import { collectMcpServerNames, effectiveAgentPermission } from "../../core/agent-routing.mjs"

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export function applyMcpConfig(config, managedMcp) {
  if (managedMcp === undefined || Object.keys(managedMcp).length === 0) return
  config.mcp = { ...objectValue(config.mcp), ...structuredClone(managedMcp) }
}

export function applyAgentPolicies(config, agents, managedMcp, frozenMcpServerNames) {
  const mcpServerNames = frozenMcpServerNames ?? collectMcpServerNames(agents, managedMcp, config.mcp)
  if (config.permission === undefined) config.permission = {}
  config.agent = config.agent ?? {}
  for (const agent of agents) {
    const current = objectValue(config.agent[agent.name])
    config.agent[agent.name] = {
      ...current,
      ...(agent.planProfile && (agent.type === "primary" || agent.type === "all") ? { mode: agent.type } : {}),
      permission: effectiveAgentPermission(agent, { agents, mcpServerNames, managedMcp, basePermission: current.permission }),
    }
  }
}
