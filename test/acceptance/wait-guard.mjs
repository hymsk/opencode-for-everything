import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const publicValue = (value) => !value?.synthetic && !value?.ignored
  && (value?.visibility === undefined || value.visibility === "public")
const hash = (text) => createHash("sha256").update(text).digest("hex")
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)

function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const parent = openSync(dirname(path), "r")
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

export function initializeAcceptance(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const fd = openSync(join(stateDir, "manifest.json"), "wx", 0o600)
  try { writeFileSync(fd, JSON.stringify({ version: 1, createdAt: Date.now() })); fsyncSync(fd) } finally { closeSync(fd) }
}

// This ledger belongs only to the test fixture, never to production Task inspection.
export function createAcceptance({ client, directory, stateDir, sleep = delay, inspectionEvidence: inspectEvidence }) {
  if (typeof inspectEvidence !== "function") throw new Error("Acceptance inspectionEvidence function required")
  const manifest = JSON.parse(readFileSync(join(stateDir, "manifest.json"), "utf8"))
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.createdAt)) throw new Error("Invalid acceptance manifest")

  async function record(sessionID) {
    if (!id(sessionID)) throw new Error("Invalid acceptance Session")
    const response = await client.session.get({ path: { id: sessionID }, query: { directory } })
    const session = response.data
    const task = session?.metadata?.o4e?.task
    if (response.error || session?.id !== sessionID || task?.childSessionID !== sessionID
      || task?.taskSessionID !== sessionID || task?.ownerSessionID !== session.parentID
      || task?.agent !== "inspect-child" || !id(task?.taskID) || !id(task?.dispatchMessageID)
      || !id(task?.ownerSessionID) || !Number.isSafeInteger(task.createdAt) || task.createdAt < manifest.createdAt
      || task.attemptNumber !== 1 || task.runGeneration !== 0) throw new Error("Unverified acceptance Task")
    return task
  }

  async function history(task) {
    const response = await client.session.messages({ path: { id: task.childSessionID }, query: { directory, limit: 100 } })
    const messages = response.data
    if (response.error || !Array.isArray(messages) || messages.length > 100
      || response.response?.headers?.get("X-Next-Cursor")
      || !messages.some(({ info }) => info?.id === task.dispatchMessageID && info.role === "user")
      || messages.some(({ info, parts }) => info?.sessionID !== task.childSessionID || !Array.isArray(parts)
        || (info.role === "assistant" && info.parentID !== task.dispatchMessageID))) throw new Error("Acceptance history incomplete")
    return messages.filter(({ info }) => info.role === "assistant").flatMap(({ info, parts }) => parts.map((part) => ({ info, part })))
  }

  function ledger(task) {
    const path = join(stateDir, `${task.childSessionID}.json`)
    if (!existsSync(path)) return { path, value: { taskID: task.taskID, dispatch: task.dispatchMessageID, entries: [], rejections: [] } }
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (value.taskID !== task.taskID || value.dispatch !== task.dispatchMessageID || !Array.isArray(value.entries)
      || !Array.isArray(value.rejections) || value.entries.length > 2
      || value.entries.some((entry, i) => entry.stage !== ["BEGIN", "MIDDLE"][i] || !id(entry.callID)
        || !id(entry.textID) || !["admitted", "completed", "interrupted"].includes(entry.state))) throw new Error("Invalid acceptance ledger")
    return { path, value }
  }

  return {
    async wait({ stage }, context) {
      if (context.agent !== "inspect-child" || context.directory !== directory || !id(context.callID)
        || !id(context.messageID) || !["BEGIN", "MIDDLE"].includes(stage)) throw new Error("Acceptance wait denied")
      await context.ask({ permission: "acceptance_wait", patterns: [stage], always: ["*"], metadata: {} })
      context.abort.throwIfAborted()
      const task = await record(context.sessionID)
      const lock = join(stateDir, `${task.childSessionID}.lock`)
      // A crash leaves this lock in place. Never automatically reset an uncertain allowance.
      try { mkdirSync(lock, { mode: 0o700 }) } catch { throw new Error("Acceptance wait busy or interrupted; no allowance reset") }
      try {
        const { path, value } = ledger(task)
        const reject = (reason) => {
          value.rejections.push({ callID: context.callID, stage, reason })
          save(path, value)
          throw new Error(reason)
        }
        if (value.entries.length >= 2) reject("Acceptance wait quota exhausted: maximum two admissions")
        if (value.entries.some((entry) => entry.callID === context.callID || entry.state !== "completed")) reject("Acceptance wait replay or uncertain previous execution")
        if (stage !== ["BEGIN", "MIDDLE"][value.entries.length]) reject("Acceptance stage out of order")
        let evidence
        let current
        for (let attempt = 0; attempt < 20; attempt += 1) {
          context.abort.throwIfAborted()
          const parts = await history(task)
          const index = parts.findIndex(({ info, part }) => info.id === context.messageID
            && part.type === "tool" && part.tool === "acceptance_wait" && part.callID === context.callID)
          current = parts[index]?.part
          const otherWaits = parts.filter(({ part }) => part.type === "tool" && part.tool === "acceptance_wait"
            && part.callID !== context.callID && ["running", "completed"].includes(part.state?.status))
          if (otherWaits.some(({ part }) => !value.entries.some((entry) => entry.callID === part.callID))) reject("Untracked acceptance execution; refusing to reset quota")
          const prior = value.entries.at(-1)
          const previousIndex = prior ? parts.findIndex(({ part }) => part.callID === prior.callID && part.type === "tool") : -1
          if (prior && previousIndex < 0) reject("Previous acceptance tool evidence missing")
          evidence = parts.slice(previousIndex + 1, Math.max(0, index)).findLast(({ info, part }) =>
            !info.summary && info.mode !== "compaction" && publicValue(info) && publicValue(part)
            && part.type === "text" && id(part.id) && typeof part.text === "string" && part.text.trim().startsWith(`${stage}\n`)
            && Buffer.byteLength(part.text) >= 256 && Number.isFinite(part.time?.end)
            && !value.entries.some((entry) => entry.textID === part.id))
          if (current && evidence) break
          await delay(100, undefined, { signal: context.abort })
        }
        if (!current || !evidence) reject(`Missing public ${stage} progress before wait. Emit a public assistant text paragraph starting with ${stage}, newline, and at least 256 bytes, then call again. Reasoning and tool arguments do not count.`)
        const latest = await record(context.sessionID)
        if (latest.taskID !== task.taskID || latest.dispatchMessageID !== task.dispatchMessageID || latest.status !== "running") reject("Acceptance execution changed")
        context.abort.throwIfAborted()
        const entry = { stage, callID: context.callID, messageID: context.messageID, toolID: current.id,
          textID: evidence.part.id, textHash: hash(evidence.part.text), textBytes: Buffer.byteLength(evidence.part.text),
          state: "admitted", admittedAt: Date.now() }
        value.entries.push(entry)
        save(path, value)
        try {
          context.metadata({ title: `Acceptance ${stage}: fixed 45-second wait`, metadata: { stage, admission: value.entries.length } })
          await sleep(45_000, undefined, { signal: context.abort })
          context.abort.throwIfAborted()
          entry.state = "completed"
          entry.endedAt = Date.now()
          save(path, value)
        } catch (error) {
          entry.state = "interrupted"
          save(path, value)
          throw error
        }
        return JSON.stringify({ stage, waitedMs: 45_000, admission: value.entries.length })
      } finally { rmdirSync(lock) }
    },

    async evidence({ taskID }, context) {
      if (context.agent !== "inspect-main" || context.directory !== directory) throw new Error("Acceptance evidence denied")
      await context.ask({ permission: "acceptance_evidence", patterns: [taskID], always: ["*"], metadata: {} })
      context.abort.throwIfAborted()
      const owner = await client.session.get({ path: { id: context.sessionID }, query: { directory } })
      if (owner.error || owner.data?.id !== context.sessionID) throw new Error("Acceptance evidence owner mismatch")
      const task = await record(owner.data.metadata?.o4e?.backgroundTasks?.taskRefs?.[taskID]?.taskSessionID)
      if (task.taskID !== taskID || task.ownerSessionID !== context.sessionID) throw new Error("Acceptance evidence owner mismatch")
      const parts = await history(task)
      const { value } = ledger(task)
      const response = await client.session.messages({ path: { id: context.sessionID }, query: { directory, limit: 100 } })
      if (response.error || !Array.isArray(response.data) || response.data.length > 100
        || response.response?.headers?.get("X-Next-Cursor")
        || response.data.some(({ info, parts }) => info?.sessionID !== context.sessionID || !Array.isArray(parts))) throw new Error("Acceptance parent history incomplete")
      const inspection = inspectEvidence(response.data, task.taskID, task.childSessionID)
      if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)
        || typeof inspection.passed !== "boolean") throw new Error("Invalid acceptance inspection evidence")
      const waits = parts.filter(({ part }) => part.type === "tool" && part.tool === "acceptance_wait")
      const checks = {
        exactlyTwoAdmissions: value.entries.length === 2,
        exactlyTwoCompletedWaits: waits.filter(({ part }) => part.state?.status === "completed").length === 2,
        noUntrackedWaits: waits.filter(({ part }) => ["running", "completed"].includes(part.state?.status))
          .every(({ part }) => value.entries.some((entry) => entry.callID === part.callID)),
        noOtherTools: parts.every(({ part }) => part.type !== "tool" || part.tool === "acceptance_wait"),
        noRejectedCalls: value.rejections.length === 0 && waits.every(({ part }) => part.state?.status !== "error"),
        publicProgressVerified: value.entries.length === 2 && value.entries.every((entry) => {
          const textIndex = parts.findIndex(({ part }) => part.id === entry.textID)
          const toolIndex = parts.findIndex(({ part }) => part.id === entry.toolID && part.callID === entry.callID)
          const text = parts[textIndex]
          const call = parts[toolIndex]?.part
          let output
          try { output = JSON.parse(call?.state?.output ?? "") } catch {}
          return textIndex >= 0 && toolIndex > textIndex && publicValue(text.info) && publicValue(text.part)
            && hash(text.part.text) === entry.textHash && entry.state === "completed"
            && call?.state?.status === "completed" && output?.stage === entry.stage && output?.waitedMs === 45_000
        }),
        taskCompleted: task.status === "completed",
        finalMarker: parts.some(({ info, part }) => publicValue(info) && publicValue(part) && part.type === "text"
          && part.text?.includes("O4E_INSPECT_ACCEPTANCE_DONE")),
      }
      return JSON.stringify({ taskID: task.taskID, status: task.status, checks, inspection,
        executionPassed: Object.values(checks).every(Boolean), passed: Object.values(checks).every(Boolean) && inspection.passed, admitted: value.entries.length,
        completed: waits.filter(({ part }) => part.state?.status === "completed").length,
        rejected: value.rejections, evidence: value.entries.map(({ stage, textID, toolID, state }) => ({ stage, textID, toolID, state })),
        scope: "Acceptance-only fixed timer, not Bash execution; no model self-report used." })
    },
  }
}
