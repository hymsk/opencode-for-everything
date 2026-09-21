import { hasUnmodifiedToolOutput, inspectionText } from "../../runtime/task-result-visibility.mjs"
import { modelTaskPart } from "../../runtime/task-model-output.mjs"

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value) => typeof value === "string" && value.trim().length > 0
const validCursor = (value) => nonempty(value) && value.length <= 512
const matchesInspectionText = (state, preview) => {
  try { return modelTaskPart({ type: "tool", tool: "o4e_task", state }).state.output === inspectionText(preview, state.metadata.kind ?? preview.kind) }
  catch { return false } // Damaged metadata must not turn a rejected anchor into a tool error.
}
const publicValue = (value) => !value?.synthetic && !value?.ignored && !value?.private
  && !value?.summary && !value?.compaction
  && !["summary", "compaction"].includes(value?.mode)
  && !["summary", "compaction"].includes(value?.agent)
  && (value?.visibility === undefined || value.visibility === "public")

/**
 * Recover opaque preview positions from persisted parent inspect responses only.
 * Pages are chronological internally; nextCursor walks older pages. Keep only
 * per-call positions/IDs, never parent bodies or a durable reader watermark.
 * Empty/not-dispatched previews are fresh only after exhausting history without
 * an older anchor or failure; they never permit fallback to an old position.
 * The caller must exclude unavailable Tasks from previews, not read their latest
 * tail. Cursor authorization and execution/source validation remain the reader's.
 */
export async function resolveInspectionCursors({ store, sessionID, messageID, callID, taskIDs, direction = "forward", signal }) {
  const ids = [...new Set(Array.isArray(taskIDs) ? taskIDs.filter(nonempty) : [])]
  const fail = (reason) => ({ cursors: {}, unavailable: Object.fromEntries(ids.map((id) => [id, reason])) })
  if (!Array.isArray(taskIDs) || taskIDs.some((id) => !nonempty(id) || id !== id.trim())) return fail("resume-invalid-tasks")
  if (!ids.length) return { cursors: {}, unavailable: {} }
  if (signal?.aborted) return fail("aborted")
  if (!["forward", "backward"].includes(direction)) return fail("resume-invalid-direction")
  if (![sessionID, messageID, callID].every(nonempty)) return fail("resume-boundary-unavailable")
  const pending = new Set(ids)
  const unanchored = new Set()
  const cursors = new Map()
  const unavailable = new Map()
  const reject = (id, reason) => { pending.delete(id); unavailable.set(id, reason) }
  const result = () => ({ cursors: Object.fromEntries(cursors), unavailable: Object.fromEntries(unavailable) })
  const seenMessages = new Set()
  const seenPages = new Set()
  let boundarySeen = false
  let before
  let onAbort
  const aborted = Symbol("aborted")
  const interrupted = signal && new Promise((resolve) => {
    onAbort = () => resolve(aborted)
    signal.addEventListener("abort", onAbort, { once: true })
  })

  try {
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      if (signal?.aborted) return fail("aborted")
      let page
      try {
        const reading = store.messagePage(sessionID, { before, limit: 20, signal })
        page = await (interrupted ? Promise.race([reading, interrupted]) : reading)
      } catch {
        return fail(signal?.aborted ? "aborted" : "resume-page-unavailable")
      }
      if (signal?.aborted || page === aborted) return fail("aborted")
      if (page.nextCursor !== undefined) {
        if (!nonempty(page.nextCursor)) return fail("resume-invalid-page")
        if (seenPages.has(page.nextCursor)) return fail("resume-pagination-changed")
        seenPages.add(page.nextCursor)
      }
      for (const message of page.messages) {
        if (!nonempty(message?.info?.id) || message.info.sessionID !== sessionID || !Array.isArray(message.parts)) {
          return fail("resume-invalid-page")
        }
        if (seenMessages.has(message.info.id)) return fail("resume-pagination-changed")
        seenMessages.add(message.info.id)
        for (const part of message.parts) {
          if (!object(part) || (part.sessionID !== undefined && part.sessionID !== sessionID)
            || (part.messageID !== undefined && part.messageID !== message.info.id)) return fail("resume-invalid-page")
        }
      }

      for (let m = page.messages.length - 1; m >= 0; m -= 1) {
        if (signal?.aborted) return fail("aborted")
        const message = page.messages[m]
        const visible = message.info.role === "assistant" && publicValue(message) && publicValue(message.info)
        let end = message.parts.length
        if (!boundarySeen) {
          if (message.info.id !== messageID) continue
          const matches = message.parts.flatMap((part, index) => part.callID === callID ? [index] : [])
          const current = message.parts[matches[0]]
          if (!visible || matches.length !== 1 || current?.type !== "tool" || current.tool !== "o4e_task"
            || !object(current.state) || !["pending", "running", "completed", "error"].includes(current.state.status)
            || !publicValue(current) || !publicValue(current.state)) return fail("resume-boundary-unavailable")
          end = matches[0]
          boundarySeen = true
        }
        if (!visible) continue
        for (let p = end - 1; p >= 0 && pending.size; p -= 1) {
          if (signal?.aborted) return fail("aborted")
          const part = message.parts[p]
          if (part.type !== "tool" || part.tool !== "o4e_task" || !publicValue(part) || !publicValue(part.state)) continue
          const input = part.state?.input
          if (object(input) && ["watch", "status", "output", "input", "pending", "cancel", "resolve", "follow", "permission.reply", "question.reply", "question.reject"].includes(input.action)) continue
          const unknownInput = !object(input) || input.action !== "inspect" || !nonempty(input.taskID)
          // Host pending Parts start with input: {}; interrupted parsing can retain it.
          // Until the action and selector are known, no unresolved Task is proven unrelated.
          if (unknownInput) {
            const status = part.state?.status
            const reason = ["pending", "running", "error"].includes(status) ? `resume-tool-${status}` : "resume-invalid-input"
            for (const id of [...pending]) reject(id, reason)
            continue
          }

          const id = input.taskID.trim()
          if (!pending.has(id)) continue
          if (part.state.status !== "completed") {
            const reason = ["pending", "running", "error"].includes(part.state.status)
              ? `resume-tool-${part.state.status}` : "resume-invalid-output"
            reject(id, reason)
            continue
          }

          if (typeof part.state.output !== "string") {
            reject(id, "resume-invalid-output")
            continue
          }
          if (!hasUnmodifiedToolOutput(part.state)) {
            reject(id, "resume-preview-unavailable")
            continue
          }

          const preview = part.state.metadata?.o4eResult
          if (!object(preview) || preview.taskID !== id) {
            reject(id, "resume-invalid-output")
            continue
          }
          if (!nonempty(part.callID)) {
            reject(id, "resume-preview-unavailable")
          } else if (Object.hasOwn(preview, "gap")) {
            reject(id, "resume-preview-gap")
          } else if (Object.hasOwn(preview, "unavailable") && (preview.unavailable !== "not-dispatched"
            || ["tail", "cursor", "beforeCursor"].some((key) => Object.hasOwn(preview, key)))) {
            reject(id, "resume-preview-unavailable")
          } else if (!nonempty(preview.status)
            || (Object.hasOwn(preview, "tail") && typeof preview.tail !== "string")
            || (Object.hasOwn(preview, "unchanged") && typeof preview.unchanged !== "boolean")
            || ["cursor", "beforeCursor"].some((key) => Object.hasOwn(preview, key) && !validCursor(preview[key]))) {
            reject(id, "resume-invalid-output")
          } else if (!matchesInspectionText(part.state, preview)) {
            // A later hook may rewrite only the body without setting host flags.
            // Metadata cannot acknowledge text that was never publicly delivered.
            reject(id, "resume-preview-unavailable")
          } else if ((preview.unchanged === true || preview.unavailable === "not-dispatched")
            && !["tail", "cursor", "beforeCursor"].some((key) => Object.hasOwn(preview, key))) {
            // Continue only to prove first use, not to reuse an anchor that may
            // have disappeared from the latest execution's public source.
            unanchored.add(id)
          } else {
            const cursor = direction === "backward" ? preview.beforeCursor : preview.cursor
            if (unanchored.has(id) && (preview.cursor !== undefined || preview.beforeCursor !== undefined)) reject(id, "resume-preview-unavailable")
            else if (cursor === undefined) reject(id, direction === "backward" ? "resume-no-earlier" : "resume-no-cursor")
            else { pending.delete(id); cursors.set(id, cursor) }
          }
        }
      }
      if (signal?.aborted) return fail("aborted")
      if (boundarySeen && !pending.size) return result()
      if (page.nextCursor === undefined) {
        if (!boundarySeen) return fail("resume-boundary-unavailable")
        if (direction === "backward") for (const id of pending) reject(id, "resume-no-earlier")
        return result()
      }
      before = page.nextCursor
    }
    for (const id of pending) reject(id, "resume-history-limit")
    return result()
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
