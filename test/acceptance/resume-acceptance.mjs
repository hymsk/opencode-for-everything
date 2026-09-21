const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value) => typeof value === "string" && value.trim().length > 0
const validID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const validCursor = (value) => nonempty(value) && value.length <= 512
const publicValue = (value) => !value?.synthetic && !value?.ignored && !value?.private
  && !value?.summary && !value?.compaction && !["summary", "compaction"].includes(value?.mode)
  && !["summary", "compaction"].includes(value?.agent)
  && (value?.visibility === undefined || value.visibility === "public")
const boundedID = (value) => validID(value) ? value : "invalid-id"
const interrupted = (preview) => object(preview) && ["gap", "unavailable"].some((key) => Object.hasOwn(preview, key))
const freshInspect = (input) => !Object.hasOwn(input, "cursor") && (input.resume === undefined || input.resume === false)
const forbiddenWatchKeys = ["cursor", "cursors", "direction", "maxBytes", "resume", "reread"]
const forbiddenWatchResultKeys = ["tail", "cursor", "beforeCursor", "unchanged", "unavailable", "gap", "output", "outputTruncated"]

function inspectionText(preview) {
  const details = [preview.status, preview.phase, preview.reason, preview.exitCode === undefined ? undefined : `exit ${preview.exitCode}`]
    .filter((value) => value !== undefined && value !== "")
  const lines = [`Task ${preview.taskID ?? "unknown"}${details.length ? ` · ${details.join(" · ")}` : ""}`]
  if (["waiting_permission", "waiting_question", "waiting_retry_decision"].includes(preview.status)
    && Number.isSafeInteger(preview.revision)) lines.push(`Expected revision: ${preview.revision}`)
  if (preview.tail) lines.push(preview.tail)
  if (typeof preview.output === "string") lines.push(preview.output || "(no output)")
  if (preview.outputTruncated) lines.push(`[Result preview truncated; ${preview.outputBytes ?? "unknown"} bytes observed. Use output to read the authoritative retained result.]`)
  else if (preview.truncated) lines.push("[Output truncated; retained view only. Use inspect to page the retained output.]")
  if (preview.unchanged) lines.push("No new public output.")
  if (preview.unavailable) lines.push(`Preview unavailable: ${preview.unavailable}`)
  if (preview.gap) lines.push(`Preview gap: ${preview.gap}`)
  if (preview.cursor) lines.push(`Cursor: ${preview.cursor}`)
  if (preview.beforeCursor) lines.push(`Earlier cursor: ${preview.beforeCursor}`)
  return lines.join("\n")
}

function toolCalls(messages) {
  return messages.filter((message) => message.info?.role === "assistant" && publicValue(message) && publicValue(message.info))
    .flatMap(({ info, parts }) => (Array.isArray(parts) ? parts : [])
      .filter((part) => part?.type === "tool" && publicValue(part) && publicValue(part.state))
      .map((part) => {
      const input = object(part.state?.input) ? part.state.input : {}
      const output = object(part.state?.metadata?.o4eResult) ? part.state.metadata.o4eResult : undefined
      const completed = part.state?.status === "completed" && typeof part.state.output === "string"
        && part.state.metadata?.truncated !== true && part.state.time?.compacted === undefined
        && validID(part.id) && validID(part.callID)
        && (part.sessionID === undefined || part.sessionID === info.sessionID)
        && (part.messageID === undefined || part.messageID === info.id)
        return { part, input, output, completed }
      }))
}

export function resumeInspectionEvidence(messages, taskID, childSessionID) {
  const calls = toolCalls(messages)
  const creations = calls.filter((call) => call.part.tool === "task")
  const created = creations.find((call) => call.completed
    && call.input.subagent_type === "inspect-child" && call.input.background === undefined
    && call.output?.taskID === taskID && call.output.sessionID === childSessionID
    && call.output.agent === "inspect-child" && call.output.status === "queued")
  const managed = calls.filter((call) => call.part.tool === "o4e_task")
  const watches = managed.filter((call) => call.input.action === "watch")
  const inspections = managed.filter((call) => call.input.action === "inspect")
  const outputs = managed.filter((call) => call.input.action === "output")
  const output = outputs[0]
  const outputIndex = output ? calls.indexOf(output) : -1
  const progressInspections = inspections.filter((call) => calls.indexOf(call) < outputIndex)
  const finalInspections = inspections.filter((call) => calls.indexOf(call) > outputIndex)
  const evidenceCalls = calls.filter((call) => call.part.tool === "acceptance_evidence")
  const gaps = []
  const freshRecoveryPartIDs = []
  let gapCount = 0
  let unavailableCount = 0
  let recoveryRequired = false
  let recoveryPolicy = true
  for (const call of inspections) {
    const preview = call.output
    for (const kind of ["gap", "unavailable"]) {
      if (!object(preview) || !Object.hasOwn(preview, kind)) continue
      if (kind === "gap") gapCount += 1
      else unavailableCount += 1
      const reason = typeof preview[kind] === "string" && /^[A-Za-z0-9_.:-]+$/.test(preview[kind])
        ? preview[kind].slice(0, 96) : `invalid-${kind}-reason`
      if (gaps.length < 100) gaps.push({ partID: boundedID(call.part.id), taskID: boundedID(taskID), kind, reason })
    }
    if (interrupted(preview)) recoveryRequired = true
    else if (recoveryRequired) {
      if (freshInspect(call.input)) {
        freshRecoveryPartIDs.push(boundedID(call.part.id))
        recoveryRequired = false
      } else recoveryPolicy = false
    }
  }
  const inspectValid = (call) => call.completed && call.input.taskID === taskID && call.input.maxBytes === 128
    && ["forward", "backward"].includes(call.input.direction ?? "forward")
    && !Object.hasOwn(call.input, "cursors") && !(call.input.resume === true && Object.hasOwn(call.input, "cursor"))
    && object(call.output) && call.output.taskID === taskID && nonempty(call.output.status)
    && call.part.state.output === inspectionText(call.output)
    && (!Object.hasOwn(call.output, "tail") || typeof call.output.tail === "string")
    && (!Object.hasOwn(call.output, "unchanged") || typeof call.output.unchanged === "boolean")
    && ["cursor", "beforeCursor"].every((key) => !Object.hasOwn(call.output, key) || validCursor(call.output[key]))
    && Buffer.byteLength(call.output.tail ?? "") <= 128
  const successfulPosition = (call) => inspectValid(call) && !interrupted(call.output)
    && validCursor(call.output.cursor) && (nonempty(call.output.tail) || call.output.unchanged === true)
  const watchValid = (call) => call.completed && call.input.taskID === taskID && call.input.timeoutMs === 1000
    && forbiddenWatchKeys.every((key) => !Object.hasOwn(call.input, key))
    && object(call.output) && ["heartbeat", "actionable", "user-message", "empty", "aborted"].includes(call.output.reason)
    && Array.isArray(call.output.tasks) && call.output.tasks.length === 1 && call.output.tasks[0]?.taskID === taskID
    && forbiddenWatchResultKeys.every((key) => !Object.hasOwn(call.output.tasks[0], key))
  const begin = progressInspections.find((call) => successfulPosition(call) && call.output.tail?.includes("BEGIN\n"))
  const middle = progressInspections.find((call) => successfulPosition(call) && call.output.tail?.includes("MIDDLE\n"))
  const resumed = progressInspections.find((call) => successfulPosition(call) && call.input.resume === true)
  const terminalWatch = watches.findLast((call) => watchValid(call) && call.output.reason === "actionable"
    && call.output.tasks[0].status === "completed")
  const userMessageWatches = watches.filter((call) => watchValid(call) && call.output.reason === "user-message")
  const [recent, backward, forward, latest] = finalInspections
  const finalSequence = finalInspections.length === 4 && finalInspections.every((call) => successfulPosition(call))
    && freshInspect(recent?.input) && (recent.input.direction ?? "forward") === "forward" && validCursor(recent.output.beforeCursor)
    && backward.input.direction === "backward" && backward.input.resume === true && nonempty(backward.output.tail)
    && forward.input.direction === "forward" && forward.input.resume === true && forward.output.tail === recent.output.tail
    && latest.input.direction === "forward" && latest.input.resume === true && latest.output.unchanged === true
  const sequence = calls.filter((call) => call.part.tool !== "acceptance_evidence")
  const expected = [created, ...calls.filter((call) => call.part.tool === "o4e_task")]
  const onlyScenarioTools = sequence.length === expected.length && sequence.every((call, index) => call === expected[index])
    && managed.every((call) => ["watch", "inspect", "output"].includes(call.input.action))
  const ordered = !!created && calls[0] === created && watches.length > 0 && watches.length <= 30
    && progressInspections.length > 0 && progressInspections.length <= 30 && !!terminalWatch
    && calls.indexOf(terminalWatch) < outputIndex && outputs.length === 1
    && finalInspections.length === 4 && finalInspections.every((call, index) => calls.indexOf(call) === outputIndex + index + 1)
    && evidenceCalls.length <= 1 && evidenceCalls.every((call) => call === calls.at(-1) && call.input.taskID === taskID)
  const sequentialCalls = calls.every((call, index) => {
    if (!index) return true
    const previous = calls[index - 1].part.state?.time
    const current = call.part.state?.time
    return Number.isFinite(previous?.start) && Number.isFinite(previous?.end) && previous.end >= previous.start
      && Number.isFinite(current?.start) && current.start >= previous.end
  })
  const relevant = [created, ...managed].filter(Boolean)
  const checks = {
    taskCreated: !!created && creations.length === 1,
    currentWatchProtocol: watches.every(watchValid),
    statusOnlyWatch: watches.every((call) => forbiddenWatchResultKeys.every((key) => !Object.hasOwn(call.output?.tasks?.[0] ?? {}, key))),
    progressInspection: progressInspections.every(inspectValid) && !!begin && !!middle,
    normalInspectResume: !!resumed,
    explicitFreshRecovery: recoveryPolicy && !recoveryRequired && freshRecoveryPartIDs.length <= 4,
    completedWatch: !!terminalWatch,
    noUserInterruption: userMessageWatches.length === 0,
    outputCollected: !!output?.completed && output.input.taskID === taskID && !Object.hasOwn(output.input, "reread")
      && output.output?.taskID === taskID && output.output.status === "completed"
      && typeof output.output.output === "string" && output.output.output.includes("O4E_INSPECT_ACCEPTANCE_DONE")
      && output.part.state.output === output.output.output && !interrupted(output.output),
    finalInspectionSequence: finalSequence,
    boundedRun: ordered && onlyScenarioTools,
    sequentialCalls,
    distinctParts: relevant.every(({ part }) => validID(part.id) && validID(part.callID))
      && new Set(relevant.map(({ part }) => part.id)).size === relevant.length
      && new Set(relevant.map(({ part }) => part.callID)).size === relevant.length,
  }
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    cursorSource: "o4e_task-inspect-resume",
    partIDs: {
      taskCreated: created?.part.id,
      liveBeginText: begin?.part.id,
      liveMiddleText: middle?.part.id,
      runningResume: resumed?.part.id,
      completedWatch: terminalWatch?.part.id,
      outputCollected: output?.part.id,
      sequence: finalInspections.map(({ part }) => boundedID(part.id)),
      latestRead: inspections.length ? boundedID(inspections.at(-1).part.id) : undefined,
    },
    gaps,
    gapCount,
    unavailableCount,
    gapsTruncated: gapCount + unavailableCount > gaps.length,
    freshRecoveryPartIDs,
    counts: { creations: creations.length, watches: watches.length, progressInspections: progressInspections.length,
      inspections: inspections.length, finalInspections: finalInspections.length, freshRecoveries: freshRecoveryPartIDs.length,
      userMessages: userMessageWatches.length },
    gapPolicy: "Only prompt-authorized explicit fresh inspect recovery; gaps/unavailable are not successes or lossless recovery.",
  }
}
