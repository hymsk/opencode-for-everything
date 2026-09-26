import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { loadRuntimeDefinition } from "../../runtime-builder.mjs"

const marker = "<!--opencode-for-everything-v2-preview-agent:"

// Projection of identity and model only. Never reuse V1 prompts here: they
// describe managed tools which V2 does not offer. The V2 host adds its own
// baseline permissions; the final blanket deny must be last.
export function renderV2PreviewAgent(agent) {
  if (!agent || !["primary", "all", "subagent"].includes(agent.type)
    || typeof agent.name !== "string" || !/^[a-z0-9][a-z0-9-]*(?: \(plan\))?$/.test(agent.name)) {
    throw new Error("O4E_V2_PREVIEW_AGENT_INVALID")
  }
  // Partition plain and Plan names: both "foo-plan" and "foo (plan)" are
  // valid distinct V1 identities and must never collapse into one V2 ID.
  const plan = agent.name.endsWith(" (plan)")
  const name = `o4e-v2-preview-${plan ? "plan" : "agent"}-${plan ? agent.name.slice(0, -" (plan)".length) : agent.name}`
  const description = `Read-only V2 preview of ${agent.name}; O4E managed execution unavailable`
  const model = agent.model?.id
  if (model !== undefined && (typeof model !== "string" || !/^[^\s#/:]+\/[^\s#]+$/.test(model)
    || (agent.model.variant !== undefined && (typeof agent.model.variant !== "string" || !agent.model.variant.trim()
      || /[\r\n#]/.test(agent.model.variant))))) {
    throw new Error("O4E_V2_PREVIEW_MODEL_UNSUPPORTED")
  }
  return {
    name,
    content: `---\ndescription: ${JSON.stringify(description)}\nmode: ${agent.type}\n${model ? `model: ${JSON.stringify(`${model}${agent.model.variant ? `#${agent.model.variant}` : ""}`)}\n` : ""}permissions:\n  - action: "*"\n    resource: "*"\n    effect: deny\n---\n${marker}${name}-->\nThis is an isolated, read-only O4E V2 preview. O4E tools, delegation, Workflow, and managed execution are unavailable. Do not claim their capabilities.\n`,
  }
}

// Explicit isolated output only: never rebuild or modify a user's existing
// .opencode or V1 installation. A nonempty target fails before any write.
export function buildV2PreviewAgents({ configRoot, target }) {
  if (typeof configRoot !== "string" || typeof target !== "string" || !configRoot || !target) {
    throw new Error("O4E_V2_PREVIEW_PATH_REQUIRED")
  }
  if (!isAbsolute(configRoot) || !isAbsolute(target)) throw new Error("O4E_V2_PREVIEW_ABSOLUTE_PATH_REQUIRED")
  const directory = resolve(target)
  const source = realpathSync(configRoot)
  const stat = lstatSync(directory, { throwIfNoEntry: false })
  if (!stat?.isDirectory() || realpathSync(directory) !== directory || readdirSync(directory).length !== 0) {
    throw new Error("O4E_V2_PREVIEW_TARGET_NOT_EMPTY")
  }
  const overlap = (left, right) => {
    const path = relative(left, right)
    return !path || (!path.startsWith("..") && !isAbsolute(path))
  }
  if (overlap(source, directory) || overlap(directory, source)) throw new Error("O4E_V2_PREVIEW_SOURCE_TARGET_OVERLAP")
  const { runtimeAgents } = loadRuntimeDefinition(source)
  const entries = runtimeAgents.map(renderV2PreviewAgent)
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("O4E_V2_PREVIEW_AGENT_CONFLICT")
  let stage
  const publishedRoot = join(directory, ".opencode")
  try {
    stage = mkdtempSync(join(directory, ".o4e-v2-preview-stage-"))
    mkdirSync(join(stage, "agents"))
    const guard = join(stage, "plugins", "o4e-v2-preview-guard")
    mkdirSync(join(stage, "plugins"))
    mkdirSync(guard)
    for (const { name, content } of entries) writeFileSync(join(stage, "agents", `${name}.md`), content, { flag: "wx" })
    writeFileSync(join(guard, "package.json"), '{"type":"module"}\n', { flag: "wx" })
    writeFileSync(join(guard, "index.mjs"), readFileSync(new URL("./preview-guard.mjs", import.meta.url)), { flag: "wx" })
    // This exporter only owns the fresh staging tree and the empty target.
    // If another writer has populated the target meanwhile, refuse promotion.
    if (readdirSync(directory).some((entry) => join(directory, entry) !== stage)) throw new Error("O4E_V2_PREVIEW_TARGET_CHANGED")
    if (realpathSync(directory) !== directory) throw new Error("O4E_V2_PREVIEW_TARGET_CHANGED")
    // mkdir is exclusive: rename(stage, .opencode) on Linux would replace a
    // foreign empty .opencode created after the last readdir check.
    mkdirSync(publishedRoot)
    renameSync(join(stage, "plugins"), join(publishedRoot, "plugins"))
    // Publish the guard first: a partial promotion must never leave newly
    // generated preview Agents loadable without their companion guard.
    renameSync(join(stage, "agents"), join(publishedRoot, "agents"))
    rmSync(stage, { recursive: true })
    stage = undefined
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
    // If promotion fails after mkdir, leave the empty root for inspection:
    // deleting it could erase a foreign empty directory swapped in meanwhile.
  }
  return { names: entries.map((entry) => entry.name), directory: join(directory, ".opencode", "agents"),
    guard: join(directory, ".opencode", "plugins", "o4e-v2-preview-guard") }
}
