import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createCommandExecutionPort } from "../src/command-core/command-execution-port.mjs"

const linux = { skip: process.platform !== "linux", timeout: 15000 }
const digest = (value) => createHash("sha256").update(value).digest("hex")
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const nodeCommand = (source) => `${quote(process.execPath)} -e ${quote(source)}`

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "o4e-command-port-"))
  const directory = join(root, "workspace")
  const logRoot = join(root, "logs")
  fs.mkdirSync(directory)
  const port = createCommandExecutionPort({ directory, logRoot, ...options })
  t.after(async () => {
    try { await port.dispose() } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  return { directory, logRoot, port }
}

async function waitFor(predicate) {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "condition did not become true")
    await delay(10)
  }
}

function isLive(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")
    return !["Z", "X"].includes(fields[0])
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false
    throw error
  }
}

test("process liveness probe tolerates vanished proc entries but preserves other errors", (t) => {
  const error = Object.assign(new Error("injected proc read error"), { code: "ESRCH" })
  t.mock.method(fs, "readFileSync", () => { throw error })
  assert.equal(isLive(123), false)
  error.code = "ENOENT"
  assert.equal(isLive(123), false)
  error.code = "EACCES"
  assert.throws(() => isLive(123), value => value === error)
})

test("direct shell captures stdout/stderr, cwd and stdin EOF", linux, async (t) => {
  const { directory, port } = fixture(t)
  const cwd = join(directory, "cwd")
  fs.mkdirSync(cwd)
  const updates = []
  const handle = port.start({ executionID: "printf", cwd: "cwd", command: "printf 'hello'; printf 'error' >&2; read value || printf ':eof'; printf '\\n%s\\n%s' \"$PWD\" \"$$\"", onUpdate: (update) => updates.push(update) })
  assert.equal(port.get("printf"), handle)
  assert.equal(handle.snapshot().status, "running")
  assert.equal(handle.snapshot().stopped, false)
  const result = await handle.done
  assert.equal(result.status, "completed")
  assert.equal(result.exitCode, 0)
  assert.equal(result.stopped, true)
  assert.equal(result.truncated, false)
  assert.ok(result.output.includes("hello"))
  assert.ok(result.output.includes("error"))
  assert.ok(result.output.includes(":eof"))
  assert.ok(result.output.includes(cwd))
  assert.equal(result.sha256, digest(result.output))
  assert.equal(result.totalBytes, Buffer.byteLength(result.output))
  await waitFor(() => updates.some((update) => update.status === "completed"))
  assert.deepEqual(handle.snapshot(), result)
  assert.deepEqual(await handle.cancel(), result)
  assert.equal(port.get("missing"), undefined)
  assert.equal(port.cancel("missing"), undefined)
})

test("nonzero exit and signal exit fail without retry or command diagnostics", linux, async (t) => {
  const { directory, port } = fixture(t)
  const result = await port.start({ executionID: "nonzero", command: "printf x >> invocations; printf 'partial'; exit 7" }).done
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "nonzero-exit")
  assert.equal(result.exitCode, 7)
  assert.equal(result.stopped, true)
  assert.equal(result.output, "partial")
  assert.equal(fs.readFileSync(join(directory, "invocations"), "utf8"), "x")
  const signalled = await port.start({ executionID: "signal", command: "kill -TERM $$" }).done
  assert.equal(signalled.status, "failed")
  assert.equal(signalled.reason, "signal-exit")
  assert.equal(signalled.exitCode, undefined)
  assert.equal(signalled.stopped, true)
})

test("uses exactly the supplied host shell with ordinary startup and no fallback", linux, async (t) => {
  const { directory } = fixture(t)
  const shell = join(directory, "bash")
  fs.symlinkSync("/bin/bash", shell)
  const port = createCommandExecutionPort({ directory, shell })
  t.after(() => port.dispose())
  const command = "printf '%s:%s:%s' \"$0\" \"$-\" \"$$\"; while :; do :; done"
  const handle = port.start({ executionID: "shell", command })
  await waitFor(() => handle.snapshot().output)
  const [executable, flags, pid] = handle.snapshot().output.split(":")
  assert.equal(executable, shell)
  assert.ok(!flags.includes("p"))
  assert.deepEqual(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1), [shell, "-c", command])
  assert.equal((await handle.cancel()).stopped, true)
  for (const shell of ["/bin/sh"]) {
    const alternate = createCommandExecutionPort({ directory, shell })
    t.after(() => alternate.dispose())
    assert.equal((await alternate.start({ executionID: `alternate-${shell}`, command: "printf ok" }).done).output, "ok")
  }
  const missing = createCommandExecutionPort({ directory, shell: join(directory, "missing", "bash") })
  t.after(() => missing.dispose())
  const failed = await missing.start({ executionID: "spawn-failure", command: "do-not-echo-command-value" }).done
  assert.equal(failed.status, "failed")
  assert.equal(failed.reason, "spawn-failed")
  assert.equal(failed.output, "")
  assert.equal(failed.totalBytes, 0)
  assert.equal(failed.truncated, false)
  assert.equal(failed.sha256, digest(""))
  assert.equal(failed.logComplete, true)
  assert.equal(failed.stopped, true)
})

test("Bash inherits launch environment and ordinary startup behavior", linux, async (t) => {
  const { directory } = fixture(t)
  const url = new URL("../src/command-core/command-execution-port.mjs", import.meta.url).href
  const startup = join(directory, "startup.sh")
  fs.writeFileSync(startup, 'export STARTUP_VALUE="启动"\n')
  const source = `import assert from 'node:assert/strict';
    import { createCommandExecutionPort } from ${JSON.stringify(url)};
    const before = { ...process.env };
    const port = createCommandExecutionPort();
    process.env.O4E_COMMAND_PORT_TEST_VALUE = 'at-launch';
    const result = await port.start({ executionID: 'startup',
      command: 'printf "%s:%s:%s" "$O4E_COMMAND_PORT_TEST_VALUE" "$STARTUP_VALUE" "$-"' }).done;
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output.split(':').slice(0, 2), ['at-launch', '启动']);
    assert.ok(!result.output.split(':')[2].includes('p'));
    assert.equal(process.env.BASH_ENV, before.BASH_ENV);
    assert.equal(process.env.STARTUP_VALUE, undefined);
    await port.dispose();`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: directory, env: { ...process.env, BASH_ENV: startup }, encoding: "utf8", timeout: 10000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, "")
  assert.equal(child.stderr, "")
})

test("bounds running tail and terminal head/tail, counting and hashing the entire stream", linux, async (t) => {
  const { port } = fixture(t)
  const text = "A".repeat(40000) + "B".repeat(90000) + "C".repeat(40000)
  const handle = port.start({ executionID: "large", command: `${nodeCommand("process.stdout.write('A'.repeat(40000) + 'B'.repeat(90000) + 'C'.repeat(40000))")}; sleep 0.3` })
  await waitFor(() => handle.snapshot().totalBytes === text.length)
  const running = handle.snapshot()
  assert.equal(running.status, "running")
  assert.equal(running.output, text.slice(-65536))
  assert.equal(running.sha256, undefined)
  assert.equal(running.truncated, true)
  assert.equal(running.logComplete, false)
  assert.equal(fs.readFileSync(running.logPath, "utf8"), text)
  const result = await handle.done
  assert.equal(result.output, text.slice(0, 32768) + text.slice(-32768))
  assert.equal(Buffer.byteLength(result.output), 65536)
  assert.equal(result.totalBytes, text.length)
  assert.equal(result.sha256, digest(text))
  assert.equal(result.stopped, true)
})

test("UTF-8 split chunks and truncation never exceed the byte budget", linux, async (t) => {
  const { port } = fixture(t)
  const text = "\u20ac".repeat(30000)
  const handle = port.start({ executionID: "utf8", command: `${nodeCommand("const b = Buffer.from('\\u20ac'.repeat(30000)); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 30)")}; sleep 0.2` })
  await waitFor(() => handle.snapshot().totalBytes === Buffer.byteLength(text))
  assert.ok(Buffer.byteLength(handle.snapshot().output) <= 65536)
  assert.ok(!handle.snapshot().output.includes("\ufffd"))
  const result = await handle.done
  assert.equal(result.sha256, digest(text))
  assert.equal(result.totalBytes, 90000)
  assert.ok(Buffer.byteLength(result.output) <= 65536)
  assert.ok(!result.output.includes("\ufffd"))
  assert.equal(result.truncated, true)
  assert.equal(result.logComplete, true)
  assert.equal(fs.readFileSync(result.logPath, "utf8"), text)
  const invalid = await port.start({ executionID: "invalid-utf8", command: nodeCommand("process.stdout.write(Buffer.alloc(70000, 255))") }).done
  assert.ok(Buffer.byteLength(invalid.output) <= 65536)
  assert.equal(invalid.totalBytes, 70000)
  assert.equal(invalid.sha256, digest(Buffer.alloc(70000, 255)))
  assert.equal(invalid.logComplete, true)
  assert.equal(fs.readFileSync(invalid.logPath, "utf8"), "\ufffd".repeat(70000))
})

test("complete user-only text logs preserve raw text beyond the retained view", linux, async (t) => {
  const { directory, logRoot, port } = fixture(t)
  const text = "begin\n" + "中€".repeat(30000) + "\nend"
  const result = await port.start({ executionID: "full-log", command: nodeCommand("process.stdout.write('begin\\n' + '中€'.repeat(30000) + '\\nend')") }).done
  assert.equal(result.status, "completed")
  assert.equal(result.truncated, true)
  assert.equal(result.logComplete, true)
  assert.equal(result.logError, undefined)
  assert.equal(result.logBytes, Buffer.byteLength(text))
  assert.equal(fs.readFileSync(result.logPath, "utf8"), text)
  assert.ok(!result.logPath.startsWith(`${directory}/`))
  assert.equal(fs.lstatSync(logRoot).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(join(result.logPath, "..")).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(result.logPath).mode & 0o777, 0o600)
  assert.equal(fs.lstatSync(result.logPath).uid, process.getuid())
  // Ordinary bounded file reads can reconstruct bytes omitted by the view.
  const fd = fs.openSync(result.logPath, "r")
  const chunks = []
  try {
    for (let position = 0; position < result.logBytes;) {
      const bytes = Buffer.alloc(4096)
      const count = fs.readSync(fd, bytes, 0, bytes.length, position)
      assert.ok(count > 0)
      chunks.push(bytes.subarray(0, count))
      position += count
    }
  } finally { fs.closeSync(fd) }
  assert.equal(Buffer.concat(chunks).toString("utf8"), text)
})

test("log capacity failure is explicit and never claims a complete archive", linux, async (t) => {
  const { port } = fixture(t, { logLimitBytes: 7 })
  const result = await port.start({ executionID: "log-cap", command: "printf '123456789'" }).done
  assert.equal(result.status, "completed")
  assert.equal(result.output, "123456789")
  assert.equal(result.logComplete, false)
  assert.equal(result.logError, "O4E_COMMAND_LOG_CAPACITY_EXCEEDED")
  assert.equal(result.logBytes, 7)
  assert.equal(fs.readFileSync(result.logPath, "utf8"), "1234567")
  const unicode = await port.start({ executionID: "log-cap-utf8", command: nodeCommand("process.stdout.write('123€€')") }).done
  assert.equal(unicode.logComplete, false)
  assert.equal(unicode.logError, "O4E_COMMAND_LOG_CAPACITY_EXCEEDED")
  assert.equal(unicode.logBytes, 6)
  assert.equal(fs.readFileSync(unicode.logPath, "utf8"), "123€")
})

test("small, empty and whitespace-only output and logs preserve captured text exactly", linux, async (t) => {
  const { port } = fixture(t)
  for (const [executionID, text] of [["small", "hello"], ["empty", ""], ["whitespace", "  \n\t \n\n"]]) {
    const result = await port.start({ executionID, command: nodeCommand(`process.stdout.write(${JSON.stringify(text)})`) }).done
    assert.equal(result.status, "completed")
    assert.equal(result.output, text)
    assert.equal(result.truncated, false)
    assert.equal(result.logComplete, true)
    assert.equal(result.logBytes, Buffer.byteLength(text))
    assert.equal(fs.readFileSync(result.logPath, "utf8"), text)
  }
})

test("partial disk write failure reports actual archived bytes while capture continues", linux, async (t) => {
  let writes = 0
  let synced = false
  const { port } = fixture(t, { logIO: {
    writeSync: (fd, bytes, offset) => {
      if (writes++ === 0) return fs.writeSync(fd, bytes, offset, 2)
      throw Object.assign(new Error("private-disk-detail"), { code: "ENOSPC" })
    },
    fsyncSync: (fd) => { fs.fsyncSync(fd); synced = true },
  } })
  const result = await port.start({ executionID: "partial-write", command: nodeCommand("process.stdout.write('abcdef')") }).done
  assert.equal(result.status, "completed")
  assert.equal(result.output, "abcdef")
  assert.equal(result.sha256, digest("abcdef"))
  assert.equal(result.logBytes, 2)
  assert.equal(result.logComplete, false)
  assert.equal(result.logError, "ENOSPC")
  assert.equal(fs.readFileSync(result.logPath, "utf8"), "ab")
  assert.equal(synced, true)
})

test("zero disk writes and final fsync failure cannot claim a complete log", linux, async (t) => {
  for (const [name, logIO, expectedBytes, error] of [
    ["zero-write", { writeSync: () => 0 }, 0, "O4E_COMMAND_LOG_WRITE_STALLED"],
    ["sync-failed", { fsyncSync: () => { throw Object.assign(new Error("private-sync-detail"), { code: "EIO" }) } }, 6, "EIO"],
  ]) {
    const { port } = fixture(t, { logIO })
    const result = await port.start({ executionID: name, command: nodeCommand("process.stdout.write('abcdef')") }).done
    assert.equal(result.status, "completed")
    assert.equal(result.output, "abcdef")
    assert.equal(result.logBytes, expectedBytes)
    assert.equal(result.logComplete, false)
    assert.equal(result.logError, error)
  }
})

test("untrusted log roots and ancestors resolving inside the workspace never archive there", linux, async (t) => {
  const { directory, logRoot } = fixture(t)
  fs.mkdirSync(logRoot, { mode: 0o755 })
  const alias = join(logRoot, "workspace-alias")
  fs.symlinkSync(directory, alias, "dir")
  for (const [name, root, error] of [
    ["open-permissions", logRoot, "O4E_COMMAND_LOG_DIRECTORY_UNTRUSTED"],
    ["inside", join(directory, "logs"), "O4E_COMMAND_LOG_DIRECTORY_IN_WORKSPACE"],
    ["symlink-ancestor", join(alias, "logs"), "O4E_COMMAND_LOG_DIRECTORY_IN_WORKSPACE"],
    ["symlink-root", alias, "O4E_COMMAND_LOG_DIRECTORY_UNTRUSTED"],
  ]) {
    const port = createCommandExecutionPort({ directory, logRoot: root })
    t.after(() => port.dispose())
    const result = await port.start({ executionID: name, command: nodeCommand("process.stdout.write('captured')") }).done
    assert.equal(result.status, "completed")
    assert.equal(result.output, "captured")
    assert.equal(result.logComplete, false)
    assert.equal(result.logBytes, 0)
    assert.equal(result.logPath, undefined)
    assert.equal(result.logError, error)
  }
  assert.equal(fs.existsSync(join(directory, "logs")), false)
})

test("a Session subdirectory cannot put logs in its repository siblings", linux, async (t) => {
  const { directory } = fixture(t)
  const sessionDirectory = join(directory, "session")
  const logRoot = join(directory, "sibling-logs")
  fs.mkdirSync(sessionDirectory)
  const port = createCommandExecutionPort({ directory: sessionDirectory, projectRoot: directory, logRoot })
  t.after(() => port.dispose())
  const result = await port.start({ executionID: "repository-log-root", command: nodeCommand("process.stdout.write('captured')") }).done
  assert.equal(result.status, "completed")
  assert.equal(result.output, "captured")
  assert.equal(result.logComplete, false)
  assert.equal(result.logError, "O4E_COMMAND_LOG_DIRECTORY_IN_WORKSPACE")
  assert.equal(fs.existsSync(logRoot), false)
})

test("deleted, replaced, truncated and exposed log files never settle as complete archives", linux, async (t) => {
  for (const [name, mutate, error] of [
    ["deleted", (path) => fs.unlinkSync(path), "ENOENT"],
    ["replaced", (path) => { fs.unlinkSync(path); fs.writeFileSync(path, "ready", { mode: 0o600 }) }, "O4E_COMMAND_LOG_FILE_CHANGED"],
    ["truncated", (path) => fs.truncateSync(path, 1), "O4E_COMMAND_LOG_FILE_CHANGED"],
    ["exposed", (path) => fs.chmodSync(path, 0o644), "O4E_COMMAND_LOG_FILE_UNTRUSTED"],
  ]) {
    const { directory, port } = fixture(t)
    const handle = port.start({ executionID: name, command: "printf ready; while [ ! -e release ]; do sleep 0.02; done" })
    await waitFor(() => handle.snapshot().output === "ready")
    mutate(handle.snapshot().logPath)
    fs.writeFileSync(join(directory, "release"), "")
    const result = await handle.done
    assert.equal(result.status, "completed")
    assert.equal(result.output, "ready")
    assert.equal(result.logComplete, false)
    assert.equal(result.logError, error)
  }
})

test("24 hour cleanup keeps active logs even after capacity failure and starts retention at settlement", linux, async (t) => {
  let now = Date.now()
  const { directory, port } = fixture(t, { now: () => now, logLimitBytes: 7 })
  const old = await port.start({ executionID: "old", command: nodeCommand("process.stdout.write('old')") }).done
  const handle = port.start({ executionID: "active", command: "printf 123456789; while [ ! -e release ]; do sleep 0.02; done; printf last" })
  await waitFor(() => handle.snapshot().logError === "O4E_COMMAND_LOG_CAPACITY_EXCEEDED")
  const activePath = handle.snapshot().logPath
  now += 25 * 60 * 60 * 1000
  await port.start({ executionID: "cleanup-active", command: nodeCommand("process.stdout.write('sweep')") }).done
  assert.equal(fs.existsSync(old.logPath), false)
  assert.equal(fs.existsSync(activePath), true)
  assert.equal(handle.snapshot().status, "running")
  fs.writeFileSync(join(directory, "release"), "")
  const result = await handle.done
  assert.equal(result.status, "completed")
  assert.equal(result.output, "123456789last")
  assert.equal(result.logComplete, false)
  assert.equal(result.logError, "O4E_COMMAND_LOG_CAPACITY_EXCEEDED")
  assert.ok(Math.abs(fs.statSync(activePath).mtimeMs - now) < 1)
  now += 23 * 60 * 60 * 1000
  await port.start({ executionID: "cleanup-before-expiry", command: nodeCommand("process.stdout.write('sweep')") }).done
  assert.equal(fs.existsSync(activePath), true)
  now += 2 * 60 * 60 * 1000
  await port.start({ executionID: "cleanup-after-expiry", command: nodeCommand("process.stdout.write('sweep')") }).done
  assert.equal(fs.existsSync(activePath), false)
})

test("timeout is an execution deadline and stops the shell and foreground child", linux, async (t) => {
  const { port } = fixture(t)
  const start = performance.now()
  const handle = port.start({ executionID: "timeout", timeout: 150, command: "printf '%s ' $$; sleep 20 & printf '%s' $!; wait" })
  const result = await handle.done
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "timeout")
  assert.equal(result.stopped, true)
  assert.ok(performance.now() - start < 5500)
  const pids = result.output.split(" ").map(Number)
  assert.equal(pids.length, 2)
  assert.ok(pids.every((pid) => pid > 1 && !isLive(pid)))
})

test("cancellation stops child sleep without touching another execution", linux, async (t) => {
  const { port } = fixture(t)
  const other = port.start({ executionID: "other", command: "printf ready; sleep 20" })
  const handle = port.start({ executionID: "cancel", command: "sleep 20 & printf '%s' $!; wait" })
  await waitFor(() => handle.snapshot().output && other.snapshot().output)
  const result = await port.cancel("cancel")
  assert.equal(result.status, "cancelled")
  assert.equal(result.stopped, true)
  assert.equal(isLive(Number(result.output)), false)
  assert.equal(other.snapshot().status, "running")
  assert.equal((await other.cancel()).stopped, true)
})

test("cancel waits for final trap output, both read ends and exit before publishing stopped", linux, async (t) => {
  const { port } = fixture(t)
  const handle = port.start({ executionID: "trap-output", command: "trap 'printf final; exit 0' TERM; printf ready; while :; do :; done" })
  await waitFor(() => handle.snapshot().output === "ready")
  const cancellation = handle.cancel()
  assert.equal(handle.snapshot().stopped, false)
  const result = await cancellation
  assert.equal(result.status, "cancelled")
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, "readyfinal")
  assert.equal(result.totalBytes, 10)
  assert.equal(result.sha256, digest("readyfinal"))
  assert.equal(result.stopped, true)
  assert.ok(Object.isFrozen(result))
})

test("shell exit terminates background descendants even when they close output", linux, async (t) => {
  const { port } = fixture(t)
  for (const [executionID, redirection] of [["pipes-open", ""], ["pipes-closed", ">/dev/null 2>&1"]]) {
    const result = await port.start({ executionID, command: `sleep 20 ${redirection} & printf '%s' $!; exit 0` }).done
    assert.equal(result.status, "completed")
    assert.equal(result.stopped, true)
    assert.equal(isLive(Number(result.output)), false)
  }
})

test("TERM-resistant descendants require the 3 second grace then KILL", linux, async (t) => {
  const { port } = fixture(t)
  const handle = port.start({ executionID: "kill", command: "trap '' TERM; sleep 20 & printf '%s' $!; wait" })
  await waitFor(() => handle.snapshot().output)
  const start = performance.now()
  const result = await handle.cancel()
  assert.equal(result.status, "cancelled")
  assert.equal(result.stopped, true)
  assert.ok(performance.now() - start >= 2900)
  assert.ok(performance.now() - start < 5500)
  assert.equal(isLive(Number(result.output)), false)
})

test("output boundary is exact at 64 KiB and truncates explicitly one byte over", linux, async (t) => {
  const { port } = fixture(t)
  for (const size of [65536, 65537]) {
    const result = await port.start({ executionID: `boundary-${size}`, command: nodeCommand(`process.stdout.write('x'.repeat(${size}))`) }).done
    assert.equal(result.status, "completed")
    assert.equal(result.output.length, 65536)
    assert.equal(result.totalBytes, size)
    assert.equal(result.truncated, size > 65536)
    assert.equal(result.sha256, digest("x".repeat(size)))
  }
})

test("escaping setsid descendants lose output completeness but not owned-group stop evidence", linux, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "o4e-command-escaped-"))
  const port = createCommandExecutionPort({ directory })
  const pidFile = join(directory, "escaped-pid")
  t.after(async () => {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"))
      if (isLive(pid)) process.kill(pid, "SIGKILL")
      await waitFor(() => !isLive(pid))
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const source = "const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.stdout.write(\"escaped\"); setTimeout(() => {}, 10000)'], { detached: true, stdio: ['ignore', 1, 2] }); require('node:fs').writeFileSync('escaped-pid', String(child.pid)); child.unref()"
  const handle = port.start({ executionID: "escaped", command: nodeCommand(source) })
  const result = await handle.done
  assert.equal(result.status, "unknown")
  assert.equal(result.reason, "output-or-exit-unconfirmed")
  assert.equal(result.stopped, true)
  assert.equal(result.truncated, true)
  assert.equal(result.sha256, undefined)
  assert.equal(isLive(Number(fs.readFileSync(pidFile, "utf8"))), true)
  assert.equal(port.get("escaped"), handle)
  await port.dispose()
  assert.deepEqual(await handle.cancel(), result)
})

test("unconfirmed KILL is bounded and never publishes cancellation or a complete hash", linux, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "o4e-command-kill-bound-"))
  const port = createCommandExecutionPort({ directory })
  const handle = port.start({ executionID: "kill-bound", command: "printf '%s' $$; exec sleep 20" })
  await waitFor(() => handle.snapshot().output)
  const pid = Number(handle.snapshot().output)
  const kill = process.kill
  t.after(async () => {
    if (isLive(pid)) kill.call(process, -pid, "SIGKILL")
    await waitFor(() => !isLive(pid))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const mocked = t.mock.method(process, "kill", (target, signal) => {
    if (target === -pid && signal !== 0) return true
    return kill.call(process, target, signal)
  })
  const start = performance.now()
  const result = await handle.cancel()
  assert.equal(result.status, "unknown")
  assert.equal(result.stopped, false)
  assert.equal(result.sha256, undefined)
  assert.ok(performance.now() - start < 6500)
  assert.ok(isLive(pid))
  assert.equal(port.get("kill-bound"), handle)
  mocked.mock.restore()
  const denied = t.mock.method(process, "kill", (target, signal) => {
    if (target === -pid) throw Object.assign(new Error("private-signal-error"), { code: "EPERM" })
    return kill.call(process, target, signal)
  })
  await assert.rejects(port.dispose(), { code: "O4E_COMMAND_DISPOSE_UNCONFIRMED" })
  denied.mock.restore()
  await port.dispose()
  assert.equal(handle.snapshot().stopped, true)
  assert.equal(handle.snapshot().status, "unknown")
  assert.equal(handle.snapshot().truncated, true)
  assert.equal(handle.snapshot().sha256, undefined)
  assert.deepEqual(await handle.done, result)
  assert.equal(isLive(pid), false)
})

test("a gone group is never signalled on subsequent cancel or disposal", linux, async (t) => {
  const { port } = fixture(t)
  const kill = t.mock.method(process, "kill")
  for (let index = 0; index < 2; index += 1) {
    const handle = port.start({ executionID: `short-${index}`, command: "printf short" })
    assert.equal((await handle.done).status, "completed")
    await handle.cancel()
  }
  await port.dispose()
  assert.equal(kill.mock.calls.filter(({ arguments: args }) => args[1] !== 0).length, 0)
})

test("claims are shared across canonical aliases and module reload, with no duplicate spawn", linux, async (t) => {
  const { directory, port } = fixture(t)
  const alias = join(directory, "alias")
  fs.symlinkSync(directory, alias, "dir")
  const reloaded = await import(`../src/command-core/command-execution-port.mjs?reload=${Date.now()}`)
  const second = reloaded.createCommandExecutionPort({ directory: alias })
  const args = { executionID: "once", command: "printf x >> count; sleep 0.1" }
  const handle = port.start(args)
  assert.equal(second.get("once"), handle)
  assert.throws(() => second.start(args), { code: "O4E_COMMAND_EXECUTION_EXISTS" })
  for (const conflict of [{ command: "different" }, { cwd: tmpdir() }, { timeout: 1 }]) {
    assert.throws(() => second.start({ ...args, ...conflict }), { code: "O4E_COMMAND_EXECUTION_EXISTS" })
  }
  await second.dispose()
  assert.equal(handle.snapshot().status, "running")
  assert.equal((await handle.done).status, "completed")
  const distinct = port.start({ ...args, executionID: "distinct" })
  await distinct.done
  assert.equal(fs.readFileSync(join(directory, "count"), "utf8"), "xx")
  await port.dispose()
  const successor = createCommandExecutionPort({ directory })
  assert.equal(successor.get("once"), handle)
  assert.throws(() => successor.start(args), { code: "O4E_COMMAND_EXECUTION_EXISTS" })
  await successor.dispose()
})

test("dispose cancels only facade-owned handles and rejects new work", linux, async (t) => {
  const { directory, port } = fixture(t)
  const second = createCommandExecutionPort({ directory })
  t.after(() => second.dispose())
  const firstHandle = port.start({ executionID: "first", command: "printf ready; sleep 20" })
  const secondHandle = second.start({ executionID: "second", command: "printf ready; sleep 20" })
  await waitFor(() => firstHandle.snapshot().output && secondHandle.snapshot().output)
  await port.dispose()
  assert.equal(firstHandle.snapshot().status, "cancelled")
  assert.equal(secondHandle.snapshot().status, "running")
  assert.equal(second.get("first"), firstHandle)
  assert.throws(() => port.start({ executionID: "late", command: "true" }), { code: "O4E_COMMAND_PORT_DISPOSED" })
})

test("immediate cancellation and dispose before spawn perform no execution", linux, async (t) => {
  const { directory, port } = fixture(t)
  const first = port.start({ executionID: "cancel-before-spawn", command: "printf x > unexpected" })
  const cancelled = first.cancel()
  const second = port.start({ executionID: "dispose-before-spawn", command: "printf x > unexpected" })
  await port.dispose()
  assert.equal((await cancelled).status, "cancelled")
  assert.equal((await second.done).stopped, true)
  assert.equal(fs.existsSync(join(directory, "unexpected")), false)
})

test("deadline expiration before the spawn microtask does not execute the command", linux, async (t) => {
  const { directory, port } = fixture(t)
  const handle = port.start({ executionID: "expired-before-spawn", timeout: 1, command: "printf x > unexpected" })
  const until = performance.now() + 5
  while (performance.now() < until) { /* Hold this turn past the deadline. */ }
  const result = await handle.done
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "timeout")
  assert.equal(result.stopped, true)
  assert.equal(fs.existsSync(join(directory, "unexpected")), false)
})

test("observer failures, rejection and pending promises cannot fail or delay done", linux, async (t) => {
  const { port } = fixture(t)
  for (const [executionID, onUpdate] of [
    ["throws", () => { throw new Error("private-observer-detail") }],
    ["rejects", async () => { throw new Error("private-observer-detail") }],
    ["pending", () => new Promise(() => {})],
  ]) {
    const result = await port.start({ executionID, command: "printf ok", onUpdate }).done
    assert.equal(result.status, "completed")
    assert.equal(result.output, "ok")
  }
  await delay(20)
})

test("EPERM after natural exit is retryable by dispose, preserving done, output and the execution claim", linux, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "o4e-command-unconfirmed-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const port = createCommandExecutionPort({ directory })
  const handle = port.start({ executionID: "unconfirmed", command: "printf ready; sleep 0.2" })
  await waitFor(() => handle.snapshot().output)
  const kill = process.kill
  const mocked = t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0) throw Object.assign(new Error("private-signal-error"), { code: "EPERM" })
    return kill.call(process, pid, signal)
  })
  const result = await handle.cancel()
  assert.equal(result.status, "unknown")
  assert.equal(result.stopped, false)
  assert.equal(result.reason, "process-group-unconfirmed")
  assert.equal(result.logComplete, false)
  await assert.rejects(port.dispose(), { code: "O4E_COMMAND_DISPOSE_UNCONFIRMED" })
  mocked.mock.restore()
  await port.dispose()
  assert.equal(handle.snapshot().stopped, true)
  assert.equal(handle.snapshot().status, "cancelled")
  assert.equal(handle.snapshot().sha256, digest("ready"))
  assert.equal(handle.snapshot().logComplete, true)
  assert.deepEqual(await handle.done, result)
  const successor = createCommandExecutionPort({ directory })
  assert.equal(successor.get("unconfirmed"), handle)
  assert.throws(() => successor.start({ executionID: "unconfirmed", command: "true" }), { code: "O4E_COMMAND_EXECUTION_EXISTS" })
  await successor.dispose()
})

test("EPERM recovery retries live-group cancel without respawn or fabricating lost output/hash", linux, async (t) => {
  const { directory, port } = fixture(t)
  const updates = []
  const args = { executionID: "retry-live", command: "printf x >> invocations; printf '%s' $$; exec sleep 20", onUpdate: (value) => updates.push(value) }
  const handle = port.start(args)
  await waitFor(() => handle.snapshot().output)
  const pid = Number(handle.snapshot().output)
  const kill = process.kill
  const denied = t.mock.method(process, "kill", (target, signal) => {
    if (target === -pid && signal !== 0) throw Object.assign(new Error("private-signal-error"), { code: "EPERM" })
    return kill.call(process, target, signal)
  })
  const firstCancel = handle.cancel()
  assert.equal(handle.cancel(), firstCancel)
  const first = await firstCancel
  assert.deepEqual(await handle.done, first)
  assert.equal(first.status, "unknown")
  assert.equal(first.stopped, false)
  assert.equal(first.truncated, true)
  assert.equal(first.sha256, undefined)
  assert.equal(first.logComplete, false)
  assert.equal(first.logError, "O4E_COMMAND_LOG_CAPTURE_INCOMPLETE")
  assert.equal(isLive(pid), true)
  assert.throws(() => port.start(args), { code: "O4E_COMMAND_EXECUTION_EXISTS" })
  denied.mock.restore()
  const signals = t.mock.method(process, "kill")
  const secondCancel = handle.cancel()
  assert.notEqual(secondCancel, firstCancel)
  assert.equal(handle.cancel(), secondCancel)
  const result = await secondCancel
  assert.equal(result.status, "unknown")
  assert.equal(result.reason, "output-or-exit-unconfirmed")
  assert.equal(result.stopped, true)
  assert.equal(result.truncated, true)
  assert.equal(result.sha256, undefined)
  assert.equal(result.logComplete, false)
  assert.equal(result.logError, "O4E_COMMAND_LOG_CAPTURE_INCOMPLETE")
  assert.equal(result.totalBytes, first.totalBytes)
  assert.equal(result.output, first.output)
  assert.equal(isLive(pid), false)
  assert.deepEqual(await handle.done, first)
  assert.deepEqual(handle.snapshot(), result)
  await waitFor(() => updates.some((value) => value.stopped))
  await port.dispose()
  assert.deepEqual(await handle.cancel(), result)
  assert.equal(signals.mock.calls.filter(({ arguments: args }) => args[1] !== 0).length, 1)
  assert.equal(fs.readFileSync(join(directory, "invocations"), "utf8"), "x")
})

test("EACCES on unrelated /proc/1/stat cannot veto TERM to an independently owned group", linux, async (t) => {
  const { port } = fixture(t)
  const handle = port.start({ executionID: "unrelated-proc", command: "printf '%s' $$; exec sleep 20" })
  await waitFor(() => handle.snapshot().output)
  const pid = Number(handle.snapshot().output)
  const read = fs.readFileSync
  const denied = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === "/proc/1/stat") throw Object.assign(new Error("unrelated-proc-private"), { code: "EACCES" })
    return read(path, ...args)
  })
  const kill = t.mock.method(process, "kill")
  const result = await handle.cancel()
  assert.ok(denied.mock.calls.some(({ arguments: args }) => args[0] === "/proc/1/stat"))
  assert.deepEqual(kill.mock.calls.filter(({ arguments: args }) => args[1] !== 0).map(({ arguments: args }) => args), [[-pid, "SIGTERM"]])
  assert.equal(result.status, "cancelled")
  assert.equal(result.stopped, true)
  assert.equal(isLive(pid), false)
})

test("an incomplete census still stops an owned leaderless group but cannot prove zombie-only stop", linux, async (t) => {
  const { directory, port } = fixture(t)
  const handle = port.start({ executionID: "leaderless-proc", command: "sleep 20 >/dev/null 2>&1 & printf '%s %s' $$ $!; while [ ! -e release ]; do sleep 0.02; done" })
  await waitFor(() => handle.snapshot().output.includes(" "))
  const [pid, memberPID] = handle.snapshot().output.split(" ").map(Number)
  const read = fs.readFileSync
  const denied = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === "/proc/1/stat") throw Object.assign(new Error("unrelated-proc-private"), { code: "EACCES" })
    return read(path, ...args)
  })
  const kill = process.kill
  const signals = t.mock.method(process, "kill", (target, signal) => {
    // Keep existence probing conservative even if this host promptly reaps zombies.
    if (target === -pid && signal === 0) return true
    return kill.call(process, target, signal)
  })
  fs.writeFileSync(join(directory, "release"), "")
  await waitFor(() => !isLive(memberPID))
  assert.ok(signals.mock.calls.some(({ arguments: args }) => args[0] === -pid && args[1] === "SIGTERM"))
  assert.equal(handle.snapshot().stopped, false)
  const first = await handle.done
  assert.equal(first.status, "unknown")
  assert.equal(first.stopped, false)
  denied.mock.restore()
  signals.mock.restore()
  assert.equal((await handle.cancel()).stopped, true)
  assert.deepEqual(await handle.done, first)
})

test("EACCES on the owned leader refuses signals until identity can be checked again", linux, async (t) => {
  const { port } = fixture(t)
  const handle = port.start({ executionID: "own-proc", command: "printf '%s' $$; exec sleep 20" })
  await waitFor(() => handle.snapshot().output)
  const pid = Number(handle.snapshot().output)
  const read = fs.readFileSync
  const denied = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === `/proc/${pid}/stat`) throw Object.assign(new Error("own-proc-private"), { code: "EACCES" })
    return read(path, ...args)
  })
  const kill = t.mock.method(process, "kill")
  const first = await handle.cancel()
  assert.equal(first.status, "unknown")
  assert.equal(first.stopped, false)
  assert.equal(kill.mock.calls.filter(({ arguments: args }) => args[1] !== 0).length, 0)
  denied.mock.restore()
  assert.equal((await handle.cancel()).stopped, true)
  assert.equal(isLive(pid), false)
  assert.deepEqual(await handle.done, first)
})

test("a changed leader start-time refuses signals instead of killing a reused PID", linux, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "o4e-command-reuse-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const port = createCommandExecutionPort({ directory })
  const handle = port.start({ executionID: "reuse", command: "printf '%s' $$; sleep 0.2" })
  await waitFor(() => handle.snapshot().output)
  const pid = Number(handle.snapshot().output)
  const read = fs.readFileSync
  const original = read(`/proc/${pid}/stat`, "utf8")
  const mocked = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path !== `/proc/${pid}/stat`) return read(path, ...args)
    const text = original
    const boundary = text.lastIndexOf(")") + 2
    const fields = text.slice(boundary).trim().split(/\s+/)
    fields[19] = String(BigInt(fields[19]) + 1n)
    return text.slice(0, boundary) + fields.join(" ")
  })
  const kill = t.mock.method(process, "kill")
  const result = await handle.cancel()
  assert.equal(result.status, "unknown")
  assert.equal(result.stopped, false)
  assert.equal(kill.mock.calls.filter(({ arguments: args }) => args[1] !== 0).length, 0)
  await assert.rejects(port.dispose(), { code: "O4E_COMMAND_DISPOSE_UNCONFIRMED" })
  mocked.mock.restore()
  await port.dispose()
})

test("fresh host process has no handle and never adopts a PID", linux, async (t) => {
  const { directory, port } = fixture(t)
  const handle = port.start({ executionID: "host-local", command: "printf ready; sleep 20" })
  await waitFor(() => handle.snapshot().output)
  const url = new URL("../src/command-core/command-execution-port.mjs", import.meta.url).href
  const source = `import { createCommandExecutionPort } from ${JSON.stringify(url)}; const port = createCommandExecutionPort({ directory: ${JSON.stringify(directory)} }); if (port.get('host-local') !== undefined) process.exitCode = 1; await port.dispose()`
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: directory, stdio: "ignore" })
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
  assert.equal(code, 0)
  assert.equal(handle.snapshot().status, "running")
})

test("invalid input fails closed while supported host platforms remain constructible", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    const port = createCommandExecutionPort()
    await port.dispose()
  } finally { Object.defineProperty(process, "platform", platform) }
  if (process.platform !== "linux") return
  const { port } = fixture(t)
  for (const invalid of [{ timeout: 0 }, { timeout: NaN }, { timeout: 2147483648 }, { command: "private\0value" }, { cwd: "private\0value" }, { onUpdate: "private-value" }]) {
    assert.throws(() => port.start({ executionID: "invalid", command: "true", ...invalid }), { message: "O4E_COMMAND_INVALID_ARGUMENTS", code: "O4E_COMMAND_INVALID_ARGUMENTS" })
  }
  assert.throws(() => createCommandExecutionPort({ directory: "\0private-path" }), { message: "O4E_COMMAND_INVALID_DIRECTORY_OR_PROC" })
})
