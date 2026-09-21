import { createHash, randomUUID } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { createTaskID } from "../core/background-task-domain.mjs"
import { createSharedBackgroundTaskScheduler } from "./background-task-scheduler.mjs"
import { canonicalDirectoryKey } from "./directory-key.mjs"
import { serial } from "./serial.mjs"
import { sessionO4E } from "./session-store.mjs"
import { createTaskReadBudget, validateTaskReadOptions } from "./task-read-budget.mjs"
import { validateTaskControlArgs } from "./task-control-args.mjs"
import { OUTPUT_LIMITS, utf8Range } from "./output-limits.mjs"
import { assertCommandExecutionPort } from "../command-core/contracts.mjs"

const SHARED = Symbol.for("opencode-for-everything.command-task-runtime.v1")
const directories = globalThis[SHARED] ??= new Map()
const STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "unknown", "interrupted"])
const fields = new Set(["version", "revision", "sequence", "taskID", "kind", "ownerSessionID", "taskSessionID",
  "requesterAgent", "source", "commandHash", "cwd", "timeout", "descriptionHash", "authorizationFingerprint",
  "executionID", "status", "phase", "claim", "stopped", "lockOwner", "parentTaskID", "result"])
const digest = (value) => createHash("sha256").update(value).digest("hex")
const text = (value) => typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
const object = (value) => value && typeof value === "object" && !Array.isArray(value)
const terminal = (record) => !["queued", "running"].includes(record.status)
const safe = (record) => terminal(record) && record.stopped
const failure = (code) => Object.assign(new Error(`O4E_COMMAND_${code}`), { code: `O4E_COMMAND_${code}` })
const callKey = (source) => digest(JSON.stringify([source.sessionID, source.messageID, source.callID]))

async function awaitReader(operation, signal) {
  if (!signal) return await operation
  if (signal.aborted) throw signal.reason ?? failure("READ_ABORTED")
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? failure("READ_ABORTED"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  operation.catch(() => undefined)
  try { return await Promise.race([operation, aborted]) }
  finally { signal.removeEventListener("abort", onAbort) }
}

function portResult(value) {
  if (!object(value) || !["running", "completed", "failed", "cancelled", "unknown"].includes(value.status)
    || typeof value.stopped !== "boolean" || typeof value.output !== "string"
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || typeof value.truncated !== "boolean"
    || (value.exitCode !== undefined && !Number.isInteger(value.exitCode))
    || (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 256))
    || (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.sha256))
    || (value.logPath !== undefined && (typeof value.logPath !== "string" || !isAbsolute(value.logPath) || value.logPath.length > 4096 || value.logPath.includes("\0")))
    || !Number.isSafeInteger(value.logBytes ?? 0) || (value.logBytes ?? 0) < 0
    || typeof (value.logComplete ?? false) !== "boolean"
    || (value.logError !== undefined && (typeof value.logError !== "string" || value.logError.length > 256))
    || (value.logComplete === true && (!value.stopped || value.logPath === undefined || value.logError !== undefined))) throw failure("INVALID_RESULT")
  // A live result cannot also claim that its process has stopped. Conversely,
  // ordinary terminal statuses must carry confirmed stop evidence; unknown is
  // the only status that may truthfully remain unconfirmed.
  if ((value.status === "running" && value.stopped)
    || (["completed", "failed", "cancelled"].includes(value.status) && !value.stopped)) throw failure("INVALID_RESULT")
  const bytes = Buffer.from(value.output)
  return { status: value.status, stopped: value.stopped, output: utf8Range(bytes, 0, Math.min(bytes.length, OUTPUT_LIMITS.executionViewBytes)).value,
    totalBytes: value.totalBytes, truncated: value.truncated || bytes.length > OUTPUT_LIMITS.executionViewBytes,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    ...(value.logPath === undefined ? {} : { logPath: value.logPath }),
    ...(value.logBytes === undefined ? {} : { logBytes: value.logBytes }),
    ...(value.logComplete === undefined ? {} : { logComplete: value.logComplete }),
    ...(value.logError === undefined ? {} : { logError: value.logError }) }
}

// Command ledgers intentionally do not pass through the Agent Task normalizer.
function validate(record, owner, taskID) {
  if (!object(record) || Object.keys(record).some((key) => !fields.has(key))
    || record.version !== 1 || record.kind !== "command" || !/^o4e_command_[a-f0-9]{32}$/.test(taskID)
    || record.taskID !== taskID || record.executionID !== taskID || record.ownerSessionID !== owner
    || !text(owner) || !text(record.requesterAgent) || !text(record.lockOwner)
    || record.taskSessionID !== owner
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1
    || !object(record.source) || Object.keys(record.source).length !== 3
    || record.source.sessionID !== owner || !text(record.source.messageID) || !text(record.source.callID)
    || !/^[a-f0-9]{64}$/.test(record.commandHash) || !/^[a-f0-9]{64}$/.test(record.descriptionHash)
    || !text(record.cwd) || !Number.isInteger(record.timeout) || record.timeout < 1 || record.timeout > 2147483647
    || !STATUSES.has(record.status) || !text(record.phase) || record.phase.length > 128
    || !(record.claim === null || text(record.claim)) || typeof record.stopped !== "boolean"
    || (record.parentTaskID !== undefined && !text(record.parentTaskID))
    || (record.authorizationFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.authorizationFingerprint))
    || (record.status === "queued" && (record.claim !== null || !record.stopped))
    || (record.status === "running" && (record.claim === null || record.stopped))
    || (record.claim === null && !record.stopped)
    || (record.status === "unknown" && record.claim === null)
    || (record.status === "interrupted" && (record.claim !== null || record.phase !== "not-submitted"))
    || (["completed", "failed"].includes(record.status) && (!record.claim || !record.result))
    || (record.status === "cancelled" && record.phase !== "not-submitted" && !record.result)
    || (["completed", "failed", "cancelled"].includes(record.status) && !record.stopped)) throw failure("INVALID_LEDGER")
  if (record.result !== undefined) {
    const result = portResult(record.result)
    if (!isDeepStrictEqual(result, record.result) || result.status !== record.status
      || result.stopped !== record.stopped) throw failure("INVALID_LEDGER")
  }
  return structuredClone(record)
}

function refsOf(o4e) {
  const group = o4e.commandTasks
  if (group === undefined) return {}
  if (!object(group) || group.version !== 1 || !object(group.refs)
    || Object.keys(group).some((key) => !["version", "refs"].includes(key))) throw failure("INVALID_INDEX")
  return group.refs
}

function ownerRefs(session, owner) {
  if (session?.id !== owner) throw failure("INVALID_LEDGER")
  return refsOf(sessionO4E(session))
}

function validateRef(ref, owner, taskID) {
  if (!object(ref) || Object.keys(ref).some((key) => !["taskSessionID", "callKey", "claim", "recovery"].includes(key))) throw failure("INVALID_INDEX")
  const record = validate(ref.recovery, owner, taskID)
  if (ref.taskSessionID !== owner || ref.claim !== record.claim || ref.callKey !== callKey(record.source)) throw failure("INVALID_INDEX")
  return record
}

/** Authorized shell input belongs to the host Bash Part, never to Session metadata.
 * lockOwner/parentTaskID are trusted identity fields, not model-supplied options.
 * lockOwner remains frozen in the ledger but never acquires or borrows a lock.
 * beforeStart is a trusted, non-reentrant async check: resolve to authorize,
 * throw/reject to refuse. It runs once after resource admission, before the claim.
 * The injected execution port must already use the authorized shell.
 * limits is config.backgroundTasks; an injected scheduler must be a dedicated
 * facade configured with those limits, not the Agent Runtime's dispatcher facade.
 * watchSelection supplies owned command states to the shared Task watch loop.
 */
export class CommandTaskRuntime {
  #store
  #execution
  #scheduler
  #directory
  #clock
  #resolver
  #state
  #closed = false
  #disposed = false
  #disposeFailed = false
  #disposals = new Set()
  #readAbort = new AbortController()
  #owned = new Set()
  #operations = new Set()

  constructor({ store, execution, directory, limits, scheduler, clock, inspectionCursorResolver }) {
    this.#store = store
    this.#execution = assertCommandExecutionPort(execution)
    this.#directory = canonicalDirectoryKey(directory)
    this.#scheduler = scheduler ?? createSharedBackgroundTaskScheduler(this.#directory, limits)
    this.#scheduler.setDispatcher?.((taskIDs) => this.#admit(taskIDs))
    this.#clock = clock ?? { setTimeout, clearTimeout }
    this.#resolver = inspectionCursorResolver
    this.#state = directories.get(this.#directory) ?? { queues: new Map(), entries: new Map(), cancelling: new Map() }
    directories.set(this.#directory, this.#state)
  }

  owns(taskID) { return typeof taskID === "string" && /^o4e_command_[a-f0-9]{32}$/.test(taskID) }

  #track(operation) {
    this.#operations.add(operation)
    operation.then(() => this.#operations.delete(operation), () => this.#operations.delete(operation))
    return operation
  }

  #serial(owner, operation) { return this.#track(serial(this.#state.queues, owner, operation)) }

  #entry(record) {
    let entry = this.#state.entries.get(record.taskID)
    if (!entry) {
      entry = { record, listeners: new Set(), controller: new AbortController(), attached: new Set() }
      this.#state.entries.set(record.taskID, entry)
    }
    if (entry.record.ownerSessionID !== record.ownerSessionID) throw failure("OWNER_MISMATCH")
    return entry
  }

  #notify(entry) { for (const listener of [...entry.listeners]) listener() }

  #retain(entry, recovery = false) {
    entry.scheduler ??= this.#scheduler
    if (recovery) entry.scheduler.restoreActive(entry.record)
  }

  #release(entry) {
    if (!safe(entry.record)) return
    entry.error = undefined
    entry.launch = undefined
    this.#notify(entry)
    this.#admit(entry.scheduler?.withdraw(entry.record).admitted ?? [])
  }

  async #index(record, expected) {
    const saved = await this.#store.updateO4E(record.ownerSessionID, (o4e, session) => {
      if (session?.id !== record.ownerSessionID) throw failure("INVALID_LEDGER")
      const refs = refsOf(o4e)
      const ref = refs[record.taskID]
      const current = validateRef(ref, record.ownerSessionID, record.taskID)
      if (!isDeepStrictEqual(current, expected) && !isDeepStrictEqual(current, record)) throw failure("CLAIM_LOST")
      return { ...o4e, commandTasks: { version: 1, refs: { ...refs,
        [record.taskID]: { taskSessionID: record.taskSessionID, callKey: ref.callKey, claim: record.claim, recovery: record } } } }
    })
    // A resolved write alone is not an acknowledgment of this exact transition.
    const confirmed = validateRef(ownerRefs(saved, record.ownerSessionID)[record.taskID], record.ownerSessionID, record.taskID)
    if (!isDeepStrictEqual(confirmed, record)) throw failure("CLAIM_LOST")
  }

  async #write(entry, patch) {
    const current = entry.record
    const next = validate(Object.fromEntries(Object.entries({ ...current, ...patch, revision: current.revision + 1 })
      .filter(([, value]) => value !== undefined)), current.ownerSessionID, current.taskID)
    entry.pendingWrite = next
    // The owner is the sole storage container, never an execution/navigation Session.
    // Keep the expected/next pair on an uncertain response; recovery may confirm it,
    // but must never replay execution or release an unconfirmed resource slot.
    await this.#index(next, current)
    entry.record = next
    entry.pendingWrite = undefined
    entry.error = undefined
    entry.disposeFailed = false
    entry.scheduler?.refresh?.(next)
    this.#notify(entry)
    if (safe(next)) this.#release(entry)
    return next
  }

  start(args, context, { lockOwner, parentTaskID, authorizationFingerprint, beforeStart, onOutput } = {}) {
    if (this.#closed) return Promise.reject(failure("DISPOSED"))
    if (!object(args) || !text(args.command) || !text(context?.sessionID) || !text(context?.messageID)
      || !text(context?.callID) || !text(context.agent ?? context.requesterAgent)
      || (args.cwd !== undefined && !text(args.cwd)) || (args.shell !== undefined && !text(args.shell))
      || (args.description !== undefined && typeof args.description !== "string")
      || (args.timeout !== undefined && (!Number.isInteger(args.timeout) || args.timeout < 1 || args.timeout > 2147483647))
      || (lockOwner !== undefined && !text(lockOwner)) || (parentTaskID !== undefined && !text(parentTaskID))
      || (beforeStart !== undefined && typeof beforeStart !== "function")
      || (onOutput !== undefined && typeof onOutput !== "function")
      || (authorizationFingerprint !== undefined && !text(authorizationFingerprint))) return Promise.reject(failure("INVALID_ARGUMENTS"))
    return this.#serial(context.sessionID, async () => {
      if (this.#closed) throw failure("DISPOSED")
      if (this.#state.cancelling.has(context.sessionID)) throw failure("OWNER_CANCELLING")
      await this.#recover(context.sessionID)
      if (this.#closed) throw failure("DISPOSED")
      if (this.#state.cancelling.has(context.sessionID)) throw failure("OWNER_CANCELLING")
      const source = { sessionID: context.sessionID, messageID: context.messageID, callID: context.callID }
      const commandHash = digest(args.command)
      const cwd = resolve(this.#directory, args.cwd ?? ".")
      const timeout = args.timeout ?? 120000
      const taskID = createTaskID("o4e_command")
      let selected
      const saved = await this.#store.updateO4E(context.sessionID, (o4e, session) => {
        if (session?.id !== context.sessionID) throw failure("INVALID_LEDGER")
        const refs = refsOf(o4e)
        const existing = Object.values(refs).find((ref) => ref.callKey === callKey(source))
        if (existing) {
          selected = validateRef(existing, context.sessionID, existing.recovery.taskID)
          if (selected.commandHash !== commandHash || selected.cwd !== cwd || selected.timeout !== timeout) throw failure("CALL_MISMATCH")
          return o4e
        }
        selected = validate({ version: 1, revision: 1,
          sequence: Object.values(refs).reduce((max, ref) => Math.max(max, ref.recovery.sequence), 0) + 1,
          taskID, kind: "command", ownerSessionID: context.sessionID, taskSessionID: context.sessionID,
          requesterAgent: context.agent ?? context.requesterAgent, source, commandHash, cwd, timeout,
          descriptionHash: digest(args.description ?? ""),
          ...(authorizationFingerprint === undefined ? {} : { authorizationFingerprint: digest(authorizationFingerprint) }),
          executionID: taskID, status: "queued", phase: "queued", claim: null, stopped: true,
          lockOwner: lockOwner ?? taskID, ...(parentTaskID === undefined ? {} : { parentTaskID }) }, context.sessionID, taskID)
        return { ...o4e, commandTasks: { version: 1, refs: { ...refs,
          [taskID]: { taskSessionID: context.sessionID, callKey: callKey(source), claim: null, recovery: selected } } } }
      })
      if (!isDeepStrictEqual(validateRef(ownerRefs(saved, context.sessionID)[selected.taskID], context.sessionID, selected.taskID), selected)) throw failure("CLAIM_LOST")
      const entry = this.#entry(selected)
      if (selected.taskID !== taskID) return this.#snapshot(entry)
      this.#owned.add(entry)
      try {
        if (this.#closed || this.#state.cancelling.has(context.sessionID)) {
          entry.controller.abort(failure("CANCELLED"))
          await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
          return this.#snapshot(entry)
        }
        this.#retain(entry)
        if (this.#closed || entry.controller.signal.aborted || this.#state.cancelling.has(context.sessionID)) {
          entry.controller.abort(failure("CANCELLED"))
          await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
          return this.#snapshot(entry)
        }
        // No caller signal is attached: cancelling a reader must not stop work.
        entry.launch = { command: args.command, cwd, timeout, beforeStart, onOutput }
        entry.runtime = this
        // Closures also work across ESM reloads; private class brands do not.
        entry.dispatch = () => this.#track(this.#dispatch(entry).catch(() => {
          entry.launch = undefined
          entry.error = failure("PERSISTENCE_OR_DISPATCH_FAILED")
          this.#notify(entry)
        }).finally(() => { entry.dispatching = false }))
        const snapshot = this.#snapshot(entry)
        const admitted = this.#scheduler.enqueue(selected)
        setImmediate(() => this.#admit(admitted))
        return snapshot
      } catch (error) {
        entry.error = failure("PERSISTENCE_FAILED")
        throw entry.error
      }
    })
  }

  #admit(taskIDs) {
    for (const taskID of taskIDs) {
      const entry = this.#state.entries.get(taskID)
      // A quarantined runtime (failed disposal) must not start new commands.
      // The entry stays queued until a later dispose performs the
      // authoritative cancellation write; entry.dispatching stays false so
      // that cancellation is never fenced as an in-flight dispatch.
      if (this.#disposeFailed || !entry?.launch || entry.disposeFailed || entry.dispatching || entry.record.claim || entry.controller.signal.aborted) continue
      entry.dispatching = true
      // Command admission is resource-only; Agent and Command writes do not
      // serialize execution through ScopeLockManager.
      entry.dispatch()
    }
  }

  async #dispatch(entry) {
    await this.#serial(entry.record.ownerSessionID, async () => {
      if (this.#closed || entry.controller.signal.aborted || entry.record.status !== "queued") {
        if (entry.record.status === "queued") await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
        this.#release(entry)
        return
      }
      const { beforeStart, ...launch } = entry.launch
      entry.launch = undefined
      try {
        await beforeStart?.()
      } catch {
        await this.#write(entry, { status: "interrupted", phase: "not-submitted", stopped: true })
        return
      }
      if (this.#closed || entry.controller.signal.aborted || this.#state.cancelling.has(entry.record.ownerSessionID)) {
        await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
        return
      }
      await this.#write(entry, { status: "running", phase: "claim-persisted", claim: randomUUID(), stopped: false })
      if (this.#closed || entry.controller.signal.aborted) {
        await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
        return
      }
      // There is deliberately no retry across the claim/start crash window.
      try {
        entry.handle = this.#execution.start({ ...launch, executionID: entry.record.executionID,
          onUpdate: () => this.#notify(entry) })
      } catch {
        entry.handle = this.#execution.get(entry.record.executionID)
        if (!entry.handle) await this.#write(entry, { status: "unknown", phase: "submission-unconfirmed", stopped: false })
      }
      if (entry.handle) this.#attach(entry)
    })
  }

  #attach(entry) {
    if (entry.attached.has(this)) return
    entry.attached.add(this)
    Promise.resolve(entry.handle.done).then((result) => this.#serial(entry.record.ownerSessionID, () => this.#settle(entry, result, { force: true })))
      .catch((error) => {
        // An execution port contract violation must not leave a claimed
        // running ledger forever. Persist conservative unknown state when the
        // failure is local to result validation; persistence failures retain
        // the in-memory diagnostic and resource slot for a later recovery attempt.
        if (error?.code !== "O4E_COMMAND_INVALID_RESULT") {
          entry.error = failure("SETTLEMENT_FAILED")
          this.#notify(entry)
          return
        }
        void this.#serial(entry.record.ownerSessionID, async () => {
          if (safe(entry.record)) { this.#release(entry); return }
          try {
            await this.#write(entry, { status: "unknown", phase: "settlement-unconfirmed", stopped: false, result: undefined })
          } catch {
            entry.error = failure("SETTLEMENT_FAILED")
            this.#notify(entry)
          }
        }).catch(() => {
          entry.error = failure("SETTLEMENT_FAILED")
          this.#notify(entry)
        })
      })
  }

  async #settle(entry, value, { force = false } = {}) {
    // Disposal owns the terminal transition. A process-stop callback may race
    // with the explicit cancellation write; letting it publish `completed`
    // would release the admission slot before disposal has persisted the
    // authoritative cancellation state.
    if (entry.disposePending && !force) return
    let result = portResult(value)
    // done is only the first settlement. A retry can prove stop after unknown;
    // a delayed first result must not overwrite that proof or its partial commit.
    if (!result.stopped && entry.handle) {
      const latest = portResult(entry.handle.snapshot())
      if (latest.stopped) result = latest
    }
    if (result.status === "running") return
    if (safe(entry.record)) { this.#release(entry); return }
    await this.#write(entry, { status: result.stopped ? result.status : "unknown",
      phase: result.stopped ? "stopped" : "stop-unconfirmed", stopped: result.stopped,
      result: { ...result, status: result.stopped ? result.status : "unknown" } })
  }

  recoverSession(context, { resolveDisposal = false } = {}) {
    if (!text(context?.sessionID)) return Promise.reject(failure("OWNER_REQUIRED"))
    return this.#serial(context.sessionID, async () => {
      await this.#recover(context.sessionID, { resolveDisposal })
      return [...this.#state.entries.values()].filter((entry) => entry.record.ownerSessionID === context.sessionID).map((entry) => this.#snapshot(entry))
    })
  }

  // Freeze membership once; every refresh still checks the addressed owner index.
  // This read port never acknowledges results or controls command execution.
  async watchSelection(taskIDs, context) {
    if (this.#closed) throw failure("DISPOSED")
    if (taskIDs !== undefined && (!Array.isArray(taskIDs) || taskIDs.some((id) => !this.owns(id)))) throw failure("TASK_ID_REQUIRED")
    const wait = (operation) => awaitReader(Promise.resolve().then(operation), context.abort)
    const initial = await wait(() => this.recoverSession(context))
    const ids = [...new Set(taskIDs ?? initial.map((task) => task.taskID))]
    const selected = ids.map((id) => this.#state.entries.get(id))
    if (selected.some((entry) => !entry || entry.record.ownerSessionID !== context.sessionID)) throw failure("NOT_OWNED")
    const tasks = async () => {
      if (this.#closed) throw failure("DISPOSED")
      await wait(() => this.recoverSession(context))
      const refs = refsOf(sessionO4E(await wait(() => this.#store.get(context.sessionID))))
      if (ids.some((id) => !Object.hasOwn(refs, id))) throw failure("NOT_OWNED")
      return selected.map((entry) => {
        const { output, ...snapshot } = this.#snapshot(entry)
        return snapshot
      })
    }
    await tasks()
    return { tasks, subscribe: (listener) => {
      const state = () => JSON.stringify(selected.map((entry) => [entry.record.revision, entry.error?.code]))
      let previous = state()
      const changed = () => {
        const next = state()
        if (next === previous) return
        previous = next
        listener()
      }
      for (const entry of selected) entry.listeners.add(changed)
      this.#readAbort.signal.addEventListener("abort", listener, { once: true })
      return () => {
        for (const entry of selected) entry.listeners.delete(changed)
        this.#readAbort.signal.removeEventListener("abort", listener)
      }
    } }
  }

  // The plugin observes only a task it just started. Keep this display listener
  // independent of the original Bash reader and remove it at settlement/disposal.
  observe(taskID, context, listener) {
    const entry = this.#state.entries.get(taskID)
    if (!entry || entry.record.ownerSessionID !== context.sessionID) throw failure("NOT_OWNED")
    const changed = () => {
      try { listener(this.#snapshot(entry)) } catch { /* Display cannot affect lifecycle writes. */ }
    }
    entry.listeners.add(changed)
    return () => entry.listeners.delete(changed)
  }

  async #recover(owner, { resolveDisposal = false } = {}) {
    const refs = ownerRefs(await this.#store.get(owner), owner)
    if ([...this.#state.entries.values()].some((entry) => entry.record.ownerSessionID === owner
      && !Object.hasOwn(refs, entry.record.taskID))) throw failure("INDEX_MISSING")
    const loaded = []
    const calls = new Set()
    for (const [taskID, ref] of Object.entries(refs)) {
      const recovery = validateRef(ref, owner, taskID)
      if (calls.has(ref.callKey)) throw failure("INVALID_INDEX")
      calls.add(ref.callKey)
      const entry = this.#entry(recovery)
      const previous = entry.record
      if (["lockOwner", "parentTaskID", "sequence", "requesterAgent", "commandHash", "cwd", "timeout", "descriptionHash", "authorizationFingerprint"]
        .some((key) => recovery[key] !== previous[key])
        || callKey(recovery.source) !== callKey(previous.source) || recovery.revision < previous.revision
        || (previous.claim && recovery.claim !== previous.claim)
        || (recovery.revision === previous.revision && !isDeepStrictEqual(recovery, previous))
        || (entry.pendingWrite && !isDeepStrictEqual(recovery, previous) && !isDeepStrictEqual(recovery, entry.pendingWrite)
          && !(previous.status === "queued" && recovery.claim === null && safe(recovery) && recovery.phase === "not-submitted"))) throw failure("INVALID_LEDGER")
      if (!entry.runtime) this.#owned.add(entry)
      // Restore every uncertain resource slot before querying any execution.
      if (recovery.claim && !safe(recovery)) this.#retain(entry, true)
      loaded.push({ entry, record: recovery })
    }
    for (const { entry, record } of loaded) {
      entry.record = record
      entry.pendingWrite = undefined
      if (safe(record)) { this.#release(entry); continue }
      // A previous dispose stopped the process but failed to persist the
      // terminal transition. Keep the uncertain resource occupied until a
      // resolving recovery (resume) or a later dispose retries the
      // authoritative cancellation write.
      if (entry.disposeFailed && !resolveDisposal) continue
      if ((this.#closed || this.#state.cancelling.has(owner)) && !record.claim) {
        entry.controller.abort(failure("CANCELLED"))
        entry.launch = undefined
        await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
        continue
      }
      if (entry.launch || (entry.dispatching && !record.claim && entry.runtime)) continue
      if (!record.claim) {
        await this.#write(entry, { status: "interrupted", phase: "not-submitted", stopped: true })
        continue
      }
      entry.handle = this.#execution.get(record.executionID)
      if (entry.handle) {
        this.#attach(entry)
        await this.#settle(entry, entry.handle.snapshot(), { force: resolveDisposal })
      } else if (record.status !== "unknown" || record.phase !== "handle-missing") {
        await this.#write(entry, { status: "unknown", phase: "handle-missing", stopped: false, result: undefined })
      }
    }
  }

  #snapshot(entry) {
    const record = entry.record
    const output = entry.handle ? portResult(entry.handle.snapshot()) : record.result
    const { result: _result, ...snapshot } = structuredClone(record)
    return { ...snapshot, ...(output ? { output: output.output, totalBytes: output.totalBytes,
      truncated: output.truncated, ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
      ...(output.sha256 === undefined ? {} : { sha256: output.sha256 }),
      ...(output.reason === undefined ? {} : { reason: output.reason }),
      ...(output.logPath === undefined ? {} : { logPath: output.logPath }),
      logBytes: output.logBytes, logComplete: output.logComplete,
      ...(output.logError === undefined ? {} : { logError: output.logError }) } : {}),
      ...(entry.error ? { diagnostic: entry.error.code } : {}) }
  }

  async #cancel(entry, stopping, knownOnly = false, { force = false } = {}) {
    entry.controller.abort(failure("CANCELLED"))
    entry.launch = undefined
    const handle = await this.#serial(entry.record.ownerSessionID, async () => {
      if (safe(entry.record)) { this.#release(entry); return }
      if (!entry.record.claim) {
        await this.#write(entry, { status: "cancelled", phase: "not-submitted", stopped: true })
        return
      }
      const found = knownOnly ? entry.handle : this.#execution.get(entry.record.executionID)
      if (!found) {
        await this.#write(entry, { status: "unknown", phase: "cancel-unconfirmed", stopped: false, result: undefined })
        return
      }
      entry.handle = found
      return found
    })
    if (handle) {
      const result = await (stopping ?? this.#bounded(Promise.resolve().then(() => handle.cancel()), 10000))
      await this.#serial(entry.record.ownerSessionID, () => this.#settle(entry, result, { force }))
    }
    return this.#snapshot(entry)
  }

  // Trusted lifecycle API only. Select from memory, never recover/discover tasks
  // or use this path as public tool authorization. Only selected queues are fenced.
  async cancelKnown(sessionID, taskID) {
    if (!text(sessionID)) throw failure("OWNER_REQUIRED")
    if (taskID !== undefined && !text(taskID)) throw failure("INVALID_ARGUMENTS")
    const entries = [...this.#state.entries.values()].filter((entry) =>
      (entry.record.ownerSessionID === sessionID || entry.record.taskSessionID === sessionID)
      && (taskID === undefined || entry.record.taskID === taskID))
    if (entries.length === 0) return []
    for (const entry of entries) {
      entry.controller.abort(failure("CANCELLED"))
      entry.launch = undefined
    }
    const stopping = entries.map((entry) => {
      const handle = entry.handle
      if (!handle || safe(entry.record)) return undefined
      try { return this.#track(Promise.resolve(handle.cancel())) }
      catch (error) { return this.#track(Promise.reject(error)) }
    })
    const cancelling = this.#track((async () => {
      const settled = await Promise.allSettled(entries.map((entry, index) => this.#track((async () => {
        // Await each raw stop independently; a stuck sibling cannot suppress it.
        await stopping[index]
        return this.#cancel(entry, stopping[index], true)
      })())))
      const rejected = settled.find((result) => result.status === "rejected")
      if (rejected) throw rejected.reason
      const results = settled.map((result) => result.value)
      if (results.some((result) => !result.stopped || result.diagnostic)) throw failure("CANCEL_UNCONFIRMED")
      return results
    })())
    // Keep actual stops and persistence tracked after the caller's deadline.
    return this.#bounded(cancelling, 10000)
  }

  async cancelOwned(sessionID) {
    if (!text(sessionID)) throw failure("OWNER_REQUIRED")
    this.#state.cancelling.set(sessionID, (this.#state.cancelling.get(sessionID) ?? 0) + 1)
    const stopping = new Map()
    for (const entry of this.#state.entries.values()) {
      if (entry.record.ownerSessionID !== sessionID) continue
      entry.controller.abort(failure("CANCELLED"))
      entry.launch = undefined
      // Stop known handles before touching the store, even if its Session is gone.
      const handle = entry.handle
      if (handle && !safe(entry.record)) stopping.set(entry,
        this.#track(this.#bounded(Promise.resolve().then(() => handle.cancel()), 10000)))
    }
    const stopped = Promise.allSettled(stopping.values())
    const cancelling = this.#track((async () => {
      try {
        const attempts = await stopped
        await this.recoverSession({ sessionID })
        const entries = [...this.#state.entries.values()].filter((entry) => entry.record.ownerSessionID === sessionID)
        const settled = await Promise.allSettled(entries.map((entry) => this.#track(this.#cancel(entry, stopping.get(entry)))))
        const rejected = [...attempts, ...settled].find((result) => result.status === "rejected")
        if (rejected) throw rejected.reason
        const results = settled.map((result) => result.value)
        if (results.some((result) => !result.stopped || result.diagnostic)) throw failure("CANCEL_UNCONFIRMED")
        return results
      } finally {
        const count = this.#state.cancelling.get(sessionID) - 1
        if (count) this.#state.cancelling.set(sessionID, count)
        else this.#state.cancelling.delete(sessionID)
      }
    })())
    return this.#bounded(cancelling, 10000)
  }

  async #bounded(operation, timeout) {
    let timer
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = this.#clock.setTimeout(() => reject(failure("WAIT_TIMEOUT")), timeout)
      })])
    } finally { this.#clock.clearTimeout(timer) }
  }

  async dispose() {
    if (this.#disposed) return
    this.#closed = true
    this.#readAbort.abort(failure("DISPOSED"))
    const owned = [...this.#owned]
    for (const entry of owned) {
      entry.disposePending = true
      entry.controller.abort(failure("DISPOSED"))
      entry.launch = undefined
    }
    // Stop known live processes even if the store is unavailable. Persistence
    // failures still retain resource slots and make disposal fail/retryable.
    const stopping = Promise.allSettled(owned.filter((entry) => entry.handle && !safe(entry.record))
      .map((entry) => this.#bounded(Promise.resolve().then(() => entry.handle.cancel()), 10000)))
    const work = (async () => {
      const attempts = await stopping
      await Promise.allSettled([...this.#operations])
      for (const sessionID of new Set([...this.#owned].map((entry) => entry.record.ownerSessionID))) {
        await this.recoverSession({ sessionID })
      }
      const settled = await Promise.allSettled([...this.#owned].map((entry) => this.#track(this.#cancel(entry, undefined, false, { force: true }))))
      await Promise.allSettled([...this.#operations])
      const rejected = [...attempts, ...settled].find((result) => result.status === "rejected")
      if (rejected) throw rejected.reason
      const results = settled.map((result) => result.value)
      if (results.some((result) => !result.stopped || result.diagnostic)) throw failure("DISPOSE_UNCONFIRMED")
    })()
    this.#disposals.add(work)
    work.then(() => this.#disposals.delete(work), () => this.#disposals.delete(work))
    try {
      await this.#bounded(work, 10000)
      this.#scheduler.dispose?.()
      this.#disposed = true
    } catch (error) {
      for (const entry of owned) entry.disposeFailed = true
      this.#disposeFailed = true
      throw error
    }
  }

  resume() {
    if (this.#disposed) throw failure("DISPOSED")
    if (!this.#closed || !this.#disposeFailed) throw failure("RESUME_UNAVAILABLE")
    if (this.#disposals.size > 0) throw failure("DISPOSE_PENDING")
    // Reopen only this facade. Old controllers, claims and admissions stay fenced.
    this.#readAbort = new AbortController()
    this.#closed = false
    // Resolve the failed disposal: retry owner persistence for every uncertain
    // entry. Success lifts the quarantine and reopens admission; failure keeps
    // it, so new commands stay queued until a later dispose performs the
    // authoritative cancellation write.
    const resolution = this.#track((async () => {
      for (const sessionID of new Set([...this.#owned].map((entry) => entry.record.ownerSessionID))) {
        await this.recoverSession({ sessionID }, { resolveDisposal: true })
      }
      for (const entry of this.#owned) entry.disposeFailed = false
      this.#disposeFailed = false
      this.#admit([...this.#state.entries.keys()])
    })())
    return resolution.catch(() => undefined)
  }

  // Bash wait: queued work returns after a fixed admission window. Once running,
  // a second independent window detaches the original tool reader without
  // cancelling execution; execution timeout remains owned by the port.
  async waitInitial(taskID, context, { timeoutMs: queueTimeoutMs = 1000, runningTimeoutMs = 10000 } = {}) {
    if ([queueTimeoutMs, runningTimeoutMs].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 60000)) throw failure("INVALID_READ_OPTIONS")
    if (this.#closed) throw failure("DISPOSED")
    if (!text(context?.sessionID) || !this.owns(taskID)) throw failure("TASK_ID_REQUIRED")
    // A freshly started command is already indexed before start() returns. Do
    // not enqueue recovery behind that command's owner-serial dispatch: dispatch
    // may be awaiting authorization or persistence, preventing the admission
    // timer below from being installed. Unknown IDs still require recovery.
    let entry = this.#state.entries.get(taskID)
    if (!entry) {
      await awaitReader(this.recoverSession(context), context.abort)
      entry = this.#state.entries.get(taskID)
    }
    if (!entry || entry.record.ownerSessionID !== context.sessionID) throw failure("NOT_OWNED")
    const owner = await awaitReader(Promise.resolve(this.#store.get(context.sessionID)), context.abort)
    if (!Object.hasOwn(refsOf(sessionO4E(owner)), taskID)) throw failure("NOT_OWNED")
    return await new Promise((resolvePromise, reject) => {
      let timer
      let runningTimer
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        this.#clock.clearTimeout(timer)
        this.#clock.clearTimeout(runningTimer)
        entry.listeners.delete(changed)
        context.abort?.removeEventListener("abort", aborted)
        if (error) reject(error)
        else resolvePromise(this.#snapshot(entry))
      }
      const changed = () => {
        if (terminal(entry.record) || entry.error) finish()
        else if (entry.record.status !== "queued" && runningTimer === undefined) {
          this.#clock.clearTimeout(timer)
          runningTimer = this.#clock.setTimeout(() => finish(), runningTimeoutMs)
        }
      }
      const aborted = () => finish(context.abort.reason ?? failure("READ_ABORTED"))
      entry.listeners.add(changed)
      context.abort?.addEventListener("abort", aborted, { once: true })
      timer = this.#clock.setTimeout(() => {
        if (entry.record.status === "queued") finish()
      }, queueTimeoutMs)
      if (context.abort?.aborted) aborted()
      else changed()
    })
  }

  async handle(args, context) {
    if (this.#closed) throw failure("DISPOSED")
    validateTaskControlArgs(args)
    if (!text(context?.sessionID)) throw failure("OWNER_REQUIRED")
    if (!object(args) || !["status", "output", "inspect", "cancel", "pending"].includes(args.action)) throw failure("UNSUPPORTED_ACTION")
    // No group fallback: plugin routing must select a concrete command taskID.
    if (!this.owns(args.taskID) || args.taskIDs !== undefined) throw failure("TASK_ID_REQUIRED")
    validateTaskReadOptions(args)
    const read = args.action === "inspect"
    const readContext = { ...context, abort: AbortSignal.any([this.#readAbort.signal, ...(context.abort ? [context.abort] : [])]) }
    const budget = read && !context.readWait ? createTaskReadBudget(args, readContext) : undefined
    const reader = budget?.context ?? readContext
    const wait = (operation) => reader.readWait ? reader.readWait(operation) : operation()
    try {
      await wait(() => this.recoverSession(reader))
      const entry = this.#state.entries.get(args.taskID)
      if (!entry || entry.record.ownerSessionID !== context.sessionID) throw failure("NOT_OWNED")
      // Membership is checked in the addressed owner's index, not by ID prefix.
      // The plugin must separately authorize the current Agent's access.
      const owner = await wait(() => this.#store.get(context.sessionID))
      if (!Object.hasOwn(refsOf(sessionO4E(owner)), args.taskID)) throw failure("NOT_OWNED")
      if (args.action === "cancel") return await this.#track(this.#cancel(entry))
      if (args.action === "pending") return { taskID: args.taskID, kind: "command", status: entry.record.status, pending: [], supported: false }
      if (args.action === "inspect") return await this.#inspect(entry, args, reader, wait)
      return this.#snapshot(entry)
    } finally { budget?.close() }
  }

  async #inspect(entry, args, context, wait) {
    const taskID = entry.record.taskID
    let base = { taskID, status: entry.record.status }
    let cursor = args.cursor
    if (args.resume) {
      if (!this.#resolver) return { ...base, unavailable: "resume-unsupported-store" }
      const resumed = await wait(() => this.#resolver({ store: this.#store, sessionID: context.sessionID,
        messageID: context.messageID, callID: context.callID, taskIDs: [taskID], direction: args.direction, signal: context.abort }))
      if (resumed?.unavailable?.[taskID]) return { ...base, unavailable: resumed.unavailable[taskID] }
      if (!object(resumed?.cursors)) return { ...base, unavailable: "resume-unverifiable" }
      cursor = resumed.cursors[taskID]
      if (cursor === undefined && args.direction === "backward") return { ...base, unavailable: "resume-no-earlier" }
    }
    const snapshot = this.#snapshot(entry)
    base = { taskID, status: snapshot.status,
      ...Object.fromEntries(["exitCode", "reason", "diagnostic", "truncated", "logPath", "logBytes", "logComplete", "logError"]
        .filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]])) }
    if (snapshot.output === undefined) return { ...base, ...(cursor ? { gap: "output-unavailable" } : { unavailable: "not-dispatched" }) }
    const bytes = Buffer.from(snapshot.output)
    const size = args.maxBytes ?? 1024
    const identity = [1, "command", taskID, entry.record.taskSessionID, entry.record.claim]
    let position
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) throw failure("CURSOR")
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
        if (!Array.isArray(parsed) || parsed.length !== 8 || JSON.stringify(parsed.slice(0, 5)) !== JSON.stringify(identity)
          || !Number.isSafeInteger(parsed[5]) || parsed[5] < 0 || !Number.isSafeInteger(parsed[6])
          || parsed[6] < parsed[5] || parsed[6] > bytes.length || (bytes[parsed[5]] & 0xc0) === 0x80
          || digest(bytes.subarray(0, parsed[6])) !== parsed[7]) throw failure("CURSOR")
        position = parsed[5]
      } catch { return { ...base, gap: "cursor-invalid-or-output-changed" } }
    }
    const backward = args.direction === "backward"
    const end = position === undefined ? bytes.length : backward ? position : Math.min(bytes.length, position + size)
    const start = position === undefined || backward ? Math.max(0, end - size) : position
    const window = utf8Range(bytes, start, end)
    // Bind the entire prior public prefix, including bytes not yet paginated.
    // Validation above hashes only that saved length, so appends remain valid.
    const prefixHash = digest(bytes)
    const encode = (offset) => Buffer.from(JSON.stringify([...identity, offset, bytes.length, prefixHash])).toString("base64url")
    const next = encode(window.end)
    if (next.length > 512) return { ...base, unavailable: "cursor-identity-too-large" }
    return { ...base, tail: window.value, cursor: next,
      ...(window.start > 0 ? { beforeCursor: encode(window.start) } : {}),
      ...(window.start === window.end ? { unchanged: true } : {}),
      ...(snapshot.truncated ? { gap: "output-truncated" } : {}) }
  }
}
