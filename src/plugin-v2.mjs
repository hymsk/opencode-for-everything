// Separate OpenCode 2.x entry. Do not load this from the V1 generated plugin:
// @opencode/plugin 2.x and @opencode-ai/plugin 1.x are different host APIs.
import { Plugin } from "@opencode/plugin"
import { createV2Plugin } from "./adapters/opencode-v2/compat.mjs"

export default createV2Plugin(Plugin.define)
