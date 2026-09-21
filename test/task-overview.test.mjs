import assert from "node:assert/strict"
import test from "node:test"
import { createTaskReceiptID } from "../src/core/background-task-domain.mjs"
import { adjacentCommand, outputScreenMove, commandOutput, commandSource, commandPreview, commandListItem, outputPage, navigateTask, projectTaskOverview, registerOverviewCommands, registerTaskOverview, registerTaskListPaging, taskNavigationTarget } from "../src/tui/task-overview.mjs"
import { createHash } from "node:crypto"

const id = (kind, n) => `o4e_${kind === "agent" ? "task" : kind}_${String(n).padStart(32, "0")}`
test("list previews bind synchronized input without reading output or changing task state", () => {
  const f = fixture()
  const command = "npm test -- --runInBand\nprintf second"
  const record = f.add("command", "running", 1, { commandHash: createHash("sha256").update(command).digest("hex") })
  const options = { sessionID: "owner", taskID: record.taskID, getSession: (key) => f.sessions.get(key) }
  const source = commandSource(options)
  const state = { status: "completed", input: { command }, metadata: { taskID: record.taskID } }
  for (const obj of [state, state.metadata]) Object.defineProperty(obj, "output", { get() { throw Error("output read") } })
  Object.defineProperty(state.input, "description", { get() { throw Error("description read") } })
  const part = { type: "tool", tool: "bash", ...record.source, state }
  const message = { info: { id: source.messageID, sessionID: "owner", role: "assistant" }, parts: [part] }
  const args = { source, taskID: record.taskID, message }
  const before = structuredClone(f.owner)
  assert.equal(commandPreview(args), "npm test -- --runInBand")
  assert.equal(f.project().groups[0].rows[0].status, "running")
  assert.deepEqual(f.owner, before)
  assert.equal(commandPreview({ ...args, source: commandSource({ ...options, sessionID: "other" }) }), undefined)
  for (const mutate of [
    (m) => { m.info.sessionID = "other" }, (m) => { m.info.hidden = true },
    (m) => { m.parts.push(m.parts[0]) }, (m) => { m.parts[0].callID = "other" },
    (m) => { m.parts[0].state.input.command = "npm publish" },
    (m) => { m.parts[0].state.metadata.taskID = id("command", 2) },
    (m) => { m.parts[0].state.time = { compacted: 1 } },
    (m) => { m.parts[0].state.status = "pending" }, (m) => { m.parts[0].private = true },
  ]) {
    const m = JSON.parse(JSON.stringify(message))
    mutate(m)
    assert.equal(commandPreview({ ...args, message: m }), undefined)
  }
})

test("list preview rejects controls and obvious sensitive forms before truncation", () => {
  const preview = (command) => commandPreview({ source: { sessionID: "owner", messageID: "m", callID: "c", commandHash: createHash("sha256").update(command).digest("hex") },
    taskID: id("command", 1), message: { info: { id: "m", sessionID: "owner", role: "assistant" }, parts: [{ type: "tool", tool: "bash", sessionID: "owner", messageID: "m", callID: "c",
      state: { status: "running", input: { command }, metadata: { taskID: id("command", 1) } } }] } })
  for (const command of ["X=fixture npm test", "curl --token fixture", "curl https://example.invalid/demo", "cat /private/demo", "cat C:\\private\\demo", "echo \u001b[31mtest", "echo \u202etest", "echo \tword", "x".repeat(65537), "x".repeat(4097), "\nnpm test", "echo \ud800"]) assert.equal(preview(command), undefined, command.slice(0, 30))
  assert.equal(preview("npm test\r\necho second"), "npm test")
  assert.equal(preview("printf 中文👩‍💻é"), "printf 中文👩‍💻é")
  assert.equal(preview("node scripts/check.mjs"), "node scripts/check.mjs")
  assert.equal(preview("npm test " + "x".repeat(90) + " --password fixture"), undefined)
})

test("list options reserve an independent right footer and fit host title and terminal budgets", () => {
  const row = { sequence: 42, status: "completed", phase: "stopped", exitCode: 0 }
  // Injectable terminal measure lets the pure formatter run under Node as well as Bun.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  const measure = (text) => [...segmenter.segment(text)].reduce((sum, { segment }) => sum + (/[^\x00-\xff…]/u.test(segment) ? 2 : 1), 0)
  const base = commandListItem({ row, columns: 0, measure })
  assert.deepEqual(base, { title: "#42", footer: "completed · stopped · 0" })
  const render = (columns, preview = "npm test -- --runInBand") => commandListItem({ row, preview, columns, measure })
  assert.deepEqual(render(measure(base.title) + measure(base.footer) + 12), base)
  assert.deepEqual(render(90), { title: "#42 npm test -- --runInBand", footer: base.footer })
  const value = render(44)
  assert.ok(value.title.endsWith("…"))
  assert.equal(value.footer, base.footer)
  assert.ok(measure(value.title) + measure(value.footer) <= 44)
  const unicode = "printf 中文👩‍💻é🇨🇳".repeat(3)
  for (let columns = 48; columns < 85; columns++) {
    const { title, footer } = render(columns, unicode)
    assert.ok(measure(title) + measure(footer) <= columns)
    assert.ok(measure(title) <= 61)
    assert.equal(footer, base.footer)
    const prefix = title.slice("#42 ".length).replace(/…$/, "")
    assert.ok([...segmenter.segment(unicode)].some(({ index, segment }) => unicode.slice(0, index + segment.length) === prefix))
  }
  assert.deepEqual(commandListItem({ row, columns: 100, measure }), base)
  assert.equal(measure(render(200, "x".repeat(300)).title), 61)
  assert.deepEqual(commandListItem({ row: { sequence: 2, status: "failed", phase: "stopped", exitCode: 7 }, preview: "npm test", columns: 90, measure }), { title: "#2 npm test", footer: "failed · stopped · 7" })
  assert.deepEqual(commandListItem({ row: { sequence: 3, status: "running", phase: "running" }, preview: "npm test", columns: 90, measure }), { title: "#3 npm test", footer: "running" })
  const rows = [row, { sequence: 19, status: "failed", phase: "stopped", exitCode: 127 }, { sequence: 18, status: "running", phase: "running" }]
  const items = rows.map(row => commandListItem({ row, rows, preview: "npm test", columns: 60, measure }))
  assert.equal(new Set(items.map(item => measure(item.footer))).size, 1)
  assert.deepEqual(items.map(item => item.footer), ["completed · stopped ·   0", "failed    · stopped · 127", "running" + " ".repeat(18)])
})
test("output navigation moves by viewport, crosses chunks both ways and clamps at ends", () => {
  const base = { page: 0, count: 3, top: 0, height: 182, viewport: 16, direction: 1 }
  assert.deepEqual(outputScreenMove(base), { page: 0, top: 15 })
  assert.deepEqual(outputScreenMove({ ...base, top: 166 }), { page: 1, top: 0 })
  assert.deepEqual(outputScreenMove({ ...base, page: 1, direction: -1 }), { page: 0, top: "end" })
  assert.deepEqual(outputScreenMove({ ...base, direction: -1 }), { page: 0, top: 0 })
  assert.deepEqual(outputScreenMove({ ...base, page: 2, top: 166 }), { page: 2, top: 166 })
  assert.deepEqual(outputScreenMove({ ...base, height: 1, count: 1 }), { page: 0, top: 0 })
})

test("Bash adjacency follows list order across pages without crossing owners or wrapping", () => {
  const f = fixture()
  for (let n = 1; n <= 55; n++) f.add("command", ["completed", "running", "failed", "unknown"][n % 4], n)
  f.add("agent", "completed", 100)
  const args = { sessionID: "owner", getSession: (key) => f.sessions.get(key), taskID: id("command", 6) }
  assert.deepEqual(adjacentCommand({ ...args, direction: 1 }), { taskID: id("command", 5), page: 2 })
  assert.deepEqual(adjacentCommand({ ...args, direction: -1 }), { taskID: id("command", 7), page: 2 })
  assert.deepEqual(adjacentCommand({ ...args, taskID: id("command", 36), direction: 1 }), { taskID: id("command", 35), page: 1 })
  assert.equal(adjacentCommand({ ...args, taskID: id("command", 55), direction: -1 }), undefined)
  assert.equal(adjacentCommand({ ...args, taskID: id("command", 1), direction: 1 }), undefined)
  assert.equal(adjacentCommand({ ...args, sessionID: "other", direction: 1 }), undefined)
  assert.equal(adjacentCommand({ ...args, taskID: id("command", 99), direction: 1 }), undefined)
})

test("task list arrow keys page within the focused panel and clamp against current totals", () => {
  let layer
  let disposed = false
  let page = 0
  let total = 45
  const panel = {}
  const api = { keymap: { registerLayer(value) { layer = value; return () => { disposed = true } } } }
  const dispose = registerTaskListPaging(api, panel, { page: () => page, total: () => total, setPage: (value) => { page = value } })
  assert.equal(layer.target, panel)
  assert.equal(layer.targetMode, "focus-within")
  const key = (name) => layer.bindings.find((binding) => binding.key === name).cmd()
  key("left"); assert.equal(page, 0)
  key("right"); assert.equal(page, 1)
  key("right"); assert.equal(page, 2)
  key("right"); assert.equal(page, 2)
  key("left"); assert.equal(page, 1)
  total = 20
  key("right"); assert.equal(page, 0)
  total = 0
  key("left"); assert.equal(page, 0)
  dispose(); assert.equal(disposed, true)
})
function fixture() {
  const owner = { id: "owner", metadata: { o4e: { backgroundTasks: { version: 1, taskRefs: {} }, commandTasks: { version: 1, refs: {} } } } }
  const sessions = new Map([[owner.id, owner]])
  const reads = []
  function add(kind, status, n, extra = {}) {
    const taskID = id(kind, n)
    const taskSessionID = kind === "command" ? owner.id : `session-${kind}-${n}`
    const record = { version: 1, revision: 1, sequence: n, kind, taskID, ownerSessionID: owner.id, taskSessionID, status, runGeneration: 0, attemptSessionIDs: [], agent: "reviewer (plan)", ...extra }
    if (["completed", "failed", "cancelled"].includes(status)) {
      record.phase = "settled"
      record.receipt = { version: 1, receiptID: createTaskReceiptID(taskID, status, 0), taskID, status, generation: 0, phase: "settled", createdAt: 1 }
      record.stopped = true
      record.result = { status, stopped: true, exitCode: status === "completed" ? 0 : 1 }
    }
    if (kind === "agent") owner.metadata.o4e.backgroundTasks.taskRefs[taskID] = { kind, sequence: n, taskSessionID, recoveryEnvelope: { version: 1, task: record } }
    else {
      record.source ??= { sessionID: owner.id, messageID: `message-${n}`, callID: `call-${n}` }
      record.claim = "claim"
      owner.metadata.o4e.commandTasks.refs[taskID] = { taskSessionID, claim: record.claim,
        callKey: createHash("sha256").update(JSON.stringify([record.source.sessionID, record.source.messageID, record.source.callID])).digest("hex"), recovery: record }
    }
    return record
  }
  const project = () => projectTaskOverview({ sessionID: owner.id, getSession: (key) => { reads.push(key); return sessions.get(key) } })
  return { owner, sessions, reads, add, project }
}

test("overview groups owner snapshots, preserves waiting/failure, bounds rows and does not read payloads", () => {
  const f = fixture()
  f.add("agent", "waiting_permission", 1)
  f.add("agent", "waiting_retry_decision", 2)
  f.add("agent", "failed", 3)
  for (let n = 1; n <= 8; n++) f.add("command", n === 8 ? "running" : "completed", n)
  const record = f.add("command", "unknown", 9)
  for (const field of ["cwd", "result", "command", "description"]) Object.defineProperty(record, field, { get() { throw new Error("sensitive payload accessed") } })
  const view = f.project()
  assert.equal(view.groups[0].rows.length, 6)
  assert.equal(view.groups[0].hidden, 3)
  assert.equal(view.groups[0].rows[0].status, "unknown")
  assert.deepEqual(view.groups[1].rows.map((row) => row.status), ["failed", "waiting_retry_decision", "waiting_permission"])
  assert.ok(view.groups.every((g) => g.rows.every((r) => r.source === "snapshot")))
  assert.ok(f.reads.every((key) => key === "owner" || key.startsWith("session-")))
})

test("overview follows reactive host records without mistaking history or unknown ownership for current success", () => {
  const f = fixture()
  const saved = f.add("agent", "completed", 1)
  const session = { id: saved.taskSessionID, metadata: { o4e: { task: { ...saved, revision: 2, status: "running" } } } }
  f.sessions.set(session.id, session)
  assert.equal(f.project().groups[1].rows[0].status, "running")
  session.metadata.o4e.task.status = "waiting_question"
  assert.equal(f.project().groups[1].rows[0].status, "waiting_question")
  session.metadata.o4e.task.ownerSessionID = "other-owner"
  assert.equal(f.project().groups[1].rows[0].source, "unavailable")
  f.sessions.delete(session.id)
  assert.equal(f.project().groups[1].rows[0].source, "snapshot")
  assert.equal(f.project().groups[1].rows[0].status, "completed") // explicitly recorded, never live
  f.owner.metadata.o4e.backgroundTasks.version = 999
  assert.equal(f.project().groups[1].invalid, 1)
})

test("overview omits untrusted names, unsupported records and unavailable session state", () => {
  const f = fixture()
  f.add("agent", "running", 1, { agent: "/private/token=secret" })
  f.add("command", "made-up-success", 1)
  assert.equal(f.project().groups[1].rows[0].label, "Agent")
  assert.equal(f.project().groups[0].rows[0].status, "unknown")
  assert.doesNotMatch(JSON.stringify(f.project()), /private|secret|token/)
  assert.deepEqual(projectTaskOverview({ sessionID: "missing", getSession: () => undefined }), { available: false, groups: [] })
})

test("owner-only synchronized Agent recovery snapshots update queued/running/terminal views without receipt consumption", () => {
  const f = fixture()
  const task = f.add("agent", "queued", 1)
  const options = { sessionID: "owner", getSession: (key) => key === "owner" ? f.owner : undefined }
  const group = (extra = {}) => projectTaskOverview({ ...options, ...extra }).groups[1]
  assert.equal(group().rows[0].status, "queued")
  const ref = f.owner.metadata.o4e.backgroundTasks.taskRefs[task.taskID]
  ref.recoveryEnvelope.task = { ...task, revision: 2, status: "running" }
  assert.equal(group().rows[0].status, "running")
  const completed = f.add("agent", "completed", 1, { revision: 6 })
  const before = structuredClone(f.owner)
  assert.equal(group({ hideCompleted: true, hideFailed: true }).total, 0)
  assert.equal(group({ taskID: completed.taskID }).rows[0].status, "completed")
  assert.equal(group().rows[0].revision, 6)
  assert.deepEqual(f.owner, before)
  assert.equal(completed.receipt.acknowledgedAt, undefined)
})

test("overview slot precedes Todo and switches owner using only the supplied public host state", () => {
  const f = fixture()
  f.add("agent", "waiting_question", 1)
  let registration
  const api = { slots: { register(value) { registration = value; return "host-id" } } }
  assert.equal(registerTaskOverview(api, (sessionID) => projectTaskOverview({ sessionID, getSession: (id) => f.sessions.get(id) })), "host-id")
  assert.equal(registration.order, 350)
  const render = registration.slots.sidebar_content
  assert.equal(render({}, { session_id: "owner" }).groups[1].rows[0].status, "waiting_question")
  assert.equal(render({}, { session_id: "different-owner" }).available, false)
  const completed = f.add("command", "completed", 1)
  completed.result.exitCode = 1
  assert.equal(render({}, { session_id: "owner" }).groups[0].rows[0].status, "unknown")
})

test("task lists page beyond the sidebar and details reproject by stable identity", () => {
  const f = fixture()
  for (let n = 1; n <= 45; n++) f.add("command", ["running", "failed", "waiting_question", "completed"][n % 4], n)
  const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id), limit: 20 }
  const pages = [0, 20, 40].map((offset) => projectTaskOverview({ ...options, offset }).groups[0])
  assert.deepEqual(pages.map((g) => g.rows.length), [20, 20, 5])
  assert.equal(new Set(pages.flatMap((g) => g.rows.map((r) => r.id))).size, 45)
  assert.deepEqual(pages.flatMap((g) => g.rows.map((r) => r.sequence)), Array.from({ length: 45 }, (_, n) => 45 - n))
  const order = f.project().groups[0].rows.map((row) => row.id)
  f.add("command", "failed", 45)
  assert.deepEqual(f.project().groups[0].rows.map((row) => row.id), order)
  const selected = projectTaskOverview({ ...options, taskID: id("command", 1) }).groups[0].rows[0]
  assert.equal(selected.revision, 1)
  assert.equal(selected.kind, "command")
  assert.throws(() => projectTaskOverview({ ...options, limit: Infinity }))
  assert.throws(() => projectTaskOverview({ ...options, offset: -1 }))
})

test("navigation rechecks current owner and execution identity without invoking management", () => {
  const f = fixture()
  const task = f.add("agent", "running", 1, { childSessionID: "child", attemptSessionIDs: ["child"], dispatchMessageID: "dispatch", authorizationFingerprint: "a".repeat(64) })
  const child = { id: "child", agent: task.agent, metadata: { o4e: { version: 1, kind: "delegation-attempt", delegation: {
    toolName: "task", taskID: task.taskID, parentSessionID: "owner", targetAgent: task.agent,
    dispatchMessageID: "dispatch", authorizationFingerprint: task.authorizationFingerprint,
  } } } }
  f.sessions.set("child", child)
  const options = { sessionID: "owner", taskID: task.taskID, getSession: (id) => f.sessions.get(id) }
  assert.equal(taskNavigationTarget(options), "child")
  const calls = []
  const api = { state: { session: { get: options.getSession } }, ui: { dialog: { clear: () => calls.push("clear") } }, route: {
    current: { name: "session", params: { sessionID: "owner" } }, navigate: (...args) => calls.push(args),
  } }
  assert.equal(navigateTask(api, "owner", task.taskID), true)
  assert.deepEqual(calls, ["clear", ["session", { sessionID: "child" }]])
  api.route.current.params.sessionID = "other"
  assert.equal(navigateTask(api, "owner", task.taskID), false)
  api.route.current.params.sessionID = "owner"
  child.metadata.o4e.delegation.dispatchMessageID = "stale"
  assert.equal(navigateTask(api, "owner", task.taskID), false)
  f.add("command", "running", 1, { childSessionID: "child" })
  assert.equal(taskNavigationTarget({ ...options, taskID: id("command", 1) }), undefined)
  assert.equal(calls.length, 2)
})

test("same revision conflicting records fail closed rather than showing success", () => {
  const f = fixture()
  const saved = f.add("agent", "completed", 1)
  f.sessions.set(saved.taskSessionID, { id: saved.taskSessionID, metadata: { o4e: { task: { ...saved, status: "running" } } } })
  assert.equal(f.project().groups[1].rows[0].source, "unavailable")
  for (const [kind, mutate] of [
    ["command", (record) => { record.result.exitCode = 1 }],
    ["command", (record) => { record.stopped = false }],
    ["command", (record) => { record.taskSessionID = "legacy-command-session" }],
    ["agent", (record) => { record.receipt.receiptID = "conflicting" }],
    ["agent", (record) => { record.receipt.generation = 8 }],
  ]) {
    const f = fixture()
    const saved = f.add(kind, "completed", 1)
    const canonical = structuredClone(saved)
    mutate(saved)
    if (kind === "agent") f.sessions.set(saved.taskSessionID, { id: saved.taskSessionID, metadata: { o4e: { task: canonical } } })
    else f.owner.metadata.o4e.task = canonical // unrelated owner ledger cannot repair invalid command evidence
    assert.equal(f.project().groups.find((group) => group.kind === kind).rows[0].source, "unavailable")
  }
})

test("owner command projection ignores an Agent ledger and never navigates or reads historical command Sessions", () => {
  const f = fixture()
  const saved = f.add("command", "completed", 1)
  Object.defineProperty(f.owner.metadata.o4e, "task", { get() { throw new Error("owner Agent ledger must not be read") } })
  assert.equal(f.project().groups[0].rows[0].status, "completed")
  const options = { sessionID: "owner", taskID: saved.taskID, getSession: (id) => {
    assert.equal(id, "owner")
    return f.owner
  } }
  assert.equal(taskNavigationTarget(options), undefined)
  assert.equal(commandSource(options).sessionID, "owner")
  f.owner.metadata.o4e.commandTasks.refs[saved.taskID].taskSessionID = "historical-ledger"
  assert.equal(projectTaskOverview(options).groups[0].rows[0].source, "unavailable")
  assert.equal(commandSource(options), undefined)
})

test("palette entry resolves the current owner only when explicitly selected", () => {
  let layer
  const calls = []
  const api = { keymap: { registerLayer(value) { layer = value } }, route: { current: { name: "home" } } }
  registerOverviewCommands(api, (...args) => calls.push(args))
  // The command palette selects commands while modal mode is active.
  const select = (index) => { if (layer.mode === undefined || layer.mode === "modal") layer.commands[index].run() }
  select(0)
  assert.equal(calls.length, 0)
  api.route.current = { name: "session", params: { sessionID: "second-owner" } }
  select(0)
  select(1)
  select(2)
  assert.deepEqual(calls, [["command", "second-owner"], ["agent", "second-owner"], ["workflows", "second-owner"]])
  assert.equal(layer.commands.some((command) => command.name === "o4e.overview.tasks"), false)
})

for (const kind of ["command", "agent"]) test(`${kind} sidebar filters only verified completed before paging; history retains all records`, () => {
  const f = fixture()
  const statuses = ["queued", "starting", "running", "retrying", "waiting_permission", "waiting_question", "waiting_retry_decision", "failed", "unknown", "interrupted", "cancelling", "cancelled"]
  statuses.forEach((status, index) => f.add(kind, status, index + 1))
  if (kind === "command") {
    const ref = f.owner.metadata.o4e.commandTasks.refs[id(kind, 10)]
    Object.assign(ref.recovery, { phase: "not-submitted", stopped: true, claim: null })
    ref.claim = null
  }
  for (let n = 20; n < 45; n++) f.add(kind, "completed", n)
  const broken = f.add(kind, "completed", 45)
  if (kind === "command") broken.result.exitCode = 1
  else broken.receipt.receiptID = "invalid"
  const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id) }
  const group = (extra) => projectTaskOverview({ ...options, ...extra }).groups.find((g) => g.kind === kind)
  const before = structuredClone(f.owner)
  const sidebar = group({ hideCompleted: true })
  assert.equal(sidebar.hiddenCompleted, 25)
  assert.equal(sidebar.total, 13)
  assert.equal(sidebar.rows.length, 6)
  assert.equal(sidebar.hidden, 7)
  const filtered = [0, 6, 12].flatMap((offset) => group({ hideCompleted: true, offset }).rows)
  assert.equal(filtered.find((r) => r.id === broken.taskID).source, "unavailable")
  assert.deepEqual(new Set(filtered.filter((r) => r.source === "snapshot").map((r) => r.status)), new Set(statuses))
  const history = [0, 20].flatMap((offset) => group({ limit: 20, offset }).rows)
  assert.equal(history.length, 38)
  assert.equal(history.filter((r) => r.status === "completed").length, 25)
  assert.equal(group({ taskID: id(kind, 20) }).rows[0].status, "completed")
  assert.deepEqual(f.owner, before, "projection must not consume receipts or change the ledger")
})

test("sidebar completed counts react to completion, new generations and owner changes; invalid indexes stay visible", () => {
  const f = fixture()
  const saved = f.add("agent", "completed", 1)
  const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id), hideCompleted: true }
  const view = () => projectTaskOverview(options)
  assert.equal(view().groups[1].total, 0)
  assert.equal(view().groups[1].hiddenCompleted, 1)
  const active = { ...saved, revision: 2, runGeneration: 1, status: "running" }
  f.sessions.set(saved.taskSessionID, { id: saved.taskSessionID, metadata: { o4e: { task: active } } })
  assert.equal(view().groups[1].total, 1)
  assert.equal(view().groups[1].hiddenCompleted, 0)
  Object.assign(active, structuredClone(saved), { revision: 3 })
  assert.equal(view().groups[1].total, 0)
  assert.equal(projectTaskOverview({ ...options, hideCompleted: false, taskID: saved.taskID }).groups[1].rows[0].status, "completed")
  const other = { id: "other", metadata: { o4e: { commandTasks: { version: 1, refs: {} } } } }
  f.sessions.set(other.id, other)
  assert.ok(projectTaskOverview({ ...options, sessionID: "other" }).groups.every((g) => !g.total && !g.hiddenCompleted && !g.invalid))
  f.owner.metadata.o4e.backgroundTasks.version = 999
  assert.equal(view().groups[1].invalid, 1)
  assert.equal(view().groups[1].hiddenCompleted, 0)
})

test("category cards retain independent history counts and hide categories with no records", () => {
  const f = fixture()
  const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id), hideCompleted: true }
  const cards = () => projectTaskOverview(options).groups.filter((group) => group.total || group.invalid || group.hiddenCompleted)
  assert.deepEqual(cards(), [])
  f.add("command", "completed", 1)
  assert.deepEqual(cards().map((group) => [group.kind, group.total, group.hiddenCompleted]), [["command", 0, 1]])
  f.add("agent", "completed", 1)
  f.add("agent", "completed", 2)
  f.add("agent", "waiting_question", 3)
  assert.deepEqual(cards().map((group) => [group.kind, group.total, group.hiddenCompleted]), [["command", 0, 1], ["agent", 1, 2]])
  for (const kind of ["command", "agent"]) {
    const history = projectTaskOverview({ ...options, hideCompleted: false }).groups.find((group) => group.kind === kind)
    assert.ok(history.rows.every((row) => row.kind === kind))
    assert.equal(history.total, kind === "command" ? 1 : 3)
  }
})

test("compact cards omit verified terminal states but keep uncertain work and all history", () => {
  const f = fixture()
  for (const kind of ["command", "agent"]) {
    for (const [index, status] of ["failed", "completed", "running", "waiting_permission", "unknown", "cancelled", "cancelling", "interrupted"].entries()) f.add(kind, status, index + 1)
    if (kind === "command") {
      const ref = f.owner.metadata.o4e.commandTasks.refs[id(kind, 8)]
      Object.assign(ref.recovery, { phase: "not-submitted", stopped: true, claim: null })
      ref.claim = null
    }
    const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id) }
    const before = structuredClone(f.owner)
    const card = projectTaskOverview({ ...options, hideTerminal: true }).groups.find((g) => g.kind === kind)
    assert.equal(card.total, kind === "command" ? 4 : 5)
    assert.equal(card.allTotal, 8)
    assert.deepEqual(card.rows.map((r) => r.status), kind === "command"
      ? ["cancelling", "unknown", "waiting_permission", "running"]
      : ["interrupted", "cancelling", "unknown", "waiting_permission", "running"])
    const history = projectTaskOverview({ ...options, limit: 20 }).groups.find((g) => g.kind === kind)
    assert.equal(history.total, 8)
    assert.deepEqual(new Set(history.rows.map((r) => r.status)), new Set(["failed", "completed", "running", "waiting_permission", "unknown", "cancelled", "cancelling", "interrupted"]))
    assert.deepEqual(f.owner, before)
  }
})

test("terminal filtering validates cancellation and command claims before hiding records", () => {
  for (const kind of ["command", "agent"]) {
    const f = fixture()
    const cancelled = f.add(kind, "cancelled", 1)
    const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id), hideTerminal: true }
    const group = () => projectTaskOverview(options).groups.find((g) => g.kind === kind)
    assert.equal(group().total, 0)
    if (kind === "agent") cancelled.receipt.receiptID = "invalid"
    else cancelled.stopped = false
    assert.equal(group().rows[0].source, "unavailable")
    assert.equal(group().rows[0].status, "unknown")
  }
  for (const claim of [null, undefined, "", " ", "bad\0claim"]) for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
    const f = fixture()
    const record = f.add("command", status, 1)
    const ref = f.owner.metadata.o4e.commandTasks.refs[record.taskID]
    ref.claim = record.claim = claim
    const options = { sessionID: "owner", getSession: (id) => f.sessions.get(id), hideTerminal: true }
    const group = () => projectTaskOverview(options).groups[0]
    assert.equal(group().rows[0].source, "unavailable", status)
    if (claim === null && ["cancelled", "interrupted"].includes(status)) {
      Object.assign(record, { phase: "not-submitted", stopped: true })
      delete record.result
      assert.equal(group().total, 0, status)
      assert.equal(group().allTotal, 1)
      record.stopped = false
      assert.equal(group().rows[0].source, "unavailable", status)
    }
  }
})

test("Bash output reads only an owner-bound original call and pages the entire captured stream", () => {
  const f = fixture()
  const command = "printf demo"
  const record = f.add("command", "completed", 1, { source: { sessionID: "owner", messageID: "message", callID: "call" }, commandHash: createHash("sha256").update(command).digest("hex") })
  const args = { sessionID: "owner", taskID: record.taskID, getSession: (id) => f.sessions.get(id) }
  const source = commandSource(args)
  const output = "a".repeat(11999) + "😀" + "\n" + "end".repeat(5000)
  const part = { type: "tool", tool: "bash", sessionID: "owner", messageID: "message", callID: "call", state: { status: "completed", input: { command }, output: "background task control", metadata: { taskID: record.taskID, output } } }
  const message = { info: { role: "assistant", id: "message", sessionID: "owner" }, parts: [part] }
  const result = commandOutput({ source, taskID: record.taskID, message })
  assert.equal(result.output, output)
  assert.equal(Array.from({ length: outputPage(output).count }, (_, page) => outputPage(output, page).text).join(""), output)
  assert.ok(Array.from({ length: outputPage(output).count }, (_, page) => outputPage(output, page).text).every((text) => text.length <= 12000))
  part.private = true
  assert.ok(commandOutput({ source, taskID: record.taskID, message }).unavailable)
  delete part.private
  part.state.metadata.output = ""
  assert.equal(commandOutput({ source, taskID: record.taskID, message }).output, "")
  part.state.metadata.output = "[O4E UI output incomplete: limit]"
  assert.equal(commandOutput({ source, taskID: record.taskID, message }).incomplete, true)
  part.state.input.command = "different"
  assert.ok(commandOutput({ source, taskID: record.taskID, message }).unavailable)
  part.state.input.command = command
  message.parts.push(part)
  assert.ok(commandOutput({ source, taskID: record.taskID, message }).unavailable)
  assert.equal(commandSource({ ...args, sessionID: "different" }), undefined)
  f.sessions.set(record.taskSessionID, { id: record.taskSessionID, metadata: { o4e: { task: { ...record, source: { ...record.source, callID: "conflict" } } } } })
  assert.equal(commandSource(args), undefined)
  assert.throws(() => outputPage(output, -1))
})
