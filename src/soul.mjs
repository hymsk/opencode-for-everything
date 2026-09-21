import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readPromptFile } from "./prompt-file.mjs"

const COMPONENT = "opencode-for-everything"
const SOUL_BLOCK_START = `<!--${COMPONENT}-soul:start-->`
const SOUL_BLOCK_END = `<!--${COMPONENT}-soul:end-->`
const SOUL_BLOCK_RE = new RegExp(`${SOUL_BLOCK_START}[\\s\\S]*?${SOUL_BLOCK_END}\\n*`, "g")

export function resolveSoulContent(configRoot, soulConfig, globalConfigRoot = undefined) {
  if (!soulConfig.enabled) return null

  const globalSoulRoot = globalConfigRoot || join(homedir(), ".config", "opencode", ".o4e")
  const globalSoulPath = soulConfig.globalFile || join(globalSoulRoot, soulConfig.file)
  const projectSoulPath = join(configRoot, soulConfig.file)

  const globalReadRoot = soulConfig.globalFile ? undefined : globalSoulRoot
  const globalSoul = readPromptFile(globalSoulPath, globalReadRoot)?.trim() || null
  const sameSoulPath = resolve(globalSoulPath) === resolve(projectSoulPath)
  const projectSoul = sameSoulPath ? globalSoul : readPromptFile(projectSoulPath, configRoot)?.trim() || null

  if (sameSoulPath) return projectSoul ? { content: projectSoul, path: projectSoulPath, scope: "project" } : null

  if (soulConfig.inheritMode === "extend") {
    const parts = []
    if (globalSoul) parts.push(globalSoul)
    if (projectSoul) parts.push(projectSoul)
    return parts.length > 0 ? { content: parts.join("\n\n---\n\n"), path: projectSoulPath, scope: "project" } : null
  }
  if (projectSoul) return { content: projectSoul, path: projectSoulPath, scope: "project" }
  if (globalSoul) return { content: globalSoul, path: globalSoulPath, scope: "global" }
  return null
}

function injectSoulIntoPrompt(prompt, soulData) {
  const promptWithoutSoul = prompt.replace(SOUL_BLOCK_RE, "").trimStart()
  const pathInfo = `<!-- SOUL_FILE: ${soulData.path} (scope: ${soulData.scope}) -->`
  return `${SOUL_BLOCK_START}\n${pathInfo}\n${soulData.content}\n${SOUL_BLOCK_END}\n\n${promptWithoutSoul}`
}

export function createSoulHandler(configRoot, config, globalConfigRoot = undefined) {
  const soulConfig = config.soul
  if (!soulConfig.enabled) return null

  return {
    transformSystem(output) {
      if (!Array.isArray(output?.system) || output.system.length === 0) return
      for (let index = 0; index < output.system.length; index += 1) {
        output.system[index] = output.system[index].replace(SOUL_BLOCK_RE, "")
      }
      const soulData = resolveSoulContent(configRoot, soulConfig, globalConfigRoot)
      if (!soulData?.content) return
      output.system[0] = injectSoulIntoPrompt(output.system[0], soulData)
    }
  }
}
