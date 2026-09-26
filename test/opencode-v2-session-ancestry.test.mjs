import assert from "node:assert/strict"
import test from "node:test"
import { readV2SessionAncestry } from "../src/adapters/opencode-v2/session-ancestry.mjs"

const sessions = {
  child: { id: "child", agent: "worker", parentID: "parent" },
  parent: { id: "parent", agent: "reviewer", parentID: "root" },
  root: { id: "root", agent: "main" },
}
const getSession = async ({ sessionID }) => ({ data: sessions[sessionID] })

test("bounded public Session ancestry returns child-to-root identity without inferring policy", async () => {
  const result = await readV2SessionAncestry({ sessionID: "child", getSession, maxDepth: 2 })
  assert.deepEqual(result, [
    { sessionID: "child", agent: "worker" }, { sessionID: "parent", agent: "reviewer" }, { sessionID: "root", agent: "main" },
  ])
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(await readV2SessionAncestry({ sessionID: "root", getSession, maxDepth: 0 }), [{ sessionID: "root", agent: "main" }])
})

test("ancestry refuses excess depth, cycles, mismatched IDs, absent identity, and failed reads", async () => {
  const run = (reader, maxDepth = 2) => readV2SessionAncestry({ sessionID: "child", getSession: reader, maxDepth })
  await assert.rejects(run(getSession, 1), /DEPTH_EXCEEDED/)
  await assert.rejects(run(async ({ sessionID }) => ({ ...sessions[sessionID], ...(sessionID === "root" ? { parentID: "child" } : {}) }), 3), /CYCLE/)
  await assert.rejects(run(async ({ sessionID }) => ({ ...sessions[sessionID], id: "foreign" })), /UNVERIFIABLE/)
  await assert.rejects(run(async ({ sessionID }) => ({ ...sessions[sessionID], agent: "" })), /UNVERIFIABLE/)
  await assert.rejects(run(async ({ sessionID }) => sessionID === "parent" ? undefined : sessions[sessionID]), /UNVERIFIABLE/)
  await assert.rejects(run(async ({ sessionID }) => { if (sessionID === "parent") throw new Error("read failed"); return sessions[sessionID] }), /read failed/)
  await assert.rejects(run(getSession, -1), /INPUT_INVALID/)
})
