import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"

let fixtureRoot

function testOpenCodeRoot() {
  if (fixtureRoot) return fixtureRoot
  fixtureRoot = mkdtempSync(join(tmpdir(), "o4e-test-opencode-"))
  const binaryPath = join(fixtureRoot, process.platform === "win32" ? "opencode.cmd" : "opencode")
  const promptData = `var Hi=\`You are the deterministic OpenCode test prompt\`
var PlanReminder=\`<system-reminder>
# Plan Mode - System Reminder
Deterministic test reminder
</system-reminder>
\``
  const executable = process.platform === "win32"
    ? `@echo off\r\nif "%1"=="--version" echo 9.9.1\r\nexit /b 0\r\n${promptData}\r\n`
    : `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 9.9.1
  exit 0
fi
exit 1
: <<'O4E_TEST_PROMPTS'
${promptData}
O4E_TEST_PROMPTS
`
  writeFileSync(binaryPath, executable)
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755)
  process.once("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }))
  return fixtureRoot
}

export function installerTestEnv(base = process.env) {
  const env = { ...base }
  if (process.platform === "win32") return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path")
  const searchPath = pathKey ? env[pathKey] : ""
  if (pathKey) delete env[pathKey]
  env.PATH = `${testOpenCodeRoot()}${searchPath ? `${delimiter}${searchPath}` : ""}`
  return env
}
