import { NATIVE_AGENT_NAMES, NATIVE_AGENT_STRATEGIES } from "../agent-layout.mjs"

const NATIVE_AGENT_NAME_SET = new Set(NATIVE_AGENT_NAMES)
const NATIVE_AGENT_STRATEGY_SET = new Set(NATIVE_AGENT_STRATEGIES)

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value
}

export function normalizeNativeAgentStrategies(value, label = "nativeAgents") {
  const source = objectValue(value, label)
  for (const name of Object.keys(source)) {
    if (!NATIVE_AGENT_NAME_SET.has(name)) throw new Error(`${label} 不支持原生 Agent: ${name}`)
  }
  const strategies = {}
  for (const name of NATIVE_AGENT_NAMES) {
    const strategy = source[name]
    if (!NATIVE_AGENT_STRATEGY_SET.has(strategy)) {
      throw new Error(`${label}.${name} 必须是 keep、managed 或 disable`)
    }
    strategies[name] = strategy
  }
  return strategies
}

function nativeAgentDefinitions(agents) {
  const definitions = {}
  for (const name of ["build", "plan"]) {
    definitions[name] = agents.find((agent) => agent.nativeMode === name)
  }
  for (const name of ["general", "explore"]) {
    definitions[name] = agents.find((agent) => agent.name === name)
  }
  return definitions
}

export function resolveNativeAgentPolicy(configured, agents, label = "nativeAgents") {
  const strategies = normalizeNativeAgentStrategies(configured, label)
  const definitions = nativeAgentDefinitions(agents)

  for (const name of NATIVE_AGENT_NAMES) {
    const strategy = strategies[name]
    const definition = definitions[name]
    if (strategy === "managed") {
      if (!definition) throw new Error(`${label}.${name} 为 managed 时必须存在对应的受管 Agent 配置`)
      if (["general", "explore"].includes(name) && definition.type !== "subagent") {
        throw new Error(`${label}.${name} 为 managed 时必须使用同名 subagent 配置`)
      }
      continue
    }
    if (definition) throw new Error(`${label}.${name} 为 ${strategy} 时不能存在对应的受管 Agent 配置: ${definition.name}`)
  }

  return {
    strategies,
    targets: Object.fromEntries(NATIVE_AGENT_NAMES.map((name) => [name, definitions[name]?.name])),
  }
}
