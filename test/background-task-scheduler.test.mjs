import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { BackgroundTaskScheduler, createSharedBackgroundTaskScheduler } from "../src/runtime/background-task-scheduler.mjs"
import { canonicalDirectoryKey } from "../src/runtime/directory-key.mjs"
import { ScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { createDanglingDirectoryLink, createDirectoryLink, removeLink } from "./helpers/fs-link-fixture.mjs"

function record(taskID, sequence, kind = "agent", ownerSessionID = "owner", effect = "read") {
  return { taskID, sequence, kind, ownerSessionID, effect }
}

test("Scheduler 对同一 owner 的 Agent Task 严格 FIFO", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 1, maxConcurrentCommands: 1 })
  const first = record("first", 1)
  const second = record("second", 2)
  const third = record("third", 3)

  assert.deepEqual(scheduler.enqueue(first), ["first"])
  assert.deepEqual(scheduler.enqueue(third), [])
  assert.deepEqual(scheduler.enqueue(second), [])
  assert.deepEqual(scheduler.release(first), ["second"])
  assert.deepEqual(scheduler.release(second), ["third"])
})

test("Scheduler 的 owner 和 Agent/command lane 独立", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 1, maxConcurrentCommands: 1 })

  assert.deepEqual(scheduler.enqueue(record("owner-agent", 1)), ["owner-agent"])
  assert.deepEqual(scheduler.enqueue(record("owner-command", 2, "command")), ["owner-command"])
  assert.deepEqual(scheduler.enqueue(record("other-agent", 1, "agent", "other")), ["other-agent"])
})

test("共享 Scheduler 按 kind 查找 Session，不让 owner 内 command 遮蔽 Agent", () => {
  const scheduler = createSharedBackgroundTaskScheduler(`/tmp/o4e-kind-${Date.now()}`)
  const command = { ...record("command", 1, "command"), taskSessionID: "owner" }
  const agent = { ...record("agent", 1), taskSessionID: "agent-ledger", childSessionID: "owner", attemptSessionIDs: ["old-attempt"] }
  scheduler.enqueue(command)
  scheduler.enqueue(agent)
  assert.equal(scheduler.recordForSession("owner", "command"), command)
  assert.equal(scheduler.recordForSession("owner", "agent"), agent)
  assert.equal(scheduler.recordForSession("old-attempt", "agent"), agent)
  assert.equal(scheduler.recordForSession("agent-ledger", "command"), undefined)
  scheduler.dispose()
})

test("Scheduler 可取消 queued Task 并幂等释放槽位", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 1, maxConcurrentCommands: 1 })
  const first = record("first", 1)
  const second = record("second", 2)

  scheduler.enqueue(first)
  scheduler.enqueue(second)
  assert.equal(scheduler.removeQueued(second), true)
  assert.equal(scheduler.removeQueued(second), false)
  assert.deepEqual(scheduler.release(first), [])
  assert.deepEqual(scheduler.release(first), [])
})

test("Scheduler withdraw 同时撤销 queued 和 active-but-unclaimed Task", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 1, maxConcurrentCommands: 1 })
  const first = record("first", 1)
  const second = record("second", 2)
  const third = record("third", 3)

  assert.deepEqual(scheduler.enqueue(first), ["first"])
  assert.deepEqual(scheduler.enqueue(second), [])
  assert.deepEqual(scheduler.withdraw(second), { removedQueued: true, removedActive: false, admitted: [] })
  assert.deepEqual(scheduler.release(first), [])

  assert.deepEqual(scheduler.enqueue(first), ["first"])
  assert.deepEqual(scheduler.enqueue(third), [])
  assert.deepEqual(scheduler.withdraw(first), { removedQueued: false, removedActive: true, admitted: ["third"] })
  assert.deepEqual(scheduler.withdraw(first), { removedQueued: false, removedActive: false, admitted: [] })
})

test("Scheduler 可在保守冻结 active Task 时延迟 drain", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 1, maxConcurrentCommands: 1 })
  const first = record("first", 1)
  const second = record("second", 2)

  assert.deepEqual(scheduler.enqueue(first), ["first"])
  assert.deepEqual(scheduler.enqueue(second), [])
  assert.deepEqual(scheduler.withdraw(first, { drain: false }), { removedQueued: false, removedActive: true, admitted: [] })
  scheduler.restoreActive(first)
  assert.deepEqual(scheduler.release(first), ["second"])
})

test("Scheduler 在并发额度内允许读写混合，满额后保持 FIFO", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 2, maxConcurrentCommands: 1 })
  const firstRead = record("first-read", 1, "agent", "owner", "read")
  const blockedWrite = record("blocked-write", 2, "agent", "owner", "unknown-write")
  const secondRead = record("second-read", 3, "agent", "owner", "read")

  assert.deepEqual(scheduler.enqueue(firstRead), ["first-read"])
  assert.deepEqual(scheduler.enqueue(blockedWrite), ["blocked-write"])
  assert.deepEqual(scheduler.enqueue(secondRead), [])
  assert.deepEqual(scheduler.release(firstRead), ["second-read"])
  assert.deepEqual(scheduler.release(secondRead), [])
  assert.deepEqual(scheduler.release(blockedWrite), [])
})

test("写任务运行时后到只读任务可准入，恢复也不重建读写互斥", () => {
  const scheduler = new BackgroundTaskScheduler({ maxConcurrentAgents: 2, maxConcurrentCommands: 1 })
  const writer = record("writer", 1, "agent", "owner", "unknown-write")
  const reader = record("reader", 2)
  scheduler.restoreActive(writer)
  assert.deepEqual(scheduler.enqueue(reader), ["reader"])
  assert.deepEqual(scheduler.enqueue(reader), [])
  assert.deepEqual(scheduler.enqueue(record("next", 3)), [])
  assert.deepEqual(scheduler.release(writer), ["next"])
})

test("调度准入后的根只读不等待写锁，写写冲突仍等待", async () => {
  const locks = new ScopeLockManager()
  await locks.acquire("writer", { kind: "unknown-write" })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("read blocked by write lock")), 1000)
  try {
    assert.deepEqual(await locks.acquire("reader", { kind: "read" }, { signal: controller.signal }), { ok: true })
  } finally { clearTimeout(timer) }
  const waiting = new AbortController()
  let admitted = false
  const second = locks.acquire("second-writer", { kind: "unknown-write" }, { signal: waiting.signal })
    .then(() => { admitted = true }, (error) => { assert.equal(error.message, "test-cancel") })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(admitted, false)
  waiting.abort(new Error("test-cancel"))
  await second
})

test("共享 Scheduler 将目录词法别名和符号链接归并为同一 key", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-scheduler-directory-key-"))
  const alias = `${root}-alias`
  try {
    createDirectoryLink(root, alias)
    const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
    const first = createSharedBackgroundTaskScheduler(root, limits)
    const second = createSharedBackgroundTaskScheduler(`${root}/.`, limits)
    const third = createSharedBackgroundTaskScheduler(alias, limits)
    const active = record("active", 1)
    const queued = record("queued", 2)

    assert.deepEqual(first.enqueue(active), ["active"])
    assert.equal(second.isActive(active), true)
    assert.deepEqual(third.enqueue(queued), [])
    assert.equal(first.isQueued(queued), true)
    const dispatched = []
    third.setDispatcher((taskIDs) => dispatched.push(...taskIDs))
    assert.deepEqual(second.release(active), [])
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.deepEqual(dispatched, ["queued"])
    third.release(queued)
    third.dispose()
    second.dispose()
    first.dispose()
  } finally {
    removeLink(alias)
    rmSync(root, { recursive: true, force: true })
  }
})

test("canonical directory key 支持不存在尾部并对悬空链接和非目录 fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-directory-key-safety-"))
  const missing = join(root, "future")
  const dangling = join(root, "dangling")
  const file = join(root, "file")
  try {
    writeFileSync(file, "not a directory")
    createDanglingDirectoryLink(join(root, "not-created"), dangling)
    assert.equal(canonicalDirectoryKey(missing), canonicalDirectoryKey(`${missing}/.`))
    assert.throws(() => canonicalDirectoryKey(dangling), /路径包含无法解析的符号链接/)
    assert.throws(() => canonicalDirectoryKey(file), /directory 必须指向目录/)
  } finally {
    removeLink(dangling)
    rmSync(root, { recursive: true, force: true })
  }
})

test("共享 Scheduler 新 facade 收紧 maxConcurrentAgents 后使用安全最小值", () => {
  const key = `scheduler-limit-tightening-${Date.now()}-${Math.random()}`
  const wide = createSharedBackgroundTaskScheduler(key, { maxConcurrentAgents: 2, maxConcurrentCommands: 2 })
  const first = record("first", 1)
  const second = record("second", 2)
  const queued = record("queued", 3)

  assert.deepEqual(wide.enqueue(first), ["first"])
  assert.deepEqual(wide.enqueue(second), ["second"])
  const tight = createSharedBackgroundTaskScheduler(`${key}/.`, { maxConcurrentAgents: 1, maxConcurrentCommands: 1 })
  assert.deepEqual(tight.enqueue(queued), [])
  wide.dispose()
  assert.equal(tight.isActive(first), true)
  assert.equal(tight.isActive(second), true)
  assert.equal(tight.isQueued(queued), true)
  assert.deepEqual(tight.release(first), [])
  assert.deepEqual(tight.release(second), ["queued"])
  tight.release(queued)
  tight.dispose()
})

test("共享 Scheduler facade dispose 时保留其 queued admission", () => {
  const key = `scheduler-queued-handoff-${Date.now()}-${Math.random()}`
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const first = createSharedBackgroundTaskScheduler(key, limits)
  const second = createSharedBackgroundTaskScheduler(key, limits)
  const active = record("active", 1)
  const queued = record("queued", 2)

  assert.deepEqual(first.enqueue(active), ["active"])
  assert.deepEqual(first.enqueue(queued), [])
  first.dispose()
  assert.equal(second.isActive(active), true)
  assert.equal(second.isQueued(queued), true)
  assert.deepEqual(second.release(active), ["queued"])
  second.release(queued)
  second.dispose()
})

test("共享 Scheduler 已 dispose 的 facade 不得重新 admission 或释放 successor 的 entry", () => {
  const key = `scheduler-closed-facade-${Date.now()}-${Math.random()}`
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const first = createSharedBackgroundTaskScheduler(key, limits)
  const second = createSharedBackgroundTaskScheduler(key, limits)
  const active = record("active", 1)
  const stale = record("stale", 2)

  assert.deepEqual(first.enqueue(active), ["active"])
  assert.deepEqual(second.enqueue(active), [])
  first.dispose()
  assert.equal(second.isActive(active), true)
  assert.deepEqual(first.enqueue(stale), [])
  assert.deepEqual(first.restoreActive(stale), undefined)
  assert.deepEqual(first.release(active), [])
  assert.equal(second.isActive(active), true)

  second.release(active)
  second.dispose()
})

test("共享 Scheduler 延迟路由在 owner dispose 后投递给最新 facade", async () => {
  const key = `scheduler-late-route-${Date.now()}-${Math.random()}`
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const first = createSharedBackgroundTaskScheduler(key, limits)
  const second = createSharedBackgroundTaskScheduler(key, limits)
  const active = record("active", 1)
  const queued = record("queued", 2)
  const dispatched = []
  first.setDispatcher((taskIDs) => dispatched.push(...taskIDs))
  second.setDispatcher((taskIDs) => dispatched.push(...taskIDs))

  assert.deepEqual(first.enqueue(active), ["active"])
  assert.deepEqual(second.enqueue(queued), [])
  first.release(active)
  second.dispose()
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(dispatched, ["queued"])
  assert.equal(first.isActive(queued), true)
  first.release(queued)
  first.dispose()
})

test("共享 Scheduler facade 已共同观察 active entry 时 dispose 仍重驱存活 owner", async () => {
  const key = `scheduler-observed-active-handoff-${Date.now()}-${Math.random()}`
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const first = createSharedBackgroundTaskScheduler(key, limits)
  const second = createSharedBackgroundTaskScheduler(key, limits)
  const active = record("active", 1)
  const dispatched = []
  second.setDispatcher((taskIDs) => dispatched.push(...taskIDs))

  assert.deepEqual(first.enqueue(active), ["active"])
  assert.deepEqual(second.enqueue(active), [])
  first.dispose()
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(dispatched, ["active"])
  second.release(active)
  second.dispose()
})

test("共享 Scheduler 迟到的 closed facade release 不影响 successor 接管的 active entry", async () => {
  const key = `scheduler-late-closed-release-${Date.now()}-${Math.random()}`
  const limits = { maxConcurrentAgents: 1, maxConcurrentCommands: 1 }
  const first = createSharedBackgroundTaskScheduler(key, limits)
  const second = createSharedBackgroundTaskScheduler(key, limits)
  const active = record("active", 1)
  const queued = record("queued", 2)
  const dispatched = []
  second.setDispatcher((taskIDs) => dispatched.push(...taskIDs))

  assert.deepEqual(first.enqueue(active), ["active"])
  first.dispose()
  assert.deepEqual(second.enqueue(queued), [])
  assert.deepEqual(first.release(active), [])
  assert.equal(second.isActive(active), true)

  assert.deepEqual(second.release(active), ["queued"])
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.deepEqual(dispatched, [])
  assert.equal(second.isActive(queued), true)
  second.release(queued)
  second.dispose()
})
