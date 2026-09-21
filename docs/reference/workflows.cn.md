# Workflow 参考（Beta）

[中文](workflows.cn.md) | [English](workflows.md)

[← 文档中心](../README.cn.md) | [Agent](./agents.cn.md) | [配置](./configuration.cn.md)

Workflow 是实验性 Beta 检查点协议，默认关闭，不宣称稳定或生产可用，也不是后台多 Agent 调度器。
普通步骤由当前主 Agent 使用现有工具直接完成；Runtime 验证依赖、报告、Gate 和持久化版本。
只有显式 Task 要求才调用现有 `task`。Workflow 不负责 Task 等待、调度、取消、回执或交互。

## 当前边界

- 必须在 `.o4e/config.jsonc` 显式设置 `"enableWorkflow": true`，重建并重启 OpenCode 后才开放；省略、`false` 均关闭，非布尔值报错。`loadWorkflows` 和权限不能代替总开关。
- 关闭不删除定义或检查点、不取消既有 Agent/Command 任务，但不开放 Workflow 读取或推进入口。定义仍需通过静态校验。

- 仅接受 `contract: "process-v1"`，直接破坏性替换旧 agent/workflow/loop 定义和旧调用协议。
- 仅面向新会话创建的新 Run；不迁移、扫描或处理旧会话/旧 Run。
- 新契约自身支持插件重启、响应丢失后的 owner 检查点恢复，不隐式跨会话接管。
- 每个 owner 同时一个 running/interrupted Run，每个 Run 同时一个 active Step。
- 嵌套、Loop、并行主 Step、effect/writeScopes/permissionOverlay 等主 Session 隔离声明均明确拒绝。
- 不承诺跨进程 CAS、exactly-once、外部副作用与报告原子提交或主 Session 工具沙箱。
- Linux / OpenCode 1.18.31 / 真实模型已验证单步 Task 创建、结果读取、report Gate 接受及 read/list 完成状态。三类 evidence 的完整矩阵、多用户回合、compaction、重启、授权 UI 和 Windows/macOS 仍需独立验收；模拟插件测试不是宿主验证。

## 定义

文件位于 `.o4e/workflows/<name>.jsonc`，文件名必须等于 `name`。

```jsonc
{
  "$schema": "../schemas/workflow.schema.json",
  "contract": "process-v1",
  "name": "bounded-change",
  "description": "设计、实施和验证一个有限变更",
  "inputSchema": {
    "type": "object",
    "required": ["task"],
    "properties": { "task": { "type": "string", "minLength": 1 } }
  },
  "output": { "$from": "steps", "path": "/verify" },
  "outputSchema": { "type": "object" },
  "steps": [
    { "id": "design", "type": "work", "description": "读取需求并确定边界和验收条件" },
    {
      "id": "implement", "type": "work", "dependsOn": ["design"],
      "description": "由主 Agent 完成授权范围内的实施",
      "input": { "$from": "dependencies", "path": "/design" },
      "maxRepairRounds": 1
    },
    {
      "id": "verify", "type": "work", "dependsOn": ["implement"],
      "description": "执行测试并读取真实结果，报告未验证项",
      "gate": { "evidence": ["command-success"] }
    }
  ]
}
```

顶层必填 `contract/name/description/output/steps`。`visibility` 默认 `entry`；`internal` 不可直接启动，当前也不支持子 Workflow 调用。
Step 必填 `id/type`，type 只能是 `work`。`description` 缺省为 id；`execution` 缺省 `{mode:"self"}`。
`maxRepairRounds` 默认 2，范围 0..10；失败后必须显式 begin，耗尽后不能靠 resume 增加次数。

输入默认继承 Run input；显式模板只能使用 `$from:"workflow"` 或已声明的 `dependencies`。
后者映射的是已接受的领域 output，不是完整 StepReport。顶层 output 只能读取 `steps`。
`path` 为 JSON Pointer（空串表示整个来源），`default` 仅在路径不存在时生效。缺失来源、非法引用和 DAG 循环拒绝。

### 支持的 Schema 子集

每个 Schema 必须显式声明单个 `type`：object/array/string/number/integer/boolean/null。
Workflow 顶层和每个 Step 的 `inputSchema`、`outputSchema` **省略时各自默认 `{type:"object"}`**，不是无约束，也不会继承另一层 Schema。Step 默认继承的是 Run 的输入值，不是 Run 的 inputSchema。例如顶层显式允许 string，而 Step 省略 inputSchema 时，start 可以成功，但 begin 会因 Step 仍要求 object 而拒绝；使用标量、数组或 null 时须在相应层显式声明类型。省略 outputSchema 的报告也必须提供 object output。

支持 `properties`、`required`、布尔 `additionalProperties`、`items`、`enum`、`minLength`、`minItems`、`description`。
未知关键字和类型不适用的关键字拒绝；`required` 名称须出现在 properties 中。
不支持 `$ref/const/oneOf/allOf/pattern/format/minimum` 等，不会静默忽略它们。

Step id 不得使用保留名称 `constructor` 或 `prototype`。`dependsOn` 允许重复输入，构建器按首次出现顺序去重；重复项不会创建额外依赖或执行次数。Schema 和构建器保持这两项语义一致；DAG、引用目标和 Schema 关键字的语义约束仍由构建器验证。

非可空配置字段的默认值只适用于省略；`visibility`、`execution`、`maxRepairRounds`、`gate.artifactsMin`、对象 Schema 的 `properties` 不接受显式 `null`。可选 `$schema` 注解必须是字符串。这不限制通过 `type:"null"` 明确声明的业务输入或输出值。

## 工具协议

所有请求都必须显式提供 action；旧省略 action、bindings、resumeRunID 不接受。

`input`、`report` 使用原生 JSON 值，不用 JSON 字符串包装对象；字符串输入保持字符串，不会隐式解析。`begin` 必须提供 `stepID`，完成报告的 `status` 必须为 `reported-completed`，不是 `completed`；错误会提示所缺字段或合法格式，但不回显输入内容。

执行后调用 `read`，从 `availableEvidence.references` 复制适用于当前 Step 的 `{kind,taskID,messageID,callID}` 到 `report.evidence`。引用从当前 owner 已完成工具记录提取，经过与 Gate 相同的验证；提交报告时仍重新验证。没有引用不代表成功，不要猜 ID 或为了取得 ID 重跑副作用。发现最多返回 32 条、检查 128 个候选与 5000 个 Part，超限显示 `limited:true`；这些不是底层 SDK 下载量上限。

| action | 参数 | 行为 |
| --- | --- | --- |
| catalog | 无 | 返回当前主 Agent 获准 entry 定义及 inputSchema |
| list | 无 | 按现有名称权限经宿主授权，列出当前 owner、同 Agent 的 Run 摘要；不恢复或写入 |
| start | workflow，可选 input | 冻结定义和输入，返回 revision=1；不创建子 Session |
| read | runID | 重读当前 owner 检查点、requirements、ready、steps、submissions；active Attempt 提供经验证的 availableEvidence.references |
| begin | runID、stepID、expectedRevision | 开始一个依赖已通过的 Attempt，返回 attemptID、输入和要求 |
| report | runID、stepID、attemptID、submissionID、expectedRevision、report | 验收并持久化接受/拒绝决定；不执行下一步 |
| resume | runID、expectedRevision | 处理最新指令后恢复推进；保留 active Attempt，不重放工作 |
| pause | runID、expectedRevision | 暂停并释放当前 Run 绑定，不取消 Task |
| stop | runID、expectedRevision | 终止后续推进，不停止主 Session、Task 或命令 |

```json
{"action":"start","workflow":"feature-development","input":{"task":"实现已确认变更"}}
```

`runID` 为 `wfr_...` 领域身份；`runSessionID` 等于 owner Session。记录位于
`metadata.o4e.workflowProcess`，没有另一个后台 Workflow ledger、taskID 或执行 Session。
`o4e_task` 只管理真实 Task/Command，不能管理 Run。

begin/report/resume/pause/stop 使用正整数 expectedRevision。相同目录/owner 的同进程调用串行化，持久化前复核版本。
report 的相同 submissionID+payload 重试返回已经保存的决定（即使后续 revision 改变）；不同 payload 拒绝。
start 的同一消息/调用来源可重读同一 Run；不同工具调用不会被猜测为同一次启动。
当前每个 owner 最多保存 32 个 Run，单次请求 JSON 最大 64 KiB；达到限制明确拒绝，不自动清理用户记录。

不知道 `runID` 时使用 `{"action":"list"}`。列表仅返回名称、状态、revision、活动步骤／Attempt 和步骤计数，不含输入、输出、报告或证据正文。无可见项返回空列表；无权限条目不泄露，定义漂移、损坏或失效来源不会被呈现为有效可继续的 Run。每个可见 Workflow 按名称进行宿主授权并在授权后重验，后续 `read` 和写操作仍独立校验。TUI 的检查点面板仅显示宿主同步快照，不等于该工具的来源／授权检查。

## StepReport 与 Gate

```json
{
  "status": "reported-completed",
  "output": { "summary": "已执行的实际结果" },
  "artifacts": [],
  "evidence": [],
  "diagnostics": []
}
```

恰好这五个字段；status 只能是 reported-completed 或 failed，后三项为数组，diagnostics 元素为字符串。
reported-completed 只是模型报告；只有 `decision.accepted:true` 才通过 Gate。
Gate 检查 outputSchema、artifactsMin 和 gate.evidence；最终 Run 输出也必须通过 Schema。
Artifact 是声明，不证明文件存在；不要把自然语言放入 evidence 冒充事实。

`gate.evidence` 通常使用事实类型字符串。跨 Step 收集同一 Task 结果时使用：

```json
{"kind":"task-result","taskFrom":"review"}
```

`taskFrom` 必须是当前 Step 的直接依赖、该依赖必须为 `execution.mode:"task"` 且 Gate 要求
`task-created`。Runtime 从该依赖已接受且重新验证的 Task 创建引用提取唯一 `taskID`，再要求当前
`task-result` 指向同一 Task；不会信任依赖 output 中的 taskID 或模型文字。依赖未通过、身份不唯一、
错误 Agent/Task、伪造或修改引用都会拒绝，并在重读恢复时重新验证。

支持的事实引用只有：

```json
{"kind":"command-success","taskID":"o4e_command_...","messageID":"msg_...","callID":"call_..."}
```

- `command-success`：owner 的原始成功 Bash 或后续 output Part，原命令 hash、owner 索引和规范账本匹配；必须 completed、exitCode=0、停止已确认、输出已实际读取且不截断、日志完整。只证明该命令成功，不证明覆盖充分。
- `task-created`：owner 已完成 task 工具 Part 与真实 Task/授权信封匹配；只证明创建，不证明审查通过。
- `task-result`：owner 已完成 `o4e_task output` Part，任务 completed、revision/归属/授权匹配，公开正文与当前结果 Message/Parts 一致。只证明取得该结果，结论仍可能是专业判断。

引用必须在当前 Attempt begin 之后、report 之前。缺失 begin/调用来源、跨 owner、伪造、失效、截断或来源删除拒绝。
不支持文件 hash、任意命令条件、通用事实 DSL；未知 evidence 要求在定义/报告边界拒绝。
长输出或缺失完整日志当前无法满足 command-success，不要改用一句“测试通过”绕过。

## 显式 Task

```jsonc
{
  "id": "review",
  "type": "work",
  "description": "调用 reviewer (plan) Task 并收集其创建引用",
  "execution": { "mode": "task", "agent": "reviewer (plan)" },
  "gate": { "evidence": ["task-created"] }
}
```

主 Agent 调用 task，随后按既有 watch/output 协议处理。Workflow 不替代 task 的 loadAgents、host ask、Effect、Scope Lock 或深度限制。
`quality-gate` 默认定义展示创建/收集两个独立 Step。暂停/停止 Run 后已有 Task 仍存在；主 Agent 应如实列出并按用户意图管理，不自动连带取消。

## 权限、消息与恢复

仅受管 primary/all 根 Session 可使用；owner Session 与 Agent 均绑定，不能由子 Agent 或另一根 Session 接管。
catalog 按加载、黑名单、O4E/host permission 过滤；其他入口即使 O4E allow 也要求宿主 context.ask，之后重新核对策略。
Workflow 授权不授予普通工具或 Task 权限。

chat.message 只中断原 owner 索引中的活动 Run，并返回提示；不扫描历史 Session。
主 Agent 必须先处理最新用户指令，再 read/resume。写操作验证当前 assistant 工具调用及其宿主
`parentID` 指向的真实 user 消息。宿主当前只提供毫秒时间戳；相同时间戳下数组位置和 ID 字典序都
不作为可信先后关系。出现无法由父关系排除的新 user 消息歧义时返回明确错误并 fail closed，而不是
按旧指令推进或自动无限重试。时序校验不能证明模型已经理解新指令。
执行后未报告的 active Attempt 在重启后原样保留，必须对账已有工作，不自动再执行。
持久化失败、定义变化、损坏记录或无法验证的来源均拒绝继续；没有旧字段回填或迁移路径。

## 验证

```bash
node --test test/workflow-definition.test.mjs test/workflow-process.test.mjs
npm test
```

[Workflow creator Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md) 只指导创建配置，不扩大权限。
