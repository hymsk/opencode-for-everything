import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { stripJsonComments } from "../../src/jsonc.mjs"
import { copyInstalledDefaults } from "../helpers/o4e-fixture.mjs"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pluginUrl = pathToFileURL(join(sourceRoot, "test", "acceptance", "workspace-cwd-plugin.mjs")).href
const opencodeName = process.env.OPENCODE_BIN || "opencode"
const opencode = realpathSync(opencodeName.includes("/") ? opencodeName : run("which", [opencodeName]).stdout.trim())
const runRoot = realpathSync(mkdtempSync("/tmp/opencode/o4e-workspace-cwd-"))
const worktree = join(runRoot, "worktree")
const directory = join(worktree, "nested")
const relativeDirectory = join(directory, "relative")
const explicitDirectory = join(directory, "explicit")
const home = join(runRoot, "home")
const tmp = join(runRoot, "tmp")
const configHome = join(runRoot, "config")
const dataHome = join(runRoot, "data")
const cacheHome = join(runRoot, "cache")
const stateHome = join(runRoot, "state")
const reportPath = join(runRoot, "report.json")
mkdirSync(relativeDirectory, { recursive: true })
mkdirSync(explicitDirectory)
for (const path of [home, tmp, configHome, dataHome, cacheHome, stateHome]) mkdirSync(path)

function fail(message, detail) {
  const error = new Error(message)
  if (detail !== undefined) error.cause = detail
  throw error
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.status !== 0) fail(`${command} failed with exit ${result.status}`, { stdout: result.stdout, stderr: result.stderr })
  return result
}

function readJsonc(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")))
}

function jsonText(value) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "").join("")
}

function commandResult(body, callID) {
  const message = [...(Array.isArray(body.messages) ? body.messages : [])].reverse()
    .find((entry) => entry?.role === "tool" && entry.tool_call_id === callID)
  return message ? jsonText(message.content) : undefined
}

function streamResponse(response, { id, model = "workspace", content, tool }) {
  const event = (delta, finishReason = null) => `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
  const bytes = event({ role: "assistant" })
    + (content ? event({ content }) : "")
    + (tool ? event({ tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }) : "")
    + event({}, tool ? "tool_calls" : "stop")
    + "data: [DONE]\n\n"
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
  response.end(bytes)
}

function outputEvents(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

copyInstalledDefaults(sourceRoot, directory)
const runtimeConfigPath = join(directory, ".o4e", "config.jsonc")
const runtimeConfig = readJsonc(runtimeConfigPath)
runtimeConfig.soul.enabled = false
writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`)
run("git", ["init", "--quiet", worktree])

const requests = []
const MAX_PROVIDER_REQUESTS = 7
const calls = [
  { id: "cwd-1", command: "pwd", description: "default cwd before explicit overrides", expected: directory },
  { id: "cwd-2", command: "pwd", description: "relative cwd", workdir: "relative", expected: relativeDirectory },
  { id: "cwd-3", command: "pwd", description: "explicit absolute cwd", workdir: explicitDirectory, expected: explicitDirectory },
  { id: "cwd-4", command: "pwd", description: "default cwd after explicit overrides", expected: directory },
]
let bashSchema
let transportMode
let issuedCalls = 0
let providerFailure

const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push({ url: request.url, body })
    writeFileSync(join(runRoot, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`)
    if (providerFailure) throw providerFailure
    if (requests.length > MAX_PROVIDER_REQUESTS) fail("provider request limit exceeded")
    const bash = Array.isArray(body.tools)
      ? body.tools.find((entry) => entry?.function?.name === "bash")?.function
      : undefined

    if (!bash?.parameters) {
      streamResponse(response, { id: `fixture-${requests.length}`, content: "Workspace cwd acceptance" })
      return
    }
    if (!bash.description?.startsWith("Execute Bash directly as a durable command Task")) {
      fail("provider received the host Bash tool instead of the O4E Bash override", { description: bash.description })
    }
    bashSchema ??= structuredClone(bash.parameters)

    for (const [index, call] of calls.entries()) {
      const actual = commandResult(body, call.id)
      const expected = index < issuedCalls ? `${call.expected}\n` : undefined
      if (actual !== expected) fail(`model-visible Bash result mismatch for ${call.id}`, { expected, actual })
    }
    const current = calls[issuedCalls]
    const toolCall = current ? (() => {
      const required = new Set(bashSchema.required ?? [])
      transportMode ??= required.has("workdir") ? "required-nullable" : "optional-omission"
      const args = { command: current.command, description: current.description }
      if (Object.hasOwn(current, "workdir")) args.workdir = current.workdir
      else if (required.has("workdir")) args.workdir = null
      if (required.has("timeout")) args.timeout = null
      issuedCalls += 1
      return { id: current.id, name: "bash", args }
    })() : undefined
    streamResponse(response, {
      id: `fixture-${requests.length}`,
      ...(toolCall ? { tool: toolCall } : { content: "WORKSPACE_CWD_ACCEPTANCE_DONE" }),
    })
  } catch (error) {
    providerFailure ??= error
    streamResponse(response, { id: `fixture-${requests.length}`, content: "WORKSPACE_CWD_ACCEPTANCE_FAILED" })
  }
})

try {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === "string") fail("fake provider address unavailable")
  writeFileSync(join(directory, "opencode.json"), `${JSON.stringify({
    plugin: [pluginUrl],
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Workspace acceptance fixture",
        options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
        models: { workspace: { name: "Workspace fixture", limit: { context: 32768, output: 4096 } } },
      },
    },
  }, null, 2)}\n`)
  run(process.execPath, [join(sourceRoot, "scripts", "installer.mjs"), "build", `--target=${directory}`], { cwd: sourceRoot })
  cpSync(join(sourceRoot, "node_modules"), join(directory, ".opencode", "node_modules"), { recursive: true })
  cpSync(join(sourceRoot, "package-lock.json"), join(directory, ".opencode", "package-lock.json"))
  cpSync(join(directory, ".opencode", "node_modules"), join(configHome, "opencode", "node_modules"), { recursive: true })
  cpSync(join(directory, ".opencode", "package.json"), join(configHome, "opencode", "package.json"))
  cpSync(join(directory, ".opencode", "package-lock.json"), join(configHome, "opencode", "package-lock.json"))

  const child = spawn(opencode, ["run", "--dir", directory, "--model", "fixture/workspace", "--agent", "orchestrator", "--auto", "--format", "json",
    "Run the four deterministic Bash cwd checks supplied by the provider and then stop."], {
    cwd: sourceRoot,
    env: {
      PATH: [...new Set([dirname(opencode), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
      LANG: "C.UTF-8",
      TERM: "dumb",
      SHELL: "/bin/bash",
      HOME: home,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_STATE_HOME: stateHome,
      OPENCODE_CONFIG_DIR: join(directory, ".opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pluginUrl],
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Workspace acceptance fixture",
            options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
            models: { workspace: { name: "Workspace fixture", limit: { context: 32768, output: 4096 } } },
          },
        },
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_PRINT_LOGS: "1",
      OPENCODE_LOG_LEVEL: "DEBUG",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      rejectPromise(Object.assign(new Error("OpenCode acceptance timed out"), { cause: { requestCount: requests.length, stdout, stderr, runRoot } }))
    }, 90_000)
    child.once("error", rejectPromise)
    child.once("close", (code) => { clearTimeout(timer); resolvePromise(code) })
  })
  if (exitCode !== 0) fail(`OpenCode acceptance failed with exit ${exitCode}`, { stderr, stdout })
  if (providerFailure) fail("provider could not verify Bash results", { message: providerFailure.message, detail: providerFailure.cause, runRoot })

  const events = outputEvents(stdout)
  const sessionID = events.find((event) => event.type === "step_start")?.sessionID
  if (typeof sessionID !== "string" || !sessionID) fail("OpenCode Session ID not found in JSON event output", { stdout })
  const evidence = calls.map((call) => {
    const parts = events.filter((event) => event.type === "tool_use" && event.part?.tool === "bash" && event.part?.callID === call.id)
    if (parts.length !== 1) fail(`expected one Bash ToolPart for ${call.id}`, { count: parts.length })
    const state = parts[0].part.state
    const producing = requests.find((entry) => entry.body.messages?.some((message) => message?.tool_calls?.some((toolCall) => toolCall.id === call.id)))
    const inputText = producing?.body.messages?.find((message) => message?.tool_calls?.some((toolCall) => toolCall.id === call.id))
      ?.tool_calls?.find((toolCall) => toolCall.id === call.id)?.function?.arguments
    const providerInput = JSON.parse(inputText)
    const result = state?.metadata?.o4eResult
    if (!isDeepStrictEqual(state?.input, providerInput) || state?.status !== "completed" || result?.kind !== "command"
      || result?.status !== "completed" || result?.exitCode !== 0 || state.output !== `${call.expected}\n` || state.output !== result.output
      || typeof result.taskID !== "string" || !result.taskID.startsWith("o4e_command_")
      || parts[0].sessionID !== sessionID || parts[0].part.sessionID !== sessionID
      || state?.metadata?.kind !== "command" || state.metadata.taskID !== result.taskID) {
      fail(`cwd evidence mismatch for ${call.id}`, { expected: call.expected, providerInput, state })
    }
    return { callID: call.id, taskID: result.taskID, input: state.input, output: result.output, exitCode: result.exitCode, status: result.status }
  })
  const report = {
    status: "passed", sessionID, opencode: run(opencode, ["--version"]).stdout.trim(),
    processCwd: sourceRoot, directory, worktree, transportMode, bashSchema, evidence,
    requestCount: requests.length, finalMarker: stdout.includes("WORKSPACE_CWD_ACCEPTANCE_DONE"),
  }
  if (!report.finalMarker || requestCountInvalid(report.requestCount)) fail("OpenCode acceptance did not reach the bounded final response", report)
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise))
}

function requestCountInvalid(count) {
  return count < calls.length + 1 || count > MAX_PROVIDER_REQUESTS
}
