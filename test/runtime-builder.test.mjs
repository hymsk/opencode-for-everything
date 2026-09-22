import assert from "node:assert/strict"
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildRuntime, loadRuntimeDefinition } from "../src/runtime-builder.mjs"
import { legalAgentCandidates } from "../src/core/agent-routing.mjs"
import { copyInstalledDefaults, readConfigJson, resolveConfigPath, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { createDirectoryLink, createFileLink } from "./helpers/fs-link-fixture.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const nativeBuildAgent = "build"
const nativePlanAgent = "plan"

function createTarget() {
  const target = mkdtempSync(join(tmpdir(), "o4e-build-"))
  copyInstalledDefaults(componentRoot, target)
  return target
}

function build(target) {
  return buildRuntime({ target })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function assertBuildFails(target, pattern) {
  assert.throws(() => build(target), pattern)
}

test("项目级构建要求显式指定目标目录", () => {
  assert.throws(() => {
    try {
       execFileSync(process.execPath, [join(componentRoot, "scripts", "installer.mjs"), "build"], {
        cwd: componentRoot,
        stdio: "pipe",
      })
    } catch (error) {
      throw new Error(error.stderr.toString())
    }
  }, /Project-level build requires --target to specify the target directory/)
})

test("pnpm override 版本比较符保留用户配置且不能绕过 parser 精确版本", (t) => {
  const target = createTarget()
  t.after(() => rmSync(target, { recursive: true, force: true }))
  const runtimeRoot = join(target, ".opencode")
  mkdirSync(runtimeRoot)
  const packagePath = join(runtimeRoot, "package.json")
  const original = {
    private: true,
    pnpm: { overrides: {
      "left-pad@>=1": "1.3.0",
      "left-pad@>1": "1.3.0",
      "left-pad@>v1": "1.3.0",
      "left-pad@1 || >2": "1.3.0",
      "@scope/parent@>= 1 <2>left-pad@>=1": "1.3.0",
      "parent@> 1>left-pad@>= 1": "1.3.0",
      "parent>123-package": "1.3.0",
      "tree-sitter-bash@>=0.20>left-pad@>=1": "1.3.0",
      "tree-sitter-bash@>=0.20": "0.25.0",
      "parent@>=1>web-tree-sitter@>=0.20": "0.25.10",
    } },
  }
  writeFileSync(packagePath, JSON.stringify(original))
  build(target)
  assert.deepEqual(readJson(packagePath), {
    ...original,
    dependencies: {
      "@opencode-ai/plugin": "1.18.21",
      effect: "4.0.0-beta.83",
      "tree-sitter-bash": "0.25.0",
      "web-tree-sitter": "0.25.10",
    },
  })

  for (const selector of ["tree-sitter-bash@>=0.20", "123-parent@>=1>web-tree-sitter@>0.20"]) {
    const content = JSON.stringify({ pnpm: { overrides: { [selector]: "0.24.0" } } })
    writeFileSync(packagePath, content)
    assertBuildFails(target, /Bash parser 依赖冲突/)
    assert.equal(readFileSync(packagePath, "utf8"), content)
  }
})

test("生成运行时 manifest 固化插件与 Effect 依赖", () => {
  const target = createTarget()
  try {
    build(target)
    assert.deepEqual(readJson(join(target, ".opencode", "package.json")).dependencies, {
      "@opencode-ai/plugin": "1.18.21",
      effect: "4.0.0-beta.83",
      "tree-sitter-bash": "0.25.0",
      "web-tree-sitter": "0.25.10",
    })

    const packagePath = join(target, ".opencode", "package.json")
    writeFileSync(packagePath, JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.18.29", effect: "3.22.2" } }))
    build(target)
    assert.deepEqual(readJson(packagePath).dependencies, {
      "@opencode-ai/plugin": "1.18.29",
      effect: "3.22.2",
      "tree-sitter-bash": "0.25.0",
      "web-tree-sitter": "0.25.10",
    })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("四类 agent 配置是构建唯一来源", async () => {
  const target = createTarget()
  try {
    const definition = loadRuntimeDefinition(join(target, ".o4e"))
    assert.deepEqual(legalAgentCandidates({
      requester: { loadAgents: ["*"] },
      agents: definition.runtimeAgents.filter((agent) => agent.name === "tester"),
      required: definition.workflows.get("test-design").steps[0],
    }).map((entry) => entry.id), ["tester"])
    const userRootModule = join(target, ".opencode", "plugins", "user-module.mjs")
    mkdirSync(join(target, ".opencode", "plugins"), { recursive: true })
    writeFileSync(userRootModule, "user module")
    const componentRoot = join(target, ".opencode", "plugins", "opencode-for-everything")
    mkdirSync(join(componentRoot, "core"), { recursive: true })
    mkdirSync(join(componentRoot, "adapters", "opencode"), { recursive: true })
    writeFileSync(join(componentRoot, "stale-module.mjs"), "stale module")
    writeFileSync(join(componentRoot, "core", "stale-module.mjs"), "stale core module")
    writeFileSync(join(componentRoot, "adapters", "opencode", "stale-module.mjs"), "stale adapter module")

    execFileSync(process.execPath, [join(import.meta.dirname, "../scripts/installer.mjs"), "build", "--target", target], { stdio: "pipe" })
    assert.equal(typeof (await import(pathToFileURL(join(componentRoot, "soul.mjs")).href)).createSoulHandler, "function")

    const managedBuild = readFileSync(join(target, ".opencode", "agents", `${nativeBuildAgent}.md`), "utf8")
    const general = readFileSync(join(target, ".opencode", "agents", "general.md"), "utf8")
    assert.match(managedBuild, /mode: primary/)
    assert.doesNotMatch(managedBuild, /^model:|^variant:/m)
    assert.match(managedBuild, /<!--opencode-for-everything-agent:build-->/)
    assert.doesNotMatch(managedBuild, /# Soul|opencode-for-everything-soul/)
    assert.match(general, /mode: subagent/)
    assert.match(general, /<!--opencode-for-everything-agent:general-->/)
    for (const name of ["build", "plan (plan)", "orchestrator", "architect", "architect (plan)", "reviewer (plan)", "researcher (plan)", "chat (plan)", "debugger", "tester", "general", "explore"]) {
      assert.equal(existsSync(join(target, ".opencode", "agents", `${name}.md`)), true)
    }
    for (const name of ["reviewer", "researcher"]) assert.equal(existsSync(join(target, ".opencode", "agents", `${name}.md`)), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "plan.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "chat.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "architect-plan.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "orchestrator (plan).md")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "researcher-plan.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "agents", "title.md")), false)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts")), true)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything", "agent-layout.mjs")), true)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything", "prompt-file.mjs")), true)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything", "runtime-builder.mjs")), true)
    assert.equal(existsSync(join(componentRoot, "stale-module.mjs")), false)
    assert.equal(existsSync(join(componentRoot, "core", "stale-module.mjs")), false)
    assert.equal(existsSync(join(componentRoot, "adapters", "opencode", "stale-module.mjs")), false)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything", "adapters", "opencode", "plugin-hooks.ts")), true)
     assert.match(readFileSync(join(target, ".o4e", "skills", "o4e-agent-creator", "SKILL.md"), "utf8"), /opencode-for-everything-skill:o4e-agent-creator/)
    assert.equal(readFileSync(userRootModule, "utf8"), "user module")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeAgents 混合策略要求并生成对应的受管 Agent", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const config = readConfigJson(configRoot, "config.json")
    config.nativeAgents = { build: "keep", plan: "disable", general: "keep", explore: "disable" }
    writeConfigJson(configPath, config)
    for (const [type, name] of [["primary", "build"], ["primary", "plan"], ["subagent", "general"], ["subagent", "explore"]]) {
      rmSync(join(configRoot, "agents", type, `${name}.jsonc`), { force: true })
    }

    build(target)

    const runtimeAgents = join(target, ".opencode", "agents")
    assert.equal(existsSync(join(runtimeAgents, "build.md")), false)
    assert.equal(existsSync(join(runtimeAgents, "plan.md")), false)
    assert.equal(existsSync(join(runtimeAgents, "general.md")), false)
    assert.equal(existsSync(join(runtimeAgents, "explore.md")), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeAgents 的 managed 策略拒绝缺少受管 Agent", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const config = readConfigJson(configRoot, "config.json")
    config.nativeAgents = { build: "managed", plan: "managed", general: "managed", explore: "managed" }
    writeConfigJson(configPath, config)
    rmSync(join(configRoot, "agents", "primary", "build.jsonc"))

    assertBuildFails(target, /config\.nativeAgents\.build 为 managed 时必须存在对应的受管 Agent 配置/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("config 必须显式声明 nativeAgents", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const config = readConfigJson(configRoot, "config.json")
    delete config.nativeAgents
    writeConfigJson(configPath, config)

    assertBuildFails(target, /config\.nativeAgents 必须显式声明 build、plan、general 和 explore 策略/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 Skill registry 不属于用户配置", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const original = readConfigJson(configRoot, "config.json")

    delete original.managedSkills
    writeConfigJson(configPath, original)
    assert.doesNotThrow(() => build(target))

    writeConfigJson(configPath, { ...original, managedSkills: ["unexpected-user-field"] })
    assertBuildFails(target, /config\.json 不支持字段: managedSkills/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("loadSkills 使用名称 allowlist，拒绝布尔值、重复项和混合通配符", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const configPath = resolveConfigPath(configRoot, "config.json")
    const original = readConfigJson(configRoot, "config.json")

    writeConfigJson(configPath, { ...original, loadSkills: true })
    assertBuildFails(target, /config\.loadSkills 必须是 Skill 名称数组/)

    writeConfigJson(configPath, { ...original, loadSkills: ["one", "one"] })
    assertBuildFails(target, /config\.loadSkills 不能包含重复 Skill 名称/)

    writeConfigJson(configPath, { ...original, loadSkills: ["*", "one"] })
    assertBuildFails(target, /config\.loadSkills 使用 \* 时不能同时声明其他 Skill 名称/)

    writeConfigJson(configPath, { ...original, loadSkills: ["one", "two"] })
    assert.doesNotThrow(() => build(target))

    const chatRoot = join(configRoot, "agents", "primary")
    const chatPath = resolveConfigPath(chatRoot, "chat.json")
    const chat = readConfigJson(chatRoot, "chat.json")
    chat.loadSkills = false
    writeConfigJson(chatPath, chat)
    assertBuildFails(target, /primary\/chat\.jsonc?\.loadSkills 必须是 Skill 名称数组/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装目标残留默认 Agent catalog 时构建失败", () => {
  const target = createTarget()
  try {
    cpSync(
      join(componentRoot, "defaults", ".o4e", "agents", "default.jsonc"),
      join(target, ".o4e", "agents", "default.jsonc"),
    )

    assertBuildFails(target, /agents\/default\.jsonc 仅属于仓库默认模板/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("具体 Agent 必须声明 description，不需要排序字段", () => {
  const target = createTarget()
  try {
    const chatRoot = join(target, ".o4e", "agents", "primary")
    const chatPath = resolveConfigPath(chatRoot, "chat.json")
    const chat = readConfigJson(chatRoot, "chat.json")
    delete chat.description
    writeConfigJson(chatPath, chat)
    assertBuildFails(target, /primary\/chat\.jsonc?\.description 必须是非空字符串/)

    chat.description = "chat"
    writeConfigJson(chatPath, chat)
    assert.doesNotThrow(() => build(target))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建直接校验配置 Skill，保留内容并拒绝缺失或无效的受管 Skill", () => {
  const target = createTarget()
  try {
    build(target)
    const sourcePath = join(target, ".o4e", "skills", "o4e-agent-creator", "SKILL.md")
    const runtimePath = join(target, ".o4e", "skills", "o4e-agent-creator", "SKILL.md")
    const customized = `${readFileSync(sourcePath, "utf8")}\nUser-maintained extension.\n`
    writeFileSync(sourcePath, customized)
    build(target)
    assert.equal(readFileSync(runtimePath, "utf8"), customized)
     assert.equal(existsSync(join(target, ".o4e", "skills", "o4e-agent-creator", "references", "schemas.md")), true)
     assert.equal(existsSync(join(target, ".o4e", "skills", "o4e-agent-creator", "agents", "grader.md")), true)
     assert.equal(existsSync(join(target, ".o4e", "skills", "o4e-agent-creator", "evals", "evals.json")), true)

    writeFileSync(runtimePath, "unmanaged skill\n")
     assertBuildFails(target, /受管 Skill 缺少匹配名称 marker/)

    rmSync(runtimePath)
    assertBuildFails(target, /Skill 必须是独立普通文件/)

     rmSync(dirname(runtimePath), { recursive: true, force: true })
     assert.doesNotThrow(() => build(target))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建保留用户 Skill 文本和二进制内容", () => {
  const target = createTarget()
  try {
     const skillsRoot = join(target, ".o4e", "skills")
    mkdirSync(join(skillsRoot, "second-skill"), { recursive: true })
    writeFileSync(join(skillsRoot, "second-skill", "SKILL.md"), "---\nname: second-skill\ndescription: test skill\n---\n<!--opencode-for-everything-skill:second-skill-->\nsecond\n")
    mkdirSync(join(skillsRoot, "second-skill", "references"), { recursive: true })
    writeFileSync(join(skillsRoot, "second-skill", "references", "guide.md"), "guide\n")
    const binary = Buffer.from([0, 255, 128, 1, 2, 3])
     writeFileSync(join(skillsRoot, "second-skill", "references", "asset.bin"), binary)
      build(target)
     assert.equal(existsSync(join(target, ".opencode", "skills")), false)
     assert.equal(existsSync(join(target, ".o4e", "skills", "second-skill", "references", "guide.md")), true)
     assert.deepEqual(readFileSync(join(target, ".o4e", "skills", "second-skill", "references", "asset.bin")), binary)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("受管 Skill 拒绝通过符号链接覆盖项目外文件", () => {
  const target = createTarget()
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-skill-"))
  const externalSkillDir = join(externalRoot, "o4e-agent-creator")
  const externalSkill = join(externalSkillDir, "SKILL.md")
     const runtimeSkill = join(target, ".opencode", "skills", "o4e-agent-creator", "SKILL.md")
  try {
    mkdirSync(dirname(runtimeSkill), { recursive: true })
    rmSync(dirname(runtimeSkill), { recursive: true, force: true })
    mkdirSync(externalSkillDir, { recursive: true })
    writeFileSync(externalSkill, "<!--opencode-for-everything-skill:o4e-agent-creator-->\nexternal\n")
    createDirectoryLink(externalSkillDir, dirname(runtimeSkill))

     build(target)
     assert.match(readFileSync(externalSkill, "utf8"), /external/)
     assert.equal(existsSync(runtimeSkill), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("构建拒绝符号链接运行时根目录", () => {
  const target = createTarget()
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-runtime-"))
  try {
    createDirectoryLink(externalRoot, join(target, ".opencode"))
    assertBuildFails(target, /运行时根目录必须是普通目录，拒绝覆盖/)
    assert.deepEqual(readdirSync(externalRoot), [])
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("构建拒绝组件运行时目录中的符号链接，并保留项目外文件", () => {
  const target = createTarget()
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-component-"))
  const externalFile = join(externalRoot, "plugin-hooks.ts")
  const linkedDirectory = join(target, ".opencode", "plugins", "opencode-for-everything", "adapters")
  try {
    mkdirSync(dirname(linkedDirectory), { recursive: true })
    mkdirSync(externalRoot, { recursive: true })
    writeFileSync(externalFile, "external component\n")
    createDirectoryLink(externalRoot, linkedDirectory)

    assertBuildFails(target, /组件运行时目录必须是普通目录，拒绝覆盖/)
    assert.equal(readFileSync(externalFile, "utf8"), "external component\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("构建不触碰共享 plugin 目录中的非受管文件", () => {
  const target = createTarget()
  const sharedFiles = [
    join(target, ".opencode", "plugins", "adapters", "shared.mjs"),
    join(target, ".opencode", "plugins", "core", "shared.mjs"),
    join(target, ".opencode", "plugins", "runtime", "shared.mjs"),
  ]
  try {
    for (const path of sharedFiles) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "user plugin\n")
    }
    build(target)
    for (const path of sharedFiles) assert.equal(readFileSync(path, "utf8"), "user plugin\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝链接配置源和生成叶子文件", () => {
  const target = createTarget()
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-files-"))
  const externalPrompt = join(externalRoot, "prompt.md")
  const externalRuntime = join(externalRoot, "runtime.md")
  try {
    writeFileSync(externalPrompt, "external prompt\n")
    const promptPath = join(target, ".o4e", "prompts", "cn", "all", "orchestrator", "system.md")
    rmSync(promptPath)
    createFileLink(externalPrompt, promptPath)
    assertBuildFails(target, /配置目录不能包含链接或特殊文件/)

    rmSync(promptPath)
    writeFileSync(promptPath, "local prompt\n")
    mkdirSync(join(target, ".opencode", "agents"), { recursive: true })
    writeFileSync(externalRuntime, "external runtime\n")
    createFileLink(externalRuntime, join(target, ".opencode", "agents", "build.md"))
    assertBuildFails(target, /生成目标必须是独立普通文件，拒绝覆盖/)
    assert.equal(readFileSync(externalRuntime, "utf8"), "external runtime\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("构建拒绝硬链接配置源和生成叶子文件", () => {
  const target = createTarget()
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-hardlinks-"))
  const externalConfig = join(externalRoot, "config.jsonc")
  const externalRuntime = join(externalRoot, "runtime.md")
  try {
    writeFileSync(externalConfig, "external config\n")
    linkSync(externalConfig, join(target, ".o4e", "linked-config.jsonc"))
    assertBuildFails(target, /配置目录不能包含链接或特殊文件/)

    rmSync(join(target, ".o4e", "linked-config.jsonc"))
    mkdirSync(join(target, ".opencode", "agents"), { recursive: true })
    writeFileSync(externalRuntime, "external runtime\n")
    linkSync(externalRuntime, join(target, ".opencode", "agents", "build.md"))
    assertBuildFails(target, /生成目标必须是独立普通文件，拒绝覆盖/)
    assert.equal(readFileSync(externalRuntime, "utf8"), "external runtime\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("构建在任何写入前预检全部生成目标", () => {
  const target = createTarget()
  const externalRuntime = join(target, "external-runtime.mjs")
  try {
    build(target)
    const subagentRoot = join(target, ".o4e", "agents", "subagent")
    const added = readConfigJson(subagentRoot, "general.json")
    added.name = "zz-added"
    added.description = "late generated target"
    writeConfigJson(join(subagentRoot, "zz-added.json"), added)

    const blockedTarget = join(target, ".opencode", "plugins", "opencode-for-everything", "prompt-file.mjs")
    rmSync(blockedTarget)
    writeFileSync(externalRuntime, "external runtime\n")
    linkSync(externalRuntime, blockedTarget)

    assertBuildFails(target, /组件运行时目录必须是普通目录，拒绝覆盖/)
    assert.equal(existsSync(join(target, ".opencode", "agents", "zz-added.md")), false)
    assert.equal(readFileSync(externalRuntime, "utf8"), "external runtime\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("plan.mode=child 生成 Plan Profile，并拒绝括号源名称", () => {
  const target = createTarget()
  try {
    build(target)
    const orchestratorPlan = readFileSync(join(target, ".opencode", "agents", "orchestrator (plan).md"), "utf8")
    assert.match(orchestratorPlan, /name: orchestrator \(plan\)/)
    assert.match(orchestratorPlan, /description: .* \(plan\)/)
    assert.match(orchestratorPlan, /<!--opencode-for-everything-agent:orchestrator \(plan\)-->/)
    assert.match(orchestratorPlan, /工程执行与编排/)

    const primaryRoot = join(target, ".o4e", "agents", "primary")
    writeConfigJson(join(primaryRoot, "invalid.json"), {
      "$schema": "../../schemas/primary-agent.schema.json",
      name: "invalid (plan)",
      description: "invalid source name",
      systemPrompt: "primary/chat/system",
    })
    assertBuildFails(target, /name 只能包含小写字母、数字和连字符/)
    rmSync(join(primaryRoot, "invalid.json"))

    writeConfigJson(join(primaryRoot, "custom.json"), {
      "$schema": "../../schemas/primary-agent.schema.json",
      name: "custom",
      description: "custom primary",
      systemPrompt: "primary/chat/system",
    })
    assert.doesNotThrow(() => build(target))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("loadAgents 接受 child Plan 引用，loadWorkflows 拒绝 Plan 后缀", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.loadAgents = ["orchestrator (plan)"]
    config.loadWorkflows = ["feature-development (plan)"]
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.loadWorkflows\[0\] 只能是 \* 或小写 Workflow 名称/)

    config.loadWorkflows = ["feature-development"]
    writeConfigJson(configPath, config)
    assert.doesNotThrow(() => build(target))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("Agent 引用拒绝历史大写 Plan 后缀", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.loadAgents = ["orchestrator (Plan)"]
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.loadAgents\[0\] 只能是 \* 或小写 Agent 名称或其 \(plan\) Profile/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("Agent 配置保留 model、variant 和 fallbackModels 并生成 self Plan", () => {
  const target = createTarget()
  try {
    const chatPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "chat.json")
    const chat = readConfigJson(join(target, ".o4e", "agents", "primary"), "chat.json")
    chat.model = { id: "provider/model", variant: "high" }
    chat.fallbackModels = [{ id: "provider/fallback", variant: "low" }]
    writeConfigJson(chatPath, chat)
    build(target)
    const generated = readFileSync(join(target, ".opencode/agents/chat (plan).md"), "utf8")
    assert.match(generated, /model: provider\/model\nvariant: high/)
    chat.model = "invalid"
    writeConfigJson(chatPath, chat)
    assertBuildFails(target, /provider\/model/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("subagent Plan 展开继承模型 variant，且不进入可选择 defaultAgent", () => {
  const target = createTarget()
  try {
    const configRoot = join(target, ".o4e")
    const architectPath = resolveConfigPath(join(configRoot, "agents", "subagent"), "architect.json")
    const architect = readConfigJson(join(configRoot, "agents", "subagent"), "architect.json")
    architect.model = { id: "provider/architect", variant: "high" }
    writeConfigJson(architectPath, architect)

    const definition = loadRuntimeDefinition(configRoot)
    const source = definition.runtimeAgents.find((agent) => agent.name === "architect")
    const plan = definition.runtimeAgents.find((agent) => agent.name === "architect (plan)")
    assert.deepEqual(source.model, { id: "provider/architect", variant: "high" })
    assert.deepEqual(plan.model, source.model)

    const configPath = resolveConfigPath(configRoot, "config.json")
    const config = readConfigJson(configRoot, "config.json")
    config.defaultAgent = "architect (plan)"
    writeConfigJson(configPath, config)
    assertBuildFails(target, /可选 all\/primary Agent/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("config 默认模型由 Agent 继承且校验 fallbackModels", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.defaultModel = { id: "provider/default", variant: "low" }
    config.fallbackModels = ["provider/fallback"]
    writeConfigJson(configPath, config)
    build(target)
    assert.match(readFileSync(join(target, ".opencode/agents/orchestrator.md"), "utf8"), /model: provider\/default\nvariant: low/)
    config.fallbackModels = ["invalid"]
    writeConfigJson(configPath, config)
    assertBuildFails(target, /provider\/model/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("全局委派深度默认 2，接受有限配置并拒绝非法值和 Agent 覆盖", (t) => {
  const target = createTarget()
  t.after(() => rmSync(target, { recursive: true, force: true }))
  const configRoot = join(target, ".o4e")
  const configPath = resolveConfigPath(configRoot, "config.json")
  const config = readConfigJson(configRoot, "config.json")

  delete config.maxDelegationDepth
  writeConfigJson(configPath, config)
  assert.equal(loadRuntimeDefinition(configRoot).config.maxDelegationDepth, 2)

  for (const value of [1, 5]) {
    config.maxDelegationDepth = value
    writeConfigJson(configPath, config)
    assert.equal(loadRuntimeDefinition(configRoot).config.maxDelegationDepth, value)
  }
  for (const value of [null, 0, 6, 1.5, "2"]) {
    config.maxDelegationDepth = value
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.maxDelegationDepth/)
  }

  config.maxDelegationDepth = 2
  writeConfigJson(configPath, config)
  const workerRoot = join(configRoot, "agents", "subagent")
  const workerPath = resolveConfigPath(workerRoot, "general.json")
  const worker = readConfigJson(workerRoot, "general.json")
  worker.maxDelegationDepth = 5
  writeConfigJson(workerPath, worker)
  assertBuildFails(target, /subagent\/general\.jsonc? 不支持字段: maxDelegationDepth/)
})

test("构建校验 Background Task 全局配置和 Agent 重试覆盖", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.backgroundTasks = { maxRetries: 2, maxConcurrentAgents: 1, maxConcurrentCommands: 3 }
    writeConfigJson(configPath, config)

    const workerPath = resolveConfigPath(join(target, ".o4e", "agents", "subagent"), "general.json")
    const worker = readConfigJson(join(target, ".o4e", "agents", "subagent"), "general.json")
    worker.backgroundTasks = { maxRetries: 4 }
    writeConfigJson(workerPath, worker)
    assert.doesNotThrow(() => build(target))

    config.backgroundTasks.maxConcurrentAgents = 0
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.backgroundTasks\.maxConcurrentAgents 必须是大于等于 1 的安全整数/)

    config.backgroundTasks.maxConcurrentAgents = 1
    writeConfigJson(configPath, config)
    worker.backgroundTasks = { maxRetries: -1 }
    writeConfigJson(workerPath, worker)
    assertBuildFails(target, /subagent\/general\.jsonc?\.backgroundTasks\.maxRetries 必须是非负安全整数/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("config agentDefaults 为省略 core prompt 的 Agent 提供默认值，并接受 Agent promptDir 覆盖", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.agentDefaults = { systemPrompt: "shared/default-system" }
    writeConfigJson(configPath, config)
    mkdirSync(join(target, ".o4e", "custom", "prompts", "shared"), { recursive: true })
    writeFileSync(join(target, ".o4e", "custom", "prompts", "shared", "default-system.md"), "agent defaults system prompt\n")
    mkdirSync(join(target, ".o4e", "custom", "prompts", "primary", "chat"), { recursive: true })
    writeFileSync(join(target, ".o4e", "custom", "prompts", "primary", "chat", "reminder.md"), "Read-only conversation mode.\n")

    const chatPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), "chat.json")
    const chat = readConfigJson(join(target, ".o4e", "agents", "primary"), "chat.json")
    delete chat.systemPrompt
    delete chat.injects
    chat.promptDir = "custom\\prompts"
    writeConfigJson(chatPath, chat)

    build(target)

    const rendered = readFileSync(join(target, ".opencode", "agents", "chat (plan).md"), "utf8")
    assert.match(rendered, /agent defaults system prompt/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建校验 MCP server 与按 agent 工具白名单", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.mcp = { context7: { type: "remote", url: "https://mcp.context7.com/mcp" } }
    config.loadMcp = { context7: ["resolve-library-id"] }
    writeConfigJson(configPath, config)
    build(target)

    config.mcp.context7.type = "unknown"
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.mcp\.context7\.type 只能是 local 或 remote/)

    config.mcp.context7.type = "remote"
    config.loadMcp = { context7: ["bad tool"] }
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.loadMcp\.context7\[0\] 不是合法的 MCP 工具名称/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝非 canonical loadTools.write", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.loadTools = ["read", "write"]
    writeConfigJson(configPath, config)

    assertBuildFails(target, /config\.loadTools\[1\] 不支持的内置工具: write/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝非 canonical permission 名称并接受 custom/MCP 名称", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.permission = { "functions.bash": "deny" }
    writeConfigJson(configPath, config)
    assertBuildFails(target, /请改用 bash/)

    config.permission = { apply_patch: "deny" }
    writeConfigJson(configPath, config)
    assertBuildFails(target, /请改用 edit/)

    config.permission = { write: "ask" }
    writeConfigJson(configPath, config)
    assertBuildFails(target, /write 无效，请改用 edit/)

    config.permission = { edit: "deny", "context7_query-docs": "allow", "filesystem_write-file": "ask" }
    writeConfigJson(configPath, config)
    assert.doesNotThrow(() => build(target))

    const orchestratorPath = resolveConfigPath(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    const orchestrator = readConfigJson(join(target, ".o4e", "agents", "all"), "orchestrator.json")
    orchestrator.plan = { ...orchestrator.plan, permission: { "functions.apply_patch": "deny" } }
    writeConfigJson(orchestratorPath, orchestrator)
    assertBuildFails(target, /请改用 edit/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝错误类型、内部阶段扩展与无效原生映射", () => {
  const target = createTarget()
  try {
    const primaryPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), `${nativeBuildAgent}.json`)
    const primary = readConfigJson(join(target, ".o4e", "agents", "primary"), `${nativeBuildAgent}.json`)
    primary.mode = "primary"
    writeConfigJson(primaryPath, primary)
    assertBuildFails(target, /primary\/build\.jsonc? 不支持字段: mode/)

    delete primary.mode
    primary.nativeMode = "plan"
    primary.plan = { mode: "self" }
    writeConfigJson(primaryPath, primary)
    assertBuildFails(target, /agent 名 build 只能由声明 nativeMode: build 的主 agent 使用/)

    primary.nativeMode = "build"
    delete primary.plan
    writeConfigJson(primaryPath, primary)
    const systemPath = resolveConfigPath(join(target, ".o4e", "agents", "system"), "custom.json")
    writeConfigJson(systemPath, { "$schema": "../../schemas/system-phase-agent.schema.json", name: "custom", systemPrompt: "system/title" })
    assertBuildFails(target, /system\/custom\.json\.name 不是受支持的系统内部阶段 agent/)
    rmSync(systemPath)

    const subagentPath = resolveConfigPath(join(target, ".o4e", "agents", "subagent"), "general.json")
    const subagent = readConfigJson(join(target, ".o4e", "agents", "subagent"), "general.json")
    subagent.unknownField = []
    writeConfigJson(subagentPath, subagent)
    assertBuildFails(target, /subagent\/general\.jsonc? 不支持字段: unknownField/)

    delete subagent.unknownField
    subagent.capabilities = ["本地调研"]
    writeConfigJson(subagentPath, subagent)
    assertBuildFails(target, /capabilities\[0\] 必须是稳定的点分技能 ID/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("扩展 primary 不需要 order，并拒绝不支持的排序字段", () => {
  const target = createTarget()
  try {
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    writeConfigJson(join(primaryRoot, "custom.json"), {
      "$schema": "../../schemas/primary-agent.schema.json",
      name: "custom",
      description: "custom primary agent",
      systemPrompt: "primary/chat/system",
    })
    assert.doesNotThrow(() => build(target))

    const customPath = join(primaryRoot, "custom.json")
    const custom = readConfigJson(primaryRoot, "custom.json")
    custom.order = 0
    writeConfigJson(customPath, custom)
    assertBuildFails(target, /primary\/custom\.json 不支持字段: order/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("nativeMode alias 可以改为其他短名称", () => {
  const target = createTarget()
  try {
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    const buildPath = resolveConfigPath(primaryRoot, `${nativeBuildAgent}.json`)
    const planPath = resolveConfigPath(primaryRoot, `${nativePlanAgent}.json`)
    const buildAgent = readConfigJson(primaryRoot, `${nativeBuildAgent}.json`)
    const planAgent = readConfigJson(primaryRoot, `${nativePlanAgent}.json`)
    buildAgent.name = "custom-build"
    buildAgent.description = "custom build agent"
    planAgent.name = "custom-plan"
    planAgent.description = "custom plan agent"
    writeConfigJson(buildPath, buildAgent)
    writeConfigJson(planPath, planAgent)
    renameSync(buildPath, join(primaryRoot, "custom-build.json"))
    renameSync(planPath, join(primaryRoot, "custom-plan.json"))

    build(target)

    assert.equal(existsSync(join(target, ".opencode", "agents", "custom-build.md")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "custom-plan (plan).md")), true)
    assert.equal(existsSync(join(target, ".opencode", "agents", "custom-plan.md")), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("build 和 plan 名称不能被无关主 agent 或 subagent 占用", () => {
  const target = createTarget()
  try {
    const primaryRoot = join(target, ".o4e", "agents", "primary")
    const buildPath = resolveConfigPath(primaryRoot, "build.json")
    const buildAgent = readConfigJson(primaryRoot, "build.json")
    buildAgent.name = "custom-build"
    buildAgent.description = "custom build agent"
    writeConfigJson(buildPath, buildAgent)
    renameSync(buildPath, join(primaryRoot, "custom-build.json"))
    const subagentPath = resolveConfigPath(join(target, ".o4e", "agents", "subagent"), "general.json")
    const subagent = readConfigJson(join(target, ".o4e", "agents", "subagent"), "general.json")
    subagent.name = "build"
    writeConfigJson(subagentPath, subagent)
    renameSync(subagentPath, join(target, ".o4e", "agents", "subagent", "build.json"))

    assertBuildFails(target, /agent 名 build 只能由声明 nativeMode: build 的主 agent 使用/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("配置入口归一化 Soul 和指令文件默认值", (t) => {
  const target = createTarget()
  t.after(() => rmSync(target, { recursive: true, force: true }))
  const configRoot = join(target, ".o4e")
  const configPath = resolveConfigPath(configRoot, "config.json")
  const config = readConfigJson(configRoot, "config.json")
  delete config.soul
  delete config.instructionFiles
  writeConfigJson(configPath, config)
  const normalized = loadRuntimeDefinition(configRoot).config
  const configHome = process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config")
  const globalInstructions = join(configHome, "opencode", "AGENTS.md")
  assert.deepEqual(normalized.soul, { enabled: true, file: "soul.md", inheritMode: "override" })
  assert.deepEqual(normalized.instructionFiles, {
    global: [globalInstructions, join(homedir(), ".claude", "CLAUDE.md")],
    project: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"],
  })
  config.instructionFiles = { global: ["<default>"], project: ["<default>"] }
  writeConfigJson(configPath, config)
  assert.deepEqual(loadRuntimeDefinition(configRoot).config.instructionFiles, { global: [globalInstructions], project: ["AGENTS.md"] })
})

test("构建拒绝未知 Soul 字段", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")
    config.soul.unknownField = "project"
    writeConfigJson(configPath, config)

    assertBuildFails(target, /config\.soul 不支持字段: unknownField/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝 soul.file 绝对路径和 .. 逃逸", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")

    config.soul.file = "/absolute/path.md"
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.soul\.file 必须是配置目录内的相对路径/)

    config.soul.file = "../escape.md"
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.soul\.file 必须是配置目录内的相对路径/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝 soul.globalFile 相对路径", () => {
  const target = createTarget()
  try {
    const configPath = resolveConfigPath(join(target, ".o4e"), "config.json")
    const config = readConfigJson(join(target, ".o4e"), "config.json")

    config.soul.globalFile = "relative.md"
    writeConfigJson(configPath, config)
    assertBuildFails(target, /config\.soul\.globalFile 必须是绝对路径/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("构建拒绝 Agent 未知字段", () => {
  const target = createTarget()
  try {
    const buildPath = resolveConfigPath(join(target, ".o4e", "agents", "primary"), `${nativeBuildAgent}.json`)
    const buildAgent = readConfigJson(join(target, ".o4e", "agents", "primary"), `${nativeBuildAgent}.json`)
    buildAgent.unknownField = []
    writeConfigJson(buildPath, buildAgent)
    assertBuildFails(target, /primary\/build\.jsonc? 不支持字段: unknownField/)

    delete buildAgent.unknownField
    writeConfigJson(buildPath, buildAgent)
    const allRoot = join(target, ".o4e", "agents", "all")
    const orchestratorPath = resolveConfigPath(allRoot, "orchestrator.json")
    const orchestrator = readConfigJson(allRoot, "orchestrator.json")
    orchestrator.unknownField = []
    writeConfigJson(orchestratorPath, orchestrator)
    assertBuildFails(target, /all\/orchestrator\.jsonc? 不支持字段: unknownField/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
