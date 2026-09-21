import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, parse, relative, resolve } from "node:path"

const fileCache = new Map()

// Optional prompt sources must stay within their root and use ordinary files.
export function readPromptFile(path, root = parse(resolve(path)).root) {
  try {
    const target = resolve(path)
    const boundary = resolve(root)
    const pathRelative = relative(boundary, target)
    if (pathRelative === ".." || pathRelative.startsWith("../") || pathRelative.startsWith("..\\") || isAbsolute(pathRelative)) return null
    if (!lstatSync(boundary).isDirectory()) return null

    let current = boundary
    let mtimeMs
    for (const part of pathRelative.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part)
      const stat = lstatSync(current)
      if (current === target) {
        if (!stat.isFile() || stat.nlink !== 1) return null
        mtimeMs = stat.mtimeMs
      } else if (!stat.isDirectory()) return null
    }
    const realRelative = relative(realpathSync(boundary), realpathSync(target))
    if (realRelative === ".." || realRelative.startsWith("../") || realRelative.startsWith("..\\") || isAbsolute(realRelative)) return null

    const cached = fileCache.get(path)
    if (cached?.mtimeMs === mtimeMs) return cached.content
    const content = readFileSync(path, "utf8")
    fileCache.set(path, { mtimeMs, content })
    return content
  } catch {
    return null
  }
}
