import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { canonicalDirectoryKey } from "./directory-key.mjs"
import { serial } from "./serial.mjs"
import { sessionO4E } from "./session-store.mjs"
import { validateCommandRef } from "./command-task-runtime.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const failure = (code) => Object.assign(new Error(`O4E_COMMAND_STORAGE_${code}`), { code: `O4E_COMMAND_STORAGE_${code}` })
const queues = globalThis[Symbol.for("opencode-for-everything.command-ledger-queues.v1")] ??= new Map()
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
let databaseConstructor
async function sqlite() {
  databaseConstructor ??= typeof globalThis.Bun !== "undefined"
    ? import("bun:sqlite").then((module) => module.Database)
    : import("node:sqlite").then((module) => module.DatabaseSync)
  return databaseConstructor
}

export function commandLedgerPath(directory, root) {
  const dataHome = process.platform === "win32"
    ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const base = root ?? join(dataHome, "opencode-for-everything", "command-ledgers")
  if (!isAbsolute(base) || base.includes("\0")) throw failure("INVALID_PATH")
  return join(base, `${hash(canonicalDirectoryKey(directory))}.sqlite`)
}

function privatePath(path, directory) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw failure("UNTRUSTED_PATH")
}

function prepare(path) {
  const parent = join(path, "..")
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  privatePath(parent, true)
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)) }
  catch (error) { if (error.code !== "EEXIST") throw error }
  privatePath(path, false)
  for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(path + suffix)) privatePath(path + suffix, false)
}

// Only display fields enter the host event stream. This is not an execution or
// authorization record, and must never be used to rebuild the canonical ledger.
export function commandProjection(refs) {
  return { version: 2, refs: Object.fromEntries(Object.entries(refs).map(([id, ref]) => {
    const r = ref.recovery
    const snapshot = Object.fromEntries(["version", "revision", "sequence", "taskID", "kind", "ownerSessionID", "taskSessionID",
      "source", "commandHash", "status", "phase", "claim", "stopped"].map((key) => [key, r[key]]))
    if (r.result) snapshot.result = { status: r.result.status, stopped: r.result.stopped,
      ...(r.result.exitCode === undefined ? {} : { exitCode: r.result.exitCode }) }
    return [id, { taskSessionID: ref.taskSessionID, callKey: ref.callKey, claim: ref.claim, snapshot }]
  })) }
}

/** Command-only storage port. Session get/updateO4E here are an internal Runtime
 * view, not host persistence. Canonical refs are separate SQLite rows; only
 * changed rows are written. Agent metadata always remains in the host store.
 * root is a test/embedding seam, never model input or a path read from metadata.
 */
export class CommandLedgerStore {
  #host
  #path
  #directory
  #queue
  #projectionFailures = new Set()
  #connect
  constructor(host, directory, { root, connect } = {}) {
    this.#host = host
    this.#directory = canonicalDirectoryKey(directory)
    this.#path = commandLedgerPath(directory, root)
    this.#connect = connect
    this.#queue = queues.get(this.#path) ?? new Map()
    queues.set(this.#path, this.#queue)
  }

  async #database(operation, { create = false } = {}) {
    if (!create && !existsSync(this.#path)) return operation(undefined)
    const Database = await sqlite()
    prepare(this.#path)
    const db = this.#connect ? await this.#connect(this.#path) : new Database(this.#path)
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
      if (create) {
        db.exec("CREATE TABLE IF NOT EXISTS identity(version INTEGER NOT NULL, directory TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(owner TEXT NOT NULL, id TEXT NOT NULL, call_key TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(owner,id), UNIQUE(owner,call_key))")
        db.prepare("INSERT INTO identity SELECT 1, ? WHERE NOT EXISTS(SELECT 1 FROM identity)").run(this.#directory)
      }
      const identity = db.prepare("SELECT version,directory FROM identity").all()
      if (identity.length !== 1 || identity[0].version !== 1 || identity[0].directory !== this.#directory) throw failure("INVALID_IDENTITY")
      return operation(db)
    } catch (error) {
      if (error?.code?.startsWith("O4E_COMMAND_")) throw error
      throw failure("UNAVAILABLE")
    } finally { db.close() }
  }

  #rows(db, owner) {
    const refs = {}
    for (const row of db?.prepare("SELECT id,call_key,ref FROM commands WHERE owner=?").all(owner) ?? []) {
      const ref = JSON.parse(row.ref)
      validateCommandRef(ref, owner, row.id)
      if (ref.callKey !== row.call_key) throw failure("INVALID_RECORD")
      refs[row.id] = ref
    }
    return refs
  }

  #checkHost(session, owner, refs) {
    if (session?.id !== owner) throw failure("OWNER_MISMATCH")
    const index = sessionO4E(session).commandTasks
    if (index !== undefined && (!object(index) || index.version !== 2 || !object(index.refs))) throw failure("UNSUPPORTED_INDEX")
    // A missing canonical row can never be resurrected from a UI snapshot.
    if (index && Object.keys(index.refs).some((id) => !Object.hasOwn(refs, id))) throw failure("MISSING_LEDGER")
  }

  #view(session, refs) {
    return { ...session, metadata: { ...session.metadata, o4e: { ...sessionO4E(session), commandTasks: { version: 1, refs } } } }
  }

  async get(owner) {
    const session = await this.#host.get(owner)
    return this.#database((db) => {
      const refs = this.#rows(db, owner)
      this.#checkHost(session, owner, refs)
      if (!Object.keys(refs).length && sessionO4E(session).commandTasks === undefined) return session
      return this.#view(session, refs)
    })
  }

  async hasOwner(owner) {
    return this.#database((db) => Boolean(db?.prepare("SELECT 1 FROM commands WHERE owner=? LIMIT 1").get(owner)))
  }

  async #publish(owner, refs) {
    if (!Object.keys(refs).length) return
    const projection = commandProjection(refs)
    // Projection loss is repairable; it is never evidence of a failed canonical
    // commit. New tool reads/recovery republish it from verified SQLite rows.
    try {
      const saved = await this.#host.updateO4E(owner, (state, session) => {
        this.#checkHost(session, owner, refs)
        return { ...state, commandTasks: projection }
      })
      if (!isDeepStrictEqual(sessionO4E(saved).commandTasks, projection)) throw failure("PROJECTION_UNCONFIRMED")
      this.#projectionFailures.delete(owner)
    } catch { this.#projectionFailures.add(owner) }
  }

  diagnostic(owner) { return this.#projectionFailures.has(owner) ? "O4E_COMMAND_PROJECTION_UNAVAILABLE" : undefined }

  messagePage(owner, options) { return this.#host.messagePage(owner, options) }

  async publish(owner) {
    return serial(this.#queue, owner, async () => {
      const session = await this.get(owner)
      await this.#publish(owner, sessionO4E(session).commandTasks?.refs ?? {})
    })
  }

  async updateO4E(owner, transform) {
    return serial(this.#queue, owner, async () => {
      const session = await this.#host.get(owner)
      const saved = await this.#database((db) => {
        db.exec("BEGIN IMMEDIATE")
        try {
          const before = this.#rows(db, owner)
          this.#checkHost(session, owner, before)
          const view = this.#view(session, before)
          const next = transform(structuredClone(sessionO4E(view)), view)
          const refs = next?.commandTasks?.refs
          if (next?.commandTasks?.version !== 1 || !object(refs)
            || !isDeepStrictEqual({ ...next, commandTasks: undefined }, { ...sessionO4E(view), commandTasks: undefined })
            || Object.keys(before).some((id) => !Object.hasOwn(refs, id))) throw failure("INVALID_MUTATION")
          for (const [id, ref] of Object.entries(refs)) {
            validateCommandRef(ref, owner, id)
            if (isDeepStrictEqual(ref, before[id])) continue
            db.prepare("INSERT INTO commands(owner,id,call_key,ref) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET call_key=excluded.call_key,ref=excluded.ref")
              .run(owner, id, ref.callKey, JSON.stringify(ref))
          }
          db.exec("COMMIT")
          return this.#view(session, refs)
        } catch (error) { db.exec("ROLLBACK"); throw error }
      }, { create: true })
      await this.#publish(owner, sessionO4E(saved).commandTasks.refs)
      return saved
    })
  }
}
