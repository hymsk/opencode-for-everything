function assertRegistration(registration) {
  if (!registration || typeof registration.dispose !== "function") {
    throw new Error("O4E_V2_INVALID_REGISTRATION")
  }
  return registration
}

// Own every host transform from one place. Future Ports can add event hooks or
// reload handles without changing plugin cleanup and rollback semantics.
export function createV2RegistrationSet() {
  const registrations = []
  let closed = false
  let closing = false
  let disposePromise

  return {
    get size() { return registrations.length },
    add(registration) {
      if (closed || closing || disposePromise) throw new Error("O4E_V2_REGISTRATION_SET_CLOSED")
      registrations.push(assertRegistration(registration))
      return registration
    },
    async rollback() {
      if (disposePromise) return disposePromise
      disposePromise = (async () => {
        const errors = []
        for (let index = registrations.length - 1; index >= 0; index -= 1) {
          const registration = registrations[index]
          try {
            await registration.dispose()
            registrations.splice(index, 1)
          } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, "O4E_V2_REGISTRATION_ROLLBACK_FAILED")
      })()
      try { await disposePromise } finally { disposePromise = undefined }
    },
    async dispose() {
      if (closed) return
      closing = true
      try {
        await this.rollback()
        closed = true
      } finally {
        closing = false
      }
    },
  }
}
