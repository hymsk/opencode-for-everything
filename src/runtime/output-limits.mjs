import { StringDecoder } from "node:string_decoder"

/**
 * Output budgets shared by command capture, the native Shell card and the
 * model-facing task adapters.  These are byte budgets unless named otherwise.
 */
export const OUTPUT_LIMITS = Object.freeze({
  executionViewBytes: 64 * 1024,
  logBytes: 256 * 1024 * 1024,
  shellCardBytes: 256 * 1024 * 1024,
  modelBytes: 48 * 1024,
  modelLines: 1800,
  executeMetadataBytes: 20 * 1024,
  taskMetadataBytes: 40 * 1024,
  hostResultBytes: 49 * 1024,
})

/** Decode a byte window without splitting a UTF-8 code point. */
export function utf8Window(buffer, size, tail = false) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer must be a Buffer")
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("size must be a non-negative integer")
  let bytes = buffer.subarray(tail ? Math.max(0, buffer.length - size) : 0, tail ? buffer.length : size)
  if (tail) {
    let start = 0
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
    bytes = bytes.subarray(start)
  }
  return new StringDecoder("utf8").write(bytes)
}

/** Return a UTF-8-safe byte range and its decoded text for paged output. */
export function utf8Range(buffer, start, end) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer must be a Buffer")
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > buffer.length) {
    throw new RangeError("invalid byte range")
  }
  while (start < end && (buffer[start] & 0xc0) === 0x80) start += 1
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { start, end, value: buffer.subarray(start, end).toString("utf8") }
}

/** Keep the UTF-8-safe prefix of text within a byte budget. */
export function truncateUtf8Head(text, maxBytes) {
  const bytes = Buffer.from(String(text))
  return {
    text: utf8Window(bytes, maxBytes),
    truncated: bytes.length > maxBytes,
  }
}

/** Keep the UTF-8-safe suffix of text within a byte budget. */
export function truncateUtf8Tail(text, maxBytes) {
  const bytes = Buffer.from(String(text))
  return {
    text: utf8Window(bytes, maxBytes, true),
    truncated: bytes.length > maxBytes,
  }
}

/** Keep the last lines while preserving the existing line separator behavior. */
export function truncateLinesTail(text, maxLines) {
  const lines = String(text).split("\n")
  return {
    text: lines.length > maxLines ? lines.slice(-maxLines).join("\n") : String(text),
    truncated: lines.length > maxLines,
  }
}
