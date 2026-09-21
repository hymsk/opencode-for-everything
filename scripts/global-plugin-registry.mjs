import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { stripJsonComments } from "../src/jsonc.mjs"

const lstatIfPresent = (path) => lstatSync(path, { throwIfNoEntry: false })

function globalRegistryPath(configRoot) {
  const root = resolve(configRoot)
  const jsonPath = join(root, "opencode.json")
  const jsoncPath = join(root, "opencode.jsonc")
  let selected = null
  for (const path of [jsonPath, jsoncPath]) {
    const stat = lstatIfPresent(path)
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new Error(`Global OpenCode configuration must be an unlinked regular file: ${path}`)
    }
    if (stat && !selected) selected = path
  }
  return selected
}

export function readGlobalRegistry(configRoot, { allowComments = false } = {}) {
  const registryPath = globalRegistryPath(configRoot)
  if (!registryPath) return { registryPath: null, config: {} }
  let config
  try {
    const source = readFileSync(registryPath, "utf8")
    config = JSON.parse(allowComments ? stripJsonComments(source) : source)
  } catch (error) {
    if (allowComments) throw error
    throw new Error(`无法解析全局 OpenCode 配置 ${registryPath}；全局组件注册仅支持严格 JSON（请将 JSONC 注释移除后重试）：${error.message}`)
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Global OpenCode configuration must be a JSON object: ${registryPath}`)
  }
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error(`${registryPath} plugin must be an array`)
  return { registryPath, config }
}

function matchesPlugin(entry, pluginSpec) {
  return entry === pluginSpec || (Array.isArray(entry) && entry[0] === pluginSpec)
}

function writeConfig(configRoot, configPath, config) {
  globalRegistryPath(configRoot)
  const mode = lstatIfPresent(configPath)?.mode ?? 0o600
  const stagingDir = mkdtempSync(join(dirname(configPath), ".o4e-registry-"))
  const stagedPath = join(stagingDir, "opencode.json")
  try {
    writeFileSync(stagedPath, `${JSON.stringify(config, null, 2)}\n`, { mode })
    chmodSync(stagedPath, mode)
    renameSync(stagedPath, configPath)
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

export function globalPluginRegistered(configRoot, pluginFile, options) {
  const { config } = readGlobalRegistry(configRoot, options)
  const pluginSpec = pathToFileURL(resolve(pluginFile)).href
  return (config.plugin ?? []).some((entry) => matchesPlugin(entry, pluginSpec))
}

export function installGlobalPlugin(configRoot, pluginFile) {
  const { registryPath, config } = readGlobalRegistry(configRoot)
  const pluginSpec = pathToFileURL(resolve(pluginFile)).href
  const plugins = config.plugin ?? []
  if (!plugins.some((entry) => matchesPlugin(entry, pluginSpec))) {
    writeConfig(configRoot, registryPath ?? join(resolve(configRoot), "opencode.json"), { ...config, plugin: [...plugins, pluginSpec] })
  }
}

export function prepareGlobalPluginRegistrationRemoval(configRoot, pluginFile, options) {
  const { registryPath, config } = readGlobalRegistry(configRoot, options)
  const pluginSpec = pathToFileURL(resolve(pluginFile)).href
  const plugins = (config.plugin ?? []).filter((entry) => !matchesPlugin(entry, pluginSpec))
  if (!config.plugin || plugins.length === config.plugin.length) return () => {}
  const { plugin: _removed, ...withoutPlugin } = config
  return () => {
    // A prepared removal must not recreate a registry removed since preflight.
    lstatSync(registryPath)
    writeConfig(configRoot, registryPath, plugins.length ? { ...config, plugin: plugins } : withoutPlugin)
  }
}

function main() {
  const [action, configRoot, pluginFile] = process.argv.slice(2)
  if (!configRoot || !pluginFile || !["install", "uninstall", "status"].includes(action)) {
    console.error("用法: node scripts/global-plugin-registry.mjs <install|uninstall|status> <config-root> <plugin-file>")
    process.exitCode = 2
    return
  }
  try {
    if (action === "status") process.exitCode = globalPluginRegistered(configRoot, pluginFile) ? 0 : 1
    else if (action === "install") installGlobalPlugin(configRoot, pluginFile)
    else prepareGlobalPluginRegistrationRemoval(configRoot, pluginFile)()
  } catch (error) {
    console.error(`[opencode-for-everything] ${error.message}`)
    process.exitCode = 1
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
})()
if (isMain) main()
