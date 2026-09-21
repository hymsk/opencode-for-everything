import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

function realpathWithMissingLeaf(candidate) {
  const missing = []
  let current = candidate
  while (true) {
    try {
      const existing = realpathSync(current)
      if (missing.length > 0 && !lstatSync(existing).isDirectory()) {
        throw new Error(`directory 必须指向目录: ${candidate}`)
      }
      return missing.reduceRight((path, part) => resolve(path, part), existing)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      try {
        lstatSync(current)
        throw new Error(`路径包含无法解析的符号链接: ${candidate}`)
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError
      }
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

export function canonicalDirectoryKey(directory) {
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new Error("directory 必须是非空路径")
  }
  const key = realpathWithMissingLeaf(resolve(directory))
  try {
    if (!lstatSync(key).isDirectory()) throw new Error(`directory 必须指向目录: ${directory}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  return key
}
