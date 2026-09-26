import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"
import { createV2TuiPlugin, formatV2TuiStatus } from "../src/adapters/opencode-v2/tui-status.mjs"
import { readV2Definition } from "../src/adapters/opencode-v2/compat.mjs"
import publishedTui from "../src/tui-v2.mjs"

test("V2 CLI entry imports without optional Solid JSX dependencies", () => {
  assert.equal(publishedTui.id, "opencode-for-everything-v2-cli-preview")
})

test("V2 CLI exports a local-only, read-only status command with no keybinding", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "o4e-v2-cli-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  copyInstalledDefaults(resolve(import.meta.dirname, ".."), directory)
  let command, alert, reads = 0
  const plugin = createV2TuiPlugin((definition) => definition, {
    read(location) {
      reads++
      assert.equal(location, directory)
      return readV2Definition(directory, { XDG_CONFIG_HOME: directory })
    },
  })
  assert.equal(plugin.id, "opencode-for-everything-v2-cli-preview")
  let disposed = 0
  const dispose = plugin.setup({ location: { directory }, keymap: { layer(callback) {
    const layer = callback()
    assert.equal(layer.mode, "global")
    assert.equal(layer.bindings, undefined)
    assert.equal(layer.commands.length, 1)
    command = layer.commands[0]
  } }, ui: { slot(claim) { assert.equal(claim.append, "app"); assert.equal(claim.render({}), null); return () => { disposed++ } },
    dialog: { async alert(value) { alert = value } } } })
  assert.equal(reads, 0, "configuration is read only on explicit command invocation")
  assert.equal(command.bind, undefined)
  assert.equal(command.palette, true)
  assert.equal(command.slash.name, "o4e-v2-status")
  await command.run()
  assert.equal(reads, 1)
  assert.match(alert.message, /Local O4E configuration: found/)
  assert.match(alert.message, /managed execution: unavailable/)
  assert.ok(!alert.message.includes(directory), "do not show paths or config contents")
  dispose()
  assert.equal(disposed, 1)
})

test("V2 CLI refuses missing UI API; invalid selected configuration fails closed without leaking errors", async () => {
  const plugin = createV2TuiPlugin((definition) => definition, { read() { throw new Error("secret-in-config-error") } })
  assert.throws(() => plugin.setup({ keymap: { layer() {} } }), /O4E_V2_CLI_STATUS_UNAVAILABLE/)
  let command, alert
  plugin.setup({ location: { directory: "/fixture" }, keymap: { layer(fn) { command = fn().commands[0] } },
    ui: { slot(claim) { claim.render({}); return () => {} }, dialog: { async alert(value) { alert = value } } } })
  await command.run()
  assert.match(alert.message, /invalid/)
  assert.match(alert.message, /unavailable/)
  assert.ok(!alert.message.includes("secret-in-config-error"))
  assert.match(formatV2TuiStatus(null), /not active/)
  assert.match(formatV2TuiStatus(null), /managed execution: unavailable/)
})
