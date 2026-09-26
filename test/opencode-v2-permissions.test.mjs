import test from "node:test"
import assert from "node:assert/strict"
import { toV2PermissionAction, toV2PermissionRules } from "../src/adapters/opencode-v2/permissions.mjs"

test("V2 permission transport preserves ordered denies, asks, resource patterns and input", () => {
  const rules = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git *", action: "ask" },
    { permission: "bash", pattern: "git status", action: "allow" },
    { permission: "task", pattern: "tester", action: "ask" },
    { permission: "edit", pattern: "~/src/*", action: "deny" },
    { permission: "o4e_task", pattern: "agent:cancel", action: "allow" },
  ]
  const before = structuredClone(rules)
  assert.deepEqual(toV2PermissionRules(rules), [
    { action: "*", resource: "*", effect: "deny" },
    { action: "shell", resource: "git *", effect: "ask" },
    { action: "shell", resource: "git status", effect: "allow" },
    { action: "subagent", resource: "tester", effect: "ask" },
    { action: "edit", resource: "~/src/*", effect: "deny" },
    { action: "o4e_task", resource: "agent:cancel", effect: "allow" },
  ])
  assert.deepEqual(rules, before)
  assert.deepEqual(toV2PermissionRules([]), [])
})

test("V2 permission transport fails closed without echoing input", () => {
  for (const rules of [null, {}, [null], [{ permission: "bash", pattern: "private-value", action: "permit" }],
    [{ permission: "bash", pattern: "*", action: "allow", extra: true }],
    [{ permission: "bash", pattern: "", action: "deny" }]]) {
    assert.throws(() => toV2PermissionRules(rules), (error) => /^O4E_V2_INVALID_PERMISSION_/.test(error.message)
      && !error.message.includes("private-value"))
  }
  assert.throws(() => toV2PermissionAction("ba*"), /ACTION_PATTERN_UNSUPPORTED/)
  assert.throws(() => toV2PermissionAction(undefined), /INVALID_PERMISSION_ACTION/)
})
