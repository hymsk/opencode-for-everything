// Public V2 Session API only. This proves physical ancestry, NOT inherited
// authority or ownership of a same-named Agent definition.
export async function readV2SessionAncestry({ sessionID, getSession, maxDepth }) {
  if (typeof sessionID !== "string" || !sessionID || typeof getSession !== "function"
    || !Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error("O4E_V2_ANCESTRY_INPUT_INVALID")
  const seen = new Set()
  const lineage = []
  let id = sessionID
  for (;;) {
    if (seen.has(id)) throw new Error("O4E_V2_ANCESTRY_CYCLE")
    seen.add(id)
    // API failures propagate; never treat a missing/failed parent as a root.
    const response = await getSession({ sessionID: id })
    const session = response?.data ?? response
    if (!session || session.id !== id || typeof session.agent !== "string" || !session.agent
      || (session.parentID !== undefined && (typeof session.parentID !== "string" || !session.parentID))) {
      throw new Error("O4E_V2_ANCESTRY_UNVERIFIABLE")
    }
    lineage.push(Object.freeze({ sessionID: id, agent: session.agent }))
    if (session.parentID === undefined) return Object.freeze(lineage)
    if (lineage.length > maxDepth) throw new Error("O4E_V2_ANCESTRY_DEPTH_EXCEEDED")
    id = session.parentID
  }
}
