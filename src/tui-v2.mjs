// Separate V2 CLI plugin: no V1 TUI imports or managed Task UI.
// The public subpath avoids loading the optional Solid renderer used by
// @opencode/plugin/tui's barrel; this CLI command has no JSX dependency.
import * as Plugin from "@opencode/plugin/tui/plugin"
import { createV2TuiPlugin } from "./adapters/opencode-v2/tui-status.mjs"

export default createV2TuiPlugin(Plugin.define)
