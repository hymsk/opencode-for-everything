import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripJsonComments } from "../../src/jsonc.mjs"
import { materializeDefaultAgentMetadata } from "../../scripts/installer.mjs"

export function resolveConfigPath(configRoot, name) {
  const baseName = name.replace(/\.json$/, "")
  const jsoncPath = join(configRoot, `${baseName}.jsonc`)
  return existsSync(jsoncPath) ? jsoncPath : join(configRoot, `${baseName}.json`)
}

export function readConfigJson(configRoot, name) {
  const path = resolveConfigPath(configRoot, name)
  const content = readFileSync(path, "utf8")
  return JSON.parse(path.endsWith(".jsonc") ? stripJsonComments(content) : content)
}

export function writeConfigJson(path, value) {
  const jsoncPath = path.replace(/\.json$/, ".jsonc")
  writeFileSync(existsSync(jsoncPath) ? jsoncPath : path, `${JSON.stringify(value, null, 2)}\n`)
}

export function copyInstalledDefaults(componentRoot, target, { language = "zh" } = {}) {
  const configRoot = join(target, ".o4e")
  cpSync(join(componentRoot, "defaults", ".o4e"), configRoot, { recursive: true })
  const soulLanguage = language === "en" ? "en" : "zh"
  writeFileSync(join(configRoot, "soul.md"), readFileSync(join(configRoot, `soul.${soulLanguage}.md`)))
  rmSync(join(configRoot, "soul.zh.md"), { force: true })
  rmSync(join(configRoot, "soul.en.md"), { force: true })
  const catalogPath = join(configRoot, "agents", "default.jsonc")
  const catalog = JSON.parse(stripJsonComments(readFileSync(catalogPath, "utf8")))
  for (const agent of catalog.agents) {
    const path = join(configRoot, "agents", agent.type, `${agent.id}.jsonc`)
    if (!existsSync(path)) continue
    const content = materializeDefaultAgentMetadata(readFileSync(path, "utf8"), agent, language, `${agent.id} test Agent configuration`)
    writeFileSync(path, content)
  }
  rmSync(catalogPath)
  return configRoot
}
