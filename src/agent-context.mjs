import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

function resolveProjectFiles(root, files) {
  const boundary = resolve(root)
  let realBoundary
  try {
    realBoundary = realpathSync(boundary)
  } catch {
    return []
  }
  return files.flatMap((file) => {
    const path = resolve(boundary, file)
    const relativePath = relative(boundary, path)
    if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) return []
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.nlink !== 1) return []
      const realPath = realpathSync(path)
      const realRelativePath = relative(realBoundary, realPath)
      if (realRelativePath === ".." || realRelativePath.startsWith("../") || realRelativePath.startsWith("..\\") || isAbsolute(realRelativePath)) return []
      return [{ scope: "project", file, path: realPath }]
    } catch {
      return []
    }
  })
}

const fileCache = new Map()
function tryRead(path) {
  let signature
  try {
    const stat = statSync(path, { bigint: true })
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch {
    return null
  }
  const cached = fileCache.get(path)
  if (cached?.signature === signature) return cached.content
  try {
    const content = readFileSync(path, "utf8")
    fileCache.set(path, { signature, content })
    return content
  } catch {
    return null
  }
}

export function loadInstructionFiles(files, { projectRoot }) {
  const instructions = []
  const seen = new Set()
  for (const { scope, file, path } of [
    ...files.global.map((file) => ({ scope: "global", file, path: file })),
    ...resolveProjectFiles(projectRoot, files.project),
  ]) {
    if (seen.has(path)) continue
    seen.add(path)
    const content = tryRead(path)?.trim()
    if (content) instructions.push({ scope, file, content })
  }
  return instructions
}

export function formatInstructionFiles(instructions) {
  if (instructions.length === 0) return ""
  return instructions.map(({ scope, file, content }) => `# ${scope}: ${file}\n${content}`).join("\n\n")
}
