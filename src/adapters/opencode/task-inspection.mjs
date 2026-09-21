import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { dispatchRelatedUserIDs } from "./agent-execution-port.mjs"

const digest = (value) => createHash("sha256").update(value).digest("base64url").slice(0, 32)
const CURSOR_TAG = 2
const CURSOR_DIGEST_BYTES = 24
const CURSOR_MAX_LENGTH = 120
const validID = (value) => typeof value === "string" && value.length > 0
const publicValue = (value) => !value?.synthetic && !value?.ignored && !value?.private
  && (value?.visibility === undefined || value.visibility === "public")
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const safeBytes = (value, maximum) => Buffer.byteLength(value) <= maximum
const unsafePathSegment = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*(?:^|[._-])(?:secret|secrets|token|tokens|password|passwd|credential|credentials|api[._-]?key|private[._-]?key|access[._-]?key)(?:[._-]|$).*)$/i
const unsafePatternWord = /(?:^|[^A-Za-z0-9])(?:secret|secrets|token|tokens|password|passwd|credential|credentials|authorization|bearer|cookie|api[._-]?key|private[._-]?key|access[._-]?key)(?:[^A-Za-z0-9]|$)/i
const unsafeOpaqueSecret = /(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{16,}|A(?:KI|SI)A[A-Z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{20,})/i

function safeWorkspacePath(value, directory) {
  if (typeof value !== "string" || !value || value !== value.trim() || !safeBytes(value, 512)
    || /[\u0000-\u001f\u007f\\?#=&]/u.test(value) || /%[0-9A-Fa-f]{2}/u.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || typeof directory !== "string" || !isAbsolute(directory)) return undefined
  let projected
  try {
    const root = resolve(directory)
    const target = resolve(root, value)
    const inside = relative(root, target)
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined
    projected = (inside || ".").split(sep).join("/")
  } catch {
    return undefined
  }
  if (!safeBytes(projected, 240) || unsafeOpaqueSecret.test(projected)
    || projected.split("/").some((segment) => unsafePathSegment.test(segment) || /[A-Za-z0-9_-]{40,}/u.test(segment))) return undefined
  return projected
}

function safePattern(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || !safeBytes(value, 96)
    || /[\u0000-\u001f\u007f\s:=&#'"`]/u.test(value) || /:\/\//u.test(value)
    || unsafePatternWord.test(value) || unsafeOpaqueSecret.test(value) || /[A-Za-z0-9_-]{25,}/u.test(value)
    || !/^[A-Za-z0-9_./*?{}[\]()+^$|\\,!-]+$/u.test(value)) return undefined
  return value
}

function toolSummary(tool, part, directory) {
  try {
    const state = publicValue(part.state) ? part.state : undefined
    const input = plainObject(state?.input) ? state.input : undefined
    if (!input) return ""
    if (tool === "read") {
      const filePath = safeWorkspacePath(input.filePath, directory)
      return filePath === undefined ? "" : ` file=${JSON.stringify(filePath)}`
    }
    if (tool === "glob" || tool === "grep") {
      const path = safeWorkspacePath(input.path, directory)
      const pattern = safePattern(input.pattern)
      const fields = [
        ...(path === undefined ? [] : [`path=${JSON.stringify(path)}`]),
        ...(pattern === undefined ? [] : [`pattern=${JSON.stringify(pattern)}`]),
      ]
      return fields.length ? ` ${fields.join(" ")}` : ""
    }
  } catch {
    // A malformed or accessor-backed input cannot make inspection expose or fail.
  }
  return ""
}

function hasPublicProjection(message) {
  const info = message?.info
  if (info?.role !== "assistant" || info.summary || info.mode === "compaction" || !publicValue(info)) return false
  return message.parts.some((part) => part && publicValue(part)
    && ((part.type === "text" && typeof part.text === "string" && part.text.length > 0) || part.type === "tool"))
}

function project(message, directory) {
  const info = message.info
  if (info.role !== "assistant" || info.summary || info.mode === "compaction" || !publicValue(info)) return undefined
  const texts = []
  const layout = []
  let length = 0
  for (const [index, part] of message.parts.entries()) {
    if (!part || !publicValue(part)) continue
    let text
    if (part.type === "text" && typeof part.text === "string") text = part.text
    if (part.type === "tool") {
      const name = typeof part.tool === "string" ? part.tool.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, "_") : "tool"
      const state = publicValue(part.state) ? part.state : undefined
      const status = ["pending", "running", "completed", "error"].includes(state?.status) ? state.status : "unknown"
      text = `[tool ${name || "tool"}${toolSummary(name, part, directory)}: ${status}]`
    }
    if (!text) continue
    if (texts.length) length += 1
    layout.push([length, digest(JSON.stringify([part.id ?? index, part.type]))])
    texts.push(text)
    length += Buffer.byteLength(text)
  }
  return {
    key: digest(JSON.stringify([info.id, info.parentID])),
    bytes: Buffer.from(texts.join("\n")),
    layout,
  }
}

function signature(source, length) {
  return digest(Buffer.concat([
    Buffer.from(JSON.stringify(source.layout.filter(([start]) => start < length))),
    source.bytes.subarray(0, length),
  ]))
}

const boundary = (bytes, offset) => offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80

function encodeUnsigned(value) {
  let remaining = BigInt(value)
  const bytes = []
  do {
    let byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    if (remaining) byte |= 0x80
    bytes.push(byte)
  } while (remaining)
  return Buffer.from(bytes)
}

function decodeUnsigned(bytes, start) {
  let value = 0n
  let shift = 0n
  let index = start
  for (; index < bytes.length && index - start < 8; index += 1) {
    const byte = bytes[index]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("unsigned integer overflow")
      const decoded = Number(value)
      const encoded = encodeUnsigned(decoded)
      if (!bytes.subarray(start, index + 1).equals(encoded)) throw new Error("noncanonical unsigned integer")
      return { value: decoded, next: index + 1 }
    }
    shift += 7n
  }
  throw new Error("invalid unsigned integer")
}

function encodeCursor(identity, source, offset) {
  return Buffer.concat([
    Buffer.from([CURSOR_TAG]),
    Buffer.from(identity, "base64url"),
    Buffer.from(source.key, "base64url"),
    encodeUnsigned(offset),
    encodeUnsigned(source.bytes.length),
    Buffer.from(signature(source, source.bytes.length), "base64url"),
  ]).toString("base64url")
}

function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid cursor")
  const bytes = Buffer.from(cursor, "base64url")
  if (bytes.toString("base64url") !== cursor) throw new Error("invalid cursor")
  if (bytes[0] !== CURSOR_TAG || bytes.length < 1 + CURSOR_DIGEST_BYTES * 3 + 2) throw new Error("invalid cursor")
  let index = 1
  const identity = bytes.subarray(index, index += CURSOR_DIGEST_BYTES).toString("base64url")
  const sourceKey = bytes.subarray(index, index += CURSOR_DIGEST_BYTES).toString("base64url")
  const offset = decodeUnsigned(bytes, index)
  index = offset.next
  const snapshotLength = decodeUnsigned(bytes, index)
  index = snapshotLength.next
  if (bytes.length - index !== CURSOR_DIGEST_BYTES || offset.value > snapshotLength.value) throw new Error("invalid cursor")
  const snapshotSignature = bytes.subarray(index).toString("base64url")
  return [CURSOR_TAG, identity, sourceKey, offset.value, snapshotLength.value, snapshotSignature]
}

/**
 * Read-only, stateless preview of one canonical Agent Task execution. Text parts
 * within a message are newline-separated; message bodies are concatenated in
 * host chronological order. Tool labels contain only name/status and optional
 * bounded allowlisted workspace-relative read/glob/grep summaries, never output
 * or hidden metadata.
 * cursor is the exclusive end, beforeCursor the start; pass either back with the
 * desired direction. Without a cursor, return the recent tail (either direction).
 * Compact cursors are at most 120 ASCII bytes. They bind
 * execution, message, UTF-8 offset and a public message snapshot prefix, allowing
 * append but rejecting edits to that snapshot.
 * Each call starts at the newest page and reads at most 5 x 20 messages. These are
 * not authenticated capabilities or session snapshots: callers authorize records;
 * unavailable old sources/lineage fail closed. SDK payload bytes, part counts and
 * per-message projection memory are not bounded by the returned body byte budget.
 */
export async function readTaskInspection({ store, record, directory, cursor, direction = "forward", maxBytes = 1024, signal }) {
  if (signal?.aborted) return { unavailable: "aborted" }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 8192) return { unavailable: "invalid-max-bytes" }
  if (!["forward", "backward"].includes(direction)) return { unavailable: "invalid-direction" }
  if (record?.kind !== "agent") return { unavailable: "unsupported-kind" }
  if (![record.taskID, record.childSessionID, record.dispatchMessageID].every(validID)
    || ![record.runGeneration, record.attemptNumber].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { unavailable: "invalid-record" }
  }
  const identity = digest(JSON.stringify([record.taskID, record.childSessionID, record.dispatchMessageID, record.runGeneration, record.attemptNumber]))
  let position
  if (cursor !== undefined) {
    try {
      position = decodeCursor(cursor)
    } catch {
      return { gap: "invalid-cursor" }
    }
    if (position[1] !== identity) return { gap: "execution-changed" }
  }
  let messages = []
  let before
  const seenMessages = new Set()
  const seenPages = new Set()
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    if (signal?.aborted) return { unavailable: "aborted" }
    let page
    try {
      page = await store.messagePage(record.childSessionID, { before, limit: 20, signal })
    } catch {
      return { unavailable: signal?.aborted ? "aborted" : "page-unavailable" }
    }
    if (signal?.aborted) return { unavailable: "aborted" }
    if (page.nextCursor !== undefined && seenPages.has(page.nextCursor)) return { gap: "pagination-changed" }
    seenPages.add(page.nextCursor)
    for (const message of page.messages) {
      if (!validID(message?.info?.id) || !Array.isArray(message.parts)
        || (message.info.sessionID !== undefined && message.info.sessionID !== record.childSessionID)) return { unavailable: "invalid-page" }
      if (seenMessages.has(message.info.id)) return { gap: "pagination-changed" }
      seenMessages.add(message.info.id)
    }
    // Pages are chronological internally, but before/X-Next-Cursor walks older pages.
    messages = [...page.messages, ...messages]
    const related = dispatchRelatedUserIDs(messages, record.dispatchMessageID)
    const users = new Map(messages.filter((message) => message.info.role === "user").map((message) => [message.info.id, message]))
    const dispatchSeen = users.has(record.dispatchMessageID)
    const sources = []
    let unresolved = false
    const lastRelated = messages.findLastIndex((message) => message.info.role === "assistant" && related.has(message.info.parentID))
    for (const [messageIndex, message] of messages.entries()) {
      if (signal?.aborted) return { unavailable: "aborted" }
      if (related.has(message.info.parentID)) {
        const source = project(message, directory)
        if (source) sources.push(source)
      } else if (hasPublicProjection(message)) {
        const parent = users.get(message.info.parentID)
        const continuation = parent?.parts.some((part) => part?.metadata?.compaction_continue === true)
        if (messageIndex > lastRelated && (continuation || !parent)) unresolved = true
      }
    }
    const sourceIndex = position ? sources.findIndex((source) => source.key === position[2]) : sources.length - 1
    const source = sources[sourceIndex]
    if (position && source && (position[4] > source.bytes.length || !boundary(source.bytes, position[3])
      || !boundary(source.bytes, position[4]) || signature(source, position[4]) !== position[5])) return { gap: "source-changed" }

    const exhausted = page.nextCursor === undefined || dispatchSeen
    const capped = pageNumber === 4
    if ((!source || unresolved) && !exhausted && !capped) {
      before = page.nextCursor
      continue
    }
    if (unresolved) return { gap: "lineage-unverified" }
    if (!source) {
      if (position) return { gap: "source-missing" }
      if (!dispatchSeen) return { unavailable: capped && !exhausted ? "page-limit" : "lineage-unverified" }
      return { unchanged: true }
    }

    const backwards = !position || direction === "backward"
    let index = sourceIndex
    let offset = position ? position[3] : source.bytes.length
    const chunks = []
    let remaining = maxBytes
    let start = [index, offset]
    let end = [index, offset]
    while (index >= 0 && index < sources.length && remaining > 0) {
      if (signal?.aborted) return { unavailable: "aborted" }
      const bytes = sources[index].bytes
      let edge = backwards ? Math.max(0, offset - remaining) : Math.min(bytes.length, offset + remaining)
      while (!boundary(bytes, edge)) edge += backwards ? 1 : -1
      const chunk = backwards ? bytes.subarray(edge, offset) : bytes.subarray(offset, edge)
      if (backwards) { chunks.unshift(chunk); start = [index, edge] }
      else { chunks.push(chunk); end = [index, edge] }
      remaining -= chunk.length
      if (backwards ? edge > 0 : edge < bytes.length) break
      index += backwards ? -1 : 1
      if (index >= 0 && index < sources.length) offset = backwards ? sources[index].bytes.length : 0
    }
    const hasEarlier = start[1] > 0 || sources.slice(0, start[0]).some((entry) => entry.bytes.length > 0)
    // A host cursor proves older messages, not earlier public bytes.
    if (!hasEarlier && !exhausted && !capped) {
      before = page.nextCursor
      continue
    }
    const encode = ([index, offset]) => {
      const source = sources[index]
      return encodeCursor(identity, source, offset)
    }
    const tail = Buffer.concat(chunks).toString("utf8")
    return {
      ...(tail ? { tail } : { unchanged: true }),
      cursor: encode(end),
      ...(hasEarlier ? { beforeCursor: encode(start) } : {}),
      ...(!hasEarlier && capped && !exhausted ? { gap: "page-limit" } : {}),
    }
  }
}
