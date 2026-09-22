import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { CommandLedgerStore, commandLedgerPath, commandProjection } from "../src/runtime/command-ledger-store.mjs"
import { OpenCodeSessionStore, sessionO4E } from "../src/runtime/session-store.mjs"
import { projectTaskOverview, commandSource } from "../src/tui/task-overview.mjs"

const hash = (s) => createHash("sha256").update(s).digest("hex")
function ref(owner, sequence, output = "  preserved 中文\n") {
  const taskID = "o4e_command_" + randomUUID().replaceAll("-", "")
  const source = { sessionID: owner, messageID: `message-${sequence}`, callID: `call-${sequence}` }
  return { taskSessionID: owner, callKey: hash(JSON.stringify(Object.values(source))), claim: "claim",
    recovery: { version: 1, revision: 3, sequence, taskID, kind: "command", ownerSessionID: owner,
      taskSessionID: owner, requesterAgent: "build", source, commandHash: hash("printf test"),
      cwd: "/tmp", timeout: 1000, descriptionHash: hash("test"), executionID: taskID,
      status: "completed", phase: "stopped", claim: "claim", stopped: true, lockOwner: taskID,
      result: { status: "completed", stopped: true, exitCode: 0, output, totalBytes: Buffer.byteLength(output), truncated: false } } }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "o4e-ledger-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = new Map(["owner", "other"].map((id) => [id, { id, metadata: { user: "keep", o4e: { unrelated: { value: true } } } }]))
  const f = { root, sessions, writes: [], failProjection: false }
  const host = new OpenCodeSessionStore({ session: {
    get: async ({ path }) => ({ data: structuredClone(sessions.get(path.id)) }),
    update: async ({ path, body }) => {
      if (f.failProjection) throw new Error("host unavailable")
      f.writes.push(structuredClone(body))
      sessions.set(path.id, { ...sessions.get(path.id), ...structuredClone(body) })
      return { data: structuredClone(sessions.get(path.id)) }
    },
  } }, root)
  return Object.assign(f, { host, store: new CommandLedgerStore(host, root, { root: join(root, "ledger") }),
    path: commandLedgerPath(root, join(root, "ledger")) })
}
const put = (store, owner, refs) => store.updateO4E(owner, (state) => ({ ...state,
  commandTasks: { version: 1, refs: { ...state.commandTasks.refs, ...Object.fromEntries(refs.map((r) => [r.recovery.taskID, r])) } } }))

test("Command SQLite persists exact output across processes; host summaries retain navigation without output", async (t) => {
  const f = fixture(t)
  const r = ref("owner", 1)
  await put(f.store, "owner", [r])
  const projection = f.sessions.get("owner")
  assert.equal(projection.metadata.user, "keep")
  assert.deepEqual(projection.metadata.o4e.unrelated, { value: true })
  assert.equal(projection.metadata.o4e.commandTasks.version, 2)
  assert.equal(JSON.stringify(projection).includes(r.recovery.result.output), false)
  assert.equal(Object.hasOwn(projection.metadata.o4e.commandTasks.refs[r.recovery.taskID], "recovery"), false)
  const view = projectTaskOverview({ sessionID: "owner", getSession: (id) => f.sessions.get(id) })
  assert.equal(view.groups[0].rows[0].status, "completed")
  assert.equal(view.groups[0].rows[0].exitCode, 0)
  assert.equal(commandSource({ sessionID: "owner", taskID: r.recovery.taskID, getSession: (id) => f.sessions.get(id) }).commandHash, r.recovery.commandHash)
  const saved = join(f.root, "owner.json")
  writeFileSync(saved, JSON.stringify(projection))
  const code = `import {readFileSync} from 'node:fs'; import {CommandLedgerStore} from ${JSON.stringify(new URL("../src/runtime/command-ledger-store.mjs", import.meta.url).href)};
    const host={get:async()=>JSON.parse(readFileSync(process.argv[1],'utf8'))};
    const store=new CommandLedgerStore(host,process.argv[2],{root:process.argv[3]});
    process.stdout.write(JSON.stringify((await store.get('owner')).metadata.o4e.commandTasks.refs));`
  const reloaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, saved, f.root, join(f.root, "ledger")], { encoding: "utf8" }))
  assert.deepEqual(reloaded, { [r.recovery.taskID]: r })
  if (process.platform !== "win32") assert.equal(statSync(f.path).mode & 0o777, 0o600)
})

test("Command commits survive failed host projection; directed publication repairs summaries and diagnostics", async (t) => {
  const f = fixture(t)
  const r = ref("owner", 1)
  f.failProjection = true
  await put(f.store, "owner", [r])
  assert.equal(f.sessions.get("owner").metadata.o4e.commandTasks, undefined)
  assert.equal(f.store.diagnostic("owner"), "O4E_COMMAND_PROJECTION_UNAVAILABLE")
  assert.deepEqual(sessionO4E(await f.store.get("owner")).commandTasks.refs[r.recovery.taskID], r)
  f.failProjection = false
  await f.store.publish("owner")
  assert.equal(f.store.diagnostic("owner"), undefined)
  assert.deepEqual(f.sessions.get("owner").metadata.o4e.commandTasks, commandProjection({ [r.recovery.taskID]: r }))
})

test("Command database rejects public permissions and final symlinks, but accepts OS symlink ancestors", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const r = ref("owner", 1)
  await put(f.store, "owner", [r])
  chmodSync(f.path, 0o644)
  await assert.rejects(f.store.get("owner"), /UNTRUSTED_PATH/)
  chmodSync(f.path, 0o600)
  const realParent = join(f.root, "real")
  mkdirSync(realParent)
  const alias = join(f.root, "alias")
  symlinkSync(realParent, alias, "dir")
  const other = new CommandLedgerStore(f.host, f.root, { root: join(alias, "private-ledger") })
  // The host already references r, so copying cannot be inferred from its UI.
  f.sessions.get("owner").metadata.o4e.commandTasks = undefined
  await put(other, "owner", [r])
  assert.deepEqual(sessionO4E(await other.get("owner")).commandTasks.refs[r.recovery.taskID], r)
  const linkRoot = join(f.root, "linked-ledger")
  mkdirSync(linkRoot, { mode: 0o700 })
  symlinkSync(f.path, commandLedgerPath(f.root, linkRoot))
  const linked = new CommandLedgerStore(f.host, f.root, { root: linkRoot })
  await assert.rejects(linked.get("owner"), /UNTRUSTED_PATH/)
})

test("Command store refuses old recovery indexes and missing databases without reconstructing from UI", async (t) => {
  const f = fixture(t)
  f.sessions.get("owner").metadata.o4e.commandTasks = { version: 1, refs: {} }
  await assert.rejects(f.store.get("owner"), /UNSUPPORTED_INDEX/)
  delete f.sessions.get("owner").metadata.o4e.commandTasks
  const r = ref("owner", 1)
  await put(f.store, "owner", [r])
  rmSync(f.path)
  await assert.rejects(f.store.get("owner"), /MISSING_LEDGER/)
  await assert.rejects(put(f.store, "owner", [r]), /MISSING_LEDGER/)
})

test("Command transaction rolls back invalid/cross-owner records and preserves existing rows", async (t) => {
  const f = fixture(t)
  const first = ref("owner", 1)
  await put(f.store, "owner", [first])
  const second = ref("owner", 2)
  await assert.rejects(put(f.store, "owner", [second, ref("other", 3)]), /INVALID_LEDGER/)
  assert.deepEqual(Object.keys(sessionO4E(await f.store.get("owner")).commandTasks.refs), [first.recovery.taskID])
  assert.equal(sessionO4E(await f.store.get("other")).commandTasks, undefined)
  const db = new DatabaseSync(f.path)
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  db.close()
})

test("independent facades preserve both commands; unchanged recovery emits no host update", async (t) => {
  const f = fixture(t)
  const other = new CommandLedgerStore(f.host, f.root, { root: join(f.root, "ledger") })
  await Promise.all([put(f.store, "owner", [ref("owner", 1)]), put(other, "owner", [ref("owner", 2)])])
  assert.equal(Object.keys(sessionO4E(await f.store.get("owner")).commandTasks.refs).length, 2)
  const writes = f.writes.length
  await f.store.publish("owner")
  await other.updateO4E("owner", (state) => state)
  assert.equal(f.writes.length, writes, "identical host event snapshots are suppressed")
  await assert.rejects(other.updateO4E("owner", () => { throw new Error("CAS rejected") }), /CAS rejected|UNAVAILABLE/)
  assert.equal(f.writes.length, writes)
})

test("large retained outputs stay in per-task rows; changing one task does not rewrite sibling rows", async (t) => {
  const f = fixture(t)
  const refs = Array.from({ length: 16 }, (_, i) => ref("owner", i + 1, "x".repeat(60 * 1024)))
  await put(f.store, "owner", refs)
  const canonicalBytes = Buffer.byteLength(JSON.stringify({ version: 1, refs: Object.fromEntries(refs.map((r) => [r.recovery.taskID, r])) }))
  const summaryBytes = Buffer.byteLength(JSON.stringify(f.sessions.get("owner").metadata.o4e.commandTasks))
  assert.ok(summaryBytes / canonicalBytes < 0.02, "representative 60KiB outputs remove >98% of command metadata bytes")
  const db = new DatabaseSync(f.path)
  db.exec("CREATE TABLE touched(id TEXT); CREATE TRIGGER count_updates AFTER UPDATE ON commands BEGIN INSERT INTO touched VALUES(new.id); END")
  refs[0].recovery.revision++
  await put(f.store, "owner", [refs[0]])
  assert.deepEqual(db.prepare("SELECT id FROM touched").all().map((r) => r.id), [refs[0].recovery.taskID])
  db.close()
})
