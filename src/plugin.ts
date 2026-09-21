import type { Plugin } from "@opencode-ai/plugin"
import { createOpenCodeHooks } from "./adapters/opencode/plugin-hooks.ts"

export const OpenCodeForEverythingPlugin: Plugin = createOpenCodeHooks
