/**
 * opencode-for-everything model configuration editor
 *
 * Edits the model fields of an installed `.o4e/` source tree while preserving
 * user JSONC comments, then rebuilds the runtime through the normal builder.
 * Only `config.defaultModel` (with variant) and per-Agent `model` (with
 * variant) for `all`/`primary`/`subagent` Agents are editable; `null`
 * restores inheritance. `fallbackModels`, system Agents and Plan models are
 * not editable here. Build failures restore the original files.
 */

import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { applyEdits, modify } from "jsonc-parser"
import { stripJsonComments } from "../src/jsonc.mjs"
import { buildRuntime } from "../src/runtime-builder.mjs"

const MODEL_EDITABLE_TYPES = Object.freeze(["all", "primary", "subagent"])
// Kept in sync with defaults/.o4e/schemas/agent-common.schema.json modelRef.
const MODEL_ID_PATTERN = /^[^/\s]+\/[^\r\n]+$/
const MODEL_VARIANT_PATTERN = /^[^\r\n]+$/

export function modelConfigRoot({ target = ".", global = false } = {}) {
  // Mirrors buildRuntime: the global runtime root is fixed under the user home.
  return global ? join(homedir(), ".config", "opencode", ".o4e") : join(target, ".o4e")
}

function selectJsonFile(directory, baseName) {
  for (const extension of [".jsonc", ".json"]) {
    const file = `${baseName}${extension}`
    const path = join(directory, file)
    if (existsSync(path)) return { file, path }
  }
  return null
}

function parseJsoncFile(path, label) {
  let value
  try {
    value = JSON.parse(stripJsonComments(readFileSync(path, "utf-8")))
  } catch (error) {
    throw new Error(`${label} 不是有效的 JSONC: ${path}: ${error.message}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象: ${path}`)
  }
  return value
}

function validateModelId(id, label) {
  if (typeof id !== "string" || !MODEL_ID_PATTERN.test(id)) {
    throw new Error(`${label} 必须使用 provider/model 格式`)
  }
  return id
}

function validateModelVariant(variant, label) {
  if (typeof variant !== "string" || !MODEL_VARIANT_PATTERN.test(variant)) {
    throw new Error(`${label} 必须为单行非空字符串`)
  }
  return variant
}

function currentModelId(value) {
  if (typeof value === "string") return MODEL_ID_PATTERN.test(value) ? value : undefined
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return typeof value.id === "string" && MODEL_ID_PATTERN.test(value.id) ? value.id : undefined
  }
  return undefined
}

/**
 * Resolve one model change into the value to write.
 * model: undefined keeps the current id, null clears to null, string sets a new id.
 * variant: undefined keeps nothing extra, null removes the variant, string sets it.
 * Returns undefined when nothing changes, otherwise null | {id, variant?}.
 */
export function resolveModelChange({ model, variant } = {}, current, label) {
  if (model === undefined && variant === undefined) return undefined
  if (model === null) {
    if (variant !== undefined && variant !== null) throw new Error(`${label}: variant 不能附加到已清除的模型`)
    return null
  }
  let id
  if (model !== undefined) {
    id = validateModelId(model, label)
  } else {
    id = currentModelId(current)
    if (!id) throw new Error(`${label}: 当前未配置模型，无法单独设置 variant`)
  }
  if (variant === undefined || variant === null) return { id }
  return { id, variant: validateModelVariant(variant, label) }
}

/**
 * Read the current model configuration of an installed target.
 * Returns { configPath, agentsDir, defaultModel, agents: [{ type, name, path, model }] }.
 */
export function readModelConfiguration(configRoot) {
  const configFile = selectJsonFile(configRoot, "config")
  if (!configFile) throw new Error(`未找到 O4E 配置文件: ${join(configRoot, "config.jsonc")}`)
  const config = parseJsoncFile(configFile.path, "O4E 配置")
  const agentsDir = typeof config.agentsDir === "string" && config.agentsDir ? config.agentsDir : "agents"
  const agents = []
  for (const type of MODEL_EDITABLE_TYPES) {
    const directory = join(configRoot, agentsDir, type)
    if (!existsSync(directory)) continue
    const selected = new Map()
    for (const entry of readdirSync(directory)) {
      const baseName = entry.endsWith(".jsonc") ? entry.slice(0, -".jsonc".length)
        : entry.endsWith(".json") ? entry.slice(0, -".json".length)
          : null
      if (!baseName) continue
      // .jsonc wins over .json for the same Agent name, matching the builder.
      if (!selected.has(baseName) || entry.endsWith(".jsonc")) selected.set(baseName, entry)
    }
    for (const [name, file] of [...selected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const path = join(directory, file)
      const spec = parseJsoncFile(path, `agent 配置 ${type}/${file}`)
      agents.push({ type, name, path, model: spec.model ?? null })
    }
  }
  return { configPath: configFile.path, agentsDir, defaultModel: config.defaultModel ?? null, agents }
}

function setJsoncProperty(content, property, value) {
  const edits = modify(content, [property], value, {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
  })
  return applyEdits(content, edits)
}

/**
 * Apply model changes to an installed target and rebuild the runtime.
 *
 * change: {
 *   defaultModel?: string | null,       // undefined = untouched, null = clear
 *   defaultVariant?: string | null,     // undefined = untouched, null = remove
 *   agents?: Array<{ name, model?: string | null, variant?: string | null }>,
 * }
 * Returns { configRoot, changes: Array<{ target, value }> }.
 */
export function applyModelChanges({ target = ".", global = false, defaultModel, defaultVariant, agents = [], build = buildRuntime } = {}) {
  const configRoot = modelConfigRoot({ target, global })
  const state = readModelConfiguration(configRoot)

  const edits = []
  const changes = []
  const defaultChange = resolveModelChange({ model: defaultModel, variant: defaultVariant }, state.defaultModel, "config.defaultModel")
  if (defaultChange !== undefined) {
    edits.push({ path: state.configPath, property: "defaultModel", value: defaultChange })
    changes.push({ target: "defaultModel", value: defaultChange })
  }

  const knownAgents = new Map(state.agents.map((agent) => [agent.name, agent]))
  const seen = new Set()
  for (const entry of agents) {
    const name = entry?.name
    const agent = knownAgents.get(name)
    if (!agent) {
      const available = state.agents.map((item) => item.name).join(", ") || "(无)"
      throw new Error(`未知或不可配置模型的 Agent: ${String(name)}；可配置: ${available}`)
    }
    if (seen.has(name)) throw new Error(`重复指定 Agent: ${name}`)
    seen.add(name)
    const value = resolveModelChange(entry, agent.model, `agent ${name}.model`)
    if (value === undefined) continue
    edits.push({ path: agent.path, property: "model", value })
    changes.push({ target: name, value })
  }

  if (edits.length === 0) return { configRoot, changes }

  const editedPaths = [...new Set(edits.map((edit) => edit.path))]
  for (const path of editedPaths) {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.nlink !== 1) throw new Error(`配置文件必须是无链接的普通文件，拒绝修改: ${path}`)
  }

  const backup = mkdtempSync(join(tmpdir(), "o4e-model-backup-"))
  const backups = new Map()
  try {
    editedPaths.forEach((path, index) => {
      const backupPath = join(backup, String(index))
      copyFileSync(path, backupPath)
      backups.set(path, backupPath)
    })
    const contents = new Map()
    for (const edit of edits) {
      const content = contents.get(edit.path) ?? readFileSync(edit.path, "utf-8")
      contents.set(edit.path, setJsoncProperty(content, edit.property, edit.value))
    }
    for (const [path, content] of contents) writeFileSync(path, content)
    try {
      build({ target, global })
    } catch (error) {
      for (const [path, backupPath] of backups) copyFileSync(backupPath, path)
      throw new Error(`模型配置校验失败，已恢复原配置: ${error.message}`)
    }
  } finally {
    rmSync(backup, { recursive: true, force: true })
  }
  return { configRoot, changes }
}

function parseNullableFlag(value, option) {
  if (value === "null") return null
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${option} 需要 provider/model 或 null`)
  return value
}

function parseAssignments(values, option) {
  const entries = values === undefined ? [] : Array.isArray(values) ? values : [values]
  const assignments = []
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error(`${option} 必须使用 name=value 格式`)
    const separator = entry.indexOf("=")
    const name = separator > 0 ? entry.slice(0, separator).trim() : ""
    const value = separator > 0 ? entry.slice(separator + 1).trim() : ""
    if (!name || !value || value.includes("=")) throw new Error(`${option} 必须使用 name=value 格式`)
    assignments.push({ name, value })
  }
  return assignments
}

/**
 * Parse the silent-mode CLI flags of the `model` subcommand.
 * Returns { touched, defaultModel, defaultVariant, agents: [{ name, model, variant }] }.
 */
export function parseModelCliOptions(values = {}) {
  const change = { touched: false, defaultModel: undefined, defaultVariant: undefined, agents: new Map() }
  if (values["default-model"] !== undefined) {
    change.touched = true
    change.defaultModel = parseNullableFlag(values["default-model"], "--default-model")
  }
  if (values["default-variant"] !== undefined) {
    change.touched = true
    change.defaultVariant = parseNullableFlag(values["default-variant"], "--default-variant")
  }
  const ensureAgent = (name) => {
    if (!change.agents.has(name)) change.agents.set(name, { name, model: undefined, variant: undefined })
    return change.agents.get(name)
  }
  for (const { name, value } of parseAssignments(values.model, "--model")) {
    change.touched = true
    const agent = ensureAgent(name)
    if (agent.model !== undefined) throw new Error(`--model 重复指定 Agent: ${name}`)
    agent.model = parseNullableFlag(value, `--model ${name}=`)
  }
  for (const { name, value } of parseAssignments(values.variant, "--variant")) {
    change.touched = true
    const agent = ensureAgent(name)
    if (agent.variant !== undefined) throw new Error(`--variant 重复指定 Agent: ${name}`)
    agent.variant = parseNullableFlag(value, `--variant ${name}=`)
  }
  return {
    touched: change.touched,
    defaultModel: change.defaultModel,
    defaultVariant: change.defaultVariant,
    agents: [...change.agents.values()].filter((agent) => agent.model !== undefined || agent.variant !== undefined),
  }
}

/** Format one model value for display. */
export function formatModelValue(value, { inherit = "null" } = {}) {
  if (value === null || value === undefined) return inherit
  const id = currentModelId(value)
  if (!id) return "(无效)"
  const variant = value && typeof value === "object" && !Array.isArray(value) ? value.variant : undefined
  return variant ? `${id} (variant: ${variant})` : id
}
