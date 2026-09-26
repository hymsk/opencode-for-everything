import { evaluateV2Feature } from "./feature-gates.mjs"

// Declarative feature registration keeps future command/delegation/workflow
// additions independent: each feature states its Gate and owns only its host
// registrations. Unavailable features are skipped, never partially wired.
export function createV2FeatureRegistry(capabilities) {
  const definitions = new Map()
  let installing = false

  return {
    define({ name, feature, setup }) {
      if (typeof name !== "string" || !name || definitions.has(name)) throw new Error("O4E_V2_FEATURE_REGISTRATION_INVALID")
      if (typeof setup !== "function") throw new Error("O4E_V2_FEATURE_SETUP_INVALID")
      definitions.set(name, { name, feature, setup })
      return this
    },
    plan() {
      return [...definitions.values()].map(({ name, feature }) => ({ name, feature, ...evaluateV2Feature(feature, capabilities) }))
    },
    async install(registrations, { only = undefined } = {}) {
      if (!registrations || typeof registrations.add !== "function") throw new Error("O4E_V2_FEATURE_REGISTRATION_SET_REQUIRED")
      if (installing) throw new Error("O4E_V2_FEATURE_INSTALL_IN_PROGRESS")
      installing = true
      const installed = []
      const skipped = []
      try {
        for (const definition of definitions.values()) {
          if (only && !only.includes(definition.name)) continue
          const gate = evaluateV2Feature(definition.feature, capabilities)
          if (!gate.available) {
            skipped.push({ name: definition.name, feature: definition.feature, missing: gate.missing })
            continue
          }
          // Once setup begins, even a FEATURE_UNAVAILABLE error is an actual
          // registration failure, not evidence that setup was safely skipped.
          const registration = await definition.setup()
          registrations.add(registration)
          installed.push(definition.name)
        }
        return { installed, skipped }
      } finally {
        installing = false
      }
    },
  }
}
