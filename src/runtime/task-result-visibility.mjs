import { isActionableTaskStatus, isTerminalTaskStatus } from "../core/background-task-domain.mjs"
import { modelTaskPart, publicValue } from "./task-model-output.mjs"
export { publicValue } from "./task-model-output.mjs"

const nonempty = (value) => typeof value === "string" && value.trim().length > 0

// Keep rendering and delivery evidence tied to exactly the same public state.
export function statusLine(label, result, { reason = true } = {}) {
  const details = [result.status, result.phase, reason ? result.reason : undefined, result.exitCode === undefined ? undefined : `exit ${result.exitCode}`]
    .filter((value) => value !== undefined && value !== "")
  return `${label}${details.length ? ` · ${details.join(" · ")}` : ""}`
}

export function previewLines(preview, index) {
  const label = `${index === undefined ? "Task" : `Task ${index + 1}`} ${preview.taskID ?? "unknown"}`
  const lines = [statusLine(label, preview)]
  if (isActionableTaskStatus(preview.status) && !isTerminalTaskStatus(preview.status)
    && Number.isSafeInteger(preview.revision)) lines.push(`Expected revision: ${preview.revision}`)
  if (preview.tail) lines.push(preview.tail)
  if (typeof preview.output === "string") lines.push(preview.output || "(no output)")
  if (preview.outputTruncated) lines.push(`[Result preview truncated; ${preview.outputBytes ?? "unknown"} bytes observed. Use output to read the authoritative retained result.]`)
  else if (preview.truncated) lines.push("[Output truncated; retained view only. Use inspect to page the retained output.]")
  if (preview.unchanged) lines.push("No new public output.")
  if (preview.unavailable) lines.push(`Preview unavailable: ${preview.unavailable}`)
  if (preview.gap) lines.push(`Preview gap: ${preview.gap}`)
  if (preview.cursor) lines.push(`Cursor: ${preview.cursor}`)
  if (preview.beforeCursor) lines.push(`Earlier cursor: ${preview.beforeCursor}`)
  return lines
}

export function inspectionText(preview, kind) {
  const control = kind === "command" ? commandControlLines(preview) : []
  return [...control, ...previewLines(preview)].join("\n")
}

export function watchTaskText(task, index) {
  const details = [task.status, task.phase, task.exitCode === undefined ? undefined : `exit ${task.exitCode}`]
    .filter((value) => value !== undefined && value !== "")
  const lines = [`Task ${index + 1} ${task.taskID} · ${details.join(" · ")}`]
  if (Number.isSafeInteger(task.revision)) lines.push(`Expected revision: ${task.revision}`)
  if (task.reason) lines.push(`Reason: ${task.reason}`)
  if (task.diagnostic) lines.push(`Diagnostic: ${task.diagnostic}`)
  if (task.truncated) lines.push("Output view truncated; use output or inspect to read the retained text.")
  if (task.logError || (task.stopped && task.logComplete === false)) {
    lines.push(`Log incomplete${task.logError ? `: ${task.logError}` : "."}`)
  }
  return lines.join("\n")
}

export function hasUnmodifiedToolOutput(state) {
  return typeof state?.output === "string" && state.metadata?.truncated !== true
    && state.time?.compacted === undefined
}

/** Persisted metadata identifies a result; only a public, intact Part can prove delivery. */
export function priorPublicToolParts(messages, context) {
  if (!Array.isArray(messages) || ![context?.sessionID, context?.messageID, context?.callID].every(nonempty)) return []
  const publicMessage = (message) => message?.info?.role === "assistant"
    && message.info.sessionID === context.sessionID && nonempty(message.info.id)
    && publicValue(message) && publicValue(message.info) && Array.isArray(message.parts)
  const publicPart = (part, message) => part?.type === "tool" && ["o4e_task", "bash"].includes(part.tool)
    && nonempty(part.callID) && publicValue(part) && publicValue(part.state)
    && (part.sessionID === undefined || part.sessionID === context.sessionID)
    && (part.messageID === undefined || part.messageID === message.info.id)
  const boundaries = messages.flatMap((message, index) => message?.info?.id === context.messageID ? [index] : [])
  if (boundaries.length !== 1) return []
  const boundaryIndex = boundaries[0]
  const boundary = messages[boundaryIndex]
  if (!publicMessage(boundary)) return []
  const calls = boundary.parts.flatMap((part, index) => part?.callID === context.callID ? [index] : [])
  if (calls.length !== 1 || !publicPart(boundary.parts[calls[0]], boundary)
    || !["pending", "running", "completed", "error"].includes(boundary.parts[calls[0]].state.status)) return []
  const prior = []
  for (let index = 0; index <= boundaryIndex; index += 1) {
    const message = messages[index]
    if (!publicMessage(message)) continue
    const parts = index === boundaryIndex ? message.parts.slice(0, calls[0]) : message.parts
    for (const part of parts) {
      if (publicPart(part, message) && part.state.status === "completed" && hasUnmodifiedToolOutput(part.state)) {
        try { prior.push({ ...modelTaskPart(part), sessionID: context.sessionID, messageID: message.info.id }) }
        catch { /* Invalid model presentation is not delivery evidence. */ }
      }
    }
  }
  return prior
}

export function commandControlLines(result, outputOnly = false) {
  const control = []
  if (!outputOnly && ["queued", "running"].includes(result.status)) {
    control.push(`[O4E command ${result.status}; taskID=${result.taskID}${result.exitCode === undefined ? "" : `; exit=${result.exitCode}`}${result.diagnostic ? `; diagnostic=${result.diagnostic}` : ""}; use o4e_task watch/inspect/output/cancel]`)
  } else if (!outputOnly && (result.status !== "completed" || result.exitCode !== 0 || result.diagnostic)) {
    control.push(`[O4E command ${result.status}${result.exitCode === undefined ? "" : `; exit=${result.exitCode}`}${result.reason ? `; reason=${result.reason}` : ""}${result.diagnostic ? `; diagnostic=${result.diagnostic}` : ""}]`)
  }
  if (result.truncated || result.logError || (result.stopped && result.logComplete === false)) {
    control.push(`[O4E output ${result.truncated ? "preview-truncated" : "preview-retained"}; log=${result.logPath ?? "unavailable"}; complete=${result.logComplete === true ? "yes" : "no"}${result.logError ? `; error=${result.logError}` : ""}]`)
  }
  return control
}
