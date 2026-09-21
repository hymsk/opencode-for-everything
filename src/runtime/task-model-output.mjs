import { createHash } from "node:crypto"

const key = "o4eModelOutput"
export const publicValue = (value) => value && !value.synthetic && !value.ignored && !value.private
  && !value.summary && !value.compaction
  && !["summary", "compaction"].includes(value.mode)
  && !["summary", "compaction"].includes(value.agent)
  && (value.visibility === undefined || value.visibility === "public")
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const digest = (action, text, result) => createHash("sha256").update(JSON.stringify(canonical([action, text, result]))).digest("hex")

// Only o4e_task uses this presentation envelope. The native Task/Bash outputs
// and other plugins are untouched. This is integrity checking, not authority.
export function presentTaskResult(result, action, detail) {
  if (detail) return result
  const text = result.output
  if (typeof text !== "string" || Buffer.byteLength(text) > 50 * 1024) throw new Error("O4E_TASK_OUTPUT_TOO_LARGE")
  return { ...result, title: undefined, output: "", metadata: {
    o4eResult: result.metadata.o4eResult,
    ...(result.metadata.kind === "command" ? { kind: "command" } : {}),
    [key]: { version: 1, action, text, digest: digest(action, text, result.metadata.o4eResult) },
  } }
}

// Read a model-visible copy, never mutate a persisted/synced UI Part. Compaction
// and host truncation must remain authoritative: never resurrect pruned output.
export function modelTaskPart(part) {
  if (part?.tool !== "o4e_task" || part.type !== "tool" || part.state?.status !== "completed") return part
  if (!publicValue(part) || !publicValue(part.state)) return part
  const state = part.state
  const envelope = state.metadata?.[key]
  if (envelope === undefined) return part
  if (state.time?.compacted !== undefined || state.metadata?.truncated === true) return part
  if ((state.output !== "" && state.output !== envelope?.text) || envelope?.version !== 1 || typeof envelope.action !== "string"
    || envelope.action !== state.input?.action || typeof envelope.text !== "string"
    || Buffer.byteLength(envelope.text) > 50 * 1024 || !state.metadata.o4eResult
    || envelope.digest !== digest(envelope.action, envelope.text, state.metadata.o4eResult)) {
    throw new Error("O4E_TASK_MODEL_OUTPUT_INVALID")
  }
  return { ...part, state: { ...state, output: envelope.text } }
}

export function restoreTaskModelMessages(messages) {
  for (const message of messages) {
    if (message?.info?.role !== "assistant" || !publicValue(message) || !publicValue(message.info) || !Array.isArray(message.parts)) continue
    message.parts = message.parts.map(modelTaskPart)
  }
}
