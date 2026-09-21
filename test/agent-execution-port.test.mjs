import assert from "node:assert/strict"
import test from "node:test"
import { createOpenCodeAgentExecutionPort } from "../src/adapters/opencode/agent-execution-port.mjs"

const noPendingRequests = { supported: true, requests: [] }

function client({ status = "idle", messages = [], request = async ({ url }) => ({ data: url.startsWith("/api/") ? { data: [] } : [] }) } = {}) {
  return {
    _client: { request },
    session: {
      status: async () => ({ data: { child: { type: status } } }),
      messages: async () => ({ data: messages }),
    },
  }
}

test("Agent execution port 向异步回合传递冻结模型和 dispatch messageID", async () => {
  const prompts = []
  const port = createOpenCodeAgentExecutionPort({
    client: { session: { promptAsync: async (request) => { prompts.push(request); return {} } } },
    directory: "/workspace",
  })

  await port.startTurn({
    sessionID: "child",
    messageID: "dispatch",
    agent: "worker",
    model: { providerID: "provider", modelID: "fallback", variant: "high" },
    tools: { task: false },
    parts: [{ type: "text", text: "task" }],
  })

  assert.deepEqual(prompts[0].body, {
    messageID: "dispatch",
    agent: "worker",
    model: { providerID: "provider", modelID: "fallback" },
    variant: "high",
    tools: { task: false },
    parts: [{ type: "text", text: "task" }],
  })
})

test("Agent execution port 向同步回合传递冻结模型和 dispatch messageID", async () => {
  const prompts = []
  const port = createOpenCodeAgentExecutionPort({
    client: { session: { prompt: async (request) => { prompts.push(request); return { data: { info: {}, parts: [] } } } } },
    directory: "/workspace",
  })

  await port.runTurn({
    sessionID: "child",
    messageID: "dispatch",
    agent: "worker",
    model: { providerID: "provider", modelID: "primary" },
    tools: { task: false },
    parts: [{ type: "text", text: "task" }],
  })

  assert.deepEqual(prompts[0].body, {
    messageID: "dispatch",
    agent: "worker",
    model: { providerID: "provider", modelID: "primary" },
    tools: { task: false },
    parts: [{ type: "text", text: "task" }],
  })
})

test("Agent execution port 将取消确认返回给同步委派 Runtime", async () => {
  const aborts = []
  const port = createOpenCodeAgentExecutionPort({
    client: { session: { abort: async (request) => { aborts.push(request); return { data: true } } } },
    directory: "/workspace",
  })

  assert.deepEqual(await port.cancelTurn({ sessionID: "child" }), { acknowledged: true })
  assert.deepEqual(aborts[0], { path: { id: "child" }, query: { directory: "/workspace" } })
})

test("Agent execution port 通过宿主 v2 prompt endpoint 请求 steer", async () => {
  const requests = []
  const port = createOpenCodeAgentExecutionPort({
    client: { _client: { request: async (request) => { requests.push(request); return { data: { id: "steer-1", sessionID: "child", admittedSeq: 1 } } } } },
    directory: "/workspace",
  })
  assert.deepEqual(await port.steerTurn({ sessionID: "child", messageID: "steer-1", text: "interrupt now" }), {
    supported: true,
    accepted: true,
    messageID: "steer-1",
  })
  assert.deepEqual(requests[0], {
    url: "/api/session/child/prompt",
    method: "POST",
    body: { id: "steer-1", prompt: { text: "interrupt now" }, delivery: "steer", resume: true },
    bodySerializer: JSON.stringify,
    headers: { "Content-Type": "application/json" },
  })
})

test("Agent execution port 在宿主拒绝 v2 steer endpoint 时传播错误", async () => {
  const port = createOpenCodeAgentExecutionPort({
    client: { _client: { request: async () => ({ response: { status: 404 }, error: "missing" }) } },
    directory: "/workspace",
  })
  await assert.rejects(port.steerTurn({ sessionID: "child", text: "interrupt now" }), /HTTP 404|missing/i)
})

test("Agent execution port 只在 Session idle 后报告完成消息", async () => {
  const messages = [{ info: { id: "assistant", role: "assistant", parentID: "dispatch", finish: "stop" }, parts: [{ type: "text", text: "done" }] }]
  const running = createOpenCodeAgentExecutionPort({ client: client({ status: "busy", messages }), directory: "/workspace" })
  const completed = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await running.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running", error: undefined, result: undefined })
  assert.deepEqual(await completed.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "idle", error: undefined, result: messages[0] })
})

test("Agent execution port 将 status 缺项与显式 idle 区分开", async () => {
  const host = client()
  host.session.status = async () => ({ data: {} })
  host.session.get = async () => ({ data: { id: "child" } })
  const port = createOpenCodeAgentExecutionPort({ client: host, directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "inactive",
  })
})

test("Agent execution port rechecks an omitted status after reads without treating malformed entries as inactive", async (t) => {
  for (const status of [undefined, null, {}, { type: "busy" }, { type: "retry" }]) await t.test(JSON.stringify(status) ?? "omitted", async () => {
    const host = client()
    host.session.get = async () => ({ data: { id: "child" } })
    let reads = 0
    host.session.status = async () => ({ data: ++reads === 1 || status === undefined ? {} : { child: status } })
    const port = createOpenCodeAgentExecutionPort({ client: host, directory: "/workspace" })
    assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
      pendingRequests: noPendingRequests,
      state: status === undefined ? "inactive" : status?.type === "busy" ? "running" : status?.type === "retry" ? "retrying" : "unknown",
    })
  })
})

test("Agent execution port reports idle without a result after a settled rejected tool turn", async () => {
  const messages = [{
    info: { id: "assistant", role: "assistant", parentID: "dispatch", finish: "tool-calls", time: { completed: 123 } },
    parts: [{ type: "tool", tool: "question", state: { status: "error", error: "rejected" } }],
  }]
  const host = client({ messages })
  let reads = 0
  host.session.status = async () => { reads += 1; return { data: { child: { type: "idle" } } } }
  const port = createOpenCodeAgentExecutionPort({ client: host, directory: "/workspace" })
  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "idle" })
  assert.equal(reads, 2)
  assert.equal(port.isCompletedAssistantMessage({ message: messages[0], dispatchMessageID: "dispatch" }), false)
})

test("Agent execution port rechecks activity after reading settled tool parts", async () => {
  for (const status of ["busy", "retry", "future-status"]) {
    const host = client({ messages: [{
      info: { role: "assistant", parentID: "dispatch", finish: "tool-calls", time: { completed: 123 } },
      parts: [{ type: "tool", state: { status: "completed" } }],
    }] })
    let reads = 0
    host.session.status = async () => ({ data: { child: { type: ++reads === 1 ? "idle" : status } } })
    const port = createOpenCodeAgentExecutionPort({ client: host, directory: "/workspace" })
    assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
      pendingRequests: noPendingRequests,
      state: status === "busy" ? "running" : status === "retry" ? "retrying" : "unknown",
    })
  }
})

test("Agent execution port retains incomplete tool turns even with a completed message timestamp", async () => {
  for (const status of ["pending", "running", undefined]) {
    const port = createOpenCodeAgentExecutionPort({ client: client({ messages: [{
      info: { role: "assistant", parentID: "dispatch", finish: "tool-calls", time: { completed: 123 } },
      parts: [{ type: "tool", state: { status } }],
    }] }), directory: "/workspace" })
    assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
  }
})

test("Agent execution port 对未知宿主 Session 状态 fail closed", async () => {
  const messages = [{ info: { id: "assistant", role: "assistant", parentID: "dispatch", finish: "stop" }, parts: [] }]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "future-status", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "unknown",
    error: undefined,
    result: undefined,
  })
})

test("Agent execution port 对畸形 parts fail closed 而不抛异常", async () => {
  const malformedUser = {
    info: { id: "dispatch", role: "user" },
    parts: {},
  }
  const malformedAssistant = {
    info: { id: "assistant", role: "assistant", parentID: "dispatch", finish: "stop" },
    parts: {},
  }
  const port = createOpenCodeAgentExecutionPort({
    client: client({ status: "idle", messages: [malformedUser, malformedAssistant] }),
    directory: "/workspace",
  })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "unknown",
  })
})

test("Agent execution port 不从未完成的 compaction summary 扩展 lineage", async () => {
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-final", role: "assistant", parentID: "compaction-continue", finish: "stop" }, parts: [] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
})

test("Agent execution port 不从缺少 ID 的 compaction continuation 扩展 lineage", async () => {
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", finish: "stop" }, parts: [] },
    { info: { role: "user" }, parts: [{ type: "text", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-final", role: "assistant", finish: "stop" }, parts: [] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
})

test("Agent execution port 将宿主 compaction continuation 的最终消息归因到原 dispatch", async () => {
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [{ type: "text", text: "summary" }] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-tools-2", role: "assistant", parentID: "compaction-continue", finish: "tool-calls" }, parts: [{ type: "tool", tool: "webfetch", state: { status: "completed" } }] },
    { info: { id: "compaction-user-2", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary-2", role: "assistant", parentID: "compaction-user-2", mode: "compaction", summary: true, finish: "stop" }, parts: [{ type: "text", text: "summary 2" }] },
    { info: { id: "compaction-continue-2", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-final", role: "assistant", parentID: "compaction-continue-2", finish: "stop" }, parts: [{ type: "text", text: "done" }] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "idle",
    error: undefined,
    result: messages.at(-1),
  })
  assert.equal(port.isCompletedAssistantMessage({ message: messages.at(-1), messages, dispatchMessageID: "dispatch" }), true)
})

test("Agent execution port 将 compaction continuation 的模型错误归因到原 dispatch", async () => {
  const error = { name: "UnknownError", data: { message: "failed after compaction" } }
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "assistant-error", role: "assistant", parentID: "compaction-continue", error }, parts: [] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "idle",
    error,
  })
})

test("Agent execution port 不接受缺少 synthetic 标记的 compaction continuation", async () => {
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", metadata: { compaction_continue: true } }] },
    { info: { id: "unrelated-final", role: "assistant", parentID: "compaction-continue", finish: "stop" }, parts: [{ type: "text", text: "must not complete dispatch" }] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
  assert.equal(port.isCompletedAssistantMessage({ message: messages.at(-1), messages, dispatchMessageID: "dispatch" }), false)
})

test("Agent execution port 遇到无关 Assistant 后不再扩展 compaction lineage", async () => {
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    { info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" }, parts: [{ type: "tool", tool: "read", state: { status: "completed" } }] },
    { info: { id: "foreign-assistant", role: "assistant", parentID: "other-user", finish: "stop" }, parts: [{ type: "text", text: "foreign" }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "unrelated-final", role: "assistant", parentID: "compaction-continue", finish: "stop" }, parts: [{ type: "text", text: "must not complete dispatch" }] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
  assert.equal(port.isCompletedAssistantMessage({ message: messages.at(-1), messages, dispatchMessageID: "dispatch" }), false)
})

test("Agent execution port 不让完成结果后的 compaction continuation 覆盖原结果", async () => {
  const original = { info: { id: "assistant-original", role: "assistant", parentID: "dispatch", finish: "stop" }, parts: [{ type: "text", text: "original" }] }
  const messages = [
    { info: { id: "dispatch", role: "user" }, parts: [{ type: "text", text: "task", synthetic: true }] },
    original,
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } }] },
    { info: { id: "unrelated-final", role: "assistant", parentID: "compaction-continue", finish: "stop" }, parts: [{ type: "text", text: "must not replace original" }] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "idle",
    error: undefined,
    result: original,
  })
  assert.equal(port.isCompletedAssistantMessage({ message: messages.at(-1), messages, dispatchMessageID: "dispatch" }), false)
})

test("Agent execution port 不把 idle 窗口中的 tool-calls 消息当成完成结果", async () => {
  const messages = [{
    info: { id: "assistant-tools", role: "assistant", parentID: "dispatch", finish: "tool-calls" },
    parts: [{ type: "tool", tool: "webfetch", state: { status: "completed" } }],
  }]
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
})

test("Agent execution port 不把缺失或 unknown finish 当成完成结果", async () => {
  const scaffold = {
    info: { id: "assistant-scaffold", role: "assistant", parentID: "dispatch" },
    parts: [{ id: "part-scaffold", type: "text", text: "partial" }],
  }
  const unknown = {
    info: { id: "assistant-unknown", role: "assistant", parentID: "dispatch", finish: "unknown" },
    parts: [{ id: "part-unknown", type: "text", text: "host terminal" }],
  }

  const scaffoldPort = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [scaffold] }), directory: "/workspace" })
  const unknownPort = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [unknown] }), directory: "/workspace" })

  assert.deepEqual(await scaffoldPort.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "idle" })
  assert.deepEqual(await unknownPort.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
})

test("Agent execution port 按宿主 ToolPart 规则判断最终消息", async () => {
  const hostTool = {
    info: { id: "assistant-host-tool", role: "assistant", parentID: "dispatch", finish: "stop" },
    parts: [{ id: "tool-host", type: "tool", tool: "read", state: { status: "completed" } }],
  }
  const providerTool = {
    info: { id: "assistant-provider-tool", role: "assistant", parentID: "dispatch", finish: "stop" },
    parts: [{ id: "tool-provider", type: "tool", tool: "read", metadata: { providerExecuted: true }, state: { status: "completed" } }],
  }
  const interruptedOrphan = {
    info: { id: "assistant-orphan", role: "assistant", parentID: "dispatch", finish: "stop" },
    parts: [{ id: "tool-orphan", type: "tool", tool: "read", state: { status: "error", metadata: { interrupted: true } } }],
  }

  const hostPort = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [hostTool] }), directory: "/workspace" })
  const providerPort = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [providerTool] }), directory: "/workspace" })
  const orphanPort = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [interruptedOrphan] }), directory: "/workspace" })

  assert.deepEqual(await hostPort.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), { pendingRequests: noPendingRequests, state: "running" })
  assert.deepEqual((await providerPort.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" })).result, providerTool)
  assert.deepEqual((await orphanPort.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" })).result, interruptedOrphan)
})

test("Agent execution port 只返回成功完成的 Assistant parentID", async () => {
  const messages = [
    { info: { id: "error", role: "assistant", parentID: "user-error", finish: "stop", error: { name: "APIError" } }, parts: [] },
    { info: { id: "partial", role: "assistant", parentID: "user-partial" }, parts: [] },
    { info: { id: "tools", role: "assistant", parentID: "user-tools", finish: "tool-calls" }, parts: [] },
    { info: { id: "host-tool", role: "assistant", parentID: "user-host-tool", finish: "stop" }, parts: [{ type: "tool", state: { status: "completed" } }] },
    { info: { id: "done", role: "assistant", parentID: "user-done", finish: "stop" }, parts: [] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ messages }), directory: "/workspace" })

  assert.deepEqual(await port.completedAssistantParentIDs({ sessionID: "child" }), ["user-done"])
  assert.equal(port.isCompletedAssistantMessage({ message: messages.at(-1), dispatchMessageID: "user-done" }), true)
  assert.equal(port.isCompletedAssistantMessage({ message: messages[3], dispatchMessageID: "user-host-tool" }), false)
})

test("Agent execution port 将 compaction continuation 的完成确认映射回原 user messageID", async () => {
  const messages = [
    { info: { id: "user-root", role: "user" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "compaction-user", role: "user" }, parts: [{ type: "compaction" }] },
    { info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", mode: "compaction", summary: true, finish: "stop" }, parts: [] },
    { info: { id: "compaction-continue", role: "user" }, parts: [{ type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "Continue" }] },
    { info: { id: "done", role: "assistant", parentID: "compaction-continue", finish: "stop" }, parts: [] },
  ]
  const port = createOpenCodeAgentExecutionPort({ client: client({ messages }), directory: "/workspace" })

  assert.deepEqual(await port.completedAssistantParentIDs({ sessionID: "child" }), ["user-root"])
})

test("Agent execution port 列举完成消息时不截断父 Session 历史", async () => {
  const queries = []
  const port = createOpenCodeAgentExecutionPort({
    client: {
      session: {
        messages: async (request) => {
          queries.push(request.query)
          return { data: [{ info: { id: "done", role: "assistant", parentID: "user-old", finish: "stop" }, parts: [] }] }
        },
      },
    },
    directory: "/workspace",
  })

  assert.deepEqual(await port.completedAssistantParentIDs({ sessionID: "child" }), ["user-old"])
  assert.deepEqual(queries, [{ directory: "/workspace" }])
})

test("Agent execution port 在部分结果存在时仍优先报告 Assistant error", async () => {
  const failed = {
    info: { id: "assistant-failed", role: "assistant", parentID: "dispatch", finish: "stop", error: { name: "APIError" } },
    parts: [
      { id: "part-partial", type: "text", text: "partial" },
      { id: "tool-partial", type: "tool", tool: "read", state: { status: "completed" } },
    ],
  }
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [failed] }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "idle",
    error: failed.info.error,
  })
})

test("Agent execution port 不会把较早的失败消息覆盖在最新结果之上", async () => {
  const failed = { info: { id: "failed", role: "assistant", parentID: "dispatch", error: { name: "UnknownError" } }, parts: [] }
  const completed = { info: { id: "completed", role: "assistant", parentID: "dispatch", finish: "stop" }, parts: [{ type: "text", text: "done" }] }
  const port = createOpenCodeAgentExecutionPort({ client: client({ status: "idle", messages: [failed, completed] }), directory: "/workspace" })

  assert.deepEqual(await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" }), {
    pendingRequests: noPendingRequests,
    state: "idle",
    error: undefined,
    result: completed,
  })
})

test("Agent execution port 合并当前两组 pending requests 并通过 SDK 回复", async () => {
  const calls = []
  const pendingPermission = {
    id: "permission-1",
    sessionID: "child",
    permission: "bash",
    patterns: ["git status"],
    always: [],
  }
  const pendingQuestion = {
    id: "question-1",
    sessionID: "child",
    questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }] }],
  }
  const port = createOpenCodeAgentExecutionPort({
    client: client({ request: async (options) => {
      calls.push(options)
      if (options.method === "POST") return { response: { status: 204 } }
      if (options.url === "/permission?directory=%2Fworkspace") return { data: [pendingPermission, { ...pendingPermission, id: "foreign", sessionID: "other" }] }
      if (options.url === "/question?directory=%2Fworkspace") return { data: [] }
      if (options.url === "/api/session/child/permission") return { data: { data: [] } }
      if (options.url === "/api/session/child/question") return { data: { data: [pendingQuestion] } }
      throw new Error(`Unexpected endpoint: ${options.url}`)
    } }),
    directory: "/workspace",
  })

  const listed = await port.listPendingRequests({ sessionID: "child" })
  assert.equal(listed.supported, true)
  assert.deepEqual(listed.requests.map((request) => [request.kind, request.requestID]), [
    ["permission", "permission-1"],
    ["question", "question-1"],
  ])
  assert.equal(listed.requests.some((request) => "transport" in request), false)
  await port.respondToPendingRequest({ kind: "permission", sessionID: "child", requestID: "permission-1", reply: "once" })
  await port.respondToPendingRequest({ kind: "question", sessionID: "child", requestID: "question-1", answers: [["Local"]] })
  await port.respondToPendingRequest({ kind: "question", sessionID: "child", requestID: "question-1", reject: true })
  const replies = calls.filter((call) => call.method === "POST")
  assert.deepEqual(replies.map((call) => call.url), [
    "/permission/permission-1/reply?directory=%2Fworkspace",
    "/api/session/child/question/question-1/reply",
    "/api/session/child/question/question-1/reject",
  ])
  assert.deepEqual(replies[0].body, { reply: "once" })
  assert.deepEqual(replies[1].body, { answers: [["Local"]] })
  assert.equal(replies[1].bodySerializer(replies[1].body), '{"answers":[["Local"]]}')
  assert.equal(replies[2].body, undefined)
  await assert.rejects(port.respondToPendingRequest({ kind: "permission", sessionID: "child", requestID: "missing", reply: "once" }), /不存在待处理的 permission request: missing/)
  assert.equal(calls.filter((call) => call.method === "POST").length, 3)
})

test("Agent execution port 不用另一组空列表掩盖 HTTP 失败或 404", async () => {
  for (const endpoint of ["/permission?directory=%2Fworkspace", "/api/session/child/permission"]) {
    for (const [status, error] of [[500, "permission failed"], [500, ""], [404, "not found"]]) {
      const port = createOpenCodeAgentExecutionPort({
        client: client({ request: async ({ url }) => url === endpoint
          ? { error, response: { status } }
          : { data: url.startsWith("/api/") ? { data: [] } : [] } }),
        directory: "/workspace",
      })
      const listed = await port.listPendingRequests({ sessionID: "child" })
      assert.equal(listed.supported, true)
      assert.deepEqual(listed.requests, [])
      assert.match(listed.error, new RegExp(`HTTP ${status}${error ? ` ${error}` : "$"}`))
    }
  }
})

test("Agent execution port inspectTurn 返回宿主 pending requests", async () => {
  const port = createOpenCodeAgentExecutionPort({
    client: client({ request: async ({ url }) => ({ data: url === "/api/session/child/question"
      ? { data: [{ id: "question-1", sessionID: "child", questions: [{ header: "Target", question: "Which target?", options: [] }] }] }
      : url.startsWith("/api/") ? { data: [] } : [] }) }),
    directory: "/workspace",
  })
  const inspected = await port.inspectTurn({ sessionID: "child", dispatchMessageID: "dispatch" })
  assert.equal(inspected.pendingRequests.supported, true)
  assert.equal(inspected.pendingRequests.requests[0].kind, "question")
  assert.equal(inspected.pendingRequests.requests[0].requestID, "question-1")
})
