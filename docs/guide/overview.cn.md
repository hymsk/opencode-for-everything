# 项目概览

[中文](overview.cn.md) | [English](overview.md)

[← 文档中心](../README.cn.md) | [快速开始](../getting-started/quick-start.cn.md) | [配置参考](../reference/configuration.cn.md)

`opencode-for-everything` 是运行在 OpenCode 之上的项目级 Agent 和 Workflow 配置系统。它让团队能够为不同开发任务准备专业角色，并把这些角色的 prompt、工具、Skill、MCP、权限和协作流程与项目一起管理。

## 项目定位

当一个项目开始使用多个 Agent，配置往往不再只是一个 system prompt：架构设计、代码实现、调试、测试和审查需要不同的上下文、工具权限和工作方式，复杂任务还需要可靠的主会话检查点与中断恢复。

本项目为这些需求提供统一入口：

| 需求 | 项目能力 |
| --- | --- |
| 专业角色分工 | Agent 的角色、上下文和能力通过配置明确表达。 |
| 配置治理 | 项目配置可以进入版本管理并接受代码审查。 |
| 协作边界 | 每个 Agent 的委派对象和可用 Workflow 均可控制。 |
| 流程复用 | 重复流程可以定义一次，并在多个任务中复用。 |
| 部署边界 | OpenCode 是唯一宿主，无需额外部署 Agent 服务。 |

## 核心模型

```text
.o4e/                       构建                        .opencode/
项目可编辑配置              ─────────────────────────>  OpenCode 加载的运行时
```

`.o4e/` 是用户维护的配置源，包含 Agent、Workflow、prompt、Skill、Soul 和权限策略。安装器读取并校验这些配置，然后生成 `.opencode/` 中的 Agent 和插件入口；插件直接把 `.o4e/skills/` 注册给 OpenCode。

日常使用只编辑 `.o4e/`。`.opencode/` 可以随时重新生成，因此不应手工维护。

## Agent 分工

默认安装提供 7 个自定义角色：

| Agent | 适合处理的任务 |
| --- | --- |
| `orchestrator` | 需要拆解、协调和汇总的多步骤开发任务 |
| `architect` / `architect (plan)` | 需求澄清、方案设计和模块边界分析；普通 Profile 可按任务落地，Plan Profile 只读 |
| `debugger` | 缺陷复现、根因定位和修复 |
| `tester` | 测试设计、边界覆盖和行为验证 |
| `reviewer (plan)` | 代码审查、架构审查和回归风险分析 |
| `researcher (plan)` | 技术调研、资料比较和证据整理 |
| `chat (plan)` | 只读纯对话和需求讨论；源配置名为 `chat` |

Agent 还分为不同使用方式：

| 类型 | 用途 |
| --- | --- |
| `all` | 既可以从 Agent Selector 选择，也可以被其他 Agent 委派 |
| `primary` | 只能作为当前会话的主 Agent |
| `subagent` | 只能作为受控委派目标 |
| `system` | OpenCode 固定使用的内部阶段 |

安装时可以选择接管原生 `build`、`plan`，也可以启用原生 `general`、`explore`。具体配置方式见 [Agent 参考](../reference/agents.cn.md)。

## Workflow 如何协作

Workflow 是 `.o4e/workflows/` 中的 process-v1 主会话检查点协议，适合表达需要复用、验收和恢复的开发流程。例如，主 Agent 可以依次完成需求分析、实现和验证，并在每个 Step 后提交结构化报告供 Runtime Gate 验收。

| Workflow 能力 | 说明 |
| --- | --- |
| DAG 依赖 | 只让依赖已通过 Gate 的 Step 进入 ready；当前一次只有一个 active Step。 |
| 主会话执行 | 普通 Step 由当前主 Agent 直接完成，不创建 Workflow 执行 Session。 |
| 显式 Task | Step 可以要求主 Agent 另行调用现有 `task`，但授权、等待和取消仍属 Task 协议。 |
| Gate | 按输出 Schema、Artifact 数量和有限事实引用验收 StepReport。 |
| 有限修复 | Gate 拒绝后可在配置次数内显式开始下一 Attempt，不自动重放工作。 |
| 检查点恢复 | Run 保存在 owner Session metadata；新消息后先处理指令，再显式 read/resume。 |

普通任务可以直接交给单个 Agent。只有当过程本身值得复用、约束或恢复时，才需要创建 Workflow。

## Skill 与 Soul

| 组件 | 作用 |
| --- | --- |
| Skill | 提供按需加载的方法和操作指南，不扩大 Agent 已有权限。 |
| Soul | 为多个角色提供共享的用户背景和持久偏好。 |

## 适用场景

| 场景 | 支持情况 |
| --- | --- |
| 在同一项目中使用多个专业 Agent | 适用 |
| 将 Agent 配置与代码一起版本管理 | 适用 |
| 限制不同角色的工具、权限和委派范围 | 适用 |
| 将实现、测试和审查沉淀为可恢复的主会话 Workflow | 适用 |
| 运行独立 Agent 进程或 Agent Card | 不提供 |
| 提供 HTTP/SSE Gateway 或 push notification | 不提供 |
| 运行远端 A2A 或跨主机 Agent 网络 | 不提供 |

## 相关文档

| 主题 | 文档 |
| --- | --- |
| 安装与首次运行 | [快速开始](../getting-started/quick-start.cn.md) |
| Agent 定制 | [创建和优化 Agent](creating-agents.cn.md) |
| Workflow 编排 | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md#design-steps) |
| 配置字段 | [配置参考](../reference/configuration.cn.md) |
| 与 OpenCode 原生能力对比 | [能力对比](opencode-comparison.cn.md) |
