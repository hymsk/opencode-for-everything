# 生成文件参考

[中文](generated-files.cn.md) | [English](generated-files.md)

[← 文档中心](../README.cn.md) | [配置参考](./configuration.cn.md) | [Agent 参考](./agents.cn.md) | [仓库规则](../../AGENTS.md)

`.o4e/` 是配置真实源，`.opencode/` 是运行时生成物：

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

构建器为 `all`、`primary` 和 `subagent` 生成运行时 Agent Markdown。`all` 生成 `mode: all`，因此既能被用户选择也能被 Runtime 委派；`primary` 可进入主 Agent Selector；`subagent` 文件只作为委派目标，不进入主 Selector。`system` 固定阶段不生成 Agent 文件，只通过 config hook marker 接管。

`plan.mode: "self"` 只生成 `<name> (plan).md`，不生成无后缀源 selector；`plan.mode: "child"` 保留源 selector 并额外生成 `<name> (plan).md`。所有 Plan 入口（包括受管原生 `plan`）都使用 `<name> (plan)` 作为 OpenCode Agent 名称；它与源角色配置共用 prompt、模型和基础配置，再应用默认 Plan 策略以及用户的显式 Plan override。历史 `<name> (Plan)` 和无后缀 self 名称不生成。列表顺序由 OpenCode 管理。

构建器复制插件运行时模块，并校验内部 managed Skill registry 列出的 `.o4e/skills/*/` 完整 Skill 目录，包括其 `agents/`、`references/`、`templates/`、`evals/` 等资源。Skill 不复制到 `.opencode/`；插件直接注册 `.o4e/skills/`。默认受管 Skill 包括：

- `o4e-agent-creator`：创建和优化 Agent（使用指南见[创建和优化 Agent](../guide/creating-agents.cn.md)）
- `o4e-workflow-creator`：创建和优化 Workflow（方法见[`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md)）

Workflow JSONC 不复制到 `.opencode/`；它保留在 `.o4e/workflows/`，由构建器校验并由插件运行时加载。Workflow Run 状态写入 OpenCode Session，不生成项目内状态文件。

写入前会预检所有生成目标和配置树，拒绝符号链接、硬链接和特殊文件。O4E 不检查或修改公共 `.opencode/skills/`。

生成的 agent Markdown 只用于 OpenCode 发现 Agent 和传递 marker，不是最终 system prompt 的权威来源。最终 prompt 在运行时从扁平的 `.o4e/prompts/`、instruction files 和 Soul 重新组装。

不要手工编辑 `.opencode/` 的受管生成模块。`tui.json[c]` 仍是用户配置，构建和卸载仅维护 O4E 注册，不接管其主题、快捷键或其他插件。独立 TUI 模块不会进入 server 插件自动扫描目录；详情见[任务侧栏 / Task overview](../guide/task-overview.cn.md)。修改 `.o4e/` 后运行构建器；构建命令见 [CLI 参考](./cli.cn.md)。

## 另请参阅

- [配置参考](./configuration.cn.md)：配置源和字段说明
- [Agent 参考](./agents.cn.md)：Agent 类型和 Plan Profile
- [仓库规则](../../AGENTS.md)：真实源、生成物和实现入口
