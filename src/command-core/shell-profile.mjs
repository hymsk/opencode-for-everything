import path from "node:path"
import { assertShellProfile } from "./contracts.mjs"

const POWERSHELL = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"])
const CMD = new Set(["cmd", "cmd.exe"])

export function defaultShell(env = process.env, platform = process.platform) {
  if (env.SHELL) return env.SHELL
  if (platform === "win32") return env.ComSpec || "cmd.exe"
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh"
}

export function resolveShellProfile(shell = defaultShell()) {
  if (typeof shell !== "string" || !shell || shell.includes("\0")) {
    throw Object.assign(new Error("O4E_COMMAND_INVALID_SHELL"), { code: "O4E_COMMAND_INVALID_SHELL" })
  }
  const name = path.basename(shell).toLowerCase()
  const powershell = POWERSHELL.has(name)
  const cmd = CMD.has(name)
  return assertShellProfile(Object.freeze({
    shell, name,
    kind: powershell ? "powershell" : cmd ? "cmd" : "posix-compatible",
    direct: powershell && process.platform === "win32",
    args: powershell && process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
      : cmd && process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"],
    detached: process.platform !== "win32",
  }))
}
