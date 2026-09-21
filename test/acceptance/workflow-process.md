# process-v1 宿主验收清单（尚未执行）

这是 opt-in 验收说明，不是自动运行脚本或 PASS 记录。对应 [SPEC 的 WFL 条款](../../SPEC.md)及[当前协议](../../docs/reference/workflows.md)。现有 resume/closure 夹具验证 Agent Task inspect，workspace-cwd 夹具验证 Bash；两者都不能证明 Workflow 宿主验收。

## 无宿主执行的基线

在源码目录运行，测试数据由夹具创建在系统临时目录：

```bash
node --test test/workflow-definition.test.mjs test/workflow-process.test.mjs test/workflow-tool.test.mjs
node --test test/acceptance/*.test.mjs
npm test
```

第一组使用模拟 SDK/Session/Tool Part，覆盖新契约三步串行、Gate、来源校验、消息中断、持久化失败与 Runtime 重建。Runtime 对象重建不是 OpenCode 进程重启；删除模拟 Part 不是实际 compaction。第二组只检查现有 Task 夹具，不运行 Workflow 或 OpenCode。完整测试也不自动产生 host-validated/platform-validated 结论。

## 真正宿主运行前提

- 另行获准启动隔离 OpenCode、在新测试配置中加载 process-v1，以及所需模型调用。不得修改用户宿主配置、复用旧 Run/数据库、处理旧进程或释放不确定锁。
- 每次使用新的临时工作目录及隔离 HOME/XDG 数据；明确记录源码 HEAD、未提交 diff 标识、OpenCode、Node、插件/SDK、OS、Shell 和场景。不要记录密钥或完整环境。
- 本清单不提供已经验证的 Workflow host runner。应先准备并审查有超时、请求数限制、仅清理本次拥有资源的执行器；不能直接把 Task resume runner 当作 Workflow runner。
- 可使用无凭据本地 synthetic provider 验证真实宿主工具接线，但只能标记 controlled-host；它不证明模型遵循多回合指令。live 模型验收需独立成本授权。
- Task resume/closure runner 在依赖准备时解析 npm `latest`，并将当次实际 OpenCode/plugin/SDK 版本与 lock/hash 封存在隔离资产中；它不会长期固定历史版本。静态测试仍不能视为该实际版本的宿主 PASS，也不要求升级或降级活动宿主。

## 场景与可观察断言

使用仅含 `contract: process-v1`、`type: work` 的新定义。每个写操作必须由真实当前 assistant Tool Part 发起；保留其指向真实 user 消息的 parentID。不得直接写 metadata 制造通过。

| 场景 | 最小动作与必须保存的证据 |
| --- | --- |
| 多回合 self | catalog/start 后，逐步 begin/执行/report 三个依赖 Step；保存 runID、revision、attemptID、submissionID、decision、最终 output。runSessionID 等于 owner；Workflow 不创建子执行 Session 或派发模型。 |
| 用户改令 | 在 active Attempt 时发送真实新用户消息；旧边界推进被拒绝/中断；处理新指令后 read/resume 保留同一 Attempt，不重做工具。相同时间戳歧义须拒绝，不能用数组顺序猜测。 |
| 有限修复 | 提交缺字段或不满足 Gate 的报告；不自动执行下一步。使用最新 revision 显式 begin 修复；达到 maxRepairRounds 后不能用 resume 绕过。 |
| 响应丢失/重启 | 在本次新 Run 执行后、report 前停止测试宿主，再启动同一隔离数据目录；read 保留 active Attempt。对已经持久化但响应丢失的报告以相同 submissionID/payload 重试，只返回原决定，不重放工具。 |
| compaction | 使用宿主真实压缩入口，并记录压缩前后来源 Part 是否仍可验证。来源保留时 read/report 应按契约校验；来源丢失或无法验证时 fail closed，不接受摘要文字替代证据。不得预设压缩后必然可继续。 |
| command-success | 使用本次 owner 的短成功命令；保存实际 Bash/output Part、完整日志标志、owner 索引和规范结果引用。另用失败/截断/错误 owner 的引用确认拒绝。exit 0 不证明覆盖充分。 |
| task-created/result | 另行授权普通 task；创建 Step 仅证明创建，收集 Step 必须 watch 并实际读取 output，taskFrom 绑定同一 Task。错误 Task、伪造/失效/删除的来源或未读结果必须拒绝。 |
| pause/stop | 只停止 Workflow 推进；已有 Task/Command 不自动取消。测试拥有的任务按普通任务协议单独收敛；不得触碰其他任务。 |
| 权限和 UI | 手动观察真实授权提示、拒绝、Tool Card 中检查点/revision/决定的持续可见性、多回合及重启后 read。只读 API 或截图中的模型自述不是授权/UI 验收。无 owner Run 列表仍是已知缺口。 |

变更参数只有 begin/report/resume/pause/stop 要求 expectedRevision；start 不传。report 恰含 status/output/artifacts/evidence/diagnostics；evidence 仅为真实 `{kind,taskID,messageID,callID}` 引用，Artifact 仍只是声明。

## 平台矩阵与报告

Linux、Windows、macOS 分别记录上述场景，不能用 `process.platform` 分支或模拟路径补足真实平台。各平台还需依 SPEC 验证默认/显式 Host Shell、空格与非 ASCII 路径、编码、超时/取消、日志与恢复；仅 Workflow 测试不覆盖整个跨平台要求。现有 Task 夹具的 Linux `/proc`、subreaper、pidfd 依赖不是 Windows/macOS 支持证据，不应在缺少环境时反复重跑它们充数。

报告至少分开：源码/版本；实际命令；模拟回归；controlled-host；live-model；UI 人工观察；逐平台结果；阻塞与最小下一步。没有实际执行的项保持 unverified。只保存脱敏后的有界断言和引用，不提交原始宿主日志、数据库、凭据或 Prompt 全文。
