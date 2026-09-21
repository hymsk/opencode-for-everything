import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { resolveSessionDirectory } from "../src/adapters/opencode/plugin-hooks.ts"

test("Workflow Session 使用当前 project directory，不被父 worktree 覆盖", () => {
  const worktree = mkdtempSync(join(tmpdir(), "o4e-workflow-directory-"))
  const directory = join(worktree, ".test")
  try {
    mkdirSync(directory)
    assert.equal(resolveSessionDirectory(directory, worktree), realpathSync(directory))
    assert.equal(resolveSessionDirectory(undefined, worktree), realpathSync(worktree))
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})
