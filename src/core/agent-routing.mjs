import { assertCanonicalPermissionName, BUILTIN_TOOL_NAMES, decidePlanPermission } from "./capability-policy.mjs"
import { compilePermissionRules, wildcardMatch } from "./permission-rules.mjs"

export const AGENT_TASK_TOOL = "task"
export const TASK_TOOL = "o4e_task"
export const WORKFLOW_TOOL = "o4e_workflow"
export const DEFAULT_MAX_DELEGATION_DEPTH = 2

const DELEGATABLE_TYPES = new Set(["all", "subagent"])
const DELEGATION_REQUESTER_TYPES = new Set(["primary", "all", "subagent"])
const WORKFLOW_REQUESTER_TYPES = new Set(["primary", "all"])
const ACTION_RANK = Object.freeze({ deny: 0, ask: 1, allow: 2 })
export const INTERNAL_TOOL_NAMES = Object.freeze(["invalid"])
const EFFECT_SAFE_PERMISSION_NAMES = new Set([
  "question",
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "lsp",
  "todowrite",
  "skill",
  "invalid",
  AGENT_TASK_TOOL,
  TASK_TOOL,
  WORKFLOW_TOOL,
])
const EFFECT_WRITE_PERMISSION_NAMES = new Set(["bash", "edit"])

export function normalizeMaxDelegationDepth(value, label = "maxDelegationDepth") {
  if (value === undefined) return DEFAULT_MAX_DELEGATION_DEPTH
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`${label} 必须是 1 到 5 的整数`)
  return value
}

export function toolMayHaveSideEffects(name) {
  return name === WORKFLOW_TOOL || typeof name !== "string" || !EFFECT_SAFE_PERMISSION_NAMES.has(name)
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function permissionObject(value) {
  return value === "allow" || value === "ask" || value === "deny" ? { "*": value } : objectValue(value)
}

function validActions(rule) {
  if (rule === "allow" || rule === "ask" || rule === "deny") return [rule]
  return Object.values(objectValue(rule)).filter((action) => action === "allow" || action === "ask" || action === "deny")
}

export function permissionActions(permission, name) {
  if (permission === "allow" || permission === "ask" || permission === "deny") return [permission]
  const actions = []
  let covered = false
  const rules = compilePermissionRules(permission)
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]
    if (!wildcardMatch(name, rule.permission)) continue
    actions.push(rule.action)
    if (rule.pattern === "*") {
      covered = true
      break
    }
  }
  if (!covered) actions.push("allow")
  return actions
}

function overlayBaseActions(permission, name) {
  if (name !== "*" || permission === "allow" || permission === "ask" || permission === "deny") return permissionActions(permission, name)
  const config = objectValue(permission)
  const actions = validActions(config["*"])
  if (actions.length === 0) actions.push("allow")
  for (const [permissionName, rule] of Object.entries(config)) {
    if (permissionName !== "*") actions.push(...validActions(rule))
  }
  return actions
}

export function permissionAction(permission, name, pattern = "*") {
  const match = compilePermissionRules(permission)
    .findLast((rule) => wildcardMatch(name, rule.permission) && wildcardMatch(pattern, rule.pattern))
  return match?.action ?? "allow"
}

export function mergeAgentPermission(base, explicit) {
  if (explicit === undefined) return base
  if (explicit === "allow" || explicit === "ask" || explicit === "deny") return explicit
  const projected = { ...objectValue(base) }
  const overrides = objectValue(explicit)
  for (const name of Object.keys(overrides)) delete projected[name]
  const merged = { ...projected, ...overrides }
  if (Object.hasOwn(merged, TASK_TOOL) && Object.keys(overrides).some((name) => name !== TASK_TOOL && wildcardMatch(TASK_TOOL, name))) {
    // Materialize ordered Task decisions before Plan moves or closes wildcard rules.
    const rule = {}
    for (const { permission: name, pattern, action } of compilePermissionRules(merged)) {
      if (!wildcardMatch(TASK_TOOL, name)) continue
      delete rule[pattern]
      rule[pattern] = action
    }
    delete merged[TASK_TOOL]
    merged[TASK_TOOL] = Object.keys(rule).length === 1 && rule["*"] ? rule["*"] : rule
  }
  return merged
}

export function applyManagedToolPermission(permission, agent) {
  if (Array.isArray(agent?.loadTools)) {
    const enabled = new Set(agent.loadTools)
    return {
      "*": "deny",
      external_directory: "ask",
      doom_loop: "ask",
      ...objectValue(permission),
      ...Object.fromEntries([...BUILTIN_TOOL_NAMES, ...INTERNAL_TOOL_NAMES].map((name) => [name, enabled.has(name) ? "allow" : "deny"])),
    }
  }
  return permission
}

export function applyManagedSkillPermission(permission, agent) {
  const loadSkills = agent?.loadSkills
  if (loadSkills === undefined) return permission
  if (!Array.isArray(loadSkills)) throw new TypeError("loadSkills 必须是 Skill 名称数组")
  if (loadSkills.includes("*")) return permission
  const skillPermission = { "*": "deny" }
  for (const name of loadSkills) skillPermission[name] = "allow"
  return { ...objectValue(permission), skill: skillPermission }
}

export function applyExplicitSkillPermission(permission, agent) {
  const loadSkills = agent?.loadSkills
  if (loadSkills === undefined) return permission
  if (!Array.isArray(loadSkills)) throw new TypeError("loadSkills 必须是 Skill 名称数组")
  if (loadSkills.includes("*")) return { ...objectValue(permission), skill: "allow" }
  return applyManagedSkillPermission(permission, { loadSkills })
}

function delegationTargetNames(agent, agents = []) {
  if (!Array.isArray(agent?.loadAgents) || agent.loadAgents.length === 0) return []
  return agents
    .filter((candidate) => candidate && DELEGATABLE_TYPES.has(candidate.type) && isLoaded(agent.loadAgents, candidate.name)
      && !(Array.isArray(agent.blockAgents) && (agent.blockAgents.includes("*") || agent.blockAgents.includes(candidate.name))))
    .map((candidate) => candidate.name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort((left, right) => left.localeCompare(right))
}

function hasWorkflowTargets(agent) {
  return WORKFLOW_REQUESTER_TYPES.has(agent?.type) && Array.isArray(agent.loadWorkflows) && agent.loadWorkflows.length > 0
}

function managedTaskPermission(agent, agents, currentPermission) {
  if (!DELEGATION_REQUESTER_TYPES.has(agent?.type)) return "deny"
  if (Array.isArray(agent?.loadTools) && !agent.loadTools.includes(AGENT_TASK_TOOL)) return "deny"
  const targets = delegationTargetNames(agent, agents)
  if (targets.length === 0) return "deny"
  const rule = { "*": "deny" }
  for (const target of targets) {
    const action = currentPermission === undefined ? "allow" : permissionAction(currentPermission, AGENT_TASK_TOOL, target)
    if (action !== "deny") rule[target] = action
  }
  return Object.keys(rule).length > 1 ? rule : "deny"
}

function commandTaskPermission(permission) {
  // Keep this action set aligned with CMD-005 and the command tool entry.
  const resources = ["status", "watch", "inspect", "output", "cancel", "pending"].map((action) => {
    const resource = `command:${action}`
    return [resource, permissionAction(permission, TASK_TOOL, resource)]
  })
  if (resources.every(([, action]) => action === "allow")) return { "*": "deny", "command:*": "allow" }
  const rule = { "*": "deny", ...Object.fromEntries(resources.filter(([, action]) => action !== "deny")) }
  return Object.keys(rule).length > 1 ? rule : "deny"
}

export function applyManagedDelegationPermission(permission, agent, agents = []) {
  const commandPermission = DELEGATION_REQUESTER_TYPES.has(agent?.type)
    && (!Array.isArray(agent.loadTools) || agent.loadTools.includes("bash"))
    ? { "*": "deny", "command:*": "allow" }
    : "deny"
  if (!DELEGATION_REQUESTER_TYPES.has(agent?.type)) {
    return {
      ...objectValue(permission),
      [AGENT_TASK_TOOL]: "deny",
      [TASK_TOOL]: commandPermission,
      [WORKFLOW_TOOL]: "deny",
    }
  }
  const canDelegate = delegationTargetNames(agent, agents).length > 0
  const canManageTasks = canDelegate || hasWorkflowTargets(agent)
  return {
    ...objectValue(permission),
    [AGENT_TASK_TOOL]: managedTaskPermission(agent, agents),
    [TASK_TOOL]: canManageTasks ? "allow" : commandPermission,
    [WORKFLOW_TOOL]: hasWorkflowTargets(agent) ? "allow" : "deny",
  }
}

export function mcpToolKey(server, tool) {
  const normalizedServer = server.replace(/[^a-zA-Z0-9_-]/g, "_")
  return tool === "*"
    ? `${normalizedServer}_*`
    : `${normalizedServer}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

export function collectMcpServerNames(agents = [], managedMcp, hostMcp) {
  const names = new Set()
  for (const source of [hostMcp, managedMcp]) {
    for (const name of Object.keys(objectValue(source))) if (name !== "*") names.add(name)
  }
  for (const agent of agents ?? []) {
    for (const server of Object.keys(objectValue(agent?.loadMcp))) if (server !== "*") names.add(server)
    for (const server of Array.isArray(agent?.blockMcp) ? agent.blockMcp : []) if (server !== "*") names.add(server)
  }
  return names
}

function mcpEntries(access, serverNames) {
  const result = []
  for (const [server, tools] of Object.entries(objectValue(access))) {
    const servers = server === "*" ? [...serverNames] : [server]
    for (const target of servers) {
      if (!Array.isArray(tools)) continue
      for (const tool of tools) if (typeof tool === "string") result.push([target, tool])
    }
  }
  return result
}

export function applyManagedMcpPermission(permission, agent, serverNames = new Set()) {
  const knownServers = serverNames.size > 0 ? serverNames : collectMcpServerNames([agent], undefined)
  if (knownServers.size === 0) return permission
  const projected = { ...permissionObject(permission) }
  for (const server of knownServers) projected[mcpToolKey(server, "*")] = "deny"
  for (const [server, tool] of mcpEntries(agent?.loadMcp, knownServers)) {
    projected[mcpToolKey(server, tool)] = "allow"
  }
  return projected
}

function applyBlacklistPermission(permission, agent, serverNames = new Set()) {
  const projected = { ...permissionObject(permission) }
  const deny = (name) => { delete projected[name]; projected[name] = "deny" }
  const denyResources = (name, blocked) => {
    if (!Array.isArray(blocked) || blocked.length === 0) return
    if (blocked.includes("*")) {
      deny(name)
      return
    }
    // Materialize every matching permission rule before moving the entry last,
    // preserving the effective decision for resources outside the blacklist.
    const resources = { "*": "allow" }
    for (const rule of compilePermissionRules(projected)) {
      if (!wildcardMatch(name, rule.permission)) continue
      delete resources[rule.pattern]
      resources[rule.pattern] = rule.action
    }
    for (const resource of blocked) {
      delete resources[resource]
      resources[resource] = "deny"
    }
    delete projected[name]
    projected[name] = resources
  }
  for (const name of Array.isArray(agent?.blockTools) ? agent.blockTools : []) deny(name)
  denyResources("skill", agent?.blockSkills)
  if (Array.isArray(agent?.blockMcp)) {
    const servers = agent.blockMcp.includes("*") ? [...serverNames] : agent.blockMcp
    for (const server of servers) {
      const wildcard = mcpToolKey(server, "*")
      const prefix = wildcard.slice(0, -1)
      for (const name of Object.keys(projected)) if (name.startsWith(prefix)) delete projected[name]
      deny(wildcard)
    }
  }
  denyResources(AGENT_TASK_TOOL, agent?.blockAgents)
  denyResources(WORKFLOW_TOOL, agent?.blockWorkflows)
  return projected
}

export function applyPlanOverridePermission(permission, agent, agents = [], mcpServerNames = new Set()) {
  if (!agent?.planProfile) return permission
  let projected = permission === "allow" || permission === "ask" || permission === "deny"
    ? { "*": permission }
    : objectValue(permission)
  if (agent.planOverrides?.loadTools && Array.isArray(agent.loadTools)) {
    const enabled = new Set(agent.loadTools)
    projected = {
      ...projected,
      ...Object.fromEntries([...BUILTIN_TOOL_NAMES, ...INTERNAL_TOOL_NAMES]
        .filter((name) => name !== AGENT_TASK_TOOL)
        .map((name) => [name, enabled.has(name) ? "allow" : "deny"])),
    }
  }
  if (agent.planOverrides?.loadSkills) projected = applyExplicitSkillPermission(projected, agent)
  if (agent.planOverrides?.loadAgents) {
    const canDelegate = delegationTargetNames(agent, agents).length > 0
    projected = {
      ...projected,
      [AGENT_TASK_TOOL]: managedTaskPermission(agent, agents),
      [TASK_TOOL]: canDelegate || hasWorkflowTargets(agent) ? "allow" : commandTaskPermission(projected),
    }
  }
  if (agent.planOverrides?.loadWorkflows) projected = { ...projected, [WORKFLOW_TOOL]: hasWorkflowTargets(agent) ? "allow" : "deny" }
  if (agent.planOverrides?.loadMcp) {
    const knownServers = mcpServerNames.size > 0 ? mcpServerNames : collectMcpServerNames([agent], undefined)
    for (const server of knownServers) projected[mcpToolKey(server, "*")] = "deny"
    for (const [server, tool] of mcpEntries(agent.loadMcp, knownServers)) projected[mcpToolKey(server, tool)] = "allow"
  }
  return mergeAgentPermission(projected, agent.planPermission)
}

export function applyRuntimeSafetyPermission(permission, agent, agents = []) {
  const projected = permission === "allow" || permission === "ask" || permission === "deny"
    ? { "*": permission }
    : objectValue(permission)
  const ordered = { ...projected }
  if (!DELEGATION_REQUESTER_TYPES.has(agent?.type)) {
    for (const name of [AGENT_TASK_TOOL, TASK_TOOL, WORKFLOW_TOOL]) {
      delete ordered[name]
      ordered[name] = "deny"
    }
    return ordered
  }
  delete ordered[AGENT_TASK_TOOL]
  ordered[AGENT_TASK_TOOL] = managedTaskPermission(agent, agents, projected)
  if (!WORKFLOW_REQUESTER_TYPES.has(agent?.type)) {
    delete ordered[WORKFLOW_TOOL]
    ordered[WORKFLOW_TOOL] = "deny"
  }
  if (delegationTargetNames(agent, agents).length === 0 && !hasWorkflowTargets(agent)) {
    delete ordered[TASK_TOOL]
    ordered[TASK_TOOL] = commandTaskPermission(projected)
  }
  return ordered
}

export function effectiveAgentPermission(agent, { agents = [], managedMcp, mcpServerNames, basePermission = {} } = {}) {
  const knownMcpServers = collectMcpServerNames([...agents, agent], managedMcp)
  for (const name of mcpServerNames ?? []) knownMcpServers.add(name)
  let permission = basePermission
  permission = applyManagedToolPermission(permission, agent)
  permission = applyManagedSkillPermission(permission, agent)
  permission = applyManagedDelegationPermission(permission, agent, agents)
  permission = applyManagedMcpPermission(permission, agent, knownMcpServers)
  if (agent?.type !== "system") permission = mergeAgentPermission(permission, agent?.permission)
  if (agent?.planProfile) {
    permission = decidePlanPermission(permission, { intersect: Array.isArray(agent?.loadTools) })
    permission = applyPlanOverridePermission(permission, agent, agents, knownMcpServers)
  }
  permission = applyRuntimeSafetyPermission(permission, agent, agents)
  return applyBlacklistPermission(permission, agent, knownMcpServers)
}

export function normalizePermissionOverlayInput(overlay, label = "permissionOverlay") {
  if (overlay === undefined) return {}
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) throw new Error(`${label} 必须是权限名称到 ask/deny 的对象`)
  const validated = {}
  for (const [name, action] of Object.entries(overlay)) {
    assertCanonicalPermissionName(name, label)
    if (action !== "ask" && action !== "deny") throw new Error(`${label}.${name} 只能是 ask 或 deny`)
    validated[name] = action
  }
  return validated
}

export function normalizePermissionOverlay(overlay, basePermission) {
  const normalized = normalizePermissionOverlayInput(overlay)
  for (const [name, action] of Object.entries(normalized)) {
    const base = overlayBaseActions(basePermission, name).reduce((lowest, candidate) => ACTION_RANK[candidate] < ACTION_RANK[lowest] ? candidate : lowest, "allow")
    if (ACTION_RANK[action] > ACTION_RANK[base]) throw new Error(`permissionOverlay.${name} 不能把 ${base} 扩大为 ${action}`)
  }
  return normalized
}

export function applyPermissionOverlay(permission, overlay) {
  const normalized = normalizePermissionOverlay(overlay, permission)
  if (Object.keys(normalized).length === 0) return permission
  if (permission === "deny") return permission
  if (permission === "allow" || permission === "ask" || permission === undefined) return { "*": permission ?? "allow", ...normalized }
  if (normalized["*"]) {
    const projected = Object.fromEntries(Object.keys(objectValue(permission))
      .filter((name) => name !== "*" && !(name in normalized))
      .map((name) => [name, normalized[name] ?? normalized["*"]]))
    return { ...projected, ...normalized }
  }
  const projected = { ...objectValue(permission) }
  for (const name of Object.keys(normalized)) delete projected[name]
  return { ...projected, ...normalized }
}

export function applyInheritedPermissionOverlay(permission, overlay) {
  let projected = permission === "allow" || permission === "ask" || permission === "deny"
    ? { "*": permission }
    : { ...objectValue(permission) }
  const tighten = (action) => action === "allow" ? "ask" : action
  for (const [name, action] of Object.entries(normalizePermissionOverlayInput(overlay))) {
    if (action === "deny") {
      delete projected[name]
      projected[name] = "deny"
      continue
    }
    if (name === "*") {
      const covered = compilePermissionRules(projected).some((rule) => /^\*+$/.test(rule.permission) && /^\*+$/.test(rule.pattern))
      projected = Object.fromEntries(Object.entries(projected).map(([key, rule]) => [key,
        typeof rule === "string" ? tighten(rule)
          : Object.fromEntries(Object.entries(objectValue(rule)).map(([pattern, value]) => [pattern, tighten(value)])),
      ]))
      if (!covered) {
        // A distinct equivalent wildcard keeps the implicit default before all
        // existing rules, including a later resource-only wildcard rule.
        let fallback = "*"
        while (Object.hasOwn(projected, fallback)) fallback += "*"
        projected = { [fallback]: "ask", ...projected }
      }
      continue
    }
    if (/[?*]/.test(name)) throw new Error(`Inherited permissionOverlay.${name}: ask wildcard intersection cannot be verified`)
    const rule = { "*": "ask" }
    for (const existing of compilePermissionRules(projected)) {
      if (!wildcardMatch(name, existing.permission)) continue
      delete rule[existing.pattern]
      rule[existing.pattern] = tighten(existing.action)
    }
    delete projected[name]
    projected[name] = rule
  }
  return projected
}

export const permissionRules = compilePermissionRules

export function deriveSelfEffects(agent, { permissionOverlay, writeScopes = [], permission: projectedPermission } = {}) {
  const permission = applyPermissionOverlay(projectedPermission ?? effectiveAgentPermission(agent), permissionOverlay)
  const mayUse = (name) => permissionActions(permission, name).some((action) => action !== "deny")
  if (mayUse("bash") || mayUse("execute")) return { kind: "unknown-write", permission }
  if (permission === "allow" || permission === "ask") return { kind: "unknown-write", permission }
  // A pattern's literal spelling cannot prove all the tools it matches are denied.
  let closedToolSet = false
  for (const rule of compilePermissionRules(permission).toReversed()) {
    if (rule.permission === "*" && rule.pattern === "*" && rule.action === "deny") {
      closedToolSet = true
      break
    }
    if (/[?*]/.test(rule.permission) && rule.action !== "deny") return { kind: "unknown-write", permission }
  }
  if (!closedToolSet) return { kind: "unknown-write", permission }
  for (const name of Object.keys(objectValue(permission))) {
    // external_directory gates paths; the actual tool still determines its Effect.
    if (name === "*" || name === "external_directory" || name === "doom_loop" || EFFECT_SAFE_PERMISSION_NAMES.has(name) || EFFECT_WRITE_PERMISSION_NAMES.has(name)) continue
    if (mayUse(name)) return { kind: "unknown-write", permission }
  }
  const wildcard = objectValue(permission)["*"]
  if (wildcard === "allow" || wildcard === "ask") return { kind: "unknown-write", permission }
  if (mayUse("edit")) {
    return writeScopes.length > 0
      ? { kind: "scoped-write", permission, writeScopes: [...writeScopes] }
      : { kind: "unknown-write", permission }
  }
  return { kind: "read", permission }
}

function isLoaded(loadAgents, name) {
  return Array.isArray(loadAgents) && (loadAgents.includes("*") || loadAgents.includes(name))
}

export function legalAgentCandidates({ requester, agents, required = {}, mcpServerNames }) {
  const candidates = []
  for (const agent of agents) {
    if (!agent || !DELEGATABLE_TYPES.has(agent.type) || !isLoaded(requester?.loadAgents, agent.name)) continue
    if (Array.isArray(requester?.blockAgents) && (requester.blockAgents.includes("*") || requester.blockAgents.includes(agent.name))) continue
    if (required.plan === true && !agent.planProfile) continue
    if (required.plan === false && agent.planProfile) continue
    if (required.skill && !agent.capabilities?.includes(required.skill)) continue
    const permission = effectiveAgentPermission(agent, { agents, mcpServerNames })
    if (Array.isArray(required.tools) && required.tools.some((name) => permissionActions(permission, name).every((action) => action === "deny"))) continue
    let effect
    try {
      effect = deriveSelfEffects(agent, { permission, permissionOverlay: required.permissionOverlay, writeScopes: required.writeScopes })
    } catch {
      continue
    }
    if (required.effect && effect.kind !== required.effect) continue
    candidates.push({
      id: agent.name,
      type: agent.type,
      description: agent.description,
      capabilities: [...(agent.capabilities ?? [])],
      plan: Boolean(agent.planProfile),
      effect: effect.kind,
    })
  }
  return candidates.toSorted((left, right) => left.id.localeCompare(right.id))
}

export function selectPreferredAgent({ preferred, fallback = "discover", candidates }) {
  if (preferred) {
    const match = candidates.find((candidate) => candidate.id === preferred)
    if (match) return { status: "selected", agent: match }
    if (fallback !== "discover") return { status: "agent-not-found", candidates: [] }
  }
  if (candidates.length === 0) return { status: "agent-not-found", candidates: [] }
  if (candidates.length === 1) return { status: "selected", agent: candidates[0] }
  return { status: "selection-required", candidates }
}
