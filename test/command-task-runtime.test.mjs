import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setImmediate as turn } from "node:timers/promises"
import test from "node:test"
import { CommandTaskRuntime } from "../src/runtime/command-task-runtime.mjs"
import { ScopeLockManager, createSharedScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { BackgroundTaskScheduler, createSharedBackgroundTaskScheduler } from "../src/runtime/background-task-scheduler.mjs"
import { resolveInspectionCursors } from "../src/adapters/opencode/task-inspection-resume.mjs"
import { inspectionText } from "../src/runtime/task-result-visibility.mjs"

const context = { sessionID: "owner", messageID: "message", callID: "call", agent: "main" }
const args = { command: "private-command-input", description: "private-description", timeout: 1000 }
const effect = { kind: "unknown-write" }
const clone = (value) => structuredClone(value)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

class Store {
  sessions = new Map([["owner", { id: "owner", metadata: { o4e: { unrelated: true } } }], ["other", { id: "other", metadata: {} }]])
  writes = []
  queues = new Map()
  creates = 0
  async get(id) {
    await this.onGet?.(id)
    if (!this.sessions.has(id)) throw Object.assign(new Error("missing"), { name: "NotFoundError" })
    return clone(this.sessions.get(id))
  }
  async create({ parentID, title, ...rest }) {
    assert.deepEqual(rest, {})
    await this.onCreate?.()
    const session = { id: `ledger-${++this.creates}`, ...(parentID === undefined ? {} : { parentID }), title, metadata: {} }
    this.sessions.set(session.id, session)
    return clone(session)
  }
  async updateO4E(id, transform) {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(async () => {
      const session = await this.get(id)
      const o4e = transform(clone(session.metadata?.o4e ?? {}), session)
      await this.beforeWrite?.(id, o4e)
      this.sessions.set(id, { ...session, metadata: { ...session.metadata, o4e: clone(o4e) } })
      this.writes.push({ id, o4e: clone(o4e) })
      await this.afterWrite?.(id, o4e)
      return clone(this.sessions.get(id))
    })
    this.queues.set(id, next.catch(() => {}))
    return next
  }
  ref(taskID) { return this.sessions.get("owner").metadata.o4e.commandTasks.refs[taskID] }
  record(taskID) { return this.ref(taskID).recovery }
}

class Execution {
  handles = new Map()
  starts = []
  cancels = []
  start(input) {
    this.beforeStart?.(input)
    assert.equal(this.handles.has(input.executionID), false)
    this.starts.push(input)
    const completion = deferred()
    let value = { status: "running", stopped: false, output: "", totalBytes: 0, truncated: false,
      logPath: "/tmp/o4e-test-command.log", logBytes: 0, logComplete: false }
    let finished = false
    const handle = {
      executionID: input.executionID, done: completion.promise,
      snapshot: () => clone(value),
      append: (output) => { value = { ...value, output, totalBytes: Buffer.byteLength(output), logBytes: Buffer.byteLength(output) }; input.onUpdate?.(clone(value)) },
      finish: (patch = {}) => {
        if (finished && value.stopped) return clone(value)
        const first = !finished
        finished = true
        value = { ...value, status: "completed", stopped: true, exitCode: 0,
          logComplete: patch.stopped !== false && !patch.logError, ...patch }
        if (first) completion.resolve(clone(value))
        input.onUpdate?.(clone(value))
        return clone(value)
      },
      cancel: async () => {
        this.cancels.push(input.executionID)
        if (finished && value.stopped) return clone(value)
        return this.onCancel ? this.onCancel(handle) : handle.finish({ status: "cancelled" })
      },
    }
    this.handles.set(input.executionID, handle)
    return handle
  }
  get(id) { this.onGet?.(id); return this.handles.get(id) }
}

function fixture(options = {}) {
  const store = options.store ?? new Store()
  const execution = options.execution ?? new Execution()
  const locks = options.locks ?? new ScopeLockManager()
  const directory = options.directory ?? `/tmp/opencode/command-runtime-${randomUUID()}`
  const limits = options.limits ?? { maxConcurrentCommands: 1 }
  const scheduler = options.scheduler ?? createSharedBackgroundTaskScheduler(directory, limits)
  const runtime = new CommandTaskRuntime({ ...options, store, execution, directory, limits, scheduler })
  const active = (taskID) => {
    assert.equal(locks.has(taskID), false, "Command must never own a Scope Lock")
    return scheduler.isActive({ taskID, kind: "command", ownerSessionID: "owner" })
  }
  return { runtime, store, execution, locks, directory, scheduler, active,
    reload: (extra = {}) => new CommandTaskRuntime({ store, execution, directory, limits, ...extra }) }
}

async function started(f, options) {
  const snapshot = await f.runtime.start(args, context, options)
  await turn()
  assert.equal(f.execution.starts.length, 1)
  return snapshot
}

test("root commands execute concurrently under an Agent write lock, bounded only by command slots", async (t) => {
  const f = fixture({ limits: { maxConcurrentCommands: 2 } })
  t.after(() => f.runtime.dispose())
  await f.locks.acquire("writer-agent", effect)
  t.after(() => f.locks.release("writer-agent"))
  const first = await f.runtime.start(args, context)
  const second = await f.runtime.start(args, { ...context, callID: "second" })
  const third = await f.runtime.start(args, { ...context, callID: "third" })
  await turn()
  assert.deepEqual(f.execution.starts.map((entry) => entry.executionID), [first.taskID, second.taskID])
  assert.equal(f.store.record(third.taskID).status, "queued")
  for (const task of [first, second, third]) assert.equal(f.locks.has(task.taskID), false)
  assert.equal(f.locks.has("writer-agent"), true)
  f.execution.get(first.taskID).finish()
  await turn()
  assert.deepEqual(f.execution.starts.map((entry) => entry.executionID), [first.taskID, second.taskID, third.taskID])
  assert.equal(f.execution.get(second.taskID).snapshot().stopped, false)
})

test("command cancel rejects reason before recovery and accepts the minimal call", async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  const task = await started(f)
  const writes = f.store.writes.length
  await assert.rejects(f.runtime.handle({ action: "cancel", taskID: task.taskID, reason: "stop" }, context), /reason is not supported/)
  assert.equal(f.store.writes.length, writes)
  assert.deepEqual(f.execution.cancels, [])
  const result = await f.runtime.handle({ action: "cancel", taskID: task.taskID }, context)
  assert.equal(result.status, "cancelled")
  assert.equal(result.stopped, true)
})

test("command watch returns only states and output always reads the retained body", async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  const task = await started(f)
  const body = "  captured\n\ntext  \n"
  f.execution.get(task.taskID).append(body)
  f.execution.get(task.taskID).finish()
  const watched = await f.runtime.watchSelection([task.taskID], context)
  const states = await watched.tasks()
  assert.equal(states[0].output, undefined)
  assert.equal(states[0].tail, undefined)
  assert.equal((await f.runtime.handle({ action: "output", taskID: task.taskID }, context)).output, body)
  assert.equal((await f.runtime.handle({ action: "output", taskID: task.taskID }, context)).output, body)
})

test("watch selection freezes owner membership, observes settlement, and rechecks a removed index", async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  const first = await started(f)
  const selection = await f.runtime.watchSelection(undefined, context)
  const settled = deferred()
  const unsubscribe = selection.subscribe(() => settled.resolve())
  t.after(unsubscribe)
  const second = await f.runtime.start(args, { ...context, callID: "later" })
  assert.deepEqual((await selection.tasks()).map((task) => task.taskID), [first.taskID])
  f.execution.get(first.taskID).append("private output")
  assert.equal((await selection.tasks())[0].output, undefined)
  f.execution.get(first.taskID).finish()
  await settled.promise
  assert.equal((await selection.tasks())[0].status, "completed")
  await assert.rejects(f.runtime.watchSelection([first.taskID], { ...context, sessionID: "other" }), /NOT_OWNED/)
  const refs = f.store.sessions.get("owner").metadata.o4e.commandTasks.refs
  const saved = refs[first.taskID]
  delete refs[first.taskID]
  await assert.rejects(selection.tasks(), /INDEX|NOT_OWNED/)
  refs[first.taskID] = saved
  assert.notEqual(second.taskID, first.taskID)
})

test("start returns a canonical queued command, claims before port start, and never stores raw input", async () => {
  const f = fixture()
  const ownerAgent = { kind: "agent", sentinel: "owner-ledger" }
  f.store.sessions.get("owner").metadata.o4e.task = clone(ownerAgent)
  f.execution.beforeStart = ({ executionID }) => {
    assert.equal(f.store.record(executionID).phase, "claim-persisted")
    assert.equal(f.store.ref(executionID).claim, f.store.record(executionID).claim)
    assert.equal(f.active(executionID), true)
  }
  const queued = await f.runtime.start(args, context)
  assert.equal(queued.kind, "command")
  assert.equal(queued.status, "queued")
  assert.equal(queued.executionID, queued.taskID)
  assert.equal(queued.taskSessionID, context.sessionID)
  assert.equal(f.store.creates, 0)
  assert.equal(f.store.sessions.get(queued.taskSessionID).parentID, undefined)
  assert.equal(f.store.record(queued.taskID).ownerSessionID, context.sessionID)
  assert.equal(f.store.record(queued.taskID).taskSessionID, queued.taskSessionID)
  assert.equal(f.execution.starts.length, 0)
  assert.equal(f.runtime.owns(queued.taskID), true)
  assert.equal(f.runtime.owns("o4e_task_fake"), false)
  await turn()
  const handle = f.execution.get(queued.taskID)
  handle.append("hello")
  const writes = f.store.writes.length
  for (let i = 0; i < 100; i += 1) handle.append("hello")
  assert.equal(f.store.writes.length, writes)
  assert.equal((await f.runtime.handle({ action: "output", taskID: queued.taskID }, context)).output, "hello")
  handle.finish()
  const status = await f.runtime.handle({ action: "status", taskID: queued.taskID }, context)
  assert.equal(status.status, "completed")
  assert.equal(f.store.ref(queued.taskID).recovery.result.output, "hello")
  assert.equal(f.active(queued.taskID), false)
  assert.deepEqual(f.store.sessions.get("owner").metadata.o4e.task, ownerAgent)
  const persisted = JSON.stringify([...f.store.sessions.values()])
  assert.equal(persisted.includes(args.command), false)
  assert.equal(persisted.includes(args.description), false)
  assert.equal(persisted.includes("backgroundTasks"), false)
  assert.equal(persisted.includes("delegation"), false)
  await f.runtime.dispose()
})

test("invalid execution settlement is quarantined as unknown and retains its command slot", async () => {
  const invalid = { status: "running", stopped: true, output: "", totalBytes: 0, truncated: false }
  const settled = { status: "unknown", stopped: true, output: "", totalBytes: 0, truncated: true,
    reason: "output-or-exit-unconfirmed" }
  let current = invalid
  const handle = {
    done: Promise.resolve(invalid),
    snapshot: () => clone(current),
    cancel: async () => { current = settled; return clone(settled) },
  }
  const execution = {
    start: () => handle,
    get: () => handle,
  }
  const f = fixture({ execution })
  const snapshot = await f.runtime.start(args, context)
  await turn()
  await turn()
  assert.equal(f.store.record(snapshot.taskID).status, "unknown")
  assert.equal(f.store.record(snapshot.taskID).phase, "settlement-unconfirmed")
  assert.equal(f.store.record(snapshot.taskID).stopped, false)
  assert.equal(f.active(snapshot.taskID), true)
  const cancelled = await f.runtime.cancelKnown("owner", snapshot.taskID)
  assert.equal(cancelled[0].status, "unknown")
  assert.equal(cancelled[0].stopped, true)
  assert.equal(f.active(snapshot.taskID), false)
  await f.runtime.dispose()
})

test("racing facades and reloaded module serialize a source call into one execution", async () => {
  const f = fixture()
  const { CommandTaskRuntime: Reloaded } = await import(`../src/runtime/command-task-runtime.mjs?test=${randomUUID()}`)
  const second = new Reloaded(f)
  const snapshots = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? second : f.runtime).start(args, context)))
  assert.equal(new Set(snapshots.map((value) => value.taskID)).size, 1)
  assert.equal(f.store.creates, 0)
  await turn()
  assert.equal(f.execution.starts.length, 1)
  await assert.rejects(second.start({ ...args, command: "changed" }, context), /CALL_MISMATCH/)
  f.execution.get(snapshots[0].taskID).finish()
  await second.recoverSession(context)
  assert.equal((await second.start(args, context)).status, "completed")
  await f.runtime.dispose()
})

test("child command identity never borrows or retains an Agent lock across facades", async () => {
  const directory = `/tmp/opencode/command-runtime-${randomUUID()}`
  const locks = createSharedScopeLockManager(directory)
  const secondLocks = createSharedScopeLockManager(directory)
  const f = fixture({ directory, locks })
  const second = f.reload({ locks: secondLocks })
  await locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent", parentTaskID: "parent-task" })
  const next = await second.start(args, { ...context, sessionID: "other" }, { lockOwner: "parent" })
  locks.release("parent")
  await turn()
  assert.equal(f.execution.starts.length, 2)
  assert.equal(locks.has("parent"), false)
  f.execution.get(first.taskID).finish()
  await turn()
  assert.equal(f.execution.starts.length, 2)
  assert.equal(locks.has("parent"), false)
  f.execution.get(next.taskID).finish()
  await second.recoverSession({ sessionID: "other" })
  assert.equal(locks.has("parent"), false)
  await f.runtime.dispose()
  await second.dispose()
  locks.clear()
  secondLocks.clear()
})

test("child commands rely on beforeStart authority, never on borrowing a caller lock", async () => {
  for (const scoped of [false, true]) {
    const f = fixture()
    if (scoped) f.locks.restore("parent", { kind: "scoped-write", writeScopes: ["/tmp/opencode/scoped"] })
    const snapshot = await f.runtime.start(args, context, { lockOwner: "parent", beforeStart: () => { throw new Error("authority denied") } })
    await turn()
    assert.equal(f.store.record(snapshot.taskID).status, "interrupted")
    assert.equal(f.execution.starts.length, 0)
    assert.equal(f.store.creates, 0)
    assert.deepEqual(f.locks.restore("unrelated", { kind: "scoped-write", writeScopes: ["/tmp/opencode/other"] }), { ok: true })
    await f.runtime.dispose()
  }
})

test("queued cancellation blocks submission, including a command waiting for a resource slot", async () => {
  for (const waiting of [false, true]) {
    const f = fixture()
    if (waiting) await started(f)
    const snapshot = await f.runtime.start(args, { ...context, callID: "cancel-queued" })
    if (waiting) await turn()
    const cancelled = await f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.phase, "not-submitted")
    await turn()
    assert.equal(f.execution.starts.length, waiting ? 1 : 0)
    assert.equal(f.active(snapshot.taskID), false)
    await f.runtime.dispose()
  }
})

test("cancel returns actual port settlement and cancelOwned stops all children", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  const outcomes = await f.runtime.cancelOwned("owner")
  assert.deepEqual(outcomes.map((value) => value.status), ["cancelled", "cancelled"])
  assert.equal(f.execution.starts.length, 1)
  assert.equal(f.store.record(first.taskID).result.status, "cancelled")
  assert.equal(f.store.record(second.taskID).claim, null)
  assert.equal(f.locks.has("parent"), true)
  f.locks.release("parent")
  await f.runtime.dispose()
})

test("watch abort and read budget timeout cancel only the reader, including slow recovery", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const abort = new AbortController()
  const watch = f.runtime.watchSelection([snapshot.taskID], { ...context, abort: abort.signal })
  abort.abort(new Error("reader-only"))
  await assert.rejects(watch, /reader-only/)
  const blocked = deferred()
  f.store.onGet = () => blocked.promise
  await assert.rejects(f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, ioTimeoutMs: 5 }, context), { name: "TaskReadTimeoutError" })
  assert.equal(f.execution.cancels.length, 0)
  assert.equal(f.active(snapshot.taskID), true)
  f.store.onGet = undefined
  blocked.resolve()
  await f.runtime.dispose()
})

test("reload reattaches done and commits terminal output even without later reads", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const second = f.reload()
  await second.recoverSession(context)
  f.execution.get(snapshot.taskID).append("persist me")
  f.execution.get(snapshot.taskID).finish({ status: "failed", exitCode: 7, reason: "nonzero-exit" })
  await turn()
  assert.equal(f.store.record(snapshot.taskID).status, "failed")
  assert.equal(f.store.record(snapshot.taskID).result.output, "persist me")
  f.execution.handles.clear()
  const output = await second.handle({ action: "output", taskID: snapshot.taskID }, context)
  assert.equal(output.status, "failed")
  assert.equal(output.exitCode, 7)
  assert.equal(output.output, "persist me")
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
})

test("claimed missing handles stay unknown and retain command slots; source reentry never starts again", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.execution.handles.clear()
  // A fresh directory simulates a new process without shared Runtime entries.
  const restarted = fixture({ store: f.store, execution: new Execution() })
  const recovered = await restarted.runtime.recoverSession(context)
  assert.equal(recovered[0].status, "unknown")
  assert.equal(restarted.active(snapshot.taskID), true)
  assert.equal((await restarted.runtime.start({ ...args, cwd: snapshot.cwd }, context)).taskID, snapshot.taskID)
  assert.equal(restarted.execution.starts.length, 0)
  const cancelled = await restarted.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
  assert.equal(cancelled.stopped, false)
  assert.equal(restarted.active(snapshot.taskID), true)
  await assert.rejects(restarted.runtime.cancelOwned("owner"), /CANCEL_UNCONFIRMED/)
})

test("owner deletion rejects recovery and never recreates a Session or replays a command", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.sessions.delete(snapshot.taskSessionID)
  const restarted = fixture({ store: f.store })
  await assert.rejects(restarted.runtime.recoverSession(context), /missing/)
  await assert.rejects(restarted.runtime.start({ ...args, cwd: snapshot.cwd }, context), /missing/)
  assert.equal(f.active(snapshot.taskID), true)
  assert.equal(restarted.execution.starts.length, 0)
  assert.equal(f.store.creates, 0)
  assert.equal(f.store.sessions.has("owner"), false)
})

test("owner native parent metadata does not turn command storage into a navigation Session", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.sessions.get(snapshot.taskSessionID).parentID = context.sessionID
  const restarted = fixture({ store: f.store, execution: f.execution })
  const recovered = await restarted.runtime.recoverSession(context)
  assert.equal(recovered[0].taskSessionID, snapshot.taskSessionID)
  assert.equal(recovered[0].ownerSessionID, context.sessionID)
})

test("command recovery rejects canonical owner or Session identity tampering", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.record(snapshot.taskID).ownerSessionID = "other"
  await assert.rejects(f.reload().recoverSession(context), /INVALID_LEDGER/)

  const g = fixture()
  const second = await started(g)
  const originalGet = g.store.get.bind(g.store)
  g.store.get = async (id) => {
    const value = await originalGet(id)
    return id === second.taskSessionID ? { ...value, id: "spoofed" } : value
  }
  await assert.rejects(g.reload().recoverSession(context), /INVALID_LEDGER/)
})

test("recovery rejects old standalone layout without reading, migrating or deleting historical Sessions", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const historical = clone(f.store.record(snapshot.taskID))
  historical.taskSessionID = "historical-command"
  f.store.ref(snapshot.taskID).taskSessionID = historical.taskSessionID
  f.store.ref(snapshot.taskID).recovery = historical
  f.store.sessions.set(historical.taskSessionID, { id: historical.taskSessionID, metadata: { o4e: { task: clone(historical) } } })
  const before = clone([...f.store.sessions])
  const restarted = fixture({ store: f.store })
  f.store.onGet = (id) => assert.equal(id, "owner")
  await assert.rejects(restarted.runtime.recoverSession(context), /INVALID_LEDGER/)
  await assert.rejects(f.runtime.start(args, context), /INVALID_LEDGER/)
  assert.deepEqual([...f.store.sessions], before)
  assert.equal(f.store.creates, 0)
  assert.equal(f.execution.starts.length, 1)
  assert.equal(restarted.execution.starts.length, 0)
  assert.equal(f.active(snapshot.taskID), true)
})

test("recovery validates complete owner record and ref provenance before discovering handles", async () => {
  for (const mutate of [
    (ref) => { ref.callKey = "forged" },
    (ref) => { ref.claim = "forged" },
    (ref) => { ref.recovery.source.sessionID = "other" },
    (ref) => { delete ref.recovery.descriptionHash },
    (ref) => { ref.recovery.command = "must-not-replay" },
    (ref) => { ref.recovery.result = { status: "completed", stopped: true } },
  ]) {
    const f = fixture()
    const snapshot = await started(f)
    mutate(f.store.ref(snapshot.taskID))
    const restarted = fixture({ store: f.store })
    restarted.execution.onGet = () => assert.fail("must not discover an unverifiable command")
    await assert.rejects(restarted.runtime.recoverSession(context), /INVALID_INDEX|INVALID_LEDGER|INVALID_RESULT/)
    assert.equal(f.active(snapshot.taskID), true)
    assert.equal(restarted.execution.starts.length, 0)
  }
})

test("deleting the owner stops its known command process and retains the unpersisted slot", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.sessions.delete(snapshot.taskSessionID)
  await assert.rejects(f.runtime.cancelKnown(snapshot.taskSessionID), /missing/)
  assert.equal(f.execution.get(snapshot.taskID).snapshot().stopped, true)
  assert.equal(f.active(snapshot.taskID), true)
  await assert.rejects(f.runtime.recoverSession(context), /missing/)
  await assert.rejects(f.runtime.dispose(), /missing/)
  assert.equal(f.active(snapshot.taskID), true)
  assert.equal(f.store.creates, 0)
  assert.equal(f.store.sessions.has("owner"), false)
})

test("all uncertain owner slots are restored without locks before any execution query or other-owner scan", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  // Seed a second uncertain durable claim to represent independent pre-crash evidence.
  for (const record of [f.store.record(second.taskID), f.store.ref(second.taskID).recovery]) {
    Object.assign(record, { status: "running", phase: "claim-persisted", claim: randomUUID(), stopped: false })
  }
  f.store.ref(second.taskID).recovery.claim = f.store.record(second.taskID).claim
  f.store.ref(second.taskID).claim = f.store.record(second.taskID).claim
  const restarted = fixture({ store: f.store })
  const reads = []
  f.store.onGet = (id) => { reads.push(id) }
  restarted.execution.onGet = () => {
    assert.equal(restarted.active(first.taskID), true)
    assert.equal(restarted.active(second.taskID), true)
  }
  await restarted.runtime.recoverSession(context)
  assert.equal(reads.includes("other"), false)
  assert.equal(restarted.execution.starts.length, 0)
})

test("owner reservation failure or lost response never executes and recovers only persisted unsubmitted records", async () => {
  for (const timing of ["beforeWrite", "afterWrite"]) {
    const f = fixture()
    await f.locks.acquire("parent", effect)
    f.store[timing] = () => { throw new Error("reservation unconfirmed") }
    await assert.rejects(f.runtime.start(args, context, { lockOwner: "parent" }), /reservation unconfirmed/)
    f.locks.release("parent")
    assert.equal(f.locks.has("parent"), false)
    f.store[timing] = undefined
    const recovered = await f.reload().recoverSession(context)
    if (timing === "afterWrite") {
      assert.equal(recovered[0].status, "interrupted")
      assert.equal(recovered[0].stopped, true)
      assert.equal((await f.runtime.start(args, context)).taskID, recovered[0].taskID)
    } else assert.deepEqual(recovered, [])
    assert.equal(f.store.creates, 0)
    assert.equal(f.execution.starts.length, 0)
    await f.runtime.dispose()
  }
})

test("owner claim CAS loss before port submission retains admission and never retries", async () => {
  const f = fixture()
  f.store.afterWrite = (id, o4e) => {
    const record = Object.values(o4e.commandTasks.refs)[0].recovery
    if (record.phase !== "claim-persisted") return
    const ref = f.store.ref(record.taskID)
    ref.claim = ref.recovery.claim = "another-claim"
    ref.recovery.status = "running"
    ref.recovery.stopped = false
  }
  const snapshot = await f.runtime.start(args, context)
  await turn()
  assert.equal(f.execution.starts.length, 0)
  assert.equal(f.active(snapshot.taskID), true)
  await assert.rejects(f.reload().recoverSession(context), /INVALID_LEDGER/)
  assert.equal(f.execution.starts.length, 0)
})

test("resolved but unconfirmed owner writes cannot start a command or release a terminal slot", async () => {
  for (const phase of ["claim-persisted", "stopped"]) {
    const f = fixture()
    const update = f.store.updateO4E.bind(f.store)
    const installFailure = () => {
      f.store.updateO4E = async (id, transform) => {
        const before = await f.store.get(id)
        const next = transform(clone(before.metadata.o4e), before)
        if (Object.values(next.commandTasks.refs).some((ref) => ref.recovery.phase === phase)) return before
        return update(id, transform)
      }
    }
    if (phase === "claim-persisted") installFailure()
    const snapshot = await f.runtime.start(args, context)
    await turn()
    if (phase === "stopped") {
      installFailure()
      f.execution.get(snapshot.taskID).finish()
      await turn()
    }
    assert.equal(f.active(snapshot.taskID), true)
    assert.equal(f.execution.starts.length, phase === "stopped" ? 1 : 0)
    f.store.updateO4E = update
    const recovered = (await f.runtime.recoverSession(context))[0]
    assert.equal(recovered.status, phase === "stopped" ? "completed" : "interrupted")
    assert.equal(f.active(snapshot.taskID), false)
    assert.equal((await f.runtime.start(args, context)).taskID, snapshot.taskID)
    assert.equal(f.execution.starts.length, phase === "stopped" ? 1 : 0)
    await f.runtime.dispose()
  }
})

test("failed terminal owner persistence or acknowledgment retains resource slot until confirmed", async () => {
  for (const timing of ["beforeWrite", "afterWrite"]) {
    const f = fixture()
    await f.locks.acquire("parent", effect)
    const snapshot = await started(f, { lockOwner: "parent" })
    f.locks.release("parent")
    f.store[timing] = (id, o4e) => {
      if (Object.values(o4e.commandTasks.refs).some((ref) => ref.recovery.status === "completed")) throw new Error("terminal persistence failed")
    }
    f.execution.get(snapshot.taskID).finish()
    await turn()
    assert.equal(f.locks.has("parent"), false)
    assert.equal(f.active(snapshot.taskID), true)
    assert.equal(f.store.ref(snapshot.taskID).recovery.status, timing === "beforeWrite" ? "running" : "completed")
    if (timing === "beforeWrite") {
      await assert.rejects(f.runtime.dispose())
      assert.equal(f.active(snapshot.taskID), true)
    }
    f.store[timing] = undefined
    await f.runtime.dispose()
    assert.equal(f.store.ref(snapshot.taskID).recovery.status, "completed")
    assert.equal(f.active(snapshot.taskID), false)
  }
})

test("unconfirmed cancellation/dispose preserves command slot without a write lock", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const snapshot = await started(f, { lockOwner: "parent" })
  f.locks.release("parent")
  f.execution.onCancel = (handle) => handle.finish({ status: "unknown", stopped: false, reason: "process-group-unconfirmed" })
  const result = await f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
  assert.equal(result.status, "unknown")
  assert.equal(result.stopped, false)
  await assert.rejects(f.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
  assert.equal(f.locks.has("parent"), false)
  assert.equal(f.active(snapshot.taskID), true)
})

test("all actions enforce owner membership and reject interactive/restart or group selectors", async () => {
  const f = fixture()
  const snapshot = await started(f)
  for (const action of ["status", "cancel"]) {
    await assert.rejects(f.runtime.handle({ action, taskID: snapshot.taskID }, { ...context, sessionID: "other" }), /NOT_OWNED/)
  }
  await assert.rejects(f.runtime.handle({ action: "input", taskID: snapshot.taskID }, context), /UNSUPPORTED_ACTION/)
  await assert.rejects(f.runtime.handle({ action: "status" }, context), /TASK_ID_REQUIRED/)
  await assert.rejects(f.runtime.handle({ action: "status", taskID: snapshot.taskID, taskIDs: [snapshot.taskID] }, context), /TASK_ID_REQUIRED/)
  assert.equal(f.execution.cancels.length, 0)
  await f.runtime.dispose()
})

test("inspect uses bounded UTF-8 byte cursors, binds identity/prefix and fails closed on unknown positions", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const handle = f.execution.get(snapshot.taskID)
  handle.append("a\u00e9\u4e2d\ud83d\ude00bc")
  const read = (options = {}) => f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, maxBytes: 4, ...options }, context)
  const first = await read()
  assert.ok(Buffer.byteLength(first.tail) <= 4)
  assert.equal(first.tail.includes("\ufffd"), false)
  assert.ok(first.beforeCursor)
  assert.ok(first.cursor.length <= 512)
  const before = await read({ cursor: first.beforeCursor, direction: "backward" })
  assert.equal(before.tail, "\ud83d\ude00")
  handle.append("a\u00e9\u4e2d\ud83d\ude00bcNEXT")
  assert.equal((await read({ cursor: first.cursor })).tail, "NEXT")
  assert.equal((await read({ cursor: "unknown" })).gap, "cursor-invalid-or-output-changed")
  handle.append("changed prefix")
  assert.ok((await read({ cursor: first.cursor })).gap)
  await assert.rejects(read({ cursors: { other: "cursor" } }), /cursors/)
  await f.runtime.dispose()
})

test("resume reads only inspect history and retains an append position", async () => {
  const f = fixture({ inspectionCursorResolver: resolveInspectionCursors })
  const snapshot = await started(f)
  f.execution.get(snapshot.taskID).append("first")
  const preview = await f.runtime.handle({ action: "inspect", taskID: snapshot.taskID }, context)
  f.store.messagePage = async (sessionID) => ({ messages: [{ info: { id: "next-message", sessionID, role: "assistant" }, parts: [
    { type: "tool", tool: "o4e_task", callID: "previous", state: { status: "completed", input: { action: "inspect", taskID: snapshot.taskID },
      output: inspectionText(preview, "command"), metadata: { kind: "command", o4eResult: preview } } },
    { type: "tool", tool: "o4e_task", callID: "next-call", state: { status: "running", input: { action: "inspect", taskID: snapshot.taskID, resume: true } } },
  ] }] })
  f.execution.get(snapshot.taskID).append("firstNEXT")
  const resumed = await f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, resume: true }, { ...context, messageID: "next-message", callID: "next-call" })
  assert.equal(resumed.tail, "NEXT")
  const unavailable = await f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, resume: true }, context)
  assert.equal(unavailable.unavailable, "resume-boundary-unavailable")
  assert.equal(unavailable.tail, undefined)
  await f.runtime.dispose()
})

test("corrupt command canonical ledger is rejected without invoking Agent normalization", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.record(snapshot.taskID).model = { leaked: true }
  await assert.rejects(f.reload().recoverSession(context), /INVALID_LEDGER/)
  assert.equal(f.active(snapshot.taskID), true)
})

test("root and child commands in separate owner lanes execute while an Agent holds its lock", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const standalone = await f.runtime.start(args, { ...context, sessionID: "other" })
  await turn()
  assert.equal(f.execution.starts.length, 1)
  const child = await f.runtime.start(args, context, { lockOwner: "parent" })
  await turn()
  assert.deepEqual(f.execution.starts.map((input) => input.executionID), [standalone.taskID, child.taskID])
  assert.equal(f.locks.has("parent"), true)
  f.locks.release("parent")
  assert.equal(f.locks.has("parent"), false)
  await f.runtime.dispose()
})

test("disposal during durable claim prevents port submission after the write completes", async () => {
  const f = fixture()
  const gate = deferred()
  const entered = deferred()
  f.store.beforeWrite = async (id, o4e) => {
    if (id !== "owner" || !Object.values(o4e.commandTasks.refs).some((ref) => ref.claim)) return
    entered.resolve()
    await gate.promise
  }
  const snapshot = await f.runtime.start(args, context)
  await entered.promise
  const disposing = f.runtime.dispose()
  gate.resolve()
  await disposing
  assert.equal(f.execution.starts.length, 0)
  assert.equal(f.store.record(snapshot.taskID).status, "cancelled")
  assert.equal(f.active(snapshot.taskID), false)
})

test("fresh recovery interrupts an unsubmitted queued ledger without execution or a Scope Lock", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const snapshot = await f.runtime.start(args, context, { lockOwner: "parent" })
  const restarted = fixture({ store: f.store })
  const recovered = await restarted.runtime.recoverSession(context)
  assert.equal(recovered[0].status, "interrupted")
  assert.equal(recovered[0].phase, "not-submitted")
  assert.equal(restarted.execution.starts.length, 0)
  assert.equal(restarted.active(snapshot.taskID), false)
  assert.equal((await restarted.runtime.start({ ...args, cwd: snapshot.cwd }, context)).taskID, snapshot.taskID)
  // The old facade's CAS must also reject its now-stale queued admission.
  await turn()
  assert.equal(f.execution.starts.length, 0)
  await f.runtime.dispose()
  await restarted.runtime.dispose()
})

test("new ESM facade can drain older facade queued commands without private-brand errors", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  const { CommandTaskRuntime: Reloaded } = await import(`../src/runtime/command-task-runtime.mjs?drain=${randomUUID()}`)
  const second = new Reloaded(f)
  await second.recoverSession(context)
  f.execution.get(first.taskID).finish()
  await second.recoverSession(context)
  await turn()
  assert.equal(f.execution.starts.length, 2)
  f.execution.get(queued.taskID).finish()
  await f.runtime.dispose()
})

test("disposing a read facade notifies its watch selection without cancelling another facade's process", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const reader = f.reload()
  const watch = await reader.watchSelection([snapshot.taskID], context)
  let notified = false
  const unsubscribe = watch.subscribe(() => { notified = true })
  await reader.dispose()
  assert.equal(notified, true)
  await assert.rejects(watch.tasks(), /DISPOSED/)
  unsubscribe()
  assert.equal(f.execution.cancels.length, 0)
  await f.runtime.dispose()
})

test("port result snapshots and durable output remain bounded even when a port violates its output cap", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const handle = f.execution.get(snapshot.taskID)
  handle.append("\u4e2d".repeat(40000))
  handle.finish({ status: "cancelled", reason: "cancelled" })
  const output = await f.runtime.handle({ action: "output", taskID: snapshot.taskID }, context)
  assert.equal(output.status, "cancelled")
  assert.equal(output.truncated, true)
  assert.ok(Buffer.byteLength(output.output) <= 65536)
  assert.equal(output.output.includes("\ufffd"), false)
  assert.ok(Buffer.byteLength(f.store.record(snapshot.taskID).result.output) <= 65536)
  const inspect = await f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, maxBytes: 8192 }, context)
  assert.ok(Buffer.byteLength(inspect.tail) <= 8192)
  assert.equal(inspect.gap, "output-truncated")
  await f.runtime.dispose()
})

test("rejected port start is never retried, while an existing shared handle is reattached", async () => {
  for (const withHandle of [false, true]) {
    const f = fixture()
    const start = f.execution.start.bind(f.execution)
    let calls = 0
    f.execution.start = (input) => {
      calls += 1
      if (withHandle) start(input)
      throw new Error("start acknowledgment lost")
    }
    const snapshot = await f.runtime.start(args, context)
    await turn()
    assert.equal(calls, 1)
    const status = await f.runtime.handle({ action: "status", taskID: snapshot.taskID }, context)
    assert.equal(status.status, withHandle ? "running" : "unknown")
    assert.equal((await f.reload().start(args, context)).taskID, snapshot.taskID)
    assert.equal(calls, 1)
    if (withHandle) await f.runtime.dispose()
    else await assert.rejects(f.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
  }
})

test("unresponsive port cancellation has a finite deadline and cannot release an unconfirmed slot", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const snapshot = await started(f)
  f.execution.onCancel = () => new Promise(() => {})
  const cancelling = f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
  const rejected = assert.rejects(cancelling, /WAIT_TIMEOUT/)
  await turn()
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  assert.equal(timer.ms, 10000)
  timer.fn()
  await rejected
  assert.equal(f.active(snapshot.taskID), true)
  f.execution.onCancel = undefined
  await f.runtime.dispose()
})

test("dispose stops its live process even when owner recovery is unavailable and keeps the slot", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.onGet = () => { throw new Error("store unavailable") }
  await assert.rejects(f.runtime.dispose(), /store unavailable/)
  assert.ok(f.execution.cancels.length > 0)
  assert.equal(f.execution.get(snapshot.taskID).snapshot().stopped, true)
  assert.equal(f.active(snapshot.taskID), true)
  f.store.onGet = undefined
  await f.runtime.dispose()
  assert.equal(f.active(snapshot.taskID), false)
})

test("lost owner index cannot turn the same live source call into a second task", async () => {
  const f = fixture()
  const snapshot = await started(f)
  delete f.store.sessions.get("owner").metadata.o4e.commandTasks
  await assert.rejects(f.reload().start(args, context), /INDEX_MISSING/)
  assert.equal(f.execution.starts.length, 1)
  assert.equal(f.active(snapshot.taskID), true)
})

test("parent cancellation fences a queued sibling before recovery releases a completed child", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  f.execution.get(first.taskID).finish()
  const result = await f.runtime.cancelOwned("owner")
  assert.equal(f.execution.starts.length, 1)
  assert.equal(result.find((value) => value.taskID === queued.taskID).status, "cancelled")
  await f.runtime.dispose()
})

test("inspect validates the entire previous prefix through pagination and repeated appends", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const handle = f.execution.get(snapshot.taskID)
  const read = (cursor, direction) => f.runtime.handle({ action: "inspect", taskID: snapshot.taskID, maxBytes: 4, cursor, direction }, context)
  handle.append("abcdefghijkl")
  const first = await read()
  assert.equal(first.tail, "ijkl")
  const back = await read(first.beforeCursor, "backward")
  assert.equal(back.tail, "efgh")
  handle.append("abcdefghijklmnop")
  const forward = await read(back.cursor)
  assert.equal(forward.tail, "ijkl")
  assert.equal(forward.gap, undefined)
  handle.append("abcdefghijklmnopqrst")
  const appended = await read(forward.cursor)
  assert.equal(appended.tail, "mnop")
  assert.equal(appended.gap, undefined)
  handle.append("abcdefghijklmnopqrsX")
  assert.equal((await read(appended.cursor)).gap, "cursor-invalid-or-output-changed")
  handle.append("abcdefghijkl")
  assert.equal((await read(forward.cursor)).gap, "cursor-invalid-or-output-changed")
  handle.append("abcdefgXijkl")
  assert.equal((await read(first.beforeCursor, "backward")).gap, "cursor-invalid-or-output-changed")
  await f.runtime.dispose()
})

test("claim failures before and after owner acknowledgment never resubmit and recover conservatively", async () => {
  for (const timing of ["beforeWrite", "afterWrite"]) {
    const f = fixture()
    await f.locks.acquire("parent", effect)
    f.store[timing] = (id, o4e) => {
      const record = Object.values(o4e.commandTasks.refs)[0].recovery
      if (record?.phase !== "claim-persisted") return
      throw new Error("claim acknowledgment unavailable")
    }
    const snapshot = await f.runtime.start(args, context, { lockOwner: "parent" })
    await turn()
    f.locks.release("parent")
    assert.equal(f.execution.starts.length, 0)
    assert.equal(f.active(snapshot.taskID), true)
    f.store[timing] = undefined
    const claimed = timing === "afterWrite"
    const recovered = (await f.reload().recoverSession(context))[0]
    assert.equal(recovered.status, claimed ? "unknown" : "interrupted")
    assert.equal(f.active(snapshot.taskID), claimed)
    assert.equal((await f.runtime.start(args, context)).taskID, snapshot.taskID)
    assert.equal(f.execution.starts.length, 0)
    if (claimed) await assert.rejects(f.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
    else await f.runtime.dispose()
  }
})

test("terminal acknowledgment loss is retryable for cancellation after the owner commits", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const snapshot = await started(f, { lockOwner: "parent" })
  f.locks.release("parent")
  f.store.afterWrite = (id, o4e) => {
    const record = Object.values(o4e.commandTasks.refs)[0].recovery
    if (record?.status === "cancelled") throw new Error("terminal acknowledgment lost")
  }
  await assert.rejects(f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context), /terminal acknowledgment lost/)
  await turn()
  assert.equal(f.active(snapshot.taskID), true)
  f.store.afterWrite = undefined
  const recovered = await f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
  assert.equal(recovered.status, "cancelled")
  assert.equal(recovered.diagnostic, undefined)
  assert.equal(f.active(snapshot.taskID), false)
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
})

test("concurrent done and cancellation retry an unconfirmed owner settlement without recovery", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const gate = deferred()
  const entered = deferred()
  let fail = true
  f.store.beforeWrite = async (id, o4e) => {
    if (id !== "owner" || Object.values(o4e.commandTasks.refs)[0].recovery.status !== "cancelled" || !fail) return
    fail = false
    entered.resolve()
    await gate.promise
    throw new Error("first index settlement failed")
  }
  const cancelling = f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
  await entered.promise
  assert.equal(f.store.record(snapshot.taskID).status, "running")
  assert.equal(f.store.ref(snapshot.taskID).recovery.status, "running")
  assert.equal(f.active(snapshot.taskID), true)
  gate.resolve()
  const result = await cancelling
  assert.equal(result.status, "cancelled")
  assert.equal(result.diagnostic, undefined)
  assert.equal(f.active(snapshot.taskID), false)
  assert.deepEqual(f.store.record(snapshot.taskID), f.store.ref(snapshot.taskID).recovery)
  await f.runtime.dispose()
})

test("injected scheduler applies command limits and sequence without occupying the Agent lane", async () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 2, maxConcurrentAgents: 1 })
  const f = fixture({ scheduler })
  await f.locks.acquire("parent", effect)
  const commands = []
  for (let i = 0; i < 4; i += 1) commands.push(await f.runtime.start(args, { ...context, callID: `call-${i}` }, { lockOwner: "parent" }))
  await turn()
  assert.deepEqual(f.execution.starts.map((value) => value.executionID), commands.slice(0, 2).map((value) => value.taskID))
  assert.equal(scheduler.isQueued(commands[2]), true)
  const agent = { taskID: "agent-task", ownerSessionID: "owner", kind: "agent", sequence: 1, effect: "read" }
  assert.deepEqual(scheduler.enqueue(agent), [agent.taskID])
  f.execution.get(commands[0].taskID).finish()
  await turn()
  assert.equal(f.execution.starts[2].executionID, commands[2].taskID)
  f.execution.get(commands[1].taskID).finish()
  await turn()
  assert.equal(f.execution.starts[3].executionID, commands[3].taskID)
  await f.runtime.dispose()
  assert.equal(scheduler.isActive(agent), true)
  assert.equal(commands.some((record) => scheduler.isActive(record) || scheduler.isQueued(record)), false)
})

test("default shared scheduler honors configured command capacity and facade-local dispatch", async () => {
  const f = fixture({ limits: { maxConcurrentCommands: 2 } })
  const execution = new Execution()
  const second = f.reload({ execution })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  const next = await second.start(args, { ...context, callID: "next" }, { lockOwner: "parent" })
  await turn()
  assert.deepEqual(f.execution.starts.map((value) => value.executionID), [first.taskID])
  assert.deepEqual(execution.starts.map((value) => value.executionID), [next.taskID])
  const tight = f.reload({ limits: { maxConcurrentCommands: 1 } })
  const queued = await second.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  f.execution.get(first.taskID).finish()
  await turn()
  assert.equal(execution.starts.length, 1)
  execution.get(next.taskID).finish()
  await turn()
  assert.equal(execution.starts[1].executionID, queued.taskID)
  execution.get(queued.taskID).finish()
  await turn()
  await second.dispose()
  await tight.dispose()
  await f.runtime.dispose()
})

test("a recovered uncertain command occupies only its owner's command admission", async () => {
  const f = fixture()
  const unknown = await started(f)
  const restarted = fixture({ store: f.store })
  await restarted.runtime.recoverSession(context)
  restarted.locks.restore("unrelated-agent", effect)
  const queued = await restarted.runtime.start(args, { ...context, callID: "queued" })
  await turn()
  assert.equal(restarted.execution.starts.length, 0)
  const foreign = await restarted.runtime.start(args, { ...context, sessionID: "other" })
  await turn()
  assert.equal(restarted.execution.starts[0].executionID, foreign.taskID)
  assert.equal(restarted.active(unknown.taskID), true)
  await restarted.runtime.handle({ action: "cancel", taskID: queued.taskID }, context)
  await restarted.runtime.cancelOwned("other")
  await assert.rejects(restarted.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
})

test("shared scheduler restores an uncertain admission before a failed handle query", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const directory = `/tmp/opencode/command-runtime-${randomUUID()}`
  const scheduler = createSharedBackgroundTaskScheduler(directory, { maxConcurrentCommands: 1 })
  const restarted = fixture({ store: f.store, directory, scheduler })
  restarted.execution.onGet = () => { throw new Error("handle unavailable") }
  await assert.rejects(restarted.runtime.recoverSession(context), /handle unavailable/)
  assert.equal(scheduler.isActive(snapshot), true)
  assert.equal(restarted.active(snapshot.taskID), true)
  restarted.execution.onGet = undefined
  await assert.rejects(restarted.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
  assert.equal(scheduler.isActive(snapshot), true)
})

test("waitInitial detaches a running command after the independent foreground window", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const snapshot = await f.runtime.start(args, context)
  const initial = f.runtime.waitInitial(snapshot.taskID, context)
  await turn()
  const handle = f.execution.get(snapshot.taskID)
  handle.append("latest")
  const runningTimer = [...timers.values()].find(({ ms }) => ms === 10000)
  assert.ok(runningTimer)
  runningTimer.fn()
  const detached = await initial
  assert.equal(detached.status, "running")
  assert.equal(detached.output, "latest")
  assert.equal(f.execution.starts[0].timeout, 1000, "the running wait must not replace the execution timeout")
  assert.equal(f.execution.cancels.length, 0)
  assert.equal(f.active(snapshot.taskID), true)
  handle.finish()
  await f.runtime.recoverSession(context)
  await f.runtime.dispose()
})

test("waitInitial returns early on completion, queues time out, and abort affects only its reader", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const abort = new AbortController()
  const aborted = f.runtime.waitInitial(snapshot.taskID, { ...context, abort: abort.signal })
  abort.abort(new Error("initial-reader-only"))
  await assert.rejects(aborted, /initial-reader-only/)
  assert.equal(f.execution.cancels.length, 0)
  const initial = f.runtime.waitInitial(snapshot.taskID, context, { timeoutMs: 60000 })
  await turn()
  f.execution.get(snapshot.taskID).append("completed output")
  f.execution.get(snapshot.taskID).finish()
  const result = await initial
  assert.equal(result.status, "completed")
  assert.equal(result.output, "completed output")
  await assert.rejects(f.runtime.waitInitial(snapshot.taskID, { ...context, sessionID: "other" }), /NOT_OWNED/)
  await assert.rejects(f.runtime.waitInitial(snapshot.taskID, context, { timeoutMs: 0 }), /INVALID_READ_OPTIONS/)
  await assert.rejects(f.runtime.waitInitial(snapshot.taskID, context, { runningTimeoutMs: 60001 }), /INVALID_READ_OPTIONS/)
  await f.runtime.dispose()
})

test("waitInitial installs the admission timeout while fresh dispatch awaits authority", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const gate = deferred()
  const snapshot = await f.runtime.start(args, context, { beforeStart: () => gate.promise })
  const initial = f.runtime.waitInitial(snapshot.taskID, context)
  await turn()
  const timer = [...timers.values()].find(({ ms }) => ms === 1000)
  assert.ok(timer, "fresh queued admission must install its timeout without waiting behind dispatch")
  timer.fn()
  const queued = await initial
  assert.equal(queued.status, "queued")
  gate.resolve()
  await turn()
  f.execution.get(snapshot.taskID).finish()
  await f.runtime.dispose()
})

test("failed dispose can reopen new admission without reviving queued work or an old claim", async () => {
  const f = fixture()
  assert.throws(() => f.runtime.resume(), /RESUME_UNAVAILABLE/)
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  f.store.onGet = () => { throw new Error("store unavailable") }
  await assert.rejects(f.runtime.dispose(), /store unavailable/)
  await assert.rejects(f.runtime.start(args, { ...context, callID: "new" }), /DISPOSED/)
  assert.equal(f.locks.has("parent"), true)
  f.store.onGet = undefined
  await f.runtime.resume()
  const next = await f.runtime.start(args, { ...context, callID: "new" }, { lockOwner: "parent" })
  assert.equal((await f.runtime.start(args, context)).taskID, first.taskID)
  await turn()
  assert.deepEqual(f.execution.starts.map((value) => value.executionID), [first.taskID, next.taskID])
  const interrupted = await f.runtime.handle({ action: "status", taskID: queued.taskID }, context)
  assert.equal(interrupted.status, "interrupted")
  assert.equal(interrupted.claim, null)
  await f.runtime.dispose()
  assert.throws(() => f.runtime.resume(), /DISPOSED/)
})

test("cancelOwned retries rejected and uncertain port cancellation without spawning a replacement", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.execution.onCancel = () => { throw new Error("cancel transport failed") }
  await assert.rejects(f.runtime.cancelOwned("owner"), /cancel transport failed/)
  assert.equal(f.active(snapshot.taskID), true)
  f.execution.onCancel = () => ({ status: "unknown", stopped: false, output: "", totalBytes: 0, truncated: false })
  await assert.rejects(f.runtime.cancelOwned("owner"), /CANCEL_UNCONFIRMED/)
  assert.equal(f.active(snapshot.taskID), true)
  f.execution.onCancel = undefined
  const results = await f.runtime.cancelOwned("owner")
  assert.equal(results[0].status, "cancelled")
  assert.equal(f.active(snapshot.taskID), false)
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
})

test("cancelOwned keeps its owner fence until every child attempt settles, including a rejected sibling", async () => {
  const f = fixture({ limits: { maxConcurrentCommands: 2 } })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  await turn()
  const entered = deferred()
  const gate = deferred()
  f.execution.onCancel = async (handle) => {
    if (handle.executionID === first.taskID) throw new Error("first cancellation failed")
    entered.resolve()
    await gate.promise
    return handle.finish({ status: "cancelled" })
  }
  const cancelling = f.runtime.cancelOwned("owner")
  const rejected = assert.rejects(cancelling, /first cancellation failed/)
  await entered.promise
  await turn()
  await assert.rejects(f.reload().start(args, { ...context, callID: "racing" }, { lockOwner: "parent" }), /OWNER_CANCELLING/)
  gate.resolve()
  await rejected
  f.execution.onCancel = undefined
  await f.runtime.cancelOwned("owner")
  assert.equal(f.execution.starts.length, 2)
  await f.runtime.dispose()
})

test("disposal fences commands admitted during recovery or owner reservation acknowledgment", async () => {
  for (const stage of ["recovery", "reservation", "acknowledgment"]) {
    const f = fixture()
    const entered = deferred()
    const gate = deferred()
    if (stage === "recovery") f.store.onGet = () => { entered.resolve(); return gate.promise }
    if (stage === "reservation") f.store.beforeWrite = (id, o4e) => {
      if (id === "owner" && Object.values(o4e.commandTasks.refs)[0].recovery.phase === "queued") {
        entered.resolve()
        return gate.promise
      }
    }
    if (stage === "acknowledgment") f.store.afterWrite = () => { entered.resolve(); return gate.promise }
    const starting = f.runtime.start(args, context)
    const result = stage === "recovery" ? assert.rejects(starting, /DISPOSED/) : starting
    await entered.promise
    const disposing = f.runtime.dispose()
    gate.resolve()
    const snapshot = await result
    await disposing
    await turn()
    assert.equal(f.execution.starts.length, 0)
    if (snapshot) {
      assert.equal(snapshot.status, "cancelled")
      assert.equal(snapshot.phase, "not-submitted")
      assert.equal(snapshot.claim, null)
      assert.equal((await f.runtime.recoverSession(context))[0].status, "cancelled")
      assert.equal(f.active(snapshot.taskID), false)
    }
  }
})

test("resume refuses a timed-out disposal whose admitted recovery is still pending", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const snapshot = await started(f)
  const gate = deferred()
  f.store.onGet = () => gate.promise
  const disposing = f.runtime.dispose()
  const rejected = assert.rejects(disposing, /WAIT_TIMEOUT/)
  await turn()
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  timer.fn()
  await rejected
  assert.equal(f.active(snapshot.taskID), true)
  assert.throws(() => f.runtime.resume(), /DISPOSE_PENDING/)
  f.store.onGet = undefined
  gate.resolve()
  await turn()
  await f.runtime.resume()
  assert.equal((await f.runtime.start(args, context)).taskID, snapshot.taskID)
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
})

test("concurrent dispose calls remain idempotent and close the facade only after confirmed settlement", async () => {
  const f = fixture()
  const snapshot = await started(f)
  await Promise.all([f.runtime.dispose(), f.runtime.dispose()])
  assert.equal(f.store.record(snapshot.taskID).status, "cancelled")
  assert.equal(f.active(snapshot.taskID), false)
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
  assert.throws(() => f.runtime.resume(), /DISPOSED/)
})

test("beforeStart runs once after resource admission, before either claim or port submission", async () => {
  for (const child of [false, true]) {
    const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 1 })
    const f = fixture({ scheduler })
    await f.locks.acquire("parent", effect)
    const blocker = await started(f)
    const gate = deferred()
    const entered = deferred()
    let checks = 0
    const options = { ...(child ? { lockOwner: "parent" } : {}), beforeStart: async () => {
      checks += 1
      assert.equal(scheduler.isActive(queued), true)
      assert.equal(f.locks.has("parent"), true)
      assert.equal(f.locks.has(queued.taskID), false)
      assert.equal(f.store.record(queued.taskID).claim, null)
      assert.equal(f.store.ref(queued.taskID).claim, null)
      entered.resolve()
      await gate.promise
    } }
    const source = { ...context, callID: "guarded" }
    const queued = await f.runtime.start(args, source, options)
    await turn()
    assert.equal(checks, 0)
    assert.equal((await f.reload().start(args, source, { beforeStart: () => { throw new Error("duplicate check") } })).taskID, queued.taskID)
    f.execution.get(blocker.taskID).finish()
    await entered.promise
    assert.equal(f.execution.starts.length, 1)
    gate.resolve()
    await turn()
    assert.equal(checks, 1)
    assert.equal(f.execution.starts.at(-1).executionID, queued.taskID)
    assert.equal(Object.hasOwn(f.execution.starts.at(-1), "beforeStart"), false)
    assert.equal(JSON.stringify([...f.store.sessions.values()]).includes("beforeStart"), false)
    await f.runtime.dispose()
  }
})

test("beforeStart rejection is unsubmitted and never retried; failed interruption persistence retains only the slot", async () => {
  for (const stage of ["none", "owner-before", "owner-after"]) {
    const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 1 })
    const f = fixture({ scheduler })
    await f.locks.acquire("parent", effect)
    const timing = stage.endsWith("after") ? "afterWrite" : "beforeWrite"
    if (stage !== "none") f.store[timing] = (id, o4e) => {
      const record = Object.values(o4e.commandTasks.refs)[0].recovery
      if (record?.status === "interrupted") throw new Error("interrupt persistence failed")
    }
    let checks = 0
    const queued = await f.runtime.start(args, context, { lockOwner: "parent", beforeStart: async () => {
      checks += 1
      throw new Error("private authority rejection")
    } })
    await turn()
    f.locks.release("parent")
    assert.equal(f.execution.starts.length, 0)
    assert.equal(f.store.ref(queued.taskID).claim, null)
    assert.equal(f.locks.has("parent"), false)
    assert.equal(scheduler.isActive(queued), stage !== "none")
    f.store[timing] = undefined
    const record = (await f.reload().recoverSession(context))[0]
    assert.equal(record.status, "interrupted")
    assert.equal(record.phase, "not-submitted")
    assert.equal(record.claim, null)
    assert.equal(record.stopped, true)
    assert.equal(record.diagnostic, undefined)
    assert.equal(f.locks.has("parent"), false)
    assert.equal(scheduler.isActive(queued), false)
    assert.equal((await f.runtime.start(args, context, { beforeStart: () => { checks += 1 } })).taskID, queued.taskID)
    assert.equal(checks, 1)
    assert.equal(JSON.stringify([...f.store.sessions.values()]).includes("private authority rejection"), false)
    await f.runtime.dispose()
  }
})

test("cancellation and disposal during beforeStart fence the claim even when the check later succeeds", async () => {
  for (const action of ["cancelOwned", "dispose"]) {
    const f = fixture()
    const gate = deferred()
    const entered = deferred()
    const queued = await f.runtime.start(args, context, { beforeStart: async () => { entered.resolve(); await gate.promise } })
    await entered.promise
    const controller = new AbortController()
    const read = f.runtime.waitInitial(queued.taskID, { ...context, abort: controller.signal })
    controller.abort(new Error("read only"))
    await assert.rejects(read, /read only/)
    assert.equal(f.active(queued.taskID), true)
    const stopping = action === "dispose" ? f.runtime.dispose() : f.runtime.cancelOwned("owner")
    gate.resolve()
    await stopping
    assert.equal(f.execution.starts.length, 0)
    assert.equal(f.store.record(queued.taskID).status, "cancelled")
    assert.equal(f.store.record(queued.taskID).claim, null)
    assert.equal(f.active(queued.taskID), false)
    if (action !== "dispose") await f.runtime.dispose()
  }
})

test("beforeStart is type-checked before creation and is never recreated from recovered ledgers", async () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 1 })
  scheduler.enqueue = () => [] // Simulate interruption before resource admission.
  const f = fixture({ scheduler })
  for (const beforeStart of [null, false, {}, "callback"]) await assert.rejects(f.runtime.start(args, context, { beforeStart }), /INVALID_ARGUMENTS/)
  assert.equal(f.store.writes.length, 0)
  let checks = 0
  const source = { ...context, callID: "queued" }
  const queued = await f.runtime.start(args, source, { beforeStart: () => { checks += 1 } })
  await turn()
  const recovered = fixture({ store: f.store })
  assert.equal((await recovered.runtime.recoverSession(context)).find((record) => record.taskID === queued.taskID).status, "interrupted")
  await turn()
  assert.equal(f.execution.starts.length, 0)
  assert.equal(recovered.execution.starts.length, 0)
  assert.equal(checks, 0)
  assert.equal((await recovered.runtime.start({ ...args, cwd: queued.cwd }, source, { beforeStart: () => { checks += 1 } })).taskID, queued.taskID)
  assert.equal(checks, 0)
  await f.runtime.dispose()
  await recovered.runtime.dispose()
})

test("cancelOwned attempts every known owner handle despite unreadable or deleted owner Session, retaining slots until persistence", async () => {
  for (const missing of [false, true]) {
    const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 2 })
    const f = fixture({ scheduler })
    await f.locks.acquire("parent", effect)
    const first = await f.runtime.start(args, context, { lockOwner: "parent" })
    const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
    const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
    const foreign = await f.runtime.start(args, { ...context, sessionID: "other" }, { lockOwner: "parent" })
    await turn()
    const owner = clone(f.store.sessions.get("owner"))
    if (missing) f.store.sessions.delete("owner")
    else f.store.onGet = () => { throw new Error("store unavailable") }
    await assert.rejects(f.reload().cancelOwned("owner"), missing ? { name: "NotFoundError" } : /store unavailable/)
    assert.deepEqual(new Set(f.execution.cancels), new Set([first.taskID, second.taskID]))
    assert.equal(f.execution.get(first.taskID).snapshot().stopped, true)
    assert.equal(f.execution.get(second.taskID).snapshot().stopped, true)
    assert.equal(f.execution.get(foreign.taskID).snapshot().stopped, false)
    assert.equal(scheduler.isActive(first), true)
    assert.equal(scheduler.isActive(second), true)
    assert.equal(scheduler.isQueued(queued), true)
    assert.equal(f.locks.has("parent"), true)
    if (missing) f.store.sessions.set("owner", owner)
    f.store.onGet = undefined
    const results = await f.runtime.cancelOwned("owner")
    assert.deepEqual(results.map((record) => record.status), ["cancelled", "cancelled", "cancelled"])
    assert.equal(f.execution.starts.length, 3)
    assert.equal(scheduler.isActive(first), false)
    assert.equal(scheduler.isActive(second), false)
    assert.equal(scheduler.isQueued(queued), false)
    await f.runtime.dispose()
  }
})

test("cancelOwned starts known cancellation without waiting for a blocked owner read and keeps the admission fence", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const gate = deferred()
  const entered = deferred()
  f.store.onGet = () => gate.promise
  f.execution.onCancel = (handle) => { entered.resolve(); return handle.finish({ status: "cancelled" }) }
  const cancelling = f.runtime.cancelOwned("owner")
  await entered.promise
  await turn()
  assert.equal(f.execution.get(snapshot.taskID).snapshot().stopped, true)
  assert.equal(f.active(snapshot.taskID), true)
  const admission = assert.rejects(f.reload().start(args, { ...context, callID: "racing" }), /OWNER_CANCELLING/)
  f.store.onGet = undefined
  gate.resolve()
  await admission
  await cancelling
  assert.equal(f.active(snapshot.taskID), false)
  await f.runtime.dispose()
})

test("cancelOwned does not let one rejected handle skip another handle when recovery also fails", async () => {
  const f = fixture({ limits: { maxConcurrentCommands: 2 } })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  await turn()
  f.store.onGet = () => { throw new Error("store unavailable") }
  f.execution.onCancel = (handle) => {
    if (handle.executionID === first.taskID) throw new Error("stop failed")
    return handle.finish({ status: "cancelled" })
  }
  await assert.rejects(f.runtime.cancelOwned("owner"), /store unavailable/)
  assert.deepEqual(f.execution.cancels, [first.taskID, second.taskID])
  assert.equal(f.execution.get(second.taskID).snapshot().stopped, true)
  assert.equal(f.locks.has("parent"), true)
  f.store.onGet = undefined
  f.execution.onCancel = undefined
  await f.runtime.cancelOwned("owner")
  await f.runtime.dispose()
})

test("second cancellation persists stopped unknown without fabricating output success, despite immutable first done", async () => {
  for (const action of ["cancel", "cancelOwned", "dispose"]) {
    const f = fixture()
    const snapshot = await started(f)
    const handle = f.execution.get(snapshot.taskID)
    f.execution.onCancel = (current) => current.finish({ status: "unknown", stopped: false, output: "partial", truncated: true, reason: "process-group-unconfirmed" })
    const first = await f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context)
    assert.equal(first.stopped, false)
    assert.equal(f.active(snapshot.taskID), true)
    const done = await handle.done
    f.execution.onCancel = (current) => current.finish({ status: "unknown", stopped: true, reason: "output-or-exit-unconfirmed" })
    if (action === "cancel") await f.runtime.handle({ action, taskID: snapshot.taskID }, context)
    else if (action === "cancelOwned") await f.runtime.cancelOwned("owner")
    else await f.runtime.dispose()
    const record = f.store.record(snapshot.taskID)
    assert.equal(record.status, "unknown")
    assert.equal(record.phase, "stopped")
    assert.equal(record.stopped, true)
    assert.equal(record.result.reason, "output-or-exit-unconfirmed")
    assert.equal(record.result.output, "partial")
    assert.equal(record.result.truncated, true)
    assert.equal(record.result.sha256, undefined)
    assert.equal(f.active(snapshot.taskID), false)
    assert.deepEqual(await handle.done, done)
    assert.equal(done.stopped, false)
    assert.equal(f.execution.starts.length, 1)
    assert.equal((await f.reload().recoverSession(context))[0].stopped, true)
    await f.runtime.dispose()
  }
})

test("second stop proof persistence failure retains admission and is retryable without resume after failed dispose", async () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 1 })
  const f = fixture({ scheduler })
  const snapshot = await started(f)
  f.execution.onCancel = (handle) => handle.finish({ status: "unknown", stopped: false })
  await assert.rejects(f.runtime.dispose(), /DISPOSE_UNCONFIRMED/)
  f.execution.onCancel = (handle) => handle.finish({ status: "unknown", stopped: true, truncated: true, reason: "output-or-exit-unconfirmed" })
  f.store.beforeWrite = (id, o4e) => {
    const record = Object.values(o4e.commandTasks.refs)[0].recovery
    if (record?.status === "unknown" && record.stopped) throw new Error("stop proof persistence failed")
  }
  await assert.rejects(f.runtime.dispose(), /stop proof persistence failed/)
  assert.equal(scheduler.isActive(snapshot), true)
  assert.equal(f.active(snapshot.taskID), true)
  await assert.rejects(f.runtime.start(args, { ...context, callID: "new" }), /DISPOSED/)
  await assert.rejects(f.runtime.handle({ action: "status", taskID: snapshot.taskID }, context), /DISPOSED/)
  f.store.beforeWrite = undefined
  await f.runtime.dispose()
  assert.equal(f.store.record(snapshot.taskID).stopped, true)
  assert.equal(scheduler.isActive(snapshot), false)
  assert.equal(f.active(snapshot.taskID), false)
  assert.equal(f.execution.starts.length, 1)
})

test("a delayed first done retries rather than downgrades an unconfirmed owner second stop proof", async () => {
  const f = fixture()
  const delayed = deferred()
  const start = f.execution.start.bind(f.execution)
  f.execution.start = (input) => { const handle = start(input); handle.done = delayed.promise; return handle }
  const snapshot = await started(f)
  const handle = f.execution.get(snapshot.taskID)
  const first = handle.finish({ status: "unknown", stopped: false, truncated: true })
  await f.runtime.recoverSession(context)
  handle.finish({ status: "unknown", stopped: true, reason: "output-or-exit-unconfirmed" })
  const gate = deferred()
  const entered = deferred()
  let fail = true
  f.store.beforeWrite = async (id, o4e) => {
    if (!fail || id !== "owner" || !Object.values(o4e.commandTasks.refs)[0].recovery.stopped) return
    fail = false
    entered.resolve()
    await gate.promise
    throw new Error("second proof index failed")
  }
  const recovering = f.runtime.recoverSession(context)
  const rejected = assert.rejects(recovering, /second proof index failed/)
  await entered.promise
  assert.equal(f.store.record(snapshot.taskID).stopped, false)
  assert.equal(f.store.ref(snapshot.taskID).recovery.stopped, false)
  assert.equal(f.active(snapshot.taskID), true)
  delayed.resolve(first)
  await turn()
  gate.resolve()
  await rejected
  await turn()
  assert.equal(f.store.record(snapshot.taskID).stopped, true)
  assert.equal(f.store.ref(snapshot.taskID).recovery.stopped, true)
  assert.equal(f.store.record(snapshot.taskID).result.reason, "output-or-exit-unconfirmed")
  assert.equal(f.active(snapshot.taskID), false)
  assert.equal(f.execution.starts.length, 1)
  await f.runtime.dispose()
})

test("dispose propagates a rejected stop attempt even if concurrent stop proof later settles, then retries without resume", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const error = new Error("cancel transport failed")
  f.execution.onCancel = (handle) => {
    handle.finish({ status: "unknown", stopped: true, truncated: true })
    throw error
  }
  await assert.rejects(f.runtime.dispose(), (reason) => reason === error)
  await assert.rejects(f.runtime.start(args, { ...context, callID: "new" }), /DISPOSED/)
  await f.runtime.dispose()
  assert.equal(f.store.record(snapshot.taskID).status, "unknown")
  assert.equal(f.store.record(snapshot.taskID).stopped, true)
  assert.equal(f.active(snapshot.taskID), false)
})

test("cancelKnown invokes raw stop immediately while owner recovery and store reads are blocked", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const gate = deferred()
  const entered = deferred()
  f.store.onGet = () => { entered.resolve(); return gate.promise }
  const recovery = f.runtime.recoverSession(context)
  await entered.promise
  const cancelling = f.runtime.cancelKnown("owner", snapshot.taskID)
  assert.deepEqual(f.execution.cancels, [snapshot.taskID])
  assert.equal(f.execution.get(snapshot.taskID).snapshot().stopped, true)
  assert.equal(f.active(snapshot.taskID), true)
  f.store.onGet = undefined
  gate.resolve()
  await recovery
  const results = await cancelling
  assert.equal(results.length, 1)
  assert.equal(results[0].status, "cancelled")
  assert.equal(f.active(snapshot.taskID), false)
  await f.runtime.dispose()
})

test("cancelKnown returns empty for unknown, deleted or foreign selectors without reads, discovery or creation", async () => {
  const f = fixture()
  const snapshot = await started(f)
  const fresh = fixture({ store: f.store })
  f.store.sessions.delete("other")
  f.store.onGet = () => { throw new Error("must not read") }
  f.execution.onGet = () => { throw new Error("must not discover handles") }
  assert.deepEqual(await fresh.runtime.cancelKnown("owner", snapshot.taskID), [])
  assert.deepEqual(await f.runtime.cancelKnown("deleted"), [])
  assert.deepEqual(await f.runtime.cancelKnown("owner", `o4e_command_${"0".repeat(32)}`), [])
  assert.deepEqual(await f.runtime.cancelKnown("other", snapshot.taskID), [])
  assert.deepEqual(await f.runtime.cancelKnown("other"), [])
  assert.deepEqual(f.execution.cancels, [])
  assert.equal(f.store.creates, 0)
  assert.equal(f.active(snapshot.taskID), true)
  f.store.onGet = undefined
  f.execution.onGet = undefined
  await f.runtime.dispose()
  await fresh.runtime.dispose()
})

test("cancelKnown single selection leaves same-owner siblings and other owners running", async () => {
  const f = fixture({ limits: { maxConcurrentCommands: 2 } })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  const sibling = await f.runtime.start(args, { ...context, callID: "sibling" }, { lockOwner: "parent" })
  const foreign = await f.runtime.start(args, { ...context, sessionID: "other" }, { lockOwner: "parent" })
  await turn()
  f.execution.onGet = () => { throw new Error("must use known handles") }
  const results = await f.reload().cancelKnown("owner", first.taskID)
  assert.deepEqual(results.map((record) => record.taskID), [first.taskID])
  assert.deepEqual(f.execution.cancels, [first.taskID])
  assert.equal(f.execution.handles.get(sibling.taskID).snapshot().stopped, false)
  assert.equal(f.execution.handles.get(foreign.taskID).snapshot().stopped, false)
  f.execution.onGet = undefined
  await f.runtime.dispose()
})

test("cancelKnown aborts every selected queue before settling live handles and releasing their slots", async () => {
  const f = fixture()
  await f.locks.acquire("parent", effect)
  const first = await started(f, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  const results = await f.runtime.cancelKnown("owner")
  assert.deepEqual(results.map((record) => record.taskID), [first.taskID, queued.taskID])
  assert.deepEqual(results.map((record) => record.status), ["cancelled", "cancelled"])
  assert.equal(f.store.record(queued.taskID).claim, null)
  await turn()
  assert.equal(f.execution.starts.length, 1)
  assert.equal(f.locks.has("parent"), true)
  await f.runtime.dispose()
})

test("cancelKnown raw stop rejection cannot skip another handle or queued cancellation", async () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 2 })
  const f = fixture({ scheduler })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  await turn()
  const error = new Error("raw stop failed")
  f.execution.handles.get(first.taskID).cancel = () => { f.execution.cancels.push(first.taskID); throw error }
  const cancelling = f.runtime.cancelKnown("owner")
  assert.deepEqual(f.execution.cancels, [first.taskID, second.taskID])
  await assert.rejects(cancelling, (reason) => reason === error)
  assert.equal(f.store.record(second.taskID).status, "cancelled")
  assert.equal(f.store.record(queued.taskID).status, "cancelled")
  assert.equal(scheduler.isActive(first), true)
  assert.equal(scheduler.isActive(second), false)
  assert.equal(scheduler.isQueued(queued), false)
  assert.equal(f.locks.has("parent"), true)
  f.execution.handles.get(first.taskID).cancel = () => f.execution.handles.get(first.taskID).finish({ status: "cancelled" })
  await f.runtime.cancelKnown("owner")
  await f.runtime.dispose()
})

test("cancelKnown preserves slots on deleted owner or failed owner persistence and retries only the stop", async () => {
  for (const stage of ["deleted", "index"]) {
    const scheduler = new BackgroundTaskScheduler({ maxConcurrentCommands: 1 })
    const f = fixture({ scheduler })
    const snapshot = await started(f)
    const owner = clone(f.store.sessions.get("owner"))
    if (stage === "deleted") f.store.sessions.delete("owner")
    else f.store.beforeWrite = (id, o4e) => {
      const record = Object.values(o4e.commandTasks.refs)[0].recovery
      if (record?.status === "cancelled") throw new Error("cancel persistence failed")
    }
    await assert.rejects(f.runtime.cancelKnown("owner", snapshot.taskID), stage === "deleted" ? { name: "NotFoundError" } : /cancel persistence failed/)
    assert.equal(f.execution.handles.get(snapshot.taskID).snapshot().stopped, true)
    assert.equal(f.active(snapshot.taskID), true)
    assert.equal(scheduler.isActive(snapshot), true)
    if (stage === "deleted") f.store.sessions.set("owner", owner)
    f.store.beforeWrite = undefined
    const results = await f.runtime.cancelKnown("owner", snapshot.taskID)
    assert.equal(results[0].status, "cancelled")
    assert.equal(f.active(snapshot.taskID), false)
    assert.equal(scheduler.isActive(snapshot), false)
    assert.equal(f.execution.starts.length, 1)
    await f.runtime.dispose()
  }
})

test("cancelKnown deadline retains pending persistence tracking so dispose cannot finish before the write", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const snapshot = await started(f)
  const gate = deferred()
  const entered = deferred()
  f.store.onGet = () => { entered.resolve(); return gate.promise }
  const cancelling = f.runtime.cancelKnown("owner", snapshot.taskID)
  const rejected = assert.rejects(cancelling, /WAIT_TIMEOUT/)
  assert.deepEqual(f.execution.cancels, [snapshot.taskID])
  await entered.promise
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  assert.equal(timer.ms, 10000)
  timer.fn()
  await rejected
  assert.equal(f.active(snapshot.taskID), true)
  let disposed = false
  const disposing = f.runtime.dispose().then(() => { disposed = true })
  await turn()
  assert.equal(disposed, false)
  assert.ok(f.execution.cancels.length >= 2)
  f.store.onGet = undefined
  gate.resolve()
  await disposing
  assert.equal(disposed, true)
  assert.equal(f.store.record(snapshot.taskID).status, "cancelled")
  assert.equal(f.active(snapshot.taskID), false)
})

test("cancelKnown tracks the actual raw stop after timeout; dispose retries stop without dropping the old promise", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock })
  const snapshot = await started(f)
  const raw = deferred()
  const handle = f.execution.handles.get(snapshot.taskID)
  f.execution.onCancel = () => raw.promise
  const cancelling = f.runtime.cancelKnown("owner", snapshot.taskID)
  const rejected = assert.rejects(cancelling, /WAIT_TIMEOUT/)
  assert.equal(f.execution.cancels.length, 1)
  assert.equal(timers.size, 1)
  const cancelTimer = [...timers.values()][0]
  cancelTimer.fn()
  await rejected
  f.execution.onCancel = undefined
  const disposing = f.runtime.dispose()
  const disposeRejected = assert.rejects(disposing, /WAIT_TIMEOUT/)
  await turn()
  assert.equal(f.execution.cancels.length, 2)
  assert.equal(handle.snapshot().stopped, true)
  assert.equal(timers.size, 1)
  const disposeTimer = [...timers.values()][0]
  disposeTimer.fn()
  await disposeRejected
  assert.throws(() => f.runtime.resume(), /DISPOSE_PENDING/)
  raw.resolve(handle.snapshot())
  await turn()
  await f.runtime.dispose()
  assert.equal(f.execution.starts.length, 1)
})

test("public handle cancel still validates owner index before cancellation", async () => {
  const f = fixture()
  const snapshot = await started(f)
  f.store.onGet = () => { throw new Error("owner index unavailable") }
  await assert.rejects(f.runtime.handle({ action: "cancel", taskID: snapshot.taskID }, context), /owner index unavailable/)
  assert.deepEqual(f.execution.cancels, [])
  await assert.rejects(f.runtime.cancelKnown("owner", snapshot.taskID), /owner index unavailable/)
  assert.deepEqual(f.execution.cancels, [snapshot.taskID])
  f.store.onGet = undefined
  await f.runtime.dispose()
})

test("cancelKnown persists other selected stops and queued cancellation while one raw stop remains pending", async () => {
  const timers = new Map()
  const clock = { setTimeout: (fn, ms) => { const id = randomUUID(); timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id) }
  const f = fixture({ clock, limits: { maxConcurrentCommands: 2 } })
  await f.locks.acquire("parent", effect)
  const first = await f.runtime.start(args, context, { lockOwner: "parent" })
  const second = await f.runtime.start(args, { ...context, callID: "second" }, { lockOwner: "parent" })
  const queued = await f.runtime.start(args, { ...context, callID: "queued" }, { lockOwner: "parent" })
  await turn()
  const raw = deferred()
  f.execution.onCancel = (handle) => handle.executionID === first.taskID ? raw.promise : handle.finish({ status: "cancelled" })
  const cancelling = f.runtime.cancelKnown("owner")
  const rejected = assert.rejects(cancelling, /WAIT_TIMEOUT/)
  assert.deepEqual(f.execution.cancels, [first.taskID, second.taskID])
  await turn()
  assert.equal(f.store.record(first.taskID).status, "running")
  assert.equal(f.store.record(second.taskID).status, "cancelled")
  assert.equal(f.store.record(queued.taskID).status, "cancelled")
  assert.equal(f.execution.starts.length, 2)
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  timer.fn()
  await rejected
  raw.resolve(f.execution.handles.get(first.taskID).finish({ status: "unknown", stopped: false }))
  await turn()
  f.execution.onCancel = undefined
  const results = await f.runtime.cancelKnown("owner")
  assert.equal(results.every((record) => record.stopped), true)
  await f.runtime.dispose()
})
