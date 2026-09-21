import assert from "node:assert/strict"
import { linkSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { formatInstructionFiles, loadInstructionFiles } from "../src/agent-context.mjs"
import { BUILTIN_TOOL_NAMES } from "../src/core/capability-policy.mjs"
import { applyAgentPolicies, applyMcpConfig } from "../src/adapters/opencode/context-projection.mjs"
import { createDirectoryLink, createFileLink } from "./helpers/fs-link-fixture.mjs"

test("指令文件按全局和项目范围读取并去重", () => {
  const globalRoot = mkdtempSync(join(tmpdir(), "o4e-global-"))
  const projectRoot = mkdtempSync(join(tmpdir(), "o4e-project-"))
  try {
    const globalFile = join(globalRoot, "CLAUDE.md")
    writeFileSync(globalFile, "global instructions")
    writeFileSync(join(projectRoot, "CLAUDE.md"), "project instructions")
    const override = { global: [globalFile, globalFile], project: ["CLAUDE.md"] }

    const instructions = loadInstructionFiles(override, { projectRoot })
    assert.deepEqual(instructions, [
      { scope: "global", file: globalFile, content: "global instructions" },
      { scope: "project", file: "CLAUDE.md", content: "project instructions" },
    ])
    assert.match(formatInstructionFiles(instructions), /# global: /)
    assert.match(formatInstructionFiles(instructions), /project instructions/)
  } finally {
    rmSync(globalRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test("额外项目 instruction file 在 AGENTS.md 之后加载，并可由完整 agent 配置排除", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "o4e-project-rules-"))
  try {
    writeFileSync(join(projectRoot, "AGENTS.md"), "engineering rules")
    writeFileSync(join(projectRoot, "project-rules.md"), "acceptance contract")
    const defaults = { global: [], project: ["AGENTS.md", "project-rules.md"] }

    assert.deepEqual(loadInstructionFiles(defaults, { projectRoot }), [
      { scope: "project", file: "AGENTS.md", content: "engineering rules" },
      { scope: "project", file: "project-rules.md", content: "acceptance contract" },
    ])
    assert.deepEqual(loadInstructionFiles({ global: [], project: [] }, { projectRoot }), [])
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test("项目 instruction file 即使保留 mtime 也会读取更新内容", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "o4e-project-rules-cache-"))
  const rulesPath = join(projectRoot, "project-rules.md")
  try {
    writeFileSync(rulesPath, "first contract")
    const original = statSync(rulesPath)
    const files = { global: [], project: ["project-rules.md"] }
    assert.equal(loadInstructionFiles(files, { projectRoot })[0].content, "first contract")

    writeFileSync(rulesPath, "later contract")
    utimesSync(rulesPath, original.atime, original.mtime)
    assert.equal(loadInstructionFiles(files, { projectRoot })[0].content, "later contract")
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test("项目 instruction file 拒绝符号链接、硬链接和真实路径越界", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "o4e-project-instruction-links-"))
  const externalRoot = mkdtempSync(join(tmpdir(), "o4e-external-instruction-"))
  const externalFile = join(externalRoot, "secret.md")
  try {
    writeFileSync(externalFile, "external secret")
    createFileLink(externalFile, join(projectRoot, "project-rules.md"))
    assert.deepEqual(loadInstructionFiles({ global: [], project: ["project-rules.md"] }, { projectRoot }), [])

    rmSync(join(projectRoot, "project-rules.md"))
    linkSync(externalFile, join(projectRoot, "project-rules.md"))
    assert.deepEqual(loadInstructionFiles({ global: [], project: ["project-rules.md"] }, { projectRoot }), [])

    rmSync(join(projectRoot, "project-rules.md"))
    createDirectoryLink(externalRoot, join(projectRoot, "linked"))
    assert.deepEqual(loadInstructionFiles({ global: [], project: ["linked/secret.md"] }, { projectRoot }), [])
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test("loadSkills 按名称限制目标 agent 的 skill 工具", () => {
  const config = {
    agent: {
      simple: { tools: { bash: true } },
      full: { tools: { read: true } },
    },
  }

  applyAgentPolicies(config, [
    { name: "simple", type: "primary", loadSkills: ["docs", "review"] },
    { name: "full", type: "primary", loadSkills: ["*"] },
  ])

  assert.deepEqual(config.agent.simple.tools, { bash: true })
  assert.deepEqual(config.agent.simple.permission.skill, { "*": "deny", docs: "allow", review: "allow" })
  assert.deepEqual(config.agent.full.tools, { read: true })
  assert.equal(config.agent.full.permission.skill, undefined)
})

test("loadTools 以白名单管理内置工具，loadSkills 仍可强制关闭 skill", () => {
  const config = {
    agent: {
      simple: { tools: { bash: true, external: "keep" }, permission: { external: "allow" } },
      full: { tools: { read: true } },
    },
  }

  applyAgentPolicies(config, [
    { name: "simple", type: "primary", loadTools: ["read", "skill"], loadSkills: [] },
    { name: "full", type: "primary", loadTools: undefined },
  ])
  assert.equal(config.agent.simple.tools.external, "keep")
  assert.equal(config.agent.simple.permission.external, "allow")
  for (const tool of BUILTIN_TOOL_NAMES) {
    if (tool === "skill") continue
    assert.equal(config.agent.simple.permission[tool], tool === "read" ? "allow" : "deny")
  }
  assert.deepEqual(config.agent.simple.permission.skill, { "*": "deny" })
  assert.equal(config.agent.simple.permission.invalid, "deny")
  assert.equal(config.agent.full.tools.read, true)
  assert.equal(config.agent.full.tools.bash, undefined)
})

test("受管 MCP 全局关闭后仅对授权 agent 开放指定工具", () => {
   const config = {
     mcp: { inherited: { type: "local", command: ["inherited"] } },
     tools: { "inherited_*": true },
     permission: { existing_tool: "allow" },
    agent: {
      orchestrator: { tools: { existing: true } },
      architect: { tools: { existing: true } },
    },
  }
  const managedMcp = {
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", headers: { "X-Token": "{env:CONTEXT7_API_KEY}" } },
  }

  applyMcpConfig(config, managedMcp)
  applyAgentPolicies(config, [
    { name: "orchestrator", type: "all", loadMcp: { context7: ["resolve-library-id", "query-docs"] } },
    { name: "architect", type: "subagent", loadMcp: {} },
  ], managedMcp)

  assert.deepEqual(config.mcp.context7, managedMcp.context7)
  config.mcp.context7.headers["X-Token"] = "host mutation"
  assert.equal(managedMcp.context7.headers["X-Token"], "{env:CONTEXT7_API_KEY}")
  assert.deepEqual(config.mcp.inherited, { type: "local", command: ["inherited"] })
   assert.equal(config.permission["context7_*"], undefined)
   assert.equal(config.permission.existing_tool, "allow")
   assert.equal(config.tools["inherited_*"], true)
   assert.equal(config.agent.orchestrator.tools.existing, true)
   assert.equal(config.agent.orchestrator.permission["context7_*"], "deny")
   assert.equal(config.agent.orchestrator.permission["context7_resolve-library-id"], "allow")
   assert.equal(config.agent.orchestrator.permission["context7_query-docs"], "allow")
   assert.equal(config.agent.architect.permission["context7_resolve-library-id"], undefined)
   assert.equal(config.agent.architect.permission["context7_*"], "deny")
})

test("MCP server 通配授权会保留 OpenCode 的 server 工具匹配模式", () => {
  const config = { agent: {} }

  applyAgentPolicies(config, [{ name: "researcher", type: "subagent", loadMcp: { "doc-search": ["*"] } }], undefined)

   assert.equal(config.permission["doc-search_*"], undefined)
   assert.equal(config.agent.researcher.permission["doc-search_*"], "allow")
})

test("Plan Profile 不继承 MCP 授权", () => {
  const config = { agent: {} }

  applyAgentPolicies(config, [{ name: "orchestrator (plan)", type: "all", planProfile: true, loadTools: ["read"], loadMcp: { context7: ["query-docs"] } }], undefined)

  assert.equal(config.permission["context7_*"], undefined)
  assert.equal(config.agent["orchestrator (plan)"].permission["context7_*"], "deny")
  assert.equal(config.agent["orchestrator (plan)"].permission["context7_query-docs"], "deny")
})
