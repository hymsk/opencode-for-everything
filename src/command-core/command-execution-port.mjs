import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { setTimeout as delay } from "node:timers/promises"
import { canonicalDirectoryKey } from "../runtime/directory-key.mjs"
import { OUTPUT_LIMITS, utf8Window } from "../runtime/output-limits.mjs"
import { resolveShellProfile } from "./shell-profile.mjs"
import { KILL_GRACE, TERM_GRACE, createProcessTreeController, processStat, stopWindowsProcessTree } from "./process-tree.mjs"
import { createOutputArchive } from "./output-archive.mjs"

const LOG_RETENTION_MS = 24 * 60 * 60 * 1000
const CLOSE_GRACE = 1000
const EXECUTIONS = Symbol.for("opencode-for-everything.command-executions.v1")
const directories = globalThis[EXECUTIONS] ??= new Map()
const ACTIVE_LOGS = Symbol.for("opencode-for-everything.command-active-logs.v1")
const activeLogs = globalThis[ACTIVE_LOGS] ??= new Set()

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function trustedDirectory(path) {
  const stat = fs.lstatSync(path)
  // Windows does not expose POSIX ownership/mode bits. The directory is
  // created below the per-user temporary root and symlink checks still apply;
  // POSIX ownership/mode checks remain mandatory on Unix.
  if (process.platform === "win32") return stat.isDirectory() && !stat.isSymbolicLink()
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (stat.mode & 0o077) === 0 && (stat.mode & 0o700) === 0o700
}

function trustedLog(path) {
  const stat = fs.lstatSync(path)
  if (process.platform === "win32") return stat.isFile() && !stat.isSymbolicLink()
  return stat.isFile() && !stat.isSymbolicLink()
    && (typeof process.getuid !== "function" || stat.uid === process.getuid())
    && (stat.mode & 0o077) === 0 && (stat.mode & 0o600) === 0o600
}

function canonicalLogRoot(root, workspaces) {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw failure("O4E_COMMAND_LOG_DIRECTORY_UNTRUSTED")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  root = canonicalDirectoryKey(root)
  if (workspaces.some((workspace) => root === workspace
    || root.startsWith(workspace.endsWith(sep) ? workspace : `${workspace}${sep}`))) {
    throw failure("O4E_COMMAND_LOG_DIRECTORY_IN_WORKSPACE")
  }
  return root
}

function prepareLogDirectory(root, now, workspaces) {
  // Resolve existing ancestors before creating anything: TMPDIR or an injected
  // root may contain symlinks back into the workspace.
  root = canonicalLogRoot(root, workspaces)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (!trustedDirectory(root)) throw failure("O4E_COMMAND_LOG_DIRECTORY_UNTRUSTED")
  // Keep the directory name shape stable for lazy cleanup; Windows has no
  // process start tick, so `0` is a local sentinel and is never used for
  // identity or signalling.
  // macOS has no portable, race-free process start identity exposed by Node.
  // Use a non-identity marker there and keep cleanup conservative.
  const self = process.platform === "win32" || process.platform === "darwin" ? { start: "0" }
    : processStat("/proc/self/stat")
  if (!self) throw failure("O4E_COMMAND_PROCESS_UNVERIFIABLE")
  const processDirectory = resolve(root, `${process.pid}-${self.start}`)
  fs.mkdirSync(processDirectory, { recursive: true, mode: 0o700 })
  if (!trustedDirectory(processDirectory)) throw failure("O4E_COMMAND_LOG_DIRECTORY_UNTRUSTED")
  const cutoff = now() - LOG_RETENTION_MS
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+-\d+$/.test(entry.name)) continue
    const directory = resolve(root, entry.name)
    try {
      if (!trustedDirectory(directory)) continue
      const [pidText, start] = entry.name.split("-")
      const live = process.platform === "darwin" || process.platform === "win32"
        ? undefined : processStat(`/proc/${pidText}/stat`)
      if (live?.start === start && directory !== processDirectory) continue
      for (const name of fs.readdirSync(directory)) {
        if (!/^command-[a-f0-9-]+\.log$/.test(name)) continue
        const path = resolve(directory, name)
        if (activeLogs.has(path) || !trustedLog(path) || fs.lstatSync(path).mtimeMs >= cutoff) continue
        fs.unlinkSync(path)
      }
      if (directory !== processDirectory && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
    } catch { /* Cleanup is best-effort and never broadens the trusted deletion set. */ }
  }
  return processDirectory
}

/**
 * Runtime must persist its execution claim before start; this port never respawns.
 * Uses an injected host Shell profile, no PTY. The host must pass the same shell
 * selection to authorization and this port. Inherit the process environment
 * at launch, as native Bash does. The public plugin API cannot dispatch shell.env
 * hooks belonging to other plugins.
 * Stop evidence covers only the owned
 * process group, NOT an OS sandbox: descendants escaping with setsid/setpgid are
 * outside that proof. No PID adoption or persisted handles after host restart.
 * Retained output is bounded in memory. A short-lived UTF-8 text log is created
 * before spawn in a user-only directory and records the two pipe callbacks in
 * observer order; per-stream decoding does not claim a kernel-level fd total
 * order or binary fidelity. SHA-256 covers raw stdout/stderr chunks in callback
 * order. Callers own output and log-path authorization.
 * timeout is an execution deadline in milliseconds (default 120000). done and
 * cancel resolve snapshots, including failures; dispose rejects unconfirmed stop.
 * done is the first settlement only. After unknown/unconfirmed stop, cancel and
 * dispose retry stop evidence/signals, not execution; snapshot/onUpdate reflect it.
 * Output loss never prevents stopped evidence and never gains a complete hash.
 */
export function createCommandExecutionPort({ directory = process.cwd(), projectRoot = directory, shell,
  logRoot = resolve(tmpdir(), `opencode-for-everything-${typeof process.getuid === "function" ? process.getuid() : "user"}-command-logs`),
  logLimitBytes = OUTPUT_LIMITS.logBytes, now = () => Date.now(), logIO = {} } = {}) {
  const shellProfile = resolveShellProfile(shell)
  const processTree = createProcessTreeController({ signal: (...args) => process.kill(...args) })
  let key
  let projectKey
  try {
    key = canonicalDirectoryKey(directory)
    projectKey = canonicalDirectoryKey(projectRoot)
    if (process.platform === "linux" && !processStat("/proc/self/stat")) throw failure("O4E_COMMAND_PROCESS_UNVERIFIABLE")
  } catch {
    throw failure("O4E_COMMAND_INVALID_DIRECTORY_OR_PROC")
  }
  if (typeof logRoot !== "string" || !isAbsolute(logRoot) || logRoot.includes("\0")
    || !Number.isSafeInteger(logLimitBytes) || logLimitBytes < 1 || typeof now !== "function"
    || logIO === null || typeof logIO !== "object"
    || (logIO.writeSync !== undefined && typeof logIO.writeSync !== "function")
    || (logIO.fsyncSync !== undefined && typeof logIO.fsyncSync !== "function")) {
    throw failure("O4E_COMMAND_INVALID_LOG_OPTIONS")
  }
  // Narrow, construction-time I/O seam for deterministic disk failure tests.
  const writeLog = logIO.writeSync ?? fs.writeSync
  const syncLog = logIO.fsyncSync ?? fs.fsyncSync
  let records = directories.get(key)
  if (!records) directories.set(key, records = new Map())
  const owned = new Set()
  let closed = false

  function start({ executionID, command, cwd = key, timeout = 120000, onUpdate, onOutput } = {}) {
    if (closed) throw failure("O4E_COMMAND_PORT_DISPOSED")
    if (typeof executionID !== "string" || !executionID.trim()
      || typeof command !== "string" || command.includes("\0")
      || typeof cwd !== "string" || !cwd || cwd.includes("\0")
      || !Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647
      || (onUpdate !== undefined && typeof onUpdate !== "function")
      || (onOutput !== undefined && typeof onOutput !== "function")) {
      throw failure("O4E_COMMAND_INVALID_ARGUMENTS")
    }
    // Reject even identical duplicates. get() is the explicit reattachment path.
    if (records.has(executionID)) throw failure("O4E_COMMAND_EXECUTION_EXISTS")
    cwd = resolve(key, cwd)
    let child
    let identity
    let groupGone = false
    let launched = false
    let finished = false
    let stopping
    let resolveStop
    let ioFailed = false
    let exitCode
    let exitSeen = false
    let status = "running"
    let reason
    let stopped = false
    let sha256
    let totalBytes = 0
    let textBytes = 0
    let head = Buffer.alloc(0)
    let tail = Buffer.alloc(0)
    let incomplete = false
    let logPath
    let logFile
    let logIdentity
    let logBytes = 0
    let logComplete = false
    let logError
    try {
      const logDirectory = prepareLogDirectory(logRoot, now, [key, projectKey])
      logPath = resolve(logDirectory, `command-${randomUUID()}.log`)
      logFile = fs.openSync(logPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      if (!trustedLog(logPath)) throw failure("O4E_COMMAND_LOG_FILE_UNTRUSTED")
      logIdentity = fs.fstatSync(logFile)
      activeLogs.add(logPath)
    } catch (error) {
      if (logFile !== undefined) try { fs.closeSync(logFile) } catch {}
      logFile = undefined
      logError = error?.code ?? "O4E_COMMAND_LOG_CREATE_FAILED"
    }
    const hash = createHash("sha256")
    const archive = createOutputArchive({ logPath, logFile, logIdentity, logLimitBytes, now, writeLog, syncLog,
      trustedLog, trustedDirectory, activeLogs, incomplete: () => incomplete, stopped: () => stopped })
    let resolveDone
    const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })
    let resolveExit
    const exit = new Promise((resolvePromise) => { resolveExit = resolvePromise })
    const reads = []
    const snapshot = () => Object.freeze({
      status,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(reason === undefined ? {} : { reason }),
      output: status === "running" || textBytes <= OUTPUT_LIMITS.executionViewBytes
        ? utf8Window(tail, OUTPUT_LIMITS.executionViewBytes, true)
        : utf8Window(head, OUTPUT_LIMITS.executionViewBytes / 2) + utf8Window(tail, OUTPUT_LIMITS.executionViewBytes / 2, true),
      totalBytes,
      truncated: incomplete || totalBytes > OUTPUT_LIMITS.executionViewBytes || textBytes > OUTPUT_LIMITS.executionViewBytes,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(logPath === undefined ? {} : { logPath }),
      logBytes,
      logComplete,
      ...(logError === undefined ? {} : { logError }),
      stopped,
    })
    let updateQueued = false
    let updating = false
    let updatePending = false
    function notify() {
      updatePending = true
      if (!onUpdate || updateQueued || updating) return
      updateQueued = true
      setImmediate(async () => {
        updateQueued = false
        updatePending = false
        updating = true
        try { await onUpdate(snapshot()) } catch { /* Observers cannot control execution. */ }
        updating = false
        if (updatePending) notify()
      })
    }
    function append(text) {
      const bytes = Buffer.from(text)
      // A UI observer sees each decoded chunk, independently of the bounded
      // model view and log storage. It cannot interrupt capture or execution.
      try { onOutput?.(text) } catch { /* Best-effort display. */ }
      textBytes += bytes.length
      if (head.length < OUTPUT_LIMITS.executionViewBytes / 2) {
        head = Buffer.concat([head, bytes.subarray(0, OUTPUT_LIMITS.executionViewBytes / 2 - head.length)])
      }
      tail = bytes.length >= OUTPUT_LIMITS.executionViewBytes
        ? Buffer.from(bytes.subarray(-OUTPUT_LIMITS.executionViewBytes))
        : Buffer.concat([tail.subarray(Math.max(0, tail.length + bytes.length - OUTPUT_LIMITS.executionViewBytes)), bytes])
      archive.append(bytes)
      const archived = archive.snapshot(); logBytes = archived.logBytes; logComplete = archived.logComplete; logError = archived.logError ?? logError
      notify()
    }
    function finalizeLog() {
      archive.finalize({ stopped, incomplete })
      const archived = archive.snapshot(); logBytes = archived.logBytes; logComplete = archived.logComplete; logError = archived.logError ?? logError
    }
    function finish(nextStatus, nextReason, confirmed) {
      if (finished && stopped) return
      const first = !finished
      finished = true
      clearTimeout(deadline)
      if (child) child.spawnargs = []
      status = nextStatus
      reason = nextReason
      stopped = confirmed
      if (first && !incomplete) sha256 = hash.digest("hex")
      finalizeLog()
      const result = snapshot()
      const settleStop = resolveStop
      stopping = undefined
      resolveStop = undefined
      settleStop?.(result)
      if (first) resolveDone(result)
      notify()
    }

    function inspectGroup() {
      if (groupGone) return { stopped: true, signalSafe: false }
      const pid = child?.pid
      if (!identity || !Number.isInteger(pid) || pid <= 1 || pid === process.pid
        || records.get(executionID) !== handle) {
        return { stopped: false, signalSafe: false }
      }
      // Windows has no `/proc` process-group identity and Node does not expose
      // a portable process-group signal. The child handle is the authority for
      // the process we spawned: an observed exit is stopped, otherwise a
      // direct child signal is safe and confirmation comes from the exit event.
      if (process.platform === "win32") {
        if (exitSeen) { groupGone = true; return { stopped: true, signalSafe: false } }
        try {
          process.kill(pid, 0)
          return { stopped: false, signalSafe: true }
        } catch (error) {
          if (error?.code === "ESRCH") { groupGone = true; return { stopped: true, signalSafe: false } }
          return { stopped: false, signalSafe: false }
        }
      }
      if (process.platform === "darwin") {
        try {
          process.kill(-pid, 0)
          return { stopped: false, signalSafe: true }
        } catch (error) {
          if (error?.code === "ESRCH") { groupGone = true; return { stopped: true, signalSafe: false } }
          return { stopped: false, signalSafe: false }
        }
      }
      if (identity.group !== pid || identity.session !== pid) {
        return { stopped: false, signalSafe: false }
      }
      const leaderState = () => {
        const leader = processStat(`/proc/${pid}/stat`)
        return !leader ? "missing"
          : leader.start === identity.start && leader.group === pid && leader.session === pid ? "owned" : "reused"
      }
      let signalSafe = false
      try {
        const leader = leaderState()
        if (leader === "reused") return { stopped: false, signalSafe: false }
        signalSafe = leader === "owned"
        process.kill(-pid, 0)
        let members = 0
        let live = false
        let complete = true
        const entries = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))
        for (const entry of entries) {
          let member
          try { member = processStat(`/proc/${entry}/stat`) } catch {
            // An unreadable PID invalidates the census, not an independently
            // verified group's signal ownership. Keep looking for owned members.
            complete = false
            continue
          }
          if (!member || member.group !== pid) continue
          if (member.session !== pid || BigInt(member.start) < BigInt(identity.start)) return { stopped: false, signalSafe: false }
          members += 1
          if (!["Z", "X"].includes(member.state)) live = true
          else {
            // A zombie main thread can still have live worker threads. Zombies
            // alone cannot execute; PID 1 need not reap orphan zombies promptly.
            try {
              for (const tid of fs.readdirSync(`/proc/${entry}/task`)) {
                const thread = processStat(`/proc/${entry}/task/${tid}/stat`)
                if (thread && !["Z", "X"].includes(thread.state)) live = true
              }
            } catch (error) { if (error?.code !== "ENOENT") complete = false }
          }
        }
        signalSafe = false
        const afterLeader = leaderState()
        if (afterLeader === "reused") return { stopped: false, signalSafe: false }
        signalSafe = afterLeader === "owned" || members > 0
        // Recheck disappearance after the scan; never signal this number again
        // once gone. Start-time checks narrow PID reuse races, not atomic pidfds.
        process.kill(-pid, 0)
        if (!complete || !members || live) return { stopped: false, signalSafe }
        // A forking member can disappear before its stat is read. Do not infer
        // zombie-only stop from a census whose PID set changed during the scan.
        const after = new Set(fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)))
        if (after.size !== entries.length || entries.some((entry) => !after.has(entry))) return { stopped: false, signalSafe }
        groupGone = true
        return { stopped: true, signalSafe: false }
      } catch (error) {
        if (error?.code === "ESRCH") {
          groupGone = true
          return { stopped: true, signalSafe: false }
        }
        return { stopped: false, signalSafe }
      }
    }
    async function stopGroup() {
      for (const [signal, grace] of [["SIGTERM", TERM_GRACE], ["SIGKILL", KILL_GRACE]]) {
        const state = inspectGroup()
        if (state.stopped || !state.signalSafe) return state.stopped
        try {
          if (process.platform === "win32") return await stopWindowsProcessTree(child.pid, { graceMs: TERM_GRACE, isStopped: () => exitSeen })
          if (!processTree.stop(child.pid, signal)) return false
        } catch (error) {
          if (error?.code === "ESRCH") { groupGone = true; return true }
          return false
        }
        const until = performance.now() + grace
        while (true) {
          const current = inspectGroup()
          if (current.stopped || !current.signalSafe) return current.stopped
          const remaining = until - performance.now()
          if (remaining <= 0) break
          await delay(Math.min(50, remaining))
        }
      }
      return false
    }
    async function settle(nextReason) {
      const confirmed = await stopGroup()
      if (!finished) {
        let timer
        const drained = await Promise.race([
          Promise.all([exit, ...reads]).then(() => true),
          new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), CLOSE_GRACE) }),
        ])
        clearTimeout(timer)
        if (!drained || ioFailed || !exitSeen) {
          incomplete = true
          child.stdout.destroy()
          child.stderr.destroy()
        }
      }
      if (!confirmed || incomplete) {
        finish("unknown", !confirmed ? "process-group-unconfirmed" : "output-or-exit-unconfirmed", confirmed)
      } else {
        finish(nextReason === "cancelled" ? "cancelled" : nextReason === undefined ? "completed" : "failed", nextReason, true)
      }
    }
    function stop(nextReason) {
      if (stopping) return stopping
      if (finished && stopped) return Promise.resolve(snapshot())
      const pending = new Promise((resolvePromise) => { resolveStop = resolvePromise })
      stopping = pending
      clearTimeout(deadline)
      if (!launched) finish(nextReason === "cancelled" ? "cancelled" : "failed", nextReason, true)
      else void settle(nextReason).catch(() => {
        incomplete = true
        child.stdout?.destroy()
        child.stderr?.destroy()
        sha256 = undefined
        finish("unknown", "settlement-unconfirmed", groupGone)
      })
      return pending
    }
    const handle = Object.freeze({ executionID, done, snapshot, cancel: () => stop("cancelled") })
    records.set(executionID, handle)
    owned.add(handle)
    const expires = performance.now() + timeout
    const deadline = setTimeout(() => stop("timeout"), timeout)
    // Claim synchronously, spawn on the next microtask so immediate cancellation
    // (including dispose) cannot execute a command that has not started yet.
    queueMicrotask(() => {
      if (!finished && performance.now() >= expires) stop("timeout")
      if (finished) { command = undefined; return }
      launched = true
      try {
        child = shellProfile.direct
          ? spawn(shellProfile.shell, [...shellProfile.args, command], { cwd, env: { ...process.env }, detached: shellProfile.detached, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
          : spawn(command, [], { cwd, env: { ...process.env }, shell: shellProfile.shell, detached: shellProfile.detached, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      } catch {
        finish("failed", "spawn-failed", true)
        command = undefined
        return
      }
      command = undefined
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8")
        let ended = false
        reads.push(new Promise((resolvePromise) => {
          stream.on("data", (bytes) => {
            if (finished) return
            totalBytes += bytes.length
            hash.update(bytes)
            append(decoder.write(bytes))
          })
          stream.once("end", () => { ended = true; if (!finished) append(decoder.end()) })
          stream.once("close", () => { if (!ended) ioFailed = true; resolvePromise() })
          stream.on("error", () => { ioFailed = true; if (!finished) stop("output-error") })
        }))
      }
      child.once("exit", (code) => {
        exitSeen = true
        if (!finished && Number.isInteger(code)) exitCode = code
        resolveExit()
        if (!finished) stop(code === 0 ? undefined : Number.isInteger(code) ? "nonzero-exit" : "signal-exit")
      })
      child.on("error", () => {
        if (!child.pid) finish("failed", "spawn-failed", true)
        else if (!finished) stop("execution-error")
      })
      if (child.pid && process.platform === "linux") {
        try { identity = processStat(`/proc/${child.pid}/stat`) } catch { /* Never signal an unverified group. */ }
        if (!identity) stop("process-identity-unconfirmed")
      } else if (child.pid && process.platform === "darwin") identity = { pid: child.pid, group: child.pid, session: child.pid }
      else if (child.pid) identity = { pid: child.pid }
      notify()
    })
    return handle
  }

  return {
    start,
    get: (executionID) => records.get(executionID),
    cancel: (executionID) => records.get(executionID)?.cancel(),
    async dispose() {
      closed = true
      const results = await Promise.all([...owned].map((handle) => handle.cancel()))
      if (results.some((result) => !result.stopped)) throw failure("O4E_COMMAND_DISPOSE_UNCONFIRMED")
      owned.clear()
      // Keep all shared claims, including terminal and unknown records, for the
      // process lifetime. A new facade must never accidentally respawn an ID.
    },
  }
}
