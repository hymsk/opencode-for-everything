function string(value) {
  return typeof value === "string" && value ? value : undefined
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry) : []
}

function tool(value) {
  const source = object(value)
  const messageID = string(source.messageID)
  const callID = string(source.callID)
  return messageID && callID ? { messageID, callID } : undefined
}

export function normalizeOpenCodePendingRequest(kind, value, fallbackSessionID) {
  const source = object(value)
  const requestID = string(source.requestID) ?? string(source.id)
  const sessionID = string(source.sessionID) ?? string(fallbackSessionID)
  if (!requestID || !sessionID) return undefined
  if (kind === "permission") {
    const requestTool = tool(source.source?.type === "tool" ? source.source : source.tool)
    const action = string(source.action) ?? string(source.permission)
    if (!action) return undefined
    return {
      kind,
      requestID,
      sessionID,
      permission: {
        action,
        resources: strings(source.resources ?? source.patterns),
        save: strings(source.save ?? source.always),
        ...(requestTool ? { tool: requestTool } : {}),
      },
    }
  }
  if (kind === "question") {
    const questions = Array.isArray(source.questions)
      ? source.questions.map((entry) => {
          const question = object(entry)
          return {
            header: string(question.header) ?? "Question",
            question: string(question.question) ?? "Question",
            options: Array.isArray(question.options)
              ? question.options.map((option) => ({
                  label: string(object(option).label) ?? "Option",
                  description: typeof object(option).description === "string" ? object(option).description : "",
                }))
              : [],
            multiple: question.multiple === true,
            custom: question.custom !== false,
          }
        })
      : []
    const requestTool = tool(source.tool)
    return {
      kind,
      requestID,
      sessionID,
      question: {
        questions,
        ...(requestTool ? { tool: requestTool } : {}),
      },
    }
  }
}

export function normalizeOpenCodeEvent(event) {
  const properties = event?.properties && typeof event.properties === "object" ? event.properties : {}
  if (event?.type === "session.deleted") {
    const session = properties.info && typeof properties.info === "object" ? properties.info : undefined
    return {
      kind: "deleted",
      sessionID: string(properties.sessionID) ?? string(session?.id),
      ...(session ? { session } : {}),
      ...(string(session?.parentID) ? { parentSessionID: string(session.parentID) } : {}),
    }
  }
  if (event?.type === "session.error") {
    return { kind: "error", sessionID: string(properties.sessionID), error: properties.error }
  }
  if (event?.type === "session.status") {
    return { kind: "session-status", sessionID: string(properties.sessionID), status: properties.status }
  }
  if (event?.type === "session.idle") {
    return { kind: "session-idle", sessionID: string(properties.sessionID) }
  }
  if (event?.type === "message.updated") {
    const message = object(properties.info)
    return {
      kind: "message-updated",
      sessionID: string(message.sessionID) ?? string(properties.sessionID),
      messageID: string(message.id),
      messageRole: string(message.role),
      message: properties.info,
    }
  }
  if (event?.type === "message.part.updated") {
    const part = object(properties.part)
    return {
      kind: "message-part-updated",
      sessionID: string(part.sessionID) ?? string(properties.sessionID),
      messageID: string(part.messageID),
      partID: string(part.id),
      part: properties.part,
    }
  }
  if (event?.type === "permission.updated" || event?.type === "permission.asked" || event?.type === "permission.v2.asked") {
    const permission = properties.info ?? properties.data ?? properties
    const request = normalizeOpenCodePendingRequest("permission", permission, properties.sessionID)
    return { kind: "permission-waiting", sessionID: request?.sessionID ?? string(permission?.sessionID) ?? string(properties.sessionID), request }
  }
  if (event?.type === "permission.replied" || event?.type === "permission.v2.replied") {
    const reply = properties.info ?? properties.data ?? properties
    return {
      kind: "session-resumed",
      sessionID: string(reply?.sessionID) ?? string(properties.sessionID),
      interactionKind: "permission",
      requestID: string(reply?.requestID) ?? string(reply?.id),
      reply: reply?.reply,
    }
  }
  if (event?.type === "question.asked" || event?.type === "question.v2.asked") {
    const question = properties.info ?? properties.data ?? properties
    const request = normalizeOpenCodePendingRequest("question", question, properties.sessionID)
    return { kind: "question-waiting", sessionID: request?.sessionID ?? string(question?.sessionID) ?? string(properties.sessionID), request }
  }
  if (event?.type === "question.replied" || event?.type === "question.v2.replied" || event?.type === "question.rejected" || event?.type === "question.v2.rejected") {
    const reply = properties.info ?? properties.data ?? properties
    return {
      kind: "session-resumed",
      sessionID: string(reply?.sessionID) ?? string(properties.sessionID),
      interactionKind: "question",
      requestID: string(reply?.requestID) ?? string(reply?.id),
      ...(event.type === "question.rejected" || event.type === "question.v2.rejected" ? { rejected: true } : { answers: reply?.answers }),
    }
  }
  return { kind: "ignored" }
}
