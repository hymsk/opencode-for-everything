import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import acceptancePlugin from "./resume-acceptance-plugin.mjs"
import { BUDGET, MODELS, PROVIDERS, READY, createSequence, fileBytes, filesUnchanged, toolAdmission } from "./resume-closure-runner.mjs"
import { REASONS, hash } from "./common.mjs"

// OpenCode loads each export as a plugin. Keep exactly one, composing exactly one production instance.
export default async function (input) {
  let manifest
  try { manifest = JSON.parse(fileBytes(process.env.O4E_RESUME_MANIFEST, 1024 * 1024, true)) }
  catch { throw new Error("O4E_RESUME_GUARD_CONFIG") }
  const { project, audit, proxy, immutable, deadline } = manifest
  const runtimeID = randomUUID(), roles = new Map(), sessions = new Map(), active = new Map(), sequence = createSequence()
  let configured = false, failed = false
  const log = (entry) => {
    try { appendFileSync(audit, JSON.stringify({ ...entry, runtimeID }) + "\n", { mode: 0o600 }) }
    catch { throw new Error("O4E_RESUME_GUARD_INTEGRITY") }
  }
  const deny = async (reason, idError = false) => {
    const safe = REASONS.includes(reason) ? reason : "PRODUCTION"
    if (!failed) {
      failed = true; log({ kind: "DENIED", reason: safe, idError })
      await fetch(proxy + "/abort", { method: "POST", headers: { authorization: `Bearer ${process.env.O4E_RESUME_LOCAL_KEY}` },
        body: JSON.stringify({ reason: safe, idError }), signal: AbortSignal.timeout(1000) }).catch(() => {})
    }
    throw new Error("O4E_RESUME_GUARD_DENIED")
  }
  // Bound even a production hook stalled on SDK I/O. Tool timers also cover the unmodified execute body.
  const bounded = async (operation, ms = 10000) => {
    let timer
    try {
      if (failed || Date.now() >= deadline) return await deny("TOTAL_BUDGET")
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("REQUEST_BUDGET")), Math.max(1, Math.min(ms, deadline - Date.now())))
      })])
    } catch (error) { return deny(REASONS.includes(error?.message) ? error.message : "PRODUCTION", error?.message === "Expected 'id' to be a string.") }
    finally { clearTimeout(timer) }
  }
  if (input.directory !== project || input.worktree !== project || !filesUnchanged(immutable)) return deny("INTEGRITY")
  const singleton = Symbol.for("o4e.resume.closure.runtime")
  if (globalThis[singleton]) return deny("IDENTITY")
  globalThis[singleton] = runtimeID
  const hooks = await bounded(() => acceptancePlugin(input))
  if (!["task", "o4e_task", "acceptance_wait", "acceptance_evidence"].every((name) => typeof hooks.tool?.[name]?.execute === "function")) return deny("PRODUCTION")
  const roleFor = (request) => request.agent === "inspect-main" ? "parent" : request.agent === "inspect-child" ? "child" : undefined
  const identify = async (request) => {
    const role = roleFor(request)
    if (!configured || !role || !/^ses_[A-Za-z0-9]{20,40}$/.test(request.sessionID)) return deny("ROLE")
    if (sessions.has(role) && sessions.get(role) !== request.sessionID || roles.has(request.sessionID) && roles.get(request.sessionID) !== role
      || role === "child" && sequence.task && request.sessionID !== sequence.task.sessionID) return deny("IDENTITY")
    sessions.set(role, request.sessionID); roles.set(request.sessionID, role)
    return role
  }
  return {
    ...hooks,
    config: async (config) => {
      await bounded(() => hooks.config?.(config))
      if (configured || config.plugin?.length !== 1 || Object.keys(config.mcp ?? {}).length !== 0
        || config.agent?.["inspect-main"]?.mode !== "primary" || config.agent?.["inspect-child"]?.mode !== "subagent") return deny("CONFIG")
      configured = true; log({ kind: "READY" }); console.error(READY)
    },
    "chat.message": async (request, result) => {
      await bounded(() => hooks["chat.message"]?.(request, result))
    },
    "chat.params": async (request, result) => {
      const role = await identify(request)
      if (request.model?.id !== MODELS[role] || request.model?.providerID !== PROVIDERS[role]) return deny("ROLE")
      await bounded(() => hooks["chat.params"]?.(request, result))
      result.maxOutputTokens = BUDGET[`${role}Tokens`]
    },
    "chat.headers": async (request, result) => {
      await bounded(() => hooks["chat.headers"]?.(request, result))
      const role = roles.get(request.sessionID)
      if (!role) return deny("ROLE")
      result.headers["x-o4e-acceptance-role"] = role; result.headers["x-o4e-acceptance-runtime"] = runtimeID
    },
    "tool.execute.before": async (request, result) => {
      if (failed || Date.now() >= deadline) return deny("TOTAL_BUDGET")
      if (!filesUnchanged(immutable)) return deny("INTEGRITY")
      const role = roles.get(request.sessionID)
      let operation
      try { operation = sequence.before(role, request.tool, result.args, request.callID) }
      catch (error) { return deny(error.message) }
      const inputHash = hash(JSON.stringify(result.args))
      const timer = setTimeout(() => { void deny("REQUEST_BUDGET").catch(() => {}) }, Math.min(BUDGET.toolMs, deadline - Date.now()))
      active.set(role, { callID: request.callID, operation, inputHash, timer, startedAt: Date.now() })
      log({ kind: "ADMIT", operation, callHash: hash(request.callID), sessionHash: hash(request.sessionID), inputHash })
      await bounded(() => hooks["tool.execute.before"]?.(request, result))
      if (hash(JSON.stringify(result.args)) !== inputHash || toolAdmission(role, request.tool, result.args) !== operation) return deny("ARGUMENTS")
    },
    "tool.execute.after": async (request, result) => {
      const role = roles.get(request.sessionID), admitted = active.get(role)
      if (!admitted || admitted.callID !== request.callID || !filesUnchanged(immutable)) return deny("INTEGRITY")
      await bounded(() => hooks["tool.execute.after"]?.(request, result), Math.max(1, BUDGET.toolMs - (Date.now() - admitted.startedAt)))
      try { sequence.after(role, request.callID, result.output, result.metadata) } catch (error) { return deny(error.message) }
      if (sequence.task && sessions.has("child") && sessions.get("child") !== sequence.task.sessionID) return deny("IDENTITY")
      if (failed || Date.now() - admitted.startedAt > BUDGET.toolMs) return deny("REQUEST_BUDGET")
      clearTimeout(admitted.timer); active.delete(role)
      log({ kind: "COMPLETE", operation: admitted.operation, callHash: hash(request.callID), sessionHash: hash(request.sessionID),
        inputHash: admitted.inputHash, outputHash: hash(result.output) })
    },
    event: async (request) => {
      const type = request.event?.type
      const properties = request.event?.properties
      const error = properties?.error ?? properties?.info?.error
      const reason = ["permission.asked", "permission.v2.asked", "permission.updated"].includes(type) ? "PERMISSION"
        : ["question.asked", "question.v2.asked"].includes(type) ? "QUESTION"
          : type === "session.error" || type === "message.updated" && error
            || type === "message.part.updated" && properties?.part?.state?.status === "error" ? "HOST_ERROR" : undefined
      if (reason) { await deny(reason, error?.data?.message === "Expected 'id' to be a string." || error?.message === "Expected 'id' to be a string.").catch(() => {}); return }
      await bounded(() => hooks.event?.(request)).catch(() => {})
    },
    dispose: async () => {
      for (const entry of active.values()) clearTimeout(entry.timer)
      await bounded(() => hooks.dispose?.()).catch(() => {})
      log({ kind: "DISPOSE" })
    },
  }
}
