import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { copyInstalledDefaults, readConfigJson, writeConfigJson, resolveConfigPath } from "./helpers/o4e-fixture.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"
import { latestUserPromptContext } from "../src/adapters/opencode/message-model.mjs"

const root = resolve(import.meta.dirname, "..")
const model = { providerID: "provider", modelID: "selected" }
const retryable = (sessionID) => ({ event: { type: "session.error", properties: { sessionID, error: { name: "APIError", data: { isRetryable: true } } } } })

async function fixture(t, { client = {}, keepNative = false, configuredModel = false, disableFallback = false } = {}) {
  const target = mkdtempSync(join(tmpdir(), "o4e-model-authority-"))
  t.after(() => rmSync(target, { recursive: true, force: true }))
  copyInstalledDefaults(root, target)
  if (configuredModel) {
    const configRoot = join(target, ".o4e")
    const config = readConfigJson(configRoot, "config.json")
    config.defaultModel = { id: "provider/default", variant: "high" }
    config.fallbackModels = ["provider/fallback"]
    writeConfigJson(resolveConfigPath(configRoot, "config.json"), config)
    const agentRoot = join(configRoot, "agents/all")
    const agent = readConfigJson(agentRoot, "orchestrator.json")
    if (disableFallback) agent.fallbackModels = []
    else delete agent.fallbackModels
    writeConfigJson(resolveConfigPath(agentRoot, "orchestrator.json"), agent)
  }
  if (keepNative) {
    for (const [type, name] of [["primary", "build"], ["primary", "plan"], ["subagent", "general"], ["subagent", "explore"]]) {
      rmSync(join(target, `.o4e/agents/${type}/${name}.jsonc`), { force: true })
    }
    const { readFileSync, writeFileSync } = await import("node:fs")
    const path = join(target, ".o4e", "config.jsonc")
    writeFileSync(path, readFileSync(path, "utf8").replace(
      '{"build":"managed","plan":"managed","general":"managed","explore":"managed"}',
      '{"build":"keep","plan":"keep","general":"keep","explore":"keep"}',
    ))
  }
  const hooks = await OpenCodeForEverythingPlugin({ client, directory: target, worktree: target })
  t.after(() => hooks.dispose())
  return hooks
}

for (const shape of ["top-level", "nested"]) {
  test(`主消息保留宿主显式模型及 variant（${shape} variant）`, async (t) => {
    const hooks = await fixture(t)
    const message = { id: "user-1", agent: "orchestrator", model: { providerID: "host", modelID: "saved" } }
    if (shape === "nested") message.model.variant = "xhigh"
    else message.variant = "xhigh"
    const original = structuredClone(message)
    await hooks["chat.message"]({ sessionID: "parent", model: message.model, variant: "xhigh" }, { message, parts: [] })
    assert.deepEqual(message, original)
  })
}

test("没有 O4E 模型配置时 default 保留宿主模型选择", async (t) => {
  const hooks = await fixture(t)
  const config = {
    model: "host/saved",
    variant: "xhigh",
    agent: { host: { model: "host/custom", variant: "low", prompt: "host prompt" } },
  }
  await hooks.config(config)
  assert.equal(config.model, "host/saved")
  assert.equal(config.variant, "xhigh")
  assert.deepEqual(config.agent.host, { model: "host/custom", variant: "low", prompt: "host prompt" })
  for (const name of ["orchestrator", "orchestrator (plan)"]) {
    assert.equal(Object.hasOwn(config.agent[name], "model"), false)
    assert.equal(Object.hasOwn(config.agent[name], "variant"), false)
  }
})

test("default 投影配置模型到普通及 Plan Agent，但消息保留显式宿主选择", async (t) => {
  const hooks = await fixture(t, { configuredModel: true })
  // Built-in providers need not appear in config.provider.models.
  const config = { model: "host/saved", agent: {} }
  await hooks.config(config)
  for (const name of ["orchestrator", "orchestrator (plan)", "chat (plan)", "architect", "architect (plan)", "researcher (plan)"]) {
    assert.equal(config.agent[name].model, "provider/default")
    assert.equal(config.agent[name].variant, "high")
  }
  assert.equal(config.model, "host/saved")
  const message = { id: "manual", agent: "orchestrator", model: { providerID: "host", modelID: "manual" }, variant: "low" }
  const original = structuredClone(message)
  await hooks["chat.message"]({ sessionID: "manual", agent: "orchestrator" }, { message, parts: [] })
  assert.deepEqual(message, original)
})

test("default 与 clear 都不在模型错误后自动 fallback", async (t) => {
  const previous = process.env.o4e_mode
  try {
    for (const mode of ["default", "clear"]) {
      process.env.o4e_mode = mode
      const retries = []
      const hooks = await fixture(t, { configuredModel: true, client: { session: { promptAsync: async (request) => { retries.push(request); return {} } } } })
      const config = { agent: {}, provider: { provider: { models: { default: {}, fallback: {} } } } }
      await hooks.config(config)
      const message = { id: "failed", agent: "orchestrator", model: { providerID: "provider", modelID: "default" }, variant: "high" }
      await hooks["chat.message"]({ sessionID: mode, agent: "orchestrator" }, { message, parts: [] })
      await hooks.event(retryable(mode))
      assert.equal(retries.length, 0)
      if (mode === "clear") assert.equal(config.agent.orchestrator.model, undefined)
    }
  } finally {
    if (previous === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previous
  }
})

test("主消息未选择 variant 时不注入 variant", async (t) => {
  const hooks = await fixture(t)
  const message = { id: "no-variant", agent: "orchestrator", model: { ...model } }
  const original = structuredClone(message)
  await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator", model }, { message, parts: [] })
  assert.deepEqual(message, original)
})

test("显式空 fallback 不因手动模型或 variant 变化而回到角色默认值", async (t) => {
  const retries = []
  const hooks = await fixture(t, { configuredModel: true, disableFallback: true,
    client: { session: { promptAsync: async (request) => { retries.push(request); return {} } } } })
  await hooks.config({ agent: {} })
  for (const [modelID, variant] of [["manual", "low"], ["default", "low"], ["default", undefined]]) {
    const sessionID = `${modelID}-${variant}`
    const message = { id: sessionID, agent: "orchestrator", model: { providerID: "provider", modelID }, ...(variant ? { variant } : {}) }
    const original = structuredClone(message)
    await hooks["chat.message"]({ sessionID, agent: "orchestrator" }, { message, parts: [] })
    await hooks.event(retryable(sessionID))
    assert.deepEqual(message, original)
  }
  assert.deepEqual(retries, [])
})

test("手动模型错误也不自动使用显式 fallback", async (t) => {
  const retries = []
  const hooks = await fixture(t, { configuredModel: true,
    client: { session: { promptAsync: async (request) => { retries.push(request); return {} } } } })
  await hooks.config({ agent: {} })
  const message = { id: "manual-fallback", agent: "orchestrator", model: { providerID: "host", modelID: "manual" }, variant: "low" }
  await hooks["chat.message"]({ sessionID: "manual-fallback", agent: "orchestrator" }, { message, parts: [] })
  await hooks.event(retryable("manual-fallback"))
  assert.equal(retries.length, 0)
})

test("native keep 和 managed build/plan 均保留宿主选择", async (t) => {
  const kept = await fixture(t, { keepNative: true })
  const managed = await fixture(t)
  for (const agent of ["build", "plan"]) {
    const message = { id: agent, agent, model: { providerID: "host", modelID: "saved", variant: "xhigh" } }
    const original = structuredClone(message)
    await kept["chat.message"]({ sessionID: agent, agent }, { message, parts: [] })
    assert.deepEqual(message, original)
    await managed["chat.message"]({ sessionID: agent, agent }, { message, parts: [] })
    assert.deepEqual(message, original)
  }
})

test("受管子 Session 保留 Runtime 冻结的消息模型", async (t) => {
  const hooks = await fixture(t, { client: { session: {
    get: async ({ path }) => ({ data: { id: path.id, parentID: "parent", metadata: {} } }),
  } } })
  const message = { id: "child-message", agent: "orchestrator", model: { providerID: "provider", modelID: "selected", variant: "low" } }
  const original = structuredClone(message)
  await hooks["chat.message"]({ sessionID: "child", agent: "orchestrator", model: message.model }, { message, parts: [] })
  assert.deepEqual(message, original)
})

test("自动续接与重载上下文保留实际消息模型和 variant", async (t) => {
  const hooks = await fixture(t)
  const context = latestUserPromptContext([
    { info: { role: "user", agent: "orchestrator", model: { ...model, variant: "high" } } },
    { info: { role: "user", agent: "orchestrator", model: { providerID: "provider", modelID: "selected", variant: "low" } } },
    { info: { role: "assistant" } },
  ])
  assert.deepEqual(context, { agent: "orchestrator", model, variant: "low" })
  const message = { id: "continuation", agent: context.agent, model: { ...context.model, variant: context.variant } }
  const parts = [{ type: "text", synthetic: true, metadata: { o4e: { producer: "opencode-for-everything", version: 1, kind: "background-task-continuation" } } }]
  await hooks["chat.message"]({ sessionID: "parent", ...context }, { message, parts })
  assert.deepEqual(message.model, { ...model, variant: "low" })
})

test("单一宿主选择没有组件级 fallback 候选", async (t) => {
  const retries = []
  const hooks = await fixture(t, { client: { session: { promptAsync: async (request) => { retries.push(request); return {} } } } })
  const message = { id: "selected", agent: "orchestrator", model: { ...model, variant: "high" } }
  await hooks["chat.message"]({ sessionID: "parent", agent: "orchestrator", model, variant: "high" }, { message, parts: [] })
  await hooks.event(retryable("parent"))
  assert.deepEqual(retries, [])
})
