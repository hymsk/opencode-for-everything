import { readV2Definition, v2Status } from "./compat.mjs"

// This is a local configuration preview, not a server/session health check.
// Never show paths, definition contents, host credentials, or exception text.
export function formatV2TuiStatus(definition) {
  const status = v2Status(definition)
  return [
    `Local O4E configuration: ${status.configured ? "found" : "not active"}`,
    `Configured agents: ${status.configuredAgentCount ?? 0}`,
    `Configured MCP servers (not registered): ${status.configuredMcpServerCount ?? 0}`,
    "O4E V2 managed execution: unavailable",
    "This preview does not inspect the server, restrict native tools, or run tasks.",
  ].join("\n")
}

export function createV2TuiPlugin(define, { read = readV2Definition } = {}) {
  return define({
    id: "opencode-for-everything-v2-cli-preview",
    setup(ctx) {
      if (typeof ctx?.keymap?.layer !== "function" || typeof ctx?.ui?.slot !== "function" || typeof ctx?.ui?.dialog?.alert !== "function") {
        throw new Error("O4E_V2_CLI_STATUS_UNAVAILABLE")
      }
      // Keymap.layer requires a Solid UI owner. setup() has none. A local,
      // invisible additive app slot supplies a component owner, and the host
      // releases the layer with it. Only this slot's disposer is ours.
      return ctx.ui.slot({ append: "app", render: () => {
        ctx.keymap.layer(() => ({
        mode: "global",
        commands: [{
          id: "o4e.v2.preview.status",
          title: "O4E V2 compatibility status",
          description: "Read-only local preview; managed execution is unavailable",
          group: "O4E",
          palette: true,
          slash: { name: "o4e-v2-status" },
          async run() {
            let message
            try {
              const directory = ctx.location?.directory
              if (typeof directory !== "string" || !directory) throw new Error("O4E_V2_LOCATION_UNAVAILABLE")
              message = formatV2TuiStatus(read(directory))
            } catch {
              // An invalid selected config must not fall back to global or
              // display a success-shaped status (or leak exception details).
              message = "O4E V2 configuration unavailable or invalid. Managed execution is unavailable."
            }
            await ctx.ui.dialog.alert({ title: "O4E V2 preview", message })
          },
        }],
        }))
        return null
      } })
    },
  })
}
