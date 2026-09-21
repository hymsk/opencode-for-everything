import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import test from "node:test"
import { Effect } from "effect"
import { createCommandCard } from "../src/adapters/opencode/command-card.mjs"

async function until(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("card observation timed out")
    await sleep(2)
  }
}

function fixture(options = {}) {
  let part = {
    id: "part", type: "tool", tool: "bash", sessionID: "owner", messageID: "message", callID: "call",
    state: { status: "completed", input: { command: "example" }, output: "[O4E taskID=command; status=running]",
      title: "example", time: { start: 1, end: 2 }, metadata: { taskID: "command", output: "",
        o4eResult: { taskID: "command", status: "running", output: "" } } },
  }
  const updates = []
  const attached = []
  const client = {
    session: { message: async () => ({ data: { parts: [structuredClone(part)] } }) },
    _client: { request: async (request) => {
      updates.push(request)
      part = structuredClone(request.body)
      return { data: part }
    } },
  }
  const card = createCommandCard({ client, directory: "/workspace", taskID: "command", title: "example",
    context: { sessionID: "owner", messageID: "message", callID: "call",
      metadata: (value) => Effect.sync(() => attached.push(value)) },
    intervalMs: 1, requestTimeoutMs: 30, settleTimeoutMs: 250, ...options })
  let settled
  card.done.then((result) => { settled = result })
  return { card, client, updates, attached, get part() { return part }, set part(value) { part = value },
    settled: async () => { await until(() => settled); return settled } }
}

test("Command card retains full capture beyond 64 KiB and updates completed metadata without changing model text", async () => {
  const f = fixture()
  const modelPart = structuredClone(f.part)
  const first = `  开头✓\n${"正文\n".repeat(20000)}`
  f.card.append(first)
  await until(() => f.attached.length > 0)
  assert.equal(f.attached.at(-1).metadata.output, first)
  f.part.state.status = "running"
  f.card.detach()
  f.card.append("  后台增长\n\n")
  await sleep(8)
  assert.equal(f.updates.length, 0)
  assert.equal(f.card.metadata().output, first + "  后台增长\n\n")
  f.part.state.status = "completed"
  f.card.finish()
  assert.equal((await f.settled()).reason, "published")
  assert.equal(f.part.state.metadata.output, first + "  后台增长\n\n")
  const updated = structuredClone(f.part)
  updated.state.metadata.output = modelPart.state.metadata.output
  assert.deepEqual(updated, modelPart)
  assert.equal(f.updates.at(-1).url, "/session/owner/message/message/part/part?directory=%2Fworkspace")
  assert.equal(f.updates.at(-1).method, "PATCH")
  assert.equal(f.card.output(), "")
})

test("Command card retries failed transport and coalesces capture arriving during a slow publication", async () => {
  const f = fixture()
  let release
  let attempts = 0
  const write = f.client._client.request
  f.client._client.request = async (request) => {
    attempts++
    if (attempts === 1) return { error: "unavailable", response: { status: 503 } }
    if (attempts === 2) await new Promise((resolve) => { release = resolve })
    return write(request)
  }
  f.card.append("first\n")
  f.card.detach()
  await until(() => release)
  f.card.append("second\n")
  f.card.append("third\n")
  f.card.finish()
  release()
  assert.equal((await f.settled()).reason, "published")
  assert.equal(f.part.state.metadata.output, "first\nsecond\nthird\n")
  assert.equal(f.part.state.output, "[O4E taskID=command; status=running]")
})

test("Command card never overwrites another Task or revives a compacted result", async () => {
  for (const reason of ["source-mismatch", "compacted"]) {
    const f = fixture()
    if (reason === "source-mismatch") f.part.state.metadata.taskID = "another-command"
    else f.part.state.time.compacted = 3
    f.card.append("private capture")
    f.card.finish()
    f.card.detach()
    assert.equal((await f.settled()).reason, reason)
    assert.deepEqual(f.updates, [])
  }
})

test("Command card enforces its full-prefix capacity with explicit incompleteness and intact UTF-8", async () => {
  const f = fixture({ maxOutputBytes: 5 })
  f.card.append("a中")
  f.card.append("文tail")
  assert.equal(f.card.output(), "a中\n[O4E UI output incomplete: 5 byte limit reached; use the command log.]")
  f.card.finish()
  f.card.detach()
  await f.settled()
  assert.match(f.part.state.metadata.output, /^a中\n\[O4E UI output incomplete:/)
  assert.doesNotMatch(f.part.state.metadata.output, /�|tail/)
})

test("Command card disposal fences pending reads and transport failures do not block settlement", async () => {
  const f = fixture()
  let release
  f.client.session.message = () => new Promise((resolve) => { release = resolve })
  f.card.append("unfinished")
  f.card.detach()
  await until(() => release)
  f.card.dispose()
  release({ data: { parts: [f.part] } })
  assert.equal((await f.settled()).reason, "disposed")
  await sleep(2)
  assert.deepEqual(f.updates, [])
  assert.equal(f.card.output(), "")

  const failed = fixture({ settleTimeoutMs: 15 })
  failed.client.session.message = async () => { throw new Error("offline") }
  failed.card.finish()
  failed.card.detach()
  assert.equal((await failed.settled()).reason, "unpublished")
})

test("Command card keeps terminal capture until the original Bash reader returns", async () => {
  const f = fixture({ settleTimeoutMs: 15 })
  f.card.append("final capture\n")
  f.card.finish()
  await sleep(25)
  assert.equal(f.card.output(), "final capture\n")
  assert.deepEqual(f.updates, [])
  f.card.detach()
  assert.equal((await f.settled()).reason, "published")
  assert.equal(f.part.state.metadata.output, "final capture\n")
})
