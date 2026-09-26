// This is a standalone guard for an isolated V2 preview project, not O4E
// managed authorization. It never grants permission or installs a tool.
const prefix = "o4e-v2-preview-"
const marker = "<!--opencode-for-everything-v2-preview-agent:"

export function assertPreviewAgent(agent, id) {
  if (!agent || agent.id !== id || !["all", "primary", "subagent"].includes(agent.mode)
    || typeof agent.system !== "string" || !agent.system.includes(`${marker}${id}-->`)
    || !Array.isArray(agent.permissions) || !agent.permissions.length
    || !agent.permissions.every((rule) => rule && typeof rule.action === "string" && typeof rule.resource === "string"
      && ["allow", "ask", "deny"].includes(rule.effect))
    || agent.permissions.at(-1).action !== "*" || agent.permissions.at(-1).resource !== "*"
    || agent.permissions.at(-1).effect !== "deny") throw new Error("O4E_V2_PREVIEW_AGENT_UNVERIFIABLE")
}

export default {
  id: "o4e-v2-isolated-preview-guard",
  async setup(ctx) {
    const handles = []
    try {
      handles.push(await ctx.session.hook("context", async (event) => {
        if (!event.agent.startsWith(prefix)) return
        const response = await ctx.agent.get({ agentID: event.agent })
        assertPreviewAgent(response?.data ?? response, event.agent)
        if (Object.keys(event.tools ?? {}).length) throw new Error("O4E_V2_PREVIEW_TOOLS_VISIBLE")
      }))
      handles.push(await ctx.session.hook("model.request", async (event) => {
        if (!event.agent.startsWith(prefix)) return
        const response = await ctx.agent.get({ agentID: event.agent })
        assertPreviewAgent(response?.data ?? response, event.agent)
      }))
      handles.push(await ctx.permission.hook("evaluate", async (event) => {
        // The host can evaluate a permission outside model requests. Deny
        // requests for Sessions whose own Agent is a preview identity. This
        // does not claim to constrain non-preview child Session identities.
        const response = await ctx.session.get({ sessionID: event.sessionID })
        const session = response?.data ?? response
        if (!session || session.id !== event.sessionID || typeof session.agent !== "string") {
          throw new Error("O4E_V2_PREVIEW_SESSION_UNVERIFIABLE")
        }
        if (session.agent.startsWith(prefix)) event.effect = "deny"
      }))
      return async () => { for (const handle of handles.reverse()) await handle.dispose() }
    } catch (error) {
      for (const handle of handles.reverse()) await handle.dispose()
      throw error
    }
  },
}
