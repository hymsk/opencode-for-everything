# Workflow Reference (Beta)

[English](workflows.md) | [中文](workflows.cn.md)

[← Documentation Home](../README.md) | [Agent](./agents.md) | [Configuration](./configuration.md)

Workflow is an experimental Beta checkpoint protocol, disabled by default; it does not claim to be stable or production-ready, and it is not a background multi-Agent scheduler.
Ordinary steps are completed directly by the current main Agent using existing tools; the Runtime validates dependencies, reports, Gates, and persisted revisions.
Only an explicit Task requirement invokes the existing `task`. Workflow is not responsible for Task waiting, scheduling, cancellation, receipts, or interaction.

## Current Boundaries

- You must explicitly set `"enableWorkflow": true` in `.o4e/config.jsonc`, rebuild, and restart OpenCode before it opens; omitting it or `false` keeps it off, and a non-boolean value errors. `loadWorkflows` and permissions cannot replace the master switch.
- Disabling does not delete definitions or checkpoints and does not cancel existing Agent/Command tasks, but it does not open the Workflow read or advancement entry. Definitions must still pass static validation.

- Only `contract: "process-v1"` is accepted; it directly and breaking-replaces the old agent/workflow/loop definitions and the old invocation protocol.
- Only for new Runs created by new sessions; it does not migrate, scan, or process old sessions/old Runs.
- The new contract itself supports owner checkpoint recovery after plugin restarts and lost responses; it does not implicitly take over across sessions.
- One running/interrupted Run per owner at a time; one active Step per Run at a time.
- Nesting, Loops, parallel main Steps, and main-Session isolation declarations such as effect/writeScopes/permissionOverlay are all explicitly rejected.
- No cross-process CAS, exactly-once, atomic commit of external side effects and reports, or main-Session tool sandbox is promised.
- Verified on Linux / OpenCode 1.18.31 / real models: single-step Task creation, result reading, report Gate acceptance, and read/list completion states. The full matrix of the three evidence kinds, multi-user turns, compaction, restarts, authorization UI, and Windows/macOS still require independent acceptance; simulated plugin tests are not host verification.

## Definitions

Files live at `.o4e/workflows/<name>.jsonc`; the file name must equal `name`.

```jsonc
{
  "$schema": "../schemas/workflow.schema.json",
  "contract": "process-v1",
  "name": "bounded-change",
  "description": "设计、实施和验证一个有限变更",
  "inputSchema": {
    "type": "object",
    "required": ["task"],
    "properties": { "task": { "type": "string", "minLength": 1 } }
  },
  "output": { "$from": "steps", "path": "/verify" },
  "outputSchema": { "type": "object" },
  "steps": [
    { "id": "design", "type": "work", "description": "读取需求并确定边界和验收条件" },
    {
      "id": "implement", "type": "work", "dependsOn": ["design"],
      "description": "由主 Agent 完成授权范围内的实施",
      "input": { "$from": "dependencies", "path": "/design" },
      "maxRepairRounds": 1
    },
    {
      "id": "verify", "type": "work", "dependsOn": ["implement"],
      "description": "执行测试并读取真实结果，报告未验证项",
      "gate": { "evidence": ["command-success"] }
    }
  ]
}
```

The top level requires `contract/name/description/output/steps`. `visibility` defaults to `entry`; `internal` cannot be started directly, and sub-Workflow invocation is not currently supported either.
A Step requires `id/type`; type can only be `work`. `description` defaults to the id; `execution` defaults to `{mode:"self"}`.
`maxRepairRounds` defaults to 2, range 0..10; after failure an explicit begin is required, and once exhausted resume cannot add more rounds.

Input inherits the Run input by default; explicit templates may only use `$from:"workflow"` or declared `dependencies`.
The latter maps the accepted domain output, not the full StepReport. The top-level output may only read from `steps`.
`path` is a JSON Pointer (an empty string means the entire source); `default` only applies when the path does not exist. Missing sources, invalid references, and DAG cycles are rejected.

### Supported Schema Subset

Every Schema must explicitly declare a single `type`: object/array/string/number/integer/boolean/null.
The Workflow top-level and each Step's `inputSchema` and `outputSchema` **each default to `{type:"object"}` when omitted** — this is not unconstrained, and they do not inherit another layer's Schema. What a Step inherits by default is the Run's input value, not the Run's inputSchema. For example, if the top level explicitly allows string while a Step omits inputSchema, start can succeed but begin is rejected because the Step still requires object; when using scalars, arrays, or null you must explicitly declare the type at the corresponding layer. A report that omits outputSchema must still provide an object output.

Supports `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `minLength`, `minItems`, `description`.
Unknown keywords and keywords not applicable to the type are rejected; `required` names must appear in properties.
`$ref/const/oneOf/allOf/pattern/format/minimum` etc. are not supported and will not be silently ignored.

Step ids must not use the reserved names `constructor` or `prototype`. `dependsOn` allows duplicate entries; the builder deduplicates by first occurrence; duplicates do not create extra dependencies or executions. The Schema and the builder keep these two semantics consistent; the semantic constraints of the DAG, reference targets, and Schema keywords are still validated by the builder.

Default values of non-nullable configuration fields only apply when omitted; `visibility`, `execution`, `maxRepairRounds`, `gate.artifactsMin`, and an object Schema's `properties` do not accept explicit `null`. The optional `$schema` annotation must be a string. This does not restrict business input or output values explicitly declared with `type:"null"`.

## Tool Protocol

Every request must explicitly provide an action; the old omitted-action, bindings, and resumeRunID forms are not accepted.

`input` and `report` use native JSON values; do not wrap objects in JSON strings; string input stays a string and is not implicitly parsed. `begin` must provide `stepID`; the completion report's `status` must be `reported-completed`, not `completed`; errors indicate the missing field or the valid format, but do not echo input content.

After execution call `read`, and copy the `{kind,taskID,messageID,callID}` entries applicable to the current Step from `availableEvidence.references` into `report.evidence`. References are extracted from the current owner's completed tool records and undergo the same validation as the Gate; they are re-validated again when the report is submitted. Having no references does not mean success; do not guess IDs or rerun side effects just to obtain an ID. Discovery returns at most 32 entries and checks 128 candidates and 5000 Parts, showing `limited:true` beyond those limits; these are not caps on the underlying SDK download volume.

| action | parameters | behavior |
| --- | --- | --- |
| catalog | none | returns the entry definitions and inputSchemas the current main Agent is granted |
| list | none | authorized by the host under existing name permissions; lists Run summaries of the current owner and same Agent; does not restore or write |
| start | workflow, optional input | freezes the definition and input, returns revision=1; does not create a child Session |
| read | runID | rereads the current owner checkpoint, requirements, ready, steps, submissions; an active Attempt provides validated availableEvidence.references |
| begin | runID, stepID, expectedRevision | starts an Attempt whose dependencies have passed, returns attemptID, input, and requirements |
| report | runID, stepID, attemptID, submissionID, expectedRevision, report | accepts and persists the accept/reject decision; does not execute the next step |
| resume | runID, expectedRevision | resumes advancement after processing the latest instruction; keeps the active Attempt, does not replay work |
| pause | runID, expectedRevision | pauses and releases the current Run binding; does not cancel Tasks |
| stop | runID, expectedRevision | terminates further advancement; does not stop the main Session, Tasks, or commands |

```json
{"action":"start","workflow":"feature-development","input":{"task":"实现已确认变更"}}
```

`runID` is the `wfr_...` domain identity; `runSessionID` equals the owner Session. Records live at
`metadata.o4e.workflowProcess`; there is no separate background Workflow ledger, taskID, or execution Session.
`o4e_task` only manages real Tasks/Commands; it cannot manage Runs.

begin/report/resume/pause/stop use a positive-integer expectedRevision. Same-process calls from the same directory/owner are serialized, and the revision is rechecked before persistence.
A report retry with the same submissionID+payload returns the already-saved decision (even if the revision has since changed); a different payload is rejected.
A start from the same message/call source can reread the same Run; different tool calls are not guessed to be the same start.
Each owner currently keeps at most 32 Runs, and a single request JSON is at most 64 KiB; limits reject explicitly without automatically cleaning up user records.

When you do not know the `runID`, use `{"action":"list"}`. The list returns only names, states, revisions, the active step/Attempt, and step counts — no inputs, outputs, reports, or evidence bodies. With no visible items it returns an empty list; entries without permission are not leaked, and drifted definitions, corrupted records, or invalid sources are not presented as valid continuable Runs. Each visible Workflow is authorized by the host by name and re-verified after authorization; subsequent `read` and write operations are still independently validated. The TUI checkpoint panel only shows host-synced snapshots and does not equal the tool's source/authorization checks.

## StepReport and Gate

```json
{
  "status": "reported-completed",
  "output": { "summary": "已执行的实际结果" },
  "artifacts": [],
  "evidence": [],
  "diagnostics": []
}
```

Exactly these five fields; status can only be reported-completed or failed; the last three are arrays, and diagnostics elements are strings.
reported-completed is only the model's report; only `decision.accepted:true` passes the Gate.
The Gate checks outputSchema, artifactsMin, and gate.evidence; the final Run output must also pass the Schema.
An Artifact is a declaration and does not prove a file exists; do not put natural language into evidence to impersonate facts.

`gate.evidence` usually uses fact-type strings. When collecting the same Task result across Steps, use:

```json
{"kind":"task-result","taskFrom":"review"}
```

`taskFrom` must be a direct dependency of the current Step, that dependency must be `execution.mode:"task"`, and the Gate must require
`task-created`. The Runtime extracts the unique `taskID` from that dependency's accepted and revalidated Task creation reference, then requires the current
`task-result` to point at the same Task; it does not trust a taskID in the dependency output or model text. A failed dependency, non-unique identity,
wrong Agent/Task, forged or modified references are all rejected, and are revalidated on reread recovery.

The only supported factual references are:

```json
{"kind":"command-success","taskID":"o4e_command_...","messageID":"msg_...","callID":"call_..."}
```

- `command-success`: the owner's original successful Bash or a subsequent output Part; the original command hash, owner index, and canonical ledger match; it must be completed, exitCode=0, stop confirmed, output actually read without truncation, and logs complete. It only proves that command succeeded, not that coverage is sufficient.
- `task-created`: the owner's completed task tool Part matches a real Task/authorization envelope; it only proves creation, not review acceptance.
- `task-result`: the owner's completed `o4e_task output` Part; the task is completed, revision/ownership/authorization match, and the public body is consistent with the current result Message/Parts. It only proves the result was obtained; the conclusion may still be professional judgment.

References must be after the current Attempt's begin and before report. Missing begin/call sources, cross-owner, forged, expired, truncated, or source-deleted references are rejected.
File hashes, arbitrary command conditions, and general-purpose fact DSLs are not supported; unknown evidence requirements are rejected at the definition/report boundary.
Long output or missing complete logs currently cannot satisfy command-success; do not bypass it with a one-line "tests passed".

## Explicit Task

```jsonc
{
  "id": "review",
  "type": "work",
  "description": "调用 reviewer (plan) Task 并收集其创建引用",
  "execution": { "mode": "task", "agent": "reviewer (plan)" },
  "gate": { "evidence": ["task-created"] }
}
```

The main Agent calls task and then follows the existing watch/output protocol. Workflow does not replace task's loadAgents, host ask, Effect, Scope Lock, or depth limits.
The default `quality-gate` definition shows creation/collection as two independent Steps. Existing Tasks still exist after pausing/stopping a Run; the main Agent should list them truthfully and manage them per user intent, without automatically cancelling them together.

## Permissions, Messages, and Recovery

Only managed primary/all root Sessions may use it; both the owner Session and Agent are bound and cannot be taken over by a child Agent or another root Session.
catalog filters by loading, blacklist, and O4E/host permission; other entries require host context.ask even with O4E allow, and the policy is rechecked afterwards.
Workflow authorization does not grant ordinary tool or Task permissions.

chat.message only interrupts active Runs in the original owner index and returns a hint; it does not scan historical Sessions.
The main Agent must handle the newest user instruction first, then read/resume. Write operations validate the current assistant tool call and the real user message its host
`parentID` points to. The host currently provides only millisecond timestamps; under equal timestamps, neither array position nor ID lexicographic order
counts as a trustworthy ordering. When an ambiguous new user message cannot be excluded by parent relations, return an explicit error and fail closed rather than
advancing on the old instruction or automatically retrying forever. Timing validation cannot prove the model has understood the new instruction.
An active Attempt executed but not reported survives restarts as-is; existing work must be reconciled, not automatically re-executed.
Persistence failures, definition changes, corrupted records, or unverifiable sources all reject continuation; there is no legacy-field backfill or migration path.

## Verification

```bash
node --test test/workflow-definition.test.mjs test/workflow-process.test.mjs
npm test
```

The [Workflow creator Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md) only guides configuration creation; it does not expand permissions.
