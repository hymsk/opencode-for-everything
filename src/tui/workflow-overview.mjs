// UI snapshot validation only; it does not revalidate Gate evidence or authorize a Run.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value)
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const runPattern = new RegExp(`^wfr_${uuid}$`)
const attemptPattern = new RegExp(`^wfa_${uuid}$`)
const runID = (value) => typeof value === "string" && runPattern.test(value)
const attemptID = (value) => typeof value === "string" && attemptPattern.test(value)
const statuses = new Set(["running", "paused", "interrupted", "completed", "stopped"])

// The public TUI startup options must be supplied by the integration. Neither a
// saved Run nor an Agent permission proves the current Runtime opted in.
export const workflowEnabled = (options) => options?.enableWorkflow === true

export function projectWorkflowOverview({ sessionID, getSession, enabled = false }) {
  if (enabled !== true) return { available: false, rows: [], invalid: 0 }
  const owner = getSession(sessionID)
  if (owner?.id !== sessionID) return { available: false, rows: [], invalid: 0 }
  const index = owner.metadata?.o4e?.workflowProcess
  if (index === undefined) return { available: true, rows: [], invalid: 0 }
  if (!object(index) || index.contract !== "process-v1" || !object(index.runs)
    || Object.keys(index.runs).length > 32 || !(index.activeRunID === null || runID(index.activeRunID))) {
    return { available: false, rows: [], invalid: 1 }
  }
  const rows = []
  let invalid = 0
  for (const [id, run] of Object.entries(index.runs)) {
    if (!runID(id)) { invalid++; continue }
    const unavailable = () => { invalid++; rows.push({ id, status: "unknown", source: "unavailable", steps: [] }) }
    if (!object(run) || run.runID !== id || run.contract !== "process-v1"
      || run.owner?.sessionID !== sessionID || run.runSessionID !== sessionID || !statuses.has(run.status)
      || !Number.isSafeInteger(run.revision) || run.revision < 1 || !identifier(run.definition?.name)
      || !Array.isArray(run.definition.steps) || !run.definition.steps.length || run.definition.steps.length > 256
      || !object(run.steps)) { unavailable(); continue }
    const ids = run.definition.steps.map((step) => step?.id)
    if (ids.some((id) => !identifier(id)) || new Set(ids).size !== ids.length || Object.keys(run.steps).length > ids.length
      || Object.entries(run.steps).some(([id, state]) => !ids.includes(id) || !object(state)
        || !["active", "passed", "rejected"].includes(state.status)
        || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || state.attempt > 11 || !attemptID(state.attemptID)
        || !Number.isSafeInteger(state.beginRevision) || state.beginRevision < 2 || state.beginRevision > run.revision
        || state.status !== "active" && state.decision?.accepted !== (state.status === "passed"))) { unavailable(); continue }
    const steps = ids.map((id, index) => ({ id, number: index + 1, status: run.steps[id]?.status ?? "pending",
      ...(run.steps[id] ? { attempt: run.steps[id].attempt } : {}) }))
    const active = steps.filter((step) => step.status === "active")
    const passed = steps.filter((step) => step.status === "passed").length
    if (steps.some((step) => !["pending", "active", "passed", "rejected"].includes(step.status)) || active.length > 1
      || (run.status === "completed" && passed !== ids.length)
      || (["running", "interrupted"].includes(run.status) && index.activeRunID !== id)
      || (index.activeRunID === id && !["running", "interrupted"].includes(run.status))) { unavailable(); continue }
    rows.push({ id, workflow: run.definition.name, status: run.status, revision: run.revision,
      passed, total: ids.length, steps, activeStep: active[0]?.id, source: "snapshot" })
  }
  if (index.activeRunID !== null && !rows.some((row) => row.id === index.activeRunID)) invalid++
  // Runs have no canonical sequence. Use an identity label, not an invented
  // creation number or status rank; collisions expand to the full UUID.
  for (const row of rows) row.reference = rows.filter((other) => other.id.slice(-8) === row.id.slice(-8)).length === 1
    ? row.id.slice(-8) : row.id.slice(4)
  rows.sort((a, b) => a.id.localeCompare(b.id))
  return { available: true, rows, invalid }
}

export function workflowSidebar(view) {
  const rows = view.rows.filter((row) => row.source !== "snapshot" || !["completed", "stopped"].includes(row.status))
  return { rows: rows.slice(0, 6), total: rows.length, allTotal: view.rows.length,
    // Known malformed Runs already have explicit unknown/unavailable rows.
    invalid: view.invalid - view.rows.filter((row) => row.source === "unavailable").length }
}

export function workflowPage(rows, page = 0) {
  const count = Math.max(1, Math.ceil(rows.length / 20))
  const current = Number.isSafeInteger(page) ? Math.max(0, Math.min(count - 1, page)) : 0
  return { rows: rows.slice(current * 20, (current + 1) * 20), page: current, count }
}

export function workflowListItem({ row, columns, measure }) {
  const number = `#${row.reference}`
  const status = `${row.status}${row.source === "unavailable" ? " · unavailable" : ""}`
  const budget = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0
  let footer = row.source === "snapshot" ? `${status} · ${row.passed}/${row.total}` : status
  if (measure(number) + measure(footer) > budget) footer = status
  // Preserve the complete status on its own line rather than truncate it behind
  // a workflow name on a narrow terminal (or a full UUID collision label).
  if (measure(number) + measure(footer) > budget) return { title: number, description: footer }
  const available = Math.min(61, budget - measure(footer)) - measure(number) - 1
  if (!row.workflow || available < 4) return { title: number, footer }
  const name = measure(row.workflow) <= available ? row.workflow : `${row.workflow.slice(0, available - 1)}…`
  return { title: `${number} ${name}`, footer }
}

// Kept here so the Workflow entry can be absent when Beta is disabled, without
// changing the separate Task projection or reading private configuration.
export function registerTuiOverviewCommands(api, open, options) {
  const entries = [["command", "O4E: View Bash tasks"], ["agent", "O4E: View subagent tasks"]]
  if (workflowEnabled(options)) entries.push(["workflows", "O4E: View Workflows (Beta)"])
  return api.keymap.registerLayer({ commands: entries.map(([kind, title]) => ({
    name: `o4e.overview.${kind}`, title, category: "O4E", namespace: "palette", run() {
      const route = api.route.current
      if (route.name === "session" && typeof route.params?.sessionID === "string") open(kind, route.params.sessionID)
    },
  })) })
}
