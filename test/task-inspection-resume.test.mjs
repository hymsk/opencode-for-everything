import assert from "node:assert/strict"
import test from "node:test"
import { getEventListeners } from "node:events"
import { resolveInspectionCursors } from "../src/adapters/opencode/task-inspection-resume.mjs"
import { readTaskInspection } from "../src/adapters/opencode/task-inspection.mjs"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"
import { previewLines } from "../src/runtime/task-result-visibility.mjs"

const preview = (taskID, cursor = `${taskID}-cursor`, extra = {}) => ({ taskID, status: "running", tail: "public tail", cursor, ...extra })
const tool = (callID, input, output, status = "completed", extra = {}) => ({
  id: `part-${callID}`, type: "tool", tool: "o4e_task", callID,
  state: { status, input, ...(output === undefined ? {} : { output: previewLines(output).join("\n"), metadata: { o4eResult: output } }) },
  ...extra,
})
const inspect = (callID, taskID, extra = {}) => tool(callID, { action: "inspect", taskID }, preview(taskID, `${callID}-cursor`, extra))
const inspection = (callID, output) => tool(callID, { action: "inspect", taskID: output.taskID }, output)
const current = () => tool("current-call", { action: "inspect", taskID: "a", resume: true }, undefined, "running")
const assistant = (id, parts = [], info = {}) => ({
  info: { id, role: "assistant", sessionID: "parent", ...info },
  parts: parts.map((part) => part && ({ sessionID: "parent", messageID: id, ...part })),
})
const boundary = () => assistant("current-message", [current()])
const args = { sessionID: "parent", messageID: "current-message", callID: "current-call", taskIDs: ["a"] }
const empty = { cursors: {}, unavailable: {} }
const failure = (reason, ids = ["a"]) => ({ cursors: {}, unavailable: Object.fromEntries(ids.map((id) => [id, reason])) })
const initialPreviews = [
  { taskID: "a", status: "running", unchanged: true },
  { taskID: "a", status: "queued", unavailable: "not-dispatched" },
]

function history(messages, { pageSize = 20, onRequest } = {}) {
  const calls = []
  const tokens = new Map()
  const store = {
    messages: () => assert.fail("all-history fallback is forbidden"),
    get: () => assert.fail("no child reads or extra persistence"),
    update: () => assert.fail("resume must not persist anything"),
    async messagePage(sessionID, options) {
      calls.push({ sessionID, ...options })
      assert.equal(sessionID, "parent")
      assert.equal(options.limit, 20)
      assert.ok(options.before === undefined || tokens.has(options.before), "before must be a store-issued opaque token")
      await onRequest?.(options, calls.length)
      const end = options.before === undefined ? messages.length : tokens.get(options.before)
      const start = Math.max(0, end - pageSize)
      const nextCursor = `opaque /+?= page ${start}`
      tokens.set(nextCursor, start)
      return { messages: messages.slice(start, end), ...(start ? { nextCursor } : {}) }
    },
  }
  return { store, calls, read: (options = {}) => resolveInspectionCursors({ ...args, store, ...options }) }
}

test("forward is fresh only after locating the call and exhausting history", async () => {
  const { read, calls } = history([assistant("user", [], { role: "user" }), boundary()], { pageSize: 1 })
  assert.deepEqual(await read(), empty)
  assert.equal(calls.length, 2)
  assert.deepEqual(await read({ direction: "backward" }), failure("resume-no-earlier"))
})

test("resume requires the complete public preview matching current metadata", async () => {
  const prior = tool("readable", { action: "inspect", taskID: "a" }, preview("a", "metadata-cursor"))
  const { read } = history([assistant("prior", [prior]), boundary()])
  assert.deepEqual(await read(), { cursors: { a: "metadata-cursor" }, unavailable: {} })
  for (const output of ["", "Inspection summarized.", prior.state.output.replace("public tail", "public")]) {
    const damaged = structuredClone(prior)
    damaged.state.output = output
    const { read } = history([assistant("older", [inspect("safe", "a")]), assistant("prior", [damaged]), boundary()])
    for (const direction of ["forward", "backward"]) {
      assert.deepEqual(await read({ direction }), failure("resume-preview-unavailable"))
    }
  }
})

test("JSON body without current result metadata cannot supply a resume cursor", async () => {
  const prior = inspect("body-only", "a")
  prior.state.output = JSON.stringify(prior.state.metadata.o4eResult)
  delete prior.state.metadata
  assert.deepEqual(await history([assistant("prior", [prior]), boundary()]).read(), failure("resume-invalid-output"))
})

test("each Task independently selects its nearest inspect preview", async () => {
  const { read } = history([
    assistant("older", [inspection("old-a", preview("a")), inspection("old-b", preview("b"))]),
    assistant("newer", [inspect("new-a", "a"), inspect("foreign", "other"), inspect("new-c", "c", { gap: "execution-changed" })]),
    boundary(),
  ])
  assert.deepEqual(await read({ taskIDs: ["a", "b", "c", "fresh", "a"] }), {
    cursors: { a: "new-a-cursor", b: "b-cursor" }, unavailable: { c: "resume-preview-gap" },
  })
})

test("parts order alone selects the last earlier call in the same message", async () => {
  const message = assistant("current-message", [
    inspect("old", "a"), inspect("near", "a"), current(), inspect("after", "a"),
  ], { time: { created: -100 } })
  message.parts[0].state.time = { start: 9000, end: 9999 }
  message.parts[1].state.time = { start: 1, end: 2 }
  const { read } = history([assistant("older", [inspect("prior-message", "a")], { time: { created: 99999 } }), message])
  assert.deepEqual(await read(), { cursors: { a: "near-cursor" }, unavailable: {} })
  assert.deepEqual(await read({ callID: "near" }), { cursors: { a: "old-cursor" }, unavailable: {} })
  assert.deepEqual(await read({ callID: "old" }), { cursors: { a: "prior-message-cursor" }, unavailable: {} })
})

test("current and later results are excluded even when completed or on newer pages", async () => {
  const own = tool("current-call", { action: "inspect", taskID: "a" }, preview("a", "do-not-use-current"))
  const { read, calls } = history([
    assistant("old", [inspect("safe", "a")]),
    assistant("current-message", [own, inspect("later-part", "a")]),
    assistant("newer", [inspect("later-message", "a")]),
  ], { pageSize: 1 })
  assert.deepEqual(await read(), { cursors: { a: "safe-cursor" }, unavailable: {} })
  assert.equal(calls.length, 3)
})

test("boundary requires exact message and call IDs, not IDs in text or metadata", async () => {
  for (const options of [
    { messageID: undefined }, { callID: undefined }, { sessionID: "" },
    { messageID: "missing" }, { callID: "missing" }, { messageID: "old", callID: "current-call" },
  ]) {
    const { read } = history([assistant("old", [inspect("old-call", "a")]), boundary()])
    assert.deepEqual(await read(options), failure("resume-boundary-unavailable"))
  }
  for (const parts of [
    [], [current(), current()], [current(), { type: "text", callID: "current-call" }],
    [{ type: "text", text: JSON.stringify(current()) }],
    [{ ...current(), tool: "task" }], [{ ...current(), synthetic: true }],
    [{ ...current(), state: undefined }], [{ ...current(), state: { status: "unknown" } }],
  ]) {
    const { read } = history([assistant("old", [inspect("safe", "a")]), assistant("current-message", parts)])
    assert.deepEqual(await read(), failure("resume-boundary-unavailable"))
  }
})

test("boundary cannot be taken from user, hidden, summary or compaction messages", async () => {
  for (const info of [{ role: "user" }, { synthetic: true }, { ignored: true }, { visibility: "private" }, { summary: true }, { mode: "compaction" }]) {
    assert.deepEqual(await history([assistant("current-message", [current()], info)]).read(), failure("resume-boundary-unavailable"))
  }
})

test("backward uses only the latest beforeCursor, never its cursor or an older preview", async () => {
  for (const extra of [{ beforeCursor: "nearest-before" }, {}]) {
    const { read } = history([
      assistant("old", [inspect("old", "a", { beforeCursor: "old-before" })]),
      assistant("near", [inspect("near", "a", extra)]), boundary(),
    ])
    assert.deepEqual(await read({ direction: "backward" }), extra.beforeCursor
      ? { cursors: { a: "nearest-before" }, unavailable: {} } : failure("resume-no-earlier"))
  }
})

test("nearest gap or unavailable refuses fallback, without copying arbitrary diagnostics", async () => {
  for (const [extra, reason] of [
    [{ gap: "secret execution details" }, "resume-preview-gap"],
    [{ unavailable: "secret authorization details" }, "resume-preview-unavailable"],
    [{ gap: false }, "resume-preview-gap"], [{ unavailable: null }, "resume-preview-unavailable"],
  ]) {
    for (const direction of ["forward", "backward"]) {
      const { read } = history([
        assistant("old", [inspect("old", "a", { beforeCursor: "old-before" })]),
        assistant("near", [inspection("near", preview("a", "blocked", { beforeCursor: "blocked-before", ...extra }))]), boundary(),
      ])
      assert.deepEqual(await read({ direction }), failure(reason))
    }
  }
})

test("malformed inspect outputs and missing cursor block the input Task only", async () => {
  for (const output of [
    "not JSON", "```json\n{}\n```", "null", "[]", "3", "{}", "{\"taskID\":", undefined,
    preview("other", "forged"), preview("a", "bad", { status: 1 }),
    preview("a", "bad", { tail: {} }), preview("a", "bad", { unchanged: "true" }),
  ]) {
    const { read } = history([
      assistant("old", [inspect("old-a", "a"), inspect("old-b", "b")]),
      assistant("near", [tool("broken", { action: "inspect", taskID: "a" }, output)]), boundary(),
    ])
    assert.deepEqual(await read({ taskIDs: ["a", "b"] }), {
      cursors: { b: "old-b-cursor" }, unavailable: { a: "resume-invalid-output" },
    })
  }
  for (const output of [{ taskID: "a", status: "running" }, { taskID: "a", status: "running", unchanged: false }]) {
    const { read } = history([assistant("old", [inspect("old", "a")]), assistant("near", [tool("near", { action: "inspect", taskID: "a" }, output)]), boundary()])
    assert.deepEqual(await read(), failure("resume-no-cursor"))
  }
})

test("initial empty and queued not-dispatched previews require an exhausted history before fresh", async () => {
  for (const output of initialPreviews) {
    for (const direction of ["forward", "backward"]) {
      const { read, calls } = history([
        assistant("oldest", [tool("status", { action: "status", taskID: "a" }, "irrelevant", "error")]),
        assistant("first", [tool("first", { action: "inspect", taskID: "a" }, output)]),
        assistant("second", [inspection("second", output)]), boundary(),
      ], { pageSize: 1 })
      assert.deepEqual(await read({ direction }), direction === "forward" ? empty : failure("resume-no-earlier"))
      assert.equal(calls.length, 4)
    }
  }
})

test("empty and not-dispatched previews forbid older anchors, across pages and within the current message", async () => {
  for (const output of initialPreviews) {
    for (const direction of ["forward", "backward"]) {
      for (const extra of [{}, { beforeCursor: "old-before" }]) {
        const { read, calls } = history([
          assistant("old", [inspect("old", "a", extra)]),
          assistant("near", [inspection("near", output)]), boundary(),
        ], { pageSize: 1 })
        assert.deepEqual(await read({ direction }), failure("resume-preview-unavailable"))
        assert.equal(calls.length, 3)
        const sameMessage = history([assistant("current-message", [
          inspection("old", preview("a", "old-cursor", extra)),
          tool("near", { action: "inspect", taskID: "a" }, output), current(), inspect("later", "a"),
        ])])
        assert.deepEqual(await sameMessage.read({ direction }), failure("resume-preview-unavailable"))
      }
    }
  }
})

test("initial-looking previews cannot hide earlier tool failures, gaps or malformed output", async () => {
  const failures = [
    ...["pending", "running", "error"].map((status) => [tool("failed", { action: "inspect", taskID: "a" }, undefined, status), `resume-tool-${status}`]),
    [tool("failed", { action: "inspect", taskID: "a" }, undefined, "error"), "resume-tool-error"],
    [inspection("failed", preview("a", "bad", { gap: "source-missing" })), "resume-preview-gap"],
    [inspection("failed", preview("a", "bad", { unavailable: "inspection-timeout" })), "resume-preview-unavailable"],
    [tool("failed", { action: "inspect", taskID: "a" }, { error: "no reason" }), "resume-invalid-output"],
    [tool("failed", { action: "inspect", taskID: "a" }, "malformed"), "resume-invalid-output"],
    [tool("failed", { action: "inspect", taskID: "a" }, { taskID: "a", status: "running" }), "resume-no-cursor"],
  ]
  for (const output of initialPreviews) {
    for (const [failed, reason] of failures) {
      for (const direction of ["forward", "backward"]) {
        const { read, calls } = history([
          assistant("old", [failed]), assistant("near", [inspection("near", output)]), boundary(),
        ], { pageSize: 1 })
        assert.deepEqual(await read({ direction }), failure(direction === "backward" && reason === "resume-no-cursor" ? "resume-no-earlier" : reason))
        assert.equal(calls.length, 3)
      }
    }
  }
})

test("latest failures still win over both initial-looking previews and older successes", async () => {
  for (const output of initialPreviews) {
    const { read } = history([assistant("current-message", [
      inspect("old", "a"), inspection("empty", output),
      tool("failed", { action: "inspect", taskID: "a" }, undefined, "error"), current(),
    ])])
    for (const direction of ["forward", "backward"]) assert.deepEqual(await read({ direction }), failure("resume-tool-error"))
  }
})

test("not-dispatched is the only unavailable exception and cannot carry preview data", async () => {
  for (const output of [
    ...["inspection-budget", "inspection-timeout", "not-dispatched ", "authorization-unverifiable", "resume-preview-unavailable", null]
      .map((unavailable) => ({ taskID: "a", status: "queued", unchanged: true, unavailable })),
    ...[{ tail: "" }, { tail: "body" }, { cursor: "anchor" }, { beforeCursor: "anchor" }]
      .map((extra) => ({ ...initialPreviews[1], ...extra })),
  ]) {
    const { read } = history([assistant("prior", [inspection("prior", output)]), boundary()])
    for (const direction of ["forward", "backward"]) assert.deepEqual(await read({ direction }), failure("resume-preview-unavailable"))
  }
  for (const initial of initialPreviews) {
    for (const extra of [{ gap: "source-missing" }, { status: null }, { unchanged: "true" }]) {
      const { read } = history([assistant("prior", [inspection("prior", { ...initial, ...extra })]), boundary()])
      assert.deepEqual(await read(), failure(extra.gap ? "resume-preview-gap" : "resume-invalid-output"))
    }
  }
})

test("initial-looking previews prove freshness at 100 exhausted messages, never at a truncated limit", async () => {
  for (const output of initialPreviews) {
    for (const direction of ["forward", "backward"]) {
      for (const oldest of [[], [inspect("old-anchor", "a")]]) {
        const messages = [
          assistant("oldest", oldest), ...Array.from({ length: 97 }, (_, i) => assistant(`filler-${i}`)),
          assistant("initial", [inspection("initial", output)]), boundary(),
        ]
        const exhausted = history(messages)
        assert.deepEqual(await exhausted.read({ direction }), oldest.length ? failure("resume-preview-unavailable")
          : direction === "forward" ? empty : failure("resume-no-earlier"))
        assert.equal(exhausted.calls.length, 5)
        messages.splice(1, 0, assistant("one-more"))
        const truncated = history(messages)
        assert.deepEqual(await truncated.read({ direction }), failure("resume-history-limit"))
        assert.equal(truncated.calls.length, 5)
      }
    }
  }
})

test("unanchored scan does not mask pagination failure or abort with fresh", async () => {
  for (const output of initialPreviews) {
    for (const abort of [false, true]) {
      const controller = new AbortController()
      const { read, calls } = history([assistant("old"), assistant("initial", [inspection("initial", output)]), boundary()], {
        pageSize: 2,
        onRequest(_options, count) {
          if (count !== 2) return
          if (abort) controller.abort()
          else throw new Error("unverifiable older history")
        },
      })
      assert.deepEqual(await read({ signal: controller.signal }), failure(abort ? "aborted" : "resume-page-unavailable"))
      assert.equal(calls.length, 2)
    }
  }
})

test("cursor fields must be nonempty strings of at most 512 characters", async () => {
  for (const key of ["cursor", "beforeCursor"]) {
    for (const value of ["", " \t\n", "x".repeat(513), null, 12, {}, []]) {
      const { read } = history([
        assistant("old", [inspect("old", "a")]),
        assistant("near", [inspect("near", "a", { [key]: value })]), boundary(),
      ])
      assert.deepEqual(await read(), failure("resume-invalid-output"))
      assert.deepEqual(await read({ direction: "backward" }), failure("resume-invalid-output"))
    }
  }
  const exact = `  opaque /+?= ${"x".repeat(496)}  `
  assert.equal(exact.length, 512)
  const { read } = history([assistant("prior", [inspect("old", "a", { cursor: exact, beforeCursor: exact })]), boundary()])
  for (const direction of ["forward", "backward"]) assert.deepEqual(await read({ direction }), { cursors: { a: exact }, unavailable: {} })
})

test("pending, running and error calls take precedence over old successes", async () => {
  for (const status of ["pending", "running", "error"]) {
    const { read } = history([
      assistant("old", [inspect("old-a", "a"), inspect("old-b", "b")]),
      assistant("near", [tool("incomplete", { action: "inspect", taskID: "a" }, { reason: "actionable", ...preview("a", "untrusted") }, status)]), boundary(),
    ])
    assert.deepEqual(await read({ taskIDs: ["a", "b"] }), {
      cursors: { b: "old-b-cursor" }, unavailable: { a: `resume-tool-${status}` },
    })
  }
})

test("a later success supersedes an older failed preview, not vice versa", async () => {
  const { read } = history([
    assistant("old", [tool("failed", { action: "inspect", taskID: "a" }, undefined, "error")]),
    assistant("near", [inspect("new", "a")]), boundary(),
  ])
  assert.deepEqual(await read(), { cursors: { a: "new-cursor" }, unavailable: {} })
})

test("host empty or damaged tool input blocks old anchors and first fresh reads", async () => {
  for (const status of ["pending", "running", "error", "completed"]) {
    for (const input of [{}, undefined, null, [], { action: "inspect" }, { action: "inspect", taskID: 1 }, { action: "future" }]) {
      for (const anchored of [false, true]) for (const direction of ["forward", "backward"]) {
        const parts = [
          ...(anchored ? [inspect("old-a", "a"), inspect("old-b", "b")] : []),
          tool("incomplete", input, undefined, status), current(),
        ]
        const reason = status === "completed" ? "resume-invalid-input" : `resume-tool-${status}`
        assert.deepEqual(await history([assistant("current-message", parts)]).read({ taskIDs: ["a", "b"], direction }), failure(reason, ["a", "b"]))
      }
    }
  }
})

test("unknown input only blocks unresolved Tasks and never uses raw arguments as a selector", async () => {
  const pending = tool("incomplete", {}, undefined, "pending")
  pending.state.raw = '{"action":"status","taskID":"other"}'
  const messages = [assistant("old", [inspect("old-b", "b")]), assistant("unknown", [pending]),
    assistant("new", [inspect("new-a", "a")]), boundary()]
  assert.deepEqual(await history(messages, { pageSize: 1 }).read({ taskIDs: ["a", "b"] }), {
    cursors: { a: "new-a-cursor" }, unavailable: { b: "resume-tool-pending" },
  })
})

test("an earlier pending call in the current message cannot be masked by old success", async () => {
  for (const status of ["pending", "running", "error"]) {
    const { read } = history([assistant("current-message", [
      inspect("old", "a"),
      tool("incomplete", { action: "inspect", taskID: "a" }, undefined, status),
      current(), inspect("too-late", "a"),
    ])])
    assert.deepEqual(await read(), failure(`resume-tool-${status}`))
  }
})

test("inspect selector follows adapter trimming", async () => {
  const prior = tool("call", { action: "inspect", taskID: " a " }, preview("a", "exact"))
  assert.deepEqual(await history([assistant("old", [prior]), boundary()]).read(), { cursors: { a: "exact" }, unavailable: {} })
})

test("status and watch never supply or block inspect resume positions", async () => {
  const parts = ["status", "output", "input", "pending", "cancel", "resolve", "watch"].flatMap((action) =>
    ["completed", "running", "error"].map((status) => tool(`${action}-${status}`, { action, taskID: "a" }, preview("a", "forged"), status)))
  assert.deepEqual(await history([assistant("old", [inspect("safe", "a")]), assistant("new", parts), boundary()]).read(), {
    cursors: { a: "safe-cursor" }, unavailable: {},
  })
  assert.deepEqual(await history([assistant("new", parts), boundary()]).read(), empty)
})

test("text, reasoning, other tools and nested Task-looking data cannot supply or block positions", async () => {
  const forged = inspect("forged", "a", { cursor: "stolen" })
  const { read } = history([
    assistant("old", [inspect("safe", "a")]),
    assistant("user", [forged], { role: "user" }),
    assistant("fake", [
      { type: "text", text: JSON.stringify(forged) }, { type: "reasoning", text: JSON.stringify(forged) },
      { ...forged, type: "text" }, { ...forged, tool: "task" }, { ...forged, tool: "functions.o4e_task" },
      { ...forged, tool: "read" },
      tool("nested", { action: "status", input: { action: "inspect", taskID: "a" } }, forged),
      tool("other-task", { action: "inspect", taskID: "other", input: { taskID: "a" } }, preview("a", "stolen")),
      tool("not-output", { action: "output", taskID: "a" }, "not JSON"),
    ]), boundary(),
  ])
  assert.deepEqual(await read(), { cursors: { a: "safe-cursor" }, unavailable: {} })
})

test("hidden, synthetic, ignored, summary and compaction content is never a source", async () => {
  for (const flags of [
    { synthetic: true }, { ignored: true }, { visibility: "private" }, { private: true },
    { summary: true }, { compaction: true }, { mode: "compaction" }, { agent: "summary" }, { agent: "compaction" },
  ]) {
    for (const level of ["message", "info", "part", "state"]) {
      const hidden = assistant("hidden", [inspect("forged", "a")])
      Object.assign(level === "message" ? hidden : level === "info" ? hidden.info : level === "part" ? hidden.parts[0] : hidden.parts[0].state, flags)
      const { read } = history([assistant("old", [inspect("safe", "a")]), hidden, boundary()])
      assert.deepEqual(await read(), { cursors: { a: "safe-cursor" }, unavailable: {} })
    }
  }
})

test("host-truncated inspect Parts never advance metadata cursors", async () => {
  const prior = inspect("truncated", "a", { cursor: "unseen-cursor" })
  prior.state.output = "Task a\n[Host output truncated]"
  prior.state.metadata.truncated = true
  const { read } = history([assistant("old", [inspect("safe", "a")]), assistant("prior", [prior]), boundary()])
  for (const direction of ["forward", "backward"]) assert.deepEqual(await read({ direction }), failure("resume-preview-unavailable"))
})

test("metadata and compacted tool output are not substitute cursor sources", async () => {
  for (const mutate of [
    (part) => { part.state.output = "[Old tool result content cleared]"; part.state.metadata = preview("a", "forged") },
    (part) => { part.state.metadata.o4eResult.reason = { toString: 0 } },
    (part) => { part.state.time = { compacted: 123 } },
    (part) => { delete part.callID },
    (part) => { part.state.output = preview("a", "object-not-persisted-string") },
  ]) {
    const bad = inspect("bad", "a")
    mutate(bad)
    const result = await history([assistant("old", [inspect("safe", "a")]), assistant("bad", [bad]), boundary()]).read()
    assert.deepEqual(result.cursors, {})
    assert.ok(result.unavailable.a)
  }
})

test("foreign or missing page session identity fails closed without stealing cursors", async () => {
  for (const sessionID of ["child", "other-parent", undefined]) {
    const { read, calls } = history([assistant("foreign", [inspect("stolen", "a")], { sessionID }), boundary()])
    assert.deepEqual(await read(), failure("resume-invalid-page"))
    assert.ok(calls.every((call) => call.sessionID === "parent"))
  }
  for (const extra of [{ sessionID: "child" }, { messageID: "foreign-message" }]) {
    const { read } = history([assistant("bad", [{ ...inspect("stolen", "a"), ...extra }]), boundary()])
    assert.deepEqual(await read(), failure("resume-invalid-page"))
  }
})

test("opaque pagination walks at most five pages and retains independently found Tasks", async () => {
  const messages = [
    assistant("too-old", [inspect("out-of-range", "b")]),
    ...Array.from({ length: 110 }, (_, i) => assistant(`filler-${i}`)),
    assistant("recent", [inspect("recent", "a")]), boundary(),
  ]
  const { read, calls } = history(messages)
  assert.deepEqual(await read({ taskIDs: ["a", "b"] }), { cursors: { a: "recent-cursor" }, unavailable: { b: "resume-history-limit" } })
  assert.equal(calls.length, 5)
  assert.equal(calls[0].before, undefined)
  assert.ok(calls.slice(1).every((call) => call.before.startsWith("opaque /+?= page ")))
  assert.deepEqual(await history(messages).read({ taskIDs: ["b"], direction: "backward" }), failure("resume-history-limit", ["b"]))
})

test("source on the fifth page is usable, and exactly 100 exhausted messages can be fresh", async () => {
  for (const parts of [[], [inspect("last-page", "a")]]) {
    const messages = [assistant("oldest", parts), ...Array.from({ length: 98 }, (_, i) => assistant(`filler-${i}`)), boundary()]
    const { read, calls } = history(messages)
    assert.deepEqual(await read(), parts.length ? { cursors: { a: "last-page-cursor" }, unavailable: {} } : empty)
    assert.equal(calls.length, 5)
  }
})

test("unlocated boundary is not fresh, whether exhausted or outside the history limit", async () => {
  assert.deepEqual(await history([]).read(), failure("resume-boundary-unavailable"))
  assert.deepEqual(await history([assistant("old", [inspect("old", "a")])]).read(), failure("resume-boundary-unavailable"))
  const messages = [boundary(), ...Array.from({ length: 100 }, (_, i) => assistant(`new-${i}`, [inspect(`new-${i}`, "a")]))]
  const { read, calls } = history(messages)
  assert.deepEqual(await read(), failure("resume-history-limit"))
  assert.equal(calls.length, 5)
})

test("duplicate message IDs within or across pages and token loops invalidate the scan", async () => {
  const fixtures = [
    [{ messages: [assistant("duplicate"), assistant("duplicate"), boundary()] }],
    [{ messages: [assistant("duplicate"), boundary()], nextCursor: "one" }, { messages: [assistant("duplicate")] }],
    [{ messages: [boundary()], nextCursor: "loop" }, { messages: [assistant("older")], nextCursor: "loop" }],
    [{ messages: [boundary()], nextCursor: "one" }, { messages: [assistant("older")], nextCursor: "two" }, { messages: [assistant("oldest")], nextCursor: "one" }],
  ]
  for (const pages of fixtures) {
    let calls = 0
    const store = { messagePage: async () => pages[calls++] }
    assert.deepEqual(await resolveInspectionCursors({ ...args, store }), failure("resume-pagination-changed"))
    assert.equal(calls, pages.length)
  }
})

test("malformed messages and blank resume tokens reject without an all-history fallback", async () => {
  for (const page of [
    { messages: [null] }, { messages: [{ info: { id: "a", sessionID: "parent" }, parts: {} }] },
    { messages: [assistant("broken", [null])] },
    { messages: [boundary()], nextCursor: " " },
  ]) {
    const store = { messagePage: async () => page, messages: () => assert.fail("no fallback") }
    assert.deepEqual(await resolveInspectionCursors({ ...args, store }), failure("resume-invalid-page"))
  }
})

test("store validates SDK header provenance; a normalized test store needs only nextCursor", async () => {
  for (const response of [undefined, { headers: {} }]) {
    const store = new OpenCodeSessionStore({ session: { messages: async () => ({ data: [boundary()], response }) } }, "/workspace")
    assert.deepEqual(await resolveInspectionCursors({ ...args, store }), failure("resume-page-unavailable"))
  }
  const store = { messagePage: async () => ({ messages: [boundary()], nextCursor: undefined }) }
  assert.deepEqual(await resolveInspectionCursors({ ...args, store }), empty)
})

test("page size cannot prove exhaustion while a nextCursor exists", async () => {
  let calls = 0
  const store = { messagePage: async () => ({ messages: [calls++ === 0 ? boundary() : assistant(`old-${calls}`)], nextCursor: `token-${calls}` }) }
  assert.deepEqual(await resolveInspectionCursors({ ...args, store }), failure("resume-history-limit"))
  assert.equal(calls, 5)
})

test("failed reads and invalid arguments do not expose raw errors", async () => {
  assert.deepEqual(await resolveInspectionCursors({ ...args, store: { messagePage() { throw new Error("secret") } } }), failure("resume-page-unavailable"))
  const { read, calls } = history([boundary()])
  assert.deepEqual(await read({ direction: "sideways" }), failure("resume-invalid-direction"))
  assert.deepEqual(await read({ taskIDs: ["a", null] }), failure("resume-invalid-tasks"))
  assert.deepEqual(await read({ taskIDs: [] }), empty)
  assert.equal(calls.length, 0)
})

test("unverifiable later pages discard partial results rather than assert a trustworthy scan", async () => {
  for (const broken of [undefined, { messages: [assistant("foreign", [], { sessionID: "foreign" })] }]) {
    let calls = 0
    const store = { messagePage: async () => {
      if (++calls === 1) return { messages: [assistant("near", [inspect("found", "a")]), boundary()], nextCursor: "older" }
      if (broken) return broken
      throw new Error("private page failure")
    } }
    assert.deepEqual(await resolveInspectionCursors({ ...args, taskIDs: ["a", "b"], store }),
      failure(broken ? "resume-invalid-page" : "resume-page-unavailable", ["a", "b"]))
    assert.equal(calls, 2)
  }
})

test("abort before and during I/O returns unavailable and cleans up its listener", async () => {
  const before = new AbortController()
  before.abort(new Error("secret"))
  const { read, calls } = history([boundary()])
  assert.deepEqual(await read({ signal: before.signal }), failure("aborted"))
  assert.equal(calls.length, 0)
  for (const settle of [true, false]) {
    const controller = new AbortController()
    let count = 0
    const store = { messagePage: async (_id, { signal }) => {
      count++
      assert.equal(signal, controller.signal)
      queueMicrotask(() => controller.abort(new Error("secret")))
      return settle ? { messages: [boundary()] } : new Promise(() => {})
    } }
    assert.deepEqual(await resolveInspectionCursors({ ...args, store, signal: controller.signal }), failure("aborted"))
    assert.equal(count, 1)
    assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  }
})

test("abort between pages discards partial positions and prevents further reads", async () => {
  const controller = new AbortController()
  const { read, calls } = history([assistant("older"), assistant("near", [inspect("found", "a")]), boundary()], {
    pageSize: 2,
    onRequest({ signal }, count) { assert.equal(signal, controller.signal); if (count === 2) controller.abort() },
  })
  assert.deepEqual(await read({ signal: controller.signal, taskIDs: ["a", "b"] }), failure("aborted", ["a", "b"]))
  assert.equal(calls.length, 2)
})

test("no cross-call cache: ongoing output and new calls preserve stored opaque cursor exactly", async () => {
  const exact = "  opaque original /+?= cursor  "
  const stored = inspect("previous", "a", { cursor: exact })
  const messages = [assistant("old", [stored]), boundary()]
  const { read, calls } = history(messages)
  const controller = new AbortController()
  for (let count = 0; count < 3; count++) {
    messages.push(assistant(`streaming-${count}`, [{ type: "text", text: `continuously growing ${count}` }, inspect(`future-${count}`, "a")]))
    assert.deepEqual(await read({ signal: controller.signal }), { cursors: { a: exact }, unavailable: {} })
    assert.equal(getEventListeners(controller.signal, "abort").length, 0)
  }
  assert.equal(calls.length, 3)
  messages[0].parts[0].state.metadata.o4eResult = preview("a", "changed-persisted-cursor")
  assert.deepEqual(await read(), failure("resume-preview-unavailable"))
  messages[0].parts[0].state.output = previewLines(messages[0].parts[0].state.metadata.o4eResult).join("\n")
  assert.deepEqual(await read(), { cursors: { a: "changed-persisted-cursor" }, unavailable: {} })
  messages.splice(0, 1)
  assert.deepEqual(await read(), empty)
})

test("real reader receives the exact stored cursor and reads appended output rather than latest tail", async () => {
  const record = { kind: "agent", taskID: "a", childSessionID: "child", dispatchMessageID: "dispatch", runGeneration: 0, attemptNumber: 1 }
  const childMessages = [
    { info: { id: "dispatch", sessionID: "child", role: "user" }, parts: [] },
    { info: { id: "answer", sessionID: "child", role: "assistant", parentID: "dispatch" }, parts: [{ id: "body", type: "text", text: "original" }] },
  ]
  const childStore = { messagePage: async (sessionID) => {
    assert.equal(sessionID, "child")
    return { messages: childMessages }
  } }
  const initial = await readTaskInspection({ store: childStore, record })
  assert.equal(initial.tail, "original")
  const messages = [assistant("previous", [tool("inspect", { action: "inspect", taskID: "a" }, { taskID: "a", status: "running", ...initial })]), boundary()]
  const { read } = history(messages)
  for (const appended of ["-first", "-second", "-third"]) {
    childMessages[1].parts[0].text += appended
    const resumed = await read()
    assert.equal(resumed.cursors.a, initial.cursor)
    assert.deepEqual(resumed.unavailable, {})
    const next = await readTaskInspection({ store: childStore, record, cursor: resumed.cursors.a })
    assert.equal(next.tail, childMessages[1].parts[0].text.slice("original".length))
    assert.equal(next.gap, undefined)
    assert.equal(next.unavailable, undefined)
  }
})

test("queued and empty first previews transition to a real anchor without retaining unanchored state", async () => {
  const record = { kind: "agent", taskID: "a", childSessionID: "child", dispatchMessageID: "dispatch", runGeneration: 0, attemptNumber: 1 }
  const childMessages = [{ info: { id: "dispatch", sessionID: "child", role: "user" }, parts: [] }]
  const childStore = { messagePage: async () => ({ messages: childMessages }) }
  const messages = [assistant("queued", [inspection("queued", initialPreviews[1])]), boundary()]
  const { read } = history(messages)
  assert.deepEqual(await read(), empty)
  const initial = await readTaskInspection({ store: childStore, record })
  assert.deepEqual(initial, { unchanged: true })
  messages.splice(-1, 0, assistant("no-body", [inspection("no-body", { taskID: "a", status: "running", ...initial })]))
  assert.deepEqual(await read(), empty)

  childMessages.push({
    info: { id: "answer", sessionID: "child", role: "assistant", parentID: "dispatch" },
    parts: [{ id: "body", type: "text", text: "first public output" }],
  })
  const { cursors } = await read()
  const anchored = await readTaskInspection({ store: childStore, record, cursor: cursors.a })
  assert.equal(anchored.tail, "first public output")
  messages.splice(-1, 0, assistant("anchored", [inspection("anchored", { taskID: "a", status: "running", ...anchored })]))
  assert.deepEqual(await read(), { cursors: { a: anchored.cursor }, unavailable: {} })
  childMessages[1].parts[0].text += "-appended"
  assert.equal((await readTaskInspection({ store: childStore, record, cursor: (await read()).cursors.a })).tail, "-appended")

  messages.splice(-1, 0, assistant("lost-source", [inspection("lost-source", { taskID: "a", status: "running", ...initial })]))
  assert.deepEqual(await read(), failure("resume-preview-unavailable"))
})

test("Task IDs cannot mutate the prototype of result records", async () => {
  const { read } = history([assistant("prior", [inspect("proto", "__proto__"), inspect("constructor", "constructor")]), boundary()])
  const result = await read({ taskIDs: ["__proto__", "constructor"] })
  assert.equal(Object.getPrototypeOf(result.cursors), Object.prototype)
  assert.equal(Object.hasOwn(result.cursors, "__proto__"), true)
  assert.equal(result.cursors.__proto__, "proto-cursor")
  assert.equal(result.cursors.constructor, "constructor-cursor")
})
