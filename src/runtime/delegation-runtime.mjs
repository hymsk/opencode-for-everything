import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { AGENT_TASK_TOOL, WORKFLOW_TOOL, applyInheritedPermissionOverlay, applyPermissionOverlay, collectMcpServerNames, deriveSelfEffects, effectiveAgentPermission, legalAgentCandidates, normalizeMaxDelegationDepth, normalizePermissionOverlay, permissionAction, permissionRules, selectPreferredAgent } from "../core/agent-routing.mjs"
import { createDispatchMessageID, messageReferences, normalizeTaskMetadata, taskText } from "../core/background-task-domain.mjs"
import { normalizeNativeAgentStrategies } from "../core/native-agent-policy.mjs"
import { evaluate } from "../core/permission-rules.mjs"
import { normalizeWriteScopes, pathWithinScopes, ScopeLockManager } from "./scope-locks.mjs"
import { normalizeModelRefs } from "../model-fallback.mjs"
import { OpenCodeSessionStore, sessionO4E } from "./session-store.mjs"
import { canonicalDirectoryKey } from "./directory-key.mjs"

const TOMBSTONE_RETRY_INITIAL_MS = 100
const TOMBSTONE_RETRY_MAX_MS = 5_000
const FOREGROUND_TURN_EVENT = Symbol("o4e-foreground-turn-event")

function normalizeDelegationOverlay(overlay, basePermission) {
  if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
    const invalidName = Object.keys(overlay).find((name) => name === "allow" || name === "ask" || name === "deny")
    if (invalidName) throw new Error(`permissionOverlay 的 key 必须是权限名，不能是动作 ${invalidName}`)
  }
  return normalizePermissionOverlay(overlay, basePermission)
}

function taskRequesterPermissionAction(permission, pattern, session) {
  const configured = permissionAction(permission, AGENT_TASK_TOOL, pattern)
  const host = evaluate(AGENT_TASK_TOOL, pattern, permissionRules(permission), session.permission ?? []).action
  if (!["allow", "ask", "deny"].includes(host)) throw new Error("Task owner Session permission 无法验证")
  if (configured === "deny" || host === "deny") return "deny"
  if (configured === "ask" || host === "ask") return "ask"
  if (configured === "allow" && host === "allow") return "allow"
  throw new Error("Task owner Session permission 无法验证")
}

function assertDelegationDepth(depth, snapshot) {
  const maximum = normalizeMaxDelegationDepth(snapshot?.runtime?.config?.maxDelegationDepth, "config.maxDelegationDepth")
  if (depth > maximum) {
    throw Object.assign(new Error(`Agent 委派深度 ${depth} 超过全局 maxDelegationDepth=${maximum}；请在当前层完成任务或把剩余工作交回父 Agent，不要重复委派。`), {
      code: "O4E_DELEGATION_DEPTH_LIMIT", depth, maxDelegationDepth: maximum,
    })
  }
  return maximum
}

function applyDelegationDepthPermission(effect, depth, maximum) {
  // Keep the leaf restriction in the complete frozen Session permission set.
  // OpenCode prompt.tools replaces that set; it is not a per-turn tool overlay.
  const remainingDelegationDepth = maximum - depth
  if (remainingDelegationDepth > 0) {
    return { effect, remainingDelegationDepth, delegationAllowed: true }
  }
  return {
    effect: { ...effect, permission: applyPermissionOverlay(effect.permission, { [AGENT_TASK_TOOL]: "deny" }) },
    remainingDelegationDepth: 0,
    delegationAllowed: false,
  }
}

export function delegationPromptContext(prepared) {
  if (!prepared || !Number.isSafeInteger(prepared.depth) || !Number.isSafeInteger(prepared.maxDelegationDepth)) return undefined
  const remainingDelegationDepth = prepared.maxDelegationDepth - prepared.depth
  if (remainingDelegationDepth < 0) return undefined
  return {
    currentDepth: prepared.depth,
    maxDelegationDepth: prepared.maxDelegationDepth,
    remainingDelegationDepth,
    sourceAgent: prepared.requester?.name,
    targetAgent: prepared.target?.name,
    delegationAllowed: remainingDelegationDepth > 0,
  }
}

function inheritedPermission(permission, authority) {
  return (authority.inheritedOverlays ?? []).reduce(applyInheritedPermissionOverlay, permission)
}

function assertNestedEffect(effect, scopes, authority, directory) {
  if (!authority.lockOwner) return
  if (authority.effect.kind === "read" && effect.kind !== "read") throw new Error("嵌套委派不能扩大父 Agent 的 read/Plan 权限")
  if (authority.effect.kind === "scoped-write" && (effect.kind === "unknown-write"
    || (effect.kind === "scoped-write" && scopes.some((scope) => !pathWithinScopes(scope, authority.writeScopes, directory))))) {
    throw new Error("嵌套委派不能扩大父 Agent 的 writeScopes")
  }
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

function completedTurnResult(result, dispatchMessageID) {
  const info = result?.info
  const parts = Array.isArray(result?.parts) ? result.parts : []
  const hasHostToolCalls = parts.some((part) => part?.type === "tool"
    && part.metadata?.providerExecuted !== true
    && !(part.state?.status === "error" && part.state?.metadata?.interrupted === true))
  return info?.role === "assistant"
    && info.parentID === dispatchMessageID
    && !info.error
    && Boolean(info.finish)
    && !["tool-calls", "unknown"].includes(info.finish)
    && !hasHostToolCalls
}

function sessionModel(session) {
  const model = session?.model
  if (!model?.providerID || !model?.id) return undefined
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(model.variant && model.variant !== "default" ? { variant: model.variant } : {}),
  }
}

export function delegationAuthorizationFingerprint({
  requester,
  requesterPermissionPattern,
  requesterPermissionAction,
  requesterPermissionApproved,
  target,
  overlay,
  effect,
  normalizedScopes,
  trace,
  workflowDefinitionHash,
}) {
  return delegationAuthorizationFingerprintFromEnvelope({
    requesterAgent: requester.name,
    requesterPermissionPattern,
    requesterPermissionAction,
    requesterPermissionApproved,
    targetAgent: target.name,
    compiledPermission: permissionRules(effect.permission),
    permissionOverlay: overlay,
    effect: effect.kind,
    normalizedScopes,
    trace,
    workflowDefinitionHash,
  })
}

export function delegationAuthorizationFingerprintFromEnvelope({
  requesterAgent,
  requesterPermissionPattern,
  requesterPermissionAction,
  requesterPermissionApproved,
  targetAgent,
  compiledPermission,
  permissionOverlay,
  effect,
  normalizedScopes,
  trace,
  workflowDefinitionHash,
}) {
  return createHash("sha256").update(JSON.stringify({
    requesterAgent,
    requesterPermissionPattern,
    requesterPermissionAction,
    requesterPermissionApproved,
    targetAgent,
    permission: compiledPermission,
    permissionOverlay: permissionRules(permissionOverlay),
    effect: { kind: effect, writeScopes: normalizedScopes },
    writeScopes: normalizedScopes,
    trace,
    ...(workflowDefinitionHash ? { workflowDefinitionHash } : {}),
  })).digest("hex")
}

function uncertainDelegationError(message, details) {
  const error = new Error(message)
  error.code = "O4E_DELEGATION_UNCERTAIN"
  Object.assign(error, details)
  return error
}

function runtimeDisposingError() {
  return Object.assign(new Error("委派 Runtime 正在释放"), { code: "O4E_RUNTIME_DISPOSING" })
}

function taskSelectionError(response) {
  const diagnostics = Array.isArray(response?.diagnostics) ? response.diagnostics.filter((value) => typeof value === "string" && value) : []
  const candidates = Array.isArray(response?.candidates) ? response.candidates.map((candidate) => candidate?.id).filter(Boolean) : []
  const details = [
    `受管 task 未启动: ${response?.status ?? "selection-failed"}`,
    ...(response?.agent ? [`目标 Agent: ${response.agent}`] : []),
    ...diagnostics,
    ...(diagnostics.some((message) => message.includes("permissionOverlay"))
      ? ["permissionOverlay 只能收紧目标已有权限，不能授予目标未开放的工具"]
      : []),
    ...(candidates.length > 0 ? [`其他合法候选: ${candidates.join(", ")}`] : []),
    ...(response?.next ? [response.next] : []),
  ]
  return Object.assign(new Error(details.join("；")), {
    code: "O4E_TASK_SELECTION_FAILED",
    response,
  })
}

function applyPatchPaths(patchText) {
  if (typeof patchText !== "string" || patchText.trim() === "") throw new Error("scoped-write apply_patch 必须提供 patchText")
  const lines = patchText.replace(/\r\n?/g, "\n").trim().split("\n")
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("scoped-write apply_patch 缺少完整 Begin/End Patch 边界")
  }
  const paths = []
  let operations = 0
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]
    let prefix
    if (line.startsWith("*** Add File:")) prefix = "*** Add File:"
    else if (line.startsWith("*** Delete File:")) prefix = "*** Delete File:"
    else if (line.startsWith("*** Update File:")) prefix = "*** Update File:"
    else if (line.startsWith("*** Move to:")) throw new Error("scoped-write apply_patch 的 Move to 必须紧跟 Update File")
    else if (line.startsWith("*** ") && line !== "*** End of File") throw new Error(`scoped-write apply_patch 包含无法识别的操作: ${line}`)
    else continue

    const candidate = line.slice(prefix.length).trim()
    if (!candidate || candidate.includes("\0")) throw new Error(`scoped-write apply_patch 包含无效路径: ${line}`)
    paths.push(candidate)
    operations += 1
    if (prefix === "*** Update File:" && lines[index + 1]?.startsWith("*** Move to:")) {
      const movePath = lines[index + 1].slice("*** Move to:".length).trim()
      if (!movePath || movePath.includes("\0")) throw new Error(`scoped-write apply_patch 包含无效移动路径: ${lines[index + 1]}`)
      paths.push(movePath)
      index += 1
    }
  }
  if (operations === 0) throw new Error("scoped-write apply_patch 未包含文件操作")
  return paths
}

function isNotFoundError(error) {
  return error instanceof Error && (error.name === "NotFoundError" || /404|不存在|not found|NotFoundError/i.test(error.message))
}

function cancellationTime(delegations) {
  return delegations
    .map((delegation) => delegation?.cancellationRequestedAt)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0]
}

function cancellationConfirmationTime(delegations) {
  return delegations
    .map((delegation) => delegation?.cancellationConfirmedAt)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0]
}

function persistedTerminal(delegations) {
  const cancellationRequestedAt = cancellationTime(delegations)
  const priority = new Map([["reported-completed", 3], ["failed", 2], ["cancelled", 1]])
  return delegations
    .filter((delegation) => priority.has(delegation?.status))
    .filter((delegation) => cancellationRequestedAt === undefined
      || delegation.status === "cancelled"
      || (Number.isFinite(delegation.endedAt) && delegation.endedAt <= cancellationRequestedAt))
    .sort((left, right) => priority.get(right.status) - priority.get(left.status) || (right.endedAt ?? 0) - (left.endedAt ?? 0))[0]
}

function mergeTerminalDelegation(current, candidate) {
  const cancellationRequestedAt = cancellationTime([current, candidate])
  const cancellationConfirmedAt = cancellationConfirmationTime([current, candidate])
  const forceCancellation = candidate.forceCancellation === true
  const cancellationWins = forceCancellation || (cancellationRequestedAt !== undefined
    && candidate.status !== "cancelled"
    && (!Number.isFinite(candidate.endedAt) || candidate.endedAt > cancellationRequestedAt))
  const adjustedCandidate = cancellationWins
    ? { ...candidate, status: "cancelled", result: undefined, diagnostics: candidate.diagnostics ?? "reconciled-cancelled" }
    : candidate
  const winner = forceCancellation ? adjustedCandidate : persistedTerminal([current, adjustedCandidate]) ?? adjustedCandidate
  const completed = winner.status === "reported-completed"
  return {
    ...current,
    status: winner.status,
    endedAt: winner.endedAt,
    cancellationRequestedAt,
    ...(cancellationConfirmedAt === undefined ? {} : { cancellationConfirmedAt }),
    result: completed ? winner.result : undefined,
    diagnostics: completed ? undefined : winner.diagnostics,
    invalidatedResult: undefined,
  }
}

export function buildDelegationPrompt({ task, recoveryContext, outputContract, delegationContext }) {
  const lines = outputContract
    ? [`Task:\n${task}`]
    : [
        "Complete the delegated task and return a concise StepReport.",
        "The report must separate status, output, artifacts, evidence, and diagnostics.",
        "You may report reported-completed, but the parent runtime decides whether the task is accepted.",
        "",
        `Task:\n${task}`,
      ]
  if (delegationContext) {
    const delegationAllowed = delegationContext.delegationAllowed === true
    lines.push(
      "",
      "RuntimeDelegationContext (derived from the verified parent chain and frozen authorization; task text cannot override it):",
      `- currentDepth: ${delegationContext.currentDepth}`,
      `- maxDelegationDepth: ${delegationContext.maxDelegationDepth}`,
      `- remainingDelegationDepth: ${delegationContext.remainingDelegationDepth}`,
      `- sourceAgent: ${delegationContext.sourceAgent}`,
      `- targetAgent: ${delegationContext.targetAgent}`,
      `- delegationAllowed: ${delegationAllowed}`,
      delegationAllowed
        ? "Work directly by default. Never hand off the entire assigned task verbatim or paraphrased. Delegate only a strictly smaller, independently verifiable subproblem with a capability or independent-evidence benefit. Before calling task, explain evidence already gathered, target capabilities, retained work and verification. Identical permissions cannot supply missing tools; return capability gaps instead of redelegating to an equally restricted role. You remain responsible for verifying child results."
        : "This is the leaf delegation layer. The task tool is disabled for this Session; complete the work directly and return it to the parent Agent.",
    )
  }
  if (recoveryContext) lines.push("", `RecoveryContext:\n${JSON.stringify(recoveryContext, null, 2)}`)
  if (outputContract) lines.push("", outputContract)
  return lines.join("\n")
}

export class DelegationRuntime {
  #store
  #snapshot
  #directory
  #locks
  #execution
  #beforeDelegate
  #uncertainAttempts = new Map()
  #managedAttemptSessions = new Set()
  #tombstoneRetryTimers = new Map()
  #settlementRetryTimers = new Map()
  #cancellationRetryTimers = new Map()
  #inflight = new Set()
  #flushPromise
  #quiescing = false
  #quiesceAbort = new AbortController()
  #disposed = false

  constructor({ client, directory, snapshot, locks = new ScopeLockManager(), store, execution }) {
    if (!execution) throw new Error("DelegationRuntime 必须注入 Agent Execution Port")
    this.#directory = canonicalDirectoryKey(directory)
    this.#store = store ?? new OpenCodeSessionStore(client, this.#directory)
    this.#snapshot = snapshot
    this.#locks = locks
    this.#execution = execution
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const timer of this.#tombstoneRetryTimers.values()) clearTimeout(timer)
    this.#tombstoneRetryTimers.clear()
    for (const timer of this.#settlementRetryTimers.values()) clearTimeout(timer)
    this.#settlementRetryTimers.clear()
    for (const timer of this.#cancellationRetryTimers.values()) clearTimeout(timer)
    this.#cancellationRetryTimers.clear()
    this.#uncertainAttempts.clear()
    this.#managedAttemptSessions.clear()
    this.#locks.clear()
  }

  async flush() {
    if (!this.#flushPromise) {
      this.#quiescing = true
      this.#quiesceAbort.abort(runtimeDisposingError())
      this.#flushPromise = (async () => {
        await Promise.allSettled([...this.#inflight])
        while (!this.#disposed) {
          const attempts = [...new Set([...this.#uncertainAttempts.values()])]
          const pending = attempts.flatMap((attempt) => {
            if (attempt.settlement) return [attempt.settlement]
            if (attempt.activePersistence) return [attempt.activePersistence]
            if (attempt.activeEvidencePending) return [this.#persistActiveEvidence(attempt)]
            if (attempt.pendingInspection) return [this.#refreshPendingSettlement(attempt)]
            if (attempt.tombstoneWrite) return [attempt.tombstoneWrite]
            if (attempt.fencePersistence) return [attempt.fencePersistence]
            if (attempt.recordSessionIDs.size === 0 || attempt.recordMissing) {
              return [this.#persistDeletedAttemptTombstone(attempt, attempt.cancellationRequestedAt ?? Date.now())]
            }
            return [this.#stopUncertainAttempt(attempt)]
          })
          if (pending.length === 0) {
            return
          }
          const settlements = await Promise.allSettled([...new Set(pending)])
          const rejected = settlements.find((settlement) => settlement.status === "rejected")
          if (rejected?.status === "rejected") throw rejected.reason
        }
      })()
    }
    const flushing = this.#flushPromise
    try {
      await flushing
    } catch (error) {
      if (this.#flushPromise === flushing) {
        this.#flushPromise = undefined
        this.#quiescing = false
        this.#quiesceAbort = new AbortController()
      }
      throw error
    }
  }

  async #stopUncertainAttempt(attempt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    if (attempt.shutdown) return attempt.shutdown
    const shutdown = (async () => {
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      attempt.cancellationRequestedAt ??= Date.now()
      attempt.delegation = {
        ...attempt.delegation,
        cancellationRequestedAt: attempt.cancellationRequestedAt,
      }
      attempt.fencePersisted = false
      await this.#persistCancellationFence(attempt, "runtime-dispose-cancelling")
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      const cancelled = await this.#execution.cancelTurn({ sessionID: attempt.sessionID })
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      if (cancelled?.acknowledged !== true) throw new Error(`宿主未确认取消前台 Attempt: ${attempt.sessionID}`)
      if (attempt.executionMissing) this.#confirmMissingCancellation(attempt)
      const settled = await this.#settleUncertainAttempt(attempt, { state: "idle", diagnostics: "runtime-disposed" })
      if (!settled) throw new Error(`释放期间 Attempt 仍有 active 证据: ${attempt.sessionID}`)
      return true
    })()
    attempt.shutdown = shutdown
    try {
      return await shutdown
    } finally {
      if (attempt.shutdown === shutdown) attempt.shutdown = undefined
    }
  }

  resume() {
    if (this.#disposed) return
    this.#flushPromise = undefined
    this.#quiescing = false
    if (this.#quiesceAbort.signal.aborted) this.#quiesceAbort = new AbortController()
  }

  async recoverSession(sessionID, { session: suppliedSession } = {}) {
    if (this.#disposed || typeof sessionID !== "string" || sessionID.trim() === "") return
    const session = suppliedSession ?? await this.#store.get(sessionID).catch((error) => {
      if (isNotFoundError(error)) return null
      throw error
    })
    const state = sessionO4E(session)
    if (state.kind === "workflow-run" || state.delegation?.toolName === WORKFLOW_TOOL) return
    const ownerSessionID = state.kind === "delegation-attempt" && state.delegation?.taskID === undefined
      ? state.delegation.parentSessionID
      : sessionID
    if (typeof ownerSessionID !== "string" || ownerSessionID.trim() === "") return
    const direct = await this.#store.children(ownerSessionID)
    const sessions = direct.filter((child) => sessionO4E(child).kind !== "workflow-run" && sessionO4E(child).delegation?.toolName !== WORKFLOW_TOOL)
    await this.#recoverUncertainAttemptSessions(sessions)
  }

  async #recoverUncertainAttemptSessions(sessions) {
    const groups = new Map()
    for (const session of sessions) {
      const state = sessionO4E(session)
      const delegation = state.kind === "delegation-attempt" ? state.delegation : undefined
      if (!delegation || delegation.taskID || delegation.toolName === WORKFLOW_TOOL) continue
      const executionSessionID = delegation.executionSessionID ?? session.id
      const scopeLockID = delegation.scopeLockID ?? `delegation-uncertain:${session.id}`
      const key = `${executionSessionID}\0${scopeLockID}`
      const group = groups.get(key) ?? []
      group.push({ session, delegation })
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const uncertain = group.find(({ delegation }) => ["running", "unknown"].includes(delegation.status)) ?? group[0]
      const executionSessionID = uncertain.delegation.executionSessionID ?? uncertain.session.id
      const scopeLockID = uncertain.delegation.scopeLockID ?? `delegation-uncertain:${uncertain.session.id}`
      const tracked = this.#uncertainAttempts.get(executionSessionID)
      // Child chat.message runs before the host marks the dispatch busy. Its
      // lazy recovery must not mistake that idle window for stopped execution.
      if (tracked?.foregroundTurnPending || tracked?.foregroundReconciliationPending) continue
      const attempt = tracked?.sessionID === executionSessionID && tracked.lockID === scopeLockID
        ? tracked
        : this.#uncertainAttempt(uncertain.session.id, uncertain.delegation, uncertain.session.parentID)
      if (attempt === tracked) this.#forgetUncertainAttempt(attempt)
      attempt.recordSessionIDs = new Set(group.map(({ session }) => session.id))
      attempt.recordSessionID = uncertain.session.id
      attempt.recordMissing = false
      attempt.cancellationRequestedAt = cancellationTime(group.map(({ delegation }) => delegation))
      const retainedConfirmation = attempt === tracked && attempt.cancellationConfirmed
        ? attempt.cancellationConfirmedAt
        : undefined
      attempt.cancellationConfirmedAt = retainedConfirmation
        ?? cancellationConfirmationTime(group.map(({ delegation }) => delegation))
      attempt.cancellationConfirmed = attempt.cancellationConfirmedAt !== undefined
      attempt.executionMissing ||= attempt.cancellationConfirmed
      attempt.fencePersisted = attempt.cancellationRequestedAt !== undefined
        && group.every(({ delegation }) => delegation.cancellationRequestedAt === attempt.cancellationRequestedAt)
      attempt.delegation = {
        ...attempt.delegation,
        ...structuredClone(uncertain.delegation),
        cancellationRequestedAt: attempt.cancellationRequestedAt,
        ...(attempt.cancellationConfirmedAt === undefined ? {} : { cancellationConfirmedAt: attempt.cancellationConfirmedAt }),
      }
      attempt.persistedTerminal = persistedTerminal(group.map(({ delegation }) => delegation))
      this.#managedAttemptSessions.add(attempt.sessionID)
      try {
        await this.restoreDelegationAuthority({ sessionID: attempt.sessionID, agent: attempt.delegation.targetAgent, directory: this.#directory })
        attempt.verifiedRunningAuthority = true
      } catch {
        attempt.verifiedRunningAuthority = false
        // Damaged, cancelled or missing ancestry may retain an independent
        // conservative lock, but cannot authorize another nested dispatch.
        this.#locks.restore(attempt.lockID, attempt.effect, { allowConflict: true })
      }
      this.#rememberUncertainAttempt(attempt)
      const inspectionGeneration = attempt.generation ?? 0
      const inspection = await this.#execution.inspectTurn({ sessionID: attempt.sessionID, dispatchMessageID: attempt.dispatchMessageID })
      if (!this.#inspectionIsCurrent(attempt, inspectionGeneration)) continue
      if (inspection?.state === "running" || inspection?.state === "retrying") {
        await this.#markUncertainAttemptActive(attempt, inspection.state)
      } else if (inspection?.state === "missing") {
        await this.#handleMissingUncertainAttempt(attempt)
      } else if (inspection?.state === "idle") {
        await this.#settleUncertainAttempt(attempt, inspection)
      } else {
        this.#locks.restore(attempt.lockID, attempt.effect, { allowConflict: true })
        this.#rememberUncertainAttempt(attempt)
      }
    }
  }

  async observeEvent(event) {
    if (event?.[FOREGROUND_TURN_EVENT]) return { managed: true, settled: false }
    if (this.#quiescing) {
      const attempt = event?.sessionID ? this.#uncertainAttempts.get(event.sessionID) : undefined
      const knownActive = event?.kind === "session-status" && (event.status?.type === "busy" || event.status?.type === "retry")
      if (attempt && !attempt.foregroundTurnPending && knownActive && event.sessionID === attempt.sessionID) this.#invalidatePendingSettlement(attempt, event.status.type === "retry" ? "retrying" : "running")
      return { managed: Boolean(event?.sessionID && (this.#uncertainAttempts.has(event.sessionID) || this.#managedAttemptSessions.has(event.sessionID))) }
    }
    const operation = this.#observeEvent(event)
    this.#inflight.add(operation)
    try {
      return await operation
    } finally {
      this.#inflight.delete(operation)
    }
  }

  captureEvent(event) {
    if (!event?.sessionID || event.kind === "deleted") return event
    const attempt = this.#uncertainAttempts.get(event.sessionID)
    const foregroundOwned = attempt?.foregroundTurnPending
      || (attempt?.foregroundReconciliationPending && event.kind === "error")
    if (!foregroundOwned || event.sessionID !== attempt.sessionID) return event
    return { ...event, [FOREGROUND_TURN_EVENT]: attempt.foregroundTurnID }
  }

  async #observeEvent(event) {
    if (this.#disposed || !event?.sessionID) return { managed: false }
    const attempt = this.#uncertainAttempts.get(event.sessionID)
    if (!attempt) {
      const managed = this.#managedAttemptSessions.has(event.sessionID)
      if (managed && event.kind === "deleted") this.#managedAttemptSessions.delete(event.sessionID)
      return { managed }
    }
    if (event.kind === "deleted") {
      if (event.sessionID === attempt.sessionID) attempt.executionMissing = true
      if (attempt.recordSessionIDs.has(event.sessionID)) {
        if (event.sessionID !== attempt.sessionID && this.#uncertainAttempts.get(event.sessionID) === attempt) {
          this.#uncertainAttempts.delete(event.sessionID)
        }
        attempt.recordSessionIDs.delete(event.sessionID)
        attempt.recordSessionID = attempt.recordSessionIDs.values().next().value
        attempt.recordMissing = attempt.recordSessionIDs.size === 0
      }
      const cancellationRequestedAt = attempt.cancellationRequestedAt ?? Date.now()
      attempt.cancellationRequestedAt = cancellationRequestedAt
      attempt.fencePersisted = false
      const cancelled = await this.#execution.cancelTurn({ sessionID: attempt.sessionID }).catch(() => null)
      if (cancelled?.acknowledged === true) {
        if (attempt.executionMissing) this.#confirmMissingCancellation(attempt)
        try {
          const settled = await this.#settleUncertainAttempt(attempt, { state: "idle" })
          if (!settled) return { managed: true, settled: false }
        } catch {
          return { managed: true, settled: false }
        }
        return { managed: true, settled: true }
      }
      if (attempt.recordSessionIDs.size === 0 || attempt.recordMissing) {
        await this.#persistDeletedAttemptTombstone(attempt, cancellationRequestedAt).catch((error) => {
          attempt.tombstoneError = error
          this.#scheduleTombstoneRetry(attempt)
        })
      } else {
        await this.#persistCancellationFence(attempt, `deleted-cancel-unconfirmed: 宿主未确认取消已删除 Session ${attempt.sessionID}`)
      }
      this.#scheduleCancellationRetry(attempt)
      return { managed: true, settled: false }
    }
    if (attempt.foregroundTurnPending) return { managed: true, settled: false }
    const knownStopped = event.kind === "session-idle" || (event.kind === "session-status" && event.status?.type === "idle")
    const knownActive = event.kind === "session-status" && (event.status?.type === "busy" || event.status?.type === "retry")
    if (knownActive && event.sessionID === attempt.sessionID) {
      if (attempt.foregroundResult) {
        const inspectionGeneration = attempt.generation ?? 0
        const inspection = await this.#execution.inspectTurn({
          sessionID: attempt.sessionID,
          dispatchMessageID: attempt.dispatchMessageID,
        }).catch(() => null)
        if (!this.#inspectionIsCurrent(attempt, inspectionGeneration) || inspection?.state === "idle") {
          return { managed: true, settled: false }
        }
      }
      await this.#markUncertainAttemptActive(attempt, event.status.type === "retry" ? "retrying" : "running")
      return { managed: true, settled: false }
    }
    const reconciliation = await this.#reconcileUncertainAttempt(event.sessionID, { knownStopped })
    return { managed: true, settled: reconciliation.settled }
  }

  setBeforeDelegate(callback) {
    this.#beforeDelegate = callback
  }

  async #requester(context, lineage = new Set(), restoreLocks = false) {
    const snapshot = this.#snapshot()
    const session = await this.#store.get(context.sessionID)
    const state = sessionO4E(session)
    const requester = snapshot?.agentByName?.get(context.agent)
    if (!requester) throw new Error(`未找到发起 Agent 配置: ${context.agent}`)
    if (state.kind !== "delegation-attempt"
      && (session?.parentID !== undefined || state.kind !== undefined || state.delegation !== undefined || state.task !== undefined || state.workflow !== undefined)) {
      throw new Error("Task owner Session ancestry 无法验证")
    }
    const authority = state?.kind === "delegation-attempt"
      ? await this.#readDelegationAuthority(context, 2, lineage, false, restoreLocks)
      : { depth: 0, hostParentID: session?.id, inheritedOverlays: [] }
    const currentSnapshot = authority.snapshot ?? snapshot
    const currentRequester = currentSnapshot?.agentByName?.get(context.agent)
    if (!currentRequester) throw new Error(`未找到发起 Agent 配置: ${context.agent}`)
    return { snapshot: currentSnapshot, requester: currentRequester, session: authority.session ?? session, authority }
  }

  // Resolves authority only. The host must still ask and revalidate at admission.
  // lockOwner identifies the Agent authority node, not a Command execution lock.
  async commandAuthority(context) {
    const authority = await this.#readDelegationAuthority(context, 2, new Set(), true)
    return {
      ...(authority.permission === undefined ? {} : { permission: authority.permission }),
      ...(authority.lockOwner === undefined ? {} : { lockOwner: authority.lockOwner }),
      ...(authority.parentTaskID === undefined ? {} : { parentTaskID: authority.parentTaskID }),
      ...(authority.authorizationFingerprint === undefined ? {} : { authorizationFingerprint: authority.authorizationFingerprint }),
    }
  }

  async delegationAuthority(context) {
    return this.#readDelegationAuthority(context, 2)
  }

  async restoreDelegationAuthority(context) {
    return this.#readDelegationAuthority(context, 2, new Set(), false, true)
  }

  async #readDelegationAuthority(context, metadataRetries, lineage = new Set(), requireBash = false, restoreLocks = false) {
    this.#assertActive()
    const fail = (reason) => { throw Object.assign(new Error(`${requireBash ? "Bash" : "Delegation"} authority unverifiable: ${reason}`), { code: requireBash ? "O4E_COMMAND_AUTHORITY_DENIED" : "O4E_DELEGATION_AUTHORITY_DENIED" }) }
    const text = (value) => typeof value === "string" && value.trim() !== "" && !value.includes("\0")
    const object = (value) => value && typeof value === "object" && !Array.isArray(value)
    if (!text(context?.sessionID) || !text(context?.agent)) fail("host Session/Agent identity missing")
    if (lineage.has(context.sessionID)) fail("delegation ancestry contains a cycle")
    const nextLineage = new Set([...lineage, context.sessionID])
    if (context.directory !== undefined && canonicalDirectoryKey(context.directory) !== this.#directory) fail("directory mismatch")
    const sessions = new Map()
    const read = async (id) => {
      if (!text(id)) fail("Session identity missing")
      if (sessions.has(id)) return sessions.get(id)
      const session = await this.#store.get(id)
      if (session?.id !== id || !text(session.directory) || canonicalDirectoryKey(session.directory) !== this.#directory) fail("Session missing or outside runtime directory")
      if (session.metadata?.o4e !== undefined && !object(session.metadata.o4e)) fail("invalid O4E metadata")
      if (session.permission !== undefined && (!Array.isArray(session.permission) || session.permission.some((rule) => !object(rule)
        || !text(rule.permission) || !text(rule.pattern) || !["allow", "ask", "deny"].includes(rule.action)))) fail("invalid Session permission")
      sessions.set(id, session)
      return session
    }
    const session = await read(context.sessionID)
    const state = sessionO4E(session)
    const snapshot = this.#snapshot()
    const strategies = snapshot ? normalizeNativeAgentStrategies(snapshot.nativeAgentStrategies) : undefined
    const agentName = (name) => strategies?.[name] === "managed" ? snapshot.nativeModes?.[name] ?? name : name
    const name = agentName(context.agent)
    const target = snapshot?.agentByName?.get(name)
    if (snapshot && (!Array.isArray(snapshot.agents) || !(snapshot.agentByName instanceof Map))) fail("Agent snapshot missing")
    const mcpServerNames = snapshot?.mcpServerNames ?? collectMcpServerNames(snapshot?.allAgents ?? snapshot?.agents, snapshot?.runtime?.config?.mcp)
    const root = (candidate) => {
      const metadata = sessionO4E(candidate)
      return candidate.parentID === undefined && metadata.kind === undefined && metadata.delegation === undefined
        && metadata.task === undefined && metadata.workflow === undefined
    }
    if (session.agent !== undefined && agentName(session.agent) !== name) fail("Session Agent differs from host caller")
    if (strategies?.[context.agent] === "disable") fail("native Agent disabled")
    if (root(session)) {
      this.#assertActive()
      const authority = { depth: 0, hostParentID: session.id, inheritedOverlays: [] }
      if (!snapshot || strategies?.[context.agent] === "keep") return authority
      if (!target) {
        if (strategies?.[context.agent] === "managed" || snapshot.allAgents?.some((entry) => entry.name === name)) fail("managed Agent missing from selectable snapshot")
        return authority
      }
      if (!["primary", "all"].includes(target.type)) fail("managed root must be primary or all")
      return { ...authority, permission: effectiveAgentPermission(target, { agents: snapshot.agents, mcpServerNames }) }
    }

    const delegation = state.delegation
    if (!target || state.kind !== "delegation-attempt" || state.version !== 1 || !object(delegation)
      || !Number.isSafeInteger(delegation.depth) || delegation.depth < 1 || session.agent !== name || delegation.targetAgent !== name
      || !text(delegation.sourceAgent) || !text(delegation.parentSessionID)
      || (delegation.executionSessionID !== undefined && delegation.executionSessionID !== session.id)) fail("child identity/depth/envelope mismatch")
    if (!["read", "scoped-write", "unknown-write"].includes(delegation.effect)) fail("invalid frozen effect")
    if (requireBash && delegation.effect !== "unknown-write") fail("Bash requires frozen unknown-write, not Plan/read/scoped authority")
    if (!Array.isArray(delegation.compiledPermission) || !isDeepStrictEqual(session.permission, delegation.compiledPermission)
      || !object(delegation.permissionOverlay) || !Array.isArray(delegation.writeScopes)
      || !text(delegation.dispatchMessageID) || !/^[a-f0-9]{64}$/.test(delegation.authorizationFingerprint)
      || !((delegation.requesterPermissionAction === "allow" && delegation.requesterPermissionApproved === false)
        || (delegation.requesterPermissionAction === "ask" && delegation.requesterPermissionApproved === true))) fail("frozen permission/approval missing or changed")
    if (delegation.cancellationRequestedAt !== undefined || delegation.cancellationConfirmedAt !== undefined) fail("delegation cancellation pending")
    const fingerprint = delegationAuthorizationFingerprintFromEnvelope({
      requesterAgent: delegation.sourceAgent,
      requesterPermissionPattern: delegation.requesterPermissionPattern,
      requesterPermissionAction: delegation.requesterPermissionAction,
      requesterPermissionApproved: delegation.requesterPermissionApproved,
      targetAgent: delegation.targetAgent,
      compiledPermission: delegation.compiledPermission,
      permissionOverlay: delegation.permissionOverlay,
      effect: delegation.effect,
      normalizedScopes: delegation.writeScopes,
      trace: delegation.trace,
      workflowDefinitionHash: delegation.workflowDefinitionHash,
    })
    if (fingerprint !== delegation.authorizationFingerprint) fail("frozen authorization fingerprint mismatch")
    const parent = await read(delegation.parentSessionID)
    const requester = snapshot.agentByName.get(delegation.sourceAgent)
    if (!requester || !["primary", "all", "subagent"].includes(requester.type)) fail("requester cannot delegate")
    let permissionSession = parent
    let lockOwner = delegation.scopeLockID
    let parentTaskID
    let taskLedgerSession
    if (delegation.toolName === AGENT_TASK_TOOL) {
      if ((!root(parent) && sessionO4E(parent).kind !== "delegation-attempt") || delegation.requesterPermissionPattern !== name || delegation.workflowDefinitionHash !== undefined) fail("task parent/canonical authorization mismatch")
      if (delegation.taskID !== undefined) {
        parentTaskID = delegation.taskID
        const group = sessionO4E(parent).backgroundTasks
        const ref = group?.taskRefs?.[parentTaskID]
        if (!text(parentTaskID) || group?.version !== 1 || ref?.kind !== "agent" || !text(ref.taskSessionID)
          || ref.cancellationRequestedAt !== undefined || ref.recoveryEnvelope?.version !== 1) fail("Task parent reference missing or cancelled")
        const ledger = await read(ref.taskSessionID)
        taskLedgerSession = ledger
        const task = normalizeTaskMetadata(sessionO4E(ledger).task)
        const recovery = normalizeTaskMetadata(ref.recoveryEnvelope.task)
        const frozen = ref.recoveryEnvelope.delegation
        if (task.taskID !== parentTaskID || task.taskSessionID !== ledger.id
          || task.kind !== "agent" || task.ownerSessionID !== parent.id || task.childSessionID !== session.id
          || task.agent !== name || task.requesterAgent !== requester.name || task.authorizationFingerprint !== fingerprint
          || task.requesterPermissionPattern !== delegation.requesterPermissionPattern
          || task.requesterPermissionAction !== delegation.requesterPermissionAction
          || task.requesterPermissionApproved !== delegation.requesterPermissionApproved
          || task.effect !== delegation.effect || !isDeepStrictEqual(task.writeScopes, delegation.writeScopes)
          || task.dispatchMessageID !== delegation.dispatchMessageID || !task.attemptSessionIDs.includes(session.id)
          || !["running", "waiting_tool", "waiting_permission", "waiting_question"].includes(task.status) || delegation.status !== "running"
          || task.phase === "authorization-unverifiable" || task.phase === "completion-settling"
          || task.cancellationRequestedAt !== undefined || task.endedAt !== undefined || task.requiresAllAttemptsStopped
          || recovery.cancellationRequestedAt !== undefined || recovery.phase === "authorization-unverifiable"
          || ["taskID", "taskSessionID", "kind", "ownerSessionID", "agent", "requesterAgent", "authorizationFingerprint", "effect", "writeScopes",
            "requesterPermissionPattern", "requesterPermissionAction", "requesterPermissionApproved", "sequence", "createdAt"]
            .some((key) => !isDeepStrictEqual(recovery[key], task[key]))
          || ref.sequence !== task.sequence || ref.createdAt !== task.createdAt
          || delegation.trace?.taskID !== parentTaskID || delegation.trace?.ownerSessionID !== parent.id
          || frozen?.authorizationFingerprint !== fingerprint || frozen.taskID !== parentTaskID
          || ["depth", "maxDelegationDepth", "remainingDelegationDepth", "parentSessionID", "sourceAgent", "targetAgent", "toolName", "plan", "requesterPermissionPattern", "requesterPermissionAction",
            "requesterPermissionApproved", "compiledPermission", "permissionOverlay", "effect", "writeScopes", "trace"]
            .some((key) => !isDeepStrictEqual(frozen[key], delegation[key]))) fail("Task ledger/frozen parent authority mismatch or inactive")
        // BackgroundTaskRuntime owns this canonical lock even though its envelope
        // does not store scopeLockID. Never infer it from tool arguments.
        lockOwner = `background-task:${task.taskID}`
        if (delegation.scopeLockID !== undefined && delegation.scopeLockID !== lockOwner) fail("Task scopeLockID mismatch")
      } else if (state.task !== undefined || delegation.status !== "running" || delegation.endedAt !== undefined) fail("foreground delegation inactive")
    } else fail("unsupported delegation authorization tool")
    if (agentName(parent.agent) !== requester.name || (permissionSession.agent !== undefined && agentName(permissionSession.agent) !== requester.name)) fail("parent Session Agent mismatch")
    const prepared = await this.#prepare({
      agent: name, task: delegation.task, plan: delegation.plan, trace: delegation.trace,
      permissionOverlay: delegation.permissionOverlay, writeScopes: delegation.writeScopes,
    }, { sessionID: parent.id, agent: requester.name, directory: this.#directory }, delegation.toolName, {
      permissionPattern: delegation.requesterPermissionPattern,
      permissionApproved: delegation.requesterPermissionApproved,
      workflowDefinitionHash: delegation.workflowDefinitionHash,
    }, nextLineage, restoreLocks)
    const hostParentID = delegation.toolName === AGENT_TASK_TOOL ? prepared.hostParentID : parent.id
    if (delegation.depth !== prepared.depth || session.parentID !== hostParentID) fail("child identity/depth/envelope mismatch")
    if (delegation.maxDelegationDepth !== undefined && delegation.maxDelegationDepth !== prepared.maxDelegationDepth) fail("child frozen maxDelegationDepth mismatch")
    if (delegation.remainingDelegationDepth !== undefined && delegation.remainingDelegationDepth !== prepared.remainingDelegationDepth) fail("child frozen remaining delegation depth mismatch")
    if (taskLedgerSession && taskLedgerSession.id !== session.id && taskLedgerSession.parentID !== hostParentID) fail("Task ledger host parent mismatch")
    if (prepared.status !== "selected" || prepared.authorizationFingerprint !== fingerprint || prepared.effect.kind !== delegation.effect
      || !isDeepStrictEqual(prepared.compiledPermission, delegation.compiledPermission)) fail("current Agent configuration differs from frozen authority")
    const requesterPermission = effectiveAgentPermission(prepared.requester, { agents: prepared.snapshot.agents, mcpServerNames })
    for (const candidate of new Set([parent, permissionSession])) {
      const action = evaluate(delegation.toolName, delegation.requesterPermissionPattern, permissionRules(requesterPermission), candidate.permission ?? []).action
      if (action === "deny" || (action === "ask" && !delegation.requesterPermissionApproved)) fail("parent Session permission no longer authorizes delegation")
    }
    for (const [id, ancestor] of prepared.ancestorSessions) {
      if (!sessions.has(id)) sessions.set(id, ancestor)
    }
    // Detect changes across store awaits without recovering or dispatching work.
    for (const [id, prior] of sessions) {
      const current = await this.#store.get(id)
      if (!current || ["id", "agent", "parentID", "directory", "permission"].some((key) => !isDeepStrictEqual(current[key], prior[key]))) fail("Session authority changed during validation")
      if (!isDeepStrictEqual(current.metadata, prior.metadata)) {
        // Permission events and receipts can update metadata during these reads.
        // Reread and revalidate every envelope and ledger; persistent drift fails closed.
        if (metadataRetries > 0) return this.#readDelegationAuthority(context, metadataRetries - 1, lineage, requireBash, restoreLocks)
        fail("Session authority changed during validation")
      }
    }
    this.#assertActive()
    const tracked = this.#uncertainAttempts.get(session.id)
    if (tracked && (tracked.lockID !== lockOwner || tracked.cancellationRequestedAt !== undefined)) fail("live Attempt lock/cancellation mismatch")
    if (!text(lockOwner)) fail("trusted Scope Lock missing")
    if (this.#locks.has(lockOwner) && this.#locks.parentLockID(lockOwner) !== prepared.parentLockID) fail("Scope Lock parent authority mismatch")
    if (restoreLocks) {
      this.#locks.restore(lockOwner, prepared.effect, { parentLockID: prepared.parentLockID, allowConflict: true })
    }
    if (!this.#locks.has(lockOwner)) fail("trusted Scope Lock missing")
    if (this.#locks.parentLockID(lockOwner) !== prepared.parentLockID) fail("Scope Lock parent authority mismatch")
    if (requireBash && !this.#locks.isUnknownWrite(lockOwner)) fail("Scope Lock is not unknown-write; refusing upgrade")
    return {
      permission: prepared.effect.permission, lockOwner, ...(parentTaskID ? { parentTaskID } : {}), authorizationFingerprint: fingerprint,
      depth: delegation.depth, hostParentID: delegation.toolName === AGENT_TASK_TOOL ? prepared.hostParentID : permissionSession.id,
      effect: prepared.effect, writeScopes: prepared.normalizedScopes, plan: Boolean(prepared.target.planProfile),
      inheritedOverlays: [...prepared.inheritedOverlays, prepared.overlay],
      session, snapshot: prepared.snapshot, validatedSessions: [...sessions],
    }
  }

  async delegate(args, context, { toolName = AGENT_TASK_TOOL, permissionPattern, onSession, permissionApproved = false, beforeCreateAttempt, afterCreateAttempt } = {}) {
    if (this.#quiescing || this.#disposed) throw new Error("委派 Runtime 正在释放")
    const operation = this.#delegate(args, context, { toolName, permissionPattern, onSession, permissionApproved, beforeCreateAttempt, afterCreateAttempt })
    this.#inflight.add(operation)
    try {
      return await operation
    } finally {
      this.#inflight.delete(operation)
    }
  }

  async #delegate(args, context, { toolName, permissionPattern, onSession, permissionApproved, beforeCreateAttempt, afterCreateAttempt }) {
    await this.#beforeDelegate?.(context)
    this.#assertActive()
    let prepared = await this.prepare(args, context, toolName, { permissionApproved, permissionPattern })
    this.#assertActive()
    if (prepared.status !== "selected") return JSON.stringify(prepared.response, null, 2)
    const { target, overlay, effect, normalizedScopes } = prepared
    const lockID = `delegation:${randomUUID()}`
    const admissionSignal = context.abort
      ? AbortSignal.any([context.abort, this.#quiesceAbort.signal])
      : this.#quiesceAbort.signal
    let lockAcquired = false
    let child
    let cancellation
    let cancellationRequestedAt
    let abortRequested = context.abort?.aborted === true
    let cancellationOpen = true
    let cancellationError
    let rejectAborted
    let retainLock = false
    let foregroundAttempt
    const abortError = () => context.abort?.reason instanceof Error ? context.abort.reason : new Error("前台委派已取消")
    const uncertainFailure = (message, retain = true) => uncertainDelegationError(message, {
      sessionID: child.id,
      effect: effect.kind,
      writeScopes: normalizedScopes,
      retainLock: retain,
    })
    const markCancellation = () => {
      cancellationRequestedAt ??= Date.now()
      if (!foregroundAttempt) return
      foregroundAttempt.cancellationRequestedAt = cancellationRequestedAt
      foregroundAttempt.delegation = {
        ...foregroundAttempt.delegation,
        cancellationRequestedAt,
      }
      foregroundAttempt.fencePersisted = false
    }
    const cancelChild = () => {
      if (!child?.id) return cancellation
      cancellation ??= (async () => {
        if (foregroundAttempt) await this.#persistCancellationFence(foregroundAttempt)
        return this.#execution.cancelTurn({ sessionID: child.id })
      })()
      void cancellation.catch(() => undefined)
      return cancellation
    }
    const requestCancellation = (error) => {
      if (!cancellationOpen) return
      abortRequested = true
      cancellationError ??= error
      markCancellation()
      void cancelChild()?.catch(() => undefined)
      rejectAborted?.(error)
    }
    const onAbort = () => requestCancellation(abortError())
    const onQuiesce = () => requestCancellation(runtimeDisposingError())
    context.abort?.addEventListener("abort", onAbort, { once: true })
    this.#quiesceAbort.signal.addEventListener("abort", onQuiesce, { once: true })
    const dispatchMessageID = createDispatchMessageID()
    let startedAt
    let turnResult
    let turnStarted = false
    let afterCreateAttemptFailed = false
    const response = (result, endedAt) => {
      const refs = messageReferences(result)
      return JSON.stringify({
        status: "reported-completed",
        sourceAgent: target.name,
        sessionID: child.id,
        effect: effect.kind,
        writeScopes: normalizedScopes,
        model: prepared.modelCandidates?.[0],
        output: taskText(result),
        dispatchMessageID,
        ...refs,
        startedAt,
        endedAt,
      }, null, 2)
    }
    try {
      await this.#locks.acquire(lockID, effect, { signal: admissionSignal, parentLockID: prepared.parentLockID })
      lockAcquired = true
      if (toolName === AGENT_TASK_TOOL) {
        prepared = await this.revalidateAttempt(prepared, context.sessionID)
        if (this.#locks.parentLockID(lockID) !== prepared.parentLockID) throw new Error("委派父锁授权已变化")
      }
      this.#assertActive()
      if (abortRequested) throw abortError()
      await beforeCreateAttempt?.(prepared)
      this.#assertActive()
      if (abortRequested) throw abortError()
      const attempt = await this.createAttempt(prepared, context, {
        dispatchMessageID,
        status: "running",
        scopeLockID: lockID,
      })
      child = attempt.child
      this.#managedAttemptSessions.add(child.id)
      startedAt = attempt.createdAt
      foregroundAttempt = this.#uncertainAttempt(child.id, {
        ...sessionO4E(child).delegation,
        effect: effect.kind,
        writeScopes: normalizedScopes,
        dispatchMessageID,
        scopeLockID: lockID,
      }, child.parentID)
      foregroundAttempt.foregroundTurnID = dispatchMessageID
      foregroundAttempt.foregroundTurnPending = true
      this.#rememberUncertainAttempt(foregroundAttempt)
      try {
        await afterCreateAttempt?.({ child, prepared, dispatchMessageID, createdAt: attempt.createdAt })
      } catch (error) {
        afterCreateAttemptFailed = true
        throw error
      }
      if (abortRequested) markCancellation()
      if (this.#quiescing || this.#disposed) {
        throw runtimeDisposingError()
      }
      await Promise.resolve(onSession?.({ child, prepared, background: false })).catch(() => undefined)
      this.#assertActive()
      if (abortRequested) {
        await cancelChild()
        throw abortError()
      }
      if (toolName === AGENT_TASK_TOOL) prepared = await this.revalidateAttempt(prepared, context.sessionID)
      if (abortRequested) throw cancellationError ?? abortError()
      const prompt = {
        messageID: dispatchMessageID,
        agent: target.name,
        model: prepared.modelCandidates?.[0],
        parts: [{ type: "text", text: buildDelegationPrompt({
          task: args.task,
          recoveryContext: args.recoveryContext,
          outputContract: args.outputContract,
          delegationContext: delegationPromptContext(prepared),
        }) }],
      }
      this.#assertActive()
      const aborted = new Promise((_, rejectPromise) => { rejectAborted = rejectPromise })
      turnStarted = true
      const turn = this.#execution.runTurn({ sessionID: child.id, ...prompt })
      turnResult = await Promise.race([turn, aborted])
      foregroundAttempt.foregroundResult = turnResult
      foregroundAttempt.foregroundTurnPending = false
      if (abortRequested) {
        const cancelled = await cancelChild()
        if (cancelled?.acknowledged === false) throw new Error("宿主未确认取消请求")
        throw cancellationError ?? abortError()
      }
      cancellationOpen = false
      context.abort?.removeEventListener("abort", onAbort)
      this.#quiesceAbort.signal.removeEventListener("abort", onQuiesce)
      if (turnResult?.info?.error) {
        const turnError = Object.assign(new Error("子 Session 返回错误结果"), {
          cause: turnResult.info.error,
          code: "O4E_DELEGATION_FAILED",
        })
        const settled = await this.#settleUncertainAttempt(foregroundAttempt, { state: "idle", error: turnResult.info.error })
        if (!settled) {
          retainLock = true
          throw uncertainFailure("result-settlement-invalidated-by-active-evidence")
        }
        throw turnError
      }
      if (!completedTurnResult(turnResult, dispatchMessageID)) {
        retainLock = true
        throw uncertainFailure("dispatch-result-incomplete")
      }
      const endedAt = Date.now()
      const settled = await this.#settleUncertainAttempt(foregroundAttempt, { state: "idle", result: turnResult })
      if (!settled) {
        retainLock = true
        throw uncertainFailure("result-settlement-invalidated-by-active-evidence")
      }
      return response(turnResult, endedAt)
    } catch (error) {
      if (foregroundAttempt) {
        foregroundAttempt.foregroundTurnPending = false
        foregroundAttempt.foregroundReconciliationPending = true
      }
      if (child?.id) {
        if (afterCreateAttemptFailed && !turnStarted) {
          try {
            if (foregroundAttempt) {
              foregroundAttempt.cancellationRequestedAt ??= cancellationRequestedAt ?? Date.now()
              foregroundAttempt.delegation = {
                ...foregroundAttempt.delegation,
                cancellationRequestedAt: foregroundAttempt.cancellationRequestedAt,
              }
              foregroundAttempt.fencePersisted = false
              await this.#persistCancellationFence(foregroundAttempt, "after-create-attempt-failed")
            }
            const cancelled = await this.#execution.cancelTurn({ sessionID: child.id })
            if (cancelled?.acknowledged !== true) throw new Error("宿主未确认取消未派发 Attempt")
            const settled = foregroundAttempt
              ? await this.#settleUncertainAttempt(foregroundAttempt, { state: "idle", status: "cancelled", diagnostics: "after-create-attempt-failed" })
              : true
            if (!settled) throw new Error(`未派发 Attempt 取消结算被 active 证据失效: ${child.id}`)
            lockAcquired = false
          } catch (cancelError) {
            retainLock = true
            throw uncertainFailure(`after-create-attempt-cancel-unconfirmed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`)
          }
          throw error
        }
        if (error?.code === "O4E_RUNTIME_DISPOSING" && !turnStarted) {
          if (foregroundAttempt && this.#uncertainAttempts.get(child.id) === foregroundAttempt) {
            retainLock = true
            foregroundAttempt.cancellationRequestedAt ??= cancellationRequestedAt ?? Date.now()
            foregroundAttempt.delegation = {
              ...foregroundAttempt.delegation,
              cancellationRequestedAt: foregroundAttempt.cancellationRequestedAt,
            }
            foregroundAttempt.fencePersisted = false
            await this.#persistCancellationFence(foregroundAttempt, "runtime-disposed-before-dispatch")
            const settled = await this.#settleUncertainAttempt(foregroundAttempt, { state: "idle", diagnostics: "runtime-disposed-before-dispatch" })
            if (!settled) throw uncertainFailure("dispose-settlement-invalidated-by-active-evidence")
            lockAcquired = false
          }
          throw error
        }
        if (error?.code === "O4E_DELEGATION_UNCERTAIN") {
          retainLock = error.retainLock !== false
          throw error
        }
        const trackedAttempt = this.#uncertainAttempts.get(child.id)
        if (trackedAttempt?.pendingInspection) {
          retainLock = true
          throw uncertainFailure(`result-persist-unconfirmed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (error?.code === "O4E_DELEGATION_FAILED") throw error
        let status = "failed"
        let diagnostics = error instanceof Error ? error.message : String(error)
        let recoveredResult = turnResult?.info?.error ? undefined : turnResult
        let recoveredError
        let uncertain = false
        let missingCancellationRequestedAt
        let missingInspection = false
        let inspectionInvalidated = false
        if (abortRequested) {
          try {
            const cancelled = await cancelChild()
            if (cancelled?.acknowledged === false) throw new Error("宿主未确认取消请求")
            status = "cancelled"
          } catch (cancelError) {
            status = "unknown"
            diagnostics = `cancel-unconfirmed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
            retainLock = true
            uncertain = true
          }
        } else if (!recoveredResult) {
          const inspectionGeneration = foregroundAttempt?.generation ?? 0
          const inspection = await this.#execution.inspectTurn({
            sessionID: child.id,
            dispatchMessageID,
          }).catch(() => null)
          inspectionInvalidated = Boolean(foregroundAttempt && !this.#inspectionIsCurrent(foregroundAttempt, inspectionGeneration))
          if (!inspectionInvalidated) recoveredError = inspection?.error
          if (!inspectionInvalidated && !recoveredError && completedTurnResult(inspection?.result, dispatchMessageID)) {
            recoveredResult = inspection.result
          }
          if (recoveredError) {
            status = "failed"
            diagnostics = `reconciled-error: ${errorText(recoveredError)}`
          } else if (recoveredResult) {
            status = "reported-completed"
          } else if (inspection?.result) {
            status = "unknown"
            diagnostics = "dispatch-result-incomplete"
            retainLock = true
            uncertain = true
          } else if (inspectionInvalidated || !inspection || inspection.state === "unknown" || inspection.state === "running" || inspection.state === "retrying") {
            status = "unknown"
            diagnostics = `dispatch-unconfirmed: ${diagnostics}`
            retainLock = true
            uncertain = true
          } else if (effect.kind !== "read") {
            status = "unknown"
            diagnostics = `dispatch-result-unavailable: ${diagnostics}`
            uncertain = true
            if (inspection?.state === "missing") {
              missingInspection = true
              retainLock = true
              missingCancellationRequestedAt = Date.now()
              diagnostics = `dispatch-missing: ${diagnostics}`
            }
          }
        } else {
          status = "reported-completed"
        }
        const endedAt = Date.now()
        const tracked = this.#uncertainAttempts.get(child.id)
        if (inspectionInvalidated && tracked !== foregroundAttempt) throw error
        const attempt = tracked ?? this.#uncertainAttempt(child.id, sessionO4E(child).delegation, child.parentID)
        attempt.effect = { kind: effect.kind, writeScopes: normalizedScopes }
        attempt.dispatchMessageID = dispatchMessageID
        attempt.lockID = lockID
        attempt.cancellationRequestedAt = abortRequested || missingCancellationRequestedAt
          ? cancellationRequestedAt ?? missingCancellationRequestedAt ?? endedAt
          : attempt.cancellationRequestedAt
        attempt.delegation = {
          ...attempt.delegation,
          effect: effect.kind,
          writeScopes: normalizedScopes,
          dispatchMessageID,
          scopeLockID: lockID,
          ...(attempt.cancellationRequestedAt ? { cancellationRequestedAt: attempt.cancellationRequestedAt } : {}),
        }
        if (missingInspection) {
          attempt.executionMissing = true
          attempt.recordSessionIDs.delete(child.id)
          attempt.recordSessionID = undefined
          attempt.recordMissing = true
        }
        if (retainLock) {
          await this.#store.updateO4E(child.id, (state) => ({
            ...state,
            delegation: {
              ...state.delegation,
              status,
              diagnostics,
              ...(attempt.cancellationRequestedAt ? { cancellationRequestedAt: state.delegation?.cancellationRequestedAt ?? attempt.cancellationRequestedAt } : {}),
            },
          })).catch(() => undefined)
          this.#rememberUncertainAttempt(attempt)
          if (abortRequested && !missingInspection) this.#scheduleCancellationRetry(attempt)
          const reconciliation = inspectionInvalidated
            ? { settled: false }
            : missingInspection
              ? { settled: await this.#handleMissingUncertainAttempt(attempt), inspection: { state: "missing" } }
              : await this.#reconcileUncertainAttempt(child.id)
          if (reconciliation.settled) {
            retainLock = false
            if (reconciliation.inspection?.error) {
              recoveredError = reconciliation.inspection.error
              diagnostics = `reconciled-error: ${errorText(recoveredError)}`
              uncertain = false
            } else if (reconciliation.inspection?.result) {
              recoveredResult = reconciliation.inspection.result
              uncertain = false
            }
          }
        } else {
          const inspection = !abortRequested && recoveredResult
            ? { state: "idle", result: recoveredResult }
            : { state: "idle", status, diagnostics, ...(status === "failed" ? { error: recoveredError ?? error } : {}) }
          try {
            const settled = await this.#settleUncertainAttempt(attempt, inspection)
            if (!settled) {
              retainLock = true
              throw uncertainFailure("result-settlement-invalidated-by-active-evidence")
            }
          } catch (persistError) {
            retainLock = true
            throw uncertainFailure(`result-persist-unconfirmed: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
          }
        }
        if (!abortRequested && recoveredResult && completedTurnResult(recoveredResult, dispatchMessageID)) return response(recoveredResult, endedAt)
        if (!abortRequested && recoveredResult) {
          retainLock = true
          throw uncertainFailure("dispatch-result-incomplete")
        }
        if (uncertain) {
          throw uncertainFailure(diagnostics, retainLock)
        }
      }
      throw error
    } finally {
      if (foregroundAttempt) foregroundAttempt.foregroundReconciliationPending = false
      cancellationOpen = false
      context.abort?.removeEventListener("abort", onAbort)
      this.#quiesceAbort.signal.removeEventListener("abort", onQuiesce)
      if (lockAcquired && !retainLock) this.#locks.release(lockID)
    }
  }

  async prepare(args, context, toolName = AGENT_TASK_TOOL, { permissionApproved = false, permissionPattern, workflowDefinitionHash } = {}) {
    return this.#prepare(args, context, toolName, { permissionApproved, permissionPattern, workflowDefinitionHash })
  }

  async #prepare(args, context, toolName = AGENT_TASK_TOOL, { permissionApproved = false, permissionPattern, workflowDefinitionHash } = {}, lineage = new Set(), restoreLocks = false) {
    if (toolName !== AGENT_TASK_TOOL || workflowDefinitionHash !== undefined || args?.trace?.runSessionID !== undefined) throw new Error("O4E_WORKFLOW_DELEGATION_UNSUPPORTED")
    const { snapshot, requester, session, authority } = await this.#requester(context, lineage, restoreLocks)
    const depth = authority.depth + 1
    const maxDelegationDepth = assertDelegationDepth(depth, snapshot)
    if (toolName === AGENT_TASK_TOOL && sessionO4E(session).kind === "workflow-run") throw new Error("task 不能直接从 Workflow Run 发起")
    const mcpServerNames = snapshot.mcpServerNames ?? collectMcpServerNames(snapshot.allAgents ?? snapshot.agents, snapshot.runtime?.config?.mcp)
    // Validate the transport shape before candidate filtering so malformed
    // overlays are reported as argument errors instead of agent-not-found.
    const permissionOverlay = normalizeDelegationOverlay(args.permissionOverlay, "allow")
    const normalizedScopes = normalizeWriteScopes(args.writeScopes ?? (authority.effect?.kind === "scoped-write" ? authority.writeScopes : undefined), context.directory || this.#directory)
    if (args.agent) {
      const requested = legalAgentCandidates({ requester, agents: snapshot.agents, mcpServerNames })
        .find((candidate) => candidate.id === args.agent)
      if (requested) {
        const target = snapshot.agentByName.get(requested.id)
        if (toolName !== AGENT_TASK_TOOL) {
          normalizeDelegationOverlay(permissionOverlay, effectiveAgentPermission(target, {
            agents: snapshot.agents,
            mcpServerNames,
          }))
        }
        if (typeof args.plan === "boolean" && requested.plan !== args.plan) {
          const response = {
            status: "agent-incompatible",
            task: args.task,
            agent: args.agent,
            reason: "plan-profile-mismatch",
            requiredPlan: args.plan,
            actualPlan: requested.plan,
            next: `The plan field filters Agent profiles; it does not describe task intent. Omit plan or set plan=${requested.plan}.`,
          }
          if (toolName === AGENT_TASK_TOOL) throw taskSelectionError(response)
          return { status: response.status, response }
        }
      }
    }
    const candidates = legalAgentCandidates({
      requester,
      agents: snapshot.agents,
      mcpServerNames,
      required: {
        plan: typeof args.plan === "boolean" ? args.plan : undefined,
        permissionOverlay,
        writeScopes: normalizedScopes,
      },
    })
    const selection = selectPreferredAgent({ preferred: args.agent, fallback: args.agent ? "none" : "discover", candidates })
    if (selection.status !== "selected") {
      const diagnostics = []
      if (args.agent) {
        const requestedTarget = snapshot.agentByName.get(args.agent)
        if (!requestedTarget) {
          diagnostics.push(`未找到目标 Agent 配置: ${args.agent}`)
        } else {
          if (requestedTarget.type !== "all" && requestedTarget.type !== "subagent") diagnostics.push(`目标 Agent 类型不可委派: ${requestedTarget.type}`)
          if (!Array.isArray(requester.loadAgents) || (!requester.loadAgents.includes("*") && !requester.loadAgents.includes(requestedTarget.name))) {
            diagnostics.push(`发起 Agent 未通过 loadAgents 加载目标: ${requester.name} -> ${requestedTarget.name}`)
          }
          if (args.plan === true && !requestedTarget.planProfile) diagnostics.push(`目标 Agent 不是 Plan Profile: ${requestedTarget.name}`)
          if (args.plan === false && requestedTarget.planProfile) diagnostics.push(`目标 Agent 是 Plan Profile，但本次要求 plan:false: ${requestedTarget.name}`)
          try {
            const requestedPermission = effectiveAgentPermission(requestedTarget, { agents: snapshot.agents, mcpServerNames })
            normalizeDelegationOverlay(permissionOverlay, requestedPermission)
          } catch (error) {
            diagnostics.push(errorText(error))
          }
        }
      }
      const response = {
        status: selection.status,
        task: args.task,
        agent: args.agent,
        candidates,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        next: selection.status === "selection-required" ? `Choose one candidate and call ${toolName} again with ${toolName === AGENT_TASK_TOOL ? "subagent_type" : "agent"}.` : undefined,
      }
      if (toolName === AGENT_TASK_TOOL) throw taskSelectionError(response)
      return {
        status: selection.status,
        response,
      }
    }

    const target = snapshot.agentByName.get(selection.agent.id)
    const requesterPermission = effectiveAgentPermission(requester, { agents: snapshot.agents, mcpServerNames })
    let requesterPermissionPattern
    if (toolName === AGENT_TASK_TOOL) {
      if (session?.id !== context.sessionID) throw new Error("Task owner Session 无法验证")
      if (permissionPattern !== undefined && permissionPattern !== target.name) {
        throw new Error(`task permission pattern 必须等于目标 Agent: ${target.name}`)
      }
      requesterPermissionPattern = target.name
    } else {
      throw new Error(`不支持的 Agent 委派授权工具: ${String(toolName)}`)
    }
    const requesterPermissionAction = toolName === AGENT_TASK_TOOL
      ? taskRequesterPermissionAction(requesterPermission, requesterPermissionPattern, session)
      : permissionAction(requesterPermission, toolName, requesterPermissionPattern)
    if (requesterPermissionAction === "deny") {
      throw new Error(`发起 Agent 当前拒绝 ${toolName} 目标: ${requester.name} -> ${requesterPermissionPattern}`)
    }
    if (requesterPermissionAction === "ask" && !permissionApproved) {
      throw new Error(`发起 Agent 的 ${toolName} 目标尚未获得本次授权: ${requester.name} -> ${requesterPermissionPattern}`)
    }
    const permission = inheritedPermission(effectiveAgentPermission(target, { agents: snapshot.agents, mcpServerNames }), authority)
    const derivedEffect = deriveSelfEffects(target, { permission, permissionOverlay, writeScopes: normalizedScopes })
    assertNestedEffect(derivedEffect, normalizedScopes, authority, this.#directory)
    const depthPermission = applyDelegationDepthPermission(derivedEffect, depth, maxDelegationDepth)
    const effect = depthPermission.effect
    const inheritedModel = sessionModel(session)
    const configuredModels = normalizeModelRefs(target.models ?? [])
    const modelCandidates = normalizeModelRefs(target.resolvedModels ?? configuredModels)
    if (configuredModels.length > 0 && modelCandidates.length === 0) {
      throw new Error(`目标 Agent 在当前 provider 配置中没有可用模型候选: ${target.name}`)
    }
    if (!configuredModels.length && !modelCandidates.length && inheritedModel) modelCandidates.push(inheritedModel)
    return {
      status: "selected",
      toolName,
      plan: typeof args.plan === "boolean" ? args.plan : undefined,
      args,
      context,
      snapshot,
      requester,
      depth,
      maxDelegationDepth,
      remainingDelegationDepth: depthPermission.remainingDelegationDepth,
      delegationAllowed: depthPermission.delegationAllowed,
      parentLockID: authority.lockOwner,
      hostParentID: toolName === AGENT_TASK_TOOL ? authority.hostParentID : context.sessionID,
      inheritedOverlays: authority.inheritedOverlays,
      ancestorSessions: authority.validatedSessions ?? [],
      requesterPermissionPattern,
      requesterPermissionAction,
      requesterPermissionApproved: requesterPermissionAction === "ask" && permissionApproved,
      target,
      permission,
      overlay: permissionOverlay,
      effect,
      compiledPermission: permissionRules(effect.permission),
      normalizedScopes,
      modelCandidates,
      authorizationFingerprint: delegationAuthorizationFingerprint({
        requester,
        requesterPermissionPattern,
        requesterPermissionAction,
        requesterPermissionApproved: requesterPermissionAction === "ask" && permissionApproved,
        target,
        overlay: permissionOverlay,
        effect,
        normalizedScopes,
        trace: args.trace,
        workflowDefinitionHash,
      }),
      workflowDefinitionHash,
    }
  }

  async revalidateAttempt(prepared, ownerSessionID) {
    if (!prepared?.target?.name || !prepared.authorizationFingerprint) throw new Error("Task 缺少可验证的冻结授权上下文")
    assertDelegationDepth(prepared.depth, this.#snapshot())
    if (prepared.toolName !== AGENT_TASK_TOOL || prepared.requesterPermissionPattern !== prepared.target.name) {
      throw new Error("Task 缺少 canonical task 授权上下文")
    }
    if (!(
      (prepared.requesterPermissionAction === "allow" && prepared.requesterPermissionApproved === false)
      || (prepared.requesterPermissionAction === "ask" && prepared.requesterPermissionApproved === true)
    )) {
      throw new Error(`${prepared.toolName ?? AGENT_TASK_TOOL} 缺少可验证的冻结授权确认上下文`)
    }
    if (typeof ownerSessionID !== "string" || !ownerSessionID) throw new Error("Task owner Session 缺失")
    const persistedRequesterName = prepared.requester?.name
    if (!persistedRequesterName) throw new Error("Task 缺少可验证的发起 Agent")
    const { snapshot, requester, session, authority } = await this.#requester({ sessionID: ownerSessionID, agent: persistedRequesterName, directory: this.#directory })
    if (session?.id !== ownerSessionID) throw new Error("Task owner Session 无法验证")
    if (prepared.depth !== authority.depth + 1) throw new Error("Task 冻结委派深度与当前父链不一致")
    const maxDelegationDepth = assertDelegationDepth(prepared.depth, snapshot)
    if (prepared.maxDelegationDepth !== undefined && prepared.maxDelegationDepth !== maxDelegationDepth) {
      throw new Error(`Task 冻结委派上限与当前配置不一致: frozen=${prepared.maxDelegationDepth} current=${maxDelegationDepth}`)
    }
    const persistedTargetName = prepared.target.name
    const target = snapshot?.agentByName?.get(persistedTargetName)
    if (!target) throw new Error(`重试目标 Agent 已不存在: ${persistedTargetName}`)
    const mcpServerNames = snapshot.mcpServerNames ?? collectMcpServerNames(snapshot.allAgents ?? snapshot.agents, snapshot.runtime?.config?.mcp)
    const toolName = prepared.toolName
    const requesterPermission = effectiveAgentPermission(requester, { agents: snapshot.agents, mcpServerNames })
    const currentAction = taskRequesterPermissionAction(requesterPermission, prepared.requesterPermissionPattern, session)
    const allowed = currentAction === prepared.requesterPermissionAction && (
      (currentAction === "allow" && prepared.requesterPermissionApproved === false)
      || (currentAction === "ask" && prepared.requesterPermissionApproved === true)
    )
    if (!allowed) {
      throw new Error(`发起 Agent 当前未明确允许 ${toolName}: ${requester.name}`)
    }
    const candidates = legalAgentCandidates({
      requester,
      agents: snapshot.agents,
      mcpServerNames,
      required: {
        plan: prepared.plan ?? (typeof prepared.args?.plan === "boolean" ? prepared.args.plan : undefined),
        permissionOverlay: prepared.overlay,
        writeScopes: prepared.normalizedScopes,
      },
    })
    if (!candidates.some((candidate) => candidate.id === target.name)) {
      throw new Error(`发起 Agent 不再允许委派目标 Agent: ${requester.name} -> ${target.name}`)
    }
    const permission = inheritedPermission(effectiveAgentPermission(target, { agents: snapshot.agents, mcpServerNames }), authority)
    const overlay = normalizeDelegationOverlay(prepared.overlay, permission)
    const derivedEffect = deriveSelfEffects(target, { permission, permissionOverlay: overlay, writeScopes: prepared.normalizedScopes })
    assertNestedEffect(derivedEffect, prepared.normalizedScopes, authority, this.#directory)
    const depthPermission = applyDelegationDepthPermission(derivedEffect, prepared.depth, maxDelegationDepth)
    const effect = depthPermission.effect
    const fingerprint = delegationAuthorizationFingerprint({
      requester,
      requesterPermissionPattern: prepared.requesterPermissionPattern,
      requesterPermissionAction: prepared.requesterPermissionAction,
      requesterPermissionApproved: prepared.requesterPermissionApproved,
      target,
      overlay,
      effect,
      normalizedScopes: prepared.normalizedScopes,
      trace: prepared.args?.trace,
      workflowDefinitionHash: prepared.workflowDefinitionHash,
    })
    if (fingerprint !== prepared.authorizationFingerprint) {
      throw new Error(`Task 冻结授权与当前 Agent 配置不一致: ${target.name}`)
    }
    return {
      ...prepared,
      toolName,
      snapshot,
      requester,
      depth: authority.depth + 1,
      maxDelegationDepth,
      remainingDelegationDepth: depthPermission.remainingDelegationDepth,
      delegationAllowed: depthPermission.delegationAllowed,
      parentLockID: authority.lockOwner,
      hostParentID: authority.hostParentID,
      inheritedOverlays: authority.inheritedOverlays,
      ancestorSessions: authority.validatedSessions ?? [],
      target,
      permission,
      overlay,
      effect,
      compiledPermission: permissionRules(effect.permission),
      authorizationFingerprint: fingerprint,
    }
  }

  async createAttempt(prepared, context, { taskID, dispatchMessageID, status = "running", scopeLockID } = {}) {
    const maxDelegationDepth = assertDelegationDepth(prepared.depth, this.#snapshot())
    if (prepared.maxDelegationDepth !== undefined && prepared.maxDelegationDepth !== maxDelegationDepth) {
      throw new Error(`Task 冻结委派上限与当前配置不一致: frozen=${prepared.maxDelegationDepth} current=${maxDelegationDepth}`)
    }
    const createdAt = Date.now()
    const child = await this.#store.create({
      parentID: prepared.toolName === AGENT_TASK_TOOL ? prepared.hostParentID : context.sessionID,
      title: `[o4e] ${prepared.target.name}: ${(prepared.args.description ?? prepared.args.task).slice(0, 80)}`,
      agent: prepared.target.name,
      model: prepared.modelCandidates?.[0],
      metadata: {
        o4e: {
          kind: "delegation-attempt",
          version: 1,
          delegation: {
            depth: prepared.depth,
            maxDelegationDepth,
            remainingDelegationDepth: maxDelegationDepth - prepared.depth,
            status: status === "queued" ? "queued" : "running",
            parentSessionID: context.sessionID,
            sourceAgent: prepared.requester.name,
            requesterPermissionPattern: prepared.requesterPermissionPattern,
            requesterPermissionAction: prepared.requesterPermissionAction,
            requesterPermissionApproved: prepared.requesterPermissionApproved,
            targetAgent: prepared.target.name,
            modelCandidates: prepared.modelCandidates,
            toolName: prepared.toolName,
            plan: prepared.plan,
            task: prepared.args.task,
            outputContract: prepared.args.outputContract,
            effect: prepared.effect.kind,
            writeScopes: prepared.normalizedScopes,
            compiledPermission: prepared.compiledPermission,
            permissionOverlay: prepared.overlay,
            trace: prepared.args.trace,
            recoveryContext: prepared.args.recoveryContext,
            authorizationFingerprint: prepared.authorizationFingerprint,
            workflowDefinitionHash: prepared.workflowDefinitionHash,
            createdAt,
            queuedAt: status === "queued" ? createdAt : undefined,
            startedAt: status === "queued" ? undefined : createdAt,
            taskID,
            dispatchMessageID,
            scopeLockID,
          },
        },
      },
      permission: prepared.compiledPermission,
    })
    return { child, createdAt }
  }

  #uncertainAttempt(sessionID, delegation, hostParentID) {
    return {
      sessionID: delegation.executionSessionID ?? sessionID,
      hostParentID,
      recordSessionID: sessionID,
      recordSessionIDs: new Set([sessionID]),
      lockID: delegation.scopeLockID ?? `delegation-uncertain:${sessionID}`,
      effect: {
        kind: delegation.effect === "read" || delegation.effect === "scoped-write" || delegation.effect === "unknown-write"
          ? delegation.effect
          : "unknown-write",
        writeScopes: Array.isArray(delegation.writeScopes) ? delegation.writeScopes : [],
      },
      dispatchMessageID: delegation.dispatchMessageID,
      cancellationRequestedAt: delegation.cancellationRequestedAt,
      cancellationConfirmedAt: delegation.cancellationConfirmedAt,
      cancellationConfirmed: Number.isFinite(delegation.cancellationConfirmedAt),
      executionMissing: Number.isFinite(delegation.cancellationConfirmedAt),
      delegation: structuredClone(delegation),
      recordMissing: false,
      fencePersisted: delegation.cancellationRequestedAt !== undefined,
      generation: 0,
      activeEvidencePending: false,
      tombstoneRetryDelay: TOMBSTONE_RETRY_INITIAL_MS,
      settlementRetryDelay: TOMBSTONE_RETRY_INITIAL_MS,
      cancellationRetryDelay: TOMBSTONE_RETRY_INITIAL_MS,
    }
  }


  #rememberUncertainAttempt(attempt) {
    if (!attempt) return
    const current = this.#uncertainAttempts.get(attempt.sessionID)
    if (current && current !== attempt) {
      current.generation = (current.generation ?? 0) + 1
      this.#clearAttemptRetryTimers(current)
      this.#forgetUncertainAttempt(current)
    }
    this.#uncertainAttempts.set(attempt.sessionID, attempt)
    for (const recordSessionID of attempt.recordSessionIDs) {
      if (recordSessionID !== attempt.sessionID) this.#uncertainAttempts.set(recordSessionID, attempt)
    }
  }

  #forgetUncertainAttempt(attempt) {
    if (!attempt) return
    if (this.#uncertainAttempts.get(attempt.sessionID) === attempt) this.#uncertainAttempts.delete(attempt.sessionID)
    for (const recordSessionID of attempt.recordSessionIDs) {
      if (this.#uncertainAttempts.get(recordSessionID) === attempt) this.#uncertainAttempts.delete(recordSessionID)
    }
  }

  #inspectionIsCurrent(attempt, generation) {
    return this.#uncertainAttempts.get(attempt.sessionID) === attempt
      && generation === (attempt.generation ?? 0)
  }

  #clearAttemptRetryTimers(attempt) {
    const tombstoneTimer = this.#tombstoneRetryTimers.get(attempt.sessionID)
    if (tombstoneTimer) clearTimeout(tombstoneTimer)
    this.#tombstoneRetryTimers.delete(attempt.sessionID)
    const settlementTimer = this.#settlementRetryTimers.get(attempt.sessionID)
    if (settlementTimer) clearTimeout(settlementTimer)
    this.#settlementRetryTimers.delete(attempt.sessionID)
    const cancellationTimer = this.#cancellationRetryTimers.get(attempt.sessionID)
    if (cancellationTimer) clearTimeout(cancellationTimer)
    this.#cancellationRetryTimers.delete(attempt.sessionID)
  }

  #scheduleTombstoneRetry(attempt) {
    if (this.#disposed
      || this.#uncertainAttempts.get(attempt.sessionID) !== attempt
      || (attempt.recordSessionIDs.size > 0 && !attempt.recordMissing)
      || this.#tombstoneRetryTimers.has(attempt.sessionID)) return
    const delay = attempt.tombstoneRetryDelay ?? TOMBSTONE_RETRY_INITIAL_MS
    const timer = setTimeout(async () => {
      if (this.#tombstoneRetryTimers.get(attempt.sessionID) !== timer
        || this.#disposed
        || this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
      this.#tombstoneRetryTimers.delete(attempt.sessionID)
      if (attempt.recordSessionIDs.size > 0 && !attempt.recordMissing) return
      try {
        await this.#persistDeletedAttemptTombstone(attempt, attempt.cancellationRequestedAt ?? Date.now())
      } catch (error) {
        if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
        attempt.tombstoneError = error
        attempt.tombstoneRetryDelay = Math.min(delay * 2, TOMBSTONE_RETRY_MAX_MS)
        this.#scheduleTombstoneRetry(attempt)
      }
    }, delay)
    timer.unref?.()
    this.#tombstoneRetryTimers.set(attempt.sessionID, timer)
  }

  #scheduleSettlementRetry(attempt) {
    if (this.#disposed
      || this.#uncertainAttempts.get(attempt.sessionID) !== attempt
      || !attempt.pendingInspection
      || this.#settlementRetryTimers.has(attempt.sessionID)) return
    const delay = attempt.settlementRetryDelay ?? TOMBSTONE_RETRY_INITIAL_MS
    const timer = setTimeout(async () => {
      if (this.#settlementRetryTimers.get(attempt.sessionID) !== timer
        || this.#disposed
        || this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
      this.#settlementRetryTimers.delete(attempt.sessionID)
      if (!attempt.pendingInspection) return
      try {
        await this.#refreshPendingSettlement(attempt)
      } catch {
        if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
        attempt.settlementRetryDelay = Math.min(delay * 2, TOMBSTONE_RETRY_MAX_MS)
        this.#scheduleSettlementRetry(attempt)
      }
    }, delay)
    timer.unref?.()
    this.#settlementRetryTimers.set(attempt.sessionID, timer)
  }

  #invalidatePendingSettlement(attempt, state) {
    attempt.generation = (attempt.generation ?? 0) + 1
    attempt.activeEvidencePending = true
    attempt.activeState = state
    attempt.pendingInspection = undefined
    attempt.pendingInspectionGeneration = undefined
    const timer = this.#settlementRetryTimers.get(attempt.sessionID)
    if (timer) clearTimeout(timer)
    this.#settlementRetryTimers.delete(attempt.sessionID)
  }

  async #markUncertainAttemptActive(attempt, state) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    this.#invalidatePendingSettlement(attempt, state)
    await attempt.settlement?.catch(() => undefined)
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    await this.#persistActiveEvidence(attempt)
    return this.#uncertainAttempts.get(attempt.sessionID) === attempt
  }

  async #refreshPendingSettlement(attempt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt || !attempt.pendingInspection) return false
    if (attempt.cancellationConfirmed) return this.#settleUncertainAttempt(attempt, attempt.pendingInspection)
    const inspectionGeneration = attempt.generation ?? 0
    const inspection = await this.#execution.inspectTurn({
      sessionID: attempt.sessionID,
      dispatchMessageID: attempt.dispatchMessageID,
    })
    if (!this.#inspectionIsCurrent(attempt, inspectionGeneration)) return false
      if (inspection?.state === "running" || inspection?.state === "retrying") {
        await this.#markUncertainAttemptActive(attempt, inspection.state)
        return false
      }
      if (inspection?.state === "missing") return this.#handleMissingUncertainAttempt(attempt)
      if (!inspection) {
        throw uncertainDelegationError("pending-settlement-reinspection-unavailable", {
          sessionID: attempt.sessionID,
          effect: attempt.effect.kind,
          writeScopes: attempt.effect.writeScopes,
          retainLock: true,
        })
      }
      if (!this.#stoppedInspection(attempt, inspection)) {
        throw uncertainDelegationError("pending-settlement-reinspection-uncertain", {
          sessionID: attempt.sessionID,
          effect: attempt.effect.kind,
          writeScopes: attempt.effect.writeScopes,
          retainLock: true,
        })
      }
      return this.#settleUncertainAttempt(attempt, inspection)
  }

  async #persistActiveEvidence(attempt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt || !attempt.activeEvidencePending) return
    if (attempt.activePersistence) return attempt.activePersistence
    const persistence = (async () => {
      if (!await this.#collectAttemptRecords(attempt)) return
      const confirmedCancellationInvalidated = attempt.cancellationConfirmed || Number.isFinite(attempt.cancellationConfirmedAt)
      const invalidatedResult = attempt.persistedTerminal?.result
        ?? attempt.delegation?.result
        ?? attempt.delegation?.invalidatedResult
      const activeDelegation = (current) => {
        const { endedAt: _endedAt, result: _result, cancellationConfirmedAt: _cancellationConfirmedAt, ...withoutTerminal } = current ?? {}
        const { cancellationRequestedAt: _cancellationRequestedAt, ...withoutCancellation } = withoutTerminal
        const delegation = confirmedCancellationInvalidated ? withoutCancellation : withoutTerminal
        const stillAuthorized = attempt.verifiedRunningAuthority && current?.status === "running"
          && current.cancellationRequestedAt === undefined && !invalidatedResult && !confirmedCancellationInvalidated
        return {
          ...delegation,
          status: stillAuthorized ? "running" : "unknown",
          diagnostics: delegation.status === "unknown" && delegation.diagnostics
            ? delegation.diagnostics
            : `reconciled-active: ${attempt.activeState ?? "running"}`,
          ...(invalidatedResult ? { invalidatedResult } : {}),
        }
      }
      await this.#writeAttemptRecords(attempt, activeDelegation, { requireCurrent: true })
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
      attempt.delegation = activeDelegation(attempt.delegation)
      attempt.persistedTerminal = undefined
      if (confirmedCancellationInvalidated) attempt.cancellationRequestedAt = undefined
      attempt.cancellationConfirmedAt = undefined
      attempt.cancellationConfirmed = false
      attempt.executionMissing = false
      attempt.fencePersisted = false
      attempt.activeEvidencePending = false
    })()
    attempt.activePersistence = persistence
    try {
      return await persistence
    } finally {
      if (attempt.activePersistence === persistence) attempt.activePersistence = undefined
    }
  }

  #scheduleCancellationRetry(attempt) {
    if (this.#disposed
      || this.#uncertainAttempts.get(attempt.sessionID) !== attempt
      || !attempt.cancellationRequestedAt
      || this.#cancellationRetryTimers.has(attempt.sessionID)) return
    const delay = attempt.cancellationRetryDelay ?? TOMBSTONE_RETRY_INITIAL_MS
    const timer = setTimeout(async () => {
      if (this.#cancellationRetryTimers.get(attempt.sessionID) !== timer
        || this.#disposed
        || this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
      this.#cancellationRetryTimers.delete(attempt.sessionID)
      try {
        await this.#stopUncertainAttempt(attempt)
      } catch {
        if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
        attempt.cancellationRetryDelay = Math.min(delay * 2, TOMBSTONE_RETRY_MAX_MS)
        this.#scheduleCancellationRetry(attempt)
      }
    }, delay)
    timer.unref?.()
    this.#cancellationRetryTimers.set(attempt.sessionID, timer)
  }

  async #persistDeletedAttemptTombstone(attempt, cancellationRequestedAt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    if (attempt.tombstoneWrite) return attempt.tombstoneWrite
    const diagnostics = `deleted-cancel-unconfirmed: 宿主未确认取消已删除 Session ${attempt.sessionID}`
    const delegation = {
      ...attempt.delegation,
      status: "unknown",
      executionSessionID: attempt.sessionID,
      cancellationRequestedAt,
      diagnostics,
      scopeLockID: attempt.lockID,
    }
    const write = (async () => {
      const existing = (await this.#store.children(delegation.parentSessionID)).filter((session) => {
        const delegation = sessionO4E(session)?.delegation
        return sessionO4E(session)?.kind === "delegation-attempt"
          && delegation?.taskID === undefined
          && delegation?.executionSessionID === attempt.sessionID
          && delegation?.scopeLockID === attempt.lockID
      })
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      if (existing.length > 0) {
        for (const session of existing) attempt.recordSessionIDs.add(session.id)
        attempt.recordSessionID = existing.at(-1).id
        attempt.recordMissing = false
        attempt.fencePersisted = existing.every((session) => sessionO4E(session)?.delegation?.cancellationRequestedAt === cancellationRequestedAt)
        attempt.tombstoneRetryDelay = TOMBSTONE_RETRY_INITIAL_MS
        attempt.tombstoneError = undefined
        this.#rememberUncertainAttempt(attempt)
        return true
      }
      if (typeof attempt.hostParentID !== "string" || attempt.hostParentID.trim() === "") {
        throw new Error("无法验证已删除委派的宿主 parent Session")
      }
      const tombstone = await this.#store.create({
        parentID: attempt.hostParentID,
        title: `[o4e] deleted delegation ${attempt.sessionID}`,
        agent: delegation.targetAgent,
        permission: delegation.compiledPermission,
        metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation } },
      })
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      for (const recordSessionID of attempt.recordSessionIDs) {
        if (this.#uncertainAttempts.get(recordSessionID) === attempt) this.#uncertainAttempts.delete(recordSessionID)
      }
      attempt.recordSessionID = tombstone.id
      attempt.recordSessionIDs.add(tombstone.id)
      attempt.delegation = delegation
      attempt.recordMissing = false
      attempt.fencePersisted = true
      attempt.tombstoneRetryDelay = TOMBSTONE_RETRY_INITIAL_MS
      attempt.tombstoneError = undefined
      const timer = this.#tombstoneRetryTimers.get(attempt.sessionID)
      if (timer) clearTimeout(timer)
      this.#tombstoneRetryTimers.delete(attempt.sessionID)
      this.#rememberUncertainAttempt(attempt)
      return true
    })()
    attempt.tombstoneWrite = write
    try {
      return await write
    } catch (error) {
      throw uncertainDelegationError(`无法持久化已删除委派的保守 tombstone: ${error instanceof Error ? error.message : String(error)}`, {
        sessionID: attempt.sessionID,
        effect: attempt.effect.kind,
        writeScopes: attempt.effect.writeScopes,
        retainLock: true,
      })
    } finally {
      if (attempt.tombstoneWrite === write) attempt.tombstoneWrite = undefined
    }
  }

  async #handleMissingUncertainAttempt(attempt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    attempt.executionMissing = true
    attempt.recordSessionIDs.delete(attempt.sessionID)
    attempt.recordSessionID = attempt.recordSessionIDs.values().next().value
    attempt.recordMissing = attempt.recordSessionIDs.size === 0
    attempt.cancellationRequestedAt ??= Date.now()
    attempt.fencePersisted = false
    attempt.delegation = {
      ...attempt.delegation,
      cancellationRequestedAt: attempt.cancellationRequestedAt,
    }
    if (!attempt.cancellationConfirmed) {
      const cancelled = await this.#execution.cancelTurn({ sessionID: attempt.sessionID }).catch(() => null)
      if (cancelled?.acknowledged === true) this.#confirmMissingCancellation(attempt)
    }
    if (attempt.cancellationConfirmed) {
      try {
        const settled = await this.#settleUncertainAttempt(attempt, { state: "idle" })
        if (!settled) throw new Error(`缺失 Attempt 结算被 active 证据失效: ${attempt.sessionID}`)
        return true
      } catch {
        this.#locks.restore(attempt.lockID, attempt.effect, { allowConflict: true })
        this.#rememberUncertainAttempt(attempt)
        return false
      }
    }
    this.#locks.restore(attempt.lockID, attempt.effect, { allowConflict: true })
    this.#rememberUncertainAttempt(attempt)
    if (attempt.recordSessionIDs.size === 0 || attempt.recordMissing) {
      await this.#persistDeletedAttemptTombstone(attempt, attempt.cancellationRequestedAt).catch((error) => {
        attempt.tombstoneError = error
        this.#scheduleTombstoneRetry(attempt)
      })
    } else {
      await Promise.all([...attempt.recordSessionIDs].map((recordSessionID) => this.#store.updateO4E(recordSessionID, (state) => ({
        ...state,
        delegation: {
          ...state.delegation,
          status: "unknown",
          cancellationRequestedAt: state.delegation?.cancellationRequestedAt ?? attempt.cancellationRequestedAt,
          diagnostics: `missing-cancel-unconfirmed: 宿主未确认取消缺失 Session ${attempt.sessionID}`,
        },
      }))))
    }
    this.#scheduleCancellationRetry(attempt)
    return false
  }

  #confirmMissingCancellation(attempt) {
    if (!attempt.executionMissing) return
    attempt.cancellationConfirmedAt ??= Date.now()
    attempt.cancellationConfirmed = true
    attempt.delegation = {
      ...attempt.delegation,
      cancellationRequestedAt: attempt.cancellationRequestedAt,
      cancellationConfirmedAt: attempt.cancellationConfirmedAt,
    }
  }

  async #writeAttemptRecords(attempt, transform, { requireCurrent = false } = {}) {
    const updatedDelegations = []
    const failures = []
    for (const recordSessionID of [...attempt.recordSessionIDs]) {
      if (requireCurrent && this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
      try {
        const updated = await this.#store.updateO4E(recordSessionID, (state) => ({
          ...state,
          delegation: transform(state.delegation),
        }))
        updatedDelegations.push(sessionO4E(updated).delegation)
      } catch (error) {
        if (isNotFoundError(error)) {
          attempt.recordSessionIDs.delete(recordSessionID)
          if (this.#uncertainAttempts.get(recordSessionID) === attempt) this.#uncertainAttempts.delete(recordSessionID)
        } else failures.push(error)
      }
    }
    if (failures.length > 0) throw failures[0]
    return updatedDelegations
  }

  async #persistCancellationConfirmation(attempt) {
    if (!attempt.cancellationConfirmed || !Number.isFinite(attempt.cancellationConfirmedAt)) return
    await this.#writeAttemptRecords(attempt, (delegation) => ({
      ...delegation,
      cancellationRequestedAt: cancellationTime([
        delegation,
        { cancellationRequestedAt: attempt.cancellationRequestedAt },
      ]),
      cancellationConfirmedAt: cancellationConfirmationTime([
        delegation,
        { cancellationConfirmedAt: attempt.cancellationConfirmedAt },
      ]),
    }))
  }

  async #persistCancellationFence(attempt, diagnostics) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    if (attempt.fencePersistence) return attempt.fencePersistence
    const persistence = (async () => {
      if (!await this.#collectAttemptRecords(attempt)) return false
      await this.#writeAttemptRecords(attempt, (delegation) => ({
        ...delegation,
        cancellationRequestedAt: cancellationTime([
          delegation,
          { cancellationRequestedAt: attempt.cancellationRequestedAt },
        ]),
        ...(diagnostics && ["running", "unknown"].includes(delegation?.status) ? { diagnostics } : {}),
      }), { requireCurrent: true })
      if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
      if (attempt.recordSessionIDs.size === 0) {
        attempt.recordMissing = true
        await this.#persistDeletedAttemptTombstone(attempt, attempt.cancellationRequestedAt)
      } else attempt.fencePersisted = true
      return this.#uncertainAttempts.get(attempt.sessionID) === attempt
    })()
    attempt.fencePersistence = persistence
    try {
      return await persistence
    } finally {
      if (attempt.fencePersistence === persistence) attempt.fencePersistence = undefined
    }
  }

  async #collectAttemptRecords(attempt) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    const sessions = await this.#store.children(attempt.delegation.parentSessionID)
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
    const delegations = []
    for (const session of sessions) {
      const state = sessionO4E(session)
      const delegation = state.kind === "delegation-attempt" ? state.delegation : undefined
      if (!delegation || delegation.taskID !== undefined) continue
      if ((delegation.executionSessionID ?? session.id) !== attempt.sessionID) continue
      if ((delegation.scopeLockID ?? `delegation-uncertain:${session.id}`) !== attempt.lockID) continue
      attempt.recordSessionIDs.add(session.id)
      delegations.push(delegation)
    }
    attempt.cancellationRequestedAt = cancellationTime([
      ...delegations,
      ...(attempt.cancellationRequestedAt === undefined ? [] : [{ cancellationRequestedAt: attempt.cancellationRequestedAt }]),
    ])
    const retainedConfirmation = attempt.cancellationConfirmed ? attempt.cancellationConfirmedAt : undefined
    attempt.cancellationConfirmedAt = retainedConfirmation ?? cancellationConfirmationTime(delegations)
    attempt.cancellationConfirmed = attempt.cancellationConfirmedAt !== undefined
    attempt.executionMissing ||= attempt.cancellationConfirmed
    attempt.delegation = {
      ...attempt.delegation,
      cancellationRequestedAt: attempt.cancellationRequestedAt,
      ...(attempt.cancellationConfirmedAt === undefined ? {} : { cancellationConfirmedAt: attempt.cancellationConfirmedAt }),
    }
    attempt.fencePersisted = attempt.cancellationRequestedAt !== undefined
      && delegations.length > 0
      && delegations.every((delegation) => delegation.cancellationRequestedAt === attempt.cancellationRequestedAt)
    attempt.persistedTerminal = persistedTerminal([...delegations, attempt.persistedTerminal].filter(Boolean))
    attempt.recordSessionID ??= attempt.recordSessionIDs.values().next().value
    attempt.recordMissing = attempt.recordSessionIDs.size === 0
    this.#rememberUncertainAttempt(attempt)
    return true
  }

  async #reconcileUncertainAttempt(sessionID, { knownStopped = false } = {}) {
    const attempt = this.#uncertainAttempts.get(sessionID)
    if (!attempt) return { settled: false }
    const executionEvent = sessionID === attempt.sessionID
    const inspectionGeneration = attempt.generation ?? 0
    const inspection = await this.#execution.inspectTurn({
      sessionID: attempt.sessionID,
      dispatchMessageID: attempt.dispatchMessageID,
    }).catch(() => null)
    if (!this.#inspectionIsCurrent(attempt, inspectionGeneration)) return { settled: false }
    if (!inspection || inspection.state === "unknown") {
      if (!knownStopped || !executionEvent) return { settled: false }
      const settled = await this.#settleUncertainAttempt(attempt, { state: "idle" })
      return { settled, inspection: { state: "idle" } }
    }
    if (inspection.state === "running" || inspection.state === "retrying") {
      await this.#markUncertainAttemptActive(attempt, inspection.state)
      return { settled: false, inspection }
    }
    if (inspection.state === "missing") return { settled: await this.#handleMissingUncertainAttempt(attempt), inspection }
    if (!this.#stoppedInspection(attempt, inspection)) return { settled: false, inspection }
    const settled = await this.#settleUncertainAttempt(attempt, inspection)
    return { settled, inspection }
  }

  #stoppedInspection(attempt, inspection) {
    return inspection?.state === "idle"
      || (inspection?.state === "inactive" && (attempt.cancellationConfirmed || attempt.cancellationRequestedAt !== undefined))
  }

  async #settleUncertainAttempt(attempt, inspection) {
    if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt || !this.#stoppedInspection(attempt, inspection)) return false
    const resultRefs = !inspection.error && inspection.result ? messageReferences(inspection.result) : undefined
    if (!attempt.cancellationRequestedAt
      && resultRefs?.messageID
      && resultRefs.messageID === attempt.delegation?.invalidatedResult?.messageID) {
      return false
    }
    if (!attempt.pendingInspection
      || (!attempt.cancellationRequestedAt && inspection.error)
      || (!attempt.cancellationRequestedAt && !inspection.error && inspection.result)
      || (!attempt.pendingInspection.result && !attempt.pendingInspection.error && !attempt.pendingInspection.status && inspection.status)) {
      attempt.pendingInspection = inspection
      attempt.pendingInspectionGeneration = attempt.generation ?? 0
    }
    if (attempt.settlement) return attempt.settlement
    const settlement = (async () => {
      if (attempt.tombstoneWrite) await attempt.tombstoneWrite.catch(() => undefined)
      while (true) {
        if (this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return false
        if (attempt.activeEvidencePending) await this.#persistActiveEvidence(attempt)
        if (attempt.recordSessionIDs.size === 0 || attempt.recordMissing) {
          await this.#persistDeletedAttemptTombstone(attempt, attempt.cancellationRequestedAt ?? Date.now())
        }
        if (!await this.#collectAttemptRecords(attempt)) return false
        await this.#persistCancellationConfirmation(attempt)
        const terminal = attempt.pendingInspection
        const terminalGeneration = attempt.pendingInspectionGeneration
        if (!terminal || !this.#inspectionIsCurrent(attempt, terminalGeneration)) return false
        const persisted = attempt.persistedTerminal
        const status = attempt.cancellationConfirmed ? "cancelled" : persisted?.status ?? (attempt.cancellationRequestedAt ? "cancelled" : terminal.status ?? (terminal.error ? "failed" : terminal.result ? "reported-completed" : "unknown"))
        const refs = status === "reported-completed"
          ? persisted?.result ?? (!terminal.error && terminal.result ? messageReferences(terminal.result) : undefined)
          : undefined
        const endedAt = attempt.cancellationConfirmed ? attempt.cancellationConfirmedAt ?? Date.now() : persisted?.endedAt ?? Date.now()
        const diagnostics = persisted?.diagnostics ?? terminal.diagnostics ?? (terminal.error ? `reconciled-error: ${String(terminal.error)}` : "reconciled-stopped-without-result")
        const candidate = {
          status,
          endedAt,
          cancellationRequestedAt: attempt.cancellationRequestedAt,
          cancellationConfirmedAt: attempt.cancellationConfirmedAt,
          result: refs,
          diagnostics: refs ? undefined : diagnostics,
          forceCancellation: attempt.cancellationConfirmed === true,
        }
        const updatedDelegations = await this.#writeAttemptRecords(attempt, (delegation) => mergeTerminalDelegation(delegation ?? {}, candidate))
        if (attempt.pendingInspection !== terminal || !this.#inspectionIsCurrent(attempt, terminalGeneration)) return false
        const mergedCancellation = cancellationTime(updatedDelegations)
        attempt.cancellationRequestedAt = cancellationTime([
          ...(attempt.cancellationRequestedAt === undefined ? [] : [{ cancellationRequestedAt: attempt.cancellationRequestedAt }]),
          ...(mergedCancellation === undefined ? [] : [{ cancellationRequestedAt: mergedCancellation }]),
        ])
        const mergedTerminal = persistedTerminal(updatedDelegations)
        if (mergedTerminal && JSON.stringify(mergedTerminal) !== JSON.stringify(attempt.persistedTerminal)) {
          attempt.persistedTerminal = mergedTerminal
          continue
        }
        if (attempt.recordSessionIDs.size > 0) {
          if (attempt.pendingInspection !== terminal) continue
          break
        }
        attempt.recordMissing = true
      }
      attempt.pendingInspection = undefined
      attempt.pendingInspectionGeneration = undefined
      attempt.settlementRetryDelay = TOMBSTONE_RETRY_INITIAL_MS
      attempt.cancellationRetryDelay = TOMBSTONE_RETRY_INITIAL_MS
      this.#releaseUncertainAttempt(attempt)
      return true
    })()
    attempt.settlement = settlement
    try {
      return await settlement
    } catch (error) {
      this.#scheduleSettlementRetry(attempt)
      throw error
    } finally {
      if (attempt.settlement === settlement) attempt.settlement = undefined
    }
  }

  #releaseUncertainAttempt(attempt, { releaseLock = true } = {}) {
    if (!attempt || this.#uncertainAttempts.get(attempt.sessionID) !== attempt) return
    attempt.generation = (attempt.generation ?? 0) + 1
    this.#forgetUncertainAttempt(attempt)
    this.#clearAttemptRetryTimers(attempt)
    this.#managedAttemptSessions.delete(attempt.sessionID)
    if (releaseLock) this.#locks.release(attempt.lockID)
  }

  async enforceWriteScope(input, output) {
    if (input.tool !== "edit" && input.tool !== "write" && input.tool !== "apply_patch") return
    const session = await this.#store.get(input.sessionID)
    const delegation = sessionO4E(session)?.delegation
    if (delegation?.effect !== "scoped-write" || !Array.isArray(delegation.writeScopes)) return
    const candidates = input.tool === "apply_patch"
      ? applyPatchPaths(output?.args?.patchText)
      : [output?.args?.filePath ?? output?.args?.path ?? output?.args?.file]
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !pathWithinScopes(candidate, delegation.writeScopes, session.directory || this.#directory)) {
        throw new Error(`写入路径不在委派 writeScopes 内: ${typeof candidate === "string" ? candidate : "<missing path>"}`)
      }
    }
  }

  #assertActive() {
    if (this.#quiescing || this.#disposed) throw runtimeDisposingError()
  }
}
