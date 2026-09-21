import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { canonicalDirectoryKey } from "./directory-key.mjs"

function inside(root, candidate) {
  const scoped = relative(root, candidate)
  return scoped === "" || (!scoped.startsWith("..") && !isAbsolute(scoped))
}

function realpathWithMissingLeaf(candidate) {
  const missing = []
  let current = candidate
  while (true) {
    try {
      const existing = realpathSync(current)
      return missing.reduceRight((path, part) => resolve(path, part), existing)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      try {
        lstatSync(current)
        throw new Error(`路径包含无法解析的符号链接: ${candidate}`)
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError
      }
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

function overlaps(left, right) {
  const leftToRight = relative(left, right)
  const rightToLeft = relative(right, left)
  return leftToRight === "" || rightToLeft === ""
    || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
}

export function normalizeWriteScopes(scopes, directory) {
  if (scopes === undefined) return []
  if (!Array.isArray(scopes)) throw new Error("writeScopes 必须是路径数组")
  const root = realpathSync(directory)
  const normalized = []
  for (const value of scopes) {
    if (typeof value !== "string" || value.trim() === "") throw new Error("writeScopes 只能包含非空路径")
    const candidate = resolve(root, value)
    if (!inside(root, candidate)) throw new Error(`writeScopes 超出工作目录: ${value}`)
    const real = realpathWithMissingLeaf(candidate)
    if (!inside(root, real)) throw new Error(`writeScopes 真实路径超出工作目录: ${value}`)
    if (!normalized.includes(real)) normalized.push(real)
  }
  return normalized.toSorted()
}

export function pathWithinScopes(path, scopes, directory) {
  try {
    const root = realpathSync(directory)
    const candidate = resolve(root, path)
    if (!inside(root, candidate)) return false
    const real = realpathWithMissingLeaf(candidate)
    if (!inside(root, real)) return false
    try {
      const stat = lstatSync(real)
      if (stat.isFile() && stat.nlink !== 1) return false
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    return scopes.some((scope) => inside(scope, candidate) && inside(scope, real))
  } catch {
    return false
  }
}

export class ScopeLockManager {
  #locks = new Map()
  #waiters = []

  #scopes(effect) {
    return effect.kind === "scoped-write" ? effect.writeScopes : effect.kind === "unknown-write" ? ["*"] : []
  }

  #mergeScopes(current = [], incoming = []) {
    if (current.includes("*") || incoming.includes("*")) return ["*"]
    return [...new Set([...current, ...incoming])].toSorted()
  }

  #parent(owner, scopes, parentLockID, { restoring = false } = {}) {
    const existing = this.#locks.get(owner)
    if (parentLockID !== undefined && (typeof parentLockID !== "string" || parentLockID.trim() === "")) {
      throw new Error(`Scope Lock 父锁不可用: ${owner}`)
    }
    if (existing && parentLockID !== undefined && existing.parentLockID !== parentLockID) {
      throw new Error(`Scope Lock 不得重新绑定父锁: ${owner}`)
    }
    const parentID = parentLockID ?? existing?.parentLockID
    if (parentID === undefined) return undefined
    const parent = this.#locks.get(parentID)
    if (parentID === owner || !parent) throw new Error(`Scope Lock 父锁不可用: ${owner}`)
    const ancestry = new Set([owner])
    for (let current = parentID; current !== undefined; current = this.#locks.get(current)?.parentLockID) {
      if (ancestry.has(current)) throw new Error(`Scope Lock 父锁存在循环: ${owner}`)
      if (!restoring && !this.#locks.get(current)?.owned) throw new Error(`Scope Lock 父锁不可用: ${owner}`)
      ancestry.add(current)
    }
    const merged = this.#mergeScopes(existing?.scopes, scopes)
    if (!parent.scopes.includes("*") && merged.some((scope) => scope === "*" || !parent.scopes.some((allowed) => inside(allowed, scope)))) {
      throw new Error(`Scope Lock 超出父锁范围: ${owner}`)
    }
    return parentID
  }

  #own(owner, scopes, parentLockID) {
    const lock = this.#locks.get(owner) ?? { scopes: [], owned: false, children: new Set(), parentLockID }
    lock.scopes = this.#mergeScopes(lock.scopes, scopes)
    lock.owned = true
    this.#locks.set(owner, lock)
    if (parentLockID !== undefined) this.#locks.get(parentLockID).children.add(owner)
  }

  #ancestors(parentLockID) {
    const ancestors = new Set()
    for (let current = parentLockID; current !== undefined; current = this.#locks.get(current)?.parentLockID) ancestors.add(current)
    return ancestors
  }

  #conflict(owner, scopes, parentLockID) {
    // Root readers own no writable scopes. Keep their authority node, but do
    // not serialize them behind writers; parented lock inheritance is unchanged.
    if (scopes.length === 0 && parentLockID === undefined) return undefined
    const ancestors = this.#ancestors(parentLockID)
    for (const [currentOwner, current] of this.#locks) {
      if (currentOwner === owner) continue
      if (ancestors.has(currentOwner) || this.#ancestors(current.parentLockID).has(owner)) continue
      const currentScopes = current.scopes
      // A root read has no write lock, but remains an authority node for children.
      if (currentScopes.length === 0 && current.parentLockID === undefined) continue
      if (scopes.includes("*") || currentScopes.includes("*") || scopes.some((left) => currentScopes.some((right) => overlaps(left, right)))) return currentOwner
    }
    return undefined
  }

  #drain() {
    for (let index = 0; index < this.#waiters.length;) {
      const waiter = this.#waiters[index]
      try {
        this.#parent(waiter.owner, waiter.scopes, waiter.parentLockID)
      } catch (error) {
        this.#waiters.splice(index, 1)
        waiter.cleanup()
        waiter.reject(error)
        continue
      }
      if (this.#conflict(waiter.owner, waiter.scopes, waiter.parentLockID)) {
        index += 1
        continue
      }
      this.#waiters.splice(index, 1)
      waiter.cleanup()
      this.#own(waiter.owner, waiter.scopes, waiter.parentLockID)
      waiter.resolve({ ok: true })
    }
  }

  async acquire(owner, effect, { signal, parentLockID } = {}) {
    const scopes = this.#scopes(effect)
    if (signal?.aborted) throw signal.reason ?? new Error("Scope Lock 等待已取消")
    parentLockID = this.#parent(owner, scopes, parentLockID)
    if (!this.#conflict(owner, scopes, parentLockID)) {
      this.#own(owner, scopes, parentLockID)
      return { ok: true }
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        owner,
        scopes,
        parentLockID,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      }
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        waiter.cleanup()
        rejectPromise(signal.reason ?? new Error("Scope Lock 等待已取消"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  restore(owner, effect, { allowConflict = false, parentLockID } = {}) {
    const scopes = this.#scopes(effect)
    parentLockID = this.#parent(owner, scopes, parentLockID, { restoring: true })
    const conflict = this.#conflict(owner, scopes, parentLockID)
    if (conflict && !allowConflict) throw new Error(`Scope Lock 恢复冲突: ${owner} 与 ${conflict}`)
    this.#own(owner, scopes, parentLockID)
    return { ok: true }
  }

  isUnknownWrite(owner) {
    const lock = this.#locks.get(owner)
    return lock?.owned === true && lock.scopes.includes("*")
  }

  has(owner) {
    return this.#locks.has(owner)
  }

  parentLockID(owner) {
    return this.#locks.get(owner)?.parentLockID
  }

  #dropUnowned(owner) {
    const lock = this.#locks.get(owner)
    if (!lock || lock.owned || lock.children.size > 0) return
    this.#locks.delete(owner)
    if (lock.parentLockID !== undefined) {
      this.#locks.get(lock.parentLockID)?.children.delete(owner)
      this.#dropUnowned(lock.parentLockID)
    }
  }

  release(owner) {
    const lock = this.#locks.get(owner)
    if (lock) {
      lock.owned = false
      this.#dropUnowned(owner)
    }
    this.#drain()
  }

  clear() {
    // Disposal is not evidence that nested Agents stopped.
    for (const [owner, lock] of this.#locks) {
      if (lock.parentLockID !== undefined) continue
      lock.owned = false
      this.#dropUnowned(owner)
    }
    const waiters = this.#waiters.splice(0)
    for (const waiter of waiters) {
      waiter.cleanup()
      waiter.reject(new Error("Scope Lock Manager 已释放"))
    }
  }
}

const SHARED_SCOPE_LOCKS = Symbol.for("opencode-for-everything.scope-lock-managers.v1")
const sharedScopeLocks = globalThis[SHARED_SCOPE_LOCKS] ??= new Map()

class SharedScopeLockManager {
  #key
  #state
  #owners = new Set()
  #abort = new AbortController()
  #closed = false

  constructor(key) {
    this.#key = canonicalDirectoryKey(key)
    this.#state = sharedScopeLocks.get(this.#key) ?? { manager: new ScopeLockManager(), facades: new Set(), owners: new Map() }
    this.#state.facades.add(this)
    sharedScopeLocks.set(this.#key, this.#state)
    for (const [owner, facades] of this.#state.owners) {
      for (const facade of facades) {
        if (!facade.#closed) continue
        this.#remember(owner)
        facade.#owners.delete(owner)
        facades.delete(facade)
      }
    }
  }

  async acquire(owner, effect, { signal, parentLockID } = {}) {
    const combined = signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal
    const result = await this.#state.manager.acquire(owner, effect, { signal: combined, parentLockID })
    if (this.#closed) {
      const successor = [...this.#state.facades].find((facade) => facade !== this && !facade.#closed)
      if (successor) successor.#remember(owner)
      else if (!this.#state.owners.has(owner)) this.#state.manager.release(owner)
    } else {
      this.#remember(owner)
    }
    return result
  }

  restore(owner, effect, options) {
    if (this.#closed) return { ok: false, closed: true }
    const result = this.#state.manager.restore(owner, effect, options)
    this.#remember(owner)
    return result
  }

  isUnknownWrite(owner) {
    return !this.#closed && this.#state.manager.isUnknownWrite(owner)
  }

  has(owner) {
    return this.#state.manager.has(owner)
  }

  parentLockID(owner) {
    return this.#state.manager.parentLockID(owner)
  }

  release(owner) {
    this.#owners.delete(owner)
    const facades = this.#state.owners.get(owner)
    facades?.delete(this)
    if (!facades || facades.size === 0) {
      this.#state.owners.delete(owner)
      this.#state.manager.release(owner)
    }
    this.#forgetEmptyState()
  }

  clear() {
    if (this.#closed) return
    this.#closed = true
    this.#abort.abort(new Error("Scope Lock Manager 已释放"))
    const successor = [...this.#state.facades].find((facade) => facade !== this && !facade.#closed)
    for (const owner of [...this.#owners]) {
      const facades = this.#state.owners.get(owner)
      if (facades?.size === 1 && facades.has(this)) {
        if (!successor && this.#state.manager.parentLockID(owner) !== undefined) continue
        successor?.#remember(owner)
      }
      this.release(owner)
    }
    this.#state.facades.delete(this)
    this.#forgetEmptyState()
  }

  #forgetEmptyState() {
    if (this.#state.facades.size === 0 && this.#state.owners.size === 0
      && sharedScopeLocks.get(this.#key) === this.#state) sharedScopeLocks.delete(this.#key)
  }

  #remember(owner) {
    this.#owners.add(owner)
    const facades = this.#state.owners.get(owner) ?? new Set()
    facades.add(this)
    this.#state.owners.set(owner, facades)
  }
}

export function createSharedScopeLockManager(key) {
  return new SharedScopeLockManager(key)
}

export function hashWriteScopes(scopes) {
  const hash = createHash("sha256")
  const visit = (path, relativePath = "") => {
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      hash.update(`missing\0${relativePath}\0`)
      return
    }
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${relativePath}\0`)
      return
    }
    if (stat.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`)
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry)
      return
    }
    if (stat.isFile()) {
      hash.update(`file\0${relativePath}\0${stat.mode}\0${stat.size}\0`)
      hash.update(readFileSync(path))
      return
    }
    hash.update(`other\0${relativePath}\0`)
  }
  for (const scope of [...scopes].sort()) visit(scope, scope)
  return hash.digest("hex")
}
