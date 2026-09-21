import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { currentNativePrompts, extractNativeBuildPrompt, extractNativePlanReminder, locateOpenCode, syncNativePrompts } from "../scripts/native-prompt-sync.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

function createTarget() {
  const target = mkdtempSync(join(tmpdir(), "o4e-native-prompt-"))
  const configRoot = join(target, ".o4e")
  cpSync(join(componentRoot, "defaults", ".o4e"), configRoot, { recursive: true })
  return { target, configRoot }
}

function writeFakeOpenCode(path, version, buildPrompt, planReminder = "<system-reminder>\n# Plan Mode - System Reminder\nSynced plan reminder\n</system-reminder>\n") {
  writeFileSync(path, `binary fixture ${version}\nvar Hi=\`${buildPrompt}\`\nvar PlanReminder=\`${planReminder}\`\n`)
}

test("从发布二进制 template literal 提取并解码原生 prompt", () => {
  const { target } = createTarget()
  const binaryPath = join(target, "opencode")
  try {
    writeFileSync(binaryPath, "prefix var Hi=`You are test\\u2019s prompt with \\`backtick\\` and \\u{1F680}` var PlanReminder=`<system-reminder>\\n# Plan Mode - System Reminder\\nPlan\\u2019s reminder\\n</system-reminder>\\n`")
    assert.equal(extractNativeBuildPrompt(binaryPath), "You are test’s prompt with `backtick` and 🚀")
    assert.equal(extractNativePlanReminder(binaryPath), "<system-reminder>\n# Plan Mode - System Reminder\nPlan’s reminder\n</system-reminder>\n")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装复用预检读取的 OpenCode prompt 与受管哈希", () => {
  const { target, configRoot } = createTarget()
  const binaryPath = join(target, "opencode")
  try {
    writeFakeOpenCode(binaryPath, "9.9.1", "You are synced prompt one")
    const prompts = currentNativePrompts({ binaryPath, readVersion: () => "9.9.1" })
    rmSync(binaryPath)
    const result = syncNativePrompts(configRoot, prompts)
    const manifest = JSON.parse(readFileSync(join(configRoot, "native-prompt-install.json"), "utf8"))

    assert.deepEqual(result.updated, ["prompts/primary/build/system.md", "prompts/primary/plan/system.md", "prompts/primary/plan/reminder.md"])
    assert.equal(sha256(readFileSync(join(configRoot, "prompts/primary/build/system.md"), "utf8")), result.sources.build.sha256)
    assert.equal(sha256(readFileSync(join(configRoot, "prompts/primary/plan/system.md"), "utf8")), result.sources.build.sha256)
    assert.equal(sha256(readFileSync(join(configRoot, "prompts/primary/plan/reminder.md"), "utf8")), result.sources.planReminder.sha256)
    assert.deepEqual(manifest.files["prompts/primary/build/system.md"], result.sources.build)
    assert.deepEqual(manifest.files["prompts/primary/plan/system.md"], result.sources.build)
    assert.deepEqual(manifest.files["prompts/primary/plan/reminder.md"], result.sources.planReminder)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("Windows npm shim 定位并同步真实 OpenCode 可执行文件", () => {
  const { target, configRoot } = createTarget()
  const npmRoot = join(target, "npm")
  const binaryPath = join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe")
  const shimPath = join(npmRoot, "opencode.cmd")
  try {
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFakeOpenCode(binaryPath, "9.9.1", "You are synced from a Windows npm shim")
    writeFileSync(shimPath, `@ECHO off\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\n`)

    assert.equal(locateOpenCode({ searchPath: npmRoot, platform: "win32" }), realpathSync(binaryPath))
    const result = syncNativePrompts(configRoot, currentNativePrompts({ binaryPath: shimPath, platform: "win32", readVersion: () => "9.9.1" }))
    assert.equal(result.sources.build.opencodeVersion, "9.9.1")
    assert.equal(readFileSync(join(configRoot, "prompts", "primary", "build", "system.md"), "utf8"), "You are synced from a Windows npm shim")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("可以将原生 prompt 同步到自定义 prompt 目录", () => {
  const { target, configRoot } = createTarget()
  const binaryPath = join(target, "opencode")
  try {
    writeFakeOpenCode(binaryPath, "9.9.1", "You are synced prompt")
    const result = syncNativePrompts(configRoot, currentNativePrompts({ binaryPath, readVersion: () => "9.9.1" }), { promptDir: "assets/prompts" })

    assert.deepEqual(result.updated, ["assets/prompts/primary/build/system.md", "assets/prompts/primary/plan/system.md", "assets/prompts/primary/plan/reminder.md"])
    assert.equal(existsSync(join(configRoot, "assets", "prompts", "primary", "build", "system.md")), true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("安装生成用户 prompt 时保留用户改写", () => {
  const { target, configRoot } = createTarget()
  const binaryPath = join(target, "opencode")
  try {
    writeFakeOpenCode(binaryPath, "9.9.1", "You are synced prompt one")
    syncNativePrompts(configRoot, currentNativePrompts({ binaryPath, readVersion: () => "9.9.1" }))
    const buildPath = join(configRoot, "prompts", "primary", "build", "system.md")
    const reminderPath = join(configRoot, "prompts", "primary", "plan", "reminder.md")
    writeFileSync(buildPath, "user customized build prompt")
    writeFileSync(reminderPath, "user customized plan reminder")
    writeFakeOpenCode(binaryPath, "9.9.2", "You are synced prompt two")

    const result = syncNativePrompts(configRoot, currentNativePrompts({ binaryPath, readVersion: () => "9.9.2" }))
    const manifest = JSON.parse(readFileSync(join(configRoot, "native-prompt-install.json"), "utf8"))

    assert.deepEqual(result.preserved, ["prompts/primary/build/system.md", "prompts/primary/plan/reminder.md"])
    assert.deepEqual(result.updated, ["prompts/primary/plan/system.md"])
    assert.equal(readFileSync(buildPath, "utf8"), "user customized build prompt")
    assert.equal(readFileSync(reminderPath, "utf8"), "user customized plan reminder")
    assert.equal(manifest.files["prompts/primary/build/system.md"].opencodeVersion, "9.9.1")
    assert.equal(manifest.files["prompts/primary/plan/system.md"].opencodeVersion, "9.9.2")
    assert.equal(manifest.files["prompts/primary/plan/reminder.md"].opencodeVersion, "9.9.1")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
