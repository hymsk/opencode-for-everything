import { createHash } from "node:crypto"
// Display-only projection. No Runtime imports, client calls, writes or recovery.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const statuses = new Set(["queued", "starting", "running", "waiting_permission", "waiting_question", "waiting_workflow", "waiting_retry_decision", "waiting_tool", "retrying", "cancelling", "completed", "failed", "cancelled", "unknown", "interrupted"])
const terminal = new Set(["completed", "failed", "cancelled"])
const taskIdentity = (value, kind) => typeof value === "string" && new RegExp(`^o4e_${kind === "agent" ? "task" : kind}_[a-f0-9]{32}$`).test(value)
const validRecord = (record, owner, id, kind, sessionID) => object(record)
  && record.version === 1 && record.kind === kind && record.taskID === id
  && record.ownerSessionID === owner && record.taskSessionID === sessionID
  && Number.isSafeInteger(record.revision) && record.revision > 0
  && Number.isSafeInteger(record.sequence) && record.sequence > 0 && statuses.has(record.status)

function terminalEvidence(record, kind) {
  if (kind === "command" && (terminal.has(record.status) || record.status === "interrupted")) {
    if (record.stopped !== true) return false
    if (["cancelled", "interrupted"].includes(record.status) && record.phase === "not-submitted") {
      return record.claim === null && record.result === undefined
    }
    if (record.status === "interrupted" || typeof record.claim !== "string" || !record.claim.trim() || record.claim.includes("\0")) return false
  }
  if (!terminal.has(record.status)) return true
  if (kind === "agent") return object(record.receipt) && record.receipt.taskID === record.taskID
    && record.receipt.status === record.status && record.receipt.generation === record.runGeneration
    && record.receipt.version === 1 && record.receipt.phase === record.phase
    && Number.isSafeInteger(record.receipt.createdAt) && record.receipt.createdAt >= 0
    && record.receipt.receiptID === `o4e_receipt_${createHash("sha256").update(`${record.taskID}\0${record.status}\0${record.runGeneration}`).digest("hex").slice(0, 32)}`
  return record.stopped === true && (record.status === "cancelled" && record.phase === "not-submitted"
    || object(record.result) && record.result.status === record.status && record.result.stopped === true
      && (record.status !== "completed" || record.result.exitCode === 0))
}

function sameSnapshot(a, b, kind) {
  if (["status", "phase", "sequence", "ownerSessionID", "taskSessionID", "childSessionID", "dispatchMessageID", "runGeneration", "agent", "authorizationFingerprint"]
    .some((field) => a[field] !== b[field])) return false
  if (kind === "command" && (a.commandHash !== b.commandHash || ["sessionID", "messageID", "callID"].some((field) => a.source?.[field] !== b.source?.[field]))) return false
  if (!terminal.has(a.status)) return true
  if (kind === "agent") return ["version", "receiptID", "taskID", "status", "phase", "generation", "createdAt"]
    .every((field) => a.receipt?.[field] === b.receipt?.[field])
  return a.stopped === b.stopped && ["status", "stopped", "exitCode"].every((field) => a.result?.[field] === b.result?.[field])
}

function selectedRecord(kind, ref, owner, id, getSession) {
  const saved = kind === "command" ? ref.snapshot : ref.recoveryEnvelope?.version === 1 ? ref.recoveryEnvelope.task : undefined
  if (kind === "command") {
    // The owner may itself carry an Agent ledger. It is never this command's
    // execution Session, and its o4e.task must not participate in projection.
    const source = saved?.source
    return ref.taskSessionID === owner && saved?.taskSessionID === owner
      && source?.sessionID === owner && typeof source.messageID === "string" && typeof source.callID === "string"
      && ref.callKey === createHash("sha256").update(JSON.stringify([owner, source.messageID, source.callID])).digest("hex")
      && ref.claim === saved.claim ? saved : undefined
  }
  const session = typeof ref.taskSessionID === "string" ? getSession(ref.taskSessionID) : undefined
  const canonical = session?.id === ref.taskSessionID ? session.metadata?.o4e?.task : undefined
  if (canonical === undefined) return saved
  if (!validRecord(canonical, owner, id, kind, ref.taskSessionID)) return undefined
  if (saved && canonical.revision === saved.revision && !sameSnapshot(canonical, saved, kind)) return undefined
  return !saved || canonical.revision >= saved.revision ? canonical : saved
}

const safePhase = (phase) => typeof phase === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(phase) ? phase : undefined

function group(kind, refs, owner, getSession, limit, offset, taskID, hideCompleted, hideFailed, hideTerminal) {
  const rows = []
  let invalid = 0
  let hiddenCompleted = 0
  let hiddenFailed = 0
  let hiddenTerminal = 0
  for (const [id, ref] of Object.entries(refs)) {
    if (taskID !== undefined && id !== taskID) continue
    if (!taskIdentity(id, kind) || !object(ref)) { invalid++; continue }
    const record = selectedRecord(kind, ref, owner, id, getSession)
    const valid = validRecord(record, owner, id, kind, ref.taskSessionID) && terminalEvidence(record, kind)
      && (kind === "command" || (ref.kind === "agent" && record.sequence === ref.sequence
        && Number.isSafeInteger(record.runGeneration) && record.runGeneration >= 0
        && Array.isArray(record.attemptSessionIDs)))
    const status = valid ? record.status : "unknown"
    // Command interruption is final only with verified not-submitted/stop evidence.
    // Unknown and Agent interruption remain actionable, even if a read has ended.
    if (hideTerminal && valid && (terminal.has(status) || kind === "command" && status === "interrupted")) {
      hiddenTerminal++
      continue
    }
    // Filter only validated projections, before sorting and paging. Raw
    // completed fields without trustworthy evidence must remain visible.
    if (hideCompleted && valid && status === "completed") { hiddenCompleted++; continue }
    if (hideFailed && valid && status === "failed") { hiddenFailed++; continue }
    // Names are configuration identifiers, not descriptions, commands or paths.
    const agent = valid && typeof record.agent === "string" && /^[a-z0-9][a-z0-9-]{0,47}(?: \(plan\))?$/.test(record.agent) ? record.agent : "Agent"
    rows.push({ id, kind, label: kind === "command" ? "Bash" : agent, status,
      sequence: valid ? record.sequence : 0, source: valid ? "snapshot" : "unavailable",
      ...(valid ? { revision: record.revision, ...(safePhase(record.phase) ? { phase: record.phase } : {}) } : {}),
      ...(valid && kind === "command" && terminal.has(status) && Number.isSafeInteger(record.result?.exitCode) ? { exitCode: record.result.exitCode } : {}),
      ...(valid && kind === "agent" ? { generation: record.runGeneration } : {}) })
  }
  rows.sort((a, b) => b.sequence - a.sequence || a.id.localeCompare(b.id))
  return { kind, total: rows.length, allTotal: rows.length + hiddenCompleted + hiddenFailed + hiddenTerminal, hidden: Math.max(0, rows.length - offset - limit), hiddenCompleted, hiddenFailed, hiddenTerminal, invalid, rows: rows.slice(offset, offset + limit) }
}

export function projectTaskOverview({ sessionID, getSession, limit = 6, offset = 0, taskID, hideCompleted = false, hideFailed = false, hideTerminal = false }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid overview page")
  const owner = getSession(sessionID)
  if (!owner || owner.id !== sessionID) return { available: false, groups: [] }
  const o4e = owner.metadata?.o4e
  const groups = []
  for (const [kind, index, field] of [["command", o4e?.commandTasks, "refs"], ["agent", o4e?.backgroundTasks, "taskRefs"]]) {
    if (index === undefined) continue
    if (!object(index) || index.version !== (kind === "command" ? 2 : 1) || !object(index[field])) {
      groups.push({ kind, total: 0, allTotal: 0, hidden: 0, hiddenCompleted: 0, hiddenFailed: 0, hiddenTerminal: 0, invalid: 1, rows: [] })
      continue
    }
    groups.push(group(kind, index[field], sessionID, getSession, limit, offset, taskID, hideCompleted, hideFailed, hideTerminal))
  }
  return { available: true, groups }
}

// Explicit human detail only. Never read commands, outputs or descriptions during sidebar projection.
export function adjacentCommand({ sessionID, taskID, getSession, direction }) {
  if (direction !== -1 && direction !== 1) throw new Error("Invalid task direction")
  let previous
  let found = false
  for (let offset = 0; ; offset += 50) {
    const group = projectTaskOverview({ sessionID, getSession, limit: 50, offset }).groups.find((g) => g.kind === "command")
    if (!group) return undefined
    for (let index = 0; index < group.rows.length; index++) {
      const row = group.rows[index]
      if (found) return { taskID: row.id, page: Math.floor((offset + index) / 20) }
      if (row.id === taskID) {
        if (direction === -1) return previous
        found = true
      }
      previous = { taskID: row.id, page: Math.floor((offset + index) / 20) }
    }
    if (!group.hidden) return undefined
  }
}

export function outputScreenMove({ page, count, top, height, viewport, direction }) {
  const max = Math.max(0, height - viewport)
  if (direction === 1 && top >= max && page < count - 1) return { page: page + 1, top: 0 }
  if (direction === -1 && top <= 0 && page > 0) return { page: page - 1, top: "end" }
  return { page, top: Math.max(0, Math.min(max, top + direction * Math.max(1, viewport - 1))) }
}

export function registerTaskListPaging(api, panel, { page, total, setPage }) {
  const turn = (direction) => setPage(Math.max(0, Math.min(Math.max(0, Math.ceil(total() / 20) - 1), page() + direction)))
  return api.keymap.registerLayer({ target: panel, targetMode: "focus-within", bindings: [
    { key: "left", cmd: () => turn(-1) }, { key: "right", cmd: () => turn(1) },
  ] })
}

export function commandSource({ sessionID, taskID, getSession }) {
  const row = projectTaskOverview({ sessionID, taskID, getSession }).groups.flatMap((g) => g.rows)[0]
  if (row?.kind !== "command" || row.source !== "snapshot") return undefined
  const ref = getSession(sessionID)?.metadata?.o4e?.commandTasks?.refs?.[taskID]
  const record = selectedRecord("command", ref, sessionID, taskID, getSession)
  const source = record?.source
  if (!object(source) || source.sessionID !== sessionID || ![source.messageID, source.callID].every((s) => typeof s === "string" && s.length > 0)) return undefined
  return { ...source, commandHash: record.commandHash }
}

function commandPart({ source, taskID, message }, maxCommandLength = Infinity) {
  if (!source || message?.info?.id !== source.messageID || message.info.sessionID !== source.sessionID || message.info.role !== "assistant") return { unavailable: "Source message unavailable" }
  const hidden = (value) => value?.hidden === true || value?.private === true || value?.ignored === true || value?.synthetic === true
  if (hidden(message.info)) return { unavailable: "Source message unavailable" }
  const parts = Array.isArray(message.parts) ? message.parts.filter((part) => part?.type === "tool" && part.tool === "bash" && part.callID === source.callID
    && part.sessionID === source.sessionID && part.messageID === source.messageID) : []
  const part = parts.length === 1 ? parts[0] : undefined
  if (!part || hidden(part) || hidden(part.state) || part.state?.metadata?.taskID !== taskID || typeof part.state.input?.command !== "string"
    || part.state.input.command.length > maxCommandLength
    || createHash("sha256").update(part.state.input.command).digest("hex") !== source.commandHash) return { unavailable: "Bash source identity unavailable" }
  return { part }
}

export function commandOutput(args) {
  const { part, unavailable } = commandPart(args)
  if (!part) return { unavailable }
  // metadata.output is the original Shell card's captured stream, not the detached control reply.
  const output = part.state.metadata.output
  if (typeof output !== "string") return { unavailable: "Captured output not available; refresh after host sync" }
  return { output, ...(part.state.metadata.truncated === true || output.includes("[O4E UI output incomplete:") ? { incomplete: true } : {}) }
}

// Explicit list only: never fetch, persist, search hidden input, or read output.
export function commandPreview(args) {
  const { part } = commandPart(args, 65536)
  if (!part || !["running", "completed", "error"].includes(part.state.status)
    || part.state.time?.compacted !== undefined) return undefined
  const command = part.state.input.command
  const line = command.split(/[\r\n\u2028\u2029]/, 1)[0]
  if (!line || line.length > 4096 || /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(line)) return undefined
  // Conservative screen-exposure guard, NOT a secret detector or shell parser.
  // Reject whole previews rather than laundering a command into misleading text.
  if (/(?:[a-z_][\w]*=|\$env:|\b(?:token|password|passwd|secret|authorization|api[-_]?key|credential)\b|:\/\/|(?:^|[\s"'=])(?:\/|~[\/\\]|[a-z]:[\/\\]|\\\\))/i.test(line)) return undefined
  return line.trim()
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function commandListItem({ row, rows = [row], preview, columns, measure }) {
  const number = `#${row.sequence || "?"}`
  const fields = (item) => [item.status, item.phase !== item.status ? item.phase || "" : "",
    item.exitCode === undefined ? "" : String(item.exitCode)]
  // Known status/phase names and exit codes are ASCII. Keep each metadata column
  // stable across this page, including rows without a phase or exit code.
  const widths = [0, 1, 2].map(index => Math.max(...rows.map(item => fields(item)[index].length), fields(row)[index].length))
  const status = fields(row).map((value, index) => widths[index] === 0 ? ""
    : `${index === 0 ? "" : value ? " · " : "   "}${index === 2 ? value.padStart(widths[index]) : value.padEnd(widths[index])}`).join("")
  const base = { title: number, footer: status }
  if (!preview || !Number.isFinite(columns) || typeof measure !== "function") return base
  // Host DialogSelect truncates title at 61 columns independently of its footer.
  // columns already excludes host gutters and the title/footer gap.
  const titleColumns = Math.min(61, Math.floor(columns) - measure(status))
  const available = titleColumns - measure(number) - measure(" ")
  // Do not spend scarce space on an unrecognizable fragment or a placeholder.
  if (available < 12) return base
  if (measure(preview) <= available) return { title: `${number} ${preview}`, footer: status }
  const budget = available - measure("…")
  let prefix = ""
  for (const { segment } of graphemes.segment(preview)) {
    if (measure(prefix + segment) > budget) break
    prefix += segment
  }
  return prefix ? { title: `${number} ${prefix}…`, footer: status } : base
}

export function outputPage(output, page = 0, size = 12000) {
  if (typeof output !== "string" || !Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 2 || size > 12000) throw new Error("Invalid output page")
  const stride = size - 1
  const count = Math.max(1, Math.ceil(output.length / stride))
  let start = Math.min(page, count - 1) * stride
  let end = Math.min(start + stride, output.length)
  // Keep UTF-16 pairs together without losing or repeating characters across pages.
  if (start && /[\uDC00-\uDFFF]/.test(output[start]) && /[\uD800-\uDBFF]/.test(output[start - 1])) start--
  if (end < output.length && /[\uDC00-\uDFFF]/.test(output[end]) && /[\uD800-\uDBFF]/.test(output[end - 1])) end--
  return { text: output.slice(start, end), count }
}

// A navigation target is a checked link, not an execution/management authority.
export function taskNavigationTarget({ sessionID, taskID, getSession }) {
  const row = projectTaskOverview({ sessionID, getSession, taskID }).groups.flatMap((g) => g.rows)[0]
  if (!row || row.kind !== "agent" || row.source !== "snapshot") return undefined
  const ref = getSession(sessionID)?.metadata?.o4e?.backgroundTasks?.taskRefs?.[taskID]
  const ledger = getSession(ref.taskSessionID)?.metadata?.o4e?.task
  const saved = ref.recoveryEnvelope?.task
  const record = ledger && (!saved || ledger.revision >= saved.revision) ? ledger : saved
  const childID = record?.childSessionID
  if (typeof childID !== "string" || childID === sessionID || !record.attemptSessionIDs.includes(childID)) return undefined
  const child = getSession(childID)
  const state = child?.metadata?.o4e
  const delegation = state?.delegation
  if (child?.id !== childID || state?.version !== 1 || state.kind !== "delegation-attempt"
    || delegation?.toolName !== "task" || delegation.taskID !== taskID || delegation.parentSessionID !== sessionID
    || child.agent !== record.agent || delegation.targetAgent !== record.agent
    || !/^[a-f0-9]{64}$/.test(record.authorizationFingerprint ?? "")
    || delegation.authorizationFingerprint !== record.authorizationFingerprint
    || typeof record.dispatchMessageID !== "string" || delegation.dispatchMessageID !== record.dispatchMessageID
    || (delegation.executionSessionID !== undefined && delegation.executionSessionID !== childID)) return undefined
  return childID
}

export function navigateTask(api, sessionID, taskID) {
  if (api.route.current.name !== "session" || api.route.current.params?.sessionID !== sessionID) return false
  const target = taskNavigationTarget({ sessionID, taskID, getSession: (id) => api.state.session.get(id) })
  if (!target) return false
  api.ui.dialog.clear()
  api.route.navigate("session", { sessionID: target })
  return true
}

export function registerTaskOverview(api, render) {
  // The host owns/disposes the slot registration. No timers or event listeners.
  return api.slots.register({ order: 350, slots: {
    sidebar_content(_context, props) { return render(props.session_id) },
  } })
}

export function registerOverviewCommands(api, open) {
  // Palette selection itself runs in modal mode. No bindings are installed.
  return api.keymap.registerLayer({ commands: [
    ["command", "O4E: View Bash tasks"], ["agent", "O4E: View subagent tasks"], ["workflows", "O4E: View Workflow checkpoints"],
  ].map(([kind, title]) => ({ name: `o4e.overview.${kind}`, title, category: "O4E", namespace: "palette", run() {
    const route = api.route.current
    if (route.name !== "session" || typeof route.params?.sessionID !== "string") return
    open(kind, route.params.sessionID)
  } })) })
}
