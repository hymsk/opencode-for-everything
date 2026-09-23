# opencode-for-everything

[![CI](https://github.com/hymsk/opencode-for-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/hymsk/opencode-for-everything/actions/workflows/ci.yml)

> O4E lets you run a configurable Agent team inside OpenCode: describe a goal, and the main Agent advances the work — delegating reviews, research, and test design to specialist sub-agents, running builds and benchmarks as background tasks, and staying responsive while they execute.

**Independent project:** O4E is not officially developed by or affiliated with the OpenCode team.

[简体中文](README.zh-cn.md) | [English](README.md) · [Documentation](https://github.com/hymsk/opencode-for-everything/blob/main/docs/README.md) · [Specification](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md) · [Security policy](https://github.com/hymsk/opencode-for-everything/blob/main/SECURITY.md) · [Contributing](https://github.com/hymsk/opencode-for-everything/blob/main/CONTRIBUTING.md)

## Use cases

- **Delegate specialist work**: hand a code review to `reviewer`, edge-case test design to `tester`, or evidence gathering to `researcher` — each role with its own model, tools, and permissions — and collect their findings without leaving the conversation.
- **Keep talking while work runs**: tests, builds, and benchmarks execute as background tasks shown in a sidebar; interject mid-flight to add requirements or change direction, without cancelling anything.
- **Shape your own Agent team**: define roles, prompts, models, tools, and permissions in `.o4e/`, reuse them globally or per project, and design new roles conversationally with the built-in creator Skills instead of writing everything from scratch.
- **Carry context across sessions**: Soul stores the personal background and collaboration preferences you explicitly ask to keep — shared globally or added per project — rather than remembering every conversation automatically.

O4E does not grant sub-agents extra permissions, retry failed models on its own, or treat sidebar records as accepted results, and an interjection never cancels background work implicitly. Workflow checkpoints are an experimental Beta: disabled by default, not production-ready. Delegation and commands can call real providers, incur costs, and modify files — see [Security and implementation boundaries](#security-and-implementation-boundaries).

## Install

Requirements: Node.js 20.12+, npm, and `opencode` on `PATH`. The OpenCode validation baseline is `>=1.18.21`, not a claim that every later version has been individually validated.

```bash
npx @hymsk/o4e install
```

Follow the prompts to select installation scope, roles, models, and other options. The installer generates configuration and builds the runtime. Afterwards, start or restart OpenCode in the target project.

See the [installation guide](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/installation.md) for manual source installation and advanced options.

## Usage

### Start a task

Start OpenCode in a project with O4E installed, select `orchestrator`, and describe the goal, constraints, and acceptance criteria. For example:

```text
Check the login flow and fix the page not redirecting after the session expires.
Identify the cause first, make a minimal fix, and add regression tests. Do not commit or push.
```

The main Agent can handle simple work directly or delegate independent subproblems to suitable sub-agents. To discuss a plan first, select `orchestrator (plan)` or explicitly ask for analysis without changes.

### Delegate to specialist sub-agents

Let the main Agent decide how to divide the work, or explicitly state the role and boundaries:

```text
Have reviewer inspect these changes in the background, read-only,
focusing on compatibility and missing tests. Continue organizing the usage
documentation yourself without overlapping file edits with the review task.
```

The main Agent creates delegations with managed `task`, then tracks status and reads results with `o4e_task`. These tool names are not Shell commands; natural-language instructions are sufficient for everyday use.

Handle sub-agent permission requests and questions through OpenCode's native prompts. Authorization, nesting depth, and available tools remain subject to configuration; naming a role does not grant additional permissions.

### Default roles

The main Agent is your direct conversation entry. The default is `orchestrator`:

| Main entry | Purpose |
| --- | --- |
| `orchestrator` | Advance implementation, coordinate work, and track results |
| `orchestrator (plan)` | Read-only analysis and planning without making changes |
| `chat (plan)` | Conversation without tools, delegation, or Workflows |

Specialist sub-agents are delegated by the main Agent as needed and do not appear in the primary Agent selector:

| Sub-agent | Purpose |
| --- | --- |
| `architect` | Architecture design and implementation when explicitly requested |
| `architect (plan)` | Read-only architecture analysis and implementation plans |
| `debugger` | Reproduce problems, identify root causes, and fix faults |
| `tester` | Design tests, run validation, and report evidence |
| `reviewer (plan)` | Independently review code and architecture for risks |
| `researcher (plan)` | Read-only research and evidence verification |

Roles and capabilities are configurable rather than limited to these defaults. The default `o4e-only` installation disables OpenCode's native `build`, `plan`, `general`, and `explore` entries. Choose another [native-Agent policy](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/cli.md#native-agent-strategies) to preserve or manage them.

### View tasks and output

The sidebar groups tasks directly owned by the current Session into **Bash** and **Subagents**. Click a task for details or `View all` for the full list. Finished tasks may be hidden from the sidebar but remain accessible in the full list.

Keyboard users can open these command palette entries:

| Command palette entry | Contents |
| --- | --- |
| `O4E: View Bash tasks` | Bash task list and output |
| `O4E: View subagent tasks` | Sub-agent task status and details |
| `O4E: View Workflows (Beta)` | Workflow checkpoints in the current Session; only available after explicit opt-in |

The Bash list shows command prefixes on the left, with aligned status, phase, and exit code on the right. Common controls:

| View | Controls |
| --- | --- |
| Task list | Up/down to select, Enter to open, left/right to page; Bash search matches displayed numbers and command prefixes |
| Bash output details | Left/right to switch tasks, up/down to scroll by screen, `r` to refresh, `b` to return to the list |
| Sub-agent details | Up/down to select an action, Enter to activate; a verified execution Session can be opened |
| Lists and details | Esc to close |

The UI shows synchronized records, not proof that results have been accepted. To confirm completion and obtain the full available result, you can say:

```text
Check whether the background tasks have completed, and read their results before summarizing.
If any failed, explain why without automatically rerunning them.
```

See [Task overview](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/task-overview.md) for more interactions and display boundaries. Missing or potentially sensitive command prefixes are omitted, but this is not complete redaction; output may still contain secrets.

### Interject, stop following, or cancel

While background tasks run, you can add instructions or arrange non-conflicting work with the main Agent. New messages take priority without automatically cancelling existing background tasks. Automatic follow-up can resume coordination after a natural idle turn.

These intentions are different:

| Your intention | Example |
| --- | --- |
| Stop monitoring while execution continues | “Stop following this background task, but do not cancel it.” |
| Stop execution | “Cancel the test task and confirm the stop result.” |

**Stopping follow-up is not cancellation, and closing details is not cancellation.** Check the returned result to confirm whether cancellation succeeded. Persisted records do not mean old commands can be replayed or old processes adopted after a host restart.

### Choose a startup mode

Use the `o4e_mode` environment variable to select how this instance starts, without uninstalling the plugin or rewriting configuration files:

| Mode | Behavior | Use case |
| --- | --- | --- |
| `default` (also used when unset) | Enable O4E and retain configured models and Agent capabilities | Everyday use |
| `origin` | Do not initialize the managed O4E Runtime; return a clean host configuration projection | Temporarily use native OpenCode or compare behavior when diagnosing O4E's impact |
| `clear` | Retain O4E capabilities, remove top-level and per-Agent `model` / `variant` from this instance's final runtime configuration, and disable internal configured candidates | Temporarily use host model selection instead of configured model assignments |

Start from your target project directory. The examples below use Bash / Zsh syntax:

```bash
# Default mode; plain opencode is equivalent when o4e_mode is unset
o4e_mode=default opencode

# Native mode
o4e_mode=origin opencode

# Keep O4E but clear configured model assignments for this runtime
o4e_mode=clear opencode
```

`clear` does not delete models, credentials, or saved host model preferences, nor does it reset the model already selected for a Session. The host may still use explicit or remembered selections. `origin` is not an uninstall and does not disable other plugins.

The mode is read when the plugin instance is created, so restart OpenCode after changing it. Values use the lowercase names above; an empty string or any other value falls back to `default` and emits an error diagnostic naming the invalid value (host log, plus a TUI warning toast when available).

You can also select a different configuration with `o4e_config`, combined with a startup mode:

```bash
o4e_config=/absolute/path/to/.o4e o4e_mode=default opencode
```

When explicitly set, configuration is read only from that directory. Otherwise, project `.o4e/` takes precedence, with global configuration as the default source. The path must be absolute (a `~/` prefix is supported), and changes also require a restart. Switching configuration does not isolate tasks or locks. See the [environment variable reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.md#environment-variables) for details.

### Try Workflow (Beta, opt-in)

**Workflow is Beta, not a stable or production-ready feature.** It is disabled by default, including when the setting is omitted. To experiment, explicitly opt in in `.o4e/config.jsonc`:

```jsonc
{
  "enableWorkflow": true
}
```

Merge this field into the existing configuration rather than replacing the file. Rebuild the target and restart OpenCode. `loadWorkflows`, Agent permissions, and having Workflow definition files do not enable it on their own. Set `enableWorkflow` to `false` to disable it again; this does not cancel already-created Agent or Bash tasks.

Once opted in, configure a Workflow and ask the main Agent to inspect experimental entries:

```text
Check the available Workflows. If one fits this task, explain its input requirements
and follow it step by step. Otherwise, work directly without inventing a workflow name.
```

The main Agent creates and advances checkpoints with `o4e_workflow`, performs the steps itself, and submits reports. Gates validate the declared schemas and supported evidence references; only accepted results advance subsequent steps. A Workflow is not a background scheduler and does not prove every professional conclusion or file claim correct.

After a user interjection, the main Agent must explicitly resume the workflow in light of the new instructions. Pausing or stopping a Workflow does not cancel Tasks it already created. See the [Workflow reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/workflows.md) for definitions and full operations.

## Configuration

`.o4e/` is the editable configuration source. Files managed by this component in `.opencode/` are generated output; do not edit them directly.

| Path | Configuration | Details |
| --- | --- | --- |
| `.o4e/config.jsonc` | Loading rules, models, permissions, MCP, and Soul settings | [Configuration reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.md) |
| `.o4e/agents/` | Agent roles, Plan Profiles, and capability assignments | [Agent reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/agents.md) |
| `.o4e/workflows/` | Steps, dependencies, input/output schemas, and Gates | [Workflow reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/workflows.md) |
| `.o4e/prompts/` | Prompts in the installation's selected language | [Configuration reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.md) |
| `.o4e/skills/` | Skills loaded directly by the plugin | [Skill reference](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/skills.md) |
| `.o4e/soul.md` | Personal context when Soul is enabled | [Usage guide](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/usage.md) |

After changing Agent or Workflow configuration, or runtime code, rebuild from the O4E source directory and restart OpenCode:

```bash
node scripts/installer.mjs build --target /path/to/project
```

Use `build --global` for a global installation. Prompt Markdown, Soul, and managed instruction files are reread during the next relevant prompt assembly. See the [usage guide](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/usage.md) for maintenance operations and [Creating Agents](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/creating-agents.md) for new roles.

## Security and implementation boundaries

- **Delegation and commands may call real providers, incur costs, and modify files or external systems.** Review permission requests; neither Prompts nor Workflows are a sandbox.
- Agent capabilities depend on host permissions and O4E policies together, with blocklists taking precedence over allowlists. Scope Locks between Agents coordinate within a process, not through OS isolation or cross-process leases. Bash does not participate in write-scope exclusion; command concurrency is limited by a resource count instead. Callers must coordinate concurrent file changes and command dependencies.
- Model errors in background Agent Tasks wait for an explicit retry decision. O4E does not automatically retry models or switch fallback candidates; provider-internal retries are outside this boundary.
- O4E supports OpenCode only, without standalone Agent processes, an HTTP/SSE Gateway, or a remote A2A network.

## Compatibility and validation

O4E is developed and primarily tested on Linux. Windows and macOS have basic compatibility, but complete installation and task-lifecycle behavior has not been comprehensively validated on real hosts. Development and tests use Node.js 24.

Full host lifecycle, crash recovery, and cross-platform acceptance remain incomplete. Module observations in disposal fixtures do not directly establish that normal host exit leaves tasks running or reuses old plugin instances, nor do they demonstrate a fix. See [SPEC](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md) for requirements and validation scope, and [troubleshooting](https://github.com/hymsk/opencode-for-everything/blob/main/docs/troubleshooting/README.md) for diagnostics.

## Documentation and contributing

English is the primary documentation language under `docs/`; Chinese mirrors use the `.cn.md` suffix.

- [Documentation index](https://github.com/hymsk/opencode-for-everything/blob/main/docs/README.md): all guides and references.
- [O4E and native OpenCode](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/opencode-comparison.md): capabilities and responsibility boundaries.
- [Contributing](https://github.com/hymsk/opencode-for-everything/blob/main/CONTRIBUTING.md): development, validation, and commit conventions; read [AGENTS.md](https://github.com/hymsk/opencode-for-everything/blob/main/AGENTS.md) and [SPEC.md](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md) before changing the implementation.
- [Security policy](https://github.com/hymsk/opencode-for-everything/blob/main/SECURITY.md): how to report security issues.

## License

[AGPL-3.0-or-later](LICENSE).
