#!/usr/bin/env node

/**
 * opencode-for-everything installer
 *
 * Supports interactive TUI and silent --no-tui modes
 *
 * Usage:
 *   node scripts/installer.mjs install            # Interactive mode
 *   node scripts/installer.mjs install --no-tui           # Silent mode (default configuration)
 *   node scripts/installer.mjs install --no-tui --lang=zh # Silent mode with an explicit language
 *   node scripts/installer.mjs install --no-tui --no-soul # Silent mode without SOUL
 *   node scripts/installer.mjs build --target /path/to/project # Rebuild runtime
 *   node scripts/installer.mjs uninstall        # Uninstall the plugin
 *   node scripts/installer.mjs status --target /path/to/project # Check project installation status
 *   node scripts/installer.mjs export backup.o4e.tar.gz --target /path/to/project
 *   node scripts/installer.mjs import backup.o4e.tar.gz --target /path/to/project --force
 *   node scripts/installer.mjs model --no-tui --target /path/to/project --default-model=provider/model
 */

import { parseArgs, promisify } from "node:util"
import { execFile, execFileSync } from "node:child_process"
import { chmodSync, closeSync, constants as fsConstants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join, dirname, isAbsolute, resolve, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripJsonComments } from "../src/jsonc.mjs"
import { buildRuntime, sourceRuntimeFiles } from "../src/runtime-builder.mjs"
import { NATIVE_AGENT_NAMES, NATIVE_AGENT_STRATEGIES } from "../src/agent-layout.mjs"
import { currentNativePrompts, locateOpenCode, resolveOpenCodeBinary, syncNativePrompts } from "./native-prompt-sync.mjs"
import { globalPluginRegistered, installGlobalPlugin, prepareGlobalPluginRegistrationRemoval, readGlobalRegistry } from "./global-plugin-registry.mjs"
import { readManagedSkills } from "../src/managed-skills.mjs"
import { expandPlanProfiles } from "../src/core/capability-policy.mjs"
import { prepareTuiRegistrationRemoval, runtimeModulePath, tuiPluginRegistered } from "../src/tui-registration.mjs"
import { applyModelChanges, formatModelValue, modelConfigRoot, parseModelCliOptions, readModelConfiguration } from "./model-config.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const COMPONENT = "opencode-for-everything"
const RUNTIME_PLUGIN_FILES = [
  "opencode-for-everything.ts",
]
const RUNTIME_COMPONENT_DIRECTORY = "opencode-for-everything"
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const NATIVE_AGENT_NAME_SET = new Set(NATIVE_AGENT_NAMES)
const NATIVE_AGENT_STRATEGY_SET = new Set(NATIVE_AGENT_STRATEGIES)
const NATIVE_POLICY_NAMES = Object.freeze(["o4e-only", "managed", "keep", "custom"])
const NATIVE_POLICY_NAME_SET = new Set(NATIVE_POLICY_NAMES)
const DEFAULT_NATIVE_POLICY = "o4e-only"
const NATIVE_POLICY_ARGUMENTS = Object.freeze(["native-policy", "native-agent", ...NATIVE_AGENT_NAMES.map((name) => `native-${name}`)])

function portablePath(path) {
  return path.replace(/\\/g, "/")
}

function readPlainTree(root, label) {
  const files = []
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        const stat = lstatIfPresent(path)
        if (!stat?.isDirectory()) throw new Error(`${label} must be a regular directory: ${path}`)
        visit(path, relativePath)
      } else {
        const stat = lstatIfPresent(path)
        if (!stat?.isFile() || stat.nlink !== 1) throw new Error(`${label} cannot contain symlinks, hard links, or special files: ${path}`)
        files.push(relativePath)
      }
    }
  }
  visit(root)
  return files
}

function globalConfigRoot() {
  return join(homedir(), ".config", "opencode")
}

// 解析目标路径（支持绝对路径和相对路径）
function resolveTarget(target) {
  if (isAbsolute(target)) {
    return target
  }
  return resolve(process.cwd(), target)
}

const lstatIfPresent = (path) => lstatSync(path, { throwIfNoEntry: false })

export function defaultSkillNames() {
  const defaultsDir = join(__dirname, "..", "defaults", ".o4e")
  return readManagedSkills(defaultsDir, { required: true }).map(({ name }) => name)
}

export function resolveSkillSelection(values = {}) {
  const defaults = defaultSkillNames()
  if (values["no-skills"] && values.skill !== undefined) throw new Error("--no-skills cannot be combined with --skill")
  if (values["no-skills"]) return []
  if (values.skill === undefined) return defaults
  const requested = Array.isArray(values.skill) ? values.skill : [values.skill]
  const available = new Set(defaults)
  const selected = []
  const seen = new Set()
  for (const name of requested) {
    if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) throw new Error("--skill must use a lowercase Skill name")
    if (!available.has(name)) throw new Error(`Unknown default Skill: ${name}`)
    if (seen.has(name)) throw new Error(`--skill specified duplicate Skill: ${name}`)
    seen.add(name)
    selected.push(name)
  }
  return selected
}

function replaceJsoncTemplateValue(content, property, expectedValue, value, label) {
  const pattern = new RegExp(`(\"${property}\"\\s*:\\s*)${expectedValue}`, "g")
  const matches = [...content.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`${label} is missing a replaceable default value for ${property}`)
  return content.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(value)}`)
}

export function materializeDefaultAgentMetadata(content, agent, language, label) {
  const parsed = JSON.parse(stripJsonComments(content))
  if (parsed.description !== undefined) {
    throw new Error(`${label} already contains default Agent metadata`)
  }

  const namePattern = /^(\s*)\"name\"\s*:\s*[^,\r\n]+,\s*$/m
  const metadataCommentPattern = /^(\s*)\/\/ \[o4e:defaultMetadata\].*$/m
  const pattern = metadataCommentPattern.test(content) ? metadataCommentPattern : namePattern
  const match = content.match(pattern)
  if (!match) throw new Error(`${label} is missing a name field for metadata insertion`)

  const metadata = [`${match[1]}\"description\": ${JSON.stringify(agent.description[language])},`]
  return content.replace(pattern, `${match[0]}\n${metadata.join("\n")}`)
}

export function materializeModelConfig({ mode = "all", all, byType = {}, perAgent = {}, selectedAgents = [] } = {}) {
  const agents = {}
  if (mode === "all") return { defaultModel: all, agents }
  if (mode !== "by-type" && mode !== "per-agent") throw new Error(`Unknown model configuration mode: ${mode}`)
  for (const agent of selectedAgents) {
    const model = mode === "by-type" ? byType[agent.type] : perAgent[agent.id]
    agents[agent.id] = model ? { model: model.id, ...(model.variant ? { variant: model.variant } : {}) } : {}
  }
  return { agents }
}

function assertDirectoryIfPresent(path, message) {
  const stat = lstatIfPresent(path)
  if (stat && !stat.isDirectory()) throw new Error(`${message}: ${path}`)
}

function assertWritableRuntimeTarget(target, { global = false } = {}) {
  const runtimeRoot = global ? target : join(target, ".opencode")
  assertDirectoryIfPresent(runtimeRoot, "Runtime root must be a regular directory; refusing to overwrite")
  assertDirectoryIfPresent(join(runtimeRoot, "agents"), "Runtime agent directory must be a regular directory; refusing to overwrite")
  assertDirectoryIfPresent(join(runtimeRoot, "plugins"), "Runtime plugin directory must be a regular directory; refusing to overwrite")
  assertDirectoryIfPresent(join(runtimeRoot, "tui"), "Runtime TUI directory must be a regular directory; refusing to overwrite")
}

function assertConfigRoot(target) {
  const configRoot = join(target, ".o4e")
  const stat = lstatIfPresent(configRoot)
  if (stat && !stat.isDirectory()) throw new Error(`Configuration root must be a regular directory: ${configRoot}`)
}

function assertPlainConfigTree(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      assertPlainConfigTree(path)
    } else if (!entry.isFile() || lstatSync(path).nlink !== 1) {
      throw new Error(`Configuration archive cannot contain links or special files: ${path}`)
    }
  }
}

function preserveFailedConfig(target, o4eDir, prefix) {
  if (!lstatIfPresent(o4eDir)) return null
  const failedRoot = mkdtempSync(join(target, prefix))
  const failedConfigDir = join(failedRoot, ".o4e")
  renameSync(o4eDir, failedConfigDir)
  return failedConfigDir
}

function snapshotRuntimeFile(path, kind) {
  const stat = lstatIfPresent(path)
  if (!stat) return { path, kind, state: "absent" }
  if (!stat.isFile() || stat.nlink !== 1) return { path, kind, state: "preserve" }
  return { path, kind, state: "file", content: readFileSync(path), mode: stat.mode }
}

function readRuntimeModules(runtimeRoot) {
  const files = []
  const directories = []
  assertDirectoryIfPresent(runtimeRoot, "Runtime module root must be a regular directory; refusing to operate")
  const componentRoot = join(runtimeRoot, RUNTIME_COMPONENT_DIRECTORY)
  const rootStat = lstatIfPresent(componentRoot)
  if (!rootStat) return { files, directories }
  if (!rootStat.isDirectory()) throw new Error(`Component runtime directory must be a regular directory; refusing to operate: ${componentRoot}`)
  const visit = (directory) => {
    directories.push(directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = lstatIfPresent(path)
      if (entry.isDirectory()) {
        if (!stat?.isDirectory()) throw new Error(`Component runtime directory must be a regular directory; refusing to operate: ${path}`)
        visit(path)
      } else {
        if (!stat?.isFile() || stat.nlink !== 1) throw new Error(`Runtime module must be an unlinked regular file; refusing to operate: ${path}`)
        files.push(path)
      }
    }
  }
  visit(componentRoot)
  return { files, directories }
}

function snapshotManagedRuntime(runtimeRoot) {
  const files = [snapshotRuntimeFile(join(runtimeRoot, "package.json"), "package")]
  for (const name of ["tui.json", "tui.jsonc"]) files.push(snapshotRuntimeFile(join(runtimeRoot, name), "registry"))
  const trees = ["plugins", "tui"].map((name) => readRuntimeModules(join(runtimeRoot, name)))
  const modules = { files: trees.flatMap((tree) => tree.files), directories: trees.flatMap((tree) => tree.directories) }
  for (const filename of RUNTIME_PLUGIN_FILES) {
    files.push(snapshotRuntimeFile(join(runtimeRoot, "plugins", filename), "plugin"))
  }
  for (const path of modules.files) {
    files.push(snapshotRuntimeFile(path, "plugin"))
  }
  const agentsDir = join(runtimeRoot, "agents")
  const agentsStat = lstatIfPresent(agentsDir)
  if (agentsStat?.isDirectory()) {
    for (const filename of readdirSync(agentsDir).filter((name) => name.endsWith(".md"))) {
      files.push(snapshotRuntimeFile(join(agentsDir, filename), "agent"))
    }
  }
  return {
    runtimeRoot,
    files,
    componentDirectories: modules.directories,
  }
}

function restoreManagedRuntime(snapshot) {
  const originalPaths = new Set(snapshot.files.map((entry) => entry.path))
  const agentsDir = join(snapshot.runtimeRoot, "agents")
  const agentsStat = lstatIfPresent(agentsDir)
  if (agentsStat?.isDirectory()) {
    for (const filename of readdirSync(agentsDir).filter((name) => name.endsWith(".md"))) {
      const path = join(agentsDir, filename)
      if (originalPaths.has(path)) continue
      const stat = lstatIfPresent(path)
      if (stat?.isFile() && stat.nlink === 1 && readFileSync(path, "utf8").includes(`<!--${COMPONENT}-agent:`)) rmSync(path, { force: true })
    }
  }

  const trees = ["plugins", "tui"].map((name) => readRuntimeModules(join(snapshot.runtimeRoot, name)))
  const currentModules = { files: trees.flatMap((tree) => tree.files), directories: trees.flatMap((tree) => tree.directories) }
  for (const path of currentModules.files) {
    if (!originalPaths.has(path)) rmSync(path, { force: true })
  }
  const originalComponentDirectories = new Set(snapshot.componentDirectories)
  for (const path of currentModules.directories.toSorted((left, right) => right.length - left.length)) {
    if (!originalComponentDirectories.has(path) && readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true })
  }

  for (const entry of snapshot.files) {
    if (entry.state === "preserve") continue
    if (entry.state === "file") {
      mkdirSync(dirname(entry.path), { recursive: true })
      writeFileSync(entry.path, entry.content)
      chmodSync(entry.path, entry.mode)
      continue
    }
    const stat = lstatIfPresent(entry.path)
    if (!stat?.isFile() || stat.nlink !== 1) continue
    const managed = entry.kind === "plugin" || entry.kind === "package" || entry.kind === "registry"
      || (entry.kind === "agent" && readFileSync(entry.path, "utf8").includes(`<!--${COMPONENT}-agent:`))
    if (managed) rmSync(entry.path, { force: true })
  }
}

const IS_MAIN = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  }
})()

const DEFAULT_ARGS = {
  "no-tui": false,
  lang: "en",
  "no-soul": false,
  target: ".",
  global: false,
  force: false,
  skill: undefined,
  "no-skills": false,
  "native-policy": undefined,
  "native-agent": undefined,
  "native-build": undefined,
  "native-plan": undefined,
  "native-general": undefined,
  "native-explore": undefined,
  "default-model": undefined,
  "default-variant": undefined,
  model: undefined,
  variant: undefined,
  help: false,
}
let args = DEFAULT_ARGS
let command
let archiveFile
if (IS_MAIN) {
  try {
    const parsed = parseArgs({
      options: {
        "no-tui": { type: "boolean", default: false },
        "lang": { type: "string", default: "en" },
        "no-soul": { type: "boolean", default: false },
        "target": { type: "string", default: "." },
        "global": { type: "boolean", default: false },
         "force": { type: "boolean", default: false },
         "skill": { type: "string", multiple: true },
         "no-skills": { type: "boolean", default: false },
        "native-policy": { type: "string" },
        "native-agent": { type: "string", multiple: true },
        "native-build": { type: "string" },
        "native-plan": { type: "string" },
        "native-general": { type: "string" },
        "native-explore": { type: "string" },
        "default-model": { type: "string" },
        "default-variant": { type: "string" },
        "model": { type: "string", multiple: true },
        "variant": { type: "string", multiple: true },
        "help": { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    })
    args = parsed.values
    command = parsed.positionals[0]
    if (command && !["install", "uninstall", "status", "build", "export", "import", "model"].includes(command)) {
      console.error(`Unsupported command: ${command}`)
      process.exit(2)
    }
    if (["export", "import"].includes(command)) {
      archiveFile = typeof parsed.positionals[1] === "string" ? parsed.positionals[1].trim() : undefined
      if (!archiveFile) {
        console.error(`${command} requires an archive file path`)
        process.exit(2)
      }
      if (parsed.positionals.length > 2) {
        console.error(`${command} accepts exactly one archive file path`)
        process.exit(2)
      }
    } else if (command && parsed.positionals.length > 1) {
      console.error(`${command} does not accept positional arguments: ${parsed.positionals.slice(1).join(" ")}`)
      process.exit(2)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

if (IS_MAIN && args.help) {
  printUsage()
  process.exit(0)
}
if (IS_MAIN && process.argv.length === 2) {
  printUsage()
  process.exit(0)
}
if (IS_MAIN && !["zh", "en"].includes(args.lang)) {
  console.error("--lang must be either zh or en")
  process.exit(2)
}

const hasArgument = (name) => process.argv.slice(2).some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
const hasTargetArgument = hasArgument("target")
const hasNativePolicyArgument = NATIVE_POLICY_ARGUMENTS.some(hasArgument)
const hasSkillArgument = hasArgument("skill") || hasArgument("no-skills")
if (IS_MAIN && args.global && hasTargetArgument) {
  console.error("--global cannot be used together with --target")
  process.exit(2)
}
if (IS_MAIN && !args.help && !command) {
  console.error("A subcommand is required: install, uninstall, status, build, export, import, or model")
  process.exit(2)
}
if (IS_MAIN && ["status", "build"].includes(command) && !args.global && !hasTargetArgument) {
  console.error(`Project-level ${command} requires --target to specify the target directory`)
  process.exit(2)
}
if (IS_MAIN && hasNativePolicyArgument && command !== "install") {
  console.error("Native Agent policy options are only supported by install")
  process.exit(2)
}
const hasModelArgument = ["default-model", "default-variant", "model", "variant"].some(hasArgument)
if (IS_MAIN && hasModelArgument && command !== "model") {
  console.error("Model options are only supported by the model subcommand")
  process.exit(2)
}
if (IS_MAIN && command === "model" && (args.force || args["no-soul"])) {
  console.error("The model subcommand only supports --target/--global, --no-tui, --lang and model options")
  process.exit(2)
}
if (IS_MAIN && hasSkillArgument && command !== "install") {
  console.error("Skill selection options are only supported by install")
  process.exit(2)
}
if (IS_MAIN && command === "install") {
  try {
    resolveNativeInstallOptions(args, { requireCompleteCustom: args["no-tui"] })
    resolveSkillSelection(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

function printUsage() {
  console.log(`
opencode-for-everything installer

Usage:
   node scripts/installer.mjs <command> [argument] [options]

Commands:
  install            Install and build the runtime
  uninstall          Uninstall the managed runtime
  status             Check installation status (read-only)
  build              Validate .o4e/ and rebuild the runtime entry point
  export <archive>   Export .o4e configuration to a .o4e.tar.gz archive
  import <archive>   Import a .o4e.tar.gz archive and rebuild the runtime
  model              Modify installed model configuration and rebuild

Options:
  --no-tui          Silent mode (no interactive interface)
  --lang=<language> Language: zh or en (default: en)
  --no-soul         Disable SOUL.md (enabled by default)
  --target=<dir>    Target directory for install, build, uninstall, status, or model;
                    required for project-level build and status
  --global          Use the global directory (~/.config/opencode)
  --force           Overwrite existing configuration
  --skill=<name>    Install one default Skill (repeatable; default: all)
  --no-skills       Do not install any default Skill
  --native-policy=<o4e-only|managed|keep|custom>
                    Native Agent preset (default: o4e-only)
  --native-build=<keep|managed|disable>
  --native-plan=<keep|managed|disable>
  --native-general=<keep|managed|disable>
  --native-explore=<keep|managed|disable>
  --native-agent=<name>=<keep|managed|disable>
                    Override one native Agent after applying the preset;
                    repeat this option for multiple overrides. Custom requires
                    all four values in silent mode.
  --default-model=<provider/model|null>
                    model subcommand: set or clear config defaultModel
  --default-variant=<name|null>
                    model subcommand: set or remove the defaultModel variant
  --model=<agent>=<provider/model|null>
                    model subcommand: set or clear one Agent model; repeatable
  --variant=<agent>=<name|null>
                    model subcommand: set or remove one Agent model variant; repeatable
  --help, -h        Show this help

Examples:
   node scripts/installer.mjs install                   # Interactive install
   node scripts/installer.mjs install --no-tui          # Silent install (default configuration)
   node scripts/installer.mjs install --no-tui --no-soul --lang=en # Silent install in English without SOUL
   node scripts/installer.mjs install --no-tui --native-policy=managed
   node scripts/installer.mjs install --no-tui --native-policy=custom --native-build=managed --native-plan=keep --native-general=disable --native-explore=disable
   node scripts/installer.mjs install --no-tui --native-agent build=managed --native-agent plan=keep --native-agent general=disable --native-agent explore=disable
   node scripts/installer.mjs install --target=./my-project # Install to a specific directory
   node scripts/installer.mjs build --target=./my-project
   node scripts/installer.mjs uninstall                 # Uninstall from the current directory
   node scripts/installer.mjs uninstall --global        # Uninstall the global installation
   node scripts/installer.mjs status --target=./my-project
   node scripts/installer.mjs status --global
   node scripts/installer.mjs export backup.o4e.tar.gz --target=./my-project
   node scripts/installer.mjs import backup.o4e.tar.gz --target=./my-project --force
   node scripts/installer.mjs model                             # Interactive model configuration
   node scripts/installer.mjs model --global                    # Interactive model configuration (global)
   node scripts/installer.mjs model --no-tui --target=./my-project --default-model=anthropic/claude-sonnet-4-5
   node scripts/installer.mjs model --no-tui --model=orchestrator=openai/gpt-5.2 --variant=orchestrator=high
   node scripts/installer.mjs model --no-tui --model=chat=null  # Clear one Agent model (inherit)
`)
}

// 多语言文本
const TEXTS = {
  zh: {
    welcome: "欢迎使用 opencode-for-everything 安装器",
    selectLanguage: "选择安装语言",
    langZh: "中文",
    langEn: "English",
    selectScope: "选择安装范围",
    scopeProject: "项目级安装",
    scopeProjectDesc: "安装到当前目录的 .o4e/",
    scopeGlobal: "全局安装",
    scopeGlobalDesc: "安装到 ~/.config/opencode/",
    selectPrimaryAgents: "选择要启用的主 Agent（空格选择/取消，回车确认）",
    selectSubagents: "选择要启用的子 Agent（空格选择/取消，回车确认）",
    selectSkills: "选择要安装的 Skill（空格选择/取消，回车确认）",
    selectNativePolicy: "选择 OpenCode 原生 Agent 预设",
    nativePolicyO4EOnly: "仅使用自定义 Agent（推荐）",
    nativePolicyO4EOnlyDesc: "禁用 build、plan、general、explore，不接管这些宿主原生 Agent",
    nativePolicyManaged: "由 O4E 接管全部原生 Agent",
    nativePolicyManagedDesc: "接管 build、plan、general、explore，并可在 .o4e 中定制提示词",
    nativePolicyKeep: "保留 OpenCode 原生 Agent",
    nativePolicyKeepDesc: "不由 O4E 接管，也不修改宿主原生 Agent",
    nativePolicyCustom: "自定义",
    nativePolicyCustomDesc: "在下一步逐项设置四个原生 Agent",
    configureNativeAgents: "设置原生 Agent 策略",
    nativeStrategyKeep: "保留原生",
    nativeStrategyKeepDesc: "不由 O4E 管理，保留 OpenCode 宿主定义",
    nativeStrategyManaged: "O4E 接管",
    nativeStrategyManagedDesc: "由 O4E 接管同名原生 Agent，并可在 .o4e 中定制提示词",
    nativeStrategyDisable: "禁用",
    nativeStrategyDisableDesc: "不由 O4E 接管，并从宿主列表禁用",
    nativeAgentsConfigured: "原生 Agent 策略",
    selectModelMode: "选择模型配置方式",
    modelModeAll: "所有 Agent 使用同一模型",
    modelModeByType: "按 Agent 类型分别配置",
    modelModePerAgent: "为每个 Agent 单独配置",
    selectDefaultModel: "选择默认模型（应用到所有 Agent）",
    loadingModels: "正在加载 OpenCode 模型...",
    modelsLoaded: "已加载 OpenCode 模型",
    searchPlaceholder: "输入关键词实时筛选模型...",
    selectModel: "选择模型",
    selectVariant: "选择推理档位",
    modelNone: "使用 OpenCode 当前模型",
    enableSoul: "是否启用 SOUL.md",
    soulDescription: `SOUL.md 是一个持久化上下文文件，用于记录用户偏好和协作方式。

启用后，AI 将：
• 记住您的称呼和语言偏好
• 仅保留您明确要求记住或明确表达为长期适用的个人偏好
• 默认不写入；不把临时任务、项目规则或推断当作偏好

这将使 AI 更了解您，提供更个性化的服务。`,
    installComplete: "安装完成",
    installPath: "安装路径",
    configSaved: "配置已保存",
    agentsConfigured: "已配置的 Agent",
    soulEnabled: "SOUL.md 已启用",
    soulDisabled: "SOUL.md 已禁用",
    errorTargetExists: "目标目录已存在配置，使用 --force 强制覆盖",
    confirmOverwrite: "目标目录已存在 .o4e 配置，是否覆盖？",
    errorNoTarget: "目标目录不存在",
    confirmContinue: "确认继续安装",
    skipAgent: "跳过",
    // 卸载相关
    uninstallWelcome: "欢迎使用 opencode-for-everything 卸载器",
    selectUninstallScope: "选择卸载范围",
    noConfigFound: "未找到 opencode-for-everything 配置",
    keepConfig: "是否保留配置文件（.o4e 目录）",
    uninstallPath: "卸载路径",
    willKeepConfig: "将保留配置文件",
    willRemoveConfig: "将删除所有配置文件",
    confirmUninstall: "确认卸载",
    uninstalling: "正在卸载...",
    uninstallComplete: "卸载完成",
    uninstallFailed: "卸载失败",
    // 模型配置相关
    modelWelcome: "opencode-for-everything 模型配置",
    modelSelectScope: "选择要修改的配置范围",
    modelCurrent: "当前模型配置",
    modelDefaultTarget: "全局默认模型 (defaultModel)",
    modelInherit: "继承全局默认",
    modelHostCurrent: "沿用 OpenCode 当前模型",
    modelSelectTarget: "选择要修改的条目",
    modelTargetDone: "完成并应用",
    modelNoChanges: "没有需要应用的修改",
    modelApplying: "正在写入配置并重建运行时...",
    modelApplied: "模型配置已更新",
    modelFailed: "模型配置失败",
    modelPending: "待应用",
  },
  en: {
    welcome: "Welcome to opencode-for-everything Installer",
    selectLanguage: "Select installation language",
    langZh: "中文",
    langEn: "English",
    selectScope: "Select installation scope",
    scopeProject: "Project-level install",
    scopeProjectDesc: "Install to .o4e/ in current directory",
    scopeGlobal: "Global install",
    scopeGlobalDesc: "Install to ~/.config/opencode/",
    selectPrimaryAgents: "Select main Agents to enable (space to toggle, enter to confirm)",
    selectSubagents: "Select subagents to enable (space to toggle, enter to confirm)",
    selectSkills: "Select Skills to install (space to toggle, enter to confirm)",
    selectNativePolicy: "Select an OpenCode native Agent preset",
    nativePolicyO4EOnly: "Use custom Agents only (recommended)",
    nativePolicyO4EOnlyDesc: "Disable build, plan, general, and explore without taking over those host-native Agents",
    nativePolicyManaged: "Let O4E manage all native Agents",
    nativePolicyManagedDesc: "Let O4E take over build, plan, general, and explore with customizable prompts in .o4e",
    nativePolicyKeep: "Keep OpenCode native Agents",
    nativePolicyKeepDesc: "Do not let O4E take over; leave the host-native Agents unchanged",
    nativePolicyCustom: "Custom",
    nativePolicyCustomDesc: "Set all four native Agents individually in the next step",
    configureNativeAgents: "Set native Agent strategies",
    nativeStrategyKeep: "Keep native",
    nativeStrategyKeepDesc: "Leave the OpenCode host definition unmanaged",
    nativeStrategyManaged: "Managed by O4E",
    nativeStrategyManagedDesc: "Let O4E take over the native Agent and customize its prompt in .o4e",
    nativeStrategyDisable: "Disable",
    nativeStrategyDisableDesc: "Do not let O4E take over; disable the host-native Agent",
    nativeAgentsConfigured: "Native Agent strategies",
    selectModelMode: "Choose model configuration mode",
    modelModeAll: "Use one model for all agents",
    modelModeByType: "Configure by agent type",
    modelModePerAgent: "Configure each agent individually",
    selectDefaultModel: "Select default model (apply to all agents)",
    loadingModels: "Loading OpenCode models...",
    modelsLoaded: "Loaded OpenCode models",
    searchPlaceholder: "Type to filter models...",
    selectModel: "Select model",
    selectVariant: "Select reasoning level",
    modelNone: "Use the current OpenCode model",
    enableSoul: "Enable SOUL.md",
    soulDescription: `SOUL.md is a persistent context file that records user preferences and collaboration style.

When enabled, AI will:
• Remember your name and language preferences
• Retain only personal preferences explicitly requested to be remembered or stated as enduring
• Not write by default or treat temporary tasks, project rules, or inferences as preferences

This helps AI understand you better and provide more personalized service.`,
    installComplete: "Installation complete",
    installPath: "Install path",
    configSaved: "Configuration saved",
    agentsConfigured: "Configured agents",
    soulEnabled: "SOUL.md enabled",
    soulDisabled: "SOUL.md disabled",
    errorTargetExists: "Target directory already has config, use --force to overwrite",
    confirmOverwrite: "The target already contains .o4e configuration. Overwrite it?",
    errorNoTarget: "Target directory does not exist",
    confirmContinue: "Confirm to continue",
    skipAgent: "Skip",
    // Uninstall related
    uninstallWelcome: "Welcome to opencode-for-everything Uninstaller",
    selectUninstallScope: "Select uninstall scope",
    noConfigFound: "No opencode-for-everything configuration found",
    keepConfig: "Keep configuration files (.o4e directory)",
    uninstallPath: "Uninstall path",
    willKeepConfig: "Configuration files will be kept",
    willRemoveConfig: "All configuration files will be removed",
    confirmUninstall: "Confirm uninstall",
    uninstalling: "Uninstalling...",
    uninstallComplete: "Uninstall complete",
    uninstallFailed: "Uninstall failed",
    // Model configuration related
    modelWelcome: "opencode-for-everything Model Configuration",
    modelSelectScope: "Select the configuration scope to modify",
    modelCurrent: "Current model configuration",
    modelDefaultTarget: "Global default model (defaultModel)",
    modelInherit: "inherits the global default",
    modelHostCurrent: "uses the current OpenCode model",
    modelSelectTarget: "Select an entry to modify",
    modelTargetDone: "Done - apply changes",
    modelNoChanges: "No changes to apply",
    modelApplying: "Writing configuration and rebuilding the runtime...",
    modelApplied: "Model configuration updated",
    modelFailed: "Model configuration failed",
    modelPending: "pending",
  },
}

const NAVIGATE_BACK = Symbol("navigate-back")
const EXIT_INSTALLER = Symbol("exit-installer")
const USE_CURRENT_MODEL = "__o4e-current-model__"
function uniformNativeStrategies(strategy) {
  return Object.fromEntries(NATIVE_AGENT_NAMES.map((name) => [name, strategy]))
}

export function nativePolicyStrategies(policy, current = uniformNativeStrategies("disable")) {
  if (!NATIVE_POLICY_NAME_SET.has(policy)) throw new Error(`--native-policy must be one of: ${NATIVE_POLICY_NAMES.join(", ")}`)
  if (policy === "custom") return { ...current }
  if (policy === "managed") return uniformNativeStrategies("managed")
  if (policy === "keep") return uniformNativeStrategies("keep")
  return uniformNativeStrategies("disable")
}

export function resolveNativeInstallOptions(values = {}, { requireCompleteCustom = false } = {}) {
  const policy = values["native-policy"] ?? DEFAULT_NATIVE_POLICY
  let strategies = nativePolicyStrategies(policy)
  const explicit = new Set()
  const setStrategy = (name, strategy, option) => {
    if (!NATIVE_AGENT_NAME_SET.has(name)) throw new Error(`${option} 不支持原生 Agent: ${name}`)
    if (!NATIVE_AGENT_STRATEGY_SET.has(strategy)) throw new Error(`${option} 的策略必须是 keep、managed 或 disable`)
    if (explicit.has(name)) throw new Error(`${option} 重复指定原生 Agent: ${name}`)
    strategies[name] = strategy
    explicit.add(name)
  }
  const assignments = values["native-agent"] === undefined
    ? []
    : Array.isArray(values["native-agent"])
      ? values["native-agent"]
      : [values["native-agent"]]
  for (const assignment of assignments) {
    if (typeof assignment !== "string") throw new Error("--native-agent 必须使用 name=strategy 格式")
    const separator = assignment.indexOf("=")
    const name = separator > 0 ? assignment.slice(0, separator) : ""
    const strategy = separator > 0 ? assignment.slice(separator + 1) : ""
    if (!name || !strategy || strategy.includes("=")) throw new Error("--native-agent 必须使用 name=strategy 格式")
    setStrategy(name, strategy, "--native-agent")
  }
  for (const name of NATIVE_AGENT_NAMES) {
    const strategy = values[`native-${name}`]
    if (strategy === undefined) continue
    setStrategy(name, strategy, `--native-${name}`)
  }
  if (requireCompleteCustom && policy === "custom" && explicit.size !== NATIVE_AGENT_NAMES.length) {
    throw new Error("--native-policy=custom requires --native-build, --native-plan, --native-general, and --native-explore in silent mode")
  }
  return { policy, strategies }
}

function withManagedNativeAgents(selectedAgents, nativeStrategies) {
  const selected = new Set(selectedAgents.filter((name) => !NATIVE_AGENT_NAME_SET.has(name)))
  for (const name of NATIVE_AGENT_NAMES) if (nativeStrategies[name] === "managed") selected.add(name)
  return AGENT_DEFINITIONS.filter((agent) => selected.has(agent.id)).map((agent) => agent.id)
}

export function shouldConfigureNativeAgents(policy) {
  return policy === "custom"
}

function nativeStrategyLabel(strategy, texts) {
  if (strategy === "managed") return texts.nativeStrategyManaged
  if (strategy === "keep") return texts.nativeStrategyKeep
  return texts.nativeStrategyDisable
}

function nativeStrategySummary(strategies, texts) {
  return NATIVE_AGENT_NAMES.map((name) => `${name}=${nativeStrategyLabel(strategies[name], texts)}`).join(", ")
}

const AGENT_COMMENT_TEXTS = {
  zh: {
    schema: "供编辑器校验和补全；移动文件时保持相对路径正确。",
    name: "稳定 ID；必须与文件名一致。",
    defaultMetadata: "安装器已将本地化 description 写入本文件，可直接修改。",
    model: "null 表示继承 config.jsonc 的 defaultModel；该值也是 null 时沿用 OpenCode 当前模型。",
    fallbackModels: "当前 agent 的按序模型降级链；[] 明确关闭该 agent 的组件级降级。",
    nativeBuild: "原位接管 OpenCode 的 build 原生模式；必须且只能有一个 primary agent 声明该值。",
    nativePlan: "原位接管 OpenCode 的 plan 原生模式；必须且只能有一个 primary agent 声明该值。",
    nativeNone: "当前不配置 nativeMode；只有 primary Agent 可接管 build 或 plan。",
    planEnabled: "Plan 是显式对象：所有 Profile 使用 <name> (plan)；mode:self 只生成该 Profile，mode:child 还保留可写源角色；原生 plan 同样映射到小写后缀。对象内配置优先于默认只读交集。",
    planSelf: "只生成带小写后缀的 <name> (plan)；无后缀源名称不是 Plan Profile。对象内可覆盖权限、工具、MCP、Agent、Workflow 和 reminder。",
    planChild: "保留可写角色，并额外生成只读 <name> (plan)；对象内可覆盖权限、工具、MCP、Agent、Workflow 和 reminder。",
    planNone: "当前未声明 Plan；该角色不会应用 Plan reminder 或生成 Plan 复制体。",
    planDisabled: "当前未声明 Plan；不会应用 Plan reminder 或生成 Plan 复制体。",
    promptCore: "完整 system prompt 的 Markdown 路径；如改用 base 或 nativeSystem，必须删除本项并遵守三者互斥关系。",
    systemPrompt: "固定内部阶段的完整 system prompt Markdown 路径；system 阶段不支持 base 或 nativeSystem。",
    injects: "按顺序追加到 systemPrompt 后的 prompt 片段；[] 明确不追加。",
    messagePrompt: "当前未配置 messagePrompt。该字段没有 null/false 形式；仅在需要追加消息提示词时填写 Markdown 路径。",
    promptDir: "当前安装语言的 prompt 目录；修改时需同时迁移本文件引用的 Markdown。",
    instructionFiles: "完整规则文件覆盖；某个范围使用 [] 表示不读取该范围的规则文件。",
    loadTools: "完整受管 OpenCode permission 白名单；配置只接受 canonical edit，它同时控制宿主 edit、write 和 apply_patch；execute 是可选实验性 Code Mode；null 不接管 allow/deny，[] 全部拒绝。",
    loadSkills: "完整 Skill 名称 allowlist；[\"*\"] 不按名称限制，[] 全部拒绝，具体名称数组只开放对应 Skill。",
    loadMcp: "完整 MCP 工具白名单；{\"*\":[\"*\"]} 开放全部 MCP，{} 明确关闭。",
    routing: "loadAgents 控制可委派 Agent，loadWorkflows 控制可启动的 entry Workflow；默认按角色职责配置，用户可显式覆盖。",
    systemScope: "固定 OpenCode 内部阶段；只能使用 system/ 目录中允许的名称，且不支持模型或 Plan 字段。",
  },
  en: {
    schema: "Validates this file and provides editor completion; keep the relative path valid if the file moves.",
    name: "Stable ID; it must match this filename.",
    defaultMetadata: "The installer materialized the localized description into this file; edit it here.",
    model: "null inherits config.jsonc defaultModel; if that is also null, OpenCode keeps its current model.",
    fallbackModels: "Ordered per-agent model fallback chain; [] explicitly disables component fallback for this agent.",
    nativeBuild: "Takes over OpenCode's native build mode; exactly one primary agent must declare this value.",
    nativePlan: "Takes over OpenCode's native plan mode; exactly one primary agent must declare this value.",
    nativeNone: "No nativeMode is configured here; only primary Agents may take over build or plan.",
    planEnabled: "Plan is explicit and every Profile uses <name> (plan): mode:self emits only that Profile, while mode:child also keeps the writable source role. Native plan maps to the same lowercase suffix. Object-level configuration overrides the default read-only intersection.",
    planSelf: "Emits only the lowercase <name> (plan) Profile; the unsuffixed source name is not a Plan Profile. Object-level settings may override permissions, tools, MCP, Agents, Workflows, and reminder.",
    planChild: "Keeps the writable role and creates a read-only <name> (plan). Object-level settings may override permissions, tools, MCP, Agents, Workflows, and reminder.",
    planNone: "No Plan is declared; this role receives no Plan reminder and creates no Plan copy.",
    planDisabled: "No Plan is declared; this role receives no Plan reminder and creates no Plan copy.",
    promptCore: "Markdown path for the complete system prompt. To use base or nativeSystem, remove this field and follow their mutual-exclusion rules.",
    systemPrompt: "Markdown path for this fixed internal phase's complete system prompt; system phases do not support base or nativeSystem.",
    injects: "Prompt fragments appended after systemPrompt in order; [] explicitly appends none.",
    messagePrompt: "No messagePrompt is configured. This field has no null/false form; set a Markdown path only to append a message prompt.",
    promptDir: "Prompt directory for the installed language; move the Markdown files referenced here when changing it.",
    instructionFiles: "Complete rules-file override; [] for a scope means that scope loads no rules files.",
    loadTools: "Complete managed OpenCode permission allowlist. Configuration accepts canonical edit only; it controls host edit, write, and apply_patch. execute is optional experimental Code Mode. null leaves allow/deny unmanaged; [] denies all.",
    loadSkills: "Complete Skill-name allowlist: [\"*\"] adds no name restriction, [] denies all Skills, and explicit names allow only those Skills.",
    loadMcp: "Complete MCP-tool allowlist; {\"*\":[\"*\"]} opens all MCP tools and {} explicitly closes them.",
    routing: "loadAgents controls delegatable Agents and loadWorkflows controls startable entry Workflows. Defaults are role-specific and users may override them explicitly.",
    systemScope: "Fixed OpenCode internal phase; only allowed names in system/ may be used, and model and Plan fields are unsupported.",
  },
}

function localizeAgentComments(content, language, label) {
  const comments = AGENT_COMMENT_TEXTS[language] ?? AGENT_COMMENT_TEXTS.zh
  const localized = content.replace(/^(\s*)\/\/ \[o4e:([a-zA-Z][a-zA-Z0-9]*)\].*$/gm, (_match, indentation, key) => {
    const text = comments[key]
    if (!text) throw new Error(`${label} contains an unknown Agent comment marker: ${key}`)
    return `${indentation}// ${text}`
  })
  return localized.replace(/("promptDir"\s*:\s*)"prompts\/cn"/g, (_match, prefix) => `${prefix}"prompts"`)
}

function localizeInstalledAgentComments(configRoot, language, selectedAgents) {
  const agentsRoot = join(configRoot, "agents")
  const paths = []
  for (const agent of selectedAgents) {
    paths.push(join(agentsRoot, agent.type, `${agent.id}.jsonc`))
  }
  for (const name of ["compaction", "title", "summary"]) {
    paths.push(join(agentsRoot, "system", `${name}.jsonc`))
  }
  for (const path of paths) {
    if (!existsSync(path)) continue
    writeFileSync(path, localizeAgentComments(readFileSync(path, "utf8"), language, path))
  }
}

function soulTemplateName(language) {
  return language === "en" ? "soul.en.md" : "soul.zh.md"
}

function existingSoulFile(configRoot) {
  const configPath = [join(configRoot, "config.jsonc"), join(configRoot, "config.json")].find((path) => existsSync(path))
  if (!configPath) return "soul.md"
  try {
    const soul = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")))?.soul
    const file = soul && typeof soul === "object" && !Array.isArray(soul) ? soul.file : undefined
    if (typeof file === "string" && file && !isAbsolute(file) && !file.split(/[\\/]+/).includes("..")) {
      return portablePath(relative(resolve(configRoot), resolve(configRoot, file.replace(/\\/g, "/"))))
    }
  } catch {
    // A force install replaces an invalid config instead of inheriting from it.
  }
  return "soul.md"
}

function installerManagedConfigFiles(defaultsDir, promptLanguage) {
  const managed = new Set(["config.json", "config.jsonc", "agents/default.json", "agents/default.jsonc", "native-prompt-install.json"])
  const addManaged = (path) => managed.add(portablePath(path))
  for (const relativePath of readPlainTree(defaultsDir, "Default configuration directory")) {
    if (relativePath === "soul.md" || /^soul\.(?:zh|en)\.md$/.test(relativePath)) continue
    const parts = relativePath.split(/[\\/]+/)
    if (parts[0] !== "prompts") {
      addManaged(relativePath)
    } else if (parts[1] === "AGENTS.md") {
      addManaged(join("prompts", "AGENTS.md"))
    } else if (parts[1] === promptLanguage) {
      addManaged(join("prompts", ...parts.slice(2)))
    }
  }
  for (const agent of AGENT_DEFINITIONS) {
    addManaged(join("agents", agent.type, `${agent.id}.json`))
    addManaged(join("agents", agent.type, `${agent.id}.jsonc`))
  }
  for (const path of ["primary/build/system.md", "primary/plan/system.md", "primary/plan/reminder.md"]) {
    addManaged(join("prompts", path))
  }
  return managed
}

function readDefaultAgentCatalog() {
  const path = join(__dirname, "..", "defaults", ".o4e", "agents", "default.jsonc")
  const catalog = JSON.parse(stripJsonComments(readFileSync(path, "utf8")))
  if (!Array.isArray(catalog.agents)) throw new Error(`Default Agent catalog has an invalid format: ${path}`)
  const definitions = []
  const names = new Set()
  for (const agent of catalog.agents) {
    if (!agent?.id || names.has(agent.id)) throw new Error(`Default Agent catalog contains an invalid or duplicate name: ${agent?.id ?? "<unknown>"}`)
    if (!["primary", "subagent", "all"].includes(agent.type)) throw new Error(`Default Agent type is invalid: ${agent.id}`)
    for (const field of ["displayName", "roleName", "description"]) {
      if (!["zh", "en"].every((lang) => typeof agent[field]?.[lang] === "string" && agent[field][lang].length > 0 && !/[\r\n]/.test(agent[field][lang]))) {
        throw new Error(`Default Agent localization field is invalid: ${agent.id}.${field}`)
      }
    }
    if (typeof agent.defaultEnabled !== "boolean") throw new Error(`Default Agent enabled state is invalid: ${agent.id}`)
    names.add(agent.id)
    definitions.push(agent)
  }
  return definitions
}

const AGENT_DEFINITIONS = readDefaultAgentCatalog().map((metadata) => {
  const { id } = metadata
  const path = join(__dirname, "..", "defaults", ".o4e", "agents", metadata.type, `${id}.jsonc`)
  if (!existsSync(path)) throw new Error(`Default Agent configuration does not exist: ${id}`)
  const definition = JSON.parse(stripJsonComments(readFileSync(path, "utf8")))
  if (definition.name !== id) throw new Error(`Default Agent configuration name does not match: ${path}`)
  if (definition.description !== undefined) throw new Error(`Default Agent description must be maintained by agents/default.jsonc: ${id}`)
  return { ...definition, ...metadata, path }
})

export function defaultAgentSelectionGroups() {
  const custom = AGENT_DEFINITIONS.filter((agent) => !NATIVE_AGENT_NAME_SET.has(agent.id))
  return {
    primary: custom.filter((agent) => ["all", "primary"].includes(agent.type)).map((agent) => agent.id),
    subagent: custom.filter((agent) => agent.type === "subagent").map((agent) => agent.id),
  }
}

function agentLabel(agent, lang) {
  return `${agent.displayName[lang]} [${agent.id}]`
}

function configuredAgentLabels(agentIds, lang) {
  const selected = new Set(agentIds)
  return AGENT_DEFINITIONS.filter((agent) => selected.has(agent.id)).map((agent) => agentLabel(agent, lang))
}

// 静默模式配置生成
export function generateSilentConfig(lang, enableSoul, nativeStrategies = nativePolicyStrategies(DEFAULT_NATIVE_POLICY)) {
  const config = {
    lang: lang === "en" ? "en" : "zh",
    soul: enableSoul,
    nativeAgents: { ...nativeStrategies },
    agents: {},
  }

  for (const agent of AGENT_DEFINITIONS) {
    config.agents[agent.id] = {
      enabled: NATIVE_AGENT_NAME_SET.has(agent.id)
        ? nativeStrategies[agent.id] === "managed"
        : agent.defaultEnabled,
    }
  }

  return config
}

function jsonObjectEnd(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return index + 1
  }
  return -1
}

export function parseOpenCodeModels(output) {
  const source = String(output).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  const models = []
  const seen = new Set()
  const modelLine = /^([^\s/]+\/[^\r\n]+?)\r?$/gm
  let match
  while ((match = modelLine.exec(source))) {
    let cursor = modelLine.lastIndex
    while (/\s/.test(source[cursor] ?? "")) cursor += 1
    if (source[cursor] !== "{") continue
    const end = jsonObjectEnd(source, cursor)
    if (end < 0) continue
    try {
      const metadata = JSON.parse(source.slice(cursor, end))
      const id = match[1].trim()
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || seen.has(id)) continue
      seen.add(id)
      models.push({
        id,
        name: typeof metadata.name === "string" && metadata.name ? metadata.name : id.slice(id.indexOf("/") + 1),
        provider: typeof metadata.providerID === "string" && metadata.providerID ? metadata.providerID : id.slice(0, id.indexOf("/")),
        context: Number.isFinite(metadata.limit?.context) ? metadata.limit.context : undefined,
        reasoning: metadata.capabilities?.reasoning === true,
        variants: metadata.variants && typeof metadata.variants === "object" && !Array.isArray(metadata.variants)
          ? Object.keys(metadata.variants)
          : [],
      })
      modelLine.lastIndex = end
    } catch {
      // Ignore a malformed entry and continue scanning the catalog.
    }
  }
  return models
}

function loadConfiguredModels(configRoot) {
  for (const configPath of [join(configRoot, "opencode.json"), join(configRoot, "opencode.jsonc")]) {
    if (!existsSync(configPath)) continue
    try {
      const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")))
      const models = []
      for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
        if (!provider || typeof provider !== "object") continue
        for (const [modelId, model] of Object.entries(provider.models ?? {})) {
          if (!model || typeof model !== "object") continue
          models.push({
            id: `${providerId}/${modelId}`,
            name: model.name || modelId,
            provider: providerId,
            context: model.limit?.context,
            reasoning: model.reasoning === true,
            variants: model.variants ? Object.keys(model.variants) : [],
          })
        }
      }
      if (models.length > 0) return models
    } catch {
      // Try the next local catalog when this file cannot be read.
    }
  }
  return []
}

export async function loadAvailableModels({ binaryPath = locateOpenCode(), cwd = process.cwd(), configRoot = globalConfigRoot(), execute = execFileAsync } = {}) {
  if (binaryPath) {
    try {
      const { stdout } = await execute(resolveOpenCodeBinary(binaryPath), ["models", "--verbose", "--pure"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      })
      const models = parseOpenCodeModels(stdout)
      if (models.length > 0) return models
    } catch {
      // Fall back when the OpenCode CLI is unavailable or temporarily failing.
    }
  }
  return loadConfiguredModels(configRoot)
}

export function createModelCatalogLoader(loadModels = loadAvailableModels) {
  const tasks = new Map()
  return {
    prefetch(cwd) {
      const key = resolve(cwd)
      const existing = tasks.get(key)
      if (existing) return existing
      const task = { pending: true, promise: null }
      task.promise = Promise.resolve()
        .then(() => loadModels({ cwd: key }))
        .then((models) => {
          task.pending = false
          if (models.length === 0) tasks.delete(key)
          return models
        }, () => {
          task.pending = false
          tasks.delete(key)
          return []
        })
      tasks.set(key, task)
      return task
    },
  }
}

// TUI 模式
async function runTuiInstaller() {
  const p = await import("@clack/prompts")

  // 检查 TTY
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Error: the interactive installer requires a TTY. Use --no-tui for silent installation.")
    process.exit(1)
  }

  // 配置状态
  const nativeInstallOptions = resolveNativeInstallOptions(args)
  const state = {
    lang: args.lang,
    scope: args.global ? "global" : "project",
    nativePolicy: nativeInstallOptions.policy,
    nativeStrategies: nativeInstallOptions.strategies,
    selectedAgents: withManagedNativeAgents(AGENT_DEFINITIONS.filter((agent) => agent.defaultEnabled).map((agent) => agent.id), nativeInstallOptions.strategies),
    modelMode: "all",
    defaultModel: null,
    byTypeModels: {},
    agentModels: {},
    enableSoul: !args["no-soul"],
    selectedSkills: defaultSkillNames(),
    overwriteTarget: null,
  }

  let currentStep = 0
  const modelCatalogs = createModelCatalogLoader()
  function modelCatalogCwd() {
    const target = state.scope === "global" ? globalConfigRoot() : resolveTarget(args.target || ".")
    return lstatIfPresent(target)?.isDirectory() ? target : process.cwd()
  }
  // INS-006：进入安装流程即对项目和全局候选范围并行后台预加载模型目录；
  // scope 步骤与 models 步骤复用已启动的同目录任务，模型选择不再是首次触发。
  for (const candidate of [resolveTarget(args.target || "."), globalConfigRoot()]) {
    modelCatalogs.prefetch(lstatIfPresent(candidate)?.isDirectory() ? candidate : process.cwd())
  }
  // Esc returns to the previous installer step. Ctrl+C remains a direct exit.
  async function ask(prompt, options) {
    let navigation
    const onKeypress = (character, key) => {
      if (key?.name === "escape" || character === "\u001b") {
        navigation = NAVIGATE_BACK
      } else if ((key?.ctrl && key.name === "c") || character === "\u0003") {
        navigation = EXIT_INSTALLER
      }
    }

    process.stdin.on("keypress", onKeypress)
    try {
      const result = await prompt(options)
      if (p.isCancel(result)) return navigation ?? EXIT_INSTALLER
      return result
    } finally {
      process.stdin.off("keypress", onKeypress)
    }
  }

  const steps = [
    // Step 0: 语言选择
    {
      name: "lang",
      run: async () => {
        const result = await ask(p.select, {
          message: TEXTS.en.selectLanguage,
          options: [
            { value: "zh", label: TEXTS.en.langZh },
            { value: "en", label: TEXTS.en.langEn },
          ],
          initialValue: state.lang,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        state.lang = result
        return "next"
      },
    },
    // Step 1: 安装范围
    {
      name: "scope",
      run: async () => {
        const t = TEXTS[state.lang]
        const result = await ask(p.select, {
          message: t.selectScope,
          options: [
            { value: "project", label: t.scopeProject, hint: t.scopeProjectDesc },
            { value: "global", label: t.scopeGlobal, hint: t.scopeGlobalDesc },
          ],
          initialValue: state.scope,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        state.scope = result
        modelCatalogs.prefetch(modelCatalogCwd())
        const target = state.scope === "global"
          ? globalConfigRoot()
          : resolveTarget(args.target || ".")
        if (!args.force && existsSync(join(target, ".o4e")) && state.overwriteTarget !== target) {
          const overwrite = await ask(p.confirm, {
            message: `${t.confirmOverwrite} ${target}`,
            initialValue: false,
          })
          if (overwrite === NAVIGATE_BACK) return "back"
          if (overwrite === EXIT_INSTALLER) return "exit"
          if (!overwrite) return "cancel"
          state.overwriteTarget = target
        }
        return "next"
      },
    },
    // Step 2: 原生 Agent 预设
    {
      name: "nativePolicy",
      run: async () => {
        const t = TEXTS[state.lang]
        const result = await ask(p.select, {
          message: t.selectNativePolicy,
          options: [
            { value: "o4e-only", label: t.nativePolicyO4EOnly, hint: t.nativePolicyO4EOnlyDesc },
            { value: "managed", label: t.nativePolicyManaged, hint: t.nativePolicyManagedDesc },
            { value: "keep", label: t.nativePolicyKeep, hint: t.nativePolicyKeepDesc },
            { value: "custom", label: t.nativePolicyCustom, hint: t.nativePolicyCustomDesc },
          ],
          initialValue: state.nativePolicy,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        if (result !== state.nativePolicy) state.nativeStrategies = nativePolicyStrategies(result, state.nativeStrategies)
        state.nativePolicy = result
        return "next"
      },
    },
    // Step 3: 仅在选择 custom 时逐项设置原生 Agent
    {
      name: "nativeAgents",
      active: () => shouldConfigureNativeAgents(state.nativePolicy),
      run: async () => {
        const t = TEXTS[state.lang]
        p.log.message(`\n${t.configureNativeAgents}`)
        for (const name of NATIVE_AGENT_NAMES) {
          const result = await ask(p.select, {
            message: name,
            options: [
              { value: "keep", label: t.nativeStrategyKeep, hint: t.nativeStrategyKeepDesc },
              { value: "managed", label: t.nativeStrategyManaged, hint: t.nativeStrategyManagedDesc },
              { value: "disable", label: t.nativeStrategyDisable, hint: t.nativeStrategyDisableDesc },
            ],
            initialValue: state.nativeStrategies[name],
          })
          if (result === NAVIGATE_BACK) return "back"
          if (result === EXIT_INSTALLER) return "exit"
          state.nativeStrategies[name] = result
        }
        state.selectedAgents = withManagedNativeAgents(state.selectedAgents, state.nativeStrategies)
        return "next"
      },
    },
    // Step 4: 选择主 Agent
    {
      name: "primaryAgents",
      run: async () => {
        const t = TEXTS[state.lang]
        const primaryAgentIds = new Set(defaultAgentSelectionGroups().primary)
        const agentOptions = AGENT_DEFINITIONS.filter((agent) => primaryAgentIds.has(agent.id)).map((agent) => ({
          value: agent.id,
          label: `${agentLabel(agent, state.lang)} [${agent.type}]`,
          hint: `${agent.roleName[state.lang]} - ${agent.description[state.lang]}`,
        }))
        const result = await ask(p.multiselect, {
          message: t.selectPrimaryAgents,
          options: agentOptions,
          initialValues: state.selectedAgents,
          required: true,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        const selectedSubagents = state.selectedAgents.filter((id) => AGENT_DEFINITIONS.find((agent) => agent.id === id)?.type === "subagent")
        state.selectedAgents = withManagedNativeAgents([...result, ...selectedSubagents], state.nativeStrategies)
        return "next"
      },
    },
    // Step 5: 选择子 Agent
    {
      name: "subagents",
      run: async () => {
        const t = TEXTS[state.lang]
        const subagentIds = new Set(defaultAgentSelectionGroups().subagent)
        const agentOptions = AGENT_DEFINITIONS.filter((agent) => subagentIds.has(agent.id)).map((agent) => ({
          value: agent.id,
          label: `${agentLabel(agent, state.lang)} [${agent.type}]`,
          hint: `${agent.roleName[state.lang]} - ${agent.description[state.lang]}`,
        }))
        const result = await ask(p.multiselect, {
          message: t.selectSubagents,
          options: agentOptions,
          initialValues: state.selectedAgents,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        const selectedPrimaryAgents = state.selectedAgents.filter((id) => ["all", "primary"].includes(AGENT_DEFINITIONS.find((agent) => agent.id === id)?.type))
        state.selectedAgents = withManagedNativeAgents([...selectedPrimaryAgents, ...result], state.nativeStrategies)
        return "next"
      },
    },
    // Step 6: 选择受管 Skill
    {
      name: "skills",
      run: async () => {
        const t = TEXTS[state.lang]
        const result = await ask(p.multiselect, {
          message: t.selectSkills,
          options: defaultSkillNames().map((name) => ({ value: name, label: name })),
           initialValues: state.selectedSkills,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
         state.selectedSkills = result
        return "next"
      },
    },
    {
      name: "modelMode",
      run: async () => {
        const t = TEXTS[state.lang]
        const result = await ask(p.select, {
          message: t.selectModelMode,
          options: [
            { value: "all", label: t.modelModeAll },
            { value: "by-type", label: t.modelModeByType, hint: "primary / all / subagent" },
            { value: "per-agent", label: t.modelModePerAgent },
          ],
          initialValue: state.modelMode,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        state.modelMode = result
        return "next"
      },
    },
    {
      name: "models",
      run: async () => {
        const t = TEXTS[state.lang]
        const task = modelCatalogs.prefetch(modelCatalogCwd())
        const spinner = task.pending ? p.spinner() : null
        spinner?.start(t.loadingModels)
        const models = await task.promise
        spinner?.stop(`${t.modelsLoaded}: ${models.length}`)
        const selected = AGENT_DEFINITIONS.filter((agent) => state.selectedAgents.includes(agent.id))
        const choices = state.modelMode === "all" ? ["default"]
          : state.modelMode === "by-type" ? [...new Set(selected.map((agent) => agent.type))]
            : selected.map((agent) => agent.id)
        for (const key of choices) {
          const previous = state.modelMode === "all" ? state.defaultModel
            : state.modelMode === "by-type" ? state.byTypeModels[key] : state.agentModels[key]
          const model = await selectModel(ask, p, models, state.modelMode === "all" ? t.selectDefaultModel : `${t.selectModel} (${key})`, previous?.id, t)
          if (model === NAVIGATE_BACK) return "back"
          if (model === EXIT_INSTALLER) return "exit"
          const variants = models.find((item) => item.id === model)?.variants
          let variant
          if (variants?.length) {
            variant = await ask(p.select, {
              message: `${t.selectVariant} (${key})`,
              options: variants.map((value) => ({ value, label: value })),
              initialValue: previous?.id === model && variants.includes(previous.variant) ? previous.variant : variants.includes("high") ? "high" : variants[0],
            })
            if (variant === NAVIGATE_BACK) return "back"
            if (variant === EXIT_INSTALLER) return "exit"
          }
          const value = model ? { id: model, ...(variant ? { variant } : {}) } : null
          if (state.modelMode === "all") state.defaultModel = value
          else if (state.modelMode === "by-type") state.byTypeModels[key] = value
          else state.agentModels[key] = value
        }
        return "next"
      },
    },
    // SOUL 配置
    {
      name: "soul",
      run: async () => {
        if (args["no-soul"]) return "next"
        const t = TEXTS[state.lang]
        p.log.message(`\n${t.enableSoul}`)
        p.log.info(t.soulDescription)
        const result = await ask(p.confirm, {
          message: t.enableSoul,
          initialValue: state.enableSoul,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        state.enableSoul = result
        return "next"
      },
    },
    // Step 8: 确认
    {
      name: "confirm",
      run: async () => {
        const t = TEXTS[state.lang]
        const target = state.scope === "global"
          ? globalConfigRoot()
          : resolveTarget(args.target || ".")

        const enabledAgents = state.selectedAgents
        p.log.message(`\n${t.installPath}: ${target}`)
        p.log.message(`${t.agentsConfigured}: ${configuredAgentLabels(enabledAgents, state.lang).join(", ")}`)
        p.log.message(`${t.nativeAgentsConfigured}: ${nativeStrategySummary(state.nativeStrategies, t)}`)
        p.log.message(state.enableSoul ? t.soulEnabled : t.soulDisabled)

        const result = await ask(p.confirm, {
          message: t.confirmContinue,
          initialValue: true,
        })
        if (result === NAVIGATE_BACK) return "back"
        if (result === EXIT_INSTALLER) return "exit"
        if (!result) return "cancel"

        // 执行安装
        const spinner = p.spinner()
        spinner.start(t.configSaved)

        const materializedModels = materializeModelConfig({
          mode: state.modelMode,
          all: state.defaultModel,
          byType: state.byTypeModels,
          perAgent: state.agentModels,
          selectedAgents: AGENT_DEFINITIONS.filter((agent) => state.selectedAgents.includes(agent.id)),
        })
        const agentConfigs = {}
        for (const agent of AGENT_DEFINITIONS) {
          const enabled = state.selectedAgents.includes(agent.id)
          agentConfigs[agent.id] = { enabled, ...(enabled ? materializedModels.agents[agent.id] : {}) }
        }

        const writeResult = writeConfig(target, {
          lang: state.lang,
          soul: state.enableSoul,
          defaultModel: materializedModels.defaultModel,
          nativeAgents: state.nativeStrategies,
          agents: agentConfigs,
        }, { force: args.force || state.overwriteTarget === target, global: state.scope === "global", targetExistsError: t.errorTargetExists, selectedSkillNames: state.selectedSkills })

        if (writeResult.success) {
          spinner.stop(t.installComplete)
          p.outro(`${t.installComplete} ✓\n${t.installPath}: ${target}`)
        } else {
          spinner.stop("Installation failed")
          p.cancel(writeResult.error)
          process.exit(1)
        }
        return "done"
      },
    },
  ]

  // 执行步骤
  while (currentStep >= 0 && currentStep < steps.length) {
    const step = steps[currentStep]
    if (step.active && !step.active()) {
        currentStep++
      continue
    }
    const result = await step.run()

    if (result === "next") {
      currentStep++
    } else if (result === "back") {
      if (currentStep === 0) {
        p.cancel("Installation cancelled")
        return
      }
      currentStep -= 1
      while (currentStep >= 0 && steps[currentStep].active && !steps[currentStep].active()) currentStep -= 1
    } else if (result === "cancel" || result === "exit") {
      p.cancel("Installation cancelled")
      return
    } else if (result === "done") {
      break
    }
  }
}

async function selectModel(ask, p, models, message, initialValue, t) {
  const result = await ask(p.autocomplete, {
    message,
    options: [{ value: USE_CURRENT_MODEL, label: t.modelNone, hint: "" }, ...models.map((model) => ({
      value: model.id,
      label: model.name,
      hint: [model.provider, model.id, model.variants?.join(", ")].filter(Boolean).join(" | "),
    }))],
    initialValue: initialValue ?? USE_CURRENT_MODEL,
    placeholder: t.searchPlaceholder,
    maxItems: 10,
    filter: (search, option) => {
      const term = search.trim().toLowerCase()
      return !term || `${option.value}\n${option.label}\n${option.hint ?? ""}`.toLowerCase().includes(term)
    },
  })
  return result === USE_CURRENT_MODEL ? null : result
}

// 静默模式
function runCliInstaller() {
  const lang = args.lang
  const enableSoul = !args["no-soul"]
  const target = args.global
    ? globalConfigRoot()
    : resolveTarget(args.target || ".")

  const t = TEXTS[lang]

  console.log(`\n${t.welcome}`)
  console.log(`${t.installPath}: ${target}`)

  // 生成配置
  const nativeInstallOptions = resolveNativeInstallOptions(args, { requireCompleteCustom: true })
  const selectedSkillNames = resolveSkillSelection(args)
  const config = generateSilentConfig(lang, enableSoul, nativeInstallOptions.strategies)
  console.log(`${t.nativeAgentsConfigured}: ${nativeStrategySummary(config.nativeAgents, t)}`)

  // 写入配置
  const result = writeConfig(target, config, { force: args.force, global: args.global, targetExistsError: t.errorTargetExists, selectedSkillNames })

  if (result.success) {
    console.log(`\n${t.installComplete} ✓`)
    console.log(`${t.configSaved}`)
    console.log(`${t.agentsConfigured}: ${configuredAgentLabels(Object.keys(config.agents).filter((k) => config.agents[k].enabled), lang).join(", ")}`)
    console.log(enableSoul ? t.soulEnabled : t.soulDisabled)
  } else {
    console.error(`\nInstallation failed: ${result.error}`)
    process.exit(1)
  }
}

// 静默模型配置
function runCliModel() {
  const t = TEXTS[args.lang] ?? TEXTS.en
  let change
  try {
    change = parseModelCliOptions(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  if (!change.touched) {
    console.error("model requires at least one of --default-model, --default-variant, --model or --variant")
    process.exit(2)
  }
  const target = args.global ? globalConfigRoot() : resolveTarget(args.target || ".")
  try {
    const result = applyModelChanges({
      target,
      global: args.global,
      defaultModel: change.defaultModel,
      defaultVariant: change.defaultVariant,
      agents: change.agents,
    })
    if (result.changes.length === 0) {
      console.log(t.modelNoChanges)
      return
    }
    console.log(`\n${t.modelApplied} ✓`)
    for (const entry of result.changes) {
      console.log(`  ${entry.target}: ${formatModelValue(entry.value)}`)
    }
    console.log(`Runtime rebuilt: ${target}`)
  } catch (error) {
    console.error(`\n${t.modelFailed}: ${error.message}`)
    process.exit(1)
  }
}

// 交互式模型配置
async function runTuiModel() {
  const p = await import("@clack/prompts")
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Error: the interactive model configuration requires a TTY. Use --no-tui for silent mode.")
    process.exit(1)
  }
  // Esc 返回条目菜单；第一步或 Ctrl+C 直接退出。
  async function ask(prompt, options) {
    let navigation
    const onKeypress = (character, key) => {
      if (key?.name === "escape" || character === "\u001b") {
        navigation = NAVIGATE_BACK
      } else if ((key?.ctrl && key.name === "c") || character === "\u0003") {
        navigation = EXIT_INSTALLER
      }
    }
    process.stdin.on("keypress", onKeypress)
    try {
      const result = await prompt(options)
      if (p.isCancel(result)) return navigation ?? EXIT_INSTALLER
      return result
    } finally {
      process.stdin.off("keypress", onKeypress)
    }
  }

  // INS-006：进入命令即对项目和全局候选范围并行后台预加载模型目录；
  // 语言/范围选择、阅读当前配置和浏览菜单期间目录已在加载，模型选择不再是首次触发。
  const modelCatalogs = createModelCatalogLoader()
  const catalogCwdFor = (directory) => (lstatIfPresent(directory)?.isDirectory() ? directory : process.cwd())
  modelCatalogs.prefetch(catalogCwdFor(resolveTarget(args.target || ".")))
  modelCatalogs.prefetch(catalogCwdFor(globalConfigRoot()))

  // 与交互安装/卸载一致，先选择界面语言；--lang 仅作为初始值。
  const lang = await ask(p.select, {
    message: TEXTS.en.selectLanguage,
    options: [
      { value: "zh", label: TEXTS.en.langZh },
      { value: "en", label: TEXTS.en.langEn },
    ],
    initialValue: args.lang === "zh" ? "zh" : "en",
  })
  if (lang === NAVIGATE_BACK || lang === EXIT_INSTALLER) {
    p.cancel("Cancelled")
    return
  }
  const t = TEXTS[lang]

  p.intro(t.modelWelcome)

  // 范围选择：未显式 --target/--global 时让用户选择项目或全局。
  let target
  let global = args.global
  if (global) {
    target = globalConfigRoot()
  } else if (hasTargetArgument) {
    target = resolveTarget(args.target || ".")
  } else {
    const projectTarget = resolveTarget(".")
    const globalTarget = globalConfigRoot()
    const scopeOptions = []
    if (existsSync(join(projectTarget, ".o4e"))) scopeOptions.push({ value: "project", label: t.scopeProject, hint: projectTarget })
    if (existsSync(join(globalTarget, ".o4e"))) scopeOptions.push({ value: "global", label: t.scopeGlobal, hint: globalTarget })
    if (scopeOptions.length === 0) {
      p.cancel(t.noConfigFound)
      process.exit(1)
    }
    const scope = await ask(p.select, { message: t.modelSelectScope, options: scopeOptions, initialValue: scopeOptions[0].value })
    if (scope === NAVIGATE_BACK || scope === EXIT_INSTALLER) {
      p.cancel("Cancelled")
      return
    }
    global = scope === "global"
    target = global ? globalTarget : projectTarget
  }
  // 范围确定后立即为最终目标预加载（同目录任务幂等复用）。
  const catalogCwd = catalogCwdFor(target)
  modelCatalogs.prefetch(catalogCwd)

  let state
  try {
    state = readModelConfiguration(modelConfigRoot({ target, global }))
  } catch (error) {
    p.cancel(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  p.log.message(`\n${t.modelCurrent}:`)
  p.log.message(`  defaultModel: ${formatModelValue(state.defaultModel, { inherit: t.modelHostCurrent })}`)
  for (const agent of state.agents) {
    p.log.message(`  ${agent.name} (${agent.type}): ${formatModelValue(agent.model, { inherit: t.modelInherit })}`)
  }

  const DEFAULT_KEY = "__default__"
  const DONE_KEY = "__done__"
  const changes = new Map()
  const describe = (key, current, nullText) => {
    if (changes.has(key)) {
      const change = changes.get(key)
      return `${t.modelPending}: ${change.model === null ? nullText : formatModelValue({ id: change.model, ...(change.variant ? { variant: change.variant } : {}) })}`
    }
    return formatModelValue(current, { inherit: nullText })
  }

  for (;;) {
    const options = [
      { value: DEFAULT_KEY, label: t.modelDefaultTarget, hint: describe(DEFAULT_KEY, state.defaultModel, t.modelHostCurrent) },
      ...state.agents.map((agent) => ({
        value: agent.name,
        label: `${agent.name} (${agent.type})`,
        hint: describe(agent.name, agent.model, t.modelInherit),
      })),
      { value: DONE_KEY, label: t.modelTargetDone },
    ]
    const picked = await ask(p.select, { message: t.modelSelectTarget, options, initialValue: DEFAULT_KEY })
    if (picked === EXIT_INSTALLER) {
      p.cancel("Cancelled")
      return
    }
    if (picked === NAVIGATE_BACK || picked === DONE_KEY) break

    const task = modelCatalogs.prefetch(catalogCwd)
    const spinner = task.pending ? p.spinner() : null
    spinner?.start(t.loadingModels)
    const models = await task.promise
    spinner?.stop(`${t.modelsLoaded}: ${models.length}`)

    const agent = state.agents.find((item) => item.name === picked)
    const current = picked === DEFAULT_KEY ? state.defaultModel : agent.model
    const pending = changes.get(picked)
    const previous = pending !== undefined
      ? (pending.model === null ? null : { id: pending.model, variant: pending.variant })
      : (typeof current === "string" ? { id: current } : current)
    const model = await selectModel(ask, p, models, picked === DEFAULT_KEY ? t.selectDefaultModel : `${t.selectModel} (${picked})`, previous?.id, t)
    if (model === NAVIGATE_BACK) continue
    if (model === EXIT_INSTALLER) {
      p.cancel("Cancelled")
      return
    }
    let variant
    if (model) {
      const variants = models.find((item) => item.id === model)?.variants
      if (variants?.length) {
        variant = await ask(p.select, {
          message: `${t.selectVariant} (${picked})`,
          options: variants.map((value) => ({ value, label: value })),
          initialValue: previous?.id === model && variants.includes(previous.variant) ? previous.variant : variants.includes("high") ? "high" : variants[0],
        })
        if (variant === NAVIGATE_BACK) continue
        if (variant === EXIT_INSTALLER) {
          p.cancel("Cancelled")
          return
        }
      }
    }
    changes.set(picked, { model, variant })
  }

  if (changes.size === 0) {
    p.log.message(t.modelNoChanges)
    p.outro(t.modelNoChanges)
    return
  }

  let defaultModel
  let defaultVariant
  const agentChanges = []
  for (const [key, change] of changes) {
    if (key === DEFAULT_KEY) {
      defaultModel = change.model
      defaultVariant = change.variant
    } else {
      agentChanges.push({ name: key, model: change.model, variant: change.variant })
    }
  }

  const spinner = p.spinner()
  spinner.start(t.modelApplying)
  try {
    const result = applyModelChanges({ target, global, defaultModel, defaultVariant, agents: agentChanges })
    spinner.stop(`${t.modelApplied} ✓`)
    for (const entry of result.changes) {
      p.log.message(`  ${entry.target}: ${formatModelValue(entry.value, { inherit: t.modelHostCurrent })}`)
    }
    p.outro(`${t.modelApplied} ✓\n${t.installPath}: ${target}`)
  } catch (error) {
    spinner.stop(t.modelFailed)
    p.cancel(`${t.modelFailed}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// 写入配置
export function writeConfig(target, config, { force = false, global = false, targetExistsError, selectedSkillNames = defaultSkillNames() } = {}) {
  let backupDir
  let backupConfigDir
  let configModified = false
  let keepBackup = false
  let runtimeSnapshot
  try {
    const o4eDir = join(target, ".o4e")
    if (existsSync(o4eDir) && !force) {
      throw new Error(targetExistsError || "Target directory already contains configuration; use --force to overwrite")
    }
    if (global) readGlobalRegistry(target, { allowComments: true })
    assertConfigRoot(target)
    if (existsSync(o4eDir)) {
      assertPlainConfigTree(o4eDir)
    }
    const soulFile = existingSoulFile(o4eDir)
    const defaultsDir = join(__dirname, "..", "defaults", ".o4e")
    if (!existsSync(defaultsDir)) throw new Error(`Default configuration directory is missing: ${defaultsDir}`)
    const promptLanguage = config.lang === "en" ? "en" : "cn"
    if (installerManagedConfigFiles(defaultsDir, promptLanguage).has(soulFile)) {
      throw new Error(`Soul cannot use the same path as an installer-managed configuration file: ${soulFile}`)
    }
    const existingSoulPath = join(o4eDir, soulFile)
    const existingSoulStat = lstatIfPresent(existingSoulPath)
    if (existingSoulStat && !existingSoulStat.isFile()) throw new Error(`Soul must be a regular file: ${existingSoulPath}`)
    const existingSoulContent = existingSoulStat ? readFileSync(existingSoulPath) : undefined
    const existingSoulMode = existingSoulStat ? existingSoulStat.mode & 0o7777 : undefined

    // Reject ownership conflicts before copying defaults over an existing configuration.
    assertWritableRuntimeTarget(target, { global })
    runtimeSnapshot = snapshotManagedRuntime(global ? target : join(target, ".opencode"))

    // Fail before modifying the target when the required source prompt is unavailable.
    const nativePrompts = currentNativePrompts()

    // Start from complete, buildable defaults and replace only explicit choices.
    mkdirSync(target, { recursive: true })
    if (existsSync(o4eDir)) {
      backupDir = mkdtempSync(join(target, ".o4e-install-backup-"))
      backupConfigDir = join(backupDir, ".o4e")
      cpSync(o4eDir, backupConfigDir, { recursive: true })
    }
    configModified = true
    mkdirSync(o4eDir, { recursive: true })
    for (const entry of readdirSync(defaultsDir)) {
      // Soul is user-owned after creation and is handled separately below.
      if (entry === "soul.md" || /^soul\.(?:zh|en)\.md$/.test(entry)) continue
      if (entry === "prompts" || entry === "skills") continue
      cpSync(join(defaultsDir, entry), join(o4eDir, entry), { recursive: true, force })
    }
    const defaultSkills = readManagedSkills(defaultsDir, { required: true })
    const installedSkillRoot = join(o4eDir, "skills")
    mkdirSync(installedSkillRoot, { recursive: true })
    for (const skill of defaultSkills) {
      const installedRoot = join(installedSkillRoot, skill.name)
      rmSync(installedRoot, { recursive: true, force: true })
      if (selectedSkillNames.includes(skill.name)) {
        cpSync(skill.directory, installedRoot, { recursive: true, force: true })
      }
    }
    mkdirSync(join(o4eDir, "prompts"), { recursive: true })
    cpSync(join(defaultsDir, "prompts", "AGENTS.md"), join(o4eDir, "prompts", "AGENTS.md"), { force })
    cpSync(join(defaultsDir, "prompts", promptLanguage), join(o4eDir, "prompts"), { recursive: true, force })
    // Keep JSONC comments and complete defaults in the installed source files.
    let mainConfig = readFileSync(join(defaultsDir, "config.jsonc"), "utf-8")
    const defaultDefinition = AGENT_DEFINITIONS.find((agent) => ["all", "primary"].includes(agent.type) && config.agents[agent.id]?.enabled)
    if (!defaultDefinition) throw new Error("Installation requires at least one selectable Agent")
    const defaultSource = JSON.parse(stripJsonComments(readFileSync(defaultDefinition.path, "utf-8")))
    const defaultAgent = expandPlanProfiles([defaultSource])[0].name
    mainConfig = mainConfig.replace(/^(\s*)"language"\s*:/m, (_match, indentation) => `${indentation}"defaultAgent": ${JSON.stringify(defaultAgent)},\n${indentation}"language":`)
    mainConfig = replaceJsoncTemplateValue(mainConfig, "language", '"zh"', config.lang === "en" ? "en" : "zh", "Default configuration")
    mainConfig = replaceJsoncTemplateValue(mainConfig, "defaultModel", "null", config.defaultModel ?? null, "Default configuration")
    if (config.fallbackModels !== undefined) mainConfig = replaceJsoncTemplateValue(mainConfig, "fallbackModels", '\\[\\]', config.fallbackModels, "Default configuration")
    mainConfig = replaceJsoncTemplateValue(mainConfig, "nativeAgents", '\\{"build":"managed","plan":"managed","general":"managed","explore":"managed"\\}', config.nativeAgents, "Default native Agent configuration")
    mainConfig = replaceJsoncTemplateValue(mainConfig, "enabled", "true", config.soul, "Default Soul configuration")
    mainConfig = replaceJsoncTemplateValue(mainConfig, "file", '"soul.md"', soulFile, "Default Soul configuration")
    mainConfig = replaceJsoncTemplateValue(mainConfig, "promptsDir", '"prompts/cn"', "prompts", "Default prompt configuration")
    writeFileSync(join(o4eDir, "config.jsonc"), mainConfig)

    // 写入 SOUL.md
    const soulPath = join(o4eDir, soulFile)
    if (existingSoulContent !== undefined) {
      mkdirSync(dirname(soulPath), { recursive: true })
      writeFileSync(soulPath, existingSoulContent)
      chmodSync(soulPath, existingSoulMode)
    } else if (config.soul) {
      const soulTemplate = readFileSync(join(defaultsDir, soulTemplateName(config.lang)), "utf-8")
      mkdirSync(dirname(soulPath), { recursive: true })
      writeFileSync(soulPath, soulTemplate)
    }

    // Keep each enabled agent as an annotated JSONC default.
    for (const agent of AGENT_DEFINITIONS) {
      const agentConfig = config.agents[agent.id]
      const agentDir = join(o4eDir, "agents", agent.type)
      const agentPath = join(agentDir, `${agent.id}.jsonc`)
      for (const extension of [".json", ".jsonc"]) rmSync(join(agentDir, `${agent.id}${extension}`), { force: true })
      if (!agentConfig?.enabled) {
        continue
      }

      let agentDef = readFileSync(agent.path, "utf-8")
      agentDef = materializeDefaultAgentMetadata(agentDef, agent, config.lang === "en" ? "en" : "zh", `${agent.id} default Agent configuration`)
      const model = agentConfig.model
        ? typeof agentConfig.model === "string"
          ? { id: agentConfig.model, ...(agentConfig.variant ? { variant: agentConfig.variant } : {}) }
          : agentConfig.model
        : null
      agentDef = replaceJsoncTemplateValue(agentDef, "model", "null", model, `${agent.id} default Agent configuration`)
      if (agentConfig.fallbackModels !== undefined) agentDef = replaceJsoncTemplateValue(agentDef, "fallbackModels", '\\[\\]', agentConfig.fallbackModels, `${agent.id} default Agent configuration`)
      writeFileSync(agentPath, agentDef)
    }

    localizeInstalledAgentComments(o4eDir, config.lang === "en" ? "en" : "zh", AGENT_DEFINITIONS.filter((agent) => config.agents[agent.id]?.enabled))
    rmSync(join(o4eDir, "agents", "default.jsonc"), { force: true })
    rmSync(join(o4eDir, "agents", "default.json"), { force: true })

    syncNativePrompts(o4eDir, nativePrompts)
    rebuildRuntime(target, { global })
    return { success: true }
  } catch (error) {
    if (!configModified) return { success: false, error: error.message }

    const o4eDir = join(target, ".o4e")
    let failedConfigDir
    try {
      failedConfigDir = preserveFailedConfig(target, o4eDir, ".o4e-install-failed-")
      if (backupConfigDir) {
        cpSync(backupConfigDir, o4eDir, { recursive: true })
      }
      restoreManagedRuntime(runtimeSnapshot)
    } catch (rollbackError) {
      keepBackup = Boolean(backupConfigDir)
      return {
        success: false,
        error: backupConfigDir
          ? `${error.message}; original configuration backup retained at ${backupConfigDir}: ${rollbackError.message}`
          : `${error.message}; cleanup failed: ${rollbackError.message}`,
      }
    }
    return {
      success: false,
      error: failedConfigDir ? `${error.message}; failed configuration retained at ${failedConfigDir}` : error.message,
    }
  } finally {
    if (backupDir && !keepBackup) rmSync(backupDir, { recursive: true, force: true })
  }
}

function rebuildRuntime(target, { global = false } = {}) {
  buildRuntime({ target, global })
  if (global) {
    installGlobalPlugin(target, join(target, "plugins", "opencode-for-everything.ts"))
  }
}

function archivePath(path) {
  const resolved = resolve(process.cwd(), path)
  if (!resolved.endsWith(".o4e.tar.gz")) {
    throw new Error("Configuration archive filename must end with .o4e.tar.gz")
  }
  return resolved
}

function localTarArchive(path) {
  return { cwd: dirname(path), argument: `./${basename(path)}` }
}

function tarCommand() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  return process.platform === "win32" && systemRoot ? join(systemRoot, "System32", "tar.exe") : "tar"
}

export function tarOutputLines(output) {
  return output.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).filter(Boolean)
}

export function isSafeArchiveEntryPath(entry) {
  if (typeof entry !== "string" || !entry || entry.includes("\\") || /[\0\r\n]/.test(entry)) return false
  const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry
  if (normalized === ".o4e") return true
  if (!normalized.startsWith(".o4e/")) return false
  const segments = normalized.split("/")
  const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
  return segments.every((segment, index) => {
    if (index === 0) return segment === ".o4e"
    return Boolean(segment)
      && segment !== "."
      && segment !== ".."
      && !segment.includes(":")
      && !/[. ]$/.test(segment)
      && !windowsDeviceName.test(segment)
  })
}

function snapshotImportArchive(archive, stagingDir) {
  const sourceStat = lstatIfPresent(archive)
  if (!sourceStat) throw new Error(`Configuration archive does not exist: ${archive}`)
  if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
    throw new Error(`Configuration archive source must be an unlinked regular file: ${archive}`)
  }

  const stagedArchive = join(stagingDir, "source.o4e.tar.gz")
  let sourceFd
  let targetFd
  try {
    sourceFd = openSync(archive, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const openedStat = fstatSync(sourceFd)
    if (!openedStat.isFile() || openedStat.nlink !== 1 || openedStat.dev !== sourceStat.dev || openedStat.ino !== sourceStat.ino) {
      throw new Error(`Configuration archive source changed while opening: ${archive}`)
    }
    targetFd = openSync(stagedArchive, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead
    while ((bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
      let written = 0
      while (written < bytesRead) {
        written += writeSync(targetFd, buffer, written, bytesRead - written, null)
      }
    }
  } finally {
    if (targetFd !== undefined) closeSync(targetFd)
    if (sourceFd !== undefined) closeSync(sourceFd)
  }
  return stagedArchive
}

function exportConfig(target, outputPath) {
  const o4eDir = join(target, ".o4e")
  const archive = archivePath(outputPath)
  assertConfigRoot(target)
  if (!existsSync(o4eDir)) throw new Error(`Configuration directory not found: ${o4eDir}`)
  assertPlainConfigTree(o4eDir)
  if (!existsSync(dirname(archive))) {
    throw new Error(`Archive output directory does not exist: ${dirname(archive)}`)
  }
  const archiveStat = lstatIfPresent(archive)
  if (archiveStat && (!archiveStat.isFile() || archiveStat.nlink !== 1)) throw new Error(`Configuration archive target must be an unlinked regular file: ${archive}`)
  const realConfigRoot = realpathSync(o4eDir)
  const realArchiveParent = realpathSync(dirname(archive))
  const archiveRelativePath = relative(realConfigRoot, join(realArchiveParent, archive.split(/[\\/]/).at(-1)))
  if (!archiveRelativePath || (!archiveRelativePath.startsWith("..") && !isAbsolute(archiveRelativePath))) {
    throw new Error("Configuration archive cannot be written inside the .o4e directory")
  }
  const stagingDir = mkdtempSync(join(dirname(archive), ".o4e-export-"))
  const stagedArchive = join(stagingDir, "config.o4e.tar.gz")
  const tarArchive = localTarArchive(stagedArchive)
  try {
    execFileSync(tarCommand(), ["-C", target, "-czf", tarArchive.argument, ".o4e"], { cwd: tarArchive.cwd, encoding: "utf8", stdio: "pipe" })
    validateArchiveEntries(stagedArchive)
    chmodSync(stagedArchive, archiveStat?.mode ?? 0o600)
    renameSync(stagedArchive, archive)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  return archive
}

function validateArchiveEntries(archive) {
  const tarArchive = localTarArchive(archive)
  const options = {
    cwd: tarArchive.cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, QUOTING_STYLE: "escape", TAR_OPTIONS: "" },
  }
  const entries = tarOutputLines(execFileSync(tarCommand(), ["-tzf", tarArchive.argument], options)).map((entry) => {
    // GNU and BSD tar escape non-printable high bytes as octal in C locales.
    // Decode only UTF-8 byte runs; literal backslashes and ASCII escapes remain
    // visible to the existing unsafe-path check.
    if (entry.includes("\\\\")) return entry
    try {
      return entry.replace(/(?:\\[23][0-7]{2})+/g, (escaped) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Uint8Array.from(escaped.match(/[23][0-7]{2}/g), (octet) => parseInt(octet, 8)),
      ))
    } catch {
      throw new Error(`Configuration archive contains a non-UTF-8 entry: ${JSON.stringify(entry)}`)
    }
  })
  const invalidEntry = entries.find((entry) => !isSafeArchiveEntryPath(entry))
  if (entries.length === 0 || invalidEntry !== undefined) {
    throw new Error(`Configuration archive may only contain the .o4e directory with safe portable filenames${invalidEntry === undefined ? "" : `; unsupported entry: ${JSON.stringify(invalidEntry)}`}`)
  }
  const entryTypes = tarOutputLines(execFileSync(tarCommand(), ["-tvzf", tarArchive.argument], options))
    .map((entry) => entry[0])
  if (entryTypes.some((type) => type !== "-" && type !== "d")) {
    throw new Error("Configuration archive cannot contain symlinks, hard links, or special files")
  }
}

function importConfig(target, inputPath, { force = false, global = false } = {}) {
  const archive = archivePath(inputPath)
  const o4eDir = join(target, ".o4e")
  if (!global && !existsSync(target)) {
    throw new Error("Target directory does not exist")
  }
  if (existsSync(o4eDir) && !force) {
    throw new Error("Target directory already contains configuration; use --force to overwrite")
  }
  if (global) readGlobalRegistry(target, { allowComments: true })
  assertConfigRoot(target)
  assertWritableRuntimeTarget(target, { global })

  const archiveStagingDir = mkdtempSync(join(tmpdir(), "o4e-import-archive-"))
  let stagingDir
  let backupDir
  let backupConfigDir
  let importedConfigInstalled = false
  let keepBackup = false
  let runtimeSnapshot
  try {
    const stagedArchive = snapshotImportArchive(archive, archiveStagingDir)
    validateArchiveEntries(stagedArchive)
    mkdirSync(target, { recursive: true })
    stagingDir = mkdtempSync(join(target, ".o4e-import-"))
    const tarArchive = localTarArchive(stagedArchive)
    execFileSync(tarCommand(), ["-xzf", tarArchive.argument, "-C", stagingDir, "--no-same-owner", "--no-same-permissions"], { cwd: tarArchive.cwd, encoding: "utf8", stdio: "pipe" })
    const importedDir = join(stagingDir, ".o4e")
    assertPlainConfigTree(importedDir)
    if (!existsSync(join(importedDir, "config.json")) && !existsSync(join(importedDir, "config.jsonc"))) {
      throw new Error("Configuration archive is missing .o4e/config.json or .o4e/config.jsonc")
    }
    assertWritableRuntimeTarget(target, { global })
    runtimeSnapshot = snapshotManagedRuntime(global ? target : join(target, ".opencode"))
    if (existsSync(o4eDir)) {
      backupDir = mkdtempSync(join(target, ".o4e-backup-"))
      backupConfigDir = join(backupDir, ".o4e")
      renameSync(o4eDir, backupConfigDir)
    }
    renameSync(importedDir, o4eDir)
    importedConfigInstalled = true
    rebuildRuntime(target, { global })
  } catch (error) {
    let failedConfigDir
    if (backupConfigDir && existsSync(backupConfigDir)) {
      try {
        failedConfigDir = preserveFailedConfig(target, o4eDir, ".o4e-import-failed-")
        renameSync(backupConfigDir, o4eDir)
      } catch (rollbackError) {
        keepBackup = true
        throw new Error(`${error.message}; original configuration retained at ${backupConfigDir}: ${rollbackError.message}`)
      }
      try {
        restoreManagedRuntime(runtimeSnapshot)
      } catch (rollbackError) {
        throw new Error(`${error.message}; original configuration restored, but runtime restore failed: ${rollbackError.message}`)
      }
    } else if (importedConfigInstalled) {
      failedConfigDir = preserveFailedConfig(target, o4eDir, ".o4e-import-failed-")
      restoreManagedRuntime(runtimeSnapshot)
    }
    throw new Error(failedConfigDir ? `${error.message}; failed configuration retained at ${failedConfigDir}` : error.message)
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true })
    rmSync(archiveStagingDir, { recursive: true, force: true })
    if (backupDir && !keepBackup) rmSync(backupDir, { recursive: true, force: true })
  }
}

async function runCliImport(path) {
  const target = args.global ? globalConfigRoot() : resolveTarget(args.target || ".")
  const o4eDir = join(target, ".o4e")
  const configExists = existsSync(o4eDir)
  let confirmedOverwrite = args.force
  if (configExists && !confirmedOverwrite) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("The target already contains configuration; use --force for non-interactive import")
      process.exit(1)
    }

    const p = await import("@clack/prompts")
    const confirmed = await p.confirm({
      message: `The target already contains .o4e configuration. Overwrite it with the archive? ${target}`,
      initialValue: false,
    })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Import cancelled")
      return
    }
    confirmedOverwrite = true
  }

  try {
    importConfig(target, path, { force: confirmedOverwrite, global: args.global })
    console.log(`Configuration imported and runtime rebuilt: ${target}`)
  } catch (error) {
    console.error(`Import failed: ${error.message}`)
    process.exit(1)
  }
}

function prepareManagedRuntimeRemoval(runtimeRoot) {
  const pluginsDir = join(runtimeRoot, "plugins")
  const agentsDir = join(runtimeRoot, "agents")
  assertDirectoryIfPresent(runtimeRoot, "Runtime root must be a regular directory; refusing to remove")
  assertDirectoryIfPresent(pluginsDir, "Runtime plugin directory must be a regular directory; refusing to remove")
  assertDirectoryIfPresent(agentsDir, "Runtime agent directory must be a regular directory; refusing to remove")
  assertDirectoryIfPresent(join(runtimeRoot, "tui"), "Runtime TUI directory must be a regular directory; refusing to remove")
  const modules = readRuntimeModules(pluginsDir)
  const paths = []

  for (const filename of RUNTIME_PLUGIN_FILES) {
    const pluginPath = join(pluginsDir, filename)
    const stat = lstatIfPresent(pluginPath)
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Runtime plugin must be an unlinked regular file; refusing to remove: ${pluginPath}`)
      paths.push(pluginPath)
    }
  }
  paths.push(...modules.files)
  paths.push(...readRuntimeModules(join(runtimeRoot, "tui")).files)

  if (existsSync(agentsDir)) {
    for (const filename of readdirSync(agentsDir)) {
      const agentPath = join(agentsDir, filename)
      if (!filename.endsWith(".md")) continue
      const stat = lstatSync(agentPath)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Runtime agent must be an unlinked regular file; refusing to remove: ${agentPath}`)
      if (readFileSync(agentPath, "utf-8").includes(`<!--${COMPONENT}-agent:`)) {
        paths.push(agentPath)
      }
    }
  }

  return paths
}

function removeManagedRuntime(runtimeRoot, paths = prepareManagedRuntimeRemoval(runtimeRoot)) {
  for (const path of paths) rmSync(path, { recursive: true, force: true })
  return paths.length
}

function hasManagedRuntime(runtimeRoot) {
  const pluginsDir = join(runtimeRoot, "plugins")
  if (RUNTIME_PLUGIN_FILES.some((filename) => existsSync(join(pluginsDir, filename)))) {
    return true
  }

  if (readRuntimeModules(pluginsDir).files.length > 0) return true
  if (readRuntimeModules(join(runtimeRoot, "tui")).files.length > 0) return true

  const agentsDir = join(runtimeRoot, "agents")
  return existsSync(agentsDir) && readdirSync(agentsDir).some((filename) => {
    const agentPath = join(agentsDir, filename)
    return filename.endsWith(".md") && lstatSync(agentPath).isFile() && readFileSync(agentPath, "utf-8").includes(`<!--${COMPONENT}-agent:`)
  })
}

function printStatus(target, { global = false } = {}) {
  const runtimeRoot = global ? target : join(target, ".opencode")
  const configRoot = join(target, ".o4e")
  assertDirectoryIfPresent(runtimeRoot, "Runtime root must be a regular directory; refusing to inspect")
  assertDirectoryIfPresent(join(runtimeRoot, "tui"), "Runtime TUI directory must be a regular directory; refusing to inspect")
  assertDirectoryIfPresent(join(runtimeRoot, "tui", RUNTIME_COMPONENT_DIRECTORY), "Runtime TUI component must be a regular directory; refusing to inspect")
  assertDirectoryIfPresent(configRoot, "Configuration root must be a regular directory; refusing to inspect")
  const scope = global ? `global (${runtimeRoot})` : `project (${runtimeRoot})`
  console.log(`==> ${COMPONENT} installation status (${scope})`)
  const configPaths = [join(configRoot, "config.json"), join(configRoot, "config.jsonc")]
  for (const path of configPaths) {
    const stat = lstatIfPresent(path)
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Configuration file must be an unlinked regular file; refusing to inspect: ${path}`)
  }
  console.log(configPaths.some((path) => lstatIfPresent(path)?.isFile()) ? "  [installed] config" : "  [missing]   config")

  const labels = { "opencode-for-everything.ts": "plugin" }
  for (const filename of RUNTIME_PLUGIN_FILES) {
    const label = labels[filename]
    const stat = lstatIfPresent(join(runtimeRoot, "plugins", filename))
    const installed = stat?.isFile() && stat.nlink === 1
    console.log(installed ? `  [installed] ${label}` : `  [missing]   ${label}`)
  }
  const componentFiles = sourceRuntimeFiles()
  const runtimeLabels = {
    "model-fallback.mjs": "model reference utilities",
    "agent-context.mjs": "agent context",
    "agent-layout.mjs": "agent layout",
    "soul.mjs": "soul",
    "prompt-file.mjs": "prompt reader",
    "jsonc.mjs": "jsonc",
  }
  for (const { relativePath } of componentFiles) {
    const path = runtimeModulePath(runtimeRoot, relativePath)
    const stat = lstatIfPresent(path)
    const installed = stat?.isFile() && stat.nlink === 1
    const label = runtimeLabels[relativePath] ?? `runtime/${portablePath(relativePath)}`
    console.log(installed ? `  [installed] ${label}` : `  [missing]   ${label}`)
  }
  console.log(tuiPluginRegistered(runtimeRoot) ? "  [registered] TUI task overview (activation is host-controlled)" : "  [unregistered] TUI task overview")
  const configuredSkills = readManagedSkills(configRoot)
  if (configuredSkills.length === 0) {
    console.log("  [disabled]  managed skills")
  } else {
    for (const skill of configuredSkills) {
      const label = skill.name === "o4e-agent-creator" ? "agent creator skill" : `skill: ${skill.name}`
      console.log(`  [installed] ${label}`)
    }
  }
  if (global) {
    const registered = globalPluginRegistered(runtimeRoot, join(runtimeRoot, "plugins", "opencode-for-everything.ts"), { allowComments: true })
    console.log(registered ? "  [active]   global plugin registry" : "  [inactive] global plugin registry")
  }
}

// 卸载函数
function uninstall(target, { global = false, keepConfig = true } = {}) {
  const o4eDir = join(target, ".o4e")
  const runtimeRoot = global ? target : join(target, ".opencode")

  try {
    if (!existsSync(o4eDir) && !hasManagedRuntime(runtimeRoot)) {
      return { success: false, error: "No opencode-for-everything configuration found" }
    }
    if (!global) {
      assertConfigRoot(target)
      const runtimeStat = lstatIfPresent(runtimeRoot)
      if (runtimeStat && !runtimeStat.isDirectory()) throw new Error(`Runtime root must be a regular directory; refusing to remove: ${runtimeRoot}`)
    }
    const runtimeRemoval = prepareManagedRuntimeRemoval(runtimeRoot)
    const removeTuiRegistration = prepareTuiRegistrationRemoval(runtimeRoot)
    const removeGlobalPluginRegistration = global
      ? prepareGlobalPluginRegistrationRemoval(runtimeRoot, join(runtimeRoot, "plugins", "opencode-for-everything.ts"), { allowComments: true })
      : null
    removeGlobalPluginRegistration?.()
    removeTuiRegistration()
    removeManagedRuntime(runtimeRoot, runtimeRemoval)

    if (!keepConfig && existsSync(o4eDir)) {
      rmSync(o4eDir, { recursive: true, force: true })
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

// TUI 卸载模式
async function runTuiUninstaller() {
  const p = await import("@clack/prompts")

  // 检查 TTY
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Error: the interactive uninstaller requires a TTY. Use uninstall --no-tui for silent uninstallation.")
    process.exit(1)
  }

  // 检测项目级配置
  const projectTarget = resolveTarget(".")
  const projectHasConfig = existsSync(join(projectTarget, ".o4e")) || hasManagedRuntime(join(projectTarget, ".opencode"))

  // 检测全局配置
  const globalTarget = globalConfigRoot()
  const globalHasConfig = existsSync(join(globalTarget, ".o4e")) || hasManagedRuntime(globalTarget)

  // 选择语言
  const lang = await p.select({
    message: TEXTS.en.selectLanguage,
    options: [
      { value: "zh", label: TEXTS.en.langZh },
      { value: "en", label: TEXTS.en.langEn },
    ],
    initialValue: "en",
  })

  if (p.isCancel(lang)) {
    p.cancel("Uninstallation cancelled")
    process.exit(0)
  }

  const t = TEXTS[lang]

  p.intro(t.uninstallWelcome)

  // 选择卸载范围
  const scopeOptions = []
  if (projectHasConfig) {
    scopeOptions.push({ value: "project", label: t.scopeProject, hint: t.scopeProjectDesc })
  }
  if (globalHasConfig) {
    scopeOptions.push({ value: "global", label: t.scopeGlobal, hint: t.scopeGlobalDesc })
  }

  if (scopeOptions.length === 0) {
    p.cancel(t.noConfigFound)
    process.exit(1)
  }

  const scope = await p.select({
    message: t.selectUninstallScope,
    options: scopeOptions,
    initialValue: scopeOptions[0].value,
  })

  if (p.isCancel(scope)) {
    p.cancel("Uninstallation cancelled")
    process.exit(0)
  }

  const target = scope === "global" ? globalTarget : projectTarget

  // 选择是否保留配置
  const keepConfig = await p.confirm({
    message: t.keepConfig,
    initialValue: true,
  })

  if (p.isCancel(keepConfig)) {
    p.cancel("Uninstallation cancelled")
    process.exit(0)
  }

  // 确认卸载
  p.log.message(`\n${t.uninstallPath}: ${target}`)
  p.log.message(keepConfig ? t.willKeepConfig : t.willRemoveConfig)

  const confirm = await p.confirm({
    message: t.confirmUninstall,
    initialValue: true,
  })

  if (p.isCancel(confirm) || !confirm) {
    p.cancel("Uninstallation cancelled")
    process.exit(0)
  }

  // 执行卸载
  const spinner = p.spinner()
  spinner.start(t.uninstalling)

  const result = uninstall(target, { global: scope === "global", keepConfig })

  if (result.success) {
    spinner.stop(t.uninstallComplete)
    p.outro(`${t.uninstallComplete} ✓`)
  } else {
    spinner.stop(t.uninstallFailed)
    p.cancel(result.error)
    process.exit(1)
  }
}

// 主入口
if (IS_MAIN && command === "status") {
  const target = args.global ? globalConfigRoot() : resolveTarget(args.target)
  if (!args.global && !existsSync(target)) {
    console.error("Target directory does not exist")
    process.exit(1)
  }
  printStatus(target, { global: args.global })
} else if (IS_MAIN && command === "build") {
  const target = args.global ? globalConfigRoot() : resolveTarget(args.target)
  try {
    buildRuntime({ target, global: args.global })
    console.log(`Runtime rebuilt: ${target}`)
  } catch (error) {
    console.error(`Build failed: ${error.message}`)
    process.exit(1)
  }
} else if (IS_MAIN && command === "export") {
  const target = args.global ? globalConfigRoot() : resolveTarget(args.target || ".")
  try {
    const archive = exportConfig(target, archiveFile)
    console.log(`Configuration exported: ${archive}`)
  } catch (error) {
    console.error(`Export failed: ${error.message}`)
    process.exit(1)
  }
} else if (IS_MAIN && command === "import") {
  runCliImport(archiveFile).catch((error) => {
    console.error(`Importer error: ${error.message}`)
    process.exit(1)
  })
} else if (IS_MAIN && command === "uninstall") {
  if (args["no-tui"]) {
    // 静默卸载模式
    const target = args.global
      ? globalConfigRoot()
      : resolveTarget(args.target || ".")

    console.log(`\nUninstalling opencode-for-everything`)
    console.log(`Target path: ${target}`)

    const result = uninstall(target, { global: args.global })

    if (result.success) {
      console.log(`\nUninstallation complete ✓`)
      console.log(`Managed runtime files removed`)
      console.log(`Configuration kept: ${join(target, ".o4e")}`)
    } else {
      console.error(`\nUninstallation failed: ${result.error}`)
      process.exit(1)
    }
  } else {
    // 交互式卸载模式
    runTuiUninstaller().catch((error) => {
      console.error("Uninstaller error:", error)
      process.exit(1)
    })
  }
} else if (IS_MAIN && command === "install" && args["no-tui"]) {
  runCliInstaller()
} else if (IS_MAIN && command === "install") {
  runTuiInstaller().catch((error) => {
    console.error("Installer error:", error)
    process.exit(1)
  })
} else if (IS_MAIN && command === "model" && args["no-tui"]) {
  runCliModel()
} else if (IS_MAIN && command === "model") {
  runTuiModel().catch((error) => {
    console.error("Model configuration error:", error)
    process.exit(1)
  })
}
