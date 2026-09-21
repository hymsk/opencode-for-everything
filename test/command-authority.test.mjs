import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { effectiveAgentPermission, permissionAction, permissionRules } from "../src/core/agent-routing.mjs"
import { evaluate } from "../src/core/permission-rules.mjs"
import { BackgroundTaskRuntime } from "../src/runtime/background-task-runtime.mjs"
import { DelegationRuntime, delegationAuthorizationFingerprintFromEnvelope } from "../src/runtime/delegation-runtime.mjs"
import { createSharedScopeLockManager, ScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { OpenCodeSessionStore, sessionO4E } from "../src/runtime/session-store.mjs"

const agent = (overrides = {}) => ({
  name: "orchestrator", type: "all", description: "Command authority fixture", planProfile: false,
  loadTools: ["read", "bash", "task"], loadAgents: ["worker"], loadWorkflows: ["*"],
  loadSkills: ["*"], loadMcp: {}, capabilities: ["task.general"], ...overrides,
})

function fixture(t, { worker = {}, requester = {}, native = {}, absent = false, maxDelegationDepth } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "o4e-command-authority-"))
  const sessions = new Map()
  const agents = [agent(requester), agent({ name: "worker", type: "subagent", loadAgents: [], ...worker })]
  const snapshot = {
    agents, allAgents: agents, agentByName: new Map(agents.map((entry) => [entry.name, entry])),
    nativeAgentStrategies: { build: "keep", plan: "keep", general: "keep", explore: "keep", ...native },
    nativeModes: {}, workflows: new Map(), runtime: { config: { maxDelegationDepth } },
  }
  let nextID = 0
  let startTurn
  let runTurn
  const client = { session: {
    create: async ({ body }) => {
      const value = { ...structuredClone(body), id: `ses_${++nextID}`, directory }
      sessions.set(value.id, value)
      return { data: structuredClone(value) }
    },
    get: async ({ path }) => {
      if (!sessions.has(path.id)) throw new Error("Session not found")
      return { data: structuredClone(sessions.get(path.id)) }
    },
    update: async ({ path, body }) => {
      const value = { ...sessions.get(path.id), ...structuredClone(body) }
      sessions.set(path.id, value)
      return { data: structuredClone(value) }
    },
    children: async ({ path }) => ({ data: structuredClone([...sessions.values()].filter((entry) => entry.parentID === path.id)) }),
    list: async () => ({ data: structuredClone([...sessions.values()]) }),
    status: async () => ({ data: {} }),
    messages: async () => ({ data: [] }),
  } }
  const store = new OpenCodeSessionStore(client, directory)
  const locks = new ScopeLockManager()
  const execution = {
    startTurn: async (input) => { await startTurn?.(input) },
    runTurn: async (input) => {
      const permission = Object.entries(input.tools ?? {}).map(([permission, enabled]) => ({
        permission, action: enabled ? "allow" : "deny", pattern: "*",
      }))
      if (permission.length > 0) sessions.get(input.sessionID).permission = permission
      await runTurn?.(input)
      return { info: { id: "msg_result", role: "assistant", parentID: input.messageID, finish: "stop" },
        parts: [{ id: "part_result", type: "text", text: JSON.stringify({ status: "reported-completed", output: {}, artifacts: [], evidence: [], diagnostics: [] }) }] }
    },
    cancelTurn: async () => ({ acknowledged: true }),
    inspectTurn: async () => ({ state: "running" }),
  }
  const runtime = new DelegationRuntime({ store, directory, locks, execution, snapshot: () => absent ? null : snapshot })
  const background = new BackgroundTaskRuntime({ sessionStore: store, execution, delegation: runtime, locks, directory })
  t.after(() => { background.dispose(); runtime.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const context = (sessionID, name = "worker", extra = {}) => ({ sessionID, agent: name, directory, ...extra })
  const root = (name = "orchestrator", extra = {}) => store.create({ agent: name, ...extra })
  const child = async (args = {}) => {
    const parent = await root()
    const parentContext = context(parent.id, "orchestrator")
    const prepared = await runtime.prepare({ agent: "worker", task: "Check Bash authority", ...args }, parentContext)
    const lockOwner = `delegation:${parent.id}`
    await locks.acquire(lockOwner, prepared.effect)
    const { child } = await runtime.createAttempt(prepared, parentContext, { dispatchMessageID: "msg_dispatch", scopeLockID: lockOwner })
    return { child, parent, prepared, lockOwner, context: context(child.id) }
  }
  const delegatedBackground = async () => {
    const parent = await root()
    const started = new Promise((resolve) => { startTurn = resolve })
    const result = JSON.parse(await background.startAgent({ agent: "worker", task: "Check background Bash authority" }, context(parent.id, "orchestrator")))
    const dispatch = await started
    await setImmediate()
    return { parent, result, dispatch, context: context(dispatch.sessionID) }
  }
  return { directory, sessions, snapshot, store, locks, execution, runtime, background, root, child, context, delegatedBackground,
    onRun(callback) { runTurn = callback }, onStart(callback) { startTurn = callback } }
}

function resign(delegation) {
  delegation.authorizationFingerprint = delegationAuthorizationFingerprintFromEnvelope({
    requesterAgent: delegation.sourceAgent, requesterPermissionPattern: delegation.requesterPermissionPattern,
    requesterPermissionAction: delegation.requesterPermissionAction, requesterPermissionApproved: delegation.requesterPermissionApproved,
    targetAgent: delegation.targetAgent, compiledPermission: delegation.compiledPermission,
    permissionOverlay: delegation.permissionOverlay, effect: delegation.effect, normalizedScopes: delegation.writeScopes,
    trace: delegation.trace, workflowDefinitionHash: delegation.workflowDefinitionHash,
  })
}

test("native keep and unmanaged roots return no O4E permission or caller-supplied lock", async (t) => {
  for (const absent of [false, true]) {
    const f = fixture(t, { absent })
    for (const name of ["build", "external-agent"]) {
      const root = await f.root(name)
      assert.deepEqual(await f.runtime.commandAuthority(f.context(root.id, name, {
        lockOwner: "forged", parentTaskID: "forged", authorizationFingerprint: "forged", permission: "allow",
      })), {})
    }
  }
})

test("managed root returns effective permission, including Plan deny and native managed projection", async (t) => {
  const f = fixture(t, { requester: { permission: { bash: { "*": "deny", "git status": "ask" } } } })
  const root = await f.root()
  const authority = await f.runtime.commandAuthority(f.context(root.id, "orchestrator"))
  assert.deepEqual(authority, { permission: effectiveAgentPermission(f.snapshot.agents[0], { agents: f.snapshot.agents }) })
  assert.equal(permissionAction(authority.permission, "bash", "git status"), "ask")
  assert.equal(permissionAction(authority.permission, "bash", "git push"), "deny")
  f.snapshot.agents[0].planProfile = true
  assert.equal(permissionAction((await f.runtime.commandAuthority(f.context(root.id, "orchestrator"))).permission, "bash"), "deny")
  f.snapshot.agents[0].planProfile = false
  f.snapshot.nativeAgentStrategies.build = "managed"
  f.snapshot.nativeModes.build = "orchestrator"
  const native = await f.root("build")
  assert.deepEqual(await f.runtime.commandAuthority(f.context(native.id, "build")), authority)
})

test("root Session and snapshot identity fail closed", async (t) => {
  const f = fixture(t)
  const root = await f.root()
  await assert.rejects(f.runtime.commandAuthority(f.context(root.id, "build")), /Agent differs/)
  await assert.rejects(f.runtime.commandAuthority(f.context("missing", "build")), /not found/)
  await assert.rejects(f.runtime.commandAuthority(f.context(root.id, "orchestrator", { directory: "/different" })), /directory mismatch/)
  const workerRoot = await f.root("worker")
  await assert.rejects(f.runtime.commandAuthority(f.context(workerRoot.id)), /root must be primary or all/)
  const native = await f.root("build")
  f.snapshot.nativeAgentStrategies.build = "disable"
  await assert.rejects(f.runtime.commandAuthority(f.context(native.id, "build")), /disabled/)
  delete f.snapshot.nativeAgentStrategies.plan
  await assert.rejects(f.runtime.commandAuthority(f.context(root.id, "orchestrator")), /nativeAgents.plan/)
})

test("foreground dispatch verifies its Agent lock identity without borrowing and prepares a nested child", async (t) => {
  const f = fixture(t, { worker: { type: "all", loadAgents: ["orchestrator"] } })
  const root = await f.root()
  f.onRun(async ({ sessionID }) => {
    const child = await f.store.get(sessionID)
    const context = f.context(sessionID, "worker", { lockOwner: "forged", parentTaskID: "forged", authorizationFingerprint: "forged", permission: "allow" })
    const authority = await f.runtime.commandAuthority(context)
    assert.deepEqual(permissionRules(authority.permission), child.permission)
    assert.equal(authority.lockOwner, sessionO4E(child).delegation.scopeLockID)
    assert.equal(authority.authorizationFingerprint, sessionO4E(child).delegation.authorizationFingerprint)
    assert.equal(authority.parentTaskID, undefined)
    assert.equal(f.locks.has(authority.lockOwner), true)
    const nested = await f.runtime.prepare({ agent: "orchestrator", task: "recurse" }, context)
    assert.equal(nested.depth, 2)
    assert.equal(nested.parentLockID, authority.lockOwner)
    assert.equal(nested.hostParentID, root.id)
  })
  const result = JSON.parse(await f.runtime.delegate({ agent: "worker", task: "foreground" }, f.context(root.id, "orchestrator")))
  const child = await f.store.get(result.sessionID)
  assert.equal(f.locks.has(sessionO4E(child).delegation.scopeLockID), false)
  await assert.rejects(f.runtime.commandAuthority(f.context(child.id)), /inactive/)
})

test("frozen ask approval and tightening Overlay survive command authority without new approval", async (t) => {
  const f = fixture(t, { requester: { permission: { task: "ask" } } })
  const parent = await f.root()
  const context = f.context(parent.id, "orchestrator")
  const prepared = await f.runtime.prepare({ agent: "worker", task: "Approved child", permissionOverlay: { bash: "ask" } }, context, "task", { permissionApproved: true })
  await f.locks.acquire("approved-lock", prepared.effect)
  const { child } = await f.runtime.createAttempt(prepared, context, { scopeLockID: "approved-lock", dispatchMessageID: "dispatch" })
  const authority = await f.runtime.commandAuthority(f.context(child.id, "worker", { ask: () => assert.fail("authority must not ask") }))
  assert.equal(permissionAction(authority.permission, "bash", "git status"), "ask")
  assert.deepEqual(permissionRules(authority.permission), child.permission)
  f.snapshot.agents[0].permission.task = "allow"
  await assert.rejects(f.runtime.commandAuthority(f.context(child.id)), /configuration differs/)
})

test("background execution can use a separate canonical Task ledger but never execute as that ledger", async (t) => {
  const f = fixture(t)
  const c = await f.delegatedBackground()
  const child = f.sessions.get(c.context.sessionID)
  const task = structuredClone(sessionO4E(child).task)
  const ledger = await f.store.create({ parentID: c.parent.id })
  task.taskSessionID = ledger.id
  await f.store.updateO4E(ledger.id, () => ({ task }))
  delete child.metadata.o4e.task
  const ref = sessionO4E(f.sessions.get(c.parent.id)).backgroundTasks.taskRefs[c.result.taskID]
  ref.taskSessionID = ledger.id
  ref.recoveryEnvelope.task.taskSessionID = ledger.id
  assert.equal((await f.runtime.commandAuthority(c.context)).parentTaskID, task.taskID)
  await assert.rejects(f.runtime.commandAuthority(f.context(ledger.id)), /identity\/depth/)
})

test("child identity, envelope, current permission and actual lock are independently checked", async (t) => {
  const cases = [
    ["caller identity", (f, c) => { c.context.agent = "orchestrator" }, /Agent differs/],
    ["Session Agent", (f, c, s) => { s.agent = "orchestrator" }, /Agent differs/],
    ["depth", (f, c, s, d) => { d.depth = 2 }, /identity\/depth/],
    ["max depth", (f, c, s, d) => { d.maxDelegationDepth = 5 }, /maxDelegationDepth/],
    ["remaining depth", (f, c, s, d) => { d.remainingDelegationDepth = 4 }, /remaining delegation depth/],
    ["missing envelope", (f, c, s) => { delete s.metadata.o4e.delegation }, /identity\/depth/],
    ["parent identity", (f, c, s) => { s.parentID = "other" }, /identity\/depth/],
    ["execution identity", (f, c, s, d) => { d.executionSessionID = "other" }, /identity\/depth/],
    ["fingerprint", (f, c, s, d) => { d.authorizationFingerprint = "0".repeat(64) }, /fingerprint/],
    ["Session permission", (f, c, s) => { s.permission = [{ permission: "*", pattern: "*", action: "allow" }] }, /permission\/approval/],
    ["resigned permission", (f, c, s, d) => { d.compiledPermission.push({ permission: "bash", pattern: "*", action: "ask" }); s.permission = structuredClone(d.compiledPermission); resign(d) }, /configuration differs/],
    ["missing Overlay", (f, c, s, d) => { delete d.permissionOverlay }, /permission\/approval/],
    ["missing approval", (f, c, s, d) => { delete d.requesterPermissionApproved }, /permission\/approval/],
    ["cancelled", (f, c, s, d) => { d.cancellationRequestedAt = 0 }, /cancellation/],
    ["current target permission", (f) => { f.snapshot.agents[1].permission = { bash: "deny" } }, /configuration differs/],
    ["current target removed", (f) => { f.snapshot.agentByName.delete("worker") }, /identity\/depth/],
    ["current source permission", (f) => { f.snapshot.agents[0].permission = { task: "deny" } }, /拒绝 task/],
    ["parent Session permission", (f, c) => { f.sessions.get(c.parent.id).permission = [{ permission: "task", pattern: "worker", action: "deny" }] }, /拒绝 task/],
    ["unmanaged parent ancestry", (f, c) => { f.sessions.get(c.parent.id).parentID = "grandparent" }, /parent\/canonical authorization/],
    ["parent Agent", (f, c) => { f.sessions.get(c.parent.id).agent = "worker" }, /parent Session Agent/],
    ["no lock ID", (f, c, s, d) => { delete d.scopeLockID; c.context.scopeLockID = c.lockOwner }, /Scope Lock missing/],
    ["lock released", (f, c) => { f.locks.release(c.lockOwner) }, /Scope Lock missing/],
    ["scoped lock under unknown envelope", (f, c) => { f.locks.release(c.lockOwner); f.locks.restore(c.lockOwner, { kind: "scoped-write", writeScopes: [f.directory] }) }, /refusing upgrade/],
  ]
  for (const [name, mutate, expected] of cases) await t.test(name, async (t) => {
    const f = fixture(t)
    const c = await f.child()
    const session = f.sessions.get(c.child.id)
    mutate(f, c, session, sessionO4E(session).delegation)
    await assert.rejects(f.runtime.commandAuthority(c.context), expected)
  })
})

test("Plan/read/scoped children cannot turn Bash into a narrower Effect or forge caller authority", async (t) => {
  for (const [name, worker, args] of [
    ["Plan", { planProfile: true, loadTools: ["read"] }, {}],
    ["read", { loadTools: ["read"] }, {}],
    ["scoped", { loadTools: ["read", "edit"] }, { writeScopes: ["src"] }],
  ]) await t.test(name, async (t) => {
    const f = fixture(t, { worker })
    const c = await f.child(args)
    f.locks.restore("caller-lock", { kind: "unknown-write" }, { allowConflict: true })
    await assert.rejects(f.runtime.commandAuthority({ ...c.context, lockOwner: "caller-lock", effect: "unknown-write" }), /requires frozen unknown-write/)
  })
})

test("background cancellation, quarantine, stale attempt and parent fingerprint fail closed", async (t) => {
  for (const [name, mutate] of [
    ["quarantine", (task) => { task.status = "unknown"; task.phase = "authorization-unverifiable" }],
    ["stale child", (task) => { task.childSessionID = "new-attempt" }],
    ["fingerprint", (task) => { task.authorizationFingerprint = "0".repeat(64) }],
    ["parent cancelled", (task, ref) => { ref.cancellationRequestedAt = 0 }],
    ["parent fingerprint", (task, ref) => { ref.recoveryEnvelope.delegation.authorizationFingerprint = "0".repeat(64) }],
    ["parent permission tampered", (task, ref) => { ref.recoveryEnvelope.delegation.compiledPermission = [] }],
    ["parent recovery identity", (task, ref) => { ref.recoveryEnvelope.task.requesterAgent = "worker" }],
  ]) await t.test(name, async (t) => {
    const f = fixture(t)
    const c = await f.delegatedBackground()
    await f.runtime.commandAuthority(c.context)
    const task = sessionO4E(f.sessions.get(c.context.sessionID)).task
    const ref = sessionO4E(f.sessions.get(c.parent.id)).backgroundTasks.taskRefs[c.result.taskID]
    mutate(task, ref)
    await assert.rejects(f.runtime.commandAuthority(c.context), /Task .*mismatch|Task parent reference/)
  })
})

test("commandAuthority 拒绝旧 Workflow 子信封，不恢复其 Scope Lock", async (t) => {
  for (const [name, mutate] of [
    ["toolName", () => {}],
    ["trace.runSessionID", (delegation) => { delegation.toolName = "task" }],
    ["workflowDefinitionHash", (delegation) => { delegation.toolName = "task"; delete delegation.trace.runSessionID }],
  ]) await t.test(name, async (t) => {
    const f = fixture(t)
    const c = await f.child()
    const child = f.sessions.get(c.child.id)
    const delegation = sessionO4E(child).delegation
    delegation.toolName = "o4e_workflow"
    delegation.requesterPermissionPattern = "legacy-flow"
    delegation.trace = { runSessionID: "legacy-run", stepID: "work", attempt: 1 }
    delegation.workflowDefinitionHash = "f".repeat(64)
    mutate(delegation)
    resign(delegation)
    f.locks.release(c.lockOwner)
    await assert.rejects(f.runtime.commandAuthority(c.context), /unsupported delegation authorization tool|O4E_WORKFLOW_DELEGATION_UNSUPPORTED|task parent\/canonical authorization mismatch/)
    assert.equal(f.locks.has(c.lockOwner), false)
  })
})

test("DelegationRuntime 拒绝旧 Workflow prepare 入口和 trace.runSessionID", async (t) => {
  const f = fixture(t)
  const root = await f.root()
  const context = f.context(root.id, "orchestrator")
  await assert.rejects(
    f.runtime.prepare({ agent: "worker", task: "legacy Workflow Step" }, context, "o4e_workflow", { permissionPattern: "legacy-flow" }),
    /O4E_WORKFLOW_DELEGATION_UNSUPPORTED/,
  )
  await assert.rejects(
    f.runtime.prepare({ agent: "worker", task: "legacy trace", trace: { runSessionID: "legacy-run", stepID: "work", attempt: 1 } }, context),
    /O4E_WORKFLOW_DELEGATION_UNSUPPORTED/,
  )
  await assert.rejects(
    f.runtime.prepare({ agent: "worker", task: "legacy hash" }, context, "task", { workflowDefinitionHash: "f".repeat(64) }),
    /O4E_WORKFLOW_DELEGATION_UNSUPPORTED/,
  )
  assert.equal(f.sessions.size, 1)
})

test("nested foreground task enforces global depth and preserves host root and inherited Bash approval", { timeout: 5000 }, async (t) => {
  for (const configured of [undefined, 1, 5]) await t.test(`maxDelegationDepth=${configured ?? "default"}`, async (t) => {
    const maximum = configured ?? 2
    const f = fixture(t, { worker: { loadAgents: ["worker"] }, maxDelegationDepth: configured })
    const root = await f.root()
    const calls = []
    f.onRun(async (turn) => {
      const { sessionID } = turn
      const child = await f.store.get(sessionID)
      const delegation = sessionO4E(child).delegation
      assert.deepEqual(child.permission, delegation.compiledPermission)
      calls.push({ id: child.id, depth: delegation.depth })
      assert.equal(child.parentID, root.id, "all task permission requests remain visible in the native root")
      assert.equal(delegation.maxDelegationDepth, maximum)
      assert.equal(delegation.remainingDelegationDepth, maximum - delegation.depth)
      assert.match(turn.parts?.[0]?.text ?? "", new RegExp(`currentDepth: ${delegation.depth}`))
      assert.match(turn.parts?.[0]?.text ?? "", new RegExp(`remainingDelegationDepth: ${maximum - delegation.depth}`))
      assert.match(turn.parts?.[0]?.text ?? "", /sourceAgent: orchestrator|sourceAgent: worker/)
      assert.match(turn.parts?.[0]?.text ?? "", /targetAgent: worker/)
      const authority = await f.runtime.commandAuthority(f.context(sessionID))
      assert.equal(permissionAction(authority.permission, "bash", "printf marker"), "ask")
      if (delegation.depth > 1) {
        const parent = sessionO4E(await f.store.get(delegation.parentSessionID)).delegation
        assert.equal(parent.depth + 1, delegation.depth)
        assert.equal(f.locks.parentLockID(authority.lockOwner), parent.scopeLockID)
      }
      if (delegation.depth < maximum) {
        assert.notEqual(evaluate("task", "worker", child.permission).action, "deny")
        assert.equal(turn.tools, undefined)
        await f.runtime.delegate({ agent: "worker", task: "nested foreground" }, f.context(sessionID))
      } else {
        assert.equal(evaluate("task", "worker", child.permission).action, "deny")
        assert.equal(turn.tools, undefined)
        assert.match(turn.parts?.[0]?.text ?? "", /leaf delegation layer/)
        const sessionCount = f.sessions.size
        const args = { agent: "worker", task: "too deep", depth: 0, maxDelegationDepth: 5 }
        await assert.rejects(f.runtime.delegate(args, f.context(sessionID)), { code: "O4E_DELEGATION_DEPTH_LIMIT", depth: maximum + 1 })
        await assert.rejects(f.background.startAgent(args, f.context(sessionID)), { code: "O4E_DELEGATION_DEPTH_LIMIT" })
        assert.equal(f.sessions.size, sessionCount, "a denied delegation creates no Session or Task")
        assert.equal(f.locks.has(authority.lockOwner), true, "denied child must not release its caller's lock")
      }
  })
  await f.runtime.delegate({ agent: "worker", task: "outer", permissionOverlay: { bash: "ask" } }, f.context(root.id, "orchestrator"))
  assert.deepEqual(calls.map((call) => call.depth), Array.from({ length: maximum }, (_, i) => i + 1))
  for (const call of calls) await assert.rejects(f.runtime.commandAuthority(f.context(call.id)), /inactive/)
  })
})

test("lowered depth rejects stale preparation and prevents dispatch after Session creation", async (t) => {
  const f = fixture(t, { worker: { loadAgents: ["worker"] } })
  const parent = await f.child()
  const context = parent.context
  const args = { agent: "worker", task: "second level" }
  const prepared = await f.runtime.prepare(args, context)
  f.snapshot.runtime.config.maxDelegationDepth = 1
  const sessionCount = f.sessions.size
  await assert.rejects(f.runtime.revalidateAttempt(prepared, context.sessionID), { code: "O4E_DELEGATION_DEPTH_LIMIT" })
  await assert.rejects(f.runtime.createAttempt(prepared, context, { dispatchMessageID: "stale-depth" }), { code: "O4E_DELEGATION_DEPTH_LIMIT" })
  assert.equal(f.sessions.size, sessionCount)
  f.snapshot.runtime.config.maxDelegationDepth = 2
  let runs = 0
  f.onRun(() => { runs += 1 })
  await assert.rejects(f.runtime.delegate(args, context, {
    afterCreateAttempt: () => { f.snapshot.runtime.config.maxDelegationDepth = 1 },
  }), (error) => {
    assert.equal(error.code, "O4E_DELEGATION_UNCERTAIN")
    assert.match(error.message, /maxDelegationDepth=1/)
    assert.equal(error.retainLock, true, "unknown host stop evidence must retain the existing lock")
    return true
  })
  assert.equal(runs, 0, "a created but now over-depth child must not call the model")
})

test("foreground abort during final owner revalidation never submits the child", { timeout: 2000 }, async (t) => {
  const f = fixture(t)
  const root = await f.root()
  const controller = new AbortController()
  const get = f.store.get.bind(f.store)
  let hold = false
  let enter
  let release
  let submissions = 0
  const entered = new Promise((resolve) => { enter = resolve })
  const resumed = new Promise((resolve) => { release = resolve })
  f.onRun(() => { submissions += 1 })
  f.store.get = async (id) => {
    if (hold && id === root.id) {
      hold = false
      enter()
      await resumed
    }
    return get(id)
  }
  const pending = f.runtime.delegate({ agent: "worker", task: "abort before submit" },
    f.context(root.id, "orchestrator", { abort: controller.signal }), { afterCreateAttempt: () => { hold = true } })
  const rejected = assert.rejects(pending)
  try {
    await entered
    controller.abort(new Error("abort-before-child-submit"))
    release()
    await rejected
    assert.equal(submissions, 0)
  } finally { release() }
})

test("nested child validates the active background ancestor and both owner ledgers", async (t) => {
  for (const boundary of ["ancestor cancelled", "ancestor ledger changed", "host parent changed", "ancestry cycle", "late ancestor cancellation"]) await t.test(boundary, async (t) => {
    const f = fixture(t, { worker: { loadAgents: ["worker"] } })
    const parent = await f.delegatedBackground()
    const prepared = await f.runtime.prepare({ agent: "worker", task: "nested authority" }, parent.context)
    assert.equal(prepared.parentLockID, `background-task:${parent.result.taskID}`)
    await f.locks.acquire("nested-lock", prepared.effect, { parentLockID: prepared.parentLockID })
    const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "nested-lock", dispatchMessageID: "nested-dispatch" })
    assert.equal(child.parentID, parent.parent.id)
    assert.equal(sessionO4E(child).delegation.parentSessionID, parent.context.sessionID)
    assert.equal((await f.runtime.commandAuthority(f.context(child.id))).lockOwner, "nested-lock")
    if (boundary === "ancestor cancelled") sessionO4E(f.sessions.get(parent.context.sessionID)).delegation.cancellationRequestedAt = 0
    else if (boundary === "ancestor ledger changed") {
      sessionO4E(f.sessions.get(parent.parent.id)).backgroundTasks.taskRefs[parent.result.taskID].recoveryEnvelope.delegation.authorizationFingerprint = "0".repeat(64)
    } else if (boundary === "host parent changed") f.sessions.get(child.id).parentID = parent.context.sessionID
    else if (boundary === "ancestry cycle") sessionO4E(f.sessions.get(child.id)).delegation.parentSessionID = child.id
    else {
      const get = f.store.get.bind(f.store)
      let reads = 0
      f.store.get = async (id) => {
        if (id === child.id && ++reads === 2) {
          sessionO4E(f.sessions.get(parent.parent.id)).backgroundTasks.taskRefs[parent.result.taskID].cancellationRequestedAt = 0
        }
        return get(id)
      }
    }
    await assert.rejects(f.runtime.commandAuthority(f.context(child.id)), /cancellation|mismatch|cycle|cancelled/)
    assert.equal(f.locks.has("nested-lock"), true)
  })
})

test("cold nested authority restores the background ancestor before its foreground child", async (t) => {
  const f = fixture(t, { worker: { loadAgents: ["worker"] }, maxDelegationDepth: 3 })
  const parent = await f.delegatedBackground()
  const prepared = await f.runtime.prepare({ agent: "worker", task: "cold nested authority" }, parent.context)
  await f.locks.acquire("cold-nested-lock", prepared.effect, { parentLockID: prepared.parentLockID })
  const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "cold-nested-lock", dispatchMessageID: "cold-nested-dispatch" })
  const locks = new ScopeLockManager()
  const runtime = new DelegationRuntime({ store: f.store, directory: f.directory, locks, snapshot: () => f.snapshot, execution: {
    inspectTurn: async () => ({ state: "running" }),
    cancelTurn: async () => ({ acknowledged: false }),
  } })
  t.after(() => { runtime.dispose(); locks.release("cold-nested-lock"); locks.clear() })
  await runtime.recoverSession(child.id)
  assert.equal(locks.parentLockID("cold-nested-lock"), prepared.parentLockID)
  assert.equal((await runtime.commandAuthority(f.context(child.id))).lockOwner, "cold-nested-lock")
  assert.equal((await runtime.prepare({ agent: "worker", task: "next" }, f.context(child.id))).depth, 3)
  locks.release(prepared.parentLockID)
  assert.throws(() => locks.restore("competing-writer", { kind: "unknown-write" }), /Scope Lock/)
  locks.release("cold-nested-lock")
  assert.equal(locks.has(prepared.parentLockID), false)
})

test("cold nested read authority restores read nodes without granting Bash", async (t) => {
  const f = fixture(t, { worker: { loadTools: ["read", "task"], loadAgents: ["worker"] }, maxDelegationDepth: 3 })
  const parent = await f.child()
  const prepared = await f.runtime.prepare({ agent: "worker", task: "nested read" }, parent.context)
  await f.locks.acquire("cold-read-lock", prepared.effect, { parentLockID: prepared.parentLockID })
  const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "cold-read-lock", dispatchMessageID: "cold-read-dispatch" })
  const locks = new ScopeLockManager()
  const runtime = new DelegationRuntime({ store: f.store, directory: f.directory, locks, snapshot: () => f.snapshot, execution: {} })
  t.after(() => { runtime.dispose(); locks.release("cold-read-lock"); locks.clear() })
  assert.equal((await runtime.restoreDelegationAuthority(f.context(child.id))).depth, 2)
  assert.equal(locks.has(parent.lockOwner), true)
  assert.equal(locks.parentLockID("cold-read-lock"), parent.lockOwner)
  await assert.rejects(runtime.commandAuthority(f.context(child.id)), /requires frozen unknown-write/)
  assert.equal((await runtime.prepare({ agent: "worker", task: "next read" }, f.context(child.id))).effect.kind, "read")
})

test("shared reload restores verified ancestor ownership before another nested dispatch", async (t) => {
  const f = fixture(t, { worker: { loadAgents: ["worker"] }, maxDelegationDepth: 3 })
  const parent = await f.child()
  const prepared = await f.runtime.prepare({ agent: "worker", task: "nested across reload" }, parent.context)
  await f.locks.acquire("reload-nested-lock", prepared.effect, { parentLockID: prepared.parentLockID })
  const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "reload-nested-lock", dispatchMessageID: "reload-nested-dispatch" })
  const firstLocks = createSharedScopeLockManager(f.directory)
  const first = new DelegationRuntime({ store: f.store, directory: f.directory, locks: firstLocks, snapshot: () => f.snapshot, execution: {} })
  await first.restoreDelegationAuthority(f.context(child.id))
  first.dispose()
  firstLocks.clear()
  const locks = createSharedScopeLockManager(f.directory)
  const runtime = new DelegationRuntime({ store: f.store, directory: f.directory, locks, snapshot: () => f.snapshot, execution: {} })
  t.after(() => { runtime.dispose(); locks.release("after-reload"); locks.release("reload-nested-lock"); locks.clear() })
  await runtime.restoreDelegationAuthority(f.context(child.id))
  const next = await runtime.prepare({ agent: "worker", task: "run after reload" }, f.context(child.id))
  await locks.acquire("after-reload", next.effect, { parentLockID: next.parentLockID })
  assert.equal(locks.parentLockID("after-reload"), "reload-nested-lock")
  assert.throws(() => locks.restore("competing-writer", { kind: "unknown-write" }), /Scope Lock/)
})

test("cold nested recovery retains conservative locks after ancestor cancellation or a lower depth limit", async (t) => {
  for (const boundary of ["cancelled ancestor", "lowered depth"]) await t.test(boundary, async (t) => {
    const f = fixture(t, { worker: { loadAgents: ["worker"] } })
    const parent = await f.delegatedBackground()
    const prepared = await f.runtime.prepare({ agent: "worker", task: "invalid cold ancestry" }, parent.context)
    await f.locks.acquire("invalid-cold-lock", prepared.effect, { parentLockID: prepared.parentLockID })
    const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "invalid-cold-lock", dispatchMessageID: "invalid-cold-dispatch" })
    if (boundary === "cancelled ancestor") {
      sessionO4E(f.sessions.get(parent.parent.id)).backgroundTasks.taskRefs[parent.result.taskID].cancellationRequestedAt = 0
    } else {
      f.snapshot.runtime.config.maxDelegationDepth = 1
    }
    const denied = boundary === "cancelled ancestor" ? /cancelled|inactive/ : /maxDelegationDepth/
    const locks = new ScopeLockManager()
    const runtime = new DelegationRuntime({ store: f.store, directory: f.directory, locks, snapshot: () => f.snapshot, execution: {
      inspectTurn: async () => ({ state: "running" }),
    } })
    t.after(() => { runtime.dispose(); locks.clear() })
    await assert.rejects(runtime.restoreDelegationAuthority(f.context(child.id)), denied)
    assert.equal(locks.has("invalid-cold-lock"), false)
    await runtime.recoverSession(child.id)
    assert.equal(locks.has("invalid-cold-lock"), true)
    assert.equal(locks.parentLockID("invalid-cold-lock"), undefined)
    await assert.rejects(runtime.prepare({ agent: "worker", task: "must not run" }, f.context(child.id)), /maxDelegationDepth|cancelled|inactive/)
    assert.throws(() => locks.restore("competing-writer", { kind: "unknown-write" }), /Scope Lock/)
  })
})

test("lowered depth quarantines a running background child after reload but root cancellation stops the tree", { timeout: 3000 }, async (t) => {
  const f = fixture(t, { worker: { loadAgents: ["worker"] }, maxDelegationDepth: 2 })
  const root = await f.root()
  const rootContext = f.context(root.id, "orchestrator")
  const submissions = []
  const stopped = new Set()
  f.execution.cancelTurn = async ({ sessionID }) => {
    stopped.add(sessionID)
    return { acknowledged: true }
  }
  f.execution.inspectTurn = async ({ sessionID }) => ({ state: stopped.has(sessionID) ? "idle" : "running" })
  const start = async (context) => {
    const started = new Promise((resolve) => {
      f.onStart((input) => { submissions.push(input); resolve() })
    })
    const result = JSON.parse(await f.background.startAgent({ agent: "worker", task: "background work across reload" }, context))
    await started
    await setImmediate()
    assert.equal(sessionO4E(await f.store.get(result.sessionID)).task.status, "running")
    return result
  }
  const parent = await start(rootContext)
  const child = await start(f.context(parent.sessionID))
  assert.equal(sessionO4E(await f.store.get(child.sessionID)).delegation.depth, 2)
  await f.background.flush()
  f.background.dispose()
  f.runtime.dispose()
  f.snapshot.runtime.config.maxDelegationDepth = 1

  const locks = new ScopeLockManager()
  const delegation = new DelegationRuntime({ store: f.store, directory: f.directory, locks, execution: f.execution, snapshot: () => f.snapshot })
  const background = new BackgroundTaskRuntime({ sessionStore: f.store, directory: f.directory, locks, execution: f.execution, delegation })
  t.after(() => { background.dispose(); delegation.dispose(); locks.clear() })
  await background.recoverSession(parent.sessionID, { dispatch: false })
  await setImmediate()
  const quarantined = await background.status({ taskID: child.taskID }, f.context(parent.sessionID))
  assert.equal(quarantined.status, "unknown")
  assert.equal(quarantined.phase, "authorization-unverifiable")
  assert.equal(quarantined.receipt, undefined)
  assert.equal(submissions.length, 2, "cold recovery must not submit another model turn")
  assert.throws(() => locks.restore("competing-writer", { kind: "unknown-write" }), /Scope Lock/)

  await background.cancel({ taskID: parent.taskID }, rootContext)
  await background.observeEvent({ kind: "session-idle", sessionID: parent.sessionID }, { dispatch: false })
  for (const task of [parent, child]) {
    const cancelled = sessionO4E(await f.store.get(task.sessionID)).task
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.receipt.status, "cancelled")
    assert.equal(stopped.has(task.sessionID), true)
  }
  assert.equal(submissions.length, 2)
  locks.restore("after-cancel", { kind: "unknown-write" })
  locks.release("after-cancel")
})

test("deleted nested foreground attempt keeps its tombstone visible under the host root", async (t) => {
  const f = fixture(t, { worker: { loadAgents: ["worker"] } })
  const parent = await f.child()
  const prepared = await f.runtime.prepare({ agent: "worker", task: "nested deletion" }, parent.context)
  await f.locks.acquire("deleted-nested-lock", prepared.effect, { parentLockID: prepared.parentLockID })
  const { child } = await f.runtime.createAttempt(prepared, parent.context, { scopeLockID: "deleted-nested-lock", dispatchMessageID: "deleted-nested-dispatch" })
  const locks = new ScopeLockManager()
  const runtime = new DelegationRuntime({ store: f.store, directory: f.directory, locks, snapshot: () => f.snapshot, execution: {
    inspectTurn: async () => ({ state: "running" }),
    cancelTurn: async () => ({ acknowledged: false }),
  } })
  t.after(() => { runtime.dispose(); locks.release("deleted-nested-lock"); locks.clear() })
  await runtime.recoverSession(child.id)
  f.sessions.delete(child.id)
  await runtime.observeEvent({ kind: "deleted", sessionID: child.id })
  const tombstone = [...f.sessions.values()].find((session) => sessionO4E(session).delegation?.executionSessionID === child.id)
  assert.equal(tombstone.parentID, parent.parent.id)
  assert.equal(sessionO4E(tombstone).delegation.parentSessionID, parent.context.sessionID)
  assert.equal(sessionO4E(tombstone).delegation.status, "unknown")
  assert.equal(locks.has("deleted-nested-lock"), true)
})

test("nested delegation cannot escape read, Plan or scoped parent effects", async (t) => {
  for (const kind of ["read", "Plan", "scoped-write"]) await t.test(kind, async (t) => {
    const f = fixture(t, { worker: {
      loadTools: kind === "scoped-write" ? ["read", "edit", "task"] : ["read", "task"],
      loadAgents: ["worker", "writer"],
      ...(kind === "Plan" ? { type: "all", planProfile: true } : {}),
    } })
    const writer = agent({ name: "writer", type: "subagent", loadTools: ["bash"], loadAgents: [] })
    f.snapshot.agents.push(writer)
    f.snapshot.agentByName.set(writer.name, writer)
    const parent = await f.child(kind === "scoped-write" ? { writeScopes: ["src"] } : {})
    const nested = await f.runtime.prepare({ agent: "worker", task: "same effect" }, parent.context)
    assert.equal(nested.effect.kind, kind === "scoped-write" ? kind : "read")
    assert.deepEqual(nested.normalizedScopes, parent.prepared.normalizedScopes)
    await assert.rejects(f.runtime.prepare({ agent: "writer", task: "wider write" }, parent.context), /不能扩大/)
    if (kind === "scoped-write") {
      await assert.rejects(f.runtime.prepare({ agent: "worker", task: "outside scope", writeScopes: ["other"] }, parent.context), /不能扩大/)
    }
  })
})

test("child authority rereads complete snapshots without accepting cancellation or ledger changes", async (t) => {
  for (const source of ["host metadata", "Task progress", "continuous changes", "delegation cancelled", "Task ledger changed", "parent reference cancelled"]) await t.test(source, { timeout: 1000 }, async (t) => {
    const f = fixture(t)
    const c = source.startsWith("Task") || source === "parent reference cancelled" ? await f.delegatedBackground() : await f.child()
    const get = f.store.get.bind(f.store)
    let reads = 0
    f.store.get = async (id) => {
      if (id === c.context.sessionID && ++reads % 2 === 0 && (reads === 2 || source === "continuous changes")) {
        const current = f.sessions.get(id)
        if (source === "Task progress") {
          const task = sessionO4E(current).task
          task.status = "waiting_tool"
          task.phase = "tool-running"
          task.revision += 1
        } else if (source === "delegation cancelled") sessionO4E(current).delegation.cancellationRequestedAt = 0
        else if (source === "Task ledger changed") sessionO4E(current).task.authorizationFingerprint = "0".repeat(64)
        else if (source === "parent reference cancelled") {
          sessionO4E(f.sessions.get(c.parent.id)).backgroundTasks.taskRefs[c.result.taskID].cancellationRequestedAt = 0
        } else current.metadata.hostProgress = reads
      }
      return get(id)
    }
    if (source === "continuous changes") {
      await assert.rejects(f.runtime.commandAuthority(c.context), /changed during validation/)
    } else if (source === "delegation cancelled") {
      await assert.rejects(f.runtime.commandAuthority(c.context), /cancellation pending/)
    } else if (source === "Task ledger changed") {
      await assert.rejects(f.runtime.commandAuthority(c.context), /ledger\/frozen parent authority mismatch/)
    } else if (source === "parent reference cancelled") {
      await assert.rejects(f.runtime.commandAuthority(c.context), /parent reference missing or cancelled/)
    } else {
      const authority = await f.runtime.commandAuthority(c.context)
      assert.equal(authority.lockOwner, c.lockOwner ?? `background-task:${c.result.taskID}`)
      assert.deepEqual(permissionRules(authority.permission), f.sessions.get(c.context.sessionID).permission)
      assert.equal(f.locks.has(authority.lockOwner), true)
    }
  })
})

test("read races and disposed Runtime never return stale child authority", async (t) => {
  const f = fixture(t)
  const c = await f.child()
  const get = f.store.get.bind(f.store)
  let reads = 0
  f.store.get = async (id) => {
    if (id === c.child.id && ++reads === 2) f.sessions.get(id).permission = []
    return get(id)
  }
  await assert.rejects(f.runtime.commandAuthority(c.context), /changed during validation/)
  f.runtime.dispose()
  await assert.rejects(f.runtime.commandAuthority(c.context), { code: "O4E_RUNTIME_DISPOSING" })
})
