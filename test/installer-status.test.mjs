import assert from "node:assert/strict"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createDanglingDirectoryLink, createDirectoryLink, createFileLink, removeLink } from "./helpers/fs-link-fixture.mjs"
import { installerTestEnv } from "./helpers/installer-cli-fixture.mjs"
import { defaultSkillNames } from "../scripts/installer.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function installer(args, home) {
  return execFileSync(process.execPath, [join(componentRoot, "scripts", "installer.mjs"), ...args], {
    cwd: componentRoot,
    encoding: "utf8",
    env: installerTestEnv({ ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}) }),
  })
}

function install(args, home) {
  return installer(["install", ...args], home)
}

test("status 和 uninstall 管理 soul 运行时插件", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-deploy-"))
  try {
    install(["--no-tui", "--target", target])
    const soulPath = join(target, ".opencode", "plugins", "opencode-for-everything", "soul.mjs")
    const promptReaderPath = join(target, ".opencode", "plugins", "opencode-for-everything", "prompt-file.mjs")
    const skillPaths = defaultSkillNames().map((name) => join(target, ".o4e", "skills", name, "SKILL.md"))
    assert.equal(existsSync(soulPath), true)
    assert.equal(existsSync(promptReaderPath), true)
    for (const skillPath of skillPaths) assert.equal(existsSync(skillPath), true)
    const extraSkillPath = join(target, ".o4e", "skills", "status-extra", "SKILL.md")
    mkdirSync(dirname(extraSkillPath), { recursive: true })
    writeFileSync(extraSkillPath, "---\nname: status-extra\ndescription: status test\n---\n<!--opencode-for-everything-skill:status-extra-->\nextra\n")
    const status = installer(["status", "--target", target])
    assert.doesNotMatch(status, /skill: status-extra/)
    assert.match(status, /\[installed\] soul/)
    assert.match(status, /\[installed\] prompt reader/)
    assert.match(status, /\[installed\] agent creator skill/)
    assert.doesNotMatch(status, /\[missing\]/)

    installer(["uninstall", "--no-tui", "--target", target])
    assert.equal(existsSync(soulPath), false)
    assert.equal(existsSync(promptReaderPath), false)
    for (const skillPath of skillPaths) assert.equal(existsSync(skillPath), true)
    assert.equal(existsSync(extraSkillPath), true)
    assert.equal(existsSync(join(target, ".o4e", "config.json")) || existsSync(join(target, ".o4e", "config.jsonc")), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("全局 registry CLI 保持严格 JSON，installer status 和卸载允许注释并保留其他注册项", () => {
  const home = mkdtempSync(join(tmpdir(), "o4e-global-home-"))
  try {
    const runtimeRoot = join(home, ".config", "opencode")
    let registryPath = join(runtimeRoot, "opencode.json")
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(registryPath, "{}\n")
    chmodSync(registryPath, 0o600)
    const registryMode = statSync(registryPath).mode & 0o777
    install(["--no-tui", "--global"], home)
    const config = JSON.parse(readFileSync(registryPath, "utf8"))
    const pluginPath = join(runtimeRoot, "plugins", "opencode-for-everything.ts")
    const pluginSpec = pathToFileURL(pluginPath).href

    assert.equal(existsSync(pluginPath), true)
    assert.deepEqual(config.plugin, [pluginSpec])
    assert.equal(statSync(registryPath).mode & 0o777, registryMode)
    assert.match(installer(["status", "--global"], home), /\[active\]\s+global plugin registry/)

    const registry = (action) => spawnSync(process.execPath, [join(componentRoot, "scripts", "global-plugin-registry.mjs"), action, runtimeRoot, pluginPath], { encoding: "utf8" })
    assert.equal(registry("status").status, 0)
    assert.equal(registry("uninstall").status, 0)
    assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), {})
    assert.equal(registry("status").status, 1)
    assert.equal(registry("install").status, 0)
    assert.equal(registry("invalid").status, 2)
    const jsoncPath = join(runtimeRoot, "opencode.jsonc")
    renameSync(registryPath, jsoncPath)
    registryPath = jsoncPath
    const otherPlugin = ["other-plugin", { enabled: true }]
    const commented = `// user configuration\n${JSON.stringify({ plugin: [[pluginSpec, { enabled: true }], otherPlugin] })}\n`
    writeFileSync(registryPath, commented)
    for (const action of ["install", "status", "uninstall"]) {
      const result = registry(action)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /仅支持严格 JSON/)
      assert.equal(readFileSync(registryPath, "utf8"), commented)
    }
    assert.match(installer(["status", "--global"], home), /\[active\]\s+global plugin registry/)

    installer(["uninstall", "--no-tui", "--global"], home)
    assert.equal(existsSync(pluginPath), false)
    assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), { plugin: [otherPlugin] })
    assert.equal(statSync(registryPath).mode & 0o777, registryMode)
    assert.equal(existsSync(join(runtimeRoot, ".o4e", "config.json")) || existsSync(join(runtimeRoot, ".o4e", "config.jsonc")), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("全局 status 拒绝非法注册配置", () => {
  const home = mkdtempSync(join(tmpdir(), "o4e-global-status-invalid-"))
  const runtimeRoot = join(home, ".config", "opencode")
  try {
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(runtimeRoot, "opencode.json"), "{}\n")
    createDanglingDirectoryLink(join(home, "missing.jsonc"), join(runtimeRoot, "opencode.jsonc"))
    assert.throws(() => installer(["status", "--global"], home), /Global OpenCode configuration must be an unlinked regular file/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("安装从当前 OpenCode 生成可编辑的 build/plan prompt 和 plan reminder，并保留后续用户定制", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-native-prompt-deploy-"))
    const buildPrompt = join(target, ".o4e", "prompts", "primary", "build", "system.md")
    const planReminder = join(target, ".o4e", "prompts", "primary", "plan", "reminder.md")
  const statePath = join(target, ".o4e", "native-prompt-install.json")
  try {
    install(["--no-tui", "--target", target])
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    assert.match(state.files["prompts/primary/build/system.md"].opencodeVersion, /\d+\.\d+/)
    assert.match(state.files["prompts/primary/build/system.md"].sha256, /^[0-9a-f]{64}$/)
    assert.match(state.files["prompts/primary/plan/reminder.md"].sha256, /^[0-9a-f]{64}$/)
    assert.equal(readFileSync(buildPrompt, "utf8").includes("You are "), true)
    assert.match(readFileSync(planReminder, "utf8"), /^<system-reminder>\n# Plan Mode - System Reminder/)

    const customized = "user customized build prompt"
    writeFileSync(buildPrompt, customized)
    install(["--no-tui", "--target", target, "--force"])
    assert.equal(readFileSync(buildPrompt, "utf8"), customized)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("项目级 status 要求显式指定目标目录", () => {
  assert.throws(() => installer(["status"]), /Project-level status requires --target to specify the target directory/)
})

test("项目级 status 拒绝不存在的目标目录", () => {
  const missingTarget = join(tmpdir(), `o4e-missing-status-${Date.now()}`)
  assert.throws(() => installer(["status", "--target", missingTarget]), /Target directory does not exist/)
})

test("status 报告缺失的分层运行时模块", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-status-runtime-module-"))
  try {
    install(["--no-tui", "--target", target])
    const modulePath = join(target, ".opencode", "plugins", "opencode-for-everything", "core", "capability-policy.mjs")
    rmSync(modulePath)
    const status = installer(["status", "--target", target])
    assert.match(status, /\[missing\]\s+runtime\/core\/capability-policy\.mjs/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("status 拒绝损坏的受管 Skill，不扫描用户自建 Skill", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-status-managed-skill-"))
  const managedRoot = join(target, ".o4e", "skills", "o4e-agent-creator")
  try {
    mkdirSync(managedRoot, { recursive: true })
    writeFileSync(join(managedRoot, "SKILL.md"), "unmanaged skill\n")
    assert.throws(() => installer(["status", "--target", target]), /受管 Skill 缺少匹配名称 marker/)
    rmSync(join(managedRoot, "SKILL.md"))
    assert.throws(() => installer(["status", "--target", target]), /Skill 必须是独立普通文件/)
    rmSync(managedRoot, { recursive: true })
    createDanglingDirectoryLink(join(target, "missing"), join(target, ".o4e", "skills", "user-owned"))
    assert.match(installer(["status", "--target", target]), /\[disabled\]\s+managed skills/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("status 不把链接 plugin 入口报告为已安装", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-status-linked-plugin-"))
  const externalPlugin = join(target, "external-plugin.ts")
  try {
    mkdirSync(join(target, ".o4e"), { recursive: true })
   writeFileSync(join(target, ".o4e", "config.jsonc"), '{"nativeAgents":{"build":"keep","plan":"keep","general":"keep","explore":"keep"}}\n')
    mkdirSync(join(target, ".opencode", "plugins"), { recursive: true })
    writeFileSync(externalPlugin, "plugin\n")
    createFileLink(externalPlugin, join(target, ".opencode", "plugins", "opencode-for-everything.ts"))
    assert.match(installer(["status", "--target", target]), /\[missing\]\s+plugin/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("status 拒绝链接配置或运行时根目录", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-status-linked-roots-"))
  const externalConfig = mkdtempSync(join(tmpdir(), "o4e-status-external-config-"))
  const externalRuntime = mkdtempSync(join(tmpdir(), "o4e-status-external-runtime-"))
  try {
    createDirectoryLink(externalConfig, join(target, ".o4e"))
    assert.throws(() => installer(["status", "--target", target]), /Configuration root must be a regular directory; refusing to inspect/)
    removeLink(join(target, ".o4e"))
    mkdirSync(join(target, ".o4e"), { recursive: true })
    writeFileSync(join(target, ".o4e", "config.jsonc"), "{}\n")
    createDirectoryLink(externalRuntime, join(target, ".opencode"))
    assert.throws(() => installer(["status", "--target", target]), /Runtime root must be a regular directory; refusing to inspect/)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(externalConfig, { recursive: true, force: true })
    rmSync(externalRuntime, { recursive: true, force: true })
  }
})
