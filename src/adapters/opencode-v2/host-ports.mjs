import { describeV2Features } from "./feature-gates.mjs"
import { assertV2HostPorts, createAvailableMethod, createUnavailableMethod, V2_HOST_PORT_CONTRACT_VERSION } from "./contracts.mjs"

function available(method, reason = `${method}-unavailable`) {
  return { available: typeof method === "function", reason }
}

function unavailable(reason) {
  return { available: false, reason }
}

export function createUnavailablePort(name, reason = `${name}-unavailable`) {
  const unavailableMethod = createUnavailableMethod(name, reason)
  return Object.freeze({ name, available: false, reason, unavailable: unavailableMethod })
}

function createTransformPort(name, transform, owner) {
  if (typeof transform !== "function") return createUnavailablePort(name, `${name}-transform-unavailable`)
  return Object.freeze({
    name,
    available: true,
    transform: createAvailableMethod(transform, `${name}.transform`, owner),
  })
}

function createAuthorizationPort(ctx) {
  // This is intentionally a port, not a best-effort wrapper around
  // permission.evaluate/reply. Those APIs do not establish a per-call user
  // approval and must not be presented as an equivalent ask operation.
  return Object.freeze({
    name: "authorization",
    available: false,
    reason: "tool-scoped-host-ask-unavailable",
    ask: createUnavailablePort("authorization.ask", "tool-scoped-host-ask-unavailable").unavailable,
    evaluate: typeof ctx?.permission?.hook === "function"
      ? createAvailableMethod(ctx.permission.hook, "authorization.evaluate", ctx.permission)
      : createUnavailableMethod("authorization.evaluate"),
  })
}

function createSessionPort(ctx) {
  const session = ctx?.session
  const missing = createUnavailablePort("session.source", "paged-message-and-activity-source-unavailable")
  return Object.freeze({
    name: "session",
    create: typeof session?.create === "function" ? createAvailableMethod(session.create, "session.create", session) : createUnavailableMethod("session.create"),
    get: typeof session?.get === "function" ? createAvailableMethod(session.get, "session.get", session) : createUnavailableMethod("session.get"),
    update: typeof session?.update === "function" ? createAvailableMethod(session.update, "session.update", session) : createUnavailableMethod("session.update"),
    messages: typeof session?.messages === "function" ? createAvailableMethod(session.messages, "session.messages", session) : missing.unavailable,
    active: typeof session?.active === "function" ? createAvailableMethod(session.active, "session.active", session) : missing.unavailable,
    source: missing,
    parentCreate: createUnavailablePort("session.parentCreate", "parent-session-create-unavailable"),
  })
}

function createPartPort() {
  return Object.freeze({
    name: "original-part",
    available: false,
    reason: "original-tool-part-update-unavailable",
    update: createUnavailablePort("original-part.update", "original-tool-part-update-unavailable").unavailable,
  })
}

function createExecutionPort(ctx) {
  const session = ctx?.session
  return Object.freeze({
    prompt: typeof session?.prompt === "function" ? createAvailableMethod(session.prompt, "execution.prompt", session) : createUnavailableMethod("execution.prompt"),
    generate: typeof session?.generate === "function" ? createAvailableMethod(session.generate, "execution.generate", session) : createUnavailableMethod("execution.generate"),
    interrupt: typeof session?.interrupt === "function" ? createAvailableMethod(session.interrupt, "execution.interrupt", session) : createUnavailableMethod("execution.interrupt"),
    wait: typeof session?.wait === "function" ? createAvailableMethod(session.wait, "execution.wait", session) : createUnavailableMethod("execution.wait"),
  })
}

// This probe reports only public capabilities actually exposed by the plugin
// context. It never infers a capability from a protocol endpoint, a private
// client, a similarly named method, or the model's ability to call a tool.
export function detectV2Capabilities(ctx) {
  const toolTransform = typeof ctx?.tool?.transform === "function"
  const agentTransform = typeof ctx?.agent?.transform === "function"
  const mcpTransform = typeof ctx?.mcp?.transform === "function"
  const sessionCreate = typeof ctx?.session?.create === "function"
  const permissionHook = typeof ctx?.permission?.hook === "function"

  return Object.freeze({
    location: typeof ctx?.location?.directory === "string" && ctx.location.directory.length > 0
      ? { available: true, reason: "public-location" }
      : unavailable("location-unavailable"),
    toolTransform: available(ctx?.tool?.transform, "tool-transform-unavailable"),
    agentTransform: available(ctx?.agent?.transform, "agent-transform-unavailable"),
    mcpTransform: available(ctx?.mcp?.transform, "mcp-transform-unavailable"),
    // V2 2.0.15 has no ownership marker/registration namespace that lets the
    // plugin prove an Agent belongs to this O4E runtime.
    agentOwnership: unavailable("agent-ownership-unproven"),
    mcpOwnership: unavailable("mcp-ownership-unproven"),
    // A ToolContext ask/permission.create was absent in the real 2.0.15
    // probe. A permission evaluate hook is observation/policy composition, not
    // a per-call approval request, so it is intentionally not promoted here.
    hostAsk: unavailable("tool-scoped-host-ask-unavailable"),
    permissionHook: permissionHook
      ? { available: true, reason: "permission-hook-present-but-not-an-ask" }
      : unavailable("permission-hook-unavailable"),
    // These are real 2.0.15 entrypoints but only expose narrower semantics.
    // Do not derive G1–G4 from a similarly named API or from a Tool option.
    permissionPending: available(ctx?.permission?.list, "permission-pending-list-unavailable"),
    sessionContext: available(ctx?.session?.context, "unbounded-model-context-unavailable"),
    toolAfterHook: available(ctx?.tool?.hook, "tool-result-hook-unavailable"),
    pluginRpc: available(ctx?.rpc?.register, "plugin-rpc-unavailable"),
    pluginStorage: available(ctx?.storage?.set, "plugin-storage-unavailable"),
    sessionCreate: available(ctx?.session?.create, "session-create-unavailable"),
    parentSessionCreate: unavailable("parent-session-create-unavailable"),
    sessionMetadata: unavailable("session-metadata-cas-unverified"),
    hostShell: unavailable("host-shell-profile-unverified"),
    sessionSource: typeof ctx?.session?.get === "function" && typeof ctx?.session?.update === "function"
      ? unavailable("paged-message-and-activity-source-unavailable")
      : unavailable("session-source-unavailable"),
    sessionMessages: available(ctx?.session?.messages, "session-messages-unavailable"),
    sessionActivity: available(ctx?.session?.active, "session-activity-unavailable"),
    originalPartUpdate: unavailable("original-tool-part-update-unavailable"),
    sessionContextTransform: available(ctx?.session?.hook, "session-context-transform-unavailable"),
  })
}

export function createV2HostPorts(ctx) {
  const capabilities = detectV2Capabilities(ctx)
  const transforms = Object.freeze({
    tool: createTransformPort("tool", ctx?.tool?.transform, ctx?.tool),
    agent: createTransformPort("agent", ctx?.agent?.transform, ctx?.agent),
    mcp: createTransformPort("mcp", ctx?.mcp?.transform, ctx?.mcp),
    session: createTransformPort("session", ctx?.session?.hook, ctx?.session),
  })
  return assertV2HostPorts(Object.freeze({
    contractVersion: V2_HOST_PORT_CONTRACT_VERSION,
    context: ctx,
    capabilities,
    features: describeV2Features(capabilities),
    featurePlan: undefined,
    location: Object.freeze({ directory: ctx?.location?.directory }),
    transforms,
    authorization: createAuthorizationPort(ctx),
    sessions: createSessionPort(ctx),
    execution: createExecutionPort(ctx),
    parts: createPartPort(),
    domains: Object.freeze({
      tool: ctx?.tool,
      agent: ctx?.agent,
      mcp: ctx?.mcp,
      permission: ctx?.permission,
      session: ctx?.session,
    }),
  }))
}
