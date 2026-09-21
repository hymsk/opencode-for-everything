import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export function resolveO4eConfigRoot(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME
  const defaultRoot = xdg && isAbsolute(xdg) ? join(xdg, "opencode", ".o4e") : join(home, ".config", "opencode", ".o4e")
  const configured = env.o4e_config === undefined ? defaultRoot : env.o4e_config
  if (typeof configured !== "string" || !configured || configured.includes("\0")) throw new Error("O4E_CONFIG_INVALID: o4e_config must be a non-empty absolute path")
  const expanded = configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured
  if (!isAbsolute(expanded)) throw new Error("O4E_CONFIG_INVALID: o4e_config must be an absolute path")
  return resolve(expanded)
}

export function runtimePaths(directory, configuredRoot, explicitConfig) {
  if (explicitConfig) return [{ configRoot: configuredRoot, scope: "global" }]
  return [{ configRoot: join(directory || process.cwd(), ".o4e"), scope: "project" }, { configRoot: configuredRoot, scope: "global" }]
}

export function configRootExists(configRoot, scope) {
  try {
    if (!lstatSync(configRoot).isDirectory()) throw new Error(`${scope === "project" ? "项目" : "全局"}配置根必须是普通目录: ${configRoot}`)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}
