# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
release candidates before a stable baseline.

## Unreleased

- Add the `model` CLI subcommand to modify an installed target's model
  configuration after installation: the global `defaultModel` and per-Agent
  `model` (both with optional variant, `null` restores inheritance) for
  `all`/`primary`/`subagent` Agents, in interactive mode (with project/global
  scope selection and the same model catalog as the installer) and in silent
  mode (`--default-model`, `--default-variant`, `--model <agent>=<value>`,
  `--variant <agent>=<value>`). Edits preserve JSONC comments and other
  settings, are applied only to the configuration file selected by the normal
  precedence, and trigger a full builder rebuild with rollback to the original
  files on validation failure.

## 0.1.0-rc.1

First public release candidate (tag `v0.1.0-rc.1`); the public compatibility
baseline is maintained from this version onward.

- Configurable Agent teams in OpenCode: main Agents (`orchestrator`, read-only
  Plan entries) delegate to specialist sub-agents (`architect`, `debugger`,
  `tester`, `reviewer`, `researcher`) with per-role models, tools, and
  permissions.
- Durable background Agent and Bash tasks with admission limits, sidebar
  visibility, watch/inspect/output reads, cancellation, and recovery across
  sessions and plugin restarts; last-facade shutdown cancels running Agents
  instead of orphaning them.
- Shared-directory coordination between plugin instances, Scope Lock conflict
  management, and quarantine-then-resolve handling of failed disposal.
- Experimental Workflow checkpoints (Beta, opt-in via `enableWorkflow`),
  declarative steps and Gates; disabled by default and not production-ready.
- Project and global configuration under `.o4e/`, installer/CLI (`o4e`)
  published as `@hymsk/o4e`,
  import/export, creator Skills for conversational role design, and Soul
  long-term personal context.
- Bilingual documentation: English is primary under `docs/` with Chinese
  mirrors (`*.cn.md`).

Known limitations: developed and verified on Linux; Windows and macOS
lifecycles are not covered by CI or host acceptance. The npm package is not
yet published; install from source. See `README.md` and `docs/` for
capabilities and boundaries present at the tagged commit.
