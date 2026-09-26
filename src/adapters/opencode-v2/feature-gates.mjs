// Capability names are deliberately independent from OpenCode method names.
// The V2 adapter can therefore keep its feature policy stable while host APIs
// evolve between releases.
export const V2_FEATURES = Object.freeze({
  statusTool: Object.freeze({ required: ["toolTransform"] }),
  agentProjection: Object.freeze({ required: ["agentTransform", "agentOwnership"] }),
  mcpProjection: Object.freeze({ required: ["mcpTransform", "mcpOwnership", "agentProjection"] }),
  promptProjection: Object.freeze({ required: ["sessionContextTransform", "agentProjection"] }),
  managedCommand: Object.freeze({ required: ["toolTransform", "hostAsk", "originalPartUpdate", "hostShell", "agentProjection"] }),
  managedDelegation: Object.freeze({ required: ["toolTransform", "hostAsk", "parentSessionCreate", "sessionSource", "sessionMetadata", "agentProjection"] }),
  taskManagement: Object.freeze({ required: ["toolTransform", "hostAsk", "sessionSource", "sessionMetadata", "managedDelegation", "managedCommand"] }),
  workflow: Object.freeze({ required: ["toolTransform", "hostAsk", "sessionSource", "sessionMetadata", "taskManagement", "promptProjection"] }),
})

export const V2_FEATURE_ORDER = Object.freeze([
  "statusTool",
  "agentProjection",
  "mcpProjection",
  "promptProjection",
  "managedCommand",
  "managedDelegation",
  "taskManagement",
  "workflow",
])

function requiredCapabilities(feature) {
  if (typeof feature === "string") {
    const definition = V2_FEATURES[feature]
    if (!definition) throw new Error(`O4E_V2_UNKNOWN_FEATURE:${feature}`)
    return definition.required
  }
  if (feature && typeof feature === "object" && Array.isArray(feature.required)) return feature.required
  throw new Error("O4E_V2_FEATURE_INVALID")
}

export function evaluateV2Feature(feature, capabilities) {
  const required = requiredCapabilities(feature)
  const visiting = new Set()
  const resolveFeature = (name) => {
    if (visiting.has(name)) throw new Error(`O4E_V2_FEATURE_CYCLE:${name}`)
    visiting.add(name)
    const dependencies = requiredCapabilities(name)
    const missing = dependencies.filter((item) => {
      if (Object.hasOwn(V2_FEATURES, item)) return !resolveFeature(item).available
      return capabilities?.[item]?.available !== true
    })
    visiting.delete(name)
    return { available: missing.length === 0, missing }
  }
  const missing = required.filter((name) => {
    if (Object.hasOwn(V2_FEATURES, name)) return !resolveFeature(name).available
    return capabilities?.[name]?.available !== true
  })
  return {
    available: missing.length === 0,
    required: [...required],
    missing,
    reasons: Object.fromEntries(missing.map((name) => [name,
      Object.hasOwn(V2_FEATURES, name) ? "feature-dependency-unavailable" : capabilities?.[name]?.reason ?? "capability-unavailable",
    ])),
  }
}

export function assertV2Feature(feature, capabilities) {
  const result = evaluateV2Feature(feature, capabilities)
  if (result.available) return result
  const error = new Error(`O4E_V2_FEATURE_UNAVAILABLE:${typeof feature === "string" ? feature : "custom"}`)
  error.code = "O4E_V2_FEATURE_UNAVAILABLE"
  error.feature = typeof feature === "string" ? feature : undefined
  error.missing = result.missing
  throw error
}

export function describeV2Features(capabilities) {
  return Object.fromEntries(V2_FEATURE_ORDER.map((name) => [name, evaluateV2Feature(name, capabilities)]))
}
