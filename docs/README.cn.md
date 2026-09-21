# O4E 用户文档

[中文](README.cn.md) | [English](README.md)

[项目主页](../README.md) | [参与贡献](../CONTRIBUTING.md)

这里仅保留安装、使用、配置、扩展和排查
`opencode-for-everything` 所需的公开文档。内部评审、历史记录、实施计划、验收记录和问题台账不属于公开用户手册。

## 开始使用

- [快速开始](getting-started/quick-start.cn.md)：从源码安装并首次启动 OpenCode
- [项目概览](guide/overview.cn.md)：理解 `.o4e/` 配置源、Agent、Skill 和 Workflow
- [O4E 与 OpenCode 原生能力对比](guide/opencode-comparison.cn.md)：了解 O4E 增加的能力、设计原因、优势和边界
- [当前特性总览](guide/features.cn.md)：完整说明插件行为及与 OpenCode 原生能力的对比
- [安装指南](guide/installation.cn.md)：项目级、全局和静默安装
- [使用指南](guide/usage.cn.md)：构建、状态、备份、恢复和卸载
- [任务侧栏 / Task overview](guide/task-overview.cn.md)：Todo 上方的只读 Bash / 子 Agent 快照及 TUI 注册生命周期
- [自动任务跟踪 / Automatic task tracking](reference/automatic-follow.cn.md)：持久停止／恢复、失败诊断与宿主验收边界

## 配置与扩展

- [创建和优化 Agent](guide/creating-agents.cn.md)
- [配置参考](reference/configuration.cn.md)
- [Agent 参考](reference/agents.cn.md)
- [Workflow 参考](reference/workflows.cn.md)
- [Skill 参考](reference/skills.cn.md)
- [CLI 参考](reference/cli.cn.md)
- [生成文件参考](reference/generated-files.cn.md)

仓库内的 `o4e-workflow-creator` Skill 维护 Workflow 创建方法；安装后配置目录的完整边界见
[`defaults/.o4e/README.md`](../defaults/.o4e/README.md)。完整方法见
[`o4e-workflow-creator` Skill](../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md)。

## 排查问题

- [故障排查](troubleshooting/README.cn.md)
