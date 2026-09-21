# 自动任务跟踪

[中文](automatic-follow.cn.md) | [English](automatic-follow.md)

主回合自然 idle 后，Runtime 可以为未完成 Task 创建 synthetic 文本回合继续协调，不伪造模型工具结果。真实用户插话优先。后台任务状态仍应通过 `watch/status` 确认，正文通过 `output` 读取；自动续接本身不是完成证据。

## 显式停止与恢复

仅受管 `primary`/`all` 根调用方可以管理自己的跟踪选择，操作仍经过宿主权限检查。先读取，再携带返回的 revision 修改：

```json
{"action":"follow"}
```

```json
{"action":"follow","enabled":false,"expectedRevision":1}
```

上述 revision 仅为示例。恢复时重新读取，将 `enabled` 改为 `true`。不提供 `taskID` 或 `taskIDs`；选择适用于当前 owner，不改变 Task 执行。普通用户消息不解除显式停止，选择在 Session metadata 中持久化。自然语言由主 Agent 理解并调用控制操作，Runtime 不猜测用户文本。

宿主根回合 abort 是临时抑制，下一真实用户回合解除；它与显式停止不同。已脱离 Bash 不因该临时抑制取消，但 `dispose`、owner 删除、子任务生命周期终止和显式 cancel 仍保留停止边界。

## 失败与恢复边界

- `automatic-follow-failed` 表示自动续接检查或提交失败后已停用。读取 `follow` 查看诊断，排查后在授权内显式恢复；不会自动重试模型或回答权限／问题请求。若元数据存储本身不可用，持久化可能失败，不应宣称控制已保存。
- 终态通知的检查接口连续失败三次后停止跟踪；busy、用户回合或 watch 等正常等待不计为失败，完整检查成功会清零检查失败计数。此计数独立于下面的终态提交额度。
- 失败停用若未能持久化，本实例仍停止自动检查；宿主读取恢复可用后，`follow` 返回 `enabled:false`、`diagnostic:"automatic-follow-failed"` 和 `persistenceConfirmed:false`。这不表示持久状态已经改为停用，也不保证重启后仍保留本地抑制；普通消息不解除该本地失败状态，须显式设置 follow。若 Session 本身仍无法读取，查询会报错，不伪造可用的 revision。
- 终态 receipt 的响应丢失或持久化确认允许复用同一消息身份进行最多三次有界提交；耗尽后停用并暴露诊断。旧尝试的迟到失败不能覆盖更晚的用户回合或显式控制 revision。
- 同目录实例的提交互斥及 actionable 去重仅为同进程保证，不是跨进程租约或 exactly-once。显式启停状态可由新实例读取；不能据此声称崩溃后提交去重、所有命令终态交付或完整生命周期已经真实宿主验收。
- 此功能的自动化夹具不等于真实宿主或 Windows/macOS 验收；发布前需分别记录目标环境证据。
