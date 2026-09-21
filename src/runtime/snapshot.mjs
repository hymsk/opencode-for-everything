export function createSnapshotAccessor(load) {
  let cached
  let initialized = false

  return () => {
    if (!initialized) {
      cached = load()
      initialized = true
    }
    return cached
  }
}
