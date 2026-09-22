# Configuration Reference

[English](configuration.md) | [中文](configuration.cn.md)

[← Documentation Home](../README.md) | [Agent Reference](./agents.md) | [Workflow Reference](./workflows.md) | [Skill Reference](./skills.md)

`.o4e/` is the editable source of truth; `.opencode/` is generated output. For machine
constraints on fields see [`defaults/.o4e/schemas/`](../../defaults/.o4e/schemas/);
build and runtime semantics are defined by `src/runtime-builder.mjs`.

## Configuration Root

Runtime selects one configuration root in the following order, without deep merging:

1. `<project>/.o4e/` when `o4e_config` is not set
2. the global root `~/.config/opencode/.o4e/` when `o4e_config` is not set (its parent
   directory may be replaced by an absolute `XDG_CONFIG_HOME`)
3. when `o4e_config` is set explicitly, only that directory is used and the project root is skipped

A project `.o4e/` shadows the default global configuration whenever it exists. If project
configuration parsing fails, an Agent/Workflow is invalid, or a Prompt reference is missing,
Runtime fails closed directly and does not fall back to the global configuration.

Within the same configuration root, `config.jsonc` shadows `config.json` when present. If the
selected `config.jsonc` is invalid, Runtime does not try `config.json`.

## Directories

```text
.o4e/
├── config.jsonc
├── soul.md
├── agents/
│   ├── system/
│   ├── all/
│   ├── primary/
│   └── subagent/
├── workflows/
├── prompts/
├── skills/
└── schemas/
```

All four Agent type directories must exist. The installation target must not retain
`agents/default.json[c]`; the installer materializes the `description` of the selected
language from the default catalog into the concrete Agent JSONC.

### Default Agent

`defaultAgent` is an optional field, e.g. `"defaultAgent": "orchestrator"`. When set, it
overrides OpenCode's `default_agent` after native mode mapping; when omitted, no default
entry is additionally specified. The target must be an O4E-configured `all`/`primary` or its
generated `<name> (plan)`; it cannot be a pure subagent, a nonexistent role, or an entry
disabled by the host. This field does not control list ordering or persist the last selection.
At install time, the first selected `all`/`primary` in catalog display order is written,
usually `orchestrator`; if it was not selected, the next selected primary Agent is used.
A normal build does not change this value.

## Minimal Configuration

### Explicit Workflow Beta Opt-in

`enableWorkflow` is a top-level boolean field, default `false`; omitting it also keeps it off. Workflow is experimental Beta and is not claimed to be stable or production-ready. To experiment, merge `"enableWorkflow": true` into the existing `.o4e/config.jsonc`, then rebuild and restart. An Agent's `loadWorkflows`, a Plan override, or explicit permission cannot bypass the disabled state. Disabling does not cancel ordinary tasks already created, nor delete configuration or checkpoints; definition files still pass static validation.

### Required Fields Example

```jsonc
{
  "$schema": "./schemas/config.schema.json",
  "nativeAgents": {
    "build": "disable",
    "plan": "disable",
    "general": "disable",
    "explore": "disable"
  }
}
```

`nativeAgents` is a required top-level Schema field. Builder also requires the four Agent
type directories to exist, and `primary` plus `all` to contain at least one valid Agent in total.

## Top-level Fields

| Field | Default and effect |
| --- | --- |
| `language` | `"zh"` or `"en"`; the installer selects one set of Prompts and flattens it into `prompts/` |
| `maxDelegationDepth` | `2`; global Agent delegation depth cap, accepts only integers 1..5 |
| `backgroundTasks` | `{ maxRetries: 1, maxConcurrentAgents: 4, maxConcurrentCommands: 4 }` |
| `nativeAgents` | required; each of the four native Agents uses `keep`, `managed`, or `disable` |
| `agentDefaults` | Prompt defaults for `all`, `primary`, `subagent` that do not declare a core Prompt |
| `soul` | Soul file, enabled state, and `override`/`extend` inheritance mode |
| `instructionFiles` | global/project rule file lists |
| `loadTools` | `null`; does not take over the builtin tool allow/deny allowlist |
| `loadSkills` | `["*"]`; default Skill name allowlist when an Agent does not declare it explicitly |
| `permission` | fresh installs write `{ "external_directory": "allow" }`; custom configurations with the field omitted normalize to `{}`, which does not mean a fresh install has no directory permission default |
| `mcp` | `{}`; local/remote MCP servers managed by O4E |
| `loadMcp` | `{ "*": ["*"] }`; all MCP tools open by default, `{}` explicitly disables them |
| `blockTools` / `blockSkills` / `blockMcp` | blacklists, accumulated layer by layer and taking precedence over the corresponding allowlists and `permission.allow` |
| `blockAgents` / `blockWorkflows` | delegation and Workflow blacklists, accumulated layer by layer and taking precedence over the corresponding allowlists |
| `loadAgents` | `["*"]`; discovers all legal `all`/`subagent` by default |
| `loadWorkflows` | `["*"]`; config-level default loads all `entry` Workflows |
| `promptsDir` | `prompts`; Prompt root directory |
| `agentsDir` | `agents`; Agent configuration root directory |
| `workflowsDir` | `workflows`; Workflow configuration root directory |

Explicit Agent fields take precedence. `instructionFiles`, `loadSkills`, `loadMcp`, `loadAgents`,
and `loadWorkflows` still override as allowlists; `blockSkills`, `blockTools`, `blockMcp`,
`blockAgents`, `blockWorkflows` are blacklists accumulated layer by layer, and blacklists take
precedence over any allowlist or permission allow.

`maxDelegationDepth` sits at the top level of the currently effective `.o4e/config.jsonc` and is
shared by all Agents; "global" here means configuration scope, not an OS-level global
installation, and not an Agent or `backgroundTasks` field. After changing it, rebuild and reload
OpenCode through the existing process; hot reload is not promised.
The root Agent has depth 0, its direct child Agent depth 1, and the level below that depth 2; each Agent `task` adds 1.
Workflow main-session Steps do not increase delegation depth; explicit Tasks use the same existing delegation entry.
Launches exceeding the configured cap are rejected. Raising the default is not recommended, to avoid
increasing task volume, cost, and coordination complexity; the hard cap is 5.

After lowering the cap and reloading, subsequent dispatch, managed Bash, and Task management by
Agents already beyond the depth are rejected at authorization revalidation, and recovery may enter
the conservative `unknown`. Already-running models do not stop immediately because of this;
other host tools remain governed by existing permission rules. Legal owners within the effective
depth can read completed results, and ancestors can still initiate cancellation.

`loadSkills: ["*"]` does not restrict by name; `[]` projects
`skill: { "*": "deny" }` at the base `skillPolicy` stage; an array of concrete names projects a
wildcard deny plus per-name allow. When Plan omits the field it inherits from the Agent; an
explicit array overrides completely. Duplicate names, legacy boolean values, and declaring both
`"*"` and concrete names all fail closed. The config hook then also merges the Agent's
explicit permission and Plan override, so they can intentionally override that projection.

## Native Agents

```jsonc
{
  "nativeAgents": {
    "build": "managed",
    "plan": "managed",
    "general": "keep",
    "explore": "disable"
  }
}
```

- `keep`: keeps the host Agent identity and configuration; the target must not contain a
  corresponding managed Agent; builtin tool implementations are not kept. Same-named `bash` and
  `task` override global ordinary tool calls; host permissions still apply, and a `keep` Agent is
  not granted delegation or Agent Task management permission.
- `managed`: taken over by O4E. `build`/`plan` require a `primary` declaring a matching
  `nativeMode`; `general`/`explore` require a same-named `subagent`.
- `disable`: disables the same-named entry in the host configuration projection; the target must
  not contain a corresponding managed Agent.

All four items must be declared explicitly. The installer's default `o4e-only` preset sets all
four to `disable`.

## Model Selection and Run Modes

An unset `o4e_mode` is equivalent to `default`, preserving full model configuration capability:
config can set `defaultModel`, `fallbackModels`; Agents can set `model`, `fallbackModels`.
A model accepts `"provider/model"` or `{ "id": "provider/model", "variant": "high" }`.
When an Agent model is absent/null it inherits the global default; when the global is also null,
the host's is used. An omitted fallback inherits the global; explicit `[]` disables it.
Plan inherits the source Agent's model and does not declare its own model field.

Builder writes configured models and variants into Agent frontmatter; the default config hook keeps
the declared candidates and does not mistake provider configuration overrides for the complete model
library; the actual model is resolved and validated when the host makes the request. A model
explicitly chosen by the user in a message is not rewritten by `chat.message`; automatic continuation
follows the actual message selection. A managed Agent Task preferentially freezes the target's
configured candidates, and when none are configured freezes the parent Session model;
resumption does not reabsorb configuration changes. `fallbackModels` is retained as frozen candidate
data, but O4E does not automatically retry the model or automatically switch to a fallback after a
model error; Command Tasks do not use models.

Neither the main session nor Agent Tasks automatically consume explicit or inherited `fallbackModels`.
Candidates are only for diagnostics and explicit decisions by the main Agent; `fallbackModels: []`
means there are no additional candidates and the user's current selection stays unchanged. The host
provider may retry internally on its own; that happens outside the plugin's control boundary.

`o4e_mode=origin` returns a clean host projection without initializing the managed O4E Runtime.
`o4e_mode=clear` still loads O4E Agent, permission, Skill, MCP, and tool projections, but removes
the top-level and per-Agent `model`/`variant` in the final config hook, and also disables internal
configuration candidates and fallback. The host can still use explicit or remembered
selections; `clear` does not modify `.o4e/`, host configuration files, credentials, or the global
model library; an empty string or any other unsupported value is treated as `default` and reported
through an error diagnostic instead of failing startup.

The post-installation configuration notes also summarize the [model configuration boundary](../../defaults/.o4e/README.md#配置规则).

To change these values after installation, either edit the `.o4e/` source files above and run `build`, or use the [`model` subcommand](./cli.md#model-configuration), which edits the selected source file with comments preserved and rebuilds the runtime, rolling back on validation failure.

## Canonical Permission

The current legal values of `loadTools` are:

```json
["question", "bash", "read", "glob", "grep", "edit", "task", "execute", "webfetch", "websearch", "lsp", "todowrite", "skill"]
```

`loadTools`, `permission`, and `permissionOverlay` in configuration accept only canonical
OpenCode permission names:

- Use `edit` to control host `edit`, `write`, and `apply_patch`.
- `write` is not a legal configuration name; Builder and Schema reject it directly.
- `functions.*` and `apply_patch` are also not legal permission names.
- `loadTools: null` does not take over builtin allow/deny; `[]` denies everything.
- When the host has not enabled `execute` or `lsp`, opening the permission does not create the tool.

The managed `task` adapter only corrects commonly misgenerated
`functions.bash`, `functions.write`, and `functions.apply_patch` at the ordinary model call
boundary. This correction is not written back to configuration or the Task ledger and does not
constitute configuration compatibility semantics.

```jsonc
{
  "loadTools": ["question", "read", "glob", "grep", "task"],
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "external_directory": "deny"
  }
}
```

## Background Task

Managed `task` is the only Agent delegation entry: omitting `background` or passing `true` creates
a background Agent Task; only explicit `background:false` waits synchronously. The global managed
`bash` is already the creation entry for command Tasks and executes directly without delegating to
a model. `o4e_task` only manages existing Tasks; it creates neither delegations nor commands.
The two Task kinds share resource scheduling, but only Agents use write scope locks; the Agent
ledger, recovery, interaction, receipt, and message preview described below apply only to Agent
Tasks, while watch sets support Commands as well. For Commands see
[Managed Bash And Command Tasks](#managed-bash-and-command-tasks).

```jsonc
{
  "backgroundTasks": {
    "maxRetries": 1,
    "maxConcurrentAgents": 4,
    "maxConcurrentCommands": 4
  }
}
```

- `maxConcurrentAgents` is the concurrency cap per parent Session Agent lane.
- `maxConcurrentCommands` is the concurrency cap per owner Session command lane,
  used by command Tasks created by the global `bash`; it does not occupy Agent slots. Bash is not
  blocked by Scope Locks and still queues when the command count cap is reached.
- `maxRetries` only limits the extra retry rounds of an Agent Task's `resolve continue|restart`.
- A single Agent can use `backgroundTasks.maxRetries` to override the retry budget; it cannot
  override lane concurrency caps.

The Scheduler groups by `ownerSessionID` first, then splits lanes by `agent`/`command`. Queued
Tasks are admitted in `sequence` order within the concurrency quota; they are not blocked or
skipped based on the read/write mode of active tasks in the other category.
Admission order does not guarantee global execution FIFO; actual write conflicts are handled by the
`ScopeLockManager`:

- `read` holds no write lock; a root read can observe the workspace in parallel with write tasks
  and provides no consistent snapshot.
- `scoped-write` locks the normalized `writeScopes`.
- `unknown-write` conflicts with other write locks.

Plugin instances in the same directory share these coordination objects within the current OpenCode
JavaScript process; releasing one instance does not clear other instances' admission or locks.
They are not cross-process leases.

### Ledger and Recovery

The canonical Agent Task lifecycle ledger lives at `metadata.o4e.task` of the Task Session;
the complete frozen delegation authorization lives at the sibling `metadata.o4e.delegation` of the
same Session. The parent Session stores the Task reference, sequence, a recovery envelope
containing both, cancellation evidence, and the terminal receipt. Receipts are stored only in
`taskRefs[taskID].receipts[]`; flat `receiptID`, `receiptStatus`, and
`receiptCreatedAt` are not part of the current structure. Each Task ref's receipt history keeps at most
`TASK_REF_RECEIPT_LIMIT` entries; the Task ref map itself currently has no total count cap.
Receipts are at-least-once delivery; callers deduplicate by the stable `receiptID`; business results
may only be read after `completed` via `o4e_task output` through persisted Message/Part references.
After the parent Session's `watch` does return a terminal Task, or `output` successfully reads a
completed result, Runtime persists that tool consumption by `receiptID` to both the canonical Task
ledger and the parent `taskRefs[].receipts[]`; repeated consumption stays idempotent, and a plugin
reload does not reschedule already acknowledged receipts. `watch` aborts/read timeouts before the
consumption transaction is admitted, heartbeats, `reason: "user-message"`, and failed `output`
calls do not acknowledge receipts early; a consumption transaction after admission must wait for the
actual result — see the read budget below. Receipts carried by ordinary user turns are still
acknowledged after the corresponding parent Assistant turn completes successfully; on Assistant
error or interruption, at-least-once redelivery is preserved.
Multiple plugin instances in the same directory share terminal continuation claim and consumed
receipt state; durable acknowledgement by `watch`/`output` prevents other instances from submitting
the corresponding continuation again. Concurrent submissions, lost responses, or retries after a
parent Assistant error/interruption reuse the same `messageID` and synthetic `partID`, and do not
generate mutually independent parent-turn identities for the same receipt. Synthetic Message/Part
persistence only stops submission of response retries; it does not mean the receipt has been consumed;
the receipt is acknowledged only after the parent Assistant completes successfully, and failure or
interruption reschedules the continuation when there is no new user message.
Completion first enters the non-terminal `running/completion-settling` state, and the terminal
ledger is committed only after the sibling Delegation result is written. If host `busy`/`retry`
evidence or a Delegation write failure occurs in the meantime, Runtime does not publish the receipt
and conservatively retains admission and the Scope Lock.

Plugin startup does not enumerate all project Sessions. Queries only restore the current parent
Session's relationships and state, and do not dispatch old queued Tasks along the way. In a new
Runtime, the first real user message in the original parent Session is the explicit activation point
and only dispatches Tasks recoverable for that Session.

Recovery requires the complete canonical `task` frozen authorization, including requester, target,
permission pattern/action/approval, fingerprint, Effect, Scope, Overlay, and
trace. When missing or mismatched, the Task enters `unknown/authorization-unverifiable`; it can still
be queried and cancelled, but must not continue input, pending reply, retry, fallback, restart,
tool side effects, or completion-state promotion. When host execution evidence already exists,
admission and the write lock are conservatively held; only after all related Attempts are proven
`idle` or `missing` are local resources released, and the state remains authorization-isolated.

Recovery after Task Session deletion uses the current V1 tombstone/relink protocol: Runtime first
saves a strict tombstone descriptor, then converges to a new canonical ledger; when the owner is
already missing, the ledger may be retained without `parentID`. This process does not read old
migration metadata and does not backfill old semantics from missing fields.

### `o4e_task`

The following are Agent Task actions, allowed for authorized managed `primary`/`all`/`subagent`
callers in the owner Session, and require host `context.ask` authorization of
`o4e_task:agent:<action>`. Native `keep` retaining an owner Session still cannot manage Agent Tasks;
a delegated child can manage lower-level Tasks it created, but must not manage the parent Task it
belongs to or sibling Tasks.

Agent Task supported actions:

```text
status | watch | inspect | output | input | resume | cancel | resolve | pending
permission.reply | question.reply | question.reject
```

`watch` freezes the selection set visible to the current owner at call entry; when the selector is
omitted it freezes the pending Agent and Command Tasks not yet reliably delivered at that time;
mixed `taskIDs` may be selected explicitly; terminal Agent Tasks with persisted acknowledged receipts
are excluded by default; an explicit selector can still select them, but the same consumed terminal
state does not wake watch again. `taskIDs: []` explicitly selects the empty set, and subsequently
created Tasks do not join that wait. It returns as soon as any new terminal or actionable event
(permission/question/workflow/retry waits, unknown/interrupted, etc.) appears, returning only status.
Agent terminal states are deduplicated by consumed receipt; Command status events are deduplicated
only by the original Bash terminal response bound to a trusted public watch or canonical source;
Command status/output does not consume watch events; non-terminal events are deduplicated only when
the previous watch public body was fully delivered and `taskID/status/phase/revision` match —
metadata itself does not constitute delivery evidence.
Identical events keep waiting; when all selected Tasks are terminal and their events have been
delivered, it returns `reason:"empty"`. When reliable delivery evidence is missing, repeat reporting
is allowed. A single event does not mean the whole set is complete; real user messages and reader
abort can still interrupt the wait. When `watch` omits `timeoutMs` or passes `0`, it uses a 30-minute
(`1800000` ms) wait window; a positive explicit value specifies the window, maximum `3600000` ms.
The deadline is fixed with no watch backoff; internal checks and progress events do not extend the
window; new actionable events and real user messages can wake it early. After expiry reconciliation
it returns `heartbeat`; the Agent must first report a meaningful current status to the user before
calling the next watch. For completed Tasks, read output first; failed, cancelled,
unknown/interrupted, and explicit-wait states must not be stated as success. Real user messages and
terminal/explicit-wait states take priority. Runtime does not generate synthetic heartbeat progress
messages; whether intermediate reports are visible in the TUI depends on the host. Callers should
still check the returned status and keep watching unfinished dependencies instead of treating
heartbeat as a result or automatically restarting tasks. This window does not cancel tasks and is
separate from the read call budget below.

Only inspect/watch accept `ioTimeoutMs`: a safe integer 1..60000, default 10000 ms;
it is a tool call parameter, not a `backgroundTasks` configuration or Task execution timeout.
The budget starts at the tool execute entry and covers recovery, authorization, cursor scan, the
watch window, expiry recheck, and UI waits. The inspect deadline is this allowance; for watch it is
the normalized window plus allowance, fixed and not reset or extended by progress or per-I/O.
Timeout or caller abort only cancels the read wait; it does not cancel the child Task or shared
recovery; already-started lifecycle Promises are still tracked, and dispose must still wait for them.

O4E's `tool.execute.before` leaves recovery/event drain for inspect/watch to the execute budget
above and does not repeat the wait in the before hook; they need no write scope check or side-effect
watermark. Other tools and Task actions keep their original before-hook behavior. This budget does
not cover hooks of the host or other plugins that run before O4E execute.

Once a receipt consumption transaction is admitted (including the adapter consuming callback), the
deadline closes and it is no longer interrupted by deadline/abort; the call must wait for the
transaction's actual result, which may still fail. A committed result does not wait for the final
best-effort UI metadata publication. This budget is not an absolute hard wall-clock cap: admitted
transactions, synchronous JavaScript, and SDK oversized payload handling may all exceed it.

`watch` and `status` return only status and necessary control information, without result bodies or
heartbeat tails. `output` returns the result body on every call, preserving whitespace and empty
output, with only necessary truncation or incomplete-log notices. A single completed Agent result
must be authoritatively read via output before being reported. Inspect handles progress preview;
only inspect accepts `resume` and resumes the cursor from a previous trusted inspect response.
The `metadata.o4eResult` of the same completed Tool Part retains a bounded structure for trusted
parsing and grants no permission; when public text is truncated or compacted by the host, the event
must not be deemed fully delivered, nor may the inspect resume position be advanced.

`input`, `resume`, `resolve`, and interaction replies use the latest `revision` as
`expectedRevision`. Permission/question prompts are by default operated by the user in OpenCode's
root session native prompt. Only when the user explicitly asks to operate the current request on
their behalf should you first call `pending` to refresh the revision and then reply; do not infer
authorization from task goals or a generic "continue".

`input` by default only queues to the next turn of the same child Session: it is not injected in
real time into a running turn. When `delivery: "steer"` is passed, it requests the host to persist
the input and schedule it for the next runnable turn; steer is reported only after the host confirms
acceptance, otherwise it falls back to queueing, and the actual mode is reported in `inputDelivery`.
`resume` carries the latest `expectedRevision` and only wakes queued/retry/pending-input Tasks that
can be safely redispatched; executions that are uncertain or being cancelled are not restarted.
`cancel` remains for explicit termination. Input remains subject to the existing rules: the 16-entry
queue and the 16,384-character limit per entry (truncated by UTF-16 code unit), CAS revision,
terminal-state continuation, fallback/retry retention, and rejection while waiting for
permission/question.

### Read-only Inspect

`inspect` does not create or continue delegations, does not consume terminal receipts, and does not
judge whether a Task is complete; business results must still be read via `output` after `completed`.

Inspect's windowed read does not settle completion or consume receipts; the tool entry still reuses
existing recovery and authorization reconciliation, which may update lifecycle state on cold start.
Preview page count and body budget do not constrain these existing recovery history reads or
persistence operations.

`inspect` accepts only a single `taskID`, not `taskIDs` or `timeoutMs`;
`timeoutMs` is only for watch, and inspect's read deadline uses `ioTimeoutMs`.

| Parameter | Contract |
| --- | --- |
| `taskID` | required non-empty Task ID, still authorized per current Session |
| `cursor` | optional non-empty string, max 512 characters; the singular form is only for inspect. Agent cursors accept only the current compact format, max 120 characters |
| `direction` | `"forward"` (default) or `"backward"`, only for inspect |
| `maxBytes` | UTF-8 byte budget for the returned tail, safe integer 4..8192, default 1024; only for inspect |
| `resume` | optional boolean only for inspect; `true` automatically resumes the parent Session's most recent preview position; cannot be used together with `cursor` |
| `ioTimeoutMs` | read I/O allowance only for inspect/watch, safe integer 1..60000, default 10000 ms; deadline and consumption transaction exceptions are described above |

The public tool Schema accepts `null` for optional `cursor`, `direction`, `maxBytes`, `resume`,
and `ioTimeoutMs`; the adapter treats it as omission before strict Runtime validation. For a fresh
preview or automatic resume, omit the manual cursor or use `cursor:null`. Never invent a placeholder
such as `"x"`. Nonempty cursors remain validated; `resume:true` with a manual cursor is still rejected.

Both Plugin and Runtime validate parameters. Omitting `resume` or setting it to false without a
manual cursor returns the recent tail — this is an intentional read-position reset, not lossless
recovery from a gap; pass a `cursor` to fetch increments forward, or when `beforeCursor` is returned
use it with `direction:"backward"` to read earlier data. `beforeCursor` is provided only when
earlier data actually exists. The default response is compact `taskID`/`status`, available
`tail`/`cursor`, and optional `unchanged`, `unavailable`, `gap` markers; it is not a complete Task ledger.

A cursor binds Task, child Session, dispatch, run generation, and Attempt, fixes a UTF-8 byte
position, supports text, Part, and message appends, and does not jump to the tail as new content
arrives. Validation covers the entire old public snapshot prefix of the referenced source, not just
the bytes already read; prefix rewriting, tool status changes, or source deletion return `gap`.
It is not authorization and cannot cross parent Session ownership. When cursor origin or lineage
cannot be verified it fails closed and does not guess historical positions. The current compact
format encodes binding fields, offset, and digest bytes, adding no cache, state table, or
authorization capability.

Explicit `resume:true` resumes each Task's most recent position from real `o4e_task`
inspect tool responses persisted in the caller's parent Session; it only takes responses before the
current tool's `messageID`/`callID`, including earlier Parts in the same message — not the current or
later Parts/messages — and does not guess cursors from ordinary text or metadata. Parent history is
scanned via `messagePage` for at most 5 pages of 20 entries each, without adding caches or
cursor/watermark tables. Backward inspect uses only the most recent preview's `beforeCursor`; when
missing it returns `unavailable`, and does not switch to that preview's `cursor` or an earlier
successful preview.

The first forward resume may become fresh only after locating the current call boundary, exhausting
history, and proving no old anchor or failure exists. Empty `unchanged:true` or queued
`unavailable:"not-dispatched"` previews without `tail`/`cursor`/`beforeCursor` may keep first-time
state, but cannot mask earlier anchors or failures. It returns `unavailable` when the latest related
call failed or is pending/running, the preview failed/gapped, output is corrupted or compacted, the
boundary cannot be confirmed, or the history limit is reached before a position is determined — it
cannot fall back to historical success or re-fetch a new tail. Exactly-once across multiple readers
is not guaranteed; concurrent pending/running calls fail closed.

The Reader reads at most 5 pages of 20 messages each via the host `messagePage`, without cache, and
does not fall back to full-history reads. It projects only public assistant text, tool name/status,
and a minimal safe allowlist summary of verified current dispatch/compaction lineage: `read` may
show a bounded, normalized workspace-relative `filePath`; `glob`/`grep` may show a bounded
workspace-relative `path` and a conservatively length-limited `pattern`. External paths,
suspected-sensitive, URL/query-like, malformed, or overlong values are omitted; unknown tools still
show only name/status; other tool inputs, all tool outputs, reasoning, and hidden metadata are
excluded. Summaries participate in old public snapshot prefix validation, but summary bodies do not
enter the cursor and do not change authorization. Page count, message count, and returned tail bytes
are bounded, but the SDK may still first download a single oversized message and all its Parts; this
is not a full-path byte cap and limits neither Part count nor per-message projection memory.

The owner state copy of an Agent Task waits for the publication attempt before the corresponding
outer operation completes; the wait happens outside the Task state lock. If publication fails,
already-accepted state is not rolled back or re-executed, and the current Runtime's task
results/queries carry the `owner-publication-failed` diagnostic. After directed recovery through the
current owner publishes successfully, the diagnostic clears. This is not a new protocol for Commands
and does not guarantee same-frame TUI refresh; if the underlying write never returns, the write
operation may still wait.

## Managed Bash And Command Tasks

### Shell and Permission Boundary

The global `bash` applies to ordinary tool calls, including native `keep` `build`/`plan`; it does
not change these Agents' identity and configuration, nor bypass host permissions. Execution uses the
Host Shell selected by the OpenCode host `config.shell` — not limited to Linux or absolute Bash —
and does not use an O4E custom shell fallback. This is not an `.o4e/config.jsonc` field and does not
accept a model-selected shell; there is no fallback to other shells or builtins. It uses the target
Host Shell's launch argument protocol, no PTY, stdin EOF, inherits the process environment at
launch, and normal Host Shell behavior. Environment assignments inside the command must use the
target Shell's syntax; the public plugin API cannot distribute other plugins' `shell.env` hooks.
This boundary is not environment isolation or an executable sandbox.

| Bash parameter | Current contract |
| --- | --- |
| `command` | required non-empty, no NUL, max 64 KiB; must pass host permission validation |
| `description` | required non-empty description |
| `workdir` | optional execution directory; when omitted, uses the current Session `context.directory`; relative values are resolved from that directory and realpath-validated; each call is independent and does not inherit the previous cwd; for strict providers, nullable `null` is equivalent to omitting, empty paths are still rejected; external directories require authorization |
| `timeout` | optional integer 1..2147483647 ms, default 120000; port execution limit, not the initial wait, queue, or read limit |

The tool name `bash` does not constrain the target Shell. Unicode, escaping, quoting, globbing,
expansion, assignments, functions, loops, scripts, and multi-line text are interpreted according to
the target Shell's capabilities and syntax; Bash idioms such as heredoc cannot be treated as
universal syntax for PowerShell/cmd. The Parser only extracts permission resources and adds no
syntax allowlist; the raw command is handed to the target Host Shell, and syntax errors are also
returned by that Shell. Statically decodable literals are also checked as canonical resources;
dynamic paths are not expanded before authorization — static checks must not be treated as a
filesystem sandbox. Input that is unrecognized or has no command node is authorized as full text.

All managed ordinary Agent and Plan Profile system prompts include the O4E workspace context.
The OpenCode `directory` is the active working directory and `worktree` is the repository/project
rule root; when they differ they do not override each other. This fact injection does not depend on
whether the Agent has `task` permission, and does not change native `keep` or host system prompts
that do not match the O4E marker.

### Authorization and Execution

1. Parse the command and verify caller authority; the host `context.ask` must complete before
   creating a Task or executing. Bash authorizes both raw and canonical atomic resources; applicable
   `external_directory` resources first undergo realpath validation and authorization; you must not
   approve only the whole compound command while missing the atomic commands within it.
2. O4E permission can tighten to deny but cannot replace host authorization; even if O4E is
   configured `allow`, it must still enter `context.ask`. Only when the host's currently effective
   rules decide `allow` can it return without UI; host `ask`/`deny` is not bypassed by O4E `allow`.
   The managed child verifies live identity, frozen delegation/Agent Task,
   fingerprint, permission, and Effect. After approval it verifies current authority again, and
   verifies once more after resource admission and before claim.
3. Bash does not acquire, borrow, or restore an execution Scope Lock, and does not queue because of
   the write scopes of writable Agents or other Bash. The child must still hold trusted frozen
   `unknown-write` permission, does not accept a model-specified owner, and does not upgrade
   read/scoped authority. Write locks between Agents, parent-child lifecycle, and stop confirmation
   are unchanged; conflicts from concurrent modification of the same file and command dependency
   order are coordinated by the caller.
4. Admission is by owner/kind command lane; the port is invoked only after the independent SQLite
   transaction confirms the canonical record and execution claim; the host display summary is published separately. The admission wait defaults to 1000 ms; after
   running starts there is another default 10000 ms window; when still queued/running at expiry it
   returns a snapshot with the stable command `taskID`, and the command keeps executing. Both windows
   are separate from the default 120000 ms execution timeout and are not end-to-end
   authorization/persistence limits.

### Command Management

Cancellation for Agent and Command is unified as `{"action":"cancel","taskID":"…"}` with only these
two fields. If a model fills optional fields for other actions in the flat tool Schema, the adapter
discards them before strict cancellation validation. It never infers a target from `taskIDs` or
expands cancellation to multiple tasks; ownership, permissions and stop evidence remain required.
No action accepts a `reason` input (including `resolve`); internal cancellation
diagnostics and the `reason` in watch/Command output are retained.

`o4e_task` supports `status/watch/inspect/output/cancel/pending` for commands;
`pending` returns an empty list with `supported:false`. Every Task validates the caller owner index,
current permission, and host `o4e_task:command:<action>` authorization. Watch by default includes
the owner's current Agent and Command Tasks; mixed `taskIDs` may be selected explicitly; other
actions accept only one `taskID`. Authorized native `keep` roots and managed children can only
manage their own commands and do not thereby gain Agent management capability. Command input,
retry/resolve/restart, and permission/question replies are not supported. Commands do not delegate
to a model, do no model fallback, and generate no Agent receipt.

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

### Ledger, Output, and Cancellation

A Command's independent `kind: command` ledger is stored by directory, owner, and task in private O4E SQLite.
It is the sole canonical record, does not use the Agent normalizer, and does not overwrite the owner's
Agent ledger or delegation envelope. Session `metadata.o4e.commandTasks` uses version 2 with allowlisted
`snapshot` display summaries only. Recovery, output reads, and Workflow Gates read the full bounded record from SQLite. No separate Command Session is created, so new commands add neither ordinary
Session list entries nor Ctrl+x subagent navigation items. `taskSessionID` equals `ownerSessionID`
and denotes only the storage container, not a navigable execution session. Source Session/message/call
identities deduplicate; the command and description bodies stay in the host Bash Part, and the ledger
stores references/hashes rather than replayable input. Records, source indexes, and claims are committed in
one SQLite transaction; execution happens only after confirmation. Historical Command Sessions and old recovery
records are not scanned, migrated, or deleted; records not matching the current layout are refused.
The database defaults to `opencode-for-everything/command-ledgers/<directory-sha256>.sqlite` under the user data directory:
`XDG_DATA_HOME` (default `~/.local/share`) on Linux/macOS, or `LOCALAPPDATA` (default `~/AppData/Local`) on Windows.
POSIX private directories use 0700 and databases 0600; no user-configurable database path field is provided.
Task records do not expire with the 24-hour output-log TTL. Backups or transfers to another machine must preserve
both this database and the host session data; installation, build, and uninstall do not delete it.
Moving a project selects a different directory identity and does not guarantee automatic recovery.
Missing/unreadable databases fail closed instead of reconstructing from summaries. Host summary publication failure
only reports `O4E_COMMAND_PROJECTION_UNAVAILABLE`; subsequent directed owner recovery can republish it. Recovery only handles the specified owner: it first recovers uncertain Command
admissions without creating write locks, then queries the handle; it can reattach an existing
in-process handle, does not re-execute old claims, does not adopt PIDs across host restarts, and does
not rebuild old commands from user messages. Uncommitted records without a live launch enter
`interrupted/not-submitted`; when claimed but the handle is missing, `unknown` and the Command
resource slot are retained.

Ordinary successful Bash without truncation returns captured text directly, preserving spaces,
newlines, and empty output, without Task status wrappers, summaries, or empty-output placeholders.
Nonzero exits, exceptions, truncation, and incomplete logs place clearly separated minimal necessary
control information before the body; it must not be hidden only in UI metadata or JSON attachments.
"As-is" is the captured text after UTF-8 decoding of each stream, excluding terminal emulation,
binary fidelity, or the true global write order of the stdout/stderr fds.

The retained output view is at most 64 KiB — a tail while running, head plus tail for large terminal
output; inspect only paginates this retained view. The Bash model body uses an independent 48
KiB/1800-line budget; beyond the limit the tail is retained, control information is placed before the
body separated by a blank line, preserving exit/archive evidence against host truncation. The
`o4eResult` budget in Bash structured metadata is 20 KiB, independent of card output; other command
actions get 40 KiB. Metadata reduction marks `truncated` and `outputView` and does not rewrite the
in-budget Bash model body. Full UTF-8 text is stored in a private
directory (0700) of the current user outside the repository, with log file permission 0600 and a
per-file cap of 256 MiB. The default location is under `opencode-for-everything-<uid>-command-logs/`
in the system temporary directory, isolated per host process. Retention is 24 hours from terminal
settlement; expired files are lazily cleaned when new command logs are created; active logs must not
be deleted and cleanup may be conservatively delayed.

The body budgets above reserve room for OpenCode's default 50 KiB/2000-line tool truncation; the host
`tool_output` configuration may use lower caps, and subsequent host or model truncation still follows
actual host behavior.

Write-to-disk is confirmed before terminal state; creation, write, capacity, sync, or capture
failures mark the log incomplete. `logPath` is the file location, `logBytes` the recorded text
bytes; only `logComplete:true` means the complete capture log was saved; `logError` describes storage
failure. `logComplete:false` while running is not a completion state. When full text is needed, read
in segments through the returned `logPath` using authorized host file tools; inspect does not read
full logs. After the 24-hour retention period the path is not guaranteed to still exist. `totalBytes`
and available `sha256` describe the observed raw stream; incomplete capture generates no complete
hash. The Command ledger stores only the bounded view and log information; the native Shell Part's UI
capture is stored independently.

The native Shell card independently accumulates up to 256 MiB of captured text; beyond the limit it
keeps a UTF-8 complete prefix and clearly marks the card incomplete. Both attached and background
phases merge updates into the same Bash Part's `metadata.output`; background updates do not change
the `state.output`, tool status, time, or `o4eResult` already received by the model. Transfer is
best-effort and failures do not affect execution; the host may collapse, trim, or strip ANSI, and
full card delivery is not guaranteed. Short command terminal bodies can be used directly; background
returns only status and taskID, and the body is read via output as needed.

Independent inspect/watch reader abort/read timeout only cancels the read wait. After Bash returns a
queued/running snapshot, its original reader abort does not cancel execution; ordinary root owner
idle and root-turn `MessageAbortedError`/`AbortError` both preserve detached commands. Root-turn
abort only temporarily suppresses automatic tracking, lifted on the next real user turn; explicit
`follow enabled:false` persists and ordinary messages do not lift it. Attached Bash caller abort,
explicit Task cancel, owner deletion, managed child lifecycle termination/cancellation, and plugin
disposal still initiate command cancellation, and execution timeout still initiates stop. To stop a
background command, use the authorized `o4e_task cancel`; do not treat aborting the root conversation
as cancellation evidence. Background running provides no cross-host-restart recovery. When stop is
unconfirmed or canonical/owner persistence fails, Command admission and the uncertain record are
retained without holding a write lock; cancellation and disposal retries only retry stop evidence or
persistence, not re-execution. Coordination is in-process only, not a cross-process lease or OS
sandbox; stop evidence covers only the owning process group and does not guarantee stopping
descendants that escaped via `setsid`/`setpgid`.

## MCP

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
      }
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
    }
  },
  "loadMcp": {
    "context7": ["resolve-library-id", "query-docs"],
    "filesystem": ["read_file", "list_directory"]
  }
}
```

A local MCP `command` is a non-empty string array. Secrets use `{env:VAR_NAME}` and must not be
written into configuration. O4E first denies managed servers' tools, then opens them per Agent
`loadMcp`.

## Environment Variables

| Variable or placeholder | Current use |
| --- | --- |
| `o4e_mode` | unset or `default` enables O4E; `origin` returns a clean host projection; `clear` keeps the O4E projection but removes top-level and Agent `model`/`variant` from this run's final runtime configuration; an empty string or any other value falls back to `default` while emitting an error diagnostic naming the invalid value (host log, plus a TUI warning toast when available). The value is read when the plugin instance is created. |
| `o4e_config` | when set explicitly to an absolute path (supporting the `~/` prefix), only that directory is read; when unset, the default global root is `~/.config/opencode/.o4e/`, with project `.o4e/` still taking precedence. Frozen within the plugin instance; the new value is read only after restarting OpenCode (including a new `-s` process). |
| `XDG_CONFIG_HOME` | Runtime uses it to resolve the global configuration root only when it is an absolute path; the installer's global target remains fixed at `~/.config/opencode`. |
| `{env:VAR_NAME}` | reads environment variables in configuration values such as MCP headers, avoiding writing credentials into files. |
| `OPENCODE_FOR_EVERYTHING_DEBUG=1` | temporarily enables O4E debug logs; logs may contain project context — sanitize before sharing and do not commit. |

When using a custom configuration profile, use `o4e_config=/absolute/path` and restart OpenCode;
different configuration profiles still share the current workspace's Task/lock partition.

## Instruction Files

```jsonc
{
  "instructionFiles": {
    "global": ["<default>"],
    "project": ["<default>", "docs/project-rules.md"]
  }
}
```

The global `<default>` expands to `AGENTS.md` in the OpenCode configuration directory; the project
`<default>` expands to the project root `AGENTS.md`. Agent overrides must give the complete
global/project object.

## Soul and Prompt

`soul.enabled` controls whether the shared Soul is enabled, `soul.file` points to a file inside the
configuration root, and `soul.inheritMode` uses `override` or `extend`. The repository maintains
`soul.zh.md` and `soul.en.md` by default; the installer writes only the selected language as the
installation target's `.o4e/soul.md`.

The default maintenance guidance does not require updating on every task: only consider personal
background and collaboration preferences the user explicitly asks to retain or explicitly states as
long-term applicable and useful across sessions; temporary tasks, execution authorizations, project
rules, and product decisions are not written. Skip when uncertain. At runtime, Soul is only read and
injected — preferences are not automatically extracted or saved, and no semantic write interception
is provided. An existing `soul.md` is preserved across builds and reinstalls; updating the default
guidance requires user authorization to modify the maintenance section separately, rather than
overwriting existing personal content.

For an Agent's core Prompt, inject, message Prompt, and `nativeSystem` fields, see
[Prompt Fields in the Agent Reference](./agents.md#prompt-fields). Prompts, Plan reminders,
instruction files, and Soul bodies are re-read at the corresponding hook boundaries; file paths,
enabled state, inheritance policy, and Agent JSONC remain part of the static Snapshot. For a summary
of the installation target layout and injection order, see the
[Skill and Soul section of `defaults/.o4e/README.md`](../../defaults/.o4e/README.md#skill-与-soul).

## Snapshot and Hot Reload

A plugin instance loads the Runtime Snapshot only once. The following changes require a rebuild and restart:

- config and Agent JSONC
- native Agent policy, Plan Profile, permission, parent Session model freezing, and routing
- Workflow definitions
- plugin source code, installer Skill selection, and Skill allowlist

The following bodies are re-read at the next relevant hook:

- system/inject/message Prompts
- Plan reminder
- instruction files
- Soul file content

Soul's path, enabled state, and inheritance policy remain part of the static Snapshot.

## Task Tool Display

The top-level `enable_o4e_task_detail` is a boolean, default `false`. When off, `o4e_task` shows
only the `⚙ o4e_task [parameters]` call line and does not expand the return body for humans; the
model still receives the complete bounded return through the public message transform hook. When on,
normal detail display is kept. This switch affects only `o4e_task` and does not change other MCP,
custom tools, native `task`, Bash cards, or host global display preferences. If the host hides all
tool call lines, that choice is still respected.

In hidden mode the raw persisted UI output is empty, and the full body is stored in bounded,
binding-validated display metadata, with `metadata.o4eResult` retained. Watch/inspect/Workflow
evidence checks use the same model representation and do not treat arbitrary metadata as
authorization or completion evidence. Host compaction, truncation, and summarization still apply;
cleaned output is not restored, and verbatim preservation of the original after compaction is not
guaranteed. This feature depends on the current host's experimental message transform hook and
should be re-accepted after host upgrades.

The sidebar overview is independent of the detail switch; see [Task Overview](../guide/task-overview.md).
For persistent enable/disable of automatic tracking and failure recovery, see [Automatic Task Follow](./automatic-follow.md).

## See Also

- [Agent Reference](./agents.md)
- [Workflow Reference](./workflows.md)
- [Model Selection and Run Modes](#model-selection-and-run-modes)
- [Soul and Prompt](#soul-and-prompt)
- [Environment Variables](#environment-variables)
- [Generated Files Reference](./generated-files.md)
