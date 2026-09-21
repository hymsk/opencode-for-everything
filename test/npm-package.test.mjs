import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, posix, relative, resolve, sep } from "node:path"
import test from "node:test"
import { installerTestEnv } from "./helpers/installer-cli-fixture.mjs"

const componentRoot = resolve(import.meta.dirname, "..")
const npmCommand = process.env.npm_execpath
  ? { executable: process.execPath, prefix: [process.env.npm_execpath] }
  : { executable: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] }
const systemRoot = process.env.SystemRoot || process.env.WINDIR
const tar = process.platform === "win32" && systemRoot ? join(systemRoot, "System32", "tar.exe") : "tar"

function npm(args, options) {
  return execFileSync(npmCommand.executable, [...npmCommand.prefix, ...args], options)
}

function publishedPaths(root, directory = root, result = new Set()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) publishedPaths(root, absolute, result)
    else result.add(relative(root, absolute).split(sep).join("/"))
  }
  return result
}

function assertPublishedMarkdownLinksResolve(root) {
  const files = publishedPaths(root)
  const links = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const content = readFileSync(join(root, file), "utf8")
    for (const [, target] of content.matchAll(links)) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue
      const path = target.split("#", 1)[0]
      if (!path) continue
      const resolved = posix.normalize(posix.join(posix.dirname(file), path))
      const directory = `${resolved.replace(/\/$/, "")}/`
      assert.ok(files.has(resolved) || [...files].some((candidate) => candidate.startsWith(directory)),
        `${file} links to unpublished package path ${target}`)
    }
  }
}

test("npm 包包含 @hymsk/o4e 安装所需文件", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "o4e-npm-package-"))
  const target = join(packageRoot, "target")
  try {
    const tarball = npm(["pack", "--pack-destination", packageRoot], {
      cwd: componentRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    execFileSync(tar, ["-xzf", `./${tarball}`, "-C", packageRoot], { cwd: packageRoot, stdio: "pipe" })

    const published = join(packageRoot, "package")
    for (const path of [
      "scripts/installer.mjs",
      "scripts/native-prompt-sync.mjs",
      "scripts/global-plugin-registry.mjs",
      "src/runtime-builder.mjs",
      "defaults/.o4e/config.jsonc",
    ]) {
      assert.equal(existsSync(join(published, path)), true, `${path} must be published`)
    }
    assert.equal(existsSync(join(published, "test")), false)
    assert.equal(existsSync(join(published, "docs")), false)
    assertPublishedMarkdownLinksResolve(published)

    const manifest = JSON.parse(readFileSync(join(published, "package.json"), "utf8"))
    assert.equal(manifest.name, "@hymsk/o4e")
    assert.equal(manifest.bin?.o4e, "scripts/installer.mjs")
    const bin = join(published, manifest.bin.o4e)
    assert.equal(existsSync(bin), true)

    // Exercise the exact unpacked package without asking npm to resolve its
    // dependencies again. npm ci has already installed the lockfile graph;
    // npm exec --offline is not deterministic on a clean runner because it
    // still requires cached package metadata that npm ci does not guarantee.
    symlinkSync(join(componentRoot, "node_modules"), join(published, "node_modules"), process.platform === "win32" ? "junction" : "dir")

    mkdirSync(target)
    execFileSync(process.execPath, [bin, "install", "--no-tui", "--target", target], {
      cwd: componentRoot,
      stdio: "pipe",
      timeout: 60_000,
      env: installerTestEnv(),
    })
    assert.equal(existsSync(join(target, ".o4e", "config.jsonc")), true)
    assert.equal(existsSync(join(target, ".opencode", "plugins", "opencode-for-everything.ts")), true)

    const archive = join(packageRoot, "config.o4e.tar.gz")
    execFileSync(process.execPath, [bin, "export", archive, "--target", target], {
      cwd: componentRoot,
      stdio: "pipe",
      timeout: 60_000,
      env: installerTestEnv(),
    })
    assert.equal(existsSync(archive), true)
  } finally {
    rmSync(packageRoot, { recursive: true, force: true })
  }
})
