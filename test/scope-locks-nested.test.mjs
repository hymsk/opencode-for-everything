import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { createSharedScopeLockManager, ScopeLockManager } from "../src/runtime/scope-locks.mjs"

const write = { kind: "unknown-write" }
const read = { kind: "read" }
const scoped = (...writeScopes) => ({ kind: "scoped-write", writeScopes })

for (const [name, create] of [
  ["ScopeLockManager", () => new ScopeLockManager()],
  ["SharedScopeLockManager", () => createSharedScopeLockManager(`nested-lock-${randomUUID()}`)],
]) {
  test(`${name}: nested writers bypass ancestors but serialize conflicting siblings`, async (t) => {
    const locks = create()
    t.after(() => { locks.release("first"); locks.release("second"); locks.release("parent"); locks.clear() })
    await locks.acquire("parent", write)
    await locks.acquire("first", write, { parentLockID: "parent" })
    let secondStarted = false
    const second = locks.acquire("second", write, { parentLockID: "parent" }).then(() => { secondStarted = true })
    await setImmediate()
    assert.equal(secondStarted, false)
    locks.release("first")
    await second
    assert.equal(secondStarted, true)
    assert.equal(locks.has("parent"), true)
  })

  test(`${name}: nested read retains all released ancestor locks`, async (t) => {
    const locks = create()
    t.after(() => { locks.release("reader"); locks.release("child"); locks.release("root"); locks.clear() })
    await locks.acquire("root", write)
    await locks.acquire("child", write, { parentLockID: "root" })
    await locks.acquire("reader", read, { parentLockID: "child" })
    locks.release("root")
    await assert.rejects(locks.acquire("late-descendant", read, { parentLockID: "child" }), /Scope Lock/)
    locks.release("child")
    let competitorStarted = false
    const competitor = locks.acquire("competitor", write).then(() => { competitorStarted = true })
    await setImmediate()
    assert.equal(competitorStarted, false)
    locks.release("reader")
    await competitor
    assert.equal(locks.has("root"), false)
    assert.equal(locks.has("child"), false)
    locks.release("competitor")
  })
}

test("nested effects may narrow parent authority but never expand or rebind it", async (t) => {
  const locks = new ScopeLockManager()
  t.after(() => { locks.release("grandchild"); locks.release("peer"); locks.release("child"); locks.clear() })
  await locks.acquire("root", scoped("/workspace/src"))
  await locks.acquire("child", scoped("/workspace/src/component"), { parentLockID: "root" })
  await locks.acquire("grandchild", read, { parentLockID: "child" })
  await locks.acquire("peer", scoped("/workspace/src/other"), { parentLockID: "root" })
  for (const effect of [write, scoped("/workspace/docs"), scoped("/workspace/src")]) {
    await assert.rejects(locks.acquire("too-wide", effect, { parentLockID: "child" }), /Scope Lock/)
    assert.throws(() => locks.restore("too-wide", effect, { parentLockID: "child", allowConflict: true }), /Scope Lock/)
  }
  await assert.rejects(locks.acquire("write-under-read", write, { parentLockID: "grandchild" }), /Scope Lock/)
  await assert.rejects(locks.acquire("child", read, { parentLockID: "grandchild" }), /Scope Lock/)
  assert.throws(() => locks.restore("root", read, { parentLockID: "child", allowConflict: true }), /Scope Lock/)
  for (const parentLockID of ["missing", "", "unbound", null, 42]) {
    await assert.rejects(locks.acquire("unbound", read, { parentLockID }), /Scope Lock/)
  }
})

test("queued nested acquisition fails if its parent releases before the sibling stops", async (t) => {
  const locks = new ScopeLockManager()
  t.after(() => { locks.release("first"); locks.clear() })
  await locks.acquire("root", write)
  await locks.acquire("first", write, { parentLockID: "root" })
  const rejected = assert.rejects(locks.acquire("queued", write, { parentLockID: "root" }), /Scope Lock/)
  locks.release("root")
  await rejected
  assert.equal(locks.has("queued"), false)
  assert.equal(locks.has("root"), true)
  locks.release("first")
  assert.equal(locks.has("root"), false)
})

test("recovery restores nested locks and read-only ancestry without granting write authority", async (t) => {
  const locks = new ScopeLockManager()
  t.after(() => { locks.release("child"); locks.release("reader"); locks.clear() })
  locks.restore("root", read)
  locks.restore("reader", read, { parentLockID: "root" })
  assert.throws(() => locks.restore("writer", write, { parentLockID: "reader", allowConflict: true }), /Scope Lock/)
  locks.release("root")
  locks.restore("reader", read, { parentLockID: "root", allowConflict: true })
  await assert.rejects(locks.acquire("new-child", read, { parentLockID: "root" }), /Scope Lock/)
  locks.release("reader")
  assert.equal(locks.has("root"), false)
  locks.restore("root", write)
  locks.restore("child", write, { parentLockID: "root", allowConflict: true })
  assert.throws(() => locks.restore("competitor", write), /Scope Lock/)
  locks.restore("root", write)
})

test("last shared disposal preserves nested locks for successor adoption and explicit completion", async () => {
  const key = `nested-lock-${randomUUID()}`
  const first = createSharedScopeLockManager(key)
  await first.acquire("root", write)
  await first.acquire("child", write, { parentLockID: "root" })
  await first.acquire("grandchild", read, { parentLockID: "child" })
  first.clear()
  assert.equal(first.has("root"), true)
  const second = createSharedScopeLockManager(key)
  try {
    assert.throws(() => second.restore("competitor", write), /Scope Lock/)
    first.release("child")
    first.release("grandchild")
    assert.equal(second.has("grandchild"), true)
    second.release("child")
    assert.equal(second.has("root"), true)
    second.release("grandchild")
    assert.equal(second.has("root"), false)
    await second.acquire("competitor", write)
  } finally { second.release("grandchild"); second.release("child"); second.clear() }
})
