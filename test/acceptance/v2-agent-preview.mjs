// Explicit opt-in host check for the isolated, deny-all Agent preview exporter.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { copyInstalledDefaults } from "../helpers/o4e-fixture.mjs"
import { buildV2PreviewAgents } from "../../src/adapters/opencode-v2/agent-preview-builder.mjs"

const root = mkdtempSync(join(tmpdir(), "o4e-v2-agent-preview-"))
const project = join(root, "project")
for (const path of [project, ...["source", "home", "config", "data", "cache", "state", "runtime"].map((entry) => join(root, entry))]) mkdirSync(path)
const source = resolve(import.meta.dirname, "../..")
const configRoot = copyInstalledDefaults(source, join(root, "source"))
const packaged = process.argv.includes("--package")
let result
if (packaged) {
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source, encoding: "utf8", timeout: 90_000 })
  assert.equal(packed.status, 0, packed.stderr)
  const installed = join(root, "installed")
  const install = spawnSync("npm", ["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund",
    join(root, packed.stdout.trim())], { cwd: source, encoding: "utf8", timeout: 90_000 })
  assert.equal(install.status, 0, install.stderr)
  const cli = join(installed, "node_modules", "@hymsk", "o4e", "scripts", "build-v2-preview.mjs")
  const build = spawnSync(process.execPath, [cli, "--config-root", configRoot, "--target", project],
    { cwd: source, encoding: "utf8", timeout: 60_000 })
  assert.equal(build.status, 0, build.stderr)
  result = { names: (await import("node:fs")).readdirSync(join(project, ".opencode", "agents")).map((name) => name.slice(0, -3)),
    directory: join(project, ".opencode", "agents") }
} else result = buildV2PreviewAgents({ configRoot, target: project })
const collision = process.argv.includes("--collision")
const globalCollision = process.argv.includes("--global-collision")
const tamper = process.argv.includes("--tamper")
const probe = process.argv.includes("--probe")
if (tamper) {
  const file = join(result.directory, "o4e-v2-preview-plan-chat.md")
  writeFileSync(file, readFileSync(file, "utf8").replace('    effect: deny\n---', '    effect: deny\n  - action: shell\n    resource: "*"\n    effect: allow\n---'))
}
const executable = process.env.OPENCODE_V2_BIN || "opencode2"
const path = executable.includes("/") ? resolve(executable) : spawnSync("which", [executable], { encoding: "utf8" }).stdout.trim()
assert.match(spawnSync(path, ["--version"], { encoding: "utf8" }).stdout, /\bv?2\.0\.15\b/)
let seen, requests = 0, providerError, probeIssued = false
const server = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests++
    if (requests > 5) throw new Error("request budget")
    const content = JSON.stringify(body.messages ?? [])
    if (content.includes("opencode-for-everything-v2-preview-agent:o4e-v2-preview-plan-chat")) {
      seen = { tools: (body.tools ?? []).map((entry) => entry.function?.name).filter(Boolean), content }
    }
    const event = (delta, reason = null) => `data: ${JSON.stringify({ id: `fixture-${requests}`, object: "chat.completion.chunk", created: 1,
      model: "probe", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(event({ role: "assistant" }) + (probe && seen && !probeIssued && (probeIssued = true)
      ? event({ tool_calls: [{ index: 0, id: "call_preview_probe", type: "function", function: {
        name: "shell", arguments: JSON.stringify({ command: "printf O4E_V2_UNEXPECTED > escaped", timeout: 10000 }),
      } }] }) + event({}, "tool_calls")
      : event({ content: "O4E_V2_AGENT_PREVIEW_DONE" }) + event({}, "stop")) + "data: [DONE]\n\n")
  } catch (error) { providerError = error; response.writeHead(500).end("fixture rejected") }
})
try {
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok) })
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: ["./.opencode/plugins/o4e-v2-preview-guard"], ...(collision ? { agents: {
    "o4e-v2-preview-plan-chat": { permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
  } } : {}), providers: { fixture: {
    name: "Local fixture", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" },
    models: { probe: { name: "Probe", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32768, output: 4096 } },
    },
  } } }))
  if (globalCollision) {
    const global = join(root, "config", "opencode", "agents")
    mkdirSync(global, { recursive: true })
    writeFileSync(join(global, "o4e-v2-preview-plan-chat.md"), '---\nmode: primary\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n---\nGLOBAL_NAME_COLLISION\n')
  }
  const env = { PATH: [dirname(path), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "runtime"),
    LANG: "C.UTF-8", TERM: "dumb", SHELL: "/bin/sh", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}" }
  const child = spawn(path, ["run", "--standalone", "--model", "fixture/probe", "--agent", "o4e-v2-preview-plan-chat", "--format", "json",
    "Respond with the fixture marker."], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  let stdout = "", stderr = "", timedOut = false
  child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-64000) })
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-64000) })
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL") } catch {} }, 60000)
  let exit
  try { exit = await new Promise((ok, fail) => { child.once("error", fail); child.once("close", ok) }) }
  finally { clearTimeout(timer) }
  writeFileSync(join(root, "result.json"), JSON.stringify({ exit, timedOut, requests, collision, globalCollision, tamper, probe, seen: Boolean(seen), toolNames: seen?.tools, stderr: stderr.slice(-1200) }, null, 2))
  if (tamper) {
    assert.equal(timedOut, false)
    assert.equal(exit, 1, "tampered Agent must fail rather than silently succeed")
    assert.equal(seen, undefined, "tampered effective Agent must not reach model")
    assert.match(stderr + stdout, /O4E_V2_PREVIEW_AGENT_UNVERIFIABLE/, "guard must reject tampered Agent")
    console.log(JSON.stringify({ status: "passed", host: "2.0.15", tamperRejected: true, fixture: root }))
    process.exit(0)
  }
  assert.ifError(providerError)
  assert.equal(timedOut, false, "host timed out")
  assert.equal(exit, 0, stderr.slice(-900))
  assert.ok(seen, `generated agent must be used; event: ${stdout.slice(-1000)}`)
  assert.equal(seen.tools.length, 0, "deny-all must expose no tools to model")
  if (probe) assert.equal(existsSync(join(project, "escaped")), false, "unoffered shell must never execute")
  assert.equal(result.names.length, 13)
  console.log(JSON.stringify({ status: "passed", host: "2.0.15", agents: result.names.length, availableTools: 0, packaged, collision, globalCollision,
    attemptedUnlistedShell: probe, fixture: root }))
} catch (error) {
  console.error(JSON.stringify({ status: "failed", fixture: root, error: error.message }))
  process.exitCode = 1
} finally { await new Promise((ok) => server.close(ok)) }
