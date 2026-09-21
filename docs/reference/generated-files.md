# Generated Files Reference

[English](generated-files.md) | [中文](generated-files.cn.md)

[← Documentation Home](../README.md) | [Configuration Reference](./configuration.md) | [Agent Reference](./agents.md) | [Repository Rules](../../AGENTS.md)

`.o4e/` is the configuration source of truth; `.opencode/` is generated runtime output:

```text
目标项目/
├── .o4e/
│   ├── config.jsonc
│   ├── agents/{system,all,primary,subagent}/
│   ├── workflows/
│   ├── prompts/
│   ├── schemas/
│   ├── skills/
│   └── soul.md
└── .opencode/
    ├── agents/*.md
    ├── plugins/*
    ├── tui/opencode-for-everything/*
    └── tui.json[c] # 用户配置；仅精确维护 O4E plugin 注册项
```

The builder generates runtime Agent Markdown for `all`, `primary`, and `subagent`. `all` generates `mode: all`, so it can both be selected by the user and delegated to by the Runtime; `primary` can enter the main Agent Selector; `subagent` files serve only as delegation targets and do not enter the main Selector. The `system` fixed phase generates no Agent files and only takes over via the config hook marker.

`plan.mode: "self"` generates only `<name> (plan).md` and no suffix-less source selector; `plan.mode: "child"` keeps the source selector and additionally generates `<name> (plan).md`. All Plan entries (including the managed native `plan`) use `<name> (plan)` as the OpenCode Agent name; it shares the prompt, model, and base configuration with the source role configuration, then applies the default Plan policy and the user's explicit Plan overrides. The historical `<name> (Plan)` and suffix-less self names are not generated. List order is managed by OpenCode.

The builder copies plugin runtime modules and validates the complete Skill directories of `.o4e/skills/*/` listed in the internal managed Skill registry, including their `agents/`, `references/`, `templates/`, `evals/`, and other resources. Skills are not copied into `.opencode/`; the plugin registers `.o4e/skills/` directly. Default managed Skills include:

- `o4e-agent-creator`: create and improve Agents (usage guide: [Creating and Improving Agents](../guide/creating-agents.md))
- `o4e-workflow-creator`: create and improve Workflows (method: [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md))

Workflow JSONC is not copied into `.opencode/`; it stays in `.o4e/workflows/`, validated by the builder and loaded by the plugin at runtime. Workflow Run state is written to the OpenCode Session; no in-project state files are generated.

All generation targets and the configuration tree are prechecked before writing, rejecting symlinks, hard links, and special files. O4E does not inspect or modify the public `.opencode/skills/`.

The generated agent Markdown is only used by OpenCode to discover Agents and pass markers; it is not the authoritative source of the final system prompt. The final prompt is reassembled at runtime from the flat `.o4e/prompts/`, instruction files, and Soul.

Do not manually edit the managed generated modules under `.opencode/`. `tui.json[c]` remains user configuration; build and uninstall only maintain the O4E registration and do not take over its theme, keybindings, or other plugins. Standalone TUI modules do not enter the server plugin auto-scan directory; see [Task Sidebar / Task Overview](../guide/task-overview.md) for details. After modifying `.o4e/`, run the builder; for build commands see the [CLI Reference](./cli.md).

## See Also

- [Configuration Reference](./configuration.md): configuration source and field descriptions
- [Agent Reference](./agents.md): Agent types and the Plan Profile
- [Repository Rules](../../AGENTS.md): source of truth, generated artifacts, and implementation entries
