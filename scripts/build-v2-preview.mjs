#!/usr/bin/env node
// Deliberately separate from the V1 install/build CLI and its generated output.
import { isAbsolute } from "node:path"
import { buildV2PreviewAgents } from "../src/adapters/opencode-v2/agent-preview-builder.mjs"

const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key || !["--config-root", "--target"].includes(key) || Object.hasOwn(options, key)
    || !value || value.startsWith("--") || !isAbsolute(value)) {
    throw new Error("O4E_V2_PREVIEW_USAGE: --config-root /absolute/.o4e --target /absolute/empty-project")
  }
  options[key] = value
}
const result = buildV2PreviewAgents({ configRoot: options["--config-root"], target: options["--target"] })
console.log(`Created ${result.names.length} guarded, deny-all V2 preview Agent files in ${result.directory}. The guard is at ${result.guard}. Only use in this isolated project; managed execution remains unavailable.`)
