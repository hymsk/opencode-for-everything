import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createSharedScopeLockManager, ScopeLockManager } from "../src/runtime/scope-locks.mjs"

for (const [name, create] of [
  ["ScopeLockManager", () => new ScopeLockManager()],
  ["SharedScopeLockManager", () => createSharedScopeLockManager(`lock-authority-${randomUUID()}`)],
]) {
  test(`${name}: unknown-write authority inspection cannot acquire, upgrade or retain locks`, async (t) => {
    const locks = create()
    t.after(() => { locks.release("child"); locks.clear() })
    assert.equal(locks.isUnknownWrite("missing"), false)
    for (const effect of [{ kind: "read" }, { kind: "scoped-write", writeScopes: ["/workspace/src"] }]) {
      await locks.acquire("parent", effect)
      assert.equal(locks.isUnknownWrite("parent"), false)
      locks.release("parent")
    }
    await locks.acquire("parent", { kind: "unknown-write" })
    assert.equal(locks.isUnknownWrite("parent"), true)
    await locks.acquire("child", { kind: "read" }, { parentLockID: "parent" })
    locks.release("parent")
    assert.equal(locks.has("parent"), true, "nested Agent still retains ancestor conflict boundary")
    assert.equal(locks.isUnknownWrite("parent"), false, "released authority cannot authorize new commands")
    locks.release("child")
    assert.equal(locks.has("parent"), false)
  })
}

test("shared Agent owners remain independently retained across facade handoff", async () => {
  const key = `lock-authority-${randomUUID()}`
  const first = createSharedScopeLockManager(key)
  const second = createSharedScopeLockManager(key)
  try {
    await first.acquire("agent", { kind: "unknown-write" })
    second.restore("agent", { kind: "unknown-write" })
    first.release("agent")
    assert.equal(second.isUnknownWrite("agent"), true)
    first.restore("agent", { kind: "unknown-write" })
    first.clear()
    assert.equal(first.isUnknownWrite("agent"), false)
    first.release("agent")
    assert.equal(second.isUnknownWrite("agent"), true)
    second.release("agent")
    assert.equal(second.has("agent"), false)
  } finally { first.clear(); second.clear() }
})
