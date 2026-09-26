// Opt-in, credential-free acceptance of the published V2 preview entry.
// It deliberately does not exercise O4E managed execution or user configuration.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyInstalledDefaults } from "../helpers/o4e-fixture.mjs"

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = mkdtempSync(join(tmpdir(), "o4e-v2-preview-"))
const project = join(root, "project")
const plugin = join(project, "plugins", "o4e-preview")
for (const path of [project, plugin, ...["home", "config", "data", "cache", "state", "runtime"].map((name) => join(root, name))]) {
  mkdirSync(path, { recursive: true })
}
const report = { host: "", package: "", requests: 0, status: "not-run", managedExecution: "not-run" }
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: source, encoding: "utf8", timeout: 90_000, ...options })
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr ?? "").slice(-900)}`)
  return result.stdout.trim()
}
const executable = process.env.OPENCODE_V2_BIN || "opencode2"
const path = executable.includes("/") ? executable : run("which", [executable])
report.host = run(path, ["--version"])
assert.match(report.host, /\bv?2\.0\.15\b/, "pin the host before interpreting this acceptance")

const tarball = run("npm", ["pack", "--silent", "--pack-destination", root])
run("npm", ["install", "--prefix", project, "--ignore-scripts", "--no-audit", "--no-fund", join(root, tarball)])
const installed = join(project, "node_modules", "@hymsk", "o4e")
report.package = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version
assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).exports["./v2"], "./src/plugin-v2.mjs")
// The host loads directory plugins, so forward from a directory to the real
// installed package export. This is not a rewritten copy of the adapter.
writeFileSync(join(plugin, "package.json"), '{"type":"module"}\n')
writeFileSync(join(plugin, "index.mjs"), 'export { default } from "@hymsk/o4e/v2"\n')
copyInstalledDefaults(source, project)
const configPath = join(project, ".o4e", "config.jsonc")
const config = readFileSync(configPath, "utf8")
assert.ok(config.includes('"mcp": {},'), "fixture requires an empty default MCP map")
writeFileSync(configPath, config.replace('"mcp": {},', '"mcp": { "never-run": { "type": "local", "command": ["/does-not-exist-o4e-v2-probe"] } },'))

let providerError
let seenStatus = false
let requestedStatus = false
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    report.requests += 1
    assert.ok(report.requests <= 5, "provider request budget")
    const tools = body.tools ?? []
    // The host may make an auxiliary title/compaction request without tools.
    if (tools.length) assert.ok(tools.some((item) => item.function?.name === "o4e_v2_status"),
      `installed status tool must reach model (request ${report.requests}, names: ${tools.map((item) => item.function?.name).join(",")})`)
    if (tools.length && !requestedStatus) requestedStatus = true
    for (const forbidden of ["task", "o4e_task", "o4e_workflow"]) {
      assert.ok(!tools.some((item) => item.function?.name === forbidden && item.function?.description?.includes("O4E")), `managed ${forbidden} must not register`)
    }
    const result = (body.messages ?? []).filter((item) => item.role === "tool" && item.tool_call_id === "call_v2_status")
    for (const item of result) {
      const text = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? [])
      try {
        const value = JSON.parse(text)
        if (value.configuredMcpServerCount === 1 && value.mcpProjection === "unavailable"
          && value.managedExecution === "unavailable") seenStatus = true
      } catch { /* not a matching structured status result */ }
    }
    const tool = requestedStatus && !seenStatus && tools.length > 0
      ? { id: "call_v2_status", name: "o4e_v2_status", args: {} }
      : undefined
    const event = (delta, reason = null) => `data: ${JSON.stringify({
      id: `v2-fixture-${report.requests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "status",
      choices: [{ index: 0, delta, finish_reason: reason }],
    })}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    response.end(event({ role: "assistant" })
      + (tool ? event({ tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: "{}" } }] })
        : event({ content: tools.length ? "V2_PREVIEW_DONE" : "V2 preview test title" }))
      + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
  } catch (error) {
    providerError ??= error
    response.writeHead(500).end("fixture rejected request")
  }
})

try {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok) })
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  writeFileSync(join(project, "opencode.json"), JSON.stringify({
    plugins: ["./plugins/o4e-preview"],
    providers: {
      fixture: {
        name: "O4E V2 test provider", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
        models: { status: { name: "Status", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32768, output: 4096 } } },
      },
    },
  }))
  const environment = {
    PATH: [dirname(path), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
    LANG: "C.UTF-8", TERM: "dumb", SHELL: "/bin/sh", o4e_config: join(project, ".o4e"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_AUTH_CONTENT: "{}",
  }
  const child = spawn(path, ["run", "--standalone", "--model", "fixture/status", "--agent", "build", "--format", "json",
    "Call o4e_v2_status once, then stop."], { cwd: project, env: environment, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8").slice(0, 65536) })
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 65536) })
  const exit = await new Promise((ok, fail) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail(new Error("V2 host timeout")) }, 90_000)
    child.once("error", (error) => { clearTimeout(timer); fail(error) })
    child.once("close", (code) => { clearTimeout(timer); ok(code) })
  })
  assert.equal(exit, 0, `V2 host failed: ${providerError?.message ?? "no provider error"}; ${stderr.slice(-1100)} ${stdout.slice(-800)}`)
  if (providerError) throw new Error(`${providerError.message}; host: ${stderr.slice(-3500)}; events: ${stdout.slice(-1800)}`)
  assert.equal(seenStatus, true, "model must receive the status tool result")
  assert.match(stdout, /V2_PREVIEW_DONE/, "host must reach the final model turn")
  assert.match(stdout, /configuredMcpServerCount/, "host tool event must contain O4E status")
  assert.match(stdout, /managedExecution/, "host tool event must report execution unavailable")
  report.status = "passed"
  report.managedExecution = "unavailable"
  console.log(JSON.stringify({ report, fixture: root }))
} catch (error) {
  console.error(JSON.stringify({ report, fixture: root, error: error.message }))
  process.exitCode = 1
} finally {
  await new Promise((ok) => server.close(ok))
}
