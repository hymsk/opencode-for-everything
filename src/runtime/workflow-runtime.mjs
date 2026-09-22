import { collectMcpServerNames, effectiveAgentPermission, permissionAction, permissionRules, WORKFLOW_TOOL } from "../core/agent-routing.mjs"
import { evaluate } from "../core/permission-rules.mjs"
import { workflowHash } from "../core/workflow-definition.mjs"
import { acceptProcessReport, assertProcess, beginProcess, newProcess, PROCESS_OWNER_RUN_LIMIT, processError, processSummary, processView, validateProcessArgs } from "../core/workflow-process.mjs"
import { OpenCodeSessionStore, sessionO4E } from "./session-store.mjs"
import { CommandLedgerStore } from "./command-ledger-store.mjs"
import { withWorkflowRunLock } from "./workflow-coordination.mjs"
import { canonicalDirectoryKey } from "./directory-key.mjs"
import { discoverWorkflowEvidence, readWorkflowEvidence } from "../adapters/opencode/workflow-evidence.mjs"
import { publicValue } from "./task-result-visibility.mjs"

const loaded = (agent, name) => agent.loadWorkflows?.some((entry) => entry === "*" || entry === name)
  && !agent.blockWorkflows?.some((entry) => entry === "*" || entry === name)
const terminal = (run) => ["completed", "stopped"].includes(run.status)
const source = (context) => ({ messageID: context.messageID, callID: context.callID })
const object = (value) => value && typeof value === "object" && !Array.isArray(value)
// UserMessage.summary is host diff metadata; AssistantMessage.summary is a
// compaction marker. Ignore only the current user-metadata shape, never flags
// on the message/Parts or any of the other public provenance guards.
const publicUserInfo = (info) => {
  if (info?.role !== "user" || !object(info.summary) || !Array.isArray(info.summary.diffs)
    || Object.keys(info.summary).some((key) => !["title", "body", "diffs"].includes(key))
    || ["title", "body"].some((key) => info.summary[key] !== undefined && typeof info.summary[key] !== "string")) return publicValue(info)
  const { summary: _summary, ...identity } = info
  return publicValue(identity)
}
const accessible = ({ session, agent, permission }, name) => loaded(agent, name)
  && permissionAction(permission, WORKFLOW_TOOL, name) !== "deny"
  && ["allow", "ask"].includes(evaluate(WORKFLOW_TOOL, name, permissionRules(permission), session.permission ?? []).action)
const LIST_OUTPUT_BYTES = 48 * 1024

// Only this owner's current-contract checkpoints are read. No Session discovery,
// delegation, scheduling, cancellation, or side-effect replay belongs here.
export class WorkflowRuntime {
  #store
  #commandStore
  #snapshot
  #directory
  #userTurnEpoch
  constructor({ client, directory, snapshot, store, commandStore, userTurnEpoch = () => 0 }) {
    this.#directory = canonicalDirectoryKey(directory)
    this.#store = store ?? new OpenCodeSessionStore(client, this.#directory)
    this.#commandStore = commandStore ?? new CommandLedgerStore(this.#store, this.#directory)
    this.#snapshot = snapshot
    this.#userTurnEpoch = userTurnEpoch
  }

  #indexShape(session) {
    const index = sessionO4E(session).workflowProcess
    if (index === undefined) return { contract: "process-v1", activeRunID: null, runs: {} }
    if (!object(index) || index.contract !== "process-v1" || !object(index.runs)
      || Object.keys(index.runs).length > PROCESS_OWNER_RUN_LIMIT
      || !(index.activeRunID === null || typeof index.activeRunID === "string")
      || Object.keys(index).some((key) => !["contract", "activeRunID", "runs"].includes(key))) throw processError("INVALID_INDEX")
    return index
  }

  #index(session) {
    const index = this.#indexShape(session)
    for (const [id, run] of Object.entries(index.runs)) {
      assertProcess(run)
      if (id !== run.runID || run.owner.sessionID !== session.id) throw processError("INVALID_INDEX")
      if (["running", "interrupted"].includes(run.status) && index.activeRunID !== id) throw processError("INVALID_INDEX")
    }
    if (index.activeRunID !== null && (!index.runs[index.activeRunID] || !["running", "interrupted"].includes(index.runs[index.activeRunID].status))) throw processError("INVALID_INDEX")
    return structuredClone(index)
  }

  #listIndex(owner, context) {
    const index = this.#indexShape(owner.session)
    const runs = Object.fromEntries(Object.entries(index.runs).filter(([, run]) => {
      if (run?.owner?.agent !== context.agent) return false
      if (typeof run.definition?.name !== "string") throw processError("INVALID_CHECKPOINT")
      return accessible(owner, run.definition.name)
    }))
    // Hidden business records and their active binding are neither validated nor
    // hashed. Otherwise corruption or concurrent hidden work becomes observable.
    return structuredClone({ runs, activeRunID: Object.hasOwn(runs, index.activeRunID) ? index.activeRunID : null })
  }

  async #owner(context, name) {
    const snapshot = this.#snapshot()
    if (snapshot?.runtime?.config?.enableWorkflow !== true) throw processError("DISABLED")
    const session = await this.#store.get(context.sessionID)
    const agent = snapshot?.agentByName?.get(context.agent)
    const state = sessionO4E(session)
    if (session?.id !== context.sessionID || session.parentID !== undefined || state.kind !== undefined
      || state.delegation !== undefined || state.task !== undefined || state.workflow !== undefined
      || !agent || !["primary", "all"].includes(agent.type)) throw processError("OWNER_DENIED")
    if (session.directory !== undefined && canonicalDirectoryKey(session.directory) !== this.#directory) throw processError("OWNER_DENIED")
    const permission = effectiveAgentPermission(agent, { agents: snapshot.agents,
      mcpServerNames: snapshot.mcpServerNames ?? collectMcpServerNames(snapshot.allAgents ?? snapshot.agents, snapshot.runtime?.config?.mcp) })
    if (name !== undefined && !accessible({ session, agent, permission }, name)) throw processError("AUTHORIZATION_DENIED")
    return { session, agent, permission, snapshot }
  }

  async #authorize(context, name, action) {
    await this.#owner(context, name)
    if (typeof context.ask !== "function") throw processError("HOST_ASK_REQUIRED")
    await context.ask({ permission: WORKFLOW_TOOL, patterns: [name], always: [], metadata: { action, workflow: name } })
    context.abort?.throwIfAborted()
    return this.#owner(context, name)
  }

  async #boundary(context) {
    if (typeof context.messageID !== "string" || typeof context.callID !== "string") throw processError("MESSAGE_BOUNDARY_UNVERIFIABLE")
    const messages = await this.#store.messages(context.sessionID)
    if (!Array.isArray(messages)) throw processError("MESSAGE_BOUNDARY_UNVERIFIABLE")
    const current = messages.find((message) => message.info?.id === context.messageID)
    const call = current?.parts?.find((part) => part.type === "tool" && part.callID === context.callID && part.tool === WORKFLOW_TOOL)
    if (current?.info?.role !== "assistant" || current.info.sessionID !== context.sessionID || !call
      || ![current, current.info, call, call.state].every(publicValue)
      || messages.filter((message) => message.info?.id === context.messageID).length !== 1
      || current.parts.filter((part) => part.callID === context.callID).length !== 1
      || !["pending", "running"].includes(call.state?.status)) throw processError("MESSAGE_BOUNDARY_UNVERIFIABLE")
    const realUsers = messages.filter((message) => message.info?.role === "user"
      && message.info.sessionID === context.sessionID
      && message.parts?.some((part) => !part.synthetic && !part.ignored && ["text", "file"].includes(part.type)))
    const parentUsers = realUsers.filter((message) => message.info.id === current.info.parentID)
    if (parentUsers.length !== 1 || realUsers.some((message) => !Number.isFinite(message.info.time?.created))
      || !Number.isFinite(current.info.time?.created)) throw processError("MESSAGE_BOUNDARY_UNVERIFIABLE")
    for (const message of realUsers) {
      if (message.info.id === current.info.parentID) continue
      if (message.info.time.created > current.info.time.created) throw processError("NEW_USER_MESSAGE")
      // The host exposes only millisecond message time plus an ID tiebreaker.
      // ID lexical order and returned array position are not trusted chronology.
      if (message.info.time.created === current.info.time.created) throw processError("MESSAGE_BOUNDARY_AMBIGUOUS")
    }
    return current.info.parentID
  }

  async #provenance(run, context) {
    const messages = await this.#store.messages(context.sessionID)
    const locate = (ref) => {
      const candidates = messages.filter((message) => message.info?.id === ref.messageID)
      const message = candidates[0]
      const parts = message?.parts?.filter((part) => part.callID === ref.callID) ?? []
      const part = parts[0]
      if (candidates.length !== 1 || parts.length !== 1 || message.info.role !== "assistant" || message.info.sessionID !== context.sessionID
        || ![message, message.info, part, part.state].every(publicValue) || part.tool !== WORKFLOW_TOOL
        || part.state.time?.compacted !== undefined || part.state.metadata?.truncated === true
        || !["running", "completed", "error"].includes(part.state.status) || !Number.isFinite(message.info.time?.created)) throw processError("INVALID_CHECKPOINT")
      return { message, input: part.state.input }
    }
    const initial = locate(run.source)
    if (initial.input?.action !== "start" || initial.input.workflow !== run.definition.name
      || workflowHash(initial.input.input === undefined ? {} : initial.input.input) !== run.inputHash) throw processError("INVALID_CHECKPOINT")
    const boundarySource = locate(run.boundarySource)
    if (boundarySource.input?.action === "start") {
      if (workflowHash(run.boundarySource) !== workflowHash(run.source)) throw processError("INVALID_CHECKPOINT")
    } else if (boundarySource.input?.action !== "resume" || boundarySource.input.runID !== run.runID) throw processError("INVALID_CHECKPOINT")
    const boundaryUsers = messages.filter((message) => message.info?.id === run.boundary && message.info?.role === "user"
      && message.info.sessionID === context.sessionID
      && message.parts?.some((part) => !part.synthetic && !part.ignored && ["text", "file"].includes(part.type)))
    if (boundaryUsers.length !== 1 || boundarySource.message.info.parentID !== run.boundary
      || !publicValue(boundaryUsers[0]) || !publicUserInfo(boundaryUsers[0].info)) throw processError("INVALID_CHECKPOINT")
    for (const [id, step] of Object.entries(run.steps)) {
      const begin = locate(step.source)
      if (begin.input?.action !== "begin" || begin.input.runID !== run.runID || begin.input.stepID !== id
        || begin.input.expectedRevision !== step.beginRevision - 1 || begin.message.info.parentID !== step.boundary) throw processError("INVALID_CHECKPOINT")
    }
    for (const [id, submission] of Object.entries(run.submissions)) {
      const saved = locate(submission.source)
      if (saved.input?.action !== "report" || saved.input.runID !== run.runID || saved.input.stepID !== submission.stepID
        || saved.input.attemptID !== submission.attemptID || saved.input.submissionID !== id
        || saved.input.expectedRevision !== submission.revision - 1 || workflowHash(saved.input.report) !== submission.reportHash
        || saved.message.info.parentID !== submission.boundary) throw processError("INVALID_CHECKPOINT")
    }
    for (const [id, state] of Object.entries(run.steps)) {
      if (state.status !== "passed" || !state.report.evidence.length) continue
      const submission = Object.values(run.submissions).find((item) => item.attemptID === state.attemptID)
      const diagnostics = await readWorkflowEvidence({ store: this.#store, commandStore: this.#commandStore,
        context: { ...context, ...submission.source }, step: run.definition.steps.find((item) => item.id === id),
        attempt: state, evidence: state.report.evidence })
      if (diagnostics.length) throw processError("EVIDENCE_SOURCE_LOST")
    }
  }

  #run(index, id, context) {
    const run = index.runs[id]
    if (!run || run.owner.sessionID !== context.sessionID || run.owner.agent !== context.agent) throw processError("OWNER_DENIED")
    const definition = this.#snapshot()?.workflows?.get(run.definition.name)
    if (!definition || definition.hash !== run.definitionHash) throw processError("DEFINITION_CHANGED")
    return run
  }

  async #save(context, original, index) {
    context.abort?.throwIfAborted()
    // updateO4E is same-process serialized. Check the complete observed index,
    // not a timestamp. Persist first; a failed response can be read/retried.
    await this.#store.updateO4E(context.sessionID, (state, session) => {
      if (context.workflowEpoch !== undefined && this.#userTurnEpoch(context.sessionID) !== context.workflowEpoch) throw processError("NEW_USER_MESSAGE")
      if (workflowHash(this.#index(session)) !== workflowHash(original)) throw processError("REVISION_CONFLICT")
      return { ...state, workflowProcess: index }
    })
  }

  async handle(rawArgs, context) {
    if (this.#snapshot()?.runtime?.config?.enableWorkflow !== true) throw processError("DISABLED")
    const args = validateProcessArgs(rawArgs)
    context = { ...context, workflowEpoch: this.#userTurnEpoch(context.sessionID) }
    context.abort?.throwIfAborted()
    if (args.action === "catalog") return this.catalog(context)
    if (args.action === "list") return this.#list(context)
    const owner = await this.#owner(context)
    const initial = this.#index(owner.session)
    const name = args.action === "start" ? args.workflow : this.#run(initial, args.runID, context).definition.name
    await this.#authorize(context, name, args.action)
    return withWorkflowRunLock(this.#directory, `process:${context.sessionID}`, async () => {
      const { session, snapshot } = await this.#owner(context, name)
      const original = this.#index(session)
      const index = structuredClone(original)
      if (args.action === "start") {
        const boundary = await this.#boundary(context)
        const existing = Object.values(index.runs).find((run) => run.source.messageID === context.messageID && run.source.callID === context.callID)
        if (existing) {
          if (existing.definition.name !== name || existing.inputHash !== workflowHash(args.input === undefined ? {} : args.input)) throw processError("START_CONFLICT")
          return JSON.stringify(processView(existing))
        }
        if (index.activeRunID !== null) throw processError("ACTIVE_RUN_EXISTS")
        if (Object.keys(index.runs).length >= PROCESS_OWNER_RUN_LIMIT) throw processError("OWNER_RUN_LIMIT")
        const definition = snapshot.workflows.get(name)
        if (!definition || definition.visibility !== "entry") throw processError("ENTRY_REQUIRED")
        const run = newProcess(definition, args.input === undefined ? {} : args.input, { sessionID: context.sessionID, agent: context.agent }, boundary, source(context))
        index.runs[run.runID] = run
        index.activeRunID = run.runID
        await this.#save(context, original, index)
        return JSON.stringify(processView(run))
      }
      const run = this.#run(index, args.runID, context)
      await this.#provenance(run, context)
      if (args.action === "read") {
        const active = Object.entries(run.steps).find(([, state]) => state.status === "active")
        let availableEvidence
        if (active) {
          const [stepID, attempt] = active
          const step = run.definition.steps.find((item) => item.id === stepID)
          availableEvidence = { stepID, attemptID: attempt.attemptID,
            ...await discoverWorkflowEvidence({ store: this.#store, commandStore: this.#commandStore, context, step, attempt }) }
          // Discovery is read-only, but source I/O must not bypass a permission
          // change or publish references for a checkpoint changed while reading.
          const latest = await this.#owner(context, name)
          if (workflowHash(this.#index(latest.session)) !== workflowHash(original)) throw processError("REVISION_CONFLICT")
          context.abort?.throwIfAborted()
        }
        return JSON.stringify({ ...processView(run), ...(availableEvidence ? { availableEvidence } : {}) })
      }
      // Identical submissions return their persisted decision even after later
      // revisions or user turns; they never execute or advance anything again.
      if (args.action === "report" && Object.hasOwn(run.submissions, args.submissionID)) {
        const submission = run.submissions[args.submissionID]
        if (submission.attemptID !== args.attemptID || submission.stepID !== args.stepID || submission.reportHash !== workflowHash(args.report)) throw processError("SUBMISSION_CONFLICT")
        return JSON.stringify({ runID: run.runID, submissionID: args.submissionID, ...submission, replay: true })
      }
      if (run.revision !== args.expectedRevision) throw processError("REVISION_CONFLICT")
      if (terminal(run)) throw processError("TERMINAL_RUN")
      const boundary = await this.#boundary(context)
      if (args.action !== "resume" && boundary !== run.boundary) {
        if (run.status === "running") {
          run.status = "interrupted"
          run.revision++
          await this.#save(context, original, index)
        }
        throw processError("EXPLICIT_RESUME_REQUIRED")
      }
      if (["begin", "report"].includes(args.action) && (run.status !== "running" || index.activeRunID !== run.runID)) throw processError("EXPLICIT_RESUME_REQUIRED")
      let decision
      if (args.action === "begin") beginProcess(run, args.stepID, boundary, source(context))
      if (args.action === "report") {
        const state = run.steps[args.stepID]
        if (state?.status !== "active" || state.attemptID !== args.attemptID) throw processError("ATTEMPT_MISMATCH")
        const step = run.definition.steps.find((item) => item.id === args.stepID)
        const diagnostics = await readWorkflowEvidence({ store: this.#store, commandStore: this.#commandStore, context, step, attempt: state, evidence: args.report.evidence })
        // A newly persisted user turn during evidence I/O invalidates promotion.
        if (await this.#boundary(context) !== boundary) throw processError("NEW_USER_MESSAGE")
        decision = acceptProcessReport(run, args, diagnostics, boundary, source(context))
      }
      if (args.action === "resume") {
        if (index.activeRunID !== null && index.activeRunID !== run.runID) throw processError("ACTIVE_RUN_EXISTS")
        index.activeRunID = run.runID
        run.status = "running"
        run.boundary = boundary
        run.boundarySource = source(context)
      }
      if (args.action === "pause") { run.status = "paused"; index.activeRunID = null }
      if (args.action === "stop") { run.status = "stopped"; index.activeRunID = null }
      if (run.status === "completed") index.activeRunID = null
      run.revision++
      if (args.action === "report") {
        assertProcess(run)
        await this.#provenance(run, context)
      }
      await this.#owner(context, name)
      await this.#save(context, original, index)
      return JSON.stringify({ ...processView(run), ...(decision ? { submissionID: args.submissionID, decision } : {}) })
    })
  }

  async #list(context) {
    try {
      const owner = await this.#owner(context)
      const initial = this.#listIndex(owner, context)
      // Freeze only current-caller candidates; never disclose another Agent's
      // workflow through ask metadata, counts, activeRunID or diagnostics.
      for (const [id, run] of Object.entries(initial.runs)) {
        assertProcess(run)
        if (id !== run.runID || run.owner.sessionID !== context.sessionID
          || ["running", "interrupted"].includes(run.status) !== (initial.activeRunID === id)) throw processError("INVALID_INDEX")
        processSummary(run)
      }
      const candidates = Object.values(initial.runs)
      const names = [...new Set(candidates.map((run) => run.definition.name))]
      if (names.length && typeof context.ask !== "function") throw processError("HOST_ASK_REQUIRED")
      for (const name of names) {
        try { await this.#authorize(context, name, "list") }
        catch {
          context.abort?.throwIfAborted()
          // Host rejection text may contain a now-denied workflow name.
          throw processError("AUTHORIZATION_DENIED")
        }
      }
      return await withWorkflowRunLock(this.#directory, `process:${context.sessionID}`, async () => {
        const current = await this.#owner(context)
        for (const candidate of candidates) {
          if (!accessible(current, candidate.definition.name)) throw processError("AUTHORIZATION_DENIED")
        }
        const index = this.#listIndex(current, context)
        // Include additions/removals even when the initial list was empty. Do not
        // silently expand the approved selection, repeat ask, or retry the read.
        if (workflowHash(index) !== workflowHash(initial)) throw processError("REVISION_CONFLICT")
        const runs = candidates.map((candidate) => this.#run(index, candidate.runID, context))
        for (const run of runs) await this.#provenance(run, context)
        // Evidence reads yield. Recheck every name, including earlier approvals,
        // against one fresh owner snapshot before publishing any summaries.
        const latest = await this.#owner(context)
        for (const run of runs) {
          if (!accessible(latest, run.definition.name)) throw processError("AUTHORIZATION_DENIED")
          this.#run(index, run.runID, context)
        }
        if (workflowHash(this.#listIndex(latest, context)) !== workflowHash(index)) throw processError("REVISION_CONFLICT")
        context.abort?.throwIfAborted()
        // No visible names means no host resource to ask for, and runs: [].
        const output = JSON.stringify({ status: "workflow-list", runs: runs.map(processSummary) })
        if (Buffer.byteLength(output) > LIST_OUTPUT_BYTES) throw processError("OUTPUT_TOO_LARGE")
        return output
      })
    } catch (error) {
      context.abort?.throwIfAborted()
      // Definition/schema/SDK errors may echo private record content. Only fixed
      // codes are public; malformed records never become a usable partial list.
      const codes = ["OWNER_DENIED", "HOST_ASK_REQUIRED", "AUTHORIZATION_DENIED", "INVALID_INDEX", "INVALID_CHECKPOINT",
        "DEFINITION_CHANGED", "EVIDENCE_SOURCE_LOST", "REVISION_CONFLICT", "OUTPUT_TOO_LARGE"]
      if (codes.some((code) => error?.message === `O4E_WORKFLOW_${code}`)) throw error
      throw processError("LIST_UNAVAILABLE")
    }
  }

  async catalog(context) {
    const { session, agent, permission, snapshot } = await this.#owner(context)
    const workflows = [...(snapshot.workflows?.values() ?? [])].filter((definition) => definition.visibility === "entry" && loaded(agent, definition.name)
      && permissionAction(permission, WORKFLOW_TOOL, definition.name) !== "deny"
      && evaluate(WORKFLOW_TOOL, definition.name, permissionRules(permission), session.permission ?? []).action !== "deny")
      .map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema }))
    return JSON.stringify({ status: "workflow-catalog", workflows, next: "Use action:start; ordinary work runs in the main Session." })
  }

  async resumeForSession(sessionID, context) {
    if (this.#snapshot()?.runtime?.config?.enableWorkflow !== true) return []
    // chat.message may run before its user Part is durable. It only invalidates
    // an explicitly indexed Run, never creates/dispatches/resumes one.
    return withWorkflowRunLock(this.#directory, `process:${sessionID}`, async () => {
      const session = await this.#store.get(sessionID)
      if (sessionO4E(session).workflowProcess === undefined) return []
      const original = this.#index(session)
      if (!original.activeRunID) return []
      const index = structuredClone(original)
      const run = index.runs[index.activeRunID]
      if (!context?.messageID || run.boundary === context.messageID || run.status === "interrupted") return []
      run.status = "interrupted"
      run.revision++
      await this.#save({ sessionID }, original, index)
      return [{ runID: run.runID, revision: run.revision, status: run.status, next: "Read latest user instruction; explicitly resume. Active work is not replayed; Tasks are unaffected." }]
    })
  }
}
