import { spawn } from "node:child_process"
import fs from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

export const TERM_GRACE = 3000
export const KILL_GRACE = 1000

export function processStat(path) {
  try {
    const text = fs.readFileSync(path, "utf8")
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/)
    if (!/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3])) return undefined
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19] }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined
    throw error
  }
}

export async function stopWindowsProcessTree(pid, { graceMs = TERM_GRACE, isStopped = () => false } = {}) {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
  const result = await new Promise((resolve) => {
    killer.once("error", (error) => resolve({ error }))
    killer.once("exit", (code, signal) => resolve({ code, signal }))
  })
  if (result.error || result.code !== 0) return false
  const deadline = performance.now() + graceMs
  while (performance.now() < deadline && !isStopped()) await delay(50)
  return isStopped()
}

export function createProcessTreeController({ platform = process.platform, signal = process.kill } = {}) {
  return Object.freeze({
    inspect(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return { stopped: false, signalSafe: false }
      if (platform === "win32") return { stopped: false, signalSafe: true }
      try { signal(-pid, 0); return { stopped: false, signalSafe: true } }
      catch (error) { return error?.code === "ESRCH" ? { stopped: true, signalSafe: false } : { stopped: false, signalSafe: false } }
    },
    stop(pid, name = "SIGTERM") {
      if (!Number.isInteger(pid) || pid <= 1) return false
      if (platform === "win32") return false
      try { signal(-pid, name); return true } catch { return false }
    },
  })
}
