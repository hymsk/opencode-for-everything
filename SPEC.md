# O4E V1 产品与工程契约

本文件定义 `opencode-for-everything` 当前的产品与工程要求。文件属于本仓库，不会作为 O4E 项目契约被安装、导出、导入、解释或管理。

## 契约权威与文本真实性

本文件是本仓库唯一的产品与工程契约。`AGENTS.md` 只负责指向本文件和任务阅读入口，不重复维护行为要求。`CONTRIBUTING.md` 维护贡献流程；README、使用文档、Prompt 和 Skill 不构成另一份产品契约。

- 实现、Schema、测试和 CLI 用于证明当前行为及其与本契约的差异；当前实现不符合本契约时，记录为实现缺陷或未完成项，不得仅为迁就现状而降低本契约。
- 契约调整必须有明确的需求变更授权。已知缺陷、历史实现、测试通过或某个平台的使用习惯不构成缩小要求的授权。
- 使用文档必须准确描述当前可用行为，并明确标注与契约之间的缺口和未验证项；不得将目标要求写成已经实现的事实，也不得将缺陷写成获准的产品边界。
- 默认中文沟通，技术标识、命令、路径和 API 名称保留原文。不得记录凭据，覆盖无关用户改动，或未经授权提交、推送、发布。
- 默认配置的真实源为 `defaults/.o4e/`；安装目标的 `.o4e/` 是用户可编辑源，`.opencode/` 是生成物，不手工修改。根 SPEC 不进入安装目标或导出归档；`.test/`、构建产物和用户安装目录不提交。
- 公开文档仅收录使用与贡献所需内容，不引用仓库外维护记录。公开说明保持中英文语义一致；修改配置、CLI、权限或默认资源时，同步检查对应 Schema、使用文档和测试。不得把 Prompt 文字当作安全边界。

### 正常使用与异常处理范围

本契约仅要求处理用户通过支持的 UI、CLI、配置和受管工具正常使用时可达的异常。同一 Session 按单一用户操作入口使用；正常委派产生的子 Session、后台任务并行、用户插话与取消、权限交互、压缩，以及顺序退出后重启/恢复仍属于正常使用。模型生成错误工具参数也属于公开入口应处理的正常异常。

范围内的异常包括上述路径中实际可能发生的模型/provider 错误、宿主接口读取或写入失败、响应丢失、超时、进程中断及存储延迟。异常要求必须说明正常操作入口、必要触发条件和可观察影响，不能仅凭内部状态可以被改坏就判定为用户缺陷。

不要求处理绕过支持入口直接篡改内存、数据库、Session 权限、账本或内部事件的注入场景，也不要求多个窗口、客户端或独立进程同时操作同一 Session 的冲突协调。此处“注入”指直接改写内部状态或伪造宿主事实，不免除对模型工具输入的校验。上述排除场景不作为必修缺陷或发布验收门槛；既有检查和测试不因此自动删除。

测试可以模拟已经说明正常来源的接口失败、延迟或中断以验证错误处理，但模拟成功不证明真实宿主已经发生或完成验收。仅有直接状态篡改、孤立模块调用或多窗口竞争证据时，必须标为范围外或正常路径待证，不能外推成正常使用故障。本节限定下文权限漂移、来源损坏、并发、恢复等要求的适用场景；现有正常入口的权限、取消、锁、去重和不确定结果拒绝要求仍保留。

### 跨平台要求与验收

O4E 开发于 Linux，主要在 Linux 上开发和验证；对 Windows、macOS 等其他系统提供基本兼容，不宣称完全支持。基本兼容表示保留安装、构建、Shell、路径及进程管理的平台适配，不表示完整任务生命周期已通过目标系统实机验收。命令细节遵循 `CMD` 条款；不能仅为文案调整移除现有平台实现、权限或停止证据检查。

如要扩大平台支持声明，须核对对应目标平台的默认及显式 Host Shell、参数协议、路径、编码、进程启动与终止、超时与取消、日志及恢复的正常和失败路径。存在平台分支、Mock 测试通过或仅在 Linux 上通过全量测试，均不足以声称完整跨平台支持已经完成。未获得目标平台实际验证证据时，必须明确报告未验证，不得宣称已通过。

OpenCode 验证基线统一为 `>=1.18.21`，仅作为公开验证范围说明，不新增运行时或安装器版本硬拦截，不声称每个后续版本均已逐一验证。具体验收证据保留实际宿主与 SDK 版本。开发与 CI 使用 Node.js 24 直接加载 TypeScript 测试入口，安装器 Node.js 下限为 20.12；SDK 开发依赖固定于 1.18.21，与 CI 宿主基线一致。

## 产品边界

O4E 是一个 OpenCode 插件系统，可将 `.o4e/` 配置转换为生成的 `.opencode/` 运行时。它提供可配置 Agent、嵌套受管委派、持久化后台任务、声明式 Workflow
执行与校验、提示词组装、模型选择传递以及安全的安装器生命周期操作。

包含范围：

- 仅支持 OpenCode 作为宿主。
- V1 Agent 布局：`agents/{system,all,primary,subagent}`。
- 项目级和全局配置根目录。
- Agent、Plan Profile、Prompt、Skill、Soul、MCP、权限和 Workflow 配置。
- 使用受管 `task` 进行 Agent 委派，使用全局受管 `bash` 执行直接命令任务；包含按类型区分的任务管理、Session 持久化、恢复、Effect 与 Scope Lock；
  终端回执仅适用于 Agent 任务。
- 安装、构建、状态查看、导入、导出、模型配置修改、全局注册和卸载。

不包含范围：

- 独立的 Agent 进程或服务。
- Agent Card、HTTP/SSE 网关、推送通知或远程 A2A 网络。
- OpenCode 之外的宿主。
- 在消息时刻的协调尚未解析最新用户指令前，派发新的 Workflow Step。
- 将任何项目契约文件名（包括 `SPEC.md`）视为 O4E 功能。
- 本首个版本的当前源码、Schema 和 CLI 契约未定义的任何 O4E 行为、别名或配置形态。

当前发布版是 O4E 的第一个且唯一的版本。在版本号保持不变期间，O4E 不得实现历史版本兼容、升级、迁移、旧协议读取器或缺失字段回填。仅接受当前配置和持久化
数据契约。仍支持重建、重新安装以及有效当前记录的恢复。无效或无法验证的记录必须以拒绝继续（fail closed）处理，且不得释放状态不确定的锁。

## 需求

### 配置（`CFG`）

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `CFG-001` | `.o4e/` 必须是可编辑源目录。`.opencode/` 必须包含生成的 Agent 和插件输出；O4E Skill 作为插件受管资源保留在 `.o4e/skills/`，不得复制到公开的 `.opencode/skills/`，也不得由其管理。 | `src/runtime-builder.mjs`; `src/adapters/opencode/plugin-hooks.ts`; 安装器测试；生成文件文档 |
| `CFG-002` | 未设置 `o4e_config` 时，Runtime 必须选择项目 `.o4e/`。仅当项目根目录不存在时才可以使用默认全局 `.o4e/`。选定根目录无效时必须拒绝继续（fail closed）。显式设置的 `o4e_config` 是唯一选定根目录。 | `src/runtime-builder.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/plugin-config.test.mjs`; `test/environment-mode.test.mjs` |
| `CFG-003` | 在同一配置根目录中，`config.jsonc` 必须覆盖 `config.json`。选定文件无效时，Runtime 不得尝试另一个文件名。 | `src/runtime-builder.mjs`; `test/plugin-config.test.mjs`; `test/runtime-builder.test.mjs` |
| `CFG-004` | `config.nativeAgents` 必须显式声明 `build`、`plan`、`general` 和 `explore`，每项取值为 `keep`、`managed` 或 `disable`。 | `defaults/.o4e/schemas/config.schema.json`; `src/core/native-agent-policy.mjs`; `test/runtime-builder.test.mjs` |
| `CFG-005` | 配置权限名称必须使用当前 OpenCode 规范名称。配置必须拒绝 `functions.*`、`apply_patch` 和 `write`；文件修改使用 `edit` 配置。 | `src/core/capability-policy.mjs`; `defaults/.o4e/schemas/agent-common.schema.json`; `test/runtime-builder.test.mjs` |
| `CFG-006` | 对同一插件实例，Runtime 配置、Agent 定义、原生策略、Plan 展开和 Workflow 定义必须保持静态。Prompt、指令、提醒和 Soul 文件内容可以在文档规定的钩子边界重新读取。 | `src/runtime/snapshot.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/runtime-architecture.test.mjs`; `test/plugin-config.test.mjs` |
| `CFG-007` | 原生 `keep` 必须保留宿主 Agent 的身份和配置，不得选择内置工具实现。插件同名的 `bash` 和 `task` 覆盖对普通工具调用全局生效；宿主权限仍适用，且 `keep` 不得获得受管 Agent 委派或 Agent 任务管理权限。 | `src/adapters/opencode/plugin-hooks.ts`; `src/core/native-agent-policy.mjs`; `test/plugin-command-task.test.mjs` |
| `CFG-008` | `o4e_mode` 未设置或为 `default` 时必须启用 O4E；字面值 `origin` 返回干净宿主投影；字面值 `clear` 保留 O4E 投影，但从本次最终运行时配置中移除顶层和 Agent 的 `model`/`variant`。空字符串、历史别名和其他值都必须回退为 `default` 启用 O4E，同时输出包含该非法值的错误诊断（写入宿主日志，并在 TUI 可用时弹出警告提示），不得静默忽略或直接拒绝。模式不得修改 `.o4e/`、凭据或宿主保存的模型库。`o4e_config` 必须是绝对路径（可选 `~/` 展开），每个插件实例只读取一次，新启动的宿主进程（如 `opencode -s`）会重新读取。 | `src/adapters/opencode/plugin-hooks.ts`; `test/environment-mode.test.mjs` |
| `CFG-009` | 默认 `default` 模式必须保留模型配置能力。config 支持可空 `defaultModel` 和 `fallbackModels`；可选择/可委派 Agent 支持可空 `model` 和 `fallbackModels`，Plan 继承源 Agent 的模型。模型使用 `provider/model` 或 `{id,variant}`；Agent 缺省或 null 模型继承全局默认，最终未配置时沿用宿主选择；省略 fallback 继承全局，显式空数组关闭。Builder、Schema、安装器和生成 frontmatter 必须一致。只有 `clear` 清除本次模型投影及内部候选链，绝不删除源字段。 | 配置 Schema；`src/runtime-builder.mjs`; `scripts/installer.mjs`; 构建和安装器测试 |

### Runtime 与构建（`RUN`、`BLD`）

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `BLD-001` | Builder 必须要求四个 V1 Agent 目录，并至少存在一个可选择的 `primary` 或 `all` Agent。 | `src/runtime-builder.mjs`; `test/runtime-builder.test.mjs` |
| `BLD-002` | 已安装目标不得保留 `agents/default.json[c]`；安装器必须将 `description` 实例化到具体 Agent JSONC 文件。 | `src/runtime-builder.mjs`; `scripts/installer.mjs`; `test/installer.test.mjs`; `test/runtime-builder.test.mjs` |
| `BLD-003` | 替换受管输出前，构建必须校验 Agent 名称、文件名、类型专属字段、Prompt 引用、Plan 冲突、Workflow 名称和 Step DAG；不支持的嵌套 Workflow、Loop、隔离声明和 Schema 关键字必须拒绝。 | `src/runtime-builder.mjs`; `src/core/workflow-definition.mjs`; 定义和构建测试 |
| `RUN-001` | 插件必须暴露当前 OpenCode 钩子及受管工具 `bash`、`task`、`o4e_task` 和 `o4e_workflow`。不得暴露 `o4e_delegate` 或 `o4e_delegate_background`。 | `src/adapters/opencode/plugin-hooks.ts`; `test/runtime-architecture.test.mjs`; `test/plugin-command-task.test.mjs` |
| `RUN-002` | 插件不得声明或依赖 `tool.execute.after` 钩子。作用域写入检查和副作用水印在 `tool.execute.before` 中执行。 | `src/adapters/opencode/plugin-hooks.ts`; `test/runtime-architecture.test.mjs` |
| `RUN-003` | 插件释放时必须在让出控制权前同步进入 Runtime 静默状态，停止新工作，等待已准入的 Runtime 操作及刷新，持久化不确定时保守保留锁，并在释放失败后仍可重试。 | `src/runtime/lifecycle.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/runtime-architecture.test.mjs`; `test/plugin-background-task.test.mjs`; `test/runtime-orchestration.test.mjs` |

### Agent 与 Plan（`AGT`）

可选的 `config.defaultAgent` 必须引用已配置且可选择的 `all`/`primary` Agent 或其展开的 Plan
Profile。名称无效或目标仅可委派时，配置加载必须失败；宿主禁用的目标必须在投影阶段失败。存在该配置时，它必须在接管原生 Agent 后覆盖宿主 `default_agent`。
缺省时不得添加默认选择，也不定义排序或选择记忆。安装器必须按目录显示顺序，将第一个启用且可选择的 Agent（通常为 `orchestrator`）实例化为 `defaultAgent`，排除
仅可委派的 Agent。普通构建不得改写此用户配置。

默认入口为 `orchestrator`，不是 `chat`。默认 `chat` 是只读纯对话 `primary`，使用 `plan.mode: "self"` 只生成 `chat (plan)`；不加载工具、Skill、MCP、Agent 或 Workflow，也不注入角色目录、委派协议及项目规则；其 Plan 提醒同样保持纯对话边界。不得用提示词代替最终权限拒绝。用户主动提供的聊天内容不属于插件可保证消除的知识范围。

受管子 Agent 的执行上下文必须依据已验证父链提供当前深度、最大深度和剩余可委派深度，不相信任务文本中的自报层级。达到最大深度时，在当前 child Session 权限中关闭 `task`；不得修改共享 Agent 权限而影响兄弟或根 Session，既有 Task 的管理能力不因此关闭。Runtime 的深度拒绝与冻结授权复核继续有效。判断是否值得委派属于行为规则：默认亲自执行，不整单转交；仅委派严格更小且有能力或独立证据收益的子问题，并说明保留工作和验收方式。相同权限不补足缺失工具，能力不足必须返回缺口而非循环委派。

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `AGT-001` | 目录必须决定 Agent 类型。Agent JSON 不得声明 `mode`；`name` 必须等于文件名且全局唯一。 | Agent Schema；`src/runtime-builder.mjs`；构建测试 |
| `AGT-002` | `system` 必须仅限 `compaction`、`title` 和 `summary`。`all` 可选择且可委派，`primary` 仅可选择，`subagent` 仅可委派。 | `src/agent-layout.mjs`；Agent Schema；路由测试 |
| `AGT-003` | 每个已安装目标或用户定义的具体 `all`、`primary`、`subagent` 必须具有非空单行 `description` 和核心 Prompt 源。仓库默认值可以在安装器生成具体目标文件之前，仅在 `agents/default.jsonc` 中暂存本地化内容。Agent 配置不得定义排序权重；O4E 不得从选择器列表中选择默认 Agent。现有原生模式别名投影保持独立。 | `src/runtime-builder.mjs`；`scripts/installer.mjs`；`test/runtime-builder.test.mjs`；`test/installer.test.mjs`；`test/plugin-config.test.mjs` |
| `AGT-004` | Plan 必须显式配置为 `self` 或 `child`。所有 Plan Profile 都必须且只能使用 `<name> (plan)`：`self` 只生成该 Profile，`child` 保留源 Agent 并额外生成该 Profile；无后缀源名称与历史 `<name> (Plan)` 均不得作为 Plan Profile。原生 `plan` 受管入口同样映射到 `<name> (plan)`。 | `src/core/capability-policy.mjs`；`src/runtime-builder.mjs`；Plan 测试 |
| `AGT-005` | Plan 默认应为只读，但显式的 Plan Skill、工具、权限、MCP、Agent、Workflow 和提醒覆盖属于用户授权，可以重新开放能力。最终 Runtime 安全仍必须执行合法委派边界。 | `src/core/capability-policy.mjs`；`src/core/agent-routing.mjs`；`test/plan-permission.test.mjs`；`test/plugin-config.test.mjs` |

### 权限与委派（`PER`、`DEL`）

新安装应允许 `external_directory` 在任务相关读取时无需反复确认。这是路径门控，不是写入能力：角色工具权限、显式 O4E `ask`/`deny`、收紧型 Overlay
和任务授权仍然适用。Plan 必须保留已配置的目录门控，同时关闭默认写入/执行能力。仅有目录访问不得推导出写入 Effect；Bash、Code Mode、未知工具和 edit
权限仍按保守策略处理。构建不得为采用新默认值而改写现有用户权限配置。显式 Agent 权限仍完全覆盖配置权限。受管 `loadTools` 数组必须用基础通配符拒绝关闭未列出的工具；显式的
Skill、MCP、委派和权限投影可以重新开放声明的能力。路径和循环门控除非配置，否则保持 `ask`。没有封闭工具集时，隐式执行或未知工具必须推导为 `unknown-write`。

O4E 默认将 `loadMcp` 归一化为 `{ "*": ["*"] }`，向受管 Agent 开放宿主配置和 O4E 配置中的全部 MCP 工具；显式 `{}` 关闭该 Agent 的
MCP。宿主 MCP server 名称必须纳入同一份 Runtime Snapshot，保证配置投影、委派授权和 Workflow 校验使用一致的工具集合。原生 `keep` Agent 不得因
O4E 的 MCP 投影被额外关闭。

配置支持 `blockTools`、`blockSkills`、`blockMcp`、`blockAgents` 和 `blockWorkflows` 黑名单。黑名单从 config、Agent 到
Plan 逐层累加，在白名单和显式 `permission` 投影之后强制执行；`blockMcp` 默认按 server 名称关闭该 server 的全部工具，`*` 表示当前已知的全部
server。黑名单不能被后续的 `allow` 重新开放。

编译后的权限模式必须完全按照支持的 OpenCode 宿主展开 home 前缀，并保留有序的 “最后匹配生效”规则。默认值或 home 路径变化后，不得静默提升已冻结的任务权限。`question`
的回答只用于澄清意图；既不会回复待处理的权限请求，也不会扩大子任务已冻结的权限或写入范围。默认设置应避免对已获得授权且符合角色的编辑、构建或测试
再次提问，但删除、发布、推送和凭据变更必须要求相应任务授权。Prompt 指引不构成强制执行。

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `PER-001` | `loadTools` 必须使用规范的内置工具集合。`edit` 控制宿主的 `edit`、`write` 和 `apply_patch`；宿主工具事件仍可以报告 `tool: "write"`。 | `src/core/capability-policy.mjs`; `src/runtime-builder.mjs`; 插件测试 |
| `PER-002` | `permissionOverlay` 必须只包含带 `ask` 或 `deny` 的规范权限名称，且不得扩大目标权限。 | `src/core/agent-routing.mjs`; 路由与编排测试 |
| `PER-003` | 受管 `task` 适配器可以在传输边界修正三个已知的模型生成 Overlay 键：`functions.bash`、`functions.write` 和 `functions.apply_patch`。修正后的名称不得进入配置或持久化账本。 | `src/adapters/opencode/plugin-hooks.ts`; `test/task-tool.test.mjs`; `test/plugin-background-task.test.mjs` |
| `PER-004` | `config.loadSkills` 必须是 Skill 名称白名单，仅作为省略 `loadSkills` 的 Agent 的默认值。`['*']` 不增加名称限制，`[]` 拒绝所有 Skill，显式名称投影为 `skill: { '*': 'deny', <name>: 'allow' }`。Agent 和 Plan 数组是完整覆盖；非数组值、重复名称以及将 `'*'` 与命名项混用都必须拒绝继续（fail closed）。后续显式权限可以有意覆盖基础投影。 | `src/runtime-builder.mjs`; `src/adapters/opencode/context-projection.mjs`; `src/core/agent-routing.mjs`; `test/agent-context.test.mjs`; `test/agent-routing.test.mjs`; `test/plugin-config.test.mjs` |
| `PER-005` | `loadMcp` 默认必须为 `{ "*": ["*"] }`，在同一冻结 Runtime Snapshot 中包含宿主和 O4E 受管 MCP server 名称，并允许用显式 `{}` 关闭某个 Agent。`blockTools`、`blockSkills`、`blockMcp`、`blockAgents` 和 `blockWorkflows` 必须从 config、Agent、Plan 逐层累加，并在所有允许投影之后应用；黑名单条目必须保持拒绝。原生 `keep` Agent 不得接收 O4E 的受管 MCP 拒绝投影。 | `src/runtime-builder.mjs`; `src/adapters/opencode/context-projection.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `src/core/agent-routing.mjs`; `src/runtime/delegation-runtime.mjs`; `src/runtime/workflow-runtime.mjs`; MCP、路由和插件测试 |
| `DEL-001` | `task` 必须是唯一的 Agent 委派入口。获授权的 `primary`、`all`、`subagent` Profile 可以发起它，包括从已委派 Session 发起；只有 `all` 和 `subagent` 可以作为目标。顶层 O4E `maxDelegationDepth` 默认必须为 2，且只接受 1 到 5 的整数。Runtime 必须从已验证的父链推导深度，拒绝超过限制的启动，拒绝循环或缺失祖先，并保留祖先权限 Overlay 及 Effect/Scope 限制。根 Agent 深度为 0；主会话中的 Workflow Step 不创建 Agent Session，也不增加委派深度。只有主 Agent 显式调用 `task` 时才按普通委派从当前已验证调用方增加 1。此限制不得增加根模型审批或改变并发预算。不建议提高该值，因为会增加任务量、成本和协调复杂度。Workflow 发现/启动仍限于获授权的根调用方。 | `src/core/agent-routing.mjs`; `src/runtime/delegation-runtime.mjs`; `src/runtime/workflow-runtime.mjs`; 配置 Schema；路由与 process 测试 |
| `DEL-002` | 普通 `task` 调用默认必须以后台任务执行。只有显式 `background: false` 才选择同步执行。 | `src/adapters/opencode/plugin-hooks.ts`; 插件后台任务测试 |
| `DEL-003` | 普通委派授权必须评估并冻结为 `task:<target-agent>`。每个合法的受管 `task` 选择都必须在创建子任务前通过宿主 `context.ask`；O4E `allow` 不得绕过宿主 Session 的 `ask`/`deny`，缺失宿主授权必须拒绝继续（fail closed）。冻结动作必须合并 O4E 策略与当前所有者 Session 限制，且宿主 `allow` 不得放宽 O4E 策略；宿主 `ask` 获批后必须冻结为 `ask/true`。后续派发和恢复必须依据冻结权限重新校验当前所有者规则，不得推断或添加缺失审批。Workflow 的 `o4e_workflow:<name>` 授权只允许访问对应流程检查点，不授予或冻结子 Task 权限；`execution.mode: task` 要求主 Agent 另行发起并完成一次独立授权的普通 `task` 调用。 | `src/adapters/opencode/plugin-hooks.ts`; `src/runtime/delegation-runtime.mjs`; `src/runtime/workflow-runtime.mjs`; 插件、委派与 process 测试 |
| `DEL-004` | Slash 命令子任务必须被拒绝，因为宿主会通过绕过受管 `task` 的仅内置路径路由它们。 | `src/adapters/opencode/plugin-hooks.ts`; `test/plugin-background-task.test.mjs` |
| `DEL-005` | 延迟恢复不得检查或结算仍由本 Runtime 前台派发或前台协调拥有的 Attempt。子任务的 `chat.message` 可能早于宿主 busy 状态到达；该空闲窗口不得成为“已停止但无结果”的证据。持久化但无所有者的 Attempt 仍按保守策略恢复。 | `src/runtime/delegation-runtime.mjs`; `test/plugin-background-task.test.mjs`; `test/runtime-orchestration.test.mjs` |
| `DEL-006` | 公开受管 `task` 执行入口必须先依据其声明的同一 Schema 校验参数，再进行恢复、授权或创建。缺失或无效的必填 `description`、`prompt` 或 `subagent_type` 必须抛出 `O4E_TASK_INVALID_ARGUMENTS`；不得从唯一候选推断目标，也不得接受 `agent` 别名。诊断只能指出规范的顶层字段，绝不能回显参数内容。较早的宿主/插件 before 钩子保留各自生命周期行为；Workflow 发现仍是独立契约。 | `src/adapters/opencode/plugin-hooks.ts`; `test/task-tool.test.mjs`; `test/plugin-background-task.test.mjs`; `test/runtime-architecture.test.mjs` |

### 后台任务（`BGT`）

受管 `task` 执行 Session 必须使用宿主原生根 Session 作为物理 `parentID`，使后代的权限/问题请求出现在 OpenCode 根提示词中。逻辑所有权必须在冻结的
`delegation.parentSessionID` 和任务 `ownerSessionID` 中保留为直接调用方；恢复和管理必须使用该逻辑关系。原生任务卡保留到执行 Session
的链接，而宿主父级导航遵循其物理根布局。

宿主 Session 处于空闲时，如果最新的派发相关 assistant 消息已有完成时间戳且仅包含已结算工具调用，不得仅因其 finish 为 `tool-calls`
就投影为运行中。适配器读取这些 Part 后必须再次检查宿主活动状态，不得将其作为业务结果接受，并必须保留待处理交互协调。没有可验证请求的已停止交互必须暴露明确的重试决定，同时保留保守锁；仅查询
失败不得擦除现有请求或推断宿主已终止。交互请求必须使用宿主提供的 SDK 客户端，以保留宿主认证和进程内传输。当前宿主的 instance 与 session API 暴露独立的待处理
存储；任一存储出错都必须报告，即使另一个成功返回。O4E 不得回退到裸 fetch，也不得将 HTTP 404 视为受支持的宿主版本差异。

模型指引默认必须让用户在 OpenCode 原生根 Session 提示词中处理子任务的权限/问题请求。父任务只报告等待，不复制或回答请求。当用户明确要求父任务代为处理时，在使用
`pending` 刷新请求及其修订号后，仍可执行回复/拒绝操作。任务目标、已知答案或通用继续指令不得暗示已有该授权。这是模型指引，不是新的自然语言授权解析器或 API 门控。

`BGT-002` 是 Agent 任务与命令任务共享的资源调度要求；其中写锁及 `BGT-003` 仅适用于 Agent 任务。Bash 不获取、借用或恢复执行 Scope Lock，不与 Agent 或其他 Bash 因写范围互斥。其余 BGT 行以及下面的检查、恢复、回执和 watch 协议仅适用于 **Agent
任务**。命令任务使用独立的 `CMD` 契约，不继承 Agent 委派账本、模型执行、任务组、交互回复或终端回执续接。

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `BGT-001` | Agent 任务的规范生命周期状态必须位于 `Task Session.metadata.o4e.task`，完整冻结的委派授权信封必须位于同级的 `metadata.o4e.delegation`。父 Session 必须保存 Agent 任务引用、恢复数据、取消证据和终端回执；每个任务引用的回执历史必须受 `TASK_REF_RECEIPT_LIMIT` 限制。 | `src/core/background-task-domain.mjs`; `src/runtime/background-task-runtime.mjs`; `src/runtime/delegation-runtime.mjs`; `test/background-task-domain.test.mjs`; `test/background-task-runtime.test.mjs` |
| `BGT-002` | 调度器必须按 `ownerSessionID` 和任务类型分区，在并发额度内按序列准入排队项，不得因活动任务的读/写类别阻塞另一类别。同一 JavaScript 进程中同一目录的所有插件实例必须共享该调度器，同时保留由 facade 所有的派发路由。准入不等于取得写锁，不保证全局执行 FIFO；写冲突由 ScopeLockManager 裁决。根 read 不等待写锁，可与写任务并行观察工作区，但不提供一致性快照；嵌套权限和父锁保留规则不变。 | `src/runtime/background-task-scheduler.mjs`; `test/background-task-scheduler.test.mjs`; `test/plugin-background-task.test.mjs` |
| `BGT-003` | `ScopeLockManager` 必须提供进程内写冲突边界。`read` 不占写范围，`scoped-write` 锁定规范化范围，`unknown-write` 与其他写入冲突。嵌套任务必须使用与已验证父锁关联的独立锁：祖先不阻塞后代，兄弟冲突仍存在，子任务 Effect/Scope 不得超出父级。包括读任务在内的后代持有者在结算前必须保留已释放的祖先锁；冷恢复必须先恢复祖先。同一 JavaScript 进程中同一目录的所有插件实例必须共享底层锁管理器，且一个 facade 不得释放另一个 facade 的所有权。 | `src/runtime/scope-locks.mjs`; 路由、编排和插件后台任务测试 |
| `BGT-004` | 插件启动和普通查询不得枚举并派发项目中的所有 Agent 任务。持久化 Agent 任务只为指定的父 Session 恢复；旧的排队 Agent 工作只有在新 Runtime 中该 Session 首次真实用户消息激活后才派发。成功的只读恢复可以继续恢复它暂停的派发工作；恢复失败不得继续该工作（包括通过其他所有者的恢复），并且必须在所有者成功激活后才能重启。 | `src/adapters/opencode/plugin-hooks.ts`; `src/runtime/background-task-runtime.mjs`; 插件与后台任务测试 |
| `BGT-005` | 可恢复的后台 Agent 任务必须具有完整规范的 `task` 授权上下文：匹配的请求者、目标、权限模式/动作/审批、指纹、Effect、Scope、Overlay 和追踪信息。Runtime 在初始或恢复派发、输入续接、重试或重启前必须重新验证该冻结权限。正常使用路径中缺失或无法验证的来源必须进入授权隔离；该范围内可验证的权限漂移必须在不派发的情况下失败。仅直接篡改 child Session 权限才能构造的漂移不构成本条必修缺陷；须先证明正常入口可达。 | `src/runtime/delegation-runtime.mjs`; `src/runtime/background-task-runtime.mjs`; `test/background-task-runtime.test.mjs`; `test/runtime-orchestration.test.mjs` |
| `BGT-006` | 无法验证授权的 Agent 任务必须进入 `unknown/authorization-unverifiable`。可以查询和取消，但不得接受输入、回答待处理请求、重试、回退、重启、执行副作用或推进到完成。 | `src/runtime/background-task-runtime.mjs`; `test/background-task-runtime.test.mjs` |
| `BGT-007` | 从未提交给宿主的隔离排队写入 Agent 任务必须释放其准入槽和 Scope Lock。具有宿主执行证据的 Agent 任务必须保守地保留二者，直到停止或取消；后续 Runtime 重新加载必须根据持久化证据重建该保守槽位和锁所有权。当所有相关 Attempt 被机械证明为 `idle` 或 `missing` 后，Runtime 必须持久化停止证据，仅释放本地准入和 Scope Lock 所有权，不得提升或接受结果。 | `src/runtime/background-task-runtime.mjs`; 后台任务测试 |
| `BGT-008` | Agent 任务终端回执必须使用稳定 ID 并至少投递一次。消费者必须按 `receiptID` 去重；业务输出仅通过已验证的 Message/Part 引用和 `o4e_task output` 提供。 | `src/core/background-task-domain.mjs`; `src/runtime/background-task-runtime.mjs`; 后台任务测试 |
| `BGT-009` | Agent 任务完成必须经过非终端结算阶段。Runtime 必须持久化 `running/completion-settling`，发布同级委派结果，然后仅在修订、阶段和检查证据仍为最新时提交终端任务账本。任何并发 `busy`/`retry` 证据或委派持久化失败都必须使完成无效、抑制回执发布，并保守保留准入和 Scope Lock 所有权。 | `src/runtime/background-task-runtime.mjs`; `test/background-task-runtime.test.mjs` |
| `BGT-010` | 公开 `o4e_task` Agent 操作必须要求所有者 Session 中由受管 `primary`/`all`/`subagent` 调用方发起、具备有效权限，并通过宿主 `context.ask` 的 `o4e_task:agent:<action>` 授权。仅有原生 `keep` 所有权不得授予访问权。委派子任务可以管理自己创建的任务，但不得管理自己的父 Agent 任务或兄弟任务。默认选择必须使用调用方拥有的组。 | `src/adapters/opencode/plugin-hooks.ts`; `src/core/agent-routing.mjs`; `test/plugin-command-task.test.mjs`; `test/agent-routing.test.mjs` |
| `BGT-011` | 等待未完成子任务的后台 Agent 任务所有者，不得仅因宿主轮次变为空闲就结算。子任务回执必须通过 Runtime 控制的派发恢复所有者，该派发会重新验证祖先关系并更新冻结的派发身份；直接提示宿主不得绕过此边界。祖先取消/删除必须取消后代；停止或持久化不确定时必须保守保留锁。 | `src/runtime/background-task-runtime.mjs`; `src/adapters/opencode/plugin-hooks.ts`; 后台任务与插件测试 |

当前任务账本必须显式持久化 `runGeneration` 和 `attemptSessionIDs`；终端回执及所有者回执引用必须显式持久化其
generation，包括零。每一轮的回执身份必须包含 generation。读取器必须拒绝缺失必填字段，而不得推断早期记录形态。终端任务账本必须已经包含在
终端结算时写入的回执；读取器不得伪造缺失回执。仍支持将已有回执重新发布到所有者索引。

Agent 任务 `input` 默认必须采用安全的下一轮语义。必须通过带修订保护的 CAS 持久化输入，并以机器可读形式确认 `queued`/`pending`
状态、当前轮次边界、`input-queued` 阶段和生成的修订号。显式指定 `delivery: "steer"` 时，活动宿主适配器可以为下一次
可运行轮次请求持久准入；只有宿主确认准入后，才能将 steer 视为生效。不支持或未确认的 steer 必须回退到持久队列并报告该模式。Runtime 不得声称实时投递或即时 token
中断，而无需宿主确认。在任一投递路径前，输入文本必须限制为 16,384 个字符（实现使用 UTF-16 代码单元切片，而非字节预算），并使用相同的截断规则；steer
不得绕过此限制。`o4e_task` 还必须为可安全派发的 queued/retry/pending-input 状态提供经过所有者校验的
`resume`，并报告工作已派发还是仍在排队。Resume 不得重启 unknown、无法验证或等待取消的执行。现有终端续接、回退/重试保留以及问题/权限等待拒绝行为保持不变。

显式 `resolve stop` 必须废弃此前已准入的 active/pending inputs；自动续接、恢复和 `resume` 不得用旧输入复活 `retry-stopped`。后续经过授权和 CAS 的显式新 `input` 仍可按终端续接协议创建新 generation，但不得带回停止前的输入队列。

公开 `o4e_task cancel` 对 Agent 与 Command 必须统一只接受 `action: "cancel"` 和单个非空 `taskID`，不要求取消原因或 revision。公开工具 Schema 不得声明 `reason` 输入，所有动作（包括 `resolve`）均不接受该输入；插件在按任务类型路由前统一拒绝，并且 Runtime 入口同样校验。内部生命周期诊断、Command 停止原因及 watch 输出的 `reason` 不属于被移除的输入字段，继续保留。不得为省略原因而绕过所有权、宿主权限、停止证据或保守锁。

`o4e_task watch` 必须冻结调用入口解析出的所有者可见选择。选择可以同时包含 Agent 和命令任务。省略选择器时，必须选择所有者当前待处理的 Agent 与命令任务；授权仍
按类型区分并绑定所有者。显式空 `taskIDs` 数组必须选择零个任务，不得回退到所有者集合。终端回执已持久确认的终端 Agent 任务会从省略选择器集合中排除；显式选择器仍可访问它，
但已消费的终端事件不得再次唤醒 watch。冻结选择不会加入之后创建的任务；只有 watch 接受混合的 `taskIDs`，其他操作要求单个 `taskID`。Watch
必须在任一选定任务出现新的终端或可操作事件时立即返回，包括权限/问题/Workflow/ 重试等待以及 `unknown`/`interrupted`。Agent
终端事件必须按已消费回执去重。命令事件必须使用已验证的公开 watch 响应或规范的原始 Bash 终端 Part 作为投递证据。命令状态/ 输出读取不得消费 watch
事件；仅有输出文本不得暗示命令状态或退出信息已投递。只有当先前 watch 已在完整公开文本中可验证地投递事件时，Agent 非终端可操作事件才可按
`taskID`/`status`/`phase`/`revision` 去重；仅有元数据不足以去重。投递历史扫描必须限制在剩余固定 watch 截止时间内且最多 5
秒，并让位于持久化用户消息、新可操作事件和读取器中止；投递证据不完整时可以再次报告事件。没有新事件时 watch 必须继续等待；若所有选定任务均已终端化且其事件已投递，必须返回
`reason:"empty"`。单个事件不代表任务组完成。持久化的真实用户消息、读取器中止或固定截止时间必须保留其打断行为。

`o4e_task watch` 必须使用固定等待截止时间，最长 3,600,000 毫秒。省略或为零的 `timeoutMs` 必须使用 1,800,000 毫秒（30
分钟）默认值；显式正值可以选择最长一小时的窗口。内部检查和进度事件不得延长截止时间；watch 不得使用退避或返回 `nextHeartbeatMs`。到期时，Runtime 必须协调任务状态并返回
`heartbeat`，除非新的可操作事件或持久化用户消息需要更早处理。Heartbeat 不代表完成，不得取消或重启任务。收到 `heartbeat` 或可操作 watch 结果后，Agent
协议必须先向用户报告有意义的当前状态，再发出下一次 `watch`；已完成任务必须先用 `output` 读取结果再报告，而失败、取消、unknown、interrupted
和显式等待状态必须如实报告，不得呈现为成功。真实用户消息以及终端或显式等待状态优先于 heartbeat 进度。Runtime 不得制造合成 heartbeat 进度消息：这是 Agent/TUI
协议，插件无法保证中间文本会在宿主 UI 中可见。用户意图未改变时，调用方必须检查返回状态并继续 watch 待处理依赖。这是 watch 等待窗口限制，与下文读取调用预算分离，不是任务执行超时。

主 Session 的生命周期协调不得只依赖 Prompt 自律。真实用户插话必须优先于旧 Task 跟踪，且不得隐式取消或复制既有 Agent/Command Task；主 Agent 应先推进不依赖后台结果的授权工作。宿主确认主回合自然 idle 后，如 owner 仍有未完成 Agent 或 Command Task，插件必须以 Runtime 生成的 synthetic 文本回合机械恢复协调，等待后续 Task 事件并持续收敛到完成、可操作异常、显式等待或用户停止。该回合不是伪造的模型 `tool` Part，不绕过宿主 `context.ask`，也不自动回复 permission/question。自动续接失败必须停止并留下可操作诊断，不得忙循环；同目录插件实例必须去重提交。根 Session 的显式 `MessageAbortedError`/`AbortError` 只抑制当前自动跟踪意图并保留后台执行；下一次真实用户回合恢复跟踪意图。宿主 `dispose`、owner 删除、显式 Task cancel 和受管 child 终止仍是停止执行边界。

`o4e_task inspect` 必须要求 `taskID`，并接受非空可选 `cursor`（最多 512 个字符）、`direction`（`forward`，默认值，或
`backward`）以及 4..8192 范围内的安全整数 `maxBytes`（默认 1024）。插件必须将 `readTaskInspection` 注入
`BackgroundTaskRuntime`；插件和 Runtime 都必须校验这些选项。单值 `cursor`、`direction`、`maxBytes` 和 `resume` 仅供
inspect 使用。`timeoutMs` 和 `taskIDs` 仅供 watch 使用；watch 必须拒绝所有 cursor/resume 选项。共享字段校验必须在读取 I/O 前，于插件和
Runtime 输入边界执行；读取预算构造器必须直接使用已校验选项，不得再次校验。

Agent 检查位置必须使用当前紧凑 cursor 格式，长度最多 120 个字符；其他编码必须拒绝。共享工具输入限制对类型专属 cursor 仍为 512 个字符。每个 cursor
必须绑定执行、源前缀签名和 UTF-8 偏移，保留拒绝继续（fail closed）的 `gap` 行为，且绝不授予授权或要求额外 cursor 状态。

只有 inspect 可以接受布尔值 `resume`。inspect/watch 可以接受 1..60000 范围内的安全整数 `ioTimeoutMs`（默认 10000
毫秒）。二者的读取调用预算必须从工具执行入口开始，覆盖恢复、授权、cursor 扫描、watch 窗口、到期复查和 UI 等待。Inspect 截止时间必须是 I/O 允许时长；watch
截止时间必须是规范化等待窗口加该允许时长，且不得延长或按操作重置。超时或调用方中止只能取消读取器等待，不得取消子任务或共享恢复。已启动的生命周期 Promise
必须持续跟踪，释放时仍必须等待它们。

对于这两个操作，O4E 的 `tool.execute.before` 必须将恢复和事件排空推迟到带预算的执行入口；作用域写检查和副作用水印均不适用于这些读取。其他工具和任务操作必须保留其
before 钩子行为。此预算不限制宿主或其他插件在 O4E 执行前运行的钩子。

一旦回执消费事务（包括其适配器消费回调）获准进入，就不得被读取截止时间或调用方中止打断。准入必须关闭截止计时；调用必须等待并返回事务实际结果，该结果仍可能失败。返回已提交结果不得等待最终的尽力而为
UI 元数据发布。这不是绝对的硬性墙钟限制：已准入事务、同步 JavaScript 以及超大 SDK 载荷处理都可能超出该时长。

公开 `o4e_task` watch/status 输出必须只包含状态，不得包含结果正文或进度尾部。显式 `output` 必须只返回结果文本，保留空白和空字符串，仅附加必要的截断或日志不完整提示。
不得重复状态、退出状态或任务包装。Inspect 提供进度预览。相同的已完成宿主 Tool Part 必须在其状态元数据中携带有界结构化结果，供适配器解析和 resume 使用。只有在当前消息/
调用边界之前从已验证的已完成 `o4e_task` Part 读取时，才信任该元数据；元数据不隐藏通用输出正文，也不构成授权。Watch 投递去重还必须验证与当前结果匹配的公开且完整的
模型可见文本；隐藏详情时，公开模型文本使用已完成 `o4e_task` Part 中绑定 action、正文与结构化结果的完整展示包络恢复，而不是将任意 `o4eResult` 视为投递证据。inspect 恢复同样必须将完整模型预览与当前渲染器匹配，之后才能接受元数据中的 cursor 或首次使用证据。宿主截断或压缩的 Part 不得建立投递证据或推进恢复的
inspect 位置。每次显式读取时，`output` 都必须返回正文。读取器必须使用当前已完成 Part 的元数据；不得仅凭 JSON 正文作为 resume
来源。响应不得要求用户启用宿主通用输出偏好才能理解结果。

Inspect 必须独立于 cursor 对任务授权。预览不得消费终端回执、结算完成或替换 `output`。现有工具入口的恢复和授权检查可以在预览前协调持久化生命周期状态；inspect 不会使该
现有恢复变为只读。预览读取器自身不得触发生命周期结算。其紧凑结果必须包含 `taskID`/`status` 以及可用的 `tail`/`cursor`，并可选
`unchanged`/`unavailable`/`gap`。只有存在更早数据时才显示 `beforeCursor`。读取器 cursor 必须绑定任务、子 Session、派发、运行代次和
Attempt，并在文本、Part、消息追加时保留固定 UTF-8 字节位置。校验必须覆盖所引用源此前完整的公开快照前缀，而不只是已消费字节；前缀重写、工具状态变化或源删除必须返回
`gap`，绝不能跳到新尾部。Cursor 是分页位置，不是授权能力。

显式 inspect `resume:true` 必须从调用方父 Session 中、当前工具 `messageID`/`callID` 边界之前真实持久化的 `o4e_task` inspect
工具响应恢复任务最新预览位置。当前及之后的 Part/消息不得提供位置。恢复最多扫描 5 页、每页 20 条消息，且不得新增缓存或 cursor/水印表。`resume:true` 不得与手动
`cursor` 组合。向后 inspect 必须使用最新预览的 `beforeCursor`，而非其 `cursor` 或更早预览；没有更早位置时必须报告 `unavailable`。

只有在找到调用边界且耗尽历史、没有先前锚点或失败记录后，首次 forward resume 才可以读取新尾部。没有 `tail`/`cursor`/`beforeCursor` 的初始空
`unchanged:true` 或排队的 `unavailable:"not-dispatched"` 预览可以保留首次使用资格，但不得隐藏更早锚点或失败。
最新相关的失败、待处理或运行中调用，失败/gap 预览，损坏或压缩的输出，无法验证的边界，或在解析位置前达到历史限制，都必须报告 `unavailable`，不得回退到更早成功记录或新尾部。
不保证多读取器严格只执行一次；并发的 pending/running 调用必须拒绝继续（fail closed）。宿主工具 Part 输入为空或损坏时，如果无法证明其 action 或 inspect
选择器无关，必须阻止未解析的位置；不得解析原始不完整参数来猜测排除关系。要刻意读取新尾部，调用方必须省略 `resume` 或设为 false，并省略手动 cursor；这会重置读取位置，而不是从
gap 无损恢复。

Inspection 必须使用宿主 `messagePage` 分页，每次预览最多 5 页、每页 20 条消息，不使用缓存，也不回退到全历史。从已验证的当前派发/压缩 lineage
中，只能暴露公开 assistant 文本、工具名称/状态，以及 `read`/`glob`/`grep` 的最小白名单摘要。`read` 只能显示有界、相对工作区且规范化的
`filePath`；`glob`/`grep` 只能显示有界的相对工作区 `path` 和保守有界的 `pattern` 值。外部、疑似敏感、类似 URL/query、格式错误或超大值必须省略，
未知工具只能保留名称/状态。不得暴露其他工具输入、工具输出、推理或隐藏元数据。摘要必须来源于同一已验证的公开 Part 和当前执行 lineage，必须参与 cursor 前缀校验，不得进入
cursor 源文本，也不得授予授权。无法验证的 lineage 或 cursor 源必须拒绝继续（fail closed）。该限制约束页数/消息数和返回的 UTF-8 尾部字节数，不约束 SDK 线下载荷字节数、Part
数量或每条消息的投影内存；SDK 可能在返回前下载巨大的单条消息 Part。

Watch 不得执行 heartbeat 检查或返回 tail/cursor 字段。其有界结构化条目包含 `taskID`/`status`、可操作事件的
`revision`/`phase`，以及必需的命令退出、截断和日志完整性信息。公开的非终端可操作条目必须暴露状态、阶段和预期修订号，使投递去重能在可读文本中验证事件。Watch
消费状态事件；`output` 仍是权威结果读取，不得因为先前返回过 watch 或 output 就抑制正文。插件 UI 必须使用现有快照和返回数据，在不额外读取活动消息的情况下保留 Agent
名称。

确认终端 watch 回执前，适配器必须根据 49 KiB 文本和结构化结果预算预检公开结果，并为确认修订号更新预留空间。选择过大时必须失败并要求减少显式 `taskIDs`，且不得确认其
回执。预检出的业务结果在整个回执事务中必须保持不变；并发的新执行不得替换它。这不会使多回执持久化变为原子操作，也不改变 watch 唤醒条件。

`o4e_task action:follow` 必须提供当前根 owner 的自动跟踪状态读取与显式启停。仅获授权的受管 primary/all 根调用方可使用，必须经过宿主 `o4e_task:follow` 授权；不接受 Task selector。省略 `enabled` 只读；设置布尔 `enabled` 必须携带当前 `expectedRevision`。选择在 owner 的 `metadata.o4e.automaticFollow` 持久化，普通用户插话和新插件实例不得解除显式停用；它不取消 Task、不回复交互、不恢复旧 Task 执行。abort 的临时抑制仍只持续到下一真实用户回合。自动跟踪失败须持久化不含原始错误正文的 `automatic-follow-failed` 诊断并停用，状态读取提供显式恢复方式。宿主元数据写入按同进程 owner 串行化；不承诺跨进程 CAS 或 exactly-once。

非终态 actionable 变化必须唤醒空闲 owner 一次以报告等待或异常，去重依据包含 Task 身份、状态、阶段和 revision；同一变化报告后不得因新 assistant idle 锚点形成忙循环。自动提交前必须再次校验真实用户回合和持久化启停控制。

终态通知检查的接口错误必须与 busy、watch 和用户回合等正常等待分开计数；同一用户意图与控制 revision 内连续三次检查失败后停止跟踪，完整检查成功才清零失败计数。检查失败预算不等于终态消息提交预算。停用诊断写入失败时，本实例必须先停止自动检查；在宿主读取可用时，follow 应以 `persistenceConfirmed:false` 明确本地停用未持久确认并提供显式恢复方式，普通用户消息不得解除该本地失败状态。不承诺未保存状态跨进程保留；Session 读取仍失败时应报告读取错误而非伪造 revision。

普通 Agent/Command Task 的自动续接同样按当前真实用户跟踪意图内的任务状态变化逐项去重，包含运行中和取消中状态；synthetic 回复产生的新 assistant 锚点不得重置投递资格。已报告的等待不得阻挡新兄弟任务或其他新变化。真实用户回合及显式恢复 follow 可以重新启用一次状态报告，持久化的显式停用仍优先；无新变化时等待 Runtime 事件，不循环启动模型。此去重不改变 watch 的事件消费或终态 receipt 投递协议。

终态 receipt 投递为确认响应丢失或宿主持久化而重投时，必须复用同一消息身份，且同一用户跟踪意图内最多提交三次；耗尽后持久化失败诊断并停用，等待显式恢复。失败写入必须校验尝试所属用户 epoch 与控制 revision，旧提交的迟到错误不得覆盖新的用户控制。

### 任务展示

Agent Task 规范状态提交后必须同步发布 owner 索引中的当前恢复副本，保持 revision 单调且不覆盖较新记录、回执确认或取消证据；发布失败不能回滚已经接受的规范提交或重复执行。当前 owner 的定向恢复必须从有效规范记录修复陈旧副本，不增加全库扫描、不引入旧协议迁移。TUI 仅同步到 owner 时，也必须能够展示其已发布的当前任务状态。

对应外层操作或事件完成前须在退出 Task/transition 串行区后等待本操作的发布尝试，不等待兄弟任务执行结束。发布失败以脱敏 `owner-publication-failed` 诊断暴露在当前 Runtime 的结果/查询投影中，不为诊断改写已提交的 canonical 结果；成功定向发布后清除该诊断。服务端发布完成不保证界面同帧刷新；底层写入永久不返回时不伪称发布完成。

原生后台 Task 卡片的工具调用完成标志不得作为 Agent Task 终态证据。排队会话应呈现非完成的活动指示；不得为满足展示而伪造执行 Session 的 `busy` 或修改 O4E `queued` 真值。若宿主公开扩展面不能改变原生判定，必须记录未满足项，不能用 O4E 侧栏正确展示冒充原生卡片已修复。

顶层 `enable_o4e_task_detail` 必须为布尔值，默认 `false`。关闭时仅对 `o4e_task` 隐藏人类界面的返回正文，保留 `⚙ o4e_task [参数]` 调用行（宿主若主动隐藏全部工具则仍尊重该选择）；即使宿主开启 generic tool output，也不得展开其成功返回正文。开启时保留正常正文展示。两种模式必须向模型提供相同的完整有界正文及结构化 `metadata.o4eResult`，不改变授权、任务账本或回执，不修改宿主源码、全局显示偏好或其他工具的显示。

隐藏模式在已完成 Part 中保存有界的模型输出展示包络，使用公开 `experimental.chat.messages.transform` 仅恢复发给模型的副本，不把正文写回持久化 UI Part。正文、action 与结构化结果必须绑定校验，损坏时 fail closed；校验不是授权。watch 去重、inspect 续读与 Workflow evidence 必须使用同一经过验证的模型表示，保留调用边界和规范结果核对。已压缩／宿主截断的内容不得复活；宿主摘要和压缩工具截断规则仍适用，不保证压缩后逐字保留原文。CLI 导出的原始 UI output 也为空，不等于模型未收到正文。

任务侧栏必须通过公开 `sidebar_content` slot 的 `order:350` 放在内建 Todo 之前，按当前 owner 的 Bash／子 Agent 分组并有界展示。仅使用宿主已同步 Session 数据，不扫描旧 Session、不调用模型、管理工具或恢复执行。状态属于记录快照，不证明实时运行、结果接受或任务成功；此边界在使用文档说明，Task 侧栏、列表与详情不显示固定的只读／快照提示或正常记录的 `recorded`／`snapshot` 后缀。等待、失败、未知和缺失记录不得美化，必须保留 `unknown`／`unavailable` 等必要异常标识，禁止显示命令、原始描述、输出或敏感路径。

任务概览必须按 Bash、Subagents 顺序各显示一张分组卡片，任务以稳定 Task 身份在卡片内呈现紧凑行，不再为每个任务嵌套边框。分组标题及各自 `View all` 直接打开对应分类的完整分页列表，任务行直接打开只读详情；不得经过中间分类菜单。命令面板提供独立的 Bash 与 subagent 列表入口。它不是聊天流工具卡片替换器，不改变 detail 的正文语义。详情每次从当前 owner 的同步记录重新投影，失效或切换 owner 后不得继续导航。仅 Agent Task 在执行 Session 与任务、逻辑 owner、Agent 和派发身份一致时允许用户主动导航；命令账本不得伪装为执行 Session。查看不创建 Task、不确认结果、不消费回执或回答交互。

Task 默认侧栏隐藏通过校验后投影为 `completed`、`failed` 或 `cancelled` 的记录；Bash 还隐藏具有未提交、无执行 claim 且已停止证据的 `interrupted/not-submitted`。等待、未知、Agent 中断、取消中及无法验证的记录保留，损坏终态不得因原始 status 被隐藏。顺序必须为读取、校验、状态投影、过滤、排序、分页；侧栏与完整列表均按已验证序号降序排列，不按状态排序；无可信序号的异常行仍保留在列表尾部。每张分组卡片最多六条任务行，布局为 `Bash(n)`／`Subagents(n)`、`#序号 · 状态`、`View all · (总数)`，标题数量按过滤后记录计算，底部总数包含隐藏项。除记录异常外，不显示空态、隐藏数量或额外提示行。某组无引用且无异常时隐藏该组，两组均为空时隐藏整个 Task 区域。完整列表每页二十项，包含全部终态；左右键前后翻页，到首尾不环绕，不再将翻页作为列表中的可选项；上下键保留任务选择。翻页键仅在列表焦点子树内生效，关闭时清理，不抢占聊天输入。列表显示阶段、Agent 名称及可验证的命令退出码。Bash 行直接打开输出，子 Agent 行直接打开状态及经校验的执行 Session 入口；不可操作信息使用普通文本而非伪操作项。owner 切换重新计算，不跨 owner 保留列表状态；不改变 Workflow、任务账本、结果接受和回执协议，不新增全局配置项。

子 Agent 详情操作必须具有可见的键盘选中态，支持上下选择、Enter 执行、鼠标点击及 Esc 关闭；详情不显示搜索框，Tab 可切换操作。Bash 详情默认聚焦输出：左右键按完整列表顺序切换相邻 Bash 任务，上下键按可视屏翻动当前输出（保留一行重叠），PageUp/PageDown 与上下键等价；跨内部有界输出分段连续浏览，到首尾不环绕，不要求 Tab 或分页菜单。切换任务重新校验 owner/source 并丢弃旧请求和输出。从列表进入详情后返回保留当前任务所在页与选择，不跨 owner 保存。布局随终端可用高度和正文长度收缩，不能用固定大空白挤出底部操作。侧栏分组使用轻量左边界，不再堆叠完整矩形边框。

用户主动打开 Bash 完整列表（`View all` 或命令面板）时，允许在编号之后显示命令首行的有界前缀，作为侧栏禁止命令展示规则的有限例外。左列为 `#n 命令前缀…`，右侧独立保留 `状态 · 阶段 · 退出码数字`，同页各元信息列对齐，不随命令长短移动或被标题截断；相同阶段不重复显示，退出码存在时只显示数字，不带 `exit` 标签，缺失字段不增加占位文字。每项优先单行，宽度预算优先保留编号、状态、阶段和退出码，前缀随实际可用宽度缩短，按字素边界及终端列宽截断；不足以显示可辨认前缀时直接省略，不换行或增加占位提示。仅使用当前 owner 已同步的原始消息与 Part，必须校验消息/Part 的 owner、messageID、callID、taskID 及完整 commandHash；缺失、冲突、隐藏、压缩或超过处理预算时省略前缀，不补读历史、不新增请求或持久化副本。搜索仅索引左列实际展示的编号与命令前缀，不搜索被省略内容。首行含终端控制字符或明显敏感形态时整条前缀省略；这是降低屏幕暴露风险的启发式规则，不保证识别所有秘密或共享屏幕安全。侧栏不读取命令，详情正文与列表前缀互不替代。

仅在用户主动打开 Bash 详情或点击刷新时，TUI 可以通过宿主公开 SDK `session.message` 读取该 Task 的原始 Bash 消息；不得执行命令、调用模型／管理工具、扫描历史或读取日志路径。读取前后必须校验当前 owner、Task 记录与 source 身份，消息/Part 的 Session、messageID、callID、taskID 和 commandHash 必须一致，冲突或缺失时拒绝显示。输出来自原始 Shell Part 的 `metadata.output`，不得把后台控制回执伪装为输出；以有界页面访问完整已捕获正文，保留空输出，截断或捕获不完整须显式说明，不能承诺宿主未保存的内容。请求须有超时及关闭／切换保护，侧栏仍不读取任何正文，输出不得写回账本或发送模型。

Workflow 必须在 Beta 显式开启后提供独立的只读检查点概览和详情入口，关闭时不注册 Workflow 菜单或读取检查点。侧栏采用 `Workflows(n) · Beta` 轻量分组卡片，最多六行；校验后的正常终态从侧栏隐藏，完整列表仍保留。以 Run ID 短后缀标识，碰撞时展开完整 ID，不虚构序号或创建顺序。完整列表每页二十项，左右翻页、上下选择、Enter 进入详情、Esc 关闭；详情支持步骤分页、滚动和可见返回操作，返回保留列表页和选择，owner 切换清理旧弹窗。仅显示当前 owner 的有界白名单摘要，并标明记录快照而非 Gate 重新验证结果。不得显示输入、输出、报告或证据正文；不得通过 UI 自动恢复、推进流程或建立后台 Workflow ledger。

TUI 必须具有独立于 server 的入口，生成文件不得进入 server 自动扫描入口目录。构建显式维护 `tui.json[c]` 注册；安装、导入回滚、卸载和 status 必须覆盖该注册及文件生命周期，同时保留用户 JSONC 注释、其他插件、选项与偏好。自动化投影和注册测试不等于真实交互 TUI 验收。

### 受管 Bash 与命令任务（`CMD`）

全局 `bash` 工具是生产环境中的命令任务创建器。它直接通过命令端口执行，不经过模型委派或 Agent 任务。

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `CMD-001` | 受管命令必须支持 OpenCode 当前支持的主流宿主平台和 Shell。O4E 接管 OpenCode 的命令工具，但不将执行器限定为 Bash、POSIX Shell、Linux 或单一平台。授权和执行必须使用 OpenCode 宿主 `config.shell` 解析出的同一个 Shell、参数协议、工作目录和环境；未配置时使用 OpenCode 当前平台的默认 Shell。不得使用 O4E 自己定义的 Shell fallback；Shell 无法解析或启动时必须 fail closed。无 PTY，标准输入为 EOF；进程启动和终止必须使用当前平台可验证的进程边界。 | `src/adapters/opencode/plugin-hooks.ts`; `src/command-core/command-execution-port.mjs`; `test/command-execution-port.test.mjs`; `test/plugin-command-task.test.mjs` |
| `CMD-002` | 命令字符串必须原样交给宿主配置的 Shell，不得转换为另一种 Shell 语法。Shell 语法、展开、内置命令、重定向、管道、函数、循环、脚本和错误行为由目标 Shell 处理。O4E 不施加语法白名单，也不得在授权前求值替换。提取出的原子源资源和可静态解码的规范字面量必须获得授权；无法识别的语法或未提取出资源的命令还必须授权完整输入。语法错误由 Bash 自身报告。静态路径检查必须跳过无法在不执行的情况下解析的动态操作数；授权不是 shell 或文件系统沙箱。 | `src/adapters/opencode/bash-permission.mjs`; `test/bash-permission.test.mjs`; `test/plugin-command-task.test.mjs` |
| `CMD-003` | 命令端口启动时必须继承进程环境，不得移除普通 Bash 启动/行为变量或施加特权启动。每条命令的环境赋值仍属于 shell 语法。公开插件 API 不暴露其他插件 `shell.env` 钩子的派发；O4E 不得导入宿主私有 API 来模拟，也不得声称这些钩子已被调用。 | `src/command-core/command-execution-port.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/command-execution-port.test.mjs` |
| `CMD-004` | 创建命令任务或生成进程前，O4E 必须要求宿主 `context.ask` 对原始及规范原子 Bash 资源，以及适用的基于 realpath 的 `external_directory` 资源进行授权；O4E 权限可以收紧拒绝，但不能替代宿主授权。受管委派子任务必须校验实时身份、冻结的委派/Agent Task、指纹、权限及 Effect；主会话 Workflow Step 不形成另一层命令授权身份，命令仍按当前 root owner 的普通权限独立授权。获批后以及资源准入后、持久化执行声明前都必须重新校验。Bash 不获取、借用或恢复执行 Scope Lock，不与可写 Agent 或其他 Bash 做写范围互斥；仅保留 `maxConcurrentCommands` 资源数量上限及账本更新、来源去重的内部同步。受管 child 仍须具备可信冻结的 `unknown-write` 权限，绝不能升级 `read`/`scoped-write` 或接受模型提供的所有权。允许 Bash 的 Agent 仍按原规则推导 Effect，Agent 之间的锁不变；父子生命周期仍须确认子命令停止，不能用移除命令锁绕过取消或停止证据。并发文件冲突及依赖顺序由调用方协调，不宣称文件隔离。 | `src/adapters/opencode/plugin-hooks.ts`; `src/runtime/delegation-runtime.mjs`; `src/runtime/command-task-runtime.mjs`; `test/bash-permission.test.mjs`; `test/command-authority.test.mjs`; `test/command-task-runtime.test.mjs` |
| `CMD-005` | `o4e_task` 命令管理必须要求调用方 Session 属于所有者索引、具备当前权限，并通过宿主 `context.ask` 获得 `o4e_task:command:<action>` 授权。仅支持 `status`、`watch`、`inspect`、`output`、`cancel` 和 `pending`；`pending` 必须报告 `pending: []` 与 `supported: false`。Watch 可以选择多个或混合 Agent/命令 `taskIDs`，省略选择器时必须包含所有者命令。其他命令操作必须要求一个显式 `taskID`。必须拒绝 `input`、重试/`resolve`、重启以及权限/问题回复。获授权的原生 `keep` 根和委派子任务可以管理自己创建的命令任务；Agent 任务访问遵循 `BGT-010`。命令不得派发模型，也不得产生 Agent 终端回执或自动回执唤醒。 | `src/adapters/opencode/plugin-hooks.ts`; `src/runtime/command-task-runtime.mjs`; `src/core/agent-routing.mjs`; `test/plugin-command-task.test.mjs`; `test/command-task-runtime.test.mjs` |
| `CMD-006` | `bash` 必须要求 `command` 和 `description`，接受可选 `workdir` 与执行 `timeout`（整数 1..2147483647 毫秒，默认 120000 毫秒）。省略 `workdir` 时必须使用当前 Session 的 `context.directory`；相对 `workdir` 必须从同一目录解析；每次调用相互独立，不得继承之前命令的 cwd。当严格 provider Schema 传输将可选 `workdir` 或 `timeout` 表示为必填可空字段时，`null` 必须与省略完全相同；空字符串及其他无效值仍必须拒绝。准入等待默认必须为 1000 毫秒；执行开始后，独立的运行等待默认必须为 10000 毫秒。在排队或运行期间到期时，必须返回当前快照和稳定 `taskID`，不得停止执行。这些可独立注入的窗口与执行超时、授权和持久化时间分离。命令 watch 对省略/零 `timeoutMs` 必须使用固定 1800000 毫秒默认窗口，最长 3600000 毫秒，且不得因进度延长。Inspect/watch 使用读取预算和选项校验；适配器必须在相同所有者 watch 选择及用户消息打断中包含命令。命令不使用 Agent 回执。Inspect 必须允许随着输出增长按需读取最新尾部；进度读取不得暗示完成。Inspect 读取保留的命令输出，而不是 Agent 消息 lineage；cursor/前缀变化或截断必须报告 gap，而不是无损恢复。 | `src/adapters/opencode/plugin-hooks.ts`; `src/adapters/opencode/bash-permission.mjs`; `src/runtime/command-task-runtime.mjs`; `src/runtime/task-read-budget.mjs`; `test/runtime-architecture.test.mjs`; `test/command-task-runtime.test.mjs`; `test/plugin-command-task.test.mjs` |
| `CMD-007` | 命令任务必须使用独立校验的 `kind: command` 记录，以 owner Session 的 `metadata.o4e.commandTasks.refs[taskID].recovery` 为唯一规范账本；对应 ref 与记录的 `taskSessionID` 必须等于 `ownerSessionID`，仅标识存储容器。不得创建 Command 根 Session 或子 Session，不得污染普通 Session 列表或子 Agent 导航，不得覆盖 owner 的 Agent `metadata.o4e.task`、委派信封或其他元数据。源 Session/消息/调用身份必须用于创建去重；规范记录、claim 与引用须在同一 owner 更新中校验并提交，声明提交确认必须先于端口执行。命令通道必须按 `ownerSessionID` 遵守 `maxConcurrentCommands`，且不消耗 Agent 槽位；按执行 Session 查找 Agent 时必须排除 Command。恢复仅接受符合当前契约的 owner 记录，必须在检查句柄前恢复指定所有者的不确定资源准入，不创建 Command 写锁。可以重新连接已有的进程内句柄，但不得重新提交旧声明、在宿主重启后接管 PID，或根据持久化输入重建未提交的命令。没有实际启动的未提交记录变为 `interrupted/not-submitted`；缺失的已声明句柄保持 `unknown` 并保守保留 Command 槽位。不得自动扫描、迁移或删除历史 Command Session。 | `src/runtime/command-task-runtime.mjs`; `src/runtime/background-task-scheduler.mjs`; `src/command-core/command-execution-port.mjs`; `test/command-task-runtime.test.mjs`; `test/background-task-scheduler.test.mjs` |
| `CMD-008` | 未截断且成功的 Bash 完成必须原样返回捕获文本，包括空格、换行和空输出，不得附加任务包装、摘要、重排或空输出占位符。非零退出、异常状态、截断和日志不完整必须对模型可见，可使用已验证的宿主通道或最短且明确分隔的控制文本；仅有 UI 元数据或附件类型声明不得暗示模型可见。捕获指按流并依观察到的回调顺序进行 UTF-8 解码，不是终端仿真、二进制保真或 stdout/stderr 文件描述符之间的真实全局写入顺序。内存保留最多 64 KiB 的视图：运行中尾部，或较大的终端头部加尾部。Bash 模型文本必须使用独立的 48 KiB/1800 行预算，超出时返回带标记的尾部；必要控制文本必须带显式分隔符置于正文之前，以便在支持的宿主默认截断限制下保留。宿主配置可以施加更低限制；O4E 不得声称控制下游宿主/模型截断。Bash `metadata.o4eResult` 必须独立于原生 Shell 卡片输出使用 20 KiB 预算；其他命令操作使用 40 KiB。元数据缩减必须标记，但不得改变其预算内的 Bash 文本。`inspect` 只能分页读取保留的数据。完整捕获文本必须写入仓库外仅当前用户可访问的存储（目录 0700、文件 0600），每个日志上限 256 MiB，自终端结算起延迟保留 24 小时；活动日志必须防止过期，保守清理可以延迟。终端结算必须确认日志写入；创建、写入、容量、同步或捕获失败必须暴露不完整状态，不得声称归档完整。返回的 `logPath` 可以通过获授权的宿主文件工具分段读取；路径本身不保证附件可见。`totalBytes` 和可用的 `sha256` 描述观察到的原始流数据；捕获不完整时不得伪造完整哈希。命令账本持久化有界视图和日志信息，而非完整内容；原生 Shell Part 元数据可以携带独立的 UI 捕获。原始命令/描述输入属于宿主 Bash Part；命令账本只保留源引用/哈希，不保留可执行重放载荷。 | `src/command-core/command-execution-port.mjs`; `src/runtime/command-task-runtime.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/command-execution-port.test.mjs`; `test/plugin-command-task.test.mjs` |
| `CMD-009` | Inspect/watch 读取器中止或读取截止时间不得取消命令。Bash 返回 queued/running 快照后，中止原读取器不得取消执行。普通根所有者 Session 空闲或根回合的 `MessageAbortedError`/`AbortError` 必须保留已分离命令；根回合 abort 只临时抑制自动跟踪。附着的 `bash` 调用方中止、所有者 Session 删除、显式 Task cancel、受管子任务生命周期终止/取消以及插件释放仍必须发起取消；执行超时必须发起停止。分离不得削弱子任务权限或生命周期边界。停止证据只能覆盖已验证的所属进程组。未知停止或规范/所有者持久化失败必须保留 Command 资源准入及不确定记录，不创建 Command 写锁；取消/释放重试可以重试停止证据或持久化，但绝不能重试执行。Agent 父级的停止及保锁要求仍按 Agent 契约执行。不得声称存在跨进程租约、OS 沙箱或能停止通过 `setsid`/`setpgid` 逃逸的后代。 | `src/adapters/opencode/plugin-hooks.ts`; `src/command-core/command-execution-port.mjs`; `src/runtime/command-task-runtime.mjs`; `test/plugin-command-task.test.mjs`; `test/command-task-runtime.test.mjs`; `test/command-execution-port.test.mjs` |

原生 Shell 卡片必须独立于有界模型响应和命令账本视图接收捕获文本。其 UI 捕获必须保留最长 256 MiB 的 UTF-8 安全前缀，保留空输出，并明确标记容量损失。Bash 返回后台
taskID 后，合并的尽力而为发布必须继续，通过更新原始 Part 的 `metadata.output` 实现；不得改变面向模型的 `state.output`、工具状态、时间或结构化结果。UI
失败不得控制执行或声称保证投递。宿主可能裁剪/移除 ANSI 或折叠显示，因此卡片展示不保证文本保真度。短命令的 Bash 必须直接返回终端结果。queued/running 返回只能提供状态和
taskID；捕获正文由 output 读取单独提供。

没有派发身份的 idle 事件只能触发现有 Agent 协调。子命令取消必须使用 Runtime 冻结的派发，并重新检查当前宿主活动状态和派发身份；延迟到达的 idle 事件不得取消已恢复的
活动执行。宿主状态映射会省略 idle Session；只有在 Session 和冻结派发得到验证后，缺失条目才可接受为 idle。显式格式错误/未知条目必须保持
unknown，busy/retry 条目必须阻止终端结算。显式中止/删除和释放操作保留其取消边界。

### Workflow（Beta，`WFL`）

Workflow 为实验性 Beta，不宣称稳定或生产可用。顶层 `config.enableWorkflow` 必须为布尔值，默认 `false`，省略同样关闭；仅显式 `true` 才开放工具入口、授权投影及流程发现。Agent 的 `loadWorkflows`、显式 permission 或 Plan 覆盖不能绕过此总开关。关闭时不读取或推进会话中的 Workflow Run，不影响普通 Agent/Command Task，也不取消已创建任务；定义文件可继续静态校验和保留。切换后须重建并重启，不能热迁移活动实例。双语 README、Schema、默认配置和工具说明必须标注 Beta 与显式开启方法。

Workflow 尝试以检查点辅助主 Agent 协调工作，不是后台任务调度器，也不保证工作完成。仅接受 `contract: "process-v1"` 定义和新会话创建的当前契约检查点；不兼容、迁移、扫描或处理旧 Run。主 Agent 默认直接执行 Step；显式 Task 仍由主 Agent 调用现有 `task`，Workflow 不等待、调度、取消或回复其交互。

`o4e_workflow` 必须使用显式 `action: catalog/list/start/read/begin/report/resume/pause/stop`。`start`、`resume` 和消息 hook 不创建执行 Session、不派发模型、不重放副作用。Run 记录位于 owner Session 的 `metadata.o4e.workflowProcess`；`runSessionID` 就是 owner Session，不另建 Workflow Task ledger。`runID` 是领域身份，不是 `o4e_task` ID。

`list` 不要求 runID，仅列出当前 owner、同一调用 Agent 有权访问的当前契约 Run，返回有界的名称、状态、revision、活动 Step/Attempt 和步骤计数摘要，不返回输入、输出、报告或证据正文。每个可见 Workflow 必须按已有名称权限经过宿主 ask 并重新校验；无可见项返回空列表。损坏检查点、定义漂移或不可验证来源不得伪装成可继续的有效 Run。list 不写入、不恢复、不扫描其他 Session；read 和所有写操作仍独立校验。

首期每个 owner 仅有一个 running/interrupted Run，每个 Run 仅有一个 active Step。暂停可以释放活动 Run 绑定，但不丢弃 active Attempt；恢复仍保留同一 Attempt。有限修复只在拒绝报告后由显式 `begin` 创建，不能隐式重试执行。当前不支持嵌套、Loop、并行主会话 Step 或主 Session Effect/Scope 沙箱；对应硬要求必须明确拒绝，不得降级为 Prompt。

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `WFL-001` | 定义必须声明 `contract: process-v1`、`name`、`description`、`output`、非空 `steps`；文件名必须等于 `name`。可选 `$schema` 必须为字符串；非可空字段的默认值仅适用于省略，不得用显式 null 绕过字段类型校验。 | Workflow Schema、definition 测试 |
| `WFL-002` | Step 只支持显式 `type: work`，id 拒绝保留名称 constructor/prototype；依赖使用 `dependsOn`，重复依赖按首次出现顺序去重，不增加执行次数。旧 agent/workflow/loop 定义拒绝。 | definition 测试 |
| `WFL-003` | `execution` 默认 `{mode:self}`；`{mode:task,agent:<name>}` 仅规定主 Agent 调用现有 task，Gate 要求匹配目标的可信创建/结果引用，不兑换 Task 授权。 | process/evidence 测试 |
| `WFL-004` | 输入只读取 workflow 或声明的 dependencies；输出只读取通过 Gate 的步骤 output。拒绝循环、缺失依赖和越界映射。 | definition/process 测试 |
| `WFL-005` | 严格 Gate 校验 outputSchema、artifactsMin 以及 gate.evidence；`task-result` 可以声明 `taskFrom`，绑定直接依赖中已接受 `task-created` 事实的唯一可信 Task 身份。拒绝未知 Schema 关键字。maxRepairRounds 为 0..10，默认 2；修复只能显式 begin。最终输出 Schema 未通过不得 completed。 | process 测试 |
| `WFL-006` | 嵌套、Loop、并行主 Step、硬隔离及主 Session effect/scope 声明当前必须拒绝；需要隔离的实际工作使用已授权 Task，不伪称 Workflow 执行了沙箱。 | definition 测试 |
| `WFL-007` | begin/report/resume/pause/stop 要求正整数 expectedRevision；持久化 revision 严格递增。同进程按目录/owner 串行化并校验存储版本，不承诺跨进程 CAS 或 exactly-once。 | process 并发/故障测试 |
| `WFL-008` | report 必须绑定 stepID、attemptID、submissionID。相同 submissionID 和 payload 返回同一持久化决定；不同 payload 拒绝。保存成功而响应丢失可重读，不重放工具执行。无法验证当前记录时 fail closed。 | process 恢复测试 |
| `WFL-009` | 所有操作限受管 primary/all 根 owner 和同一 Agent；按加载策略、当前 O4E/host permission 校验。除 catalog 外每次入口均经 host ask，包括 O4E allow；ask 后重验，缺失 ask 拒绝。 | process 权限/插件测试 |
| `WFL-010` | start/begin/report/resume 等写操作绑定可信当前 assistant Tool Part 及其宿主 `parentID` 指向的真实 user 消息。不得把毫秒时间戳、消息数组位置或 ID 字典序当成同时间戳先后证明；存在无法由可信父关系消除的新用户消息歧义时必须 fail closed。chat.message 只中断当前 owner 索引的 Run；新指令后显式 resume，active Attempt 不重放。消息时序不证明模型理解指令。 | process/plugin-background 测试 |
| `WFL-011` | catalog 按 loadWorkflows、visibility 和当前权限过滤；list 按同 owner、同 Agent 和当前权限返回经宿主授权的有界 Run 摘要；read 返回 owner 检查点。pause/stop 仅阻止流程推进，不停止 Session、Task 或 Command；不建统一后台 Workflow ledger。 | process/plugin 测试 |
| `WFL-012` | StepReport 恰含 status/output/artifacts/evidence/diagnostics；status 为 reported-completed 或 failed，后三项为数组且 diagnostics 是字符串数组。Gate 接受独立于模型完成声明。仅支持 command-success/task-created/task-result 事实引用；不接受 prose 证明、未知 evidence 类型、跨 owner、失效或不完整来源。 | process/evidence 测试 |

事实引用为 `{kind,taskID,messageID,callID}`，message/call 指向 owner 在当前 Attempt 开始后、report 前已经完成的工具 Part。Gate 的 evidence 要求通常为类型字符串；`{"kind":"task-result","taskFrom":"<dependency-step>"}` 额外要求结果 Task 等于该直接依赖 Step 已通过 Gate 的唯一 `task-created` Task。该身份来自 Runtime 已重新验证的账本、授权信封和工具 Part，不信任 Step output 或模型文字；依赖未通过、身份不唯一、引用被修改或结果指向其他 Task 均拒绝。command-success 要求规范 owner 索引/命令账本一致、原命令 hash 匹配、实际 completed/exitCode=0、输出已读且未截断、完整日志；Task 创建只证明已创建，结果必须有已完成的 `o4e_task output` 公开正文及当前结果 Message/Part 来源。文件/hash、任意 shell 谓词和完整测试覆盖证明不支持。Artifact 仍为模型声明，不是文件事实。

Workflow 工具 Schema 必须显式描述严格 StepReport、状态枚举及动作所需字段，输入错误提供脱敏且可操作的字段诊断。`input` 和 `report` 使用原生 JSON 值，禁止隐式二次解析字符串。`read` 对 active Attempt 提供有界 `availableEvidence.references`，来源只取当前 owner 已完成工具 Part，并使用报告 Gate 同一 verifier 验证；不得代替执行、读取结果、恢复或消费回执。最多返回 32 条引用、检查 128 个候选及 5000 个 Part，限额须显式标记；不宣称限制 SDK 下载量。报告提交时必须再次验证引用，发现不是授权或接受证明，不得用模型伪造 ID 补足缺失来源。

### Prompt、模型与安装器（`PRM`、`MOD`、`INS`）

| ID | 要求 | 验收依据 |
| --- | --- | --- |
| `PRM-001` | 系统组装必须先应用受管接管，再注入 Soul。消息组装必须依次运行 `messagePrompt`、`planReminder`，然后记录回退。 | `src/adapters/opencode/plugin-hooks.ts`; 插件测试 |
| `PRM-002` | Prompt、提醒、指令和 Soul 文本可以在文档规定的钩子边界热加载，无需重建静态 Runtime Snapshot。 | 插件钩子；`src/agent-context.mjs`; `src/soul.mjs`; 插件测试 |
| `PRM-003` | 普通 `base`/`systemPrompt` Agent 必须用 O4E 标记、核心 Prompt、注入内容、可选后台任务协议和受管指令文件替换宿主系统。`nativeSystem` 则必须连接其声明的 Prompt 片段，仅保留 O4E 标记之后且 `Instructions from:` 之前的宿主尾部，再追加可选协议和受管指令。每次受管 Agent 与 Plan 接管都必须追加明确的工作区上下文，指出当前 Session 的 `directory` 是活动文件/命令 cwd，`worktree` 是仓库/项目指令根；该上下文不得依赖委派权限。原生 `keep` 及没有 O4E 标记的系统保持不变。两条接管分支都必须将 Soul 放在最前面。 | `src/core/prompt-assembly.mjs`; `src/adapters/opencode/plugin-hooks.ts`; `test/plugin-config.test.mjs`; `test/soul.test.mjs` |
| `MOD-001` | `default` 下 Agent Task 必须冻结目标 Agent 的配置模型及有序 fallback 候选数据；未配置候选时才继承已验证父 Session 当前有效模型和 variant。候选只用于保留兼容配置、诊断和主 Agent 显式决策，O4E 不得据此自动切换模型。config.provider 只是覆盖项，不得据此剔除内置模型；实际模型由宿主请求时解析验证。若已有完整解析结果且候选全部不可用则拒绝，不可静默继承。恢复与续接保留冻结链，不重新吸收配置修改。`clear` 不保留配置候选，仅继承父 Session 当前选择。命令任务不使用模型。 | `src/runtime/delegation-runtime.mjs`; 后台任务 Runtime；模型冻结测试 |
| `MOD-002` | `default` 的 config hook 必须投影受管 Agent 配置模型及 variant；未配置时保留宿主选择。Primary `chat.message` 不改写用户选定的模型及 variant，自动续接使用实际消息选择。O4E 对 Primary 或受管子任务都不得在模型错误后自动模型重试或自动切换 fallback；受管 Agent Task 的所有模型错误（包括非 `APIError` 和宿主标记不可重试者）必须保留原因并进入可由 owner 主 Agent 以最新 CAS revision 显式选择 `continue`、`restart` 或 `stop` 的等待。错误分类和候选只可提供诊断/建议，不替调用方决策。显式继续或重启必须保留授权、取消、Attempt、Scope Lock 和副作用边界；调用方在已有管理授权内作出选择时不要求额外自然语言用户确认。宿主 provider 内部重试不在插件控制边界内。`clear` 清除最终配置中的顶层和全部 Agent 模型/variant，禁用内部配置候选，不修改实际消息、源文件、宿主偏好、凭据或持久模型库。 | `src/model-fallback.mjs`; `src/runtime/event-pipeline.mjs`; `src/runtime/background-task-runtime.mjs`; `src/adapters/opencode/plugin-hooks.ts`; 模型与后台任务测试 |
| `INS-001` | 安装、构建、状态查看、导入、导出和卸载必须保留项目所有者文件，且不得创建或管理项目 `SPEC.md`。 | `scripts/installer.mjs`; 安装器测试 |
| `INS-004` | 构建必须声明 O4E 直接使用的 Effect 与 Bash parser 运行依赖，但不得执行依赖安装或补入 `@opencode-ai/plugin` 默认版本；运行 SDK 由宿主准备，仓库开发 SDK 固定版本不构成目标运行目录的版本锁。目标已有 SDK 和 Effect 声明必须保留，不隐式删除或覆盖。依赖声明不证明安装或离线就绪，不改变卡片与任务运行行为。 | `src/runtime-builder.mjs`; 构建与安装器测试；`docs/reference/cli.md` |
| `INS-002` | 仓库默认值必须维护成对的 `cn`/`en` Prompt，而已安装目标在 `.o4e/prompts/` 下只能直接包含所选语言。交互安装器必须分别选择可作为主会话入口的 `all`/`primary` 与仅可委派的 `subagent`，不得把两类角色混在同一选择列表。默认 orchestrator 为 child Plan、chat 为 self Plan；专业子角色 architect 为 child Plan，researcher/reviewer 为 self Plan，debugger/tester 为普通模式。subagent 支持 self/child Plan，但展开后仍仅可委派，不产生主选择器入口。专业 Plan 默认关闭 MCP 且有效 Effect 为 read，显式能力覆盖仍遵循 AGT-005。 | 安装器实现与测试 |
| `INS-003` | O4E 必须维护插件受管默认 Skill 的内部注册表，不能将该注册表暴露为用户配置。安装器选择必须支持全部默认值、精确重复 `--skill=<name>` 子集或 `--no-skills`；重新安装只能清理未选中的默认受管 Skill，保留用户创建的 `.o4e/skills/`，且绝不创建、检查、清理、作为 Runtime 导出或卸载公开的 `.opencode/skills/`。 | `scripts/installer.mjs`; `src/managed-skills.mjs`; `src/runtime-builder.mjs`; 安装器与构建测试 |
| `INS-005` | CLI 必须提供 `model` 子命令修改已安装目标的模型配置：支持全局 `defaultModel` 与具体 `all`/`primary`/`subagent` Agent 的 `model`，均可携带 `variant`，`null` 恢复继承；不提供 `fallbackModels`、system Agent 和 Plan 模型的编辑入口。必须保留用户 JSONC 注释与其余配置，只编辑按既有优先级选定的配置文件（`config.jsonc` 优先于 `config.json`，Agent 文件同理）；写入后必须通过正常 Builder 重建，校验失败必须恢复原文件并报告。交互模式与交互安装/卸载一致，先选择界面语言（`--lang` 仅作为初始值），且在未指定 `--target`/`--global` 时必须让用户选择项目或全局范围；静默模式沿用现有 target/global 约定，结果提示跟随 `--lang`。不得修改 `.opencode/` 生成物、宿主模型库或凭据；修改只影响重建后的新投影，不重新吸收到已冻结的 Agent Task。 | `scripts/installer.mjs`; `scripts/model-config.mjs`; 安装器与模型配置测试 |
| `INS-006` | 所有需要加载模型目录的交互式安装器入口（`install`、`model`）必须在进入命令后即开始后台预加载，模型选择步骤不得成为目录加载的首次触发。目标范围尚未确定时必须对项目和全局候选范围并行预加载；范围确定后以及模型选择时必须复用已启动的同目录任务，不得重复加载。 | `scripts/installer.mjs`; 安装器与模型配置测试 |

## 验证基线

只有相关聚焦测试和仓库级行为测试均通过时，变更才满足本契约。测试应保留当前生产行为所需的最小代表集合，而不是固定措辞、源码布局、内部调用次数或重复用例。常规发布基线为：

```bash
npm test
npm run test:verbose # 可选：输出逐测试进度与成功信息
```

精简的 `test/run.mjs` 入口必须在测试文件 glob 之前保留追加的 Node 测试运行器参数。默认 `npm test`
报告器必须保持成功输出简洁：打印最终数量/耗时摘要和有界的慢测试区段，同时保留失败与取消相关的 stdout、stderr 及错误诊断。它有意不输出长时间运行进度。`npm run test:verbose` 提供内置的逐测试 `spec` 视图；`--test-name-pattern` 等 Node 测试运行器参数在两个入口中都必须继续支持。

本 SPEC 描述要求，其他仓库 Markdown 按“契约权威与文本真实性”区分当前行为、契约缺口与未验证项。外部笔记、历史记录、损坏账本以及当前源码未定义的名称都不能覆盖本契约。

## 实施边界

本节归纳既有实施边界，具体验收仍以对应需求条款为准。本 SPEC 是唯一的产品与工程契约，不再按问题编号维护公开台账。内部记录可以保留详细复现、修复历史、证据和分阶段计划，但必须引用对应需求及本文件的边界、验证范围，不能另行定义要求；分类或结论冲突时以本 SPEC 为准。

### 契约与证据使用

- 仅有方案或计划的内容不得通过 Prompt、README、测试标题或模拟测试被描述为已实现；源码、Schema 或 CLI 已实现不表示已完成目标平台验收。自动化测试必须区分模拟宿主与真实宿主。
- 修复已确认的契约差距前，必须先更新对应需求、验收证据和影响范围；不得以降低 SPEC 要求的方式关闭问题，契约调整仍须明确的需求变更授权。
- 未验证范围只能凭对应的真实宿主或目标平台证据升级验收结论，不能由源码分支或 Mock 测试单独升级。宣称问题不再成立必须有实现和验收证据，并保留可追溯的修复或验证引用；已有实现和测试的历史修复不再作为未解决问题重复列示，也不自动扩大其验证范围。
- 已确认的产品边界只有在明确的产品边界变更后才能移除，否则必须继续在公开文档披露；实现缺陷或缺少证据不能改写为获准的产品边界。建议、历史状态和测试计划不得冒充当前能力。

### 运行与公开能力边界

- 调度器和 Scope Lock 是进程内协调，不是跨进程租约或 OS 沙箱。所属进程组的停止证据不涵盖通过 `setsid`/`setpgid` 逃逸的后代。
- 全局受管 `bash` 会创建命令任务，包括受权限约束的原生 `keep` 调用方。执行支持 OpenCode 当前支持的平台和 Host Shell，使用宿主 `config.shell` 及其默认解析，不做 O4E shell fallback。命令原样交给目标 Shell，并继承启动环境；公开插件 API 不暴露其他插件的 `shell.env` 钩子。
- Watch 默认支持混合 Agent/命令选择并包含两种类型；其他命令管理操作需要一个显式 `taskID`。命令不支持输入、重启、模型委派或 Agent 回执唤醒。长命令在默认 10 秒运行
  窗口后分离，并在普通根所有者空闲及根回合 abort 后继续；显式 Task cancel、owner 删除、子任务生命周期和释放仍会停止它们，未脱离的 Bash 调用方中止也会停止执行。
- 命令内存最多保留 64 KiB 视图，另有 Bash 20 KiB、其他命令操作 40 KiB 的结构化元数据预算。Bash 模型文本单独使用 48 KiB/1800
  行预算，并有明确截断控制。私有文本日志每个上限 256 MiB，自终端结算起延迟保留 24 小时；存储/捕获失败会明确标记为不完整。完整日志需要获授权的宿主文件读取，而非 inspect
  分页。重新加载不会重放旧声明；句柄缺失以及停止/持久化不确定时会保守保留 Command 资源准入，不声称恢复成功。Bash 不参与写范围锁，不能保证与其他命令或 Agent 并发修改文件时无冲突。
- `fallbackModels` 保留为冻结候选数据，但 O4E 不自动模型重试或自动 fallback。后台 Agent Task 的任何模型错误都等待显式 retry decision：调用方必须携带 `expectedRevision` 选择 `continue`、`restart` 或 `stop`，并重新通过 owner、权限、Attempt、Scope、取消和副作用校验；`restart` 的重复副作用风险不得被隐式接受。宿主 provider 可能在插件边界内不可见地自行重试，O4E 无法关闭该行为。
- Workflow 与 Task/Command 管理面保持分离，不建立后台 Workflow ledger。同 Agent 获权的 `list` 摘要不要求预先知道 runID，仍按 Workflow 名称经过 host ask 并重验权限与来源；TUI 检查点列表和步骤详情只是已同步记录快照，不是 Gate 重新验证结果。
- Workflow Gate 仅接受 `WFL-012` 规定的三种有限事实引用，不证明测试覆盖充分、专业结论正确、文件存在或任意 hash/谓词成立；不增加 prose、文件 hash 或通用事实 DSL。
- Workflow Schema 与 normalizer 均拒绝保留 Step ID，接受并由 normalizer 去重 dependsOn。Schema 保留非空白描述、依赖/Agent 名称及安全整数上限校验；normalizer 继续拒绝非字符串 `$schema` 及非可空字段的显式 null，并校验 DAG、引用目标、类型专属关键字及 required/property 关联。没有新增生产 Schema 引擎；有限测试校验器不是完整 JSON Schema 标准实现，不宣称所有语义接受集合完全相同。
- Command 展示继续在终态过滤前校验停止证据及类型专属 claim/status 约束；双方 claim 缺失、null、空白或无效字符串的 completed/failed 记录必须投影为 unknown/unavailable，不得当作完成隐藏。合法未提交的 cancelled/interrupted 仅接受 null claim 和停止证据。这些展示校验不扩大为完整 Runtime 账本验证或执行/Gate 授权。
- 静默卸载和交互卸载默认均保留 `.o4e/`；删除须主动选择不保留并最终确认，保留删除摘要与备份提醒。

## 验证范围与待验收项

以下区分已有范围证据与尚未完成的验收，不将模块观察直接认定为正常用户故障。正常入口可达性及异常适用范围仍遵循“正常使用与异常处理范围”；直接篡改内部状态、孤立模块调用或多窗口竞争不能替代正常宿主路径证据。测试通过、真实 CLI 工具证据和交互 TUI 视觉证据各有范围，不能相互替代。

### 平台、自动跟踪与展示

- 项目开发于 Linux，对 Windows/macOS 等其他系统提供基本兼容。已有平台适配、模拟测试和 Linux 证据，但没有足够的 Windows/macOS 完整真实宿主生命周期证据，不宣称完全支持。如需扩大支持声明，必须补齐安装、构建、默认及显式 Host Shell、参数协议、路径、编码、进程启动与终止、超时与取消、日志及恢复的正常和失败路径；公开文档继续披露未全面实机验证范围。
- 侧栏投影、follow 控制、actionable 唤醒、插话 fencing 和失败诊断有自动化测试。Linux / OpenCode 1.18.31 已验证两种详情模式的真实 CLI ToolPart、follow 启停和 Bash watch/output，交互 TUI 已有 Bash 记录展示证据。子 Agent 与 Todo 同屏排序、动态切换、完整多回合生命周期及崩溃恢复尚未全部验收；同进程去重不能证明跨进程提交 exactly-once，跨进程与崩溃投递仍未验证。
- 终态通知检查异常、诊断持久化失败和 owner 恢复副本发布有自动化回归，真实宿主持续接口/存储故障及跨平台仍待验收。已知 busy/retry 先等待，不读取消息或消耗检查失败预算；普通自动续接、终态通知检查和终态提交的预算保持独立。owner 发布继续保持 revision、回执和取消证据合并，不回滚已接受结果或重复执行。底层写入永久不返回仍可能等待，不保证界面同帧刷新。

### 宿主释放与恢复

- 最后 facade 释放的现有证据属于模块观察，尚未证明正常宿主退出会留下仍在运行的 Agent。正常宿主路径中的 Agent 停止、停止确认和最后所有者保锁闭环仍待验证；存在存活 facade 的合法 handoff 须独立覆盖，不误取消合法接管者。不得仅凭 dispose 返回成功推断 Agent 已停止。
- 释放失败后外层与 Command Runtime 状态不一致属于模块观察，尚未证明正常宿主会复用释放失败的旧实例；该正常路径及可观察影响仍待证。此项不认定为已确认用户故障或已解决，也不改变既有生命周期策略。
- 上述两项观察不降低 `RUN-003`、`BGT-011` 与 `CMD-009`：释放仍须同步静默、停止新工作、等待已准入操作及刷新，按既有生命周期边界发起停止；停止或持久化不确定时保守保留资源准入及适用的 Agent 锁，Command 不持有写锁，释放失败仍须可重试。不得重放旧命令，亦不得宣称全部工具已恢复。
- 终态提交预算在顺序重启/重载中的连续性仍属正常路径待证。正常启动不自动恢复所有旧 Session，新用户回合会合法开启新跟踪意图；尚未证明单入口顺序重载后，同一意图/消息实际超限提交。须先验证无新用户意图的正常恢复链路及已投递去重，证明可达后再制定持久预算修复，不将多窗口或内部重建脚本作为用户故障证据。

### Workflow Gate 与其他验收

- process-v1 的三种有限事实引用及检查点查询已有自动化覆盖。Linux / OpenCode 1.18.31 / 真实模型已验证 `task-created`、`task-result` 的实际 Tool Part、单步 report Gate 接受与 read/list completed；已有查询与展示实现不再作为未解决的可见性缺口。完整多用户回合、交互及顺序重启仍未全部实机验收，不得把整体标为真实宿主验收完成。
- `command-success` 专项 Gate，以及正常工具入口的无效事实引用、截断、通过支持入口删除来源、compaction、顺序重启和授权 UI 等矩阵尚未完成。保留已有部分正向证据；直接改写宿主内部记录不作为验收门槛。
- 卸载默认保留、Command 展示校验及 Workflow Schema/normalizer 校验已有自动化覆盖，不代表真实终端键盘、完整宿主交互或其他平台均已验收。验收聚焦正常宿主交互及范围内异常，人为构造无效记录不证明正常使用可达，也不增加损坏注入验收要求。
- Mermaid 及其他由浏览器渲染的文档图表，除离线 HTML 构建成功外，还需要浏览器验证。
