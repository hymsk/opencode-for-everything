import fs from "node:fs"
import { dirname } from "node:path"

export function createOutputArchive({ logPath, logFile, logIdentity, logLimitBytes, now, writeLog, syncLog,
  trustedLog, trustedDirectory, activeLogs, incomplete = () => false, stopped = () => false } = {}) {
  let file = logFile
  let identity = logIdentity
  let bytes = 0
  let complete = false
  let error

  function append(chunk) {
    if (file === undefined || error !== undefined || chunk.length === 0) return
    try {
      let end = Math.min(chunk.length, logLimitBytes - bytes)
      while (end > 0 && end < chunk.length && (chunk[end] & 0xc0) === 0x80) end -= 1
      let offset = 0
      while (offset < end) {
        const written = writeLog(file, chunk, offset, end - offset)
        if (!Number.isInteger(written) || written <= 0 || written > end - offset) throw Object.assign(new Error(), { code: "O4E_COMMAND_LOG_WRITE_STALLED" })
        offset += written
        bytes += written
      }
      if (end < chunk.length) error = "O4E_COMMAND_LOG_CAPACITY_EXCEEDED"
    } catch (cause) { error = cause?.code ?? "O4E_COMMAND_LOG_WRITE_FAILED" }
  }

  function markIncomplete(reason = "O4E_COMMAND_LOG_CAPTURE_INCOMPLETE") {
    error ??= reason
  }

  function finalize({ stopped: settled = stopped(), incomplete: capturedIncomplete = incomplete() } = {}) {
    if (capturedIncomplete) markIncomplete()
    try {
      if (file === undefined && settled && activeLogs.has(logPath)) file = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      if (file === undefined) return
      const opened = fs.fstatSync(file)
      const current = fs.lstatSync(logPath)
      if (!trustedLog(logPath) || !trustedDirectory(dirname(logPath)) || !trustedDirectory(dirname(dirname(logPath)))) throw Object.assign(new Error(), { code: "O4E_COMMAND_LOG_FILE_UNTRUSTED" })
      if (opened.dev !== identity.dev || opened.ino !== identity.ino || current.dev !== opened.dev || current.ino !== opened.ino || opened.size !== bytes || current.size !== bytes) throw Object.assign(new Error(), { code: "O4E_COMMAND_LOG_FILE_CHANGED" })
      const settledAt = new Date(now())
      fs.futimesSync(file, settledAt, settledAt)
      syncLog(file)
      const verified = fs.fstatSync(file)
      if (verified.size !== bytes) throw Object.assign(new Error(), { code: "O4E_COMMAND_LOG_FILE_CHANGED" })
      fs.closeSync(file); file = undefined
      complete = !capturedIncomplete && settled && error === undefined
    } catch (cause) {
      error ??= cause?.code ?? "O4E_COMMAND_LOG_FINALIZE_FAILED"
      try { fs.closeSync(file) } catch {}
      file = undefined
    } finally { if (settled) activeLogs.delete(logPath) }
  }

  return {
    append,
    markIncomplete,
    finalize,
    snapshot: () => ({ logBytes: bytes, logComplete: complete, ...(error === undefined ? {} : { logError: error }) }),
  }
}
