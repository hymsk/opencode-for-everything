import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { loadRuntimeDefinition } from "../src/runtime-builder.mjs"
import { effectiveAgentPermission } from "../src/core/agent-routing.mjs"
import { copyInstalledDefaults, readConfigJson, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"
import { runtimeWorkflowOptions } from "../src/tui/workflow-options.mjs"

function fixture(t) {
  const target = mkdtempSync(join(tmpdir(), "o4e-workflow-beta-"))
  t.after(() => rmSync(target, { recursive: true, force: true }))
  copyInstalledDefaults(resolve(import.meta.dirname, ".."), target)
  const root = join(target, ".o4e")
  return { root, config: readConfigJson(root, "config.json") }
}

test("Workflow Beta defaults off, including omitted config and expanded Plan profiles", (t) => {
  const { root, config } = fixture(t)
  for (const value of [false, undefined]) {
    if (value === undefined) delete config.enableWorkflow
    else config.enableWorkflow = value
    writeConfigJson(join(root, "config.json"), config)
    const definition = loadRuntimeDefinition(root)
    assert.equal(definition.config.enableWorkflow, false)
    assert.ok(definition.runtimeAgents.some((agent) => agent.planProfile))
    for (const agent of definition.runtimeAgents) {
      assert.deepEqual(agent.loadWorkflows, [])
      assert.deepEqual(agent.blockWorkflows, ["*"])
      assert.equal(effectiveAgentPermission({ ...agent, permission: { "*": "allow", o4e_workflow: "allow" } }, { agents: definition.runtimeAgents }).o4e_workflow, "deny")
    }
  }
})

test("Workflow Beta opt-in preserves configured role access without enabling child execution", (t) => {
  const { root, config } = fixture(t)
  writeConfigJson(join(root, "config.json"), { ...config, enableWorkflow: true })
  const definition = loadRuntimeDefinition(root)
  assert.equal(definition.config.enableWorkflow, true)
  assert.ok(definition.runtimeAgents.find((agent) => agent.name === "orchestrator").loadWorkflows.includes("quality-gate"))
  assert.ok(definition.workflows.has("quality-gate"))
})

test("Workflow Beta rejects non-boolean opt-in instead of treating it as enabled", (t) => {
  const { root, config } = fixture(t)
  for (const value of [null, 0, 1, "true", "false", {}, []]) {
    writeConfigJson(join(root, "config.json"), { ...config, enableWorkflow: value })
    assert.throws(() => loadRuntimeDefinition(root), /config.enableWorkflow/)
  }
})

test("disabled Beta tool fails before Session reads or host authorization", async (t) => {
  const { root } = fixture(t)
  let reads = 0
  let asks = 0
  const target = resolve(root, "..")
  const hooks = await OpenCodeForEverythingPlugin({ directory: target, worktree: target, client: { session: {
    get: async () => { reads++; throw new Error("must not read Workflow state") },
    messages: async () => { reads++; throw new Error("must not read Workflow messages") },
  } } })
  for (const action of ["catalog", "list", "start", "read", "begin", "report", "resume", "pause", "stop"]) {
    await assert.rejects(() => hooks.tool.o4e_workflow.execute({ action }, {
      sessionID: "owner", agent: "orchestrator", ask: async () => { asks++ },
    }), /O4E_WORKFLOW_DISABLED/)
  }
  assert.equal(reads, 0)
  assert.equal(asks, 0)
})

test("TUI Beta uses selected project/explicit/global config, never stale build options", (t) => {
  const home = mkdtempSync(join(tmpdir(), "o4e-tui-roots-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const directory = join(home, "project")
  const projectRoot = join(directory, ".o4e")
  const globalRoot = join(home, ".config", "opencode", ".o4e")
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })
  const save = (root, value) => writeFileSync(join(root, "config.jsonc"), JSON.stringify({ enableWorkflow: value }))
  const selected = (options, env = {}) => runtimeWorkflowOptions(options, env, home, directory).enableWorkflow
  for (const enabled of [false, true]) {
    save(projectRoot, enabled)
    save(globalRoot, !enabled)
    assert.equal(selected({ enableWorkflow: !enabled, configRoot: globalRoot }), enabled)
    assert.equal(selected({}, { o4e_config: globalRoot }), !enabled)
    assert.equal(selected({}, { o4e_config: "~/.config/opencode/.o4e" }), !enabled)
  }
  for (const env of [{ o4e_mode: "origin" }, { o4e_config: "" }, { o4e_config: "relative" }, { o4e_config: join(home, "missing") }]) {
    assert.equal(selected({ enableWorkflow: true }, env), false)
  }
  // 非法 o4e_mode 与 default 一致：正常读取选定配置（此处 projectRoot 为 true）
  assert.equal(selected({ enableWorkflow: false }, { o4e_mode: "invalid" }), true)
  save(globalRoot, true)
  writeFileSync(join(projectRoot, "config.jsonc"), "invalid")
  writeFileSync(join(projectRoot, "config.json"), '{"enableWorkflow":true}')
  assert.equal(selected({ enableWorkflow: true }), false, "invalid preferred JSONC cannot fall back")
  rmSync(projectRoot, { recursive: true })
  assert.equal(selected({ enableWorkflow: false }), true, "absent project selects global")
  assert.equal(runtimeWorkflowOptions({ enableWorkflow: true }, {}, home).enableWorkflow, false, "unknown TUI directory stays disabled")
})
