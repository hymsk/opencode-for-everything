import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export default async function (input) {
  const packageDir = join(input.directory, ".opencode", "node_modules", "@opencode-ai", "plugin")
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
  await import(pathToFileURL(join(packageDir, pkg.exports["./tool"].import)).href)
  const { OpenCodeForEverythingPlugin } = await import(pathToFileURL(join(
    input.directory, ".opencode", "plugins", "opencode-for-everything.ts",
  )).href)
  return OpenCodeForEverythingPlugin(input)
}
