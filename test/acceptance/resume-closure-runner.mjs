#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { MODELS, PROVIDERS, REASONS, parseCLI as parseBaseCLI, hash, sourceSnapshot, spawnOwnedProcess, streamEvidence } from "./common.mjs"
import { OFFLINE_INSTALL, seedDependencies } from "./resume-dependencies.mjs"
import { createAcceptance, initializeAcceptance } from "./wait-guard.mjs"
import { resumeInspectionEvidence } from "./resume-acceptance.mjs"

export { MODELS, PROVIDERS }
export const BUDGET = Object.freeze({ totalMs: 600000, cleanupAtMs: 595000, hardAtMs: 599000, setupMs: 90000,
  requestMs: 180000, requestBytes: 512 * 1024, responseBytes: 1024 * 1024,
  parentCalls: 68, childCalls: 3, parentTokens: 2048, childTokens: 16384,
  watches: 30, inspections: 30, recoveries: 4, waitMs: 45000, toolMs: 60000, readMs: 10000, parentPaceMs: 3000, publicPaceMs: 10000 })
export const READY = "O4E_RESUME_CLOSURE_READY"
export const CREATION = Object.freeze({ subagent_type: "inspect-child", description: "Production resume live acceptance",
  prompt: "Follow your complete system protocol: public BEGIN paragraph, first guarded wait, public MIDDLE paragraph, second guarded wait, all 100 long STREAM lines and completion marker. No replacement, retry or restart." })
const MARKER = "O4E_INSPECT_ACCEPTANCE_DONE"
const HISTORIC_ID_ERROR = "Expected 'id' to be a string."
const FROZEN = ["resume-closure-runner.mjs", "resume-closure-plugin.mjs", "common.mjs", "resume-dependencies.mjs",
  "resume-acceptance-plugin.mjs", "resume-acceptance.mjs", "wait-guard.mjs",
  "resume-main.jsonc", "resume-child.jsonc", "resume-acceptance-prompt.md"]
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const json = (v) => { try { return JSON.parse(v) } catch {} }
const same = (a, b) => object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k])
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const taskID = (v) => typeof v === "string" && /^o4e_task_[a-f0-9]{32}$/.test(v)
const sessionID = (v) => typeof v === "string" && /^ses_[A-Za-z0-9]{20,40}$/.test(v)
const opaqueID = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(v)
const digest = (v) => hash(typeof v === "string" ? v : "")
const interrupted = (v) => object(v) && ["gap", "unavailable"].some((k) => Object.hasOwn(v, k))
const reasonOf = (error, fallback = "SETUP") => REASONS.includes(error?.message) ? error.message : fallback
const check = (condition, code) => { if (!condition) throw new Error(REASONS.includes(code) ? code : "SETUP") }
const publicValue = (v) => !!v && !v.synthetic && !v.ignored && !v.private && !v.summary && !v.compaction
  && !["summary", "compaction"].includes(v.mode) && (v.visibility === undefined || v.visibility === "public")

export function hostVersionForArtifact(raw, versions) {
  check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw), "SETUP")
  check(object(versions) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versions.host), "INTEGRITY")
  check(raw === versions.host, "SOURCE")
  return raw
}

export function parseCLI(argv) {
  const base = [], extra = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (["--dependency-artifact", "--dependency-sha256"].includes(argv[i])) {
      check(!Object.hasOwn(extra, argv[i]) && typeof argv[i + 1] === "string", "ARGUMENTS"); extra[argv[i]] = argv[i + 1]
    } else base.push(...argv.slice(i, i + 2))
  }
  const options = parseBaseCLI(base), dependencyArtifact = extra["--dependency-artifact"], dependencyHash = extra["--dependency-sha256"]
  check(typeof dependencyArtifact === "string" && dependencyArtifact.startsWith("/") && resolve(dependencyArtifact) === dependencyArtifact
    && ![options.root, options.source].some((path) => dependencyArtifact === path || dependencyArtifact.startsWith(path + "/") || path.startsWith(dependencyArtifact + "/"))
    && /^[a-f0-9]{64}$/.test(dependencyHash), "ARGUMENTS")
  return { ...options, dependencyArtifact, dependencyHash }
}

export function hostExecutable(path = process.env.PATH ?? "") {
  for (const directory of path.split(":").filter((value) => value.startsWith("/"))) {
    const candidate = join(directory, "opencode")
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return realpathSync(candidate)
    } catch {}
  }
  throw new Error("SETUP")
}

export function toolAdmission(role, tool, args) {
  if (!object(args)) return "DENIED"
  if (role === "child") return tool === "acceptance_wait" && ["BEGIN", "MIDDLE"].includes(args.stage)
    && same(args, { stage: args.stage }) ? args.stage : "DENIED"
  if (role !== "parent") return "DENIED"
  if (tool === "task" && same(args, CREATION)) return "TASK"
  if (tool === "acceptance_evidence" && taskID(args.taskID) && same(args, { taskID: args.taskID })) return "EVIDENCE"
  if (tool !== "o4e_task" || !taskID(args.taskID)) return "DENIED"
  const normalized = { ...args }
  if (["watch", "inspect"].includes(args.action) && args.ioTimeoutMs === BUDGET.readMs) delete normalized.ioTimeoutMs
  if (same(normalized, { action: "watch", taskID: args.taskID, timeoutMs: 1000 })) return "WATCH"
  if (same(args, { action: "output", taskID: args.taskID })) return "OUTPUT"
  if (["forward", "backward"].includes(args.direction) && typeof args.resume === "boolean"
    && same(normalized, { action: "inspect", taskID: args.taskID, maxBytes: 128, direction: args.direction, resume: args.resume })) return "INSPECT"
  return "DENIED"
}

// Request budgets belong to this scenario, independently of process supervision.
export function requestAdmission(body, { role, calls, bytes, elapsedMs }) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > BUDGET.requestBytes) return "BYTE_BUDGET"
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= BUDGET.cleanupAtMs) return "TOTAL_BUDGET"
  if (!["parent", "child"].includes(role)) return "ROLE"
  if (!Number.isSafeInteger(calls) || calls < 0 || calls >= BUDGET[`${role}Calls`]) return "CALL_BUDGET"
  if (!object(body) || body.model !== MODELS[role] || body.stream !== true || body.max_tokens !== BUDGET[`${role}Tokens`]
    || !Array.isArray(body.messages) || !body.messages.length || !Array.isArray(body.tools)) return "ADMISSION"
  const fields = ["model", "stream", "stream_options", "max_tokens", "messages", "tools", "tool_choice", "parallel_tool_calls",
    "temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "seed", "response_format", "user", "logit_bias", "n", "best_of",
    ...(role === "parent" ? ["reasoning_effort"] : [])]
  if (Object.keys(body).some((key) => !fields.includes(key)) || ![undefined, 1].includes(body.n) || ![undefined, 1].includes(body.best_of)
    || Object.hasOwn(body, "reasoning_effort") && body.reasoning_effort !== "medium"
    || body.stream_options !== undefined && (!same(body.stream_options, { include_usage: body.stream_options?.include_usage })
      || typeof body.stream_options.include_usage !== "boolean")) return "ADMISSION"
  const names = body.tools.map((item) => item?.function?.name)
  const required = role === "parent" ? ["task", "o4e_task", "acceptance_evidence"] : ["acceptance_wait"]
  if (names.length !== required.length || new Set(names).size !== names.length || required.some((name) => !names.includes(name))
    || body.tools.some((item) => item?.type !== "function" || !object(item.function?.parameters))) return "ADMISSION"
  const schema = body.tools.find((item) => item.function.name === (role === "parent" ? "task" : "acceptance_wait")).function.parameters
  const keys = role === "parent" ? ["description", "prompt", "subagent_type"] : ["stage"]
  if (schema.type !== "object" || !Array.isArray(schema.required) || schema.required.length !== keys.length
    || keys.some((key) => !schema.required.includes(key) || schema.properties?.[key]?.type !== "string")
    || role === "child" && (!equal(schema.properties.stage.enum, ["BEGIN", "MIDDLE"]) || Object.keys(schema.properties).length !== 1)) return "ADMISSION"
  return "ACCEPT"
}

export function createSequence() {
  const active = new Map(), seen = new Set()
  let task, started = false, terminal = false, output = false, inspections = 0, finalInspections = 0, evidence = false
  let watches = 0, recoveries = 0, childIndex = 0, inspectGap = false, began = false, middle = false
  return {
    before(role, tool, args, callID) {
      const operation = toolAdmission(role, tool, args)
      check(operation !== "DENIED", "ARGUMENTS")
      check(opaqueID(callID) && !seen.has(callID), "IDENTITY")
      check(!active.has(role), "SEQUENCE")
      if (role === "child") check(started && operation === ["BEGIN", "MIDDLE"][childIndex], "SEQUENCE")
      else {
        check(!evidence, "SEQUENCE")
        if (operation === "TASK") { check(!started, "SEQUENCE"); started = true }
        else {
          check(!!task, "SEQUENCE")
          check(args.taskID === task.taskID, "IDENTITY")
          if (operation === "WATCH") {
            check(!terminal && !output && watches < BUDGET.watches, "SEQUENCE")
            watches++
          } else if (operation === "OUTPUT") check(terminal && !output, "SEQUENCE")
          else if (operation === "INSPECT") {
            if (output) check(finalInspections < 4 && args.direction === (finalInspections === 1 ? "backward" : "forward")
              && args.resume === (finalInspections !== 0), "SEQUENCE")
            else {
              check(!terminal && inspections < BUDGET.inspections && args.direction === "forward"
                && args.resume === (inspections === 0 ? false : !inspectGap), "SEQUENCE")
              if (!args.resume && inspections > 0) { check(recoveries < BUDGET.recoveries, "SEQUENCE"); recoveries++ }
            }
            inspections++
          } else if (operation === "EVIDENCE") check(finalInspections === 4, "SEQUENCE")
        }
      }
      seen.add(callID); active.set(role, { operation, callID })
      return operation
    },
    after(role, callID, raw, metadata = {}) {
      const admitted = active.get(role)
      const value = ["TASK", "WATCH", "OUTPUT", "INSPECT"].includes(admitted?.operation) ? metadata.o4eResult : json(raw)
      check(admitted?.callID === callID && typeof raw === "string" && object(value), "PRODUCTION")
      check(!metadata.timeout && !metadata.truncated && !metadata.interrupted && (metadata.exit === undefined || metadata.exit === 0), "EVIDENCE")
      const operation = admitted.operation
      if (operation === "TASK") {
        check(value.agent === "inspect-child" && value.status === "queued" && taskID(value.taskID) && sessionID(value.sessionID), "PRODUCTION")
        task = { taskID: value.taskID, sessionID: value.sessionID }
      } else if (operation === "WATCH") {
        check(value.tasks?.length === 1 && value.tasks[0].taskID === task.taskID, "PRODUCTION")
        const preview = value.tasks[0]
        terminal = value.reason === "actionable" && preview.status === "completed"
        check(!["tail", "cursor", "beforeCursor", "unchanged", "unavailable", "gap", "output", "outputTruncated"]
          .some((key) => Object.hasOwn(preview, key)), "PRODUCTION")
        check(terminal ? true : value.reason === "heartbeat" && ["queued", "running"].includes(preview.status), "PRODUCTION")
      } else if (operation === "OUTPUT") {
        check(value.taskID === task.taskID && value.status === "completed" && !interrupted(value)
          && typeof value.output === "string" && value.output.trimEnd().endsWith(MARKER), "EVIDENCE")
        output = true
      } else if (operation === "INSPECT") {
        check(value.taskID === task.taskID && ["running", "completed"].includes(value.status)
          && (value.tail === undefined || typeof value.tail === "string") && Buffer.byteLength(value.tail ?? "") <= 128, "EVIDENCE")
        if (interrupted(value)) inspectGap = true
        else {
          check(typeof value.cursor === "string" && value.cursor.length > 0 && value.cursor.length <= 512, "EVIDENCE")
          inspectGap = false
          began ||= value.tail?.includes("BEGIN\n") === true
          middle ||= value.tail?.includes("MIDDLE\n") === true
          if (output) {
            check(value.status === "completed" && (finalInspections === 3 ? value.unchanged === true : !!value.tail), "EVIDENCE")
            finalInspections++
          }
        }
      } else if (operation === "EVIDENCE") {
        check(began && middle && value.taskID === task.taskID && value.passed === true
          && value.executionPassed === true && value.inspection?.passed === true, "EVIDENCE")
        evidence = true
      } else {
        check(same(value, { stage: operation, waitedMs: BUDGET.waitMs, admission: childIndex + 1 }), "EVIDENCE")
        childIndex++
      }
      active.delete(role)
      return operation
    },
    get task() { return task },
    get complete() { return evidence && began && middle && childIndex === 2 && active.size === 0 },
  }
}

export function controlledReply(body, role, call) {
  let tool, args, content
  if (role === "child") {
    check(call >= 1 && call <= 3, "SEQUENCE")
    if (call < 3) { args = { stage: call === 1 ? "BEGIN" : "MIDDLE" }; content = args.stage + "\n" + "a".repeat(400); tool = "acceptance_wait" }
    else content = Array.from({ length: 100 }, (_, i) => `STREAM${String(i + 1).padStart(3, "0")}${"a".repeat(80)}`).join("\n") + "\n" + MARKER
  } else {
    const calls = new Map(body.messages.flatMap((message) => message.tool_calls ?? []).map((call) => [call.id, call.function]))
    const outputs = body.messages.filter((message) => message.role === "tool").map((message) => ({
      call: calls.get(message.tool_call_id),
      text: typeof message.content === "string" ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    }))
    const created = outputs.find((entry) => entry.call?.name === "task")?.text.match(/^Task (o4e_task_[a-f0-9]{32}) start · queued(?:\n|$)/)?.[1]
    const previous = outputs.at(-1), input = json(previous?.call?.arguments)
    const inspections = outputs.filter((entry) => entry.call?.name === "o4e_task" && json(entry.call.arguments)?.action === "inspect").length
    if (!created) { check(call === 1, "SEQUENCE"); tool = "task"; args = CREATION }
    else if (previous.call?.name === "acceptance_evidence") {
      check(json(previous.text)?.passed === true, "EVIDENCE")
      content = "Controlled synthetic SSE closure passed mechanical checks; this is not live model acceptance."
    }
    else if (inspections === 6) { tool = "acceptance_evidence"; args = { taskID: created } }
    else if (input?.action === "output" || outputs.some((entry) => entry.call?.name === "o4e_task" && json(entry.call.arguments)?.action === "output")) { tool = "o4e_task"; args = { action: "inspect", taskID: created,
      maxBytes: 128, direction: inspections === 3 ? "backward" : "forward", resume: inspections !== 2, ioTimeoutMs: BUDGET.readMs } }
    else if (previous.text.startsWith("Watch · actionable")) { tool = "o4e_task"; args = { action: "output", taskID: created } }
    else if (input?.action === "inspect") { tool = "o4e_task"; args = { action: "watch", taskID: created, timeoutMs: 1000, ioTimeoutMs: BUDGET.readMs } }
    else { tool = "o4e_task"; args = { action: "inspect", taskID: created, maxBytes: 128, direction: "forward",
      resume: inspections > 0 && !/^Preview (?:gap|unavailable):/m.test(previous.text), ioTimeoutMs: BUDGET.readMs } }

  }
  const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `chatcmpl_resume_${role}_${call}`,
    object: "chat.completion.chunk", created: 1, model: MODELS[role], choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  // Public text precedes a separate tool event; only controlled mode may pace these frames.
  return Buffer.from(event({ role: "assistant" }) + (content ? event({ content }) : "") + (tool ? event({ tool_calls: [{ index: 0,
    id: `call_resume_${role}_${call}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }) : "")
    + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
}

export function fileBytes(path, max = 1024 * 1024, privateFile = false) {
  try {
    const stat = lstatSync(path)
    check(stat.isFile() && stat.nlink === 1 && stat.size <= max && realpathSync(path) === path
      && (!privateFile || (stat.mode & 0o077) === 0 && stat.uid === process.getuid()), "INTEGRITY")
    return readFileSync(path)
  } catch { throw new Error(privateFile ? "CONFIG" : "INTEGRITY") }
}

export function filesUnchanged(entries) {
  try { return entries.every((entry) => hash(fileBytes(entry.path)) === entry.hash) } catch { return false }
}

export async function expectedPermission(coreRoot, configRoot) {
  const { loadRuntimeDefinition } = await import(pathToFileURL(join(coreRoot, "runtime-builder.mjs")).href)
  const { effectiveAgentPermission, permissionRules, deriveSelfEffects } = await import(pathToFileURL(join(coreRoot, "core/agent-routing.mjs")).href)
  const { runtimeAgents: agents, config } = loadRuntimeDefinition(configRoot)
  check(agents.length === 2 && Object.keys(config.mcp).length === 0, "CONFIG")
  const parent = agents.find((a) => a.name === "inspect-main"), child = agents.find((a) => a.name === "inspect-child")
  check(parent?.type === "primary" && child?.type === "subagent", "CONFIG")
  const permission = effectiveAgentPermission(child, { agents, mcpServerNames: [] })
  const effect = deriveSelfEffects(child, { permission, permissionOverlay: {}, writeScopes: [] })
  return { child: permissionRules(effect.permission), parent: permissionRules(effectiveAgentPermission(parent, { agents, mcpServerNames: [] })), effect: effect.kind }
}

export async function closureEvidence({ sessions = [], messages = [], parts = [], audit = [], project, stateDir, startedAt, endedAt }, policy = {}) {
  const parents = sessions.filter((s) => !s.parent_id), parent = parents[0]
  const tools = parts.filter((p) => p.type === "tool")
  const parentTools = tools.filter((p) => p.sessionID === parent?.id).sort((a, b) => a.state?.time?.start - b.state?.time?.start)
  const created = parentTools[0]?.state?.metadata?.o4eResult, child = sessions.find((s) => s.id === created?.sessionID)
  const childTools = tools.filter((p) => p.sessionID === child?.id).sort((a, b) => a.state?.time?.start - b.state?.time?.start)
  const ledgers = sessions.filter((s) => object(s.metadata?.o4e?.task)), ledger = ledgers[0]?.metadata.o4e.task, delegation = child?.metadata?.o4e?.delegation
  const history = (id) => messages.filter((m) => m.sessionID === id).map((info) => ({ info, parts: parts.filter((p) => p.messageID === info.id && p.sessionID === id) }))
  const inspection = resumeInspectionEvidence(history(parent?.id), created?.taskID, child?.id)
  const completed = (p) => publicValue(p) && publicValue(p.state) && p.state.status === "completed" && !p.state.error
    && typeof p.state.output === "string" && p.state.metadata?.truncated !== true
    && !Object.hasOwn(p.state.time ?? {}, "compacted") && opaqueID(p.id) && opaqueID(p.callID)
    && Number.isFinite(p.state.time?.start) && Number.isFinite(p.state.time?.end) && p.state.time.start >= startedAt
    && p.state.time.end >= p.state.time.start && p.state.time.end <= endedAt && p.state.time.end - p.state.time.start <= BUDGET.toolMs
    && messages.some((m) => m.id === p.messageID && m.sessionID === p.sessionID && m.role === "assistant" && publicValue(m) && !m.error)
  const final = (id) => messages.findLast((m) => m.sessionID === id && m.role === "assistant" && m.finish === "stop" && publicValue(m) && !m.error
    && Number.isFinite(m.time?.completed) && m.time.completed >= startedAt && m.time.completed <= endedAt
    && parts.some((p) => p.messageID === m.id && p.sessionID === id && p.type === "text" && publicValue(p) && typeof p.text === "string" && p.text.trim().length > 0))
  const childFinal = final(child?.id), parentFinal = final(parent?.id)
  const finalParts = parts.filter((p) => p.messageID === childFinal?.id && p.sessionID === child?.id)
  const finalText = finalParts.filter((p) => p.type === "text" && publicValue(p)).map((p) => p.text).join("\n")
  const lines = finalText.trimEnd().split(/\r?\n/), streamLines = lines.filter((line) => /^STREAM\d{3}/.test(line))
  let guarded = false, execution = false, waits = false, outputBound = false, fingerprintMatches = false, requesterAllowed = false
  try {
    const outputPart = parentTools.findLast((p) => p.tool === "o4e_task" && p.state?.input?.action === "output")
    const output = outputPart?.state?.metadata?.o4eResult, reference = ledger.result
    const referencedParts = reference.partIDs.map((id) => finalParts.find((p) => p.id === id))
    outputBound = completed(outputPart) && reference.sessionID === child?.id && reference.messageID === childFinal?.id
      && reference.partIDs.length > 0 && reference.partIDs.every(opaqueID) && new Set(reference.partIDs).size === reference.partIDs.length
      && referencedParts.every(publicValue) && new Set(finalParts.map((p) => p.id)).size === finalParts.length
      && output?.taskID === created?.taskID && output.status === "completed" && !interrupted(output)
      && output.messageID === reference.messageID && equal(output.partIDs, reference.partIDs)
      && equal(referencedParts.filter((p) => p.type === "text").map((p) => p.id), finalParts.filter((p) => p.type === "text" && publicValue(p)).map((p) => p.id))
      // Production reads result references in ledger order, then taskText joins text with two newlines and trims.
      && typeof output.output === "string" && output.output === policy.taskText({ parts: referencedParts })
      && outputPart.state.output.includes(output.output)
  } catch {}
  try {
    const sequence = createSequence()
    // Millisecond clocks may give a fast read identical start/end times. Complete
    // earlier calls first, then replay each zero-duration call in persisted order.
    const operations = tools.flatMap((p, order) => [true, false].map((before) => ({ p, before, order,
      at: before ? p.state.time.start : p.state.time.end,
      phase: p.state.time.start === p.state.time.end ? 1 : before ? 2 : 0 })))
      .sort((a, b) => a.at - b.at || a.phase - b.phase || a.order - b.order || Number(b.before) - Number(a.before))
    for (const { before, p } of operations) {
      const role = p.sessionID === parent?.id ? "parent" : p.sessionID === child?.id ? "child" : "invalid"
      if (before) sequence.before(role, p.tool, p.state.input, p.callID)
      else sequence.after(role, p.callID, p.state.output, p.state.metadata)
    }
    guarded = sequence.complete
  } catch {}
  try {
    const client = { session: {
      get: async ({ path }) => {
        const session = sessions.find((entry) => entry.id === path.id)
        return { data: session && { ...session, parentID: session.parent_id } }
      },
      messages: async ({ path }) => ({ data: history(path.id) }),
    } }
    const api = createAcceptance({ client, directory: project, stateDir, inspectionEvidence: resumeInspectionEvidence })
    const recomputed = json(await api.evidence({ taskID: created.taskID }, { agent: "inspect-main", directory: project,
      sessionID: parent.id, ask: async () => {}, abort: new AbortController().signal }))
    const recorded = json(parentTools.at(-1)?.state?.output)
    execution = recomputed?.passed === true && recorded?.passed === true && recorded.executionPassed === true
      && equal(recorded.checks, recomputed.checks) && equal(recorded.inspection?.checks, inspection.checks)
      && equal(recorded.evidence, recomputed.evidence) && recorded.admitted === 2 && recorded.completed === 2 && recorded.rejected?.length === 0
    const waitLedger = json(fileBytes(join(stateDir, `${child.id}.json`), 65536))
    waits = waitLedger.entries.length === 2 && waitLedger.rejections.length === 0 && childTools.length === 2 && waitLedger.entries.every((entry, i) => {
      const part = childTools[i], text = parts.find((p) => p.id === entry.textID && p.sessionID === child.id), result = json(part.state?.output)
      return completed(part) && entry.stage === ["BEGIN", "MIDDLE"][i] && entry.state === "completed" && entry.callID === part.callID
        && entry.toolID === part.id && entry.messageID === part.messageID && publicValue(text) && text.type === "text"
        && typeof text.text === "string" && text.text.trimStart().startsWith(entry.stage + "\n") && Buffer.byteLength(text.text) >= 256
        && entry.textBytes === Buffer.byteLength(text.text) && entry.textHash === hash(text.text)
        && Number.isFinite(text.time?.end) && text.time.end <= entry.admittedAt
        && entry.admittedAt >= part.state.time.start && entry.endedAt <= part.state.time.end
        && entry.endedAt - entry.admittedAt >= BUDGET.waitMs && entry.endedAt - entry.admittedAt <= BUDGET.toolMs
        && same(result, { stage: entry.stage, waitedMs: BUDGET.waitMs, admission: i + 1 })
    })
  } catch {}
  try {
    requesterAllowed = policy.evaluate("task", "inspect-child", policy.parent).action === "allow"
    const fingerprint = policy.fingerprint({ requesterAgent: "inspect-main", targetAgent: "inspect-child", requesterPermissionPattern: "inspect-child",
      requesterPermissionAction: "allow", requesterPermissionApproved: false, compiledPermission: policy.child, permissionOverlay: {},
      effect: policy.effect, normalizedScopes: [], trace: { taskID: created.taskID, ownerSessionID: parent.id } })
    fingerprintMatches = /^[a-f0-9]{64}$/.test(fingerprint) && fingerprint === delegation.authorizationFingerprint && fingerprint === ledger.authorizationFingerprint
  } catch {}
  const ready = audit.filter((a) => a.kind === "READY")
  const checks = {
    freshSessions: sessions.length === 2 && parents.length === 1 && sessionID(parent?.id) && sessionID(child?.id) && child.parent_id === parent.id
      && sessions.every((s) => s.directory === project && s.time_created >= startedAt && s.time_created <= endedAt),
    inspection: inspection.passed, originalExecution: execution, guardedSequence: guarded, twoTimedWaits: waits, outputBound,
    longOutput: Buffer.byteLength(finalText) <= 16 * 1024 && lines.length === 101 && streamLines.length === 100 && streamLines.every((line, i) => line.startsWith(`STREAM${String(i + 1).padStart(3, "0")}`)
      && /^[\x20-\x7e]{80,120}$/.test(line.slice(9))) && lines.at(-1) === MARKER
      && parts.filter((p) => p.sessionID === child?.id && p.type === "text" && publicValue(p)).map((p) => p.text).join("\n").split(/\r?\n/).filter((line) => /^STREAM\d{3}/.test(line)).length === 100,
    completedLedger: ledgers.length === 1 && ledgers[0].id === child?.id && ledger?.kind === "agent" && ledger.agent === "inspect-child"
      && ledger.taskID === created?.taskID && ledger.ownerSessionID === parent?.id && ledger.taskSessionID === child?.id && ledger.childSessionID === child?.id
      && ledger.status === "completed" && ledger.phase === "completed" && ledger.runGeneration === 0 && ledger.attemptNumber === 1 && ledger.retryRound === 0
      && equal(ledger.attemptSessionIDs, [child?.id]) && equal(ledger.pendingRequests, []) && equal(ledger.pendingInputs, []) && ledger.requiresAllAttemptsStopped !== true
      && !!childFinal && ledger.result?.messageID === childFinal.id && Array.isArray(ledger.result.partIDs) && ledger.result.partIDs.length > 0
      && ledger.result.partIDs.every((id) => parts.some((p) => p.id === id && p.messageID === childFinal.id && p.sessionID === child.id)),
    dispatchLineage: opaqueID(ledger?.dispatchMessageID) && messages.filter((m) => m.sessionID === child?.id && m.role === "user").length === 1
      && messages.some((m) => m.id === ledger?.dispatchMessageID && m.sessionID === child?.id && m.role === "user")
      && messages.filter((m) => m.sessionID === child?.id && m.role === "assistant").every((m) => m.parentID === ledger?.dispatchMessageID),
    frozenAuthority: delegation?.depth === 1 && delegation.toolName === "task" && delegation.taskID === created?.taskID
      && delegation.parentSessionID === parent?.id && delegation.sourceAgent === "inspect-main" && delegation.targetAgent === "inspect-child"
      && delegation.requesterPermissionPattern === "inspect-child" && delegation.requesterPermissionAction === "allow" && delegation.requesterPermissionApproved === false
      && delegation.dispatchMessageID === ledger?.dispatchMessageID && delegation.effect === policy.effect && ledger?.effect === policy.effect
      && equal(delegation.writeScopes, []) && equal(ledger?.writeScopes, []) && equal(delegation.permissionOverlay, {})
      && same(delegation.trace, { taskID: created?.taskID, ownerSessionID: parent?.id }) && delegation.workflowDefinitionHash === undefined,
    frozenPermissions: Array.isArray(policy.child) && policy.child.length > 0 && equal(child?.permission, policy.child) && equal(delegation?.compiledPermission, policy.child),
    requesterAllowed, fingerprintMatches,
    finalAfterEvidence: !!parentFinal && !!childFinal && parentTools.at(-1)?.tool === "acceptance_evidence" && parentFinal.time.completed >= parentTools.at(-1)?.state?.time?.end,
    correctModels: ["parent", "child"].every((role) => {
      const entries = messages.filter((m) => m.sessionID === (role === "parent" ? parent?.id : child?.id) && m.role === "assistant")
      return entries.length > 0 && entries.length <= BUDGET[`${role}Calls`] && entries.every((m) => m.providerID === PROVIDERS[role] && m.modelID === MODELS[role])
    }),
    noErrorsOrPending: messages.every((m) => !m.error) && tools.every(completed) && tools.length === parentTools.length + childTools.length,
    distinctTools: new Set(tools.map((p) => p.id)).size === tools.length && new Set(tools.map((p) => p.callID)).size === tools.length,
    uniqueRuntime: ready.length === 1 && /^[a-f0-9-]{36}$/.test(ready[0].runtimeID) && audit.every((a) => a.runtimeID === ready[0].runtimeID
      && ["READY", "ADMIT", "COMPLETE", "DISPOSE"].includes(a.kind)),
    auditLinked: ["ADMIT", "COMPLETE"].every((kind) => {
      const entries = audit.filter((a) => a.kind === kind)
      return entries.length === tools.length && tools.every((p) => entries.filter((a) => a.callHash === digest(p.callID) && a.sessionHash === digest(p.sessionID)
        && a.operation === toolAdmission(p.sessionID === parent?.id ? "parent" : "child", p.tool, p.state?.input)
        && a.inputHash === hash(JSON.stringify(p.state.input)) && (kind === "ADMIT" || a.outputHash === digest(p.state.output))).length === 1)
    }),
  }
  for (const key of Object.keys(checks)) checks[key] = checks[key] === true
  return { passed: Object.values(checks).every(Boolean), checks,
    inspection: { passed: inspection.passed, checks: inspection.checks },
    idError: messages.some((m) => m.error?.data?.message === HISTORIC_ID_ERROR || m.error?.message === HISTORIC_ID_ERROR),
    counts: { sessions: sessions.length, ledgers: ledgers.length, parentTools: parentTools.length, childTools: childTools.length,
      watches: inspection.counts.watches, progressInspections: inspection.counts.progressInspections,
      inspections: inspection.counts.inspections, recoveries: inspection.counts.freshRecoveries,
      gaps: inspection.gapCount, unavailable: inspection.unavailableCount, longLines: streamLines.length },
    hashes: { parent: digest(parent?.id), child: digest(child?.id), task: digest(created?.taskID),
      inspectionParts: hash(JSON.stringify(inspection.partIDs.sequence)), output: hash(finalText) },
    cursorSource: inspection.cursorSource }
}

function strictEnvironment(root, binary) {
  return { PATH: [...new Set([dirname(binary), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
    LANG: "C.UTF-8", TERM: "dumb", SHELL: "/bin/bash", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    OPENCODE_CONFIG_DIR: join(root, "config/opencode"), OPENCODE_CONFIG: join(root, "host.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_AUTH_CONTENT: "{}", OPENCODE_PURE: "0", OPENCODE_EXPERIMENTAL_NATIVE_LLM: "0",
    OPENCODE_PRINT_LOGS: "1", OPENCODE_LOG_LEVEL: "ERROR", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_globalconfig: join(root, "global.npmrc"), npm_config_cache: join(root, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_fetch_timeout: "10000", npm_config_fetch_retries: "0",
    npm_config_audit: "false", npm_config_fund: "false" }
}

export function createSetupProgress(startedAt, now = Date.now) {
  const stages = ["ENVIRONMENT", "SOURCE", "HOST_VERSION", "INSTALL", "CONFIG", "BUILD", "CORE", "PERMISSION",
    "DEPENDENCY_ARTIFACT", "NPM_PROJECT", "DEPENDENCY_COPY", "DEPENDENCY_VERIFY", "ROUTES", "HOST_CONFIG", "FINALIZE"]
  const report = { completed: false, elapsedMs: 0, timedOut: false, reason: "NONE", stages: [] }
  let ended = false
  const update = () => {
    report.elapsedMs = Math.max(0, now() - startedAt)
    const current = report.stages.at(-1)
    if (current) current.elapsedMs = Math.max(0, report.elapsedMs - current.startedMs)
    return current
  }
  const finish = (reason = "NONE") => {
    if (ended) return
    const current = update()
    report.timedOut = report.elapsedMs >= BUDGET.setupMs
    report.reason = reason === "NONE" ? report.timedOut ? "SETUP" : "NONE" : REASONS.includes(reason) ? reason : "SETUP"
    report.completed = report.reason === "NONE"
    if (current) current.status = report.completed ? "COMPLETED" : "FAILED"
    ended = true
  }
  return { report, finish,
    enter(stage) {
      check(!ended && stages.includes(stage) && !report.stages.some((entry) => entry.stage === stage), "SETUP")
      const previous = update()
      if (report.elapsedMs >= BUDGET.setupMs) { finish("SETUP"); throw new Error("SETUP") }
      if (previous) previous.status = "COMPLETED"
      report.stages.push({ stage, startedMs: report.elapsedMs, elapsedMs: 0, status: "RUNNING" })
    },
  }
}

// Observe the existing fd4 contract without relaxing owned.result or implementing another supervisor.
export function observeOwnedProcess(owned) {
  let receipt = "", bytes = 0, code, signal
  owned.child.stdio[4].on("data", (chunk) => { bytes += chunk.length; receipt = bytes <= 1024 ? receipt + chunk.toString() : "" })
  owned.child.once("close", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal })
  return owned.result.then(() => true, () => false).then((accepted) => {
    const value = bytes <= 1024 ? json(receipt) : undefined
    const exit = (v) => Number.isInteger(v) && v >= -64 && v <= 255
    const valid = object(value) && Object.keys(value).length === 4 && typeof value.cleaned === "boolean"
      && typeof value.timedOut === "boolean" && Number.isSafeInteger(value.tracked) && value.tracked >= 0
      && (exit(value.exitCode) || value.exitCode === null && !value.cleaned)
    const consistent = valid && signal === null && (code === 0 && value.cleaned && !value.timedOut || code === 1 && (!value.cleaned || value.timedOut))
    return { accepted, supervisorExitCode: exit(code) ? code : null,
      supervisorSignal: signal === null ? "NONE" : ["SIGTERM", "SIGKILL", "SIGINT"].includes(signal) ? signal : "UNKNOWN",
      receipt: bytes > 1024 ? "OVERSIZED" : bytes === 0 ? "MISSING" : valid ? "VALID" : "INVALID",
      childExitCode: valid ? value.exitCode : null, tracked: valid ? value.tracked : null,
      // The shared supervisor's timedOut flag also covers cleanup failure; it is not a timeout diagnosis.
      timeoutOrCleanupFailure: valid ? value.timedOut : null,
      cleanup: consistent ? value.cleaned ? "CONFIRMED" : "FAILED" : "UNPROVEN" }
  })
}

export async function prepareDependencies(root, command, stage, artifact, expectedHash) {
  const project = join(root, "project/.opencode"), config = join(root, "config/opencode")
  stage("DEPENDENCY_ARTIFACT")
  check(realpathSync(root) === root && [project, config].every((path) => realpathSync(path) === path)
    && !existsSync(join(project, "node_modules")) && readdirSync(config).length === 0, "SETUP")
  let artifactInfo
  try { artifactInfo = seedDependencies(artifact, expectedHash, project, join(root, "npm-cache")) } catch { throw new Error("INTEGRITY") }
  const npmVersion = await command("npm", ["--version"], { capture: true })
  check(npmVersion.stdout.trim() === artifactInfo.npmVersion, "SETUP")
  stage("NPM_PROJECT")
  await command("npm", [...OFFLINE_INSTALL, "--prefix", project, "--cache", join(root, "npm-cache")])
  for (const name of ["plugin", "sdk"]) check(json(fileBytes(join(project, "node_modules/@opencode-ai", name, "package.json")))?.version === artifactInfo.versions[name], "SETUP")
  stage("DEPENDENCY_COPY")
  // Copy only this run's completed install, including its lockfile. No second resolution/download/unpack or previous-run cache.
  await command(process.execPath, ["--input-type=module", "-e",
    'import { cpSync } from "node:fs"; import { join } from "node:path"; for (const name of ["node_modules", "package.json", "package-lock.json"]) cpSync(join(process.argv[1], name), join(process.argv[2], name), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })',
    project, config])
  stage("DEPENDENCY_VERIFY")
  for (const prefix of [project, config]) for (const name of ["plugin", "sdk"]) {
    check(json(fileBytes(join(prefix, "node_modules/@opencode-ai", name, "package.json")))?.version === artifactInfo.versions[name], "SETUP")
  }
  for (const name of ["package.json", "package-lock.json"]) check(hash(fileBytes(join(project, name))) === hash(fileBytes(join(config, name))), "SETUP")
  check(hash(fileBytes(join(project, "package-lock.json"))) === artifactInfo.lockHash, "INTEGRITY")
  return artifactInfo
}

// Executed only in a supervised setup worker; route secrets cross an anonymous pipe, never a file/report.
export async function liveRoutes(options) {
  const original = json(fileBytes(options.providerConfig, 1024 * 1024, true))
  const resolverBytes = fileBytes(options.keyResolver, 1024 * 1024, true)
  const resolverPath = join(options.root, "harness/private-resolver.mjs")
  writeFileSync(resolverPath, resolverBytes, { flag: "wx", mode: 0o600 })
  const resolver = await import(pathToFileURL(resolverPath).href)
  check(typeof resolver.resolveKey === "function", "CONFIG")
  const routes = {}
  for (const role of ["parent", "child"]) {
    const provider = original?.provider?.[PROVIDERS[role]], model = provider?.models?.[MODELS[role]]
    check(provider?.npm === "@ai-sdk/openai-compatible" && object(model) && typeof provider.options?.baseURL === "string", "CONFIG")
    const url = new URL(provider.options.baseURL.replace(/\/$/, "") + "/chat/completions")
    check(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, "CONFIG")
    const key = await resolver.resolveKey(provider.options.apiKey, { configDir: dirname(options.providerConfig), home: options.resolverHome })
    check(typeof key === "string" && key.length > 0 && key.length <= 16384 && !/[\r\n]/.test(key), "CONFIG")
    const metadata = { name: MODELS[role] }
    for (const name of ["reasoning", "toolcall", "temperature", "attachment"]) if (typeof model[name] === "boolean") metadata[name] = model[name]
    if (object(model.limit)) {
      metadata.limit = {}
      for (const name of ["context", "input", "output"]) if (Number.isSafeInteger(model.limit[name]) && model.limit[name] > 0) metadata.limit[name] = model.limit[name]
    }
    if (typeof model.interleaved === "boolean") metadata.interleaved = model.interleaved
    else if (["reasoning_content", "reasoning_details"].includes(model.interleaved?.field)) metadata.interleaved = { field: model.interleaved.field }
    const headers = new Headers(provider.options.headers ?? {})
    headers.set("authorization", `Bearer ${key}`); headers.set("content-type", "application/json")
    headers.set("accept", "text/event-stream"); headers.set("accept-encoding", "identity")
    routes[role] = { url: url.href, headers: Object.fromEntries(headers), metadata }
  }
  return routes
}

export async function runAcceptance(options) {
  const startedAt = Date.now(), root = options.root
  // Freeze every repository import before setup. The executing implementation below is the frozen copy.
  check(realpathSync("/tmp/opencode") === "/tmp/opencode" && !existsSync(root), "ARGUMENTS")
  process.umask(0o077)
  mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "harness"), { mode: 0o700 })
  try {
    const immutable = FROZEN.map((name) => {
      const bytes = fileBytes(join(dirname(fileURLToPath(import.meta.url)), name)), path = join(root, "harness", name)
      writeFileSync(path, bytes, { flag: "wx", mode: 0o400 })
      return { path, hash: hash(bytes) }
    })
    const frozen = await import(pathToFileURL(join(root, "harness/resume-closure-runner.mjs")).href)
    return await frozen.runFrozen(options, startedAt, immutable)
  } catch (error) {
    const report = { mode: options.mode, verdict: "failed", reason: reasonOf(error), idError: false, elapsedMs: Date.now() - startedAt }
    try { writeFileSync(join(root, "report.json"), JSON.stringify(report) + "\n", { mode: 0o600 }) } catch {}
    return report
  }
}

export async function runFrozen(options, startedAt, frozenFiles) {
  const progress = createSetupProgress(startedAt)
  const report = { mode: options.mode, scope: options.mode === "controlled" ? "synthetic-sse-real-host-and-tools" : "live-unaltered-provider-streams",
    verdict: "failed", reason: "SETUP", hostVersion: "unverified", versionPolicy: "artifact-resolved-npm-latest", idError: false, budget: BUDGET,
    counts: { parent: 0, child: 0, upstream: 0, denied: 0, streams: 0, cleanedProcesses: 0 }, checks: {}, hashes: {}, requests: [],
    setup: progress.report, commands: [], cleanup: { status: "UNPROVEN", confirmed: 0, failed: 0, unproven: 0 } }
  const processes = new Set(), controllers = new Set(), sockets = new Set(), pending = new Set(), runtimes = new Set(), activeRoles = new Set(), requests = new Set()
  let server, env, stopReason, closed = false, actualStart, setup = true, cleanupFailed = false
  const remaining = () => BUDGET.cleanupAtMs - (Date.now() - startedAt)
  const stop = (reason, timedOut = false) => {
    if (reason && !stopReason) stopReason = REASONS.includes(reason) ? reason : "SETUP"
    if (reason && setup) progress.finish(stopReason)
    for (const record of report.commands.filter((entry) => entry.outcome === "RUNNING")) {
      if (record.stopReason === "NONE") record.stopReason = stopReason ?? "CLEANUP"
      if (timedOut && record.timeoutReason === "NONE") record.timeoutReason = REASONS.includes(reason) ? reason : "SETUP"
    }
    closed = true
    for (const controller of controllers) controller.abort()
    for (const socket of sockets) socket.destroy()
    for (const owned of processes) owned.stop()
  }
  const save = () => { try { writeFileSync(join(options.root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }) } catch {} }
  const signal = () => stop("SIGNAL")
  process.on("SIGINT", signal); process.on("SIGTERM", signal)
  const setupTimer = setTimeout(() => { if (setup) stop("SETUP", true) }, Math.max(1, BUDGET.setupMs - (Date.now() - startedAt)))
  const deadline = setTimeout(() => stop("TOTAL_BUDGET", true), Math.max(1, remaining()))
  const hard = setTimeout(() => {
    stop("TOTAL_BUDGET", true); server?.closeAllConnections(); server?.close()
    report.checks.ownedProcessesStopped = false
    report.verdict = "failed"; report.reason = "TOTAL_BUDGET"; report.elapsedMs = Date.now() - startedAt; save()
    process.stdout.write('{"verdict":"failed","reason":"TOTAL_BUDGET"}\n'); process.exit(1)
  }, Math.max(1, BUDGET.hardAtMs - (Date.now() - startedAt)))
  const command = async (binary, args, { cwd = options.root, capture = false, host = false } = {}) => {
    check(!stopReason && remaining() > 0, stopReason ?? "TOTAL_BUDGET")
    const commandAt = Date.now(), setupCommand = setup
    const timeout = Math.min(remaining(), setup ? BUDGET.setupMs - (commandAt - startedAt) : BUDGET.totalMs)
    check(timeout > 0, setup ? "SETUP" : "TOTAL_BUDGET")
    const record = { stage: setup ? report.setup.stages.at(-1).stage : host ? "HOST" : "VERIFY", startedMs: commandAt - startedAt,
      elapsedMs: 0, timeoutMs: timeout, timeoutReason: "NONE", stopReason: "NONE", outcome: "RUNNING" }
    report.commands.push(record)
    let owned
    try { owned = spawnOwnedProcess(binary, args, { cwd, env, timeout, cleanupMs: 3000 }) }
    catch { record.outcome = "SPAWN_ERROR"; record.elapsedMs = Date.now() - commandAt; throw new Error("SETUP") }
    processes.add(owned)
    const observed = observeOwnedProcess(owned)
    let stdout = "", size = 0, ready = 0, composite = 0, errTail = "", outTail = ""
    const observe = (bytes, stderr) => {
      size += bytes.length
      if (size > 2 * 1024 * 1024) { stop("BYTE_BUDGET"); return }
      const text = (stderr ? errTail : outTail) + bytes.toString("utf8")
      if (host) report.idError ||= text.includes(HISTORIC_ID_ERROR)
      if (stderr) {
        const lines = text.split(/\r?\n/); errTail = lines.pop().slice(-128)
        ready += lines.filter((line) => line === READY).length
        composite += lines.filter((line) => line === "O4E_RESUME_ACCEPTANCE_COMPOSITE_READY").length
      } else { outTail = text.slice(-128); if (capture) stdout += bytes.toString("utf8") }
    }
    owned.child.stdout.on("data", (bytes) => observe(bytes, false)); owned.child.stderr.on("data", (bytes) => observe(bytes, true))
    const timer = setTimeout(() => stop(setupCommand ? "SETUP" : "TOTAL_BUDGET", true), timeout)
    let result
    try {
      result = await observed; record.supervision = result; record.elapsedMs = Date.now() - commandAt
      if (Date.now() - startedAt >= (setupCommand ? BUDGET.setupMs : BUDGET.cleanupAtMs)) stop(setupCommand ? "SETUP" : "TOTAL_BUDGET", true)
      record.outcome = !result.accepted ? "SUPERVISOR_REJECTED" : result.childExitCode === 0 ? "COMPLETED" : "CHILD_EXIT"
      if (result.cleanup === "CONFIRMED") report.counts.cleanedProcesses++
      if (!result.accepted || result.cleanup !== "CONFIRMED") { cleanupFailed = true; throw new Error("CLEANUP") }
    }
    finally { clearTimeout(timer); owned.stop(); processes.delete(owned) }
    if (host) report.checks.hostExitedZero = result.childExitCode === 0
    check(!stopReason && result.childExitCode === 0, stopReason ?? (host ? "HOST_ERROR" : "SETUP"))
    return { stdout, ready: ready + Number(errTail === READY), composite: composite + Number(errTail === "O4E_RESUME_ACCEPTANCE_COMPOSITE_READY") }
  }
  try {
    progress.enter("ENVIRONMENT")
    check(process.platform === "linux" && Number(process.versions.node.split(".")[0]) >= 22, "SETUP")
    check(realpathSync(options.source) === options.source && lstatSync(options.source).isDirectory() && filesUnchanged(frozenFiles), "SOURCE")
    const binary = hostExecutable()
    env = strictEnvironment(options.root, realpathSync(binary))
    for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME,
      env.OPENCODE_TEST_MANAGED_CONFIG_DIR, env.OPENCODE_CONFIG_DIR]) mkdirSync(path, { recursive: true, mode: 0o700 })
    for (const path of [env.npm_config_userconfig, env.npm_config_globalconfig]) writeFileSync(path, "", { flag: "wx", mode: 0o600 })
    progress.enter("SOURCE")
    const snapshot = await sourceSnapshot(options.source, command)
    report.hashes.sourceCommit = snapshot.head; report.hashes.sourceIndexTree = snapshot.tree
    report.hashes.harness = hash(JSON.stringify(frozenFiles.map((entry) => ({ name: entry.path.slice(entry.path.lastIndexOf("/") + 1), hash: entry.hash }))))
    progress.enter("HOST_VERSION")
    const version = await command(binary, ["--version"], { capture: true })
    check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.stdout.trim()), "SETUP"); report.hostVersion = version.stdout.trim()
    const binaryHash = hash(fileBytes(realpathSync(binary), 512 * 1024 * 1024)); report.hashes.hostBinary = binaryHash
    const project = join(options.root, "project"), harness = join(options.root, "harness")
    progress.enter("INSTALL")
    mkdirSync(project); await command("git", ["init", "--quiet", project])
    const installer = join(options.source, "scripts/installer.mjs")
    await command(process.execPath, [installer, "install", "--no-tui", "--no-soul", "--no-skills", "--lang=en", `--target=${project}`])
    progress.enter("CONFIG")
    const coreRoot = join(project, ".opencode/plugins/opencode-for-everything")
    check(hash(fileBytes(join(coreRoot, "jsonc.mjs"))) === hash(fileBytes(join(options.source, "src/jsonc.mjs"))), "SOURCE")
    const { stripJsonComments } = await import(pathToFileURL(join(coreRoot, "jsonc.mjs")).href)
    const configPath = join(project, ".o4e/config.jsonc"), config = json(stripJsonComments(fileBytes(configPath).toString()))
    check(object(config?.permission), "CONFIG")
    const baseline = JSON.stringify(config.permission)
    config.agentsDir = "acceptance-agents"; config.loadSkills = []; config.loadWorkflows = []; config.loadAgents = []; config.loadMcp = {}
    config.instructionFiles = { global: [], project: [] }; config.backgroundTasks = { ...config.backgroundTasks, maxRetries: 0, maxConcurrentAgents: 1 }
    check(JSON.stringify(config.permission) === baseline, "CONFIG"); report.checks.baselinePermissionUnchanged = true
    report.hashes.baselinePermission = hash(baseline)
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    for (const type of ["primary", "subagent", "all", "system"]) mkdirSync(join(project, ".o4e/acceptance-agents", type), { recursive: true })
    for (const [suffix, type, role] of [["main", "primary", "parent"], ["child", "subagent", "child"]]) {
      const bytes = fileBytes(join(harness, `resume-${suffix}.jsonc`)), agent = json(stripJsonComments(bytes.toString()))
      check(agent?.name === `inspect-${suffix}` && !("model" in agent) && !("fallbackModels" in agent), "CONFIG")
      writeFileSync(join(project, `.o4e/acceptance-agents/${type}/inspect-${suffix}.jsonc`), bytes, { flag: "wx", mode: 0o600 })
    }
    progress.enter("BUILD")
    await command(process.execPath, [installer, "build", `--target=${project}`])
    progress.enter("CORE")
    const core = []
    const visit = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name, path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path, name + "/")
        else { check(entry.isFile(), "INTEGRITY"); const digest = hash(fileBytes(path)); check(digest === hash(fileBytes(join(options.source, "src", name))), "SOURCE"); core.push({ name, digest }) }
      }
    }
    visit(coreRoot)
    check(core.length > 20 && ["adapters/opencode/task-inspection-resume.mjs", "runtime/task-read-budget.mjs", "adapters/opencode/plugin-hooks.ts"]
      .every((name) => core.some((entry) => entry.name === name)), "SOURCE")
    report.hashes.generatedCore = hash(JSON.stringify(core))
    progress.enter("PERMISSION")
    const policyResult = await command(process.execPath, ["--input-type=module", "-e",
      `import { expectedPermission } from ${JSON.stringify(import.meta.url)}; process.stdout.write(JSON.stringify(await expectedPermission(process.argv[1], process.argv[2])))`,
      coreRoot, join(project, ".o4e")], { capture: true })
    const policy = json(policyResult.stdout)
    check(Array.isArray(policy?.child) && Array.isArray(policy.parent), "PRODUCTION")
    report.hashes.expectedChildPermission = hash(JSON.stringify(policy.child))
    const { evaluate } = await import(pathToFileURL(join(coreRoot, "core/permission-rules.mjs")).href)
    const { delegationAuthorizationFingerprintFromEnvelope: fingerprint } = await import(pathToFileURL(join(coreRoot, "runtime/delegation-runtime.mjs")).href)
    const { taskText } = await import(pathToFileURL(join(coreRoot, "core/background-task-domain.mjs")).href)
    report.dependencies = await prepareDependencies(options.root, command, progress.enter, options.dependencyArtifact, options.dependencyHash)
    hostVersionForArtifact(report.hostVersion, report.dependencies.versions); report.checks.hostMatchesArtifactSource = true
    report.hashes.dependencyArtifact = report.dependencies.artifactHash; report.hashes.dependencyLock = report.dependencies.lockHash
    progress.enter("ROUTES")
    const routes = options.mode === "live" ? json((await command(process.execPath, ["--input-type=module", "-e",
      `import { liveRoutes } from ${JSON.stringify(import.meta.url)}; process.stdout.write(JSON.stringify(await liveRoutes(JSON.parse(process.argv[1]))))`,
      JSON.stringify({ ...options, resolverHome: process.env.HOME })], { capture: true })).stdout) : {}
    check(object(routes) && (options.mode !== "live" || object(routes.parent) && object(routes.child)), "CONFIG")
    progress.enter("HOST_CONFIG")
    const localKey = randomUUID()
    const receive = async (req, max, controller) => {
      const chunks = []; let length = 0
      const abort = () => req.destroy(); controller.signal.addEventListener("abort", abort, { once: true })
      try { for await (const chunk of req) { controller.signal.throwIfAborted(); length += chunk.length; check(length <= max, "BYTE_BUDGET"); chunks.push(chunk) } }
      finally { controller.signal.removeEventListener("abort", abort) }
      return Buffer.concat(chunks)
    }
    const handle = async (req, res) => {
      const controller = new AbortController(); controllers.add(controller)
      const timer = setTimeout(() => stop("REQUEST_BUDGET"), Math.min(BUDGET.requestMs, Math.max(1, remaining())))
      let role, ownsRole = false, response
      res.on("close", () => { if (!res.writableEnded && !closed) stop("TRANSPORT") })
      try {
        check(!closed && req.method === "POST" && req.headers.authorization === `Bearer ${localKey}`, "ADMISSION")
        if (req.url === "/abort") {
          const value = json((await receive(req, 128, controller)).toString())
          check(object(value) && REASONS.includes(value.reason) && typeof value.idError === "boolean"
            && same(value, { reason: value.reason, idError: value.idError }), "ADMISSION")
          report.idError ||= value.idError; res.writeHead(204).end(); stop(value.reason); return
        }
        check(req.url === "/v1/chat/completions" && actualStart !== undefined, "ADMISSION")
        const bytes = await receive(req, BUDGET.requestBytes, controller), body = json(bytes.toString()), requestHash = hash(bytes)
        role = req.headers["x-o4e-acceptance-role"]
        const admitted = requestAdmission(body, { role, calls: report.counts[role], bytes: bytes.length, elapsedMs: Date.now() - startedAt })
        check(admitted === "ACCEPT", admitted)
        const runtime = req.headers["x-o4e-acceptance-runtime"]
        check(typeof runtime === "string" && /^[a-f0-9-]{36}$/.test(runtime) && !activeRoles.has(role) && !requests.has(requestHash), "IDENTITY")
        runtimes.add(runtime); check(runtimes.size === 1, "IDENTITY"); activeRoles.add(role); ownsRole = true; requests.add(requestHash)
        report.counts[role]++
        const record = { role, number: report.counts[role], requestHash, requestBytes: bytes.length, complete: false }
        report.requests.push(record)
        if (options.mode === "controlled") {
          if (role === "parent") await delay(BUDGET.parentPaceMs, undefined, { signal: controller.signal })
          const reply = controlledReply(body, role, report.counts[role])
          const paced = role === "child" && report.counts.child < 3
          response = new Response(paced ? new ReadableStream({
            async start(stream) {
              try {
                for (const frame of reply.toString().split("\n\n").filter(Boolean)) {
                  controller.signal.throwIfAborted(); stream.enqueue(Buffer.from(frame + "\n\n"))
                  if (json(frame.slice(6))?.choices?.[0]?.delta?.content) await delay(BUDGET.publicPaceMs, undefined, { signal: controller.signal })
                }
                stream.close()
              } catch { stream.error(new Error("TRANSPORT")) }
            },
            cancel() { controller.abort() },
          }) : reply, { headers: { "content-type": "text/event-stream" } })
        } else {
          report.counts.upstream++
          response = await fetch(routes[role].url, { method: "POST", headers: routes[role].headers, body: bytes, signal: controller.signal, redirect: "error" })
        }
        if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")
          || ![null, "identity"].includes(response.headers.get("content-encoding"))) {
          await response.body?.cancel(); throw new Error("TRANSPORT")
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
        const chunks = []; let length = 0
        for await (const chunk of response.body) {
          controller.signal.throwIfAborted(); length += chunk.length; check(length <= BUDGET.responseBytes, "BYTE_BUDGET")
          chunks.push(Buffer.from(chunk))
          if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal })
        }
        const responseBytes = Buffer.concat(chunks)
        record.responseHash = hash(responseBytes); record.responseBytes = length
        check(streamEvidence(responseBytes).complete, "TRANSPORT")
        record.complete = true; report.counts.streams++; res.end()
      } catch (error) {
        report.counts.denied++; stop(reasonOf(error, "TRANSPORT")); res.destroy()
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
      finally { clearTimeout(timer); controllers.delete(controller); if (ownsRole) activeRoles.delete(role) }
    }
    server = createServer((req, res) => { const p = handle(req, res); pending.add(p); p.finally(() => pending.delete(p)) })
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
    server.on("clientError", (_error, socket) => { socket.destroy(); stop("ADMISSION") })
    server.requestTimeout = BUDGET.requestMs; server.headersTimeout = 10000
    server.listen(0, "127.0.0.1"); await once(server, "listening")
    const proxy = `http://127.0.0.1:${server.address().port}`
    env.O4E_RESUME_LOCAL_KEY = localKey; env.O4E_RESUME_MANIFEST = join(options.root, "manifest.json")
    const host = { $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(join(harness, "resume-closure-plugin.mjs")).href],
      agent: { title: { disable: true }, summary: { disable: true } }, provider: {}, enabled_providers: Object.values(PROVIDERS),
      default_agent: "inspect-main", model: `${PROVIDERS.parent}/${MODELS.parent}`, instructions: [], mcp: {}, share: "disabled",
      snapshot: false, autoupdate: false, shell: "/bin/bash", formatter: false, lsp: false, compaction: { auto: false }, logLevel: "ERROR" }
    for (const [role, suffix] of [["parent", "main"], ["child", "child"]]) {
      host.provider[PROVIDERS[role]] = { npm: "@ai-sdk/openai-compatible", name: PROVIDERS[role],
        options: { baseURL: proxy + "/v1", apiKey: "{env:O4E_RESUME_LOCAL_KEY}", timeout: BUDGET.requestMs },
        models: { [MODELS[role]]: routes[role]?.metadata ?? { name: MODELS[role], toolcall: true, limit: { context: 131072, output: BUDGET[`${role}Tokens`] } } } }
      const generated = fileBytes(join(project, `.opencode/agents/inspect-${suffix}.md`)).toString(), match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(generated)
      check(match?.[1].startsWith(`<!--opencode-for-everything-agent:inspect-${suffix}-->`), "PRODUCTION")
      host.agent[`inspect-${suffix}`] = { mode: role === "parent" ? "primary" : "subagent", prompt: match[1] }
    }
    check(!Object.hasOwn(host, "permission"), "CONFIG")
    writeFileSync(env.OPENCODE_CONFIG, JSON.stringify(host), { flag: "wx", mode: 0o600 })
    const configFiles = []
    const configTree = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) configTree(path)
        else { check(entry.isFile(), "INTEGRITY"); configFiles.push(path) }
      }
    }
    configTree(join(project, ".o4e"))
    check(fileBytes(join(project, ".opencode/plugins/opencode-for-everything.ts")).toString()
      === 'export { OpenCodeForEverythingPlugin } from "./opencode-for-everything/plugin.ts"\n', "SOURCE")
    const immutable = [...frozenFiles, ...[...configFiles, env.OPENCODE_CONFIG, join(project, ".opencode/plugins/opencode-for-everything.ts"),
      ...["inspect-main.md", "inspect-child.md"].map((p) => join(project, ".opencode/agents", p)), ...core.map((entry) => join(coreRoot, entry.name))]
      .map((path) => ({ path, hash: hash(fileBytes(path)) }))]
    const stateDir = join(project, ".acceptance/guard"); initializeAcceptance(stateDir)
    writeFileSync(env.O4E_RESUME_MANIFEST, JSON.stringify({ project, proxy, immutable, audit: join(options.root, "guard.jsonl"), deadline: startedAt + BUDGET.cleanupAtMs }), { flag: "wx", mode: 0o600 })
    progress.enter("FINALIZE")
    const dbPath = join(env.XDG_DATA_HOME, "opencode/opencode.db")
    check(!existsSync(dbPath) && !stopReason && Date.now() - startedAt < BUDGET.setupMs, "SETUP")
    progress.finish(); check(report.setup.completed, "SETUP")
    setup = false; clearTimeout(setupTimer); actualStart = Date.now()
    const prompt = fileBytes(join(harness, "resume-acceptance-prompt.md")).toString()
      + `\nYour FIRST tool must be task with exactly ${JSON.stringify(CREATION)}. Explicit ioTimeoutMs:10000 may be supplied on watch/inspect only.\n`
    const run = await command(binary, ["run", "--print-logs", "--log-level", "ERROR", "--format", "json", "--title", "Bounded Resume closure",
      "--agent", "inspect-main", "--model", `${PROVIDERS.parent}/${MODELS.parent}`, prompt], { cwd: project, host: true })
    const endedAt = Date.now(); closed = true
    for (const controller of controllers) controller.abort()
    server.closeAllConnections(); await new Promise((done) => server.close(done)); await Promise.allSettled(pending)
    report.checks.ready = run.ready === 1 && run.composite === 1 && runtimes.size === 1
    report.checks.immutable = filesUnchanged(immutable)
    const originalCore = JSON.stringify(core); core.length = 0; visit(coreRoot)
    report.checks.generatedCoreUnchanged = JSON.stringify(core) === originalCore
    report.checks.hostUnchanged = hash(fileBytes(realpathSync(binary), 512 * 1024 * 1024)) === binaryHash
    report.checks.dependencies = [join(project, ".opencode"), env.OPENCODE_CONFIG_DIR].every((prefix) => ["plugin", "sdk"]
      .every((name) => json(fileBytes(join(prefix, "node_modules/@opencode-ai", name, "package.json"))).version === report.dependencies.versions[name]))
    report.checks.transport = report.counts.denied === 0 && report.counts.parent > 0 && report.counts.child === 3
      && report.counts.streams === report.counts.parent + report.counts.child && report.counts.upstream === (options.mode === "live" ? report.counts.streams : 0)
    report.checks.sourceIndexUnchanged = same(await sourceSnapshot(options.source, command), snapshot)
      && core.every((entry) => hash(fileBytes(join(options.source, "src", entry.name))) === entry.digest)
    const stat = lstatSync(dbPath)
    check(stat.isFile() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024 && stat.birthtimeMs >= actualStart, "EVIDENCE")
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      check(Object.values(db.prepare("PRAGMA quick_check").get())[0] === "ok", "EVIDENCE")
      for (const table of ["session", "message", "part"]) check(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n <= 2000, "EVIDENCE")
      const sessions = db.prepare("SELECT id, parent_id, directory, time_created, permission, metadata FROM session").all()
        .map((row) => ({ ...row, permission: json(row.permission), metadata: json(row.metadata) }))
      const messages = db.prepare("SELECT id, session_id, data FROM message ORDER BY time_created, id").all().map((row) => ({ ...json(row.data), id: row.id, sessionID: row.session_id }))
      const parts = db.prepare("SELECT id, session_id, message_id, data FROM part ORDER BY time_created, id").all().map((row) => ({ ...json(row.data), id: row.id, sessionID: row.session_id, messageID: row.message_id }))
      const audit = fileBytes(join(options.root, "guard.jsonl"), 256 * 1024).toString().trim().split("\n").map((line) => JSON.parse(line))
      report.checks.runtimeLinked = audit.filter((entry) => entry.kind === "READY").length === 1 && runtimes.has(audit.find((entry) => entry.kind === "READY")?.runtimeID)
      report.evidence = await closureEvidence({ sessions, messages, parts, audit, project, stateDir, startedAt: actualStart, endedAt }, { ...policy, evaluate, fingerprint, taskText })
      report.idError ||= report.evidence.idError
    } finally { db.close() }
    check(report.evidence.passed && Object.values(report.checks).every(Boolean) && !stopReason, "EVIDENCE")
    report.verdict = "passed"; report.reason = "NONE"
  } catch (error) { report.reason = stopReason ?? reasonOf(error) }
  finally {
    if (setup) progress.finish(report.reason)
    stop()
    const results = await Promise.allSettled([...processes].map((owned) => owned.result))
    cleanupFailed ||= results.some((entry) => entry.status !== "fulfilled" || entry.value.cleaned !== true)
    if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)) }
    await Promise.allSettled(pending)
    clearTimeout(setupTimer); clearTimeout(deadline); clearTimeout(hard)
    process.off("SIGINT", signal); process.off("SIGTERM", signal)
    report.cleanup = { confirmed: 0, failed: 0, unproven: 0 }
    for (const record of report.commands) report.cleanup[record.supervision?.cleanup === "CONFIRMED" ? "confirmed" : record.supervision?.cleanup === "FAILED" ? "failed" : "unproven"]++
    report.cleanup.status = report.cleanup.failed ? "FAILED" : report.cleanup.unproven ? "UNPROVEN" : "CONFIRMED"
    report.checks.ownedProcessesStopped = report.cleanup.status === "CONFIRMED"
    cleanupFailed ||= !report.checks.ownedProcessesStopped
    if (cleanupFailed || stopReason) { report.verdict = "failed"; report.reason = stopReason ?? "CLEANUP" }
    report.elapsedMs = Date.now() - startedAt
    if (report.elapsedMs >= BUDGET.totalMs) { report.verdict = "failed"; report.reason = "TOTAL_BUDGET" }
    save()
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runAcceptance(parseCLI(process.argv.slice(2)))
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.verdict === "passed" ? 0 : 1
  } catch { process.stdout.write('{"verdict":"failed","reason":"ARGUMENTS"}\n'); process.exitCode = 2 }
}
