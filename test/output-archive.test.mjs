import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtempSync, openSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOutputArchive } from "../src/command-core/output-archive.mjs"

function fixture(limit = 1024) {
  const root = mkdtempSync(join(tmpdir(), "o4e-archive-test-"))
  const path = join(root, "command-test.log")
  const file = openSync(path, "w+")
  const identity = statSync(path)
  let stopped = false
  const archive = createOutputArchive({
    logPath: path, logFile: file, logIdentity: identity, logLimitBytes: limit,
    now: () => Date.now(), writeLog: fs.writeSync, syncLog: fs.fsyncSync,
    trustedLog: (value) => statSync(value).isFile(),
    trustedDirectory: (value) => statSync(value).isDirectory(),
    activeLogs: new Set([path]), stopped: () => stopped,
  })
  return { root, path, archive, stop: () => { stopped = true } }
}

test("OutputArchive writes and finalizes a complete log", () => {
  const f = fixture()
  f.archive.append(Buffer.from("hello\n"))
  f.stop(); f.archive.finalize()
  assert.deepEqual(f.archive.snapshot(), { logBytes: 6, logComplete: true })
  assert.equal(readFileSync(f.path, "utf8"), "hello\n")
})

test("OutputArchive reports capacity without claiming completeness", () => {
  const f = fixture(3)
  f.archive.append(Buffer.from("hello"))
  f.stop(); f.archive.finalize()
  assert.equal(f.archive.snapshot().logBytes, 3)
  assert.equal(f.archive.snapshot().logComplete, false)
  assert.equal(f.archive.snapshot().logError, "O4E_COMMAND_LOG_CAPACITY_EXCEEDED")
})

test("OutputArchive preserves incomplete capture state", () => {
  const f = fixture()
  const incomplete = true
  const archive = createOutputArchive({
    logPath: f.path, logFile: openSync(f.path, "w+"), logIdentity: statSync(f.path), logLimitBytes: 100,
    now: () => Date.now(), writeLog: fs.writeSync, syncLog: fs.fsyncSync,
    trustedLog: (value) => statSync(value).isFile(), trustedDirectory: (value) => statSync(value).isDirectory(),
    activeLogs: new Set([f.path]), incomplete: () => incomplete, stopped: f.stop,
  })
  archive.append(Buffer.from("x")); f.stop(); archive.finalize()
  assert.equal(archive.snapshot().logComplete, false)
  assert.equal(archive.snapshot().logError, "O4E_COMMAND_LOG_CAPTURE_INCOMPLETE")
})
