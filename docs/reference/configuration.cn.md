# 配置参考

[中文](configuration.cn.md) | [English](configuration.md)

[← 文档中心](../README.cn.md) | [Agent 参考](./agents.cn.md) | [Workflow 参考](./workflows.cn.md) | [Skill 参考](./skills.cn.md)

`.o4e/` 是可编辑真实源，`.opencode/` 是生成物。字段机器约束见
[`defaults/.o4e/schemas/`](../../defaults/.o4e/schemas/)，构建和运行时语义以
`src/runtime-builder.mjs` 为准。

## 配置根

Runtime 按以下顺序选择一套配置根，不做深度合并：

1. 未设置 `o4e_config` 时，`<project>/.o4e/`
2. 未设置 `o4e_config` 时的全局根 `~/.config/opencode/.o4e/`（可由绝对
   `XDG_CONFIG_HOME` 替换其父目录）
3. 显式设置 `o4e_config` 时，仅使用该目录，跳过项目根

项目 `.o4e/` 只要存在就遮蔽默认全局配置。项目配置解析失败、Agent/Workflow
无效或 Prompt 引用缺失时直接 fail closed，不回退到全局配置。

同一配置根内，`config.jsonc` 存在时遮蔽 `config.json`。若选中的
`config.jsonc` 无效，Runtime 不尝试 `config.json`。

## 目录

```text
.o4e/
├── config.jsonc
├── soul.md
├── agents/
│   ├── system/
│   ├── all/
│   ├── primary/
│   └── subagent/
├── workflows/
├── prompts/
├── skills/
└── schemas/
```

四个 Agent 类型目录都必须存在。安装目标不得保留
`agents/default.json[c]`；安装器会把默认 catalog 中选定语言的
`description` 物化到具体 Agent JSONC。

### 默认 Agent

`defaultAgent` 是可选字段，例如 `"defaultAgent": "orchestrator"`。填写时在原生
模式映射后覆盖 OpenCode 的 `default_agent`；省略时不额外指定默认入口。
目标必须是 O4E 已配置的 `all`/`primary` 或其生成的 `<name> (plan)`，不能是
纯子 Agent、不存在的角色或宿主禁用的入口。该字段不控制列表排序或保存上次选择。
安装时按 catalog 展示顺序写入首个已选 `all`/`primary`，通常为 `orchestrator`；
未选择它时使用下一个已选主 Agent。普通 build 不改变该值。

## 最小配置

### Workflow Beta 显式开关

`enableWorkflow` 是顶层布尔字段，默认 `false`，省略同样关闭。Workflow 属于实验性 Beta，不宣称稳定或生产可用。如需试验，在现有 `.o4e/config.jsonc` 合并 `"enableWorkflow": true`，然后重建并重启。Agent 的 `loadWorkflows`、Plan 覆盖或显式权限不能绕过关闭状态。关闭不取消已创建的普通任务，也不删除配置或检查点；定义文件仍接受静态校验。

### 必需字段示例

```jsonc
{
  "$schema": "./schemas/config.schema.json",
  "nativeAgents": {
    "build": "disable",
    "plan": "disable",
    "general": "disable",
    "explore": "disable"
  }
}
```

`nativeAgents` 是 Schema 必填顶层字段。Builder 还要求四个 Agent 类型目录
存在，并且 `primary` 与 `all` 合计至少有一个有效 Agent。

## 顶层字段

| 字段 | 默认与作用 |
| --- | --- |
| `language` | `"zh"` 或 `"en"`；安装器选择一套 Prompt 并扁平化到 `prompts/` |
| `maxDelegationDepth` | `2`；全局 Agent 委派深度上限，只接受 1..5 的整数 |
| `backgroundTasks` | `{ maxRetries: 1, maxConcurrentAgents: 4, maxConcurrentCommands: 4 }` |
| `nativeAgents` | 必填；四个原生 Agent 各用 `keep`、`managed` 或 `disable` |
| `agentDefaults` | 未声明 core Prompt 的 `all`、`primary`、`subagent` 的 Prompt 默认值 |
| `soul` | Soul 文件、启用状态与 `override`/`extend` 继承方式 |
| `instructionFiles` | global/project 规则文件列表 |
| `loadTools` | `null`；不接管 builtin 工具 allow/deny 白名单 |
| `loadSkills` | `["*"]`；Agent 未显式声明时的 Skill 名称 allowlist 默认值 |
| `permission` | 新安装写入 `{ "external_directory": "allow" }`；自定义配置省略字段时归一化为 `{}`，不代表新安装没有目录权限默认值 |
| `mcp` | `{}`；由 O4E 管理的 local/remote MCP server |
| `loadMcp` | `{ "*": ["*"] }`；默认开放全部 MCP 工具，`{}` 显式关闭 |
| `blockTools` / `blockSkills` / `blockMcp` | 黑名单，逐层累加并优先于对应白名单和 `permission.allow` |
| `blockAgents` / `blockWorkflows` | 委派与 Workflow 黑名单，逐层累加并优先于对应白名单 |
| `loadAgents` | `["*"]`；默认发现全部合法 `all`/`subagent` |
| `loadWorkflows` | `["*"]`；config 级默认加载全部 `entry` Workflow |
| `promptsDir` | `prompts`；Prompt 根目录 |
| `agentsDir` | `agents`；Agent 配置根目录 |
| `workflowsDir` | `workflows`；Workflow 配置根目录 |

Agent 显式字段优先。`instructionFiles`、`loadSkills`、`loadMcp`、`loadAgents`
和 `loadWorkflows` 仍按白名单覆盖；`blockSkills`、`blockTools`、`blockMcp`、`blockAgents`、`blockWorkflows` 为黑名单并逐层累加，黑名单优先于任何白名单或 permission allow。

`maxDelegationDepth` 位于当前生效的 `.o4e/config.jsonc` 顶层，由所有 Agent 共用；
这里的“全局”指配置作用范围，不是操作系统级全局安装，也不是 Agent 或
`backgroundTasks` 字段。修改后按现有流程重新 build 并重新加载 OpenCode 生效，
不承诺热更新。
根 Agent 深度为 0，直接子 Agent 为 1，其下级为 2；每次 Agent `task` 加 1。
Workflow 主会话 Step 不增加委派深度，显式 Task 使用同一现有委派入口。
超过配置上限的启动会被拒绝。不建议提高默认值，以免增加任务量、成本和协调
复杂度；硬上限为 5。

降低上限并重新加载后，已超深 Agent 的后续派发、受管 Bash 和 Task 管理会在
授权重验时被拒绝，恢复可能进入保守 `unknown`。已运行模型不会因此立即停止，
其他宿主工具仍受既有权限规则约束。有效深度内的合法 owner 可读取已完成结果，
祖先仍可发起取消。

`loadSkills: ["*"]` 不按名称限制；`[]` 在基础 `skillPolicy` 阶段投影
`skill: { "*": "deny" }`；具体名称数组投影 wildcard deny 和逐名 allow。
Plan 省略时继承 Agent，显式数组完整覆盖。重复名称、旧布尔值以及同时声明
`"*"` 和具体名称都会 fail closed。config hook 随后还会合并 Agent
显式 permission 和 Plan override，因此它们可以有意覆盖该投影。

## 原生 Agent

```jsonc
{
  "nativeAgents": {
    "build": "managed",
    "plan": "managed",
    "general": "keep",
    "explore": "disable"
  }
}
```

- `keep`：保留宿主 Agent 身份和配置，目标中不得存在对应受管 Agent；不保留
  builtin 工具实现。同名 `bash` 和 `task` 覆盖全局普通工具调用，宿主权限仍生效，
  不授予 `keep` Agent 委派或 Agent Task 管理权限。
- `managed`：由 O4E 接管。`build`/`plan` 要求 `primary` 声明匹配的
  `nativeMode`；`general`/`explore` 要求同名 `subagent`。
- `disable`：在宿主配置投影中禁用同名入口，目标中不得存在对应受管 Agent。

四项必须全部显式声明。安装器默认 `o4e-only` 预设将四项设为
`disable`。

## 模型选择与运行模式

未设置 `o4e_mode` 等同于 `default`，保留全部模型配置能力：config 可设置
`defaultModel`、`fallbackModels`，Agent 可设置 `model`、`fallbackModels`。
模型接受 `"provider/model"` 或 `{ "id": "provider/model", "variant": "high" }`。
Agent 模型缺省/null 时继承全局默认；全局也为 null 时沿用宿主。fallback 省略时继承全局，
显式 `[]` 关闭。Plan 继承源 Agent 模型，不单独声明模型字段。

Builder 将配置模型及 variant 写入 Agent frontmatter；默认 config hook 保留声明的候选，
不把 provider 配置覆盖项误作完整模型库；实际模型由宿主请求时解析和验证。用户在消息中显式选择的模型不被 `chat.message` 改写，自动续接
沿用实际消息选择。受管 Agent Task 优先冻结目标配置候选，未配置时冻结父 Session 模型；
恢复不重新吸收配置修改。`fallbackModels` 作为冻结候选数据保留，但 O4E 不在模型错误后
自动模型重试或自动切换 fallback；Command Task 不使用模型。

主会话和 Agent Task 都不会自动消费显式或继承的 `fallbackModels`。候选只供诊断和主 Agent
显式决策；`fallbackModels: []` 表示没有额外候选，用户当前选择保持不变。宿主 provider
内部可能自行重试，这发生在插件控制边界之外。

`o4e_mode=origin` 返回干净宿主投影，不初始化受管 O4E Runtime。`o4e_mode=clear`
仍加载 O4E Agent、权限、Skill、MCP 和工具投影，但在最终 config hook 中删除顶层和
每个 Agent 的 `model`/`variant`，同时关闭内部配置候选和 fallback。宿主仍可使用显式或记忆的选择；`clear` 不修改
`.o4e/`、宿主配置文件、凭据或全局模型库；空字符串不是兼容别名，会 fail closed。

安装后配置说明也汇总了[模型配置边界](../../defaults/.o4e/README.md#配置规则)。

安装后要修改这些取值，可以直接编辑上述 `.o4e/` 源文件并运行 `build`，或使用 [`model` 子命令](./cli.cn.md#模型配置)：它在保留注释的前提下编辑按优先级选定的源文件并重建运行时，校验失败时回滚。

## Canonical Permission

`loadTools` 的当前合法值为：

```json
["question", "bash", "read", "glob", "grep", "edit", "task", "execute", "webfetch", "websearch", "lsp", "todowrite", "skill"]
```

配置中的 `loadTools`、`permission` 和 `permissionOverlay` 只接受 canonical
OpenCode permission 名称：

- 使用 `edit` 控制宿主 `edit`、`write` 和 `apply_patch`。
- `write` 不是合法配置名，Builder 与 Schema 直接拒绝。
- `functions.*` 和 `apply_patch` 也不是合法 permission 名称。
- `loadTools: null` 不接管 builtin allow/deny；`[]` 全部拒绝。
- 宿主未启用 `execute` 或 `lsp` 时，开放 permission 不会创建工具。

受管 `task` 的 adapter 只在普通模型调用边界纠正常见误生成的
`functions.bash`、`functions.write` 和 `functions.apply_patch`。该纠错不会写回
配置或 Task ledger，不构成配置兼容语义。

```jsonc
{
  "loadTools": ["question", "read", "glob", "grep", "task"],
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "external_directory": "deny"
  }
}
```

## Background Task

受管 `task` 是唯一 Agent 委派入口：省略 `background` 或传 `true` 时创建
后台 Agent Task；只有显式 `background:false` 才同步等待。全局受管 `bash` 已是
command Task 的创建入口，直接执行而不委派模型。`o4e_task` 只管理既有 Task，
不创建委派或命令。两种 Task 共享资源调度，但仅 Agent 使用写范围锁；下述 Agent ledger、恢复、交互、receipt
和消息预览仅适用于 Agent Task，watch 集合同时支持 Command。Command 见
[Managed Bash And Command Tasks](#managed-bash-and-command-tasks)。

```jsonc
{
  "backgroundTasks": {
    "maxRetries": 1,
    "maxConcurrentAgents": 4,
    "maxConcurrentCommands": 4
  }
}
```

- `maxConcurrentAgents` 是每个父 Session Agent lane 的并发上限。
- `maxConcurrentCommands` 是每个 owner Session command lane 的并发上限，
  由全局 `bash` 创建的 command Task 使用，不占 Agent 槽；Bash 不因 Scope Lock 阻塞，达到命令数量上限时仍会排队。
- `maxRetries` 只限制 Agent Task `resolve continue|restart` 的额外 retry round。
- 单个 Agent 可用 `backgroundTasks.maxRetries` 覆盖 retry 预算，不能覆盖
  lane 并发上限。

Scheduler 先按 `ownerSessionID` 分组，再按 `agent`/`command` 分 lane。queued
Task 在并发额度内按 `sequence` 顺序准入，不按活动任务的 read/write mode 阻塞或跳过另一类别。
准入顺序不保证全局执行 FIFO；实际写冲突由 `ScopeLockManager` 处理：

- `read` 不持有写锁；根 read 可与写任务并行观察工作区，不提供一致性快照。
- `scoped-write` 锁住规范化 `writeScopes`。
- `unknown-write` 与其他写锁冲突。

同一目录的插件实例在当前 OpenCode JavaScript 进程内共享这些协调对象；单个
实例释放不会清空其他实例的 admission 或锁。它们不是跨进程 lease。

### Ledger 与恢复

canonical Agent Task lifecycle ledger 位于 Task Session 的 `metadata.o4e.task`；
完整冻结委派授权位于同一 Session 的 sibling `metadata.o4e.delegation`。父
Session 保存 Task 引用、sequence、同时包含两者的 recovery envelope、取消
证据和 terminal receipt。receipt 只保存在
`taskRefs[taskID].receipts[]`；扁平 `receiptID`、`receiptStatus` 和
`receiptCreatedAt` 不属于当前结构。每个 Task ref 的 receipt history 最多保留
`TASK_REF_RECEIPT_LIMIT` 条；Task ref map 本身当前没有总数量上限。
receipt 是至少一次投递，调用方按稳定 `receiptID` 去重；业务结果只可在
`completed` 后通过 `o4e_task output` 按持久化 Message/Part 引用读取。
父 Session 的 `watch` 确实返回 terminal Task，或 `output` 成功读取 completed
结果后，Runtime 会按 `receiptID` 将该次工具消费同时持久化到 canonical Task
ledger 和父 `taskRefs[].receipts[]`；重复消费保持幂等，插件重载不会再次安排已
确认 receipt。`watch` 在消费事务 admitted 前的 abort/读取超时、heartbeat、
`reason: "user-message"`，以及失败的 `output` 都不会提前确认 receipt；admitted
后的消费事务必须等待实际结果，见下述读取预算。普通用户回合携带的 receipt 仍在对应父
Assistant 回合成功完成后确认；Assistant error 或中断时保留至少一次重投。
同一目录内的多个插件实例会共享 terminal continuation claim 和已消费 receipt
状态；`watch`/`output` 的 durable acknowledgement 会阻止其他实例再提交对应
continuation。并发提交、响应丢失或父 Assistant error/中断后的重试复用同一
`messageID` 和 synthetic `partID`，不会为同一 receipt 生成彼此独立的父回合
身份。synthetic Message/Part 持久化只停止提交响应重试，不代表 receipt 已消费；
只有父 Assistant 成功完成后才确认 receipt，失败或中断会在没有新用户消息时
重新安排 continuation。
完成先进入非终态 `running/completion-settling`，写入 sibling Delegation 结果
后才提交 terminal ledger。若期间出现宿主 `busy`/`retry` 证据或 Delegation
写失败，Runtime 不发布 receipt，并保守保留 admission 和 Scope Lock。

插件启动不枚举项目全部 Session。查询只恢复当前父 Session 的关系和状态，
不会顺带派发旧 queued Task。新 Runtime 中原父 Session 的第一条真实用户
消息是显式激活点，只派发该 Session 可恢复的 Task。

恢复需要完整 canonical `task` 冻结授权，包括 requester、target、
permission pattern/action/approval、fingerprint、Effect、Scope、Overlay 和
trace。缺失或不匹配时 Task 进入 `unknown/authorization-unverifiable`；它仍
可查询和取消，但不得继续 input、pending reply、retry、fallback、restart、
工具副作用或完成态晋升。已有宿主执行证据时会保守占用 admission 和写锁；
全部相关 Attempt 被证明为 `idle` 或 `missing` 后只释放本地资源，状态仍保持
授权隔离。

Task Session 删除后的恢复使用当前 V1 tombstone/relink 协议：Runtime 先保存
严格 tombstone 描述符，再收敛为新的 canonical ledger；owner 已缺失时 ledger
可以无 `parentID` 保留。该流程不读取旧 migration metadata，也不根据缺失字段
补齐旧语义。

### `o4e_task`

以下为 Agent Task 动作，允许有权限的 managed `primary`/`all`/`subagent` caller 在 owner
Session 中使用，且须经宿主 `context.ask` 授权
`o4e_task:agent:<action>`。Native `keep` 保留 owner Session 也不能管理 Agent Task；
已委派 child 可以管理自己创建的下级 Task，不得管理其自身所属的父 Task 或兄弟 Task。

Agent Task 支持动作：

```text
status | watch | inspect | output | input | resume | cancel | resolve | pending
permission.reply | question.reply | question.reject
```

`watch` 在调用入口冻结当前 owner 可见的选择集合；省略 selector 时冻结当时尚未可靠
交付的 pending Agent 和 Command Task，可显式选择混合 `taskIDs`；已持久化确认 receipt 的 Agent 终态 Task 默认排除；显式
selector 仍可选择它，但已消费的同一终态不再唤醒 watch。`taskIDs: []` 明确选择空集，
后续新建 Task 不会加入该次等待。任一新的终态或需处理事件（permission/question/
workflow/retry 等等待、unknown/interrupted）出现即返回，只返回状态。
Agent 终态按已消费 receipt 去重；Command 状态事件仅按可信公开 watch 或 canonical source 绑定的原 Bash 终态响应去重，Command 的 status/output 不消费 watch 事件；非终态事件只有在此前 watch 公开正文完整交付且
`taskID/status/phase/revision` 匹配时才去重，metadata 本身不构成交付证据。
相同事件继续等待；全部所选 Task 已终态且事件已交付则返回 `reason:"empty"`。
缺失可靠交付证据时允许重报。单个事件不表示整个集合完成，真实用户消息和 reader
abort 仍可中断等待。`watch` 省略 `timeoutMs` 或传 `0` 时使用 30 分钟（`1800000` 毫秒）等待窗口；
正数显式值可指定窗口，最大 `3600000` 毫秒。deadline 固定，不做 watch 退避，
内部检查和进度事件不会延长窗口；新可操作事件
和真实用户消息可提前唤醒。到期对账后返回 `heartbeat`；Agent 必须先向用户
报告有意义的当前状态，再调用下一次 watch。completed 先读取 output；失败、取消、
unknown/interrupted 和显式等待状态不得表述为成功。真实用户消息以及终态/显式等待
状态优先。Runtime 不生成合成 heartbeat 进度消息，中间汇报是否在 TUI 可见取决于
宿主。调用者仍应检查返回状态并继续 watch 尚未完成的依赖，而不是把 heartbeat 当作
结果或自动重启任务。该窗口不取消任务，与下述读取调用预算分开。

只有 inspect/watch 接受 `ioTimeoutMs`：1..60000 的安全整数，默认 10000 毫秒，
是工具调用参数，不是 `backgroundTasks` 配置或 Task 执行超时。预算从 tool
execute 入口开始，覆盖 recovery、授权、cursor scan、watch 窗口、到期复核和
UI 等待。inspect deadline 为该 allowance；watch 为归一化窗口加 allowance，
固定且不随进度或每次 I/O 重置、延长。超时或 caller abort 只取消读取等待，
不取消 child Task 或共享 recovery；已启动的生命周期 Promise 仍被追踪，
dispose 仍须等待它们。

O4E 的 `tool.execute.before` 对 inspect/watch 将 recovery/event drain 留给
上述 execute 预算，不在前置 hook 中重复等待；它们不需要写范围检查或副作用
水印。其他工具和 Task 动作保持原有前置行为。该预算不覆盖宿主或其他插件在
O4E execute 之前的 hooks。

receipt 消费事务一旦 admitted（包含 adapter consuming callback），便关闭
deadline，不再被 deadline/abort 中断；调用必须等事务实际结果，仍可能失败。
已 commit 结果不等待最终 best-effort UI metadata 发布。该预算不是绝对硬
wall-clock 上限：admitted 事务、同步 JavaScript 和 SDK 超大 payload 处理均
可能超过它。

`watch` 和 `status` 只返回状态与必要控制信息，不带结果正文或 heartbeat tail。
`output` 每次返回结果正文，保留空白与空输出，仅附必要的截断或日志不完整提示。
单个 completed Agent 结果须通过 output 权威读取后再报告。Inspect 负责过程预览，
只有 inspect 接受 `resume` 并从此前可信 inspect 响应恢复游标。
同一 completed Tool Part 的 `metadata.o4eResult` 保留有界结构供可信解析，不授予权限；
公开文本被宿主截断或压缩时不得认定事件已完整交付或推进 inspect 恢复位置。

`input`、`resume`、`resolve` 和交互回复使用最新 `revision` 作为
`expectedRevision`。permission/question 默认由用户在 OpenCode 根会话的
原生提示中操作。仅用户明确要求代操作当前请求时，才先调用 `pending`
刷新 revision 后回复；不从任务目标或笼统“继续”推断授权。

`input` 默认只排队到同一 child Session 的下一 turn：它不会实时注入正在运行
的正在运行的 turn。传 `delivery: "steer"` 时，请求宿主将输入持久化并安排到下一次可运行回合；仅在
宿主确认接纳后才报告 steer，否则回退到队列，并在 `inputDelivery` 报告实际模式。`resume` 携带最新
`expectedRevision`，只唤醒可安全重派发的 queued/retry/pending-input Task；不确定
或取消中的执行不会被重启。`cancel` 仍用于显式终止。输入仍受既有 16 条队列及每条
16,384 个字符上限（按 UTF-16 code unit 截断）、CAS revision、终态续跑、fallback/retry 保留和等待
permission/question 时拒绝规则约束。

### 只读 Inspect

`inspect` 不创建或继续委派，不消费终态回执，也不判断 Task 是否完成；
业务结果仍须在 `completed` 后通过 `output` 读取。

inspect 的窗口读取不结算完成或消费回执；工具入口仍复用既有 recovery 和授权
对账，冷启动时可能更新生命周期状态。预览页数及正文预算不约束这些既有
recovery 的历史读取或持久化操作。

`inspect` 只接受单个 `taskID`，不接受 `taskIDs` 或 `timeoutMs`；
`timeoutMs` 仅用于 watch，inspect 的读取期限使用 `ioTimeoutMs`。

| 参数 | 契约 |
| --- | --- |
| `taskID` | 必填非空 Task ID，仍按当前 Session 独立授权 |
| `cursor` | 可选非空字符串，最多 512 字符；单数形式只用于 inspect。Agent 游标只接受当前紧凑格式，最多 120 字符 |
| `direction` | `"forward"`（默认）或 `"backward"`，只用于 inspect |
| `maxBytes` | 返回 tail 的 UTF-8 字节预算，4..8192 的安全整数，默认 1024；只用于 inspect |
| `resume` | 只用于 inspect 的可选布尔值；`true` 自动恢复父 Session 最近预览位置，不能与 `cursor` 并用 |
| `ioTimeoutMs` | 只用于 inspect/watch 的读取 I/O allowance，1..60000 的安全整数，默认 10000 毫秒；deadline 和消费事务例外见上文 |

Plugin 和 Runtime 都校验参数。省略 `resume` 或设为 false 且不带手工游标时
返回近期 tail，这是有意重置读取位置，不是 gap 的无损恢复；带 `cursor` 向前
获取增量，或在返回 `beforeCursor` 时用它配合 `direction:"backward"`
读取更早数据。仅确有更早数据时提供 `beforeCursor`。默认响应为紧凑
`taskID`/`status`、可用的 `tail`/`cursor`，及可选 `unchanged`、
`unavailable`、`gap` 标记；它不是完整 Task ledger。

游标绑定 Task、子 Session、dispatch、run generation 和 Attempt，固定 UTF-8
字节位置，支持文本、Part 和消息追加，不随新内容跳到 tail。校验覆盖被引用
源的整个旧公开快照前缀，而不只是已读字节；前缀改写、工具状态变化或源删除
返回 `gap`。它不是授权，不能越过父 Session 所有权。游标来源或 lineage
无法验证时 fail closed，不猜测历史位置。当前紧凑格式编码绑定字段、偏移和摘要字节，
不增加缓存、状态表或授权能力。

显式 `resume:true` 从 caller 父 Session 已持久化的真实 `o4e_task`
inspect 工具响应恢复各 Task 最近位置；只取当前工具
`messageID`/`callID` 之前的响应，包括同消息中更早的 Part，不取当前及之后的
Part/消息，也不从普通文本或 metadata 猜测游标。父历史最多通过 `messagePage`
扫描 5 页、每页 20 条，不新增缓存或游标/水位表。Backward inspect 只使用
最近预览的 `beforeCursor`，缺失时返回 `unavailable`，不改用该预览的 `cursor`
或更早的成功预览。

首次 forward resume 只有定位当前调用边界、扫尽历史并证明无旧 anchor 或失败
后才可 fresh。空 `unchanged:true` 或 queued `unavailable:"not-dispatched"`
预览在不含 `tail`/`cursor`/`beforeCursor` 时可保持首次状态，但不能遮蔽更早的
anchor 或失败。最新相关调用失败或 pending/running、预览失败/gap、输出损坏或
被压缩、边界无法确认，或尚未确定位置就达到历史上限时返回 `unavailable`，
不能回退历史成功或重新取新 tail。不保证多个读者 exactly once；并发
pending/running 调用 fail closed。

Reader 通过宿主 `messagePage` 每次最多读取 5 页、每页 20 条消息，无缓存，
不回退到全历史读取。只投影已验证当前 dispatch/compaction lineage 的公开
assistant 文本、工具名称/状态和极小安全白名单摘要：`read` 可显示有界、
规范化的工作区相对 `filePath`；`glob`/`grep` 可显示有界工作区相对 `path`
和保守限长 `pattern`。外部路径、疑似敏感、URL/query-like、畸形或超长值
省略，未知工具仍只显示名称/状态；排除其他工具输入、任何工具输出、reasoning
和隐藏 metadata。摘要参与旧公开快照前缀校验，但摘要正文不进入 cursor，也不
改变授权。页数、消息数和返回 tail 字节数有界，但 SDK 仍可能先下载单条
超大消息及其全部 Parts；这不是全路径字节上限，也不限制 Part 数量或单条
消息投影内存。

Agent Task 的 owner 状态副本在对应外层操作完成前等待发布尝试；等待发生在 Task 状态锁之外。
若发布失败，任务已经接受的状态不会回滚或重新执行，当前 Runtime 的任务结果/查询会带
`owner-publication-failed` 诊断。通过当前 owner 的定向恢复成功发布后，该诊断清除。
这不是 Command 的新协议，也不保证 TUI 同帧刷新；底层写入永久不返回时，写操作仍可能等待。

## Managed Bash And Command Tasks

### Shell 与权限边界

全局 `bash` 对普通工具调用生效，包括原生 `keep` 的 `build`/`plan`；它不改变
这些 Agent 的身份和配置，也不绕过宿主权限。执行使用 OpenCode 宿主 `config.shell` 选择的
Host Shell，不限定 Linux 或 absolute Bash，也不使用 O4E 自定义 shell fallback。
这不是 `.o4e/config.jsonc` 字段，不接受模型选择 shell；不回退其他 shell 或 builtin。
使用目标 Host Shell 的启动参数协议、无 PTY、stdin EOF，继承启动时进程环境和正常 Host Shell 行为。
命令内的环境赋值必须使用目标 Shell 语法；公开插件 API 无法分发其他插件的 `shell.env` hook。
此边界不是环境隔离或可执行文件 sandbox。

| Bash 参数 | 当前契约 |
| --- | --- |
| `command` | 必填非空、无 NUL，最多 64 KiB；须通过宿主权限校验 |
| `description` | 必填非空说明 |
| `workdir` | 可选执行目录；省略时使用当前 Session `context.directory`，相对值从该目录解析并 realpath 校验；每次调用独立，不继承前次 cwd；严格 provider 的 nullable `null` 等价于省略，空路径仍拒绝；外部目录须获授权 |
| `timeout` | 可选整数 1..2147483647 毫秒，默认 120000；port 执行时限，不是初始等待、排队或读取时限 |

工具名 `bash` 不限定目标 Shell。Unicode、转义、引号、通配符、展开、赋值、函数、循环、
脚本和多行文本按目标 Shell 的能力和语法解释；Bash 的 heredoc 等写法不能直接视为 PowerShell/cmd 的通用语法。
Parser 只提取权限资源，不增加语法白名单；命令原文交给目标 Host Shell，语法错误也由该 Shell 返回。
可静态解码的 literal 同时检查 canonical resource；动态路径不在授权前执行展开，
不能将静态检查当作文件系统 sandbox。无法识别或没有命令节点的输入按全文授权。

所有受管普通 Agent 和 Plan Profile 的 system prompt 都包含 O4E workspace 上下文。
OpenCode `directory` 是活动工作目录，`worktree` 是仓库/项目规则根；两者不同时不会
互相覆盖。该事实注入不依赖 Agent 是否拥有 `task` 权限，也不改变 native `keep` 或
未匹配 O4E marker 的宿主 system prompt。

### 授权与执行

1. 解析命令并验证 caller authority，创建 Task 或执行前必须完成宿主 `context.ask`。
   Bash 同时授权 raw 与 canonical 的各原子资源，适用的 `external_directory` 资源
   先经 realpath 校验和授权；不能只批准整段复合命令而漏掉其中的原子命令。
2. O4E permission 可以收紧拒绝，不能替代 host 授权；即使 O4E 配置为 `allow`，仍须进入 `context.ask`。只有宿主当前有效规则判定为 `allow` 时才可能无 UI 返回；宿主 `ask`/`deny` 不会被 O4E `allow` 绕过。
   受管 child 验证 live identity、冻结 delegation/Agent Task、
    fingerprint、permission 与 Effect。批准后再次验证 current authority，
    资源 admission 后、claim 前再验证一次。
3. Bash 不获取、借用或恢复执行 Scope Lock，不因可写 Agent 或其他 Bash 的写范围而排队。
    Child 仍须具备可信冻结的 `unknown-write` 权限，不接受模型指定 owner，不升级 read/scoped authority。
    Agent 之间的写锁、父子生命周期及停止确认不变；并发修改同一文件的冲突与命令依赖顺序由调用方协调。
4. 按 owner/kind command lane 准入，canonical ledger 和 owner index 都持久化
   execution claim 后才调用 port。Admission 等待默认 1000 毫秒，开始 running 后
   另有默认 10000 毫秒窗口；到期仍 queued/running 时返回快照与稳定 command
   `taskID`，命令继续执行。两个窗口均与默认 120000 毫秒 execution timeout 分离，
   也不是授权/持久化的端到端时限。

### Command 管理

Agent 和 Command 的取消调用统一为 `{"action":"cancel","taskID":"…"}`，只传这两个字段。
所有动作均不接受 `reason` 输入（包括 `resolve`）；内部取消诊断及 watch／Command 输出的 `reason` 保留。

`o4e_task` 支持 command 的 `status/watch/inspect/output/cancel/pending`；
`pending` 返回空列表与 `supported:false`。每个 Task 都校验 caller owner index、
当前权限与宿主 `o4e_task:command:<action>` 授权。Watch 默认包含 owner 当前 Agent
和 Command，可显式选择混合 `taskIDs`；其他动作只接受一个 `taskID`。
有权限的 native `keep` root 和受管 child 只可管理自身 command，不因此获得 Agent
管理能力。不支持 command input、retry/resolve/restart 或 permission/question 回复。
Command 不委派模型、不做模型 fallback，也不生成 Agent receipt。

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

### Ledger、输出与取消

Command 的独立 `kind: command` ledger 保存在 owner Session 的
`metadata.o4e.commandTasks.refs[taskID].recovery`；这是唯一规范记录，不使用 Agent
normalizer，也不覆盖 owner 的 `metadata.o4e.task` 或 delegation envelope。
不另建 Command Session，因此新命令不会增加普通 Session 列表或 Ctrl+x 子 agent 导航项。
`taskSessionID` 等于 `ownerSessionID`，仅表示存储容器，不是可导航的执行会话。
来源 Session/message/call 身份去重，命令与说明正文留在宿主 Bash Part，ledger 保存引用/hash
而非可重放输入。记录与引用在一次 owner 更新中提交，claim 确认后才执行。
不扫描、迁移或删除历史 Command Session；不符合当前布局的记录拒绝继续处理。
恢复只处理指定 owner，先恢复不确定 Command admission，不创建写锁，
再查询 handle；可重接进程内现有 handle，不重新执行旧 claim，
不跨宿主重启收养 PID，也不按用户消息重建旧命令。已无 live launch 的未提交记录进入
`interrupted/not-submitted`；已 claim 但 handle 缺失时保留 `unknown` 和 Command 资源槽位。

未截断的普通成功 Bash 直接返回捕获文本，保留空格、换行和空输出，不加 Task 状态包装、摘要
或空输出占位。非零退出、异常、截断、日志不完整会在正文前放置明确分隔的最短必要
控制信息，不能仅藏于 UI metadata 或 JSON attachment。原样是各流 UTF-8 解码后的
捕获文本，不包括终端仿真、二进制保真或 stdout/stderr 两个 fd 的真实全局写入顺序。

Retained output view 最多 64 KiB，运行中为 tail，大型终态为 head 加 tail；inspect
仅分页该保留视图。Bash 模型正文采用独立的 48 KiB/1800 行预算；超限保留 tail，
控制信息置于正文前并以空行分隔，为宿主截断保留退出/存档证据。Bash 结构化 metadata
中的 `o4eResult` 预算为 20 KiB，与卡片输出独立；其他 command 动作为 40 KiB。
Metadata 缩减标记 `truncated` 和 `outputView`，不改写预算内的 Bash 模型正文。
完整 UTF-8 文本保存于仓库外当前用户
私有目录（0700），日志文件权限为 0600，单条上限 256 MiB。默认位置在系统临时目录
的 `opencode-for-everything-<uid>-command-logs/` 下，按宿主进程隔离。从终态结算起保留 24 小时，
新建命令日志时惰性清理过期文件；活动日志不得删除，清理可能保守延迟。

上述正文预算为 OpenCode 默认的 50 KiB/2000 行工具截断预留空间；宿主 `tool_output` 配置可使用更低上限，后续宿主或模型截断仍以实际宿主行为为准。

终态前确认写盘；创建、写入、容量、同步或捕获失败会标记日志不完整。`logPath` 是
文件位置，`logBytes` 是已记录文本字节数，`logComplete:true` 才表示完整捕获日志已保存，
`logError` 说明存储失败。运行中 `logComplete:false` 不是完成状态。需要完整文本时，
通过返回的 `logPath` 使用获准的宿主文件工具分段读取；inspect 不读取完整日志。
24 小时保留期过后不能保证路径仍存在。`totalBytes` 与可用 `sha256` 描述已观察原始流；
采集不完整不生成完整 hash。Command ledger 仅保存有界视图和日志信息；原生 Shell Part 的 UI 捕获独立保存。

原生 Shell 卡片独立累积最多 256 MiB 捕获文本，超限保留 UTF-8 完整前缀并明确标记
卡片不完整。附着和后台阶段都合并更新同一 Bash Part 的 `metadata.output`；后台更新
不改变模型已收到的 `state.output`、工具状态、时间或 `o4eResult`。传输 best-effort，
失败不影响执行；宿主可能折叠、trim 或 strip ANSI，不能保证卡片完整送达。
短命令终态正文可直接使用；后台返回仅有状态与 taskID，按需通过 output 读取正文。

独立 inspect/watch reader abort/读取超时只取消读取等待。Bash 返回 queued/running
快照后，其原 reader abort 不取消执行；普通 root owner idle 和根回合的
`MessageAbortedError`/`AbortError` 均保留已脱离命令。根回合 abort 只临时抑制自动跟踪，
下一真实用户回合解除；显式 `follow enabled:false` 则持续生效，普通消息不会解除。
附着 Bash 调用方 abort、显式 Task cancel、owner 删除、受管 child 生命周期终止/取消和
plugin disposal 仍发起 command 取消，execution timeout 仍发起停止。要停止后台命令，
使用获授权的 `o4e_task cancel`，不要把中止根对话当作取消证据。后台运行不提供跨宿主重启恢复。
停止未确认或 canonical/owner 持久化失败时保留 Command admission 与不确定记录，不持有写锁；取消和 disposal 重试
只重试停止证据或持久化，不重执行。协调仅限进程内，不是跨进程 lease 或 OS sandbox；
stop evidence 仅覆盖所属进程组，不保证停止通过 `setsid`/`setpgid` 逃逸的后代。

## MCP

```jsonc
{
  "mcp": {
    "context7": {
      "type": "remote",
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"
      }
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
    }
  },
  "loadMcp": {
    "context7": ["resolve-library-id", "query-docs"],
    "filesystem": ["read_file", "list_directory"]
  }
}
```

local MCP 的 `command` 是非空字符串数组。密钥使用 `{env:VAR_NAME}`，不要
写入配置。O4E 先拒绝受管 server 的工具，再按 Agent 的 `loadMcp` 开放。

## 环境变量

| 变量或占位符 | 当前用途 |
| --- | --- |
| `o4e_mode` | 未设置或为 `default` 时启用 O4E；`origin` 返回干净宿主投影；`clear` 保留 O4E 投影但清除本次最终运行时配置中的顶层和 Agent `model`/`variant`；空字符串和其他值回退为 `default`，同时输出包含该非法值的错误诊断（宿主日志，TUI 可用时弹出警告）。该值在插件实例创建时读取。 |
| `o4e_config` | 显式设置为绝对路径（支持前缀 `~/`）时仅从该目录读取；未设置时默认全局根为 `~/.config/opencode/.o4e/`，并保留项目 `.o4e/` 优先。插件实例内冻结，重新启动 OpenCode（包括新的 `-s` 进程）后才读取新值。 |
| `XDG_CONFIG_HOME` | Runtime 仅在它是绝对路径时用其解析全局配置根；安装器的全局目标仍固定为 `~/.config/opencode`。 |
| `{env:VAR_NAME}` | 在 MCP header 等配置值中读取环境变量，避免把凭据写入文件。 |
| `OPENCODE_FOR_EVERYTHING_DEBUG=1` | 临时启用 O4E 调试日志；日志可能包含项目上下文，脱敏后再共享且不要提交。 |

自定义配置档案时使用 `o4e_config=/绝对路径` 并重新启动 OpenCode；不同配置档案仍共享当前工作区的 Task/锁分区。

## Instruction Files

```jsonc
{
  "instructionFiles": {
    "global": ["<default>"],
    "project": ["<default>", "docs/project-rules.md"]
  }
}
```

global `<default>` 展开为 OpenCode 配置目录的 `AGENTS.md`，project
`<default>` 展开为项目根 `AGENTS.md`。Agent 覆盖时必须给出完整
global/project 对象。

## Soul 和 Prompt

`soul.enabled` 控制共享 Soul 是否启用，`soul.file` 指向配置根内文件，
`soul.inheritMode` 使用 `override` 或 `extend`。仓库默认维护 `soul.zh.md` 和
`soul.en.md`，安装器只把所选语言写为安装目标的 `.o4e/soul.md`。

默认维护指引不要求每次任务更新：只考虑用户明确要求保留或明确表达为长期
适用、跨会话仍有用的个人背景与协作偏好；临时任务、执行授权、项目规则及产品决策不写入。
不确定时跳过。运行时只读取和注入 Soul，不自动提取或
保存偏好，也不提供语义写入拦截。已有 `soul.md` 在构建和重装时保留，更新默认
指引需经用户授权单独修改维护章节，而不是覆盖已有个人内容。

Agent 的 core Prompt、inject、message Prompt 和 `nativeSystem` 字段见
[Agent 参考的 Prompt 字段](./agents.cn.md#prompt-字段)。Prompt、Plan reminder、
instruction file 和 Soul 正文会在对应 hook 边界重读；文件路径、启用状态、
继承策略和 Agent JSONC 仍属于静态 Snapshot。安装目标的布局与注入顺序摘要见
[`defaults/.o4e/README.md` 的 Skill 与 Soul 章节](../../defaults/.o4e/README.md#skill-与-soul)。

## Snapshot 与热读

一个插件实例只加载一次 Runtime Snapshot。以下变化需要重新构建并重启：

- config 和 Agent JSONC
- native Agent 策略、Plan Profile、permission、父 Session 模型冻结和路由
- Workflow 定义
- 插件源码、安装器 Skill 选择和 Skill allowlist

以下正文在下一次相关 hook 中重读：

- system/inject/message Prompt
- Plan reminder
- instruction files
- Soul 文件内容

Soul 的路径、启用状态和继承策略仍属于静态 Snapshot。

## Task 工具展示

顶层 `enable_o4e_task_detail` 为布尔值，默认 `false`。关闭时 `o4e_task` 仅显示 `⚙ o4e_task [参数]` 调用行，不向人类展开返回正文；模型仍通过公开消息转换钩子收到完整有界返回。开启时保留正常详情展示。此开关只影响 `o4e_task`，不更改其他 MCP、自定义工具、原生 `task`、Bash 卡片或宿主全局显示偏好。宿主若隐藏全部工具调用行，仍尊重该选择。

隐藏模式的原始持久化 UI output 为空，完整正文保存在有界且绑定校验的展示 metadata 中，`metadata.o4eResult` 保留。watch／inspect／Workflow 证据核对使用同一模型表示，不把任意 metadata 当作授权或完成证据。宿主压缩、截断与摘要仍生效；已清理输出不恢复，不保证压缩后原文逐字保留。该功能依赖当前宿主的实验性消息转换钩子，升级宿主后应重新验收。

侧栏概览独立于详情开关，见[任务概览](../guide/task-overview.cn.md)。自动跟踪的持久启停及失败恢复见[自动任务跟踪](./automatic-follow.cn.md)。

## 另请参阅

- [Agent 参考](./agents.cn.md)
- [Workflow 参考](./workflows.cn.md)
- [模型选择与运行模式](#模型选择与运行模式)
- [Soul 和 Prompt](#soul-和-prompt)
- [环境变量](#环境变量)
- [生成文件参考](./generated-files.cn.md)
