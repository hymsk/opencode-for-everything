import { canonicalDirectoryKey } from "../../runtime/directory-key.mjs"

const SHARED = Symbol.for("opencode-for-everything.automatic-task-follow.v1")
const directories = globalThis[SHARED] ??= new Map()

function sessionState(entry, sessionID) {
  let state = entry.sessions.get(sessionID)
  if (!state) {
    state = {
      epoch: 0,
      activated: false,
      suppressed: false,
      claims: new Map(),
      completed: new Set(),
      trackedCommands: new Set(),
      deliveredCommandRevisions: new Map(),
      deliveredTaskEvents: new Map(),
      terminalAttempts: new Map(),
    }
    entry.sessions.set(sessionID, state)
  }
  return state
}

function bound(set, limit = 512) {
  while (set.size > limit) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

export function acquireAutomaticTaskFollow(directory) {
  directory = canonicalDirectoryKey(directory)
  let entry = directories.get(directory)
  if (!entry) {
    entry = { refs: 0, sessions: new Map() }
    directories.set(directory, entry)
  }
  entry.refs += 1
  const owner = Symbol("automatic-task-follow")
  let released = false
  return {
    resume(sessionID) {
      const state = sessionState(entry, sessionID)
      const wasSuppressed = state.suppressed
      state.activated = true
      state.suppressed = false
      state.epoch += 1
      state.terminalAttempts.clear()
      state.completed.clear()
      state.deliveredTaskEvents.clear()
      state.claims.clear()
      return wasSuppressed
    },
    suppress(sessionID) {
      const state = sessionState(entry, sessionID)
      if (state.suppressed) return false
      state.suppressed = true
      state.epoch += 1
      return true
    },
    isSuppressed(sessionID) {
      return entry.sessions.get(sessionID)?.suppressed === true
    },
    trackCommand(sessionID, taskID) {
      const state = sessionState(entry, sessionID)
      state.activated = true
      state.trackedCommands.add(taskID)
    },
    activate(sessionID) {
      sessionState(entry, sessionID).activated = true
    },
    isActivated(sessionID) {
      return entry.sessions.get(sessionID)?.activated === true
    },
    commandDelivered(sessionID, task) {
      const state = sessionState(entry, sessionID)
      state.deliveredCommandRevisions.set(task.taskID, task.revision)
      if (!["queued", "running"].includes(task.status)) state.trackedCommands.delete(task.taskID)
    },
    commandNeedsDelivery(sessionID, task) {
      const state = entry.sessions.get(sessionID)
      return state?.trackedCommands.has(task?.taskID) === true
        && state.deliveredCommandRevisions.get(task.taskID) !== task.revision
    },
    taskNeedsDelivery(sessionID, taskID, key) {
      return entry.sessions.get(sessionID)?.deliveredTaskEvents.get(taskID) !== key
    },
    admitTerminalSubmission(sessionID, key) {
      const state = sessionState(entry, sessionID)
      const count = state.terminalAttempts.get(key) ?? 0
      if (count >= 3) return false
      state.terminalAttempts.set(key, count + 1)
      while (state.terminalAttempts.size > 512) state.terminalAttempts.delete(state.terminalAttempts.keys().next().value)
      return true
    },
    begin(sessionID, key) {
      const state = sessionState(entry, sessionID)
      // One submission per owner, not per batch: {A} and {A,B} overlap even
      // though their batch keys differ. The accepted turn will trigger a fresh
      // idle check for any remaining/new events.
      if (state.suppressed || state.completed.has(key) || state.claims.size > 0) return undefined
      const token = Symbol("automatic-task-follow-claim")
      state.claims.set(key, { owner, token, epoch: state.epoch })
      return { key, token, epoch: state.epoch }
    },
    current(sessionID, claim) {
      const state = entry.sessions.get(sessionID)
      const current = state?.claims.get(claim?.key)
      return Boolean(state && !state.suppressed && current?.token === claim?.token && current.epoch === state.epoch)
    },
    finish(sessionID, claim, { accepted = false, commandTasks = [], taskEvents = [] } = {}) {
      const state = entry.sessions.get(sessionID)
      const current = state?.claims.get(claim?.key)
      if (!state || current?.token !== claim?.token) return false
      state.claims.delete(claim.key)
      if (!accepted || current.epoch !== state.epoch || state.suppressed) return false
      state.completed.add(claim.key)
      bound(state.completed)
      // Keep only the latest event per Task, without evicting unchanged live
      // Tasks when the owner has more than 512 of them.
      for (const { taskID, key } of taskEvents) state.deliveredTaskEvents.set(taskID, key)
      for (const task of commandTasks) {
        state.deliveredCommandRevisions.set(task.taskID, task.revision)
        if (!task.unfinished) state.trackedCommands.delete(task.taskID)
      }
      return true
    },
    deleteSession(sessionID) {
      entry.sessions.delete(sessionID)
    },
    release() {
      if (released) return
      released = true
      for (const state of entry.sessions.values()) {
        for (const [key, claim] of state.claims) if (claim.owner === owner) state.claims.delete(key)
      }
      entry.refs -= 1
      if (entry.refs <= 0 && directories.get(directory) === entry) directories.delete(directory)
    },
  }
}

// This is an optional current-contract owner record, not an old Task reader.
// Missing means the owner has never explicitly configured follow control.
export function automaticFollowControl(o4e) {
  const value = o4e?.automaticFollow
  if (value === undefined) return { revision: 1, enabled: true }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.enabled !== "boolean"
    || (value.diagnostic !== undefined && value.diagnostic !== "automatic-follow-failed")) {
    throw new Error("O4E_FOLLOW_STATE_INVALID")
  }
  return { revision: value.revision, enabled: value.enabled,
    ...(value.diagnostic ? { diagnostic: value.diagnostic } : {}) }
}

export function updateAutomaticFollowControl(o4e, { expectedRevision, enabled, diagnostic }) {
  const current = automaticFollowControl(o4e)
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("O4E_FOLLOW_REVISION_CONFLICT")
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("O4E_FOLLOW_REVISION_EXHAUSTED")
  return { ...o4e, automaticFollow: { revision: current.revision + 1,
    enabled: enabled ?? current.enabled, ...(diagnostic ? { diagnostic } : {}) } }
}
