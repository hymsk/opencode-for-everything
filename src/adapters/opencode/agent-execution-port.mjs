import { normalizeOpenCodePendingRequest } from "./event-normalizer.mjs"

function unwrap(result, operation) {
  if (result?.error) {
    throw new Error(`${operation} 失败: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`)
  }
  return result?.data ?? result
}

function sessionState(status) {
  if (status?.type === "busy") return "running"
  if (status?.type === "retry") return "retrying"
  if (status?.type === "idle") return "idle"
  return "unknown"
}

function sessionMapState(statuses, sessionID) {
  return Object.prototype.hasOwnProperty.call(statuses, sessionID) ? sessionState(statuses[sessionID]) : "inactive"
}

function isOrphanedInterruptedTool(part) {
  return part?.type === "tool"
    && part.state?.status === "error"
    && part.state?.metadata?.interrupted === true
}

function hasHostToolCalls(parts) {
  return Array.isArray(parts) && parts.some((part) => (
    part?.type === "tool"
    && part.metadata?.providerExecuted !== true
    && !isOrphanedInterruptedTool(part)
  ))
}

function isCompletedAssistantMessage(record) {
  const info = record?.info
  if (!Array.isArray(record?.parts)) return false
  const parts = record.parts
  return info?.role === "assistant"
    && !info.error
    && Boolean(info.finish)
    && !["tool-calls", "unknown"].includes(info.finish)
    && !hasHostToolCalls(parts)
}

function isCompactionUserMessage(record) {
  return record?.info?.role === "user"
    && Array.isArray(record.parts)
    && record.parts.some((part) => part?.type === "compaction")
}

function isCompactionSummaryMessage(record, compactionUserMessageID) {
  const info = record?.info
  return info?.role === "assistant"
    && info.parentID === compactionUserMessageID
    && (info.mode === "compaction" || info.summary === true)
    && isCompletedAssistantMessage(record)
}

function isCompactionContinuationMessage(record) {
  return record?.info?.role === "user"
    && typeof record.info.id === "string"
    && record.info.id.length > 0
    && Array.isArray(record.parts)
    && record.parts.some((part) => part?.synthetic === true && part?.metadata?.compaction_continue === true)
}

export function dispatchRelatedUserIDs(messages, dispatchMessageID) {
  const records = messages ?? []
  const related = new Set([dispatchMessageID])
  const dispatchIndex = records.findIndex((record) => record?.info?.role === "user" && record.info.id === dispatchMessageID)
  if (dispatchIndex < 0) return related
  for (let index = dispatchIndex + 1; index < records.length;) {
    const record = records[index]
    if (record?.info?.role === "assistant" && related.has(record.info.parentID)) {
      if (record.info.error || isCompletedAssistantMessage(record)) break
      index += 1
      continue
    }
    if (isCompactionUserMessage(record)) {
      const summary = records[index + 1]
      const continuation = records[index + 2]
      if (!isCompactionSummaryMessage(summary, record.info.id) || !isCompactionContinuationMessage(continuation)) break
      related.add(continuation.info.id)
      index += 3
      continue
    }
    if (record?.info?.role === "user") break
    if (record?.info?.role === "assistant") break
    index += 1
  }
  return related
}

function completedMessage(messages, dispatchMessageID) {
  const relatedUserIDs = dispatchRelatedUserIDs(messages, dispatchMessageID)
  return (messages ?? []).findLast((record) => record?.info?.role === "assistant"
    && relatedUserIDs.has(record.info.parentID)) ?? null
}

function completedAssistantParentIDs(messages) {
  const records = messages ?? []
  const userMessageIDs = new Set(records
    .filter((record) => record?.info?.role === "user" && typeof record.info.id === "string")
    .map((record) => record.info.id))
  const completed = new Set()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record?.info?.role !== "user" || isCompactionUserMessage(record) || isCompactionContinuationMessage(record)) continue
    const result = completedMessage(records, record.info.id)
    if (isCompletedAssistantMessage(result)) completed.add(record.info.id)
  }
  for (const record of records) {
    const parentID = record?.info?.parentID
    if (!isCompletedAssistantMessage(record) || typeof parentID !== "string" || userMessageIDs.has(parentID)) continue
    completed.add(parentID)
  }
  return [...completed]
}

function modelFields(model) {
  if (!model?.providerID || !model?.modelID) return {}
  return {
    model: { providerID: model.providerID, modelID: model.modelID },
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function interactionKey(request) {
  return `${request.kind}\u0000${request.sessionID}\u0000${request.requestID}`
}

export function createOpenCodeAgentExecutionPort({ client, directory }) {
  const request = async (path, { method = "GET", body } = {}) => {
    const result = await client._client.request({
      url: path,
      method,
      ...(body === undefined ? {} : {
        body,
        bodySerializer: JSON.stringify,
        headers: { "Content-Type": "application/json" },
      }),
    })
    const status = result.response?.status
    if (result.error !== undefined || status >= 400) {
      const detail = typeof result.error === "string" ? result.error : JSON.stringify(result.error)
      throw new Error(`OpenCode interaction API ${method} ${path.split("?")[0]} 失败${status ? `: HTTP ${status}` : ""}${detail ? ` ${detail}` : ""}`)
    }
    return result.data
  }
  const pending = async (sessionID) => {
    const encodedSessionID = encodeURIComponent(sessionID)
    const directoryQuery = `?directory=${encodeURIComponent(directory)}`
    const endpoints = [
      { kind: "permission", transport: "legacy", path: `/permission${directoryQuery}` },
      { kind: "permission", transport: "v2", path: `/api/session/${encodedSessionID}/permission` },
      { kind: "question", transport: "legacy", path: `/question${directoryQuery}` },
      { kind: "question", transport: "v2", path: `/api/session/${encodedSessionID}/question` },
    ]
    const results = await Promise.all(endpoints.map(async (endpoint) => ({ ...endpoint, data: await request(endpoint.path) })))
    const requests = new Map()
    for (const { kind, transport, data } of results) {
      const values = transport === "v2" ? data.data : data
      for (const value of values) {
        const normalized = normalizeOpenCodePendingRequest(kind, value)
        if (!normalized || normalized.sessionID !== sessionID) continue
        requests.set(interactionKey(normalized), { ...normalized, transport })
      }
    }
    return [...requests.values()]
  }
  const respondToPendingRequest = async ({ kind, sessionID, requestID, reply, message, answers, reject = false }) => {
    const listed = await pending(sessionID)
    const requestRecord = listed.find((entry) => entry.kind === kind && entry.requestID === requestID)
    if (!requestRecord) throw new Error(`宿主中不存在待处理的 ${kind} request: ${requestID}`)
    const encodedRequestID = encodeURIComponent(requestID)
    const directoryQuery = `?directory=${encodeURIComponent(directory)}`
    if (kind === "permission") {
      const path = requestRecord.transport === "v2"
        ? `/api/session/${encodeURIComponent(sessionID)}/permission/${encodedRequestID}/reply`
        : `/permission/${encodedRequestID}/reply${directoryQuery}`
      await request(path, { method: "POST", body: { reply, ...(message ? { message } : {}) } })
      return { acknowledged: true }
    }
    const path = requestRecord.transport === "v2"
      ? `/api/session/${encodeURIComponent(sessionID)}/question/${encodedRequestID}/${reject ? "reject" : "reply"}`
      : `/question/${encodedRequestID}/${reject ? "reject" : "reply"}${directoryQuery}`
    await request(path, { method: "POST", ...(reject ? {} : { body: { answers } }) })
    return { acknowledged: true }
  }
  return {
    async steerTurn({ sessionID, messageID, text }) {
      if (typeof client?._client?.request !== "function") return { supported: false }
      const id = typeof messageID === "string" && messageID ? messageID : `o4e_steer_${Date.now()}`
      const admitted = await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: "POST",
        body: { id, prompt: { text: String(text ?? "") }, delivery: "steer", resume: true },
      })
      if (!admitted || admitted.id !== id || (admitted.sessionID !== undefined && admitted.sessionID !== sessionID)) {
        throw new Error("OpenCode steer 响应缺少有效的 admitted input")
      }
      return { supported: true, accepted: true, messageID: id }
    },
    async startTurn({ sessionID, messageID, agent, model, parts, tools }) {
      const result = await client.session.promptAsync({
        path: { id: sessionID },
        query: { directory },
        body: {
          messageID,
          ...(agent ? { agent } : {}),
          ...modelFields(model),
          ...(tools ? { tools } : {}),
          parts,
        },
      })
      unwrap(result, `异步执行 Session ${sessionID}`)
      return { accepted: true }
    },

    async runTurn({ sessionID, messageID, agent, model, parts, tools }) {
      return unwrap(await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          ...(messageID ? { messageID } : {}),
          ...(agent ? { agent } : {}),
          ...modelFields(model),
          ...(tools ? { tools } : {}),
          parts,
        },
      }), `执行 Session ${sessionID}`)
    },

    async cancelTurn({ sessionID }) {
      const result = await client.session.abort({
        path: { id: sessionID },
        query: { directory },
      })
      return { acknowledged: Boolean(unwrap(result, `取消 Session ${sessionID}`)) }
    },

    async listPendingRequests({ sessionID }) {
      try {
        return { supported: true, requests: (await pending(sessionID)).map(({ transport: _transport, ...entry }) => entry) }
      } catch (error) {
        return { supported: true, requests: [], error: errorText(error) }
      }
    },

    respondToPendingRequest,

    async completedAssistantParentIDs({ sessionID }) {
      const messages = unwrap(await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      }), `读取 Session 消息 ${sessionID}`) ?? []
      return completedAssistantParentIDs(messages)
    },

    isCompletedAssistantMessage({ message, messages, dispatchMessageID }) {
      const relatedUserIDs = messages ? dispatchRelatedUserIDs(messages, dispatchMessageID) : new Set([dispatchMessageID])
      return relatedUserIDs.has(message?.info?.parentID) && isCompletedAssistantMessage(message)
    },

    async inspectTurn({ sessionID, dispatchMessageID }) {
      const statuses = unwrap(await client.session.status({ query: { directory } }), "读取 Session 状态") ?? {}
      const status = statuses[sessionID]
      let sessionExists = true
      if (!status && typeof client.session.get === "function") {
        try {
          const session = unwrap(await client.session.get({ path: { id: sessionID }, query: { directory } }), `读取 Session ${sessionID}`)
          if (!session) sessionExists = false
        } catch (error) {
          if (error instanceof Error && /404|不存在|not found/i.test(error.message)) sessionExists = false
          else throw error
        }
      }
      if (!sessionExists) return { state: "missing" }

      const pendingRequests = await this.listPendingRequests({ sessionID })

      const messages = unwrap(await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      }), `读取 Session 消息 ${sessionID}`) ?? []
      // OpenCode omits idle Sessions from the status map. The omission proves
      // only that the Session is not currently advertised as active; it is not
      // the same evidence as an explicit idle transition.
      let state = sessionMapState(statuses, sessionID)
      if (state === "inactive") {
        // Reading messages/interactions can overlap host activation. Runtime
        // must additionally verify the Attempt and its dispatch/activation fence.
        const latest = unwrap(await client.session.status({ query: { directory } }), "复核 Session 状态") ?? {}
        state = sessionMapState(latest, sessionID)
      }
      const result = completedMessage(messages, dispatchMessageID)
      if (result) {
        if (!["idle", "inactive"].includes(state)) return { state, error: undefined, result: undefined, pendingRequests }
        if (result.info?.error) return { state, error: result.info.error, pendingRequests }
        if (!Array.isArray(result.parts)) return { state: "unknown", pendingRequests }
        if (!isCompletedAssistantMessage(result)) {
          // A completed tool-call message is not a business result, but neither
          // is it proof that the host is still executing (for example after a
          // permission rejection). Confirm host idle after reading the settled
          // message before handing interruption reconciliation to the Runtime.
          const tools = result.parts.filter((part) => part?.type === "tool")
          if (Number.isFinite(result.info?.time?.completed)
            && tools.length > 0
            && tools.every((part) => ["completed", "error"].includes(part.state?.status))) {
            const latest = unwrap(await client.session.status({ query: { directory } }), "复核 Session 状态") ?? {}
            return { state: sessionMapState(latest, sessionID), pendingRequests }
          }
          if (["tool-calls", "unknown"].includes(result.info?.finish) || hasHostToolCalls(result.parts)) return { state: "running", pendingRequests }
          return { state, pendingRequests }
        }
        return {
          state,
          error: undefined,
          result,
          pendingRequests,
        }
      }
      return { state, pendingRequests }
    },
  }
}
