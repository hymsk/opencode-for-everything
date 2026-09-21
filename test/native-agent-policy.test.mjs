import assert from "node:assert/strict"
import test from "node:test"
import { normalizeNativeAgentStrategies, resolveNativeAgentPolicy } from "../src/core/native-agent-policy.mjs"

const allStrategies = { build: "managed", plan: "managed", general: "managed", explore: "keep" }

test("native Agent 策略要求四个受支持名称和三态值", () => {
  assert.deepEqual(normalizeNativeAgentStrategies(allStrategies), allStrategies)
  assert.throws(() => normalizeNativeAgentStrategies({ ...allStrategies, other: "keep" }), /不支持原生 Agent: other/)
  assert.throws(() => normalizeNativeAgentStrategies({ ...allStrategies, plan: "allow" }), /nativeAgents\.plan 必须是 keep、managed 或 disable/)
  assert.throws(() => normalizeNativeAgentStrategies({ build: "keep" }), /nativeAgents\.plan 必须是 keep、managed 或 disable/)
})

test("nativeAgents 必须显式声明", () => {
  assert.throws(() => resolveNativeAgentPolicy(undefined, []), /nativeAgents 必须是对象/)
})

test("显式策略要求 managed Agent 与配置事实一致", () => {
  const agents = [
    { name: "custom-build", nativeMode: "build", type: "primary" },
    { name: "custom-plan", nativeMode: "plan", type: "primary" },
    { name: "general", type: "subagent" },
  ]

  assert.deepEqual(resolveNativeAgentPolicy(allStrategies, agents).strategies, allStrategies)
  assert.throws(() => resolveNativeAgentPolicy({ ...allStrategies, general: "keep" }, agents, "config.nativeAgents"), /config\.nativeAgents\.general 为 keep 时不能存在对应的受管 Agent 配置: general/)
  assert.throws(() => resolveNativeAgentPolicy({ ...allStrategies, plan: "keep" }, agents, "config.nativeAgents"), /config\.nativeAgents\.plan 为 keep 时不能存在对应的受管 Agent 配置: custom-plan/)
  assert.throws(() => resolveNativeAgentPolicy({ ...allStrategies, explore: "managed" }, agents, "config.nativeAgents"), /config\.nativeAgents\.explore 为 managed 时必须存在对应的受管 Agent 配置/)
  assert.throws(() => resolveNativeAgentPolicy({ ...allStrategies, build: "managed" }, [{ name: "general", type: "subagent" }], "config.nativeAgents"), /config\.nativeAgents\.build 为 managed 时必须存在对应的受管 Agent 配置/)
})
