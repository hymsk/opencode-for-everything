import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { compilePermissionRules, evaluateResources } from "../src/core/permission-rules.mjs"
import { stripJsonComments } from "../src/jsonc.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"
import { createSharedScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { createSharedBackgroundTaskScheduler } from "../src/runtime/background-task-scheduler.mjs"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const options = { timeout: 30000 }
const hash = (value) => createHash("sha256").update(value).digest("hex")

async function bounded(operation, ms = 6000) {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`test operation exceeded ${ms} ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

async function until(predicate, ms = 2000) {
  const deadline = performance.now() + ms
  do {
    if (await predicate()) return
    await delay(5)
  } while (performance.now() < deadline)
  assert.fail(`fixture did not reach expected state within ${ms} ms`)
}

function blockSessionGet(client, sessionID) {
  const get = client.session.get
  let unblock
  let started
  const pending = new Promise((resolvePromise) => { unblock = resolvePromise })
  const entered = new Promise((resolvePromise) => { started = resolvePromise })
  client.session.get = async (args) => {
    if (args.path.id === sessionID) {
      started()
      // No timer or AbortSignal releases the store; only the test's finally does.
      await pending
    }
    return get(args)
  }
  return { entered, release() { client.session.get = get; unblock() } }
}

// Observe actual Linux processes, without replacing spawn, the port, or Runtime.
function liveProcesses(root) {
  const found = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`)
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (!["Z", "X"].includes(fields[0])) found.push({ pid: Number(entry), start: fields[19] })
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error
    }
  }
  return found
}

class HookClient {
  constructor(directory, saved = {}) {
    this.directory = directory
    this.sessions = new Map(saved.sessions)
    this.messages = new Map(saved.messages)
    this.nextSession = saved.nextSession ?? 1
    this.updateCalls = []
    this.abortCalls = []
    this.promptCalls = []
    this.promptAsyncCalls = []
    this.partUpdates = []
    this.pendingRequests = []
    this._client = { request: async ({ url, method, body, signal }) => {
      signal?.throwIfAborted()
      if (method === "GET" && /^\/(permission|question)(\?|$)|^\/api\/session\/[^/]+\/(permission|question)$/.test(url)) {
        return { data: url.startsWith("/api/") ? { data: [] }
          : this.pendingRequests.filter((request) => url.startsWith(`/${request.kind}`)).map(({ kind, ...request }) => request) }
      }
      assert.equal(method, "PATCH")
      const match = new URL(url, "http://host").pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)\/part\/([^/]+)$/)
      assert.ok(match, "card must use the public Part update endpoint")
      const [sessionID, messageID, partID] = match.slice(1).map(decodeURIComponent)
      const message = this.messages.get(sessionID)?.find((entry) => entry.info.id === messageID)
      const index = message?.parts.findIndex((part) => part.id === partID) ?? -1
      assert.ok(index >= 0, "card cannot create a missing source Part")
      assert.equal(body.sessionID, sessionID)
      assert.equal(body.messageID, messageID)
      assert.equal(body.id, partID)
      this.partUpdates.push(structuredClone(body))
      message.parts[index] = structuredClone(body)
      return { data: structuredClone(body) }
    } }
    this.session = {
      list: async ({ query } = {}) => ({ data: structuredClone([...this.sessions.values()].slice(0, query?.limit)) }),
      get: async ({ path }) => {
        if (!this.sessions.has(path.id)) throw Object.assign(new Error(`Session not found: ${path.id}`), { name: "NotFoundError" })
        return { data: structuredClone(this.sessions.get(path.id)) }
      },
      create: async ({ body }) => ({ data: this.addSession({ id: `child-${this.nextSession++}`, ...body }) }),
      update: async ({ path, body }) => {
        this.updateCalls.push({ sessionID: path.id, body: structuredClone(body) })
        assert.ok(this.sessions.has(path.id), `update of missing Session ${path.id}`)
        const updated = { ...this.sessions.get(path.id), ...structuredClone(body) }
        this.sessions.set(path.id, updated)
        return { data: structuredClone(updated) }
      },
      children: async ({ path }) => ({ data: structuredClone([...this.sessions.values()].filter((session) => session.parentID === path.id)) }),
      status: async () => ({ data: Object.fromEntries([...this.sessions].map(([id, session]) => [id, { type: session.status }])) }),
      messages: async ({ path, query = {}, responseStyle, signal }) => {
        signal?.throwIfAborted()
        const messages = this.messages.get(path.id) ?? []
        const end = query.before === undefined ? messages.length : Number(query.before)
        const start = Math.max(0, end - (query.limit ?? messages.length))
        return {
          data: structuredClone(messages.slice(start, end)),
          ...(responseStyle === "fields" ? { response: { ok: true, headers: new Headers(start ? { "X-Next-Cursor": String(start) } : {}) } } : {}),
        }
      },
      message: async ({ path, signal }) => {
        signal?.throwIfAborted()
        const message = this.messages.get(path.id)?.find((entry) => entry.info.id === path.messageID)
        if (!message) throw Object.assign(new Error("Message not found"), { name: "NotFoundError" })
        return { data: structuredClone(message) }
      },
      promptAsync: async ({ path, body }) => {
        this.promptAsyncCalls.push({ sessionID: path.id, body: structuredClone(body) })
        this.sessions.get(path.id).status = "busy"
        const messages = this.messages.get(path.id) ?? []
        messages.push({ info: { id: body.messageID, sessionID: path.id, role: "user", agent: body.agent }, parts: structuredClone(body.parts) })
        this.messages.set(path.id, messages)
        return { data: undefined }
      },
      prompt: async (args) => {
        this.promptCalls.push(structuredClone(args))
        throw new Error("unexpected model dispatch through session.prompt")
      },
      abort: async ({ path }) => {
        this.abortCalls.push(path.id)
        this.sessions.get(path.id).status = "idle"
        const assistant = this.messages.get(path.id)?.findLast((message) => message.info.role === "assistant")
        if (assistant) assistant.info.error = { name: "MessageAbortedError", data: { message: "host abort" } }
        return { data: true }
      },
    }
  }

  addSession(session) {
    const value = { directory: this.directory, status: "busy", metadata: {}, ...structuredClone(session) }
    this.sessions.set(value.id, value)
    return structuredClone(value)
  }

  save(path) {
    writeFileSync(path, JSON.stringify({ sessions: [...this.sessions], messages: [...this.messages], nextSession: this.nextSession }))
  }
}

async function fixture(t, { buildPermission = {}, shell = "/bin/bash", maxConcurrentCommands = 4, worktreeName = null,
  commandWaitOptions = { runningTimeoutMs: 1000 }, commandLogOptions = {}, generalConfig } = {}) {
  const root = mkdtempSync("/tmp/opencode/o4e-plugin-command-")
  const directory = join(root, "project")
  const outside = join(root, "outside")
  mkdirSync(directory)
  mkdirSync(outside)
  const activeWorktree = worktreeName ? join(root, worktreeName) : directory
  if (activeWorktree !== directory) mkdirSync(activeWorktree)
  let hooks
  let locks
  let scheduler
  const facades = new Set()
  const controllers = []
  const inflight = new Set()
  const f = { root, directory, outside, asks: [], metadataUpdates: [] }
  t.after(async () => {
    let cleanupError
    try {
      locks?.clear()
      const disposed = await bounded(Promise.allSettled([...facades].map((facade) => facade.dispose())), 15000)
      const failed = disposed.find((result) => result.status === "rejected")
      if (failed) throw failed.reason
    } catch (error) { cleanupError = error }
    finally {
      scheduler?.dispose()
      for (const controller of controllers) controller.abort(new Error("fixture cleanup"))
      const leaked = liveProcesses(root)
      // Emergency cleanup fails the test; it is not accepted as plugin stop evidence.
      for (const { pid, start } of leaked) {
        if (!liveProcesses(root).some((current) => current.pid === pid && current.start === start)) continue
        try { process.kill(pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      }
      await until(() => liveProcesses(root).length === 0)
      await bounded(Promise.allSettled([...inflight]), 15000)
      rmSync(root, { recursive: true, force: true })
      assert.deepEqual(leaked, [], "plugin disposal leaked live fixture processes")
    }
    if (cleanupError) throw cleanupError
  })

  const configRoot = copyInstalledDefaults(componentRoot, directory)
  const configPath = join(configRoot, "config.jsonc")
  const config = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")))
  config.nativeAgents = { build: "keep", plan: "keep", general: "managed", explore: "managed" }
  config.backgroundTasks.maxConcurrentCommands = maxConcurrentCommands
  config.soul.enabled = false
  writeFileSync(configPath, JSON.stringify(config))
  if (generalConfig) {
    const path = join(configRoot, "agents", "subagent", "general.jsonc")
    writeFileSync(path, JSON.stringify({ ...JSON.parse(stripJsonComments(readFileSync(path, "utf8"))), ...generalConfig }))
  }
  for (const name of ["build", "plan"]) rmSync(join(configRoot, "agents", "primary", `${name}.jsonc`))
  f.hostConfig = {
    shell, default_agent: "build", permission: { bash: "ask", external_directory: "ask" },
    agent: {
      build: {
        mode: "primary", model: "host/build", prompt: "native build prompt", tools: { bash: true },
        permission: {
          bash: { "*": "ask", "printf OK": "allow", "sleep *": "allow", "cat *": "allow", "touch *": "allow", "rm *": "deny" },
          external_directory: "ask", o4e_task: { "*": "deny", "command:*": "allow" }, ...buildPermission,
        },
      },
      plan: {
        mode: "primary", model: "host/plan", prompt: "native plan prompt", tools: { bash: true },
        permission: { bash: { "*": "deny", "printf OK": "allow", "cat *": "allow" }, edit: "deny", external_directory: "ask", o4e_task: { "*": "deny", "command:*": "allow" } },
      },
    },
  }
  f.nativeDefinitions = { build: f.hostConfig.agent.build, plan: f.hostConfig.agent.plan }
  f.nativeValues = structuredClone(f.nativeDefinitions)
  f.client = new HookClient(directory)
  for (const [id, agent] of [["native", "build"], ["other", "build"], ["plan", "plan"], ["parent", "orchestrator"]]) f.client.addSession({ id, agent })
  f.facade = async () => {
    const facade = await OpenCodeForEverythingPlugin({ client: f.client, directory, worktree: activeWorktree,
      commandWaitOptions, commandLogOptions: { logRoot: join(root, "logs"), ...commandLogOptions } })
    facades.add(facade)
    await facade.config(f.hostConfig)
    return facade
  }
  hooks = await f.facade()
  f.hooks = hooks
  locks = createSharedScopeLockManager(directory)
  f.locks = locks
  scheduler = createSharedBackgroundTaskScheduler(directory, { maxConcurrentCommands })
  f.active = (taskID) => {
    assert.equal(locks.has(taskID), false, "Command must never own a Scope Lock")
    return scheduler.isActive({ taskID, kind: "command", ownerSessionID: "native" })
  }
  let nextCall = 0
  f.context = ({ sessionID = "native", agent = f.client.sessions.get(sessionID)?.agent, controller, approvals = [], ...extra } = {}) => {
    controller ??= new AbortController()
    controllers.push(controller)
    const id = ++nextCall
    return {
      sessionID, messageID: `assistant-${id}`, callID: `call-${id}`, agent, directory, worktree: activeWorktree,
      abort: controller.signal,
      metadata: (value) => Effect.sync(() => {
        f.metadataUpdates.push(structuredClone(value))
        const part = f.client.messages.get(sessionID)?.find((message) => message.info.id === `assistant-${id}`)?.parts.find((entry) => entry.callID === `call-${id}`)
        if (part?.state?.status === "running") part.state = { ...part.state, title: value.title, metadata: structuredClone(value.metadata) }
      }),
      ask: async (request) => {
        assert.ok(Array.isArray(request.patterns) && request.patterns.length, "host ask must authorize concrete resources")
        const rules = [compilePermissionRules(f.hostConfig.permission), compilePermissionRules(f.hostConfig.agent[agent]?.permission), f.client.sessions.get(sessionID)?.permission ?? []]
        const action = evaluateResources(request.permission, request.patterns, ...rules)
        f.asks.push({ sessionID, agent, ...structuredClone(request), action })
        if (action === "deny") throw new Error(`HOST_PERMISSION_DENIED: ${request.permission} ${JSON.stringify(request.patterns)}`)
        if (action === "ask" && request.patterns.some((pattern) => evaluateResources(request.permission, [pattern], ...rules) === "ask"
          && !approvals.includes(`${request.permission}:${pattern}`))) {
          throw new Error(`HOST_ASK_REJECTED: ${request.permission} ${JSON.stringify(request.patterns)}`)
        }
      },
      ...extra,
    }
  }
  f.invoke = (tool, args, context = f.context(), facade = hooks) => {
    const operation = (async () => {
      assert.equal(f.client.sessions.get(context.sessionID)?.agent, context.agent, "host Session and caller Agent must match")
      const messages = f.client.messages.get(context.sessionID) ?? []
      f.client.messages.set(context.sessionID, messages)
      let message = messages.find((entry) => entry.info.id === context.messageID)
      if (!message) {
        message = { info: { id: context.messageID, sessionID: context.sessionID, agent: context.agent, role: "assistant", parentID: messages.findLast((entry) => entry.info.role === "user")?.info.id }, parts: [] }
        messages.push(message)
      }
      let part = message.parts.find((entry) => entry.callID === context.callID)
      if (!part) {
        part = { id: `part-${context.callID}`, sessionID: context.sessionID, messageID: context.messageID, type: "tool", tool, callID: context.callID }
        message.parts.push(part)
      }
      const startedAt = Date.now()
      part.state = { status: "running", input: structuredClone(args), time: { start: startedAt } }
      try {
        await facade["tool.execute.before"]({ tool, sessionID: context.sessionID, callID: context.callID }, { args })
        const result = await facade.tool[tool].execute(args, context)
        part.state = { status: "completed", input: structuredClone(args), output: typeof result === "string" ? result : result.output,
          time: { start: startedAt, end: Date.now() },
          ...(typeof result === "string" ? {} : { title: result.title, metadata: structuredClone(result.metadata) }) }
        const projection = { messages: [{ info: { role: "assistant" }, parts: [structuredClone(part)] }] }
        await facade["experimental.chat.messages.transform"]({}, projection)
        return typeof result === "string" ? result : { ...result, output: projection.messages[0].parts[0].state.output }
      } catch (error) {
        part.state = { status: "error", input: structuredClone(args), error: error.message }
        throw error
      }
    })()
    inflight.add(operation)
    operation.then(() => inflight.delete(operation), () => inflight.delete(operation))
    return operation
  }
  f.json = async (tool, args, context, facade) => {
    const result = await bounded(f.invoke(tool, args, context, facade))
    assert.equal(typeof result, "object", `${tool} must return a tool result object`)
    assert.equal(typeof result.output, "string")
    assert.ok(Buffer.byteLength(result.output) < 50 * 1024, "readable tool output must stay below 50 KiB")
    const structured = result.metadata?.o4eResult
    if (!structured) return JSON.parse(result.output)
    if (tool === "bash" && structured.output === undefined && typeof result.metadata?.output === "string") {
      return { ...structured, output: result.metadata.output.replace(/^\[[^\n]+\]\n?/, "") }
    }
    return structured
  }
  f.bash = (command, context, extra = {}) => f.json("bash", { command, description: "command integration fixture", timeout: 5000, ...extra }, context)
  f.read = (taskID, action = "status", context, extra = {}) => f.json("o4e_task", { action, taskID, ...extra }, context)
  f.refs = (owner = "native") => f.client.sessions.get(owner)?.metadata?.o4e?.commandTasks?.refs ?? {}
  f.record = (taskID, owner = "native") => f.refs(owner)[taskID]?.recovery
  f.running = (owner = "native") => Object.values(f.refs(owner)).find((ref) => ref.recovery.status === "running")?.recovery
  f.noDispatch = () => {
    assert.equal(f.client.promptCalls.length, 0)
    assert.equal(f.client.promptAsyncCalls.length, 0)
  }
  f.general = async () => {
    const created = await f.json("task", { description: "managed general fixture", prompt: "Perform the bounded command fixture", subagent_type: "general" }, f.context({ sessionID: "parent" }))
    await until(() => f.client.sessions.get(created.sessionID)?.metadata?.o4e?.task?.status === "running"
      && f.client.promptAsyncCalls.some((call) => call.sessionID === created.sessionID))
    const child = f.client.sessions.get(created.sessionID)
    assert.equal(child.metadata.o4e.task.kind, "agent")
    assert.equal(child.metadata.o4e.delegation.effect, "unknown-write")
    assert.equal(f.locks.has(`background-task:${created.taskID}`), true, "real Agent Task must already own its unknown-write lock")
    assert.deepEqual(child.permission, child.metadata.o4e.delegation.compiledPermission)
    return created
  }
  f.reload = async () => {
    await bounded(hooks.dispose(), 15000)
    const path = join(root, "host-state.json")
    f.client.save(path)
    f.client = new HookClient(directory, JSON.parse(readFileSync(path, "utf8")))
    hooks = await f.facade()
    f.hooks = hooks
  }
  return f
}

test("Agent/Command cancel expose no reason and use the same minimal public call", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { timeoutMs: 20, runningTimeoutMs: 100 } })
  assert.equal(Object.hasOwn(f.hooks.tool.o4e_task.args, "reason"), false)
  const agent = await f.general()
  const command = await f.bash("sleep 5; touch must-not-run.txt")
  assert.equal(command.status, "running")
  const aborts = f.client.abortCalls.length
  const asks = f.asks.length
  for (const [taskID, sessionID] of [[agent.taskID, "parent"], [command.taskID, "native"]]) {
    await assert.rejects(f.hooks.tool.o4e_task.execute({ action: "cancel", taskID, reason: "private-reason" }, f.context({ sessionID })), (error) => {
      assert.match(error.message, /O4E_TASK_INVALID_ARGUMENTS: reason is not supported/)
      assert.doesNotMatch(error.message, /private-reason/)
      return true
    })
  }
  assert.equal(f.client.abortCalls.length, aborts)
  assert.equal(f.asks.length, asks)
  assert.equal((await f.read(command.taskID, "cancel")).status, "cancelled")
  await f.read(agent.taskID, "cancel", f.context({ sessionID: "parent" }))
  await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: agent.sessionID } } })
  assert.equal(f.client.sessions.get(agent.sessionID).metadata.o4e.task.status, "cancelled")
  assert.equal(existsSync(join(f.directory, "must-not-run.txt")), false)
})

test("native keep preserves build/plan config identity and host Plan denies writes", options, async (t) => {
  const f = await fixture(t)
  await f.hooks.config(f.hostConfig)
  for (const name of ["build", "plan"]) {
    assert.equal(f.hostConfig.agent[name], f.nativeDefinitions[name])
    assert.deepEqual(f.hostConfig.agent[name], f.nativeValues[name])
  }
  const context = f.context({ sessionID: "plan" })
  await assert.rejects(f.bash("touch forbidden.txt", context), /HOST_PERMISSION_DENIED: bash/)
  assert.equal(existsSync(join(f.directory, "forbidden.txt")), false)
  assert.deepEqual(f.refs("plan"), {})
  const result = await f.bash("printf OK", f.context({ sessionID: "plan" }))
  assert.equal(result.output, "OK")
  assert.equal(result.status, "completed")
  f.noDispatch()
})

test("Bash cwd handles omitted, relative, explicit and nullable workdir without inheritance", options, async (t) => {
  const f = await fixture(t, { worktreeName: "worktree" })
  mkdirSync(join(f.directory, "nested"))
  const omitted = await f.bash("pwd", f.context({ approvals: ["bash:pwd"] }))
  const relative = await f.bash("pwd", f.context({ approvals: ["bash:pwd"] }), { workdir: "nested" })
  const nullable = await f.bash("pwd", f.context({ approvals: ["bash:pwd"] }), { workdir: null })
  assert.equal((await f.read(omitted.taskID, "output")).output.trim(), f.directory)
  assert.equal((await f.read(relative.taskID, "output")).output.trim(), join(f.directory, "nested"))
  assert.equal((await f.read(nullable.taskID, "output")).output.trim(), f.directory)
  assert.equal(f.record(omitted.taskID).cwd, f.directory)
  assert.equal(f.record(relative.taskID).cwd, join(f.directory, "nested"))
  assert.equal(f.record(nullable.taskID).cwd, f.directory)
  f.noDispatch()
})

test("Bash executes scripts, nested quoting and ordinary shell syntax unchanged", options, async (t) => {
  const f = await fixture(t, { buildPermission: { bash: "allow" } })
  writeFileSync(join(f.directory, "script.sh"), 'printf "%s\\n" "$*"\n')
  const script = "bash script.sh plan --types mcp --hosts opencode,codex --json"
  const nested = `node -e 'require("node:child_process").execFileSync(process.execPath,["-e","process.stdout.write(\\"嵌套\\")"],{stdio:"inherit"})'`
  const shell = `VALUE=中文; f() { for x in "$VALUE"; do printf '%s\\n' "$x"; done; }; f; cat <<'EOF'
* ? \\ end
EOF`
  for (const [command, expected] of [
    [script, "plan --types mcp --hosts opencode,codex --json\n"],
    [nested, "嵌套"],
    [shell, "中文\n* ? \\ end\n"],
  ]) {
    const result = await f.invoke("bash", { command, description: "native shell syntax", timeout: 5000 }, f.context())
    assert.equal(result.metadata.o4eResult.status, "completed", result.output)
    assert.equal(result.output, expected)
    assert.equal(result.metadata.output, expected)
  }
  const invalid = await f.invoke("bash", { command: "if then", description: "Bash syntax error" }, f.context())
  assert.equal(invalid.metadata.o4eResult.exitCode, 2)
  assert.match(invalid.output, /syntax error/)
  const pathError = await f.invoke("bash", { command: "cat /dev/null/child 2>&1; printf OK", description: "Bash handles invalid file operands" },
    f.context({ approvals: ["external_directory:/dev/null/*"] }))
  assert.equal(pathError.metadata.o4eResult.exitCode, 0)
  assert.match(pathError.output, /Not a directory/)
  assert.ok(pathError.output.endsWith("OK"))
  f.noDispatch()
})

test("Bash rejects an unapproved directory mismatch before command creation", options, async (t) => {
  const f = await fixture(t, { worktreeName: "worktree" })
  await assert.rejects(
    f.bash("pwd", f.context({ directory: f.outside })),
    /Bash authority unverifiable: directory mismatch/,
  )
  assert.deepEqual(f.refs(), {})
  f.noDispatch()
})

test("native Bash card persists readable output while command JSON remains machine-readable", options, async (t) => {
  const f = await fixture(t)
  const context = f.context({ metadata: () => { throw new Error("unexpected UI callback") } })
  const result = await f.invoke("bash", { command: "printf OK", description: "visible output", timeout: 5000 }, context)
  const snapshot = result.metadata.o4eResult
  const part = f.client.messages.get(context.sessionID).find((message) => message.info.id === context.messageID).parts[0]
  assert.equal(part.state.status, "completed")
  // OpenCode 1.18.29 Shell reads completed state.metadata.output, not state.output.
  assert.equal(part.state.metadata.output, "OK")
  assert.equal(part.state.metadata.taskID, snapshot.taskID)
  assert.equal(part.state.metadata.status, "completed")
  assert.equal(part.state.output, result.output)
  assert.equal(part.state.output, "OK")
  assert.equal(part.state.title, result.title)
  assert.equal(snapshot.output, "OK")
  assert.equal(snapshot.exitCode, 0)
  const read = await f.invoke("o4e_task", { action: "output", taskID: snapshot.taskID })
  assert.equal(read.output, "OK")
  assert.equal(read.metadata.o4eResult.output, "OK")
  assert.equal(Object.hasOwn(read.metadata, "output"), false, "generic tool uses state.output, not Shell metadata")
  assert.deepEqual(f.metadataUpdates, [], "final display must not wait on a separate metadata callback")
  f.noDispatch()
})

test("terminal Bash returns exact empty, whitespace and nonzero text without Task wrapping", options, async (t) => {
  const f = await fixture(t)
  writeFileSync(join(f.directory, "whitespace.txt"), "  \n\t\n")
  for (const [command, expected, status] of [
    ["true", "", "completed"],
    ["cat whitespace.txt", "  \n\t\n", "completed"],
    ["printf partial; false", "partial", "failed"],
  ]) {
    const result = await f.invoke("bash", { command, description: "exact terminal text", timeout: 5000 },
      f.context({ approvals: [`bash:${command}`, "bash:printf partial", "bash:false"] }))
    assert.equal(result.metadata.o4eResult.status, status)
    assert.doesNotMatch(result.output, /^Task /)
    if (status === "completed") assert.equal(result.output, expected)
    else assert.equal(result.output, `[O4E command failed; exit=1; reason=nonzero-exit]\n\n${expected}`)
    const read = await f.invoke("o4e_task", { action: "output", taskID: result.metadata.o4eResult.taskID }, f.context())
    assert.equal(read.output, expected, "output returns captured body without execution state")
  }
})

test("Bash model text is independent of escaped metadata size and keeps failure controls before long output", options, async (t) => {
  const f = await fixture(t)
  const text = '  "\\\t'.repeat(5000) + "\n\n"
  writeFileSync(join(f.directory, "escaped.txt"), text)
  const exact = await f.invoke("bash", { command: "cat escaped.txt", description: "escaped text" }, f.context())
  assert.equal(exact.output, text)
  assert.equal(exact.metadata.o4eResult.truncated, true, "only the metadata copy needed reduction")
  const read = await f.invoke("o4e_task", { action: "output", taskID: exact.metadata.o4eResult.taskID }, f.context())
  assert.equal(read.output, text, "metadata reduction must not shorten an explicit output read")
  const lines = "line\n".repeat(3000)
  writeFileSync(join(f.directory, "lines.txt"), lines)
  const failed = await f.invoke("bash", { command: "cat lines.txt; false", description: "long failed text" },
    f.context({ approvals: ["bash:cat lines.txt; false", "bash:false"] }))
  assert.match(failed.output, /^\[O4E command failed; exit=1; reason=nonzero-exit\]\n\[O4E output preview-truncated; log=/)
  assert.ok(failed.output.split("\n").length < 2000)
  assert.ok(Buffer.byteLength(failed.output) < 50 * 1024)
  assert.equal(readFileSync(failed.metadata.o4eResult.logPath, "utf8"), lines)
  const retained = await f.invoke("o4e_task", { action: "output", taskID: failed.metadata.o4eResult.taskID }, f.context())
  assert.match(retained.output, /^\[O4E output preview-truncated; log=/)
  assert.doesNotMatch(retained.output, /O4E command|exit=1/)
  assert.ok(retained.output.endsWith("line\n"))
})

test("command inspect resumes intact running and failed previews but rejects rewritten output", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 }, buildPermission: { bash: "allow" } })
  const command = "printf FIRST; while [ ! -e release ]; do sleep 0.01; done; printf NEXT; exit 7"
  const running = await f.bash(command)
  assert.equal(running.status, "running")
  const taskID = running.taskID
  const first = await f.read(taskID, "inspect")
  assert.equal(first.tail, "FIRST")
  assert.equal((await f.read(taskID, "inspect", undefined, { resume: true })).unchanged, true)
  const messages = f.client.messages.get("native")
  const prior = messages.at(-1).parts[0]
  assert.equal(prior.state.metadata.kind, "command")
  prior.state.output = "Inspection summarized."
  const damaged = await f.read(taskID, "inspect", undefined, { resume: true })
  assert.equal(damaged.unavailable, "resume-preview-unavailable")
  assert.equal(damaged.tail, undefined)
  assert.equal((await f.read(taskID, "inspect", undefined, { resume: false })).tail, "FIRST")
  writeFileSync(join(f.directory, "release"), "")
  await until(() => f.record(taskID)?.status === "failed")
  const appended = await f.read(taskID, "inspect", undefined, { resume: true })
  assert.equal(appended.status, "failed")
  assert.equal(appended.tail, "NEXT")
  assert.equal((await f.read(taskID, "inspect", undefined, { resume: true })).unchanged, true)
})

test("detached Bash ignores its completed reader abort while fresh tail grows until terminal settlement", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
  const controller = new AbortController()
  const command = "printf FIRST; sleep 0.4; printf SECOND; sleep 0.4; printf END"
  const result = await f.invoke("bash", { command, description: "growing tail", timeout: 5000 },
    f.context({ controller, approvals: [`bash:${command}`, "bash:printf FIRST", "bash:printf SECOND", "bash:printf END"] }))
  const taskID = result.metadata.o4eResult.taskID
  assert.equal(result.metadata.output, "FIRST", "native card contains captured text without command status")
  assert.ok(result.output.includes(taskID), "the model still receives the background handle")
  assert.equal(result.metadata.o4eResult.status, "running")
  assert.match(result.output, new RegExp(`O4E command running; taskID=${taskID}`))
  assert.equal(result.output.includes("FIRST"), false, "detached model response contains only the task handle and controls")
  controller.abort(new Error("finished Bash reader"))
  const first = await f.read(taskID, "inspect", undefined, { maxBytes: 8192 })
  assert.equal(first.status, "running")
  assert.equal(first.tail, "FIRST")
  let next
  await until(async () => {
    next = await f.read(taskID, "inspect", undefined, { maxBytes: 8192 })
    return next.tail.includes("SECOND")
  })
  assert.equal(next.status, "running")
  assert.equal(next.tail, "FIRSTSECOND")
  assert.ok(liveProcesses(f.root).length > 0)
  assert.equal(f.active(taskID), true)
  const watched = await f.read(taskID, "watch", undefined, { timeoutMs: 1500 })
  assert.equal(watched.tasks[0].status, "completed")
  assert.equal(watched.tasks[0].exitCode, 0)
  assert.equal(watched.tasks[0].logComplete, true)
  assert.equal((await f.invoke("o4e_task", { action: "output", taskID }, f.context())).output, "FIRSTSECONDEND")
})

test("empty detached Bash keeps the native card empty and its task manageable", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 20 } })
  const result = await f.invoke("bash", { command: "sleep 0.2", description: "empty background command" }, f.context())
  const taskID = result.metadata.o4eResult.taskID
  assert.equal(result.metadata.o4eResult.status, "running")
  assert.equal(result.metadata.output, "")
  assert.ok(result.output.includes(taskID))
  assert.ok(f.metadataUpdates.every((update) => update.metadata.output === ""))
  const watched = await f.read(taskID, "watch", undefined, { timeoutMs: 1000 })
  assert.equal(watched.tasks[0].status, "completed")
  assert.equal((await f.invoke("o4e_task", { action: "output", taskID }, f.context())).output, "")
})

test("background log finalization failure is model-visible through every output reader", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 },
    commandLogOptions: { logIO: { fsyncSync() { throw Object.assign(new Error("disk failure"), { code: "ENOSPC" }) } } } })
  const command = "sleep 0.2; printf OK"
  const running = await f.bash(command, f.context({ approvals: [`bash:${command}`] }))
  assert.equal(running.status, "running")
  for (const action of ["watch", "inspect", "output", "status"]) {
    const result = await f.invoke("o4e_task", { action, taskID: running.taskID,
      ...(action === "watch" ? { timeoutMs: 1000 } : {}) }, f.context())
    assert.match(result.output, action === "watch" ? /Log incomplete: ENOSPC/ : /complete=no; error=ENOSPC/)
    if (["watch", "status"].includes(action)) assert.equal(result.output.includes("OK"), false)
    else assert.match(result.output, /OK/)
    if (action === "output") {
      assert.match(result.output, /^\[O4E output /)
      assert.ok(result.output.endsWith("OK"))
    }
  }
  assert.equal(f.record(running.taskID).result.logComplete, false)
  assert.equal(f.active(running.taskID), false, "log failure does not erase verified process stop")
})

test("Bash terminal owner persistence failure exposes diagnostic and retains the command slot", options, async (t) => {
  const f = await fixture(t)
  const update = f.client.session.update
  f.client.session.update = async (args) => {
    const o4e = args.body.metadata?.o4e
    const terminalWrite = Object.values(o4e?.commandTasks?.refs ?? {}).some((ref) => ref.recovery.status === "completed")
    if (terminalWrite) throw new Error("terminal store unavailable")
    return update(args)
  }
  try {
    const result = await f.invoke("bash", { command: "printf OK", description: "failed settlement" }, f.context())
    const snapshot = result.metadata.o4eResult
    assert.equal(snapshot.status, "running")
    assert.match(result.output, /diagnostic=O4E_COMMAND_SETTLEMENT_FAILED/)
    assert.match(result.output, /exit=0/)
    assert.equal(result.output.includes("OK"), false)
    assert.equal(result.metadata.output, "OK", "the native Shell card retains captured text")
    assert.equal(f.active(snapshot.taskID), true)
    assert.deepEqual(liveProcesses(f.root), [])
  } finally { f.client.session.update = update }
})

test("command watch and status show state while every output call returns exact captured text", options, async (t) => {
  const f = await fixture(t)
  const text = "  \nWatch · captured text\nTask captured text\n\t"
  writeFileSync(join(f.directory, "body.txt"), text)
  const first = await f.bash("cat body.txt")
  for (const action of ["watch", "status"]) {
    const state = await f.invoke("o4e_task", { action, taskID: first.taskID,
      ...(action === "watch" ? { timeoutMs: 1 } : {}) }, f.context())
    assert.match(state.output, /completed/)
    assert.equal(state.output.includes("captured text"), false)
  }
  for (let index = 0; index < 2; index++) {
    const read = await f.invoke("o4e_task", { action: "output", taskID: first.taskID }, f.context())
    assert.equal(read.output, text)
    assert.equal(read.metadata.o4eResult.output, text)
  }
  f.noDispatch()
})

test("native Bash card streams running output to terminal settlement", options, async (t) => {
  const f = await fixture(t)
  const command = "printf EARLY; sleep 0.4; printf LATE"
  const result = await f.invoke("bash", { command, description: "visible state", timeout: 5000 },
    f.context({ approvals: [`bash:${command}`, "bash:printf EARLY", "bash:printf LATE"] }))
  const snapshot = result.metadata.o4eResult
  assert.equal(snapshot.status, "completed")
  assert.ok(f.metadataUpdates.some((update) => update.metadata.output === "EARLY"))
  assert.equal(snapshot.output, "EARLYLATE")
  assert.equal(result.metadata.output, "EARLYLATE")
  f.noDispatch()
})

test("detached Bash updates the original completed Shell card with full capture while model text remains frozen", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
  const first = `HEAD\n${"甲".repeat(30000)}\nFIRST\n`
  const second = `${"乙".repeat(30000)}\nSECOND\n`
  writeFileSync(join(f.directory, "first.txt"), first)
  writeFileSync(join(f.directory, "second.txt"), second)
  const command = "cat first.txt; sleep 0.5; cat second.txt; sleep 0.6; printf END"
  const controller = new AbortController()
  const context = f.context({ controller, approvals: [`bash:${command}`, "bash:printf END"] })
  const result = await f.invoke("bash", { command, description: "full background card", timeout: 5000 }, context)
  const source = () => f.client.messages.get(context.sessionID).find((message) => message.info.id === context.messageID).parts[0]
  const original = structuredClone(source())
  assert.equal(result.metadata.o4eResult.status, "running")
  assert.equal(result.metadata.output, first)
  assert.equal(source().state.status, "completed")
  controller.abort(new Error("the Bash reader has already returned"))
  await until(() => source().state.metadata.output === first + second)
  assert.equal(f.record(result.metadata.taskID).status, "running")
  assert.ok(f.client.partUpdates.length > 0, "background capture must reach the public Part update API")
  const terminal = await f.read(result.metadata.taskID, "watch", undefined, { timeoutMs: 2000 })
  assert.equal(terminal.tasks[0].status, "completed")
  await until(() => source().state.metadata.output === first + second + "END")
  assert.equal(readFileSync((await f.read(result.metadata.taskID)).logPath, "utf8"), source().state.metadata.output)
  for (const part of f.client.partUpdates) {
    const unchanged = structuredClone(part)
    unchanged.state.metadata.output = original.state.metadata.output
    assert.deepEqual(unchanged, original, "UI updates must preserve model text, input, status, end time and structured result")
  }
  assert.equal(result.output.includes("FIRST"), false)
  assert.equal(source().state.output, result.output)
  f.noDispatch()
})

test("short Bash returns an empty Shell card without waiting for separate metadata publication", options, async (t) => {
  const f = await fixture(t)
  const context = f.context({ metadata: () => new Promise(() => {}) })
  const result = await bounded(f.invoke("bash", { command: "sleep 0.01", description: "short empty card", timeout: 5000 }, context), 1000)
  const part = f.client.messages.get(context.sessionID).find((message) => message.info.id === context.messageID).parts[0]
  assert.equal(part.state.status, "completed")
  assert.equal(part.state.metadata.status, "completed")
  assert.equal(part.state.metadata.output, "")
  assert.equal(result.output, "")
})

test("native Bash card retains full captured UTF-8 while model text reports its independent truncation", options, async (t) => {
  const f = await fixture(t)
  for (const text of ["\u4e2d\u6587\n".repeat(40000), "\u0000\n\t\"\\".repeat(40000)]) {
    writeFileSync(join(f.directory, "visible.txt"), text)
    const result = await f.invoke("bash", { command: "cat visible.txt", description: "large visible output", timeout: 5000 }, f.context())
    const snapshot = result.metadata.o4eResult
    assert.equal(snapshot.truncated, true)
    assert.equal(typeof result.metadata.output, "string")
    assert.equal(result.metadata.output, text)
    assert.match(result.output, /O4E output preview-truncated/)
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 20 * 1024)
    assert.doesNotMatch(result.metadata.output, /\uFFFD/)
  }
  f.noDispatch()
})

test("aborting watch/inspect readers does not cancel the original Bash command", options, async (t) => {
  const f = await fixture(t)
  const running = f.bash("sleep 2")
  await until(() => f.running()?.status === "running")
  const taskID = f.running().taskID
  const controller = new AbortController()
  const context = f.context({ controller })
  const rejected = assert.rejects(f.read(taskID, "watch", context, { timeoutMs: 2500 }), /reader-only/)
  await until(() => f.asks.some((ask) => ask.patterns.includes("command:watch")))
  await delay(20)
  controller.abort(new Error("reader-only"))
  await bounded(rejected, 1000)
  await assert.rejects(f.read(taskID, "inspect", f.context({ controller })), /reader-only/)
  assert.equal((await f.read(taskID)).status, "running")
  assert.ok(liveProcesses(f.root).length > 0)
  assert.equal(f.client.abortCalls.length, 0)
  assert.equal((await f.read(taskID, "watch", undefined, { timeoutMs: 2500 })).tasks[0].status, "completed")
  assert.ok(["running", "completed"].includes((await running).status))
  f.noDispatch()
})

test("same-owner duplicate calls and persisted reload append the file probe only once", options, async (t) => {
  const f = await fixture(t)
  const command = "printf OK >> once.txt"
  const sessionsBefore = [...f.client.sessions.keys()]
  const context = f.context({ approvals: [`bash:${command}`] })
  // Literal redirection is parser-supported; file bytes prove execution count.
  const results = await Promise.all([f.bash(command, context), f.bash(command, context), f.bash(command, context)])
  assert.equal(new Set(results.map((result) => result.taskID)).size, 1)
  assert.equal(readFileSync(join(f.directory, "once.txt"), "utf8"), "OK")
  assert.equal(Object.keys(f.refs()).length, 1)
  assert.deepEqual([...f.client.sessions.keys()], sessionsBefore)
  assert.equal(f.refs()[results[0].taskID].taskSessionID, "native")
  assert.equal(f.client.sessions.get("native").metadata.o4e.task, undefined)
  const first = results[0]
  await f.reload()
  const replay = await f.bash(command, context)
  assert.equal(replay.taskID, first.taskID)
  assert.equal(replay.status, "completed")
  assert.equal(readFileSync(join(f.directory, "once.txt"), "utf8"), "OK")
  await assert.rejects(f.bash("touch duplicate.txt", context), /O4E_COMMAND_CALL_MISMATCH/)
  assert.equal(existsSync(join(f.directory, "duplicate.txt")), false)
  assert.equal(Object.keys(f.refs()).length, 1)
  f.noDispatch()
})

test("cross-owner command reads and cancellation reject", options, async (t) => {
  const f = await fixture(t)
  const result = await f.bash("printf OK")
  for (const action of ["status", "cancel"]) {
    await assert.rejects(f.read(result.taskID, action, f.context({ sessionID: "other" })), /O4E_COMMAND_NOT_OWNED/)
  }
  f.client.sessions.get("native").permission = [{ permission: "o4e_task", pattern: "command:output", action: "deny" }]
  await assert.rejects(f.read(result.taskID, "output"), /HOST_PERMISSION_DENIED: o4e_task/)
  assert.equal(f.record(result.taskID).status, "completed")
  assert.deepEqual(f.refs("other"), {})
  f.noDispatch()
})

test("native owner watches its command collection while cross-owner and Agent selectors remain denied", options, async (t) => {
  const f = await fixture(t)
  const first = await f.bash("printf OK")
  const second = await f.bash("printf OK")
  const taskIDs = [first.taskID, second.taskID]
  const watched = await f.invoke("o4e_task", { action: "watch", taskIDs, timeoutMs: 1 }, f.context())
  assert.deepEqual(watched.metadata.o4eResult.tasks.map((task) => task.taskID).sort(), [...taskIDs].sort())
  assert.ok(watched.metadata.o4eResult.tasks.every((task) => task.status === "completed"))
  assert.equal(watched.output.includes("OK"), false)
  await assert.rejects(f.invoke("o4e_task", { action: "watch", taskIDs, timeoutMs: 1 }, f.context({ sessionID: "other" })), /O4E_COMMAND_NOT_OWNED/)
  await assert.rejects(f.invoke("o4e_task", { action: "watch", taskIDs: [first.taskID, "o4e_task_not_owned"], timeoutMs: 1 }, f.context()), /O4E_TASK_MANAGEMENT_DENIED/)
  f.noDispatch()
})

test("watch requests only the permissions represented by its frozen selection", options, async (t) => {
  const f = await fixture(t)
  const command = await f.bash("printf WATCH", f.context({ approvals: ["bash:printf WATCH"] }))
  const before = f.asks.length
  const watched = await f.invoke("o4e_task", { action: "watch", timeoutMs: 1 }, f.context())
  assert.equal(watched.metadata.o4eResult.tasks[0].taskID, command.taskID)
  const watchAsks = f.asks.slice(before)
  assert.deepEqual(watchAsks.map((ask) => ask.patterns), [["command:watch"]])

  const emptyBefore = f.asks.length
  const empty = await f.invoke("o4e_task", { action: "watch", taskIDs: [], timeoutMs: 1 }, f.context())
  assert.equal(empty.metadata.o4eResult.reason, "empty")
  assert.equal(f.asks.length, emptyBefore, "an explicit empty selection must not ask for either kind")

  const otherBefore = f.asks.length
  const other = await f.invoke("o4e_task", { action: "watch", timeoutMs: 1 }, f.context({ sessionID: "other" }))
  assert.equal(other.metadata.o4eResult.reason, "empty")
  assert.equal(f.asks.length, otherBefore, "an owner with no tasks must not ask for unrelated permissions")
})

test("mixed default watch asks independently for Agent and Command lanes", options, async (t) => {
  const f = await fixture(t)
  const agent = await f.general()
  const command = await f.bash("printf MIXED", f.context({ sessionID: "parent", approvals: ["bash:printf MIXED"] }))
  const before = f.asks.length
  const watched = await f.invoke("o4e_task", { action: "watch", timeoutMs: 1 }, f.context({ sessionID: "parent" }))
  assert.deepEqual(new Set(watched.metadata.o4eResult.tasks.map((task) => task.taskID)), new Set([agent.taskID, command.taskID]))
  assert.deepEqual(f.asks.slice(before).map((ask) => ask.patterns).sort((a, b) => a[0].localeCompare(b[0])), [["agent:watch"], ["command:watch"]])
})

test("an explicit Agent watch never gets silently dropped when the caller lacks Agent authority", options, async (t) => {
  const f = await fixture(t)
  const created = await f.general()
  f.client.sessions.get("parent").agent = "build"
  const context = f.context({ sessionID: "parent" })
  await assert.rejects(
    f.invoke("o4e_task", { action: "watch", taskIDs: [created.taskID], timeoutMs: 1 }, context),
    /O4E_TASK_MANAGEMENT_DENIED/,
  )
  assert.ok(f.client.promptAsyncCalls.length > 0)
})

test("native keep cannot manage an Agent Task after the owner switches from orchestrator", options, async (t) => {
  const f = await fixture(t)
  const created = await f.general()
  // A real selector change retains Session ownership, but not managed-Agent authority.
  f.client.sessions.get("parent").agent = "build"
  const context = f.context({ sessionID: "parent" })
  assert.equal(evaluateResources("o4e_task", ["status"], compilePermissionRules(f.hostConfig.agent.build.permission)), "deny")
  await assert.rejects(f.invoke("o4e_task", { action: "status", taskID: created.taskID }, context), /denied|拒绝|未找到发起 Agent|无权/i,
    "native keep must not gain Agent Task management merely by retaining the owner Session")
  assert.equal(f.client.sessions.get(created.sessionID).metadata.o4e.task.status, "running")
})

test("managed general retains its Agent authority but Bash does not borrow its Task lock", options, async (t) => {
  const f = await fixture(t)
  const created = await f.general()
  const child = f.client.sessions.get(created.sessionID)
  const context = f.context({ sessionID: child.id, approvals: ["bash:printf OK"] })
  const result = await f.bash("printf OK", context)
  assert.equal(result.status, "completed", "Bash executes independently of the Agent lock")
  assert.equal(result.output, "OK")
  const record = f.record(result.taskID, child.id)
  assert.equal(record.parentTaskID, created.taskID)
  assert.equal(record.lockOwner, `background-task:${created.taskID}`)
  assert.equal(record.ownerSessionID, child.id)
  assert.equal(f.locks.has(record.lockOwner), true)
  assert.equal(child.metadata.o4e.delegation.effect, "unknown-write")
  assert.equal(f.client.sessions.get(child.id).metadata.o4e.task.sideEffectWatermark.callID, context.callID)
  assert.equal(evaluateResources("o4e_task", ["command:status"], child.permission), "allow")
  assert.equal(evaluateResources("o4e_task", ["status"], child.permission), "deny")
  for (const action of ["status", "inspect", "cancel"]) {
    const managed = await f.read(result.taskID, action, f.context({ sessionID: child.id }))
    assert.equal(managed.taskID, result.taskID)
    assert.equal(managed.status, "completed")
    if (action === "inspect") assert.equal(managed.tail, "OK")
  }
  const sessionCount = f.client.sessions.size
  await assert.rejects(f.invoke("task", { description: "recursive", prompt: "must not dispatch", subagent_type: "general" }, f.context({ sessionID: child.id })), /候选|拒绝|目标|权限/)
  assert.equal(f.client.sessions.size, sessionCount)
  assert.equal(f.client.promptAsyncCalls.length, 1)
  assert.equal(f.client.promptCalls.length, 0)
})

test("host-approved task Session ask preserves child Bash authority and later denies still block", options, async (t) => {
  const f = await fixture(t)
  f.client.sessions.get("parent").permission = [{ permission: "task", pattern: "general", action: "ask" }]
  const created = await f.json("task", {
    description: "host-approved child", prompt: "Perform the bounded command fixture", subagent_type: "general",
  }, f.context({ sessionID: "parent", approvals: ["task:general"] }))
  await until(() => f.client.sessions.get(created.sessionID)?.metadata?.o4e?.task?.status === "running")
  const context = f.context({ sessionID: created.sessionID, approvals: ["bash:printf OK"] })
  const result = await f.bash("printf OK", context)
  assert.equal(result.status, "completed")
  assert.equal(result.output, "OK")
  const child = f.client.sessions.get(created.sessionID)
  for (const envelope of [child.metadata.o4e.delegation, child.metadata.o4e.task]) {
    assert.equal(envelope.requesterPermissionAction, "ask")
    assert.equal(envelope.requesterPermissionApproved, true)
  }
  assert.equal(f.record(result.taskID, child.id).lockOwner, `background-task:${created.taskID}`)
  f.client.sessions.get("parent").permission = [{ permission: "task", pattern: "general", action: "deny" }]
  await assert.rejects(f.bash("printf OK", f.context({ sessionID: child.id })), /拒绝.*task|parent Session permission/)
})

test("nested child launch asks the host, owns its watch group, and resumes through frozen dispatch", options, async (t) => {
  const f = await fixture(t, { generalConfig: { loadAgents: ["general"], permission: { task: { "*": "ask" } } } })
  const parentTask = await f.general()
  const childID = parentTask.sessionID
  const nestedArgs = { description: "next-level work", prompt: "Wait for host approval and report the result", subagent_type: "general" }
  const before = f.client.sessions.size
  await assert.rejects(f.json("task", nestedArgs, f.context({ sessionID: childID })), /HOST_ASK_REJECTED/)
  assert.equal(f.client.sessions.size, before, "the host must approve before any next-level Session exists")
  const nested = await f.json("task", nestedArgs, f.context({ sessionID: childID, approvals: ["task:general"] }))
  await until(() => f.client.sessions.get(nested.sessionID)?.metadata?.o4e?.task?.status === "running")
  const readNested = (action, extra = {}) => f.read(nested.taskID, action, f.context({ sessionID: childID }), extra)
  const ledger = () => f.client.sessions.get(childID).metadata.o4e.task
  const grandchild = () => f.client.sessions.get(nested.sessionID)
  assert.equal(grandchild().parentID, "parent", "physical Session placement keeps host-native approvals visible")
  assert.equal(grandchild().metadata.o4e.delegation.parentSessionID, childID)
  assert.equal(grandchild().metadata.o4e.delegation.depth, 2)
  assert.equal(grandchild().metadata.o4e.task.ownerSessionID, childID)
  assert.equal(f.asks.findLast((request) => request.permission === "task").sessionID, childID)
  assert.equal((await readNested("status")).status, "running")
  for (const action of ["status", "watch", "output", "cancel"]) {
    const extra = action === "watch" ? { timeoutMs: 1 } : {}
    await assert.rejects(f.read(parentTask.taskID, action, f.context({ sessionID: childID }), extra), /O4E_TASK_MANAGEMENT_DENIED/)
    await assert.rejects(f.read(nested.taskID, action, f.context({ sessionID: "parent" }), extra), /O4E_TASK_MANAGEMENT_DENIED/)
  }
  const changingAuthority = f.context({ sessionID: childID })
  const hostAsk = changingAuthority.ask
  changingAuthority.ask = async (request) => {
    await hostAsk(request)
    f.client.sessions.get("parent").permission = [{ permission: "task", pattern: "general", action: "deny" }]
  }
  try {
    await assert.rejects(f.read(nested.taskID, "cancel", changingAuthority), /拒绝.*task|parent Session permission/)
    assert.equal(grandchild().metadata.o4e.task.status, "running", "ancestor revocation during host approval must block the mutation")
  } finally { delete f.client.sessions.get("parent").permission }

  const pending = { kind: "permission", id: "nested-bash-permission", sessionID: nested.sessionID, permission: "bash", patterns: ["printf NESTED"] }
  f.client.pendingRequests.push(pending)
  await f.hooks.event({ event: { type: "permission.asked", properties: { info: pending } } })
  const watched = await f.json("o4e_task", { action: "watch", timeoutMs: 5 }, f.context({ sessionID: childID }))
  assert.equal(watched.reason, "actionable")
  assert.deepEqual(watched.tasks.map((task) => [task.taskID, task.status]), [[nested.taskID, "waiting_permission"]])
  const requests = await readNested("pending")
  assert.equal(requests.tasks[0].pendingRequests[0].requestID, pending.id)
  assert.deepEqual(f.client.pendingRequests, [pending], "watch and pending must leave the real request for host UI")

  const finish = async (sessionID, text) => {
    const session = f.client.sessions.get(sessionID)
    const messages = f.client.messages.get(sessionID) ?? []
    messages.push({ info: { id: `done-${sessionID}-${messages.length}`, role: "assistant", agent: session.agent,
      parentID: session.metadata.o4e.task.dispatchMessageID, finish: "stop" },
    parts: [{ id: `result-${sessionID}-${messages.length}`, type: "text", text }] })
    f.client.messages.set(sessionID, messages)
    session.status = "idle"
    await f.hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  }
  const originalDispatch = ledger().dispatchMessageID
  await finish(childID, "Waiting for the host to approve the child request.")
  assert.equal(ledger().status, "running")
  assert.equal(ledger().phase, "waiting-children")
  assert.equal(ledger().dispatchMessageID, originalDispatch)
  f.client.pendingRequests = []
  await f.hooks.event({ event: { type: "permission.replied", properties: { sessionID: nested.sessionID, requestID: pending.id, reply: "once" } } })
  await finish(nested.sessionID, "NESTED RESULT")
  await until(() => f.client.promptAsyncCalls.filter((call) => call.sessionID === childID).length === 2)
  const continuation = f.client.promptAsyncCalls.findLast((call) => call.sessionID === childID)
  assert.notEqual(continuation.body.messageID, originalDispatch)
  assert.equal(ledger().dispatchMessageID, continuation.body.messageID, "the resumed owner turn must remain bound to its canonical Task")
  assert.equal(ledger().status, "running")
  assert.equal(continuation.body.parts[0].metadata.o4e.kind, "background-task-continuation")
  assert.match(continuation.body.parts[0].text, new RegExp(nested.taskID))
  assert.doesNotMatch(continuation.body.parts[0].text, /NESTED RESULT/)
  await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: nested.sessionID } } })
  assert.equal(f.client.promptAsyncCalls.filter((call) => call.sessionID === childID).length, 2)
  const output = await f.invoke("o4e_task", { action: "output", taskID: nested.taskID }, f.context({ sessionID: childID }))
  assert.equal(output.output, "NESTED RESULT")
  await finish(childID, "Collected NESTED RESULT")
  assert.equal(ledger().status, "completed")
  const final = await f.invoke("o4e_task", { action: "output", taskID: parentTask.taskID }, f.context({ sessionID: "parent" }))
  assert.equal(final.output, "Collected NESTED RESULT")
})

test("foreground cancellation and disposal stop owned background descendants", options, async (t) => {
  for (const boundary of ["abort", "dispose"]) {
    const f = await fixture(t, { generalConfig: { loadAgents: ["general"] } })
    let nested
    let childID
    let releaseTurn
    const turnPending = new Promise((resolvePromise) => { releaseTurn = resolvePromise })
    f.client.session.prompt = async ({ path, body }) => {
      childID = path.id
      f.client.sessions.get(childID).status = "busy"
      f.client.messages.set(childID, [{ info: { id: body.messageID, sessionID: childID, role: "user", agent: body.agent }, parts: body.parts }])
      nested = await f.json("task", { description: "foreground descendant", prompt: "Wait for cancellation", subagent_type: "general" },
        f.context({ sessionID: childID }))
      await turnPending
      return { data: { info: { id: "cancelled-foreground", role: "assistant", parentID: body.messageID,
        error: { name: "MessageAbortedError" } }, parts: [] } }
    }
    const controller = new AbortController()
    const foreground = f.invoke("task", { description: "foreground owner", prompt: "Delegate a bounded child", subagent_type: "general", background: false },
      f.context({ sessionID: "parent", controller }))
    const rejected = assert.rejects(foreground, /cancel foreground|Runtime 正在释放/)
    try {
      await until(() => nested && f.client.sessions.get(nested.sessionID).metadata.o4e.task.status === "running")
      if (boundary === "abort") controller.abort(new Error("cancel foreground"))
      else await bounded(f.hooks.dispose())
      await bounded(rejected)
      assert.ok(f.client.abortCalls.includes(childID), boundary)
      assert.ok(f.client.abortCalls.includes(nested.sessionID), boundary)
      assert.equal(f.client.sessions.get(nested.sessionID).metadata.o4e.task.status, "cancelled", boundary)
      assert.equal(f.client.sessions.get(childID).metadata.o4e.delegation.status, "cancelled", boundary)
      assert.equal(f.locks.has(`background-task:${nested.taskID}`), false, boundary)
    } finally { releaseTurn() }
  }
})

test("Agent settlement after Bash distinguishes omitted idle status from malformed status", options, async (t) => {
  for (const [entry, expected] of [[undefined, "completed"], [null, "unknown"]]) {
    const f = await fixture(t)
    assert.equal((await f.bash("printf OK")).status, "completed")
    const created = await f.general()
    const child = f.client.sessions.get(created.sessionID)
    f.client.messages.get(child.id).push({
      info: { id: "sparse-status-completion", sessionID: child.id, role: "assistant",
        parentID: child.metadata.o4e.delegation.dispatchMessageID, finish: "stop", time: { created: 1, completed: 2 } },
      parts: [{ type: "text", text: "completed child result" }],
    })
    child.status = "idle"
    const status = f.client.session.status
    f.client.session.status = async () => {
      const result = await status()
      if (entry === undefined) delete result.data[child.id]
      else result.data[child.id] = entry
      return result
    }
    const watched = await f.invoke("o4e_task", { action: "watch", taskID: created.taskID, timeoutMs: 20 },
      f.context({ sessionID: "parent" }))
    assert.equal(watched.metadata.o4eResult.tasks[0].status, expected)
    assert.equal(f.client.sessions.get(child.id).metadata.o4e.task.status, expected)
    assert.equal(f.locks.has(`background-task:${created.taskID}`), expected === "unknown")
  }
})

test("detached child commands still stop on idle, parent cancellation and reconciled completion", options, async (t) => {
  for (const boundary of ["session.idle", "session.status", "parent-cancel", "completion"]) {
    const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
    const created = await f.general()
    const command = "sleep 2; touch child-later.txt"
    const result = await f.bash(command, f.context({ sessionID: created.sessionID,
      approvals: [`bash:${command}`, "bash:sleep 2", "bash:touch child-later.txt"] }))
    assert.equal(result.status, "running", boundary)
    assert.ok(liveProcesses(f.root).length > 0)
    if (boundary === "parent-cancel") {
      await f.invoke("o4e_task", { action: "cancel", taskID: created.taskID }, f.context({ sessionID: "parent" }))
    } else if (boundary === "completion") {
      const dispatch = f.client.promptAsyncCalls.find((call) => call.sessionID === created.sessionID)
      f.client.messages.get(created.sessionID).push({
        info: { id: "assistant-completed", role: "assistant", sessionID: created.sessionID,
          parentID: dispatch.body.messageID, finish: "stop", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: "completed child result" }],
      })
      f.client.sessions.get(created.sessionID).status = "idle"
      const watched = await f.invoke("o4e_task", { action: "watch", taskID: created.taskID, timeoutMs: 20 }, f.context({ sessionID: "parent" }))
      assert.equal(watched.metadata.o4eResult.tasks[0].status, "completed")
    } else {
      const assistant = f.client.messages.get(created.sessionID).findLast((message) => message.info.role === "assistant")
      assistant.info.finish = "tool-calls"
      assistant.info.time = { created: 1, completed: 2 }
      f.client.sessions.get(created.sessionID).status = "idle"
      await f.hooks.event({ event: { type: boundary, properties: { sessionID: created.sessionID,
        ...(boundary === "session.status" ? { status: { type: "idle" } } : {}) } } })
    }
    assert.equal(f.record(result.taskID, created.sessionID).status, "cancelled", boundary)
    assert.deepEqual(liveProcesses(f.root), [], boundary)
    assert.equal(existsSync(join(f.directory, "child-later.txt")), false)
  }
})

test("delayed child idle events preserve commands after busy, retry or dispatch changes", options, async (t) => {
  for (const [type, drift] of [
    ["session.idle", "busy"], ["session.idle", "retry"], ["session.idle", "dispatch"],
    ["session.status", "busy"],
  ]) {
    const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
    const created = await f.general()
    const command = "sleep 2; touch event-later.txt"
    const running = await f.bash(command, f.context({ sessionID: created.sessionID,
      approvals: [`bash:${command}`, "bash:sleep 2", "bash:touch event-later.txt"] }))
    assert.equal(running.status, "running")
    const child = f.client.sessions.get(created.sessionID)
    const dispatchMessageID = child.metadata.o4e.delegation.dispatchMessageID
    const assistant = f.client.messages.get(child.id).findLast((message) => message.info.role === "assistant")
    assistant.info.finish = "tool-calls"
    assistant.info.time = { created: 1, completed: 2 }
    child.status = "idle"
    const messages = f.client.session.messages
    let release
    let entered = false
    const gate = new Promise((resolvePromise) => { release = resolvePromise })
    f.client.session.messages = async (args) => {
      const result = await messages(args)
      if (args.path.id === child.id && args.query?.limit === undefined && !entered) {
        entered = true
        await gate
      }
      return result
    }
    const event = f.hooks.event({ event: { type, properties: { sessionID: child.id,
      ...(type === "session.status" ? { status: { type: "idle" } } : {}) } } })
    const settled = Promise.allSettled([event])
    try {
      await until(() => entered)
      assert.equal(f.record(running.taskID, child.id).status, "running", "idle must await verified inspection before cancellation")
      const current = f.client.sessions.get(child.id)
      if (drift === "dispatch") current.metadata.o4e.delegation.dispatchMessageID = "new-dispatch"
      else current.status = drift
      release()
      const [outcome] = await bounded(settled)
      assert.equal(outcome.status, "fulfilled", outcome.reason?.message)
      assert.equal(f.record(running.taskID, child.id).status, "running", `${type}: ${drift}`)
      assert.ok(liveProcesses(f.root).length > 0)
    } finally {
      release()
      f.client.session.messages = messages
      const current = f.client.sessions.get(child.id)
      current.metadata.o4e.delegation.dispatchMessageID = dispatchMessageID
      current.status = "busy"
      await bounded(settled)
    }
  }
})

test("foreground child completion stops its detached commands", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
  let running
  let childID
  f.client.session.prompt = async ({ path, body }) => {
    childID = path.id
    f.client.promptCalls.push({ sessionID: childID, body: structuredClone(body) })
    f.client.sessions.get(childID).status = "busy"
    f.client.messages.set(childID, [{ info: { id: body.messageID, sessionID: childID, role: "user", agent: body.agent },
      parts: structuredClone(body.parts) }])
    const command = "sleep 2; touch foreground-later.txt"
    running = await f.bash(command, f.context({ sessionID: childID,
      approvals: [`bash:${command}`, "bash:sleep 2", "bash:touch foreground-later.txt"] }))
    assert.equal(running.status, "running")
    const message = {
      info: { id: "completed-child", role: "assistant", parentID: body.messageID, finish: "stop", time: { created: 1, completed: 2 } },
      parts: [{ id: "completed-text", type: "text", text: "completed child" }],
    }
    f.client.messages.get(childID).push(message)
    f.client.sessions.get(childID).status = "idle"
    await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
    return { data: message }
  }
  await f.invoke("task", { description: "foreground lifecycle", prompt: "Check Bash lifecycle",
    subagent_type: "general", background: false }, f.context({ sessionID: "parent" }))
  assert.equal(f.record(running.taskID, childID).status, "cancelled")
  assert.deepEqual(liveProcesses(f.root), [])
  assert.equal(existsSync(join(f.directory, "foreground-later.txt")), false)
})

test("旧 Workflow 入口被拒绝且不会执行命令或创建 Session", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
  const baselineSessions = f.client.sessions.size
  for (const args of [
    { workflow: "investigation" },
    { resumeRunID: "legacy-run" },
  ]) {
    await assert.rejects(f.invoke("o4e_workflow", args, f.context({ sessionID: "parent" })), /O4E_WORKFLOW_DISABLED/)
  }
  assert.equal(f.client.sessions.size, baselineSessions)
  assert.equal(f.client.promptCalls.length, 0)
  assert.equal(f.client.promptAsyncCalls.length, 0)
  assert.deepEqual(f.refs("parent"), {})
  assert.deepEqual(liveProcesses(f.root), [])
})

test("delayed child idle inspection cannot cancel commands after activity changes", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 100 } })
  const created = await f.general()
  const command = "sleep 2; touch after-stale.txt"
  const running = await f.bash(command, f.context({ sessionID: created.sessionID,
    approvals: [`bash:${command}`, "bash:sleep 2", "bash:touch after-stale.txt"] }))
  assert.equal(running.status, "running")
  const child = f.client.sessions.get(created.sessionID)
  const dispatchMessageID = child.metadata.o4e.delegation.dispatchMessageID
  f.client.messages.get(child.id).push({
    info: { id: "old-final", role: "assistant", parentID: dispatchMessageID, finish: "stop" },
    parts: [{ id: "old-text", type: "text", text: "old turn result" }],
  })
  child.status = "idle"
  const messages = f.client.session.messages
  let release
  let entered = false
  const gate = new Promise((resolvePromise) => { release = resolvePromise })
  f.client.session.messages = async (args) => {
    const result = await messages(args)
    if (args.path.id === child.id && args.query?.limit === undefined && !entered) {
      entered = true
      await gate
    }
    return result
  }
  const watch = f.invoke("o4e_task", { action: "watch", taskID: created.taskID, timeoutMs: 20 }, f.context({ sessionID: "parent" }))
  const settled = Promise.allSettled([watch])
  try {
    await until(() => entered)
    child.status = "busy"
    release()
    const [outcome] = await bounded(settled)
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message)
    assert.notEqual(outcome.value.metadata.o4eResult.tasks[0].status, "completed")
    assert.equal(f.record(running.taskID, child.id).status, "running")
    assert.ok(liveProcesses(f.root).length > 0)
  } finally {
    release()
    f.client.session.messages = messages
    const current = f.client.sessions.get(child.id)
    current.metadata.o4e.delegation.dispatchMessageID = dispatchMessageID
    current.status = "busy"
  }
})

test("root Bash executes under an Agent lock and parent cancellation stops only its child command", options, async (t) => {
  const f = await fixture(t)
  const created = await f.general()
  const childContext = f.context({ sessionID: created.sessionID, approvals: ["bash:sleep 2", "bash:touch after-cancel.txt"] })
  const childOperation = f.bash("sleep 2; touch after-cancel.txt", childContext)
  const childSettled = Promise.allSettled([childOperation])
  await until(() => f.running(created.sessionID) && liveProcesses(f.root).length > 0)
  const commandID = f.running(created.sessionID).taskID
  const rootResult = await f.bash("touch unblocked.txt")
  assert.equal(rootResult.status, "completed")
  assert.equal(existsSync(join(f.directory, "unblocked.txt")), true, "root process executes before parent cancellation")
  assert.equal(f.locks.has(`background-task:${created.taskID}`), true)
  assert.equal(f.record(commandID, created.sessionID).status, "running")
  assert.equal(f.record(commandID, created.sessionID).lockOwner, `background-task:${created.taskID}`)
  const cancelled = (await bounded(f.invoke("o4e_task", { action: "cancel", taskID: created.taskID }, f.context({ sessionID: "parent" })), 1200)).metadata.o4eResult
  assert.ok(["cancelling", "cancelled"].includes(cancelled.status))
  assert.equal(f.record(commandID, created.sessionID).status, "cancelled", "parent cancel must stop its command before a later host idle event")
  assert.equal(f.record(commandID, created.sessionID).stopped, true)
  assert.equal(existsSync(join(f.directory, "after-cancel.txt")), false)
  // Host abort acknowledgement precedes the idle event that settles Agent Tasks.
  await bounded(f.hooks.event({ event: { type: "session.idle", properties: { sessionID: created.sessionID } } }), 1200)
  await until(() => f.client.sessions.get(created.sessionID).metadata.o4e.task.status === "cancelled", 1200)
  const [childOutcome] = await childSettled
  assert.equal(childOutcome.status, "fulfilled", childOutcome.reason?.message)
  const childResult = childOutcome.value
  assert.equal(childResult.status, "cancelled")
  assert.equal(childResult.stopped, true)
  assert.equal(existsSync(join(f.directory, "after-cancel.txt")), false)
  assert.equal(existsSync(join(f.directory, "unblocked.txt")), true)
  assert.equal(f.locks.has(`background-task:${created.taskID}`), false)
  assert.ok(f.client.abortCalls.includes(created.sessionID))
  assert.equal(f.client.promptAsyncCalls.length, 1)
  assert.deepEqual(liveProcesses(f.root), [])
})

test("two root Bash processes run concurrently while the third waits for maxConcurrentCommands", options, async (t) => {
  const f = await fixture(t, { maxConcurrentCommands: 2, commandWaitOptions: { timeoutMs: 20, runningTimeoutMs: 20 } })
  const run = (name) => {
    const command = `touch ${name}; while [ ! -f release-roots ]; do sleep 0.01; done`
    return f.bash(command, f.context({ approvals: [`bash:${command}`, "bash:[ ! -f release-roots ]"] }))
  }
  const first = await run("first-root.txt")
  const second = await run("second-root.txt")
  assert.equal(first.status, "running")
  assert.equal(second.status, "running")
  await until(() => existsSync(join(f.directory, "first-root.txt")) && existsSync(join(f.directory, "second-root.txt")))
  const queued = await f.bash("touch third-root.txt")
  assert.equal(queued.status, "queued")
  assert.equal(existsSync(join(f.directory, "third-root.txt")), false)
  assert.equal(f.active(first.taskID), true)
  assert.equal(f.active(second.taskID), true)
  writeFileSync(join(f.directory, "release-roots"), "")
  await until(() => [first, second, queued].every((task) => f.record(task.taskID).status === "completed"))
  assert.equal(existsSync(join(f.directory, "third-root.txt")), true)
  f.noDispatch()
})

test("unconfirmed child command persistence retains its Agent lock but cannot block root Bash", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 20 } })
  const parent = await f.general()
  const child = await f.bash("sleep 5", f.context({ sessionID: parent.sessionID, approvals: ["bash:sleep 5"] }))
  assert.equal(child.status, "running")
  const update = f.client.session.update
  try {
    f.client.session.update = async (args) => {
      if (args.path.id === parent.sessionID && args.body.metadata?.o4e?.commandTasks?.refs?.[child.taskID]?.recovery.stopped) {
        throw new Error("child command stop persistence unavailable")
      }
      return update(args)
    }
    await Promise.allSettled([f.read(parent.taskID, "cancel", f.context({ sessionID: "parent" }))])
    await until(() => liveProcesses(f.root).length === 0)
    assert.equal(f.record(child.taskID, parent.sessionID).stopped, false)
    assert.equal(f.locks.has(child.taskID), false)
    assert.equal(f.locks.has(`background-task:${parent.taskID}`), true, "Agent settlement requires confirmed child command persistence")
    const root = await f.bash("touch independent-root.txt")
    assert.notEqual(root.status, "queued")
    await until(() => f.record(root.taskID).status === "completed")
    assert.equal(existsSync(join(f.directory, "independent-root.txt")), true)
  } finally { f.client.session.update = update }
  await f.read(parent.taskID, "cancel", f.context({ sessionID: "parent" }))
  await f.hooks.event({ event: { type: "session.idle", properties: { sessionID: parent.sessionID } } })
  await until(() => !f.locks.has(`background-task:${parent.taskID}`))
  assert.equal(f.record(child.taskID, parent.sessionID).stopped, true)
})

test("host ask rejection prevents every side effect of an otherwise valid compound command", options, async (t) => {
  const f = await fixture(t, { buildPermission: { bash: { "*": "ask", "printf OK": "allow" } } })
  await assert.rejects(f.bash("printf OK; touch ask-probe.txt"), /HOST_ASK_REJECTED: bash/)
  assert.deepEqual(f.asks[0].patterns, ["printf OK", "touch ask-probe.txt"])
  assert.equal(f.asks[0].action, "ask")
  assert.equal(existsSync(join(f.directory, "ask-probe.txt")), false)
  assert.deepEqual(f.refs(), {})
  assert.equal(f.client.sessions.size, 4)
  assert.deepEqual(liveProcesses(f.root), [])
  f.noDispatch()
})

test("host deny catches compound rm including tab normalization and Session rules before spawn", options, async (t) => {
  const f = await fixture(t)
  writeFileSync(join(f.directory, "protected.txt"), "keep")
  const command = "touch deny-probe.txt && rm\tprotected.txt"
  await assert.rejects(f.bash(command), /HOST_PERMISSION_DENIED: bash/)
  assert.ok(f.asks.at(-1).patterns.includes("rm protected.txt"), "authorize the canonical atomic rm, not just its container")
  assert.equal(existsSync(join(f.directory, "deny-probe.txt")), false)
  assert.equal(readFileSync(join(f.directory, "protected.txt"), "utf8"), "keep")
  f.client.sessions.get("native").permission = [{ permission: "bash", pattern: "touch session-denied.txt", action: "deny" }]
  await assert.rejects(f.bash("touch session-denied.txt"), /HOST_PERMISSION_DENIED: bash/)
  assert.equal(existsSync(join(f.directory, "session-denied.txt")), false)
  assert.deepEqual(f.refs(), {})
  assert.equal(f.client.sessions.size, 4)
  f.noDispatch()
})

test("external-directory gates file arguments and workdir with explicit host approval", options, async (t) => {
  const f = await fixture(t)
  writeFileSync(join(f.outside, "fixture.txt"), "outside output")
  const command = `cat ${join(f.outside, "fixture.txt")}`
  await assert.rejects(f.bash(command), /HOST_ASK_REJECTED: external_directory/)
  assert.deepEqual(f.asks.at(-1).patterns, [`${f.outside}/*`])
  assert.deepEqual(f.refs(), {})
  const approved = f.context({ approvals: [`external_directory:${f.outside}/*`] })
  assert.equal((await f.bash(command, approved)).output, "outside output")
  const count = Object.keys(f.refs()).length
  await assert.rejects(f.bash("touch outside-probe.txt", undefined, { workdir: f.outside }), /HOST_ASK_REJECTED: external_directory/)
  assert.equal(Object.keys(f.refs()).length, count)
  assert.equal(existsSync(join(f.outside, "outside-probe.txt")), false)
  const cwdResult = await f.bash("cat fixture.txt", f.context({ approvals: [`external_directory:${f.outside}/*`] }), { workdir: f.outside })
  assert.equal(cwdResult.output, "outside output")
  assert.equal(f.record(cwdResult.taskID).cwd, f.outside)
  f.noDispatch()
})

test("the original Bash abort signal cancels a queued command before a resource slot becomes available", options, async (t) => {
  const f = await fixture(t, { maxConcurrentCommands: 1, commandWaitOptions: { runningTimeoutMs: 20 } })
  const blocker = await f.bash("sleep 5")
  const controller = new AbortController()
  const rejected = assert.rejects(f.bash("touch queued-probe.txt", f.context({ controller })), /cancel queued Bash/)
  await until(() => Object.values(f.refs()).some((ref) => ref.recovery.status === "queued"))
  const queued = Object.values(f.refs()).find((ref) => ref.recovery.status === "queued").recovery
  assert.equal(f.record(queued.taskID).claim, null)
  controller.abort(new Error("cancel queued Bash"))
  await rejected
  await until(() => f.record(queued.taskID).status === "cancelled")
  await f.read(blocker.taskID, "cancel")
  assert.equal(f.active(blocker.taskID), false)
  assert.equal((await f.bash("printf OK")).status, "completed", "the cancelled queue must remain fenced after a later writer is admitted")
  const final = await f.read(queued.taskID)
  assert.equal(final.status, "cancelled")
  assert.equal(final.phase, "not-submitted")
  assert.equal(f.record(queued.taskID).claim, null)
  assert.equal(existsSync(join(f.directory, "queued-probe.txt")), false)
  assert.deepEqual(liveProcesses(f.root), [])
})

test("a returned queued Bash reader abort leaves explicit cancellation available", options, async (t) => {
  const f = await fixture(t, { maxConcurrentCommands: 1, commandWaitOptions: { timeoutMs: 20, runningTimeoutMs: 100 } })
  const blocker = await f.bash("sleep 5")
  const controller = new AbortController()
  const queued = await f.bash("touch queued-detached.txt", f.context({ controller }))
  assert.equal(queued.status, "queued")
  controller.abort(new Error("finished queued reader"))
  assert.equal((await f.read(queued.taskID)).status, "queued")
  const cancelled = await f.bash("touch queued-cancelled.txt")
  assert.equal((await f.read(cancelled.taskID, "cancel")).status, "cancelled")
  await f.read(blocker.taskID, "cancel")
  assert.equal((await f.read(queued.taskID, "watch", undefined, { timeoutMs: 1000 })).tasks[0].status, "completed")
  assert.equal(existsSync(join(f.directory, "queued-detached.txt")), true)
  assert.equal(existsSync(join(f.directory, "queued-cancelled.txt")), false)
})

test("dispose stops running and queued Bash work and rejects later execution", options, async (t) => {
  const f = await fixture(t, { maxConcurrentCommands: 1 })
  const running = f.bash("sleep 2; touch dispose-running.txt")
  const runningSettled = Promise.allSettled([running])
  await until(() => f.running() && liveProcesses(f.root).length > 0)
  const queued = f.bash("touch dispose-queued.txt")
  const queuedSettled = Promise.allSettled([queued])
  await until(() => Object.values(f.refs()).some((ref) => ref.recovery.status === "queued"))
  await bounded(f.hooks.dispose(), 1200)
  await Promise.all([runningSettled, queuedSettled])
  for (const ref of Object.values(f.refs())) {
    assert.equal(ref.recovery.status, "cancelled")
    assert.equal(ref.recovery.stopped, true)
  }
  assert.equal(existsSync(join(f.directory, "dispose-running.txt")), false)
  assert.equal(existsSync(join(f.directory, "dispose-queued.txt")), false)
  assert.deepEqual(liveProcesses(f.root), [])
  await assert.rejects(f.bash("touch after-dispose.txt"), /正在释放/)
  assert.equal(existsSync(join(f.directory, "after-dispose.txt")), false)
  f.noDispatch()
})

test("large binary and newline output stays below 50 KiB JSON and reports truncation", options, async (t) => {
  const f = await fixture(t)
  for (const [name, bytes] of [
    ["binary.dat", Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 256))],
    ["newlines.txt", Buffer.alloc(128 * 1024, 10)],
  ]) {
    writeFileSync(join(f.directory, name), bytes)
    const result = await f.bash(`cat ${name}`)
    assert.equal(result.status, "completed")
    assert.equal(result.totalBytes, bytes.length)
    assert.equal(result.sha256, hash(bytes))
    assert.equal(result.truncated, true)
    for (const action of ["status", "output", "inspect", "watch"]) {
      const read = await f.read(result.taskID, action, undefined, action === "inspect" ? { maxBytes: 8192 } : action === "watch" ? { timeoutMs: 20 } : {})
      assert.equal(action === "watch" ? read.tasks[0].status : read.status, "completed")
      if (["status", "output"].includes(action)) {
        assert.equal(read.truncated, true)
        assert.equal(read.totalBytes, bytes.length)
        assert.equal(read.sha256, hash(bytes))
      }
      if (action === "inspect") assert.equal(read.gap, "output-truncated")
    }
  }
  f.noDispatch()
})

test("host shell is preserved without fallback", options, async (t) => {
  const f = await fixture(t, { shell: "/bin/sh" })
  await f.bash("touch shell-probe.txt")
  assert.ok(f.asks.length > 0)
  assert.equal(existsSync(join(f.directory, "shell-probe.txt")), true)
  assert.deepEqual(liveProcesses(f.root), [])
  f.noDispatch()
})

test("root abort suppresses automatic tracking without cancelling detached commands; idle also preserves them", options, async (t) => {
  const f = await fixture(t)
  const events = [
    { type: "session.error", properties: { error: { name: "MessageAbortedError", data: { message: "host abort" } } } },
    { type: "session.error", properties: { error: { name: "AbortError", message: "host abort" } } },
    { type: "session.idle", properties: {} },
    { type: "session.status", properties: { status: { type: "idle" } } },
  ]
  for (const [index, event] of events.entries()) {
    f.client.sessions.get("native").status = "busy"
    const operation = f.bash(`sleep 2; touch event-${index}.txt`)
    const settled = Promise.allSettled([operation])
    await until(() => f.running() && liveProcesses(f.root).length > 0)
    const taskID = f.running().taskID
    f.client.sessions.get("native").status = "idle"
    await bounded(f.hooks.event({ event: { ...event, properties: { ...event.properties, sessionID: "native" } } }), 1200)
    const [outcome] = await settled
    assert.equal(outcome.status, "fulfilled", outcome.reason?.message)
    const result = outcome.value
    const terminal = await f.read(taskID, "watch", undefined, { timeoutMs: 2500 })
    assert.equal(terminal.tasks[0].status, "completed", event.type)
    assert.equal(existsSync(join(f.directory, `event-${index}.txt`)), true)
    assert.deepEqual(liveProcesses(f.root), [])
  }
  f.noDispatch()
})

test("command-only owner idle automatically continues coordination without a model tool Part", options, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { runningTimeoutMs: 20 }, buildPermission: { bash: "allow" } })
  const context = f.context({ sessionID: "native" })
  const result = await f.invoke("bash", { command: "while [ ! -f release-follow ]; do sleep 0.02; done; printf DONE", description: "automatic command follow" }, context)
  const taskID = result.metadata.o4eResult.taskID
  assert.equal(result.metadata.o4eResult.status, "running")
  f.client.messages.set("native", [{
    info: { id: "assistant-command-idle", sessionID: "native", role: "assistant", parentID: "user-command", finish: "stop" },
    parts: [{ id: "part-command-idle", type: "text", text: "independent work finished" }],
  }])
  f.client.sessions.get("native").status = "idle"
  await bounded(f.hooks.event({ event: { type: "session.idle", properties: { sessionID: "native" } } }), 1200)
  await until(() => f.client.promptAsyncCalls.some((call) => call.sessionID === "native"))
  const continuation = f.client.promptAsyncCalls.find((call) => call.sessionID === "native")
  assert.equal(continuation.body.parts.length, 1)
  assert.equal(continuation.body.parts[0].type, "text")
  assert.equal(continuation.body.parts[0].synthetic, true)
  assert.equal(continuation.body.parts[0].metadata.o4e.kind, "background-task-continuation")
  assert.match(continuation.body.parts[0].text, new RegExp(taskID))
  assert.equal(continuation.body.parts.some((part) => part.type === "tool"), false)
  for (const id of ["command-reported", "command-still-running"]) {
    f.client.messages.set("native", [{ info: { id, role: "assistant", finish: "stop" }, parts: [] }])
    f.client.sessions.get("native").status = "idle"
    await bounded(f.hooks.event({ event: { type: "session.idle", properties: { sessionID: "native" } } }), 1200)
  }
  assert.equal(f.client.promptAsyncCalls.filter((call) => call.sessionID === "native").length, 1)
  writeFileSync(join(f.directory, "release-follow"), "")
  assert.equal((await f.read(taskID, "watch", undefined, { timeoutMs: 1500 })).tasks[0].status, "completed")
  assert.equal((await f.read(taskID, "output")).output, "DONE")
})

test("deleting a missing Session without commands leaves initialized command Runtime usable", options, async (t) => {
  const f = await fixture(t)
  const initialized = await f.bash("printf OK")
  assert.equal(initialized.status, "completed")
  const deleted = f.client.sessions.get("other")
  assert.deepEqual(f.refs(deleted.id), {})
  f.client.sessions.delete(deleted.id)
  await assert.rejects(f.client.session.get({ path: { id: deleted.id } }), { name: "NotFoundError" })

  await bounded(f.hooks.event({ event: { type: "session.deleted", properties: { info: deleted } } }), 1000)
  const result = await f.bash("printf OK", f.context({ sessionID: "plan" }))
  assert.equal(result.status, "completed")
  assert.equal(result.output, "OK")
  assert.equal((await f.read(initialized.taskID, "output")).output, "OK")
  assert.equal(f.client.sessions.has(deleted.id), false)
  assert.deepEqual(liveProcesses(f.root), [])
  f.noDispatch()
})

test("original Bash abort stops its real process while owner get remains permanently pending", options, async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  const bashSettled = Promise.allSettled([f.bash("sleep 2; touch pending-abort-later.txt", f.context({ controller }))])
  let blocked
  let readSettled
  let taskID
  try {
    await until(() => f.running() && liveProcesses(f.root).length > 0)
    taskID = f.running().taskID
    blocked = blockSessionGet(f.client, "native")
    readSettled = Promise.allSettled([f.read(taskID)])
    await bounded(blocked.entered, 1000)

    controller.abort(new Error("original-bash-abort-with-pending-store"))
    await until(() => liveProcesses(f.root).length === 0, 1000)
    assert.equal(f.active(taskID), true, "raw stop cannot release a resource slot before owner persistence")
    await delay(2100)
    assert.equal(existsSync(join(f.directory, "pending-abort-later.txt")), false)
    assert.deepEqual(liveProcesses(f.root), [])
    assert.equal(f.active(taskID), true)
    f.noDispatch()
  } finally { blocked?.release() }

  const [[bashResult]] = await bounded(Promise.all([bashSettled, readSettled]))
  assert.equal(bashResult.status, "rejected")
  assert.match(bashResult.reason.message, /original-bash-abort-with-pending-store/)
  await until(() => f.record(taskID).status === "cancelled")
  assert.equal(f.record(taskID).stopped, true)
  await bounded(f.hooks.dispose())
  assert.equal(f.active(taskID), false)
})

test("dispose stops known processes before awaiting a read blocked on owner persistence", options, async (t) => {
  const f = await fixture(t)
  const bashSettled = Promise.allSettled([f.bash("sleep 2; touch pending-dispose-later.txt")])
  let blocked
  let readSettled
  let disposalSettled
  let disposalFinished = false
  let taskID
  try {
    await until(() => f.running() && liveProcesses(f.root).length > 0)
    taskID = f.running().taskID
    blocked = blockSessionGet(f.client, "native")
    readSettled = Promise.allSettled([f.read(taskID)])
    await bounded(blocked.entered, 1000)

    disposalSettled = Promise.allSettled([f.hooks.dispose()])
    void disposalSettled.then(() => { disposalFinished = true })
    await until(() => liveProcesses(f.root).length === 0, 1000)
    await delay(2100)
    assert.equal(disposalFinished, false, "disposal must still await admitted store work")
    assert.equal(f.active(taskID), true, "stopped processes alone do not prove persisted settlement")
    assert.equal(existsSync(join(f.directory, "pending-dispose-later.txt")), false)
    assert.deepEqual(liveProcesses(f.root), [])
    f.noDispatch()
  } finally { blocked?.release() }

  const [outcome] = await bounded(disposalSettled)
  assert.equal(outcome.status, "fulfilled", outcome.reason?.message)
  await bounded(Promise.all([bashSettled, readSettled]))
  assert.equal(f.record(taskID).status, "cancelled")
  assert.equal(f.record(taskID).stopped, true)
  assert.equal(f.active(taskID), false)
})

test("deleted live command owner stops its process, retains its slot and reports the event error only once", options, async (t) => {
  const f = await fixture(t)
  const other = await f.bash("printf OK", f.context({ sessionID: "other" }))
  assert.equal(other.status, "completed")
  const bashSettled = Promise.allSettled([f.bash("sleep 2; touch deleted-owner-later.txt")])
  const get = f.client.session.get
  let owner
  let taskID
  let missingReads = 0
  let otherReads = 0
  try {
    await until(() => f.running() && liveProcesses(f.root).length > 0)
    taskID = f.running().taskID
    owner = structuredClone(f.client.sessions.get("native"))
    f.client.sessions.delete(owner.id)
    f.client.session.get = async (args) => {
      if (args.path.id === owner.id) missingReads++
      if (args.path.id === "other") otherReads++
      return get(args)
    }
    await assert.rejects(f.client.session.get({ path: { id: owner.id } }), { name: "NotFoundError" })

    const deletionSettled = Promise.allSettled([f.hooks.event({ event: { type: "session.deleted", properties: { info: owner } } })])
    await until(() => liveProcesses(f.root).length === 0, 1000)
    const [deletion] = await bounded(deletionSettled, 1200)
    assert.equal(deletion.status, "rejected", "missing owner persistence must not be reported as successful cancellation")
    assert.equal(deletion.reason.name, "NotFoundError")
    assert.match(deletion.reason.message, /Session not found: native/)
    await bounded(bashSettled)
    assert.equal(f.active(taskID), true)

    const failuresBeforeNextEvent = missingReads
    const readsBeforeNextEvent = otherReads
    await bounded(f.hooks.event({ event: { type: "session.error", properties: { sessionID: "other",
      error: { name: "AbortError", message: "unrelated owner abort" } } } }), 1000)
    assert.ok(otherReads > readsBeforeNextEvent, "the unrelated event must actually reach its own Session processing")
    assert.equal((await f.read(other.taskID, "output", f.context({ sessionID: "other" }))).output, "OK")
    assert.equal(missingReads, failuresBeforeNextEvent, "later events/tools must not replay the failed deleted queue head")
    await delay(2100)
    assert.equal(f.client.sessions.has(owner.id), false)
    assert.equal(f.active(taskID), true, "failed owner persistence must retain the resource slot")
    assert.equal(existsSync(join(f.directory, "deleted-owner-later.txt")), false)
    assert.deepEqual(liveProcesses(f.root), [])
    f.noDispatch()
  } finally {
    // Restore only fake host storage for cleanup, never synthesize stop evidence.
    f.client.session.get = get
    if (owner) f.client.sessions.set(owner.id, owner)
  }
  await bounded(f.hooks.dispose())
  assert.equal(f.active(taskID), false)
})

test("disposing a reader facade does not cancel the creator facade's shared live command", options, async (t) => {
  const f = await fixture(t)
  const reader = await f.facade()
  assert.notEqual(reader, f.hooks)
  const command = "printf OK >> facade-once.txt; sleep 2; touch facade-finished.txt"
  const running = f.bash(command, f.context({ approvals: ["bash:printf OK >> facade-once.txt"] }))
  await until(() => f.running()?.status === "running")
  const created = f.running()
  const processes = liveProcesses(f.root)
  assert.ok(processes.length > 0)
  const observed = await f.json("o4e_task", { action: "status", taskID: created.taskID }, undefined, reader)
  assert.equal(observed.taskID, created.taskID)
  assert.equal(observed.claim, undefined, "public command projection must not expose the execution claim")
  assert.equal(Number.isSafeInteger(observed.revision), true)
  assert.equal(observed.status, "running")

  await bounded(reader.dispose(), 1000)
  assert.ok(liveProcesses(f.root).some((current) => processes.some(({ pid, start }) => current.pid === pid && current.start === start)),
    "reader disposal must leave the creator's actual process alive")
  assert.equal(f.active(created.taskID), true)
  assert.equal(f.record(created.taskID).status, "running")
  assert.equal(existsSync(join(f.directory, "facade-finished.txt")), false)
  await assert.rejects(f.json("o4e_task", { action: "status", taskID: created.taskID }, undefined, reader), /正在释放/)
  const terminal = await f.read(created.taskID, "watch", undefined, { timeoutMs: 2500 })
  assert.equal(terminal.tasks[0].status, "completed")
  assert.equal(terminal.tasks[0].stopped, true)
  assert.equal(readFileSync(join(f.directory, "facade-once.txt"), "utf8"), "OK")
  assert.equal(existsSync(join(f.directory, "facade-finished.txt")), true)
  assert.equal(Object.keys(f.refs()).length, 1)
  assert.equal(f.active(created.taskID), false)
  assert.deepEqual(liveProcesses(f.root), [])
  assert.ok(["running", "completed"].includes((await running).status))
  f.noDispatch()
})

test("dispose retries failed owner persistence without respawning its stopped command", options, async (t) => {
  const f = await fixture(t)
  const command = "printf OK >> dispose-once.txt; sleep 2; touch dispose-retry-later.txt"
  const bashSettled = Promise.allSettled([f.bash(command, f.context({ approvals: ["bash:printf OK >> dispose-once.txt"] }))])
  await until(() => f.running() && existsSync(join(f.directory, "dispose-once.txt")) && liveProcesses(f.root).length > 0)
  const started = structuredClone(f.running())
  const taskID = started.taskID
  const update = f.client.session.update
  const storeError = new Error("fixture owner update unavailable")
  const failedWrites = []
  try {
    f.client.session.update = async (args) => {
      if (args.path.id === "native") {
        failedWrites.push(structuredClone(args.body))
        throw storeError
      }
      return update(args)
    }
    await assert.rejects(bounded(f.hooks.dispose(), 1200), (error) => error === storeError)
    await bounded(bashSettled, 1000)
    assert.ok(failedWrites.some((body) => body.metadata?.o4e?.commandTasks?.refs?.[taskID]?.recovery.stopped === true))
    assert.deepEqual(liveProcesses(f.root), [], "failed disposal must already have stopped the real process")
    assert.equal(f.record(taskID).status, "running")
    assert.equal(f.record(taskID).stopped, false)
    assert.deepEqual(f.refs()[taskID].recovery, started, "owner index must not pretend the failed write committed")
    assert.equal(f.active(taskID), true, "process stop without confirmed owner persistence cannot release the resource slot")
    assert.equal(readFileSync(join(f.directory, "dispose-once.txt"), "utf8"), "OK")
    assert.equal(existsSync(join(f.directory, "dispose-retry-later.txt")), false)
  } finally { f.client.session.update = update }

  await bounded(f.hooks.dispose(), 1200)
  const record = f.record(taskID)
  assert.deepEqual(f.refs()[taskID].recovery, record)
  assert.equal(record.status, "cancelled")
  assert.equal(record.stopped, true)
  assert.equal(record.claim, started.claim)
  assert.equal(record.executionID, started.executionID)
  assert.deepEqual(record.source, started.source)
  assert.equal(f.active(taskID), false)
  await delay(2100)
  assert.equal(readFileSync(join(f.directory, "dispose-once.txt"), "utf8"), "OK", "dispose retry must not execute the command again")
  assert.equal(existsSync(join(f.directory, "dispose-retry-later.txt")), false)
  assert.equal(Object.keys(f.refs()).length, 1)
  assert.equal(f.client.sessions.size, 4)
  assert.deepEqual(liveProcesses(f.root), [])
  f.noDispatch()
})

test("failed plugin dispose rolls Bash admission back instead of leaving the facade DISPOSED", {
  ...options,
}, async (t) => {
  const f = await fixture(t, { commandWaitOptions: { timeoutMs: 20, runningTimeoutMs: 100 } })
  const command = "printf OK >> dispose-rollback-once.txt; sleep 2; touch dispose-rollback-later.txt"
  const bashSettled = Promise.allSettled([f.bash(command, f.context({ approvals: ["bash:printf OK >> dispose-rollback-once.txt"] }))])
  await until(() => f.running() && existsSync(join(f.directory, "dispose-rollback-once.txt")) && liveProcesses(f.root).length > 0)
  const taskID = f.running().taskID
  const update = f.client.session.update
  const storeError = new Error("fixture rollback owner update unavailable")
  try {
    f.client.session.update = async (args) => {
      if (args.path.id === "native") throw storeError
      return update(args)
    }
    await assert.rejects(bounded(f.hooks.dispose(), 1200), (error) => error === storeError)
    await bounded(bashSettled, 1000)
    assert.deepEqual(liveProcesses(f.root), [])
    assert.equal(f.record(taskID).status, "running")
    assert.equal(f.active(taskID), true)
  } finally { f.client.session.update = update }

  const afterRollback = await f.bash("touch after-failed-dispose.txt")
  assert.equal(afterRollback.status, "queued")
  assert.equal(existsSync(join(f.directory, "after-failed-dispose.txt")), false)

  await bounded(f.hooks.dispose(), 1200)
  assert.equal(f.record(taskID).status, "cancelled")
  assert.equal(f.record(afterRollback.taskID).status, "cancelled")
  assert.equal(f.active(taskID), false)
  await delay(2100)
  assert.equal(readFileSync(join(f.directory, "dispose-rollback-once.txt"), "utf8"), "OK")
  assert.equal(existsSync(join(f.directory, "dispose-rollback-later.txt")), false)
  assert.equal(existsSync(join(f.directory, "after-failed-dispose.txt")), false)
  f.noDispatch()
})

test("same native owner switching build to plan can read its command but cannot start denied Bash", options, async (t) => {
  const f = await fixture(t)
  const created = await f.bash("touch build-before-plan.txt; printf OK")
  assert.equal(created.status, "completed")
  assert.equal(existsSync(join(f.directory, "build-before-plan.txt")), true)
  assert.equal(f.record(created.taskID).requesterAgent, "build")
  const refs = structuredClone(f.refs())
  const sessionCount = f.client.sessions.size
  await f.client.session.update({ path: { id: "native" }, body: { agent: "plan" } })
  const owner = f.client.sessions.get("native")
  assert.equal(owner.parentID, undefined)
  assert.equal(owner.metadata.o4e.delegation, undefined)

  for (const action of ["status", "output"]) {
    const context = f.context()
    assert.equal(context.agent, "plan")
    const result = await f.read(created.taskID, action, context)
    assert.equal(result.taskID, created.taskID)
    assert.equal(result.status, "completed")
    assert.equal(result.output, "OK")
    assert.equal(f.asks.at(-1).agent, "plan")
    assert.equal(f.asks.at(-1).permission, "o4e_task")
    assert.deepEqual(f.asks.at(-1).patterns, [`command:${action}`])
    assert.equal(f.asks.at(-1).action, "allow")
  }
  await assert.rejects(f.bash("touch plan-after-switch.txt"), /HOST_PERMISSION_DENIED: bash/)
  assert.equal(f.asks.at(-1).agent, "plan")
  assert.equal(f.asks.at(-1).action, "deny")
  assert.deepEqual(f.asks.at(-1).patterns, ["touch plan-after-switch.txt"])
  assert.equal(existsSync(join(f.directory, "plan-after-switch.txt")), false)
  assert.deepEqual(f.refs(), refs)
  assert.equal(f.client.sessions.size, sessionCount)
  assert.deepEqual(liveProcesses(f.root), [])
  f.noDispatch()
})
