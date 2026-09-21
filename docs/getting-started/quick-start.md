# Quick Start

[English](quick-start.md) | [中文](quick-start.cn.md)

[← Documentation home](../README.md) | [Project overview](../guide/overview.md) | [Installation guide](../guide/installation.md)

This page explains how to install `opencode-for-everything` into a project and
use the default Agents in OpenCode. For manual source installation and advanced
options, see the [installation guide](../guide/installation.md).

## Requirements

| Dependency | Requirement |
| --- | --- |
| Node.js | 20.12 or later; see the contributing guide for the development/test environment |
| npm | Installed with Node.js |
| OpenCode | Validation baseline `>=1.18.21`; the `opencode` command must be on `PATH`; this is not a per-version pass guarantee and no hard version gate is imposed |
| Managed `bash` execution | Uses the Host Shell selected by OpenCode `config.shell`; O4E does not provide a custom fallback |

The project is developed and primarily tested on Linux. Basic compatibility is
provided for Windows and macOS, but complete installation and task-lifecycle
acceptance has not been performed on those platforms and full support is not
claimed.

## Install into a project

```bash
npx @hymsk/o4e install --no-tui --target /path/to/project
```

After installation, the target project contains:

```text
/path/to/project/
├── .o4e/                # editable configuration
│   ├── config.jsonc
│   ├── soul.md
│   ├── agents/
│   ├── workflows/
│   ├── prompts/
│   ├── skills/
│   └── schemas/
└── .opencode/           # generated OpenCode runtime
    ├── agents/
    └── plugins/
```

If the project already contains `.o4e/`, the installer requires an explicit
`--force`. Before overwriting existing configuration, read the [installation
guide](../guide/installation.md) and [usage guide](../guide/usage.md).

## Start OpenCode

```bash
cd /path/to/project
opencode
```

OpenCode automatically discovers Agents and plugins in `.opencode/`; the plugin
also registers `.o4e/skills/` as the first explicit Skill source. The default
installation provides these main roles in the Agent Selector:

| Agent | Purpose |
| --- | --- |
| `orchestrator` | Handles general development work that needs decomposition and coordination |
| `chat (plan)` | Read-only conversation and requirements discussion; the source configuration name is `chat` |
| `orchestrator (plan)` | Plans work with the default read-only Plan permissions |

Specialist roles are normally delegation-only and do not appear in the main
Agent Selector: `architect` generates both an implementation-capable normal
Profile and a read-only `architect (plan)`; `reviewer` and `researcher` generate
only `reviewer (plan)` and `researcher (plan)`; `debugger` and `tester` remain
normal Profiles. `orchestrator` is the default entry for general development
work. The installer defaults to `o4e-only`, disabling native `build`, `plan`,
`general`, and `explore`; installation can instead use `managed` or choose
`keep`, `managed`, or `disable` item by item.

The enabled Soul is generated during installation and uses `主人` as the
Chinese default form of address and `master` for English installations. Edit
`.o4e/soul.md` to change the form of address or language.

Managed `primary`/`all`/`subagent` Profiles, including Plan Profiles, may use
the managed `task` to delegate when their final permissions allow it. Child
Agents may create another level, but ancestor permission Overlays, Effects, and
write Scope restrictions remain in force. `system` cannot delegate. `task` is
the only Agent-delegation entry point. Omit `background` for normal delegation;
the Runtime executes it in the background and returns immediately. Set
`background: false` only when the user explicitly requests synchronous or
foreground delegation; depending on a child result in the final answer is not
a reason to run it in the foreground.

An Agent Task can be managed by an authorized managed `primary`/`all`/`subagent`
Agent in the Session that created it; a child cannot manage its parent or sibling
Tasks. `watch` freezes the current owner's Agent and Command Task membership by
default and can explicitly select one `taskID` or mixed `taskIDs`; an empty
array selects an empty set. It returns when a new terminal or actionable event
appears, while reliably delivered events do not wake it repeatedly. One event
does not mean that the entire set is complete; continue tracking remaining
dependencies.

Watch waits for 30 minutes by default and accepts an explicit window of at most
one hour. Real user messages and reader aborts can interrupt the wait.
`watch/status` returns status only; read completed Agent results with `output`.
Output preserves whitespace and empty output. A heartbeat does not mean
completion; report a meaningful state change before waiting again.

Use one-task `inspect` for bounded process previews. It accepts `cursor`,
`direction`, `maxBytes`, and `resume: true` from a previously trusted inspect
response. If the source changes or history cannot be verified it reports
`gap/unavailable` rather than silently jumping to a new tail. Inspect does not
consume receipts or decide completion. Inspect/watch read allowances are
separate from execution timeouts.

Permission and question requests for child tasks are normally handled by the
user in the native OpenCode root-session prompt. The parent Agent reports the
wait instead of copying or answering it. Only when the user explicitly asks the
parent to handle the current request may it refresh the request with
`pending` and then call `permission.reply`, `question.reply`, or
`question.reject` with the latest `revision`; a task goal, known answer, or
generic “continue” is not authorization. See the [configuration reference](../reference/configuration.md#background-task)
for the complete parameter and recovery boundaries.

### Run a Command directly

The managed global `bash` tool creates a Command Task directly rather than
delegating through a model. `keep` retains the native Agent identity and
configuration, but not the builtin tool implementation; host permissions still
apply and do not grant Agent delegation or Agent Task management. The tool is
still named `bash`, but command syntax must match the Host Shell selected by
OpenCode. The command is sent to that Shell after host authorization; O4E does
not translate between Bash, PowerShell, and `cmd`. Execution inherits the
startup environment, and the public plugin API does not distribute another
plugin's `shell.env` hook.

Admission waits one second by default, running has a separate ten-second
window, and both are separate from the default 120000-millisecond execution
timeout. If that reader returns before execution finishes, the tool returns a
`taskID` and execution continues; use `o4e_task` to watch it or
explicitly manage that ID. Command supports `status/watch/inspect/output/cancel/pending`;
`pending` returns an empty list with `supported:false` and has no interaction,
input, retry/restart, or Agent receipt.

The native OpenCode Shell card controls its own capture and display. O4E
maintains a separate bounded output view and external log archive; the two
channels are not guaranteed to be identical. The host may fold or adjust the
display, and a card is not a guarantee of complete text delivery.

Untruncated ordinary successful Bash returns captured text, including spaces,
newlines, and empty output. Errors, truncation, or incomplete logs have an
explicit control message before the body. The in-memory view is at most 64 KiB,
the Bash model body is limited to 48 KiB/1800 lines, and larger content returns
a tail. Complete text is written to a private log outside the repository; each
log is limited to 256 MiB, retained for 24 hours after terminal settlement, and
protected while active. Storage failures are marked incomplete. Use authorized
file tools to read `logPath` in segments; inspect only reads the retained view,
idle, and root-turn abort do not cancel a detached command; attached Bash abort,
explicit Task cancel, owner deletion, managed child termination/cancellation,
and disposal still request cancellation. Use authorized `o4e_task cancel` to
stop a background command, not only a conversation abort.

Keep the lock when stop or persistence is uncertain. In-process coordination is
not a sandbox and does not guarantee termination of `setsid` descendants. See
the [command reference](../reference/configuration.md#managed-bash-and-command-tasks)
for complete parameters, permissions, and recovery rules.

## View installation information

To see which Agents and Skills are currently installed:

```bash
npx @hymsk/o4e status --target /path/to/project
```

The `status` command only reads installation state and does not modify the
target project.

## Modify configuration

`.o4e/config.jsonc` is the global configuration entry point. `.o4e/agents/`,
`.o4e/workflows/`, and `.o4e/prompts/` store Agent, Workflow, and Prompt
configuration.

Common defaults include:

| Field | Default | Purpose |
| --- | --- | --- |
| `backgroundTasks` | 4 Agent slots, 4 command slots, `maxRetries: 1` | Agent slots limit direct background Agent Tasks per parent Session; command slots limit each owner/kind lane for global `bash` creation, do not use Agent slots, and do not participate in Scope Lock write exclusion; model errors are not retried automatically and the main Agent resolves them with CAS |
| `loadTools` | `null` | Does not globally rewrite host tool permissions |
| `loadSkills` | `["*"]` | Does not restrict Skills by name; an Agent inherits this default when it declares none |
| `soul.enabled` | `true` | Enables cross-role Soul context |

Rebuild after editing `.o4e/`:

```bash
npx @hymsk/o4e build --target /path/to/project
```

The builder validates configuration before generating a new `.opencode/`
runtime. Do not edit generated files under `.opencode/` directly.

## Further reading

| Topic | Document | Contents |
| --- | --- | --- |
| Installation | [Installation guide](../guide/installation.md) | Interactive, silent, and global installation |
| Installation maintenance | [Usage guide](../guide/usage.md) | Status, backup, restore, and uninstall |
| Global configuration | [Configuration reference](../reference/configuration.md) | Fields, defaults, and precedence |
| Agent configuration | [Agent reference](../reference/agents.md) | Permissions, capabilities, Plan, and delegation |
| Workflow creation | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md#建立契约) | Workflow contracts, Steps, Gates, and recovery design |
| Prompt customization | [Agent Prompt fields](../reference/agents.md#prompt-fields) | Core Prompt, inject, message Prompt, and native Prompt |
| Soul | [Soul and Prompt](../reference/configuration.md#soul-and-prompt) | Soul files, inheritance, and hot-read boundaries |
| Model selection | [Model selection and run modes](../reference/configuration.md#model-selection-and-run-modes) | Host model selection, child-task freezing, and `origin`/`clear` |
| Problems | [Troubleshooting](../troubleshooting/README.md) | Installation, build, and runtime problems |
