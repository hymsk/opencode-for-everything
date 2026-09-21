import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeSessionStore } from "../src/runtime/session-store.mjs"

function fixture() {
  const sessions = new Map()
  const add = (id, parentID, owner, toolName = "task") => {
    sessions.set(id, { id, directory: process.cwd(), ...(parentID ? { parentID } : {}),
      ...(owner ? { metadata: { o4e: { kind: "delegation-attempt", delegation: { parentSessionID: owner, toolName } } } } : {}) })
  }
  const client = { session: {
    get: async ({ path }) => {
      if (!sessions.has(path.id)) throw Object.assign(new Error("not found"), { name: "NotFoundError" })
      return { data: structuredClone(sessions.get(path.id)) }
    },
    children: async ({ path }) => ({ data: [...sessions.values()].filter((entry) => entry.parentID === path.id) }),
    list: async () => ({ data: [...sessions.values()] }),
  } }
  return { sessions, add, client, store: new OpenCodeSessionStore(client, process.cwd()) }
}

test("Session children selects logical owners within flattened host Tasks and preserves Workflow children", async () => {
  const f = fixture()
  f.add("root")
  f.add("child", "root", "root")
  f.add("grandchild", "root", "child")
  f.sessions.set("command-ledger", { id: "command-ledger", metadata: { o4e: { task: { kind: "command", ownerSessionID: "child" } } } })
  f.add("next", "root", "grandchild")
  f.add("sibling", "root", "root")
  f.add("run", "root")
  f.add("step", "run", "run", "o4e_workflow")
  f.add("step-child", "root", "step")
  const ids = async (owner) => (await f.store.children(owner)).map((entry) => entry.id)
  assert.deepEqual(await ids("root"), ["child", "sibling", "run"])
  assert.deepEqual(await ids("child"), ["grandchild"])
  assert.deepEqual(await ids("grandchild"), ["next"])
  assert.deepEqual(await ids("run"), ["step"])
  assert.deepEqual(await ids("step"), ["step-child"])
  f.sessions.delete("child")
  assert.deepEqual(await ids("child"), ["grandchild"])
})

test("Session child enumeration propagates read failures and rejects invalid host ancestry", async () => {
  for (const issue of ["cycle", "missing ancestor", "wrong identity", "cross directory", "read failure"]) {
    const f = fixture()
    f.add("root")
    f.add("child", "root", "root")
    if (issue === "cycle") f.sessions.get("root").parentID = "child"
    if (issue === "missing ancestor") f.sessions.delete("root")
    if (issue === "wrong identity") f.sessions.get("root").id = "other"
    if (issue === "cross directory") f.sessions.get("root").directory = "/tmp"
    if (issue === "read failure") f.client.session.get = async () => { throw new Error("store offline") }
    await assert.rejects(f.store.children("child"), /不可验证|not found|store offline/, issue)
  }
})

test("Session creation omits native parentID when no host parent is requested", async () => {
  const calls = []
  const client = { session: {
    create: async (request) => { calls.push(request); return { data: { id: "root-ledger" } } },
  } }
  const store = new OpenCodeSessionStore(client, process.cwd())
  await store.create({ title: "Command root ledger" })
  assert.equal(Object.hasOwn(calls[0].body, "parentID"), false)
  assert.equal(calls[0].body.title, "Command root ledger")
})
