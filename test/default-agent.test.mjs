import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadRuntimeDefinition } from "../src/runtime-builder.mjs"
import { createOpenCodeHooks } from "../src/adapters/opencode/plugin-hooks.ts"

function fixture(defaultAgent) {
  const target = mkdtempSync(join(tmpdir(), "o4e-default-agent-"))
  const root = join(target, ".o4e")
  for (const type of ["all", "primary", "subagent", "system"]) mkdirSync(join(root, "agents", type), { recursive: true })
  writeFileSync(join(root, "config.json"), JSON.stringify({
    defaultAgent, soul: { enabled: false },
    nativeAgents: { build: "disable", plan: "disable", general: "disable", explore: "disable" },
  }))
  for (const [type, name, plan] of [["all", "main", { mode: "child" }], ["primary", "chat", { mode: "self" }], ["subagent", "worker"]]) {
    writeFileSync(join(root, "agents", type, `${name}.json`), JSON.stringify({ name, description: name, base: "Fixture prompt", plan }))
  }
  return { target, root }
}

test("defaultAgent 接受可写主 Agent 和统一后缀 Plan，显式覆盖宿主默认入口", async () => {
  for (const name of ["main", "main (plan)", "chat (plan)"]) {
    const { target, root } = fixture(name)
    try {
      assert.equal(loadRuntimeDefinition(root).config.defaultAgent, name)
      const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
      const config = { default_agent: "build", agent: {} }
      await hooks.config(config)
      assert.equal(config.default_agent, name)
    } finally { rmSync(target, { recursive: true, force: true }) }
  }
})

test("省略 defaultAgent 保留宿主选择或未设置状态", async () => {
  const { target } = fixture()
  try {
    const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
    for (const selected of [undefined, "chat"]) {
      const config = { default_agent: selected, agent: {} }
      await hooks.config(config)
      assert.equal(config.default_agent, selected)
    }
  } finally { rmSync(target, { recursive: true, force: true }) }
})

test("defaultAgent 拒绝缺失、纯子 Agent、禁用原生入口、self 原名、历史后缀及非法值", () => {
  for (const value of ["missing", "worker", "build", "chat", "main (Plan)", "chat (Plan)", "", null, 1, {}]) {
    const { target, root } = fixture(value)
    try { assert.throws(() => loadRuntimeDefinition(root), /config\.defaultAgent/) }
    finally { rmSync(target, { recursive: true, force: true }) }
  }
})

test("defaultAgent 不重新启用宿主显式禁用的角色", async () => {
  const { target } = fixture("chat (plan)")
  try {
    const hooks = await createOpenCodeHooks({ client: {}, directory: target, worktree: target })
    const config = { default_agent: "main", agent: { "chat (plan)": { disable: true } } }
    await assert.rejects(hooks.config(config), /config\.defaultAgent/)
    assert.equal(config.default_agent, "main")
  } finally { rmSync(target, { recursive: true, force: true }) }
})
