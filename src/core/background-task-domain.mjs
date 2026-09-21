import { createHash, randomUUID } from "node:crypto"
import { modelCandidateKey, normalizeModelRefs } from "../model-fallback.mjs"

export const DEFAULT_BACKGROUND_TASK_CONFIG = Object.freeze({
  maxRetries: 1,
  maxConcurrentAgents: 4,
  maxConcurrentCommands: 4,
})

export const TASK_METADATA_VERSION = 1
export const TASK_GROUP_METADATA_VERSION = 1
export const TASK_REF_RECEIPT_LIMIT = 20
export const TASK_PENDING_INPUT_LIMIT = 16
export const TASK_INPUT_MAX_LENGTH = 16_384
export const TASK_KIND_AGENT = "agent"
export const TASK_KIND_COMMAND = "command"
export const TASK_STATUS_QUEUED = "queued"
export const TASK_STATUS_STARTING = "starting"
export const TASK_STATUS_RUNNING = "running"
export const TASK_STATUS_WAITING_PERMISSION = "waiting_permission"
export const TASK_STATUS_WAITING_QUESTION = "waiting_question"
export const TASK_STATUS_WAITING_WORKFLOW = "waiting_workflow"
export const TASK_STATUS_WAITING_RETRY_DECISION = "waiting_retry_decision"
export const TASK_STATUS_WAITING_TOOL = "waiting_tool"
export const TASK_STATUS_RETRYING = "retrying"
export const TASK_STATUS_CANCELLING = "cancelling"
export const TASK_STATUS_COMPLETED = "completed"
export const TASK_STATUS_FAILED = "failed"
export const TASK_STATUS_CANCELLED = "cancelled"
export const TASK_STATUS_UNKNOWN = "unknown"
export const TASK_STATUS_INTERRUPTED = "interrupted"

const TASK_KINDS = new Set([TASK_KIND_AGENT, TASK_KIND_COMMAND])
const TASK_STATUSES = new Set([
  TASK_STATUS_QUEUED,
  TASK_STATUS_STARTING,
  TASK_STATUS_RUNNING,
  TASK_STATUS_WAITING_PERMISSION,
  TASK_STATUS_WAITING_QUESTION,
  TASK_STATUS_WAITING_WORKFLOW,
  TASK_STATUS_WAITING_RETRY_DECISION,
  TASK_STATUS_WAITING_TOOL,
  TASK_STATUS_RETRYING,
  TASK_STATUS_CANCELLING,
  TASK_STATUS_COMPLETED,
  TASK_STATUS_FAILED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_UNKNOWN,
  TASK_STATUS_INTERRUPTED,
])

export const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUS_COMPLETED,
  TASK_STATUS_FAILED,
  TASK_STATUS_CANCELLED,
])

export const ACTIONABLE_TASK_STATUSES = new Set([
  ...TERMINAL_TASK_STATUSES,
  TASK_STATUS_WAITING_PERMISSION,
  TASK_STATUS_WAITING_QUESTION,
  TASK_STATUS_WAITING_WORKFLOW,
  TASK_STATUS_WAITING_RETRY_DECISION,
  TASK_STATUS_UNKNOWN,
  TASK_STATUS_INTERRUPTED,
])

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} 不支持字段: ${key}`)
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`)
  return value
}

function requireInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} 必须是${minimum === 0 ? "非负" : `大于等于 ${minimum} 的`}安全整数`)
  }
  return value
}

function optionalTimestamp(value, label) {
  return value === undefined ? undefined : requireInteger(value, label, 0)
}

function optionalString(value, label) {
  return value === undefined ? undefined : requireString(value, label)
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`)
  return value
}

export function normalizeBackgroundTaskConfig(value, { label = "backgroundTasks" } = {}) {
  if (value === undefined) return { ...DEFAULT_BACKGROUND_TASK_CONFIG }
  const source = requireObject(value, label)
  assertOnlyKeys(source, new Set(["maxRetries", "maxConcurrentAgents", "maxConcurrentCommands"]), label)
  return {
    maxRetries: source.maxRetries === undefined
      ? DEFAULT_BACKGROUND_TASK_CONFIG.maxRetries
      : requireInteger(source.maxRetries, `${label}.maxRetries`, 0),
    maxConcurrentAgents: source.maxConcurrentAgents === undefined
      ? DEFAULT_BACKGROUND_TASK_CONFIG.maxConcurrentAgents
      : requireInteger(source.maxConcurrentAgents, `${label}.maxConcurrentAgents`, 1),
    maxConcurrentCommands: source.maxConcurrentCommands === undefined
      ? DEFAULT_BACKGROUND_TASK_CONFIG.maxConcurrentCommands
      : requireInteger(source.maxConcurrentCommands, `${label}.maxConcurrentCommands`, 1),
  }
}

export function normalizeAgentBackgroundTaskConfig(value, fallback = DEFAULT_BACKGROUND_TASK_CONFIG, { label = "agent.backgroundTasks" } = {}) {
  if (value === undefined) return { maxRetries: fallback.maxRetries }
  const source = requireObject(value, label)
  assertOnlyKeys(source, new Set(["maxRetries"]), label)
  return {
    maxRetries: source.maxRetries === undefined
      ? fallback.maxRetries
      : requireInteger(source.maxRetries, `${label}.maxRetries`, 0),
  }
}

export function createTaskID(prefix = "o4e_task") {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

export function createDispatchMessageID() {
  return `msg_${randomUUID().replaceAll("-", "")}`
}

export function createTaskReceiptID(taskID, status, generation = 0) {
  requireString(taskID, "receipt.taskID")
  if (!TERMINAL_TASK_STATUSES.has(status)) throw new Error(`receipt.status 不是终态: ${String(status)}`)
  const identity = `${taskID}\u0000${status}\u0000${generation}`
  return `o4e_receipt_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`
}

export function createTaskReceipt(record) {
  if (!isTerminalTaskStatus(record?.status)) return undefined
  const generation = record.runGeneration
  return {
    version: 1,
    receiptID: createTaskReceiptID(record.taskID, record.status, generation),
    taskID: record.taskID,
    status: record.status,
    phase: record.phase,
    createdAt: record.endedAt ?? record.updatedAt,
    generation,
  }
}

export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.has(status)
}

export function isActionableTaskStatus(status) {
  return ACTIONABLE_TASK_STATUSES.has(status)
}

export function taskDiagnostic(code, message, at = Date.now()) {
  return {
    code: requireString(code, "diagnostic.code"),
    message: requireString(message, "diagnostic.message"),
    at: requireInteger(at, "diagnostic.at", 0),
  }
}

export function compactText(value, maxBytes = 4096) {
  const text = typeof value === "string" ? value : String(value ?? "")
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return { truncated: false, value: text, bytes }
  const preview = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  return {
    truncated: true,
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    preview,
  }
}

export function taskText(result) {
  const parts = Array.isArray(result?.parts) ? result.parts : []
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

export function messageReferences(result) {
  const info = result?.info && typeof result.info === "object" ? result.info : {}
  return {
    messageID: typeof info.id === "string" ? info.id : undefined,
    partIDs: Array.isArray(result?.parts)
      ? result.parts.map((part) => part?.id).filter((id) => typeof id === "string")
      : [],
  }
}

function normalizeDiagnostic(value, label) {
  const diagnostic = requireObject(value, label)
  return {
    code: requireString(diagnostic.code, `${label}.code`),
    message: requireString(diagnostic.message, `${label}.message`),
    at: requireInteger(diagnostic.at, `${label}.at`, 0),
  }
}

function normalizeTaskResult(value, label) {
  if (value === undefined) return undefined
  const result = requireObject(value, label)
  const output = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? structuredClone(result.output)
    : undefined
  return {
    sessionID: typeof result.sessionID === "string" ? result.sessionID : undefined,
    messageID: typeof result.messageID === "string" ? result.messageID : undefined,
    partIDs: Array.isArray(result.partIDs) ? result.partIDs.filter((id) => typeof id === "string") : [],
    output,
  }
}

function normalizeModel(value, label) {
  if (value === undefined) return undefined
  const model = normalizeModelRefs([value])[0]
  if (!model) throw new Error(`${label} 必须是合法模型引用`)
  return model
}

function normalizeModels(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  const models = normalizeModelRefs(value)
  if (models.length !== value.length) throw new Error(`${label} 包含无效或重复模型引用`)
  return models
}

function normalizeSideEffectWatermark(value, label) {
  if (value === undefined) return undefined
  const watermark = requireObject(value, label)
  if (watermark.version !== 1) throw new Error(`${label}.version 不支持: ${String(watermark.version)}`)
  return {
    version: 1,
    retryRound: requireInteger(watermark.retryRound, `${label}.retryRound`, 0),
    attemptNumber: requireInteger(watermark.attemptNumber, `${label}.attemptNumber`, 1),
    childSessionID: requireString(watermark.childSessionID, `${label}.childSessionID`),
    dispatchMessageID: requireString(watermark.dispatchMessageID, `${label}.dispatchMessageID`),
    tool: requireString(watermark.tool, `${label}.tool`),
    callID: requireString(watermark.callID, `${label}.callID`),
    at: requireInteger(watermark.at, `${label}.at`, 0),
  }
}

function normalizeRetryDecision(value, label) {
  if (value === undefined) return undefined
  const decision = requireObject(value, label)
  if (decision.status !== "pending" && decision.status !== "resolved") {
    throw new Error(`${label}.status 不支持: ${String(decision.status)}`)
  }
  const normalized = {
    status: decision.status,
    retryRound: requireInteger(decision.retryRound, `${label}.retryRound`, 0),
    attemptNumber: requireInteger(decision.attemptNumber, `${label}.attemptNumber`, 1),
    requestedAt: requireInteger(decision.requestedAt, `${label}.requestedAt`, 0),
    error: requireString(decision.error, `${label}.error`),
  }
  if (decision.status === "pending") return normalized
  if (decision.decision !== "continue" && decision.decision !== "restart" && decision.decision !== "stop") {
    throw new Error(`${label}.decision 不支持: ${String(decision.decision)}`)
  }
  return {
    ...normalized,
    decision: decision.decision,
    reason: optionalString(decision.reason, `${label}.reason`),
    resolvedAt: requireInteger(decision.resolvedAt, `${label}.resolvedAt`, 0),
  }
}

function normalizeTaskInputs(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  if (value.length > TASK_PENDING_INPUT_LIMIT) throw new Error(`${label} 最多允许 ${TASK_PENDING_INPUT_LIMIT} 条`)
  return value.map((entry, index) => {
    const source = requireObject(entry, `${label}[${index}]`)
    if (source.version !== 1) throw new Error(`${label}[${index}].version 不支持: ${String(source.version)}`)
    if (source.delivery !== undefined && source.delivery !== "queue" && source.delivery !== "steer") {
      throw new Error(`${label}[${index}].delivery 不支持: ${String(source.delivery)}`)
    }
    return {
      version: 1,
      text: boundedString(source.text, `${label}[${index}].text`, TASK_INPUT_MAX_LENGTH),
      createdAt: requireInteger(source.createdAt, `${label}[${index}].createdAt`, 0),
      ...(source.delivery === undefined ? {} : { delivery: source.delivery }),
      ...(source.delivery === "steer" && source.messageID !== undefined
        ? { messageID: boundedString(source.messageID, `${label}[${index}].messageID`, 256) }
        : {}),
      ...(source.delivery === "steer" && source.revision !== undefined
        ? { revision: requireInteger(source.revision, `${label}[${index}].revision`, 1) }
        : {}),
    }
  })
}

function boundedString(value, label, maximum = 4096) {
  return requireString(value, label).slice(0, maximum)
}

function boundedStrings(value, label, maximum = 64) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  return value.slice(0, maximum).map((entry, index) => boundedString(entry, `${label}[${index}]`))
}

function normalizePendingTool(value, label) {
  if (value === undefined) return undefined
  const source = requireObject(value, label)
  return {
    messageID: requireString(source.messageID, `${label}.messageID`),
    callID: requireString(source.callID, `${label}.callID`),
  }
}

function normalizePendingQuestionInfo(value, label) {
  const source = requireObject(value, label)
  const options = source.options === undefined
    ? []
    : Array.isArray(source.options)
      ? source.options.slice(0, 64).map((option, index) => {
          const normalized = requireObject(option, `${label}.options[${index}]`)
          return {
            label: boundedString(normalized.label, `${label}.options[${index}].label`, 256),
            description: typeof normalized.description === "string" ? normalized.description.slice(0, 2048) : "",
          }
        })
      : (() => { throw new Error(`${label}.options 必须是数组`) })()
  return {
    header: boundedString(source.header, `${label}.header`, 256),
    question: boundedString(source.question, `${label}.question`),
    options,
    multiple: optionalBoolean(source.multiple, `${label}.multiple`) ?? false,
    custom: optionalBoolean(source.custom, `${label}.custom`) ?? true,
  }
}

export function normalizeTaskPendingRequest(value, { label = "metadata.o4e.task.pendingRequests[]" } = {}) {
  const source = requireObject(value, label)
  if (source.version !== 1) throw new Error(`${label}.version 不支持: ${String(source.version)}`)
  if (source.kind !== "permission" && source.kind !== "question") throw new Error(`${label}.kind 不支持: ${String(source.kind)}`)
  if (source.state !== "pending" && source.state !== "submitting") throw new Error(`${label}.state 不支持: ${String(source.state)}`)
  const common = {
    version: 1,
    kind: source.kind,
    requestID: requireString(source.requestID, `${label}.requestID`),
    sessionID: requireString(source.sessionID, `${label}.sessionID`),
    state: source.state,
    requestedAt: requireInteger(source.requestedAt, `${label}.requestedAt`, 0),
    updatedAt: requireInteger(source.updatedAt, `${label}.updatedAt`, 0),
  }
  if (source.kind === "permission") {
    const permission = requireObject(source.permission, `${label}.permission`)
    return {
      ...common,
      permission: {
        action: boundedString(permission.action, `${label}.permission.action`, 512),
        resources: boundedStrings(permission.resources, `${label}.permission.resources`),
        save: boundedStrings(permission.save, `${label}.permission.save`),
        ...(permission.tool === undefined ? {} : { tool: normalizePendingTool(permission.tool, `${label}.permission.tool`) }),
      },
    }
  }
  const question = requireObject(source.question, `${label}.question`)
  if (!Array.isArray(question.questions)) throw new Error(`${label}.question.questions 必须是数组`)
  return {
    ...common,
    question: {
      questions: question.questions.slice(0, 16).map((entry, index) => normalizePendingQuestionInfo(entry, `${label}.question.questions[${index}]`)),
      ...(question.tool === undefined ? {} : { tool: normalizePendingTool(question.tool, `${label}.question.tool`) }),
    },
  }
}

export function normalizeTaskPendingRequests(value, { label = "metadata.o4e.task.pendingRequests" } = {}) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  const requests = value.slice(0, 32).map((entry, index) => normalizeTaskPendingRequest(entry, { label: `${label}[${index}]` }))
  const seen = new Set()
  for (const request of requests) {
    const key = `${request.kind}\u0000${request.sessionID}\u0000${request.requestID}`
    if (seen.has(key)) throw new Error(`${label} 包含重复 request: ${request.requestID}`)
    seen.add(key)
  }
  return requests
}

function normalizeTaskReceipt(value, taskID, status, label, expectedGeneration) {
  if (value === undefined) {
    if (isTerminalTaskStatus(status)) throw new Error(`${label} 终态 Task 必须包含 receipt`)
    return undefined
  }
  const receipt = requireObject(value, label)
  const receiptStatus = requireString(receipt.status, `${label}.status`)
  if (!TERMINAL_TASK_STATUSES.has(receiptStatus)) throw new Error(`${label}.status 不是终态: ${receiptStatus}`)
  if (receiptStatus !== status) throw new Error(`${label}.status 与 Task 状态不一致`)
  const generation = requireInteger(receipt.generation, `${label}.generation`, 0)
  if (generation !== expectedGeneration) throw new Error(`${label}.generation 与 Task runGeneration 不一致`)
  if (receipt.receiptID !== createTaskReceiptID(taskID, receiptStatus, generation)) throw new Error(`${label}.receiptID 与 Task 终态不一致`)
  return {
    version: receipt.version === 1 ? 1 : (() => { throw new Error(`${label}.version 不支持: ${String(receipt.version)}`) })(),
    receiptID: requireString(receipt.receiptID, `${label}.receiptID`),
    taskID: receipt.taskID === taskID ? taskID : (() => { throw new Error(`${label}.taskID 与 Task 不一致`) })(),
    status: receiptStatus,
    phase: requireString(receipt.phase, `${label}.phase`),
    createdAt: requireInteger(receipt.createdAt, `${label}.createdAt`, 0),
    generation,
    deliveredToMessageID: optionalString(receipt.deliveredToMessageID, `${label}.deliveredToMessageID`),
    deliveredAt: optionalTimestamp(receipt.deliveredAt, `${label}.deliveredAt`),
    acknowledgedAt: optionalTimestamp(receipt.acknowledgedAt, `${label}.acknowledgedAt`),
  }
}

export function normalizeTaskMetadata(value, { label = "metadata.o4e.task" } = {}) {
  const source = requireObject(value, label)
  if (source.version !== TASK_METADATA_VERSION) throw new Error(`${label}.version 不支持: ${String(source.version)}`)
  if (!TASK_KINDS.has(source.kind)) throw new Error(`${label}.kind 不支持: ${String(source.kind)}`)
  if (!TASK_STATUSES.has(source.status)) throw new Error(`${label}.status 不支持: ${String(source.status)}`)
  if (source.effect !== "read" && source.effect !== "scoped-write" && source.effect !== "unknown-write") {
    throw new Error(`${label}.effect 不支持: ${String(source.effect)}`)
  }
  const diagnostics = source.diagnostics === undefined
    ? []
    : Array.isArray(source.diagnostics)
      ? source.diagnostics.map((entry, index) => normalizeDiagnostic(entry, `${label}.diagnostics[${index}]`))
      : (() => { throw new Error(`${label}.diagnostics 必须是数组`) })()
  const runGeneration = requireInteger(source.runGeneration, `${label}.runGeneration`, 0)
  const receipt = normalizeTaskReceipt(source.receipt, source.taskID, source.status, `${label}.receipt`, runGeneration)
  const activeInputs = normalizeTaskInputs(source.activeInputs, `${label}.activeInputs`)
  const pendingInputs = normalizeTaskInputs(source.pendingInputs, `${label}.pendingInputs`)
  return {
    version: TASK_METADATA_VERSION,
    revision: requireInteger(source.revision, `${label}.revision`, 1),
    sequence: requireInteger(source.sequence, `${label}.sequence`, 1),
    taskID: requireString(source.taskID, `${label}.taskID`),
    kind: source.kind,
    status: source.status,
    phase: requireString(source.phase, `${label}.phase`),
    ownerSessionID: requireString(source.ownerSessionID, `${label}.ownerSessionID`),
    taskSessionID: requireString(source.taskSessionID, `${label}.taskSessionID`),
    childSessionID: source.childSessionID === undefined ? undefined : requireString(source.childSessionID, `${label}.childSessionID`),
    agent: source.agent === undefined ? undefined : requireString(source.agent, `${label}.agent`),
    requesterAgent: optionalString(source.requesterAgent, `${label}.requesterAgent`),
    requesterPermissionPattern: optionalString(source.requesterPermissionPattern, `${label}.requesterPermissionPattern`),
    requesterPermissionAction: optionalString(source.requesterPermissionAction, `${label}.requesterPermissionAction`),
    requesterPermissionApproved: optionalBoolean(source.requesterPermissionApproved, `${label}.requesterPermissionApproved`),
    authorizationFingerprint: optionalString(source.authorizationFingerprint, `${label}.authorizationFingerprint`),
    effect: source.effect,
    writeScopes: Array.isArray(source.writeScopes)
      ? source.writeScopes.map((scope, index) => requireString(scope, `${label}.writeScopes[${index}]`))
      : (() => { throw new Error(`${label}.writeScopes 必须是数组`) })(),
    dispatchMessageID: source.dispatchMessageID === undefined ? undefined : requireString(source.dispatchMessageID, `${label}.dispatchMessageID`),
    attemptSessionIDs: Array.isArray(source.attemptSessionIDs)
      ? [...new Set(source.attemptSessionIDs.map((sessionID, index) => requireString(sessionID, `${label}.attemptSessionIDs[${index}]`)))]
      : (() => { throw new Error(`${label}.attemptSessionIDs 必须是数组`) })(),
    requiresAllAttemptsStopped: optionalBoolean(source.requiresAllAttemptsStopped, `${label}.requiresAllAttemptsStopped`) ?? false,
    modelCandidates: normalizeModels(source.modelCandidates, `${label}.modelCandidates`),
    currentModel: normalizeModel(source.currentModel, `${label}.currentModel`),
    failedModelCandidates: normalizeModels(source.failedModelCandidates, `${label}.failedModelCandidates`),
    maxRetries: requireInteger(source.maxRetries, `${label}.maxRetries`, 0),
    attemptNumber: requireInteger(source.attemptNumber, `${label}.attemptNumber`, 0),
    retryRound: requireInteger(source.retryRound, `${label}.retryRound`, 0),
    handledModelErrorAttempt: source.handledModelErrorAttempt === undefined
      ? 0
      : requireInteger(source.handledModelErrorAttempt, `${label}.handledModelErrorAttempt`, 0),
    runGeneration,
    sideEffectWatermark: normalizeSideEffectWatermark(source.sideEffectWatermark, `${label}.sideEffectWatermark`),
    retryDecision: normalizeRetryDecision(source.retryDecision, `${label}.retryDecision`),
    activeInputs,
    pendingInputs,
    pendingRequests: normalizeTaskPendingRequests(source.pendingRequests, { label: `${label}.pendingRequests` }),
    createdAt: requireInteger(source.createdAt, `${label}.createdAt`, 0),
    queuedAt: optionalTimestamp(source.queuedAt, `${label}.queuedAt`),
    startedAt: optionalTimestamp(source.startedAt, `${label}.startedAt`),
    updatedAt: requireInteger(source.updatedAt, `${label}.updatedAt`, 0),
    endedAt: optionalTimestamp(source.endedAt, `${label}.endedAt`),
    cancellationRequestedAt: optionalTimestamp(source.cancellationRequestedAt, `${label}.cancellationRequestedAt`),
    result: normalizeTaskResult(source.result, `${label}.result`),
    receipt,
    diagnostics,
  }
}

function normalizeTaskRefRecoveryEnvelope(value, taskID, ref, label) {
  if (value === undefined) return undefined
  const envelope = requireObject(value, label)
  if (envelope.version !== 1) throw new Error(`${label}.version 不支持: ${String(envelope.version)}`)
  const task = normalizeTaskMetadata(envelope.task, { label: `${label}.task` })
  if (task.taskID !== taskID) throw new Error(`${label}.task.taskID 与父索引不一致`)
  if (task.kind !== ref.kind || task.sequence !== ref.sequence || task.createdAt !== ref.createdAt) {
    throw new Error(`${label}.task 与父索引身份不一致`)
  }
  const delegation = envelope.delegation === undefined
    ? undefined
    : structuredClone(requireObject(envelope.delegation, `${label}.delegation`))
  return {
    version: 1,
    task,
    ...(delegation ? { delegation } : {}),
  }
}

function normalizeTaskRefReceipt(value, taskID, label) {
  const receipt = requireObject(value, label)
  const receiptID = requireString(receipt.receiptID, `${label}.receiptID`)
  const receiptStatus = requireString(receipt.receiptStatus, `${label}.receiptStatus`)
  if (!TERMINAL_TASK_STATUSES.has(receiptStatus)) throw new Error(`${label}.receiptStatus 不是终态`)
  const generation = requireInteger(receipt.receiptGeneration, `${label}.receiptGeneration`, 0)
  if (receiptID !== createTaskReceiptID(taskID, receiptStatus, generation)) throw new Error(`${label}.receiptID 与 Task 终态不一致`)
  const normalized = {
    receiptID,
    receiptStatus,
    receiptCreatedAt: requireInteger(receipt.receiptCreatedAt, `${label}.receiptCreatedAt`, 0),
    receiptGeneration: generation,
    ...(receipt.receiptPhase === undefined ? {} : { receiptPhase: requireString(receipt.receiptPhase, `${label}.receiptPhase`) }),
    ...(receipt.receiptDeliveredToMessageID === undefined ? {} : { receiptDeliveredToMessageID: requireString(receipt.receiptDeliveredToMessageID, `${label}.receiptDeliveredToMessageID`) }),
    ...(receipt.receiptDeliveredAt === undefined ? {} : { receiptDeliveredAt: requireInteger(receipt.receiptDeliveredAt, `${label}.receiptDeliveredAt`, 0) }),
    ...(receipt.receiptAcknowledgedAt === undefined ? {} : { receiptAcknowledgedAt: requireInteger(receipt.receiptAcknowledgedAt, `${label}.receiptAcknowledgedAt`, 0) }),
  }
  const deliveryFieldCount = [normalized.receiptDeliveredToMessageID, normalized.receiptDeliveredAt]
    .filter((entry) => entry !== undefined).length
  if (deliveryFieldCount !== 0 && deliveryFieldCount !== 2) throw new Error(`${label} receipt 投递引用不完整`)
  if (normalized.receiptAcknowledgedAt !== undefined && deliveryFieldCount !== 2) throw new Error(`${label} receipt 确认缺少投递引用`)
  if (normalized.receiptAcknowledgedAt !== undefined && normalized.receiptAcknowledgedAt < normalized.receiptDeliveredAt) {
    throw new Error(`${label} receipt 确认时间早于投递时间`)
  }
  return normalized
}

function compareTaskRefReceipts(left, right) {
  return left.receiptCreatedAt - right.receiptCreatedAt
    || left.receiptGeneration - right.receiptGeneration
    || left.receiptID.localeCompare(right.receiptID)
}

export function mergeTaskRefReceipt(current, incoming) {
  if (!current) return incoming
  if (current.receiptID !== incoming.receiptID || current.receiptStatus !== incoming.receiptStatus) {
    throw new Error(`receipt ${incoming.receiptID} 身份字段不一致`)
  }
  const currentDeliveredAt = current.receiptDeliveredAt ?? -1
  const incomingDeliveredAt = incoming.receiptDeliveredAt ?? -1
  const delivery = currentDeliveredAt === incomingDeliveredAt
    ? incoming.receiptAcknowledgedAt !== undefined && current.receiptAcknowledgedAt === undefined ? incoming : current
    : currentDeliveredAt > incomingDeliveredAt ? current : incoming
  const acknowledgedAt = Math.max(current.receiptAcknowledgedAt ?? -1, incoming.receiptAcknowledgedAt ?? -1)
  const keepAcknowledgement = acknowledgedAt >= (delivery.receiptDeliveredAt ?? Number.POSITIVE_INFINITY)
  return {
    receiptID: current.receiptID,
    receiptStatus: current.receiptStatus,
    receiptCreatedAt: Math.min(current.receiptCreatedAt, incoming.receiptCreatedAt),
    receiptGeneration: current.receiptGeneration,
    ...(incoming.receiptPhase ?? current.receiptPhase ? { receiptPhase: incoming.receiptPhase ?? current.receiptPhase } : {}),
    ...(delivery.receiptDeliveredToMessageID === undefined ? {} : { receiptDeliveredToMessageID: delivery.receiptDeliveredToMessageID }),
    ...(delivery.receiptDeliveredAt === undefined ? {} : { receiptDeliveredAt: delivery.receiptDeliveredAt }),
    ...(keepAcknowledgement ? { receiptAcknowledgedAt: acknowledgedAt } : {}),
  }
}

export function retainTaskRefReceipts(receipts) {
  const sorted = receipts.toSorted(compareTaskRefReceipts)
  const acknowledged = sorted.filter((receipt) => receipt.receiptAcknowledgedAt !== undefined)
  const pending = sorted.filter((receipt) => receipt.receiptAcknowledgedAt === undefined)
  if (pending.length > TASK_REF_RECEIPT_LIMIT) throw new Error(`Task receipt 未确认项最多允许 ${TASK_REF_RECEIPT_LIMIT} 条`)
  const acknowledgedLimit = TASK_REF_RECEIPT_LIMIT - pending.length
  return [...(acknowledgedLimit > 0 ? acknowledged.slice(-acknowledgedLimit) : []), ...pending].sort(compareTaskRefReceipts)
}

export function normalizeTaskGroupMetadata(value, { label = "metadata.o4e.backgroundTasks" } = {}) {
  if (value === undefined) {
    return {
      version: TASK_GROUP_METADATA_VERSION,
      revision: 0,
      nextSequence: 1,
      taskRefs: {},
    }
  }
  const source = requireObject(value, label)
  if (source.version !== TASK_GROUP_METADATA_VERSION) throw new Error(`${label}.version 不支持: ${String(source.version)}`)
  const refs = requireObject(source.taskRefs, `${label}.taskRefs`)
  const taskRefs = {}
  for (const [taskID, value] of Object.entries(refs)) {
    const ref = requireObject(value, `${label}.taskRefs.${taskID}`)
    assertOnlyKeys(ref, new Set(["taskSessionID", "taskRevision", "cancellationRequestedAt", "receipts", "kind", "sequence", "createdAt", "recoveryEnvelope"]), `${label}.taskRefs.${taskID}`)
    if (!TASK_KINDS.has(ref.kind)) throw new Error(`${label}.taskRefs.${taskID}.kind 不支持: ${String(ref.kind)}`)
    if (ref.receipts !== undefined && !Array.isArray(ref.receipts)) throw new Error(`${label}.taskRefs.${taskID}.receipts 必须是数组`)
    const receiptByID = new Map()
    for (const [index, receipt] of (ref.receipts ?? []).entries()) {
      const normalized = normalizeTaskRefReceipt(receipt, taskID, `${label}.taskRefs.${taskID}.receipts[${index}]`)
      receiptByID.set(normalized.receiptID, mergeTaskRefReceipt(receiptByID.get(normalized.receiptID), normalized))
    }
    const receipts = retainTaskRefReceipts([...receiptByID.values()])
    const normalizedRef = {
      taskSessionID: requireString(ref.taskSessionID, `${label}.taskRefs.${taskID}.taskSessionID`),
      ...(ref.taskRevision === undefined ? {} : { taskRevision: requireInteger(ref.taskRevision, `${label}.taskRefs.${taskID}.taskRevision`, 1) }),
      ...(ref.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: requireInteger(ref.cancellationRequestedAt, `${label}.taskRefs.${taskID}.cancellationRequestedAt`, 0) }),
      ...(receipts.length === 0 ? {} : { receipts }),
      kind: ref.kind,
      sequence: requireInteger(ref.sequence, `${label}.taskRefs.${taskID}.sequence`, 1),
      createdAt: requireInteger(ref.createdAt, `${label}.taskRefs.${taskID}.createdAt`, 0),
    }
    const recoveryEnvelope = normalizeTaskRefRecoveryEnvelope(
      ref.recoveryEnvelope,
      taskID,
      normalizedRef,
      `${label}.taskRefs.${taskID}.recoveryEnvelope`,
    )
    taskRefs[taskID] = {
      ...normalizedRef,
      ...(recoveryEnvelope ? { recoveryEnvelope } : {}),
    }
  }
  return {
    version: TASK_GROUP_METADATA_VERSION,
    revision: requireInteger(source.revision, `${label}.revision`, 0),
    nextSequence: requireInteger(source.nextSequence, `${label}.nextSequence`, 1),
    taskRefs,
  }
}

function publicRetryDecision(decision) {
  if (!decision) return undefined
  return {
    status: decision.status,
    retryRound: decision.retryRound,
    attemptNumber: decision.attemptNumber,
    requestedAt: decision.requestedAt,
    ...(typeof decision.error === "string" ? { error: decision.error.slice(0, 512) } : {}),
    ...(decision.decision ? { decision: decision.decision } : {}),
    ...(typeof decision.reason === "string" ? { reason: decision.reason.slice(0, 512) } : {}),
    ...(decision.resolvedAt === undefined ? {} : { resolvedAt: decision.resolvedAt }),
  }
}

export function taskPublicSnapshot(record) {
  return {
    version: record.version,
    revision: record.revision,
    sequence: record.sequence,
    taskID: record.taskID,
    kind: record.kind,
    status: record.status,
    phase: record.phase,
    ownerSessionID: record.ownerSessionID,
    taskSessionID: record.taskSessionID,
    childSessionID: record.childSessionID,
    agent: record.agent,
    effect: record.effect,
    maxRetries: record.maxRetries,
    attemptNumber: record.attemptNumber,
    retryRound: record.retryRound,
    runGeneration: record.runGeneration,
    retryDecision: publicRetryDecision(record.retryDecision),
    pendingRequests: structuredClone(record.pendingRequests),
    pendingInputs: record.pendingInputs ? structuredClone(record.pendingInputs) : [],
    createdAt: record.createdAt,
    queuedAt: record.queuedAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    endedAt: record.endedAt,
    cancellationRequestedAt: record.cancellationRequestedAt,
    receipt: record.receipt
      ? {
          receiptID: record.receipt.receiptID,
          status: record.receipt.status,
          createdAt: record.receipt.createdAt,
          generation: record.receipt.generation,
        }
      : undefined,
    diagnostics: Array.isArray(record.diagnostics)
      ? record.diagnostics.map((diagnostic) => ({ code: diagnostic.code, at: diagnostic.at }))
      : [],
  }
}

// Input is a durable next-turn handoff. Keep this acknowledgement separate from
// the normal snapshot so a running Task cannot be mistaken for having received
// input inside its current model turn.
export function taskInputPublicSnapshot(record, { currentTurnRunning = false, delivery = "queue", delivered = false } = {}) {
  return {
    ...taskPublicSnapshot(record),
    inputDelivery: {
      mode: delivered ? delivery : "next-turn",
      queued: !delivered,
      pending: !delivered,
      currentTurnRunning: currentTurnRunning === true,
      boundary: delivered
        ? delivery === "steer" ? "next-runnable-turn" : "current-turn"
        : currentTurnRunning === true ? "after-current-turn" : "next-dispatch",
      phase: delivered
        ? delivery === "steer" ? "input-admitted" : "input-delivered"
        : "input-queued",
      revision: record.revision,
    },
  }
}

export function taskMetadata(record) {
  const receipt = isTerminalTaskStatus(record.status)
    ? (record.receipt ?? createTaskReceipt(record))
    : undefined
  return normalizeTaskMetadata({ ...record, receipt })
}

export function taskHasCurrentRoundSideEffect(record) {
  return record?.sideEffectWatermark?.retryRound === record?.retryRound
}

export function nextTaskModelCandidate(record) {
  const candidates = record.modelCandidates
  const failed = new Set(record.failedModelCandidates.map(modelCandidateKey))
  const currentKey = modelCandidateKey(record?.currentModel)
  const currentIndex = currentKey ? candidates.findIndex((model) => modelCandidateKey(model) === currentKey) : -1
  for (let index = currentIndex + 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (!failed.has(modelCandidateKey(candidate))) return candidate
  }
  return null
}

export function firstTaskModelCandidate(record) {
  return record.modelCandidates[0]
}
