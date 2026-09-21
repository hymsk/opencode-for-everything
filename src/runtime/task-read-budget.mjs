export const TASK_READ_IO_TIMEOUT_MS = 10_000
export const WATCH_MAX_TIMEOUT_MS = 3_600_000
const validCursor = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 512

export const taskWatchTimeoutMs = (timeoutMs) => timeoutMs > 0 ? Math.min(timeoutMs, WATCH_MAX_TIMEOUT_MS) : 1_800_000

export function validateTaskReadOptions(args) {
  if (args?.taskIDs !== undefined && args.action !== "watch") throw new Error("taskIDs is watch only")
  if (args?.cursors !== undefined || args?.reread !== undefined) throw new Error("cursors and reread are not supported; watch returns states, output reads content")
  if (args?.ioTimeoutMs !== undefined && !["inspect", "watch"].includes(args.action)) throw new Error("ioTimeoutMs is inspect/watch only")
  if (args?.resume !== undefined && typeof args.resume !== "boolean") throw new Error("resume must be boolean")
  if (args?.resume && (args.cursor !== undefined || args.cursors !== undefined)) throw new Error("resume cannot be combined with cursor/cursors")
  if (args?.ioTimeoutMs !== undefined && (!Number.isSafeInteger(args.ioTimeoutMs) || args.ioTimeoutMs < 1 || args.ioTimeoutMs > 60_000)) {
    throw new Error("ioTimeoutMs must be an integer in 1..60000")
  }
  for (const key of ["cursor", "direction", "maxBytes", "resume"]) {
    if (args?.[key] !== undefined && args.action !== "inspect") throw new Error(`${args.action}.${key} is inspect only`)
  }
  for (const key of ["timeoutMs"]) {
    if (args?.[key] !== undefined && args.action !== "watch") throw new Error(`${args.action}.${key} is watch only`)
  }
  if (args?.action === "inspect") {
    if (typeof args.taskID !== "string" || !args.taskID.trim()) throw new Error("inspect requires taskID")
    if (args.taskIDs !== undefined) throw new Error("inspect does not accept taskIDs")
    if (args.cursor !== undefined && !validCursor(args.cursor)) throw new Error("inspect.cursor must be a nonempty string of at most 512 characters")
    if (args.direction !== undefined && !["forward", "backward"].includes(args.direction)) throw new Error("inspect.direction must be forward or backward")
    if (args.maxBytes !== undefined && (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 4 || args.maxBytes > 8192)) {
      throw new Error("inspect.maxBytes must be a safe integer in 4..8192")
    }
  }
  if (args?.action === "watch") {
    if (args.taskID !== undefined && (typeof args.taskID !== "string" || !args.taskID.trim())) throw new Error("watch.taskID must be a nonempty string")
    if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 0)) throw new Error("watch.timeoutMs must be a nonnegative safe integer")
  }
}

// Cancel the reader's wait, not shared recovery or an admitted receipt commit.
export function createTaskReadBudget(args, context) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, ...(context.abort ? [context.abort] : [])])
  const window = args.action === "watch" ? taskWatchTimeoutMs(args.timeoutMs) : 0
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("o4e_task read deadline exceeded; Task execution is unchanged"), {
    name: "TaskReadTimeoutError",
  })), window + (args.ioTimeoutMs ?? TASK_READ_IO_TIMEOUT_MS))
  let committed = false
  return {
    context: {
      ...context,
      abort: signal,
      readWait: async (operation) => {
        signal.throwIfAborted()
        let onAbort
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener("abort", onAbort, { once: true })
        })
        try {
          const result = await Promise.race([Promise.resolve().then(() => {
            signal.throwIfAborted()
            return operation()
          }), aborted])
          signal.throwIfAborted()
          return result
        } finally { signal.removeEventListener("abort", onAbort) }
      },
      readCommit: () => {
        signal.throwIfAborted()
        committed = true
        clearTimeout(timer)
      },
    },
    get committed() { return committed },
    close: () => clearTimeout(timer),
  }
}
