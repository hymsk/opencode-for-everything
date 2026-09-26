import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"
import { buildV2PreviewAgents, renderV2PreviewAgent } from "../src/adapters/opencode-v2/agent-preview-builder.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "o4e-v2-builder-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configRoot = copyInstalledDefaults(resolve(import.meta.dirname, ".."), join(root, "source"))
  const target = join(root, "target")
  mkdirSync(target)
  return { root, configRoot, target }
}

test("isolated V2 Agent preview preserves names, modes, variants and denies every tool", (t) => {
  const { configRoot, target } = fixture(t)
  const result = buildV2PreviewAgents({ configRoot, target })
  assert.ok(result.names.includes("o4e-v2-preview-agent-orchestrator"))
  assert.ok(result.names.includes("o4e-v2-preview-plan-chat"))
  const agent = readFileSync(join(result.directory, "o4e-v2-preview-agent-orchestrator.md"), "utf8")
  assert.match(agent, /mode: all/)
  assert.match(agent, /action: "\*"\n    resource: "\*"\n    effect: deny/)
  assert.match(readFileSync(join(result.guard, "index.mjs"), "utf8"), /O4E_V2_PREVIEW_TOOLS_VISIBLE/)
  assert.doesNotMatch(agent, /task-authority|You are an|你是/)
  assert.deepEqual(readdirSync(target), [".opencode"])
  assert.throws(() => buildV2PreviewAgents({ configRoot, target }), /TARGET_NOT_EMPTY/)
  const model = renderV2PreviewAgent({ name: "reviewer", type: "subagent", model: { id: "fixture/probe", variant: "high" } })
  assert.match(model.content, /model: "fixture\/probe#high"/)
  assert.match(renderV2PreviewAgent({ name: "reviewer", type: "subagent",
    model: { id: "fixture/probe", variant: "high+fast" } }).content, /model: "fixture\/probe#high\+fast"/)
  assert.throws(() => renderV2PreviewAgent({ name: "reviewer", type: "subagent",
    model: { id: "fixture/probe", variant: "high#fast" } }), /MODEL_UNSUPPORTED/)
  assert.match(model.content, /mode: subagent/)
  assert.notEqual(renderV2PreviewAgent({ name: "foo-plan", type: "all" }).name,
    renderV2PreviewAgent({ name: "foo (plan)", type: "all" }).name)
  assert.throws(() => renderV2PreviewAgent({ name: "reviewer", type: "subagent", model: { id: "unsafe/model\npermissions: []" } }), /MODEL_UNSUPPORTED/)
})

test("V2 preview rejects nonempty, symlink and invalid config before output", (t) => {
  const { root, configRoot, target } = fixture(t)
  writeFileSync(join(target, "opencode.json"), "{}")
  assert.throws(() => buildV2PreviewAgents({ configRoot, target }), /TARGET_NOT_EMPTY/)
  assert.deepEqual(readdirSync(target), ["opencode.json"])
  const link = join(root, "linked-target")
  symlinkSync(target, link, "dir")
  assert.throws(() => buildV2PreviewAgents({ configRoot, target: link }), /TARGET_NOT_EMPTY/)
  rmSync(join(target, "opencode.json"))
  assert.throws(() => buildV2PreviewAgents({ configRoot: join(root, "missing"), target }), /ENOENT|配置根目录/)
  assert.deepEqual(readdirSync(target), [])
  assert.equal(existsSync(join(target, ".opencode")), false)
  const inside = join(configRoot, "empty-preview")
  mkdirSync(inside)
  assert.throws(() => buildV2PreviewAgents({ configRoot, target: inside }), /SOURCE_TARGET_OVERLAP/)
  assert.deepEqual(readdirSync(inside), [])
  assert.throws(() => buildV2PreviewAgents({ configRoot, target: root }), /TARGET_NOT_EMPTY/)
  assert.throws(() => buildV2PreviewAgents({ configRoot, target: "relative-target" }), /ABSOLUTE_PATH_REQUIRED/)
  assert.throws(() => buildV2PreviewAgents({ configRoot: "relative-source", target }), /ABSOLUTE_PATH_REQUIRED/)
  assert.throws(() => renderV2PreviewAgent({ name: "../foreign", type: "primary" }), /AGENT_INVALID/)
  assert.throws(() => renderV2PreviewAgent({ name: "test", type: "system" }), /AGENT_INVALID/)
})
