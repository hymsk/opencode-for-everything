import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_TYPE_DIRECTORIES, NATIVE_MODES, SELECTABLE_AGENT_TYPES, SYSTEM_PHASE_AGENT_NAMES } from "./agent-layout.mjs"
import { stripJsonComments } from "./jsonc.mjs"
import { compileWorkflowRegistry } from "./core/workflow-definition.mjs"
import { normalizeAgentBackgroundTaskConfig, normalizeBackgroundTaskConfig } from "./core/background-task-domain.mjs"
import { normalizeMaxDelegationDepth } from "./core/agent-routing.mjs"
import { assertCanonicalPermissionName, BUILTIN_TOOL_NAMES, expandPlanProfiles } from "./core/capability-policy.mjs"
import { normalizeNativeAgentStrategies, resolveNativeAgentPolicy } from "./core/native-agent-policy.mjs"
import { readManagedSkills } from "./managed-skills.mjs"
import { prepareTuiRegistration, runtimeModulePath } from "./tui-registration.mjs"

const COMPONENT = "opencode-for-everything"
const CONFIG_DIR = ".o4e"
const PLUGIN_FILE = `${COMPONENT}.ts`
const RUNTIME_COMPONENT_DIRECTORY = "opencode-for-everything"
const RUNTIME_PARSER_DEPENDENCIES = { "tree-sitter-bash": "0.25.0", "web-tree-sitter": "0.25.10" }
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const DEFAULT_INSTRUCTION_FILE = "<default>"
const DEFAULT_SOUL_FILE = "soul.md"
const PROMPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const AGENT_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9-]*(?: \(plan\))?$/
const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const WORKFLOW_SKILL_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
const BUILTIN_TOOL_NAME_SET = new Set(BUILTIN_TOOL_NAMES)
const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/
const PERMISSION_ACTIONS = new Set(["allow", "ask", "deny"])
const MARKER = `<!--${COMPONENT}-agent:`
const __dirname = dirname(fileURLToPath(import.meta.url))
const SYSTEM_PHASE_AGENT_NAME_SET = new Set(SYSTEM_PHASE_AGENT_NAMES)

function fail(message) {
  throw new Error(`[${COMPONENT}] ${message}`)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    fail(`${label} 无法解析: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
}

function readJsonc(path, label) {
  try {
    const content = readFileSync(path, "utf8")
    return JSON.parse(stripJsonComments(content))
  } catch (error) {
    fail(`${label} 无法解析: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
}

function readConfigJson(configRoot, name, label) {
  // Try .jsonc first, then fall back to .json
  const baseName = name.replace(/\.json$/, '')
  const jsoncPath = join(configRoot, `${baseName}.jsonc`)
  const jsonPath = join(configRoot, `${baseName}.json`)
  if (existsSync(jsoncPath)) return readJsonc(jsoncPath, label)
  return readJson(jsonPath, label)
}

function configFiles(directory) {
  const selected = new Map()
  for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonc"))) {
    const name = file.endsWith(".jsonc") ? file.slice(0, -".jsonc".length) : file.slice(0, -".json".length)
    if (!selected.has(name) || file.endsWith(".jsonc")) selected.set(name, file)
  }
  return [...selected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, file]) => ({ name, file }))
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是对象`)
  return value
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} 不支持字段: ${key}`)
  }
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) fail(`${label} 必须是${allowEmpty ? "字符串" : "非空字符串"}`)
  return value
}

function requireModel(value, label) {
  if (typeof value === "string") value = { id: value }
  requireObject(value, label)
  assertOnlyKeys(value, new Set(["id", "variant"]), label)
  const id = requireString(value.id, `${label}.id`)
  if (!/^[^/\s]+\/[^\r\n]+$/.test(id)) fail(`${label} 必须使用 provider/model 格式`)
  const variant = value.variant === undefined ? undefined : requireString(value.variant, `${label}.variant`)
  if (variant !== undefined && /[\r\n]/.test(variant)) fail(`${label}.variant 必须为单行`)
  return variant === undefined ? { id } : { id, variant }
}

function optionalModel(value, label) {
  return value === undefined || value === null ? undefined : requireModel(value, label)
}

function normalizeFallbackModels(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是模型名称数组`)
  const models = value.map((model, index) => requireModel(model, `${label}[${index}]`))
  return models.filter((model, index) => models.findIndex((candidate) => candidate.id === model.id && candidate.variant === model.variant) === index)
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} 必须是布尔值`)
  return value
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} 必须是非负安全整数`)
  return value
}

function normalizeLoadTools(value, label) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) fail(`${label} 必须是内置工具名称数组`)
  const tools = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const tool = requireString(value[index], `${label}[${index}]`)
    if (!BUILTIN_TOOL_NAME_SET.has(tool)) fail(`${label}[${index}] 不支持的内置工具: ${tool}`)
    if (!seen.has(tool)) {
      seen.add(tool)
      tools.push(tool)
    }
  }
  return tools
}

function normalizeLoadableNames(value, label, { fallback, pattern = AGENT_NAME_PATTERN, expected = "小写名称" } = {}) {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) fail(`${label} 必须是名称数组`)
  const names = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = requireString(value[index], `${label}[${index}]`)
    if (name !== "*" && !pattern.test(name)) fail(`${label}[${index}] 只能是 * 或${expected}`)
    if (!seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

function normalizeSkillNames(value, label, { fallback } = {}) {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) fail(`${label} 必须是 Skill 名称数组`)
  const names = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = requireString(value[index], `${label}[${index}]`)
    if (name !== "*" && !SKILL_NAME_PATTERN.test(name)) fail(`${label}[${index}] 只能是 * 或小写 Skill 名称`)
    if (seen.has(name)) fail(`${label} 不能包含重复 Skill 名称: ${name}`)
    seen.add(name)
    names.push(name)
  }
  if (seen.has("*") && names.length !== 1) fail(`${label} 使用 * 时不能同时声明其他 Skill 名称`)
  return names
}

function normalizeBlockNames(value, label, { fallback = [] } = {}) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) fail(`${label} 必须是名称数组`)
  const names = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const name = requireString(value[index], `${label}[${index}]`)
    if (name !== "*" && !SKILL_NAME_PATTERN.test(name) && !MCP_NAME_PATTERN.test(name)) fail(`${label}[${index}] 名称不合法`)
    if (!seen.has(name)) { seen.add(name); names.push(name) }
  }
  return names
}

function normalizeBlockTools(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是内置工具名称数组`)
  return [...new Set(value.map((tool, index) => {
    const name = requireString(tool, `${label}[${index}]`)
    if (!BUILTIN_TOOL_NAME_SET.has(name)) fail(`${label}[${index}] 不支持的内置工具: ${name}`)
    return name
  }))]
}

function normalizeCapabilities(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是稳定技能 ID 数组`)
  const capabilities = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const capability = requireString(value[index], `${label}[${index}]`)
    if (!WORKFLOW_SKILL_PATTERN.test(capability)) fail(`${label}[${index}] 必须是稳定的点分技能 ID`)
    if (!seen.has(capability)) {
      seen.add(capability)
      capabilities.push(capability)
    }
  }
  return capabilities
}

function normalizePermissionAction(value, label) {
  const action = requireString(value, label)
  if (!PERMISSION_ACTIONS.has(action)) fail(`${label} 只能是 allow、ask 或 deny`)
  return action
}

function normalizePermission(value, label) {
  if (value === undefined) return undefined
  if (typeof value === "string") return normalizePermissionAction(value, label)
  requireObject(value, label)
  const permission = {}
  for (const [name, rawRule] of Object.entries(value)) {
    assertCanonicalPermissionName(name, label)
    if (typeof rawRule === "string") {
      permission[name] = normalizePermissionAction(rawRule, `${label}.${name}`)
      continue
    }
    requireObject(rawRule, `${label}.${name}`)
    permission[name] = Object.fromEntries(Object.entries(rawRule).map(([pattern, action]) => {
      if (pattern.trim() === "") fail(`${label}.${name} 包含空匹配模式`)
      return [pattern, normalizePermissionAction(action, `${label}.${name}.${pattern}`)]
    }))
  }
  return permission
}

function normalizePlan(value, label) {
  if (value === undefined) return undefined
  requireObject(value, label)
  assertOnlyKeys(value, new Set(["mode", "permission", "loadSkills", "loadTools", "loadMcp", "loadAgents", "loadWorkflows", "blockSkills", "blockTools", "blockMcp", "blockAgents", "blockWorkflows", "reminder"]), label)
  const mode = requireString(value.mode, `${label}.mode`)
  if (mode !== "self" && mode !== "child") fail(`${label}.mode 只能是 self 或 child`)
  return {
    mode,
    permission: normalizePermission(value.permission, `${label}.permission`),
    loadSkills: normalizeSkillNames(value.loadSkills, `${label}.loadSkills`),
    loadTools: normalizeLoadTools(value.loadTools, `${label}.loadTools`),
    loadMcp: normalizeMcpToolAccess(value.loadMcp, `${label}.loadMcp`),
    loadAgents: normalizeLoadableNames(value.loadAgents, `${label}.loadAgents`, { pattern: AGENT_REFERENCE_PATTERN, expected: "小写 Agent 名称或其 (plan) Profile" }),
    loadWorkflows: normalizeLoadableNames(value.loadWorkflows, `${label}.loadWorkflows`, { pattern: WORKFLOW_NAME_PATTERN, expected: "小写 Workflow 名称" }),
    blockSkills: normalizeBlockNames(value.blockSkills, `${label}.blockSkills`),
    blockTools: normalizeBlockTools(value.blockTools, `${label}.blockTools`),
    blockMcp: normalizeBlockNames(value.blockMcp, `${label}.blockMcp`),
    blockAgents: normalizeBlockNames(value.blockAgents, `${label}.blockAgents`),
    blockWorkflows: normalizeBlockNames(value.blockWorkflows, `${label}.blockWorkflows`),
    reminder: value.reminder === undefined ? undefined : requirePromptName(value.reminder, `${label}.reminder`),
  }
}

function normalizeMcpToolAccess(value, label) {
  if (value === undefined) return undefined
  requireObject(value, label)
  const access = {}
  for (const [server, toolNames] of Object.entries(value)) {
    if (server !== "*" && !MCP_NAME_PATTERN.test(server)) fail(`${label} 的 MCP server 名称不合法: ${server}`)
    if (!Array.isArray(toolNames)) fail(`${label}.${server} 必须是 MCP 工具名称数组`)
    const tools = []
    const seen = new Set()
    for (let index = 0; index < toolNames.length; index += 1) {
      const tool = requireString(toolNames[index], `${label}.${server}[${index}]`)
      if (tool !== "*" && !MCP_TOOL_NAME_PATTERN.test(tool)) fail(`${label}.${server}[${index}] 不是合法的 MCP 工具名称`)
      if (!seen.has(tool)) {
        seen.add(tool)
        tools.push(tool)
      }
    }
    access[server] = tools
  }
  return access
}

function normalizeStringMap(value, label) {
  requireObject(value, label)
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = requireString(item, `${label}.${key}`, { allowEmpty: true })
  return result
}

function normalizeMcpConfig(value, label) {
  if (value === undefined) return undefined
  requireObject(value, label)
  const servers = {}
  for (const [name, rawServer] of Object.entries(value)) {
    if (!MCP_NAME_PATTERN.test(name)) fail(`${label} 的 MCP server 名称不合法: ${name}`)
    requireObject(rawServer, `${label}.${name}`)
    const type = rawServer.type
    if (type === undefined) {
      assertOnlyKeys(rawServer, new Set(["enabled"]), `${label}.${name}`)
      servers[name] = { enabled: requireBoolean(rawServer.enabled, `${label}.${name}.enabled`) }
      continue
    }
    if (type === "local") {
      assertOnlyKeys(rawServer, new Set(["type", "command", "cwd", "environment", "enabled", "timeout"]), `${label}.${name}`)
      if (!Array.isArray(rawServer.command) || rawServer.command.length === 0) fail(`${label}.${name}.command 必须是非空命令数组`)
      const command = rawServer.command.map((item, index) => requireString(item, `${label}.${name}.command[${index}]`))
      const server = { type, command }
      if (rawServer.cwd !== undefined) server.cwd = requireString(rawServer.cwd, `${label}.${name}.cwd`)
      if (rawServer.environment !== undefined) server.environment = normalizeStringMap(rawServer.environment, `${label}.${name}.environment`)
      if (rawServer.enabled !== undefined) server.enabled = requireBoolean(rawServer.enabled, `${label}.${name}.enabled`)
      if (rawServer.timeout !== undefined) server.timeout = requireNonNegativeInteger(rawServer.timeout, `${label}.${name}.timeout`)
      if (server.timeout === 0) fail(`${label}.${name}.timeout 必须大于 0`)
      servers[name] = server
      continue
    }
    if (type === "remote") {
      assertOnlyKeys(rawServer, new Set(["type", "url", "headers", "oauth", "enabled", "timeout"]), `${label}.${name}`)
      const server = { type, url: requireString(rawServer.url, `${label}.${name}.url`) }
      if (rawServer.headers !== undefined) server.headers = normalizeStringMap(rawServer.headers, `${label}.${name}.headers`)
      if (rawServer.oauth !== undefined) {
        if (rawServer.oauth === false) server.oauth = false
        else {
          requireObject(rawServer.oauth, `${label}.${name}.oauth`)
          assertOnlyKeys(rawServer.oauth, new Set(["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"]), `${label}.${name}.oauth`)
          const oauth = {}
          for (const key of ["clientId", "clientSecret", "scope", "redirectUri"]) {
            if (rawServer.oauth[key] !== undefined) oauth[key] = requireString(rawServer.oauth[key], `${label}.${name}.oauth.${key}`)
          }
          if (rawServer.oauth.callbackPort !== undefined) {
            const port = requireNonNegativeInteger(rawServer.oauth.callbackPort, `${label}.${name}.oauth.callbackPort`)
            if (port < 1 || port > 65535) fail(`${label}.${name}.oauth.callbackPort 必须介于 1 和 65535`)
            oauth.callbackPort = port
          }
          server.oauth = oauth
        }
      }
      if (rawServer.enabled !== undefined) server.enabled = requireBoolean(rawServer.enabled, `${label}.${name}.enabled`)
      if (rawServer.timeout !== undefined) server.timeout = requireNonNegativeInteger(rawServer.timeout, `${label}.${name}.timeout`)
      if (server.timeout === 0) fail(`${label}.${name}.timeout 必须大于 0`)
      servers[name] = server
      continue
    }
    fail(`${label}.${name}.type 只能是 local 或 remote`)
  }
  return servers
}

function safeRelativePath(value, label) {
  const path = requireString(value, label)
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) fail(`${label} 必须是配置目录内的相对路径`)
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

function safeAbsolutePath(value, label) {
  const path = requireString(value, label)
  if (!isAbsolute(path)) fail(`${label} 必须是绝对路径或 ${DEFAULT_INSTRUCTION_FILE}`)
  return resolve(path)
}

function originalInstructionFiles() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const configHome = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config")
  return {
    global: [join(configHome, "opencode", "AGENTS.md"), join(homedir(), ".claude", "CLAUDE.md")],
    project: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"],
  }
}

function configuredDefaultInstructionFiles() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const configHome = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config")
  return { global: [join(configHome, "opencode", "AGENTS.md")], project: ["AGENTS.md"] }
}

function normalizeInstructionFileList(value, label, normalizePath, scopeDefaults) {
  if (!Array.isArray(value)) fail(`${label} 必须是提示词文件数组`)
  const files = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const paths = value[index] === DEFAULT_INSTRUCTION_FILE
      ? scopeDefaults
      : [normalizePath(value[index], `${label}[${index}]`)]
    for (const path of paths) {
      if (!seen.has(path)) {
        seen.add(path)
        files.push(path)
      }
    }
  }
  return files
}

function normalizeInstructionFiles(value, label, { requireScopes = false } = {}) {
  const originalDefaults = originalInstructionFiles()
  const configuredDefaults = configuredDefaultInstructionFiles()
  if (value === undefined) return originalDefaults
  requireObject(value, label)
  assertOnlyKeys(value, new Set(["global", "project"]), label)
  return {
    global: value.global === undefined
      ? (requireScopes ? fail(`${label}.global 是覆盖全局配置时的必填项`) : originalDefaults.global)
      : normalizeInstructionFileList(value.global, `${label}.global`, safeAbsolutePath, configuredDefaults.global),
    project: value.project === undefined
      ? (requireScopes ? fail(`${label}.project 是覆盖全局配置时的必填项`) : originalDefaults.project)
      : normalizeInstructionFileList(value.project, `${label}.project`, safeRelativePath, configuredDefaults.project),
  }
}

function requirePromptName(value, label) {
  const name = safeRelativePath(value, label)
  if (!PROMPT_NAME_PATTERN.test(name)) fail(`${label} 必须是安全的提示词片段名称`)
  return name
}

function normalizeNativeSystem(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) fail(`${label} 必须是非空提示词片段名称数组`)
  return value.map((name, index) => requirePromptName(name, `${label}[${index}]`))
}

function normalizeInjects(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是提示词片段名称数组`)
  return value.map((name, index) => requirePromptName(name, `${label}[${index}]`))
}

function normalizePromptFields(spec, label) {
  const nativeSystem = normalizeNativeSystem(spec.nativeSystem, `${label}.nativeSystem`)
  const base = spec.base === undefined ? "" : requireString(spec.base, `${label}.base`, { allowEmpty: true })
  const systemPrompt = spec.systemPrompt === undefined ? undefined : requirePromptName(spec.systemPrompt, `${label}.systemPrompt`)
  const injects = normalizeInjects(spec.injects, `${label}.injects`)
  const hasCoreOverride = Object.hasOwn(spec, "nativeSystem") || Object.hasOwn(spec, "base") || Object.hasOwn(spec, "systemPrompt") || Object.hasOwn(spec, "injects")
  if (spec.base !== undefined && spec.systemPrompt !== undefined) fail(`${label} 不能同时声明 base 与 systemPrompt`)
  if (nativeSystem && (spec.base !== undefined || spec.systemPrompt !== undefined || spec.injects !== undefined)) {
    fail(`${label}.nativeSystem 不能与 base、systemPrompt 或 injects 同时声明`)
  }
  return {
    nativeSystem,
    base,
    systemPrompt,
    injects,
    messagePrompt: spec.messagePrompt === undefined ? undefined : requirePromptName(spec.messagePrompt, `${label}.messagePrompt`),
    promptDir: spec.promptDir === undefined ? undefined : safeRelativePath(spec.promptDir, `${label}.promptDir`),
    hasCoreOverride,
  }
}

function normalizePromptDefaults(value, label) {
  if (value === undefined) return undefined
  requireObject(value, label)
  assertOnlyKeys(value, new Set(["nativeSystem", "base", "systemPrompt", "injects", "messagePrompt", "promptDir"]), label)
  const defaults = normalizePromptFields(value, label)
  if (!defaults.hasCoreOverride) fail(`${label} 至少需要声明 nativeSystem、base、systemPrompt 或 injects 之一`)
  return defaults
}

function validatePromptReferences(configRoot, promptDir, promptFields, label, { allowMissingSystemPrompt = false } = {}) {
  const promptRoot = resolve(configRoot, promptDir)
  const configRelative = relative(resolve(configRoot), promptRoot)
  if (configRelative === ".." || configRelative.startsWith("../") || configRelative.startsWith("..\\") || isAbsolute(configRelative)) {
    fail(`${label}.promptDir 超出配置目录`)
  }
  for (const prompt of [...(promptFields.nativeSystem ?? []), ...(promptFields.systemPrompt ? [promptFields.systemPrompt] : []), ...promptFields.injects]) {
    const allowMissing = allowMissingSystemPrompt && prompt === promptFields.systemPrompt
    if (!existsSync(join(promptRoot, `${prompt}.md`)) && !allowMissing) fail(`${label} 引用了不存在的提示词片段: ${promptDir}/${prompt}.md`)
  }
  if (promptFields.messagePrompt && !existsSync(join(promptRoot, `${promptFields.messagePrompt}.md`))) {
    fail(`${label} 引用了不存在的消息提示词片段: ${promptDir}/${promptFields.messagePrompt}.md`)
  }
}

function normalizeSoulConfig(value, label) {
  if (value === undefined) return { enabled: true, file: DEFAULT_SOUL_FILE, inheritMode: "override" }
  requireObject(value, label)
  assertOnlyKeys(value, new Set(["enabled", "file", "globalFile", "inheritMode"]), label)
  const enabled = value.enabled === undefined ? true : requireBoolean(value.enabled, `${label}.enabled`)
  const file = value.file === undefined ? DEFAULT_SOUL_FILE : safeRelativePath(value.file, `${label}.file`)
  const globalFile = value.globalFile === undefined ? undefined : requireString(value.globalFile, `${label}.globalFile`)
  if (globalFile !== undefined && !isAbsolute(globalFile)) fail(`${label}.globalFile 必须是绝对路径`)
  const inheritMode = value.inheritMode === undefined ? "override" : requireString(value.inheritMode, `${label}.inheritMode`)
  if (!["override", "extend"].includes(inheritMode)) fail(`${label}.inheritMode 只能是 override 或 extend`)
  return { enabled, file, globalFile, inheritMode }
}

function normalizeConfigDir(value, fallback, label) {
  if (value === undefined) return fallback
  return safeRelativePath(value, label)
}

function readConfig(configRoot) {
  const config = readConfigJson(configRoot, "config.json", "config.json")
  requireObject(config, "config.json")
  assertOnlyKeys(config, new Set([
    "enable_o4e_task_detail", "enableWorkflow",
    "$schema", "language", "defaultAgent", "defaultModel", "fallbackModels", "backgroundTasks", "maxDelegationDepth", "nativeAgents", "agentDefaults", "soul", "instructionFiles", "loadSkills", "loadTools", "loadMcp", "blockSkills", "blockTools", "blockMcp", "blockAgents", "blockWorkflows", "permission", "loadAgents", "loadWorkflows", "mcp", "promptsDir", "agentsDir", "workflowsDir", "_comment",
  ]), "config.json")
  const language = config.language === undefined ? "zh" : requireString(config.language, "config.language")
  if (!["zh", "en"].includes(language)) fail("config.language 只能是 zh 或 en")
  if (config.enable_o4e_task_detail !== undefined && typeof config.enable_o4e_task_detail !== "boolean") fail("config.enable_o4e_task_detail 必须为 boolean")
  if (config.enableWorkflow !== undefined && typeof config.enableWorkflow !== "boolean") fail("config.enableWorkflow 必须为 boolean")
  const promptsDir = normalizeConfigDir(config.promptsDir, "prompts", "config.promptsDir")
  const agentDefaults = normalizePromptDefaults(config.agentDefaults, "config.agentDefaults")
  const soul = normalizeSoulConfig(config.soul, "config.soul")
  if (config.nativeAgents === undefined) fail("config.nativeAgents 必须显式声明 build、plan、general 和 explore 策略")
  return {
    language,
    enable_o4e_task_detail: config.enable_o4e_task_detail ?? false,
    enableWorkflow: config.enableWorkflow ?? false,
    defaultModel: optionalModel(config.defaultModel, "config.defaultModel"),
    fallbackModels: normalizeFallbackModels(config.fallbackModels, "config.fallbackModels"),
    defaultAgent: config.defaultAgent === undefined ? undefined : requireString(config.defaultAgent, "config.defaultAgent"),
    backgroundTasks: normalizeBackgroundTaskConfig(config.backgroundTasks, { label: "config.backgroundTasks" }),
    maxDelegationDepth: normalizeMaxDelegationDepth(config.maxDelegationDepth, "config.maxDelegationDepth"),
    nativeAgents: normalizeNativeAgentStrategies(config.nativeAgents, "config.nativeAgents"),
    promptsDir,
    agentsDir: normalizeConfigDir(config.agentsDir, "agents", "config.agentsDir"),
    workflowsDir: normalizeConfigDir(config.workflowsDir, "workflows", "config.workflowsDir"),
    agentDefaults,
    soul,
    instructionFiles: normalizeInstructionFiles(config.instructionFiles, "config.instructionFiles"),
    loadSkills: normalizeSkillNames(config.loadSkills, "config.loadSkills", { fallback: ["*"] }),
    loadTools: normalizeLoadTools(config.loadTools, "config.loadTools"),
    loadMcp: normalizeMcpToolAccess(config.loadMcp, "config.loadMcp") ?? { "*": ["*"] },
    blockSkills: normalizeBlockNames(config.blockSkills, "config.blockSkills"),
    blockTools: normalizeBlockTools(config.blockTools, "config.blockTools"),
    blockMcp: normalizeBlockNames(config.blockMcp, "config.blockMcp"),
    blockAgents: normalizeBlockNames(config.blockAgents, "config.blockAgents"),
    blockWorkflows: normalizeBlockNames(config.blockWorkflows, "config.blockWorkflows"),
    permission: normalizePermission(config.permission, "config.permission"),
    loadAgents: normalizeLoadableNames(config.loadAgents, "config.loadAgents", { fallback: ["*"], pattern: AGENT_REFERENCE_PATTERN, expected: "小写 Agent 名称或其 (plan) Profile" }),
    loadWorkflows: normalizeLoadableNames(config.loadWorkflows, "config.loadWorkflows", { fallback: ["*"], pattern: WORKFLOW_NAME_PATTERN, expected: "小写 Workflow 名称" }),
    mcp: normalizeMcpConfig(config.mcp, "config.mcp"),
  }
}

const PRIMARY_AGENT_FIELDS = new Set([
  "model", "fallbackModels",
  "$schema", "name", "description", "nativeMode", "plan", "nativeSystem", "backgroundTasks", "loadSkills", "loadTools", "loadMcp", "blockSkills", "blockTools", "blockMcp", "blockAgents", "blockWorkflows", "permission", "loadAgents", "loadWorkflows", "capabilities", "instructionFiles", "base", "systemPrompt", "injects", "messagePrompt", "promptDir",
])
const SUBAGENT_FIELDS = new Set([
  "model", "fallbackModels", "plan",
  "$schema", "name", "description", "nativeSystem", "backgroundTasks", "loadSkills", "loadTools", "loadMcp", "blockSkills", "blockTools", "blockMcp", "blockAgents", "blockWorkflows", "permission", "loadAgents", "loadWorkflows", "capabilities", "instructionFiles", "base", "systemPrompt", "injects", "messagePrompt", "promptDir",
])
const ALL_AGENT_FIELDS = new Set([...PRIMARY_AGENT_FIELDS].filter((field) => field !== "nativeMode"))
const SYSTEM_PHASE_AGENT_FIELDS = new Set([
  "$schema", "name", "systemPrompt", "injects", "promptDir", "instructionFiles", "loadSkills", "loadTools", "loadMcp", "blockSkills", "blockTools", "blockMcp",
])

function readName(spec, file, type) {
  const name = requireString(spec.name, `${file}.name`)
  if (!AGENT_NAME_PATTERN.test(name)) fail(`${file}.name 只能包含小写字母、数字和连字符`)
  const expectedBase = file.endsWith(".jsonc") ? file.slice(0, -".jsonc".length) : file.slice(0, -".json".length)
  if (expectedBase !== name) fail(`${type}/${file} 的文件名必须与 name 一致`)
  return name
}

function readConfigurableAgents(configRoot, config, type) {
  const directory = AGENT_TYPE_DIRECTORIES[type]
  const agentsRoot = join(configRoot, config.agentsDir, directory)
  if (!existsSync(agentsRoot)) fail(`未找到 ${directory} agent 配置目录: ${agentsRoot}`)
  const files = configFiles(agentsRoot)
  const fields = type === "primary" ? PRIMARY_AGENT_FIELDS : type === "all" ? ALL_AGENT_FIELDS : SUBAGENT_FIELDS
  const defaults = config.agentDefaults
  const agents = []
  for (const { name, file } of files) {
    const label = `${directory}/${file}`
    const spec = requireObject(readConfigJson(agentsRoot, `${name}.json`, `agent 配置 ${label}`), label)
    assertOnlyKeys(spec, fields, label)
    readName(spec, file, directory)
    const description = requireString(spec.description, `${label}.description`)
    if (/[\r\n]/.test(description)) fail(`${label}.description 不能包含换行`)
    const overrides = normalizePromptFields(spec, label)
    const promptSource = overrides.hasCoreOverride ? overrides : defaults
    if (!promptSource) fail(`${label} 必须声明提示词字段，或配置对应的默认提示词`)
    const promptDir = overrides.promptDir ?? defaults?.promptDir ?? config.promptsDir
    const messagePrompt = overrides.messagePrompt ?? defaults?.messagePrompt
    const promptFields = { ...promptSource, messagePrompt }
    validatePromptReferences(configRoot, promptDir, promptFields, label, { allowMissingSystemPrompt: type === "primary" && ["build", "plan"].includes(spec.nativeMode) && promptFields.systemPrompt !== undefined })
    let nativeMode
    let plan
    if ([...SELECTABLE_AGENT_TYPES, "subagent"].includes(type)) {
      if (spec.nativeMode !== undefined) {
        if (type !== "primary") fail(`${label}.nativeMode 只能用于 primary agent`)
        nativeMode = requireString(spec.nativeMode, `${label}.nativeMode`)
        if (!NATIVE_MODES.includes(nativeMode)) fail(`${label}.nativeMode 只能是 build 或 plan`)
      }
      plan = normalizePlan(spec.plan, `${label}.plan`)
      if (nativeMode === "plan" && plan?.mode !== "self") fail(`${label} 声明 nativeMode: plan 时必须同时声明 plan.mode: self`)
      if (plan?.reminder) validatePromptReferences(configRoot, promptDir, { base: "", injects: [], messagePrompt: plan.reminder }, `${label}.plan`)
    }
    agents.push({
      type,
      name,
      description,
      nativeMode,
      plan,
      model: spec.model === undefined || spec.model === null ? config.defaultModel : requireModel(spec.model, `${label}.model`),
      fallbackModels: spec.fallbackModels === undefined ? config.fallbackModels : normalizeFallbackModels(spec.fallbackModels, `${label}.fallbackModels`),
      backgroundTasks: normalizeAgentBackgroundTaskConfig(spec.backgroundTasks, config.backgroundTasks, { label: `${label}.backgroundTasks` }),
      nativeSystem: promptSource.nativeSystem,
      base: promptSource.base,
      systemPrompt: promptSource.systemPrompt,
      injects: promptSource.injects,
      messagePrompt,
      promptDir,
      loadSkills: spec.loadSkills === undefined ? [...config.loadSkills] : normalizeSkillNames(spec.loadSkills, `${label}.loadSkills`),
      loadTools: spec.loadTools === undefined ? config.loadTools : normalizeLoadTools(spec.loadTools, `${label}.loadTools`),
      loadMcp: spec.loadMcp === undefined ? config.loadMcp : normalizeMcpToolAccess(spec.loadMcp, `${label}.loadMcp`),
      blockSkills: [...config.blockSkills, ...normalizeBlockNames(spec.blockSkills, `${label}.blockSkills`)],
      blockTools: [...config.blockTools, ...normalizeBlockTools(spec.blockTools, `${label}.blockTools`)],
      blockMcp: [...config.blockMcp, ...normalizeBlockNames(spec.blockMcp, `${label}.blockMcp`)],
      blockAgents: [...config.blockAgents, ...normalizeBlockNames(spec.blockAgents, `${label}.blockAgents`)],
      blockWorkflows: [...config.blockWorkflows, ...normalizeBlockNames(spec.blockWorkflows, `${label}.blockWorkflows`)],
      permission: spec.permission === undefined ? config.permission : normalizePermission(spec.permission, `${label}.permission`),
      loadAgents: spec.loadAgents === undefined ? config.loadAgents : normalizeLoadableNames(spec.loadAgents, `${label}.loadAgents`, { pattern: AGENT_REFERENCE_PATTERN, expected: "小写 Agent 名称或其 (plan) Profile" }),
      loadWorkflows: spec.loadWorkflows === undefined ? config.loadWorkflows : normalizeLoadableNames(spec.loadWorkflows, `${label}.loadWorkflows`, { pattern: WORKFLOW_NAME_PATTERN, expected: "小写 Workflow 名称" }),
      capabilities: normalizeCapabilities(spec.capabilities, `${label}.capabilities`),
      instructionFiles: spec.instructionFiles === undefined
        ? config.instructionFiles
        : normalizeInstructionFiles(spec.instructionFiles, `${label}.instructionFiles`, { requireScopes: true }),
    })
  }
  return agents
}

function readSystemPhaseAgents(configRoot, config) {
  const directory = AGENT_TYPE_DIRECTORIES.system
  const agentsRoot = join(configRoot, config.agentsDir, directory)
  if (!existsSync(agentsRoot)) fail(`未找到 ${directory} agent 配置目录: ${agentsRoot}`)
  const agents = []
  const files = configFiles(agentsRoot)
  for (const { name, file } of files) {
    const label = `${directory}/${file}`
    const spec = requireObject(readConfigJson(agentsRoot, `${name}.json`, `agent 配置 ${label}`), label)
    assertOnlyKeys(spec, SYSTEM_PHASE_AGENT_FIELDS, label)
    readName(spec, file, directory)
    if (!SYSTEM_PHASE_AGENT_NAME_SET.has(name)) fail(`${label}.name 不是受支持的系统内部阶段 agent`)
    const systemPrompt = requirePromptName(spec.systemPrompt, `${label}.systemPrompt`)
    const injects = normalizeInjects(spec.injects, `${label}.injects`)
    const promptDir = safeRelativePath(spec.promptDir ?? config.promptsDir, `${label}.promptDir`)
    validatePromptReferences(configRoot, promptDir, { base: "", systemPrompt, injects }, label)
    agents.push({
      type: "system",
      name,
      systemPrompt,
      injects,
      promptDir,
      loadSkills: spec.loadSkills === undefined ? [...config.loadSkills] : normalizeSkillNames(spec.loadSkills, `${label}.loadSkills`),
      loadTools: spec.loadTools === undefined ? config.loadTools : normalizeLoadTools(spec.loadTools, `${label}.loadTools`),
      loadMcp: spec.loadMcp === undefined ? config.loadMcp : normalizeMcpToolAccess(spec.loadMcp, `${label}.loadMcp`),
      blockSkills: [...config.blockSkills, ...normalizeBlockNames(spec.blockSkills, `${label}.blockSkills`)],
      blockTools: [...config.blockTools, ...normalizeBlockTools(spec.blockTools, `${label}.blockTools`)],
      blockMcp: [...config.blockMcp, ...normalizeBlockNames(spec.blockMcp, `${label}.blockMcp`)],
      instructionFiles: spec.instructionFiles === undefined
        ? config.instructionFiles
        : normalizeInstructionFiles(spec.instructionFiles, `${label}.instructionFiles`, { requireScopes: true }),
    })
  }
  return agents
}

function validateAgentLayout(primaryAgents, subagents, allModeAgents, systemPhaseAgents) {
  const names = new Set()
  const configurableAgents = [...primaryAgents, ...subagents, ...allModeAgents]
  for (const agent of [...configurableAgents, ...systemPhaseAgents]) {
    if (names.has(agent.name)) fail(`agent 名重复: ${agent.name}`)
    names.add(agent.name)
  }
  for (const nativeName of NATIVE_MODES) {
    const sameName = configurableAgents.find((agent) => agent.name === nativeName)
    if (sameName && (sameName.type !== "primary" || sameName.nativeMode !== nativeName)) {
      fail(`agent 名 ${nativeName} 只能由声明 nativeMode: ${nativeName} 的主 agent 使用`)
    }
  }
  const nativeModes = new Map()
  for (const agent of [...primaryAgents, ...allModeAgents]) {
    if (agent.nativeMode) {
      if (nativeModes.has(agent.nativeMode)) fail(`nativeMode 重复: ${agent.nativeMode}`)
      nativeModes.set(agent.nativeMode, agent.name)
    }
  }
  const runtimeNames = new Set(systemPhaseAgents.map((agent) => agent.name))
  for (const agent of expandPlanProfiles([...primaryAgents, ...allModeAgents, ...subagents])) {
    if (runtimeNames.has(agent.name)) fail(`Plan Profile 生成的 runtime agent 名冲突: ${agent.name}`)
    runtimeNames.add(agent.name)
  }
}

function renderAgent(agent, configRoot) {
  const mode = agent.type
  const model = agent.model ? `model: ${agent.model.id}${agent.model.variant === undefined ? "" : `\nvariant: ${agent.model.variant}`}\n` : ""
  if (agent.nativeSystem) {
    return `---\nname: ${agent.name}\ndescription: ${agent.description}\n${model}mode: ${mode}\n---\n${MARKER}${agent.name}-->\n`
  }
  const promptRoot = resolve(configRoot, agent.promptDir)
  const parts = []
  if (agent.systemPrompt) {
    const promptPath = join(promptRoot, `${agent.systemPrompt}.md`)
    if (existsSync(promptPath)) parts.push(readFileSync(promptPath, "utf8").trim())
  }
  else if (agent.base) parts.push(agent.base.trim())
  for (const inject of agent.injects) {
    const content = readFileSync(join(promptRoot, `${inject}.md`), "utf8").trim()
    parts.push(`# ${inject}\n${content}`)
  }
  return `---\nname: ${agent.name}\ndescription: ${agent.description}\n${model}mode: ${mode}\n---\n${MARKER}${agent.name}-->\n${parts.join("\n\n")}\n`
}

function sameContent(path, expected) {
  if (!existsSync(path)) return false
  const current = readFileSync(path)
  const content = Buffer.isBuffer(expected) ? expected : Buffer.from(expected)
  return current.equals(content)
}

function writeIfChanged(path, content) {
  if (sameContent(path, content)) return
  assertGeneratedFileIfPresent(path)
  mkdirSync(dirname(path), { recursive: true })
  assertGeneratedFileIfPresent(path)
  writeFileSync(path, content)
  console.log(`generated ${path}`)
}

export function sourceRuntimeFiles() {
  const files = []
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = join(relativeDirectory, entry.name)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path, relativePath)
      else if (entry.isFile()) files.push({ source: path, relativePath })
    }
  }
  visit(__dirname)
  return files
}

function runtimeComponentPath(pluginsRoot, relativePath = "") {
  return join(pluginsRoot, RUNTIME_COMPONENT_DIRECTORY, relativePath)
}

function assertManagedComponentTree(pluginsRoot) {
  assertDirectoryIfPresent(pluginsRoot, "运行时 plugin 目录")
  const componentRoot = runtimeComponentPath(pluginsRoot)
  assertDirectoryIfPresent(componentRoot, "组件运行时目录")
  if (!existsSync(componentRoot)) return

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        assertDirectoryIfPresent(path, "组件运行时目录")
        visit(path)
      } else {
        const stat = lstatIfPresent(path)
        if (!stat?.isFile() || stat.nlink !== 1) fail(`组件运行时目录必须是普通目录，拒绝覆盖: ${path}`)
      }
    }
  }
  visit(componentRoot)
}

function assertGeneratedFileIfPresent(path) {
  const stat = lstatIfPresent(path)
  if (stat && (!stat.isFile() || stat.nlink !== 1)) fail(`生成目标必须是独立普通文件，拒绝覆盖: ${path}`)
  return stat
}

const lstatIfPresent = (path) => lstatSync(path, { throwIfNoEntry: false })

function assertDirectoryIfPresent(path, label) {
  const stat = lstatIfPresent(path)
  if (stat && !stat.isDirectory()) fail(`${label}必须是普通目录，拒绝覆盖: ${path}`)
}

function assertPlainConfigTree(root) {
  assertDirectoryIfPresent(root, "配置根目录")
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      assertPlainConfigTree(path)
    } else if (!entry.isFile() || lstatSync(path).nlink !== 1) {
      fail(`配置目录不能包含链接或特殊文件: ${path}`)
    }
  }
}

function readWorkflows(configRoot, config) {
  const workflowsRoot = join(configRoot, config.workflowsDir)
  if (!existsSync(workflowsRoot)) return new Map()
  const definitions = configFiles(workflowsRoot).map(({ name, file }) => {
    const source = join(config.workflowsDir, file)
    const value = readConfigJson(workflowsRoot, `${name}.json`, `Workflow ${source}`)
    if (value.name !== name) fail(`${source} 的文件名必须与 name 一致`)
    return { source, value }
  })
  try {
    return compileWorkflowRegistry(definitions)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

export function loadRuntimeDefinition(configRoot) {
  assertPlainConfigTree(configRoot)
  const config = readConfig(configRoot)
  const agentsRoot = join(configRoot, config.agentsDir)
  if (existsSync(join(agentsRoot, "default.jsonc")) || existsSync(join(agentsRoot, "default.json"))) {
    fail("agents/default.jsonc 仅属于仓库默认模板；安装目标必须将 description 写入具体 Agent JSONC")
  }
  const primaryAgents = readConfigurableAgents(configRoot, config, "primary")
  const subagents = readConfigurableAgents(configRoot, config, "subagent")
  const allModeAgents = readConfigurableAgents(configRoot, config, "all")
  const systemPhaseAgents = readSystemPhaseAgents(configRoot, config)
  const workflows = readWorkflows(configRoot, config)
  if (primaryAgents.length + allModeAgents.length === 0) fail("至少需要一个 agents/primary 或 agents/all 配置")
  validateAgentLayout(primaryAgents, subagents, allModeAgents, systemPhaseAgents)
  const configurableAgents = [...primaryAgents, ...subagents, ...allModeAgents]
  const runtimeSelectableAgents = expandPlanProfiles([...primaryAgents, ...allModeAgents])
  const runtimeAgents = [...runtimeSelectableAgents, ...expandPlanProfiles(subagents)].map((agent) => config.enableWorkflow
    ? agent
    : { ...agent, loadWorkflows: [], blockWorkflows: ["*"] })
  if (config.defaultAgent !== undefined && !runtimeSelectableAgents.some((agent) => agent.name === config.defaultAgent)) {
    fail("config.defaultAgent 必须指向已配置的可选 all/primary Agent 或其 Plan Profile")
  }
  return {
    config,
    primaryAgents,
    subagents,
    allModeAgents,
    runtimeAgents,
    systemPhaseAgents,
    workflows,
    nativeAgentPolicy: resolveNativeAgentPolicy(config.nativeAgents, configurableAgents, "config.nativeAgents"),
  }
}

export function buildRuntime({ target, global = false }) {
  const runtimeRoot = global ? join(homedir(), ".config", "opencode") : join(target, ".opencode")
  const configRoot = global ? join(runtimeRoot, CONFIG_DIR) : join(target, CONFIG_DIR)
  assertDirectoryIfPresent(runtimeRoot, "运行时根目录")
  const { runtimeAgents, config } = loadRuntimeDefinition(configRoot)
  const runtimeAgentsRoot = join(runtimeRoot, "agents")
  const pluginsRoot = join(runtimeRoot, "plugins")
  assertDirectoryIfPresent(runtimeAgentsRoot, "运行时 agent 目录")
  assertManagedComponentTree(pluginsRoot)
  assertManagedComponentTree(join(runtimeRoot, "tui"))
  const tuiRegistration = prepareTuiRegistration(runtimeRoot, { enableWorkflow: config.enableWorkflow, configRoot: resolve(configRoot) })
  readManagedSkills(configRoot)
  const expected = new Map(runtimeAgents.map((agent) => [join(runtimeAgentsRoot, `${agent.name}.md`), renderAgent(agent, configRoot)]))
  // OpenCode installs local-plugin dependencies from the config directory at startup.
  const packagePath = join(runtimeRoot, "package.json")
  assertGeneratedFileIfPresent(packagePath)
  const runtimePackage = existsSync(packagePath) ? requireObject(readJson(packagePath, "运行时 package.json"), "运行时 package.json") : {}
  const dependencies = runtimePackage.dependencies === undefined ? {} : requireObject(runtimePackage.dependencies, "运行时 package.json.dependencies")
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (runtimePackage[field] === undefined) continue
    const declared = requireObject(runtimePackage[field], `运行时 Bash parser ${field}`)
    for (const [name, version] of Object.entries(RUNTIME_PARSER_DEPENDENCIES)) {
      if (declared[name] !== undefined && declared[name] !== version) fail(`运行时 Bash parser 依赖冲突: ${field}.${name} 必须为 ${version}`)
    }
  }
  const constraints = [
    { value: runtimePackage.overrides, label: "overrides", references: true },
    { value: runtimePackage.resolutions, label: "resolutions", paths: true },
    { value: runtimePackage.pnpm?.overrides, label: "pnpm.overrides", references: true, parents: true },
  ].filter(({ value }) => value !== undefined)
  while (constraints.length) {
    const { value, label, references, paths, parents, depth = 0 } = constraints.pop()
    if (depth > 128) fail("运行时 Bash parser 依赖覆盖嵌套过深")
    for (const [selector, rule] of Object.entries(requireObject(value, `运行时 Bash parser ${label}`))) {
      if (selector === ".") continue
      // Nested npm scopes are all checked. Yarn paths select the final package.
      // pnpm's parent delimiter excludes range comparators after '@', space or
      // '|'; the override replaces only the target, not its parent package.
      const parentDelimiter = parents ? selector.search(/[^ |@]>/) : -1
      const targetSelector = parentDelimiter === -1 ? selector : selector.slice(parentDelimiter + 2)
      const scopes = paths ? selector.split("/") : [targetSelector]
      const selectors = []
      for (let index = 0; index < scopes.length; index += 1) {
        let scope = scopes[index].trim()
        if (paths && scope.startsWith("@")) scope += `/${scopes[++index] ?? ""}`
        const selected = scope.match(/^((?:@[A-Za-z0-9_.*?-]+\/)?[A-Za-z0-9_.*?-]+)(?:@(.*))?$/)
        if (!selected || (paths && selected[2] !== undefined && !/^(?:npm:)?[A-Za-z0-9.*^~<>=| +?-]*$/.test(selected[2]))) {
          fail(`运行时 Bash parser 无法验证依赖选择器: ${label}.${selector}`)
        }
        if (paths) selectors.length = 0
        selectors.push(new RegExp(`^${selected[1].replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".")}$`))
      }
      for (const [name, version] of Object.entries(RUNTIME_PARSER_DEPENDENCIES)) {
        if (!selectors.some((matches) => matches.test(name))) continue
        // An object without '.' inherits its selector range in npm; it is not
        // proof of a pinned version. Only the exact pin or its own $ref is safe.
        const constraint = typeof rule === "string" ? rule : rule?.["."]
        if (constraint !== version && !(references && constraint === `$${name}`)) {
          fail(`运行时 Bash parser 依赖冲突: ${label}.${selector} 必须为 ${version}`)
        }
      }
      if (rule && typeof rule === "object") constraints.push({ value: rule, label: `${label}.${selector}`, references, paths, parents, depth: depth + 1 })
    }
  }
  expected.set(packagePath, `${JSON.stringify({ ...runtimePackage, dependencies: { ...dependencies, ...RUNTIME_PARSER_DEPENDENCIES } }, null, 2)}\n`)
  expected.set(join(pluginsRoot, PLUGIN_FILE), `export { OpenCodeForEverythingPlugin } from "./${RUNTIME_COMPONENT_DIRECTORY}/plugin.ts"\n`)
  for (const file of sourceRuntimeFiles()) {
    let content = readFileSync(file.source, "utf8")
    // TUI modules live outside server auto-discovery after installation. Keep
    // their two shared, side-effect-free helpers pointing at the copied source.
    if (file.relativePath.replaceAll("\\", "/") === "tui/workflow-options.mjs") {
      content = content.replace('"../config-paths.mjs"', '"../../plugins/opencode-for-everything/config-paths.mjs"')
        .replace('"../jsonc.mjs"', '"../../plugins/opencode-for-everything/jsonc.mjs"')
    }
    expected.set(runtimeModulePath(runtimeRoot, file.relativePath), content)
  }
  for (const entry of tuiRegistration) expected.set(entry.path, entry.content)
  for (const path of expected.keys()) assertGeneratedFileIfPresent(path)

  const staleAgents = []
  if (existsSync(runtimeAgentsRoot)) {
    for (const file of readdirSync(runtimeAgentsRoot).filter((file) => file.endsWith(".md"))) {
      const path = join(runtimeAgentsRoot, file)
      assertGeneratedFileIfPresent(path)
      if (!expected.has(path) && readFileSync(path, "utf8").includes(MARKER)) staleAgents.push(path)
    }
  }
  const staleRuntimeModules = []
  for (const componentRoot of [runtimeComponentPath(pluginsRoot), runtimeComponentPath(join(runtimeRoot, "tui"))]) {
    if (existsSync(componentRoot)) {
      const visit = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name)
          if (entry.isDirectory()) visit(child)
          else if (entry.isFile() && !expected.has(child)) staleRuntimeModules.push(child)
        }
      }
      visit(componentRoot)
    }
  }
  for (const [path, content] of expected) writeIfChanged(path, content)

  for (const path of staleAgents) {
    unlinkSync(path)
    console.log(`removed stale generated agent ${path}`)
  }
  for (const path of staleRuntimeModules) {
    unlinkSync(path)
    console.log(`removed stale generated runtime module ${path}`)
  }
}
