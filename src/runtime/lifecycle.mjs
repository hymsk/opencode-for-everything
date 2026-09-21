export function createRuntimeLifecycle(onDispose) {
  let disposed = false
  let disposing = false
  let disposal
  return {
    isActive() {
      return !disposed && !disposing
    },
    state() {
      if (disposed) return "disposed"
      if (disposing) return "disposing"
      return "active"
    },
    async dispose() {
      if (!disposal) {
        disposing = true
        disposal = (async () => {
          await onDispose()
          disposed = true
        })()
      }
      try {
        await disposal
      } catch (error) {
        disposal = undefined
        disposing = false
        throw error
      }
    },
  }
}
