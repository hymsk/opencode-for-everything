# Skill 参考

[中文](skills.cn.md) | [English](skills.md)

[← 文档中心](../README.cn.md) | [Agent 参考](./agents.cn.md) | [Workflow 参考](./workflows.cn.md) | [创建和优化 Agent](../guide/creating-agents.cn.md)

Skill 是可复用的单 Agent 方法，按需加载，不扩大 Agent 权限。Skill 的真实源和运行时来源都是 `.o4e/skills/`。插件的 `config` hook 将当前配置根的 `.o4e/skills/` 置于显式 `skills.paths` 首位，同时保留宿主已有路径和 URL。O4E 不创建、不覆盖、不裁剪也不卸载公共 `.opencode/skills/` 或全局公共 `skills/`。

## 与 Agent 和 Workflow 的区别

| 概念 | 用途 | 权限 | 持久化 |
| --- | --- | --- | --- |
| Agent | 定义权限和会话边界 | 独立权限域 | Session |
| Skill | 可复用的单 Agent 方法 | 继承调用者权限 | 不持久化 |
| Workflow | 主 Agent 的可恢复检查点流程 | 不新增权限；显式 Task 独立授权 | owner Session metadata |

## 受管 Skill

O4E 内部 managed Skill registry 列出安装器维护和 Builder 校验的默认 Skill；它不属于用户 `config.jsonc`。默认包括：

| Skill | 用途 | 使用指南 |
| --- | --- | --- |
| `o4e-agent-creator` | 创建和优化 Agent | [创建和优化 Agent](../guide/creating-agents.cn.md) |
| `o4e-workflow-creator` | 创建和优化 Workflow | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md) |

`build` 和 `status` 使用同一套受管 Skill 校验：目录缺失表示未安装；目录存在但 `SKILL.md` 缺失、marker 或 frontmatter 名称不匹配时直接报错。`status` 只检查 registry 中的默认 Skill，不扫描用户自建 Skill。构建和安装写入前仍校验配置树，拒绝符号链接、硬链接和特殊文件。

## Skill 生命周期

1. **安装**：安装器按 `--skill=<name>` 或 `--no-skills` 将所选默认 Skill 写入 `.o4e/skills/`
2. **定义**：在 `.o4e/skills/<skill-name>/SKILL.md` 中维护 Skill 内容
3. **校验**：运行 `node scripts/installer.mjs build --target /path/to/project` 校验所选受管 Skill 的目录、marker、frontmatter 和文件类型
4. **注册**：插件将当前配置根的 `.o4e/skills/` 置于已有显式 `skills.paths` 之前
5. **加载**：Agent 调用 Skill 时按需加载，不自动注入 system prompt
6. **执行**：Skill 内容临时加载，执行完毕后释放

静默安装默认选择全部默认 Skill。可重复使用 `--skill=<name>` 精确选择，或使用 `--no-skills` 安装空集合。每次安装都会先删除内部 registry 中各默认 Skill 的同名目录：选中的重新完整写入，未选中的保持删除。registry 之外的用户 Skill 目录会被保留。

## Skill 目录结构

```text
.o4e/skills/<skill-name>/
├── SKILL.md              # Skill 主文件（必需）
├── agents/               # 可选：Skill 专用 Agent 配置
├── references/           # 可选：参考文档
├── templates/            # 可选：模板文件
└── evals/                # 可选：评测集
    └── evals.json
```

## 配置 Skill 工具

在 Agent 配置中，`loadSkills` 是 Skill 名称 allowlist：

```jsonc
{
  "loadSkills": ["*"]  // 默认值；不按名称限制
}
```

拒绝全部 Skill：

```jsonc
{
  "loadSkills": []
}
```

只开放指定 Skill：

```jsonc
{
  "loadSkills": ["o4e-agent-creator", "o4e-workflow-creator"]
}
```

具体名称数组投影为 `skill: { "*": "deny", <name>: "allow" }`。
`config.loadSkills` 只是 Agent 省略该字段时的默认值；Agent 显式数组完整覆盖
config，Plan 省略时继承 Agent，Plan 显式数组完整覆盖 Agent。`["*"]` 不能与
其他名称混用，重复名称和旧布尔值会被拒绝。后续显式 `permission` 仍可有意
覆盖基础投影。

## 受管 marker

安装器通过内部 registry 识别自己维护的默认 Skill 名称，并通过 marker 校验已写入内容。registry 中的名称属于 O4E 默认 Skill：安装时同名目录会被完整覆盖或删除。Builder 只校验当前存在的 registry 默认 Skill；其他名称的用户 Skill 仍由插件通过同一 `.o4e/skills/` 来源发现。

marker 由 O4E 默认 Skill 资产自带，并由安装器用于识别受管内容。通用 Skill 的定义、格式和创建方式属于 OpenCode 宿主能力，不由 O4E 另行定义，也不要求添加 O4E marker。

## 最佳实践

1. **单一职责**：每个 Skill 只做一件事
2. **可复用**：Skill 应该可以在多个 Agent 之间共享
3. **不扩权**：Skill 继承调用者权限，不定义自己的权限
4. **文档完整**：SKILL.md 应包含使用方法和示例
5. **评测覆盖**：为关键 Skill 编写评测集

## 另请参阅

- [Agent 参考](./agents.cn.md)：Agent 配置和权限
- [Workflow 参考](./workflows.cn.md)：主 Agent process-v1 检查点流程
- [创建和优化 Agent](../guide/creating-agents.cn.md)：使用 o4e-agent-creator Skill
- [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md)：创建和优化 Workflow
- [生成文件参考](./generated-files.cn.md)：配置源与运行时产物边界
