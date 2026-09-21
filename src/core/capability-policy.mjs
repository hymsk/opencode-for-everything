import { compilePermissionRules, wildcardMatch } from "./permission-rules.mjs"

export const PLAN_PROFILE_SUFFIX = " (plan)"
export const PLAN_REMINDER_HEADER = "# Plan Mode - System Reminder"
export const BUILTIN_TOOL_NAMES = Object.freeze([
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "task",
  "execute",
  "webfetch",
  "websearch",
  "lsp",
  "todowrite",
  "skill",
])

export const INVALID_PERMISSION_NAME_CODE = "O4E_INVALID_PERMISSION_NAME"

export function assertCanonicalPermissionName(name, label = "permission") {
  if (typeof name !== "string" || name.trim() === "") {
    throw Object.assign(new Error(`${label} 包含空权限名称`), { code: INVALID_PERMISSION_NAME_CODE })
  }
  if (name.startsWith("functions.")) {
    const requested = name.slice("functions.".length)
    const permissionName = requested === "apply_patch" || requested === "write" ? "edit" : requested
    throw Object.assign(new Error(`${label} 使用 OpenCode permission 名称，不使用 functions.* 工具命名空间: ${name}；请改用 ${permissionName}`), {
      code: INVALID_PERMISSION_NAME_CODE,
    })
  }
  if (name === "apply_patch") {
    throw Object.assign(new Error(`${label} 使用 OpenCode permission 名称，不使用工具别名 apply_patch；请改用 edit`), {
      code: INVALID_PERMISSION_NAME_CODE,
    })
  }
  if (name === "write") {
    throw Object.assign(new Error(`${label} 使用 OpenCode canonical permission 名称；write 无效，请改用 edit`), {
      code: INVALID_PERMISSION_NAME_CODE,
    })
  }
  return name
}

export const PLAN_PERMISSION = Object.freeze({
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  webfetch: "allow",
  websearch: "allow",
  lsp: "allow",
  question: "allow",
  skill: "allow",
  task: "allow",
  o4e_task: "allow",
})

const PLAN_ALLOWED_PERMISSION_NAMES = Object.freeze(Object.keys(PLAN_PERMISSION).filter((name) => name !== "*"))
export function decidePlanPermission(currentPermission = {}, { intersect = false } = {}) {
  const current = currentPermission === "allow" || currentPermission === "ask" || currentPermission === "deny"
    ? { "*": currentPermission }
    : currentPermission && typeof currentPermission === "object" && !Array.isArray(currentPermission)
      ? currentPermission
      : {}
  // OpenCode evaluates the last matching permission rule. Keep the broad
  // Plan deny first so explicit read-only allows below remain effective.
  const permission = { "*": "deny" }
  for (const [name, value] of Object.entries(current)) {
    if (name !== "*") permission[name] = value
  }
  for (const name of PLAN_ALLOWED_PERMISSION_NAMES) {
    if (intersect) {
      if (current[name] === undefined && current["*"] === undefined) delete permission[name]
      else permission[name] = current[name] ?? current["*"]
      continue
    }
    permission[name] = current[name] ?? current["*"] ?? "allow"
  }
  for (const name of Object.keys(permission)) {
    if (name === "*" || PLAN_ALLOWED_PERMISSION_NAMES.includes(name)) continue
    permission[name] = "deny"
  }
  const directoryRules = compilePermissionRules(current).filter((rule) => wildcardMatch("external_directory", rule.permission))
  if (directoryRules.length > 0) {
    const rule = {}
    for (const { pattern, action } of directoryRules) {
      delete rule[pattern]
      rule[pattern] = action
    }
    delete permission.external_directory
    permission.external_directory = Object.keys(rule).length === 1 && rule["*"] ? rule["*"] : rule
  }
  return permission
}

export function planProfileName(name) {
  return `${name}${PLAN_PROFILE_SUFFIX}`
}

function mergeBlockMcp(base, extra) {
  // blockMcp is a flat server-name blacklist (the same shape as blockAgents).
  return [...new Set([
    ...(Array.isArray(base) ? base : []),
    ...(Array.isArray(extra) ? extra : []),
  ])]
}

export function expandPlanProfiles(agents) {
  return agents.flatMap((agent) => {
    if (!agent?.plan) return [{ ...agent, planProfile: false }]
    const profile = {
      ...agent,
      name: planProfileName(agent.name),
      description: `${agent.description} (plan)`,
      planProfile: true,
      planSourceName: agent.name,
      loadSkills: agent.plan.loadSkills === undefined ? [...(agent.loadSkills ?? ["*"])] : [...agent.plan.loadSkills],
      loadTools: agent.plan.loadTools === undefined ? agent.loadTools : agent.plan.loadTools,
      loadMcp: agent.plan.loadMcp === undefined ? {} : agent.plan.loadMcp,
      loadAgents: agent.plan.loadAgents === undefined ? agent.loadAgents : agent.plan.loadAgents,
      loadWorkflows: agent.plan.loadWorkflows === undefined ? agent.loadWorkflows : agent.plan.loadWorkflows,
      blockTools: [...new Set([...(agent.blockTools ?? []), ...(agent.plan.blockTools ?? [])])],
      blockSkills: [...new Set([...(agent.blockSkills ?? []), ...(agent.plan.blockSkills ?? [])])],
      blockMcp: mergeBlockMcp(agent.blockMcp, agent.plan.blockMcp),
      blockAgents: [...new Set([...(agent.blockAgents ?? []), ...(agent.plan.blockAgents ?? [])])],
      blockWorkflows: [...new Set([...(agent.blockWorkflows ?? []), ...(agent.plan.blockWorkflows ?? [])])],
      planPermission: agent.plan.permission,
      planReminder: agent.plan.reminder,
      planOverrides: {
        loadSkills: agent.plan.loadSkills !== undefined,
        loadTools: agent.plan.loadTools !== undefined,
        loadMcp: agent.plan.loadMcp !== undefined,
        loadAgents: agent.plan.loadAgents !== undefined,
        loadWorkflows: agent.plan.loadWorkflows !== undefined,
      },
    }
    if (agent.plan.mode === "self") return [profile]

    return [
      {
        ...agent,
        planProfile: false,
      },
      {
        ...profile,
        nativeMode: undefined,
      },
    ]
  })
}
