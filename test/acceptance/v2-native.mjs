// Opt-in Linux native-tool experiment, NOT an O4E managed-execution adapter.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

assert.equal(process.platform, "linux", "this fixture is Linux-only")
const root = mkdtempSync(join(tmpdir(), "o4e-v2-native-"))
const executable = process.env.OPENCODE_V2_BIN || "opencode2"
const found = spawnSync("which", [executable], { encoding: "utf8" })
const binary = executable.includes("/") ? resolve(executable) : found.stdout.trim()
const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()
assert.match(version, /\bv?2\.0\.15\b/)
const cases = []
const selected = process.argv.slice(2)
const matrix = [
  { name: "native-allow", effect: "allow", wrapped: false },
  { name: "wrapped-allow", effect: "allow", wrapped: true },
  { name: "native-deny", effect: "deny", wrapped: false },
  { name: "wrapped-deny", effect: "deny", wrapped: true },
  { name: "native-ask-reject", effect: "ask", wrapped: false },
  { name: "wrapped-ask-reject", effect: "ask", wrapped: true },
  { name: "native-ask-auto", effect: "ask", wrapped: false, auto: true },
  { name: "wrapped-ask-auto", effect: "ask", wrapped: true, auto: true },
  { name: "wrapped-cancel", effect: "allow", wrapped: true, cancel: true },
  { name: "native-child-permissions", effect: "deny", wrapped: false, delegation: true },
  { name: "native-child-parent-hook", effect: "deny", wrapped: false, delegation: true, parentHook: true },
  { name: "native-child-bounded-ancestry", effect: "deny", wrapped: false, delegation: true, parentHook: true, boundedAncestry: true },
  { name: "native-child-parent-hook-failure", effect: "deny", wrapped: false, delegation: true, parentHook: true, parentLookupFail: true },
]
assert.ok(selected.every((name) => matrix.some((entry) => entry.name === name)), "unknown case name")
async function runCase(spec) {
  const base = join(root, spec.name), project = join(base, "project")
  for (const directory of [project, join(project, ".opencode", "agents"), join(project, "plugins", "probe"),
    ...["home", "config", "data", "cache", "state", "runtime"].map((name) => join(base, name))]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(project, "probe.json"), JSON.stringify(spec))
  copyFileSync(join(import.meta.dirname, "v2-native-probe-plugin.mjs"), join(project, "plugins", "probe", "index.mjs"))
  copyFileSync(join(import.meta.dirname, "../../src/adapters/opencode-v2/session-ancestry.mjs"),
    join(project, "plugins", "probe", "session-ancestry.mjs"))
  writeFileSync(join(project, "plugins", "probe", "package.json"), '{"type":"module"}')
  // Generated fixture only; does not touch a user's .opencode output.
  writeFileSync(join(project, ".opencode", "agents", "o4e-native-probe.md"), `---\ndescription: Isolated native execution acceptance\nmode: primary\nmodel: fixture/probe\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n  - action: subagent\n    resource: "*"\n    effect: deny\n  - action: shell\n    resource: "*"\n    effect: allow\n  - action: shell\n    resource: "*O4E_NATIVE_SENTINEL*"\n    effect: ${spec.effect}\n---\nO4E_NATIVE_AGENT_FIXTURE. Use only the requested fixture command.\n`)
  if (spec.delegation) {
    const agentPath = join(project, ".opencode", "agents", "o4e-native-probe.md")
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace('  - action: subagent\n    resource: "*"\n    effect: deny', '  - action: subagent\n    resource: "o4e-native-child"\n    effect: allow'))
    writeFileSync(join(project, ".opencode", "agents", "o4e-native-child.md"), '---\ndescription: Isolated child\nmode: subagent\nmodel: fixture/probe\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n  - action: subagent\n    resource: "*"\n    effect: deny\n---\nO4E_NATIVE_CHILD_FIXTURE\n')
  }
  const command = spec.cancel ? "printf '%s' $$ > shell.pid; printf O4E_NATIVE_SENTINEL > started; sleep 3; printf unexpected > late"
    : "printf O4E_NATIVE_SENTINEL > executed; printf O4E_NATIVE_SENTINEL"
  let requests = 0, issued = false, childIssued = false, providerError, modelResult, offered, childSchema
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.ok(++requests <= 8, "request budget")
      const shell = (body.tools ?? []).find((item) => item.function?.name === "shell")
      if (shell) offered = shell.function
      const subagent = (body.tools ?? []).find((item) => item.function?.name === "subagent")
      if (subagent) childSchema = subagent.function
      const result = (body.messages ?? []).find((item) => item.role === "tool" && item.tool_call_id === "call_native_probe")
      if (result) modelResult = result.content
      const primary = (body.messages ?? []).some((item) => JSON.stringify(item.content).includes("O4E_NATIVE_AGENT_FIXTURE"))
      const childTurn = (body.messages ?? []).some((item) => item.role === "system" && JSON.stringify(item.content).includes("O4E_NATIVE_CHILD_FIXTURE"))
      let tool
      if (spec.delegation && primary && !issued) {
        issued = true
        tool = { name: "subagent", arguments: JSON.stringify({ agent: "o4e-native-child", prompt: "Run the fixture sentinel shell command once.", description: "Fixture child", background: false }) }
      } else if (spec.delegation && childTurn && !childIssued) {
        childIssued = true
        tool = { name: "shell", arguments: JSON.stringify({ command, timeout: 10000 }) }
      } else if (!spec.delegation && primary && !issued) {
        issued = true
        // Even denied calls are attempted, just as a model can emit an
        // unavailable tool name. Assert separately whether the host exposed it.
        tool = { name: "shell", arguments: JSON.stringify({ command, timeout: 10000 }) }
      }
      const event = (delta, reason = null) => `data: ${JSON.stringify({ id: `fixture-${requests}`, object: "chat.completion.chunk",
        created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(event({ role: "assistant" }) + (tool ? event({ tool_calls: [{ index: 0, id: "call_native_probe", type: "function", function: tool }] })
        : event({ content: "NATIVE_PROBE_DONE" })) + event({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n")
    } catch (error) { providerError = error; response.writeHead(500).end("fixture failed") }
  })
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok))
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: ["./plugins/probe"], providers: { fixture: {
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" },
    models: { probe: { name: "Probe", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32768, output: 4096 } } },
  } } }))
  const env = { PATH: [dirname(binary), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "config"), XDG_DATA_HOME: join(base, "data"),
    XDG_CACHE_HOME: join(base, "cache"), XDG_STATE_HOME: join(base, "state"), XDG_RUNTIME_DIR: join(base, "runtime"),
    LANG: "C.UTF-8", TERM: "dumb", SHELL: "/bin/sh", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_AUTH_CONTENT: "{}" }
  let stdout = "", stderr = "", timedOut = false
  const child = spawn(binary, ["run", "--standalone", "--model", "fixture/probe", "--agent", "o4e-native-probe", "--format", "json", ...(spec.auto ? ["--auto"] : []),
    "Perform the single native fixture call."], { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const stopGroup = (signal) => { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== "ESRCH") throw error } }
  let killTimer
  const timer = setTimeout(() => { timedOut = true; stopGroup("SIGTERM"); killTimer = setTimeout(() => stopGroup("SIGKILL"), 3000) }, 45000)
  child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-100000) })
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-100000) })
  let exit
  try { exit = await new Promise((ok, fail) => { child.once("error", fail); child.once("close", ok) }) }
  finally { clearTimeout(timer); clearTimeout(killTimer); if (timedOut) stopGroup("SIGKILL"); await new Promise((ok) => server.close(ok)) }
  if (spec.cancel) await delay(3500)
  const evidence = existsSync(join(project, "evidence.jsonl")) ? readFileSync(join(project, "evidence.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []
  const result = { name: spec.name, exit, timedOut, issued, childIssued, requests, offered, childSchema, modelResult, evidence,
    executed: existsSync(join(project, "executed")), started: existsSync(join(project, "started")), late: existsSync(join(project, "late")) }
  writeFileSync(join(base, "stdout.txt"), stdout); writeFileSync(join(base, "stderr.txt"), stderr)
  writeFileSync(join(base, "result.json"), JSON.stringify(result, null, 2))
  assert.ifError(providerError)
  assert.equal(timedOut, false, `timeout: ${spec.name}`)
  assert.ok(evidence.some((event) => event.type === "agent" && event.marker && event.model?.id === "probe"), "generated Agent and model must load")
  assert.ok(evidence.some((event) => event.type === "model" && event.model?.providerID === "fixture"), "host must actually request the fixture model")
  assert.equal(issued, true, "fake model must attempt a native call")
  assert.ok(offered, "resource-specific policy must keep the native tool available")
  if (spec.wrapped) assert.ok(evidence.some((event) => event.type === "wrapper-enter" && event.callID === "call_native_probe"))
  for (const event of evidence.filter((entry) => entry.type === "permission")) {
    assert.equal(event.source?.id, "call_native_probe")
    if (event.action === "shell") assert.ok(event.resources.some((resource) => resource.includes("O4E_NATIVE_SENTINEL")))
    if (spec.wrapped) {
      const caller = evidence.find((entry) => entry.type === "wrapper-enter")
      assert.equal(event.sessionID, caller.sessionID)
      assert.equal(event.source.messageID, caller.messageID)
    }
  }
  if (spec.delegation) {
    assert.equal(childIssued, true, "native child must reach the local model")
    const parent = evidence.find((event) => event.type === "session" && event.agent === "o4e-native-probe")
    const child = evidence.find((event) => event.type === "session" && event.agent === "o4e-native-child")
    assert.ok(parent?.id && child?.id && child.id !== parent.id)
    assert.equal(child.parentID, parent.id, "native child must have physical parent")
    if (spec.parentHook) {
      if (spec.parentLookupFail) {
        assert.ok(evidence.some((event) => event.type === "parent-hook-lookup-failed"), "failure must occur before shell decision")
        assert.equal(result.executed, false, "failed parent lookup must not allow shell side effects")
        return result
      }
      if (spec.boundedAncestry) {
        assert.ok(evidence.some((event) => event.type === "ancestry" && event.depth === 1
          && event.agents[0] === "o4e-native-child" && event.agents[1] === "o4e-native-probe"))
        assert.ok(evidence.some((event) => event.type === "parent-hook-denied"))
        assert.equal(result.executed, false, "bounded public ancestry must enforce the host deny")
        return result
      }
      // This explicitly records whether the public Session snapshot exposes enough
      // parent identity for the hook; absence is an observed contract gap, not a pass.
      const checks = evidence.filter((event) => event.type === "parent-hook")
      assert.ok(checks.length > 0, "parent hook must inspect the child shell evaluation")
      if (checks.some((event) => event.parentAgent === "o4e-native-probe")) {
        assert.equal(result.executed, false, "host must enforce tightened parent-hook decision")
        assert.ok(evidence.some((event) => event.type === "parent-hook-denied"))
      } else assert.equal(result.executed, true, "without a trustworthy parent agent hook cannot derive parent's policy")
    } else assert.equal(result.executed, true, "child uses its own allow despite parent resource deny; NOT O4E permission equivalence")
  } else if (spec.cancel) {
    assert.equal(result.started, true, "command must start before cancellation")
    assert.ok(evidence.some((event) => event.type === "interrupt-returned"), "host interrupt must return")
    assert.equal(result.late, false, "no delayed write after host interrupt")
    const pid = Number(readFileSync(join(project, "shell.pid"), "utf8"))
    assert.ok(Number.isSafeInteger(pid) && pid > 1)
    assert.equal(existsSync(`/proc/${pid}`), false, "started shell process must be gone, not just missing output")
  } else {
    const rejectedAsk = spec.effect === "ask" && !spec.auto
    assert.equal(exit, rejectedAsk ? 1 : 0, `host exit: ${spec.name}`)
    if (rejectedAsk) assert.match(stderr, /auto-rejecting/, "noninteractive host must reject pending permission")
    if (spec.effect === "deny") assert.ok(JSON.stringify(modelResult).includes("permission.rejected"), "deny must be a host permission rejection")
    if (spec.effect !== "deny") assert.ok(evidence.some((event) => event.type === "permission" && event.effect === spec.effect), "host permission evaluation required")
    const allowed = spec.effect === "allow" || spec.auto === true
    assert.equal(result.executed, allowed, `sentinel side effect: ${spec.name}`)
    if (allowed) assert.ok(JSON.stringify(modelResult).includes("O4E_NATIVE_SENTINEL"), "model must receive native output")
  }
  return result
}
try {
  for (const spec of matrix.filter((entry) => !selected.length || selected.includes(entry.name))) {
    const result = await runCase(spec)
    cases.push({ name: result.name, status: "passed", executed: result.executed, permissions: result.evidence.filter((e) => e.type === "permission"),
      parentChecks: result.evidence.filter((e) => e.type === "parent-hook" || e.type === "parent-hook-denied") })
    console.log(JSON.stringify({ case: spec.name, status: "passed", fixture: root }))
  }
  writeFileSync(join(root, "report.json"), JSON.stringify({ version, cases, managedExecution: "unavailable" }, null, 2))
  console.log(JSON.stringify({ version, cases: cases.length, fixture: root, status: "passed", managedExecution: "unavailable" }))
} catch (error) {
  console.error(JSON.stringify({ fixture: root, cases, error: error.message }))
  process.exitCode = 1
}
