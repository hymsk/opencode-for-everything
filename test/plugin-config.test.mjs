import assert from "node:assert/strict"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { copyInstalledDefaults, readConfigJson, resolveConfigPath, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { createFileLink } from "./helpers/fs-link-fixture.mjs"
import { deriveSelfEffects, legalAgentCandidates } from "../src/core/agent-routing.mjs"
import { loadRuntimeDefinition } from "../src/runtime-builder.mjs"
import { compilePermissionRules, evaluate } from "../src/core/permission-rules.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const nativeBuildAgent = "build"
const nativePlanAgent = "plan"
const { OpenCodeForEverythingPlugin } = await import("../src/plugin.ts")

test("agent 指令文件和工具列表完整覆盖全局配置，Skill 可强制关闭", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.instructionFiles = { global: [], project: ["global.md"] }
    runtimeConfig.loadTools = ["read", "skill"]
    writeConfigJson(configPath, runtimeConfig)
     const chatPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "chat.json")
     const chat = readConfigJson(join(target, ".o4e", "agents", "primary"), "chat.json")
     chat.systemPrompt = "test-system"
      chat.promptDir = "prompts"
      chat.injects = []
     chat.loadSkills = []
     chat.plan = { mode: "self" }
    chat.loadTools = ["bash", "skill"]
    chat.permission = { task: "allow" }
    chat.instructionFiles = { global: [], project: ["agent.md"] }
    writeConfigJson(chatPath, chat)
    writeFileSync(join(target, "global.md"), "global instructions")
    writeFileSync(join(target, "agent.md"), "agent instructions")
     writeFileSync(join(target, ".o4e", "prompts", "test-system.md"), "controlled system prompt")

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      instructions: ["existing.md"],
      agent: {},
      provider: {
        "fixture-deepseek": {
          models: {
            "zen/deepseek-v4-flash": {},
            "SiliconFlow/DeepSeek-V4-Flash": {},
            "SiliconFlow/DeepSeek-V4-Pro": {},
          },
        },
        "fixture-openai": {
          models: {
            "gpt-5.3-codex-spark": {},
            "gpt-5.4": {},
            "gpt-5.4-mini": {},
            "gpt-5.6-sol": {},
            "gpt-5.6-terra": {},
            "gpt-5.6-luna": {},
          },
        },
        "fixture-opencode": {
          models: {
            "zen/deepseek-v4-flash": {},
          },
        },
        "fixture-xiaomi": {
          models: {
            "Mimo/Mimo-V2.5": {},
            "Mimo/Mimo-V2.5-Pro": {},
            "zen/mimo-v2.5": {},
          },
        },
      },
    }

    await hooks.config(config)

    assert.deepEqual(config.instructions, ["existing.md"])
    assert.equal(config.agent["chat (plan)"].permission.bash, "deny")
    assert.equal(config.agent["chat (plan)"].permission.read, "deny")
     assert.deepEqual(config.agent["chat (plan)"].permission.skill, { "*": "deny" })
    assert.equal(config.agent["chat (plan)"].permission.invalid, "deny")
    assert.equal(config.agent["chat (plan)"].permission.task, "deny")
    assert.equal(config.agent.orchestrator.permission.read, "allow")
    assert.equal(config.agent.orchestrator.permission.bash, "allow")
    assert.equal(config.agent.orchestrator.permission.execute, "allow")
    assert.equal(config.agent.orchestrator.permission.write, undefined)
    assert.equal(config.agent.orchestrator.permission.skill, "allow")
     assert.equal(config.agent.orchestrator.permission.o4e_workflow, "deny")
    assert.equal("model" in config.agent.orchestrator, false)
    assert.equal("variant" in config.agent.orchestrator, false)
    assert.equal(config.agent["researcher (plan)"].permission.webfetch, "allow")
    assert.equal(config.agent["researcher (plan)"].permission.bash, "deny")
    assert.equal(config.agent["researcher (plan)"].permission.edit, "deny")
    assert.equal(config.agent["researcher (plan)"].permission.task["*"], "deny")
    assert.equal(config.agent["researcher (plan)"].permission.task["reviewer (plan)"], "allow")
    assert.equal(config.agent["researcher (plan)"].permission.task.chat, undefined)
    assert.equal("model" in config.agent["researcher (plan)"], false)
    assert.equal("variant" in config.agent["researcher (plan)"], false)
    assert.equal(config.agent.architect.permission.bash, "allow")
    assert.equal(config.agent.architect.permission.edit, "allow")
    assert.equal(config.agent.architect.permission.task["*"], "deny")
    assert.equal(config.agent.architect.permission.task["researcher (plan)"], "allow")
    assert.equal(config.agent.architect.permission.skill, "allow")
    assert.equal("model" in config.agent.architect, false)
    assert.equal("variant" in config.agent.architect, false)
    assert.equal(config.agent["architect (plan)"].permission.bash, "deny")
    assert.equal(config.agent["architect (plan)"].permission.edit, "deny")
    assert.equal(deriveSelfEffects({}, { permission: config.agent.architect.permission }).kind, "unknown-write")
    assert.equal(deriveSelfEffects({}, { permission: config.agent["architect (plan)"].permission }).kind, "read")
    assert.equal(deriveSelfEffects({}, { permission: config.agent["reviewer (plan)"].permission }).kind, "read")
    for (const name of ["read", "glob", "grep", "external_directory"]) assert.equal(config.agent.explore.permission[name], "allow")
    for (const name of ["bash", "edit", "execute", "task", "o4e_task", "o4e_workflow"]) assert.equal(config.agent.explore.permission[name], "deny")
     assert.equal(config.agent.tester.permission.o4e_workflow, "deny")

    const output = {
      system: [
        "OpenCode core system context",
        "<!--opencode-for-everything-agent:chat (plan)-->\nbase\nYou are powered by the model named test\nInstructions from: /native/AGENTS.md\nnative instructions",
        "Instructions from: /native/CLAUDE.md\nmore native instructions",
        "other native context",
      ],
    }
    await hooks["experimental.chat.system.transform"]({}, output)
    assert.match(output.system[0], /^<!--opencode-for-everything-soul:start-->/)
    assert.match(output.system[0], /# SOUL/)
    assert.match(output.system[0], /controlled system prompt/)
    assert.match(output.system[0], /agent instructions/)
    assert.doesNotMatch(output.system[0], /global instructions/)
    assert.doesNotMatch(output.system.join("\n"), /base|Instructions from:|native instructions|You are powered|other native context|OpenCode core system context/)
    assert.equal(output.system.length, 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("默认目录许可投影到主子角色和 Plan，既有配置的显式限制不被补写", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-permission-defaults-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    for (const override of [undefined, {}, { external_directory: "ask" }, { external_directory: "deny" }, "deny"]) {
      const path = join(target, ".o4e", "config.jsonc")
      const source = readConfigJson(join(target, ".o4e"), "config.json")
      if (override !== undefined) source.permission = override
      writeConfigJson(path, source)
      const before = readFileSync(path, "utf8")
      const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
      const config = { agent: {} }
      await hooks.config(config)
      for (const name of ["orchestrator", "orchestrator (plan)", "researcher (plan)", "architect", "architect (plan)", "explore", "general", "plan (plan)"]) {
        const expected = override === undefined ? "allow" : override === "deny" ? "deny" : override.external_directory ?? (name === "plan (plan)" ? "deny" : "ask")
        assert.equal(evaluate("external_directory", "/reference/*", compilePermissionRules(config.agent[name].permission)).action, expected, name)
      }
      for (const name of ["researcher (plan)", "architect (plan)", "explore", "orchestrator (plan)"]) {
        assert.equal(deriveSelfEffects({}, { permission: config.agent[name].permission }).kind, "read")
        for (const tool of ["edit", "bash", "execute"]) assert.equal(evaluate(tool, "*", compilePermissionRules(config.agent[name].permission)).action, "deny")
      }
      assert.equal(readFileSync(path, "utf8"), before)
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("config hook 将选中的 O4E 配置 Skill 目录置于显式 Skill paths 首位且保持幂等", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-skill-source-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const inheritedPath = join(target, "custom-skills")
    const config = {
      agent: {},
      skills: {
        paths: [inheritedPath],
        urls: ["https://example.com/skills/"],
      },
    }

    await hooks.config(config)
    await hooks.config(config)

    assert.deepEqual(config.skills, {
      paths: [join(target, ".o4e", "skills"), inheritedPath],
      urls: ["https://example.com/skills/"],
    })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("MCP 配置和白名单只向获授权 agent 暴露 MCP 工具", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-mcp-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.mcp = {
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        headers: { "CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}" },
      },
    }
    runtimeConfig.loadMcp = { context7: ["resolve-library-id"] }
    writeConfigJson(configPath, runtimeConfig)

    const orchestratorPath = resolveConfigPath(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    const orchestrator = readConfigJson(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    orchestrator.loadMcp = { context7: ["query-docs"] }
    writeConfigJson(orchestratorPath, orchestrator)
    const buildPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "build.json")
    const build = readConfigJson(join(target, ".o4e", "agents", "primary"), "build.json")
    build.loadMcp = { context7: ["resolve-library-id"] }
    writeConfigJson(buildPath, build)
    const chatPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "chat.json")
    const chat = readConfigJson(join(target, ".o4e", "agents", "primary"), "chat.json")
    chat.loadMcp = {}
    writeConfigJson(chatPath, chat)

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { mcp: { inherited: { type: "local", command: ["inherited"] } }, tools: { "inherited_*": true }, agent: {} }
    await hooks.config(config)

    assert.deepEqual(config.mcp.context7, runtimeConfig.mcp.context7)
    assert.deepEqual(config.mcp.inherited, { type: "local", command: ["inherited"] })
     assert.equal(config.permission["context7_*"], undefined)
     assert.equal(config.tools["inherited_*"], true)
     assert.equal(config.agent.orchestrator.permission["context7_*"], "deny")
     assert.equal(config.agent.orchestrator.permission["context7_query-docs"], "allow")
     assert.equal(config.agent.orchestrator.permission["context7_resolve-library-id"], undefined)
     assert.equal(config.agent.build.permission["context7_resolve-library-id"], "allow")
     assert.equal(config.agent["researcher (plan)"].permission["context7_resolve-library-id"], undefined)
     assert.equal(config.agent.architect.permission["context7_resolve-library-id"], undefined)
     assert.equal(config.agent["architect (plan)"].permission["context7_*"], "deny")
     assert.equal(config.agent["chat (plan)"].permission["context7_resolve-library-id"], undefined)
     assert.equal(config.agent["chat (plan)"].permission["context7_*"], "deny")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件热加载拒绝非 canonical permission 名称", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-invalid-permission-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.permission = { apply_patch: "deny" }
    writeConfigJson(configPath, runtimeConfig)

    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
      /请改用 edit/,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("系统提示词完全由 .o4e 接管，不保留 OpenCode 原生上下文", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.instructionFiles = { global: [], project: [] }
    writeConfigJson(configPath, runtimeConfig)

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = {
      system: [
        "OpenCode core system context",
        "<!--opencode-for-everything-agent:chat (plan)-->\nbase\nYou are powered by the model named test\nInstructions from: /native/AGENTS.md\nnative instructions",
        "Instructions from: /native/CLAUDE.md\nmore native instructions",
      ],
    }
    await hooks["experimental.chat.system.transform"]({}, output)

    assert.equal(output.system.length, 1)
    assert.match(output.system[0], /^<!--opencode-for-everything-soul:start-->/)
    assert.match(output.system[0], /纯对话助手/)
    assert.doesNotMatch(output.system[0], /opencode-for-everything-runtime:background-task-protocol/)
    assert.doesNotMatch(output.system.join("\n"), /Instructions from:|native instructions|You are powered|OpenCode core system context|You are opencode, an interactive CLI tool/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("build prompt 从用户文件读取并可热修改", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const buildPromptPath = join(target, ".o4e", "prompts", "cn", "primary", "build", "system.md")
    mkdirSync(dirname(buildPromptPath), { recursive: true })
    writeFileSync(buildPromptPath, "user build prompt")
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = {
      system: [
        `<!--opencode-for-everything-agent:${nativeBuildAgent}-->\nYou are powered by the model named test\nHere is some useful information about the environment\n<env>test</env>\nInstructions from: /native/CLAUDE.md\nnative instructions`,
      ],
    }

    await hooks["experimental.chat.system.transform"]({}, output)

    assert.equal(output.system.length, 1)
    assert.match(output.system[0], /^<!--opencode-for-everything-soul:start-->/)
    assert.match(output.system[0], /<!--opencode-for-everything-agent:build-->\nuser build prompt/)
    assert.match(output.system[0], /# O4E 后台 Task 协议/)
    assert.match(output.system[0], /action:"watch"/)
    assert.match(output.system[0], /action:"output"/)
    assert.doesNotMatch(output.system[0], /native instructions|You are powered|<env>test<\/env>/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("后台 Task 协议只注入实际可直接委派的 Agent，并遵从配置语言", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-background-task-protocol-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })

    const orchestrator = { system: ["<!--opencode-for-everything-agent:orchestrator-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, orchestrator)
    assert.match(orchestrator.system[0], /# O4E 后台 Task 协议/)
    const orchestratorPlan = { system: ["<!--opencode-for-everything-agent:orchestrator (plan)-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, orchestratorPlan)
    assert.match(orchestratorPlan.system[0], /# O4E 后台 Task 协议/)

    const delegatedOnly = { system: ["<!--opencode-for-everything-agent:general-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, delegatedOnly)
    assert.doesNotMatch(delegatedOnly.system[0], /opencode-for-everything-runtime:background-task-protocol/)

    const orchestratorPath = resolveConfigPath(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    const orchestratorConfig = readConfigJson(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    orchestratorConfig.plan.loadAgents = []
    writeConfigJson(orchestratorPath, orchestratorConfig)
    const planDisabledHooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const disabledPlan = { system: ["<!--opencode-for-everything-agent:orchestrator (plan)-->\nnative prompt"] }
    await planDisabledHooks["experimental.chat.system.transform"]({}, disabledPlan)
    assert.doesNotMatch(disabledPlan.system[0], /opencode-for-everything-runtime:background-task-protocol/)

    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.language = "en"
    writeConfigJson(configPath, runtimeConfig)
    const englishHooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const debuggerOutput = { system: ["<!--opencode-for-everything-agent:debugger-->\nnative prompt"] }
    await englishHooks["experimental.chat.system.transform"]({}, debuggerOutput)
    assert.match(debuggerOutput.system[0], /# O4E Background Task Protocol/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("workspace 上下文独立于委派权限，并区分 directory 与 project root", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "o4e-plugin-workspace-root-"))
  const directory = join(projectRoot, "nested")
  try {
    mkdirSync(directory)
    copyInstalledDefaults(componentRoot, directory)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory, worktree: projectRoot })
    await hooks.config({ agent: {} })

    for (const name of ["orchestrator", "orchestrator (plan)", "chat (plan)", "general"]) {
      const output = { system: [`<!--opencode-for-everything-agent:${name}-->\nnative prompt`] }
      await hooks["experimental.chat.system.transform"]({}, output)
      assert.match(output.system[0], /# O4E Workspace Context/)
      assert.ok(output.system[0].includes(`当前 workspace 目录是 \`${directory}\``), name)
      assert.ok(output.system[0].includes(`仓库\/项目规则根目录是 \`${projectRoot}\``), name)
    }

    const general = { system: ["<!--opencode-for-everything-agent:general-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, general)
    assert.doesNotMatch(general.system[0], /opencode-for-everything-runtime:background-task-protocol/)

    const untouched = { system: ["native keep prompt", "Instructions from: /native/AGENTS.md\nkeep"] }
    await hooks["experimental.chat.system.transform"]({}, untouched)
    assert.equal(untouched.system.length, 2)
    assert.match(untouched.system[0], /native keep prompt$/)
    assert.doesNotMatch(untouched.system.join("\n"), /# O4E Workspace Context/)
    assert.equal(untouched.system[1], "Instructions from: /native/AGENTS.md\nkeep")
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test("运行时严格拒绝链接配置树", async () => {
  for (const linkType of ["symbolic", "hard"]) {
    const target = mkdtempSync(join(tmpdir(), `o4e-plugin-linked-${linkType}-`))
    try {
      copyInstalledDefaults(componentRoot, target)
      const externalPrompt = join(target, "external-prompt.md")
      const chatPrompt = join(target, ".o4e", "prompts", "cn", "primary", "chat", "system.md")
      writeFileSync(externalPrompt, "external prompt content")
      rmSync(chatPrompt)
      if (linkType === "symbolic") createFileLink(externalPrompt, chatPrompt)
      else linkSync(externalPrompt, chatPrompt)

      await assert.rejects(
        OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
        /配置目录不能包含链接或特殊文件/,
      )

      rmSync(chatPrompt)
      writeFileSync(chatPrompt, "restored prompt")

      const externalAgent = join(target, "external-chat.jsonc")
      const chatAgent = join(target, ".o4e", "agents", "primary", "chat.jsonc")
      writeFileSync(externalAgent, readFileSync(chatAgent, "utf8"))
      rmSync(chatAgent)
      if (linkType === "symbolic") createFileLink(externalAgent, chatAgent)
      else linkSync(externalAgent, chatAgent)
      await assert.rejects(
        OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
        /配置目录不能包含链接或特殊文件/,
      )

      rmSync(chatAgent)
      writeFileSync(chatAgent, readFileSync(externalAgent, "utf8"))

      const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
      const externalConfig = join(target, "external-config.jsonc")
      writeFileSync(externalConfig, readFileSync(configPath, "utf8"))
      rmSync(configPath)
      if (linkType === "symbolic") createFileLink(externalConfig, configPath)
      else linkSync(externalConfig, configPath)
      await assert.rejects(
        OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
        /配置目录不能包含链接或特殊文件/,
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test("项目配置根存在时遮蔽全局配置并在错误时 fail closed", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-project-config-priority-"))
  const xdgConfigHome = join(target, "xdg")
  const globalConfigRoot = join(xdgConfigHome, "opencode", ".o4e")
  const projectConfigRoot = join(target, ".o4e")
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  try {
    copyInstalledDefaults(componentRoot, join(xdgConfigHome, "opencode"))
    const globalConfig = readConfigJson(globalConfigRoot, "config.json")
    globalConfig.mcp = { globalmarker: { type: "local", command: ["global"] } }
    writeConfigJson(resolveConfigPath(globalConfigRoot, "config.json"), globalConfig)
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    mkdirSync(projectConfigRoot)
    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
      /项目配置加载失败/,
    )

    rmSync(projectConfigRoot, { recursive: true })
    copyInstalledDefaults(componentRoot, target)
    const projectConfig = readConfigJson(projectConfigRoot, "config.json")
    projectConfig.mcp = { projectmarker: { type: "local", command: ["project"] } }
    writeConfigJson(resolveConfigPath(projectConfigRoot, "config.json"), projectConfig)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: {} }
    await hooks.config(config)
    assert.deepEqual(config.mcp.projectmarker, { type: "local", command: ["project"] })
    assert.equal(config.mcp.globalmarker, undefined)
    assert.deepEqual(config.skills.paths, [join(projectConfigRoot, "skills")])

    const nativeAgents = projectConfig.nativeAgents
    delete projectConfig.nativeAgents
    writeConfigJson(resolveConfigPath(projectConfigRoot, "config.json"), projectConfig)
    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
      /config\.nativeAgents 必须显式声明 build、plan、general 和 explore 策略/,
    )
    projectConfig.nativeAgents = nativeAgents
    writeConfigJson(resolveConfigPath(projectConfigRoot, "config.json"), projectConfig)

    writeFileSync(join(projectConfigRoot, "config.jsonc"), "{ invalid jsonc")
    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
      /项目配置加载失败: .*config\.jsonc/,
    )
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    rmSync(target, { recursive: true, force: true })
  }
})

test("项目配置根缺失时使用全局配置，全局配置错误时 fail closed", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-global-config-priority-"))
  const xdgConfigHome = join(target, "xdg")
  const globalConfigRoot = join(xdgConfigHome, "opencode", ".o4e")
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  try {
    copyInstalledDefaults(componentRoot, join(xdgConfigHome, "opencode"))
    const globalConfig = readConfigJson(globalConfigRoot, "config.json")
    globalConfig.mcp = { globalmarker: { type: "local", command: ["global"] } }
    writeConfigJson(resolveConfigPath(globalConfigRoot, "config.json"), globalConfig)
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: {} }
    await hooks.config(config)
    assert.deepEqual(config.mcp.globalmarker, { type: "local", command: ["global"] })
    assert.deepEqual(config.skills.paths, [join(globalConfigRoot, "skills")])

    writeFileSync(join(globalConfigRoot, "config.jsonc"), "{ invalid jsonc")
    await assert.rejects(
      OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target }),
      /全局配置加载失败: .*config\.jsonc/,
    )
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    rmSync(target, { recursive: true, force: true })
  }
})

test("项目 Agent 可显式加入额外 instruction file，chat 保持隔离", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-project-rules-"))
  try {
    copyInstalledDefaults(componentRoot, target)
     writeFileSync(join(target, "AGENTS.md"), "project engineering rules")
      const rulesPath = join(target, "docs", "project-rules.md")
      mkdirSync(dirname(rulesPath), { recursive: true })
      writeFileSync(rulesPath, "first acceptance contract")
      const orchestratorPath = resolveConfigPath(join(target, ".o4e", "agents", "all"), "orchestrator.json")
      const orchestratorConfig = readConfigJson(join(target, ".o4e", "agents", "all"), "orchestrator.json")
      orchestratorConfig.instructionFiles = { global: ["<default>"], project: ["<default>", "docs/project-rules.md"] }
      writeConfigJson(orchestratorPath, orchestratorConfig)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })

    const orchestrator = { system: ["<!--opencode-for-everything-agent:orchestrator-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, orchestrator)
    assert.match(orchestrator.system[0], /# project: AGENTS\.md\nproject engineering rules/)
    assert.match(orchestrator.system[0], /# project: docs\/project-rules\.md\nfirst acceptance contract/)
    assert.ok(orchestrator.system[0].indexOf("project engineering rules") < orchestrator.system[0].indexOf("first acceptance contract"))

    writeFileSync(rulesPath, "updated acceptance contract with more detail")
    const updated = { system: ["<!--opencode-for-everything-agent:orchestrator-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, updated)
    assert.match(updated.system[0], /updated acceptance contract with more detail/)

    const chat = { system: ["<!--opencode-for-everything-agent:chat (plan)-->\nnative prompt"] }
    await hooks["experimental.chat.system.transform"]({}, chat)
    assert.doesNotMatch(chat.system[0], /project engineering rules|acceptance contract/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("原生 plan 映射到统一后缀 Profile 且不重复注入 OpenCode reminder", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = {
      message: { id: "message-plan" },
      parts: [{ type: "text", text: "plan this work" }],
    }

    await hooks["chat.message"]({
      sessionID: "session-plan",
      agent: nativePlanAgent,
      model: { providerID: "fixture-deepseek", modelID: "zen/deepseek-v4-flash" },
    }, output)

    assert.equal(output.parts.length, 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("plan.mode=child 生成的 profile 自动注入可编辑原生 reminder，且不会重复", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
     copyInstalledDefaults(componentRoot, target)
     const orchestratorPath = resolveConfigPath(join(target, ".o4e", "agents", "all"), "orchestrator.json")
     const orchestratorConfig = readConfigJson(join(target, ".o4e", "agents", "all"), "orchestrator.json")
     orchestratorConfig.promptDir = "prompts"
     for (const prompt of [orchestratorConfig.systemPrompt, ...(orchestratorConfig.injects ?? [])]) {
       const source = join(target, ".o4e", "prompts", "cn", `${prompt}.md`)
       const destination = join(target, ".o4e", "prompts", `${prompt}.md`)
       mkdirSync(dirname(destination), { recursive: true })
       writeFileSync(destination, readFileSync(source, "utf8"))
     }
     writeConfigJson(orchestratorPath, orchestratorConfig)
     const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
     const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
     runtimeConfig.promptsDir = "prompts"
     writeConfigJson(configPath, runtimeConfig)
     const reminderPath = join(target, ".o4e", "prompts", "primary", "plan", "reminder.md")
    mkdirSync(dirname(reminderPath), { recursive: true })
    writeFileSync(reminderPath, `<system-reminder>\n# Plan Mode - System Reminder\nfirst reminder\n</system-reminder>\n`)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = {
       message: { id: "message-orchestrator-plan" },
      parts: [{ type: "text", text: "plan this implementation" }],
    }

    await hooks["chat.message"]({
       sessionID: "session-orchestrator-plan",
       agent: "orchestrator (plan)",
      model: { providerID: "provider", modelID: "model" },
    }, output)

    assert.equal(output.parts.length, 2)
    assert.match(output.parts[1].text, /first reminder/)
    assert.equal(output.parts[1].metadata.o4e.producer, "opencode-for-everything")

    const duplicate = {
       message: { id: "message-orchestrator-plan-duplicate" },
      parts: [{ type: "text", text: "continue" }, structuredClone(output.parts[1])],
    }
     await hooks["chat.message"]({
        sessionID: "session-orchestrator-plan",
        agent: "orchestrator (plan)",
      model: { providerID: "provider", modelID: "model" },
     }, duplicate)
    assert.equal(duplicate.parts.length, 2)
    assert.equal(duplicate.parts[1].text.match(/<system-reminder>/g)?.length, 1)

    writeFileSync(reminderPath, `<system-reminder>\n# Plan Mode - System Reminder\nupdated reminder\n</system-reminder>\n`)
     const updated = { message: { id: "message-orchestrator-plan-updated" }, parts: [{ type: "text", text: "continue" }] }
    await hooks["chat.message"]({
       sessionID: "session-orchestrator-plan-updated",
       agent: "orchestrator (plan)",
      model: { providerID: "provider", modelID: "model" },
    }, updated)
    assert.match(updated.parts[1].text, /updated reminder/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("切出 Plan Agent 后模型上下文会移除历史 plan reminder", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-plan-context-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const reminderPath = join(target, ".o4e", "prompts", "cn", "primary", "plan", "reminder.md")
    mkdirSync(dirname(reminderPath), { recursive: true })
    writeFileSync(reminderPath, `<system-reminder>\n# Plan Mode - System Reminder\nplan only\n</system-reminder>\n`)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const planMessage = { message: { id: "plan-message" }, parts: [{ type: "text", text: "plan this" }] }
    await hooks["chat.message"]({ sessionID: "session-plan-context", agent: "orchestrator (plan)", model: {} }, planMessage)
    assert.equal(planMessage.parts.some((part) => part.text?.includes("# Plan Mode - System Reminder")), true)

    const writableMessage = { message: { id: "writable-message" }, parts: [{ type: "text", text: "implement this" }] }
    await hooks["chat.message"]({ sessionID: "session-plan-context", agent: "orchestrator", model: {} }, writableMessage)
    const writableContext = { messages: [
      { info: { id: "plan-message", role: "user", agent: "orchestrator (plan)" }, parts: structuredClone(planMessage.parts) },
      { info: { id: "writable-message", role: "user", agent: "orchestrator" }, parts: structuredClone(writableMessage.parts) },
    ] }
    await hooks["experimental.chat.messages.transform"]({}, writableContext)
    assert.equal(writableContext.messages.flatMap((message) => message.parts).some((part) => part.text?.includes("# Plan Mode - System Reminder")), false)

    const finalWritable = { message: { id: "final-writable" }, parts: [{ type: "text", text: "write now" }] }
    await hooks["chat.message"]({ sessionID: "session-plan-context", agent: "orchestrator", model: {} }, finalWritable)
    const finalContext = { messages: [
      ...writableContext.messages,
      { info: { id: "final-writable", role: "user", agent: "orchestrator" }, parts: structuredClone(finalWritable.parts) },
    ] }
    await hooks["experimental.chat.messages.transform"]({}, finalContext)
    assert.equal(finalContext.messages.flatMap((message) => message.parts).some((part) => part.text?.includes("# Plan Mode - System Reminder")), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("普通用户正文中的完整 Plan reminder wrapper 不会被替换或移除", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-plan-user-text-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const reminderPath = join(target, ".o4e", "prompts", "cn", "primary", "plan", "reminder.md")
    mkdirSync(dirname(reminderPath), { recursive: true })
    writeFileSync(reminderPath, `<system-reminder>\n# Plan Mode - System Reminder\nmanaged reminder\n</system-reminder>\n`)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const userText = `<system-reminder>\n# Plan Mode - System Reminder\nThis is user-authored content.\n</system-reminder>`
    const planMessage = { message: { id: "plan-user-text" }, parts: [{ type: "text", text: userText }] }
    await hooks["chat.message"]({ sessionID: "session-plan-user-text", agent: "orchestrator (plan)", model: {} }, planMessage)
    assert.equal(planMessage.parts[0].text, userText)
    assert.equal(planMessage.parts.length, 2)
    assert.equal(planMessage.parts[0].metadata, undefined)
    assert.equal(planMessage.parts[1].metadata.o4e.producer, "opencode-for-everything")

    const writableContext = { messages: [
      {
        info: { id: "plan-user-text", role: "user", agent: "orchestrator (plan)" },
        parts: structuredClone(planMessage.parts),
      },
      {
        info: { id: "writable-user-text", role: "user", agent: "orchestrator" },
        parts: [{ type: "text", text: "implement now" }],
      },
    ] }
    await hooks["experimental.chat.messages.transform"]({}, writableContext)
    assert.deepEqual(writableContext.messages[0].parts, [{ type: "text", text: userText }])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("自定义 promptsDir 的 plan profile 从自定义目录读取 reminder", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
     runtimeConfig.promptsDir = "assets/prompts"
    writeConfigJson(configPath, runtimeConfig)
     const reminderPath = join(target, ".o4e", "assets", "prompts", "primary", "plan", "reminder.md")
    mkdirSync(dirname(reminderPath), { recursive: true })
    writeFileSync(reminderPath, `<system-reminder>\n# Plan Mode - System Reminder\nEnglish reminder\n</system-reminder>\n`)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = { message: { id: "message-orchestrator-plan-en" }, parts: [{ type: "text", text: "plan this implementation" }] }

    await hooks["chat.message"]({
      sessionID: "session-orchestrator-plan-en",
      agent: "orchestrator (plan)",
      model: { providerID: "provider", modelID: "model" },
    }, output)

    assert.match(output.parts[1].text, /English reminder/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeMode 别名可显式配置 plan messagePrompt", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    const planPath = resolveConfigPath(primaryRoot, `${nativePlanAgent}.json`)
     const plan = readConfigJson(primaryRoot, `${nativePlanAgent}.json`)
     plan.name = "custom-plan"
     plan.messagePrompt = "primary/plan/reminder"
      plan.promptDir = "prompts"
      plan.injects = []
     const reminderPath = join(target, ".o4e", "prompts", "primary", "plan", "reminder.md")
    mkdirSync(dirname(reminderPath), { recursive: true })
    writeFileSync(reminderPath, "<system-reminder>\n# Plan Mode - System Reminder\nGenerated reminder\n</system-reminder>\n")
    writeConfigJson(join(primaryRoot, "custom-plan.json"), plan)
    rmSync(planPath)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = { message: { id: "message-plan" }, parts: [{ type: "text", text: "plan this work" }] }

    await hooks["chat.message"]({
      sessionID: "session-plan",
      agent: nativePlanAgent,
      model: { providerID: "fixture-deepseek", modelID: "zen/deepseek-v4-flash" },
    }, output)

    assert.equal(output.parts.length, 2)
    assert.match(output.parts[1].text, /^<system-reminder>\n# Plan Mode - System Reminder/)
    assert.equal(output.parts[1].metadata.o4e.kind, "message-prompt")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeMode 根据主 agent 配置动态映射原生 build/plan", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    const buildPath = resolveConfigPath(primaryRoot, `${nativeBuildAgent}.json`)
    const planPath = resolveConfigPath(primaryRoot, `${nativePlanAgent}.json`)
    const build = readConfigJson(primaryRoot, `${nativeBuildAgent}.json`)
    const plan = readConfigJson(primaryRoot, `${nativePlanAgent}.json`)
    build.name = "custom-build"
    build.description = "custom build agent"
    plan.name = "custom-plan"
    plan.description = "custom plan agent"
    writeConfigJson(join(primaryRoot, "custom-build.json"), build)
    writeConfigJson(join(primaryRoot, "custom-plan.json"), plan)
    rmSync(buildPath)
    rmSync(planPath)

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      default_agent: "build",
      agent: {},
      provider: { "fixture-deepseek": { models: { "zen/deepseek-v4-flash": {} } } },
    }
    await hooks.config(config)

    assert.equal(config.default_agent, "custom-build")
    assert.deepEqual(config.agent.build, { disable: true })
    assert.deepEqual(config.agent.plan, { disable: true })
    assert.equal(config.agent["custom-plan (plan)"].mode, "primary")
    assert.equal(config.agent["custom-plan (plan)"].permission["*"], "deny")
    assert.equal(config.agent["custom-plan"], undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("纯对话 chat 无工具、候选或编排提示，主入口仍为 orchestrator", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-chat-isolation-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const runtime = loadRuntimeDefinition(join(target, ".o4e"))
    const chat = runtime.runtimeAgents.find(agent => agent.name === "chat (plan)")
    assert.equal(chat.planProfile, true)
    assert.equal(runtime.runtimeAgents.some(agent => agent.name === "chat"), false)
    assert.deepEqual(legalAgentCandidates({ requester: chat, agents: runtime.runtimeAgents }), [])
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: { "chat (plan)": { permission: { "*": "allow", task: "allow" } } }, mcp: { fixture: { type: "remote", url: "https://example.invalid/mcp" } } }
    await hooks.config(config)
    const rules = compilePermissionRules(config.agent["chat (plan)"].permission)
    for (const tool of ["task", "o4e_task", "o4e_workflow", "read", "bash", "edit", "skill", "fixture_query"]) {
      assert.equal(evaluate(tool, "*", rules).action, "deny", tool)
    }
    for (const language of ["cn", "en"]) {
      const file = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "chat.json")
      const definition = readConfigJson(join(target, ".o4e", "agents", "primary"), "chat.json")
      definition.promptDir = `prompts/${language}`
      writeConfigJson(file, definition)
      const languageHooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
      const output = { system: ["<!--opencode-for-everything-agent:chat (plan)-->\nAvailable agents: researcher, orchestrator"] }
      await languageHooks["experimental.chat.system.transform"]({}, output)
      assert.doesNotMatch(output.system.join("\n"), /researcher|orchestrator|shared\/task-authority|background-task-protocol/)
    }
  } finally { rmSync(target, { recursive: true, force: true }) }
})

test("默认主 Agent、子 Agent 与 Plan Profile 保持合法且不重复的 mode", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-all-plan-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: {}, provider: {} }

    await hooks.config(config)

    for (const name of ["architect", "architect (plan)", "debugger", "researcher (plan)", "reviewer (plan)", "tester"]) assert.equal(config.agent[name].mode, undefined)
    assert.equal(config.agent.researcher, undefined)
    assert.equal(config.agent.reviewer, undefined)
    assert.equal(config.agent.orchestrator.mode, undefined)
    assert.equal(config.agent["orchestrator (plan)"].mode, "all")
    assert.equal(config.agent["chat (plan)"].mode, "primary")
    assert.equal(config.agent.chat, undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeMode 映射目标可直接命名为 build，plan 统一映射到 plan (plan)", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      default_agent: "build",
      agent: {
        build: { prompt: "<!--opencode-for-everything-agent:build-->", disable: true },
        plan: { prompt: "host plan", disable: true },
        "plan (plan)": { prompt: "<!--opencode-for-everything-agent:plan (plan)-->", disable: true },
      },
      provider: { "fixture-deepseek": { models: { "zen/deepseek-v4-flash": {} } } },
    }

    await hooks.config(config)

    assert.equal(config.default_agent, "build")
    assert.equal(config.agent.build.disable, undefined)
    assert.deepEqual(config.agent.plan, { disable: true })
    assert.equal(config.agent["plan (plan)"].disable, undefined)
    assert.equal(config.agent["plan (plan)"].permission["*"], "deny")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeAgents 策略分别控制宿主原生 Agent 投影", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-native-policy-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const runtimeConfig = readConfigJson(configRoot, "config.json")
    runtimeConfig.nativeAgents = { build: "managed", plan: "keep", general: "disable", explore: "keep" }
    writeConfigJson(configPath, runtimeConfig)
    rmSync(join(configRoot, "agents", "primary", "plan.jsonc"))
    rmSync(join(configRoot, "agents", "subagent", "general.jsonc"))
    rmSync(join(configRoot, "agents", "subagent", "explore.jsonc"))

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      default_agent: "build",
      agent: {
        plan: { model: "host/plan" },
        general: { model: "host/general" },
        explore: { model: "host/explore" },
      },
      provider: { "fixture-deepseek": { models: { "zen/deepseek-v4-flash": {} } } },
    }

    await hooks.config(config)

    assert.equal(config.agent.build.disable, undefined)
    assert.deepEqual(config.agent.plan, { model: "host/plan" })
    assert.deepEqual(config.agent.general, { disable: true })
    assert.deepEqual(config.agent.explore, { model: "host/explore" })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("原生模式别名的消息策略遵从用户选中的 agent", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    const buildPath = resolveConfigPath(primaryRoot, `${nativeBuildAgent}.json`)
    const build = readConfigJson(primaryRoot, `${nativeBuildAgent}.json`)
    build.name = "custom-build"
    build.description = "custom build agent"
    build.messagePrompt = "test-message"
    writeConfigJson(join(primaryRoot, "custom-build.json"), build)
    rmSync(buildPath)
    writeFileSync(join(target, ".o4e", "prompts", "cn", "test-message.md"), "custom build message prompt")

    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = { message: { id: "message-build" }, parts: [{ type: "text", text: "implement this" }] }

    await hooks["chat.message"]({
      sessionID: "session-build",
      agent: nativeBuildAgent,
      model: { providerID: "fixture-deepseek", modelID: "zen/deepseek-v4-flash" },
    }, output)

    assert.equal(output.parts.length, 2)
    assert.equal(output.parts[1].text, "custom build message prompt")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("O4E-only 未指定默认入口时交由宿主选择", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-host-selection-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configRoot = join(target, ".o4e")
    const runtimeConfig = readConfigJson(configRoot, "config.json")
    runtimeConfig.nativeAgents = { build: "disable", plan: "disable", general: "disable", explore: "disable" }
    writeConfigJson(resolveConfigPath(configRoot, "config.json"), runtimeConfig)
    for (const [type, name] of [["primary", "build"], ["primary", "plan"], ["subagent", "general"], ["subagent", "explore"]]) {
      rmSync(resolveConfigPath(join(configRoot, "agents", type), `${name}.json`))
    }
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: {}, provider: {} }
    await hooks.config(config)
    assert.equal(config.default_agent, undefined)
    assert.equal(config.agent.build.disable, true)
    assert.equal(config.agent["orchestrator (plan)"].mode, "all")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("plan 只读权限在工具白名单之后强制生效", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const planPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), `${nativePlanAgent}.json`)
    const plan = readConfigJson(join(target, ".o4e", "agents", "primary"), `${nativePlanAgent}.json`)
    plan.loadTools = ["bash", "edit", "read"]
    writeConfigJson(planPath, plan)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = { agent: { "plan (plan)": {} }, provider: {} }

    await hooks.config(config)

    assert.equal(config.agent["plan (plan)"].permission.bash, "deny")
    assert.equal(config.agent["plan (plan)"].permission.edit, "deny")
    assert.equal(config.agent["plan (plan)"].permission.write, undefined)
    assert.equal(config.agent["plan (plan)"].permission.read, "allow")
    assert.equal(config.agent["plan (plan)"].permission.task, "deny")
    assert.equal(config.agent["plan (plan)"].permission["*"], "deny")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("固定系统内部阶段从 agents/system 读取，并支持独立覆盖", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const titlePath = resolveConfigPath(join(target, ".o4e", "agents", "system"), "title.json")
    const title = readConfigJson(join(target, ".o4e", "agents", "system"), "title.json")
    title.systemPrompt = "test-system"
    title.instructionFiles = {
      global: [],
      project: ["native.md"],
    }
    title.loadTools = ["read", "skill"]
     title.loadSkills = []
    writeConfigJson(titlePath, title)
    writeFileSync(join(target, ".o4e", "prompts", "cn", "test-system.md"), "controlled title prompt")
    writeFileSync(join(target, "native.md"), "native instructions")
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const config = {
      agent: {},
      provider: {
        "fixture-deepseek": {
          models: {
            "zen/deepseek-v4-flash": {},
          },
        },
        "fixture-openai": {
          models: {
            "gpt-5.6-sol": {},
          },
        },
      },
    }
    await hooks.config(config)

    assert.equal(config.agent.title.prompt, "<!--opencode-for-everything-system-agent:title-->")
    assert.equal(config.agent.title.permission.read, "allow")
     assert.deepEqual(config.agent.title.permission.skill, { "*": "deny" })
    for (const name of ["task", "o4e_task", "o4e_workflow"]) {
      assert.equal(config.agent.title.permission[name], "deny")
    }
    assert.deepEqual(config.agent.general.permission, {
      external_directory: "allow",
      task: "deny",
      o4e_task: { "*": "deny", "command:*": "allow" },
      o4e_workflow: "deny",
    })

    const output = {
      system: [
        "OpenCode native title prompt",
        config.agent.title.prompt,
        "native environment and tool context",
      ],
    }
    await hooks["experimental.chat.system.transform"]({}, output)

    assert.equal(output.system.length, 1)
    assert.match(output.system[0], /^<!--opencode-for-everything-soul:start-->/)
    assert.match(output.system[0], /# SOUL/)
    assert.match(output.system[0], /controlled title prompt/)
    assert.match(output.system[0], /native instructions/)
    assert.doesNotMatch(output.system.join("\n"), /OpenCode native|native environment/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("soul 可显式关闭", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const runtimeConfig = readConfigJson(join(target, ".o4e"), "config.json")
    runtimeConfig.soul.enabled = false
    writeConfigJson(configPath, runtimeConfig)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = { system: ["<!--opencode-for-everything-agent:chat (plan)-->\nnative prompt"] }

    await hooks["experimental.chat.system.transform"]({}, output)

    assert.doesNotMatch(output.system[0], /opencode-for-everything-soul|# SOUL/)
    assert.match(output.system[0], /纯对话助手/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("插件重复 transform 时 soul 仍只保留一份", async () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-plugin-"))
  try {
    copyInstalledDefaults(componentRoot, target)
    const hooks = await OpenCodeForEverythingPlugin({ client: {}, directory: target, worktree: target })
    const output = { system: ["<!--opencode-for-everything-agent:chat (plan)-->\nnative prompt"] }
    const systemReference = output.system

    await hooks["experimental.chat.system.transform"]({}, output)
    await hooks["experimental.chat.system.transform"]({}, output)

    assert.equal(output.system, systemReference)
    assert.equal(output.system.length, 1)
    assert.equal(output.system[0].match(/<!--opencode-for-everything-soul:start-->/g)?.length, 1)
    assert.equal(output.system[0].match(/<!--opencode-for-everything-soul:end-->/g)?.length, 1)
    assert.match(output.system[0], /纯对话助手/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
