# CLI Reference

[English](cli.md) | [中文](cli.cn.md)

[← Documentation Home](../README.md) | [Configuration Reference](./configuration.md) | [Troubleshooting](../troubleshooting/README.md)

`opencode-for-everything` provides two equivalent command entries:

- **Source script**: `node scripts/installer.mjs` (used for development and debugging)
- **Package command**: `o4e` (provided by an npm global install or link; arguments are exactly the same as the source script)

For one-off use, run `npx @hymsk/o4e <subcommand>`. The examples below use the source script form; you can replace `node scripts/installer.mjs` with `npx @hymsk/o4e` or `o4e`. The installer's `install --global` only selects the OpenCode global configuration scope and does not install the command globally.

```bash
node scripts/installer.mjs install
node scripts/installer.mjs install --no-tui
node scripts/installer.mjs build --target /path/to/project
node scripts/installer.mjs build --global
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs uninstall --no-tui --target /path/to/project
node scripts/installer.mjs uninstall --no-tui --global
node scripts/installer.mjs export my-config.o4e.tar.gz --target /path/to/project
node scripts/installer.mjs import my-config.o4e.tar.gz --target /path/to/project --force
```

## Subcommands

| Subcommand | Description |
| --- | --- |
| `install` | install and build the runtime |
| `uninstall` | clean the managed runtime; both silent and interactive defaults keep the configuration source, and interactive mode can explicitly choose to delete it |
| `status` | read-only check of installation state |
| `build` | validate `.o4e/` and rebuild the runtime |
| `export <archive>` | export `.o4e/` as `.o4e.tar.gz` |
| `import <archive>` | import `.o4e.tar.gz` and rebuild the runtime |

## Options

| Option | Description |
| --- | --- |
| `--no-tui` | silent mode; no interactive UI |
| `--lang=zh` / `--lang=en` | installation language, default `en`; mainly for silent installs |
| `--no-soul` | disable Soul; enabled by default in silent installs |
| `--target=<directory>` | project-level target directory; mutually exclusive with `--global` |
| `--global` | use the global target `~/.config/opencode` |
| `--force` | overwrite an existing `.o4e/`, or confirm overwrite for non-interactive import |
| `--skill=<name>` | `install` only; install exactly one default Skill, repeatable; installs all default Skills when omitted |
| `--no-skills` | `install` only; install no default Skills; cannot be used with `--skill` |
| `--native-policy=<o4e-only\|managed\|keep\|custom>` | choose the overall preset for the four OpenCode native Agents at install time; default `o4e-only` |
| `--native-build=<keep\|managed\|disable>` etc. | override the individual `build`, `plan`, `general`, or `explore` strategy |
| `--native-agent <name>=<strategy>` | override a single strategy as a repeatable flag, e.g. `--native-agent build=managed` |
| `--help`, `-h` | show help |

## Arguments

`status` and project-level `build` must explicitly specify `--target`; silent install and uninstall use the current directory when `--target` is omitted. `export` and `import` must be immediately followed by a non-empty archive file path. Only one subcommand may be selected per invocation; the old `--status`, `--uninstall`, `--build`, `--export`, and `--import` action options are no longer supported.

Running the CLI without any arguments shows help and exits normally; it does not implicitly start an installation. Every operation requires an explicit subcommand.

`--native-policy`, `--native-*` / `--native-agent`, `--skill`, and `--no-skills` are only for `install`. In a silent install, `custom` must provide a final strategy for all four native Agents; an interactive install separately selects the default main Agent (`all`/`primary`), the child Agent source configuration (`subagent`), default Skills, and the native Agent preset. The default entry is `orchestrator`; optional entries are `orchestrator`, `orchestrator (plan)`, and the read-only pure-chat `chat (plan)`. Chat loads no tools or other roles and cannot delegate or run Workflows; professional roles remain child Agents after expansion, where `architect` is a child Plan and `reviewer`/`researcher` are self Plans. When only self main roles are selected, the installer writes the expanded `(plan)` name into `defaultAgent`.

## Status, Build, and Uninstall

`build` validates the configuration and the internal managed Skill registry, and generates `.opencode/agents/` and `.opencode/plugins/`; it does not modify `.o4e/` or the public `.opencode/skills/`. Skills are registered by the plugin directly from `.o4e/skills/`. A global `build` does not register plugins; registration only happens on global install or import.

## Native Agent Strategies

The `nativeAgents` in the installation configuration always contains four entries:

```jsonc
{
  "nativeAgents": {
    "build": "disable",
    "plan": "disable",
    "general": "keep",
    "explore": "keep"
  }
}
```

- `keep`: O4E does not take over the Agent identity and configuration, nor modify its host definition; builtin
  tool implementations are not kept — the same-named `bash` and `task` still override global ordinary tool calls, host permissions remain in effect,
  and no Agent delegation or Agent Task management permission is granted. For Command boundaries see the
  [Configuration Reference](./configuration.md#managed-bash-and-command-tasks).
- `managed`: O4E takes over the corresponding host native Agent and allows customizing its prompt in `.o4e`; `build`/`plan` use `nativeMode`, and `general`/`explore` use the same-named `subagent`.
- `disable`: not taken over by O4E, and `agent.<name> = { "disable": true }` is projected to the host.

At build time all four strategies are checked to be explicitly declared, and the strategies and `.o4e/agents/` files are validated for consistency, avoiding "configuration claims keep/disable but files still take over" or "claims takeover but files are missing". Old configurations that omit `nativeAgents` or any of its entries fail directly; fill in all four first — they are no longer implicitly derived from existing Agent files.

Project-level `status` reports `.o4e/` and the generated runtime; global status reports the global `.o4e/`, runtime, and plugin registration.

Runtime cleanup only handles Agents, plugins, and runtime modules that carry component markers and can be safely identified. Silent uninstall (`--no-tui`) keeps `.o4e/` and the Skills inside it; O4E never cleans the public `.opencode/skills/`.

In interactive uninstall, "keep configuration?" defaults to yes; accepting the default keeps the entire `.o4e/`. Only after actively choosing no, seeing the deletion summary, and completing final confirmation is the configuration source deleted, including user configuration, Soul, and self-built Skills; uninstall does not create backups for them — export whatever you need to keep before deleting.

## Import and Export

An export archive contains only the target `.o4e/`, not `.opencode/`. The archive name must end with `.o4e.tar.gz` and must not be placed inside the `.o4e/` being exported. When the import target already has `.o4e/`, an interactive terminal asks; non-interactive calls require `--force`.

Import only accepts plain, non-linked archive files. The installer first copies the input archive to a pinned private temporary directory, then validates and extracts that same copy; archive members must use POSIX `/` separators and must live only under `.o4e/`; symlinks, hard links, special files, and non-canonical paths are all rejected. Only import archives from trusted sources.

Export validates the generated archive with the same rules and only replaces an existing backup after it passes; on failure the original backup is kept. Chinese and space file names are supported; paths containing colons, backslashes, newlines or carriage returns, trailing dots or spaces, and Windows reserved device names do not meet archive constraints. When you hit `unsupported entry`, rename per the path in the error and export again.

Import and export rely on the system `tar`. On Windows, `%SystemRoot%\System32\tar.exe` is used when `SystemRoot` or `WINDIR` is available; on other platforms `tar` is looked up in `PATH`.

## Agent Layout

V1 only accepts the `agents/{system,all,primary,subagent}` directory structure. The installer and builder provide no migration or normalization entry for other layouts; configurations that do not meet the current Schema and directory contract fail directly.

## Native Prompt Sync

The installer extracts the `build`/`plan` system prompt and Plan reminder from the `opencode` binary in the current `PATH`. The generated files are user configuration and can be edited directly; `.o4e/native-prompt-install.json` only records the source and hashes to protect user edits.

For the shortest interactive installation, run `npx @hymsk/o4e install`. Manual source installation is documented in the [Installation Guide](../guide/installation.md). Treat the command's `--help` output as the authoritative source for arguments.
