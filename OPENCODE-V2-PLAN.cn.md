# OpenCode V2 适配方案与当前状态

[中文](OPENCODE-V2-PLAN.cn.md) | [English](OPENCODE-V2-PLAN.md)

## 结论

### 全拒绝预览的宿主合并防护（仍仅限隔离项目）

生成器现随 `.opencode/agents/` 输出一个隔离用 `.opencode/plugins/o4e-v2-preview-guard/`，在公开 `session.context` 与 `session.model.request` 核对有效 Agent 身份、预览标记、最后一条全拒绝权限及可见工具；对预览 Session 的宿主权限请求额外设 `deny`。模型前拒绝“生成后把 `shell: allow` 追加在 `deny` 后”的变更；隔离同名项目配置追加 `allow` 实测最终仍为 0 工具；假模型主动请求未展示的 `shell` 也未执行命令。该防护只限守卫被正常加载的隔离环境，**不证明**全局同名 Agent 的来源、其他插件不会覆盖 hook、生产安装安全或 V1 受管执行。`node test/acceptance/v2-agent-preview.mjs --tamper|--collision|--probe` 分别验收上述情形。

`--package` 验收另用本地 `npm pack`、临时安装产物中的 CLI 构建预览，并由真实 2.0.15 宿主加载守卫；不执行 npm 发布或在用户现有项目安装。

后续另在 Zellij 独立 Tab、仓库外隔离 HOME/XDG 下用真实 `newapi-openai/gpt-6-luna` 验证了当前源码的生成预览：正常运行返回 `LUNA_V2_PREVIEW_OK`，宿主退出 0，无工具调用；追加 `shell: allow` 篡改同一预览 Agent 后，守卫在模型请求前报 `O4E_V2_PREVIEW_AGENT_UNVERIFIABLE`，宿主退出 1，未发生工具调用。临时 V2 配置权限为 `0600`，仅存环境变量密钥引用；包装脚本在仓库外，不进入本提交，也不读取/改写用户 V1 配置。这不证明已发布 npm 包的真实模型使用、生产安装或受管执行。

独立审查后补充了隔离 XDG 下同名**全局** Agent 的实机对照，仍显示 0 工具，但名称及最终拒绝不证明来源归属；用户操作必须同时隔离 HOME/XDG，不能仅新建空目录。守卫只拒绝**自身 Agent 为预览身份**的 Session 权限请求，不宣称继承限制其他身份的子 Session。variant 对 `high+fast` 等单行值采用安全引用转义；包含 `#` 的值仍拒绝投影而不暗中改变解析语义。

### 独立 V2 契约与父链权限实证（非 V1 等价）

根 `SPEC.md` 的 `V2-NAT-001`–`005` 是获准定义的**增量目标**，不是当前已完成能力；V1 受管契约仍有效。OpenCode 2.0.15 隔离宿主、独立 HOME/XDG、本地假模型的对照：不装收紧 hook 时，原生子 Agent 的 `shell: allow` 执行了父 Agent 资源规则 `deny` 的命令；在公开 `permission.hook("evaluate")` 中通过 `session.get(child.parentID)` 取得父 Session 的 `agent` 后，把该子 Shell 决策由 `allow` 改为 `deny`，真实命令没有产生副作用；强制公开 `session.get` 查询不存在的 Session 报错时，Shell 同样没有执行，但子任务返回的文本仍可能标为 `completed`。对应夹具：`node test/acceptance/v2-native.mjs native-child-permissions native-child-parent-hook native-child-parent-hook-failure`。这些证据仅说明**单次原生 Shell 授权可收紧且读取失败没有放行**；父规则动态求值、祖先链、其他工具、ask 审批、错误可见性与进程重启均未证明，不能宣称已经实现 O4E 父级权限继承。原生子 Agent 默认仍按自身权限执行。

新增 `src/adapters/opencode-v2/session-ancestry.mjs` 只通过公开 `session.get` 沿父链逐个读取 ID 与 Agent 身份，限制最大深度并拒绝缺失、ID 不符、循环与接口失败；单元测试覆盖这些失败边界，`native-child-bounded-ancestry` 在隔离实机证明有界读取与一次 Shell 收紧可组合。它不从 Agent 名推断文件归属，也不解析父 Agent 权限，因此不自动授予任何执行能力。

当前独立 V2 用户可用范围：隔离 opt-in 的只读状态工具/TUI 命令，以及空项目的全拒绝 Agent 预览；原生 Shell/子 Session 路径是测试探针，未加入生产执行入口。完整 V2 安装、Agent 归属、动态授权收紧、后台管理与恢复、原始 Tool Part 后续更新以及 V1 等价性均未完成。当前独立契约及验收条件以 `SPEC.md` 为准，不因本页实验叙述放宽。

### 独立 V2 Agent 生成切片（显式 opt-in，非受管执行）

新增 `npm run build:v2-preview -- --config-root /absolute/.o4e --target /absolute/empty-project`：
使用现有 Builder 的配置校验、Agent 和 Plan 展开，只向**已存在且完全空白的独立目录**输出前缀
`o4e-v2-preview-` 的 V2 Markdown Agent（mode、可选模型、全拒绝权限）；不导出仍声明受管工具的
V1 提示词，不修改 V1 Builder/安装器和现有 `.opencode/`。拒绝目标 symlink、非空目录、无效配置，
先在私有临时目录准备文件再提升。`node test/acceptance/v2-agent-preview.mjs` 的真实 OpenCode
`2.0.15` 隔离假模型验证生成的 13 个 Agent 中选定只读 Profile 能进入模型上下文、可见工具数为 0。
该切片不处理全局同名定义合并或生产 Agent 所有权、授权委派和后台任务；不能称为完整 V2 迁移。

### 原生执行复用实测（Linux，固定 2.0.15）

新增独立实验 `node test/acceptance/v2-native.mjs`，不加载 O4E 受管 Runtime。
最初十项隔离实机用例通过，后续加入上述父链权限对照：生成 Markdown Agent 的身份、system marker、模型和有序权限可读取；
公开 `ToolEditor.update` 包装原生 `shell.execute` 后仍保留原生资源级 allow/deny，
permission 事件与包装调用的 Session/message/call ID 一致；非交互 ask 被宿主自动拒绝（退出 1），
显式 `--auto` 可允许；执行开始后 `session.interrupt` 返回、Shell PID 消失且无延迟写入。
原生子 Agent 创建了物理父链，但使用自身 allow，能执行父 Agent 禁止的命令。
此最后用例证明**与 O4E 权限收紧不等价**，不是受管委派通过。

因此，缺少工具 `ask` 不应再被解释为所有原生工具复用均不可行；原生 Shell 包装是值得继续验证的路径。
但它不是任意 O4E 副作用的授权入口。人工审批 UI、审批中取消、复杂进程树、生成物归属/冲突、
委派深度、后台/重启恢复及完成后原始 Part 更新均未验收，受管 Gate 未打开。
首次夹具遗漏 CLI 显式模型，宿主回退到内置免费模型并超时，该次失败不计通过；未使用用户凭据，
但不能称为仅本地请求。最终夹具显式固定本地假模型，并在 `model.request` 拒绝非 fixture provider。
本次仅新增测试资产与证据说明，没有改动产品执行实现或契约。

上游最小接口需求草案：[中文](OPENCODE-V2-UPSTREAM-API.cn.md) / [English](OPENCODE-V2-UPSTREAM-API.md)；仅作讨论，尚未提交上游。

### 最新可交付切片（独立 V2 preview，不是受管执行）

另有独立 CLI-only 导出 `@hymsk/o4e/v2/tui`，用 `@opencode/plugin/tui/plugin` 的公开 CLI 插件入口和组件作用域内的 Keymap 接口注册显式调用的 `o4e-v2-status` 只读命令；它仅在调用时读取当前 CLI location 的本地 `.o4e/`，显示配置计数与 `managed execution: unavailable`，配置读取失败不回退或泄露错误内容。它**不是** V2 受管 Task TUI、服务端状态或 V1 `./tui` 的自动替代。隔离 `cli.json` 只加载 CLI-only 插件，不把它放到自动发现的 server 插件路径。Linux 真实 OpenCode `2.0.15` 全量 TUI 已从实际 npm 安装产物加载该命令，显示 13 个 Agent、0 个 MCP 和执行不可用，正常退出 0；早期直接在 setup 调用 Keymap 及误作为 server 插件加载的失败均已纠正，最终隔离运行无插件失败提示。没有验证 V2 受管执行或多平台。

根据[官方迁移指南](https://opencode.ai/v2/docs/build/plugins/migrate-v1/)，V1 插件实现不能在 V2 直接运行，而受支持的 V1 配置无须先整体改写。当前 npm 包新增独立导出 `@hymsk/o4e/v2`，并固定 `@opencode/plugin@2.0.15` 运行依赖；V1 `./server` / `./tui` 导出、Builder 与安装器的 V1 注册保持不变。preview 只读 `o4e_v2_status` 对配置中的 MCP 仅报告数量与 `mcpProjection: unavailable`，不注册 MCP、不修改 Agent 或接管其权限，也不禁止 V2 宿主原生工具。

仓库外无凭据、独立 HOME/XDG 的验收命令 `node test/acceptance/v2-preview.mjs` 会从当前源码执行 `npm pack`、安装该包，配置仅含本地假模型和不可执行的合成 MCP，按 `@hymsk/o4e/v2` 的**实际发布导出**加载，要求模型看到 `o4e_v2_status` 的真实 Tool 结果，并检查 `managedExecution: unavailable` 与 MCP 投影状态；`opencode2` 必须是 `2.0.15`。最新一次 Linux 实机验收返回 `status: passed`、退出 0，测试脚本记录 3 次本地 provider 请求（含辅助请求）。验收未使用真实用户模型与凭据，未验证真实 TUI、CLI 安装接线或受管执行；本地假 provider 证明的是传输/调用闭环，不是生产模型质量。

## 真实宿主隔离验证（OpenCode 2.0.15，Linux）

通过 Zellij 的独立 Tab，在仓库外的临时目录使用 `env -i` 指定隔离的 `HOME`、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME`、`XDG_RUNTIME_DIR`，运行 `opencode2 debug paths` 和 `opencode2 mini --standalone`。实际观察到全部用户数据/配置/缓存/状态路径指向该隔离目录，mini TUI 显示 `v2.0.15` 并正常启动；用 `/quit` 正常退出（状态 0）。未连接实际用户的后台服务、模型或配置。

只在该临时项目中配置目录型、无执行能力的本地探针插件。初次误将单文件列在 `plugins` 中，宿主日志明确警告 `configured plugin path must be a directory`，该次不计成功。改为目录 `package.json` + `index.mjs` 后，日志显示 `loading plugin`，探针 `setup` 在隔离目录写入了如下**仅布尔值**结果，正常退出时 `cleanup` 写入标记：

```json
{"version":"2.0.15","toolScopedAsk":false,"sessionCreate":true,"sessionMessages":false,"sessionActive":false,"permissionCreate":false,"toolTransform":true}
```

这只验证插件 `setup` 可运行以及这些属性在**插件顶层上下文**中的可见性；没有执行自定义工具，因此 `toolScopedAsk` 并非对工具调用上下文的运行时验证。`opencode2 api --standalone plugin.list` 在该隔离环境返回空数组，即使 `setup` 与 `cleanup` 已有标记；插件列表的作用域/时序仍待核实，不能把空数组当成未加载或活跃状态证据。曾尝试不带 `--standalone` 的 `debug config`，遇默认服务端口占用后中断，未将其计为验收。没有加载 O4E V1 插件，也没有验证 O4E V2 工具、真实模型、受管后台任务、权限交互或恢复。

### 后续真实模型与自定义工具验证

在用户明确授权读取现有配置后，识别到 V1 的 `newapi-openai/gpt-6-luna` 使用 HTTPS OpenAI-compatible endpoint 与权限为 `0600` 的 `{file:...}` 密钥引用。只提取该 provider/model 的必要字段，重新生成隔离的 V2 `providers` 配置（`0600`，无 MCP、无用户插件、无明文密钥）；独立包装进程在内存中读取密钥文件，将值通过隔离子进程的环境变量传给 V2。没有将密钥写入新配置、仓库或 CLI 参数；V2 进程及其 provider 可以使用此凭据发起实际请求，不能将此等同于凭据不可见。

在 Zellij 独立 Tab 运行 `opencode2 run --standalone --model newapi-openai/gpt-6-luna --agent build`：模型回复 `LUNA_OK`，退出码 `0`。第二轮使用同一模型实际调用隔离插件注册的只读 `o4e_v2_probe` 工具，工具返回 `PROBE_OK`，模型复述结果，退出码 `0`。工具执行时仅记录上下文属性的类型：`sessionID`、`agent`、`messageID`、调用 `id` 均为字符串，`signal` 为对象，`progress` 为函数，**`ask` 与 `permission.create` 均为 `undefined`**。探针未执行 Shell、委派或文件修改；它的成功只证明 V2 自定义工具注册及调用可用，不能替代受管工具授权验证。

结论：V2 + `gpt-6-luna` 的独立模型与只读工具调用已在 Linux 实测，但工具调用上下文缺少 O4E 所需的资源级宿主审批。`DEL-003` / `CMD-004` Gate 仍未满足；受管执行不能安全接线，原始 Part 更新、父 Session 创建、分页来源及恢复仍待验收。**当前不能保证 O4E 在 V2 可用**，没有在真实 V2 上运行受管 O4E Runtime 或迁移旧 Task 账本。

### 独立 V2 preview 适配器（部分验证）

新增 `src/plugin-v2.mjs` 和 `src/adapters/opencode-v2/compat.mjs`，与 V1 `src/plugin.ts` 分离；当前在**手工配置的隔离 V2 项目**里作为 preview 入口加载，安装器和 CLI/TUI 尚未接线。适配器读取已选定的 `.o4e/` 定义；V2 AgentEditor 仅支持更新现有 Agent，不支持创建，因此不生成 O4E Agent，也不伪装接管 `build`、`plan`、`general`、`explore`（包括原生 `keep`）。纯函数提供 O4E 权限“只收紧、不放宽”的候选计算，但**不应用到宿主 Agent**：名称相同不能证明归属，错误接管会破坏 `keep` 或其他用户 Agent。全局 `config`、完整 Agent、Prompt、Skill、模型和 MCP 投影尚未接线；如果定义包含 MCP server，preview 只计数并报告未接管，不注册 server。现阶段的 preview **不施加全局原生执行禁令**，不能依靠它隔离宿主原生工具。

只读工具 `o4e_v2_status` 标明 `managedExecution: unavailable` 和缺失 Gate；不提供受管 `bash`、`task`、`o4e_task` 或 Workflow。在既有隔离夹具实际运行 OpenCode `2.0.15` 与 `gpt-6-luna` 时，最初夹具找不到 `@opencode/plugin`，该次未加载成功；后续隔离夹具以固定发布包 `Plugin.define` 的等价 identity 入口载入相同适配器模块，并把 status 工具标记为 `codemode:false`，模型实际调用 `o4e_v2_status`，返回 `managedExecution: unavailable`，进程退出码 `0`。此证据仅覆盖适配器模块和只读工具，**未验证 `src/plugin-v2.mjs` 的真实 npm 包依赖安装与加载，也未证明原生权限 Gate**。

后续在仓库外 `/tmp` 隔离目录使用 `npm install --no-save --no-package-lock --ignore-scripts @opencode/plugin@2.0.15` 安装固定依赖，复制未修改的 `src/plugin-v2.mjs`，将其相对引用指向仓库适配模块；Node 实际解析了 `@opencode/plugin` 并检查 `Plugin.define` 导出的插件对象。再让隔离 OpenCode `2.0.15` 项目通过转发入口加载该副本，真实模型调用 `o4e_v2_status`，报告 `managedExecution: unavailable`，命令退出码 `0`。这验证了**隔离副本的真实依赖解析和只读工具调用**，并不等同于发布包安装、安装器/CLI/TUI 接线或完整生命周期验收。Host Port、Feature Gate 和注册清理层已加入，未验证的授权、父链、分页来源、原始 Part 更新及其他执行依赖保持不可用；`npm test` 全量回归 `1564/1564` 通过。

继续核对固定发布包的 `promise/tool.d.ts`、`promise/permission.d.ts`、`promise/session.d.ts` 后，仍未找到可替代 G1–G4 的已证明公开插件接口。preview 的工具 transform 在重放时会检查宿主同名工具，拒绝覆盖；含 MCP 配置的定义仍在注册前拒绝，宿主注册失败也直接报错。隔离真实模型再次调用只读工具得到 `configured: true`、`managedExecution: unavailable`；不等于受管执行已可用。本次全量 `npm test` 回归 `1567/1567` 通过，`git diff --check` 通过。要闭合完整 V2 Runtime，必须由上游提供并验证所列宿主能力，之后再完成 Runtime、CLI/TUI 及发布包生命周期验收；不得靠 Port 外观或配置翻译假装完成。

相似接口补查：`ToolContext` 的 `sessionID/agent/messageID/id` 可在执行期间绑定调用来源，`progress` 可在工具仍运行时更新进度；新增 `tool-call.mjs` 限定其生命周期，并在缺少来源时拒绝执行。`permission.hook("evaluate")` 只审查宿主已有决策，协议层 `permission.create` 未注入普通插件；`session.context` 虽已公开但无 cursor/limit，不能作为有界消息来源；完整客户端的 `message.list`、`session.active` 未进入普通插件 Context；`session.create` 请求没有 `parentID`；`ToolContext.progress`、`tool.execute.after` 和 `session.synthetic` 都不能在返回后更新同一个原始 Part。故这些相似接口均**不能提升 G1–G4 Gate**，受管执行仍保持关闭。隔离真实宿主已再次成功调用只读状态工具。

以上兼容层完成后，全量 `npm test` 最新通过 `1570/1570`，`git diff --check` 通过；先前的 `1564/1564` 和 `1567/1567` 分别是更早阶段的回归记录。

### 深挖 Plugin 接口与替代方案（固定 2.0.15）

继续核对 `@opencode/plugin/dist/promise/adapter.js` 的实际 Context 组装、Effect/Promise 两种类型、`@opencode/client` 和 `@opencode/protocol` 的公开类型，并在隔离宿主记录普通插件 Context 的**属性名称而非数据**。运行时 `permission` 仅有 `get/hook/list/reply`，`session` 仅有 `context/create/get/hook/interrupt/prompt/update/wait` 等受限成员；`rpc` 是注册并调用插件自定义 RPC 的工厂，不是宿主内置 API 代理。官方在线文档中出现的 `ctx.permission.rules` 不在固定版本的类型、Promise 适配器和实测 Context 中，不能据此开启 Gate。完整 `@opencode/client` 确实有 `permission.create`、`message.list`、`session.active`，但普通插件没有注入该客户端；另外完整客户端也没有创建带 `parentID` 的请求或已完成原始 Tool Part 的更新方法。不能改用裸 HTTP、私有宿主对象或另建凭据连接来绕过注入边界。

`Tool.Options.permission?: string` 也经过最小隔离实测：给无副作用探针工具设 `permission: "shell"`，在默认权限下模型调用后，工具直接执行并返回，未观察到 `permission.hook("evaluate")` 的调用；进一步设置显式 `shell: deny` 时，模型报告工具不可用，探针未执行。这只证明宿主可能据权限**过滤工具可用性**，不能证明每次执行都已按 Shell 命令资源发起审批，更不能靠该字段获得动态命令的资源级授权。状态能力矩阵新增相似接口的单独条目和回归断言，不将它们提升为 G1–G4。上述探针仅写入仓库外隔离目录，未注册 O4E 受管执行工具。

额外在仓库外安装 `@opencode/plugin@2.0.16` 及对应 `@opencode/client`、`@opencode/protocol`、`@opencode/schema`，与 `2.0.15` 比较 `promise/permission.d.ts`、`session.d.ts`、`tool.d.ts`、`rpc.d.ts`，这些声明无差异；没有把新版本视为宿主实机验收或自动改变目标版本。

本轮完整回归 `npm test` 为 `1571/1571` 通过，`git diff --check` 通过；之前的通过数是历史阶段快照。

目标宿主为 **OpenCode 2.0.15**，不是 V1 包内的 `@opencode-ai/sdk/v2` 子路径。
当前 O4E **尚不支持 V2 完整运行**。本阶段实现独立 preview 入口、收紧型投影与权限传输转换，不接入受管执行，也未更换 V1 入口或 SDK。
规范仍以根 `SPEC.md` 为准；本页是适配方案，不是降低权限和生命周期要求的替代契约。

## 已核实差异

依据官方迁移指南以及 npm 发布的 `@opencode/plugin`、`@opencode/schema`、`@opencode/protocol` **2.0.15**：

| 范围 | V2 变化及 O4E 影响 |
| --- | --- |
| 插件入口 | `Plugin.define({ id, setup(ctx) })`；V1 返回 hooks 的函数不能直接运行 |
| 配置投影 | 全局 `config` hook 拆为领域 transform；回调必须同步、可重放，不放文件读取和一次性副作用 |
| 权限 | 有序 `{action,resource,effect}[]`，`bash → shell`、`task → subagent`；转换必须保序，不能把 allow 当审批 |
| 工具 | JSON Schema 和结构化 content；Tool Context 无 `ask`，权限域仅提供 list/get/reply/evaluate hook |
| Session | 插件域不提供 list、active、分页 message API；HTTP 协议存在部分端点不表示插件自动拥有它们 |
| 子 Session | `session.create` 公共 payload 不含 `parentID`；不能用独立根 Session 冒充原生子 Session |
| 消息 | `prompt` hook 在持久准入之前；不能把 hook 返回当持久化证明。context 的模型消息不是原始 Message/Part |
| 展示 | 不能假定 `progress` 可在工具返回后修改已完成原始 Part；旧 TUI 入口也需要单独移植 |
| CLI | 默认共享后台服务，配置热重载；必须重验 Location、实例共享、取消和释放 |

这些缺口阻塞完整 Runtime 接线，不能使用裸 fetch、宿主私有 API、全历史读取、仅靠事件缓存或默认允许规避。

## 分阶段实施与验收

1. **基线与并存**：保留 V1；固定 V2 包证据；使用无凭据、独立 HOME/XDG 的验证目录。只读 preview 已完成安装产物的本地假模型工具调用验收，不等于受管执行验收。
2. **传输转换**：独立 `src/adapters/opencode-v2/`；首个权限转换保持规则顺序、资源字符串及 effect，拒绝未证明等价的 action 模式。仅单元验证，不参与授权。
3. **V2 原生语义与可信接口**：先明确 V2 工作台、真实执行、来源与恢复各自契约；需求草案所列 ask、parentID、分页来源和原始 Part 更新是当前 V1 等价能力的缺口，不预设为 V2 原生产品的全部前置接口。任何受管副作用仍须通过可实测的宿主权限与停止边界；不得直接修改宿主或发布 issue。
4. **Runtime 接线**：原生契约和所需接口具备后再评估哪些 V1 领域规则可复用，哪些 SessionStore、执行端口和账本必须独立实现；验证 deny/ask、身份、取消、停止证据和恢复。V1 等价性另设 Gate，不将当前 preview 称为完整迁移。
5. **投影与 UI**：拆分 Agent/MCP/Skill/模型 transforms、Prompt hooks、CLI 插件。选择独立 V2 入口，避免要求现有 V1 用户升级到 1.18.29 才支持的双对象入口。
6. **发布 Gate**：V1 全量回归、V2 安装包真实加载、真实模型、工具与 TUI、正常退出/重启验收；未取得对应证据前不标记完整支持。Windows/macOS 单独验收。

## 平滑配置与秘密边界

V2 官方支持在内存归一化既有 `opencode.json(c)` 和文件定义，**无需先改写 provider/MCP 配置**。
V1/V2 默认使用同一配置目录，CLI 首次启动还可能迁移设置，因此验证时不能直接启动实际用户环境。
不读取 `auth.json`、数据库凭据、`.env`、完整环境变量或可能内嵌秘密的宿主配置；不能把“读完再脱敏”等同于“未读取秘密”。
本阶段没有复制或转换本机 provider/MCP/用户配置。配置行为验证使用合成无秘密样例；个性化设置需要用户提供经其审查的白名单片段。

官方 V2 安装器为 `https://opencode.ai/v2/install`，会覆盖默认 `opencode`，并创建 `opencode2` shim；它不是独立配置隔离器。
需要并存时保留 V1 二进制，V2 使用独立名称；两个名称仍可能访问同一配置和数据，不要依靠改名隔离状态。
不要为回滚调用 `uninstall`，因为它可能删除版本间共享的配置、数据和缓存。升级器也可能覆盖手工并存布局。

## 来源

- [V1 → V2 迁移](https://opencode.ai/v2/docs/migrate-v1/)
- [插件迁移](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [V2 插件 API](https://opencode.ai/v2/docs/build/plugins)
- [V2 CLI](https://opencode.ai/v2/docs/cli/)
- 固定发布包：[@opencode/plugin 2.0.15](https://registry.npmjs.org/@opencode/plugin/2.0.15)、[@opencode/schema 2.0.15](https://registry.npmjs.org/@opencode/schema/2.0.15)、[@opencode/protocol 2.0.15](https://registry.npmjs.org/@opencode/protocol/2.0.15)。

网站会更新；API 结论须以固定发布包复核，不把 Git 标签日期当 GA 发布日期。
