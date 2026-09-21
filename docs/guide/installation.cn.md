# 安装指南

[中文](installation.cn.md) | [English](installation.md)

[← 文档中心](../README.cn.md) | [快速开始](../getting-started/quick-start.cn.md) | [使用指南](usage.cn.md)

`opencode-for-everything` 支持安装到单个项目，也支持安装到 OpenCode 的全局配置目录。npm 是最简单的安装方式；开发、调试或希望审阅实际执行源码时，仍可手动从源码安装。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | 20.12 或更高版本；开发测试环境另见贡献指南 |
| npm | 随 Node.js 安装 |
| OpenCode | 验证基线 `>=1.18.21`，`opencode` 命令已加入 `PATH`；不作逐版本通过保证，不设置版本硬拦截 |

项目开发于 Linux，主要在 Linux 上测试，对 Windows、macOS 等其他系统提供基本兼容；完整安装及任务生命周期尚未全面实机验证，不宣称完全支持。

## 使用 npm 安装

无需永久安装 CLI，直接启动交互安装器：

```bash
npx @hymsk/o4e install
```

跟随提示选择目标范围、Agent、模型、Skill 和 Soul。下文示例使用源码脚本形式，以便明确展示每项操作；使用 npm 时，将 `node scripts/installer.mjs` 替换为 `npx @hymsk/o4e` 即可执行同一命令。

## 手动源码安装

```bash
git clone https://github.com/hymsk/opencode-for-everything.git
cd opencode-for-everything
npm ci
node scripts/installer.mjs install
```

跟随交互提示完成安装。后续源码脚本命令默认在 `opencode-for-everything` 中执行。

## 项目级安装

项目级安装适合希望将 Agent 和 Workflow 配置与代码一起管理的团队。

### 使用默认选项

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project
```

| 项目 | 默认行为 |
| --- | --- |
| 配置目录 | 在目标项目中创建 `.o4e/`。 |
| OpenCode 运行时 | 生成 `.opencode/agents/` 和 `.opencode/plugins/`；Skill 保留在 `.o4e/skills/` 并由插件直接注册。 |
| Soul | 默认启用，并在安装阶段生成已初始化的 `soul.md`；中文默认称呼为 `主人`。 |
| 自定义 Agent | 默认入口为 `orchestrator`；可选主入口为 `orchestrator`、`orchestrator (plan)`、只读纯对话 `chat (plan)`。Chat 无工具、角色发现、委派或 Workflow 能力。默认子 Agent Runtime 名称为 `architect`、`architect (plan)`、`reviewer (plan)`、`researcher (plan)`、`debugger`、`tester`，全部仅可委派。 |
| OpenCode 原生 Agent | 默认预设为 `o4e-only`：`build`、`plan`、`general`、`explore` 均为 `disable`，不接管宿主原生 Agent，并在运行时禁用宿主同名入口。选择 `managed` 时，O4E 会接管对应宿主 Agent，并允许在 `.o4e` 中定制提示词。 |

禁用 Soul：

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project --no-soul
```

### 交互选择

```bash
node scripts/installer.mjs install
```

交互安装用于选择目标范围、原生 Agent 预设、主 Agent、子 Agent、默认 Skill、模型及 Soul。主 Agent 列表只包含可作为会话入口的 `all`/`primary`，子 Agent 列表只包含仅可委派的 `subagent`；两类不会混在同一列表。原生 Agent 先选择整体预设；只有选择 `custom` 时，安装器才逐项设置 `build`、`plan`、`general`、`explore` 的最终策略，其他预设直接生效。模型支持统一、按类型或逐 Agent 选择及 variant；选择沿用宿主时保存 null。默认 `default` 保留这些配置，`clear` 只清除当次运行时投影，不改源文件。

静默安装默认安装全部默认 Skill。精确选择或禁用默认 Skill：

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project \
  --skill=o4e-agent-creator --skill=o4e-workflow-creator
node scripts/installer.mjs install --no-tui --target /path/to/project --no-skills
```

重装会删除内部 registry 中各默认 Skill 的同名目录，重新完整写入选中项并保持未选中项删除；registry 之外的用户自建 `.o4e/skills/` 会保留，且不触碰公共 `.opencode/skills/`。

整体预设和静默安装参数对应如下：

```bash
node scripts/installer.mjs install --no-tui --native-policy=o4e-only
node scripts/installer.mjs install --no-tui --native-policy=managed
node scripts/installer.mjs install --no-tui --native-policy=keep
node scripts/installer.mjs install --no-tui --native-policy=custom \
  --native-build=managed --native-plan=keep \
  --native-general=disable --native-explore=keep
```

也可以重复使用 `--native-agent build=managed` 形式的参数。静默 `custom` 必须明确提供四项策略；交互安装只有在选择 `custom` 后才逐项设置。

安装器会把所选语言的 Agent `description` 写入具体配置，并把所选语言的 prompt 直接复制到 `.o4e/prompts/`。安装器按 catalog 展示顺序选择首个已启用且可作为主入口的 Agent，写入 `defaultAgent`；不会写入 Agent 排序字段，宿主 Selector 的排序仍由 OpenCode 管理。

启用 Soul 时，安装器也会同时生成已初始化的 `.o4e/soul.md`。中文安装默认称呼为 `主人`，英文安装默认称呼为 `master`；后续可直接编辑该文件。

### 已有配置

目标项目已经存在 `.o4e/` 时，静默安装需要显式使用 `--force`：

```bash
node scripts/installer.mjs install --no-tui --target /path/to/project --force
```

`--force` 用于确认重新安装受管配置。执行前应备份需要保留的自定义内容；配置导出和恢复方式见[使用指南](usage.cn.md)。

## 全局安装

全局安装适合希望在多个项目中共享同一套基础 Agent 配置的个人环境：

```bash
node scripts/installer.mjs install --no-tui --global
```

安装器会将配置源写入 `~/.config/opencode/.o4e/`，将运行时文件写入 `~/.config/opencode/`，并在 `opencode.json` 或 `opencode.jsonc` 中注册插件入口。

当前全局安装路径固定为 `~/.config/opencode`。运行时可以解析绝对 `XDG_CONFIG_HOME`，但安装和全局构建尚未跟随该变量迁移目录。使用自定义 XDG 路径时，应优先采用项目级安装。

## 安装中断与恢复

如果安装或导入在写入配置后失败，安装器会保留失败内容，并尽量恢复原有配置和运行时：

| 内容 | 处理方式 |
| --- | --- |
| 失败配置 | 保存在 `.o4e-install-failed-*` 或 `.o4e-import-failed-*` 目录。 |
| 已有受管运行时 | 尝试恢复原有内容。 |

遇到问题时，请保留终端错误信息，并参考[故障排查](../troubleshooting/README.cn.md)。

## 安装后

在目标项目中运行 `opencode` 即可使用已安装的 Agent。需要查看当前安装内容时运行：

```bash
node scripts/installer.mjs status --target /path/to/project
```

修改 `.o4e/config.jsonc` 或重新安装后，请退出并重启 OpenCode，使宿主配置和插件重新加载。

安装目标中各目录的用途和运行时边界见
[`defaults/.o4e/README.md`](../../defaults/.o4e/README.md)。重新构建、导入导出、
备份和卸载方式见[使用指南](usage.cn.md)。
