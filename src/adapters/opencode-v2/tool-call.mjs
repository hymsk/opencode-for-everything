import { createV2PortError } from "./contracts.mjs"

// V2 ToolContext supplies provenance and progress for a *live* call. Neither
// proves user approval nor permits updating the Tool Part after completion.
// Scope the adapter to execute() so callers cannot retain a progress handle.
export async function withV2ToolCall(context, execute) {
  if (typeof execute !== "function"
    || !context || typeof context !== "object"
    || ["sessionID", "agent", "messageID", "id"].some((key) => typeof context[key] !== "string" || !context[key])
    || typeof context.progress !== "function") {
    throw createV2PortError("tool.call", "tool-call-provenance-unavailable")
  }
  let active = true
  const origin = Object.freeze({
    sessionID: context.sessionID,
    agent: context.agent,
    messageID: context.messageID,
    callID: context.id,
  })
  const call = Object.freeze({
    origin,
    signal: context.signal,
    progress(update) {
      if (!active) throw createV2PortError("tool.progress", "tool-call-completed")
      return context.progress(update)
    },
    ask() { throw createV2PortError("authorization.ask", "tool-scoped-host-ask-unavailable") },
    updateOriginalPart() { throw createV2PortError("original-part.update", "original-tool-part-update-unavailable") },
  })
  try {
    return await execute(call)
  } finally {
    active = false
  }
}
