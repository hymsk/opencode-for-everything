# Installation Guide

[English](installation.md) | [中文](installation.cn.md)

[← Documentation Hub](../README.md) | [Quick Start](../getting-started/quick-start.md) | [Usage Guide](./usage.md)

`opencode-for-everything` supports installation into a single project as well as into OpenCode's global configuration directory. npm is the simplest installation path; manual source installation remains available for development, debugging, and reviewing the exact source being executed.

## Requirements

| Dependency | Requirement |
| --- | --- |
| Node.js | 20.12 or later; for the development test environment, see the contribution guide |
| npm | Installed with Node.js |
| OpenCode | Verification baseline `>=1.18.21`, with the `opencode` command on `PATH`; no per-version pass guarantee and no hard version gate |

The project is developed on Linux, tested mainly on Linux, and provides basic compatibility with Windows, macOS, and other systems; full installation and task lifecycles have not been comprehensively verified on real machines there, and full support is not claimed.

## Install with npm

Start the interactive installer without permanently installing a CLI:

```bash
npx @hymsk/o4e install
```

Follow the prompts to select the target scope, Agents, models, Skills, and Soul options. The remaining examples use the source-script form so every operation is explicit; replace `node scripts/installer.mjs` with `npx @hymsk/o4e` to run the same command from npm.

## Manual Source Installation

```bash
git clone https://github.com/hymsk/opencode-for-everything.git
cd opencode-for-everything
npm ci
node scripts/installer.mjs install
```

Follow the interactive prompts. Subsequent source-script commands run in `opencode-for-everything` by default.

## Project-Level Installation

Project-level installation suits teams that want to manage Agent and Workflow configuration together with the code.

### Using Default Options

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project
```

| Item | Default behavior |
| --- | --- |
| Configuration directory | Creates `.o4e/` in the target project. |
| OpenCode runtime | Generates `.opencode/agents/` and `.opencode/plugins/`; Skills stay in `.o4e/skills/` and are registered directly by the plugin. |
| Soul | Enabled by default, with an initialized `soul.md` generated during installation; the default Chinese form of address is `主人`. |
| Custom Agents | The default entry is `orchestrator`; optional main entries are `orchestrator`, `orchestrator (plan)`, and the read-only pure-chat `chat (plan)`. Chat has no tool, role discovery, delegation, or Workflow capabilities. The default subagent Runtime names are `architect`, `architect (plan)`, `reviewer (plan)`, `researcher (plan)`, `debugger`, `tester`, all delegation-only. |
| OpenCode native Agents | The default preset is `o4e-only`: `build`, `plan`, `general`, `explore` are all `disable`, the host native Agents are not taken over, and the host's same-named entries are disabled at runtime. With `managed`, O4E takes over the corresponding host Agents and allows customizing their prompts in `.o4e`. |

Disabling Soul:

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project --no-soul
```

### Interactive Selection

```bash
node scripts/installer.mjs install
```

The interactive install selects the target scope, native Agent preset, main Agents, subagents, default Skills, models, and Soul. The main Agent list contains only `all`/`primary` roles usable as session entries; the subagent list contains only delegation-only `subagent` roles; the two kinds never mix in one list. Native Agents first choose an overall preset; only with `custom` does the installer set the final strategy for `build`, `plan`, `general`, `explore` item by item — other presets take effect directly. Models support unified, per-type, or per-Agent selection and variants; when inheriting from the host, null is saved. The default `default` keeps these configurations; `clear` only clears the current runtime projection without modifying source files.

Silent installation installs all default Skills. To select or disable default Skills precisely:

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project \
  --skill=o4e-agent-creator --skill=o4e-workflow-creator
node scripts/installer.mjs install --no-tui --target /path/to/project --no-skills
```

Reinstallation deletes the same-named directories of the default Skills in the internal registry, fully rewrites the selected ones, and keeps the unselected ones deleted; user-created `.o4e/skills/` outside the registry are preserved, and the public `.opencode/skills/` is not touched.

Overall presets correspond to silent-install parameters as follows:

```bash
node scripts/installer.mjs install --no-tui --native-policy=o4e-only
node scripts/installer.mjs install --no-tui --native-policy=managed
node scripts/installer.mjs install --no-tui --native-policy=keep
node scripts/installer.mjs install --no-tui --native-policy=custom \
  --native-build=managed --native-plan=keep \
  --native-general=disable --native-explore=keep
```

You can also repeat parameters of the form `--native-agent build=managed`. Silent `custom` must explicitly provide all four strategies; interactive install sets them item by item only after `custom` is chosen.

The installer writes the Agent `description` in the selected language into the concrete configuration and copies the prompts in the selected language directly into `.o4e/prompts/`. The installer selects the first enabled Agent in catalog display order that can serve as a main entry and writes it to `defaultAgent`; it does not write an Agent ordering field — the ordering of the host Selector is still managed by OpenCode.

When Soul is enabled, the installer also generates an initialized `.o4e/soul.md`. Chinese installs default to the form of address `主人`, English installs default to `master`; you can edit the file directly afterwards.

### Existing Configuration

When `.o4e/` already exists in the target project, silent installation requires the explicit `--force`:

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project --force
```

`--force` confirms reinstalling the managed configuration. Back up any custom content you want to keep beforehand; see the [Usage Guide](./usage.md) for configuration export and restore.

## Global Installation

Global installation suits personal environments that want to share one set of base Agent configuration across multiple projects:

```bash
node scripts/installer.mjs install --no-tui --global
```

The installer writes the configuration source to `~/.config/opencode/.o4e/`, writes runtime files to `~/.config/opencode/`, and registers the plugin entry in `opencode.json` or `opencode.jsonc`.

The global installation path is currently fixed at `~/.config/opencode`. The runtime can resolve an absolute `XDG_CONFIG_HOME`, but installation and global builds do not yet follow that variable to relocate directories. With a custom XDG path, prefer project-level installation.

## Installation Interruption and Recovery

If installation or import fails after writing configuration, the installer preserves the failed content and restores the original configuration and runtime as much as possible:

| Content | Handling |
| --- | --- |
| Failed configuration | Saved in `.o4e-install-failed-*` or `.o4e-import-failed-*` directories. |
| Existing managed runtime | An attempt is made to restore the original content. |

When problems occur, keep the terminal error messages and refer to [Troubleshooting](../troubleshooting/README.md).

## After Installation

Run `opencode` in the target project to use the installed Agents. To view the current installation contents, run:

```bash
node scripts/installer.mjs status --target /path/to/project
```

After modifying `.o4e/config.jsonc` or reinstalling, exit and restart OpenCode so the host configuration and plugin reload.

For the purpose of each directory in the installation target and the runtime boundaries, see
[`defaults/.o4e/README.md`](../../defaults/.o4e/README.md). For rebuilding, import/export,
backup, and uninstall, see the [Usage Guide](./usage.md).
