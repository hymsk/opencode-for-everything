import assert from "node:assert/strict"
import test from "node:test"
import { applyAgentPolicies } from "../src/adapters/opencode/context-projection.mjs"
import {
  applyInheritedPermissionOverlay,
  applyManagedDelegationPermission,
  applyPermissionOverlay,
  applyRuntimeSafetyPermission,
  collectMcpServerNames,
  deriveSelfEffects,
  effectiveAgentPermission,
  legalAgentCandidates,
  mergeAgentPermission,
  normalizePermissionOverlay,
  permissionAction,
  permissionRules,
  selectPreferredAgent,
  toolMayHaveSideEffects,
} from "../src/core/agent-routing.mjs"

test("permissionOverlay 只能收紧权限", () => {
  assert.deepEqual(normalizePermissionOverlay({ bash: "deny", edit: "ask" }, { bash: "allow", edit: "allow" }), { bash: "deny", edit: "ask" })
  assert.throws(() => normalizePermissionOverlay({ "functions.bash": "deny" }, { bash: "allow" }), /请改用 bash/)
  assert.throws(() => normalizePermissionOverlay({ "functions.apply_patch": "deny" }, { edit: "allow" }), /请改用 edit/)
  assert.throws(() => normalizePermissionOverlay({ apply_patch: "deny" }, { edit: "allow" }), /请改用 edit/)
  assert.throws(() => normalizePermissionOverlay({ bash: "ask" }, { bash: "deny" }), /不能把 deny 扩大为 ask/)
  assert.throws(() => normalizePermissionOverlay({ "*": "ask" }, { "*": "allow", task: "deny" }), /不能把 deny 扩大为 ask/)
  assert.deepEqual(applyPermissionOverlay({ bash: "allow" }, { bash: "deny" }), { bash: "deny" })
  assert.deepEqual(applyPermissionOverlay({ "*": "allow", bash: "allow", edit: { "*": "allow", "secret/**": "deny" } }, { "*": "deny" }), {
    "*": "deny",
    bash: "deny",
    edit: "deny",
  })
  assert.throws(() => normalizePermissionOverlay({ "context7_query-docs": "ask" }, { "context7_*": "deny" }), /不能把 deny 扩大为 ask/)
  assert.deepEqual(normalizePermissionOverlay({ "context7_query-docs": "ask" }, {
    "context7_*": "deny",
    "context7_query-docs": "allow",
  }), { "context7_query-docs": "ask" })
  assert.throws(() => normalizePermissionOverlay({ "context7_query-docs": "ask" }, {
    "context7_query-docs": "allow",
    "context7_*": "deny",
  }), /不能把 deny 扩大为 ask/)
  assert.throws(() => normalizePermissionOverlay({ "context7_query-docs": "ask" }, {
    "context7_*": { "*": "allow", "secret/**": "deny" },
  }), /不能把 deny 扩大为 ask/)
  assert.equal(permissionRules(applyPermissionOverlay({
    "context7_query-docs": "allow",
    "context7_*": "allow",
  }, { "context7_query-docs": "deny" })).findLast((rule) => rule.permission === "context7_query-docs")?.action, "deny")
  assert.equal(deriveSelfEffects({ permission: { bash: "allow", edit: "allow" } }, { permissionOverlay: { "*": "deny" } }).kind, "read")
})

test("权限合并只接受 canonical edit 并保留显式覆盖", () => {
  assert.deepEqual(mergeAgentPermission({ edit: "allow" }, { edit: "deny" }), { edit: "deny" })
  assert.throws(() => normalizePermissionOverlay({ write: "ask" }, { edit: "allow" }), /请改用 edit/)
})

test("继承 Overlay 收紧目标权限并保留已有 deny 和资源规则", () => {
  const all = applyInheritedPermissionOverlay({ bash: "deny", read: "allow", "*": { "secret/*": "deny" } }, { "*": "ask" })
  assert.equal(permissionAction(all, "bash", "pwd"), "deny")
  assert.equal(permissionAction(all, "read", "src/file"), "ask")
  assert.equal(permissionAction(all, "custom", "public/file"), "ask")
  assert.equal(permissionAction(all, "custom", "secret/file"), "deny")
  const bash = applyInheritedPermissionOverlay({
    "*": "deny", bash: { "*": "allow", "rm *": "deny", "git *": "ask" }, read: "allow",
  }, { bash: "ask" })
  assert.equal(permissionAction(bash, "bash", "printf hi"), "ask")
  assert.equal(permissionAction(bash, "bash", "rm file"), "deny")
  assert.equal(permissionAction(bash, "bash", "git status"), "ask")
  assert.equal(permissionAction(bash, "read", "file"), "allow")
  const denied = applyInheritedPermissionOverlay({ "*": "allow", fs_read: "ask" }, { "fs_*": "deny" })
  assert.equal(permissionAction(denied, "fs_read", "file"), "deny")
  assert.equal(permissionAction(denied, "fs_write", "file"), "deny")
  assert.equal(permissionAction(denied, "read", "file"), "allow")
  assert.equal(permissionAction(applyInheritedPermissionOverlay("deny", { bash: "ask", "*": "ask" }), "bash", "pwd"), "deny")
  assert.throws(() => applyInheritedPermissionOverlay({ "fs_*": "allow" }, { "fs_?": "ask" }), /intersection cannot be verified/)
})

test("受管 task 只开放 loadAgents 目标，Plan 继承路由能力且允许显式关闭", () => {
  const regular = {
    name: "regular",
    type: "all",
    loadTools: ["read", "task"],
    loadAgents: ["worker"],
    loadWorkflows: [],
    permission: { task: "allow" },
  }
  const plan = {
    ...regular,
    name: "regular-plan",
    planProfile: true,
    planOverrides: { loadTools: true },
  }
  const worker = { name: "worker", type: "subagent" }
  const agents = [regular, plan, worker]

  assert.deepEqual(effectiveAgentPermission(regular, { agents }).task, { "*": "deny", worker: "allow" })
  assert.equal(effectiveAgentPermission({ ...regular, loadTools: ["read"] }, { agents }).task, "deny")
  assert.deepEqual(effectiveAgentPermission(plan, { agents }).task, {
    "*": "deny",
    worker: "allow",
  })
  assert.equal(effectiveAgentPermission({ ...plan, loadAgents: [], planOverrides: { loadTools: true, loadAgents: true } }, { agents }).task, "deny")
})

test("subagent 可按目标权限继续委派，但不能通过显式权限开放 Workflow", () => {
  const worker = {
    name: "worker",
    type: "subagent",
    loadTools: ["read", "task"],
    loadAgents: ["peer"],
    loadWorkflows: ["flow"],
    permission: {
      task: "allow",
      o4e_task: "allow",
      o4e_workflow: "allow",
    },
  }
  const agents = [worker, { name: "peer", type: "subagent" }, { name: "unloaded", type: "all" }]
  const permission = effectiveAgentPermission(worker, { agents })
  assert.deepEqual(permission.task, { "*": "deny", peer: "allow" })
  assert.equal(permissionAction(permission, "o4e_task", "agent:watch"), "allow")
  assert.equal(permissionAction(permission, "task", "unloaded"), "deny")
  assert.equal(permission.o4e_workflow, "deny")
  for (const change of [
    { loadTools: ["read"] },
    { loadAgents: [] },
    { permission: { task: "deny" } },
    { permission: { task: "allow", "*": "deny" } },
  ]) assert.equal(effectiveAgentPermission({ ...worker, ...change }, { agents }).task, "deny")
  const restricted = effectiveAgentPermission({ ...worker, permission: {
    task: { "*": "deny", peer: "ask" }, o4e_task: { "*": "allow", "agent:cancel": "deny" }, "o4e_workflow": "allow",
  } }, { agents })
  assert.equal(permissionAction(restricted, "task", "peer"), "ask")
  assert.equal(permissionAction(restricted, "o4e_task", "agent:cancel"), "deny")
  assert.equal(permissionAction(applyPermissionOverlay(restricted, { task: "deny" }), "task", "peer"), "deny")
  assert.equal(permissionAction(effectiveAgentPermission({ ...worker, loadAgents: [] }, { agents }), "o4e_task", "agent:watch"), "deny")
  assert.equal(effectiveAgentPermission({ ...worker, permission: "allow" }, { agents }).o4e_workflow, "deny")
})

test("Bash command 管理初始投影只授予声明 Bash 或工具开放的受管角色", () => {
  for (const type of ["primary", "all", "subagent"]) {
    for (const loadTools of [["read", "bash"], null, undefined]) {
      const agent = { name: type, type, loadTools, loadAgents: [], loadWorkflows: [] }
      const permission = applyManagedDelegationPermission({}, agent)
      assert.deepEqual(permission.o4e_task, { "*": "deny", "command:*": "allow" })
      assert.equal(permission.task, "deny")
      assert.equal(permission.o4e_workflow, "deny")
      assert.deepEqual(effectiveAgentPermission(agent).o4e_task, permission.o4e_task)
    }
    for (const loadTools of [[], ["read"], ["execute", "task"]]) {
      assert.equal(effectiveAgentPermission({ type, loadTools }).o4e_task, "deny")
    }
  }
  for (const type of ["system", undefined]) {
    assert.equal(applyManagedDelegationPermission({}, { type, loadTools: ["bash"] }).o4e_task, "deny")
    assert.equal(effectiveAgentPermission({ type, loadTools: ["bash"], permission: "allow" }).o4e_task, "deny")
  }
})

test("command-only Runtime 投影保留显式标量、资源 ask/deny 和后置 wildcard 决策", () => {
  const resources = ["command:status", "command:watch", "command:inspect", "command:output", "command:cancel", "command:pending"]
  const permissions = [
    "deny", "ask", "allow",
    { o4e_task: "deny" },
    { o4e_task: "ask" },
    { o4e_task: { "*": "deny", "command:*": "ask", "command:cancel": "deny" } },
    { o4e_task: { "command:*": "allow", "*": "deny" } },
    { o4e_task: { "*": "allow", "command:cancel": "deny" }, "*": "deny" },
    { o4e_task: "allow", "o4e_*": "ask" },
    { "*": "deny", o4e_task: { "command:watch": "allow", "command:output": "ask" } },
    { o4e_task: { "*": "ask", "*cancel": "deny", "*watch": "allow", "com?and:out*": "deny" } },
    { o4e_task: "allow", "*": { "command:*": "ask", "*cancel": "deny" } },
    { o4e_task: { "*": "deny", "*command:*": "ask", "command:command:*": "deny" } },
  ]
  for (const type of ["primary", "all", "subagent"]) {
    const agent = { name: type, type, loadTools: ["bash"], loadAgents: [], loadWorkflows: [] }
    for (const explicit of permissions) {
      const projected = applyRuntimeSafetyPermission(explicit, agent)
      const effective = effectiveAgentPermission({ ...agent, permission: explicit })
      for (const resource of resources) {
        const expected = permissionAction(explicit, "o4e_task", resource)
        assert.equal(permissionAction(projected, "o4e_task", resource), expected, JSON.stringify({ type, explicit, resource }))
        assert.equal(permissionAction(effective, "o4e_task", resource), expected)
      }
      for (const permission of [projected, effective]) {
        for (const resource of ["*", "worker", "agent:watch", "o4e_task_123", "xcommand:watch"]) {
          assert.equal(permissionAction(permission, "o4e_task", resource), "deny")
          assert.equal(permissionAction(permission, "task", resource), "deny")
        }
        assert.deepEqual(applyRuntimeSafetyPermission(permission, agent), permission)
      }
    }
    for (const permission of ["deny", { o4e_task: "deny" }, { o4e_task: "allow", "*": "deny" }]) {
      assert.equal(effectiveAgentPermission({ ...agent, permission }).o4e_task, "deny")
    }
  }
})

test("command wildcard 收紧只投影 canonical 动作，无获准动作时保持 deny", () => {
  const explicit = { o4e_task: { "*": "deny", "command:*": "ask", "*put": "allow", "*ing": "deny", "command:c?nc?l": "deny" } }
  for (const type of ["primary", "all", "subagent"]) {
    const agent = { type, loadTools: ["bash"], loadAgents: [] }
    const permission = effectiveAgentPermission({ ...agent, permission: explicit })
    assert.deepEqual(permission.o4e_task, {
      "*": "deny", "command:status": "ask", "command:watch": "ask", "command:inspect": "ask", "command:output": "allow",
    })
    for (const resource of ["", "command:", "command:future", "command:input", "command:command:watch", "agent:watch"]) {
      assert.equal(permissionAction(permission, "o4e_task", resource), "deny")
    }
    for (const denied of [
      "deny",
      { o4e_task: { "*": "deny", "command:": "allow" } },
      { o4e_task: { "*": "deny", "command:future": "ask" } },
      { o4e_task: "allow", "o4e_*": { "command:*": "deny" } },
    ]) {
      assert.equal(effectiveAgentPermission({ ...agent, permission: denied }).o4e_task, "deny")
    }
    const allAllowed = Object.fromEntries(["status", "watch", "inspect", "output", "cancel", "pending"].map((action) => [`command:${action}`, "allow"]))
    assert.deepEqual(effectiveAgentPermission({ ...agent, permission: { o4e_task: { "*": "deny", ...allAllowed } } }).o4e_task,
      { "*": "deny", "command:*": "allow" })
  }
})

test("command-only 权限与宿主投影一致，Overlay 不能开放 Agent Task 资源", () => {
  const agents = ["primary", "all", "subagent"].flatMap((type) => [
    { name: `${type}-bash`, type, loadTools: ["bash", "read"] },
    { name: `${type}-open`, type, loadTools: null, permission: { o4e_task: "ask" } },
    { name: `${type}-deny`, type, loadTools: ["bash"], permission: "deny" },
    { name: `${type}-global-deny`, type, loadTools: ["bash"], permission: { o4e_task: "allow", "*": "deny" } },
    { name: `${type}-resources`, type, loadTools: ["bash"], permission: { o4e_task: { "*": "ask", "*cancel": "deny" } } },
  ])
  const config = { agent: {} }
  applyAgentPolicies(config, agents)
  for (const agent of agents) {
    const permission = effectiveAgentPermission(agent, { agents })
    assert.deepEqual(config.agent[agent.name].permission, permission)
    assert.deepEqual(permissionRules(config.agent[agent.name].permission), permissionRules(permission))
    assert.throws(() => normalizePermissionOverlay({ o4e_task: "ask" }, permission), /不能把 deny 扩大为 ask/)
    const denied = applyPermissionOverlay(permission, { o4e_task: "deny" })
    assert.equal(permissionAction(applyRuntimeSafetyPermission(denied, agent), "o4e_task", "command:watch"), "deny")
  }
})

test("primary/all/subagent 可发起 Task，Workflow 仅 primary/all 且 system 拒绝协调入口", () => {
  const worker = { name: "worker", type: "subagent" }
  const requester = {
    loadTools: ["read", "task"],
    loadAgents: ["worker"],
    loadWorkflows: ["flow"],
    permission: {
      task: "allow",
      o4e_task: "allow",
      o4e_workflow: "allow",
    },
  }
  for (const type of ["primary", "all", "subagent"]) {
    const agent = { ...requester, name: type, type }
    const permission = effectiveAgentPermission(agent, { agents: [agent, worker] })
    assert.deepEqual(permission.task, { "*": "deny", worker: "allow" })
    assert.equal(permission.o4e_task, "allow")
    assert.equal(permission.o4e_workflow, type === "subagent" ? "deny" : "allow")
  }
  const system = { ...requester, name: "title", type: "system" }
  const permission = effectiveAgentPermission(system, { agents: [system, worker] })
  for (const name of ["task", "o4e_task", "o4e_workflow"]) {
    assert.equal(permission[name], "deny")
  }
})

test("受管 task 目标权限遵循 wildcard 和最后匹配规则", () => {
  const requester = {
    name: "requester",
    type: "all",
    loadAgents: ["reviewer", "review-helper", "worker"],
    permission: { task: { "*": "allow", "review*": "deny", reviewer: "ask" } },
  }
  const agents = [
    requester,
    { name: "reviewer", type: "subagent" },
    { name: "review-helper", type: "subagent" },
    { name: "worker", type: "subagent" },
  ]

  assert.deepEqual(effectiveAgentPermission(requester, { agents }).task, {
    "*": "deny",
    reviewer: "ask",
    worker: "allow",
  })
})

test("Agent 和 Plan 显式 task 规则保留相对 wildcard 的声明顺序", () => {
  const worker = { name: "worker", type: "subagent" }
  const requester = {
    name: "requester",
    type: "all",
    loadAgents: ["worker"],
    permission: { "*": "allow", task: "deny" },
  }
  const agents = [requester, worker]

  assert.equal(effectiveAgentPermission(requester, { agents }).task, "deny")
  assert.deepEqual(effectiveAgentPermission({ ...requester, permission: { task: "deny", "*": "allow" } }, { agents }).task, {
    "*": "deny",
    worker: "allow",
  })

  const plan = {
    ...requester,
    name: "requester-plan",
    planProfile: true,
    planOverrides: { loadAgents: true },
    planPermission: { "*": "allow", task: "deny" },
  }
  const planAgents = [plan, worker]
  assert.equal(effectiveAgentPermission(plan, { agents: planAgents }).task, "deny")
  assert.deepEqual(effectiveAgentPermission({ ...plan, planPermission: { task: "deny", "*": "allow" } }, { agents: planAgents }).task, {
    "*": "deny",
    worker: "allow",
  })
  assert.deepEqual(effectiveAgentPermission({ ...plan, planPermission: { task: "allow" } }, { agents: planAgents }).task, {
    "*": "deny",
    worker: "allow",
  })
  const defaultPlan = { ...plan, planOverrides: {}, planPermission: { task: "allow" } }
  assert.deepEqual(effectiveAgentPermission(defaultPlan, { agents: [defaultPlan, worker] }).task, {
    "*": "deny",
    worker: "allow",
  })
})

test("Plan 默认策略保留 Agent 标量权限的收紧语义", () => {
  const permission = effectiveAgentPermission({ type: "all", planProfile: true, permission: "deny" })

  assert.equal(permission["*"], "deny")
  assert.equal(permission.read, "deny")
  assert.equal(permission.skill, "deny")
  assert.equal(permission.task, "deny")
})

test("Plan 只读 allow 排在 wildcard deny 之后，符合 OpenCode 最后匹配规则", () => {
  const permission = effectiveAgentPermission({
    type: "all",
    planProfile: true,
    loadTools: ["read", "glob", "grep"],
    loadSkills: ["*"],
    loadAgents: [],
    loadWorkflows: [],
  })
  const names = Object.keys(permission)
  assert.equal(names[0], "*")
  assert.ok(names.indexOf("read") > names.indexOf("*"))
  assert.ok(names.indexOf("glob") > names.indexOf("*"))
  assert.ok(names.indexOf("grep") > names.indexOf("*"))
  assert.equal(permissionRules(permission).find((rule) => rule.permission === "read")?.action, "allow")
  assert.equal(permissionRules(permission).at(-1)?.action, "deny")
})

test("Plan Skill allowlist 继承源 Agent，并允许显式完整覆盖", () => {
  const inherited = effectiveAgentPermission({
    type: "all",
    planProfile: true,
    loadSkills: ["docs", "review"],
    loadAgents: [],
    loadWorkflows: [],
    planOverrides: {},
  })
  assert.deepEqual(inherited.skill, { "*": "deny", docs: "allow", review: "allow" })

  const overridden = effectiveAgentPermission({
    type: "all",
    planProfile: true,
    loadSkills: ["plan-only"],
    loadAgents: [],
    loadWorkflows: [],
    planOverrides: { loadSkills: true },
  })
  assert.deepEqual(overridden.skill, { "*": "deny", "plan-only": "allow" })

  const reopened = effectiveAgentPermission({
    type: "all",
    planProfile: true,
    loadSkills: ["*"],
    loadAgents: [],
    loadWorkflows: [],
    planOverrides: { loadSkills: true },
  })
  assert.equal(reopened.skill, "allow")
})

test("permissionOverlay 基于最终 task、Workflow 和 MCP 权限拒绝扩权", () => {
  const target = {
    name: "target",
    type: "all",
    loadTools: ["task", "read"],
    loadSkills: ["*"],
    loadAgents: [],
    loadWorkflows: [],
    loadMcp: {},
  }
  const peer = { ...target, name: "peer", loadMcp: { context7: ["query-docs"] } }
  const mcpServerNames = collectMcpServerNames([target, peer])
  const permission = effectiveAgentPermission(target, { mcpServerNames })

  assert.equal(permission.task, "deny")
  assert.equal(permission.o4e_workflow, "deny")
  assert.equal(permission["context7_*"], "deny")
  assert.throws(() => normalizePermissionOverlay({ task: "ask" }, permission), /不能把 deny 扩大为 ask/)
  assert.throws(() => normalizePermissionOverlay({ o4e_workflow: "ask" }, permission), /不能把 deny 扩大为 ask/)
  assert.throws(() => normalizePermissionOverlay({ "context7_*": "ask" }, permission), /不能把 deny 扩大为 ask/)
})

test("Runtime 最终权限计算与 OpenCode 配置投影保持一致", () => {
  const target = {
    name: "target-plan",
    type: "all",
    planProfile: true,
    loadTools: ["read", "task"],
    loadSkills: ["*"],
    loadAgents: [],
    loadWorkflows: ["flow"],
    loadMcp: { context7: ["query-docs"] },
    permission: { read: "ask", task: "allow" },
    planOverrides: { loadTools: true, loadMcp: true, loadWorkflows: true },
    planPermission: { o4e_workflow: "ask" },
  }
  const peer = { ...target, name: "peer", planProfile: false, loadMcp: { docs: ["search"] } }
  const agents = [target, peer]
  const config = { agent: {} }

  applyAgentPolicies(config, agents)

  const mcpServerNames = collectMcpServerNames(agents)
  assert.deepEqual(config.agent[target.name].permission, effectiveAgentPermission(target, { agents, mcpServerNames }))
  assert.equal(config.agent[target.name].permission.task, "deny")
  assert.equal(config.agent[target.name].permission.o4e_workflow, "ask")
  assert.equal(config.agent[target.name].mode, "all")
})

test("统一投影保留宿主规则、显式覆盖和 system 权限边界", () => {
  const hostPermission = {
    read: { "*": "allow", "secret/**": "deny" },
    skill: { "*": "deny", docs: "allow" },
    external_directory: { "*": "deny", "/reference/**": "ask" },
    custom_tool: "deny",
  }
  const original = structuredClone(hostPermission)
  const agents = [
    { name: "parent", type: "primary", loadSkills: ["*"], loadAgents: ["worker"], permission: { glob: "ask" } },
    { name: "worker", type: "subagent", loadTools: ["read"] },
    { name: "title", type: "system", loadTools: ["read"], permission: { read: "deny", custom_tool: "allow" } },
  ]
  const untouched = { permission: "deny", model: "host/model" }
  const config = { agent: { parent: { permission: hostPermission }, title: { permission: hostPermission }, untouched } }

  applyAgentPolicies(config, agents)

  const permission = config.agent.parent.permission
  assert.equal(permissionAction(permission, "read", "secret/token.txt"), "deny")
  assert.equal(permissionAction(permission, "read", "src/main.mjs"), "allow")
  assert.equal(permissionAction(permission, "skill", "docs"), "allow")
  assert.equal(permissionAction(permission, "skill", "other"), "deny")
  assert.equal(permissionAction(permission, "external_directory", "/reference/file"), "ask")
  assert.equal(permissionAction(permission, "external_directory", "/private/file"), "deny")
  assert.equal(permissionAction(permission, "glob"), "ask")
  assert.equal(permissionAction(permission, "custom_tool"), "deny")
  assert.equal(permissionAction(permission, "task", "worker"), "allow")
  assert.equal(permissionAction(permission, "task", "other"), "deny")
  assert.equal(permissionAction(config.agent.title.permission, "read"), "allow")
  assert.equal(permissionAction(config.agent.title.permission, "custom_tool"), "deny")
  for (const name of ["task", "o4e_task", "o4e_workflow"]) assert.equal(config.agent.title.permission[name], "deny")
  assert.equal(config.agent.untouched, untouched)
  assert.deepEqual(hostPermission, original)
})

test("统一投影保留 Plan mode、宿主目录门禁和显式全局拒绝", () => {
  for (const type of ["primary", "all"]) {
    const agent = { name: "reader", type, planProfile: true, loadAgents: [] }
    const config = { agent: { reader: { mode: "subagent", model: "host/model", permission: {
      read: "ask", external_directory: { "*": "deny", "/reference/**": "allow" }, bash: "allow",
    } } } }
    applyAgentPolicies(config, [agent])
    assert.equal(config.agent.reader.mode, type)
    assert.equal(config.agent.reader.model, "host/model")
    assert.equal(permissionAction(config.agent.reader.permission, "read"), "ask")
    assert.equal(permissionAction(config.agent.reader.permission, "bash"), "deny")
    assert.equal(permissionAction(config.agent.reader.permission, "external_directory", "/reference/file"), "allow")
    assert.equal(permissionAction(config.agent.reader.permission, "external_directory", "/private/file"), "deny")

    for (const permission of ["deny", { read: "deny", "*": "deny" }]) {
      const denied = { agent: {} }
      applyAgentPolicies(denied, [{ ...agent, permission }])
      for (const tool of ["read", "bash", "task", "o4e_task", "o4e_workflow"]) {
        assert.equal(permissionAction(denied.agent.reader.permission, tool), "deny")
      }
    }
  }
})

test("pattern 权限按任意可写规则保守推导 Effect，Overlay 不得覆盖局部 deny", () => {
  const agent = {
    loadTools: ["read", "edit"],
    permission: {
      bash: "deny",
      external_directory: "deny",
      edit: { "*": "deny", "src/**": "allow" },
    },
  }
  const permission = effectiveAgentPermission(agent)

  assert.equal(deriveSelfEffects(agent, { permission }).kind, "unknown-write")
  assert.equal(deriveSelfEffects(agent, { permission, writeScopes: ["src"] }).kind, "scoped-write")
  assert.throws(() => normalizePermissionOverlay({ edit: "ask" }, permission), /不能把 deny 扩大为 ask/)
})

test("Effect 由最终权限和 writeScopes 推导", () => {
  assert.equal(deriveSelfEffects({ permission: { "*": "deny", bash: "deny", edit: "deny", external_directory: "deny" } }).kind, "read")
  assert.equal(deriveSelfEffects({ permission: { "*": "deny", bash: "deny", edit: "allow", external_directory: "deny" } }, { writeScopes: ["src"] }).kind, "scoped-write")
  assert.equal(deriveSelfEffects({ permission: { bash: "allow", edit: "deny", external_directory: "deny" } }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ permission: {
    bash: "deny",
    edit: "deny",
    external_directory: "deny",
    "filesystem_write-file": "allow",
  } }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ permission: {
    "*": "deny",
    read: "allow",
    "filesystem_*": "deny",
  } }).kind, "read")
  assert.equal(deriveSelfEffects({ permission: {
    "*": "deny",
    read: "allow",
    execute: "allow",
  } }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ permission: {
    "*": "deny",
    read: "allow",
    execute: "allow",
  } }, { permissionOverlay: { execute: "deny" } }).kind, "read")
})

test("目录门禁不代表写能力，真实写工具和 Overlay 仍决定 Effect", () => {
  for (const external_directory of [undefined, "allow", "ask", "deny", { "*": "ask", "~/reference/**": "allow" }]) {
    const agent = { type: "subagent", loadTools: ["read", "glob", "grep"], permission: { external_directory } }
    assert.equal(deriveSelfEffects(agent).kind, "read")
    assert.equal(deriveSelfEffects({ ...agent, loadTools: ["read", "edit"] }, { writeScopes: ["src"] }).kind, "scoped-write")
    for (const tool of ["bash", "execute"]) {
      assert.equal(deriveSelfEffects({ ...agent, loadTools: ["read", tool] }, { writeScopes: ["src"] }).kind, "unknown-write")
    }
    assert.equal(deriveSelfEffects({ ...agent, permission: { external_directory, custom_tool: "ask" } }).kind, "unknown-write")
  }
  const agent = { type: "subagent", loadTools: ["read", "edit"], permission: { external_directory: "allow" } }
  const result = deriveSelfEffects(agent, { writeScopes: ["src"], permissionOverlay: { edit: "deny", external_directory: "deny" } })
  assert.equal(result.kind, "read")
  assert.equal(result.permission.external_directory, "deny")
  assert.equal(toolMayHaveSideEffects("external_directory"), true)
})

test("未关闭的隐式工具保持 unknown-write，白名单关闭未知工具但显式权限可重开", () => {
  const permission = { bash: "deny", edit: "deny", external_directory: "allow" }
  assert.equal(deriveSelfEffects({ loadTools: null, permission }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ loadTools: null, permission: { ...permission, execute: "deny" } }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ loadTools: null, permission: { ...permission, edit: "allow" } }, { writeScopes: ["src"] }).kind, "unknown-write")
  const agent = { loadTools: ["read"], permission }
  assert.equal(deriveSelfEffects(agent).kind, "read")
  assert.equal(deriveSelfEffects({ ...agent, permission: { ...permission, "unmanaged_write": "allow" } }).kind, "unknown-write")
  assert.equal(deriveSelfEffects({ ...agent, permission: { ...permission, "*": "allow" } }).kind, "unknown-write")
  const wildcard = { ...agent, permission: { external_directory: "allow", "fs_*": "allow", "fs_?": "deny" } }
  assert.equal(deriveSelfEffects(wildcard).kind, "unknown-write")
  assert.equal(deriveSelfEffects(wildcard, { permissionOverlay: { "*": "deny" } }).kind, "read")
  assert.equal(deriveSelfEffects({ loadTools: null, permission: { ...permission, execute: "deny", "?": "deny" } }).kind, "unknown-write")
})

test("候选发现只展开 all/subagent 且尊重硬约束", () => {
  const requester = { loadAgents: ["*"] }
  const agents = [
    { name: "chat", type: "primary", permission: {}, capabilities: ["conversation.chat"], description: "chat" },
    { name: "reviewer", type: "all", planProfile: true, permission: { bash: "deny", edit: "deny", external_directory: "deny" }, capabilities: ["review.code"], description: "review" },
    { name: "tester", type: "all", permission: { bash: "allow" }, capabilities: ["test.verify"], description: "test" },
    { name: "helper", type: "subagent", loadTools: ["read"], permission: { bash: "deny", edit: "deny", external_directory: "deny" }, capabilities: ["task.general"], description: "help" },
  ]
  assert.deepEqual(legalAgentCandidates({ requester, agents, required: { effect: "read" } }).map((entry) => entry.id), ["helper", "reviewer"])
  assert.equal(selectPreferredAgent({ preferred: "missing", candidates: legalAgentCandidates({ requester, agents }) }).status, "selection-required")
  assert.equal(selectPreferredAgent({ preferred: "reviewer", candidates: legalAgentCandidates({ requester, agents }) }).agent.id, "reviewer")
  assert.deepEqual(legalAgentCandidates({ requester, agents, required: { plan: true } }).map((entry) => entry.id), ["reviewer"])
  assert.deepEqual(legalAgentCandidates({ requester, agents, required: { plan: false } }).map((entry) => entry.id), ["helper", "tester"])
})

test("候选发现以稳定 Skill 和机械 Effect 为硬边界，缺失首选 ID 时只发现同契约 Agent", () => {
  const requester = { loadAgents: ["*"] }
  const readPermission = { "*": "deny", read: "allow", bash: "deny", edit: "deny", external_directory: "deny" }
  const agents = [
    { name: "reviewer", type: "all", permission: readPermission, capabilities: ["review.code"], description: "review changes" },
    { name: "replacement-tester", type: "all", permission: readPermission, capabilities: ["test.verify"], description: "verify changes" },
    { name: "writer", type: "subagent", permission: { bash: "allow" }, capabilities: ["test.verify"], description: "write tests" },
    { name: "generic", type: "subagent", permission: readPermission, capabilities: ["task.general"], description: "general work" },
  ]

  const candidates = legalAgentCandidates({ requester, agents, required: { skill: "test.verify", effect: "read" } })
  assert.deepEqual(candidates.map((entry) => entry.id), ["replacement-tester"])
  const selected = selectPreferredAgent({ preferred: "tester", fallback: "discover", candidates })
  assert.equal(selected.status, "selected")
  assert.equal(selected.agent.id, "replacement-tester")
})

test("候选发现按最终权限过滤，并跳过无法应用收紧覆盖的 Agent", () => {
  const requester = { loadAgents: ["*"] }
  const agents = [
    { name: "denied", type: "all", loadTools: ["read"], permission: { bash: "deny" }, description: "denied" },
    { name: "allowed", type: "all", loadTools: ["bash", "read"], description: "allowed" },
  ]
  const candidates = legalAgentCandidates({
    requester,
    agents,
    required: { tools: ["bash"], permissionOverlay: { bash: "ask" } },
  })
  assert.deepEqual(candidates.map((entry) => entry.id), ["allowed"])
})

test("command 管理不改变 Effect、合法目标类型或 loadAgents 硬边界", () => {
  const requester = { type: "primary", loadAgents: ["worker", "reader", "writer", "primary", "system"] }
  const agents = [
    { name: "worker", type: "subagent", loadTools: ["read", "bash"] },
    { name: "reader", type: "all", loadTools: ["read"] },
    { name: "writer", type: "subagent", loadTools: ["read", "edit"] },
    { name: "unloaded", type: "subagent", loadTools: ["bash"] },
    { name: "primary", type: "primary", loadTools: ["bash"] },
    { name: "system", type: "system", loadTools: ["bash"] },
  ].map((agent) => ({ ...agent, permission: { o4e_task: { "*": "deny", "command:*": "allow" } } }))
  const denied = agents.map((agent) => ({ ...agent, permission: { o4e_task: "deny" } }))
  for (const required of [{}, { effect: "read" }, { effect: "unknown-write" }, { effect: "scoped-write", writeScopes: ["src"] }, { tools: ["bash"] }]) {
    assert.deepEqual(legalAgentCandidates({ requester, agents, required }), legalAgentCandidates({ requester, agents: denied, required }))
  }
  assert.deepEqual(legalAgentCandidates({ requester, agents }).map((agent) => agent.id), ["reader", "worker", "writer"])
  assert.equal(deriveSelfEffects(agents[0]).kind, "unknown-write")
  assert.equal(deriveSelfEffects(agents[1]).kind, "read")
  assert.equal(deriveSelfEffects(agents[2], { writeScopes: ["src"] }).kind, "scoped-write")
  assert.equal(effectiveAgentPermission(agents[0], { agents }).task, "deny")
})

test("权限配置可编译为 OpenCode Session ruleset", () => {
  assert.deepEqual(permissionRules({ bash: "deny", read: { "*": "allow", "/secret/*": "ask" } }), [
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "/secret/*", action: "ask" },
  ])
})

test("工具副作用分类只豁免明确只读或 Task 控制工具", () => {
  assert.equal(toolMayHaveSideEffects("read"), false)
  assert.equal(toolMayHaveSideEffects("grep"), false)
  assert.equal(toolMayHaveSideEffects("list"), true)
  assert.equal(toolMayHaveSideEffects("websearch"), false)
  assert.equal(toolMayHaveSideEffects("lsp"), false)
  assert.equal(toolMayHaveSideEffects("o4e_task"), false)
  assert.equal(toolMayHaveSideEffects("edit"), true)
  assert.equal(toolMayHaveSideEffects("bash"), true)
  assert.equal(toolMayHaveSideEffects("o4e_workflow"), true)
  assert.equal(toolMayHaveSideEffects("custom_tool"), true)
})

test("黑名单优先于工具、Skill、MCP 和委派白名单", () => {
  const agent = {
    type: "all", name: "orchestrator", loadTools: ["read", "bash", "skill", "task"],
    loadSkills: ["docs"], loadMcp: { context7: ["query-docs"] },
    loadAgents: ["worker"], blockTools: ["bash"], blockSkills: ["docs"],
    blockMcp: ["context7"], blockAgents: ["worker"], blockWorkflows: ["build"],
    loadWorkflows: ["build"],
  }
  const permission = effectiveAgentPermission(agent, {
    agents: [agent, { type: "subagent", name: "worker", loadTools: [], loadSkills: [], loadMcp: {} }],
    mcpServerNames: new Set(["context7"]),
  })
  assert.equal(permission.bash, "deny")
  assert.equal(permission.skill.docs, "deny")
  assert.equal(permission["context7_*"] , "deny")
  assert.equal(permissionAction(permission, "context7_query-docs"), "deny")
  assert.equal(permission.task.worker, "deny")
  assert.equal(permission.o4e_workflow.build, "deny")
})
