import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseCLI, sourceSnapshot, spawnOwnedProcess, streamEvidence } from "./common.mjs"

test("CLI accepts only explicit mode, a source worktree and a fresh-root-shaped absolute path", () => {
  const args = ["--source", "/product", "--run-root", "/tmp/opencode/new-run", "--mode", "controlled"]
  assert.equal(parseCLI(args).mode, "controlled")
  assert.equal(parseCLI([...args.slice(0, -1), "live", "--provider-config", "/private/config.json", "--key-resolver", "/private/key.mjs"]).mode, "live")
  for (const bad of [[], [...args, "--mode", "live"], [...args, "--auto", "true"], [...args, "extra"],
    [...args, "--provider-config", "/private/config.json"], [...args.slice(0, -1), "live"],
    ["--source", "relative", ...args.slice(2)], ["--source", "/product/../product", ...args.slice(2)],
    ["--source", "/product", "--run-root", "/tmp/opencode", "--mode", "controlled"],
    ["--source", "/product", "--run-root", "/tmp/new-run", "--mode", "controlled"],
    ["--source", "/product", "--run-root", "/tmp/opencode/a/../b", "--mode", "controlled"],
    ["--source", "/tmp/opencode/new-run", ...args.slice(2)]]) assert.throws(() => parseCLI(bad), /^Error: ARGUMENTS$/)
})

test("SSE evidence accepts one terminal choice within the inclusive byte cap without exposing content", () => {
  for (const finish_reason of ["stop", "tool_calls"]) {
    const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "PRIVATE_SENTINEL" }, finish_reason }] })}\n\ndata: [DONE]\n\n`)
    assert.deepEqual(streamEvidence(bytes), { complete: true })
    assert.deepEqual(streamEvidence(Buffer.concat([bytes, Buffer.alloc(1024 * 1024 - bytes.length, "\n")])), { complete: true })
  }
})

test("SSE evidence fails closed for truncated, malformed, error and token-exhausted streams", () => {
  const good = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
  for (const bad of ["", good.replace("data: [DONE]\n\n", ""), good + "data: [DONE]\n\n",
    good.replace('"finish_reason":"tool_calls"', '"finish_reason":"length"'),
    "data: {not-json}\n\n" + good, 'data: {"error":{"message":"private upstream error"}}\n\n' + good,
    good + 'data: {"choices":[]}\n\n', good.replace('"index":0', '"index":1'),
    'data: {"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}\n\n' + good]) assert.deepEqual(streamEvidence(Buffer.from(bad)), { complete: false })
  assert.deepEqual(streamEvidence(Buffer.alloc(1024 * 1024 + 1)), { complete: false })
})

test("source snapshot accepts a staged tree, verifies raw index blobs, and rejects unstaged/untracked/conflicted input", async () => {
  const root = mkdtempSync(join(tmpdir(), "o4e-acceptance-index-unit-"))
  try {
    const bytes = "unit fixture\n", path = join(root, "fixture.txt")
    writeFileSync(path, bytes, { mode: 0o600 })
    const oid = createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`).digest("hex")
    let status = "M  fixture.txt\0", tree = "b".repeat(40), entry = `100644 ${oid} 0\tfixture.txt\0`
    const command = async (_binary, args) => ({ stdout: args.includes("--show-toplevel") ? root + "\n"
      : args.includes("status") ? status : args.includes("ls-files") ? entry : args.includes("write-tree") ? tree + "\n" : "a".repeat(40) + "\n" })
    assert.deepEqual(await sourceSnapshot(root, command), { head: "a".repeat(40), tree })
    const first = await sourceSnapshot(root, command)
    tree = "c".repeat(40)
    assert.notDeepEqual(await sourceSnapshot(root, command), first)
    for (status of [" M fixture.txt\0", "MM fixture.txt\0", "?? extra.txt\0", "!! ignored.txt\0", "UU fixture.txt\0"]) {
      await assert.rejects(sourceSnapshot(root, command), /^Error: SOURCE$/)
    }
    status = ""
    writeFileSync(path, "unstaged but stat-cache-hidden content\n")
    await assert.rejects(sourceSnapshot(root, command), /^Error: SOURCE$/)
    writeFileSync(path, bytes)
    entry = `160000 ${oid} 0\tsubmodule\0`
    await assert.rejects(sourceSnapshot(root, command), /^Error: SOURCE$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("owned process rejects nonfinite and out-of-budget deadlines before spawning", () => {
  for (const options of [
    ...[NaN, Infinity, -Infinity, 0, -1, 600001].map((timeout) => ({ timeout })),
    ...[NaN, Infinity, -Infinity, 0, -1, 5000].map((cleanupMs) => ({ cleanupMs })),
  ]) assert.throws(() => spawnOwnedProcess(process.execPath, ["-e", ""], options), /^Error: SETUP$/)
})

test("owned cleanup reaps a detached TERM-resistant descendant after its leader exits without killing an unrelated process", { timeout: 10000 }, async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const sleeper = 'process.on("SIGTERM", () => {}); process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n"); setInterval(() => {}, 1000)'
  const leader = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.unref(); setTimeout(() => process.exit(0), 200)`
  const owned = spawnOwnedProcess(process.execPath, ["-e", leader], { timeout: 5000, cleanupMs: 2500 })
  const pending = owned.result
  owned.child.stderr.resume()
  let text = ""
  owned.child.stdout.on("data", (bytes) => { text += bytes.toString() })
  try {
    const result = await pending
    const pid = JSON.parse(text.trim()).pid
    assert.equal(result.exitCode, 0)
    assert.equal(result.cleaned, true)
    assert.ok(result.tracked >= 2)
    assert.throws(() => readFileSync(`/proc/${pid}/stat`), { code: "ENOENT" })
    assert.equal(unrelated.exitCode, null)
    assert.equal(process.kill(unrelated.pid, 0), true)
  } finally {
    owned.stop(); await pending.catch(() => {})
    const exited = once(unrelated, "close"); unrelated.kill("SIGKILL"); await exited
  }
})

test("owned cleanup handles stop requests and enforces its own deadline", { timeout: 10000 }, async () => {
  for (const cancel of [true, false]) {
    const owned = spawnOwnedProcess(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeout: cancel ? 2000 : 200, cleanupMs: 1200 })
    owned.child.stdout.resume(); owned.child.stderr.resume()
    const result = owned.result
    if (cancel) { await delay(100); owned.stop(); owned.stop() }
    if (cancel) {
      assert.equal((await result).cleaned, true)
    } else await assert.rejects(result, /^Error: CLEANUP$/)
  }
})

test("subreaper discovers fast double-fork orphans and control disconnect also cleans detached children", { timeout: 10000 }, async () => {
  for (const disconnect of [false, true]) {
    const code = String.raw`import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    print(os.getpid(), flush=True)
    while True:
        time.sleep(1)
if ${disconnect ? "True" : "False"}:
    while True:
        time.sleep(1)
os._exit(0)
`
    const owned = spawnOwnedProcess("/usr/bin/python3", ["-I", "-c", code], { timeout: 5000, cleanupMs: 2000 })
    const result = owned.result
    owned.child.stderr.resume()
    let output = ""
    owned.child.stdout.on("data", (bytes) => { output += bytes.toString(); if (disconnect) owned.child.stdio[3].destroy() })
    try {
      assert.equal((await result).cleaned, true)
      assert.match(output.trim(), /^\d+$/)
      assert.throws(() => readFileSync(`/proc/${Number(output)}/stat`), { code: "ENOENT" })
    } finally { owned.stop(); await result.catch(() => {}) }
  }
})
