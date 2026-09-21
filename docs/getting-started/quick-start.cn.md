# 快速开始

[中文](quick-start.cn.md) | [English](quick-start.md)

[← 文档中心](../README.cn.md) | [项目概览](../guide/overview.cn.md) | [安装指南](../guide/installation.cn.md)

本页介绍如何把 `opencode-for-everything` 安装到一个项目，并在 OpenCode 中使用默认 Agent。手动源码安装和高级选项见[安装指南](../guide/installation.cn.md)。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | 20.12 或更高版本；开发测试环境另见贡献指南 |
| npm | 随 Node.js 安装 |
| OpenCode | 验证基线 `>=1.18.21`，`opencode` 命令已加入 `PATH`；不作逐版本通过保证，不设置版本硬拦截 |
| 受管 `bash` 执行 | 使用 OpenCode 宿主 `config.shell` 选择的 Host Shell；不使用 O4E 自定义 fallback |

项目开发于 Linux，主要在 Linux 上测试，对 Windows、macOS 等其他系统提供基本兼容；完整安装及任务生命周期尚未全面实机验证，不宣称完全支持。

## 安装到项目

```bash
npx @hymsk/o4e install --no-tui --target /path/to/project
```

安装完成后，目标项目会包含：

```text
/path/to/project/
├── .o4e/                # 可编辑配置
│   ├── config.jsonc
│   ├── soul.md
│   ├── agents/
│   ├── workflows/
│   ├── prompts/
│   ├── skills/
│   └── schemas/
└── .opencode/           # 生成的 OpenCode 运行时
    ├── agents/
    └── plugins/
```

如果项目中已经存在 `.o4e/`，安装器会要求显式传入 `--force`。在覆盖已有配置前，建议先阅读[安装指南](../guide/installation.cn.md)和[使用指南](../guide/usage.cn.md)。

## 启动 OpenCode

```bash
cd /path/to/project
opencode
```

OpenCode 会自动发现 `.opencode/` 中的 Agent 和插件；插件再把 `.o4e/skills/` 注册为首个显式 Skill 来源。默认安装会在 Agent Selector 中提供以下主角色：

| Agent | 用途 |
| --- | --- |
| `orchestrator` | 处理需要拆解和协调的一般开发任务 |
| `chat (plan)` | 只读纯对话和需求讨论；源配置名为 `chat` |
| `orchestrator (plan)` | 以默认只读 Plan 权限规划任务 |

专业角色默认都只可委派，不进入主 Agent Selector：`architect` 同时生成可落地实现的普通 Profile 和只读 `architect (plan)`；`reviewer`、`researcher` 只生成 `reviewer (plan)`、`researcher (plan)`；`debugger`、`tester` 保持普通 Profile。`orchestrator` 适合作为一般开发任务的默认入口。安装器默认使用 `o4e-only`，会禁用宿主原生 `build`、`plan`、`general` 和 `explore`；安装时可以改用 `managed` 或逐项选择 `keep`、`managed`、`disable`。

默认启用的 Soul 会在安装阶段直接生成，并使用 `主人` 作为中文默认称呼；英文安装使用 `master`。如需修改称呼或语言，直接编辑 `.o4e/soul.md`。

managed `primary`/`all`/`subagent` Profile（包括 Plan）在最终权限允许时，可以用受管 `task` 发起委派；子 Agent 可继续创建下一层，祖先的权限 Overlay、Effect 和写入 Scope 限制仍须保留。`system` 不能发起委派。`task` 是唯一 Agent 委派入口。日常委派省略 `background`，由 Runtime 后台执行并立即返回；只有用户明确要求同步或前台委派时才设置 `background: false`，最终答复依赖子结果不构成前台理由。Agent Task 的 `o4e_task` 管理允许有权限的 managed `primary`/`all`/`subagent` 管理自己 Session 创建的 Task；child 不得越级管理自己的父 Task 或兄弟 Task。`watch` 默认冻结当前 owner 的 Agent 和 Command Task，也可显式选择单个 `taskID` 或混合 `taskIDs`；空数组选择空集。任一新终态或需处理事件出现即返回，可靠交付过的事件不重复唤醒。一个事件不表示整个集合完成，继续跟踪剩余依赖。

Watch 默认固定等待 30 分钟，显式窗口最大 1 小时；真实用户消息和 reader abort 可中断等待。`watch/status` 只返回状态，报告 completed Agent 结果前用 `output` 读取正文。Output 保留空白和空输出，每次显式读取都返回正文。Heartbeat 不表示完成；再次等待前向用户报告有意义的状态变化。

需要过程预览时，用单 Task `inspect`；可指定 `cursor`、`direction`、`maxBytes`，或 `resume:true` 从此前可信 inspect 响应续读。Resume 仅用于 inspect。源变化或历史不可验证时返回 `gap/unavailable`，不会静默跳到新 tail；inspect 不消费回执或判断完成。Inspect/watch 的独立读取 allowance 不属于 execution timeout。

子任务的 permission/question 默认由用户在 OpenCode 原生根会话提示中处理，父 Agent 报告等待，不复制或代答。只有用户明确要求代为处理当前请求时，才先调用 `pending` 获取最新 revision，再回复或拒绝；已知答案或笼统的“继续”不构成代操作授权。完整参数及恢复边界见[配置参考](../reference/configuration.cn.md#background-task)。

### 直接运行 Command

全局受管 `bash` 已直接创建 command Task，不经过模型委派。`keep` 保留原生 Agent
身份和配置，不保留 builtin 工具实现；宿主权限继续生效，也不因此获得 Agent 委派
或 Agent Task 管理能力。工具名仍为 `bash`，但命令语法必须符合 OpenCode 选定的 Host Shell；
命令原文经宿主权限批准后交给该 Shell，不在 Bash、PowerShell、cmd 等语法间转换。执行继承启动时环境，使用目标 Shell 的启动参数协议，
公开插件 API 不提供其他插件的 `shell.env` hook 分发。


Admission 默认等待 1 秒，开始 running 后另有默认 10 秒窗口，均与默认 120000 毫秒
execution timeout 分开；到期仍 queued/running 时返回 taskID，命令继续执行，用
`o4e_task` 的 watch 跟踪，或显式指定 taskID 管理。Watch 可混合 Agent 与 Command，其他动作只接受单个 taskID。
Command 支持 `status/watch/inspect/output/cancel/pending`；pending 返回空列表与 `supported:false`，无交互、input、retry/restart 或 Agent receipt。

OpenCode 原生 Shell 卡片的捕获和展示由宿主控制；O4E Command Runtime 另行维护自己的有界输出视图和外部日志归档。两者是独立通道，不承诺捕获内容、截断和 UI 展示完全同步。
宿主可能折叠或调整显示，卡片不等于完整文本交付保证。

未截断的普通成功 Bash 直接返回捕获文本，保留空格、换行和空输出；异常、截断或日志不完整
在正文前放置最短明确控制信息。内存视图最多 64 KiB，Bash 模型正文另限 48 KiB/1800 行，
超限返回 tail。完整文本写入仓库外的当前用户私有日志，单条上限 256 MiB，终态结算后保留 24 小时，活动日志受保护；存储失败会明确标记不完整。
需要完整文本时，用获准文件工具按 `logPath` 分段读取；inspect 仅查看保留视图，最新
tail 不表示完成。Reader abort、普通 root owner idle 和根回合 abort 不取消已脱离 command；
根回合 abort 只临时抑制跟踪。附着 Bash 调用方 abort、显式 Task cancel、owner 删除、
受管 child 生命周期终止/取消和 disposal 仍会发起取消。要停止后台命令，使用获授权的
`o4e_task cancel`，不要仅中止对话。
停止或持久化不确定时保锁。进程内协调不是 sandbox，不保证停止 `setsid` 逃逸后代。
完整参数、权限和恢复规则见
[command 参考](../reference/configuration.cn.md#managed-bash-and-command-tasks)。

## 查看安装信息

需要了解当前安装了哪些 Agent 和 Skill 时，可以运行：

```bash
npx @hymsk/o4e status --target /path/to/project
```

`status` 子命令只读取安装状态，不修改目标项目。

## 修改配置

`.o4e/config.jsonc` 是全局配置入口，`.o4e/agents/`、`.o4e/workflows/` 和 `.o4e/prompts/` 分别保存 Agent、Workflow 和 prompt 配置。

常用默认设置包括：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `backgroundTasks` | Agent 4 槽、command 4 槽、`maxRetries: 1` | Agent 槽限制每个父 Session 的直接后台 Agent Task；command 槽限制全局 `bash` 创建的每个 owner/kind lane，不占 Agent 槽，不参与 Scope Lock 写互斥；模型错误不自动重试，主 Agent 以 CAS 显式 resolve；该字段保留对 retry round 的配置兼容 |
| `loadTools` | `null` | 不统一改写宿主工具权限 |
| `loadSkills` | `["*"]` | 不按名称限制 Skill；Agent 未声明时继承此默认值 |
| `soul.enabled` | `true` | 启用跨角色 Soul 上下文 |

修改 `.o4e/` 后重新构建：

```bash
npx @hymsk/o4e build --target /path/to/project
```

构建器会先校验配置，再生成新的 `.opencode/` 运行时。不要直接修改 `.opencode/` 中的生成文件。

## 后续文档

| 主题 | 文档 | 内容 |
| --- | --- | --- |
| 安装方式 | [安装指南](../guide/installation.cn.md) | 交互安装、静默安装和全局安装 |
| 安装维护 | [使用指南](../guide/usage.cn.md) | 状态、备份、恢复和卸载 |
| 全局配置 | [配置参考](../reference/configuration.cn.md) | 配置字段、默认值和优先级 |
| Agent 配置 | [Agent 参考](../reference/agents.cn.md) | 权限、能力、Plan 和委派 |
| Workflow 创建 | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md#建立契约) | Workflow 契约、步骤、Gate 和恢复设计 |
| Prompt 定制 | [Agent Prompt 字段](../reference/agents.cn.md#prompt-字段) | core Prompt、inject、message Prompt 和原生 Prompt |
| Soul | [Soul 和 Prompt](../reference/configuration.cn.md#soul-和-prompt) | Soul 文件、继承策略和热读边界 |
| 模型选择 | [模型选择与运行模式](../reference/configuration.cn.md#模型选择与运行模式) | 宿主模型选择、子任务冻结和 `origin`/`clear` |
| 问题处理 | [故障排查](../troubleshooting/README.cn.md) | 安装、构建和运行时问题 |
