import assert from "node:assert/strict"
import test from "node:test"
import { BackgroundTaskRuntime } from "../src/runtime/background-task-runtime.mjs"
import { commandControlLines, watchTaskText } from "../src/runtime/task-result-visibility.mjs"
import { createSharedBackgroundTaskScheduler } from "../src/runtime/background-task-scheduler.mjs"
import { ScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"
import { DelegationRuntime, delegationAuthorizationFingerprintFromEnvelope } from "../src/runtime/delegation-runtime.mjs"
import { TASK_INPUT_MAX_LENGTH, TASK_PENDING_INPUT_LIMIT, createTaskReceipt, createTaskReceiptID } from "../src/core/background-task-domain.mjs"
import { createOpenCodeAgentExecutionPort } from "../src/adapters/opencode/agent-execution-port.mjs"
import { projectTaskOverview } from "../src/tui/task-overview.mjs"
import { readWorkflowEvidence } from "../src/adapters/opencode/workflow-evidence.mjs"

class BackgroundClient {
  constructor() {
    this.sessions = new Map()
    this.messages = new Map()
    this.prompts = []
    this.aborts = []
    this.nextSession = 1
    this.nextMessage = 1
    this.session = {
      create: async ({ body, query }) => ({ data: this.addSession({ directory: query?.directory ?? "/workspace", ...body }) }),
      list: async ({ query } = {}) => ({
        data: [...this.sessions.values()].slice(0, query?.limit ?? this.sessions.size).map((session) => structuredClone(session)),
      }),
      get: async ({ path }) => ({ data: structuredClone(this.sessions.get(path.id)) }),
      update: async ({ path, body }) => {
        const current = this.sessions.get(path.id)
        const updated = { ...current, ...structuredClone(body) }
        this.sessions.set(path.id, updated)
        return { data: structuredClone(updated) }
      },
      children: async ({ path }) => ({ data: [...this.sessions.values()].filter((session) => session.parentID === path.id).map((session) => structuredClone(session)) }),
      status: async () => ({ data: Object.fromEntries([...this.sessions.values()].map((session) => [session.id, { type: session.status ?? "idle" }])) }),
      messages: async ({ path }) => ({ data: structuredClone(this.messages.get(path.id) ?? []) }),
      promptAsync: async ({ path, body }) => {
        this.prompts.push({ sessionID: path.id, body: structuredClone(body) })
        this.applyPromptTools(path.id, body.tools)
        this.sessions.get(path.id).status = "busy"
        return { data: undefined }
      },
      prompt: async ({ path, body }) => {
        this.applyPromptTools(path.id, body.tools)
        const messageID = `msg_${this.nextMessage++}`
        const partID = `prt_${this.nextMessage++}`
        const result = { info: { id: messageID, role: "assistant", parentID: body.messageID, finish: "stop" }, parts: [{ id: partID, type: "text", text: "completed" }] }
        this.sessions.get(path.id).status = "idle"
        this.messages.set(path.id, [result])
        return { data: result }
      },
      abort: async ({ path }) => {
        this.aborts.push(path.id)
        this.sessions.get(path.id).status = "idle"
        return { data: true }
      },
    }
  }

  applyPromptTools(sessionID, tools) {
    // OpenCode SessionPrompt.prompt replaces, rather than merges, Session.permission.
    const permission = Object.entries(tools ?? {}).map(([permission, enabled]) => ({
      permission, action: enabled ? "allow" : "deny", pattern: "*",
    }))
    if (permission.length > 0) this.sessions.get(sessionID).permission = permission
  }

  addSession(body = {}) {
    const id = body.id ?? `ses_${this.nextSession++}`
    const session = { id, directory: "/workspace", status: "idle", ...structuredClone(body) }
    this.sessions.set(id, session)
    return structuredClone(session)
  }

  complete(sessionID, parentID, text = "completed") {
    const messageID = `msg_${this.nextMessage++}`
    const partID = `prt_${this.nextMessage++}`
    const record = { info: { id: messageID, role: "assistant", parentID, finish: "stop" }, parts: [{ id: partID, type: "text", text }] }
    this.messages.set(sessionID, [record])
    this.sessions.get(sessionID).status = "idle"
    return record
  }

  fail(sessionID, parentID, message = "model failed", { retryable = false, append = false } = {}) {
    const messageID = `msg_${this.nextMessage++}`
    const record = {
      info: {
        id: messageID,
        role: "assistant",
        parentID,
        error: retryable
          ? { name: "APIError", data: { message, isRetryable: true } }
          : { name: "UnknownError", data: { message } },
      },
      parts: [],
    }
    this.messages.set(sessionID, append ? [...(this.messages.get(sessionID) ?? []), record] : [record])
    this.sessions.get(sessionID).status = "idle"
    return record
  }
}

function agent(overrides = {}) {
  return {
    type: "all",
    name: "orchestrator",
    description: "orchestrator",
    planProfile: false,
    loadTools: ["read", "task"],
    loadSkills: ["*"],
    loadAgents: ["worker"],
    loadWorkflows: [],
    loadMcp: {},
    capabilities: [],
    ...overrides,
  }
}

function makeRuntime(client, root, locks = new ScopeLockManager(), options = {}) {
  const selectedModel = Array.isArray(options.models) ? options.models[0] : undefined
  const modelID = typeof selectedModel === "string" ? selectedModel : selectedModel?.id
  if (typeof modelID === "string" && modelID.includes("/")) {
    const separator = modelID.indexOf("/")
    const parent = client.sessions.get("parent")
    if (parent) parent.model = {
      providerID: modelID.slice(0, separator),
      id: modelID.slice(separator + 1),
      ...(typeof selectedModel === "object" && selectedModel.variant ? { variant: selectedModel.variant } : {}),
    }
  }
  const requester = options.requester ?? agent()
  const worker = options.worker ?? agent({
    name: "worker",
    type: "subagent",
    description: "worker",
    // Lock fixtures need real write capabilities, not an external_directory gate.
    loadTools: ["read", "bash", "edit"],
    backgroundTasks: { maxRetries: options.maxRetries ?? options.limits?.maxRetries ?? 1 },
  })
  const agents = [requester, worker]
  const snapshot = () => ({ agents, allAgents: agents, agentByName: new Map(agents.map((entry) => [entry.name, entry])), nativeAgentStrategies: { build: "disable", plan: "disable", general: "disable", explore: "disable" }, runtime: { config: { maxDelegationDepth: options.maxDelegationDepth } } })
  const store = new OpenCodeSessionStore(client, root)
  const execution = options.execution ?? createOpenCodeAgentExecutionPort({ client, directory: root })
  const delegation = new DelegationRuntime({ client, directory: root, snapshot, store, locks, execution })
  const legacyModelCandidates = options.legacyModelCandidates
    ?? (Array.isArray(options.models) && options.models.length > 1
      ? options.models.map((value) => {
          const id = typeof value === "string" ? value : value.id
          const separator = id.indexOf("/")
          return {
            providerID: id.slice(0, separator),
            modelID: id.slice(separator + 1),
            ...(typeof value === "object" && value.variant ? { variant: value.variant } : {}),
          }
        })
      : undefined)
  // Test-only compatibility seam: historical persisted tasks may still carry a
  // multi-candidate record even though new Agent config cannot create one.
  if (Array.isArray(legacyModelCandidates) && legacyModelCandidates.length > 0) {
    const originalPrepare = delegation.prepare.bind(delegation)
    delegation.prepare = async (...args) => ({
      ...(await originalPrepare(...args)),
      modelCandidates: structuredClone(legacyModelCandidates),
    })
  }
  return {
    runtime: new BackgroundTaskRuntime({
      sessionStore: store,
      execution,
      delegation,
      locks,
      directory: root,
      monitorIntervalMs: options.monitorIntervalMs ?? 1,
      limits: options.limits,
      scheduler: options.scheduler,
      clock: options.clock,
      inspectionReader: options.inspectionReader,
      inspectionCursorResolver: options.inspectionCursorResolver,
      onTerminalReceipt: options.onTerminalReceipt,
      onTerminalReceiptConsumed: options.onTerminalReceiptConsumed,
      onTerminalReceiptConsuming: options.onTerminalReceiptConsuming,
      onTerminalReceiptConsumptionFailed: options.onTerminalReceiptConsumptionFailed,
    }),
    store,
    delegation,
  }
}

function persistedDelegationWithTaskID(delegation, taskID, ownerSessionID) {
  const updated = {
    ...structuredClone(delegation),
    taskID,
    trace: {
      ...structuredClone(delegation.trace),
      taskID,
      ownerSessionID,
    },
  }
  updated.authorizationFingerprint = delegationAuthorizationFingerprintFromEnvelope({
    requesterAgent: updated.sourceAgent,
    requesterPermissionPattern: updated.requesterPermissionPattern,
    requesterPermissionAction: updated.requesterPermissionAction,
    requesterPermissionApproved: updated.requesterPermissionApproved,
    targetAgent: updated.targetAgent,
    compiledPermission: updated.compiledPermission,
    permissionOverlay: updated.permissionOverlay,
    effect: updated.effect,
    normalizedScopes: updated.writeScopes,
    trace: updated.trace,
  })
  return updated
}

function renamePersistedTask(client, { ownerSessionID, taskSessionID, fromTaskID, toTaskID }) {
  const taskSession = client.sessions.get(taskSessionID)
  const owner = client.sessions.get(ownerSessionID)
  const currentTask = taskSession.metadata.o4e.task
  const delegation = persistedDelegationWithTaskID(taskSession.metadata.o4e.delegation, toTaskID, ownerSessionID)
  const task = {
    ...structuredClone(currentTask),
    taskID: toTaskID,
    authorizationFingerprint: delegation.authorizationFingerprint,
  }
  taskSession.metadata.o4e = {
    ...taskSession.metadata.o4e,
    task,
    delegation,
  }
  const taskRefs = owner.metadata.o4e.backgroundTasks.taskRefs
  const previousRef = taskRefs[fromTaskID]
  const recoveryEnvelope = previousRef.recoveryEnvelope
    ? {
        ...structuredClone(previousRef.recoveryEnvelope),
        task: {
          ...structuredClone(previousRef.recoveryEnvelope.task),
          taskID: toTaskID,
          authorizationFingerprint: delegation.authorizationFingerprint,
        },
        delegation: persistedDelegationWithTaskID(previousRef.recoveryEnvelope.delegation, toTaskID, ownerSessionID),
      }
    : undefined
  delete taskRefs[fromTaskID]
  taskRefs[toTaskID] = {
    ...structuredClone(previousRef),
    ...(recoveryEnvelope ? { recoveryEnvelope } : {}),
  }
}

function resetPersistedTaskToQueued(client, { ownerSessionID, taskSessionID, taskID }) {
  const taskSession = client.sessions.get(taskSessionID)
  const owner = client.sessions.get(ownerSessionID)
  const currentTask = taskSession.metadata.o4e.task
  const {
    startedAt: _startedAt,
    endedAt: _endedAt,
    result: _result,
    receipt: _receipt,
    cancellationRequestedAt: _cancellationRequestedAt,
    sideEffectWatermark: _sideEffectWatermark,
    ...taskBase
  } = currentTask
  const task = {
    ...structuredClone(taskBase),
    revision: currentTask.revision + 1,
    status: "queued",
    phase: "queued",
    attemptNumber: 0,
    activeInputs: [],
    pendingRequests: [],
    updatedAt: currentTask.updatedAt + 1,
  }
  const {
    startedAt: _delegationStartedAt,
    endedAt: _delegationEndedAt,
    cancellationRequestedAt: _delegationCancellationRequestedAt,
    ...delegationBase
  } = taskSession.metadata.o4e.delegation
  const delegation = {
    ...structuredClone(delegationBase),
    status: "queued",
  }
  taskSession.status = "idle"
  taskSession.metadata.o4e = {
    ...taskSession.metadata.o4e,
    task,
    delegation,
  }
  const ref = owner.metadata.o4e.backgroundTasks.taskRefs[taskID]
  owner.metadata.o4e.backgroundTasks.taskRefs[taskID] = {
    ...ref,
    taskRevision: task.revision,
    ...(ref.recoveryEnvelope
      ? {
          recoveryEnvelope: {
            ...structuredClone(ref.recoveryEnvelope),
            task: structuredClone(task),
            delegation: structuredClone(delegation),
          },
        }
      : {}),
  }
}

function persistPendingSteer(client, response, text = "recover steer") {
  const task = client.sessions.get(response.sessionID).metadata.o4e.task
  const revision = task.revision + 1
  const messageID = `o4e_steer_${response.taskID}_${revision}`
  task.revision = revision
  task.updatedAt += 1
  task.activeInputs = [...(task.activeInputs ?? []), {
    version: 1,
    text,
    createdAt: task.updatedAt,
    delivery: "steer",
    messageID,
    revision,
  }]
  return { messageID, revision }
}

function addUnverifiableTask(client, {
  taskID = "o4e_task_unverifiable",
  ownerSessionID = "parent",
  childSessionID = "unverifiable-child",
  status = "queued",
  phase = "queued",
  effect = "read",
  writeScopes = [],
  dispatchMessageID = "msg_unverifiable_dispatch",
} = {}) {
  const createdAt = 1
  const task = {
    version: 1,
    revision: 1,
    sequence: 1,
    taskID,
    kind: "agent",
    status,
    phase,
    ownerSessionID,
    taskSessionID: childSessionID,
    childSessionID,
    attemptSessionIDs: [childSessionID],
    agent: "worker",
    effect,
    writeScopes,
    dispatchMessageID,
    maxRetries: 1,
    attemptNumber: status === "queued" ? 0 : 1,
    retryRound: 0,
    runGeneration: 0,
    createdAt,
    queuedAt: createdAt,
    ...(status === "queued" ? {} : { startedAt: 2 }),
    updatedAt: 2,
    diagnostics: [],
  }
  task.receipt = createTaskReceipt(task)
  client.addSession({
    id: ownerSessionID,
    metadata: {
      o4e: {
        backgroundTasks: {
          version: 1,
          revision: 1,
          nextSequence: 2,
          taskRefs: {
            [taskID]: { taskSessionID: childSessionID, kind: "agent", sequence: 1, createdAt },
          },
        },
      },
    },
  })
  client.addSession({
    id: childSessionID,
    parentID: ownerSessionID,
    agent: "worker",
    permission: [],
    metadata: {
      o4e: {
        kind: "delegation-attempt",
        version: 1,
        delegation: {
          depth: 1,
          status,
          parentSessionID: ownerSessionID,
          sourceAgent: "orchestrator",
          targetAgent: "worker",
          task: "unverifiable task",
          effect,
          writeScopes,
          permissionOverlay: {},
          createdAt,
          queuedAt: createdAt,
          taskID,
          dispatchMessageID,
        },
        task,
      },
    },
  })
  return { taskID, ownerSessionID, childSessionID, dispatchMessageID }
}

async function internalTask(runtime, taskID, sessionID = "parent") {
  return runtime.status({ taskID }, { sessionID })
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function useSparseStatusMap(client) {
  client.session.status = async () => ({ data: Object.fromEntries([...client.sessions.values()]
    .filter((session) => session.status !== "idle")
    .map((session) => [session.id, { type: session.status }])) })
}

async function until(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
}

async function makeInspectionRuntime(t, options, taskCount = 1) {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, store, delegation } = makeRuntime(client, root, new ScopeLockManager(), options)
  t.after(() => {
    runtime.dispose()
    delegation.dispose()
  })
  const tasks = []
  for (let index = 0; index < taskCount; index += 1) {
    tasks.push(JSON.parse(await runtime.startAgent(
      { task: `inspection task ${index + 1}`, agent: "worker", permissionOverlay: { "*": "deny" } },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    )))
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, taskCount)
  for (const task of tasks) assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
  return { client, runtime, store, tasks }
}

function deliveredWaitingWatchMessages(watched, context) {
  const output = [`Watch · ${watched.reason}`, ...watched.tasks.map(watchTaskText)].join("\n\n")
  return [{
    info: { id: "delivered-watch", sessionID: context.sessionID, role: "assistant" },
    parts: [{ type: "tool", tool: "o4e_task", callID: "prior-watch", state: {
      status: "completed", input: { action: "watch" }, output,
      metadata: { truncated: false, o4eResult: structuredClone(watched) },
    } }],
  }, {
    info: { id: context.messageID, sessionID: context.sessionID, role: "assistant" },
    parts: [{ type: "tool", tool: "o4e_task", callID: context.callID,
      state: { status: "running", input: { action: "watch" } } }],
  }]
}

test("watch returns status only and output remains independently readable after receipt acknowledgement", async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t)
  const body = `BEGIN\n${"\n".repeat(2010)}MISSING_END`
  const final = client.complete(task.sessionID, client.prompts[0].body.messageID, body)
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const watched = JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID }, {
    sessionID: "parent", messageID: "prior-watch", callID: "watch",
  }))
  assert.equal(watched.reason, "actionable")
  assert.equal(watched.tasks[0].status, "completed")
  assert.equal(watched.tasks[0].output, undefined)
  assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }), [])
  const context = { sessionID: "parent", messageID: "current-output", callID: "output" }
  client.messages.set("parent", deliveredWaitingWatchMessages(watched, context))
  for (let index = 0; index < 2; index += 1) {
    const result = await runtime.output({ taskID: task.taskID }, context)
    assert.equal(result.output, body)
    assert.equal(result.messageID, final.info.id)
    assert.deepEqual(result.partIDs, final.parts.map((part) => part.id))
  }
})

function makePendingExecution(client, hostRequests, replies = [], { confirmationError } = {}) {
  let submitted = false
  const listPendingRequests = async ({ sessionID }) => {
    if (submitted && confirmationError) return { supported: true, requests: [], error: confirmationError }
    return {
      supported: true,
      requests: [...hostRequests.values()].filter((request) => request.sessionID === sessionID),
    }
  }
  return {
    startTurn: async ({ sessionID, messageID, agent: targetAgent, model, parts }) => {
      const result = await client.session.promptAsync({ path: { id: sessionID }, body: { messageID, agent: targetAgent, model, parts } })
      return result.data
    },
    cancelTurn: async ({ sessionID }) => {
      const result = await client.session.abort({ path: { id: sessionID } })
      return { acknowledged: result.data }
    },
    listPendingRequests,
    respondToPendingRequest: async (response) => {
      replies.push(structuredClone(response))
      hostRequests.delete(`${response.kind}:${response.requestID}`)
      submitted = true
      client.sessions.get(response.sessionID).status = "busy"
      return { acknowledged: true }
    },
    inspectTurn: async ({ sessionID, dispatchMessageID }) => {
      const status = (await client.session.status({})).data[sessionID]
      const records = (await client.session.messages({ path: { id: sessionID } })).data
      const result = records.find((entry) => entry.info?.role === "assistant" && entry.info.parentID === dispatchMessageID)
      return {
        state: status?.type === "busy" ? "running" : "idle",
        error: result?.info?.error,
        result: result?.info?.error ? undefined : result,
        pendingRequests: await listPendingRequests({ sessionID }),
      }
    },
  }
}

test("后台委派立即返回 taskID，并持久化父子关联和 dispatch messageID", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, store } = makeRuntime(client, root)

  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  assert.equal(response.status, "queued")
  assert.match(response.taskID, /^o4e_task_/)
  assert.equal(client.prompts.length, 0)

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  const child = client.sessions.get(response.sessionID)
  assert.equal(child.metadata.o4e.task.taskID, response.taskID)
  assert.equal(child.metadata.o4e.task.dispatchMessageID, client.prompts[0].body.messageID)
  assert.equal(child.metadata.o4e.delegation.depth, 1)
  assert.equal(child.metadata.o4e.delegation.toolName, "task")
  assert.equal(child.metadata.o4e.delegation.requesterPermissionPattern, "worker")
  assert.equal(child.metadata.o4e.delegation.requesterPermissionAction, "allow")
  assert.equal(child.metadata.o4e.delegation.requesterPermissionApproved, false)
  assert.deepEqual(child.metadata.o4e.delegation.trace, { taskID: response.taskID, ownerSessionID: "parent" })
  const group = (await store.get("parent")).metadata.o4e.backgroundTasks
  assert.equal(group.version, 1)
  assert.ok(group.revision > 2)
  assert.equal(group.nextSequence, 2)
  const ref = group.taskRefs[response.taskID]
  assert.deepEqual({
    taskSessionID: ref.taskSessionID,
    taskRevision: ref.taskRevision,
    kind: ref.kind,
    sequence: ref.sequence,
    createdAt: ref.createdAt,
  }, {
    taskSessionID: response.sessionID,
    taskRevision: child.metadata.o4e.task.revision,
    kind: "agent",
    sequence: 1,
    createdAt: response.createdAt,
  })
  assert.equal(ref.recoveryEnvelope.version, 1)
  assert.equal(ref.recoveryEnvelope.task.taskID, response.taskID)
  assert.equal(ref.recoveryEnvelope.task.status, "running")
  assert.deepEqual(ref.recoveryEnvelope.task, child.metadata.o4e.task)
  assert.equal(ref.recoveryEnvelope.delegation.dispatchMessageID, child.metadata.o4e.task.dispatchMessageID)
  runtime.dispose()
})

test("Workflow evidence accepts Runtime-created completed Task output without recovering or rewriting the Task", { timeout: 5000 }, async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, { monitorIntervalMs: 60_000 })
  client.complete(task.sessionID, client.prompts[0].body.messageID, "verified runtime result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const output = await runtime.output({ taskID: task.taskID }, { sessionID: "parent", agent: "orchestrator" })
  await until(() => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].recoveryEnvelope.task.revision === output.revision)
  const toolMessage = (id, created, tool, input, body, metadata) => ({
    info: { id, sessionID: "parent", role: "assistant", time: { created } },
    parts: [{ id: `part-${id}`, sessionID: "parent", messageID: id, callID: id, type: "tool", tool,
      state: { status: "completed", input, output: body, metadata } }],
  })
  client.messages.set("parent", [
    toolMessage("begin", 1, "o4e_workflow", { action: "begin" }, "begun", {}),
    toolMessage("output", 2, "o4e_task", { action: "output", taskID: task.taskID }, output.output, { o4eResult: output }),
    toolMessage("report", 3, "o4e_workflow", { action: "report" }, "", {}),
  ])
  const before = structuredClone([...client.sessions])
  const prompts = client.prompts.length
  // The evidence reader only gets read ports: no recover/start/update methods.
  const diagnostics = await readWorkflowEvidence({
    store: { get: async (id) => structuredClone(client.sessions.get(id)), messages: async (id) => structuredClone(client.messages.get(id) ?? []) },
    context: { sessionID: "parent", agent: "orchestrator", messageID: "report", callID: "report" },
    step: { execution: { mode: "task", agent: "worker" } },
    attempt: { source: { messageID: "begin", callID: "begin" } },
    evidence: [{ kind: "task-result", taskID: task.taskID, messageID: "output", callID: "output" }],
  })
  assert.deepEqual(diagnostics, [])
  assert.deepEqual([...client.sessions], before)
  assert.equal(client.prompts.length, prompts)
})

test("owner recovery projection follows running and terminal commits without synchronized child Sessions", { timeout: 5000 }, async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, { monitorIntervalMs: 60_000 })
  const canonical = () => client.sessions.get(task.sessionID).metadata.o4e.task
  const ref = () => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  const project = (extra = {}) => projectTaskOverview({
    sessionID: "parent", getSession: (id) => id === "parent" ? client.sessions.get(id) : undefined, ...extra,
  }).groups.find((group) => group.kind === "agent")
  await until(() => ref().recoveryEnvelope.task.revision === canonical().revision)
  assert.equal(project().rows[0].status, "running")
  client.complete(task.sessionID, client.prompts[0].body.messageID)
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  await until(() => ref().recoveryEnvelope.task.revision === canonical().revision)
  assert.equal(canonical().status, "completed")
  assert.deepEqual(ref().recoveryEnvelope.task, canonical())
  assert.equal(project().rows[0].status, "completed")
  assert.equal(project({ hideCompleted: true }).total, 0)
  await runtime.handle({ action: "watch", taskID: task.taskID }, { sessionID: "parent", messageID: "ack-projection" })
  await until(() => ref().recoveryEnvelope.task.revision === canonical().revision)
  assert.deepEqual(ref().recoveryEnvelope.task, canonical())
  assert.ok(ref().receipts[0].receiptAcknowledgedAt)
  assert.equal(client.prompts.length, 1)
})

test("owner publication boundary waits for slow writes on progress, completion and cancellation", { timeout: 5000 }, async (t) => {
  for (const transition of ["progress", "completion", "cancellation"]) {
    await t.test(transition, async (t) => {
      const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, { monitorIntervalMs: 60_000 })
      const canonical = () => client.sessions.get(task.sessionID).metadata.o4e.task
      const ref = () => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
      await until(() => ref().recoveryEnvelope.task.revision === canonical().revision)
      if (transition === "cancellation") await runtime.cancel({ taskID: task.taskID }, { sessionID: "parent" })
      const targetStatus = { progress: "retrying", completion: "completed", cancellation: "cancelled" }[transition]
      const entered = deferred()
      const release = deferred()
      t.after(() => release.resolve())
      const update = client.session.update
      client.session.update = async (request) => {
        if (request.path.id === "parent" && request.body.metadata.o4e.backgroundTasks.taskRefs[task.taskID].recoveryEnvelope.task.status === targetStatus) {
          entered.resolve()
          await release.promise
        }
        return update(request)
      }
      if (transition === "completion") client.complete(task.sessionID, client.prompts[0].body.messageID)
      let returned = false
      const observing = runtime.observeEvent(transition === "progress"
        ? { kind: "session-status", sessionID: task.sessionID, status: { type: "retry" } }
        : { kind: "session-idle", sessionID: task.sessionID }).then((value) => { returned = true; return value })
      await entered.promise
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(canonical().status, targetStatus, "canonical commit precedes owner publication")
      const returnedBeforePublication = returned
      let newerObservation
      if (transition === "progress") {
        const blockedRevision = canonical().revision
        newerObservation = runtime.observeEvent({ kind: "session-status", sessionID: task.sessionID, status: { type: "busy" } })
        await until(() => canonical().revision > blockedRevision)
        assert.equal(canonical().status, "running", "owner publication wait must not hold the Task transition queue")
      }
      release.resolve()
      await observing
      await newerObservation
      assert.equal(returnedBeforePublication, false, "operation must not return before its owner publication attempt settles")
      assert.deepEqual(ref().recoveryEnvelope.task, canonical())
      if (transition === "cancellation") assert.equal(ref().cancellationRequestedAt, canonical().cancellationRequestedAt)
      assert.equal(client.prompts.length, 1)
    })
  }
})

test("owner projection write failure leaves canonical completion committed and addressed restart repairs stale current index", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, process.cwd(), new ScopeLockManager(), { monitorIntervalMs: 60_000 })
  t.after(() => { runtime.dispose(); delegation.dispose() })
  const task = JSON.parse(await runtime.startAgent(
    { task: "stale queued projection", agent: "worker", permissionOverlay: { "*": "deny" } },
    { sessionID: "parent", agent: "orchestrator", directory: process.cwd() },
  ))
  const canonical = () => client.sessions.get(task.sessionID).metadata.o4e.task
  const ref = () => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  const queuedEnvelope = structuredClone(ref().recoveryEnvelope)
  assert.equal(queuedEnvelope.task.status, "queued")
  assert.equal(queuedEnvelope.task.revision, 1)
  await until(() => canonical().status === "running")
  const update = client.session.update
  const savedRevision = ref().recoveryEnvelope.task.revision
  let rejected = 0
  client.session.update = async (request) => {
    if (request.path.id === "parent" && request.body.metadata.o4e.backgroundTasks.taskRefs[task.taskID].recoveryEnvelope.task.revision > savedRevision) {
      rejected += 1
      throw new Error("owner projection unavailable")
    }
    return update(request)
  }
  client.complete(task.sessionID, client.prompts[0].body.messageID)
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const status = await runtime.status({ taskID: task.taskID }, { sessionID: "parent" })
  assert.ok(status.diagnostics.some((entry) => entry.code === "owner-publication-failed"), "publication failure must be observable without changing canonical completion")
  assert.equal(canonical().diagnostics.some((entry) => entry.code === "owner-publication-failed"), false)
  await runtime.flush()
  assert.equal(canonical().status, "completed")
  assert.ok(rejected > 0)
  assert.ok(ref().recoveryEnvelope.task.revision < canonical().revision)
  runtime.dispose()
  client.session.update = update
  const completed = structuredClone(canonical())
  // Existing current-format indexes can have a fresh receipt taskRevision but
  // the initial queued recoveryEnvelope: repair that exact split snapshot.
  ref().recoveryEnvelope = queuedEnvelope
  ref().taskRevision = completed.revision
  client.session.list = async () => { throw new Error("must not scan all Sessions") }
  const restarted = makeRuntime(client, process.cwd(), new ScopeLockManager(), { monitorIntervalMs: 60_000 })
  t.after(() => { restarted.runtime.dispose(); restarted.delegation.dispose() })
  await restarted.runtime.recoverSession("parent", { dispatch: false })
  assert.deepEqual(ref().recoveryEnvelope.task, completed)
  assert.deepEqual(canonical(), completed, "repair does not mutate the canonical ledger")
  assert.equal(client.prompts.length, 1, "repair must not redispatch completed work")
})

test("owner publication failure after accepted input is diagnostic and repair does not replay input", { timeout: 5000 }, async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, { monitorIntervalMs: 60_000 })
  const canonical = () => client.sessions.get(task.sessionID).metadata.o4e.task
  const ref = () => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  await until(() => ref().recoveryEnvelope.task.revision === canonical().revision)
  const revision = canonical().revision
  const update = client.session.update
  client.session.update = async (request) => {
    if (request.path.id === "parent" && request.body.metadata.o4e.backgroundTasks.taskRefs[task.taskID].recoveryEnvelope.task.revision > revision) {
      throw new Error("private transport detail must not be exposed")
    }
    return update(request)
  }
  const result = await runtime.input({ taskID: task.taskID, expectedRevision: revision, input: "next instruction" }, { sessionID: "parent" })
  assert.equal(result.revision, revision + 1)
  assert.equal(result.diagnostics.filter((entry) => entry.code === "owner-publication-failed").length, 1)
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /private transport detail/)
  assert.equal(canonical().pendingInputs.length, 1)
  assert.equal(canonical().pendingInputs[0].text, "next instruction")
  for (const entries of [
    await runtime.taskGroup({ sessionID: "parent" }),
    (await runtime.pending({ taskID: task.taskID }, { sessionID: "parent" })).tasks,
  ]) {
    assert.equal(entries.find((entry) => entry.taskID === task.taskID).diagnostics.filter((entry) => entry.code === "owner-publication-failed").length, 1)
  }
  const accepted = structuredClone(canonical())
  client.session.update = update
  client.session.list = async () => { throw new Error("must not scan all Sessions") }
  await runtime.recoverSession("parent", { dispatch: false })
  assert.deepEqual(canonical(), accepted)
  assert.deepEqual(ref().recoveryEnvelope.task, accepted)
  assert.equal((await runtime.status({ taskID: task.taskID }, { sessionID: "parent" })).diagnostics.some((entry) => entry.code === "owner-publication-failed"), false)
  assert.equal(client.prompts.length, 1)
})

test("late owner recovery publication preserves newer revision and acknowledged receipt", { timeout: 5000 }, async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, { monitorIntervalMs: 60_000 })
  client.complete(task.sessionID, client.prompts[0].body.messageID)
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  await runtime.flush()
  runtime.resume({ dispatch: false })
  const get = client.session.get
  const entered = deferred()
  const release = deferred()
  let held = false
  client.session.get = async (request) => {
    const result = await get(request)
    if (!held && request.path.id === task.sessionID) {
      held = true
      entered.resolve()
      await release.promise
    }
    return result
  }
  const restarted = makeRuntime(client, process.cwd(), new ScopeLockManager(), { monitorIntervalMs: 60_000 })
  t.after(() => { release.resolve(); restarted.runtime.dispose(); restarted.delegation.dispose() })
  const recovering = restarted.runtime.recoverSession("parent", { dispatch: false })
  await entered.promise
  await runtime.handle({ action: "watch", taskID: task.taskID }, { sessionID: "parent", messageID: "newer-ack" })
  await runtime.flush()
  const ref = () => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  const acknowledged = structuredClone(ref())
  assert.ok(acknowledged.receipts[0].receiptAcknowledgedAt)
  release.resolve()
  await recovering
  await restarted.runtime.flush()
  assert.deepEqual(ref(), acknowledged)
  assert.equal(ref().recoveryEnvelope.task.revision, client.sessions.get(task.sessionID).metadata.o4e.task.revision)
  assert.equal(client.prompts.length, 1)
})

test("maxDelegationDepth=1 leaf 保留完整冻结权限并正常结算", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
    maxDelegationDepth: 1,
    worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "task", "o4e_task"], loadAgents: ["worker"] }),
  })
  t.after(() => { runtime.dispose(); delegation.dispose() })
  const task = JSON.parse(await runtime.startAgent(
    { task: "leaf work", agent: "worker", depth: 0, maxDelegationDepth: 5 },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const child = client.sessions.get(task.sessionID)
  assert.deepEqual(child.permission, child.metadata.o4e.delegation.compiledPermission)
  assert.equal(child.metadata.o4e.delegation.depth, 1)
  assert.equal(child.metadata.o4e.delegation.maxDelegationDepth, 1)
  assert.equal(child.metadata.o4e.delegation.remainingDelegationDepth, 0)
  assert.equal(child.permission.findLast((rule) => rule.permission === "task" && rule.pattern === "*")?.action, "deny")
  assert.equal(client.prompts[0].body.tools, undefined)
  assert.match(client.prompts[0].body.parts[0].text, /currentDepth: 1/)
  assert.match(client.prompts[0].body.parts[0].text, /maxDelegationDepth: 1/)
  assert.match(client.prompts[0].body.parts[0].text, /remainingDelegationDepth: 0/)
  assert.match(client.prompts[0].body.parts[0].text, /sourceAgent: orchestrator/)
  assert.match(client.prompts[0].body.parts[0].text, /targetAgent: worker/)
  assert.match(client.prompts[0].body.parts[0].text, /leaf delegation layer/)
  await assert.rejects(
    runtime.startAgent({ task: "forged deeper work", agent: "worker", depth: 0, maxDelegationDepth: 5 },
      { sessionID: task.sessionID, agent: "worker", directory: root }),
    { code: "O4E_DELEGATION_DEPTH_LIMIT", depth: 2, maxDelegationDepth: 1 },
  )
  client.complete(task.sessionID, client.prompts[0].body.messageID, "leaf result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  assert.equal((await runtime.status({ taskID: task.taskID }, { sessionID: "parent" })).status, "completed")
})

test("同进程多 Runtime hydration 不把 promptAsync 受理前后窗口误写为 execution-interrupted", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const submitted = deferred()
  const accepted = deferred()
  client.session.promptAsync = async ({ path, body }) => {
    client.prompts.push({ sessionID: path.id, body: structuredClone(body) })
    submitted.resolve()
    await accepted.promise
    return { data: undefined }
  }
  const status = client.session.status
  client.session.status = async () => {
    const result = await status()
    const values = { ...result.data }
    for (const session of client.sessions.values()) {
      if (session.parentID === "parent") delete values[session.id]
    }
    return { data: values }
  }
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    scheduler: createSharedBackgroundTaskScheduler(root, { maxConcurrentAgents: 4 }),
  })
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    scheduler: createSharedBackgroundTaskScheduler(root, { maxConcurrentAgents: 4 }),
  })
  const third = makeRuntime(client, root, new ScopeLockManager(), {
    scheduler: createSharedBackgroundTaskScheduler(root, { maxConcurrentAgents: 4 }),
  })
  t.after(() => {
    first.runtime.dispose()
    first.delegation.dispose()
    second.runtime.dispose()
    second.delegation.dispose()
    third.runtime.dispose()
    third.delegation.dispose()
  })

  const created = JSON.parse(await first.runtime.startAgent(
    { task: "activation race", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await submitted.promise

  await second.runtime.recoverSession(created.sessionID, { dispatch: false })
  assert.equal((await internalTask(second.runtime, created.taskID)).phase, "starting")

  accepted.resolve()
  await until(() => client.sessions.get(created.sessionID).metadata.o4e.task.phase === "model-running")
  const hydrated = await third.runtime.taskGroup({ sessionID: "parent" })
  assert.equal(hydrated.find((task) => task.taskID === created.taskID)?.phase, "model-running")
  assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.diagnostics.length, 0)

  client.sessions.get(created.sessionID).status = "busy"
  await third.runtime.observeEvent({ kind: "session-status", sessionID: created.sessionID, status: { type: "busy" } })
  assert.equal((await internalTask(third.runtime, created.taskID)).status, "running")
  client.session.status = status
  await second.runtime.recoverSession("parent", { dispatch: false })
  const afterBusyHydration = await internalTask(second.runtime, created.taskID)
  assert.equal(afterBusyHydration.status, "running")
  assert.equal(afterBusyHydration.phase, "model-running")
  const result = client.complete(created.sessionID, client.prompts[0].body.messageID, "activated result")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: created.sessionID })
  const completed = await internalTask(second.runtime, created.taskID)
  assert.equal(completed.status, "completed")
  assert.equal(completed.result.messageID, result.info.id)
  assert.equal(completed.diagnostics.some((entry) => entry.code === "execution-interrupted"), false)
})

test("同进程 live Attempt 看到 busy 后仍把后续无结果 idle 判为真中断", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    scheduler: createSharedBackgroundTaskScheduler(root, { maxConcurrentAgents: 4 }),
  })
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    scheduler: createSharedBackgroundTaskScheduler(root, { maxConcurrentAgents: 4 }),
  })
  t.after(() => {
    first.runtime.dispose()
    first.delegation.dispose()
    second.runtime.dispose()
    second.delegation.dispose()
  })
  const created = JSON.parse(await first.runtime.startAgent(
    { task: "real interruption", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await until(() => client.sessions.get(created.sessionID).metadata.o4e.task.phase === "model-running")
  await first.runtime.observeEvent({ kind: "session-status", sessionID: created.sessionID, status: { type: "busy" } })
  client.sessions.get(created.sessionID).status = "idle"
  await second.runtime.recoverSession("parent", { dispatch: false })
  const interrupted = await internalTask(second.runtime, created.taskID)
  assert.equal(interrupted.status, "waiting_retry_decision")
  assert.equal(interrupted.phase, "execution-interrupted")
})

test("全部 Runtime 释放后的真正恢复不继承进程内 live ownership", { timeout: 5000 }, async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const status = client.session.status
  client.session.status = async () => {
    const result = await status()
    const values = { ...result.data }
    for (const session of client.sessions.values()) {
      if (session.parentID === "parent") delete values[session.id]
    }
    return { data: values }
  }
  const first = makeRuntime(client, root)
  const created = JSON.parse(await first.runtime.startAgent(
    { task: "restart recovery", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await until(() => client.sessions.get(created.sessionID).metadata.o4e.task.phase === "model-running")
  first.runtime.dispose()
  first.delegation.dispose()

  const restarted = makeRuntime(client, root)
  await restarted.runtime.recoverSession("parent", { dispatch: false })
  const interrupted = await internalTask(restarted.runtime, created.taskID)
  assert.equal(interrupted.status, "waiting_retry_decision")
  assert.equal(interrupted.phase, "execution-interrupted")
  restarted.runtime.dispose()
  restarted.delegation.dispose()
})

test("flush 停止新建 Task 并等待在途 dispatch 稳定", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let releaseTurn
  let turnStarted = false
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: {
      startTurn: async () => {
        turnStarted = true
        await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      },
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async () => ({ state: "running" }),
    },
  })
  await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  let flushed = false
  const flushing = runtime.flush().then(() => { flushed = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(flushed, false)
  await assert.rejects(
    runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }),
    /正在释放/,
  )
  releaseTurn()
  await flushing
  assert.equal(flushed, true)
  runtime.dispose()
})

test("flush 在后台创建 prepare 阶段关闭 admission 且不创建子 Session", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root)
  const originalPrepare = delegation.prepare.bind(delegation)
  let prepareStarted = false
  let releasePrepare
  delegation.prepare = async (...args) => {
    const prepared = await originalPrepare(...args)
    prepareStarted = true
    await new Promise((resolvePromise) => { releasePrepare = resolvePromise })
    return prepared
  }
  const starting = runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  while (!prepareStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const flushing = runtime.flush()
  releasePrepare()

  await assert.rejects(starting, /正在释放/)
  await flushing
  assert.equal([...client.sessions.values()].some((session) => session.parentID === "parent"), false)
  assert.equal(client.prompts.length, 0)
  assert.equal(client.sessions.get("parent").metadata?.o4e?.backgroundTasks, undefined)
  runtime.dispose()
  delegation.dispose()
})

test("flush 跨越 createAttempt 时将已创建 Task 持久化为 cancelled", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const originalCreate = client.session.create
  let childCreated
  let releaseCreate
  client.session.create = async (request) => {
    const result = await originalCreate(request)
    if (request.body?.metadata?.o4e?.kind === "delegation-attempt") {
      childCreated = result.data.id
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise })
    }
    return result
  }
  const first = makeRuntime(client, root)
  const starting = first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  while (!childCreated) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const flushing = first.runtime.flush()
  releaseCreate()

  await assert.rejects(starting, /正在释放/)
  await flushing
  assert.equal(client.prompts.length, 0)
  const child = client.sessions.get(childCreated)
  assert.equal(child.metadata.o4e.task.status, "cancelled")
  assert.equal(child.metadata.o4e.task.phase, "runtime-disposed-before-dispatch")
  assert.equal(child.metadata.o4e.delegation.status, "cancelled")
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[child.metadata.o4e.task.taskID]
  assert.equal(ref.taskSessionID, childCreated)
  assert.equal(ref.taskRevision, child.metadata.o4e.task.revision)
  first.runtime.dispose()
  first.delegation.dispose()

  client.session.create = originalCreate
  const second = makeRuntime(client, root)
  await second.runtime.activateSession("parent")
  assert.equal(client.prompts.length, 0)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("dispatch owner Session 重验等待期间遵守取消、释放和恢复暂停", { timeout: 5000 }, async () => {
  for (const boundary of ["cancel", "flush", "recover", "recover-fail", "recover-fail-early"]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const locks = new ScopeLockManager()
    const { runtime, delegation } = makeRuntime(client, root, locks)
    const get = client.session.get
    let release
    let entered
    let held = false
    const reading = new Promise((resolvePromise) => { entered = resolvePromise })
    const resumed = new Promise((resolvePromise) => { release = resolvePromise })
    let holdRecovery = false
    let enterRecovery
    let releaseRecovery
    const recoveryReading = new Promise((resolvePromise) => { enterRecovery = resolvePromise })
    const recoveryResumed = new Promise((resolvePromise) => { releaseRecovery = resolvePromise })
    client.session.get = async (request) => {
      const queued = [...client.sessions.values()].find((session) => session.metadata?.o4e?.task?.status === "queued")
      if (!held && request.path.id === "parent" && queued && locks.has(`background-task:${queued.metadata.o4e.task.taskID}`)) {
        held = true
        entered()
        await resumed
      } else if (holdRecovery && request.path.id === "parent") {
        holdRecovery = false
        enterRecovery()
        await recoveryResumed
      }
      return get(request)
    }
    try {
      const created = JSON.parse(await runtime.startAgent({ task: "await current owner authority", agent: "worker" },
        { sessionID: "parent", agent: "orchestrator", directory: root }))
      await reading
      assert.equal(client.prompts.length, 0)
      if (boundary.startsWith("recover")) {
        holdRecovery = true
        const restoring = runtime.recoverSession("parent", { dispatch: false, session: structuredClone(client.sessions.get("parent")) })
        await recoveryReading
        if (boundary.startsWith("recover-fail")) client.sessions.get("parent").metadata.o4e.backgroundTasks.version = 999
        if (boundary !== "recover-fail-early") release()
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        assert.equal(client.prompts.length, 0, "in-flight revalidation must respect the recovery pause")
        releaseRecovery()
        if (boundary.startsWith("recover-fail")) {
          await assert.rejects(restoring, /version|版本/)
          release()
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
          assert.equal(client.prompts.length, 0, "failed recovery must not resume deferred dispatch")
          assert.equal(locks.has(`background-task:${created.taskID}`), true)
          client.addSession({ id: "unrelated", metadata: {} })
          await runtime.recoverSession("unrelated", { dispatch: false })
          assert.equal(client.prompts.length, 0, "another owner's successful recovery must not resume failed-owner work")
          client.sessions.get("parent").metadata.o4e.backgroundTasks.version = 1
          await runtime.recoverSession("parent", { dispatch: false })
          assert.equal(client.prompts.length, 0, "failed work waits for explicit activation")
          await runtime.activateSession("parent")
          const deadline = Date.now() + 500
          while (client.prompts.length === 0 && Date.now() < deadline) await new Promise((resolvePromise) => setImmediate(resolvePromise))
          assert.equal(client.prompts.length, 1)
          continue
        }
        await restoring
        const deadline = Date.now() + 500
        while (client.prompts.length === 0 && Date.now() < deadline) await new Promise((resolvePromise) => setImmediate(resolvePromise))
        assert.equal(client.prompts.length, 1, "resuming dispatch must retain the deferred task")
      } else {
        const stopping = boundary === "flush" ? runtime.flush() : runtime.cancel({ taskID: created.taskID }, { sessionID: "parent" })
        if (boundary === "cancel") {
          while (!client.sessions.get(created.sessionID).metadata.o4e.task.cancellationRequestedAt) {
            await new Promise((resolvePromise) => setImmediate(resolvePromise))
          }
        }
        release()
        await stopping
        await runtime.flush()
        assert.equal(client.prompts.length, 0)
        assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.attemptNumber, 0)
      }
    } finally {
      release()
      releaseRecovery()
      runtime.dispose()
      delegation.dispose()
    }
  }
})

test("dispatch claim 写入期间恢复失败保留 unknown 锁，不提交宿主执行", { timeout: 5000 }, async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime, delegation } = makeRuntime(client, root, locks)
  const update = client.session.update
  let release
  let entered
  let held = false
  const writing = new Promise((resolvePromise) => { entered = resolvePromise })
  const resumed = new Promise((resolvePromise) => { release = resolvePromise })
  client.session.update = async (request) => {
    const result = await update(request)
    if (!held && request.body.metadata?.o4e?.task?.status === "starting") {
      held = true
      entered()
      await resumed
    }
    return result
  }
  try {
    const created = JSON.parse(await runtime.startAgent({ task: "persist claim", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root }))
    await writing
    client.sessions.get("parent").metadata.o4e.backgroundTasks.version = 999
    await assert.rejects(runtime.recoverSession("parent", { dispatch: false }), /version|版本/)
    release()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    client.sessions.get("parent").metadata.o4e.backgroundTasks.version = 1
    await runtime.activateSession("parent")
    const state = JSON.parse(await runtime.handle({ action: "status", taskID: created.taskID }, { sessionID: "parent" }))
    assert.equal(state.status, "unknown")
    assert.equal(state.phase, "dispatch-unconfirmed")
    assert.equal(state.attemptNumber, 1)
    assert.equal(client.prompts.length, 0)
    assert.equal(locks.has(`background-task:${created.taskID}`), true)
  } finally {
    release()
    runtime.dispose()
    delegation.dispose()
  }
})

test("Session 定向恢复只加载当前父 Session，不可验证 Task 默认不派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const firstUnverifiable = addUnverifiableTask(client, {
    taskID: "o4e_task_parent_a",
    ownerSessionID: "parent-a",
    childSessionID: "child-a",
    dispatchMessageID: "msg_parent_a",
  })
  addUnverifiableTask(client, {
    taskID: "o4e_task_parent_b",
    ownerSessionID: "parent-b",
    childSessionID: "child-b",
    dispatchMessageID: "msg_parent_b",
  })
  let listCalls = 0
  client.session.list = async () => {
    listCalls += 1
    throw new Error("项目级 Session 枚举不应被调用")
  }
  const { runtime, delegation } = makeRuntime(client, root)

  const recovered = await runtime.recoverSession("parent-a", { dispatch: false })
  assert.equal(recovered.ownerSessionID, "parent-a")
  assert.equal(listCalls, 0)
  assert.equal(client.prompts.length, 0)
  assert.equal((await runtime.status({ taskID: firstUnverifiable.taskID }, { sessionID: "parent-a" })).ownerSessionID, "parent-a")
  await assert.rejects(runtime.status({ taskID: "o4e_task_parent_b" }, { sessionID: "parent-a" }), /未找到 Task|无权读取 Task/)

  runtime.dispose()
  delegation.dispose()
})

test("已持久化 Task 只有父 Session 显式激活后恢复派发，模型保持冻结值", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  await locks.acquire("holder", { kind: "unknown-write" })
  const first = makeRuntime(client, root, locks, {
    models: ["frozen-provider/frozen-model"],
  })
  const queued = JSON.parse(await first.runtime.startAgent(
    { task: "frozen model", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 0)
  first.runtime.dispose()
  first.delegation.dispose()
  locks.clear()

  const second = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["current-provider/current-model"],
  })

  await second.runtime.recoverSession("parent", { dispatch: false })
  assert.equal(client.prompts.length, 0)
  await second.runtime.handle({ action: "status", taskID: queued.taskID }, { sessionID: "parent" })
  assert.equal(client.prompts.length, 0)

  await second.runtime.activateSession("parent")
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(client.prompts[0].body.model, { providerID: "frozen-provider", modelID: "frozen-model" })

  second.runtime.dispose()
  second.delegation.dispose()
})

test("createAttempt 响应丢失后在同一 Runtime 对账唯一子 Session", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const originalCreate = client.session.create
  let lost = true
  client.session.create = async (request) => {
    if (request.body?.metadata?.o4e?.kind === "delegation-attempt" && lost) {
      lost = false
      await originalCreate(request)
      throw new Error("createAttempt response lost")
    }
    return originalCreate(request)
  }
  const { runtime, delegation } = makeRuntime(client, root)

  const response = JSON.parse(await runtime.startAgent(
    { task: "inspect", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))

  const attempts = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.kind === "delegation-attempt")
  assert.equal(attempts.length, 1)
  assert.equal(response.sessionID, attempts[0].id)
  assert.equal(attempts[0].metadata.o4e.task.taskID, response.taskID)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, response.sessionID)
  assert.equal(client.prompts.length, 1)
  assert.equal(client.prompts[0].sessionID, response.sessionID)
  runtime.dispose()
  delegation.dispose()
})

test("createAttempt 响应丢失后拒绝复用授权上下文不完整的子 Session", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const originalCreate = client.session.create
  let lost = true
  client.session.create = async (request) => {
    if (request.body?.metadata?.o4e?.kind === "delegation-attempt" && lost) {
      lost = false
      const created = await originalCreate(request)
      delete client.sessions.get(created.data.id).metadata.o4e.delegation.requesterPermissionPattern
      throw new Error("createAttempt response lost")
    }
    return originalCreate(request)
  }
  const { runtime, delegation } = makeRuntime(client, root)

  await assert.rejects(runtime.startAgent(
    { task: "inspect", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ), /Attempt 创建结果授权上下文不匹配/)
  assert.equal(client.prompts.length, 0)
  runtime.dispose()
  delegation.dispose()
})

test("flush 中止等待 Scope Lock 的后台 dispatch", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent-a", metadata: {} })
  client.addSession({ id: "parent-b", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime, delegation } = makeRuntime(client, root, locks)
  await runtime.startAgent({ task: "first write", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-a", agent: "orchestrator", directory: root })
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.startAgent({ task: "second write", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-b", agent: "orchestrator", directory: root })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await Promise.race([
    runtime.flush(),
    new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("flush deadlocked")), 100)),
  ])
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
  delegation.dispose()
})

test("flush 等待 Background 状态写结算并传播持久化失败", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const originalUpdate = client.session.update
  let releaseUpdate
  let updateStarted = false
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.task?.sideEffectWatermark) {
      updateStarted = true
      await new Promise((resolvePromise) => { releaseUpdate = resolvePromise })
      throw new Error("background metadata unavailable")
    }
    return originalUpdate(request)
  }
  const marking = runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  while (!updateStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  let flushSettled = false
  const flushing = runtime.flush().then(
    () => { flushSettled = true },
    (error) => { flushSettled = true; throw error },
  )
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(flushSettled, false)
  releaseUpdate()
  await assert.rejects(marking, /background metadata unavailable/)
  await assert.rejects(flushing, /background metadata unavailable/)

  client.session.update = originalUpdate
  runtime.resume()
  runtime.dispose()
  delegation.dispose()
})

test("flush 失败后 resume 的 queued Task 完成时释放 admission 槽", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const originalPromptAsync = client.session.promptAsync
  let releaseFirst
  let firstStarted = false
  client.session.promptAsync = async (request) => {
    const result = originalPromptAsync(request)
    if (!firstStarted) {
      firstStarted = true
      await new Promise((resolvePromise) => { releaseFirst = resolvePromise })
    }
    return result
  }
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
    monitorIntervalMs: 1000,
  })
  const first = JSON.parse(await runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (!firstStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = JSON.parse(await runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))

  const flushing = runtime.flush()
  releaseFirst()
  await flushing
  runtime.resume()
  assert.equal(client.prompts.length, 1)

  client.complete(first.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[1].sessionID, second.sessionID)

  client.complete(second.sessionID, client.prompts[1].body.messageID, "second result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: second.sessionID })
  const third = JSON.parse(await runtime.startAgent({ task: "third", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 3) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[2].sessionID, third.sessionID)

  runtime.dispose()
  delegation.dispose()
})

test("flush 后 resume 将历史 fallback pending 转为显式决策并为 retry pending 重建 Scope abort signal", async () => {
  const root = process.cwd()
  for (const { phase, decision, models } of [
    { phase: "model-fallback-pending", models: ["provider/primary", "provider/fallback"] },
    { phase: "retry-continue-pending", decision: "continue", models: ["provider/primary"] },
    { phase: "retry-restart-pending", decision: "restart", models: ["provider/primary"] },
  ]) {
    const client = new BackgroundClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const first = makeRuntime(client, root, new ScopeLockManager(), { models })
    const response = JSON.parse(await first.runtime.startAgent(
      { task: phase, agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    const task = client.sessions.get(response.sessionID).metadata.o4e.task
    const updatedAt = Date.now()
    Object.assign(task, {
      status: "retrying",
      phase,
      revision: task.revision + 1,
      retryRound: decision ? 1 : task.retryRound,
      currentModel: phase === "model-fallback-pending"
        ? { providerID: "provider", modelID: "fallback" }
        : { providerID: "provider", modelID: "primary" },
      failedModelCandidates: phase === "model-fallback-pending"
        ? [{ providerID: "provider", modelID: "primary" }]
        : [],
      handledModelErrorAttempt: 1,
      dispatchMessageID: `msg_${phase.replaceAll("-", "_")}`,
      updatedAt,
      ...(decision
        ? {
            retryDecision: {
              status: "resolved",
              retryRound: 0,
              attemptNumber: 1,
              requestedAt: updatedAt,
              error: "retryable fixture error",
              decision,
              resolvedAt: updatedAt,
            },
          }
        : {}),
    })
    first.runtime.dispose()
    first.delegation.dispose()

    const locks = new ScopeLockManager()
    let observedSignal
    const acquire = locks.acquire.bind(locks)
    locks.acquire = async (owner, effect, options) => {
      observedSignal = options?.signal
      return acquire(owner, effect, options)
    }
    const second = makeRuntime(client, root, locks, { models })
    await second.runtime.recoverSession("parent")
    await second.runtime.flush()
    second.runtime.resume()

    if (phase === "model-fallback-pending") {
      const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
      assert.equal(status.status, "waiting_retry_decision", phase)
      assert.equal(status.phase, "model-error-fallback-available", phase)
      assert.equal(client.prompts.length, 1, phase)
      assert.equal(observedSignal, undefined, phase)
    } else {
      while (client.prompts.length < 2 && !observedSignal) await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(observedSignal?.aborted, false, phase)
      while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
      const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
      assert.notEqual(status.status, "unknown", phase)
      assert.equal(client.prompts[1].body.messageID, task.dispatchMessageID, phase)
      if (decision === "restart") assert.notEqual(client.prompts[1].sessionID, response.sessionID)
      else assert.equal(client.prompts[1].sessionID, response.sessionID)
    }
    second.runtime.dispose()
    second.delegation.dispose()
  }
})

test("dispose drain 重试的 resume({dispatch:false}) 允许后续显式恢复派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  await locks.acquire("dispose-holder", { kind: "unknown-write" })
  const { runtime, delegation } = makeRuntime(client, root, locks, { monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent(
    { task: "retry after drain", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 0)

  await runtime.flush()
  locks.release("dispose-holder")
  runtime.resume({ dispatch: false })
  assert.equal(client.prompts.length, 0)
  runtime.dispatchRecoverableTasks()
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[0].sessionID, response.sessionID)

  runtime.dispose()
  delegation.dispose()
})

test("后台委派跨宿主 compaction continuation 对账原 dispatch 的完成结果", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const execution = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const dispatchMessageID = client.prompts[0].body.messageID
  const result = {
    info: { id: "assistant-final", role: "assistant", parentID: "compaction-continue", finish: "stop" },
    parts: [{ id: "part-final", type: "text", text: "result after compaction" }],
  }
  client.messages.set(response.sessionID, [
    { info: { id: dispatchMessageID, role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: dispatchMessageID, finish: "tool-calls" }, parts: [{ id: "part-tool", type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [{ id: "part-summary", type: "text", text: "summary" }] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    result,
  ])
  client.sessions.get(response.sessionID).status = "idle"

  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "completed")
  assert.equal(status.phase, "completed")
  const output = JSON.parse(await runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(output.output, "result after compaction")
  assert.equal(output.messageID, result.info.id)
  runtime.dispose()
})

test("后台委派跨宿主 compaction continuation 对账原 dispatch 的模型错误", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const execution = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const dispatchMessageID = client.prompts[0].body.messageID
  const error = { name: "UnknownError", data: { message: "failed after compaction" } }
  client.messages.set(response.sessionID, [
    { info: { id: dispatchMessageID, role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: dispatchMessageID, finish: "tool-calls" }, parts: [{ id: "part-tool", type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-error", role: "assistant", parentID: "compaction-continue", error }, parts: [] },
  ])
  client.sessions.get(response.sessionID).status = "idle"

  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "model-error-non-retryable")
  assert.equal(status.handledModelErrorAttempt, 1)
  assert.match(status.retryDecision.error, /failed after compaction/)
  runtime.dispose()
})

test("o4e_task output 只允许 completed 并严格使用持久化结果引用", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  await assert.rejects(
    runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }),
    /尚未 completed，不能读取 output/,
  )

  const completed = client.complete(response.sessionID, client.prompts[0].body.messageID, "result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  client.messages.set(response.sessionID, [
    completed,
    { info: { id: "newer-message", role: "assistant", parentID: client.prompts[0].body.messageID }, parts: [{ id: "newer-part", type: "text", text: "must not leak" }] },
  ])
  const output = JSON.parse(await runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(output.output, "result")
  assert.equal(output.messageID, completed.info.id)
  assert.deepEqual(output.partIDs, completed.parts.map((part) => part.id))

  client.messages.set(response.sessionID, [{
    info: { id: "unrelated-message", role: "assistant", parentID: client.prompts[0].body.messageID },
    parts: [{ id: "unrelated-part", type: "text", text: "must not be used as fallback" }],
  }])
  await assert.rejects(
    runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }),
    /completed 结果引用不可用/,
  )
  runtime.dispose()
})

test("o4e_task output 成功后持久化确认 terminal receipt 且重载不再通知", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "consume output receipt", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const output = await first.runtime.output(
    { taskID: response.taskID },
    { sessionID: "parent", messageID: "assistant-output-tool" },
  )
  assert.equal(output.output, "private result")
  const acknowledged = await internalTask(first.runtime, response.taskID)
  const acknowledgedRef = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  const acknowledgedRefReceipt = acknowledgedRef.receipts.find((receipt) => receipt.receiptID === acknowledged.receipt.receiptID)
  assert.equal(acknowledged.receipt.deliveredToMessageID, "assistant-output-tool")
  assert.equal(Number.isSafeInteger(acknowledged.receipt.acknowledgedAt), true)
  assert.equal(acknowledgedRefReceipt.receiptDeliveredToMessageID, "assistant-output-tool")
  assert.equal(acknowledgedRefReceipt.receiptAcknowledgedAt, acknowledged.receipt.acknowledgedAt)
  assert.deepEqual(await first.runtime.pendingReceipts({ sessionID: "parent" }), [])

  const acknowledgedRevision = acknowledged.revision
  await first.runtime.output(
    { taskID: response.taskID },
    { sessionID: "parent", messageID: "assistant-output-tool-repeated" },
  )
  const repeated = await internalTask(first.runtime, response.taskID)
  assert.equal(repeated.revision, acknowledgedRevision)
  assert.equal(repeated.receipt.deliveredToMessageID, "assistant-output-tool")
  assert.equal(repeated.receipt.acknowledgedAt, acknowledged.receipt.acknowledgedAt)
  first.runtime.dispose()
  first.delegation.dispose()

  const notifications = []
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: (event) => notifications.push(structuredClone(event)),
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(notifications, [])
  assert.deepEqual(await second.runtime.pendingReceipts({ sessionID: "parent" }), [])
  second.runtime.dispose()
  second.delegation.dispose()
})

test("终态 ledger 缺少 canonical 授权时恢复会撤销终态并隔离", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const unverifiable = addUnverifiableTask(client, { status: "completed", phase: "completed" })
  const { runtime, delegation } = makeRuntime(client, root)

  await runtime.recoverSession("parent")

  const task = client.sessions.get(unverifiable.childSessionID).metadata.o4e.task
  const ref = client.sessions.get(unverifiable.ownerSessionID).metadata.o4e.backgroundTasks.taskRefs[unverifiable.taskID]
  assert.equal(task.status, "unknown")
  assert.equal(task.phase, "authorization-unverifiable")
  assert.equal(task.result, undefined)
  assert.equal(task.receipt, undefined)
  assert.equal(ref.receipts, undefined)
  assert.equal(ref.receipts, undefined)
  runtime.dispose()
  delegation.dispose()
})

test("父 Session 缺失时不可验证终态 ledger 仍撤销终态并隔离", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const unverifiable = addUnverifiableTask(client, { status: "completed", phase: "completed" })
  client.sessions.delete(unverifiable.ownerSessionID)
  const { runtime, delegation } = makeRuntime(client, root)

  await runtime.recoverSession(unverifiable.childSessionID)

  const task = client.sessions.get(unverifiable.childSessionID).metadata.o4e.task
  assert.equal(task.status, "unknown")
  assert.equal(task.phase, "authorization-unverifiable")
  assert.equal(task.result, undefined)
  assert.equal(task.receipt, undefined)
  runtime.dispose()
  delegation.dispose()
})

test("父 receipt 引用持久化失败时不注入 task-only receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent(
    { task: "durable receipt", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const originalUpdate = client.session.update
  let rejectParentReceipt = true
  client.session.update = async (request) => {
    const ref = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[response.taskID]
    if (request.path.id === "parent" && ref?.receipts?.length && rejectParentReceipt) return { error: "parent receipt unavailable" }
    return originalUpdate(request)
  }
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  assert.equal((await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-1" })).length, 0)

  rejectParentReceipt = false
  const receipts = await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-2" })
  assert.equal(receipts.length, 1)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts.at(-1).receiptID, receipts[0].receiptID)
  runtime.dispose()
  delegation.dispose()
})

test("父 receipt 引用持久化失败时重载后发布 receipt 并续跑一次", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "durable continuation", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(first.runtime, response.taskID)
  await first.runtime.handle({ action: "input", taskID: response.taskID, input: "continue safely", expectedRevision: before.revision }, { sessionID: "parent" })
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    const ref = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[response.taskID]
    if (request.path.id === "parent" && ref?.receipts?.length) return { error: "parent receipt unavailable" }
    return originalUpdate(request)
  }

  client.complete(response.sessionID, client.prompts[0].body.messageID, "completed result")
  await first.runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  const terminal = await internalTask(first.runtime, response.taskID)
  assert.equal(terminal.status, "completed")
  assert.equal(terminal.pendingInputs[0].text, "continue safely")
  assert.equal(client.prompts.length, 1)
  first.runtime.dispose()

  client.session.update = originalUpdate
  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")
  const queued = await internalTask(second.runtime, response.taskID)
  assert.equal(queued.status, "queued")
  assert.equal(queued.phase, "input-queued")
  assert.equal(client.prompts.length, 1)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(ref.receipts.at(-1).receiptStatus, "completed")

  second.runtime.dispatchRecoverableTasks()
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[1].sessionID, response.sessionID)
  assert.match(client.prompts[1].body.parts[0].text, /continue safely/)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 2)
  second.runtime.dispose()
})

test("并发 Runtime 只允许当前 receipt generation 排队一次 pending input continuation", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "single generation continuation", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(first.runtime, response.taskID)
  await first.runtime.handle(
    { action: "input", taskID: response.taskID, input: "continue once", expectedRevision: before.revision },
    { sessionID: "parent" },
  )
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const queued = await internalTask(first.runtime, response.taskID)
  assert.equal(["queued", "starting", "running"].includes(queued.status), true)
  assert.equal(queued.runGeneration, 1)
  const queuedRevision = queued.revision
  first.runtime.dispose()
  first.delegation.dispose()

  const second = makeRuntime(client, root)
  const third = makeRuntime(client, root)
  await Promise.all([
    second.runtime.recoverSession("parent", { dispatch: false }),
    third.runtime.recoverSession("parent", { dispatch: false }),
  ])
  const recovered = client.sessions.get(response.sessionID).metadata.o4e.task
  assert.equal(recovered.runGeneration, 1)
  assert.equal(recovered.revision >= queuedRevision, true)
  assert.equal(recovered.pendingInputs.length + recovered.activeInputs.length, 1)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(ref.taskRevision <= recovered.revision, true)
  assert.equal(ref.receipts.filter((receipt) => receipt.receiptStatus === "completed").length, 1)
  second.runtime.dispose()
  second.delegation.dispose()
  third.runtime.dispose()
  third.delegation.dispose()
})

test("terminal receipt 至少一次投递并在父 Assistant 回合后确认", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await runtime.observeEvent({ kind: "idle", sessionID: response.sessionID })

  const first = await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-1" })
  assert.equal(first.length, 1)
  assert.equal(JSON.stringify(first).includes("private result"), false)
  await runtime.markReceiptsDelivered(first.map((receipt) => receipt.receiptID), { sessionID: "parent" }, "user-1")
  assert.equal((await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-2" })).length, 1)

  client.messages.set("parent", [{
    info: { id: "assistant-error", role: "assistant", parentID: "user-1", finish: "stop", error: { name: "APIError" } },
    parts: [],
  }])
  assert.equal((await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-3" })).length, 1)
  client.messages.set("parent", [{ info: { id: "assistant-parent", role: "assistant", parentID: "user-1", finish: "stop" }, parts: [] }])
  assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-4" }), [])
  const task = await internalTask(runtime, response.taskID)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(task.receipt.deliveredToMessageID, "user-1")
  assert.equal(Number.isSafeInteger(task.receipt.acknowledgedAt), true)
  const refReceipt = ref.receipts.find((entry) => entry.receiptID === task.receipt.receiptID)
  assert.equal(refReceipt.receiptDeliveredToMessageID, "user-1")
  assert.equal(refReceipt.receiptDeliveredAt, task.receipt.deliveredAt)
  assert.equal(refReceipt.receiptAcknowledgedAt, task.receipt.acknowledgedAt)

  await runtime.markReceiptsDelivered([task.receipt.receiptID], { sessionID: "parent" }, "user-5")
  const unchangedTask = await internalTask(runtime, response.taskID)
  const unchangedRef = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(unchangedTask.receipt.deliveredToMessageID, "user-1")
  assert.equal(unchangedRef.receipts.find((entry) => entry.receiptID === task.receipt.receiptID).receiptDeliveredToMessageID, "user-1")
})

test("terminal continuation delivery claim 跨 Runtime 保留首个 messageID", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "claim terminal delivery", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const [receipt] = await first.runtime.pendingReceipts({ sessionID: "parent" })

  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent", { dispatch: false })
  const [firstDelivery, secondDelivery] = await Promise.all([
    first.runtime.markReceiptsDelivered(
      [receipt.receiptID],
      { sessionID: "parent" },
      "continuation-first",
      { preserveExistingDelivery: true },
    ),
    second.runtime.markReceiptsDelivered(
      [receipt.receiptID],
      { sessionID: "parent" },
      "continuation-second",
      { preserveExistingDelivery: true },
    ),
  ])
  const claimedMessageIDs = new Set([...firstDelivery, ...secondDelivery].map((delivery) => delivery.messageID))
  assert.equal(claimedMessageIDs.size, 1)
  const claimedMessageID = [...claimedMessageIDs][0]
  assert.equal(["continuation-first", "continuation-second"].includes(claimedMessageID), true)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  const refReceipt = ref.receipts.find((entry) => entry.receiptID === receipt.receiptID)
  assert.equal(refReceipt.receiptDeliveredToMessageID, claimedMessageID)
  const task = client.sessions.get(response.sessionID).metadata.o4e.task
  assert.equal(task.receipt.deliveredToMessageID, claimedMessageID)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("terminal ledger 在首次投递前删除并重载仍保留 receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while (!client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts?.length) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  const receiptID = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts.at(-1).receiptID
  first.runtime.dispose()
  first.delegation.dispose()
  client.sessions.delete(response.sessionID)

  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")
  const status = await internalTask(second.runtime, response.taskID)
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "missing-ledger")
  const receipts = await second.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-1" })
  assert.deepEqual(receipts.map((receipt) => receipt.receiptID), [receiptID])
  assert.equal(receipts[0].status, "completed")
  assert.equal(receipts[0].outputAvailable, false)

  await second.runtime.markReceiptsDelivered([receiptID], { sessionID: "parent" }, "user-1")
  second.runtime.dispose()
  second.delegation.dispose()

  const third = makeRuntime(client, root)
  await third.runtime.recoverSession("parent")
  assert.deepEqual((await third.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-2" })).map((receipt) => receipt.receiptID), [receiptID])
  client.messages.set("parent", [{ info: { id: "assistant-parent", role: "assistant", parentID: "user-1", finish: "stop" }, parts: [] }])
  assert.deepEqual(await third.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-3" }), [])
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(ref.receipts.at(-1).receiptID, receiptID)
  assert.equal(Number.isSafeInteger(ref.receipts.at(-1).receiptAcknowledgedAt), true)
  third.runtime.dispose()
  third.delegation.dispose()
})

test("canonical ledger 删除但尚未 relink 时 receipt 不声称 output 可读", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent(
    { task: "verify output availability", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const [available] = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(available.outputAvailable, true)

  client.sessions.delete(response.sessionID)
  const [missing] = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(missing.receiptID, available.receiptID)
  assert.equal(missing.outputAvailable, false)
  runtime.dispose()
  delegation.dispose()
})

test("canonical completed ledger 的结果消息丢失时 receipt 不声称 output 可读", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent(
    { task: "verify result reference", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const [available] = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(available.outputAvailable, true)

  client.messages.delete(response.sessionID)
  const [missing] = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(missing.receiptID, available.receiptID)
  assert.equal(missing.outputAvailable, false)
  runtime.dispose()
  delegation.dispose()
})

test("canonical completed ledger 指向非最终或错误 Assistant 时 output 不可读", async () => {
  for (const info of [
    { finish: undefined },
    { finish: "unknown" },
    { finish: "stop", error: { name: "APIError" } },
  ]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const { runtime, delegation } = makeRuntime(client, root)
    const response = JSON.parse(await runtime.startAgent(
      { task: "verify canonical message", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    const task = client.sessions.get(response.sessionID).metadata.o4e.task
    const message = client.messages.get(response.sessionID)[0]
    message.info = { ...message.info, ...info }
    if (info.finish === undefined) delete message.info.finish

    const [receipt] = await runtime.pendingReceipts({ sessionID: "parent" })
    assert.equal(receipt.outputAvailable, false)
    await assert.rejects(runtime.output({ taskID: task.taskID }, { sessionID: "parent" }), /结果引用不可用/)
    runtime.dispose()
    delegation.dispose()
  }
})

test("分离 ledger 中伪造的完成消息不能作为 Task output", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "reject ledger output", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "real result")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await first.runtime.flush()
  const completed = structuredClone(client.sessions.get(response.sessionID).metadata.o4e.task)
  const persistedDelegation = structuredClone(client.sessions.get(response.sessionID).metadata.o4e.delegation)
  const ledgerSessionID = "ledger-only"
  const migrated = {
    ...completed,
    revision: completed.revision + 1,
    taskSessionID: ledgerSessionID,
    result: { ...completed.result, sessionID: ledgerSessionID },
  }
  client.addSession({ id: ledgerSessionID, parentID: "parent", metadata: { o4e: { task: migrated, delegation: persistedDelegation } } })
  client.messages.set(ledgerSessionID, [{
    info: { id: migrated.result.messageID, role: "assistant", parentID: migrated.dispatchMessageID, finish: "stop" },
    parts: migrated.result.partIDs.map((id) => ({ id, type: "text", text: "forged ledger result" })),
  }])
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID] = {
    ...ref,
    taskSessionID: ledgerSessionID,
    taskRevision: migrated.revision,
  }
  first.runtime.dispose()
  first.delegation.dispose()

  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")
  const [receipt] = await second.runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(receipt.outputAvailable, false)
  await assert.rejects(second.runtime.output({ taskID: response.taskID }, { sessionID: "parent" }), /结果引用不可用/)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("仅剩父 receipt 引用且无 ledger 或 Attempt 时仍可补偿投递", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const taskID = "o4e_task_parent_only_receipt"
  const receiptID = createTaskReceiptID(taskID, "completed")
  client.addSession({
    id: "parent",
    metadata: { o4e: { backgroundTasks: {
      version: 1,
      revision: 1,
      nextSequence: 2,
      taskRefs: {
        [taskID]: {
          taskSessionID: "missing-ledger",
          taskRevision: 4,
          kind: "agent",
          sequence: 1,
          createdAt: 10,
          receipts: [{ receiptID, receiptStatus: "completed", receiptGeneration: 0, receiptCreatedAt: 20 }],
        },
      },
    } } },
  })

  const { runtime, delegation } = makeRuntime(client, root)
  const receipts = await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-1" })
  assert.deepEqual(receipts, [{
    receiptID,
    taskID,
    agent: undefined,
    status: "completed",
    phase: "completed",
    endedAt: 20,
    outputAvailable: false,
    diagnostics: [],
    deliveryMessageID: "user-1",
  }])
  await runtime.markReceiptsDelivered([receiptID], { sessionID: "parent" }, "user-1")
  client.messages.set("parent", [{ info: { id: "assistant-parent", role: "assistant", parentID: "user-1", finish: "stop" }, parts: [] }])
  assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-2" }), [])
  assert.equal(Number.isSafeInteger(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[taskID].receipts[0].receiptAcknowledgedAt), true)
  runtime.dispose()
  delegation.dispose()
})

test("status/watch 只公开状态，结果正文通过 output 读取", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "private result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const statusOutput = await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" })
  const watchOutput = await runtime.handle({ action: "watch", taskIDs: [response.taskID], timeoutMs: 0 }, { sessionID: "parent" })
  assert.equal(statusOutput.includes("private result"), false)
  assert.equal(watchOutput.includes("private result"), false)
  for (const output of [statusOutput, watchOutput]) {
    for (const field of ["authorizationFingerprint", "dispatchMessageID", "attemptSessionIDs", "modelCandidates", "failedModelCandidates", "sideEffectWatermark", "result"]) {
      assert.equal(output.includes(`\"${field}\"`), false, field)
    }
  }
  runtime.dispose()
})

test("receipt 背压不阻止投递和确认已有未确认项，但重载后不隐式派发旧 continuation", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "receipt pressure", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const child = client.sessions.get(response.sessionID)
  const record = child.metadata.o4e.task
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  record.status = "completed"
  record.phase = "completed"
  record.runGeneration = 20
  record.endedAt = record.updatedAt + 1
  record.updatedAt = record.endedAt
  record.revision += 1
  record.result = undefined
  record.pendingInputs = [{ version: 1, text: "continue after receipt pressure", createdAt: record.updatedAt }]
  record.receipt = {
    version: 1,
    receiptID: createTaskReceiptID(response.taskID, "completed", 20),
    taskID: response.taskID,
    status: "completed",
    phase: "completed",
    createdAt: record.endedAt,
    generation: 20,
  }
  ref.receipts = Array.from({ length: 20 }, (_, generation) => ({
    receiptID: createTaskReceiptID(response.taskID, "completed", generation),
    receiptStatus: "completed",
    receiptGeneration: generation,
    receiptCreatedAt: generation + 1,
  }))
  first.runtime.dispose()

  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts.length, 20)

  const receipts = await second.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-pressure" })
  assert.equal(receipts.length, 20)
  assert.equal(receipts.some((receipt) => receipt.receiptID === record.receipt.receiptID), false)
  await second.runtime.markReceiptsDelivered(receipts.map((receipt) => receipt.receiptID), { sessionID: "parent" }, "user-pressure")
  client.messages.set("parent", [{
    info: { id: "assistant-pressure", role: "assistant", parentID: "user-pressure", finish: "stop" },
    parts: [{ id: "prt-pressure", type: "text", text: "handled" }],
  }])
  const released = await second.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-after-pressure" })
  assert.deepEqual(released.map((receipt) => receipt.receiptID), [record.receipt.receiptID])
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 1)
  const continuation = await internalTask(second.runtime, response.taskID)
  assert.equal(continuation.runGeneration, 21)
  assert.equal(continuation.status, "queued")
  assert.equal(continuation.phase, "input-queued")
  await second.runtime.markReceiptsDelivered([record.receipt.receiptID], { sessionID: "parent" }, "user-after-pressure")
  client.messages.set("parent", [...client.messages.get("parent"), {
    info: { id: "assistant-after-pressure", role: "assistant", parentID: "user-after-pressure", finish: "stop" },
    parts: [{ id: "prt-after-pressure", type: "text", text: "handled current" }],
  }])
  assert.deepEqual(await second.runtime.pendingReceipts({ sessionID: "parent" }, { messageID: "user-final-pressure" }), [])
  const acknowledged = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts
  assert.equal(acknowledged.every((receipt) => receipt.receiptAcknowledgedAt !== undefined), true)
  second.runtime.dispose()
})

test("后台写任务在终止前持有 Scope Lock，并拒绝 sibling 查询和取消", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  client.addSession({ id: "sibling", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks)
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  let acquired = false
  const waiting = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  await assert.rejects(runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "sibling" }), /无权读取 Task/)
  await assert.rejects(runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: response.sessionID }), /只有父 Session/)
  client.complete(response.sessionID, client.prompts[0].body.messageID)
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await waiting
  assert.equal(acquired, true)
  locks.release("other")
  runtime.dispose()
})

test("取消先写入 cancelling，宿主确认 idle 后才进入 cancelled", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(runtime.handle({ action: "cancel", taskID: response.taskID, reason: "stop" }, { sessionID: "parent" }), /reason is not supported/)
  assert.deepEqual(client.aborts, [])
  const cancelling = JSON.parse(await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  assert.deepEqual(client.aborts, [response.sessionID])
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const cancelled = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  const delegation = client.sessions.get(response.sessionID).metadata.o4e.delegation
  assert.equal(delegation.status, "cancelled")
  assert.equal(delegation.cancellationRequestedAt, cancelled.cancellationRequestedAt)
  assert.equal(typeof delegation.endedAt, "number")
  assert.equal(delegation.result, undefined)
  runtime.dispose()
})

test("取消在已观察活动后以 status 缺项收敛，但未激活或未决 dispatch 保留写锁", { timeout: 5000 }, async (t) => {
  for (const allAttempts of [false, true]) for (const mode of ["active", "shared-runtime", "cold-running", "cold-starting", "awaiting-activation", "dispatch-pending"]) await t.test(`${allAttempts ? "all-attempts" : "current"}/${mode}`, async (t) => {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    useSparseStatusMap(client)
    const dispatch = Promise.withResolvers()
    const started = Promise.withResolvers()
    const originalPrompt = client.session.promptAsync
    client.session.promptAsync = async (request) => {
      if (mode === "awaiting-activation") {
        client.prompts.push({ sessionID: request.path.id, body: structuredClone(request.body) })
      } else await originalPrompt(request)
      started.resolve()
      if (mode === "dispatch-pending") await dispatch.promise
      return { data: undefined }
    }
    const locks = new ScopeLockManager()
    const first = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
    let runtime = first.runtime
    t.after(() => { dispatch.resolve(); first.runtime.dispose(); first.delegation.dispose() })
    const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    await started.promise
    await new Promise((resolve) => setImmediate(resolve))
    // The activity proof belongs to this Attempt, not a generic idle event.
    if (mode !== "awaiting-activation") await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
    if (mode.startsWith("cold-")) {
      first.runtime.dispose()
      first.delegation.dispose()
      const record = client.sessions.get(response.sessionID).metadata.o4e.task
      record.status = mode === "cold-starting" ? "starting" : "running"
      record.phase = mode === "cold-starting" ? "starting" : "model-running"
      record.revision += 1
      client.sessions.get(response.sessionID).status = "idle"
    }
    if (mode === "shared-runtime" || mode.startsWith("cold-")) {
      const second = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
      t.after(() => { second.runtime.dispose(); second.delegation.dispose() })
      await second.runtime.recoverSession("parent", { dispatch: false })
      runtime = second.runtime
    }
    if (allAttempts) {
      const record = client.sessions.get(response.sessionID).metadata.o4e.task
      record.requiresAllAttemptsStopped = true
      record.revision += 1
    }
    await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
    let acquired = false
    const blocked = locks.acquire(`other-${mode}`, { kind: "unknown-write" }).then(() => { acquired = true })
    void blocked.catch(() => undefined)
    t.after(() => locks.release(`other-${mode}`))
    if (mode === "active") {
      const originalStatus = client.session.status
      for (const status of [{ type: "busy" }, { type: "retry" }, null, {}, "read-failed"]) {
        client.session.status = async () => {
          if (status === "read-failed") throw new Error("host status unavailable")
          return { data: { [response.sessionID]: status } }
        }
        await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
        const uncertain = await internalTask(runtime, response.taskID)
        assert.notEqual(uncertain.status, "cancelled")
        assert.equal(acquired, false)
      }
      client.session.status = originalStatus
    }
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    let status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
    const canSettle = ["active", "shared-runtime", "cold-running"].includes(mode)
    if (canSettle) assert.equal(status.status, "cancelled")
    else assert.ok(["cancelling", "unknown"].includes(status.status))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(acquired, canSettle)
    if (mode === "awaiting-activation" || mode === "cold-starting") {
      // A late activation still must not escape cancellation, and supplies the
      // missing activation evidence before the subsequent inactive snapshot.
      client.sessions.get(response.sessionID).status = "busy"
      await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
      client.sessions.get(response.sessionID).status = "idle"
    }
    if (mode === "cold-starting") {
      await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
      assert.notEqual((await internalTask(runtime, response.taskID)).status, "cancelled")
      assert.equal(acquired, false)
      // A lost dispatch acknowledgement remains uncertain even after activity;
      // unlike omission, explicit idle provides independent stopped evidence.
      client.session.status = async () => ({ data: { [response.sessionID]: { type: "idle" } } })
    }
    dispatch.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
    assert.equal(status.status, "cancelled")
    await blocked
    assert.equal(acquired, true)
  })
})

test("取消的 inactive 停止写入遇到新 busy 后撤销终态并保留锁", { timeout: 5000 }, async (t) => {
  for (const allAttempts of [false, true]) await t.test(allAttempts ? "all-attempts" : "current", async (t) => {
    const client = new BackgroundClient()
    useSparseStatusMap(client)
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const locks = new ScopeLockManager()
    const { runtime, delegation } = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
    t.after(() => { runtime.dispose(); delegation.dispose() })
    const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    await until(() => client.sessions.get(response.sessionID).metadata.o4e.task.status === "running")
    await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
    const record = client.sessions.get(response.sessionID).metadata.o4e.task
    record.requiresAllAttemptsStopped = allAttempts
    record.revision += 1
    await runtime.cancel({ taskID: response.taskID }, { sessionID: "parent" })

    const written = deferred()
    const release = deferred()
    t.after(() => release.resolve())
    const originalUpdate = client.session.update
    let blocked = false
    client.session.update = async (request) => {
      const result = await originalUpdate(request)
      if (!blocked && request.body?.metadata?.o4e?.task?.status === "cancelled") {
        blocked = true
        written.resolve()
        await release.promise
      }
      return result
    }
    const stale = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    await written.promise
    client.sessions.get(response.sessionID).status = "busy"
    const newer = runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
    await new Promise((resolve) => setImmediate(resolve))
    release.resolve()
    await Promise.all([stale, newer])
    const current = await internalTask(runtime, response.taskID)
    assert.equal(current.status, "cancelling")
    assert.equal(current.receipt, undefined)
    const delegationState = client.sessions.get(response.sessionID).metadata.o4e.delegation
    assert.notEqual(delegationState.status, "cancelled")
    assert.equal(delegationState.endedAt, undefined)
    assert.equal(locks.has(`background-task:${response.taskID}`), true)
    const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
    assert.equal(ref.receiptID, undefined)
    assert.equal(ref.receipts?.length ?? 0, 0)

    client.sessions.get(response.sessionID).status = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    assert.equal((await internalTask(runtime, response.taskID)).status, "cancelled")
    assert.equal(locks.has(`background-task:${response.taskID}`), false)
  })
})

test("取消对账不会被仍在宿主列表中的 pending request 阻塞", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const execution = makePendingExecution(client, hostRequests)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "ask", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-cancel",
    sessionID: response.sessionID,
    question: {
      questions: [{ header: "Stop?", question: "Continue?", options: [], multiple: false, custom: true }],
    },
  }
  hostRequests.set("question:question-cancel", request)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })

  const cancelling = JSON.parse(await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const cancelled = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  runtime.dispose()
})

test("starting 期间取消不会被异步 dispatch 回写为 running", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let acceptDispatch
  let dispatchStarted
  const started = new Promise((resolve) => { dispatchStarted = resolve })
  client.session.promptAsync = async ({ path, body }) => {
    client.prompts.push({ sessionID: path.id, body: structuredClone(body) })
    client.sessions.get(path.id).status = "busy"
    dispatchStarted()
    await new Promise((resolve) => { acceptDispatch = resolve })
    return { data: undefined }
  }
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await started

  const cancelling = JSON.parse(await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const stillCancelling = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillCancelling.status, "cancelling")
  acceptDispatch()
  await new Promise((resolve) => setTimeout(resolve, 5))

  const cancelled = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.attemptNumber, 1)
  assert.equal(client.aborts.length, 2)
  runtime.dispose()
})

test("跨 Runtime 未决 dispatch 完成前取消不会进入终态或释放写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let acceptDispatch
  let dispatchStarted
  const started = new Promise((resolve) => { dispatchStarted = resolve })
  client.session.promptAsync = async ({ path, body }) => {
    client.prompts.push({ sessionID: path.id, body: structuredClone(body) })
    dispatchStarted()
    await new Promise((resolve) => { acceptDispatch = resolve })
    client.sessions.get(path.id).status = "busy"
    return { data: undefined }
  }
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await started

  const second = makeRuntime(client, root, locks)
  await second.runtime.activateSession("parent")
  const cancelling = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  let acquired = false
  const waiting = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)

  acceptDispatch()
  while (client.sessions.get(response.sessionID).metadata.o4e.task.status !== "cancelled") {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(client.sessions.get(response.sessionID).metadata.o4e.task.status, "cancelled")
  await waiting
  locks.release("other")
  first.runtime.dispose()
  second.runtime.dispose()
})

test("跨 Runtime queued 快速取消先建立 fence，阻止并发 claim 启动回合", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  const second = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  let releaseCancelRef
  let cancelRefBlocked
  let blockedCancelRef = false
  const blocked = new Promise((resolve) => { cancelRefBlocked = resolve })
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    if (!blockedCancelRef && request.path.id === "parent" && request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[queued.taskID]?.cancellationRequestedAt) {
      blockedCancelRef = true
      const result = await originalUpdate(request)
      cancelRefBlocked()
      await new Promise((resolve) => { releaseCancelRef = resolve })
      return result
    }
    return originalUpdate(request)
  }
  const cancelling = second.runtime.handle({ action: "cancel", taskID: queued.taskID }, { sessionID: "parent" })
  await blocked

  client.complete(active.sessionID, client.prompts[0].body.messageID, "active done")
  const completing = first.runtime.observeEvent({ kind: "session-idle", sessionID: active.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  releaseCancelRef()
  await completing
  await cancelling
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: queued.sessionID })
  const cancelled = JSON.parse(await second.runtime.handle({ action: "status", taskID: queued.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  assert.equal(client.prompts.length, 1)
  first.runtime.dispose()
  second.runtime.dispose()
})

test("不同目录的同 taskID cancellation fence 不阻止 queued Task 派发", async () => {
  const sharedTaskID = "o4e_task_same_directory_isolation"
  const rootA = "/tmp"
  const rootB = process.cwd()
  const clientA = new BackgroundClient()
  const clientB = new BackgroundClient()
  clientA.addSession({ id: "parent-a", directory: rootA, metadata: {} })
  clientB.addSession({ id: "parent-b", directory: rootB, metadata: {} })
  let releaseCancelRef
  let cancelRefBlocked
  let blockedCancelRef = false
  const cancelFenceEstablished = new Promise((resolve) => { cancelRefBlocked = resolve })
  const originalUpdateA = clientA.session.update
  clientA.session.update = async (request) => {
    if (!blockedCancelRef && request.path.id === "parent-a" && request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[sharedTaskID]?.cancellationRequestedAt) {
      blockedCancelRef = true
      const result = await originalUpdateA(request)
      cancelRefBlocked()
      await new Promise((resolve) => { releaseCancelRef = resolve })
      return result
    }
    return originalUpdateA(request)
  }

  const runtimeA = makeRuntime(clientA, rootA)
  const createdA = JSON.parse(await runtimeA.runtime.startAgent(
    { task: "cancel in project A", agent: "worker" },
    { sessionID: "parent-a", agent: "orchestrator", directory: rootA },
  ))
  while (clientA.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
  renamePersistedTask(clientA, {
    ownerSessionID: "parent-a",
    taskSessionID: createdA.sessionID,
    fromTaskID: createdA.taskID,
    toTaskID: sharedTaskID,
  })
  const recoveredA = makeRuntime(clientA, rootA)
  await recoveredA.runtime.recoverSession("parent-a", { dispatch: false })
  const cancellingA = recoveredA.runtime.handle(
    { action: "cancel", taskID: sharedTaskID },
    { sessionID: "parent-a", directory: rootA },
  )
  await cancelFenceEstablished

  const seedB = makeRuntime(clientB, rootB)
  const createdB = JSON.parse(await seedB.runtime.startAgent(
    { task: "dispatch in project B", agent: "worker" },
    { sessionID: "parent-b", agent: "orchestrator", directory: rootB },
  ))
  while (clientB.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
  renamePersistedTask(clientB, {
    ownerSessionID: "parent-b",
    taskSessionID: createdB.sessionID,
    fromTaskID: createdB.taskID,
    toTaskID: sharedTaskID,
  })
  resetPersistedTaskToQueued(clientB, {
    ownerSessionID: "parent-b",
    taskSessionID: createdB.sessionID,
    taskID: sharedTaskID,
  })
  const promptCountBeforeRecovery = clientB.prompts.length
  const recoveredB = makeRuntime(clientB, rootB)
  await recoveredB.runtime.recoverSession("parent-b", { dispatch: true })
  while (clientB.prompts.length === promptCountBeforeRecovery) await new Promise((resolve) => setImmediate(resolve))
  const runningB = JSON.parse(await recoveredB.runtime.handle(
    { action: "status", taskID: sharedTaskID },
    { sessionID: "parent-b", directory: rootB },
  ))
  assert.equal(runningB.status, "running")

  releaseCancelRef()
  await cancellingA
  runtimeA.runtime.dispose()
  recoveredA.runtime.dispose()
  seedB.runtime.dispose()
  recoveredB.runtime.dispose()
})

test("不同目录的同 taskID dispatch fence 不阻止取消结算", async () => {
  const sharedTaskID = "o4e_task_same_dispatch_isolation"
  const rootA = "/tmp"
  const rootB = process.cwd()
  const clientA = new BackgroundClient()
  const clientB = new BackgroundClient()
  clientA.addSession({ id: "parent-a", directory: rootA, metadata: {} })
  clientB.addSession({ id: "parent-b", directory: rootB, metadata: {} })

  const seedA = makeRuntime(clientA, rootA)
  const createdA = JSON.parse(await seedA.runtime.startAgent(
    { task: "seed project A", agent: "worker" },
    { sessionID: "parent-a", agent: "orchestrator", directory: rootA },
  ))
  while (clientA.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
  renamePersistedTask(clientA, {
    ownerSessionID: "parent-a",
    taskSessionID: createdA.sessionID,
    fromTaskID: createdA.taskID,
    toTaskID: sharedTaskID,
  })
  resetPersistedTaskToQueued(clientA, {
    ownerSessionID: "parent-a",
    taskSessionID: createdA.sessionID,
    taskID: sharedTaskID,
  })
  let acceptDispatchA
  let dispatchStartedA
  const startedA = new Promise((resolve) => { dispatchStartedA = resolve })
  const dispatchExecutionA = {
    startTurn: async () => {
      dispatchStartedA()
      await new Promise((resolve) => { acceptDispatchA = resolve })
    },
    cancelTurn: async () => ({ acknowledged: true }),
    inspectTurn: async () => ({ state: "running" }),
  }
  const recoveredA = makeRuntime(clientA, rootA, new ScopeLockManager(), { execution: dispatchExecutionA })
  await recoveredA.runtime.recoverSession("parent-a", { dispatch: true })
  await startedA

  const seedB = makeRuntime(clientB, rootB)
  const createdB = JSON.parse(await seedB.runtime.startAgent(
    { task: "cancel project B", agent: "worker" },
    { sessionID: "parent-b", agent: "orchestrator", directory: rootB },
  ))
  while (clientB.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
  renamePersistedTask(clientB, {
    ownerSessionID: "parent-b",
    taskSessionID: createdB.sessionID,
    fromTaskID: createdB.taskID,
    toTaskID: sharedTaskID,
  })
  const recoveredB = makeRuntime(clientB, rootB)
  await recoveredB.runtime.recoverSession("parent-b", { dispatch: false })
  const cancellingB = JSON.parse(await recoveredB.runtime.handle(
    { action: "cancel", taskID: sharedTaskID },
    { sessionID: "parent-b", directory: rootB },
  ))
  assert.equal(cancellingB.status, "cancelling")
  await recoveredB.runtime.observeEvent({ kind: "session-idle", sessionID: createdB.sessionID })
  const cancelledB = JSON.parse(await recoveredB.runtime.handle(
    { action: "status", taskID: sharedTaskID },
    { sessionID: "parent-b", directory: rootB },
  ))
  assert.equal(cancelledB.status, "cancelled")

  acceptDispatchA()
  seedA.runtime.dispose()
  recoveredA.runtime.dispose()
  seedB.runtime.dispose()
  recoveredB.runtime.dispose()
})

test("跨 Runtime 显式 status 和 cancel 刷新 owner 与 ledger", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "cross runtime visibility", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")
  client.complete(response.sessionID, client.prompts[0].body.messageID, "visible completion")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const completed = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(completed.status, "completed")

  const cancellable = JSON.parse(await first.runtime.startAgent(
    { task: "cross runtime cancel", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const cancelling = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: cancellable.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  assert.equal(client.aborts.at(-1), cancellable.sessionID)

  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("取消请求未被宿主确认时进入 unknown 并保留写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const execution = {
    startTurn: ({ sessionID, messageID, agent: targetAgent, parts }) => client.session.promptAsync({ path: { id: sessionID }, body: { messageID, agent: targetAgent, parts } }),
    cancelTurn: async () => ({ acknowledged: false }),
    inspectTurn: async () => ({ state: "running" }),
  }
  const { runtime } = makeRuntime(client, root, locks, { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  const unknown = JSON.parse(await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.phase, "cancel-unconfirmed")
  let acquired = false
  const waiting = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waiting
  locks.release("other")
})

test("取消时 dispatch 失败不会伪造 cancelled", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let rejectDispatch
  let dispatchStarted
  const started = new Promise((resolve) => { dispatchStarted = resolve })
  const execution = {
    startTurn: async () => {
      dispatchStarted()
      await new Promise((_, reject) => { rejectDispatch = reject })
    },
    cancelTurn: async () => ({ acknowledged: true }),
    inspectTurn: async () => { throw new Error("transport unavailable") },
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await started

  await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  rejectDispatch(new Error("dispatch transport failed"))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "cancel-unconfirmed")
  runtime.dispose()
})

test("取消意图保持单调并继续占用 admission 槽", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    return { data: false }
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary", "provider/fallback"],
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const first = JSON.parse(await runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const second = JSON.parse(await runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  const unknown = JSON.parse(await runtime.handle({ action: "cancel", taskID: first.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  assert.equal(client.prompts.length, 1)
  await runtime.observeEvent({ kind: "permission-waiting", sessionID: first.sessionID })
  await runtime.observeEvent({ kind: "question-waiting", sessionID: first.sessionID })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: first.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const stillUnknown = JSON.parse(await runtime.handle({ action: "status", taskID: first.taskID }, { sessionID: "parent" }))
  assert.equal(stillUnknown.status, "unknown")
  assert.equal(stillUnknown.phase, "cancel-unconfirmed")
  assert.equal(client.prompts.length, 1)

  client.sessions.get(first.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const cancelled = JSON.parse(await runtime.handle({ action: "status", taskID: first.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  assert.equal(client.prompts.length, 2)
  assert.equal(client.prompts[1].sessionID, second.sessionID)
  runtime.dispose()
})

test("取消期间旧 idle inspection 不会覆盖后到的 busy 证据", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    return { data: false }
  }
  let releaseIdle
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks, {
    execution: {
      startTurn: async ({ sessionID }) => { client.sessions.get(sessionID).status = "busy" },
      cancelTurn: async ({ sessionID }) => {
        client.aborts.push(sessionID)
        return { acknowledged: false }
      },
      inspectTurn: async () => {
        if (!releaseIdle) {
          await new Promise((resolvePromise) => { releaseIdle = resolvePromise })
          return { state: "idle" }
        }
        return { state: "running" }
      },
    },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })

  const idle = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while (!releaseIdle) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  releaseIdle()
  await idle

  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "cancel-unconfirmed")
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  blocked.abort(new Error("still locked"))
  await assert.rejects(waiting, /still locked/)
  runtime.dispose()
})

test("完成记录持久化期间到达的 busy 证据会撤销陈旧 completed 并保留写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
  const response = JSON.parse(await runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const originalUpdate = client.session.update
  let releaseCompletedWrite
  let completedWriteStarted
  const started = new Promise((resolvePromise) => { completedWriteStarted = resolvePromise })
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.task?.status === "completed") {
      completedWriteStarted()
      await new Promise((resolvePromise) => { releaseCompletedWrite = resolvePromise })
    }
    return originalUpdate(request)
  }

  client.complete(response.sessionID, client.prompts[0].body.messageID, "stale result")
  const idle = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await started
  client.sessions.get(response.sessionID).status = "busy"
  const busy = runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releaseCompletedWrite()
  await Promise.all([idle, busy])

  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "running")
  assert.equal(status.phase, "model-running")
  assert.equal(status.receipt, undefined)
  assert.equal(locks.has(`background-task:${response.taskID}`), true)
  runtime.dispose()
})

test("完成 ledger 已持久化后到达 busy 仍撤销 receipt 并保留写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
  const response = JSON.parse(await runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const originalUpdate = client.session.update
  let releaseDelegationWrite
  let delegationWriteStarted
  const started = new Promise((resolvePromise) => { delegationWriteStarted = resolvePromise })
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
      delegationWriteStarted()
      await new Promise((resolvePromise) => { releaseDelegationWrite = resolvePromise })
    }
    return originalUpdate(request)
  }

  client.complete(response.sessionID, client.prompts[0].body.messageID, "stale result")
  const idle = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await started
  client.sessions.get(response.sessionID).status = "busy"
  const busy = runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releaseDelegationWrite()
  await Promise.all([idle, busy])

  const status = await internalTask(runtime, response.taskID)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(status.status, "running")
  assert.equal(status.receipt, undefined)
  assert.equal(ref.receipts, undefined)
  assert.equal(locks.has(`background-task:${response.taskID}`), true)
  runtime.dispose()
})

test("跨 Runtime 的 busy 证据会使 completion settlement 失效并保留写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const second = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000 })
  await second.runtime.recoverSession("parent")
  const originalUpdate = client.session.update
  let releaseDelegationWrite
  let delegationWriteStarted
  const started = new Promise((resolvePromise) => { delegationWriteStarted = resolvePromise })
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
      delegationWriteStarted()
      await new Promise((resolvePromise) => { releaseDelegationWrite = resolvePromise })
    }
    return originalUpdate(request)
  }

  client.complete(response.sessionID, client.prompts[0].body.messageID, "stale result")
  const idle = first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await started
  client.sessions.get(response.sessionID).status = "busy"
  const busy = second.runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releaseDelegationWrite()
  await Promise.all([idle, busy])

  const status = await internalTask(second.runtime, response.taskID)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(status.status, "running")
  assert.equal(status.phase, "model-running")
  assert.equal(status.receipt, undefined)
  assert.equal(ref.receipts, undefined)
  assert.equal(locks.has(`background-task:${response.taskID}`), true)
  first.runtime.dispose()
  second.runtime.dispose()
})

test("并发取消已持久化后旧 completion rollback 不会把 sibling Delegation 改回 running", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000, models: ["provider/primary"] })
  const bounded = async (label, promise) => {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, rejectPromise) => { timer = setTimeout(() => rejectPromise(new Error(`timeout: ${label}`)), 5000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const response = JSON.parse(await bounded("start", first.runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  )))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await bounded("watermark", first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" }))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await bounded("model-error", first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } }))
  const waiting = JSON.parse(await bounded("status", first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" })))
  const restarted = JSON.parse(await bounded("restart", first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" })))
  assert.notEqual(restarted.taskSessionID, restarted.childSessionID)

  const second = makeRuntime(client, root, locks, { monitorIntervalMs: 60_000, models: ["provider/primary"] })
  await bounded("recover", second.runtime.recoverSession("parent"))

  const originalUpdate = client.session.update
  let releaseDelegationWrite
  let delegationWriteCommitted
  let cancellationFencePersisted
  const committed = new Promise((resolvePromise) => { delegationWriteCommitted = resolvePromise })
  const cancellationPersisted = new Promise((resolvePromise) => { cancellationFencePersisted = resolvePromise })
  client.session.update = async (request) => {
    if (request.path.id === restarted.taskSessionID
      && request.body?.metadata?.o4e?.task?.status === "cancelling") {
      const result = await originalUpdate(request)
      cancellationFencePersisted()
      return result
    }
    if (request.path.id === restarted.childSessionID
      && request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
      const result = await originalUpdate(request)
      delegationWriteCommitted()
      await new Promise((resolvePromise) => { releaseDelegationWrite = resolvePromise })
      return result
    }
    return originalUpdate(request)
  }

  client.complete(restarted.childSessionID, client.prompts[1].body.messageID, "stale result")
  const completing = first.runtime.observeEvent({ kind: "session-idle", sessionID: restarted.childSessionID })
  await bounded("completion sibling write", committed)
  const cancelling = second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  await bounded("cancellation fence", cancellationPersisted)
  releaseDelegationWrite()
  await bounded("cancel", cancelling)
  await bounded("cancel reconciliation", second.runtime.observeEvent({ kind: "session-idle", sessionID: restarted.childSessionID }))
  await bounded("completion rollback", completing)

  const ledger = client.sessions.get(restarted.taskSessionID).metadata.o4e
  const task = ledger.task
  const delegation = client.sessions.get(restarted.childSessionID).metadata.o4e.delegation
  assert.equal(task.status, "cancelled")
  assert.equal(ledger.delegation.status, "cancelled")
  assert.notEqual(delegation.status, "running")
  assert.equal(delegation.cancellationRequestedAt, task.cancellationRequestedAt)
  assert.equal(delegation.result, undefined)
  assert.equal(locks.has(`background-task:${response.taskID}`), false)
  await bounded("post-cancel lock", locks.acquire("after", { kind: "unknown-write" }))
  locks.release("after")
  first.runtime.dispose()
  second.runtime.dispose()
})

test("completion sibling Delegation 缺失或身份不匹配时 fail closed", async () => {
  const root = process.cwd()
  for (const [label, mutate] of [
    ["missing", (state) => { delete state.delegation }],
    ["mismatched", (state) => { state.delegation.taskID = "other-task" }],
    ["permission-replaced", (_state, session) => { session.permission = [{ permission: "task", action: "deny", pattern: "*" }] }],
  ]) {
    const client = new BackgroundClient()
    client.addSession({ id: "parent", metadata: {} })
    const locks = new ScopeLockManager()
    const { runtime } = makeRuntime(client, root, locks)
    const response = JSON.parse(await runtime.startAgent(
      { task: `edit ${label}`, agent: "worker", writeScopes: ["."] },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    mutate(client.sessions.get(response.sessionID).metadata.o4e, client.sessions.get(response.sessionID))
    client.complete(response.sessionID, client.prompts[0].body.messageID, "must not settle")

    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

    const status = await internalTask(runtime, response.taskID)
    assert.equal(status.status, "unknown", label)
    assert.equal(status.phase, "result-settlement-unconfirmed", label)
    assert.equal(status.receipt, undefined, label)
    assert.equal(locks.has(`background-task:${response.taskID}`), true, label)
    runtime.dispose()
    locks.clear()
  }
})

test("旧 Runtime 的在途状态写不会覆盖新 Runtime 的取消", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  const originalUpdate = client.session.update
  let releaseOldWrite
  let oldWriteBlocked
  const blocked = new Promise((resolve) => { oldWriteBlocked = resolve })
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.task?.phase === "permission-waiting") {
      oldWriteBlocked()
      await new Promise((resolve) => { releaseOldWrite = resolve })
    }
    return originalUpdate(request)
  }
  const latePermission = first.runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID })
  await blocked
  const second = makeRuntime(client, root)
  const cancelling = second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  while (!client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].cancellationRequestedAt) {
    await Promise.resolve()
  }
  releaseOldWrite()
  await Promise.all([latePermission, cancelling])

  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.ok(status.status === "cancelling" || status.status === "cancelled")
  assert.ok(status.cancellationRequestedAt)
  assert.ok(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].cancellationRequestedAt)
  first.runtime.dispose()
  second.runtime.dispose()
})

test("迟到取消不会覆盖另一 Runtime 已持久化的 completed 终态", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = makeRuntime(client, root)
  await second.runtime.activateSession("parent")
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done before cancel persisted")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const result = JSON.parse(await first.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(result.status, "completed")
  assert.equal(client.sessions.get(response.sessionID).metadata.o4e.task.status, "completed")
  first.runtime.dispose()
  second.runtime.dispose()
})

test("父 Session 删除的迟到取消接受 completed 并释放本地写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.activateSession("parent")
  client.complete(response.sessionID, client.prompts[0].body.messageID, "completed before owner delete")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  client.sessions.delete("parent")

  await first.runtime.observeEvent({ kind: "deleted", sessionID: "parent" })
  assert.equal(client.sessions.get(response.sessionID).metadata.o4e.task.status, "completed")
  await locks.acquire("other", { kind: "unknown-write" })
  locks.release("other")
  first.runtime.dispose()
  second.runtime.dispose()
})

test("取消产生的 session.error 按 idle 对账为 cancelled 并释放写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks)
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: new Error("MessageAbortedError") })
  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "cancelled")

  await locks.acquire("other", { kind: "unknown-write" })
  locks.release("other")
  runtime.dispose()
})

test("Agent 并发槽位按父 Session FIFO 调度", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
    monitorIntervalMs: 1000,
  })

  const first = JSON.parse(await runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const second = JSON.parse(await runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  assert.equal(client.prompts[0].sessionID, first.sessionID)

  client.complete(first.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(client.prompts.length, 2)
  assert.equal(client.prompts[1].sessionID, second.sessionID)
  runtime.dispose()
})

test("group watch freezes its selection and returns each new completion without repeating consumed receipts", { timeout: 2_000 }, async (t) => {
  const { client, runtime, tasks: [first, second] } = await makeInspectionRuntime(t, { monitorIntervalMs: 1000 }, 2)
  const watching = runtime.handle({ action: "watch", timeoutMs: 1000 }, { sessionID: "parent", messageID: "first-watch" })
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const third = JSON.parse(await runtime.startAgent({ task: "third", agent: "worker", permissionOverlay: { "*": "deny" } },
    { sessionID: "parent", agent: "orchestrator", directory: process.cwd() }))
  client.complete(first.sessionID, client.prompts.find((call) => call.sessionID === first.sessionID).body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  const watched = JSON.parse(await watching)
  assert.equal(watched.reason, "actionable")
  assert.deepEqual(new Map(watched.tasks.map((task) => [task.taskID, task.status])), new Map([
    [first.taskID, "completed"], [second.taskID, "running"],
  ]))
  assert.equal(watched.tasks[0].output, undefined)
  assert.equal(watched.tasks.some((task) => task.taskID === third.taskID), false)
  assert.ok((await internalTask(runtime, first.taskID)).receipt.acknowledgedAt !== undefined)

  const selection = { action: "watch", taskIDs: [first.taskID, second.taskID] }
  const unchanged = JSON.parse(await runtime.handle({ ...selection, timeoutMs: 10 }, { sessionID: "parent", messageID: "unchanged-watch" }))
  assert.equal(unchanged.reason, "heartbeat", "the first receipt and its acknowledgement revision must not wake the same selection again")
  const next = runtime.handle({ ...selection, timeoutMs: 1000 }, { sessionID: "parent", messageID: "second-watch" })
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(second.sessionID, client.prompts.find((call) => call.sessionID === second.sessionID).body.messageID, "second result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: second.sessionID })
  const changed = JSON.parse(await next)
  assert.equal(changed.reason, "actionable")
  assert.equal(changed.tasks.find((task) => task.taskID === second.taskID).output, undefined)
  assert.equal(changed.tasks.every((task) => task.status === "completed"), true)
  assert.equal(JSON.parse(await runtime.handle(selection, { sessionID: "parent", messageID: "all-consumed" })).reason, "empty")
  await runtime.cancel({ taskID: third.taskID }, { sessionID: "parent" })
})

test("watch immediately returns an existing undelivered completion alongside a running Task", async (t) => {
  const { client, runtime, tasks: [first, second] } = await makeInspectionRuntime(t, undefined, 2)
  client.complete(first.sessionID, client.prompts[0].body.messageID, "already complete")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  const watched = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [first.taskID, second.taskID], timeoutMs: 10 },
    { sessionID: "parent", messageID: "first-delivery" }))
  assert.equal(watched.reason, "actionable")
  assert.deepEqual(watched.tasks.map((task) => task.status), ["completed", "running"])
  assert.equal(watched.tasks[0].output, undefined)
})

test("watch returns an initially blocked mixed selection immediately", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { monitorIntervalMs: 1000 })
  const blocked = JSON.parse(await runtime.startAgent({ task: "blocked", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const running = JSON.parse(await runtime.startAgent({ task: "running", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.observeEvent({ kind: "question-waiting", sessionID: blocked.sessionID })

  const watched = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [blocked.taskID, running.taskID] }, { sessionID: "parent" }))
  assert.equal(watched.reason, "actionable")
  assert.deepEqual(new Map(watched.tasks.map((task) => [task.taskID, task.status])), new Map([
    [blocked.taskID, "waiting_question"],
    [running.taskID, "running"],
  ]))
  await runtime.cancel({ taskID: blocked.taskID }, { sessionID: "parent" })
  await runtime.cancel({ taskID: running.taskID }, { sessionID: "parent" })
  runtime.dispose()
})

function commandWatchFixture(record) {
  const listeners = new Set()
  return {
    listeners,
    tasks: async () => [structuredClone(record)],
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    update: (patch) => { Object.assign(record, patch); for (const listener of listeners) listener() },
  }
}

test("one watch observes Agent and Command states, then excludes delivered Command completion", { timeout: 2_000 }, async (t) => {
  const { client, runtime, tasks: [agent] } = await makeInspectionRuntime(t)
  const command = { taskID: "command-mixed", kind: "command", ownerSessionID: "parent", status: "running", phase: "running", revision: 2, output: "private command text" }
  const commandWatch = commandWatchFixture(command)
  const context = { sessionID: "parent", messageID: "watch-mixed", callID: "watch", commandWatch }
  const watching = runtime.handle({ action: "watch", timeoutMs: 1000 }, context).then(JSON.parse)
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolve) => setImmediate(resolve))
  commandWatch.update({ status: "completed", phase: "completed", revision: 3, exitCode: 7, stopped: true, logComplete: false, logError: "disk full" })
  const watched = await watching
  assert.equal(watched.reason, "actionable")
  assert.deepEqual(watched.tasks.map((task) => [task.kind, task.status]), [["agent", "running"], ["command", "completed"]])
  assert.equal(watched.tasks[1].exitCode, 7)
  assert.equal(watched.tasks[1].logError, "disk full")
  assert.equal(watched.tasks[1].output, undefined)
  assert.equal(commandWatch.listeners.size, 0)
  client.messages.set("parent", deliveredWaitingWatchMessages(watched, context))
  const repeated = JSON.parse(await runtime.handle({ action: "watch", timeoutMs: 5 }, context))
  assert.equal(repeated.reason, "heartbeat")
  const commandOnly = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 5 }, context))
  assert.equal(commandOnly.reason, "empty")
  assert.deepEqual(commandOnly.tasks.map((task) => task.taskID), [command.taskID])
  assert.equal((await internalTask(runtime, agent.taskID)).status, "running")
  assert.deepEqual(client.aborts, [])
})

test("delivered stopped Command interruption becomes empty while an unconfirmed stop keeps watching", async (t) => {
  const { client, runtime } = await makeInspectionRuntime(t, undefined, 0)
  const command = { taskID: "command-interrupted", kind: "command", ownerSessionID: "parent", status: "interrupted", phase: "not-submitted", revision: 2, stopped: true }
  const commandWatch = commandWatchFixture(command)
  const context = { sessionID: "parent", messageID: "watch-interrupted", callID: "watch", commandWatch }
  for (const [state, expected] of [
    [{ status: "interrupted", phase: "not-submitted", stopped: true }, "empty"],
    [{ status: "unknown", phase: "stop-unconfirmed", stopped: false }, "heartbeat"],
  ]) {
    commandWatch.update(state)
    client.messages.set("parent", [])
    const initial = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 5 }, context))
    assert.equal(initial.reason, "actionable")
    client.messages.set("parent", deliveredWaitingWatchMessages(initial, context))
    const repeated = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 5 }, context))
    assert.equal(repeated.reason, expected)
    assert.equal(repeated.tasks[0].stopped, state.stopped)
    assert.equal(commandWatch.listeners.size, 0)
  }
})

test("Command diagnostic changes wake watch without a ledger revision and interrupt stalled delivery history", { timeout: 2_000 }, async (t) => {
  const { client, runtime, store } = await makeInspectionRuntime(t, undefined, 0)
  const command = { taskID: "command-diagnostic", kind: "command", ownerSessionID: "parent", status: "running", phase: "running", revision: 2, diagnostic: "SETTLEMENT_FAILED" }
  const commandWatch = commandWatchFixture(command)
  const context = { sessionID: "parent", messageID: "watch-diagnostic", callID: "watch", commandWatch }
  const initial = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [] }, context))
  assert.equal(initial.reason, "actionable")
  client.messages.set("parent", deliveredWaitingWatchMessages(initial, context))
  const waiting = runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 1000 }, context).then(JSON.parse)
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  commandWatch.update({ diagnostic: "OWNER_PERSISTENCE_FAILED" })
  const changed = await waiting
  assert.equal(changed.reason, "actionable")
  assert.equal(changed.tasks[0].diagnostic, "OWNER_PERSISTENCE_FAILED")
  assert.equal(changed.tasks[0].revision, initial.tasks[0].revision)

  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve([]))
  const messages = store.messages
  store.messages = () => { entered.resolve(); return release.promise }
  t.after(() => { store.messages = messages })
  const watching = runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 1000 }, context).then(JSON.parse)
  await entered.promise
  commandWatch.update({ diagnostic: "CANONICAL_PERSISTENCE_FAILED" })
  const interrupted = await watching
  assert.equal(interrupted.reason, "actionable")
  assert.equal(interrupted.tasks[0].diagnostic, "CANONICAL_PERSISTENCE_FAILED")
  assert.equal(commandWatch.listeners.size, 0)
  assert.deepEqual(client.aborts, [])
})

test("Command watch dedup requires a public complete state; Bash empty success is bound to canonical source", async (t) => {
  const { client, runtime } = await makeInspectionRuntime(t, undefined, 0)
  const command = {
    taskID: "command-bash-source", kind: "command", ownerSessionID: "parent", status: "completed", phase: "completed", revision: 3, exitCode: 0, stopped: true, logComplete: true,
    source: { sessionID: "parent", messageID: "bash-message", callID: "bash-call" },
  }
  const commandWatch = commandWatchFixture(command)
  const context = { sessionID: "parent", messageID: "watch-after-bash", callID: "watch", commandWatch }
  const initial = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [] }, context))
  for (const [label, change, expected] of [
    ["empty success", () => {}, "empty"],
    ["wrong source", (message) => { message.parts[0].callID = "another-call" }, "actionable"],
    ["host truncation", (message) => { message.parts[0].state.metadata.truncated = true }, "actionable"],
    ["private Part", (message) => { message.parts[0].private = true }, "actionable"],
    ["output has no state", (message) => { message.parts[0].tool = "o4e_task"; message.parts[0].state.input = { action: "output", taskID: command.taskID } }, "actionable"],
    ["nonzero hidden in metadata", (message) => { command.exitCode = 7; message.parts[0].state.metadata.o4eResult.exitCode = 7 }, "actionable"],
    ["exit absent from control", (message) => { command.exitCode = 7; message.parts[0].state.metadata.o4eResult.exitCode = 7; message.parts[0].state.output = "[O4E command completed]" }, "actionable"],
    ["metadata exit disagrees with canonical state", (message) => { command.exitCode = 7; message.parts[0].state.output = "[O4E command completed; exit=0]" }, "actionable"],
    ["control is not a complete line", (message) => { command.exitCode = 7; message.parts[0].state.output = "prefix [O4E command completed; exit=7] suffix" }, "actionable"],
    ["nonzero public control", (message) => { command.exitCode = 7; message.parts[0].state.metadata.o4eResult.exitCode = 7; message.parts[0].state.output = commandControlLines(command).join("\n") }, "empty"],
    ["log completeness unknown", () => { delete command.logComplete }, "actionable"],
    ["log failure hidden in metadata", (message) => {
      command.logComplete = false; command.logError = "disk full"
      Object.assign(message.parts[0].state.metadata.o4eResult, { logComplete: false, logError: "disk full" })
    }, "actionable"],
    ["log control omitted after visible exit", (message) => {
      command.exitCode = 7; command.logComplete = false; command.logError = "disk full"
      Object.assign(message.parts[0].state.metadata.o4eResult, { exitCode: 7, logComplete: false, logError: "disk full" })
      message.parts[0].state.output = "[O4E command completed; exit=7]"
    }, "actionable"],
    ["log failure public control", (message) => {
      command.logComplete = false; command.logError = "disk full"
      Object.assign(message.parts[0].state.metadata.o4eResult, { logComplete: false, logError: "disk full" })
      message.parts[0].state.output = commandControlLines(command).join("\n")
    }, "empty"],
  ]) {
    command.exitCode = 0
    command.logComplete = true
    delete command.logError
    const messages = deliveredWaitingWatchMessages(initial, context)
    messages[0].info.id = command.source.messageID
    messages[0].parts[0] = { type: "tool", tool: "bash", callID: command.source.callID, state: {
      status: "completed", input: { command: "true" }, output: "", metadata: { truncated: false, o4eResult: structuredClone(command) },
    } }
    change(messages[0])
    client.messages.set("parent", messages)
    const result = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 5 }, context))
    assert.equal(result.reason, expected, label)
    assert.equal(commandWatch.listeners.size, 0, label)
  }
})

test("Command watch reader abort, user message and owner revalidation clean subscriptions without cancelling execution", async (t) => {
  for (const interruption of ["reader-abort", "user-message", "owner-changed"]) await t.test(interruption, { timeout: 2_000 }, async (t) => {
    const { client, runtime } = await makeInspectionRuntime(t, undefined, 0)
    const command = { taskID: "command-interrupt", kind: "command", ownerSessionID: "parent", status: "running", phase: "running", revision: 2 }
    const commandWatch = commandWatchFixture(command)
    const controller = new AbortController()
    const watching = runtime.handle({ action: "watch", taskIDs: [], timeoutMs: 1000 }, {
      sessionID: "parent", commandWatch, abort: controller.signal,
    }).then((value) => ({ value: JSON.parse(value) }), (error) => ({ error }))
    while (!runtime.hasActiveWatch("parent")) await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    const failure = new Error(interruption)
    if (interruption === "reader-abort") controller.abort(failure)
    else if (interruption === "user-message") runtime.notifyUserMessagePersisted({ sessionID: "parent", messageID: "new-user-message" })
    else { commandWatch.tasks = async () => { throw failure }; commandWatch.update({}) }
    const result = await watching
    if (interruption === "user-message") assert.equal(result.value.reason, "user-message")
    else assert.equal(result.error, failure)
    assert.equal(commandWatch.listeners.size, 0)
    assert.equal(command.status, "running")
    assert.equal(runtime.hasActiveWatch("parent"), false)
    assert.deepEqual(client.aborts, [])
  })
})

test("watch skips a publicly delivered waiting revision across calls and recovery, then returns a new request", { timeout: 2_000 }, async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t)
  const request = (requestID) => ({ kind: "question", sessionID: task.sessionID, requestID, question: { questions: [] } })
  await runtime.observeEvent({ kind: "question-waiting", sessionID: task.sessionID, request: request("question-1") })
  const initial = JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID },
    { sessionID: "parent", messageID: "delivered-watch", callID: "prior-watch" }))
  assert.equal(initial.reason, "actionable")
  assert.equal(initial.tasks[0].status, "waiting_question")
  const context = { sessionID: "parent", messageID: "watch-again", callID: "current-watch" }
  for (const reason of ["actionable", "heartbeat", "user-message"]) {
    client.messages.set("parent", deliveredWaitingWatchMessages({ ...initial, reason }, context))
    const watched = JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 5 }, context))
    assert.equal(watched.reason, "heartbeat", `${reason} already exposed this waiting revision`)
    assert.equal(watched.tasks[0].revision, initial.tasks[0].revision)
  }

  runtime.dispose()
  const recovered = makeRuntime(client, process.cwd())
  t.after(() => { recovered.runtime.dispose(); recovered.delegation.dispose() })
  await recovered.runtime.recoverSession("parent")
  const unchanged = JSON.parse(await recovered.runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 5 }, context))
  assert.equal(unchanged.reason, "heartbeat", "the persisted public Part must survive a Runtime replacement")
  const watching = recovered.runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 1000 }, context)
  while (!recovered.runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await recovered.runtime.observeEvent({ kind: "question-waiting", sessionID: task.sessionID, request: request("question-2") })
  const changed = JSON.parse(await watching)
  assert.equal(changed.reason, "actionable")
  assert.equal(changed.tasks[0].status, "waiting_question")
  assert.ok(changed.tasks[0].revision > initial.tasks[0].revision)
  assert.deepEqual((await internalTask(recovered.runtime, task.taskID)).pendingRequests.map((entry) => entry.requestID), ["question-1", "question-2"])
  assert.equal(client.prompts.length, 1, "watch and recovery must not restart the child")
})

test("watch does not suppress waiting events using truncated, absent or mismatched public delivery text", async (t) => {
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: task.sessionID })
  const initial = JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID }, { sessionID: "parent" }))
  const context = { sessionID: "parent", messageID: "watch-again", callID: "current-watch" }
  for (const [label, change] of [
    ["host truncation", (part) => { part.state.metadata.truncated = true }],
    ["compaction", (part) => { part.state.time = { compacted: 123 } }],
    ["absent public text", (part) => { delete part.state.output }],
    ["missing status", (part) => { part.state.output = part.state.output.replace("waiting_question", "running") }],
    ["missing phase", (part) => { part.state.output = part.state.output.replace("question-waiting", "other-phase") }],
    ["missing revision", (part) => { part.state.output = part.state.output.replace(`Expected revision: ${initial.tasks[0].revision}`, "") }],
    ["private Part", (part) => { part.private = true }],
  ]) {
    const messages = deliveredWaitingWatchMessages(initial, context)
    change(messages[0].parts[0])
    client.messages.set("parent", messages)
    const watched = JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 5 }, context))
    assert.equal(watched.reason, "actionable", label)
    assert.equal(watched.tasks[0].revision, initial.tasks[0].revision, label)
  }
  client.messages.set("parent", deliveredWaitingWatchMessages(initial, context))
  assert.equal(JSON.parse(await runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 5 }, context)).reason, "heartbeat")
})

test("watch history I/O cannot delay a user message, new completion, reader abort or fixed deadline", async (t) => {
  for (const interruption of ["user-message", "new-terminal", "reader-abort", "deadline"]) await t.test(interruption, { timeout: 2_000 }, async (t) => {
    const { client, runtime, store, tasks: [waiting, running] } = await makeInspectionRuntime(t, undefined, 2)
    await runtime.observeEvent({ kind: "question-waiting", sessionID: waiting.sessionID })
    const prior = JSON.parse(await runtime.handle({ action: "watch", taskID: waiting.taskID }, { sessionID: "parent" }))
    const controller = new AbortController()
    const context = { sessionID: "parent", messageID: "watch-during-history-read", callID: "watch-history", abort: controller.signal }
    client.messages.set("parent", deliveredWaitingWatchMessages(prior, context))
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const messages = store.messages.bind(store)
    let historyReadFinished = false
    store.messages = async (sessionID, ...args) => {
      if (sessionID === "parent") {
        started.resolve()
        // The underlying host request remains pending even when its reader leaves.
        await release.promise
        historyReadFinished = true
      }
      return messages(sessionID, ...args)
    }
    t.after(() => { store.messages = messages; release.resolve() })
    const watching = runtime.handle({ action: "watch", taskIDs: [waiting.taskID, running.taskID],
      timeoutMs: interruption === "deadline" ? 10 : 1000, ioTimeoutMs: 1000 }, context)
      .then((value) => ({ value: JSON.parse(value) }), (error) => ({ error }))
    await started.promise
    assert.equal(runtime.hasActiveWatch("parent"), true)
    const startedAt = performance.now()
    const abortReason = new Error("reader stopped during delivery history read")
    if (interruption === "user-message") {
      client.messages.get("parent").push({
        info: { id: "new-user-message", sessionID: "parent", role: "user" },
        parts: [{ type: "text", text: "Handle this new instruction first." }],
      })
      assert.ok(runtime.notifyUserMessagePersisted({ sessionID: "parent", messageID: "new-user-message" }) > 0)
    } else if (interruption === "new-terminal") {
      client.complete(running.sessionID, client.prompts.find((call) => call.sessionID === running.sessionID).body.messageID, "completed during history read")
      await runtime.observeEvent({ kind: "session-idle", sessionID: running.sessionID })
    } else if (interruption === "reader-abort") controller.abort(abortReason)
    const outcome = await watching
    assert.ok(performance.now() - startedAt < 1000, "watch must not wait for the full history I/O allowance")
    assert.equal(historyReadFinished, false, "return must not depend on releasing the host messages request")
    assert.equal(runtime.hasActiveWatch("parent"), false)
    assert.equal((await internalTask(runtime, waiting.taskID)).status, "waiting_question")
    assert.equal((await internalTask(runtime, waiting.taskID)).revision, prior.tasks[0].revision)
    const current = await internalTask(runtime, running.taskID)
    if (interruption === "reader-abort") {
      assert.equal(outcome.error, abortReason)
      assert.equal(current.status, "running")
    } else {
      assert.equal(outcome.error, undefined)
      assert.equal(outcome.value.reason, interruption === "user-message" ? "user-message" : "actionable")
      const selected = outcome.value.tasks.find((task) => task.taskID === running.taskID)
      assert.equal(selected.status, interruption === "new-terminal" ? "completed" : "running")
      if (interruption === "new-terminal") {
        assert.equal(selected.output, undefined)
        assert.ok(current.receipt.acknowledgedAt !== undefined)
      } else if (interruption === "deadline") {
        const repeated = outcome.value.tasks.find((task) => task.taskID === waiting.taskID)
        assert.equal(repeated.status, "waiting_question", "missing delivery evidence must not hide the waiting event")
        assert.equal(repeated.revision, prior.tasks[0].revision)
        assert.equal(current.receipt, undefined)
      }
    }
    assert.deepEqual(client.aborts, [])
    assert.equal(client.prompts.length, 2)
    release.resolve()
  })
})

test("explicit empty watch selection stays empty instead of falling back to the owner group", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const created = JSON.parse(await runtime.startAgent({ task: "not selected", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const watched = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [] }, { sessionID: "parent" }))
  assert.equal(watched.reason, "empty")
  assert.deepEqual(watched.tasks, [])
  await runtime.cancel({ taskID: created.taskID }, { sessionID: "parent" })
  runtime.dispose()
})

test("omitted watch excludes a durably acknowledged completed Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const completed = JSON.parse(await runtime.startAgent({ task: "delivered", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(completed.sessionID, client.prompts[0].body.messageID, "delivered result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: completed.sessionID })
  await runtime.handle({ action: "output", taskID: completed.taskID }, { sessionID: "parent", messageID: "assistant-output" })
  const pending = JSON.parse(await runtime.handle({ action: "watch" }, { sessionID: "parent" }))
  assert.equal(pending.reason, "empty")
  assert.deepEqual(pending.tasks, [])
  const explicit = JSON.parse(await runtime.handle({ action: "watch", taskID: completed.taskID }, { sessionID: "parent" }))
  assert.equal(explicit.reason, "empty")
  assert.equal(explicit.tasks[0].output, undefined)
  runtime.dispose()
})

test("默认 watch 到期对账期间由持久化用户消息优先唤醒", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let now = 0
  const timers = []
  const clock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => { timer.cleared = true },
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { clock })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.sessions.get(response.sessionID).metadata.o4e.task.status !== "running") {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }

  let settled = false
  const watching = runtime.handle({ action: "watch" }, { sessionID: "parent" }).then((value) => {
    settled = true
    return JSON.parse(value)
  })
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const originalGet = client.session.get
  let releaseHeartbeatRead
  let heartbeatReadStarted = false
  const heartbeatRead = new Promise((resolvePromise) => { releaseHeartbeatRead = resolvePromise })
  client.session.get = async (request) => {
    if (request.path.id === "parent" && !heartbeatReadStarted) {
      heartbeatReadStarted = true
      await heartbeatRead
    }
    return originalGet(request)
  }
  now += timers[0].delay
  timers[0].callback()
  while (!heartbeatReadStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  assert.equal(settled, false)
  assert.equal(runtime.hasActiveWatch("parent"), true)
  assert.equal(runtime.notifyUserMessagePersisted({ sessionID: "parent", messageID: "user-2" }), 0)
  releaseHeartbeatRead()
  const observed = await watching
  assert.equal(observed.reason, "user-message")
  assert.equal(observed.tasks[0].status, "running")
  assert.equal(client.aborts.length, 0)
  runtime.dispose()
})

test("watch 使用固定窗口，progress 不延长等待且刷新期间的新终态优先返回", async (t) => {
  for (const timeoutMs of [undefined, 0, 7_200_000, 25_000]) {
    await t.test(`timeoutMs=${timeoutMs}`, { timeout: 2_000 }, async (t) => {
      const client = new BackgroundClient()
      const root = process.cwd()
      client.addSession({ id: "parent", metadata: {} })
      let now = 0
      const timers = new Set()
      const clock = {
        now: () => now,
        setTimeout: (callback, delay) => {
          const timer = { callback, delay }
          timers.add(timer)
          return timer
        },
        clearTimeout: (timer) => { timers.delete(timer) },
      }
      const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), { clock })
      t.after(() => {
        runtime.dispose()
        delegation.dispose()
      })
      const response = JSON.parse(await runtime.startAgent(
        { task: "inspect", agent: "worker" },
        { sessionID: "parent", agent: "orchestrator", directory: root },
      ))
      while (client.sessions.get(response.sessionID).metadata.o4e.task.status !== "running") {
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
      }
      const windowMs = timeoutMs > 0 ? Math.min(timeoutMs, 3_600_000) : 1_800_000
      const completeDuringProgress = timeoutMs === 25_000
      const refreshStarted = Promise.withResolvers()
      const releaseRefresh = Promise.withResolvers()
      t.after(() => releaseRefresh.resolve())
      let holdRefresh = false
      let settled = false
      const watching = runtime.handle({ action: "watch", timeoutMs }, {
        sessionID: "parent", messageID: "fixed-window-watch",
        ...(completeDuringProgress ? { readWait: async (operation) => {
          if (holdRefresh) {
            holdRefresh = false
            refreshStarted.resolve()
            await releaseRefresh.promise
          }
          return operation()
        } } : {}),
      }).then((value) => {
        settled = true
        return JSON.parse(value)
      })
      while (timers.size === 0 && !settled) await new Promise((resolvePromise) => setImmediate(resolvePromise))
      assert.equal(settled, false)

      let sentProgress = false
      while (!settled) {
        const [timer] = timers
        assert.ok(timer)
        assert.ok(timer.delay > 0 && now + timer.delay <= windowMs)
        // A late progress wake must not extend the fixed watch deadline.
        if (!sentProgress && now + timer.delay === windowMs) {
          now = windowMs - 1
          holdRefresh = completeDuringProgress
          await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "retry" } })
          sentProgress = true
          if (completeDuringProgress) {
            await refreshStarted.promise
            client.complete(response.sessionID, client.prompts[0].body.messageID, "completed during progress refresh")
            await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
            releaseRefresh.resolve()
            await watching
          }
        } else {
          now += timer.delay
          timer.callback()
        }
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        if (now < windowMs && !completeDuringProgress) assert.equal(settled, false)
      }

      const observed = await watching
      assert.equal(sentProgress, true)
      assert.equal(observed.reason, completeDuringProgress ? "actionable" : "heartbeat")
      assert.equal(observed.waitedMs, completeDuringProgress ? windowMs - 1 : windowMs)
      assert.equal(observed.tasks[0].status, completeDuringProgress ? "completed" : "retrying")
      assert.equal(runtime.hasActiveWatch("parent"), false)
      assert.equal(timers.size, 0)
      assert.equal(client.aborts.length, 0)
      assert.equal(client.prompts.length, 1)
      assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }), [])
    })
  }
})

test("inspect handle 的 read deadline 覆盖入口 recovery 和授权 I/O，flush 仍等待真实 operation", async (t) => {
  for (const stage of ["recovery", "authorization"]) await t.test(stage, { timeout: 2_000 }, async (t) => {
    const reads = []
    const fixture = await makeInspectionRuntime(t, {
      inspectionReader: (request) => { reads.push(request); return { tail: "must not read" } },
    })
    const { client, tasks: [task] } = fixture
    let runtime = fixture.runtime
    if (stage === "recovery") {
      const reloaded = makeRuntime(client, process.cwd(), new ScopeLockManager(), {
        inspectionReader: (request) => { reads.push(request); return { tail: "must not read" } },
      })
      runtime = reloaded.runtime
      t.after(() => { runtime.dispose(); reloaded.delegation.dispose() })
    }
    const recoverSession = runtime.recoverSession.bind(runtime)
    let recoveries = 0
    runtime.recoverSession = (...args) => { recoveries += 1; return recoverSession(...args) }
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const get = client.session.get
    let held = false
    let readFinished = false
    client.session.get = async (request) => {
      if (request.path.id === "parent" && !held) {
        held = true
        started.resolve()
        await release.promise
        readFinished = true
      }
      return get(request)
    }
    t.after(() => { client.session.get = get; release.resolve() })
    const startedAt = performance.now()
    const inspecting = runtime.handle({ action: "inspect", taskID: task.taskID, ioTimeoutMs: 50 }, { sessionID: "parent" })
    const rejected = assert.rejects(inspecting, { name: "TaskReadTimeoutError" })
    await started.promise
    await rejected
    assert.ok(performance.now() - startedAt < 1_000, "entry I/O must not inherit the 5-second preview timeout")
    assert.equal(recoveries, stage === "recovery" ? 1 : 0)
    assert.equal(readFinished, false)
    assert.deepEqual(reads, [])

    let flushed = false
    const flushing = runtime.flush().then(() => { flushed = true })
    void flushing.catch(() => undefined)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(flushed, false, "timing out the caller must not untrack the admitted operation")
    release.resolve()
    await flushing
    assert.equal(readFinished, true)
    assert.equal(flushed, true)
    assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
    assert.deepEqual(client.aborts, [])
    assert.equal(client.prompts.length, 1)
  })
})

test("inspect resume 不可用时不得 fresh 读取，首次和已恢复 cursor 分别交给 reader", async (t) => {
  for (const [action, mode] of [
    ["inspect", "unsupported"],
    ["inspect", "unavailable"],
    ["inspect", "first"],
    ["inspect", "cursor"],
  ]) {
    await t.test(`${action}: ${mode}`, { timeout: 2_000 }, async (t) => {
      const reads = []
      const resolutions = []
      const { runtime, store, tasks: [task] } = await makeInspectionRuntime(t, {
        inspectionReader: (request) => { reads.push(request); return { tail: "safe preview", cursor: "next-cursor" } },
        inspectionCursorResolver: mode === "unsupported" ? undefined : (request) => {
          resolutions.push(request)
          return {
            cursors: mode === "cursor" ? { [request.taskIDs[0]]: "persisted-cursor" } : {},
            unavailable: mode === "unavailable" ? { [request.taskIDs[0]]: "resume-history-limit" } : {},
          }
        },
      })
      const args = { taskID: task.taskID }
      const context = { sessionID: "parent", messageID: "assistant-resume", callID: "resume-call" }
      const result = JSON.parse(await runtime.handle({ action, ...args, resume: true }, context))
      const preview = result
      assert.deepEqual(preview, {
        taskID: task.taskID, status: "running",
        ...(mode === "unsupported" ? { unavailable: "resume-unsupported-store" }
          : mode === "unavailable" ? { unavailable: "resume-history-limit" }
          : { tail: "safe preview", cursor: "next-cursor" }),
      })
      assert.equal(reads.length, ["first", "cursor"].includes(mode) ? 1 : 0)
      if (reads.length) assert.equal(reads[0].cursor, mode === "cursor" ? "persisted-cursor" : undefined)
      assert.equal(resolutions.length, mode === "unsupported" ? 0 : 1)
      if (resolutions.length) {
        const request = resolutions[0]
        assert.equal(request.store, store)
        assert.equal(request.sessionID, context.sessionID)
        assert.equal(request.messageID, context.messageID)
        assert.equal(request.callID, context.callID)
        assert.deepEqual(request.taskIDs, [task.taskID])
      }
      assert.equal(runtime.hasActiveWatch("parent"), false)
    })
  }
})

test("inspect resume 期间执行身份变化必须拒绝旧 tail", async (t) => {
  for (const [action, field] of [["inspect", "runGeneration"], ["inspect", "attemptNumber"]]) {
    await t.test(`${action}: ${field}`, { timeout: 2_000 }, async (t) => {
      const started = Promise.withResolvers()
      const resume = Promise.withResolvers()
      const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
        inspectionCursorResolver: (request) => { started.resolve(request); return resume.promise },
        inspectionReader: () => ({ tail: "old execution tail", cursor: "old-cursor", beforeCursor: "old-before" }),
      })
      t.after(() => resume.resolve({ cursors: {}, unavailable: {} }))
      const args = { taskID: task.taskID }
      const inspecting = runtime.handle({ action, ...args, resume: true }, {
        sessionID: "parent", messageID: "assistant-resume", callID: "resume-call",
      }).then(JSON.parse)
      void inspecting.catch(() => undefined)
      await started.promise
      const record = client.sessions.get(task.sessionID).metadata.o4e.task
      record[field] += 1
      record.revision += 1
      record.updatedAt += 1
      // A concurrent status call refreshes the live Task while resume still owns the old claim.
      assert.equal((await internalTask(runtime, task.taskID))[field], record[field])
      resume.resolve({ cursors: { [task.taskID]: "previous-execution-cursor" }, unavailable: {} })

      const result = await inspecting
      assert.deepEqual(result, {
        taskID: task.taskID, status: "running", gap: "execution-changed",
      })
      assert.equal(runtime.hasActiveWatch("parent"), false)
      assert.deepEqual(client.aborts, [])
      assert.equal(client.prompts.length, 1)
    })
  }
})

test("inspect 授权父 Session 和自身读取，拒绝持有 cursor 的 sibling/stranger 且不缓存公共投影", async (t) => {
  const calls = []
  const { client, runtime, store, tasks: [task, sibling] } = await makeInspectionRuntime(t, {
    inspectionReader: async (request) => {
      calls.push(request)
      return {
        tail: `preview ${calls.length}`,
        cursor: `cursor-${calls.length}`,
        taskID: "forged-task",
        status: "completed",
        result: { text: "not public" },
        receipt: { receiptID: "not public" },
        authorizationFingerprint: "not public",
      }
    },
  }, 2)
  client.addSession({ id: "stranger", metadata: {} })
  const args = { action: "inspect", taskID: task.taskID }
  const first = JSON.parse(await runtime.handle(args, { sessionID: "parent" }))
  assert.deepEqual(first, { taskID: task.taskID, status: "running", tail: "preview 1", cursor: "cursor-1" })
  const own = JSON.parse(await runtime.handle({ ...args, cursor: first.cursor, direction: "backward" }, { sessionID: task.sessionID }))
  assert.deepEqual(own, { taskID: task.taskID, status: "running", tail: "preview 2", cursor: "cursor-2" })
  assert.equal(calls[0].store, store)
  assert.equal(calls[0].record.taskID, task.taskID)
  assert.equal(calls[0].record.childSessionID, task.sessionID)
  assert.equal(calls[0].directory, process.cwd())
  assert.equal(calls[0].maxBytes, 1024)
  assert.equal(calls[1].cursor, first.cursor)
  assert.equal(calls[1].direction, "backward")

  for (const sessionID of [sibling.sessionID, "stranger"]) {
    await assert.rejects(runtime.handle({ ...args, cursor: first.cursor }, { sessionID }), /无权读取 Task/)
    assert.equal(calls.length, 2, sessionID)
  }
  const fresh = JSON.parse(await runtime.handle(args, { sessionID: "parent" }))
  assert.deepEqual(fresh, { taskID: task.taskID, status: "running", tail: "preview 3", cursor: "cursor-3" })
  assert.equal(calls.length, 3)
})

test("inspect 的 final-looking preview 不完成 running Task，也不消费 terminal receipt", async (t) => {
  const consuming = []
  const consumed = []
  const preview = { tail: '<task_result>{"status":"completed","output":"All done"}</task_result>', cursor: "final-looking" }
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
    inspectionReader: async () => preview,
    onTerminalReceiptConsuming: (event) => consuming.push(event),
    onTerminalReceiptConsumed: (event) => consumed.push(event),
  })
  const final = client.complete(task.sessionID, client.prompts[0].body.messageID, "validated output")
  client.sessions.get(task.sessionID).status = "busy"
  const runningLedger = structuredClone(client.sessions.get(task.sessionID).metadata.o4e)
  const runningGroup = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
  const args = { action: "inspect", taskID: task.taskID }
  const context = { sessionID: "parent", messageID: "assistant-inspect" }

  assert.deepEqual(JSON.parse(await runtime.handle(args, context)), { taskID: task.taskID, status: "running", ...preview })
  assert.deepEqual(client.sessions.get(task.sessionID).metadata.o4e, runningLedger)
  assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks, runningGroup)
  assert.equal(runningLedger.task.receipt, undefined)
  await assert.rejects(runtime.output({ taskID: task.taskID }, context), /尚未 completed/)

  client.sessions.get(task.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  await until(() => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts?.length > 0)
  const terminalLedger = structuredClone(client.sessions.get(task.sessionID).metadata.o4e)
  const terminalGroup = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
  assert.ok(terminalLedger.task.receipt)
  assert.equal(terminalLedger.task.receipt.acknowledgedAt, undefined)
  assert.deepEqual(JSON.parse(await runtime.handle(args, context)), { taskID: task.taskID, status: "completed", ...preview })
  assert.deepEqual(client.sessions.get(task.sessionID).metadata.o4e, terminalLedger)
  assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks, terminalGroup)
  assert.deepEqual(consuming, [])
  assert.deepEqual(consumed, [])
  assert.deepEqual((await runtime.pendingReceipts({ sessionID: "parent" })).map((receipt) => receipt.receiptID), [terminalLedger.task.receipt.receiptID])
  const output = await runtime.output({ taskID: task.taskID }, context)
  assert.equal(output.output, "validated output")
  assert.equal(output.messageID, final.info.id)
})

test("inspect/watch 的非法 Runtime 参数在调用 reader 前严格拒绝", async (t) => {
  const calls = []
  const { runtime, tasks: [task] } = await makeInspectionRuntime(t, {
    inspectionReader: async (request) => {
      calls.push(request)
      return { tail: "safe", cursor: "valid-cursor" }
    },
  })
  const context = { sessionID: "parent" }
  await assert.rejects(runtime.handle({ action: "inspect", taskID: task.taskID, maxBytes: 0 }, context), /inspect.maxBytes/)
  assert.equal(calls.length, 0)
  await assert.rejects(runtime.handle({ action: "watch", taskIDs: [task.taskID], cursors: new Map() }, context), /cursors.*not supported/)
  assert.equal(calls.length, 0)
  assert.equal(runtime.hasActiveWatch("parent"), false)
  for (const maxBytes of [4, 8192]) {
    assert.equal(JSON.parse(await runtime.handle({ action: "inspect", taskID: task.taskID, maxBytes }, context)).tail, "safe")
    assert.equal(calls.at(-1).maxBytes, maxBytes)
  }
  assert.equal(calls.length, 2)
})

test("watch heartbeat never reads inspection tails or resumes cursors", async (t) => {
  const { client, runtime, tasks } = await makeInspectionRuntime(t, {
    inspectionReader: () => { assert.fail("watch must not read output") },
    inspectionCursorResolver: () => { assert.fail("watch must not resolve output cursors") },
  }, 2)
  const watched = JSON.parse(await runtime.handle({ action: "watch", timeoutMs: 1 }, { sessionID: "parent" }))
  assert.equal(watched.reason, "heartbeat")
  for (const [index, task] of watched.tasks.entries()) {
    const record = await internalTask(runtime, tasks[index].taskID)
    assert.deepEqual(task, { taskID: record.taskID, kind: "agent", status: "running", phase: record.phase, revision: record.revision })
  }
  assert.equal(runtime.hasActiveWatch("parent"), false)
  assert.deepEqual(client.aborts, [])
})

test("inspect 读取期间 generation 或 attempt 变化丢弃旧 tail 并返回 execution-changed", async (t) => {
  for (const [action, field] of [["inspect", "runGeneration"], ["inspect", "attemptNumber"]]) {
    await t.test(`${action}: ${field}`, { timeout: 2_000 }, async (t) => {
      const started = Promise.withResolvers()
      const reading = Promise.withResolvers()
      const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
        inspectionReader: (request) => {
          started.resolve(request)
          return reading.promise
        },
      })
      t.after(() => reading.resolve({ tail: "stale tail", cursor: "stale-cursor" }))
      const args = { taskID: task.taskID }
      const inspecting = runtime.handle({ action, ...args }, { sessionID: "parent" }).then(JSON.parse)
      void inspecting.catch(() => undefined)
      const request = await started.promise
      const record = client.sessions.get(task.sessionID).metadata.o4e.task
      record[field] += 1
      record.revision += 1
      record.updatedAt += 1
      reading.resolve({ tail: "stale tail", cursor: "stale-cursor", beforeCursor: "stale-before" })

      const result = await inspecting
      const expected = { taskID: task.taskID, status: "running", gap: "execution-changed" }
      assert.deepEqual(result, expected)
      assert.equal((await internalTask(runtime, task.taskID))[field], request.record[field] + 1)
      assert.equal(request.signal.aborted, true)
      assert.equal(runtime.hasActiveWatch("parent"), false)
      assert.deepEqual(client.aborts, [])
    })
  }
})

test("watch 最终 ledger 复核挂起时响应 deadline/abort 且不消费 receipt", async (t) => {
  for (const interruption of ["deadline", "abort"]) await t.test(interruption, { timeout: 2_000 }, async (t) => {
    const finalRead = Promise.withResolvers()
    const releaseFinal = Promise.withResolvers()
    const consuming = []
    const consumed = []
    let expired = false
    const clock = {
      now: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(() => { expired = true; callback() }, delay),
      clearTimeout,
    }
    const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
      clock,
      onTerminalReceiptConsuming: (event) => consuming.push(event),
      onTerminalReceiptConsumed: (event) => consumed.push(event),
    })
    t.after(() => releaseFinal.resolve())
    const get = client.session.get
    let held = false
    let readFinished = false
    client.session.get = async (input) => {
      if (expired && input.path.id === "parent" && !held) {
        held = true
        finalRead.resolve()
        await releaseFinal.promise
        readFinished = true
      }
      return get(input)
    }
    const controller = new AbortController()
    const startedAt = performance.now()
    const watching = runtime.handle({ action: "watch", taskIDs: [task.taskID], timeoutMs: 1, ioTimeoutMs: 50 }, {
      sessionID: "parent", messageID: "assistant-final-read", abort: controller.signal,
    }).then((value) => ({ value }), (error) => ({ error }))
    await finalRead.promise
    client.complete(task.sessionID, client.prompts[0].body.messageID, "completed during final read")
    await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
    const receipt = structuredClone(client.sessions.get(task.sessionID).metadata.o4e.task.receipt)
    assert.ok(receipt?.receiptID)
    assert.equal(receipt.acknowledgedAt, undefined)
    const reason = new Error("abort during final ledger read")
    if (interruption === "abort") controller.abort(reason)
    const outcome = await watching
    if (interruption === "abort") assert.equal(outcome.error, reason)
    else assert.equal(outcome.error?.name, "TaskReadTimeoutError")
    assert.ok(performance.now() - startedAt < 1_000)
    assert.equal(readFinished, false)
    assert.equal(runtime.hasActiveWatch("parent"), false)
    assert.deepEqual(consuming, [])
    assert.deepEqual(consumed, [])
    releaseFinal.resolve()
    await runtime.flush()
    assert.equal(readFinished, true)
    assert.deepEqual(client.sessions.get(task.sessionID).metadata.o4e.task.receipt, receipt)
    const refReceipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts[0]
    assert.equal(refReceipt.receiptID, receipt.receiptID)
    assert.equal(refReceipt.receiptAcknowledgedAt, undefined)
    assert.deepEqual(client.aborts, [])
  })
})

test("终态 receipt 在无父 watcher 时通知一次，有父 watcher 时只解析 watch", async () => {
  const root = process.cwd()
  const idleClient = new BackgroundClient()
  idleClient.addSession({ id: "parent", metadata: {} })
  const notifications = []
  const { runtime: idleRuntime } = makeRuntime(idleClient, root, new ScopeLockManager(), {
    onTerminalReceipt: (event) => notifications.push(structuredClone(event)),
  })
  const idleTask = JSON.parse(await idleRuntime.startAgent({ task: "notify", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (idleClient.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  idleClient.complete(idleTask.sessionID, idleClient.prompts[0].body.messageID, "done")
  await idleRuntime.observeEvent({ kind: "session-idle", sessionID: idleTask.sessionID })
  while (notifications.length === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].taskID, idleTask.taskID)
  const receipts = await idleRuntime.pendingReceipts({ sessionID: "parent" })
  assert.equal(receipts[0].receiptID, notifications[0].receiptID)

  const watchedClient = new BackgroundClient()
  watchedClient.addSession({ id: "parent", metadata: {} })
  const watchedNotifications = []
  const { runtime: watchedRuntime } = makeRuntime(watchedClient, root, new ScopeLockManager(), {
    onTerminalReceipt: (event) => watchedNotifications.push(structuredClone(event)),
  })
  const watchedTask = JSON.parse(await watchedRuntime.startAgent({ task: "watch", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (watchedClient.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const watching = watchedRuntime.handle({ action: "watch", taskID: watchedTask.taskID, timeoutMs: 100 }, { sessionID: "parent" })
  while (!watchedRuntime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  // hasActiveWatch observes the outer claim; give the inner event waiter one
  // turn to attach before injecting completion so this test exercises wakeup,
  // not the fixed 30-minute fallback window.
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  watchedClient.complete(watchedTask.sessionID, watchedClient.prompts[0].body.messageID, "done")
  await watchedRuntime.observeEvent({ kind: "session-idle", sessionID: watchedTask.sessionID })
  const watched = JSON.parse(await watching)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(watched.reason, "actionable")
  assert.equal(watchedNotifications.length, 0)
  idleRuntime.dispose()
  watchedRuntime.dispose()
})

test("watch 返回 terminal Task 后持久化确认 receipt 且重载不再通知", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const task = JSON.parse(await first.runtime.startAgent(
    { task: "persist watch consumption", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const watching = first.runtime.handle(
    { action: "watch", taskID: task.taskID, timeoutMs: 100 },
    { sessionID: "parent", messageID: "assistant-watch-tool" },
  )
  while (!first.runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(task.sessionID, client.prompts[0].body.messageID, "done")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const watched = JSON.parse(await watching)

  assert.equal(watched.reason, "actionable")
  const acknowledged = await internalTask(first.runtime, task.taskID)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  const refReceipt = ref.receipts.find((receipt) => receipt.receiptID === acknowledged.receipt.receiptID)
  assert.equal(acknowledged.receipt.deliveredToMessageID, "assistant-watch-tool")
  assert.equal(Number.isSafeInteger(acknowledged.receipt.acknowledgedAt), true)
  assert.equal(refReceipt.receiptDeliveredToMessageID, "assistant-watch-tool")
  assert.equal(refReceipt.receiptAcknowledgedAt, acknowledged.receipt.acknowledgedAt)
  assert.deepEqual(await first.runtime.pendingReceipts({ sessionID: "parent" }), [])
  first.runtime.dispose()
  first.delegation.dispose()

  const notifications = []
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: (event) => notifications.push(structuredClone(event)),
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(notifications, [])
  assert.deepEqual(await second.runtime.pendingReceipts({ sessionID: "parent" }), [])
  second.runtime.dispose()
  second.delegation.dispose()
})

test("watch 等待已在途 terminal callback 后确认消费 receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const notifications = []
  const consumed = []
  let releaseCallback
  const callback = new Promise((resolvePromise) => { releaseCallback = resolvePromise })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: async (event) => {
      notifications.push(structuredClone(event))
      await callback
    },
    onTerminalReceiptConsumed: async (event) => consumed.push(structuredClone(event)),
  })
  const task = JSON.parse(await runtime.startAgent({ task: "terminal callback race", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(task.sessionID, client.prompts[0].body.messageID, "done")
  const terminal = runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  while (notifications.length === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  let watchSettled = false
  const watching = runtime.handle({ action: "watch", taskID: task.taskID, timeoutMs: 100 }, { sessionID: "parent" }).then((value) => {
    watchSettled = true
    return JSON.parse(value)
  })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(watchSettled, false)
  assert.equal(runtime.hasActiveWatch("parent", { taskIDs: [task.taskID] }), true)

  releaseCallback()
  await terminal
  const watched = await watching
  assert.equal(watched.reason, "actionable")
  assert.equal(consumed.length, 1)
  assert.equal(consumed[0].receiptID, notifications[0].receiptID)
  runtime.dispose()
})

test("watch 的 adapter consume callback 失败不撤销已持久化的直接消费", async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceiptConsumed: async () => { throw new Error("adapter cleanup failed") },
  })
  const controller = new AbortController()
  t.after(() => controller.abort(new Error("test cleanup")))
  const task = JSON.parse(await runtime.startAgent(
    { task: "consume despite adapter cleanup", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const watching = runtime.handle(
    { action: "watch", taskID: task.taskID, timeoutMs: 100 },
    { sessionID: "parent", messageID: "assistant-watch-cleanup-failure", abort: controller.signal },
  )
  while (!runtime.hasActiveWatch("parent")) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(task.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })

  const watched = JSON.parse(await watching)
  assert.equal(watched.reason, "actionable")
  const persisted = await internalTask(runtime, task.taskID)
  assert.equal(persisted.receipt.deliveredToMessageID, "assistant-watch-cleanup-failure")
  assert.equal(Number.isSafeInteger(persisted.receipt.acknowledgedAt), true)
  assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }), [])
  runtime.dispose()
})

test("watch presentation preflight fails before receipt transaction admission", async (t) => {
  const consumed = []
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
    onTerminalReceiptConsumed: (event) => consumed.push(event),
  })
  client.complete(task.sessionID, client.prompts[0].body.messageID, "undelivered output")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  let admitted = false
  await assert.rejects(runtime.handle({ action: "watch" }, {
    sessionID: "parent", messageID: "watch-preflight",
    readWait: (operation) => operation(),
    readCommit: () => { admitted = true },
    validateWatchResult: (result) => {
      assert.equal(result.tasks[0].output, undefined)
      throw new Error("presentation unavailable")
    },
  }), /presentation unavailable/)
  assert.equal(admitted, false)
  assert.deepEqual(consumed, [])
  assert.equal((await runtime.pendingReceipts({ sessionID: "parent" })).length, 1)
  assert.equal(runtime.hasActiveWatch("parent"), false)
  const watched = JSON.parse(await runtime.handle({ action: "watch" }, { sessionID: "parent", messageID: "watch-retry" }))
  assert.equal(watched.tasks[0].output, undefined)
  assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }), [])
})

test("watch keeps its preflighted result when a new generation starts during acknowledgement", async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
    onTerminalReceiptConsuming: async () => { entered.resolve(); await release.promise },
  })
  client.complete(task.sessionID, client.prompts[0].body.messageID, "original completed output")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const original = await internalTask(runtime, task.taskID)
  let checked
  const watching = runtime.handle({ action: "watch" }, {
    sessionID: "parent", messageID: "watch-old-generation",
    validateWatchResult: (result) => { checked = structuredClone(result) },
  })
  await entered.promise
  await runtime.input({ taskID: task.taskID, input: "continue", expectedRevision: original.revision }, { sessionID: "parent" })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(task.sessionID, client.prompts[1].body.messageID, "new generation output")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const current = await internalTask(runtime, task.taskID)
  assert.notEqual(current.runGeneration, original.runGeneration)
  release.resolve()
  const result = JSON.parse(await watching)
  assert.deepEqual(result, checked)
  assert.equal(result.tasks[0].output, undefined)
  const receipts = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(receipts.some((receipt) => receipt.receiptID === current.receipt.receiptID), true)
  assert.equal(receipts.some((receipt) => receipt.receiptID === original.receipt.receiptID), false)
})

test("watch acknowledgement 开始后跨过 deadline/abort 仍等待持久化并返回 actionable", async (t) => {
  for (const interruption of ["deadline", "abort"]) await t.test(interruption, { timeout: 2_000 }, async (t) => {
    const consumed = []
    const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
      onTerminalReceiptConsumed: (event) => consumed.push(event),
    })
    client.complete(task.sessionID, client.prompts[0].body.messageID, "done")
    await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(() => release.resolve())
    const update = client.session.update
    client.session.update = async (request) => {
      const receipt = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[task.taskID]?.receipts?.[0]
      if (request.path.id === "parent" && receipt?.receiptAcknowledgedAt !== undefined) {
        started.resolve()
        await release.promise
      }
      return update(request)
    }
    const acknowledge = runtime.acknowledgeReceipts.bind(runtime)
    let readSignal
    runtime.acknowledgeReceipts = (receiptIDs, context, messageID) => {
      readSignal = context.abort
      return acknowledge(receiptIDs, context, messageID)
    }
    const controller = new AbortController()
    let settled = false
    const watching = runtime.handle({ action: "watch", timeoutMs: 1, ioTimeoutMs: 50 }, {
      sessionID: "parent", messageID: "assistant-watch-commit", abort: controller.signal,
    }).then((value) => { settled = true; return JSON.parse(value) }, (error) => { settled = true; throw error })
    void watching.catch(() => undefined)
    await started.promise
    assert.equal(readSignal.aborted, false)
    if (interruption === "abort") controller.abort(new Error("abort after durable commit started"))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
    assert.equal(settled, false, "an admitted acknowledgement must not return before persistence completes")
    assert.equal(readSignal.aborted, interruption === "abort", "readCommit must close the deadline")
    assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts[0].receiptAcknowledgedAt, undefined)
    assert.deepEqual(consumed, [])
    release.resolve()

    const watched = await watching
    const persisted = await internalTask(runtime, task.taskID)
    assert.equal(watched.reason, "actionable")
    assert.deepEqual(watched.tasks, [{
      taskID: task.taskID, kind: "agent", status: "completed", revision: persisted.revision, phase: "completed",
    }])
    assert.equal(persisted.receipt.deliveredToMessageID, "assistant-watch-commit")
    assert.equal(Number.isSafeInteger(persisted.receipt.acknowledgedAt), true)
    const refReceipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts[0]
    assert.equal(refReceipt.receiptAcknowledgedAt, persisted.receipt.acknowledgedAt)
    assert.deepEqual(consumed.map((event) => event.receiptID), [persisted.receipt.receiptID])
    assert.deepEqual(await runtime.pendingReceipts({ sessionID: "parent" }), [])
    assert.equal(runtime.hasActiveWatch("parent"), false)
    assert.deepEqual(client.aborts, [])
  })
})

test("watch 等待 terminal delivery 时响应 deadline/abort 且不消费 receipt", async (t) => {
  for (const interruption of ["deadline", "abort"]) await t.test(interruption, { timeout: 2_000 }, async (t) => {
    const started = Promise.withResolvers()
    const callback = Promise.withResolvers()
    const consumed = []
    const consuming = []
    let callbackFinished = false
    const { client, runtime, tasks: [task] } = await makeInspectionRuntime(t, {
      onTerminalReceipt: async (event) => {
        started.resolve(event)
        await callback.promise
        callbackFinished = true
      },
      onTerminalReceiptConsuming: (event) => consuming.push(event),
      onTerminalReceiptConsumed: (event) => consumed.push(event),
    })
    t.after(() => callback.resolve())
    client.complete(task.sessionID, client.prompts[0].body.messageID, "done")
    await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
    const notification = await started.promise
    const controller = new AbortController()
    const startedAt = performance.now()
    const watching = runtime.handle({ action: "watch", taskIDs: [task.taskID], timeoutMs: 1, ioTimeoutMs: 50 }, {
      sessionID: "parent", messageID: "assistant-aborted-watch", abort: controller.signal,
    }).then((value) => ({ value }), (error) => ({ error }))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(runtime.hasActiveWatch("parent"), true)
    const reason = new Error("user cancelled delivery wait")
    if (interruption === "abort") controller.abort(reason)
    const outcome = await watching
    if (interruption === "abort") assert.equal(outcome.error, reason)
    else assert.equal(outcome.error?.name, "TaskReadTimeoutError")
    assert.ok(performance.now() - startedAt < 1_000)
    assert.equal(callbackFinished, false)
    assert.equal(runtime.hasActiveWatch("parent"), false)
    assert.deepEqual(consuming, [])
    assert.deepEqual(consumed, [])

    callback.resolve()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(callbackFinished, true)
    assert.deepEqual(consuming, [])
    assert.deepEqual(consumed, [])
    assert.deepEqual((await runtime.pendingReceipts({ sessionID: "parent" })).map((receipt) => receipt.receiptID), [notification.receiptID])
    const persisted = await internalTask(runtime, task.taskID)
    const refReceipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts[0]
    assert.equal(persisted.receipt.acknowledgedAt, undefined)
    assert.equal(refReceipt.receiptAcknowledgedAt, undefined)
    assert.deepEqual(client.aborts, [])
  })
})

test("多 Task watch 不被已经消费的 completed Task 永久短路", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const completedTask = JSON.parse(await runtime.startAgent({ task: "completed", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const runningTask = JSON.parse(await runtime.startAgent({ task: "running", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(completedTask.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: completedTask.sessionID })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.output({ taskID: completedTask.taskID }, { sessionID: "parent", messageID: "already-delivered" })

  const heartbeat = JSON.parse(await runtime.handle({
    action: "watch",
    taskIDs: [completedTask.taskID, runningTask.taskID],
    timeoutMs: 1,
  }, { sessionID: "parent" }))
  assert.equal(heartbeat.reason, "heartbeat")
  assert.deepEqual(new Set(heartbeat.tasks.map((task) => task.status)), new Set(["completed", "running"]))

  const watching = runtime.handle({
    action: "watch",
    taskIDs: [completedTask.taskID, runningTask.taskID],
    timeoutMs: 1000,
  }, { sessionID: "parent" })
  const completedWhileWatching = new Promise((resolvePromise, rejectPromise) => {
    setTimeout(() => {
      client.complete(runningTask.sessionID, client.prompts[1].body.messageID, "done too")
      runtime.observeEvent({ kind: "session-idle", sessionID: runningTask.sessionID }).then(resolvePromise, rejectPromise)
    }, 10)
  })
  const terminal = JSON.parse(await watching)
  await completedWhileWatching
  assert.equal(terminal.reason, "actionable")
  assert.deepEqual(terminal.tasks.map((task) => task.status), ["completed", "completed"])
  runtime.dispose()
})

test("插件重载后子 Session 仍可读取自身 Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { monitorIntervalMs: 1000 })
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: response.sessionID }))
  assert.equal(status.taskID, response.taskID)
  assert.equal(status.ownerSessionID, "parent")
  second.runtime.dispose()
})

test("后台 Task 只冻结父 Session 当前模型，retryable 错误等待显式决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const firstDispatch = client.prompts[0].body.messageID
  assert.deepEqual(client.prompts[0].body.model, { providerID: "provider", modelID: "primary" })
  client.fail(response.sessionID, firstDispatch, "retryable", { retryable: true })

  const error = { name: "APIError", data: { isRetryable: true } }
  const decision = await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error })
  assert.deepEqual(decision, { managed: true, ownerSessionID: "parent" })
  assert.equal(client.prompts.length, 1)
  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "model-error-retryable")
  assert.equal(status.attemptNumber, 1)
  assert.equal(status.retryRound, 0)
  assert.deepEqual(status.failedModelCandidates, [{ providerID: "provider", modelID: "primary" }])
  assert.deepEqual(status.currentModel, { providerID: "provider", modelID: "primary" })

  runtime.dispose()
})

test("后台 Task 有 fallback 候选时仍不自动切换模型", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary", "provider/fallback"],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "overloaded", { retryable: true })

  await runtime.observeEvent({ kind: "error", phase: "before-resolution", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })

  const waiting = await internalTask(runtime, response.taskID)
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.phase, "model-error-fallback-available")
  assert.equal(waiting.attemptNumber, 1)
  assert.equal(waiting.retryRound, 0)
  assert.deepEqual(waiting.currentModel, { providerID: "provider", modelID: "primary" })
  assert.deepEqual(waiting.failedModelCandidates, [{ providerID: "provider", modelID: "primary" }])
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("模型错误事件的 inspect 异常公开为 unknown 而不吞掉原因为 fallback", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const execution = {
    startTurn: ({ sessionID, messageID, agent: targetAgent, model, parts }) => client.session.promptAsync({ path: { id: sessionID }, body: { messageID, agent: targetAgent, model, parts } }),
    cancelTurn: async () => ({ acknowledged: true }),
    inspectTurn: async () => { throw new Error("inspection transport unavailable") },
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, models: ["provider/primary", "provider/fallback"] })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await runtime.observeEvent({ kind: "error", phase: "before-resolution", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })

  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "inspection-failed")
  assert.ok(status.diagnostics.some((entry) => entry.code === "inspection-failed" && entry.message.includes("inspection transport unavailable")))
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("非 APIError 与不可重试 APIError 都保留原因等待显式 resolve", async () => {
  for (const error of [
    { name: "ProviderAuthError", data: { message: "credential rejected" } },
    { name: "APIError", data: { message: "bad request", isRetryable: false } },
  ]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
    const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    client.messages.set(response.sessionID, [{
      info: { id: `error-${error.name}`, role: "assistant", parentID: client.prompts[0].body.messageID, error },
      parts: [],
    }])
    client.sessions.get(response.sessionID).status = "idle"

    await runtime.observeEvent({ kind: "error", phase: "before-resolution", sessionID: response.sessionID, error })

    const waiting = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
    assert.equal(waiting.status, "waiting_retry_decision")
    assert.equal(waiting.phase, "model-error-non-retryable")
    assert.match(waiting.retryDecision.error, new RegExp(error.data.message))
    assert.equal(client.prompts.length, 1)
    const stopped = JSON.parse(await runtime.handle({
      action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "stop",
    }, { sessionID: "parent" }))
    assert.equal(stopped.status, "failed")
    assert.equal(stopped.phase, "retry-stopped")
    runtime.dispose()
  }
})

test("observeEvent dispatch=false 的单一冻结模型错误仍等待显式决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })

  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } }, { dispatch: false })
  assert.equal(client.prompts.length, 1)
  const pending = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(pending.status, "waiting_retry_decision")
  assert.equal(pending.phase, "model-error-retryable")

  runtime.dispatchRecoverableTasks()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("observeEvent dispatch=false 延迟终态释放后的 queued Task 派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const first = JSON.parse(await runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const second = JSON.parse(await runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(first.sessionID, client.prompts[0].body.messageID, "done")

  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID }, { dispatch: false })
  assert.equal(client.prompts.length, 1)
  assert.equal(client.prompts.some((entry) => entry.sessionID === second.sessionID), false)

  runtime.dispatchRecoverableTasks()
  while (!client.prompts.some((entry) => entry.sessionID === second.sessionID)) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  runtime.dispose()
})

test("副作用 watermark 后的 retryable 模型错误等待 CAS resolve continue", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.deepEqual(await runtime.markSideEffectBeforeTool({ sessionID: "ordinary", tool: "edit", callID: "ordinary" }), { managed: false, watermarked: false })
  const watermarks = await Promise.all([
    runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" }),
    runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" }),
  ])
  assert.deepEqual(watermarks, [{ managed: true, watermarked: true }, { managed: true, watermarked: true }])
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable after write", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })

  const waiting = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.phase, "model-error-after-side-effect")
  assert.equal(client.prompts.length, 1)
  const continued = JSON.parse(await runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: waiting.revision,
    decision: "continue",
  }, { sessionID: "parent" }))
  assert.equal(continued.status, "running")
  assert.equal(continued.retryRound, 1)
  assert.equal(continued.attemptNumber, 2)
  assert.equal(continued.childSessionID, response.sessionID)
  assert.deepEqual(client.prompts[1].body.model, { providerID: "provider", modelID: "primary" })
  await assert.rejects(runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: waiting.revision,
    decision: "continue",
  }, { sessionID: "parent" }), /Task 当前不等待|revision 已变化/)
  runtime.dispose()
})

test("显式 resolve continue 不受自动 retry 预算替代决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "overloaded", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.retryRound, 0)
  const continued = JSON.parse(await runtime.handle({
    action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "continue",
  }, { sessionID: "parent" }))
  assert.equal(continued.status, "running")
  assert.equal(continued.retryRound, 1)
  runtime.dispose()
})

test("cancelling 或 unknown Task 拒绝迟到写工具", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const execution = {
    startTurn: ({ sessionID, messageID, agent: targetAgent, model, parts }) => client.session.promptAsync({ path: { id: sessionID }, body: { messageID, agent: targetAgent, model, parts } }),
    cancelTurn: async () => ({ acknowledged: false }),
    inspectTurn: async () => ({ state: "running" }),
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const unknown = JSON.parse(await runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  await assert.rejects(runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "late-edit" }), /不允许执行工具/)
  runtime.dispose()
})

test("cancel 赢得模型错误等待竞态后不会启动新回合", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let decisionClaimed
  let releaseDecision
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    const phase = request.body?.metadata?.o4e?.task?.phase
    const result = await originalUpdate(request)
    if (phase === "model-error-fallback-available") {
      decisionClaimed?.()
      await new Promise((resolve) => { releaseDecision = resolve })
    }
    return result
  }
  const claimed = new Promise((resolve) => { decisionClaimed = resolve })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
    legacyModelCandidates: [
      { providerID: "provider", modelID: "primary" },
      { providerID: "provider", modelID: "fallback" },
    ],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  const observing = runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  await claimed
  const cancelling = runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  releaseDecision()
  await Promise.all([observing, cancelling])
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("cancel 赢得 restart ledger 分离竞态后不会创建新 Attempt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))

  let ledgerPersisted
  let releaseLedger
  const persisted = new Promise((resolve) => { ledgerPersisted = resolve })
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    const task = request.body?.metadata?.o4e?.task
    if (task?.taskID === response.taskID && task.taskSessionID === request.path.id && task.taskSessionID !== response.sessionID && task.phase === "retry-restart-pending") {
      const result = await originalUpdate(request)
      ledgerPersisted()
      await new Promise((resolve) => { releaseLedger = resolve })
      return result
    }
    return originalUpdate(request)
  }
  const resolving = runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" })
  await persisted
  const cancelling = runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  releaseLedger()
  await Promise.all([resolving, cancelling])

  const status = await internalTask(runtime, response.taskID)
  assert.ok(status.status === "cancelling" || status.status === "cancelled" || status.status === "unknown")
  assert.deepEqual(status.attemptSessionIDs, [response.sessionID])
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("并发观察多候选模型错误只持久化一个显式决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
    legacyModelCandidates: [
      { providerID: "provider", modelID: "primary" },
      { providerID: "provider", modelID: "fallback" },
    ],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  const event = { kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } }

  await Promise.all([runtime.observeEvent(event), runtime.observeEvent(event)])

  assert.equal(client.prompts.length, 1)
  const status = await internalTask(runtime, response.taskID)
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "model-error-fallback-available")
  assert.equal(status.attemptNumber, 1)
  runtime.dispose()
})

test("resolve restart 创建新 Attempt，并忽略旧 Session 的迟到结果", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "write", callID: "call-write" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable after write", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))

  const restartedPublic = JSON.parse(await runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: waiting.revision,
    decision: "restart",
  }, { sessionID: "parent" }))
  const restarted = await internalTask(runtime, response.taskID)
  assert.equal(restarted.status, restartedPublic.status)
  assert.notEqual(restarted.childSessionID, response.sessionID)
  assert.deepEqual(restarted.attemptSessionIDs, [response.sessionID, restarted.childSessionID])
  assert.equal(restarted.retryRound, 1)

  client.complete(response.sessionID, client.prompts[0].body.messageID, "late old result")
  await runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  const stillRunning = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillRunning.status, "running")

  client.complete(restarted.childSessionID, client.prompts[1].body.messageID, "new result")
  await runtime.observeEvent({ kind: "message-updated", sessionID: restarted.childSessionID })
  const completed = JSON.parse(await runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(completed.status, "completed")
  assert.equal(completed.output, "new result")
  runtime.dispose()
})

test("共享 Scheduler 在 restart 后按新旧 Attempt Session 将事件交给存活 Runtime", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const schedulerKey = `background-restart-handoff-${Date.now()}-${Math.random()}`
  const locks = new ScopeLockManager()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, locks, {
    models: ["provider/primary"],
    limits,
    scheduler: createSharedBackgroundTaskScheduler(schedulerKey, limits),
  })
  const second = makeRuntime(client, root, locks, {
    models: ["provider/primary"],
    limits,
    scheduler: createSharedBackgroundTaskScheduler(schedulerKey, limits),
  })
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable after edit", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: waiting.revision,
    decision: "restart",
  }, { sessionID: "parent" }))
  assert.notEqual(restarted.childSessionID, response.sessionID)

  first.runtime.dispose()
  const oldAttempt = await second.runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  assert.equal(oldAttempt.managed, true)
  const running = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(running.status, "running")

  client.complete(restarted.childSessionID, client.prompts[1].body.messageID, "new result")
  const newAttempt = await second.runtime.observeEvent({ kind: "message-updated", sessionID: restarted.childSessionID })
  assert.equal(newAttempt.managed, true)
  const completed = JSON.parse(await second.runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(completed.status, "completed")
  assert.equal(completed.output, "new result")
  second.runtime.dispose()
})

test("插件重载保留 waiting retry decision，并可 CAS restart", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable after write", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await second.runtime.activateSession("parent")
  const recovered = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(recovered.status, "waiting_retry_decision")
  assert.equal(recovered.revision, waiting.revision)
  const restarted = JSON.parse(await second.runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: recovered.revision,
    decision: "restart",
  }, { sessionID: "parent" }))
  assert.equal(restarted.status, "running")
  assert.notEqual(restarted.childSessionID, response.sessionID)
  second.runtime.dispose()
})

test("插件重载会把已持久化但尚未 dispatch 的 fallback 转为显式决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary", "provider/fallback"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const child = client.sessions.get(response.sessionID)
  child.status = "idle"
  child.metadata.o4e.task.status = "retrying"
  child.metadata.o4e.task.phase = "model-fallback-pending"
  child.metadata.o4e.task.currentModel = { providerID: "provider", modelID: "fallback" }
  child.metadata.o4e.task.failedModelCandidates = [{ providerID: "provider", modelID: "primary" }]
  child.metadata.o4e.task.handledModelErrorAttempt = 1
  child.metadata.o4e.task.dispatchMessageID = "msg_fallback_pending"
  child.metadata.o4e.task.revision += 1
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary", "provider/fallback"] })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  const waiting = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.phase, "model-error-fallback-available")
  second.runtime.dispose()
})

test("queued Task 缺少冻结授权时可查询取消但始终保持隔离", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const fixture = addUnverifiableTask(client, { taskID: "o4e_task_unverifiable_queued" })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks)

  await runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const quarantined = JSON.parse(await runtime.handle({ action: "status", taskID: fixture.taskID }, { sessionID: fixture.ownerSessionID }))
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(client.prompts.length, 0)

  const cancelling = JSON.parse(await runtime.handle({ action: "cancel", taskID: fixture.taskID }, { sessionID: fixture.ownerSessionID }))
  assert.equal(cancelling.status, "cancelling")
  await runtime.observeEvent({ kind: "session-idle", sessionID: fixture.childSessionID })
  const persisted = client.sessions.get(fixture.childSessionID).metadata.o4e.task
  const ref = client.sessions.get(fixture.ownerSessionID).metadata.o4e.backgroundTasks.taskRefs[fixture.taskID]
  assert.equal(persisted.status, "unknown")
  assert.equal(persisted.phase, "authorization-unverifiable")
  assert.equal(persisted.receipt, undefined)
  assert.equal(ref.receipts, undefined)
  const cancelled = JSON.parse(await runtime.handle({ action: "status", taskID: fixture.taskID }, { sessionID: fixture.ownerSessionID }))
  assert.equal(cancelled.status, "unknown")
  assert.equal(cancelled.phase, "authorization-unverifiable")
  assert.ok(cancelled.cancellationRequestedAt)
  assert.deepEqual(client.aborts, [fixture.childSessionID])
  runtime.dispose()
})

test("受管 task 有指纹但缺少 ask 冻结字段时不会自动派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const requester = agent({ permission: { task: { "*": "deny", worker: "allow" } } })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    requester,
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await first.runtime.startAgent(
    { task: "active", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
    { toolName: "task", permissionApproved: true },
  ))
  const queued = JSON.parse(await first.runtime.startAgent(
    { task: "queued", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
    { toolName: "task", permissionApproved: true },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const delegation = client.sessions.get(queued.sessionID).metadata.o4e.delegation
  delete delegation.requesterPermissionAction
  delete delegation.requesterPermissionApproved
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    requester,
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const quarantined = JSON.parse(await second.runtime.handle({ action: "status", taskID: queued.taskID }, { sessionID: "parent" }))
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("queued Task 缺少冻结 trace 时恢复即隔离", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const options = { limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } }
  const first = makeRuntime(client, root, new ScopeLockManager(), options)
  const active = JSON.parse(await first.runtime.startAgent(
    { task: "active", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  const queued = JSON.parse(await first.runtime.startAgent(
    { task: "queued", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  delete client.sessions.get(queued.sessionID).metadata.o4e.delegation.trace
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), options)
  await second.runtime.activateSession("parent")
  const quarantined = await internalTask(second.runtime, queued.taskID)
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("queued Task 的 canonical delegation 关键字段篡改时恢复即隔离", async () => {
  const root = process.cwd()
  const mutations = [
    ["tampered targetAgent", (delegation) => { delegation.targetAgent = "other-worker" }],
    ["tampered sourceAgent", (delegation) => { delegation.sourceAgent = "alternate-orchestrator" }],
    ["tampered authorizationFingerprint", (delegation) => { delegation.authorizationFingerprint = "tampered-fingerprint" }],
    ["tampered effect", (delegation) => { delegation.effect = delegation.effect === "read" ? "unknown-write" : "read" }],
    ["tampered writeScopes", (delegation) => { delegation.writeScopes = ["/tampered"] }],
  ]
  for (const [label, mutate] of mutations) {
    const client = new BackgroundClient()
    client.addSession({ id: "parent", metadata: {} })
    const options = { limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } }
    const first = makeRuntime(client, root, new ScopeLockManager(), options)
    const active = JSON.parse(await first.runtime.startAgent(
      { task: "active", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    const queued = JSON.parse(await first.runtime.startAgent(
      { task: "queued", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    mutate(client.sessions.get(queued.sessionID).metadata.o4e.delegation)
    first.runtime.dispose()
    first.delegation.dispose()

    client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
    const second = makeRuntime(client, root, new ScopeLockManager(), options)
    await second.runtime.recoverSession("parent", { dispatch: true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const quarantined = await internalTask(second.runtime, queued.taskID)
    assert.equal(quarantined.status, "unknown", label)
    assert.equal(quarantined.phase, "authorization-unverifiable", label)
    assert.equal(client.prompts.length, 1, label)
    second.runtime.dispose()
    second.delegation.dispose()
  }
})

test("无效 toolName 的 queued Task 会 quarantine", async () => {
  const root = process.cwd()
  const client = new BackgroundClient()
  client.addSession({ id: "parent", metadata: {} })
  const options = {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  }
  const first = makeRuntime(client, root, new ScopeLockManager(), options)
  const active = JSON.parse(await first.runtime.startAgent(
    { task: "active", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  const queued = JSON.parse(await first.runtime.startAgent(
    { task: "queued", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const delegation = client.sessions.get(queued.sessionID).metadata.o4e.delegation
  delegation.toolName = "invalid-task-tool"
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), options)
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const quarantined = await internalTask(second.runtime, queued.taskID)
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("授权隔离的 active 写 Task 再次重载时恢复 admission 槽和 Scope Lock", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const legacy = addUnverifiableTask(client, {
    taskID: "o4e_task_quarantined_active_write",
    status: "running",
    phase: "model-running",
    effect: "unknown-write",
  })
  client.sessions.get(legacy.childSessionID).status = "busy"
  const options = { limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } }
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks, options)

  await first.runtime.recoverSession(legacy.ownerSessionID, { dispatch: false })
  const quarantined = await internalTask(first.runtime, legacy.taskID, legacy.ownerSessionID)
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(quarantined.attemptNumber, 1)
  first.runtime.dispose()
  first.delegation.dispose()
  firstLocks.clear()

  const secondLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, secondLocks, options)
  await second.runtime.recoverSession(legacy.ownerSessionID, { dispatch: false })

  const blocked = new AbortController()
  const waiting = secondLocks.acquire("other-writer", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  blocked.abort(new Error("quarantined write lock retained after reload"))
  await assert.rejects(waiting, /quarantined write lock retained after reload/)

  const next = JSON.parse(await second.runtime.startAgent(
    { task: "queued behind quarantined task", agent: "worker" },
    { sessionID: legacy.ownerSessionID, agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 0)
  assert.equal((await internalTask(second.runtime, next.taskID, legacy.ownerSessionID)).status, "queued")
  second.runtime.dispose()
  second.delegation.dispose()
  secondLocks.clear()
})

test("授权隔离 Task 的 Attempt 停止后只释放 admission 槽和 Scope Lock", async () => {
  const client = new BackgroundClient()
  useSparseStatusMap(client)
  const root = process.cwd()
  const legacy = addUnverifiableTask(client, {
    taskID: "o4e_task_quarantine_release",
    status: "running",
    phase: "model-running",
    effect: "unknown-write",
  })
  client.sessions.get(legacy.childSessionID).status = "busy"
  const locks = new ScopeLockManager()
  const options = { limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } }
  const first = makeRuntime(client, root, locks, options)
  await first.runtime.recoverSession(legacy.ownerSessionID, { dispatch: false })
  assert.equal((await internalTask(first.runtime, legacy.taskID, legacy.ownerSessionID)).phase, "authorization-unverifiable")

  const next = JSON.parse(await first.runtime.startAgent(
    { task: "queued behind quarantine", agent: "worker" },
    { sessionID: legacy.ownerSessionID, agent: "orchestrator", directory: root },
  ))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts.length, 0)

  client.sessions.get(legacy.childSessionID).status = "idle"
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: legacy.childSessionID })
  for (let index = 0; index < 20 && client.prompts.length < 1; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  const released = await internalTask(first.runtime, legacy.taskID, legacy.ownerSessionID)
  assert.equal(released.status, "unknown")
  assert.equal(released.phase, "authorization-unverifiable")
  assert.ok(released.endedAt)
  assert.equal(client.prompts[0].sessionID, next.sessionID)
  assert.equal(locks.has(`background-task:${legacy.taskID}`), false)
  first.runtime.dispose()
  first.delegation.dispose()
  locks.clear()

  const secondLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, secondLocks, options)
  await second.runtime.recoverSession(legacy.ownerSessionID, { dispatch: false })
  const reloaded = await internalTask(second.runtime, legacy.taskID, legacy.ownerSessionID)
  assert.equal(reloaded.status, "unknown")
  assert.equal(reloaded.phase, "authorization-unverifiable")
  assert.ok(reloaded.endedAt)
  assert.equal(secondLocks.has(`background-task:${legacy.taskID}`), false)
  second.runtime.dispose()
  second.delegation.dispose()
  secondLocks.clear()
})

test("授权隔离 Task 仅在全部历史 Attempt 停止后释放资源", async () => {
  const client = new BackgroundClient()
  useSparseStatusMap(client)
  const root = process.cwd()
  const legacy = addUnverifiableTask(client, {
    taskID: "o4e_task_quarantine_all_attempts",
    childSessionID: "current-attempt",
    status: "running",
    phase: "model-running",
    effect: "unknown-write",
  })
  const task = client.sessions.get(legacy.childSessionID).metadata.o4e.task
  task.attemptSessionIDs = ["old-attempt", "current-attempt"]
  task.requiresAllAttemptsStopped = false
  client.addSession({ id: "old-attempt", parentID: legacy.ownerSessionID, status: "busy", metadata: {} })
  client.sessions.get("current-attempt").status = "idle"
  const locks = new ScopeLockManager()
  const { runtime, delegation } = makeRuntime(client, root, locks)

  await runtime.recoverSession(legacy.ownerSessionID, { dispatch: false })
  let quarantined = await internalTask(runtime, legacy.taskID, legacy.ownerSessionID)
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(quarantined.endedAt, undefined)
  assert.equal(locks.has(`background-task:${legacy.taskID}`), true)

  client.sessions.get("old-attempt").status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: legacy.childSessionID })
  quarantined = await internalTask(runtime, legacy.taskID, legacy.ownerSessionID)
  assert.ok(quarantined.endedAt)
  assert.equal(locks.has(`background-task:${legacy.taskID}`), false)
  runtime.dispose()
  delegation.dispose()
})

test("不可验证 queued 写 Task 隔离后释放未派发 Scope Lock", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  const legacy = addUnverifiableTask(client, { taskID: "o4e_task_unverifiable_write", effect: "unknown-write" })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks)

  await first.runtime.recoverSession(legacy.ownerSessionID, { dispatch: true })
  const quarantined = await internalTask(first.runtime, legacy.taskID, legacy.ownerSessionID)
  assert.equal(quarantined.phase, "authorization-unverifiable")

  const second = makeRuntime(client, root, locks)
  const created = JSON.parse(await second.runtime.startAgent(
    { task: "new write", agent: "worker", writeScopes: ["."] },
    { sessionID: legacy.ownerSessionID, agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[0].sessionID, created.sessionID)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("不可验证 pending phase 不会被解释为当前格式自动派发", async () => {
  const root = process.cwd()
  const phase = "retry-restart-pending"
  const client = new BackgroundClient()
  const suffix = phase.replaceAll("-", "_")
  const legacy = addUnverifiableTask(client, {
    taskID: `o4e_task_unverifiable_${suffix}`,
    childSessionID: `unverifiable-child-${suffix}`,
    status: "retrying",
    phase,
    dispatchMessageID: `msg_unverifiable_${suffix}`,
  })
  const child = client.sessions.get(legacy.childSessionID)
  child.metadata.o4e.task.attemptNumber = 1
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary", "provider/fallback"] })

  await runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const quarantined = JSON.parse(await runtime.handle({ action: "status", taskID: legacy.taskID }, { sessionID: legacy.ownerSessionID }))
  assert.equal(quarantined.status, "unknown", phase)
  assert.equal(quarantined.phase, "authorization-unverifiable", phase)
  assert.equal(client.prompts.length, 0, phase)
  runtime.dispose()
})

test("插件重载会复用已创建但尚未记入 ledger 的 restart Attempt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable after write", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const child = client.sessions.get(response.sessionID)
  child.metadata.o4e.task.status = "retrying"
  child.metadata.o4e.task.phase = "retry-restart-pending"
  child.metadata.o4e.task.retryRound = 1
  child.metadata.o4e.task.currentModel = { providerID: "provider", modelID: "primary" }
  child.metadata.o4e.task.failedModelCandidates = []
  child.metadata.o4e.task.dispatchMessageID = "msg_restart_pending"
  child.metadata.o4e.task.retryDecision = {
    ...waiting.retryDecision,
    status: "resolved",
    decision: "restart",
    resolvedAt: Date.now(),
  }
  child.metadata.o4e.task.revision += 1
  const frozenDelegation = structuredClone(child.metadata.o4e.delegation)
  client.addSession({
    id: "existing-restart-attempt",
    parentID: "parent",
    directory: root,
    agent: "worker",
    permission: frozenDelegation.compiledPermission,
    metadata: {
      o4e: {
        kind: "delegation-attempt",
        delegation: {
          ...frozenDelegation,
          status: "running",
          requesterPermissionPattern: "worker",
          requesterPermissionAction: "allow",
          requesterPermissionApproved: false,
          toolName: "task",
          taskID: response.taskID,
          dispatchMessageID: "msg_restart_pending",
        },
      },
    },
  })
  first.runtime.dispose()
  const sessionCount = client.sessions.size

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const recovered = await internalTask(second.runtime, response.taskID)
  assert.equal(client.sessions.size, sessionCount + 1)
  assert.equal([...client.sessions.values()].filter((session) => session.metadata?.o4e?.kind === "delegation-attempt").length, 2)
  assert.equal(recovered.childSessionID, "existing-restart-attempt")
  assert.deepEqual(recovered.attemptSessionIDs, [response.sessionID, "existing-restart-attempt"])
  second.runtime.dispose()
})

test("restart crash window 的不完整 Attempt 不会被自动复用", async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const child = client.sessions.get(response.sessionID)
  child.metadata.o4e.task.status = "retrying"
  child.metadata.o4e.task.phase = "retry-restart-pending"
  child.metadata.o4e.task.retryRound = 1
  child.metadata.o4e.task.dispatchMessageID = "msg_incomplete_restart"
  child.metadata.o4e.task.retryDecision = { ...waiting.retryDecision, status: "resolved", decision: "restart", resolvedAt: Date.now() }
  child.metadata.o4e.task.revision += 1
  client.addSession({
    id: "incomplete-restart-attempt",
    parentID: "parent",
    directory: root,
    metadata: { o4e: { kind: "delegation-attempt", delegation: { taskID: response.taskID, dispatchMessageID: "msg_incomplete_restart" } } },
  })
  first.runtime.dispose()
  const promptCount = client.prompts.length
  const sessionCount = client.sessions.size

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"] })
  t.after(() => {
    second.runtime.dispose()
    second.delegation.dispose()
    first.delegation.dispose()
    locks.clear()
  })
  await second.runtime.activateSession("parent")
  await second.runtime.handle({ action: "watch", taskID: response.taskID, timeoutMs: 1000 }, { sessionID: "parent" })
  const unknown = await internalTask(second.runtime, response.taskID)
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.phase, "restart-attempt-unverifiable")
  assert.equal(unknown.requiresAllAttemptsStopped, true)
  assert.deepEqual(new Set(unknown.attemptSessionIDs), new Set([response.sessionID, "incomplete-restart-attempt"]))
  assert.equal(client.prompts.length, promptCount)
  assert.equal(client.sessions.size, sessionCount + 1)
  assert.notEqual(unknown.taskSessionID, response.sessionID)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, unknown.taskSessionID)
  const blocked = new AbortController()
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await Promise.resolve()
  blocked.abort(new Error("incomplete attempt remains locked"))
  await assert.rejects(waitingLock, /incomplete attempt remains locked/)
})

test("重载后 Agent 授权漂移会拒绝 resolve dispatch", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const readWorker = agent({
    name: "worker",
    type: "subagent",
    description: "worker",
    loadTools: ["read"],
    permission: { bash: "deny", edit: "deny", external_directory: "deny" },
    models: ["provider/primary"],
    backgroundTasks: { maxRetries: 1 },
  })
  const first = makeRuntime(client, root, new ScopeLockManager(), { worker: readWorker })
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  first.runtime.dispose()

  const expandedWorker = { ...readWorker, loadTools: ["read", "bash"], permission: { bash: "allow" } }
  const second = makeRuntime(client, root, new ScopeLockManager(), { worker: expandedWorker })
  await second.runtime.activateSession("parent")
  await assert.rejects(second.runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: waiting.revision,
    decision: "restart",
  }, { sessionID: "parent" }), /冻结授权与当前 Agent 配置不一致/)
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的历史 fallback pending 在 Agent 授权漂移时不派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const readWorker = agent({
    name: "worker",
    type: "subagent",
    description: "worker",
    loadTools: ["read"],
    permission: { bash: "deny", edit: "deny", external_directory: "deny" },
    models: ["provider/primary", "provider/fallback"],
    backgroundTasks: { maxRetries: 1 },
  })
  const first = makeRuntime(client, root, new ScopeLockManager(), { worker: readWorker })
  const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const child = client.sessions.get(response.sessionID)
  child.status = "idle"
  child.metadata.o4e.task.status = "retrying"
  child.metadata.o4e.task.phase = "model-fallback-pending"
  child.metadata.o4e.task.currentModel = { providerID: "provider", modelID: "fallback" }
  child.metadata.o4e.task.failedModelCandidates = [{ providerID: "provider", modelID: "primary" }]
  child.metadata.o4e.task.handledModelErrorAttempt = 1
  child.metadata.o4e.task.dispatchMessageID = "msg_fallback_after_reload"
  child.metadata.o4e.task.revision += 1
  first.runtime.dispose()

  const expandedWorker = { ...readWorker, loadTools: ["read", "bash"], permission: { bash: "allow" } }
  const second = makeRuntime(client, root, new ScopeLockManager(), { worker: expandedWorker })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(failed.status, "waiting_retry_decision")
  assert.equal(failed.phase, "model-error-fallback-available")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的 queued Task 在 Agent 授权漂移时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const readWorker = agent({
    name: "worker",
    type: "subagent",
    description: "worker",
    loadTools: ["read"],
    permission: { bash: "deny", edit: "deny", external_directory: "deny" },
    models: ["provider/primary"],
    backgroundTasks: { maxRetries: 1 },
  })
  const first = makeRuntime(client, root, new ScopeLockManager(), { worker: readWorker, limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const expandedWorker = { ...readWorker, loadTools: ["read", "bash"], permission: { bash: "allow" } }
  const second = makeRuntime(client, root, new ScopeLockManager(), { worker: expandedWorker, limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 } })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = await internalTask(second.runtime, queued.taskID)
  assert.equal(failed.status, "failed")
  assert.equal(failed.phase, "authorization-changed")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的 queued Task 在 Agent 名称已不存在时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const oldRequester = agent({ name: "orchestrator-plan", planProfile: true, planOverrides: { loadAgents: true }, loadAgents: ["*"] })
  const oldWorker = agent({
    name: "worker-plan",
    type: "all",
    planProfile: true,
    loadTools: ["read"],
    models: ["provider/primary"],
    backgroundTasks: { maxRetries: 1 },
  })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    requester: oldRequester,
    worker: oldWorker,
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const context = { sessionID: "parent", agent: "orchestrator-plan", directory: root }
  const active = JSON.parse(await first.runtime.startAgent({ task: "active", agent: "worker-plan" }, context))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker-plan" }, context))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const currentRequester = agent({ name: "orchestrator (plan)", planProfile: true, planOverrides: { loadAgents: true }, loadAgents: ["*"] })
  const currentWorker = agent({
    name: "worker (plan)",
    type: "all",
    planProfile: true,
    loadTools: ["read"],
    models: ["provider/primary"],
    backgroundTasks: { maxRetries: 1 },
  })
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    requester: currentRequester,
    worker: currentWorker,
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))

  const failed = await internalTask(second.runtime, queued.taskID)
  assert.equal(failed.status, "failed")
  assert.equal(failed.phase, "authorization-changed")
  assert.match(failed.diagnostics.at(-1).message, /发起 Agent.*orchestrator-plan/)
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的 queued Task 在发起 Agent 撤销委派时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    requester: agent({ loadAgents: [] }),
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = await internalTask(second.runtime, queued.taskID)
  assert.equal(failed.status, "failed")
  assert.equal(failed.phase, "authorization-changed")
  assert.match(failed.diagnostics.at(-1).message, /未明确允许|不再允许委派目标 Agent/)
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的 queued 受管 task 从 allow 收紧为 ask 时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    requester: agent({ permission: { task: { "*": "deny", worker: "allow" } } }),
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await first.runtime.startAgent(
    { task: "active", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
    { toolName: "task", permissionApproved: true },
  ))
  const queued = JSON.parse(await first.runtime.startAgent(
    { task: "queued", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
    { toolName: "task", permissionApproved: true },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    requester: agent({ permission: { task: { "*": "deny", worker: "ask" } } }),
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = await internalTask(second.runtime, queued.taskID)
  assert.equal(failed.status, "failed")
  assert.equal(failed.phase, "authorization-changed")
  assert.match(failed.diagnostics.at(-1).message, /未明确允许 task/)
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("重载后的 queued 受管 task 保留有效 ask 授权并拒绝宿主撤权", async () => {
  for (const source of ["agent", "session", "revoked-session"]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {}, ...(source === "agent" ? {} : {
      permission: [{ permission: "task", pattern: "worker", action: "ask" }],
    }) })
    const requester = agent({ permission: { task: { "*": "deny", worker: source === "agent" ? "ask" : "allow" } } })
    const first = makeRuntime(client, root, new ScopeLockManager(), {
      requester,
      limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
    })
    const active = JSON.parse(await first.runtime.startAgent(
      { task: "active", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
      { toolName: "task", permissionApproved: true },
    ))
    const queued = JSON.parse(await first.runtime.startAgent(
      { task: "queued", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
      { toolName: "task", permissionApproved: true },
    ))
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(client.sessions.get(queued.sessionID).metadata.o4e.task.requesterPermissionAction, "ask")
    assert.equal(client.sessions.get(queued.sessionID).metadata.o4e.task.requesterPermissionApproved, true)
    first.runtime.dispose()

    client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
    if (source === "revoked-session") client.sessions.get("parent").permission[0].action = "deny"
    const second = makeRuntime(client, root, new ScopeLockManager(), {
      requester,
      limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
    })
    await second.runtime.activateSession("parent")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const running = JSON.parse(await second.runtime.handle({ action: "status", taskID: queued.taskID }, { sessionID: "parent" }))
    assert.equal(running.status, source === "revoked-session" ? "failed" : "running")
    if (source === "revoked-session") assert.equal(running.phase, "authorization-changed")
    assert.equal(client.prompts.length, source === "revoked-session" ? 1 : 2)
    second.runtime.dispose()
  }
})

test("重载后的 queued Task 在发起 Agent 显式禁止 task 时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  client.complete(active.sessionID, client.prompts[0].body.messageID, "done")
  const second = makeRuntime(client, root, new ScopeLockManager(), {
    requester: agent({ permission: { task: "deny" } }),
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const failed = await internalTask(second.runtime, queued.taskID)
  assert.equal(failed.status, "failed")
  assert.equal(failed.phase, "authorization-changed")
  assert.match(failed.diagnostics.at(-1).message, /未明确允许 task/)
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("restart 主动分离 ledger，旧 Attempt 删除后可直接重载", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  assert.notEqual(restarted.taskSessionID, response.sessionID)
  assert.notEqual(restarted.taskSessionID, restarted.childSessionID)
  client.sessions.delete(response.sessionID)
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await second.runtime.activateSession("parent")
  const recovered = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(recovered.taskID, response.taskID)
  assert.equal(recovered.childSessionID, restarted.childSessionID)
  client.complete(restarted.childSessionID, client.prompts[1].body.messageID, "completed after ledger replacement")
  await second.runtime.observeEvent({ kind: "message-updated", sessionID: restarted.childSessionID })
  const completed = JSON.parse(await second.runtime.handle({ action: "output", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(completed.status, "completed")
  assert.equal(completed.output, "completed after ledger replacement")
  const canonical = client.sessions.get(restarted.taskSessionID).metadata.o4e
  assert.equal(canonical.delegation.status, "reported-completed")
  assert.deepEqual(canonical.delegation.result, {
    messageID: completed.messageID,
    partIDs: completed.partIDs,
  })
  second.runtime.dispose()
})

test("独立 ledger 的当前 Attempt 删除后持久化 unknown", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.childSessionID)

  await first.runtime.observeEvent({ kind: "deleted", sessionID: restarted.childSessionID })
  const unknown = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.phase, "missing-session")
  assert.equal(unknown.taskSessionID, restarted.taskSessionID)
  assert.equal(client.sessions.get(restarted.taskSessionID).metadata.o4e.task.phase, "missing-session")
  first.runtime.dispose()
})

test("owner 定向恢复不发现无父索引的 queued Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await first.runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const owner = client.sessions.get("parent")
  delete owner.metadata.o4e.backgroundTasks.taskRefs[queued.taskID]
  first.runtime.dispose()
  const promptCount = client.prompts.length

  const second = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  await assert.rejects(second.runtime.status({ taskID: queued.taskID }, { sessionID: "parent" }), /未找到 Task/)
  assert.equal(client.prompts.length, promptCount)
  second.runtime.dispose()
})

test("独立 ledger 丢失时不回退旧快照派发，并关联当前 Attempt fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks, { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()
  firstLocks.clear()
  const promptCount = client.prompts.length

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"] })
  await second.runtime.activateSession("parent")
  await new Promise((resolve) => setTimeout(resolve, 5))
  const unknown = await internalTask(second.runtime, response.taskID)
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.phase, "missing-ledger")
  assert.equal(unknown.childSessionID, restarted.childSessionID)
  assert.equal(client.prompts.length, promptCount)
  await assert.rejects(second.runtime.markSideEffectBeforeTool({ sessionID: restarted.childSessionID, tool: "edit", callID: "late-edit" }), /不允许执行工具/)
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  second.runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waitingLock
  locks.release("other")
})

test("全部 Task 快照丢失时从当前 Attempt 重建保守 tombstone", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks, { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  client.sessions.delete(response.sessionID)
  first.runtime.dispose()
  firstLocks.clear()
  const promptCount = client.prompts.length

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"] })
  await second.runtime.activateSession("parent")
  const unknown = await internalTask(second.runtime, response.taskID)
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.phase, "missing-ledger")
  assert.equal(unknown.childSessionID, restarted.childSessionID)
  assert.equal(client.prompts.length, promptCount)
  await assert.rejects(second.runtime.markSideEffectBeforeTool({ sessionID: restarted.childSessionID, tool: "edit", callID: "late-edit" }), /不允许执行工具/)
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  second.runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waitingLock
  locks.release("other")
})

test("missing-ledger tombstone 映射同一 Task 的全部 Attempt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 2 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit-1" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable one", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const firstWaiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const firstRestart = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: firstWaiting.revision, decision: "restart" }, { sessionID: "parent" }))
  await first.runtime.markSideEffectBeforeTool({ sessionID: firstRestart.childSessionID, tool: "edit", callID: "call-edit-2" })
  client.fail(firstRestart.childSessionID, client.prompts[1].body.messageID, "retryable two", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: firstRestart.childSessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const secondWaiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const secondRestart = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: secondWaiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(secondRestart.taskSessionID)
  first.runtime.dispose()

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 2 })
  await second.runtime.activateSession("parent")
  const unknown = await internalTask(second.runtime, response.taskID)
  assert.equal(unknown.status, "unknown")
  assert.equal(unknown.childSessionID, secondRestart.childSessionID)
  assert.deepEqual(new Set(unknown.attemptSessionIDs), new Set([response.sessionID, firstRestart.childSessionID, secondRestart.childSessionID]))
  for (const sessionID of unknown.attemptSessionIDs) {
    await assert.rejects(second.runtime.markSideEffectBeforeTool({ sessionID, tool: "edit", callID: `late-${sessionID}` }), /陈旧.*Attempt|不允许执行工具/)
  }
  client.sessions.get(response.sessionID).status = "busy"
  client.fail(secondRestart.childSessionID, client.prompts[2].body.messageID, "late failure")
  await second.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: secondRestart.childSessionID, error: new Error("late failure") })
  const stillUnknown = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillUnknown.status, "unknown")
  client.sessions.get(secondRestart.childSessionID).status = "busy"
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id !== secondRestart.childSessionID) client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  const cancelling = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelling.status, "cancelling")
  assert.deepEqual(new Set(client.aborts.slice(-3)), new Set(unknown.attemptSessionIDs))
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const stillCancelling = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillCancelling.status, "cancelling")
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  client.sessions.get(secondRestart.childSessionID).status = "idle"
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: secondRestart.childSessionID })
  const cancelled = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  await waitingLock
  locks.release("other")
  second.runtime.dispose()
})

test("missing-ledger 恢复拒绝其他 owner 借用已加载 Task 且保留原锁", async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime, delegation } = makeRuntime(client, root, locks)
  t.after(() => { runtime.dispose(); delegation.dispose() })
  const created = JSON.parse(await runtime.startAgent(
    { task: "retain owner", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  const original = structuredClone(client.sessions.get(created.sessionID).metadata.o4e.task)
  const ownerGroup = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
  const foreignRef = { ...ownerGroup.taskRefs[created.taskID], taskSessionID: "foreign-missing-ledger" }
  client.addSession({ id: "foreign", metadata: { o4e: { backgroundTasks: {
    ...ownerGroup, taskRefs: { [created.taskID]: foreignRef },
  } } } })
  const sessionCount = client.sessions.size

  await assert.rejects(runtime.recoverSession("foreign"), /Task owner 与父索引不一致/)

  assert.equal(client.sessions.size, sessionCount, "must reject before creating a foreign tombstone")
  assert.deepEqual(client.sessions.get(created.sessionID).metadata.o4e.task, original)
  assert.deepEqual(client.sessions.get("foreign").metadata.o4e.backgroundTasks.taskRefs[created.taskID], foreignRef)
  assert.equal(locks.has(`background-task:${created.taskID}`), true)
  assert.deepEqual(client.aborts, [])
})

test("missing-ledger 恢复读取 children 失败时中止而非构造不完整 tombstone", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()
  const originalChildren = client.session.children
  client.session.children = async ({ path }) => {
    if (path.id === "parent") throw new Error("temporary children failure")
    return originalChildren({ path })
  }

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await assert.rejects(second.runtime.activateSession("parent"), /temporary children failure/)
  second.runtime.dispose()
})

test("missing-ledger 取消失败后重试仍核验全部 Attempt", async () => {
  const client = new BackgroundClient()
  useSparseStatusMap(client)
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 2 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit-1" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable one", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const firstWaiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const firstRestart = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: firstWaiting.revision, decision: "restart" }, { sessionID: "parent" }))
  await first.runtime.markSideEffectBeforeTool({ sessionID: firstRestart.childSessionID, tool: "edit", callID: "call-edit-2" })
  client.fail(firstRestart.childSessionID, client.prompts[1].body.messageID, "retryable two", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: firstRestart.childSessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const secondWaiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const secondRestart = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: secondWaiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(secondRestart.taskSessionID)
  first.runtime.dispose()

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 2 })
  await second.runtime.activateSession("parent")
  let failOne = true
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id === firstRestart.childSessionID && failOne) return { data: false }
    if (path.id !== secondRestart.childSessionID) client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  const firstCancelPublic = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  const firstCancel = await internalTask(second.runtime, response.taskID)
  assert.equal(firstCancel.status, firstCancelPublic.status)
  assert.equal(firstCancel.status, "unknown")
  assert.equal(firstCancel.requiresAllAttemptsStopped, true)

  failOne = false
  client.aborts.length = 0
  const secondCancelPublic = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  const secondCancel = await internalTask(second.runtime, response.taskID)
  assert.equal(secondCancel.status, secondCancelPublic.status)
  assert.equal(secondCancel.status, "cancelling")
  assert.deepEqual(new Set(client.aborts), new Set(secondCancel.attemptSessionIDs))
  client.sessions.get(secondRestart.childSessionID).status = "idle"
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: secondRestart.childSessionID })
  const cancelled = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  second.runtime.dispose()
})

test("requiresAllAttemptsStopped 的陈旧 uncertain inspection 不会覆盖后到的 busy 证据", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  let inspectionMode = "recover"
  const execution = {
    startTurn: async () => undefined,
    cancelTurn: async () => ({ acknowledged: true }),
    inspectTurn: async ({ sessionID }) => {
      if (inspectionMode === "recover") return { state: "running" }
      if (inspectionMode === "uncertain") {
        if (sessionID === response.sessionID) throw new Error("temporary inspection failure")
        return { state: "idle" }
      }
      return sessionID === response.sessionID ? { state: "running" } : { state: "idle" }
    },
  }
  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 1, execution })
  await second.runtime.activateSession("parent")
  const cancellingPublic = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  const cancelling = await internalTask(second.runtime, response.taskID)
  assert.equal(cancelling.status, cancellingPublic.status)
  assert.equal(cancelling.status, "cancelling")
  assert.equal(cancelling.phase, "all-attempts-cancelling")
  assert.equal(cancelling.requiresAllAttemptsStopped, true)

  const originalUpdate = client.session.update
  let staleWriteStarted
  let releaseStaleWrite
  const staleWriteBlocked = new Promise((resolve) => { staleWriteStarted = resolve })
  client.session.update = async (request) => {
    const task = request.body?.metadata?.o4e?.task
    if (task?.taskID === response.taskID && task.phase === "cancel-unconfirmed" && !releaseStaleWrite) {
      const result = await originalUpdate(request)
      staleWriteStarted()
      await new Promise((resolve) => { releaseStaleWrite = resolve })
      return result
    }
    return originalUpdate(request)
  }

  inspectionMode = "uncertain"
  const stale = second.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await staleWriteBlocked
  inspectionMode = "busy"
  let newerSettled = false
  const newer = second.runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
    .finally(() => { newerSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(newerSettled, false)
  releaseStaleWrite()
  await Promise.all([stale, newer])

  const final = await internalTask(second.runtime, response.taskID)
  assert.equal(final.status, "cancelling")
  assert.equal(final.phase, "all-attempts-cancelling")
  assert.equal(final.requiresAllAttemptsStopped, true)
  assert.equal(final.cancellationRequestedAt, cancelling.cancellationRequestedAt)
  assert.equal(final.diagnostics.some((entry) => entry.code === "cancel-unconfirmed"), false)
  const persisted = client.sessions.get(final.taskSessionID).metadata.o4e.task
  assert.equal(persisted.status, "cancelling")
  assert.equal(persisted.phase, "all-attempts-cancelling")
  const blocked = new AbortController()
  const lockAttempt = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolve) => setImmediate(resolve))
  blocked.abort(new Error("still locked"))
  await assert.rejects(lockAttempt, /still locked/)
  client.session.update = originalUpdate
  second.runtime.dispose()
})

test("missing-ledger 取消失败后单 Attempt 完成不会释放锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  client.sessions.get(response.sessionID).status = "busy"
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id === response.sessionID) return { data: false }
    return { data: true }
  }
  const unknown = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  client.complete(restarted.childSessionID, client.prompts[1].body.messageID, "late completion")
  await second.runtime.observeEvent({ kind: "message-updated", sessionID: restarted.childSessionID })
  const stillUnknown = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillUnknown.status, "unknown")
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  second.runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waitingLock
  locks.release("other")
})

test("missing-ledger 当前 Attempt 删除仍等待全部 Attempt 停止", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  client.sessions.get(response.sessionID).status = "busy"
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id === response.sessionID) return { data: false }
    return { data: true }
  }
  const unknown = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(unknown.status, "unknown")
  client.sessions.delete(restarted.childSessionID)
  await second.runtime.observeEvent({ kind: "deleted", sessionID: restarted.childSessionID })
  const stillUnknown = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(stillUnknown.status, "unknown")
  assert.equal(stillUnknown.phase, "cancel-unconfirmed")
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  second.runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waitingLock
  locks.release("other")
})

test("父 Session 删除会取消并核验 missing-ledger 的全部 Attempt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id !== restarted.childSessionID) client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  await second.runtime.observeEvent({ kind: "deleted", sessionID: "parent" })
  const cancelling = await internalTask(second.runtime, response.taskID, restarted.childSessionID)
  assert.equal(cancelling.status, "cancelling")
  assert.deepEqual(new Set(client.aborts.slice(-2)), new Set(cancelling.attemptSessionIDs))
  let acquired = false
  const waitingLock = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  client.sessions.get(restarted.childSessionID).status = "idle"
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: restarted.childSessionID })
  const cancelled = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: restarted.childSessionID }))
  assert.equal(cancelled.status, "cancelled")
  await waitingLock
  locks.release("other")
  second.runtime.dispose()
})

test("父 Session 已缺失的 unknown missing-ledger 在重载后重试全量取消", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id === response.sessionID) throw new Error("temporary abort failure")
    return { data: true }
  }
  await second.runtime.observeEvent({ kind: "deleted", sessionID: "parent" })
  const unknown = await internalTask(second.runtime, response.taskID, restarted.childSessionID)
  assert.equal(unknown.status, "unknown")
  second.runtime.dispose()

  client.sessions.delete("parent")
  client.aborts.length = 0
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  const third = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await third.runtime.recoverSession(unknown.taskSessionID)
  assert.deepEqual(new Set(client.aborts), new Set(unknown.attemptSessionIDs))
  const cancelled = JSON.parse(await third.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: restarted.childSessionID }))
  assert.equal(cancelled.status, "cancelled")
  third.runtime.dispose()
})

test("owner 存在时重载继续核验 unknown missing-ledger 的全部 Attempt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    if (path.id === response.sessionID) throw new Error("temporary abort failure")
    return { data: true }
  }
  const unknownPublic = JSON.parse(await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  const unknown = await internalTask(second.runtime, response.taskID)
  assert.equal(unknown.status, unknownPublic.status)
  assert.equal(unknown.status, "unknown")
  second.runtime.dispose()

  client.aborts.length = 0
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  const third = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await third.runtime.activateSession("parent")
  assert.deepEqual(new Set(client.aborts), new Set(unknown.attemptSessionIDs))
  const cancelled = JSON.parse(await third.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  third.runtime.dispose()
})

test("取消标记写入后 ledger 丢失仍会在重载时全量取消", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    return { data: false }
  }
  const unknownPublic = JSON.parse(await first.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" }))
  const unknown = await internalTask(first.runtime, response.taskID)
  assert.equal(unknown.status, unknownPublic.status)
  assert.equal(unknown.status, "unknown")
  assert.ok(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].cancellationRequestedAt)
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  client.aborts.length = 0
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    client.sessions.get(path.id).status = "idle"
    return { data: true }
  }
  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  assert.deepEqual(new Set(client.aborts), new Set(unknown.attemptSessionIDs))
  const cancelled = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(cancelled.status, "cancelled")
  second.runtime.dispose()
})

test("终态 requiresAllAttemptsStopped Task 重载后不占用 admission 槽", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  client.sessions.delete(restarted.taskSessionID)
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"], maxRetries: 1 })
  await second.runtime.activateSession("parent")
  await second.runtime.handle({ action: "cancel", taskID: response.taskID }, { sessionID: "parent" })
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: restarted.childSessionID })
  const cancelled = await internalTask(second.runtime, response.taskID)
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.requiresAllAttemptsStopped, true)
  second.runtime.dispose()

  const third = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await third.runtime.activateSession("parent")
  const next = JSON.parse(await third.runtime.startAgent({ task: "next", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.at(-1).sessionID, next.sessionID)
  third.runtime.dispose()
})

test("Session 枚举达到恢复上限时 fail closed", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.session.list = async (request) => {
    const sessions = []
    sessions.length = request.query.limit
    return { data: sessions }
  }
  const store = new OpenCodeSessionStore(client, root)
  await assert.rejects(store.children("missing-owner"), /数量达到恢复上限 100000/)
})

test("Agent Task input 要求父 Session CAS revision，并排队续用同一子 Session", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const before = await internalTask(runtime, response.taskID)
  const input = JSON.parse(await runtime.handle({ action: "input", taskID: response.taskID, input: "text", expectedRevision: before.revision }, { sessionID: "parent" }))
  assert.equal(input.status, "running")
  assert.equal(input.pendingInputs[0].text, "text")
  assert.deepEqual(input.inputDelivery, {
    mode: "next-turn",
    queued: true,
    pending: true,
    currentTurnRunning: true,
    boundary: "after-current-turn",
    phase: "input-queued",
    revision: input.revision,
  })
  assert.equal(Object.hasOwn(input, "dispatchMessageID"), false)
  assert.equal(Object.hasOwn(input, "authorizationFingerprint"), false)
  await assert.rejects(runtime.handle({ action: "input", taskID: response.taskID, input: "stale", expectedRevision: before.revision }, { sessionID: "parent" }), /revision 已变化/)
  await assert.rejects(runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: 1, decision: "stop" }, { sessionID: response.sessionID }), /只有父 Session/)
  runtime.dispose()
})

test("Agent Task steer 在宿主确认后安排到下一可运行回合", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const calls = []
  const base = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: { ...base, steerTurn: async (request) => { calls.push(request); return { supported: true, accepted: true } } },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "steer", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(runtime, response.taskID)
  const oversizedInput = "x".repeat(TASK_INPUT_MAX_LENGTH + 1)
  const steered = JSON.parse(await runtime.handle({ action: "input", taskID: response.taskID, input: oversizedInput, delivery: "steer", expectedRevision: before.revision }, { sessionID: "parent" }))
  assert.equal(steered.inputDelivery.mode, "steer")
  assert.equal(steered.inputDelivery.pending, false)
  assert.equal(steered.inputDelivery.boundary, "next-runnable-turn")
  assert.equal(steered.inputDelivery.phase, "input-admitted")
  assert.equal(calls[0].sessionID, response.sessionID)
  assert.equal(calls[0].text.length, TASK_INPUT_MAX_LENGTH)
  assert.equal(calls[0].text, oversizedInput.slice(0, TASK_INPUT_MAX_LENGTH))
  runtime.dispose()
})

test("Agent Task steer 使用 revision CAS 拒绝并发重放", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const calls = []
  const base = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: { ...base, steerTurn: async (request) => {
      calls.push(request)
      await new Promise((resolve) => setImmediate(resolve))
      return { supported: true, accepted: true }
    } },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "steer race", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
  const before = await internalTask(runtime, response.taskID)
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => runtime.handle({
    action: "input", taskID: response.taskID, input: "same", delivery: "steer", expectedRevision: before.revision,
  }, { sessionID: "parent" })))
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
  assert.equal(calls.length, 1)
  runtime.dispose()
})

test("Agent Task steer 在权限漂移时拒绝输入且不向宿主新派发", async () => {
  const client = new BackgroundClient()
  const root = `${process.cwd()}/.steer-authorization-drift`
  client.addSession({ id: "parent", metadata: {} })
  const calls = []
  const worker = agent({
    name: "worker",
    type: "subagent",
    description: "worker",
    loadTools: ["read"],
    permission: { bash: "deny", edit: "deny", external_directory: "deny" },
  })
  const base = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    worker,
    execution: { ...base, steerTurn: async (request) => { calls.push(request); return { supported: true, accepted: true } } },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "steer", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await until(() => client.prompts.length === 1)
  const before = await internalTask(runtime, response.taskID)
  worker.loadTools = ["read", "bash"]
  worker.permission = { bash: "allow" }

  await assert.rejects(runtime.handle({
    action: "input", taskID: response.taskID, input: "do not steer", delivery: "steer", expectedRevision: before.revision,
  }, { sessionID: "parent" }), /冻结授权与当前 Agent 配置不一致/)

  assert.equal(calls.length, 0)
  const running = await internalTask(runtime, response.taskID)
  assert.equal(running.status, "running")
  assert.equal(running.activeInputs.length, 0)
  assert.equal(running.pendingInputs.length, 0)
  runtime.dispose()
})

test("Agent Task steer 在准入期间 Attempt revision 变化时不向宿主新派发", async () => {
  const client = new BackgroundClient()
  const root = `${process.cwd()}/.steer-revision-race`
  client.addSession({ id: "parent", metadata: {} })
  const calls = []
  const base = createOpenCodeAgentExecutionPort({ client, directory: root })
  const fixture = makeRuntime(client, root, new ScopeLockManager(), {
    execution: { ...base, steerTurn: async (request) => { calls.push(request); return { supported: true, accepted: true } } },
  })
  const response = JSON.parse(await fixture.runtime.startAgent({ task: "steer", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await until(() => client.prompts.length === 1)
  const before = await internalTask(fixture.runtime, response.taskID)
  const originalRevalidate = fixture.delegation.revalidateAttempt.bind(fixture.delegation)
  let changed = false
  fixture.delegation.revalidateAttempt = async (...args) => {
    const prepared = await originalRevalidate(...args)
    if (!changed) {
      changed = true
      const task = client.sessions.get(response.sessionID).metadata.o4e.task
      task.revision += 1
      task.attemptNumber += 1
      task.updatedAt += 1
    }
    return prepared
  }

  await assert.rejects(fixture.runtime.handle({
    action: "input", taskID: response.taskID, input: "stale steer", delivery: "steer", expectedRevision: before.revision,
  }, { sessionID: "parent" }), /steer.*变化|revision 已变化/i)
  assert.equal(calls.length, 0)
  fixture.runtime.dispose()
})

test("冷恢复 pending steer 先核验权限并保留正常幂等 messageID", async (t) => {
  for (const mode of ["accepted", "authorization-drift"]) await t.test(mode, async () => {
    const client = new BackgroundClient()
    const root = `${process.cwd()}/.recover-steer-${mode}`
    client.addSession({ id: "parent", metadata: {} })
    const readWorker = agent({
      name: "worker",
      type: "subagent",
      description: "worker",
      loadTools: ["read"],
      permission: { bash: "deny", edit: "deny", external_directory: "deny" },
    })
    const first = makeRuntime(client, root, new ScopeLockManager(), { worker: readWorker })
    const response = JSON.parse(await first.runtime.startAgent({ task: "steer", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    await until(() => client.prompts.length === 1)
    const pending = persistPendingSteer(client, response, `recover ${mode}`)
    first.runtime.dispose()
    first.delegation.dispose()

    const calls = []
    const base = createOpenCodeAgentExecutionPort({ client, directory: root })
    const worker = mode === "accepted" ? readWorker : { ...readWorker, loadTools: ["read", "bash"], permission: { bash: "allow" } }
    const second = makeRuntime(client, root, new ScopeLockManager(), {
      worker,
      execution: { ...base, steerTurn: async (request) => { calls.push(request); return { supported: true, accepted: true } } },
    })
    await second.runtime.recoverSession("parent", { dispatch: false })
    const recovered = await internalTask(second.runtime, response.taskID)

    assert.equal(calls.length, mode === "accepted" ? 1 : 0)
    if (mode === "accepted") {
      assert.equal(calls[0].messageID, pending.messageID)
      assert.equal(recovered.activeInputs.length, 0)
    } else {
      assert.equal(recovered.status, "running")
      assert.equal(recovered.pendingInputs.at(-1).text, `recover ${mode}`)
    }
    second.runtime.dispose()
    second.delegation.dispose()
  })
})

test("冷恢复 pending steer 在取消或 owner 缺失时不向宿主新派发", async (t) => {
  for (const mode of ["cancelling", "owner-missing"]) await t.test(mode, async () => {
    const client = new BackgroundClient()
    const root = `${process.cwd()}/.recover-steer-${mode}`
    client.addSession({ id: "parent", metadata: {} })
    const first = makeRuntime(client, root)
    const response = JSON.parse(await first.runtime.startAgent({ task: "steer", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    await until(() => client.prompts.length === 1)
    persistPendingSteer(client, response, `recover ${mode}`)
    if (mode === "cancelling") client.sessions.get(response.sessionID).metadata.o4e.task.cancellationRequestedAt = Date.now()
    else client.sessions.delete("parent")
    first.runtime.dispose()
    first.delegation.dispose()

    const calls = []
    const base = createOpenCodeAgentExecutionPort({ client, directory: root })
    const second = makeRuntime(client, root, new ScopeLockManager(), {
      execution: { ...base, steerTurn: async (request) => { calls.push(request); return { supported: true, accepted: true } } },
    })
    await second.runtime.recoverSession(mode === "owner-missing" ? response.sessionID : "parent", { dispatch: false })
    assert.equal(calls.length, 0)
    second.runtime.dispose()
    second.delegation.dispose()
  })
})

test("Agent Task 超长 input 在 queue 和未确认 steer 时持久化相同前缀", { timeout: 5000 }, async () => {
  const prefix = "x".repeat(TASK_INPUT_MAX_LENGTH)
  for (const mode of ["queue", "unsupported", "error"]) {
    const client = new BackgroundClient()
    const root = `${process.cwd()}/.input-boundary-${mode}`
    client.addSession({ id: "parent", metadata: {} })
    const base = createOpenCodeAgentExecutionPort({ client, directory: root })
    const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
      execution: { ...base, steerTurn: async ({ text }) => {
        assert.notEqual(mode, "queue", "queue must not call the host steer endpoint")
        assert.equal(text, prefix)
        if (mode === "error") throw new Error("host steer unavailable")
        return { supported: false }
      } },
    })
    try {
      const task = JSON.parse(await runtime.startAgent({ task: mode, agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
      for (let attempt = 0; attempt < 100 && client.prompts.length === 0; attempt++) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(client.prompts.length, 1)
      const before = await internalTask(runtime, task.taskID)
      const result = JSON.parse(await runtime.handle({
        action: "input", taskID: task.taskID, expectedRevision: before.revision,
        input: prefix + "TAIL_NOT_DELIVERED", delivery: mode === "queue" ? "queue" : "steer",
      }, { sessionID: "parent" }))
      assert.equal(result.inputDelivery.mode, "next-turn")
      assert.equal(result.inputDelivery.pending, true)
      assert.equal(result.pendingInputs[0].text, prefix)
      assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.pendingInputs[0].text, prefix)
      assert.equal(client.prompts.length, 1, "queued input must not interrupt or duplicate the current turn")
    } finally {
      runtime.dispose()
      delegation.dispose()
    }
  }
})

test("resume 对调度器中尚未获准的 queued Task 返回 queued 而非伪造 dispatch", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const first = JSON.parse(await runtime.startAgent({ task: "hold lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = JSON.parse(await runtime.startAgent({ task: "queued lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = await internalTask(runtime, second.taskID)
  assert.equal(queued.status, "queued")
  const resumed = JSON.parse(await runtime.handle({
    action: "resume", taskID: second.taskID, expectedRevision: queued.revision,
  }, { sessionID: "parent" }))
  assert.deepEqual(resumed.resume, { accepted: true, reason: "queued" })
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("resume 在 Runtime quiescing 或 disposed 时明确拒绝", { timeout: 5000 }, async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let releasePrompt
  let promptStarted
  const promptGate = new Promise((resolvePromise) => { releasePrompt = resolvePromise })
  const started = new Promise((resolvePromise) => { promptStarted = resolvePromise })
  const originalPromptAsync = client.session.promptAsync
  client.session.promptAsync = async (request) => {
    promptStarted()
    const result = await originalPromptAsync(request)
    await promptGate
    return result
  }
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  try {
    await runtime.startAgent({ task: "hold lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
    await started
    const second = JSON.parse(await runtime.startAgent({ task: "queued lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    const queued = await internalTask(runtime, second.taskID)
    const flushing = runtime.flush()
    const duringFlush = await runtime.resumeTask({ taskID: second.taskID, expectedRevision: queued.revision }, { sessionID: "parent" })
    assert.deepEqual(duringFlush.resume, { accepted: false, reason: "runtime-quiescing" })
    releasePrompt()
    await flushing

    runtime.dispose()
    const disposed = await runtime.resumeTask({ taskID: second.taskID, expectedRevision: queued.revision }, { sessionID: "parent" })
    assert.deepEqual(disposed.resume, { accepted: false, reason: "runtime-disposed" })
  } finally {
    releasePrompt()
    runtime.dispose()
    delegation.dispose()
  }
})

test("resume 在 dispatch suspension 期间拒绝派发 queued Task", { timeout: 5000 }, async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  let releaseOwnerRead
  let ownerReadStarted
  const ownerReadGate = new Promise((resolvePromise) => { releaseOwnerRead = resolvePromise })
  const ownerReadEntered = new Promise((resolvePromise) => { ownerReadStarted = resolvePromise })
  const originalGet = client.session.get
  let holdNextOwnerRead = false
  client.session.get = async (request) => {
    if (holdNextOwnerRead && request.path.id === "parent") {
      holdNextOwnerRead = false
      ownerReadStarted()
      await ownerReadGate
    }
    return originalGet(request)
  }
  try {
    const first = JSON.parse(await runtime.startAgent({ task: "hold lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const second = JSON.parse(await runtime.startAgent({ task: "queued lane", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    const queued = await internalTask(runtime, second.taskID)
    holdNextOwnerRead = true
    const recovering = runtime.recoverSession("parent", {
      dispatch: false,
      session: structuredClone(client.sessions.get("parent")),
    })
    await ownerReadEntered
    const suspended = await runtime.resumeTask({ taskID: second.taskID, expectedRevision: queued.revision }, { sessionID: "parent" })
    assert.deepEqual(suspended.resume, { accepted: false, reason: "dispatch-suspended" })
    releaseOwnerRead()
    await recovering
    assert.equal(client.prompts.length, 1)
    assert.equal(first.taskID !== second.taskID, true)
  } finally {
    releaseOwnerRead()
    client.session.get = originalGet
    runtime.dispose()
    delegation.dispose()
  }
})

test("Agent Task input 队列达到固定容量时拒绝而不推进 revision", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  let task = await internalTask(runtime, response.taskID)
  for (let index = 0; index < TASK_PENDING_INPUT_LIMIT; index += 1) {
    await runtime.handle({ action: "input", taskID: response.taskID, input: `input-${index}`, expectedRevision: task.revision }, { sessionID: "parent" })
    task = await internalTask(runtime, response.taskID)
  }
  const fullRevision = task.revision
  await assert.rejects(runtime.handle({
    action: "input",
    taskID: response.taskID,
    input: "overflow",
    expectedRevision: fullRevision,
  }, { sessionID: "parent" }), new RegExp(`达到上限 ${TASK_PENDING_INPUT_LIMIT}`))
  const unchanged = await internalTask(runtime, response.taskID)
  assert.equal(unchanged.revision, fullRevision)
  assert.equal(unchanged.pendingInputs.length, TASK_PENDING_INPUT_LIMIT)
  assert.equal(unchanged.pendingInputs.some((entry) => entry.text === "overflow"), false)
  runtime.dispose()
})

test("completed Agent Task input 重开同一子 Session并生成新的 dispatch 与 receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const firstDispatch = client.prompts[0].body.messageID
  client.complete(response.sessionID, firstDispatch, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while ((await internalTask(runtime, response.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const completed = await internalTask(runtime, response.taskID)
  const firstReceipt = completed.receipt.receiptID

  const responseSnapshot = JSON.parse(await runtime.handle({
    action: "input",
    taskID: response.taskID,
    input: "continue with the new instruction",
    expectedRevision: completed.revision,
  }, { sessionID: "parent" }))
  const queued = await internalTask(runtime, response.taskID)
  assert.equal(Object.hasOwn(responseSnapshot, "dispatchMessageID"), false)
  assert.ok(["queued", "starting", "running"].includes(queued.status))
  assert.equal(queued.childSessionID, response.sessionID)
  assert.equal(queued.runGeneration, 1)
  assert.notEqual(queued.dispatchMessageID, firstDispatch)
  assert.equal(queued.receipt, undefined)
  assert.deepEqual(responseSnapshot.inputDelivery, {
    mode: "next-turn",
    queued: true,
    pending: true,
    currentTurnRunning: false,
    boundary: "next-dispatch",
    phase: "input-queued",
    revision: responseSnapshot.revision,
  })

  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[1].sessionID, response.sessionID)
  assert.equal(client.prompts[1].body.messageID, queued.dispatchMessageID)
  assert.equal(client.prompts[1].body.parts[0].synthetic, true)
  assert.match(client.prompts[1].body.parts[0].text, /continue with the new instruction/)
  client.complete(response.sessionID, client.prompts[1].body.messageID, "second result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while ((await internalTask(runtime, response.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = await internalTask(runtime, response.taskID)
  assert.notEqual(second.receipt.receiptID, firstReceipt)
  assert.equal(second.receipt.generation, 1)
  const receipts = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.deepEqual(receipts.map((receipt) => receipt.receiptID), [firstReceipt, second.receipt.receiptID])
  runtime.dispose()
})

test("terminal continuation ledger 更新已提交但响应丢失时仍会派发下一 generation", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "continue after completion", expectedRevision: before.revision }, { sessionID: "parent" })

  const originalUpdate = client.session.update
  let responseLost = true
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.task?.phase === "input-queued" && responseLost) {
      responseLost = false
      await originalUpdate(request)
      throw new Error("continuation ledger response lost")
    }
    return originalUpdate(request)
  }
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const continuation = await internalTask(runtime, response.taskID)
  assert.equal(responseLost, false)
  assert.equal(continuation.runGeneration, 1)
  assert.match(client.prompts[1].body.parts[0].text, /continue after completion/)
  runtime.dispose()
})

test("dispatch claim 已提交但响应丢失时仍保留 active input 并启动回合", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const completed = await internalTask(runtime, response.taskID)

  const originalUpdate = client.session.update
  let responseLost = true
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID && request.body?.metadata?.o4e?.task?.phase === "input-starting" && responseLost) {
      responseLost = false
      await originalUpdate(request)
      throw new Error("dispatch claim response lost")
    }
    return originalUpdate(request)
  }
  await runtime.handle({ action: "input", taskID: response.taskID, input: "resume safely", expectedRevision: completed.revision }, { sessionID: "parent" })

  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const running = await internalTask(runtime, response.taskID)
  assert.equal(responseLost, false)
  assert.equal(running.status, "running")
  assert.equal(running.activeInputs[0].text, "resume safely")
  assert.deepEqual(running.pendingInputs, [])
  assert.match(client.prompts[1].body.parts[0].text, /resume safely/)
  runtime.dispose()
})

test("running Agent Task 完成时会先保留 receipt，再自动续跑 pending input", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const firstDispatch = client.prompts[0].body.messageID
  const before = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "recover after failure", expectedRevision: before.revision }, { sessionID: "parent" })

  client.complete(response.sessionID, firstDispatch, "first result")
  await runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const queued = await internalTask(runtime, response.taskID)
  assert.equal(queued.childSessionID, response.sessionID)
  assert.equal(queued.runGeneration, 1)
  assert.equal(client.prompts[1].sessionID, response.sessionID)
  assert.notEqual(client.prompts[1].body.messageID, firstDispatch)
  assert.equal(client.prompts[1].body.parts[0].synthetic, true)
  assert.match(client.prompts[1].body.parts[0].text, /recover after failure/)

  client.complete(response.sessionID, client.prompts[1].body.messageID, "recovered result")
  await runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  while ((await internalTask(runtime, response.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const completed = await internalTask(runtime, response.taskID)
  assert.equal(completed.receipt.generation, 1)
  const receipts = await runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(receipts.length, 2)
  assert.equal(receipts[0].status, "completed")
  assert.equal(receipts[1].receiptID, createTaskReceiptID(response.taskID, "completed", 1))
  const receiptRefs = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts
  assert.equal(receiptRefs.at(-1).receiptGeneration, 1)
  runtime.dispose()
})

test("terminal callback 失败且已完成 Task 立即续跑时仍按旧 receipt 重试", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const notifications = []
  let failures = 1
  const first = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: async (event) => {
      notifications.push(structuredClone(event))
      if (failures-- > 0) throw new Error("temporary callback failure")
    },
  })
  const response = JSON.parse(await first.runtime.startAgent({ task: "retry old receipt", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(first.runtime, response.taskID)
  await first.runtime.handle({ action: "input", taskID: response.taskID, input: "next generation", expectedRevision: before.revision }, { sessionID: "parent" })
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await first.runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const oldReceiptID = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts[0].receiptID
  first.runtime.dispose()
  first.delegation.dispose()
  const previousNotifications = notifications.filter((event) => event.receiptID === oldReceiptID).length

  const second = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: async (event) => notifications.push(structuredClone(event)),
  })
  await second.runtime.recoverSession("parent", { dispatch: false })
  assert.equal(notifications.filter((event) => event.receiptID === oldReceiptID).length, previousNotifications)
  await second.runtime.activateSession("parent")
  for (let attempt = 0; attempt < 100 && notifications.filter((event) => event.receiptID === oldReceiptID).length === previousNotifications; attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  assert.equal(notifications.filter((event) => event.receiptID === oldReceiptID).length, previousNotifications + 1)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("活跃 watch 不会吞掉已完成并立即续跑的前一 generation terminal receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const notifications = []
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    onTerminalReceipt: async (event) => notifications.push(structuredClone(event)),
  })
  const response = JSON.parse(await runtime.startAgent({ task: "watch across generation", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "continue next generation", expectedRevision: before.revision }, { sessionID: "parent" })
  const watching = runtime.handle({ action: "watch", taskID: response.taskID }, { sessionID: "parent" })
  while (!runtime.hasActiveWatch("parent", { taskIDs: [response.taskID] })) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "message-updated", sessionID: response.sessionID })
  while (client.prompts.length < 2 || notifications.length === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(notifications[0].bypassActiveWatch, true)
  assert.equal(notifications[0].receiptID, client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts[0].receiptID)
  assert.equal(JSON.parse(await watching).reason, "actionable")
  runtime.dispose()
})

test("显式 stop 丢弃旧输入且恢复或 resume 不复活；显式新 input 只启动新输入", { timeout: 5000 }, async (t) => {
  for (const restorePending of [false, true]) await t.test(`persisted pending: ${restorePending}`, async (t) => {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const first = makeRuntime(client, root, new ScopeLockManager(), { monitorIntervalMs: 60_000 })
    t.after(() => { first.runtime.dispose(); first.delegation.dispose() })
    const response = JSON.parse(await first.runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    while (client.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
    const running = await internalTask(first.runtime, response.taskID)
    await first.runtime.handle({ action: "input", taskID: response.taskID, input: "obsolete queued input", expectedRevision: running.revision }, { sessionID: "parent" })
    const queued = await internalTask(first.runtime, response.taskID)
    client.fail(response.sessionID, client.prompts[0].body.messageID)
    await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    const waiting = await internalTask(first.runtime, response.taskID)
    assert.equal(waiting.status, "waiting_retry_decision")
    await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "stop" }, { sessionID: "parent" })
    const stopped = await internalTask(first.runtime, response.taskID)
    assert.equal(stopped.status, "failed")
    assert.equal(stopped.phase, "retry-stopped")
    assert.deepEqual(stopped.pendingInputs, [])
    assert.deepEqual(stopped.activeInputs, [])
    assert.equal(stopped.runGeneration, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(client.prompts.length, 1)
    first.runtime.dispose()
    first.delegation.dispose()
    // A valid persisted stop record may contain old queued inputs. Its phase
    // must independently fence automatic continuation and explicit resume.
    if (restorePending) client.sessions.get(response.sessionID).metadata.o4e.task.pendingInputs = Array.from({ length: TASK_PENDING_INPUT_LIMIT }, () => structuredClone(queued.pendingInputs[0]))
    const second = makeRuntime(client, root, new ScopeLockManager(), { monitorIntervalMs: 60_000 })
    t.after(() => { second.runtime.dispose(); second.delegation.dispose() })
    await second.runtime.recoverSession("parent", { dispatch: false })
    await second.runtime.activateSession("parent")
    const recovered = await internalTask(second.runtime, response.taskID)
    assert.equal(recovered.status, "failed")
    const resumed = JSON.parse(await second.runtime.handle({ action: "resume", taskID: response.taskID, expectedRevision: recovered.revision }, { sessionID: "parent" }))
    assert.deepEqual(resumed.resume, { accepted: false, reason: "state-not-resumable" })
    assert.equal(client.prompts.length, 1)
    await second.runtime.handle({ action: "input", taskID: response.taskID, input: "explicit fresh input", expectedRevision: recovered.revision }, { sessionID: "parent" })
    while (client.prompts.length < 2) await new Promise((resolve) => setImmediate(resolve))
    assert.match(client.prompts[1].body.parts[0].text, /explicit fresh input/)
    assert.doesNotMatch(client.prompts[1].body.parts[0].text, /obsolete queued input/)
    const next = await internalTask(second.runtime, response.taskID)
    assert.equal(next.runGeneration, 1)
    assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts[0].receiptStatus, "failed")
  })
})

test("显式 continue 保留 pending input 到当前 generation 结束后再续跑", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
    legacyModelCandidates: [
      { providerID: "provider", modelID: "primary" },
      { providerID: "provider", modelID: "fallback" },
    ],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const before = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "next generation only", expectedRevision: before.revision }, { sessionID: "parent" })

  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "continue" }, { sessionID: "parent" })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[1].body.parts[0].text.includes("next generation only"), false)
  const fallback = await internalTask(runtime, response.taskID)
  assert.equal(fallback.runGeneration, 0)
  assert.equal(fallback.pendingInputs[0].text, "next generation only")
  const fallbackInput = JSON.parse(await runtime.handle({
    action: "input", taskID: response.taskID, input: "another queued input", expectedRevision: fallback.revision,
  }, { sessionID: "parent" }))
  assert.equal(fallbackInput.inputDelivery.currentTurnRunning, true)
  assert.equal(fallbackInput.inputDelivery.boundary, "after-current-turn")
  assert.equal(fallbackInput.inputDelivery.phase, "input-queued")
  assert.equal(fallbackInput.inputDelivery.revision, fallbackInput.revision)

  client.complete(response.sessionID, client.prompts[1].body.messageID, "fallback result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while (client.prompts.length < 3) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const continuation = await internalTask(runtime, response.taskID)
  assert.equal(continuation.runGeneration, 1)
  assert.match(client.prompts[2].body.parts[0].text, /next generation only/)
  runtime.dispose()
})

test("历史 fallback pending 转为显式决策后拒绝 input 且不派发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    models: ["provider/primary"],
    legacyModelCandidates: [
      { providerID: "provider", modelID: "primary" },
      { providerID: "provider", modelID: "fallback" },
    ],
  })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } }, { dispatch: false })
  const pending = await internalTask(runtime, response.taskID)
  assert.equal(pending.phase, "model-error-fallback-available")
  await assert.rejects(runtime.handle({ action: "input", taskID: response.taskID, input: "after stale claim", expectedRevision: pending.revision }, { sessionID: "parent" }), /等待显式交互或 retry 决策/)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const waiting = await internalTask(runtime, response.taskID)
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.phase, "model-error-fallback-available")
  assert.deepEqual(waiting.pendingInputs, [])
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("续跑 generation restart 向新 Attempt 发送原任务、RecoveryContext 和 active input", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await runtime.startAgent({ task: "original task", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while ((await internalTask(runtime, response.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const completed = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "generation input", expectedRevision: completed.revision }, { sessionID: "parent" })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  while ((await internalTask(runtime, response.taskID)).status !== "running") await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-generation-edit" })
  client.fail(response.sessionID, client.prompts[1].body.messageID, "retryable after generation write", { retryable: true })
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = await internalTask(runtime, response.taskID)
  assert.equal(waiting.status, "waiting_retry_decision")
  await runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" })
  while (client.prompts.length < 3) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.notEqual(client.prompts[2].sessionID, response.sessionID)
  assert.match(client.prompts[2].body.parts[0].text, /original task/)
  assert.match(client.prompts[2].body.parts[0].text, /generation input/)
  assert.match(client.prompts[2].body.parts[0].text, /RecoveryContext/)
  assert.match(client.prompts[2].body.parts[0].text, /"retryDecision": "restart"/)
  assert.match(client.prompts[2].body.parts[0].text, /"duplicateSideEffectRiskAccepted": true/)
  runtime.dispose()
})

test("同 Session continuation 保留完整 leaf 权限并结算新 generation", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), {
    maxDelegationDepth: 1,
    worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "task", "o4e_task"], loadAgents: ["worker"] }),
  })
  t.after(() => { runtime.dispose(); delegation.dispose() })
  const task = JSON.parse(await runtime.startAgent({ task: "leaf continuation", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(task.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  while ((await internalTask(runtime, task.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const completed = await internalTask(runtime, task.taskID)
  await runtime.handle({ action: "input", taskID: task.taskID, input: "continue leaf work", expectedRevision: completed.revision }, { sessionID: "parent" })
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(client.prompts[1].sessionID, task.sessionID)
  assert.equal(client.prompts[1].body.tools, undefined)
  const child = client.sessions.get(task.sessionID)
  assert.deepEqual(child.permission, child.metadata.o4e.delegation.compiledPermission)
  assert.equal(child.permission.findLast((rule) => rule.permission === "task" && rule.pattern === "*")?.action, "deny")
  assert.doesNotMatch(client.prompts[1].body.parts[0].text, /Task:\nleaf continuation/)
  assert.match(client.prompts[1].body.parts[0].text, /Do not replay completed work/)
  assert.match(client.prompts[1].body.parts[0].text, /continue leaf work/)
  assert.match(client.prompts[1].body.parts[0].text, /currentDepth: 1/)
  assert.match(client.prompts[1].body.parts[0].text, /remainingDelegationDepth: 0/)
  client.complete(task.sessionID, client.prompts[1].body.messageID, "continued leaf result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: task.sessionID })
  const continued = await internalTask(runtime, task.taskID)
  assert.equal(continued.status, "completed")
  assert.equal(continued.runGeneration, completed.runGeneration + 1)
})

test("continuation dispatch 失败时将本轮输入保留在 activeInputs", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let starts = 0
  const execution = {
    startTurn: async ({ sessionID, messageID, agent: targetAgent, model, parts }) => {
      starts += 1
      if (starts === 2) throw new Error("host rejected continuation")
      return (await client.session.promptAsync({ path: { id: sessionID }, body: { messageID, agent: targetAgent, model, parts } })).data
    },
    inspectTurn: async ({ sessionID, dispatchMessageID }) => {
      const messages = client.messages.get(sessionID) ?? []
      const result = messages.find((entry) => entry.info?.role === "assistant" && entry.info?.parentID === dispatchMessageID)
      return { state: client.sessions.get(sessionID)?.status === "busy" ? "running" : "idle", result }
    },
    cancelTurn: async ({ sessionID }) => client.session.abort({ path: { id: sessionID } }),
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "first result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while ((await internalTask(runtime, response.taskID)).status !== "completed") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const completed = await internalTask(runtime, response.taskID)
  await runtime.handle({ action: "input", taskID: response.taskID, input: "durable continuation", expectedRevision: completed.revision }, { sessionID: "parent" })
  while ((await internalTask(runtime, response.taskID)).status !== "unknown") await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const unknown = await internalTask(runtime, response.taskID)
  assert.equal(unknown.phase, "dispatch-unconfirmed")
  assert.equal(unknown.pendingInputs.length, 0)
  assert.equal(unknown.activeInputs[0].text, "durable continuation")
  runtime.dispose()
})

test("等待交互、取消和不确定状态拒绝 Agent Task input", async () => {
  const cases = [
    ["waiting_question", "question-waiting"],
    ["cancelled", "cancelled"],
    ["unknown", "inspection-failed"],
  ]
  for (const [status, phase] of cases) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const { runtime } = makeRuntime(client, root)
    const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const record = client.sessions.get(response.sessionID).metadata.o4e.task
    record.status = status
    record.phase = phase
    record.revision += 1
    record.updatedAt += 1
    if (status === "cancelled") {
      record.cancellationRequestedAt = record.updatedAt
      record.endedAt = record.updatedAt
      record.receipt = {
        version: 1,
        receiptID: createTaskReceiptID(response.taskID, status),
        generation: 0,
        taskID: response.taskID,
        status,
        phase,
        createdAt: record.endedAt,
      }
    }
    await assert.rejects(runtime.handle({
      action: "input",
      taskID: response.taskID,
      input: "must reject",
      expectedRevision: record.revision,
    }, { sessionID: "parent" }), /不允许 input|等待显式交互或 retry 决策/)
    assert.equal(client.prompts.length, 1)
    runtime.dispose()
  }
})

test("Background Task 持久化 question request，并由父 Session CAS 回复", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "ask", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-1",
    sessionID: response.sessionID,
    question: {
      questions: [{
        header: "Target",
        question: "Which target?",
        options: [{ label: "Local", description: "Use local" }],
        multiple: false,
        custom: false,
      }],
    },
  }
  hostRequests.set("question:question-1", request)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })

  const waiting = JSON.parse(await runtime.handle({ action: "pending", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(waiting.supported, true)
  assert.equal(waiting.tasks[0].status, "waiting_question")
  assert.equal(waiting.tasks[0].pendingRequests[0].question.questions[0].question, "Which target?")
  const revision = waiting.tasks[0].revision
  const ownerEnvelope = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].recoveryEnvelope
  assert.equal(ownerEnvelope.task.pendingRequests[0].requestID, "question-1")

  const repeated = JSON.parse(await runtime.handle({ action: "pending", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(repeated.tasks[0].revision, revision)
  await assert.rejects(
    runtime.handle({ action: "question.reply", taskID: response.taskID, requestID: "question-1", expectedRevision: revision - 1, answers: [["Local"]] }, { sessionID: "parent" }),
    /revision 已变化/,
  )
  assert.equal(replies.length, 0)
  await assert.rejects(
    runtime.handle({ action: "question.reply", taskID: response.taskID, requestID: "question-1", expectedRevision: revision, answers: [["Remote"]] }, { sessionID: "parent" }),
    /匹配可选 label/,
  )
  const replied = JSON.parse(await runtime.handle({
    action: "question.reply",
    taskID: response.taskID,
    requestID: "question-1",
    expectedRevision: revision,
    answers: [["Local"]],
  }, { sessionID: "parent" }))
  assert.equal(replied.status, "running")
  assert.deepEqual(replied.pendingRequests, [])
  assert.deepEqual(replies, [{
    kind: "question",
    sessionID: response.sessionID,
    requestID: "question-1",
    answers: [["Local"]],
  }])
  await assert.rejects(
    runtime.handle({ action: "question.reject", taskID: response.taskID, requestID: "question-1", expectedRevision: revision }, { sessionID: "parent" }),
    /revision 已变化|不等待 question request/,
  )
  runtime.dispose()
})

test("settled rejected tool with host idle becomes an actionable interruption through the real port", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const execution = createOpenCodeAgentExecutionPort({ client, directory: root })
  const { runtime, delegation } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  try {
    const response = JSON.parse(await runtime.startAgent({ task: "rejected tool", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
    while (client.prompts.length < 1) await new Promise((resolve) => setImmediate(resolve))
    await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
    client.messages.set(response.sessionID, [{
      info: { id: "rejected", role: "assistant", parentID: client.prompts[0].body.messageID, finish: "tool-calls", time: { completed: 123 } },
      parts: [{ type: "tool", tool: "read", state: { status: "error", error: "permission rejected" } }],
    }])
    client.sessions.get(response.sessionID).status = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    const interrupted = await internalTask(runtime, response.taskID)
    assert.equal(interrupted.status, "waiting_retry_decision")
    assert.equal(interrupted.phase, "execution-interrupted")
    assert.equal(client.prompts.length, 1)
    const watched = JSON.parse(await runtime.handle({ action: "watch", taskID: response.taskID, timeoutMs: 1 }, { sessionID: "parent" }))
    assert.equal(watched.reason, "actionable")
    assert.equal(watched.tasks[0].status, "waiting_retry_decision")
  } finally {
    runtime.dispose()
    delegation.dispose()
  }
})

test("缺少 requestID 且 pending 无法验证时，停止的交互 Task 进入显式 retry 决策", async () => {
  for (const pendingResult of [
    { supported: false, requests: [] },
    { supported: true, requests: [], error: "pending unavailable" },
  ]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", metadata: {} })
    const execution = makePendingExecution(client, new Map())
    execution.listPendingRequests = async () => pendingResult
    execution.inspectTurn = async () => ({
      state: "idle",
      ...(pendingResult.supported || pendingResult.error ? { pendingRequests: pendingResult } : {}),
    })
    const locks = new ScopeLockManager()
    const { runtime } = makeRuntime(client, root, locks, { execution, monitorIntervalMs: 1000 })
    const response = JSON.parse(await runtime.startAgent(
      { task: "ask without request id", agent: "worker", writeScopes: ["."] },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ))
    while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID })
    const waiting = JSON.parse(await runtime.handle({ action: "watch", taskIDs: [response.taskID], timeoutMs: 1 }, { sessionID: "parent" }))
    assert.equal(waiting.reason, "actionable")
    assert.equal(waiting.tasks[0].status, "waiting_question")

    client.sessions.get(response.sessionID).status = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
    const interrupted = await internalTask(runtime, response.taskID)
    assert.equal(interrupted.status, "waiting_retry_decision")
    assert.equal(interrupted.phase, "execution-interrupted")
    assert.equal(interrupted.retryDecision.status, "pending")
    assert.equal(interrupted.diagnostics.at(-1).code, "interaction-reconciliation-unavailable")
    assert.deepEqual(interrupted.pendingRequests, [])
    assert.equal(client.prompts.length, 1)

    let acquired = false
    const blocked = new AbortController()
    const lock = locks.acquire("other-writer", { kind: "unknown-write" }, { signal: blocked.signal }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)
    blocked.abort(new Error("interaction lock retained"))
    await assert.rejects(lock, /interaction lock retained/)
    runtime.dispose()
  }
})

test("缺少 requestID 且 pending 无法验证时，child error 进入显式 retry 决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const pendingResult = { supported: false, requests: [] }
  const execution = makePendingExecution(client, new Map())
  execution.listPendingRequests = async () => pendingResult
  execution.inspectTurn = async () => ({ state: "idle", pendingRequests: pendingResult })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "ask then error", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  await runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID })
  const decision = await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: new Error("child failed") })
  assert.equal(decision.managed, true)
  const interrupted = await internalTask(runtime, response.taskID)
  assert.equal(interrupted.status, "waiting_retry_decision")
  assert.equal(interrupted.phase, "execution-interrupted")
  assert.equal(interrupted.diagnostics.at(-1).code, "interaction-reconciliation-unavailable")
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("before-fallback 清空已解决 pending request 后继续使用最新 inspection claim", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const execution = makePendingExecution(client, hostRequests)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "permission resolves before fallback", agent: "worker" }, {
    sessionID: "parent",
    agent: "orchestrator",
    directory: root,
  }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "permission",
    requestID: "permission-resolved",
    sessionID: response.sessionID,
    permission: { action: "bash", resources: ["git status"], save: [] },
  }
  hostRequests.set("permission:permission-resolved", request)
  await runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID, request })
  hostRequests.clear()
  client.sessions.get(response.sessionID).status = "idle"

  const decision = await runtime.observeEvent({
    kind: "error",
    phase: "before-fallback",
    sessionID: response.sessionID,
    error: new Error("late child error"),
  })
  assert.equal(decision.managed, true)
  const reconciled = await internalTask(runtime, response.taskID)
  assert.equal(reconciled.status, "unknown")
  assert.equal(reconciled.phase, "model-error-unattributed")
  assert.deepEqual(reconciled.pendingRequests, [])
  runtime.dispose()
})

test("pending 查询失败时保留已验证 request，恢复查询成功后仍可正常回复", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  let pendingFails = true
  const execution = makePendingExecution(client, hostRequests, replies)
  const listPendingRequests = execution.listPendingRequests
  execution.listPendingRequests = async (args) => pendingFails
    ? { supported: true, requests: [], error: "pending temporarily unavailable" }
    : listPendingRequests(args)
  execution.inspectTurn = async ({ sessionID }) => ({
    state: client.sessions.get(sessionID).status === "busy" ? "running" : "idle",
    pendingRequests: await execution.listPendingRequests({ sessionID }),
  })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "preserve question", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-preserved",
    sessionID: response.sessionID,
    question: {
      questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], multiple: false, custom: false }],
    },
  }
  hostRequests.set("question:question-preserved", request)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })
  client.sessions.get(response.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const preserved = await internalTask(runtime, response.taskID)
  assert.equal(preserved.status, "waiting_question")
  assert.equal(preserved.pendingRequests[0].requestID, "question-preserved")
  pendingFails = false
  const replied = JSON.parse(await runtime.handle({
    action: "question.reply",
    taskID: response.taskID,
    requestID: "question-preserved",
    expectedRevision: preserved.revision,
    answers: [["Local"]],
  }, { sessionID: "parent" }))
  assert.equal(replied.status, "running")
  assert.deepEqual(replied.pendingRequests, [])
  assert.equal(replies.length, 1)
  runtime.dispose()
})

test("重载时缺少 requestID 且 pending unsupported 的 idle 交互 Task 进入显式 retry 决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const pendingResult = { supported: false, requests: [] }
  const execution = makePendingExecution(client, new Map())
  execution.listPendingRequests = async () => pendingResult
  execution.inspectTurn = async () => ({ state: "idle" })
  const first = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "recover missing request", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await first.runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID })
  client.sessions.get(response.sessionID).status = "idle"
  first.runtime.dispose()
  first.delegation.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  await second.runtime.recoverSession("parent")
  const recovered = await internalTask(second.runtime, response.taskID)
  assert.equal(recovered.status, "waiting_retry_decision")
  assert.equal(recovered.phase, "execution-interrupted")
  assert.equal(recovered.diagnostics.at(-1).code, "interaction-reconciliation-unavailable")
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("唯一 pending request 可补全 taskID、requestID 和最新 revision", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const response = JSON.parse(await runtime.startAgent({ task: "ask", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-inferred",
    sessionID: response.sessionID,
    question: {
      questions: [{
        header: "Target",
        question: "Which target?",
        options: [{ label: "Local", description: "Use local" }],
        multiple: false,
        custom: false,
      }],
    },
  }
  hostRequests.set("question:question-inferred", request)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })

  await assert.rejects(runtime.handle({
    action: "question.reply",
    answers: [["Local"]],
  }, { sessionID: response.sessionID }))
  assert.equal(replies.length, 0)
  const replied = JSON.parse(await runtime.handle({
    action: "question.reply",
    answers: [["Local"]],
  }, { sessionID: "parent" }))
  assert.equal(replied.taskID, response.taskID)
  assert.equal(replied.status, "running")
  assert.deepEqual(replies, [{
    kind: "question",
    sessionID: response.sessionID,
    requestID: "question-inferred",
    answers: [["Local"]],
  }])
  runtime.dispose()
})

test("多个 pending request 时拒绝猜测 reply 目标", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution })
  const first = JSON.parse(await runtime.startAgent({ task: "ask first", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const second = JSON.parse(await runtime.startAgent({ task: "ask second", agent: "worker", permissionOverlay: { "*": "deny" } }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  for (const [index, response] of [first, second].entries()) {
    const request = {
      kind: "question",
      requestID: `question-${index + 1}`,
      sessionID: response.sessionID,
      question: {
        questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], multiple: false, custom: false }],
      },
    }
    hostRequests.set(`question:${request.requestID}`, request)
    await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })
  }

  await assert.rejects(runtime.handle({
    action: "question.reply",
    answers: [["Local"]],
  }, { sessionID: "parent" }), /无法唯一定位 question request/)
  assert.equal(replies.length, 0)
  runtime.dispose()
})

test("父 Session 可 CAS 回复 permission 并拒绝 question", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies)
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "interact", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const permission = {
    kind: "permission",
    requestID: "permission-1",
    sessionID: response.sessionID,
    permission: { action: "bash", resources: ["git status"], save: [] },
  }
  hostRequests.set("permission:permission-1", permission)
  await runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID, request: permission })
  let pending = JSON.parse(await runtime.handle({ action: "pending", taskID: response.taskID }, { sessionID: "parent" }))
  const permissionResult = JSON.parse(await runtime.handle({
    action: "permission.reply",
    taskID: response.taskID,
    requestID: "permission-1",
    expectedRevision: pending.tasks[0].revision,
    reply: "always",
    message: "Approved for this workflow",
  }, { sessionID: "parent" }))
  assert.equal(permissionResult.status, "running")

  const question = {
    kind: "question",
    requestID: "question-1",
    sessionID: response.sessionID,
    question: {
      questions: [{ header: "Target", question: "Which target?", options: [], multiple: false, custom: true }],
    },
  }
  hostRequests.set("question:question-1", question)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request: question })
  pending = JSON.parse(await runtime.handle({ action: "pending", taskID: response.taskID }, { sessionID: "parent" }))
  const rejected = JSON.parse(await runtime.handle({
    action: "question.reject",
    taskID: response.taskID,
    requestID: "question-1",
    expectedRevision: pending.tasks[0].revision,
  }, { sessionID: "parent" }))
  assert.equal(rejected.status, "running")
  assert.deepEqual(replies, [{
    kind: "permission",
    sessionID: response.sessionID,
    requestID: "permission-1",
    reply: "always",
    message: "Approved for this workflow",
  }, {
    kind: "question",
    sessionID: response.sessionID,
    requestID: "question-1",
    reject: true,
  }])
  runtime.dispose()
})

test("pending reply 提交后确认失败会恢复 pending 且不自动重发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies, { confirmationError: "confirmation unavailable" })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await runtime.startAgent({ task: "ask", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-confirm",
    sessionID: response.sessionID,
    question: {
      questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], multiple: false, custom: false }],
    },
  }
  hostRequests.set("question:question-confirm", request)
  await runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })
  const pending = JSON.parse(await runtime.handle({ action: "pending", taskID: response.taskID }, { sessionID: "parent" }))

  await assert.rejects(runtime.handle({
    action: "question.reply",
    taskID: response.taskID,
    requestID: "question-confirm",
    expectedRevision: pending.tasks[0].revision,
    answers: [["Local"]],
  }, { sessionID: "parent" }), /confirmation unavailable/)
  const restored = await internalTask(runtime, response.taskID)
  assert.equal(restored.status, "waiting_question")
  assert.equal(restored.pendingRequests[0].state, "pending")
  assert.equal(restored.diagnostics.at(-1).code, "reply-submit-unconfirmed")
  assert.equal(replies.length, 1)
  runtime.dispose()
})

test("插件重载将遗留 submitting request 与宿主对账为 pending 而不重发", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const hostRequests = new Map()
  const replies = []
  const execution = makePendingExecution(client, hostRequests, replies)
  const first = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "ask", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const request = {
    kind: "question",
    requestID: "question-recover",
    sessionID: response.sessionID,
    question: {
      questions: [{ header: "Target", question: "Which target?", options: [], multiple: false, custom: true }],
    },
  }
  hostRequests.set("question:question-recover", request)
  await first.runtime.observeEvent({ kind: "question-waiting", sessionID: response.sessionID, request })
  const child = client.sessions.get(response.sessionID)
  child.metadata.o4e.task.pendingRequests[0].state = "submitting"
  child.metadata.o4e.task.revision += 1
  child.metadata.o4e.task.updatedAt += 1
  first.runtime.dispose()

  const second = makeRuntime(client, root, new ScopeLockManager(), { execution, monitorIntervalMs: 1000 })
  await second.runtime.recoverSession("parent")
  const recovered = await internalTask(second.runtime, response.taskID)
  assert.equal(recovered.status, "waiting_question")
  assert.equal(recovered.pendingRequests[0].state, "pending")
  assert.equal(replies.length, 0)
  second.runtime.dispose()
})

test("终态后台 Task 仍拦截延迟到达的模型错误事件", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })

  const decision = await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: new Error("late retryable error") })
  assert.deepEqual(decision, { managed: true, ownerSessionID: "parent" })
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "completed")
  runtime.dispose()
})

test("并发创建按父 Session 串行，较早 sequence 不会被越过", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const originalCreate = client.session.create
  let releaseFirst
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve })
  let creates = 0
  client.session.create = async (request) => {
    creates += 1
    if (creates === 1) {
      const created = await originalCreate(request)
      await firstBlocked
      return created
    }
    return originalCreate(request)
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
    monitorIntervalMs: 1000,
  })

  const firstPromise = runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  await Promise.resolve()
  const secondPromise = runtime.startAgent({ task: "second", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
  await Promise.resolve()
  assert.equal(client.prompts.length, 0)

  releaseFirst()
  const first = JSON.parse(await firstPromise)
  const second = JSON.parse(await secondPromise)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(first.sequence, 1)
  assert.equal(second.sequence, 2)
  assert.equal(client.prompts[0].sessionID, first.sessionID)
  runtime.dispose()
})

test("插件重载先恢复写锁，再允许新的同步委派", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks, { monitorIntervalMs: 1000 })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()
  firstLocks.clear()

  const secondLocks = new ScopeLockManager()
  const requester = agent()
  const worker = agent({ name: "worker", type: "subagent", description: "worker", loadTools: ["read", "bash", "edit"] })
  const agents = [requester, worker]
  const store = new OpenCodeSessionStore(client, root)
  const delegation = new DelegationRuntime({ client, directory: root, snapshot: () => ({ agents, allAgents: agents, agentByName: new Map(agents.map((entry) => [entry.name, entry])) }), store, locks: secondLocks, execution: createOpenCodeAgentExecutionPort({ client, directory: root }) })
  const secondRuntime = new BackgroundTaskRuntime({
    sessionStore: store,
    execution: {
      startTurn: async () => undefined,
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async ({ sessionID, dispatchMessageID }) => {
        const status = (await client.session.status({})).data[sessionID]
        const records = (await client.session.messages({ path: { id: sessionID } })).data
        const result = records.find((entry) => entry.info?.role === "assistant" && entry.info.parentID === dispatchMessageID)
        return { state: status?.type === "busy" ? "running" : "idle", result }
      },
    },
    delegation,
    locks: secondLocks,
    directory: root,
  })
  delegation.setBeforeDelegate((context) => secondRuntime.ensureOwner(context))

  let delegated = false
  const pending = delegation.delegate({ task: "second edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }).then(() => { delegated = true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(delegated, false)

  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await secondRuntime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await pending
  assert.equal(delegated, true)
  secondRuntime.dispose()
})

test("插件重载先对账停机期间完成的写任务，不恢复陈旧锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()
  firstLocks.clear()
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done while reloading")

  const secondLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, secondLocks)
  await second.runtime.activateSession("parent")
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "completed")
  await secondLocks.acquire("other", { kind: "unknown-write" })
  secondLocks.release("other")
  second.runtime.dispose()
})

test("插件重载将未受理的 persisted starting Task 转为 unknown", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const child = client.sessions.get(response.sessionID)
  child.status = "idle"
  child.metadata.o4e.task.status = "starting"
  child.metadata.o4e.task.phase = "starting"
  child.metadata.o4e.task.revision += 1
  first.runtime.dispose()
  firstLocks.clear()

  const secondLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, secondLocks)
  await second.runtime.activateSession("parent")
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "dispatch-unconfirmed")
  let acquired = false
  const waiting = secondLocks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  second.runtime.dispose()
  secondLocks.release(`background-task:${response.taskID}`)
  await waiting
  secondLocks.release("other")
})

test("插件重载将 idle 且无完成证据的 running Task 转为 retry decision", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.get(response.sessionID).status = "idle"
  first.runtime.dispose()
  firstLocks.clear()

  const secondLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, secondLocks)
  await second.runtime.activateSession("parent")
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "execution-interrupted")
  assert.equal(status.retryDecision.status, "pending")

  let acquired = false
  const waiting = secondLocks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  const stopped = JSON.parse(await second.runtime.handle({
    action: "resolve",
    taskID: response.taskID,
    expectedRevision: status.revision,
    decision: "stop",
  }, { sessionID: "parent" }))
  assert.equal(stopped.status, "failed")
  await waiting
  secondLocks.release("other")
  second.runtime.dispose()
})

test("实时 Task 在先观测 active 后收到 idle 无结果时转为 retry decision", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent({ task: "read", agent: "worker", writeScopes: [] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.get(response.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  let status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "running")

  client.sessions.get(response.sessionID).status = "busy"
  await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  client.sessions.get(response.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "execution-interrupted")
  runtime.dispose()
})

test("startTurn 未决期间收到的 active 证据不会被 dispatch 完成清除", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let releaseTurn
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: {
      startTurn: async ({ sessionID }) => {
        client.sessions.get(sessionID).status = "busy"
        await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      },
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async ({ sessionID }) => ({ state: client.sessions.get(sessionID).status === "busy" ? "running" : "idle" }),
    },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "read", agent: "worker", writeScopes: [] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (!releaseTurn) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  releaseTurn()
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  client.sessions.get(response.sessionID).status = "idle"
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "execution-interrupted")
  runtime.dispose()
})

test("pending idle inspection 不会覆盖随后到达的 busy 事件", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let releaseInspection
  let blockInspection = false
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: {
      startTurn: async ({ sessionID }) => { client.sessions.get(sessionID).status = "busy" },
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async ({ sessionID }) => {
        const state = client.sessions.get(sessionID).status === "busy" ? "running" : "idle"
        if (blockInspection) await new Promise((resolvePromise) => { releaseInspection = resolvePromise })
        return { state }
      },
    },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "read", agent: "worker", writeScopes: [] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })

  client.sessions.get(response.sessionID).status = "idle"
  blockInspection = true
  const idle = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while (!releaseInspection) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.sessions.get(response.sessionID).status = "busy"
  const busy = runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  releaseInspection()
  await Promise.all([idle, busy])

  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "running")
  assert.equal(status.phase, "model-running")
  runtime.dispose()
})

test("排队在旧 transition 后的 idle 事件不会借用新 busy epoch", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let releaseWatermark
  let watermarkBlocked = false
  let inspections = 0
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    if (request.body?.metadata?.o4e?.task?.sideEffectWatermark && !watermarkBlocked) {
      watermarkBlocked = true
      await new Promise((resolvePromise) => { releaseWatermark = resolvePromise })
    }
    return originalUpdate(request)
  }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    execution: {
      startTurn: async ({ sessionID }) => { client.sessions.get(sessionID).status = "busy" },
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async ({ sessionID }) => {
        inspections += 1
        return { state: client.sessions.get(sessionID).status === "busy" ? "running" : "idle" }
      },
    },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const watermark = runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  while (!releaseWatermark) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  client.sessions.get(response.sessionID).status = "idle"
  const idle = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const busy = runtime.observeEvent({ kind: "session-status", sessionID: response.sessionID, status: { type: "busy" } })
  releaseWatermark()
  client.sessions.get(response.sessionID).status = "busy"
  await Promise.all([watermark, idle, busy])

  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "running")
  assert.equal(status.phase, "model-running")
  assert.equal(inspections, 0)
  runtime.dispose()
})

test("pending retry inspection 不会覆盖随后持久化的模型错误决策", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  let inspectionCalls = 0
  let releaseInspection
  const retryableError = { name: "APIError", data: { message: "retryable", isRetryable: true } }
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    maxRetries: 0,
    execution: {
      startTurn: async ({ sessionID }) => { client.sessions.get(sessionID).status = "busy" },
      cancelTurn: async () => ({ acknowledged: true }),
      inspectTurn: async () => {
        inspectionCalls += 1
        if (inspectionCalls === 1) {
          await new Promise((resolvePromise) => { releaseInspection = resolvePromise })
          return { state: "retrying" }
        }
        return { state: "idle", error: retryableError }
      },
    },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "read", agent: "worker", writeScopes: [] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const inspecting = runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  while (!releaseInspection) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: retryableError })
  releaseInspection()
  await inspecting

  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "waiting_retry_decision")
  assert.equal(status.phase, "model-error-retryable")
  runtime.dispose()
})

test("插件停机期间父 Session 删除后，恢复会取消 active 子 Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()
  client.sessions.delete("parent")
  const get = client.session.get
  client.session.get = async (request) => {
    if (request.path.id === "parent") throw Object.assign(new Error("Session not found"), { name: "NotFoundError" })
    return get(request)
  }

  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.recoverSession(response.sessionID)
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: response.sessionID }))
  assert.equal(status.status, "cancelled")
  assert.deepEqual(client.aborts, [response.sessionID])
  second.runtime.dispose()
})

test("Session 定向恢复不会管控其他父 Session 的写 Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent-a", metadata: {} })
  client.addSession({ id: "parent-b", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const firstTask = JSON.parse(await first.runtime.startAgent({ task: "first edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-a", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()
  firstLocks.clear()

  const second = makeRuntime(client, root, new ScopeLockManager())
  const secondTask = JSON.parse(await second.runtime.startAgent({ task: "second edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-b", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 2)
  assert.equal(client.prompts[1].sessionID, secondTask.sessionID)

  client.complete(firstTask.sessionID, client.prompts[0].body.messageID, "first done")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: firstTask.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 2)
  second.runtime.dispose()
})

test("已恢复 active 写锁阻止另一 owner 激活 queued Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "owner-active", metadata: {} })
  client.addSession({ id: "owner-queued", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const active = JSON.parse(await first.runtime.startAgent({ task: "active edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-active", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-queued", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  first.runtime.dispose()
  firstLocks.clear()

  const queuedOwner = client.sessions.get("owner-queued")
  const activeOwner = client.sessions.get("owner-active")
  client.sessions.delete("owner-active")
  client.sessions.delete("owner-queued")
  client.sessions.set("owner-queued", queuedOwner)
  client.sessions.set("owner-active", activeOwner)
  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.recoverSession("owner-active")
  await second.runtime.activateSession("owner-queued")
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)

  client.complete(active.sessionID, client.prompts[0].body.messageID, "active done")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: active.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 2)
  assert.equal(client.prompts[1].sessionID, queued.sessionID)
  second.runtime.dispose()
})

test("已恢复 active 写锁阻止另一 owner 协调历史 pending fallback", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "owner-pending", metadata: {} })
  client.addSession({ id: "owner-active", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks, { models: ["provider/primary", "provider/fallback"] })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-active", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const pending = JSON.parse(await first.runtime.startAgent({ task: "pending edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-pending", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  const pendingSession = client.sessions.get(pending.sessionID)
  pendingSession.status = "idle"
  pendingSession.metadata.o4e.task.status = "retrying"
  pendingSession.metadata.o4e.task.phase = "model-fallback-pending"
  pendingSession.metadata.o4e.task.currentModel = { providerID: "provider", modelID: "fallback" }
  pendingSession.metadata.o4e.task.failedModelCandidates = [{ providerID: "provider", modelID: "primary" }]
  pendingSession.metadata.o4e.task.handledModelErrorAttempt = 1
  pendingSession.metadata.o4e.task.dispatchMessageID = "msg_pending_fallback_barrier"
  pendingSession.metadata.o4e.task.revision += 1
  first.runtime.dispose()
  firstLocks.clear()

  const pendingOwner = client.sessions.get("owner-pending")
  const activeOwner = client.sessions.get("owner-active")
  client.sessions.delete("owner-pending")
  client.sessions.delete("owner-active")
  client.sessions.set("owner-pending", pendingOwner)
  client.sessions.set("owner-active", activeOwner)
  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary", "provider/fallback"] })
  await second.runtime.recoverSession("owner-active")
  await second.runtime.activateSession("owner-pending")
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)

  client.complete(active.sessionID, client.prompts[0].body.messageID, "active done")
  await second.runtime.observeEvent({ kind: "session-idle", sessionID: active.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)
  const waiting = JSON.parse(await second.runtime.handle({ action: "status", taskID: pending.taskID }, { sessionID: "owner-pending" }))
  assert.equal(waiting.status, "waiting_retry_decision")
  assert.equal(waiting.phase, "model-error-fallback-available")
  second.runtime.dispose()
})

test("启动恢复先登记不确定同步写锁，再派发 queued 后台 Task", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "owner-active", metadata: {} })
  client.addSession({ id: "owner-queued", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const writeOptions = {
    requester: agent({ loadTools: ["read", "edit", "task"] }),
    worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "edit"], backgroundTasks: { maxRetries: 1 } }),
  }
  const first = makeRuntime(client, root, firstLocks, writeOptions)
  const active = JSON.parse(await first.runtime.startAgent({ task: "active edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-active", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const queued = JSON.parse(await first.runtime.startAgent({ task: "queued edit", agent: "worker", writeScopes: ["."] }, { sessionID: "owner-queued", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()
  firstLocks.clear()
  client.sessions.delete("owner-active")
  client.sessions.delete(active.sessionID)

  client.addSession({ id: "sync-owner", metadata: {} })
  client.addSession({
    id: "sync-attempt",
    parentID: "sync-owner",
    status: "busy",
    metadata: { o4e: { kind: "delegation-attempt", delegation: {
      status: "unknown",
      parentSessionID: "sync-owner",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      effect: "scoped-write",
      writeScopes: [root],
      dispatchMessageID: "msg_sync_uncertain",
      scopeLockID: "delegation:sync-uncertain",
    } } },
  })
  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks, writeOptions)
  await second.delegation.recoverSession("sync-owner")
  await second.runtime.activateSession("owner-queued")
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 1)

  client.sessions.get("sync-attempt").status = "idle"
  await second.delegation.observeEvent({ kind: "session-idle", sessionID: "sync-attempt" })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.length, 2)
  assert.equal(client.prompts[1].sessionID, queued.sessionID)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("恢复时子 Session 瞬时读取失败会阻止新 Task，不会漏恢复写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  first.runtime.dispose()

  const originalGet = client.session.get
  client.session.get = async ({ path }) => {
    if (path.id === response.sessionID) throw new Error("temporary transport failure")
    return originalGet({ path })
  }
  const second = makeRuntime(client, root, new ScopeLockManager())
  await assert.rejects(second.runtime.activateSession("parent"), /temporary transport failure/)
  await assert.rejects(
    second.runtime.startAgent({ task: "second edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }),
    /temporary transport failure/,
  )
  assert.equal(client.prompts.length, 1)
  second.runtime.dispose()
})

test("恢复时跳过悬空父索引，不阻塞 owner 后续使用", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({
    id: "parent",
    metadata: {
      o4e: {
        backgroundTasks: {
          version: 1,
          revision: 1,
          nextSequence: 2,
          taskRefs: {
            orphan: { taskSessionID: "missing-child", kind: "agent", sequence: 1, createdAt: 1 },
          },
        },
      },
    },
  })
  const { runtime } = makeRuntime(client, root)
  await runtime.activateSession("parent")

  await assert.rejects(runtime.status({ taskID: "orphan" }, { sessionID: "parent" }), /未找到 Task/)
  const created = JSON.parse(await runtime.startAgent({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  assert.equal(created.sequence, 2)
  runtime.dispose()
})

test("恢复识别结构化 NotFoundError 并跳过悬空父索引", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({
    id: "parent",
    metadata: {
      o4e: {
        backgroundTasks: {
          version: 1,
          revision: 1,
          nextSequence: 2,
          taskRefs: {
            orphan: { taskSessionID: "missing-child", kind: "agent", sequence: 1, createdAt: 1 },
          },
        },
      },
    },
  })
  const originalGet = client.session.get
  client.session.get = async ({ path }) => path.id === "missing-child"
    ? { error: { name: "NotFoundError", data: { message: path.id } } }
    : originalGet({ path })
  const { runtime } = makeRuntime(client, root)
  await runtime.activateSession("parent")
  await assert.rejects(runtime.status({ taskID: "orphan" }, { sessionID: "parent" }), /未找到 Task/)
  runtime.dispose()
})

test("任务完成后的委派引用写入失败保持不确定状态和写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks)
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  const originalUpdate = client.session.update
  let childUpdates = 0
  client.session.update = async (request) => {
    if (request.path.id === response.sessionID) {
      childUpdates += 1
      if (childUpdates >= 2) return { error: "metadata unavailable" }
    }
    return originalUpdate(request)
  }

  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "result-settlement-unconfirmed")
  assert.equal(status.receipt, undefined)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].receipts, undefined)
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  blocked.abort(new Error("still locked"))
  await assert.rejects(waiting, /still locked/)
  runtime.dispose()
})

test("已完成的共址 ledger 删除后降级 unknown 时恢复保守写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks)
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await runtime.pendingReceipts({ sessionID: "parent" })
  const receiptRef = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID])
  assert.match(receiptRef.receipts.at(-1).receiptID, /^o4e_receipt_/)
  await locks.acquire("after-complete", { kind: "unknown-write" })
  locks.release("after-complete")

  client.sessions.delete(response.sessionID)
  await runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID })
  const migratedRef = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.notEqual(migratedRef.taskSessionID, response.sessionID)
  assert.deepEqual(migratedRef.receipts, receiptRef.receipts)
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "missing-session")
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  blocked.abort(new Error("conservative lock restored"))
  await assert.rejects(waiting, /conservative lock restored/)
  runtime.dispose()
  locks.clear()
})

test("子 Session 删除后写入 tombstone 并保持 unknown 写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks, {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const response = JSON.parse(await runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = JSON.parse(await runtime.startAgent({ task: "queued", agent: "worker", writeScopes: [] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.delete(response.sessionID)

  await runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID })
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "missing-session")
  assert.notEqual(status.taskSessionID, response.sessionID)
  assert.equal(client.prompts.length, 1)
  assert.notEqual(client.prompts[0].sessionID, queued.sessionID)
  let acquired = false
  const waiting = locks.acquire("other", { kind: "unknown-write" }).then(() => { acquired = true })
  await Promise.resolve()
  assert.equal(acquired, false)
  runtime.dispose()
  locks.release(`background-task:${response.taskID}`)
  await waiting
  locks.release("other")
})

test("删除仍在 Scheduler queue 的 Task Session 后不会在槽位释放时 dispatch", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const first = JSON.parse(await runtime.startAgent({ task: "first", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const removed = JSON.parse(await runtime.startAgent({ task: "removed", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const third = JSON.parse(await runtime.startAgent({ task: "third", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.delete(removed.sessionID)

  await runtime.observeEvent({ kind: "deleted", sessionID: removed.sessionID })
  client.complete(first.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(client.prompts.some((entry) => entry.sessionID === removed.sessionID), false)
  assert.equal(client.prompts.some((entry) => entry.sessionID === third.sessionID), true)
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: removed.taskID }, { sessionID: "parent" }))
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "missing-session")
  assert.equal(status.diagnostics.some((entry) => entry.code === "dispatch-unconfirmed"), false)
  runtime.dispose()
})

test("删除已 admitted 但等待 Scope Lock 的 Task Session 会撤销 waiter", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent-a", metadata: {} })
  client.addSession({ id: "parent-b", metadata: {} })
  client.addSession({ id: "parent-c", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime } = makeRuntime(client, root, locks, {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const holder = JSON.parse(await runtime.startAgent({ task: "holder", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-a", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const removed = JSON.parse(await runtime.startAgent({ task: "removed", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-b", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(client.prompts.some((entry) => entry.sessionID === removed.sessionID), false)
  client.sessions.delete(removed.sessionID)

  await runtime.observeEvent({ kind: "deleted", sessionID: removed.sessionID })
  client.complete(holder.sessionID, client.prompts[0].body.messageID, "done")
  await runtime.observeEvent({ kind: "session-idle", sessionID: holder.sessionID })
  const next = JSON.parse(await runtime.startAgent({ task: "next", agent: "worker", writeScopes: ["."] }, { sessionID: "parent-c", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(client.prompts.some((entry) => entry.sessionID === removed.sessionID), false)
  assert.equal(client.prompts.some((entry) => entry.sessionID === next.sessionID), true)
  const status = JSON.parse(await runtime.handle({ action: "status", taskID: removed.taskID }, { sessionID: "parent-b" }))
  assert.equal(status.phase, "missing-session")
  assert.equal(status.diagnostics.some((entry) => entry.code === "dispatch-unconfirmed"), false)
  runtime.dispose()
})

test("删除恢复后的 fallback decision/retry pending waiter 不会 dispatch 并保留保守写锁", async () => {
  const root = process.cwd()
  for (const { phase, decision, models } of [
    { phase: "model-fallback-pending", models: ["provider/primary", "provider/fallback"] },
    { phase: "retry-continue-pending", decision: "continue", models: ["provider/primary"] },
  ]) {
    const client = new BackgroundClient()
    client.addSession({ id: "owner-holder", metadata: {} })
    client.addSession({ id: "owner-pending", metadata: {} })
    const firstLocks = new ScopeLockManager()
    const first = makeRuntime(client, root, firstLocks, { models })
    const holder = JSON.parse(await first.runtime.startAgent(
      { task: "holder", agent: "worker", writeScopes: ["."] },
      { sessionID: "owner-holder", agent: "orchestrator", directory: root },
    ))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const pending = JSON.parse(await first.runtime.startAgent(
      { task: phase, agent: "worker", writeScopes: ["."] },
      { sessionID: "owner-pending", agent: "orchestrator", directory: root },
    ))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const pendingTask = client.sessions.get(pending.sessionID).metadata.o4e.task
    const updatedAt = Date.now()
    Object.assign(pendingTask, {
      status: "retrying",
      phase,
      revision: pendingTask.revision + 1,
      attemptNumber: 1,
      retryRound: decision ? 1 : 0,
      currentModel: phase === "model-fallback-pending"
        ? { providerID: "provider", modelID: "fallback" }
        : { providerID: "provider", modelID: "primary" },
      failedModelCandidates: phase === "model-fallback-pending"
        ? [{ providerID: "provider", modelID: "primary" }]
        : [],
      handledModelErrorAttempt: 1,
      dispatchMessageID: `msg_deleted_${phase.replaceAll("-", "_")}`,
      updatedAt,
      ...(decision
        ? {
            retryDecision: {
              status: "resolved",
              retryRound: 0,
              attemptNumber: 1,
              requestedAt: updatedAt,
              error: "retryable fixture error",
              decision,
              resolvedAt: updatedAt,
            },
          }
        : {}),
    })
    first.runtime.dispose()
    first.delegation.dispose()
    firstLocks.clear()

    const locks = new ScopeLockManager()
    let pendingWaiter
    const waiterStarted = new Promise((resolve) => { pendingWaiter = resolve })
    const acquire = locks.acquire.bind(locks)
    locks.acquire = async (owner, effect, options) => {
      if (owner === `background-task:${pending.taskID}`) pendingWaiter()
      return acquire(owner, effect, options)
    }
    const second = makeRuntime(client, root, locks, { models })
    await second.runtime.recoverSession("owner-holder")
    await second.runtime.activateSession("owner-pending")
    if (phase === "model-fallback-pending") {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await internalTask(second.runtime, pending.taskID, "owner-pending")
        if (status.status === "waiting_retry_decision") break
        await new Promise((resolve) => setImmediate(resolve))
      }
      const waiting = await internalTask(second.runtime, pending.taskID, "owner-pending")
      assert.equal(waiting.status, "waiting_retry_decision")
      assert.equal(waiting.phase, "model-error-fallback-available")
      assert.equal(client.prompts.some((entry) => entry.body.messageID === pendingTask.dispatchMessageID), false)
    } else await waiterStarted
    client.sessions.delete(pending.sessionID)

    await second.runtime.observeEvent({ kind: "deleted", sessionID: pending.sessionID })
    client.complete(holder.sessionID, client.prompts[0].body.messageID, "holder done")
    await second.runtime.observeEvent({ kind: "session-idle", sessionID: holder.sessionID })
    await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(client.prompts.some((entry) => entry.sessionID === pending.sessionID), false, phase)
    const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: pending.taskID }, { sessionID: "owner-pending" }))
    assert.equal(status.status, "unknown", phase)
    assert.equal(status.phase, "missing-session", phase)
    const blocked = new AbortController()
    const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolve) => setImmediate(resolve))
    blocked.abort(new Error(`still locked ${phase}`))
    await assert.rejects(waiting, new RegExp(`still locked ${phase}`))
    second.runtime.dispose()
    second.delegation.dispose()
    locks.clear()
  }
})

test("子 Session tombstone 持久化失败会阻止 flush，重试成功后可重载恢复", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks, {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.delete(response.sessionID)
  const originalUpdate = client.session.update
  let failTombstone = true
  client.session.update = async (request) => {
    if (request.path.id !== "parent" && failTombstone) throw new Error("tombstone metadata unavailable")
    return originalUpdate(request)
  }

  await assert.rejects(first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }), /tombstone metadata unavailable/)
  await assert.rejects(first.runtime.flush(), /tombstone metadata unavailable/)
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await Promise.resolve()
  blocked.abort(new Error("still locked"))
  await assert.rejects(waiting, /still locked/)

  failTombstone = false
  first.runtime.resume()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const ownerRef = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.notEqual(ownerRef.taskSessionID, response.sessionID)
  assert.equal(client.sessions.get(ownerRef.taskSessionID).metadata.o4e.task.phase, "missing-session")

  first.runtime.dispose()
  first.delegation.dispose()
  locks.clear()
  const recoveredLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, recoveredLocks, {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  await second.runtime.activateSession("parent")
  const recovered = await internalTask(second.runtime, response.taskID)
  assert.equal(recovered.status, "unknown")
  assert.equal(recovered.phase, "missing-session")
  const recoveredBlocked = new AbortController()
  const recoveredWaiting = recoveredLocks.acquire("other", { kind: "unknown-write" }, { signal: recoveredBlocked.signal })
  await Promise.resolve()
  recoveredBlocked.abort(new Error("still locked after reload"))
  await assert.rejects(recoveredWaiting, /still locked after reload/)
  second.runtime.dispose()
  second.delegation.dispose()
  recoveredLocks.clear()
})

test("missing-task tombstone create 响应丢失后重载复用同一 tombstone", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const sourceRevision = client.sessions.get(response.sessionID).metadata.o4e.task.revision
  client.sessions.delete(response.sessionID)
  const originalCreate = client.session.create
  let submittedCreates = 0
  client.session.create = async (request) => {
    if (request.body?.metadata?.o4e?.tombstone) {
      submittedCreates += 1
      await originalCreate(request)
      throw new Error("create response lost")
    }
    return originalCreate(request)
  }

  await assert.rejects(first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }), /create response lost/)
  first.runtime.dispose()
  first.delegation.dispose()
  firstLocks.clear()
  client.session.create = originalCreate

  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.activateSession("parent")
  const ledgers = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(submittedCreates, 1)
  assert.equal(ledgers.length, 1)
  assert.equal(ledgers[0].metadata.o4e.task.revision, sourceRevision + 1)
  assert.equal(ledgers[0].metadata.o4e.task.phase, "missing-session")
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, ledgers[0].id)
  assert.equal(ledgers[0].metadata.o4e.tombstone, undefined)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("missing-task ledger update 响应丢失后重载复用冻结 revision", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const sourceRevision = client.sessions.get(response.sessionID).metadata.o4e.task.revision
  client.sessions.delete(response.sessionID)
  const originalUpdate = client.session.update
  let lost = true
  client.session.update = async (request) => {
    if (request.path.id !== "parent" && request.body?.metadata?.o4e?.task?.phase === "missing-session" && lost) {
      lost = false
      await originalUpdate(request)
      throw new Error("ledger update response lost")
    }
    return originalUpdate(request)
  }

  await assert.rejects(first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }), /ledger update response lost/)
  first.runtime.dispose()
  first.delegation.dispose()
  firstLocks.clear()
  client.session.update = originalUpdate

  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.activateSession("parent")
  const ledgers = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(ledgers.length, 1)
  assert.equal(ledgers[0].metadata.o4e.task.revision, sourceRevision + 1)
  assert.equal(ledgers[0].metadata.o4e.task.diagnostics.filter((entry) => entry.code === "session-missing").length, 1)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, ledgers[0].id)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("missing-task owner ref 响应丢失后按 taskID 最高 revision relink", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const sourceRevision = client.sessions.get(response.sessionID).metadata.o4e.task.revision
  client.sessions.delete(response.sessionID)
  const originalUpdate = client.session.update
  let lost = true
  client.session.update = async (request) => {
    const nextRef = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[response.taskID]
    if (request.path.id === "parent" && nextRef?.taskSessionID !== response.sessionID && lost) {
      lost = false
      await originalUpdate(request)
      throw new Error("owner ref response lost")
    }
    return originalUpdate(request)
  }

  await assert.rejects(first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }), /owner ref response lost/)
  first.runtime.dispose()
  first.delegation.dispose()
  firstLocks.clear()
  client.session.update = originalUpdate

  const beforeRecovery = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(beforeRecovery.length, 1)
  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.activateSession("parent")
  const ledgers = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(ledgers.length, 1)
  assert.equal(ledgers[0].metadata.o4e.task.revision, sourceRevision + 1)
  assert.equal(ledgers[0].metadata.o4e.task.phase, "missing-session")
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, ledgers[0].id)
  assert.equal(ledgers[0].metadata.o4e.tombstone, undefined)
  second.runtime.dispose()
  second.delegation.dispose()
})

test("owner 定向恢复的旧 replacement 快照不回退并发推进的 canonical ledger", { timeout: 2000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const clock = { now: Date.now, setTimeout: () => ({}), clearTimeout() {} }
  const writer = makeRuntime(client, root, locks, { clock })
  const reader = makeRuntime(client, root, locks, { clock })
  let releaseSnapshot
  t.after(() => {
    releaseSnapshot?.()
    writer.runtime.dispose()
    writer.delegation.dispose()
    reader.runtime.dispose()
    reader.delegation.dispose()
    locks.clear()
  })
  const response = JSON.parse(await writer.runtime.startAgent(
    { task: "concurrent missing ledger recovery", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.prompts.length, 1)
  client.sessions.delete(response.sessionID)
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    const ref = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[response.taskID]
    if (request.path.id === "parent" && ref?.taskSessionID !== response.sessionID) {
      throw new Error("owner ref unavailable")
    }
    return originalUpdate(request)
  }
  await assert.rejects(writer.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false }), /owner ref unavailable/)
  const replacement = [...client.sessions.values()].find((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.ok(replacement)
  assert.equal(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskSessionID, response.sessionID)

  let snapshotTaken
  const captured = new Promise((resolve) => { snapshotTaken = resolve })
  const gate = new Promise((resolve) => { releaseSnapshot = resolve })
  const originalChildren = client.session.children
  let paused = false
  client.session.children = async (request) => {
    const result = await originalChildren(request)
    if (request.path.id === "parent" && !paused) {
      paused = true
      snapshotTaken()
      await gate
    }
    return result
  }
  const recovering = reader.runtime.recoverSession("parent")
  await captured
  client.session.update = originalUpdate
  const advancing = (async () => {
    await writer.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
    client.sessions.delete(replacement.id)
    await writer.runtime.observeEvent({ kind: "deleted", sessionID: replacement.id }, { dispatch: false })
    return structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID])
  })()
  // Let in-memory writes progress; releasing the read never depends on acquiring its mutation lock.
  await new Promise((resolve) => setImmediate(resolve))
  releaseSnapshot()
  const [, latestRef] = await Promise.all([recovering, advancing])
  assert.notEqual(latestRef.taskSessionID, replacement.id)
  assert.ok(latestRef.taskRevision > replacement.metadata.o4e.task.revision)
  assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID], latestRef)
  const recovered = await internalTask(reader.runtime, response.taskID)
  assert.equal(recovered.taskSessionID, latestRef.taskSessionID)
  assert.equal(recovered.status, "unknown")
  assert.equal(recovered.phase, "missing-session")
  assert.equal(client.prompts.length, 1)
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await Promise.resolve()
  blocked.abort(new Error("unknown task remains locked"))
  await assert.rejects(waiting, /unknown task remains locked/)
})

test("跨 Runtime owner ref relink 后显式 status 跟随新 ledger", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "cross runtime relink", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = makeRuntime(client, root)
  await second.runtime.recoverSession("parent")

  client.sessions.delete(response.sessionID)
  await first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.notEqual(ref.taskSessionID, response.sessionID)
  const status = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(status.taskSessionID, ref.taskSessionID)
  assert.equal(status.status, "unknown")
  assert.equal(status.phase, "missing-session")

  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("陈旧 Runtime 发布 terminal receipt 不回滚 missing-task relink", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "stale receipt", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await first.runtime.pendingReceipts({ sessionID: "parent" })

  const stale = makeRuntime(client, root)
  await stale.runtime.recoverSession("parent")
  const staleStatus = await internalTask(stale.runtime, response.taskID)
  assert.equal(staleStatus.status, "completed")
  assert.equal(staleStatus.taskSessionID, response.sessionID)

  client.sessions.delete(response.sessionID)
  await first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
  await first.runtime.flush()
  const relinkedGroup = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
  const relinkedRef = relinkedGroup.taskRefs[response.taskID]
  const relinkedReceiptID = relinkedRef.receipts.at(-1).receiptID
  assert.notEqual(relinkedRef.taskSessionID, response.sessionID)
  assert.ok(relinkedRef.taskRevision > staleStatus.revision)

  const staleReceipts = await stale.runtime.pendingReceipts({ sessionID: "parent" })
  assert.equal(staleReceipts.length, 1)
  assert.equal(staleReceipts[0].receiptID, relinkedReceiptID)
  assert.equal(staleReceipts[0].outputAvailable, false)
  const finalGroup = client.sessions.get("parent").metadata.o4e.backgroundTasks
  const finalRef = finalGroup.taskRefs[response.taskID]
  assert.equal(finalRef.taskSessionID, relinkedRef.taskSessionID)
  assert.equal(finalRef.taskRevision, relinkedRef.taskRevision)
  assert.deepEqual(finalRef.receipts, relinkedRef.receipts)
  assert.equal(finalGroup.revision, relinkedGroup.revision)
  assert.equal(client.sessions.get(finalRef.taskSessionID).metadata.o4e.task.revision, finalRef.taskRevision)
  assert.equal(client.sessions.has(response.sessionID), false)

  first.runtime.dispose()
  first.delegation.dispose()
  stale.runtime.dispose()
  stale.delegation.dispose()
})

test("较旧 Runtime 不覆盖较新且未确认的不同 terminal receipt", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "stale different receipt", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await first.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  await first.runtime.pendingReceipts({ sessionID: "parent" })
  const completed = await internalTask(first.runtime, response.taskID)
  const cancelledReceiptID = createTaskReceiptID(response.taskID, "cancelled")
  const parent = client.sessions.get("parent")
  const current = parent.metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  parent.metadata.o4e.backgroundTasks.taskRefs[response.taskID] = {
    ...current,
    taskRevision: completed.revision + 1,
    receipts: [...(current.receipts ?? []), {
      receiptID: cancelledReceiptID,
      receiptStatus: "cancelled",
      receiptGeneration: 0,
      receiptCreatedAt: completed.updatedAt + 1,
      receiptPhase: "cancelled",
    }],
  }
  const groupRevision = parent.metadata.o4e.backgroundTasks.revision

  const receipts = await first.runtime.pendingReceipts({ sessionID: "parent" })
  assert.deepEqual(receipts.map((receipt) => receipt.receiptID), [completed.receipt.receiptID, cancelledReceiptID])
  assert.equal(receipts[0].endedAt, completed.endedAt)
  assert.equal(receipts[1].endedAt, completed.updatedAt + 1)
  assert.deepEqual(receipts[1].diagnostics, [])
  const unchangedGroup = client.sessions.get("parent").metadata.o4e.backgroundTasks
  assert.equal(unchangedGroup.taskRefs[response.taskID].receipts.at(-1).receiptID, cancelledReceiptID)
  assert.equal(unchangedGroup.revision, groupRevision)

  await first.runtime.markReceiptsDelivered(receipts.map((receipt) => receipt.receiptID), { sessionID: "parent" }, "user-1")
  const finalGroup = client.sessions.get("parent").metadata.o4e.backgroundTasks
  assert.equal(finalGroup.taskRefs[response.taskID].receipts.at(-1).receiptID, cancelledReceiptID)
  assert.deepEqual(finalGroup.taskRefs[response.taskID].receipts.map((receipt) => receipt.receiptID), [completed.receipt.receiptID, cancelledReceiptID])
  assert.ok(finalGroup.revision > groupRevision)
  assert.equal(finalGroup.taskRefs[response.taskID].receipts[0].receiptDeliveredToMessageID, "user-1")
  first.runtime.dispose()
  first.delegation.dispose()
})

test("较早的 receipt delivery 不覆盖较晚投递", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const newer = makeRuntime(client, root, new ScopeLockManager(), {
    clock: { now: () => 20, setTimeout, clearTimeout },
  })
  const response = JSON.parse(await newer.runtime.startAgent(
    { task: "delivery order", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.complete(response.sessionID, client.prompts[0].body.messageID, "done")
  await newer.runtime.observeEvent({ kind: "session-idle", sessionID: response.sessionID })
  const [receipt] = await newer.runtime.pendingReceipts({ sessionID: "parent" })
  await newer.runtime.markReceiptsDelivered([receipt.receiptID], { sessionID: "parent" }, "user-newer")

  const older = makeRuntime(client, root, new ScopeLockManager(), {
    clock: { now: () => 10, setTimeout, clearTimeout },
  })
  await older.runtime.recoverSession("parent")
  await older.runtime.markReceiptsDelivered([receipt.receiptID], { sessionID: "parent" }, "user-older")

  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  const refReceipt = ref.receipts.find((entry) => entry.receiptID === receipt.receiptID)
  const task = client.sessions.get(response.sessionID).metadata.o4e.task
  assert.equal(refReceipt.receiptDeliveredToMessageID, "user-newer")
  assert.equal(refReceipt.receiptDeliveredAt, 20)
  assert.equal(task.receipt.deliveredToMessageID, "user-newer")
  assert.equal(task.receipt.deliveredAt, 20)
  newer.runtime.dispose()
  newer.delegation.dispose()
  older.runtime.dispose()
  older.delegation.dispose()
})

test("missing-task 完成时 owner 已删除仍保留 canonical tombstone", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "owner disappears", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.sessions.delete(response.sessionID)

  let releasePostWrite
  let sawPostWrite
  const postWriteSeen = new Promise((resolve) => { sawPostWrite = resolve })
  const postWriteBlocked = new Promise((resolve) => { releasePostWrite = resolve })
  let blocked = false
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    if (!blocked && request.body?.metadata?.o4e?.task?.phase === "missing-session") {
      blocked = true
      sawPostWrite()
      await postWriteBlocked
    }
    return originalUpdate(request)
  }

  const migrating = first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
  await postWriteSeen
  client.sessions.delete("parent")
  releasePostWrite()
  await migrating

  const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.ok(tombstone)
  assert.equal(tombstone.metadata.o4e.task.status, "unknown")
  assert.equal(tombstone.metadata.o4e.task.phase, "missing-session")
  assert.equal(tombstone.metadata.o4e.tombstone, undefined)
  first.runtime.dispose()
  first.delegation.dispose()
  locks.clear()

  const recoveredLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, recoveredLocks)
  await second.runtime.recoverSession(tombstone.id)
  const recovered = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: tombstone.id }))
  assert.equal(recovered.status, "unknown")
  assert.equal(recovered.phase, "missing-session")
  const blockedLock = new AbortController()
  const waiting = recoveredLocks.acquire("other", { kind: "unknown-write" }, { signal: blockedLock.signal })
  await new Promise((resolve) => setImmediate(resolve))
  blockedLock.abort(new Error("orphan lock retained"))
  await assert.rejects(waiting, /orphan lock retained/)
  second.runtime.dispose()
  second.delegation.dispose()
  recoveredLocks.clear()
})

test("owner 先删除后 Task Session 删除时仍收敛唯一无父 tombstone", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const locks = new ScopeLockManager()
  const first = makeRuntime(client, root, locks)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "owner disappears first", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  client.session.abort = async ({ path }) => {
    client.aborts.push(path.id)
    return { data: false }
  }
  client.sessions.delete("parent")
  await first.runtime.observeEvent({ kind: "deleted", sessionID: "parent" }, { dispatch: false })
  client.sessions.delete(response.sessionID)
  await first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })

  const tombstones = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(tombstones.length, 1)
  assert.equal(tombstones[0].parentID, undefined)
  assert.equal(tombstones[0].metadata.o4e.task.status, "cancelled")
  assert.equal(tombstones[0].metadata.o4e.tombstone, undefined)
  assert.equal([...client.sessions.values()].filter((session) => (
    session.metadata?.o4e?.kind === "background-task-tombstone" && session.metadata.o4e.tombstone
  )).length, 0)
  first.runtime.dispose()
  first.delegation.dispose()
  locks.clear()

  const recoveredLocks = new ScopeLockManager()
  const second = makeRuntime(client, root, recoveredLocks)
  await second.runtime.recoverSession(tombstones[0].id)
  const recovered = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: tombstones[0].id }))
  assert.equal(recovered.status, "cancelled")
  second.runtime.dispose()
  second.delegation.dispose()
  recoveredLocks.clear()
})

test("missing-task tombstone 完成不回滚更高 revision 的 canonical ref", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "monotonic tombstone", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const sourceTask = structuredClone(client.sessions.get(response.sessionID).metadata.o4e.task)
  client.sessions.delete(response.sessionID)

  let releasePostWrite
  let sawPostWrite
  const postWriteSeen = new Promise((resolve) => { sawPostWrite = resolve })
  const postWriteBlocked = new Promise((resolve) => { releasePostWrite = resolve })
  let blocked = false
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    if (!blocked && request.body?.metadata?.o4e?.task?.phase === "missing-session") {
      blocked = true
      sawPostWrite()
      await postWriteBlocked
    }
    return originalUpdate(request)
  }

  const migrating = first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
  await postWriteSeen
  const owner = client.sessions.get("parent")
  const currentRef = owner.metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  const nextSourceTask = {
    ...sourceTask,
    revision: sourceTask.revision + 2,
    taskSessionID: "new-ledger",
    updatedAt: sourceTask.updatedAt + 2,
  }
  client.addSession({
    id: "new-ledger",
    parentID: "parent",
    metadata: { o4e: { task: nextSourceTask } },
  })
  owner.metadata.o4e.backgroundTasks.taskRefs[response.taskID] = {
    ...currentRef,
    taskSessionID: "new-ledger",
    taskRevision: nextSourceTask.revision,
    recoveryEnvelope: { version: 1, task: structuredClone(nextSourceTask) },
  }
  releasePostWrite()
  await migrating

  const finalOwner = client.sessions.get("parent").metadata.o4e
  assert.equal(finalOwner.backgroundTasks.taskRefs[response.taskID].taskSessionID, "new-ledger")
  assert.equal(finalOwner.backgroundTasks.taskRefs[response.taskID].taskRevision, nextSourceTask.revision)
  assert.equal(finalOwner.backgroundTasks.taskRefs[response.taskID].recoveryEnvelope.task.revision, nextSourceTask.revision)
  assert.equal(client.sessions.get("new-ledger").metadata.o4e.task.revision, nextSourceTask.revision)

  first.runtime.dispose()
  first.delegation.dispose()
})

test("missing-task tombstone 写失败后从 owner ref envelope 重建写锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const firstLocks = new ScopeLockManager()
  const first = makeRuntime(client, root, firstLocks)
  const response = JSON.parse(await first.runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const originalRef = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID])
  assert.equal(originalRef.recoveryEnvelope.task.taskID, response.taskID)
  assert.notEqual(originalRef.recoveryEnvelope.task.effect, "read")
  client.sessions.delete(response.sessionID)
  const originalUpdate = client.session.update
  let failTombstone = true
  client.session.update = async (request) => {
    if (request.path.id !== "parent" && request.body?.metadata?.o4e?.task?.phase === "missing-session" && failTombstone) {
      failTombstone = false
      throw new Error("first tombstone write failed")
    }
    return originalUpdate(request)
  }

  await assert.rejects(first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }), /first tombstone write failed/)
  first.runtime.dispose()
  first.delegation.dispose()
  firstLocks.clear()
  client.session.update = originalUpdate

  const locks = new ScopeLockManager()
  const second = makeRuntime(client, root, locks)
  await second.runtime.activateSession("parent")
  const recovered = await internalTask(second.runtime, response.taskID)
  assert.equal(recovered.status, "unknown")
  assert.equal(recovered.phase, "missing-session")
  assert.equal(recovered.effect, originalRef.recoveryEnvelope.task.effect)
  assert.deepEqual(recovered.writeScopes, originalRef.recoveryEnvelope.task.writeScopes)
  const recoveredRef = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.notEqual(recoveredRef.taskSessionID, response.sessionID)
  assert.deepEqual(recoveredRef.recoveryEnvelope, originalRef.recoveryEnvelope)
  const blocked = new AbortController()
  const waiting = locks.acquire("other", { kind: "unknown-write" }, { signal: blocked.signal })
  await new Promise((resolve) => setImmediate(resolve))
  blocked.abort(new Error("recovered envelope lock retained"))
  await assert.rejects(waiting, /recovered envelope lock retained/)
  second.runtime.dispose()
  second.delegation.dispose()
  locks.clear()
})

test("两个 Runtime 并发创建 missing-task tombstone 收敛到单一 ledger", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const initial = makeRuntime(client, root, new ScopeLockManager())
  const response = JSON.parse(await initial.runtime.startAgent(
    { task: "edit", agent: "worker", writeScopes: ["."] },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  await new Promise((resolve) => setTimeout(resolve, 5))
  initial.runtime.dispose()
  initial.delegation.dispose()

  const first = makeRuntime(client, root, new ScopeLockManager())
  const second = makeRuntime(client, root, new ScopeLockManager())
  await Promise.all([first.runtime.recoverSession("parent"), second.runtime.recoverSession("parent")])
  client.sessions.delete(response.sessionID)
  let releasePostWrite
  let sawPostWrite
  const postWriteSeen = new Promise((resolve) => { sawPostWrite = resolve })
  const postWriteBlocked = new Promise((resolve) => { releasePostWrite = resolve })
  let blocked = false
  const originalUpdate = client.session.update
  client.session.update = async (request) => {
    if (!blocked
      && request.body?.metadata?.o4e?.task?.taskID === response.taskID
      && request.body.metadata.o4e.task.phase === "missing-session"
      && request.body.metadata.o4e.kind === "background-task-tombstone") {
      blocked = true
      sawPostWrite()
      await postWriteBlocked
    }
    return originalUpdate(request)
  }

  const firstMigration = first.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
  await postWriteSeen
  let secondSettled = false
  const secondMigration = second.runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
    .finally(() => { secondSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondSettled, false)
  assert.equal([...client.sessions.values()].filter((session) => session.title === `[o4e] missing task ${response.taskID}`).length, 1)
  releasePostWrite()
  await Promise.all([firstMigration, secondMigration])

  const tombstones = [...client.sessions.values()].filter((session) => session.title === `[o4e] missing task ${response.taskID}`)
  assert.equal(tombstones.length, 1)
  const ledgers = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.task?.taskID === response.taskID)
  assert.equal(ledgers.length, 1)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(ref.taskSessionID, ledgers[0].id)
  assert.equal(ref.taskRevision, ledgers[0].metadata.o4e.task.revision)
  assert.equal(ledgers[0].metadata.o4e.tombstone, undefined)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("两个 Runtime 并发替换删除的独立 ledger 只创建一个 replacement", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const initial = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await initial.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  await initial.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await initial.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await initial.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await initial.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  initial.runtime.dispose()
  initial.delegation.dispose()

  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await Promise.all([first.runtime.recoverSession("parent"), second.runtime.recoverSession("parent")])
  client.sessions.delete(restarted.taskSessionID)

  await Promise.all([
    first.runtime.observeEvent({ kind: "deleted", sessionID: restarted.taskSessionID }, { dispatch: false }),
    second.runtime.observeEvent({ kind: "deleted", sessionID: restarted.taskSessionID }, { dispatch: false }),
  ])
  const ledgers = [...client.sessions.values()].filter((session) => session.title === `[o4e] task ledger ${response.taskID}` && session.metadata?.o4e?.task)
  assert.equal(ledgers.length, 1)
  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.equal(ref.taskSessionID, ledgers[0].id)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("跨 Runtime 迟到事件先跟随 owner canonical ref 再拒绝陈旧 Attempt 写入", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = makeRuntime(client, root, new ScopeLockManager(), { models: ["provider/primary"] })
  await second.runtime.recoverSession("parent")

  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  client.fail(response.sessionID, client.prompts[0].body.messageID, "retryable", { retryable: true })
  await first.runtime.observeEvent({ kind: "error", phase: "before-fallback", sessionID: response.sessionID, error: { name: "APIError", data: { isRetryable: true } } })
  const waiting = JSON.parse(await first.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  const restarted = JSON.parse(await first.runtime.handle({ action: "resolve", taskID: response.taskID, expectedRevision: waiting.revision, decision: "restart" }, { sessionID: "parent" }))
  const oldRevision = client.sessions.get(response.sessionID).metadata.o4e.task.revision

  await second.runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID }, { dispatch: false })
  assert.equal(client.sessions.get(response.sessionID).metadata.o4e.task.revision, oldRevision)
  assert.notEqual(client.sessions.get(restarted.taskSessionID).metadata.o4e.task.phase, "permission-waiting")
  const canonical = JSON.parse(await second.runtime.handle({ action: "status", taskID: response.taskID }, { sessionID: "parent" }))
  assert.equal(canonical.taskSessionID, restarted.taskSessionID)
  assert.equal(canonical.childSessionID, restarted.childSessionID)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("跨 Runtime 事件在父引用 revision 滞后时刷新同一 canonical ledger", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const first = makeRuntime(client, root, new ScopeLockManager())
  const response = JSON.parse(await first.runtime.startAgent({ task: "edit", agent: "worker", writeScopes: ["."] }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const second = makeRuntime(client, root, new ScopeLockManager())
  await second.runtime.recoverSession("parent")

  const update = client.session.update
  client.session.update = async (request) => {
    if (request.path.id === "parent") throw new Error("owner index temporarily unavailable")
    return update(request)
  }
  await first.runtime.markSideEffectBeforeTool({ sessionID: response.sessionID, tool: "edit", callID: "call-edit" })
  await first.runtime.flush()
  first.runtime.resume({ dispatch: false })
  client.session.update = update
  const ledgerRevision = client.sessions.get(response.sessionID).metadata.o4e.task.revision
  const refRevision = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID].taskRevision
  assert.ok(ledgerRevision > refRevision)
  const request = {
    kind: "permission",
    requestID: "permission-stale-ledger",
    sessionID: response.sessionID,
    permission: { action: "bash", resources: ["git status"], save: [] },
  }
  await second.runtime.observeEvent({ kind: "permission-waiting", sessionID: response.sessionID, request }, { dispatch: false })

  const persisted = client.sessions.get(response.sessionID).metadata.o4e.task
  assert.equal(persisted.revision, ledgerRevision + 1)
  assert.equal(persisted.status, "waiting_permission")
  assert.equal(persisted.pendingRequests[0].requestID, request.requestID)
  first.runtime.dispose()
  first.delegation.dispose()
  second.runtime.dispose()
  second.delegation.dispose()
})

test("missing-task tombstone 与 SessionStore owner update queue 不死锁", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime, store, delegation } = makeRuntime(client, root)
  const response = JSON.parse(await runtime.startAgent(
    { task: "queue ordering", agent: "worker" },
    { sessionID: "parent", agent: "orchestrator", directory: root },
  ))
  while (client.prompts.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))

  const originalUpdate = client.session.update
  let releaseOwnerUpdate
  let ownerUpdateStarted
  let ownerUpdateBlocked = false
  const ownerUpdateSeen = new Promise((resolve) => { ownerUpdateStarted = resolve })
  client.session.update = async (request) => {
    if (!ownerUpdateBlocked && request.path.id === "parent" && request.body?.metadata?.o4e?.queueBarrier) {
      ownerUpdateBlocked = true
      ownerUpdateStarted()
      await new Promise((resolvePromise) => { releaseOwnerUpdate = resolvePromise })
    }
    return originalUpdate(request)
  }
  const queuedOwnerUpdate = store.updateO4E("parent", (state) => ({ ...state, queueBarrier: true }))
  await ownerUpdateSeen
  client.sessions.delete(response.sessionID)

  let tombstoneSettled = false
  const writingTombstone = runtime.observeEvent({ kind: "deleted", sessionID: response.sessionID }, { dispatch: false })
    .finally(() => { tombstoneSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(tombstoneSettled, false)
  releaseOwnerUpdate()
  await Promise.all([queuedOwnerUpdate, writingTombstone])

  const ref = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[response.taskID]
  assert.notEqual(ref.taskSessionID, response.sessionID)
  assert.equal(client.sessions.get(ref.taskSessionID).metadata.o4e.task.phase, "missing-session")
  runtime.dispose()
  delegation.dispose()
})

test("父 Session 删除时 queued Task 取消，active Task 请求取消", async () => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", metadata: {} })
  const { runtime } = makeRuntime(client, root, new ScopeLockManager(), {
    limits: { maxRetries: 1, maxConcurrentAgents: 1, maxConcurrentCommands: 1 },
  })
  const active = JSON.parse(await runtime.startAgent({ task: "active", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  const queued = JSON.parse(await runtime.startAgent({ task: "queued", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  client.sessions.delete("parent")

  await runtime.observeEvent({ kind: "deleted", sessionID: "parent" })
  const activeStatus = JSON.parse(await runtime.handle({ action: "status", taskID: active.taskID }, { sessionID: active.sessionID }))
  const queuedStatus = JSON.parse(await runtime.handle({ action: "status", taskID: queued.taskID }, { sessionID: queued.sessionID }))
  assert.equal(activeStatus.status, "cancelled")
  assert.equal(queuedStatus.status, "cancelled")
  assert.equal(client.aborts[0], active.sessionID)
  assert.ok(client.aborts.slice(1).every((sessionID) => sessionID === queued.sessionID))
  assert.equal(client.prompts.length, 1)
  runtime.dispose()
})

test("nested background Tasks keep logical ownership, host approvals and receipt continuation dispatch", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const locks = new ScopeLockManager()
  const { runtime, delegation } = makeRuntime(client, root, locks, {
    worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "bash", "task", "o4e_task"] }),
  })
  t.after(() => { runtime.dispose(); delegation.dispose() })
  const context = (sessionID, agentName = "worker") => ({ sessionID, agent: agentName, directory: root })
  const running = async (task) => {
    for (let turn = 0; turn < 100; turn += 1) {
      if (client.sessions.get(task.sessionID).metadata.o4e.task.status === "running") return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.fail(JSON.stringify(client.sessions.get(task.sessionID).metadata.o4e.task))
  }
  const first = JSON.parse(await runtime.startAgent({ agent: "worker", task: "delegate and collect" }, context("parent", "orchestrator")))
  await running(first)
  const second = JSON.parse(await runtime.startAgent({ agent: "worker", task: "nested work" }, context(first.sessionID)))
  await running(second)
  assert.equal(client.sessions.get(second.sessionID).parentID, "parent")
  assert.equal(client.sessions.get(second.sessionID).metadata.o4e.delegation.depth, 2)
  assert.equal(client.sessions.get(first.sessionID).metadata.o4e.delegation.maxDelegationDepth, 2)
  assert.equal(client.sessions.get(first.sessionID).metadata.o4e.delegation.remainingDelegationDepth, 1)
  assert.equal(client.sessions.get(second.sessionID).metadata.o4e.delegation.maxDelegationDepth, 2)
  assert.equal(client.sessions.get(second.sessionID).metadata.o4e.delegation.remainingDelegationDepth, 0)
  assert.equal(client.prompts[0].body.tools, undefined)
  assert.equal(client.prompts[1].body.tools, undefined)
  assert.deepEqual(client.sessions.get(second.sessionID).permission, client.sessions.get(second.sessionID).metadata.o4e.delegation.compiledPermission)
  assert.match(client.prompts[0].body.parts[0].text, /currentDepth: 1/)
  assert.match(client.prompts[0].body.parts[0].text, /remainingDelegationDepth: 1/)
  assert.match(client.prompts[1].body.parts[0].text, /currentDepth: 2/)
  assert.match(client.prompts[1].body.parts[0].text, /remainingDelegationDepth: 0/)
  assert.match(client.prompts[1].body.parts[0].text, /leaf delegation layer/)
  assert.equal(client.sessions.get(first.sessionID).permission.findLast((rule) => rule.permission === "task" && rule.pattern === "worker")?.action, "allow")
  assert.equal(client.sessions.get(second.sessionID).permission.findLast((rule) => rule.permission === "task" && rule.pattern === "*")?.action, "deny")
  assert.equal(client.sessions.get(second.sessionID).metadata.o4e.task.ownerSessionID, first.sessionID)
  assert.equal(locks.parentLockID(`background-task:${second.taskID}`), `background-task:${first.taskID}`)
  assert.deepEqual((await runtime.taskGroup(context("parent", "orchestrator"))).map((task) => task.taskID), [first.taskID])
  assert.deepEqual((await runtime.taskGroup(context(first.sessionID))).map((task) => task.taskID), [second.taskID])

  client.complete(first.sessionID, client.prompts[0].body.messageID, "delegated; awaiting result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  assert.equal((await runtime.status({ taskID: first.taskID }, context("parent", "orchestrator"))).phase, "waiting-children")
  client.complete(second.sessionID, client.prompts[1].body.messageID, "nested result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: second.sessionID })
  assert.equal((await runtime.status({ taskID: second.taskID }, context(first.sessionID))).status, "completed")
  assert.equal((await runtime.status({ taskID: first.taskID }, context("parent", "orchestrator"))).status, "running")
  const parts = [{ type: "text", synthetic: true, text: "A child completed; read its output." }]
  assert.deepEqual(await runtime.continueOwner(first.sessionID, { messageID: "msg_nested_receipt", parts, agent: "worker" }), { managed: true, accepted: true })
  assert.deepEqual(await runtime.continueOwner(first.sessionID, { messageID: "msg_nested_receipt", parts, agent: "worker" }), { managed: true, accepted: true })
  assert.equal(client.prompts.length, 3)
  assert.equal(client.prompts.at(-1).body.messageID, "msg_nested_receipt")
  assert.deepEqual(client.prompts.at(-1).body.parts, parts)
  assert.equal(client.sessions.get(first.sessionID).metadata.o4e.delegation.dispatchMessageID, "msg_nested_receipt")
  await runtime.handle({ action: "output", taskID: second.taskID }, { ...context(first.sessionID), messageID: "msg_read_nested" })
  client.complete(first.sessionID, "msg_nested_receipt", "collected nested result")
  await runtime.observeEvent({ kind: "session-idle", sessionID: first.sessionID })
  assert.equal((await runtime.status({ taskID: first.taskID }, context("parent", "orchestrator"))).status, "completed")
  assert.equal(locks.has(`background-task:${first.taskID}`), false)
  assert.deepEqual(await runtime.continueOwner(first.sessionID, { messageID: "msg_late", parts }), { managed: true, accepted: false })
})

test("cold recovery restores nested read authority before loading both owner and Attempt tasks", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const options = { worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "task", "o4e_task"] }) }
  const first = makeRuntime(client, root, new ScopeLockManager(), options)
  const start = async (runtime, sessionID, agentName) => {
    const task = JSON.parse(await runtime.startAgent({ agent: "worker", task: "nested read" }, { sessionID, agent: agentName, directory: root }))
    for (let index = 0; index < 100 && client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
    return task
  }
  const child = await start(first.runtime, "parent", "orchestrator")
  const grandchild = await start(first.runtime, child.sessionID, "worker")
  first.runtime.dispose(); first.delegation.dispose()
  const locks = new ScopeLockManager()
  const recovered = makeRuntime(client, root, locks, options)
  t.after(() => { recovered.runtime.dispose(); recovered.delegation.dispose() })
  await recovered.runtime.recoverSession(child.sessionID, { dispatch: false })
  const owned = await recovered.runtime.taskGroup({ sessionID: child.sessionID })
  assert.equal(owned.length, 1)
  assert.equal(owned[0].taskID, grandchild.taskID)
  assert.equal(owned[0].status, "running")
  assert.equal(locks.has(`background-task:${child.taskID}`), true)
  assert.equal(locks.parentLockID(`background-task:${grandchild.taskID}`), `background-task:${child.taskID}`)
  assert.equal((await recovered.delegation.delegationAuthority({ sessionID: grandchild.sessionID, agent: "worker", directory: root })).depth, 2)
  assert.equal(client.sessions.get(grandchild.sessionID).metadata.o4e.delegation.maxDelegationDepth, 2)
  assert.equal(client.sessions.get(grandchild.sessionID).metadata.o4e.delegation.remainingDelegationDepth, 0)
  assert.equal(client.sessions.get(grandchild.sessionID).permission.findLast((rule) => rule.permission === "task" && rule.pattern === "*")?.action, "deny")
  assert.equal(client.prompts.length, 2)
  client.complete(grandchild.sessionID, client.prompts[1].body.messageID, "recovered leaf result")
  await recovered.runtime.observeEvent({ kind: "session-idle", sessionID: grandchild.sessionID })
  assert.equal((await recovered.runtime.status({ taskID: grandchild.taskID }, { sessionID: child.sessionID })).status, "completed")
  assert.equal(locks.has(`background-task:${grandchild.taskID}`), false)
  assert.equal(locks.has(`background-task:${child.taskID}`), true)
})

test("nested cancellation and owner deletion stop descendants and retain unknown descendant locks", { timeout: 5000 }, async (t) => {
  for (const deleted of [false, true]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
    const locks = new ScopeLockManager()
    const { runtime, delegation } = makeRuntime(client, root, locks, {
      maxDelegationDepth: 3,
      worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "bash", "task", "o4e_task"] }),
    })
    t.after(() => { runtime.dispose(); delegation.dispose() })
    const start = async (sessionID, agentName) => {
      const task = JSON.parse(await runtime.startAgent({ agent: "worker", task: "nested work" }, { sessionID, agent: agentName, directory: root }))
      for (let index = 0; index < 100 && client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
      return task
    }
    const child = await start("parent", "orchestrator")
    const grandchild = await start(child.sessionID, "worker")
    const leaf = await start(grandchild.sessionID, "worker")
    const abort = client.session.abort
    client.session.abort = async (request) => request.path.id === leaf.sessionID ? { data: false } : abort(request)
    if (deleted) {
      client.sessions.delete("parent")
      await runtime.observeEvent({ kind: "deleted", sessionID: "parent" })
    } else await runtime.cancel({ taskID: child.taskID }, { sessionID: "parent" })
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.sessionID })
    assert.equal(client.sessions.get(leaf.sessionID).metadata.o4e.task.status, "unknown")
    assert.notEqual(client.sessions.get(child.sessionID).metadata.o4e.task.status, "cancelled")
    assert.equal(locks.has(`background-task:${child.taskID}`), true)
    assert.equal(locks.has(`background-task:${leaf.taskID}`), true)
    client.sessions.get(leaf.sessionID).status = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.sessionID })
    assert.equal(client.sessions.get(child.sessionID).metadata.o4e.task.status, "cancelled")
    assert.equal(client.sessions.get(grandchild.sessionID).metadata.o4e.task.status, "cancelled")
    assert.equal(client.sessions.get(leaf.sessionID).metadata.o4e.task.status, "cancelled")
    assert.equal(locks.has(`background-task:${child.taskID}`), false)
  }
})


test("owner model errors wait without cancelling nested Tasks，显式 stop 后才安全收敛", { timeout: 5000 }, async (t) => {
  for (const uncertain of [false, true]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
    const locks = new ScopeLockManager()
    const { runtime, delegation } = makeRuntime(client, root, locks, {
      worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "bash", "task", "o4e_task"] }),
    })
    t.after(() => { runtime.dispose(); delegation.dispose() })
    const start = async (sessionID, agentName) => {
      const task = JSON.parse(await runtime.startAgent({ agent: "worker", task: "nested work" }, { sessionID, agent: agentName, directory: root }))
      for (let index = 0; index < 100 && client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
      return task
    }
    const owner = await start("parent", "orchestrator")
    const child = await start(owner.sessionID, "worker")
    const abort = client.session.abort
    client.session.abort = async (request) => {
      const resumed = await runtime.continueOwner(owner.sessionID, { messageID: "msg_unsafe_receipt", parts: [{ type: "text", text: "resume" }] })
      assert.equal(resumed.accepted, false)
      return uncertain ? { data: false } : abort(request)
    }
    client.fail(owner.sessionID, client.prompts[0].body.messageID)
    await runtime.observeEvent({ kind: "session-idle", sessionID: owner.sessionID })
    const waiting = client.sessions.get(owner.sessionID).metadata.o4e.task
    assert.equal(waiting.status, "waiting_retry_decision")
    assert.equal(waiting.phase, "model-error-non-retryable")
    assert.equal(client.sessions.get(child.sessionID).metadata.o4e.task.status, "running")
    assert.equal(client.prompts.length, 2)
    assert.equal(locks.has(`background-task:${owner.taskID}`), true)

    const stopped = JSON.parse(await runtime.handle({
      action: "resolve", taskID: owner.taskID, expectedRevision: waiting.revision, decision: "stop",
    }, { sessionID: "parent" }))
    assert.equal(stopped.status, uncertain ? "unknown" : "failed")
    assert.equal(stopped.phase, uncertain ? "children-stop-unconfirmed" : "retry-stopped")
    assert.equal(locks.has(`background-task:${owner.taskID}`), uncertain)
    assert.equal(client.sessions.get(child.sessionID).metadata.o4e.task.status, uncertain ? "unknown" : "cancelled")
    if (uncertain) assert.equal(stopped.receipt, undefined)
  }
})


test("activating a nested owner dispatches its queued children without activating root siblings", { timeout: 5000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const options = { worker: agent({ name: "worker", type: "subagent", loadTools: ["read", "task", "o4e_task"] }), limits: { maxConcurrentAgents: 1 } }
  const first = makeRuntime(client, root, new ScopeLockManager(), options)
  const start = (sessionID, agentName) => first.runtime.startAgent({ agent: "worker", task: "nested read" }, { sessionID, agent: agentName, directory: root }).then(JSON.parse)
  const running = async (task) => {
    for (let index = 0; index < 100 && client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "running")
  }
  const owner = await start("parent", "orchestrator")
  await running(owner)
  const sibling = await start("parent", "orchestrator")
  const activeChild = await start(owner.sessionID, "worker")
  await running(activeChild)
  const queuedChild = await start(owner.sessionID, "worker")
  await first.runtime.flush()
  first.runtime.dispose(); first.delegation.dispose()
  client.complete(activeChild.sessionID, client.prompts[1].body.messageID)
  const recovered = makeRuntime(client, root, new ScopeLockManager(), { ...options, limits: { maxConcurrentAgents: 2 } })
  t.after(() => { recovered.runtime.dispose(); recovered.delegation.dispose() })
  await recovered.runtime.activateSession(owner.sessionID)
  await running(queuedChild)
  assert.equal(client.sessions.get(sibling.sessionID).metadata.o4e.task.status, "queued")
  assert.deepEqual(client.prompts.map((prompt) => prompt.sessionID), [owner.sessionID, activeChild.sessionID, queuedChild.sessionID])
})

test("read recovery defers already admitted work at enqueue, authorization and lock boundaries", { timeout: 5000 }, async (t) => {
  for (const boundary of ["enqueue", "authorization", "lock"]) {
    await t.test(boundary, async () => {
      const client = new BackgroundClient()
      const root = process.cwd()
      client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
      const locks = new ScopeLockManager()
      const { runtime, delegation, store } = makeRuntime(client, root, locks)
      t.after(() => { runtime.dispose(); delegation.dispose() })
      let enterBoundary, releaseBoundary
      const entered = new Promise((resolve) => { enterBoundary = resolve })
      const held = new Promise((resolve) => { releaseBoundary = resolve })
      const pause = async () => { enterBoundary(); await held }
      const revalidate = delegation.revalidateAttempt.bind(delegation)
      let validations = 0
      delegation.revalidateAttempt = async (...args) => {
        if (boundary === "authorization" && ++validations === 1) await pause()
        return revalidate(...args)
      }
      const acquire = locks.acquire.bind(locks)
      locks.acquire = async (...args) => {
        const result = await acquire(...args)
        if (boundary === "lock") await pause()
        return result
      }
      const starting = runtime.startAgent({ task: "run after the read", agent: "worker" }, {
        sessionID: "parent", agent: "orchestrator", directory: root,
      }, { onSession: boundary === "enqueue" ? pause : undefined })
      await entered
      let enterRecovery, releaseRecovery
      const recoveryEntered = new Promise((resolve) => { enterRecovery = resolve })
      const recoveryHeld = new Promise((resolve) => { releaseRecovery = resolve })
      const get = store.get.bind(store)
      let ownerReads = 0
      store.get = async (id) => {
        if (id === "parent" && ++ownerReads === 2) { enterRecovery(); await recoveryHeld }
        return get(id)
      }
      const recovering = runtime.recoverSession("parent", { dispatch: false })
      await recoveryEntered
      releaseBoundary()
      await starting
      for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(client.prompts.length, 0)
      releaseRecovery()
      await recovering
      for (let turn = 0; turn < 100 && client.prompts.length === 0; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(client.prompts.length, 1)
    })
  }
})

test("failed recovery invalidates a pending admission authorization success or rejection", { timeout: 3000 }, async (t) => {
  for (const rejects of [false, true]) {
    const client = new BackgroundClient()
    const root = process.cwd()
    client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
    const { runtime, delegation, store } = makeRuntime(client, root)
    t.after(() => { runtime.dispose(); delegation.dispose() })
    let enteredValidation, releaseValidation
    const entered = new Promise((resolve) => { enteredValidation = resolve })
    const held = new Promise((resolve) => { releaseValidation = resolve })
    const revalidate = delegation.revalidateAttempt.bind(delegation)
    delegation.revalidateAttempt = async (...args) => {
      enteredValidation(); await held
      if (rejects) throw new Error("stale owner policy rejection")
      return revalidate(...args)
    }
    const task = JSON.parse(await runtime.startAgent({ task: "read fence", agent: "worker" }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }))
    await entered
    const get = store.get.bind(store)
    let ownerReads = 0
    store.get = async (id) => {
      if (id === "parent" && ++ownerReads === 2) throw new Error("owner read failed")
      return get(id)
    }
    await assert.rejects(runtime.recoverSession("parent", { dispatch: false }), /owner read failed/)
    store.get = get
    releaseValidation()
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    await runtime.recoverSession("parent", { dispatch: false })
    assert.equal(client.prompts.length, 0)
    assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.status, "queued")
    assert.equal(client.sessions.get(task.sessionID).metadata.o4e.task.revision, 1)
  }
})


test("read recovery queues newly discovered input continuation until explicit owner activation", { timeout: 3000 }, async (t) => {
  const client = new BackgroundClient()
  const root = process.cwd()
  client.addSession({ id: "parent", directory: root, agent: "orchestrator", metadata: {} })
  const worker = agent({ name: "worker", type: "subagent", description: "worker", loadTools: ["read"] })
  const first = makeRuntime(client, root, new ScopeLockManager(), { worker, limits: { maxConcurrentAgents: 2 } })
  t.after(() => { first.runtime.dispose(); first.delegation.dispose() })
  const active = JSON.parse(await first.runtime.startAgent({ task: "active sibling", agent: "worker" }, {
    sessionID: "parent", agent: "orchestrator", directory: root,
  }))
  const response = JSON.parse(await first.runtime.startAgent({ task: "first turn", agent: "worker" }, {
    sessionID: "parent", agent: "orchestrator", directory: root,
  }))
  while (client.prompts.length < 2) await new Promise((resolve) => setImmediate(resolve))
  const task = await first.runtime.status({ taskID: response.taskID }, { sessionID: "parent" })
  await first.runtime.input({ taskID: response.taskID, expectedRevision: task.revision, input: "continue" }, { sessionID: "parent" })
  await first.runtime.flush()
  first.runtime.dispose(); first.delegation.dispose()
  client.complete(response.sessionID, client.prompts.find((prompt) => prompt.sessionID === response.sessionID).body.messageID)
  const second = makeRuntime(client, root, new ScopeLockManager(), { worker, limits: { maxConcurrentAgents: 1 } })
  t.after(() => { second.runtime.dispose(); second.delegation.dispose() })
  await second.runtime.recoverSession("parent", { dispatch: false })
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.prompts.length, 2)
  assert.equal(client.sessions.get(response.sessionID).metadata.o4e.task.phase, "input-queued")
  client.complete(active.sessionID, client.prompts.find((prompt) => prompt.sessionID === active.sessionID).body.messageID)
  await second.runtime.recoverSession("parent", { dispatch: false })
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.prompts.length, 2, "read-only sibling settlement must not admit a newly recovered continuation")
  await second.runtime.activateSession("parent")
  for (let turn = 0; turn < 100 && client.prompts.length < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(client.prompts.length, 3)
  assert.equal(client.prompts[2].sessionID, response.sessionID)
  assert.doesNotMatch(client.prompts[2].body.parts[0].text, /Task:\nfirst turn/)
  assert.match(client.prompts[2].body.parts[0].text, /Do not replay completed work/)
  assert.match(client.prompts[2].body.parts[0].text, /currentDepth: 1/)
  assert.match(client.prompts[2].body.parts[0].text, /remainingDelegationDepth: 1/)
  assert.match(client.prompts[2].body.parts[0].text, /continue$/)
})
