# process-v1 Schema

顶层：contract（必须 process-v1）、name、description、output、steps 必填；visibility 默认 entry，另可 internal（不可直接启动，当前不支持嵌套）。
Step：id/type 必填，type 只支持 work；可选 description、dependsOn、input、inputSchema、outputSchema、execution、gate、maxRepairRounds。
execution 默认 `{mode:self}`，显式 Task 为 `{mode:task,agent:<name>}`；只是工作要求，不授予 Task 权限。
gate 支持 artifactsMin 非负整数、evidence 数组（command-success/task-created/task-result）。task-result 还可使用 `{kind:"task-result",taskFrom:"<direct-dependency>"}`，绑定该 task 依赖已接受 task-created 事实的唯一 Task 身份。
maxRepairRounds 为 0..10，默认 2。

顶层和每个 Step 的 inputSchema/outputSchema 省略时分别默认 `{type:"object"}`，不是无约束或继承另一层 Schema。Step 默认继承 Run 的输入值，但仍按自身 Schema 校验。标量、数组和 null 必须在相关输入/输出层显式声明；省略 outputSchema 时 StepReport.output 应为对象。

当前 Schema/构建器尚有差异：不要使用保留 Step ID `constructor`/`prototype`，不要重复 dependsOn。Schema 尚未排除这两个 ID，而构建器会拒绝；Schema 拒绝重复依赖，而构建器当前去重。两者一致性仍待修复。

Schema 必须有单值 type；仅支持 object/array/string/number/integer/boolean/null、properties、required、布尔 additionalProperties、items、enum、minLength、minItems、description。
关键字须匹配类型，required 名称须在 properties；所有未知关键字拒绝。

模板为 JSON 值或 `{$from,path?,default?}`；Step 来源为 workflow/dependencies，顶层输出来源为 steps。
path 为 JSON Pointer，空字符串指整个来源。只有声明并通过 Gate 的依赖输出可引用。

禁止旧 agent/workflow/loop、task.description/skill/effect/agent selector、recovery 策略和主 Session 隔离字段。
仅当前定义/检查点，不做旧契约读取或迁移。
