import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { compileWorkflowRegistry, workflowHash } from "../src/core/workflow-definition.mjs"
import { newProcess, normalizeProcessArgs, validateProcessArgs } from "../src/core/workflow-process.mjs"
import { WorkflowRuntime } from "../src/runtime/workflow-runtime.mjs"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"
import { copyInstalledDefaults, readConfigJson, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { taskMetadata, normalizeTaskGroupMetadata } from "../src/core/background-task-domain.mjs"
import { delegationAuthorizationFingerprintFromEnvelope } from "../src/runtime/delegation-runtime.mjs"
import { presentTaskResult } from "../src/runtime/task-model-output.mjs"

const report = (output = {}) => ({ status: "reported-completed", output, artifacts: [], evidence: [], diagnostics: [] })
const definition = (steps = ["first", "second", "third"].map((id, index, ids) => ({ id, type: "work", dependsOn: index ? [ids[index - 1]] : [] }))) => ({
  contract: "process-v1", name: "investigation", description: "Process tests", output: { $from: "steps", path: `/${steps.at(-1).id}` }, steps,
})

test("Workflow flat tool args route by action and keep strict meaningful validation", () => {
  assert.deepEqual(normalizeProcessArgs({ action: "list", runID: "", expectedRevision: 1, input: "", report: null }), { action: "list" })
  assert.deepEqual(normalizeProcessArgs({ action: "catalog", workflow: "", runID: "" }), { action: "catalog" })
  assert.deepEqual(normalizeProcessArgs({ action: "start", workflow: "investigation", input: {}, runID: "" }), {
    action: "start", workflow: "investigation", input: {},
  })
  assert.throws(() => validateProcessArgs(normalizeProcessArgs({ action: "list", runID: "unexpected" })), /Allowed fields/)
  assert.throws(() => validateProcessArgs(normalizeProcessArgs({ action: "begin", runID: "run", expectedRevision: 1, stepID: "" })), /stepID/)
})

function fixture(t, value = definition(), { plugin = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "o4e-process-"))
  const sessions = new Map([["owner", { id: "owner", directory, agent: "orchestrator", metadata: {} }],
    ["foreign", { id: "foreign", directory, agent: "orchestrator", metadata: {} }]])
  const messages = new Map([["owner", []], ["foreign", []]])
  const commandSessions = new Map()
  let sequence = 0
  let writes = 0
  let failWrite = false
  let loseResponse = false
  let creates = 0
  let prompts = 0
  let epoch = 0
  let beforeUpdate
  const reads = []
  const client = { session: {
    get: async ({ path }) => { reads.push(["get", path.id]); return { data: structuredClone(sessions.get(path.id)) } },
    update: async ({ path, body }) => {
      if (failWrite) throw new Error("persistence-failed")
      writes++
      sessions.set(path.id, { ...sessions.get(path.id), ...structuredClone(body) })
      if (loseResponse) { loseResponse = false; throw new Error("response-lost") }
      return { data: structuredClone(sessions.get(path.id)) }
    },
    create: async () => { creates++; throw new Error("Workflow must not create Sessions") },
    prompt: async () => { prompts++; throw new Error("Workflow must not dispatch") },
    promptAsync: async () => { prompts++; throw new Error("Workflow must not dispatch") },
    children: async () => ({ data: [] }), list: async () => { throw new Error("must not scan Sessions") },
    status: async () => ({ data: {} }),
    messages: async ({ path }) => { reads.push(["messages", path.id]); return { data: structuredClone(messages.get(path.id) ?? []) } },
  } }
  const agents = [{ name: "orchestrator", type: "all", loadWorkflows: ["*"], loadAgents: [], loadMcp: {}, permission: { o4e_workflow: "allow" } }]
  const snapshot = { agents, allAgents: agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])), workflows: compileWorkflowRegistry([{ value, source: "test" }]), runtime: { config: { enableWorkflow: true } } }
  const store = new OpenCodeSessionStore(client, directory)
  const updateO4E = store.updateO4E.bind(store)
  store.updateO4E = async (...args) => { await beforeUpdate?.(); return updateO4E(...args) }
  const commandStore = { get: async (owner) => structuredClone(commandSessions.get(owner)) }
  const runtime = () => new WorkflowRuntime({ store, commandStore, directory, snapshot: () => snapshot, userTurnEpoch: () => epoch })
  const user = (id = `user-${++sequence}`, sessionID = "owner") => {
    epoch++
    messages.get(sessionID).push({ info: { id, sessionID, role: "user", time: { created: ++sequence } }, parts: [{ id: `p-${id}`, type: "text", text: "user instruction" }] })
    return id
  }
  user()
  user(undefined, "foreign")
  let asks = []
  const context = (args, overrides = {}) => {
    const sessionID = overrides.sessionID ?? "owner"
    const id = `assistant-${++sequence}`
    const callID = `call-${sequence}`
    const parentID = messages.get(sessionID).findLast((entry) => entry.info.role === "user")?.info.id
    messages.get(sessionID).push({ info: { id, sessionID, role: "assistant", parentID, time: { created: sequence } }, parts: [{ id: `p-${id}`, messageID: id, sessionID, type: "tool", tool: "o4e_workflow", callID, state: { status: "running", input: args } }] })
    return { sessionID, agent: "orchestrator", directory, messageID: id, callID, abort: new AbortController().signal,
      ask: async (request) => { asks.push(request) }, ...overrides }
  }
  const toolPart = (tool, input, output, metadata) => {
    const id = `assistant-${++sequence}`
    const callID = `call-${sequence}`
    const part = { id: `p-${id}`, messageID: id, sessionID: "owner", type: "tool", tool, callID, state: { status: "completed", input, output, metadata } }
    messages.get("owner").push({ info: { id, sessionID: "owner", role: "assistant", time: { created: sequence } }, parts: [part] })
    return { messageID: id, callID, part }
  }
  const f = { directory, client, store, snapshot, sessions, commandSessions, messages, reads, runtime, context, user, toolPart,
    get writes() { return writes }, get creates() { return creates }, get prompts() { return prompts }, get asks() { return asks },
    set failWrite(value) { failWrite = value }, set loseResponse(value) { loseResponse = value },
    set beforeUpdate(value) { beforeUpdate = value },
    async call(args, overrides = {}, instance = runtime()) { return JSON.parse(await instance.handle(args, context(args, overrides))) },
    persisted(runID) { return sessions.get("owner").metadata.o4e.workflowProcess.runs[runID] },
    async hooks() {
      copyInstalledDefaults(resolve(import.meta.dirname, ".."), directory)
      const configRoot = join(directory, ".o4e")
      writeConfigJson(join(configRoot, "config.jsonc"), { ...readConfigJson(configRoot, "config"), enableWorkflow: true })
      writeFileSync(join(directory, ".o4e/workflows/investigation.jsonc"), JSON.stringify(value))
      return OpenCodeForEverythingPlugin({ client, directory, worktree: directory })
    },
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return f
}

function indexAgentTask(f, task, envelope) {
  const group = f.sessions.get("owner").metadata.o4e.backgroundTasks ??= { version: 1, revision: 0, nextSequence: 1, taskRefs: {} }
  task.sequence = group.nextSequence++
  group.revision++
  group.taskRefs[task.taskID] = { taskSessionID: task.taskSessionID, kind: "agent", sequence: task.sequence,
    createdAt: task.createdAt, taskRevision: task.revision,
    recoveryEnvelope: { version: 1, task: structuredClone(task), delegation: structuredClone(envelope) } }
  // Fixtures must satisfy the same current index schema as production writes.
  normalizeTaskGroupMetadata(group)
}

function registerAgentTask(f, taskID, agent = "reviewer") {
  const envelope = { toolName: "task", depth: 1, sourceAgent: "orchestrator", targetAgent: agent, parentSessionID: "owner",
    requesterPermissionPattern: agent, requesterPermissionAction: "allow", requesterPermissionApproved: false,
    compiledPermission: [], permissionOverlay: {}, effect: "read", writeScopes: [], trace: { taskID, ownerSessionID: "owner" } }
  envelope.authorizationFingerprint = delegationAuthorizationFingerprintFromEnvelope({
    requesterAgent: envelope.sourceAgent, targetAgent: envelope.targetAgent, requesterPermissionPattern: envelope.requesterPermissionPattern,
    requesterPermissionAction: envelope.requesterPermissionAction, requesterPermissionApproved: false, compiledPermission: [],
    permissionOverlay: {}, effect: "read", normalizedScopes: [], trace: envelope.trace,
  })
  const ledgerID = `ledger-${taskID}`
  const dispatchID = `dispatch-${taskID}`
  const resultID = `result-${taskID}`
  const partID = `result-text-${taskID}`
  const task = taskMetadata({ version: 1, revision: 4, sequence: 1, taskID, kind: "agent", status: "completed", phase: "completed",
    ownerSessionID: "owner", taskSessionID: ledgerID, childSessionID: ledgerID, agent, requesterAgent: "orchestrator",
    requesterPermissionPattern: agent, requesterPermissionAction: "allow", requesterPermissionApproved: false,
    authorizationFingerprint: envelope.authorizationFingerprint, effect: "read", writeScopes: [], dispatchMessageID: dispatchID, attemptSessionIDs: [ledgerID],
    modelCandidates: [], failedModelCandidates: [], maxRetries: 0, attemptNumber: 1, retryRound: 0, runGeneration: 0,
    createdAt: 1, updatedAt: 2, endedAt: 2, result: { sessionID: ledgerID, messageID: resultID, partIDs: [partID] }, diagnostics: [] })
  f.messages.set(ledgerID, [{ info: { id: dispatchID, role: "user" }, parts: [] },
    { info: { id: resultID, role: "assistant", parentID: dispatchID, finish: "stop" }, parts: [{ id: partID, type: "text", text: `result:${taskID}` }] }])
  f.sessions.set(ledgerID, { id: ledgerID, metadata: { o4e: { task, delegation: envelope } } })
  indexAgentTask(f, task, envelope)
  return {
    task, envelope,
    created: () => f.toolPart("task", { subagent_type: agent }, taskID, { o4eResult: { taskID, sessionID: ledgerID } }),
    output: () => f.toolPart("o4e_task", { action: "output", taskID }, `result:${taskID}`,
      { o4eResult: { taskID, status: "completed", revision: task.revision, output: `result:${taskID}`, messageID: resultID, partIDs: [partID] } }),
  }
}

test("Workflow entry diagnoses the real demo mistakes without echoing values or mutating", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work" }]))
  const hooks = await f.hooks()
  t.after(() => hooks.dispose())
  const call = async (args) => JSON.parse(await hooks.tool.o4e_workflow.execute(args, f.context(args)))
  let run = await call({ action: "start", workflow: "investigation" })
  await assert.rejects(call({ action: "begin", runID: run.runID, expectedRevision: 1 }), /INVALID_ARGUMENTS.*stepID/)
  await assert.rejects(call({ action: "begin", runID: run.runID, stepID: "work", revision: 1 }), /INVALID_ARGUMENTS.*expectedRevision/)
  run = await call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  const args = { action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID,
    expectedRevision: 2, submissionID: "demo", report: report() }
  for (const [change, expected] of [
    [{ status: "completed" }, /INVALID_REPORT.*report.status.*reported-completed/],
    [{ diagnostics: {} }, /INVALID_REPORT.*report.diagnostics/],
    [{ evidence: [{ kind: "task-created", taskID: "private-value" }] }, /UNSUPPORTED_EVIDENCE.*messageID.*callID.*read/],
  ]) await assert.rejects(call({ ...args, report: { ...report(), ...change } }), (error) => {
    assert.match(error.message, expected)
    assert.ok(!error.message.includes("private-value"))
    return true
  })
  assert.equal(f.persisted(run.runID).revision, 2)
  assert.deepEqual(f.persisted(run.runID).submissions, {})
  const schema = hooks.tool.o4e_workflow.args.report
  assert.equal(schema.safeParse(report()).success, true)
  assert.equal(schema.safeParse({ ...report(), status: "completed" }).success, false)
  assert.equal(schema.safeParse({ ...report(), evidence: [{ kind: "task-created", taskID: "x" }] }).success, false)
  for (const invalid of [JSON.stringify(args), null, "private-value"]) {
    await assert.rejects(call(invalid), /INVALID_ARGUMENTS.*object/)
  }
  await assert.rejects(call({ ...args, report: JSON.stringify(report()) }), /INVALID_REPORT.*object/)
  const { output: _output, ...missingOutput } = report()
  assert.equal(schema.safeParse(missingOutput).success, false)
  await assert.rejects(call({ ...args, report: missingOutput }), /INVALID_REPORT.*output/)
})

test("public Workflow input preserves native strings through start, provenance and report", async (t) => {
  for (const input of ["plain string", "123", "null", '{"literal":true}', '"quoted"']) await t.test(input, async (t) => {
    const f = fixture(t, { ...definition([{ id: "work", type: "work", inputSchema: { type: "string" } }]), inputSchema: { type: "string" } })
    const hooks = await f.hooks()
    t.after(() => hooks.dispose())
    const call = async (args) => JSON.parse(await hooks.tool.o4e_workflow.execute(args, f.context(args)))
    let run = await call({ action: "start", workflow: "investigation", input })
    run = await call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    assert.equal(run.steps.work.input, input)
    run = await call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID,
      expectedRevision: 2, submissionID: "string", report: report() })
    assert.equal((await call({ action: "read", runID: run.runID })).status, "completed")
  })
})

test("read discovers verified current Attempt references without Task replay; report revalidates them", async (t) => {
  const f = fixture(t, definition([
    { id: "review", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] } },
    { id: "collect", type: "work", dependsOn: ["review"], gate: { evidence: [{ kind: "task-result", taskFrom: "review" }] } },
  ]))
  const hooks = await f.hooks()
  t.after(() => hooks.dispose())
  f.call = async (args) => JSON.parse(await hooks.tool.o4e_workflow.execute(args, f.context(args)))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "review", expectedRevision: 1 })
  const task = registerAgentTask(f, "demo-task")
  const created = task.created()
  const writes = f.writes
  let view = await f.call({ action: "read", runID: run.runID })
  assert.deepEqual(view.availableEvidence.references, [{ kind: "task-created", taskID: task.task.taskID, messageID: created.messageID, callID: created.callID }])
  assert.equal(view.availableEvidence.attemptID, run.steps.review.attemptID)
  assert.equal(f.writes, writes)
  run = await f.call({ action: "report", runID: run.runID, stepID: "review", attemptID: run.steps.review.attemptID,
    expectedRevision: run.revision, submissionID: "created", report: { ...report(), evidence: view.availableEvidence.references } })
  assert.equal(run.decision.accepted, true)
  run = await f.call({ action: "begin", runID: run.runID, stepID: "collect", expectedRevision: run.revision })
  const output = task.output()
  view = await f.call({ action: "read", runID: run.runID })
  assert.deepEqual(view.availableEvidence.references, [{ kind: "task-result", taskID: task.task.taskID, messageID: output.messageID, callID: output.callID }])
  const args = { action: "report", runID: run.runID, stepID: "collect", attemptID: run.steps.collect.attemptID,
    expectedRevision: run.revision, submissionID: "output", report: { ...report(), evidence: view.availableEvidence.references } }
  run = await f.call(args)
  assert.equal(run.status, "completed")
  assert.equal((await f.call(args)).replay, true)
  output.part.state.time = { compacted: 1 }
  await assert.rejects(f.call({ action: "read", runID: run.runID }), /EVIDENCE_SOURCE_LOST/)
  assert.equal(f.creates, 0)
  assert.equal(f.prompts, 0)
})

test("reference discovery omits forged, foreign, stale, hidden and corrupt sources", async (t) => {
  for (const mutation of ["valid", "hidden-detail", "damaged-envelope", "before-begin", "after-read", "same-time", "foreign", "forged", "compacted", "truncated", "hidden", "duplicate", "result-private"]) await t.test(mutation, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work", gate: { evidence: ["task-result"] } }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    const task = registerAgentTask(f, "discovery-task")
    let ref
    if (mutation === "before-begin") ref = task.output()
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    if (!ref) ref = task.output()
    const args = { action: "read", runID: run.runID }
    const context = f.context(args)
    const source = f.messages.get("owner").find((message) => message.info.id === ref.messageID)
    const current = f.messages.get("owner").find((message) => message.info.id === context.messageID)
    if (mutation === "after-read") source.info.time.created = current.info.time.created + 1
    if (mutation === "same-time") source.info.time.created = current.info.time.created
    if (mutation === "foreign") source.info.sessionID = "foreign"
    if (mutation === "forged") ref.part.state.metadata.o4eResult.taskID = "made-up"
    if (mutation === "compacted") ref.part.state.time = { compacted: 1 }
    if (mutation === "truncated") ref.part.state.metadata.truncated = true
    if (mutation === "hidden") ref.part.private = true
    if (mutation === "duplicate") source.parts.push(structuredClone(ref.part))
    if (mutation === "result-private") f.messages.get(task.task.taskSessionID)[1].parts[0].private = true
    if (["hidden-detail", "damaged-envelope"].includes(mutation)) {
      const presented = presentTaskResult({ output: ref.part.state.output, metadata: ref.part.state.metadata }, "output", false)
      Object.assign(ref.part.state, { output: presented.output, metadata: presented.metadata })
      if (mutation === "damaged-envelope") ref.part.state.metadata.o4eModelOutput.text = "forged"
    }
    const view = JSON.parse(await f.runtime().handle(args, context))
    assert.equal(view.availableEvidence.references.length, ["valid", "hidden-detail"].includes(mutation) ? 1 : 0)
    assert.equal(f.persisted(run.runID).revision, 2)
  })
})

test("discovery is bounded and its returned references confer no authority after source loss", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work", gate: { evidence: ["task-result"] } }]))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  const task = registerAgentTask(f, "bounded-task")
  for (let i = 0; i < 33; i++) task.output()
  const view = await f.call({ action: "read", runID: run.runID })
  assert.equal(view.availableEvidence.references.length, 32)
  assert.equal(view.availableEvidence.limited, true)
  const selected = view.availableEvidence.references[0]
  f.messages.set("owner", f.messages.get("owner").filter((message) => message.info.id !== selected.messageID))
  run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID,
    expectedRevision: 2, submissionID: "lost-source", report: { ...report(), evidence: [selected] } })
  assert.equal(run.decision.accepted, false)
  assert.deepEqual(run.decision.diagnostics, ["unverified:task-result"])
  assert.equal(f.creates, 0)
  assert.equal(f.prompts, 0)
})

test("reference discovery rechecks owner permission and checkpoint after source I/O", async (t) => {
  for (const change of ["permission", "checkpoint"]) await t.test(change, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work" }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    const task = registerAgentTask(f, "discovery-race")
    task.output()
    const get = f.store.get.bind(f.store)
    f.store.get = async (id) => {
      const session = await get(id)
      if (id === task.task.taskSessionID) {
        if (change === "permission") f.snapshot.agents[0].loadWorkflows = []
        else f.persisted(run.runID).revision++
      }
      return session
    }
    const writes = f.writes
    await assert.rejects(f.call({ action: "read", runID: run.runID }), change === "permission" ? /AUTHORIZATION_DENIED/ : /REVISION_CONFLICT/)
    assert.equal(f.writes, writes)
  })
})

test("user-turn epoch fences a report paused immediately before persistence", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work" }]))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  f.beforeUpdate = async () => { f.beforeUpdate = undefined; f.user() }
  await assert.rejects(f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: report() }), /NEW_USER_MESSAGE/)
  assert.equal(f.persisted(run.runID).steps.work.status, "active")
  assert.equal(f.persisted(run.runID).revision, 2)
  assert.equal(Object.keys(f.persisted(run.runID).submissions).length, 0)
})

test("recovery rejects changed boundary, deleted/mismatched provenance and inconsistent decisions/output", async (t) => {
  for (const mutation of ["boundary", "begin", "begin-parent", "report-parent", "deleted", "submission", "decision", "output"]) await t.test(mutation, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work" }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    if (["submission", "decision", "output"].includes(mutation)) run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: report({ actual: true }) })
    if (mutation === "report-parent") run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: report({ actual: true }) })
    const saved = f.persisted(run.runID)
    if (mutation === "boundary") saved.boundary = f.user()
    if (mutation === "begin") saved.steps.work.source = saved.source
    if (mutation === "begin-parent") f.messages.get("owner").find((message) => message.info.id === saved.steps.work.source.messageID).info.parentID = "other-user"
    if (mutation === "report-parent") f.messages.get("owner").find((message) => message.info.id === saved.submissions.s.source.messageID).info.parentID = "other-user"
    if (mutation === "deleted") f.messages.set("owner", f.messages.get("owner").filter((message) => message.info.id !== saved.steps.work.source.messageID))
    if (mutation === "submission") saved.submissions.s.stepID = "other"
    if (mutation === "decision") saved.submissions.s.decision = { accepted: false, diagnostics: [] }
    if (mutation === "output") saved.output = { fabricated: true }
    await assert.rejects(f.call({ action: "read", runID: run.runID }), /INVALID_CHECKPOINT/)
  })
})

test("public Workflow plugin executes three serial main-Agent steps with zero delegated Sessions", async (t) => {
  const f = fixture(t)
  const hooks = await f.hooks()
  t.after(() => hooks.dispose())
  const call = async (args, overrides = {}) => JSON.parse(await hooks.tool.o4e_workflow.execute(args, f.context(args, overrides)))
  assert.ok((await call({ action: "catalog" })).workflows.some((item) => item.name === "investigation"))
  let run = await call({ action: "start", workflow: "investigation" })
  // OpenCode adds a diff summary to the real user message after tool turns.
  // This is UserMessage metadata, not AssistantMessage.summary: true.
  const userInfo = f.messages.get("owner").find((message) => message.info.role === "user").info
  userInfo.summary = { diffs: [] }
  assert.equal(run.runSessionID, "owner")
  await assert.rejects(call({ action: "begin", runID: run.runID, stepID: "second", expectedRevision: 1 }), /STEP_NOT_READY/)
  for (const stepID of ["first", "second", "third"]) {
    run = await call({ action: "begin", runID: run.runID, stepID, expectedRevision: run.revision })
    const state = run.steps[stepID]
    assert.equal(state.status, "active")
    assert.deepEqual(run.ready, [])
    run = await call({ action: "report", runID: run.runID, stepID, attemptID: state.attemptID, expectedRevision: run.revision, submissionID: `submit-${stepID}`, report: report({ stepID }) })
    assert.equal(run.decision.accepted, true)
  }
  assert.equal(run.status, "completed")
  assert.deepEqual(run.output, { stepID: "third" })
  assert.equal(run.revision, 7)
  userInfo.summary = { title: "Changed files", body: "Host diff summary", diffs: [{ file: "example", before: "", after: "", additions: 0, deletions: 0 }] }
  assert.equal((await call({ action: "read", runID: run.runID })).status, "completed")
  assert.equal((await call({ action: "list" })).runs[0].status, "completed")
  assert.equal(f.creates, 0)
  assert.equal(f.prompts, 0)
  assert.ok(f.asks.length >= 7)
  assert.equal(f.sessions.size, 2)
  await assert.rejects(call({ action: "read", runID: run.runID }, { sessionID: "foreign" }), /OWNER_DENIED/)
  await assert.rejects(call({ resumeRunID: "old" }), /INVALID_ARGUMENTS/)
})

test("user diff summaries never bypass Workflow provenance visibility or compaction guards", async (t) => {
  for (const mutation of ["summary-marker", "summary-string", "summary-array", "missing-diffs", "bad-title", "unknown-summary-field",
    "synthetic", "ignored", "private", "compaction", "visibility", "summary-agent", "compaction-mode", "assistant-summary", "part-summary"]) {
    await t.test(mutation, async (t) => {
      const f = fixture(t)
      const run = await f.call({ action: "start", workflow: "investigation" })
      const saved = f.persisted(run.runID)
      const info = f.messages.get("owner").find((message) => message.info.id === saved.boundary).info
      info.summary = { diffs: [] }
      if (mutation === "summary-marker") info.summary = true
      if (mutation === "summary-string") info.summary = "summary"
      if (mutation === "summary-array") info.summary = []
      if (mutation === "missing-diffs") info.summary = {}
      if (mutation === "bad-title") info.summary.title = true
      if (mutation === "unknown-summary-field") info.summary.synthetic = true
      if (["synthetic", "ignored", "private", "compaction"].includes(mutation)) info[mutation] = true
      if (mutation === "visibility") info.visibility = "hidden"
      if (mutation === "summary-agent") info.agent = "summary"
      if (mutation === "compaction-mode") info.mode = "compaction"
      const source = f.messages.get("owner").find((message) => message.info.id === saved.source.messageID)
      if (mutation === "assistant-summary") source.info.summary = { diffs: [] }
      if (mutation === "part-summary") source.parts[0].summary = { diffs: [] }
      const writes = f.writes
      for (const args of [{ action: "read", runID: run.runID }, { action: "list" },
        { action: "begin", runID: run.runID, stepID: "first", expectedRevision: 1 }]) {
        await assert.rejects(f.call(args), /INVALID_CHECKPOINT/)
      }
      assert.equal(f.writes, writes)
      assert.equal(saved.revision, 1)
    })
  }
})

test("report is revision guarded, strict and idempotent across response loss/restart", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work" }]))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  const args = { action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "submit", report: report() }
  await assert.rejects(f.call({ ...args, expectedRevision: 1 }), /REVISION_CONFLICT/)
  await assert.rejects(f.call({ ...args, attemptID: "foreign" }), /ATTEMPT_MISMATCH/)
  await assert.rejects(f.call({ ...args, report: { ...report(), unexpected: true } }), /INVALID_REPORT/)
  await assert.rejects(f.call({ ...args, report: { ...report(), evidence: ["tests passed"] } }), /UNSUPPORTED_EVIDENCE/)
  f.loseResponse = true
  await assert.rejects(f.call(args), /response-lost/)
  const writes = f.writes
  const retry = await f.call(args)
  assert.equal(retry.replay, true)
  assert.equal(retry.decision.accepted, true)
  assert.equal(f.writes, writes)
  await assert.rejects(f.call({ ...args, report: report({ changed: true }) }), /SUBMISSION_CONFLICT/)
  assert.equal((await f.call({ action: "read", runID: run.runID })).status, "completed")
})

test("Gate rejection requires bounded explicit repair; failed final output never completes", async (t) => {
  const value = definition([{ id: "work", type: "work", maxRepairRounds: 1, outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean", enum: [true] } }, additionalProperties: false } }])
  const f = fixture(t, value)
  let run = await f.call({ action: "start", workflow: "investigation" })
  for (let attempt = 1; attempt <= 2; attempt++) {
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: run.revision })
    run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: run.revision, submissionID: `s-${attempt}`, report: report({ ok: false }) })
    assert.equal(run.decision.accepted, false)
    assert.equal(run.status, "running")
  }
  assert.deepEqual(run.ready, [])
  await assert.rejects(f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: run.revision }), /STEP_NOT_READY/)
  const final = fixture(t, { ...definition([{ id: "work", type: "work" }]), outputSchema: { type: "string" } })
  let invalid = await final.call({ action: "start", workflow: "investigation" })
  invalid = await final.call({ action: "begin", runID: invalid.runID, stepID: "work", expectedRevision: 1 })
  invalid = await final.call({ action: "report", runID: invalid.runID, stepID: "work", attemptID: invalid.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: report() })
  assert.equal(invalid.decision.accepted, false)
  assert.notEqual(invalid.status, "completed")
})

test("current-contract restart preserves active work; new user turn requires explicit resume, pause/stop do not cancel Tasks", async (t) => {
  const f = fixture(t)
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "first", expectedRevision: 1 })
  const attemptID = run.steps.first.attemptID
  const userID = f.user()
  const notices = await f.runtime().resumeForSession("owner", { messageID: userID })
  assert.equal(notices[0].status, "interrupted")
  run = await f.call({ action: "read", runID: run.runID })
  await assert.rejects(f.call({ action: "begin", runID: run.runID, stepID: "first", expectedRevision: run.revision }), /EXPLICIT_RESUME_REQUIRED/)
  run = await f.call({ action: "resume", runID: run.runID, expectedRevision: run.revision })
  assert.equal(run.steps.first.attemptID, attemptID)
  run = await f.call({ action: "pause", runID: run.runID, expectedRevision: run.revision })
  const other = await f.call({ action: "start", workflow: "investigation" })
  await assert.rejects(f.call({ action: "resume", runID: run.runID, expectedRevision: run.revision }), /ACTIVE_RUN_EXISTS/)
  await f.call({ action: "stop", runID: other.runID, expectedRevision: other.revision })
  run = await f.call({ action: "resume", runID: run.runID, expectedRevision: run.revision })
  run = await f.call({ action: "stop", runID: run.runID, expectedRevision: run.revision })
  assert.equal(run.status, "stopped")
  assert.equal(run.steps.first.attemptID, attemptID)
  assert.equal(f.prompts, 0)
})

test("resumed active Attempt reports preserve the report boundary across rebuilt Runtime reads", async (t) => {
  const cases = [
    { name: "accepted", value: definition([{ id: "work", type: "work" }]), makeReport: () => report({ accepted: true }), accepted: true },
    { name: "rejected", value: definition([{ id: "work", type: "work" }]), makeReport: () => ({ ...report(), status: "failed" }), accepted: false },
    { name: "evidence", value: definition([{ id: "work", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] } }]),
      makeReport: (f) => {
        const created = registerAgentTask(f, "task-resumed").created()
        return { ...report({ evidenced: true }), evidence: [{ kind: "task-created", taskID: "task-resumed", messageID: created.messageID, callID: created.callID }] }
      }, accepted: true },
  ]
  for (const item of cases) await t.test(item.name, async (t) => {
    const f = fixture(t, item.value)
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: run.revision })
    const beginBoundary = f.persisted(run.runID).steps.work.boundary
    const userID = f.user()
    const [notice] = await f.runtime().resumeForSession("owner", { messageID: userID })
    run = await f.call({ action: "resume", runID: run.runID, expectedRevision: notice.revision })
    const args = { action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID,
      expectedRevision: run.revision, submissionID: `resumed-${item.name}`, report: item.makeReport(f) }
    run = await f.call(args)
    assert.equal(run.decision.accepted, item.accepted)
    const saved = f.persisted(run.runID)
    assert.notEqual(saved.boundary, beginBoundary)
    assert.equal(saved.submissions[args.submissionID].boundary, saved.boundary)
    const rebuilt = await f.call({ action: "read", runID: run.runID }, {}, f.runtime())
    assert.equal(rebuilt.steps.work.status, item.accepted ? "passed" : "rejected")
    saved.submissions[args.submissionID].boundary = beginBoundary
    await assert.rejects(f.call({ action: "read", runID: run.runID }, {}, f.runtime()), /INVALID_CHECKPOINT/)
  })
})

test("host ask, root ownership, permission drift, definition drift, and message provenance fail closed", async (t) => {
  const f = fixture(t)
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }, { ask: undefined }), /HOST_ASK_REQUIRED/)
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }, { ask: async () => { throw new Error("host-denied") } }), /host-denied/)
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }, { messageID: "missing" }), /MESSAGE_BOUNDARY_UNVERIFIABLE/)
  f.sessions.get("owner").parentID = "foreign"
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }), /OWNER_DENIED/)
  delete f.sessions.get("owner").parentID
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }, { ask: async () => { f.snapshot.agents[0].permission.o4e_workflow = "deny" } }), /AUTHORIZATION_DENIED/)
  f.snapshot.agents[0].permission.o4e_workflow = "allow"
  const run = await f.call({ action: "start", workflow: "investigation" })
  f.snapshot.workflows.get("investigation").hash = "changed"
  await assert.rejects(f.call({ action: "read", runID: run.runID }), /DEFINITION_CHANGED/)
  assert.equal(f.creates, 0)
})

test("concurrent owners/revisions and persistence failure cannot create duplicate Attempts", async (t) => {
  const f = fixture(t)
  const run = await f.call({ action: "start", workflow: "investigation" })
  const args = { action: "begin", runID: run.runID, stepID: "first", expectedRevision: 1 }
  f.failWrite = true
  await assert.rejects(f.call(args), /persistence-failed/)
  assert.equal(f.persisted(run.runID).revision, 1)
  f.failWrite = false
  const results = await Promise.allSettled([f.call(args), f.call(args)])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(f.persisted(run.runID).steps.first.attempt, 1)
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }), /ACTIVE_RUN_EXISTS/)
  assert.equal(f.creates, 0)
})

test("new user message discovered without chat hook interrupts old advancement", async (t) => {
  const f = fixture(t)
  const run = await f.call({ action: "start", workflow: "investigation" })
  f.user()
  await assert.rejects(f.call({ action: "begin", runID: run.runID, stepID: "first", expectedRevision: 1 }), /EXPLICIT_RESUME_REQUIRED/)
  assert.equal(f.persisted(run.runID).status, "interrupted")
  assert.equal(f.persisted(run.runID).revision, 2)
})

test("same-timestamp user ambiguity fails closed for start, begin, report and resume", async (t) => {
  for (const action of ["start", "begin", "report", "resume"]) await t.test(action, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work" }]))
    let run
    if (action !== "start") run = await f.call({ action: "start", workflow: "investigation" })
    if (["report", "resume"].includes(action)) run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: run.revision })
    if (action === "resume") {
      const userID = f.user()
      await f.runtime().resumeForSession("owner", { messageID: userID })
      run = await f.call({ action: "read", runID: run.runID })
    }
    const args = action === "start" ? { action, workflow: "investigation" }
      : action === "begin" ? { action, runID: run.runID, stepID: "work", expectedRevision: run.revision }
      : action === "report" ? { action, runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: run.revision, submissionID: "same-time", report: report() }
      : { action, runID: run.runID, expectedRevision: run.revision }
    const context = f.context(args)
    const current = f.messages.get("owner").find((message) => message.info.id === context.messageID)
    f.messages.get("owner").push({ info: { id: `ambiguous-${action}`, sessionID: "owner", role: "user", time: { created: current.info.time.created } },
      parts: [{ id: `p-ambiguous-${action}`, type: "text", text: "new instruction" }] })
    await assert.rejects(f.runtime().handle(args, context), /MESSAGE_BOUNDARY_AMBIGUOUS/)
  })
})

test("checkpoint corruption and old definition/arguments are rejected without migration", async (t) => {
  const f = fixture(t)
  await assert.rejects(f.call({ workflow: "investigation" }), /INVALID_ARGUMENTS/)
  const run = await f.call({ action: "start", workflow: "investigation" })
  f.persisted(run.runID).definition.steps[0].description = "tampered"
  await assert.rejects(f.call({ action: "read", runID: run.runID }), /INVALID_CHECKPOINT/)
  assert.equal(f.creates, 0)
})

test("strict fact gates reject forged, foreign, stale and unsupported evidence", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work", gate: { evidence: ["command-success"] } }]))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: {
    ...report(), evidence: [{ kind: "command-success", taskID: "forged", messageID: "forged", callID: "forged" }],
  } })
  assert.equal(run.decision.accepted, false)
  assert.ok(run.decision.diagnostics.includes("unverified:command-success"))
})

test("explicit null input remains null, dependency mapping uses only accepted outputs", async (t) => {
  const f = fixture(t, { ...definition([{ id: "work", type: "work", inputSchema: { type: "null" }, outputSchema: { type: "null" } }]), inputSchema: { type: "null" }, outputSchema: { type: "null" } })
  let run = await f.call({ action: "start", workflow: "investigation", input: null })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  assert.equal(run.steps.work.input, null)
  run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s", report: report(null) })
  assert.equal(run.status, "completed")
  assert.equal(run.output, null)
})

test("command-success verifies canonical owner/source/result and rejects corruption or incomplete capture", async (t) => {
  for (const mutation of ["valid", "missing-canonical", "exit", "foreign", "command", "truncated", "log", "index", "claim", "legacy-layout", "model-output", "synthetic", "private", "ignored", "summary", "visibility", "compacted"]) await t.test(mutation, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work", gate: { evidence: ["command-success"] } }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    const taskID = `o4e_command_${"a".repeat(32)}`
    const command = "printf verified"
    const ref = f.toolPart("bash", { command }, "verified", { o4eResult: { taskID } })
    const record = { kind: "command", version: 1, revision: 3, taskID, taskSessionID: "owner", ownerSessionID: "owner", requesterAgent: "orchestrator",
      status: "completed", stopped: true, claim: "claimed", commandHash: createHash("sha256").update(command).digest("hex"),
      source: { sessionID: "owner", messageID: ref.messageID, callID: ref.callID },
      result: { status: "completed", stopped: true, output: "verified", exitCode: 0, truncated: false, logComplete: true } }
    if (mutation === "exit") record.result.exitCode = 1
    if (mutation === "foreign") record.ownerSessionID = "foreign"
    if (mutation === "command") record.commandHash = "wrong"
    if (mutation === "truncated") record.result.truncated = true
    if (mutation === "log") record.result.logComplete = false
    if (mutation === "model-output") ref.part.state.output = "tests passed"
    if (["synthetic", "private", "ignored", "summary"].includes(mutation)) ref.part[mutation] = true
    if (mutation === "visibility") ref.part.visibility = "hidden"
    if (mutation === "compacted") ref.part.state.time = { compacted: 1 }
    const commandRef = { taskSessionID: "owner", claim: record.claim,
      callKey: createHash("sha256").update(JSON.stringify([record.source.sessionID, record.source.messageID, record.source.callID])).digest("hex"), recovery: structuredClone(record) }
    // A display snapshot can neither authorize a Gate nor substitute for the
    // independently read canonical record. Deliberately disagree in valid case.
    f.sessions.get("owner").metadata.o4e.commandTasks = { version: 2, refs: { [taskID]: {
      snapshot: { ...record, status: mutation === "valid" ? "failed" : "completed" },
    } } }
    if (mutation !== "missing-canonical") f.commandSessions.set("owner", { id: "owner", metadata: {
      o4e: { commandTasks: { version: 1, refs: { [taskID]: commandRef } } },
    } })
    if (mutation === "index") commandRef.callKey = "wrong"
    if (mutation === "claim") commandRef.claim = "wrong"
    if (mutation === "legacy-layout") {
      commandRef.taskSessionID = commandRef.recovery.taskSessionID = "command-ledger"
      f.sessions.set("command-ledger", { id: "command-ledger", metadata: { o4e: { task: commandRef.recovery } } })
    }
    const discovery = await f.call({ action: "read", runID: run.runID })
    assert.equal(discovery.availableEvidence.references.length, mutation === "valid" ? 1 : 0)
    run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s",
      report: { ...report(), evidence: [{ kind: "command-success", taskID, messageID: ref.messageID, callID: ref.callID }] } })
    assert.equal(run.decision.accepted, mutation === "valid")
    if (mutation === "valid") {
      assert.equal((await f.call({ action: "read", runID: run.runID })).status, "completed")
      f.messages.set("owner", f.messages.get("owner").filter((message) => message.info.id !== ref.messageID))
      await assert.rejects(f.call({ action: "read", runID: run.runID }), /EVIDENCE_SOURCE_LOST/)
    }
  })
})

test("task-created is not task-result; result Gate requires completed output read and current referenced Parts", async (t) => {
  for (const mutation of ["valid", "created-only", "foreign", "fingerprint", "result-edited", "revision", "wrong-agent", "private", "compacted"]) await t.test(mutation, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-result"] } }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    const taskID = "o4e_task_reference"
    const envelope = { toolName: "task", depth: 1, sourceAgent: "orchestrator", targetAgent: "reviewer", parentSessionID: "owner",
      requesterPermissionPattern: "reviewer", requesterPermissionAction: "allow", requesterPermissionApproved: false,
      compiledPermission: [], permissionOverlay: {}, effect: "read", writeScopes: [], trace: { taskID, ownerSessionID: "owner" } }
    envelope.authorizationFingerprint = delegationAuthorizationFingerprintFromEnvelope({
      requesterAgent: envelope.sourceAgent, targetAgent: envelope.targetAgent, requesterPermissionPattern: envelope.requesterPermissionPattern,
      requesterPermissionAction: envelope.requesterPermissionAction, requesterPermissionApproved: false, compiledPermission: [],
      permissionOverlay: {}, effect: "read", normalizedScopes: [], trace: envelope.trace,
    })
    const task = taskMetadata({ version: 1, revision: 4, sequence: 1, taskID, kind: "agent", status: "completed", phase: "completed",
      ownerSessionID: "owner", taskSessionID: "task-ledger", childSessionID: "task-ledger", agent: "reviewer", requesterAgent: "orchestrator",
      requesterPermissionPattern: "reviewer", requesterPermissionAction: "allow", requesterPermissionApproved: false,
      authorizationFingerprint: envelope.authorizationFingerprint, effect: "read", writeScopes: [], dispatchMessageID: "dispatch", attemptSessionIDs: ["task-ledger"],
      modelCandidates: [], failedModelCandidates: [], maxRetries: 0, attemptNumber: 1, retryRound: 0, runGeneration: 0,
      createdAt: 1, updatedAt: 2, endedAt: 2, result: { sessionID: "task-ledger", messageID: "result", partIDs: ["result-text"] }, diagnostics: [] })
    f.messages.set("task-ledger", [{ info: { id: "dispatch", role: "user" }, parts: [] },
      { info: { id: "result", role: "assistant", parentID: "dispatch", finish: "stop" }, parts: [{ id: "result-text", type: "text", text: "reviewed" }] }])
    f.sessions.set("task-ledger", { id: "task-ledger", metadata: { o4e: { task, delegation: envelope } } })
    indexAgentTask(f, task, envelope)
    const created = f.toolPart("task", { subagent_type: "reviewer" }, taskID, { o4eResult: { taskID, sessionID: "task-ledger" } })
    const read = f.toolPart("o4e_task", { action: "output", taskID }, "reviewed", { o4eResult: { taskID, status: "completed", revision: task.revision, output: "reviewed", messageID: "result", partIDs: ["result-text"] } })
    if (mutation === "foreign") task.ownerSessionID = "foreign"
    if (mutation === "fingerprint") envelope.authorizationFingerprint = "forged"
    if (mutation === "result-edited") f.messages.get("task-ledger")[1].parts[0].text = "rewritten"
    if (mutation === "revision") task.revision++
    if (mutation === "wrong-agent") envelope.targetAgent = "other"
    if (mutation === "private") read.part.private = true
    if (mutation === "compacted") read.part.state.time = { compacted: 1 }
    const ref = mutation === "created-only" ? created : read
    run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID, expectedRevision: 2, submissionID: "s",
      report: { ...report(), evidence: [{ kind: mutation === "created-only" ? "task-created" : "task-result", taskID, messageID: ref.messageID, callID: ref.callID }] } })
    assert.equal(run.decision.accepted, mutation === "valid")
    if (mutation === "created-only") assert.ok(run.decision.diagnostics.includes("missing:task-result"))
  })
})

test("Agent evidence rejects damaged provenance but accepts a valid stale owner snapshot without repairing it", async (t) => {
  const mutations = {
    valid: () => {},
    stale: ({ ref }) => {
      ref.taskRevision = 1
      ref.recoveryEnvelope.task = taskMetadata({ ...ref.recoveryEnvelope.task, revision: 1, status: "queued", phase: "queued",
        updatedAt: 1, endedAt: undefined, receipt: undefined, result: undefined })
    },
    "group-version": ({ group }) => { delete group.version },
    "group-revision": ({ group }) => { delete group.revision },
    "group-sequence": ({ group }) => { delete group.nextSequence },
    "ref-kind": ({ ref }) => { delete ref.kind },
    "ref-sequence": ({ ref }) => { delete ref.sequence },
    "recovery-version": ({ ref }) => { delete ref.recoveryEnvelope.version },
    "stable-identity": ({ ref }) => { ref.sequence++; ref.recoveryEnvelope.task.sequence++ },
    "future-ref": ({ ref }) => { ref.taskRevision++ },
    "future-recovery": ({ ref }) => { ref.recoveryEnvelope.task.revision++ },
    "recovery-owner": ({ ref }) => { ref.recoveryEnvelope.task.ownerSessionID = "foreign" },
    "recovery-session": ({ ref }) => { ref.recoveryEnvelope.task.taskSessionID = "foreign" },
    "permission-missing": ({ task }) => { delete task.requesterPermissionAction },
    "approval-mismatch": ({ task }) => { task.requesterPermissionApproved = true },
    "depth-missing": ({ envelope }) => { delete envelope.depth },
    "effect-mismatch": ({ task }) => { task.effect = "unknown-write" },
    "scope-mismatch": ({ task }) => { task.writeScopes = ["unexpected"] },
    // Matching fingerprints alone do not prove valid frozen authorization.
    "denied-with-matching-hash": ({ task, envelope, ref }) => {
      task.requesterPermissionAction = envelope.requesterPermissionAction = "deny"
      envelope.authorizationFingerprint = delegationAuthorizationFingerprintFromEnvelope({
        requesterAgent: envelope.sourceAgent, targetAgent: envelope.targetAgent,
        requesterPermissionPattern: envelope.requesterPermissionPattern, requesterPermissionAction: "deny",
        requesterPermissionApproved: false, compiledPermission: envelope.compiledPermission,
        permissionOverlay: envelope.permissionOverlay, effect: envelope.effect, normalizedScopes: envelope.writeScopes, trace: envelope.trace,
      })
      task.authorizationFingerprint = envelope.authorizationFingerprint
      ref.recoveryEnvelope.delegation = structuredClone(envelope)
      ref.recoveryEnvelope.task = structuredClone(task)
    },
  }
  for (const kind of ["task-created", "task-result"]) for (const [mutation, change] of Object.entries(mutations)) await t.test(`${kind}/${mutation}`, async (t) => {
    const f = fixture(t, definition([{ id: "work", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: [kind] } }]))
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: run.revision })
    const registered = registerAgentTask(f, "task-evidence")
    const output = kind === "task-created" ? registered.created() : registered.output()
    const group = f.sessions.get("owner").metadata.o4e.backgroundTasks
    const ref = group.taskRefs[registered.task.taskID]
    change({ ...registered, group, ref })
    const snapshot = structuredClone(group)
    const canonical = structuredClone(f.sessions.get(registered.task.taskSessionID))
    run = await f.call({ action: "report", runID: run.runID, stepID: "work", attemptID: run.steps.work.attemptID,
      expectedRevision: run.revision, submissionID: "evidence-report", report: { ...report(), evidence: [
        { kind, taskID: registered.task.taskID, messageID: output.messageID, callID: output.callID },
      ] } })
    const accepted = ["valid", "stale"].includes(mutation)
    assert.equal(run.decision.accepted, accepted)
    if (!accepted) assert.ok(run.decision.diagnostics.includes(`unverified:${kind}`))
    assert.deepEqual(f.sessions.get("owner").metadata.o4e.backgroundTasks, snapshot)
    assert.deepEqual(f.sessions.get(registered.task.taskSessionID), canonical)
    assert.equal(f.creates, 0)
    assert.equal(f.prompts, 0)
    if (accepted) {
      assert.equal((await f.call({ action: "read", runID: run.runID })).status, "completed")
      delete f.sessions.get("owner").metadata.o4e.backgroundTasks.version
      await assert.rejects(f.call({ action: "read", runID: run.runID }), /EVIDENCE_SOURCE_LOST/)
      await assert.rejects(f.call({ action: "list" }), /EVIDENCE_SOURCE_LOST/)
    }
  })
})

test("cross-Step task-result binds to the accepted dependency Task identity", async (t) => {
  for (const mutation of ["valid", "wrong-task", "wrong-agent", "dependency-rejected", "tampered-reference"]) await t.test(mutation, async (t) => {
    const value = definition([
      { id: "review", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] } },
      { id: "collect", type: "work", dependsOn: ["review"], gate: { evidence: [{ kind: "task-result", taskFrom: "review" }] } },
    ])
    const f = fixture(t, value)
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "review", expectedRevision: run.revision })
    const taskA = registerAgentTask(f, "task-A")
    const createdA = taskA.created()
    const reviewReport = { ...report(), evidence: mutation === "dependency-rejected" ? []
      : [{ kind: "task-created", taskID: "task-A", messageID: createdA.messageID, callID: createdA.callID }] }
    run = await f.call({ action: "report", runID: run.runID, stepID: "review", attemptID: run.steps.review.attemptID,
      expectedRevision: run.revision, submissionID: "review-submission", report: reviewReport })
    if (mutation === "dependency-rejected") {
      assert.equal(run.decision.accepted, false)
      assert.deepEqual(run.ready, ["review"])
      return
    }
    run = await f.call({ action: "begin", runID: run.runID, stepID: "collect", expectedRevision: run.revision })
    const selected = mutation === "valid" || mutation === "tampered-reference" ? taskA : registerAgentTask(f, "task-B", mutation === "wrong-agent" ? "researcher" : "reviewer")
    const output = selected.output()
    const collectArgs = { action: "report", runID: run.runID, stepID: "collect", attemptID: run.steps.collect.attemptID,
      expectedRevision: run.revision, submissionID: "collect-submission", report: { ...report(), evidence: [
        { kind: "task-result", taskID: selected.task.taskID, messageID: output.messageID, callID: output.callID },
      ] } }
    run = await f.call(collectArgs)
    assert.equal(run.decision.accepted, mutation === "valid" || mutation === "tampered-reference")
    if (["wrong-task", "wrong-agent"].includes(mutation)) assert.ok(run.decision.diagnostics.includes("dependency-task-mismatch:review:task-result"))
    if (mutation === "tampered-reference") {
      f.persisted(run.runID).steps.review.report.evidence[0].taskID = "task-B"
      await assert.rejects(f.call({ action: "read", runID: run.runID }), /INVALID_CHECKPOINT/)
    } else if (mutation === "valid") {
      const replay = await f.call(collectArgs)
      assert.equal(replay.replay, true)
      assert.equal(replay.decision.accepted, true)
      assert.equal((await f.call({ action: "read", runID: run.runID })).status, "completed")
    }
  })
})

test("list returns only bounded navigation summaries across Run states without recovery or writes", async (t) => {
  const f = fixture(t, definition([{ id: "first", type: "work" }, { id: "second", type: "work", dependsOn: ["first"] }]))
  let completed = await f.call({ action: "start", workflow: "investigation", input: { secret: "input-body" } })
  for (const stepID of ["first", "second"]) {
    completed = await f.call({ action: "begin", runID: completed.runID, stepID, expectedRevision: completed.revision })
    completed = await f.call({ action: "report", runID: completed.runID, stepID, expectedRevision: completed.revision,
      attemptID: completed.steps[stepID].attemptID, submissionID: stepID,
      report: { ...report({ secret: "output-body" }), artifacts: ["artifact-body"], diagnostics: ["diagnostic-body"] } })
  }
  let stopped = await f.call({ action: "start", workflow: "investigation" })
  stopped = await f.call({ action: "stop", runID: stopped.runID, expectedRevision: stopped.revision })
  let paused = await f.call({ action: "start", workflow: "investigation" })
  paused = await f.call({ action: "begin", runID: paused.runID, stepID: "first", expectedRevision: paused.revision })
  paused = await f.call({ action: "pause", runID: paused.runID, expectedRevision: paused.revision })
  let running = await f.call({ action: "start", workflow: "investigation" })
  running = await f.call({ action: "begin", runID: running.runID, stepID: "first", expectedRevision: running.revision })
  running = await f.call({ action: "report", runID: running.runID, stepID: "first", expectedRevision: running.revision,
    attemptID: running.steps.first.attemptID, submissionID: "first", report: report() })
  running = await f.call({ action: "begin", runID: running.runID, stepID: "second", expectedRevision: running.revision })
  const summary = (run, passedSteps, stepID = null) => ({ runID: run.runID, workflow: "investigation", status: run.status,
    revision: run.revision, activeStep: stepID ? { stepID, attemptID: run.steps[stepID].attemptID, attempt: 1 } : null,
    passedSteps, totalSteps: 2 })
  const expected = [summary(completed, 2), summary(stopped, 0), summary(paused, 0, "first"), summary(running, 1, "second")]
  const readOnly = async (runs) => {
    const saved = structuredClone([...f.sessions])
    const writes = f.writes
    f.reads.length = 0
    f.asks.length = 0
    assert.deepEqual(await f.call({ action: "list" }, { messageID: undefined, callID: undefined }), { status: "workflow-list", runs })
    assert.deepEqual(f.asks, [{ permission: "o4e_workflow", patterns: ["investigation"], always: [], metadata: { action: "list", workflow: "investigation" } }])
    assert.deepEqual([...f.sessions], saved)
    assert.equal(f.writes, writes)
    assert.equal(f.creates, 0)
    assert.equal(f.prompts, 0)
    assert.ok(f.reads.every(([, id]) => id === "owner"))
  }
  await readOnly(expected)
  const [notice] = await f.runtime().resumeForSession("owner", { messageID: f.user() })
  expected.at(-1).status = "interrupted"
  expected.at(-1).revision = notice.revision
  await readOnly(expected)
})

test("list filters current owner and caller Agent before asking, including empty and denied selections", async (t) => {
  const f = fixture(t)
  const definitions = ["visible", "foreign-agent", "not-loaded", "blocked", "o4e-denied", "host-denied"]
    .map((name) => ({ value: { ...definition(), name }, source: name }))
  f.snapshot.workflows = compileWorkflowRegistry(definitions)
  const other = { ...f.snapshot.agents[0], name: "other", type: "primary" }
  f.snapshot.agents.push(other)
  f.snapshot.agentByName.set(other.name, other)
  const visible = []
  for (const workflow of ["visible", "visible", ...definitions.slice(1).map((entry) => entry.value.name)]) {
    const agent = workflow === "foreign-agent" ? "other" : "orchestrator"
    const run = await f.call({ action: "start", workflow }, { agent })
    await f.call({ action: "stop", runID: run.runID, expectedRevision: 1 }, { agent })
    if (workflow === "visible") visible.push(run.runID)
  }
  const agent = f.snapshot.agents[0]
  agent.loadWorkflows = definitions.map((entry) => entry.value.name).filter((name) => name !== "not-loaded")
  agent.blockWorkflows = ["blocked"]
  agent.permission.o4e_workflow = { "*": "allow", "o4e-denied": "deny" }
  f.sessions.get("owner").permission = [{ permission: "o4e_workflow", pattern: "host-denied", action: "deny" }]
  f.asks.length = 0
  f.reads.length = 0
  const result = await f.call({ action: "list" })
  assert.deepEqual(result.runs.map((run) => run.runID), visible)
  assert.deepEqual(f.asks.map((request) => request.patterns), [["visible"]])
  assert.ok(f.reads.every(([, id]) => id === "owner"))
  f.asks.length = 0
  assert.deepEqual((await f.call({ action: "list" }, { agent: "other" })).runs.map((run) => run.workflow), ["foreign-agent"])
  assert.deepEqual(f.asks.map((request) => request.patterns), [["foreign-agent"]])
  f.asks.length = 0
  agent.loadWorkflows = []
  assert.deepEqual(await f.call({ action: "list" }, { ask: undefined }), { status: "workflow-list", runs: [] })
  assert.deepEqual(await f.call({ action: "list" }, { sessionID: "foreign", ask: undefined }), { status: "workflow-list", runs: [] })
  assert.equal(f.asks.length, 0)
})

test("list isolates hidden malformed Runs while read and writes retain strict full-index validation", async (t) => {
  for (const mode of ["foreign-agent", "o4e-denied", "host-denied"]) await t.test(mode, async (t) => {
    const f = fixture(t)
    f.snapshot.workflows = compileWorkflowRegistry(["investigation", "private-workflow"].map((name) => ({ value: { ...definition(), name }, source: name })))
    const visible = await f.call({ action: "start", workflow: "investigation" })
    await f.call({ action: "stop", runID: visible.runID, expectedRevision: 1 })
    const hidden = await f.call({ action: "start", workflow: "private-workflow" })
    const saved = f.persisted(hidden.runID)
    if (mode === "foreign-agent") saved.owner.agent = "private-agent"
    if (mode === "o4e-denied") f.snapshot.agents[0].permission.o4e_workflow = { "*": "allow", "private-workflow": "deny" }
    if (mode === "host-denied") f.sessions.get("owner").permission = [{ permission: "o4e_workflow", pattern: "private-workflow", action: "deny" }]
    saved.revision = 0
    saved.owner.sessionID = "private-owner"
    saved.status = "private-invalid-status"
    saved.definition.steps = "private-invalid-definition"
    saved.source = { messageID: "private-missing", callID: "private-missing" }
    const metadata = structuredClone(f.sessions.get("owner").metadata)
    const writes = f.writes
    f.asks.length = 0
    const result = await f.call({ action: "list" })
    assert.deepEqual(result.runs.map((run) => run.runID), [visible.runID])
    assert.deepEqual(f.asks.map((request) => request.patterns), [["investigation"]])
    assert.doesNotMatch(JSON.stringify({ result, asks: f.asks }), /private-/)
    await assert.rejects(f.call({ action: "read", runID: visible.runID }), /INVALID_CHECKPOINT/)
    await assert.rejects(f.call({ action: "start", workflow: "investigation" }), /INVALID_CHECKPOINT/)
    assert.deepEqual(f.sessions.get("owner").metadata, metadata)
    assert.equal(f.writes, writes)
  })
})

test("list rejects visible Run additions during ask without asking again or retrying", async (t) => {
  for (const workflow of ["investigation", "new-workflow"]) await t.test(workflow, async (t) => {
    const f = fixture(t)
    f.snapshot.workflows = compileWorkflowRegistry(["investigation", "new-workflow"].map((name) => ({ value: { ...definition(), name }, source: name })))
    const run = await f.call({ action: "start", workflow: "investigation" })
    await f.call({ action: "stop", runID: run.runID, expectedRevision: 1 })
    const asks = []
    let writes
    let metadata
    await assert.rejects(f.call({ action: "list" }, { ask: async (request) => {
      asks.push(request)
      await f.call({ action: "start", workflow })
      writes = f.writes
      metadata = structuredClone(f.sessions.get("owner").metadata)
    } }), { message: "O4E_WORKFLOW_REVISION_CONFLICT" })
    assert.deepEqual(asks.map((request) => request.patterns), [["investigation"]])
    assert.equal(f.writes, writes)
    assert.deepEqual(f.sessions.get("owner").metadata, metadata)
  })
})

test("list rejects a visible Run appearing after an initially empty owner snapshot", async (t) => {
  const f = fixture(t)
  const get = f.store.get.bind(f.store)
  let inject = true
  let writes
  f.store.get = async (...args) => {
    const snapshot = await get(...args)
    if (inject) {
      inject = false
      await f.call({ action: "start", workflow: "investigation" })
      writes = f.writes
    }
    return snapshot
  }
  await assert.rejects(f.call({ action: "list" }, { ask: undefined }), { message: "O4E_WORKFLOW_REVISION_CONFLICT" })
  assert.equal(f.writes, writes)
  assert.deepEqual(f.asks.map((request) => request.metadata.action), ["start"])
})

test("list ignores hidden Run additions and corruption during ask and provenance reads", async (t) => {
  for (const phase of ["ask", "provenance"]) for (const visibility of ["other-agent", "denied"]) await t.test(`${phase}/${visibility}`, async (t) => {
    const f = fixture(t)
    const run = await f.call({ action: "start", workflow: "investigation" })
    await f.call({ action: "stop", runID: run.runID, expectedRevision: 1 })
    f.snapshot.agents[0].permission.o4e_workflow = { "*": "allow", "private-workflow": "deny" }
    const mutate = () => {
      const index = f.sessions.get("owner").metadata.o4e.workflowProcess
      index.runs.hidden = { owner: { agent: visibility === "other-agent" ? "other" : "orchestrator" },
        definition: { name: "private-workflow" }, revision: 0 }
      index.activeRunID = "hidden"
    }
    const overrides = phase === "ask" ? { ask: async () => mutate() } : {}
    if (phase === "provenance") {
      const messages = f.store.messages.bind(f.store)
      f.store.messages = async (...args) => { mutate(); return messages(...args) }
    }
    const writes = f.writes
    assert.deepEqual((await f.call({ action: "list" }, overrides)).runs.map((item) => item.runID), [run.runID])
    assert.equal(f.writes, writes)
  })
})

test("list rejects visible candidate removal, revision and active-binding drift during ask", async (t) => {
  for (const mutation of ["remove", "revision", "active-binding"]) await t.test(mutation, async (t) => {
    const f = fixture(t)
    const run = await f.call({ action: "start", workflow: "investigation" })
    const writes = f.writes
    let asks = 0
    await assert.rejects(f.call({ action: "list" }, { ask: async () => {
      asks++
      const index = f.sessions.get("owner").metadata.o4e.workflowProcess
      if (mutation === "remove") { delete index.runs[run.runID]; index.activeRunID = null }
      if (mutation === "revision") index.runs[run.runID].revision++
      if (mutation === "active-binding") index.activeRunID = null
    } }), { message: "O4E_WORKFLOW_REVISION_CONFLICT" })
    assert.equal(asks, 1)
    assert.equal(f.writes, writes)
  })
})

test("list still validates visible owner, index key and inactive Run bindings", async (t) => {
  for (const mutation of ["owner", "key", "inactive-binding"]) await t.test(mutation, async (t) => {
    const f = fixture(t)
    const run = await f.call({ action: "start", workflow: "investigation" })
    const index = f.sessions.get("owner").metadata.o4e.workflowProcess
    const saved = index.runs[run.runID]
    if (mutation === "owner") { saved.owner.sessionID = "foreign"; saved.runSessionID = "foreign" }
    if (mutation === "key") { index.runs.other = saved; delete index.runs[run.runID]; index.activeRunID = "other" }
    if (mutation === "inactive-binding") saved.status = "stopped"
    const writes = f.writes
    await assert.rejects(f.call({ action: "list" }), { message: "O4E_WORKFLOW_INVALID_INDEX" })
    assert.equal(f.writes, writes)
  })
})

test("list rejects non-root/unmanaged callers and unrelated arguments before any I/O", async (t) => {
  const f = fixture(t)
  for (const key of ["workflow", "runID", "input", "expectedRevision", "stepID", "attemptID", "submissionID", "report", "limit", "cursor", "sessionID"]) {
    f.reads.length = 0
    await assert.rejects(f.call({ action: "list", [key]: "not-allowed" }), /INVALID_ARGUMENTS/)
    assert.deepEqual(f.reads, [])
  }
  for (const mutate of [
    () => { f.sessions.get("owner").parentID = "foreign" },
    () => { f.sessions.get("owner").metadata = { o4e: { kind: "delegation-attempt" } } },
    () => { f.snapshot.agents[0].type = "subagent" },
    () => { f.snapshot.agentByName.delete("orchestrator") },
  ]) {
    mutate()
    await assert.rejects(f.call({ action: "list" }), /OWNER_DENIED/)
    delete f.sessions.get("owner").parentID
    f.sessions.get("owner").metadata = {}
    f.snapshot.agents[0].type = "all"
  }
  assert.equal(f.asks.length, 0)
  assert.equal(f.writes, 0)
})

test("list requires host ask and rechecks all authorized names after ask and evidence I/O", async (t) => {
  for (const mode of ["missing", "rejected", "host-ask", "load-revoked", "host-revoked", "earlier-revoked", "during-provenance"]) await t.test(mode, async (t) => {
    const f = fixture(t)
    f.snapshot.workflows = compileWorkflowRegistry(["first", "second"].map((name) => ({ value: { ...definition(), name }, source: name })))
    for (const workflow of ["first", "second"]) {
      const run = await f.call({ action: "start", workflow })
      await f.call({ action: "stop", runID: run.runID, expectedRevision: 1 })
    }
    const saved = structuredClone(f.sessions.get("owner").metadata)
    const writes = f.writes
    f.snapshot.agents[0].permission.o4e_workflow = mode === "host-ask" ? "ask" : "allow"
    f.sessions.get("owner").permission = [{ permission: "o4e_workflow", pattern: "*", action: "ask" }]
    let asks = 0
    const ask = mode === "missing" ? undefined : async () => {
      asks++
      if (mode === "rejected") throw new Error("host rejected private-name")
      if (mode === "load-revoked") f.snapshot.agents[0].loadWorkflows = []
      if (mode === "host-revoked" || mode === "earlier-revoked" && asks === 2) {
        f.sessions.get("owner").permission.push({ permission: "o4e_workflow", pattern: "first", action: "deny" })
      }
    }
    if (mode === "during-provenance") {
      const messages = f.store.messages.bind(f.store)
      f.store.messages = async (...args) => {
        f.snapshot.agents[0].permission.o4e_workflow = "deny"
        return messages(...args)
      }
    }
    if (mode === "host-ask") {
      assert.equal((await f.call({ action: "list" }, { ask })).runs.length, 2)
      assert.equal(asks, 2)
    } else await assert.rejects(f.call({ action: "list" }, { ask }),
      (error) => error.message === `O4E_WORKFLOW_${mode === "missing" ? "HOST_ASK_REQUIRED" : "AUTHORIZATION_DENIED"}`)
    assert.deepEqual(f.sessions.get("owner").metadata, saved)
    assert.equal(f.writes, writes)
  })
})

test("list fails closed without leaking malformed records, changed definitions or lost provenance", async (t) => {
  for (const mode of ["index", "checkpoint", "schema", "definition", "deleted", "compacted", "truncated", "ask-drift", "index-race", "long-name"]) await t.test(mode, async (t) => {
    const workflow = mode === "long-name" ? "a".repeat(257) : "investigation"
    const f = fixture(t, { ...definition(), name: workflow })
    // A long configured name cannot be started via public arguments; exercise a
    // current-format persisted checkpoint whose definition passes normalization.
    if (mode === "long-name") {
      const run = newProcess(f.snapshot.workflows.get(workflow), {}, { sessionID: "owner", agent: "orchestrator" }, "user", { messageID: "m", callID: "c" })
      f.sessions.get("owner").metadata.o4e = { workflowProcess: { contract: "process-v1", activeRunID: run.runID, runs: { [run.runID]: run } } }
    } else await f.call({ action: "start", workflow })
    const index = f.sessions.get("owner").metadata.o4e.workflowProcess
    const run = Object.values(index.runs)[0]
    if (mode === "index") index.activeRunID = "missing"
    if (mode === "checkpoint") run.revision = 0
    if (mode === "schema") { run.definition["private-record-content"] = true; run.definitionHash = workflowHash(run.definition) }
    if (mode === "definition") f.snapshot.workflows.get(workflow).hash = "changed"
    if (mode === "deleted") f.messages.set("owner", f.messages.get("owner").filter((message) => message.info.id !== run.source.messageID))
    if (mode === "compacted") f.messages.get("owner").find((message) => message.info.id === run.source.messageID).parts[0].state.time = { compacted: 1 }
    if (mode === "truncated") f.messages.get("owner").find((message) => message.info.id === run.source.messageID).parts[0].state.metadata = { truncated: true }
    const overrides = mode === "ask-drift" ? { ask: async () => { f.snapshot.workflows.delete(workflow) } } : {}
    if (mode === "index-race") {
      const messages = f.store.messages.bind(f.store)
      f.store.messages = async (...args) => { run.revision++; return messages(...args) }
    }
    const writes = f.writes
    await assert.rejects(f.call({ action: "list" }, overrides), (error) => /^O4E_WORKFLOW_(INVALID_INDEX|INVALID_CHECKPOINT|LIST_UNAVAILABLE|DEFINITION_CHANGED|REVISION_CONFLICT)$/.test(error.message))
    assert.equal(f.writes, writes)
  })
})

test("list validates accepted evidence read-only and never promotes lost evidence", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-result"] } }]))
  let run = await f.call({ action: "start", workflow: "investigation" })
  run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
  const task = registerAgentTask(f, "referenced-task")
  const output = task.output()
  run = await f.call({ action: "report", runID: run.runID, stepID: "work", expectedRevision: 2,
    attemptID: run.steps.work.attemptID, submissionID: "result", report: { ...report(), evidence: [
      { kind: "task-result", taskID: task.task.taskID, messageID: output.messageID, callID: output.callID },
    ] } })
  const saved = structuredClone([...f.sessions])
  f.reads.length = 0
  assert.equal((await f.call({ action: "list" })).runs[0].passedSteps, 1)
  assert.ok(f.reads.every(([, id]) => ["owner", task.task.taskSessionID].includes(id)))
  assert.deepEqual([...f.sessions], saved)
  f.messages.set(task.task.taskSessionID, [])
  await assert.rejects(f.call({ action: "list" }), /EVIDENCE_SOURCE_LOST/)
  assert.deepEqual([...f.sessions], saved)
})

test("list enforces the 32-Run owner bound and rejects oversized indexes rather than truncating", async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 32; i++) {
    const run = await f.call({ action: "start", workflow: "investigation" })
    await f.call({ action: "stop", runID: run.runID, expectedRevision: 1 })
  }
  const result = await f.call({ action: "list" })
  assert.equal(result.runs.length, 32)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 48 * 1024)
  await assert.rejects(f.call({ action: "start", workflow: "investigation" }), /OWNER_RUN_LIMIT/)
  const index = f.sessions.get("owner").metadata.o4e.workflowProcess
  const extra = structuredClone(Object.values(index.runs)[0])
  extra.runID = "extra"
  index.runs.extra = extra
  await assert.rejects(f.call({ action: "list" }), /INVALID_INDEX/)
})

test("list refuses oversized summary bytes without publishing a partial result", async (t) => {
  const f = fixture(t, definition([{ id: "work", type: "work" }]))
  for (let i = 0; i < 32; i++) {
    let run = await f.call({ action: "start", workflow: "investigation" })
    run = await f.call({ action: "begin", runID: run.runID, stepID: "work", expectedRevision: 1 })
    await f.call({ action: "pause", runID: run.runID, expectedRevision: 2 })
  }
  const index = f.sessions.get("owner").metadata.o4e.workflowProcess
  for (const [i, run] of Object.values(index.runs).entries()) {
    delete index.runs[run.runID]
    run.runID = `${i}${"界".repeat(250)}`
    run.steps.work.attemptID = "界".repeat(256)
    f.messages.get("owner").find((message) => message.info.id === run.steps.work.source.messageID).parts[0].state.input.runID = run.runID
    index.runs[run.runID] = run
  }
  const saved = structuredClone([...f.sessions])
  await assert.rejects(f.call({ action: "list" }), /OUTPUT_TOO_LARGE/)
  assert.deepEqual([...f.sessions], saved)
})

test("public plugin wires list and keeps empty, strict-argument and populated paths side-effect free", async (t) => {
  const f = fixture(t)
  const hooks = await f.hooks()
  t.after(() => hooks.dispose())
  assert.equal(hooks.tool.o4e_workflow.args.action.parse("list"), "list")
  const call = async (args) => {
    const context = f.context(args)
    await hooks["tool.execute.before"]({ tool: "o4e_workflow", ...context }, { args })
    return JSON.parse(await hooks.tool.o4e_workflow.execute(args, context))
  }
  assert.deepEqual(await call({ action: "list" }), { status: "workflow-list", runs: [] })
  for (const args of [{ action: "list", runID: "forbidden" }, { action: "list", input: undefined }, { action: "list", report: undefined }]) {
    await assert.rejects(call(args), /INVALID_ARGUMENTS/)
  }
  assert.equal(f.writes, 0)
  assert.equal(f.asks.length, 0)
  const run = await call({ action: "start", workflow: "investigation" })
  const saved = structuredClone([...f.sessions])
  f.reads.length = 0
  assert.deepEqual((await call({ action: "list" })).runs, [{ runID: run.runID, workflow: "investigation", status: "running", revision: 1,
    activeStep: null, passedSteps: 0, totalSteps: 3 }])
  assert.deepEqual([...f.sessions], saved)
  assert.ok(f.reads.every(([, id]) => id === "owner"))
  assert.equal(f.creates, 0)
  assert.equal(f.prompts, 0)
})
