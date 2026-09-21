import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { homedir } from "node:os"
import test from "node:test"
import { copyInstalledDefaults, readConfigJson, resolveConfigPath, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"
import { resolveO4eConfigRoot, resolveO4eMode } from "../src/adapters/opencode/plugin-hooks.ts"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("o4e_mode 仅接受 default、origin 或 clear，未设置时默认启用", () => {
  assert.equal(resolveO4eMode({}), "default")
  assert.equal(resolveO4eMode({ o4e_mode: "default" }), "default")
  assert.equal(resolveO4eMode({ o4e_mode: "origin" }), "origin")
  assert.equal(resolveO4eMode({ o4e_mode: "clear" }), "clear")
  for (const value of ["", "DEFAULT", "disabled", " ", "1"]) {
    assert.throws(() => resolveO4eMode({ o4e_mode: value }), /O4E_MODE_INVALID/)
  }
})

test("o4e_config 拒绝空值、相对路径和 NUL", () => {
  for (const value of ["", "profile/.o4e", "~/ok\0bad"]) {
    assert.throws(() => resolveO4eConfigRoot({ o4e_config: value }), /O4E_CONFIG_INVALID/)
  }
})

test("o4e_mode=origin 时插件不初始化受管 hooks", async () => {
  const previous = process.env.o4e_mode
  try {
    process.env.o4e_mode = "origin"
    const target = mkdtempSync(join(tmpdir(), "o4e-disabled-"))
    try {
      mkdirSync(join(target, ".opencode", "agents"), { recursive: true })
      writeFileSync(join(target, ".opencode", "agents", "chat.md"), "<!--opencode-for-everything-agent:chat-->\n")
      const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target })
      const config = { default_agent: "chat", agent: { chat: {}, embedded: { prompt: "<!--opencode-for-everything-system-agent:title-->" }, native: {} } }
      await hooks.config(config)
      assert.deepEqual(config.agent, { native: {} })
      assert.equal(config.default_agent, undefined)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  } finally {
    if (previous === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previous
  }
})

test("origin 模式清理自定义配置档案旁的 Agent 投影，显式缺失根拒绝启动", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-disabled-profile-"))
  const profileRoot = join(target, "profile", ".o4e")
  const previousMode = process.env.o4e_mode
  const previousConfig = process.env.o4e_config
  try {
    mkdirSync(join(dirname(profileRoot), "agents"), { recursive: true })
    writeFileSync(join(dirname(profileRoot), "agents", "custom.md"), "<!--opencode-for-everything-agent:custom-->\n")
    process.env.o4e_mode = "origin"
    process.env.o4e_config = profileRoot
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target })
    const config = { agent: { custom: {} } }
    await hooks.config(config)
    assert.deepEqual(config.agent, {})

    process.env.o4e_mode = "default"
    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target }),
      /O4E_CONFIG_NOT_FOUND/,
    )
  } finally {
    if (previousMode === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previousMode
    if (previousConfig === undefined) delete process.env.o4e_config
    else process.env.o4e_config = previousConfig
    rmSync(target, { recursive: true, force: true })
  }
})

test("clear 模式保留 O4E 投影但清除本次运行时模型选择", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-clear-model-"))
  const previousMode = process.env.o4e_mode
  try {
    copyInstalledDefaults(componentRoot, target)
    const sourcePath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const source = readConfigJson(join(target, ".o4e"), "config.json")
    source.defaultModel = { id: "configured/model", variant: "high" }
    source.fallbackModels = ["configured/fallback"]
    writeConfigJson(sourcePath, source)
    const before = readFileSync(sourcePath, "utf8")
    process.env.o4e_mode = "clear"
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      model: "host/saved",
      variant: "high",
      agent: {
        host: { model: "host/custom", variant: "low", prompt: "host prompt" },
      },
    }
    await hooks.config(config)
    assert.equal(config.model, undefined)
    assert.equal(config.variant, undefined)
    assert.equal(config.agent.host.model, undefined)
    assert.equal(config.agent.host.variant, undefined)
    assert.equal(config.agent.host.prompt, "host prompt")
    assert.ok(config.agent.orchestrator)
    assert.equal(config.agent.orchestrator.model, undefined)
    assert.equal(readFileSync(sourcePath, "utf8"), before)
    await hooks.dispose()
  } finally {
    if (previousMode === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previousMode
    rmSync(target, { recursive: true, force: true })
  }
})

test("显式 o4e_config 切换配置根并在实例内冻结，支持 -s 新进程重读", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-env-config-"))
  const selected = join(target, "selected")
  const previousMode = process.env.o4e_mode
  const previousConfig = process.env.o4e_config
  try {
    copyInstalledDefaults(componentRoot, selected)
    const configPath = resolveConfigPath(join(selected, ".o4e"), "config.json")
    const config = readConfigJson(join(selected, ".o4e"), "config.json")
    config.mcp = { selectedmarker: { type: "local", command: ["selected"] } }
    writeConfigJson(configPath, config)
    mkdirSync(join(target, ".o4e"))
    writeFileSync(join(target, ".o4e", "config.json"), "{ invalid")
    process.env.o4e_mode = "default"
    process.env.o4e_config = join(selected, ".o4e")
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    process.env.o4e_config = join(target, "other")
    const hostConfig = { agent: {} }
    await hooks.config(hostConfig)
    assert.deepEqual(hostConfig.mcp.selectedmarker, { type: "local", command: ["selected"] })
    assert.equal(resolveO4eConfigRoot({ o4e_config: "~/profile/.o4e" }), join(homedir(), "profile/.o4e"))
  } finally {
    if (previousMode === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previousMode
    if (previousConfig === undefined) delete process.env.o4e_config
    else process.env.o4e_config = previousConfig
    rmSync(target, { recursive: true, force: true })
  }
})
