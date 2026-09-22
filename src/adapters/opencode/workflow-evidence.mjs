import { createHash } from "node:crypto"
import { sessionO4E } from "../../runtime/session-store.mjs"
import { normalizeTaskGroupMetadata, normalizeTaskMetadata, taskText } from "../../core/background-task-domain.mjs"
import { dispatchRelatedUserIDs } from "./agent-execution-port.mjs"
import { delegationAuthorizationFingerprintFromEnvelope } from "../../runtime/delegation-runtime.mjs"
import { isDeepStrictEqual } from "node:util"
import { publicValue, hasUnmodifiedToolOutput } from "../../runtime/task-result-visibility.mjs"
import { modelTaskPart } from "../../runtime/task-model-output.mjs"
import { validateStepReport } from "../../core/workflow-process.mjs"

const hash = (text) => createHash("sha256").update(text).digest("hex")

function verifiedAgentReference(ownerSession, ref, task, envelope, context) {
  const saved = ref.recoveryEnvelope?.task
  // Owner snapshots may lag canonical commits. Compare stable identity, not
  // status or exact revision; neither a future snapshot nor a different owner
  // can serve as provenance. This reader never repairs or consumes metadata.
  return ownerSession?.id === context.sessionID && ref.kind === "agent" && task.kind === "agent"
    && task.sequence === ref.sequence && task.createdAt === ref.createdAt
    && task.taskSessionID === ref.taskSessionID
    && (ref.taskRevision === undefined || ref.taskRevision <= task.revision)
    && saved?.ownerSessionID === context.sessionID && saved.taskSessionID === task.taskSessionID
    && saved.revision <= task.revision
    && ["agent", "requesterAgent", "authorizationFingerprint", "requesterPermissionPattern", "requesterPermissionAction", "requesterPermissionApproved", "effect"]
      .every((field) => saved[field] === task[field])
    && isDeepStrictEqual(saved.writeScopes, task.writeScopes)
    && Number.isSafeInteger(envelope?.depth) && envelope.depth >= 1
    && envelope.requesterPermissionPattern === task.agent && envelope.targetAgent === task.agent
    && task.requesterPermissionPattern === envelope.requesterPermissionPattern
    && task.requesterPermissionAction === envelope.requesterPermissionAction
    && task.requesterPermissionApproved === envelope.requesterPermissionApproved
    && ((envelope.requesterPermissionAction === "allow" && envelope.requesterPermissionApproved === false)
      || (envelope.requesterPermissionAction === "ask" && envelope.requesterPermissionApproved === true))
    && Array.isArray(envelope.compiledPermission)
    && envelope.permissionOverlay !== null && typeof envelope.permissionOverlay === "object" && !Array.isArray(envelope.permissionOverlay)
    && envelope.effect === task.effect && Array.isArray(envelope.writeScopes) && isDeepStrictEqual(envelope.writeScopes, task.writeScopes)
    && envelope.trace?.taskID === task.taskID && envelope.trace?.ownerSessionID === context.sessionID
}

// Read-only evidence: never invokes Task recovery, dispatch, watch, output,
// cancellation or receipt consumption. Missing/truncated references fail closed.
export async function readWorkflowEvidence({ store, commandStore, context, step, attempt, evidence }) {
  if (!evidence.length) return []
  const messages = await store.messages(context.sessionID)
  const ownerSession = await store.get(context.sessionID)
  return verifyEvidence({ store, commandStore, context, step, attempt, evidence, messages, ownerSession })
}

// Reference discovery uses the same verifier as Gate acceptance. IDs come only
// from completed owner ToolParts, never from prose or a model-supplied locator.
// No output is returned and no Task operation, recovery or receipt is invoked.
export async function discoverWorkflowEvidence({ store, commandStore, context, step, attempt }) {
  const messages = await store.messages(context.sessionID)
  const ownerSession = await store.get(context.sessionID)
  const references = []
  let scanned = 0
  let candidates = 0
  let limited = false
  outer: for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    for (let partIndex = (message.parts?.length ?? 0) - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]
      if (++scanned > 5000 || candidates >= 128 || references.length >= 32) { limited = true; break outer }
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const taskID = part.state.metadata?.o4eResult?.taskID
      const kind = part.tool === "task" ? "task-created" : part.tool === "bash" ? "command-success"
        : part.tool === "o4e_task" && part.state.input?.action === "output"
          ? typeof taskID === "string" && taskID.startsWith("o4e_command_") ? "command-success" : "task-result" : undefined
      if (!kind) continue
      const item = { kind, taskID, messageID: message.info?.id, callID: part.callID }
      try { validateStepReport({ status: "reported-completed", output: null, artifacts: [], evidence: [item], diagnostics: [] }) }
      catch { continue }
      candidates++
      if (!(await verifyEvidence({ store, commandStore, context, step, attempt, evidence: [item], messages, ownerSession })).length) references.push(item)
    }
  }
  return { references, limited, next: "Copy applicable references into report.evidence; report revalidates sources and Gate requirements. Empty or limited discovery is not proof. Do not rerun side effects to obtain IDs." }
}

async function verifyEvidence({ store, commandStore, context, step, attempt, evidence, messages, ownerSession }) {
  const diagnostics = []
  const current = messages.find((message) => message.info?.id === context.messageID)
  const begin = messages.find((message) => message.info?.id === attempt.source.messageID)
  const boundary = (message, callID) => {
    const parts = message?.parts?.filter((part) => part.callID === callID) ?? []
    const part = parts[0]
    return message?.info?.role === "assistant" && message.info.sessionID === context.sessionID
      && messages.filter((entry) => entry.info?.id === message.info.id).length === 1
      && parts.length === 1 && part.type === "tool" && part.tool === "o4e_workflow"
      && (part.sessionID === undefined || part.sessionID === context.sessionID)
      && (part.messageID === undefined || part.messageID === message.info.id)
      && [message, message.info, part, part.state].every(publicValue)
      && ["pending", "running", "completed"].includes(part.state?.status)
      && part.state.time?.compacted === undefined && part.state.metadata?.truncated !== true
  }
  if (!boundary(current, context.callID) || !boundary(begin, attempt.source.callID)) return evidence.map((item) => `unverified:${item.kind}`)
  const before = (message, part, target, callID) => {
    if (!message || !target || !Number.isFinite(message.info?.time?.created) || !Number.isFinite(target.info?.time?.created)) return false
    if (message.info.id === target.info.id) return message.parts.indexOf(part) < target.parts.findIndex((candidate) => candidate.callID === callID)
    return message.info.time.created < target.info.time.created
  }
  const owner = sessionO4E(ownerSession)
  for (const item of evidence) {
    try {
      const message = messages.find((entry) => entry.info?.id === item.messageID)
      const part = message?.parts?.find((entry) => entry.type === "tool" && entry.callID === item.callID)
      const beginPart = begin?.parts?.find((entry) => entry.callID === attempt.source.callID)
      if (message?.info?.role !== "assistant" || message.info.sessionID !== context.sessionID || part?.state?.status !== "completed"
        || ![message, message.info, part, part.state, current, current?.info, begin, begin?.info, beginPart].every(publicValue)
        || messages.filter((entry) => entry.info?.id === item.messageID).length !== 1
        || message.parts.filter((entry) => entry.callID === item.callID).length !== 1
        || (part.sessionID !== undefined && part.sessionID !== context.sessionID)
        || (part.messageID !== undefined && part.messageID !== item.messageID)
        || !before(message, part, current, context.callID) || !before(begin, beginPart, message, item.callID)
         || !hasUnmodifiedToolOutput(part.state)) throw new Error()
      const modelOutput = modelTaskPart(part).state.output
      if (item.kind === "command-success") {
        const canonicalOwner = sessionO4E(await commandStore.get(context.sessionID))
        const ref = canonicalOwner.commandTasks?.refs?.[item.taskID]
        const record = ref?.recovery
        if (ownerSession?.id !== context.sessionID || canonicalOwner.commandTasks?.version !== 1 || ref?.taskSessionID !== context.sessionID
          || record?.kind !== "command" || record.version !== 1 || record.taskID !== item.taskID || record.taskSessionID !== context.sessionID
          || record.ownerSessionID !== context.sessionID || record.requesterAgent !== context.agent
          || !Number.isSafeInteger(record.revision) || record.revision < 1
          || ref.claim !== record.claim || ref.callKey !== hash(JSON.stringify([record.source?.sessionID, record.source?.messageID, record.source?.callID]))
          || record.status !== "completed" || record.stopped !== true || !record.claim
          || record.result?.status !== "completed" || record.result.exitCode !== 0 || record.result.stopped !== true
          || record.result.truncated || record.result.logComplete !== true || record.result.logError) throw new Error()
        const commandMessage = messages.find((entry) => entry.info?.id === record.source?.messageID)
        const commandPart = commandMessage?.parts?.find((entry) => entry.callID === record.source?.callID && entry.tool === "bash")
        if (record.source?.sessionID !== context.sessionID || typeof commandPart?.state?.input?.command !== "string"
          || hash(commandPart.state.input.command) !== record.commandHash || !before(begin, beginPart, commandMessage, record.source.callID)) throw new Error()
        if (part.tool === "bash") {
          if (part !== commandPart || part.state.metadata?.o4eResult?.taskID !== item.taskID || part.state.output !== record.result.output) throw new Error()
        } else if (part.tool !== "o4e_task" || part.state.input?.action !== "output" || part.state.input.taskID !== item.taskID
          || part.state.metadata?.o4eResult?.taskID !== item.taskID || modelOutput !== record.result.output) throw new Error()
      } else {
        const ref = normalizeTaskGroupMetadata(owner.backgroundTasks).taskRefs[item.taskID]
        if (!ref?.taskSessionID) throw new Error()
        const taskSession = await store.get(ref.taskSessionID)
        const state = sessionO4E(taskSession)
        const task = normalizeTaskMetadata(state.task)
        const envelope = state.delegation
        if (!verifiedAgentReference(ownerSession, ref, task, envelope, context)
          || task.taskID !== item.taskID || task.ownerSessionID !== context.sessionID || task.taskSessionID !== taskSession.id
          || envelope?.toolName !== "task" || envelope.parentSessionID !== context.sessionID
          || !envelope.authorizationFingerprint || envelope.sourceAgent !== context.agent
          || task.requesterAgent !== context.agent || task.authorizationFingerprint !== envelope.authorizationFingerprint
          || ref.recoveryEnvelope?.delegation?.authorizationFingerprint !== envelope.authorizationFingerprint
          || ref.recoveryEnvelope?.task?.runGeneration !== task.runGeneration
          || envelope.authorizationFingerprint !== delegationAuthorizationFingerprintFromEnvelope({
            requesterAgent: envelope.sourceAgent, requesterPermissionPattern: envelope.requesterPermissionPattern,
            requesterPermissionAction: envelope.requesterPermissionAction, requesterPermissionApproved: envelope.requesterPermissionApproved,
            targetAgent: envelope.targetAgent, compiledPermission: envelope.compiledPermission,
            permissionOverlay: envelope.permissionOverlay, effect: envelope.effect, normalizedScopes: envelope.writeScopes, trace: envelope.trace,
          })
          || step.execution.mode === "task" && envelope.targetAgent !== step.execution.agent) throw new Error()
        if (item.kind === "task-created") {
          if (part.tool !== "task" || part.state.metadata?.o4eResult?.taskID !== item.taskID
            || part.state.metadata.o4eResult.sessionID !== task.taskSessionID || part.state.input?.subagent_type !== task.agent
            || !part.state.output.includes(item.taskID)) throw new Error()
        } else {
          // A result requires the main Agent's completed output read, not a
          // model-written taskID or a successful creation response.
          if (task.status !== "completed" || part.tool !== "o4e_task" || part.state.input?.action !== "output" || part.state.input.taskID !== item.taskID
            || part.state.metadata?.o4eResult?.taskID !== item.taskID || part.state.metadata.o4eResult.status !== "completed"
            || part.state.metadata.o4eResult.output !== modelOutput || part.state.metadata.o4eResult.truncated) throw new Error()
          // Do not accept a read from an earlier run generation/revision.
          if (part.state.metadata.o4eResult.revision !== task.revision) throw new Error()
          const reference = task.result
          if (!reference?.sessionID || !reference.messageID || !reference.partIDs?.length || !task.attemptSessionIDs.includes(reference.sessionID)) throw new Error()
          const resultMessages = await store.messages(reference.sessionID)
          const result = resultMessages.find((entry) => entry.info?.id === reference.messageID)
          const related = dispatchRelatedUserIDs(resultMessages, task.dispatchMessageID)
          const parts = reference.partIDs.map((id) => result?.parts?.find((entry) => entry.id === id))
          if (result?.info?.role !== "assistant" || result.info.error || !result.info.finish || ["tool-calls", "unknown"].includes(result.info.finish)
            || ![result, result.info, ...parts].every(publicValue)
            || resultMessages.filter((entry) => entry.info?.id === reference.messageID).length !== 1
            || (result.info.sessionID !== undefined && result.info.sessionID !== reference.sessionID)
            || !related.has(result.info.parentID) || parts.some((entry) => !entry) || result.parts.some((entry) => entry.type === "tool")
            || taskText({ parts }) !== modelOutput
            || part.state.metadata.o4eResult.messageID !== reference.messageID
            || !isDeepStrictEqual(part.state.metadata.o4eResult.partIDs, reference.partIDs)) throw new Error()
        }
      }
    } catch { diagnostics.push(`unverified:${item.kind}`) }
  }
  return diagnostics
}
