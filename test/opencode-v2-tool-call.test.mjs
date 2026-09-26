import test from "node:test"
import assert from "node:assert/strict"
import { withV2ToolCall } from "../src/adapters/opencode-v2/tool-call.mjs"

function toolContext() {
  const seen = []
  const context = {
    sessionID: "ses_test", messageID: "msg_test", id: "call_test", agent: "build",
    signal: new AbortController().signal,
    progress: async function (metadata) { assert.equal(this, context); seen.push(metadata) },
  }
  return { seen, context }
}

test("V2 live tool call binds provenance and progress without elevating authorization or part update", async () => {
  const { context, seen } = toolContext()
  let retained
  const result = await withV2ToolCall(context, async (call) => {
    retained = call
    assert.deepEqual(call.origin, {
      sessionID: "ses_test", agent: "build", messageID: "msg_test", callID: "call_test",
    })
    assert.equal(call.signal, context.signal)
    await call.progress({ title: "still running" })
    assert.throws(() => call.ask({ action: "shell" }), /O4E_V2_PORT_UNAVAILABLE:authorization.ask/)
    assert.throws(() => call.updateOriginalPart({ content: "done" }), /O4E_V2_PORT_UNAVAILABLE:original-part.update/)
    return { content: "done" }
  })
  assert.deepEqual(result, { content: "done" })
  assert.deepEqual(seen, [{ title: "still running" }])
  assert.throws(() => retained.progress({ title: "late" }), /O4E_V2_PORT_UNAVAILABLE:tool.progress/)
})

test("V2 malformed tool origin and progress fail closed before executing", async () => {
  let ran = false
  const { context } = toolContext()
  await assert.rejects(() => withV2ToolCall({ ...context, messageID: undefined }, async () => { ran = true }),
    /O4E_V2_PORT_UNAVAILABLE:tool.call/)
  assert.equal(ran, false)
})

test("V2 progress handle is revoked when the live tool call rejects", async () => {
  const { context } = toolContext()
  let retained
  await assert.rejects(() => withV2ToolCall(context, async (call) => {
    retained = call
    throw new Error("tool failed")
  }), /tool failed/)
  assert.throws(() => retained.progress({ title: "late" }), /O4E_V2_PORT_UNAVAILABLE:tool.progress/)
})
