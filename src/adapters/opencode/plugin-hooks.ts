import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { SELECTABLE_AGENT_TYPES } from "../../agent-layout.mjs"
import { modelRefKey, normalizeModelRefs, SessionModelFallback } from "../../model-fallback.mjs"
import { formatInstructionFiles, loadInstructionFiles } from "../../agent-context.mjs"
import { applyAgentPolicies, applyMcpConfig } from "./context-projection.mjs"
import { applyNativeAgentTakeover, resolveNativeAgentName } from "../../core/native-takeover.mjs"
import { assembleNativePrompt, assemblePrompt } from "../../core/prompt-assembly.mjs"
import { PLAN_REMINDER_HEADER } from "../../core/capability-policy.mjs"
import { createSoulHandler } from "../../soul.mjs"
import { readPromptFile } from "../../prompt-file.mjs"
import { runEventPipeline } from "../../runtime/event-pipeline.mjs"
import { createSnapshotAccessor } from "../../runtime/snapshot.mjs"
import { createRuntimeLifecycle } from "../../runtime/lifecycle.mjs"
import { serial } from "../../runtime/serial.mjs"
import { DelegationRuntime } from "../../runtime/delegation-runtime.mjs"
import { BackgroundTaskRuntime } from "../../runtime/background-task-runtime.mjs"
import { CommandTaskRuntime } from "../../runtime/command-task-runtime.mjs"
import { createTaskReadBudget, validateTaskReadOptions, WATCH_MAX_TIMEOUT_MS } from "../../runtime/task-read-budget.mjs"
import { validateTaskControlArgs } from "../../runtime/task-control-args.mjs"
import { commandControlLines, inspectionText, previewLines, statusLine, watchTaskText } from "../../runtime/task-result-visibility.mjs"
import { presentTaskResult, restoreTaskModelMessages } from "../../runtime/task-model-output.mjs"
import { canonicalDirectoryKey } from "../../runtime/directory-key.mjs"
import { OpenCodeSessionStore, sessionO4E } from "../../runtime/session-store.mjs"
import { createSharedScopeLockManager } from "../../runtime/scope-locks.mjs"
import { createSharedBackgroundTaskScheduler } from "../../runtime/background-task-scheduler.mjs"
import { createOpenCodeAgentExecutionPort } from "./agent-execution-port.mjs"
import { createCommandExecutionPort } from "../../command-core/command-execution-port.mjs"
import { createCommandCard } from "./command-card.mjs"
import { acquireAutomaticTaskFollow, automaticFollowControl, updateAutomaticFollowControl } from "./automatic-task-follow.mjs"
import { authorizeBash } from "./bash-permission.mjs"
import { readTaskInspection } from "./task-inspection.mjs"
import { resolveInspectionCursors } from "./task-inspection-resume.mjs"
import { latestUserPromptContext, messageModel } from "./message-model.mjs"
import { AGENT_TASK_TOOL, collectMcpServerNames, effectiveAgentPermission, legalAgentCandidates, permissionAction, TASK_TOOL, WORKFLOW_TOOL } from "../../core/agent-routing.mjs"
import { isActionableTaskStatus, isTerminalTaskStatus } from "../../core/background-task-domain.mjs"
import { normalizeOpenCodeEvent } from "./event-normalizer.mjs"
import { invalidO4eModeMessage, invalidO4eModeValue as findInvalidO4eModeValue, resolveO4eMode } from "../../run-mode.mjs"
import { loadRuntimeDefinition } from "../../runtime-builder.mjs"
import { configRootExists, runtimePaths, resolveO4eConfigRoot } from "../../config-paths.mjs"
export { resolveO4eConfigRoot } from "../../config-paths.mjs"
import { WorkflowRuntime } from "../../runtime/workflow-runtime.mjs"
import { normalizeProcessArgs, processToolArgs, validateProcessArgs } from "../../core/workflow-process.mjs"
import { OUTPUT_LIMITS, truncateLinesTail, truncateUtf8Tail } from "../../runtime/output-limits.mjs"

const COMPONENT = "opencode-for-everything"
const CONFIG_DIR = ".o4e"
const MARKER_RE = new RegExp(`<!--${COMPONENT}-agent:([a-z0-9][a-z0-9-]*(?: \\(plan\\))?)-->`)
const SYSTEM_AGENT_MARKER_RE = new RegExp(`<!--${COMPONENT}-system-agent:([a-z0-9-]+)-->`)
const BACKGROUND_TASK_PROTOCOL_MARKER = `<!--${COMPONENT}-runtime:background-task-protocol-->`
const DEBUG = process.env.OPENCODE_FOR_EVERYTHING_DEBUG === "1"
const TERMINAL_WAKEUP_BATCH_DELAY_MS = 100
const TERMINAL_WAKEUP_BATCH_RECHECK_MS = 1_000
const TERMINAL_WAKEUP_BATCH_MAX_WAIT_MS = 30_000
const TERMINAL_CHECK_FAILURE_LIMIT = 3
const TERMINAL_FALLBACK_ACCEPTANCE_GRACE_MS = 1_000

type McpToolAccess = Record<string, string[]>
type AgentType = "primary" | "subagent" | "all"
type PlanConfig = { mode: "self" | "child"; permission?: unknown; loadSkills?: string[]; loadTools?: string[]; loadMcp?: McpToolAccess; loadAgents?: string[]; loadWorkflows?: string[]; reminder?: string }
type PromptRuntime = { nativeSystem?: string[]; base: string; systemPrompt?: string; injects: string[]; promptDir: string; instructionFiles: { global: string[]; project: string[] } }
type AgentRuntime = PromptRuntime & { type: AgentType; name: string; description: string; messagePrompt?: string; models: unknown[]; resolvedModels?: unknown[]; fallbackModels: unknown[]; backgroundTasks: { maxRetries: number }; nativeMode?: "build" | "plan"; plan?: PlanConfig; planProfile: boolean; planSourceName?: string; planPermission?: unknown; planReminder?: string; planOverrides?: Record<string, boolean>; loadSkills: string[]; loadTools?: string[]; loadMcp?: McpToolAccess; permission?: unknown; loadAgents: string[]; loadWorkflows: string[]; capabilities: string[] }
type SystemPhaseAgentRuntime = PromptRuntime & { type: "system"; name: string; loadSkills: string[]; loadTools?: string[]; loadMcp?: McpToolAccess }
type RuntimeDefinition = ReturnType<typeof loadRuntimeDefinition>
type Runtime = { configRoot: string; globalConfigRoot: string; config: RuntimeDefinition["config"]; skillsRoot: string }
type RuntimeSnapshot = {
  runtime: Runtime
  agents: AgentRuntime[]
  primaryAgents: AgentRuntime[]
  systemPhaseAgents: SystemPhaseAgentRuntime[]
  nativeModes: Record<string, string>
  nativeAgentStrategies: Record<string, string>
  agentByName: Map<string, AgentRuntime>
  allAgents: Array<AgentRuntime | SystemPhaseAgentRuntime>
  soulHandler: ReturnType<typeof createSoulHandler> | null
  workflows: Map<string, any>
  mcpServerNames?: Set<string>
}

type SharedTerminalContinuation = {
  messageID: string
  partID: string
  part: any
  receiptIDs: Set<string>
  messageUpdated: boolean
  pendingPartIDs: Set<string>
  persisted: boolean
  retryRequested: boolean
  fallbackAcceptedAt?: number
  fallbackObservedActive?: boolean
  createdAt: number
  submission?: Promise<any>
}

type SharedTerminalSubmissionDecision = "submit" | "consumed" | "unavailable"

const SHARED_TERMINAL_CONTINUATIONS = Symbol.for("opencode-for-everything.terminal-continuations.v2")
const sharedTerminalContinuations = ((globalThis as any)[SHARED_TERMINAL_CONTINUATIONS] ??= new Map()) as Map<string, {
  refs: number
  sessions: Map<string, Map<string, SharedTerminalContinuation>>
  consumers: Map<symbol, (sessionID: string, messageID: string, receiptIDs: Set<string>) => void>
  receiptConsumers: Map<symbol, (sessionID: string, receiptIDs: Set<string>) => void>
  receiptReleaseConsumers: Map<symbol, (sessionID: string, receiptIDs: Set<string>) => void>
  consumedReceipts: Map<string, Set<string>>
  consumingReceipts: Map<string, Map<string, number>>
  submitLocks: Map<string, Promise<unknown>>
  userTurnEpochs: Map<string, number>
  userTurnClaims: Map<string, Map<symbol, { ownerID: symbol; epoch: number; phase: "active" | "persisted" }>>
  userTurnReleaseConsumers: Map<symbol, (sessionID: string) => void>
  watchClaims: Map<string, Map<symbol, { ownerID: symbol; requesterSessionID: string; watchAll: boolean; watchedTaskIDs: Set<string> }>>
  watchReleaseConsumers: Map<symbol, (sessionID: string) => void>
}>

function acquireSharedTerminalContinuations(directory: string) {
  let entry = sharedTerminalContinuations.get(directory)
  if (!entry) {
    entry = {
      refs: 0,
      sessions: new Map(),
      consumers: new Map(),
      receiptConsumers: new Map(),
      receiptReleaseConsumers: new Map(),
      consumedReceipts: new Map(),
      consumingReceipts: new Map(),
      submitLocks: new Map(),
      userTurnEpochs: new Map(),
      userTurnClaims: new Map(),
      userTurnReleaseConsumers: new Map(),
      watchClaims: new Map(),
      watchReleaseConsumers: new Map(),
    }
    sharedTerminalContinuations.set(directory, entry)
  }
  entry.refs += 1
  const consumerID = Symbol()
  let released = false
  return {
    sessions: entry.sessions,
    registerConsumer(consumer: (sessionID: string, messageID: string, receiptIDs: Set<string>) => void) {
      entry!.consumers.set(consumerID, consumer)
    },
    registerReceiptConsumer(consumer: (sessionID: string, receiptIDs: Set<string>) => void) {
      entry!.receiptConsumers!.set(consumerID, consumer)
    },
    registerReceiptReleaseConsumer(consumer: (sessionID: string, receiptIDs: Set<string>) => void) {
      entry!.receiptReleaseConsumers!.set(consumerID, consumer)
    },
    markPersisted(sessionID: string, messageID: string) {
      const continuations = entry!.sessions.get(sessionID)
      const continuation = continuations?.get(messageID)
      if (!continuation || !continuation.messageUpdated || continuation.pendingPartIDs.size > 0) return false
      continuation.persisted = true
      const receiptIDs = new Set(continuation.receiptIDs)
      for (const consumer of entry!.consumers.values()) consumer(sessionID, messageID, receiptIDs)
      return true
    },
    consumeReceipts(sessionID: string, receiptIDs: Set<string>) {
      if (receiptIDs.size === 0) return
      const consumed = entry!.consumedReceipts!.get(sessionID) ?? new Set<string>()
      for (const receiptID of receiptIDs) consumed.add(receiptID)
      while (consumed.size > 512) {
        const oldest = consumed.values().next().value
        if (typeof oldest !== "string") break
        consumed.delete(oldest)
      }
      entry!.consumedReceipts!.set(sessionID, consumed)
      const consuming = entry!.consumingReceipts!.get(sessionID)
      for (const receiptID of receiptIDs) consuming?.delete(receiptID)
      if (consuming?.size === 0) entry!.consumingReceipts!.delete(sessionID)
      const continuations = entry!.sessions.get(sessionID)
      if (continuations) {
        for (const [messageID, continuation] of continuations) {
          if ([...receiptIDs].some((receiptID) => continuation.receiptIDs.has(receiptID))) continuations.delete(messageID)
        }
        if (continuations.size === 0) entry!.sessions.delete(sessionID)
      }
      for (const consumer of entry!.receiptConsumers!.values()) consumer(sessionID, new Set(receiptIDs))
    },
    beginReceiptConsumption(sessionID: string, receiptIDs: Set<string>) {
      if (receiptIDs.size === 0) return
      const consuming = entry!.consumingReceipts!.get(sessionID) ?? new Map<string, number>()
      for (const receiptID of receiptIDs) consuming.set(receiptID, (consuming.get(receiptID) ?? 0) + 1)
      entry!.consumingReceipts!.set(sessionID, consuming)
    },
    releaseReceiptConsumption(sessionID: string, receiptIDs: Set<string>) {
      if (receiptIDs.size === 0) return
      const consuming = entry!.consumingReceipts!.get(sessionID)
      const released = new Set<string>()
      for (const receiptID of receiptIDs) {
        const count = consuming?.get(receiptID) ?? 0
        if (count <= 1) {
          consuming?.delete(receiptID)
          if (!entry!.consumedReceipts!.get(sessionID)?.has(receiptID)) released.add(receiptID)
        } else consuming!.set(receiptID, count - 1)
      }
      if (consuming?.size === 0) entry!.consumingReceipts!.delete(sessionID)
      if (released.size > 0) {
        for (const consumer of entry!.receiptReleaseConsumers!.values()) consumer(sessionID, new Set(released))
      }
    },
    hasConsumedReceipt(sessionID: string, receiptID: string) {
      return entry!.consumedReceipts!.get(sessionID)?.has(receiptID) === true
    },
    isReceiptUnavailable(sessionID: string, receiptID: string) {
      return entry!.consumedReceipts!.get(sessionID)?.has(receiptID) === true
        || entry!.consumingReceipts!.get(sessionID)?.has(receiptID) === true
    },
    serializeSubmission<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
      return serial(entry!.submitLocks, sessionID, operation)
    },
    beginUserTurn(sessionID: string) {
      const epochs = entry!.userTurnEpochs!
      const epoch = (epochs.get(sessionID) ?? 0) + 1
      epochs.set(sessionID, epoch)
      const claimID = Symbol("terminal-user-turn")
      const claims = entry!.userTurnClaims!.get(sessionID) ?? new Map()
      claims.set(claimID, { ownerID: consumerID, epoch, phase: "active" })
      entry!.userTurnClaims!.set(sessionID, claims)
      return { claimID, epoch }
    },
    userTurnEpoch(sessionID: string) {
      return entry!.userTurnEpochs!.get(sessionID) ?? 0
    },
    userTurnSettlementEpoch(sessionID: string) {
      let throughEpoch = entry!.userTurnEpochs!.get(sessionID) ?? 0
      for (const claim of entry!.userTurnClaims!.get(sessionID)?.values() ?? []) {
        if (claim.phase === "active") throughEpoch = Math.min(throughEpoch, claim.epoch - 1)
      }
      return Math.max(0, throughEpoch)
    },
    hasUserTurn(sessionID: string) {
      return (entry!.userTurnClaims!.get(sessionID)?.size ?? 0) > 0
    },
    markUserTurnPersisted(sessionID: string, claimID: symbol) {
      const claim = entry!.userTurnClaims!.get(sessionID)?.get(claimID)
      if (!claim) return false
      claim.phase = "persisted"
      return true
    },
    endUserTurn(sessionID: string, claimID: symbol) {
      const claims = entry!.userTurnClaims!.get(sessionID)
      if (!claims?.delete(claimID)) return false
      if (claims.size === 0) entry!.userTurnClaims!.delete(sessionID)
      for (const consumer of entry!.userTurnReleaseConsumers!.values()) consumer(sessionID)
      return true
    },
    settlePersistedUserTurnsThrough(sessionID: string, throughEpoch: number) {
      const claims = entry!.userTurnClaims!.get(sessionID)
      let changed = false
      for (const [claimID, claim] of claims ?? []) {
        if (claim.phase !== "persisted" || claim.epoch > throughEpoch) continue
        claims!.delete(claimID)
        changed = true
      }
      if (!changed) return false
      if (claims!.size === 0) entry!.userTurnClaims!.delete(sessionID)
      for (const consumer of entry!.userTurnReleaseConsumers!.values()) consumer(sessionID)
      return true
    },
    clearOwnedUserTurnsThrough(sessionID: string, throughEpoch: number) {
      const claims = entry!.userTurnClaims!.get(sessionID)
      let changed = false
      for (const [claimID, claim] of claims ?? []) {
        if (claim.ownerID !== consumerID || claim.epoch > throughEpoch) continue
        claims!.delete(claimID)
        changed = true
      }
      if (!changed) return false
      if (claims!.size === 0) entry!.userTurnClaims!.delete(sessionID)
      for (const consumer of entry!.userTurnReleaseConsumers!.values()) consumer(sessionID)
      return true
    },
    registerUserTurnReleaseConsumer(consumer: (sessionID: string) => void) {
      entry!.userTurnReleaseConsumers!.set(consumerID, consumer)
    },
    registerWatch(sessionID: string, claim: { requesterSessionID: string; watchAll: boolean; watchedTaskIDs: Set<string> }) {
      const watches = entry!.watchClaims!.get(sessionID) ?? new Map()
      const claimID = Symbol("terminal-watch")
      watches.set(claimID, { ...claim, ownerID: consumerID })
      entry!.watchClaims!.set(sessionID, watches)
      return claimID
    },
    unregisterWatch(sessionID: string, claimID?: symbol) {
      const watches = entry!.watchClaims!.get(sessionID)
      if (claimID) watches?.delete(claimID)
      else for (const [id, claim] of watches ?? []) if (claim.requesterSessionID === sessionID) watches.delete(id)
      if (watches?.size === 0) entry!.watchClaims!.delete(sessionID)
      for (const consumer of entry!.watchReleaseConsumers!.values()) consumer(sessionID)
    },
    hasWatch(sessionID: string, taskID?: string) {
      return [...(entry!.watchClaims!.get(sessionID)?.values() ?? [])].some((watch) => (
        watch.requesterSessionID === sessionID
        && (taskID === undefined || watch.watchAll || watch.watchedTaskIDs.has(taskID))
      ))
    },
    registerWatchReleaseConsumer(consumer: (sessionID: string) => void) {
      entry!.watchReleaseConsumers!.set(consumerID, consumer)
    },
    deleteSession(sessionID: string) {
      entry!.sessions.delete(sessionID)
      entry!.consumedReceipts!.delete(sessionID)
      entry!.consumingReceipts!.delete(sessionID)
      entry!.submitLocks!.delete(sessionID)
      entry!.userTurnEpochs!.delete(sessionID)
      entry!.userTurnClaims!.delete(sessionID)
      entry!.watchClaims!.delete(sessionID)
    },
    release() {
      if (released) return
      released = true
      entry!.consumers.delete(consumerID)
      entry!.receiptConsumers!.delete(consumerID)
      entry!.receiptReleaseConsumers!.delete(consumerID)
      entry!.userTurnReleaseConsumers!.delete(consumerID)
      entry!.watchReleaseConsumers!.delete(consumerID)
      const releasedUserSessions = new Set<string>()
      for (const [sessionID, claims] of entry!.userTurnClaims!) {
        for (const [claimID, claim] of claims) {
          if (claim.ownerID !== consumerID) continue
          claims.delete(claimID)
          releasedUserSessions.add(sessionID)
        }
        if (claims.size === 0) entry!.userTurnClaims!.delete(sessionID)
      }
      const releasedWatchSessions = new Set<string>()
      for (const [sessionID, claims] of entry!.watchClaims!) {
        for (const [claimID, claim] of claims) {
          if (claim.ownerID !== consumerID) continue
          claims.delete(claimID)
          releasedWatchSessions.add(sessionID)
        }
        if (claims.size === 0) entry!.watchClaims!.delete(sessionID)
      }
      for (const sessionID of releasedUserSessions) {
        for (const consumer of entry!.userTurnReleaseConsumers!.values()) consumer(sessionID)
      }
      for (const sessionID of releasedWatchSessions) {
        for (const consumer of entry!.watchReleaseConsumers!.values()) consumer(sessionID)
      }
      entry!.refs -= 1
      if (entry!.refs <= 0 && sharedTerminalContinuations.get(directory) === entry) {
        sharedTerminalContinuations.delete(directory)
      }
    },
  }
}

function dbg(...args: unknown[]): void {
  if (DEBUG) console.log(...args)
}

// Fields that can carry meaning for each o4e_task action. Fields outside the
// set are noise for that action by definition and are discarded before
// validation, regardless of their value: some host/model adapters populate
// every advertised optional field with invented values ("", " ", "unused",
// enabled:true|false, expectedRevision:1, taskIDs:[], cursor:"x" ...), and
// such model-generated arguments are normal input the public entry must
// absorb rather than reject. Fields inside the set stay strictly validated
// below; reason/cursors/reread are never meaningful input and keep their
// explicit rejections in the shared validators, so they survive the discard.
const TASK_ACTION_FIELDS: Record<string, readonly string[]> = {
  status: ["taskID"],
  watch: ["taskID", "taskIDs", "timeoutMs", "ioTimeoutMs"],
  inspect: ["taskID", "cursor", "direction", "maxBytes", "resume", "ioTimeoutMs"],
  output: ["taskID"],
  input: ["taskID", "input", "expectedRevision", "delivery"],
  resume: ["taskID", "expectedRevision"],
  resolve: ["taskID", "expectedRevision", "decision"],
  pending: ["taskID"],
  "permission.reply": ["taskID", "requestID", "reply", "message", "expectedRevision"],
  "question.reply": ["taskID", "requestID", "answers", "expectedRevision"],
  "question.reject": ["taskID", "requestID", "expectedRevision"],
}
const TASK_ARGS_VALIDATOR_KEYS = new Set(["reason", "cursors", "reread"])
const blankTaskArg = (value: unknown): boolean => value === undefined || value === null
  || (typeof value === "string" && value.trim().length === 0)

export function normalizeTaskToolArgs(args: any): any {
  const action = args?.action
  if (args && typeof args === "object" && Object.hasOwn(TASK_ACTION_FIELDS, action)) {
    args = { ...args }
    const allowed = new Set(["action", ...TASK_ACTION_FIELDS[action]])
    for (const key of Object.keys(args)) {
      if (!allowed.has(key) && !TASK_ARGS_VALIDATOR_KEYS.has(key)) delete args[key]
    }
    // Structural no-information values count as omitted; only values with a
    // meaningful shape reach the strict per-action validation below.
    for (const key of ["taskID", "cursor", "direction", "delivery", "requestID", "message",
      "timeoutMs", "ioTimeoutMs", "maxBytes", "expectedRevision", "resume"]) {
      if (blankTaskArg(args[key])) delete args[key]
    }
    if (action === "watch" && Array.isArray(args.taskIDs)) {
      // taskIDs is watch-only; other actions had it discarded above. An
      // explicit empty selection ("[] selects nothing") is preserved only as
      // the sole selector; all-blank elements are fill noise, and an empty
      // array alongside taskID adds no selection. Overlapping taskID/taskIDs
      // merge into taskIDs; disjoint non-empty ones stay for the strict
      // coexistence rejection below.
      const cleaned = args.taskIDs.filter((taskID: unknown) => !blankTaskArg(taskID))
      const hasTaskID = typeof args.taskID === "string" && args.taskID.trim().length > 0
      if (cleaned.length === 0) {
        if (args.taskIDs.length > 0 || hasTaskID) delete args.taskIDs
      } else if (!cleaned.every((taskID: unknown) => typeof taskID === "string")) {
        args.taskIDs = cleaned
      } else {
        const ids = [...new Set(cleaned.map((taskID: string) => taskID.trim()))]
        if (!hasTaskID) args.taskIDs = ids
        else if (ids.includes(args.taskID.trim())) {
          args.taskIDs = ids
          delete args.taskID
        } else args.taskIDs = ids
      }
    }
  }
  if (action === "follow" && args && typeof args === "object") {
    if (Object.keys(args).some((key) => !["action", "enabled", "expectedRevision"].includes(key))) {
      throw new Error("O4E_FOLLOW_INVALID_ARGUMENTS")
    }
    if (args.enabled !== undefined && (typeof args.enabled !== "boolean"
      || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)) {
      throw new Error("O4E_FOLLOW_INVALID_ARGUMENTS")
    }
    if (args.enabled === undefined && args.expectedRevision !== undefined) {
      throw new Error("O4E_FOLLOW_INVALID_ARGUMENTS")
    }
  }
  validateTaskControlArgs(args)
  validateTaskReadOptions(args)
  if (args?.action === "cancel") return { action: "cancel", taskID: args.taskID.trim() }
  if (args?.action === "inspect") {
    return {
      action: "inspect",
      taskID: args.taskID.trim(),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      direction: args.direction ?? "forward",
      maxBytes: args.maxBytes ?? 1024,
      ...(args.resume !== undefined ? { resume: args.resume } : {}),
      ...(args.ioTimeoutMs !== undefined ? { ioTimeoutMs: args.ioTimeoutMs } : {}),
    }
  }
  if (args?.action === "watch") {
    if (args.timeoutMs > WATCH_MAX_TIMEOUT_MS) {
      throw new Error(`o4e_task watch timeoutMs 必须是 0..${WATCH_MAX_TIMEOUT_MS} 的安全整数`)
    }
    if (args.taskID !== undefined && args.taskIDs !== undefined) throw new Error("o4e_task watch 不能同时提供 taskID 和 taskIDs")
    if (args.taskIDs !== undefined && !Array.isArray(args.taskIDs)) throw new Error("o4e_task watch taskIDs 必须是数组")
    if (Array.isArray(args.taskIDs) && !args.taskIDs.every((taskID: unknown) => typeof taskID === "string" && taskID.trim().length > 0)) {
      throw new Error("o4e_task watch taskIDs 必须只包含非空字符串")
    }
    const taskIDs = Array.isArray(args.taskIDs)
      ? args.taskIDs
          .map((taskID: string) => taskID.trim())
      : []
    if (taskIDs.length === 0 && typeof args.taskID === "string" && args.taskID.trim()) {
      taskIDs.push(args.taskID.trim())
    }
    const timeoutMs = args.timeoutMs > 0 ? args.timeoutMs : undefined
    return {
      action: "watch",
      ...(args.taskIDs !== undefined || taskIDs.length > 0 ? { taskIDs: [...new Set(taskIDs)] } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(args.ioTimeoutMs !== undefined ? { ioTimeoutMs: args.ioTimeoutMs } : {}),
    }
  }
  if (args?.action === "input") {
    if (typeof args.taskID !== "string" || !args.taskID.trim()) throw new Error("o4e_task input 必须提供 taskID")
    if (typeof args.input !== "string" || !args.input) throw new Error("o4e_task input 必须提供非空 input")
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error("o4e_task input 必须提供 expectedRevision")
    if (args.delivery !== undefined && args.delivery !== "queue" && args.delivery !== "steer") throw new Error("o4e_task input delivery 必须是 queue 或 steer")
    return { ...args, taskID: args.taskID.trim(), ...(args.delivery === undefined ? {} : { delivery: args.delivery }) }
  }
  if (args?.action === "resume") {
    if (typeof args.taskID !== "string" || !args.taskID.trim()) throw new Error("o4e_task resume 必须提供 taskID")
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error("o4e_task resume 必须提供 expectedRevision")
    return { ...args, taskID: args.taskID.trim() }
  }
  if (args?.action === "resolve") {
    if (typeof args.taskID !== "string" || !args.taskID.trim()) throw new Error("o4e_task resolve 必须提供 taskID")
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error("o4e_task resolve 必须提供 expectedRevision")
    if (args.decision !== "continue" && args.decision !== "restart" && args.decision !== "stop") {
      throw new Error("o4e_task resolve 必须提供 continue、restart 或 stop decision")
    }
  }
  if (["permission.reply", "question.reply", "question.reject"].includes(args?.action)) {
    // Runtime can infer omitted identifiers when one pending request matches.
    // Explicit malformed revisions remain rejected at the adapter boundary.
    const hasExpectedRevision = args.expectedRevision !== undefined && args.expectedRevision !== null && args.expectedRevision !== ""
    if (hasExpectedRevision && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)) {
      throw new Error(`o4e_task ${args.action} expectedRevision 必须是大于等于 1 的安全整数`)
    }
  }
  if (args?.action === "permission.reply" && !["once", "always", "reject"].includes(args.reply)) {
    throw new Error("o4e_task permission.reply 必须提供 once、always 或 reject reply")
  }
  if (args?.action === "question.reply" && (!Array.isArray(args.answers) || !args.answers.every((answer: unknown) => Array.isArray(answer)))) {
    throw new Error("o4e_task question.reply 必须提供 answers")
  }
  return args
}

const agentTaskArgs = {
  description: tool.schema.string().min(1).describe("Short UI label for the delegated task"),
  prompt: tool.schema.string().min(1).describe("Complete bounded instruction for the delegated Agent"),
  subagent_type: tool.schema.string().min(1).describe("Legal Agent ID; use subagent_type, not agent"),
  command: tool.schema.string().optional(),
  background: tool.schema.boolean().optional().describe("Omit for normal background execution; set false only when the user explicitly requests synchronous or foreground delegation"),
  plan: tool.schema.boolean().optional(),
  permissionOverlay: tool.schema.record(tool.schema.string(), tool.schema.enum(["ask", "deny"])).optional().describe("Temporary restrictions only: ask/deny cannot grant a permission the target Agent lacks. Use OpenCode permission names without a functions. prefix and edit to restrict apply_patch"),
  writeScopes: tool.schema.array(tool.schema.string()).optional(),
}
const agentTaskSchema = tool.schema.object(agentTaskArgs)

export function normalizeAgentTaskArgs(args: any): any {
  // The host's JSON Schema advertisement does not guarantee plugin input validation.
  const parsed = agentTaskSchema.safeParse(args)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => {
      const field = issue.path[0]
      return typeof field === "string" && Object.hasOwn(agentTaskArgs, field) ? field : "input"
    }))]
    throw Object.assign(new Error(`O4E_TASK_INVALID_ARGUMENTS: invalid or missing ${fields.join(", ")}. Required: description, prompt, subagent_type. No delegation was started; supply an explicit subagent_type, not agent.`), {
      code: "O4E_TASK_INVALID_ARGUMENTS",
    })
  }
  args = parsed.data
  return {
    task: args.prompt,
    description: args.description,
    agent: args.subagent_type,
    plan: args.plan === true ? true : undefined,
    permissionOverlay: normalizeTaskPermissionOverlay(args.permissionOverlay),
    writeScopes: args.writeScopes,
    trace: args.command ? { command: args.command } : undefined,
  }
}

// Fill-all models always send background:false together with every other
// optional field at its default (plan:false, empty command/writeScopes/
// permissionOverlay). That combination is adapter noise, not an explicit
// foreground request; only a selective background:false opts into synchronous
// delegation. Misreading the noise would silently force every delegation
// into the foreground.
export function isExplicitForegroundDelegation(args: any): boolean {
  if (args?.background !== false) return false
  const filledDefaultsOnly = args.plan === false
    && (args.command === undefined || args.command === "")
    && (args.writeScopes === undefined || (Array.isArray(args.writeScopes) && args.writeScopes.length === 0))
    && (args.permissionOverlay === undefined
      || (typeof args.permissionOverlay === "object" && args.permissionOverlay !== null
        && !Array.isArray(args.permissionOverlay) && Object.keys(args.permissionOverlay).length === 0))
  return !filledDefaultsOnly
}

const TASK_PERMISSION_OVERLAY_ALIASES = Object.freeze({
  "functions.apply_patch": "edit",
  "functions.write": "edit",
  "functions.bash": "bash",
})

export function normalizeTaskPermissionOverlay(overlay: unknown): unknown {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return overlay
  const source = overlay as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const [name, action] of Object.entries(source)) {
    const permissionName = TASK_PERMISSION_OVERLAY_ALIASES[name as keyof typeof TASK_PERMISSION_OVERLAY_ALIASES]
    if (!permissionName || (action !== "ask" && action !== "deny")) {
      normalized[name] = action
      continue
    }
    if (Object.hasOwn(source, permissionName)) continue
    normalized[permissionName] = normalized[permissionName] === "deny" || action === "deny" ? "deny" : action
  }
  return normalized
}

async function publishTaskMetadata(context: any, { child, prepared, background }: any): Promise<void> {
  const model = normalizeModelRefs(prepared.modelCandidates ?? [])[0]
  const update = context.metadata?.({
    title: prepared.args.description ?? prepared.args.task.slice(0, 80),
    metadata: {
      parentSessionId: context.sessionID,
      sessionId: child.id,
      ...(model ? { model } : {}),
      ...(background ? { background: true } : {}),
    },
  })
  if (Effect.isEffect(update)) await Effect.runPromise(update)
}

async function publishToolMetadata(context: any, value: any): Promise<void> {
  context.abort?.throwIfAborted()
  const update = context.metadata?.(value)
  if (Effect.isEffect(update)) await Effect.runPromise(update, { signal: context.abort })
  else await update
}

function displayAgentName(agent: unknown): string {
  if (typeof agent !== "string" || !agent) return "Background"
  return agent.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ")
}

const TOOL_RESULT_METADATA_KEY = "o4eResult"

function resultMetadata(result: any, extra: Record<string, any> = {}): Record<string, any> {
  return { ...extra, [TOOL_RESULT_METADATA_KEY]: result }
}

function interactionLines(result: any): string[] {
  const lines: string[] = []
  if (Number.isSafeInteger(result.revision)) lines.push(`Expected revision: ${result.revision}`)
  if (Array.isArray(result.pendingRequests) && result.pendingRequests.length > 0) {
    lines.push("Pending requests:", JSON.stringify(result.pendingRequests, null, 2))
  }
  if (result.retryDecision?.status === "pending") {
    lines.push(`Retry decision required${result.retryDecision.reason ? `: ${result.retryDecision.reason}` : result.retryDecision.error ? `: ${result.retryDecision.error}` : "."}`)
  }
  return lines
}

function readableTaskOutput(result: any, action: string): string {
  if (action === "output") {
    const body = result.output ?? ""
    return result.truncated || result.outputTruncated ? `[Output truncated.]\n\n${body}` : body
  }
  if (action === "watch") {
    const tasks = Array.isArray(result.tasks) ? result.tasks : []
    const lines = [statusLine(`Watch${result.reason ? ` · ${result.reason}` : ""}`, result, { reason: false })]
    tasks.forEach((task, index) => lines.push("", watchTaskText(task, index)))
    if (result.userMessage) lines.push("", "A newer user message is waiting; handle it before watching again.")
    return lines.join("\n")
  }
  if (action === "inspect") return inspectionText(result)
  if (action === "pending" && Array.isArray(result.tasks)) {
    const lines = ["Pending Task interactions"]
    result.tasks.forEach((task: any, index: number) => {
      lines.push("", ...previewLines(task, index), ...interactionLines(task))
    })
    if (result.tasks.length === 0) lines.push("(none)")
    if (result.supported === false) lines.push("Host interaction inspection is unavailable.")
    return lines.join("\n")
  }
  const task = result.taskID ? `Task ${result.taskID}` : "Task"
  const lines = [statusLine(`${task} ${action}`, result)]
  if (["waiting_permission", "waiting_question", "waiting_retry_decision"].includes(result.status)
    || ["input", "resolve", "permission.reply", "question.reply", "question.reject"].includes(action)) {
    lines.push(...interactionLines(result))
  }
  if (result.inputDelivery) {
    lines.push(result.inputDelivery.mode === "steer"
      ? "Input admitted for the next runnable turn."
      : `Input queued for ${result.inputDelivery.boundary ?? "the next dispatch"}.`)
  }
  if (typeof result.diagnostic === "string") lines.push(`Diagnostic: ${result.diagnostic}`)
  if (Array.isArray(result.diagnostics) && result.diagnostics.length > 0) {
    lines.push(`Diagnostics: ${result.diagnostics.map((entry: any) => entry?.code ?? String(entry)).join(", ")}`)
  }
  if (action !== "status" && typeof result.output === "string") {
    lines.push("", result.output || "(no output)")
  }
  if (result.truncated) lines.push("[Output truncated; retained view only. Use inspect to page the retained output.]")
  if (result.supported === false) lines.push("Interactive requests are not supported for this Task kind.")
  return lines.join("\n")
}

function validateWatchToolResult(result: any) {
  // Receipt acknowledgement can advance revisions. Reserve their maximum width
  // before committing, without changing any result body or pagination position.
  const reserved = { ...result, tasks: result.tasks.map((task: any) => ({
    ...task, ...(task.revision === undefined ? {} : { revision: Number.MAX_SAFE_INTEGER }),
  })) }
  if (Buffer.byteLength(readableTaskOutput(reserved, "watch")) > OUTPUT_LIMITS.hostResultBytes
    || Buffer.byteLength(JSON.stringify(reserved)) > OUTPUT_LIMITS.hostResultBytes) {
    throw new Error("O4E_TASK_OUTPUT_TOO_LARGE: select fewer taskIDs per watch; terminal receipts were not acknowledged by this call")
  }
}

function taskToolResult(output: string, action: string, extraMetadata: Record<string, any> = {}, detail = false) {
  const result = JSON.parse(output)
  const title = action === "watch" ? watchToolTitle(Array.isArray(result.tasks) ? result.tasks : [], result.reason)
    : `${result.kind === "command" ? "Command" : "Background Task"} ${action} · ${result.status ?? "ok"}`
  const readable = readableTaskOutput(result, action)
  if (Buffer.byteLength(readable) > OUTPUT_LIMITS.hostResultBytes || Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMITS.hostResultBytes) {
    throw new Error("O4E_TASK_OUTPUT_TOO_LARGE")
  }
  return presentTaskResult({ title, output: readable, metadata: resultMetadata(result, extraMetadata) }, action, detail)
}

const O4E_TASK_DESCRIPTION = "Manage durable Agent and Bash Tasks. By default action=watch monitors all owned Agent and command Tasks together, freezing membership at entry. Omit selectors normally; taskID/taskIDs explicitly narrow the set and may mix kinds, while taskIDs:[] selects nothing. Watch returns only status, never output or progress text; it wakes for any new terminal or actionable event, a persisted user message, or the fixed timeout (reason=heartbeat; 30 minutes by default, maximum one hour). Previously delivered events do not repeatedly wake it; empty means all selected terminal events have already been reported. User-message and reader abort interrupt waiting without cancelling execution. Report meaningful status before watching again. Use status for details, exit codes and diagnostics. Use output with one taskID to actually read content: completed Agent result or the current retained Bash text, without Task/Watch status wrappers; repeated output calls reread content. A content read is not completion. Inspect provides bounded incremental tails with cursor/resume; it does not determine completion. Completed Bash already returns captured text; background Bash returns a taskID. The original Shell card continues accumulating user-visible output without sending it to the model. Output truncation or incomplete logs are explicit; full private logs at logPath can be paged through authorized file tools. Agent input defaults to durable next-turn queue; set delivery:steer to admit input for the next runnable turn when the host supports it, otherwise the input is queued. Use resume with a current expectedRevision to wake safely dispatchable queued/retry/pending-input work; use cancel for explicit termination. Leave Agent permission/question requests pending for the user in OpenCode's native root-session prompt. Report the wait and pause; use pending plus a reply/reject action only when the user explicitly asks you to handle that request on their behalf. Permissions and ownership apply per Task kind. Configured delegated Agents may create and manage their own next-level Tasks; they cannot manage their parent or sibling Tasks. Native keep callers may manage only their own commands."


function commandToolResult(snapshot: any, action: string) {
  const keys = ["taskID", "kind", "status", "revision", "phase", "stopped", "output", "totalBytes", "truncated",
    "exitCode", "sha256", "reason", "diagnostic", "logPath", "logBytes", "logComplete", "logError",
    "tasks", "tail", "cursor", "beforeCursor", "unchanged", "unavailable", "gap", "pending", "supported"]
  const result = Object.fromEntries(keys.filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]]))
  // JSON escaping can expand the retained output. Bound recovery metadata
  // independently of both the model body and the full native Shell display.
  const outputHolder = typeof result.output === "string" ? result : undefined
  const structuredLimit = action === "execute" ? OUTPUT_LIMITS.executeMetadataBytes : OUTPUT_LIMITS.taskMetadataBytes
  while (outputHolder && Buffer.byteLength(JSON.stringify(result)) > structuredLimit) {
    const previous = outputHolder.output
    outputHolder.output = truncateUtf8Tail(previous, Math.floor(Buffer.byteLength(previous) / 2)).text
    if (outputHolder.output === previous) break
    outputHolder.truncated = true
    outputHolder.outputView = "bounded-tail; use inspect for retained output"
  }
  if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMITS.hostResultBytes) throw new Error("O4E_COMMAND_OUTPUT_TOO_LARGE")
  const metadata: Record<string, any> = resultMetadata(result, { taskID: snapshot.taskID, kind: "command", status: snapshot.status })
  if (action === "execute" && ["queued", "running"].includes(snapshot.status)) {
    return { title: `Command ${action}: ${snapshot.status}`, output: commandControlLines(snapshot).join("\n"), metadata }
  }
  if (action === "execute" || action === "output") {
    // JSON escaping and the duplicate Shell-card metadata must not shorten the
    // model's captured text. Bound its own view independently below the supported
    // host's 50 KiB / 2000-line truncator, leaving room for control information.
    const visible = { ...snapshot, output: snapshot.output ?? "" }
    if (Buffer.byteLength(visible.output) > OUTPUT_LIMITS.modelBytes) {
      visible.output = truncateUtf8Tail(visible.output, OUTPUT_LIMITS.modelBytes).text
      visible.truncated = true
    }
    const lineBound = truncateLinesTail(visible.output, OUTPUT_LIMITS.modelLines)
    if (lineBound.truncated) {
      visible.output = lineBound.text
      visible.truncated = true
    }
    const control = commandControlLines(visible, action === "output")
    // The host may truncate from the head. Keep failure/archive evidence before
    // the text; the blank line separates controls from the captured body.
    return { title: `Command ${action}: ${snapshot.status}`,
      output: control.length ? `${control.join("\n")}\n\n${visible.output}` : visible.output, metadata }
  }
  if (action === "inspect") return { title: `Command ${action}: ${snapshot.status}`, output: inspectionText(result, "command"), metadata }
  const control = commandControlLines(result)
  return { title: `Command ${action}: ${snapshot.status}`,
    output: [...control, readableTaskOutput(result, action)].join("\n"), metadata }
}

function shortTaskID(taskID: unknown): string {
  if (typeof taskID !== "string") return "unknown"
  return taskID.replace(/^o4e_(task|command)_/, "").slice(0, 8)
}

function watchToolTitle(tasks: any[], reason: string): string {
  const suffix = reason === "heartbeat" ? " · heartbeat" : reason === "user-message" ? " · user message" : ""
  if (tasks.length !== 1) {
    const counts = new Map<string, number>()
    for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
    const statuses = [...counts].map(([status, count]) => `${count} ${status}`).join(", ")
    return `${tasks.length} Background Tasks${statuses ? ` · ${statuses}` : ""}${suffix}`
  }
  const task = tasks[0]
  const label = task.kind === "command" ? "Command" : `${displayAgentName(task.agent)} Task`
  return `${label} ${shortTaskID(task.taskID)} · ${task.status}${task.phase ? ` · ${task.phase}` : ""}${suffix}`
}

function backgroundTaskNotice(tasks: any[], language: unknown): string {
  const visible = tasks.map((task) => ({
    taskID: task.taskID,
    agent: task.agent,
    status: task.status,
    phase: task.phase,
    updatedAt: task.updatedAt,
  }))
  if (language === "en") {
    return `O4E Background Task continuation notice:\nThis parent Session still owns unfinished Tasks from an earlier turn. The new user message remains authoritative. Do not create duplicate Tasks. Report status when relevant; unless the user explicitly asks to cancel or abandon them, continue tracking relevant Tasks with o4e_task watch, and call o4e_task output for each completed Task before summarizing dependent results. A heartbeat or running status is not completion.\n${JSON.stringify(visible, null, 2)}`
  }
  return `O4E Background Task 继续跟踪提示：\n当前父 Session 仍有前序回合未结束的 Task。新的用户消息始终是当前指令，不要创建重复 Task。相关时先报告状态；除非用户明确要求取消或放弃，否则继续使用 o4e_task watch 跟踪，并在 Task completed 后调用 o4e_task output，再汇总依赖其结果的答复。heartbeat 或运行中状态不代表完成。\n${JSON.stringify(visible, null, 2)}`
}

function backgroundTaskAutomaticContinuation(tasks: any[], receipts: any[], language: unknown): string {
  const visible = tasks.map((task) => ({
    taskID: task.taskID,
    agent: task.agent,
    status: task.status,
    phase: task.phase,
    revision: task.revision,
  }))
  const terminal = receipts.map((receipt) => ({
    receiptID: receipt.receiptID,
    taskID: receipt.taskID,
    status: receipt.status,
    phase: receipt.phase,
  }))
  if (language === "en") {
    return `O4E Background Task automatic continuation:\nThis is a synthetic Runtime turn, not a new user request. Process the pending terminal receipts and continue tracking any unfinished Tasks without creating duplicates. For completed Tasks, read output before summarizing. If explicit user input or a retry decision is required, ask once and wait for the user. A real user message always has priority.\n${JSON.stringify({ tasks: visible, receipts: terminal }, null, 2)}`
  }
  return `O4E Background Task 自动续接：\n这是 Runtime 生成的 synthetic 回合，不是新的用户请求。处理待投递的终态回执，并继续跟踪尚未结束的 Task，不要创建重复 Task。Task completed 后先读取 output 再汇总；需要用户显式输入或 retry 决策时，只询问一次并等待用户。真实用户消息始终优先。\n${JSON.stringify({ tasks: visible, receipts: terminal }, null, 2)}`
}

function backgroundTaskReceiptNotice(receipts: any[], language: unknown): string {
  if (language === "en") {
    return `O4E Background Task terminal receipts:\nThese receipts are delivered at least once and may repeat after interruption. Deduplicate by receiptID. The new user message remains authoritative. Use o4e_task output only for completed Tasks whose output is needed.\n${JSON.stringify(receipts, null, 2)}`
  }
  return `O4E Background Task 终态回执：\n这些回执采用至少一次投递，中断后可能重复；请按 receiptID 去重。新的用户消息始终是当前指令。仅在需要 completed Task 的结果时调用 o4e_task output。\n${JSON.stringify(receipts, null, 2)}`
}

function backgroundTaskRequestNotice(tasks: any[], language: unknown): string {
  const visible = tasks.map((task) => ({
    taskID: task.taskID,
    revision: task.revision,
    status: task.status,
    pendingRequests: task.pendingRequests,
  }))
  if (language === "en") {
    return `O4E Background Task interaction requests:\nLet the user handle these permission/question requests in OpenCode's native root-session prompt. Report the waiting state and leave the requests pending; do not duplicate questions or answer automatically. Only when the user explicitly asks you to handle a specific request on their behalf, call o4e_task action:"pending" to refresh it, then use permission.reply, question.reply, or question.reject with that expectedRevision. A task goal, a known answer, or a generic instruction to continue is not authorization to reply.\n${JSON.stringify(visible, null, 2)}`
  }
  return `O4E Background Task 等待交互：\n以下 permission/question 请求默认由用户在 OpenCode 根会话的原生提示中处理。报告等待状态并保留原请求，不重复提问或主动代答。只有用户明确要求代为处理某个请求时，才先调用 o4e_task action:"pending" 刷新请求，再携带该 expectedRevision 使用 permission.reply、question.reply 或 question.reject。任务目标、已知答案或笼统的“继续”不等于代操作授权。\n${JSON.stringify(visible, null, 2)}`
}

function agentTaskResult(output: string, { description, background, parentSessionId }: { description: string; background: boolean; parentSessionId: string }) {
  let result: any = {}
  try {
    result = JSON.parse(output)
  } catch {
    return { title: description, output }
  }
  const action = background ? "start" : "execute"
  const readable = readableTaskOutput(result, action)
  if (Buffer.byteLength(readable) > OUTPUT_LIMITS.hostResultBytes || Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMITS.hostResultBytes) {
    throw new Error("O4E_TASK_OUTPUT_TOO_LARGE")
  }
  return {
    title: description,
    output: readable,
    metadata: {
      parentSessionId,
      ...(typeof result.sessionID === "string" && result.sessionID ? { sessionId: result.sessionID } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.taskID ? { taskID: result.taskID } : {}),
      ...(background ? { background: true } : {}),
      [TOOL_RESULT_METADATA_KEY]: result,
    },
  }
}

export function resolveSessionDirectory(directory?: string, worktree?: string): string {
  return canonicalDirectoryKey(directory || worktree || process.cwd())
}

/** O4E is enabled by default; origin returns the original host and clear removes runtime model selection. Unsupported values fall back to default with a diagnostic (CFG-008). */
export { resolveO4eMode }
export function invalidO4eModeValue(env = process.env): string | undefined {
  return findInvalidO4eModeValue(env)
}

function cleanDisabledAgentProjection(config: any, directory?: string): void {
  if (!config || typeof config !== "object" || !config.agent || typeof config.agent !== "object") return
  for (const [name, value] of Object.entries(config.agent)) {
    let serialized
    try { serialized = JSON.stringify(value) } catch { continue }
    if (MARKER_RE.test(serialized) || SYSTEM_AGENT_MARKER_RE.test(serialized)) {
      delete config.agent[name]
      if (config.default_agent === name) delete config.default_agent
    }
  }
  const roots = new Set<string>([
    join(resolve(directory || process.cwd()), ".opencode", "agents"),
    join(homedir(), ".config", "opencode", "agents"),
  ])
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg)) roots.add(join(xdg, "opencode", "agents"))
  if (process.env.o4e_config) {
    const configured = process.env.o4e_config === "~"
      ? homedir()
      : process.env.o4e_config.startsWith("~/") ? join(homedir(), process.env.o4e_config.slice(2)) : process.env.o4e_config
    if (isAbsolute(configured)) roots.add(join(dirname(resolve(configured)), "agents"))
  }
  for (const agentsRoot of roots) {
    let files: string[]
    try { files = readdirSync(agentsRoot).filter((file) => file.endsWith(".md")) } catch { continue }
    for (const file of files) {
      let source
      try { source = readFileSync(join(agentsRoot, file), "utf8") } catch { continue }
      const marker = source.match(MARKER_RE) ?? source.match(SYSTEM_AGENT_MARKER_RE)
      if (!marker) continue
      delete config.agent[marker[1]]
      if (config.default_agent === marker[1]) delete config.default_agent
    }
  }
}

function readRuntimeDefinition(directory: string | undefined, configuredRoot: string, explicitConfig: boolean): ({ configRoot: string } & ReturnType<typeof loadRuntimeDefinition>) | null {
  for (const { configRoot, scope } of runtimePaths(directory, configuredRoot, explicitConfig)) {
    if (!configRootExists(configRoot, scope)) continue
    try {
      return { configRoot, ...loadRuntimeDefinition(configRoot) }
    } catch (error) {
      throw new Error(`${scope === "project" ? "项目" : "全局"}配置加载失败: ${configRoot} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return null
}

function runtimeAgentFromDefinition(agent: RuntimeDefinition["runtimeAgents"][number]): AgentRuntime {
  return { ...agent, models: normalizeModelRefs([agent.model, ...agent.fallbackModels]) }
}

function systemAgentFromDefinition(agent: RuntimeDefinition["systemPhaseAgents"][number]): SystemPhaseAgentRuntime {
  return {
    ...agent,
    base: "",
  }
}

function readInject(configRoot: string, name: string, promptDir: string): string | null {
  return readPromptFile(resolve(configRoot, promptDir, `${name}.md`), configRoot)
}

function buildPrompt(entry: PromptRuntime, configRoot: string, instructionRoots: { projectRoot: string }, runtimeProtocol = ""): string | null {
  let systemPrompt: string | undefined
  if (entry.systemPrompt) {
    const content = readInject(configRoot, entry.systemPrompt, entry.promptDir)
    if (!content) return null
    systemPrompt = content
  }
  const injects: Array<{ name: string; content: string }> = []
  for (const inject of entry.injects) {
    const content = readInject(configRoot, inject, entry.promptDir)
    if (!content) return null
    injects.push({ name: inject, content })
  }
  const instructions = formatInstructionFiles(loadInstructionFiles(entry.instructionFiles, instructionRoots))
  return assemblePrompt({
    base: entry.base,
    systemPrompt,
    injects,
    instructions: [runtimeProtocol, instructions].filter(Boolean).join("\n\n"),
  })
}

function nativeSystemParts(entry: PromptRuntime, configRoot: string): string[] | null {
  if (!entry.nativeSystem?.length) return null
  const parts: string[] = []
  for (const name of entry.nativeSystem) {
    const content = readInject(configRoot, name, entry.promptDir)
    if (content === null) return null
    parts.push(content)
  }
  return parts
}

function buildNativePrompt(entry: PromptRuntime, configRoot: string, source: string, marker: string, instructionRoots: { projectRoot: string }, runtimeProtocol = ""): string | null {
  const parts = nativeSystemParts(entry, configRoot)
  if (!parts) return null
  const instructions = formatInstructionFiles(loadInstructionFiles(entry.instructionFiles, instructionRoots))
  return assembleNativePrompt({
    nativeSystem: parts,
    source,
    marker,
    instructions: [runtimeProtocol, instructions].filter(Boolean).join("\n\n"),
  })
}

function canStartManagedTask(entry: AgentRuntime, agents: AgentRuntime[]): boolean {
  if (!["primary", "all", "subagent"].includes(entry.type)) return false
  const permission = effectiveAgentPermission(entry, { agents })
  return legalAgentCandidates({ requester: entry, agents }).some((candidate) => (
    permissionAction(permission, AGENT_TASK_TOOL, candidate.id) !== "deny"
  ))
}

function backgroundTaskProtocol(entry: AgentRuntime, agents: AgentRuntime[], language: unknown): string {
  if (!canStartManagedTask(entry, agents)) return ""
  if (language === "en") {
    return `${BACKGROUND_TASK_PROTOCOL_MARKER}
# O4E Background Task Protocol

- Bash creates command Tasks without delegation. Successful completion within the default 10-second running window returns captured text exactly, including empty output; nonzero exits and read-integrity problems have separate minimal controls. Otherwise Bash returns a taskID without partial content; use o4e_task output to read it. The original Shell card continues accumulating user-visible text after detachment without injecting it into the model context (256 MiB limit, explicitly marked if exceeded). Admission wait is about 1 second, separate from the running window and execution timeout. Logs are private outside the repository with 24-hour retention after settlement and active-log protection; use authorized file reads for logPath, and heed logComplete/logError. Root idle and reader abort preserve detached commands; cancellation, owner deletion, child termination and disposal still stop them. Capture is decoded text, not terminal emulation, binary fidelity or a global ordering guarantee across stdout/stderr.
- Use the managed \`task\` as the sole normal delegation entry. If its arguments, permission, or Runtime checks fail, correct that \`task\` call or report the error; do not probe alternate delegation tools. Always omit \`background\` for normal delegation so Runtime starts a background Task. Use \`background:false\` only when the user explicitly requests synchronous or foreground delegation; dependency on the result is not sufficient.
- Preserve every returned \`taskID\`. You may continue work that does not depend on the result.
- Default watch freezes all owned Agent and Bash Tasks together and returns only status. Any new terminal or actionable event returns immediately. Agent terminal receipts acknowledge status delivery, not result content; command events and Agent waits use verifiable prior public tool responses for deduplication. Unchanged events keep waiting; empty means all selected terminal events have already been reported. Missing reliable evidence allows repeats. One event does not imply group completion. User messages, reader abort and the fixed deadline still interrupt waiting.
- Before a dependent action or final response, call \`o4e_task\` with \`action:"watch"\`. Normally omit selectors to freeze all owned Agent and Bash Tasks together, or pass \`taskID\`/\`taskIDs\` for an explicit dependency set; \`taskIDs:[]\` selects nothing. Omit \`timeoutMs\` for the normal event-driven wait with a 30-minute default window (zero also uses this default); a positive explicit timeout selects a window up to one hour. The deadline is fixed, with no watch backoff. Actionable Task changes or a persisted real user message wake it earlier. After \`reason:"heartbeat"\` or another actionable result, first report a meaningful current status to the user before calling the next \`watch\`; then continue watching pending dependencies as needed. Read completed output before reporting it, and prioritize a real user message and terminal or explicit-wait states over heartbeat progress. Runtime does not synthesize heartbeat progress messages, and intermediate TUI visibility is host-dependent. A heartbeat is not a result and does not cancel or restart a Task.
- Every Agent Task model error retains its cause and enters actionable \`waiting_retry_decision\`; O4E never automatically retries the model or switches to a fallback. Classification and frozen fallback candidates are diagnostic only. The owning main Agent reads the latest revision and explicitly chooses \`resolve continue|restart|stop\` within existing authority. Continue/restart still revalidate authorization, CAS, cancellation, Attempt, Scope Lock and side-effect boundaries; do not ask the user again merely for that choice when already authorized. Provider-internal retries are outside the plugin boundary and cannot be controlled by O4E.
- watch/status provide states, exit codes and diagnostics; output provides content without status headers and actually reads it on every call. Watch never reads heartbeat tails or completed bodies. Use inspect for incremental preview pagination and resume; watch accepts no output cursors or resume.
- Use \`action:"inspect"\` with a required \`taskID\` for a read-only recent tail; inspect rejects \`taskIDs\`, \`cursors\` and \`timeoutMs\`. Use an optional nonempty \`cursor\` (at most 512 characters) with \`direction:"forward"\` (default) or \`"backward"\`. Agent cursors use the current compact format, at most 120 characters; other formats are rejected. \`maxBytes\` is a safe integer from 4 to 8192, default 1024. Visible progress is limited to public assistant text, tool name/status, and safe workspace-relative summaries for \`read\` filePath and bounded \`glob\`/\`grep\` path/pattern; sensitive, external, URL/query-like, malformed, oversized, and unknown-tool arguments remain hidden. The compact result contains \`taskID\`/\`status\`, available \`tail\`/\`cursor\`, and optional \`unchanged\`/\`unavailable\`/\`gap\`; \`beforeCursor\` is provided only when earlier data exists. Cursors contain no summary text and are not authorization. Inspect never consumes a receipt or determines completion; final results still require \`output\`. Each preview reads at most 5 pages of 20 messages, without caches or all-history fallback; this does not bound SDK downloads of a giant message or its Parts.
- If \`watch\` returns \`reason:"user-message"\`, handle the newest real user instruction first. This does not cancel or complete any Task; resume the relevant Task Group afterward unless the user explicitly changes that intent.
- For each \`completed\` Task, call \`o4e_task\` with \`action:"output"\` and summarize only the retrieved output. Never report \`failed\`, \`cancelled\`, \`unknown\`, or \`interrupted\` as success. Handle actionable waiting or retry states explicitly, and ask the user when safe resolution requires their decision.
- Do not finish while the current answer still depends on an uncollected background Task. Workflow process-v1 is main-Agent checkpoint coordination, not background execution; use managed \`task\` only for bounded, independently useful subtasks.
- Leave child permission/question requests for the user in OpenCode's native root-session prompt. Report the wait and pause instead of repeating watch, duplicating questions, or answering automatically. Use pending and the matching reply/reject action only when the user explicitly asks you to handle that request on their behalf; task goals, known answers and generic instructions to continue do not grant that authority.
- A configured delegated Agent may use task within the top-level maxDelegationDepth (default 2, integer range 1..5), and o4e_task to manage only Tasks it owns. Root depth is 0; each Agent task adds 1. Main-Session Workflow Steps do not add delegation depth. At the limit, act directly or report the help needed to the caller. Do not change configuration yourself to bypass the limit. Every launch still requires host authorization and retains ancestor permission, Effect and scope limits. Handle permission/question prompts in the original root Session. Workflow entry remains limited to managed primary/all root Sessions.`
  }
  return `${BACKGROUND_TASK_PROTOCOL_MARKER}
# O4E 后台 Task 协议

- Bash 不经委派创建 command Task。默认 running 窗口 10 秒内成功结束直接返回捕获文本（包括空输出），非零退出和读取完整性问题使用分隔的最短控制行。否则只返回 taskID，不附部分正文；使用 o4e_task output 读取内容。原 Shell 卡片在转后台后继续累积用户可见的输出，不注入模型上下文（上限 256 MiB，超限明确标记）。admission 等待约 1 秒，与 running 窗口、execution timeout 独立。日志位于仓库外私有目录，终态起保留 24 小时，活动日志受保护；通过获准文件工具分段读取 logPath，注意 logComplete/logError。root idle 和 reader abort 保留脱离的命令；取消、owner 删除、child 生命周期终止和 disposal 仍会停止命令。捕获是解码文本，不承诺终端仿真、二进制保真或 stdout/stderr 的真实全局顺序。
- 日常委派只使用受管 \`task\`。参数、权限或 Runtime 检查失败时，应修正该 \`task\` 调用或报告错误，不得探测其他委派工具。日常委派必须省略 \`background\`，由 Runtime 启动后台 Task；只有用户明确要求同步或前台委派时才使用 \`background:false\`，依赖子结果本身不是使用前台模式的理由。
- 保存每个返回的 \`taskID\`；等待期间可以继续完成不依赖该结果的工作。
- 默认 watch 在入口冻结当前 owner 全部 Agent 和 Bash Task，只返回状态。任一新终态或需处理事件立即返回。Agent 终态 receipt 确认状态交付，不代表已读正文；command 事件和 Agent 等待事件根据可信公开工具响应去重。相同事件继续等待，没有未处理的所选事件时返回 empty，缺失可靠证据允许重报。单个事件不表示全组完成。用户消息、reader abort 和固定 deadline 仍可中断等待。
- 执行依赖动作或提交最终答复前，调用 \`o4e_task\` 的 \`action:"watch"\`。通常省略 selector，冻结 owner 当前全部 Agent 和 Bash Task 集合；传 \`taskID\` 或 \`taskIDs\` 可显式选择依赖，\`taskIDs:[]\` 明确选择空集。正常事件等待省略 \`timeoutMs\`，默认等待窗口 30 分钟，传 0 也使用该默认值；正数显式 timeout 可以指定最长 1 小时的窗口。deadline 固定，不做 watch 退避。可操作 Task 变化或已持久化的真实用户消息会提前唤醒。返回 \`reason:"heartbeat"\` 或其他可操作结果后，必须先向用户报告有意义的当前状态，再调用下一次 \`watch\`，并按需继续跟踪尚未完成的依赖。completed 先读取 output 再报告；真实用户消息以及终态或显式等待状态优先于 heartbeat 进度。Runtime 不为 heartbeat 自动生成合成进度消息，中间文本是否在 TUI 可见取决于宿主。heartbeat 不是结果，也不会取消或重启 Task。
- Agent Task 的任何模型错误都会保留原因并进入可操作的 \`waiting_retry_decision\`；O4E 不自动模型重试或自动切换 fallback。错误分类和冻结候选只作诊断。拥有 Task 的主 Agent 读取最新 revision，并在既有授权内显式选择 \`resolve continue|restart|stop\`。continue/restart 仍复核授权、CAS、取消、Attempt、Scope Lock 和副作用边界；已获授权时不要仅为该选择再次询问用户。宿主 provider 内部重试位于插件边界之外，O4E 无法控制。
- watch/status 专门报告状态、退出码和诊断；output 专门读取正文，不加状态标题，每次调用都实际读取。watch 不读取 heartbeat tail 或终态正文。需要增量预览和续读时使用 inspect；watch 不接受输出游标或 resume。
- 使用 \`action:"inspect"\` 和必填 \`taskID\` 只读查看近期 tail，不接受 \`taskIDs\`、\`cursors\` 或 \`timeoutMs\`；可选非空 \`cursor\` 最多 512 字符，\`direction\` 为默认 \`"forward"\` 或 \`"backward"\`。Agent 游标只接受当前紧凑格式，最多 120 字符。\`maxBytes\` 必须是 4..8192 的安全整数，默认 1024。可见进度仅限已验证当前 dispatch/compaction lineage 的公开 assistant 文本、工具名称/状态，以及 \`read\` 的工作区相对 filePath 和有界 \`glob\`/\`grep\` path/pattern 安全摘要；敏感、外部、URL/query-like、畸形、超长和未知工具参数保持隐藏。紧凑结果包含 \`taskID\`/\`status\`、可用的 \`tail\`/\`cursor\` 及可选 \`unchanged\`/\`unavailable\`/\`gap\`；仅在存在更早数据时提供 \`beforeCursor\`。游标不含摘要正文且不是授权。inspect 不消费回执、不判断完成；最终结果仍须使用 \`output\`。每次预览最多读取 5 页、每页 20 条消息，不使用缓存或全历史回退；这不限制 SDK 下载超大单条消息及其 Parts 的字节量。
- 若 \`watch\` 返回 \`reason:"user-message"\`，先处理最新真实用户指令。该结果不会取消或完成任何 Task；除非用户明确改变意图，处理后继续跟踪相关 Task Group。
- 每个 \`completed\` Task 都要调用 \`o4e_task\` 的 \`action:"output"\`，并且只汇总实际读取的输出。不得把 \`failed\`、\`cancelled\`、\`unknown\` 或 \`interrupted\` 表述为成功；等待处理或 retry 状态必须显式处理，需要用户安全决策时应请求确认。
- 当前答复仍依赖尚未收集的后台 Task 时不得结束。Workflow process-v1 是主 Agent 检查点协调，不是后台执行；只对边界清晰且结果可独立使用的子任务调用受管 \`task\`。
- 子 Agent 的 permission/question 默认交由用户在 OpenCode 根会话原生提示中处理；报告等待并暂停，不反复 watch、重复提问或主动代答。只有用户明确要求代操作某个请求时，才使用 pending 和对应 reply/reject；任务目标、已知答案或笼统的“继续”不等于授权。
- 已配置委派能力的子 Agent 可在顶层 maxDelegationDepth 内通过 task 委派，并用 o4e_task 只管理自己拥有的 Task；默认深度上限为 2，只接受 1..5 的整数。根深度为 0，每次 Agent task 加 1；Workflow 主会话 Step 不增加委派深度。达到上限时直接处理或向调用者报告所需帮助。不要为绕过限制自行修改配置。每次启动仍须经过宿主授权，并保留祖先权限、Effect 和范围限制。permission/question 在最初根会话的原生提示中处理；Workflow 入口仍仅限受管 primary/all 根会话。`
}

function workspaceContext(language: unknown, workspaceDirectory: string, projectRoot: string): string {
  if (language === "en") {
    return `# O4E Workspace Context

- The current workspace directory is \`${workspaceDirectory}\`. Treat it as the default working directory for file and command operations. An omitted Bash \`workdir\` uses this directory; a relative \`workdir\` is resolved from it. Use an explicit \`workdir\` only when the user requests another directory.
- The repository/project instruction root is \`${projectRoot}\`. Keep repository rules and the active workspace directory distinct when they differ.`
  }
  return `# O4E Workspace Context

- 当前 workspace 目录是 \`${workspaceDirectory}\`。文件和命令操作默认使用此目录；Bash 省略 \`workdir\` 时使用此目录，相对 \`workdir\` 也从此目录解析。只有用户要求其他目录时才使用显式 \`workdir\`。
- 仓库/项目规则根目录是 \`${projectRoot}\`。两者不同时必须保持规则根与当前工作目录的区别。`
}

function systemAgentMarker(name: string): string {
  return `<!--${COMPONENT}-system-agent:${name}-->`
}

function configuredNativeModes(agents: AgentRuntime[]): Record<string, string> {
  const modes: Record<string, string> = {}
  for (const agent of agents) {
    if (agent.type === "primary" && agent.nativeMode && !modes[agent.nativeMode]) modes[agent.nativeMode] = agent.name
  }
  return modes
}

function applyConfiguredSystemAgentPrompts(config: any, runtime: Runtime, agents: SystemPhaseAgentRuntime[], projectRoot: string): void {
  config.agent = config.agent ?? {}
  for (const agent of agents) {
    if (!buildPrompt(agent, runtime.configRoot, { projectRoot })) {
      dbg(`[${COMPONENT}] 未接管 agents/system/${agent.name}：提示词不可用`)
      continue
    }
    const current = config.agent[agent.name] && typeof config.agent[agent.name] === "object" ? config.agent[agent.name] : {}
    config.agent[agent.name] = { ...current, prompt: systemAgentMarker(agent.name) }
  }
}

function applyO4eSkillSource(config: any, runtime: Runtime): void {
  const skillRoot = runtime.skillsRoot
  const skills = config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)
    ? config.skills
    : {}
  const paths = Array.isArray(skills.paths) ? skills.paths : []
  skills.paths = [skillRoot, ...paths.filter((path: unknown) => path !== skillRoot)]
  config.skills = skills
}

function resolveConfiguredAgentModels(config: any, agents: any[]): void {
  for (const agent of agents) {
    // config.provider contains overrides, not the host's complete model registry.
    // Keep declared candidates; the host resolves them when submitting a request.
    agent.resolvedModels = normalizeModelRefs(agent.models)
    const model = agent.resolvedModels[0]
    if (!model) continue
    const current = config.agent[agent.name] ?? {}
    const { variant: _variant, ...rest } = current
    config.agent[agent.name] = { ...rest, model: modelRefKey(model), ...(model.variant ? { variant: model.variant } : {}) }
  }
}

function clearRuntimeModelProjection(config: any): void {
  if (!config || typeof config !== "object") return
  delete config.model
  delete config.variant
  if (!config.agent || typeof config.agent !== "object") return
  for (const value of Object.values(config.agent)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    delete (value as any).model
    delete (value as any).variant
  }
}

function takeOver(output: { system: string[] }, runtime: Runtime, agents: AgentRuntime[], systemPhaseAgents: SystemPhaseAgentRuntime[], workspaceDirectory: string, projectRoot: string): void {
  if (!Array.isArray(output?.system) || output.system.length === 0) return
  for (const system of output.system) {
    const marker = system.match(MARKER_RE)
    if (!marker) continue
    const entry = agents.find((agent) => agent.name === marker[1])
    if (!entry) continue
    const runtimeProtocol = backgroundTaskProtocol(entry, agents, runtime.config.language)
    const prompt = entry.nativeSystem
      ? buildNativePrompt(entry, runtime.configRoot, system, marker[0], { projectRoot }, runtimeProtocol)
      : buildPrompt(entry, runtime.configRoot, { projectRoot }, runtimeProtocol)
    if (!prompt) return
    const workflowNotice = runtime.config.language === "en"
      ? `Workflow is experimental Beta, not production-ready. ${runtime.config.enableWorkflow === true ? "Explicit opt-in is enabled; current permissions still apply." : "It is disabled. Do not call o4e_workflow or enable it yourself; use ordinary tools and Tasks."}`
      : `Workflow 为实验性 Beta，不宣称生产可用。${runtime.config.enableWorkflow === true ? "已显式开启，仍受当前权限约束。" : "当前关闭，不调用 o4e_workflow，不自行开启；使用普通工具和 Task。"}`
    const withWorkspaceContext = `${prompt}\n\n${workflowNotice}\n\n${workspaceContext(runtime.config.language, workspaceDirectory, projectRoot)}`
    const agentPrompt = entry.nativeSystem ? withWorkspaceContext : `<!--${COMPONENT}-agent:${entry.name}-->\n${withWorkspaceContext}`
    const nativeLength = output.system.reduce((total, value) => total + value.length, 0)
    output.system.splice(0, output.system.length, agentPrompt)
    dbg(`[${COMPONENT}] 完全接管 ${entry.type} agent=${entry.name} (${nativeLength} -> ${agentPrompt.length})`)
    return
  }
  for (const system of output.system) {
    const marker = system.match(SYSTEM_AGENT_MARKER_RE)
    if (!marker) continue
    const entry = systemPhaseAgents.find((agent) => agent.name === marker[1])
    if (!entry) return
    const prompt = buildPrompt(entry, runtime.configRoot, { projectRoot })
    if (!prompt) return
    const nativeLength = output.system.reduce((total, value) => total + value.length, 0)
    output.system.splice(0, output.system.length, prompt)
    dbg(`[${COMPONENT}] 完全接管 system phase=${entry.name} (${nativeLength} -> ${prompt.length})`)
    return
  }
}

function configNameForAgent(agent: string | undefined, nativeModes: Record<string, string>): string | undefined {
  return resolveNativeAgentName(agent, nativeModes)
}

function planReminderRanges(text: string): Array<{ start: number; end: number }> {
  const ranges = []
  const pattern = /<system-reminder>([\s\S]*?)<\/system-reminder>/g
  for (const match of text.matchAll(pattern)) {
    if (!match[1].trimStart().startsWith(PLAN_REMINDER_HEADER) || match.index === undefined) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

const O4E_PART_PROVENANCE = Object.freeze({ producer: COMPONENT, version: 1 })

function o4eProducedPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const provenance = (part as { metadata?: { o4e?: { producer?: unknown; version?: unknown } } }).metadata?.o4e
  return provenance?.producer === COMPONENT && provenance.version === 1
}

function o4ePartMetadata(kind: "message-prompt" | "plan-reminder" | "background-task-notice" | "background-task-receipts" | "background-task-requests" | "background-task-continuation") {
  return { o4e: { ...O4E_PART_PROVENANCE, kind } }
}

function o4eSyntheticPart(part: Record<string, unknown>): Record<string, unknown> {
  return { ...part, synthetic: true }
}

function isBackgroundTaskContinuation(parts: unknown): boolean {
  return Array.isArray(parts) && parts.some((part) => (
    o4eProducedPart(part)
    && (part as { metadata?: { o4e?: { kind?: unknown } } }).metadata?.o4e?.kind === "background-task-continuation"
  ))
}

function latestCompletedAssistantMessageID(messages: any[]): string | undefined {
  for (const record of [...messages].reverse()) {
    const info = record?.info
    const parts = Array.isArray(record?.parts) ? record.parts : []
    const hasPendingHostTool = parts.some((part: any) => (
      part?.type === "tool"
      && part.metadata?.providerExecuted !== true
      && !(part.state?.status === "error" && part.state?.metadata?.interrupted === true)
    ))
    if (
      info?.role === "assistant"
      && typeof info.id === "string"
      && !info.error
      && Boolean(info.finish)
      && !["tool-calls", "unknown"].includes(info.finish)
      && !hasPendingHostTool
    ) return info.id
  }
}

function hasPlanReminder(parts: unknown[]): boolean {
  return parts.some((part) => o4eProducedPart(part) && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" && planReminderRanges((part as { text: string }).text).length > 0)
}

function replacePlanReminder(parts: any[], reminder: string): boolean {
  for (const part of parts) {
    if (!o4eProducedPart(part) || part.type !== "text" || typeof part.text !== "string") continue
    const range = planReminderRanges(part.text)[0]
    if (!range) continue
    part.text = `${part.text.slice(0, range.start)}${reminder}${part.text.slice(range.end)}`
    return true
  }
  return false
}

function removePlanReminders(parts: any[]): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (!o4eProducedPart(part) || part.type !== "text" || typeof part.text !== "string") continue
    const ranges = planReminderRanges(part.text)
    if (ranges.length === 0) continue
    let text = part.text
    for (const range of ranges.toReversed()) text = `${text.slice(0, range.start)}${text.slice(range.end)}`
    if (text.trim()) part.text = text
    else parts.splice(index, 1)
  }
}

// Command options are dependency-injection seams, never model or O4E config fields.
export async function createOpenCodeHooks({ client, directory, worktree, commandWaitOptions, commandLogOptions }: any) {
  const o4eMode = resolveO4eMode()
  if (o4eMode === "origin") {
    return { config: async (config: any) => cleanDisabledAgentProjection(config, directory ?? worktree) }
  }
  const invalidModeValue = invalidO4eModeValue()
  if (invalidModeValue !== undefined) {
    // 持久诊断写宿主日志（fire-and-forget，绝不阻塞插件初始化）；屏幕上的 toast
    // 由 TUI 端插件在 UI 就绪后本地弹出（见 tui/index.tsx），不受服务端事件桥时序影响。
    const message = invalidO4eModeMessage(invalidModeValue)
    try {
      void Promise.resolve(client?.app?.log?.({ body: { service: "opencode-for-everything", level: "error", message } })).catch(() => {})
    } catch { /* 日志记录尽力而为 */ }
  }
  const configuredRoot = resolveO4eConfigRoot()
  const explicitConfig = process.env.o4e_config !== undefined
  if (explicitConfig && !configRootExists(configuredRoot, "global")) {
    throw new Error(`O4E_CONFIG_NOT_FOUND: o4e_config directory does not exist: ${configuredRoot}`)
  }
  const modelFallback = new SessionModelFallback()
  let delegationRuntime: DelegationRuntime | undefined
  let backgroundTaskRuntime: BackgroundTaskRuntime | undefined
  const commandCards = new Set<ReturnType<typeof createCommandCard>>()
  let commandTaskRuntime: CommandTaskRuntime | undefined
  let commandPort: ReturnType<typeof createCommandExecutionPort> | undefined
  let commandShell: string | undefined
  const commandAbortListeners = new Map<string, () => void>()
  let workflowRuntime: WorkflowRuntime | undefined
  let operationAbort = new AbortController()
  const runtimeOperations = new Set<Promise<unknown>>()
  const abortable = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("O4E Runtime 正在释放"))
    return new Promise((resolvePromise, rejectPromise) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort)
      const onAbort = () => {
        cleanup()
        rejectPromise(signal.reason ?? new Error("O4E Runtime 正在释放"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      operation.then(
        (value) => { cleanup(); resolvePromise(value) },
        (error) => { cleanup(); rejectPromise(error) },
      )
    })
  }
  const runtimeContext = (context: any) => {
    const signal = context?.abort
      ? AbortSignal.any([context.abort, operationAbort.signal])
      : operationAbort.signal
    return {
      ...context,
      abort: signal,
      ...(typeof context?.ask === "function"
        ? { ask: (...args: any[]) => abortable(Promise.resolve(context.ask(...args)), signal) }
        : {}),
    }
  }
  const trackRuntimeOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = Promise.resolve().then(operation)
    runtimeOperations.add(pending)
    return pending.finally(() => runtimeOperations.delete(pending))
  }
  const sessionDirectory = resolveSessionDirectory(directory, worktree)
  // OpenCode's directory is the active workspace; worktree is only the repository
  // root used for project-scoped instructions and relative-path presentation.
  const projectRoot = canonicalDirectoryKey(worktree ?? directory ?? process.cwd())
  const terminalContinuationCoordination = acquireSharedTerminalContinuations(sessionDirectory)
  const automaticTaskFollow = acquireAutomaticTaskFollow(sessionDirectory)
  const sharedTerminalContinuationSessions = terminalContinuationCoordination.sessions
  const sessionStore = new OpenCodeSessionStore(client, sessionDirectory)
  const scopeLocks = createSharedScopeLockManager(sessionDirectory)
  const hostAgentExecution = createOpenCodeAgentExecutionPort({ client, directory: sessionDirectory })
  const stopCommands = async (sessionID: string) => {
    if (!commandTaskRuntime) return
    await commandTaskRuntime.cancelOwned(sessionID)
  }
  const stopTerminatedCommands = async (sessionID: string, dispatchMessageID: string) => {
    if (!commandTaskRuntime) return
    // Inspection may have waited on host I/O while this child began a new turn.
    // Recheck both generation and activity before any cancellation side effect;
    // outer Agent settlement guards run only after this adapter returns.
    const current = await sessionStore.get(sessionID)
    if (!dispatchMessageID || sessionO4E(current).delegation?.dispatchMessageID !== dispatchMessageID) return { state: "unknown" }
    // OpenCode removes idle Sessions from this sparse map. Only a missing entry
    // means idle; an explicit malformed/unknown entry cannot prove termination.
    const status = (await sessionStore.status())[sessionID]
    if (status !== undefined && status?.type !== "idle") {
      return { state: status?.type === "busy" ? "running" : status?.type === "retry" ? "retrying" : "unknown" }
    }
    const checked = await sessionStore.get(sessionID)
    if (sessionO4E(checked).delegation?.dispatchMessageID !== dispatchMessageID) return { state: "unknown" }
    await stopCommands(sessionID)
  }
  const agentExecution = {
    ...hostAgentExecution,
    async cancelTurn(args: any) {
      const results = await Promise.allSettled([hostAgentExecution.cancelTurn(args), stopCommands(args.sessionID)])
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      return (results[0] as PromiseFulfilledResult<any>).value
    },
    async runTurn(args: any) {
      const result = await hostAgentExecution.runTurn(args)
      if (hostAgentExecution.isCompletedAssistantMessage({ message: result, dispatchMessageID: args.messageID })
        || (result?.info?.role === "assistant" && result.info.parentID === args.messageID && result.info.error)) {
        if (await stopTerminatedCommands(args.sessionID, args.messageID)) throw new Error("O4E_COMMAND_CHILD_TERMINATION_STALE")
      }
      return result
    },
    async inspectTurn(args: any) {
      const inspection = await hostAgentExecution.inspectTurn(args)
      // Reconciled child termination is a boundary even if the host idle event
      // was missed. Stop child commands before the Agent Runtime can settle.
      if (inspection.state === "idle" && args.dispatchMessageID) {
        const changed = await stopTerminatedCommands(args.sessionID, args.dispatchMessageID)
        if (changed) return changed
      }
      return inspection
    },
  }
  const commands = () => commandTaskRuntime ??= new CommandTaskRuntime({
    store: sessionStore, directory: sessionDirectory,
    limits: runtimeSnapshot()?.runtime.config.backgroundTasks,
    inspectionCursorResolver: resolveInspectionCursors,
    execution: {
      start: (args: any) => {
        commandPort ??= createCommandExecutionPort({ ...commandLogOptions, directory: sessionDirectory, projectRoot, shell: commandShell })
        return commandPort.start(args)
      },
      get: (executionID: string) => {
        commandPort ??= createCommandExecutionPort({ ...commandLogOptions, directory: sessionDirectory, projectRoot, shell: commandShell })
        return commandPort.get(executionID)
      },
    },
  })
  const pendingRuntimeEvents: any[] = []
  const parentPromptContexts = new Map<string, { agent?: string; model?: { providerID: string; modelID: string }; variant?: string }>()
  const processedParentIdleMessages = new Map<string, string>()
  const pendingPersistedUserMessages = new Map<string, Map<string, {
    userTurnClaimID: symbol
    userTurnEpoch: number
    messageUpdated: boolean
    registrationComplete: boolean
    pendingPartIDs: Set<string>
    persistedPartIDs: Set<string>
    deliveredReceiptIDs: Set<string>
  }>>()
  const pendingSyntheticContinuations = new Map<string, Map<string, {
    messageUpdated: boolean
    partID: string
    part: any
    pendingPartIDs: Set<string>
    receiptIDs: Set<string>
  }>>()
  const pendingTerminalWakeups = new Map<string, Map<string, { taskID: string; receiptID: string; deliveredToMessageID?: string; bypassActiveWatch?: boolean }>>()
  const terminalWakeupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const terminalWakeupRetryCounts = new Map<string, number>()
  const terminalCheckFailures = new Map<string, { epoch: number; revision?: number; count: number }>()
  // Local fail-closed state is distinct from abort suppression: a user message
  // must not silently resume coordination whose failure could not be saved.
  const unpersistedFollowFailures = new Map<string, { revision?: number }>()
  const followControlEpochs = new Map<string, number>()
  const terminalWakeupBatchStartedAt = new Map<string, number>()
  const terminalWakeupOperations = new Map<string, Promise<"submitted" | "blocked" | "retry">>()
  const automaticFollowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const userDeliveredTerminalReceipts = new Set<string>()
  const watchConsumedTerminalReceipts = new Set<string>()
  let processTerminalWakeup = async (_sessionID: string): Promise<"submitted" | "blocked" | "retry"> => "blocked"
  let processAutomaticFollow = async (_sessionID: string): Promise<"submitted" | "blocked" | "retry"> => "blocked"
  const rememberUserDeliveredReceipt = (receiptID: string) => {
    userDeliveredTerminalReceipts.add(receiptID)
    while (userDeliveredTerminalReceipts.size > 512) {
      const oldest = userDeliveredTerminalReceipts.values().next().value
      if (typeof oldest !== "string") break
      userDeliveredTerminalReceipts.delete(oldest)
    }
  }
  const rememberWatchConsumedReceipt = (receiptID: string) => {
    watchConsumedTerminalReceipts.add(receiptID)
    while (watchConsumedTerminalReceipts.size > 512) {
      const oldest = watchConsumedTerminalReceipts.values().next().value
      if (typeof oldest !== "string") break
      watchConsumedTerminalReceipts.delete(oldest)
    }
  }
  const removePendingTerminalWakeup = (sessionID: string, receiptID: string) => {
    const pending = pendingTerminalWakeups.get(sessionID)
    pending?.delete(receiptID)
    if (pending?.size !== 0) return
    pendingTerminalWakeups.delete(sessionID)
    const timer = terminalWakeupTimers.get(sessionID)
    if (timer) clearTimeout(timer)
    terminalWakeupTimers.delete(sessionID)
    terminalWakeupRetryCounts.delete(sessionID)
    terminalCheckFailures.delete(sessionID)
    terminalWakeupBatchStartedAt.delete(sessionID)
  }
  const rememberPersistedSyntheticContinuation = (sessionID: string, messageID: string, _receiptIDs: Set<string>) => {
    const continuations = pendingSyntheticContinuations.get(sessionID)
    continuations?.delete(messageID)
    if (continuations?.size === 0) pendingSyntheticContinuations.delete(sessionID)
  }
  const consumeTerminalReceipts = (sessionID: string, receiptIDs: Set<string>) => {
    const continuations = pendingSyntheticContinuations.get(sessionID)
    if (continuations) {
      for (const [messageID, continuation] of continuations) {
        if ([...receiptIDs].some((receiptID) => continuation.receiptIDs.has(receiptID))) continuations.delete(messageID)
      }
      if (continuations.size === 0) pendingSyntheticContinuations.delete(sessionID)
    }
    for (const receiptID of receiptIDs) {
      rememberWatchConsumedReceipt(receiptID)
      removePendingTerminalWakeup(sessionID, receiptID)
    }
    processedParentIdleMessages.delete(sessionID)
  }
    terminalContinuationCoordination.registerConsumer(rememberPersistedSyntheticContinuation)
  terminalContinuationCoordination.registerReceiptConsumer(consumeTerminalReceipts)
  terminalContinuationCoordination.registerReceiptReleaseConsumer((sessionID: string, receiptIDs: Set<string>) => {
    if ([...receiptIDs].some((receiptID) => pendingTerminalWakeups.get(sessionID)?.has(receiptID))) {
      scheduleTerminalWakeup(sessionID, { retry: true })
    }
  })
  terminalContinuationCoordination.registerWatchReleaseConsumer((sessionID: string) => {
    backgroundTaskRuntime?.releaseSharedWatch(sessionID)
  })
  terminalContinuationCoordination.registerUserTurnReleaseConsumer((sessionID: string) => {
    if (pendingTerminalWakeups.has(sessionID)) scheduleTerminalWakeup(sessionID, { retry: true })
  })
  const scheduleTerminalWakeup = (sessionID: string, { retry = false } = {}) => {
    if (!lifecycle.isActive() || unpersistedFollowFailures.has(sessionID) || automaticTaskFollow.isSuppressed(sessionID) || terminalWakeupTimers.has(sessionID)) return
    const retryCount = retry ? (terminalWakeupRetryCounts.get(sessionID) ?? 0) : 0
    const batchStartedAt = terminalWakeupBatchStartedAt.get(sessionID)
    const batching = batchStartedAt !== undefined && Date.now() - batchStartedAt < TERMINAL_WAKEUP_BATCH_MAX_WAIT_MS
    const delay = batching
      ? retry ? TERMINAL_WAKEUP_BATCH_RECHECK_MS : TERMINAL_WAKEUP_BATCH_DELAY_MS
      : retry ? Math.min(1000 * (2 ** retryCount), 60_000) : TERMINAL_WAKEUP_BATCH_DELAY_MS
    if (retry && !batching) terminalWakeupRetryCounts.set(sessionID, retryCount + 1)
    else if (retry && batching) terminalWakeupRetryCounts.delete(sessionID)
    else terminalWakeupRetryCounts.delete(sessionID)
    const timer = setTimeout(() => {
      terminalWakeupTimers.delete(sessionID)
      void trackRuntimeOperation(async () => {
        const result = await processTerminalWakeup(sessionID)
        if (result === "retry" && pendingTerminalWakeups.has(sessionID)) scheduleTerminalWakeup(sessionID, { retry: true })
        else if (result === "submitted" && pendingTerminalWakeups.has(sessionID)) scheduleTerminalWakeup(sessionID, { retry: true })
        else if (result === "submitted" || !pendingTerminalWakeups.has(sessionID)) terminalWakeupRetryCounts.delete(sessionID)
      }).catch(() => {
        if (pendingTerminalWakeups.has(sessionID)) scheduleTerminalWakeup(sessionID, { retry: true })
      })
    }, delay)
    terminalWakeupTimers.set(sessionID, timer)
  }
  const scheduleAutomaticFollow = (sessionID: string) => {
    if (!lifecycle.isActive() || unpersistedFollowFailures.has(sessionID) || automaticTaskFollow.isSuppressed(sessionID) || automaticFollowTimers.has(sessionID)) return
    const timer = setTimeout(() => {
      automaticFollowTimers.delete(sessionID)
      void trackRuntimeOperation(() => processAutomaticFollow(sessionID)).catch((error) => {
        dbg(`[${COMPONENT}] 自动 Task 跟踪检查停止: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, TERMINAL_WAKEUP_BATCH_DELAY_MS)
    automaticFollowTimers.set(sessionID, timer)
  }
  let acceptingRuntimeEvents = true
  let drainRuntimeEvents = async (): Promise<void> => {}
  const runtimeRecoveries = new Map<string, Promise<void>>()
  const runtimeActivations = new Map<string, Promise<void>>()
  const canRecoverRuntimeSessions = ["get", "children"]
    .every((method) => typeof client?.session?.[method] === "function")
  const canReadBackgroundTasks = typeof client?.session?.get === "function"
  const canRecoverWorkflows = ["get", "messages", "update"]
    .every((method) => typeof client?.session?.[method] === "function")
  const ensureRuntimeRecovery = async (sessionID?: string, session?: any): Promise<void> => {
    if (!backgroundTaskRuntime || !delegationRuntime) throw new Error("O4E Runtime 尚未初始化")
    const recoverableSession = canRecoverRuntimeSessions && typeof sessionID === "string" && sessionID
    if (recoverableSession) {
      let recovery = runtimeRecoveries.get(sessionID)
      if (!recovery) {
        recovery = (async () => {
          const current = session ?? await sessionStore.get(sessionID)
          if (current?.metadata?.o4e?.commandTasks !== undefined) await commands().recoverSession({ sessionID })
          await Promise.all([
          trackRuntimeOperation(() => backgroundTaskRuntime!.recoverSession(sessionID, { dispatch: false, session })),
          trackRuntimeOperation(() => delegationRuntime!.recoverSession(sessionID, { session })),
          ])
        })()
        runtimeRecoveries.set(sessionID, recovery)
        void recovery.catch((error) => {
          if (runtimeRecoveries.get(sessionID) === recovery) runtimeRecoveries.delete(sessionID)
          dbg(`[${COMPONENT}] Session ${sessionID} Task/委派恢复失败: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      await recovery
    }
    await drainRuntimeEvents()
  }
  const activateRuntimeSession = async (sessionID?: string): Promise<void> => {
    await ensureRuntimeRecovery(sessionID)
    if (!canRecoverRuntimeSessions || typeof sessionID !== "string" || !sessionID) return
    let activation = runtimeActivations.get(sessionID)
    if (!activation) {
      activation = backgroundTaskRuntime!.activateSession(sessionID).then(() => undefined)
      runtimeActivations.set(sessionID, activation)
      void activation.catch((error) => {
        if (runtimeActivations.get(sessionID) === activation) runtimeActivations.delete(sessionID)
        dbg(`[${COMPONENT}] Session ${sessionID} Task 激活失败: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    await activation
    await drainRuntimeEvents()
  }
  const lifecycle = createRuntimeLifecycle(async () => {
    for (const card of commandCards) card.dispose()
    commandCards.clear()
    const disposingAbort = operationAbort
    disposingAbort.abort(new Error("O4E Runtime 正在释放"))
    // Start process cancellation before waiting on readers or persistence I/O.
    const commandDisposal = commandTaskRuntime?.dispose()
    void commandDisposal?.catch(() => undefined)
    let backgroundQuiesced = false
    let delegationQuiesced = false
    const quiesceRuntimes = async () => {
      const backgroundFlushing = backgroundTaskRuntime?.flush()
      backgroundQuiesced = true
      const delegationFlushing = delegationRuntime?.flush()
      delegationQuiesced = true
      const enteredOperations = Promise.allSettled([...runtimeOperations])
      const settlements = await Promise.allSettled([backgroundFlushing, delegationFlushing, enteredOperations])
      const failure = settlements.find((settlement) => settlement.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    }
    try {
      while (true) {
        await quiesceRuntimes()
        if (pendingRuntimeEvents.length === 0) break
        backgroundTaskRuntime?.resume({ dispatch: false })
        backgroundQuiesced = false
        delegationRuntime?.resume()
        delegationQuiesced = false
        await drainRuntimeEvents()
      }
      await commandDisposal
      await commandPort?.dispose()
      acceptingRuntimeEvents = false
    } catch (error) {
      await commandTaskRuntime?.resume()
      if (backgroundQuiesced) {
        backgroundTaskRuntime?.resume({ dispatch: false })
      }
      if (delegationQuiesced) delegationRuntime?.resume()
      if (operationAbort === disposingAbort) operationAbort = new AbortController()
      throw error
    }
    terminalContinuationCoordination.release()
    automaticTaskFollow.release()
    modelFallback.clear()
    parentPromptContexts.clear()
    processedParentIdleMessages.clear()
    pendingPersistedUserMessages.clear()
    pendingSyntheticContinuations.clear()
    pendingTerminalWakeups.clear()
    for (const timer of terminalWakeupTimers.values()) clearTimeout(timer)
    terminalWakeupTimers.clear()
    terminalWakeupRetryCounts.clear()
    terminalCheckFailures.clear()
    unpersistedFollowFailures.clear()
    followControlEpochs.clear()
    terminalWakeupBatchStartedAt.clear()
    terminalWakeupOperations.clear()
    for (const timer of automaticFollowTimers.values()) clearTimeout(timer)
    automaticFollowTimers.clear()
    userDeliveredTerminalReceipts.clear()
    watchConsumedTerminalReceipts.clear()
    runtimeRecoveries.clear()
    runtimeActivations.clear()
    for (const remove of commandAbortListeners.values()) remove()
    commandAbortListeners.clear()
    backgroundTaskRuntime?.dispose()
    delegationRuntime?.dispose()
  })
  const runtimeSnapshot = createSnapshotAccessor((): RuntimeSnapshot | null => {
    const definition = readRuntimeDefinition(directory, configuredRoot, explicitConfig)
    if (!definition) return null
    const runtime = { configRoot: definition.configRoot, globalConfigRoot: configuredRoot, config: definition.config, skillsRoot: join(definition.configRoot, "skills") }
    const agents = definition.runtimeAgents.map((definition) => {
      const agent = runtimeAgentFromDefinition(definition)
      // clear must remove the internal candidate chain as well as host frontmatter.
      return o4eMode === "clear" ? { ...agent, model: undefined, fallbackModels: [], models: [] } : agent
    })
    const primaryAgents = agents.filter((agent) => SELECTABLE_AGENT_TYPES.includes(agent.type))
    const systemPhaseAgents = definition.systemPhaseAgents.map(systemAgentFromDefinition)
    const nativeModes = configuredNativeModes(agents)
    const soulHandler = createSoulHandler(runtime.configRoot, runtime.config, runtime.globalConfigRoot)
    return {
      runtime,
      agents,
      primaryAgents,
      systemPhaseAgents,
      nativeModes,
      nativeAgentStrategies: definition.nativeAgentPolicy.strategies,
      agentByName: new Map(agents.map((agent) => [agent.name, agent])),
      allAgents: [...agents, ...systemPhaseAgents],
      soulHandler,
      workflows: definition.workflows,
    }
  })
  delegationRuntime = new DelegationRuntime({
    client,
    // Session API calls must stay bound to the active project directory. The
    // OpenCode worktree can be a parent repository (for example .test inside
    // the repository), and using it here makes delegated Sessions lose the
    // project's .o4e/.opencode configuration.
    directory: sessionDirectory,
    snapshot: runtimeSnapshot,
    store: sessionStore,
    locks: scopeLocks,
    execution: {
      ...agentExecution,
      async cancelTurn(args: any) {
        // Background Tasks already cancel their own descendants. Only the
        // Foreground delegation needs this additional boundary.
        const results = await Promise.allSettled([
          agentExecution.cancelTurn(args),
          backgroundTaskRuntime!.cancelOwned(args.sessionID),
        ])
        const failed = results.find((result) => result.status === "rejected")
        if (failed?.status === "rejected") throw failed.reason
        const descendants = (results[1] as PromiseFulfilledResult<any>).value
        return { acknowledged: (results[0] as PromiseFulfilledResult<any>).value?.acknowledged === true && descendants.stopped === true }
      },
    },
  })
  backgroundTaskRuntime = new BackgroundTaskRuntime({
    sessionStore,
    inspectionReader: readTaskInspection,
    inspectionCursorResolver: resolveInspectionCursors,
    execution: agentExecution,
    delegation: delegationRuntime,
    locks: scopeLocks,
    directory: sessionDirectory,
    limits: runtimeSnapshot()?.runtime.config.backgroundTasks,
    scheduler: createSharedBackgroundTaskScheduler(sessionDirectory, runtimeSnapshot()?.runtime.config.backgroundTasks),
    sharedWatch: terminalContinuationCoordination,
    onTerminalReceipt: ({ ownerSessionID, taskID, receiptID, deliveredToMessageID, bypassActiveWatch }: any) => {
      if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
      if (
        userDeliveredTerminalReceipts.has(receiptID)
        || watchConsumedTerminalReceipts.has(receiptID)
        || terminalContinuationCoordination.hasConsumedReceipt(ownerSessionID, receiptID)
      ) return
      const pending = pendingTerminalWakeups.get(ownerSessionID) ?? new Map()
      pending.set(receiptID, { taskID, receiptID, ...(deliveredToMessageID ? { deliveredToMessageID } : {}), ...(bypassActiveWatch ? { bypassActiveWatch: true } : {}) })
      pendingTerminalWakeups.set(ownerSessionID, pending)
      if (!terminalWakeupBatchStartedAt.has(ownerSessionID)) terminalWakeupBatchStartedAt.set(ownerSessionID, Date.now())
      scheduleTerminalWakeup(ownerSessionID)
    },
    onTerminalReceiptConsumed: ({ ownerSessionID, receiptID, receiptIDs }: any) => {
      return terminalContinuationCoordination.serializeSubmission(ownerSessionID, async () => {
        terminalContinuationCoordination.consumeReceipts(ownerSessionID, new Set(receiptIDs ?? (receiptID ? [receiptID] : [])))
      })
    },
    onTerminalReceiptConsuming: ({ ownerSessionID, receiptIDs }: any) => {
      return terminalContinuationCoordination.serializeSubmission(ownerSessionID, async () => {
        terminalContinuationCoordination.beginReceiptConsumption(ownerSessionID, new Set(receiptIDs))
      })
    },
    onTerminalReceiptConsumptionFailed: ({ ownerSessionID, receiptIDs }: any) => {
      return terminalContinuationCoordination.serializeSubmission(ownerSessionID, async () => {
        terminalContinuationCoordination.releaseReceiptConsumption(ownerSessionID, new Set(receiptIDs))
      })
    },
  })
  delegationRuntime.setBeforeDelegate(async (context) => {
    await ensureRuntimeRecovery(context.sessionID)
    if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
    await backgroundTaskRuntime!.ensureOwner(context)
  })
  workflowRuntime = runtimeSnapshot()?.runtime.config.enableWorkflow === true ? new WorkflowRuntime({
    client,
    directory: sessionDirectory,
    snapshot: runtimeSnapshot,
    store: sessionStore,
    userTurnEpoch: (sessionID: string) => terminalContinuationCoordination.userTurnEpoch(sessionID),
  }) : undefined
  const continueParentSession = async (runtimeEvent: any, { terminalWakeup = false } = {}): Promise<"submitted" | "blocked" | "retry"> => {
    const idleEvent = runtimeEvent.kind === "session-idle"
      || (runtimeEvent.kind === "session-status" && runtimeEvent.status?.type === "idle")
    if ((!idleEvent && !terminalWakeup) || typeof runtimeEvent.sessionID !== "string" || !lifecycle.isActive()) return "blocked"
    const sessionID = runtimeEvent.sessionID
    if (unpersistedFollowFailures.has(sessionID) || automaticTaskFollow.isSuppressed(sessionID)) return "blocked"
    if (!terminalWakeup && !automaticTaskFollow.isActivated(sessionID)) return "blocked"
    if ((pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0) return "blocked"
    if (terminalContinuationCoordination.hasUserTurn(sessionID)) return "blocked"
    const userEpoch = terminalContinuationCoordination.userTurnEpoch(sessionID)
    const messages = await sessionStore.messages(sessionID).catch((error) => {
      if (terminalWakeup) throw error
      return []
    })
    const anchorMessageID = latestCompletedAssistantMessageID(messages)
    const statuses = await sessionStore.status()
    if (statuses?.[sessionID] !== undefined && !["idle", "busy", "retry"].includes(statuses[sessionID]?.type)) return "blocked"
    const followOwner = await sessionStore.get(sessionID)
    if (!followOwner) return "blocked"
    const initialFollowControl = automaticFollowControl(sessionO4E(followOwner))
    if (!initialFollowControl.enabled) {
      automaticTaskFollow.suppress(sessionID)
      return "blocked"
    }
    const completedAssistantParentIDs = terminalWakeup
      ? new Set(await agentExecution.completedAssistantParentIDs?.({ sessionID }).catch(() => []) ?? [])
      : new Set<string>()
    if (terminalWakeup && statuses?.[sessionID]?.type === "idle") {
      for (const continuation of sharedTerminalContinuationSessions.get(sessionID)?.values() ?? []) {
        if (completedAssistantParentIDs.has(continuation.messageID)) continue
        if (continuation.fallbackAcceptedAt !== undefined) {
          if (continuation.fallbackObservedActive || Date.now() - continuation.fallbackAcceptedAt >= TERMINAL_FALLBACK_ACCEPTANCE_GRACE_MS) {
            continuation.fallbackAcceptedAt = undefined
            continuation.fallbackObservedActive = false
            continuation.retryRequested = true
          }
        } else if (continuation.persisted) continuation.retryRequested = true
      }
    }
    const retryContinuation = terminalWakeup
      ? [...(sharedTerminalContinuationSessions.get(sessionID)?.values() ?? [])]
          .filter((continuation) => continuation.retryRequested)
          .sort((left, right) => left.createdAt - right.createdAt)[0]
      : undefined
    const retryingSyntheticContinuation = terminalWakeup && (
      (pendingSyntheticContinuations.get(sessionID)?.size ?? 0) > 0
      || Boolean(retryContinuation)
    )
    if (!anchorMessageID || (terminalWakeup && processedParentIdleMessages.get(sessionID) === anchorMessageID && !retryingSyntheticContinuation)) return "blocked"
    if (["busy", "retry"].includes(statuses?.[sessionID]?.type)) return "blocked"
    const tasks = (await backgroundTaskRuntime!.taskGroup({ sessionID }).catch((error) => {
      if (terminalWakeup) throw error
      return []
    }))
      .filter((task) => task.ownerSessionID === sessionID && !isTerminalTaskStatus(task.status))
    const owner = terminalWakeup ? undefined : await sessionStore.get(sessionID)
    const commandIDs = terminalWakeup || automaticTaskFollow.isSuppressed(sessionID) ? [] : Object.keys(sessionO4E(owner).commandTasks?.refs ?? {})
    const commandSelection = commandIDs.length > 0 ? await commands().watchSelection(commandIDs, { sessionID }) : undefined
    const commandTasks = commandSelection ? await commandSelection.tasks() : []
    const visibleCommandTasks = commandTasks.filter((task: any) => (
      ["queued", "running"].includes(task.status) || automaticTaskFollow.commandNeedsDelivery(sessionID, task)
    ))
    const taskEventKey = (task: any) => JSON.stringify([task.taskID, task.runGeneration, task.status, task.phase, task.revision])
    // Every state, including running Agent/Command tasks, is reported once per
    // real follow intent. Our own assistant reply must not renew that intent.
    // Filter individually: a reported wait must not suppress new sibling work.
    const continuingTasks = terminalWakeup
      ? tasks.filter((task) => !isActionableTaskStatus(task.status))
      : [...tasks, ...visibleCommandTasks].filter((task) => automaticTaskFollow.taskNeedsDelivery(sessionID, task.taskID, taskEventKey(task)))
    const taskEvents = continuingTasks.map((task) => ({ taskID: task.taskID, key: taskEventKey(task) }))
    const taskKeys = taskEvents.map((event) => event.key).sort()
    let terminalReceipts = terminalWakeup
      ? await backgroundTaskRuntime!.pendingReceipts({ sessionID })
      : []
    if (terminalWakeup) {
      const pending = pendingTerminalWakeups.get(sessionID)
      if (!pending?.size) return "blocked"
      let blockedByWatch = false
      let blockedByConsumption = false
      const wakeableReceiptIDs = new Set<string>()
      for (const [receiptID, receipt] of pending) {
        if (terminalContinuationCoordination.isReceiptUnavailable(sessionID, receiptID)) {
          blockedByConsumption = true
          continue
        }
        if (!receipt.bypassActiveWatch && (backgroundTaskRuntime!.hasActiveWatch(sessionID, { taskIDs: [receipt.taskID] }) || terminalContinuationCoordination.hasWatch(sessionID, receipt.taskID))) {
          blockedByWatch = true
          continue
        }
        wakeableReceiptIDs.add(receiptID)
      }
      terminalReceipts = terminalReceipts.filter((receipt) => wakeableReceiptIDs.has(receipt.receiptID))
      if (retryContinuation) {
        terminalReceipts = terminalReceipts.filter((receipt) => retryContinuation.receiptIDs.has(receipt.receiptID))
      } else {
        const continuations = sharedTerminalContinuationSessions.get(sessionID)
        const pendingReceiptIDs = new Set(terminalReceipts.map((receipt) => receipt.receiptID))
        for (const [continuationMessageID, continuation] of continuations ?? []) {
          const receiptStillPending = [...continuation.receiptIDs].some((receiptID) => pendingReceiptIDs.has(receiptID))
          if (!receiptStillPending && continuation.persisted && !continuation.submission) continuations!.delete(continuationMessageID)
        }
        if (continuations?.size === 0) sharedTerminalContinuationSessions.delete(sessionID)
        const claimedReceiptIDs = new Set(
          [...(continuations?.values() ?? [])]
            .filter((continuation) => (
              (continuation.persisted || continuation.fallbackAcceptedAt !== undefined)
              && !continuation.retryRequested
            ))
            .flatMap((continuation) => [...continuation.receiptIDs]),
        )
        terminalReceipts = terminalReceipts.filter((receipt) => !claimedReceiptIDs.has(receipt.receiptID))
        if (terminalReceipts.length === 0 && claimedReceiptIDs.size > 0) return "retry"
      }
      if (terminalReceipts.length === 0 && (blockedByWatch || blockedByConsumption)) return "retry"
    }
    if (terminalWakeup && terminalReceipts.length === 0) {
      pendingTerminalWakeups.delete(sessionID)
      terminalWakeupRetryCounts.delete(sessionID)
      terminalWakeupBatchStartedAt.delete(sessionID)
      return "blocked"
    }
    if (terminalWakeup && continuingTasks.length > 0) {
      const startedAt = terminalWakeupBatchStartedAt.get(sessionID) ?? Date.now()
      terminalWakeupBatchStartedAt.set(sessionID, startedAt)
      if (Date.now() - startedAt < TERMINAL_WAKEUP_BATCH_MAX_WAIT_MS) return "retry"
    }
    if (continuingTasks.length === 0 && terminalReceipts.length === 0) return "blocked"
    if (terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch || terminalContinuationCoordination.hasUserTurn(sessionID)) return "blocked"
    if ((pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0) return "blocked"
    const latestStatuses = await sessionStore.status()
    if (latestStatuses?.[sessionID] !== undefined && !["idle", "busy", "retry"].includes(latestStatuses[sessionID]?.type)) return "blocked"
    if (["busy", "retry"].includes(latestStatuses?.[sessionID]?.type)) return "blocked"
    if (terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch || terminalContinuationCoordination.hasUserTurn(sessionID)) return "blocked"
    if ((pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0) return "blocked"
    const automaticKey = terminalWakeup ? undefined : JSON.stringify(taskKeys)
    // Only a complete successful terminal check resets the error streak.
    // Busy/watch/user-turn waits are neither failures nor successful checks.
    if (terminalWakeup) terminalCheckFailures.delete(sessionID)
    const automaticClaim = automaticKey === undefined ? undefined : automaticTaskFollow.begin(sessionID, automaticKey)
    if (!terminalWakeup && !automaticClaim) return "blocked"
    if (terminalWakeup) {
      const pending = pendingTerminalWakeups.get(sessionID)
      let blockedByWatch = false
      let blockedByConsumption = false
      terminalReceipts = terminalReceipts.filter((receipt) => {
        const wakeup = pending?.get(receipt.receiptID)
        if (!wakeup) return false
        if (terminalContinuationCoordination.isReceiptUnavailable(sessionID, receipt.receiptID)) {
          blockedByConsumption = true
          return false
        }
        if (!wakeup.bypassActiveWatch && (backgroundTaskRuntime!.hasActiveWatch(sessionID, { taskIDs: [wakeup.taskID] }) || terminalContinuationCoordination.hasWatch(sessionID, wakeup.taskID))) {
          blockedByWatch = true
          return false
        }
        return true
      })
      if (terminalReceipts.length === 0) return blockedByWatch || blockedByConsumption ? "retry" : "blocked"
    }
    processedParentIdleMessages.set(sessionID, anchorMessageID)
    const remembered = parentPromptContexts.get(sessionID) ?? latestUserPromptContext(messages)
    const reusedMessageIDs = terminalWakeup
      ? new Set(terminalReceipts.map((receipt) => pendingTerminalWakeups.get(sessionID)?.get(receipt.receiptID)?.deliveredToMessageID).filter(Boolean))
      : new Set()
    let messageID = retryContinuation?.messageID ?? (reusedMessageIDs.size > 0 ? [...reusedMessageIDs].sort()[0] : `msg_${randomUUID()}`)
    if (terminalWakeup && reusedMessageIDs.size > 1) {
      terminalReceipts = terminalReceipts.filter((receipt) => {
        const deliveredToMessageID = pendingTerminalWakeups.get(sessionID)?.get(receipt.receiptID)?.deliveredToMessageID
        return deliveredToMessageID === undefined || deliveredToMessageID === messageID
      })
      if (terminalReceipts.length === 0) return "retry"
    }
    let automaticAccepted = false
    try {
      const continuations = terminalWakeup ? (pendingSyntheticContinuations.get(sessionID) ?? new Map()) : undefined
      const existingContinuation = continuations?.get(messageID)
      if (existingContinuation) {
        terminalReceipts = terminalReceipts.filter((receipt) => existingContinuation.receiptIDs.has(receipt.receiptID))
        if (terminalReceipts.length === 0) return "retry"
      }
      if (terminalWakeup) {
        const deliveries = await backgroundTaskRuntime!.markReceiptsDelivered(
          terminalReceipts.map((receipt) => receipt.receiptID),
          { sessionID },
          messageID,
          { preserveExistingDelivery: true },
        )
        const deliveryByReceiptID = new Map(deliveries.map((delivery) => [delivery.receiptID, delivery]))
        const conflictingDeliveries = terminalReceipts.filter((receipt) => deliveryByReceiptID.get(receipt.receiptID)?.messageID !== messageID)
        if (conflictingDeliveries.length > 0) {
          const latestPending = pendingTerminalWakeups.get(sessionID)
          for (const receipt of conflictingDeliveries) {
            const delivery = deliveryByReceiptID.get(receipt.receiptID)
            const wakeup = latestPending?.get(receipt.receiptID)
            if (delivery?.messageID && wakeup) wakeup.deliveredToMessageID = delivery.messageID
          }
          terminalReceipts = terminalReceipts.filter((receipt) => !conflictingDeliveries.includes(receipt))
          if (terminalReceipts.length === 0) {
            if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
            return "retry"
          }
        }
        if (
          terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch
          || terminalContinuationCoordination.hasUserTurn(sessionID)
          || (pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0
        ) {
          if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
          return "blocked"
        }
        const latestPending = pendingTerminalWakeups.get(sessionID)
        let blockedByWatch = false
        const wakeableReceipts = terminalReceipts.filter((receipt) => {
          const wakeup = latestPending?.get(receipt.receiptID)
          if (!wakeup) return false
          if (!wakeup.bypassActiveWatch && (backgroundTaskRuntime!.hasActiveWatch(sessionID, { taskIDs: [wakeup.taskID] }) || terminalContinuationCoordination.hasWatch(sessionID, wakeup.taskID))) {
            blockedByWatch = true
            return false
          }
          return true
        })
        if (wakeableReceipts.length !== terminalReceipts.length) {
          if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
          return blockedByWatch || pendingTerminalWakeups.has(sessionID) ? "retry" : "blocked"
        }
        for (const receipt of terminalReceipts) {
          const wakeup = latestPending?.get(receipt.receiptID)
          if (wakeup) wakeup.deliveredToMessageID = messageID
        }
        const latestPendingReceipts = await backgroundTaskRuntime!.pendingReceipts({ sessionID })
        const latestPendingReceiptIDs = new Set(latestPendingReceipts.map((receipt) => receipt.receiptID))
        terminalReceipts = terminalReceipts.filter((receipt) => latestPendingReceiptIDs.has(receipt.receiptID))
        if (terminalReceipts.length === 0) {
          if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
          return pendingTerminalWakeups.has(sessionID) ? "retry" : "blocked"
        }
      }
      const sharedContinuations = terminalWakeup
        ? (sharedTerminalContinuationSessions.get(sessionID) ?? new Map<string, SharedTerminalContinuation>())
        : undefined
      let sharedContinuation = sharedContinuations?.get(messageID)
      if (sharedContinuation) {
        terminalReceipts = terminalReceipts.filter((receipt) => sharedContinuation!.receiptIDs.has(receipt.receiptID))
        if (terminalReceipts.length === 0) return "retry"
      }
      const continuationPartID = sharedContinuation?.partID ?? existingContinuation?.partID ?? `prt_${randomUUID()}`
      const automaticTasks = terminalWakeup
        ? continuingTasks
        : continuingTasks.map((task: any) => ({ ...task, kind: task.kind ?? (task.taskID?.startsWith("o4e_command_") ? "command" : "agent") }))
      const continuationPart = sharedContinuation?.part ?? existingContinuation?.part ?? o4eSyntheticPart({
        id: continuationPartID,
        sessionID,
        messageID,
        type: "text",
        text: backgroundTaskAutomaticContinuation(automaticTasks, terminalReceipts, runtimeSnapshot()?.runtime.config.language),
        metadata: o4ePartMetadata("background-task-continuation"),
      }) as any
      if (terminalWakeup) {
        if (!sharedContinuation) {
          sharedContinuation = {
            messageID,
            partID: continuationPartID,
            part: continuationPart,
            receiptIDs: new Set(terminalReceipts.map((receipt) => receipt.receiptID)),
            messageUpdated: false,
            pendingPartIDs: new Set([continuationPartID]),
            persisted: false,
            retryRequested: false,
            createdAt: Date.now(),
          }
          sharedContinuations!.set(messageID, sharedContinuation)
          sharedTerminalContinuationSessions.set(sessionID, sharedContinuations!)
          while (sharedContinuations!.size > 512) {
            const removable = [...sharedContinuations!.entries()]
              .filter(([, continuation]) => continuation.persisted && !continuation.submission)
              .sort(([, left], [, right]) => left.createdAt - right.createdAt)[0]
              ?? [...sharedContinuations!.entries()].sort(([, left], [, right]) => left.createdAt - right.createdAt)[0]
            if (!removable) break
            sharedContinuations!.delete(removable[0])
          }
        }
        if (!existingContinuation && !sharedContinuation.persisted) {
          continuations!.set(messageID, {
            messageUpdated: false,
            partID: sharedContinuation.partID,
            part: sharedContinuation.part,
            pendingPartIDs: new Set([continuationPartID]),
            receiptIDs: new Set(sharedContinuation.receiptIDs),
          })
        }
        pendingSyntheticContinuations.set(sessionID, continuations!)
      }
      const submit = () => terminalContinuationCoordination.serializeSubmission<SharedTerminalSubmissionDecision | any>(sessionID, async () => {
        const control = automaticFollowControl(sessionO4E(await sessionStore.get(sessionID)))
        if (!lifecycle.isActive() || !control.enabled || automaticTaskFollow.isSuppressed(sessionID)
          || terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch
          || terminalContinuationCoordination.hasUserTurn(sessionID)
          || (pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0) {
          return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        if (terminalWakeup) {
          if (terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch || terminalContinuationCoordination.hasUserTurn(sessionID)) {
            return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
          }
          const unavailableBeforeSubmit = terminalReceipts.some((receipt) => (
            terminalContinuationCoordination.isReceiptUnavailable(sessionID, receipt.receiptID)
          ))
          if (unavailableBeforeSubmit) return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        if (automaticClaim && !automaticTaskFollow.current(sessionID, automaticClaim)) {
          return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        if (terminalWakeup && !automaticTaskFollow.admitTerminalSubmission(sessionID, messageID)) {
          await failAutomaticFollow(sessionID, { epoch: userEpoch, revision: initialFollowControl.revision })
          return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        const continuation = {
          messageID,
          ...(remembered.agent ? { agent: remembered.agent } : {}),
          ...(remembered.model ? { model: remembered.model } : {}),
          ...(remembered.variant ? { variant: remembered.variant } : {}),
          parts: [continuationPart],
        }
        const ownerContinuation = await backgroundTaskRuntime!.continueOwner(sessionID, continuation)
        if (ownerContinuation.managed) {
          return ownerContinuation.accepted ? {} : { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        if (!lifecycle.isActive() || automaticTaskFollow.isSuppressed(sessionID)
          || terminalContinuationCoordination.userTurnEpoch(sessionID) !== userEpoch
          || terminalContinuationCoordination.hasUserTurn(sessionID)
          || (pendingPersistedUserMessages.get(sessionID)?.size ?? 0) > 0
          || (automaticClaim && !automaticTaskFollow.current(sessionID, automaticClaim))) {
          return { o4eTerminalSubmission: "unavailable" satisfies SharedTerminalSubmissionDecision }
        }
        return client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: sessionDirectory },
            body: continuation,
          })
      })
      let submission = sharedContinuation?.submission
      if (!submission) {
        submission = submit()
        if (sharedContinuation) sharedContinuation.submission = submission
      }
      let result
      try {
        result = await submission
      } finally {
        if (sharedContinuation?.submission === submission) sharedContinuation.submission = undefined
      }
      if (result?.o4eTerminalSubmission === "consumed") {
        if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
        return pendingTerminalWakeups.has(sessionID) ? "retry" : "blocked"
      }
      if (result?.o4eTerminalSubmission === "unavailable") {
        if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
        return "retry"
      }
      if (!result?.error) {
            if (sharedContinuation) {
              sharedContinuation.retryRequested = false
              sharedContinuation.fallbackAcceptedAt = undefined
              sharedContinuation.fallbackObservedActive = false
            }
        automaticAccepted = true
        return terminalWakeup && !sharedContinuation?.persisted ? "retry" : "submitted"
      }
      if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
      dbg(`[${COMPONENT}] 父 Session 自动续接未受理: ${String(result.error)}`)
      if (!terminalWakeup) await failAutomaticFollow(sessionID, { epoch: userEpoch, revision: initialFollowControl.revision, claim: automaticClaim })
    } catch (error) {
      if (processedParentIdleMessages.get(sessionID) === anchorMessageID) processedParentIdleMessages.delete(sessionID)
      dbg(`[${COMPONENT}] 父 Session 自动续接失败: ${error instanceof Error ? error.message : String(error)}`)
      if (!terminalWakeup) await failAutomaticFollow(sessionID, { epoch: userEpoch, revision: initialFollowControl.revision, claim: automaticClaim })
    } finally {
      if (automaticClaim) automaticTaskFollow.finish(sessionID, automaticClaim, {
        accepted: automaticAccepted,
        taskEvents,
        commandTasks: visibleCommandTasks.map((task: any) => ({
          taskID: task.taskID,
          revision: task.revision,
          unfinished: ["queued", "running"].includes(task.status),
        })),
      })
    }
    return terminalWakeup ? "retry" : "blocked"
  }
  processTerminalWakeup = async (sessionID: string) => {
    const pending = pendingTerminalWakeups.get(sessionID)
    if (!pending?.size || !lifecycle.isActive() || unpersistedFollowFailures.has(sessionID) || automaticTaskFollow.isSuppressed(sessionID)) return "blocked"
    const existing = terminalWakeupOperations.get(sessionID)
    if (existing) return existing
    const epoch = terminalContinuationCoordination.userTurnEpoch(sessionID)
    const controlEpoch = followControlEpochs.get(sessionID) ?? 0
    const current = () => lifecycle.isActive()
      && terminalContinuationCoordination.userTurnEpoch(sessionID) === epoch
      && (followControlEpochs.get(sessionID) ?? 0) === controlEpoch
      && !terminalContinuationCoordination.hasUserTurn(sessionID)
    const operation = (async () => {
      let revision: number | undefined
      try {
        const statuses = await sessionStore.status()
        if (!current() || ["busy", "retry"].includes(statuses?.[sessionID]?.type)) return "blocked"
        const control = automaticFollowControl(sessionO4E(await sessionStore.get(sessionID)))
        revision = control.revision
        if (!current() || !control.enabled) return "blocked"
        const result = await continueParentSession({ kind: "background-task-terminal", sessionID }, { terminalWakeup: true })
        return result === "blocked" && pendingSyntheticContinuations.get(sessionID)?.size ? "retry" : result
      } catch {
        if (!current()) return "blocked"
        const previous = terminalCheckFailures.get(sessionID)
        const sameIntent = previous?.epoch === epoch
          && (revision === undefined || previous.revision === undefined || previous.revision === revision)
        const count = sameIntent ? previous.count + 1 : 1
        const knownRevision = revision ?? (sameIntent ? previous.revision : undefined)
        terminalCheckFailures.set(sessionID, { epoch, revision: knownRevision, count })
        dbg(`[${COMPONENT}] 终态续接检查失败 (${count}/${TERMINAL_CHECK_FAILURE_LIMIT})`)
        if (count >= TERMINAL_CHECK_FAILURE_LIMIT) {
          try {
            if (knownRevision === undefined) throw new Error("O4E_FOLLOW_CONTROL_UNCONFIRMED")
            await failAutomaticFollow(sessionID, { epoch, revision: knownRevision })
          } catch {
            if (current()) {
              unpersistedFollowFailures.set(sessionID, { revision })
              automaticTaskFollow.suppress(sessionID)
              dbg(`[${COMPONENT}] automatic-follow-failed: persistence unconfirmed; local coordination stopped`)
            }
          }
          if (current() && automaticTaskFollow.isSuppressed(sessionID)) {
            for (const timers of [terminalWakeupTimers, automaticFollowTimers]) {
              const timer = timers.get(sessionID)
              if (timer) clearTimeout(timer)
              timers.delete(sessionID)
            }
          }
          return "blocked"
        }
        return "retry"
      }
    })()
    terminalWakeupOperations.set(sessionID, operation)
    try {
      return await operation
    } finally {
      if (terminalWakeupOperations.get(sessionID) === operation) terminalWakeupOperations.delete(sessionID)
    }
  }
  processAutomaticFollow = async (sessionID: string) => {
    if (!lifecycle.isActive() || unpersistedFollowFailures.has(sessionID) || automaticTaskFollow.isSuppressed(sessionID)) return "blocked"
    const epoch = terminalContinuationCoordination.userTurnEpoch(sessionID)
    const control = automaticFollowControl(sessionO4E(await sessionStore.get(sessionID)))
    try { return await continueParentSession({ kind: "session-idle", sessionID }) }
    catch (error) { await failAutomaticFollow(sessionID, { epoch, revision: control.revision }); throw error }
  }
  const failAutomaticFollow = async (sessionID: string, { epoch, revision, claim }: any) => {
    const current = () => lifecycle.isActive()
      && terminalContinuationCoordination.userTurnEpoch(sessionID) === epoch
      && !terminalContinuationCoordination.hasUserTurn(sessionID)
      && (!claim || automaticTaskFollow.current(sessionID, claim))
    if (!current()) return
    let changed = false
    await sessionStore.updateO4E(sessionID, (o4e: any) => {
      if (!current() || automaticFollowControl(o4e).revision !== revision) return o4e
      changed = true
      return updateAutomaticFollowControl(o4e, {
        expectedRevision: revision, enabled: false, diagnostic: "automatic-follow-failed",
      })
    })
    if (changed && current()) automaticTaskFollow.suppress(sessionID)
  }
  const confirmPersistedUserMessage = (sessionID: string, messageID: string) => {
    const messages = pendingPersistedUserMessages.get(sessionID)
    const candidate = messages?.get(messageID)
    if (!candidate?.registrationComplete || !candidate.messageUpdated || candidate.pendingPartIDs.size > 0) return false
    messages!.delete(messageID)
    if (messages!.size === 0) pendingPersistedUserMessages.delete(sessionID)
    const pendingWakeups = pendingTerminalWakeups.get(sessionID)
    for (const receiptID of candidate.deliveredReceiptIDs) {
      rememberUserDeliveredReceipt(receiptID)
      pendingWakeups?.delete(receiptID)
    }
    if (pendingWakeups?.size === 0) {
      pendingTerminalWakeups.delete(sessionID)
      const timer = terminalWakeupTimers.get(sessionID)
      if (timer) clearTimeout(timer)
      terminalWakeupTimers.delete(sessionID)
      terminalWakeupRetryCounts.delete(sessionID)
      terminalWakeupBatchStartedAt.delete(sessionID)
    }
    backgroundTaskRuntime?.notifyUserMessagePersisted({ sessionID, messageID })
    terminalContinuationCoordination.markUserTurnPersisted(sessionID, candidate.userTurnClaimID)
    return true
  }
  const confirmSyntheticContinuation = (sessionID: string, messageID: string) => {
    const continuations = pendingSyntheticContinuations.get(sessionID)
    const continuation = continuations?.get(messageID)
    const sharedContinuation = sharedTerminalContinuationSessions.get(sessionID)?.get(messageID)
    const sharedPersisted = sharedContinuation ? terminalContinuationCoordination.markPersisted(sessionID, messageID) : false
    const persisted = sharedPersisted || Boolean(continuation?.messageUpdated && continuation.pendingPartIDs.size === 0)
    if (!persisted) return false
    if (!sharedPersisted && continuation) rememberPersistedSyntheticContinuation(sessionID, messageID, continuation.receiptIDs)
    return true
  }
  const processRuntimeEvent = async (runtimeEvent: any) => {
    if (commandTaskRuntime && runtimeEvent.kind === "deleted" && typeof runtimeEvent.sessionID === "string") {
      await commandTaskRuntime.cancelKnown(runtimeEvent.sessionID)
    }
    if (typeof runtimeEvent.sessionID === "string" && runtimeEvent.kind === "error"
      && ["MessageAbortedError", "AbortError"].includes(runtimeEvent.error?.name)) {
      const session = await sessionStore.get(runtimeEvent.sessionID).catch(() => undefined)
      if (sessionO4E(session).task === undefined) {
        automaticTaskFollow.suppress(runtimeEvent.sessionID)
        const timer = automaticFollowTimers.get(runtimeEvent.sessionID)
        if (timer) clearTimeout(timer)
        automaticFollowTimers.delete(runtimeEvent.sessionID)
      } else if (commandTaskRuntime) await stopCommands(runtimeEvent.sessionID)
    }
    // Idle events have no dispatch identity and may wait behind host I/O. Let
    // the Agent Runtime inspect its frozen dispatch below; inspectTurn rechecks
    // that generation and current host activity before stopping child commands.
    let observedBackgroundOwnerSessionID: string | undefined
    if (
      typeof runtimeEvent.sessionID === "string"
      && (
        runtimeEvent.kind === "session-idle"
        || (runtimeEvent.kind === "session-status" && ["busy", "retry", "idle"].includes(runtimeEvent.status?.type))
      )
    ) {
      const statusUserTurnEpoch = Number.isSafeInteger(runtimeEvent.userTurnEpoch)
        ? runtimeEvent.userTurnEpoch
        : terminalContinuationCoordination.userTurnEpoch(runtimeEvent.sessionID)
      terminalContinuationCoordination.settlePersistedUserTurnsThrough(runtimeEvent.sessionID, statusUserTurnEpoch)
      if (
        runtimeEvent.kind === "session-status"
        && ["busy", "retry"].includes(runtimeEvent.status?.type)
      ) {
        for (const continuation of sharedTerminalContinuationSessions.get(runtimeEvent.sessionID)?.values() ?? []) {
          if (continuation.fallbackAcceptedAt !== undefined) continuation.fallbackObservedActive = true
        }
      }
    }
    if (
      runtimeEvent.kind === "message-updated"
      && runtimeEvent.messageRole === "user"
      && typeof runtimeEvent.sessionID === "string"
      && typeof runtimeEvent.messageID === "string"
    ) {
      const candidate = pendingPersistedUserMessages.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (candidate) {
        candidate.messageUpdated = true
        confirmPersistedUserMessage(runtimeEvent.sessionID, runtimeEvent.messageID)
      }
      const continuation = pendingSyntheticContinuations.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (continuation) {
        continuation.messageUpdated = true
      }
      const sharedContinuation = sharedTerminalContinuationSessions.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (sharedContinuation) sharedContinuation.messageUpdated = true
      if (continuation || sharedContinuation) confirmSyntheticContinuation(runtimeEvent.sessionID, runtimeEvent.messageID)
    }
    if (
      runtimeEvent.kind === "message-part-updated"
      && typeof runtimeEvent.sessionID === "string"
      && typeof runtimeEvent.messageID === "string"
      && typeof runtimeEvent.partID === "string"
    ) {
      const candidate = pendingPersistedUserMessages.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (candidate) {
        candidate.persistedPartIDs.add(runtimeEvent.partID)
        candidate.pendingPartIDs.delete(runtimeEvent.partID)
        confirmPersistedUserMessage(runtimeEvent.sessionID, runtimeEvent.messageID)
      }
      const continuation = pendingSyntheticContinuations.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (continuation) {
        continuation.pendingPartIDs.delete(runtimeEvent.partID)
      }
      const sharedContinuation = sharedTerminalContinuationSessions.get(runtimeEvent.sessionID)?.get(runtimeEvent.messageID)
      if (sharedContinuation) sharedContinuation.pendingPartIDs.delete(runtimeEvent.partID)
      if (continuation || sharedContinuation) confirmSyntheticContinuation(runtimeEvent.sessionID, runtimeEvent.messageID)
    }
    const result = await runEventPipeline(runtimeEvent, {
      fallback: modelFallback,
      taskObserver: async (observedEvent) => {
        const foreground = await delegationRuntime?.observeEvent(observedEvent)
        if (foreground?.managed) return foreground
        const background = await backgroundTaskRuntime?.observeEvent(observedEvent, { dispatch: false })
        if (background?.managed && typeof background.ownerSessionID === "string") observedBackgroundOwnerSessionID = background.ownerSessionID
        return background
      },
    })
    if (observedBackgroundOwnerSessionID) {
      backgroundTaskRuntime?.dispatchRecoverableTasks(observedBackgroundOwnerSessionID)
      scheduleAutomaticFollow(observedBackgroundOwnerSessionID)
    }
    if (runtimeEvent.kind === "error" && typeof runtimeEvent.sessionID === "string") {
      const errorUserTurnEpoch = Number.isSafeInteger(runtimeEvent.userTurnEpoch)
        ? runtimeEvent.userTurnEpoch
        : terminalContinuationCoordination.userTurnEpoch(runtimeEvent.sessionID)
      const pending = pendingPersistedUserMessages.get(runtimeEvent.sessionID)
      for (const [messageID, candidate] of pending ?? []) {
        if (candidate.userTurnEpoch <= errorUserTurnEpoch) pending!.delete(messageID)
      }
      if (pending?.size === 0) pendingPersistedUserMessages.delete(runtimeEvent.sessionID)
      processedParentIdleMessages.delete(runtimeEvent.sessionID)
      terminalContinuationCoordination.clearOwnedUserTurnsThrough(runtimeEvent.sessionID, errorUserTurnEpoch)
      for (const continuation of sharedTerminalContinuationSessions.get(runtimeEvent.sessionID)?.values() ?? []) {
        if (continuation.persisted && continuation.fallbackAcceptedAt === undefined) continuation.retryRequested = true
      }
      if (pendingTerminalWakeups.has(runtimeEvent.sessionID)) scheduleTerminalWakeup(runtimeEvent.sessionID, { retry: true })
    }
    if (runtimeEvent.kind === "deleted" && typeof runtimeEvent.sessionID === "string") {
      parentPromptContexts.delete(runtimeEvent.sessionID)
      processedParentIdleMessages.delete(runtimeEvent.sessionID)
      pendingPersistedUserMessages.delete(runtimeEvent.sessionID)
      pendingSyntheticContinuations.delete(runtimeEvent.sessionID)
      terminalContinuationCoordination.deleteSession(runtimeEvent.sessionID)
      pendingTerminalWakeups.delete(runtimeEvent.sessionID)
      const timer = terminalWakeupTimers.get(runtimeEvent.sessionID)
      if (timer) clearTimeout(timer)
      terminalWakeupTimers.delete(runtimeEvent.sessionID)
      terminalWakeupRetryCounts.delete(runtimeEvent.sessionID)
      terminalCheckFailures.delete(runtimeEvent.sessionID)
      unpersistedFollowFailures.delete(runtimeEvent.sessionID)
      followControlEpochs.delete(runtimeEvent.sessionID)
      terminalWakeupBatchStartedAt.delete(runtimeEvent.sessionID)
      terminalWakeupOperations.delete(runtimeEvent.sessionID)
      automaticTaskFollow.deleteSession(runtimeEvent.sessionID)
      const automaticTimer = automaticFollowTimers.get(runtimeEvent.sessionID)
      if (automaticTimer) clearTimeout(automaticTimer)
      automaticFollowTimers.delete(runtimeEvent.sessionID)
      return result
    }
    const terminalWakeup = typeof runtimeEvent.sessionID === "string" && pendingTerminalWakeups.has(runtimeEvent.sessionID)
    if (terminalWakeup) {
      const continuation = await processTerminalWakeup(runtimeEvent.sessionID)
      if (continuation === "retry") scheduleTerminalWakeup(runtimeEvent.sessionID, { retry: true })
    }
    if (
      typeof runtimeEvent.sessionID === "string"
      && !observedBackgroundOwnerSessionID
      && (runtimeEvent.kind === "session-idle" || (runtimeEvent.kind === "session-status" && runtimeEvent.status?.type === "idle"))
    ) await processAutomaticFollow(runtimeEvent.sessionID)
    return result
  }
  let eventDrain: Promise<void> | undefined
  drainRuntimeEvents = async () => {
    if (lifecycle.state() === "disposed" || pendingRuntimeEvents.length === 0) return
    while (lifecycle.state() !== "disposed" && pendingRuntimeEvents.length > 0) {
      if (!eventDrain) {
        eventDrain = (async () => {
          while (lifecycle.state() !== "disposed" && pendingRuntimeEvents.length > 0) {
            try { await processRuntimeEvent(pendingRuntimeEvents[0]) }
            catch (error) {
              // A deleted owner cannot be reread by replaying a global event.
              // Report this failure once; Runtime retains its unsettled locks
              // and disposal still retries the known commands independently.
              if (pendingRuntimeEvents[0]?.kind === "deleted") pendingRuntimeEvents.shift()
              throw error
            }
            pendingRuntimeEvents.shift()
          }
        })()
      }
      const draining = eventDrain
      try {
        await draining
      } finally {
        if (eventDrain === draining) eventDrain = undefined
      }
    }
  }
  const authorizeDelegation = async (args: any, context: any, toolName: string, metadata: any) => {
    const prepared = await delegationRuntime!.prepare(args, context, toolName, { permissionApproved: true })
    if (prepared.status !== "selected") return false
    if (typeof context.ask !== "function") throw new Error(`发起 Agent 的 ${toolName} 目标尚未获得本次授权: ${prepared.requester.name} -> ${prepared.target.name}`)
    await context.ask({
      permission: toolName,
      patterns: [prepared.target.name],
      always: ["*"],
      metadata: typeof metadata === "function" ? metadata(prepared) : metadata,
    })
    return prepared.requesterPermissionAction === "ask"
  }
  const assertAgentTaskOwner = async (owner: any, context: any, taskIDs?: string[]) => {
    if (owner?.parentID !== undefined || sessionO4E(owner).kind === "delegation-attempt") {
      await delegationRuntime!.delegationAuthority(context)
    }
    const refs = sessionO4E(owner).backgroundTasks?.taskRefs ?? {}
    if (taskIDs?.some((taskID) => !Object.hasOwn(refs, taskID))) throw new Error("O4E_TASK_MANAGEMENT_DENIED")
  }
  const watchTasks = async (args: any, rawContext: any) => {
    const normalized = normalizeTaskToolArgs(args)
    const budget = createTaskReadBudget(normalized, runtimeContext(rawContext))
    const context = budget.context
    const wait = (operation: () => Promise<any>) => context.readWait(() => trackRuntimeOperation(operation))
    try { return await trackRuntimeOperation(async () => {
      await wait(() => ensureRuntimeRecovery(context.sessionID))
      const snapshot = runtimeSnapshot()
      const agent = snapshot?.agentByName.get(context.agent)
      const owner = await wait(() => sessionStore.get(context.sessionID))
      const permission = agent ? effectiveAgentPermission(agent, {
        agents: snapshot!.agents, managedMcp: snapshot!.runtime.config.mcp,
      }) : undefined
      const canManageAgents = agent && (["primary", "all"].includes(agent.type)
        || (agent.type === "subagent" && permissionAction(permission, TASK_TOOL, "agent:watch") !== "deny"))
      const ids: string[] | undefined = normalized.taskIDs
      // Freeze both kinds from the same owner snapshot before permission waits.
      const commandIDs = ids?.filter((id) => id.startsWith("o4e_command_"))
        ?? Object.keys(sessionO4E(owner).commandTasks?.refs ?? {})
      const agentIDs = ids?.filter((id) => !id.startsWith("o4e_command_"))
        ?? Object.keys(sessionO4E(owner).backgroundTasks?.taskRefs ?? {})
      // Request permissions only for kinds actually present in the frozen
      // selection. Empty selectors and owners without a kind must not trigger
      // unrelated host permission prompts.
      const includeAgents = agentIDs.length > 0
      const includeCommands = commandIDs.length > 0
      for (const kind of [includeAgents ? "agent" : undefined, includeCommands ? "command" : undefined].filter(Boolean)) {
        if ((kind === "agent" && !canManageAgents) || !context.agent
          || (permission && permissionAction(permission, TASK_TOOL, `${kind}:watch`) === "deny")) {
          throw new Error(kind === "agent" ? "O4E_TASK_MANAGEMENT_DENIED" : "O4E_COMMAND_MANAGEMENT_DENIED")
        }
        if (kind === "agent") await wait(() => assertAgentTaskOwner(owner, context, agentIDs))
        if (typeof context.ask !== "function") throw new Error("O4E_TASK_ASK_REQUIRED")
        await wait(() => context.ask({ permission: TASK_TOOL, patterns: [`${kind}:watch`], always: [], metadata: {} }))
      }
      const commandWatch = includeCommands ? await wait(() => commands().watchSelection(commandIDs, context)) : undefined
      const agentTasks = !includeAgents ? [] : (await Promise.all(agentIDs.map((taskID) =>
        wait(() => backgroundTaskRuntime!.status({ taskID }, context)))))
        .filter((task: any) => ids !== undefined || task.receipt?.acknowledgedAt === undefined)
      const selected = [...agentTasks, ...(commandWatch ? await wait(commandWatch.tasks) : [])]
      const initialTasks = selected.map((task: any) => ({
        taskID: task.taskID, kind: task.kind, agent: task.agent, status: task.status, phase: task.phase,
      }))
      const detail = runtimeSnapshot()?.runtime.config.enable_o4e_task_detail === true
      if (detail) await wait(() => publishToolMetadata(context, {
        title: watchToolTitle(initialTasks, "watching"),
        metadata: { action: "watch", reason: "watching", tasks: initialTasks },
      })).catch(() => context.abort?.throwIfAborted())
      const result = JSON.parse(await backgroundTaskRuntime!.handle({
        ...normalized, taskIDs: agentTasks.map((task: any) => task.taskID),
      }, { ...context, commandWatch, validateWatchResult: validateWatchToolResult }))
      for (const task of result.tasks ?? []) {
        if (task.taskID?.startsWith("o4e_command_") && !["queued", "running"].includes(task.status)) automaticTaskFollow.commandDelivered(context.sessionID, task)
      }
      const names = new Map(selected.map((task: any) => [task.taskID, task.agent]))
      const displayTasks = result.tasks.map((task: any) => ({ ...task, agent: names.get(task.taskID) }))
      const display = taskToolResult(JSON.stringify(result), "watch", {
        action: "watch", reason: result.reason, waitedMs: result.waitedMs, tasks: displayTasks,
      }, detail)
      if (detail) display.title = watchToolTitle(displayTasks, result.reason)
      if (detail && !budget.committed) {
        const { o4eResult, ...metadata } = display.metadata
        await wait(() => publishToolMetadata(context, { title: display.title, metadata }))
          .catch(() => context.abort?.throwIfAborted())
      }
      return display
    }) } finally { budget.close() }
  }
  return {
    tool: {
      bash: tool({
        description: "Execute Bash directly as a durable command Task, without delegating to an Agent. Applies to all Agents, including native keep/build/plan. The configured OpenCode host shell is used unchanged across supported platforms. Supports normal shell syntax, including scripts, Unicode, expansions, assignments, loops, functions, pipelines and heredocs. Commands are passed unchanged to the host shell after host permission approval. Queued admission returns after about 1 second; running commands return a durable taskID after about 10 seconds so the AI can continue and inspect the latest retained tail via o4e_task. timeout independently limits execution (default 120000 ms). A running/heartbeat preview is not completion. The original Shell card continues accumulating captured text after detachment, only for the user (up to 256 MiB with explicit incompleteness beyond this limit). If still running, model-facing text contains only the taskID and necessary controls; call o4e_task output to read content and watch/status for state. Default watch monitors both Agents and commands. Successful small terminal output is exact captured text, including whitespace and empty output; failure, truncation and incomplete logs have separate minimal control lines. Full UTF-8 text logs are private outside the repository, retained for 24 hours after settlement with lazy cleanup and active-log protection, capped at 256 MiB per command. Use an authorized file reader to page logPath; logComplete:false/logError never promises a full archive. Root idle preserves detached commands; explicit cancellation, owner deletion, child lifecycle termination and disposal still stop them. Commands inherit the launch environment and normal host-shell behavior; the public plugin API does not expose other plugins' shell.env hooks.",
        args: {
          command: tool.schema.string().min(1),
          description: tool.schema.string().min(1),
          workdir: tool.schema.string().optional(),
          timeout: tool.schema.number().int().min(1).max(2147483647).optional(),
        },
        execute: async (args, context) => {
          if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
          // Host schema validation is not guaranteed; adapters may fill
          // optional fields with no-information values. Treat blank workdir
          // and non-positive timeout as omitted rather than failing.
          if (args.workdir === null || (typeof args.workdir === "string" && !args.workdir.trim())) delete args.workdir
          if (args.timeout !== undefined && (!Number.isSafeInteger(args.timeout) || args.timeout < 1)) delete args.timeout
          return trackRuntimeOperation(async () => {
            context = runtimeContext(context)
            context.abort?.throwIfAborted()
            if (!context.messageID || !context.callID) throw new Error("O4E_COMMAND_SOURCE_REQUIRED")
            await ensureRuntimeRecovery(context.sessionID)
            const authority = await delegationRuntime!.commandAuthority(context)
            const sessionPermission = structuredClone((await sessionStore.get(context.sessionID))?.permission)
            const authorized = await authorizeBash(args, context, {
              directory: sessionDirectory, worktree, shell: commandShell, permission: authority.permission,
            })
            let initialReaderActive = true
            const revalidate = async () => {
              if (initialReaderActive) context.abort?.throwIfAborted()
              if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
              const current = await delegationRuntime!.commandAuthority(context)
              if (!isDeepStrictEqual(current, authority)
                || !isDeepStrictEqual((await sessionStore.get(context.sessionID))?.permission, sessionPermission)) {
                throw new Error("O4E_COMMAND_AUTHORITY_CHANGED")
              }
            }
            await revalidate()
            const runtime = commands()
            const card = createCommandCard({ client, directory: sessionDirectory, context, title: args.description })
            commandCards.add(card)
            let stopDisplay = () => {}
            void card.done.then(() => { stopDisplay(); commandCards.delete(card) })
            let task
            try {
              task = await runtime.start(authorized, context, { ...authority, beforeStart: revalidate, onOutput: card.append })
            } catch (error) { card.dispose(); throw error }
            card.setTaskID(task.taskID)
            automaticTaskFollow.trackCommand(context.sessionID, task.taskID)
            try {
              const displayState = (snapshot: any) => {
                if (!["queued", "running"].includes(snapshot.status)) card.finish(snapshot)
              }
              stopDisplay = runtime.observe(task.taskID, context, (snapshot: any) => {
                displayState(snapshot)
                scheduleAutomaticFollow(context.sessionID)
              })
              displayState(task)
              const cancel = () => {
                void trackRuntimeOperation(() => runtime.cancelKnown(context.sessionID, task.taskID)).catch(() => undefined)
              }
              context.abort?.addEventListener("abort", cancel, { once: true })
              commandAbortListeners.get(task.taskID)?.()
              commandAbortListeners.set(task.taskID, () => context.abort?.removeEventListener("abort", cancel))
              if (context.abort?.aborted) cancel()
              const result = await runtime.waitInitial(task.taskID, context, commandWaitOptions)
              if (!["queued", "running"].includes(result.status)) automaticTaskFollow.commandDelivered(context.sessionID, result)
              if (["queued", "running"].includes(result.status)) {
                initialReaderActive = false
                // Detachment is a successful end of the original Bash reader, so a
                // later host abort for that reader must not cancel the command.
                commandAbortListeners.get(task.taskID)?.()
                commandAbortListeners.delete(task.taskID)
              }
              if (result.stopped && !["queued", "running"].includes(result.status)) {
                commandAbortListeners.get(task.taskID)?.()
                commandAbortListeners.delete(task.taskID)
              }
              const display = commandToolResult(result, "execute")
              card.detach(result)
              display.metadata.output = card.output()
              if (!["queued", "running"].includes(result.status)) card.finish(result)
              return display
            } catch (error) { card.dispose(); throw error }
          })
        },
      }),
      [AGENT_TASK_TOOL]: tool({
        description: "Canonical and only entry for managed Agent delegation. Use description, prompt, and subagent_type. The top-level O4E maxDelegationDepth defaults to 2 and accepts integers 1..5: root depth is 0 and each Agent task adds 1. Main-Session Workflow Steps do not add delegation depth. At the limit, act directly or report the help needed instead of delegating. Do not change configuration yourself to bypass the limit. Omit background for normal delegation so Runtime starts a background Task. Set background=false only when the user explicitly requests synchronous or foreground delegation; dependency on the result is not sufficient. Preserve the returned taskID and, before any dependent action or final response, call o4e_task watch without timeoutMs (30-minute default window). Watch returns for any new terminal or actionable event; one event does not imply group completion. After heartbeat or actionable, first report a meaningful current status to the user before calling the next watch; for completed Tasks, call o4e_task output before reporting, and report failed/cancelled/unknown/interrupted/explicit-wait states without claiming success. On user-message, handle the newest user instruction first; terminal states and explicit waits take priority over heartbeat previews. Continue watching pending dependencies after the report when needed. Runtime does not synthesize heartbeat progress messages or guarantee intermediate TUI visibility. The child Session is linked through the native OpenCode task card.",
        args: agentTaskArgs,
        execute: async (args, context) => {
          if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
          const normalized = normalizeAgentTaskArgs(args)
          return trackRuntimeOperation(async () => {
            context = runtimeContext(context)
            await ensureRuntimeRecovery(context.sessionID)
            if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
            const onSession = (input: any) => publishTaskMetadata(context, input)
            const permissionApproved = await authorizeDelegation(normalized, context, AGENT_TASK_TOOL, {
              description: args.description,
              subagent_type: args.subagent_type,
            })
            if (isExplicitForegroundDelegation(args)) {
              const output = await delegationRuntime!.delegate(normalized, context, { toolName: AGENT_TASK_TOOL, onSession, permissionApproved })
              return agentTaskResult(output, { description: args.description, background: false, parentSessionId: context.sessionID })
            }
            const output = await backgroundTaskRuntime!.startAgent(normalized, context, { toolName: AGENT_TASK_TOOL, onSession, permissionApproved })
            automaticTaskFollow.activate(context.sessionID)
            return agentTaskResult(output, { description: args.description, background: true, parentSessionId: context.sessionID })
          })
        },
      }),
      [TASK_TOOL]: tool({
        description: O4E_TASK_DESCRIPTION + " Cancel Agent and Command Tasks with only action:cancel and taskID; reason is not an input field for any action. Root managed primary/all callers can read action:follow, then persist enabled:false|true with expectedRevision to stop/resume owner automatic tracking. Follow accepts no Task selector, never cancels Tasks, and an explicit stop persists across ordinary user turns. On automatic-follow-failed read follow state and explicitly resume when authorized.",
        args: {
          action: tool.schema.enum(["status", "watch", "inspect", "output", "input", "resume", "cancel", "resolve", "pending", "permission.reply", "question.reply", "question.reject", "follow"]),
          enabled: tool.schema.boolean().optional().describe("Follow only: persist owner automatic tracking on/off; omit to read. Changes require expectedRevision. Does not cancel tasks."),
          taskID: tool.schema.string().optional().describe("Select one Agent or command Task. Required for inspect/output/cancel and command status/pending; omit selectors for watch to monitor all owned Agent and Bash Tasks"),
          taskIDs: tool.schema.array(tool.schema.string()).optional().describe("Watch only: explicit Agent and/or command Task IDs; omit to watch all owned Tasks, [] selects nothing"),
          cursor: tool.schema.string().min(1).max(512).refine((value) => value.trim().length > 0).optional().describe("Inspect only: opaque cursor from a prior response, not authorization. Agent cursors use the current compact format, at most 120 characters"),
           direction: tool.schema.enum(["forward", "backward"]).optional().describe("Inspect only, default forward; use beforeCursor with backward for earlier data when provided"),
           maxBytes: tool.schema.number().int().min(4).max(8192).optional().describe("Inspect only: UTF-8 tail byte budget, default 1024, range 4..8192. Does not bound SDK message/Part downloads"),
           timeoutMs: tool.schema.number().int().min(0).max(WATCH_MAX_TIMEOUT_MS).optional().describe("Watch-only window in milliseconds, maximum 3600000 (one hour). Omitted or zero uses the 1800000 ms (30-minute) default; a positive value selects the window. Heartbeat is not Task completion"),
          resume: tool.schema.boolean().optional().describe("Inspect only: true resumes from this parent Session's latest persisted inspect automatically; never supply cursor with resume. Backward inspect uses its beforeCursor. Missing/invalid history reports unavailable, never silently skips to the live tail. Omit/false for an explicit fresh tail."),
           ioTimeoutMs: tool.schema.number().int().min(1).max(60_000).optional().describe("Inspect/watch only: total read-call I/O allowance, default 10000 ms. Inspect deadline is this allowance; watch deadline is its window plus this allowance. Receipt commits already admitted must settle; timeout does not cancel the Task or shared recovery."),
          input: tool.schema.string().optional().describe("Additional instruction for the same child Session; requires expectedRevision"),
          delivery: tool.schema.enum(["queue", "steer"]).optional().describe("Input delivery: queue for the next turn (default), or steer to admit input for the next runnable turn; unsupported steer falls back to queue"),
          decision: tool.schema.enum(["continue", "restart", "stop"]).optional(),
          expectedRevision: tool.schema.number().int().min(1).optional().describe("CAS revision for input/resume and interaction replies"),
          requestID: tool.schema.string().optional(),
          reply: tool.schema.enum(["once", "always", "reject"]).optional(),
          message: tool.schema.string().max(512).optional(),
          answers: tool.schema.array(tool.schema.array(tool.schema.string().min(1))).optional(),
        },
        execute: async (args, context) => {
          if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
          const routedArgs = normalizeTaskToolArgs(args)
          if (routedArgs.action === "follow") {
            args = routedArgs
            context = runtimeContext(context)
            return trackRuntimeOperation(async () => {
              const snapshot = runtimeSnapshot()
              const agent = snapshot?.agentByName.get(context.agent)
              const checkOwner = (owner: any) => {
                if (!owner || owner.id !== context.sessionID || owner.parentID !== undefined || sessionO4E(owner).task !== undefined
                  || sessionO4E(owner).delegation !== undefined || !agent || !["primary", "all"].includes(agent.type)
                  || permissionAction(effectiveAgentPermission(agent, { agents: snapshot!.agents, managedMcp: snapshot!.runtime.config.mcp }), TASK_TOOL, "follow") === "deny") {
                  throw new Error("O4E_FOLLOW_MANAGEMENT_DENIED")
                }
              }
              checkOwner(await sessionStore.get(context.sessionID))
              if (typeof context.ask !== "function") throw new Error("O4E_TASK_ASK_REQUIRED")
              await context.ask({ permission: TASK_TOOL, patterns: ["follow"], always: [], metadata: {} })
              context.abort?.throwIfAborted()
              let owner = await sessionStore.get(context.sessionID)
              checkOwner(owner)
              if (args.enabled !== undefined) {
                owner = await sessionStore.updateO4E(context.sessionID, (o4e: any, current: any) => {
                  checkOwner(current)
                  return updateAutomaticFollowControl(o4e, args)
                })
                followControlEpochs.set(context.sessionID, (followControlEpochs.get(context.sessionID) ?? 0) + 1)
                terminalCheckFailures.delete(context.sessionID)
                unpersistedFollowFailures.delete(context.sessionID)
                if (args.enabled) automaticTaskFollow.resume(context.sessionID)
                else automaticTaskFollow.suppress(context.sessionID)
              }
              const control = automaticFollowControl(sessionO4E(owner))
              const unconfirmed = unpersistedFollowFailures.get(context.sessionID)
              if (unconfirmed && !control.enabled && control.diagnostic === "automatic-follow-failed"
                && (unconfirmed.revision === undefined || control.revision > unconfirmed.revision)) {
                unpersistedFollowFailures.delete(context.sessionID)
              }
              const localFailure = unpersistedFollowFailures.has(context.sessionID)
              const result = { action: "follow", ...control,
                ...(localFailure ? { enabled: false, diagnostic: "automatic-follow-failed", persistenceConfirmed: false } : {}),
                ...(control.diagnostic || localFailure ? { recovery: "Read follow state, then set enabled:true with expectedRevision to explicitly retry coordination." } : {}),
                tasksCancelled: false }
              return presentTaskResult({ title: "Automatic task tracking",
                output: JSON.stringify(result), metadata: resultMetadata(result, {}) }, "follow", snapshot?.runtime.config.enable_o4e_task_detail === true)
            })
          }
          args = routedArgs
          if (args.enabled !== undefined) throw new Error("O4E_FOLLOW_INVALID_ARGUMENTS")
          if (args.action === "watch") return watchTasks(args, context)
          const commandSelector = typeof args.taskID === "string" && args.taskID.trim().startsWith("o4e_command_")
          if (Array.isArray(args.taskIDs) && args.taskIDs.some((id) => typeof id === "string" && id.startsWith("o4e_command_"))) {
            throw new Error("O4E_COMMAND_SINGLE_TASK_REQUIRED")
          }
          if (commandSelector) {
            if (args.taskIDs !== undefined || !["status", "watch", "inspect", "output", "cancel", "pending"].includes(args.action)) {
              throw new Error("O4E_COMMAND_UNSUPPORTED_ACTION_OR_SELECTOR")
            }
             const allowed = new Set(["action", "taskID", "cursor", "direction", "maxBytes", "resume", "ioTimeoutMs"])
            if (Object.keys(args).some((key) => !allowed.has(key))) throw new Error("O4E_COMMAND_INVALID_ARGUMENTS")
            const normalized = normalizeTaskToolArgs(args)
            delete normalized.taskIDs
            normalized.taskID = args.taskID.trim()
            context = runtimeContext(context)
            const budget = ["inspect", "watch"].includes(args.action) ? createTaskReadBudget(normalized, context) : undefined
            context = budget?.context ?? context
            const wait = (operation: () => Promise<any>) => context.readWait
              ? context.readWait(() => trackRuntimeOperation(operation)) : operation()
            try { return await trackRuntimeOperation(async () => {
              const snapshot = runtimeSnapshot()
              const agent = snapshot?.agentByName.get(context.agent)
              const resource = `command:${args.action}`
              if (!context.agent || (agent && permissionAction(effectiveAgentPermission(agent, {
                agents: snapshot!.agents, managedMcp: snapshot!.runtime.config.mcp,
              }), TASK_TOOL, resource) === "deny")) throw new Error("O4E_COMMAND_MANAGEMENT_DENIED")
              if (typeof context.ask !== "function") throw new Error("O4E_COMMAND_ASK_REQUIRED")
              await wait(() => context.ask({ permission: TASK_TOOL, patterns: [resource], always: [], metadata: { taskID: args.taskID } }))
              const result = await commands().handle(normalized, context)
              return presentTaskResult(commandToolResult(result, args.action), args.action, runtimeSnapshot()?.runtime.config.enable_o4e_task_detail === true)
            }) } finally { budget?.close() }
          }
          const normalized = normalizeTaskToolArgs(args)
          context = runtimeContext(context)
          const budget = ["inspect", "watch"].includes(normalized.action) ? createTaskReadBudget(normalized, context) : undefined
          context = budget?.context ?? context
          const wait = (operation: () => Promise<any>) => context.readWait
            ? context.readWait(() => trackRuntimeOperation(operation)) : operation()
          try { return await trackRuntimeOperation(async () => {
            await wait(() => ensureRuntimeRecovery(context.sessionID))
            if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
            const snapshot = runtimeSnapshot()
            const agent = snapshot?.agentByName.get(context.agent)
            if (!agent || !["primary", "all", "subagent"].includes(agent.type)
              || permissionAction(effectiveAgentPermission(agent, {
                agents: snapshot!.agents, managedMcp: snapshot!.runtime.config.mcp,
              }), TASK_TOOL, `agent:${normalized.action}`) === "deny") throw new Error("O4E_TASK_MANAGEMENT_DENIED")
            const owner = await wait(() => sessionStore.get(context.sessionID))
            await wait(() => assertAgentTaskOwner(owner, context, typeof normalized.taskID === "string" ? [normalized.taskID.trim()] : normalized.taskIDs))
            if (typeof context.ask !== "function") throw new Error("O4E_TASK_ASK_REQUIRED")
            await wait(() => context.ask({ permission: TASK_TOOL, patterns: [`agent:${normalized.action}`], always: [], metadata: {} }))
            await wait(async () => assertAgentTaskOwner(await sessionStore.get(context.sessionID), context,
              typeof normalized.taskID === "string" ? [normalized.taskID.trim()] : normalized.taskIDs))
            const output = await backgroundTaskRuntime!.handle(normalized, context)
            return taskToolResult(output, normalized.action, {}, runtimeSnapshot()?.runtime.config.enable_o4e_task_detail === true)
          }) } finally { budget?.close() }
        },
      }),
      [WORKFLOW_TOOL]: tool({
        description: "Experimental Beta, disabled unless config.enableWorkflow=true; not production-ready. Main-Agent Workflow checkpoints, not a task scheduler. Use action catalog/list/start/read/begin/report/resume/pause/stop. list accepts only action and returns at most 32 bounded Run summaries for the current owner and caller Agent, with host authorization per visible workflow name; no visible Runs returns runs:[] without asking for hidden names. list is read-only: no recovery, execution, input/output/report/evidence bodies or cross-Session discovery; invalid checkpoints or lost sources fail closed. Use read with runID for checkpoint details and availableEvidence.references verified for the active Attempt. Copy applicable references into report.evidence; never invent messageID/callID or rerun side effects to obtain IDs. start creates no child Session; begin requires stepID and returns work for this Agent to execute directly. begin/report/resume/pause/stop require expectedRevision (copy the latest returned revision). report requires stepID, attemptID, submissionID and exactly {status:reported-completed|failed,output,artifacts:[],evidence:[],diagnostics:[]}. Only accepted outputs advance dependencies. Read and explicitly resume after new user instructions; no side effects are replayed. Explicit task requirements use the existing task tool and its own permissions/lifecycle. Pause/stop never cancel Tasks.",
        args: processToolArgs(tool.schema),
        execute: async (args, context) => {
          if (!workflowRuntime) throw new Error("O4E_WORKFLOW_DISABLED: Experimental Beta requires config.enableWorkflow=true, rebuild and restart. Do not enable it without user authorization.")
          args = normalizeProcessArgs(args)
          validateProcessArgs(args)
          if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
          return trackRuntimeOperation(async () => {
            context = runtimeContext(context)
            return workflowRuntime!.handle(args, context)
          })
        },
      }),
    },
    config: async (config: any) => {
      if (!config || typeof config !== "object") return
      const shell = config.shell
      if (commandPort && shell !== commandShell) throw new Error("O4E_COMMAND_SHELL_CHANGED")
      commandShell = shell
      config.agent = config.agent ?? {}
      const snapshot = runtimeSnapshot()
      if (!snapshot) {
        if (o4eMode === "clear") clearRuntimeModelProjection(config)
        return
      }
      if (o4eMode === "default") resolveConfiguredAgentModels(config, snapshot.agents)
      applyNativeAgentTakeover(config, snapshot.nativeModes, snapshot.nativeAgentStrategies)
      const defaultAgent = snapshot.runtime.config.defaultAgent
      if (defaultAgent !== undefined) {
        if (config.agent?.[defaultAgent]?.disable === true) throw new Error("config.defaultAgent 指向被宿主禁用的 Agent")
        config.default_agent = defaultAgent
      }
      applyConfiguredSystemAgentPrompts(config, snapshot.runtime, snapshot.systemPhaseAgents, projectRoot)
      applyMcpConfig(config, snapshot.runtime.config.mcp)
      if (!snapshot.mcpServerNames) {
        snapshot.mcpServerNames = collectMcpServerNames(snapshot.allAgents, snapshot.runtime.config.mcp, config.mcp)
      }
      applyO4eSkillSource(config, snapshot.runtime)
      applyAgentPolicies(config, snapshot.allAgents, snapshot.runtime.config.mcp, snapshot.mcpServerNames)
      if (o4eMode === "clear") clearRuntimeModelProjection(config)
      dbg(`[${COMPONENT}] 原生 Agent 策略 ${JSON.stringify(snapshot.nativeAgentStrategies)}`)
    },
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      const snapshot = runtimeSnapshot()
      if (!snapshot) return
      takeOver(output, snapshot.runtime, snapshot.agents, snapshot.systemPhaseAgents, sessionDirectory, projectRoot)
      snapshot.soulHandler?.transformSystem(output)
    },
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: { info: any; parts: any[] }[] }) => {
      const snapshot = runtimeSnapshot()
      if (!snapshot || !Array.isArray(output?.messages)) return
      restoreTaskModelMessages(output.messages)
      const current = output.messages.findLast((message) => message?.info?.role === "user")
      const selectedAgent = configNameForAgent(current?.info?.agent, snapshot.nativeModes)
      const currentUsesPlan = snapshot.agentByName.get(selectedAgent ?? "")?.planProfile === true
      for (const message of output.messages) {
        if (!Array.isArray(message?.parts)) continue
        if (currentUsesPlan && message === current) continue
        removePlanReminders(message.parts)
      }
    },
    "chat.message": async (input: any, output: any) => {
      if (!lifecycle.isActive()) return
      const automaticContinuation = isBackgroundTaskContinuation(output?.parts)
      let pendingUserMessage: { sessionID: string; messageID: string; userTurnClaimID: symbol } | undefined
      let userTurnClaim: { sessionID: string; claimID: symbol } | undefined
      let promptContextToken: { agent?: string; model?: { providerID: string; modelID: string }; variant?: string } | undefined
      if (!automaticContinuation && typeof input?.sessionID === "string") {
        terminalCheckFailures.delete(input.sessionID)
        automaticTaskFollow.resume(input.sessionID)
        const { claimID, epoch } = terminalContinuationCoordination.beginUserTurn(input.sessionID)
        userTurnClaim = { sessionID: input.sessionID, claimID }
        promptContextToken = {
          ...(typeof input.agent === "string" && input.agent ? { agent: input.agent } : {}),
          ...(input.model?.providerID && input.model?.modelID ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } } : {}),
          ...(typeof input.variant === "string" && input.variant ? { variant: input.variant } : {}),
        }
        const messageID = typeof output?.message?.id === "string"
          ? output.message.id
          : typeof input?.messageID === "string" ? input.messageID : undefined
        const userParts = Array.isArray(output?.parts) ? output.parts : []
        if (messageID) {
          const pending = pendingPersistedUserMessages.get(input.sessionID) ?? new Map()
          const existing = pending.get(messageID)
          if (existing) terminalContinuationCoordination.endUserTurn(input.sessionID, existing.userTurnClaimID)
          pending.set(messageID, {
            userTurnClaimID: claimID,
            userTurnEpoch: epoch,
            messageUpdated: false,
            registrationComplete: false,
            pendingPartIDs: new Set(userParts.map((part: any) => part?.id).filter((partID: any) => typeof partID === "string" && partID)),
            persistedPartIDs: new Set(),
            deliveredReceiptIDs: new Set(),
          })
          while (pending.size > 256) {
            const oldest = pending.keys().next().value
            if (typeof oldest !== "string") break
            const evicted = pending.get(oldest)
            pending.delete(oldest)
            if (evicted) terminalContinuationCoordination.endUserTurn(input.sessionID, evicted.userTurnClaimID)
          }
          pendingPersistedUserMessages.set(input.sessionID, pending)
          pendingUserMessage = { sessionID: input.sessionID, messageID, userTurnClaimID: claimID }
        } else terminalContinuationCoordination.endUserTurn(input.sessionID, claimID)
      }
      const appendUserPrompt = (text: string, kind?: Parameters<typeof o4ePartMetadata>[0]) => {
        if (typeof output?.message?.id !== "string" || !Array.isArray(output.parts)) return
        const part = o4eSyntheticPart({
          id: `prt_${randomUUID()}`,
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text,
          ...(kind ? { metadata: o4ePartMetadata(kind) } : {}),
        }) as any
        if (pendingUserMessage) {
          const candidate = pendingPersistedUserMessages.get(pendingUserMessage.sessionID)?.get(pendingUserMessage.messageID)
          if (candidate?.userTurnClaimID === pendingUserMessage.userTurnClaimID && !candidate.persistedPartIDs.has(part.id)) candidate.pendingPartIDs.add(part.id)
        }
        output.parts.push(part)
      }
      try {
        await trackRuntimeOperation(async () => {
          if (automaticContinuation) await ensureRuntimeRecovery(input?.sessionID)
          else await activateRuntimeSession(input?.sessionID)
          if (!lifecycle.isActive()) return
          const snapshot = runtimeSnapshot()
          if (!snapshot) return
          if (!automaticContinuation && canReadBackgroundTasks && typeof input?.sessionID === "string") {
            const follow = automaticFollowControl(sessionO4E(await sessionStore.get(input.sessionID)))
            if (!follow.enabled) appendUserPrompt(`O4E automatic tracking is disabled for this owner. Tasks were not cancelled. Do not automatically follow or resume tracking without authorization. Read o4e_task action:follow for current revision and recovery control.${follow.diagnostic ? " Diagnostic: automatic-follow-failed." : ""}`)
          }
          const recoveryContext = runtimeContext({ sessionID: input?.sessionID, messageID: output?.message?.id })
          const recoveryNotices = !automaticContinuation && canRecoverWorkflows && typeof input?.sessionID === "string"
            ? await workflowRuntime?.resumeForSession(input.sessionID, recoveryContext).catch((error) => {
                if (recoveryContext.abort.aborted) throw error
                return [{ status: "recovery-error", diagnostics: error instanceof Error ? error.message : String(error) }]
              })
            : []
          const terminalReceipts = !automaticContinuation && canReadBackgroundTasks && typeof input?.sessionID === "string"
            ? await backgroundTaskRuntime!.pendingReceipts(
                { sessionID: input.sessionID },
                { messageID: output?.message?.id },
              )
            : []
          if (pendingUserMessage && terminalReceipts.length > 0 && output?.message && typeof output.message.id === "string") {
            const candidate = pendingPersistedUserMessages.get(pendingUserMessage.sessionID)?.get(pendingUserMessage.messageID)
            const deliveries = await backgroundTaskRuntime!.markReceiptsDelivered(
              terminalReceipts.map((receipt) => receipt.receiptID),
              { sessionID: input.sessionID },
              output.message.id,
            )
            for (const delivery of deliveries) {
              if (delivery.messageID === output.message.id && candidate?.userTurnClaimID === pendingUserMessage.userTurnClaimID) candidate.deliveredReceiptIDs.add(delivery.receiptID)
            }
          }
        const unfinishedTasks = canReadBackgroundTasks && typeof input?.sessionID === "string"
          ? (await backgroundTaskRuntime!.taskGroup({ sessionID: input.sessionID })).filter((task) => (
              task.ownerSessionID === input.sessionID && !isTerminalTaskStatus(task.status)
            ))
          : []
        const waitingRequestTasks = unfinishedTasks.filter((task) => Array.isArray(task.pendingRequests) && task.pendingRequests.length > 0)
        if (terminalReceipts.length) {
          appendUserPrompt(backgroundTaskReceiptNotice(terminalReceipts, snapshot.runtime.config.language), "background-task-receipts")
        }
        if (!automaticContinuation && unfinishedTasks.length) {
          appendUserPrompt(backgroundTaskNotice(unfinishedTasks, snapshot.runtime.config.language), "background-task-notice")
        }
        if (!automaticContinuation && waitingRequestTasks.length) {
          appendUserPrompt(backgroundTaskRequestNotice(waitingRequestTasks, snapshot.runtime.config.language), "background-task-requests")
        }
        if (recoveryNotices?.length) {
          appendUserPrompt(`O4E Workflow reconciliation notice:\nNo new Workflow Step was started while processing this user message. The new user message is authoritative. Resume a listed Run only after interpreting the new instruction.\n${JSON.stringify(recoveryNotices, null, 2)}`)
        }
        const agent = output?.message?.agent ?? input.agent
        const selectedAgent = configNameForAgent(agent, snapshot.nativeModes)
        const entry = snapshot.agentByName.get(selectedAgent ?? "")
        const effectiveModel = messageModel(output?.message, input)
        if (o4eMode === "default") modelFallback.recordMessage({
          sessionID: input.sessionID,
          messageID: output?.message?.id ?? input?.messageID,
          agent: selectedAgent ?? agent,
          model: effectiveModel,
          fallbackModels: entry?.fallbackModels ?? [],
          parts: output.parts,
        })
        if (promptContextToken) {
          promptContextToken.agent = agent
          if (effectiveModel) {
            const { variant, ...model } = effectiveModel
            promptContextToken.model = model
            delete promptContextToken.variant
            if (variant) promptContextToken.variant = variant
          }
        }
        if (!automaticContinuation && output?.message && typeof output.message.id === "string" && Array.isArray(output.parts)) {
          if (entry?.messagePrompt) {
            const messagePrompt = readInject(snapshot.runtime.configRoot, entry.messagePrompt, entry.promptDir)?.trim()
            if (messagePrompt) appendUserPrompt(messagePrompt, "message-prompt")
          }
          const nativePlanHandlesReminder = agent === "plan" && entry?.nativeMode === "plan" && !entry.planReminder
          if (entry?.planProfile && !nativePlanHandlesReminder && (entry.planReminder || !hasPlanReminder(output.parts))) {
            const configuredPromptsDir = snapshot.runtime.config.promptsDir
            const reminderPath = entry.planReminder
              ? join(snapshot.runtime.configRoot, entry.promptDir ?? configuredPromptsDir, `${entry.planReminder}.md`)
              : join(snapshot.runtime.configRoot, configuredPromptsDir, "primary/plan/reminder.md")
            const reminder = readPromptFile(reminderPath, snapshot.runtime.configRoot)?.trim()
            if (reminder && !replacePlanReminder(output.parts, reminder)) {
              appendUserPrompt(reminder, "plan-reminder")
            }
          }
        }
        })
        if (pendingUserMessage) {
          const candidate = pendingPersistedUserMessages.get(pendingUserMessage.sessionID)?.get(pendingUserMessage.messageID)
          if (candidate?.userTurnClaimID === pendingUserMessage.userTurnClaimID && Array.isArray(output?.parts)) {
            for (const part of output.parts) {
              if (typeof part?.id === "string" && part.id && !candidate.persistedPartIDs.has(part.id)) candidate.pendingPartIDs.add(part.id)
            }
          }
          if (candidate?.userTurnClaimID === pendingUserMessage.userTurnClaimID) {
            candidate.registrationComplete = true
            confirmPersistedUserMessage(pendingUserMessage.sessionID, pendingUserMessage.messageID)
          }
        }
        if (typeof input?.sessionID === "string" && promptContextToken) parentPromptContexts.set(input.sessionID, promptContextToken)
      } catch (error) {
        if (pendingUserMessage) {
          const pending = pendingPersistedUserMessages.get(pendingUserMessage.sessionID)
          const candidate = pending?.get(pendingUserMessage.messageID)
          if (candidate?.userTurnClaimID === pendingUserMessage.userTurnClaimID) pending!.delete(pendingUserMessage.messageID)
          if (pending?.size === 0) pendingPersistedUserMessages.delete(pendingUserMessage.sessionID)
          terminalContinuationCoordination.endUserTurn(pendingUserMessage.sessionID, userTurnClaim!.claimID)
          if (pendingTerminalWakeups.has(pendingUserMessage.sessionID)) scheduleTerminalWakeup(pendingUserMessage.sessionID)
        } else if (userTurnClaim) {
          terminalContinuationCoordination.endUserTurn(userTurnClaim.sessionID, userTurnClaim.claimID)
        }
        throw error
      }
    },
    "tool.execute.before": async (input: any, output: any) => {
      if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
      // Workflow owns no task lifecycle or side effects; its execute entry
      // validates owner, host ask and message boundary without task recovery.
      if (input?.tool === WORKFLOW_TOOL) return
      // These reads need neither write scopes nor watermarks; defer recovery to their budgeted execute entry.
      if (input?.tool === TASK_TOOL && ["inspect", "watch", "follow"].includes(output?.args?.action)) return
      await trackRuntimeOperation(async () => {
        await ensureRuntimeRecovery(input?.sessionID)
        if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
        await delegationRuntime?.enforceWriteScope(input, output)
        await backgroundTaskRuntime?.markSideEffectBeforeTool(input)
      })
    },
    "command.execute.before": async (_input: any, output: any) => {
      if (!lifecycle.isActive()) throw new Error("O4E Runtime 正在释放")
      if (Array.isArray(output?.parts) && output.parts.some((part: any) => part?.type === "subtask")) {
        throw new Error("O4E 禁止绕过受管 task 的 slash-command subtask；请在普通消息中调用受管 task")
      }
    },
    event: async ({ event }: any) => {
      if (!acceptingRuntimeEvents || lifecycle.state() === "disposed") return
      const runtimeEvent = normalizeOpenCodeEvent(event)
      if (
        typeof runtimeEvent.sessionID === "string"
        && (
          runtimeEvent.kind === "error"
          || runtimeEvent.kind === "session-idle"
          || (runtimeEvent.kind === "session-status" && ["busy", "retry", "idle"].includes(runtimeEvent.status?.type))
        )
      ) {
        runtimeEvent.userTurnEpoch = runtimeEvent.kind === "error"
          ? terminalContinuationCoordination.userTurnEpoch(runtimeEvent.sessionID)
          : terminalContinuationCoordination.userTurnSettlementEpoch(runtimeEvent.sessionID)
      }
      pendingRuntimeEvents.push(delegationRuntime?.captureEvent(runtimeEvent) ?? runtimeEvent)
      if (!lifecycle.isActive()) return
      await trackRuntimeOperation(() => ensureRuntimeRecovery())
    },
    dispose: async () => {
      await lifecycle.dispose()
    },
  }
}
