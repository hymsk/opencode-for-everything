function asModelRef(value) {
  if (typeof value === "string") {
    const text = value.trim()
    const separator = text.indexOf("/")
    if (separator <= 0 || separator === text.length - 1) return null
    const providerID = text.slice(0, separator).trim()
    const modelID = text.slice(separator + 1).trim()
    return providerID && modelID ? { providerID, modelID } : null
  }

  if (value && typeof value === "object" && typeof value.id === "string") {
    const ref = asModelRef(value.id)
    if (!ref) return null
    const variant = typeof value.variant === "string" && value.variant.trim() !== "" ? value.variant.trim() : undefined
    return variant === undefined ? ref : { ...ref, variant }
  }

  if (value && typeof value === "object" && typeof value.providerID === "string" && typeof value.modelID === "string") {
    const providerID = value.providerID.trim()
    const modelID = value.modelID.trim()
    const variant = typeof value.variant === "string" && value.variant.trim() !== "" ? value.variant.trim() : undefined
    if (providerID && modelID) return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }
  }

  return null
}

export function modelRefKey(value) {
  const model = asModelRef(value)
  return model ? `${model.providerID}/${model.modelID}` : null
}

export function modelCandidateKey(value) {
  const model = asModelRef(value)
  return model ? candidateKey(model) : null
}

function candidateKey(model) {
  return `${model.providerID}/${model.modelID}\u0000${model.variant ?? ""}`
}

export function normalizeModelRefs(values) {
  const models = []
  const seen = new Set()
  for (const value of values ?? []) {
    const model = asModelRef(value)
    if (!model) continue
    const key = candidateKey(model)
    if (seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  return models
}

export function isRetryableModelError(error) {
  return error?.name === "APIError" && error?.data?.isRetryable === true
}

export function availableModelKeys(source) {
  const entries = Array.isArray(source?.all)
    ? source.all.filter((provider) => typeof provider?.id === "string").map((provider) => [provider.id, provider.models])
    : Object.entries(source?.provider ?? {}).map(([id, provider]) => [id, provider?.models])
  return new Set(entries.flatMap(([id, models]) => Object.keys(models ?? {}).map((model) => `${id}/${model}`)))
}

export function firstAvailableModelFromKeys(configuredModels, available) {
  return normalizeModelRefs(configuredModels).find((model) => available.has(modelRefKey(model))) ?? null
}

// In-memory candidate metadata only; never writes source configuration or host
// preferences, selects another model, or starts another model turn.
export class SessionModelFallback {
  #sessions = new Map()

  deleteSession(sessionID) { this.#sessions.delete(sessionID) }
  clear() { this.#sessions.clear() }

  recordMessage({ sessionID, messageID, agent, model, fallbackModels, parts }) {
    if (!sessionID) return
    const current = asModelRef(model)
    // A role's default model selects an initial model; it is not an implicit
    // fallback for a user's explicit choice (including a different variant).
    const configured = normalizeModelRefs(fallbackModels)
    let index = current ? configured.findIndex((candidate) => candidateKey(candidate) === candidateKey(current)) : -1
    const candidates = index >= 0 ? configured.slice(index) : normalizeModelRefs([current, ...configured])
    if (!candidates.length) { this.deleteSession(sessionID); return }
    this.#sessions.set(sessionID, {
      candidates,
      currentModel: candidates[0],
      request: { ...(messageID ? { messageID } : {}), agent, parts },
    })
  }

  describeError(sessionID, error) {
    const state = this.#sessions.get(sessionID)
    if (!state) return null
    const currentKey = candidateKey(state.currentModel)
    const currentIndex = state.candidates.findIndex((candidate) => candidateKey(candidate) === currentKey)
    return {
      retryable: isRetryableModelError(error),
      currentModel: structuredClone(state.currentModel),
      fallbackCandidates: structuredClone(state.candidates.slice(currentIndex + 1)),
    }
  }
}
