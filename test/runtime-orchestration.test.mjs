import assert from "node:assert/strict"
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { evaluate } from "../src/core/permission-rules.mjs"
import { compileWorkflowRegistry } from "../src/core/workflow-definition.mjs"
import { DelegationRuntime } from "../src/runtime/delegation-runtime.mjs"
import { createOpenCodeAgentExecutionPort } from "../src/adapters/opencode/agent-execution-port.mjs"
import { runEventPipeline } from "../src/runtime/event-pipeline.mjs"
import { createSharedScopeLockManager, normalizeWriteScopes, pathWithinScopes, ScopeLockManager } from "../src/runtime/scope-locks.mjs"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"
import { WorkflowRuntime } from "../src/runtime/workflow-runtime.mjs"
import { createDirectoryLink, createFileLink, removeLink } from "./helpers/fs-link-fixture.mjs"

function createDelegationRuntime(options) {
  return new DelegationRuntime({
    ...options,
    execution: { ...createOpenCodeAgentExecutionPort(options), ...options.execution },
  })
}

class MockOpenCodeClient {
  constructor({ prompt } = {}) {
    this.sessions = new Map()
    this.messageRecords = new Map()
    this.promptCalls = []
    this.nextSession = 1
    this.nextMessage = 1
    this.promptHandler = prompt ?? (() => ({ status: "reported-completed", output: {}, artifacts: [], evidence: [], diagnostics: [] }))
    this.session = {
      create: async ({ body }) => ({ data: this.addSession(body) }),
      get: async ({ path }) => ({ data: structuredClone(this.sessions.get(path.id)) }),
      list: async () => ({ data: [...this.sessions.values()].map((session) => structuredClone(session)) }),
      update: async ({ path, body }) => {
        const current = this.sessions.get(path.id)
        const updated = { ...current, ...structuredClone(body) }
        this.sessions.set(path.id, updated)
        return { data: structuredClone(updated) }
      },
      children: async ({ path }) => ({ data: [...this.sessions.values()].filter((session) => session.parentID === path.id).map((session) => structuredClone(session)) }),
      status: async () => ({ data: {} }),
      messages: async ({ path }) => ({ data: structuredClone(this.messageRecords.get(path.id) ?? []) }),
      prompt: async ({ path, body }) => {
        this.promptCalls.push({ sessionID: path.id, body: structuredClone(body) })
        const report = this.promptHandler({ session: this.sessions.get(path.id), body, call: this.promptCalls.length })
        const messageID = `msg_${this.nextMessage++}`
        const partID = `prt_${this.nextMessage++}`
        const result = {
          info: { id: messageID, role: "assistant", parentID: body.messageID, finish: "stop" },
          parts: [{
            id: partID,
            type: "text",
            text: report && typeof report === "object" && typeof report.__rawAssistantText === "string"
              ? report.__rawAssistantText
              : JSON.stringify(report),
          }],
        }
        const records = this.messageRecords.get(path.id) ?? []
        records.push(structuredClone(result))
        this.messageRecords.set(path.id, records)
        return { data: result }
      },
    }
  }

  addSession(body = {}) {
    const id = body.id ?? `ses_${this.nextSession++}`
    const session = {
      id,
      directory: body.directory ?? "/workspace",
      title: body.title ?? id,
      ...structuredClone(body),
    }
    delete session.id
    session.id = id
    this.sessions.set(id, session)
    return structuredClone(session)
  }
}

function runtimeAgent(overrides) {
  return {
    type: "all",
    name: "agent",
    description: "agent",
    planProfile: false,
    loadTools: ["read", "task"],
    loadSkills: ["*"],
    loadAgents: ["*"],
    loadWorkflows: ["*"],
    loadMcp: {},
    capabilities: ["task.general"],
    ...overrides,
  }
}

test("child 冻结展开后的目录规则，父批准不扩权且跨目录许可不绕过写范围", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-directory-authority-"))
  try {
    mkdirSync(join(root, "src"))
    for (const prefix of ["~", "$HOME"]) {
      const client = new MockOpenCodeClient()
      const create = client.session.create
      client.session.create = ({ body }) => create({ body: { ...body, directory: root } })
      client.addSession({ id: "parent", directory: root, permission: [{ permission: "external_directory", pattern: "*", action: "allow" }], metadata: {} })
      const requester = runtimeAgent({ name: "orchestrator", permission: { task: "ask" } })
      const target = runtimeAgent({ name: "worker", type: "subagent", loadTools: ["read", "glob", "grep", "edit"], loadAgents: [], loadWorkflows: [],
        permission: { external_directory: { "*": "deny", [`${prefix}/reference/**`]: "allow" } } })
      const agents = [requester, target]
      const runtime = createDelegationRuntime({ client, directory: root,
        snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })
      try {
        const context = { sessionID: "parent", agent: "orchestrator", directory: root }
        const prepared = await runtime.prepare({ task: "bounded directory regression", agent: "worker", writeScopes: ["src"] }, context, "task", { permissionApproved: true })
        const { child } = await runtime.createAttempt(prepared, context)
        assert.equal(prepared.requesterPermissionApproved, true)
        assert.equal(prepared.effect.kind, "scoped-write")
        assert.deepEqual(child.permission, prepared.compiledPermission)
        assert.equal(evaluate("external_directory", `${homedir()}/reference/*`, child.permission).action, "allow")
        assert.equal(evaluate("external_directory", `${homedir()}/other/*`, child.permission).action, "deny")
        for (const tool of ["task", "o4e_task", "o4e_workflow"]) assert.equal(evaluate(tool, "*", child.permission).action, "deny")
        await runtime.enforceWriteScope({ tool: "edit", sessionID: child.id }, { args: { filePath: join(root, "src/change.txt") } })
        await assert.rejects(runtime.enforceWriteScope({ tool: "edit", sessionID: child.id }, { args: { filePath: join(homedir(), "reference/change.txt") } }), /writeScopes/)
        await runtime.enforceWriteScope({ tool: "read", sessionID: child.id }, { args: { filePath: join(homedir(), "reference/context.txt") } })
      } finally { runtime.dispose() }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("不存在写路径通过最近现存父目录解析，拒绝父级符号链接逃逸", () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-scope-root-"))
  const outside = mkdtempSync(join(tmpdir(), "o4e-scope-outside-"))
  try {
    mkdirSync(join(root, "safe"))
    createDirectoryLink(outside, join(root, "linked"))
    assert.throws(() => normalizeWriteScopes(["linked/new/file.txt"], root), /真实路径超出工作目录/)
    const scopes = normalizeWriteScopes(["safe"], root)
    assert.equal(pathWithinScopes("linked/new/file.txt", scopes, root), false)
    assert.equal(pathWithinScopes("safe/new/file.txt", scopes, root), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("scoped-write 拒绝现存硬链接写入目标", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-hardlink-scope-root-"))
  const outside = mkdtempSync(join(tmpdir(), "o4e-hardlink-scope-outside-"))
  try {
    mkdirSync(join(root, "src"))
    const outsideFile = join(outside, "shared.txt")
    const scopedAlias = join(root, "src", "shared.txt")
    writeFileSync(outsideFile, "shared")
    linkSync(outsideFile, scopedAlias)
    const scopes = normalizeWriteScopes(["src"], root)
    assert.equal(pathWithinScopes("src/shared.txt", scopes, root), false)

    const client = new MockOpenCodeClient()
    client.addSession({
      id: "child",
      directory: root,
      metadata: { o4e: { delegation: { effect: "scoped-write", writeScopes: scopes } } },
    })
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents: [], agentByName: new Map() }) })
    await assert.rejects(
      runtime.enforceWriteScope(
        { sessionID: "child", tool: "edit" },
        { args: { filePath: "src/shared.txt" } },
      ),
      /写入路径不在委派 writeScopes 内/,
    )
    await assert.rejects(
      runtime.enforceWriteScope(
        { sessionID: "child", tool: "apply_patch" },
        { args: { patchText: "*** Begin Patch\n*** Delete File: src/shared.txt\n*** End Patch" } },
      ),
      /写入路径不在委派 writeScopes 内/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("scoped-write 要求词法路径和真实路径同时位于同一 Scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-symlink-entry-scope-root-"))
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "victim.txt"), "victim")
    createFileLink(join(root, "src", "victim.txt"), join(root, "outside-link"))
    const scopes = normalizeWriteScopes(["src"], root)
    assert.equal(pathWithinScopes("outside-link", scopes, root), false)

    const client = new MockOpenCodeClient()
    client.addSession({
      id: "child",
      directory: root,
      metadata: { o4e: { delegation: { effect: "scoped-write", writeScopes: scopes } } },
    })
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents: [], agentByName: new Map() }) })
    await assert.rejects(runtime.enforceWriteScope(
      { sessionID: "child", tool: "apply_patch" },
      { args: { patchText: "*** Begin Patch\n*** Delete File: outside-link\n*** End Patch" } },
    ), /写入路径不在委派 writeScopes 内/)
    await assert.rejects(runtime.enforceWriteScope(
      { sessionID: "child", tool: "apply_patch" },
      { args: { patchText: "*** Begin Patch\n*** Update File: outside-link\n*** Move to: src/moved.txt\n@@\n-victim\n+updated\n*** End Patch" } },
    ), /写入路径不在委派 writeScopes 内/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("scoped-write 对 apply_patch 的全部源目标路径 fail closed 校验", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-apply-patch-scope-"))
  try {
    mkdirSync(join(root, "src"))
    const client = new MockOpenCodeClient()
    client.addSession({
      id: "child",
      directory: root,
      metadata: {
        o4e: {
          delegation: {
            effect: "scoped-write",
            writeScopes: normalizeWriteScopes(["src"], root),
          },
        },
      },
    })
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents: [], agentByName: new Map() }) })
    const before = (patchText) => runtime.enforceWriteScope(
      { sessionID: "child", tool: "apply_patch" },
      { args: { patchText } },
    )

    await assert.doesNotReject(before(`*** Begin Patch
*** Add File: src/new file.txt
+new
*** Update File: src/current.txt
*** Move to: src/moved.txt
@@
-old
+new
*** Delete File: src/old.txt
*** End Patch`))
    await assert.doesNotReject(before(`*** Begin Patch
*** Add File: src/marker.txt
+*** Delete File: outside.txt
*** End Patch`))
    await assert.rejects(before(`*** Begin Patch
*** Add File: outside.txt
+outside
*** End Patch`), /写入路径不在委派 writeScopes 内: outside.txt/)
    await assert.rejects(before(`*** Begin Patch
*** Update File: outside.txt
*** Move to: src/moved.txt
@@
-old
+new
*** End Patch`), /outside.txt/)
    await assert.rejects(before(`*** Begin Patch
*** Update File: src/current.txt
*** Move to: outside.txt
@@
-old
+new
*** End Patch`), /outside.txt/)
    await assert.rejects(before(`*** Begin Patch
*** Add File: src/inside.txt
+inside
*** Delete File: outside.txt
*** End Patch`), /outside.txt/)
    await assert.rejects(before(`*** Begin Patch
*** Move to: src/moved.txt
*** End Patch`), /Move to 必须紧跟 Update File/)
    await assert.rejects(before(`*** Begin Patch
*** Copy File: src/copied.txt
*** End Patch`), /无法识别的操作/)
    await assert.rejects(before("*** Begin Patch\n*** End Patch"), /未包含文件操作/)
    await assert.rejects(runtime.enforceWriteScope(
      { sessionID: "child", tool: "apply_patch" },
      { args: {} },
    ), /必须提供 patchText/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Scope Lock 对冲突写入排队，并允许不重叠 scoped-write 并行", async () => {
  const locks = new ScopeLockManager()
  await locks.acquire("first", { kind: "scoped-write", writeScopes: ["/workspace/src"] })
  let secondAcquired = false
  const waiting = locks.acquire("second", { kind: "unknown-write" }).then(() => { secondAcquired = true })
  await Promise.resolve()
  assert.equal(secondAcquired, false)
  locks.release("first")
  await waiting
  assert.equal(secondAcquired, true)
  locks.release("second")

  await locks.acquire("left", { kind: "scoped-write", writeScopes: ["/workspace/src"] })
  await locks.acquire("right", { kind: "scoped-write", writeScopes: ["/workspace/docs"] })
  locks.release("left")
  locks.release("right")
})

test("共享 Scope Lock facade 释放时将 active owner 托管给存活实例", async () => {
  const key = `scope-lock-handoff-${Date.now()}-${Math.random()}`
  const first = createSharedScopeLockManager(key)
  const second = createSharedScopeLockManager(key)
  await first.acquire("active", { kind: "unknown-write" })
  let acquired = false
  const waiting = second.acquire("waiting", { kind: "unknown-write" }).then(() => { acquired = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(acquired, false)

  first.clear()
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(acquired, false)

  second.release("active")
  await waiting
  assert.equal(acquired, true)
  second.release("waiting")
  second.clear()
})

test("共享 Scope Lock facade 释放时托管尚未返回的 acquire", async () => {
  const key = `scope-lock-pending-handoff-${Date.now()}-${Math.random()}`
  const first = createSharedScopeLockManager(key)
  const second = createSharedScopeLockManager(key)
  const acquired = first.acquire("active", { kind: "unknown-write" })

  first.clear()
  await acquired
  assert.equal(second.has("active"), true)

  let waitingAcquired = false
  const waiting = second.acquire("waiting", { kind: "unknown-write" }).then(() => { waitingAcquired = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(waitingAcquired, false)
  second.release("active")
  await waiting
  assert.equal(waitingAcquired, true)
  second.release("waiting")
  second.clear()
})

test("已释放的共享 Scope Lock facade 不得重新恢复 owner", () => {
  const key = `scope-lock-closed-facade-${Date.now()}-${Math.random()}`
  const first = createSharedScopeLockManager(key)
  const second = createSharedScopeLockManager(key)

  first.clear()
  first.restore("late", { kind: "unknown-write" })
  assert.equal(second.has("late"), false)

  second.clear()
})

test("共享 Scope Lock 迟到的 closed facade release 不影响 successor owner", async () => {
  const key = `scope-lock-late-closed-release-${Date.now()}-${Math.random()}`
  const first = createSharedScopeLockManager(key)
  const second = createSharedScopeLockManager(key)

  await first.acquire("active", { kind: "unknown-write" })
  let waitingAcquired = false
  const waiting = second.acquire("waiting", { kind: "unknown-write" }).then(() => { waitingAcquired = true })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  first.clear()
  first.release("active")
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(waitingAcquired, false)
  assert.equal(second.has("active"), true)

  second.release("active")
  await waiting
  assert.equal(waitingAcquired, true)
  second.release("waiting")
  second.clear()
})

test("共享 Scope Lock 将目录词法别名和符号链接归并为同一 key", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-scope-lock-directory-key-"))
  const alias = `${root}-alias`
  try {
    createDirectoryLink(root, alias)
    const first = createSharedScopeLockManager(root)
    const second = createSharedScopeLockManager(`${root}/.`)
    const third = createSharedScopeLockManager(alias)
    await first.acquire("active", { kind: "unknown-write" })
    let acquired = false
    const waiting = third.acquire("waiting", { kind: "unknown-write" }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)
    assert.equal(second.has("active"), true)
    first.release("active")
    await waiting
    assert.equal(acquired, true)
    third.release("waiting")
    third.clear()
    second.clear()
    first.clear()
  } finally {
    removeLink(alias)
    rmSync(root, { recursive: true, force: true })
  }
})

test("process-v1 Workflow 定义在持久化前拒绝旧 Agent Step 字段", () => {
  assert.throws(() => compileWorkflowRegistry([{ source: "workflows/legacy-agent.jsonc", value: {
    name: "legacy-agent",
    description: "legacy delegated workflow",
    visibility: "entry",
    output: { result: { $from: "steps", path: "/work" } },
    steps: [{
      id: "work",
      type: "agent",
      agent: { preferred: "worker", fallback: "none" },
      skill: "task.general",
      effect: "scoped-write",
      task: { description: "work" },
      writeScopes: ["../outside"],
    }],
  } }]), /contract 必须是 process-v1|不支持字段|只支持 work/)
})

test("OpenCode Session Store 原样持久化 metadata 和 permission，并串行合并 O4E 状态", async () => {
  const client = new MockOpenCodeClient()
  const store = new OpenCodeSessionStore(client, "/workspace")
  const created = await store.create({
    parentID: "parent",
    title: "child",
    agent: "researcher",
    metadata: { o4e: { kind: "test", count: 0 } },
    permission: [{ permission: "bash", pattern: "*", action: "deny" }],
  })
  assert.equal(created.agent, "researcher")
  assert.equal(created.metadata.o4e.kind, "test")
  assert.equal(created.permission[0].action, "deny")

  await Promise.all([
    store.updateO4E(created.id, (state) => ({ ...state, left: true })),
    store.updateO4E(created.id, (state) => ({ ...state, right: true })),
  ])
  const current = await store.get(created.id)
  assert.equal(current.metadata.o4e.left, true)
  assert.equal(current.metadata.o4e.right, true)
})

test("OpenCode Session Store 写入传播失败且不阻塞后续 O4E 合并", async () => {
  const client = new MockOpenCodeClient()
  const store = new OpenCodeSessionStore(client, "/workspace")
  const session = await store.create({ title: "queued", metadata: { o4e: { initial: true } } })
  const update = client.session.update
  client.session.update = async (request) => {
    if (request.body.metadata?.o4e?.fail) throw new Error("write failed")
    return update(request)
  }
  const failed = assert.rejects(store.updateO4E(session.id, (state) => ({ ...state, fail: true })), /write failed/)
  const merged = store.updateO4E(session.id, (state) => ({ ...state, merged: true }))
  const patched = store.updateO4E(session.id, (state) => ({ ...state, recovered: true }))
  await Promise.all([failed, merged, patched])
  const current = await store.get(session.id)
  assert.deepEqual(current.metadata.o4e, { initial: true, merged: true, recovered: true })
})

test("Session 写入旧尾项完成不会解除后继串行，其他 Session 可独立推进", async () => {
  const client = new MockOpenCodeClient()
  const store = new OpenCodeSessionStore(client, "/workspace")
  const target = await store.create({ title: "target", metadata: { o4e: {} } })
  const other = await store.create({ title: "other" })
  const update = client.session.update
  let releaseSecond
  const gate = new Promise((resolvePromise) => { releaseSecond = resolvePromise })
  client.session.update = async (request) => {
    if (request.body.metadata?.o4e?.second) await gate
    return update(request)
  }

  const first = store.updateO4E(target.id, (state) => ({ ...state, first: true }))
  const second = store.updateO4E(target.id, (state) => ({ ...state, second: true }))
  await first
  let thirdStarted = false
  const third = store.updateO4E(target.id, (state) => {
    thirdStarted = true
    return { ...state, third: true }
  })
  let otherFinished = false
  const independent = store.updateO4E(other.id, (state) => ({ ...state, independent: true })).then(() => { otherFinished = true })
  try {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(thirdStarted, false)
    assert.equal(otherFinished, true)
  } finally {
    releaseSecond()
    await Promise.all([second, third, independent])
  }
  assert.deepEqual((await store.get(target.id)).metadata.o4e, { first: true, second: true, third: true })
})

test("OpenCode Session Store 将目录别名归并到同一 update queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-session-store-directory-key-"))
  const alias = `${root}-alias`
  try {
    createDirectoryLink(root, alias)
    const client = new MockOpenCodeClient()
    const session = client.addSession({ id: "session", directory: root, metadata: {} })
    const first = new OpenCodeSessionStore(client, root)
    const second = new OpenCodeSessionStore(client, alias)
    const originalUpdate = client.session.update
    let firstUpdateBlocked = false
    let releaseFirst
    let firstUpdateStarted
    const firstUpdateSeen = new Promise((resolvePromise) => { firstUpdateStarted = resolvePromise })
    client.session.update = async (request) => {
      if (!firstUpdateBlocked && request.body?.metadata?.o4e?.first) {
        firstUpdateBlocked = true
        firstUpdateStarted()
        await new Promise((resolvePromise) => { releaseFirst = resolvePromise })
      }
      return originalUpdate(request)
    }

    const updatingFirst = first.updateO4E(session.id, (state) => ({ ...state, first: true }))
    await firstUpdateSeen
    let secondTransformCalled = false
    const updatingSecond = second.updateO4E(session.id, (state) => {
      secondTransformCalled = true
      return { ...state, second: true }
    })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(secondTransformCalled, false)
    releaseFirst()
    await Promise.all([updatingFirst, updatingSecond])
    assert.equal(client.sessions.get(session.id).metadata.o4e.first, true)
    assert.equal(client.sessions.get(session.id).metadata.o4e.second, true)
  } finally {
    removeLink(alias)
    rmSync(root, { recursive: true, force: true })
  }
})

test("Session Store 与 Execution Port 按宿主契约区分 Session 模型与 Prompt variant", async () => {
  const client = new MockOpenCodeClient()
  const store = new OpenCodeSessionStore(client, "/workspace")
  const created = await store.create({
    title: "variant",
    model: { providerID: "provider", modelID: "model", variant: "high" },
  })
  await createOpenCodeAgentExecutionPort({ client, directory: "/workspace" }).runTurn({
    sessionID: created.id,
    model: { providerID: "provider", modelID: "model", variant: "high" },
    parts: [{ type: "text", text: "inspect" }],
  })

  assert.deepEqual(created.model, { id: "model", providerID: "provider", variant: "high" })
  assert.deepEqual(client.promptCalls[0].body.model, { providerID: "provider", modelID: "model" })
  assert.equal(client.promptCalls[0].body.variant, "high")
})

test("受控委派创建一级子 Session、应用收紧权限并保留消息引用", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-"))
  try {
    const client = new MockOpenCodeClient({ prompt: () => ({ status: "reported-completed", output: { ok: true }, artifacts: [], evidence: ["checked"], diagnostics: [] }) })
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["bash", "read", "edit", "task"] })
    const target = runtimeAgent({ name: "debugger", loadTools: ["bash", "read", "edit"] })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })
    const result = JSON.parse(await runtime.delegate({
      task: "diagnose",
      agent: "debugger",
      permissionOverlay: { bash: "deny", external_directory: "deny" },
      writeScopes: ["src"],
    }, { sessionID: "parent", agent: "orchestrator", directory: root }))

    assert.equal(result.status, "reported-completed")
    assert.equal(result.effect, "scoped-write")
    assert.equal(typeof result.messageID, "string")
    const child = client.sessions.get(result.sessionID)
    assert.equal(child.parentID, "parent")
    assert.equal(child.metadata.o4e.delegation.depth, 1)
    assert.equal(child.permission.some((rule) => rule.permission === "bash" && rule.action === "deny"), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("委派直接拒绝 functions.* permissionOverlay 而不是退化为无候选", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-overlay-namespace-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadAgents: ["worker"] })
    const target = runtimeAgent({ name: "worker", type: "subagent", loadTools: ["read"] })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      snapshot: () => ({ agents, allAgents: agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.prepare({
      task: "inspect",
      agent: "worker",
      permissionOverlay: { "functions.apply_patch": "deny" },
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), /请改用 edit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("受管 task 的 ask 目标仅在本次授权后冻结并允许重验", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-task-ask-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({
      name: "orchestrator",
      permission: { task: { "*": "deny", worker: "ask" } },
    })
    const target = runtimeAgent({ name: "worker", type: "subagent" })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })
    const context = { sessionID: "parent", agent: "orchestrator", directory: root }

    await assert.rejects(
      runtime.prepare({ task: "inspect", agent: "worker" }, context, "task"),
      /尚未获得本次授权/,
    )
    const prepared = await runtime.prepare({ task: "inspect", agent: "worker" }, context, "task", { permissionApproved: true })
    assert.equal(prepared.requesterPermissionAction, "ask")
    assert.equal(prepared.requesterPermissionApproved, true)
    assert.equal((await runtime.revalidateAttempt(prepared, "parent")).target.name, "worker")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Task 重验拒绝已不存在的 Agent 名称", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-missing-agent-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    let requester = runtimeAgent({ name: "orchestrator-plan", planProfile: true, planOverrides: { loadAgents: true }, loadAgents: ["*"] })
    let target = runtimeAgent({ name: "worker-plan", type: "subagent", planProfile: true, loadTools: ["read"] })
    let agents = [requester, target]
    const snapshot = () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) })
    const runtime = createDelegationRuntime({ client, directory: root, snapshot })
    const prepared = await runtime.prepare(
      { task: "inspect", agent: "worker-plan" },
      { sessionID: "parent", agent: "orchestrator-plan", directory: root },
    )

    requester = runtimeAgent({ name: "orchestrator (plan)", planProfile: true, planOverrides: { loadAgents: true }, loadAgents: ["*"] })
    target = runtimeAgent({ name: "worker (plan)", type: "subagent", planProfile: true, loadTools: ["read"] })
    agents = [requester, target]
    await assert.rejects(runtime.revalidateAttempt(prepared, "parent"), /发起 Agent.*orchestrator-plan/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Task 冻结宿主收紧后的授权并在重验时读取当前 owner，读取失败不沿用旧授权", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-task-owner-authority-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", permission: { task: "allow" } })
    const worker = runtimeAgent({ name: "worker", type: "subagent" })
    const agents = [requester, worker]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((entry) => [entry.name, entry])) }) })
    const context = { sessionID: "parent", agent: "orchestrator", directory: root }
    const args = { task: "inspect", agent: "worker" }
    const allowed = await runtime.prepare(args, context)
    const session = client.sessions.get("parent")
    session.permission = [{ permission: "task", pattern: "worker", action: "ask" }]
    await assert.rejects(runtime.revalidateAttempt(allowed, "parent"), /未明确允许 task/)
    await assert.rejects(runtime.prepare(args, context), /尚未获得本次授权/)
    const approved = await runtime.prepare(args, context, "task", { permissionApproved: true })
    assert.equal(approved.requesterPermissionAction, "ask")
    assert.equal(approved.requesterPermissionApproved, true)
    assert.equal((await runtime.revalidateAttempt(approved, "parent")).authorizationFingerprint, approved.authorizationFingerprint)
    session.permission.push({ permission: "task", pattern: "another-worker", action: "deny" })
    assert.equal((await runtime.revalidateAttempt(approved, "parent")).authorizationFingerprint, approved.authorizationFingerprint)
    session.permission = [{ permission: "task", pattern: "worker", action: "deny" }]
    await assert.rejects(runtime.revalidateAttempt(approved, "parent"), /未明确允许 task/)
    await assert.rejects(runtime.prepare(args, context, "task", { permissionApproved: true }), /拒绝 task/)
    session.permission[0].action = "allow"
    requester.permission.task = "ask"
    await assert.rejects(runtime.prepare(args, context), /尚未获得本次授权/)
    requester.permission.task = "deny"
    await assert.rejects(runtime.prepare(args, context, "task", { permissionApproved: true }), /拒绝 task/)
    const get = client.session.get
    client.session.get = async () => { throw new Error("owner read failed") }
    await assert.rejects(runtime.revalidateAttempt(approved, "parent"), /owner read failed/)
    client.session.get = get
    client.sessions.delete("parent")
    await assert.rejects(runtime.revalidateAttempt(approved, "parent"), /owner Session 无法验证/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("委派参数错误不会伪装成 selection 失败，canonical task 的 Plan Profile 冲突抛出结构化错误", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-args-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator" })
    const reviewer = runtimeAgent({ name: "reviewer", planProfile: true, loadTools: ["read", "glob", "grep"] })
    const agents = [requester, reviewer]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })
    const context = { sessionID: "parent", agent: "orchestrator", directory: root }

    await assert.rejects(
      runtime.delegate({
        task: "review",
        agent: "reviewer",
        plan: false,
        permissionOverlay: { ask: "deny", deny: "allow" },
        writeScopes: [],
      }, context),
      /permissionOverlay 的 key 必须是权限名，不能是动作 ask/,
    )

    await assert.rejects(
      runtime.delegate({ task: "review", agent: "reviewer", permissionOverlay: { bash: "ask" } }, context),
      /permissionOverlay\.bash 不能把 deny 扩大为 ask/,
    )

    await assert.rejects(
      runtime.delegate({ task: "review", agent: "reviewer", plan: false }, context),
      (error) => {
        assert.equal(error?.code, "O4E_TASK_SELECTION_FAILED")
        assert.equal(error.response.status, "agent-incompatible")
        assert.equal(error.response.reason, "plan-profile-mismatch")
        assert.equal(error.response.actualPlan, true)
        assert.match(error.response.next, /Omit plan or set plan=true/)
        return true
      },
    )

    const delegated = JSON.parse(await runtime.delegate({ task: "review", agent: "reviewer" }, context))
    assert.equal(delegated.status, "reported-completed")
    assert.equal(delegated.sourceAgent, "reviewer")
    assert.equal(client.promptCalls.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("受管 task 在目标未配置模型时冻结父 Session 当前模型", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-parent-model-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({
      id: "parent",
      directory: root,
      metadata: {},
      model: { id: "selected", providerID: "provider", variant: "high" },
    })
    const requester = runtimeAgent({ name: "orchestrator" })
    const target = runtimeAgent({ name: "worker", type: "subagent", models: [] })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })

    const prepared = await runtime.prepare(
      { task: "inspect", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    )
    const attempt = await runtime.createAttempt(prepared, { sessionID: "parent" }, { dispatchMessageID: "msg_dispatch" })

    assert.deepEqual(prepared.modelCandidates, [{ providerID: "provider", modelID: "selected", variant: "high" }])
    assert.deepEqual(attempt.child.model, { id: "selected", providerID: "provider", variant: "high" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("受管 task 拒绝不可用配置候选而不是静默使用父模型", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-unavailable-model-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({
      id: "parent",
      directory: root,
      metadata: {},
      model: { id: "selected", providerID: "provider", variant: "high" },
    })
    const requester = runtimeAgent({ name: "orchestrator" })
    const target = runtimeAgent({
      name: "worker",
      type: "subagent",
      models: [{ providerID: "missing", modelID: "configured" }],
      resolvedModels: [],
    })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({ client, directory: root, snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }) })

    await assert.rejects(runtime.prepare(
      { task: "inspect", agent: "worker" },
      { sessionID: "parent", agent: "orchestrator", directory: root },
    ), /没有可用模型候选/)
    target.resolvedModels = [{ providerID: "available", modelID: "fallback", variant: "low" }]
    const prepared = await runtime.prepare({ task: "inspect", agent: "worker" }, { sessionID: "parent", agent: "orchestrator", directory: root })
    assert.deepEqual(prepared.modelCandidates, target.resolvedModels)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("父级 abort 取消前台子 Session，并在取消确认后释放 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-abort-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let resolveTurn
    const turn = new Promise((resolvePromise) => { resolveTurn = resolvePromise })
    const cancelled = []
    const execution = {
      runTurn: () => turn,
      cancelTurn: async ({ sessionID }) => {
        cancelled.push(sessionID)
        return { acknowledged: true }
      },
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const controller = new AbortController()
    let childSessionID
    const delegated = runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
      abort: controller.signal,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    while (!childSessionID) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    controller.abort(new Error("parent aborted"))
    resolveTurn({ info: { id: "assistant", role: "assistant" }, parts: [] })
    await assert.rejects(delegated, /parent aborted/)
    assert.deepEqual(cancelled, [childSessionID])
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "cancelled")
    assert.equal(typeof client.sessions.get(childSessionID).metadata.o4e.delegation.cancellationRequestedAt, "number")

    await locks.acquire("next", { kind: "unknown-write" })
    locks.release("next")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("前台取消终态 metadata 写失败时持锁并自动重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-abort-persist-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let resolveTurn
    const turn = new Promise((resolvePromise) => { resolveTurn = resolvePromise })
    const execution = {
      runTurn: () => turn,
      cancelTurn: async () => ({ acknowledged: true }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const controller = new AbortController()
    let childSessionID
    const delegated = runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
      abort: controller.signal,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    while (!childSessionID) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === childSessionID && request.body.metadata?.o4e?.delegation?.status === "cancelled" && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }

    controller.abort(new Error("parent aborted"))
    resolveTurn({ info: { id: "assistant", role: "assistant" }, parts: [] })
    await assert.rejects(delegated, (error) => error?.code === "O4E_DELEGATION_UNCERTAIN" && error.retainLock === true)
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "cancelled")
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("前台取消未确认时保守持有 Scope Lock，并在重载对账停止后释放", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-abort-unconfirmed-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let rejectTurn
    const turn = new Promise((_resolvePromise, rejectPromise) => { rejectTurn = rejectPromise })
    let inspectionState = "running"
    const execution = {
      runTurn: () => turn,
      cancelTurn: async () => ({ acknowledged: false }),
      inspectTurn: async () => ({ state: inspectionState }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const controller = new AbortController()
    let childSessionID
    const delegated = runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
      abort: controller.signal,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    while (!childSessionID) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    controller.abort(new Error("parent aborted"))
    rejectTurn(new Error("transport interrupted"))
    await assert.rejects(delegated, (error) => error?.code === "O4E_DELEGATION_UNCERTAIN" && /cancel-unconfirmed/.test(error.message))
    const child = client.sessions.get(childSessionID)
    assert.equal(child.metadata.o4e.delegation.status, "unknown")
    assert.match(child.metadata.o4e.delegation.diagnostics, /cancel-unconfirmed/)

    const blocked = new AbortController()
    let acquired = false
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    runtime.dispose()
    const recoveredLocks = new ScopeLockManager()
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks: recoveredLocks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await recovered.recoverSession("parent")
    const recoveredBlocked = new AbortController()
    let recoveredAcquired = false
    const recoveredWaiting = recoveredLocks.acquire("next", { kind: "unknown-write" }, { signal: recoveredBlocked.signal }).then(() => { recoveredAcquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(recoveredAcquired, false)

    inspectionState = "idle"
    await recovered.observeEvent({ kind: "session-idle", sessionID: childSessionID })
    await recoveredWaiting
    assert.equal(recoveredAcquired, true)
    recoveredLocks.release("next")
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "cancelled")
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("前台写委派传输中断时进入不确定状态并保守持有 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-transport-uncertain-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: inspectionState }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.delegation.status, "unknown")
    assert.match(child.metadata.o4e.delegation.diagnostics, /dispatch-unconfirmed/)

    const blocked = new AbortController()
    let acquired = false
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)

    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    await waiting
    assert.equal(acquired, true)
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("前台写委派遇到未知 inspection 状态时不结算也不释放 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-unknown-inspection-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: "unknown" }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.delegation.status, "unknown")
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步传输失败后即时对账到结果时直接返回完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-immediate-reconcile-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspections = 0
    let dispatchMessageID
    const recoveredResult = {
      get info() { return { id: "assistant-recovered", role: "assistant", parentID: dispatchMessageID, finish: "stop" } },
      parts: [{ id: "part-recovered", type: "text", text: "recovered" }],
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async ({ messageID }) => { dispatchMessageID = messageID; throw new Error("transport interrupted") },
        inspectTurn: async () => (++inspections === 1 ? { state: "running" } : { state: "idle", result: recoveredResult }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    const result = JSON.parse(await runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }))
    assert.equal(result.status, "reported-completed")
    assert.equal(result.output, "recovered")
    const child = client.sessions.get(result.sessionID)
    assert.equal(child.metadata.o4e.delegation.status, "reported-completed")
    assert.deepEqual(child.metadata.o4e.delegation.result, { messageID: "assistant-recovered", partIDs: ["part-recovered"] })
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步传输失败后的 inspection 同时包含 error 和 result 时错误优先", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-error-first-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read"] })
    const agents = [requester, target]
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({
          state: "idle",
          error: { name: "APIError", data: { message: "failed" } },
          result: {
            info: { id: "assistant-recovered", role: "assistant" },
            parts: [{ id: "part-recovered", type: "text", text: "must not complete" }],
          },
        }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "inspect", agent: "worker" }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), /transport interrupted/)
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.delegation.status, "failed")
    assert.equal(child.metadata.o4e.delegation.result, undefined)
    assert.match(child.metadata.o4e.delegation.diagnostics, /reconciled-error/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步传输失败后的机械对账窗口仍由前台 Runtime 接管错误事件", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-transport-reconcile-fallback-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator" })
    const target = runtimeAgent({ name: "worker" })
    const agents = [requester, target]
    let dispatchMessageID
    const recoveredResult = {
      get info() { return { id: "assistant-recovered", role: "assistant", parentID: dispatchMessageID, finish: "stop" } },
      parts: [{ id: "part-recovered", type: "text", text: "recovered" }],
    }
    let signalInspection
    let releaseInspection
    const inspectionStarted = new Promise((resolvePromise) => { signalInspection = resolvePromise })
    const inspectionBlocked = new Promise((resolvePromise) => { releaseInspection = resolvePromise })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        runTurn: async ({ messageID }) => { dispatchMessageID = messageID; throw new Error("transport interrupted") },
        inspectTurn: async () => {
          signalInspection()
          await inspectionBlocked
          return { state: "idle", result: recoveredResult }
        },
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    let childSessionID
    const delegated = runtime.delegate({ task: "inspect", agent: "worker" }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    await inspectionStarted
    const captured = runtime.captureEvent({ kind: "error", sessionID: childSessionID, error: "retryable" })
    releaseInspection()
    const response = JSON.parse(await delegated)
    assert.equal(response.status, "reported-completed")

    let observerCalls = 0
    const request = await runEventPipeline(captured, {
      taskObserver: async (event) => { observerCalls += 1; return runtime.observeEvent(event) },
    })
    assert.equal(request, null)
    assert.equal(observerCalls, 1)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("flush 中止等待 Scope Lock 的前台委派", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-lock-admission-dispose-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    await locks.acquire("holder", { kind: "unknown-write" })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: { runTurn: async () => { throw new Error("must not run") } },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const delegated = runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    const flushing = runtime.flush()
    await assert.rejects(delegated, /正在释放/)
    await Promise.race([
      flushing,
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("flush deadlocked")), 100)),
    ])
    assert.equal([...client.sessions.values()].some((session) => session.parentID === "parent"), false)
    locks.release("holder")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("createAttempt 响应后遇到 flush 会持久化取消且不启动回合", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-create-dispose-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const originalCreate = client.session.create
    let releaseCreate
    let createStarted = false
    client.session.create = async (request) => {
      createStarted = true
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise })
      return originalCreate(request)
    }
    let runCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: { runTurn: async () => { runCalls += 1 } },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const delegated = runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    })
    while (!createStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const flushing = runtime.flush()
    releaseCreate()

    await assert.rejects(delegated, /正在释放/)
    await flushing
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(runCalls, 0)
    assert.equal(child.metadata.o4e.delegation.status, "cancelled")
    assert.equal(typeof child.metadata.o4e.delegation.cancellationRequestedAt, "number")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("createAttempt 响应后 flush 的取消落盘失败仍保留写锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-create-dispose-persist-"))
  let runtime
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const agents = [
      runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] }),
      runtimeAgent({ name: "worker", loadTools: ["read", "edit"] }),
    ]
    const locks = new ScopeLockManager()
    const originalCreate = client.session.create
    let releaseCreate
    client.session.create = async (request) => {
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise })
      return originalCreate(request)
    }
    const originalUpdate = client.session.update
    let failCancellation = true
    client.session.update = async (request) => {
      if (failCancellation && request.body.metadata?.o4e?.delegation?.cancellationRequestedAt) {
        throw new Error("cancellation metadata unavailable")
      }
      return originalUpdate(request)
    }
    let runCalls = 0
    runtime = createDelegationRuntime({
      client, directory: root, locks,
      execution: { runTurn: async () => { runCalls += 1 }, cancelTurn: async () => ({ acknowledged: true }) },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const delegated = runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    })
    while (!releaseCreate) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const rejectedDelegation = assert.rejects(delegated, /cancellation metadata unavailable/)
    const rejectedFlush = assert.rejects(runtime.flush(), /cancellation metadata unavailable/)
    releaseCreate()
    await Promise.all([rejectedDelegation, rejectedFlush])
    assert.equal(runCalls, 0)

    const blocked = new AbortController()
    const waiting = locks.acquire("other-writer", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("cancellation not persisted"))
    await assert.rejects(waiting, /cancellation not persisted/)

    failCancellation = false
    await runtime.flush()
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.delegation.status, "cancelled")
    assert.equal(runCalls, 0)
    await locks.acquire("after-persistence", { kind: "unknown-write" })
    locks.release("after-persistence")
  } finally {
    runtime?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test("删除不确定前台 Attempt 时取消未确认会写入 tombstone 并继续持锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-deleted-uncertain-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    let cancellationAcknowledged = false
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: inspectionState }),
      cancelTurn: async () => ({ acknowledged: cancellationAcknowledged }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)

    await runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(tombstone.metadata.o4e.delegation.status, "unknown")
    assert.match(tombstone.metadata.o4e.delegation.diagnostics, /deleted-cancel-unconfirmed/)

    runtime.dispose()
    const recoveredLocks = new ScopeLockManager()
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks: recoveredLocks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await recovered.recoverSession("parent")
    const blocked = new AbortController()
    let acquired = false
    const waiting = recoveredLocks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)

    inspectionState = "missing"
    cancellationAcknowledged = true
    await recovered.observeEvent({ kind: "session-idle", sessionID: child.id })
    await waiting
    assert.equal(acquired, true)
    assert.equal(client.sessions.get(tombstone.id).metadata.o4e.delegation.status, "cancelled")
    recoveredLocks.release("next")
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("删除不确定前台 Attempt 且 cancelTurn 不可用时继续持锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-deleted-no-cancel-port-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.session.abort = async () => { throw new Error("session missing") }
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: "running" }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)
    assert.deepEqual(await runtime.observeEvent({ kind: "deleted", sessionID: child.id }), { managed: true, settled: false })

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(tombstone.metadata.o4e.delegation.status, "unknown")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步 Prompt 传输失败且 Session missing 时取消未确认会持锁并写入 tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-initial-missing-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: "missing" }),
      cancelTurn: async () => ({ acknowledged: false }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN" && error.retainLock === true)
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID)
    assert.match(tombstone.metadata.o4e.delegation.diagnostics, /deleted-cancel-unconfirmed/)

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步 Prompt 首次 missing 且取消已确认时 tombstone 写失败仍可由 flush 结算", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-initial-missing-confirmed-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const originalCreate = client.session.create
    let tombstoneCreateCalls = 0
    client.session.create = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.executionSessionID) {
        tombstoneCreateCalls += 1
        if (tombstoneCreateCalls === 1) throw new Error("tombstone metadata unavailable")
      }
      return originalCreate(request)
    }
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async ({ sessionID }) => {
          client.sessions.delete(sessionID)
          return { state: "missing" }
        },
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: true } },
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN" && error.retainLock === true)
    assert.equal(cancelCalls, 1)

    const blocked = new AbortController()
    const waiting = locks.acquire("blocked", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    await runtime.flush()
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID)
    assert.equal(tombstoneCreateCalls, 2)
    assert.equal(tombstone.metadata.o4e.delegation.status, "cancelled")
    assert.equal(Number.isFinite(tombstone.metadata.o4e.delegation.cancellationConfirmedAt), true)
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("不确定 Attempt tombstone 首次创建失败后自动重试并可重载恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-tombstone-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: "running" }),
      cancelTurn: async () => ({ acknowledged: false }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)
    const originalCreate = client.session.create
    let failOnce = true
    client.session.create = async (request) => {
      if (failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalCreate(request)
    }

    const first = await runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    assert.deepEqual(first, { managed: true, settled: false })
    assert.equal([...client.sessions.values()].some((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id), false)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(tombstone.metadata.o4e.delegation.status, "unknown")

    runtime.dispose()
    const recoveredLocks = new ScopeLockManager()
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks: recoveredLocks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await recovered.recoverSession("parent")
    const blocked = new AbortController()
    const waiting = recoveredLocks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("删除不确定 Attempt tombstone 会重新写入记录并继续持锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-tombstone-deleted-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: "running" }),
      cancelTurn: async () => ({ acknowledged: false }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)
    await runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    const firstTombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)

    const tombstoneIdle = await runtime.observeEvent({ kind: "session-idle", sessionID: firstTombstone.id })
    assert.deepEqual(tombstoneIdle, { managed: true, settled: false })
    client.sessions.delete(firstTombstone.id)

    const observed = await runtime.observeEvent({ kind: "deleted", sessionID: firstTombstone.id })
    assert.deepEqual(observed, { managed: true, settled: false })
    const replacement = [...client.sessions.values()].find((session) => session.id !== firstTombstone.id && session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(replacement.metadata.o4e.delegation.status, "unknown")

    runtime.dispose()
    const recoveredLocks = new ScopeLockManager()
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks: recoveredLocks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await recovered.recoverSession("parent")
    const blocked = new AbortController()
    const waiting = recoveredLocks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("删除 sibling record 不会把仍存在的 execution 误判为 missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-record-deleted-completion-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const common = {
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "dispatch",
      scopeLockID: "lock",
    }
    client.addSession({
      id: "execution",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: { ...common, status: "unknown" } } },
    })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        ...common,
        status: "reported-completed",
        executionSessionID: "execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => null,
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: true } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    client.sessions.delete("record")
    assert.deepEqual(await runtime.observeEvent({ kind: "deleted", sessionID: "record" }), { managed: true, settled: true })

    const stored = client.sessions.get("execution").metadata.o4e.delegation
    assert.equal(cancelCalls, 1)
    assert.equal(stored.status, "reported-completed")
    assert.deepEqual(stored.result, { messageID: "assistant", partIDs: ["part"] })
    assert.equal(stored.cancellationConfirmedAt, undefined)
    await locks.acquire("next", { kind: "unknown-write" })
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("不确定 Attempt 终态 metadata 写失败时继续跟踪并保留 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-settle-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: inspectionState }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === child.id && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }
    inspectionState = "idle"
    await assert.rejects(runtime.observeEvent({ kind: "session-idle", sessionID: child.id }), /metadata unavailable/)

    const blocked = new AbortController()
    let acquired = false
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)

    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    await waiting
    assert.equal(acquired, true)
    assert.equal(client.sessions.get(child.id).metadata.o4e.delegation.status, "unknown")
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("终态写失败后的 active 证据会使旧 idle settlement 失效", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-stale-settlement-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: inspectionState }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === child.id && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }

    inspectionState = "idle"
    await assert.rejects(runtime.observeEvent({ kind: "session-idle", sessionID: child.id }), /metadata unavailable/)
    inspectionState = "running"
    await runtime.observeEvent({ kind: "session-status", sessionID: child.id, status: { type: "busy" } })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.sessions.get(child.id).metadata.o4e.delegation.status, "unknown")

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步回合期间入队的宿主 idle 和 busy 延迟处理时仍被忽略", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-foreground-pending-events-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let resolveTurn
    let signalTurnStarted
    let signalTerminalUpdate
    let releaseTerminalUpdate
    const turnStarted = new Promise((resolvePromise) => { signalTurnStarted = resolvePromise })
    const terminalUpdateStarted = new Promise((resolvePromise) => { signalTerminalUpdate = resolvePromise })
    const terminalUpdateBlocked = new Promise((resolvePromise) => { releaseTerminalUpdate = resolvePromise })
    const pendingTurn = new Promise((resolvePromise) => { resolveTurn = resolvePromise })
    let dispatchMessageID
    const result = {
      get info() { return { id: "assistant-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" } },
      parts: [{ id: "part-result", type: "text", text: "completed" }],
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async ({ messageID }) => {
          dispatchMessageID = messageID
          signalTurnStarted()
          return pendingTurn
        },
        inspectTurn: async () => ({ state: "idle" }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const originalUpdate = client.session.update
    client.session.update = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
        signalTerminalUpdate()
        await terminalUpdateBlocked
      }
      return originalUpdate(request)
    }

    let childSessionID
    let delegatedSettled = false
    const delegated = runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    }).finally(() => { delegatedSettled = true })
    await turnStarted

    const staleIdle = runtime.captureEvent({ kind: "session-idle", sessionID: childSessionID })
    const staleBusy = runtime.captureEvent({ kind: "session-status", sessionID: childSessionID, status: { type: "busy" } })
    resolveTurn(result)
    await terminalUpdateStarted

    assert.deepEqual(await runtime.observeEvent(staleIdle), { managed: true, settled: false })
    assert.deepEqual(await runtime.observeEvent(staleBusy), { managed: true, settled: false })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(delegatedSettled, false)
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "running")

    releaseTerminalUpdate()
    const response = JSON.parse(await delegated)
    assert.equal(response.status, "reported-completed")
    assert.equal(response.output, "completed")
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "reported-completed")
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步回合返回后的迟到 busy 在宿主已 idle 时不失效结果", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-stale-active-after-result-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let dispatchMessageID
    const result = {
      get info() { return { id: "assistant-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" } },
      parts: [{ id: "part-result", type: "text", text: "completed" }],
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async ({ messageID }) => { dispatchMessageID = messageID; return result },
        inspectTurn: async () => ({ state: "idle", result }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const originalUpdate = client.session.update
    let signalTerminalUpdate
    let releaseTerminalUpdate
    const terminalUpdateStarted = new Promise((resolvePromise) => { signalTerminalUpdate = resolvePromise })
    const terminalUpdateBlocked = new Promise((resolvePromise) => { releaseTerminalUpdate = resolvePromise })
    client.session.update = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
        signalTerminalUpdate()
        await terminalUpdateBlocked
      }
      return originalUpdate(request)
    }

    let childSessionID
    const delegated = runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    await terminalUpdateStarted
    assert.deepEqual(await runtime.observeEvent({ kind: "session-status", sessionID: childSessionID, status: { type: "busy" } }), { managed: true, settled: false })
    releaseTerminalUpdate()

    const response = JSON.parse(await delegated)
    assert.equal(response.status, "reported-completed")
    assert.equal(response.output, "completed")
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "reported-completed")
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步结果结算与 busy 证据并发时返回 uncertain 并保留 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-concurrent-active-settlement-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    let dispatchMessageID
    const result = {
      get info() { return { id: "assistant-result", role: "assistant", parentID: dispatchMessageID, finish: "stop" } },
      parts: [{ id: "part-result", type: "text", text: "completed" }],
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async ({ messageID }) => { dispatchMessageID = messageID; return result },
        inspectTurn: async () => ({ state: inspectionState }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const originalUpdate = client.session.update
    let terminalUpdateStarted = false
    let releaseTerminalUpdate
    client.session.update = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.status === "reported-completed") {
        terminalUpdateStarted = true
        await new Promise((resolvePromise) => { releaseTerminalUpdate = resolvePromise })
      }
      return originalUpdate(request)
    }

    let childSessionID
    const delegated = runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    while (!terminalUpdateStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    const active = runtime.observeEvent({ kind: "session-status", sessionID: childSessionID, status: { type: "busy" } })
    releaseTerminalUpdate()

    await assert.rejects(delegated, (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    await active
    assert.equal(client.sessions.get(childSessionID).metadata.o4e.delegation.status, "unknown")
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: childSessionID })
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("inspection 开始后出现 busy 时丢弃陈旧 idle 结果并继续持有 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-stale-inspection-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    let deferInspection = false
    let resolveInspectionStarted
    let resolveStaleInspection
    const inspectionStarted = new Promise((resolvePromise) => { resolveInspectionStarted = resolvePromise })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => {
          if (!deferInspection) return { state: inspectionState }
          resolveInspectionStarted()
          return new Promise((resolvePromise) => { resolveStaleInspection = resolvePromise })
        },
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    deferInspection = true
    const staleIdle = runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    await inspectionStarted
    await runtime.observeEvent({ kind: "session-status", sessionID: child.id, status: { type: "busy" } })
    resolveStaleInspection({
      state: "idle",
      result: {
        info: { id: "stale-assistant", role: "assistant" },
        parts: [{ id: "stale-part", type: "text", text: "stale" }],
      },
    })

    assert.deepEqual(await staleIdle, { managed: true, settled: false })
    assert.equal(client.sessions.get(child.id).metadata.o4e.delegation.status, "unknown")
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    deferInspection = false
    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("settlement 定时重试会重新 inspection 而不落盘陈旧终态", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-settlement-reinspect-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: inspectionState }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === child.id && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }

    inspectionState = "idle"
    await assert.rejects(runtime.observeEvent({ kind: "session-idle", sessionID: child.id }), /metadata unavailable/)
    inspectionState = "running"
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.sessions.get(child.id).metadata.o4e.delegation.status, "unknown")
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("settlement 定时重试遇到 unknown inspection 时保留不确定状态和 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-settlement-unknown-reinspect-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: inspectionState }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({ task: "edit fixture", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === child.id && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }

    inspectionState = "idle"
    await assert.rejects(runtime.observeEvent({ kind: "session-idle", sessionID: child.id }), /metadata unavailable/)
    inspectionState = "unknown"
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    assert.equal(client.sessions.get(child.id).metadata.o4e.delegation.status, "unknown")

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("flush 在一个 settlement 失败时仍等待同批其他 settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-flush-all-settled-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"], permission: { external_directory: "deny" } })
    const agents = [requester, target]
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: inspectionState }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    for (const [task, writeScope] of [["first", "src/first"], ["second", "src/second"]]) {
      await assert.rejects(runtime.delegate({ task, agent: "worker", writeScopes: [writeScope] }, {
        sessionID: "parent", agent: "orchestrator", directory: root,
      }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    }
    const children = [...client.sessions.values()].filter((session) => session.parentID === "parent")
    inspectionState = "idle"
    const originalUpdate = client.session.update
    const initialFailures = new Set(children.map((child) => child.id))
    client.session.update = async (request) => {
      if (initialFailures.delete(request.path.id)) throw new Error(`prime failure: ${request.path.id}`)
      return originalUpdate(request)
    }
    for (const child of children) {
      await assert.rejects(runtime.observeEvent({ kind: "session-idle", sessionID: child.id }), /prime failure/)
    }

    let releaseSecond
    let secondStarted = false
    client.session.update = async (request) => {
      if (request.path.id === children[0].id) throw new Error("first settlement failed")
      if (request.path.id === children[1].id) {
        secondStarted = true
        await new Promise((resolvePromise) => { releaseSecond = resolvePromise })
      }
      return originalUpdate(request)
    }
    let flushSettled = false
    const flushing = runtime.flush().then(
      () => { flushSettled = true },
      (error) => { flushSettled = true; throw error },
    )
    while (!secondStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(flushSettled, false)
    releaseSecond()
    await assert.rejects(flushing, /first settlement failed/)

    client.session.update = originalUpdate
    runtime.resume()
    await runtime.observeEvent({ kind: "session-idle", sessionID: children[0].id })
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("前台 Attempt 在同步回合执行期间接收错误事件", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-foreground-fallback-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator" })
    const target = runtimeAgent({ name: "worker" })
    const agents = [requester, target]
    let resolveTurn
    let dispatchMessageID
    const turn = new Promise((resolvePromise) => { resolveTurn = resolvePromise })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: { runTurn: ({ messageID }) => { dispatchMessageID = messageID; return turn } },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    let childSessionID
    const delegated = runtime.delegate({ task: "inspect", agent: "worker" }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }, {
      onSession: ({ child }) => { childSessionID = child.id },
    })
    while (!childSessionID) await new Promise((resolvePromise) => setImmediate(resolvePromise))

    let observerCalls = 0
    const request = await runEventPipeline({ kind: "error", sessionID: childSessionID, error: "retryable" }, {
      taskObserver: async (event) => { observerCalls += 1; return runtime.observeEvent(event) },
    })
    assert.equal(request, null)
    assert.equal(observerCalls, 1)

    resolveTurn({ info: { id: "assistant", role: "assistant", parentID: dispatchMessageID, finish: "stop" }, parts: [] })
    await delegated

    const afterCompletion = await runEventPipeline({ kind: "error", sessionID: childSessionID, error: "retryable" }, {
      taskObserver: async (event) => { observerCalls += 1; return runtime.observeEvent(event) },
    })
    assert.equal(afterCompletion, null)
    assert.equal(observerCalls, 2)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("同步回合返回 info.error 时持久化 failed 且不报告完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-info-error-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        runTurn: async () => ({
          info: { id: "assistant", role: "assistant", error: { name: "APIError", message: "failed" } },
          parts: [],
        }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })

    await assert.rejects(runtime.delegate({
      task: "edit fixture",
      agent: "worker",
      writeScopes: ["src"],
    }, {
      sessionID: "parent",
      agent: "orchestrator",
      directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_FAILED")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    assert.equal(child.metadata.o4e.delegation.status, "failed")
    assert.match(child.metadata.o4e.delegation.diagnostics, /reconciled-error/)
    await locks.acquire("next", { kind: "unknown-write" })
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tombstone 写入期间 execution idle 必须等待记录落盘后才释放锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-migration-idle-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const execution = {
      runTurn: async () => { throw new Error("transport interrupted") },
      inspectTurn: async () => ({ state: inspectionState }),
      cancelTurn: async () => ({ acknowledged: false }),
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await assert.rejects(runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)

    const originalCreate = client.session.create
    let releaseCreate
    let createStarted = false
    client.session.create = async (request) => {
      if (!request.body?.metadata?.o4e?.delegation?.executionSessionID) return originalCreate(request)
      createStarted = true
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise })
      return originalCreate(request)
    }
    const deleted = runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    while (!createStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    inspectionState = "idle"
    let idleSettled = false
    const idle = runtime.observeEvent({ kind: "session-idle", sessionID: child.id }).then((result) => {
      idleSettled = true
      return result
    })
    let flushed = false
    const flushing = runtime.flush().then(() => { flushed = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(idleSettled, false)
    assert.equal(flushed, false)
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    releaseCreate()
    await Promise.all([deleted, idle, flushing])
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(tombstone.metadata.o4e.delegation.status, "cancelled")
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tombstone 创建已提交但响应丢失时重试复用同一持久记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-tombstone-response-loss-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: inspectionState }),
        cancelTurn: async () => ({ acknowledged: false }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await assert.rejects(runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)
    const originalCreate = client.session.create
    let loseResponse = true
    let tombstoneCreateCalls = 0
    client.session.create = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.executionSessionID) tombstoneCreateCalls += 1
      const created = await originalCreate(request)
      if (loseResponse && request.body?.metadata?.o4e?.delegation?.executionSessionID) {
        loseResponse = false
        throw new Error("response lost")
      }
      return created
    }

    await runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    const tombstones = [...client.sessions.values()].filter((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id)
    assert.equal(tombstones.length, 1)
    assert.equal(tombstoneCreateCalls, 1)
    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: child.id })
    assert.equal(client.sessions.get(tombstones[0].id).metadata.o4e.delegation.status, "cancelled")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复发现 execution missing 且取消未确认时自动重试并结算 tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-recovery-initial-missing-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    client.addSession({
      id: "execution",
      parentID: "parent",
      directory: root,
      metadata: {
        o4e: {
          kind: "delegation-attempt",
          version: 1,
          delegation: {
            depth: 1,
            status: "running",
            parentSessionID: "parent",
            sourceAgent: "orchestrator",
            targetAgent: "worker",
            task: "edit",
            effect: "unknown-write",
            writeScopes: [],
            dispatchMessageID: "msg_dispatch",
            scopeLockID: "missing-lock",
          },
        },
      },
    })
    const locks = new ScopeLockManager()
    let inspectionState = "missing"
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => {
          if (inspectionState === "missing") client.sessions.delete("execution")
          return { state: inspectionState }
        },
        cancelTurn: async () => {
          cancelCalls += 1
          return { acknowledged: cancelCalls > 1 }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    assert.equal(cancelCalls, 1)
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === "execution")
    assert.equal(tombstone.metadata.o4e.delegation.status, "unknown")
    assert.equal(typeof tombstone.metadata.o4e.delegation.cancellationRequestedAt, "number")
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(client.sessions.get(tombstone.id).metadata.o4e.delegation.status, "unknown")
    await Promise.race([
      waiting,
      new Promise((_, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("automatic cancellation retry timed out")), 1_000)
        timer.unref?.()
      }),
    ])
    assert.equal(cancelCalls, 2)
    assert.equal(client.sessions.get(tombstone.id).metadata.o4e.delegation.status, "cancelled")
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Session 定向恢复只检查当前父 Session 的 uncertain Attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-session-recovery-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent-a", directory: root })
    client.addSession({ id: "parent-b", directory: root })
    const addAttempt = (id, parentSessionID) => client.addSession({
      id,
      parentID: parentSessionID,
      directory: root,
      metadata: { o4e: {
        kind: "delegation-attempt",
        version: 1,
        delegation: {
          depth: 1,
          status: "running",
          parentSessionID,
          sourceAgent: "orchestrator",
          targetAgent: "worker",
          task: "inspect",
          effect: "read",
          writeScopes: [],
          dispatchMessageID: `msg_${id}`,
          scopeLockID: `lock_${id}`,
        },
      } },
    })
    addAttempt("attempt-a", "parent-a")
    addAttempt("attempt-b", "parent-b")
    let listCalls = 0
    client.session.list = async () => {
      listCalls += 1
      throw new Error("项目级 Session 枚举不应被调用")
    }
    const inspected = []
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        inspectTurn: async ({ sessionID }) => {
          inspected.push(sessionID)
          return { state: "running" }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent-a")
    assert.equal(listCalls, 0)
    assert.deepEqual(inspected, ["attempt-a"])
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Session 定向恢复忽略旧 Workflow uncertain Attempt 记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-workflow-lock-recovery-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    client.addSession({
      id: "workflow-run",
      parentID: "parent",
      directory: root,
      metadata: { o4e: {
        kind: "workflow-run",
        version: 2,
        workflow: { initiatingSessionID: "parent" },
      } },
    })
    client.addSession({
      id: "workflow-attempt",
      parentID: "workflow-run",
      directory: root,
      metadata: { o4e: {
        kind: "delegation-attempt",
        version: 1,
        delegation: {
          depth: 1,
          status: "unknown",
          parentSessionID: "workflow-run",
          sourceAgent: "orchestrator",
          targetAgent: "worker",
          toolName: "o4e_workflow",
          requesterPermissionPattern: "implementation-change",
          effect: "unknown-write",
          writeScopes: [],
          dispatchMessageID: "msg_workflow_attempt",
          scopeLockID: "workflow-uncertain-lock",
        },
      } },
    })
    const locks = new ScopeLockManager()
    const inspected = []
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async ({ sessionID }) => {
          inspected.push(sessionID)
          return { state: "running" }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    assert.deepEqual(inspected, [])

    await locks.acquire("next-write", { kind: "unknown-write" })
    locks.release("next-write")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复终态释放会使并发 running inspection 失效", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-recovery-stale-running-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    client.addSession({
      id: "execution",
      parentID: "parent",
      directory: root,
      metadata: {
        o4e: {
          kind: "delegation-attempt",
          version: 1,
          delegation: {
            depth: 1,
            status: "unknown",
            parentSessionID: "parent",
            sourceAgent: "orchestrator",
            targetAgent: "worker",
            task: "edit",
            effect: "unknown-write",
            writeScopes: [],
            dispatchMessageID: "msg_dispatch",
            scopeLockID: "stale-running-lock",
          },
        },
      },
    })
    const locks = new ScopeLockManager()
    let inspectCalls = 0
    let resolveInspectionStarted
    let resolveStaleInspection
    const inspectionStarted = new Promise((resolvePromise) => { resolveInspectionStarted = resolvePromise })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => {
          inspectCalls += 1
          if (inspectCalls === 1) {
            resolveInspectionStarted()
            return new Promise((resolvePromise) => { resolveStaleInspection = resolvePromise })
          }
          return { state: "idle" }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    const recovering = runtime.recoverSession("parent")
    await inspectionStarted
    assert.deepEqual(
      await runtime.observeEvent({ kind: "session-idle", sessionID: "execution" }),
      { managed: true, settled: true },
    )
    resolveStaleInspection({ state: "running" })
    await recovering

    const delegation = client.sessions.get("execution").metadata.o4e.delegation
    assert.equal(delegation.status, "unknown")
    assert.equal(typeof delegation.endedAt, "number")
    assert.deepEqual(
      await runtime.observeEvent({ kind: "session-status", sessionID: "execution", status: { type: "busy" } }),
      { managed: false },
    )
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复重试不会让旧取消定时器释放当前 Attempt 的 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-recovery-stale-cancellation-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const cancellationRequestedAt = Date.now()
    client.addSession({
      id: "record-a",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        depth: 1,
        status: "unknown",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "msg_dispatch_a",
        scopeLockID: "shared-recovery-lock",
        executionSessionID: "execution-a",
        cancellationRequestedAt,
      } } },
    })
    client.addSession({
      id: "record-b",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        depth: 1,
        status: "unknown",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "inspect",
        effect: "read",
        writeScopes: [],
        dispatchMessageID: "msg_dispatch_b",
        scopeLockID: "read-recovery-lock",
        executionSessionID: "execution-b",
      } } },
    })
    const locks = new ScopeLockManager()
    let executionAInspections = 0
    let failExecutionB = true
    let resolveRetryInspectionStarted
    let resolveRetryInspection
    const retryInspectionStarted = new Promise((resolvePromise) => { resolveRetryInspectionStarted = resolvePromise })
    let cancelCalls = 0
    let resolveOldCancellationStarted
    let resolveOldCancellation
    const oldCancellationStarted = new Promise((resolvePromise) => { resolveOldCancellationStarted = resolvePromise })
    const originalUpdate = client.session.update
    let resolveTerminalUpdateStarted
    let releaseTerminalUpdate
    const terminalUpdateStarted = new Promise((resolvePromise) => { resolveTerminalUpdateStarted = resolvePromise })
    let blockTerminalUpdate = true
    client.session.update = async (request) => {
      if (blockTerminalUpdate && request.body?.metadata?.o4e?.delegation?.status === "cancelled") {
        blockTerminalUpdate = false
        resolveTerminalUpdateStarted()
        await new Promise((resolvePromise) => { releaseTerminalUpdate = resolvePromise })
      }
      return originalUpdate(request)
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async ({ sessionID }) => {
          if (sessionID === "execution-a") {
            executionAInspections += 1
            if (executionAInspections === 1) return { state: "missing" }
            resolveRetryInspectionStarted()
            return new Promise((resolvePromise) => { resolveRetryInspection = resolvePromise })
          }
          if (failExecutionB) {
            failExecutionB = false
            throw new Error("second recovery group failed")
          }
          return { state: "running" }
        },
        cancelTurn: async () => {
          cancelCalls += 1
          if (cancelCalls === 1) return { acknowledged: false }
          if (cancelCalls === 2) {
            resolveOldCancellationStarted()
            return new Promise((resolvePromise) => { resolveOldCancellation = resolvePromise })
          }
          return { acknowledged: false }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await assert.rejects(runtime.recoverSession("parent"), /second recovery group failed/)
    await Promise.race([
      oldCancellationStarted,
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("old cancellation timer did not start")), 1_000)),
    ])

    const retrying = runtime.recoverSession("parent")
    await retryInspectionStarted
    resolveOldCancellation({ acknowledged: true })
    await terminalUpdateStarted
    resolveRetryInspection({ state: "running" })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    releaseTerminalUpdate()
    await retrying

    assert.equal(client.sessions.get("record-a").metadata.o4e.delegation.status, "unknown")
    const controller = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: controller.signal })
    const outcome = await Promise.race([
      waiting.then(() => "acquired"),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise("blocked"), 25)),
    ])
    if (outcome === "acquired") locks.release("next")
    else {
      controller.abort(new Error("still locked"))
      await assert.rejects(waiting, /still locked/)
    }
    assert.equal(outcome, "blocked")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复 active 证据写失败会保留 Attempt 并允许下次调用重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-recovery-active-persist-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    client.addSession({
      id: "execution",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        depth: 1,
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "msg_dispatch",
        scopeLockID: "active-persist-lock",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    const originalUpdate = client.session.update
    let failActiveWrite = true
    client.session.update = async (request) => {
      if (failActiveWrite && /^reconciled-active:/.test(request.body?.metadata?.o4e?.delegation?.diagnostics ?? "")) {
        failActiveWrite = false
        throw new Error("active metadata unavailable")
      }
      return originalUpdate(request)
    }
    let inspectionCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => {
          inspectionCalls += 1
          return { state: "running" }
        },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await assert.rejects(runtime.recoverSession("parent"), /active metadata unavailable/)
    assert.equal(client.sessions.get("execution").metadata.o4e.delegation.status, "reported-completed")
    const firstController = new AbortController()
    const firstWaiting = locks.acquire("first", { kind: "unknown-write" }, { signal: firstController.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    firstController.abort(new Error("restored lock retained"))
    await assert.rejects(firstWaiting, /restored lock retained/)

    await runtime.recoverSession("parent")
    assert.equal(inspectionCalls, 2)
    const delegation = client.sessions.get("execution").metadata.o4e.delegation
    assert.equal(delegation.status, "unknown")
    assert.equal(delegation.endedAt, undefined)
    assert.equal(delegation.result, undefined)
    const secondController = new AbortController()
    const secondWaiting = locks.acquire("second", { kind: "unknown-write" }, { signal: secondController.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    secondController.abort(new Error("active lock retained"))
    await assert.rejects(secondWaiting, /active lock retained/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复按 executionSessionID 和 scopeLockID 聚合重复 tombstone 后统一结算", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-duplicate-tombstones-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const delegation = {
      depth: 1,
      status: "unknown",
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
      cancellationRequestedAt: Date.now(),
    }
    client.addSession({ id: "record-a", parentID: "parent", directory: root, metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation } } })
    client.addSession({ id: "record-b", parentID: "parent", directory: root, metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation } } })
    const locks = new ScopeLockManager()
    let failRecordB = true
    const originalUpdate = client.session.update
    client.session.update = async (request) => {
      if (request.path.id === "record-b" && failRecordB) throw new Error("metadata unavailable")
      return originalUpdate(request)
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => ({ state: "idle" }),
        cancelTurn: async () => ({ acknowledged: true }),
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })
    await assert.rejects(runtime.recoverSession("parent"), /metadata unavailable/)
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)
    assert.equal(client.sessions.get("record-a").metadata.o4e.delegation.status, "cancelled")
    assert.equal(client.sessions.get("record-b").metadata.o4e.delegation.status, "unknown")

    failRecordB = false
    await runtime.observeEvent({ kind: "session-idle", sessionID: "execution" })
    assert.equal(client.sessions.get("record-a").metadata.o4e.delegation.status, "cancelled")
    assert.equal(client.sessions.get("record-b").metadata.o4e.delegation.status, "cancelled")
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复聚合保留已持久化终态并补齐其余 tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-tombstone-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const common = {
      depth: 1,
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
    }
    client.addSession({
      id: "record-completed",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        ...common,
        status: "reported-completed",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    client.addSession({
      id: "record-unknown",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: { ...common, status: "unknown" } } },
    })
    const locks = new ScopeLockManager()
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: { inspectTurn: async () => ({ state: "idle" }) },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    for (const recordSessionID of ["record-completed", "record-unknown"]) {
      const delegation = client.sessions.get(recordSessionID).metadata.o4e.delegation
      assert.equal(delegation.status, "reported-completed")
      assert.deepEqual(delegation.result, { messageID: "assistant", partIDs: ["part"] })
    }
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复时宿主 busy 会使已持久化终态失效并保留 Scope Lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-busy-recovery-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const common = {
      depth: 1,
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
    }
    client.addSession({
      id: "record-completed",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        ...common,
        status: "reported-completed",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    client.addSession({
      id: "record-unknown",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: { ...common, status: "unknown" } } },
    })
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: { inspectTurn: async () => ({ state: inspectionState }) },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    for (const recordSessionID of ["record-completed", "record-unknown"]) {
      assert.equal(client.sessions.get(recordSessionID).metadata.o4e.delegation.status, "unknown")
    }
    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("still locked"))
    await assert.rejects(waiting, /still locked/)

    inspectionState = "idle"
    await runtime.observeEvent({ kind: "session-idle", sessionID: "execution" })
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("active 证据失效的旧 completion 不会在 idle inspection 后重新晋升", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-invalidated-completion-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "attempt",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        endedAt: 10,
        result: { messageID: "old-assistant", partIDs: ["old-part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    let inspection = { state: "running" }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => inspection,
        cancelTurn: async () => ({ acknowledged: false }),
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    let stored = client.sessions.get("attempt").metadata.o4e.delegation
    assert.equal(stored.status, "unknown")
    assert.deepEqual(stored.invalidatedResult, { messageID: "old-assistant", partIDs: ["old-part"] })

    inspection = {
      state: "idle",
      result: {
        info: { id: "old-assistant", role: "assistant", parentID: "dispatch", finish: "stop" },
        parts: [{ id: "old-part", type: "text", text: "old" }],
      },
    }
    assert.deepEqual(await runtime.observeEvent({ kind: "session-idle", sessionID: "attempt" }), { managed: true, settled: false })
    stored = client.sessions.get("attempt").metadata.o4e.delegation
    assert.equal(stored.status, "unknown")
    assert.equal(stored.result, undefined)

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("invalidated result still locked"))
    await assert.rejects(waiting, /invalidated result still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("session-idle 对账发现 execution missing 时必须先确认取消并继续持锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-event-missing-cancel-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "execution",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "unknown",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
      } } },
    })
    const locks = new ScopeLockManager()
    let inspectionState = "running"
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => ({ state: inspectionState }),
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: false } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    inspectionState = "missing"
    assert.deepEqual(
      await runtime.observeEvent({ kind: "session-idle", sessionID: "execution" }),
      { managed: true, settled: false },
    )
    assert.equal(cancelCalls, 1)
    const tombstone = [...client.sessions.values()].find((session) => session.metadata?.o4e?.delegation?.executionSessionID === "execution")
    assert.equal(tombstone.metadata.o4e.delegation.status, "unknown")
    assert.match(tombstone.metadata.o4e.delegation.diagnostics, /deleted-cancel-unconfirmed/)

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("missing execution still locked"))
    await assert.rejects(waiting, /missing execution still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("取消确认后出现 busy 会撤销旧取消意图，后续 idle 不会误写 cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-confirmed-cancel-busy-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "execution",
        cancellationRequestedAt: 10,
        cancellationConfirmedAt: 20,
        endedAt: 5,
        result: { messageID: "old-assistant", partIDs: ["old-part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    let inspection = null
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: { inspectTurn: async () => inspection },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    assert.deepEqual(
      await runtime.observeEvent({ kind: "session-status", sessionID: "execution", status: { type: "busy" } }),
      { managed: true, settled: false },
    )
    let stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(stored.status, "unknown")
    assert.equal(stored.cancellationRequestedAt, undefined)
    assert.equal(stored.cancellationConfirmedAt, undefined)
    assert.deepEqual(stored.invalidatedResult, { messageID: "old-assistant", partIDs: ["old-part"] })

    inspection = { state: "idle" }
    assert.deepEqual(
      await runtime.observeEvent({ kind: "session-idle", sessionID: "execution" }),
      { managed: true, settled: true },
    )
    stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(stored.status, "unknown")
    assert.equal(stored.cancellationRequestedAt, undefined)
    assert.equal(stored.cancellationConfirmedAt, undefined)
    await locks.acquire("after", { kind: "unknown-write" })
    locks.release("after")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("terminal-only 定向恢复发现 execution missing 时建立取消 fence 并持锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-missing-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "missing-execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: false } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    const stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(cancelCalls, 1)
    assert.equal(stored.status, "unknown")
    assert.equal(typeof stored.cancellationRequestedAt, "number")
    assert.match(stored.diagnostics, /missing-cancel-unconfirmed/)

    const blocked = new AbortController()
    const waiting = locks.acquire("next", { kind: "unknown-write" }, { signal: blocked.signal })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    blocked.abort(new Error("missing execution still locked"))
    await assert.rejects(waiting, /missing execution still locked/)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("terminal-only missing 取消确认后的终态写失败会自动重试并释放锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-missing-settle-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "missing-execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const originalUpdate = client.session.update
    let failOnce = true
    client.session.update = async (request) => {
      if (request.path.id === "record" && failOnce) {
        failOnce = false
        throw new Error("metadata unavailable")
      }
      return originalUpdate(request)
    }
    const locks = new ScopeLockManager()
    let inspectionCalls = 0
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => { inspectionCalls += 1; return { state: "missing" } },
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: true } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    assert.equal(client.sessions.get("record").metadata.o4e.delegation.status, "reported-completed")

    let acquired = false
    const waiting = locks.acquire("next", { kind: "unknown-write" }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)

    const deadline = Date.now() + 1000
    while (client.sessions.get("record").metadata.o4e.delegation.status !== "cancelled" && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    await waiting
    assert.equal(acquired, true)
    assert.equal(client.sessions.get("record").metadata.o4e.delegation.status, "cancelled")
    assert.equal(cancelCalls, 1)
    assert.equal(inspectionCalls, 1)
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing 取消确认 fence 落盘后重启无需再次取消即可结算", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-missing-confirm-restart-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "missing-execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const originalUpdate = client.session.update
    let failTerminalOnce = true
    client.session.update = async (request) => {
      if (request.body?.metadata?.o4e?.delegation?.status === "cancelled" && failTerminalOnce) {
        failTerminalOnce = false
        throw new Error("terminal metadata unavailable")
      }
      return originalUpdate(request)
    }
    let initialCancelCalls = 0
    const first = createDelegationRuntime({
      client,
      directory: root,
      locks: new ScopeLockManager(),
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => { initialCancelCalls += 1; return { acknowledged: true } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await first.recoverSession("parent", { session: client.sessions.get("parent") })
    let stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(initialCancelCalls, 1)
    assert.equal(stored.status, "reported-completed")
    assert.equal(Number.isFinite(stored.cancellationConfirmedAt), true)
    first.dispose()

    const recoveredLocks = new ScopeLockManager()
    let recoveredCancelCalls = 0
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks: recoveredLocks,
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => { recoveredCancelCalls += 1; return { acknowledged: false } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await recovered.recoverSession("parent", { session: client.sessions.get("parent") })
    stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(recoveredCancelCalls, 0)
    assert.equal(stored.status, "cancelled")
    assert.equal(stored.result, undefined)
    await recoveredLocks.acquire("next", { kind: "unknown-write" })
    recoveredLocks.release("next")
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing 取消确认 fence 部分写入后重启会收敛全部 record", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-missing-confirm-partial-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const addRecord = (id) => client.addSession({
      id,
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "missing-execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    addRecord("record-a")
    addRecord("record-b")
    const originalUpdate = client.session.update
    let failConfirmationOnce = true
    client.session.update = async (request) => {
      if (request.path.id === "record-b"
        && Number.isFinite(request.body?.metadata?.o4e?.delegation?.cancellationConfirmedAt)
        && request.body.metadata.o4e.delegation.status !== "cancelled"
        && failConfirmationOnce) {
        failConfirmationOnce = false
        throw new Error("confirmation metadata unavailable")
      }
      return originalUpdate(request)
    }
    const first = createDelegationRuntime({
      client,
      directory: root,
      locks: new ScopeLockManager(),
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => ({ acknowledged: true }),
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await first.recoverSession("parent", { session: client.sessions.get("parent") })
    assert.equal(Number.isFinite(client.sessions.get("record-a").metadata.o4e.delegation.cancellationConfirmedAt), true)
    assert.equal(client.sessions.get("record-b").metadata.o4e.delegation.cancellationConfirmedAt, undefined)
    first.dispose()
    client.session.update = originalUpdate

    const locks = new ScopeLockManager()
    let cancelCalls = 0
    const recovered = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: false } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await recovered.recoverSession("parent", { session: client.sessions.get("parent") })
    assert.equal(cancelCalls, 0)
    for (const id of ["record-a", "record-b"]) {
      const stored = client.sessions.get(id).metadata.o4e.delegation
      assert.equal(stored.status, "cancelled")
      assert.equal(Number.isFinite(stored.cancellationConfirmedAt), true)
    }
    await locks.acquire("next", { kind: "unknown-write" })
    locks.release("next")
    recovered.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("terminal-only missing 的取消重试确认后不会恢复旧 completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-missing-cancel-retry-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "record",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        status: "reported-completed",
        parentSessionID: "parent",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        task: "edit",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "dispatch",
        scopeLockID: "lock",
        executionSessionID: "missing-execution",
        endedAt: 10,
        result: { messageID: "assistant", partIDs: ["part"] },
      } } },
    })
    const locks = new ScopeLockManager()
    let cancelCalls = 0
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: {
        inspectTurn: async () => ({ state: "missing" }),
        cancelTurn: async () => { cancelCalls += 1; return { acknowledged: cancelCalls > 1 } },
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent", { session: client.sessions.get("parent") })
    assert.equal(client.sessions.get("record").metadata.o4e.delegation.status, "unknown")

    let acquired = false
    const waiting = locks.acquire("next", { kind: "unknown-write" }).then(() => { acquired = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(acquired, false)

    await Promise.race([
      waiting,
      new Promise((_, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error("automatic cancellation retry timed out")), 1_000)
        timer.unref?.()
      }),
    ])
    const stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(cancelCalls, 2)
    assert.equal(stored.status, "cancelled")
    assert.equal(stored.result, undefined)
    locks.release("next")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复聚合不会让取消意图后的迟到完成覆盖 cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-late-terminal-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const common = {
      depth: 1,
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
      cancellationRequestedAt: 10,
    }
    client.addSession({
      id: "record-late-completed",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        ...common,
        status: "reported-completed",
        endedAt: 20,
        result: { messageID: "late-assistant", partIDs: ["late-part"] },
      } } },
    })
    client.addSession({
      id: "record-unknown",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: { ...common, status: "unknown" } } },
    })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: { inspectTurn: async () => ({ state: "idle" }) },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    for (const recordSessionID of ["record-late-completed", "record-unknown"]) {
      const delegation = client.sessions.get(recordSessionID).metadata.o4e.delegation
      assert.equal(delegation.status, "cancelled")
      assert.equal(delegation.result, undefined)
    }
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("恢复聚合所有重复记录中的取消 fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-partial-cancel-fence-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const common = {
      depth: 1,
      status: "unknown",
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
    }
    client.addSession({ id: "record-no-fence", parentID: "parent", directory: root, metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: common } } })
    client.addSession({ id: "record-with-fence", parentID: "parent", directory: root, metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: { ...common, cancellationRequestedAt: 10 } } } })
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        inspectTurn: async () => ({
          state: "idle",
          result: { info: { id: "late", role: "assistant", parentID: "msg_dispatch", finish: "stop" }, parts: [{ id: "late-part", type: "text", text: "late" }] },
        }),
      },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    for (const recordSessionID of ["record-no-fence", "record-with-fence"]) {
      const delegation = client.sessions.get(recordSessionID).metadata.o4e.delegation
      assert.equal(delegation.status, "cancelled")
      assert.equal(delegation.cancellationRequestedAt, 10)
      assert.equal(delegation.result, undefined)
    }
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("终态写入基于最新 metadata 保留并发完成结果", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-terminal-cas-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root })
    const delegation = {
      depth: 1,
      status: "unknown",
      parentSessionID: "parent",
      sourceAgent: "orchestrator",
      targetAgent: "worker",
      task: "edit",
      effect: "unknown-write",
      writeScopes: [],
      dispatchMessageID: "msg_dispatch",
      scopeLockID: "shared-lock",
      executionSessionID: "execution",
    }
    client.addSession({ id: "record", parentID: "parent", directory: root, metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation } } })
    const originalGet = client.session.get
    let injectConcurrentCompletion = true
    client.session.get = async (request) => {
      if (request.path.id === "record" && injectConcurrentCompletion) {
        injectConcurrentCompletion = false
        const current = client.sessions.get("record")
        current.metadata.o4e.delegation = {
          ...current.metadata.o4e.delegation,
          status: "reported-completed",
          endedAt: 5,
          result: { messageID: "concurrent", partIDs: ["part"] },
        }
      }
      return originalGet(request)
    }
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: { inspectTurn: async () => ({ state: "idle", error: "late failure" }) },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })

    await runtime.recoverSession("parent")
    const stored = client.sessions.get("record").metadata.o4e.delegation
    assert.equal(stored.status, "reported-completed")
    assert.deepEqual(stored.result, { messageID: "concurrent", partIDs: ["part"] })
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("flush 等待未决 tombstone 写入完成后才允许 dispose 清锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-delegation-flush-migration-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const requester = runtimeAgent({ name: "orchestrator", loadTools: ["read", "edit", "task"] })
    const target = runtimeAgent({ name: "worker", loadTools: ["read", "edit"] })
    const agents = [requester, target]
    let cancellationAcknowledged = false
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      execution: {
        runTurn: async () => { throw new Error("transport interrupted") },
        inspectTurn: async () => ({ state: "running" }),
        cancelTurn: async () => ({ acknowledged: cancellationAcknowledged }),
      },
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    await assert.rejects(runtime.delegate({ task: "edit", agent: "worker", writeScopes: ["src"] }, {
      sessionID: "parent", agent: "orchestrator", directory: root,
    }), (error) => error?.code === "O4E_DELEGATION_UNCERTAIN")
    const child = [...client.sessions.values()].find((session) => session.parentID === "parent")
    client.sessions.delete(child.id)
    const originalCreate = client.session.create
    let releaseCreate
    let createStarted = false
    client.session.create = async (request) => {
      if (!request.body?.metadata?.o4e?.delegation?.executionSessionID) return originalCreate(request)
      createStarted = true
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise })
      return originalCreate(request)
    }
    const deleted = runtime.observeEvent({ kind: "deleted", sessionID: child.id })
    while (!createStarted) await new Promise((resolvePromise) => setImmediate(resolvePromise))
    cancellationAcknowledged = true
    let flushed = false
    const flushing = runtime.flush().then(() => { flushed = true })
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    assert.equal(flushed, false)

    releaseCreate()
    await Promise.all([deleted, flushing])
    assert.equal([...client.sessions.values()].some((session) => session.metadata?.o4e?.delegation?.executionSessionID === child.id), true)
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// process-v1 keeps Workflow work in the main Session; legacy automatic
// agent/workflow/loop orchestration is represented only by rejection tests.
test("process-v1 Workflow 定义拒绝旧 agent、workflow 和 loop Step", () => {
  const legacySteps = [
    { id: "agent", type: "agent", agent: { preferred: "worker", fallback: "none" }, skill: "task.general", effect: "read", task: { description: "work" } },
    { id: "nested", type: "workflow", workflow: "child", input: {} },
    { id: "repeat", type: "loop", workflow: "child", input: {}, maxIterations: 2, until: { path: "/done", equals: true } },
  ]
  for (const step of legacySteps) {
    assert.throws(() => compileWorkflowRegistry([{ source: `workflows/legacy-${step.type}.jsonc`, value: {
      contract: "process-v1",
      name: `legacy-${step.type}`,
      description: `reject ${step.type}`,
      visibility: "entry",
      output: { result: { $from: "steps", path: `/${step.id}` } },
      steps: [step],
    } }]), /只支持 work|不支持字段/)
  }
})

test("DelegationRuntime 拒绝旧 Workflow 委派入口和 trace.runSessionID", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-legacy-workflow-delegation-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    const orchestrator = runtimeAgent({ name: "orchestrator", loadAgents: ["worker"] })
    const worker = runtimeAgent({ name: "worker", type: "subagent" })
    const agents = [orchestrator, worker]
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      snapshot: () => ({ agents, agentByName: new Map(agents.map((agent) => [agent.name, agent])) }),
    })
    const context = { sessionID: "parent", agent: "orchestrator", directory: root }
    await assert.rejects(
      runtime.prepare({ task: "legacy workflow step", agent: "worker" }, context, "o4e_workflow", { permissionPattern: "legacy" }),
      /O4E_WORKFLOW_DELEGATION_UNSUPPORTED/,
    )
    await assert.rejects(
      runtime.prepare({ task: "legacy trace", agent: "worker", trace: { runSessionID: "run", stepID: "work", attempt: 1 } }, context),
      /O4E_WORKFLOW_DELEGATION_UNSUPPORTED/,
    )
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("DelegationRuntime 恢复忽略旧 Workflow Run 与 Attempt 记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-legacy-workflow-recovery-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({ id: "parent", directory: root, metadata: {} })
    client.addSession({
      id: "legacy-run",
      parentID: "parent",
      directory: root,
      metadata: { o4e: { kind: "workflow-run", version: 2, workflow: { initiatingSessionID: "parent" } } },
    })
    client.addSession({
      id: "legacy-attempt",
      parentID: "legacy-run",
      directory: root,
      metadata: { o4e: { kind: "delegation-attempt", version: 1, delegation: {
        depth: 1,
        status: "unknown",
        parentSessionID: "legacy-run",
        sourceAgent: "orchestrator",
        targetAgent: "worker",
        toolName: "o4e_workflow",
        requesterPermissionPattern: "legacy",
        effect: "unknown-write",
        writeScopes: [],
        dispatchMessageID: "msg_legacy",
        scopeLockID: "legacy-workflow-lock",
      } } },
    })
    const locks = new ScopeLockManager()
    const inspected = []
    const runtime = createDelegationRuntime({
      client,
      directory: root,
      locks,
      execution: { inspectTurn: async ({ sessionID }) => { inspected.push(sessionID); return { state: "running" } } },
      snapshot: () => ({ agents: [], agentByName: new Map() }),
    })
    await runtime.recoverSession("parent")
    await runtime.recoverSession("legacy-run")
    await runtime.recoverSession("legacy-attempt")
    assert.deepEqual(inspected, [])
    await locks.acquire("ordinary-task-write", { kind: "unknown-write" })
    locks.release("ordinary-task-write")
    runtime.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("WorkflowRuntime 拒绝旧 workflow 字段和索引且不会迁移旧 Run Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-legacy-workflow-index-"))
  try {
    const client = new MockOpenCodeClient()
    client.addSession({
      id: "owner",
      directory: root,
      metadata: { o4e: { workflow: { version: 2, status: "running" } } },
    })
    client.addSession({
      id: "legacy-run",
      parentID: "owner",
      directory: root,
      metadata: { o4e: { kind: "workflow-run", version: 2, workflow: { initiatingSessionID: "owner" } } },
    })
    client.addSession({
      id: "invalid-index-owner",
      directory: root,
      metadata: { o4e: { workflowProcess: { contract: "workflow-v2", activeRunID: null, runs: {} } } },
    })
    const agent = runtimeAgent({ name: "orchestrator", type: "primary", loadWorkflows: ["modern"] })
    const runtime = new WorkflowRuntime({
      client,
      directory: root,
      snapshot: () => ({ runtime: { config: { enableWorkflow: true } }, agents: [agent], agentByName: new Map([[agent.name, agent]]), workflows: new Map() }),
    })
    assert.deepEqual(await runtime.resumeForSession("owner", { messageID: "user-latest" }), [])
    await assert.rejects(
      runtime.handle({ action: "read", runID: "legacy-run" }, { sessionID: "owner", agent: "orchestrator" }),
      /O4E_WORKFLOW_OWNER_DENIED/,
    )
    await assert.rejects(
      runtime.handle({ action: "read", runID: "legacy-run" }, { sessionID: "invalid-index-owner", agent: "orchestrator" }),
      /O4E_WORKFLOW_INVALID_INDEX/,
    )
    assert.equal(client.sessions.get("owner").metadata.o4e.workflowProcess, undefined)
    assert.equal(client.sessions.get("legacy-run").metadata.o4e.kind, "workflow-run")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
