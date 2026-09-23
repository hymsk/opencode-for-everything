import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { parse } from "jsonc-parser"
import { buildRuntime } from "../src/runtime-builder.mjs"
import { prepareTuiRegistration, prepareTuiRegistrationRemoval, TUI_ENTRY, tuiPluginRegistered } from "../src/tui-registration.mjs"
import { copyInstalledDefaults, readConfigJson, writeConfigJson } from "./helpers/o4e-fixture.mjs"
import { installerTestEnv } from "./helpers/installer-cli-fixture.mjs"
import { createDirectoryLink, createFileLink } from "./helpers/fs-link-fixture.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
function target(t) {
  const path = mkdtempSync(join(tmpdir(), "o4e-tui-"))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function cli(args, home) {
  return execFileSync(process.execPath, [join(root, "scripts/installer.mjs"), ...args], { cwd: root, encoding: "utf8", env: installerTestEnv({ ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}) }) })
}

test("build isolates TUI entry, preserves JSONC settings, status reports registration and uninstall preserves user plugins", async (t) => {
  const path = target(t)
  copyInstalledDefaults(root, path)
  const runtime = join(path, ".opencode")
  mkdirSync(runtime)
  const config = join(runtime, "tui.jsonc")
  writeFileSync(config, '{\n // keep theme comment\n "theme": "my-theme",\n "plugin": [["./user.tsx", {"enabled": true}],],\n "plugin_enabled": {"opencode-for-everything.tasks": false},\n}\n')
  buildRuntime({ target: path })
  assert.ok(existsSync(join(runtime, TUI_ENTRY)))
  assert.ok(existsSync(join(runtime, "tui/opencode-for-everything/workflow-overview.mjs")))
  const { runtimeWorkflowOptions } = await import(pathToFileURL(join(runtime, "tui/opencode-for-everything/workflow-options.mjs")))
  assert.equal(runtimeWorkflowOptions({}, {}, path, path).enableWorkflow, false)
  assert.equal(existsSync(join(runtime, "plugins/opencode-for-everything/tui/index.tsx")), false)
  // TUI 入口与服务端共享 run-mode：构建重写 import 指向已复制的插件源（CFG-008 诊断）
  const tuiEntry = readFileSync(join(runtime, TUI_ENTRY), "utf8")
  assert.match(tuiEntry, /"\.\.\/\.\.\/plugins\/opencode-for-everything\/run-mode\.mjs"/)
  assert.doesNotMatch(tuiEntry, /"\.\.\/run-mode\.mjs"/)
  const { invalidO4eModeMessage, invalidO4eModeValue } = await import(pathToFileURL(join(runtime, "plugins/opencode-for-everything/run-mode.mjs")))
  assert.equal(invalidO4eModeValue({ o4e_mode: "" }), "")
  assert.equal(invalidO4eModeValue({ o4e_mode: "origin" }), undefined)
  assert.match(invalidO4eModeMessage("typo"), /O4E_MODE_FALLBACK/)
  assert.match(invalidO4eModeMessage("typo"), /o4e_mode="typo"/)
  const first = readFileSync(config, "utf8")
  assert.match(first, /keep theme comment/)
  assert.equal(parse(first).plugin_enabled["opencode-for-everything.tasks"], false)
  buildRuntime({ target: path })
  assert.equal(readFileSync(config, "utf8"), first)
  assert.match(cli(["status", "--target", path]), /\[registered\] TUI task overview/)
  cli(["uninstall", "--no-tui", "--target", path])
  assert.ok(!existsSync(join(runtime, TUI_ENTRY)))
  const remaining = readFileSync(config, "utf8")
  assert.match(remaining, /keep theme comment/)
  assert.deepEqual(parse(remaining).plugin, [["./user.tsx", { enabled: true }]])
  assert.equal(parse(remaining).theme, "my-theme")
})

test("TUI JSONC preflight rejects malformed config and links before generated output changes", (t) => {
  const path = target(t)
  copyInstalledDefaults(root, path)
  const runtime = join(path, ".opencode")
  mkdirSync(runtime)
  const config = join(runtime, "tui.json")
  writeFileSync(config, '{"plugin": false}')
  assert.throws(() => buildRuntime({ target: path }), /TUI plugin must be an array/)
  assert.equal(existsSync(join(runtime, "plugins")), false)
  writeFileSync(config, '{"plugin": [], "plugin": []}')
  assert.throws(() => prepareTuiRegistration(runtime), /Duplicate/)
  rmSync(config)
  const outside = join(path, "outside.json")
  writeFileSync(outside, "{}")
  createFileLink(outside, config)
  assert.throws(() => buildRuntime({ target: path }), /unlinked regular/)
  assert.equal(readFileSync(outside, "utf8"), "{}")
  rmSync(config)
  const outsideDir = join(path, "outside")
  mkdirSync(outsideDir)
  createDirectoryLink(outsideDir, join(runtime, "tui"))
  assert.throws(() => buildRuntime({ target: path }), /普通目录/)
  assert.deepEqual(readdirSync(outsideDir), [])
})

test("build projects Beta opt-in into TUI options and preserves unrelated settings", (t) => {
  const path = target(t)
  const configRoot = copyInstalledDefaults(root, path)
  const runtime = join(path, ".opencode")
  mkdirSync(runtime)
  const registry = join(runtime, "tui.jsonc")
  writeFileSync(registry, `{ // retain comment\n"plugin":[["./${TUI_ENTRY}",{"custom":true}]],"theme":"kept"}`)
  for (const enableWorkflow of [false, true, false]) {
    writeConfigJson(join(configRoot, "config.json"), { ...readConfigJson(configRoot, "config.json"), enableWorkflow })
    buildRuntime({ target: path })
    const source = readFileSync(registry, "utf8")
    const config = parse(source)
    assert.match(source, /retain comment/)
    assert.equal(config.theme, "kept")
    assert.deepEqual(config.plugin, [[`./${TUI_ENTRY}`, { custom: true, enableWorkflow, configRoot }]])
  }
})

test("TUI uninstall removes only matching registrations in both layers and rejects concurrent edits", (t) => {
  const path = target(t)
  for (const name of ["tui.json", "tui.jsonc"]) writeFileSync(join(path, name), JSON.stringify({ plugin: [[`./${TUI_ENTRY}`, { custom: true }], "user-plugin"], theme: "kept" }))
  assert.equal(tuiPluginRegistered(path), true)
  assert.deepEqual(prepareTuiRegistration(path), [])
  const remove = prepareTuiRegistrationRemoval(path)
  writeFileSync(join(path, "tui.json"), "{}")
  assert.throws(remove, /changed during uninstall/)
  prepareTuiRegistrationRemoval(path)()
  assert.equal(tuiPluginRegistered(path), false)
  assert.deepEqual(parse(readFileSync(join(path, "tui.jsonc"), "utf8")).plugin, ["user-plugin"])
})

test("global install failure restores exact existing TUI config and removes newly generated TUI files", (t) => {
  const home = target(t)
  const runtime = join(home, ".config/opencode")
  mkdirSync(runtime, { recursive: true })
  // Existing strict global registry refuses comments after the build has run.
  writeFileSync(join(runtime, "opencode.json"), '{// deliberate failure\n}')
  const original = '{ // keep byte for byte\n "theme": "custom"\n}\n'
  writeFileSync(join(runtime, "tui.jsonc"), original)
  assert.throws(() => cli(["install", "--no-tui", "--global"], home))
  assert.equal(readFileSync(join(runtime, "tui.jsonc"), "utf8"), original)
  assert.equal(existsSync(join(runtime, TUI_ENTRY)), false)
  assert.equal(existsSync(join(runtime, "tui.json")), false)
  writeFileSync(join(runtime, "opencode.json"), "{}")
  cli(["install", "--no-tui", "--global"], home)
  assert.ok(tuiPluginRegistered(runtime))
  cli(["uninstall", "--no-tui", "--global"], home)
  assert.equal(tuiPluginRegistered(runtime), false)
  assert.match(readFileSync(join(runtime, "tui.jsonc"), "utf8"), /keep byte for byte/)
})

test("import rollback restores existing TUI module bytes and exact registration", (t) => {
  const source = target(t)
  cli(["install", "--no-tui", "--target", source])
  const archive = join(source, "backup.o4e.tar.gz")
  cli(["export", archive, "--target", source])
  const home = target(t)
  cli(["install", "--no-tui", "--global"], home)
  const runtime = join(home, ".config/opencode")
  const config = join(runtime, "tui.json")
  const entry = join(runtime, TUI_ENTRY)
  const original = readFileSync(config, "utf8")
  writeFileSync(entry, "// pre-import module bytes\n")
  writeFileSync(join(runtime, "opencode.json"), '{ // registration failure after runtime build\n}')
  assert.throws(() => cli(["import", archive, "--global", "--force"], home))
  assert.equal(readFileSync(entry, "utf8"), "// pre-import module bytes\n")
  assert.equal(readFileSync(config, "utf8"), original)
})

test("npm package includes separate target entries and both TUI modules", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" })
  assert.equal(result.status, 0, result.stderr)
  const files = JSON.parse(result.stdout)[0].files.map((file) => file.path)
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  for (const entry of Object.values(manifest.exports)) assert.ok(files.includes(entry.replace(/^\.\//, "")))
  assert.notEqual(manifest.exports["./server"], manifest.exports["./tui"])
  assert.ok(files.includes("src/tui/task-overview.mjs"))
  assert.ok(files.includes("src/tui/workflow-overview.mjs"))
})
