---
name: o4e-workflow-creator
description: 创建、修改和验证 O4E process-v1 主 Agent Workflow；定义串行依赖、严格报告、有限事实 Gate 和检查点恢复，不用于 Task 生命周期调度。
---

<!--opencode-for-everything-skill:o4e-workflow-creator-->

# O4E Workflow Creator

## 建立契约

读取当前 config、相关 Agent 的 loadWorkflows/permission、Workflow Schema 和项目规则。
只修改 `.o4e/` 真实源，不编辑 `.opencode/` 生成物或用户运行数据。
仅接受 `contract: process-v1`；旧定义、旧 Run、旧 action 形状不兼容，不迁移、不扫描旧会话。

## Design Steps

- `type: work`；默认主 Agent 直接执行，描述工作要求、依赖、输入和输出。
- `dependsOn` 是 DAG，但同一 Run 只有一个 active Step，不承诺并行。
- 输入来源只允许 workflow/已声明 dependencies；顶层 output 只读取已接受 steps output。
- 不支持 nested Workflow、Loop、主 Session effect/scope/permissionOverlay 沙箱；硬要求必须明确拒绝，不能退化成提示词。
- 必须独立委派时使用 `execution: {mode:task,agent:<name>}`，主 Agent 调用现有 task；loadAgents、host ask、Effect、Scope 和深度仍由 Task 系统执行。
- Workflow 不等待、取消、调度、重试或回答 Task 交互；pause/stop 只停止流程推进。

## Gate 与证据

StepReport 恰含 status/output/artifacts/evidence/diagnostics；reported-completed 不等于 Gate 接受。
支持的 Schema 子集见 [schema.md](references/schema.md)，未知约束必须拒绝，不静默忽略。
顶层和 Step 的 inputSchema/outputSchema 省略时各自默认 object；输入值继承不等于 Schema 继承。输出不是对象时必须显式声明对应类型，diagnostics 始终为字符串数组。
Gate 可以要求 artifactsMin 和 evidence 类型；Artifact 仅为声明。
Evidence 只接受 `{kind,taskID,messageID,callID}`，kind 为 command-success/task-created/task-result。
跨 Step 收集创建 Step 的同一 Task 结果时，Gate 要求写为 `{kind:"task-result",taskFrom:"<direct-dependency>"}`；来源依赖必须是要求 task-created 的 task Step。Runtime 使用已接受并重验的引用身份，不信任 Step output。
引用是 owner 的真实已完成工具 Part，须位于本 Attempt begin 后、report 前；不能填写字符串“测试通过”。
命令成功要求退出 0、完整日志、未截断已读输出及规范来源；Task 创建不代表结果，结果要求已完成 output 读取及当前 Message/Parts。
不支持文件 hash、任意工具事实、通用证明 DSL 或完整覆盖率保证。maxRepairRounds 为 0..10，默认 2；拒绝后显式 begin，不自动重做工具。

## 推进和恢复

仅获准 primary/all 根 Session 可调用显式 action：catalog/list/start/read/begin/report/resume/pause/stop；被委派子 Agent 不可调用入口。list 仅发现当前 owner 同 Agent 有权访问的 Run 摘要，不恢复流程。
start 不创建子 Session；runSessionID 为 owner，Run 检查点保存在 owner metadata.o4e.workflowProcess。
begin/report/resume/pause/stop 使用 expectedRevision；start 不接受该字段。report 绑定 stepID、attemptID、submissionID，相同报告重试返回持久化决定。
新用户消息中断旧边界；处理新指令后 read/resume。重启后 active Attempt 不重放。
不建立后台 Workflow ledger，不承诺跨进程 CAS、exactly-once 或外部副作用原子提交。

## 验证

1. 校验文件名、contract、Step DAG、模板来源、Schema 子集和角色加载权限。
2. 测试三步主会话流程不创建任何委派 Session；Gate 拒绝、过期 revision、错误 owner/Attempt 和重复提交不能错误推进。
3. 覆盖持久化失败、新消息、恢复、权限漂移和不可信证据。
4. 真实宿主与平台未验证时如实记录，不能把模拟测试当成宿主验收。

模板：[entry-workflow.jsonc](templates/entry-workflow.jsonc)、[internal-workflow.jsonc](templates/internal-workflow.jsonc)。
