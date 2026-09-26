# OpenCode V2：O4E 最小上游 API 需求草案

[中文](OPENCODE-V2-UPSTREAM-API.cn.md) | [English](OPENCODE-V2-UPSTREAM-API.md)

**状态：仅供上游讨论的草案；未向上游提交，也不是 V2 已支持声明。** 目标版本为 OpenCode `2.0.15`。本仓库 `SPEC.md` 是 O4E 的契约权威；本草案不降低现有要求，不要求上游采用特定函数名称。

## 已验证的接口边界

核对 npm 固定版本 `@opencode/plugin`、`@opencode/schema`、`@opencode/protocol` `2.0.15` 的类型声明：

| 需要的能力 | 当前公开表面 | 不足及影响 |
| --- | --- | --- |
| 在工具内按资源发起并等待宿主授权 | `ToolContext` 提供 `sessionID`、`agent`、`messageID`、`id`、`signal`、`progress`；插件 `permission` 域只提供 `list/get/reply` 和 `evaluate` hook；**协议层**含 `session.permission.create` | 插件上下文没有可供工具按资源调用、与本次来源绑定并等待用户结果的授权方法；规则的 `allow` 或 `evaluate` hook 不能替代审批。受管 `bash`、`task`、`o4e_task` 和 Workflow 不能接线 |
| 带受控父级创建执行 Session | 插件 `session.create`；其协议请求体没有 `parentID`，但 Session 记录有 `parentID` | 不能创建有真实物理父级的执行 Session，独立根 Session 不能冒充子 Session 或把请求汇聚到根 |
| 有界消息与状态来源 | **协议层**有 `session.messages`（`cursor`、`limit`、`order`）及 `session.active`；插件 `session` 域省略这两项，只暴露 `get` 等选择性方法 | 不得假定协议端点可经插件的认证客户端使用；无法按页验证 Message/Part 来源、用户消息打断及 idle/busy/retry 判定与恢复 |
| 完成后保留原生工具卡片输出 | `ToolContext.progress` 可提交进度；`ToolDomain` 只有 `execute.before/after` hook | 未证明工具调用返回后仍能更新**同一个原始 Part**。后台 Shell 原生卡片的捕获输出、截断与终态不能用新消息或侧栏替代 |

这里的“没有”仅指上述固定版本的公开插件类型签名；不推断私有实现或后续版本能力。协议端点存在不等于插件已获得公开、带认证且可维护的访问通道。不读取本机用户配置或凭据、不使用裸 `fetch`、私有导入或数据库直写来跨过边界。

## 建议的最小扩展与验收

1. **工具作用域的授权请求**：向插件工具调用上下文提供由宿主管理的 `ask({ action, resources, ... })` 等价能力，关联可信 Session、Agent、消息及调用 ID；先评估宿主 deny/ask/allow，deny 立即拒绝，ask 等待用户审批，审批结果须明确且可验证。支持原子 Shell、外部路径、目标 Agent 及管理动作资源；取消、交互失败与超时必须拒绝继续，不允许插件自行构造“已审批”。验收：ask 未批时没有副作用，deny 永不执行，获批后冻结授权并在派发前复核漂移；子任务问题出现在原生根提示中。
2. **受控子 Session 创建**：公开可指定父级的创建能力，宿主验证父级存在、当前调用方对父级的所有权及合法祖先关系；返回持久、可读取的 `parentID`。不能仅接受模型提供的任意父 ID。验收：嵌套子任务、权限/问题提示归属、祖先取消/删除、顺序重启与缺失父级均可机械验证；不提升子 Session 权限。
3. **插件可用的有界来源查询**：在插件上下文提供带宿主认证的消息分页、单条 Message/Part 原始读取与 Session 活动状态接口（或明确承诺可通过注入的认证客户端调用等价公开端点）。分页须有可靠 cursor/边界及有界查询；状态区分 busy、retry、idle/不存在，并能在消息读取后重新检查。验收：多页、压缩、并行写入、宿主读取失败、顺序重启与结果引用验证；失败不得被当作空闲或任务成功。
4. **原始工具 Part 的持久更新**：支持使用宿主验证的 `(sessionID,messageID,callID)` 更新同一工具 Part 的卡片元数据/输出，直到命令已结算且更新得到持久确认；包含大小界限与拒绝过期来源。验收：工具返回后台标识后，运行输出和终态仍在原卡片上；空输出、截断、丢失确认和 TUI 重启仍明确呈现，不因 UI 更新失败把命令重复执行。

这些是独立 Gate：取得某一项不代表其他项也已具备。若上游已有功能，请提供**固定版本的公开 API 签名和真实插件调用示例**，然后在隔离的无凭据环境中实测；不能因类型名相近跳过验收。插件生命周期/同步可重放 transform、配置与模型投影、CLI/TUI 迁移仍需另行实现和验证，不属于以上四个接口就绪的推论。

## 来源与边界

- `@opencode/plugin@2.0.15`: `dist/promise/tool.d.ts`、`permission.d.ts`、`session.d.ts`、`plugin.d.ts`
- `@opencode/schema@2.0.15`: `dist/tool.d.ts`、`session.d.ts`
- `@opencode/protocol@2.0.15`: `dist/groups/session.d.ts`、`message.d.ts`、`permission.d.ts`
- O4E V1 当前需求：`SPEC.md` 的 `DEL-003`、`BGT-005`、`BGT-011`、`CMD-004`、`CMD-008`、`RUN-003` 及 Inspection 分页要求。

未经单独授权，不修改 OpenCode 上游、不创建 issue/PR，不发布或迁移用户数据。
