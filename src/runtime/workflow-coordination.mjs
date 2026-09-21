import { canonicalDirectoryKey } from "./directory-key.mjs"
import { serial } from "./serial.mjs"

const KEY = Symbol.for("opencode-for-everything.workflow-process-coordination.v1")
const locks = globalThis[KEY] ??= new Map()

// Same-process owner serialization only; not a background ledger or lease.
export function withWorkflowRunLock(directory, owner, operation) {
  return serial(locks, `${canonicalDirectoryKey(directory)}\0${owner}`, operation)
}
