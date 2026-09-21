import { TASK_KIND_AGENT, TASK_KIND_COMMAND } from "../core/background-task-domain.mjs"
import { normalizeBackgroundTaskConfig } from "../core/background-task-domain.mjs"
import { canonicalDirectoryKey } from "./directory-key.mjs"

function laneLimit(kind, limits) {
  if (kind === TASK_KIND_AGENT) return limits.maxConcurrentAgents
  if (kind === TASK_KIND_COMMAND) return limits.maxConcurrentCommands
  throw new Error(`不支持的 Background Task kind: ${String(kind)}`)
}

function taskOrder(left, right) {
  return left.sequence - right.sequence || left.taskID.localeCompare(right.taskID)
}

function taskMode(record) {
  return record.effect === "read" ? "read" : "write"
}

export class BackgroundTaskScheduler {
  #limits
  #groups = new Map()

  constructor(limits) {
    this.#limits = normalizeBackgroundTaskConfig(limits)
  }

  setLimits(limits) {
    this.#limits = normalizeBackgroundTaskConfig(limits)
  }

  drainAll() {
    const admitted = []
    for (const [ownerSessionID, group] of this.#groups) {
      for (const [kind, lane] of group) admitted.push(...this.#drain(ownerSessionID, kind, lane))
    }
    return admitted
  }

  enqueue(record) {
    const lane = this.#lane(record)
    if (lane.active.has(record.taskID) || lane.queued.some((entry) => entry.taskID === record.taskID)) return []
    lane.queued.push({ taskID: record.taskID, sequence: record.sequence, mode: taskMode(record) })
    lane.queued.sort(taskOrder)
    return this.#drain(record.ownerSessionID, record.kind, lane)
  }

  restoreActive(record) {
    const lane = this.#lane(record)
    lane.queued = lane.queued.filter((entry) => entry.taskID !== record.taskID)
    lane.active.set(record.taskID, taskMode(record))
  }

  removeQueued(record) {
    const lane = this.#lane(record)
    const index = lane.queued.findIndex((entry) => entry.taskID === record.taskID)
    if (index < 0) return false
    lane.queued.splice(index, 1)
    return true
  }

  withdraw(record, { drain = true } = {}) {
    const lane = this.#lane(record)
    const queuedBefore = lane.queued.length
    lane.queued = lane.queued.filter((entry) => entry.taskID !== record.taskID)
    const removedQueued = lane.queued.length !== queuedBefore
    const removedActive = lane.active.delete(record.taskID)
    return {
      removedQueued,
      removedActive,
      admitted: removedActive && drain ? this.#drain(record.ownerSessionID, record.kind, lane) : [],
    }
  }

  release(record) {
    const lane = this.#lane(record)
    if (!lane.active.delete(record.taskID)) return []
    return this.#drain(record.ownerSessionID, record.kind, lane)
  }

  isQueued(record) {
    return this.#lane(record).queued.some((entry) => entry.taskID === record.taskID)
  }

  isActive(record) {
    return this.#lane(record).active.has(record.taskID)
  }

  clear() {
    this.#groups.clear()
  }

  drain(record) {
    const lane = this.#lane(record)
    return this.#drain(record.ownerSessionID, record.kind, lane)
  }

  #lane(record) {
    let group = this.#groups.get(record.ownerSessionID)
    if (!group) {
      group = new Map()
      this.#groups.set(record.ownerSessionID, group)
    }
    let lane = group.get(record.kind)
    if (!lane) {
      lane = { active: new Map(), queued: [] }
      group.set(record.kind, lane)
    }
    return lane
  }

  #drain(ownerSessionID, kind, lane) {
    const admitted = []
    const limit = laneLimit(kind, this.#limits)
    while (lane.active.size < limit && lane.queued.length > 0) {
      // Admission limits concurrency; write conflicts belong to ScopeLockManager.
      // Read-only work may observe a changing workspace, not a frozen snapshot.
      const next = lane.queued.shift()
      lane.active.set(next.taskID, next.mode)
      admitted.push(next.taskID)
    }
    if (lane.active.size === 0 && lane.queued.length === 0) {
      const group = this.#groups.get(ownerSessionID)
      group?.delete(kind)
      if (group?.size === 0) this.#groups.delete(ownerSessionID)
    }
    return admitted
  }
}

const SHARED_SCHEDULERS = Symbol.for("opencode-for-everything.background-task-schedulers.v1")
const sharedSchedulers = globalThis[SHARED_SCHEDULERS] ??= new Map()

function sharedSchedulerState(key, limits) {
  let state = sharedSchedulers.get(key)
  if (!state) {
    state = {
      scheduler: new BackgroundTaskScheduler(limits),
      entries: new Map(),
      facades: new Set(),
      facadeLimits: new Map(),
    }
    sharedSchedulers.set(key, state)
  }
  return state
}

function minimumLimits(limits) {
  return {
    maxRetries: Math.min(...limits.map((value) => value.maxRetries)),
    maxConcurrentAgents: Math.min(...limits.map((value) => value.maxConcurrentAgents)),
    maxConcurrentCommands: Math.min(...limits.map((value) => value.maxConcurrentCommands)),
  }
}

class SharedBackgroundTaskScheduler {
  #key
  #state
  #dispatcher
  #closed = false

  constructor(key, limits) {
    this.#key = canonicalDirectoryKey(key)
    this.#state = sharedSchedulerState(this.#key, limits)
    this.#state.facades.add(this)
    this.#state.facadeLimits.set(this, normalizeBackgroundTaskConfig(limits))
    this.#state.scheduler.setLimits(minimumLimits([...this.#state.facadeLimits.values()]))
  }

  setDispatcher(dispatcher) {
    if (this.#closed) return
    this.#dispatcher = dispatcher
  }

  enqueue(record) {
    if (this.#closed) return []
    this.#claim(record)
    return this.#route(this.#state.scheduler.enqueue(record))
  }

  restoreActive(record) {
    if (this.#closed) return
    this.#claim(record)
    this.#state.scheduler.restoreActive(record)
  }

  removeQueued(record) {
    if (this.#closed) return false
    const removed = this.#state.scheduler.removeQueued(record)
    if (removed) this.#state.entries.delete(record.taskID)
    return removed
  }

  withdraw(record, options) {
    if (this.#closed) return { removedQueued: false, removedActive: false, admitted: [] }
    const result = this.#state.scheduler.withdraw(record, options)
    if (result.removedQueued || result.removedActive) this.#state.entries.delete(record.taskID)
    return { ...result, admitted: this.#route(result.admitted) }
  }

  release(record) {
    if (this.#closed) return []
    const admitted = this.#state.scheduler.release(record)
    this.#state.entries.delete(record.taskID)
    return this.#route(admitted)
  }

  isQueued(record) {
    if (this.#closed) return false
    return this.#state.scheduler.isQueued(record)
  }

  isActive(record) {
    if (this.#closed) return false
    return this.#state.scheduler.isActive(record)
  }

  isLastFacade() {
    return !this.#closed && this.#state.facades.size === 1
  }

  refresh(record) {
    if (this.#closed) return
    const entry = this.#state.entries.get(record.taskID)
    if (entry) entry.record = record
  }

  record(taskID) {
    if (this.#closed) return undefined
    return this.#state.entries.get(taskID)?.record
  }

  recordForSession(sessionID, kind) {
    if (this.#closed) return undefined
    for (const entry of this.#state.entries.values()) {
      if (kind !== undefined && entry.record.kind !== kind) continue
      if (entry.record.taskSessionID === sessionID
        || entry.record.childSessionID === sessionID
        || entry.record.attemptSessionIDs?.includes(sessionID)) return entry.record
    }
    return undefined
  }

  clear() {
    if (this.#closed) return
    this.#releaseEntries()
  }

  dispose() {
    if (this.#closed) return
    this.#closed = true
    this.#releaseEntries()
    this.#state.facades.delete(this)
    this.#state.facadeLimits.delete(this)
    if (this.#state.facades.size === 0) {
      this.#state.scheduler.clear()
      sharedSchedulers.delete(this.#key)
      return
    }
    this.#state.scheduler.setLimits(minimumLimits([...this.#state.facadeLimits.values()]))
    this.#route(this.#state.scheduler.drainAll())
  }

  #releaseEntries() {
    const lanes = new Map()
    const handedActive = new Set()
    for (const [taskID, entry] of this.#state.entries) {
      if (!entry.facades.delete(this)) continue
      if (entry.owner === this) entry.owner = entry.facades.values().next().value
      if (entry.facades.size === 0) {
        const successor = [...this.#state.facades].find((facade) => facade !== this && !facade.#closed)
        if (successor) {
          entry.facades.add(successor)
          entry.owner = successor
        }
      }
      if (entry.facades.size > 0) {
        if (this.#state.scheduler.isActive(entry.record)) handedActive.add(taskID)
        continue
      }
      this.#state.scheduler.withdraw(entry.record, { drain: false })
      this.#state.entries.delete(taskID)
      lanes.set(`${entry.record.ownerSessionID}\0${entry.record.kind}`, entry.record)
    }
    for (const record of lanes.values()) this.#route(this.#state.scheduler.drain(record))
    this.#scheduleDispatch([...handedActive])
  }

  #claim(record) {
    let entry = this.#state.entries.get(record.taskID)
    if (!entry) {
      entry = { record, owner: this, facades: new Set(), dispatchScheduled: false }
      this.#state.entries.set(record.taskID, entry)
    }
    entry.record = record
    entry.facades.add(this)
    entry.owner = this
  }

  #route(taskIDs) {
    const local = []
    const remote = []
    for (const taskID of taskIDs) {
      const entry = this.#state.entries.get(taskID)
      const owner = entry?.owner
      if (!owner || owner === this) {
        local.push(taskID)
        continue
      }
      remote.push(taskID)
    }
    this.#scheduleDispatch(remote)
    return local
  }

  #scheduleDispatch(taskIDs) {
    const scheduled = []
    for (const taskID of taskIDs) {
      const entry = this.#state.entries.get(taskID)
      if (!entry || entry.dispatchScheduled) continue
      entry.dispatchScheduled = true
      scheduled.push(taskID)
    }
    if (scheduled.length === 0) return
    queueMicrotask(() => {
      const byOwner = new Map()
      for (const taskID of scheduled) {
        const entry = this.#state.entries.get(taskID)
        if (!entry) continue
        entry.dispatchScheduled = false
        let owner = entry.owner
        if (!owner || owner.#closed) {
          owner = [...entry.facades].find((facade) => !facade.#closed)
            ?? [...this.#state.facades].find((facade) => !facade.#closed)
          if (owner) {
            entry.facades.add(owner)
            entry.owner = owner
          }
        }
        if (!owner || owner.#closed) continue
        const owned = byOwner.get(owner) ?? []
        owned.push(taskID)
        byOwner.set(owner, owned)
      }
      for (const [owner, owned] of byOwner) owner.#dispatcher?.(owned)
    })
  }
}

export function createSharedBackgroundTaskScheduler(key, limits) {
  return new SharedBackgroundTaskScheduler(key, limits)
}
