import { collectMcpServerNames, effectiveAgentPermission } from "../../core/agent-routing.mjs"
import { compilePermissionRules } from "../../core/permission-rules.mjs"
import { loadRuntimeDefinition } from "../../runtime-builder.mjs"
import { configRootExists, resolveO4eConfigRoot, runtimePaths } from "../../config-paths.mjs"
import { resolveO4eMode } from "../../run-mode.mjs"
import { toV2PermissionRules } from "./permissions.mjs"
import { assertV2Feature } from "./feature-gates.mjs"
import { createV2HostPorts } from "./host-ports.mjs"
import { createV2RegistrationSet } from "./registrations.mjs"
import { createV2FeatureRegistry } from "./feature-registry.mjs"
import { withV2ToolCall } from "./tool-call.mjs"

export const V2_EXECUTION_GATES = Object.freeze([
  "resource-scoped host approval for each tool call",
  "controlled child Session creation with a verifiable parent",
  "bounded, provenance-preserving Message/Part pagination and Session activity",
  "persistent updates to the original completed Tool Part",
])

// This is a transport-only projection, NOT an execution authorization. V2
// 2.0.15 cannot create O4E Agents here or safely take over native identities.
const UNSUPPORTED_EXECUTION = Object.freeze([
  "shell", "subagent", "bash", "task", "o4e_task", "o4e_workflow", "execute", "edit", "write", "apply_patch", "codemode",
])

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export function readV2Definition(directory, env = process.env) {
  if (resolveO4eMode(env) === "origin") return null
  const configuredRoot = resolveO4eConfigRoot(env)
  const explicit = env.o4e_config !== undefined
  if (explicit && !configRootExists(configuredRoot, "global")) throw new Error("O4E_V2_CONFIG_NOT_FOUND")
  for (const { configRoot, scope } of runtimePaths(directory, configuredRoot, explicit)) {
    if (!configRootExists(configRoot, scope)) continue
    // An invalid selected project config cannot fall through to global.
    return { configRoot, ...loadRuntimeDefinition(configRoot) }
  }
  return null
}

export function v2McpConfig(server) {
  if (server.type !== "local" && server.type !== "remote") throw new Error("O4E_V2_MCP_INHERITED_SERVER_UNSUPPORTED")
  const result = structuredClone(server)
  if (result.enabled !== undefined) {
    result.disabled = !result.enabled
    delete result.enabled
  }
  if (result.timeout !== undefined) {
    // V1's single timeout is not equivalent to V2's startup/catalog/execution
    // phases; dropping it would widen the operation. Refuse instead.
    throw new Error("O4E_V2_MCP_TIMEOUT_UNSUPPORTED")
  }
  if (result.type === "remote" && result.oauth && result.oauth !== false) {
    result.oauth = Object.fromEntries(Object.entries(result.oauth).map(([key, value]) => [
      ({ clientId: "client_id", clientSecret: "client_secret", callbackPort: "callback_port", redirectUri: "redirect_uri" })[key] ?? key, value,
    ]))
  }
  return result
}

export function v2AgentPermissionPreview(agent, currentPermissions, definition) {
  if (!Array.isArray(currentPermissions)) throw new Error("O4E_V2_AGENT_PERMISSIONS_UNAVAILABLE")
  const agents = definition.runtimeAgents
  const names = collectMcpServerNames(agents, definition.config.mcp)
  const denials = toV2PermissionRules(compilePermissionRules(effectiveAgentPermission(agent, {
    agents, managedMcp: definition.config.mcp, mcpServerNames: names,
  }))).filter((rule) => rule.effect === "deny")
  // Pure preview only: a matching ID is not proof of O4E Agent ownership.
  // Never apply these rules to a host Agent without a verified ownership gate.
  return [...structuredClone(currentPermissions), ...denials,
    ...UNSUPPORTED_EXECUTION.map((action) => ({ action, resource: "*", effect: "deny" }))]
}

export function v2Status(definition, ports) {
  return {
    adapter: "OpenCode V2 compatibility preview",
    configured: Boolean(definition),
    managedExecution: "unavailable",
    mcpProjection: "unavailable",
    missingHostGates: V2_EXECUTION_GATES,
    hostFeatures: ports?.features ?? {},
    featurePlan: ports?.featurePlan ?? {},
    ...(definition ? {
      configuredAgentCount: definition.runtimeAgents.length,
      configuredMcpServerCount: Object.keys(objectValue(definition.config.mcp)).length,
    } : {}),
  }
}

// Injectable setup for tests: the production entry supplies @opencode/plugin's
// Plugin.define. No import from the V1 SDK or V1 Runtime is allowed here.
export function createV2Plugin(define) {
  return define({
    id: "opencode-for-everything-v2-preview",
    async setup(ctx) {
      const directory = ctx.location?.directory
      if (typeof directory !== "string" || !directory) throw new Error("O4E_V2_LOCATION_UNAVAILABLE")
      const definition = readV2Definition(directory)
      if (!definition) return
      const ports = createV2HostPorts(ctx)
      assertV2Feature("statusTool", ports.capabilities)
      const registrations = createV2RegistrationSet()
      const featureRegistry = createV2FeatureRegistry(ports.capabilities)
      const featurePlan = () => Object.fromEntries(featureRegistry.plan().map((entry) => [entry.name, entry]))
      const status = () => v2Status(definition, { ...ports, featurePlan: featurePlan() })
      // The tool setup callback is replayed by the host, so compute the plan
      // at execution time rather than mutating a frozen Port object.
      featureRegistry.define({
        name: "statusTool",
        feature: "statusTool",
        setup: async () => ports.transforms.tool.transform((editor) => {
          // V2 replays transforms against its own tool catalog. Never replace
          // an unrelated host/user tool that happens to use our preview name.
          if (typeof editor?.get !== "function" || typeof editor?.add !== "function") {
            throw new Error("O4E_V2_TOOL_EDITOR_UNAVAILABLE")
          }
          if (editor.get("o4e_v2_status") !== undefined) throw new Error("O4E_V2_STATUS_TOOL_CONFLICT")
          editor.add({
            name: "o4e_v2_status",
            description: "Read-only O4E V2 compatibility status. Managed execution is unavailable.",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            async execute(_input, context) {
              return withV2ToolCall(context, async () => ({ content: JSON.stringify(status()) }))
            },
          })
        }),
      })
      try {
        // A configured MCP server is only counted in the read-only status.
        // Never register it until ownership and Agent policy are proven.
        await featureRegistry.install(registrations)
      } catch (error) {
        try { await registrations.rollback() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "O4E_V2_SETUP_ROLLBACK_UNCERTAIN")
        }
        throw error
      }
      return async () => {
        await registrations.dispose()
      }
    },
  })
}
