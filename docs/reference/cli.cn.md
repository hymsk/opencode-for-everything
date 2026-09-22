# CLI 参考

[中文](cli.cn.md) | [English](cli.md)

[← 文档中心](../README.cn.md) | [配置参考](./configuration.cn.md) | [故障排查](../troubleshooting/README.cn.md)

`opencode-for-everything` 提供两个等价的命令入口：

- **源码脚本**：`node scripts/installer.mjs`（开发和调试时使用）
- **包命令**：`o4e`（通过 npm 全局安装或 link 提供，参数与源码脚本完全一致）

一次性使用时运行 `npx @hymsk/o4e <subcommand>`。以下示例采用源码脚本格式，可将 `node scripts/installer.mjs` 替换为 `npx @hymsk/o4e` 或 `o4e`。安装器的 `install --global` 仅选择 OpenCode 全局配置范围，不会把命令全局安装到 npm 环境。

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

## 子命令

| 子命令 | 说明 |
| --- | --- |
| `install` | 安装并构建运行时 |
| `uninstall` | 清理受管运行时；静默和交互默认均保留配置源，交互可明确选择删除 |
| `status` | 只读检查安装状态 |
| `build` | 校验 `.o4e/` 并重建运行时 |
| `export <归档文件>` | 导出 `.o4e/` 为 `.o4e.tar.gz` |
| `import <归档文件>` | 导入 `.o4e.tar.gz` 并重建运行时 |

## 选项

| 选项 | 说明 |
| --- | --- |
| `--no-tui` | 静默模式，不显示交互界面 |
| `--lang=zh` / `--lang=en` | 安装语言，默认 `en`；主要用于静默安装 |
| `--no-soul` | 禁用 Soul；静默安装默认启用 |
| `--target=<目录>` | 项目级目标目录；`--global` 与之互斥 |
| `--global` | 使用全局目标 `~/.config/opencode` |
| `--force` | 覆盖已有 `.o4e/`，或非交互导入时确认覆盖 |
| `--skill=<name>` | `install` 专用；精确安装一个默认 Skill，可重复使用；省略时安装全部默认 Skill |
| `--no-skills` | `install` 专用；不安装任何默认 Skill，不能与 `--skill` 同用 |
| `--native-policy=<o4e-only\|managed\|keep\|custom>` | 安装时选择四个 OpenCode 原生 Agent 的整体预设；默认 `o4e-only` |
| `--native-build=<keep\|managed\|disable>` 等 | 覆盖单个 `build`、`plan`、`general` 或 `explore` 策略 |
| `--native-agent <name>=<strategy>` | 以可重复参数覆盖单个策略，例如 `--native-agent build=managed` |
| `--help`, `-h` | 显示帮助 |

## 参数说明

`status` 和项目级 `build` 必须显式指定 `--target`；静默安装和卸载省略 `--target` 时使用当前目录。`export` 和 `import` 必须紧跟一个非空归档文件路径。每次调用只能选择一个子命令；旧的 `--status`、`--uninstall`、`--build`、`--export` 和 `--import` action 选项不再支持。

不带任何参数运行 CLI 时会显示帮助并正常退出，不会隐式开始安装。执行任何操作都必须显式提供子命令。

`--native-policy`、`--native-*` / `--native-agent`、`--skill` 和 `--no-skills` 只用于 `install`。静默安装中，`custom` 必须为四个原生 Agent 都提供最终策略；交互安装会分别选择默认主 Agent（`all`/`primary`）、子 Agent 源配置（`subagent`）、默认 Skill 和原生 Agent 预设。默认入口为 `orchestrator`；可选入口为 `orchestrator`、`orchestrator (plan)` 和只读纯对话 `chat (plan)`。Chat 不加载工具或其他角色，不能委派或运行 Workflow；专业角色展开后仍只作为子 Agent，其中 `architect` 为 child Plan、`reviewer`/`researcher` 为 self Plan。仅选择 self 主角色时，安装器将展开后的 `(plan)` 名称写入 `defaultAgent`。

## 状态、构建和卸载

`build` 校验配置和内部 managed Skill registry，并生成 `.opencode/agents/` 与 `.opencode/plugins/`，不修改 `.o4e/` 或公共 `.opencode/skills/`。Skill 由插件直接从 `.o4e/skills/` 注册。全局 `build` 不注册插件，注册仅发生在全局安装或导入时。

构建只声明 Effect 和 Bash 解析器等 O4E 直接运行依赖，不执行依赖安装，也不为 `@opencode-ai/plugin` 补入默认版本；SDK 由 OpenCode 在启动时准备。目标 `package.json` 已有的 SDK 和 Effect 声明会保留，不被构建删除或覆盖。仓库开发 SDK 的固定版本不是用户运行目录的版本锁。内网仍需让宿主的包管理器能够访问所需包；声明依赖不等于已安装，也不保证离线就绪。

## 原生 Agent 策略

安装配置中的 `nativeAgents` 固定包含四项：

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

- `keep`：不由 O4E 接管 Agent 身份和配置，也不修改其宿主定义；不保留 builtin
  工具实现，同名 `bash` 和 `task` 仍覆盖全局普通工具调用，宿主权限继续生效，
  且不授予 Agent 委派或 Agent Task 管理权限。Command 边界见
  [配置参考](./configuration.cn.md#managed-bash-and-command-tasks)。
- `managed`：由 O4E 接管对应宿主原生 Agent，并允许在 `.o4e` 中定制提示词；`build`/`plan` 使用 `nativeMode`，`general`/`explore` 使用同名 `subagent`。
- `disable`：不由 O4E 接管，并向宿主投影 `agent.<name> = { "disable": true }`。

构建时会检查四项策略是否全部显式声明，并校验策略和 `.o4e/agents/` 文件是否一致，避免“配置声称保留/禁用但文件仍接管”或“声称接管但文件缺失”。旧配置若省略 `nativeAgents` 或其中任一项，会直接失败；请先补齐四项，不会再从现有 Agent 文件隐式推导。

项目级 `status` 报告 `.o4e/` 和生成运行时；全局状态报告全局 `.o4e/`、运行时和插件注册。

运行时清理只处理带组件 marker、能被安全识别的 Agent、插件和运行时模块。静默卸载（`--no-tui`）保留 `.o4e/` 和其中的 Skill；O4E 从不清理公共 `.opencode/skills/`。

交互卸载的“是否保留配置”默认选中是，接受默认选择会保留整个 `.o4e/`。只有主动选择否、看到删除摘要并完成最终确认后，才删除配置源，包括用户配置、Soul 和自建 Skill；卸载过程不为其创建备份，删除前请自行导出需要保留的内容。

## 导入导出

导出归档只包含目标 `.o4e/`，不包含 `.opencode/`。归档名必须以 `.o4e.tar.gz` 结尾，不能放在待导出的 `.o4e/` 内。导入目标已有 `.o4e/` 时，交互终端会询问；非交互调用需要 `--force`。

导入只接受普通、非链接的归档文件。安装器先把输入归档固定复制到私有临时目录，再对同一副本执行校验和解压；归档成员必须使用 POSIX `/` 分隔，并且只能位于 `.o4e/` 下，符号链接、硬链接、特殊文件和非规范路径都会被拒绝。请只导入来源可信的归档。

导出会使用相同规则校验生成的归档，通过后才替换已有备份；失败时保留原备份。中文和空格文件名受支持；包含冒号、反斜杠、换行或回车、末尾点或空格，以及 Windows 保留设备名的路径不符合归档约束。遇到 `unsupported entry` 时，按错误中的路径重命名后再导出。

导入和导出依赖系统 `tar`。Windows 在 `SystemRoot` 或 `WINDIR` 可用时使用 `%SystemRoot%\System32\tar.exe`；其他平台从 `PATH` 查找 `tar`。

## Agent 布局

V1 只接受 `agents/{system,all,primary,subagent}` 目录结构。安装器和构建器不提供其他布局的迁移或归一化入口；不符合当前 Schema 和目录契约的配置会直接失败。

## 原生 Prompt 同步

安装器会从当前 `PATH` 中的 `opencode` 二进制提取 `build`/`plan` system prompt 和 Plan reminder。生成后的文件是用户配置，可以直接编辑；`.o4e/native-prompt-install.json` 只记录来源和哈希，用于保护用户改写。

最简交互安装命令为 `npx @hymsk/o4e install`。手动源码安装见[安装指南](../guide/installation.cn.md)。参数以命令的 `--help` 输出为权威来源。
