import assert from "node:assert/strict"
import test from "node:test"
import { modelTaskPart, presentTaskResult, restoreTaskModelMessages } from "../src/runtime/task-model-output.mjs"

function part(text = " \nresult\n ") {
  return { type: "tool", tool: "o4e_task", state: { status: "completed", input: { action: "output" }, time: {},
    ...presentTaskResult({ output: text, metadata: { o4eResult: { output: text } } }, "output", false) } }
}

test("hidden result preserves whitespace/empty output, reloads from JSON and leaves unrelated tools untouched", () => {
  for (const text of ["", " \nresult\n "]) {
    const saved = JSON.parse(JSON.stringify(part(text)))
    const before = structuredClone(saved)
    assert.equal(modelTaskPart(saved).state.output, text)
    assert.equal(modelTaskPart(modelTaskPart(saved)).state.output, text)
    assert.deepEqual(saved, before)
    for (const tool of ["bash", "task", "mcp_example"]) {
      const other = { ...saved, tool }
      assert.equal(modelTaskPart(other), other)
    }
  }
})

test("pruned or truncated outputs are never resurrected; malformed or rewritten envelopes fail closed", () => {
  for (const compacted of [0, 123]) {
    const saved = part()
    saved.state.time.compacted = compacted
    assert.equal(modelTaskPart(saved), saved)
  }
  const truncated = part()
  truncated.state.metadata.truncated = true
  assert.equal(modelTaskPart(truncated), truncated)
  for (const mutate of [
    (p) => { p.state.output = "rewritten" },
    (p) => { p.state.input.action = "watch" },
    (p) => { p.state.metadata.o4eResult.output = "changed" },
    (p) => { p.state.metadata.o4eModelOutput.text = "changed" },
  ]) {
    const saved = part()
    mutate(saved)
    assert.throws(() => modelTaskPart(saved), /MODEL_OUTPUT_INVALID/)
  }
})

test("model projection restores assistant ToolParts only and does not rewrite persisted Part objects", () => {
  const saved = part()
  const user = { info: { role: "user" }, parts: [saved] }
  const assistant = { info: { role: "assistant" }, parts: [saved] }
  restoreTaskModelMessages([user, assistant])
  assert.equal(user.parts[0], saved)
  assert.equal(saved.state.output, "")
  assert.equal(assistant.parts[0].state.output, " \nresult\n ")
})

test("message, info, Part and state visibility/summary markers prevent hidden output resurrection", () => {
  for (const marker of [{ synthetic: true }, { ignored: true }, { private: true }, { summary: true },
    { compaction: true }, { mode: "summary" }, { agent: "compaction" }, { visibility: "private" }]) {
    for (const target of ["message", "info", "part", "state"]) {
      const saved = part()
      const message = { info: { role: "assistant" }, parts: [saved] }
      Object.assign({ message, info: message.info, part: saved, state: saved.state }[target], marker)
      restoreTaskModelMessages([message])
      assert.equal(message.parts[0].state.output, "", `${target} ${JSON.stringify(marker)}`)
    }
  }
})
