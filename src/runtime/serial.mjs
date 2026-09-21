export function serial(queues, key, operation) {
  const next = (queues.get(key) ?? Promise.resolve()).then(operation)
  const tail = next.catch(() => undefined)
  queues.set(key, tail)
  return next.finally(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
}
