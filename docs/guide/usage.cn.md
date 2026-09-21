# 使用指南

[中文](usage.cn.md) | [English](usage.md)

[← 文档中心](../README.cn.md) | [安装指南](installation.cn.md) | [配置参考](../reference/configuration.cn.md)

本指南面向已安装 `opencode-for-everything` 的项目。所有命令假定在源码仓库根目录执行，并将 `/path/to/project` 替换为实际项目路径。

## 配置源与生成文件

`.o4e/` 是唯一的 O4E 配置源。`.opencode/` 是由构建器生成、供 OpenCode 读取的运行时文件；不要直接编辑其中由本组件管理的文件。

| 路径 | 用途 |
| --- | --- |
| `.o4e/config.jsonc` | 规则文件、工具、Skill、Soul、Agent/Workflow 加载和 prompt 目录 |
| `.o4e/agents/all/*.jsonc` | 可作为主 Agent 或受管子 Agent 的角色 |
| `.o4e/agents/primary/*.jsonc` | 只能作为会话主 Agent 的角色 |
| `.o4e/agents/subagent/*.jsonc` | 只能作为子 Agent 运行、可按配置继续委派的角色 |
| `.o4e/workflows/*.jsonc` | process-v1 主会话 DAG、结构化 I/O、Gate 与检查点恢复 |
| `.o4e/prompts/` | 安装时选择语言的 prompt 文件 |
| `.o4e/skills/` | 可编辑且由插件直接注册的 Skill 源；不复制到 `.opencode/skills/` |
| `.o4e/config.jsonc` 的 `mcp` / `loadMcp` | 受管 MCP server 与按 Agent 分配的 MCP 工具白名单 |

默认 `default` 模式保留全局 `defaultModel`、Agent `model` 和 `fallbackModels`，
模型可包含 variant。受管子任务优先冻结目标配置候选，未配置时继承父 Session；
候选不会触发自动模型重试或切换，只供诊断和显式 `resolve` 决策。只有 `clear` 清除
当次运行时模型投影及配置候选，不删除源文件。详见
[配置参考的模型选择章节](../reference/configuration.cn.md#模型选择与运行模式)。

完整字段见[配置参考](../reference/configuration.cn.md)、[Agent 参考](../reference/agents.cn.md)和 [Workflow 参考](../reference/workflows.cn.md)。

MCP 默认开放给受管 Agent。宿主已有或在 `config.jsonc` 的 `mcp` 中定义的 server 会按 `loadMcp` 投影；使用 `{}` 或 `blockMcp` 可关闭指定 Agent。配置方式见[配置参考的 MCP 章节](../reference/configuration.cn.md#mcp)。

## 应用配置修改

修改 Agent/Workflow JSON、Schema、工具、Skill 或插件代码后，重新构建并重启 OpenCode：

```bash
node scripts/installer.mjs build --target /path/to/project
```

prompt Markdown、Soul 和受管 instruction files 会在下一次相关 system 组装时重新读取。无法确定改动类型时，也可以重新构建。

## 检查安装状态

```bash
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs status --global
```

项目级状态会检查 `.o4e/` 和生成运行时；全局状态检查全局配置、运行时和插件注册。

## 备份与恢复配置

导出项目的可编辑 `.o4e/`：

```bash
node scripts/installer.mjs export my-config.o4e.tar.gz --target /path/to/project
```

归档只包含 `.o4e/`，不包含可重新生成的 `.opencode/`。归档名必须以 `.o4e.tar.gz` 结尾，且不能保存在待导出的 `.o4e/` 内。导入和导出需要系统提供 `tar`；Windows 优先使用 `%SystemRoot%\System32\tar.exe`。

导入配置后会自动重建运行时：

```bash
node scripts/installer.mjs import my-config.o4e.tar.gz --target /path/to/project --force
```

目标已有 `.o4e/` 时，交互导入会询问是否覆盖；非交互导入需要 `--force`。导入只接受普通、非链接的归档文件，并拒绝 `.o4e/` 外路径、反斜杠路径、链接和特殊文件；请只使用来源可信的归档。全局配置同样支持导入和导出：

```bash
node scripts/installer.mjs export my-config.o4e.tar.gz --global
node scripts/installer.mjs import my-config.o4e.tar.gz --global --force
```

## 卸载运行时

以下**静默卸载**命令仅清理组件生成且可识别的运行时文件，保留 `.o4e/` 和其他项目文件：

```bash
node scripts/installer.mjs uninstall --no-tui --target /path/to/project
node scripts/installer.mjs uninstall --no-tui --global
```

项目级卸载后，可用 `build --target /path/to/project` 从保留的 `.o4e/` 重新生成运行时。

全局卸载还会移除 server plugin 注册，`build --global` 只重建文件，不恢复该注册。保留自定义配置的完整恢复方式是先导出保留的配置，再导入同一归档；全局导入会重建并重新注册插件。使用新的备份文件名，并在执行前检查目标范围：

```bash
node scripts/installer.mjs export retained-global.o4e.tar.gz --global
node scripts/installer.mjs import retained-global.o4e.tar.gz --global --force
```

导出失败时不要继续导入；重启 OpenCode 前可用 `status --global` 检查注册。不要为恢复注册直接用默认 `install --force` 覆盖自定义配置。

交互卸载的“是否保留配置”默认选择“是”，与静默卸载一样保留 `.o4e/`。只有主动选择不保留并确认删除摘要后，才会删除整个配置源；删除前请自行备份。详见 [CLI 卸载说明](../reference/cli.cn.md)。
