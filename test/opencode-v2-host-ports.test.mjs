import test from "node:test"
import assert from "node:assert/strict"
import { createV2HostPorts, detectV2Capabilities } from "../src/adapters/opencode-v2/host-ports.mjs"
import { assertV2Feature, describeV2Features, evaluateV2Feature } from "../src/adapters/opencode-v2/feature-gates.mjs"
import { createV2RegistrationSet } from "../src/adapters/opencode-v2/registrations.mjs"
import { createV2FeatureRegistry } from "../src/adapters/opencode-v2/feature-registry.mjs"
import { assertV2HostPorts } from "../src/adapters/opencode-v2/contracts.mjs"

test("V2 capability detection is conservative and does not promote permission hooks to ask", () => {
  const ctx = {
    location: { directory: "/workspace" },
    tool: { transform() {} },
    agent: { transform() {} },
    mcp: { transform() {} },
    permission: { hook() {} },
    session: { create() {}, get() {}, update() {}, hook() {}, context() {} },
    rpc: Object.assign(() => {}, { register() {} }),
    storage: { set() {} },
  }
  const capabilities = detectV2Capabilities(ctx)
  assert.equal(capabilities.location.available, true)
  assert.equal(capabilities.toolTransform.available, true)
  assert.equal(capabilities.agentTransform.available, true)
  assert.equal(capabilities.mcpTransform.available, true)
  assert.equal(capabilities.permissionHook.available, true)
  assert.equal(capabilities.sessionContext.available, true)
  assert.equal(capabilities.pluginRpc.available, true)
  assert.equal(capabilities.pluginStorage.available, true)
  assert.equal(capabilities.hostAsk.available, false)
  assert.equal(capabilities.parentSessionCreate.available, false)
  assert.equal(capabilities.sessionSource.available, false)
  assert.equal(capabilities.originalPartUpdate.available, false)
  assert.equal(evaluateV2Feature("statusTool", capabilities).available, true)
  assert.equal(evaluateV2Feature("managedDelegation", capabilities).available, false)
  assert.equal(evaluateV2Feature("managedCommand", capabilities).available, false)
  assert.throws(() => assertV2Feature("managedDelegation", capabilities), /O4E_V2_FEATURE_UNAVAILABLE:managedDelegation/)
})

test("V2 similar-looking native Tool permission and lifecycle hooks cannot promote G1–G4", () => {
  const capabilities = detectV2Capabilities({
    permission: { hook() {}, list() {}, get() {}, reply() {}, rules() {} },
    tool: { transform() {}, hook() {}, options: { permission: "shell" } },
    session: { create() {}, get() {}, update() {}, context() {}, wait() {} },
    rpc: Object.assign(() => {}, { register() {} }), storage: { set() {}, get() {} },
  })
  for (const name of ["permissionHook", "permissionPending", "sessionContext", "toolAfterHook", "pluginRpc", "pluginStorage"]) {
    assert.equal(capabilities[name].available, true, name)
  }
  for (const name of ["hostAsk", "parentSessionCreate", "sessionSource", "originalPartUpdate", "sessionMetadata"]) {
    assert.equal(capabilities[name].available, false, name)
  }
  for (const name of ["managedCommand", "managedDelegation", "taskManagement", "workflow"]) {
    assert.equal(evaluateV2Feature(name, capabilities).available, false, name)
  }
})

test("V2 host ports expose stable adapters and fail closed when unavailable", () => {
  const ports = createV2HostPorts({ location: { directory: "/workspace" }, tool: { transform() {} } })
  assert.equal(assertV2HostPorts(ports), ports)
  assert.equal(ports.transforms.tool.available, true)
  assert.equal(ports.transforms.agent.available, false)
  assert.equal(ports.authorization.available, false)
  assert.throws(() => ports.authorization.ask(), (error) => error.code === "O4E_V2_PORT_UNAVAILABLE"
    && error.port === "authorization.ask")
  assert.throws(() => ports.sessions.parentCreate.unavailable(), /O4E_V2_PORT_UNAVAILABLE:session.parentCreate/)
  assert.throws(() => ports.parts.update("session", "message", "call", {}), /O4E_V2_PORT_UNAVAILABLE:original-part.update/)
  assert.deepEqual(Object.keys(describeV2Features(ports.capabilities)).sort(), [
    "agentProjection", "managedCommand", "managedDelegation", "mcpProjection", "promptProjection", "statusTool", "taskManagement", "workflow",
  ])
})

test("V2 Host Port wrappers retain the owning host domain and never infer approval from it", async () => {
  const context = {
    tool: { async transform(callback) { assert.equal(this, context.tool); callback({ add() {} }); return { dispose() {} } } },
    permission: { async hook() { assert.equal(this, context.permission) } },
    session: { async create() { assert.equal(this, context.session); return { id: "session" } },
      async prompt() { assert.equal(this, context.session); return "prompted" } },
  }
  const ports = createV2HostPorts(context)
  await ports.transforms.tool.transform(() => {})
  await ports.authorization.evaluate()
  assert.deepEqual(await ports.sessions.create(), { id: "session" })
  assert.equal(await ports.execution.prompt(), "prompted")
  assert.equal(ports.capabilities.hostAsk.available, false)
  assert.throws(() => ports.authorization.ask(), /O4E_V2_PORT_UNAVAILABLE/)
})

test("V2 feature registry installs only features with verified Gates and leaves skipped features unregistered", async () => {
  const capabilities = detectV2Capabilities({ tool: { transform() {} } })
  const registry = createV2FeatureRegistry(capabilities)
  const registrations = createV2RegistrationSet()
  const operations = []
  registry.define({ name: "status", feature: "statusTool", setup: async () => {
    operations.push("status-setup")
    return { dispose: async () => operations.push("status-dispose") }
  } })
  registry.define({ name: "command", feature: "managedCommand", setup: async () => {
    operations.push("command-setup")
    return { dispose() {} }
  } })
  const result = await registry.install(registrations)
  assert.deepEqual(result.installed, ["status"])
  assert.deepEqual(result.skipped.map((item) => item.name), ["command"])
  assert.deepEqual(operations, ["status-setup"])
  await registrations.dispose()
  assert.deepEqual(operations, ["status-setup", "status-dispose"])
})

test("V2 registration set rolls back in reverse order and preserves cleanup failures", async () => {
  const disposed = []
  const registrations = createV2RegistrationSet()
  registrations.add({ dispose: async () => disposed.push("first") })
  registrations.add({ dispose: async () => disposed.push("second") })
  await registrations.dispose()
  assert.deepEqual(disposed, ["second", "first"])
  await registrations.dispose()
  assert.throws(() => registrations.add({ dispose() {} }), /REGISTRATION_SET_CLOSED/)

  const failed = createV2RegistrationSet()
  failed.add({ dispose: async () => { throw new Error("first cleanup failure") } })
  failed.add({ dispose: async () => { throw new Error("second cleanup failure") } })
  await assert.rejects(() => failed.dispose(), (error) => error instanceof AggregateError && error.errors.length === 2)
  assert.equal(failed.size, 2)
})

test("V2 cleanup retry does not dispose a registration that was already confirmed", async () => {
  const registrations = createV2RegistrationSet()
  let failedOnce = false
  let successfulCalls = 0
  registrations.add({ async dispose() {
    if (!failedOnce) { failedOnce = true; throw new Error("temporary failure") }
  } })
  registrations.add({ async dispose() { successfulCalls += 1 } })
  await assert.rejects(() => registrations.dispose(), /O4E_V2_REGISTRATION_ROLLBACK_FAILED/)
  assert.equal(registrations.size, 1)
  await registrations.dispose()
  assert.equal(registrations.size, 0)
  assert.equal(successfulCalls, 1)
})

test("V2 feature setup failure cannot masquerade as a skipped Gate and must be rolled back", async () => {
  const capabilities = detectV2Capabilities({ tool: { transform() {} } })
  const registry = createV2FeatureRegistry(capabilities)
  const registrations = createV2RegistrationSet()
  const seen = []
  registry.define({ name: "status", feature: "statusTool", setup: async () => ({ dispose: async () => seen.push("disposed") }) })
  registry.define({ name: "broken", feature: "statusTool", setup: async () => {
    const error = new Error("setup failed after admission")
    error.code = "O4E_V2_FEATURE_UNAVAILABLE"
    throw error
  } })
  await assert.rejects(() => registry.install(registrations), /setup failed after admission/)
  await registrations.rollback()
  assert.deepEqual(seen, ["disposed"])
})
