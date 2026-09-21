import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { createAcceptance, initializeAcceptance } from "./wait-guard.mjs"
import resumePlugin from "./resume-acceptance-plugin.mjs"
import { resumeInspectionEvidence } from "./resume-acceptance.mjs"
import { readTaskInspection } from "../../src/adapters/opencode/task-inspection.mjs"
import { resolveInspectionCursors } from "../../src/adapters/opencode/task-inspection-resume.mjs"
import { inspectionText } from "../../src/runtime/task-result-visibility.mjs"

function part(id, input, output, tool = "o4e_task", status = "completed") {
  const body = tool === "task" ? "Task task start · queued"
    : input.action === "inspect" && output ? inspectionText(output, "agent")
      : input.action === "output" && typeof output?.output === "string" ? output.output : "status only"
  return { id, callID: `call-${id}`, type: "tool", tool, sessionID: "parent", messageID: "parent-message",
    state: { status, input, ...(output === undefined ? {} : { output: body, metadata: { kind: "agent", o4eResult: output } }) } }
}
const messages = (parts) => [{ info: { id: "parent-message", role: "assistant", sessionID: "parent" },
  parts: parts.map((entry, index) => ({ ...entry, state: { time: { start: index * 2, end: index * 2 + 1 }, ...entry.state } })) }]
const grade = (parts) => resumeInspectionEvidence(messages(parts), "task", "child")
const preview = (extra = {}) => ({ taskID: "task", status: "running", cursor: "opaque-position", ...extra })
const inspect = (id, input, output, status) => part(id, { action: "inspect", taskID: "task", maxBytes: 128, ...input },
  preview({ ...output }), "o4e_task", status)
const watch = (id, output, input = {}) => part(id, { action: "watch", taskID: "task", timeoutMs: 1000, ...input }, output)

function history() {
  return [
    part("creation", { subagent_type: "inspect-child", prompt: "Follow the guarded protocol" },
      { taskID: "task", sessionID: "child", agent: "inspect-child", status: "queued" }, "task"),
    inspect("begin", { direction: "forward", resume: false }, { tail: "BEGIN\npublic progress", cursor: "begin-cursor" }),
    watch("running", { reason: "heartbeat", tasks: [{ taskID: "task", status: "running", phase: "dispatched", revision: 2 }] }),
    inspect("middle", { direction: "forward", resume: true }, { tail: "MIDDLE\npublic progress", cursor: "middle-cursor" }),
    watch("terminal", { reason: "actionable", tasks: [{ taskID: "task", status: "completed", phase: "completed", revision: 4 }] }),
    part("output", { action: "output", taskID: "task" }, { taskID: "task", status: "completed", output: "O4E_INSPECT_ACCEPTANCE_DONE" }),
    inspect("fresh", { direction: "forward", resume: false }, { status: "completed", tail: "recent", beforeCursor: "before", cursor: "end" }),
    inspect("backward", { direction: "backward", resume: true }, { status: "completed", tail: "previous", cursor: "before" }),
    inspect("forward", { direction: "forward", resume: true }, { status: "completed", tail: "recent", cursor: "end" }),
    inspect("latest", { direction: "forward", resume: true }, { status: "completed", unchanged: true, cursor: "end" }),
  ]
}

test("current Task acceptance uses status-only watch, inspect resume, one output read and final inspect pagination", () => {
  const report = grade(history())
  assert.equal(report.passed, true, JSON.stringify(report.checks))
  assert.ok(Object.values(report.checks).every(Boolean))
  assert.equal(report.cursorSource, "o4e_task-inspect-resume")
  assert.deepEqual(report.partIDs.sequence, ["fresh", "backward", "forward", "latest"])
  assert.deepEqual(report.counts, { creations: 1, watches: 2, progressInspections: 2, inspections: 6,
    finalInspections: 4, freshRecoveries: 0, userMessages: 0 })
})

test("legacy watch preview/resume and output reread shapes are rejected rather than accepted as compatibility", () => {
  for (const mutate of [
    (parts) => { parts[2].state.input.resume = true },
    (parts) => { parts[2].state.input.cursor = "old" },
    (parts) => { parts[2].state.metadata.o4eResult.tasks[0].tail = "legacy preview" },
    (parts) => { parts[2].state.metadata.o4eResult.tasks[0].cursor = "legacy cursor" },
    (parts) => { parts[5].state.input.reread = true },
    (parts) => { parts[5].state.output = "Task task output · completed\n\nO4E_INSPECT_ACCEPTANCE_DONE" },
  ]) {
    const parts = history(); mutate(parts)
    assert.equal(grade(parts).passed, false, String(mutate))
  }
})

test("watch permits only current selector, timeout and read budget fields and never carries progress text", () => {
  for (const key of ["direction", "maxBytes", "cursors", "reread"]) {
    const parts = history(); parts[2].state.input[key] = key === "maxBytes" ? 128 : key === "cursors" ? {} : true
    assert.equal(grade(parts).checks.currentWatchProtocol, false)
  }
  const valid = history(); valid[2].state.input.ioTimeoutMs = 10000
  assert.equal(grade(valid).passed, true)
  for (const key of ["tail", "beforeCursor", "unchanged", "unavailable", "gap", "output", "outputTruncated"]) {
    const parts = history(); parts[2].state.metadata.o4eResult.tasks[0][key] = key === "unchanged" ? true : "legacy"
    assert.equal(grade(parts).checks.statusOnlyWatch, false)
    assert.equal(grade(parts).passed, false)
  }
})

test("inspect gap or unavailable is a barrier until an explicit fresh inspect", () => {
  for (const kind of ["gap", "unavailable"]) {
    const parts = history()
    parts.splice(3, 0, inspect("interrupted", { direction: "forward", resume: true }, { [kind]: "source-changed" }))
    let report = grade(parts)
    assert.equal(report.passed, false)
    assert.equal(report[`${kind}Count`], 1)
    parts.splice(4, 0, inspect("recovery", { direction: "forward", resume: false }, { tail: "fresh position", cursor: "recovered" }))
    report = grade(parts)
    assert.equal(report.passed, true, JSON.stringify(report.checks))
    assert.deepEqual(report.freshRecoveryPartIDs, ["recovery"])
    parts[4].state.input.resume = true
    assert.equal(grade(parts).checks.explicitFreshRecovery, false)
  }
})

test("user-message watch interruption cannot be silently treated as task progress", () => {
  const parts = history()
  parts.splice(4, 0, watch("user-message", { reason: "user-message", userMessage: true,
    tasks: [{ taskID: "task", status: "running", phase: "dispatched", revision: 3 }] }))
  const report = grade(parts)
  assert.equal(report.checks.currentWatchProtocol, true)
  assert.equal(report.checks.noUserInterruption, false)
  assert.equal(report.counts.userMessages, 1)
  assert.equal(report.passed, false)
})

test("inspect metadata requires intact production-rendered public text", () => {
  for (const mutate of [
    (parts) => { parts[3].state.output = "forged" },
    (parts) => { delete parts[3].state.metadata },
    (parts) => { parts[3].state.metadata.o4eResult.taskID = "other" },
    (parts) => { parts[3].state.time = { compacted: 1 } },
    (parts) => { parts[3].state.metadata.truncated = true },
  ]) {
    const parts = history(); mutate(parts)
    assert.equal(grade(parts).passed, false, String(mutate))
  }
})

test("final inspect sequence is four distinct persisted calls with current resume rules", () => {
  for (const mutate of [
    (parts) => { parts[6].state.input.resume = true },
    (parts) => { parts[7].state.input.resume = false },
    (parts) => { parts[8].state.input.cursor = "manual-with-resume" },
    (parts) => { parts[9].state.input.direction = "backward" },
    (parts) => { parts[8].state.metadata.o4eResult.tail = "different"; parts[8].state.output = inspectionText(parts[8].state.metadata.o4eResult, "agent") },
    (parts) => { parts[9].state.metadata.o4eResult = preview({ status: "completed", tail: "not unchanged" }); parts[9].state.output = inspectionText(parts[9].state.metadata.o4eResult, "agent") },
    (parts) => { parts[9].id = parts[8].id },
    (parts) => { parts.splice(8, 0, part("interleaved", { action: "status", taskID: "task" }, { taskID: "task", status: "completed" })) },
  ]) {
    const parts = history(); mutate(parts)
    assert.equal(grade(parts).passed, false, String(mutate))
  }
})

test("hidden, synthetic, compacted and user records cannot provide acceptance evidence", () => {
  for (const flags of [{ synthetic: true }, { ignored: true }, { visibility: "private" }, { private: true }, { summary: true }, { mode: "compaction" }]) {
    for (const level of ["message", "info", "part", "state"]) {
      const data = messages(history())
      Object.assign(level === "message" ? data[0] : level === "info" ? data[0].info : level === "part" ? data[0].parts[9] : data[0].parts[9].state, flags)
      assert.equal(resumeInspectionEvidence(data, "task", "child").passed, false)
    }
  }
  const data = messages(history()); data[0].info.role = "user"
  assert.equal(resumeInspectionEvidence(data, "task", "child").passed, false)
})

test("production reader and resolver continue from an intact inspect anchor and fail closed on source changes", async () => {
  const record = { kind: "agent", taskID: "task", childSessionID: "child", dispatchMessageID: "dispatch", runGeneration: 0, attemptNumber: 1 }
  const body = { id: "body", type: "text", text: "BEGIN\n" + "safe ".repeat(100) }
  const child = [{ info: { id: "dispatch", role: "user", sessionID: "child" }, parts: [] },
    { info: { id: "answer", role: "assistant", sessionID: "child", parentID: "dispatch" }, parts: [body] }]
  const parent = []
  const store = { messagePage: async (sessionID) => ({ messages: sessionID === "parent" ? messages(parent) : child }) }
  const first = await readTaskInspection({ store, record, direction: "forward", maxBytes: 128 })
  assert.ok(first.tail); assert.ok(first.cursor)
  const prior = part("prior", { action: "inspect", taskID: "task", direction: "forward", maxBytes: 128 }, { taskID: "task", status: "running", ...first })
  const current = part("current", { action: "inspect", taskID: "task", direction: "forward", maxBytes: 128, resume: true }, undefined, "o4e_task", "running")
  parent.push(prior, current)
  const args = { store, sessionID: "parent", messageID: "parent-message", callID: current.callID, taskIDs: ["task"], direction: "forward" }
  assert.deepEqual(await resolveInspectionCursors(args), { cursors: { task: first.cursor }, unavailable: {} })
  body.text += "\nMIDDLE\n" + "more ".repeat(50)
  const continued = await readTaskInspection({ store, record, cursor: first.cursor, direction: "forward", maxBytes: 128 })
  assert.match(continued.tail, /MIDDLE/)
  prior.state.output = "forged replacement"
  assert.deepEqual(await resolveInspectionCursors(args), { cursors: {}, unavailable: { task: "resume-preview-unavailable" } })
  prior.state.output = inspectionText(prior.state.metadata.o4eResult, "agent")
  body.text = "rewritten prefix"
  assert.deepEqual(await readTaskInspection({ store, record, cursor: first.cursor, direction: "forward", maxBytes: 128 }), { gap: "source-changed" })
})

function guardFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "resume-acceptance-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const stateDir = join(directory, ".acceptance", "guard"); initializeAcceptance(stateDir)
  const task = { taskID: "task", dispatchMessageID: "dispatch", childSessionID: "child", taskSessionID: "child",
    ownerSessionID: "parent", agent: "inspect-child", createdAt: Date.now(), attemptNumber: 1, runGeneration: 0, status: "running" }
  const child = [{ info: { id: "dispatch", role: "user", sessionID: "child" }, parts: [] }]
  const client = { session: { get: async ({ path }) => ({ data: path.id === "parent"
    ? { id: "parent", metadata: { o4e: { backgroundTasks: { taskRefs: { task: { taskSessionID: "child" } } } } } }
    : { id: "child", parentID: "parent", metadata: { o4e: { task } } } }),
  messages: async ({ path }) => ({ data: path.id === "child" ? child : messages(history()) }) } }
  const settings = { client, directory, stateDir, inspectionEvidence: resumeInspectionEvidence, sleep: async (ms) => assert.equal(ms, 45_000) }
  const parent = { agent: "inspect-main", sessionID: "parent", directory, ask: async () => {}, abort: new AbortController().signal }
  return { directory, stateDir, task, child, client, settings, parent }
}

test("current inspection evidence still requires the original guarded execution and one generation", async (t) => {
  const f = guardFixture(t), api = createAcceptance(f.settings)
  let report = JSON.parse(await api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.inspection.passed, true); assert.equal(report.executionPassed, false); assert.equal(report.passed, false)
  for (const stage of ["BEGIN", "MIDDLE"]) {
    const wait = { id: `wait-${stage}`, type: "tool", tool: "acceptance_wait", callID: `wait-call-${stage}`, state: { status: "running", input: { stage } } }
    f.child.push({ info: { id: `msg-${stage}`, role: "assistant", sessionID: "child", parentID: "dispatch" }, parts: [
      { id: `text-${stage}`, type: "text", text: `${stage}\n${"safe ".repeat(60)}`, time: { end: Date.now() } }, wait] })
    wait.state.output = await api.wait({ stage }, { ...f.parent, agent: "inspect-child", sessionID: "child", messageID: `msg-${stage}`, callID: wait.callID, metadata() {} })
    wait.state.status = "completed"
  }
  f.task.status = "completed"; f.child.at(-1).parts.push({ id: "final", type: "text", text: "O4E_INSPECT_ACCEPTANCE_DONE" })
  report = JSON.parse(await api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.passed, true); assert.equal(report.admitted, 2); assert.equal(report.completed, 2)
  f.task.runGeneration = 1
  await assert.rejects(api.evidence({ taskID: "task" }, f.parent), /Unverified acceptance Task/)
})

test("plugin composes one production Runtime and preserves the production o4e_task identity", async (t) => {
  const f = guardFixture(t)
  const packageDir = join(f.directory, ".opencode", "node_modules", "@opencode-ai", "plugin")
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module", exports: { "./tool": { import: "./tool.js" } } }))
  writeFileSync(join(packageDir, "tool.js"), "export const tool = (value) => value; tool.schema = { enum: () => ({}), string: () => ({}) }")
  const plugins = join(f.directory, ".opencode", "plugins"); mkdirSync(plugins)
  const path = join(plugins, "opencode-for-everything.ts")
  writeFileSync(path, `
    let initialized = 0
    export default () => { throw new Error("must initialize the named export only") }
    export const hooks = { config() {}, dispose() {}, event() {}, "tool.execute.before"() {}, "chat.message"() {},
      tool: { task: {}, o4e_task: { args: {}, execute: (args, context) => ({ args, context }) }, o4e_workflow: {} } }
    export const OpenCodeForEverythingPlugin = async (input) => {
      if (++initialized !== 1) throw new Error("duplicate Runtime")
      if (!input.client) throw new Error("missing host input")
      return hooks
    }
  `)
  const original = (await import(pathToFileURL(path).href)).hooks
  const hooks = await resumePlugin({ client: f.client, directory: f.directory })
  for (const key of Object.keys(original).filter((key) => key !== "tool")) assert.equal(hooks[key], original[key])
  for (const key of Object.keys(original.tool)) assert.equal(hooks.tool[key], original.tool[key])
  assert.deepEqual(Object.keys(hooks.tool), ["task", "o4e_task", "o4e_workflow", "acceptance_wait", "acceptance_evidence"])
  const args = { action: "inspect", resume: true }
  assert.deepEqual(hooks.tool.o4e_task.execute(args, f.parent), { args, context: f.parent })
  const report = JSON.parse(await hooks.tool.acceptance_evidence.execute({ taskID: "task" }, f.parent))
  assert.equal(report.inspection.cursorSource, "o4e_task-inspect-resume")
  assert.equal(report.inspection.passed, true)
  assert.equal(report.passed, false, "plugin does not bypass the execution guard")
})
