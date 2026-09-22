# 故障排查

[中文](README.cn.md) | [English](README.md)

[← 文档中心](../README.cn.md) | [CLI 参考](../reference/cli.cn.md) | [环境变量](../reference/configuration.cn.md#环境变量)

## 安装和依赖

### 找不到 `@clack/prompts`

安装器依赖尚未安装。在源码根目录执行：

```bash
npm ci
```

### `opencode` 命令不在 PATH 中

安装和测试需要 `opencode` 可执行文件在 `PATH` 中，验证基线为 `>=1.18.21`；不表示范围内每个版本均已逐一验证。确认安装了 OpenCode 并且可以在终端直接运行（下面是 Linux/macOS 示例，Windows 可用 `where.exe opencode`）：

```bash
which opencode
```

### Node.js 版本过低

安装器要求 Node.js 20.12 或更高版本；开发及 CI 测试使用 Node.js 24，测试会直接导入 TypeScript server 模块。在 Node 20 上运行测试出现 `ERR_UNKNOWN_FILE_EXTENSION` 时，不能把它误认为安装器本身不支持。检查当前版本：

```bash
node --version
```

### 导入或导出提示找不到 `tar`

配置导入和导出依赖系统 `tar`。Windows 默认使用 `%SystemRoot%\System32\tar.exe`，Linux 和 macOS 从 `PATH` 查找 `tar`。确认对应可执行文件存在且当前用户可运行；不要用来源不明的同名程序替换系统 `tar`。

### 导入归档被安全校验拒绝

导入只接受普通、非链接的 `.o4e.tar.gz` 文件。归档内部必须使用 POSIX `/` 路径并且只能包含 `.o4e/`；反斜杠、绝对路径、`.`/`..`、符号链接、硬链接和特殊文件都会被拒绝。请重新用 O4E 的 `export` 子命令生成归档，并且只导入来源可信的文件。

## 插件释放与失败后的部分恢复

最后一个插件 facade 会取消运行中的后台 Agent，不再在 Agent 运行时释放其 Scope Lock。若释放失败，会保留不确定记录，facade 可能保持隔离，直到持久化可用并完成消解性恢复，或后续 dispose 重试。不要把成功 dispose 当作独立任务停止的证明，除非已确认其终态与停止证据。

dispose 失败后不要重复执行旧命令或手工修改账本。保留错误，核对任务状态，恢复持久化依赖后重试 dispose，只有理解状态后再重载插件。最后 facade 取消和 failed-dispose 路径有专门的回归测试；模拟宿主接口失败不等于真实宿主退出验收。

## 构建

### 构建失败：配置解析错误

确认配置文件位于目标 `.o4e/`，agent 文件名与 JSON 内的 `name` 一致，并且 prompt 引用没有使用绝对路径或 `..` 逃逸。详见[配置参考](../reference/configuration.cn.md)和[Agent 参考](../reference/agents.cn.md)。

```bash
node scripts/installer.mjs build --target /path/to/project
```

### 构建失败：符号链接或硬链接拒绝

构建器拒绝配置树或生成目标中的符号链接和硬链接。确认 `.o4e/` 和 `.opencode/` 目录及其内容是普通文件和目录。

### 构建拒绝未知字段

配置包含当前 Schema 未定义的字段时，构建会拒绝。按 [`defaults/.o4e/schemas/`](../../defaults/.o4e/schemas/) 中的当前 Schema 调整配置后重新构建。

### 构建或启动失败：缺少显式配置

`config.nativeAgents` 必须包含 `build`、`plan`、`general`、`explore` 四项。安装目标中的每个具体 Agent 也必须声明单行 `description`。`agents/default.jsonc` 只属于仓库安装模板，不应保留在目标 `.o4e/agents/`。配置需符合当前 Schema，`loadSkills` 使用名称数组，再重新构建。若 OpenCode 显式设置了 `default_agent`，确保它指向未被禁用的可选 Agent。

## 运行时

### 项目配置错误时没有回退到全局配置

这是预期的 fail-closed 行为。项目 `<directory>/.o4e/` 只要存在就会遮蔽全局配置；如果项目配置无法解析、引用缺失或包含链接/特殊文件，Runtime 会拒绝启动，而不是使用全局 `.o4e/`。修复项目配置，或在确认不再需要项目配置后完整移除该目录。

### Agent 没有生效

检查目标 `.opencode/agents/` 和 `.opencode/plugins/` 是否已经重新生成。修改 agent JSON、Schema 或工具策略后需要重启 OpenCode。详见[Agent 参考](../reference/agents.cn.md)。

```bash
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs build --target /path/to/project
```

### Prompt 修改没有立即生效

Prompt、Soul 和受管 instruction files 会在下一次相关 system 组装时按文件元数据重新读取。Agent JSON、工具和 Skill 需要重新构建，插件代码变化还需要重启 OpenCode。详见[配置参考](../reference/configuration.cn.md)和[Soul 和 Prompt](../reference/configuration.cn.md#soul-和-prompt)。

### 启动时模型选择不符合预期

先检查 `o4e_mode`：未设置等同于 `default`，保留模型配置。再检查 config 的
`defaultModel`、Agent 的 `model`、`fallbackModels` 和宿主已加载 provider。
受管 child 优先使用目标配置候选，未配置时才冻结父 Session 当前模型；用户显式消息选择不被改写。

如果需要排除宿主保存模型对本次运行的影响，使用 `o4e_mode=clear` 启动新进程；它只
清除本次最终运行时配置投影，不修改宿主配置文件、凭据或模型库。需要完全不初始化 O4E
Runtime 时使用 `o4e_mode=origin`。空字符串或其他非法值不会阻止启动：O4E 回退为
`default` 继续，同时输出 `O4E_MODE_FALLBACK` 错误诊断（宿主日志，TUI 可用时弹出警告）。
核验实际行为时检查最终 config 和 provider 请求，不使用模型自述。

### MCP 已连接但 Agent 没有工具

Connected 只证明宿主连接状态，不证明当前 Agent 收到了工具。数组型 `loadTools`
会关闭未列出的 builtin 工具；MCP 默认通过 `loadMcp: { "*": ["*"] }` 开放。
Agent 显式 `loadMcp: {}` 会关闭全部 MCP，`blockMcp` 黑名单优先于白名单。按实际需要在 Agent `loadMcp` 中声明 server 和工具名单，
不要为排障把所有权限改为 allow，也不要因 MCP 不可用而绕过既有的 MCP-only 操作规则。

例如 server `zellij-mcp` 的 `workspace_list` 对应宿主工具名
`zellij-mcp_workspace_list`，连字符不会被改成下划线。还应区分 Agent/Plan 权限、消息级
工具过滤和旧实例缓存。配置变更后重新构建并重启，再核验实际工具列表，而非仅观察
连接侧栏。详见 [MCP 配置](../reference/configuration.cn.md#mcp)。

### Bash 或 o4e_task output 显示异常

OpenCode 的原生 Bash 卡片读取宿主提供的 `metadata.output`，其折叠、截断和展示由宿主控制。O4E 独立累积 Command Runtime 输出，转后台后通过 `o4e_task output` 和外部日志归档继续提供结果；这两个通道不承诺完全同步。
同一 Shell 卡片，模型已收到的正文保持不变。卡片最多保留 256 MiB，超限会明确标记；
宿主默认折叠长输出，可展开查看。未截断的普通成功 Bash 模型正文保留捕获文本、空格、
换行和空输出；非零退出、截断或日志不完整另有明确分隔的控制信息。
若 1 秒后仍 queued，或开始 running 后 10 秒仍未结束，只返回后台标识和必要控制信息，
命令继续运行。默认 `o4e_task watch` 同时监控 owner 的 Agent 和 Bash，且只报告状态；
使用 `output` 读取正文，`inspect` 分页查看近期输出。卡片更新复用公开 Part API；宿主拒绝
更新或关闭会话时可能无法送达，终态日志是完整性核验依据。
核验新行为时需要从更新后的源码 build 并完全重启，不能用旧生成运行时作为证据。

`o4e_task` 默认 `enable_o4e_task_detail:false`，人类界面保留调用行但持久化的 UI output
为空；宿主 `Show tool details` 无法恢复这类已隐藏正文。需要显示后续调用的正文时，
在 `.o4e/config.jsonc` 设置 `enable_o4e_task_detail:true`，按配置更新流程构建并重启插件实例；
宿主自己的详情偏好仍然适用，修改设置不会补写历史空 UI Part。
两种模式都通过经过校验的模型展示包络向模型提供相同的完整有界正文。
结构化恢复数据位于 completed Tool Part 的 `metadata.o4eResult`，仅供可信调用历史解析，
不构成授权。详见[配置参考](../reference/configuration.cn.md#task-工具展示)。

### 全局插件未加载

项目级 `.opencode/plugins/` 会被 OpenCode 自动发现；全局插件需要注册到 `~/.config/opencode/opencode.json` 或 `opencode.jsonc`。当前安装器的全局路径固定为 `~/.config/opencode`；设置 `XDG_CONFIG_HOME` 不会改变安装器写入位置。确认注册文件内容是严格 JSON，并检查插件 URL 是否仍指向现有运行时文件。详见[环境变量](../reference/configuration.cn.md#环境变量)。

### Workflow 没有被 Agent 加载

先让 Agent 显式调用 `o4e_workflow action:catalog`，查看当前可发现的 entry Workflow 定义；查找本会话已经创建的 Run 则使用 `action:list`。若目标未返回，确认 agent 的 `loadWorkflows` 包含目标 Workflow 名称或使用 `["*"]`，Workflow 的 `visibility` 为 `entry`，并检查最终 `o4e_workflow:<name>` permission 是否为 `deny`。当前不支持嵌套 Workflow，不能用 internal 定义绕过入口限制。详见[Agent 参考](../reference/agents.cn.md)和[Workflow 参考](../reference/workflows.cn.md)。

### 后台 Task 一直等待 permission 或 question

本项仅适用于 Agent Task，且管理 caller 必须是有权限的 managed `primary`/`all`
owner 父 Session。Command 的 `pending` 只有空列表与 `supported:false`；Bash
执行前的宿主权限批准不是 command Task 交互回复。

默认回到 OpenCode 根会话，在原生权限或问题提示中操作。父 Agent 应报告等待并保留原请求，不重复提问或代答。仅用户明确要求代为处理当前请求时，才先调用 `o4e_task pending` 刷新宿主请求和 Task revision，再用最新 `revision` 作为 `expectedRevision` 调用 `permission.reply`、`question.reply` 或 `question.reject`；任务目标、已知答案或笼统“继续”不等于代操作授权。

若回复返回 `reply-submit-unconfirmed`，表示提交或提交后的宿主确认失败；Runtime 已把 request 恢复为 `pending`，不会自动重发。重新调用 `pending` 确认宿主当前状态后再决定是否重试。修改插件代码或运行时适配后需要重新构建并重启 OpenCode。

### Watch 返回 `O4E_TASK_OUTPUT_TOO_LARGE`

Watch 的公开状态与结构化结果各有 49 KiB 预算。选择大量 Task 后
超限时，工具会在确认终态回执前拒绝；请显式提供更小的 `taskIDs` 集合，
分批读取。预算拒绝不会把这些任务标记为已交付。

Watch/status 不带结果正文；每次 output 都返回正文，不受此前读取影响。
公开状态被宿主截断或压缩时不能用于事件去重。Inspect 的预览被截断或压缩时，
resume 会报告不可用；可省略 resume 和手动游标重新查看当前 tail。

### 后台 Task 长时间停留在 `queued`

以下激活与 retry 状态仅适用于 Agent Task，不适用于旧 command claim。watch 返回 heartbeat 或可操作状态后，先向用户报告状态再继续 watch；Runtime 不会自动制造可见的合成进度消息，中间 TUI 显示依赖宿主。真实用户消息和终态/显式等待状态优先。

先用 `o4e_task` 的 `status` 或 `watch` 确认同一父 Session 是否仍有 `starting`、`running`、`retrying`、`waiting_permission`、`waiting_question`、`waiting_tool`、`waiting_workflow`、`waiting_retry_decision` 或 `cancelling` 的 Task；这些状态会占用 admission 槽。已经受理但执行、取消或 Session 状态仍无法确认的 `unknown` 也可能保守占槽，写 Task 还可能继续持有或等待 Scope Lock。Scheduler 在同一 owner/kind lane 内按 sequence 顺序准入至并发上限，不按 read/write mode 阻塞或跳过另一类别；实际写冲突由 Scope Lock 处理。根 read 可与写任务并行，不提供一致性快照，准入顺序也不保证全局执行 FIFO。

同一目录内的 Scope Lock 跨 owner Session 共享，但仅限同一 OpenCode 进程；不要让多个进程同时操作同一项目。插件代码或运行时适配刚更新时，先重新构建，完全关闭旧 Runtime，再重新打开原持久化父 Session并发送一条真实用户消息；这是该 Session 的 Agent Task 显式激活点，会定向恢复并派发其中可恢复的旧 Agent Task。插件启动、普通查询和 synthetic continuation 不会触发这一步，也不会全局派发其他父 Session 的历史 Task。若激活后没有占用槽位的 Agent Task 但 queued 仍不推进，保留 `taskID`、父 Session ID 和 `OPENCODE_FOR_EVERYTHING_DEBUG=1` 的脱敏日志；不要手改 `.opencode/` 生成物或 Session metadata。详见[配置参考的 Background Task 章节](../reference/configuration.cn.md#background-task)。

### 后台 Task 在长上下文压缩后仍显示 `running/model-running`

本项只描述 Agent Task 的模型执行与消息 lineage；command 不运行模型。

Background Task 的初始 `dispatchMessageID` 必须跨 OpenCode 自动 compaction 保持稳定。当前 Runtime 会识别宿主持久化的 `compaction` user message、compaction summary 和带 `synthetic: true`、`metadata.compaction_continue: true` 的 continuation user message，并将同一连续消息链中的最终 Assistant result 或 error 对账回原始 dispatch；它不会把 compaction summary 本身当作业务结果。若链中出现无关 Assistant、普通 user message、残缺 compaction 三元组，或原 dispatch 已经出现终态 result/error，Runtime 会停止扩展 lineage，避免把后续无关消息误归因到旧 Task。

子 Session 已有 continuation 最终消息而 Task 仍为 `running/model-running` 时，在原父 Session 发送真实用户消息触发定向恢复，再使用 `o4e_task status` 或 `watch` 检查 Task 是否收敛到 `completed` 或显式 retry decision；模型错误不会直接变成 `failed`。不要手工修改 Session metadata。若仍无法收敛，请保留原始 `taskID`、`dispatchMessageID`、子 Session ID 以及脱敏后的 user/assistant parent 链。

模型错误出现后，O4E 不会自动重试或切换 fallback。确认 `waiting_retry_decision` 中保留的
错误原因和 revision，由拥有 Task 的主 Agent 在既有授权内显式执行
`resolve continue|restart|stop`。错误分类与候选只作建议；宿主 provider 可能在插件之外内部
重试，O4E 无法关闭或观察其每一次尝试。

### Bash 被拒绝或 Command 没有完成

全局受管 `bash` 已是 command 创建入口；native `keep` 只保留身份和配置，不保留
 builtin 工具实现。执行使用宿主 `config.shell` 选择的 Host Shell，不限定 Linux 或
 某一种 Shell，也不回退到 O4E 自己选择的其他 shell。普通脚本、展开、赋值、
Unicode、引号和反斜杠不会因 O4E 语法白名单被拒绝。先看宿主权限决定、执行 cwd
和 Bash 返回的错误；不要把权限拒绝当作语法错误。公开插件 API 不提供其他插件的
`shell.env` hook 分发，依赖该 hook 注入变量的环境需单独核验。

先区分 1 秒 admission 等待、开始 running 后的 10 秒等待与默认 120000 毫秒 execution
timeout。Queued/running 快照和过程 tail 均不表示完成，需要在原 owner Session 中显式
指定该单个 command `taskID`，用
`status/watch/inspect/output/cancel/pending` 管理。Watch 省略 selector 时包含 owner Agent 和 Command，允许混合 `taskIDs`；其他动作只接受单个 taskID。Command 无 input、restart、交互或
Agent receipt 自动唤醒。Queued 可能在等待 command lane 的资源额度或准入处理；
Bash 不获取或借用执行 Scope Lock，不因可写 Agent 的锁而排队。Child 仍须验证可信冻结的 `unknown-write` 权限，不会升级 read/scoped authority。

Inspect/watch reader abort 不取消 command；Bash 脱离后其原 reader abort、普通 root
owner idle 和根回合的 `MessageAbortedError`/`AbortError` 也不取消执行。根回合 abort
只临时抑制跟踪。附着 Bash 调用方 abort、显式 Task cancel、owner 删除、受管 child 生命周期
终止/取消和 disposal 仍发起取消。要停止后台命令，使用获授权的 `o4e_task cancel` 并核对
停止状态，而不是仅中止根对话；后台运行不提供跨宿主重启的常驻服务。
重载只可重接进程内 handle，不重执行旧 claim：未提交且没有 live launch 的记录
进入 `interrupted/not-submitted`，已 claim 但 handle 丢失时保持 `unknown` 和 Command 资源槽位。
取消停止未确认或 canonical SQLite 持久化失败时同样保留 admission 与不确定记录；不要手改 ledger
释放槽位或自动重新执行。重试取消或 disposal 只重试停止证据/持久化，不会启动替代命令。

内存视图最多 64 KiB，inspect 只分页该视图。Bash 模型正文另限 48 KiB/1800 行，超限
返回 tail 和前置控制信息。结构化 `o4eResult` metadata 预算为 Bash 20 KiB、其他 command 动作 40 KiB。
完整文本在仓库外私有 `logPath`，可经获准宿主文件工具分段读取。日志单条上限 256 MiB，
终态结算后 24 小时惰性清理且保护活动日志。`logComplete:false`/`logError` 表示存档尚未完成或失败，
不能把 `totalBytes`、hash 或有界 metadata 当作完整文本；过期路径可能已删除。
此机制仅限进程内协调，不是 sandbox，也不保证停止 `setsid`/`setpgid` 逃逸后代。更多细节见
[command 参考](../reference/configuration.cn.md#managed-bash-and-command-tasks)。

## 状态检查

```bash
node scripts/installer.mjs status --target /path/to/project
node scripts/installer.mjs status --global
```

项目级状态会检查 `.o4e/` 和生成运行时；全局状态检查全局配置、运行时和插件注册。

完整命令参数见 [CLI 参考](../reference/cli.cn.md)。

## 调试日志

需要观察插件配置接管、模型解析或 fallback 时，临时启用：

```bash
OPENCODE_FOR_EVERYTHING_DEBUG=1 opencode
```

不要提交含有项目内容、凭据或完整上下文的调试日志。环境变量和全局路径差异见[环境变量参考](../reference/configuration.cn.md#环境变量)。

## 另请参阅

- [CLI 参考](../reference/cli.cn.md)：安装器和构建器命令
- [配置参考](../reference/configuration.cn.md)：配置字段和默认值
- [Agent 参考](../reference/agents.cn.md)：Agent 类型和权限
- [Workflow 参考](../reference/workflows.cn.md)：Workflow 定义和执行
- [环境变量](../reference/configuration.cn.md#环境变量)：运行时环境变量和调试开关
