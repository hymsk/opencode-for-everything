import { Effect } from "effect"
import { OUTPUT_LIMITS, truncateUtf8Head } from "../../runtime/output-limits.mjs"

function unwrap(result) {
  if (result?.error !== undefined || result?.response?.status >= 400) throw new Error("O4E_COMMAND_CARD_TRANSPORT_FAILED")
  return result?.data ?? result
}

/** A best-effort display observer. It never changes the command or model result. */
export function createCommandCard({ client, directory, context, title, taskID,
  intervalMs = 250, requestTimeoutMs = 2000, settleTimeoutMs = 5000, maxOutputBytes = OUTPUT_LIMITS.shellCardBytes }) {
  let chunks = []
  let bytes = 0
  let incomplete = false
  let revision = 0
  let publishedRevision = -1
  let detached = false
  let finished = false
  let closed = false
  let publishing = false
  let timer
  let deadline
  let activeRequest
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  const output = () => chunks.join("") + (incomplete
    ? `\n[O4E UI output incomplete: ${maxOutputBytes} byte limit reached; use the command log.]` : "")
  const dispose = (reason = "disposed") => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    clearTimeout(deadline)
    activeRequest?.abort()
    chunks = []
    resolveDone({ reason })
  }
  const schedule = () => {
    if (closed || timer || publishing) return
    timer = setTimeout(() => {
      timer = undefined
      void publish()
    }, intervalMs)
    timer.unref?.()
  }
  const request = async (operation) => {
    const controller = new AbortController()
    activeRequest = controller
    let timeout
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error("O4E_COMMAND_CARD_TIMEOUT"))
          }, requestTimeoutMs)
          timeout.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timeout)
      if (activeRequest === controller) activeRequest = undefined
    }
  }
  const publish = async () => {
    if (closed || publishing) return
    publishing = true
    const currentRevision = revision
    const visible = output()
    let published = false
    try {
      if (!detached) {
        await request(async (signal) => {
          const update = context.metadata?.({ title, metadata: { output: visible, ...(taskID ? { taskID } : {}) } })
          return Effect.isEffect(update) ? Effect.runPromise(update, { signal }) : update
        })
        // A pending metadata publication cannot stand in for the completed Part.
        published = !detached
      } else if (taskID) {
        const message = unwrap(await request((signal) => client.session.message({
          path: { id: context.sessionID, messageID: context.messageID }, query: { directory }, signal,
        })))
        if (closed) return
        const part = message?.parts?.find((part) => part?.type === "tool" && part.tool === "bash"
          && part.sessionID === context.sessionID && part.messageID === context.messageID && part.callID === context.callID)
        if (!part) return
        if (part.state?.time?.compacted) return dispose("compacted")
        if (part.state?.status !== "completed") return
        if (part.state.metadata?.taskID !== taskID) return dispose("source-mismatch")
        if (part.state.metadata.output !== visible) {
          const updated = { ...part, state: { ...part.state, metadata: { ...part.state.metadata, output: visible } } }
          const path = `/session/${encodeURIComponent(context.sessionID)}/message/${encodeURIComponent(context.messageID)}/part/${encodeURIComponent(part.id)}`
          unwrap(await request((signal) => client._client.request({
            url: `${path}?directory=${encodeURIComponent(directory)}`, method: "PATCH", body: updated,
            bodySerializer: JSON.stringify, headers: { "Content-Type": "application/json" }, signal,
          })))
        }
        published = true
      }
    } catch {
      // Display failures must never affect execution, admission, or lock release.
    } finally {
      publishing = false
      if (published) publishedRevision = currentRevision
      if (closed) return
      if (finished && detached && publishedRevision === revision) dispose("published")
      else if (publishedRevision !== revision) schedule()
    }
  }
  const setTaskID = (value) => { taskID = value }
  const settleDeadline = () => {
    if (!finished || !detached || deadline) return
    deadline = setTimeout(() => dispose("unpublished"), settleTimeoutMs)
    deadline.unref?.()
  }
  const detach = (result) => {
    if (closed) return
    if (result?.taskID) setTaskID(result.taskID)
    if (!detached) {
      detached = true
      publishedRevision = -1
    }
    settleDeadline()
    schedule()
  }
  const finish = (result) => {
    if (closed || finished) return
    finished = true
    if (result?.taskID) setTaskID(result.taskID)
    settleDeadline()
    schedule()
  }
  const append = (text) => {
    if (closed || finished || !text || incomplete) return
    const remaining = Math.max(0, maxOutputBytes - bytes)
    const bounded = truncateUtf8Head(text, remaining)
    if (bounded.text) chunks.push(bounded.text)
    bytes += Buffer.byteLength(bounded.text)
    incomplete = bounded.truncated
    revision++
    schedule()
  }
  schedule()
  return { append, detach, finish, dispose, setTaskID, output, metadata: () => ({ output: output() }), done }
}
