import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { copyInstalledDefaults } from "./helpers/o4e-fixture.mjs"
import { OpenCodeForEverythingPlugin } from "../src/plugin.ts"

test("Task detail switch hides only UI output and restores complete model messages without changing saved Parts", async () => {
  const outputs = []
  for (const enabled of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "o4e-task-detail-"))
    let hooks
    try {
      copyInstalledDefaults(resolve(import.meta.dirname, ".."), directory)
      const path = join(directory, ".o4e/config.jsonc")
      if (enabled) writeFileSync(path, readFileSync(path, "utf8").replace('"enable_o4e_task_detail": false', '"enable_o4e_task_detail": true'))
      const session = { id: "parent", directory, metadata: {} }
      const client = { session: {
        get: async () => ({ data: session }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
      } }
      hooks = await OpenCodeForEverythingPlugin({ client, directory, worktree: directory })
      const updates = []
      const result = await hooks.tool.o4e_task.execute({ action: "watch", taskIDs: [] }, {
        sessionID: "parent", agent: "orchestrator", directory, messageID: "message", callID: "call",
        abort: new AbortController().signal, ask: async () => {}, metadata: (value) => { updates.push(value) },
      })
      assert.equal(Boolean(result.title), enabled)
      assert.equal(updates.length > 0, enabled)
      assert.equal(result.metadata.o4eResult.reason, "empty")
      assert.equal(result.output === "", !enabled)
      const saved = { type: "tool", tool: "o4e_task", state: { ...result, input: { action: "watch", taskIDs: [] }, status: "completed" } }
      const messages = [{ info: { role: "assistant" }, parts: [saved] }]
      await hooks["experimental.chat.messages.transform"]({}, { messages })
      assert.equal(saved.state.output, enabled ? messages[0].parts[0].state.output : "")
      assert.match(messages[0].parts[0].state.output, /^Watch · empty/)
      outputs.push(messages[0].parts[0].state.output)
    } finally {
      await hooks?.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  assert.equal(outputs[0], outputs[1])
})
