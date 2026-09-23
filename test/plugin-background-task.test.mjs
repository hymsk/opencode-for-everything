import assert from "node:assert/strict"
import { modelTaskPart } from "../src/runtime/task-model-output.mjs"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { createSharedScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { copyInstalledDefaults, readConfigJson, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { createDirectoryLink, removeLink } from "./helpers/fs-link-fixture.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { OpenCodeForEverythingPlugin } = await import("../src/plugin.ts")

class HookClient {
  constructor() {
    this.sessions = new Map()
    this.messages = new Map()
    this.nextSession = 1
    this.failUpdateSessionID = undefined
    this.updateCalls = []
    this.abortCalls = []
    this.promptAsyncCalls = []
    this.promptCalls = []
    this.messageCalls = []
    this.session = {
      list: async ({ query } = {}) => ({
        data: [...this.sessions.values()].slice(0, query?.limit ?? this.sessions.size).map((session) => structuredClone(session)),
      }),
      get: async ({ path }) => ({ data: structuredClone(this.sessions.get(path.id)) }),
      create: async ({ body }) => ({ data: this.addSession({ id: `child-${this.nextSession++}`, directory: this.directory, ...body }) }),
      update: async ({ path, body }) => {
        this.updateCalls.push({ sessionID: path.id, body: structuredClone(body) })
        if (path.id === this.failUpdateSessionID) throw new Error("metadata unavailable")
        const updated = { ...this.sessions.get(path.id), ...structuredClone(body) }
        this.sessions.set(path.id, updated)
        return { data: structuredClone(updated) }
      },
      children: async ({ path }) => ({ data: [...this.sessions.values()].filter((session) => session.parentID === path.id) }),
      status: async () => ({ data: Object.fromEntries([...this.sessions].map(([sessionID, session]) => [sessionID, { type: session.status ?? "idle" }])) }),
      messages: async (args) => {
        this.messageCalls.push(args)
        const messages = this.messages.get(args.path.id) ?? []
        if (args.responseStyle !== "fields") return { data: structuredClone(messages) }
        const end = args.query.before === undefined ? messages.length : Number(args.query.before)
        const start = Math.max(0, end - args.query.limit)
        return {
          data: structuredClone(messages.slice(start, end)),
          response: { ok: true, headers: new Headers(start ? { "X-Next-Cursor": String(start) } : {}) },
        }
      },
      promptAsync: async ({ path, body }) => {
        this.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
        this.sessions.get(path.id).status = "busy"
        return { data: undefined }
      },
      prompt: async ({ path, body }) => {
        this.promptCalls.push({ sessionID: path.id, body: structuredClone(body) })
        return {
          data: {
            info: { id: `assistant-${this.promptCalls.length}`, role: "assistant", parentID: body.messageID, finish: "stop" },
            parts: [{ id: `part-${this.promptCalls.length}`, type: "text", text: "completed" }],
          },
        }
      },
      abort: async ({ path }) => {
        this.abortCalls.push(path.id)
        this.sessions.get(path.id).status = "idle"
        return { data: true }
      },
    }
  }

  addSession(session) {
    const value = { status: "idle", metadata: {}, ...structuredClone(session) }
    this.sessions.set(value.id, value)
    return structuredClone(value)
  }
}

function toolContext(target, metadataUpdates = [], { agent = "orchestrator", sessionID = "parent" } = {}) {
  return {
    sessionID,
    messageID: "parent-message",
    agent,
    directory: target,
    worktree: target,
    abort: new AbortController().signal,
    metadata: (value) => Effect.sync(() => metadataUpdates.push(structuredClone(value))),
    ask: async () => {},
  }
}

function taskResult(value) {
  if (typeof value === "string") return JSON.parse(value)
  return value.metadata.o4eResult
}

function modelOutput(value, action) {
  return modelTaskPart({ type: "tool", tool: "o4e_task", state: { ...value, status: "completed", input: { action } } }).state.output
}

async function executeTask(hooks, args, context) {
  return taskResult(await hooks.tool.task.execute(args, context))
}

test("缺少 subagent_type 不得发现唯一候选，且在 recovery、授权与创建前拒绝", async () => {
  for (const loadAgents of [["tester"], [], ["tester", "debugger"]]) {
    const target = mkdtempSync(join(tmpdir(), "o4e-task-required-"))
    let hooks
    try {
      copyInstalledDefaults(componentRoot, target)
      const path = join(target, ".o4e", "agents", "all", "orchestrator.jsonc")
      writeFileSync(path, readFileSync(path, "utf8").replace('"loadAgents": ["*"]', `"loadAgents": ${JSON.stringify(loadAgents)}`))
      const client = new HookClient()
      client.directory = target
      client.addSession({ id: "parent", directory: target, status: "busy" })
      let reads = 0
      const get = client.session.get
      client.session.get = async (args) => { reads++; return get(args) }
      hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
      const baseline = reads
      let asks = 0
      const context = { ...toolContext(target), ask: async () => { asks++ } }
      for (const subagent_type of [undefined, null, "", 1]) {
        for (const background of [undefined, false]) {
          await assert.rejects(executeTask(hooks, { description: "inspect", prompt: "inspect", subagent_type, background }, context),
            /O4E_TASK_INVALID_ARGUMENTS.*subagent_type/)
        }
      }
      assert.equal(reads, baseline)
      assert.equal(asks, 0)
      assert.equal(client.sessions.size, 1)
      assert.equal(client.promptCalls.length, 0)
      assert.equal(client.promptAsyncCalls.length, 0)
      assert.equal(client.updateCalls.length, 0)
      if (loadAgents.length) {
        const created = await executeTask(hooks, { description: "valid", prompt: "inspect", subagent_type: "tester" }, context)
        assert.equal(created.agent, "tester")
      }
    } finally {
      await hooks?.dispose()
      rmSync(target, { recursive: true, force: true })
    }
  }
})

async function bounded(operation, ms = 2000) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`test operation exceeded ${ms} ms`)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntil(predicate) {
  const deadline = performance.now() + 2000
  while (!predicate() && performance.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  assert.ok(predicate(), "fixture did not reach the expected state")
}

async function withTaskReadFixture(run, { detail = false } = {}) {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-read-"))
  let hooks
  try {
    copyInstalledDefaults(componentRoot, target)
    if (detail) {
      const configPath = join(target, ".o4e", "config.jsonc")
      writeFileSync(configPath, readFileSync(configPath, "utf8").replace('"enable_o4e_task_detail": false', '"enable_o4e_task_detail": true'))
    }
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await bounded(executeTask(hooks, {
      description: "read integration", prompt: "read integration", subagent_type: "researcher (plan)", writeScopes: [],
    }, toolContext(target)))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    const dispatchMessageID = client.promptAsyncCalls[0].body.messageID
    client.messages.set(created.sessionID, [{
      info: { id: dispatchMessageID, sessionID: created.sessionID, role: "user" }, parts: [],
    }])
    await run({ target, hooks, client, created, dispatchMessageID })
  } finally {
    try { await bounded(hooks?.dispose()) }
    finally { rmSync(target, { recursive: true, force: true }) }
  }
}

async function persistedTaskRead(hooks, client, args, context, status = "running") {
  const messages = client.messages.get(context.sessionID) ?? []
  client.messages.set(context.sessionID, messages)
  let message = messages.find((entry) => entry.info.id === context.messageID)
  if (!message) {
    message = { info: { id: context.messageID, sessionID: context.sessionID, role: "assistant" }, parts: [] }
    messages.push(message)
  }
  // Model the host's current Part before execution, then persist the real tool response.
  const part = {
    id: `part-${context.callID}`, sessionID: context.sessionID, messageID: context.messageID,
    type: "tool", tool: "o4e_task", callID: context.callID, state: { status, input: structuredClone(args) },
  }
  message.parts.push(part)
  try {
    await hooks["tool.execute.before"]({ tool: "o4e_task", sessionID: context.sessionID, callID: context.callID }, { args })
    const result = await hooks.tool.o4e_task.execute(args, context)
    const output = typeof result === "string" ? result : result.output
    part.state = { status: "completed", input: structuredClone(args), output,
      ...(typeof result === "string" ? {} : { title: result.title, metadata: structuredClone(result.metadata) }) }
    return taskResult(result)
  } catch (error) {
    part.state = { status: "error", input: structuredClone(args), error: error.message }
    throw error
  }
}

test("persisted watch text exposes a waiting revision once and the next call waits for a new event", { timeout: 10_000 }, async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    await hooks.event({ event: { type: "question.asked", properties: { info: {
      id: "watch-question-1", sessionID: created.sessionID, questions: [],
    } } } })
    const args = { action: "watch", taskID: created.taskID, timeoutMs: 10 }
    const context = { ...toolContext(target), messageID: "watch-delivery", callID: "watch-first" }
    const first = await persistedTaskRead(hooks, client, args, context)
    assert.equal(first.reason, "actionable")
    assert.equal(first.tasks[0].status, "waiting_question")
    const part = client.messages.get("parent").find((message) => message.info.id === context.messageID).parts[0]
    assert.ok(modelTaskPart(part).state.output.includes(`Task 1 ${created.taskID} · waiting_question · question-waiting\nExpected revision: ${first.tasks[0].revision}`))
    const unchanged = await persistedTaskRead(hooks, client, args, { ...context, callID: "watch-again" })
    assert.equal(unchanged.reason, "heartbeat")
    assert.equal(unchanged.tasks[0].revision, first.tasks[0].revision)

    await hooks.event({ event: { type: "question.asked", properties: { info: {
      id: "watch-question-2", sessionID: created.sessionID, questions: [],
    } } } })
    const changed = await persistedTaskRead(hooks, client, args, { ...context, callID: "watch-new-request" })
    assert.equal(changed.reason, "actionable")
    assert.equal(changed.tasks[0].status, "waiting_question")
    assert.ok(changed.tasks[0].revision > first.tasks[0].revision)
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === created.sessionID).length, 1)
  })
})

test("watch accepts host-populated follow placeholders through the real plugin entry", { timeout: 10_000 }, async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    const args = {
      action: "watch", taskID: created.taskID,
      enabled: false, expectedRevision: 1,
      answers: [], cursor: "unused", decision: "continue", delivery: "queue",
      input: "", ioTimeoutMs: 1_000, maxBytes: 1_024, message: "", reply: "once",
      requestID: "", resume: false, timeoutMs: 1,
    }
    const result = await persistedTaskRead(hooks, client, args, {
      ...toolContext(target), messageID: "watch-populated", callID: "watch-populated-call",
    })
    assert.ok(["empty", "heartbeat", "actionable"].includes(result.reason))
    assert.equal(result.tasks[0].taskID, created.taskID)
  })
})

test("default watch freezes membership before a slow permission approval", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    let later
    const context = toolContext(target)
    const watched = taskResult(await hooks.tool.o4e_task.execute({ action: "watch", timeoutMs: 1 }, {
      ...context,
      ask: async (request) => {
        if (!later) later = await executeTask(hooks, {
          description: "created during approval", prompt: "independent work", subagent_type: "researcher (plan)", writeScopes: [],
        }, { ...toolContext(target), callID: "later-task" })
        return context.ask(request)
      },
    }))
    assert.ok(later.taskID)
    assert.deepEqual(watched.tasks.map((task) => task.taskID), [created.taskID])
    assert.ok(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[later.taskID])
  })
})

test("default watch monitors Agent and Bash together, deduplicates command states, and leaves content for output", { timeout: 10_000 }, async (t) => {
  const target = mkdtempSync(join(tmpdir(), "o4e-mixed-watch-"))
  let hooks
  t.after(async () => { await hooks?.dispose(); rmSync(target, { recursive: true, force: true }) })
  copyInstalledDefaults(componentRoot, target)
  const client = new HookClient()
  client.directory = target
  client.addSession({ id: "parent", directory: target, status: "busy" })
  hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target,
    commandWaitOptions: { runningTimeoutMs: 20, timeoutMs: 10 } })
  const agent = await executeTask(hooks, {
    description: "independent reader", prompt: "wait for the fixture", subagent_type: "researcher (plan)", writeScopes: [],
  }, toolContext(target))
  await waitUntil(() => client.sessions.get(agent.sessionID).metadata.o4e.task.status === "running")
  const bash = await hooks.tool.bash.execute({ command: "printf EARLY; sleep 0.2; printf LATE", description: "mixed command", timeout: 2000 }, {
    ...toolContext(target), messageID: "mixed-command", callID: "mixed-command",
  })
  const commandID = bash.metadata.o4eResult.taskID
  // 并行套件负载下进程准入可能超过 10ms 排队窗口；queued 是 CMD-006 的合法初返，
  // 本用例的契约在后续 watch 终态断言，不在同步返回快照的瞬时相位。
  assert.ok(["queued", "running"].includes(bash.metadata.o4eResult.status), "command must be tracked immediately")
  assert.doesNotMatch(bash.output, /EARLY|LATE/)
  const first = await persistedTaskRead(hooks, client, { action: "watch", timeoutMs: 2000 }, {
    ...toolContext(target), messageID: "mixed-watch", callID: "first",
  })
  assert.equal(first.reason, "actionable")
  assert.equal(first.tasks.find((task) => task.taskID === commandID).status, "completed")
  assert.equal(first.tasks.find((task) => task.taskID === agent.taskID).status, "running")
  assert.ok(first.tasks.every((task) => task.output === undefined && task.tail === undefined))
  const content = await hooks.tool.o4e_task.execute({ action: "output", taskID: commandID }, toolContext(target))
  assert.equal(modelOutput(content, "output"), "EARLYLATE")
  const second = await persistedTaskRead(hooks, client, { action: "watch", timeoutMs: 10 }, {
    ...toolContext(target), messageID: "mixed-watch", callID: "second",
  })
  assert.equal(second.reason, "heartbeat", "the same command terminal state must not wake watch twice")
  const controller = new AbortController()
  const pending = persistedTaskRead(hooks, client, { action: "watch", taskIDs: [agent.taskID, commandID], timeoutMs: 2000 }, {
    ...toolContext(target), messageID: "mixed-watch", callID: "aborted", abort: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error("mixed-reader-only"))
  await assert.rejects(pending, /mixed-reader-only/)
  assert.equal(client.sessions.get(agent.sessionID).metadata.o4e.task.status, "running")
  assert.deepEqual(client.abortCalls, [])
})

function setAgentConcurrency(target, value) {
  const path = join(target, ".o4e", "config.jsonc")
  const source = readFileSync(path, "utf8")
  const updated = source.replace(/"maxConcurrentAgents":\s*4/, `"maxConcurrentAgents": ${value}`)
  assert.notEqual(updated, source)
  writeFileSync(path, updated)
}

function setOrchestratorPermission(target, toolName, action) {
  const path = join(target, ".o4e", "agents", "all", "orchestrator.jsonc")
  const source = readFileSync(path, "utf8")
  const marker = '  "capabilities": ["workflow.coordinate", "implementation.change"]'
  const updated = source.replace(marker, `  "permission": { "${toolName}": "${action}" },\n${marker}`)
  assert.notEqual(updated, source)
  writeFileSync(path, updated)
}

async function seedQueuedBackgroundTask(client, target, { dispose = true } = {}) {
  setAgentConcurrency(target, 1)
  const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
  const first = await executeTask(hooks, {
    description: "occupy slot",
    prompt: "occupy slot",
    subagent_type: "general",
    writeScopes: [],
  }, toolContext(target))
  while (client.promptAsyncCalls.length === 0) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  const queued = await executeTask(hooks, {
    description: "remain queued",
    prompt: "remain queued",
    subagent_type: "general",
    writeScopes: [],
  }, toolContext(target))
  assert.equal(client.promptAsyncCalls.length, 1)
  // Disposing the only facade is now the last-facade shutdown and cancels the
  // running first task. Callers that need it to stay running must pass
  // dispose: false and dispose the returned hooks after a successor exists.
  if (dispose) await hooks.dispose()
  return { first, queued, hooks }
}

test("同目录插件实例共享 Agent admission 和 Scope Lock", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-shared-background-coordination-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setAgentConcurrency(target, 1)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const first = await executeTask(firstHooks, {
      description: "first write",
      prompt: "first write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    while (client.promptAsyncCalls.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const second = await executeTask(secondHooks, {
      description: "second write",
      prompt: "second write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    assert.equal(client.promptAsyncCalls.length, 1)

    const firstDispatch = client.promptAsyncCalls[0].body.messageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-shared-first", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-shared-first", type: "text", text: "completed" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    while (client.promptAsyncCalls.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls[1].sessionID, second.sessionID)

    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("目录词法别名和符号链接的插件实例共享 Background coordination", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-directory-key-alias-"))
  const alias = `${target}-alias`
  try {
    copyInstalledDefaults(componentRoot, target)
    createDirectoryLink(target, alias)
    setAgentConcurrency(target, 1)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: `${target}/.`, worktree: target })
    const thirdHooks = await OpenCodeForEverythingPlugin({ client, directory: alias, worktree: target })

    const first = await executeTask(firstHooks, {
      description: "first aliased write",
      prompt: "first aliased write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    while (client.promptAsyncCalls.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const queued = await executeTask(thirdHooks, {
      description: "queued symlink write",
      prompt: "queued symlink write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(secondHooks !== firstHooks, true)

    const firstDispatch = client.promptAsyncCalls[0].body.messageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-directory-key-first", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-directory-key-first", type: "text", text: "completed" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    const deadline = Date.now() + 2000
    while (client.promptAsyncCalls.length < 2 && Date.now() < deadline) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 2, JSON.stringify({
      active: client.sessions.get(first.sessionID)?.metadata?.o4e,
      queued: client.sessions.get(queued.sessionID)?.metadata?.o4e,
    }))
    assert.equal(client.promptAsyncCalls[1].sessionID, queued.sessionID)

    await firstHooks.dispose()
    await secondHooks.dispose()
    await thirdHooks.dispose()
  } finally {
    removeLink(alias)
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 将 active Task 协调权托管给同目录存活实例", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-shared-background-handoff-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setAgentConcurrency(target, 1)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const first = await executeTask(firstHooks, {
      description: "active write",
      prompt: "active write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    while (client.promptAsyncCalls.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const second = await executeTask(secondHooks, {
      description: "queued write",
      prompt: "queued write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    assert.equal(client.promptAsyncCalls.length, 1)

    await firstHooks.dispose()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    assert.equal(client.promptAsyncCalls.length, 1)

    const firstDispatch = client.promptAsyncCalls[0].body.messageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-handoff-first", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-handoff-first", type: "text", text: "completed" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    while (client.promptAsyncCalls.length < 2) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls[1].sessionID, second.sessionID)

    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 将自身 queued Task 一并托管给同目录存活实例", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-shared-background-queued-handoff-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setAgentConcurrency(target, 1)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const first = await executeTask(firstHooks, {
      description: "active write",
      prompt: "active write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    while (client.promptAsyncCalls.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const queued = await executeTask(firstHooks, {
      description: "queued write",
      prompt: "queued write",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    assert.equal(client.promptAsyncCalls.length, 1)

    await firstHooks.dispose()
    const firstDispatch = client.promptAsyncCalls[0].body.messageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-queued-handoff-first", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-queued-handoff-first", type: "text", text: "completed" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    const observed = await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    const deadline = Date.now() + 2000
    while (client.promptAsyncCalls.length < 2 && Date.now() < deadline) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 2, JSON.stringify({
      observed,
      active: client.sessions.get(first.sessionID)?.metadata?.o4e,
      queued: client.sessions.get(queued.sessionID)?.metadata?.o4e,
    }))
    assert.equal(client.promptAsyncCalls[1].sessionID, queued.sessionID)

    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 将等待 Scope Lock 的 active Task 托管给同目录存活实例", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-shared-background-lock-waiter-handoff-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setAgentConcurrency(target, 2)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const blockerHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const blocker = await executeTask(blockerHooks, {
      description: "block scope",
      prompt: "block scope",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    while (client.promptAsyncCalls.length < 1) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const waiting = await executeTask(firstHooks, {
      description: "wait for scope",
      prompt: "wait for scope",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    assert.equal(client.promptAsyncCalls.length, 1)

    await firstHooks.dispose()
    const blockerDispatch = client.promptAsyncCalls[0].body.messageID
    client.messages.set(blocker.sessionID, [{
      info: { id: "assistant-lock-waiter-blocker", role: "assistant", parentID: blockerDispatch, finish: "stop" },
      parts: [{ id: "part-lock-waiter-blocker", type: "text", text: "completed" }],
    }])
    client.sessions.get(blocker.sessionID).status = "idle"
    await blockerHooks.event({ event: { type: "session.idle", properties: { sessionID: blocker.sessionID } } })
    const deadline = Date.now() + 2000
    while (client.promptAsyncCalls.length < 2 && Date.now() < deadline) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, waiting.sessionID)

    await blockerHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("最后一个插件 facade dispose 取消已运行 Agent，取消接口失败时保留 Scope Lock", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-last-facade-agent-dispose-"))
  let creatorHooks
  let peerHooks
  let locks
  let client
  let originalAbort
  try {
    copyInstalledDefaults(componentRoot, target)
    client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    creatorHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    peerHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    locks = createSharedScopeLockManager(target)

    const created = await executeTask(creatorHooks, {
      description: "last facade active write",
      prompt: "remain active until plugin disposal",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    await waitUntil(() => client.promptAsyncCalls.some((call) => call.sessionID === created.sessionID)
      && client.sessions.get(created.sessionID)?.metadata?.o4e?.task?.status === "running")
    assert.equal(locks.has(`background-task:${created.taskID}`), true)
    locks.clear()
    locks = undefined

    await peerHooks.dispose()
    assert.equal(client.abortCalls.length, 0, "disposing a peer facade must preserve normal shared-runtime handoff")
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")

    const cancelError = new Error("fixture host Agent cancellation unavailable")
    originalAbort = client.session.abort
    client.session.abort = async ({ path }) => {
      client.abortCalls.push(path.id)
      throw cancelError
    }
    const [outcome] = await Promise.allSettled([bounded(creatorHooks.dispose())])
    locks = createSharedScopeLockManager(target)
    assert.deepEqual({
      outcome: outcome.status,
      abortCalls: client.abortCalls.filter((sessionID) => sessionID === created.sessionID).length,
      lockHeld: locks.has(`background-task:${created.taskID}`),
    }, {
      outcome: "rejected",
      abortCalls: 1,
      lockHeld: true,
    })
    assert.match(outcome.reason.message, /fixture host Agent cancellation unavailable/)

    client.session.abort = originalAbort
    await creatorHooks.dispose()
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "cancelled")
    assert.equal(locks.has(`background-task:${created.taskID}`), false)
  } finally {
    if (originalAbort && client) client.session.abort = originalAbort
    locks?.clear()
    try { await peerHooks?.dispose() } catch {}
    try { await creatorHooks?.dispose() } catch {}
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件初始化和当前 Session 后台委派都不依赖项目级 Session 枚举", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-background-task-bootstrap-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const originalList = client.session.list
    let blocked = false
    let releaseList
    client.session.list = (request) => {
      if (blocked) return originalList(request)
      blocked = true
      return new Promise((resolvePromise) => {
      releaseList = () => resolvePromise({ data: [...client.sessions.values()].map((session) => structuredClone(session)) })
      })
    }

    const hooksPromise = OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const initialized = await Promise.race([
      hooksPromise.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 50)),
    ])
    assert.equal(initialized, true)
    const hooks = await hooksPromise

    const delegation = executeTask(hooks, {
      description: "read fixture",
      prompt: "read fixture",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    const created = await delegation
    assert.equal(created.status, "queued")

    assert.equal(blocked, false)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件启动不会恢复其他 Session 的 queued Task，删除事件只处理已激活 Session", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-recovery-event-order-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const { queued } = await seedQueuedBackgroundTask(client, target)
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const deleted = hooks.event({ event: { type: "session.deleted", properties: { info: { id: "parent" } } } })
    await deleted

    const record = client.sessions.get(queued.sessionID).metadata.o4e.task
    assert.equal(record.status, "queued")
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(client.abortCalls.includes(queued.sessionID), false)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("未激活旧子 Session 的 permission 和 question 事件不会恢复或派发旧 Task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-recovery-event-retry-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const { queued } = await seedQueuedBackgroundTask(client, target)
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks.event({ event: { type: "permission.asked", properties: { info: { id: "permission-1", sessionID: queued.sessionID, permission: "bash", patterns: ["*"] } } } })
    await hooks.event({ event: { type: "question.asked", properties: { info: { id: "question-1", sessionID: queued.sessionID, questions: [] } } } })
    assert.equal(client.sessions.get(queued.sessionID).metadata.o4e.task.status, "queued")
    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("新 Runtime 创建后台 Task 不会隐式激活旧 queued Task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-session-scoped-new-task-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const { first, queued } = await seedQueuedBackgroundTask(client, target)
    client.sessions.delete(first.sessionID)
    delete client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[first.taskID]
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const created = await executeTask(hooks,
      { description: "new task after reload", prompt: "new task after reload", subagent_type: "general", writeScopes: [] },
      toolContext(target),
    )
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }

    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, created.sessionID)
    assert.notEqual(client.promptAsyncCalls[1].sessionID, queued.sessionID)
    assert.equal(client.sessions.get(queued.sessionID).metadata.o4e.task.status, "queued")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("重新激活已关闭的父 Session 会定向派发旧 queued Task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-session-reactivation-dispatch-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const { first, queued } = await seedQueuedBackgroundTask(client, target)
    client.sessions.delete(first.sessionID)
    delete client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[first.taskID]
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const output = {
      message: { id: "user-after-reload", role: "user" },
      parts: [{ id: "part-after-reload", type: "text", text: "new instruction" }],
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, queued.sessionID)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("重新激活父 Session 后 active Task 终态会补位旧 queued Task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-session-reactivation-slot-release-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const { first, queued, hooks: seedHooks } = await seedQueuedBackgroundTask(client, target, { dispose: false })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    // A peer facade now owns coordination; disposing the seeding facade hands
    // the running first task over instead of cancelling it.
    await seedHooks.dispose()

    const output = {
      message: { id: "user-after-reopen", role: "user" },
      parts: [{ id: "part-after-reopen", type: "text", text: "resume this session" }],
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(client.sessions.get(queued.sessionID).metadata.o4e.task.status, "queued")

    const dispatchMessageID = client.promptAsyncCalls[0].body.messageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-recovered-first", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-recovered-first", type: "text", text: "first complete" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }

    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, queued.sessionID)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件成功 dispose 前处理 flush 期间已接收的事件", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-event-drain-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    let releaseTurn
    let turnStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      turnStarted = true
      await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      client.sessions.get(path.id).status = "busy"
      return { data: undefined }
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "blocked",
      prompt: "blocked",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    const disposal = hooks.dispose()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "parent" } } } })
    assert.notEqual(client.sessions.get(created.sessionID).metadata.o4e.task.status, "cancelled")
    releaseTurn()
    await disposal

    const record = client.sessions.get(created.sessionID).metadata.o4e.task
    assert.equal(record.status, "cancelled")
    assert.equal(record.diagnostics.some((diagnostic) => diagnostic.code === "owner-session-deleted"), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("当前 Session 恢复失败后允许下一次入口重试和 dispose", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-recovery-retry-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const originalGet = client.session.get
    let getCalls = 0
    client.session.get = async (request) => {
      getCalls += 1
      if (getCalls === 1) throw new Error("session get temporarily unavailable")
      return originalGet(request)
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await assert.rejects(
      hooks.tool.o4e_task.execute({ action: "status", taskID: "missing-task" }, toolContext(target)),
      /temporarily unavailable/,
    )
    await assert.rejects(
      hooks.tool.o4e_task.execute({ action: "status", taskID: "missing-task" }, toolContext(target)),
      /O4E_TASK_MANAGEMENT_DENIED/,
    )
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 等待在途后台 dispatch 且拒绝恢复后同步委派", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-dispatch-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    let releaseTurn
    let turnStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      turnStarted = true
      await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      client.sessions.get(path.id).status = "busy"
      return { data: undefined }
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "read fixture",
      prompt: "read fixture",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    let disposed = false
    const disposal = hooks.dispose().then(() => { disposed = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(disposed, false)
    await assert.rejects(
      hooks.tool.task.execute({
        description: "late",
        prompt: "late",
        subagent_type: "general",
        background: false,
        writeScopes: [],
      }, toolContext(target)),
      /正在释放/,
    )
    await assert.rejects(
      hooks["tool.execute.before"](
        { sessionID: created.sessionID, tool: "edit", callID: "call-during-dispose" },
        { args: { filePath: "fixture.txt" } },
      ),
      /正在释放/,
    )
    releaseTurn()
    await disposal
    assert.equal(disposed, true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 在一个 flush 失败时仍等待另一个 flush，并恢复为可重试状态", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-partial-failure-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const generalPath = join(target, ".o4e", "agents", "subagent", "general.jsonc")
    writeFileSync(generalPath, readFileSync(generalPath, "utf8").replace('"loadTools": null', '"loadTools": ["read"]'))
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    let releaseBackground
    let backgroundStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      backgroundStarted = true
      await new Promise((resolvePromise) => { releaseBackground = resolvePromise })
      client.sessions.get(path.id).status = "busy"
      return { data: undefined }
    }
    const originalPrompt = client.session.prompt
    client.session.prompt = async ({ path, body }) => {
      client.promptCalls.push({ sessionID: path.id, body: structuredClone(body) })
      client.failUpdateSessionID = path.id
      return {
        data: {
          info: { id: "assistant-failed-persist", role: "assistant", parentID: body.messageID, finish: "stop" },
          parts: [{ id: "part-failed-persist", type: "text", text: "completed" }],
        },
      }
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const readOverlay = { bash: "deny", edit: "deny", external_directory: "deny" }

    const backgroundCreated = await executeTask(hooks, {
      description: "background read",
      prompt: "background read",
      subagent_type: "general",
      permissionOverlay: readOverlay,
      writeScopes: [],
    }, toolContext(target))
    while (!backgroundStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    await assert.rejects(hooks.tool.task.execute({
      description: "foreground read",
      prompt: "foreground read",
      subagent_type: "general",
      background: false,
      permissionOverlay: readOverlay,
      writeScopes: [],
    }, toolContext(target)), /result-persist-unconfirmed/)

    let disposalSettled = false
    const disposal = hooks.dispose().then(
      () => { disposalSettled = true },
      (error) => { disposalSettled = true; throw error },
    )
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(disposalSettled, false)

    await hooks.event({ event: { type: "question.asked", properties: { info: { id: "question-during-dispose", sessionID: backgroundCreated.sessionID, questions: [] } } } })
    assert.notEqual(client.sessions.get(backgroundCreated.sessionID).metadata.o4e.task.phase, "question-waiting")

    client.failUpdateSessionID = undefined
    client.session.prompt = originalPrompt
    releaseBackground()
    await assert.rejects(disposal, /metadata unavailable/)

    const backgroundStatus = taskResult(await hooks.tool.o4e_task.execute({ action: "status", taskID: backgroundCreated.taskID }, toolContext(target)))
    assert.equal(backgroundStatus.status, "waiting_question")
    assert.equal(backgroundStatus.phase, "question-waiting")

    const retried = await executeTask(hooks, {
      description: "read after failed dispose",
      prompt: "read after failed dispose",
      subagent_type: "general",
      background: false,
      permissionOverlay: readOverlay,
      writeScopes: [],
    }, toolContext(target))
    assert.equal(retried.status, "reported-completed")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("当前 Session 恢复后已开始 dispose 的同步委派不会创建子 Session", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-waiting-delegate-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const originalGet = client.session.get
    let releaseGet
    let getStarted = false
    client.session.get = (request) => {
      if (getStarted) return originalGet(request)
      getStarted = true
      return new Promise((resolvePromise) => {
        releaseGet = () => resolvePromise(originalGet(request))
      })
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const delegated = hooks.tool.task.execute({
      description: "late",
      prompt: "late",
      subagent_type: "general",
      background: false,
      writeScopes: [],
    }, toolContext(target))
    while (!getStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const disposal = hooks.dispose()
    releaseGet()
    await assert.rejects(delegated, /正在释放/)
    await disposal
    assert.equal([...client.sessions.values()].filter((session) => session.parentID === "parent").length, 0)
    assert.equal(client.promptCalls.length, 0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 中止等待权限 ask 的受管 task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-ask-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setOrchestratorPermission(target, "task", "ask")
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    let askStarted = false
    let releaseAsk
    const context = {
      ...toolContext(target),
      ask: async () => {
        askStarted = true
        await new Promise((resolvePromise) => { releaseAsk = resolvePromise })
      },
    }
    const delegated = hooks.tool.task.execute({
      description: "blocked permission",
      prompt: "must not start",
      subagent_type: "general",
    }, context)
    while (!askStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    await Promise.race([
      hooks.dispose(),
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("dispose deadlocked")), 100)),
    ])
    await assert.rejects(delegated, /正在释放/)
    assert.equal([...client.sessions.values()].some((session) => session.parentID === "parent"), false)
    releaseAsk()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptCalls.length, 0)
    assert.equal(client.promptAsyncCalls.length, 0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件 dispose 跨越受管 task metadata 发布时持久化取消且不派发", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-task-metadata-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    let metadataStarted = false
    let releaseMetadata
    const context = {
      ...toolContext(target),
      metadata: () => Effect.promise(() => {
        metadataStarted = true
        return new Promise((resolvePromise) => { releaseMetadata = resolvePromise })
      }),
    }
    const delegated = hooks.tool.task.execute({
      description: "dispose metadata",
      prompt: "must not dispatch",
      subagent_type: "general",
    }, context)
    while (!metadataStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const disposal = hooks.dispose()
    releaseMetadata()

    await assert.rejects(delegated, /正在释放/)
    await disposal
    assert.equal(client.promptAsyncCalls.length, 0)
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.task.status, "cancelled")
    assert.equal(child.metadata.o4e.task.phase, "runtime-disposed-before-dispatch")
    assert.equal(child.metadata.o4e.delegation.status, "cancelled")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task 的 O4E allow 和 ask 都交由宿主授权，deny 在创建前拒绝", async () => {
  for (const action of ["allow", "ask", "deny"]) {
    const target = mkdtempSync(join(tmpdir(), `o4e-plugin-task-${action}-`))
    try {
      copyInstalledDefaults(componentRoot, target)
      setOrchestratorPermission(target, "task", action)
      const client = new HookClient()
      client.directory = target
      client.addSession({ id: "parent", directory: target })
      const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
      const asks = []
      const context = { ...toolContext(target), ask: async (request) => { asks.push(request) } }
      const input = {
        description: `${action} task`,
        prompt: "inspect",
        subagent_type: "general",
        background: false,
      }

      if (action === "deny") {
        await assert.rejects(hooks.tool.task.execute(input, context), /拒绝 task 目标/)
      } else {
        const result = taskResult(await hooks.tool.task.execute(input, context))
        assert.equal(result.status, "reported-completed")
      }

      assert.deepEqual(
        asks.map((request) => [request.permission, request.patterns]),
        action === "deny" ? [] : [["task", ["general"]]],
      )
      assert.equal(client.promptCalls.length, action === "deny" ? 0 : 1)
      const children = [...client.sessions.values()].filter((session) => session.parentID === "parent")
      assert.equal(children.length, action === "deny" ? 0 : 1)
      if (action !== "deny") {
        assert.equal(children[0].metadata.o4e.delegation.requesterPermissionAction, action)
        assert.equal(children[0].metadata.o4e.delegation.requesterPermissionApproved, action === "ask")
      }
      await hooks.dispose()
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test("受管 task 前后台在宿主批准前不创建，拒绝、取消与缺失 ask 均不派发", async () => {
  for (const background of [false, undefined]) {
    for (const outcome of ["approve", "reject", "abort", "approve-abort", "missing"]) {
      const target = mkdtempSync(join(tmpdir(), `o4e-plugin-task-host-${outcome}-`))
      let hooks
      let approve
      let reject
      const approval = new Promise((resolvePromise, rejectPromise) => { approve = resolvePromise; reject = rejectPromise })
      try {
        copyInstalledDefaults(componentRoot, target)
        setOrchestratorPermission(target, "task", "allow")
        const client = new HookClient()
        client.directory = target
        client.addSession({ id: "parent", directory: target, permission: [{ permission: "task", pattern: "general", action: "ask" }] })
        hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
        const asks = []
        const controller = new AbortController()
        const context = {
          ...toolContext(target),
          abort: controller.signal,
          ask: outcome === "missing" ? undefined : async (request) => { asks.push(request); await approval },
        }
        const delegated = hooks.tool.task.execute({
          description: "host approval boundary",
          prompt: "inspect",
          subagent_type: "general",
          ...(background === undefined ? {} : { background }),
        }, context)
        const expected = outcome === "approve" ? delegated : assert.rejects(delegated,
          outcome === "missing" ? /尚未获得本次授权/ : /host rejected|caller aborted/)

        if (outcome !== "missing") {
          await waitUntil(() => asks.length === 1)
          assert.deepEqual(asks[0].patterns, ["general"])
          assert.equal(asks[0].permission, "task")
          assert.equal(client.sessions.size, 1, "host approval is still pending")
          assert.equal(client.promptCalls.length + client.promptAsyncCalls.length, 0)
          if (outcome === "reject") reject(new Error("host rejected"))
          else if (outcome === "abort") controller.abort(new Error("caller aborted"))
          else {
            approve()
            if (outcome === "approve-abort") controller.abort(new Error("caller aborted"))
          }
        }
        const result = await bounded(expected)
        approve()
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        if (outcome === "approve") {
          assert.ok(taskResult(result).sessionID)
          await waitUntil(() => client.promptCalls.length + client.promptAsyncCalls.length === 1)
          assert.equal(client.sessions.size, 2)
          const delegation = client.sessions.get(taskResult(result).sessionID).metadata.o4e.delegation
          assert.equal(delegation.requesterPermissionAction, "ask")
          assert.equal(delegation.requesterPermissionApproved, true)
        } else {
          assert.equal(client.sessions.size, 1)
          assert.equal(client.promptCalls.length + client.promptAsyncCalls.length, 0)
        }
      } finally {
        approve()
        await hooks?.dispose()
        rmSync(target, { recursive: true, force: true })
      }
    }
  }
})

test("dispose drain 普通 session.error 时不启动新的模型回合", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-fallback-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks.config({ agent: {}, provider: { provider: { models: { primary: {} } } } })
    await hooks["chat.message"]({ sessionID: "ordinary", agent: "orchestrator", model: { providerID: "provider", modelID: "primary" } }, { message: { id: "ordinary-message" }, parts: [{ type: "text", text: "work" }] })
    let releaseTurn
    let turnStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      turnStarted = true
      await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      return { data: undefined }
    }
    await executeTask(hooks, {
      description: "hold dispose",
      prompt: "hold dispose",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    const disposal = hooks.dispose()
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "ordinary", error: { name: "APIError", data: { isRetryable: true } } } } })
    releaseTurn()
    await disposal
    assert.equal(client.promptAsyncCalls.length, 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("dispose drain Background Task 模型错误时不启动新的模型回合", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-background-fallback-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, model: { providerID: "provider", id: "primary" } })
    let releaseTurn
    let turnStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      turnStarted = true
      await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      client.sessions.get(path.id).status = "busy"
      return { data: undefined }
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks.config({ agent: {}, provider: { provider: { models: { primary: {} } } } })
    const created = await executeTask(hooks, {
      description: "retryable",
      prompt: "retryable",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    client.messages.set(created.sessionID, [{
      info: {
        id: "assistant-error",
        role: "assistant",
        parentID: client.promptAsyncCalls[0].body.messageID,
        error: { name: "APIError", data: { isRetryable: true } },
      },
      parts: [],
    }])
    client.sessions.get(created.sessionID).status = "idle"

    const disposal = hooks.dispose()
    await hooks.event({ event: { type: "session.error", properties: { sessionID: created.sessionID, error: { name: "APIError", data: { isRetryable: true } } } } })
    releaseTurn()
    await disposal
    assert.equal(client.promptAsyncCalls.length, 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("dispose drain Background Task 完成事件时不启动 queued 后继", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-dispose-background-slot-release-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    setAgentConcurrency(target, 1)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    let releaseTurn
    let turnStarted = false
    client.session.promptAsync = async ({ path, body }) => {
      client.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
      turnStarted = true
      await new Promise((resolvePromise) => { releaseTurn = resolvePromise })
      client.sessions.get(path.id).status = "busy"
      return { data: undefined }
    }
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const first = await executeTask(hooks, {
      description: "first",
      prompt: "first",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (!turnStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const second = await executeTask(hooks, {
      description: "second",
      prompt: "second",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-complete", role: "assistant", parentID: client.promptAsyncCalls[0].body.messageID },
      parts: [{ id: "part-complete", type: "text", text: "done" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"

    const disposal = hooks.dispose()
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    releaseTurn()
    await disposal
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(client.promptAsyncCalls.some((call) => call.sessionID === second.sessionID), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("Workflow 插件拒绝旧定义和旧 start/resume 参数且不执行", async () => {
  const legacyDefinition = {
    name: "legacy-workflow",
    description: "Legacy automatic Workflow definition",
    output: {},
    steps: [{ id: "work", type: "agent", agent: { preferred: "researcher", fallback: "none" },
      skill: "research.investigate", effect: "read", task: { description: "must not dispatch" } }],
  }
  for (const [name, prepare, invoke] of [
    ["definition", (target) => writeFileSync(join(target, ".o4e", "workflows", "legacy-workflow.jsonc"), JSON.stringify(legacyDefinition)), null],
    ["start", null, (hooks, context) => hooks.tool.o4e_workflow.execute({ workflow: "investigation", input: {} }, context)],
    ["resume", null, (hooks, context) => hooks.tool.o4e_workflow.execute({ resumeRunID: "legacy-run" }, context)],
  ]) {
    const target = mkdtempSync(join(tmpdir(), `o4e-plugin-legacy-workflow-${name}-`))
    let hooks
    try {
      copyInstalledDefaults(componentRoot, target)
      prepare?.(target)
      const configRoot = join(target, ".o4e")
      writeConfigJson(join(configRoot, "config.json"), { ...readConfigJson(configRoot, "config.json"), enableWorkflow: true })
      const client = new HookClient()
      client.directory = target
      client.addSession({ id: "parent", directory: target })
      if (!invoke) {
        await assert.rejects(OpenCodeForEverythingPlugin({ client, directory: target, worktree: target }), /contract 必须是 process-v1|只支持 work/)
      } else {
        hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
        await assert.rejects(invoke(hooks, { ...toolContext(target), callID: `legacy-${name}` }), /O4E_WORKFLOW_INVALID_ARGUMENTS/)
      }
      assert.equal(client.sessions.size, 1)
      assert.equal(client.promptCalls.length, 0)
      assert.equal(client.promptAsyncCalls.length, 0)
      assert.equal(client.updateCalls.length, 0)
    } finally {
      await hooks?.dispose()
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test("Workflow chat.message 忽略旧 Run，不扫描、不迁移也不修改", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-legacy-workflow-message-"))
  let hooks
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({
      id: "parent",
      directory: target,
      metadata: { o4e: { workflow: { version: 2, status: "running", runSessionID: "legacy-run" } } },
    })
    client.addSession({
      id: "legacy-run",
      parentID: "parent",
      directory: target,
      metadata: { o4e: { kind: "workflow-run", version: 2, workflow: { initiatingSessionID: "parent", status: "running" } } },
    })
    client.addSession({
      id: "legacy-attempt",
      parentID: "legacy-run",
      directory: target,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        depth: 1, status: "unknown", parentSessionID: "legacy-run", sourceAgent: "orchestrator", targetAgent: "researcher",
        toolName: "o4e_workflow", requesterPermissionPattern: "legacy", effect: "unknown-write", writeScopes: [],
        dispatchMessageID: "msg-legacy", scopeLockID: "legacy-lock",
      } } },
    })
    const before = structuredClone([...client.sessions])
    let listCalls = 0
    let legacyChildrenCalls = 0
    const children = client.session.children
    client.session.list = async () => { listCalls++; throw new Error("legacy Workflow recovery must not list Sessions") }
    client.session.children = async (args) => {
      if (["legacy-run", "legacy-attempt"].includes(args.path.id)) legacyChildrenCalls++
      return children(args)
    }
    hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const output = { message: { id: "incoming" }, parts: [{ type: "text", text: "new instruction" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    assert.equal(listCalls, 0)
    assert.equal(legacyChildrenCalls, 0)
    assert.deepEqual([...client.sessions], before)
    assert.equal(client.updateCalls.length, 0)
    assert.equal(client.promptCalls.length, 0)
    assert.equal(client.promptAsyncCalls.length, 0)
    assert.deepEqual(output.parts, [{ type: "text", text: "new instruction" }])
  } finally {
    await hooks?.dispose()
    rmSync(target, { recursive: true, force: true })
  }
})

test("新 process-v1 Run 在 chat.message 中只中断当前检查点且不扫描 Session", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-process-workflow-message-"))
  let hooks
  try {
    copyInstalledDefaults(componentRoot, target)
    const configRoot = join(target, ".o4e")
    writeConfigJson(join(configRoot, "config.json"), { ...readConfigJson(configRoot, "config.json"), enableWorkflow: true })
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, agent: "orchestrator" })
    let listCalls = 0
    const childrenCalls = []
    client.session.list = async () => { listCalls++; throw new Error("process Workflow must not list Sessions") }
    const children = client.session.children
    client.session.children = async (args) => { childrenCalls.push(args.path.id); return children(args) }
    hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const invoke = async (args, messageID, callID) => {
      const messages = client.messages.get("parent") ?? []
      if (!messages.some((message) => message.info.role === "user")) messages.push({
        info: { id: "user-before", sessionID: "parent", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "start investigation" }],
      })
      messages.push({
        info: { id: messageID, sessionID: "parent", role: "assistant", parentID: "user-before", time: { created: 2 } },
        parts: [{ type: "tool", tool: "o4e_workflow", callID, state: { status: "running", input: structuredClone(args) } }],
      })
      client.messages.set("parent", messages)
      return JSON.parse(await hooks.tool.o4e_workflow.execute(args, { ...toolContext(target), messageID, callID }))
    }
    const started = await invoke({ action: "start", workflow: "investigation" }, "workflow-start", "workflow-start")
    const active = await invoke({ action: "begin", runID: started.runID, stepID: "scope", expectedRevision: started.revision }, "workflow-begin", "workflow-begin")
    assert.equal(active.status, "running")
    const output = { message: { id: "new-user-message" }, parts: [{ type: "text", text: "change direction" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    const persisted = client.sessions.get("parent").metadata.o4e.workflowProcess.runs[started.runID]
    assert.equal(persisted.status, "interrupted")
    assert.equal(persisted.revision, active.revision + 1)
    assert.equal(listCalls, 0)
    assert.deepEqual(childrenCalls, ["parent"], "ordinary Task recovery may inspect the owner only; Workflow must not scan child Sessions")
    assert.equal(client.sessions.size, 1)
    assert.equal(client.promptCalls.length, 0)
    assert.equal(client.promptAsyncCalls.length, 0)
    assert.equal(output.parts.some((part) => /Workflow reconciliation notice/.test(part.text)), true)
  } finally {
    await hooks?.dispose()
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task 缺省后台，并在返回前发布原生子 Session metadata", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-background-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, model: { id: "selected", providerID: "provider", variant: "high" } })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const metadataUpdates = []

    const result = await hooks.tool.task.execute({
      description: "Inspect fixture",
      prompt: "Read the fixture",
      subagent_type: "general",
      permissionOverlay: { "functions.apply_patch": "deny" },
    }, toolContext(target, metadataUpdates))
    const created = taskResult(result)

    assert.equal(created.status, "queued")
    assert.equal(client.promptCalls.length, 0)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(client.promptAsyncCalls[0].body.messageID.startsWith("msg_"), true)
    assert.deepEqual(client.promptAsyncCalls[0].body.model, { providerID: "provider", modelID: "selected" })
    assert.equal(client.promptAsyncCalls[0].body.variant, "high")
    assert.equal(client.sessions.get(created.sessionID).permission.some((rule) => rule.permission === "edit" && rule.action === "deny"), true)
    assert.deepEqual(metadataUpdates.at(-1), {
      title: "Inspect fixture",
      metadata: {
        parentSessionId: "parent",
        sessionId: created.sessionID,
        model: { providerID: "provider", modelID: "selected", variant: "high" },
        background: true,
      },
    })
    assert.equal(result.metadata.sessionId, created.sessionID)
    assert.equal(result.metadata.background, true)
    assert.equal(result.metadata.o4eResult.taskID, created.taskID)
    assert.match(result.output, new RegExp(created.taskID))
    assert.doesNotMatch(result.output, /revision:|authorization Fingerprint:|owner Session ID:/i)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task 的 plan:false 可委派普通非 Plan Agent", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-self-plan-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, model: { id: "selected", providerID: "provider" } })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    const result = await hooks.tool.task.execute({
      description: "Debug fixture",
      prompt: "Inspect the fixture",
      subagent_type: "debugger",
      plan: false,
    }, toolContext(target))
    const created = taskResult(result)

    assert.equal(created.status, "queued")
    assert.equal(created.agent, "debugger")
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.delegation.plan, undefined)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("默认 primary/all 执行与 Plan Profile 都可发起一级受管 task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-requester-boundary-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
  const requesters = ["orchestrator", "orchestrator (plan)", "architect", "architect (plan)", "reviewer (plan)", "researcher (plan)", "debugger", "tester", "build", "plan (plan)"]
    for (const requester of requesters) client.addSession({ id: `parent-${requester}`, directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    for (const requester of requesters) {
      const result = await hooks.tool.task.execute({
        description: `Delegate from ${requester}`,
        prompt: "Return a bounded result",
        subagent_type: "general",
        background: false,
      }, toolContext(target, [], { agent: requester, sessionID: `parent-${requester}` }))
      const completed = taskResult(result)
      assert.equal(completed.status, "reported-completed", requester)
      assert.equal(client.sessions.get(completed.sessionID).metadata.o4e.delegation.sourceAgent, requester)
    }

    assert.equal(client.promptCalls.length, requesters.length)
    client.addSession({ id: "parent-chat", directory: target })
    await assert.rejects(hooks.tool.task.execute({
      description: "Forbidden chat delegation", prompt: "work", subagent_type: "researcher",
    }, toolContext(target, [], { agent: "chat (plan)", sessionID: "parent-chat" })))
    assert.equal(client.promptCalls.length, requesters.length)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task 在 permissionOverlay 试图扩权时以工具错误拒绝且保留替代候选", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-overlay-rejection-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    await assert.rejects(
      hooks.tool.task.execute({
        description: "Inspect host CPU",
        prompt: "Inspect CPU usage with read-only commands",
        subagent_type: "researcher (plan)",
        permissionOverlay: { bash: "ask", edit: "deny" },
      }, toolContext(target)),
      (error) => {
        assert.equal(error.code, "O4E_TASK_SELECTION_FAILED")
        assert.equal(error.response.status, "agent-not-found")
        assert.match(error.message, /permissionOverlay\.bash 不能把 deny 扩大为 ask/)
        assert.match(error.message, /permissionOverlay 只能收紧目标已有权限/)
        assert.equal(error.response.candidates.some((candidate) => candidate.id === "debugger"), true)
        return true
      },
    )
    assert.equal([...client.sessions.values()].some((session) => session.parentID === "parent"), false)
    assert.equal(client.promptCalls.length + client.promptAsyncCalls.length, 0)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("o4e_task watch 只返回状态，正文由独立读取提供", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-watch-metadata-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = join(target, ".o4e", "config.jsonc")
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace('"enable_o4e_task_detail": false', '"enable_o4e_task_detail": true'))
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "inspect sources",
      prompt: "inspect sources",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-tools", role: "assistant", parentID: client.promptAsyncCalls[0].body.messageID, finish: "tool-calls" },
      parts: [
        { id: "tool-read", type: "tool", tool: "read", state: { status: "running", input: { filePath: join(target, "src", "worker.ts"), token: "private-token" }, output: "private body" } },
        { id: "tool-webfetch", type: "tool", tool: "webfetch", state: { status: "completed", input: { url: "https://example.com/private?token=private-token" }, output: "private body" } },
      ],
    }])
    const metadataUpdates = []
    client.messageCalls.length = 0

    const result = await hooks.tool.o4e_task.execute({
      action: "watch",
      taskID: created.taskID,
      timeoutMs: 1,
    }, toolContext(target, metadataUpdates))
    const watched = result.metadata.o4eResult

    assert.equal(watched.reason, "heartbeat")
    assert.match(result.title, /^General Task [a-f0-9]{8} · running · model-running · heartbeat$/)
    assert.equal(result.metadata.action, "watch")
    assert.equal(result.metadata.tasks[0].taskID, created.taskID)
    assert.equal(watched.tasks[0].tail, undefined)
    assert.equal(watched.tasks[0].output, undefined)
    assert.deepEqual(result.metadata.tasks[0], { ...watched.tasks[0], agent: "general" })
    assert.equal(Object.hasOwn(watched, "nextHeartbeatMs"), false)
    assert.equal(Object.hasOwn(result.metadata, "nextHeartbeatMs"), false)
    assert.equal(Number.isSafeInteger(watched.tasks[0].revision), true)
    assert.equal(typeof watched.tasks[0].phase, "string")
    assert.match(result.output, /Watch · heartbeat/)
    assert.doesNotMatch(result.output, /src\/worker.ts|private body/)
    assert.equal(JSON.stringify(result.metadata).includes("private body"), false)
    assert.equal(JSON.stringify(result.metadata).includes("example.com/private"), false)
    assert.equal(JSON.stringify(result.metadata).includes("private-token"), false)
    const limitedReads = client.messageCalls.filter((call) => call.query.limit !== undefined)
    assert.equal(limitedReads.length, 0)
    assert.equal(metadataUpdates.length, 2)
    assert.match(metadataUpdates[0].title, /^General Task [a-f0-9]{8} · running/)
    assert.equal(Object.hasOwn(metadataUpdates[0].metadata.tasks[0], "activity"), false)
    assert.equal(metadataUpdates[0].metadata.reason, "watching")
    const { o4eResult: _o4eResult, ...displayMetadata } = result.metadata
    assert.deepEqual(metadataUpdates[1], { title: result.title, metadata: displayMetadata })
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("o4e_task inspect 注入分页 reader、增量游标与 output/receipt 隔离", { timeout: 30_000 }, async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-inspect-"))
  let hooks
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    client.addSession({ id: "other-parent", directory: target })
    hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "inspect running output", prompt: "inspect running output", subagent_type: "general", writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const dispatchMessageID = client.promptAsyncCalls[0].body.messageID
    const assistant = {
      info: { id: "assistant-inspect", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [
        { id: "public-text", type: "text", text: "a".repeat(1100) },
        { id: "private-text", type: "text", text: "private body", visibility: "private" },
        { id: "reasoning", type: "reasoning", text: "hidden reasoning" },
      ],
    }
    client.messages.set(created.sessionID, [{ info: { id: dispatchMessageID, role: "user" }, parts: [] }, assistant])
    client.messageCalls.length = 0
    const ledgerBefore = structuredClone(client.sessions.get(created.sessionID).metadata.o4e)
    const groupBefore = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
    const inspect = async (options = {}, context = toolContext(target)) => taskResult(await hooks.tool.o4e_task.execute({
      action: "inspect", taskID: created.taskID, ...options,
    }, context))
    const first = await inspect()
    assert.equal(first.status, "running", "assistant finish text must not settle a busy Task")
    assert.equal(first.tail, "a".repeat(1024))
    assert.ok(first.cursor.length <= 120)
    assert.ok(first.beforeCursor.length <= 120)
    assert.deepEqual(Object.keys(first).sort(), ["beforeCursor", "cursor", "status", "tail", "taskID"])
    const earlier = await inspect({ cursor: first.beforeCursor, direction: "backward" })
    assert.equal(earlier.tail, "a".repeat(76))
    const unchanged = await inspect({ cursor: first.cursor })
    assert.equal(unchanged.unchanged, true)
    assert.equal(unchanged.tail, undefined)
    assistant.parts[0].text += " appended"
    const appended = await inspect({ cursor: first.cursor })
    assert.equal(appended.tail, " appended")
    assistant.parts[0].text = `b${assistant.parts[0].text.slice(1)}`
    assert.equal((await inspect({ cursor: first.cursor })).gap, "source-changed")
    assert.deepEqual(client.sessions.get(created.sessionID).metadata.o4e, ledgerBefore)
    assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks, groupBefore)
    assert.equal(client.messageCalls.length, 5)
    assert.ok(client.messageCalls.every((call) => call.responseStyle === "fields" && call.query.limit === 20))
    await assert.rejects(inspect({}, toolContext(target, [], { agent: "general", sessionID: created.sessionID })), /O4E_TASK_MANAGEMENT_DENIED/)
    const readsBefore = client.messageCalls.filter((call) => call.responseStyle === "fields").length
    await assert.rejects(inspect({ cursor: first.cursor }, toolContext(target, [], { sessionID: "other-parent" })))
    assert.equal(client.messageCalls.filter((call) => call.responseStyle === "fields").length, readsBefore)
    await assert.rejects(hooks.tool.o4e_task.execute({ action: "output", taskID: created.taskID }, toolContext(target)), /尚未 completed/)

    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    const terminalGroup = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks)
    assert.ok(terminalGroup.taskRefs[created.taskID].receipts.length > 0)
    assert.equal((await inspect()).status, "completed")
    assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks, terminalGroup)
    const output = taskResult(await hooks.tool.o4e_task.execute({ action: "output", taskID: created.taskID }, toolContext(target)))
    assert.equal(output.status, "completed")
    assert.ok(output.output.includes(assistant.parts[0].text))
    const consumed = taskResult(await hooks.tool.o4e_task.execute({ action: "watch", taskID: created.taskID }, toolContext(target)))
    assert.equal(consumed.reason, "empty", "output already consumed the terminal receipt")
    assert.equal(consumed.tasks[0].kind, "agent")
    assert.equal(consumed.tasks[0].output, undefined)
    assert.equal(Object.hasOwn(earlier, "beforeCursor"), false)
  } finally {
    await hooks?.dispose()
    rmSync(target, { recursive: true, force: true })
  }
})

test("o4e_task resume 从真实父 Part 的 empty 进入同一正文并逐字节续读 inspect/backward，watch 不改变续读位置", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    let sequence = 0
    const read = (args, status) => bounded(persistedTaskRead(hooks, client, {
      taskID: created.taskID, resume: true, ...args,
    }, { ...toolContext(target), callID: `read-${++sequence}` }, status))
    assert.deepEqual(await read({ action: "inspect", maxBytes: 4 }, "pending"), {
      taskID: created.taskID, status: "running", unchanged: true,
    })
    const body = { id: "streaming-body", type: "text", text: "ABCD" }
    client.messages.get(created.sessionID).push({
      info: { id: "streaming-answer", sessionID: created.sessionID, role: "assistant", parentID: dispatchMessageID },
      parts: [body],
    })
    const anchored = await read({ action: "inspect", maxBytes: 4 })
    assert.equal(anchored.tail, "ABCD")
    assert.ok(anchored.cursor)
    const tails = [anchored.tail]
    for (const [addition, expected, status] of [
      ["EFGHijkl", "EFGH", "pending"], ["MNOP", "ijkl", "running"], ["汉a字b", "MNOP", "completed"],
      ["", "汉a", "running"], ["", "字b", "pending"],
    ]) {
      body.text += addition
      const preview = await read({ action: "inspect", maxBytes: 4 }, status)
      assert.equal(preview.tail, expected)
      assert.equal(Buffer.byteLength(preview.tail), 4)
      assert.equal(preview.gap, undefined)
      assert.equal(preview.unavailable, undefined)
      tails.push(preview.tail)
    }
    assert.equal(tails.join(""), body.text, "ongoing append must not move the cursor to the live tail")
    assert.equal((await read({ action: "inspect", maxBytes: 4 })).unchanged, true)

    body.text += "NEXT"
    const status = await bounded(persistedTaskRead(hooks, client, {
      action: "watch", taskID: created.taskID, timeoutMs: 1,
    }, { ...toolContext(target), callID: `status-${++sequence}` }))
    assert.equal(status.reason, "heartbeat")
    assert.equal(status.tasks[0].tail, undefined)
    assert.equal((await read({ action: "inspect", maxBytes: 4 })).tail, "NEXT")

    body.text += "BACKwardTAIL"
    const fresh = await read({ action: "inspect", resume: false, maxBytes: 4 })
    assert.equal(fresh.tail, "TAIL")
    assert.ok(fresh.beforeCursor)
    assert.equal((await read({ action: "inspect", direction: "backward", maxBytes: 4 })).tail, "ward")
    assert.equal((await read({ action: "inspect", direction: "backward", maxBytes: 4 })).tail, "BACK")

    await assert.rejects(read({ action: "inspect", maxBytes: 3 }), /maxBytes/)
    const readsBefore = client.messageCalls.filter((call) => call.responseStyle === "fields" && call.path.id === created.sessionID).length
    assert.deepEqual(await read({ action: "inspect", maxBytes: 4 }), {
      taskID: created.taskID, status: "running", unavailable: "resume-tool-error",
    })
    assert.equal(client.messageCalls.filter((call) => call.responseStyle === "fields" && call.path.id === created.sessionID).length, readsBefore)
    assert.equal((await read({ action: "inspect", resume: false, maxBytes: 4 })).tail, "TAIL")
    body.text += "+NEW"
    assert.equal((await read({ action: "inspect", maxBytes: 4 })).tail, "+NEW")
    assert.ok(client.messageCalls.filter((call) => call.responseStyle === "fields").every((call) => call.query.limit === 20))
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.deepEqual(client.abortCalls, [])
  })
})

test("o4e_task resume refuses rewritten public previews and requires an explicit fresh read", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    const body = { id: "preview-body", type: "text", text: "first public output" }
    client.messages.get(created.sessionID).push({
      info: { id: "preview-answer", sessionID: created.sessionID, role: "assistant", parentID: dispatchMessageID },
      parts: [body],
    })
    const context = (callID) => ({ ...toolContext(target), callID })
    const args = { action: "inspect", taskID: created.taskID, resume: true }
    const first = await persistedTaskRead(hooks, client, args, context("preview-original"))
    assert.equal(first.tail, body.text)
    body.text += "-appended"
    const messages = client.messages.get("parent")
    const prior = messages[0].parts[0]
    const publicOutput = prior.state.output
    // Model another after hook changing only the actual body the host persists.
    for (const output of ["", "Inspection summarized.", publicOutput.replace(first.tail, "first")]) {
      messages[0].parts.splice(1)
      prior.state.output = output
      const resumed = await persistedTaskRead(hooks, client, args, context("preview-damaged"))
      assert.equal(resumed.unavailable, "resume-preview-unavailable")
      assert.equal(resumed.tail, undefined)
      assert.equal(resumed.cursor, undefined)
    }
    const fresh = await persistedTaskRead(hooks, client, { ...args, resume: false }, context("preview-fresh"))
    assert.equal(fresh.tail, body.text)
    body.text += "-next"
    const resumed = await persistedTaskRead(hooks, client, args, context("preview-resumed"))
    assert.equal(resumed.tail, "-next")
    assert.equal(resumed.unavailable, undefined)
  }, { detail: true })
})

test("o4e_task resume rejects host empty-input Parts without reading a fresh child tail", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    client.messages.get(created.sessionID).push({
      info: { id: "partial-input-answer", sessionID: created.sessionID, role: "assistant", parentID: dispatchMessageID },
      parts: [{ id: "partial-input-body", type: "text", text: "public text" }],
    })
    for (const status of ["pending", "running", "error"]) {
      client.messages.set("parent", [{ info: { id: "parent-message", sessionID: "parent", role: "assistant" }, parts: [{
        id: "incomplete-part", callID: "incomplete-call", type: "tool", tool: "o4e_task",
        state: { status, input: {}, raw: "" },
      }] }])
      const before = client.messageCalls.filter((call) => call.responseStyle === "fields" && call.path.id === created.sessionID).length
      const result = await bounded(persistedTaskRead(hooks, client, {
        action: "inspect", taskID: created.taskID, resume: true,
      }, { ...toolContext(target), callID: `after-${status}` }))
      assert.deepEqual(result, { taskID: created.taskID, status: "running", unavailable: `resume-tool-${status}` })
      assert.equal(client.messageCalls.filter((call) => call.responseStyle === "fields" && call.path.id === created.sessionID).length, before)
    }
  })
})

test("o4e_task watch reports streamed tool identity failure as explicit model-error decision", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-stream-identity-error-"))
  let hooks
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy", model: { providerID: "provider", id: "primary" } })
    hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks.config({ agent: {}, provider: { provider: { models: { primary: {} } } } })
    const created = await bounded(executeTask(hooks, {
      description: "stream identity failure", prompt: "Emit public progress, then call a tool.",
      subagent_type: "general", writeScopes: [],
    }, toolContext(target)))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    const dispatchMessageID = client.promptAsyncCalls[0].body.messageID
    const body = { id: "partial-public-body", type: "text", text: "BEGIN\n" + "a".repeat(400) }
    const answer = {
      info: { id: "partial-answer", sessionID: created.sessionID, role: "assistant", parentID: dispatchMessageID },
      parts: [body],
    }
    client.messages.set(created.sessionID, [
      { info: { id: dispatchMessageID, sessionID: created.sessionID, role: "user" }, parts: [] }, answer,
    ])
    const first = await bounded(persistedTaskRead(hooks, client, {
      action: "watch", taskID: created.taskID, timeoutMs: 1,
    }, { ...toolContext(target), callID: "progress-watch" }))
    assert.equal(first.reason, "heartbeat")
    assert.equal(first.tasks[0].tail, undefined)

    // The host persists this error after parsing fails, before any tool Part exists.
    const error = { name: "UnknownError", data: { message: "Expected 'id' to be a string." } }
    answer.info.error = error
    client.sessions.get(created.sessionID).status = "idle"
    const event = { event: { type: "session.error", properties: { sessionID: created.sessionID, error } } }
    await bounded(hooks.event(event))
    await bounded(hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }))
    const failed = await bounded(persistedTaskRead(hooks, client, {
      action: "watch", taskID: created.taskID, timeoutMs: 1000,
    }, { ...toolContext(target), callID: "failed-watch" }))
    assert.equal(failed.reason, "actionable")
    assert.equal(failed.tasks[0].taskID, created.taskID)
    assert.equal(failed.tasks[0].status, "waiting_retry_decision")
    assert.equal(failed.tasks[0].phase, "model-error-non-retryable")
    assert.equal(failed.tasks[0].tail, undefined)
    assert.equal(failed.tasks[0].cursor, undefined)
    await assert.rejects(hooks.tool.o4e_task.execute({ action: "output", taskID: created.taskID }, toolContext(target)), /尚未 completed/)
    await bounded(hooks.event(event))

    const record = client.sessions.get(created.sessionID).metadata.o4e.task
    assert.equal(record.attemptNumber, 1)
    assert.equal(record.runGeneration, 0)
    assert.equal(record.retryRound, 0)
    assert.equal(record.modelCandidates.length, 1)
    assert.deepEqual(record.currentModel, { providerID: "provider", modelID: "primary" })
    assert.equal(record.retryDecision.error.includes(error.data.message), true)
    assert.ok(record.diagnostics.some((item) => item.code === "model-error" && item.message.includes(error.data.message)))
    assert.deepEqual(answer.parts, [body])
    assert.equal(client.promptAsyncCalls.length, 1)
    assert.equal(client.promptCalls.length, 0)
    assert.deepEqual(client.abortCalls, [])
  } finally {
    try { await bounded(hooks?.dispose()) }
    finally { rmSync(target, { recursive: true, force: true }) }
  }
})

test("o4e_task resume 同父并发 Part 的 pending/running 拒绝旧 cursor 和当前或后续 Part", async (t) => {
  for (const status of ["pending", "running"]) await t.test(status, async () => {
    await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
      const args = { action: "inspect", taskID: created.taskID, resume: true, maxBytes: 4 }
      const context = (callID) => ({ ...toolContext(target), callID })
      const body = { id: "concurrent-body", type: "text", text: "seed" }
      client.messages.get(created.sessionID).push({
        info: { id: "concurrent-answer", role: "assistant", parentID: dispatchMessageID }, parts: [body],
      })
      const seed = await bounded(persistedTaskRead(hooks, client, args, context("seed")))
      assert.equal(seed.tail, "seed")
      body.text += "nextTAIL"
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const messages = client.session.messages
      const controller = new AbortController()
      let reading, following
      let childPages = 0
      client.session.messages = async (request) => {
        if (request.responseStyle === "fields" && request.path.id === created.sessionID) {
          childPages += 1
          entered.resolve()
          await release.promise
        }
        return messages(request)
      }
      try {
        reading = persistedTaskRead(hooks, client, args, { ...context("in-flight"), abort: controller.signal }, status)
        void reading.catch(() => undefined)
        await bounded(entered.promise)
        following = persistedTaskRead(hooks, client, args, { ...context("following"), abort: controller.signal }, "completed")
        // Even a later completed Part in the same Message is outside this call's boundary.
        const parent = client.messages.get("parent")[0]
        parent.parts.push({
          id: "part-future", type: "tool", tool: "o4e_task", callID: "future",
          state: { status: "completed", input: args, output: "invalid future output" },
        })
        assert.deepEqual(await bounded(following), {
          taskID: created.taskID, status: "running", unavailable: `resume-tool-${status}`,
        })
        assert.equal(childPages, 1, "the second call must not read a fresh child tail")
        release.resolve()
        assert.equal((await bounded(reading)).tail, "next")
        assert.equal(parent.parts.find((part) => part.callID === "in-flight").state.status, "completed")
      } finally {
        client.session.messages = messages
        controller.abort()
        release.resolve()
        await bounded(Promise.allSettled([reading, following]))
      }
    })
  })
})

test("before hook 仅将 inspect/watch recovery 留给 execute，参数校验与 dispose 仍 fail closed", async () => {
  await withTaskReadFixture(async ({ target, hooks: originalHooks, client, created }) => {
    await bounded(originalHooks.dispose())
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const get = client.session.get
    let reads = 0
    client.session.get = async (request) => { reads += 1; return get(request) }
    try {
      for (const action of ["inspect", "watch"]) {
        const args = { action, taskID: created.taskID, ioTimeoutMs: 0 }
        await bounded(hooks["tool.execute.before"]({ tool: "o4e_task", sessionID: "parent", callID: action }, { args }))
        assert.equal(reads, 0, "before must not start unbudgeted read recovery")
        await assert.rejects(hooks.tool.o4e_task.execute(args, toolContext(target)), /ioTimeoutMs/)
        assert.equal(reads, 0, "execute must validate before recovery")
      }
      for (const [tool, action] of [["o4e_task", "status"], ["o4e_task", "cancel"], ["task", "inspect"], ["read", "watch"]]) {
        const sessionID = `${tool}-${action}`
        client.addSession({ id: sessionID, directory: target })
        const before = reads
        await bounded(hooks["tool.execute.before"]({ tool, sessionID, callID: sessionID }, { args: { action } }))
        assert.ok(reads > before, "other tools/actions retain before-hook recovery")
      }
      await bounded(hooks.dispose())
      for (const action of ["inspect", "watch"]) {
        await assert.rejects(hooks["tool.execute.before"]({ tool: "o4e_task", sessionID: "parent" }, { args: { action } }), /正在释放/)
      }
      assert.equal(client.promptAsyncCalls.length, 1)
      // The child is still running; last-facade dispose must cancel it.
      assert.deepEqual(client.abortCalls, [created.sessionID])
    } finally {
      client.session.get = get
      await bounded(hooks.dispose())
    }
  })
})

test("o4e_task inspect/watch direct 与 before→execute 的 shared recovery 超时不丢失 dispose 追踪", async (t) => {
  for (const [entry, action, interruption] of [
    ["direct", "inspect", "deadline"],
    ["before-execute", "watch", "abort"],
  ]) await t.test(`${entry} ${action} ${interruption}`, async () => {
    await withTaskReadFixture(async ({ target, hooks: originalHooks, client, created }) => {
      await bounded(originalHooks.dispose())
      const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const get = client.session.get
      const controller = new AbortController()
      const otherController = new AbortController()
      const metadata = []
      let held = false
      let finished = false
      let parentGets = 0
      let reading, other, disposal
      client.messageCalls.length = 0
      client.session.get = async (request) => {
        if (request.path.id === "parent") {
          parentGets += 1
          if (!held) {
            held = true
            entered.resolve()
            await release.promise
            finished = true
          }
        }
        return get(request)
      }
      const read = async (ioTimeoutMs, signal) => {
        const args = { action, taskID: created.taskID, ioTimeoutMs, ...(action === "watch" ? { timeoutMs: 1 } : {}) }
        const context = { ...toolContext(target, metadata), abort: signal, callID: `read-${ioTimeoutMs}` }
        if (entry === "before-execute") {
          await hooks["tool.execute.before"]({ tool: "o4e_task", sessionID: context.sessionID, callID: context.callID }, { args })
        }
        return hooks.tool.o4e_task.execute(args, context)
      }
      try {
        const startedAt = performance.now()
        reading = read(50, controller.signal)
        const rejected = assert.rejects(reading, interruption === "deadline" ? { name: "TaskReadTimeoutError" } : /caller stopped recovery/)
        void rejected.catch(() => undefined)
        await bounded(entered.promise)
        let otherSettled = false
        other = read(10_000, otherController.signal).finally(() => { otherSettled = true })
        const otherRejected = assert.rejects(other, /正在释放/)
        void otherRejected.catch(() => undefined)
        if (interruption === "abort") controller.abort(new Error("caller stopped recovery"))
        await bounded(rejected, 1000)
        const elapsed = performance.now() - startedAt
        assert.ok(elapsed < 1000)
        if (interruption === "deadline") assert.ok(elapsed >= 40)
        assert.equal(otherSettled, false, "one caller must not cancel shared recovery for another")
        assert.equal(parentGets, 1, "the shared owner read must gate Command, Background and Delegation recovery across tool calls")
        assert.equal(finished, false)
        assert.deepEqual(client.messageCalls, [])
        assert.deepEqual(metadata, [])

        let disposed = false
        disposal = hooks.dispose().then(() => { disposed = true })
        void disposal.catch(() => undefined)
        await bounded(otherRejected)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
        assert.equal(disposed, false, "caller rejection must not untrack the real get")
        assert.equal(finished, false)
        release.resolve()
        await bounded(disposal)
        assert.equal(finished, true)
        assert.deepEqual(client.messageCalls.filter((call) => call.responseStyle === "fields"), [])
        assert.deepEqual(metadata, [])
        assert.equal(client.promptAsyncCalls.length, 1)
        // The child is still running; last-facade dispose must cancel it.
        assert.deepEqual(client.abortCalls, [created.sessionID])
      } finally {
        client.session.get = get
        controller.abort()
        otherController.abort()
        release.resolve()
        await bounded(Promise.allSettled([reading, other, disposal]))
        await bounded(hooks.dispose())
      }
    })
  })
})

test("o4e_task before→execute 等待 event drain 也响应 deadline/abort，dispose 仍等待真实事件", async (t) => {
  for (const [action, interruption] of [
    ["inspect", "deadline"],
    ["watch", "abort"],
  ]) await t.test(`${action} ${interruption}`, async () => {
    await withTaskReadFixture(async ({ target, hooks, client, created }) => {
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const get = client.session.get
      const controller = new AbortController()
      const metadata = []
      let finished = false
      let reading, event, disposal
      client.messageCalls.length = 0
      client.session.get = async (request) => {
        if (request.path.id === "parent") {
          entered.resolve()
          await release.promise
          finished = true
        }
        return get(request)
      }
      try {
        let eventSettled = false
        event = hooks.event({ event: { type: "session.status", properties: { sessionID: created.sessionID, status: { type: "busy" } } } })
          .finally(() => { eventSettled = true })
        void event.catch(() => undefined)
        await bounded(entered.promise)
        const args = { action, taskID: created.taskID, ioTimeoutMs: 50, ...(action === "watch" ? { timeoutMs: 1 } : {}) }
        const context = { ...toolContext(target, metadata), abort: controller.signal, callID: "drain-read" }
        reading = (async () => {
          await hooks["tool.execute.before"]({ tool: "o4e_task", sessionID: context.sessionID, callID: context.callID }, { args })
          return hooks.tool.o4e_task.execute(args, context)
        })()
        const rejected = assert.rejects(reading, interruption === "deadline" ? { name: "TaskReadTimeoutError" } : /caller stopped drain/)
        void rejected.catch(() => undefined)
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
        if (interruption === "abort") controller.abort(new Error("caller stopped drain"))
        await bounded(rejected, 1000)
        assert.equal(eventSettled, false)
        assert.equal(finished, false)
        assert.deepEqual(client.messageCalls, [])
        assert.deepEqual(metadata, [])

        let disposed = false
        disposal = hooks.dispose().then(() => { disposed = true })
        void disposal.catch(() => undefined)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
        assert.equal(disposed, false)
        release.resolve()
        await bounded(Promise.allSettled([event, disposal]))
        await bounded(disposal)
        assert.equal(finished, true)
        assert.deepEqual(client.messageCalls.filter((call) => call.responseStyle === "fields"), [])
        assert.deepEqual(metadata, [])
        assert.equal(client.promptAsyncCalls.length, 1)
        // The child is still running; last-facade dispose must cancel it.
        assert.deepEqual(client.abortCalls, [created.sessionID])
      } finally {
        client.session.get = get
        controller.abort()
        release.resolve()
        await bounded(Promise.allSettled([reading, event, disposal]))
      }
    })
  })
})

test("o4e_task watch 初始/最终 metadata 的 Promise 和 Effect.never 响应 deadline/abort 且保留 receipt", async (t) => {
  for (const [stage, kind, interruption] of [
    ["initial", "Promise", "deadline"],
    ["initial", "Effect", "abort"],
    ["final", "Promise", "abort"],
    ["final", "Effect", "deadline"],
  ]) {
    await t.test(`${stage} ${kind} ${interruption}`, async () => {
      await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
        const entered = Promise.withResolvers()
        const release = Promise.withResolvers()
        const controller = new AbortController()
        const updates = []
        const baseContext = toolContext(target, updates)
        const complete = async () => {
          client.messages.get(created.sessionID).push({
            info: { id: "metadata-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
            parts: [{ id: "metadata-result-body", type: "text", text: "validated result" }],
          })
          client.sessions.get(created.sessionID).status = "idle"
          await bounded(hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }))
        }
        let metadataFinished = false
        let watching, disposal
        try {
          if (stage === "initial") await complete()
          const startedAt = performance.now()
          watching = hooks.tool.o4e_task.execute({ action: "watch", taskID: created.taskID, timeoutMs: 1, ioTimeoutMs: 150 }, {
            ...baseContext, abort: controller.signal,
            metadata: (value) => {
              if (value.metadata.reason !== (stage === "initial" ? "watching" : "heartbeat")) return baseContext.metadata(value)
              updates.push(structuredClone(value))
              if (kind === "Promise") {
                entered.resolve()
                return release.promise.then(() => { metadataFinished = true })
              }
              return Effect.sync(() => entered.resolve()).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.sync(() => { metadataFinished = true })),
              )
            },
          })
          const rejected = assert.rejects(watching, interruption === "deadline" ? { name: "TaskReadTimeoutError" } : /caller stopped metadata/)
          void rejected.catch(() => undefined)
          await bounded(entered.promise)
          // Final metadata is best-effort after heartbeat, not after an admitted receipt commit.
          if (stage === "final") await complete()
          const receipts = structuredClone(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts)
          const taskReceipt = structuredClone(client.sessions.get(created.sessionID).metadata.o4e.task.receipt)
          assert.equal(receipts.length, 1)
          assert.equal(receipts[0].receiptAcknowledgedAt, undefined)
          assert.equal(receipts[0].receiptDeliveredToMessageID, undefined)
          assert.ok(taskReceipt.receiptID)
          if (interruption === "abort") controller.abort(new Error("caller stopped metadata"))
          await bounded(rejected, 1000)
          assert.ok(performance.now() - startedAt < 1000)
          assert.deepEqual(updates.map((update) => update.metadata.reason), stage === "initial" ? ["watching"] : ["watching", "heartbeat"])
          if (kind === "Effect") await waitUntil(() => metadataFinished)

          let disposed = false
          disposal = hooks.dispose().then(() => { disposed = true })
          void disposal.catch(() => undefined)
          if (kind === "Promise") {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
            assert.equal(disposed, false)
            assert.equal(metadataFinished, false)
          } else {
            await bounded(disposal, 1000)
            assert.equal(metadataFinished, true, "Effect.never must run its interruption finalizer")
          }
          release.resolve()
          await bounded(disposal)
          assert.equal(metadataFinished, true)
          assert.equal(updates.length, stage === "initial" ? 1 : 2)
          assert.deepEqual(client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts, receipts)
          assert.deepEqual(client.sessions.get(created.sessionID).metadata.o4e.task.receipt, taskReceipt)
          assert.equal(client.promptAsyncCalls.length, 1)
          assert.deepEqual(client.abortCalls, [])
        } finally {
          controller.abort()
          release.resolve()
          await bounded(Promise.allSettled([watching, disposal]))
        }
      }, { detail: true })
    })
  }
})

test("真实用户消息只在 Message 和全部注入 Part 持久化后唤醒父 watch", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-watch-user-message-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "keep running until the user returns",
      prompt: "keep running until the user returns",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }

    let settled = false
    const watching = hooks.tool.o4e_task.execute({ action: "watch" }, toolContext(target)).then((result) => {
      settled = true
      return taskResult(result)
    })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const user = { message: { id: "user-persisted" }, parts: [{ id: "user-part", type: "text", text: "what time is it?" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    const injectedPartIDs = user.parts.map((part) => part.id)
    assert.equal(injectedPartIDs.length > 1, true)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)

    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-persisted",
      sessionID: "parent",
      role: "user",
    } } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: "user-part",
      sessionID: "parent",
      messageID: "user-persisted",
      type: "text",
      text: "what time is it?",
    } } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)
    for (const partID of injectedPartIDs.filter((partID) => partID !== "user-part")) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: partID,
        sessionID: "parent",
        messageID: "user-persisted",
        type: "text",
      } } } })
    }
    const observed = await watching
    assert.equal(observed.reason, "user-message")
    assert.equal(observed.tasks[0].status, "running")
    assert.equal(client.abortCalls.length, 0)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("synthetic continuation 的 message.updated 不会把自身 watch 当作用户插话唤醒", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-watch-synthetic-message-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "keep running",
      prompt: "keep running",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    let settled = false
    const watching = hooks.tool.o4e_task.execute({ action: "watch" }, toolContext(target)).then((result) => {
      settled = true
      return taskResult(result)
    })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const synthetic = {
      message: { id: "synthetic-continuation" },
      parts: [{
        type: "text",
        text: "continue",
        synthetic: true,
        metadata: { o4e: { producer: "opencode-for-everything", version: 1, kind: "background-task-continuation" } },
      }],
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, synthetic)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "synthetic-continuation",
      sessionID: "parent",
      role: "user",
    } } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)

    const real = { message: { id: "real-user" }, parts: [{ id: "real-user-part", type: "text", text: "hello" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, real)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "real-user",
      sessionID: "parent",
      role: "user",
    } } } })
    for (const part of real.parts) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: "real-user",
      } } } })
    }
    assert.equal((await watching).reason, "user-message")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("父 Session 自然 idle 时机械续接未完成 Agent；真实插话优先且不取消后台", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-automatic-follow-user-priority-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "automatic follow", prompt: "remain running", subagent_type: "general", writeScopes: [],
    }, toolContext(target))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    client.messages.set("parent", [{
      info: { id: "assistant-before-follow", role: "assistant", parentID: "user-before-follow", finish: "stop" },
      parts: [{ id: "part-before-follow", type: "text", text: "independent work finished" }],
    }])

    const user = { message: { id: "user-interjection" }, parts: [{ id: "user-interjection-part", type: "text", text: "handle this first" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    assert.deepEqual(client.abortCalls, [])

    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-interjection", sessionID: "parent", role: "user",
    } } } })
    for (const part of user.parts) await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...part, sessionID: "parent", messageID: "user-interjection",
    } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await waitUntil(() => client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length === 1)
    const continuation = client.promptAsyncCalls.find((call) => call.sessionID === "parent")
    assert.equal(continuation.body.parts[0].metadata.o4e.kind, "background-task-continuation")
    assert.match(continuation.body.parts[0].text, new RegExp(created.taskID))
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    assert.deepEqual(client.abortCalls, [])
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

for (const waiting of ["question", "permission", "model-error"]) test(`actionable ${waiting} 自动续接仅报告一次，后续自然 idle 不重复等待`, async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    client.messages.set("parent", [{ info: { id: "follow-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.sessions.get("parent").status = "idle"
    const event = waiting === "model-error"
      ? { type: "session.error", properties: { sessionID: created.sessionID, error: { name: "APIError", data: { message: "fixture failure", isRetryable: false } } } }
      : { type: `${waiting}.asked`, properties: { info: {
        id: `follow-${waiting}`, sessionID: created.sessionID, questions: [], permission: "read", patterns: ["fixture"], always: [],
      } } }
    if (waiting === "model-error") {
      client.messages.get(created.sessionID).push({ info: {
        id: "follow-error-answer", sessionID: created.sessionID, role: "assistant", parentID: dispatchMessageID,
        error: event.properties.error,
      }, parts: [] })
      client.sessions.get(created.sessionID).status = "idle"
    }
    await hooks.event({ event })
    const expectedStatus = waiting === "model-error" ? "waiting_retry_decision" : `waiting_${waiting}`
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    const submitted = () => client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    await waitUntil(() => submitted().length === 1)
    assert.ok(submitted()[0].body.parts[0].text.includes(expectedStatus), submitted()[0].body.parts[0].text)
    client.messages.get("parent").push({ info: { id: "follow-reported", role: "assistant", finish: "stop" }, parts: [] })
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(submitted().length, 1)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, expectedStatus)
    assert.deepEqual(client.abortCalls, [])
  })
})

test("unchanged running is reported once across assistant anchors; new input and explicit follow resume wake again", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    const submitted = () => client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    const idle = async (id) => {
      client.messages.set("parent", [{ info: { id, role: "assistant", finish: "stop" }, parts: [] }])
      client.sessions.get("parent").status = "idle"
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    }
    await idle("running-first")
    await waitUntil(() => submitted().length === 1)
    await idle("running-reported")
    await idle("running-unchanged")
    assert.equal(submitted().length, 1)
    const record = client.sessions.get(created.sessionID).metadata.o4e.task
    await hooks.tool.o4e_task.execute({ action: "input", taskID: created.taskID,
      expectedRevision: record.revision, input: "new queued instruction" }, toolContext(target))
    await idle("running-changed")
    await waitUntil(() => submitted().length === 2)
    await idle("running-change-reported")
    assert.equal(submitted().length, 2)
    const follow = async (args) => taskResult(await hooks.tool.o4e_task.execute({ action: "follow", ...args }, toolContext(target)))
    const initial = await follow({})
    const stopped = await follow({ enabled: false, expectedRevision: initial.revision })
    await idle("running-disabled")
    assert.equal(submitted().length, 2)
    await follow({ enabled: true, expectedRevision: stopped.revision })
    await idle("running-resumed")
    await waitUntil(() => submitted().length === 3)
    await idle("running-resume-reported")
    assert.equal(submitted().length, 3)
    const synthetic = { message: { id: "synthetic-repeat" }, parts: structuredClone(submitted()[2].body.parts) }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, synthetic)
    await idle("synthetic-finished")
    assert.equal(submitted().length, 3)
    const user = { message: { id: "real-follow-user" }, parts: [{ id: "real-follow-part", type: "text", text: "continue tracking" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: user.message.id, sessionID: "parent", role: "user",
    } } } })
    for (const part of user.parts) await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...part, sessionID: "parent", messageID: user.message.id,
    } } } })
    await idle("real-user-finished")
    await waitUntil(() => submitted().length === 4)
    await idle("real-user-reported")
    assert.equal(submitted().length, 4)
  })
})

test("reported cancellation does not suppress a newly created sibling's automatic follow", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    client.session.abort = async () => ({ data: true })
    await hooks.tool.o4e_task.execute({ action: "cancel", taskID: created.taskID }, toolContext(target))
    const submitted = () => client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    const idle = async (id) => {
      client.messages.set("parent", [{ info: { id, role: "assistant", finish: "stop" }, parts: [] }])
      client.sessions.get("parent").status = "idle"
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    }
    await idle("cancel-report")
    await waitUntil(() => submitted().length === 1)
    const sibling = await executeTask(hooks, { description: "independent sibling", prompt: "inspect", subagent_type: "general", writeScopes: [] }, toolContext(target))
    await waitUntil(() => client.sessions.get(sibling.sessionID).metadata.o4e.task.status === "running")
    await idle("sibling-started")
    assert.equal(submitted().length, 2)
    assert.match(submitted()[1].body.parts[0].text, new RegExp(sibling.taskID))
    await idle("sibling-reported")
    assert.equal(submitted().length, 2)
  })
})

test("unchanged cancelling does not automatically wake on every assistant anchor, but terminal delivery still wakes", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    const abort = client.session.abort
    // Abort acknowledgement alone does not prove the host has stopped.
    client.session.abort = async ({ path }) => { client.abortCalls.push(path.id); return { data: true } }
    try {
      await hooks.tool.o4e_task.execute({ action: "cancel", taskID: created.taskID }, toolContext(target))
      assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "cancelling")
      const submitted = () => client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
      const idle = async (id) => {
        client.messages.set("parent", [{ info: { id, role: "assistant", finish: "stop" }, parts: [] }])
        client.sessions.get("parent").status = "idle"
        await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      }
      await idle("cancel-first-anchor")
      await waitUntil(() => submitted().length === 1)
      for (const id of ["cancel-reported", "cancel-still-unchanged"]) await idle(id)
      assert.equal(submitted().length, 1)
      assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "cancelling")
      client.sessions.get(created.sessionID).status = "idle"
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
      await idle("cancel-terminal-anchor")
      await waitUntil(() => submitted().length === 2)
      assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "cancelled")
    } finally { client.session.abort = abort }
  })
})

test("follow 控制持久化、CAS、授权和重载，不取消后台且新用户回合不解除显式停止", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created }) => {
    const context = toolContext(target)
    const follow = async (args = {}, ctx = context) => taskResult(await hooks.tool.o4e_task.execute({ action: "follow", ...args }, ctx))
    const initial = await follow()
    assert.equal(initial.enabled, true)
    const stopped = await follow({ enabled: false, expectedRevision: initial.revision })
    assert.equal(stopped.enabled, false)
    assert.equal(stopped.tasksCancelled, false)
    await assert.rejects(follow({ enabled: true, expectedRevision: initial.revision }), /REVISION_CONFLICT/)
    await assert.rejects(follow({ enabled: "false", expectedRevision: stopped.revision }), /INVALID_ARGUMENTS/)
    await assert.rejects(follow({ taskID: created.taskID }), /INVALID_ARGUMENTS/)
    await assert.rejects(follow({}, { ...context, ask: undefined }), /ASK_REQUIRED/)
    await assert.rejects(follow({}, { ...context, ask: async () => { throw new Error("host denied") } }), /host denied/)
    await assert.rejects(follow({}, toolContext(target, [], { sessionID: created.sessionID, agent: "researcher (plan)" })), /MANAGEMENT_DENIED/)
    const user = { message: { id: "follow-user" }, parts: [] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "follow-user", sessionID: "parent", role: "user" } } } })
    for (const part of user.parts) await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...part, sessionID: "parent", messageID: "follow-user",
    } } } })
    client.messages.set("parent", [{ info: { id: "follow-new-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    const second = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    try {
      assert.equal(taskResult(await second.tool.o4e_task.execute({ action: "follow" }, context)).enabled, false)
      await follow({ enabled: true, expectedRevision: stopped.revision })
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      await waitUntil(() => client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length === 1)
    } finally { await second.dispose() }
  })
})

test("automatic follow 失败持久化可恢复诊断并停止重试，不泄露错误正文", async () => {
  await withTaskReadFixture(async ({ target, hooks, client }) => {
    client.messages.set("parent", [{ info: { id: "failed-follow", role: "assistant", finish: "stop" }, parts: [] }])
    client.sessions.get("parent").status = "idle"
    const original = client.session.promptAsync
    let attempts = 0
    client.session.promptAsync = async (args) => {
      if (args.path.id !== "parent") return original(args)
      attempts++
      throw new Error("secret-provider-details")
    }
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    const result = taskResult(await hooks.tool.o4e_task.execute({ action: "follow" }, toolContext(target)))
    assert.equal(result.enabled, false)
    assert.equal(result.diagnostic, "automatic-follow-failed")
    assert.match(result.recovery, /expectedRevision/)
    assert.doesNotMatch(JSON.stringify(result), /secret-provider/)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(attempts, 1)
  })
})

test("terminal check 接口连续失败有限停止，诊断写入失败也不再自动读取", async () => {
  for (const failPersistence of [false, true, "response-lost"]) await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    client.messages.set("parent", [{ info: { id: "terminal-check-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.messages.get(created.sessionID).push({
      info: { id: "terminal-check-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "terminal-check-text", type: "text", text: "done" }],
    })
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    client.sessions.get("parent").status = "idle"
    const messages = client.session.messages
    const update = client.session.update
    let failures = 0
    client.session.messages = async (args) => {
      if (args.path.id === "parent") { failures++; throw new Error("private-storage-error") }
      return messages(args)
    }
    client.session.update = async (args) => {
      if (failPersistence && args.body.metadata?.o4e?.automaticFollow?.diagnostic) {
        if (failPersistence === "response-lost") await update(args)
        throw new Error("private-write-error")
      }
      return update(args)
    }
    try {
      for (let n = 0; n < 3; n++) await hooks.event({ event: { type: "message.updated", properties: { info: { id: "terminal-check-anchor", sessionID: "parent", role: "assistant" } } } })
      const result = taskResult(await hooks.tool.o4e_task.execute({ action: "follow" }, toolContext(target)))
      assert.equal(result.enabled, false)
      assert.equal(result.diagnostic, "automatic-follow-failed")
      if (failPersistence === true) assert.equal(result.persistenceConfirmed, false)
      else assert.notEqual(result.persistenceConfirmed, false)
      assert.doesNotMatch(JSON.stringify(result), /private-/)
      const stoppedAt = failures
      for (let n = 0; n < 3; n++) await hooks.event({ event: { type: "message.updated", properties: { info: { id: "terminal-check-anchor", sessionID: "parent", role: "assistant" } } } })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      assert.equal(failures, stoppedAt)
      assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
      assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "completed")
      client.session.update = update
      client.session.messages = messages
      const resumed = taskResult(await hooks.tool.o4e_task.execute({ action: "follow", enabled: true, expectedRevision: result.revision }, toolContext(target)))
      assert.equal(resumed.enabled, true)
      client.sessions.get("parent").status = "idle"
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      await waitUntil(() => client.promptAsyncCalls.some((call) => call.sessionID === "parent"))
    } finally { client.session.messages = messages; client.session.update = update }
  })
})

test("terminal check 短暂读取错误及 busy 等待不误停，旧错误不覆盖显式恢复", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    client.messages.set("parent", [{ info: { id: "transient-terminal-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.messages.get(created.sessionID).push({
      info: { id: "transient-terminal-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "transient-terminal-text", type: "text", text: "done" }],
    })
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    const messages = client.session.messages
    const follow = async (args = {}) => taskResult(await hooks.tool.o4e_task.execute({ action: "follow", ...args }, toolContext(target)))
    const check = () => hooks.event({ event: { type: "message.updated", properties: { info: { id: "transient-terminal-anchor", sessionID: "parent", role: "assistant" } } } })
    try {
      let remaining = 2
      client.session.messages = async (args) => {
        if (args.path.id === "parent" && remaining-- > 0) throw new Error("temporary read failure")
        return messages(args)
      }
      for (let n = 0; n < 4; n++) await check()
      assert.equal(remaining, 2, "busy must not read failing messages or consume the failure budget")
      client.sessions.get("parent").status = "idle"
      await check(); await check()
      assert.equal((await follow()).enabled, true)
      let changed = false
      client.session.messages = async (args) => {
        if (args.path.id === "parent" && !changed) {
          changed = true
          const before = await follow()
          await follow({ enabled: true, expectedRevision: before.revision })
          throw new Error("late old read failure")
        }
        return messages(args)
      }
      await check()
      assert.equal((await follow()).enabled, true)
      client.session.messages = messages
      client.sessions.get("parent").status = "idle"
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      await waitUntil(() => client.promptAsyncCalls.some((call) => call.sessionID === "parent"))
      assert.equal((await follow()).enabled, true)
    } finally { client.session.messages = messages }
  })
})

test("terminal check 混合 status/get/messages 错误不会重置失败预算", async () => {
  await withTaskReadFixture(async ({ target, hooks, client, created, dispatchMessageID }) => {
    client.messages.set("parent", [{ info: { id: "mixed-check-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.messages.get(created.sessionID).push({
      info: { id: "mixed-check-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "mixed-check-text", type: "text", text: "done" }],
    })
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    client.sessions.get("parent").status = "idle"
    const { get, status, messages } = client.session
    let failure = "status"
    client.session.status = async (...args) => { if (failure === "status") throw new Error("status unavailable"); return status(...args) }
    client.session.get = async (args) => { if (failure === "get" && args.path.id === "parent") throw new Error("get unavailable"); return get(args) }
    client.session.messages = async (args) => { if (failure === "messages" && args.path.id === "parent") throw new Error("messages unavailable"); return messages(args) }
    try {
      for (failure of ["status", "messages", "get"]) {
        await hooks.event({ event: { type: "message.updated", properties: { info: { id: "mixed-check-anchor", sessionID: "parent", role: "assistant" } } } })
      }
      failure = undefined
      const result = taskResult(await hooks.tool.o4e_task.execute({ action: "follow" }, toolContext(target)))
      assert.equal(result.enabled, false)
      assert.equal(result.persistenceConfirmed, false)
      assert.equal(result.diagnostic, "automatic-follow-failed")
      assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    } finally { Object.assign(client.session, { get, status, messages }) }
  })
})

test("automatic follow 最终提交控制读取期间的真实插话使 claim 失效", async () => {
  await withTaskReadFixture(async ({ target, hooks, client }) => {
    client.messages.set("parent", [{ info: { id: "late-follow-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.sessions.get("parent").status = "idle"
    const get = client.session.get
    let ownerReads = 0
    let interjection
    // continueParentSession reads owner control, command refs, then submission control.
    client.session.get = async (args) => {
      const result = await get(args)
      if (args.path.id === "parent" && ++ownerReads === 3) {
        interjection = hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
          message: { id: "late-follow-user" }, parts: [{ id: "late-follow-part", type: "text", text: "handle this first" }],
        })
      }
      return result
    }
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.ok(interjection)
    await interjection
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    assert.deepEqual(client.abortCalls, [])
  })
})

test("旧 automatic submission 的迟到错误不能覆盖新的显式跟踪控制", async () => {
  await withTaskReadFixture(async ({ target, hooks, client }) => {
    client.messages.set("parent", [{ info: { id: "late-failure-anchor", role: "assistant", finish: "stop" }, parts: [] }])
    client.sessions.get("parent").status = "idle"
    let entered = false
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const original = client.session.promptAsync
    client.session.promptAsync = async (args) => {
      if (args.path.id !== "parent") return original(args)
      entered = true
      await gate
      throw new Error("late old submission")
    }
    const operation = hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    try {
      await waitUntil(() => entered)
      const state = taskResult(await hooks.tool.o4e_task.execute({ action: "follow" }, toolContext(target)))
      const updated = taskResult(await hooks.tool.o4e_task.execute({ action: "follow", enabled: true, expectedRevision: state.revision }, toolContext(target)))
      release()
      await operation
      const after = taskResult(await hooks.tool.o4e_task.execute({ action: "follow" }, toolContext(target)))
      assert.equal(after.enabled, true)
      assert.equal(after.revision, updated.revision)
      assert.equal(after.diagnostic, undefined)
    } finally { release(); await operation }
  })
})

test("同目录插件实例对自然 idle 自动跟踪只提交一次", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-automatic-follow-cross-instance-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "cross instance follow", prompt: "remain running", subagent_type: "general", writeScopes: [],
    }, toolContext(target))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    client.messages.set("parent", [{
      info: { id: "assistant-cross-instance-follow", role: "assistant", parentID: "user-cross-instance", finish: "stop" },
      parts: [{ id: "part-cross-instance-follow", type: "text", text: "independent work finished" }],
    }])
    client.sessions.get("parent").status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
    ])
    await waitUntil(() => client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length === 1)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("用户 abort 只抑制自动跟踪，下一真实用户回合恢复且后台 Agent 保留", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-automatic-follow-abort-resume-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "preserve after abort", prompt: "remain running", subagent_type: "general", writeScopes: [],
    }, toolContext(target))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    client.messages.set("parent", [{
      info: { id: "assistant-before-abort", role: "assistant", parentID: "user-before-abort", finish: "stop" },
      parts: [{ id: "part-before-abort", type: "text", text: "waiting" }],
    }])
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.error", properties: {
      sessionID: "parent", error: { name: "AbortError", message: "user stopped tracking" },
    } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    assert.deepEqual(client.abortCalls, [])

    const next = { message: { id: "user-resume-tracking" }, parts: [{ id: "user-resume-part", type: "text", text: "continue" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, next)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-resume-tracking", sessionID: "parent", role: "user",
    } } } })
    for (const part of next.parts) await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...part, sessionID: "parent", messageID: "user-resume-tracking",
    } } } })
    client.messages.set("parent", [{
      info: { id: "assistant-after-resume", role: "assistant", parentID: "user-resume-tracking", finish: "stop" },
      parts: [{ id: "part-after-resume", type: "text", text: "latest instruction handled" }],
    }])
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await waitUntil(() => client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length === 1)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
    assert.deepEqual(client.abortCalls, [])
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("多个终态 Task 在父 Session idle 且无 watch 时合并为一次 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-wakeup-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const generalPath = join(target, ".o4e", "agents", "subagent", "general.jsonc")
    const generalSource = readFileSync(generalPath, "utf8")
    writeFileSync(generalPath, generalSource.replace('"loadTools": null', '"loadTools": ["read"]'))
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const first = await executeTask(hooks, {
      description: "first result",
      prompt: "first result",
      subagent_type: "general",
      permissionOverlay: { "*": "deny" },
      writeScopes: [],
    }, toolContext(target))
    const second = await executeTask(hooks, {
      description: "second result",
      prompt: "second result",
      subagent_type: "general",
      permissionOverlay: { "*": "deny" },
      writeScopes: [],
    }, toolContext(target))
    for (let attempt = 0; attempt < 100 && [first, second].some((task) => client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running"); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    assert.deepEqual([first, second].map((task) => client.sessions.get(task.sessionID).metadata.o4e.task.status), ["running", "running"])
    client.messages.set("parent", [{
      info: { id: "assistant-parent-idle", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-idle", type: "text", text: "waiting" }],
    }])
    const firstDispatch = client.sessions.get(first.sessionID).metadata.o4e.task.dispatchMessageID
    const secondDispatch = client.sessions.get(second.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-first", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-first", type: "text", text: "first private result" }],
    }])
    client.messages.set(second.sessionID, [{
      info: { id: "assistant-second", role: "assistant", parentID: secondDispatch, finish: "stop" },
      parts: [{ id: "part-second", type: "text", text: "second private result" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    client.sessions.get(second.sessionID).status = "idle"

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    assert.equal(client.promptAsyncCalls.length, 2)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: second.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 3; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    assert.equal(client.promptAsyncCalls.length, 3, JSON.stringify({
      calls: client.promptAsyncCalls,
      first: client.sessions.get(first.sessionID).metadata.o4e.task,
      second: client.sessions.get(second.sessionID).metadata.o4e.task,
      parent: client.sessions.get("parent"),
    }, null, 2))
    const continuation = client.promptAsyncCalls[2]
    assert.equal(continuation.sessionID, "parent")
    assert.equal(continuation.body.parts[0].metadata.o4e.kind, "background-task-continuation")
    assert.match(continuation.body.parts[0].text, new RegExp(first.taskID))
    assert.match(continuation.body.parts[0].text, new RegExp(second.taskID))
    assert.match(continuation.body.parts[0].text, /"receipts":\s*\[\s*\{/)
    assert.doesNotMatch(continuation.body.parts[0].text, /private result/)
    await Promise.race([
      hooks.dispose(),
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("dispose timed out")), 1000)),
    ])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("同目录插件实例并发重试复用同一 synthetic continuation 身份", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-cross-runtime-claim-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "claim one parent continuation",
      prompt: "claim one parent continuation",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-cross-runtime-claim", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-cross-runtime-claim", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-cross-runtime-claim-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-cross-runtime-claim-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"

    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }),
    ])
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    client.sessions.get("parent").status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
    ])
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100))
    const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    assert.ok(parentCalls.length >= 2)
    assert.equal(new Set(parentCalls.map((call) => call.body.messageID)).size, 1)
    assert.equal(new Set(parentCalls.map((call) => call.body.parts[0].id)).size, 1)
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(receipt.receiptDeliveredToMessageID, parentCalls[0].body.messageID)
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("既有 synthetic continuation 确认后新 receipt 进入下一 generation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-next-generation-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const first = await executeTask(firstHooks, {
      description: "first continuation generation",
      prompt: "first continuation generation",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(first.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-next-generation", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-next-generation", type: "text", text: "waiting" }],
    }])
    const firstDispatch = client.sessions.get(first.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(first.sessionID, [{
      info: { id: "assistant-first-generation-result", role: "assistant", parentID: firstDispatch, finish: "stop" },
      parts: [{ id: "part-first-generation-result", type: "text", text: "first private result" }],
    }])
    client.sessions.get(first.sessionID).status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: first.sessionID } } }),
    ])
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    const firstContinuation = client.promptAsyncCalls.find((call) => call.sessionID === "parent")
    assert.ok(firstContinuation)

    const second = await executeTask(firstHooks, {
      description: "second continuation generation",
      prompt: "second continuation generation",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(second.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.sessions.get("parent").status = "idle"
    const secondDispatch = client.sessions.get(second.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(second.sessionID, [{
      info: { id: "assistant-second-generation-result", role: "assistant", parentID: secondDispatch, finish: "stop" },
      parts: [{ id: "part-second-generation-result", type: "text", text: "second private result" }],
    }])
    client.sessions.get(second.sessionID).status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: second.sessionID } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: second.sessionID } } }),
    ])

    for (const hooks of [firstHooks, secondHooks]) {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: firstContinuation.body.messageID,
        sessionID: "parent",
        role: "user",
      } } } })
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...firstContinuation.body.parts[0],
        sessionID: "parent",
        messageID: firstContinuation.body.messageID,
      } } } })
    }
    client.messages.get("parent").push({
      info: { id: "assistant-first-continuation-generation", role: "assistant", parentID: firstContinuation.body.messageID, finish: "stop" },
      parts: [{ id: "part-assistant-first-continuation-generation", type: "text", text: "first receipt handled" }],
    })
    client.sessions.get("parent").status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } }),
    ])
    for (let attempt = 0; attempt < 300 && new Set(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").map((call) => call.body.messageID)).size < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }

    const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    const messages = new Map(parentCalls.map((call) => [call.body.messageID, call]))
    assert.equal(messages.size, 2)
    const firstReceiptID = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[first.taskID].receipts[0].receiptID
    const secondReceiptID = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[second.taskID].receipts[0].receiptID
    assert.match(messages.get(firstContinuation.body.messageID).body.parts[0].text, new RegExp(firstReceiptID))
    const nextContinuation = [...messages.values()].find((call) => call.body.messageID !== firstContinuation.body.messageID)
    assert.ok(nextContinuation)
    assert.match(nextContinuation.body.parts[0].text, new RegExp(secondReceiptID))
    assert.doesNotMatch(nextContinuation.body.parts[0].text, new RegExp(firstReceiptID))
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("watch 状态集合不会因结果正文总量超预算而失败", async (t) => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-watch-preflight-"))
  let hooks
  t.after(async () => {
    try { await hooks?.dispose() }
    finally { rmSync(target, { recursive: true, force: true }) }
  })
  copyInstalledDefaults(componentRoot, target)
  const client = new HookClient()
  client.directory = target
  client.addSession({ id: "parent", directory: target, status: "busy" })
  hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
  const tasks = []
  for (let index = 0; index < 3; index++) {
    const created = await executeTask(hooks, {
      description: `result ${index}`, prompt: "bounded result", subagent_type: "general", writeScopes: [],
    }, toolContext(target))
    await waitUntil(() => client.sessions.get(created.sessionID).metadata.o4e.task.status === "running")
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    const output = String(index % 10).repeat(24 * 1024)
    tasks.push({ ...created, output })
    client.messages.set(created.sessionID, [{
      info: { id: `answer-${index}`, role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: `text-${index}`, type: "text", text: output }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
  }
  const receipts = () => tasks.map((task) => client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[task.taskID].receipts[0])
  const result = await hooks.tool.o4e_task.execute({ action: "watch" }, toolContext(target))
  assert.ok(Buffer.byteLength(result.output) < 4096)
  const watched = taskResult(result)
  assert.equal(watched.reason, "actionable")
  assert.equal(watched.tasks.length, tasks.length)
  assert.ok(watched.tasks.every((task) => task.output === undefined))
  for (const task of tasks) {
    const output = await hooks.tool.o4e_task.execute({ action: "output", taskID: task.taskID }, toolContext(target))
    assert.equal(modelOutput(output, "output"), task.output)
  }
  assert.equal(receipts().every((receipt) => Number.isSafeInteger(receipt.receiptAcknowledgedAt)), true)
  assert.equal(taskResult(await hooks.tool.o4e_task.execute({ action: "watch" }, toolContext(target))).reason, "empty")
})

test("终态 callback 已进入 adapter 队列后成功 watch 不再提交 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-watch-consume-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "watch queued callback",
      prompt: "watch queued callback",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-watch-consume", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-watch-consume", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-watch-consume-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-watch-consume-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    const toolResult = await hooks.tool.o4e_task.execute({ action: "watch" }, toolContext(target))
    const watched = taskResult(toolResult)
    assert.equal(watched.reason, "actionable")
    assert.equal(watched.tasks[0].output, undefined)
    assert.doesNotMatch(toolResult.output, /private result/)
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
     assert.equal(receipt.receiptDeliveredToMessageID, "parent-message")
     assert.equal(Number.isSafeInteger(receipt.receiptAcknowledgedAt), true)
    for (let index = 0; index < 2; index++) {
      const result = await hooks.tool.o4e_task.execute({ action: "output", taskID: created.taskID }, {
        ...toolContext(target), messageID: `output-${index}`, callID: `output-${index}`,
      })
      assert.equal(modelOutput(result, "output"), "private result")
    }
     client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

for (const action of ["watch", "output"]) {
  test(`同目录另一 Runtime 通过 ${action} 消费时阻止已排队的 synthetic continuation 提交`, async () => {
    const target = mkdtempSync(join(tmpdir(), `o4e-plugin-task-terminal-${action}-cross-runtime-race-`))
    try {
      copyInstalledDefaults(componentRoot, target)
      const client = new HookClient()
      client.directory = target
      client.addSession({ id: "parent", directory: target, status: "busy" })
      const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
      const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
      const created = await executeTask(firstHooks, {
        description: `${action} cross runtime race`,
        prompt: `${action} cross runtime race`,
        subagent_type: "general",
        writeScopes: [],
      }, toolContext(target))
      while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
        await new Promise((resolvePromise) => setImmediate(resolvePromise))
      }
      client.messages.set("parent", [{
        info: { id: `assistant-parent-${action}-cross-runtime-race`, role: "assistant", parentID: "user-parent", finish: "stop" },
        parts: [{ id: `part-parent-${action}-cross-runtime-race`, type: "text", text: "waiting" }],
      }])
      const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
      client.messages.set(created.sessionID, [{
        info: { id: `assistant-${action}-cross-runtime-race-result`, role: "assistant", parentID: dispatchMessageID, finish: "stop" },
        parts: [{ id: `part-${action}-cross-runtime-race-result`, type: "text", text: "private result" }],
      }])
      client.sessions.get(created.sessionID).status = "idle"
      await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
      await new Promise((resolvePromise) => setImmediate(resolvePromise))

      let releaseStatus
      const statusGate = new Promise((resolvePromise) => { releaseStatus = resolvePromise })
      let reachedSubmitRecheck
      const reachedSubmitRecheckGate = new Promise((resolvePromise) => { reachedSubmitRecheck = resolvePromise })
      const originalStatus = client.session.status
      let parentStatusCalls = 0
      client.session.status = async (...args) => {
        parentStatusCalls += 1
        const status = await originalStatus(...args)
        if (parentStatusCalls === 1) {
          reachedSubmitRecheck()
          await statusGate
        }
        return status
      }
      client.sessions.get("parent").status = "idle"
      const waking = firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      await reachedSubmitRecheckGate
      const consumed = action === "watch"
        ? taskResult(await secondHooks.tool.o4e_task.execute({ action: "watch", taskID: created.taskID, timeoutMs: 100 }, toolContext(target)))
        : taskResult(await secondHooks.tool.o4e_task.execute({ action: "output", taskID: created.taskID }, toolContext(target)))
      if (action === "watch") assert.equal(consumed.reason, "actionable")
      else assert.equal(consumed.status, "completed")
      releaseStatus()
      await waking
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))

      const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
      assert.equal(parentCalls.length, 0)
      const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
      assert.equal(Number.isSafeInteger(receipt.receiptAcknowledgedAt), true)
      await firstHooks.dispose()
      await secondHooks.dispose()
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
}

test("同目录另一 Runtime 的 active watch 阻止终态 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-cross-runtime-active-watch-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "cross runtime active watch",
      prompt: "cross runtime active watch",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-cross-runtime-active-watch", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-cross-runtime-active-watch", type: "text", text: "waiting" }],
    }])
    const watching = secondHooks.tool.o4e_task.execute({ action: "watch", taskID: created.taskID, timeoutMs: 100 }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-cross-runtime-active-watch-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-cross-runtime-active-watch-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await Promise.all([
      firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }),
      secondHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }),
    ])
    const watched = taskResult(await watching)
    assert.equal(watched.reason, "actionable")
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(Number.isSafeInteger(receipt.receiptAcknowledgedAt), true)
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 Task 唤醒检查期间到达真实用户消息时不提交 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-user-race-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "finish during user race",
      prompt: "finish during user race",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-race-terminal", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-race-terminal", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-terminal-race", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-terminal-race", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    const originalStatus = client.session.status
    let racedMessage
    let statusCalls = 0
    client.session.status = async (...args) => {
      statusCalls += 1
      const status = await originalStatus(...args)
      if (statusCalls === 1) {
        racedMessage = hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
          message: { id: "user-terminal-race" },
          parts: [{ id: "part-user-terminal-race", type: "text", text: "handle this first" }],
        })
      }
      return status
    }

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && !racedMessage; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    await racedMessage
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-terminal-race",
      sessionID: "parent",
      role: "user",
    } } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: "part-user-terminal-race",
      sessionID: "parent",
      messageID: "user-terminal-race",
      type: "text",
      text: "handle this first",
    } } } })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("同目录另一 Runtime 注册真实用户回合时阻止终态 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-cross-runtime-user-race-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "cross runtime user race",
      prompt: "cross runtime user race",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-cross-runtime-user-race", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-cross-runtime-user-race", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-cross-runtime-user-race-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-cross-runtime-user-race-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    const originalStatus = client.session.status
    let racedMessage
    let statusCalls = 0
    client.session.status = async (...args) => {
      statusCalls += 1
      const status = await originalStatus(...args)
      if (statusCalls === 1) {
        racedMessage = secondHooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
          message: { id: "user-cross-runtime-terminal-race" },
          parts: [{ id: "part-user-cross-runtime-terminal-race", type: "text", text: "handle this first" }],
        })
      }
      return status
    }

    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && !racedMessage; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    await racedMessage
    await secondHooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-cross-runtime-terminal-race",
      sessionID: "parent",
      role: "user",
    } } } })
    await secondHooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: "part-user-cross-runtime-terminal-race",
      sessionID: "parent",
      messageID: "user-cross-runtime-terminal-race",
      type: "text",
      text: "handle this first",
    } } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("重复注册同一真实用户 messageID 不泄漏共享 user-turn claim", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-duplicate-user-turn-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "duplicate user turn claim",
      prompt: "duplicate user turn claim",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const firstOutput = {
      message: { id: "user-duplicate-turn" },
      parts: [{ id: "part-user-duplicate-turn", type: "text", text: "handle this first" }],
    }
    const secondOutput = structuredClone(firstOutput)
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, firstOutput)
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, secondOutput)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: "user-duplicate-turn",
      sessionID: "parent",
      role: "user",
    } } } })
    for (const part of secondOutput.parts) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: "user-duplicate-turn",
      } } } })
    }
    client.messages.set("parent", [{
      info: { id: "assistant-after-duplicate-turn", role: "assistant", parentID: "user-duplicate-turn", finish: "stop" },
      parts: [{ id: "part-assistant-after-duplicate-turn", type: "text", text: "handled" }],
    }])
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-duplicate-turn-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-duplicate-turn-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("重复 messageID 的旧 chat.message 迟到失败不删除新 user-turn claim", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-stale-duplicate-user-turn-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const receiptTask = await executeTask(hooks, {
      description: "provide receipt for duplicate turn race",
      prompt: "provide receipt for duplicate turn race",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(receiptTask.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const receiptDispatchMessageID = client.sessions.get(receiptTask.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(receiptTask.sessionID, [{
      info: { id: "assistant-duplicate-turn-receipt", role: "assistant", parentID: receiptDispatchMessageID, finish: "stop" },
      parts: [{ id: "part-duplicate-turn-receipt", type: "text", text: "private receipt result" }],
    }])
    client.sessions.get(receiptTask.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: receiptTask.sessionID } } })

    const originalUpdate = client.session.update
    let rejectFirstDelivery
    let markFirstDeliveryEntered
    const firstDeliveryEntered = new Promise((resolvePromise) => { markFirstDeliveryEntered = resolvePromise })
    let interceptFirstDelivery = true
    client.session.update = async (request) => {
      const receipts = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[receiptTask.taskID]?.receipts
      if (interceptFirstDelivery && request.path.id === "parent" && receipts?.some((receipt) => receipt.receiptDeliveredToMessageID === "user-stale-duplicate-turn")) {
        interceptFirstDelivery = false
        markFirstDeliveryEntered()
        return new Promise((_resolvePromise, rejectPromise) => { rejectFirstDelivery = rejectPromise })
      }
      return originalUpdate(request)
    }
    const firstOutput = {
      message: { id: "user-stale-duplicate-turn" },
      parts: [{ id: "part-user-stale-duplicate-turn", type: "text", text: "old" }],
    }
    const firstMessage = hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, firstOutput)
    await firstDeliveryEntered
    const secondOutput = {
      message: { id: "user-stale-duplicate-turn" },
      parts: [{ id: "part-user-stale-duplicate-turn", type: "text", text: "new" }],
    }
    const secondMessage = hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, secondOutput)
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    rejectFirstDelivery(new Error("stale user hook failed"))
    await assert.rejects(firstMessage, /stale user hook failed/)
    await secondMessage
    client.session.update = originalUpdate

    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: secondOutput.message.id,
      sessionID: "parent",
      role: "user",
    } } } })
    for (const part of secondOutput.parts) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: secondOutput.message.id,
      } } } })
    }
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    const created = await executeTask(hooks, {
      description: "finish after stale duplicate user turn",
      prompt: "finish after stale duplicate user turn",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-after-stale-duplicate-turn", role: "assistant", parentID: secondOutput.message.id, finish: "stop" },
      parts: [{ id: "part-assistant-after-stale-duplicate-turn", type: "text", text: "handled" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-stale-duplicate-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-stale-duplicate-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("同目录另一 Runtime 的 session.error 不清除当前真实用户回合", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-cross-runtime-stale-user-error-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "finish during cross runtime user turn",
      prompt: "finish during cross runtime user turn",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-before-cross-runtime-user-error", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-before-cross-runtime-user-error", type: "text", text: "waiting" }],
    }])
    const user = {
      message: { id: "user-cross-runtime-error" },
      parts: [{ id: "part-user-cross-runtime-error", type: "text", text: "handle this first" }],
    }
    await secondHooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    await firstHooks.event({ event: { type: "session.error", properties: { sessionID: "parent", error: { name: "OldError" } } } })

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-cross-runtime-user-error-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-cross-runtime-user-error-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)

    await secondHooks.event({ event: { type: "message.updated", properties: { info: {
      id: user.message.id,
      sessionID: "parent",
      role: "user",
    } } } })
    for (const part of user.parts) {
      await secondHooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: user.message.id,
      } } } })
    }
    await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("同目录另一 Runtime 的旧 idle 不结算新持久化用户回合", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-cross-runtime-stale-user-idle-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const firstClient = new HookClient()
    firstClient.directory = target
    firstClient.addSession({ id: "parent", directory: target })
    const secondClient = new HookClient()
    secondClient.directory = target
    secondClient.sessions = firstClient.sessions
    secondClient.messages = firstClient.messages
    const firstHooks = await OpenCodeForEverythingPlugin({ client: firstClient, directory: target, worktree: target })
    const secondHooks = await OpenCodeForEverythingPlugin({ client: secondClient, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "finish during persisted cross runtime user turn",
      prompt: "finish during persisted cross runtime user turn",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (firstClient.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    firstClient.messages.set("parent", [{
      info: { id: "assistant-before-cross-runtime-user-idle", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-before-cross-runtime-user-idle", type: "text", text: "waiting" }],
    }])

    const originalStatus = firstClient.session.status
    let releaseBlockedIdle
    let markBlockedIdleEntered
    const blockedIdleEntered = new Promise((resolvePromise) => { markBlockedIdleEntered = resolvePromise })
    let interceptStatus = false
    firstClient.session.status = async (request) => {
      if (!interceptStatus) return originalStatus(request)
      interceptStatus = false
      markBlockedIdleEntered()
      await new Promise((resolvePromise) => { releaseBlockedIdle = resolvePromise })
      return originalStatus(request)
    }
    const blockingIdle = firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    interceptStatus = true
    const triggerBlockedIdle = firstClient.session.status()
    await blockedIdleEntered
    const staleIdle = firstHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    const user = {
      message: { id: "user-cross-runtime-stale-idle" },
      parts: [{ id: "part-user-cross-runtime-stale-idle", type: "text", text: "handle this first" }],
    }
    await secondHooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    await secondHooks.event({ event: { type: "message.updated", properties: { info: {
      id: user.message.id,
      sessionID: "parent",
      role: "user",
    } } } })
    for (const part of user.parts) {
      await secondHooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: user.message.id,
      } } } })
    }
    releaseBlockedIdle()
    await Promise.all([blockingIdle, triggerBlockedIdle, staleIdle])
    firstClient.session.status = originalStatus

    const dispatchMessageID = firstClient.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    firstClient.messages.set(created.sessionID, [{
      info: { id: "assistant-cross-runtime-stale-idle-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-cross-runtime-stale-idle-result", type: "text", text: "private result" }],
    }])
    firstClient.sessions.get(created.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.equal(firstClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length + secondClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 0)

    firstClient.messages.set("parent", [{
      info: { id: "assistant-after-cross-runtime-stale-idle", role: "assistant", parentID: user.message.id, finish: "stop" },
      parts: [{ id: "part-after-cross-runtime-stale-idle", type: "text", text: "handled" }],
    }])
    await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    for (let attempt = 0; attempt < 200 && firstClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length + secondClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(firstClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length + secondClient.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await firstHooks.dispose()
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("淘汰过量 pending 用户消息时释放对应 user-turn claim", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-evicted-user-turn-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    for (let index = 0; index < 257; index += 1) {
      await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
        message: { id: `user-evicted-turn-${index}` },
        parts: [{ id: `part-user-evicted-turn-${index}`, type: "text", text: String(index) }],
      })
    }
    for (let index = 1; index < 257; index += 1) {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: `user-evicted-turn-${index}`,
        sessionID: "parent",
        role: "user",
      } } } })
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: `part-user-evicted-turn-${index}`,
        sessionID: "parent",
        messageID: `user-evicted-turn-${index}`,
        type: "text",
        text: String(index),
      } } } })
    }
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    const created = await executeTask(hooks, {
      description: "evicted user turn claim",
      prompt: "evicted user turn claim",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-evicted-user-turn", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-evicted-user-turn", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-evicted-user-turn-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-evicted-user-turn-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("失败的真实用户 chat.message 不会遗留终态续接门禁", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-user-hook-failure-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "finish after rejected user hook",
      prompt: "finish after rejected user hook",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-hook-failure", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-hook-failure", type: "text", text: "waiting" }],
    }])
    const originalGet = client.session.get
    client.session.get = async ({ path }) => {
      if (path.id === "parent") throw new Error("parent unavailable")
      return originalGet({ path })
    }
    await assert.rejects(
      hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
        message: { id: "rejected-user" },
        parts: [{ id: "rejected-user-part", type: "text", text: "this will not persist" }],
      }),
      /parent unavailable/,
    )
    client.session.get = originalGet

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-hook-failure-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-hook-failure-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, "parent")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("真实用户消息宿主持久化失败后 session.error 解除终态续接门禁", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-user-persist-error-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "finish after user persistence error",
      prompt: "finish after user persistence error",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-persist-error", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-persist-error", type: "text", text: "waiting" }],
    }])
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
      message: { id: "user-persist-error" },
      parts: [{ id: "part-user-persist-error", type: "text", text: "this fails after the hook" }],
    })
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "parent", error: { name: "PersistenceError" } } } })

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-persist-error-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-persist-error-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, "parent")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("已完整持久化的真实用户回合在 session.error 后不再阻塞终态续接", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-user-turn-error-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "finish after parent error",
      prompt: "finish after parent error",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-turn-error", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-turn-error", type: "text", text: "waiting" }],
    }])
    const user = { message: { id: "user-turn-error" }, parts: [{ id: "part-user-turn-error", type: "text", text: "try this" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, user)
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "user-turn-error", sessionID: "parent", role: "user" } } } })
    for (const part of user.parts) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: { ...part, sessionID: "parent", messageID: "user-turn-error" } } } })
    }
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "parent", error: { name: "APIError" } } } })

    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-turn-error-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-turn-error-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    assert.equal(client.promptAsyncCalls.length, 2)
    assert.equal(client.promptAsyncCalls[1].sessionID, "parent")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 首次提交失败后自动重试", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-retry-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "retry parent continuation",
      prompt: "retry parent continuation",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-terminal-retry", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-terminal-retry", type: "text", text: "waiting" }],
    }])
    const originalPromptAsync = client.session.promptAsync
    let parentAttempts = 0
    client.session.promptAsync = async (request) => {
      if (request.path.id === "parent") {
        client.promptAsyncCalls.push({ sessionID: request.path.id, body: structuredClone(request.body) })
        parentAttempts += 1
        if (parentAttempts === 1) return { error: "temporarily rejected" }
        client.sessions.get(request.path.id).status = "busy"
        return { data: undefined }
      }
      return originalPromptAsync(request)
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-terminal-retry-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-terminal-retry-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && parentAttempts < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    assert.equal(parentAttempts, 2)
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 2)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 响应丢失时复用同一 messageID", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-response-lost-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "reuse continuation id",
      prompt: "reuse continuation id",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-response-lost", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-response-lost", type: "text", text: "waiting" }],
    }])
    const originalPromptAsync = client.session.promptAsync
    let parentAttempts = 0
    client.session.promptAsync = async (request) => {
      if (request.path.id === "parent") {
        client.promptAsyncCalls.push({ sessionID: request.path.id, body: structuredClone(request.body) })
        parentAttempts += 1
        if (parentAttempts === 1) throw new Error("response lost after accept")
        client.sessions.get(request.path.id).status = "busy"
        return { data: undefined }
      }
      return originalPromptAsync(request)
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-response-lost-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-response-lost-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && parentAttempts < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    assert.equal(parentCalls.length, 2)
    assert.equal(parentCalls[0].body.messageID, parentCalls[1].body.messageID)
    assert.equal(parentCalls[0].body.parts[0].id, parentCalls[1].body.parts[0].id)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 仅在自身 Message 和 Part 持久化后停止重试", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-persisted-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "confirm continuation persistence",
      prompt: "confirm continuation persistence",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-continuation-persisted", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-continuation-persisted", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-continuation-persisted-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-continuation-persisted-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    const continuation = client.promptAsyncCalls[1]
    assert.equal(continuation.sessionID, "parent")
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: continuation.body.messageID,
      sessionID: "parent",
      role: "user",
    } } } })
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    const retried = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    assert.equal(retried.length, 2)
    assert.equal(retried[0].body.messageID, retried[1].body.messageID)
    assert.equal(retried[0].body.parts[0].id, retried[1].body.parts[0].id)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: continuation.body.parts[0].id,
      sessionID: "parent",
      messageID: continuation.body.messageID,
      ...continuation.body.parts[0],
    } } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 2)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 持久化后父 Assistant error 会在无新用户消息时自动重投", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-assistant-error-retry-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "retry after assistant error",
      prompt: "retry after assistant error",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-before-error-retry", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-before-error-retry", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-error-retry-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-error-retry-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    const firstContinuation = client.promptAsyncCalls.find((call) => call.sessionID === "parent")
    assert.ok(firstContinuation)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: firstContinuation.body.messageID,
      sessionID: "parent",
      role: "user",
    } } } })
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...firstContinuation.body.parts[0],
      sessionID: "parent",
      messageID: firstContinuation.body.messageID,
    } } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)

    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "parent", error: { name: "APIError" } } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    assert.equal(parentCalls.length, 2)
    assert.equal(parentCalls[0].body.messageID, parentCalls[1].body.messageID)
    assert.equal(parentCalls[0].body.parts[0].id, parentCalls[1].body.parts[0].id)
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(receipt.receiptAcknowledgedAt, undefined)

    client.messages.get("parent").push({
      info: { id: "assistant-after-error-retry", role: "assistant", parentID: firstContinuation.body.messageID, finish: "stop" },
      parts: [{ id: "part-assistant-after-error-retry", type: "text", text: "handled" }],
    })
    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    const acknowledged = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(Number.isSafeInteger(acknowledged.receiptAcknowledgedAt), true)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 2)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 持久化后父 Session 无结果 idle 会自动重投", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-assistant-interrupted-retry-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "retry after assistant interruption",
      prompt: "retry after assistant interruption",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-before-interrupted-retry", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-before-interrupted-retry", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-interrupted-retry-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-interrupted-retry-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 1; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    const firstContinuation = client.promptAsyncCalls.find((call) => call.sessionID === "parent")
    assert.ok(firstContinuation)
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      id: firstContinuation.body.messageID,
      sessionID: "parent",
      role: "user",
    } } } })
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      ...firstContinuation.body.parts[0],
      sessionID: "parent",
      messageID: firstContinuation.body.messageID,
    } } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100))
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)

    client.sessions.get("parent").status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    for (let attempt = 0; attempt < 200 && client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    const parentCalls = client.promptAsyncCalls.filter((call) => call.sessionID === "parent")
    assert.equal(parentCalls.length, 2)
    assert.equal(parentCalls[0].body.messageID, parentCalls[1].body.messageID)
    assert.equal(parentCalls[0].body.parts[0].id, parentCalls[1].body.parts[0].id)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 synthetic continuation 进入 chat.message 时不重复注入 receipt Part", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-no-reinject-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "freeze terminal continuation",
      prompt: "freeze terminal continuation",
      subagent_type: "general",
      permissionOverlay: { "*": "deny" },
      writeScopes: [],
    }, toolContext(target))
    const waiting = await executeTask(hooks, {
      description: "wait while continuation retries",
      prompt: "wait while continuation retries",
      subagent_type: "general",
      permissionOverlay: { "*": "deny" },
      writeScopes: [],
    }, toolContext(target))
    while ([created, waiting].some((task) => client.sessions.get(task.sessionID).metadata.o4e.task.status !== "running")) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    await hooks.event({ event: { type: "question.asked", properties: { info: {
      id: "question-continuation-no-reinject",
      sessionID: waiting.sessionID,
      questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], custom: false }],
    } } } })
    client.messages.set("parent", [{
      info: { id: "assistant-parent-no-reinject", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-no-reinject", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-no-reinject-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-no-reinject-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 3; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    const continuation = client.promptAsyncCalls[2]
    const output = {
      message: { id: continuation.body.messageID },
      parts: structuredClone(continuation.body.parts),
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator", messageID: continuation.body.messageID }, output)
    assert.deepEqual(output.parts, continuation.body.parts)
    assert.equal(output.parts.some((part) => part.metadata?.o4e?.kind === "background-task-receipts"), false)
    assert.equal(output.parts.some((part) => part.metadata?.o4e?.kind === "background-task-requests"), false)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件重载不恢复已由 watch 持久化消费的终态 receipt", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-reload-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "complete before reload",
      prompt: "complete before reload",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-terminal-reload", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-terminal-reload", type: "text", text: "waiting" }],
    }])
    const watching = firstHooks.tool.o4e_task.execute({ action: "watch", taskID: created.taskID, timeoutMs: 100 }, toolContext(target))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-terminal-reload-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-terminal-reload-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    assert.equal(taskResult(await watching).reason, "actionable")
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.promptAsyncCalls.length, 1)
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(receipt.receiptDeliveredToMessageID, "parent-message")
    assert.equal(Number.isSafeInteger(receipt.receiptAcknowledgedAt), true)
    await firstHooks.dispose()

    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const output = { message: { id: "user-after-watch-reload" }, parts: [{ id: "part-after-watch-reload", type: "text", text: "continue" }] }
    await secondHooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    assert.equal(output.parts.some((part) => part.metadata?.o4e?.kind === "background-task-receipts"), false)
    client.sessions.get("parent").status = "idle"
    await secondHooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    assert.equal(client.promptAsyncCalls.length, 1)
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件重载不会重复提交已由 synthetic continuation 投递的终态 receipt", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-terminal-reload-dedup-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const firstHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(firstHooks, {
      description: "complete and continue once",
      prompt: "complete and continue once",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-terminal-reload-dedup", role: "assistant", parentID: "user-parent", finish: "stop" },
      parts: [{ id: "part-parent-terminal-reload-dedup", type: "text", text: "waiting" }],
    }])
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-terminal-reload-dedup-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-terminal-reload-dedup-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await firstHooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    for (let attempt = 0; attempt < 100 && client.promptAsyncCalls.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
    }
    assert.equal(client.promptAsyncCalls.length, 2)
    const delivered = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(delivered.receiptDeliveredToMessageID, client.promptAsyncCalls[1].body.messageID)
    await firstHooks.dispose()

    const secondHooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    assert.equal(client.promptAsyncCalls.length, 2)
    await secondHooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("用户新消息附加未结束 Background Task 的继续跟踪提示", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-continuation-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "continue after user interruption",
      prompt: "continue after user interruption",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const output = { message: { id: "incoming" }, parts: [{ type: "text", text: "现在进度如何？" }] }

    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)

    assert.equal(output.parts[0].text, "现在进度如何？")
    const notice = output.parts.find((part) => part.metadata?.o4e?.kind === "background-task-notice")
    assert.ok(notice)
    assert.equal(notice.synthetic, true)
    assert.match(notice.text, /新的用户消息始终是当前指令/)
    assert.match(notice.text, /不要创建重复 Task/)
    assert.match(notice.text, new RegExp(created.taskID))
    assert.match(notice.text, /o4e_task watch/)
    assert.doesNotMatch(notice.text, /continue after user interruption/)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("用户新消息附加 Background Task 等待交互提示且保留待处理请求", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-request-notice-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "ask target",
      prompt: "ask target",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    await hooks.event({ event: { type: "question.asked", properties: { info: {
      id: "question-1",
      sessionID: created.sessionID,
      questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], custom: false }],
    } } } })

    const output = { message: { id: "incoming" }, parts: [{ type: "text", text: "继续" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    const notice = output.parts.find((part) => part.metadata?.o4e?.kind === "background-task-requests")
    assert.ok(notice)
    assert.equal(notice.synthetic, true)
    assert.ok(notice.text.includes(created.taskID))
    assert.match(notice.text, /question-1/)
    assert.match(notice.text, /Which target\?/)
    const waiting = client.sessions.get(created.sessionID).metadata.o4e.task
    assert.equal(waiting.status, "waiting_question")
    assert.equal(waiting.pendingRequests[0].requestID, "question-1")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("用户新消息附加 Background Task 终态 receipt 且不泄露结果正文", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-receipt-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "produce private result",
      prompt: "produce private result",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-result", type: "text", text: "private result body" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "completed") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const running = await executeTask(hooks, {
      description: "keep running while the user reads the receipt",
      prompt: "keep running while the user reads the receipt",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(running.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }

    const output = { message: { id: "incoming" }, parts: [{ id: "part-incoming", type: "text", text: "what changed?" }] }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    const notice = output.parts.find((part) => part.metadata?.o4e?.kind === "background-task-receipts")
    assert.ok(notice)
    assert.equal(notice.synthetic, true)
    assert.match(notice.text, /receiptID/)
    assert.match(notice.text, new RegExp(created.taskID))
    assert.doesNotMatch(notice.text, /private result body/)
    assert.equal(output.parts.some((part) => part.metadata?.o4e?.kind === "background-task-notice"), true)
    const watching = hooks.tool.o4e_task.execute({ action: "watch", taskID: running.taskID }, toolContext(target))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "incoming", sessionID: "parent", role: "user" } } } })
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: "part-incoming",
      sessionID: "parent",
      messageID: "incoming",
      type: "text",
      text: "what changed?",
    } } } })
    let settled = false
    watching.finally(() => { settled = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)
    for (const part of output.parts.filter((part) => part.id !== "part-incoming" && part.id !== notice.id)) {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        ...part,
        sessionID: "parent",
        messageID: "incoming",
      } } } })
    }
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(settled, false)
    await hooks.event({ event: { type: "message.part.updated", properties: { part: {
      id: notice.id,
      sessionID: "parent",
      messageID: "incoming",
      type: "text",
      text: notice.text,
      synthetic: true,
    } } } })
    assert.equal(taskResult(await watching).reason, "user-message")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("用户消息 receipt delivery 持久化失败时 fail closed 且保留后续重投", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-user-receipt-delivery-failure-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "durable user receipt delivery",
      prompt: "durable user receipt delivery",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-user-receipt-delivery-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-user-receipt-delivery-result", type: "text", text: "private result" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })

    const originalUpdate = client.session.update
    client.session.update = async (request) => {
      const receipts = request.body?.metadata?.o4e?.backgroundTasks?.taskRefs?.[created.taskID]?.receipts
      if (request.path.id === "parent" && receipts?.some((receipt) => receipt.receiptDeliveredToMessageID === "user-receipt-delivery-failed")) {
        return { error: "receipt delivery unavailable" }
      }
      return originalUpdate(request)
    }
    await assert.rejects(
      hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
        message: { id: "user-receipt-delivery-failed" },
        parts: [{ id: "part-user-receipt-delivery-failed", type: "text", text: "first attempt" }],
      }),
      /receipt delivery unavailable/,
    )
    const failedReceipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(failedReceipt.receiptDeliveredToMessageID, undefined)

    client.session.update = originalUpdate
    const retriedOutput = {
      message: { id: "user-receipt-delivery-retry" },
      parts: [{ id: "part-user-receipt-delivery-retry", type: "text", text: "retry" }],
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, retriedOutput)
    assert.equal(retriedOutput.parts.some((part) => part.metadata?.o4e?.kind === "background-task-receipts"), true)
    const retriedReceipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(retriedReceipt.receiptDeliveredToMessageID, "user-receipt-delivery-retry")
    assert.equal(retriedReceipt.receiptAcknowledgedAt, undefined)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("o4e_task output 后下一条用户消息不重复注入 terminal receipt", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-output-receipt-consume-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, status: "busy" })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "consume receipt with output",
      prompt: "consume receipt with output",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-output-consume-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-output-consume-result", type: "text", text: "private result body" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })

    const result = taskResult(await hooks.tool.o4e_task.execute(
      { action: "output", taskID: created.taskID },
      toolContext(target),
    ))
    assert.equal(result.output, "private result body")
    const receipt = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts[0]
    assert.equal(receipt.receiptDeliveredToMessageID, "parent-message")
    assert.equal(Number.isSafeInteger(receipt.receiptAcknowledgedAt), true)

    const output = {
      message: { id: "user-after-output" },
      parts: [{ id: "part-user-after-output", type: "text", text: "what next?" }],
    }
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    assert.equal(output.parts.some((part) => part.metadata?.o4e?.kind === "background-task-receipts"), false)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("父 Session idle 且没有 terminal receipt 时不提交 synthetic continuation", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-auto-continuation-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
      message: { id: "user-parent-1" },
      parts: [{ type: "text", text: "run the background task" }],
    })
    const created = await executeTask(hooks, {
      description: "keep running while parent becomes idle",
      prompt: "keep running while parent becomes idle",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    assert.equal(client.promptAsyncCalls.length, 1)
    client.messages.set("parent", [{
      info: { id: "assistant-parent-1", role: "assistant", parentID: "user-parent-1", finish: "stop" },
      parts: [{ id: "part-parent-1", type: "text", text: "still running" }],
    }])

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("父 Session idle 时不会为等待显式交互的 Background Task 自动循环", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-auto-continuation-waiting-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "wait for a question answer",
      prompt: "wait for a question answer",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    await hooks.event({ event: { type: "question.asked", properties: { info: {
      id: "question-auto-continuation",
      sessionID: created.sessionID,
      questions: [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local" }], custom: false }],
    } } } })
    client.messages.set("parent", [{
      info: { id: "assistant-parent-waiting", role: "assistant", parentID: "user-parent-waiting", finish: "stop" },
      parts: [{ id: "part-parent-waiting", type: "text", text: "Which target?" }],
    }])

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })

    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    client.sessions.get("parent").status = "idle"
    client.messages.get("parent").push({ info: { id: "assistant-wait-reported", role: "assistant", finish: "stop" }, parts: [] })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    assert.equal(client.promptAsyncCalls.filter((call) => call.sessionID === "parent").length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("父 Session idle 自动续接检查期间到达真实用户消息时不提交 synthetic 回合", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-auto-continuation-user-race-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
      message: { id: "user-parent-before-race" },
      parts: [{ type: "text", text: "run tests" }],
    })
    const created = await executeTask(hooks, {
      description: "keep running during a user message race",
      prompt: "keep running during a user message race",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    client.messages.set("parent", [{
      info: { id: "assistant-parent-race", role: "assistant", parentID: "user-parent-before-race", finish: "stop" },
      parts: [{ id: "part-parent-race", type: "text", text: "still running" }],
    }])
    const originalStatus = client.session.status
    let statusCalls = 0
    let racedMessage
    client.session.status = async (...args) => {
      statusCalls += 1
      const result = await originalStatus(...args)
      if (statusCalls === 1) {
        racedMessage = hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, {
          message: { id: "user-parent-during-race" },
          parts: [{ type: "text", text: "what time is it?" }],
        })
      }
      return result
    }

    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
    await racedMessage

    assert.equal(client.promptAsyncCalls.length, 1)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("终态 ledger 丢失并重载后用户消息仍补偿 receipt", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-task-receipt-missing-ledger-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const first = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(first, {
      description: "produce private result",
      prompt: "produce private result",
      subagent_type: "general",
      writeScopes: [],
    }, toolContext(target))
    while (client.sessions.get(created.sessionID).metadata.o4e.task.status !== "running") {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const dispatchMessageID = client.sessions.get(created.sessionID).metadata.o4e.task.dispatchMessageID
    client.messages.set(created.sessionID, [{
      info: { id: "assistant-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
      parts: [{ id: "part-result", type: "text", text: "private result body" }],
    }])
    client.sessions.get(created.sessionID).status = "idle"
    await first.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } })
    while (!client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts?.length) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const receiptID = client.sessions.get("parent").metadata.o4e.backgroundTasks.taskRefs[created.taskID].receipts.at(-1).receiptID
    await first.dispose()
    client.sessions.delete(created.sessionID)

    const second = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const output = { message: { id: "incoming" }, parts: [{ type: "text", text: "what changed?" }] }
    await second["chat.message"]({ sessionID: "parent", agent: "orchestrator" }, output)
    const receiptNotice = output.parts.find((part) => part.metadata?.o4e?.kind === "background-task-receipts")
    const continuationNotice = output.parts.find((part) => part.metadata?.o4e?.kind === "background-task-notice")
    assert.ok(receiptNotice)
    assert.match(receiptNotice.text, new RegExp(receiptID))
    assert.match(receiptNotice.text, /"status": "completed"/)
    assert.match(receiptNotice.text, /"outputAvailable": false/)
    assert.doesNotMatch(receiptNotice.text, /private result body/)
    assert.ok(continuationNotice)
    assert.match(continuationNotice.text, /"status": "unknown"/)
    assert.match(continuationNotice.text, /"phase": "missing-ledger"/)
    await second.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task background=false 同步等待并复用固定 dispatch messageID", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-foreground-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, model: { id: "selected", providerID: "provider", variant: "high" } })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const metadataUpdates = []

    const result = await hooks.tool.task.execute({
      description: "Inspect fixture",
      prompt: "Read the fixture",
      subagent_type: "general",
      background: false,
    }, toolContext(target, metadataUpdates))
    const completed = taskResult(result)

    assert.equal(completed.status, "reported-completed")
    assert.equal(client.promptAsyncCalls.length, 0)
    assert.equal(client.promptCalls.length, 1)
    assert.equal(client.promptCalls[0].body.messageID.startsWith("msg_"), true)
    assert.deepEqual(client.promptCalls[0].body.model, { providerID: "provider", modelID: "selected" })
    assert.equal(client.promptCalls[0].body.variant, "high")
    assert.equal(client.sessions.get(completed.sessionID).metadata.o4e.delegation.dispatchMessageID, client.promptCalls[0].body.messageID)
    assert.equal(metadataUpdates.at(-1).metadata.sessionId, completed.sessionID)
    assert.equal(metadataUpdates.at(-1).metadata.background, undefined)
    assert.equal(result.metadata.sessionId, completed.sessionID)
    assert.equal(result.metadata.background, undefined)
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 task 同步回合期间的宿主状态事件不会使结果失效", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-foreground-events-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target, model: { id: "selected", providerID: "provider", variant: "high" } })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const originalPrompt = client.session.prompt
    const eventOperations = []
    client.session.prompt = async (request) => {
      client.sessions.get(request.path.id).status = "busy"
      eventOperations.push(hooks.event({ event: { type: "session.status", properties: { sessionID: request.path.id, status: { type: "busy" } } } }))
      const result = await originalPrompt(request)
      client.sessions.get(request.path.id).status = "idle"
      eventOperations.push(hooks.event({ event: { type: "session.idle", properties: { sessionID: request.path.id } } }))
      return result
    }

    const result = await hooks.tool.task.execute({
      description: "Inspect fixture",
      prompt: "Read the fixture",
      subagent_type: "general",
      background: false,
    }, toolContext(target))
    const completed = taskResult(result)
    await Promise.all(eventOperations)

    assert.equal(completed.status, "reported-completed")
    assert.equal(completed.output, "completed")
    assert.equal(client.sessions.get(completed.sessionID).metadata.o4e.delegation.status, "reported-completed")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("slash-command subtask fail closed，避免绕过受管 task", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-managed-task-command-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })

    await hooks["command.execute.before"]({ command: "ordinary", sessionID: "parent", arguments: "" }, { parts: [{ type: "text", text: "ok" }] })
    await assert.rejects(
      hooks["command.execute.before"]({ command: "delegate", sessionID: "parent", arguments: "" }, {
        parts: [{ type: "subtask", agent: "general", description: "inspect", prompt: "inspect" }],
      }),
      /禁止绕过受管 task/,
    )
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("tool.execute.before 只为 Background Task 写工具持久化 watermark", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-background-task-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    client.addSession({ id: "ordinary", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "edit fixture",
      prompt: "edit fixture",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))

    await hooks["tool.execute.before"]({ sessionID: created.sessionID, tool: "read", callID: "call-read" }, { args: { filePath: "fixture.txt" } })
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.sideEffectWatermark, undefined)

    await Promise.all([
      hooks["tool.execute.before"]({ sessionID: created.sessionID, tool: "edit", callID: "call-edit" }, { args: { filePath: "fixture.txt" } }),
      hooks["tool.execute.before"]({ sessionID: created.sessionID, tool: "edit", callID: "call-edit" }, { args: { filePath: "fixture.txt" } }),
    ])
    const watermark = client.sessions.get(created.sessionID).metadata.o4e.task.sideEffectWatermark
    assert.equal(watermark.tool, "edit")
    assert.equal(watermark.callID, "call-edit")
    assert.equal(watermark.childSessionID, created.sessionID)

    await hooks["tool.execute.before"]({ sessionID: "ordinary", tool: "edit", callID: "call-ordinary" }, { args: { filePath: "fixture.txt" } })
    assert.deepEqual(client.sessions.get("ordinary").metadata, {})
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("watermark metadata 写失败时 tool.execute.before fail closed", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-background-task-fail-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "edit fixture",
      prompt: "edit fixture",
      subagent_type: "general",
      writeScopes: ["."],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    client.failUpdateSessionID = created.sessionID

    await assert.rejects(hooks["tool.execute.before"](
      { sessionID: created.sessionID, tool: "write", callID: "call-write" },
      { args: { filePath: "fixture.txt" } },
    ), /metadata unavailable/)
    assert.equal(client.sessions.get(created.sessionID).metadata.o4e.task.sideEffectWatermark, undefined)
    // Restore persistence before disposal: last-facade dispose cancels the
    // running child, and that cancellation write must be able to succeed.
    client.failUpdateSessionID = undefined
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("scoped-write 的 apply_patch 越界时在 watermark 前拒绝", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-apply-patch-scope-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const generalPath = join(target, ".o4e", "agents", "subagent", "general.jsonc")
    writeFileSync(generalPath, readFileSync(generalPath, "utf8").replace('"loadTools": null', '"loadTools": ["read", "edit"]'))
    mkdirSync(join(target, "src"))
    const client = new HookClient()
    client.directory = target
    client.addSession({ id: "parent", directory: target })
    const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
    const created = await executeTask(hooks, {
      description: "patch fixture",
      prompt: "patch fixture",
      subagent_type: "general",
      permissionOverlay: { bash: "deny", external_directory: "deny" },
      writeScopes: ["src"],
    }, toolContext(target))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    const child = client.sessions.get(created.sessionID)
    assert.equal(child.metadata.o4e.delegation.effect, "scoped-write")

    await assert.rejects(hooks["tool.execute.before"](
      { sessionID: created.sessionID, tool: "apply_patch", callID: "call-outside" },
      { args: { patchText: "*** Begin Patch\n*** Add File: outside.txt\n+outside\n*** End Patch" } },
    ), /写入路径不在委派 writeScopes 内/)
    assert.equal(child.metadata.o4e.task.sideEffectWatermark, undefined)

    await assert.rejects(hooks["tool.execute.before"](
      { sessionID: created.sessionID, tool: "apply_patch", callID: "call-mixed" },
      { args: { patchText: "*** Begin Patch\n*** Add File: src/inside.txt\n+inside\n*** Delete File: outside.txt\n*** End Patch" } },
    ), /写入路径不在委派 writeScopes 内/)
    assert.equal(child.metadata.o4e.task.sideEffectWatermark, undefined)

    await hooks["tool.execute.before"](
      { sessionID: created.sessionID, tool: "apply_patch", callID: "call-inside" },
      { args: { patchText: "*** Begin Patch\n*** Add File: src/inside.txt\n+inside\n*** End Patch" } },
    )
    const watermark = client.sessions.get(created.sessionID).metadata.o4e.task.sideEffectWatermark
    assert.equal(watermark.tool, "apply_patch")
    assert.equal(watermark.callID, "call-inside")
    await hooks.dispose()
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
