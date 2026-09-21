import assert from "node:assert/strict"
import test from "node:test"
import { applyAgentPolicies } from "../src/adapters/opencode/context-projection.mjs"
import { applyPlanOverridePermission, applyRuntimeSafetyPermission, effectiveAgentPermission, permissionAction } from "../src/core/agent-routing.mjs"
import { decidePlanPermission, expandPlanProfiles, PLAN_PERMISSION, planProfileName } from "../src/core/capability-policy.mjs"
import { compilePermissionRules, evaluate } from "../src/core/permission-rules.mjs"

test("child Plan Profile 使用括号名称且不生成排序字段", () => {
  const [source, plan] = expandPlanProfiles([{
    type: "all",
    name: "orchestrator",
    description: "orchestrator",
    plan: { mode: "child" },
  }])

  assert.equal(planProfileName("orchestrator"), "orchestrator (plan)")
  assert.equal(source.name, "orchestrator")
  assert.equal("order" in source, false)
  assert.equal(plan.name, "orchestrator (plan)")
  assert.equal("order" in plan, false)
  assert.equal(plan.planSourceName, "orchestrator")
})

test("self Plan Profile 也统一使用括号名称且不保留无后缀入口", () => {
  const [plan] = expandPlanProfiles([{
    type: "primary",
    name: "chat",
    description: "chat",
    plan: { mode: "self" },
  }])

  assert.equal(plan.name, "chat (plan)")
  assert.equal(plan.description, "chat (plan)")
  assert.equal(plan.planProfile, true)
  assert.equal(plan.planSourceName, "chat")
})

test("原生 plan 的 self Profile 使用 plan (plan) 并保留 nativeMode 映射", () => {
  const [plan] = expandPlanProfiles([{
    type: "primary",
    name: "plan",
    description: "native plan",
    nativeMode: "plan",
    plan: { mode: "self" },
  }])

  assert.equal(plan.name, "plan (plan)")
  assert.equal(plan.nativeMode, "plan")
  assert.equal(plan.planProfile, true)
  assert.equal(plan.planSourceName, "plan")
})

test("规划 agent 通过权限层保持只读", () => {
  const config = { agent: { "origin-plan": { model: "provider/plan", mode: "all" } } }

  config.agent["origin-plan"].permission = decidePlanPermission(config.agent["origin-plan"].permission)

  assert.deepEqual(config.agent["origin-plan"], {
    model: "provider/plan",
    mode: "all",
    permission: PLAN_PERMISSION,
  })
  assert.equal(PLAN_PERMISSION.bash, undefined)
  assert.equal(PLAN_PERMISSION.edit, undefined)
  assert.equal(PLAN_PERMISSION.task, "allow")
  assert.equal(PLAN_PERMISSION.o4e_task, "allow")
  assert.equal(PLAN_PERMISSION.list, undefined)
  assert.equal(PLAN_PERMISSION.websearch, "allow")
  assert.equal(PLAN_PERMISSION.lsp, "allow")
  assert.equal(PLAN_PERMISSION["*"], "deny")
})

test("规划权限与角色已有能力取交集", () => {
  const config = {
    agent: {
      "orchestrator (plan)": {
        permission: {
          read: "allow",
          webfetch: "deny",
          bash: "allow",
          edit: "allow",
          task: "allow",
          o4e_task: "allow",
          skill: "deny",
        },
      },
    },
  }

  config.agent["orchestrator (plan)"].permission = decidePlanPermission(config.agent["orchestrator (plan)"].permission, { intersect: true })

  assert.deepEqual(config.agent["orchestrator (plan)"].permission, {
    "*": "deny",
    read: "allow",
    webfetch: "deny",
    bash: "deny",
    edit: "deny",
    task: "allow",
    o4e_task: "allow",
    skill: "deny",
  })
})

test("未声明工具白名单时保留宿主显式拒绝并开放其余 Plan 能力", () => {
  const config = { agent: { "custom-plan": { permission: { read: "deny", webfetch: "deny" } } } }

  config.agent["custom-plan"].permission = decidePlanPermission(config.agent["custom-plan"].permission)

  assert.equal(config.agent["custom-plan"].permission.read, "deny")
  assert.equal(config.agent["custom-plan"].permission.webfetch, "deny")
  assert.equal(config.agent["custom-plan"].permission.glob, "allow")
  assert.equal(config.agent["custom-plan"].permission.bash, undefined)
  assert.equal(config.agent["custom-plan"].permission["*"], "deny")
})

test("未声明工具白名单时保留宿主通配拒绝", () => {
  const config = { agent: { "custom-plan": { permission: { "*": "deny", read: "allow" } } } }

  config.agent["custom-plan"].permission = decidePlanPermission(config.agent["custom-plan"].permission)

  assert.equal(config.agent["custom-plan"].permission.read, "allow")
  assert.equal(config.agent["custom-plan"].permission.glob, "deny")
  assert.equal(config.agent["custom-plan"].permission.webfetch, "deny")
  assert.equal(config.agent["custom-plan"].permission["*"], "deny")
})

test("Plan 投影保留标量 permission 的全局拒绝", () => {
  const config = { agent: { "custom-plan": { permission: "deny" } } }

  config.agent["custom-plan"].permission = decidePlanPermission(config.agent["custom-plan"].permission)

  assert.equal(config.agent["custom-plan"].permission["*"], "deny")
  assert.equal(config.agent["custom-plan"].permission.read, "deny")
  assert.equal(config.agent["custom-plan"].permission.skill, "deny")
})

test("Plan 保留目录门禁许可与显式 ask/deny，而不开放写工具", () => {
  for (const intersect of [false, true]) {
    for (const external_directory of ["allow", "ask", "deny", { "*": "deny", "~/reference/**": "allow" }]) {
      const config = { agent: { reader: { permission: { read: "allow", external_directory, bash: "allow", edit: "allow", execute: "allow" } } } }
      config.agent["reader"].permission = decidePlanPermission(config.agent["reader"].permission, { intersect })
      assert.deepEqual(compilePermissionRules({ external_directory: config.agent.reader.permission.external_directory }), compilePermissionRules({ external_directory }))
      for (const tool of ["bash", "edit", "execute"]) assert.equal(config.agent.reader.permission[tool], "deny")
    }
  }
})

test("Plan 不为未配置目录门禁的权限隐式授予许可", () => {
  for (const intersect of [false, true]) {
    for (const permission of [{}, { read: "allow" }]) {
      const config = { agent: { plan: { permission } } }
      config.agent["plan"].permission = decidePlanPermission(config.agent["plan"].permission, { intersect })
      assert.equal(evaluate("external_directory", "/reference/*", compilePermissionRules(config.agent.plan.permission)).action, "deny")
    }
  }
})

test("Plan 目录许可不重开被后置 wildcard 拒绝的规则", () => {
  for (const intersect of [false, true]) {
    for (const permission of [
      { external_directory: "allow", "*": "deny" },
      { external_directory: "allow", "external_*": "ask" },
      { external_directory: { "*": "allow", "/secret/*": "deny" }, "*": { "/private/*": "ask" } },
      { "*": "deny", external_directory: { "/reference/*": "allow" } },
    ]) {
      const config = { agent: { reader: { permission } } }
      config.agent["reader"].permission = decidePlanPermission(config.agent["reader"].permission, { intersect })
      for (const path of ["/reference/*", "/secret/*", "/private/*", "/other/*"]) {
        assert.equal(evaluate("external_directory", path, compilePermissionRules(config.agent.reader.permission)).action,
          evaluate("external_directory", path, compilePermissionRules(permission)).action)
      }
    }
  }
})

test("Plan command 管理保留显式 Bash reopen，不受清空 loadAgents 覆盖且不授予 Agent 资源", () => {
  for (const type of ["primary", "all"]) {
    for (const override of [{}, { loadAgents: [] }, { loadTools: ["bash", "read"], loadAgents: [] }]) {
      const [, agent] = expandPlanProfiles([{
        name: type, type, description: type,
        loadTools: ["bash", "read"], loadAgents: [],
        plan: { mode: "child", ...override },
      }])
      const config = { agent: {} }
      applyAgentPolicies(config, [agent])
      const permission = effectiveAgentPermission(agent, { agents: [agent] })
      assert.deepEqual(config.agent[agent.name].permission, permission)
      assert.equal(permissionAction(permission, "bash"), override.loadTools ? "allow" : "deny")
      assert.deepEqual(permission.o4e_task, { "*": "deny", "command:*": "allow" })
      assert.equal(permissionAction(permission, "o4e_task", "worker"), "deny")
      assert.equal(permission.task, "deny")
      assert.equal(permission.o4e_workflow, "deny")
    }
  }
})

test("Plan 显式 command deny 与后置全局 deny 不被 Bash 或 loadAgents override 重开", () => {
  for (const type of ["primary", "all", "subagent"]) {
    for (const planPermission of [
      "deny",
      { o4e_task: "deny" },
      { o4e_task: "allow", "*": "deny" },
      { o4e_task: { "command:*": "allow", "*": "deny" } },
      { o4e_task: { "*": "deny", "command:*": "ask", "command:cancel": "deny" } },
      { o4e_task: { "*": "deny", "command:*": "ask", "*ing": "deny", "*put": "allow" } },
    ]) {
      const agent = {
        name: type, type, planProfile: true, loadTools: ["bash"], loadAgents: [],
        planOverrides: { loadTools: true, loadAgents: true }, planPermission,
      }
      const permission = effectiveAgentPermission(agent)
      for (const resource of ["command:status", "command:watch", "command:inspect", "command:output", "command:cancel", "command:pending"]) {
        assert.equal(permissionAction(permission, "o4e_task", resource), permissionAction(planPermission, "o4e_task", resource))
      }
      assert.equal(permissionAction(permission, "o4e_task", "worker"), "deny")
      assert.equal(permission.task, "deny")
    }
    for (const permission of ["deny", { o4e_task: "deny" }, { o4e_task: "allow", "*": "deny" }, { o4e_task: "allow", "o4e_*": "deny" }]) {
      const agent = { type, planProfile: true, loadTools: ["bash"], loadAgents: [], planOverrides: { loadTools: true, loadAgents: true }, permission }
      assert.equal(effectiveAgentPermission(agent).o4e_task, "deny")
    }
  }
})

test("Plan 保留源 Agent 的后置 Task wildcard 决策且与宿主投影一致", () => {
  for (const type of ["primary", "all"]) {
    for (const loadTools of [["bash"], null]) {
      for (const permission of [
        { o4e_task: "allow", "*": "deny" },
        { o4e_task: "allow", "o4e_*": "ask" },
        { o4e_task: "allow", "*": { "command:cancel": "deny" } },
      ]) {
        const agent = { name: type, type, planProfile: true, loadTools, loadAgents: [], permission }
        const config = { agent: {} }
        applyAgentPolicies(config, [agent])
        const effective = effectiveAgentPermission(agent)
        assert.deepEqual(config.agent[agent.name].permission, effective)
        for (const resource of ["command:watch", "command:cancel"]) {
          assert.equal(permissionAction(effective, "o4e_task", resource), permissionAction(permission, "o4e_task", resource))
        }
      }
    }
  }
})

test("Plan override 与最终安全层保留已有标量和后置资源拒绝", () => {
  const agent = { type: "all", planProfile: true, loadTools: ["bash"], loadAgents: [], planOverrides: { loadTools: true, loadAgents: true } }
  for (const permission of ["deny", "ask", { o4e_task: "allow", "*": "deny" }, { o4e_task: "allow", "o4e_*": { "command:cancel": "deny" } }]) {
    const projected = applyRuntimeSafetyPermission(applyPlanOverridePermission(permission, agent), agent)
    for (const resource of ["command:watch", "command:cancel"]) {
      assert.equal(permissionAction(projected, "o4e_task", resource), permissionAction(permission, "o4e_task", resource))
    }
    assert.equal(projected.task, "deny")
  }
})
