import { randomUUID } from "node:crypto"
import { normalizeWorkflow, resolveWorkflowTemplate, validateValue, workflowHash } from "./workflow-definition.mjs"

export const PROCESS_CONTRACT = "process-v1"
export const PROCESS_OWNER_RUN_LIMIT = 32
const object = (value) => value && typeof value === "object" && !Array.isArray(value)
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !["__proto__", "constructor", "prototype"].includes(value)
export const processError = (code) => new Error(`O4E_WORKFLOW_${code}`)
const argumentError = (code, detail) => new Error(`O4E_WORKFLOW_${code}: ${detail}`)
const processFields = {
  catalog: [], list: [], start: ["workflow", "input"], read: ["runID"],
  begin: ["runID", "expectedRevision", "stepID"],
  report: ["runID", "expectedRevision", "stepID", "attemptID", "submissionID", "report"],
  resume: ["runID", "expectedRevision"], pause: ["runID", "expectedRevision"], stop: ["runID", "expectedRevision"],
}
const reportKeys = ["status", "output", "artifacts", "evidence", "diagnostics"]
const evidenceKeys = ["kind", "taskID", "messageID", "callID"]
const evidenceKinds = ["command-success", "task-created", "task-result"]

const actionFields = (action) => new Set(["action", ...(processFields[action] ?? [])])
const emptyPlaceholder = (key, value) => value === null || value === ""
  || key === "expectedRevision" && value === 1
  || key === "input" && value === ""
  || key === "report" && value === null

// OpenCode advertises a flat object schema. Some host/model adapters populate
// optional fields from the union of actions (for example runID:"" and
// expectedRevision:1 on list). Remove only known empty/default placeholders;
// retain meaningful unexpected values so strict validation still rejects them.
export function normalizeProcessArgs(rawArgs) {
  if (!object(rawArgs)) return rawArgs
  const action = rawArgs.action
  if (typeof action !== "string" || !Object.hasOwn(processFields, action)) return rawArgs
  const allowed = actionFields(action)
  const args = { ...rawArgs }
  for (const key of Object.keys(args)) {
    if (allowed.has(key)) continue
    if (emptyPlaceholder(key, args[key])) delete args[key]
  }
  return args
}

// The host tool API takes a field map rather than a discriminated action union.
// Expose nested report structure here; validateProcessArgs enforces action fields
// before any authorization, I/O or state change. JSON values are never reparsed.
export function processToolArgs(schema) {
  const id = () => schema.string().min(1).max(256)
  return {
    action: schema.enum(Object.keys(processFields)),
    workflow: id().optional().describe("Required for start; use a catalog name."),
    input: schema.unknown().optional().describe("Native JSON workflow input for start. Strings remain strings; do not JSON-encode objects."),
    runID: id().optional().describe("Required for read/begin/report/resume/pause/stop; not a Task ID."),
    expectedRevision: schema.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("Required for begin/report/resume/pause/stop. Copy the latest returned revision; begin increments it. Use expectedRevision, not revision."),
    stepID: id().optional().describe("Required for begin and report; begin selects a ready Step."),
    attemptID: id().optional().describe("Required for report; copy the active Step attemptID returned by begin/read."),
    submissionID: id().optional().describe("Required for report; choose a unique submission ID, reuse only for an identical retry."),
    report: schema.object({
      status: schema.enum(["reported-completed", "failed"]),
      output: schema.union([schema.null(), schema.boolean(), schema.number(), schema.string(), schema.array(schema.unknown()), schema.record(schema.string(), schema.unknown())])
        .describe("Required native JSON Step output matching outputSchema."),
      artifacts: schema.array(schema.unknown()),
      evidence: schema.array(schema.object({ kind: schema.enum(evidenceKinds), taskID: id(), messageID: id(), callID: id() }).strict())
        .describe("Copy verified references from read.availableEvidence.references after executing tools. Never invent messageID/callID; missing references are not proof."),
      diagnostics: schema.array(schema.string()),
    }).strict().optional().describe("Required for report: exactly status/output/artifacts/evidence/diagnostics. Completion is a claim; Runtime decides Gate acceptance."),
  }
}

export function validateProcessArgs(args) {
  if (!object(args)) throw argumentError("INVALID_ARGUMENTS", "Expected an object with action.")
  if (typeof args.action !== "string" || !Object.hasOwn(processFields, args.action)) throw argumentError("INVALID_ARGUMENTS", "action must be catalog/list/start/read/begin/report/resume/pause/stop.")
  const fields = processFields[args.action]
  if (Object.keys(args).some((key) => key !== "action" && !fields.includes(key))) {
    throw argumentError("INVALID_ARGUMENTS", `Allowed fields: action${fields.length ? `, ${fields.join(", ")}` : ""}.`)
  }
  for (const key of fields.filter((key) => !["input", "report", "expectedRevision"].includes(key))) {
    if (!text(args[key])) throw argumentError("INVALID_ARGUMENTS", `${key} must be a nonempty identifier (max 256 characters, no reserved names).`)
  }
  if (fields.includes("expectedRevision") && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1)) {
    throw argumentError("INVALID_REVISION", "expectedRevision must be a positive safe integer; copy the latest revision from begin/read.")
  }
  if (args.action === "report") validateStepReport(args.report)
  if (Buffer.byteLength(JSON.stringify(args)) > 65536) throw processError("PAYLOAD_TOO_LARGE")
  return args
}

export function validateStepReport(report) {
  if (!object(report) || Object.keys(report).length !== reportKeys.length || reportKeys.some((key) => !Object.hasOwn(report, key))) {
    throw argumentError("INVALID_REPORT", "report must be an object with exactly status, output, artifacts, evidence, diagnostics.")
  }
  if (!["reported-completed", "failed"].includes(report.status)) throw argumentError("INVALID_REPORT", "report.status must be reported-completed or failed (not completed).")
  if (report.output === undefined) throw argumentError("INVALID_REPORT", "report.output must be a native JSON value (use null for no value).")
  for (const key of ["artifacts", "evidence", "diagnostics"]) {
    if (!Array.isArray(report[key])) throw argumentError("INVALID_REPORT", `report.${key} must be an array.`)
  }
  if (report.diagnostics.some((item) => typeof item !== "string")) throw argumentError("INVALID_REPORT", "report.diagnostics must contain only strings.")
  for (const item of report.evidence) {
    if (!object(item) || !evidenceKinds.includes(item.kind)
      || !text(item.taskID) || !text(item.messageID) || !text(item.callID)
      || Object.keys(item).some((key) => !evidenceKeys.includes(key))) {
      throw argumentError("UNSUPPORTED_EVIDENCE", "report.evidence items require exactly kind, taskID, messageID, callID; kind must be command-success/task-created/task-result. Use read.availableEvidence.references; never invent IDs.")
    }
  }
}

const evidenceKind = (requirement) => typeof requirement === "string" ? requirement : requirement.kind

function gateEvidenceDiagnostics(run, step, report) {
  const diagnostics = []
  for (const requirement of step.gate.evidence) {
    const kind = evidenceKind(requirement)
    if (typeof requirement === "string") {
      if (!report.evidence.some((item) => item.kind === kind)) diagnostics.push(`missing:${kind}`)
      continue
    }
    const dependency = run.steps[requirement.taskFrom]
    const taskIDs = new Set(dependency?.status === "passed"
      ? dependency.report.evidence.filter((item) => item.kind === "task-created").map((item) => item.taskID)
      : [])
    if (taskIDs.size !== 1) {
      diagnostics.push(`dependency-task-identity-unverifiable:${requirement.taskFrom}`)
      continue
    }
    const [taskID] = taskIDs
    if (!report.evidence.some((item) => item.kind === kind && item.taskID === taskID)) {
      diagnostics.push(`dependency-task-mismatch:${requirement.taskFrom}:${kind}`)
    }
  }
  return diagnostics
}

export function newProcess(definition, input, owner, boundary, source) {
  const { hash, source: _source, ...content } = definition
  const errors = validateValue(content.inputSchema, input)
  if (errors.length) throw processError("INVALID_INPUT")
  return { contract: PROCESS_CONTRACT, runID: `wfr_${randomUUID()}`, runSessionID: owner.sessionID,
    owner: structuredClone(owner), definition: content, definitionHash: workflowHash(content), input: structuredClone(input), inputHash: workflowHash(input),
    revision: 1, status: "running", boundary, boundarySource: source, source, steps: {}, submissions: {}, output: null }
}

export function assertProcess(run) {
  if (!object(run) || run.contract !== PROCESS_CONTRACT || !text(run.runID) || !text(run.runSessionID)
    || !object(run.owner) || !text(run.owner.sessionID) || !text(run.owner.agent) || run.runSessionID !== run.owner.sessionID
    || !Number.isSafeInteger(run.revision) || run.revision < 1 || !text(run.boundary)
    || !["running", "paused", "interrupted", "completed", "stopped"].includes(run.status)
    || !object(run.steps) || !object(run.submissions) || !object(run.source) || !text(run.source.messageID) || !text(run.source.callID)
    || !object(run.boundarySource) || !text(run.boundarySource.messageID) || !text(run.boundarySource.callID)
    || run.definitionHash !== workflowHash(run.definition) || run.inputHash !== workflowHash(run.input)) throw processError("INVALID_CHECKPOINT")
  const normalized = normalizeWorkflow(run.definition)
  if (workflowHash(normalized) !== run.definitionHash || validateValue(normalized.inputSchema, run.input).length) throw processError("INVALID_CHECKPOINT")
  let active = 0
  for (const [id, state] of Object.entries(run.steps)) {
    const step = normalized.steps.find((item) => item.id === id)
    if (!step || !object(state) || !["active", "passed", "rejected"].includes(state.status)
      || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || state.attempt > step.maxRepairRounds + 1
      || !text(state.attemptID) || !text(state.boundary) || !object(state.source) || !text(state.source.messageID) || !text(state.source.callID)
      || !Number.isSafeInteger(state.beginRevision) || state.beginRevision < 2 || state.beginRevision > run.revision
      || state.inputHash !== workflowHash(state.input) || validateValue(step.inputSchema, state.input).length
      || step.dependsOn.some((dependency) => run.steps[dependency]?.status !== "passed")) throw processError("INVALID_CHECKPOINT")
    if (state.status === "active") active++
    else {
      validateStepReport(state.report)
      const submissions = Object.values(run.submissions).filter((submission) => submission.attemptID === state.attemptID)
      if (!object(state.decision) || state.decision.accepted !== (state.status === "passed") || !Array.isArray(state.decision.diagnostics)
        || submissions.length !== 1 || submissions[0].stepID !== id
        || submissions[0].reportHash !== workflowHash(state.report)
        || workflowHash(submissions[0].decision) !== workflowHash(state.decision)) throw processError("INVALID_CHECKPOINT")
      if (state.status === "passed" && (state.report.status !== "reported-completed" || validateValue(step.outputSchema, state.report.output).length)) throw processError("INVALID_CHECKPOINT")
      if (state.status === "passed" && (state.report.artifacts.length < step.gate.artifactsMin
        || gateEvidenceDiagnostics(run, step, state.report).length
        || step.execution.mode === "task" && !state.report.evidence.some((item) => ["task-created", "task-result"].includes(item.kind)))) throw processError("INVALID_CHECKPOINT")
    }
  }
  if (active > 1) throw processError("INVALID_CHECKPOINT")
  for (const [id, submission] of Object.entries(run.submissions)) {
    if (!text(id) || !object(submission) || !text(submission.attemptID) || !text(submission.reportHash)
      || !text(submission.boundary)
      || !normalized.steps.some((step) => step.id === submission.stepID)
      || !object(submission.source) || !text(submission.source.messageID) || !text(submission.source.callID)
      || !object(submission.decision) || typeof submission.decision.accepted !== "boolean"
      || !Number.isSafeInteger(submission.revision) || submission.revision > run.revision || submission.revision < 2) throw processError("INVALID_CHECKPOINT")
  }
  if (run.status === "completed" && (normalized.steps.some((step) => run.steps[step.id]?.status !== "passed") || validateValue(normalized.outputSchema, run.output).length)) throw processError("INVALID_CHECKPOINT")
  if (run.status === "completed") {
    const steps = Object.fromEntries(normalized.steps.map((step) => [step.id, run.steps[step.id].report.output]))
    if (workflowHash(resolveWorkflowTemplate(normalized.output, { steps })) !== workflowHash(run.output)) throw processError("INVALID_CHECKPOINT")
  }
  return run
}

export function processView(run) {
  return { contract: run.contract, runID: run.runID, runSessionID: run.runSessionID, workflow: run.definition.name,
    revision: run.revision, status: run.status, output: run.output,
    ready: run.status === "running" && !Object.values(run.steps).some((step) => step.status === "active")
      ? run.definition.steps.filter((step) => run.steps[step.id]?.status !== "passed" && (run.steps[step.id]?.attempt ?? 0) <= step.maxRepairRounds
        && step.dependsOn.every((id) => run.steps[id]?.status === "passed")).map((step) => step.id) : [],
    steps: structuredClone(run.steps), submissions: structuredClone(run.submissions),
    requirements: structuredClone(run.definition.steps),
    next: "Main Agent executes work; begin requires stepID and expectedRevision. Report uses the latest revision, active attemptID, submissionID and exactly {status:reported-completed|failed,output,artifacts:[],evidence:[],diagnostics:[]}. After executing tools, read returns verified availableEvidence.references to copy; never invent source IDs. task/o4e_task remain independent. No side effects are replayed." }
}

// A list is navigation, not a report/output read or permission to continue.
export function processSummary(run) {
  const active = Object.entries(run.steps).find(([, step]) => step.status === "active")
  if (!text(run.definition.name) || active && !text(active[0])) throw processError("INVALID_CHECKPOINT")
  return { runID: run.runID, workflow: run.definition.name, status: run.status, revision: run.revision,
    activeStep: active ? { stepID: active[0], attemptID: active[1].attemptID, attempt: active[1].attempt } : null,
    passedSteps: Object.values(run.steps).filter((step) => step.status === "passed").length,
    totalSteps: run.definition.steps.length }
}

export function beginProcess(run, stepID, boundary, source) {
  if (!processView(run).ready.includes(stepID)) throw processError("STEP_NOT_READY")
  const step = run.definition.steps.find((item) => item.id === stepID)
  const dependencies = Object.fromEntries(step.dependsOn.map((id) => [id, run.steps[id].report.output]))
  const input = step.input === undefined ? run.input : resolveWorkflowTemplate(step.input, { workflow: run.input, dependencies })
  if (validateValue(step.inputSchema, input).length) throw processError("INVALID_STEP_INPUT")
  run.steps[stepID] = { status: "active", attempt: (run.steps[stepID]?.attempt ?? 0) + 1, attemptID: `wfa_${randomUUID()}`,
    input, inputHash: workflowHash(input), boundary, source, beginRevision: run.revision + 1 }
}

export function acceptProcessReport(run, args, evidenceDiagnostics, reportBoundary, reportSource) {
  const state = run.steps[args.stepID]
  const step = run.definition.steps.find((item) => item.id === args.stepID)
  if (state?.status !== "active" || state.attemptID !== args.attemptID) throw processError("ATTEMPT_MISMATCH")
  if (!text(reportBoundary) || reportBoundary !== run.boundary || !object(reportSource)
    || !text(reportSource.messageID) || !text(reportSource.callID)) throw processError("INVALID_CHECKPOINT")
  const report = args.report
  const diagnostics = [...evidenceDiagnostics, ...validateValue(step.outputSchema, report.output)]
  if (report.status !== "reported-completed") diagnostics.push("reported-failed")
  if (report.artifacts.length < step.gate.artifactsMin) diagnostics.push("artifacts-minimum")
  diagnostics.push(...gateEvidenceDiagnostics(run, step, report))
  if (step.execution.mode === "task" && !report.evidence.some((item) => item.kind === "task-created" || item.kind === "task-result")) diagnostics.push("task-reference-required")
  let output
  if (!diagnostics.length && run.definition.steps.every((item) => item.id === step.id || run.steps[item.id]?.status === "passed")) {
    const steps = Object.fromEntries(run.definition.steps.map((item) => [item.id, item.id === step.id ? report.output : run.steps[item.id].report.output]))
    try {
      output = resolveWorkflowTemplate(run.definition.output, { steps })
      diagnostics.push(...validateValue(run.definition.outputSchema, output, "$.workflowOutput"))
    } catch { diagnostics.push("invalid-final-output") }
  }
  const decision = { accepted: !diagnostics.length, diagnostics }
  state.report = structuredClone(report)
  state.decision = decision
  state.status = decision.accepted ? "passed" : "rejected"
  if (decision.accepted && output !== undefined) { run.status = "completed"; run.output = output }
  run.submissions[args.submissionID] = { attemptID: args.attemptID, stepID: args.stepID, boundary: reportBoundary,
    reportHash: workflowHash(report), decision, source: reportSource, revision: run.revision + 1 }
  return decision
}
