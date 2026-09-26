import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"
import { createV2Plugin, v2AgentPermissionPreview, readV2Definition, v2McpConfig } from "../src/adapters/opencode-v2/compat.mjs"

const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function withFixture(t) {
  const target = mkdtempSync(join(tmpdir(), "o4e-v2-compat-"))
  t.after(() => rmSync(target, { recursive: true, force: true }))
  copyInstalledDefaults(componentRoot, target)
  return target
}

test("V2 selected config is read once; origin does not open configuration; invalid selected project fails closed", (t) => {
  const target = withFixture(t)
  assert.equal(readV2Definition(target, { o4e_mode: "origin", o4e_config: "/absent" }), null)
  assert.equal(readV2Definition(target, { XDG_CONFIG_HOME: target }).configRoot, join(target, ".o4e"))
  assert.throws(() => readV2Definition(target, { o4e_config: join(target, "absent") }), /O4E_V2_CONFIG_NOT_FOUND/)
})

test("V2 Agent permission preview is pure and denies unsupported execution; no ownership is inferred", (t) => {
  const target = withFixture(t)
  const definition = readV2Definition(target, { XDG_CONFIG_HOME: target })
  const hostRules = [{ action: "read", resource: "private/*", effect: "deny" }]
  const agent = definition.runtimeAgents.find((entry) => entry.name === "orchestrator")
  const rules = v2AgentPermissionPreview(agent, hostRules, definition)
  assert.deepEqual(rules[0], hostRules[0])
  assert.equal(hostRules.length, 1)
  assert.equal(rules.some((rule) => rule.effect !== "deny"), false)
  for (const action of ["shell", "subagent", "edit", "task", "o4e_task", "o4e_workflow"]) {
    assert.deepEqual(rules.findLast((rule) => rule.action === action), { action, resource: "*", effect: "deny" })
  }
  assert.throws(() => v2AgentPermissionPreview(agent, null, definition), /PERMISSIONS_UNAVAILABLE/)
})

test("V2 MCP pure transport translates only known equivalent shapes", () => {
  assert.deepEqual(v2McpConfig({ type: "local", command: ["example"], enabled: false }), {
    type: "local", command: ["example"], disabled: true,
  })
  assert.deepEqual(v2McpConfig({ type: "remote", url: "https://example.invalid", oauth: { clientId: "fixture" } }), {
    type: "remote", url: "https://example.invalid", oauth: { client_id: "fixture" },
  })
  assert.throws(() => v2McpConfig({ type: "local", command: ["example"], timeout: 5000 }), /MCP_TIMEOUT_UNSUPPORTED/)
  assert.throws(() => v2McpConfig({ enabled: true }), /MCP_INHERITED_SERVER_UNSUPPORTED/)
})

test("V2 plugin setup registers only read-only status, never modifies host Agents; cleanup disposes", async (t) => {
  const target = withFixture(t)
  const previous = process.env.o4e_config
  process.env.o4e_config = join(target, ".o4e")
  t.after(() => previous === undefined ? delete process.env.o4e_config : process.env.o4e_config = previous)
  const registrations = []
  const transforms = {}
  const makeTransform = (type) => async (fn) => {
    transforms[type] = fn
    return { async dispose() { registrations.push(type) } }
  }
  const plugin = createV2Plugin((value) => value)
  assert.equal(plugin.id, "opencode-for-everything-v2-preview")
  const cleanup = await plugin.setup({ location: { directory: target },
    mcp: { transform: makeTransform("mcp") }, agent: { transform: makeTransform("agent") }, tool: { transform: makeTransform("tool") } })
  assert.equal(transforms.mcp, undefined)
  assert.equal(transforms.agent, undefined)
  const tools = []
  transforms.tool({ get: () => undefined, add: (value) => tools.push(value) })
  assert.deepEqual(tools.map((tool) => tool.name), ["o4e_v2_status"])
  assert.deepEqual(tools[0].options, { codemode: false })
  assert.equal(JSON.parse((await tools[0].execute({}, {
    sessionID: "ses_test", messageID: "msg_test", id: "call_test", agent: "build", progress: async () => {},
  })).content).managedExecution, "unavailable")
  await cleanup()
  assert.deepEqual(registrations, ["tool"])
})

test("V2 replay rejects a host tool name collision without replacing it", async (t) => {
  const target = withFixture(t)
  const previous = process.env.o4e_config
  process.env.o4e_config = join(target, ".o4e")
  t.after(() => previous === undefined ? delete process.env.o4e_config : process.env.o4e_config = previous)
  let replay
  const cleanup = await createV2Plugin((value) => value).setup({
    location: { directory: target },
    tool: { async transform(callback) { replay = callback; return { async dispose() {} } } },
  })
  let added = false
  assert.throws(() => replay({ get: () => ({ name: "o4e_v2_status" }), add() { added = true } }), /O4E_V2_STATUS_TOOL_CONFLICT/)
  assert.equal(added, false)
  await cleanup()
})

test("V2 reports configured MCPs without registering or executing them", async (t) => {
  const target = withFixture(t)
  const previous = process.env.o4e_config
  process.env.o4e_config = join(target, ".o4e")
  t.after(() => previous === undefined ? delete process.env.o4e_config : process.env.o4e_config = previous)
  const configPath = join(target, ".o4e", "config.jsonc")
  const config = readFileSync(configPath, "utf8")
  writeFileSync(configPath, config.replace('"mcp": {},', '"mcp": { "fixture": { "type": "local", "command": ["never-run"] } },'))
  let replay
  const cleanup = await createV2Plugin((value) => value).setup({
    location: { directory: target },
    mcp: { transform() { throw new Error("MCP must never register") } },
    agent: { transform() { throw new Error("Agents must never be modified") } },
    tool: { async transform(fn) { replay = fn; return { async dispose() {} } } },
  })
  const tools = []
  replay({ get: () => undefined, add(tool) { tools.push(tool) } })
  assert.deepEqual(tools.map((tool) => tool.name), ["o4e_v2_status"])
  const status = JSON.parse((await tools[0].execute({}, {
    sessionID: "ses_test", messageID: "msg_test", id: "call_test", agent: "build", progress: async () => {},
  })).content)
  assert.equal(status.configuredMcpServerCount, 1)
  assert.equal(status.mcpProjection, "unavailable")
  assert.equal(status.managedExecution, "unavailable")
  await cleanup()
})

test("V2 setup failure preserves transform failure and does not claim a working tool", async (t) => {
  const target = withFixture(t)
  const previous = process.env.o4e_config
  process.env.o4e_config = join(target, ".o4e")
  t.after(() => previous === undefined ? delete process.env.o4e_config : process.env.o4e_config = previous)
  await assert.rejects(() => createV2Plugin((value) => value).setup({
    location: { directory: target }, tool: { async transform() { throw new Error("host rejected registration") } },
  }), /host rejected registration/)
})

test("V2 plugin rejects missing transform without registering; origin does not register", async (t) => {
  const target = withFixture(t)
  const previousMode = process.env.o4e_mode
  const previousRoot = process.env.o4e_config
  t.after(() => {
    if (previousMode === undefined) delete process.env.o4e_mode
    else process.env.o4e_mode = previousMode
    if (previousRoot === undefined) delete process.env.o4e_config
    else process.env.o4e_config = previousRoot
  })
  process.env.o4e_config = join(target, ".o4e")
  const plugin = createV2Plugin((value) => value)
  await assert.rejects(() => plugin.setup({ location: { directory: target } }), /O4E_V2_FEATURE_UNAVAILABLE:statusTool/)
  process.env.o4e_mode = "origin"
  assert.equal(await plugin.setup({ location: { directory: target } }), undefined)
})
