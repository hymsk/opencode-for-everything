# 任务概览

[中文](task-overview.cn.md) | [English](task-overview.md)

独立 O4E TUI 插件在侧栏 Todo 上方（`sidebar_content`，`order: 350`）按 Bash / 子 Agent 分组显示当前 Session **直接拥有**的任务。每组最多六项；没有记录时隐藏面板。

Bash、Subagents 各为一张分组卡片，任务在卡片内仅显示序号和状态，不再嵌套任务边框。点击分类标题或该卡片的 `View all` 直接打开对应分类每页 20 项的列表，无中间分类菜单；点击任务行直接进入 Bash 输出或子 Agent 状态详情。键盘用户可从命令面板直接打开 `O4E: View Bash tasks` 或 `O4E: View subagent tasks`。详情按当前同步记录重新投影，切换 owner 或记录失效后不再提供执行链接。只有与 Task、逻辑 owner、Agent 和派发身份匹配的子 Agent 执行 Session 才能主动打开；Bash 不提供该导航。没有取消、重试或授权按钮。

默认侧栏隐藏校验通过的 `completed`、`failed` 和 `cancelled`；Bash 的 `interrupted/not-submitted` 在确认未提交、无执行 claim 且已停止时也隐藏。`unknown`、子 Agent 的 `interrupted`、取消中及无法验证的记录仍保留。每组最多六行，格式为 `Bash(n)`／`Subagents(n)`、`#序号 · 状态`、`View all · (总数)`。标题数量不含隐藏项，底部总数包含隐藏项；不显示空态或隐藏数量提示。无引用且无异常的分类不显示。侧栏与完整列表均按编号从大到小排列，不再按状态排序；无可信编号的异常记录排在末尾。完整列表包含所有终态，每页 20 项，并展示阶段、Agent 名称、命令退出码等信息。

`View all` 打开的 Bash 完整列表采用左右两列：左侧为 `#n 命令前缀…`，右侧为固定的 `状态 · 阶段 · 退出码数字` 区域。同页各状态、阶段、退出码分别对齐，不随命令长短移动；状态信息不再放入会被宿主截断的标题。退出码不带 `exit` 标签；阶段与状态相同时不重复显示，缺失字段只保留列空间而不显示占位符。宽度预算优先保留编号和右侧信息，命令前缀按终端列宽、完整字素及宿主标题上限截断，余量不足 12 列时直接省略。窗口尺寸变化时重新计算；侧栏仍只显示编号与状态。搜索匹配左侧实际展示的编号与命令前缀。

前缀只来自当前 owner 已同步、与任务身份及完整命令 hash 一致的 Bash Part；尚未加载、压缩、隐藏、来源冲突或输入超过处理预算时省略，不为列表请求历史。只处理最多 65,536 个 UTF-16 代码单元的命令和最多 4,096 个代码单元的首行；换行后的内容不拼接到前缀。控制字符、双向控制字符以及明显的赋值、凭据关键词、URL、绝对路径形态会使整个前缀省略。此启发式检查并非完整脱敏，可能误报或漏报，不能保证共享屏幕安全。命令不会复制到任务账本或日志，列表搜索只使用实际显示的文本。

点击 Bash 行查看原始 Shell 卡片已捕获的输出：左右键切换相邻 Bash 任务，上下键按屏翻动当前输出，`r` 刷新，`b` 返回。内部每段最多 12,000 个 UTF-16 代码单元，不拆断代理对；上下翻屏可跨分段连续浏览。详情通过公开 SDK 只读取与当前 Task 绑定的一条原始消息，不调用模型或任务管理工具。捕获不完整、缺失或读取失败会明确提示；“输出”不保证恢复宿主未保存的内容。点击子 Agent 行查看状态、阶段、待处理权限／问题数量及经校验的执行 Session 入口。状态信息是普通文本，不再伪装成无动作菜单项。隐藏与查看均不表示接受结果或消费回执。

子 Agent 详情操作具有可见选中态：上下键选择、Enter 执行、鼠标点击，Tab / Shift+Tab 切换操作，无搜索框。Bash 无需 Tab 或分页菜单，PageUp/PageDown 与上下翻屏等价，到首尾不环绕。Esc 关闭，返回列表保留当前任务所在页和选择。短输出不撑满大面板，侧栏使用轻量左边线。完整任务列表使用左右键前后翻页，不再把“上一页／下一页”放在任务选项中；上下键选择任务，保留宿主搜索，到首尾不环绕。翻页键仅作用于打开的列表，关闭后释放；侧栏本身不抢占聊天输入焦点，纯键盘入口仍是命令面板。

Workflow 是默认关闭的实验性 Beta。仅在 `.o4e/config.jsonc` 显式设置 `"enableWorkflow": true` 并重建、重启后，显示独立的 `Workflows(n) · Beta` 轻量分组卡片及命令面板入口 `O4E: View Workflows (Beta)`。关闭时不读取 Workflow 检查点，不显示该区域或入口，也不取消普通 Task。

Workflow 侧栏最多六项，正常终态隐藏但保留 `View all · (总数)`；异常记录仍显示。行标识来自 Run ID 的短后缀，冲突时展开完整 ID，不是任务序号或创建顺序。完整列表每页 20 项，左右翻页、上下选择、Enter 查看详情、Esc 关闭；详情提供步骤分页、滚动和可见返回操作，返回保留列表页与选择，切换 owner 后关闭旧弹窗。只展示当前 owner 的白名单摘要，不读取输入、输出、报告或证据正文。它不重新验证 Gate evidence，也不恢复或推进 Run。模型可用 `o4e_workflow action:list` 在授权后发现当前 Agent 的 Run，再用 `read` 查询；UI 快照不是工具授权或执行依据。

这些卡片不替换聊天流中的工具卡片，也不受 `enable_o4e_task_detail` 控制：该开关仅控制 `o4e_task` 返回正文，人类单行显示与模型完整有界返回语义保持不变。

新 Bash 任务的规范账本保存在独立 O4E SQLite；owner Session metadata 只保留轻量展示摘要，不另建 Command Session，因此不会增加普通 Session 列表或空子 Agent 导航项。历史 Command Session 不自动删除或迁移。原生后台 Task 工具卡片的勾号表示启动调用已返回，不足以证明 Agent 已完成；OpenCode 1.18.31 对尚未派发的 queued Session 仍可能显示勾号，目前公开插件接口不能独立改变该判定。此限制不等于 O4E 将 queued 视为 completed。

Task 侧栏、列表与详情不再重复显示 `Read-only · recorded snapshots`、`recorded` 等提示；记录来源与只读边界仅在此说明。状态随宿主同步的 Session 元数据更新，不证明实时执行或结果验收。保留权限、问题、重试等待、失败、未知与中断等状态；缺失或无法验证的记录仍标为 unavailable。旧记录的 `running` 不证明进程仍运行，`completed` 不代表结果已读取或接受。通过原生任务卡及正常协议中获授权的 `o4e_task status/watch/output` 确认状态与结果。

owner 恢复副本在 canonical 提交后发布；外层操作退出 Task/transition 串行区后等待本操作的发布尝试，不等待兄弟任务执行结束。发布失败不回滚 canonical 结果或重放执行，而以 `owner-publication-failed` 诊断暴露；成功定向恢复后清除诊断（`ISSUE-TASK-OWNER-PUBLICATION`，有自动化回归覆盖，真实宿主存储故障尚未验收）。服务端发布不保证界面同帧刷新。Command 终态展示会检查 claim 与停止证据，无效 completed 记录标为异常而不是隐藏（`ISSUE-TUI-COMMAND-CLAIM`）。展示校验不替代 Runtime 完整账本校验；应以获授权的任务管理查询确认状态，不手工修改账本。

侧栏不调用模型、管理工具或 HTTP API，仅读取当前 owner 的同步引用及记录；不显示命令正文、描述、输出、日志路径、工作目录及原始错误。仅用户主动查看 Bash 输出时，通过宿主 SDK 读取绑定消息并核验调用身份，绝不恢复/派发任务、消费回执、回答交互、扫描全部 Session 或轮询消息历史。切换 Session 后不显示旧 owner 的输出，不汇总兄弟或其他 owner 的任务。

`install`、`build`、`import` 生成 `.opencode/tui/opencode-for-everything/index.tsx` 并在 `.opencode/tui.json[c]` 注册；全局安装使用相应全局配置目录。入口在 server 自动扫描的 `plugins/` 目录之外，npm 包提供分离的 `./server` 与 `./tui`。`--no-tui` 只关闭安装器交互界面，不关闭此侧栏。

注册保留 JSONC 注释、用户插件及选项、主题、快捷键和启用偏好，重建不会重复注册。TUI 启动时依据公开工作目录和与服务端共享的选择规则读取活动配置的 Beta 开关：显式 `o4e_config` 优先，否则项目 `.o4e/` 优先于全局；配置不可用或无效时关闭，不沿用其他配置根的构建开关。只读取选定配置文件，不读取凭据或其他配置内容用于展示，开关不热加载。卸载仅移除匹配的 O4E 注册与受管模块，保留用户 TUI 配置。安装/导入失败回滚包含 TUI 文件与注册。`status` 检查文件和注册存在性，**不证明宿主激活成功**。

可在宿主 Plugins 面板关闭 `opencode-for-everything.tasks`，或将 `plugin_enabled` 的对应项设为 `false`；宿主 KV 的显式选择可能覆盖配置。槽注册与插件停用清理由宿主管理。

实现按 OpenCode **1.18.31** 公开 TUI 文档和本地 SDK **1.18.21** 接口核对；自动化覆盖投影、构建、注册、卸载、回滚及 npm 清单。Linux 真实交互 TUI 已验证独立 TSX 加载及两种详情配置下 Bash 已完成记录的侧栏渲染。**子 Agent 分组与 Todo 同屏排序、动态切换、停用和 Windows/macOS 实机尚未视觉验收**，不宣称旧宿主兼容。

后续卡片版本在隔离 Linux TUI 中验证了 Bash 卡片、命令面板入口、任务列表／详情、非空 Workflow 检查点及步骤翻页、21 条 Bash 记录的跨页访问和 Agent 执行 Session 导航。真实宿主 CLI 的双 detail 模式使用本地 fake provider 验证 start/begin/list/pause 与结果等价性；不等于真实 report Gate、三类 evidence、compaction/restart 完整链路或远程模型验收。

本次终态过滤、纯编号排序及列表左右键翻页有自动化投影与按键层回归覆盖；尚未完成这次改动的真实交互 TUI 视觉验收，不能沿用上述旧版验收宣称已验证。

命令前缀版本另在 Linux / OpenCode 1.18.31 的隔离真实 TUI 验证：完整列表单行显示前缀、21 项左右翻页、前缀搜索及输出详情；72 列时显示前缀，动态缩到 52 列时省略，恢复宽度后重新显示。来源校验、敏感形态、省略预算和字素截断有自动化回归。未完成长命令及中文/emoji 截断的完整实机矩阵，也未验证 Windows/macOS；本地确定性服务生成真实宿主任务，不等于远程模型验收。

上述前缀实机检查对应命令位于状态之后的初版排列；后续调整为命令紧跟编号、退出码仅显示数字，已补充自动化回归，但该最终排列尚未单独重复真实 TUI 验收。

右侧独立状态列版本已在 Linux / OpenCode 1.18.31 的隔离 TUI 中，用当前组件和 21 条合成快照验证 52/72/100 列动态宽度、长短命令、缺失前缀、成功/失败/运行中状态、左右翻页和命令前缀搜索。该证据只覆盖真实宿主的布局与交互，不代表命令执行或生命周期验收；组合 emoji 在终端转储中的字形表现仍有限制，Windows/macOS 未验证。

另有 Linux / OpenCode 1.18.31 / 真实模型的单步 task-created/task-result → report Gate → read/list 完成验收。它是 CLI 证据，不替代 TUI 视觉、三类 evidence 完整矩阵或重启验收。

Workflow Beta 版本另以真实模型驱动的主 Agent 及 Reviewer/Architect 角色在 Linux / OpenCode 1.18.31 完成两步 quality-gate（task-created、task-result）和保留 active Attempt 的 pause/resume/pause；最终安装版本重启后验证 140 列侧栏、完成/暂停列表及步骤详情。默认关闭时普通 Bash 六项示例测试通过。全局/项目相反开关及安装后共享模块导入有自动化回归，但相反开关实机矩阵、21+ Workflow 跨页、owner 动态切换、三类 Gate 全矩阵及 Windows/macOS 未在本轮验证；窄屏转储有缩放残影，不作为干净截图证据。
