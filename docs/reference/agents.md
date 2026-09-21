# Agent Reference

[English](agents.md) | [中文](agents.cn.md)

[← Documentation Home](../README.md) | [Configuration Reference](./configuration.md) | [Workflow Reference](./workflows.md) | [Soul and Prompt](./configuration.md#soul-and-prompt)

Agent configuration lives in `.o4e/agents/`. The directory determines the type; `mode` must not be
declared inside JSONC; the file name must match `name` and be globally unique. Source Agent names
use only lowercase letters, digits, and hyphens.

## The Four Agent Types

| Directory | OpenCode mode | User-selectable | Can initiate delegation | Can be a target |
| --- | --- | --- | --- | --- |
| `system/` | internal stage | No | No | No |
| `all/` | `all` | Yes | Yes | Yes |
| `primary/` | `primary` | Yes | Yes | No |
| `subagent/` | `subagent` | No | Yes | Yes |

`system` allows only `compaction`, `title`, `summary`. When `all` and `subagent` run as child
Sessions they may keep delegating per configuration; each layer still requires host authorization
and inherits the ancestors' permission Overlay and Effect/Scope restrictions.

"Can initiate delegation" in the table means the type permits it; the final decision is still
subject to concrete tool and `loadAgents` permission constraints. The default entry remains
`orchestrator`; the default `chat` is a read-only pure conversation role whose self Plan generates
only `chat (plan)` — it loads no tools, MCP, Skills, Agents, Workflows, or role directories, and
cannot delegate or manage tasks. The dedicated Chinese and English Plan reminders keep the same
boundary and introduce no other roles or execution flows.

### Subtask Execution Responsibility and Depth

The default specialized roles remain `subagent` type and do not appear in the main selector:
`architect` uses child Plan, generating an implementable `architect` and a read-only
`architect (plan)`; `researcher` and `reviewer` use self Plan, generating only `researcher (plan)`
and `reviewer (plan)`; `debugger` and `tester` remain ordinary mode. Calling `task` must use the
expanded exact name. Plan disables MCP by default, and the default effective Effect is read; after
explicitly opening execution or unknown MCP capabilities, read-only is no longer guaranteed, nor is
freedom from write-lock waits.

A child Agent completes the task itself by default and does not hand off the original task verbatim
or paraphrased as a whole. Only a strictly smaller subproblem whose result is independently
verifiable and that offers a capability or independent-evidence benefit is worth delegating; before
calling, state the evidence already gathered, the target capability, the retained work, and the
acceptance method. A role with identical permissions cannot supply a missing shell or source; when a
capability is missing, report the gap instead of repeatedly handing off.

Runtime provides `currentDepth`, `maxDelegationDepth`, `remainingDelegationDepth`, `sourceAgent`,
`targetAgent`, and `delegationAllowed` in actual subtask requests, computed from the verified parent
chain and frozen authorization — self-reported depth in task text is not trusted. The root is 0; the
default cap is 2. A last-layer child Session's `task` permission is deny and it is closed from its
requested tool list; non-last layers and the root are unaffected, and existing `o4e_task` management
permissions are retained. Continuation still provides depth information but does not resend the
completed original task instructions.

Whole-task handoff detection is a model behavior rule, not a semantic-similarity security check; the
real permission boundaries are host Session permission, the requested tool projection, and Runtime's
depth checks. Default template changes do not automatically overwrite existing `.o4e/` configuration
or hot-update an already-loaded host.

## Builder Required Semantics

Schema and Builder are two layers of constraints. Concrete `all`, `primary`, `subagent` must all
satisfy in Builder:

- non-empty, single-line `description`
- core Prompt provided by itself or `agentDefaults`
- file name equals `name`

Agent list ordering and default selection are managed by OpenCode. O4E does not override the host
default entry based on the selector list; native mode alias mapping still applies per configuration.
To pin the default entry, set `defaultAgent` in O4E configuration, pointing to a configured and
non-disabled `all`/`primary` or its Plan Profile; it overrides OpenCode's `default_agent`. When
omitted, the host still manages it.

The installation target does not keep the default catalog; the concrete Agent JSONC is the source of
truth for `description`.

## Minimal Examples

### Primary

`.o4e/agents/primary/main.jsonc`:

```jsonc
{
  "$schema": "../../schemas/primary-agent.schema.json",
  "name": "main",
  "description": "Main project agent",
  "base": "You are the main project agent.",
  "loadTools": ["question", "read", "glob", "grep", "task"],
  "loadAgents": ["worker"],
  "loadWorkflows": []
}
```

### Subagent

`.o4e/agents/subagent/worker.jsonc`:

```jsonc
{
  "$schema": "../../schemas/subagent-agent.schema.json",
  "name": "worker",
  "description": "Perform bounded delegated work",
  "base": "Complete the delegated task and report evidence.",
  "loadTools": ["read", "glob", "grep"],
  "loadAgents": [],
  "loadWorkflows": [],
  "capabilities": ["task.general"]
}
```

## Prompt Fields

Core Prompt schemes:

- `base`: inline text
- `systemPrompt`: Markdown path relative to `promptsDir`
- `nativeSystem`: array of Prompt names; concatenated in declaration order, preserving the dynamic
  tail after the host marker and before `Instructions from:`
- `injects`: can constitute the core Prompt alone, or append to `base`/`systemPrompt`

`base`, `systemPrompt`, `nativeSystem` are mutually exclusive; `nativeSystem` cannot be used
together with `injects`. `messagePrompt` is injected at each user message stage.

For example:

```jsonc
{ "nativeSystem": ["primary/native/base", "primary/native/policy"] }
```

Each entry must correspond to `.o4e/<promptsDir>/<name>.md`. `nativeSystem` does not fully preserve
the host system: Runtime keeps only the dynamic tail after the O4E marker, removes the host's
original `Instructions from:` rule block, then appends the managed protocol and instruction files.

If using:

```jsonc
{ "systemPrompt": "subagent/reviewer/system" }
```

then this must exist:

```text
.o4e/<promptsDir>/subagent/reviewer/system.md
```

config `agentDefaults` is only for `all`, `primary`, `subagent` that completely omit core Prompt
fields; `system` does not inherit.

## Native Mode

Only `primary` may declare:

```jsonc
{
  "name": "build",
  "nativeMode": "build"
}
```

`nativeMode` accepts only `build` or `plan`, and must match
`config.nativeAgents.<name>: "managed"`. Managed `general` and `explore` must be same-named
`subagent`s.

## Plan Profile

Plan must be declared explicitly:

```jsonc
{ "plan": { "mode": "self" } }
{ "plan": { "mode": "child" } }
```

| Mode | Result |
| --- | --- |
| `self` | generates only `<name> (plan)`; the unsuffixed source Agent is not kept |
| `child` | keeps the source Agent and additionally generates `<name> (plan)` |

All Plan Profiles (including managed native `plan`) must use lowercase `<name> (plan)`; unsuffixed
source names and historical `<name> (Plan)` are not accepted as Plan Profiles. When persisted state
references a nonexistent Agent name, recovery fails closed.

The default Plan permission tightens direct write capability, but explicit Plan configuration
applies last and can tighten further or intentionally reopen capabilities:

```jsonc
{
  "plan": {
    "mode": "child",
    "loadTools": ["question", "read", "glob", "grep", "edit"],
    "permission": { "edit": "ask" },
    "loadAgents": [],
    "loadWorkflows": []
  }
}
```

Runtime Safety ultimately still enforces legal delegation depth and target scope, but does not
unconditionally re-close explicitly opened `edit` or `bash`.

## Capability and Permission Fields

| Field | Semantics |
| --- | --- |
| `loadTools` | canonical builtin permission allowlist; `null` does not take over, `[]` denies all |
| `loadSkills` | Skill name allowlist; `["*"]` unrestricted, `[]` denies all, concrete names open item by item |
| `loadMcp` | MCP tool allowlist; `{"*": ["*"]}` opens all, `{}` closes all |
| `blockTools` / `blockSkills` / `blockMcp` | blacklists accumulated layer by layer, taking precedence over the corresponding allowlists and permission allow |
| `blockAgents` / `blockWorkflows` | delegation and Workflow blacklists accumulated layer by layer, taking precedence over the corresponding allowlists |
| `permission` | OpenCode `allow`/`ask`/`deny` rules |
| `loadAgents` | discoverable and delegatable `all`/`subagent` IDs |
| `loadWorkflows` | directly launchable `entry` Workflows |
| `capabilities` | stable dotted Skill IDs for Agent capability discovery; grants no permission |
| `backgroundTasks.maxRetries` | Agent Task manual retry round budget override |

Configuration accepts only canonical `edit`; it controls host `edit`, `write`, and
`apply_patch`. `write`, `functions.*`, and `apply_patch` are not legal configuration
permission names.

`config.loadSkills` is only the default when an Agent omits the field. Explicit arrays on Agent and
Plan are complete overrides; when Plan omits it, it inherits the Agent. Agent explicit permission
and Plan override apply after the base Skill policy, so they can intentionally override the
allowlist projection.

`capabilities` grants no permission. The process-v1 Workflow no longer auto-selects and dispatches
Agents by Skill/Effect; explicit Tasks require the main Agent to call the existing `task`, keeping
its Plan, Effect, Scope, and Overlay validation.

## The Sole Delegation Entry `task`

O4E registers a same-named managed `task` that overrides the OpenCode builtin in ordinary LLM tool
calls:

- Executes in background by default and returns a stable `taskID`.
- Only explicit `background:false` waits synchronously.
- Parameters keep the OpenCode Task card fields `description`, `prompt`,
  `subagent_type`, `background`, and add `plan`, `permissionOverlay`,
  `writeScopes`.
- slash-command subtasks go through the host builtin-only path; O4E rejects them in
  `command.execute.before`.
- When there is no legal target, permission is denied, the Overlay expands permissions, or the Scope
  is illegal, it fails before creating the child Session.

Ordinary delegation authorization is fixed as:

```text
task:<target-agent>
```

`permission.task` can tighten to `ask` or `deny` by target pattern. Only managed
`primary`/`all`/`subagent` can initiate per configuration; only `all`/`subagent` can be selected as
targets. `keep` retains Agent identity and configuration but not the builtin `task`/`bash`
implementations, and does not thereby gain delegation permission.

### `permissionOverlay`

```jsonc
{
  "permissionOverlay": {
    "bash": "deny",
    "edit": "ask"
  }
}
```

Overlay can only use canonical permission names and `ask`/`deny`, and cannot expand the target's
existing permissions. The managed `task` adapter can correct model-misgenerated
`functions.bash`, `functions.write`, `functions.apply_patch`, but core configuration, Workflow, and
ledger always keep canonical names.

Nested delegation continues to apply ancestors' Overlays. Inheritance supports `ask` for `*`, `ask`
for concrete permission names, and `deny` for wildcard names; a non-`*` `ask` wildcard name that
cannot precisely represent the permission intersection is explicitly rejected, and ancestor
restrictions are not ignored.

### Nested Delegation and Native Interaction

The top-level `maxDelegationDepth` of the currently effective `.o4e/config.jsonc` is shared by all
Agents, default 2, legal values integers 1..5; after changing it, rebuild and reload OpenCode
through the existing process — hot update is not promised.
The root Agent has depth 0; each Agent `task` adds 1; Workflow main-session Steps do not increase
delegation depth. "Root → child → grandchild" is allowed by default; an Agent at the cap cannot
create the next layer. Raising the cap is not recommended, to avoid increasing task volume, cost,
and coordination complexity.

Each layer of Agent creates its own lower level via `task`, then waits and reads results via
`o4e_task watch/output`. Permissions and questions are handled by the user in OpenCode's root
session native prompt. So that deeper-layer requests are also shown, execution Sessions are
uniformly attached to the root session in the host; O4E still stores and validates the real
layer-by-layer owner. Task cards can be clicked to enter the corresponding lower level, and the
host's "back to parent session" returns to the root page.

Ancestor permission, cancellation, read-only, and write scope restrictions remain in effect. A
background Agent Task paused waiting for a lower level does not end the whole task; after the lower
level completes, Runtime resumes in a controlled way and reads results layer by layer. An ordinary
foreground `task` call waits for the current call result; this is not equivalent to a Workflow
Step's lifecycle. A Workflow Run is the owner Session's process-v1 checkpoint, not a background Task
ledger. The main Agent advances it with `o4e_workflow action:begin/report` and explicitly resumes
with `read/resume`; it creates no execution Session, schedules or cancels no Task, and does not
enter the `o4e_task` management entry.

## `o4e_task`

`o4e_task` does not create Tasks. The following actions and the group, receipt, and message preview
protocols are only for Agent Tasks:

```text
status | watch | inspect | output | input | resume | cancel | resolve | pending
permission.reply | question.reply | question.reject
```

- Authorized managed `primary`/`all`/`subagent` callers can manage the Agent Task Group created by
  their own Session, subject to host `o4e_task:agent:<action>` authorization. Native `keep` is not
  granted by Session ownership; a child must not manage its own parent Task or sibling Tasks across
  levels.
- `watch` freezes the selected Agent and Command Tasks at entry; when the selector is omitted it
  freezes the owner's two pending sets not yet reliably delivered at that time; mixed `taskIDs` may
  be selected explicitly; terminal Tasks with persisted acknowledged receipts are excluded by
  default; an explicit empty `taskIDs` selects the empty set and later new Tasks do not join. It
  returns as soon as any new terminal or actionable event appears, returning only status. Consumed
  Agent terminal states are deduplicated by receipt; Command status events are deduplicated only by
  the original Bash terminal response bound to a trusted public watch or canonical source; Command
  status/output does not consume watch events; non-terminal events are deduplicated only when the
  previous public body was fully delivered and `taskID/status/phase/revision` match; repeat
  reporting is allowed when reliable evidence is missing. Identical events keep waiting; when all
  selected terminal events have been delivered it returns `empty`, and explicit selectors do not
  re-wake consumed terminal states. User messages and reader abort can still interrupt the wait.
  When `timeoutMs` is omitted or zero the default window is 30 minutes; a positive explicit value
  allows up to 1 hour; the deadline is fixed with no backoff; after expiry it returns
  `heartbeat` or another actionable result — first report a meaningful current status to the user,
  then call the next watch; watch returns only status, so call output before reporting a completed
  Agent result. Failed, cancelled, unknown/interrupted, and explicit-wait states must not be stated
  as success. Real user messages and terminal/explicit-wait states take priority. Runtime does not
  generate synthetic heartbeat progress messages; intermediate TUI visibility depends on the host.
  Heartbeat does not automatically cancel or restart.
  `reason: "user-message"` means a real user message takes priority and does not mean the Task was
  cancelled.
- After `completed`, read the result authoritatively via `output`. Each output returns the body,
  preserving whitespace and empty output, with only necessary truncation or incomplete-log notices.
- Watch/status are status-only, without result bodies or heartbeat tails; a completed Part's
  `metadata.o4eResult` retains a trusted bounded structure.
- `inspect` requires `taskID`; optional non-empty `cursor` max 512 characters; `direction` is
  default `"forward"` or `"backward"`; `maxBytes` is a safe integer 4..8192, default 1024. Agent
  cursors accept only the current compact format, max 120 characters. Singular `cursor` is only for
  inspect; `beforeCursor` is provided only when earlier data exists. A cursor is not authorization;
  inspect does not consume receipts and does not judge completion.
- Inspect returns compact `taskID`/`status`, available `tail`/`cursor`, and optional
  `unchanged`/`unavailable`/`gap`; it previews only public assistant text, tool name/status, and
  safe allowlist summaries of verified current dispatch/compaction lineage: `read` may show a
  bounded workspace-relative `filePath`, `glob`/`grep` may show a bounded workspace-relative `path`
  and conservatively length-limited `pattern`; sensitive, external, URL/query-like, malformed, or
  overlong values are omitted; unknown tools still show only name/status. Summaries do not enter the
  cursor and do not change authorization. Each call reads at most 5 pages of 20 entries, without
  cache or full-history fallback; SDK oversized message/Parts download byte volume is not guaranteed
  bounded.
- A cursor fixes a UTF-8 position and supports appends; rewriting of the source's entire old public
  snapshot prefix, tool status changes, or deletion return `gap`, and it does not jump to the new
  tail. A cursor is still not authorization.
- Inspect explicit `resume:true` resumes position from real `o4e_task` inspect responses persisted
  in the caller's parent Session, taking only responses before the current tool's
  `messageID`/`callID`; parent history is scanned for at most 5 pages of 20 entries, without adding
  caches or cursor tables. It cannot be combined with `cursor`; backward inspect uses the most
  recent `beforeCursor` and returns `unavailable` when there is no earlier position.
- The first forward resume is allowed to be fresh only after exhausting history and confirming no
  old anchor or failure; empty `unchanged` or queued `not-dispatched` without body/cursor can keep
  first-time state. When the latest failed/gap, output corrupted, boundary unclear, or the history
  limit is reached before a position is found, it returns `unavailable` and does not fall back to
  historical success or a new tail. Exactly-once across multiple readers is not guaranteed;
  concurrent pending/running calls fail closed. Deliberately omitting `resume` or setting it false
  without a manual cursor re-fetches the recent tail and is not lossless recovery from a gap.
- Only inspect/watch accept safe integer `ioTimeoutMs: 1..60000` (default 10000 ms). From the tool
  execute entry it covers recovery, authorization, cursor scan, the watch window, expiry recheck,
  and UI; the inspect deadline is the allowance, watch is the normalized window plus allowance,
  fixed and not extended. It is not a Task timeout and cancels neither the child nor shared
  recovery; it only cancels the read wait — already-started lifecycle Promises keep being tracked
  and dispose still waits for them.
- After a receipt consumption transaction is admitted (including the adapter consuming callback),
  the deadline closes and it is not interrupted by deadline/abort; it must wait and return the
  actual result, which may still fail; a committed result does not wait for final best-effort UI
  metadata. This is not an absolute hard wall-clock cap and cannot hard-limit synchronous JavaScript
  or SDK oversized payload handling.
- `input`, `resolve`, and interaction replies carry the latest `expectedRevision`.
- `input` keeps safe next-turn semantics by default: input is first persisted as a `pending` queue
  and is not injected in real time into a running turn. When `delivery: "steer"` is passed, it
  requests the host to persist the input and schedule it for the next runnable turn; steer is
  reported only after the host confirms acceptance, otherwise it falls back to queueing, and the
  return value makes `inputDelivery.mode` and the boundary explicit.
- `resume` carries the latest `expectedRevision` and only wakes queued/retry/pending-input Tasks
  that can be safely redispatched; executions that are uncertain or being cancelled are not
  restarted. `cancel` remains for explicit termination.
- All Agent Task model errors retain their cause and enter `waiting_retry_decision`; O4E does not
  automatically retry the model or automatically switch fallback. The main Agent explicitly chooses
  `resolve continue|restart|stop` with the latest revision; candidates and error classification are
  diagnostic only. continue/restart still recheck authorization, CAS, cancellation, Attempt, Scope
  Lock, and side-effect boundaries; host provider internal retries are outside plugin control.
- Permission/question prompts remain by default in OpenCode's root session native prompt, operated
  by the user. Only when the user explicitly asks to operate the current request on their behalf
  should you first refresh the revision with `pending` and then reply; do not infer authorization
  from task goals or a generic "continue".
- Receipts are at-least-once delivery, deduplicated by `receiptID`.

Both Agent and Command cancel via `{"action":"cancel","taskID":"…"}` with only these two fields.
`reason` is not an input field for any `o4e_task` action, including `resolve`; Runtime automatically
records the necessary cancellation diagnostics. The `reason` in watch/Command return values is
unaffected.

Task recovery revalidates canonical `task` authorization, target, fingerprint, Effect, Scope,
Overlay, and approval. Without the complete frozen context it enters
`unknown/authorization-unverifiable` and can only be queried and cancelled.

### Command Task

`o4e_task` supports `status/watch/inspect/output/cancel/pending` for commands; `pending` returns an
empty list with `supported:false`. Every Task validates the caller owner index, current permission,
and host `o4e_task:command:<action>` authorization. Watch by default includes the owner's current
Agent and Command Tasks; mixed `taskIDs` may be selected explicitly; other actions accept only one
`taskID`. Authorized native `keep` roots and managed children can only manage their own commands and
do not thereby gain Agent management capability. Command input, retry/resolve/restart, and
permission/question replies are not supported. Commands do not delegate to a model, do no model
fallback, and generate no Agent receipt. Managed commands use the Host Shell from OpenCode's current
configuration or the platform default — not limited to Linux or absolute Bash; command syntax,
argument protocol, and lifecycle boundaries follow the actual acceptance evidence of the Host Shell
and the corresponding platform.

Watch by default waits a fixed 30 minutes, maximum 1 hour; state changes do not extend the window;
real user messages and reader abort can interrupt the wait. Inspect/watch use an independent
`ioTimeoutMs` read budget; cancelling a read does not cancel execution. Inspect reads 1024 bytes by
default; `maxBytes` is optionally 4..8192; `cursor`, `direction`, or `resume:true` without a manual
cursor may be passed. Resume only reads the previous inspect position and does not re-execute.
Previews come from a retained view of at most 64 KiB; cursors bind Task/Session/claim and the output
prefix; truncation or prefix changes report a gap. To view the latest segment, use backward without
an old cursor/resume:

```json
{ "action": "inspect", "taskID": "<returned-command-taskID>", "direction": "backward", "maxBytes": 4096 }
```

The tail grows with output; neither an inspect preview nor a watch heartbeat means the command is complete.

A child executing Bash must verify frozen authority and still requires `unknown-write` permission,
but does not borrow an execution Scope Lock; it cannot upgrade read/scoped permissions or have the
model specify the owner. Write locks between Agents and parent-child lifecycle constraints remain
unchanged. For the complete boundaries of ordinary Host Shell syntax, environment, output, and
cancellation, see the [command reference](./configuration.md#managed-bash-and-command-tasks).

## Effect and Scope

| Effect | Derivation |
| --- | --- |
| `read` | no usable Bash, external directory, unknown write tool, or `edit` |
| `scoped-write` | `edit` available and `writeScopes` non-empty |
| `unknown-write` | Bash/external directory/unknown write tool available, or `edit` without Scope |

`writeScopes` validates both lexical and real paths, rejecting directory escape, symlink escape, and
existing hardlink targets. All `apply_patch` Add/Update/Delete/Move paths are checked before
execution. Bash and `execute` cannot statically bind file Scope and therefore derive as
`unknown-write`.

## Prompt and Rules

The final system is assembled from managed Prompt, injects, the optional Background Task protocol,
instruction files, and Soul. Skills load only at invocation and grant no extra tool, network, write,
or delegation permission.

## See Also

- [Configuration Reference](./configuration.md)
- [Workflow Reference](./workflows.md)
- [Creating and Optimizing Agents](../guide/creating-agents.md)
- [O4E Engineering Contract](../../SPEC.md)
