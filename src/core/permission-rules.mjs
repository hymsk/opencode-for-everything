import { homedir } from "node:os"

const ACTIONS = new Set(["allow", "ask", "deny"])

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export function wildcardMatch(value, pattern) {
  value = value.replaceAll("\\", "/")
  pattern = pattern.replaceAll("\\", "/")
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(value)
}

export function compilePermissionRules(permission) {
  if (permission === undefined) return []
  if (ACTIONS.has(permission)) return [{ permission: "*", pattern: "*", action: permission }]

  const ruleset = []
  for (const [name, rawRule] of Object.entries(objectValue(permission))) {
    if (ACTIONS.has(rawRule)) {
      ruleset.push({ permission: name, pattern: "*", action: rawRule })
      continue
    }
    for (const [pattern, action] of Object.entries(objectValue(rawRule))) {
      if (!ACTIONS.has(action)) continue
      // Match the host's fromConfig expansion before freezing child Session rules.
      const expanded = pattern === "~" || pattern.startsWith("~/")
        ? homedir() + pattern.slice(1)
        : pattern.startsWith("$HOME") ? homedir() + pattern.slice(5) : pattern
      ruleset.push({ permission: name, pattern: expanded, action })
    }
  }
  return ruleset
}

export function evaluate(permission, pattern, ...rulesets) {
  const rules = rulesets.flat()
  const match = rules.findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern))
  return match ?? { permission, pattern: "*", action: "ask" }
}

export function evaluateResources(permission, patterns, ...rulesets) {
  let result = "allow"
  for (const pattern of patterns) {
    const action = evaluate(permission, pattern, ...rulesets).action
    if (action === "deny") return "deny"
    if (action === "ask") result = "ask"
  }
  return result
}
