import { isDeepStrictEqual } from "node:util"
import { AsyncLocalStorage } from "node:async_hooks"
import { commandControlLines, priorPublicToolParts, watchTaskText } from "./task-result-visibility.mjs"
import { buildDelegationPrompt, delegationAuthorizationFingerprint, delegationPromptContext } from "./delegation-runtime.mjs"
import { sessionO4E } from "./session-store.mjs"
import { BackgroundTaskScheduler } from "./background-task-scheduler.mjs"
import { canonicalDirectoryKey } from "./directory-key.mjs"
import { serial } from "./serial.mjs"
import { createTaskReadBudget, taskWatchTimeoutMs, validateTaskReadOptions } from "./task-read-budget.mjs"
import { validateTaskControlArgs } from "./task-control-args.mjs"
import { AGENT_TASK_TOOL, toolMayHaveSideEffects } from "../core/agent-routing.mjs"
import { isRetryableModelError, normalizeModelRefs } from "../model-fallback.mjs"
import {
  TASK_GROUP_METADATA_VERSION,
  TASK_INPUT_MAX_LENGTH,
  TASK_PENDING_INPUT_LIMIT,
  TASK_KIND_AGENT,
  TASK_METADATA_VERSION,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_CANCELLING,
  TASK_STATUS_COMPLETED,
  TASK_STATUS_FAILED,
  TASK_STATUS_INTERRUPTED,
  TASK_STATUS_QUEUED,
  TASK_STATUS_RETRYING,
  TASK_STATUS_RUNNING,
  TASK_STATUS_STARTING,
  TASK_STATUS_UNKNOWN,
  TASK_STATUS_WAITING_PERMISSION,
  TASK_STATUS_WAITING_QUESTION,
  TASK_STATUS_WAITING_RETRY_DECISION,
  TASK_STATUS_WAITING_TOOL,
  TASK_STATUS_WAITING_WORKFLOW,
  compactText,
  createDispatchMessageID,
  createTaskID,
  isActionableTaskStatus,
  isTerminalTaskStatus,
  firstTaskModelCandidate,
  messageReferences,
  mergeTaskRefReceipt,
  retainTaskRefReceipts,
  nextTaskModelCandidate,
  normalizeBackgroundTaskConfig,
  normalizeTaskGroupMetadata,
  normalizeTaskMetadata,
  normalizeTaskPendingRequest,
  taskDiagnostic,
  taskInputPublicSnapshot,
  taskMetadata,
  taskPublicSnapshot,
  taskHasCurrentRoundSideEffect,
  taskText,
} from "../core/background-task-domain.mjs"

// Bound only for bounded watch-history bookkeeping; inspect itself uses the
// caller's validated read budget and must not inherit this shorter limit.
const INSPECTION_TIMEOUT_MS = 5_000
const INSPECTION_IDENTITY_FIELDS = ["kind", "taskID", "taskSessionID", "childSessionID", "dispatchMessageID", "runGeneration", "attemptNumber"]

const CANCELLATION_FENCES = Symbol.for("opencode-for-everything.background-task-cancellation-fences.v1")
const cancellationFences = globalThis[CANCELLATION_FENCES] ??= new Map()
const DISPATCH_FENCES = Symbol.for("opencode-for-everything.background-task-dispatch-fences.v1")
const dispatchFences = globalThis[DISPATCH_FENCES] ??= new Map()
const TASK_MUTATION_QUEUES = Symbol.for("opencode-for-everything.background-task-mutation-queues.v1")
const sharedTaskMutationQueues = globalThis[TASK_MUTATION_QUEUES] ??= new Map()
const LIVE_TASK_ATTEMPTS = Symbol.for("opencode-for-everything.background-task-live-attempts.v1")
const liveTaskAttemptDirectories = globalThis[LIVE_TASK_ATTEMPTS] ??= new Map()
const TOMBSTONE_RETRY_INITIAL_MS = 100
const TOMBSTONE_RETRY_MAX_MS = 5_000

function liveTaskAttempts(directory) {
  const key = canonicalDirectoryKey(directory)
  const attempts = liveTaskAttemptDirectories.get(key) ?? new Map()
  liveTaskAttemptDirectories.set(key, attempts)
  return attempts
}

function serializeTaskMutation(directory, taskID, operation) {
  const key = canonicalDirectoryKey(directory)
  const mutations = sharedTaskMutationQueues.get(key) ?? new Map()
  sharedTaskMutationQueues.set(key, mutations)
  return serial(mutations, taskID, operation).finally(() => {
    if (mutations.size === 0 && sharedTaskMutationQueues.get(key) === mutations) sharedTaskMutationQueues.delete(key)
  })
}

function taskFenceKey(directory, taskID) {
  return `${directory}\u0000${taskID}`
}

function beginDispatch(directory, taskID) {
  const token = Symbol(taskID)
  const key = taskFenceKey(directory, taskID)
  const pending = dispatchFences.get(key) ?? new Set()
  pending.add(token)
  dispatchFences.set(key, pending)
  return token
}

function endDispatch(directory, taskID, token) {
  const key = taskFenceKey(directory, taskID)
  const pending = dispatchFences.get(key)
  if (!pending) return
  pending.delete(token)
  if (pending.size === 0) dispatchFences.delete(key)
}

function dispatchPending(directory, taskID) {
  return (dispatchFences.get(taskFenceKey(directory, taskID))?.size ?? 0) > 0
}

function systemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  }
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function sessionIDFromEvent(event) {
  return typeof event?.sessionID === "string" ? event.sessionID : undefined
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Task watch 已取消")
}

function backgroundCreationClosedError(cause) {
  return Object.assign(new Error(cause instanceof Error ? cause.message : "后台 Task Runtime 正在释放"), {
    code: "O4E_BACKGROUND_CREATION_CLOSED",
    ...(cause === undefined ? {} : { cause }),
  })
}

function missingSessionError(error) {
  return error instanceof Error && (error.name === "NotFoundError" || /404|不存在|not found|NotFoundError/i.test(error.message))
}

function retryDispatchPending(task) {
  return task.record.status === TASK_STATUS_RETRYING && task.record.phase.startsWith("retry-") && task.record.phase.endsWith("-pending")
}

function modelFallbackDispatchPending(task) {
  return task.record.status === TASK_STATUS_RETRYING && task.record.phase === "model-fallback-pending"
}

function cancellationPending(directory, record) {
  return !isTerminalTaskStatus(record.status) && (record.cancellationRequestedAt !== undefined || cancellationFences.has(taskFenceKey(directory, record.taskID)))
}

function cancellationTime(directory, record) {
  return record.cancellationRequestedAt ?? cancellationFences.get(taskFenceKey(directory, record.taskID))
}

function watchEventKey(record) {
  return JSON.stringify([record.taskID, record.status, record.phase, record.revision, record.diagnostic])
}

function watchSelectionActionable(tasks, deliveredEvents) {
  return tasks.some((task) => task.record.kind !== "command" && isTerminalTaskStatus(task.record.status)
    ? !taskReceiptAcknowledged(task)
    : (isActionableTaskStatus(task.record.status) || task.record.diagnostic) && !deliveredEvents.has(watchEventKey(task.record)))
}

function watchSelectionConsumed(tasks, deliveredEvents) {
  return tasks.every((task) => task.record.kind === "command"
    ? task.record.stopped && !["queued", "running"].includes(task.record.status) && deliveredEvents.has(watchEventKey(task.record))
    : isTerminalTaskStatus(task.record.status) && taskReceiptAcknowledged(task))
}

function taskReceiptAcknowledged(task) {
  return task.record.receipt?.acknowledgedAt !== undefined
}

function publicWatchResult(watched) {
  return { ...watched, tasks: watched.tasks.map((task) => ({
    taskID: task.taskID,
    kind: task.kind,
    status: task.status,
    revision: task.revision,
    phase: task.phase,
    ...Object.fromEntries(["stopped", "exitCode", "reason", "diagnostic", "truncated", "logPath", "logComplete", "logError"]
      .filter((key) => task[key] !== undefined).map((key) => [key, task[key]])),
  })) }
}

function normalizeMissingTaskTombstone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Background Task tombstone 必须是对象")
  if (value.version !== 1) throw new Error(`Background Task tombstone version 不支持: ${String(value.version)}`)
  const sourceTask = normalizeTaskMetadata(value.sourceTask)
  if (typeof value.taskID !== "string" || value.taskID !== sourceTask.taskID) throw new Error("Background Task tombstone.taskID 与 sourceTask 不一致")
  if (typeof value.ownerSessionID !== "string" || value.ownerSessionID !== sourceTask.ownerSessionID) throw new Error("Background Task tombstone.ownerSessionID 与 sourceTask 不一致")
  if (typeof value.sourceTaskSessionID !== "string" || value.sourceTaskSessionID !== sourceTask.taskSessionID) throw new Error("Background Task tombstone.sourceTaskSessionID 与 sourceTask 不一致")
  if (!Number.isSafeInteger(value.targetRevision) || value.targetRevision !== sourceTask.revision + 1) throw new Error("Background Task tombstone.targetRevision 无效")
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error("Background Task tombstone.createdAt 必须是非负安全整数")
  return {
    version: 1,
    taskID: value.taskID,
    ownerSessionID: value.ownerSessionID,
    sourceTaskSessionID: value.sourceTaskSessionID,
    targetRevision: value.targetRevision,
    createdAt: value.createdAt,
    sourceTask,
    delegation: value.delegation && typeof value.delegation === "object" && !Array.isArray(value.delegation)
      ? structuredClone(value.delegation)
      : undefined,
  }
}

function taskRefsEqual(left, right) {
  return left?.taskSessionID === right?.taskSessionID
    && left?.taskRevision === right?.taskRevision
    && left?.cancellationRequestedAt === right?.cancellationRequestedAt
    && JSON.stringify(left?.receipts ?? []) === JSON.stringify(right?.receipts ?? [])
    && left?.kind === right?.kind
    && left?.sequence === right?.sequence
    && left?.createdAt === right?.createdAt
    && JSON.stringify(left?.recoveryEnvelope) === JSON.stringify(right?.recoveryEnvelope)
}

function taskRefReceipts(ref) {
  return Array.isArray(ref?.receipts) ? ref.receipts.map((receipt) => ({ ...receipt })) : []
}

function taskRefReceiptFields(value) {
  const receipts = retainTaskRefReceipts(taskRefReceipts(value))
  return receipts.length > 0 ? { receipts } : {}
}

function replaceTaskRefReceiptFields(ref, value) {
  const { receipts: _receipts, ...base } = ref ?? {}
  return { ...base, ...taskRefReceiptFields(value) }
}

function taskReceiptReferenceFields(receipt) {
  if (!receipt) return {}
  return taskRefReceiptFields({ receipts: [{
    receiptID: receipt.receiptID,
    receiptStatus: receipt.status,
    receiptCreatedAt: receipt.createdAt,
    receiptGeneration: receipt.generation,
    receiptPhase: receipt.phase,
    ...(receipt.deliveredToMessageID === undefined ? {} : { receiptDeliveredToMessageID: receipt.deliveredToMessageID }),
    ...(receipt.deliveredAt === undefined ? {} : { receiptDeliveredAt: receipt.deliveredAt }),
    ...(receipt.acknowledgedAt === undefined ? {} : { receiptAcknowledgedAt: receipt.acknowledgedAt }),
  }] })
}

function mergeTaskRefReceiptFields(current, incoming) {
  const receiptByID = new Map(taskRefReceipts(current).map((receipt) => [receipt.receiptID, receipt]))
  for (const receipt of taskRefReceipts(incoming)) {
    receiptByID.set(receipt.receiptID, mergeTaskRefReceipt(receiptByID.get(receipt.receiptID), receipt))
  }
  return taskRefReceiptFields({ receipts: [...receiptByID.values()] })
}

function receiptFromTaskRef(taskID, receipt) {
  if (receipt?.receiptID === undefined) return undefined
  return {
    version: 1,
    receiptID: receipt.receiptID,
    taskID,
    status: receipt.receiptStatus,
    phase: receipt.receiptPhase ?? receipt.receiptStatus,
    createdAt: receipt.receiptCreatedAt,
    generation: receipt.receiptGeneration,
    deliveredToMessageID: receipt.receiptDeliveredToMessageID,
    deliveredAt: receipt.receiptDeliveredAt,
    acknowledgedAt: receipt.receiptAcknowledgedAt,
  }
}

function taskAttemptSessionIDs(record) {
  return [...new Set([record?.childSessionID, ...(record?.attemptSessionIDs ?? [])].filter(Boolean))]
}

function recoveredPrepared(record, delegation) {
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) return null
  return {
    toolName: delegation.toolName,
    depth: delegation.depth,
    maxDelegationDepth: delegation.maxDelegationDepth,
    remainingDelegationDepth: delegation.remainingDelegationDepth,
    delegationAllowed: Number.isSafeInteger(delegation.maxDelegationDepth)
      && Number.isSafeInteger(delegation.depth)
      && delegation.depth < delegation.maxDelegationDepth,
    plan: delegation.plan,
    args: {
      task: delegation.task,
      plan: delegation.plan,
      outputContract: delegation.outputContract,
      recoveryContext: delegation.recoveryContext,
      trace: delegation.trace,
    },
    effect: { kind: delegation.effect, writeScopes: delegation.writeScopes },
    target: { name: delegation.targetAgent },
    requester: { name: delegation.sourceAgent },
    compiledPermission: delegation.compiledPermission,
    requesterPermissionPattern: delegation.requesterPermissionPattern,
    requesterPermissionAction: delegation.requesterPermissionAction,
    requesterPermissionApproved: delegation.requesterPermissionApproved,
    modelCandidates: record.modelCandidates,
    overlay: delegation.permissionOverlay,
    normalizedScopes: delegation.writeScopes,
    authorizationFingerprint: delegation.authorizationFingerprint,
  }
}

function pendingRequestKey(request) {
  return `${request.kind}\u0000${request.sessionID}\u0000${request.requestID}`
}

function pendingRequestsEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

export class BackgroundTaskRuntime {
  #store
  #execution
  #delegation
  #locks
  #directory
  #limits
  #scheduler
  #liveAttempts
  #sharedWatch
  #clock
  #inspectionReader
  #inspectionCursorResolver
  #onTerminalReceipt
  #onTerminalReceiptConsumed
  #onTerminalReceiptConsuming
  #onTerminalReceiptConsumptionFailed
  #tasks = new Map()
  #ownerHydration = new Map()
  #taskBySession = new Map()
  #watchers = new Map()
  #activeWatches = new Map()
  #userMessageEpochs = new Map()
  #transitions = new Map()
  #creations = new Map()
  #inflight = new Set()
  #publicationScope = new AsyncLocalStorage()
  #publicationFailures = new Map()
  #missingOwners = new Set()
  #recoveryDispatchedOwners = new Set()
  #dispatchSuspensions = 0
  #deferredDispatch = new Set()
  #runs = new Set()
  #tombstoneRetryTimers = new Map()
  #pendingTerminalNotifications = new Map()
  #terminalNotificationDeliveries = new Map()
  #terminalNotificationRetryTimers = new Map()
  #flushPromise
  #quiescing = false
  #creationAdmission = new AbortController()
  #disposed = false

  constructor({
    sessionStore,
    execution,
    delegation,
    locks,
    directory,
    limits,
    scheduler,
    sharedWatch,
    clock = systemClock(),
    inspectionReader,
    inspectionCursorResolver,
    onTerminalReceipt,
    onTerminalReceiptConsumed,
    onTerminalReceiptConsuming,
    onTerminalReceiptConsumptionFailed,
  }) {
    this.#store = sessionStore
    this.#execution = execution
    this.#delegation = delegation
    this.#locks = locks
    this.#directory = canonicalDirectoryKey(directory)
    this.#limits = normalizeBackgroundTaskConfig(limits)
    this.#scheduler = scheduler ?? new BackgroundTaskScheduler(this.#limits)
    this.#liveAttempts = liveTaskAttempts(this.#directory)
    this.#sharedWatch = sharedWatch
    this.#scheduler.setDispatcher?.((taskIDs) => this.#dispatch(taskIDs))
    this.#clock = clock
    this.#inspectionReader = inspectionReader
    this.#inspectionCursorResolver = inspectionCursorResolver
    this.#onTerminalReceipt = typeof onTerminalReceipt === "function" ? onTerminalReceipt : undefined
    this.#onTerminalReceiptConsumed = typeof onTerminalReceiptConsumed === "function" ? onTerminalReceiptConsumed : undefined
    this.#onTerminalReceiptConsuming = typeof onTerminalReceiptConsuming === "function" ? onTerminalReceiptConsuming : undefined
    this.#onTerminalReceiptConsumptionFailed = typeof onTerminalReceiptConsumptionFailed === "function" ? onTerminalReceiptConsumptionFailed : undefined
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#creationAdmission.abort(backgroundCreationClosedError())
    if (typeof this.#scheduler.dispose === "function") this.#scheduler.dispose()
    else this.#scheduler.clear()
    for (const timer of this.#tombstoneRetryTimers.values()) this.#clock.clearTimeout(timer)
    this.#tombstoneRetryTimers.clear()
    for (const timer of this.#terminalNotificationRetryTimers.values()) this.#clock.clearTimeout(timer)
    this.#terminalNotificationRetryTimers.clear()
    this.#pendingTerminalNotifications.clear()
    this.#terminalNotificationDeliveries.clear()
    for (const watchers of this.#watchers.values()) {
      for (const watcher of watchers) watcher.reject(new Error("后台 Task Runtime 已释放"))
    }
    this.#watchers.clear()
    this.#activeWatches.clear()
    for (const [taskID, attempt] of this.#liveAttempts) {
      if (!attempt.owners.delete(this)) continue
      if (attempt.owners.size === 0) this.#liveAttempts.delete(taskID)
    }
    if (this.#liveAttempts.size === 0 && liveTaskAttemptDirectories.get(this.#directory) === this.#liveAttempts) {
      liveTaskAttemptDirectories.delete(this.#directory)
    }
  }

  async flush() {
    if (!this.#flushPromise) {
      this.#quiescing = true
      this.#creationAdmission.abort(backgroundCreationClosedError())
      for (const watchers of this.#watchers.values()) {
        for (const watcher of watchers) watcher.reject(new Error("后台 Task Runtime 正在释放"))
      }
      this.#watchers.clear()
      this.#activeWatches.clear()
      for (const timer of this.#tombstoneRetryTimers.values()) this.#clock.clearTimeout(timer)
      this.#tombstoneRetryTimers.clear()
      for (const timer of this.#terminalNotificationRetryTimers.values()) this.#clock.clearTimeout(timer)
      this.#terminalNotificationRetryTimers.clear()
      for (const task of this.#tasks.values()) {
        if (!task.lockAcquired) task.scopeAbort?.abort(new Error("后台 Task Runtime 正在释放"))
      }
      this.#flushPromise = (async () => {
        // A shared directory may have another live plugin facade which can
        // continue coordinating the task. Only the last facade owns shutdown
        // cancellation; earlier facades hand active work to their successor.
        if (this.#scheduler.isLastFacade?.() === true) {
          const active = [...this.#tasks.values()]
            // Queue entries and explicit permission/question waits have not
            // started model execution. Keep them recoverable for a successor
            // facade or a later Session activation; only an actually running
            // Agent must be cancelled by the last facade.
            .filter((task) => task.record.status === TASK_STATUS_RUNNING
              || (task.record.status === TASK_STATUS_UNKNOWN && cancellationPending(this.#directory, task.record)))
          const cancellations = await Promise.allSettled(active.map(async (task) => {
            await this.#cancelTask(task, "最后一个 O4E facade 正在释放", new Set(), { propagateFailure: true })
            if (!isTerminalTaskStatus(task.record.status)) await this.#inspect(task.record.taskID)
          }))
          const failure = cancellations.find((settlement) => settlement.status === "rejected")
          if (failure?.status === "rejected") throw failure.reason
        }
        this.#scheduler.clear()
        let failure
        const attemptedTombstones = new Set()
        while (!this.#disposed) {
          const tombstones = [...this.#tasks.values()]
            .filter((task) => task.missingTaskTombstonePending && !attemptedTombstones.has(task.record.taskID))
            .map((task) => {
              attemptedTombstones.add(task.record.taskID)
              return task.missingTaskTombstoneWrite ?? this.#persistMissingTaskTombstone(task, { scheduleRetry: false })
            })
          const pending = [...new Set([
            ...this.#inflight,
            ...this.#creations.values(),
            ...this.#transitions.values(),
            ...this.#runs,
            ...tombstones,
          ])]
          if (pending.length === 0) {
            if (failure !== undefined) throw failure
            return
          }
          const settlements = await Promise.allSettled(pending)
          failure ??= settlements.find((settlement) => settlement.status === "rejected" && settlement.reason?.code !== "O4E_BACKGROUND_CREATION_CLOSED")?.reason
        }
      })()
    }
    return this.#flushPromise
  }

  resume({ dispatch = true } = {}) {
    if (this.#disposed) return
    this.#flushPromise = undefined
    this.#quiescing = false
    this.#creationAdmission = new AbortController()
    this.#recoveryDispatchedOwners.clear()
    this.#scheduler.clear()
    for (const task of this.#tasks.values()) {
      if (task.missingTaskTombstonePending) this.#scheduleMissingTaskTombstoneRetry(task)
    }
    for (const receiptID of this.#pendingTerminalNotifications.keys()) this.#deliverTerminalReceiptNotification(receiptID)
    const tasks = [...this.#tasks.values()].sort((left, right) => left.record.createdAt - right.record.createdAt || left.record.sequence - right.record.sequence)
    for (const task of tasks) {
      if (isTerminalTaskStatus(task.record.status)) {
        continue
      }
      if (task.record.status === TASK_STATUS_INTERRUPTED) continue
      if (task.record.status === TASK_STATUS_UNKNOWN && !this.#recordOccupiesSlot(task.record)) continue
      const dispatchPending = retryDispatchPending(task) || modelFallbackDispatchPending(task)
      if ((task.record.status === TASK_STATUS_QUEUED || dispatchPending) && !cancellationPending(this.#directory, task.record) && task.scopeAbort?.signal.aborted) {
        task.scopeAbort = new AbortController()
      }
      if (task.record.status === TASK_STATUS_QUEUED) {
        task.slotReleased = true
        this.#scheduler.enqueue(task.record)
        continue
      }
      this.#scheduler.restoreActive(task.record)
      task.slotReleased = false
    }
    for (const task of tasks.filter((entry) => modelFallbackDispatchPending(entry))) {
      void this.#withOwnerPublication(() => this.#pauseAutomaticModelFallback(task)).catch(() => undefined)
    }
    if (dispatch) this.dispatchRecoverableTasks()
  }

  async ensureOwner(context) {
    this.#assertActive()
    return this.#track((async () => {
      await this.recoverSession(context.sessionID, { dispatch: false })
      this.#assertActive()
    })())
  }

  async recoverSession(sessionID, { dispatch = false, session: suppliedSession } = {}) {
    return this.#withOwnerPublication(() => this.#recoverSession(sessionID, { dispatch, session: suppliedSession }))
  }

  async #recoverSession(sessionID, { dispatch = false, session: suppliedSession } = {}) {
    this.#assertActive()
    if (typeof sessionID !== "string" || sessionID.trim() === "") return { managed: false }
    const session = suppliedSession ?? await this.#store.get(sessionID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    const state = sessionO4E(session)
    const persistedTask = state.task ? normalizeTaskMetadata(state.task) : undefined
    const ownerSessionID = persistedTask?.ownerSessionID
      ?? (state.kind === "delegation-attempt" && typeof state.delegation?.taskID === "string"
        ? state.delegation.parentSessionID
        : sessionID)
    if (typeof ownerSessionID !== "string" || ownerSessionID.trim() === "") return { managed: false }
    const suspendDispatch = !dispatch
    if (suspendDispatch) this.#dispatchSuspensions += 1
    let recovered = false
    try {
      if (persistedTask) await this.#loadTask(persistedTask, session, { preferIndexed: true })
      const owner = ownerSessionID === sessionID ? session : undefined
      if (owner || await this.#store.get(ownerSessionID).then(Boolean, (error) => {
        if (missingSessionError(error)) return false
        throw error
      })) {
        await this.#hydrateOwner(ownerSessionID, { dispatchQueued: dispatch, force: true })
      } else if (persistedTask) {
        this.#missingOwners.add(ownerSessionID)
        await this.#restoreOwnerTasks(ownerSessionID, { dispatchQueued: false, ownerExists: false })
      }
      await this.#reconcileLoadedTasks(ownerSessionID)
      if (sessionID !== ownerSessionID && state.backgroundTasks) {
        await this.#hydrateOwner(sessionID, { dispatchQueued: dispatch, force: true })
        await this.#reconcileLoadedTasks(sessionID)
      }
      recovered = true
      if (dispatch) {
        this.dispatchRecoverableTasks(ownerSessionID)
        if (sessionID !== ownerSessionID && state.backgroundTasks) this.dispatchRecoverableTasks(sessionID)
      }
      return { managed: Boolean(persistedTask || sessionO4E(session).backgroundTasks), ownerSessionID }
    } catch (error) {
      this.#discardDeferredDispatch(ownerSessionID)
      throw error
    } finally {
      if (suspendDispatch) this.#dispatchSuspensions -= 1
      if (recovered) this.#resumeDeferredDispatch()
    }
  }

  dispatchRecoverableTasks(ownerSessionID) {
    const key = ownerSessionID ?? "*"
    if (this.#disposed || this.#quiescing || this.#recoveryDispatchedOwners.has(key)) return
    this.#recoveryDispatchedOwners.add(key)
    this.#dispatchRecoverableTasks(ownerSessionID)
  }

  async activateSession(sessionID) {
    const recovered = await this.recoverSession(sessionID, { dispatch: false })
    if (recovered.managed) {
      await this.#recoverTerminalReceiptNotifications(sessionID)
      this.dispatchRecoverableTasks(sessionID)
    }
    return recovered
  }

  async startAgent(args, context, options = {}) {
    this.#assertActive()
    const creationAdmission = this.#creationAdmission.signal
    return this.#withOwnerPublication(() => serial(this.#creations, context.sessionID, () => this.#startAgent(args, context, { ...options, creationAdmission })))
  }

  async #startAgent(args, context, { toolName = AGENT_TASK_TOOL, onSession, permissionApproved = false, creationAdmission } = {}) {
    this.#assertCreationActive(creationAdmission, context.abort)
    await this.ensureOwner(context)
    this.#assertCreationActive(creationAdmission, context.abort)
    const prepared = await this.#delegation.prepare(args, context, toolName, { permissionApproved })
    this.#assertCreationActive(creationAdmission, context.abort)
    if (prepared.status !== "selected") return json(prepared.response)

    const taskID = createTaskID()
    const dispatchMessageID = createDispatchMessageID()
    const createdAt = this.#now()
    prepared.args = {
      ...prepared.args,
      trace: {
        ...(prepared.args?.trace && typeof prepared.args.trace === "object" && !Array.isArray(prepared.args.trace)
          ? prepared.args.trace
          : {}),
        taskID,
        ownerSessionID: context.sessionID,
      },
    }
    prepared.authorizationFingerprint = delegationAuthorizationFingerprint({
      requester: prepared.requester,
      requesterPermissionPattern: prepared.requesterPermissionPattern,
      requesterPermissionAction: prepared.requesterPermissionAction,
      requesterPermissionApproved: prepared.requesterPermissionApproved,
      target: prepared.target,
      overlay: prepared.overlay,
      effect: prepared.effect,
      normalizedScopes: prepared.normalizedScopes,
      trace: prepared.args.trace,
    })
    const sequence = await this.#reserveTaskRef(context.sessionID, {
      taskID,
      kind: TASK_KIND_AGENT,
      taskSessionID: null,
      createdAt,
    })
    this.#assertCreationActive(creationAdmission, context.abort)
    let child
    let record
    let task
    try {
      const attempt = await this.#createOrRecoverAttempt(prepared, context, {
        taskID,
        dispatchMessageID,
        status: TASK_STATUS_QUEUED,
      })
      child = attempt.child
      const maxRetries = Number.isSafeInteger(prepared.target.backgroundTasks?.maxRetries)
        ? prepared.target.backgroundTasks.maxRetries
        : this.#limits.maxRetries
      const modelCandidates = normalizeModelRefs(prepared.modelCandidates ?? [])
      record = normalizeTaskMetadata({
        version: TASK_METADATA_VERSION,
        revision: 1,
        sequence,
        taskID,
        kind: TASK_KIND_AGENT,
        status: TASK_STATUS_QUEUED,
        phase: "queued",
        ownerSessionID: context.sessionID,
        taskSessionID: child.id,
        childSessionID: child.id,
        agent: prepared.target.name,
        requesterAgent: prepared.requester.name,
        requesterPermissionPattern: prepared.requesterPermissionPattern,
        requesterPermissionAction: prepared.requesterPermissionAction,
        requesterPermissionApproved: prepared.requesterPermissionApproved,
        authorizationFingerprint: prepared.authorizationFingerprint,
        effect: prepared.effect.kind,
        writeScopes: prepared.normalizedScopes,
        dispatchMessageID,
        maxRetries,
        attemptNumber: 0,
        retryRound: 0,
        attemptSessionIDs: [child.id],
        modelCandidates,
        currentModel: modelCandidates[0],
        failedModelCandidates: [],
        handledModelErrorAttempt: 0,
        runGeneration: 0,
        activeInputs: [],
        pendingInputs: [],
        createdAt,
        queuedAt: createdAt,
        updatedAt: createdAt,
        diagnostics: [],
      })
      task = {
        record,
        prepared,
        context,
        lockID: `background-task:${taskID}`,
        scopeAbort: new AbortController(),
        slotReleased: false,
        lockAcquired: false,
        dispatchPending: false,
        dispatchUnconfirmed: false,
        recovered: false,
        observedActive: false,
      }
      this.#assertCreationActive(creationAdmission, context.abort)
      await this.#store.updateO4E(child.id, (state) => ({ ...state, task: taskMetadata(record) }))
      this.#assertCreationActive(creationAdmission, context.abort)
      await this.#replaceTaskRef(context.sessionID, taskID, {
        taskSessionID: child.id,
        taskRevision: record.revision,
        kind: TASK_KIND_AGENT,
        sequence,
        createdAt,
        recoveryEnvelope: this.#taskRecoveryEnvelope(task),
      })
      this.#assertCreationActive(creationAdmission, context.abort)
      this.#remember(task)
      await Promise.resolve(onSession?.({ child, prepared, background: true })).catch(() => undefined)
      this.#assertCreationActive(creationAdmission, context.abort)
      this.#dispatch(this.#scheduler.enqueue(record))
      return json({
        taskID,
        status: TASK_STATUS_QUEUED,
        agent: record.agent,
        sessionID: child.id,
        model: record.currentModel,
        sequence,
        createdAt,
      })
    } catch (error) {
      if (error?.code === "O4E_BACKGROUND_CREATION_CLOSED") {
        if (child?.id && record && task) await this.#cancelCreationBeforeDispatch(task, error)
        throw error
      }
      if (child?.id && record) {
        const failedRecord = taskMetadata({
          ...record,
          revision: record.revision + 1,
          status: TASK_STATUS_FAILED,
          phase: "task-registration-failed",
          updatedAt: this.#now(),
          endedAt: this.#now(),
          diagnostics: [...record.diagnostics, taskDiagnostic("task-registration-failed", errorText(error), this.#now())],
        })
        const childPersisted = await this.#store.updateO4E(child.id, (state) => ({ ...state, task: failedRecord })).then(() => true, () => false)
        if (childPersisted) this.#queueTaskRecoveryReference(task, failedRecord)
        const ownerPersisted = childPersisted
            ? await this.#replaceTaskRef(context.sessionID, taskID, {
                taskSessionID: child.id,
                taskRevision: failedRecord.revision,
                 kind: TASK_KIND_AGENT,
                 sequence,
                 createdAt,
                 ...taskReceiptReferenceFields(failedRecord.receipt),
                 recoveryEnvelope: this.#taskRecoveryEnvelope({ ...task, record: failedRecord }),
             }).then(() => true, () => false)
          : false
        if (childPersisted && ownerPersisted) {
          this.#remember({
            record: failedRecord,
            prepared,
            context,
            lockID: `background-task:${taskID}`,
            scopeAbort: new AbortController(),
            slotReleased: true,
            lockAcquired: false,
          })
          return json({
            taskID,
            status: TASK_STATUS_FAILED,
            agent: failedRecord.agent,
            sessionID: child.id,
            sequence,
            createdAt,
            diagnostics: failedRecord.diagnostics,
          })
        }
      }
      throw error
    }
  }

  async handle(args, context) {
    this.#assertActive()
    validateTaskControlArgs(args)
    validateTaskReadOptions(args)
    const budget = ["inspect", "watch"].includes(args?.action) && !context.readWait ? createTaskReadBudget(args, context) : undefined
    try { return await this.#track(this.#handle(args, budget?.context ?? context)) }
    finally { budget?.close() }
  }

  async #awaitRead(context, operation) {
    return context?.readWait ? context.readWait(() => this.#withOwnerPublication(operation)) : this.#withOwnerPublication(operation)
  }

  async #handle(args, context) {
    const action = args?.action
    if (!this.#ownerHydration.has(context.sessionID)) {
      await this.#awaitRead(context, () => this.recoverSession(context.sessionID, { dispatch: false }))
    }
    this.#assertActive()
    if (action === "status") return json(taskPublicSnapshot(await this.status(args, context)))
    if (action === "watch") {
      const watched = await this.#watch(args, context)
      return JSON.stringify(publicWatchResult(watched))
    }
    if (action === "inspect") return JSON.stringify(await this.#inspectOutput(args, context))
    if (action === "output") return json(await this.output(args, context))
    if (action === "input") return json(await this.input(args, context))
    if (action === "resume") return json(await this.resumeTask(args, context))
    if (action === "cancel") return json(taskPublicSnapshot(await this.cancel(args, context)))
    if (action === "resolve") return json(taskPublicSnapshot(await this.resolve(args, context)))
    if (action === "pending") return json(await this.pending(args, context))
    if (action === "permission.reply") return json(taskPublicSnapshot(await this.#respondPendingRequest(args, context, "permission")))
    if (action === "question.reply") return json(taskPublicSnapshot(await this.#respondPendingRequest(args, context, "question")))
    if (action === "question.reject") return json(taskPublicSnapshot(await this.#respondPendingRequest(args, context, "question", { reject: true })))
    throw new Error(`当前版本的 o4e_task 暂不支持 action: ${String(action)}`)
  }

  hasActiveWatch(ownerSessionID, { requesterSessionID = ownerSessionID, taskIDs } = {}) {
    const watchers = this.#activeWatches.get(ownerSessionID)
    if (!watchers) return false
    const selected = Array.isArray(taskIDs) && taskIDs.length > 0 ? new Set(taskIDs) : undefined
    return [...watchers].some((watcher) => (
      watcher.requesterSessionID === requesterSessionID
      && (!selected || watcher.watchAll || [...watcher.watchedTaskIDs].some((taskID) => selected.has(taskID)))
    ))
  }

  releaseSharedWatch(ownerSessionID) {
    this.#releaseDeferredTerminalNotifications(ownerSessionID, {
      requesterSessionID: ownerSessionID,
      watchAll: true,
      watchedTaskIDs: new Set(),
    })
  }

  notifyUserMessagePersisted({ sessionID, messageID }) {
    if (this.#disposed || this.#quiescing || typeof sessionID !== "string" || typeof messageID !== "string") return 0
    this.#userMessageEpochs.set(sessionID, (this.#userMessageEpochs.get(sessionID) ?? 0) + 1)
    return this.#wakeOwner(
      sessionID,
      "user-message",
      (watcher) => watcher.requesterSessionID === sessionID,
    )
  }

  async pendingReceipts(context, { messageID } = {}) {
    return this.#withOwnerPublication(() => this.#pendingReceipts(context, { messageID }))
  }

  async #pendingReceipts(context, { messageID } = {}) {
    this.#assertActive()
    await this.recoverSession(context.sessionID, { dispatch: false })
    const ownerSessionID = context.sessionID
    let tasks = await this.#authorizedTasks(context)
    const assistantParents = new Set(await this.#execution.completedAssistantParentIDs?.({ sessionID: ownerSessionID }).catch(() => []) ?? [])
    let owner = await this.#store.get(ownerSessionID)
    let group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    const assistantConsumed = []
    for (const task of tasks) {
      if (task.record.ownerSessionID !== ownerSessionID) continue
      await this.#refreshTaskFromOwnerRef(task)
    }
    tasks = [...this.#tasks.values()]
      .filter((task) => task.record.ownerSessionID === ownerSessionID)
      .sort((left, right) => left.record.sequence - right.record.sequence)
    for (const task of tasks) {
      if (isTerminalTaskStatus(task.record.status)) await this.#publishReceiptReference(task.record).catch(() => undefined)
    }
    owner = await this.#store.get(ownerSessionID)
    group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    const taskByID = new Map(tasks.map((task) => [task.record.taskID, task]))
    for (const [taskID, ref] of Object.entries(group.taskRefs)) {
      for (const refReceipt of taskRefReceipts(ref)) {
        const receipt = receiptFromTaskRef(taskID, refReceipt)
        if (!receipt?.deliveredToMessageID || receipt.acknowledgedAt !== undefined || !assistantParents.has(receipt.deliveredToMessageID)) continue
        const acknowledgedAt = Math.max(this.#now(), receipt.deliveredAt)
        const receiptIDs = [receipt.receiptID]
        await Promise.resolve(this.#onTerminalReceiptConsuming?.({ ownerSessionID, receiptIDs })).catch(() => undefined)
        let acknowledged
        try {
          acknowledged = await this.#updateReceiptReference(ownerSessionID, taskID, receipt.receiptID, {
            receiptAcknowledgedAt: acknowledgedAt,
          }, {
            expectedDeliveredToMessageID: receipt.deliveredToMessageID,
            requireUnacknowledged: true,
          })
        } catch (error) {
          await Promise.resolve(this.#onTerminalReceiptConsumptionFailed?.({ ownerSessionID, receiptIDs })).catch(() => undefined)
          throw error
        }
        if (!acknowledged) {
          await Promise.resolve(this.#onTerminalReceiptConsumptionFailed?.({ ownerSessionID, receiptIDs })).catch(() => undefined)
          continue
        }
        const task = taskByID.get(taskID)
        if (task) {
          await this.#updateReceipt(task, (current) => (
            current.receiptID === receipt.receiptID
            && current.acknowledgedAt === undefined
              ? {
                  ...current,
                  deliveredToMessageID: receipt.deliveredToMessageID,
                  deliveredAt: receipt.deliveredAt,
                  acknowledgedAt,
                }
              : undefined
          )).catch(() => undefined)
        }
        assistantConsumed.push({ ownerSessionID, taskID, receiptID: receipt.receiptID })
      }
    }
    for (const notification of assistantConsumed) {
      await Promise.resolve(this.#onTerminalReceiptConsumed?.(notification)).catch(() => undefined)
    }
    owner = await this.#store.get(ownerSessionID)
    group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    for (const task of tasks) {
      if (!isTerminalTaskStatus(task.record.status) || !task.record.receipt) continue
      const ref = group.taskRefs[task.record.taskID]
      if (!taskRefReceipts(ref).some((receipt) => receipt.receiptID === task.record.receipt.receiptID)) {
        await this.#publishReceiptReference(task.record).catch(() => undefined)
      }
    }
    for (const task of tasks) {
      if (isTerminalTaskStatus(task.record.status) && task.record.pendingInputs?.length > 0) {
        await this.#queuePendingInputContinuation(task, { dispatch: false }).catch(() => undefined)
      }
    }
    owner = await this.#store.get(ownerSessionID)
    group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    const pending = []
    const seenReceipts = new Set()
    const refs = Object.entries(group.taskRefs).sort(([, left], [, right]) => left.sequence - right.sequence)
    const canonicalLedgers = new Map()
    for (const [taskID, ref] of refs) {
      const task = taskByID.get(taskID)
      if (!task || task.record.taskSessionID !== ref.taskSessionID || task.record.revision < (ref.taskRevision ?? 1)) continue
      const indexedSession = await this.#store.get(ref.taskSessionID).catch((error) => {
        if (missingSessionError(error)) return null
        throw error
      })
      const persisted = sessionO4E(indexedSession)?.task
      if (!persisted) continue
      const indexedRecord = normalizeTaskMetadata(persisted)
      if (indexedRecord.taskID === taskID && indexedRecord.taskSessionID === ref.taskSessionID && indexedRecord.revision >= (ref.taskRevision ?? 1)) {
        let outputAvailable = false
        if (indexedRecord.status === TASK_STATUS_COMPLETED) {
          outputAvailable = await this.#readCompletedOutput(indexedRecord).then(() => true, () => false)
        }
        canonicalLedgers.set(taskID, { record: indexedRecord, outputAvailable })
      }
    }
    for (const [taskID, ref] of refs) {
      for (const refReceipt of taskRefReceipts(ref)) {
        const receipt = receiptFromTaskRef(taskID, refReceipt)
        if (!receipt) continue
        seenReceipts.add(receipt.receiptID)
        if (receipt.acknowledgedAt !== undefined || pending.length >= 20) continue
        const task = taskByID.get(taskID)
        const canonical = canonicalLedgers.get(taskID)
        const canonicalReceipt = canonical?.record.receipt?.receiptID === receipt.receiptID
        pending.push({
          receiptID: receipt.receiptID,
          taskID,
          agent: task?.record.agent,
          status: receipt.status,
          phase: receipt.phase,
          endedAt: canonicalReceipt ? (canonical.record.endedAt ?? receipt.createdAt) : receipt.createdAt,
          outputAvailable: Boolean(canonicalReceipt && canonical.outputAvailable),
          diagnostics: canonicalReceipt ? canonical.record.diagnostics.slice(-8).map((diagnostic) => diagnostic.code) : [],
          ...(typeof messageID === "string" ? { deliveryMessageID: messageID } : {}),
        })
      }
    }
    return pending
  }

  async markReceiptsDelivered(receiptIDs, context, messageID, { preserveExistingDelivery = false } = {}) {
    return this.#withOwnerPublication(() => this.#markReceiptsDelivered(receiptIDs, context, messageID, { preserveExistingDelivery }))
  }

  async #markReceiptsDelivered(receiptIDs, context, messageID, { preserveExistingDelivery = false } = {}) {
    if (!Array.isArray(receiptIDs) || receiptIDs.length === 0 || typeof messageID !== "string" || messageID === "") return []
    this.#assertActive()
    const requested = new Set(receiptIDs)
    const deliveredAt = this.#now()
    const tasks = await this.#authorizedTasks(context)
    const delivered = new Set()
    const deliveries = new Map()
    await this.#store.updateO4E(context.sessionID, (state) => {
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      let changed = false
      const taskRefs = { ...group.taskRefs }
      for (const [taskID, ref] of Object.entries(taskRefs)) {
        let receiptChanged = false
        const receipts = taskRefReceipts(ref).map((receipt) => {
          if (!requested.has(receipt.receiptID) || receipt.receiptAcknowledgedAt !== undefined) return receipt
          if (preserveExistingDelivery && receipt.receiptDeliveredToMessageID !== undefined) {
            delivered.add(receipt.receiptID)
            deliveries.set(receipt.receiptID, {
              receiptID: receipt.receiptID,
              messageID: receipt.receiptDeliveredToMessageID,
              deliveredAt: receipt.receiptDeliveredAt,
            })
            return receipt
          }
          if ((receipt.receiptDeliveredAt ?? -1) > deliveredAt) return receipt
          if ((receipt.receiptDeliveredAt ?? -1) === deliveredAt && receipt.receiptDeliveredToMessageID !== messageID) return receipt
          delivered.add(receipt.receiptID)
          deliveries.set(receipt.receiptID, { receiptID: receipt.receiptID, messageID, deliveredAt })
          if (receipt.receiptDeliveredToMessageID === messageID && receipt.receiptDeliveredAt === deliveredAt) return receipt
          receiptChanged = true
          return { ...receipt, receiptDeliveredToMessageID: messageID, receiptDeliveredAt: deliveredAt }
        })
        if (!receiptChanged) continue
        const nextRef = replaceTaskRefReceiptFields(ref, { receipts })
        if (taskRefsEqual(ref, nextRef)) continue
        taskRefs[taskID] = nextRef
        changed = true
      }
      if (!changed) return state
      return {
        ...state,
        backgroundTasks: { ...group, revision: group.revision + 1, taskRefs },
      }
    })
    for (const task of tasks) {
      const receipt = task.record.receipt
      if (task.record.ownerSessionID !== context.sessionID || !receipt || !requested.has(receipt.receiptID) || !delivered.has(receipt.receiptID)) continue
      const delivery = deliveries.get(receipt.receiptID)
      if (!delivery) continue
      const updated = await this.#updateReceipt(task, (current) => (
        current.receiptID === receipt.receiptID
        && current.acknowledgedAt === undefined
        && (current.deliveredAt ?? -1) <= delivery.deliveredAt
          ? { ...current, deliveredToMessageID: delivery.messageID, deliveredAt: delivery.deliveredAt }
          : undefined
      )).catch(() => undefined)
      if (!updated) continue
      delivered.add(receipt.receiptID)
      await this.#publishReceiptReference(task.record).catch(() => undefined)
    }
    return [...deliveries.values()]
  }

  async acknowledgeReceipts(receiptIDs, context, messageID = context?.messageID) {
    return this.#withOwnerPublication(() => this.#acknowledgeReceipts(receiptIDs, context, messageID))
  }

  async #acknowledgeReceipts(receiptIDs, context, messageID) {
    if (!Array.isArray(receiptIDs) || receiptIDs.length === 0 || typeof messageID !== "string" || messageID === "") return []
    this.#assertActive()
    await this.recoverSession(context.sessionID, { dispatch: false })
    const requested = [...new Set(receiptIDs)]
    const requestedSet = new Set(requested)
    for (const task of this.#tasks.values()) {
      if (
        task.record.ownerSessionID === context.sessionID
        && task.record.receipt
        && requestedSet.has(task.record.receipt.receiptID)
      ) {
        await this.#publishReceiptReference(task.record)
      }
    }
    const owner = await this.#store.get(context.sessionID)
    const group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    const locations = new Map()
    for (const [taskID, ref] of Object.entries(group.taskRefs)) {
      for (const receipt of taskRefReceipts(ref)) {
        if (!requestedSet.has(receipt.receiptID)) continue
        locations.set(receipt.receiptID, { taskID })
      }
    }
    const missing = requested.filter((receiptID) => !locations.has(receiptID))
    if (missing.length > 0) throw new Error(`Task receipt 不属于当前父 Session: ${missing.join(", ")}`)

    const acknowledged = []
    const acknowledgedAt = this.#now()
    for (const receiptID of requested) {
      const { taskID } = locations.get(receiptID)
      await serializeTaskMutation(this.#directory, taskID, async () => {
        const currentOwner = await this.#store.get(context.sessionID)
        const currentRef = normalizeTaskGroupMetadata(sessionO4E(currentOwner)?.backgroundTasks).taskRefs[taskID]
        const currentRefReceipt = taskRefReceipts(currentRef).find((receipt) => receipt.receiptID === receiptID)
        if (!currentRefReceipt) throw new Error(`Task receipt 已不属于当前父 Session: ${receiptID}`)
        const indexedSession = await this.#store.get(currentRef.taskSessionID).catch((error) => {
          if (missingSessionError(error)) return null
          throw error
        })
        const persisted = sessionO4E(indexedSession)?.task
        const record = persisted ? normalizeTaskMetadata(persisted) : undefined
        if (
          !record
          || record.taskID !== taskID
          || record.taskSessionID !== currentRef.taskSessionID
          || record.receipt?.receiptID !== receiptID
        ) {
          const acknowledgedRef = await this.#acknowledgeReceiptReference(
            context.sessionID,
            taskID,
            receiptID,
            messageID,
            acknowledgedAt,
          )
          if (!acknowledgedRef) throw new Error(`Task receipt 已不属于当前父 Session: ${receiptID}`)
          return
        }
        const mergedReceipt = mergeTaskRefReceipt(
          currentRefReceipt,
          taskReceiptReferenceFields(record.receipt).receipts[0],
        )
        const deliveredToMessageID = mergedReceipt.receiptDeliveredToMessageID ?? messageID
        const deliveredAt = mergedReceipt.receiptDeliveredAt ?? acknowledgedAt
        const receiptAcknowledgedAt = mergedReceipt.receiptAcknowledgedAt ?? Math.max(acknowledgedAt, deliveredAt)
        const nextReceipt = {
          ...record.receipt,
          deliveredToMessageID,
          deliveredAt,
          acknowledgedAt: receiptAcknowledgedAt,
        }
        let nextRecord = record
        if (JSON.stringify(nextReceipt) !== JSON.stringify(record.receipt)) {
          nextRecord = taskMetadata({
            ...record,
            revision: record.revision + 1,
            updatedAt: Math.max(this.#now(), record.updatedAt),
            receipt: nextReceipt,
          })
          await this.#store.updateO4E(record.taskSessionID, (state) => {
            const latest = normalizeTaskMetadata(state.task)
            if (latest.revision !== record.revision) {
              throw new Error(`Task revision 已变化: expected=${record.revision} actual=${latest.revision}`)
            }
            return { ...state, task: nextRecord }
          })
          const task = this.#tasks.get(taskID)
          if (task?.record.taskSessionID === nextRecord.taskSessionID && nextRecord.revision > task.record.revision) {
            this.#acceptTaskRecord(task, nextRecord)
            this.#queueTaskRecoveryReference(task, nextRecord)
          }
        }
        await this.#replaceTaskRefSerialized(context.sessionID, taskID, {
          taskSessionID: nextRecord.taskSessionID,
          taskRevision: nextRecord.revision,
          kind: nextRecord.kind,
          sequence: nextRecord.sequence,
          createdAt: nextRecord.createdAt,
          ...(nextRecord.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: nextRecord.cancellationRequestedAt }),
          ...taskReceiptReferenceFields(nextRecord.receipt),
        }, { preserveNewerTaskRef: true })
      })
      acknowledged.push(receiptID)
    }
    return acknowledged
  }

  async #cancelCreationBeforeDispatch(task, cause) {
    const at = this.#now()
    const current = await this.#store.get(task.record.taskSessionID).catch(() => null)
    const persisted = sessionO4E(current)?.task
    const base = persisted ? normalizeTaskMetadata(persisted) : task.record
    const cancelled = taskMetadata({
      ...base,
      revision: base.revision + 1,
      status: TASK_STATUS_CANCELLED,
      phase: "runtime-disposed-before-dispatch",
      cancellationRequestedAt: base.cancellationRequestedAt ?? at,
      updatedAt: at,
      endedAt: at,
      diagnostics: [
        ...base.diagnostics,
        taskDiagnostic("runtime-disposed-before-dispatch", errorText(cause), at),
      ],
    })
    await this.#store.updateO4E(task.record.taskSessionID, (state) => ({
      ...state,
      task: cancelled,
      delegation: state.delegation
        ? {
            ...state.delegation,
            status: "cancelled",
            cancellationRequestedAt: state.delegation.cancellationRequestedAt ?? at,
            endedAt: at,
            diagnostics: "runtime-disposed-before-dispatch",
          }
        : state.delegation,
    }))
    this.#queueTaskRecoveryReference(task, cancelled)
    await this.#replaceTaskRef(cancelled.ownerSessionID, cancelled.taskID, {
      taskSessionID: cancelled.taskSessionID,
      taskRevision: cancelled.revision,
      kind: cancelled.kind,
      sequence: cancelled.sequence,
      createdAt: cancelled.createdAt,
      cancellationRequestedAt: cancelled.cancellationRequestedAt,
      ...taskReceiptReferenceFields(cancelled.receipt),
    })
    task.record = cancelled
    task.slotReleased = true
    this.#remember(task)
  }

  async status(args, context) {
    return this.#withOwnerPublication(() => this.#status(args, context))
  }

  async #status(args, context) {
    const task = await this.#loadAuthorized(args?.taskID, context, "read")
    return structuredClone(task.record)
  }

  async taskGroup(context, options) {
    return this.#withOwnerPublication(() => this.#taskGroup(context, options))
  }

  async #taskGroup(context, options) {
    const tasks = await this.#authorizedTasks(context, undefined, options)
    return tasks.map((task) => this.#publicationSnapshot(task.record))
  }

  async output(args, context) {
    return this.#withOwnerPublication(() => this.#output(args, context))
  }

  async #output(args, context) {
    const task = await this.#loadAuthorized(args?.taskID, context, "read")
    if (task.record.status !== TASK_STATUS_COMPLETED) {
      throw new Error(`Task 尚未 completed，不能读取 output: ${task.record.taskID} (${task.record.status}/${task.record.phase})`)
    }
    const { reference, parts } = await this.#readCompletedOutput(task.record)
    if (task.record.ownerSessionID === context.sessionID && typeof context.messageID === "string" && context.messageID !== "") {
      await this.#consumeTerminalNotifications([task], context)
    }
    const result = {
      ...taskPublicSnapshot(task.record),
      output: taskText({ parts }),
      messageID: reference.messageID,
      partIDs: [...reference.partIDs],
    }
    return result
  }

  async #deliveredWatchEvents(tasks, context, deadline, commandListeners) {
    const delivered = new Set()
    if (!context?.messageID || !context?.callID || typeof this.#store.messages !== "function") return delivered
    const ownerSessionID = tasks[0].record.ownerSessionID
    let interrupt
    const interrupted = new Promise((resolve) => { interrupt = () => resolve(undefined) })
    const watcher = {
      watchedTaskIDs: new Set(tasks.map((task) => task.record.taskID)),
      revisions: new Map(tasks.map((task) => [task.record.taskID, task.record.revision])),
      requesterSessionID: context.sessionID,
      inspection: true,
      resolve: interrupt,
      reject: interrupt,
    }
    const watchers = this.#watchers.get(ownerSessionID) ?? new Set()
    watchers.add(watcher)
    this.#watchers.set(ownerSessionID, watchers)
    commandListeners?.add(interrupt)
    context.abort?.addEventListener("abort", interrupt, { once: true })
    const timer = this.#clock.setTimeout(interrupt, Math.min(INSPECTION_TIMEOUT_MS, Math.max(0, deadline - this.#now())))
    let messages
    try {
      context.abort?.throwIfAborted()
      messages = await Promise.race([this.#store.messages(context.sessionID), interrupted])
    } catch {
      // Without complete delivery evidence, reporting the event again is safe.
    } finally {
      this.#clock.clearTimeout(timer)
      context.abort?.removeEventListener("abort", interrupt)
      commandListeners?.delete(interrupt)
      this.#removeWatcher(ownerSessionID, watcher)
    }
    context.abort?.throwIfAborted()
    this.#assertActive()
    for (const part of priorPublicToolParts(messages, context)) {
      const result = part.state.metadata?.o4eResult
      if (!result) continue
      if (part.tool === "o4e_task" && part.state.input?.action === "watch" && Array.isArray(result.tasks)) {
        result.tasks.forEach((entry, index) => {
          if (!entry || !Number.isSafeInteger(entry.revision) || typeof entry.phase !== "string") return
          const text = watchTaskText(entry, index)
          if (`${part.state.output}\n`.includes(`\n\n${text}\n`)) delivered.add(watchEventKey(entry))
        })
        continue
      }
      const command = tasks.find((task) => task.record.kind === "command" && task.record.taskID === result.taskID)?.record
      if (!command || watchEventKey(command) !== watchEventKey(result)) continue
      if (part.tool === "bash" && command.source?.sessionID === context.sessionID
        && command.source.messageID === part.messageID && command.source.callID === part.callID) {
        // The canonical snapshot defines all required controls. Metadata alone
        // cannot prove that exit codes or incomplete logs reached the model.
        const controls = commandControlLines(command)
        if (controls.length === 0 && command.logComplete !== true) continue
        const body = `\n${part.state.output}\n`
        if (controls.every((line) => body.includes(`\n${line}\n`))) delivered.add(watchEventKey(command))
      }
    }
    return delivered
  }

  async #readCompletedOutput(record) {
    const reference = record.result
    if (!reference?.sessionID || !reference.messageID || !Array.isArray(reference.partIDs)) {
      throw new Error(`Task completed 结果引用不可用: ${record.taskID}`)
    }
    let messages
    try {
      messages = await this.#store.messages(reference.sessionID)
    } catch {
      throw new Error(`Task completed 结果引用不可用: ${record.taskID}`)
    }
    const result = messages.find((entry) => entry?.info?.id === reference.messageID)
    if (
      !result
      || !taskAttemptSessionIDs(record).includes(reference.sessionID)
      || this.#execution.isCompletedAssistantMessage?.({ message: result, messages, dispatchMessageID: record.dispatchMessageID }) !== true
    ) {
      throw new Error(`Task completed 结果引用不可用: ${record.taskID}`)
    }
    const partsByID = new Map((Array.isArray(result.parts) ? result.parts : [])
      .filter((part) => typeof part?.id === "string")
      .map((part) => [part.id, part]))
    const parts = reference.partIDs.map((partID) => partsByID.get(partID))
    if (parts.some((part) => !part)) {
      throw new Error(`Task completed 结果引用不可用: ${record.taskID}`)
    }
    return { reference, parts }
  }

  async pending(args, context) {
    return this.#withOwnerPublication(() => this.#pending(args, context))
  }

  async #pending(args, context) {
    const tasks = args?.taskID
      ? [await this.#loadAuthorized(args.taskID, context, "read")]
      : await this.#authorizedTasks(context)
    let supported = false
    const results = []
    for (const task of tasks) {
      if (await this.#quarantineUnverifiableAuthorization(task)) {
        results.push(taskPublicSnapshot(task.record))
        continue
      }
      const reconciled = await this.#reconcilePendingRequests(task)
      supported ||= reconciled.supported
      results.push(taskPublicSnapshot(task.record))
    }
    return { supported, tasks: results }
  }

  #pendingTaskStatus(requests) {
    if (requests.some((request) => request.kind === "question")) {
      return { status: TASK_STATUS_WAITING_QUESTION, phase: "question-waiting" }
    }
    if (requests.some((request) => request.kind === "permission")) {
      return { status: TASK_STATUS_WAITING_PERMISSION, phase: "permission-waiting" }
    }
    return { status: TASK_STATUS_RUNNING, phase: "model-running" }
  }

  #pendingRequestRecord(request, current) {
    const at = this.#now()
    const normalized = normalizeTaskPendingRequest({
      version: 1,
      ...request,
      state: "pending",
      requestedAt: current?.requestedAt ?? at,
      updatedAt: at,
    })
    if (current && JSON.stringify({ ...current, updatedAt: 0 }) === JSON.stringify({ ...normalized, updatedAt: 0 })) return current
    return normalized
  }

  async #upsertPendingRequest(task, request) {
    if (request.sessionID !== task.record.childSessionID) return false
    const existing = new Map((task.record.pendingRequests ?? []).map((entry) => [pendingRequestKey(entry), entry]))
    const key = pendingRequestKey(request)
    existing.set(key, this.#pendingRequestRecord(request, existing.get(key)))
    const pendingRequests = [...existing.values()]
    const desired = this.#pendingTaskStatus(pendingRequests)
    if (pendingRequestsEqual(task.record.pendingRequests, pendingRequests)
      && task.record.status === desired.status
      && task.record.phase === desired.phase) return false
    await this.#setStatus(task, desired.status, desired.phase, { pendingRequests })
    await this.#publishTaskRecoveryReference(task)
    return true
  }

  async #reconcilePendingRequests(task, supplied, { inspectionClaim, resolvedRequest } = {}) {
    const listed = supplied ?? (typeof this.#execution.listPendingRequests === "function"
      ? await this.#execution.listPendingRequests({ sessionID: task.record.childSessionID })
      : { supported: false, requests: [] })
    if (listed.error) {
      return {
        supported: listed.supported === true,
        waiting: (task.record.pendingRequests?.length ?? 0) > 0,
        changed: false,
        error: listed.error,
      }
    }
    if (!listed.supported) {
      if (!resolvedRequest) return { supported: false, waiting: (task.record.pendingRequests?.length ?? 0) > 0, changed: false }
      const pendingRequests = (task.record.pendingRequests ?? []).filter((request) => !(
        request.kind === resolvedRequest.kind && request.requestID === resolvedRequest.requestID
      ))
      if (pendingRequestsEqual(task.record.pendingRequests, pendingRequests)) {
        return { supported: false, waiting: pendingRequests.length > 0, changed: false }
      }
      const desired = this.#pendingTaskStatus(pendingRequests)
      const updated = await this.#setStatus(task, desired.status, desired.phase, { pendingRequests }, inspectionClaim ? { inspectionClaim } : {})
      if (!updated) return { supported: false, waiting: (task.record.pendingRequests?.length ?? 0) > 0, changed: false }
      await this.#publishTaskRecoveryReference(task)
      return { supported: false, waiting: pendingRequests.length > 0, changed: true }
    }
    const current = new Map((task.record.pendingRequests ?? []).map((entry) => [pendingRequestKey(entry), entry]))
    const pendingRequests = (listed.requests ?? [])
      .filter((request) => request.sessionID === task.record.childSessionID)
      .map((request) => this.#pendingRequestRecord(request, current.get(pendingRequestKey(request))))
    const desired = this.#pendingTaskStatus(pendingRequests)
    if (pendingRequestsEqual(task.record.pendingRequests, pendingRequests)
      && (pendingRequests.length > 0 || ![TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION].includes(task.record.status))) {
      return { supported: true, waiting: pendingRequests.length > 0, changed: false }
    }
    const updated = await this.#setStatus(task, desired.status, desired.phase, { pendingRequests }, inspectionClaim ? { inspectionClaim } : {})
    if (!updated) return { supported: true, waiting: (task.record.pendingRequests?.length ?? 0) > 0, changed: false }
    await this.#publishTaskRecoveryReference(task)
    return { supported: true, waiting: pendingRequests.length > 0, changed: true }
  }

  #unverifiedInteraction(task, reconciled) {
    return [TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION].includes(task.record.status)
      && (task.record.pendingRequests?.length ?? 0) === 0
      && (reconciled?.supported !== true || Boolean(reconciled.error))
  }

  async #interruptUnverifiedInteraction(task, reconciled, error, { inspectionClaim } = {}) {
    const interruptedAt = this.#now()
    const reason = reconciled?.error
      ? `无法核验宿主 pending interaction: ${reconciled.error}`
      : "宿主不支持 pending interaction 查询，无法恢复缺少 requestID 的交互"
    const eventReason = error === undefined ? "" : `；子 Session 异常: ${errorText(error)}`
    const message = `${reason}${eventReason}`
    await this.#setStatus(task, TASK_STATUS_WAITING_RETRY_DECISION, "execution-interrupted", {
      pendingRequests: [],
      retryDecision: {
        status: "pending",
        retryRound: task.record.retryRound,
        attemptNumber: task.record.attemptNumber,
        requestedAt: interruptedAt,
        error: message,
      },
      diagnostics: [...task.record.diagnostics, taskDiagnostic("interaction-reconciliation-unavailable", message, interruptedAt)],
    }, inspectionClaim ? { inspectionClaim } : {})
  }

  #validateQuestionAnswers(request, answers) {
    if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((entry) => typeof entry === "string" && entry.trim()))) {
      throw new Error("question.reply answers 必须是非空字符串数组组成的数组")
    }
    const questions = request.question?.questions ?? []
    if (answers.length !== questions.length) throw new Error(`question.reply answers 数量必须等于 questions 数量: ${questions.length}`)
    return answers.map((answer, index) => {
      const question = questions[index]
      if (answer.length === 0) throw new Error(`question.reply answers[${index}] 不能为空`)
      if (!question.multiple && answer.length !== 1) throw new Error(`question.reply answers[${index}] 只能选择一个答案`)
      const labels = new Set(question.options.map((option) => option.label))
      if (!question.custom && answer.some((entry) => !labels.has(entry))) {
        throw new Error(`question.reply answers[${index}] 必须匹配可选 label`)
      }
      return answer.map((entry) => entry.trim())
    })
  }

  async #respondPendingRequest(args, context, kind, { reject = false } = {}) {
    return this.#withOwnerPublication(() => this.#respondPendingRequestBoundary(args, context, kind, { reject }))
  }

  async #respondPendingRequestBoundary(args, context, kind, { reject = false } = {}) {
    const requestedTaskID = typeof args?.taskID === "string" ? args.taskID.trim() : ""
    const requestedRequestID = typeof args?.requestID === "string" ? args.requestID.trim() : ""
    const tasks = requestedTaskID
      ? [await this.#loadAuthorized(requestedTaskID, context, "respond")]
      : await this.#authorizedTasks(context)
    if (!requestedTaskID && tasks.some((task) => task.record.ownerSessionID !== context.sessionID)) {
      throw new Error("只有父 Session 可以回复 pending request")
    }
    const candidates = []
    for (const task of tasks) {
      if (await this.#quarantineUnverifiableAuthorization(task)) {
        throw new Error(`Task 授权来源不可验证，不能回复 pending request: ${task.record.taskID}`)
      }
      const reconciled = await this.#reconcilePendingRequests(task)
      if (!reconciled.supported) throw new Error("当前 OpenCode 宿主不支持 pending interaction API")
      if (reconciled.error) throw new Error(`读取宿主 pending interaction 失败: ${reconciled.error}`)
      for (const request of task.record.pendingRequests ?? []) {
        if (request.kind !== kind) continue
        if (requestedRequestID && request.requestID !== requestedRequestID) continue
        candidates.push({ task, request })
      }
    }
    if (candidates.length === 0) {
      throw new Error(`Task 当前不等待 ${kind} request: ${requestedRequestID || "<missing>"}`)
    }
    if (candidates.length > 1) {
      throw new Error(`无法唯一定位 ${kind} request；请提供 taskID 和 requestID`)
    }
    const { task, request } = candidates[0]
    const expectedRevision = args?.expectedRevision === undefined || args.expectedRevision === null || args.expectedRevision === ""
      ? task.record.revision
      : args.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("回复 pending request 必须提供 expectedRevision")
    if (task.record.revision !== expectedRevision) {
      throw new Error(`Task revision 已变化: expected=${expectedRevision} actual=${task.record.revision}`)
    }
    const requestID = request.requestID
    let response = { kind, sessionID: task.record.childSessionID, requestID }
    if (kind === "permission") {
      if (!["once", "always", "reject"].includes(args?.reply)) throw new Error("permission.reply 必须提供 once、always 或 reject reply")
      response = {
        ...response,
        reply: args.reply,
        ...(typeof args?.message === "string" && args.message.trim() ? { message: args.message.trim().slice(0, 512) } : {}),
      }
    } else if (reject) response = { ...response, reject: true }
    else response = { ...response, answers: this.#validateQuestionAnswers(request, args?.answers) }

    const submittingAt = this.#now()
    const pendingRequests = task.record.pendingRequests.map((entry) => pendingRequestKey(entry) === pendingRequestKey(request)
      ? { ...entry, state: "submitting", updatedAt: submittingAt }
      : entry)
    await this.#setStatus(task, task.record.status, task.record.phase, { pendingRequests }, { expectedRevision })
    await this.#publishTaskRecoveryReference(task)
    try {
      await this.#execution.respondToPendingRequest(response)
      const confirmed = await this.#reconcilePendingRequests(task)
      if (confirmed.error || task.record.pendingRequests.some((entry) => pendingRequestKey(entry) === pendingRequestKey(request))) {
        throw new Error(confirmed.error ?? "宿主仍报告 request pending")
      }
      if (!confirmed.waiting) await this.#inspect(task.record.taskID)
      return structuredClone(task.record)
    } catch (error) {
      const restored = task.record.pendingRequests.map((entry) => pendingRequestKey(entry) === pendingRequestKey(request)
        ? { ...entry, state: "pending", updatedAt: this.#now() }
        : entry)
      await this.#setStatus(task, task.record.status, task.record.phase, {
        pendingRequests: restored,
        diagnostics: [...task.record.diagnostics, taskDiagnostic("reply-submit-unconfirmed", errorText(error), this.#now())],
      }).catch(() => undefined)
      await this.#publishTaskRecoveryReference(task).catch(() => undefined)
      throw error
    }
  }

  async #watch(args, context) {
    if (args?.taskID !== undefined && args?.taskIDs !== undefined) throw new Error("watch 不能同时提供 taskID 和 taskIDs")
    const requestedTaskIDs = args?.taskIDs !== undefined ? args.taskIDs
      : typeof args?.taskID === "string" && args.taskID.trim() ? [args.taskID.trim()] : undefined
    const agents = await this.#awaitRead(context, () => this.#authorizedTasks(context, requestedTaskIDs, { pendingOnly: requestedTaskIDs === undefined }))
    const selectedTaskIDs = agents.map((task) => task.record.taskID)
    const loadSelected = async () => [
      ...await this.#authorizedTasks(context, selectedTaskIDs),
      ...(await context.commandWatch?.tasks() ?? []).map((record) => ({ record })),
    ]
    let tasks = context.commandWatch
      ? [...agents, ...(await this.#awaitRead(context, () => context.commandWatch.tasks())).map((record) => ({ record }))]
      : agents
    const revisions = new Map(tasks.map((task) => [task.record.taskID, task.record.revision]))
    const events = new Map(tasks.map((task) => [task.record.taskID, watchEventKey(task.record)]))
    const watchOwnerSessionID = tasks[0]?.record.ownerSessionID ?? context.sessionID
    if (watchSelectionConsumed(tasks, new Set())) {
      return this.#watchResult(watchOwnerSessionID, "empty", tasks, 0)
    }
    const activeWatch = {
      watchedTaskIDs: new Set(tasks.map((task) => task.record.taskID)),
      watchAll: false,
      requesterSessionID: context.sessionID,
    }
    const sharedWatchClaim = this.#sharedWatch?.registerWatch(watchOwnerSessionID, activeWatch)
    const activeWatches = this.#activeWatches.get(watchOwnerSessionID) ?? new Set()
    activeWatches.add(activeWatch)
    this.#activeWatches.set(watchOwnerSessionID, activeWatches)
    const commandListeners = new Set()
    let unsubscribeCommands
    try {
      unsubscribeCommands = context.commandWatch?.subscribe(() => {
        for (const listener of commandListeners) listener()
      })
      const startedAt = this.#now()
      const deadline = startedAt + taskWatchTimeoutMs(args.timeoutMs)
      const userMessageEpoch = this.#userMessageEpochs.get(context.sessionID) ?? 0
      const deliveredEvents = tasks.some((task) => (task.record.kind === "command" || !isTerminalTaskStatus(task.record.status))
        && (isActionableTaskStatus(task.record.status) || task.record.diagnostic))
        ? await this.#awaitRead(context, () => this.#deliveredWatchEvents(tasks, context, deadline, commandListeners)) : new Set()
      if (context.commandWatch) tasks = await this.#awaitRead(context, loadSelected)
      if ((this.#userMessageEpochs.get(context.sessionID) ?? 0) !== userMessageEpoch) {
        return this.#watchResult(watchOwnerSessionID, "user-message", tasks, this.#now() - startedAt)
      }
      if (watchSelectionActionable(tasks, deliveredEvents)) {
        return await this.#actionableWatchResult(watchOwnerSessionID, tasks, context, this.#now() - startedAt)
      }

      // Progress wakes must not extend the fixed window or consume a new event.
      while (true) {
        if ((this.#userMessageEpochs.get(context.sessionID) ?? 0) !== userMessageEpoch) {
          const latest = await this.#awaitRead(context, loadSelected)
          return this.#watchResult(watchOwnerSessionID, "user-message", latest, this.#now() - startedAt)
        }
        if (watchSelectionConsumed(tasks, deliveredEvents)) {
          return this.#watchResult(watchOwnerSessionID, "empty", tasks, this.#now() - startedAt)
        }
        const remainingMs = Math.max(0, deadline - this.#now())
        if (remainingMs === 0) break
        let watcher
        const wake = new Promise((resolve, reject) => {
          watcher = {
            watchedTaskIDs: new Set(tasks.map((task) => task.record.taskID)),
            revisions,
            watchAll: false,
            requesterSessionID: context.sessionID,
            resolve,
            reject,
            signal: context.abort,
          }
          const onAbort = () => {
            this.#removeWatcher(watchOwnerSessionID, watcher)
            reject(abortError(context.abort))
          }
          if (context.abort?.aborted) {
            reject(abortError(context.abort))
            return
          }
          watcher.cleanup = () => context.abort?.removeEventListener("abort", onAbort)
          context.abort?.addEventListener("abort", onAbort, { once: true })
          const current = this.#watchers.get(watchOwnerSessionID) ?? new Set()
          current.add(watcher)
          this.#watchers.set(watchOwnerSessionID, current)
        })
        // Authorization may still be in flight when abort rejects the wake.
        wake.catch(() => undefined)
        const commandChanged = () => watcher.resolve({ reason: "progress" })
        commandListeners.add(commandChanged)
        let timerHandle
        const timer = new Promise((resolve) => {
          timerHandle = this.#clock.setTimeout(() => resolve({ reason: "heartbeat" }), remainingMs)
        })
        let outcome
        try {
          const refreshed = await this.#awaitRead(context, loadSelected)
          if (refreshed.some((task) => watchEventKey(task.record) !== events.get(task.record.taskID))) {
            watcher.resolve({ reason: "progress" })
          }
          outcome = await Promise.race([wake, timer])
        } finally {
          if (timerHandle !== undefined) this.#clock.clearTimeout(timerHandle)
          commandListeners.delete(commandChanged)
          this.#removeWatcher(watchOwnerSessionID, watcher)
        }
        const latest = await this.#awaitRead(context, loadSelected)
        if ((this.#userMessageEpochs.get(context.sessionID) ?? 0) !== userMessageEpoch || outcome?.reason === "user-message") {
          return this.#watchResult(watchOwnerSessionID, "user-message", latest, this.#now() - startedAt)
        }
        if (watchSelectionActionable(latest, deliveredEvents)) {
          return await this.#actionableWatchResult(watchOwnerSessionID, latest, context, this.#now() - startedAt)
        }
        if (outcome?.reason === "actionable" || outcome?.reason === "progress") {
          for (const task of latest) {
            revisions.set(task.record.taskID, task.record.revision)
            events.set(task.record.taskID, watchEventKey(task.record))
          }
          tasks = latest
          continue
        }
        break
      }

      const latest = await this.#awaitRead(context, loadSelected)
      await this.#awaitRead(context, () => Promise.all(latest.filter((task) => task.record.kind !== "command" && !isActionableTaskStatus(task.record.status))
        .map((task) => this.#withOwnerPublication(() => this.#inspect(task.record.taskID)))))
      const reconciled = await this.#awaitRead(context, loadSelected)
      if ((this.#userMessageEpochs.get(context.sessionID) ?? 0) !== userMessageEpoch) {
        return this.#watchResult(watchOwnerSessionID, "user-message", reconciled, this.#now() - startedAt)
      }
      if (watchSelectionActionable(reconciled, deliveredEvents)) {
        return await this.#actionableWatchResult(watchOwnerSessionID, reconciled, context, this.#now() - startedAt)
      }
      const reason = watchSelectionConsumed(reconciled, deliveredEvents) ? "empty" : "heartbeat"
      return this.#watchResult(watchOwnerSessionID, reason, reconciled, this.#now() - startedAt)
    } finally {
      unsubscribeCommands?.()
      const registered = this.#activeWatches.get(watchOwnerSessionID)
      registered?.delete(activeWatch)
      if (registered?.size === 0) this.#activeWatches.delete(watchOwnerSessionID)
      this.#sharedWatch?.unregisterWatch(watchOwnerSessionID, sharedWatchClaim)
      this.#releaseDeferredTerminalNotifications(watchOwnerSessionID, activeWatch)
    }
  }

  async #inspectOutput(args, context) {
    const task = await this.#awaitRead(context, () => this.#loadAuthorized(args?.taskID, context, "read"))
    const claim = task.record
    const resumed = args.resume ? await this.#awaitRead(context, () => this.#resolveInspection([task.record.taskID], args, context)) : undefined
    if (resumed?.unavailable?.[claim.taskID]) {
      const refreshed = await this.#awaitRead(context, () => this.#loadAuthorized(claim.taskID, context, "read"))
      this.#assertActive()
      return { taskID: refreshed.record.taskID, status: refreshed.record.status,
        ...(INSPECTION_IDENTITY_FIELDS.some((key) => refreshed.record[key] !== claim[key])
          ? { gap: "execution-changed" } : { unavailable: resumed.unavailable[claim.taskID] }) }
    }
    const { record, preview } = await this.#readInspection({ ...task, record: claim }, { ...args, cursor: resumed?.cursors?.[claim.taskID] ?? args.cursor }, context)
    if (context.abort?.aborted) throw abortError(context.abort)
    this.#assertActive()
    return { taskID: record.taskID, status: record.status, ...preview }
  }

  async #resolveInspection(taskIDs, args, context) {
    if (typeof this.#inspectionCursorResolver !== "function") return { unavailable: Object.fromEntries(taskIDs.map((id) => [id, "resume-unsupported-store"])) }
    return this.#inspectionCursorResolver({ store: this.#store, sessionID: context.sessionID, messageID: context.messageID,
      callID: context.callID, taskIDs, direction: args.direction, signal: context.abort })
  }

  async #readInspection(task, args, context) {
    const result = (preview, record = task.record) => ({ record, preview })
    if (typeof this.#inspectionReader !== "function") return result({ unavailable: "inspection-unsupported" })
    if (task.record.phase === "authorization-unverifiable") return result({ unavailable: "authorization-unverifiable" })
    if (!task.record.dispatchMessageID || task.record.attemptNumber === 0) return result({ unavailable: "not-dispatched" })
    const claim = task.record
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.#creationAdmission.signal, ...(context.abort ? [context.abort] : [])])
    let onAbort
    try {
      const interrupted = new Promise((resolve) => {
        onAbort = () => resolve(result({ unavailable: controller.signal.aborted || context.abort?.reason?.message === "inspection-timeout" ? "inspection-timeout" : "aborted" }))
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
      return await Promise.race([interrupted, (async () => {
        if (signal.aborted) return result({ unavailable: "aborted" })
        const inspection = await this.#inspectionReader({
          store: this.#store, record: claim, directory: this.#directory, cursor: args?.cursor,
          direction: args?.direction, maxBytes: args?.maxBytes ?? 1024, signal,
        })
        if (signal.aborted) return result({ unavailable: "aborted" })
        const refreshed = await this.#awaitRead(context, () => this.#loadAuthorized(claim.taskID, context, "read"))
        if (signal.aborted) return result({ unavailable: "aborted" }, refreshed.record)
        if (INSPECTION_IDENTITY_FIELDS.some((key) => refreshed.record[key] !== claim[key])) {
          return result({ gap: "execution-changed" }, refreshed.record)
        }
        if (refreshed.record.phase === "authorization-unverifiable") return result({ unavailable: "authorization-unverifiable" }, refreshed.record)
        if (typeof inspection?.tail === "string" && Buffer.byteLength(inspection.tail) > (args?.maxBytes ?? 1024)) return result({ unavailable: "inspection-failed" }, refreshed.record)
        const preview = Object.fromEntries(["tail", "cursor", "beforeCursor", "unchanged", "unavailable", "gap"]
          .filter((key) => Object.hasOwn(inspection ?? {}, key)).map((key) => [key, inspection[key]]))
        return result(preview, refreshed.record)
      })().catch(() => result({ unavailable: "inspection-failed" }))])
    } finally {
      signal.removeEventListener("abort", onAbort)
      controller.abort()
    }
  }

  async continueOwner(sessionID, { messageID, parts, agent, model, variant } = {}) {
    return this.#withOwnerPublication(() => this.#continueOwner(sessionID, { messageID, parts, agent, model, variant }))
  }

  async #continueOwner(sessionID, { messageID, parts, agent, model, variant } = {}) {
    this.#assertActive()
    const session = await this.#store.get(sessionID)
    const state = sessionO4E(session)
    if (state.kind !== "delegation-attempt") {
      if (session?.id === sessionID && session.parentID === undefined && state.kind === undefined) return { managed: false }
      return { managed: true, accepted: false }
    }
    const taskID = state.delegation?.taskID
    if (typeof taskID !== "string") return { managed: true, accepted: false }
    const ownerID = state.delegation.parentSessionID
    const owner = await this.#store.get(ownerID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    const ref = normalizeTaskGroupMetadata(sessionO4E(owner).backgroundTasks).taskRefs[taskID]
    if (!ref) return { managed: true, accepted: false }
    await this.#hydrateOwnerRef(ownerID, taskID, ref)
    const task = this.#tasks.get(taskID)
    if (task?.record.childSessionID === sessionID && task.record.dispatchMessageID === messageID
      && task.record.attemptNumber > 0 && !task.dispatchUnconfirmed && !task.dispatchPending
      && ![TASK_STATUS_QUEUED, TASK_STATUS_STARTING, TASK_STATUS_UNKNOWN].includes(task.record.status)) {
      return { managed: true, accepted: true }
    }
    if (!task || task.record.childSessionID !== sessionID || this.#disposed || this.#quiescing
      || cancellationPending(this.#directory, task.record) || task.record.status !== TASK_STATUS_RUNNING
      || !["model-running", "waiting-children"].includes(task.record.phase)
      || task.record.pendingRequests?.length > 0 || task.dispatchPending) return { managed: true, accepted: false }
    if (agent !== undefined && agent !== task.record.agent) throw new Error("Receipt continuation Agent identity mismatch")
    if (typeof messageID !== "string" || !messageID || !Array.isArray(parts) || parts.length === 0) throw new Error("Receipt continuation message is missing")
    if (!task.lockAcquired && !await this.#restoreTaskLock(task)) return { managed: true, accepted: false }
    const claim = task.record
    const inspection = await this.#execution.inspectTurn({ sessionID, dispatchMessageID: claim.dispatchMessageID })
    if (inspection.state !== "idle" || inspection.pendingRequests?.length > 0) return { managed: true, accepted: false }
    const result = await this.#dispatchTurn(task, {
      claim, phase: "input-starting", messageID, model: claim.currentModel ?? normalizeModelRefs(model ? [{ ...model, ...(variant ? { variant } : {}) }] : [])[0], parts,
      extra: { result: undefined, activeInputs: [], runGeneration: claim.runGeneration + 1 },
    })
    return { managed: true, accepted: result?.claimed === true }
  }

  async input(args, context) {
    return this.#withOwnerPublication(() => this.#input(args, context))
  }

  async #input(args, context) {
    const task = await this.#loadAuthorized(args?.taskID, context, "input")
    let expectedRevision = args?.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("input.expectedRevision 必须是大于等于 1 的安全整数")
    if (task.record.revision !== expectedRevision) {
      throw new Error(`Task revision 已变化: expected=${expectedRevision} actual=${task.record.revision}`)
    }
    const text = typeof args?.input === "string" ? args.input.trim() : ""
    if (!text) throw new Error("input.input 必须是非空字符串")
    // Apply the same durable 16,384-character bound before either delivery path.
    // Without this, steer could bypass the queue limit and send a larger payload
    // directly to the host.
    const boundedText = text.slice(0, TASK_INPUT_MAX_LENGTH)
    const delivery = args?.delivery ?? "queue"
    if (delivery !== "queue" && delivery !== "steer") throw new Error("input.delivery 必须是 queue 或 steer")
    if (task.record.kind !== TASK_KIND_AGENT) throw new Error(`Task kind 不支持 input: ${task.record.kind}`)
    if (cancellationPending(this.#directory, task.record) || [TASK_STATUS_CANCELLING, TASK_STATUS_UNKNOWN, TASK_STATUS_INTERRUPTED, TASK_STATUS_CANCELLED].includes(task.record.status)) {
      throw new Error(`Task 当前状态不允许 input: ${task.record.status}/${task.record.phase}`)
    }
    if (task.record.pendingRequests?.length > 0 || [
      TASK_STATUS_WAITING_PERMISSION,
      TASK_STATUS_WAITING_QUESTION,
      TASK_STATUS_WAITING_WORKFLOW,
      TASK_STATUS_WAITING_RETRY_DECISION,
    ].includes(task.record.status)) {
      throw new Error(`Task 当前等待显式交互或 retry 决策，不能使用 input: ${task.record.status}/${task.record.phase}`)
    }
    const currentTurnRunning = [
      TASK_STATUS_RUNNING,
      TASK_STATUS_RETRYING,
      TASK_STATUS_WAITING_TOOL,
    ].includes(task.record.status)
    if (delivery === "steer" && currentTurnRunning && typeof this.#execution.steerTurn === "function") {
      const preparedRevision = expectedRevision + 1
      const messageID = `o4e_steer_${task.record.taskID}_${preparedRevision}`
      const steerEntry = { version: 1, text: boundedText, createdAt: this.#now(), delivery: "steer", messageID, revision: preparedRevision }
      const prepared = await this.#setStatus(task, task.record.status, task.record.phase, {
        activeInputs: [...(task.record.activeInputs ?? []), steerEntry].slice(-TASK_PENDING_INPUT_LIMIT),
      }, { expectedRevision })
      const admittedRevision = prepared?.revision ?? task.record.revision
      const admissionClaim = task.record
      let result
      let admissionError
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const admission = await this.#admitSteerDispatch(task, admissionClaim, steerEntry)
        if (!admission.admitted) {
          if (attempt === 0) {
            await this.#setStatus(task, task.record.status, task.record.phase, {
              activeInputs: (task.record.activeInputs ?? []).filter((entry) => entry.messageID !== messageID),
            }, { expectedRevision: admittedRevision })
            throw admission.error
          }
          admissionError = admission.error
          break
        }
        try {
          result = await this.#execution.steerTurn({ sessionID: task.record.childSessionID, messageID, text: boundedText })
          admissionError = undefined
          break
        } catch (error) {
          admissionError = error
        }
      }
      if (result?.accepted === true) {
        return taskInputPublicSnapshot(task.record, { currentTurnRunning, delivery: "steer", delivered: true })
      }
      await this.#setStatus(task, task.record.status, task.record.phase, {
        activeInputs: (task.record.activeInputs ?? []).filter((entry) => !(entry.createdAt === steerEntry.createdAt
          && entry.delivery === "steer" && entry.text === steerEntry.text)),
        ...(admissionError ? {
          diagnostics: [...task.record.diagnostics, taskDiagnostic(
            "steer-admission-unconfirmed",
            "宿主未确认 steer，已转入 next-turn 队列",
            this.#now(),
          )],
        } : {}),
      }, { expectedRevision: admittedRevision })
      expectedRevision = task.record.revision
    }
    const entry = { version: 1, text: boundedText, createdAt: this.#now() }
    const explicitlyStopped = task.record.status === TASK_STATUS_FAILED && task.record.phase === "retry-stopped"
    if (!explicitlyStopped && (task.record.pendingInputs?.length ?? 0) >= TASK_PENDING_INPUT_LIMIT) {
      throw new Error(`Task pending input 已达到上限 ${TASK_PENDING_INPUT_LIMIT}`)
    }
    // A new, explicit input can continue a stopped terminal Task, but must not
    // revive inputs admitted before the stop (including persisted leftovers).
    const pendingInputs = explicitlyStopped
      ? [entry]
      : [...(task.record.pendingInputs ?? []), entry]
    if (isTerminalTaskStatus(task.record.status)) {
      await this.#publishReceiptReference(task.record)
      await this.#setStatus(task, TASK_STATUS_QUEUED, "input-queued", {
        pendingInputs,
        endedAt: undefined,
        result: undefined,
        receipt: undefined,
        retryDecision: undefined,
        pendingRequests: [],
        activeInputs: [],
        cancellationRequestedAt: undefined,
        runGeneration: task.record.runGeneration + 1,
        dispatchMessageID: createDispatchMessageID(),
        attemptNumber: 0,
        retryRound: 0,
        failedModelCandidates: [],
        handledModelErrorAttempt: 0,
        sideEffectWatermark: undefined,
      }, { expectedRevision, allowTerminalTransition: true })
      await this.#publishTaskRecoveryReference(task)
      task.slotReleased = true
      this.#dispatch(this.#scheduler.enqueue(task.record))
      return taskInputPublicSnapshot(task.record, { currentTurnRunning })
    }
    const next = await this.#setStatus(task, task.record.status, task.record.phase, { pendingInputs }, { expectedRevision })
    await this.#publishTaskRecoveryReference(task)
    this.#redispatchIfPending(task)
    return taskInputPublicSnapshot(next ?? task.record, { currentTurnRunning })
  }

  async resumeTask(args, context) {
    return this.#withOwnerPublication(() => this.#resumeTask(args, context))
  }

  async #resumeTask(args, context) {
    const task = await this.#loadAuthorized(args?.taskID, context, "resume")
    const expectedRevision = args?.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("resume.expectedRevision 必须是大于等于 1 的安全整数")
    if (task.record.revision !== expectedRevision) throw new Error(`Task revision 已变化: expected=${expectedRevision} actual=${task.record.revision}`)
    if (cancellationPending(this.#directory, task.record)) return { ...taskPublicSnapshot(task.record), resume: { accepted: false, reason: "cancellation-pending" } }
    if (modelFallbackDispatchPending(task)) {
      await this.#pauseAutomaticModelFallback(task)
      return { ...taskPublicSnapshot(task.record), resume: { accepted: false, reason: "explicit-resolution-required" } }
    }
    if (task.record.status === TASK_STATUS_QUEUED || retryDispatchPending(task)) {
      const resumed = this.#redispatchIfPending(task)
      return { ...taskPublicSnapshot(task.record), resume: resumed }
    }
    if (isTerminalTaskStatus(task.record.status) && task.record.pendingInputs?.length > 0) {
      const resumed = await this.#queuePendingInputContinuation(task, { dispatch: true })
      return { ...taskPublicSnapshot(task.record), resume: resumed }
    }
    return { ...taskPublicSnapshot(task.record), resume: { accepted: false, reason: "state-not-resumable" } }
  }

  async resolve(args, context) {
    return this.#withOwnerPublication(() => this.#resolve(args, context))
  }

  async #resolve(args, context) {
    validateTaskControlArgs(args)
    const task = await this.#loadAuthorized(args?.taskID, context, "resolve")
    const expectedRevision = args?.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("resolve.expectedRevision 必须是大于等于 1 的安全整数")
    const decision = args?.decision
    if (decision !== "continue" && decision !== "restart" && decision !== "stop") {
      throw new Error(`当前 Task 等待状态不支持 resolve decision: ${String(decision)}`)
    }
    if (task.record.status !== TASK_STATUS_WAITING_RETRY_DECISION || task.record.retryDecision?.status !== "pending") {
      throw new Error(`Task 当前不等待 retry decision: ${task.record.status}/${task.record.phase}`)
    }
    const resolvedAt = this.#now()
    const retryDecision = {
      ...task.record.retryDecision,
      status: "resolved",
      decision,
      resolvedAt,
    }
    if (decision === "stop") {
      await this.#setStatus(task, TASK_STATUS_FAILED, "retry-stopped", {
        endedAt: resolvedAt,
        activeInputs: [],
        pendingInputs: [],
        retryDecision,
        diagnostics: [...task.record.diagnostics, taskDiagnostic("retry-stopped", "父 Session 终止了 Task", resolvedAt)],
      }, { expectedRevision })
      this.#releaseTerminal(task)
      return structuredClone(task.record)
    }
    // maxRetries remains part of the persisted compatibility contract, but
    // model errors never consume it automatically. An explicit owner/Agent
    // continue decision is the control path and remains available; every
    // invocation still passes the CAS, authorization, Attempt and cancellation
    // checks below.
    if (decision !== "continue" && task.record.retryRound >= task.record.maxRetries) {
      throw new Error(`Task retry 预算已耗尽: ${task.record.retryRound}/${task.record.maxRetries}`)
    }
    if (this.#authorizationUnverifiable(task)) {
      await this.#rejectDispatchAuthorization(task, task.record, new Error("Task 缺少可验证的冻结授权上下文"))
      return structuredClone(task.record)
    }
    const dispatchEpoch = task.dispatchEpoch
    task.prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
    if (task.dispatchEpoch !== dispatchEpoch) throw new Error("Task 恢复失败，本次 retry decision 已中止")
    if (task.record.revision !== expectedRevision || task.record.status !== TASK_STATUS_WAITING_RETRY_DECISION
      || task.record.retryDecision?.status !== "pending" || cancellationPending(this.#directory, task.record)) {
      throw new Error("Task retry decision 已变化")
    }
    const firstModel = firstTaskModelCandidate(task.record)
    const dispatchMessageID = createDispatchMessageID()
    await this.#setStatus(task, TASK_STATUS_RETRYING, `retry-${decision}-pending`, {
      retryRound: task.record.retryRound + 1,
      currentModel: firstModel,
      failedModelCandidates: [],
      dispatchMessageID,
      retryDecision,
    }, { expectedRevision })
    if (task.dispatchEpoch !== dispatchEpoch) throw new Error("Task 恢复失败，本次 retry decision 已中止")
    await this.#resumeResolvedRetry(task)
    return structuredClone(task.record)
  }

  async markSideEffectBeforeTool({ sessionID, callID, tool }) {
    if (typeof sessionID !== "string" || !toolMayHaveSideEffects(tool)) return { managed: false, watermarked: false }
    this.#assertActive()
    return this.#withOwnerPublication(() => this.#markSideEffectBeforeTool({ sessionID, callID, tool }))
  }

  async #markSideEffectBeforeTool({ sessionID, callID, tool }) {
    this.#assertActive()
    const taskID = this.#taskBySession.get(sessionID)
    const task = taskID ? await this.#refreshTaskFromOwnerRef(this.#tasks.get(taskID)) : null
    if (!task) return { managed: false, watermarked: false }
    if (await this.#quarantineUnverifiableAuthorization(task)) {
      throw new Error(`Background Task 授权来源不可验证，拒绝执行工具: ${task.record.taskID}`)
    }
    if (typeof callID !== "string" || callID.trim() === "") throw new Error("Background Task 工具调用缺少 callID")
    return serial(this.#transitions, task.record.taskID, async () => {
      if (sessionID !== task.record.childSessionID) throw new Error(`拒绝陈旧 Background Task Attempt 的工具调用: ${sessionID}`)
      if (![TASK_STATUS_RUNNING, TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION, TASK_STATUS_WAITING_TOOL].includes(task.record.status)) {
        throw new Error(`Background Task 当前状态不允许执行工具: ${task.record.status}`)
      }
      if (taskHasCurrentRoundSideEffect(task.record)) return { managed: true, watermarked: true }
      const previousRevision = task.record.revision
      const nextRecord = taskMetadata({
        ...task.record,
        revision: previousRevision + 1,
        updatedAt: this.#now(),
        sideEffectWatermark: {
          version: 1,
          retryRound: task.record.retryRound,
          attemptNumber: task.record.attemptNumber,
          childSessionID: task.record.childSessionID,
          dispatchMessageID: task.record.dispatchMessageID,
          tool,
          callID,
          at: this.#now(),
        },
      })
      await this.#persistTaskRecord(task, nextRecord, previousRevision)
      this.#acceptTaskRecord(task, nextRecord)
      return { managed: true, watermarked: true }
    })
  }

  async cancel(args, context) {
    return this.#withOwnerPublication(() => this.#cancel(args, context))
  }

  async #cancel(args, context) {
    validateTaskControlArgs({ ...args, action: "cancel" })
    const task = await this.#loadAuthorized(args?.taskID, context, "cancel")
    return this.#cancelTask(task)
  }

  async cancelOwned(sessionID) {
    return this.#withOwnerPublication(() => this.#cancelOwned(sessionID))
  }

  async #cancelOwned(sessionID) {
    if (this.#disposed) throw new Error("后台 Task Runtime 已释放")
    const children = await this.#ownedTasks([sessionID])
    for (const child of children) {
      if (!isTerminalTaskStatus(child.record.status)) cancellationFences.set(taskFenceKey(this.#directory, child.record.taskID), child.record.cancellationRequestedAt ?? this.#now())
    }
    const settled = await Promise.allSettled(children.map(async (child) => {
      await this.#cancelTask(child, "所属受管 Session 已终止")
      if (!isTerminalTaskStatus(child.record.status)) await this.#inspect(child.record.taskID)
    }))
    const failure = settled.find((entry) => entry.status === "rejected")
    if (failure) throw failure.reason
    return { stopped: children.every((child) => isTerminalTaskStatus(child.record.status)) }
  }

  async #ownedTasks(sessionIDs) {
    for (const sessionID of sessionIDs) {
      const owner = await this.#store.get(sessionID).catch((error) => {
        if (missingSessionError(error)) return null
        throw error
      })
      if (!owner) {
        for (const child of await this.#store.children(sessionID)) {
          const persisted = sessionO4E(child).task
          if (persisted?.ownerSessionID === sessionID) await this.#loadTask(normalizeTaskMetadata(persisted), child)
        }
      }
      for (const [taskID, ref] of Object.entries(normalizeTaskGroupMetadata(sessionO4E(owner).backgroundTasks).taskRefs)) {
        await this.#hydrateOwnerRef(sessionID, taskID, ref)
      }
    }
    return [...this.#tasks.values()].filter((task) => sessionIDs.includes(task.record.ownerSessionID))
  }

  async #cancelOwnedTasks(task, reason, lineage = new Set()) {
    if (lineage.has(task.record.taskID)) throw new Error("Task owner chain contains a cycle")
    const nextLineage = new Set([...lineage, task.record.taskID])
    const children = await this.#ownedTasks(taskAttemptSessionIDs(task.record))
    for (const child of children) {
      if (!isTerminalTaskStatus(child.record.status)) {
        cancellationFences.set(taskFenceKey(this.#directory, child.record.taskID), child.record.cancellationRequestedAt ?? this.#now())
      }
    }
    const settled = await Promise.allSettled(children.map(async (child) => {
      await this.#cancelTask(child, reason, nextLineage)
      if (!isTerminalTaskStatus(child.record.status)) await this.#inspect(child.record.taskID, { ancestry: nextLineage })
    }))
    const failure = settled.find((entry) => entry.status === "rejected")
    if (failure) throw failure.reason
    return children.every((child) => isTerminalTaskStatus(child.record.status))
  }

  async #cancelTask(task, reason, lineage = new Set(), { propagateFailure = false } = {}) {
    if (isTerminalTaskStatus(task.record.status)) return structuredClone(task.record)
    const removedBeforeDispatch = task.record.status === TASK_STATUS_QUEUED && this.#scheduler.removeQueued(task.record)
    const cancelAllAttempts = task.record.requiresAllAttemptsStopped === true
    this.#retainSlot(task)
    const cancellationRequestedAt = task.record.cancellationRequestedAt ?? this.#now()
    cancellationFences.set(taskFenceKey(this.#directory, task.record.taskID), cancellationRequestedAt)
    await this.#markTaskRefCancellation(task, cancellationRequestedAt)
    await this.#setCancellationStatus(task, TASK_STATUS_CANCELLING, cancelAllAttempts ? "all-attempts-cancelling" : "cancelling", cancellationRequestedAt, {
      cancellationRequestedAt,
      diagnostics: [...task.record.diagnostics, taskDiagnostic(
        removedBeforeDispatch ? "cancelled-before-dispatch" : "cancellation-requested",
        reason || (removedBeforeDispatch ? "Task 在 dispatch 前取消" : "收到取消请求"),
        this.#now(),
      )],
    })
    if (isTerminalTaskStatus(task.record.status)) {
      this.#releaseTerminal(task)
      return structuredClone(task.record)
    }
    await this.#markAttemptCancellations(task, cancellationRequestedAt)
    task.scopeAbort?.abort(new Error("Task 已请求取消"))
    const descendants = await this.#cancelOwnedTasks(task, reason ?? "祖先 Task 已取消", lineage)
      .then((stopped) => ({ stopped }), (error) => ({ stopped: false, error }))
    try {
      const acknowledged = cancelAllAttempts
        ? await this.#cancelAllAttempts(task)
        : (await this.#execution.cancelTurn({ sessionID: task.record.childSessionID }))?.acknowledged !== false
      if (!acknowledged) {
        await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", "宿主未确认取消请求", this.#now())],
        })
      } else if (descendants.error) {
        throw descendants.error
      } else if (removedBeforeDispatch) {
        await this.#inspect(task.record.taskID)
      }
    } catch (error) {
      await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
        diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", errorText(error), this.#now())],
      })
      if (propagateFailure) throw error
    }
    return structuredClone(task.record)
  }

  async observeEvent(event, { dispatch = true } = {}) {
    return this.#withOwnerPublication(() => this.#observeEventBoundary(event, { dispatch }))
  }

  async #observeEventBoundary(event, { dispatch = true } = {}) {
    if (this.#disposed) return
    const sessionID = sessionIDFromEvent(event)
    let sharedOwnerSessionID
    let managed = Boolean(this.#taskBySession.get(sessionID))
      || [...this.#tasks.values()].some((task) => task.record.ownerSessionID === sessionID)
    if (!managed && !this.#quiescing && sessionID) {
      const scheduled = this.#scheduler.recordForSession?.(sessionID, "agent")
      if (scheduled?.taskSessionID) {
        const recovered = await this.recoverSession(scheduled.taskSessionID, { dispatch: false })
        sharedOwnerSessionID = recovered.ownerSessionID
        managed = Boolean(this.#taskBySession.get(sessionID))
          || [...this.#tasks.values()].some((task) => task.record.ownerSessionID === sessionID)
      }
    }
    if (!managed || this.#quiescing) return { managed }
    return this.#track((async () => {
      if (!dispatch) this.#dispatchSuspensions += 1
      let observed = false
      try {
        const result = await this.#observeEvent(event)
        observed = true
        const ownerSessionID = result?.ownerSessionID ?? sharedOwnerSessionID
        if (dispatch) this.dispatchRecoverableTasks(ownerSessionID)
        return result?.managed || !sharedOwnerSessionID ? result : { managed: true, ownerSessionID }
      } catch (error) {
        this.#discardDeferredDispatch(this.#tasks.get(this.#taskBySession.get(sessionID))?.record.ownerSessionID ?? sharedOwnerSessionID ?? sessionID)
        throw error
      } finally {
        if (!dispatch) this.#dispatchSuspensions -= 1
        if (observed) this.#resumeDeferredDispatch()
      }
    })())
  }

  async #observeEvent(event) {
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return
    if (event.kind === "deleted") {
      const ownedTasks = [...this.#tasks.values()].filter((entry) => entry.record.ownerSessionID === sessionID && !isTerminalTaskStatus(entry.record.status))
      if (ownedTasks.length > 0) {
        await this.#handleOwnerDeleted(ownedTasks)
        if (!this.#taskBySession.has(sessionID)) return { managed: true, ownerSessionID: ownedTasks[0].record.ownerSessionID }
      }
    }
    const taskID = this.#taskBySession.get(sessionID)
    const loadedTask = taskID ? this.#tasks.get(taskID) : await this.#loadOwnTask(sessionID)
    // Invalidate an in-flight inspection before reloading its staged write.
    // Otherwise a new busy event can hydrate a not-yet-committed terminal
    // record, skip reconciliation, or publish its provisional receipt.
    if (loadedTask && this.#transitions.has(loadedTask.record.taskID)) await this.#beginObservation(loadedTask)
    const task = loadedTask ? await this.#refreshTaskFromOwnerRef(loadedTask) : null
    if (!task) return { managed: false }
    const managedTask = { managed: true, ownerSessionID: task.record.ownerSessionID }
    if (await this.#quarantineUnverifiableAuthorization(task)) {
      await this.#reconcileAuthorizationQuarantine(task)
      return managedTask
    }
    if (event.kind === "deleted" && sessionID === task.record.taskSessionID && sessionID !== task.record.childSessionID) {
      await this.#separateLedger(task, sessionID)
      return managedTask
    }
    if (event.kind === "deleted" && sessionID === task.record.childSessionID) {
      if (!isTerminalTaskStatus(task.record.status)) this.#blockMissingTaskDispatch(task, sessionID)
      const observation = await this.#beginObservation(task)
      if (sessionID === task.record.taskSessionID) {
        await this.#persistMissingTaskTombstone(task)
      } else if (!task.record.requiresAllAttemptsStopped && !cancellationPending(this.#directory, task.record)) {
        await this.#setStatus(task, TASK_STATUS_UNKNOWN, "missing-session", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("session-missing", "当前 Attempt Session 不存在，无法证明执行结果", this.#now())],
        })
      }
      if (task.record.requiresAllAttemptsStopped || cancellationPending(this.#directory, task.record)) {
        await this.#inspect(task.record.taskID, {
          inspectionClaim: { ...this.#inspectionClaim(task), observationEpoch: observation.observationEpoch },
        })
      } else if (this.#recordOccupiesSlot(task.record)) {
        this.#retainConservativeLock(task)
        this.#retainSlot(task)
      }
      else this.#releaseSlot(task)
      return managedTask
    }
    if (task.record.requiresAllAttemptsStopped || cancellationPending(this.#directory, task.record)) {
      const observation = await this.#beginObservation(task)
      await this.#inspect(task.record.taskID, { inspectionClaim: observation })
      return managedTask
    }
    if (sessionID !== task.record.childSessionID) return managedTask
    if (isTerminalTaskStatus(task.record.status)) {
      const managed = event.kind === "error" && ["before-resolution", "before-fallback"].includes(event.phase)
      return { managed, ...(managed ? { ownerSessionID: task.record.ownerSessionID } : {}) }
    }
    const observation = await this.#beginObservation(task)
    if (event.kind === "error" && ["before-resolution", "before-fallback"].includes(event.phase)) {
      if (task.record.status === TASK_STATUS_CANCELLING) {
        await this.#inspect(task.record.taskID)
        return managedTask
      }
      if (task.record.status === TASK_STATUS_STARTING || task.record.status === TASK_STATUS_RETRYING) return managedTask
      let inspectionClaim = observation
      let inspection
      try {
        inspection = await this.#execution.inspectTurn({
          sessionID: inspectionClaim.childSessionID,
          dispatchMessageID: inspectionClaim.dispatchMessageID,
        })
      } catch (inspectionError) {
        if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return managedTask
        await this.#setStatus(task, TASK_STATUS_UNKNOWN, "inspection-failed", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("inspection-failed", errorText(inspectionError), this.#now())],
        }, { inspectionClaim })
        return managedTask
      }
      if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return managedTask
      if ([TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION].includes(inspectionClaim.status)) {
        const reconciled = inspection?.pendingRequests
          ? await this.#reconcilePendingRequests(task, inspection.pendingRequests, { inspectionClaim })
          : await this.#reconcilePendingRequests(task, undefined, { inspectionClaim })
        if (reconciled.changed) inspectionClaim = this.#inspectionClaim(task)
        if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return managedTask
        if (reconciled.waiting) return managedTask
        if (this.#unverifiedInteraction(task, reconciled) && inspection?.state === "idle") {
          await this.#interruptUnverifiedInteraction(task, reconciled, event.error, { inspectionClaim })
          return managedTask
        }
      }
      if (inspection?.error) await this.#handleModelError(task, inspection.error, { inspectionClaim })
      else if (inspection?.result) await this.#complete(task, inspection.result, { inspectionClaim })
      else if (inspection?.state !== "running" && inspection?.state !== "retrying") {
        const unknown = await this.#setStatus(task, TASK_STATUS_UNKNOWN, "model-error-unattributed", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("model-error-unattributed", errorText(event.error), this.#now())],
        }, { inspectionClaim })
        }
      return managedTask
    }
    if (event.kind === "permission-waiting") {
      if (event.request) await this.#upsertPendingRequest(task, event.request)
      else await this.#setStatus(task, TASK_STATUS_WAITING_PERMISSION, "permission-waiting")
      return managedTask
    }
    if (event.kind === "question-waiting") {
      if (event.request) await this.#upsertPendingRequest(task, event.request)
      else await this.#setStatus(task, TASK_STATUS_WAITING_QUESTION, "question-waiting")
      return managedTask
    }
    const activeStatus = event.kind === "session-status" && (event.status?.type === "busy" || event.status?.type === "retry")
    if (event.kind === "session-resumed") {
      const reconciled = await this.#reconcilePendingRequests(task, undefined, {
        resolvedRequest: event.requestID && event.interactionKind
          ? { requestID: event.requestID, kind: event.interactionKind }
          : undefined,
      })
      if (reconciled.waiting) return managedTask
    }
    if (event.kind === "session-resumed" || activeStatus) {
      const resumedFromWait = observation.status === TASK_STATUS_WAITING_PERMISSION || observation.status === TASK_STATUS_WAITING_QUESTION
      const desiredStatus = event.status?.type === "retry" ? TASK_STATUS_RETRYING : TASK_STATUS_RUNNING
      if (activeStatus || resumedFromWait) {
        task.observedActive = true
        this.#markLiveAttemptActive(task)
        const desiredPhase = event.status?.type === "retry" ? "model-retrying" : "model-running"
        const weakInspectionState = (
          (observation.status === TASK_STATUS_WAITING_RETRY_DECISION && observation.phase === "execution-interrupted")
          || (observation.status === TASK_STATUS_UNKNOWN && ["missing-session", "dispatch-unconfirmed", "inspection-failed"].includes(observation.phase))
        )
        const activeLifecycleState = [TASK_STATUS_RUNNING, TASK_STATUS_RETRYING].includes(observation.status)
          && ["model-running", "model-retrying", "completion-settling"].includes(observation.phase)
        if (resumedFromWait || weakInspectionState || activeLifecycleState) {
          const resumed = await this.#setStatus(task, desiredStatus, desiredPhase, { retryDecision: undefined, endedAt: undefined }, {
            skipIf: (record) => !this.#sameInspectionAttempt(task, observation)
              || (record.status === desiredStatus && record.phase === desiredPhase),
          })
          if (resumed) this.#retainSlot(task)
        }
      }
      return managedTask
    }
    await this.#inspect(taskID, { inspectionClaim: observation })
    return managedTask
  }

  async #run(taskID) {
    let task = this.#tasks.get(taskID)
    if (!task) {
      const scheduled = this.#scheduler.record?.(taskID)
      if (scheduled?.taskSessionID) {
        await this.recoverSession(scheduled.taskSessionID, { dispatch: true })
        task = this.#tasks.get(taskID)
      }
    }
    if (!task || this.#disposed || this.#quiescing || task.dispatchBlockedByMissingSession || isTerminalTaskStatus(task.record.status)) return
    const dispatchEpoch = task.dispatchEpoch
    try {
      if (!task.lockAcquired) {
        const authorizationClaim = task.record
        try {
          task.prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
        } catch (error) {
          if (task.dispatchEpoch !== dispatchEpoch) return
          await this.#rejectDispatchAuthorization(task, authorizationClaim, error)
          return
        }
        if (task.dispatchEpoch !== dispatchEpoch || this.#deferDispatchIfPaused(task)) return
        await this.#locks.acquire(task.lockID, {
          kind: task.record.effect,
          writeScopes: task.record.writeScopes,
        }, { signal: task.scopeAbort?.signal, parentLockID: task.prepared.parentLockID })
        task.lockAcquired = true
      }
      if (task.dispatchEpoch !== dispatchEpoch) return
      if (this.#disposed || this.#quiescing || task.dispatchBlockedByMissingSession || isTerminalTaskStatus(task.record.status)) {
        if (task.dispatchBlockedByMissingSession) {
          if (!task.retainConservativeLock && task.lockAcquired) {
            task.lockAcquired = false
            this.#locks.release(task.lockID)
          }
          return
        }
        this.#releaseTerminal(task)
        return
      }
      if (cancellationPending(this.#directory, task.record)) {
        if (task.record.requiresAllAttemptsStopped) await this.#cancelAllAttempts(task).catch(() => undefined)
        else await this.#execution.cancelTurn({ sessionID: task.record.childSessionID }).catch(() => undefined)
        await this.#inspect(task.record.taskID)
        return
      }
      if (modelFallbackDispatchPending(task)) {
        await this.#pauseAutomaticModelFallback(task)
        return
      }
      if (retryDispatchPending(task)) {
        await this.#resumeResolvedRetry(task)
        return
      }
      if (task.record.status !== TASK_STATUS_QUEUED || !["queued", "input-queued"].includes(task.record.phase)) return
      const claim = task.record
      const continuation = task.record.phase === "input-queued"
      await this.#dispatchTurn(task, {
        claim,
        phase: continuation ? "input-starting" : "starting",
        messageID: task.record.dispatchMessageID,
        model: task.record.currentModel,
        parts: this.#delegationParts(task),
        extra: { startedAt: task.record.startedAt ?? this.#now() },
      })
    } catch (error) {
      if (this.#disposed) return
      if (task.dispatchBlockedByMissingSession) return
      if (this.#quiescing) {
        if (!task.lockAcquired) task.scopeAbort = new AbortController()
        return
      }
      if (task.record.status === TASK_STATUS_CANCELLED) return
      if (cancellationPending(this.#directory, task.record)) {
        await this.#inspect(task.record.taskID)
        if (cancellationPending(this.#directory, task.record) && task.record.status !== TASK_STATUS_UNKNOWN) {
          await this.#setStatus(task, TASK_STATUS_UNKNOWN, "dispatch-unconfirmed", {
            diagnostics: [...task.record.diagnostics, taskDiagnostic("dispatch-unconfirmed", errorText(error), this.#now())],
          })
        }
        return
      }
      await this.#setStatus(task, TASK_STATUS_UNKNOWN, "dispatch-unconfirmed", {
        diagnostics: [...task.record.diagnostics, taskDiagnostic("dispatch-unconfirmed", errorText(error), this.#now())],
      })
    }
  }

  async #recoverSteerInputs(task) {
    const entries = (task.record.activeInputs ?? []).filter((entry) => entry?.delivery === "steer")
    if (entries.length === 0) return
    for (const entry of entries) {
      const messageID = typeof entry.messageID === "string" && entry.messageID
        ? entry.messageID
        : `o4e_steer_${task.record.taskID}_${Number.isSafeInteger(entry.revision) ? entry.revision : task.record.revision}`
      const claim = task.record
      let accepted = false
      let admissionError
      if (task.record.childSessionID && typeof this.#execution.steerTurn === "function") {
        const admission = await this.#admitSteerDispatch(task, claim, entry)
        admissionError = admission.error
        if (admission.admitted) {
          try {
            accepted = (await this.#execution.steerTurn({
              sessionID: task.record.childSessionID,
              messageID,
              text: entry.text,
            }))?.accepted === true
          } catch (error) {
            admissionError = error
            accepted = false
          }
        }
      }
      if (task.record.revision !== claim.revision || task.record.status !== claim.status || task.record.phase !== claim.phase
        || task.record.childSessionID !== claim.childSessionID || task.record.dispatchMessageID !== claim.dispatchMessageID
        || task.record.attemptNumber !== claim.attemptNumber || cancellationPending(this.#directory, task.record)) return
      const activeInputs = (task.record.activeInputs ?? []).filter((candidate) => !(
        candidate?.delivery === "steer"
        && (candidate.messageID && messageID
          ? candidate.messageID === messageID
          : candidate.createdAt === entry.createdAt && candidate.text === entry.text)
      ))
      if (accepted) {
        await this.#setStatus(task, task.record.status, task.record.phase, { activeInputs }, { expectedRevision: task.record.revision })
        continue
      }
      const pendingInputs = [...(task.record.pendingInputs ?? []), {
        version: 1,
        text: entry.text,
        createdAt: entry.createdAt ?? this.#now(),
      }].slice(-TASK_PENDING_INPUT_LIMIT)
      await this.#setStatus(task, task.record.status, task.record.phase, {
        activeInputs,
        pendingInputs,
        diagnostics: [...task.record.diagnostics, taskDiagnostic("steer-admission-unconfirmed", admissionError
          ? `恢复时 steer 派发准入或宿主确认失败，已转入 next-turn 队列: ${errorText(admissionError)}`
          : "恢复时未确认 steer 已被宿主接收，已转入 next-turn 队列", this.#now())],
      }, { expectedRevision: task.record.revision })
    }
  }

  async #admitSteerDispatch(task, claim, entry) {
    const dispatchEpoch = task.dispatchEpoch
    let prepared
    try {
      prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
      await this.#refreshTaskRecord(task)
    } catch (error) {
      return { admitted: false, error }
    }
    const entryCurrent = (task.record.activeInputs ?? []).some((candidate) => candidate?.delivery === "steer" && (
      candidate.messageID && entry.messageID
        ? candidate.messageID === entry.messageID
        : candidate.createdAt === entry.createdAt && candidate.text === entry.text
    ))
    if (this.#disposed || this.#quiescing || task.dispatchEpoch !== dispatchEpoch || task.dispatchBlockedByMissingSession
      || cancellationPending(this.#directory, task.record) || !entryCurrent
      || task.record.revision !== claim.revision || task.record.status !== claim.status || task.record.phase !== claim.phase
      || task.record.childSessionID !== claim.childSessionID || task.record.dispatchMessageID !== claim.dispatchMessageID
      || task.record.runGeneration !== claim.runGeneration || task.record.attemptNumber !== claim.attemptNumber
      || task.record.retryRound !== claim.retryRound) {
      return { admitted: false, error: new Error("Task steer 派发准入期间状态已变化") }
    }
    task.prepared = prepared
    return { admitted: true }
  }

  #delegationParts(task, recoveryContext) {
    const inputs = task.record.status === TASK_STATUS_QUEUED
      ? task.record.pendingInputs ?? []
      : (task.record.activeInputs ?? []).filter((entry) => entry.delivery !== "steer")
    const continuation = inputs.length > 0 && task.record.runGeneration > 0 && !recoveryContext
    const prompt = buildDelegationPrompt({
      task: continuation
        ? "Continue from the existing results using only the new input below. Do not replay completed work or side effects."
        : task.prepared?.args?.task ?? "Resume the managed background task.",
      recoveryContext: continuation ? undefined : recoveryContext ?? task.prepared?.args?.recoveryContext,
      outputContract: task.prepared?.args?.outputContract,
      delegationContext: delegationPromptContext(task.prepared),
    })
    return [{
      type: "text",
      synthetic: true,
      text: inputs.length > 0
        ? `${prompt}\n\n${inputs.map((entry) => entry.text).join("\n\n")}`
        : prompt,
    }]
  }

  async #dispatchTurn(task, { claim, phase, messageID, model, parts, extra = {} }) {
    if (this.#quiescing || this.#disposed || this.#deferDispatchIfPaused(task)) return { claimed: false }
    const dispatchToken = beginDispatch(this.#directory, task.record.taskID)
    const dispatchEpoch = task.dispatchEpoch
    try {
      try {
        task.prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
      } catch (error) {
        if (task.dispatchEpoch !== dispatchEpoch) return { claimed: false }
        await this.#rejectDispatchAuthorization(task, claim, error)
        return { claimed: false }
      }
      if (task.dispatchEpoch !== dispatchEpoch) return { claimed: false }
      if (this.#quiescing || this.#disposed || this.#deferDispatchIfPaused(task)) return { claimed: false }
      const agentIdentityChanged = task.record.agent !== task.prepared.target.name
        || task.record.authorizationFingerprint !== task.prepared.authorizationFingerprint
      const claimed = await this.#claimDispatch(task, claim, phase, {
        ...extra,
        ...(agentIdentityChanged ? { agent: task.prepared.target.name, authorizationFingerprint: task.prepared.authorizationFingerprint } : {}),
        dispatchMessageID: messageID,
        currentModel: model,
        attemptNumber: claim.attemptNumber + 1,
        ...(["starting", "input-starting"].includes(phase)
          ? { activeInputs: claim.pendingInputs ?? [], pendingInputs: [] }
          : {}),
      }, dispatchEpoch)
      if (task.dispatchEpoch !== dispatchEpoch) {
        if (claimed) task.dispatchUnconfirmed = true
        return { claimed: false }
      }
      if (!claimed) {
        this.#redispatchIfPending(task)
        return { claimed: false }
      }
      if (this.#quiescing || this.#disposed) {
        await this.#rollbackQuiescedDispatch(task, claim, claimed)
        return { claimed: false }
      }
      if (
        task.dispatchBlockedByMissingSession
        ||
        task.record.revision !== claimed.revision
        || task.record.status !== TASK_STATUS_STARTING
        || task.record.phase !== phase
        || task.record.childSessionID !== claimed.childSessionID
        || task.record.dispatchMessageID !== messageID
      ) return { claimed: false }
      if (cancellationPending(this.#directory, task.record)) return { claimed: false }
      if (agentIdentityChanged) await this.#publishTaskRecoveryReference(task)
      if (task.dispatchEpoch !== dispatchEpoch) {
        task.dispatchUnconfirmed = true
        return { claimed: false }
      }
      task.dispatchPending = true
      task.dispatchUnconfirmed = true
      task.recovered = false
      task.observedActive = false
      task.observationEpoch = (task.observationEpoch ?? 0) + 1
      this.#claimLiveAttempt(task, "awaiting-host-activation")
      try {
        await this.#execution.startTurn({
          sessionID: claimed.childSessionID,
          messageID,
          agent: task.prepared.target.name,
          model,
          parts,
        })
        task.dispatchUnconfirmed = false
      } finally {
        task.dispatchPending = false
      }
      await this.#refreshTaskRecord(task)
      if (isTerminalTaskStatus(task.record.status)) {
        this.#releaseTerminal(task)
        return
      }
      if (cancellationPending(this.#directory, task.record)) {
        try {
          const acknowledged = task.record.requiresAllAttemptsStopped
            ? await this.#cancelAllAttempts(task)
            : (await this.#execution.cancelTurn({ sessionID: task.record.childSessionID }))?.acknowledged !== false
          if (!acknowledged) throw new Error("宿主未确认取消请求")
          await this.#inspect(task.record.taskID)
        } catch (error) {
          await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
            diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", errorText(error), this.#now())],
          })
        }
        return
      }
      if (task.record.status !== TASK_STATUS_STARTING || task.record.dispatchMessageID !== messageID) return
      await this.#setStatus(task, TASK_STATUS_RUNNING, "model-running")
      return { claimed: true }
    } finally {
      endDispatch(this.#directory, task.record.taskID, dispatchToken)
      if (!this.#disposed && cancellationPending(this.#directory, task.record)) {
        await this.#inspect(task.record.taskID).catch(() => undefined)
      }
    }
  }

  async #claimDispatch(task, claim, phase, extra, dispatchEpoch) {
    return serial(this.#transitions, task.record.taskID, async () => {
      if (
        this.#quiescing
        || this.#disposed
        || task.dispatchEpoch !== dispatchEpoch
        || task.dispatchBlockedByMissingSession
        ||
        cancellationPending(this.#directory, task.record)
        ||
        task.record.revision !== claim.revision
        || task.record.status !== claim.status
        || task.record.phase !== claim.phase
        || task.record.childSessionID !== claim.childSessionID
        || task.record.dispatchMessageID !== claim.dispatchMessageID
        || task.record.retryRound !== claim.retryRound
      ) return null
      const nextRecord = taskMetadata({
        ...task.record,
        ...extra,
        revision: claim.revision + 1,
        status: TASK_STATUS_STARTING,
        phase,
        updatedAt: this.#now(),
      })
      await this.#persistTaskRecord(task, nextRecord, claim.revision)
      this.#acceptTaskRecord(task, nextRecord)
      return nextRecord
    })
  }

  async #rollbackQuiescedDispatch(task, claim, claimed) {
    await serial(this.#transitions, task.record.taskID, async () => {
      if (
        task.record.revision !== claimed.revision
        || task.record.status !== TASK_STATUS_STARTING
        || task.record.phase !== claimed.phase
      ) return
      const nextRecord = taskMetadata({
        ...task.record,
        ...claim,
        revision: task.record.revision + 1,
        updatedAt: this.#now(),
      })
      await this.#persistTaskRecord(task, nextRecord, task.record.revision)
      this.#acceptTaskRecord(task, nextRecord)
    })
  }

  async #rejectDispatchAuthorization(task, claim, error) {
    const unverifiable = this.#authorizationUnverifiable(task)
    if (!unverifiable) {
      const settled = await this.#stopChildrenForFailure(task, { expectedRevision: claim.revision })
      if (!settled) return null
      if (settled.expectedRevision !== claim.revision) claim = task.record
    }
    const rejected = await serial(this.#transitions, task.record.taskID, async () => {
      if (
        (cancellationPending(this.#directory, task.record) && !unverifiable)
        ||
        task.record.revision !== claim.revision
        || task.record.status !== claim.status
        || task.record.phase !== claim.phase
        || task.record.childSessionID !== claim.childSessionID
        || task.record.dispatchMessageID !== claim.dispatchMessageID
      ) return null
      const nextRecord = taskMetadata({
        ...task.record,
        revision: claim.revision + 1,
        status: unverifiable ? TASK_STATUS_UNKNOWN : TASK_STATUS_FAILED,
        phase: unverifiable ? "authorization-unverifiable" : "authorization-changed",
        updatedAt: this.#now(),
        ...(unverifiable ? { endedAt: undefined, result: undefined, receipt: undefined } : { endedAt: this.#now() }),
        diagnostics: [...task.record.diagnostics, taskDiagnostic(unverifiable ? "authorization-unverifiable" : "authorization-changed", errorText(error), this.#now())],
      })
      await this.#persistTaskRecord(task, nextRecord, claim.revision)
      this.#acceptTaskRecord(task, nextRecord)
      return nextRecord
    })
    if (rejected) {
      if (unverifiable) {
        await this.#publishTaskRecoveryReference(task, { preserveReceipts: false }).catch((error) => {
          if (!missingSessionError(error)) throw error
        })
        const neverHostSubmitted = claim.status === TASK_STATUS_QUEUED
          && claim.attemptNumber === 0
          && !dispatchPending(this.#directory, claim.taskID)
          && !task.dispatchPending
          && !task.dispatchUnconfirmed
        if (neverHostSubmitted) {
          const withdrawn = this.#scheduler.withdraw(task.record)
          task.slotReleased = true
          if (task.lockAcquired) {
            task.lockAcquired = false
            this.#locks.release(task.lockID)
          }
          this.#dispatch(withdrawn.admitted)
        } else {
          this.#retainSlot(task)
          this.#retainConservativeLock(task)
        }
      } else this.#releaseTerminal(task)
    }
    return rejected
  }

  #authorizationUnverifiable(task) {
    const prepared = task.prepared
    if (!task.record.authorizationFingerprint || !prepared?.authorizationFingerprint) return true
    if (task.record.authorizationFingerprint !== prepared.authorizationFingerprint) return true
    if (!Number.isSafeInteger(prepared.depth) || prepared.depth < 1) return true
    if (!prepared.requester?.name || prepared.requester.name === "unknown" || !prepared.target?.name) return true
    if (task.record.requesterAgent !== prepared.requester.name) return true
    if (task.record.requesterPermissionPattern !== prepared.requesterPermissionPattern) return true
    if (task.record.requesterPermissionAction !== prepared.requesterPermissionAction) return true
    if (task.record.requesterPermissionApproved !== prepared.requesterPermissionApproved) return true
    if (task.record.agent !== prepared.target.name) return true
    if (prepared.toolName !== AGENT_TASK_TOOL || prepared.requesterPermissionPattern !== prepared.target.name) return true
    if (prepared.effect?.kind !== task.record.effect) return true
    if (!prepared.overlay || typeof prepared.overlay !== "object" || Array.isArray(prepared.overlay)) return true
    if (!Array.isArray(prepared.normalizedScopes)) return true
    if (JSON.stringify(prepared.normalizedScopes) !== JSON.stringify(task.record.writeScopes ?? [])) return true
    const trace = prepared.args?.trace
    if (!trace || typeof trace !== "object" || Array.isArray(trace)) return true
    if (trace.taskID !== task.record.taskID || trace.ownerSessionID !== task.record.ownerSessionID) return true
    return !(
      (prepared.requesterPermissionAction === "allow" && prepared.requesterPermissionApproved === false)
      || (prepared.requesterPermissionAction === "ask" && prepared.requesterPermissionApproved === true)
    )
  }

  async #quarantineUnverifiableAuthorization(task) {
    if (!task) return false
    if (task.record.status === TASK_STATUS_UNKNOWN && task.record.phase === "authorization-unverifiable") {
      if (this.#recordOccupiesSlot(task.record)) {
        this.#retainSlot(task)
        this.#retainConservativeLock(task)
      }
      return true
    }
    if (!this.#authorizationUnverifiable(task)) return false
    await this.#rejectDispatchAuthorization(task, task.record, new Error("Task 缺少可验证的 canonical task 冻结授权上下文"))
    return true
  }

  async #reconcileAuthorizationQuarantine(task) {
    if (
      task.record.status !== TASK_STATUS_UNKNOWN
      || task.record.phase !== "authorization-unverifiable"
      || !this.#recordOccupiesSlot(task.record)
      || dispatchPending(this.#directory, task.record.taskID)
      || task.dispatchPending
    ) return false
    const inspectionClaim = await this.#beginObservation(task)
    const attemptSessionIDs = taskAttemptSessionIDs(task.record)
    const stopped = attemptSessionIDs.length === 0 ? null : await this.#allAttemptsStopped(task, inspectionClaim)
    if (!this.#inspectionClaimCurrent(task, inspectionClaim) || stopped !== true) return false
    const released = await this.#setStatus(task, TASK_STATUS_UNKNOWN, "authorization-unverifiable", {
      endedAt: task.record.endedAt ?? this.#now(),
      diagnostics: [...task.record.diagnostics, taskDiagnostic(
        "authorization-quarantine-stopped",
        "宿主已证明授权隔离 Task 的全部相关 Attempt 停止，仅释放本地 admission 与 Scope Lock",
        this.#now(),
      )],
    }, { inspectionClaim })
    if (!released) return false
    this.#releaseSlot(task)
    if (task.lockAcquired) {
      task.lockAcquired = false
      this.#locks.release(task.lockID)
    }
    return true
  }

  async #handleModelError(task, error, { inspectionClaim } = {}) {
    if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return
    if (cancellationPending(this.#directory, task.record)) return
    if (task.record.handledModelErrorAttempt >= task.record.attemptNumber) return
    const expectedRevision = task.record.revision
    const attemptNumber = task.record.attemptNumber
    const at = this.#now()
    const failedModelCandidates = normalizeModelRefs([
      ...(task.record.failedModelCandidates ?? []),
      ...(task.record.currentModel ? [task.record.currentModel] : []),
    ])
    const handledModelErrorAttempt = attemptNumber
    const retryable = isRetryableModelError(error)
    const fallbackAvailable = nextTaskModelCandidate({ ...task.record, failedModelCandidates }) !== null
    const code = taskHasCurrentRoundSideEffect(task.record)
      ? "model-error-after-side-effect"
      : fallbackAvailable
        ? "model-error-fallback-available"
        : retryable
          ? "model-error-retryable"
          : "model-error-non-retryable"
    await this.#claimModelError(task, expectedRevision, TASK_STATUS_WAITING_RETRY_DECISION, code, {
      handledModelErrorAttempt,
      failedModelCandidates,
      retryDecision: {
        status: "pending",
        retryRound: task.record.retryRound,
        attemptNumber: task.record.attemptNumber,
        requestedAt: at,
        error: errorText(error),
      },
      diagnostics: [
        ...task.record.diagnostics,
        taskDiagnostic(retryable ? "retryable-model-error" : "model-error", errorText(error), at),
        taskDiagnostic(code, errorText(error), at),
      ],
    }, { inspectionClaim })
  }

  async #pauseAutomaticModelFallback(task) {
    if (!modelFallbackDispatchPending(task)) return null
    const at = this.#now()
    const attemptNumber = Math.max(1, task.record.attemptNumber)
    const priorError = [...(task.record.diagnostics ?? [])].toReversed()
      .find((diagnostic) => diagnostic.code === "retryable-model-error" || diagnostic.code === "model-error")?.message
      ?? "模型错误已记录；O4E 自动 fallback 已停用"
    return this.#setStatus(task, TASK_STATUS_WAITING_RETRY_DECISION, "model-error-fallback-available", {
      retryDecision: {
        status: "pending",
        retryRound: task.record.retryRound,
        attemptNumber,
        requestedAt: at,
        error: priorError,
      },
      diagnostics: [...task.record.diagnostics, taskDiagnostic(
        "automatic-model-fallback-disabled",
        "冻结 fallback 候选已保留，等待 owner 显式 resolve continue、restart 或 stop",
        at,
      )],
    })
  }

  async #claimModelError(task, expectedRevision, status, phase, extra, { inspectionClaim } = {}) {
    if (status === TASK_STATUS_FAILED) {
      const settled = await this.#stopChildrenForFailure(task, { expectedRevision, inspectionClaim })
      if (!settled) return null
      ;({ expectedRevision, inspectionClaim } = settled)
    }
    return serial(this.#transitions, task.record.taskID, async () => {
      if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return null
      if (cancellationPending(this.#directory, task.record) || task.record.revision !== expectedRevision || task.record.handledModelErrorAttempt >= task.record.attemptNumber) return null
      const previousRecord = task.record
      const nextRecord = taskMetadata({
        ...task.record,
        ...extra,
        revision: expectedRevision + 1,
        status,
        phase,
        updatedAt: this.#now(),
      })
      await this.#persistTaskRecord(task, nextRecord, expectedRevision)
      this.#acceptTaskRecord(task, nextRecord)
      if (inspectionClaim && (task.observationEpoch ?? 0) !== inspectionClaim.observationEpoch) {
        await this.#restoreAfterStaleInspection(task, previousRecord, nextRecord)
        return null
      }
      return nextRecord
    })
  }

  async #resumeResolvedRetry(task) {
    const dispatchEpoch = task.dispatchEpoch
    try {
      const authorizationClaim = task.record
      try {
        task.prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
      } catch (error) {
        if (task.dispatchEpoch !== dispatchEpoch) return
        await this.#rejectDispatchAuthorization(task, authorizationClaim, error)
        return
      }
      if (task.dispatchEpoch !== dispatchEpoch) return
      if (task.record.revision !== authorizationClaim.revision || !retryDispatchPending(task)
        || cancellationPending(this.#directory, task.record)) return
      if (this.#quiescing || this.#disposed || this.#deferDispatchIfPaused(task)) return
      const decision = task.record.retryDecision?.decision
      if (decision !== "continue" && decision !== "restart") throw new Error("Task 缺少可执行的 retry decision")
      let childSessionID = task.record.childSessionID
      let attemptSessionIDs = task.record.attemptSessionIDs
      const dispatchMessageID = task.record.dispatchMessageID
      const restartCreated = decision === "restart" && task.record.phase === "retry-restart-created-pending"
      if (decision === "restart" && !restartCreated) {
        if (!task.prepared) throw new Error("Task 缺少 restart 所需的持久化委派上下文")
        await this.#separateLedger(task)
        if (task.dispatchEpoch !== dispatchEpoch) return
        if (!retryDispatchPending(task) || task.record.retryDecision?.decision !== decision || task.record.dispatchMessageID !== dispatchMessageID) return
        const pendingRevision = task.record.revision
        const children = await this.#store.children(task.record.ownerSessionID)
        if (task.dispatchEpoch !== dispatchEpoch) return
        const attempts = children.filter((session) => {
          const state = sessionO4E(session)
          const delegation = state.delegation
          return state.kind === "delegation-attempt"
            && delegation?.taskID === task.record.taskID
        })
        const existingAttempts = attempts.filter((session) => sessionO4E(session).delegation.dispatchMessageID === dispatchMessageID)
        if (existingAttempts.length > 1 || (existingAttempts.length === 1 && !this.#restartAttemptMatches(task, existingAttempts[0]))) {
          await this.#setStatus(task, TASK_STATUS_UNKNOWN, "restart-attempt-unverifiable", {
            requiresAllAttemptsStopped: true,
            attemptSessionIDs: [...new Set([...taskAttemptSessionIDs(task.record), ...attempts.map((session) => session.id)])],
            diagnostics: [...task.record.diagnostics, taskDiagnostic("restart-attempt-unverifiable", "Restart Attempt 不唯一或冻结授权不完整，必须核验全部 Attempt 已停止", this.#now())],
          }, { expectedRevision: pendingRevision })
          return
        }
        const existingAttempt = existingAttempts[0]
        if (existingAttempt?.id) childSessionID = existingAttempt.id
        else {
          const attempt = await this.#createOrRecoverAttempt(task.prepared, task.context, {
            taskID: task.record.taskID,
            dispatchMessageID,
            status: TASK_STATUS_RUNNING,
          })
          childSessionID = attempt.child.id
        }
        attemptSessionIDs = [...new Set([...(task.record.attemptSessionIDs ?? []), childSessionID])]
        try {
          await this.#setStatus(task, TASK_STATUS_RETRYING, "retry-restart-created-pending", {
            childSessionID,
            attemptSessionIDs,
            dispatchMessageID,
            currentModel: firstTaskModelCandidate(task.record),
          }, { expectedRevision: pendingRevision })
        } catch (error) {
          if (task.record.revision !== pendingRevision) {
            await this.#execution.cancelTurn({ sessionID: childSessionID }).catch(() => undefined)
            return
          }
          throw error
        }
      }
      const recoveryContext = {
        retryDecision: decision,
        retryRound: task.record.retryRound,
        priorError: task.record.retryDecision?.error,
        duplicateSideEffectRiskAccepted: decision === "restart",
      }
      if (task.dispatchEpoch !== dispatchEpoch) return
      await this.#dispatchTurn(task, {
        claim: task.record,
        phase: `retry-${decision}-starting`,
        messageID: dispatchMessageID,
        model: task.record.currentModel,
        parts: this.#delegationParts(task, recoveryContext),
      })
    } catch (error) {
      if (task.dispatchEpoch !== dispatchEpoch) return
      if (cancellationPending(this.#directory, task.record)) {
        await this.#inspect(task.record.taskID)
        return
      }
      const decision = task.record.retryDecision?.decision ?? "unknown"
      await this.#setStatus(task, TASK_STATUS_UNKNOWN, `retry-${decision}-dispatch-unconfirmed`, {
        diagnostics: [...task.record.diagnostics, taskDiagnostic(`retry-${decision}-dispatch-unconfirmed`, errorText(error), this.#now())],
      })
    }
  }

  #restartAttemptMatches(task, session) {
    return this.#attemptMatches(task.prepared, task.record.ownerSessionID, task.record, session)
  }

  async #createOrRecoverAttempt(prepared, context, options) {
    try {
      return await this.#delegation.createAttempt(prepared, context, options)
    } catch (error) {
      const children = await this.#store.children(context.sessionID)
      const matches = children.filter((session) => {
        const state = sessionO4E(session)
        return state.kind === "delegation-attempt"
          && state.delegation?.taskID === options.taskID
          && state.delegation?.dispatchMessageID === options.dispatchMessageID
      })
      if (matches.length === 1) {
        if (!this.#attemptMatches(prepared, context.sessionID, {
          ...options,
          authorizationFingerprint: prepared.authorizationFingerprint,
          effect: prepared.effect?.kind,
          writeScopes: prepared.normalizedScopes,
        }, matches[0], options.status === TASK_STATUS_QUEUED ? "queued" : "running")) {
          throw new Error(`Background Task Attempt 创建结果授权上下文不匹配: ${options.taskID}/${options.dispatchMessageID}`, { cause: error })
        }
        return {
          child: matches[0],
          createdAt: sessionO4E(matches[0]).delegation?.createdAt,
        }
      }
      if (matches.length > 1) {
        throw new Error(`Background Task Attempt 创建结果不唯一: ${options.taskID}/${options.dispatchMessageID}`, { cause: error })
      }
      throw error
    }
  }

  #attemptMatches(prepared, ownerSessionID, claim, session, status) {
    const state = sessionO4E(session)
    const delegation = state.delegation
    if (state.kind !== "delegation-attempt" || !delegation || !prepared) return false
    return session.parentID === prepared.hostParentID
      && delegation.depth === prepared.depth
      && delegation.maxDelegationDepth === prepared.maxDelegationDepth
      && delegation.remainingDelegationDepth === prepared.remainingDelegationDepth
      && session.agent === prepared.target?.name
       && JSON.stringify(session.permission ?? []) === JSON.stringify(prepared.compiledPermission ?? [])
      && delegation.parentSessionID === ownerSessionID
      && delegation.taskID === claim.taskID
      && delegation.dispatchMessageID === claim.dispatchMessageID
      && (status === undefined || delegation.status === status)
      && delegation.sourceAgent === prepared.requester?.name
      && prepared.toolName === AGENT_TASK_TOOL
      && prepared.requesterPermissionPattern === prepared.target?.name
      && delegation.requesterPermissionPattern === prepared.requesterPermissionPattern
      && delegation.requesterPermissionAction === prepared.requesterPermissionAction
      && delegation.requesterPermissionApproved === prepared.requesterPermissionApproved
      && delegation.targetAgent === prepared.target?.name
      && delegation.toolName === prepared.toolName
      && delegation.plan === prepared.plan
      && delegation.authorizationFingerprint === claim.authorizationFingerprint
      && delegation.effect === claim.effect
      && JSON.stringify(delegation.writeScopes ?? []) === JSON.stringify(claim.writeScopes ?? [])
      && JSON.stringify(delegation.permissionOverlay ?? {}) === JSON.stringify(prepared.overlay ?? {})
      && JSON.stringify(delegation.trace) === JSON.stringify(prepared.args?.trace)
  }

  #inspectionClaim(task) {
    return {
      revision: task.record.revision,
      status: task.record.status,
      phase: task.record.phase,
      attemptNumber: task.record.attemptNumber,
      childSessionID: task.record.childSessionID,
      dispatchMessageID: task.record.dispatchMessageID,
      observationEpoch: task.observationEpoch ?? 0,
    }
  }

  #sameInspectionAttempt(task, claim) {
    return task.record.attemptNumber === claim.attemptNumber
      && task.record.childSessionID === claim.childSessionID
      && task.record.dispatchMessageID === claim.dispatchMessageID
  }

  #inspectionClaimCurrent(task, claim) {
    return this.#sameInspectionAttempt(task, claim)
      && task.record.revision === claim.revision
      && (task.observationEpoch ?? 0) === claim.observationEpoch
  }

  async #beginObservation(task) {
    const observationEpoch = (task.observationEpoch ?? 0) + 1
    task.observationEpoch = observationEpoch
    const transition = this.#transitions.get(task.record.taskID)
    if (transition) await transition
    return { ...this.#inspectionClaim(task), observationEpoch }
  }

  async #restoreAfterStaleInspection(task, previousRecord, staleRecord, previousDelegation) {
    if (cancellationPending(this.#directory, task.record) && !cancellationPending(this.#directory, previousRecord)) return false
    const restored = taskMetadata({
      ...previousRecord,
      revision: staleRecord.revision + 1,
      updatedAt: this.#now(),
    })
    await this.#persistTaskRecord(task, restored, staleRecord.revision, {
      ...(staleRecord.status === TASK_STATUS_CANCELLED && previousDelegation ? { restoreDelegation: previousDelegation } : {}),
    })
    this.#acceptTaskRecord(task, restored)
    return true
  }

  async #inspect(taskID, { inspectionClaim: suppliedClaim, ancestry = new Set() } = {}) {
    if (ancestry.has(taskID)) throw new Error("Task owner chain contains a cycle")
    const nextAncestry = new Set([...ancestry, taskID])
    const task = this.#tasks.get(taskID)
    if (!task || this.#disposed || isTerminalTaskStatus(task.record.status)) return
    let inspectionClaim = suppliedClaim ?? await this.#beginObservation(task)
    try {
      await this.#refreshTaskRecord(task)
      if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return
      if (await this.#quarantineUnverifiableAuthorization(task)) {
        await this.#reconcileAuthorizationQuarantine(task)
        return
      }
      if (isTerminalTaskStatus(task.record.status)) {
        this.#releaseTerminal(task)
        return
      }
      if (cancellationPending(this.#directory, task.record)) {
        const children = await this.#ownedTasks(taskAttemptSessionIDs(task.record))
        for (const child of children) if (!isTerminalTaskStatus(child.record.status)) await this.#inspect(child.record.taskID, { ancestry: nextAncestry })
        if (children.some((child) => !isTerminalTaskStatus(child.record.status))) return
      }
      if (task.record.requiresAllAttemptsStopped) {
        if (dispatchPending(this.#directory, task.record.taskID)) return
        const stopped = await this.#allAttemptsStopped(task, inspectionClaim)
        if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return
        if (stopped === true && task.record.cancellationRequestedAt !== undefined) {
          const cancelled = await this.#setStatus(task, TASK_STATUS_CANCELLED, "cancelled", { endedAt: this.#now() }, { inspectionClaim })
          if (cancelled) this.#releaseTerminal(task)
        } else if (stopped === true) {
          this.#releaseSlot(task)
        } else if (stopped === null && cancellationPending(this.#directory, task.record)) {
          await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
            diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", "无法证明全部 Task Attempt 已停止", this.#now())],
          }, { inspectionClaim })
        }
        return
      }
      const inspection = await this.#execution.inspectTurn({
        sessionID: inspectionClaim.childSessionID,
        dispatchMessageID: inspectionClaim.dispatchMessageID,
      })
      if (!this.#inspectionClaimCurrent(task, inspectionClaim)) return
      if (cancellationPending(this.#directory, task.record)) {
        if (["running", "retrying"].includes(inspection.state)) this.#markLiveAttemptActive(task)
        const liveAttempt = this.#liveAttempt(task)
        // A live Attempt is also retained after host abort. An inactive snapshot
        // can close an observed active Attempt, but never its pre-busy window.
        if ((inspection.state === "idle" || inspection.state === "missing"
          || (inspection.state === "inactive" && !task.dispatchUnconfirmed && (!liveAttempt
            || liveAttempt.phase === "active" && liveAttempt.observedActive)))
          && !dispatchPending(this.#directory, task.record.taskID) && !task.dispatchPending) {
          const cancelled = await this.#setStatus(task, TASK_STATUS_CANCELLED, "cancelled", { endedAt: this.#now() }, { inspectionClaim })
          if (cancelled) this.#releaseTerminal(task)
        }
        return
      }
      if (inspection.pendingRequests) {
        const reconciled = await this.#reconcilePendingRequests(task, inspection.pendingRequests, { inspectionClaim })
        if (reconciled.changed) inspectionClaim = this.#inspectionClaim(task)
        if (reconciled.waiting) return
        if (this.#unverifiedInteraction(task, reconciled) && inspection.state === "idle") {
          await this.#interruptUnverifiedInteraction(task, reconciled, undefined, { inspectionClaim })
          return
        }
      } else if ([TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION].includes(task.record.status)) {
        const reconciled = await this.#reconcilePendingRequests(task, undefined, { inspectionClaim })
        if (reconciled.changed) inspectionClaim = this.#inspectionClaim(task)
        if (reconciled.waiting) return
        if (this.#unverifiedInteraction(task, reconciled) && inspection.state === "idle") {
          await this.#interruptUnverifiedInteraction(task, reconciled, undefined, { inspectionClaim })
          return
        }
        if ([TASK_STATUS_WAITING_PERMISSION, TASK_STATUS_WAITING_QUESTION].includes(task.record.status)) return
      }
      if (inspection.state === "missing") {
        const missing = await this.#setStatus(task, TASK_STATUS_UNKNOWN, "missing-session", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("session-missing", "子 Session 不存在，无法证明执行结果", this.#now())],
        }, { inspectionClaim })
        return
      }
      if (inspection.state === "unknown") {
        await this.#setStatus(task, TASK_STATUS_UNKNOWN, "inspection-unknown", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("inspection-unknown", "宿主返回未知 Session 状态，无法证明执行已停止", this.#now())],
        }, { inspectionClaim })
        this.#retainConservativeLock(task)
        this.#retainSlot(task)
        return
      }
      if (inspection.state === "running" || inspection.state === "retrying") {
        task.observedActive = true
        this.#markLiveAttemptActive(task)
        task.observationEpoch = (task.observationEpoch ?? 0) + 1
        inspectionClaim = this.#inspectionClaim(task)
      }
      if (task.record.status === TASK_STATUS_STARTING && ["idle", "inactive"].includes(inspection.state) && !dispatchPending(this.#directory, task.record.taskID) && !task.dispatchPending && task.dispatchUnconfirmed) {
        const unknown = await this.#setStatus(task, TASK_STATUS_UNKNOWN, "dispatch-unconfirmed", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("dispatch-unconfirmed", "恢复后未找到已受理的 dispatch 结果", this.#now())],
        }, { inspectionClaim })
        return
      }
      if (task.record.status === TASK_STATUS_CANCELLING && inspection.state === "idle" && !dispatchPending(this.#directory, task.record.taskID)) {
        const cancelled = await this.#setStatus(task, TASK_STATUS_CANCELLED, "cancelled", { endedAt: this.#now() }, { inspectionClaim })
        if (cancelled) this.#releaseTerminal(task)
        return
      }
      if (inspection.error) {
        await this.#handleModelError(task, inspection.error, { inspectionClaim })
        return
      }
      if (inspection.result) {
        await this.#complete(task, inspection.result, { inspectionClaim })
        return
      }
      if (inspection.state === "retrying" && task.record.status !== TASK_STATUS_RETRYING) {
        await this.#setStatus(task, TASK_STATUS_RETRYING, "model-retrying", {}, { inspectionClaim })
        return
      }
      const dispatchQueued = retryDispatchPending(task) || modelFallbackDispatchPending(task)
      const liveAttempt = this.#liveAttempt(task)
      if (
        ["idle", "inactive"].includes(inspection.state)
        && (task.recovered || task.observedActive || liveAttempt?.observedActive)
        && !dispatchPending(this.#directory, task.record.taskID)
        && !task.dispatchPending
        && !dispatchQueued
        && [TASK_STATUS_RUNNING, TASK_STATUS_RETRYING].includes(task.record.status)
        && (!liveAttempt || liveAttempt.phase === "active")
      ) {
        const interruptedAt = this.#now()
        const message = "子 Session 已停止，但未找到与 dispatchMessageID 匹配的完成结果"
        await this.#setStatus(task, TASK_STATUS_WAITING_RETRY_DECISION, "execution-interrupted", {
          retryDecision: {
            status: "pending",
            retryRound: task.record.retryRound,
            attemptNumber: task.record.attemptNumber,
            requestedAt: interruptedAt,
            error: message,
          },
          diagnostics: [...task.record.diagnostics, taskDiagnostic("execution-interrupted", message, interruptedAt)],
        }, { inspectionClaim })
      }
    } catch (error) {
      if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return
      const cancelling = cancellationPending(this.#directory, task.record)
      const unknown = await this.#setStatus(task, TASK_STATUS_UNKNOWN, cancelling ? "cancel-unconfirmed" : "inspection-failed", {
        diagnostics: [...task.record.diagnostics, taskDiagnostic(cancelling ? "cancel-unconfirmed" : "inspection-failed", errorText(error), this.#now())],
      }, inspectionClaim ? { inspectionClaim } : {})
    }
  }

  async #complete(task, result, { inspectionClaim } = {}) {
    const children = await this.#ownedTasks([task.record.childSessionID])
    if (children.some((child) => !isTerminalTaskStatus(child.record.status) || !taskReceiptAcknowledged(child))) {
      if (task.record.phase !== "waiting-children") {
        await this.#setStatus(task, TASK_STATUS_RUNNING, "waiting-children", {}, inspectionClaim ? { inspectionClaim } : {})
      }
      return
    }
    let staged
    let delegationSettled = false
    let completed
    let resultSessionID
    let resultRefs
    const revertDelegation = async () => {
      if (!delegationSettled || !resultSessionID) return
      await this.#refreshTaskRecord(task).catch(() => undefined)
      await this.#store.updateO4E(resultSessionID, (state) => {
        if (!state.delegation
          || state.delegation.status !== "reported-completed"
          || !isDeepStrictEqual(state.delegation.result, resultRefs)) return state
        const coLocatedTask = state.task?.taskID === task.record.taskID ? state.task : undefined
        const currentRecord = (coLocatedTask?.revision ?? 0) > task.record.revision ? coLocatedTask : task.record
        const cancellationRequestedAt = currentRecord.cancellationRequestedAt ?? state.delegation.cancellationRequestedAt
        if (currentRecord.status === TASK_STATUS_COMPLETED) return state
        if (currentRecord.status === TASK_STATUS_CANCELLED) {
          return {
            ...state,
            delegation: {
              ...state.delegation,
              status: "cancelled",
              endedAt: currentRecord.endedAt,
              cancellationRequestedAt,
              result: undefined,
              diagnostics: currentRecord.phase,
            },
          }
        }
        if (currentRecord.status === TASK_STATUS_FAILED) {
          return {
            ...state,
            delegation: {
              ...state.delegation,
              status: "failed",
              endedAt: currentRecord.endedAt,
              result: undefined,
              diagnostics: currentRecord.diagnostics,
            },
          }
        }
        return {
          ...state,
          delegation: {
            ...state.delegation,
            status: cancellationRequestedAt === undefined ? "running" : "unknown",
            endedAt: undefined,
            ...(cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt }),
            result: undefined,
          },
        }
      }).catch(() => undefined)
    }
    try {
      if (await this.#quarantineUnverifiableAuthorization(task)) return
      const refs = messageReferences(result)
      resultRefs = refs
      const output = compactText(taskText(result))
      resultSessionID = inspectionClaim?.childSessionID ?? task.record.childSessionID
      staged = await this.#setStatus(task, TASK_STATUS_RUNNING, "completion-settling", {
        endedAt: undefined,
        activeInputs: [],
        result: { ...refs, sessionID: resultSessionID, output },
      }, inspectionClaim ? { inspectionClaim, publishReceipt: false } : { publishReceipt: false })
      if (!staged || staged.status !== TASK_STATUS_RUNNING || staged.phase !== "completion-settling") return
      if (inspectionClaim && (!this.#sameInspectionAttempt(task, inspectionClaim) || (task.observationEpoch ?? 0) !== inspectionClaim.observationEpoch)) return
      const settledSession = await this.#store.updateO4E(resultSessionID, (state, session) => {
        if (!this.#restartAttemptMatches(task, session)) {
          throw new Error(`Background Task completion sibling Delegation 不匹配: ${task.record.taskID}/${task.record.dispatchMessageID}`)
        }
        return {
          ...state,
          delegation: { ...state.delegation, status: "reported-completed", endedAt: this.#now(), result: refs },
        }
      })
      const settledDelegation = sessionO4E(settledSession).delegation
      if (settledDelegation?.status !== "reported-completed" || !isDeepStrictEqual(settledDelegation.result, refs)) {
        throw new Error(`Background Task completion sibling Delegation 未确认: ${task.record.taskID}/${task.record.dispatchMessageID}`)
      }
      delegationSettled = true
      if (inspectionClaim && (!this.#sameInspectionAttempt(task, inspectionClaim) || (task.observationEpoch ?? 0) !== inspectionClaim.observationEpoch)) {
        await revertDelegation()
        return
      }
      completed = await this.#setStatus(task, TASK_STATUS_COMPLETED, "completed", {
        endedAt: this.#now(),
        activeInputs: [],
        result: { ...refs, sessionID: resultSessionID, output },
      }, {
        expectedRevision: staged.revision,
        publishReceipt: false,
        ...(inspectionClaim ? { inspectionClaim: { ...inspectionClaim, revision: staged.revision, status: staged.status, phase: staged.phase } } : {}),
      })
      if (!completed || completed.status !== TASK_STATUS_COMPLETED) {
        await revertDelegation()
        return
      }
      this.#releaseTerminal(task)
      void this.#track(this.#publishReceiptReference(completed)).catch(() => undefined)
    } catch (error) {
      await revertDelegation()
      if (staged) {
        await this.#refreshTaskRecord(task).catch(() => undefined)
        if (task.record.revision === staged.revision && task.record.phase === "completion-settling") {
          const settlementDiagnostic = taskDiagnostic("delegation-result-write-failed", `写入委派完成引用失败: ${errorText(error)}`, this.#now())
          try {
            await this.#setStatus(task, TASK_STATUS_UNKNOWN, "result-settlement-unconfirmed", {
              endedAt: undefined,
              result: undefined,
              receipt: undefined,
              diagnostics: [...task.record.diagnostics, settlementDiagnostic],
            }, { expectedRevision: staged.revision, publishReceipt: false })
          } catch {
            this.#acceptTaskRecord(task, taskMetadata({
              ...task.record,
              status: TASK_STATUS_UNKNOWN,
              phase: "result-settlement-unconfirmed",
              endedAt: undefined,
              result: undefined,
              receipt: undefined,
              diagnostics: [...task.record.diagnostics, settlementDiagnostic],
            }))
          }
        }
      }
      this.#retainSlot(task)
      this.#retainConservativeLock(task)
    }
    if (task.record.status === TASK_STATUS_COMPLETED) await this.#queuePendingInputContinuation(task)
  }

  async #queuePendingInputContinuation(task, { dispatch = this.#dispatchSuspensions === 0 } = {}) {
    const unavailable = (reason) => ({ accepted: false, reason })
    const claim = {
      taskID: task.record.taskID,
      taskSessionID: task.record.taskSessionID,
      revision: task.record.revision,
      runGeneration: task.record.runGeneration,
      receiptID: task.record.receipt?.receiptID,
      status: task.record.status,
      phase: task.record.phase,
    }
    const continuationTerminal = claim.status === TASK_STATUS_COMPLETED && claim.phase === "completed"
      || claim.status === TASK_STATUS_FAILED && claim.phase === "model-error"
    if (!continuationTerminal || task.record.pendingInputs?.length === 0) return unavailable("state-not-resumable")
    if (this.#disposed) return unavailable("runtime-disposed")
    if (this.#quiescing) return unavailable("runtime-quiescing")
    if (dispatch && this.#dispatchSuspensions > 0) return unavailable("dispatch-suspended")
    let result = unavailable("continuation-not-queued")
    await serializeTaskMutation(this.#directory, claim.taskID, async () => {
      await this.#refreshTaskRecord(task)
      if (
        task.record.taskSessionID !== claim.taskSessionID
        || task.record.runGeneration !== claim.runGeneration
        || task.record.receipt?.receiptID !== claim.receiptID
        || task.record.status !== claim.status
        || task.record.phase !== claim.phase
        || task.record.revision < claim.revision
        || task.record.pendingInputs?.length === 0
      ) return
      await this.#publishReceiptReferenceSerialized(task.record)
      const previousRevision = task.record.revision
      const queued = taskMetadata({
        ...task.record,
        endedAt: undefined,
        result: undefined,
        receipt: undefined,
        retryDecision: undefined,
        pendingRequests: [],
        activeInputs: [],
        runGeneration: task.record.runGeneration + 1,
        dispatchMessageID: createDispatchMessageID(),
        attemptNumber: 0,
        retryRound: 0,
        failedModelCandidates: [],
        handledModelErrorAttempt: 0,
        sideEffectWatermark: undefined,
        version: TASK_METADATA_VERSION,
        revision: previousRevision + 1,
        status: TASK_STATUS_QUEUED,
        phase: "input-queued",
        updatedAt: this.#now(),
      })
      await this.#persistTaskRecord(task, queued, previousRevision, { publishReceipt: false })
      this.#acceptTaskRecord(task, queued)
      await this.#attemptTaskRecoveryPublication(task)
      task.slotReleased = true
      if (dispatch) {
        const admitted = this.#scheduler.enqueue(task.record)
        this.#dispatch(admitted)
        result = {
          accepted: true,
          reason: admitted.includes(task.record.taskID) ? "dispatch-requested" : "queued",
        }
      } else {
        result = { accepted: false, reason: "dispatch-suspended" }
      }
    })
    return result
  }

  async #stopChildrenForFailure(task, { expectedRevision, inspectionClaim } = {}) {
    const children = await this.#ownedTasks(taskAttemptSessionIDs(task.record))
    if (children.every((child) => isTerminalTaskStatus(child.record.status))) return { expectedRevision, inspectionClaim }
    const staged = await this.#setStatus(task, TASK_STATUS_RUNNING, "completion-settling", {}, { expectedRevision, inspectionClaim })
    if (!staged || staged.phase !== "completion-settling" || staged.status !== TASK_STATUS_RUNNING) return null
    const stopped = await this.#cancelOwnedTasks(task, "祖先 Task 已终止").catch(() => false)
    if (task.record.revision !== staged.revision || (inspectionClaim && (!this.#sameInspectionAttempt(task, inspectionClaim)
      || (task.observationEpoch ?? 0) !== inspectionClaim.observationEpoch))) return null
    if (!stopped) {
      await this.#setStatus(task, TASK_STATUS_UNKNOWN, "children-stop-unconfirmed", {}, { expectedRevision: staged.revision })
      this.#retainConservativeLock(task)
      this.#retainSlot(task)
      return null
    }
    return { expectedRevision: staged.revision, inspectionClaim: inspectionClaim ? this.#inspectionClaim(task) : undefined }
  }

  async #setStatus(task, status, phase, extra = {}, { expectedRevision, skipIf, inspectionClaim, allowTerminalTransition = false, publishReceipt = true } = {}) {
    if (status === TASK_STATUS_FAILED) {
      const settled = await this.#stopChildrenForFailure(task, { expectedRevision, inspectionClaim })
      if (!settled) return null
      ;({ expectedRevision, inspectionClaim } = settled)
    }
    return serial(this.#transitions, task.record.taskID, async () => {
      if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return null
      if (expectedRevision !== undefined && task.record.revision !== expectedRevision) {
        throw new Error(`Task revision 已变化: expected=${expectedRevision} actual=${task.record.revision}`)
      }
      if (skipIf?.(task.record)) return task.record
      if (isTerminalTaskStatus(task.record.status) && task.record.status !== status && !allowTerminalTransition) return task.record
      if (cancellationPending(this.#directory, task.record) && ![TASK_STATUS_CANCELLING, TASK_STATUS_UNKNOWN, TASK_STATUS_CANCELLED].includes(status)) return task.record
      const cancellationRequestedAt = cancellationTime(this.#directory, task.record)
      const previousRevision = task.record.revision
      const previousRecord = task.record
      const nextRecord = taskMetadata({
        ...task.record,
        ...extra,
        ...(cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt }),
        version: TASK_METADATA_VERSION,
        revision: task.record.revision + 1,
        status,
        phase,
        updatedAt: this.#now(),
        diagnostics: extra.diagnostics ?? task.record.diagnostics ?? [],
      })
      const previousDelegation = await this.#persistTaskRecord(task, nextRecord, previousRevision, { publishReceipt: false, publishRecovery: false })
      this.#acceptTaskRecord(task, nextRecord)
      if (
        inspectionClaim
        && (task.observationEpoch ?? 0) !== inspectionClaim.observationEpoch
      ) {
        await this.#restoreAfterStaleInspection(task, previousRecord, nextRecord, previousDelegation)
        return null
      }
      this.#queueTaskRecoveryReference(task, nextRecord)
      if (publishReceipt && nextRecord.receipt) {
        void this.#track(this.#publishReceiptReference(nextRecord)).catch(() => undefined)
      }
      return nextRecord
    })
  }

  async #setCancellationStatus(task, status, phase, cancellationRequestedAt, extra = {}) {
    return serial(this.#transitions, task.record.taskID, async () => {
      let nextRecord
      await this.#store.updateO4E(task.record.taskSessionID, (state) => {
        const persisted = normalizeTaskMetadata(state.task)
        if (persisted.taskID !== task.record.taskID || persisted.taskSessionID !== task.record.taskSessionID) {
          throw new Error(`Task ledger 与取消目标不一致: ${task.record.taskID}`)
        }
        if (isTerminalTaskStatus(persisted.status)) {
          nextRecord = persisted
          return state
        }
        nextRecord = taskMetadata({
          ...persisted,
          ...extra,
          version: TASK_METADATA_VERSION,
          revision: persisted.revision + 1,
          status,
          phase,
          cancellationRequestedAt: persisted.cancellationRequestedAt ?? cancellationRequestedAt,
          updatedAt: this.#now(),
          diagnostics: extra.diagnostics ?? persisted.diagnostics ?? [],
        })
        return {
          ...state,
          task: nextRecord,
          delegation: state.delegation
            ? {
                ...state.delegation,
                cancellationRequestedAt: state.delegation.cancellationRequestedAt ?? nextRecord.cancellationRequestedAt,
                ...(status === TASK_STATUS_FAILED ? { status: "failed", endedAt: nextRecord.endedAt, diagnostics: nextRecord.diagnostics } : {}),
                ...(status === TASK_STATUS_RUNNING ? { status: "running", startedAt: nextRecord.startedAt } : {}),
                ...(status === TASK_STATUS_CANCELLED ? {
                  status: "cancelled",
                  endedAt: nextRecord.endedAt,
                  result: undefined,
                  diagnostics: nextRecord.phase,
                } : {}),
              }
            : state.delegation,
        }
      })
      this.#acceptTaskRecord(task, nextRecord)
      this.#queueTaskRecoveryReference(task, nextRecord)
      return nextRecord
    })
  }

  async #refreshTaskRecord(task) {
    const session = await this.#store.get(task.record.taskSessionID)
    const persisted = sessionO4E(session)?.task
    if (!persisted) return task.record
    const record = normalizeTaskMetadata(persisted)
    if (record.taskID !== task.record.taskID || record.taskSessionID !== task.record.taskSessionID) {
      throw new Error(`Task ledger 与本地状态不一致: ${task.record.taskID}`)
    }
    if (record.revision > task.record.revision) this.#acceptTaskRecord(task, record)
    return task.record
  }

  async #persistTaskRecord(task, nextRecord, previousRevision, { publishReceipt = true, publishRecovery = true, restoreDelegation } = {}) {
    let previousDelegation
    try {
      await this.#store.updateO4E(nextRecord.taskSessionID, (state) => {
        const persisted = normalizeTaskMetadata(state.task)
        if (persisted.revision !== previousRevision) {
          throw new Error(`Task revision 已变化: expected=${previousRevision} actual=${persisted.revision}`)
        }
        previousDelegation = state.delegation
        return {
          ...state,
          task: nextRecord,
          delegation: restoreDelegation ?? (state.delegation
            ? {
                ...state.delegation,
                ...(task.prepared ? {
                  sourceAgent: task.prepared.requester?.name,
                  targetAgent: task.prepared.target?.name,
                  authorizationFingerprint: task.prepared.authorizationFingerprint,
                  effect: task.prepared.effect?.kind,
                  writeScopes: task.prepared.normalizedScopes,
                } : {}),
                ...(
                  nextRecord.taskSessionID !== nextRecord.childSessionID
                  || nextRecord.retryDecision?.decision !== "restart"
                    ? { dispatchMessageID: nextRecord.dispatchMessageID }
                    : {}
                ),
                ...(nextRecord.cancellationRequestedAt === undefined ? {} : {
                  cancellationRequestedAt: state.delegation.cancellationRequestedAt ?? nextRecord.cancellationRequestedAt,
                }),
                ...(nextRecord.status === TASK_STATUS_FAILED ? { status: "failed", endedAt: nextRecord.endedAt, diagnostics: nextRecord.diagnostics } : {}),
                ...(nextRecord.status === TASK_STATUS_RUNNING ? { status: "running", startedAt: nextRecord.startedAt } : {}),
                ...(nextRecord.status === TASK_STATUS_COMPLETED ? {
                  status: "reported-completed",
                  endedAt: nextRecord.endedAt,
                  result: nextRecord.result
                    ? { messageID: nextRecord.result.messageID, partIDs: nextRecord.result.partIDs }
                    : undefined,
                  diagnostics: undefined,
                } : {}),
                ...(nextRecord.status === TASK_STATUS_CANCELLED ? {
                  status: "cancelled",
                  endedAt: nextRecord.endedAt,
                  result: undefined,
                  diagnostics: nextRecord.phase,
                } : {}),
              }
            : state.delegation),
        }
      })
    } catch (error) {
      const persisted = await this.#store.get(nextRecord.taskSessionID)
        .then((session) => sessionO4E(session)?.task ? normalizeTaskMetadata(sessionO4E(session).task) : null, () => null)
      if (!persisted || persisted.taskID !== nextRecord.taskID || persisted.taskSessionID !== nextRecord.taskSessionID) throw error
      if (!isDeepStrictEqual(persisted, nextRecord)) {
        if (persisted.revision > task.record.revision) this.#acceptTaskRecord(task, persisted)
        throw error
      }
    }
    if (publishRecovery) this.#queueTaskRecoveryReference(task, nextRecord)
    if (publishReceipt && nextRecord.receipt) {
      void this.#track(this.#publishReceiptReference(nextRecord)).catch(() => undefined)
    }
    return previousDelegation
  }

  async #updateReceipt(task, transform) {
    return serial(this.#transitions, task.record.taskID, async () => {
      await this.#refreshTaskRecord(task)
      if (!isTerminalTaskStatus(task.record.status)) return undefined
      const current = task.record.receipt
      const nextReceipt = transform(current)
      if (!nextReceipt) return undefined
      if (JSON.stringify(nextReceipt) === JSON.stringify(current)) return current
      const previousRevision = task.record.revision
      const nextRecord = taskMetadata({
        ...task.record,
        revision: previousRevision + 1,
        updatedAt: this.#now(),
        receipt: nextReceipt,
      })
      await this.#persistTaskRecord(task, nextRecord, previousRevision)
      this.#acceptTaskRecord(task, nextRecord)
      return nextRecord.receipt
    })
  }

  async #publishReceiptReference(record) {
    if (!record.receipt) return
    await this.#replaceTaskRef(record.ownerSessionID, record.taskID, this.#receiptTaskRef(record), { preserveNewerTaskRef: true })
  }

  #receiptTaskRef(record) {
    return {
      taskSessionID: record.taskSessionID,
      taskRevision: record.revision,
      kind: record.kind,
      sequence: record.sequence,
      createdAt: record.createdAt,
      ...(record.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: record.cancellationRequestedAt }),
      ...taskReceiptReferenceFields(record.receipt),
    }
  }

  async #publishReceiptReferenceSerialized(record) {
    if (!record.receipt) return
    await this.#replaceTaskRefSerialized(record.ownerSessionID, record.taskID, this.#receiptTaskRef(record), { preserveNewerTaskRef: true })
  }

  async #updateReceiptReference(ownerSessionID, taskID, receiptID, fields, { expectedDeliveredToMessageID, requireUnacknowledged = false } = {}) {
    let changed = false
    await this.#store.updateO4E(ownerSessionID, (state) => {
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      const current = group.taskRefs[taskID]
      if (!current) return state
      let matched = false
      const receipts = taskRefReceipts(current).map((receipt) => {
        if (receipt.receiptID !== receiptID) return receipt
        if (requireUnacknowledged && receipt.receiptAcknowledgedAt !== undefined) return receipt
        if (expectedDeliveredToMessageID !== undefined && receipt.receiptDeliveredToMessageID !== expectedDeliveredToMessageID) return receipt
        matched = true
        return { ...receipt, ...fields }
      })
      if (!matched) return state
      const nextRef = replaceTaskRefReceiptFields(current, { receipts })
      if (taskRefsEqual(current, nextRef)) return state
      changed = true
      return {
        ...state,
        backgroundTasks: {
          ...group,
          revision: group.revision + 1,
          taskRefs: { ...group.taskRefs, [taskID]: nextRef },
        },
      }
    })
    return changed
  }

  async #acknowledgeReceiptReference(ownerSessionID, taskID, receiptID, messageID, acknowledgedAt) {
    let result
    await this.#store.updateO4E(ownerSessionID, (state) => {
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      const current = group.taskRefs[taskID]
      if (!current) return state
      let changed = false
      const receipts = taskRefReceipts(current).map((receipt) => {
        if (receipt.receiptID !== receiptID) return receipt
        const deliveredToMessageID = receipt.receiptDeliveredToMessageID ?? messageID
        const deliveredAt = receipt.receiptDeliveredAt ?? acknowledgedAt
        const nextAcknowledgedAt = receipt.receiptAcknowledgedAt ?? Math.max(acknowledgedAt, deliveredAt)
        const nextReceipt = {
          ...receipt,
          receiptDeliveredToMessageID: deliveredToMessageID,
          receiptDeliveredAt: deliveredAt,
          receiptAcknowledgedAt: nextAcknowledgedAt,
        }
        result = nextReceipt
        if (JSON.stringify(nextReceipt) !== JSON.stringify(receipt)) changed = true
        return nextReceipt
      })
      if (!result || !changed) return state
      const nextRef = replaceTaskRefReceiptFields(current, { receipts })
      return {
        ...state,
        backgroundTasks: {
          ...group,
          revision: group.revision + 1,
          taskRefs: { ...group.taskRefs, [taskID]: nextRef },
        },
      }
    })
    return result
  }

  #acceptTaskRecord(task, nextRecord) {
    const previousRecord = task.record
    if (!isTerminalTaskStatus(previousRecord.status) && isTerminalTaskStatus(nextRecord.status) && nextRecord.receipt) {
      const activeParentWatchers = [...(this.#activeWatches.get(nextRecord.ownerSessionID) ?? [])]
        .filter((watcher) => (
          watcher.requesterSessionID === nextRecord.ownerSessionID
          && (watcher.watchAll || watcher.watchedTaskIDs.has(nextRecord.taskID))
        ))
        .length
      task.pendingTerminalSignal = {
        record: nextRecord,
        activeParentWatchers,
      }
    } else if (!isTerminalTaskStatus(nextRecord.status)) {
      task.pendingTerminalSignal = undefined
    }
    task.record = nextRecord
    this.#remember(task)
    this.#wakeOwner(task.record.ownerSessionID, isActionableTaskStatus(task.record.status) ? "actionable" : "progress")
  }

  async #authorizedTasks(context, requestedTaskIDs, { pendingOnly = false } = {}) {
    if (Array.isArray(requestedTaskIDs)) {
      const unique = [...new Set(requestedTaskIDs)]
      return Promise.all(unique.map((taskID) => this.#awaitRead(context, () => this.#loadAuthorized(taskID, context, "read"))))
    }
    await this.#hydrateOwner(context.sessionID)
    const tasks = [...this.#tasks.values()]
      .filter((task) => task.record.ownerSessionID === context.sessionID)
      .sort((left, right) => left.record.sequence - right.record.sequence)
    return pendingOnly ? tasks.filter((task) => !taskReceiptAcknowledged(task)) : tasks
  }

  async #loadAuthorized(taskID, context, action) {
    if (typeof taskID !== "string" || taskID.trim() === "") throw new Error("taskID 必须是非空字符串")
    let task = this.#tasks.get(taskID)
    if (!task) {
      const own = await this.#loadOwnTask(context.sessionID)
      task = own?.record.taskID === taskID ? own : null
    }
    if (!task) task = await this.#loadFromOwner(taskID, context, { force: true })
    else task = await this.#refreshExplicitTask(task)
    if (!task) throw new Error(`未找到 Task: ${taskID}`)
    const allowed = task.record.ownerSessionID === context.sessionID
      || task.record.taskSessionID === context.sessionID
      || task.record.childSessionID === context.sessionID
    if (!allowed) throw new Error(`无权${action === "read" ? "读取" : "管理"} Task: ${taskID}`)
    if (action !== "read" && task.record.ownerSessionID !== context.sessionID) throw new Error(`只有父 Session 可以${action === "cancel" ? "取消" : "管理"} Task: ${taskID}`)
    if (await this.#quarantineUnverifiableAuthorization(task)) await this.#reconcileAuthorizationQuarantine(task)
    return task
  }

  async #loadOwnTask(sessionID) {
    const session = await this.#store.get(sessionID).catch(() => null)
    const persisted = sessionO4E(session)?.task
    if (!persisted) return null
    const record = normalizeTaskMetadata(persisted)
    return this.#loadTask(record, session)
  }

  async #loadFromOwner(taskID, context, { force = false } = {}) {
    await this.#hydrateOwner(context.sessionID, { force })
    return this.#tasks.get(taskID) ?? null
  }

  async #refreshExplicitTask(task) {
    let owner
    try {
      owner = await this.#store.get(task.record.ownerSessionID)
    } catch (error) {
      if (!missingSessionError(error)) throw error
      this.#missingOwners.add(task.record.ownerSessionID)
      return task
    }
    if (!owner?.id) {
      this.#missingOwners.add(task.record.ownerSessionID)
      return task
    }
    const ref = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks).taskRefs[task.record.taskID]
    if (!ref) return task
    // A newer revision on the same ledger only needs a canonical read below.
    // Rehydrating/reconciling it here could wait for an unrelated in-flight
    // completion before cancellation has established its fence.
    if (ref.taskSessionID !== task.record.taskSessionID) {
      await this.#hydrateOwner(task.record.ownerSessionID, { force: true })
      return this.#tasks.get(task.record.taskID) ?? task
    }
    try {
      const indexedSession = await this.#store.get(ref.taskSessionID)
      const persisted = sessionO4E(indexedSession)?.task
      if (!persisted) throw Object.assign(new Error(`Task ledger 不存在: ${ref.taskSessionID}`), { name: "NotFoundError" })
      const indexedRecord = normalizeTaskMetadata(persisted)
      if (indexedRecord.taskID !== task.record.taskID || indexedRecord.taskSessionID !== ref.taskSessionID) {
        throw Object.assign(new Error(`Task ledger 与父索引不一致: ${task.record.taskID}`), { name: "NotFoundError" })
      }
      if (indexedRecord.revision > task.record.revision) this.#acceptTaskRecord(task, indexedRecord)
      return task
    } catch (error) {
      if (!missingSessionError(error)) throw error
      await this.#hydrateOwner(task.record.ownerSessionID, { force: true })
      return this.#tasks.get(task.record.taskID) ?? task
    }
  }

  async #refreshTaskFromOwnerRef(task) {
    if (!task) return task
    const owner = await this.#store.get(task.record.ownerSessionID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    if (!owner?.id) return task
    const ref = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks).taskRefs[task.record.taskID]
    if (!ref) return task
    const indexedSession = await this.#store.get(ref.taskSessionID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    const persisted = sessionO4E(indexedSession)?.task
    if (!persisted) return task
    const indexedRecord = normalizeTaskMetadata(persisted)
    if (indexedRecord.taskID !== task.record.taskID || indexedRecord.taskSessionID !== ref.taskSessionID) return task
    await this.#loadTask(indexedRecord, indexedSession, { preferIndexed: true })
    return this.#tasks.get(task.record.taskID) ?? task
  }

  async #hydrateOwner(ownerSessionID, { dispatchQueued = false, force = false } = {}) {
    const existing = this.#ownerHydration.get(ownerSessionID)
    if (existing && !force) return existing
    const suspendDispatch = !dispatchQueued
    if (suspendDispatch) this.#dispatchSuspensions += 1
    const hydration = (async () => {
      if (existing) await existing
      const owner = await this.#store.get(ownerSessionID)
      const group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
      const refs = Object.entries(group.taskRefs).sort(([, left], [, right]) => left.sequence - right.sequence)
      for (const [taskID, ref] of refs) {
        await this.#hydrateOwnerRef(ownerSessionID, taskID, ref)
      }
      await this.#restoreOwnerTasks(ownerSessionID, { dispatchQueued, ownerExists: true })
    })()
    this.#ownerHydration.set(ownerSessionID, hydration)
    let recovered = false
    try {
      await hydration
      recovered = true
    } catch (error) {
      if (this.#ownerHydration.get(ownerSessionID) === hydration) this.#ownerHydration.delete(ownerSessionID)
      this.#discardDeferredDispatch(ownerSessionID)
      throw error
    } finally {
      if (suspendDispatch) this.#dispatchSuspensions -= 1
      if (recovered) this.#resumeDeferredDispatch()
    }
  }

  async #hydrateOwnerRef(ownerSessionID, taskID, ref, { refreshed = false } = {}) {
    try {
      const indexedSession = await this.#store.get(ref.taskSessionID)
      const indexedTask = sessionO4E(indexedSession)?.task
      if (!indexedTask) throw Object.assign(new Error(`Task ledger 不存在: ${ref.taskSessionID}`), { name: "NotFoundError" })
      const indexedRecord = normalizeTaskMetadata(indexedTask)
      if (indexedRecord.taskID !== taskID || indexedRecord.taskSessionID !== ref.taskSessionID) {
        throw Object.assign(new Error(`Task ledger 与父索引不一致: ${taskID}`), { name: "NotFoundError" })
      }
      if (indexedRecord.ownerSessionID !== ownerSessionID) throw new Error(`Task owner 与父索引不一致: ${taskID}`)
      const task = await this.#loadTask(indexedRecord, indexedSession, { preferIndexed: true })
      if (task && task.record.taskSessionID !== ref.taskSessionID) {
        await this.#replaceTaskRef(ownerSessionID, taskID, {
          taskSessionID: task.record.taskSessionID,
          taskRevision: task.record.revision,
          kind: task.record.kind,
          sequence: task.record.sequence,
          createdAt: task.record.createdAt,
        })
      }
      // Repair only the addressed owner's valid current records, never scan or
      // replay work just because its disposable owner projection is stale.
      await this.#attemptTaskRecoveryPublication(task)
    } catch (error) {
      if (!missingSessionError(error)) throw error
      if (!refreshed) {
        const owner = await this.#store.get(ownerSessionID)
        const currentRef = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks).taskRefs[taskID]
        if (!taskRefsEqual(currentRef, ref)) {
          if (currentRef) await this.#hydrateOwnerRef(ownerSessionID, taskID, currentRef, { refreshed: true })
          return
        }
      }
      await this.#rebuildMissingLedgerTombstone(ownerSessionID, taskID, this.#tasks.get(taskID))
    }
  }

  async #restoreOwnerTasks(ownerSessionID, { dispatchQueued, ownerExists }) {
    for (const task of [...this.#tasks.values()].filter((entry) => entry.record.ownerSessionID === ownerSessionID)) {
        if (this.#disposed) return
        if (!ownerExists && task.record.status === TASK_STATUS_QUEUED) {
          await this.#setStatus(task, TASK_STATUS_CANCELLED, "owner-deleted-before-dispatch", {
            endedAt: this.#now(),
            diagnostics: [...task.record.diagnostics, taskDiagnostic("owner-session-missing", "父 Session 已删除，queued Task 未 dispatch", this.#now())],
          })
          this.#releaseTerminal(task)
          continue
        }
        if (await this.#quarantineUnverifiableAuthorization(task)) {
          await this.#reconcileAuthorizationQuarantine(task)
          continue
        }
        if (ownerExists && !isTerminalTaskStatus(task.record.status) && task.record.status !== TASK_STATUS_QUEUED
          && !retryDispatchPending(task) && !modelFallbackDispatchPending(task)
          && !await this.#restoreTaskLock(task)) continue
        if (task.record.status !== TASK_STATUS_QUEUED && task.record.status !== TASK_STATUS_WAITING_RETRY_DECISION && !retryDispatchPending(task) && !modelFallbackDispatchPending(task) && task.record.status !== TASK_STATUS_UNKNOWN && task.record.status !== TASK_STATUS_INTERRUPTED && !isTerminalTaskStatus(task.record.status)) {
          await this.#inspect(task.record.taskID)
        }
        if (!ownerExists && !isTerminalTaskStatus(task.record.status)) {
          this.#retainConservativeLock(task)
          if (task.record.status !== TASK_STATUS_INTERRUPTED && (task.record.status !== TASK_STATUS_UNKNOWN || task.record.requiresAllAttemptsStopped || cancellationPending(this.#directory, task.record))) {
            this.#scheduler.restoreActive(task.record)
            await this.#handleOwnerDeleted([task])
          }
          continue
        }
        const dispatchPendingAfterRecovery = retryDispatchPending(task) || modelFallbackDispatchPending(task)

        if (modelFallbackDispatchPending(task)) {
          await this.#pauseAutomaticModelFallback(task)
          this.#scheduler.restoreActive(task.record)
          task.slotReleased = false
          continue
        }

        if (task.record.status === TASK_STATUS_WAITING_RETRY_DECISION) {
          this.#scheduler.restoreActive(task.record)
          task.slotReleased = false
          continue
        }
        if (isTerminalTaskStatus(task.record.status)) {
          await this.#queuePendingInputContinuation(task, { dispatch: dispatchQueued }).catch(() => undefined)
          continue
        }
        if (task.record.requiresAllAttemptsStopped) {
          this.#retainSlot(task)
          if (cancellationPending(this.#directory, task.record)) {
            const acknowledged = await this.#cancelAllAttempts(task).catch(() => false)
            if (!acknowledged) {
              await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
                diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", "恢复时无法确认全部 Task Attempt 的取消请求", this.#now())],
              })
            }
          }
          await this.#inspect(task.record.taskID)
          continue
        }
        if (cancellationPending(this.#directory, task.record)) {
          this.#retainSlot(task)
          const acknowledged = await this.#execution.cancelTurn({ sessionID: task.record.childSessionID })
            .then((result) => result?.acknowledged !== false, () => false)
          if (!acknowledged) {
            await this.#setStatus(task, TASK_STATUS_UNKNOWN, "cancel-unconfirmed", {
              diagnostics: [...task.record.diagnostics, taskDiagnostic("cancel-unconfirmed", "恢复时宿主未确认取消请求", this.#now())],
            })
          }
          await this.#inspect(task.record.taskID)
          continue
        }
        if (task.record.status === TASK_STATUS_UNKNOWN || task.record.status === TASK_STATUS_INTERRUPTED) {
          if (this.#recordOccupiesSlot(task.record)) this.#retainSlot(task)
          continue
        }
        if ((task.record.activeInputs ?? []).some((entry) => entry?.delivery === "steer")) {
          await this.#recoverSteerInputs(task)
          if (isTerminalTaskStatus(task.record.status) || cancellationPending(this.#directory, task.record)) continue
        }
        if (task.record.status === TASK_STATUS_QUEUED) {
          if (dispatchQueued) this.#dispatch(this.#scheduler.enqueue(task.record))
        }
        else {
          this.#scheduler.restoreActive(task.record)
          task.slotReleased = false
          if (dispatchQueued && dispatchPendingAfterRecovery) this.#dispatch([task.record.taskID])
        }
    }
  }

  async #restoreTaskLock(task) {
    if (task.lockAcquired) return true
    try {
      const owner = await this.#store.get(task.record.ownerSessionID)
      if (sessionO4E(owner).kind === "delegation-attempt") {
        await this.#delegation.restoreDelegationAuthority({
          sessionID: task.record.ownerSessionID, agent: task.prepared.requester.name, directory: this.#directory,
        })
        task.prepared = await this.#delegation.revalidateAttempt(task.prepared, task.record.ownerSessionID)
      } else {
        if (!owner || owner.parentID !== undefined || sessionO4E(owner).kind !== undefined || task.prepared.depth !== 1) {
          throw new Error("Task root owner ancestry cannot be verified")
        }
        // Restore the frozen root lock even if configuration has since changed.
        // Current policy is checked again before any new dispatch.
        task.prepared.hostParentID = owner.id
      }
      this.#locks.restore(task.lockID, { kind: task.record.effect, writeScopes: task.record.writeScopes }, {
        allowConflict: true, parentLockID: task.prepared.parentLockID,
      })
      task.lockAcquired = true
      return true
    } catch (error) {
      // A damaged ancestry cannot establish a borrowing relationship. Retain an
      // independent conservative lock and require stopped evidence before release.
      this.#retainConservativeLock(task)
      this.#retainSlot(task)
      await this.#setStatus(task, TASK_STATUS_UNKNOWN, "authorization-unverifiable", {
        diagnostics: [...task.record.diagnostics, taskDiagnostic("ancestor-authority-unverifiable", errorText(error), this.#now())],
      })
      return false
    }
  }

  async #loadTask(record, session, { preferIndexed = false } = {}) {
    const taskID = record.taskID
    const existing = this.#tasks.get(taskID)
    const prepared = recoveredPrepared(record, sessionO4E(session).delegation)
    if (prepared) {
      const child = record.childSessionID === session.id ? session : await this.#store.get(record.childSessionID).catch(() => null)
      prepared.hostParentID = child?.parentID
    }
    if (existing) {
      if (record.taskSessionID === existing.record.taskSessionID) {
        if (record.revision > existing.record.revision) this.#acceptTaskRecord(existing, record)
        return existing
      }
      if (!preferIndexed) return existing
      if (this.#taskBySession.get(existing.record.taskSessionID) === taskID) this.#taskBySession.delete(existing.record.taskSessionID)
      existing.record = record
      existing.prepared = prepared
      existing.context = { sessionID: record.ownerSessionID, directory: session?.directory ?? this.#directory }
      existing.recovered = true
      this.#adoptLiveAttempt(existing)
      existing.dispatchBlockedByMissingSession = undefined
      this.#remember(existing)
      return existing
    }
    const task = {
      record,
      prepared,
      context: { sessionID: record.ownerSessionID, directory: session?.directory ?? this.#directory },
      lockID: `background-task:${taskID}`,
      scopeAbort: new AbortController(),
      slotReleased: !this.#recordOccupiesSlot(record),
      lockAcquired: false,
      dispatchPending: false,
      dispatchUnconfirmed: record.status === TASK_STATUS_STARTING,
      recovered: true,
      observedActive: false,
    }
    if (this.#locks.has?.(task.lockID)) task.lockAcquired = true
    this.#adoptLiveAttempt(task)
    this.#remember(task)
    return task
  }

  async #reconcileLoadedTasks(ownerSessionID) {
    const tasks = [...this.#tasks.values()].filter((task) => (
      (!ownerSessionID || task.record.ownerSessionID === ownerSessionID)
      &&
      task.record.status !== TASK_STATUS_QUEUED
      && task.record.status !== TASK_STATUS_UNKNOWN
      && task.record.status !== TASK_STATUS_INTERRUPTED
      && !isTerminalTaskStatus(task.record.status)
    ))
    for (const task of tasks) await this.#inspect(task.record.taskID)
  }

  #dispatchRecoverableTasks(ownerSessionID) {
    const terminal = [...this.#tasks.values()]
      .filter((task) => (!ownerSessionID || task.record.ownerSessionID === ownerSessionID)
        && !this.#missingOwners.has(task.record.ownerSessionID)
        && [TASK_STATUS_COMPLETED, TASK_STATUS_FAILED].includes(task.record.status)
        && task.record.pendingInputs?.length > 0)
      .sort((left, right) => left.record.createdAt - right.record.createdAt || left.record.sequence - right.record.sequence)
    for (const task of terminal) void this.#withOwnerPublication(() => this.#queuePendingInputContinuation(task)).catch(() => undefined)
    const legacyFallback = [...this.#tasks.values()]
      .filter((task) => (!ownerSessionID || task.record.ownerSessionID === ownerSessionID)
        && !this.#missingOwners.has(task.record.ownerSessionID)
        && modelFallbackDispatchPending(task))
    for (const task of legacyFallback) void this.#withOwnerPublication(() => this.#pauseAutomaticModelFallback(task)).catch(() => undefined)
    const pending = [...this.#tasks.values()]
      .filter((task) => (!ownerSessionID || task.record.ownerSessionID === ownerSessionID)
        && !this.#missingOwners.has(task.record.ownerSessionID)
        && retryDispatchPending(task))
      .sort((left, right) => left.record.createdAt - right.record.createdAt || left.record.sequence - right.record.sequence)
    for (const task of pending) this.#dispatch([task.record.taskID])
    const queued = [...this.#tasks.values()]
      .filter((task) => (!ownerSessionID || task.record.ownerSessionID === ownerSessionID)
        && task.record.status === TASK_STATUS_QUEUED
        && !this.#missingOwners.has(task.record.ownerSessionID))
      .sort((left, right) => left.record.createdAt - right.record.createdAt || left.record.sequence - right.record.sequence)
    for (const task of queued) {
      if (this.#scheduler.isActive(task.record)) {
        // Scheduler-active records already hold an admission slot. Re-dispatch
        // recovers a lost run unless a dispatch attempt is still pending.
        if (!dispatchPending(this.#directory, task.record.taskID) && !task.dispatchPending) this.#dispatch([task.record.taskID])
      } else {
        this.#dispatch(this.#scheduler.enqueue(task.record))
      }
    }
  }

  #redispatchIfPending(task) {
    if (this.#disposed) return { accepted: false, reason: "runtime-disposed" }
    if (this.#quiescing) return { accepted: false, reason: "runtime-quiescing" }
    if (this.#dispatchSuspensions > 0) return { accepted: false, reason: "dispatch-suspended" }
    if (cancellationPending(this.#directory, task.record)) return { accepted: false, reason: "cancellation-pending" }
    if (task.record.status === TASK_STATUS_QUEUED) {
      if (this.#scheduler.isActive(task.record)) {
        this.#dispatch([task.record.taskID])
        return { accepted: true, reason: "dispatch-requested" }
      }
      const admitted = this.#scheduler.enqueue(task.record)
      this.#dispatch(admitted)
      return {
        accepted: true,
        reason: admitted.includes(task.record.taskID) ? "dispatch-requested" : "queued",
      }
    }
    if (modelFallbackDispatchPending(task)) {
      void this.#withOwnerPublication(() => this.#pauseAutomaticModelFallback(task)).catch(() => undefined)
      return { accepted: false, reason: "explicit-resolution-required" }
    }
    if (retryDispatchPending(task)) {
      this.#dispatch([task.record.taskID])
      return { accepted: true, reason: "dispatch-requested" }
    }
    return { accepted: false, reason: "state-not-resumable" }
  }

  async #handleOwnerDeleted(tasks) {
    this.#missingOwners.add(tasks[0].record.ownerSessionID)
    for (const task of tasks) {
      if (!isTerminalTaskStatus(task.record.status)) {
        cancellationFences.set(taskFenceKey(this.#directory, task.record.taskID), task.record.cancellationRequestedAt ?? this.#now())
      }
    }
    for (const task of tasks) {
      const removedBeforeDispatch = task.record.status === TASK_STATUS_QUEUED && this.#scheduler.removeQueued(task.record)
      const cancelAllAttempts = task.record.requiresAllAttemptsStopped === true
      this.#retainSlot(task)
      const cancellationRequestedAt = task.record.cancellationRequestedAt ?? cancellationFences.get(taskFenceKey(this.#directory, task.record.taskID)) ?? this.#now()
      await this.#markTaskRefCancellation(task, cancellationRequestedAt).catch(() => undefined)
      await this.#setCancellationStatus(task, TASK_STATUS_CANCELLING, cancelAllAttempts ? "owner-deleted-all-attempts-cancelling" : "owner-deleted-cancelling", cancellationRequestedAt, {
        cancellationRequestedAt,
        diagnostics: [...task.record.diagnostics, taskDiagnostic(
          "owner-session-deleted",
          removedBeforeDispatch ? "父 Session 删除前 Task 尚未 dispatch，正在阻止并发启动" : "父 Session 已删除，正在取消子 Task",
          this.#now(),
        )],
      })
      if (isTerminalTaskStatus(task.record.status)) {
        this.#releaseTerminal(task)
        continue
      }
      await this.#markAttemptCancellations(task, cancellationRequestedAt)
      task.scopeAbort?.abort(new Error("父 Session 已删除"))
      const descendants = await this.#cancelOwnedTasks(task, "祖先 Session 已删除")
        .then((stopped) => ({ stopped }), (error) => ({ stopped: false, error }))
      try {
        const acknowledged = cancelAllAttempts
          ? await this.#cancelAllAttempts(task)
          : (await this.#execution.cancelTurn({ sessionID: task.record.childSessionID }))?.acknowledged !== false
        if (!acknowledged) throw new Error("宿主未确认取消请求")
        if (descendants.error) throw descendants.error
        await this.#inspect(task.record.taskID)
      } catch (error) {
        await this.#setStatus(task, TASK_STATUS_UNKNOWN, "owner-deleted-cancel-unconfirmed", {
          diagnostics: [...task.record.diagnostics, taskDiagnostic("owner-deleted-cancel-unconfirmed", errorText(error), this.#now())],
        })
      }
    }
  }

  #missingTaskTombstone(task) {
    if (task.missingTaskTombstone) return task.missingTaskTombstone
    const sourceTask = taskMetadata(task.record)
    task.missingTaskTombstone = {
      version: 1,
      taskID: sourceTask.taskID,
      ownerSessionID: sourceTask.ownerSessionID,
      sourceTaskSessionID: sourceTask.taskSessionID,
      targetRevision: sourceTask.revision + 1,
      createdAt: sourceTask.updatedAt,
      sourceTask,
      delegation: this.#persistedDelegation(task),
    }
    return task.missingTaskTombstone
  }

  #missingTaskRecord(tombstone, taskSessionID) {
    const cancelled = tombstone.sourceTask.cancellationRequestedAt !== undefined
    return taskMetadata({
      ...tombstone.sourceTask,
      revision: tombstone.targetRevision,
      status: cancelled ? TASK_STATUS_CANCELLED : TASK_STATUS_UNKNOWN,
      phase: cancelled ? "cancelled" : "missing-session",
      taskSessionID,
      updatedAt: tombstone.createdAt,
      ...(cancelled ? { endedAt: tombstone.sourceTask.endedAt ?? tombstone.createdAt } : {}),
      diagnostics: cancelled
        ? tombstone.sourceTask.diagnostics
        : [
            ...tombstone.sourceTask.diagnostics,
            taskDiagnostic("session-missing", "子 Session 不存在，无法证明执行结果", tombstone.createdAt),
          ],
    })
  }

  async #completeMissingTaskTombstone(tombstone, tombstoneSessionID, record, markerSessionIDs = [tombstoneSessionID]) {
    const owner = await this.#store.get(tombstone.ownerSessionID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    if (owner?.id) {
      await this.#store.updateO4E(tombstone.ownerSessionID, (state) => {
        const group = normalizeTaskGroupMetadata(state.backgroundTasks)
        const current = group.taskRefs[tombstone.taskID]
        const currentRevision = Math.max(
          current ? (current.taskRevision ?? 1) : 0,
          current?.recoveryEnvelope?.task?.revision ?? 0,
        )
        const currentOwnedByTombstone = !current
          || current.taskSessionID === tombstone.sourceTaskSessionID
          || current.taskSessionID === tombstoneSessionID
        const replaceRef = currentRevision < record.revision
          || (currentRevision === record.revision && currentOwnedByTombstone)
        const nextRef = replaceRef
          ? {
              taskSessionID: tombstoneSessionID,
              taskRevision: record.revision,
              kind: record.kind,
              sequence: record.sequence,
              createdAt: record.createdAt,
              ...(current?.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: current.cancellationRequestedAt }),
              ...(current?.recoveryEnvelope ? { recoveryEnvelope: current.recoveryEnvelope } : {}),
              ...taskRefReceiptFields(current),
            }
          : current
        const refChanged = replaceRef && !taskRefsEqual(current, nextRef)
        if (!refChanged) return state
        return {
          ...state,
          backgroundTasks: {
            ...group,
            revision: group.revision + 1,
            taskRefs: { ...group.taskRefs, [tombstone.taskID]: nextRef },
          },
        }
      }).catch((error) => {
        if (missingSessionError(error)) return
        throw error
      })
    }
    for (const markerSessionID of new Set(markerSessionIDs)) {
      await this.#store.updateO4E(markerSessionID, (state) => {
        if (state.kind !== "background-task-tombstone" || !state.tombstone) return state
        const marker = normalizeMissingTaskTombstone(state.tombstone)
        if (marker.taskID !== tombstone.taskID
          || marker.sourceTaskSessionID !== tombstone.sourceTaskSessionID
          || marker.targetRevision !== tombstone.targetRevision) return state
        const { tombstone: _tombstone, ...rest } = state
        return rest
      }).catch((error) => {
        if (!missingSessionError(error)) throw error
      })
    }
  }

  #missingTaskTombstoneState(sessions, tombstone) {
    const ledgers = sessions
      .map((session) => {
        const persisted = sessionO4E(session)?.task
        if (!persisted) return null
        try {
          const record = normalizeTaskMetadata(persisted)
          return record.taskID === tombstone.taskID ? { session, record } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.record.revision - left.record.revision || left.session.id.localeCompare(right.session.id))
    const markerSessionIDs = sessions
      .filter((session) => {
        const state = sessionO4E(session)
        if (state.kind !== "background-task-tombstone" || !state.tombstone) return false
        const marker = normalizeMissingTaskTombstone(state.tombstone)
        return marker.taskID === tombstone.taskID
          && marker.sourceTaskSessionID === tombstone.sourceTaskSessionID
          && marker.targetRevision === tombstone.targetRevision
      })
      .map((session) => session.id)
      .sort()
    const canonicalLedgers = ledgers.filter(({ record }) => record.revision >= tombstone.targetRevision)
    return {
      canonical: canonicalLedgers[0],
      markerSessionIDs,
    }
  }

  async #convergeMissingTaskTombstone(tombstone) {
    let currentSessions = await this.#ownerRecoverySessions(tombstone.ownerSessionID, tombstone.sourceTaskSessionID, tombstone)
    let state = this.#missingTaskTombstoneState(currentSessions, tombstone)
    if (state.canonical) {
      await this.#completeMissingTaskTombstone(tombstone, state.canonical.session.id, state.canonical.record, state.markerSessionIDs)
      return state.canonical
    }
    if (state.markerSessionIDs.length === 0) {
      const ownerExists = await this.#store.get(tombstone.ownerSessionID).then(
        (owner) => Boolean(owner?.id),
        (error) => {
          if (missingSessionError(error)) return false
          throw error
        },
      )
      await this.#store.create({
        ...(ownerExists ? { parentID: tombstone.ownerSessionID } : {}),
        title: `[o4e] missing task ${tombstone.taskID}`,
        metadata: { o4e: {
          kind: "background-task-tombstone",
          version: 1,
          tombstone,
          ...(tombstone.delegation ? { delegation: tombstone.delegation } : {}),
        } },
      })
    }
    currentSessions = await this.#ownerRecoverySessions(tombstone.ownerSessionID, undefined, tombstone)
    state = this.#missingTaskTombstoneState(currentSessions, tombstone)
    if (state.canonical) {
      await this.#completeMissingTaskTombstone(tombstone, state.canonical.session.id, state.canonical.record, state.markerSessionIDs)
      return state.canonical
    }
    const tombstoneSessionID = state.markerSessionIDs[0]
    if (!tombstoneSessionID) throw new Error(`missing-task tombstone 缺少 Session: ${tombstone.taskID}`)
    const record = this.#missingTaskRecord(tombstone, tombstoneSessionID)
    await this.#store.updateO4E(tombstoneSessionID, (sessionState) => {
      const { tombstone: _tombstone, ...rest } = sessionState
      return {
        ...rest,
        task: record,
        ...(tombstone.delegation ? { delegation: tombstone.delegation } : {}),
      }
    })
    await this.#completeMissingTaskTombstone(tombstone, tombstoneSessionID, record, state.markerSessionIDs)
    return { session: await this.#store.get(tombstoneSessionID), record }
  }

  async #ownerRecoverySessions(ownerSessionID, preferredSessionID, tombstone) {
    const sessions = []
    const seen = new Set()
    const remember = (session) => {
      if (!session?.id || seen.has(session.id)) return
      seen.add(session.id)
      sessions.push(session)
    }
    const owner = await this.#store.get(ownerSessionID).catch((error) => {
      if (missingSessionError(error)) return null
      throw error
    })
    remember(owner)
    for (const child of await this.#store.children(ownerSessionID).catch((error) => {
      if (missingSessionError(error)) return []
      throw error
    })) remember(child)
    if (preferredSessionID && !seen.has(preferredSessionID)) {
      remember(await this.#store.get(preferredSessionID).catch((error) => {
        if (missingSessionError(error)) return null
        throw error
      }))
    }
    if (!owner?.id && tombstone) {
      for (const session of await this.#store.list()) {
        const state = sessionO4E(session)
        if (state.task?.taskID === tombstone.taskID
          || (state.kind === "background-task-tombstone" && state.tombstone?.taskID === tombstone.taskID)) {
          remember(session)
        }
      }
    }
    return sessions
  }

  async #persistMissingTaskTombstone(task, { scheduleRetry = true } = {}) {
    if (task.missingTaskTombstoneWrite) return task.missingTaskTombstoneWrite
    const tombstone = this.#missingTaskTombstone(task)
    task.missingTaskTombstonePending = true
    task.missingTaskTombstoneRetryDelay ??= TOMBSTONE_RETRY_INITIAL_MS
    const write = serializeTaskMutation(this.#directory, tombstone.taskID, async () => {
      const owner = await this.#store.get(tombstone.ownerSessionID).catch((error) => {
        if (missingSessionError(error)) return null
        throw error
      })
      const ref = owner?.id
        ? normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks).taskRefs[tombstone.taskID]
        : undefined
      const refRevision = Math.max(
        ref ? (ref.taskRevision ?? 1) : 0,
        ref?.recoveryEnvelope?.task?.revision ?? 0,
      )
      const canonical = ref?.taskSessionID !== tombstone.sourceTaskSessionID && refRevision >= tombstone.targetRevision
        ? await this.#store.get(ref.taskSessionID).then((session) => {
            const persisted = sessionO4E(session)?.task
            const record = persisted ? normalizeTaskMetadata(persisted) : undefined
            return record?.taskID === tombstone.taskID && record.revision >= tombstone.targetRevision
              ? { session, record }
              : undefined
          }, (error) => {
            if (missingSessionError(error)) return undefined
            throw error
          })
        : undefined
      const converged = canonical ?? await this.#convergeMissingTaskTombstone(tombstone)
      if (!converged) throw new Error(`missing-task tombstone 无法定位 canonical ledger: ${tombstone.taskID}`)
      return converged
    }).then((canonical) => {
      task.missingTaskTombstoneSessionID = canonical.session.id
      task.record = canonical.record
      task.missingTaskTombstonePending = false
      task.missingTaskTombstone = undefined
      task.missingTaskTombstoneRetryDelay = TOMBSTONE_RETRY_INITIAL_MS
      const timer = this.#tombstoneRetryTimers.get(task.record.taskID)
      if (timer) this.#clock.clearTimeout(timer)
      this.#tombstoneRetryTimers.delete(task.record.taskID)
      if (tombstone.sourceTaskSessionID !== task.record.taskSessionID) this.#taskBySession.delete(tombstone.sourceTaskSessionID)
      this.#remember(task)
      this.#queueTaskRecoveryReference(task, canonical.record)
      this.#wakeOwner(task.record.ownerSessionID, "actionable")
    })
    task.missingTaskTombstoneWrite = write
    try {
      return await write
    } catch (error) {
      task.record = this.#missingTaskRecord(tombstone, task.missingTaskTombstoneSessionID ?? tombstone.sourceTaskSessionID)
      this.#remember(task)
      this.#wakeOwner(task.record.ownerSessionID, "actionable")
      if (scheduleRetry) this.#scheduleMissingTaskTombstoneRetry(task)
      throw error
    } finally {
      if (task.missingTaskTombstoneWrite === write) task.missingTaskTombstoneWrite = undefined
    }
  }

  #scheduleMissingTaskTombstoneRetry(task) {
    if (this.#disposed || this.#quiescing || !task.missingTaskTombstonePending || this.#tombstoneRetryTimers.has(task.record.taskID)) return
    const delay = task.missingTaskTombstoneRetryDelay ?? TOMBSTONE_RETRY_INITIAL_MS
    const timer = this.#clock.setTimeout(async () => {
      this.#tombstoneRetryTimers.delete(task.record.taskID)
      if (this.#disposed || this.#quiescing || !task.missingTaskTombstonePending) return
      try {
        await this.#withOwnerPublication(() => this.#persistMissingTaskTombstone(task, { scheduleRetry: false }))
      } catch {
        task.missingTaskTombstoneRetryDelay = Math.min(delay * 2, TOMBSTONE_RETRY_MAX_MS)
        this.#scheduleMissingTaskTombstoneRetry(task)
      }
    }, delay)
    timer.unref?.()
    this.#tombstoneRetryTimers.set(task.record.taskID, timer)
  }

  async #separateLedger(task, deletedSessionID) {
    return serial(this.#transitions, task.record.taskID, async () => {
      return serializeTaskMutation(this.#directory, task.record.taskID, async () => {
        await this.#refreshTaskFromOwnerRef(task)
        if (task.record.taskSessionID !== (deletedSessionID ?? task.record.childSessionID)) return task.record
        const previousTaskSessionID = task.record.taskSessionID
        const ledger = await this.#store.create({
          parentID: task.record.ownerSessionID,
          title: `[o4e] task ledger ${task.record.taskID}`,
        })
        const record = taskMetadata({
          ...task.record,
          revision: task.record.revision + 1,
          taskSessionID: ledger.id,
          updatedAt: this.#now(),
          diagnostics: [...task.record.diagnostics, deletedSessionID
            ? taskDiagnostic("task-ledger-replaced", `Task ledger 已替换删除的 Attempt ${previousTaskSessionID}`, this.#now())
            : taskDiagnostic("task-ledger-detached", `Task ledger 已从 Attempt ${previousTaskSessionID} 分离`, this.#now())],
        })
        await this.#store.updateO4E(ledger.id, (state) => ({ ...state, task: record, delegation: this.#persistedDelegation(task) }))
        this.#acceptTaskRecord(task, record)
        await this.#replaceTaskRefSerialized(task.record.ownerSessionID, task.record.taskID, {
          taskSessionID: ledger.id,
          taskRevision: record.revision,
          kind: task.record.kind,
          sequence: task.record.sequence,
          createdAt: task.record.createdAt,
        })
        this.#queueTaskRecoveryReference(task, record)
        if (deletedSessionID) this.#taskBySession.delete(previousTaskSessionID)
        return record
      })
    })
  }

  #persistedDelegation(task) {
    const prepared = task.prepared
    if (!prepared) return undefined
    return {
      depth: prepared.depth,
      maxDelegationDepth: prepared.maxDelegationDepth,
      remainingDelegationDepth: prepared.remainingDelegationDepth,
      status: task.record.status,
      parentSessionID: task.record.ownerSessionID,
      sourceAgent: prepared.requester?.name,
      requesterPermissionPattern: prepared.requesterPermissionPattern,
      requesterPermissionAction: prepared.requesterPermissionAction,
      requesterPermissionApproved: prepared.requesterPermissionApproved,
      targetAgent: prepared.target?.name,
      modelCandidates: task.record.modelCandidates,
      toolName: prepared.toolName,
      plan: prepared.plan,
      task: prepared.args?.task,
      outputContract: prepared.args?.outputContract,
      effect: prepared.effect?.kind,
      writeScopes: prepared.normalizedScopes,
      compiledPermission: prepared.compiledPermission,
      permissionOverlay: prepared.overlay,
      trace: prepared.args?.trace,
      recoveryContext: prepared.args?.recoveryContext,
      taskID: task.record.taskID,
      dispatchMessageID: task.record.dispatchMessageID,
      authorizationFingerprint: prepared.authorizationFingerprint,
    }
  }

  #taskRecoveryEnvelope(task) {
    return {
      version: 1,
      task: taskMetadata(task.record),
      ...(this.#persistedDelegation(task) ? { delegation: this.#persistedDelegation(task) } : {}),
    }
  }

  #queueTaskRecoveryReference(task, record) {
    // The canonical commit has already succeeded. Use the SessionStore owner
    // queue without acquiring the Task mutex (input/receipt/retry may hold it).
    // Only the outer operation waits, after releasing transition/Task mutexes.
    // Failure is diagnostic, never a rejected canonical commit or a replay.
    const snapshot = { record, prepared: task.prepared }
    const publication = this.#track(this.#attemptTaskRecoveryPublication(snapshot))
    this.#publicationScope.getStore()?.add(publication)
    return publication
  }

  async #attemptTaskRecoveryPublication(task, options) {
    const { taskID, revision } = task.record
    try {
      await this.#publishTaskRecoveryReferenceSerialized(task, options)
      if ((this.#publicationFailures.get(taskID)?.revision ?? 0) <= revision) this.#publicationFailures.delete(taskID)
    } catch {
      if ((this.#publicationFailures.get(taskID)?.revision ?? 0) <= revision) {
        this.#publicationFailures.set(taskID, {
          revision,
          diagnostic: taskDiagnostic("owner-publication-failed", "规范 Task 已提交；owner 副本发布未确认，可通过当前 owner 的定向恢复重试发布。", this.#now()),
        })
      }
    }
  }

  #publicationSnapshot(record) {
    const snapshot = structuredClone(record)
    const failure = this.#publicationFailures.get(record.taskID)
    if (snapshot.diagnostics) snapshot.diagnostics = snapshot.diagnostics.filter((entry) => entry.code !== "owner-publication-failed")
    if (failure && failure.revision <= record.revision) snapshot.diagnostics = [...(snapshot.diagnostics ?? []), failure.diagnostic]
    return snapshot
  }

  #publicationResult(result) {
    if (Array.isArray(result)) return result.map((entry) => this.#publicationResult(entry))
    if (result?.taskID && Number.isSafeInteger(result.revision)) return this.#publicationSnapshot(result)
    if (Array.isArray(result?.tasks)) return { ...result, tasks: result.tasks.map((entry) => this.#publicationResult(entry)) }
    return result
  }

  #withOwnerPublication(operation) {
    // A separate scope per entry/dispatch collects only this operation's writes,
    // not sibling background work or the whole owner queue. Never call this from
    // inside a Task/transition/SessionStore mutex. Nested entries settle their own
    // scope; dispatch starts a fresh scope rather than extending its caller's wait.
    return this.#track(this.#publicationScope.run(new Set(), async () => {
      const publications = this.#publicationScope.getStore()
      let result
      try {
        result = await operation()
      } finally {
        await Promise.all([...publications])
        publications.clear()
      }
      return this.#publicationResult(result)
    }))
  }

  async #publishTaskRecoveryReference(task, { preserveReceipts = true } = {}) {
    await serializeTaskMutation(this.#directory, task.record.taskID, () => this.#attemptTaskRecoveryPublication(task, { preserveReceipts }))
  }

  async #publishTaskRecoveryReferenceSerialized(task, { preserveReceipts = true } = {}) {
    // Capture both record and delegation before entering the owner write queue.
    task = { record: task.record, recoveryEnvelope: this.#taskRecoveryEnvelope(task) }
    await this.#store.updateO4E(task.record.ownerSessionID, (state, owner) => {
      if (owner?.id !== task.record.ownerSessionID) throw Object.assign(new Error("Task recovery projection owner unavailable"), { name: "NotFoundError" })
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      const current = group.taskRefs[task.record.taskID]
      const currentRevision = Math.max(
        current ? (current.taskRevision ?? 1) : 0,
        current?.recoveryEnvelope?.task?.revision ?? 0,
      )
      if (currentRevision > task.record.revision) return state
      const nextRef = {
        taskSessionID: task.record.taskSessionID,
        taskRevision: task.record.revision,
        kind: task.record.kind,
        sequence: task.record.sequence,
        createdAt: task.record.createdAt,
        ...(current?.cancellationRequestedAt !== undefined
          ? { cancellationRequestedAt: current.cancellationRequestedAt }
          : task.record.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: task.record.cancellationRequestedAt }),
        ...(preserveReceipts ? taskRefReceiptFields(current) : {}),
        recoveryEnvelope: task.recoveryEnvelope,
      }
      if (taskRefsEqual(current, nextRef)) return state
      return {
        ...state,
        backgroundTasks: {
          ...group,
          revision: group.revision + 1,
          taskRefs: { ...group.taskRefs, [task.record.taskID]: nextRef },
        },
      }
    })
  }

  async #rebuildMissingLedgerTombstone(ownerSessionID, taskID, existingTask) {
    return serializeTaskMutation(this.#directory, taskID, async () => {
      if (existingTask && existingTask.record.ownerSessionID !== ownerSessionID) {
        throw new Error(`Task owner 与父索引不一致: ${taskID}`)
      }
      const owner = await this.#store.get(ownerSessionID)
      const ref = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks).taskRefs[taskID]
      if (!ref) return null
      const indexedSession = await this.#store.get(ref.taskSessionID).catch((error) => {
        if (missingSessionError(error)) return null
        throw error
      })
      const persisted = sessionO4E(indexedSession)?.task
      if (persisted) {
        const record = normalizeTaskMetadata(persisted)
        if (record.taskID === taskID && record.taskSessionID === ref.taskSessionID) {
          if (record.ownerSessionID !== ownerSessionID) throw new Error(`Task owner 与父索引不一致: ${taskID}`)
          return this.#loadTask(record, indexedSession, { preferIndexed: true })
        }
      }
      const missingRevision = ref.taskRevision ?? existingTask?.record.revision ?? 1
      const children = await this.#store.children(ownerSessionID)
      // A prior replacement may have committed despite a lost create/update response.
      // Reconcile only this owner's addressed Task before creating another ledger.
      for (const child of children) {
        const state = sessionO4E(child)
        if (state.kind !== "background-task-tombstone" || state.tombstone?.taskID !== taskID) continue
        const tombstone = normalizeMissingTaskTombstone(state.tombstone)
        if (tombstone.ownerSessionID !== ownerSessionID) throw new Error(`Task tombstone owner 与父索引不一致: ${taskID}`)
        const canonical = await this.#convergeMissingTaskTombstone(tombstone)
        return this.#loadTask(canonical.record, canonical.session, { preferIndexed: true })
      }
      const replacements = children
        .filter((session) => sessionO4E(session).task?.taskID === taskID)
        .map((session) => ({ session, record: normalizeTaskMetadata(sessionO4E(session).task) }))
        .filter(({ session, record }) => session.id !== ref.taskSessionID && record.ownerSessionID === ownerSessionID
          && record.taskSessionID === session.id && record.revision >= missingRevision)
        .sort((left, right) => right.record.revision - left.record.revision || right.session.id.localeCompare(left.session.id))
      if (replacements.length) {
        const { session, record } = replacements[0]
        await this.#replaceTaskRefSerialized(ownerSessionID, taskID, {
          taskSessionID: session.id, taskRevision: record.revision,
          kind: record.kind, sequence: record.sequence, createdAt: record.createdAt,
        })
        return this.#loadTask(record, session, { preferIndexed: true })
      }
      const attempts = children.filter((session) => {
        const state = sessionO4E(session)
        return state.kind === "delegation-attempt" && state.delegation?.taskID === taskID
      })
      const orderedAttempts = attempts.toSorted((left, right) => {
        const leftDelegation = sessionO4E(left).delegation
        const rightDelegation = sessionO4E(right).delegation
        return (rightDelegation?.createdAt ?? rightDelegation?.startedAt ?? 0) - (leftDelegation?.createdAt ?? leftDelegation?.startedAt ?? 0)
      })
      const attempt = orderedAttempts[0]
      const priorRecord = existingTask?.record ?? ref.recoveryEnvelope?.task
      const delegation = attempt?.id ? sessionO4E(attempt).delegation : ref.recoveryEnvelope?.delegation
      if (!attempt?.id && !priorRecord) return null
      const childSessionID = attempt?.id ?? priorRecord?.childSessionID ?? (existingTask ? undefined : priorRecord?.taskSessionID)
      const attemptSessionIDs = [...new Set([
        ...(priorRecord?.attemptSessionIDs ?? []),
        ...(existingTask ? attempts : orderedAttempts).map((session) => session.id),
        ...(childSessionID ? [childSessionID] : []),
      ])]
      const tombstone = await this.#store.create({
        parentID: ownerSessionID,
        title: `[o4e] missing task ledger ${taskID}`,
      })
      const source = existingTask?.record ?? priorRecord
      const createdAt = existingTask ? source.createdAt : ref.createdAt
      const record = taskMetadata({
        ...(existingTask ? source : {
          ...source,
          version: TASK_METADATA_VERSION,
          sequence: ref.sequence,
          taskID,
          kind: ref.kind,
          ownerSessionID,
          agent: source?.agent ?? delegation?.targetAgent,
          authorizationFingerprint: source?.authorizationFingerprint ?? delegation?.authorizationFingerprint,
          effect: source?.effect ?? (["read", "scoped-write", "unknown-write"].includes(delegation?.effect) ? delegation.effect : "unknown-write"),
          writeScopes: source?.writeScopes ?? delegation?.writeScopes ?? [],
          dispatchMessageID: source?.dispatchMessageID ?? delegation?.dispatchMessageID,
          modelCandidates: source?.modelCandidates ?? [],
          failedModelCandidates: source?.failedModelCandidates ?? [],
          maxRetries: source?.maxRetries ?? 0,
          attemptNumber: source?.attemptNumber ?? 0,
          retryRound: source?.retryRound ?? 0,
          handledModelErrorAttempt: source?.handledModelErrorAttempt ?? 0,
          runGeneration: source?.runGeneration ?? 0,
          createdAt,
          queuedAt: source?.queuedAt ?? createdAt,
        }),
        revision: Math.max(missingRevision, source?.revision ?? 1) + 1,
        status: TASK_STATUS_UNKNOWN,
        phase: "missing-ledger",
        taskSessionID: tombstone.id,
        childSessionID,
        attemptSessionIDs,
        requiresAllAttemptsStopped: true,
        cancellationRequestedAt: existingTask ? source.cancellationRequestedAt ?? ref.cancellationRequestedAt : ref.cancellationRequestedAt,
        updatedAt: this.#now(),
        diagnostics: [...(source?.diagnostics ?? []), taskDiagnostic("task-ledger-missing", `父索引指向的 Task ledger 不存在: ${ref.taskSessionID}`, this.#now())],
      })
      const task = existingTask ?? {
        record,
        prepared: recoveredPrepared(record, delegation),
        context: { sessionID: ownerSessionID, directory: attempt?.directory ?? this.#directory },
        lockID: `background-task:${taskID}`,
        scopeAbort: new AbortController(),
        slotReleased: true,
        lockAcquired: false,
        dispatchPending: false,
        dispatchUnconfirmed: false,
        recovered: true,
        observedActive: false,
      }
      await this.#store.updateO4E(tombstone.id, (state) => ({ ...state, task: record, delegation: this.#persistedDelegation(task) }))
      if (existingTask) this.#acceptTaskRecord(task, record)
      else this.#remember(task)
      await this.#replaceTaskRefSerialized(ownerSessionID, taskID, {
        taskSessionID: tombstone.id,
        taskRevision: record.revision,
        kind: record.kind,
        sequence: record.sequence,
        createdAt: record.createdAt,
      })
      this.#queueTaskRecoveryReference(task, record)
      return task
    })
  }

  async #cancelAllAttempts(task) {
    let acknowledged = true
    for (const sessionID of new Set([...(task.record.attemptSessionIDs ?? []), task.record.childSessionID].filter(Boolean))) {
      try {
        const cancellation = await this.#execution.cancelTurn({ sessionID })
        if (cancellation?.acknowledged === false) acknowledged = false
      } catch (error) {
        if (!missingSessionError(error)) acknowledged = false
      }
    }
    return acknowledged
  }

  async #allAttemptsStopped(task, inspectionClaim) {
    let uncertain = false
    for (const sessionID of new Set([...(task.record.attemptSessionIDs ?? []), task.record.childSessionID].filter(Boolean))) {
      if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return false
      try {
        const inspection = await this.#execution.inspectTurn({ sessionID })
        if (inspectionClaim && !this.#inspectionClaimCurrent(task, inspectionClaim)) return false
        if (inspection?.state === "running" || inspection?.state === "retrying") {
          if (sessionID === task.record.childSessionID) this.#markLiveAttemptActive(task)
          return false
        }
        // Sparse host status maps omit stopped Sessions. As with single-Attempt
        // cancellation, omission cannot close an unconfirmed/pre-busy dispatch.
        const liveAttempt = this.#liveAttempt(task)
        const inactiveStopped = inspection?.state === "inactive"
          && !dispatchPending(this.#directory, task.record.taskID) && !task.dispatchPending && !task.dispatchUnconfirmed
          && (sessionID !== task.record.childSessionID || !liveAttempt
            || liveAttempt.phase === "active" && liveAttempt.observedActive)
        if (inspection?.state !== "idle" && inspection?.state !== "missing" && !inactiveStopped) uncertain = true
      } catch (error) {
        if (!missingSessionError(error)) uncertain = true
      }
    }
    return uncertain ? null : true
  }

  async #reserveTaskRef(ownerSessionID, { taskID, kind, taskSessionID: initialTaskSessionID, createdAt }) {
    let sequence
    await this.#store.updateO4E(ownerSessionID, (state) => {
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      sequence = group.nextSequence
      return {
        ...state,
        backgroundTasks: {
          version: TASK_GROUP_METADATA_VERSION,
          revision: group.revision + 1,
          nextSequence: sequence + 1,
          taskRefs: initialTaskSessionID
            ? {
                ...group.taskRefs,
                [taskID]: { taskSessionID: initialTaskSessionID, kind, sequence, createdAt },
              }
            : group.taskRefs,
        },
      }
    })
    return sequence
  }

  async #replaceTaskRef(ownerSessionID, taskID, ref, options = {}) {
    await serializeTaskMutation(this.#directory, taskID, () => this.#replaceTaskRefSerialized(ownerSessionID, taskID, ref, options))
  }

  async #replaceTaskRefSerialized(ownerSessionID, taskID, ref, { preserveNewerTaskRef = false } = {}) {
    return this.#store.updateO4E(ownerSessionID, (state) => {
        const group = normalizeTaskGroupMetadata(state.backgroundTasks)
        const current = group.taskRefs[taskID]
        const currentRevision = Math.max(
          current ? (current.taskRevision ?? 1) : 0,
          current?.recoveryEnvelope?.task?.revision ?? 0,
        )
        const incomingRevision = Math.max(
          ref.taskRevision ?? 1,
          ref.recoveryEnvelope?.task?.revision ?? 0,
        )
        const preserveCurrentTaskRef = preserveNewerTaskRef && current && currentRevision > incomingRevision
        const nextRef = {
          ...replaceTaskRefReceiptFields(preserveCurrentTaskRef ? current : ref),
          ...(current?.cancellationRequestedAt !== undefined && ref.cancellationRequestedAt === undefined
            ? { cancellationRequestedAt: current.cancellationRequestedAt }
            : ref.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: ref.cancellationRequestedAt }),
          ...(current?.recoveryEnvelope ? { recoveryEnvelope: current.recoveryEnvelope } : {}),
          ...mergeTaskRefReceiptFields(current, ref),
        }
        if (taskRefsEqual(current, nextRef)) return state
        return {
          ...state,
          backgroundTasks: {
            ...group,
            revision: group.revision + 1,
            taskRefs: { ...group.taskRefs, [taskID]: nextRef },
          },
        }
    })
  }

  async #markTaskRefCancellation(task, cancellationRequestedAt) {
    await this.#store.updateO4E(task.record.ownerSessionID, (state) => {
      const group = normalizeTaskGroupMetadata(state.backgroundTasks)
      const ref = group.taskRefs[task.record.taskID]
      if (!ref) throw new Error(`父 Session 缺少 Task 索引: ${task.record.taskID}`)
      return {
        ...state,
        backgroundTasks: {
          ...group,
          revision: group.revision + 1,
          taskRefs: {
            ...group.taskRefs,
            [task.record.taskID]: {
              ...ref,
              cancellationRequestedAt: ref.cancellationRequestedAt ?? cancellationRequestedAt,
            },
          },
        },
      }
    })
  }

  async #markAttemptCancellations(task, cancellationRequestedAt) {
    for (const sessionID of new Set([...(task.record.attemptSessionIDs ?? []), task.record.childSessionID].filter(Boolean))) {
      await this.#store.updateO4E(sessionID, (state) => ({
        ...state,
        delegation: state.delegation
          ? { ...state.delegation, cancellationRequestedAt: state.delegation.cancellationRequestedAt ?? cancellationRequestedAt }
          : state.delegation,
      })).catch((error) => {
        if (!missingSessionError(error)) throw error
      })
    }
  }

  #remember(task) {
    if (!Number.isSafeInteger(task.observationEpoch)) task.observationEpoch = 0
    if (!Number.isSafeInteger(task.dispatchEpoch)) task.dispatchEpoch = 0
    this.#tasks.set(task.record.taskID, task)
    if (task.record.taskSessionID) this.#taskBySession.set(task.record.taskSessionID, task.record.taskID)
    for (const sessionID of task.record.attemptSessionIDs ?? []) this.#taskBySession.set(sessionID, task.record.taskID)
    if (task.record.childSessionID) this.#taskBySession.set(task.record.childSessionID, task.record.taskID)
    this.#scheduler.refresh?.(task.record)
  }

  #liveAttempt(task) {
    const attempt = this.#liveAttempts.get(task.record.taskID)
    if (!attempt
      || attempt.childSessionID !== task.record.childSessionID
      || attempt.dispatchMessageID !== task.record.dispatchMessageID
      || attempt.attemptNumber !== task.record.attemptNumber) return undefined
    return attempt
  }

  #claimLiveAttempt(task, phase) {
    const current = this.#liveAttempt(task)
    const attempt = current ?? {
      childSessionID: task.record.childSessionID,
      dispatchMessageID: task.record.dispatchMessageID,
      attemptNumber: task.record.attemptNumber,
      phase,
      observedActive: false,
      owners: new Set(),
    }
    attempt.phase = phase
    attempt.owners.add(this)
    this.#liveAttempts.set(task.record.taskID, attempt)
    return attempt
  }

  #adoptLiveAttempt(task) {
    const attempt = this.#liveAttempt(task)
    if (!attempt) return
    attempt.owners.add(this)
    task.recovered = false
    task.observedActive ||= attempt.observedActive
    task.observationEpoch = (task.observationEpoch ?? 0) + 1
  }

  #markLiveAttemptActive(task) {
    const attempt = this.#claimLiveAttempt(task, "active")
    attempt.observedActive = true
  }

  #track(operation) {
    this.#inflight.add(operation)
    return operation.finally(() => this.#inflight.delete(operation))
  }

  #deferDispatchIfPaused(task) {
    if (this.#dispatchSuspensions === 0) return false
    // Only remember work that already entered dispatch, never all hydrated Tasks.
    this.#deferredDispatch.add(task.record.taskID)
    this.#recoveryDispatchedOwners.delete(task.record.ownerSessionID)
    return true
  }

  #resumeDeferredDispatch() {
    if (this.#disposed || this.#quiescing || this.#dispatchSuspensions > 0) return
    const taskIDs = [...this.#deferredDispatch]
    this.#deferredDispatch.clear()
    this.#dispatch(taskIDs)
  }

  #discardDeferredDispatch(ownerSessionID) {
    for (const taskID of this.#deferredDispatch) {
      const owner = this.#tasks.get(taskID)?.record.ownerSessionID ?? this.#scheduler.record?.(taskID)?.ownerSessionID
      if (!ownerSessionID || !owner || owner === ownerSessionID) this.#deferredDispatch.delete(taskID)
    }
    for (const task of this.#tasks.values()) {
      if (ownerSessionID && task.record.ownerSessionID !== ownerSessionID) continue
      // Also invalidate owner reads still in flight and not yet deferred.
      task.dispatchEpoch += 1
      this.#deferredDispatch.delete(task.record.taskID)
    }
    if (ownerSessionID) this.#recoveryDispatchedOwners.delete(ownerSessionID)
    else this.#recoveryDispatchedOwners.clear()
  }

  #dispatch(taskIDs) {
    if (this.#disposed || this.#quiescing) return
    if (this.#dispatchSuspensions > 0) {
      for (const taskID of taskIDs) {
        const task = this.#tasks.get(taskID)
        if (task) this.#deferDispatchIfPaused(task)
        else this.#deferredDispatch.add(taskID)
      }
      return
    }
    for (const taskID of taskIDs) {
      const task = this.#tasks.get(taskID)
      if (task?.runPending) continue
      if (task && this.#scheduler.isActive(task.record)) task.slotReleased = false
      if (task) task.runPending = true
      const run = this.#withOwnerPublication(() => this.#run(taskID))
      this.#runs.add(run)
      void run.catch(() => undefined).finally(() => {
        this.#runs.delete(run)
        if (task) task.runPending = false
      })
    }
  }

  #blockMissingTaskDispatch(task, sessionID) {
    task.dispatchBlockedByMissingSession = sessionID
    const neverHostSubmitted = task.record.status === TASK_STATUS_QUEUED
      && task.record.phase === "queued"
      && task.record.attemptNumber === 0
      && !dispatchPending(this.#directory, task.record.taskID)
      && !task.dispatchPending
      && !task.dispatchUnconfirmed
    task.retainConservativeLock = !neverHostSubmitted && task.record.effect !== "read"
    const withdrawn = neverHostSubmitted
      ? this.#scheduler.withdraw(task.record)
      : { admitted: [] }
    if (neverHostSubmitted) task.slotReleased = true
    task.scopeAbort?.abort(new Error("Task Session 已删除"))
    if (task.retainConservativeLock) {
      if (!task.lockAcquired) {
        this.#locks.restore(task.lockID, {
          kind: task.record.effect,
          writeScopes: task.record.writeScopes,
        }, { allowConflict: true })
        task.lockAcquired = true
      }
    } else if (task.lockAcquired) {
      this.#locks.release(task.lockID)
      task.lockAcquired = false
    }
    this.#dispatch(withdrawn.admitted)
  }

  #releaseSlot(task) {
    if (cancellationPending(this.#directory, task.record) && !(task.record.status === TASK_STATUS_UNKNOWN && task.record.phase === "authorization-unverifiable" && task.record.endedAt !== undefined)) return
    if (task.slotReleased) return
    task.slotReleased = true
    this.#dispatch(this.#scheduler.release(task.record))
  }

  #recordOccupiesSlot(record) {
    if (isTerminalTaskStatus(record.status) || record.status === TASK_STATUS_QUEUED || record.status === TASK_STATUS_INTERRUPTED) return false
    if (record.status !== TASK_STATUS_UNKNOWN) return true
    if (record.phase === "authorization-unverifiable" && record.endedAt !== undefined) return false
    return cancellationPending(this.#directory, record) || record.requiresAllAttemptsStopped || record.attemptNumber > 0
  }

  #retainSlot(task) {
    if (isTerminalTaskStatus(task.record.status)) return
    this.#scheduler.restoreActive(task.record)
    task.slotReleased = false
  }

  #retainConservativeLock(task) {
    if (task.record.effect === "read" || task.lockAcquired) return
    this.#locks.restore(task.lockID, {
      kind: task.record.effect,
      writeScopes: task.record.writeScopes,
    }, { allowConflict: true })
    task.lockAcquired = true
  }

  #releaseTerminal(task) {
    this.#releaseSlot(task)
    if (task.lockAcquired) {
      task.lockAcquired = false
      this.#locks.release(task.lockID)
    }
    if (isTerminalTaskStatus(task.record.status)) cancellationFences.delete(taskFenceKey(this.#directory, task.record.taskID))
    this.#scheduleTerminalReceipt(task)
  }

  #scheduleTerminalReceipt(task) {
    const signal = task.pendingTerminalSignal
    const receiptID = signal?.record?.receipt?.receiptID
    if (!receiptID || task.terminalNotificationReceiptID === receiptID) return
    task.pendingTerminalSignal = undefined
    task.terminalNotificationReceiptID = receiptID
    const bypassActiveWatch = (signal.record.pendingInputs?.length ?? 0) > 0
    if (!this.#onTerminalReceipt || this.#disposed) {
      return
    }
    this.#queueTerminalReceiptNotification({
      record: signal.record,
      receipt: signal.record.receipt,
      bypassActiveWatch,
      deferForWatch: signal.activeParentWatchers > 0 && !bypassActiveWatch,
    })
  }

  async #recoverTerminalReceiptNotifications(ownerSessionID) {
    if (!this.#onTerminalReceipt || this.#disposed) return
    const owner = await this.#store.get(ownerSessionID).catch(() => null)
    const group = normalizeTaskGroupMetadata(sessionO4E(owner)?.backgroundTasks)
    for (const [taskID, ref] of Object.entries(group.taskRefs)) {
      for (const receipt of taskRefReceipts(ref)) {
        if (receipt.receiptAcknowledgedAt !== undefined) continue
        this.#queueTerminalReceiptNotification({
          record: {
            ownerSessionID,
            taskID,
            status: receipt.receiptStatus,
            phase: receipt.receiptPhase,
          },
          receipt: {
            receiptID: receipt.receiptID,
            deliveredToMessageID: receipt.receiptDeliveredToMessageID,
          },
          bypassActiveWatch: !isTerminalTaskStatus(this.#tasks.get(taskID)?.record.status)
            || this.#tasks.get(taskID)?.record.receipt?.receiptID !== receipt.receiptID,
        })
      }
    }
  }

  #queueTerminalReceiptNotification(notification) {
    const receiptID = notification?.receipt?.receiptID
    if (!receiptID || !this.#onTerminalReceipt || this.#disposed) return
    const current = this.#pendingTerminalNotifications.get(receiptID)
    this.#pendingTerminalNotifications.set(receiptID, current
          ? {
              record: { ...current.record, ...notification.record },
              receipt: { ...current.receipt, ...notification.receipt },
              bypassActiveWatch: current.bypassActiveWatch || notification.bypassActiveWatch,
              deferForWatch: Boolean(current.deferForWatch && notification.deferForWatch),
            }
      : notification)
    this.#deliverTerminalReceiptNotification(receiptID)
  }

  #deliverTerminalReceiptNotification(receiptID) {
    const notification = this.#pendingTerminalNotifications.get(receiptID)
    if (!notification || notification.deferForWatch || this.#terminalNotificationDeliveries.has(receiptID) || !this.#onTerminalReceipt || this.#disposed || this.#quiescing) return
    const retryTimer = this.#terminalNotificationRetryTimers.get(receiptID)
    if (retryTimer) {
      this.#clock.clearTimeout(retryTimer)
      this.#terminalNotificationRetryTimers.delete(receiptID)
    }
    const delivery = (async () => {
      try {
        const task = this.#tasks.get(notification.record.taskID)
        if (task?.record.receipt?.receiptID === receiptID) await this.#publishReceiptReference(task.record)
        if (this.#disposed || this.#quiescing) return
        await this.#onTerminalReceipt({
          ownerSessionID: notification.record.ownerSessionID,
          taskID: notification.record.taskID,
          receiptID,
          status: notification.record.status,
          phase: notification.record.phase,
          ...(notification.receipt.deliveredToMessageID ? { deliveredToMessageID: notification.receipt.deliveredToMessageID } : {}),
          ...(notification.bypassActiveWatch ? { bypassActiveWatch: true } : {}),
        })
        this.#pendingTerminalNotifications.delete(receiptID)
      } catch (error) {
        this.#scheduleTerminalReceiptRetry(receiptID)
        throw error
      }
    })()
    this.#terminalNotificationDeliveries.set(receiptID, delivery)
    void delivery.finally(() => {
      if (this.#terminalNotificationDeliveries.get(receiptID) === delivery) this.#terminalNotificationDeliveries.delete(receiptID)
    }).catch(() => undefined)
    void this.#track(delivery).catch(() => undefined)
  }

  #scheduleTerminalReceiptRetry(receiptID) {
    if (this.#disposed || this.#quiescing || this.#terminalNotificationRetryTimers.has(receiptID)) return
    const timer = this.#clock.setTimeout(() => {
      this.#terminalNotificationRetryTimers.delete(receiptID)
      if (!this.#disposed && !this.#quiescing) this.#deliverTerminalReceiptNotification(receiptID)
    }, 1000)
    this.#terminalNotificationRetryTimers.set(receiptID, timer)
  }

  async #consumeTerminalNotifications(tasks, context, prepare) {
    const signal = context?.abort
    const consumed = tasks.flatMap((task) => {
      const receiptID = task.record.kind !== "command" && task.record.ownerSessionID === context?.sessionID && isTerminalTaskStatus(task.record.status)
        ? task.record.receipt?.receiptID
        : undefined
      return receiptID ? [{ ownerSessionID: task.record.ownerSessionID, taskID: task.record.taskID, receiptID }] : []
    })
    const deliveries = Promise.allSettled(consumed.map(({ receiptID }) => this.#terminalNotificationDeliveries.get(receiptID)).filter(Boolean))
    if (signal) {
      if (signal.aborted) throw abortError(signal)
      let onAbort
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(abortError(signal))
        signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        await Promise.race([deliveries, aborted])
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    } else await deliveries
    if (signal?.aborted) throw abortError(signal)
    // Presentation can fail (for example an oversized watch selection). Resolve
    // that before admitting any durable receipt acknowledgement.
    prepare?.()
    const persistentlyConsumed = typeof context?.messageID === "string" && context.messageID !== "" && consumed.length > 0
    if (persistentlyConsumed) {
      context.readCommit?.()
      const receiptIDs = consumed.map(({ receiptID }) => receiptID)
      await Promise.resolve(this.#onTerminalReceiptConsuming?.({ ownerSessionID: context.sessionID, receiptIDs })).catch(() => undefined)
      try {
        await this.acknowledgeReceipts(receiptIDs, context, context.messageID)
        for (const notification of consumed) {
          await Promise.resolve(this.#onTerminalReceiptConsumed?.({
            ...notification,
            receiptIDs,
          })).catch(() => undefined)
        }
      } catch (error) {
        await Promise.resolve(this.#onTerminalReceiptConsumptionFailed?.({ ownerSessionID: context.sessionID, receiptIDs })).catch(() => undefined)
        throw error
      }
    }
    if (!persistentlyConsumed) for (const notification of consumed) {
      if (signal?.aborted) throw abortError(signal)
      await this.#awaitRead(context, () => Promise.resolve(this.#onTerminalReceiptConsumed?.(notification)).catch(() => undefined))
    }
    for (const { receiptID } of consumed) {
      this.#pendingTerminalNotifications.delete(receiptID)
      const timer = this.#terminalNotificationRetryTimers.get(receiptID)
      if (timer) this.#clock.clearTimeout(timer)
      this.#terminalNotificationRetryTimers.delete(receiptID)
    }
  }

  #releaseDeferredTerminalNotifications(ownerSessionID, watch) {
    for (const [receiptID, notification] of this.#pendingTerminalNotifications) {
      if (
        !notification.deferForWatch
        || notification.record.ownerSessionID !== ownerSessionID
        || (!watch.watchAll && !watch.watchedTaskIDs.has(notification.record.taskID))
      ) continue
      if (this.#sharedWatch?.hasWatch(ownerSessionID, notification.record.taskID)) continue
      notification.deferForWatch = false
      this.#deliverTerminalReceiptNotification(receiptID)
    }
  }

  async #actionableWatchResult(ownerSessionID, tasks, context, waitedMs) {
    let watched
    await this.#consumeTerminalNotifications(tasks, context, () => {
      watched = this.#watchResult(ownerSessionID, "actionable", tasks, waitedMs)
      context.validateWatchResult?.(publicWatchResult(watched))
    })
    // Freeze the preflighted business result across the receipt transaction. Only
    // refresh receipt revisions for the same execution; a concurrent new turn
    // must not replace this call's result after its presentation was checked.
    for (const snapshot of watched.tasks) {
      const current = tasks.find((task) => task.record.taskID === snapshot.taskID)?.record
      if (!isTerminalTaskStatus(snapshot.status) || current?.status !== snapshot.status
        || INSPECTION_IDENTITY_FIELDS.some((key) => current[key] !== snapshot[key])
        || current.receipt?.receiptID !== snapshot.receipt?.receiptID) continue
      snapshot.revision = current.revision
      snapshot.updatedAt = current.updatedAt
      snapshot.receipt = structuredClone(current.receipt)
    }
    return this.#publicationResult(watched)
  }

  #watchResult(ownerSessionID, reason, tasks, waitedMs) {
    return {
      reason,
      waitedMs,
      tasks: tasks.map((task) => this.#publicationSnapshot(task.record)),
    }
  }

  #wakeOwner(ownerSessionID, reason, predicate) {
    const watchers = this.#watchers.get(ownerSessionID)
    if (!watchers) return 0
    let woken = 0
    for (const watcher of [...watchers]) {
      if (watcher.inspection && reason === "progress") continue
      if (predicate && !predicate(watcher)) continue
      if (reason === "progress" || reason === "actionable") {
        const changed = watcher.watchAll || [...watcher.watchedTaskIDs].some((taskID) => {
          const task = this.#tasks.get(taskID)
          return task && task.record.revision !== watcher.revisions.get(taskID)
        })
        if (!changed) continue
      }
      this.#removeWatcher(ownerSessionID, watcher)
      watcher.resolve({ reason })
      woken += 1
    }
    return woken
  }

  #removeWatcher(ownerSessionID, watcher) {
    watcher.cleanup?.()
    const watchers = this.#watchers.get(ownerSessionID)
    watchers?.delete(watcher)
    if (watchers?.size === 0) this.#watchers.delete(ownerSessionID)
  }

  #now() {
    return this.#clock.now()
  }

  #assertActive() {
    if (this.#disposed || this.#quiescing) throw new Error("后台 Task Runtime 正在释放")
  }

  #assertCreationActive(creationAdmission, contextAbort) {
    if (this.#disposed || this.#quiescing || creationAdmission !== this.#creationAdmission.signal || creationAdmission?.aborted || contextAbort?.aborted) {
      throw backgroundCreationClosedError(contextAbort?.aborted ? contextAbort.reason : creationAdmission?.reason)
    }
  }
}
