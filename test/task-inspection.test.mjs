import assert from "node:assert/strict"
import test from "node:test"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"
import { readTaskInspection } from "../src/adapters/opencode/task-inspection.mjs"

const record = { kind: "agent", taskID: "task", childSessionID: "child", dispatchMessageID: "dispatch", runGeneration: 0, attemptNumber: 1 }
const text = (value, extra = {}) => ({ id: "text", type: "text", text: value, ...extra })
const user = (id, parts = []) => ({ info: { id, sessionID: "child", role: "user" }, parts })
const assistant = (id, value, parentID = "dispatch", extra = {}) => ({
  info: { id, sessionID: "child", role: "assistant", parentID, ...extra },
  parts: Array.isArray(value) ? value : [text(value)],
})

function history(messages, { pageSize = 20, onRequest } = {}) {
  const calls = []
  const tokens = new Map()
  const client = createOpencodeClient({
    baseUrl: "http://inspection.test",
    fetch: async (request) => {
      const url = new URL(request.url)
      calls.push({ url, signal: request.signal })
      await onRequest?.(request, calls.length)
      assert.equal(url.pathname, "/session/child/message")
      assert.equal(url.searchParams.get("directory"), "/workspace")
      assert.equal(url.searchParams.get("limit"), "20")
      const before = url.searchParams.get("before")
      assert.ok(before === null || tokens.has(before), "before must be a server-issued opaque token")
      const end = before === null ? messages.length : tokens.get(before)
      const start = Math.max(0, end - pageSize)
      const token = `opaque /+?= ${start}`
      tokens.set(token, start)
      return Response.json(messages.slice(start, end), {
        headers: start ? { "x-NeXt-CuRsOr": token } : {},
      })
    },
  })
  const store = new OpenCodeSessionStore(client, "/workspace")
  return { store, calls, read: (args = {}) => readTaskInspection({ store, record, directory: "/workspace", ...args }) }
}

function assertBody(result, expected, maxBytes) {
  assert.equal(result.tail, expected)
  assert.ok(Buffer.byteLength(result.tail) <= maxBytes)
  assert.equal(result.tail.includes("\ufffd"), false)
  assert.ok(result.cursor.length <= 120)
  if (result.beforeCursor !== undefined) assert.ok(result.beforeCursor.length <= 120)
}

test("messagePage uses SDK path/query, opaque response headers and signal", async () => {
  const messages = Array.from({ length: 23 }, (_, i) => assistant(`a${i}`, String(i)))
  const { store, calls } = history(messages)
  const controller = new AbortController()
  const first = await store.messagePage("child", { limit: 20, signal: controller.signal })
  assert.deepEqual(first.messages, messages.slice(3))
  assert.equal(first.nextCursor, "opaque /+?= 3")
  const second = await store.messagePage("child", { before: first.nextCursor, limit: 20, signal: controller.signal })
  assert.deepEqual(second, { messages: messages.slice(0, 3), nextCursor: undefined })
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
  await assert.rejects(store.messagePage("child", { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls.length, 2)
})

test("messagePage rejects unsupported responses and count overflow without history fallback", async () => {
  for (const result of [
    { data: {} }, { data: undefined }, { data: Array(21).fill({}) },
    { data: [], response: { headers: new Headers({ "X-Next-Cursor": "next" }) } },
    { data: [], response: { headers: new Headers({ "X-Next-Cursor": "x".repeat(4097) }) } },
    { data: [], response: { headers: new Headers({ "X-Next-Cursor": "" }) } },
    { data: [] }, { error: "secret exception" },
  ]) {
    let calls = 0
    const store = new OpenCodeSessionStore({ session: { messages: async () => { calls++; return result } } }, "/workspace")
    await assert.rejects(store.messagePage("child"))
    assert.equal(calls, 1)
  }
  const store = new OpenCodeSessionStore({ session: { messages: () => assert.fail("must not read") } }, "/workspace")
  for (const limit of [0, -1, 21, 1.5, Infinity]) await assert.rejects(store.messagePage("child", { limit }))
  for (const before of ["", 1, "x".repeat(4097)]) await assert.rejects(store.messagePage("child", { before }))
})

test("a whole public tail has no beforeCursor just because the dispatch is on an older host page", async () => {
  const messages = [
    user("dispatch"),
    ...Array.from({ length: 19 }, (_, i) => assistant(`reasoning${i}`, [{ type: "reasoning", text: "private" }])),
    assistant("current", "public"),
  ]
  for (const direction of ["forward", "backward"]) {
    for (const maxBytes of [6, 1024]) {
      const { read, calls } = history(messages)
      const result = await read({ direction, maxBytes })
      assertBody(result, "public", maxBytes)
      assert.equal(result.beforeCursor, undefined)
      assert.equal(result.gap, undefined)
      assert.equal(calls.length, 2)
    }
  }
})

test("older filtered or unrelated messages do not prove earlier public bytes", async () => {
  for (const earlier of [
    assistant("earlier", [{ type: "reasoning", text: "private" }]),
    assistant("earlier", [text("private", { synthetic: true })]),
    assistant("earlier", [text("private", { ignored: true })]),
    assistant("earlier", [text("private", { visibility: "private" })]),
    assistant("earlier", [{ type: "tool", tool: "hidden", visibility: "private", state: { status: "completed" } }]),
    assistant("earlier", "private", "dispatch", { summary: true }),
    assistant("earlier", "private", "dispatch", { mode: "compaction" }),
    assistant("earlier", "unrelated", "other-dispatch"),
  ]) {
    const { read, calls } = history([
      user("dispatch"), earlier,
      ...Array.from({ length: 19 }, (_, i) => assistant(`reasoning${i}`, [{ type: "reasoning", text: "private" }])),
      assistant("current", "public"),
    ])
    const result = await read({ maxBytes: 6 })
    assertBody(result, "public", 6)
    assert.equal(result.beforeCursor, undefined)
    assert.equal(result.gap, undefined)
    assert.equal(calls.length, 2)
  }
})

test("direct current dispatch attribution bounds prefix proof and excludes other turns", async () => {
  const messages = [user("dispatch"), ...Array.from({ length: 200 }, (_, i) => assistant(`old${i}`, "old", "old-dispatch")), assistant("current", "public")]
  const { read, calls } = history(messages)
  const initial = await read()
  assertBody(initial, "public", 1024)
  assert.equal(initial.beforeCursor, undefined)
  assert.equal(initial.gap, "page-limit")
  assert.equal(calls.length, 5)
  messages.push(user("other"), assistant("foreign", "not this task", "other"))
  const next = await read()
  assertBody(next, "public", 1024)
  assert.equal(next.beforeCursor, undefined)
  assert.equal(next.gap, "page-limit")
  assert.equal(calls.length, 10)
})

test("older unrelated compaction does not invalidate direct attribution during bounded prefix proof", async () => {
  const messages = [
    ...Array.from({ length: 200 }, (_, i) => user(`old${i}`)),
    user("old-continue", [text("Continue", { synthetic: true, metadata: { compaction_continue: true } })]),
    assistant("old-summary-answer", "unrelated", "old-continue"),
    assistant("current", "public"),
  ]
  const { read, calls } = history(messages)
  const result = await read()
  assertBody(result, "public", 1024)
  assert.equal(result.beforeCursor, undefined)
  assert.equal(result.gap, "page-limit")
  assert.equal(calls.length, 5)
})

test("unknown latest parent cannot silently turn an older current message into the latest preview", async () => {
  const { read } = history([user("dispatch"), assistant("current", "old output"), assistant("unverified", "secret", "missing")])
  assert.deepEqual(await read(), { gap: "lineage-unverified" })
})

test("only public assistant text and bounded sanitized tool name/status are projected", async () => {
  const message = assistant("a", [
    text("visible"), text("synthetic-secret", { synthetic: true }), text("ignored-secret", { ignored: true }),
    text("private-secret", { visibility: "private" }),
    { type: "reasoning", text: "reasoning-secret" },
    { type: "tool", id: "tool", tool: "read\n\u001b[31m", state: { status: "running", input: "input-secret", output: "output-secret", metadata: { secret: "secret" } } },
    { type: "tool", tool: "x".repeat(100), state: { status: "status-secret" } },
    { type: "tool", tool: "hidden", synthetic: true, state: { status: "completed" } },
    { type: "file", text: "file-secret" },
  ])
  const { read } = history([
    user("dispatch", [text("user-secret")]), message,
    assistant("summary", "summary-secret", "dispatch", { summary: true }),
    assistant("compact", "compaction-secret", "dispatch", { mode: "compaction" }),
    assistant("ignored", "ignored-message-secret", "dispatch", { ignored: true }),
    assistant("private", "private-message-secret", "dispatch", { visibility: "private" }),
  ])
  assertBody(await read(), `visible\n[tool read___31m: running]\n[tool ${"x".repeat(64)}: unknown]`, 1024)
})

test("read, glob and grep expose only bounded workspace-relative whitelist summaries", async () => {
  const { read } = history([
    user("dispatch"),
    assistant("tools", [
      { id: "read", type: "tool", tool: "read", state: { status: "running", input: {
        filePath: "/workspace/src/runtime/task.ts", offset: 10, token: "must-not-leak",
      }, output: "must-not-leak" } },
      { id: "glob", type: "tool", tool: "glob", state: { status: "completed", input: {
        path: "/workspace/src", pattern: "**/*.mjs", query: "must-not-leak",
      } } },
      { id: "grep", type: "tool", tool: "grep", state: { status: "pending", input: {
        path: "test", pattern: "TODO|FIXME", include: "*.mjs", secret: "must-not-leak",
      } } },
    ]),
  ])
  const result = await read()
  assertBody(result, [
    '[tool read file="src/runtime/task.ts": running]',
    '[tool glob path="src" pattern="**/*.mjs": completed]',
    '[tool grep path="test" pattern="TODO|FIXME": pending]',
  ].join("\n"), 1024)
  const decoded = Buffer.from(result.cursor, "base64url").toString("utf8")
  assert.equal(decoded.includes("src/runtime/task.ts"), false, "cursor payload must retain only hashes and positions")
  assert.equal(decoded.includes("must-not-leak"), false)
})

test("sensitive, external, URL-query and oversized inputs fall back to tool name/status", async () => {
  const oversized = `src/${"a".repeat(600)}.ts`
  const longPattern = "A".repeat(97)
  const { read } = history([user("dispatch"), assistant("tools", [
    { id: "env", type: "tool", tool: "read", state: { status: "running", input: { filePath: "/workspace/.env" } } },
    { id: "url", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "https://example.test/code.ts?token=top-secret" } } },
    { id: "query", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/workspace/src/app.ts?token=top-secret" } } },
    { id: "external", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/outside/private-key.pem" } } },
    { id: "token-file", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/workspace/tmp/ghp_1234567890abcdefghijklmn" } } },
    { id: "long-read", type: "tool", tool: "read", state: { status: "completed", input: { filePath: oversized } } },
    { id: "long-grep", type: "tool", tool: "grep", state: { status: "running", input: { path: "/workspace/src", pattern: longPattern } } },
    { id: "unknown", type: "tool", tool: "webfetch", state: { status: "completed", input: { url: "https://example.test/?token=top-secret" }, output: "secret body" } },
  ])])
  const result = await read({ maxBytes: 8192 })
  assertBody(result, [
    "[tool read: running]",
    "[tool read: completed]",
    "[tool read: completed]",
    "[tool read: completed]",
    "[tool read: completed]",
    "[tool read: completed]",
    '[tool grep path="src": running]',
    "[tool webfetch: completed]",
  ].join("\n"), 8192)
  for (const secret of [".env", "example.test", "top-secret", "private-key", "ghp_", "a".repeat(100), longPattern, "secret body"]) {
    assert.equal(result.tail.includes(secret), false, secret)
  }
})

test("concurrent summary readers share a stable cursor and input projection tampering yields a gap", async () => {
  const part = { id: "read", type: "tool", tool: "read", state: { status: "running", input: { filePath: "/workspace/src/first.ts" } } }
  const messages = [user("dispatch"), assistant("tools", [part])]
  const [left, right] = await Promise.all([history(messages).read(), history(messages).read()])
  assert.deepEqual(left, right)
  assert.equal(left.tail, '[tool read file="src/first.ts": running]')
  part.state.input.filePath = "/workspace/src/second.ts"
  assert.deepEqual(await history(messages).read({ cursor: left.cursor }), { gap: "source-changed" })
  assert.equal((await history(messages).read()).tail, '[tool read file="src/second.ts": running]')
})

function compacted() {
  return [
    user("dispatch"), assistant("working", "working", "dispatch", { finish: "tool-calls" }),
    user("compact", [{ type: "compaction" }]),
    assistant("summary", "summary-secret", "compact", { mode: "compaction", summary: true, finish: "stop" }),
    user("continue", [text("continue-secret", { synthetic: true, metadata: { compaction_continue: true } })]),
    assistant("answer", "answer", "continue"),
  ]
}

test("compaction continuation requires verified lineage across pages and excludes summaries", async () => {
  const { read, calls } = history(compacted(), { pageSize: 2 })
  assertBody(await read(), "workinganswer", 1024)
  assert.equal(calls.length, 3)
})

test("unverified compaction never masquerades as empty or current output", async () => {
  for (const mutate of [
    (messages) => { delete messages[3].info.finish },
    (messages) => { delete messages[4].parts[0].synthetic },
    (messages) => { messages.splice(0, 1) },
    (messages) => { messages.splice(2, 0, user("foreign")) },
    (messages) => { messages[1].info.finish = "stop" },
  ]) {
    const messages = compacted()
    mutate(messages)
    assert.deepEqual(await history(messages).read(), { gap: "lineage-unverified" })
  }
})

test("UTF-8 tail, backward and forward chunks preserve exact body bounds", async () => {
  const body = "a\u4e2d\ud83d\ude80\u00e9z".repeat(10)
  for (const maxBytes of [4, 5, 6, 7, 8, 9, 10, 13]) {
    const { read } = history([user("dispatch"), assistant("a", body)])
    let result = await read({ maxBytes })
    let assembled = result.tail
    assertBody(result, result.tail, maxBytes)
    while (result.beforeCursor) {
      const prior = await read({ cursor: result.beforeCursor, direction: "backward", maxBytes })
      if (prior.unchanged) break
      assertBody(prior, prior.tail, maxBytes)
      assembled = prior.tail + assembled
      result = prior
    }
    assert.equal(assembled, body)
    let cursor = result.cursor
    assembled = result.tail
    while (true) {
      const next = await read({ cursor, maxBytes })
      if (next.unchanged) break
      assertBody(next, next.tail, maxBytes)
      assembled += next.tail
      cursor = next.cursor
    }
    assert.equal(assembled, body)
  }
})

test("UTF-8 budgets include part separators and cross-message boundaries", async () => {
  const { read } = history([
    user("dispatch"),
    assistant("a", [text("\u4e2d"), text("\ud83d\ude80", { id: "second" })]),
    assistant("b", "\u00e9z"),
  ])
  const initial = await read({ maxBytes: 7 })
  assertBody(initial, "\ud83d\ude80\u00e9z", 7)
  const prior = await read({ cursor: initial.beforeCursor, direction: "backward", maxBytes: 4 })
  assertBody(prior, "\u4e2d\n", 4)
  const replay = await read({ cursor: prior.cursor, maxBytes: 7 })
  assertBody(replay, "\ud83d\ude80\u00e9z", 7)
  assert.deepEqual(await read({ direction: "backward", maxBytes: 7 }), initial)
})

test("backward and forward traverse long messages and recent opaque history pages", async () => {
  const messages = [user("dispatch"), ...Array.from({ length: 45 }, (_, i) => assistant(`a${i}`, `body-${i}-`.repeat(4)))]
  const { read, calls } = history(messages)
  let result = await read({ maxBytes: 40 })
  let assembled = result.tail
  for (let step = 0; result.beforeCursor && step < 100; step++) {
    const prior = await read({ cursor: result.beforeCursor, direction: "backward", maxBytes: 40 })
    assert.equal(prior.gap, undefined)
    if (prior.unchanged) break
    assembled = prior.tail + assembled
    result = prior
  }
  const expected = messages.slice(1).map((message) => message.parts[0].text).join("")
  assert.equal(assembled, expected)
  let cursor = result.cursor
  assembled = result.tail
  for (let step = 0; step < 100; step++) {
    const next = await read({ cursor, maxBytes: 40 })
    if (next.unchanged) break
    assert.equal(next.gap, undefined)
    assembled += next.tail
    cursor = next.cursor
  }
  assert.equal(assembled, expected)
  assert.ok(calls.some(({ url }) => url.searchParams.has("before")))
})

test("an exact host-page tail proves earlier public bytes across filtered messages before offering back pagination", async () => {
  const messages = [
    user("dispatch"), assistant("earlier", "old!"),
    ...Array.from({ length: 19 }, (_, i) => assistant(`reasoning${i}`, [{ type: "reasoning", text: "private" }])),
    ...Array.from({ length: 20 }, (_, i) => assistant(`a${i}`, "new!")),
  ]
  const { read, calls } = history(messages)
  const initial = await read({ maxBytes: 80 })
  assertBody(initial, "new!".repeat(20), 80)
  assert.ok(initial.beforeCursor)
  assert.equal(initial.gap, undefined)
  assert.equal(calls.length, 2)
  const resumed = history(messages)
  const prior = await resumed.read({ cursor: initial.beforeCursor, direction: "backward", maxBytes: 80 })
  assertBody(prior, "old!", 80)
  assert.equal(prior.beforeCursor, undefined)
  assert.equal(prior.gap, undefined)
  assert.equal(resumed.calls.length, 3)
  const replay = await history(messages).read({ cursor: prior.cursor, maxBytes: 80 })
  assertBody(replay, initial.tail, 80)
  assert.equal(replay.gap, undefined)
})

test("a fresh reader resumes append to text, new parts and new messages without cache", async () => {
  const messages = [assistant("a", "original")]
  let result = await history(messages).read()
  assert.deepEqual(await history(messages).read({ cursor: result.cursor }), {
    unchanged: true, cursor: result.cursor, beforeCursor: result.cursor,
  })
  messages[0].parts[0].text += "-appended"
  result = await history(messages).read({ cursor: result.cursor })
  assertBody(result, "-appended", 1024)
  messages[0].parts.push(text("new part", { id: "new" }))
  result = await history(messages).read({ cursor: result.cursor })
  assertBody(result, "\nnew part", 1024)
  messages.push(assistant("b", "next message"))
  result = await history(messages).read({ cursor: result.cursor })
  assertBody(result, "next message", 1024)
})

test("slow cursors stay at consumed bytes while the same TextPart keeps appending", { timeout: 5000 }, async () => {
  const unicode = ["\u4e2d\ud83d\ude80", "\u00e9Z\u6587", "\ud83d\ude80a\u4e2d", "b\u00e9\u6587"]
  for (const [maxBytes, additions, firstUnread] of [
    [4, ["01234567", "89abcdef", "ghijklmn", "opqrstuv"], "0123"],
    [4, unicode, "\u4e2d"],
    [7, unicode, "\u4e2d\ud83d\ude80"],
  ]) {
    const part = text("seed")
    const messages = [user("dispatch"), assistant("streaming", [part])]
    const initial = await history(messages).read({ maxBytes })
    assertBody(initial, "seed", maxBytes)
    let cursor = initial.cursor
    let assembled = initial.tail
    for (let step = 0; step < 32; step++) {
      part.text += additions[step] ?? ""
      const next = await history(messages).read({ cursor, maxBytes })
      assert.equal(next.gap, undefined)
      assert.equal(next.unavailable, undefined)
      if (next.unchanged) {
        assert.ok(step >= additions.length, "reader must remain behind the growing source")
        assert.equal(next.cursor, cursor)
        break
      }
      assertBody(next, next.tail, maxBytes)
      assert.notEqual(next.tail, "")
      assert.notEqual(next.cursor, cursor)
      assembled += next.tail
      assert.equal(assembled, part.text.slice(0, assembled.length), "no duplicated or skipped bytes")
      cursor = next.cursor
      if (step < additions.length) {
        const replay = await history(messages).read({ cursor: initial.cursor, maxBytes })
        assertBody(replay, firstUnread, maxBytes)
        assert.equal(replay.gap, undefined)
      }
    }
    assert.equal(assembled, `seed${additions.join("")}`)
    assert.deepEqual(await history(messages).read({ cursor, maxBytes }), {
      unchanged: true, cursor, beforeCursor: cursor,
    })
  }
})

test("a slow cursor drains every separator and byte across appended parts and messages", { timeout: 5000 }, async () => {
  const messages = [user("dispatch"), assistant("a", "seed")]
  let { cursor } = await history(messages).read({ maxBytes: 4 })
  let assembled = "seed"
  const append = [
    () => { messages[1].parts[0].text += "abcdEFGH" },
    () => { messages[1].parts.push(text("ijklMNOP", { id: "second" })) },
    () => { messages.push(assistant("b", "qrstUVWX")) },
    () => { messages[2].parts[0].text += "yz01" },
  ]
  const chunks = ["abcd", "EFGH", "\nijk", "lMNO", "Pqrs", "tUVW", "Xyz0", "1"]
  for (const [step, expected] of chunks.entries()) {
    append[step]?.()
    const next = await history(messages).read({ cursor, maxBytes: 4 })
    assertBody(next, expected, 4)
    assert.equal(next.gap, undefined)
    assert.notEqual(next.cursor, cursor)
    assembled += next.tail
    cursor = next.cursor
  }
  assert.equal(assembled, "seedabcdEFGH\nijklMNOPqrstUVWXyz01")
  assert.deepEqual(await history(messages).read({ cursor, maxBytes: 4 }), {
    unchanged: true, cursor, beforeCursor: cursor,
  })
})

test("slow cursors reject prefix rewrites, deletions and tool completion instead of jumping to tail", { timeout: 5000 }, async () => {
  for (const [name, prefix, mutate] of [
    ["rewrite", text("prefix", { id: "prefix" }), (message) => { message.parts[0].text = "PREFIX" }],
    ["delete text", text("prefix", { id: "prefix" }), (message) => { message.parts[0].text = "" }],
    ["delete part", text("prefix", { id: "prefix" }), (message) => { message.parts.shift() }],
    ["complete tool", { id: "tool", type: "tool", tool: "read", state: { status: "running" } },
      (message) => { message.parts[0].state.status = "completed" }],
  ]) {
    const part = text("seed")
    const message = assistant("streaming", [prefix, part])
    const messages = [user("dispatch"), message]
    const initial = await history(messages).read({ maxBytes: 4 })
    assertBody(initial, "seed", 4)
    part.text += "abcdEFGH"
    const slow = await history(messages).read({ cursor: initial.cursor, maxBytes: 4 })
    assertBody(slow, "abcd", 4)
    assert.equal(slow.gap, undefined)
    mutate(message)
    part.text += "ijkl"
    for (const cursor of [initial.cursor, slow.cursor]) {
      assert.deepEqual(await history(messages).read({ cursor, maxBytes: 4 }), { gap: "source-changed" }, name)
    }
    assert.deepEqual(await history(messages).read({ cursor: slow.beforeCursor, direction: "backward", maxBytes: 4 }),
      { gap: "source-changed" }, name)
  }
})

test("opaque before positions survive messages appended between pages and old cursors retain all unread UTF-8", { timeout: 5000 }, async () => {
  const messages = [user("dispatch"), assistant("source", "seed")]
  const { cursor } = await history(messages).read({ maxBytes: 4 })
  const suffix = "\u4e2d\ud83d\ude80\u00e9"
  messages[1].parts[0].text += suffix
  const pending = Array.from({ length: 40 }, (_, i) => assistant(`a${i}`, `${i}|`))
  messages.push(...pending)
  const late = [assistant("late1", "\u754c-late1|"), assistant("late2", "\ud83d\ude80-late2|")]
  const paged = history(messages, { onRequest: (_request, count) => {
    if (count === 2 || count === 3) messages.push(late[count - 2])
  } })
  const result = await paged.read({ cursor, maxBytes: 8192 })
  const expected = suffix + pending.map((message) => message.parts[0].text).join("")
  assertBody(result, expected, 8192)
  assert.equal(result.gap, undefined)
  assert.deepEqual(paged.calls.map(({ url }) => url.searchParams.get("before")), [null, "opaque /+?= 22", "opaque /+?= 2"])
  const appended = late.map((message) => message.parts[0].text).join("")
  const next = await history(messages).read({ cursor: result.cursor, maxBytes: 64 })
  assertBody(next, appended, 64)
  assert.equal(next.gap, undefined)
  const replay = await history(messages).read({ cursor, maxBytes: 8192 })
  assertBody(replay, expected + appended, 8192)
  assert.equal(replay.gap, undefined)
  assert.deepEqual(await history(messages).read({ cursor: next.cursor, maxBytes: 4 }), {
    unchanged: true, cursor: next.cursor, beforeCursor: next.cursor,
  })
})

test("message snapshot digest rejects edits, shrinkage, part replacement and tool changes", async () => {
  for (const mutate of [
    (message) => { message.parts[0].text = "changed!" },
    (message) => { message.parts[0].text = "short" },
    (message) => { message.parts[0].id = "replacement" },
    (message) => { message.parts.unshift(text("inserted", { id: "inserted" })) },
    (message) => { message.parts[0].text += "append before old tool" },
    (message) => { message.parts[1].state.status = "completed" },
  ]) {
    const messages = [assistant("a", [text("original"), { id: "tool", type: "tool", tool: "read", state: { status: "running" } }])]
    const initial = await history(messages).read({ maxBytes: 4 })
    mutate(messages[0])
    assert.deepEqual(await history(messages).read({ cursor: initial.cursor }), { gap: "source-changed" })
    assert.deepEqual(await history(messages).read({ cursor: initial.beforeCursor, direction: "backward" }), { gap: "source-changed" })
  }
})

test("cursor identity binds task, child, dispatch, generation and attempt", async () => {
  const { read, calls } = history([assistant("a", "hello")])
  const { cursor } = await read()
  for (const key of ["taskID", "childSessionID", "dispatchMessageID", "runGeneration", "attemptNumber"]) {
    const changed = { ...record, [key]: typeof record[key] === "number" ? record[key] + 1 : `${record[key]}-other` }
    assert.deepEqual(await read({ cursor, record: changed }), { gap: "execution-changed" })
  }
  assert.equal(calls.length, 1)
})

test("invalid or forged cursor shape and byte boundaries fail closed", async () => {
  const { read } = history([assistant("a", "\ud83d\ude80hello")])
  const { cursor } = await read()
  const binary = Buffer.from(cursor, "base64url")
  for (const invalid of ["", "x".repeat(513), "not a cursor", null, 4, Buffer.from("{}").toString("base64url")]) {
    assert.deepEqual(await read({ cursor: invalid }), { gap: "invalid-cursor" })
  }
  const jsonCursor = Buffer.from(JSON.stringify([1, "a".repeat(32), "b".repeat(32), 0, 9, "c".repeat(32)])).toString("base64url")
  assert.deepEqual(await read({ cursor: jsonCursor }), { gap: "invalid-cursor" })
  const offsetPastSnapshot = Buffer.from(binary)
  offsetPastSnapshot[49] = 10
  assert.deepEqual(await read({ cursor: offsetPastSnapshot.toString("base64url") }), { gap: "invalid-cursor" })
  const badVersion = Buffer.from(binary)
  badVersion[0] = 3
  assert.deepEqual(await read({ cursor: badVersion.toString("base64url") }), { gap: "invalid-cursor" })
  const badIdentity = Buffer.from(binary)
  badIdentity[1] ^= 1
  assert.deepEqual(await read({ cursor: badIdentity.toString("base64url") }), { gap: "execution-changed" })
  const badOffset = Buffer.from(binary)
  badOffset[49] = 1
  assert.deepEqual(await read({ cursor: badOffset.toString("base64url") }), { gap: "source-changed" })
  const noncanonicalOffset = Buffer.concat([binary.subarray(0, 49), Buffer.from([0x80, 0]), binary.subarray(50)])
  assert.deepEqual(await read({ cursor: noncanonicalOffset.toString("base64url") }), { gap: "invalid-cursor" })
  const truncated = binary.subarray(0, binary.length - 1)
  assert.deepEqual(await read({ cursor: truncated.toString("base64url") }), { gap: "invalid-cursor" })
  const badSignature = Buffer.from(binary)
  badSignature[badSignature.length - 1] ^= 1
  assert.deepEqual(await read({ cursor: badSignature.toString("base64url") }), { gap: "source-changed" })
})

test("missing cursor source, lost old history and pagination loops return gaps", async () => {
  const messages = [assistant("a", "hello")]
  const { cursor } = await history(messages).read()
  assert.deepEqual(await history([]).read({ cursor }), { gap: "source-missing" })
  messages.push(...Array.from({ length: 101 }, (_, i) => assistant(`new${i}`, "new")))
  const { read, calls } = history(messages)
  assert.deepEqual(await read({ cursor }), { gap: "source-missing" })
  assert.equal(calls.length, 5)
  let count = 0
  const store = { messagePage: async () => ({ messages: [user(`u${count++}`)], nextCursor: "loop" }) }
  assert.deepEqual(await readTaskInspection({ store, record }), { gap: "pagination-changed" })
  assert.equal(count, 2)
})

test("a cursor at the 5x20 window edge resumes but removal or one more message gives an explicit gap", { timeout: 5000 }, async () => {
  const source = assistant("source", "seed")
  const messages = [user("dispatch"), source]
  const { cursor } = await history(messages).read({ maxBytes: 4 })
  messages.push(...Array.from({ length: 99 }, (_, i) => assistant(`new${i}`, String(i).padStart(4, "0"))))
  const edge = history(messages)
  const result = await edge.read({ cursor, maxBytes: 4 })
  assertBody(result, "0000", 4)
  assert.equal(result.gap, undefined)
  assert.equal(edge.calls.length, 5)
  for (const changed of [
    [...messages, assistant("new99", "0099")],
    messages.filter((message) => message !== source),
  ]) {
    for (const direction of ["forward", "backward"]) {
      const missing = history(changed)
      assert.deepEqual(await missing.read({ cursor, direction, maxBytes: 4 }), { gap: "source-missing" })
      assert.equal(missing.calls.length, 5)
    }
  }
})

test("page cap yields explicit gap/unavailable rather than empty output", async () => {
  const messages = [user("dispatch"), ...Array.from({ length: 120 }, (_, i) => user(`u${i}`))]
  const capped = history(messages)
  assert.deepEqual(await capped.read(), { unavailable: "page-limit" })
  assert.equal(capped.calls.length, 5)
  const current = history(Array.from({ length: 120 }, (_, i) => assistant(`a${i}`, "x")))
  const initial = await current.read({ maxBytes: 20 })
  assertBody(initial, "x".repeat(20), 20)
  assert.ok(initial.beforeCursor)
  assert.equal(initial.gap, undefined)
  assert.equal(current.calls.length, 2)
  const prior = await current.read({ cursor: initial.beforeCursor, direction: "backward", maxBytes: 8192 })
  assert.equal(prior.gap, "page-limit")
  assert.equal(prior.tail, "x".repeat(80))
  assert.equal(prior.beforeCursor, undefined)
  assert.equal(current.calls.length, 7)
  const unverified = history([user("dispatch"), ...Array.from({ length: 120 }, (_, i) => assistant(`foreign${i}`, "secret", "missing-parent"))])
  assert.deepEqual(await unverified.read(), { gap: "lineage-unverified" })
  assert.equal(unverified.calls.length, 5)
})

test("prefix proof at the page cap reports a gap without speculative beforeCursor", async () => {
  for (const value of [[{ type: "reasoning", text: "private" }], "x"]) {
    const messages = [
      user("dispatch"), assistant("earlier", "outside the bounded window"),
      ...Array.from({ length: 120 }, (_, i) => assistant(`a${i}`, value)),
      assistant("current", "public"),
    ]
    const { read, calls } = history(messages)
    const result = await read()
    assertBody(result, `${typeof value === "string" ? "x".repeat(99) : ""}public`, 1024)
    assert.equal(result.beforeCursor, undefined)
    assert.equal(result.gap, "page-limit")
    assert.equal(calls.length, 5)
  }
})

test("byte budgets require integers 4..8192 and invalid options do not read", async () => {
  const { read, calls } = history([assistant("a", "x".repeat(10000))])
  assert.equal((await read({ maxBytes: 4 })).tail.length, 4)
  assert.equal((await read({ maxBytes: 8192 })).tail.length, 8192)
  assert.equal((await read()).tail.length, 1024)
  const before = calls.length
  for (const maxBytes of [0.1, 1, 3, 99999, 0, -1, NaN, Infinity, "10", null]) assert.deepEqual(await read({ maxBytes }), { unavailable: "invalid-max-bytes" })
  assert.deepEqual(await read({ direction: "sideways" }), { unavailable: "invalid-direction" })
  assert.deepEqual(await read({ record: { ...record, kind: "command" } }), { unavailable: "unsupported-kind" })
  for (const key of ["taskID", "childSessionID", "dispatchMessageID", "runGeneration", "attemptNumber"]) {
    assert.deepEqual(await read({ record: { ...record, [key]: undefined } }), { unavailable: "invalid-record" })
  }
  assert.equal(calls.length, before)
})

test("abort before, during and between pages is checked and exceptions never escape", async () => {
  const controller = new AbortController()
  const { read, calls } = history([assistant("a", "hello")])
  controller.abort(new Error("secret"))
  assert.deepEqual(await read({ signal: controller.signal }), { unavailable: "aborted" })
  assert.equal(calls.length, 0)
  const during = new AbortController()
  const inFlight = history([assistant("a", "hello")], { onRequest: () => during.abort() })
  assert.deepEqual(await inFlight.read({ signal: during.signal }), { unavailable: "aborted" })
  const between = new AbortController()
  let count = 0
  const store = { messagePage: async (_id, { signal }) => {
    assert.equal(signal, between.signal)
    count++
    if (count === 2) between.abort()
    return { messages: [user(`u${count}`)], nextCursor: `page${count}` }
  } }
  assert.deepEqual(await readTaskInspection({ store, record, signal: between.signal }), { unavailable: "aborted" })
  assert.equal(count, 2)
  const failed = { messagePage: async () => { throw new Error("secret token in raw exception") } }
  assert.deepEqual(await readTaskInspection({ store: failed, record }), { unavailable: "page-unavailable" })
})

test("empty is only reported for a verifiable dispatch; malformed pages fail closed", async () => {
  assert.deepEqual(await history([user("dispatch")]).read(), { unchanged: true })
  assert.deepEqual(await history([]).read(), { unavailable: "lineage-unverified" })
  for (const page of [
    { messages: [null] }, { messages: [{ info: { id: "x" }, parts: {} }] },
    { messages: [user("u"), user("u")] },
    { messages: [{ info: { id: "x", sessionID: "other" }, parts: [] }] },
  ]) {
    const result = await readTaskInspection({ store: { messagePage: async () => page }, record })
    assert.ok(result.gap || result.unavailable)
    assert.equal(result.tail, undefined)
    assert.equal(result.unchanged, undefined)
  }
})
