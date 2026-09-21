import assert from "node:assert/strict"
import test from "node:test"
import { applyNativeAgentTakeover } from "../src/core/native-takeover.mjs"

test("配置的 nativeMode 会彻底禁用原生 build/plan", () => {
  const config = {
    default_agent: "build",
    agent: {
      build: { model: "stale/build" },
      plan: { model: "stale/plan" },
      "custom-build": { model: "provider/build" },
      "custom-plan": { model: "provider/plan" },
    },
  }

  applyNativeAgentTakeover(config, { build: "custom-build", plan: "custom-plan" }, {
    build: "managed",
    plan: "managed",
    general: "keep",
    explore: "keep",
  })

  assert.deepEqual(config.agent.build, { disable: true })
  assert.deepEqual(config.agent.plan, { disable: true })
  assert.deepEqual(config.agent["custom-build"], { model: "provider/build" })
  assert.equal(config.default_agent, "custom-build")
})

test("别名映射目标会清除宿主残留 disable", () => {
  const config = {
    agent: {
      plan: { model: "stale/plan" },
      "plan (plan)": { model: "managed/plan", disable: true },
    },
  }

  applyNativeAgentTakeover(config, { plan: "plan (plan)" }, {
    build: "keep",
    plan: "managed",
    general: "keep",
    explore: "keep",
  })

  assert.deepEqual(config.agent.plan, { disable: true })
  assert.deepEqual(config.agent["plan (plan)"], { model: "managed/plan" })
})

test("缺少映射时不禁用或改写未受管的原生模式", () => {
  const config = { default_agent: "plan", agent: { build: { model: "stale/build" } } }

  applyNativeAgentTakeover(config, {}, {
    build: "keep",
    plan: "keep",
    general: "keep",
    explore: "keep",
  })

  assert.deepEqual(config.agent.build, { model: "stale/build" })
  assert.equal(config.agent.plan, undefined)
  assert.equal(config.default_agent, "plan")
})

test("build 和 plan 可作为同名原生模式映射目标", () => {
  const config = { default_agent: "build", agent: { build: { model: "managed/build", disable: true }, plan: { model: "managed/plan", disable: true } } }

  applyNativeAgentTakeover(config, { build: "build", plan: "plan" }, {
    build: "managed",
    plan: "managed",
    general: "keep",
    explore: "keep",
  })

  assert.deepEqual(config.agent.build, { model: "managed/build" })
  assert.deepEqual(config.agent.plan, { model: "managed/plan" })
  assert.equal(config.default_agent, "build")
})

test("四项 native Agent 策略分别投影 keep、managed 和 disable", () => {
  const config = {
    default_agent: "build",
    agent: {
      build: { model: "managed/build", disable: true },
      plan: { model: "host/plan", disable: true },
      general: { model: "host/general" },
      explore: { model: "host/explore" },
    },
  }

  applyNativeAgentTakeover(config, { build: "build" }, {
    build: "managed",
    plan: "keep",
    general: "disable",
    explore: "managed",
  })

  assert.deepEqual(config.agent.build, { model: "managed/build" })
  assert.deepEqual(config.agent.plan, { model: "host/plan", disable: true })
  assert.deepEqual(config.agent.general, { disable: true })
  assert.deepEqual(config.agent.explore, { model: "host/explore" })
  assert.equal(config.default_agent, "build")
})
