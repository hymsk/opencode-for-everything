// Transport translation only. This does not authorize an operation or replace
// the host's resource-level permission request (not exposed in plugin 2.0.15).
const ACTIONS = new Map([["bash", "shell"], ["task", "subagent"]])
const EFFECTS = new Set(["allow", "ask", "deny"])

export function toV2PermissionAction(action) {
  if (typeof action !== "string" || !action.trim()) throw new Error("O4E_V2_INVALID_PERMISSION_ACTION")
  // Pattern translation needs a separate semantic proof. Do not silently leave
  // a pattern such as ba* matching a different universe of host actions.
  if (action !== "*" && /[*?]/.test(action)) throw new Error("O4E_V2_PERMISSION_ACTION_PATTERN_UNSUPPORTED")
  return ACTIONS.get(action) ?? action
}

export function toV2PermissionRules(rules) {
  if (!Array.isArray(rules)) throw new Error("O4E_V2_INVALID_PERMISSION_RULES")
  return rules.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)
      || Object.keys(rule).some((key) => !["permission", "pattern", "action"].includes(key))
      || typeof rule.pattern !== "string" || !rule.pattern.trim() || !EFFECTS.has(rule.action)) {
      throw new Error("O4E_V2_INVALID_PERMISSION_RULE")
    }
    return { action: toV2PermissionAction(rule.permission), resource: rule.pattern, effect: rule.action }
  })
}
