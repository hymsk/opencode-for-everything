const O4E_MODE_VALUES = new Set(["default", "origin", "clear"])

// Unsupported o4e_mode values fall back to default (CFG-008). Both the server
// plugin and the TUI entry share these helpers so the fallback projection and
// the user-facing diagnostic stay identical across processes.
export function resolveO4eMode(env = process.env) {
  const value = env.o4e_mode
  if (value === "origin") return "origin"
  if (value === "clear") return "clear"
  return "default"
}

export function invalidO4eModeValue(env = process.env) {
  const value = env.o4e_mode
  return value === undefined || O4E_MODE_VALUES.has(value) ? undefined : value
}

export function invalidO4eModeMessage(value) {
  const bounded = value.length > 80 ? `${value.slice(0, 80)}…` : value
  return `O4E_MODE_FALLBACK: o4e_mode=${JSON.stringify(bounded)} 不是受支持的取值（default/origin/clear），已回退为 default 启用 O4E`
}
