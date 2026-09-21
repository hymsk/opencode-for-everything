import assert from "node:assert/strict"
import { homedir } from "node:os"
import test from "node:test"
import { effectiveAgentPermission } from "../src/core/agent-routing.mjs"
import {
  compilePermissionRules,
  evaluate,
  evaluateResources,
  wildcardMatch,
} from "../src/core/permission-rules.mjs"

test("标量和对象权限按声明顺序编译，最后匹配规则生效", () => {
  assert.deepEqual(compilePermissionRules("deny"), [
    { permission: "*", pattern: "*", action: "deny" },
  ])

  const rules = compilePermissionRules({
    "*": "ask",
    bash: {
      "*": "deny",
      "git *": "allow",
      "git push *": "deny",
    },
  })
  assert.deepEqual(rules, [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "git push *", action: "deny" },
  ])
  assert.equal(evaluate("bash", "git status", rules).action, "allow")
  assert.equal(evaluate("bash", "git push origin main", rules).action, "deny")

  rules.push({ permission: "*", pattern: "*", action: "allow" })
  assert.equal(evaluate("bash", "git push origin main", rules).action, "allow")
})

test("wildcard 匹配复刻 OpenCode 的完整字符串和路径语义", () => {
  assert.equal(wildcardMatch("src\\core\\file.mjs", "src/core/*.mjs"), true)
  assert.equal(wildcardMatch("file[1].mjs", "file[1].mjs"), true)
  assert.equal(wildcardMatch("file1.mjs", "file[1].mjs"), false)
  assert.equal(wildcardMatch("ab", "a?"), true)
  assert.equal(wildcardMatch("abc", "a?"), false)
  assert.equal(wildcardMatch("line1\nline2", "line*"), true)
  assert.equal(wildcardMatch("prefix-git status-suffix", "git status"), false)
  assert.equal(wildcardMatch("git status", "git status *"), true)
  assert.equal(wildcardMatch("git status --short", "git status *"), true)
  assert.equal(wildcardMatch("git statusx", "git status *"), false)
})

test("多个命令资源按 deny、ask、allow 优先级聚合且不解析 shell", () => {
  const rules = compilePermissionRules({
    bash: {
      "*": "allow",
      "git push *": "ask",
      "rm *": "deny",
    },
  })

  assert.equal(evaluateResources("bash", ["git status", "git push origin main"], rules), "ask")
  assert.equal(evaluateResources("bash", ["git push origin main", "rm -rf build"], rules), "deny")
  assert.equal(evaluateResources("bash", ["git status", "npm test"], rules), "allow")
  assert.equal(evaluateResources("bash", ["git status && rm -rf build"], rules), "allow")
})

test("未匹配规则默认 ask", () => {
  assert.deepEqual(evaluate("read", "README.md", []), {
    permission: "read",
    pattern: "*",
    action: "ask",
  })
  assert.equal(evaluateResources("bash", ["npm test"], []), "ask")
  assert.equal(evaluateResources("bash", [], []), "allow")
})

test("home 前缀编译与宿主一致，保留声明顺序和目录边界", () => {
  const home = homedir()
  for (const prefix of ["~", "$HOME"]) {
    for (const fallback of ["ask", "deny"]) {
      const rules = compilePermissionRules({
        external_directory: { "*": fallback, [`${prefix}/projects/**`]: "allow", [`${prefix}/projects/private/**`]: "deny" },
      })
      assert.equal(rules[1].pattern, `${home}/projects/**`)
      assert.equal(evaluate("external_directory", `${home}/projects/app/*`, rules).action, "allow")
      assert.equal(evaluate("external_directory", `${home}/projects/private/*`, rules).action, "deny")
      assert.equal(evaluate("external_directory", `${home}/projects-other/*`, rules).action, fallback)
      assert.equal(evaluate("external_directory", `${home}/projects/*`, rules, compilePermissionRules({ external_directory: fallback })).action, fallback)
    }
  }
  const patterns = ["~", "$HOME", "$HOME-other/*", "~other/*", "${HOME}/*", "relative/*", "/absolute/*", "git *"]
  const rules = compilePermissionRules({ read: Object.fromEntries(patterns.map((pattern) => [pattern, "allow"])) })
  assert.deepEqual(rules.map((rule) => rule.pattern), [home, home, `${home}-other/*`, ...patterns.slice(3)])
  assert.equal(evaluate("read", `${home}/child`, compilePermissionRules({ read: { "~": "allow" } })).action, "ask")
})

test("受管 task pattern 保持在最终位置", () => {
  const permission = effectiveAgentPermission({
    name: "requester",
    type: "all",
    loadTools: ["task"],
    loadAgents: ["worker"],
    permission: { task: "allow", "*": "allow" },
  }, { agents: [{ name: "requester", type: "all" }, { name: "worker", type: "subagent" }] })
  const effectiveRules = compilePermissionRules(permission)
  assert.deepEqual(effectiveRules.slice(-2), [
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "task", pattern: "worker", action: "allow" },
  ])
  assert.equal(evaluate("task", "worker", effectiveRules).action, "allow")
  assert.equal(evaluate("task", "other", effectiveRules).action, "deny")
})
