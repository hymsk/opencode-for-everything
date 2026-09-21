import assert from "node:assert/strict"
import test from "node:test"
import { isExplicitForegroundDelegation, normalizeAgentTaskArgs, normalizeTaskPermissionOverlay, normalizeTaskToolArgs } from "../src/adapters/opencode/plugin-hooks.ts"
import { normalizePermissionOverlayInput } from "../src/core/agent-routing.mjs"

test("cancel 对 Agent/Command 使用相同最小参数，reason 不再是输入字段", () => {
  for (const taskID of ["o4e_task_example", "o4e_command_example"]) {
    assert.deepEqual(normalizeTaskToolArgs({ action: "cancel", taskID: ` ${taskID} ` }), { action: "cancel", taskID })
    for (const extra of [{ reason: "stop" }, { reason: "" }, { reason: undefined }, { expectedRevision: 1 }, { taskIDs: [] }]) {
      assert.throws(() => normalizeTaskToolArgs({ action: "cancel", taskID, ...extra }), /O4E_TASK_INVALID_ARGUMENTS/)
    }
  }
  for (const taskID of [undefined, null, "", " ", 1]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "cancel", taskID }), /O4E_TASK_INVALID_ARGUMENTS/)
  }
  assert.throws(() => normalizeTaskToolArgs({ action: "resolve", taskID: "task", decision: "stop", expectedRevision: 1, reason: "stop" }), /reason is not supported/)
})

test("o4e_task input、resolve 和 pending reply 参数在 adapter 边界校验", () => {
  assert.deepEqual(normalizeTaskToolArgs({ action: "input", taskID: "task", input: "stdin", expectedRevision: 2 }), {
    action: "input",
    taskID: "task",
    input: "stdin",
    expectedRevision: 2,
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "resolve", taskID: "task", expectedRevision: 3, decision: "restart" }), {
    action: "resolve",
    taskID: "task",
    expectedRevision: 3,
    decision: "restart",
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "input", taskID: " task ", input: "stdin", expectedRevision: 2, delivery: "steer" }), {
    action: "input", taskID: "task", input: "stdin", expectedRevision: 2, delivery: "steer",
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "resume", taskID: " task ", expectedRevision: 2 }), {
    action: "resume", taskID: "task", expectedRevision: 2,
  })
  assert.throws(() => normalizeTaskToolArgs({ action: "input", taskID: "task", expectedRevision: 1 }), /非空 input/)
  assert.throws(() => normalizeTaskToolArgs({ action: "input", taskID: "task", input: "stdin" }), /expectedRevision/)
  assert.throws(() => normalizeTaskToolArgs({ action: "input", taskID: "task", input: "stdin", expectedRevision: 1, delivery: "invalid" }), /delivery 必须是 queue 或 steer/)
  assert.throws(() => normalizeTaskToolArgs({ action: "resolve", taskID: "task", decision: "continue" }), /expectedRevision/)
  assert.throws(() => normalizeTaskToolArgs({ action: "resolve", taskID: "task", expectedRevision: 1, decision: "approve" }), /continue、restart 或 stop/)
  assert.deepEqual(normalizeTaskToolArgs({
    action: "permission.reply",
    taskID: "task",
    requestID: "permission",
    expectedRevision: 4,
    reply: "once",
  }), {
    action: "permission.reply",
    taskID: "task",
    requestID: "permission",
    expectedRevision: 4,
    reply: "once",
  })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "question.reply",
    taskID: "task",
    requestID: "question",
    expectedRevision: 5,
    answers: [["Local"]],
  }), {
    action: "question.reply",
    taskID: "task",
    requestID: "question",
    expectedRevision: 5,
    answers: [["Local"]],
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "question.reply", answers: [["Local"]] }), {
    action: "question.reply",
    answers: [["Local"]],
  })
  assert.throws(() => normalizeTaskToolArgs({ action: "permission.reply", taskID: "task", requestID: "permission", expectedRevision: 1, reply: "allow" }), /once、always 或 reject/)
  assert.throws(() => normalizeTaskToolArgs({ action: "question.reply", taskID: "task", requestID: "question", expectedRevision: 1 }), /answers/)
  assert.throws(() => normalizeTaskToolArgs({ action: "question.reply", expectedRevision: 0, answers: [["Local"]] }), /expectedRevision/)
})

test("o4e_task watch 接受单个 taskID、保留显式 taskIDs 并拒绝混用", () => {
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", taskID: " task-one " }), {
    action: "watch",
    taskIDs: ["task-one"],
  })
  assert.throws(() => normalizeTaskToolArgs({ action: "watch", taskID: "task-one", taskIDs: ["task-two"] }), /不能同时提供/)
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch" }), { action: "watch" })
})

test("o4e_task watch 清理模型填充字段并只保留正数显式 timeout", () => {
  assert.deepEqual(normalizeTaskToolArgs({
    action: "watch",
    answers: [],
    decision: "continue",
    expectedRevision: 4,
    input: "",
    message: "",
    reply: "once",
    requestID: "",
    taskID: " task-one ",
    taskIDs: [],
    timeoutMs: 0,
  }), {
    action: "watch",
    taskIDs: ["task-one"],
  })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "watch",
    taskIDs: [" task-one ", "task-one", "task-two"],
    timeoutMs: 10_000,
  }), {
    action: "watch",
    taskIDs: ["task-one", "task-two"],
    timeoutMs: 10_000,
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", taskIDs: ["task-one", ""] }), {
    action: "watch",
    taskIDs: ["task-one"],
  })
})

test("o4e_task 先按 action 路由，模型填充的 follow 字段不污染读操作", () => {
  assert.deepEqual(normalizeTaskToolArgs({
    action: "watch",
    enabled: false,
    expectedRevision: 1,
    taskID: "",
    taskIDs: ["task-one"],
    decision: "continue",
    input: "",
    requestID: "",
    reply: "once",
    message: "",
    answers: [],
    timeoutMs: 0,
  }), {
    action: "watch",
    taskIDs: ["task-one"],
  })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "status",
    enabled: false,
    expectedRevision: 1,
    taskID: "task-one",
  }), {
    action: "status",
    taskID: "task-one",
  })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "follow",
    enabled: false,
    expectedRevision: 1,
  }), {
    action: "follow",
    enabled: false,
    expectedRevision: 1,
  })
  assert.throws(() => normalizeTaskToolArgs({
    action: "follow",
    enabled: false,
    expectedRevision: 1,
    taskID: "unexpected",
  }), /follow|O4E_FOLLOW|参数|arguments/i)
})

test("o4e_task 清理宿主注入的跨 action 默认值而保留显式 watch 空选择", () => {
  assert.deepEqual(normalizeTaskToolArgs({
    action: "status", taskID: "task-one", enabled: false, expectedRevision: 1,
    taskIDs: [], delivery: "queue", ioTimeoutMs: 10_000, timeoutMs: 0,
  }), { action: "status", taskID: "task-one" })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "output", taskID: "task-one", enabled: false, expectedRevision: 1,
    taskIDs: [], delivery: "queue", ioTimeoutMs: 10_000,
  }), { action: "output", taskID: "task-one" })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "watch", enabled: false, expectedRevision: 1,
    taskIDs: [], timeoutMs: 0,
  }), { action: "watch", taskIDs: [] })
  assert.deepEqual(normalizeTaskToolArgs({
    action: "watch", taskID: "task-one", enabled: false, expectedRevision: 1,
    taskIDs: [], delivery: "queue", ioTimeoutMs: 10_000, timeoutMs: 0,
  }), { action: "watch", taskIDs: ["task-one"], ioTimeoutMs: 10_000 })
})

test("o4e_task 容忍模型填充的全量垃圾字段（真实会话载荷回归）", () => {
  // 真实会话中某模型每次调用都给所有 advertised 可选字段填入编造值，
  // 包括 enabled:true 与随机 cursor（" ", "x", "not-used" 等）。
  const filledJunk = {
    answers: [],
    cursor: " ",
    decision: "continue",
    delivery: "queue",
    direction: "forward",
    enabled: true,
    expectedRevision: 1,
    input: "",
    ioTimeoutMs: 10_000,
    maxBytes: 1024,
    message: "",
    reply: "once",
    requestID: "",
    resume: false,
    timeoutMs: 0,
  }
  assert.deepEqual(normalizeTaskToolArgs({
    ...filledJunk, action: "output", taskID: "o4e_command_21a595f5657a4ec1ab0446242ae1f9f2", taskIDs: [],
  }), { action: "output", taskID: "o4e_command_21a595f5657a4ec1ab0446242ae1f9f2" })
  assert.deepEqual(normalizeTaskToolArgs({
    ...filledJunk, action: "watch", taskID: "", taskIDs: ["o4e_command_c4de463ccb9d4fa593865ff9484f3d7a"], timeoutMs: 30_000,
  }), { action: "watch", taskIDs: ["o4e_command_c4de463ccb9d4fa593865ff9484f3d7a"], timeoutMs: 30_000, ioTimeoutMs: 10_000 })
  assert.deepEqual(normalizeTaskToolArgs({
    ...filledJunk, action: "status", taskID: "o4e_command_c4de463ccb9d4fa593865ff9484f3d7a", taskIDs: ["x"],
  }), { action: "status", taskID: "o4e_command_c4de463ccb9d4fa593865ff9484f3d7a" })
  // 选择器真正冲突（taskID 与非空 taskIDs 指向不同任务）仍然拒绝。
  assert.throws(() => normalizeTaskToolArgs({
    ...filledJunk, action: "watch", taskID: "task-one", taskIDs: ["task-two"],
  }), /不能同时提供/)
  // follow 保持严格白名单：持久开关不接受无关字段。
  assert.throws(() => normalizeTaskToolArgs({
    ...filledJunk, action: "follow",
  }), /O4E_FOLLOW_INVALID_ARGUMENTS/)
})

test("受管 task 的 background:false 填充签名不强制前台委派", () => {
  assert.equal(isExplicitForegroundDelegation({ background: false }), true)
  assert.equal(isExplicitForegroundDelegation({
    background: false, plan: false, command: "", writeScopes: [], permissionOverlay: {},
  }), false)
  assert.equal(isExplicitForegroundDelegation({
    description: "d", prompt: "p", subagent_type: "tester",
    background: false, plan: false, command: "", writeScopes: [], permissionOverlay: {},
  }), false)
  assert.equal(isExplicitForegroundDelegation({ background: false, plan: false, writeScopes: ["src/"] }), true)
  assert.equal(isExplicitForegroundDelegation({ background: false, plan: false, permissionOverlay: { bash: "deny" } }), true)
  assert.equal(isExplicitForegroundDelegation({
    background: true, plan: false, command: "", writeScopes: [], permissionOverlay: {},
  }), false)
  assert.equal(isExplicitForegroundDelegation({}), false)
})

test("o4e_task inspect 归一化默认值并严格校验分页选项", () => {
  assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: " task " }), {
    action: "inspect", taskID: "task", direction: "forward", maxBytes: 1024,
  })
  for (const direction of ["forward", "backward"]) {
    for (const maxBytes of [4, 1024, 8192]) {
      const args = { action: "inspect", taskID: "task", cursor: "x".repeat(512), direction, maxBytes }
      assert.deepEqual(normalizeTaskToolArgs(args), args)
    }
  }
  for (const taskID of [undefined, null, "", " ", 1]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID }), /taskID/)
  }
  for (const cursor of [null, "", " "]) {
    assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: "task", cursor }), {
      action: "inspect", taskID: "task", direction: "forward", maxBytes: 1024,
    })
  }
  for (const cursor of ["x".repeat(513), 1, {}]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID: "task", cursor }), /cursor/)
  }
  for (const direction of [null, ""]) {
    assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: "task", direction }), {
      action: "inspect", taskID: "task", direction: "forward", maxBytes: 1024,
    })
  }
  for (const direction of ["older", 1]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID: "task", direction }), /direction/)
  }
  assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: "task", maxBytes: null }), {
    action: "inspect", taskID: "task", direction: "forward", maxBytes: 1024,
  })
  for (const maxBytes of [0, 3, 8193, 4.5, "1024", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID: "task", maxBytes }), /maxBytes/)
  }
})

test("o4e_task watch 接受状态选择并拒绝输出分页参数", () => {
  const cursors = { "task-one": "cursor-one", "task-two": "x".repeat(512) }
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", taskID: "task-one", timeoutMs: 3_600_000 }), {
    action: "watch", taskIDs: ["task-one"], timeoutMs: 3_600_000,
  })
  assert.throws(() => normalizeTaskToolArgs({ action: "watch", cursors: {} }), /cursors/)
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", resume: true }), { action: "watch" })
  for (const taskID of ["", "   ", null]) {
    assert.deepEqual(normalizeTaskToolArgs({ action: "watch", taskID }), { action: "watch" })
  }
  assert.throws(() => normalizeTaskToolArgs({ action: "watch", taskID: 1 }), /taskID/)
  for (const action of ["status", "output", "pending"]) {
    assert.deepEqual(normalizeTaskToolArgs({ action, taskIDs: ["task"] }), { action })
  }
  assert.throws(() => normalizeTaskToolArgs({ action: "cancel", taskIDs: ["task"] }), /O4E_TASK_INVALID_ARGUMENTS/)
  assert.throws(() => normalizeTaskToolArgs({ action: "input", taskIDs: ["task"] }), /taskID/)
  assert.throws(() => normalizeTaskToolArgs({ action: "resolve", taskIDs: ["task"] }), /taskID/)
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", timeoutMs: null }), { action: "watch" })
  for (const timeoutMs of [-1, 1.5, 3_600_001, "1000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "watch", timeoutMs }), /timeoutMs/)
  }
  for (const value of [null, [], "cursor", new Date(), { "": "cursor" }, { " task ": "cursor" }, { task: "" }, { task: " " }, { task: 1 }, { task: "x".repeat(513) }]) {
    assert.throws(() => normalizeTaskToolArgs({ action: "watch", cursors: value }), /cursors/)
  }
  // inspect 专属字段在其他 action 上一律丢弃，不再拒绝；缺失必需字段的
  // action 仍在对应字段上报错，cancel 保持最小参数契约。
  for (const action of ["watch", "status", "output", "input", "cancel", "resolve", "pending", "permission.reply", "question.reply", "question.reject"]) {
    for (const [key, value] of Object.entries({ cursor: "cursor", direction: "forward", maxBytes: 1024 })) {
      const junk = { action, taskID: "task", [key]: value }
      if (action === "cancel") assert.throws(() => normalizeTaskToolArgs(junk), /O4E_TASK_INVALID_ARGUMENTS/)
      else if (action === "watch") assert.deepEqual(normalizeTaskToolArgs(junk), { action, taskIDs: ["task"] })
      else if (["status", "output", "pending", "question.reject"].includes(action)) assert.deepEqual(normalizeTaskToolArgs(junk), { action, taskID: "task" })
      else if (action === "input") assert.throws(() => normalizeTaskToolArgs(junk), /input/)
      else if (action === "resolve") assert.throws(() => normalizeTaskToolArgs(junk), /expectedRevision/)
      else if (action === "permission.reply") assert.throws(() => normalizeTaskToolArgs(junk), /reply/)
      else assert.throws(() => normalizeTaskToolArgs(junk), /answers/)
    }
  }
  assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID: "task", cursors }), /cursors/)
})

test("受管 task 适配器只归一化已知 functions.* permissionOverlay 别名", () => {
  assert.deepEqual(normalizeTaskPermissionOverlay({
    "functions.apply_patch": "deny",
    "functions.bash": "deny",
    read: "ask",
  }), {
    edit: "deny",
    bash: "deny",
    read: "ask",
  })
  assert.deepEqual(normalizeTaskPermissionOverlay({
    "functions.write": "ask",
    "functions.apply_patch": "deny",
  }), { edit: "deny" })
  assert.deepEqual(normalizeTaskPermissionOverlay({
    "functions.write": "ask",
    edit: "deny",
  }), { edit: "deny" })
  assert.deepEqual(normalizeAgentTaskArgs({
    description: "inspect",
    prompt: "read files",
    subagent_type: "researcher",
    permissionOverlay: { "functions.apply_patch": "deny" },
  }).permissionOverlay, { edit: "deny" })
  const unknown = normalizeTaskPermissionOverlay({ "functions.execute": "deny" })
  assert.deepEqual(unknown, { "functions.execute": "deny" })
  assert.throws(() => normalizePermissionOverlayInput(unknown), /functions\.execute/)
})

test("inspect 续读与 watch 等待分别验证读取参数，I/O 预算不扩展到写动作", () => {
  assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: "task", resume: true, ioTimeoutMs: 1 }), {
    action: "inspect", taskID: "task", resume: true, ioTimeoutMs: 1, direction: "forward", maxBytes: 1024,
  })
  assert.equal(normalizeTaskToolArgs({ action: "watch", ioTimeoutMs: 60_000 }).ioTimeoutMs, 60_000)
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", resume: true }), { action: "watch" })
  assert.throws(() => normalizeTaskToolArgs({ action: "inspect", taskID: "task", resume: true, cursor: "cursor" }), /resume cannot/)
  for (const action of ["inspect", "watch"]) {
    for (const ioTimeoutMs of [0, 60_001, 1.5, "10"]) {
      assert.throws(() => normalizeTaskToolArgs({ action, taskID: "task", ioTimeoutMs }), /ioTimeoutMs/)
    }
  }
  assert.deepEqual(normalizeTaskToolArgs({ action: "inspect", taskID: "task", ioTimeoutMs: null }), {
    action: "inspect", taskID: "task", direction: "forward", maxBytes: 1024,
  })
  assert.deepEqual(normalizeTaskToolArgs({ action: "watch", taskID: "task", ioTimeoutMs: null }), {
    action: "watch", taskIDs: ["task"],
  })
  // 与 action 无关的可选字段按 action 丢弃，读操作不再因此拒绝；缺失必需
  // 字段的 action 仍在对应字段上报错，cancel 保持最小参数契约。
  for (const extra of [{ resume: false }, { ioTimeoutMs: 1 }]) {
    for (const action of ["status", "output", "pending", "question.reject"]) {
      assert.deepEqual(normalizeTaskToolArgs({ action, ...extra }), { action })
    }
    assert.throws(() => normalizeTaskToolArgs({ action: "cancel", ...extra }), /O4E_TASK_INVALID_ARGUMENTS/)
    assert.throws(() => normalizeTaskToolArgs({ action: "input", ...extra }), /taskID/)
    assert.throws(() => normalizeTaskToolArgs({ action: "resolve", ...extra }), /taskID/)
    assert.throws(() => normalizeTaskToolArgs({ action: "permission.reply", ...extra }), /reply/)
    assert.throws(() => normalizeTaskToolArgs({ action: "question.reply", ...extra }), /answers/)
  }
})

test("受管 task 的 plan:false 不排除 self Plan Agent", () => {
  const args = { description: "inspect", prompt: "inspect", subagent_type: "researcher" }
  assert.equal(normalizeAgentTaskArgs({ ...args, plan: true }).plan, true)
  assert.equal(normalizeAgentTaskArgs({ ...args, plan: false }).plan, undefined)
  assert.equal(normalizeAgentTaskArgs(args).plan, undefined)
})

test("受管 task 在 adapter 边界拒绝缺参和非法参数，不猜测目标或泄露输入", () => {
  const args = { description: "inspect", prompt: "private-prompt", subagent_type: "researcher" }
  for (const field of ["description", "prompt", "subagent_type"]) {
    for (const value of [undefined, null, "", 1, {}, []]) {
      assert.throws(() => normalizeAgentTaskArgs({ ...args, [field]: value }), (error) => {
        assert.match(error.message, /O4E_TASK_INVALID_ARGUMENTS/)
        assert.ok(error.message.includes(field))
        assert.ok(!error.message.includes("private-prompt"))
        return true
      })
    }
  }
  for (const value of [undefined, null, [], {}, { agent: "researcher", prompt: "private-prompt", description: "inspect" },
    { ...args, background: "false" }, { ...args, plan: "true" }, { ...args, writeScopes: "private-path" },
    { ...args, permissionOverlay: { "private-key": "allow" } }]) {
    assert.throws(() => normalizeAgentTaskArgs(value), (error) => {
      assert.match(error.message, /O4E_TASK_INVALID_ARGUMENTS/)
      assert.doesNotMatch(error.message, /private-(prompt|path|key)/)
      return true
    })
  }
})
