import { inspect } from "node:util"
import { relative } from "node:path"

const SLOW_THRESHOLD_MS = 1000
const SLOW_LIMIT = 10

function location(data = {}) {
  if (!data.file) return ""
  const file = relative(process.cwd(), data.file) || data.file
  return `${file}${data.line ? `:${data.line}${data.column ? `:${data.column}` : ""}` : ""}`
}

function duration(data = {}) {
  const value = data.details?.duration_ms
  return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "unknown duration"
}

function isCancelled(data = {}) {
  const error = data.details?.error
  const failureType = error?.failureType ?? error?.cause?.failureType
  return data.cancelled === true || typeof failureType === "string" && failureType.toLowerCase().includes("cancel")
}

function formatError(error) {
  if (!error) return "No error details were reported."
  return inspect(error, { colors: false, depth: 8, breakLength: 120 })
}

function outputKey(data = {}) {
  return data.entryFile ?? data.file ?? "<runner>"
}

function testKey(data = {}) {
  return `${data.entryFile ?? data.file ?? ""}:${data.testId ?? ""}:${data.name ?? ""}`
}

function pushOutput(buffers, event) {
  const key = outputKey(event.data)
  const entries = buffers.get(key) ?? []
  entries.push({ type: event.type, message: String(event.data?.message ?? "") })
  buffers.set(key, entries)
}

function takeOutput(buffers, data) {
  const keys = [data?.entryFile, data?.file, "<runner>"].filter(Boolean)
  const chunks = []
  for (const key of new Set(keys)) {
    const entries = buffers.get(key)
    if (!entries) continue
    buffers.delete(key)
    for (const entry of entries) {
      const label = entry.type === "test:stderr" ? "stderr" : entry.type === "test:stdout" ? "stdout" : "diagnostic"
      chunks.push(`[${label}]\n${entry.message.trimEnd()}`)
    }
  }
  return chunks.filter((chunk) => !chunk.endsWith("]\n"))
}

function summaryLine(data) {
  const counts = data.counts ?? {}
  const tests = counts.tests ?? 0
  const passed = counts.passed ?? 0
  const failed = counts.failed ?? 0
  const cancelled = counts.cancelled ?? 0
  const skipped = counts.skipped ?? 0
  const todo = counts.todo ?? 0
  const selected = Math.max(0, tests - skipped)
  const state = data.success ? "PASS" : "FAIL"
  const elapsed = Number.isFinite(data.duration_ms) ? `${data.duration_ms.toFixed(1)} ms` : "unknown duration"
  return `Tests: ${state} — selected ${selected}, passed ${passed}, failed ${failed}, cancelled ${cancelled}, skipped ${skipped}, todo ${todo}; ${elapsed}`
}

export async function * conciseReporter(source) {
  const outputBuffers = new Map()
  const slowTests = new Map()
  const counts = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 }
  const failedEntries = new Set()
  const wrapperFailures = []
  const reportedTests = new Map()
  let finalSummary

  for await (const event of source) {
    const entry = outputKey(event.data)
    const nesting = event.data?.nesting ?? 0
    if (["test:start", "test:pass", "test:fail"].includes(event.type)) {
      const outcomes = reportedTests.get(entry) ?? new Map()
      if (event.type === "test:start") outcomes.delete(nesting)
      else outcomes.set(nesting, event.type === "test:fail")
      reportedTests.set(entry, outcomes)
    }
    if (event.type === "test:diagnostic") {
      // Node emits a test's diagnostics after its reporting-order pass/fail.
      const failed = reportedTests.get(entry)?.get(nesting)
      if (failed !== undefined) {
        const message = String(event.data?.message ?? "").trimEnd()
        if (failed && message) yield `[diagnostic]\n${message}\n`
        continue
      }
    }
    if (["test:stdout", "test:stderr", "test:diagnostic"].includes(event.type)) {
      pushOutput(outputBuffers, event)
      continue
    }

    if (event.type === "test:pass") {
      const fileWrapper = event.data?.line === 1 && typeof event.data?.name === "string" && event.data.name.endsWith(".test.mjs")
      if (fileWrapper) continue
      counts.tests += 1
      if (event.data?.skip) counts.skipped += 1
      else if (event.data?.todo) counts.todo += 1
      else counts.passed += 1
      const elapsed = event.data?.details?.duration_ms
      if (!event.data?.skip && !event.data?.todo && event.data?.details?.type !== "suite" && Number.isFinite(elapsed) && elapsed >= SLOW_THRESHOLD_MS) {
        const key = testKey(event.data)
        if (!slowTests.has(key)) slowTests.set(key, { name: event.data.name, elapsed, location: location(event.data) })
      }
      continue
    }

    if (event.type === "test:complete") {
      const elapsed = event.data?.details?.duration_ms
      if (event.data?.passed && !event.data?.skip && !event.data?.todo && event.data?.details?.type !== "suite" && Number.isFinite(elapsed) && elapsed >= SLOW_THRESHOLD_MS) {
        slowTests.set(testKey(event.data), { name: event.data.name, elapsed, location: location(event.data) })
      }
      continue
    }

    if (event.type === "test:fail") {
      const todo = Boolean(event.data?.todo)
      const cancelled = isCancelled(event.data)
      const fileWrapper = event.data?.line === 1 && typeof event.data?.name === "string" && event.data.name.endsWith(".test.mjs")
      if (fileWrapper) {
        wrapperFailures.push({ cancelled, entry: outputKey(event.data) })
      } else {
        counts.tests += 1
        if (todo) counts.todo += 1
        else if (cancelled) counts.cancelled += 1
        else counts.failed += 1
        failedEntries.add(outputKey(event.data))
      }
      const prefix = todo ? "TODO" : cancelled ? "CANCELLED" : "FAIL"
      const where = location(event.data)
      const buffered = takeOutput(outputBuffers, event.data)
      yield `\n${prefix}: ${event.data?.name ?? "unnamed test"}${where ? ` (${where}, ${duration(event.data)})` : ` (${duration(event.data)})`}\n`
      if (todo && typeof event.data.todo === "string") yield `Reason: ${event.data.todo}\n`
      if (buffered.length) yield `${buffered.join("\n\n")}\n`
      yield `${formatError(event.data?.details?.error)}\n`
      continue
    }

    if (event.type === "test:interrupted") {
      for (const interrupted of event.data?.tests ?? []) {
        const where = location(interrupted)
        yield `\nINTERRUPTED: ${interrupted.name ?? "unnamed test"}${where ? ` (${where})` : ""}\n`
      }
      continue
    }

    if (event.type === "test:summary") {
      if (event.data?.file) {
        reportedTests.delete(entry)
        if (event.data.success) outputBuffers.delete(event.data.file)
      } else {
        finalSummary = event.data
      }
    }
  }

  for (const wrapper of wrapperFailures) {
    if (failedEntries.has(wrapper.entry)) continue
    counts.tests += 1
    if (wrapper.cancelled) counts.cancelled += 1
    else counts.failed += 1
  }

  if (slowTests.size) {
    yield `\nSlow tests (>= ${SLOW_THRESHOLD_MS} ms):\n`
    for (const item of [...slowTests.values()].sort((left, right) => right.elapsed - left.elapsed).slice(0, SLOW_LIMIT)) {
      yield `- ${item.elapsed.toFixed(1)} ms ${item.name}${item.location ? ` (${item.location})` : ""}\n`
    }
  }
  if (finalSummary) yield `\n${summaryLine({ ...finalSummary, counts })}\n`
}

export default conciseReporter
