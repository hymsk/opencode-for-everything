import test from "node:test"
import assert from "node:assert/strict"
import { createProcessTreeController } from "../src/command-core/process-tree.mjs"

test("ProcessTreeController rejects invalid PIDs", () => {
  const calls = []
  const tree = createProcessTreeController({ signal: (...args) => calls.push(args) })
  assert.deepEqual(tree.inspect(1), { stopped: false, signalSafe: false })
  assert.equal(tree.stop(1), false)
  assert.deepEqual(calls, [])
})

test("ProcessTreeController reports ESRCH as stopped and signals owned POSIX groups", () => {
  const calls = []
  const tree = createProcessTreeController({ signal: (...args) => {
    calls.push(args)
    if (args[1] === 0) throw Object.assign(new Error(), { code: "ESRCH" })
  } })
  assert.deepEqual(tree.inspect(123), { stopped: true, signalSafe: false })
  assert.equal(tree.stop(123, "SIGTERM"), true)
  assert.deepEqual(calls, [[-123, 0], [-123, "SIGTERM"]])
})

test("ProcessTreeController fails closed on non-ESRCH inspection errors", () => {
  const tree = createProcessTreeController({ signal: () => { throw Object.assign(new Error(), { code: "EPERM" }) } })
  assert.deepEqual(tree.inspect(123), { stopped: false, signalSafe: false })
})
