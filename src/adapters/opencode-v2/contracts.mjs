// Host-neutral V2 adapter contracts. Runtime code should depend on these
// shapes, not on OpenCode's changing domain names. Concrete V2 context
// mapping lives in host-ports.mjs.
export const V2_HOST_PORT_CONTRACT_VERSION = 1

export const V2_PORTS = Object.freeze({
  authorization: Object.freeze(["ask"]),
  sessions: Object.freeze(["create", "get", "update", "messages", "active", "source", "parentCreate"]),
  execution: Object.freeze(["prompt", "generate", "interrupt", "wait"]),
  parts: Object.freeze(["update"]),
})

/**
 * @typedef {{
 *   ask: (request: object, context?: object) => Promise<object>,
 *   evaluate: Function,
 * }} V2AuthorizationPort
 * @typedef {{
 *   create: Function,
 *   get: Function,
 *   update: Function,
 *   messages: Function,
 *   active: Function,
 *   source: Function,
 *   parentCreate: Function,
 * }} V2SessionPort
 * @typedef {{
 *   prompt: Function,
 *   generate: Function,
 *   interrupt: Function,
 *   wait: Function,
 * }} V2ExecutionPort
 * @typedef {{ update: Function }} V2OriginalPartPort
 */

export function createV2PortError(port, reason = "capability-unavailable") {
  const error = new Error(`O4E_V2_PORT_UNAVAILABLE:${port}`)
  error.code = "O4E_V2_PORT_UNAVAILABLE"
  error.port = port
  error.reason = reason
  return error
}

export function createUnavailableMethod(port, reason = "capability-unavailable") {
  const unavailable = () => { throw createV2PortError(port, reason) }
  unavailable.available = false
  unavailable.port = port
  unavailable.reason = reason
  return unavailable
}

export function createAvailableMethod(method, port, owner = undefined) {
  if (typeof method !== "function") return createUnavailableMethod(port)
  const available = (...args) => method.apply(owner, args)
  available.available = true
  available.port = port
  return available
}

export function assertV2HostPorts(ports) {
  if (!ports || ports.contractVersion !== V2_HOST_PORT_CONTRACT_VERSION) {
    throw Object.assign(new Error("O4E_V2_INVALID_HOST_PORTS"), { code: "O4E_V2_INVALID_HOST_PORTS" })
  }
  for (const [name, methods] of Object.entries(V2_PORTS)) {
    if (!ports[name] || typeof ports[name] !== "object") {
      throw Object.assign(new Error(`O4E_V2_INVALID_HOST_PORT:${name}`), { code: "O4E_V2_INVALID_HOST_PORT" })
    }
    for (const method of methods) {
      if (typeof ports[name][method] !== "function" && typeof ports[name][method]?.unavailable !== "function") {
        throw Object.assign(new Error(`O4E_V2_INVALID_HOST_PORT_METHOD:${name}.${method}`), { code: "O4E_V2_INVALID_HOST_PORT_METHOD" })
      }
    }
  }
  return ports
}
