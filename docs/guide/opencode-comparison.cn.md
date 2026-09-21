# O4E 与 OpenCode 原生能力对比

[中文](opencode-comparison.cn.md) | [English](opencode-comparison.md)

## 一句话定位

**OpenCode 原生能力解决 Agent 如何使用工具完成任务；O4E 解决多个 Agent 和后台任务如何被组织、约束、恢复和审计。**

O4E（`opencode-for-everything`）是运行在 OpenCode 之上的插件系统，不是另一个 Agent，也不是 OpenCode 的替代品。它复用 OpenCode 的 Session、Tool、权限询问、Host Shell 和插件机制，在此基础上增加 Agent 编排、Task Runtime、Workflow、Scope Lock 和配置生命周期管理。

```text
OpenCode = Agent 宿主与工具运行时
O4E      = Agent 编排与治理层
```

## 总体对比

| 能力 | OpenCode 原生 | O4E 增加或改变的内容 |
| --- | --- | --- |
| Agent 对话 | 提供 Agent、模型和工具调用 | 复用宿主，并增加角色目录、能力和权限治理 |
| 原生 Agent | 支持 `build`、`plan`、`general`、`explore` | 可按 `keep`、`managed`、`disable` 策略保留、接管或禁用 |
| 自定义 Agent | 可配置 Agent | 使用 `all`、`primary`、`subagent`、`system` 布局区分使用边界 |
| Agent 委派 | 原生 `task` 调用 | 受管 `task`，增加候选校验、父链、深度、所有权和权限复核 |
| 后台任务 | 提供宿主级执行能力 | 持久化 Task、状态读取、输出读取、取消、恢复和回执去重 |
| Shell | 使用宿主配置的 Shell 执行命令 | 受管 `bash` 工具将命令纳入 Command Task、权限、日志和生命周期管理 |
| 权限 | 宿主权限规则和用户授权 | O4E 只能收紧宿主权限，并增加 Agent、Task、Scope 和所有权约束 |
| Workflow | 主要由 Agent 自行安排步骤 | 实验性 Beta，默认关闭；显式开启后提供主会话 process-v1 DAG 检查点、Gate、有限修复和显式恢复 |
| Skill / Prompt | 支持宿主目录和配置 | `.o4e/` 统一管理 Prompt、Skill、Soul、Agent 和 Workflow |
| MCP / Tool | 宿主级配置 | 可按 Agent 控制加载的 Tool、MCP、Skill 和委派对象 |
| 模型选择 | 使用宿主已有机制 | default 保留默认/Agent 模型及 fallback 候选，child 冻结目标候选或父模型；模型错误由主 Agent 显式 resolve，不自动切换；clear 仅清除运行时投影 |
| 安装与卸载 | 以手工配置为主 | 提供 install、build、status、import、export 和 uninstall 生命周期 |

## O4E 增加了什么

### 1. 专业 Agent 角色和能力边界

默认角色按工程职责组织，例如：

| 角色 | 主要职责 |
| --- | --- |
| `orchestrator` | 拆解任务、协调子任务并汇总结果 |
| `architect` / `architect (plan)` | 架构设计与模块边界分析；普通 Profile 可实施，Plan Profile 只读 |
| `debugger` | 复现问题、定位根因和实施修复 |
| `tester` | 设计测试、覆盖边界并验证行为 |
| `reviewer (plan)` | 审查代码、架构和回归风险 |
| `researcher (plan)` | 调研资料、比较方案并整理证据 |
| `chat (plan)` | 只读纯对话和需求讨论；源配置名为 `chat` |

Agent 不只是一段 Prompt，还可以声明：

- 能使用哪些工具、Skill 和 MCP；
- 能委派哪些 Agent；
- 是否可以作为主 Agent 或子 Agent；
- 使用什么权限和 Plan Profile；
- 可以继续嵌套多少层委派。

**为什么添加：**仅在 Prompt 中写“你是 reviewer，不要修改文件”不是可靠的权限边界。O4E 将职责约束落实到配置、工具能力、宿主授权和 Runtime 校验中。

**优势：**角色可复用、可审查、可版本管理，也能降低 Agent 误用工具的风险。

### 2. 受控 Agent 委派

O4E 的受管委派流程为：

```text
选择合法 Agent
  → 校验当前身份和父链
  → 校验深度、权限和 Scope
  → 请求宿主授权
  → 创建并持久化 child Task
  → 执行、结算和投递回执
```

额外约束包括：

- 只能选择当前 Agent 被允许委派的对象；
- 子 Agent 不能管理父 Task 或兄弟 Task；
- `permissionOverlay` 只能收紧权限，不能扩权；
- 子任务继承祖先的权限和副作用边界；
- 恢复和再次派发时重新校验身份、权限和所有权；
- `maxDelegationDepth` 限制委派深度，避免无限递归。

**为什么添加：**复杂协作中，模型自行调用 `task` 容易出现越权、任务归属不清和无限嵌套。

**优势：**委派链有明确的身份、边界和生命周期，适合多角色工程协作。

### 3. 持久化后台 Task

O4E 将后台 Agent 工作建模为可管理的 Task，而不是一次性调用：

```text
Task
├── taskID
├── ownerSessionID
├── parent / child 关系
├── 状态与终态
├── 输出和读取游标
├── 权限与 Scope
└── 回执与恢复信息
```

通过 `o4e_task` 可以进行：

```text
status   查看状态
watch    等待多个 Task 的状态事件
inspect  读取有界过程 tail
output   读取最终正文
cancel   请求取消
pending  查询待处理请求
```

**为什么添加：**长任务可能在当前回答结束后仍继续运行，或者在 Session 重载、用户新消息、输出过大和父任务取消时出现状态错乱。

**优势：**长任务可查询、可取消、可恢复、可去重；输出读取也有界，不会把任意大日志直接塞入模型上下文。

### 4. 受管 Host Shell Command Task

O4E 保留 OpenCode 的外部工具名 `bash`，但内部将它作为受管 Host Shell 命令处理。执行链为：

```text
Host Shell 配置
  → 权限询问
  → 资源数量准入与排队
  → 重新授权校验与 Command claim 持久化确认
  → 执行与输出捕获
  → 日志归档
  → 终态结算
```

命令执行遵循 OpenCode `config.shell` 选择生成的 Host Shell Profile，不把命令强行限定为 Linux `/bin/bash`。目标 Shell 的命令语法、参数协议、工作目录和环境行为由宿主 Shell 决定；O4E 不把 PowerShell、`cmd.exe`、Bash 或其他 Shell 互相转换。当前后台执行由 O4E 自己的 `src/command-core/command-execution-port.mjs` 负责，不是对 OpenCode 原生 Bash `ChildProcess` 句柄的直接包装；公开插件 API 当前没有暴露可分离的原生命令句柄。

额外能力包括：

- 短命令直接返回，长命令分离并返回稳定 `taskID`；
- admission、running 和 execution timeout 分离；
- 输出捕获、截断标记、日志和 SHA-256；
- 命令级 `status/watch/inspect/output/cancel`；
- 每个 owner 的命令并发数量上限，不参与 Agent 或其他 Bash 的写范围互斥；
- Session 删除、显式取消和插件释放时的生命周期处理。

**为什么添加：**原生 Shell 调用适合即时命令；工程任务还需要管理长时间编译、测试、扫描、部署前检查和大量输出。

**优势：**Shell 命令和 Agent Task 具有一致的所有权、状态、权限、日志和取消语义。

### 5. 双重权限与 Scope Lock

O4E 不替代 OpenCode 的宿主授权，而是在宿主授权之上增加收紧层：

```text
Agent 能力
  → O4E Runtime 权限
  → Task / Scope Lock
  → OpenCode context.ask
  → 宿主最终授权
```

重要原则：

- O4E 的 `allow` 不能跳过宿主 `context.ask`；
- 子任务不能通过参数伪造所有权；
- `permissionOverlay` 不能扩大祖先权限；
- 无法确认进程停止时不能释放不确定的锁；
- Bash/Host Shell 命令默认按 `unknown-write` 处理。

**为什么添加：**工具权限只能回答“能不能调用”，不能完整回答“谁发起、谁拥有、谁能取消、谁能恢复以及并发时谁持有副作用范围”。

**优势：**将 Agent 身份、任务所有权和副作用范围纳入同一个可验证模型，降低并发写入和越权风险。

### 6. 声明式 Workflow（Beta）

Workflow 属于实验性 Beta，默认关闭，不宣称生产可用。仅在 `.o4e/config.jsonc` 显式设置 `"enableWorkflow": true` 并重建、重启后启用；Agent 权限和定义文件不能代替此开关。Workflow 位于 `.o4e/workflows/`，可以表达：

- DAG 依赖；
- 当前主 Agent 执行的 `work` Step；
- StepReport 与 Gate 验收；
- `command-success`、`task-created`、`task-result` 三种有限事实引用；
- Gate 拒绝后的显式有限修复；
- owner Session 中断和检查点恢复；
- 可选的显式 Task 要求，仍走独立 `task` 授权和生命周期。

例如：

```text
需求分析 → 方案 Gate → 实现 → 验证 Gate
                         └→ 拒绝后显式有限修复
```

**为什么添加：**只靠 Prompt 安排步骤时，模型可能跳过测试、无限重试或在中断后丢失检查点。

**优势：**流程依赖和验收条件可复用、可检查、可恢复，同时不伪装成后台多 Agent 调度器。当前不支持嵌套、Loop、并行主 Step 或主 Session Scope 沙箱；真实 OpenCode 多回合、重启和授权 UI 仍需独立验收。

### 7. 统一配置和安装生命周期

用户维护 `.o4e/`，安装器生成 `.opencode/` 运行时：

```text
.o4e/ 配置源  ── install/build ──>  .opencode/ 运行时
```

`.o4e/` 可以统一保存：

- Agent；
- Prompt；
- Skill；
- Soul；
- MCP；
- Workflow；
- 权限策略；
- 全局 O4E 配置。

**为什么添加：**当 Agent、Prompt、Skill、MCP 和流程分散在多个目录时，难以进行版本管理、审查和安全迁移。

**优势：**配置源和生成物分离，修改后可重新构建，安装、状态、导入、导出和卸载都有统一入口。

## O4E 的核心优势

### 从提示词约束升级为运行时治理

OpenCode 原生主要依赖 Agent 理解 Prompt 并选择工具。O4E 将关键边界下沉到运行时：

```text
合法 Agent
→ 合法工具
→ 合法权限
→ 合法 Task 所有权
→ 合法 Scope
→ 合法恢复
```

Prompt 负责表达角色和意图，Runtime 负责执行边界；二者不是互相替代关系。

### 更适合长任务和多 Agent 协作

原生 OpenCode 很适合即时对话和一次性工具调用。O4E 更适合：

- 多个专业 Agent 并行工作；
- 长时间构建、测试和扫描；
- 需要明确 Gate 的实现流程；
- 需要审计权限和任务归属的团队项目；
- 需要在 Session 生命周期变化后继续管理任务。

### 更容易标准化和审查

团队可以统一规定：

```text
所有调研由 researcher 完成
所有测试由 tester 完成
所有审查由 reviewer 完成
所有写操作经过权限和 Scope 检查
所有长命令进入 durable Command Task
```

这些约定可以进入版本库，经过代码审查，而不是只存在于个人 Prompt 习惯中。

## 代价与边界

O4E 增强治理能力的同时，也会增加系统复杂度：

- 配置、权限、Task、Scope 和恢复路径更多；
- 依赖 OpenCode Plugin API、Session 和 `context.ask`；
- 运行时需要额外进行授权、持久化、日志和状态处理；
- Scope Lock 是进程内协调，不是 OS sandbox、容器或虚拟机；
- O4E 不提供独立 Agent 服务、HTTP/SSE Gateway、远程 A2A 网络或跨主机调度；
- Host Shell 的具体行为由 OpenCode 和当前平台决定。当前 Linux 已有真实生命周期验证；Windows 和 macOS 的启动、编码、进程身份及进程树终止仍需目标平台实机或 CI 验证。平台分支、Mock 测试或 Linux 全量测试通过都不能替代该证据。

因此，简单的一次性任务可以直接使用 OpenCode 原生能力；需要角色分工、长任务、恢复、权限治理或流程 Gate 时，再使用 O4E。

## 如何选择

| 场景 | 建议 |
| --- | --- |
| 快速问答、简单修改、一次性命令 | 使用 OpenCode 原生能力 |
| 单 Agent 的短流程调试 | 原生能力通常已足够 |
| 多个专业角色协作 | 使用 O4E |
| 长时间后台任务 | 使用 O4E Task Runtime |
| 需要主 Agent 可恢复的实现-测试-审查检查点 | 使用 O4E Workflow |
| 需要严格权限、所有权和并发边界 | 使用 O4E |
| 需要独立 Agent 服务或远程多机网络 | O4E 当前不提供 |

## 总结

```text
OpenCode 原生：让 Agent 能做事
O4E：让 Agent 按角色、权限、流程和生命周期可控地做事
```

O4E 的价值不是简单增加一个工具，而是把 OpenCode 扩展成可配置、可治理、可恢复、可审计的 Agent 工程运行时，同时保留 OpenCode 作为唯一宿主和 Host Shell 的原生选择。
