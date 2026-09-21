import { canonicalDirectoryKey } from "./directory-key.mjs"
import { serial } from "./serial.mjs"

export const O4E_METADATA_KEY = "o4e"
const RECOVERY_SESSION_LIMIT = 100_000
const UPDATE_QUEUES = Symbol.for("opencode-for-everything.session-store-update-queues.v1")
const sharedUpdateQueues = globalThis[UPDATE_QUEUES] ??= new Map()

function unwrap(result, operation) {
  if (result?.error) {
    const error = new Error(`${operation} 失败: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`)
    if (result.error && typeof result.error === "object" && typeof result.error.name === "string") error.name = result.error.name
    throw error
  }
  return result?.data ?? result
}

function sessionModelFields(model) {
  if (!model?.providerID || !model?.modelID) return {}
  return {
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(model.variant ? { variant: model.variant } : {}),
    },
  }
}

export class OpenCodeSessionStore {
  #client
  #directory
  #updates

  constructor(client, directory) {
    this.#client = client
    this.#directory = canonicalDirectoryKey(directory)
    this.#updates = sharedUpdateQueues.get(this.#directory) ?? new Map()
    sharedUpdateQueues.set(this.#directory, this.#updates)
  }

  async get(sessionID) {
    return unwrap(await this.#client.session.get({ path: { id: sessionID }, query: { directory: this.#directory } }), `读取 Session ${sessionID}`)
  }

  async list() {
    const session = this.#client?.session
    if (!session) return []
    if (typeof session.list !== "function") {
      const hasBackgroundSessionSurface = ["get", "create", "update", "status", "messages", "abort"]
        .some((method) => typeof session[method] === "function")
      if (hasBackgroundSessionSurface) throw new Error("OpenCode Session API 缺少 list，无法安全恢复 Background Task")
      return []
    }
    const sessions = unwrap(await this.#client.session.list({
      query: { directory: this.#directory, limit: RECOVERY_SESSION_LIMIT },
    }), "读取 Session 列表") ?? []
    if (!Array.isArray(sessions)) throw new Error("OpenCode Session list 返回了不支持的分页结构，无法安全恢复 Background Task")
    if (sessions.length >= RECOVERY_SESSION_LIMIT) {
      throw new Error(`OpenCode Session 数量达到恢复上限 ${RECOVERY_SESSION_LIMIT}，无法证明枚举完整`)
    }
    return sessions
  }

  async children(sessionID) {
    // Task execution Sessions share the host root so its native UI can present
    // their requests. Runtime ownership still follows the frozen logical parent.
    let hostParentID = sessionID
    const owner = await this.get(sessionID).catch((error) => {
      if (error?.name === "NotFoundError" || /404|not found|不存在/i.test(error?.message ?? "")) return null
      throw error
    })
    const belongsToOwner = (child) => {
      const state = sessionO4E(child)
      const logicalParent = state.kind === "delegation-attempt" && typeof state.delegation?.parentSessionID === "string"
        ? state.delegation.parentSessionID
        : child.parentID
      return logicalParent === sessionID
    }
    // A deleted logical owner no longer identifies its physical host root.
    // Enumerate only for this recovery boundary, then retain its own children.
    if (!owner?.id) return (await this.list()).filter(belongsToOwner)
    if (sessionO4E(owner).kind === "delegation-attempt") {
      let ancestor = owner
      const seen = new Set()
      while (ancestor.parentID !== undefined) {
        if (seen.has(ancestor.id) || typeof ancestor.parentID !== "string" || !ancestor.parentID) {
          throw new Error("Session 宿主父链不可验证")
        }
        seen.add(ancestor.id)
        const parentID = ancestor.parentID
        ancestor = await this.get(parentID)
        if (ancestor?.id !== parentID || (ancestor.directory !== undefined
          && canonicalDirectoryKey(ancestor.directory) !== this.#directory)) throw new Error("Session 宿主父链不可验证")
      }
      hostParentID = ancestor.id
    }
    const groups = await Promise.all([...new Set([hostParentID, sessionID])].map(async (id) => {
      const children = unwrap(await this.#client.session.children({ path: { id }, query: { directory: this.#directory } }), `读取 Session 子节点 ${sessionID}`) ?? []
      if (!Array.isArray(children)) throw new Error("Session 子节点列表不可验证")
      return children
    }))
    return [...new Map(groups.flat().map((child) => [child.id, child])).values()].filter(belongsToOwner)
  }

  async status() {
    return unwrap(await this.#client.session.status({ query: { directory: this.#directory } }), "读取 Session 状态") ?? {}
  }

  async messages(sessionID, limit) {
    return unwrap(await this.#client.session.messages({ path: { id: sessionID }, query: { directory: this.#directory, ...(limit ? { limit } : {}) } }), `读取 Session 消息 ${sessionID}`) ?? []
  }

  async messagePage(sessionID, { before, limit = 20, signal } = {}) {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20
      || (before !== undefined && (typeof before !== "string" || !before.length || before.length > 4096))) {
      throw new Error("invalid-message-page-request")
    }
    // The SDK decodes whole messages/parts before returning; limit bounds count, not wire bytes.
    const result = await this.#client.session.messages({
      path: { id: sessionID },
      query: { directory: this.#directory, limit, ...(before === undefined ? {} : { before }) },
      signal,
      responseStyle: "fields",
    })
    signal?.throwIfAborted()
    if (result?.error || result?.response?.ok === false) throw new Error("message-page-unavailable")
    const messages = result?.data
    if (!Array.isArray(messages) || messages.length > limit || typeof result?.response?.headers?.get !== "function") {
      throw new Error("invalid-message-page")
    }
    const nextCursor = result.response.headers.get("X-Next-Cursor") ?? undefined
    if (nextCursor !== undefined && (typeof nextCursor !== "string" || !nextCursor.length || nextCursor.length > 4096 || !messages.length)) {
      throw new Error("invalid-message-page")
    }
    return { messages, nextCursor }
  }

  async create({ parentID, title, agent, model, metadata, permission }) {
    return unwrap(await this.#client.session.create({
      query: { directory: this.#directory },
      body: {
        ...(parentID === undefined ? {} : { parentID }),
        title,
        ...(agent ? { agent } : {}),
        ...sessionModelFields(model),
        ...(metadata ? { metadata } : {}),
        ...(permission?.length ? { permission } : {}),
      },
    }), "创建 Session")
  }

  async updateO4E(sessionID, transform) {
    return serial(this.#updates, sessionID, async () => {
      const current = await this.get(sessionID)
      const metadata = current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata) ? current.metadata : {}
      const o4e = metadata[O4E_METADATA_KEY] && typeof metadata[O4E_METADATA_KEY] === "object" && !Array.isArray(metadata[O4E_METADATA_KEY])
        ? metadata[O4E_METADATA_KEY]
        : {}
      const nextO4E = transform(structuredClone(o4e), current)
      return unwrap(await this.#client.session.update({
        path: { id: sessionID },
        query: { directory: this.#directory },
        body: { metadata: { ...metadata, [O4E_METADATA_KEY]: nextO4E } },
      }), `更新 Session ${sessionID}`)
    })
  }


}

export function sessionO4E(session) {
  const metadata = session?.metadata
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata[O4E_METADATA_KEY] && typeof metadata[O4E_METADATA_KEY] === "object"
    ? metadata[O4E_METADATA_KEY]
    : {}
}
