import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { conciseReporter } from "./reporters/concise.mjs"

async function render(events) {
  let output = ""
  for await (const chunk of conciseReporter(events)) output += chunk
  return output
}

function summary(overrides = {}) {
  return {
    type: "test:summary",
    data: {
      success: true,
      duration_ms: 12,
      counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
      ...overrides,
    },
  }
}

test("concise reporter hides successful cases and prints the final summary", async () => {
  const output = await render([
    { type: "test:pass", data: { name: "success detail", details: { duration_ms: 2 } } },
    summary(),
  ])
  assert.doesNotMatch(output, /success detail/)
  assert.match(output, /Tests: PASS — selected 1, passed 1, failed 0/)
})

test("concise reporter preserves buffered child output and error diagnostics on failure", async () => {
  const error = Object.assign(new Error("assertion exploded"), { code: "ERR_ASSERTION" })
  const output = await render([
    { type: "test:stdout", data: { file: "/repo/test/failure.test.mjs", message: "child stdout\n" } },
    { type: "test:stderr", data: { file: "/repo/test/failure.test.mjs", message: "child stderr\n" } },
    { type: "test:fail", data: { name: "failure case", file: "/repo/test/failure.test.mjs", line: 7, column: 3, details: { duration_ms: 4, error } } },
    summary({ success: false, counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 } }),
  ])
  assert.match(output, /FAIL: failure case/)
  assert.match(output, /\[stdout\]\nchild stdout/)
  assert.match(output, /\[stderr\]\nchild stderr/)
  assert.match(output, /assertion exploded/)
  assert.match(output, /Tests: FAIL/)
})

test("concise reporter preserves real Node failure and cancellation diagnostics without successful diagnostics", (t) => {
  const root = mkdtempSync(join(tmpdir(), "o4e-concise-reporter-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = join(root, "diagnostics.test.mjs")
  writeFileSync(fixture, `import test from "node:test"
for (const fail of [false, true, false]) {
  await test("same-location case " + fail, (t) => {
    t.diagnostic(fail ? "FAILED_DIAGNOSTIC" : "SUCCESS_DIAGNOSTIC")
    if (fail) throw new Error("fixture failure")
  })
}
await test("last failure", (t) => {
  t.diagnostic("LAST_FAILURE_DIAGNOSTIC")
  throw new Error("last fixture failure")
})
await test("cancelled child", (t) => {
  t.diagnostic("CANCELLED_DIAGNOSTIC")
  return new Promise(() => {})
})
`)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    "--test",
    `--test-reporter=${fileURLToPath(new URL("./reporters/concise.mjs", import.meta.url))}`,
    fixture,
  ], { encoding: "utf8", timeout: 10000, env })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /CANCELLED: cancelled child/)
  assert.match(result.stdout, /cancelled 1/)
  for (const diagnostic of ["FAILED_DIAGNOSTIC", "CANCELLED_DIAGNOSTIC", "LAST_FAILURE_DIAGNOSTIC"]) {
    assert.equal(result.stdout.split(`[diagnostic]\n${diagnostic}\n`).length - 1, 1, result.stdout)
  }
  assert.doesNotMatch(result.stdout, /SUCCESS_DIAGNOSTIC/)
  assert.match(result.stdout, /Tests: FAIL/)
})

test("concise reporter counts real Node TODO outcomes without hiding ordinary failures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "o4e-concise-todo-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = join(root, "todo.test.mjs")
  writeFileSync(fixture, `import test from "node:test"
test("known defect", { todo: "pending lifecycle policy" }, () => { throw new Error("expected defect") })
test("unexpectedly passing todo", { todo: "still awaiting review" }, () => {})
test("ordinary pass", () => {})
if (process.env.O4E_REPORTER_FAIL === "1") test("ordinary failure", () => { throw new Error("real failure") })
`)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const fail of [false, true]) {
    const result = spawnSync(process.execPath, [
      "--test", `--test-reporter=${fileURLToPath(new URL("./reporters/concise.mjs", import.meta.url))}`, fixture,
    ], { encoding: "utf8", timeout: 10000, env: { ...env, O4E_REPORTER_FAIL: fail ? "1" : "0" } })
    assert.ifError(result.error)
    assert.equal(result.status, fail ? 1 : 0, result.stderr)
    assert.match(result.stdout, /TODO: known defect/)
    assert.match(result.stdout, /pending lifecycle policy/)
    assert.match(result.stdout, /expected defect/)
    assert.match(result.stdout, new RegExp(`Tests: ${fail ? "FAIL" : "PASS"} — selected ${fail ? 4 : 3}, passed 1, failed ${fail ? 1 : 0}, cancelled 0, skipped 0, todo 2`))
    if (fail) assert.match(result.stdout, /FAIL: ordinary failure/)
  }
})

test("concise reporter makes an empty name selection explicit", async () => {
  const output = await render([
    { type: "test:pass", data: { name: "test/unmatched.test.mjs", line: 1, details: { duration_ms: 20 } } },
    summary({ counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } }),
  ])
  assert.match(output, /selected 0/)
  assert.match(output, /passed 0/)
})

test("concise reporter reports slow successes only in the bounded final section", async () => {
  const events = Array.from({ length: 12 }, (_, index) => ({
    type: "test:pass",
    data: { name: `slow ${index}`, testId: index, details: { duration_ms: 1000 + index } },
  }))
  const output = await render([...events, summary({ counts: { tests: 12, passed: 12, failed: 0, cancelled: 0, skipped: 0, todo: 0 } })])
  assert.match(output, /Slow tests/)
  assert.match(output, /slow 11/)
  assert.doesNotMatch(output, /slow 0\n/)
  assert.equal(output.match(/^- .* slow /gm)?.length, 10)
})

test("concise reporter uses execution-ordered completion for slow durations when available", async () => {
  const output = await render([
    { type: "test:complete", data: { name: "actual slow test", testId: 1, passed: true, details: { duration_ms: 1500 } } },
    { type: "test:pass", data: { name: "actual slow test", testId: 1, details: { duration_ms: 3 } } },
    summary(),
  ])
  assert.match(output, /1500\.0 ms actual slow test/)
})

test("concise reporter counts a file-level load failure without double-counting child failures", async () => {
  const error = new Error("module load failed")
  const output = await render([
    { type: "test:fail", data: { name: "test/load-failure.test.mjs", file: "/repo/test/load-failure.test.mjs", entryFile: "/repo/test/load-failure.test.mjs", line: 1, details: { duration_ms: 4, error } } },
    summary({ success: false, counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 } }),
  ])
  assert.match(output, /selected 1, passed 0, failed 1/)
})
