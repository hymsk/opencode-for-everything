export const AGENT_TYPE_DIRECTORIES = Object.freeze({
  primary: "primary",
  subagent: "subagent",
  all: "all",
  system: "system",
})

export const SELECTABLE_AGENT_TYPES = Object.freeze(["primary", "all"])

export const SYSTEM_PHASE_AGENT_NAMES = Object.freeze([
  "compaction",
  "title",
  "summary",
])

export const NATIVE_MODES = Object.freeze(["build", "plan"])

export const NATIVE_AGENT_NAMES = Object.freeze(["build", "plan", "general", "explore"])

export const NATIVE_AGENT_STRATEGIES = Object.freeze(["keep", "managed", "disable"])
