# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
release candidates before a stable baseline.

## Unreleased

## 0.1.0-rc.2

- Externalized the canonical command recovery ledger: Command records now
  live in a private per-directory SQLite database under the user data
  directory (`opencode-for-everything/command-ledgers/<directory-sha256>.sqlite`,
  `XDG_DATA_HOME`/`~/.local/share` on Linux/macOS or `LOCALAPPDATA` on
  Windows), while owner Session metadata keeps only a whitelisted version-2
  display snapshot. Execution, recovery and Workflow evidence read the
  independent ledger; a failed display publication surfaces
  `O4E_COMMAND_PROJECTION_UNAVAILABLE` and can be republished without rolling
  back confirmed records, and unchanged Session updates are skipped to reduce
  repeated recovery payloads. This updates the `CMD-007` contract: legacy
  Session recovery layouts are not read, migrated or deleted, so command
  tasks in flight during the upgrade are not recoverable, and backups or
  machine moves must include the ledger database alongside the OpenCode
  database.
- Normalized `o4e_task` control arguments at the adapter: `cancel` drops
  optional fields the model fills in for other actions and forwards only
  `action` plus a single non-empty `taskID` to strict runtime validation, and
  `inspect`/`follow` optional fields accept explicit `null` to express
  omission without invented cursors or switch settings. Forbidden inputs such
  as `reason`, `cursors` and `reread` remain rejected; ownership, host
  permission and revision checks are unchanged.
- Changed `o4e_mode` invalid-value handling: an empty string or any other
  unsupported value now falls back to `default` (O4E stays enabled) and emits
  an `O4E_MODE_FALLBACK` error diagnostic naming the invalid value — written
  to the host log and shown as a TUI warning toast when available — instead of
  refusing to load the plugin. This updates the `CFG-008` contract, which
  previously required failing closed.
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
- Build fixes: generated runtime manifests pin the runtime plugin
  dependencies and no longer add the development SDK pin, leaving the plugin
  SDK version to the host while preserving existing SDK declarations.

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
