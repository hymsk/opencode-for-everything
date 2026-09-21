---
name: o4e-agent-creator
description: 创建、修改、审查和验证 opencode-for-everything Agent 配置及其 Prompt、权限、工具、Skill、Plan 和委派能力。仅用于 O4E 的 .o4e/ Agent，不用于普通业务 Agent。
---

<!--opencode-for-everything-skill:o4e-agent-creator-->

# O4E Agent Creator

## 先确认边界

1. 读取任务相关的 `AGENTS.md`、`.o4e/README.md`、`config.jsonc`、目标 Agent、同类型 Agent、对应 Prompt 和 Schema。
2. 以 `.o4e/` 为真实源；禁止直接编辑 `.opencode/` 生成物。
3. 先定义职责、非目标、输入、输出、验证标准和权限边界；只有会改变接口、权限或验收标准的歧义才提问。

## 选择最小 Agent 类型

- `all`：可被选择或委派。
- `primary`：只能作为主 Agent；可声明 `plan` 或 `nativeMode`。
- `subagent`：只能通过受管 `task` 委派；process-v1 Workflow 不自动委派，显式 Task Step 仍由主 Agent 调用同一 `task`。
- `system`：只能是 `compaction`、`title`、`summary`。

优先修改已有角色。不要用 Prompt 文字代替 `loadTools`、`loadSkills`、`permission`、`loadAgents` 或 `loadWorkflows` 的真实边界；`permissionOverlay` 只能收紧为 `ask`/`deny`。

## 修改来源

- Agent 配置：`.o4e/agents/{all,primary,subagent,system}/<name>.jsonc`，文件名必须等于 `name`。
- 安装目标 Prompt：`.o4e/prompts/<type>/<name>/system.md`。
- 仓库默认 Prompt：同时维护 `defaults/.o4e/prompts/cn/` 和 `en/`。
- 修改 `systemPrompt`、`injects`、`messagePrompt` 或 `instructionFiles` 时，同步检查对应文件和依赖。
- 检查名称冲突、`nativeMode`、Plan profile、`capabilities` 和 Agent 加载白名单；Workflow 普通 Step 默认主 Agent 执行，显式 `execution.mode:task` 检查目标与独立 Task 授权，不使用旧 `skill`/selector/bindings。

## 验证

按最小范围执行：

```bash
node scripts/installer.mjs build --target /path/to/project
npm test
npm run build -- --target .test
```

只报告实际执行的检查。配置或 Prompt 修改后提醒重新 build，并在生成 Agent、权限或插件变化后重启 OpenCode。

## 评估（仅在明确需要时）

普通修改不要求启动对照 Agent 或写评测文件。只有用户要求评测、重大角色调整或行为无法通过 Schema/测试证明时，才创建 2–3 个场景，比较带 Skill 与 baseline 的输出，并保存可复核的断言和结果。

## 交付

说明职责与非目标、改动的真实源、权限/工具/Plan/委派决定、实际验证、未验证项和残余风险。Plan Profile 只输出实施方案，不编辑文件或执行状态变更。
