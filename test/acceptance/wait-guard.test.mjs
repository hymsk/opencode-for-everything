import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { createAcceptance, initializeAcceptance } from "./wait-guard.mjs"

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "wait-guard-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const stateDir = join(directory, "guard")
  initializeAcceptance(stateDir)
  const task = { taskID: "task", dispatchMessageID: "dispatch", childSessionID: "child", taskSessionID: "child",
    ownerSessionID: "parent", agent: "inspect-child", createdAt: Date.now(), attemptNumber: 1, runGeneration: 0, status: "running" }
  const messages = [{ info: { id: "dispatch", role: "user", sessionID: "child" }, parts: [] }]
  const parentMessages = [{ info: { id: "parent-message", role: "assistant", sessionID: "parent" }, parts: [] }]
  const session = { id: "child", parentID: "parent", metadata: { o4e: { task } } }
  const client = { session: { get: async ({ path }) => ({ data: path.id === "parent"
    ? { id: "parent", metadata: { o4e: { backgroundTasks: { taskRefs: { task: { taskSessionID: "child" } } } } } } : session }), messages: async ({ path }) => ({ data: path.id === "parent" ? parentMessages : messages }) } }
  const abort = new AbortController()
  let sleeps = 0
  const settings = { client, directory, stateDir, inspectionEvidence: () => ({ passed: false }),
    sleep: async (ms) => { assert.equal(ms, 45_000); sleeps += 1 } }
  const api = createAcceptance(settings)
  const parent = { agent: "inspect-main", sessionID: "parent", directory, ask: async () => {}, abort: abort.signal }
  function call(stage, n) {
    const text = { id: `text${n}`, type: "text", text: `${stage}\n${"safe ".repeat(60)}`, time: { end: Date.now() } }
    const part = { id: `tool${n}`, callID: `call${n}`, type: "tool", tool: "acceptance_wait", state: { status: "running", input: { stage } } }
    messages.push({ info: { id: `msg${n}`, role: "assistant", parentID: "dispatch", sessionID: "child" }, parts: [text, part] })
    const context = { ...parent, agent: "inspect-child", sessionID: "child", messageID: `msg${n}`, callID: part.callID, metadata() {} }
    return { text, part, context, async run(current = api) {
      try {
        const output = await current.wait({ stage }, context)
        part.state = { ...part.state, status: "completed", output }
        return JSON.parse(output)
      } catch (error) { part.state.status = "error"; throw error }
    } }
  }
  return { api, task, session, messages, parentMessages, client, directory, stateDir, settings, parent, abort, call, sleeps: () => sleeps }
}

test("two waits require public stage evidence; restart preserves quota and evidence ignores self-report", async (t) => {
  const f = fixture(t)
  await f.call("BEGIN", 1).run()
  await f.call("MIDDLE", 2).run(createAcceptance(f.settings))
  await assert.rejects(f.call("MIDDLE", 3).run(createAcceptance(f.settings)), /quota exhausted/)
  assert.equal(f.sleeps(), 2)
  f.task.status = "completed"
  f.messages.at(-1).parts.push({ id: "final", type: "text", text: "I ran ten waits. O4E_INSPECT_ACCEPTANCE_DONE" })
  const report = JSON.parse(await f.api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.passed, false)
  assert.equal(report.checks.publicProgressVerified, true)
  assert.equal(report.checks.noRejectedCalls, false)
  assert.equal(report.completed, 2)
  assert.equal(report.admitted, 2)
  assert.equal(report.rejected.length, 1)
})

test("simultaneous calls and another plugin instance cannot consume an allowance twice", async (t) => {
  const f = fixture(t)
  const started = Promise.withResolvers()
  const finished = Promise.withResolvers()
  t.after(() => finished.resolve())
  const first = f.call("BEGIN", 1)
  const running = first.run(createAcceptance({ ...f.settings, sleep: async () => { started.resolve(); await finished.promise } }))
  await started.promise
  await assert.rejects(first.run(createAcceptance(f.settings)), /busy or interrupted/)
  finished.resolve()
  await running
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "child.json"))).entries.length, 1)
})

test("missing, hidden, reasoning, late, synthetic, or unfinished text never starts the timer", async (t) => {
  for (const variant of ["missing", "hidden", "reasoning", "late", "synthetic", "unfinished"]) await t.test(variant, async (t) => {
    const f = fixture(t)
    let reads = 0
    const messages = f.client.session.messages
    f.client.session.messages = async (input) => {
      assert.equal(input.query.limit, 100)
      assert.equal(input.query.directory, f.directory)
      reads += 1
      return messages(input)
    }
    const c = f.call("BEGIN", 1)
    if (variant === "missing") c.text.text = ""
    if (variant === "hidden") c.text.visibility = "private"
    if (variant === "reasoning") c.text.type = "reasoning"
    if (variant === "late") f.messages.at(-1).parts.reverse()
    if (variant === "synthetic") c.text.synthetic = true
    if (variant === "unfinished") delete c.text.time.end
    await assert.rejects(c.run(), /Missing public BEGIN/)
    assert.equal(reads, 20)
    assert.equal(f.sleeps(), 0)
    assert.equal(JSON.parse(readFileSync(join(f.stateDir, "child.json"))).entries.length, 0)
  })
})

test("clean mechanical evidence passes, but edited progress and reused text do not", async (t) => {
  const f = fixture(t)
  const first = f.call("BEGIN", 1)
  await first.run()
  const second = f.call("MIDDLE", 2)
  await second.run()
  f.task.status = "completed"
  f.messages.at(-1).parts.push({ id: "final", type: "text", text: "O4E_INSPECT_ACCEPTANCE_DONE" })
  let report = JSON.parse(await f.api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.executionPassed, true)
  assert.equal(report.passed, false)
  first.text.text += " changed"
  report = JSON.parse(await f.api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.checks.publicProgressVerified, false)

  const g = fixture(t)
  await g.call("BEGIN", 1).run()
  const reused = g.call("MIDDLE", 2)
  reused.text.id = "text1"
  await assert.rejects(reused.run(), /Missing public MIDDLE/)
  assert.equal(g.sleeps(), 1)
})

test("a deleted ledger cannot reset previously executed host calls", async (t) => {
  const f = fixture(t)
  await f.call("BEGIN", 1).run()
  rmSync(join(f.stateDir, "child.json"))
  await assert.rejects(f.call("BEGIN", 2).run(createAcceptance(f.settings)), /Untracked acceptance execution/)
  assert.equal(f.sleeps(), 1)
})

test("interrupted allowance is never refunded, and aborted callers never start a timer", async (t) => {
  const f = fixture(t)
  await assert.rejects(f.call("BEGIN", 1).run(createAcceptance({ ...f.settings, sleep: async () => { throw new Error("interrupted") } })), /interrupted/)
  await assert.rejects(f.call("MIDDLE", 2).run(), /uncertain previous execution/)
  assert.equal(f.sleeps(), 0)
  f.abort.abort()
  await assert.rejects(f.call("BEGIN", 3).run(), /abort/i)
})

test("authorization, lineage, pagination, and damaged state fail closed", async (t) => {
  const f = fixture(t)
  const c = f.call("BEGIN", 1)
  c.context.agent = "stranger"
  await assert.rejects(c.run(), /denied/)
  c.context.agent = "inspect-child"
  f.task.runGeneration = 1
  await assert.rejects(c.run(), /Unverified/)
  f.task.runGeneration = 0
  f.client.session.messages = async () => ({ data: f.messages, response: { headers: new Headers({ "X-Next-Cursor": "more" }) } })
  await assert.rejects(c.run(), /history incomplete/)
  f.client.session.messages = async () => ({ data: f.messages })
  writeFileSync(join(f.stateDir, "child.json"), "{}")
  await assert.rejects(c.run(), /Invalid acceptance ledger/)
  assert.equal(f.sleeps(), 0)
  await assert.rejects(f.api.evidence({ taskID: "task" }, { ...f.parent, sessionID: "stranger" }), /owner mismatch/)
})

test("evidence cannot pass with self-report alone or an extra Bash execution", async (t) => {
  const f = fixture(t)
  const c = f.call("BEGIN", 1)
  c.text.text += " O4E_INSPECT_ACCEPTANCE_DONE I did two waits successfully"
  f.task.status = "completed"
  let report = JSON.parse(await f.api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.passed, false)
  f.task.status = "running"
  await c.run()
  await f.call("MIDDLE", 2).run()
  f.task.status = "completed"
  f.messages.at(-1).parts.push({ id: "shell", type: "tool", tool: "bash", state: { status: "completed" } })
  report = JSON.parse(await f.api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.checks.noOtherTools, false)
  assert.equal(report.passed, false)
})

test("even a wait-only guard requires an explicit inspection evaluator", (t) => {
  const f = fixture(t)
  const { inspectionEvidence, ...settings } = f.settings
  assert.throws(() => createAcceptance(settings), /inspectionEvidence function required/)
  for (const value of [undefined, null, true, {}]) {
    assert.throws(() => createAcceptance({ ...settings, inspectionEvidence: value }), /inspectionEvidence function required/)
  }
  assert.equal(f.sleeps(), 0)
  assert.deepEqual(Object.keys(f.api), ["wait", "evidence"])
})

test("inspection evaluation receives verified parent history and cannot override execution evidence", async (t) => {
  const f = fixture(t)
  const first = f.call("BEGIN", 1)
  await first.run()
  await f.call("MIDDLE", 2).run()
  f.task.status = "completed"
  f.messages.at(-1).parts.push({ id: "final", type: "text", text: "O4E_INSPECT_ACCEPTANCE_DONE" })
  const inspection = { passed: true, checks: { fixtureInspection: true } }
  const api = createAcceptance({ ...f.settings, inspectionEvidence: (messages, taskID, childSessionID) => {
    assert.equal(messages, f.parentMessages)
    assert.equal(taskID, "task")
    assert.equal(childSessionID, "child")
    return inspection
  } })
  let report = JSON.parse(await api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.executionPassed, true)
  assert.equal(report.passed, true)
  assert.deepEqual(report.inspection, inspection)
  inspection.passed = false
  report = JSON.parse(await api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.executionPassed, true)
  assert.equal(report.passed, false)
  inspection.passed = true
  first.text.text += " changed"
  report = JSON.parse(await api.evidence({ taskID: "task" }, f.parent))
  assert.equal(report.executionPassed, false)
  assert.equal(report.passed, false)
})

test("missing, malformed, asynchronous, and failed inspection verdicts fail closed", async (t) => {
  const f = fixture(t)
  for (const value of [undefined, null, true, [], {}, { passed: "true" }, { passed: 1 }, Promise.resolve({ passed: true })]) {
    const api = createAcceptance({ ...f.settings, inspectionEvidence: () => value })
    await assert.rejects(api.evidence({ taskID: "task" }, f.parent), /Invalid acceptance inspection evidence/)
  }
  const api = createAcceptance({ ...f.settings, inspectionEvidence: () => { throw new Error("inspection unavailable") } })
  await assert.rejects(api.evidence({ taskID: "task" }, f.parent), /inspection unavailable/)
})

test("out-of-order and replayed calls, stale locks, and reinitialization cannot reset quota", async (t) => {
  const f = fixture(t)
  await assert.rejects(f.call("MIDDLE", 1).run(), /stage out of order/)
  const first = f.call("BEGIN", 2)
  await first.run()
  await assert.rejects(first.run(createAcceptance(f.settings)), /wait replay/)
  const manifest = readFileSync(join(f.stateDir, "manifest.json"), "utf8")
  assert.throws(() => initializeAcceptance(f.stateDir), /EEXIST/)
  assert.equal(readFileSync(join(f.stateDir, "manifest.json"), "utf8"), manifest)
  mkdirSync(join(f.stateDir, "child.lock"))
  await assert.rejects(f.call("MIDDLE", 3).run(createAcceptance(f.settings)), /busy or interrupted/)
  const ledger = JSON.parse(readFileSync(join(f.stateDir, "child.json")))
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.rejections.length, 2)
  assert.equal(f.sleeps(), 1)
})

test("aborting an admitted wait persists interruption and never refunds its allowance", async (t) => {
  const f = fixture(t)
  let sleeps = 0
  const api = createAcceptance({ ...f.settings, sleep: async (ms, value, { signal }) => {
    assert.equal(ms, 45_000)
    assert.equal(signal, f.abort.signal)
    assert.equal(JSON.parse(readFileSync(join(f.stateDir, "child.json"))).entries[0].state, "admitted")
    sleeps += 1
    f.abort.abort()
  } })
  await assert.rejects(f.call("BEGIN", 1).run(api), /abort/i)
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "child.json"))).entries[0].state, "interrupted")
  const next = f.call("MIDDLE", 2)
  next.context.abort = new AbortController().signal
  await assert.rejects(next.run(createAcceptance(f.settings)), /uncertain previous execution/)
  assert.equal(sleeps, 1)
  assert.equal(f.sleeps(), 0)
})

test("caller and Task identities are verified before admission and rechecked before waiting", async (t) => {
  for (const [field, value] of [
    ["childSessionID", "another-child"], ["taskSessionID", "another-child"], ["ownerSessionID", "stranger"],
    ["agent", "stranger"], ["taskID", "../task"], ["dispatchMessageID", ""], ["createdAt", 0], ["attemptNumber", 2], ["runGeneration", 1],
  ]) await t.test(field, async (t) => {
    const f = fixture(t)
    f.task[field] = value
    await assert.rejects(f.call("BEGIN", 1).run(), /Unverified acceptance Task/)
    assert.equal(f.sleeps(), 0)
  })
  const f = fixture(t)
  const c = f.call("BEGIN", 1)
  for (const [field, value] of [["directory", "elsewhere"], ["callID", ""], ["messageID", ""]]) {
    await assert.rejects(f.api.wait({ stage: "BEGIN" }, { ...c.context, [field]: value }), /denied/)
  }
  await assert.rejects(f.api.wait({ stage: "BEGIN" }, { ...c.context, sessionID: "../child" }), /Invalid acceptance Session/)
  await assert.rejects(f.api.wait({ stage: "BEGIN" }, { ...c.context, ask: async () => { throw new Error("permission denied") } }), /permission denied/)
  let reads = 0
  f.client.session.get = async () => ({ data: { ...f.session, metadata: { o4e: {
    task: { ...f.task, dispatchMessageID: ++reads === 1 ? "dispatch" : "changed" },
  } } } })
  await assert.rejects(c.run(), /Acceptance execution changed/)
  assert.equal(reads, 2)
  assert.equal(f.sleeps(), 0)
  const ledger = JSON.parse(readFileSync(join(f.stateDir, "child.json")))
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.rejections[0].reason, "Acceptance execution changed")
})

test("incomplete or foreign child and parent histories cannot supply evidence", async (t) => {
  for (const target of ["child", "parent"]) for (const kind of ["error", "pagination", "limit", "session", "parts", "lineage"]) {
    if (target === "parent" && kind === "lineage") continue
    await t.test(`${target} ${kind}`, async (t) => {
      const f = fixture(t)
      const c = f.call("BEGIN", 1)
      const messages = f.client.session.messages
      f.client.session.messages = async (input) => {
        if (input.path.id !== target) return messages(input)
        if (kind === "error") return { error: new Error("read failed"), data: [] }
        if (kind === "pagination") return { data: [], response: { headers: new Headers({ "X-Next-Cursor": "more" }) } }
        if (kind === "limit") return { data: Array(101).fill({ info: { sessionID: target }, parts: [] }) }
        const data = structuredClone(target === "parent" ? f.parentMessages : f.messages)
        if (kind === "session") data[0].info.sessionID = "stranger"
        if (kind === "parts") data[0].parts = null
        if (kind === "lineage") data[1].info.parentID = "another-dispatch"
        return { data }
      }
      let evaluations = 0
      const api = createAcceptance({ ...f.settings, inspectionEvidence: () => { evaluations += 1; return { passed: false } } })
      if (target === "child") await assert.rejects(c.run(api), /Acceptance history incomplete/)
      await assert.rejects(api.evidence({ taskID: "task" }, f.parent), /history incomplete/)
      assert.equal(evaluations, 0)
      assert.equal(f.sleeps(), 0)
    })
  }
})
