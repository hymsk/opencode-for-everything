# Troubleshooting

[English](README.md) | [中文](README.cn.md)

[← Documentation home](../README.md) | [CLI reference](../reference/cli.md) | [Environment variables](../reference/configuration.md#environment-variables)

## Installation and dependencies

### `@clack/prompts` cannot be found

Installer dependencies are not installed. Run this from the source root:

```bash
npm ci
```

### The `opencode` command is not on `PATH`

Installation and tests require the `opencode` executable on `PATH`. The
validation baseline is `>=1.18.21`; this does not mean that every version in
the range has been verified. Confirm that OpenCode is installed and can run
directly from a terminal. The following is a Linux/macOS example; on Windows
use `where.exe opencode`:

```bash
which opencode
```

### Node.js is too old

The installer requires Node.js 20.12 or later. Development and CI use Node.js
24, and tests directly import the TypeScript server module. An
`ERR_UNKNOWN_FILE_EXTENSION` error while running tests on Node 20 must not be
mistaken for a lack of installer support. Check the current version:

```bash
node --version
```

### Import or export cannot find `tar`

Configuration import and export depend on the system `tar`. Windows normally
uses `%SystemRoot%\System32\tar.exe`; Linux and macOS find `tar` through
`PATH`. Confirm that the executable exists and that the current user can run
it. Do not replace the system executable with an untrusted program of the same
name.

### An imported archive is rejected by the security checks

Import accepts only ordinary, non-link `.o4e.tar.gz` files. The archive must
use POSIX `/` paths and contain only `.o4e/`; backslashes, absolute paths,
`.`/`..`, symbolic links, hard links, and special files are rejected. Generate
the archive again with O4E's `export` command and import only archives from a
trusted source.

## Plugin disposal and partial recovery

The last plugin facade cancels running background Agents instead of releasing
their Scope Lock while the Agent is still running. A disposal failure keeps the
uncertain record and can leave the facade quarantined until persistence is
available for a resolving recovery or a later disposal retry. Do not treat a
successful disposal as proof for a separate task unless its terminal state and
stop evidence are confirmed.

If a disposal fails, do not repeat an old command or edit the ledger manually.
Preserve the error, verify the task status, restore the persistence dependency,
and retry the disposal or reload the plugin only after the state is understood.
The last-facade cancellation and failed-disposal paths have dedicated
regression tests; simulated host failures are not real host-exit acceptance.

## Build

### Build fails with a configuration parse error

Confirm that the configuration is under the target `.o4e/`, that Agent file
names match the JSON `name`, and that Prompt references do not use absolute
paths or escape with `..`. See the [configuration reference](../reference/configuration.md)
and [Agent reference](../reference/agents.md).

```bash
node scripts/installer.mjs build --target /path/to/project
```

### Symbolic or hard links are rejected

The builder rejects symbolic links and hard links in the configuration tree or
generated target. Confirm that `.o4e/`, `.opencode/`, and their contents are
ordinary files and directories.

### Build rejects an unknown field

The build rejects fields not defined by the current Schema. Adjust the
configuration according to the current Schema under
[`defaults/.o4e/schemas/`](../../defaults/.o4e/schemas/) and build again.

### Build or startup fails because explicit configuration is missing

`config.nativeAgents` must contain `build`, `plan`, `general`, and `explore`.
Each concrete Agent in the installation target must also declare a one-line
`description`. `agents/default.jsonc` belongs only to the repository template
and should not remain in a target `.o4e/agents/`. Ensure that configuration
matches the current Schema and that `loadSkills` is an array of names. If
OpenCode explicitly sets `default_agent`, make sure it points to an enabled
optional Agent.

## Runtime

### Project configuration does not fall back to global configuration

This is the expected fail-closed behavior. Once `<directory>/.o4e/` exists, it
shadows the global configuration. If project configuration cannot be parsed,
has a missing reference, or contains links or special files, the Runtime
refuses to start instead of using the global `.o4e/`. Repair the project
configuration, or completely remove the directory after confirming it is no
longer needed.

### An Agent does not take effect

Check that `.opencode/agents/` and `.opencode/plugins/` in the target have been
regenerated. Changes to Agent JSON, Schemas, or tool policy require rebuilding
and restarting OpenCode. See the [Agent reference](../reference/agents.md).

```bash
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs build --target /path/to/project
```

### Prompt changes do not take effect immediately

Prompts, Soul, and managed instruction files are reread at the next relevant
system assembly according to file metadata. Agent JSON, tools, and Skills
require a rebuild; plugin code changes also require restarting OpenCode. See
the [configuration reference](../reference/configuration.md) and [Soul and Prompt](../reference/configuration.md#soul-and-prompt).

### Model selection at startup is unexpected

First check `o4e_mode`: omitted means `default`, which preserves model
configuration. Then check `defaultModel`, the Agent's `model`,
`fallbackModels`, and the provider loaded by the host. A managed child first
uses candidates from its target configuration; when none are configured, it
freezes the parent Session's current model. Explicit user-message selection is
not rewritten.

To exclude a host-saved model from the current run, start a new process with
`o4e_mode=clear`; this clears only the final runtime configuration projection
and does not modify host configuration, credentials, or the model library. Use
`o4e_mode=origin` when O4E Runtime should not be initialized at all. An empty
or otherwise invalid mode does not block startup: O4E falls back to `default`
and reports an `O4E_MODE_FALLBACK` error diagnostic (host log, plus a TUI
warning toast when available). Check the final config
and provider request when verifying behavior; do not rely on a model's
self-description.

### MCP is connected but the Agent has no tools

Connected only proves the host connection state; it does not prove that the
current Agent received a tool. An array `loadTools` disables builtin tools not
listed there; MCPs are open by default through `loadMcp: { "*": ["*"] }`.
An Agent's explicit `loadMcp: {}` closes all MCPs, and `blockMcp` takes priority
`loadMcp`; do not change every permission to `allow` for troubleshooting or
bypass an existing MCP-only operation rule because an MCP is unavailable.

For example, the `workspace_list` server action of `zellij-mcp` is exposed as
the host tool `zellij-mcp_workspace_list`; hyphens are not changed to
underscores. Also distinguish Agent/Plan permissions, message-level tool
filtering, and caches from old instances. Rebuild and restart after changing
configuration, then verify the actual tool list rather than only the sidebar
connection state. See [MCP configuration](../reference/configuration.md#mcp).

### Bash or `o4e_task output` displays unexpected content

The native OpenCode Bash card reads host-provided `metadata.output`; its
folding, truncation, and display are controlled by the host. O4E independently
accumulates Command Runtime output and continues to expose it through
`o4e_task output` and an external log archive after detachment. The channels are
not guaranteed to stay synchronized.

The same Shell card preserves the body already received by the model. The card
retains at most 256 MiB and explicitly marks capacity loss; the host normally
folds long output, which can be expanded. Ordinary successful Bash preserves
captured text, spaces, newlines, and empty output; non-zero exit, truncation,
and incomplete logs have separate control information.

If a command is still queued after one second or still running after ten
seconds, the call returns a background identifier and execution continues.
Default `o4e_task watch` monitors the owner's Agent and Bash tasks together and
reports status only; use `output` for body text and `inspect` for a recent
output preview. Card updates reuse the public Part API and may fail when the
host refuses to update or closes a Session; terminal logs are the integrity
reference.

Rebuild from updated source and fully restart when verifying new behavior; do
not use an old generated runtime as evidence.

`o4e_task` defaults to `enable_o4e_task_detail:false`. The human UI keeps the
call row, but persisted UI output is empty; the host's “Show tool details”
cannot recover such hidden historical body text. Set
`enable_o4e_task_detail:true` in `.o4e/config.jsonc`, rebuild, and restart the
plugin instance to display later calls. The host's own detail preference still
applies, and changing this setting does not backfill historical empty Parts.
Both modes provide the model with the same complete bounded body through a
validated display envelope. Structured recovery data lives in completed Tool
Part `metadata.o4eResult`; it is for trusted call-history parsing and is not
authorization. See the [configuration reference](../reference/configuration.md#task-tool-display).

### The global plugin is not loaded

OpenCode automatically discovers project-level `.opencode/plugins/`. A global
plugin must be registered in `~/.config/opencode/opencode.json` or
`opencode.jsonc`. The current installer fixes the global path at
`~/.config/opencode`; setting `XDG_CONFIG_HOME` does not change where it writes.
Confirm that the registration file is strict JSON and that the plugin URL still
points to an existing runtime file. See [environment variables](../reference/configuration.md#environment-variables).

### Workflow is not loaded by the Agent

Ask the Agent to call `o4e_workflow action:catalog` explicitly and inspect the
discoverable entry Workflow definitions. Use `action:list` to find Runs already
created in the current Session. If the target is absent, confirm that the
Agent's `loadWorkflows` contains the Workflow name or `['*']`, that the
Workflow `visibility` is `entry`, and that the final `o4e_workflow:<name>`
permission is not `deny`. Nested Workflows are not supported, and an internal
definition cannot bypass entry restrictions. See the [Agent reference](../reference/agents.md)
and [Workflow reference](../reference/workflows.md).

### A background Task waits for permission or a question

This applies only to Agent Tasks, and the managing caller must be an authorized
managed `primary`/`all` owner parent Session. Command `pending` returns only an
empty list with `supported:false`; host permission approval before Bash
execution is not a Command Task interaction response.

Return to the OpenCode root Session and act in the native permission or
question prompt. The parent Agent should report the wait and preserve the
request, not repeat or answer it. Only when the user explicitly asks the parent
to handle the current request may it refresh the host request and Task revision
with `o4e_task pending`, then call `permission.reply`, `question.reply`, or
`question.reject` with the latest `revision`. A task goal, known answer, or
generic “continue” is not authorization.

If a reply returns `reply-submit-unconfirmed`, submission or the host
confirmation after submission failed. Runtime restored the request to `pending`
and will not resend it automatically. Call `pending` again to confirm the
host's current state before deciding whether to retry. Rebuild and restart after
plugin or Runtime adaptation changes.

### `O4E_TASK_OUTPUT_TOO_LARGE` from `watch`

The public watch status and structured result each have a 49 KiB budget. When a
large selection exceeds it, the tool rejects the read before acknowledging
terminal receipts. Provide a smaller explicit `taskIDs` set and read in
batches. A budget rejection does not mark tasks delivered.

`watch/status` does not include result body text; every `output` call returns the
body again. Truncated or compressed public status cannot be used for event
deduplication. If an inspect preview is truncated or compressed, `resume`
reports it as unavailable; omit `resume` and manually inspect the current tail.

### A background Task stays `queued`

The activation and retry states below apply to Agent Tasks, not old Command
claims. After `watch` returns a heartbeat or actionable state, report the state
to the user before watching again. Runtime does not manufacture visible
synthetic progress messages; intermediate TUI display depends on the host.
Real user messages and terminal or explicit-wait states take priority.

Use `o4e_task status` or `watch` to check whether the same parent Session still
has a `starting`, `running`, `retrying`, `waiting_permission`,
`waiting_question`, `waiting_tool`, `waiting_workflow`,
`waiting_retry_decision`, or `cancelling` Task. These states consume admission
slots. An accepted but unconfirmed `unknown` execution, cancellation, or
Session state may also conservatively hold a slot and a Scope Lock. Within the
same owner/kind lane, the Scheduler admits tasks by sequence up to the
concurrency limit; it does not block or skip another category based on
read/write mode. Scope Lock handles actual write conflicts. Root reads may run
alongside writes; there is no consistent snapshot and no global FIFO guarantee.

Scope Lock is shared across owner Sessions in one directory, but only inside
one OpenCode process. Do not let multiple processes operate on the same
project. After updating plugin code or Runtime adapters, rebuild, fully close
the old Runtime, reopen the persisted parent Session, and send a real user
message. This is the explicit activation point that selectively restores and
dispatches recoverable historical Agent Tasks for that Session. Plugin startup,
ordinary queries, and synthetic continuation do not trigger it and do not
globally dispatch another parent Session's history.

If activation does not occupy a slot but a queued Task still does not advance,
preserve the `taskID`, parent Session ID, and redacted logs with
`OPENCODE_FOR_EVERYTHING_DEBUG=1`. Do not edit generated `.opencode/` files or
Session metadata. See the [Background Task section of the configuration reference](../reference/configuration.md#background-task).

### A background Task remains `running/model-running` after context compaction

This describes Agent Task model execution and message lineage; Commands do not
run models. The initial `dispatchMessageID` must remain stable across OpenCode
automatic compaction. Runtime recognizes the persisted `compaction` user
message, compaction summary, and continuation user message with
`synthetic: true` and `metadata.compaction_continue: true`, then reconciles the
final Assistant result or error in the same message chain to the original
dispatch. It does not treat the compaction summary itself as a business result.
An unrelated Assistant, ordinary user message, incomplete compaction triple, or
an original dispatch that already has a terminal result/error stops lineage
extension to avoid assigning later unrelated messages to an old Task.

When a child Session already has a final continuation message but the Task is
still `running/model-running`, send a real user message in the original parent
Session to trigger targeted recovery, then use `o4e_task status` or `watch` to
check that the Task converges to `completed` or an explicit retry decision.
Model errors do not become `failed` directly. Do not edit Session metadata
manually. If it still does not converge, preserve the original `taskID`,
`dispatchMessageID`, child Session ID, and a redacted user/Assistant parent
chain.

O4E does not automatically retry or switch a fallback after a model error.
Confirm the retained error and revision in `waiting_retry_decision`, then have
the owning main Agent explicitly execute `resolve continue|restart|stop`
within its existing authorization. Error classifications and candidates are
only suggestions; a host provider may retry internally outside the plugin and
O4E cannot disable or observe every provider attempt.

### Bash is rejected or a Command does not complete

The managed global `bash` is the Command creation entry point. Native `keep`
retains identity and configuration, not the builtin tool implementation. The
execution uses the Host Shell selected by `config.shell`; it is not limited to
Linux or one Shell and does not fall back to an O4E-selected Shell. Ordinary
scripts, expansion, assignments, Unicode, quotes, and backslashes are not
rejected by an O4E syntax allowlist. Check the host permission decision, the
execution cwd, and the Bash error first; do not mistake a permission rejection
for a syntax error. The public plugin API does not distribute another plugin's
`shell.env` hook, so environments depending on that injection need separate
verification.

Distinguish the one-second admission wait, the ten-second wait after running
starts, and the default 120000-millisecond execution timeout. Queued/running
snapshots and process tails do not mean completion. In the original owner
Session, explicitly select the single Command `taskID` and use
`status/watch/inspect/output/cancel/pending`. Without a selector, watch includes
the owner's Agent and Command tasks and allows mixed `taskIDs`; other actions
accept only one taskID. Command has no input, restart, interaction, or automatic
Agent-receipt wakeup. Queued may be waiting for command-lane capacity or
admission processing. Bash does not acquire or borrow an execution Scope Lock
and does not queue behind a writable Agent's lock. A child still requires a
trusted frozen `unknown-write` permission and cannot upgrade read/scoped
authority.

Inspect/watch reader abort does not cancel a Command. A detached Bash's reader
abort, ordinary root-owner idle, and root-turn `MessageAbortedError`/`AbortError`
also do not cancel execution. Root-turn abort only temporarily suppresses
tracking. An attached Bash caller abort, explicit Task cancel, owner deletion,
managed child termination/cancellation, and disposal still request cancellation.
Use authorized `o4e_task cancel` and check the stop state rather than only
aborting the root conversation; background execution is not a persistent
cross-host service.

Reload only reattaches an in-process handle; it does not rerun an old claim.
Unsubmitted records without a live launch become `interrupted/not-submitted`;
resource slot. Unconfirmed cancellation or canonical/owner persistence failure
also retains admission and the uncertain record. Do not edit the ledger to free
the slot or automatically execute a replacement. Retrying cancellation or
disposal retries stop evidence and persistence only; it does not start a
replacement Command.

The in-memory view is at most 64 KiB and inspect pages only that view. The Bash
model body is limited to 48 KiB/1800 lines, with a tail and leading control
information beyond that. Structured `o4eResult` metadata is limited to 20 KiB
for Bash and 40 KiB for other Command actions. Complete text lives in a private
`logPath` outside the repository; logs are lazily cleaned after 24 hours of
terminal settlement while active logs are protected. `logComplete:false` and
`logError` mean that archival is incomplete or failed; `totalBytes`, hashes,
and bounded metadata are not proof of complete text, and an expired path may
already be deleted.

This mechanism is in-process coordination, not a sandbox, and does not
guarantee termination of `setsid`/`setpgid` descendants. See the [command reference](../reference/configuration.md#managed-bash-and-command-tasks).

## Status checks

```bash
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs status --global
```

Project status checks `.o4e/` and the generated runtime; global status checks
global configuration, runtime, and plugin registration.

See the [CLI reference](../reference/cli.md) for complete command parameters.

## Debug logs

To observe plugin configuration takeover, model resolution, or fallback,

```bash
OPENCODE_FOR_EVERYTHING_DEBUG=1 opencode
```

Do not commit debug logs containing project content, credentials, or complete
context. See the [environment variable reference](../reference/configuration.md#environment-variables)
for environment and global-path differences.

## See also

- [CLI reference](../reference/cli.md): installer and builder commands
- [Configuration reference](../reference/configuration.md): fields and defaults
- [Agent reference](../reference/agents.md): Agent types and permissions
- [Workflow reference](../reference/workflows.md): Workflow definitions and execution
- [Environment variables](../reference/configuration.md#environment-variables): runtime environment variables and debug switches
