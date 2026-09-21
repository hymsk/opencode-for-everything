import assert from "node:assert/strict"
import test from "node:test"
import { acquireAutomaticTaskFollow, automaticFollowControl, updateAutomaticFollowControl } from "../src/adapters/opencode/automatic-task-follow.mjs"

test("every real user turn fences an in-flight automatic submission across same-directory facades", () => {
  const first = acquireAutomaticTaskFollow(".")
  const second = acquireAutomaticTaskFollow(".")
  try {
    const claim = first.begin("follow-race", "anchor")
    assert.equal(first.current("follow-race", claim), true)
    second.resume("follow-race")
    assert.equal(first.current("follow-race", claim), false)
    assert.equal(first.finish("follow-race", claim, { accepted: true }), false)
    const next = second.begin("follow-race", "anchor")
    assert.ok(next)
    first.suppress("follow-race")
    assert.equal(second.current("follow-race", next), false)
  } finally { first.release(); second.release() }
})

test("explicit follow control survives loss of shared process state and rejects malformed records", () => {
  const saved = JSON.parse(JSON.stringify(updateAutomaticFollowControl({}, { enabled: false, expectedRevision: 1 })))
  const facade = acquireAutomaticTaskFollow(".")
  facade.suppress("persistent-follow")
  facade.release()
  assert.deepEqual(automaticFollowControl(saved), { enabled: false, revision: 2 })
  assert.throws(() => updateAutomaticFollowControl(saved, { enabled: true, expectedRevision: 1 }), /REVISION_CONFLICT/)
  for (const automaticFollow of [null, [], {}, { enabled: true, revision: 0 }, { enabled: "false", revision: 1 }]) {
    assert.throws(() => automaticFollowControl({ automaticFollow }), /STATE_INVALID/)
  }
})

test("task event delivery is shared, fenced by real follow intent, and not consumed by stale submissions", () => {
  const a = acquireAutomaticTaskFollow(".")
  const b = acquireAutomaticTaskFollow(".")
  try {
    const owner = "event-follow"
    const event = "task:running:revision-1"
    const claim = a.begin(owner, event)
    assert.equal(b.begin(owner, event), undefined)
    assert.equal(b.begin(owner, "overlapping-batch"), undefined)
    assert.equal(a.finish(owner, claim, { accepted: true, taskEvents: [{ taskID: "task", key: event }] }), true)
    assert.equal(b.taskNeedsDelivery(owner, "task", event), false)
    assert.equal(b.begin(owner, event), undefined)
    b.resume(owner)
    assert.equal(a.taskNeedsDelivery(owner, "task", event), true)
    const stale = a.begin(owner, event)
    b.resume(owner)
    const fresh = b.begin(owner, event)
    assert.ok(fresh, "resume must not wait for stale host I/O")
    assert.equal(a.finish(owner, stale, { accepted: true, taskEvents: [{ taskID: "task", key: event }] }), false)
    assert.equal(b.taskNeedsDelivery(owner, "task", event), true)
    assert.equal(b.current(owner, fresh), true)
  } finally { a.release(); b.release() }
})

test("more than 512 unchanged live Task events retain delivery watermarks", () => {
  const follow = acquireAutomaticTaskFollow(".")
  try {
    const events = Array.from({ length: 513 }, (_, index) => ({ taskID: `task-${index}`, key: `event-${index}` }))
    const claim = follow.begin("large-owner", "large-batch")
    follow.finish("large-owner", claim, { accepted: true, taskEvents: events })
    for (const { taskID, key } of events) assert.equal(follow.taskNeedsDelivery("large-owner", taskID, key), false)
    assert.equal(follow.taskNeedsDelivery("large-owner", "task-0", "new-revision"), true)
  } finally { follow.release() }
})

test("terminal submission confirmation uses a finite same-identity allowance shared by facades", () => {
  const a = acquireAutomaticTaskFollow(".")
  const b = acquireAutomaticTaskFollow(".")
  try {
    assert.equal(a.admitTerminalSubmission("terminal-owner", "message"), true)
    assert.equal(b.admitTerminalSubmission("terminal-owner", "message"), true)
    assert.equal(a.admitTerminalSubmission("terminal-owner", "message"), true)
    assert.equal(b.admitTerminalSubmission("terminal-owner", "message"), false)
    b.resume("terminal-owner")
    assert.equal(a.admitTerminalSubmission("terminal-owner", "message"), true)
  } finally { a.release(); b.release() }
})
