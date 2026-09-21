import test from "node:test"
import assert from "node:assert/strict"
import { OUTPUT_LIMITS, truncateLinesTail, truncateUtf8Head, truncateUtf8Tail, utf8Window } from "../src/runtime/output-limits.mjs"

test("shared output limits retain the established budgets", () => {
  assert.deepEqual(OUTPUT_LIMITS, {
    executionViewBytes: 64 * 1024,
    logBytes: 256 * 1024 * 1024,
    shellCardBytes: 256 * 1024 * 1024,
    modelBytes: 48 * 1024,
    modelLines: 1800,
    executeMetadataBytes: 20 * 1024,
    taskMetadataBytes: 40 * 1024,
    hostResultBytes: 49 * 1024,
  })
})

test("shared UTF-8 windows never split a code point", () => {
  const text = "头€尾"
  const bytes = Buffer.from(text)
  assert.equal(utf8Window(bytes, bytes.length), text)
  assert.equal(truncateUtf8Head(text, 4).text, "头")
  assert.equal(truncateUtf8Head(text, 4).truncated, true)
  assert.equal(truncateUtf8Tail(text, 4).text, "尾")
  assert.equal(truncateUtf8Tail(text, 4).truncated, true)
})

test("shared line truncation keeps the final lines", () => {
  assert.deepEqual(truncateLinesTail("a\nb\nc", 2), { text: "b\nc", truncated: true })
  assert.deepEqual(truncateLinesTail("a\nb", 2), { text: "a\nb", truncated: false })
})
