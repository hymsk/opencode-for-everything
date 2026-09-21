import assert from "node:assert/strict"
import test from "node:test"
import { normalizeOpenCodeEvent } from "../src/adapters/opencode/event-normalizer.mjs"

test("OpenCode Session 和消息事件归一化为 host-neutral 事件", () => {
  assert.deepEqual(normalizeOpenCodeEvent({ type: "session.deleted", properties: { info: { id: "deleted", parentID: "parent" } } }), {
    kind: "deleted",
    sessionID: "deleted",
    session: { id: "deleted", parentID: "parent" },
    parentSessionID: "parent",
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } }), {
    kind: "session-status",
    sessionID: "session",
    status: { type: "busy" },
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "message.part.updated", properties: { sessionID: "session", part: { messageID: "message", id: "part" } } }), {
    kind: "message-part-updated",
    sessionID: "session",
    messageID: "message",
    partID: "part",
    part: { messageID: "message", id: "part" },
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "message.updated", properties: { sessionID: "session", info: { id: "message", role: "user" } } }), {
    kind: "message-updated",
    sessionID: "session",
    messageID: "message",
    messageRole: "user",
    message: { id: "message", role: "user" },
  })
})

test("OpenCode permission 和 question 事件保留所属 Session", () => {
  assert.deepEqual(normalizeOpenCodeEvent({ type: "permission.updated", properties: { sessionID: "session", id: "permission" } }), {
    kind: "permission-waiting",
    sessionID: "session",
    request: undefined,
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "permission.v2.asked", properties: { data: {
    id: "permission",
    sessionID: "session",
    action: "bash",
    resources: ["git status"],
    save: ["git *"],
    source: { type: "tool", messageID: "message", callID: "call" },
  } } }), {
    kind: "permission-waiting",
    sessionID: "session",
    request: {
      kind: "permission",
      requestID: "permission",
      sessionID: "session",
      permission: {
        action: "bash",
        resources: ["git status"],
        save: ["git *"],
        tool: { messageID: "message", callID: "call" },
      },
    },
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "question.asked", properties: { info: {
    sessionID: "session",
    id: "question",
    questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], multiple: false, custom: false }],
  } } }), {
    kind: "question-waiting",
    sessionID: "session",
    request: {
      kind: "question",
      requestID: "question",
      sessionID: "session",
      question: {
        questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], multiple: false, custom: false }],
      },
    },
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "question.asked", properties: { info: {
    sessionID: "session",
    questions: [{ header: "Target", question: "Which target?", options: [] }],
  } } }), {
    kind: "question-waiting",
    sessionID: "session",
    request: undefined,
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "permission.replied", properties: { sessionID: "session", requestID: "permission", reply: "once" } }), {
    kind: "session-resumed",
    sessionID: "session",
    interactionKind: "permission",
    requestID: "permission",
    reply: "once",
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "question.replied", properties: { sessionID: "session", requestID: "question", answers: [["Local"]] } }), {
    kind: "session-resumed",
    sessionID: "session",
    interactionKind: "question",
    requestID: "question",
    answers: [["Local"]],
  })
  assert.deepEqual(normalizeOpenCodeEvent({ type: "question.rejected", properties: { sessionID: "session", requestID: "question" } }), {
    kind: "session-resumed",
    sessionID: "session",
    interactionKind: "question",
    requestID: "question",
    rejected: true,
  })
})
