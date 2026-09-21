import { NATIVE_AGENT_NAMES } from "../agent-layout.mjs"

export function resolveNativeAgentName(agent, nativeModes = {}) {
  if (agent === "build") return nativeModes.build
  if (agent === "plan") return nativeModes.plan
  return agent
}

export function applyNativeAgentTakeover(config, nativeModes = {}, nativeAgentStrategies) {
  const agents = { ...config.agent }
  if (!nativeAgentStrategies) throw new Error("nativeAgentStrategies 必须显式提供")

  for (const nativeName of NATIVE_AGENT_NAMES) {
    const strategy = nativeAgentStrategies[nativeName]
    if (strategy === "keep") continue
    if (strategy === "disable") {
      agents[nativeName] = { disable: true }
      continue
    }
    const source = nativeModes[nativeName] ?? nativeName
    if (source === nativeName) {
      const current = agents[nativeName] && typeof agents[nativeName] === "object" ? agents[nativeName] : {}
      const { disable: _disable, ...enabled } = current
      agents[nativeName] = enabled
    } else {
      agents[nativeName] = { disable: true }
      const current = agents[source] && typeof agents[source] === "object" ? agents[source] : {}
      const { disable: _disable, ...enabled } = current
      agents[source] = enabled
    }
  }

  let selected = config.default_agent
  if ((!selected || selected === "build") && nativeModes.build) selected = nativeModes.build
  if (selected === "plan" && nativeModes.plan) selected = nativeModes.plan

  config.agent = agents
  if (selected !== undefined) config.default_agent = selected
}
