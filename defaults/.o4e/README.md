# `.o4e` 配置目录

`.o4e/` 是安装目标的可编辑真实源。修改配置后重新构建
`.opencode/`；不要直接维护生成文件。

## 目录

**Workflow 为实验性 Beta，默认关闭，不宣称生产可用。** 仅在 `config.jsonc` 显式设置 `"enableWorkflow": true` 并重建、重启后试用；`loadWorkflows` 或权限配置不能代替此开关。关闭不会取消已有普通任务或删除检查点。

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
├── schemas/
└── example/
```

四个 Agent 类型目录都必须存在。`primary/` 与 `all/` 合计至少包含一个
可选择 Agent；其他目录允许为空。安装目标不保留
`agents/default.json[c]`，每个具体 Agent JSONC 才是 `description` 的真实源。

## 构建

在组件源码目录执行：

```bash
node scripts/installer.mjs build --target /path/to/project
node scripts/installer.mjs status --target /path/to/project
```

配置、Agent、Workflow、权限或插件变化后需要重新构建并重启 OpenCode。
Prompt、instruction file、Plan reminder 和 Soul 正文会在下一次相关组装时
重读。

运行时环境变量：`o4e_mode` 未设置或为 `default` 时启用 O4E；`origin` 使用干净的
OpenCode 投影；`clear` 保留 O4E 能力，但从本次最终运行时配置中清除顶层和 Agent 的
`model`/`variant`。空字符串和其他值拒绝加载。模式不会修改 `.o4e/`、凭据或宿主模型库。`o4e_config` 显式
设置为绝对路径（支持 `~/`）时只读取该配置目录；未设置时项目 `.o4e/` 优先，
默认全局目录为 `~/.config/opencode/.o4e/`。变量在一次 OpenCode 进程内固定，
修改后须重新启动；`opencode -s` 作为新进程按当前变量读取。

## 配置规则

新安装默认 `permission: { "external_directory": "allow" }`，使有读取能力的角色
可以直接读取和搜索任务相关的外部目录。它只是路径门禁，不授予写入或执行能力；
Plan 保留目录许可，默认仍禁止写入和执行。实际编辑、构建和测试须在角色能力与任务
授权内完成，无需逐步重复确认；删除、发布、推送、凭据修改仍需相应授权。

`config.permission` 是未声明 Agent permission 时的默认值；Agent 的显式 permission
完整覆盖它，Plan 显式配置与收紧 Overlay 仍按既有顺序生效。构建不会改写已有配置；
不要使用覆盖安装来迁移权限限制。权限 pattern 支持宿主的 `~`、`~/` 和 `$HOME` 前缀
展开，仍按最后匹配规则生效，先写通用规则再写具体规则。目录名本身不等于其后代通配路径。

`question` 只澄清需求，不等于真实 `permission.reply`，也不扩大 child 的冻结权限或
`writeScopes`。显式 `ask` 使用真实 pending permission 流程，`deny` 不得通过问答或
重新委派绕过。父 Session 的目录批准不会自动写入 child 权限。配置重建后也不静默
扩张旧 Agent Task 的授权；授权发生变化的 Agent 任务须按当前用户指令重新委派。

- `config.nativeAgents` 必须显式声明 `build`、`plan`、`general`、`explore`。
- `keep` 保留宿主原生 Agent 身份和配置，不保留 builtin 工具实现；同名 `bash`
  和 `task` 覆盖全局普通工具调用，宿主权限仍生效，且不授予 `keep` Agent 委派
  或 Agent Task 管理权限。`managed` 要求存在匹配的受管 Agent；`disable` 禁用
  宿主同名入口。
- 配置态工具和 permission 使用 canonical 名称。文件修改统一配置为
  `edit`，它控制宿主 `edit`、`write` 和 `apply_patch`；`write` 不是合法的
  `loadTools`、`permission` 或 `permissionOverlay` 名称。
- `loadTools: null` 表示不接管 builtin allow/deny 白名单，`[]` 表示全部
  拒绝。`execute` 只在宿主启用实验性 Code Mode 时存在。
- `loadTools` 数组以通配 `deny` 关闭未列出工具；后续 Skill、MCP、委派和显式
  permission 可按既有顺序开放能力。目录和循环门禁未配置时保留 `ask`。
  没有关闭隐式执行或未知工具的 Agent 保守视为 `unknown-write`，不能冒充只读。
- 默认受管 Skill registry 由 O4E 内部维护，不属于用户 `config.jsonc`；安装器的
  `--skill=<name>` 与 `--no-skills` 只控制本次安装物化哪些默认 Skill。用户自建
  `skills/` 内容会被保留，不参与默认 Skill 裁剪。
- `config.loadSkills` 只是 Agent 未声明 `loadSkills` 时的名称 allowlist 默认值。
  `["*"]` 不按名称限制，`[]` 拒绝全部 Skill，具体名称数组只开放对应 Skill。
  Agent 和 Plan 的显式数组完整覆盖上层值；布尔值不是合法配置。
- `loadMcp` 默认使用 `{ "*": ["*"] }` 开放全部 MCP 工具，`{}` 显式关闭；`instructionFiles`、`loadMcp`、`loadAgents` 和 `loadWorkflows` 在 Agent 层按白名单覆盖。`blockSkills`、`blockTools`、`blockMcp`、`blockAgents`、`blockWorkflows` 是逐层累加的黑名单，优先于白名单和 permission allow。
- MCP 密钥使用 `{env:VAR_NAME}`，不要把凭据写入配置。
- 未设置模式等同于 `default`，保留 config 的 `defaultModel`、Agent 的 `model` 和
  两层 `fallbackModels`；模型可为 `provider/model` 或 `{id,variant}`。Agent 模型
  缺省/null 继承全局默认；fallback 省略继承全局，`[]` 关闭。Plan 继承源模型。
  Builder 写入模型 frontmatter，config hook 保留声明候选，由宿主请求时解析模型；消息不覆盖用户显式选择。
  子 Session 优先冻结目标候选，未配置时继承父模型；候选仅供诊断和显式决策，
  O4E 不会在模型错误后自动重试或自动切换 fallback。`clear` 仅清除本次投影及候选链。
  安装后可用 `o4e model`（交互）或 `o4e model --no-tui --default-model=...` /
  `--model=<agent>=...`（静默）修改 `defaultModel` 与 Agent `model`，自动保留注释并重建；
  直接编辑本目录后运行 `o4e build` 亦可。
- 项目需要额外规则或契约时，通过 Agent 的
  `instructionFiles.project` 显式加入项目内相对路径。

## Agent

| 类型 | 用户可选择 | 可发起委派 | 可作为目标 |
| --- | --- | --- | --- |
| `system` | 否 | 否 | 否 |
| `all` | 是 | 是 | 是 |
| `primary` | 是 | 是 | 否 |
| `subagent` | 否 | 是 | 是 |

目录决定类型，JSONC 内不得声明 `mode`。文件名必须与 `name` 一致并全局
唯一。具体 `all`、`primary`、`subagent` 必须物化单行 `description`；
只有 `primary` 可以声明 `nativeMode`。Agent 列表排序与默认选择由 OpenCode
管理；O4E 不根据 selector 列表覆盖宿主默认入口，原生模式别名映射仍按配置生效。

可在 `config.jsonc` 显式设置 `"defaultAgent": "orchestrator"`，覆盖 OpenCode
的 `default_agent`。省略则不指定默认入口。值必须是已配置的 `all`/`primary`
名称或其生成的 Plan Profile；不存在、纯子 Agent 或宿主禁用的目标会报错。
该字段不控制列表排序，也不实现上次选择记忆。

安装器按默认 Agent catalog 的展示顺序，把本次已选的第一个 `all`/`primary`
写入 `defaultAgent`；默认选择下是 `orchestrator`。取消勾选它后使用下一个已选主
Agent，纯子 Agent 不参与。普通构建不重新选择或改写该字段。

Plan 必须显式使用 `{ "mode": "self" }` 或 `{ "mode": "child" }`。
两种模式都只使用 `<name> (plan)` 作为 Plan Profile 名称：`self` 只生成该
Profile，`child` 保留源 Agent 并额外生成该 Profile。原生 `plan` 的 managed
入口也映射到 `<name> (plan)`；无后缀源名称和历史 `<name> (Plan)` 不是合法
Plan Profile。
默认 Plan 直接能力偏只读，但 `plan` 对象中的显式工具、permission、MCP、
Agent、Workflow 和 reminder 配置可以有意覆盖默认值。

## 委派与后台 Agent Task

受管 `task` 是唯一 Agent 委派入口，默认创建后台 Agent Task；只有显式
`background:false` 才同步等待。当前宿主的 slash-command subtask 会绕过
插件工具注册，因此 O4E 拒绝该路径。子 Agent 可以继续委派；每层都须经过
宿主授权，并继承祖先的权限 Overlay、Effect 和写入 Scope 限制。

当前生效的 `.o4e/config.jsonc` 顶层 `maxDelegationDepth` 由所有 Agent 共用，
默认 2，只接受 1..5 的整数。修改后按现有流程重新 build 并重新加载 OpenCode，
不承诺热更新。
根 Agent 深度为 0，直接子 Agent 为 1，其下级为 2。Workflow 的普通 Step 在
当前主 Session 执行，不创建 Agent Session，也不增加深度；只有主 Agent 显式调用
`task` 时才按普通委派从当前调用方增加 1。
达到上限的 Agent 应直接完成当前任务或向调用者报告所需帮助，不能继续委派。
不建议提高上限，以免增加任务量、成本和协调复杂度。

本节的 group、交互、模型候选、ledger、receipt 和恢复要求仅适用于 Agent
Task。创建和管理 Agent Task 允许有相应权限的 managed `primary`/`all`/`subagent`
caller 操作自己 Session 的任务；管理动作还须经宿主 `o4e_task:agent:<action>`
授权。child 可以管理自己创建的下级 Task，不得管理其自身所属的父 Task 或兄弟 Task。

公开 `task` 的 `description`、`prompt`、`subagent_type` 都是必填非空字符串。
O4E 在 `task.execute` 入口自身的 recovery、授权和创建前使用与工具声明相同的 schema 实际校验参数；缺失或非法时
返回 `O4E_TASK_INVALID_ARGUMENTS` 和字段名，不回显参数正文。即使只有一个合法候选也不
猜选目标，`agent` 不作为 `subagent_type` 别名。工具报错不表示已经创建 Task；调用者须按
当前用户授权处理错误，不自动重启已有 Task。Workflow catalog 与检查点协议独立于该参数校验。
更早的宿主/插件 before hooks 仍保留各自的生命周期行为，这不是整个 hook 链零 I/O 的保证。

`o4e_task` 不创建 Task；对既有 Agent Task 支持 `status`、`watch`、`inspect`、`output`、
`input`、`cancel`、retry decision 和 permission/question 回复。子 Agent 的权限和提问
默认由用户在 OpenCode 根会话的原生提示中处理；父 Agent 报告等待并保留原请求，
不重复提问或代答。仅用户明确要求代为处理当前请求时，先调用 `pending` 获取最新
revision，再用对应 reply/reject；任务目标、已知答案或笼统“继续”不等于代操作授权。

交互异常退出后，已结束的工具调用不等于任务完成。宿主确认 idle 且没有最终结果时，
Task 可进入 `waiting_retry_decision/execution-interrupted`；缺少 requestID 且无法核验
pending 请求时会附带诊断。此时处理显式 retry 决策或取消，不要重复空转 watch。
查询失败不会清除已有有效请求，异常状态也不会自动重跑或释放不确定的写锁。
宿主当前两套交互 API 使用独立的 pending 存储；任一查询失败都会报告错误，
另一套成功或返回空列表不表示全部查询成功。请求复用宿主 SDK 的认证和连接。

任何 Agent Task 模型错误（含非 `APIError`、不可重试标记）都会保留错误原因并进入
`waiting_retry_decision`。fallback 候选和错误分类只作诊断；主 Agent 读取最新 revision 后，
在既有授权内显式调用 `resolve continue|restart|stop`。Runtime 不替主 Agent 决定，也不自动
重复模型调用；continue/restart 仍复核授权、CAS、取消、Attempt、Scope Lock 和副作用水印。
宿主 provider 自身可能内部重试，该行为不经过 O4E 插件控制。

`watch` 冻结入口选择的 Agent 和 Command 集合，任一新终态或需处理事件出现即返回。
Agent 终态按已消费 receipt 去重；Command 状态事件仅按可信公开 watch 或 canonical source 绑定的原 Bash 终态响应去重，Command 的 status/output 不消费 watch 事件；非终态事件只有此前 watch 公开正文完整交付且
`taskID/status/phase/revision` 匹配时才去重。相同事件继续等待，全部所选终态
事件已交付则返回 `empty`；缺失可靠交付证据时允许重报。省略 selector 选择 owner
当前两类 pending 集合，可显式选择混合 `taskIDs`；空数组选择空集，后续新 Task 不加入该次等待。

`watch` 省略 `timeoutMs` 或传 `0` 时使用 30 分钟（`1800000` 毫秒）等待窗口；
正数显式值可指定窗口，最大 `3600000` 毫秒。deadline 固定，不做 watch 退避，
内部检查和进度事件不会延长该窗口。到期对账后
返回 `heartbeat` 或其他可操作结果后，必须先向用户报告有意义的当前状态，再调用下一次
watch；completed 先读取 output，失败、取消、unknown/interrupted 和显式等待状态不得表述为成功。
检查返回状态并继续 watch 尚未完成的依赖；新可操作事件和
真实用户消息可提前唤醒，且真实用户消息和终态/显式等待状态优先。Runtime 不生成合成
heartbeat 进度消息，中间汇报是否在 TUI 可见取决于宿主。heartbeat 不表示完成，也不会取消或重启 Task。
该窗口与下述读取调用预算分开，不是任务执行超时。

只有 inspect/watch 接受 `ioTimeoutMs`：1..60000 的安全整数，默认 10000 毫秒。
预算从 tool execute 入口开始，覆盖 recovery、授权、cursor scan、watch 窗口、
到期复核和 UI 等待；inspect deadline 为 allowance，watch 为归一化窗口加
allowance，固定且不按操作重置或延长。超时或 caller abort 只取消读取等待，
不取消 child Task 或共享 recovery；已启动的生命周期 Promise 继续被追踪，
dispose 仍等待它们，并在第一次异步等待前停止接纳新工作和通知；持久化失败仍会报告并允许重试释放。

对这两类读取，O4E 的 `tool.execute.before` 不提前等待 recovery/event drain，
而是留给同一次 execute 预算处理；它们不需要写范围检查或副作用水印。
其他工具和 Task 动作的前置行为不变。预算不覆盖宿主或其他插件在 O4E execute
之前执行的 hooks。

receipt 消费事务 admitted 后（包含 adapter consuming callback）不可被
deadline/abort 中断：此时关闭 deadline，等待并返回实际事务结果，仍可失败。
已 commit 结果不等待最终 best-effort UI metadata。该预算不是绝对硬 wall-clock
上限，admitted 事务、同步 JavaScript 和 SDK 超大 payload 处理都可能超过它。

`watch` 和 `status` 只返回状态与必要控制信息，不带结果正文或 heartbeat tail。
`output` 每次返回结果正文，保留空白与空输出，仅附必要的截断或日志不完整提示。
单个 completed Agent 结果须通过 output 权威读取后再报告。Inspect 负责过程预览，
只有 inspect 接受 `resume` 并从此前可信 inspect 响应恢复游标。
同一 completed Tool Part 的 `metadata.o4eResult` 保留有界结构供可信解析，不授予权限；
公开文本被宿主截断或压缩时不得认定事件已完整交付或推进 inspect 恢复位置。

inspect 的窗口读取不判定完成或消费回执；工具入口仍复用既有 recovery 和授权
对账，冷启动时可能更新生命周期状态。页数及正文预算只约束预览读取器，
不代表入口 recovery 没有历史读取或持久化副作用。

`inspect` 必填 `taskID`，可选非空 `cursor` 最多 512 字符；
`direction` 为默认 `"forward"` 或 `"backward"`，`maxBytes` 为 4..8192
的安全整数，默认 1024。单数 `cursor`、`direction`、`maxBytes` 只用于
inspect。Plugin 和 Runtime 都校验选项。
Agent 游标只接受当前紧凑格式，最多 120 字符。
结果为紧凑 `taskID`/`status`、可用的 `tail`/`cursor`，以及可选
`unchanged`/`unavailable`/`gap`；仅存在更早数据时返回 `beforeCursor`。
游标绑定 Task、子 Session、dispatch、run generation 和 Attempt，固定 UTF-8
字节位置并支持文本、Part 和消息追加。校验覆盖源的整个旧公开快照前缀，
不仅是已读字节；前缀改写、工具状态变化或源删除返回 `gap`，不跳到新 tail。
它不是授权，不能访问其他父 Session 的 Task。
inspect 不消费回执、不判断完成；完成后仍须使用 `output` 获取业务结果。

Inspect 可显式传布尔值 `resume:true`，从 caller 父 Session 已持久化的真实
`o4e_task` inspect 响应恢复各 Task 最近位置，只取当前工具
`messageID`/`callID` 之前的响应（含同消息更早的 Part），排除当前及之后的
Part/消息。父历史最多扫描 5 页、每页 20 条，不新增缓存或游标表。
`resume:true` 不能与 `cursor` 并用；backward inspect 只取最近预览的
`beforeCursor`，没有更早位置时返回 `unavailable`，不改用 `cursor` 或旧预览。

只有定位调用边界并扫尽历史、确认无旧 anchor 或失败时，首次 forward resume
才允许 fresh。空 `unchanged:true` 或 queued `unavailable:"not-dispatched"`
预览在不带 `tail`/`cursor`/`beforeCursor` 时可保持首次状态，但不能掩盖旧
anchor 或失败。最新相关调用失败、pending/running、预览失败/gap、输出损坏或
被压缩、边界不明，或位置未确定就达到历史上限时返回 `unavailable`，不回退
历史成功或新 tail。不保证多读者 exactly once，并发 pending/running 调用
fail closed。有意重新取近期 tail 时省略 `resume` 或设为 false，且不带手工
游标；这是重置读取位置，不是 gap 的无损恢复。

预览仅展示已验证当前 dispatch/compaction lineage 的公开 assistant 文本、
工具名称/状态和极小安全白名单摘要：`read` 可显示有界、规范化的工作区相对
`filePath`；`glob`/`grep` 可显示有界的工作区相对 `path` 和保守限长的
`pattern`。外部路径、疑似敏感、URL/query-like、畸形或超长值省略，未知工具
仍只显示名称/状态；不展示其他工具输入、任何工具输出、reasoning 或隐藏
metadata。摘要参与旧公开快照前缀校验，但摘要正文不进入 cursor，也不授予权限。每次通过
`messagePage` 最多读取 5 页、每页 20 条，不使用缓存或全历史回退；无法验证
lineage 或游标来源时返回错误标记。这限制页数和 tail 字节数，不限制 SDK
下载超大单条消息及其 Parts 的字节量、Part 数量或单条消息投影内存。

Task lifecycle ledger 位于 Task Session 的 `metadata.o4e.task`；完整冻结委派
授权位于 sibling `metadata.o4e.delegation`，父 Session ref 的 recovery
envelope 保存两者的恢复副本。模型候选、Effect、Scope、输入批次和 receipt
也绑定原 Session。终态 ledger 必须已经保存 receipt；缺失时拒绝读取，不自动补建。父索引缺失 receipt 时仍可从完整 ledger 重新发布。新插件 Runtime 不全局扫描或派发历史 Task；重新打开原父
Session 后的第一条真实用户消息只激活该 Session 的可恢复 Task。缺少完整
canonical `task` 冻结授权的 Task 进入
`unknown/authorization-unverifiable`，只能查询和取消，不能继续执行或晋升
完成。

`o4e_task` 的 Agent `input` 默认采用安全的 next-turn 语义：输入持久化到同一
child Session 的 `pendingInputs`，不实时注入 busy turn。传 `delivery: "steer"`
时，Runtime 仅在宿主确认支持时请求打断式插入；宿主不支持则回退到队列，并在
`inputDelivery` 明确报告实际模式和边界。`resume` 只唤醒可安全重派发的
queued/retry/pending-input Task；`cancel` 仍用于显式终止。不确定或取消中的执行
不会被重启。既有 16 条 pending input、每条最多 16,384 个字符（按 UTF-16 code unit
截断）、CAS、终态续跑、fallback/retry
保留和等待 permission/question 拒绝规则保持不变。

Scheduler 按 `ownerSessionID` 和 Task kind 分 lane，在并发额度内按 sequence 顺序准入，
不按活动任务的 read/write mode 阻塞或跳过另一类别。准入不保证全局执行 FIFO；
写冲突由进程内 `ScopeLockManager` 处理，根 read 可与写任务并行但不提供一致性快照。
不同 OpenCode 进程之间不共享锁、
admission 或 cancellation fence。

## 受管 Bash 与 Command Task

全局受管 `bash` 已直接创建 command Task，不经过模型委派，也不是 Agent Task。
它覆盖包括原生 `keep` 在内的普通 Bash 工具调用，但不绕过宿主权限。

### Shell 与参数

- 执行必须遵循 `SPEC.md` 的 `CMD` 条款，支持 OpenCode 当前支持的平台和 Host Shell。
  Shell、参数协议、进程边界、取消、日志和恢复均以宿主平台及 `config.shell` 为准；
  O4E 不使用自定义 shell fallback。尚未经过目标平台实机验证的行为必须明确标注为未验证。
- 使用目标 Host Shell 的参数协议启动，无 PTY、stdin EOF，并继承启动时的进程环境。
  POSIX-compatible Shell 使用 `-c`；Windows 上的 PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`，
  Windows 上的 `cmd.exe` 使用 `/d /s /c`。启动行为和环境赋值语法由目标 Shell 决定；公开插件 API 不分发其他插件的
  `shell.env` hook，也不引入宿主私有 API 模拟该 hook。
- 受管 Agent/Plan 的 system prompt 会明确区分 OpenCode `directory` 与 `worktree`：
  前者是文件和命令操作的当前工作目录，后者是仓库/项目规则根；无委派权限的受管
  subagent 也会获得该上下文，原生 `keep` 不被改写。
- `command` 和 `description` 必填；可选 `workdir`、`timeout`。省略 `workdir` 使用
  当前 Session `directory`，相对值从该目录解析；每次调用独立，不继承前一次 cwd。
  严格 provider 将可选字段转换为 required nullable 时，`null` 等价于省略；空路径及
  其他非法值仍拒绝。`timeout` 为
  1..2147483647 的整数毫秒，默认 120000，是 port 执行时限，不是 admission 等待或排队时限。
- Admission 等待默认 1000 毫秒，开始 running 后另有默认 10000 毫秒窗口；到期仍
  queued/running 时返回快照与稳定 command `taskID`，命令继续执行。两个窗口与
  execution timeout 分离，不包含前面的授权/持久化耗时。
- 工具名 `bash` 不代表目标一定是 Bash。命令原样交给选定 Host Shell；引号、展开、赋值、
  函数、循环、管道、重定向及多行文本等语法必须符合该 Shell，O4E 不在不同 Shell 语法间转换。
  parser 只提取权限资源，不执行替换，也不施加语法白名单；无法静态解析的动态操作数
  跳过静态路径检查，并按完整原始输入请求额外授权。语法错误由目标 Shell 报告。

### 权限、调度与恢复

创建 command 前先解析并要求宿主 `context.ask` 批准原始与 canonical 的各原子
Bash 资源，以及适用的 realpath 外部目录资源。O4E `allow` 仍须进入 `context.ask`，
不保证免提示；只有宿主当前有效规则判定为 `allow` 时才可能无 UI 返回，宿主 `ask`/`deny` 不被绕过。
O4E permission 可以收紧拒绝，不能替代宿主授权。受管 child 还须验证 live
identity、frozen delegation/Agent Task、fingerprint、权限与 Effect；
主 Session Workflow Step 不形成另一层 command authority。批准后及
资源 admission 后再次验证，再持久化 claim。

Bash 不获取、借用或恢复执行 Scope Lock，不因 Agent 或其他 Bash 的写范围而互斥。
Child 仍要求可信冻结的 `unknown-write` 权限，不接受模型传入的 owner，不将
read/scoped 权限升级。Agent 之间的锁和父子生命周期停止确认保持不变。
`backgroundTasks.maxConcurrentCommands` 默认 4，限制每个 owner Session
的 command lane，不占 Agent 槽；并发文件冲突和依赖顺序由调用方协调。

Command 使用独立校验的 `kind: command` ledger，唯一规范记录位于 owner Session 的
`metadata.o4e.commandTasks.refs[taskID].recovery`。不创建独立 Command Session，
不增加普通列表或子 Agent 导航项，也不覆盖 owner 的 Agent `.task` 或 delegation envelope。
ref/record 的 `taskSessionID` 等于 owner，仅表示存储容器。
Source Session/message/call 身份去重；记录与引用在同一次 owner 更新中持久化 execution
claim 并确认后才提交 port。历史独立账本不自动迁移或删除，无效布局拒绝继续。
恢复只处理指定 owner，先恢复不确定 Command admission（不创建写锁）再查询
handle；可重接既有进程内 handle，不重执行旧 claim、不跨宿主重启收养 PID。
未提交记录若已无 live launch，进入 `interrupted/not-submitted`；已 claim 但
handle 缺失则保持 `unknown` 和 Command 资源槽位，不因用户消息激活而重执行。

### Command 管理

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

### 输出与取消

未截断的普通成功 Bash 返回捕获到的原始文本，保留空格、换行和空输出，不加 Task 包装、摘要
或空输出占位。非零退出、异常、截断和日志不完整使用明确分隔的最短控制信息，让
模型从正文中得知；不能只放 UI metadata，也不假定 JSON attachment 可读。这里的原样
是各流 UTF-8 解码后的捕获文本，不承诺终端仿真、二进制保真或两个 fd 的真实全局写入顺序。

内存视图最多 64 KiB：运行中为 tail，大型终态为 head 加 tail；inspect 只能分页此
保留视图。Bash 模型正文独立采用 48 KiB/1800 行预算，超限返回 tail，并在正文前
放置明确分隔的控制信息。Bash `metadata.o4eResult` 预算为 20 KiB，与卡片输出独立；其他 command 动作为 40 KiB。Metadata 缩减标记 `truncated` 和
`outputView`，不改写预算内的 Bash 正文。完整文本写入仓库外的当前用户私有日志，
目录 0700、文件 0600，单条上限 256 MiB，终态前确认写盘。日志从终态结算起按
24 小时保留期惰性清理，活动日志受保护，清理可能保守延迟。创建、写入、容量、同步或捕获失败均明确
标记不完整；`logComplete:true` 才表示捕获日志已完整保存。需要完整文本时通过返回的
`logPath` 使用获准宿主文件工具分段读取，不由 inspect 提供全日志分页。
`totalBytes` 和可用 `sha256` 描述已观察原始流；采集不完整不生成完整 hash。
原生 Shell 卡片独立累积最多 256 MiB 捕获文本，超限保留 UTF-8 完整前缀并明确标记
卡片不完整。附着和后台阶段都合并更新同一 Bash Part 的 `metadata.output`；后台更新
不改变模型已收到的 `state.output`、工具状态、时间或 `o4eResult`。传输 best-effort，
失败不影响执行；宿主可能折叠、trim 或 strip ANSI，不能保证卡片完整送达。
短命令终态正文可直接使用；后台返回仅有状态与 taskID，按需通过 output 读取正文。

原始 command/description 输入留在宿主 Bash Part，command ledger 保存来源引用和 hash，
不保存可重放命令。

Inspect/watch reader abort 或读取 deadline 不取消 command；Bash 已返回 queued/running
快照后，其原 reader abort 也不取消执行。普通 root owner idle 和根回合的
`MessageAbortedError`/`AbortError` 保留已脱离命令；根回合 abort 只临时抑制跟踪，
下一真实用户回合解除，显式 `follow enabled:false` 不被普通用户消息解除。
附着 Bash 调用方 abort、显式 Task cancel、owner 删除、受管 child 生命周期终止/取消和
plugin disposal 仍发起取消，execution timeout 会发起停止。要停止后台命令应使用
获授权的 `o4e_task cancel`。后台运行不等于跨宿主重启的常驻服务。
停止未确认或 canonical/owner 持久化失败时保留 Command admission 与不确定记录，不持有写锁；重试取消或 disposal
仅重试 stop evidence/持久化，不重执行命令。进程内协调不是 OS sandbox，也不是
跨进程 lease；停止证据只覆盖所属进程组，不保证停止 `setsid`/`setpgid` 逃逸后代。

## Workflow

Workflow 是主 Agent 的 process-v1 检查点协议，不是后台多 Agent 调度器。普通
Step 由当前主 Agent 在同一 Session 使用现有工具完成；Runtime 只负责定义、依赖、
revision、StepReport、Gate 和检查点持久化。只有 Step 显式声明
`execution: { "mode": "task", "agent": "<name>" }` 时，主 Agent 才另行调用现有
`task`；该调用仍须独立通过 `task:<target-agent>` 授权、深度、Effect 和 Scope 校验，
Workflow 不等待、调度、取消或回复 Task 交互。

Workflow 文件位于 `workflows/<name>.jsonc`，文件名必须等于 `name`。顶层必填
`contract: "process-v1"`、`name`、`description`、`output` 和非空 `steps`。
Step 只接受 `type: "work"`；旧 `agent`/`workflow`/`loop` Step、嵌套、Loop、
并行主 Step 和主 Session 隔离声明均拒绝。`execution` 默认 `{ "mode": "self" }`。
依赖使用 `dependsOn`；Step input 只能读取 Run `workflow` input 或已声明的
`dependencies`，顶层 output 只能读取通过 Gate 的 `steps` output。

所有 `o4e_workflow` 调用都显式提供 `action`：`catalog`、`list`、`start`、`read`、
`begin`、`report`、`resume`、`pause` 或 `stop`。旧的省略 action、`bindings` 和
`resumeRunID` 不接受。除 `catalog` 外，每次入口都要求宿主
`o4e_workflow:<name>` 授权并在授权后重验当前 owner；仅受管 `primary`/`all` 根
Session 可使用。`start` 不创建执行 Session；Run 保存于 owner Session 的
`metadata.o4e.workflowProcess`，`runSessionID` 就是 owner Session。它没有后台
Workflow ledger、taskID 或 `o4e_task` 管理面。

`list` 无需 runID，仅列出当前 owner、同一 Agent 的有权 Run 摘要；按可见 Workflow 名称经宿主授权并重验，无可见项返回空列表，不写入、不恢复、不扫描其他 Session。详情仍用 `read`。TUI 检查点面板仅展示记录快照，不构成授权或 Gate 证据。

主 Agent 对 ready Step 先用 `begin` 建立 Attempt，再完成实际工作，最后用
`report` 提交恰好包含 `status`、`output`、`artifacts`、`evidence`、`diagnostics`
的 StepReport。`reported-completed` 只是报告；Runtime 还会检查 `outputSchema`、
`artifactsMin` 和 `gate.evidence`，只有 `decision.accepted:true` 才通过。
`maxRepairRounds` 默认 2、范围 0..10；拒绝后必须再次显式 `begin`，不会自动重放工作。

Workflow 顶层和每个 Step 的 `inputSchema`、`outputSchema` 省略时分别默认
`{type:"object"}`，不是无约束，也不继承其他层的 Schema。Step 输入值默认继承 Run input，
但仍须通过自身 Schema；使用字符串、数组或 null 时，应在相关输入/输出层显式声明类型。

Evidence 只支持 `{kind,taskID,messageID,callID}` 形状的 `command-success`、
`task-created`、`task-result`。引用必须属于同一 owner，发生在当前 Attempt 的
begin 之后、report 之前，并与真实命令账本或 Task/授权信封和已完成工具 Part
一致。它们只分别证明命令成功、Task 已创建或结果已读取，不证明测试覆盖充分、
专业结论正确或文件/hash 存在；自然语言不能替代事实引用。
Gate evidence 还可用 `{ "kind": "task-result", "taskFrom": "<dependency>" }`
把结果绑定到直接依赖 Step 已接受 `task-created` 事实中的唯一可信 Task；不读取依赖
output 的模型声明。依赖未通过、Task/Agent 不匹配或引用修改时拒绝，恢复重读会重验。

每个 owner 同时只允许一个 running/interrupted Run，每个 Run 同时只有一个 active
Step。`expectedRevision` 保护 begin/report/resume/pause/stop；相同 submissionID 与
payload 可安全重读决定，不同 payload 拒绝。新用户消息只把当前活动 Run 标为
interrupted；主 Agent 必须先处理最新指令，再 `read`/`resume`。active Attempt 不会
自动重放，pause/stop 也不会停止已经创建的 Task 或 Command。
写操作使用当前 assistant 消息的宿主 `parentID` 绑定 user turn；毫秒时间戳相同且
无法由父关系消除的用户消息顺序歧义会明确 fail closed，不依赖数组位置或 ID 字典序。

当前自动化 process 测试覆盖正常、失败、恢复和边界路径；这不是真实 OpenCode 宿主、多回合、
compaction、重启、授权 UI 或 Windows/macOS 验收。详细当前行为见源代码仓库的
[docs/reference/workflows.md](https://github.com/hymsk/opencode-for-everything/blob/main/docs/reference/workflows.md)。

## Skill 与 Soul

`skills/o4e-agent-creator` 用于创建和审查 Agent；
`skills/o4e-workflow-creator` 用于创建和审查 Workflow。Skill 只提供按需
行为，不扩大 Agent 权限。插件直接把当前 `.o4e/skills/` 放在宿主
`skills.paths` 首位；O4E 不复制或管理公共 `.opencode/skills/`。

Soul 在 system takeover 后注入到最终 system 首部。仓库默认源分别维护
`soul.zh.md` 和 `soul.en.md`，安装器根据所选语言将其中一份写入用户维护的
`soul.md`，不会把语言模板文件复制到安装目标。Prompt 同样只复制所选语言的
一套内容到扁平的 `prompts/`；仓库默认源同时维护 `prompts/cn/` 和
`prompts/en/`。

默认 Soul 维护指引采用“默认不写入”：只有用户明确要求记住或明确表达为长期
适用、跨会话仍有用的个人背景与协作偏好才考虑持久化。
临时指令、执行授权、任务状态、项目规则和产品决策不属于 Soul。
每项尽量一句，已有则合并；纠正与忘记应替换或删除原条目。
这是默认 Prompt 指引，不是运行时语义分类器或文件写入拦截器；Soul handler
只读取和注入内容。`build` 和重新安装均保留用户已有 `soul.md`，不会强制覆盖
旧维护指引；已有安装需由用户授权后单独更新维护章节，并保留用户条目。
