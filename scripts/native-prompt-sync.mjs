import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { delimiter, dirname, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const MANIFEST_FILE = "native-prompt-install.json"
const BINARY_PROMPT_VARIABLE = "Hi"
const PLAN_REMINDER_HEADER = "# Plan Mode - System Reminder"
function managedPrompts(promptDir) {
  return [
    { path: `${promptDir}/primary/build/system.md`, kind: "build" },
    { path: `${promptDir}/primary/plan/system.md`, kind: "build" },
    { path: `${promptDir}/primary/plan/reminder.md`, kind: "planReminder" },
  ]
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

export function resolveOpenCodeBinary(binaryPath, { platform = process.platform } = {}) {
  const resolvedPath = realpathSync(binaryPath)
  if (platform !== "win32" || extname(resolvedPath).toLowerCase() !== ".cmd") return resolvedPath

  const source = readFileSync(resolvedPath, "utf8")
  const match = source.match(/%dp0%[\\/]([^"\r\n]*?\.exe)(?:"|\s|$)/i)
  if (!match) throw new Error(`无法从 Windows 命令 shim 定位本机 opencode 可执行文件: ${binaryPath}`)

  const executablePath = join(dirname(resolvedPath), ...match[1].split(/[\\/]+/))
  if (!existsSync(executablePath)) throw new Error(`Windows 命令 shim 指向不存在的 opencode 可执行文件: ${executablePath}`)
  return realpathSync(executablePath)
}

export function locateOpenCode({ searchPath = process.env.PATH ?? "", platform = process.platform } = {}) {
  const names = platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"]
  for (const directory of searchPath.split(delimiter)) {
    for (const name of names) {
      const path = join(directory, name)
      if (!existsSync(path)) continue
      try {
        return resolveOpenCodeBinary(path, { platform })
      } catch {
        // Ignore broken PATH entries and continue looking for a usable executable.
      }
    }
  }
  return null
}

export function readOpenCodeVersion(binaryPath) {
  return execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim()
}

function decodeTemplateLiteralEscapes(source) {
  let result = ""
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character !== "\\") {
      result += character
      continue
    }

    const nextCharacter = source[++index]
    if (nextCharacter === undefined) throw new Error("发布二进制 prompt 包含未闭合转义")
    if (nextCharacter === "\r") {
      if (source[index + 1] === "\n") index += 1
      continue
    }
    if (nextCharacter === "\n") continue
    if (nextCharacter === "x") {
      const value = source.slice(index + 1, index + 3)
      if (!/^[0-9a-f]{2}$/i.test(value)) throw new Error("发布二进制 prompt 包含无效十六进制转义")
      result += String.fromCharCode(Number.parseInt(value, 16))
      index += 2
      continue
    }
    if (nextCharacter === "u") {
      if (source[index + 1] === "{") {
        const end = source.indexOf("}", index + 2)
        const value = end < 0 ? "" : source.slice(index + 2, end)
        if (!/^[0-9a-f]{1,6}$/i.test(value) || Number.parseInt(value, 16) > 0x10ffff) throw new Error("发布二进制 prompt 包含无效 Unicode 转义")
        result += String.fromCodePoint(Number.parseInt(value, 16))
        index = end
      } else {
        const value = source.slice(index + 1, index + 5)
        if (!/^[0-9a-f]{4}$/i.test(value)) throw new Error("发布二进制 prompt 包含无效 Unicode 转义")
        result += String.fromCharCode(Number.parseInt(value, 16))
        index += 4
      }
      continue
    }

    const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" }
    result += escapes[nextCharacter] ?? nextCharacter
  }
  return result
}

export function extractNativeBuildPrompt(binaryPath, variable = BINARY_PROMPT_VARIABLE) {
  const binary = readFileSync(binaryPath)
  const prefix = Buffer.from(`var ${variable}=\``)
  const start = binary.indexOf(prefix)
  if (start < 0) throw new Error(`无法定位发布二进制 build prompt 变量 ${variable}`)

  const prompt = extractTemplateLiteral(binary, start + prefix.length, `build prompt 变量 ${variable}`)
  if (!prompt.startsWith("You are ")) throw new Error(`发布二进制 build prompt 变量 ${variable} 不是预期的 system prompt`)
  return prompt
}

function extractTemplateLiteral(binary, start, label) {
  let end = -1
  for (let index = start; index < binary.length; index += 1) {
    if (binary[index] !== 0x60) continue
    let backslashes = 0
    for (let previous = index - 1; previous >= 0 && binary[previous] === 0x5c; previous -= 1) backslashes += 1
    if (backslashes % 2 === 0) {
      end = index
      break
    }
  }
  if (end < 0) throw new Error(`无法定位发布二进制 ${label}`)

  return decodeTemplateLiteralEscapes(binary.subarray(start, end).toString("utf8"))
}

export function extractNativePlanReminder(binaryPath) {
  const binary = readFileSync(binaryPath)
  const header = Buffer.from(PLAN_REMINDER_HEADER)
  const headerStart = binary.indexOf(header)
  if (headerStart < 0) throw new Error("无法定位发布二进制 Plan Mode reminder")

  let start = -1
  for (let index = headerStart - 1; index >= 0; index -= 1) {
    if (binary[index] !== 0x60) continue
    let backslashes = 0
    for (let previous = index - 1; previous >= 0 && binary[previous] === 0x5c; previous -= 1) backslashes += 1
    if (backslashes % 2 === 0) {
      start = index + 1
      break
    }
  }
  if (start < 0) throw new Error("无法定位发布二进制 Plan Mode reminder 起始位置")

  const reminder = extractTemplateLiteral(binary, start, "Plan Mode reminder")
  if (!reminder.startsWith("<system-reminder>\n# Plan Mode - System Reminder")) {
    throw new Error("发布二进制 Plan Mode reminder 不是预期的消息提示词")
  }
  return reminder
}

export function currentNativePrompts({ binaryPath = locateOpenCode(), platform = process.platform, readVersion = readOpenCodeVersion } = {}) {
  if (!binaryPath) throw new Error("无法从 PATH 定位本机 opencode")
  const executablePath = resolveOpenCodeBinary(binaryPath, { platform })
  const version = readVersion(executablePath)
  const buildPrompt = extractNativeBuildPrompt(executablePath)
  const planReminder = extractNativePlanReminder(executablePath)
  return {
    build: {
      prompt: buildPrompt,
      source: {
        opencodeVersion: version,
        artifact: "installed executable",
        binaryPromptVariable: BINARY_PROMPT_VARIABLE,
        sha256: sha256(buildPrompt),
      },
    },
    planReminder: {
      prompt: planReminder,
      source: {
        opencodeVersion: version,
        artifact: "installed executable",
        binaryPromptHeader: PLAN_REMINDER_HEADER,
        sha256: sha256(planReminder),
      },
    },
  }
}

function readManifest(path) {
  if (!existsSync(path)) return { schemaVersion: 1, files: {} }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
      throw new Error("结构无效")
    }
    return value
  } catch (error) {
    throw new Error(`无法解析原生 prompt 同步状态 ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function canReplace(path, previousSha256) {
  if (!existsSync(path)) return true
  const currentSha256 = sha256(readFileSync(path, "utf8"))
  return currentSha256 === previousSha256
}

export function syncNativePrompts(configRoot, prompts, { promptDir = "prompts" } = {}) {
  const manifestPath = join(configRoot, MANIFEST_FILE)
  const manifest = readManifest(manifestPath)
  const files = { ...manifest.files }
  const result = { updated: [], preserved: [], sources: { build: prompts.build.source, planReminder: prompts.planReminder.source } }

  for (const managed of managedPrompts(promptDir)) {
    const { path: relativePath, kind } = managed
    const { prompt, source } = prompts[kind]
    const path = join(configRoot, relativePath)
    if (canReplace(path, files[relativePath]?.sha256)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, prompt)
      files[relativePath] = { ...source }
      result.updated.push(relativePath)
    } else {
      result.preserved.push(relativePath)
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`)
  return result
}

function usage() {
  console.error("用法: node scripts/native-prompt-sync.mjs --check | --config-root <.o4e 目录>")
  process.exit(2)
}

function main() {
  const [command, value] = process.argv.slice(2)
  if (command === "--check" && value === undefined) {
    const { build, planReminder } = currentNativePrompts()
    console.log(`[opencode-for-everything] native build prompt: OpenCode ${build.source.opencodeVersion}, sha256 ${build.source.sha256}`)
    console.log(`[opencode-for-everything] native plan reminder: sha256 ${planReminder.source.sha256}`)
    return
  }
  if (command !== "--config-root" || !value || process.argv.length !== 4) usage()

  const result = syncNativePrompts(resolve(value), currentNativePrompts())
  for (const relativePath of result.updated) console.log(`[opencode-for-everything] 已生成用户 prompt: ${relativePath}`)
  for (const relativePath of result.preserved) console.log(`[opencode-for-everything] 保留用户自定义 prompt: ${relativePath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
