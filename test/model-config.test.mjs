import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { stripJsonComments } from "../src/jsonc.mjs"
import { applyModelChanges, formatModelValue, modelConfigRoot, parseModelCliOptions, readModelConfiguration, resolveModelChange } from "../scripts/model-config.mjs"
import { generateSilentConfig, writeConfig } from "../scripts/installer.mjs"
import { installerTestEnv } from "./helpers/installer-cli-fixture.mjs"

const INSTALLER = join(import.meta.dirname, "..", "scripts", "installer.mjs")

function readJsonc(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf-8")))
}

function makeTarget() {
  const target = mkdtempSync(join(tmpdir(), "o4e-model-config-"))
  const result = writeConfig(target, generateSilentConfig("en", true))
  assert.equal(result.success, true, result.error)
  return target
}

function runCli(cliArgs = [], env = {}) {
  const childEnv = installerTestEnv()
  for (const [name, value] of Object.entries(env)) {
    const existing = Object.keys(childEnv).find((key) => key.toLowerCase() === name.toLowerCase())
    if (existing) delete childEnv[existing]
    childEnv[name] = value
  }
  if (env.HOME && !env.USERPROFILE) childEnv.USERPROFILE = env.HOME
  try {
    const result = execFileSync(process.execPath, [INSTALLER, ...cliArgs], {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    })
    return { success: true, output: result }
  } catch (error) {
    return { success: false, output: (error.stdout || "") + (error.stderr || "") }
  }
}

test("model CLI 参数解析支持默认值、逐 Agent、null 与格式拒绝", () => {
  assert.deepEqual(parseModelCliOptions({}), { touched: false, defaultModel: undefined, defaultVariant: undefined, agents: [] })
  const parsed = parseModelCliOptions({
    "default-model": "anthropic/claude-sonnet-4-5",
    "default-variant": "high",
    model: ["orchestrator=openai/gpt-5.2", "chat=null"],
    variant: "orchestrator=max",
  })
  assert.equal(parsed.touched, true)
  assert.equal(parsed.defaultModel, "anthropic/claude-sonnet-4-5")
  assert.equal(parsed.defaultVariant, "high")
  assert.deepEqual(parsed.agents, [
    { name: "orchestrator", model: "openai/gpt-5.2", variant: "max" },
    { name: "chat", model: null, variant: undefined },
  ])
  assert.throws(() => parseModelCliOptions({ "default-model": "" }), /--default-model/)
  assert.throws(() => parseModelCliOptions({ model: ["badformat"] }), /name=value/)
  assert.throws(() => parseModelCliOptions({ model: ["a=p/m", "a=p/m2"] }), /重复指定/)
  assert.throws(() => parseModelCliOptions({ variant: ["a=high", "a=low"] }), /重复指定/)
})

test("resolveModelChange 组合 model 与 variant 并拒绝非法取值", () => {
  assert.equal(resolveModelChange({}, null, "x"), undefined)
  assert.equal(resolveModelChange({ model: null }, { id: "p/m", variant: "high" }, "x"), null)
  assert.deepEqual(resolveModelChange({ model: "p/m" }, null, "x"), { id: "p/m" })
  assert.deepEqual(resolveModelChange({ model: "p/m", variant: "low" }, null, "x"), { id: "p/m", variant: "low" })
  assert.deepEqual(resolveModelChange({ variant: "high" }, "p/m", "x"), { id: "p/m", variant: "high" })
  assert.deepEqual(resolveModelChange({ variant: null }, { id: "p/m", variant: "high" }, "x"), { id: "p/m" })
  assert.throws(() => resolveModelChange({ model: "bad" }, null, "x"), /provider\/model/)
  assert.throws(() => resolveModelChange({ model: null, variant: "high" }, null, "x"), /已清除/)
  assert.throws(() => resolveModelChange({ variant: "high" }, null, "x"), /当前未配置模型/)
  assert.throws(() => resolveModelChange({ model: "p/m", variant: "a\nb" }, null, "x"), /单行/)
})

test("modelConfigRoot 区分项目与全局配置根", () => {
  assert.equal(modelConfigRoot({ target: "/x/project" }), join("/x/project", ".o4e"))
  assert.equal(modelConfigRoot({ global: true }), join(homedir(), ".config", "opencode", ".o4e"))
})

test("readModelConfiguration 读取默认模型与可配置 Agent，排除 system Agent", () => {
  const target = makeTarget()
  try {
    const state = readModelConfiguration(join(target, ".o4e"))
    assert.equal(state.defaultModel, null)
    assert.ok(state.configPath.endsWith("config.jsonc"))
    const names = state.agents.map((agent) => agent.name)
    for (const expected of ["orchestrator", "chat", "architect", "debugger", "researcher", "reviewer", "tester"]) {
      assert.ok(names.includes(expected), `missing ${expected}`)
    }
    for (const system of ["compaction", "title", "summary"]) assert.ok(!names.includes(system))
    assert.ok(state.agents.every((agent) => ["all", "primary", "subagent"].includes(agent.type)))
    assert.equal(state.agents.find((agent) => agent.name === "orchestrator").type, "all")
    assert.equal(state.agents.find((agent) => agent.name === "chat").type, "primary")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("模型编辑遵循 config.jsonc 与 Agent .jsonc 优先级", () => {
  const target = makeTarget()
  try {
    const root = join(target, ".o4e")
    writeFileSync(join(root, "config.json"), "{ invalid json")
    writeFileSync(join(root, "agents", "all", "orchestrator.json"), "{ invalid json")
    const result = applyModelChanges({ target, defaultModel: "p/default", agents: [{ name: "orchestrator", model: "p/main" }] })
    assert.equal(result.changes.length, 2)
    // 未被选定的文件保持原样
    assert.equal(readFileSync(join(root, "config.json"), "utf8"), "{ invalid json")
    assert.equal(readFileSync(join(root, "agents", "all", "orchestrator.json"), "utf8"), "{ invalid json")
    assert.deepEqual(readJsonc(join(root, "config.jsonc")).defaultModel, { id: "p/default" })
    assert.deepEqual(readJsonc(join(root, "agents", "all", "orchestrator.jsonc")).model, { id: "p/main" })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("applyModelChanges 修改模型、保留注释并重建 frontmatter", () => {
  const target = makeTarget()
  try {
    const root = join(target, ".o4e")
    const configPath = join(root, "config.jsonc")
    const commentsBefore = (readFileSync(configPath, "utf8").match(/^\s*\/\//gm) || []).length
    const result = applyModelChanges({
      target,
      defaultModel: "anthropic/claude-sonnet-4-5",
      defaultVariant: "high",
      agents: [{ name: "orchestrator", model: "openai/gpt-5.2", variant: "max" }, { name: "chat", model: null }],
    })
    assert.deepEqual(result.changes.map((change) => change.target), ["defaultModel", "orchestrator", "chat"])
    assert.deepEqual(readJsonc(configPath).defaultModel, { id: "anthropic/claude-sonnet-4-5", variant: "high" })
    const commentsAfter = (readFileSync(configPath, "utf8").match(/^\s*\/\//gm) || []).length
    assert.equal(commentsAfter, commentsBefore)
    assert.deepEqual(readJsonc(join(root, "agents", "all", "orchestrator.jsonc")).model, { id: "openai/gpt-5.2", variant: "max" })
    assert.equal(readJsonc(join(root, "agents", "primary", "chat.jsonc")).model, null)
    const orchestrator = readFileSync(join(target, ".opencode", "agents", "orchestrator.md"), "utf8")
    assert.match(orchestrator, /^model: openai\/gpt-5\.2$/m)
    assert.match(orchestrator, /^variant: max$/m)
    // chat 清除后继承全局默认模型
    const chatPlan = readFileSync(join(target, ".opencode", "agents", "chat (plan).md"), "utf8")
    assert.match(chatPlan, /^model: anthropic\/claude-sonnet-4-5$/m)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("applyModelChanges 仅改 variant、拒绝未知与重复 Agent，无修改时不构建", () => {
  const target = makeTarget()
  try {
    assert.equal(applyModelChanges({ target, defaultModel: "p/m" }).changes.length, 1)
    const variantOnly = applyModelChanges({ target, defaultVariant: "low" })
    assert.deepEqual(variantOnly.changes, [{ target: "defaultModel", value: { id: "p/m", variant: "low" } }])
    assert.throws(
      () => applyModelChanges({ target, agents: [{ name: "nosuch", model: "p/m" }] }),
      /未知或不可配置模型的 Agent: nosuch/,
    )
    assert.throws(
      () => applyModelChanges({ target, agents: [{ name: "chat", model: "p/m" }, { name: "chat", model: null }] }),
      /重复指定 Agent: chat/,
    )
    let built = false
    const noop = applyModelChanges({ target, build: () => { built = true } })
    assert.deepEqual(noop.changes, [])
    assert.equal(built, false)
    // system Agent 不在可配置范围
    assert.throws(
      () => applyModelChanges({ target, agents: [{ name: "compaction", model: "p/m" }] }),
      /未知或不可配置模型的 Agent: compaction/,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("applyModelChanges 构建失败时恢复原文件", () => {
  const target = makeTarget()
  try {
    const configPath = join(target, ".o4e", "config.jsonc")
    const agentPath = join(target, ".o4e", "agents", "all", "orchestrator.jsonc")
    const configBefore = readFileSync(configPath, "utf8")
    const agentBefore = readFileSync(agentPath, "utf8")
    assert.throws(
      () => applyModelChanges({
        target,
        defaultModel: "p/m",
        agents: [{ name: "orchestrator", model: "p/x" }],
        build: () => { throw new Error("boom") },
      }),
      /模型配置校验失败，已恢复原配置.*boom/,
    )
    assert.equal(readFileSync(configPath, "utf8"), configBefore)
    assert.equal(readFileSync(agentPath, "utf8"), agentBefore)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("applyModelChanges 拒绝链接配置文件", () => {
  const target = makeTarget()
  try {
    const configPath = join(target, ".o4e", "config.jsonc")
    linkSync(configPath, join(target, "linked-config.jsonc"))
    assert.throws(() => applyModelChanges({ target, defaultModel: "p/m" }), /普通文件/)
    assert.equal(readJsonc(configPath).defaultModel, null)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test("model 子命令静默修改项目与全局配置", () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-model-cli-"))
  const target = join(root, "project")
  const home = join(root, "home")
  mkdirSync(target)
  mkdirSync(home)
  try {
    assert.equal(runCli(["install", "--no-tui", "--target", target]).success, true)
    const project = runCli([
      "model", "--no-tui", "--target", target,
      "--default-model=anthropic/claude-sonnet-4-5", "--default-variant=high",
      "--model=orchestrator=openai/gpt-5.2", "--variant=orchestrator=max",
    ])
    assert.equal(project.success, true, project.output)
    assert.match(project.output, /Model configuration updated/)
    assert.deepEqual(readJsonc(join(target, ".o4e", "config.jsonc")).defaultModel, { id: "anthropic/claude-sonnet-4-5", variant: "high" })
    assert.match(readFileSync(join(target, ".opencode", "agents", "orchestrator.md"), "utf8"), /^model: openai\/gpt-5\.2$/m)

    assert.equal(runCli(["install", "--no-tui", "--global"], { HOME: home }).success, true)
    const global = runCli(["model", "--no-tui", "--global", "--model=tester=openai/gpt-5.2"], { HOME: home })
    assert.equal(global.success, true, global.output)
    assert.deepEqual(readJsonc(join(home, ".config", "opencode", ".o4e", "agents", "subagent", "tester.jsonc")).model, { id: "openai/gpt-5.2" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("model 子命令参数守卫与错误出口", () => {
  const target = mkdtempSync(join(tmpdir(), "o4e-model-cli-guard-"))
  try {
    assert.equal(runCli(["install", "--no-tui", "--target", target]).success, true)
    const noFlags = runCli(["model", "--no-tui", "--target", target])
    assert.equal(noFlags.success, false)
    assert.match(noFlags.output, /at least one of --default-model/)
    const wrongCommand = runCli(["build", "--target", target, "--model=chat=p/m"])
    assert.equal(wrongCommand.success, false)
    assert.match(wrongCommand.output, /only supported by the model subcommand/)
    const installOnly = runCli(["model", "--no-tui", "--target", target, "--default-model=p/m", "--no-skills"])
    assert.equal(installOnly.success, false)
    assert.match(installOnly.output, /only supported by install/)
    const unknownAgent = runCli(["model", "--no-tui", "--target", target, "--model=nosuch=p/m"])
    assert.equal(unknownAgent.success, false)
    assert.match(unknownAgent.output, /未知或不可配置模型的 Agent: nosuch/)
    const badId = runCli(["model", "--no-tui", "--target", target, "--default-model=noprovider"])
    assert.equal(badId.success, false)
    assert.match(badId.output, /provider\/model/)
    const missing = runCli(["model", "--no-tui", "--target", join(target, "missing"), "--default-model=p/m"])
    assert.equal(missing.success, false)
    assert.match(missing.output, /未找到 O4E 配置文件/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// 交互模式需要支持 models 输出的假 opencode binary；Windows CI 使用真实 opencode，跳过。
test("交互模式在未指定范围时询问项目或全局并应用修改", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-model-interactive-"))
  const target = join(root, "project")
  const home = join(root, "home")
  const fakeBin = join(root, "bin")
  mkdirSync(target)
  mkdirSync(home)
  mkdirSync(fakeBin)
  try {
    const promptData = `var Hi=\`You are the deterministic OpenCode test prompt\`
var PlanReminder=\`<system-reminder>
# Plan Mode - System Reminder
Deterministic test reminder
</system-reminder>
\``
    writeFileSync(join(fakeBin, "opencode"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 9.9.1
  exit 0
fi
if [ "$1" = "models" ]; then
  printf 'called\\n' >> "$O4E_TEST_MODELS_MARKER"
  printf 'anthropic/claude-sonnet-4-5\\n{"name":"Claude","variants":{"high":{},"max":{}}}\\n'
  exit 0
fi
exit 1
: <<'O4E_TEST_PROMPTS'
${promptData}
O4E_TEST_PROMPTS
`)
    chmodSync(join(fakeBin, "opencode"), 0o755)

    const modelsMarker = join(root, "models-called.txt")
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, O4E_TEST_MODELS_MARKER: modelsMarker }
    const install = execFileSync(process.execPath, [INSTALLER, "install", "--no-tui", "--target", target], { encoding: "utf8", timeout: 30000, env })
    assert.ok(install.includes("Installation complete"))

    // 交互答案队列：语言=中文，范围=项目，条目=默认模型，模型=anthropic/claude-sonnet-4-5，variant=high，条目=完成
    const answers = ["zh", "project", "__default__", "anthropic/claude-sonnet-4-5", "high", "__done__"]
    const prompts = `
      import assert from "node:assert/strict";
      import { existsSync } from "node:fs";
      const answers = ${JSON.stringify(answers)};
      let selectCalls = 0;
      export async function select(options) {
        selectCalls++;
        if (selectCalls === 1) {
          // INS-006：第一个提示出现时模型目录必须已在后台预加载（进入命令即启动）
          const marker = process.env.O4E_TEST_MODELS_MARKER;
          const deadline = Date.now() + 5000;
          while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.ok(existsSync(marker), "model catalog prefetch did not start before the first prompt");
        }
        const next = answers.shift();
        assert.ok(next !== undefined, "unexpected select call");
        assert.ok(options.options.some((option) => option.value === next), "select answer not in options: " + next);
        return next;
      }
      export async function autocomplete() {
        const next = answers.shift();
        assert.ok(next !== undefined, "unexpected autocomplete call");
        return next;
      }
      export const isCancel = () => false;
      export const intro = () => {}, outro = () => {}, cancel = () => {};
      export const log = { message() {} };
      export const spinner = () => ({ start() {}, stop() {} });
      process.on("exit", () => assert.equal(answers.length, 0, "unused answers"));
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
    execFileSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, INSTALLER, "model"],
      { cwd: target, encoding: "utf8", timeout: 30000, env },
    )
    assert.deepEqual(readJsonc(join(target, ".o4e", "config.jsonc")).defaultModel, { id: "anthropic/claude-sonnet-4-5", variant: "high" })
    assert.match(readFileSync(join(target, ".opencode", "agents", "orchestrator.md"), "utf8"), /^model: anthropic\/claude-sonnet-4-5$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("formatModelValue 展示继承、id 与 variant", () => {
  assert.equal(formatModelValue(null), "null")
  assert.equal(formatModelValue(null, { inherit: "继承全局默认" }), "继承全局默认")
  assert.equal(formatModelValue("p/m"), "p/m")
  assert.equal(formatModelValue({ id: "p/m" }), "p/m")
  assert.equal(formatModelValue({ id: "p/m", variant: "high" }), "p/m (variant: high)")
  assert.equal(formatModelValue({ bad: true }), "(无效)")
})
