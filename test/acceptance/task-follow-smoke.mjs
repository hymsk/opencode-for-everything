import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripJsonComments } from "../../src/jsonc.mjs"
import { copyInstalledDefaults } from "../helpers/o4e-fixture.mjs"
import { modelTaskPart } from "../../src/runtime/task-model-output.mjs"
import { DatabaseSync } from "node:sqlite"
import { CommandLedgerStore, commandLedgerPath } from "../../src/runtime/command-ledger-store.mjs"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pluginUrl = pathToFileURL(join(sourceRoot, "test", "acceptance", "workspace-cwd-plugin.mjs")).href
const opencodeName = process.env.OPENCODE_BIN || "opencode"
const opencode = realpathSync(opencodeName.includes("/") ? opencodeName : run("which", [opencodeName]).stdout.trim())
const runRoot = realpathSync(mkdtempSync("/tmp/opencode/o4e-task-follow-smoke-"))
const reportPath = join(runRoot, "report.json")
const modes = [false, true]
const storage = process.argv.includes("--storage")
const cards = process.argv.includes("--cards") || storage
const requestLimit = cards ? 64 : 20

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

function toolResult(body, callID) {
  const message = [...(Array.isArray(body.messages) ? body.messages : [])].reverse()
    .find((entry) => entry?.role === "tool" && entry.tool_call_id === callID)
  return message ? jsonText(message.content) : undefined
}

function outputEvents(stdout) {
  return stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function streamResponse(response, { id, model = "smoke", content, tool }) {
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

function transportArgs(schema, args) {
  const result = { ...args }
  for (const name of schema?.required ?? []) if (!Object.hasOwn(result, name)) result[name] = null
  return result
}

function parseJsonResult(text, label) {
  try { return JSON.parse(text) } catch (error) { fail(`${label} was not JSON`, { text, message: error.message }) }
}

function normalizeEvidence(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(normalizeEvidence)
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["taskID", "waitedMs", "revision", "logPath", "createdAt", "updatedAt", "startedAt", "completedAt"].includes(key))
    .map(([key, entry]) => [key, normalizeEvidence(entry)]))
}

async function closeServer(server) {
  if (!server.listening) return
  await new Promise((resolvePromise) => server.close(resolvePromise))
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, "SIGTERM") } catch { try { child.kill("SIGTERM") } catch {} }
  setTimeout(() => {
    if (child.exitCode !== null) return
    try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} }
  }, 1500).unref()
}

async function runMode(detail) {
  const label = detail ? "detail-true" : "detail-false"
  const modeRoot = join(runRoot, label)
  const directory = join(modeRoot, "project")
  const home = join(modeRoot, "home")
  const tmp = join(modeRoot, "tmp")
  const configHome = join(modeRoot, "config")
  const dataHome = join(modeRoot, "data")
  const cacheHome = join(modeRoot, "cache")
  const stateHome = join(modeRoot, "state")
  mkdirSync(directory, { recursive: true })
  for (const path of [home, tmp, configHome, dataHome, cacheHome, stateHome]) mkdirSync(path)
  copyInstalledDefaults(sourceRoot, directory)
  if (cards) writeFileSync(join(directory, ".o4e", "workflows", "card-smoke.jsonc"), JSON.stringify({
    contract: "process-v1", name: "card-smoke", description: "Isolated card checkpoints", output: {},
    steps: Array.from({ length: 22 }, (_, i) => ({ id: `step-${i + 1}`, type: "work" })),
  }))
  if (cards) {
    const path = join(directory, ".o4e", "agents", "all", "orchestrator.jsonc")
    const agent = readJsonc(path)
    agent.loadWorkflows.push("card-smoke")
    writeFileSync(path, JSON.stringify(agent, null, 2))
  }
  const runtimeConfigPath = join(directory, ".o4e", "config.jsonc")
  const runtimeConfig = readJsonc(runtimeConfigPath)
  runtimeConfig.enable_o4e_task_detail = detail
  if (cards) runtimeConfig.enableWorkflow = true
  runtimeConfig.soul.enabled = false
  writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`)
  run("git", ["init", "--quiet", directory])

  const providerEvidence = []
  const requests = []
  const state = { followRevision: undefined, stoppedRevision: undefined, resumedRevision: undefined, shortTaskID: undefined, longTaskID: undefined }
  let issued = 0
  let providerFailure
  let o4eSchema
  let bashSchema
  const steps = [
    {
      id: `${label}-workflow-list-empty`, name: "o4e_workflow", args: () => ({ action: "list" }),
      verify(text) { assert.deepEqual(parseJsonResult(text, "empty Workflow list"), { status: "workflow-list", runs: [] }) },
    },
    {
      id: `${label}-follow-read-1`, name: "o4e_task", args: () => ({ action: "follow" }),
      verify(text) {
        const value = parseJsonResult(text, "initial follow")
        assert.deepEqual(value, { action: "follow", revision: 1, enabled: true, tasksCancelled: false })
        state.followRevision = value.revision
      },
    },
    {
      id: `${label}-follow-stop`, name: "o4e_task", args: () => ({ action: "follow", enabled: false, expectedRevision: state.followRevision }),
      verify(text) {
        const value = parseJsonResult(text, "stopped follow")
        assert.equal(value.enabled, false)
        assert.equal(value.revision, state.followRevision + 1)
        assert.equal(value.tasksCancelled, false)
        state.stoppedRevision = value.revision
      },
    },
    {
      id: `${label}-follow-read-2`, name: "o4e_task", args: () => ({ action: "follow" }),
      verify(text) {
        const value = parseJsonResult(text, "stopped follow read")
        assert.equal(value.enabled, false)
        assert.equal(value.revision, state.stoppedRevision)
        assert.equal(value.tasksCancelled, false)
      },
    },
    {
      id: `${label}-follow-resume`, name: "o4e_task", args: () => ({ action: "follow", enabled: true, expectedRevision: state.stoppedRevision }),
      verify(text) {
        const value = parseJsonResult(text, "resumed follow")
        assert.equal(value.enabled, true)
        assert.equal(value.revision, state.stoppedRevision + 1)
        assert.equal(value.tasksCancelled, false)
        state.resumedRevision = value.revision
      },
    },
    {
      id: `${label}-follow-read-3`, name: "o4e_task", args: () => ({ action: "follow" }),
      verify(text) {
        const value = parseJsonResult(text, "resumed follow read")
        assert.equal(value.enabled, true)
        assert.equal(value.revision, state.resumedRevision)
        assert.equal(value.tasksCancelled, false)
      },
    },
    {
      id: `${label}-watch-empty`, name: "o4e_task", args: () => ({ action: "watch", taskIDs: [], timeoutMs: 50, ioTimeoutMs: 2000 }),
      verify(text) { assert.match(text, /^Watch · empty\b/) },
    },
    {
      id: `${label}-bash-short`, name: "bash", args: () => ({ command: "printf SHORT", description: "short smoke command", timeout: 5000 }),
      verify(text) { assert.equal(text, "SHORT") },
    },
    {
      id: `${label}-follow-stop-final`, name: "o4e_task", args: () => ({ action: "follow", enabled: false, expectedRevision: state.resumedRevision }),
      verify(text) {
        const value = parseJsonResult(text, "final stopped follow")
        assert.equal(value.enabled, false)
        assert.equal(value.revision, state.resumedRevision + 1)
        assert.equal(value.tasksCancelled, false)
      },
    },
    {
      id: `${label}-bash-long`, name: "bash", args: () => ({ command: "printf BEGIN; sleep 12; printf END", description: "detached smoke command", timeout: 30000 }),
      verify(text) {
        assert.match(text, /o4e_command_[a-f0-9]{32}/)
        assert.match(text, /running|queued/)
        state.longTaskID = text.match(/o4e_command_[a-f0-9]{32}/)?.[0]
      },
    },
    {
      id: `${label}-long-watch`, name: "o4e_task", args: () => ({ action: "watch", taskID: state.longTaskID, timeoutMs: 10000, ioTimeoutMs: 3000 }),
      verify(text) {
        assert.match(text, /^Watch · actionable\b/)
        assert.match(text, /completed/)
        assert.doesNotMatch(text, /BEGINEND/)
      },
    },
    {
      id: `${label}-long-output`, name: "o4e_task", args: () => ({ action: "output", taskID: state.longTaskID }),
      verify(text) { assert.equal(text, "BEGINEND") },
    },
  ]
  if (cards) steps.push(
    { id: `${label}-workflow-start`, name: "o4e_workflow", args: () => ({ action: "start", workflow: "card-smoke" }), verify(text) {
      const value = parseJsonResult(text, "Workflow start"); assert.equal(value.revision, 1); state.runID = value.runID
    } },
    { id: `${label}-workflow-begin`, name: "o4e_workflow", args: () => ({ action: "begin", runID: state.runID, stepID: "step-1", expectedRevision: 1 }), verify(text) {
      const value = parseJsonResult(text, "Workflow begin"); assert.equal(value.steps["step-1"].status, "active")
    } },
    { id: `${label}-workflow-list-active`, name: "o4e_workflow", args: () => ({ action: "list" }), verify(text) {
      const value = parseJsonResult(text, "Workflow active list"); assert.equal(value.runs.length, 1)
      assert.equal(value.runs[0].runID, state.runID); assert.equal(value.runs[0].activeStep.stepID, "step-1"); assert.equal(value.runs[0].totalSteps, 22)
    } },
    { id: `${label}-workflow-pause`, name: "o4e_workflow", args: () => ({ action: "pause", runID: state.runID, expectedRevision: 2 }), verify(text) {
      assert.equal(parseJsonResult(text, "Workflow pause").status, "paused")
    } },
    { id: `${label}-workflow-list-paused`, name: "o4e_workflow", args: () => ({ action: "list" }), verify(text) {
      const value = parseJsonResult(text, "Workflow paused list"); assert.equal(value.runs[0].status, "paused"); assert.equal(value.runs[0].revision, 3)
    } },
    ...Array.from({ length: 19 }, (_, i) => ({ id: `${label}-card-bash-${i}`, name: "bash",
      args: () => ({ command: i === 18
        ? `node -e 'for(let i=1;i<=400;i++) console.log("OUTPUT_LINE_"+String(i).padStart(4,"0")+" "+"x".repeat(48))'`
        : storage ? "printf '%08192d' 0" : `printf CARD_${i}`, description: "isolated pagination fixture", timeout: 5000 }),
      verify(text) {
        if (i !== 18) return assert.equal(text, storage ? "0".repeat(8192) : `CARD_${i}`)
        assert.equal(text.split("\n").length, 401)
        assert.match(text, /^OUTPUT_LINE_0001 /)
        assert.match(text, /OUTPUT_LINE_0400 x+\n$/)
        assert.ok(text.length > 24000, "Output fixture must exercise multiple TUI pages")
      } })),
    { id: `${label}-card-agent`, name: "task", args: () => ({ description: "Isolated navigation fixture", prompt: "Return the fixture marker only; do not use tools.", subagent_type: "researcher (plan)" }), verify(text) {
      state.agentTaskID = text.match(/o4e_task_[a-f0-9]{32}/)?.[0]; assert.ok(state.agentTaskID, "Agent task identity missing")
    } },
    { id: `${label}-card-agent-watch`, name: "o4e_task", args: () => ({ action: "watch", taskID: state.agentTaskID, timeoutMs: 15000, ioTimeoutMs: 3000 }), verify(text) {
      assert.match(text, /completed/)
    } },
    { id: `${label}-card-agent-output`, name: "o4e_task", args: () => ({ action: "output", taskID: state.agentTaskID }), verify(text) {
      assert.match(text, /TASK_FOLLOW_SMOKE_AUX/)
    } },
  )

  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      let total = 0
      for await (const chunk of request) {
        total += chunk.length
        if (total > 4 * 1024 * 1024) fail("provider request body exceeded 4 MiB")
        chunks.push(chunk)
      }
      if (requests.length >= requestLimit) fail("provider request limit exceeded")
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      requests.push({ url: request.url, messageCount: body.messages?.length, toolCount: body.tools?.length })
      if (providerFailure) throw providerFailure
      const schemas = new Map((Array.isArray(body.tools) ? body.tools : []).map((entry) => [entry?.function?.name, entry?.function?.parameters]))
      if (!schemas.has("o4e_task") || !schemas.has("bash")) {
        streamResponse(response, { id: `${label}-aux-${requests.length}`, content: "TASK_FOLLOW_SMOKE_AUX" })
        return
      }
      o4eSchema ??= structuredClone(schemas.get("o4e_task"))
      bashSchema ??= structuredClone(schemas.get("bash"))
      if (issued > 0) {
        const previous = steps[issued - 1]
        const text = toolResult(body, previous.id)
        if (text === undefined) fail(`missing model-visible result for ${previous.id}`)
        previous.verify(text)
        providerEvidence.push({ callID: previous.id, tool: previous.name, output: text })
      }
      const current = steps[issued]
      if (!current) {
        streamResponse(response, { id: `${label}-done-${requests.length}`, content: "TASK_FOLLOW_SMOKE_DONE" })
        return
      }
      const schema = schemas.get(current.name)
      if (!schema) fail(`missing schema for ${current.name}`)
      const args = transportArgs(schema, current.args())
      issued += 1
      streamResponse(response, { id: `${label}-fixture-${requests.length}`, tool: { id: current.id, name: current.name, args } })
    } catch (error) {
      providerFailure ??= error
      streamResponse(response, { id: `${label}-failed-${requests.length}`, content: "TASK_FOLLOW_SMOKE_FAILED" })
    }
  })

  let child
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise)
      server.listen(0, "127.0.0.1", resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === "string") fail("fake provider address unavailable")
    const provider = {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Task follow smoke fixture",
        options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only" },
        models: { smoke: { name: "Task follow smoke", toolcall: true, limit: { context: 32768, output: 4096 } } },
      },
    }
    writeFileSync(join(directory, "opencode.json"), `${JSON.stringify({ plugin: [pluginUrl], provider }, null, 2)}\n`)
    run(process.execPath, [join(sourceRoot, "scripts", "installer.mjs"), "build", `--target=${directory}`], { cwd: sourceRoot })
    cpSync(join(sourceRoot, "node_modules"), join(directory, ".opencode", "node_modules"), { recursive: true })
    cpSync(join(sourceRoot, "package-lock.json"), join(directory, ".opencode", "package-lock.json"))
    mkdirSync(join(configHome, "opencode"), { recursive: true })
    cpSync(join(directory, ".opencode", "node_modules"), join(configHome, "opencode", "node_modules"), { recursive: true })
    cpSync(join(directory, ".opencode", "package.json"), join(configHome, "opencode", "package.json"))
    cpSync(join(directory, ".opencode", "package-lock.json"), join(configHome, "opencode", "package-lock.json"))

    child = spawn(opencode, ["run", "--dir", directory, "--model", "fixture/smoke", "--agent", "orchestrator", "--auto", "--format", "json",
      "Execute only the deterministic tool calls supplied by the local fixture, then stop."], {
      cwd: sourceRoot,
      detached: true,
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
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pluginUrl], provider }),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_AUTH_CONTENT: "{}",
        OPENCODE_PRINT_LOGS: "1",
        OPENCODE_LOG_LEVEL: "INFO",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) stopChild(child)
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (Buffer.byteLength(stderr) > 4 * 1024 * 1024) stopChild(child)
    })
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        stopChild(child)
        rejectPromise(Object.assign(new Error(`OpenCode ${label} smoke timed out`), { cause: { requestCount: requests.length, runRoot } }))
      }, 120_000)
      child.once("error", (error) => { clearTimeout(timer); rejectPromise(error) })
      child.once("close", (code) => { clearTimeout(timer); resolvePromise(code) })
    })
    if (exitCode !== 0) fail(`OpenCode ${label} smoke failed with exit ${exitCode}`, { stdout, stderr, runRoot })
    if (providerFailure) fail(`provider verification failed for ${label}`, { message: providerFailure.message, detail: providerFailure.cause, stdout, stderr, runRoot })
    if (issued !== steps.length || providerEvidence.length !== steps.length || !stdout.includes("TASK_FOLLOW_SMOKE_DONE")) {
      fail(`bounded fixture sequence incomplete for ${label}`, { issued, evidence: providerEvidence.length, requests: requests.length, stdout })
    }

    const events = outputEvents(stdout)
    const sessionID = events.find((event) => event.type === "step_start")?.sessionID
    if (typeof sessionID !== "string" || !sessionID) fail(`Session ID missing for ${label}`, { stdout })
    const toolParts = new Map()
    for (const event of events.filter((entry) => entry.type === "tool_use" && typeof entry.part?.callID === "string")) {
      const current = toolParts.get(event.part.callID)
      if (!current || (current.state?.status !== "completed" && event.part.state?.status === "completed")) {
        toolParts.set(event.part.callID, event.part)
      }
    }
    for (const step of steps) if (!toolParts.has(step.id)) fail(`missing ToolPart for ${step.id}`)
    const uiWatchEmpty = toolParts.get(`${label}-watch-empty`).state
    assert.equal(uiWatchEmpty.output === "", !detail)
    for (const [id, part] of toolParts) toolParts.set(id, modelTaskPart(part))
    const watchEmpty = toolParts.get(`${label}-watch-empty`).state
    assert.equal(watchEmpty.status, "completed")
    assert.match(watchEmpty.output, /^Watch · empty\b/)
    assert.equal(watchEmpty.metadata?.o4eResult?.reason, "empty")
    assert.deepEqual(watchEmpty.metadata.o4eResult.tasks, [])
    assert.equal(Boolean(watchEmpty.title), detail)
    assert.equal(Object.hasOwn(watchEmpty.metadata, "action"), detail)
    const short = toolParts.get(`${label}-bash-short`).state
    state.shortTaskID = short.metadata?.o4eResult?.taskID
    assert.match(state.shortTaskID, /^o4e_command_[a-f0-9]{32}$/)
    assert.equal(short.output, "SHORT")
    assert.equal(short.metadata.o4eResult.output, "SHORT")
    assert.equal(short.metadata.o4eResult.status, "completed")
    assert.equal(short.metadata.o4eResult.exitCode, 0)
    const long = toolParts.get(`${label}-bash-long`).state
    assert.match(long.metadata?.o4eResult?.taskID, /^o4e_command_[a-f0-9]{32}$/)
    assert.ok(["queued", "running"].includes(long.metadata.o4eResult.status))
    const longWatch = toolParts.get(`${label}-long-watch`).state
    assert.equal(longWatch.metadata?.o4eResult?.tasks?.[0]?.status, "completed")
    assert.equal(longWatch.metadata.o4eResult.tasks[0].taskID, long.metadata.o4eResult.taskID)
    assert.equal(longWatch.output.includes("BEGINEND"), false)
    const longOutput = toolParts.get(`${label}-long-output`).state
    assert.equal(longOutput.output, "BEGINEND")
    assert.equal(longOutput.metadata?.o4eResult?.output, "BEGINEND")
    assert.equal(longOutput.metadata.o4eResult.taskID, long.metadata.o4eResult.taskID)
    const followParts = ["follow-read-1", "follow-stop", "follow-read-2", "follow-resume", "follow-read-3", "follow-stop-final"]
      .map((suffix) => toolParts.get(`${label}-${suffix}`).state)
    assert.ok(followParts.every((part) => part.status === "completed" && parseJsonResult(part.output, "follow ToolPart").tasksCancelled === false))

    const hostDb = new DatabaseSync(join(dataHome, "opencode", "opencode.db"), { readOnly: true })
    let storageEvidence
    try {
      const row = hostDb.prepare("SELECT metadata FROM session WHERE id=?").get(sessionID)
      const metadata = JSON.parse(row.metadata)
      const ledgerRoot = join(dataHome, "opencode-for-everything", "command-ledgers")
      const ledger = new CommandLedgerStore({ get: async () => ({ id: sessionID, metadata }) }, directory, { root: ledgerRoot })
      // Host process has exited. Reopen the actual Bun-written ledger through
      // Node SQLite and compare exact outputs with the actual completed Parts.
      const refs = (await ledger.get(sessionID)).metadata.o4e.commandTasks.refs
      assert.equal(metadata.o4e.commandTasks.version, 2)
      for (const [id, ref] of Object.entries(refs)) {
        assert.equal(ref.recovery.status, "completed")
        assert.equal(ref.recovery.stopped, true)
        assert.equal(metadata.o4e.commandTasks.refs[id].snapshot.revision, ref.recovery.revision)
        assert.equal(Object.hasOwn(metadata.o4e.commandTasks.refs[id], "recovery"), false)
        const part = toolParts.get(ref.recovery.source.callID)
        assert.ok(part, "canonical source must identify an actual ToolPart")
        const expected = id === long.metadata.o4eResult.taskID ? "BEGINEND" : modelTaskPart(part).state.output
        assert.equal(ref.recovery.result.output, expected)
      }
      const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
      const reconstructed = { ...metadata, o4e: { ...metadata.o4e, commandTasks: { version: 1, refs } } }
      storageEvidence = {
        tasks: Object.keys(refs).length, exactOutputAfterHostExit: true,
        projectedCommandBytes: bytes(metadata.o4e.commandTasks), canonicalCommandBytes: bytes({ version: 1, refs }),
        ownerMetadataBytes: bytes(metadata), reconstructedFullRecoveryOwnerBytes: bytes(reconstructed),
        ownerMetadataReductionPercent: Number(((1 - bytes(metadata) / bytes(reconstructed)) * 100).toFixed(2)),
        comparison: "same actual records reconstructed in prior full-recovery layout; not an old-host A/B or total disk reduction",
        ledgerPath: commandLedgerPath(directory, ledgerRoot),
        sessionUpdateEvents: hostDb.prepare("SELECT count(*) AS count FROM event WHERE aggregate_id=? AND type=?").get(sessionID, "session.updated.1").count,
      }
      if (storage) assert.ok(storageEvidence.ownerMetadataReductionPercent > 85)
    } finally { hostDb.close() }
    const evidence = {
      detail,
      storage: storageEvidence,
      cards: cards ? { runID: state.runID, workflowSteps: 22, commandCount: 21, agentTaskID: state.agentTaskID } : undefined,
      sessionID,
      requestCount: requests.length,
      finalMarker: true,
      follow: followParts.map((part) => parseJsonResult(part.output, "follow ToolPart")),
      watchEmpty: { output: watchEmpty.output, uiOutput: uiWatchEmpty.output, title: watchEmpty.title, metadata: watchEmpty.metadata },
      short: { output: short.output, result: short.metadata.o4eResult },
      detached: { initialOutput: long.output, initialResult: long.metadata.o4eResult,
        watchOutput: longWatch.output, watchResult: longWatch.metadata.o4eResult,
        output: longOutput.output, outputResult: longOutput.metadata.o4eResult },
      schemas: { o4eTaskRequired: o4eSchema.required ?? [], bashRequired: bashSchema.required ?? [] },
    }
    writeFileSync(join(modeRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`)
    writeFileSync(join(modeRoot, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`)
    return evidence
  } finally {
    stopChild(child)
    await closeServer(server)
  }
}

const results = []
try {
  for (const detail of modes) results.push(await runMode(detail))
  assert.equal(results[0].watchEmpty.output, results[1].watchEmpty.output)
  assert.deepEqual(normalizeEvidence(results[0].watchEmpty.metadata.o4eResult), normalizeEvidence(results[1].watchEmpty.metadata.o4eResult))
  assert.equal(results[0].short.output, results[1].short.output)
  assert.deepEqual(normalizeEvidence(results[0].short.result), normalizeEvidence(results[1].short.result))
  assert.match(results[0].detached.initialOutput, /^\[O4E command running; taskID=o4e_command_[a-f0-9]{32}; use o4e_task watch\/inspect\/output\/cancel\]$/)
  assert.match(results[1].detached.initialOutput, /^\[O4E command running; taskID=o4e_command_[a-f0-9]{32}; use o4e_task watch\/inspect\/output\/cancel\]$/)
  assert.deepEqual(normalizeEvidence(results[0].detached.initialResult), normalizeEvidence(results[1].detached.initialResult))
  assert.equal(results[0].detached.watchOutput.replace(/o4e_command_[a-f0-9]{32}/g, "<task>"),
    results[1].detached.watchOutput.replace(/o4e_command_[a-f0-9]{32}/g, "<task>"))
  assert.deepEqual(normalizeEvidence(results[0].detached.watchResult), normalizeEvidence(results[1].detached.watchResult))
  assert.equal(results[0].detached.output, results[1].detached.output)
  assert.deepEqual(normalizeEvidence(results[0].detached.outputResult), normalizeEvidence(results[1].detached.outputResult))
  const report = {
    status: "passed",
    cards,
    storage,
    opencode: run(opencode, ["--version"]).stdout.trim(),
    node: process.version,
    localPlugin: JSON.parse(readFileSync(join(sourceRoot, "node_modules", "@opencode-ai", "plugin", "package.json"))).version,
    localSdk: JSON.parse(readFileSync(join(sourceRoot, "node_modules", "@opencode-ai", "sdk", "package.json"))).version,
    runRoot,
    modes: results.map((entry) => ({ detail: entry.detail, sessionID: entry.sessionID, requestCount: entry.requestCount, storage: entry.storage,
      evidencePath: join(runRoot, entry.detail ? "detail-true" : "detail-false", "evidence.json") })),
    equivalence: {
      watchReadableBody: true,
      watchO4eResult: true,
      shortBashReadableBody: true,
      shortBashO4eResult: true,
      detachedInitialReadableBody: true,
      detachedInitialO4eResult: true,
      detachedWatchReadableBody: true,
      detachedWatchO4eResult: true,
      detachedOutputReadableBody: true,
      detachedOutputO4eResult: true,
    },
    limits: { providerRequestsPerMode: requestLimit, providerBodyBytes: 4 * 1024 * 1024, processOutputBytes: 4 * 1024 * 1024, processTimeoutMs: 120000 },
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
} catch (error) {
  const failure = { status: "failed", message: error.message, cause: error.cause, runRoot, reportPath }
  writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`)
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`)
  process.exitCode = 1
}
