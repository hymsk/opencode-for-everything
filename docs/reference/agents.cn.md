# Agent 参考

[中文](agents.cn.md) | [English](agents.md)

[← 文档中心](../README.cn.md) | [配置参考](./configuration.cn.md) | [Workflow 参考](./workflows.cn.md) | [Soul 和 Prompt](./configuration.cn.md#soul-和-prompt)

Agent 配置位于 `.o4e/agents/`。目录决定类型，JSONC 内不得声明 `mode`；
文件名必须与 `name` 一致并全局唯一。源 Agent 名称只使用小写字母、数字和
连字符。

## 四类 Agent

| 目录 | OpenCode mode | 用户可选择 | 可发起委派 | 可作为目标 |
| --- | --- | --- | --- | --- |
| `system/` | 内部阶段 | 否 | 否 | 否 |
| `all/` | `all` | 是 | 是 | 是 |
| `primary/` | `primary` | 是 | 是 | 否 |
| `subagent/` | `subagent` | 否 | 是 | 是 |

`system` 只允许 `compaction`、`title`、`summary`。`all` 和 `subagent` 作为子
Session 运行时可按配置继续委派，每层仍须宿主授权，并继承祖先的权限 Overlay 和 Effect/Scope 限制。

表中的“可发起委派”表示类型允许，最终仍受具体工具与 `loadAgents` 权限约束。默认入口保持 `orchestrator`；默认 `chat` 是只读纯对话角色，使用 self Plan 只生成 `chat (plan)`，不加载工具、MCP、Skill、Agent、Workflow 或角色目录，不能委派和管理任务。专用中英文 Plan 提醒保持相同边界，不引入其他角色或执行流程。

### 子任务执行责任与层级

默认专业角色保持 `subagent` 类型，不出现在主选择器：`architect` 使用 child Plan，生成可实施的 `architect` 和只读 `architect (plan)`；`researcher`、`reviewer` 使用 self Plan，仅生成 `researcher (plan)`、`reviewer (plan)`；`debugger`、`tester` 保持普通模式。调用 `task` 必须使用展开后的准确名称。Plan 默认关闭 MCP，默认有效 Effect 为 read；显式开放执行或未知 MCP 能力后不保证仍为只读，也不保证免于写锁等待。

子 Agent 默认亲自完成任务，不把原任务原样或换句话后整单转交。只有严格更小、结果可独立核验，且有能力或独立证据收益的子问题才值得委派；调用前应说明已有证据、目标能力、保留工作及验收方式。同权限角色不能补足缺失的 shell 或来源，缺少能力时应报告缺口而不是重复转交。

Runtime 在实际子任务请求中提供 `currentDepth`、`maxDelegationDepth`、`remainingDelegationDepth`、`sourceAgent`、`targetAgent` 和 `delegationAllowed`，从已验证父链和冻结授权计算，不采信任务正文中的自报层级。根为 0；默认上限为 2。末层 child Session 的 `task` 权限为 deny，并从其请求工具列表中关闭；非末层和根不受其影响，`o4e_task` 既有管理权限保留。续接仍提供层级说明，但不重发已完成的原任务指令。

整单转交判定是模型行为规则，不是语义相似度安全校验；真正的权限边界是宿主 Session 权限、请求工具投影和 Runtime 的深度检查。默认模板修改不会自动覆盖既有 `.o4e/` 配置或热更新已经加载的宿主。

## Builder 必填语义

Schema 与 Builder 是两层约束。具体 `all`、`primary`、`subagent` 在
Builder 中都必须满足：

- 非空、单行 `description`
- 自身或 `agentDefaults` 提供 core Prompt
- 文件名等于 `name`

Agent 列表排序与默认选择由 OpenCode 管理。O4E 不根据 selector 列表覆盖
宿主默认入口；原生模式别名映射仍按配置生效。需要固定默认入口时，可在 O4E
配置中设置 `defaultAgent`，指向已配置且未被禁用的 `all`/`primary` 或其 Plan
Profile；它会覆盖 OpenCode 的 `default_agent`。省略时仍由宿主管理。

安装目标不保留默认 catalog；具体 Agent JSONC 是 `description` 的真实源。

## 最小示例

### Primary

`.o4e/agents/primary/main.jsonc`：

```jsonc
{
  "$schema": "../../schemas/primary-agent.schema.json",
  "name": "main",
  "description": "Main project agent",
  "base": "You are the main project agent.",
  "loadTools": ["question", "read", "glob", "grep", "task"],
  "loadAgents": ["worker"],
  "loadWorkflows": []
}
```

### Subagent

`.o4e/agents/subagent/worker.jsonc`：

```jsonc
{
  "$schema": "../../schemas/subagent-agent.schema.json",
  "name": "worker",
  "description": "Perform bounded delegated work",
  "base": "Complete the delegated task and report evidence.",
  "loadTools": ["read", "glob", "grep"],
  "loadAgents": [],
  "loadWorkflows": [],
  "capabilities": ["task.general"]
}
```

## Prompt 字段

core Prompt 方案：

- `base`：内联文本
- `systemPrompt`：相对于 `promptsDir` 的 Markdown 路径
- `nativeSystem`：Prompt 名称数组；按声明顺序连接，并保留宿主 marker 后、
  `Instructions from:` 前的动态 tail
- `injects`：可单独构成 core Prompt，也可追加到 `base`/`systemPrompt`

`base`、`systemPrompt`、`nativeSystem` 互斥；`nativeSystem` 不能与
`injects` 同时使用。`messagePrompt` 在每条用户消息阶段注入。

例如：

```jsonc
{ "nativeSystem": ["primary/native/base", "primary/native/policy"] }
```

每项都必须对应 `.o4e/<promptsDir>/<name>.md`。`nativeSystem` 不完整保留宿主
system：Runtime 只保留 O4E marker 后的动态 tail，并移除宿主原有
`Instructions from:` 规则块，再追加受管协议和 instruction files。

如果使用：

```jsonc
{ "systemPrompt": "subagent/reviewer/system" }
```

则必须存在：

```text
.o4e/<promptsDir>/subagent/reviewer/system.md
```

config `agentDefaults` 只供完全省略 core Prompt 字段的 `all`、`primary`、
`subagent` 使用；`system` 不继承。

## 原生模式

只有 `primary` 可声明：

```jsonc
{
  "name": "build",
  "nativeMode": "build"
}
```

`nativeMode` 只接受 `build` 或 `plan`，并且必须与
`config.nativeAgents.<name>: "managed"` 一致。managed `general` 和
`explore` 则必须是同名 `subagent`。

## Plan Profile

Plan 必须显式声明：

```jsonc
{ "plan": { "mode": "self" } }
{ "plan": { "mode": "child" } }
```

| 模式 | 结果 |
| --- | --- |
| `self` | 只生成 `<name> (plan)`，不保留无后缀源 Agent |
| `child` | 保留源 Agent，并额外生成 `<name> (plan)` |

所有 Plan Profile（包括受管原生 `plan`）都必须使用小写 `<name> (plan)`；
无后缀源名称和历史 `<name> (Plan)` 不作为 Plan Profile 接受。持久化状态引用
不存在的 Agent 名称时恢复 fail closed。

默认 Plan permission 收紧直接写入能力，但显式 Plan 配置最后生效，可以
继续收紧，也可以有意重新开放能力：

```jsonc
{
  "plan": {
    "mode": "child",
    "loadTools": ["question", "read", "glob", "grep", "edit"],
    "permission": { "edit": "ask" },
    "loadAgents": [],
    "loadWorkflows": []
  }
}
```

Runtime Safety 最终仍会强制合法委派深度和目标范围，但不会无条件再次关闭
显式开放的 `edit` 或 `bash`。

## 能力与权限字段

| 字段 | 语义 |
| --- | --- |
| `loadTools` | canonical builtin permission 白名单；`null` 不接管，`[]` 全拒绝 |
| `loadSkills` | Skill 名称 allowlist；`["*"]` 不限制，`[]` 全拒绝，具体名称逐项开放 |
| `loadMcp` | MCP 工具白名单；`{"*": ["*"]}` 开放全部，`{}` 全部关闭 |
| `blockTools` / `blockSkills` / `blockMcp` | 逐层累加黑名单，优先于对应白名单和 permission allow |
| `blockAgents` / `blockWorkflows` | 逐层累加委派与 Workflow 黑名单，优先于对应白名单 |
| `permission` | OpenCode `allow`/`ask`/`deny` 规则 |
| `loadAgents` | 可发现和委派的 `all`/`subagent` ID |
| `loadWorkflows` | 可直接启动的 `entry` Workflow |
| `capabilities` | Agent 能力发现使用的稳定点分 Skill ID，不授予权限 |
| `backgroundTasks.maxRetries` | Agent Task 人工 retry round 预算覆盖 |

配置只接受 canonical `edit`；它控制宿主 `edit`、`write` 和
`apply_patch`。`write`、`functions.*` 和 `apply_patch` 不是合法的配置
permission 名称。

`config.loadSkills` 只是 Agent 省略该字段时的默认值。Agent 和 Plan 的显式
数组都是完整覆盖；Plan 省略时继承 Agent。Agent 显式 permission 和 Plan
override 在基础 Skill 策略之后生效，因此可以有意覆盖 allowlist 投影。

`capabilities` 不授予权限。process-v1 Workflow 不再按 Skill/Effect 自动选择和派发 Agent；
显式 Task 要求由主 Agent 调用现有 `task`，保留其 Plan、Effect、Scope 和 Overlay 校验。

## 唯一委派入口 `task`

O4E 注册同名受管 `task` 覆盖普通 LLM 工具调用中的 OpenCode builtin：

- 默认后台执行并返回稳定 `taskID`。
- 只有显式 `background:false` 才同步等待。
- 参数保留 OpenCode Task 卡片字段 `description`、`prompt`、
  `subagent_type`、`background`，并增加 `plan`、`permissionOverlay`、
  `writeScopes`。
- slash-command subtask 走宿主 builtin-only 路径，O4E 在
  `command.execute.before` 拒绝。
- 没有合法目标、权限被拒绝、Overlay 扩权或 Scope 非法时，在创建子
  Session 前失败。

普通委派授权固定为：

```text
task:<target-agent>
```

`permission.task` 可按目标 pattern 收紧为 `ask` 或 `deny`。只有
managed `primary`/`all`/`subagent` 可按配置发起；只有 `all`/`subagent` 可被选中。
`keep` 保留 Agent 身份和配置，不保留 builtin `task`/`bash` 实现，也不因此获得委派权限。

### `permissionOverlay`

```jsonc
{
  "permissionOverlay": {
    "bash": "deny",
    "edit": "ask"
  }
}
```

Overlay 只能使用 canonical permission 名称和 `ask`/`deny`，不能扩大
目标已有权限。受管 `task` adapter 可纠正模型误生成的
`functions.bash`、`functions.write`、`functions.apply_patch`，但核心配置、
Workflow 和 ledger 始终保持 canonical 名称。

嵌套委派会继续应用祖先的 Overlay。继承支持 `*` 的 `ask`、具体权限名称的
`ask` 和通配名称的 `deny`；非 `*` 的 `ask` 通配名称若无法精确表示权限交集，
会明确拒绝，不会忽略祖先限制。

### 嵌套委派与原生交互

当前生效的 `.o4e/config.jsonc` 顶层 `maxDelegationDepth` 由所有 Agent 共用，
默认 2，合法值为 1..5 的整数；修改后按现有流程重新 build 并重新加载 OpenCode，
不承诺热更新。
根 Agent 深度为 0，每次 Agent `task` 加 1；Workflow 主会话 Step 不增加委派深度。
默认允许“根 → 子 → 孙”，
达到上限的 Agent 不能再创建下一层。不建议提高上限，以免增加任务量、成本
和协调复杂度。

每层 Agent 都通过 `task` 创建自己的下级，再用 `o4e_task watch/output` 等待和
读取结果。权限和提问由用户在 OpenCode 根会话的原生提示中处理。为让更深层
请求也显示，执行 Session 在宿主中统一挂到根会话；O4E 仍保存并校验真实的
逐层 owner。Task 卡片可以点击进入对应下级，宿主的“返回父会话”会返回根页面。

祖先的权限、取消、只读和写入范围限制持续有效。后台 Agent Task 等待下级而
暂停时不会因此结束整个任务，下级完成后由 Runtime 受控续接并逐层读取结果。
普通前台 `task` 的调用会等待当前调用结果；这不等同于 Workflow Step 的生命周期。
Workflow Run 是 owner Session 的 process-v1 检查点，不是后台 Task ledger。
主 Agent 使用 `o4e_workflow action:begin/report` 推进，使用 `read/resume` 显式恢复；
不创建执行 Session、不调度或取消 Task，也不进入 `o4e_task` 管理入口。

## `o4e_task`

`o4e_task` 不创建 Task。以下动作和 group、receipt、消息预览协议仅用于 Agent Task：

```text
status | watch | inspect | output | input | resume | cancel | resolve | pending
permission.reply | question.reply | question.reject
```

- 有权限的 managed `primary`/`all`/`subagent` caller 可以管理自己 Session 创建的
  Agent Task Group，且须经宿主 `o4e_task:agent:<action>` 授权。Native `keep` 不因
  Session 所有权而获准；child 不得越级管理自己的父 Task 或兄弟 Task。
- `watch` 在入口冻结所选 Agent 和 Command Task；省略 selector 时冻结 owner 当时两类尚未可靠交付的 pending 集合，可显式选择混合 `taskIDs`，已持久化确认 receipt 的终态 Task 默认排除；显式空 `taskIDs` 选择空集，后续新 Task 不加入。任一新的终态或需处理事件出现即返回，只返回状态。Agent 已消费终态按 receipt 去重；Command 状态事件仅按可信公开 watch 或 canonical source 绑定的原 Bash 终态响应去重，Command 的 status/output 不消费 watch 事件；非终态只有此前公开正文完整交付且 `taskID/status/phase/revision` 匹配时才去重，缺失可靠证据时允许重报。相同事件继续等待，全部所选终态事件已交付则返回 `empty`，显式 selector 也不重复唤醒已消费终态。用户消息和 reader abort 仍可中断等待。省略 `timeoutMs` 或传零时默认窗口 30 分钟，正数显式值最长 1 小时；deadline 固定且不退避，到期返回
   `heartbeat` 或其他可操作结果后，先向用户报告有意义的当前状态，再调用下一次 watch；watch 只返回状态，报告 completed Agent 结果前先调用 output。失败、取消、unknown/interrupted 和显式等待状态不得表述为成功。真实用户消息以及终态/显式等待状态优先。Runtime 不生成合成 heartbeat 进度消息，中间 TUI 可见性取决于宿主。heartbeat 不自动取消或重启。
  `reason: "user-message"`
  表示真实用户消息优先，不表示 Task 被取消。
- `completed` 后通过 `output` 权威读取结果。每次 output 返回正文，保留空白和空输出，仅附必要的截断或日志不完整提示。
- Watch/status 仅状态，不带结果正文或 heartbeat tail；completed Part 的 `metadata.o4eResult` 保留可信有界结构。
- `inspect` 必填 `taskID`；可选非空 `cursor` 最多 512 字符，`direction` 为默认 `"forward"` 或 `"backward"`，`maxBytes` 为 4..8192 的安全整数，默认 1024。Agent 游标只接受当前紧凑格式，最多 120 字符。单数 `cursor` 只用于 inspect；仅存在更早数据时提供 `beforeCursor`。游标不是授权，inspect 不消费回执、不判断完成。
- Inspect 返回紧凑 `taskID`/`status`、可用 `tail`/`cursor` 及可选 `unchanged`/`unavailable`/`gap`，仅预览已验证当前 dispatch/compaction lineage 的公开 assistant 文本、工具名称/状态和安全白名单摘要：`read` 可显示有界工作区相对 `filePath`，`glob`/`grep` 可显示有界工作区相对 `path` 与保守限长 `pattern`；敏感、外部、URL/query-like、畸形或超长值省略，未知工具仍只显示名称/状态。摘要不进入 cursor、不改变授权。每次最多读取 5 页、每页 20 条，不使用缓存或全历史回退；不保证 SDK 超大消息/Parts 下载字节量有界。
- 游标固定 UTF-8 位置并支持追加；源的整个旧公开快照前缀改写、工具状态变化或删除时返回 `gap`，不会跳到新 tail。游标仍不是授权。
- Inspect 显式 `resume:true` 从 caller 父 Session 已持久化的真实 `o4e_task` inspect 响应恢复位置，只取当前工具 `messageID`/`callID` 之前的响应；父历史最多扫描 5 页、每页 20 条，不新增缓存或游标表。不能与 `cursor` 并用；backward inspect 使用最近的 `beforeCursor`，没有更早位置时返回 `unavailable`。
- 首次 forward resume 只有扫尽历史并确认没有旧 anchor 或失败才允许 fresh；无正文/游标的空 `unchanged` 或 queued `not-dispatched` 可以保持首次状态。最新失败/gap、损坏输出、边界不明或位置未找到就达到历史上限时返回 `unavailable`，不回退历史成功或新 tail。不保证多读者 exactly once，并发 pending/running 调用 fail closed。主动省略 `resume` 或设为 false 且不带手工游标会重新取近期 tail，不是 gap 的无损恢复。
- 只有 inspect/watch 接受安全整数 `ioTimeoutMs: 1..60000`（默认 10000 毫秒）。从 tool execute 入口覆盖 recovery、授权、cursor scan、watch 窗口、到期复核和 UI；inspect deadline 为 allowance，watch 为归一化窗口加 allowance，固定不延长。它不是 Task timeout，不取消 child 或共享 recovery；只取消读取等待，已启动的生命周期 Promise 继续被追踪，dispose 仍等待它们。
- receipt 消费事务 admitted 后（含 adapter consuming callback）关闭 deadline，不受 deadline/abort 中断，必须等待并返回实际结果，仍可失败；已 commit 结果不等待最终 best-effort UI metadata。这不是绝对硬 wall-clock 上限，也不能硬限制同步 JavaScript 或 SDK 超大 payload 处理。
- `input`、`resolve` 和交互回复携带最新 `expectedRevision`。
- `input` 默认保持安全的 next-turn 语义：输入先持久化为 `pending` 队列，不会实时注入
  正在运行的 turn。传 `delivery: "steer"` 时，请求宿主将输入持久化并安排到下一次可运行回合；
  仅在宿主确认接纳后才报告 steer，否则回退到队列，返回值明确 `inputDelivery.mode` 和边界。
- `resume` 携带最新 `expectedRevision`，只唤醒可安全重派发的 queued/retry/pending-input
  Task；不确定或取消中的执行不会被重启。`cancel` 仍用于显式终止。
- 所有 Agent Task 模型错误都会保留原因并进入 `waiting_retry_decision`；O4E 不自动模型重试或
  自动切换 fallback。主 Agent 使用最新 revision 显式选择 `resolve continue|restart|stop`，
  候选和错误分类只作诊断。continue/restart 仍复核授权、CAS、取消、Attempt、Scope Lock
  与副作用边界；宿主 provider 内部重试不受插件控制。
- permission/question 默认保留在 OpenCode 根会话的原生提示中，由用户操作。仅用户明确要求代操作当前请求时，才先 `pending` 刷新 revision 后回复；不从任务目标或笼统“继续”推断授权。
- receipt 是至少一次投递，按 `receiptID` 去重。

Agent 和 Command 均使用 `{"action":"cancel","taskID":"…"}` 取消，只传这两个字段。
`reason` 不是任何 `o4e_task` 动作的输入字段，`resolve` 也不接受；
Runtime 自动记录必要的取消诊断。Watch／Command 返回值中的 `reason` 不受影响。

Task 恢复重新验证 canonical `task` 授权、目标、fingerprint、Effect、Scope、
Overlay 和 approval。缺少完整冻结上下文时进入
`unknown/authorization-unverifiable`，只能查询和取消。

### Command Task

`o4e_task` 支持 command 的 `status/watch/inspect/output/cancel/pending`；
`pending` 返回空列表与 `supported:false`。每个 Task 都校验 caller owner index、
当前权限与宿主 `o4e_task:command:<action>` 授权。Watch 默认包含 owner 当前 Agent
和 Command，可显式选择混合 `taskIDs`；其他动作只接受一个 `taskID`。
有权限的 native `keep` root 和受管 child 只可管理自身 command，不因此获得 Agent
管理能力。不支持 command input、retry/resolve/restart 或 permission/question 回复。
Command 不委派模型、不做模型 fallback，也不生成 Agent receipt。受管命令使用
OpenCode 当前配置或平台默认的 Host Shell，不限定为 Linux 或 absolute Bash；命令
语法、参数协议和生命周期边界以 Host Shell 及对应平台的实际验收证据为准。

Watch 默认固定等待 30 分钟、最大 1 小时；状态变化不延长窗口，真实用户消息和
reader abort 可中断等待。Inspect/watch 使用独立 `ioTimeoutMs` 读取预算；取消读取
不取消执行。Inspect 默认读 1024 字节，`maxBytes` 可选 4..8192，可传 `cursor`、
`direction` 或不带手动游标的 `resume:true`。Resume 只读取此前 inspect 位置，不重执行。
预览来自最多 64 KiB 的保留视图，游标绑定 Task/Session/claim 与输出前缀；截断或
前缀变化报告 gap。查看最新一段使用 backward 且不带旧 cursor/resume：

```json
{ "action": "inspect", "taskID": "<returned-command-taskID>", "direction": "backward", "maxBytes": 4096 }
```

Tail 随输出增长；inspect 预览和 watch heartbeat 均不表示命令完成。

Child 执行 Bash 须验证 frozen authority，仍要求 `unknown-write` 权限，但不借用执行 Scope Lock；
不能升级 read/scoped 权限或由模型指定 owner。Agent 之间的写锁及父子生命周期约束保持不变。普通 Host Shell 语法、环境、输出和
取消的完整边界见[command 参考](./configuration.cn.md#managed-bash-and-command-tasks)。

## Effect 与 Scope

| Effect | 推导 |
| --- | --- |
| `read` | 没有可用的 Bash、外部目录、未知写工具或 `edit` |
| `scoped-write` | `edit` 可用且 `writeScopes` 非空 |
| `unknown-write` | Bash/外部目录/未知写工具可用，或 `edit` 没有 Scope |

`writeScopes` 同时验证词法路径和真实路径，拒绝目录逃逸、符号链接逃逸和
现存硬链接目标。`apply_patch` 的 Add/Update/Delete/Move 全部路径在执行前
检查。Bash 和 `execute` 无法静态绑定文件 Scope，因此推导为
`unknown-write`。

## Prompt 与规则

最终 system 由受管 Prompt、injects、可选 Background Task 协议、
instruction files 和 Soul 组装。Skill 只在调用时加载，不授予额外工具、
网络、写入或委派权限。

## 另请参阅

- [配置参考](./configuration.cn.md)
- [Workflow 参考](./workflows.cn.md)
- [创建和优化 Agent](../guide/creating-agents.cn.md)
- [O4E 工程契约](../../SPEC.md)
