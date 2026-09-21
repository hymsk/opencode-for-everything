import { linkSync, rmSync, symlinkSync } from "node:fs"
import { resolve } from "node:path"

export function createDirectoryLink(target, path) {
  symlinkSync(resolve(target), path, process.platform === "win32" ? "junction" : "dir")
}

export function createDanglingDirectoryLink(target, path) {
  createDirectoryLink(target, path)
}

export function createFileLink(target, path) {
  try {
    symlinkSync(target, path, "file")
    return "symbolic"
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error
    linkSync(target, path)
    return "hard"
  }
}

export function removeLink(path) {
  rmSync(path, { recursive: true, force: true })
}
