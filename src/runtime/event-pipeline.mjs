export async function runEventPipeline(event, { fallback, taskObserver }) {
  if (event.kind === "deleted") fallback?.deleteSession(event.sessionID)
  if (event.kind !== "error" || !event.sessionID) {
    await taskObserver?.(event)
    return null
  }
  const modelError = fallback?.describeError?.(event.sessionID, event.error)
  await taskObserver?.({ ...event, phase: "before-resolution", ...(modelError ? { modelError } : {}) })
  return null
}
