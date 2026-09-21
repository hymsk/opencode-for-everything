import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { resolveNativeAgentName } from "../src/core/native-takeover.mjs"
import { runEventPipeline } from "../src/runtime/event-pipeline.mjs"
import { createRuntimeLifecycle } from "../src/runtime/lifecycle.mjs"
import { createOpenCodeHooks } from "../src/adapters/opencode/plugin-hooks.ts"
import { tool } from "@opencode-ai/plugin"

test("受管 task 是唯一 Agent 委派入口并公开 canonical 参数", async () => {
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  const isolatedConfigHome = mkdtempSync(join(tmpdir(), "o4e-runtime-tools-"))
  try {
    process.env.XDG_CONFIG_HOME = isolatedConfigHome
    const hooks = await createOpenCodeHooks({ client: {}, directory: isolatedConfigHome, worktree: isolatedConfigHome })
    const delegation = hooks.tool.task

    assert.ok(delegation.args.description)
    assert.ok(delegation.args.prompt)
    assert.ok(delegation.args.subagent_type)
    const schema = tool.schema.toJSONSchema(tool.schema.object(delegation.args), { io: "input" })
    assert.deepEqual(schema.required, ["description", "prompt", "subagent_type"])
    assert.equal(schema.properties.subagent_type.type, "string")
    assert.equal(schema.properties.subagent_type.minLength, 1)
    assert.equal(schema.properties.agent, undefined)
    assert.equal(schema.required.includes("background"), false)
    assert.equal(hooks.tool.o4e_delegate, undefined)
    assert.equal(hooks.tool.o4e_delegate_background, undefined)
    assert.ok(hooks.tool.o4e_workflow)
    assert.deepEqual(Object.keys(hooks.tool).toSorted(), ["bash", "o4e_task", "o4e_workflow", "task"])
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    rmSync(isolatedConfigHome, { recursive: true, force: true })
  }
})

test("Bash schema keeps workdir and timeout optional", async () => {
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  const isolatedConfigHome = mkdtempSync(join(tmpdir(), "o4e-runtime-bash-schema-"))
  try {
    process.env.XDG_CONFIG_HOME = isolatedConfigHome
    const hooks = await createOpenCodeHooks({ client: {}, directory: isolatedConfigHome, worktree: isolatedConfigHome })
    const schema = tool.schema.toJSONSchema(tool.schema.object(hooks.tool.bash.args), { io: "input" })
    assert.deepEqual(schema.required, ["command", "description"])
    assert.equal(schema.required.includes("workdir"), false)
    assert.equal(schema.properties.workdir.type, "string")
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    rmSync(isolatedConfigHome, { recursive: true, force: true })
  }
})

test("原生 Agent 名只通过 nativeMode 映射解析", () => {
  const nativeModes = { build: "custom-build", plan: "custom-plan" }

  assert.equal(resolveNativeAgentName("build", nativeModes), "custom-build")
  assert.equal(resolveNativeAgentName("plan", nativeModes), "custom-plan")
  assert.equal(resolveNativeAgentName("orchestrator", nativeModes), "orchestrator")
})

test("event pipeline 未启用 fallback 时只转发 Runtime 事件", async () => {
  const calls = []
  await runEventPipeline({ kind: "deleted", sessionID: "deleted" }, {
    taskObserver: async (event) => calls.push([event.kind, event.sessionID]),
  })
  await runEventPipeline({ kind: "error", sessionID: "failed", error: "retryable" }, {
    taskObserver: async (event) => calls.push([event.kind, event.sessionID, event.error, event.phase]),
  })

  assert.deepEqual(calls, [
    ["deleted", "deleted"],
    ["error", "failed", "retryable", "before-resolution"],
  ])
})

test("dispose 只清理一次、等待异步收尾并阻止后续运行", async () => {
  let clears = 0
  let release
  const lifecycle = createRuntimeLifecycle(async () => {
    await new Promise((resolvePromise) => { release = resolvePromise })
    clears += 1
  })

  assert.equal(lifecycle.isActive(), true)
  const first = lifecycle.dispose()
  const second = lifecycle.dispose()

  assert.equal(lifecycle.isActive(), false)
  assert.equal(typeof release, "function", "disposal must enter runtime quiescence before yielding")
  assert.equal(clears, 0)
  release()
  await first
  await second
  assert.equal(lifecycle.isActive(), false)
  assert.equal(clears, 1)
})

test("dispose 收尾失败时保持 active 并允许重试", async () => {
  let calls = 0
  const lifecycle = createRuntimeLifecycle(async () => {
    calls += 1
    if (calls === 1) throw new Error("persist failed")
  })

  await assert.rejects(lifecycle.dispose(), /persist failed/)
  assert.equal(lifecycle.isActive(), true)
  await lifecycle.dispose()
  assert.equal(lifecycle.isActive(), false)
  assert.equal(calls, 2)
})

test("同一 runtime snapshot 热读 prompt、instruction、reminder 和 soul", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-runtime-architecture-"))
  const configRoot = join(target, ".o4e")
  const promptRoot = join(configRoot, "prompts")
  const writeFresh = (path, content, offset) => {
    writeFileSync(path, content)
    const mtime = new Date(Date.now() + offset * 2000)
    utimesSync(path, mtime, mtime)
  }

  try {
    mkdirSync(join(configRoot, "agents", "primary"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "all"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "subagent"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "system"), { recursive: true })
    mkdirSync(join(promptRoot, "primary", "plan"), { recursive: true })
    writeFileSync(join(configRoot, "config.json"), JSON.stringify({
      promptsDir: "prompts",
      nativeAgents: { build: "keep", plan: "keep", general: "keep", explore: "keep" },
      instructionFiles: { global: [], project: ["AGENTS.md"] },
      soul: { globalFile: join(target, "missing-global-soul.md") },
    }))
    writeFileSync(join(configRoot, "agents", "primary", "fixture-agent.json"), JSON.stringify({
      name: "fixture-agent",
      description: "fixture-agent",
      plan: { mode: "child" },
      systemPrompt: "fixture-system",
      messagePrompt: "message-prompt",
    }))
    writeFresh(join(promptRoot, "fixture-system.md"), "first system", 1)
    writeFresh(join(promptRoot, "message-prompt.md"), "first message", 2)
    writeFresh(join(promptRoot, "primary", "plan", "reminder.md"), "# Plan Mode - System Reminder\nfirst reminder", 3)
    writeFresh(join(target, "AGENTS.md"), "first instruction", 4)
    writeFresh(join(configRoot, "soul.md"), "first soul", 5)

    const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
    const firstSystem = { system: ["<!--opencode-for-everything-agent:fixture-agent-->\nnative"] }
    await hooks["experimental.chat.system.transform"]({}, firstSystem)
    assert.match(firstSystem.system[0], /first system/)
    assert.match(firstSystem.system[0], /first instruction/)
    assert.match(firstSystem.system[0], /first soul/)

    const firstMessage = { message: { id: "first" }, parts: [{ type: "text", text: "user" }] }
    await hooks["chat.message"]({ sessionID: "first", agent: "fixture-agent (plan)", model: {} }, firstMessage)
    assert.match(firstMessage.parts[1].text, /first message/)
    assert.match(firstMessage.parts[2].text, /first reminder/)

    writeFresh(join(promptRoot, "fixture-system.md"), "updated system content", 6)
    writeFresh(join(promptRoot, "message-prompt.md"), "updated message content", 7)
    writeFresh(join(promptRoot, "primary", "plan", "reminder.md"), "# Plan Mode - System Reminder\nupdated reminder content", 8)
    writeFresh(join(target, "AGENTS.md"), "updated instruction content", 9)
    writeFresh(join(configRoot, "soul.md"), "updated soul content", 10)

    const updatedSystem = { system: ["<!--opencode-for-everything-agent:fixture-agent-->\nnative"] }
    await hooks["experimental.chat.system.transform"]({}, updatedSystem)
    assert.match(updatedSystem.system[0], /updated system content/)
    assert.match(updatedSystem.system[0], /updated instruction content/)
    assert.match(updatedSystem.system[0], /updated soul content/)
    assert.doesNotMatch(updatedSystem.system[0], /first system|first instruction|first soul/)

    const updatedMessage = { message: { id: "updated" }, parts: [{ type: "text", text: "user" }] }
    await hooks["chat.message"]({ sessionID: "updated", agent: "fixture-agent (plan)", model: {} }, updatedMessage)
    assert.match(updatedMessage.parts[1].text, /updated message content/)
    assert.match(updatedMessage.parts[2].text, /updated reminder content/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("运行时应用 config agentDefaults", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-runtime-agent-defaults-"))
  const configRoot = join(target, ".o4e")
  const promptRoot = join(configRoot, "custom", "prompts")
  try {
    mkdirSync(join(configRoot, "agents", "primary"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "all"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "subagent"), { recursive: true })
    mkdirSync(join(configRoot, "agents", "system"), { recursive: true })
    mkdirSync(promptRoot, { recursive: true })
    writeFileSync(join(configRoot, "config.json"), JSON.stringify({
      agentDefaults: { systemPrompt: "shared-default", promptDir: "custom\\prompts" },
      nativeAgents: { build: "keep", plan: "keep", general: "keep", explore: "keep" },
      soul: { enabled: false },
    }))
    writeFileSync(join(configRoot, "agents", "primary", "fixture-agent.json"), JSON.stringify({
      name: "fixture-agent",
      description: "fixture-agent",
    }))
    writeFileSync(join(promptRoot, "shared-default.md"), "runtime agent defaults prompt")

    const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
    const output = { system: ["<!--opencode-for-everything-agent:fixture-agent-->\nnative"] }
    await hooks["experimental.chat.system.transform"]({}, output)

    assert.match(output.system[0], /runtime agent defaults prompt/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("运行时不读取 project 子目录中的配置根", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-runtime-config-root-"))
  const configRoot = join(target, "project", ".o4e")
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  try {
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(join(configRoot, "config.json"), "{}\n")
    process.env.XDG_CONFIG_HOME = join(target, "empty-global-config")

    const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
    const config = { agent: {} }
    await hooks.config(config)

    assert.deepEqual(config.agent, {})
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    rmSync(target, { recursive: true, force: true })
  }
})
