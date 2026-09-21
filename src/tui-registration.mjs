import { lstatSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

// Runtime definition loading is also used by the server plugin. The installer-
// only parser must not become a server startup dependency of copied runtimes.
const require = createRequire(import.meta.url)
const parser = () => require("jsonc-parser")

export const TUI_ENTRY = "tui/opencode-for-everything/index.tsx"
const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
const stat = (path) => lstatSync(path, { throwIfNoEntry: false })

export function runtimeModulePath(runtimeRoot, relativePath) {
  return relativePath.startsWith(`tui/`) || relativePath.startsWith(`tui\\`)
    ? join(runtimeRoot, "tui", "opencode-for-everything", relativePath.slice(4))
    : join(runtimeRoot, "plugins", "opencode-for-everything", relativePath)
}

function readRegistries(root) {
  const { parseTree, getNodeValue } = parser()
  return ["tui.json", "tui.jsonc"].flatMap((name) => {
    const path = join(root, name)
    const info = stat(path)
    if (!info) return []
    if (!info.isFile() || info.nlink !== 1) throw new Error(`TUI configuration must be an unlinked regular file: ${path}`)
    const source = readFileSync(path, "utf8")
    const errors = []
    const tree = parseTree(source, errors, { allowTrailingComma: true })
    if (errors.length || tree?.type !== "object") throw new Error(`Invalid TUI JSONC configuration: ${path}`)
    const keys = tree.children.map((property) => property.children[0].value)
    if (new Set(keys).size !== keys.length) throw new Error(`Duplicate TUI configuration keys: ${path}`)
    const config = getNodeValue(tree)
    if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error(`TUI plugin must be an array: ${path}`)
    return [{ path, source, config }]
  })
}

function matches(entry, root) {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== "string") return false
  try {
    const path = spec.startsWith("file:") ? fileURLToPath(spec)
      : isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../") ? resolve(root, spec) : undefined
    return path !== undefined && resolve(path) === resolve(root, TUI_ENTRY)
  } catch { return false }
}

export function tuiPluginRegistered(root) {
  return readRegistries(root).some(({ config }) => (config.plugin ?? []).some((entry) => matches(entry, root)))
}

// Preflight before builder writes any managed files. JSONC edits touch only O4E's row.
export function prepareTuiRegistration(root, featureOptions) {
  const { applyEdits, modify } = parser()
  const registries = readRegistries(root)
  if (registries.some(({ config }) => (config.plugin ?? []).some((entry) => matches(entry, root)))) {
    if (featureOptions === undefined) return []
    return registries.flatMap(({ path, source, config }) => {
      let content = source
      for (const [index, entry] of (config.plugin ?? []).entries()) {
        if (!matches(entry, root)) continue
        const previous = Array.isArray(entry) && entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]) ? entry[1] : {}
        const value = [Array.isArray(entry) ? entry[0] : entry, { ...previous, ...featureOptions }]
        if (JSON.stringify(value) !== JSON.stringify(entry)) content = applyEdits(content, modify(content, ["plugin", index], value, options))
      }
      return content === source ? [] : [{ path, content }]
    })
  }
  const selected = registries.at(-1) ?? { path: join(root, "tui.json"), source: "{}\n", config: {} }
  const path = selected.config.plugin ? ["plugin", selected.config.plugin.length] : ["plugin"]
  const entry = featureOptions === undefined ? `./${TUI_ENTRY}` : [`./${TUI_ENTRY}`, featureOptions]
  const value = selected.config.plugin ? entry : [entry]
  return [{ path: selected.path, content: applyEdits(selected.source, modify(selected.source, path, value, { ...options, isArrayInsertion: true })) }]
}

export function prepareTuiRegistrationRemoval(root) {
  const { applyEdits, modify } = parser()
  const edits = readRegistries(root).flatMap(({ path, source, config }) => {
    let content = source
    for (let index = (config.plugin ?? []).length - 1; index >= 0; index--) {
      if (matches(config.plugin[index], root)) content = applyEdits(content, modify(content, ["plugin", index], undefined, options))
    }
    return content === source ? [] : [{ path, source, content }]
  })
  return () => {
    // Do not overwrite edits made since preflight or follow a replaced link.
    for (const edit of edits) {
      const info = stat(edit.path)
      if (!info?.isFile() || info.nlink !== 1 || readFileSync(edit.path, "utf8") !== edit.source) throw new Error("TUI configuration changed during uninstall")
    }
    for (const edit of edits) writeFileSync(edit.path, edit.content)
  }
}
