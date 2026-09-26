import assert from "node:assert/strict"
import test from "node:test"
import guard, { assertPreviewAgent } from "../src/adapters/opencode-v2/preview-guard.mjs"

const id = "o4e-v2-preview-plan-chat"
const agent = { id, mode: "primary", system: `<!--opencode-for-everything-v2-preview-agent:${id}-->`,
  permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "*", resource: "*", effect: "deny" }] }

test("guard rejects appended permission grants and missing identity", () => {
  assert.doesNotThrow(() => assertPreviewAgent(agent, id))
  for (const altered of [{ ...agent, id: "other" }, { ...agent, system: "unrelated" },
    { ...agent, permissions: [...agent.permissions, { action: "shell", resource: "*", effect: "allow" }] },
    { ...agent, permissions: null }]) {
    assert.throws(() => assertPreviewAgent(altered, id), /UNVERIFIABLE/)
  }
})

test("guard checks model context and denies Session-owned permission checks; cleans up registrations", async () => {
  const callbacks = {}, disposed = []
  const register = (prefix) => async (name, callback) => {
    callbacks[`${prefix}.${name}`] = callback
    return { async dispose() { disposed.push(`${prefix}.${name}`) } }
  }
  const dispose = await guard.setup({
    agent: { get: async () => ({ data: agent }) },
    session: { get: async ({ sessionID }) => ({ data: { id: sessionID, agent: id } }), hook: register("session") },
    permission: { hook: register("permission") },
  })
  await callbacks["session.context"]({ agent: id, tools: {} })
  await assert.rejects(callbacks["session.context"]({ agent: id, tools: { shell: {} } }), /TOOLS_VISIBLE/)
  await callbacks["session.model.request"]({ agent: id })
  const event = { sessionID: "ses_test", action: "shell", effect: "allow" }
  await callbacks["permission.evaluate"](event)
  assert.equal(event.effect, "deny")
  await dispose()
  assert.deepEqual(disposed, ["permission.evaluate", "session.model.request", "session.context"])
})

test("registration failure disposes earlier guard hooks", async () => {
  let disposed = 0
  await assert.rejects(guard.setup({ session: { hook: async () => ({ async dispose() { disposed++ } }) },
    permission: { hook: async () => { throw new Error("host refused") } } }), /host refused/)
  assert.equal(disposed, 2)
})
