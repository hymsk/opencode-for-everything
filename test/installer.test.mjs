import assert from "node:assert/strict"
import { chmodSync, cpSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { stripJsonComments } from "../src/jsonc.mjs"
import { loadRuntimeDefinition } from "../src/runtime-builder.mjs"
import { WorkflowRuntime } from "../src/runtime/workflow-runtime.mjs"
import { createModelCatalogLoader, loadAvailableModels, materializeModelConfig, parseOpenCodeModels, defaultAgentSelectionGroups, defaultSkillNames, generateSilentConfig, isSafeArchiveEntryPath, nativePolicyStrategies, resolveNativeInstallOptions, resolveSkillSelection, shouldConfigureNativeAgents, tarOutputLines } from "../scripts/installer.mjs"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"
import { createDanglingDirectoryLink, createDirectoryLink, createFileLink, removeLink } from "./helpers/fs-link-fixture.mjs"
import { installerTestEnv } from "./helpers/installer-cli-fixture.mjs"
import { pathToFileURL } from "node:url"
import { writeConfig } from "../scripts/installer.mjs"

const INSTALLER = join(import.meta.dirname, "..", "scripts", "installer.mjs")

test("模型配置物化保留 all、by-type、per-agent 和当前宿主模型选择", () => {
  const selectedAgents = [{ id: "chat", type: "primary" }, { id: "orchestrator", type: "all" }, { id: "tester", type: "subagent" }]
  assert.deepEqual(materializeModelConfig({ all: { id: "p/default", variant: "high" }, selectedAgents }), {
    defaultModel: { id: "p/default", variant: "high" }, agents: {},
  })
  assert.deepEqual(materializeModelConfig({ mode: "by-type", selectedAgents, byType: { primary: { id: "p/chat" }, subagent: { id: "p/test", variant: "low" } } }).agents, {
    chat: { model: "p/chat" }, orchestrator: {}, tester: { model: "p/test", variant: "low" },
  })
  assert.deepEqual(materializeModelConfig({ mode: "per-agent", selectedAgents, perAgent: { orchestrator: { id: "p/main", variant: "high" } } }).agents, {
    chat: {}, orchestrator: { model: "p/main", variant: "high" }, tester: {},
  })
  assert.deepEqual(materializeModelConfig({ all: null }), { defaultModel: null, agents: {} })
  assert.throws(() => materializeModelConfig({ mode: "invalid" }), /Unknown model/)
})

test("模型 catalog 解析 ANSI、metadata、重复与畸形条目", () => {
  const entry = '\u001b[32mp/model\u001b[0m\n{"name":"Model {x}","providerID":"p","limit":{"context":123},"capabilities":{"reasoning":true},"variants":{"low":{},"high":{}}}\n'
  assert.deepEqual(parseOpenCodeModels(`noise\np/bad\n{bad}\n${entry}${entry}p/empty\n{}\n`), [
    { id: "p/model", name: "Model {x}", provider: "p", context: 123, reasoning: true, variants: ["low", "high"] },
    { id: "p/empty", name: "empty", provider: "p", context: undefined, reasoning: false, variants: [] },
  ])
})

test("模型 catalog 在目标目录异步发现并在 CLI 失败时读取 provider", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-model-catalog-"))
  try {
    const binaryPath = join(target, "opencode")
    writeFileSync(binaryPath, "fixture")
    const models = await loadAvailableModels({ binaryPath, cwd: target, configRoot: target, execute: async (binary, args, options) => {
      assert.equal(binary, binaryPath)
      assert.deepEqual(args, ["models", "--verbose", "--pure"])
      assert.equal(options.cwd, target)
      return { stdout: 'opencode/free\n{"variants":{"high":{}}}\n' }
    } })
    assert.equal(models[0].id, "opencode/free")
    assert.deepEqual(models[0].variants, ["high"])
    writeFileSync(join(target, "opencode.jsonc"), '{"provider":{"p":{"models":{"local":{"name":"Local","variants":{"max":{}}}}}}}')
    const fallback = await loadAvailableModels({ binaryPath, configRoot: target, execute: async () => { throw new Error("unavailable") } })
    assert.equal(fallback[0].id, "p/local")
    assert.deepEqual(fallback[0].variants, ["max"])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("模型 catalog 预加载复用同目录任务并重试空结果和异常", async () => {
  let calls = 0
  const loader = createModelCatalogLoader(async () => {
    calls += 1
    if (calls === 1) throw new Error("unavailable")
    return calls === 2 ? [] : [{ id: "p/model" }]
  })
  const cwd = join(tmpdir(), "o4e-catalog-cache")
  const first = loader.prefetch(cwd)
  assert.equal(first, loader.prefetch(cwd))
  assert.equal(first.pending, true)
  assert.deepEqual(await first.promise, [])
  assert.equal(first.pending, false)
  assert.deepEqual(await loader.prefetch(cwd).promise, [])
  const loaded = loader.prefetch(cwd)
  assert.deepEqual(await loaded.promise, [{ id: "p/model" }])
  assert.equal(loaded, loader.prefetch(cwd))
  const other = loader.prefetch(join(cwd, "other"))
  assert.notEqual(other, loaded)
  await other.promise
})

test("安装模型配置持久化且保留 Plan defaultAgent 与 Chat 隔离", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-model-install-"))
  try {
    const config = generateSilentConfig("en", true)
    config.defaultModel = { id: "p/default", variant: "high" }
    config.fallbackModels = [{ id: "p/fallback" }]
    config.agents.orchestrator.model = "p/main"
    config.agents.orchestrator.variant = "low"
    config.agents.orchestrator.fallbackModels = [{ id: "p/backup", variant: "high" }]
    config.agents.chat.model = { id: "p/chat", variant: "max" }
    const result = writeConfig(target, config)
    assert.equal(result.success, true, result.error)
    const root = join(target, ".o4e")
    const installed = readJsonc(join(root, "config.jsonc"))
    assert.deepEqual(installed.defaultModel, config.defaultModel)
    assert.deepEqual(installed.fallbackModels, config.fallbackModels)
    assert.equal(installed.defaultAgent, "orchestrator")
    const main = readJsonc(join(root, "agents/all/orchestrator.jsonc"))
    assert.deepEqual(main.model, { id: "p/main", variant: "low" })
    assert.deepEqual(main.fallbackModels, config.agents.orchestrator.fallbackModels)
    const chat = readJsonc(join(root, "agents/primary/chat.jsonc"))
    assert.deepEqual(chat.model, config.agents.chat.model)
    assert.equal(chat.plan.mode, "self")
    assert.equal(chat.plan.reminder, "primary/chat/reminder")
    assert.deepEqual(chat.loadTools, [])
    assert.deepEqual(chat.loadMcp, {})
    assert.equal(existsSync(join(target, ".opencode/agents/chat.md")), false)
    assert.equal(existsSync(join(target, ".opencode/agents/chat (plan).md")), true)
    const before = readFileSync(join(root, "config.jsonc"), "utf8")
    assert.equal(writeConfig(target, generateSilentConfig("en", true)).success, false)
    assert.equal(readFileSync(join(root, "config.jsonc"), "utf8"), before)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

function readJsonc(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf-8")))
}

function runInstaller(args = [], env = {}) {
  const childEnv = installerTestEnv()
  for (const [name, value] of Object.entries(env)) {
    const existing = Object.keys(childEnv).find((key) => key.toLowerCase() === name.toLowerCase())
    if (existing) delete childEnv[existing]
    childEnv[name] = value
  }
  if (env.HOME && !env.USERPROFILE) childEnv.USERPROFILE = env.HOME
  try {
    const result = execFileSync(process.execPath, [INSTALLER, ...args], {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    })
    return { success: true, output: result }
  } catch (error) {
    // 合并 stdout 和 stderr
    const output = (error.stdout || "") + (error.stderr || "")
    return { success: false, output }
  }
}

function localTarArchive(path) {
  return { cwd: dirname(path), argument: `./${basename(path)}` }
}

function tarCommand() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  return process.platform === "win32" && systemRoot ? join(systemRoot, "System32", "tar.exe") : "tar"
}

function runInstall(args = [], env = {}) {
  return runInstaller(["install", ...args], env)
}

test("交互卸载默认保留自定义配置，显式删除与最终取消仍有效", async (t) => {
  // Run the real CLI and filesystem removal; only replace terminal prompts and TTY detection.
  const prompts = `
    import assert from "node:assert/strict";
    let selections = 0, confirmations = 0;
    export async function select(options) {
      selections++;
      assert.ok(options.options.some(item => item.value === options.initialValue));
      return options.initialValue;
    }
    export async function confirm(options) {
      confirmations++;
      if (confirmations === 1 && process.env.O4E_TEST_UNINSTALL_CHOICE !== "default") return false;
      if (confirmations === 2 && process.env.O4E_TEST_UNINSTALL_CHOICE === "cancel") return false;
      return options.initialValue;
    }
    export const isCancel = () => false;
    export const intro = () => {}, outro = () => {}, cancel = () => {};
    export const log = { message() {} };
    export const spinner = () => ({ start() {}, stop() {} });
    process.on("exit", () => {
      assert.equal(selections, 2);
      assert.equal(confirmations, 2);
    });
  `
  const promptsURL = `data:text/javascript,${encodeURIComponent(prompts)}`
  const loader = `export function resolve(specifier, context, nextResolve) {
    return specifier === "@clack/prompts"
      ? { url: ${JSON.stringify(promptsURL)}, shortCircuit: true }
      : nextResolve(specifier, context);
  }`
  const preload = `
    import { register } from "node:module";
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
  `
  for (const choice of ["default", "delete", "cancel"]) await t.test(choice, () => {
    const root = mkdtempSync(join(tmpdir(), "o4e-uninstall-interactive-"))
    const target = join(root, "project")
    const home = join(root, "home")
    mkdirSync(target)
    mkdirSync(home)
    try {
      const install = runInstall(["--no-tui", "--target", target])
      assert.equal(install.success, true, install.output)
      const configPath = join(target, ".o4e", "config.jsonc")
      const customConfig = `${readFileSync(configPath, "utf8")}\n// owner customization\n`
      writeFileSync(configPath, customConfig)
      const customSoul = "Owner-authored soul\n"
      writeFileSync(join(target, ".o4e", "soul.md"), customSoul)
      writeFileSync(join(target, "owner.txt"), "project owner file")
      const runtimePath = join(target, ".opencode", "agents", "orchestrator.md")
      assert.equal(existsSync(runtimePath), true)
      execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, INSTALLER, "uninstall"], {
        cwd: target, encoding: "utf8", timeout: 30000,
        env: { ...installerTestEnv(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), O4E_TEST_UNINSTALL_CHOICE: choice },
      })
      assert.equal(existsSync(runtimePath), choice === "cancel")
      assert.equal(readFileSync(join(target, "owner.txt"), "utf8"), "project owner file")
      if (choice === "delete") assert.equal(existsSync(join(target, ".o4e")), false)
      else {
        assert.equal(readFileSync(configPath, "utf8"), customConfig)
        assert.equal(readFileSync(join(target, ".o4e", "soul.md"), "utf8"), customSoul)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("静默模式 - 默认配置", async () => {
  const target = join(tmpdir(), `o4e-install-test-${Date.now()}`)
  mkdirSync(target, { recursive: true })

  try {
    const result = runInstall(["--no-tui", "--target", target])
    assert.equal(result.success, true)
    assert.match(result.output, /Installation complete/)

    // 检查配置目录
    assert.equal(existsSync(join(target, ".o4e")), true)
    assert.equal(existsSync(join(target, ".o4e", "config.jsonc")), true)
    assert.equal(existsSync(join(target, ".o4e", "schemas", "config.schema.json")), true)
    assert.equal(existsSync(join(target, ".o4e", "agents", "default.jsonc")), false)

    // 检查 agent 配置
    assert.equal(existsSync(join(target, ".o4e", "agents", "primary", "build.jsonc")), false)
    assert.equal(existsSync(join(target, ".o4e", "agents", "primary", "plan.jsonc")), false)
    assert.equal(existsSync(join(target, ".o4e", "agents", "all", "orchestrator.jsonc")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "orchestrator (plan).md")), true)
    assert.equal(existsSync(join(target, ".o4e", "agents", "primary", "chat.jsonc")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "chat (plan).md")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "chat.md")), false)
    for (const name of ["architect", "reviewer", "researcher", "debugger", "tester"]) {
      assert.equal(existsSync(join(target, ".o4e", "agents", "all", `${name}.jsonc`)), false)
      assert.equal(existsSync(join(target, ".o4e", "agents", "subagent", `${name}.jsonc`)), true)
    }
    for (const name of ["architect", "architect (plan)", "reviewer (plan)", "researcher (plan)", "debugger", "tester"]) {
      assert.equal(existsSync(join(target, ".opencode", "agents", `${name}.md`)), true)
    }
    for (const name of ["reviewer", "researcher"]) assert.equal(existsSync(join(target, ".opencode", "agents", `${name}.md`)), false)
    assert.equal(existsSync(join(target, ".o4e", "agents", "subagent", "general.jsonc")), false)
    assert.equal(existsSync(join(target, ".o4e", "agents", "subagent", "explore.jsonc")), false)

    // 检查系统阶段配置
    assert.equal(existsSync(join(target, ".o4e", "agents", "system", "compaction.jsonc")), true)
    assert.equal(existsSync(join(target, ".o4e", "agents", "system", "title.jsonc")), true)
    assert.equal(existsSync(join(target, ".o4e", "agents", "system", "summary.jsonc")), true)

    // 检查 SOUL.md 存在（默认启用）
    assert.equal(existsSync(join(target, ".o4e", "soul.md")), true)
    assert.equal(existsSync(join(target, ".o4e", "soul.zh.md")), false)
    assert.equal(existsSync(join(target, ".o4e", "soul.en.md")), false)
    assert.equal(readFileSync(join(target, ".o4e", "soul.md"), "utf8"),
      readFileSync(join(import.meta.dirname, "..", "defaults", ".o4e", "soul.en.md"), "utf8"))
    assert.deepEqual(readdirSync(target).sort(), [".o4e", ".opencode"])
    for (const name of defaultSkillNames()) {
      assert.match(readFileSync(join(target, ".o4e", "skills", name, "SKILL.md"), "utf8"), new RegExp(`name: ${name}`))
    }
    assert.equal(existsSync(join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")), false)

    // 检查配置内容
    const config = readJsonc(join(target, ".o4e", "config.jsonc"))
    assert.equal(config.defaultAgent, "orchestrator")
    assert.equal(config.defaultModel, null)
    assert.deepEqual(config.fallbackModels, [])
    assert.deepEqual(config.nativeAgents, { build: "disable", plan: "disable", general: "disable", explore: "disable" })
    assert.equal(config.language, "en")
    assert.deepEqual(config.instructionFiles, { global: ["<default>"], project: ["<default>"] })
    assert.deepEqual(config.loadSkills, ["*"])
    assert.equal(config.loadTools, null)
    assert.deepEqual(config.mcp, {})
    assert.deepEqual(config.loadMcp, { "*": ["*"] })
    assert.deepEqual(config.permission, { external_directory: "allow" })
    assert.deepEqual(config.soul, { enabled: true, file: "soul.md", inheritMode: "override" })
    assert.equal(config.agentsDir, "agents")
    assert.equal(config.promptsDir, "prompts")
    assert.equal(existsSync(join(target, ".o4e", "prompts", "cn")), false)
    assert.equal(existsSync(join(target, ".o4e", "prompts", "en")), false)
    assert.equal(existsSync(join(target, ".o4e", "prompts", "all", "orchestrator", "system.md")), true)
    const orchestrator = readJsonc(join(target, ".o4e", "agents", "all", "orchestrator.jsonc"))
    assert.equal(typeof orchestrator.description, "string")
    assert.ok(orchestrator.description.trim())
    assert.ok(readFileSync(join(target, ".opencode", "agents", "orchestrator.md"), "utf8").includes(orchestrator.description))
    assert.deepEqual(orchestrator.plan, { mode: "child" })
    assert.equal(orchestrator.systemPrompt, "all/orchestrator/system")
    assert.equal(orchestrator.model, null)
    assert.deepEqual(orchestrator.fallbackModels, [])
    assert.deepEqual(orchestrator.loadMcp, { "*": ["*"] })
    assert.ok(orchestrator.loadWorkflows.includes("quality-gate"))
    const disabled = loadRuntimeDefinition(join(target, ".o4e"))
    assert.equal(disabled.config.enableWorkflow, false)
    assert.deepEqual(disabled.runtimeAgents.find((agent) => agent.name === "orchestrator").loadWorkflows, [])
    // Retained definitions do not activate Beta; explicitly opt in before exercising it.
    writeFileSync(join(target, ".o4e", "config.jsonc"), JSON.stringify({ ...config, enableWorkflow: true }))
    const installed = loadRuntimeDefinition(join(target, ".o4e"))
    assert.ok(installed.workflows.has("quality-gate"))
    const installedOrchestrator = installed.allModeAgents.find((agent) => agent.name === "orchestrator")
    assert.ok(installedOrchestrator.loadWorkflows.includes("quality-gate"))
    assert.ok([...installed.workflows.values()].filter((workflow) => workflow.visibility === "entry"
      && installedOrchestrator.loadWorkflows.includes(workflow.name)).some((workflow) => workflow.name === "quality-gate"))
    const owner = { id: "installed-owner", directory: target, agent: "orchestrator", metadata: {} }
    const installedMessages = [{ info: { id: "installed-user", sessionID: owner.id, role: "user", time: { created: 1 } },
      parts: [{ id: "installed-user-text", type: "text", text: "run quality gate" }] }]
    const installedClient = { session: {
      get: async () => ({ data: structuredClone(owner) }),
      update: async ({ body }) => { Object.assign(owner, structuredClone(body)); return { data: structuredClone(owner) } },
      messages: async () => ({ data: structuredClone(installedMessages) }),
    } }
    const installedAgents = installed.runtimeAgents
    const workflowRuntime = new WorkflowRuntime({ client: installedClient, directory: target, snapshot: () => ({
      agents: installedAgents, allAgents: installedAgents, agentByName: new Map(installedAgents.map((agent) => [agent.name, agent])),
      workflows: installed.workflows, runtime: { config: installed.config },
    }) })
    const catalog = JSON.parse(await workflowRuntime.catalog({ sessionID: owner.id, agent: "orchestrator" }))
    assert.ok(catalog.workflows.some((workflow) => workflow.name === "quality-gate"))
    const startArgs = { action: "start", workflow: "quality-gate" }
    installedMessages.push({ info: { id: "installed-assistant", sessionID: owner.id, role: "assistant", parentID: "installed-user", time: { created: 2 } },
      parts: [{ id: "installed-start", messageID: "installed-assistant", sessionID: owner.id, type: "tool", tool: "o4e_workflow", callID: "installed-call",
        state: { status: "running", input: startArgs } }] })
    const started = JSON.parse(await workflowRuntime.handle(startArgs, { sessionID: owner.id, agent: "orchestrator", messageID: "installed-assistant",
      callID: "installed-call", abort: new AbortController().signal, ask: async () => {} }))
    assert.equal(started.workflow, "quality-gate")
    assert.deepEqual(started.ready, ["review"])
    const chat = readJsonc(join(target, ".o4e", "agents", "primary", "chat.jsonc"))
    assert.deepEqual(chat.loadTools, [])
    assert.deepEqual(chat.plan, { mode: "self", reminder: "primary/chat/reminder" })
    assert.deepEqual(chat.loadAgents, [])
    assert.deepEqual(chat.loadWorkflows, [])
    assert.deepEqual(chat.loadMcp, {})
    const architect = readJsonc(join(target, ".o4e", "agents", "subagent", "architect.jsonc"))
    const reviewer = readJsonc(join(target, ".o4e", "agents", "subagent", "reviewer.jsonc"))
    const researcher = readJsonc(join(target, ".o4e", "agents", "subagent", "researcher.jsonc"))
    assert.deepEqual(architect.plan, { mode: "child", loadMcp: {} })
    assert.deepEqual(reviewer.plan, { mode: "self", loadMcp: {} })
    assert.deepEqual(researcher.plan, { mode: "self", loadMcp: {} })
    const runtimeModes = Object.fromEntries(installed.runtimeAgents.map((agent) => [agent.name, agent.type]))
    assert.equal(runtimeModes.orchestrator, "all")
    assert.equal(runtimeModes["orchestrator (plan)"], "all")
    assert.equal(runtimeModes["chat (plan)"], "primary")
    assert.equal(runtimeModes.chat, undefined)
    for (const name of ["architect", "architect (plan)", "reviewer (plan)", "researcher (plan)", "debugger", "tester"]) assert.equal(runtimeModes[name], "subagent")
    assert.equal(runtimeModes.reviewer, undefined)
    assert.equal(runtimeModes.researcher, undefined)
    const reviewStep = installed.workflows.get("quality-gate").steps.find((step) => step.id === "review")
    assert.deepEqual(reviewStep.execution, { mode: "task", agent: "reviewer (plan)" })
    assert.equal(installed.runtimeAgents.find((agent) => agent.name === reviewStep.execution.agent)?.type, "subagent")
    assert.equal(existsSync(join(target, ".o4e", "prompts", "primary", "build", "system.md")), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("仅选择 chat 或 self Plan 角色时默认入口使用实际展开名称", () => {
  for (const name of ["chat", "plan"]) {
    const target = mkdtempSync(join(tmpdir(), "o4e-self-default-"))
    try {
      const config = generateSilentConfig("en", false)
      for (const [id, agent] of Object.entries(config.agents)) agent.enabled = id === name
      if (name === "plan") config.nativeAgents.plan = "managed"
      const result = writeConfig(target, config)
      assert.equal(result.success, true, result.error)
      const installed = loadRuntimeDefinition(join(target, ".o4e"))
      const expected = `${name} (plan)`
      assert.equal(installed.config.defaultAgent, expected)
      assert.equal(existsSync(join(target, ".opencode", "agents", `${expected}.md`)), true)
      assert.equal(existsSync(join(target, ".opencode", "agents", `${name}.md`)), false)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test("安装器原生 Agent 预设和逐项覆盖生成一致配置", () => {
  assert.equal(shouldConfigureNativeAgents("o4e-only"), false)
  assert.equal(shouldConfigureNativeAgents("managed"), false)
  assert.equal(shouldConfigureNativeAgents("keep"), false)
  assert.equal(shouldConfigureNativeAgents("custom"), true)
  assert.deepEqual(nativePolicyStrategies("managed"), { build: "managed", plan: "managed", general: "managed", explore: "managed" })
  assert.deepEqual(nativePolicyStrategies("keep"), { build: "keep", plan: "keep", general: "keep", explore: "keep" })
  assert.deepEqual(resolveNativeInstallOptions({
    "native-policy": "managed",
    "native-agent": ["build=keep", "general=disable"],
  }).strategies, { build: "keep", plan: "managed", general: "disable", explore: "managed" })
  assert.throws(() => resolveNativeInstallOptions({ "native-agent": "unknown=keep" }), /--native-agent 不支持原生 Agent: unknown/)
  assert.throws(() => resolveNativeInstallOptions({ "native-policy": "custom", "native-build": "managed" }, { requireCompleteCustom: true }), /custom requires --native-build, --native-plan, --native-general, and --native-explore/)

  const config = generateSilentConfig("en", true, {
    build: "managed",
    plan: "keep",
    general: "disable",
    explore: "keep",
  })
  assert.equal(config.agents.build.enabled, true)
  assert.equal(config.agents.plan.enabled, false)
  assert.equal(config.agents.general.enabled, false)
  assert.equal(config.agents.explore.enabled, false)
})

test("安装器将默认主 Agent 与子 Agent 分组且不生成双生角色", () => {
  assert.deepEqual(defaultAgentSelectionGroups(), {
    primary: ["orchestrator", "chat"],
    subagent: ["architect", "reviewer", "researcher", "debugger", "tester"],
  })
  const config = generateSilentConfig("en", true)
  assert.deepEqual(Object.entries(config.agents).filter(([, value]) => value.enabled).map(([name]) => name), [
    "orchestrator", "architect", "reviewer", "researcher", "chat", "debugger", "tester",
  ])
})

test("静默安装支持精确 Skill 选择", () => {
  const names = defaultSkillNames()
  assert.deepEqual(resolveSkillSelection({}), names)
  assert.deepEqual(resolveSkillSelection({ "no-skills": true }), [])
  assert.deepEqual(resolveSkillSelection({ skill: [names[1], names[0]] }), [names[1], names[0]])
  assert.throws(() => resolveSkillSelection({ "no-skills": true, skill: names[0] }), /cannot be combined/)
  assert.throws(() => resolveSkillSelection({ skill: [names[0], names[0]] }), /duplicate Skill/)
  assert.throws(() => resolveSkillSelection({ skill: "unknown-skill" }), /Unknown default Skill/)

  const target = join(tmpdir(), `o4e-install-skills-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  try {
    const result = runInstall(["--no-tui", "--target", target, `--skill=${names[0]}`])
    assert.equal(result.success, true)
    assert.equal(existsSync(join(target, ".o4e", "skills", names[0], "SKILL.md")), true)
    for (const name of names.slice(1)) assert.equal(existsSync(join(target, ".o4e", "skills", name)), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("静默安装可物化 managed native Agent", () => {
  const target = join(tmpdir(), `o4e-install-native-managed-${Date.now()}`)
  mkdirSync(target, { recursive: true })

  try {
    const result = runInstall([
      "--no-tui",
      "--target", target,
      "--native-policy=managed",
    ])
    assert.equal(result.success, true)
    const config = readJsonc(join(target, ".o4e", "config.jsonc"))
    assert.deepEqual(config.nativeAgents, { build: "managed", plan: "managed", general: "managed", explore: "managed" })
    for (const [type, name] of [["primary", "build"], ["primary", "plan"], ["subagent", "general"], ["subagent", "explore"]]) {
      assert.equal(existsSync(join(target, ".o4e", "agents", type, `${name}.jsonc`)), true)
      const runtimeName = name === "plan" ? "plan (plan)" : name
      assert.equal(existsSync(join(target, ".opencode", "agents", `${runtimeName}.md`)), true)
    }
    assert.equal(existsSync(join(target, ".opencode", "agents", "plan.md")), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("install 命令进入安装流程", () => {
  const target = join(tmpdir(), `o4e-install-command-${Date.now()}`)
  mkdirSync(target, { recursive: true })

  try {
    const result = runInstaller(["install", "--no-tui", "--target", target, "--lang=zh"])
    assert.equal(result.success, true)
    assert.match(result.output, /安装完成/)
    assert.equal(existsSync(join(target, ".o4e", "config.jsonc")), true)
    const soul = readFileSync(join(target, ".o4e", "soul.md"), "utf8")
    assert.equal(existsSync(join(target, ".o4e", "soul.zh.md")), false)
    assert.equal(existsSync(join(target, ".o4e", "soul.en.md")), false)
    assert.equal(soul, readFileSync(join(import.meta.dirname, "..", "defaults", ".o4e", "soul.zh.md"), "utf8"))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("未知命令被拒绝", () => {
  const result = runInstaller(["unknown-command"])
  assert.equal(result.success, false)
  assert.match(result.output, /Unsupported command: unknown-command/)
})

test("无参数时显示帮助", () => {
  const result = runInstaller([])
  assert.equal(result.success, true)
  assert.match(result.output, /opencode-for-everything installer/)
  assert.match(result.output, /installer\.mjs <command> \[argument\] \[options\]/)
})

test("操作必须显式使用子命令", () => {
  const result = runInstaller(["--no-tui", "--target", tmpdir()])
  assert.equal(result.success, false)
  assert.match(result.output, /A subcommand is required: install, uninstall, status, build, export, or import/)
})

test("不接受多余的位置参数", () => {
  const install = runInstaller(["install", "extra"])
  assert.equal(install.success, false)
  assert.match(install.output, /does not accept positional arguments/)
  const archive = runInstaller(["export", "archive.o4e.tar.gz", "extra"])
  assert.equal(archive.success, false)
  assert.match(archive.output, /accepts exactly one archive file path/)
})

test("未知选项被拒绝", () => {
  const result = runInstaller(["install", "--unknown-option"])
  assert.equal(result.success, false)
  assert.match(result.output, /Unknown option '--unknown-option'/)
})

test("未知语言被拒绝", () => {
  const result = runInstall(["--no-tui", "--lang=fr"])
  assert.equal(result.success, false)
  assert.match(result.output, /--lang must be either zh or en/)
})

test("静默模式 - --no-soul 禁用 SOUL", () => {
  const target = join(tmpdir(), `o4e-install-test-${Date.now()}`)
  mkdirSync(target, { recursive: true })

  try {
    const result = runInstall(["--no-tui", "--target", target, "--no-soul"])
    assert.equal(result.success, true)
    assert.match(result.output, /SOUL.md disabled/)

    // 检查 SOUL.md 不存在
    assert.equal(existsSync(join(target, ".o4e", "soul.md")), false)

    // 检查配置
    const config = readJsonc(join(target, ".o4e", "config.jsonc"))
    assert.equal(config.soul.enabled, false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("build 不修改用户维护的 Soul", () => {
  const target = join(tmpdir(), `o4e-build-soul-preserve-${Date.now()}`)
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const customized = "User-maintained Soul content.\n"
    writeFileSync(join(target, ".o4e", "soul.md"), customized)

    const result = runInstaller(["build", "--target", target])
    assert.equal(result.success, true)
    assert.equal(readFileSync(join(target, ".o4e", "soul.md"), "utf8"), customized)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("静默全局安装生成运行时并注册 plugin", () => {
  const home = join(tmpdir(), `o4e-global-install-test-${Date.now()}`)
  const target = join(home, ".config", "opencode")

  try {
    const result = runInstall(["--no-tui", "--global"], { HOME: home })
    assert.equal(result.success, true)
    assert.equal(existsSync(join(target, ".o4e", "agents", "all", "orchestrator.jsonc")), true)
    assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), true)
    assert.equal(existsSync(join(target, "agents", "orchestrator.md")), true)
    assert.equal(existsSync(join(target, ".o4e", "skills", "o4e-agent-creator", "SKILL.md")), true)
    assert.equal(existsSync(join(target, "skills", "o4e-agent-creator", "SKILL.md")), false)
    const registry = JSON.parse(readFileSync(join(target, "opencode.json"), "utf-8"))
    assert.deepEqual(registry.plugin, [pathToFileURL(join(target, "plugins", "opencode-for-everything.ts")).href])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("全局 build 只重建运行时，不注册 plugin", () => {
  const home = join(tmpdir(), `o4e-global-build-test-${Date.now()}`)
  const target = join(home, ".config", "opencode")

  try {
    copyInstalledDefaults(join(import.meta.dirname, ".."), target)
    const result = runInstaller(["build", "--global"], { HOME: home })
    assert.equal(result.success, true)
    assert.equal(existsSync(join(target, "agents", "build.md")), true)
    assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), true)
    assert.equal(existsSync(join(target, "opencode.json")), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("--global 拒绝同时指定项目目标", () => {
  const result = runInstall(["--no-tui", "--global", "--target", tmpdir()])
  assert.equal(result.success, false)
  assert.match(result.output, /--global cannot be used together with --target/)
})

test("静默模式 - --force 覆盖已有配置", () => {
  const target = join(tmpdir(), `o4e-install-test-${Date.now()}`)
  mkdirSync(join(target, ".o4e"), { recursive: true })

  try {
    // 第一次安装失败（已存在配置）
    const result1 = runInstall(["--no-tui", "--target", target])
    assert.equal(result1.success, false)
    assert.match(result1.output, /Target directory already has config/)

    const result2 = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result2.success, true)
    assert.equal(existsSync(join(target, ".o4e", "config.jsonc")), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("--force 保留自定义 agent 注释，不参与默认注释本地化", () => {
  const target = join(tmpdir(), `o4e-install-custom-comment-${Date.now()}`)
  const customAgent = join(target, ".o4e", "agents", "primary", "custom.jsonc")
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const content = `{
  // [o4e:custom] user-maintained comment
  "$schema": "../../schemas/primary-agent.schema.json",
  "name": "custom",
  "description": "custom primary agent",
  "systemPrompt": "primary/chat/system"
}
`
    writeFileSync(customAgent, content)

    assert.equal(runInstall(["--no-tui", "--target", target, "--force", "--lang=en"]).success, true)
    assert.equal(readFileSync(customAgent, "utf8"), content)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("--force 保留用户维护的 Soul", () => {
  const target = join(tmpdir(), `o4e-install-custom-soul-${Date.now()}`)
  const soulPath = join(target, ".o4e", "soul.md")
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    writeFileSync(soulPath, "user-maintained soul\n")

    assert.equal(runInstall(["--no-tui", "--target", target, "--force", "--lang=en"]).success, true)
    assert.equal(readFileSync(soulPath, "utf8"), "user-maintained soul\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("--force 保留自定义 Soul 路径、内容和权限", () => {
  const target = join(tmpdir(), `o4e-install-custom-soul-path-${Date.now()}`)
  const configPath = join(target, ".o4e", "config.jsonc")
  const soulPath = join(target, ".o4e", "identity", "persona.md")
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const config = readJsonc(configPath)
    config.soul.file = "identity\\persona.md"
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    mkdirSync(dirname(soulPath), { recursive: true })
    writeFileSync(soulPath, "custom-path soul\n")
    chmodSync(soulPath, 0o600)
    const soulMode = statSync(soulPath).mode & 0o777

    assert.equal(runInstall(["--no-tui", "--target", target, "--force", "--lang=en"]).success, true)
    assert.equal(readJsonc(configPath).soul.file, "identity/persona.md")
    assert.equal(readFileSync(soulPath, "utf8"), "custom-path soul\n")
    assert.equal(statSync(soulPath).mode & 0o777, soulMode)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("--force 在写入前拒绝 Soul 与受管 Agent 路径冲突", () => {
  const target = join(tmpdir(), `o4e-install-agent-soul-path-${Date.now()}`)
  const configPath = join(target, ".o4e", "config.jsonc")
  const agentPath = join(target, ".o4e", "agents", "all", "orchestrator.jsonc")
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const config = readJsonc(configPath)
    config.soul.file = "agents\\all\\orchestrator.jsonc"
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    writeFileSync(agentPath, "agent-path soul\n")

    const result = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result.success, false)
    assert.match(result.output, /Soul cannot use the same path as an installer-managed configuration file: agents\/all\/orchestrator\.jsonc/)
    assert.equal(readFileSync(agentPath, "utf8"), "agent-path soul\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("--force 规范化 Soul 路径并在写入前拒绝配置文件冲突", () => {
  const target = join(tmpdir(), `o4e-install-config-soul-path-${Date.now()}`)
  const configPath = join(target, ".o4e", "config.jsonc")
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const config = readJsonc(configPath)
    config.soul.file = "./config.jsonc"
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    const before = readFileSync(configPath, "utf8")

    const result = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result.success, false)
    assert.match(result.output, /Soul cannot use the same path as an installer-managed configuration file: config\.jsonc/)
    assert.equal(readFileSync(configPath, "utf8"), before)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装不触碰 OpenCode 公共 Skill 目录", () => {
  const target = join(tmpdir(), `o4e-install-skill-conflict-${Date.now()}`)
  const sentinel = join(target, ".o4e", "user-config.txt")
  const runtimeSkill = join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")
  mkdirSync(dirname(runtimeSkill), { recursive: true })
  mkdirSync(dirname(sentinel), { recursive: true })

  try {
    writeFileSync(sentinel, "preserve me\n")
    writeFileSync(runtimeSkill, "user-owned skill\n")
    const result = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result.success, true)
    assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n")
    assert.equal(readFileSync(runtimeSkill, "utf8"), "user-owned skill\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装器只替换或删除 registry 中的默认 Skill，并保留用户自建 Skill", () => {
  const target = join(tmpdir(), `o4e-install-multiple-skills-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  const extraSource = join(target, ".o4e", "skills", "custom-skill", "SKILL.md")
  const name = defaultSkillNames()[0]
  const skillRoot = join(target, ".o4e", "skills", name)
  const skillPath = join(skillRoot, "SKILL.md")
  const stalePath = join(skillRoot, "stale.txt")
  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    mkdirSync(dirname(extraSource), { recursive: true })
    writeFileSync(extraSource, "---\nname: custom-skill\ndescription: custom test\n---\n<!--opencode-for-everything-skill:custom-skill-->\ncustom\n")
    writeFileSync(skillPath, "user replacement\n")
    writeFileSync(stalePath, "stale\n")

    assert.equal(runInstall(["--no-tui", "--target", target, "--force", `--skill=${name}`]).success, true)
    assert.equal(existsSync(extraSource), true)
    assert.match(readFileSync(skillPath, "utf8"), new RegExp(`name: ${name}`))
    assert.equal(existsSync(stalePath), false)

    writeFileSync(skillPath, "user replacement again\n")
    assert.equal(runInstall(["--no-tui", "--target", target, "--force", "--no-skills"]).success, true)
    assert.equal(existsSync(extraSource), true)
    for (const defaultName of defaultSkillNames()) assert.equal(existsSync(join(target, ".o4e", "skills", defaultName)), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装保留已有项目文件", () => {
  const target = join(tmpdir(), `o4e-install-project-file-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  const projectFile = join(target, "project-rules.md")

  try {
    writeFileSync(projectFile, "project-owned rules\n")
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    assert.equal(readFileSync(projectFile, "utf8"), "project-owned rules\n")
    assert.equal(runInstall(["--no-tui", "--target", target, "--force"]).success, true)
    assert.equal(readFileSync(projectFile, "utf8"), "project-owned rules\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装拒绝符号链接配置和运行时根目录", () => {
  for (const rootName of [".o4e", ".opencode"]) {
    const target = join(tmpdir(), `o4e-install-linked-root-${rootName.slice(1)}-${Date.now()}`)
    const externalRoot = join(tmpdir(), `o4e-install-external-root-${rootName.slice(1)}-${Date.now()}`)
    mkdirSync(target, { recursive: true })
    mkdirSync(externalRoot, { recursive: true })
    try {
      createDirectoryLink(externalRoot, join(target, rootName))
      const result = runInstall(["--no-tui", "--target", target, "--force"])
      assert.equal(result.success, false)
      assert.match(result.output, /root must be a regular directory/)
      assert.deepEqual(readdirSync(externalRoot), [])
    } finally {
      rmSync(target, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    }
  }
})

test("--force 构建失败时恢复已有配置", () => {
  const target = join(tmpdir(), `o4e-install-restore-${Date.now()}`)
  const originalSoul = join(target, ".o4e", "soul.md")
  const externalRuntime = join(tmpdir(), `o4e-install-restore-external-${Date.now()}.md`)
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, ".opencode", "agents"), { recursive: true })

  try {
    writeFileSync(originalSoul, "original soul\n")
    writeFileSync(externalRuntime, "external runtime\n")
    createFileLink(externalRuntime, join(target, ".opencode", "agents", "orchestrator.md"))
    const result = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result.success, false)
    assert.equal(readFileSync(originalSoul, "utf8"), "original soul\n")
    assert.equal(readFileSync(externalRuntime, "utf8"), "external runtime\n")
    assert.match(result.output, /failed configuration retained at/)
    assert.match(result.output, /生成目标必须是独立普通文件/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRuntime, { force: true })
  }
})

test("安装和导入在运行时写入失败后恢复原 manifest 与文件快照", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "o4e-runtime-rollback-"))
  const source = join(root, "source")
  const archive = join(root, "source.o4e.tar.gz")
  const preload = join(root, "fail-runtime-write.mjs")
  try {
    copyInstalledDefaults(join(import.meta.dirname, ".."), source)
    const tarArchive = localTarArchive(archive)
    execFileSync(tarCommand(), ["-C", source, "-czf", tarArchive.argument, ".o4e"], { cwd: tarArchive.cwd })
    writeFileSync(preload, `import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
const writeFileSync = fs.writeFileSync
let failed = false
fs.writeFileSync = (path, ...args) => {
  if (!failed && path === process.env.O4E_TEST_FAIL_RUNTIME_WRITE) {
    failed = true
    writeFileSync(process.env.O4E_TEST_MANIFEST_EVIDENCE, fs.readFileSync(process.env.O4E_TEST_MANIFEST_PATH))
    throw Object.assign(new Error("injected runtime write failure"), { code: "EIO" })
  }
  return writeFileSync(path, ...args)
}
syncBuiltinESMExports()
`)
    for (const fixture of [
      { operation: "install", existingConfig: false, existingPackage: true },
      { operation: "install", existingConfig: true, existingPackage: false },
      { operation: "import", existingConfig: false, existingPackage: false },
      { operation: "import", existingConfig: true, existingPackage: true },
    ]) {
      await t.test(`${fixture.operation}, config=${fixture.existingConfig}, package=${fixture.existingPackage}`, () => {
        const target = join(root, `${fixture.operation}-${fixture.existingConfig}`)
        const runtimeRoot = join(target, ".opencode")
        const plugin = join(runtimeRoot, "plugins", "opencode-for-everything.ts")
        const manifest = join(runtimeRoot, "package.json")
        const evidence = join(target, "manifest-before-failure.json")
        const originalPackage = '{"private":true,"dependencies":{"left-pad":"1.3.0"}}\n'
        mkdirSync(dirname(plugin), { recursive: true })
        writeFileSync(plugin, "original runtime\n")
        chmodSync(plugin, 0o640)
        const pluginMode = statSync(plugin).mode & 0o777
        if (fixture.existingPackage) {
          writeFileSync(manifest, originalPackage)
          chmodSync(manifest, 0o600)
        }
        const manifestMode = fixture.existingPackage ? statSync(manifest).mode & 0o777 : undefined
        if (fixture.existingConfig) cpSync(join(source, ".o4e"), join(target, ".o4e"), { recursive: true })
        const originalConfig = fixture.existingConfig ? readFileSync(join(target, ".o4e", "config.jsonc"), "utf8") : undefined
        const commandArgs = fixture.operation === "install" ? ["install", "--no-tui"] : ["import", archive]
        const result = runInstaller([...commandArgs, "--target", target, ...(fixture.existingConfig ? ["--force"] : [])], {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${pathToFileURL(preload).href}`.trim(),
          O4E_TEST_FAIL_RUNTIME_WRITE: plugin,
          O4E_TEST_MANIFEST_PATH: manifest,
          O4E_TEST_MANIFEST_EVIDENCE: evidence,
        })
        assert.equal(result.success, false)
        assert.match(result.output, /injected runtime write failure/)
        const writtenPackage = JSON.parse(readFileSync(evidence, "utf8"))
        assert.equal(Object.hasOwn(writtenPackage.dependencies, "@opencode-ai/plugin"), false)
        assert.equal(writtenPackage.dependencies.effect, "4.0.0-beta.83")
        assert.ok(writtenPackage.dependencies["tree-sitter-bash"])
        assert.ok(writtenPackage.dependencies["web-tree-sitter"])
        assert.equal(existsSync(manifest), fixture.existingPackage)
        if (fixture.existingPackage) {
          assert.equal(readFileSync(manifest, "utf8"), originalPackage)
          assert.equal(statSync(manifest).mode & 0o777, manifestMode)
        }
        assert.equal(readFileSync(plugin, "utf8"), "original runtime\n")
        assert.equal(statSync(plugin).mode & 0o777, pluginMode)
        assert.equal(existsSync(join(runtimeRoot, "agents", "orchestrator.md")), false)
        assert.equal(existsSync(join(target, ".o4e")), fixture.existingConfig)
        if (fixture.existingConfig) assert.equal(readFileSync(join(target, ".o4e", "config.jsonc"), "utf8"), originalConfig)
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("首次安装构建失败时保留失败配置供恢复", () => {
  const target = join(tmpdir(), `o4e-install-cleanup-${Date.now()}`)
  const externalRuntime = join(tmpdir(), `o4e-install-cleanup-external-${Date.now()}.md`)
  mkdirSync(join(target, ".opencode", "agents"), { recursive: true })
  for (const name of ["adapters", "core", "runtime"]) {
    mkdirSync(join(target, ".opencode", "plugins", name), { recursive: true })
  }

  try {
    writeFileSync(externalRuntime, "external runtime\n")
    mkdirSync(join(target, ".opencode", "plugins", "opencode-for-everything"), { recursive: true })
    writeFileSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs"), "user runtime\n")
    writeFileSync(join(target, ".opencode", "plugins", "user-root-module.mjs"), "user root module\n")
    writeFileSync(join(target, ".opencode", "user-state.json"), "user state\n")
    createFileLink(externalRuntime, join(target, ".opencode", "agents", "build.md"))
    const result = runInstall(["--no-tui", "--target", target])
    assert.equal(result.success, false)
    assert.equal(existsSync(join(target, ".o4e")), false)
    assert.equal(readFileSync(externalRuntime, "utf8"), "external runtime\n")
    assert.equal(readFileSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs"), "utf8"), "user runtime\n")
    assert.equal(readFileSync(join(target, ".opencode", "plugins", "user-root-module.mjs"), "utf8"), "user root module\n")
    assert.equal(readFileSync(join(target, ".opencode", "user-state.json"), "utf8"), "user state\n")
    const component = join(target, ".opencode", "plugins", "opencode-for-everything")
    assert.equal(existsSync(join(component, "plugin.ts")), false)
    assert.equal(existsSync(join(component, "core")), false)
    for (const name of ["adapters", "core", "runtime"]) {
      assert.equal(existsSync(join(target, ".opencode", "plugins", name)), true)
    }
    assert.match(result.output, /failed configuration retained at/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRuntime, { force: true })
  }
})

test("--force 同时清理同名 Agent 的 json 和 jsonc 配置", () => {
  const target = join(tmpdir(), `o4e-install-agent-extensions-${Date.now()}`)
  const allRoot = join(target, ".o4e", "agents", "all")
  const primaryRoot = join(target, ".o4e", "agents", "primary")

  try {
    mkdirSync(target, { recursive: true })
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const orchestratorJsonc = join(allRoot, "orchestrator.jsonc")
    renameSync(orchestratorJsonc, join(allRoot, "orchestrator.json"))
    const result = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(result.success, true)
    assert.equal(existsSync(join(allRoot, "orchestrator.json")), false)
    assert.equal(existsSync(join(allRoot, "orchestrator.jsonc")), true)

    cpSync(join(import.meta.dirname, "..", "defaults", ".o4e", "agents", "primary", "build.jsonc"), join(primaryRoot, "build.json"))
    const disabledResult = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(disabledResult.success, true)
    assert.equal(existsSync(join(primaryRoot, "build.json")), false)
    assert.equal(existsSync(join(primaryRoot, "build.jsonc")), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("帮助信息", () => {
  const result = runInstaller(["--help"])
  assert.equal(result.success, true)
  assert.match(result.output, /opencode-for-everything installer/)
  assert.match(result.output, /--no-tui/)
  assert.match(result.output, /--lang/)
  assert.match(result.output, /--no-soul/)
  assert.doesNotMatch(result.output, /^\s+--soul\s/m)
  assert.match(result.output, /export <archive>/)
  assert.match(result.output, /import <archive>/)
  assert.match(result.output, /installer\.mjs <command> \[argument\] \[options\]/)
  assert.doesNotMatch(result.output, /^\s+--(?:status|uninstall|build|export|import)\b/m)
  assert.doesNotMatch(result.output, /\[install\]/)
})

test("导入导出子命令拒绝空文件路径", () => {
  for (const command of ["export", "import"]) {
    const result = runInstaller([command])
    assert.equal(result.success, false)
    assert.match(result.output, new RegExp(`${command} requires an archive file path`))
    const empty = runInstaller([command, ""])
    assert.equal(empty.success, false)
    assert.match(empty.output, new RegExp(`${command} requires an archive file path`))
  }
})

test("归档成员路径只接受规范的 POSIX .o4e 路径", () => {
  for (const path of [".o4e", ".o4e/", ".o4e/config.jsonc", ".o4e/prompts/chat/system.md"]) {
    assert.equal(isSafeArchiveEntryPath(path), true, path)
  }
  for (const path of [
    "other/config.jsonc",
    "/.o4e/config.jsonc",
    ".o4e/../outside",
    ".o4e/./config.jsonc",
    ".o4e//config.jsonc",
    ".o4e\\..\\..\\outside",
    ".o4e/C:/outside",
    ".o4e/config.jsonc:stream",
    ".o4e/trailing.",
    ".o4e/trailing ",
    ".o4e/NUL",
    ".o4e/con.jsonc",
    ".o4e/COM1/config.jsonc",
  ]) {
    assert.equal(isSafeArchiveEntryPath(path), false, path)
  }
})

test("tar 输出只移除记录结尾的 CRLF", () => {
  assert.deepEqual(tarOutputLines(".o4e/\r\n.o4e/config.jsonc\r\n"), [".o4e/", ".o4e/config.jsonc"])
  assert.deepEqual(tarOutputLines(".o4e/bad\rname\n"), [".o4e/bad\rname"])
  assert.equal(isSafeArchiveEntryPath(tarOutputLines(".o4e/bad\rname\n")[0]), false)
})

test("导出并导入配置会重建运行时", () => {
  const source = join(tmpdir(), `o4e-export-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-config-${Date.now()}.o4e.tar.gz`)
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", source]).success, true)
    writeFileSync(join(source, ".o4e", "soul.md"), "exported soul\n")
    writeFileSync(join(source, ".o4e", "中文 notes.md"), "  用户正文\n\n")

    const archiveEnv = { LC_ALL: "C", QUOTING_STYLE: "literal", TAR_OPTIONS: "--quoting-style=literal" }
    const exported = runInstaller(["export", archive, "--target", source], archiveEnv)
    assert.equal(exported.success, true)
    assert.equal(existsSync(archive), true)
    assert.equal(statSync(archive).mode & 0o777, process.platform === "win32" ? 0o666 : 0o600)
    const tarArchive = localTarArchive(archive)
    const entries = execFileSync(tarCommand(), ["-tzf", tarArchive.argument], { cwd: tarArchive.cwd, encoding: "utf8" })
    assert.match(entries, /\.o4e\/skills\/o4e-agent-creator\/SKILL\.md/)

    const imported = runInstaller(["import", archive, "--target", target], archiveEnv)
    assert.equal(imported.success, true)
    assert.equal(readFileSync(join(target, ".o4e", "soul.md"), "utf-8"), "exported soul\n")
    assert.equal(readFileSync(join(target, ".o4e", "中文 notes.md"), "utf-8"), "  用户正文\n\n")
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts")), true)
    assert.equal(existsSync(join(target, ".o4e", "skills", "o4e-agent-creator", "SKILL.md")), true)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("导出拒绝链接配置和指回配置目录的输出路径", () => {
  const target = join(tmpdir(), `o4e-export-linked-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-export-linked-${Date.now()}.o4e.tar.gz`)
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    const linkedFile = join(target, ".o4e", "linked-config.jsonc")
    createFileLink(join(target, ".o4e", "config.jsonc"), linkedFile)
    const linkedConfig = runInstaller(["export", archive, "--target", target])
    assert.equal(linkedConfig.success, false)
    assert.match(linkedConfig.output, /cannot contain links or special files/)

    rmSync(linkedFile)
    const linkedOutputDir = join(target, "archive-output")
    createDirectoryLink(join(target, ".o4e"), linkedOutputDir)
    const linkedOutput = runInstaller(["export", join(linkedOutputDir, "backup.o4e.tar.gz"), "--target", target])
    assert.equal(linkedOutput.success, false)
    assert.match(linkedOutput.output, /Configuration archive cannot be written inside the \.o4e directory/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("导出拒绝配置树和输出目标中的硬链接", () => {
  const target = join(tmpdir(), `o4e-export-hardlinked-${Date.now()}`)
  const externalFile = join(tmpdir(), `o4e-export-hardlinked-external-${Date.now()}.txt`)
  const archive = join(tmpdir(), `o4e-export-hardlinked-${Date.now()}.o4e.tar.gz`)
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    writeFileSync(externalFile, "external data\n")
    const linkedConfig = join(target, ".o4e", "linked-data.txt")
    linkSync(externalFile, linkedConfig)
    const configResult = runInstaller(["export", archive, "--target", target])
    assert.equal(configResult.success, false)
    assert.match(configResult.output, /cannot contain links or special files/)

    rmSync(linkedConfig)
    writeFileSync(archive, "archive target\n")
    const archiveAlias = join(tmpdir(), `o4e-export-hardlinked-alias-${Date.now()}.o4e.tar.gz`)
    linkSync(archive, archiveAlias)
    const outputResult = runInstaller(["export", archiveAlias, "--target", target])
    assert.equal(outputResult.success, false)
    assert.match(outputResult.output, /Configuration archive target must be an unlinked regular file/)
    assert.equal(readFileSync(archive, "utf8"), "archive target\n")
    rmSync(archiveAlias, { force: true })
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalFile, { force: true })
    rmSync(archive, { force: true })
  }
})

test("导出失败时保留已有归档", () => {
  const target = join(tmpdir(), `o4e-export-atomic-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-export-atomic-${Date.now()}.o4e.tar.gz`)
  const fakeSystemRoot = join(tmpdir(), `o4e-fake-tar-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  mkdirSync(join(fakeSystemRoot, "System32"), { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    writeFileSync(archive, "existing archive\n")
    chmodSync(archive, 0o600)
    const result = runInstaller(["export", archive, "--target", target], {
      SystemRoot: fakeSystemRoot,
      WINDIR: fakeSystemRoot,
      PATH: process.platform === "win32" ? process.env.PATH : fakeSystemRoot,
    })
    assert.equal(result.success, false)
    assert.equal(readFileSync(archive, "utf8"), "existing archive\n")
    assert.equal(statSync(archive).mode & 0o777, process.platform === "win32" ? 0o666 : 0o600)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(fakeSystemRoot, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("导出拒绝无法重新导入的文件名并保留已有备份", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-export-roundtrip-"))
  const target = join(root, "source")
  const archive = join(root, "backup.o4e.tar.gz")
  const imported = join(root, "imported")
  mkdirSync(target)
  mkdirSync(imported)
  try {
    assert.equal(runInstall(["--no-tui", "--target", target, "--no-skills"]).success, true)
    assert.equal(runInstaller(["export", archive, "--target", target]).success, true)
    chmodSync(archive, 0o640)
    const original = readFileSync(archive)
    const originalMode = statSync(archive).mode & 0o777
    for (const filename of ["meeting: draft.md", "literal\\345\\224.md", "line\nbreak.md"]) {
      const file = join(target, ".o4e", filename)
      writeFileSync(file, "user note\n")
      const result = runInstaller(["export", archive, "--target", target], { LC_ALL: "C", QUOTING_STYLE: "literal", TAR_OPTIONS: "--quoting-style=literal" })
      assert.equal(result.success, false, filename)
      assert.match(result.output, /unsupported entry:/)
      if (filename === "meeting: draft.md") assert.match(result.output, /meeting: draft\.md/)
      assert.deepEqual(readFileSync(archive), original)
      assert.equal(statSync(archive).mode & 0o777, originalMode)
      rmSync(file)
    }
    assert.equal(runInstaller(["import", archive, "--target", imported]).success, true)
    assert.equal(existsSync(join(imported, ".o4e", "meeting: draft.md")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("导入已有配置需要 --force，且拒绝包含其他目录的归档", () => {
  const source = join(tmpdir(), `o4e-import-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-existing-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-${Date.now()}.o4e.tar.gz`)
  const invalidArchive = join(tmpdir(), `o4e-invalid-${Date.now()}.o4e.tar.gz`)
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", source]).success, true)
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    assert.equal(runInstaller(["export", archive, "--target", source]).success, true)
    const blocked = runInstaller(["import", archive, "--target", target])
    assert.equal(blocked.success, false)
    assert.match(blocked.output, /use --force for non-interactive import/)

    writeFileSync(join(source, "unexpected.txt"), "invalid archive content\n")
    const invalidTarArchive = localTarArchive(invalidArchive)
    execFileSync(tarCommand(), ["-C", source, "-czf", invalidTarArchive.argument, ".o4e", "unexpected.txt"], { cwd: invalidTarArchive.cwd })
    const invalid = runInstaller(["import", invalidArchive, "--target", target, "--force"])
    assert.equal(invalid.success, false)
    assert.match(invalid.output, /may only contain the \.o4e directory/)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
    rmSync(invalidArchive, { force: true })
  }
})

test("导入拒绝包含符号链接的配置归档", () => {
  const source = join(tmpdir(), `o4e-import-linked-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-linked-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-linked-${Date.now()}.o4e.tar.gz`)
  mkdirSync(join(source, ".o4e"), { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    writeFileSync(join(source, ".o4e", "config.jsonc"), "{}\n")
    linkSync(join(source, ".o4e", "config.jsonc"), join(source, ".o4e", "linked-config.jsonc"))
    const tarArchive = localTarArchive(archive)
    execFileSync(tarCommand(), ["-C", source, "-czf", tarArchive.argument, ".o4e"], { cwd: tarArchive.cwd })
    const result = runInstaller(["import", archive, "--target", target])
    assert.equal(result.success, false)
    assert.match(result.output, /cannot contain symlinks, hard links, or special files/)
    assert.deepEqual(readdirSync(target), [])
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("导入拒绝符号链接和硬链接归档输入", () => {
  const source = join(tmpdir(), `o4e-import-archive-link-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-archive-link-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-archive-link-${Date.now()}.o4e.tar.gz`)
  const linkedArchive = join(tmpdir(), `o4e-import-archive-link-alias-${Date.now()}.o4e.tar.gz`)
  const hardlinkedArchive = join(tmpdir(), `o4e-import-archive-hardlink-${Date.now()}.o4e.tar.gz`)
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", source]).success, true)
    assert.equal(runInstaller(["export", archive, "--target", source]).success, true)

    createFileLink(archive, linkedArchive)
    const linked = runInstaller(["import", linkedArchive, "--target", target])
    assert.equal(linked.success, false)
    assert.match(linked.output, /Configuration archive source must be an unlinked regular file/)
    removeLink(linkedArchive)

    linkSync(archive, hardlinkedArchive)
    const hardlinked = runInstaller(["import", hardlinkedArchive, "--target", target])
    assert.equal(hardlinked.success, false)
    assert.match(hardlinked.output, /Configuration archive source must be an unlinked regular file/)
    assert.deepEqual(readdirSync(target), [])
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
    rmSync(linkedArchive, { recursive: true, force: true })
    rmSync(hardlinkedArchive, { force: true })
  }
})

test("导入构建失败时恢复已有配置", () => {
  const source = join(tmpdir(), `o4e-import-invalid-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-restore-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-invalid-${Date.now()}.o4e.tar.gz`)
  mkdirSync(join(source, ".o4e"), { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    writeFileSync(join(source, ".o4e", "config.jsonc"), "{}\n")
    const tarArchive = localTarArchive(archive)
    execFileSync(tarCommand(), ["-C", source, "-czf", tarArchive.argument, ".o4e"], { cwd: tarArchive.cwd })
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    writeFileSync(join(target, ".o4e", "soul.md"), "original soul\n")

    const result = runInstaller(["import", archive, "--target", target, "--force"])
    assert.equal(result.success, false)
    assert.equal(readFileSync(join(target, ".o4e", "soul.md"), "utf-8"), "original soul\n")
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts")), true)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("导入不触碰 OpenCode 公共 Skill", () => {
  const source = join(tmpdir(), `o4e-import-skill-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-skill-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-skill-${Date.now()}.o4e.tar.gz`)
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", source]).success, true)
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    writeFileSync(join(target, ".o4e", "soul.md"), "original soul\n")
    mkdirSync(join(target, ".opencode", "skills", "o4e-agent-creator"), { recursive: true })
    writeFileSync(join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md"), "user-owned skill\n")
    assert.equal(runInstaller(["export", archive, "--target", source]).success, true)

    const result = runInstaller(["import", archive, "--target", target, "--force"])
    assert.equal(result.success, true)
    assert.equal(readFileSync(join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md"), "utf8"), "user-owned skill\n")
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("首次导入构建失败时清理配置和受管运行时", () => {
  const source = join(tmpdir(), `o4e-import-cleanup-source-${Date.now()}`)
  const target = join(tmpdir(), `o4e-import-cleanup-target-${Date.now()}`)
  const archive = join(tmpdir(), `o4e-import-cleanup-${Date.now()}.o4e.tar.gz`)
  mkdirSync(source, { recursive: true })
  mkdirSync(join(target, ".opencode", "agents", "plan.md"), { recursive: true })
  mkdirSync(join(target, ".opencode", "plugins"), { recursive: true })

  try {
    assert.equal(runInstall(["--no-tui", "--target", source]).success, true)
    assert.equal(runInstaller(["export", archive, "--target", source]).success, true)
     mkdirSync(join(target, ".opencode", "plugins", "opencode-for-everything"), { recursive: true })
     writeFileSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs"), "user runtime\n")
    const result = runInstaller(["import", archive, "--target", target])
    assert.equal(result.success, false)
    assert.equal(existsSync(join(target, ".o4e")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "build.md")), false)
     assert.equal(readFileSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs"), "utf8"), "user runtime\n")
    assert.match(result.output, /failed configuration retained at/)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
})

test("静默卸载只清理受管项目运行时并保留配置", () => {
  const target = join(tmpdir(), `o4e-uninstall-test-${Date.now()}`)
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, ".opencode", "plugins"), { recursive: true })
    mkdirSync(join(target, ".opencode", "agents"), { recursive: true })
    mkdirSync(join(target, ".opencode", "skills", "o4e-agent-creator"), { recursive: true })

  try {
     mkdirSync(join(target, ".opencode", "plugins", "opencode-for-everything"), { recursive: true })
     writeFileSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs"), "managed")
     writeFileSync(join(target, ".opencode", "plugins", "other.mjs"), "unrelated")
     mkdirSync(join(target, ".opencode", "plugins", "adapters"), { recursive: true })
     mkdirSync(join(target, ".opencode", "plugins", "core"), { recursive: true })
     writeFileSync(join(target, ".opencode", "plugins", "adapters", "other.mjs"), "shared unrelated")
     writeFileSync(join(target, ".opencode", "plugins", "core", "other.mjs"), "shared unrelated")
    writeFileSync(join(target, ".opencode", "agents", "build.md"), "<!--opencode-for-everything-agent:build-->")
    writeFileSync(join(target, ".opencode", "agents", "other.md"), "unrelated")
    writeFileSync(join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md"), "<!--opencode-for-everything-skill:o4e-agent-creator-->")

    const result = runInstaller(["uninstall", "--no-tui", "--target", target])
    assert.equal(result.success, true)
    assert.equal(existsSync(join(target, ".o4e")), true)
     assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs")), false)
     assert.equal(existsSync(join(target, ".opencode", "plugins", "other.mjs")), true)
     assert.equal(readFileSync(join(target, ".opencode", "plugins", "adapters", "other.mjs"), "utf8"), "shared unrelated")
     assert.equal(readFileSync(join(target, ".opencode", "plugins", "core", "other.mjs"), "utf8"), "shared unrelated")
    assert.equal(existsSync(join(target, ".opencode", "agents", "build.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "other.md")), true)
    assert.equal(existsSync(join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建和卸载保留 plugin 根目录中的非受管用户模块", () => {
  const target = join(tmpdir(), `o4e-unmanaged-runtime-${Date.now()}`)
  const userModule = join(target, ".opencode", "plugins", "user-module.mjs")
  mkdirSync(dirname(userModule), { recursive: true })
  try {
    writeFileSync(userModule, "user plugin\n")
    assert.equal(runInstall(["--no-tui", "--target", target]).success, true)
    assert.equal(readFileSync(userModule, "utf8"), "user plugin\n")
    assert.equal(runInstaller(["uninstall", "--no-tui", "--target", target]).success, true)
    assert.equal(readFileSync(userModule, "utf8"), "user plugin\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("卸载不删除同名非受管 Skill", () => {
  const target = join(tmpdir(), `o4e-unmanaged-skill-${Date.now()}`)
  const skillPath = join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, ".opencode", "skills", "o4e-agent-creator"), { recursive: true })
  try {
    writeFileSync(skillPath, "user-owned skill\n")
    const result = runInstaller(["uninstall", "--no-tui", "--target", target])
    assert.equal(result.success, true)
    assert.equal(readFileSync(skillPath, "utf8"), "user-owned skill\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("卸载不通过符号链接目录删除项目外 Skill", () => {
  const target = join(tmpdir(), `o4e-uninstall-linked-skill-${Date.now()}`)
  const externalRoot = join(tmpdir(), `o4e-uninstall-external-skill-${Date.now()}`)
  const externalSkillDir = join(externalRoot, "o4e-agent-creator")
  const externalSkill = join(externalSkillDir, "SKILL.md")
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, ".opencode", "skills"), { recursive: true })
  mkdirSync(externalSkillDir, { recursive: true })
  try {
    writeFileSync(externalSkill, "<!--opencode-for-everything-skill:o4e-agent-creator-->\nexternal\n")
    createDirectoryLink(externalSkillDir, join(target, ".opencode", "skills", "o4e-agent-creator"))
    const result = runInstaller(["uninstall", "--no-tui", "--target", target])
    assert.equal(result.success, true)
    assert.equal(existsSync(externalSkill), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("卸载拒绝符号链接运行时根目录", () => {
  const target = join(tmpdir(), `o4e-uninstall-linked-runtime-${Date.now()}`)
  const externalRoot = join(tmpdir(), `o4e-uninstall-external-runtime-${Date.now()}`)
  const externalSkill = join(externalRoot, "skills", "o4e-agent-creator", "SKILL.md")
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(dirname(externalSkill), { recursive: true })
  try {
    writeFileSync(externalSkill, "<!--opencode-for-everything-skill:o4e-agent-creator-->\nexternal\n")
    createDirectoryLink(externalRoot, join(target, ".opencode"))
    const result = runInstaller(["uninstall", "--no-tui", "--target", target])
    assert.equal(result.success, false)
    assert.match(result.output, /Runtime root must be a regular directory; refusing to remove/)
    assert.equal(existsSync(externalSkill), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("静默全局卸载保留配置并移除组件运行时和注册", () => {
  const home = join(tmpdir(), `o4e-global-uninstall-test-${Date.now()}`)
  const target = join(home, ".config", "opencode")
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, "plugins"), { recursive: true })
  mkdirSync(join(target, "agents"), { recursive: true })

  try {
    const pluginPath = join(target, "plugins", "opencode-for-everything.ts")
    const pluginSpec = pathToFileURL(pluginPath).href
    writeFileSync(pluginPath, "managed")
    writeFileSync(join(target, "plugins", "other.mjs"), "unrelated")
    writeFileSync(join(target, "agents", "build.md"), "<!--opencode-for-everything-agent:build-->")
    writeFileSync(join(target, "opencode.json"), JSON.stringify({ plugin: [pluginSpec, "other-plugin"] }))

    const result = runInstaller(["uninstall", "--no-tui", "--global"], { HOME: home })
    assert.equal(result.success, true)
    assert.equal(existsSync(join(target, ".o4e")), true)
    assert.equal(existsSync(pluginPath), false)
    assert.equal(existsSync(join(target, "plugins", "other.mjs")), true)
    assert.equal(existsSync(join(target, "agents", "build.md")), false)
    assert.deepEqual(JSON.parse(readFileSync(join(target, "opencode.json"), "utf-8")), { plugin: ["other-plugin"] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("原生 prompt 预检失败时不改动已有安装目标", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-native-preflight-"))
  const configRoot = join(target, ".o4e")
  try {
    mkdirSync(configRoot)
    writeFileSync(join(configRoot, "user.txt"), "preserve me\n")
    const result = runInstall(["--no-tui", "--target", target, "--force"], { PATH: configRoot })
    assert.equal(result.success, false)
    assert.match(result.output, /无法从 PATH 定位本机 opencode/)
    assert.deepEqual(readdirSync(target), [".o4e"])
    assert.deepEqual(readdirSync(configRoot), ["user.txt"])
    assert.equal(readFileSync(join(configRoot, "user.txt"), "utf8"), "preserve me\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("全局注册配置无效时，静默卸载不会删除运行时", () => {
  const home = join(tmpdir(), `o4e-invalid-global-uninstall-test-${Date.now()}`)
  const target = join(home, ".config", "opencode")
  const pluginPath = join(target, "plugins", "opencode-for-everything.ts")
  mkdirSync(join(target, ".o4e"), { recursive: true })
  mkdirSync(join(target, "plugins"), { recursive: true })

  try {
    writeFileSync(pluginPath, "managed")
    writeFileSync(join(target, "opencode.json"), "{ not strict JSON }")

    const result = runInstaller(["uninstall", "--no-tui", "--global"], { HOME: home })
    assert.equal(result.success, false)
    assert.equal(existsSync(pluginPath), true)
    assert.equal(existsSync(join(target, ".o4e")), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("全局安装和卸载拒绝链接注册配置且不产生本地副作用", () => {
  for (const linkType of ["symbolic", "hard", "dangling"]) {
    const home = join(tmpdir(), `o4e-global-linked-registry-${linkType}-${Date.now()}`)
    const target = join(home, ".config", "opencode")
    const externalConfig = join(home, `external-${linkType}.json`)
    const registryPath = join(target, "opencode.json")
    mkdirSync(target, { recursive: true })
    try {
      if (linkType !== "dangling") writeFileSync(externalConfig, "{}\n")
      if (linkType === "dangling") createDanglingDirectoryLink(externalConfig, registryPath)
      else if (linkType === "symbolic") createFileLink(externalConfig, registryPath)
      else linkSync(externalConfig, registryPath)

      const install = runInstall(["--no-tui", "--global"], { HOME: home })
      assert.equal(install.success, false)
      assert.match(install.output, /Global OpenCode configuration must be an unlinked regular file/)
      assert.equal(existsSync(join(target, ".o4e")), false)
      assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), false)
      if (linkType !== "dangling") assert.equal(readFileSync(externalConfig, "utf8"), "{}\n")
      else assert.equal(existsSync(externalConfig), false)

      mkdirSync(join(target, ".o4e"), { recursive: true })
      mkdirSync(join(target, "plugins"), { recursive: true })
      writeFileSync(join(target, "plugins", "opencode-for-everything.ts"), "managed\n")
      const uninstall = runInstaller(["uninstall", "--no-tui", "--global"], { HOME: home })
      assert.equal(uninstall.success, false)
      assert.match(uninstall.output, /Global OpenCode configuration must be an unlinked regular file/)
      assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), true)
      if (linkType !== "dangling") assert.equal(readFileSync(externalConfig, "utf8"), "{}\n")
      else assert.equal(existsSync(externalConfig), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test("全局安装和卸载同时校验两个注册配置候选", () => {
  for (const linkType of ["symbolic", "hard", "dangling"]) {
    const home = join(tmpdir(), `o4e-global-secondary-registry-${linkType}-${Date.now()}`)
    const target = join(home, ".config", "opencode")
    const externalConfig = join(home, `external-${linkType}.jsonc`)
    const secondaryRegistry = join(target, "opencode.jsonc")
    mkdirSync(target, { recursive: true })
    try {
      writeFileSync(join(target, "opencode.json"), "{}\n")
      if (linkType !== "dangling") writeFileSync(externalConfig, "{}\n")
      if (linkType === "dangling") createDanglingDirectoryLink(externalConfig, secondaryRegistry)
      else if (linkType === "symbolic") createFileLink(externalConfig, secondaryRegistry)
      else linkSync(externalConfig, secondaryRegistry)

      const install = runInstall(["--no-tui", "--global"], { HOME: home })
      assert.equal(install.success, false)
      assert.match(install.output, /Global OpenCode configuration must be an unlinked regular file/)
      assert.equal(existsSync(join(target, ".o4e")), false)
      assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), false)

      mkdirSync(join(target, ".o4e"), { recursive: true })
      mkdirSync(join(target, "plugins"), { recursive: true })
      writeFileSync(join(target, "plugins", "opencode-for-everything.ts"), "managed\n")
      const uninstall = runInstaller(["uninstall", "--no-tui", "--global"], { HOME: home })
      assert.equal(uninstall.success, false)
      assert.match(uninstall.output, /Global OpenCode configuration must be an unlinked regular file/)
      assert.equal(existsSync(join(target, "plugins", "opencode-for-everything.ts")), true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test("安装、状态和卸载不检查 OpenCode 公共 Skill", () => {
  const target = join(tmpdir(), `o4e-runtime-linked-skill-${Date.now()}`)
  const runtimeSkill = join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")
  const externalSkill = join(target, "external-skill.md")
  const sentinel = join(target, ".o4e", "user-config.txt")
  mkdirSync(dirname(runtimeSkill), { recursive: true })
  mkdirSync(dirname(sentinel), { recursive: true })

  try {
    writeFileSync(externalSkill, "<!--opencode-for-everything-skill:o4e-agent-creator-->\nshared\n")
    linkSync(externalSkill, runtimeSkill)
    writeFileSync(sentinel, "preserve me\n")

    const install = runInstall(["--no-tui", "--target", target, "--force"])
    assert.equal(install.success, true)
    assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n")

    const status = runInstaller(["status", "--target", target])
    assert.equal(status.success, true)

    mkdirSync(join(target, ".opencode", "plugins"), { recursive: true })
    writeFileSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts"), "managed\n")
    const uninstall = runInstaller(["uninstall", "--no-tui", "--target", target])
    assert.equal(uninstall.success, true)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts")), false)
    assert.equal(readFileSync(externalSkill, "utf8"), "<!--opencode-for-everything-skill:o4e-agent-creator-->\nshared\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("JSONC 解析保留字符串中的注释标记", () => {
  const config = JSON.parse(stripJsonComments(`{
    // provider comment
    "endpoint": "https://example.test/v1",
    "label": "model // experimental",
    /* block comment */
    "quoted": "/* not a comment */"
  }`))

  assert.deepEqual(config, {
    endpoint: "https://example.test/v1",
    label: "model // experimental",
    quoted: "/* not a comment */",
  })
})
