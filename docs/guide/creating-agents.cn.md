# 创建和优化 Agent

[中文](creating-agents.cn.md) | [English](creating-agents.md)

[← 文档中心](../README.cn.md) | [Agent 参考](../reference/agents.cn.md) | [Prompt 字段](../reference/agents.cn.md#prompt-字段)

安装后可以调用 `o4e-agent-creator` Skill 创建、审查和迭代优化 o4e agent。它会引导 agent 从 `.o4e/` 真实源、Schema、相邻角色、项目规则和当前 prompt 出发，而不是直接编辑生成的 `.opencode/` 文件。

可以直接提出任务，例如：

```text
为这个项目新增一个只读 security-auditor，审查认证、权限和敏感数据风险。
```

```text
优化 orchestrator，让实现任务严格依据项目验收规则，并按需加载适用的 Agent 能力或声明式 Workflow。
```

## Skill 工作流

1. 确认 Agent 类型、职责、非目标和验收方式：`all` 可主可子，`primary` 只作主 Agent，`subagent` 只被委派，`system` 仅限固定内部阶段。
2. 阅读对应 Schema、现有 agent、`.o4e/prompts/` 中的已安装 prompt 和适用的项目规则；如果角色需要额外项目契约，再按配置读取对应的 instruction file。
3. 选择工具、Skill、MCP、`permission`、`loadAgents` 和角色化 `loadWorkflows`；prompt 不承担权限控制。`capabilities` 可用于角色说明，但当前 process-v1 Workflow 不按旧 `step.skill` 自动选择 Agent。
4. 修改 `.o4e/agents/`、`.o4e/prompts/` 或 `.o4e/skills/` 真实源。
5. 显式选择 Plan：`mode:self` 只生成 `<name> (plan)`，`mode:child` 保留源 Agent 并额外生成 `<name> (plan)`，省略则不提供 Plan。原生 `plan` 也使用该小写后缀；无后缀 self 名称和历史 `<name> (Plan)` 不接受。源名称不得包含括号，默认只读交集可由 `plan` 对象内的显式配置覆盖。
6. 设计 2-3 个真实场景，覆盖正常任务、权限边界、项目规则冲突、Plan 行为或 Agent-to-Agent 委派。
7. 构建、运行相关测试并根据观察结果迭代。

角色与方法应分开建模：只有需要独立权限或会话边界时才新增 Agent；可复用的单 Agent 方法优先做成按需 Skill；主 Agent 的顺序、依赖、Gate 和恢复可写成 process-v1 Workflow。需要多 Agent 时由主 Agent 显式调用 `task`，仍独立通过授权、深度和生命周期校验；Skill 和 Workflow 都不得绕过 Agent 权限。

Skill 源文件位于：

```text
.o4e/skills/o4e-agent-creator/SKILL.md
```

仓库默认版本及完整方法见
[`o4e-agent-creator` Skill](../../defaults/.o4e/skills/o4e-agent-creator/SKILL.md#先确认边界)。

仓库默认版本还包含初始评测集：

```text
.o4e/skills/o4e-agent-creator/evals/evals.json
```

Skill 和评测场景均可持续人工维护。修改 Skill 或安装器选择后运行：

```bash
node scripts/installer.mjs build --target /path/to/project
```

Builder 会在原位置校验内部 registry 中的默认 Skill；插件直接注册 `.o4e/skills/`，不会生成或覆盖 `.opencode/skills/`。修改 agent、Skill 或权限配置后，需要重启 OpenCode 才能让已加载配置生效。

## 端到端示例：创建 security-auditor

以下示例展示如何从零创建一个只读的 `security-auditor` Agent。

### 第一步：确定类型和职责

- **类型**：`all`（可作为主 Agent 被选择，也可被 orchestrator 委派）
- **职责**：审查认证、权限、敏感数据处理和依赖安全
- **非目标**：不修改代码、不执行构建、不部署

### 第二步：创建 Agent 配置

创建 `.o4e/agents/all/security-auditor.jsonc`：

```jsonc
{
  "$schema": "../../schemas/all-agent.schema.json",
  "name": "security-auditor",
  "description": "审查认证、权限和敏感数据风险，只读不改",
  "systemPrompt": "all/security-auditor/system",
  "loadTools": ["read", "glob", "grep", "question"],
  "permission": {
    "bash": "deny",
    "edit": "deny"
  },
  "loadAgents": [],
  "loadWorkflows": [],
  "plan": {
    "mode": "self",
    "permission": {
      "bash": "deny",
      "edit": "deny"
    }
  }
}
```

### 第三步：创建 Prompt

创建 `.o4e/prompts/all/security-auditor/system.md`：

```markdown
# Security Auditor

你是安全审查专家。你的职责是：

1. 审查认证和授权实现
2. 检查敏感数据处理（密码、token、密钥）
3. 评估依赖安全性
4. 识别潜在的安全漏洞

## 审查清单

- [ ] 密码是否使用安全哈希
- [ ] Token/密钥是否硬编码
- [ ] 输入验证是否完整
- [ ] SQL 注入/XSS 防护
- [ ] 依赖版本是否有已知漏洞

## 输出格式

按风险等级分类报告问题：
- **Critical**：需要立即修复
- **High**：应在发布前修复
- **Medium**：建议改进
- **Low**：可选优化
```

### 第四步：构建并验证

```bash
# 构建运行时
node scripts/installer.mjs build --target /path/to/project

# 检查生成结果
node scripts/installer.mjs status --target /path/to/project
```

### 第五步：测试场景

在 OpenCode 中选择 `security-auditor`，测试以下场景：

1. **正常任务**：「审查本项目的认证实现」
2. **权限边界**：尝试让 agent 修改文件（应被拒绝）
3. **委派测试**：从 orchestrator 委派安全审查任务

### 第六步：迭代优化

根据测试结果调整：
- 修改 prompt 以改善审查质量
- 调整 `loadTools` 以支持更多只读操作
- 添加 `loadWorkflows` 以支持安全审查 Workflow
