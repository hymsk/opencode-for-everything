import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

const BUDGET = Object.freeze({ totalMs: 600000, cleanupMs: 5000, setupStepMs: 90000, responseBytes: 1024 * 1024 })
export const MODELS = Object.freeze({ parent: "gpt-5.6-luna", child: "Mimo/Mimo-V2.5-Pro" })
export const PROVIDERS = Object.freeze({ parent: "newapi-openai", child: "newapi-xiaomi" })
export const REASONS = Object.freeze(["ARGUMENTS", "ROLE", "SEQUENCE", "IDENTITY", "INTEGRITY", "CONFIG",
  "PRODUCTION", "PERMISSION", "QUESTION", "HOST_ERROR", "TOTAL_BUDGET", "REQUEST_BUDGET",
  "CALL_BUDGET", "BYTE_BUDGET", "TRANSPORT", "ADMISSION", "SETUP", "SOURCE", "EVIDENCE", "SIGNAL", "CLEANUP"])
export const hash = (value) => createHash("sha256").update(value).digest("hex")
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const json = (value) => { try { return typeof value === "string" ? JSON.parse(value) : undefined } catch {} }
const check = (condition, code) => { if (!condition) throw new Error(REASONS.includes(code) ? code : "SETUP") }

export function parseCLI(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    check(["--source", "--run-root", "--mode", "--provider-config", "--key-resolver"].includes(key)
      && !Object.hasOwn(options, key) && typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--"), "ARGUMENTS")
    options[key] = argv[i + 1]
  }
  const source = options["--source"], root = options["--run-root"], mode = options["--mode"]
  check(typeof source === "string" && isAbsolute(source) && resolve(source) === source, "ARGUMENTS")
  check(typeof root === "string" && /^\/tmp\/opencode\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(root), "ARGUMENTS")
  check(["controlled", "live"].includes(mode) && source !== root && !source.startsWith(root + "/") && !root.startsWith(source + "/"), "ARGUMENTS")
  const privatePaths = [options["--provider-config"], options["--key-resolver"]]
  check(mode === "live" ? privatePaths.every((path) => typeof path === "string" && isAbsolute(path) && resolve(path) === path
    && !path.startsWith(root + "/")) : privatePaths.every((path) => path === undefined), "ARGUMENTS")
  return { source, root, mode, providerConfig: privatePaths[0], keyResolver: privatePaths[1] }
}

export function streamEvidence(bytes) {
  if (bytes.byteLength > BUDGET.responseBytes) return { complete: false }
  const text = Buffer.from(bytes).toString("utf8")
  let done = 0, finish = 0, events = 0, invalid = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (data === "[DONE]") { done++; continue }
    const value = json(data)
    if (done || !object(value) || value.error || !Array.isArray(value.choices) || value.choices.length > 1
      || value.choices.some((choice) => choice?.index !== 0)) { invalid = true; continue }
    events++
    for (const choice of value.choices) if (choice.finish_reason != null) {
      if (!["stop", "tool_calls"].includes(choice.finish_reason)) invalid = true
      finish++
    }
  }
  return { complete: !invalid && done === 1 && finish === 1 && events > 0 }
}

function fileBytes(path, max = 1024 * 1024) {
  const stat = lstatSync(path)
  check(stat.isFile() && stat.nlink === 1 && stat.size <= max, "INTEGRITY")
  return readFileSync(path)
}

export async function sourceSnapshot(source, command) {
  const git = async (...args) => (await command("git", ["-c", "core.fsmonitor=false", ...args], { cwd: source, capture: true })).stdout
  check((await git("rev-parse", "--show-toplevel")).trim() === source, "SOURCE")
  const status = (await git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none")).split("\0")
  for (let i = 0; i < status.length - 1; i++) {
    check(/^[MADRTC]  .+$/s.test(status[i]), "SOURCE")
    if ("RC".includes(status[i][0])) check(!!status[++i], "SOURCE")
  }
  const entries = (await git("ls-files", "--stage", "-z")).split("\0").filter(Boolean)
  check(entries.length > 0, "SOURCE")
  for (const entry of entries) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/s.exec(entry)
    check(!!match, "SOURCE")
    const [, mode, oid, name] = match, path = resolve(source, name)
    check(path.startsWith(source + "/") && realpathSync(dirname(path)) === dirname(path), "SOURCE")
    const stat = lstatSync(path)
    check(mode === "120000" ? stat.isSymbolicLink() : stat.isFile() && !!(stat.mode & 0o111) === (mode === "100755"), "SOURCE")
    const bytes = mode === "120000" ? Buffer.from(readlinkSync(path)) : fileBytes(path, 32 * 1024 * 1024)
    check(createHash(oid.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === oid, "SOURCE")
  }
  const head = (await git("rev-parse", "HEAD")).trim(), tree = (await git("write-tree")).trim()
  check([head, tree].every((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)), "SOURCE")
  return { head, tree }
}

// A dedicated subreaper prevents double-fork/setsid descendants escaping between
// /proc scans. pidfds pin the (pid, starttime) identity at every signal, not just
// at discovery. No negative-PID signal or user service is used.
const PROCESS_SUPERVISOR = String.raw`
import ctypes, json, os, select, signal, subprocess, sys, time
timeout, cleanup = float(sys.argv[1]), float(sys.argv[2])
assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
owner = os.getpid()
probe = os.pidfd_open(owner)
signal.pidfd_send_signal(probe, 0)
os.close(probe)
tracked = {}
seen = set()
stopping = None
failed = False
def stat(pid):
    try:
        with open("/proc/%d/stat" % pid) as stream:
            fields = stream.read().rsplit(")", 1)[1].split()
        return (int(fields[1]), fields[19], fields[0])
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
def discover():
    table = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            row = stat(int(name))
            if row is not None:
                table[int(name)] = row
    accepted = {owner: stat(owner)}
    changed = True
    while changed:
        changed = False
        for pid, row in table.items():
            if pid in accepted or row[0] not in accepted:
                continue
            parent = stat(row[0])
            current = stat(pid)
            if parent is None or parent[1] != accepted[row[0]][1] or current is None or current[:2] != row[:2]:
                continue
            accepted[pid] = row
            changed = True
            if row[2] in ("Z", "X") or pid in tracked:
                continue
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            current = stat(pid)
            if current is None or current[:2] != row[:2]:
                os.close(fd)
                continue
            tracked[pid] = (row[1], fd)
            seen.add((pid, row[1]))
    for pid, (birth, fd) in list(tracked.items()):
        row = stat(pid)
        if row is None or row[1] != birth or row[2] in ("Z", "X"):
            os.close(fd)
            del tracked[pid]
def send(sig):
    for pid, (birth, fd) in list(tracked.items()):
        row = stat(pid)
        if row is not None and row[1] == birth and row[2] not in ("Z", "X"):
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass
def stop(*args):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
started = time.monotonic()
child = subprocess.Popen(sys.argv[3:], stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)
code = None
empty = 0
while True:
    discover()
    code = child.poll()
    if code is not None:
        stop()
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
    if select.select([3], [], [], 0)[0]:
        try:
            os.read(3, 1024)
        except ConnectionResetError:
            pass
        stop()
    if time.monotonic() - started >= timeout:
        failed = True
        stop()
    if stopping is not None:
        send(signal.SIGTERM if time.monotonic() - stopping < min(1, cleanup / 3) else signal.SIGKILL)
        with open("/proc/%d/task/%d/children" % (owner, owner)) as stream:
            children = stream.read().strip()
        empty = empty + 1 if not tracked and not children and code is not None else 0
        if empty >= 3:
            break
        if time.monotonic() - stopping >= cleanup:
            failed = True
            break
    time.sleep(0.01)
discover()
if tracked:
    send(signal.SIGKILL)
    failed = True
result = {"cleaned": not tracked and code is not None, "exitCode": code, "tracked": len(seen), "timedOut": failed}
os.write(4, (json.dumps(result) + "\n").encode())
for birth, fd in tracked.values():
    os.close(fd)
sys.exit(0 if result["cleaned"] and not failed else 1)
`

export function spawnOwnedProcess(binary, args, { cwd, env, timeout = BUDGET.setupStepMs, cleanupMs = BUDGET.cleanupMs - 1000 } = {}) {
  check(process.platform === "linux" && timeout > 0 && timeout <= BUDGET.totalMs && cleanupMs > 0 && cleanupMs < BUDGET.cleanupMs, "SETUP")
  const child = spawn("/usr/bin/python3", ["-I", "-c", PROCESS_SUPERVISOR, String(timeout / 1000), String(cleanupMs / 1000), binary, ...args],
    { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] })
  let receipt = ""
  child.stdio[3].on("error", () => {})
  child.stdio[4].on("data", (bytes) => { if (receipt.length <= 1024) receipt += bytes.toString() })
  const result = once(child, "close").then(([code, signal]) => {
    const value = receipt.length <= 1024 ? json(receipt) : undefined
    check(code === 0 && signal === null && value?.cleaned === true && value.timedOut === false
      && Number.isInteger(value.exitCode) && Number.isSafeInteger(value.tracked) && value.tracked >= 0, "CLEANUP")
    return value
  })
  return { child, result, stop: () => { if (!child.stdio[3].writableEnded) child.stdio[3].end() } }
}
