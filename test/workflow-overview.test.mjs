import assert from "node:assert/strict"
import test from "node:test"
import { projectWorkflowOverview, workflowEnabled, workflowSidebar, workflowPage, workflowListItem, registerTuiOverviewCommands } from "../src/tui/workflow-overview.mjs"
import { registerTaskListPaging } from "../src/tui/task-overview.mjs"

const runID = (n) => `wfr_00000000-0000-0000-0000-${String(n).padStart(12, "0")}`
const step = (status) => ({ status, attempt: 1, attemptID: "wfa_00000000-0000-0000-0000-000000000001", beginRevision: 2,
  ...(status === "active" ? {} : { decision: { accepted: status === "passed" } }) })

function fixture() {
  const id = runID(1)
  const run = { contract: "process-v1", runID: id, runSessionID: "owner", owner: { sessionID: "owner" },
    status: "running", revision: 2, definition: { name: "review", steps: [{ id: "prepare" }, { id: "check" }] }, steps: { prepare: step("active") } }
  const index = { contract: "process-v1", activeRunID: id, runs: { [id]: run } }
  const owner = { id: "owner", metadata: { o4e: { workflowProcess: index } } }
  const project = () => projectWorkflowOverview({ sessionID: "owner", getSession: () => owner, enabled: true })
  return { id, run, index, owner, project }
}

test("workflow snapshots expose bounded checkpoint fields, never input/output/evidence", () => {
  const f = fixture()
  for (const field of ["input", "output", "submissions", "source"]) Object.defineProperty(f.run, field, { get() { throw new Error("private payload read") } })
  for (const field of ["input", "output", "report", "evidence"]) Object.defineProperty(f.run.steps.prepare, field, { get() { throw new Error("Step body read") } })
  for (const field of ["description", "input", "output"]) Object.defineProperty(f.run.definition, field, { get() { throw new Error("definition body read") } })
  assert.equal(f.project().rows[0].activeStep, "prepare")
  f.run.steps.prepare.status = "passed"
  f.run.steps.prepare.decision = { accepted: true }
  f.run.steps.check = step("rejected")
  f.run.revision++
  assert.equal(f.project().rows[0].passed, 1)
  assert.equal(f.project().rows[0].revision, 3)
  assert.equal(f.project().rows[0].steps[1].status, "rejected")
  assert.deepEqual(projectWorkflowOverview({ sessionID: "different", getSession: () => f.owner, enabled: true }), { available: false, rows: [], invalid: 0 })
})

test("workflow projection rejects malformed, cross-owner and false terminal checkpoints", () => {
  for (const mutate of [
    (f) => { f.run.owner.sessionID = "other" },
    (f) => { f.run.status = "completed"; f.index.activeRunID = null },
    (f) => { f.run.definition.name = "token=secret" },
    (f) => { f.run.steps.check = step("active") },
    (f) => { f.run.steps.prepare = {} },
    (f) => { f.index.activeRunID = null },
    (f) => { f.run.steps.prepare.attempt = 0 },
    (f) => { f.run.steps.prepare.attemptID = "/private/path" },
    (f) => { f.run.steps.prepare.beginRevision = 3 },
    (f) => { f.run.steps.prepare.status = "passed" },
    (f) => { f.run.definition.steps[0].id = "constructor" },
  ]) {
    const f = fixture(); mutate(f)
    assert.equal(f.project().rows.length, 1)
    assert.equal(f.project().rows[0].status, "unknown")
    assert.equal(f.project().rows[0].source, "unavailable")
    assert.deepEqual(f.project().rows[0].steps, [])
    assert.equal(workflowSidebar(f.project()).total, 1)
    assert.ok(f.project().invalid)
    assert.doesNotMatch(JSON.stringify(f.project()), /secret|token|private|path/)
  }
})

test("Workflow Beta is opt-in and disabled views do not even read owner checkpoints", () => {
  for (const options of [undefined, {}, { enableWorkflow: false }, { enableWorkflow: "true" }, { enableWorkflow: 1 }]) {
    assert.equal(workflowEnabled(options), false)
    const view = projectWorkflowOverview({ sessionID: "owner", enabled: workflowEnabled(options), getSession() { throw Error("disabled read") } })
    assert.deepEqual(view, { available: false, rows: [], invalid: 0 })
    assert.equal(workflowSidebar(view).allTotal, 0)
  }
  assert.equal(workflowEnabled({ enableWorkflow: true }), true)
})

test("compact Workflow group retains uncertainty and history with stable identities across updates", () => {
  const f = fixture()
  for (let n = 2; n <= 12; n++) {
    const run = structuredClone(f.run)
    run.runID = runID(n)
    run.status = n <= 4 ? "completed" : n === 5 ? "stopped" : "paused"
    if (run.status === "completed") run.steps = { prepare: step("passed"), check: step("passed") }
    f.index.runs[run.runID] = run
  }
  const before = structuredClone(f.owner)
  const first = f.project()
  assert.deepEqual(workflowSidebar(first), { rows: first.rows.filter((row) => !["completed", "stopped"].includes(row.status)).slice(0, 6), total: 8, allTotal: 12, invalid: 0 })
  assert.deepEqual(f.owner, before, "display never writes checkpoints or Gate decisions")
  f.run.status = "interrupted"
  f.run.revision++
  const next = f.project()
  assert.deepEqual(next.rows.map((row) => [row.id, row.reference]), first.rows.map((row) => [row.id, row.reference]))
  assert.equal(next.rows[0].status, "interrupted")
  f.index.runs[runID(3)].steps.check.decision.accepted = false
  const corrupt = workflowSidebar(f.project())
  assert.equal(corrupt.total, 9)
  assert.equal(corrupt.rows.find((row) => row.id === runID(3)).status, "unknown")
  assert.equal(corrupt.invalid, 0, "the unknown row already explains this malformed Run")
})

test("Run and step pages clamp at boundaries and retain all stable row identities", () => {
  const f = fixture()
  for (let n = 2; n <= 32; n++) f.index.runs[runID(n)] = { ...structuredClone(f.run), runID: runID(n), status: "paused" }
  const rows = f.project().rows
  const pages = [workflowPage(rows), workflowPage(rows, 1)]
  assert.deepEqual(pages.map((page) => page.rows.length), [20, 12])
  assert.equal(new Set(pages.flatMap((page) => page.rows.map((row) => row.id))).size, 32)
  assert.equal(workflowPage(rows, -1).page, 0)
  assert.equal(workflowPage(rows, 99).page, 1)
  assert.deepEqual(workflowPage([], 99), { rows: [], page: 0, count: 1 })
  f.run.definition.steps = Array.from({ length: 256 }, (_, n) => ({ id: `step-${n + 1}` }))
  f.run.steps = {}
  const steps = f.project().rows[0].steps
  assert.equal(workflowPage(steps, 12).rows.length, 16)
  assert.deepEqual(workflowPage(steps, 12).rows.map((step) => step.number), Array.from({ length: 16 }, (_, n) => n + 241))
  f.index.runs[runID(33)] = { ...structuredClone(f.run), runID: runID(33), status: "paused" }
  assert.deepEqual(f.project(), { available: false, rows: [], invalid: 1 })
})

test("owner changes and missing records discard detail snapshots without cross-owner reads", () => {
  const f = fixture()
  let currentOwner = "owner"
  const calls = []
  const view = () => projectWorkflowOverview({ sessionID: "owner", enabled: true, getSession(id) {
    if (currentOwner !== "owner") return undefined
    calls.push(id)
    return f.owner
  } })
  assert.equal(view().rows.find((row) => row.id === f.id).status, "running")
  currentOwner = "other"
  assert.equal(view().rows.find((row) => row.id === f.id), undefined)
  currentOwner = "owner"
  delete f.index.runs[f.id]
  assert.equal(view().rows.find((row) => row.id === f.id), undefined)
  assert.equal(view().invalid, 1)
  assert.ok(calls.every((id) => id === "owner"))
})

test("malformed indexes and identifiers produce generic unavailable without leaking arbitrary keys", () => {
  for (const value of [null, [], { contract: "old" }, { contract: "process-v1", runs: {}, activeRunID: "/private/token" }]) {
    const f = fixture()
    f.owner.metadata.o4e.workflowProcess = value
    assert.deepEqual(f.project(), { available: false, rows: [], invalid: 1 })
  }
  const f = fixture()
  f.index.runs["token=secret"] = null
  assert.equal(workflowSidebar(f.project()).invalid, 1)
  assert.doesNotMatch(JSON.stringify(f.project()), /token|secret/)
  const other = "wfr_11111111-0000-0000-0000-000000000001"
  f.index.runs[other] = { ...structuredClone(f.run), runID: other, status: "paused" }
  const rows = f.project().rows
  assert.equal(new Set(rows.map((row) => row.reference)).size, 2)
  assert.ok(rows.every((row) => row.reference.length === 36))
})

test("Workflow list formatting preserves status at narrow widths and budgets names at wide widths", () => {
  const row = fixture().project().rows[0]
  row.workflow = "very-long-workflow-name".repeat(3).slice(0, 80)
  const measure = (text) => text.length // accepted identifiers and states are ASCII
  for (const columns of [0, 12, 18, 24, 32, 40, 80, 140]) {
    const item = workflowListItem({ row, columns, measure })
    assert.ok(item.title.startsWith(`#${row.reference}`))
    assert.match(item.footer ?? item.description, /running/)
    if (item.footer) assert.ok(measure(item.title) + measure(item.footer) <= columns)
    if (columns < 18) assert.equal(item.description, "running")
    assert.ok(measure(item.title) <= 61)
  }
  const broken = { ...row, status: "unknown", source: "unavailable", workflow: undefined }
  assert.equal(workflowListItem({ row: broken, columns: 15, measure }).description, "unknown · unavailable")
  assert.equal(workflowListItem({ row: broken, columns: 80, measure }).footer, "unknown · unavailable")
})

test("Workflow uses focused, disposable arrow paging and defaults to Task-only palette entries", () => {
  let layer
  let disposed = false
  let page = 0
  let total = 32
  const calls = []
  const panel = {}
  const api = { keymap: { registerLayer(value) { layer = value; return () => { disposed = true } } }, route: { current: { name: "home" } } }
  registerTuiOverviewCommands(api, (...args) => calls.push(args))
  assert.deepEqual(layer.commands.map((cmd) => cmd.name), ["o4e.overview.command", "o4e.overview.agent"])
  registerTuiOverviewCommands(api, (...args) => calls.push(args), { enableWorkflow: true })
  const workflow = layer.commands.find((cmd) => cmd.name === "o4e.overview.workflows")
  assert.match(workflow.title, /Beta/)
  workflow.run(); assert.deepEqual(calls, [])
  api.route.current = { name: "session", params: { sessionID: "current-owner" } }
  workflow.run(); assert.deepEqual(calls, [["workflows", "current-owner"]])
  const dispose = registerTaskListPaging(api, panel, { page: () => page, total: () => total, setPage: (next) => { page = next } })
  assert.equal(layer.target, panel)
  assert.equal(layer.targetMode, "focus-within")
  const key = (name) => layer.bindings.find((binding) => binding.key === name).cmd()
  key("left"); assert.equal(page, 0)
  key("right"); assert.equal(page, 1)
  key("right"); assert.equal(page, 1)
  total = 0
  key("left"); assert.equal(page, 0)
  dispose(); assert.equal(disposed, true)
})
