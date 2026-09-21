import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { configRootExists, runtimePaths, resolveO4eConfigRoot } from "../config-paths.mjs"
import { stripJsonComments } from "../jsonc.mjs"

// Read only the selected config at startup, never Session checkpoints or stale
// build flags. Share server root precedence; invalid projects never fall back.
export function runtimeWorkflowOptions(options, env = process.env, home = homedir(), directory) {
  const disabled = { enableWorkflow: false }
  if (![undefined, "default", "clear"].includes(env.o4e_mode)
    || typeof directory !== "string" || !isAbsolute(directory)) return disabled
  try {
    const roots = runtimePaths(directory, resolveO4eConfigRoot(env, home), env.o4e_config !== undefined)
    for (const { configRoot, scope } of roots) {
      if (!configRootExists(configRoot, scope)) continue
      const jsonc = join(configRoot, "config.jsonc")
      const path = existsSync(jsonc) ? jsonc : join(configRoot, "config.json")
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 1024 * 1024) return disabled
      const config = JSON.parse(stripJsonComments(readFileSync(path, "utf8")))
      return { enableWorkflow: config?.enableWorkflow === true }
    }
  } catch { /* Invalid or unavailable selected config stays disabled. */ }
  return disabled
}
