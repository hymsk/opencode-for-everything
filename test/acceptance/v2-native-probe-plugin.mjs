// Test-only, installed exclusively in a fresh credential-free fixture.
// No production O4E runtime, no private host API, no permission rule changes.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readV2SessionAncestry } from "./session-ancestry.mjs"

export default {
  id: "o4e-v2-native-acceptance-only",
  async setup(ctx) {
    const root = ctx.location.directory
    const config = JSON.parse(readFileSync(join(root, "probe.json"), "utf8"))
    const record = (type, value = {}) => appendFileSync(join(root, "evidence.jsonl"), JSON.stringify({ type, ...value }) + "\n")
    const handles = []
    let timer
    handles.push(await ctx.session.hook("model.request", (event) => {
      if (event.model.providerID !== "fixture") throw new Error("NON_FIXTURE_MODEL_REFUSED")
      record("model", { agent: event.agent, model: event.model, kind: event.kind })
    }))
    handles.push(await ctx.permission.hook("evaluate", (event) => {
      record("permission", { action: event.action, resources: event.resources, effect: event.effect,
        sessionID: event.sessionID, source: event.source })
    }))
    if (config.parentHook) handles.push(await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell") return
      if (config.parentLookupFail) {
        // Exercise a real rejection from the public Session API rather than
        // fabricating a failure before attempting the lookup.
        try {
          await ctx.session.get({ sessionID: "ses_fixture_missing_parent" })
        } catch (error) {
          record("parent-hook-lookup-failed", { error: String(error.message).slice(0, 120) })
          throw error
        }
        throw new Error("FIXTURE_MISSING_PARENT_UNEXPECTEDLY_FOUND")
      }
      if (config.boundedAncestry) {
        const ancestry = await readV2SessionAncestry({ sessionID: event.sessionID,
          getSession: (request) => ctx.session.get(request), maxDepth: 1 })
        record("ancestry", { agents: ancestry.map((entry) => entry.agent), depth: ancestry.length - 1 })
        if (ancestry.length > 1 && ancestry[1].agent === "o4e-native-probe"
          && event.resources.some((resource) => resource.includes("O4E_NATIVE_SENTINEL"))) {
          event.effect = "deny"
          record("parent-hook-denied", { sessionID: event.sessionID })
        }
        return
      }
      const currentResponse = await ctx.session.get({ sessionID: event.sessionID })
      const current = currentResponse.data ?? currentResponse
      const parentResponse = current.parentID && await ctx.session.get({ sessionID: current.parentID })
      const parent = parentResponse && (parentResponse.data ?? parentResponse)
      record("parent-hook", { sessionID: event.sessionID, parentID: current.parentID,
        agent: event.agent, storedAgent: current.agent, parentAgent: parent?.agent, before: event.effect })
      // No hard-coded parent ID, prompt marker, or inferred ancestor from model text.
      if (parent?.agent === "o4e-native-probe" && event.resources.some((resource) => resource.includes("O4E_NATIVE_SENTINEL"))) {
        event.effect = "deny"
        record("parent-hook-denied", { sessionID: event.sessionID })
      }
    }))
    handles.push(await ctx.tool.transform((editor) => {
      if (config.delegation) editor.update("subagent", (tool) => { tool.options = { ...tool.options, codemode: false } })
      const tool = editor.get("shell")
      if (!tool) throw new Error("NATIVE_SHELL_MISSING")
      editor.update("shell", (draft) => {
        draft.options = { ...draft.options, codemode: false }
        if (!config.wrapped) return
        const original = draft.execute
        draft.execute = async (input, context) => {
          record("wrapper-enter", { sessionID: context.sessionID, messageID: context.messageID, callID: context.id, agent: context.agent })
          if (config.cancel) {
            timer = setInterval(() => {
              if (!existsSync(join(root, "started"))) return
              clearInterval(timer)
              record("interrupt-requested")
              void ctx.session.interrupt({ sessionID: context.sessionID }).then(() => record("interrupt-returned"),
                (error) => record("interrupt-error", { message: String(error.message) }))
            }, 50)
          }
          try {
            const result = await original(input, context)
            record("wrapper-returned")
            return result
          } catch (error) {
            record("wrapper-error", { message: String(error.message) })
            throw error
          }
        }
      })
    }))
    handles.push(await ctx.session.hook("context", async (event) => {
      if (!["o4e-native-probe", "o4e-native-child"].includes(event.agent)) return
      const response = await ctx.agent.get({ agentID: event.agent })
      const agent = response.data ?? response
      record("agent", { id: agent.id, mode: agent.mode, model: agent.model, permissions: agent.permissions,
        marker: agent.system?.includes("O4E_NATIVE_AGENT_FIXTURE") === true, keys: Object.keys(response) })
      if (config.delegation) {
        const response = await ctx.session.get({ sessionID: event.sessionID })
        const session = response.data ?? response
        record("session", { id: session.id, parentID: session.parentID, agent: event.agent, permissions: session.permissions })
      }
    }))
    return async () => {
      clearInterval(timer)
      for (const handle of handles.reverse()) await handle.dispose()
      record("cleanup")
    }
  },
}
