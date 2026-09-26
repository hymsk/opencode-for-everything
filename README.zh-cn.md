# opencode-for-everything

[![CI](https://github.com/hymsk/opencode-for-everything/actions/workflows/ci.yml/badge.svg)](https://github.com/hymsk/opencode-for-everything/actions/workflows/ci.yml)

> O4E 让您在 OpenCode 中运行一支可配置的 Agent 团队：描述目标，主 Agent 推进工作——把审查、调研和测试设计委派给专业子 Agent，把构建和基准放进后台任务执行，同时在任务运行期间保持对话可用。

**独立项目声明：**O4E 不是 OpenCode 团队官方开发的项目，与 OpenCode 团队不存在隶属关系。

[English](README.md) | [简体中文](README.zh-cn.md) · [用户文档](https://github.com/hymsk/opencode-for-everything/blob/main/docs/README.cn.md) · [规范](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md) · [安全政策](https://github.com/hymsk/opencode-for-everything/blob/main/SECURITY.md) · [贡献指南](https://github.com/hymsk/opencode-for-everything/blob/main/CONTRIBUTING.md)

## 使用场景

- **委派专业工作**：把代码审查交给 `reviewer`、边界测试设计交给 `tester`、证据调研交给 `researcher`——每个角色有自己的模型、工具和权限——不离开对话即可收集结果。
- **任务在跑，对话照聊**：测试、构建和基准作为后台任务执行并显示在侧栏；中途随时插话补充要求或调整方向，不会取消任何任务。
- **组建自己的 Agent 团队**：在 `.o4e/` 中定义角色、Prompt、模型、工具和权限，项目级定制或全局复用；还可以通过内置创建 Skill 以对话方式设计新角色，不必从零手写。
- **跨会话保留上下文**：Soul 只保存您明确要求长期保留的个人背景与协作偏好，支持全局共享与项目级补充，不会自动记忆全部对话。

O4E 不会为子 Agent 赋予额外权限，不自动重试失败的模型，也不把侧栏记录视为已验收结果；插话不会隐式取消后台任务。Workflow 检查点属于实验性 Beta：默认关闭，不具备生产可用性。委派和命令可能调用真实 provider、产生费用并修改文件——见[安全与实施边界](#安全与实施边界)。

## 安装

### OpenCode V2 预览（与上述 V1 安装不同）

当前源码的 V2 能力仅限显式启用的只读状态工具/TUI 命令，以及**空白隔离项目**中的全工具拒绝 Agent 预览；不是 V1 安装或受管委派的替代。先准备独立的 `HOME` 和全部 `XDG_*` 目录（不加载现有全局配置/插件），确认目标项目完全空白且未使用真实凭据。已有有效 `.o4e/` 配置时，可从本仓库构建预览：

```bash
npm run build:v2-preview -- --config-root /absolute/source/.o4e --target /absolute/empty-project
```

生成物含 `.opencode/agents/` 和隔离预览守卫插件；守卫在模型请求前检查有效预览 Agent，并拒绝该 Agent 自身 Session 的权限请求。请仅用上述隔离的 `HOME`/`XDG_*` 启动 OpenCode 2.0.15，不要将生成文件移入已有项目或全局目录；全局同名来源归属、其他插件交互和生产安装尚未验收。V2 `bash`、`task`、`o4e_task`、Workflow、后台恢复均不可用。这里只描述当前源码，**不代表已发布 npm 版本含有这些 V2 改动**。

环境要求：Node.js 20.12+、npm，以及已加入 `PATH` 的 `opencode`。OpenCode 验证基线为 `>=1.18.21`，不表示后续每个版本均已逐一验证。

```bash
npx @hymsk/o4e install
```

跟随交互提示选择安装范围、角色、模型和其他选项，安装器会完成配置生成与运行时构建。完成后，在目标项目启动或重启 OpenCode。

手动源码安装和高级选项见[安装指南](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/installation.cn.md)。

当前源码将 Command 恢复账本放在用户数据目录的独立 O4E SQLite 中，Session 仅保存展示摘要；原生卡片刷新和输出保持不变。该存储改动尚未发布，不能据此推断上述 npm 包已包含它。使用此源码构建时应新建会话，旧 Session recovery 不自动迁移或删除。备份须同时保留宿主数据和 O4E 账本；路径与恢复边界见[Command 配置说明](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.cn.md#command-管理)。

## 使用

### 开始一次任务

在已安装 O4E 的项目目录启动 OpenCode，选择 `orchestrator`，直接说明目标、约束和验收方式。例如：

```text
检查当前登录流程，修复会话过期后页面没有跳转的问题。
先定位原因，再做最小修改并补回归测试。不要提交或推送。
```

主 Agent 可以直接完成简单任务，也可以将独立子问题交给合适的子 Agent。若只希望先讨论方案，选择 `orchestrator (plan)`，或者明确要求“先分析，不修改”。

### 委派专业子 Agent

您可以让主 Agent 判断如何分工，也可以明确指定职责和边界：

```text
请让 reviewer 在后台只读审查本次改动，重点检查兼容性和测试缺口。
你继续整理使用说明，不要与审查任务重复修改文件。
```

主 Agent 通过受管 `task` 创建委派，再通过 `o4e_task` 跟踪状态和读取结果。工具名称不是 Shell 命令，日常使用只需自然语言表达意图。

子 Agent 遇到权限请求或问题时，按 OpenCode 的原生提示处理。授权、嵌套深度和可用工具仍受配置限制；指定角色不会自动赋予额外权限。

### 默认角色

主 Agent 是您直接对话的入口。默认主入口为 `orchestrator`：

| 主入口 | 用途 |
| --- | --- |
| `orchestrator` | 推进实施、组织分工、跟踪结果 |
| `orchestrator (plan)` | 只读分析和规划，不实施修改 |
| `chat (plan)` | 纯对话，不加载工具、委派或 Workflow |

专业子 Agent 由主 Agent 按需委派，不进入主 Agent Selector：

| 子 Agent | 用途 |
| --- | --- |
| `architect` | 架构设计，并在明确要求时落地实现 |
| `architect (plan)` | 只读架构分析与实施方案 |
| `debugger` | 复现问题、定位根因与修复故障 |
| `tester` | 设计测试、执行验证并报告证据 |
| `reviewer (plan)` | 独立审查代码与架构，识别风险 |
| `researcher (plan)` | 只读调研与证据核实 |

角色和能力可以自行配置，不局限于默认分工。默认安装采用 `o4e-only` 预设，禁用 OpenCode 原生 `build`、`plan`、`general`、`explore` 入口；需要保留或接管时，可选择其他[原生 Agent 策略](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/cli.cn.md#原生-agent-策略)。

### 查看任务与输出

侧栏按 **Bash** 和 **Subagents** 展示当前 Session 直接拥有的任务。点击任务行进入详情，点击 `View all` 查看完整列表；已结束的任务可能从侧栏隐藏，但仍可在完整列表中查看。

键盘用户可以从命令面板打开：

| 命令面板入口 | 内容 |
| --- | --- |
| `O4E: View Bash tasks` | Bash 任务列表与输出 |
| `O4E: View subagent tasks` | 子 Agent 任务状态与详情 |
| `O4E: View Workflows (Beta)` | 当前会话的 Workflow 检查点；仅显式开启后可用 |

Bash 列表左侧显示命令前缀，右侧对齐显示状态、阶段与退出码。常用操作如下：

| 界面 | 操作 |
| --- | --- |
| 任务列表 | 上下选择任务，Enter 打开，左右翻页；Bash 搜索匹配实际展示的编号与命令前缀 |
| Bash 输出详情 | 左右切换任务，上下按屏滚动，`r` 刷新，`b` 返回列表 |
| 子 Agent 详情 | 上下选择操作，Enter 执行；可打开经校验的执行 Session |
| 列表与详情 | Esc 关闭 |

界面显示的是已同步记录，不是结果验收证明。需要确认任务是否结束、获取完整可用结果时，可以直接说：

```text
检查刚才的后台任务是否完成，读取结果后再汇总。
如果失败，说明原因，不要自动重新执行。
```

更多交互与显示边界见[任务概览](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/task-overview.cn.md)。来源缺失或疑似敏感的命令前缀会省略，但这不是完整脱敏，输出仍可能包含秘密。

### 插话、停止跟踪与取消

后台任务运行时，可以继续向主 Agent 补充要求或安排不冲突的工作。新消息优先处理，不会自动取消已有后台任务；主回合自然空闲后，自动跟踪可以恢复协调。

这两类要求含义不同：

| 您的意图 | 示例 |
| --- | --- |
| 暂停关注，任务继续执行 | “停止跟踪这个后台任务，但不要取消。” |
| 停止任务执行 | “取消刚才的测试任务，并确认停止结果。” |

**停止跟踪不等于取消，关闭详情也不等于取消。** 取消是否成功需要核对返回结果；持久化记录不代表宿主重启后可以重放旧命令或重新接管旧进程。

### 选择启动模式

通过环境变量 `o4e_mode` 选择本次启动方式，无需卸载插件或改写配置文件：

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `default`（未设置时默认） | 启用 O4E，保留配置中的模型与 Agent 能力设置 | 日常使用 |
| `origin` | 不初始化受管 O4E Runtime，返回干净的宿主配置投影 | 临时使用原生 OpenCode，或对比排查 O4E 的影响 |
| `clear` | 保留 O4E 能力，移除本次最终运行时配置中顶层及各 Agent 的 `model` / `variant`，停用内部配置候选 | 暂时不使用配置中指定的模型，改用宿主选择 |

在目标项目目录启动，以下为 Bash / Zsh 写法：

```bash
# 默认模式；未设置 o4e_mode 时直接运行 opencode 也相同
o4e_mode=default opencode

# 原生模式
o4e_mode=origin opencode

# 保留 O4E，但清除本次运行时的配置模型指定
o4e_mode=clear opencode
```

`clear` 不删除模型、凭据或宿主保存的模型偏好，也不重置会话已经选择的模型；宿主仍可能采用显式或记忆的选择。`origin` 不是卸载，也不会关闭其他插件。

模式在插件实例创建时读取，切换后需要重新启动 OpenCode；取值使用上述小写名称，空字符串及其他值会回退为 `default` 启动，同时输出包含该非法值的错误诊断（宿主日志，TUI 可用时弹出警告）。

还可以通过 `o4e_config` 选择另一套配置，与启动模式组合使用：

```bash
o4e_config=/absolute/path/to/.o4e o4e_mode=default opencode
```

显式指定后只从该目录读取配置；未指定时保留项目 `.o4e/` 优先、全局配置作为默认来源的规则。配置路径须为绝对路径（支持 `~/` 前缀），修改后同样需要重新启动；切换配置不提供独立的任务或锁隔离。详细语义见[环境变量参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.cn.md#环境变量)。

### 试用 Workflow（Beta，显式开启）

**Workflow 属于 Beta，不是稳定或生产可用功能。** 默认关闭，省略配置字段也不会启用。如需试用，在 `.o4e/config.jsonc` 中显式设置：

```jsonc
{
  "enableWorkflow": true
}
```

将此字段合并到现有配置，不要替换整个文件；重建目标并重启 OpenCode。`loadWorkflows`、Agent 权限及 Workflow 定义文件本身均不能代替此开关。设为 `false` 可重新关闭，但不会取消已经创建的 Agent 或 Bash 任务。

显式开启后，再配置 Workflow 并让主 Agent 查看实验性流程入口：

```text
查看当前可用的 Workflow。如果有适合本次任务的流程，说明输入要求，
按流程逐步执行；没有合适的流程就直接处理，不要虚构流程名称。
```

主 Agent 使用 `o4e_workflow` 创建和推进检查点，亲自执行步骤并提交报告。Gate 校验声明的 Schema 与受支持的事实引用，只有接受的结果才能推动后续步骤。它不是后台调度器，也不证明所有专业结论或文件声明正确。

用户插话后，需要主 Agent 结合新指令显式恢复流程；暂停或停止 Workflow 不会同时取消已创建的 Task。流程定义及完整操作见 [Workflow 参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/workflows.cn.md)。

## 配置

`.o4e/` 是可编辑配置源，`.opencode/` 中本组件管理的文件是生成物，不要直接修改。

| 路径 | 配置内容 | 详细说明 |
| --- | --- | --- |
| `.o4e/config.jsonc` | 加载规则、模型、权限、MCP 与 Soul 设置 | [配置参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.cn.md) |
| `.o4e/agents/` | Agent 角色、Plan Profile 与能力分配 | [Agent 参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/agents.cn.md) |
| `.o4e/workflows/` | 步骤、依赖、输入输出 Schema 与 Gate | [Workflow 参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/workflows.cn.md) |
| `.o4e/prompts/` | 安装所选语言的 Prompt | [配置参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/configuration.cn.md) |
| `.o4e/skills/` | 插件直接加载的 Skill | [Skill 参考](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/skills.cn.md) |
| `.o4e/soul.md` | 启用 Soul 时的个人上下文 | [使用指南](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/usage.cn.md) |

修改 Agent、Workflow 配置或运行时代码后，在 O4E 源码目录重新构建并重启 OpenCode：

```bash
node scripts/installer.mjs build --target /path/to/project
```

全局安装使用 `build --global`。Prompt Markdown、Soul 和受管 instruction files 会在下一次相关 Prompt 组装时重新读取。更多维护操作见[使用指南](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/usage.cn.md)；创建新角色见[创建 Agent](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/creating-agents.cn.md)。

## 安全与实施边界

- **委派和命令可能调用真实 provider、产生费用，并修改文件或外部系统。** 请核对权限请求，不把 Prompt 或 Workflow 当作沙箱。
- Agent 能力由宿主权限和 O4E 策略共同决定，黑名单优先于白名单。Agent 之间的 Scope Lock 只做进程内协调，不提供 OS 隔离或跨进程租约。Bash 不参与写范围互斥，仅受命令并发数量上限约束；并发文件冲突和命令依赖顺序由调用方协调。
- 后台 Agent Task 遇到模型错误时等待显式重试决策，O4E 不自动重试模型或切换 fallback 候选；provider 内部重试不在此控制边界内。
- O4E 仅支持 OpenCode，不提供独立 Agent 进程、HTTP/SSE Gateway 或远端 A2A 网络。

## 兼容性与验证

O4E 开发于 Linux，主要在 Linux 上测试；对 Windows、macOS 提供基本兼容，完整安装与任务生命周期尚未全面实机验证。开发和测试使用 Node.js 24。

完整宿主生命周期、崩溃恢复及跨平台验收仍有未完成项。dispose 夹具中的模块现象不能直接证明正常宿主退出后任务残留或旧插件被复用，也不代表已修复。要求与验证范围见 [SPEC](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md)，诊断说明见[故障排查](https://github.com/hymsk/opencode-for-everything/blob/main/docs/troubleshooting/README.cn.md)。

## 文档与贡献

- [文档中心](https://github.com/hymsk/opencode-for-everything/blob/main/docs/README.cn.md)：全部使用和参考文档。
- [O4E 与原生 OpenCode 对比](https://github.com/hymsk/opencode-for-everything/blob/main/docs/guide/opencode-comparison.cn.md)：能力与职责边界。
- [贡献指南](https://github.com/hymsk/opencode-for-everything/blob/main/CONTRIBUTING.md)：开发、验证及提交约定；修改实现前先读 [AGENTS.md](https://github.com/hymsk/opencode-for-everything/blob/main/AGENTS.md) 与 [SPEC.md](https://github.com/hymsk/opencode-for-everything/blob/main/SPEC.md)。
- [安全政策](https://github.com/hymsk/opencode-for-everything/blob/main/SECURITY.md)：安全问题报告方式。

## 许可证

[AGPL-3.0-or-later](LICENSE)。
