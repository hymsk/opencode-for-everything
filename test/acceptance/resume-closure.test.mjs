import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { BUDGET, CREATION, MODELS, PROVIDERS, closureEvidence, controlledReply, createSequence, createSetupProgress, fileBytes, filesUnchanged,
  hostExecutable, hostVersionForArtifact, observeOwnedProcess, parseCLI, prepareDependencies, requestAdmission, toolAdmission } from "./resume-closure-runner.mjs"
import { hash, spawnOwnedProcess, streamEvidence } from "./common.mjs"
import { OFFLINE_INSTALL, dependencyLock, dependencyPackage, resolveLatestVersions, sealDependencies, seedDependencies } from "./resume-dependencies.mjs"
import { createAcceptance, initializeAcceptance } from "./wait-guard.mjs"
import { resumeInspectionEvidence } from "./resume-acceptance.mjs"
import { delegationAuthorizationFingerprintFromEnvelope as fingerprint } from "../../src/runtime/delegation-runtime.mjs"
import { evaluate } from "../../src/core/permission-rules.mjs"
import { taskText } from "../../src/core/background-task-domain.mjs"
import closurePlugin from "./resume-closure-plugin.mjs"

const parentID = "ses_" + "P".repeat(26), childID = "ses_" + "C".repeat(26), taskID = "o4e_task_" + "a".repeat(32)
const created = { taskID, sessionID: childID, agent: "inspect-child", status: "queued" }
const runtimeID = "11111111-2222-4333-8444-555555555555"
const watch = () => ({ action: "watch", taskID, timeoutMs: 1000 })
const preview = (extra = {}) => ({ taskID, status: "running", cursor: "opaque-position", ...extra })
const status = (extra = {}) => ({ taskID, status: "running", phase: "dispatched", revision: 1, ...extra })
const wire = (role = "parent") => ({ model: MODELS[role], stream: true, max_tokens: BUDGET[`${role}Tokens`],
  messages: [{ role: "user", content: "Unit test; not live model output." }],
  tools: (role === "parent" ? ["task", "o4e_task", "acceptance_evidence"] : ["acceptance_wait"]).map((name) => ({ type: "function", function: { name,
    parameters: name === "task" ? { type: "object", required: ["description", "prompt", "subagent_type"],
      properties: Object.fromEntries(["description", "prompt", "subagent_type"].map((k) => [k, { type: "string" }])) }
      : name === "acceptance_wait" ? { type: "object", required: ["stage"], properties: { stage: { type: "string", enum: ["BEGIN", "MIDDLE"] } } }
        : { type: "object" } } })) })
const context = { role: "parent", calls: 0, bytes: 100, elapsedMs: 1 }
const clone = (v) => structuredClone(v)
const VERSIONS = Object.freeze({ host: "9.8.7", plugin: "9.8.7", sdk: "9.8.7" })

test("CLI inherits strict explicit options and never supplies private defaults", () => {
  const base = ["--source", "/product", "--run-root", "/tmp/opencode/resume-unit", "--mode", "controlled"]
  const artifact = ["--dependency-artifact", "/tmp/opencode/deps/artifact", "--dependency-sha256", "a".repeat(64)]
  const args = [...artifact, ...base]
  assert.equal(parseCLI(args).mode, "controlled")
  assert.equal(parseCLI(args).dependencyHash, "a".repeat(64))
  assert.equal(parseCLI([...args.slice(0, -1), "live", "--provider-config", "/private/config.json", "--key-resolver", "/private/key.mjs"]).mode, "live")
  for (const bad of [[], [...args, "--mode", "live"], [...args.slice(0, -1), "live"], [...args, "--provider-config", "/private/config.json"],
    ["--source", "relative", ...base.slice(2), ...artifact], [...args, "--resume", "true"], base, [...base, ...artifact.slice(0, 2)],
    [...base, ...artifact, "--dependency-sha256", "a".repeat(64)], [...base, "--dependency-artifact", "relative", ...artifact.slice(2)],
    [...base, ...artifact.slice(0, 2), "--dependency-sha256", "PRIVATE_SENTINEL"],
    [...base, "--dependency-artifact", "/product/artifact", ...artifact.slice(2)],
    [...base, "--dependency-artifact", "/tmp/opencode/resume-unit/artifact", ...artifact.slice(2)]]) assert.throws(() => parseCLI(bad), /^Error: ARGUMENTS$/)
})

test("host PATH resolution skips directories and nonexecutables and accepts executable symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "resume-host-path-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = ["directory", "nonexecutable", "broken", "valid"].map((name) => join(root, name))
  for (const path of paths) mkdirSync(path)
  mkdirSync(join(paths[0], "opencode"))
  writeFileSync(join(paths[1], "opencode"), "not executable", { mode: 0o600 })
  symlinkSync(join(root, "missing"), join(paths[2], "opencode"))
  const executable = join(root, "host")
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  symlinkSync(executable, join(paths[3], "opencode"))
  assert.equal(hostExecutable(["", "relative", ...paths].join(":")), executable)
  assert.throws(() => hostExecutable(paths.slice(0, -1).join(":")), /^Error: SETUP$/)
  assert.throws(() => hostExecutable(":"), /^Error: SETUP$/)
})

test("runner accepts the artifact source version instead of a historical host pin", () => {
  assert.equal(hostVersionForArtifact("9.8.7", VERSIONS), "9.8.7")
  assert.throws(() => hostVersionForArtifact("9.8.6", VERSIONS), /^Error: SOURCE$/)
  for (const value of ["latest", "9.8"]) assert.throws(() => hostVersionForArtifact(value, VERSIONS), /^Error: SETUP$/)
  assert.throws(() => hostVersionForArtifact("9.8.7", { host: "latest" }), /^Error: INTEGRITY$/)
})

test("Resume admission enforces its own 68/3 calls, 2048/16384 tokens, bytes and time", () => {
  assert.equal(requestAdmission(wire(), { ...context, calls: 67, bytes: BUDGET.requestBytes }), "ACCEPT")
  assert.equal(requestAdmission(wire("child"), { ...context, role: "child", calls: 2 }), "ACCEPT")
  for (const [change, reason] of [[{ calls: 68 }, "CALL_BUDGET"], [{ calls: -1 }, "CALL_BUDGET"], [{ role: "unknown" }, "ROLE"],
    [{ bytes: BUDGET.requestBytes + 1 }, "BYTE_BUDGET"], [{ bytes: NaN }, "BYTE_BUDGET"], [{ elapsedMs: BUDGET.cleanupAtMs }, "TOTAL_BUDGET"]]) {
    assert.equal(requestAdmission(wire(), { ...context, ...change }), reason)
  }
  assert.equal(requestAdmission(wire("child"), { ...context, role: "child", calls: 3 }), "CALL_BUDGET")
  assert.equal(requestAdmission({ ...wire(), reasoning_effort: "medium", n: 1, best_of: 1 }, context), "ACCEPT")
  for (const change of [{ max_tokens: 4096 }, { max_completion_tokens: 2048 }, { n: 2 }, { best_of: 2 }, { thinking: { budget_tokens: 90000 } },
    { extra_body: { n: 2 } }, { candidate_count: 2 }, { logprobs: true }, { verbosity: "low" }, { max_output_tokens: 90000 },
    { stream_options: { include_usage: true, extra: 1 } }, { reasoning_effort: "high" }, { reasoning_effort: null }, { reasoningEffort: "medium" }]) {
    assert.equal(requestAdmission({ ...wire(), ...change }, context), "ADMISSION")
  }
  assert.equal(requestAdmission({ ...wire("child"), reasoning_effort: "medium" }, { ...context, role: "child" }), "ADMISSION")
  for (const mutate of [(v) => v.tools.push(v.tools[0]), (v) => v.tools[0].function.name = "functions.task",
    (v) => v.tools[0].function.parameters.required.pop(), (v) => v.tools[0].function.parameters.properties.subagent_type.type = "number"]) {
    const value = wire(); mutate(value); assert.equal(requestAdmission(value, context), "ADMISSION")
  }
})

test("tool admission requires current watch/inspect/output shapes and rejects legacy fields", () => {
  assert.equal(toolAdmission("parent", "task", CREATION), "TASK")
  assert.equal(toolAdmission("parent", "o4e_task", { ...watch(), ioTimeoutMs: 10000 }), "WATCH")
  for (const extra of [{ background: false }, { background: true }, { agent: "inspect-child" }, { permissionOverlay: {} }, { prompt: "changed" }]) {
    assert.equal(toolAdmission("parent", "task", { ...CREATION, ...extra }), "DENIED")
  }
  for (const action of ["status", "list", "cancel", "permission.reply", "question.reply", "restart", "input"]) {
    assert.equal(toolAdmission("parent", "o4e_task", { action, taskID }), "DENIED")
  }
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: 1001 }, { cursor: "opaque" }, { cursors: {} }, { resume: true },
    { direction: "forward" }, { maxBytes: 128 }, { reread: true }, { ioTimeoutMs: 60000 }, { taskIDs: [taskID] }]) {
    assert.equal(toolAdmission("parent", "o4e_task", { ...watch(), ...extra }), "DENIED")
  }
  assert.equal(toolAdmission("parent", "o4e_task", { action: "output", taskID }), "OUTPUT")
  assert.equal(toolAdmission("parent", "o4e_task", { action: "output", taskID, reread: true }), "DENIED")
  assert.equal(toolAdmission("child", "acceptance_wait", { stage: "BEGIN" }), "BEGIN")
  assert.equal(toolAdmission("child", "acceptance_wait", { stage: "BEGIN", sleep: 0 }), "DENIED")
  assert.equal(toolAdmission("child", "task", CREATION), "DENIED")
  assert.equal(toolAdmission("parent", "acceptance_inspect", { taskID }), "DENIED")
})

function sequenceFixture() {
  const s = createSequence(); let index = 0
  const call = (role, tool, args, output) => {
    const id = `call_unit_${++index}`
    s.before(role, tool, args, id); s.after(role, id, JSON.stringify(output), { o4eResult: output }); return id
  }
  call("parent", "task", CREATION, created)
  return { s, call }
}

test("local after-hook sequence requires progress inspections, status-only watch, both waits, output and final pagination", () => {
  const { s, call } = sequenceFixture()
  call("child", "acceptance_wait", { stage: "BEGIN" }, { stage: "BEGIN", waitedMs: 45000, admission: 1 })
  call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: false }, preview({ tail: "BEGIN\npublic" }))
  call("parent", "o4e_task", watch(), { reason: "heartbeat", tasks: [status()] })
  call("child", "acceptance_wait", { stage: "MIDDLE" }, { stage: "MIDDLE", waitedMs: 45000, admission: 2 })
  call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: true }, preview({ tail: "MIDDLE\npublic" }))
  call("parent", "o4e_task", watch(), { reason: "heartbeat", tasks: [status({ revision: 2 })] })
  call("parent", "o4e_task", watch(), { reason: "actionable", tasks: [{ taskID, status: "completed" }] })
  call("parent", "o4e_task", { action: "output", taskID }, { taskID, status: "completed", output: "O4E_INSPECT_ACCEPTANCE_DONE" })
  for (let i = 0; i < 4; i++) call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: i === 1 ? "backward" : "forward", resume: i !== 0 },
    preview({ status: "completed", ...(i === 3 ? { unchanged: true } : { tail: "small" }) }))
  call("parent", "acceptance_evidence", { taskID }, { taskID, passed: true, executionPassed: true, inspection: { passed: true } })
  assert.equal(s.complete, true)
  assert.throws(() => s.before("parent", "task", CREATION, "call_extra"), /^Error: SEQUENCE$/)
})

test("sequence rejects replay, concurrency, premature output, invalid watch fields and fifth inspect recovery", () => {
  for (const [role, tool, args] of [["parent", "task", CREATION],
    ["parent", "o4e_task", { action: "output", taskID }], ["child", "acceptance_wait", { stage: "MIDDLE" }],
    ["parent", "acceptance_evidence", { taskID }]]) {
    const { s } = sequenceFixture(); assert.throws(() => s.before(role, tool, args, "call_bad_1"), /^Error: SEQUENCE$/)
  }
  const { s, call } = sequenceFixture()
  for (let i = 0; i < 4; i++) {
    call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: i !== 0 }, preview({ gap: "source-changed" }))
    call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: false }, preview({ tail: "fresh" }))
  }
  call("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: true }, preview({ unavailable: "read-timeout" }))
  assert.throws(() => s.before("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: false }, "call_fifth"), /^Error: SEQUENCE$/)
  const f = sequenceFixture()
  f.s.before("parent", "o4e_task", watch(), "call_active")
  assert.throws(() => f.s.before("parent", "o4e_task", watch(), "call_parallel"), /^Error: SEQUENCE$/)
  assert.throws(() => f.s.after("parent", "call_active", "Failed task", { o4eResult: { reason: "actionable", tasks: [preview({ status: "failed" })] } }), /^Error: PRODUCTION$/)
  const g = sequenceFixture()
  assert.throws(() => g.s.before("parent", "o4e_task", watch(), "call_unit_1"), /^Error: IDENTITY$/)
  for (let i = 0; i < BUDGET.watches; i++) g.call("parent", "o4e_task", watch(), { reason: "heartbeat", tasks: [status({ revision: i + 1 })] })
  assert.throws(() => g.s.before("parent", "o4e_task", watch(), "call_overbudget"), /^Error: SEQUENCE$/)
})

test("child prompt bounds public phases without suppressing the two real wait calls", () => {
  const child = JSON.parse(readFileSync(new URL("./resume-child.jsonc", import.meta.url), "utf8")), prompt = child.base
  assert.match(prompt, /PHASE 1:.*BEGIN.*400-450 harmless printable ASCII characters/)
  assert.match(prompt, /PHASE 2 starts only after the first successful tool result:.*MIDDLE.*400-450 harmless printable ASCII characters/)
  assert.equal((prompt.match(/actually call acceptance_wait/gi) ?? []).length, 2)
  assert.match(prompt, /PHASE 3 starts only after both successful tool results: output exactly 100 literal lines STREAM001 through STREAM100/)
  assert.match(prompt, /each prefix immediately followed by 80-120 harmless printable ASCII characters/)
  assert.match(prompt, /including all prefixes, newlines and the final marker, MUST be at most 16 KiB \(16384 bytes\)/)
  assert.match(prompt, /Only PHASE 3 forbids further tool calls; PHASES 1 and 2 REQUIRE real acceptance_wait calls/)
  assert.match(prompt, /public assistant text, never reasoning or arguments as a substitute/)
  assert.match(prompt, /Do not use tools or code to generate or rewrite the text/)
  const suffix = /100-character suffix once per line: ([a-z]+)\./.exec(prompt)?.[1]
  assert.equal(suffix?.length, 100); assert.equal(Buffer.byteLength(suffix), 100)
  assert.equal(Object.hasOwn(child, "model"), false); assert.equal(Object.hasOwn(child, "fallbackModels"), false)
  assert.deepEqual(child.permission, { "*": "deny", acceptance_wait: "allow" })
})

test("PHASE 3 literal template is complete, bounded and excludes delimiters or placeholders", () => {
  const { base } = JSON.parse(readFileSync(new URL("./resume-child.jsonc", import.meta.url), "utf8"))
  const match = /\n<PHASE_3_OUTPUT_TEMPLATE>\n([\s\S]+)\n<\/PHASE_3_OUTPUT_TEMPLATE>$/.exec(base)
  assert.ok(match, "the JSON-decoded prompt must contain the full literal final template")
  assert.equal((base.match(/<\/?PHASE_3_OUTPUT_TEMPLATE>/g) ?? []).length, 2)
  const instructions = base.slice(0, match.index), template = match[1], lines = template.split("\n")
  assert.match(instructions, /The full literal template below is authoritative for PHASE 3 only/)
  assert.match(instructions, /After both successful wait results, emit its contents verbatim as your public assistant answer/)
  assert.match(instructions, /Copy the entire template exactly/)
  assert.match(instructions, /template delimiters are NOT part of the answer/)
  assert.match(instructions, /Stop immediately after the marker; no self-review/)
  assert.equal(lines.length, 101)
  const suffix = "abcdefghijklmnopqrstuvwxyz".repeat(3) + "abcdefghijklmnopqrstuv"
  for (const [i, line] of lines.slice(0, 100).entries()) {
    assert.equal(line, `STREAM${String(i + 1).padStart(3, "0")}${suffix}`)
    assert.match(line.slice(9), /^[\x20-\x7e]{80,120}$/)
  }
  assert.equal(lines.at(-1), "O4E_INSPECT_ACCEPTANCE_DONE")
  assert.equal((template.match(/O4E_INSPECT_ACCEPTANCE_DONE/g) ?? []).length, 1)
  assert.ok(Buffer.byteLength(template) <= 16 * 1024)
  assert.doesNotMatch(template, /\.\.\.|[<>{}\[\]`]|placeholder|TODO/)
})

test("controlled SSE is explicitly synthetic, complete and has public text before the real wait call", () => {
  for (const role of ["parent", "child"]) {
    const bytes = controlledReply(wire(role), role, 1)
    assert.equal(streamEvidence(bytes).complete, true)
    assert.equal(streamEvidence(bytes.subarray(0, bytes.length - 10)).complete, false)
    const events = bytes.toString().split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)))
    const deltas = events.map((event) => event.choices[0].delta)
    const tools = deltas.flatMap((delta) => delta.tool_calls ?? [])
    assert.equal(tools.length, 1)
    if (role === "child") {
      const textIndex = deltas.findIndex((d) => d.content), toolIndex = deltas.findIndex((d) => d.tool_calls)
      assert.ok(textIndex < toolIndex); assert.equal(deltas[textIndex].content, "BEGIN\n" + "a".repeat(400))
    } else assert.deepEqual(JSON.parse(tools[0].function.arguments), CREATION)
  }
  const final = controlledReply(wire("child"), "child", 3).toString()
  assert.equal((final.match(/STREAM\d{3}/g) ?? []).length, 100)
  const body = wire(); body.messages.push(
    { role: "assistant", tool_calls: [{ id: "create", function: { name: "task", arguments: JSON.stringify(CREATION) } },
      { id: "evidence", function: { name: "acceptance_evidence", arguments: JSON.stringify({ taskID }) } }] },
    { role: "tool", tool_call_id: "create", content: `Task ${taskID} start · queued` },
    { role: "tool", tool_call_id: "evidence", content: JSON.stringify({ inspection: {}, passed: true }) },
  )
  assert.match(controlledReply(body, "parent", 10).toString(), /not live model acceptance/)
  assert.equal(streamEvidence(Buffer.alloc(BUDGET.responseBytes + 1)).complete, false)
})

test("controlled parent follows visible result text without model access to metadata", () => {
  const body = wire()
  let count = 0
  const reply = (expected, text) => {
    const response = controlledReply(body, "parent", ++count).toString()
    const frames = response.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)))
    const call = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])[0]
    assert.equal(call.function.name, expected.tool)
    assert.deepEqual(JSON.parse(call.function.arguments), expected.args)
    body.messages.push({ role: "assistant", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: text })
  }
  reply({ tool: "task", args: CREATION }, `Task ${taskID} start · queued`)
  reply({ tool: "o4e_task", args: { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: false, ioTimeoutMs: BUDGET.readMs } },
    `Task ${taskID} · running\nBEGIN\nCursor: opaque`)
  reply({ tool: "o4e_task", args: { ...watch(), ioTimeoutMs: BUDGET.readMs } }, `Watch · heartbeat\n\nTask 1 ${taskID} · running`)
  reply({ tool: "o4e_task", args: { action: "inspect", taskID, maxBytes: 128, direction: "forward", resume: true, ioTimeoutMs: BUDGET.readMs } },
    `Task ${taskID} · running\nMIDDLE\nCursor: opaque`)
  reply({ tool: "o4e_task", args: { ...watch(), ioTimeoutMs: BUDGET.readMs } }, `Watch · actionable\n\nTask 1 ${taskID} · completed`)
  reply({ tool: "o4e_task", args: { action: "output", taskID } }, `Complete text`)
  for (let index = 0; index < 4; index++) reply({ tool: "o4e_task", args: {
    action: "inspect", taskID, maxBytes: 128, direction: index === 1 ? "backward" : "forward", resume: index !== 0, ioTimeoutMs: BUDGET.readMs,
  } }, `Task ${taskID} · completed\nCursor: opaque`)
  reply({ tool: "acceptance_evidence", args: { taskID } }, JSON.stringify({ passed: true }))
  assert.match(controlledReply(body, "parent", ++count).toString(), /not live model acceptance/)
})

const policy = { child: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "acceptance_wait", pattern: "*", action: "allow" }],
  parent: [{ permission: "task", pattern: "inspect-child", action: "allow" }], effect: "unknown-write", evaluate, fingerprint, taskText }

async function evidenceFixture(t) {
  const project = mkdtempSync(join(tmpdir(), "resume-evidence-unit-"))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const stateDir = join(project, ".acceptance/guard"); initializeAcceptance(stateDir)
  const start = Date.now() + 100, messages = [], parts = [], audit = [{ kind: "READY", runtimeID }]
  const assistant = (id, role, when, finish = "tool-calls") => {
    const value = { id, sessionID: role === "parent" ? parentID : childID, role: "assistant", providerID: PROVIDERS[role], modelID: MODELS[role],
      ...(role === "child" ? { parentID: "msg_dispatch" } : {}), finish, time: { created: when, completed: when + 1 } }
    messages.push(value); return value
  }
  const addTool = (name, role, tool, input, output, from, to) => {
    const info = assistant("msg_" + name, role, from - 1)
    const publicOutput = tool === "task" ? "human readable body"
      : tool === "o4e_task" && input.action === "inspect"
        ? [`Task ${output.taskID} · ${output.status}`, output.tail, output.unchanged ? "No new public output." : undefined,
          output.unavailable ? `Preview unavailable: ${output.unavailable}` : undefined,
          output.gap ? `Preview gap: ${output.gap}` : undefined, output.cursor ? `Cursor: ${output.cursor}` : undefined,
          output.beforeCursor ? `Earlier cursor: ${output.beforeCursor}` : undefined].filter(Boolean).join("\n")
        : tool === "o4e_task" && input.action === "output" ? output.output : "human readable body"
    const part = { id: "prt_" + name, callID: "call_" + name, sessionID: info.sessionID, messageID: info.id, type: "tool", tool,
      state: { status: "completed", input: clone(input), output: tool === "task" || tool === "o4e_task" ? publicOutput : JSON.stringify(output),
        metadata: tool === "task" || tool === "o4e_task" ? { kind: "agent", o4eResult: clone(output) } : {}, time: { start: from, end: to } } }
    parts.push(part)
    for (const kind of ["ADMIT", "COMPLETE"]) audit.push({ kind, runtimeID, operation: toolAdmission(role, tool, input), callHash: hash(part.callID),
      sessionHash: hash(part.sessionID), inputHash: hash(JSON.stringify(input)), ...(kind === "COMPLETE" ? { outputHash: hash(part.state.output) } : {}) })
    return part
  }
  const task = { kind: "agent", agent: "inspect-child", taskID, ownerSessionID: parentID, taskSessionID: childID, childSessionID: childID,
    dispatchMessageID: "msg_dispatch", createdAt: start + 5, runGeneration: 0, attemptNumber: 1, retryRound: 0, attemptSessionIDs: [childID],
    status: "completed", phase: "completed", pendingRequests: [], pendingInputs: [], effect: policy.effect, writeScopes: [],
    result: { sessionID: childID, messageID: "msg_final_child", partIDs: ["prt_final_child"] } }
  const delegation = { depth: 1, toolName: "task", taskID, parentSessionID: parentID, sourceAgent: "inspect-main", targetAgent: "inspect-child",
    requesterPermissionPattern: "inspect-child", requesterPermissionAction: "allow", requesterPermissionApproved: false,
    dispatchMessageID: task.dispatchMessageID, effect: policy.effect, writeScopes: [], trace: { taskID, ownerSessionID: parentID },
    compiledPermission: clone(policy.child), permissionOverlay: {} }
  task.authorizationFingerprint = delegation.authorizationFingerprint = fingerprint({ ...delegation, requesterAgent: "inspect-main", normalizedScopes: [] })
  const sessions = [{ id: parentID, parent_id: null, directory: project, time_created: start,
    metadata: { o4e: { backgroundTasks: { taskRefs: { [taskID]: { taskSessionID: childID } } } } } },
    { id: childID, parent_id: parentID, directory: project, time_created: start + 5, permission: clone(policy.child), metadata: { o4e: { task, delegation } } }]
  messages.push({ id: "msg_dispatch", sessionID: childID, role: "user" })
  addTool("creation", "parent", "task", CREATION, created, start + 1, start + 10)
  const waitLedger = { taskID, dispatch: "msg_dispatch", entries: [], rejections: [] }
  for (let i = 0; i < 2; i++) {
    const stage = ["BEGIN", "MIDDLE"][i], from = start + 100 + i * 46000
    const part = addTool("wait_" + stage, "child", "acceptance_wait", { stage }, { stage, waitedMs: 45000, admission: i + 1 }, from, from + 45100)
    const text = { id: "prt_text_" + stage, sessionID: childID, messageID: part.messageID, type: "text", text: stage + "\n" + "a".repeat(400), time: { end: from - 1 } }
    parts.splice(parts.indexOf(part), 0, text)
    waitLedger.entries.push({ stage, callID: part.callID, messageID: part.messageID, toolID: part.id, textID: text.id, textHash: hash(text.text),
      textBytes: Buffer.byteLength(text.text), state: "completed", admittedAt: from + 50, endedAt: from + 45050 })
    addTool("inspect_progress_" + stage, "parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128,
      direction: "forward", resume: i !== 0 }, preview({ tail: stage + "\npublic" }), from + 200, from + 700)
    addTool("watch_" + stage, "parent", "o4e_task", watch(), { reason: "heartbeat", tasks: [status({ revision: i + 1 })] }, from + 701, from + 1200)
  }
  const done = start + 92000
  const childFinal = assistant("msg_final_child", "child", done, "stop")
  const text = Array.from({ length: 100 }, (_, i) => `STREAM${String(i + 1).padStart(3, "0")}${"a".repeat(80)}`).join("\n") + "\nO4E_INSPECT_ACCEPTANCE_DONE"
  parts.push({ id: "prt_final_child", sessionID: childID, messageID: childFinal.id, type: "text", text })
  addTool("watch_done", "parent", "o4e_task", watch(), { reason: "actionable", tasks: [{ taskID, status: "completed" }] }, done + 2, done + 3)
  addTool("output", "parent", "o4e_task", { action: "output", taskID }, { taskID, status: "completed", output: text,
    messageID: task.result.messageID, partIDs: [...task.result.partIDs] }, done + 4, done + 5)
  for (let i = 0; i < 4; i++) addTool("inspect_" + i, "parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128,
    direction: i === 1 ? "backward" : "forward", resume: i !== 0 }, preview({ status: "completed", cursor: i === 1 ? "before" : "end",
    ...(i === 3 ? { unchanged: true } : { tail: i === 1 ? "previous" : "recent" }), ...(i === 0 ? { beforeCursor: "before" } : {}) }), done + 6 + i * 2, done + 7 + i * 2)
  writeFileSync(join(stateDir, childID + ".json"), JSON.stringify(waitLedger))
  const history = (id) => messages.filter((m) => m.sessionID === id).map((info) => ({ info, parts: parts.filter((p) => p.messageID === info.id) }))
  const client = { session: { get: async ({ path }) => ({ data: path.id === parentID ? sessions[0] : { id: childID, parentID, metadata: { o4e: { task } } } }), messages: async ({ path }) => ({ data: history(path.id) }) } }
  const api = createAcceptance({ client, directory: project, stateDir, inspectionEvidence: resumeInspectionEvidence })
  const execution = JSON.parse(await api.evidence({ taskID }, { agent: "inspect-main", directory: project, sessionID: parentID,
    ask: async () => {}, abort: new AbortController().signal }))
  assert.equal(execution.passed, true)
  addTool("evidence", "parent", "acceptance_evidence", { taskID }, execution, done + 20, done + 21)
  const parentFinal = assistant("msg_final_parent", "parent", done + 22, "stop")
  parts.push({ id: "prt_final_parent", messageID: parentFinal.id, sessionID: parentID, type: "text", text: "Unit evidence completed. Not live." })
  return { sessions, messages, parts, audit, project, stateDir, startedAt: start, endedAt: done + 30, waitLedger }
}

test("DB evidence reuses original execution reader, requires timed waits, lineage and frozen authority", async (t) => {
  const f = await evidenceFixture(t), result = await closureEvidence(f, policy)
  assert.equal(result.passed, true, JSON.stringify(result.checks))
  assert.equal(result.idError, false); assert.equal(result.counts.progressInspections, 2); assert.equal(result.counts.inspections, 6)
  const instant = clone(f)
  for (const p of instant.parts.filter((p) => p.state?.input?.action === "inspect")) p.state.time.end = p.state.time.start
  assert.equal((await closureEvidence(instant, policy)).passed, true, "zero-duration reads preserve admission-before-completion")
  const changes = [
    (e) => e.sessions[1].metadata.o4e.task.runGeneration++, (e) => e.sessions[1].metadata.o4e.task.attemptNumber++,
    (e) => e.sessions[1].metadata.o4e.delegation.depth++, (e) => e.sessions[1].permission.reverse(),
    (e) => e.sessions[1].metadata.o4e.delegation.authorizationFingerprint = "b".repeat(64),
    (e) => e.sessions[1].metadata.o4e.task.pendingRequests.push({ kind: "permission" }),
    (e) => e.parts.find((p) => p.tool === "acceptance_wait").state.status = "error",
    (e) => e.parts.find((p) => p.tool === "acceptance_wait").state.metadata.exit = 1,
    (e) => e.parts.find((p) => p.id === "prt_text_BEGIN").text += "tampered",
    (e) => e.parts.find((p) => p.id === "prt_text_MIDDLE").private = true,
    (e) => e.parts.find((p) => p.id === "prt_inspect_3").state.input.cursor = "manual",
    (e) => e.parts.find((p) => p.id === "prt_inspect_2").state.output = "unreadable PRIVATE_SENTINEL",
    (e) => e.parts.find((p) => p.id === "prt_final_child").text = "O4E_INSPECT_ACCEPTANCE_DONE",
    (e) => e.messages.find((m) => m.id === "msg_final_child").modelID = MODELS.parent,
    (e) => e.messages.find((m) => m.id === "msg_final_child").parentID = "msg_wrong",
    (e) => e.messages.find((m) => m.id === "msg_final_child").error = { data: { message: "new PRIVATE_SENTINEL error" } },
    (e) => e.audit.pop(), (e) => e.audit[1].inputHash = "forged", (e) => e.audit[2].outputHash = "forged",
    (e) => e.parts.find((p) => p.id === "prt_inspect_1").callID = "call_inspect_0",
  ]
  for (const [i, change] of changes.entries()) {
    const e = clone(f); change(e)
    const actual = await closureEvidence(e, policy)
    assert.equal(actual.passed, false, `mutation ${i}`)
    assert.equal(JSON.stringify(actual).includes("PRIVATE_SENTINEL"), false)
  }
  for (const change of [(v) => v.entries[0].endedAt--, (v) => v.entries[0].admittedAt++,
    (v) => v.entries[0].textHash = "forged", (v) => v.entries.push(clone(v.entries[0]))]) {
    const ledger = clone(f.waitLedger); change(ledger)
    writeFileSync(join(f.stateDir, childID + ".json"), JSON.stringify(ledger))
    assert.equal((await closureEvidence(f, policy)).passed, false)
  }
  writeFileSync(join(f.stateDir, childID + ".json"), JSON.stringify(f.waitLedger))
  assert.equal((await closureEvidence(f)).passed, false, "missing production policy cannot pass")
  const historic = clone(f); historic.messages[1].error = { data: { message: "Expected 'id' to be a string." } }
  const observed = await closureEvidence(historic, policy)
  assert.equal(observed.idError, true); assert.equal(observed.passed, false)
  assert.equal((await closureEvidence(f, policy)).passed, true, "unreproduced historical error is not a veto")
})

test("public text may finish after tool start but must finish by the fixed wait admission", async (t) => {
  const f = await evidenceFixture(t)
  for (const entry of f.waitLedger.entries) for (const boundary of ["after-start", "at-admission", "after-admission"]) {
    const e = clone(f), text = e.parts.find((p) => p.id === entry.textID), tool = e.parts.find((p) => p.id === entry.toolID)
    text.time.end = boundary === "after-start" ? tool.state.time.start + 1 : entry.admittedAt + Number(boundary === "after-admission")
    const result = await closureEvidence(e, policy), expected = boundary !== "after-admission"
    assert.equal(result.checks.originalExecution, true, "public Part order/hash evidence remains intact")
    assert.equal(result.checks.twoTimedWaits, expected, `${entry.stage}/${boundary}`)
    assert.equal(result.passed, expected, `${entry.stage}/${boundary}`)
  }
})

test("output body and references must match the final result even with coherent completion audit", async (t) => {
  const f = await evidenceFixture(t)
  assert.ok(Buffer.byteLength(f.parts.find((p) => p.id === "prt_final_child").text) > 9000)
  for (const mutate of [
    (out) => { out.output = "O4E_INSPECT_ACCEPTANCE_DONE" },
    (out) => { out.output = out.output.split("\n").slice(1).join("\n") },
    (out) => { out.messageID = "msg_wait_MIDDLE" },
    (out) => { delete out.messageID },
    (out) => { out.partIDs = ["prt_text_MIDDLE"] },
    (out) => { out.partIDs = [] },
    (out) => { delete out.partIDs },
    (out) => { out.partIDs.push(out.partIDs[0]) },
    (_out, e) => { e.sessions[1].metadata.o4e.task.result.sessionID = parentID },
  ]) {
    const e = clone(f), part = e.parts.find((p) => p.id === "prt_output"), out = part.state.metadata.o4eResult
    mutate(out, e); part.state.output = out.output
    e.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
    const result = await closureEvidence(e, policy)
    assert.equal(result.checks.auditLinked, true)
    assert.equal(result.checks.originalExecution, true)
    assert.equal(result.checks.longOutput, true, "the child's complete body does not prove that output returned it")
    assert.equal(result.passed, false, String(mutate))
    assert.equal(result.checks.outputBound, false, String(mutate))
  }
})

test("coherent child output and result references still reject suffixes outside 80-120 ASCII characters", async (t) => {
  const f = await evidenceFixture(t)
  for (const length of [79, 80, 100, 120, 121, 789, 896]) for (const split of [false, true]) {
    const e = clone(f), final = e.parts.find((p) => p.id === "prt_final_child")
    const text = Array.from({ length: 100 }, (_, i) => `STREAM${String(i + 1).padStart(3, "0")}${"a".repeat(length)}`)
    text[99] += "\nO4E_INSPECT_ACCEPTANCE_DONE"
    const referenced = split ? text.map((text, i) => ({ ...final, id: `prt_final_${i}`, text })) : [{ ...final, text: text.join("\n") }]
    e.parts.splice(e.parts.indexOf(final), 1, ...referenced)
    const reference = e.sessions[1].metadata.o4e.task.result
    reference.partIDs = referenced.map((p) => p.id)
    const part = e.parts.find((p) => p.id === "prt_output"), output = part.state.metadata.o4eResult
    output.partIDs = [...reference.partIDs]; output.output = taskText({ parts: referenced }); part.state.output = output.output
    e.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
    const result = await closureEvidence(e, policy), expected = length >= 80 && length <= 120
    assert.equal(result.checks.auditLinked, true); assert.equal(result.checks.outputBound, true); assert.equal(result.checks.completedLedger, true)
    assert.equal(result.counts.longLines, 100)
    assert.equal(result.checks.longOutput, expected, `${length}/${split}`)
    assert.equal(result.passed, expected, `${length}/${split}`)
  }
})

test("complete literal output with synthetic trailing review cannot pass sequence or final format evidence", async (t) => {
  const f = await evidenceFixture(t)
  const { base } = JSON.parse(readFileSync(new URL("./resume-child.jsonc", import.meta.url), "utf8"))
  const template = /\n<PHASE_3_OUTPUT_TEMPLATE>\n([\s\S]+)\n<\/PHASE_3_OUTPUT_TEMPLATE>$/.exec(base)[1]
  for (const [trailer, acceptedOutput, acceptedFormat] of [
    ["", true, true],
    ["\n \t\n", true, true],
    ["\nSynthetic self-review after the required marker.", false, false],
    ["\nO4E_INSPECT_ACCEPTANCE_DONE\nSynthetic extra commentary.", false, false],
    ["\nSynthetic extra commentary.\nO4E_INSPECT_ACCEPTANCE_DONE", true, false],
  ]) {
    const e = clone(f), final = e.parts.find((p) => p.id === "prt_final_child")
    final.text = template + trailer
    assert.ok(Buffer.byteLength(final.text) < 16 * 1024)
    const part = e.parts.find((p) => p.id === "prt_output"), output = part.state.metadata.o4eResult
    output.output = taskText({ parts: [final] }); part.state.output = output.output
    e.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
    const { s, call } = sequenceFixture()
    for (const [i, stage] of ["BEGIN", "MIDDLE"].entries()) {
      call("child", "acceptance_wait", { stage }, { stage, waitedMs: 45000, admission: i + 1 })
    }
    call("parent", "o4e_task", watch(), { reason: "actionable", tasks: [{ taskID, status: "completed" }] })
    s.before("parent", "o4e_task", { action: "output", taskID }, "call_output")
    const completeOutput = () => s.after("parent", "call_output", part.state.output, part.state.metadata)
    if (acceptedOutput) assert.equal(completeOutput(), "OUTPUT")
    else {
      assert.throws(completeOutput, /^Error: EVIDENCE$/)
      assert.throws(() => s.before("parent", "o4e_task", { action: "inspect", taskID, maxBytes: 128,
        direction: "forward", resume: false }, "call_inspect"), /^Error: SEQUENCE$/)
    }
    assert.equal(s.complete, false)
    const result = await closureEvidence(e, policy)
    assert.equal(result.checks.outputBound, true)
    assert.equal(result.checks.auditLinked, true)
    assert.equal(result.checks.completedLedger, true)
    assert.equal(result.counts.longLines, 100)
    assert.equal(result.checks.guardedSequence, acceptedOutput)
    assert.equal(result.checks.longOutput, acceptedFormat)
    assert.equal(result.passed, acceptedFormat)
  }
})

test("final public byte cap counts trailing text before trimming even with coherent output", async (t) => {
  const f = await evidenceFixture(t)
  for (const bytes of [16 * 1024, 16 * 1024 + 1]) {
    const e = clone(f), final = e.parts.find((p) => p.id === "prt_final_child")
    final.text += "\n".repeat(bytes - Buffer.byteLength(final.text))
    const part = e.parts.find((p) => p.id === "prt_output"), output = part.state.metadata.o4eResult
    output.output = taskText({ parts: [final] }); part.state.output = output.output
    e.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
    const result = await closureEvidence(e, policy)
    assert.equal(Buffer.byteLength(final.text), bytes)
    assert.equal(result.checks.auditLinked, true); assert.equal(result.checks.outputBound, true); assert.equal(result.counts.longLines, 100)
    assert.equal(result.checks.longOutput, bytes === 16 * 1024); assert.equal(result.passed, bytes === 16 * 1024)
  }
})

test("output reconstruction follows production taskText joining, trimming and non-text filtering", async (t) => {
  const f = await evidenceFixture(t), final = f.parts.find((p) => p.id === "prt_final_child")
  const original = final.text, tail = { ...final, id: "prt_final_tail", text: original.slice(original.lastIndexOf("\n") + 1) + "\n\n" }
  final.text = "\n\n" + original.slice(0, original.lastIndexOf("\n"))
  const reasoning = { ...final, id: "prt_final_reasoning", type: "reasoning", text: "Unit reasoning is not output." }
  f.parts.splice(f.parts.indexOf(final) + 1, 0, reasoning, tail)
  const reference = f.sessions[1].metadata.o4e.task.result
  reference.partIDs = [final.id, reasoning.id, tail.id]
  const part = f.parts.find((p) => p.id === "prt_output"), output = part.state.metadata.o4eResult
  output.partIDs = [...reference.partIDs]; output.output = taskText({ parts: [final, reasoning, tail] })
  part.state.output = output.output
  f.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
  // The narrow output proof is independent of the single-body 101-line fixture rule.
  let result = await closureEvidence(f, policy)
  assert.equal(result.checks.outputBound, true)
  for (const [ids, text] of [[[tail.id], tail.text.trim()], [[tail.id, final.id], taskText({ parts: [tail, final] })],
    [[final.id, reasoning.id, tail.id], output.output.replace("\n\nO4E_", "\nO4E_")]]) {
    reference.partIDs = ids; output.partIDs = [...ids]; output.output = text
    part.state.output = output.output
    f.audit.find((a) => a.kind === "COMPLETE" && a.callHash === hash(part.callID)).outputHash = hash(part.state.output)
    result = await closureEvidence(f, policy)
    assert.equal(result.checks.auditLinked, true)
    assert.equal(result.checks.outputBound, false, "coherent references cannot omit or reorder final text")
  }
})

test("private metadata and frozen byte contracts reject links, public files and tampering", (t) => {
  const root = mkdtempSync(join(tmpdir(), "resume-files-unit-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "unit.json"); writeFileSync(path, "unit-not-a-credential", { mode: 0o600 })
  const entry = { path, hash: hash(fileBytes(path, 100, true)) }
  assert.equal(filesUnchanged([entry]), true)
  chmodSync(path, 0o644); assert.throws(() => fileBytes(path, 100, true), /^Error: CONFIG$/)
  chmodSync(path, 0o600)
  symlinkSync(path, join(root, "link")); assert.throws(() => fileBytes(join(root, "link")), /^Error: INTEGRITY$/)
  linkSync(path, join(root, "hardlink")); assert.equal(filesUnchanged([entry]), false)
  rmSync(join(root, "hardlink")); writeFileSync(path, "tampered"); assert.equal(filesUnchanged([entry]), false)
})

test("frozen helper imports and one composite runtime, no SDK guard preflight or response rewrites", () => {
  const runner = readFileSync(new URL("./resume-closure-runner.mjs", import.meta.url), "utf8")
  const plugin = readFileSync(new URL("./resume-closure-plugin.mjs", import.meta.url), "utf8")
  assert.match(runner, /sourceSnapshot\(options.source, command\)/)
  assert.match(runner, /spawnOwnedProcess\(binary, args/)
  assert.doesNotMatch(runner, /PROCESS_SUPERVISOR|pidfd_send_signal|spawnSync|\.kill\(/)
  assert.match(runner, /body: bytes, signal: controller.signal/)
  assert.match(runner, /res.write\(chunk\)/)
  assert.doesNotMatch(plugin, /client\.session\.(get|messages)|OpenCodeForEverythingPlugin/)
  assert.equal((plugin.match(/export default/g) ?? []).length, 1)
  assert.equal((plugin.match(/acceptancePlugin\(input\)/g) ?? []).length, 1)
  assert.match(plugin, /Math.min\(BUDGET.toolMs, deadline - Date.now\(\)\)/)
  assert.ok(BUDGET.toolMs >= BUDGET.waitMs + 10000 && BUDGET.toolMs <= 60000)
  assert.deepEqual([BUDGET.cleanupAtMs, BUDGET.hardAtMs, BUDGET.totalMs], [595000, 599000, 600000])
  assert.equal(BUDGET.requestMs, 180000); assert.equal(BUDGET.setupMs, 90000)
  assert.doesNotMatch(runner, /!report\.idError|!.*\.nameError/)
  const frozen = JSON.parse(/const FROZEN = (\[[\s\S]*?\])/.exec(runner)[1])
  const imports = new Set()
  for (const name of frozen) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8")
    if (name.endsWith(".mjs")) for (const match of source.matchAll(/^import .+ from "\.\/([^"\n]+)"/gm)) imports.add(match[1])
  }
  assert.ok(imports.size > 0)
  for (const name of imports) assert.ok(frozen.includes(name), `${name} must be frozen with the runner`)
  assert.doesNotMatch(runner, /\/root\/|permissions-acceptance\.mjs|inspect-acceptance\.mjs/)
})

test("setup diagnostics use fixed stages and one unchanged total deadline", () => {
  let now = 500
  const progress = createSetupProgress(500, () => now)
  progress.enter("ENVIRONMENT"); now += 120; progress.enter("NPM_PROJECT")
  now += 88000; progress.enter("DEPENDENCY_COPY"); now = 500 + BUDGET.setupMs
  assert.throws(() => progress.enter("DEPENDENCY_VERIFY"), /^Error: SETUP$/)
  assert.deepEqual(progress.report, { completed: false, elapsedMs: 90000, timedOut: true, reason: "SETUP", stages: [
    { stage: "ENVIRONMENT", startedMs: 0, elapsedMs: 120, status: "COMPLETED" },
    { stage: "NPM_PROJECT", startedMs: 120, elapsedMs: 88000, status: "COMPLETED" },
    { stage: "DEPENDENCY_COPY", startedMs: 88120, elapsedMs: 1880, status: "FAILED" },
  ] })
  now += 3000; progress.finish("CLEANUP")
  assert.equal(progress.report.elapsedMs, 90000, "cleanup time must not replace the setup failure timestamp")
  assert.equal(progress.report.reason, "SETUP")
  const done = createSetupProgress(now, () => now)
  assert.throws(() => done.enter("PRIVATE_SENTINEL"), /^Error: SETUP$/)
  done.enter("ENVIRONMENT"); now += 100; done.finish()
  assert.equal(done.report.completed, true); assert.equal(done.report.timedOut, false)
  assert.equal(JSON.stringify(done.report).includes("PRIVATE_SENTINEL"), false)
  const failed = createSetupProgress(now, () => now)
  failed.enter("ENVIRONMENT"); failed.finish("PRIVATE_SENTINEL")
  assert.equal(failed.report.reason, "SETUP"); assert.equal(failed.report.timedOut, false)
})

function dependencyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "resume-artifact-unit-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const prefix = join(root, "prepare"), cache = join(root, "cache"), artifact = join(root, "artifact")
  mkdirSync(prefix)
  const pkg = dependencyPackage(VERSIONS)
  const lock = { lockfileVersion: 3, packages: { "": clone(pkg) } }
  for (const name of ["@opencode-ai/plugin", "@opencode-ai/sdk", "effect"]) {
    const bytes = Buffer.from("offline synthetic blob for " + name), digest = createHash("sha512").update(bytes).digest("hex")
    const path = join(cache, "_cacache/content-v2/sha512", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4))
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    const packageVersion = name === "effect" ? "4.0.0-beta.83" : VERSIONS[name.split("/").at(-1)]
    lock.packages["node_modules/" + name] = { version: packageVersion,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${packageVersion}.tgz`,
      integrity: "sha512-" + Buffer.from(digest, "hex").toString("base64") }
  }
  writeFileSync(join(prefix, "package.json"), JSON.stringify(pkg)); writeFileSync(join(prefix, "package-lock.json"), JSON.stringify(lock))
  const proof = sealDependencies(prefix, cache, artifact, "11.6.2", VERSIONS)
  return { root, artifact, proof, lock, pkg, prefix, cache }
}

test("dependency artifacts bind resolved latest versions and reject unsafe or unbound lock entries", (t) => {
  const f = dependencyFixture(t), pkg = JSON.stringify(f.pkg)
  assert.equal(dependencyLock(pkg, JSON.stringify(f.lock), VERSIONS).length, 3)
  for (const change of [(lock) => { lock.lockfileVersion = 2 }, (lock) => { delete lock.packages["node_modules/effect"] },
    (lock) => { lock.packages["node_modules/@opencode-ai/plugin"].version = "1.0.0" },
    (lock) => { lock.packages["node_modules/effect"].optional = true },
    (lock) => { lock.packages["node_modules/effect"].dev = true }, (lock) => { lock.packages["node_modules/effect"].link = true },
    (lock) => { lock.packages["node_modules/effect"].integrity = "sha1-PRIVATE_SENTINEL" },
    (lock) => { lock.packages["node_modules/effect"].resolved = "https://PRIVATE_SENTINEL@registry.npmjs.org/effect/-/effect.tgz" },
    (lock) => { lock.packages["node_modules/effect"].resolved = "file:/PRIVATE_SENTINEL" },
    (lock) => { lock.packages["node_modules/effect"].resolved = "https://registry.npmjs.org/effect/-/effect.tgz?key=PRIVATE_SENTINEL" },
    (lock) => { lock.packages["node_modules/../../escape"] = lock.packages["node_modules/effect"] }]) {
    const lock = clone(f.lock); change(lock)
    assert.throws(() => dependencyLock(pkg, JSON.stringify(lock), VERSIONS), /^Error: DEPENDENCY_ARTIFACT$/)
  }
  assert.throws(() => dependencyLock(JSON.stringify({ ...f.pkg, devDependencies: { typescript: "*" } }), JSON.stringify(f.lock), VERSIONS))
  for (const [restrictions, skippable] of [[{ os: ["other-platform"] }, true], [{ cpu: ["other-arch"] }, true],
    [{ os: [process.platform] }, false], [{ os: ["any"] }, false], [{ os: ["!darwin"] }, false], [{}, false]]) {
    const lock = clone(f.lock)
    lock.packages["node_modules/unit-optional"] = { ...lock.packages["node_modules/effect"], optional: true, ...restrictions }
    assert.equal(dependencyLock(pkg, JSON.stringify(lock), VERSIONS).at(-1).skippable, skippable)
  }
})

test("latest resolution requires aligned host, plugin and SDK registry metadata", async () => {
  const resolve = (values) => resolveLatestVersions(async (stage) => values[stage])
  const good = { RESOLVE_HOST: '"9.8.7"', RESOLVE_PLUGIN: '{"version":"9.8.7","dependencies.@opencode-ai/sdk":"9.8.7"}', RESOLVE_SDK: '"9.8.7"' }
  assert.deepEqual(await resolve(good), VERSIONS)
  for (const change of [
    { RESOLVE_HOST: '"9.8.6"' },
    { RESOLVE_PLUGIN: '{"version":"9.8.7","dependencies.@opencode-ai/sdk":"9.8.6"}' },
    { RESOLVE_SDK: '"latest"' },
    { RESOLVE_PLUGIN: "not-json" },
  ]) await assert.rejects(resolve({ ...good, ...change }), /^Error: DEPENDENCY_ARTIFACT$/)
})

test("artifact hash, lock hash, per-tarball SRI and file identity are checked before offline use", (t) => {
  const f = dependencyFixture(t), prefix = join(f.root, "fresh"), cache = join(f.root, "fresh-cache")
  mkdirSync(prefix)
  assert.throws(() => seedDependencies(f.artifact, "b".repeat(64), prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  assert.equal(existsSync(cache), false)
  const path = join(f.artifact, "manifest.json"), original = fileBytes(path), manifest = JSON.parse(original)
  for (const change of [(v) => { v.arch = "wrong" }, (v) => { v.platform = "wrong" }, (v) => { v.nodeMajor++ },
    (v) => { v.lockHash = "b".repeat(64) }, (v) => { v.blobs.pop() }, (v) => { v.blobs.push(v.blobs[0]) },
    (v) => { v.blobs[0].digest = "../PRIVATE_SENTINEL" }]) {
    const value = clone(manifest); change(value); const raw = Buffer.from(JSON.stringify(value)); writeFileSync(path, raw)
    assert.throws(() => seedDependencies(f.artifact, hash(raw), prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  }
  writeFileSync(path, original)
  const blob = join(f.artifact, "blobs", manifest.blobs[0].digest), content = fileBytes(blob)
  writeFileSync(blob, "tampered"); assert.throws(() => seedDependencies(f.artifact, f.proof.artifactHash, prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  writeFileSync(blob, content); linkSync(blob, join(f.root, "hardlink"))
  assert.throws(() => seedDependencies(f.artifact, f.proof.artifactHash, prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  rmSync(join(f.root, "hardlink")); rmSync(blob); symlinkSync(join(f.cache, "missing"), blob)
  assert.throws(() => seedDependencies(f.artifact, f.proof.artifactHash, prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  unlinkSync(blob); writeFileSync(blob, content)
  const proof = seedDependencies(f.artifact, f.proof.artifactHash, prefix, cache)
  assert.equal(proof.tarballs, 3); assert.equal(proof.lockHash, f.proof.lockHash)
  assert.equal(existsSync(join(prefix, "node_modules")), false, "compressed dependency bytes are not installed-session proof")
  assert.throws(() => seedDependencies(f.artifact, f.proof.artifactHash, prefix, cache), /^Error: DEPENDENCY_ARTIFACT$/)
  assert.equal(JSON.stringify(proof).includes(f.root), false)
})

test("fresh offline npm ci is copied under supervision with exact lock, versions and relative bin links", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "resume-dependencies-unit-")); t.after(() => rmSync(root, { recursive: true, force: true }))
  const f = dependencyFixture(t)
  const project = join(root, "project/.opencode"), config = join(root, "config/opencode")
  mkdirSync(project, { recursive: true }); mkdirSync(config, { recursive: true })
  const stages = [], commands = []
  const command = async (binary, args) => {
    commands.push(binary)
    if (binary === "npm") {
      if (args[0] === "--version") return { stdout: "11.6.2\n" }
      assert.deepEqual(args, [...OFFLINE_INSTALL, "--prefix", project, "--cache", join(root, "npm-cache")])
      for (const name of ["plugin", "sdk"]) {
        const dir = join(project, "node_modules/@opencode-ai", name); mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@opencode-ai/${name}`, version: VERSIONS[name] }))
      }
      mkdirSync(join(project, "node_modules/.bin")); mkdirSync(join(project, "node_modules/unit/bin"), { recursive: true })
      writeFileSync(join(project, "node_modules/unit/bin/cli.js"), "// offline unit fixture\n", { mode: 0o755 })
      symlinkSync("../unit/bin/cli.js", join(project, "node_modules/.bin/unit"))
      return
    }
    assert.equal(binary, process.execPath)
    const owned = spawnOwnedProcess(binary, args, { cwd: root, timeout: 5000, cleanupMs: 1000 })
    owned.child.stdout.resume(); owned.child.stderr.resume()
    try { assert.equal((await owned.result).exitCode, 0) } finally { owned.stop() }
  }
  const result = await prepareDependencies(root, command, (stage) => stages.push(stage), f.artifact, f.proof.artifactHash)
  assert.equal(result.artifactHash, f.proof.artifactHash)
  assert.deepEqual(commands, ["npm", "npm", process.execPath]); assert.deepEqual(stages, ["DEPENDENCY_ARTIFACT", "NPM_PROJECT", "DEPENDENCY_COPY", "DEPENDENCY_VERIFY"])
  for (const name of ["package.json", "package-lock.json", "node_modules/@opencode-ai/plugin/package.json", "node_modules/unit/bin/cli.js"]) {
    const source = join(project, name), target = join(config, name)
    assert.deepEqual(fileBytes(source), fileBytes(target)); assert.notEqual(lstatSync(source).ino, lstatSync(target).ino)
    assert.equal(lstatSync(source).mode, lstatSync(target).mode)
  }
  assert.equal(readlinkSync(join(config, "node_modules/.bin/unit")), "../unit/bin/cli.js")
  writeFileSync(join(config, "node_modules/unit/bin/cli.js"), "changed unit copy")
  assert.equal(readFileSync(join(project, "node_modules/unit/bin/cli.js"), "utf8"), "// offline unit fixture\n")
  await assert.rejects(prepareDependencies(root, command, () => {}), /^Error: SETUP$/)
  assert.equal(commands.length, 3, "never reuse a previous installation")
  rmSync(join(project, "node_modules"), { recursive: true })
  await assert.rejects(prepareDependencies(root, command, () => {}), /^Error: SETUP$/)
  rmSync(config, { recursive: true }); mkdirSync(config)
  for (const path of [join(project, "package.json"), join(project, "package-lock.json"), join(root, "npm-cache")]) rmSync(path, { recursive: true })
  await assert.rejects(prepareDependencies(root, async () => { throw new Error("SETUP") }, () => {}, f.artifact, f.proof.artifactHash), /^Error: SETUP$/)
  assert.equal(existsSync(join(config, "node_modules")), false, "failed npm cannot advance to copy")
  await assert.rejects(prepareDependencies(root, async () => {}, () => {}), /^Error: INTEGRITY$/)
})

test("supervisor diagnostics distinguish cleanup evidence from rejected exits without leaking receipts", async () => {
  const receipt = { cleaned: true, exitCode: 0, tracked: 1, timedOut: false }
  const observe = async (raw, { code = 0, signal = null, accepted = true } = {}) => {
    const child = new EventEmitter(); child.stdio = [null, null, null, null, new PassThrough()]
    let resolve, reject
    const result = new Promise((yes, no) => { resolve = yes; reject = no })
    const observed = observeOwnedProcess({ child, result })
    child.stdio[4].write(raw.slice(0, 7)); child.stdio[4].write(raw.slice(7)); child.stdio[4].end()
    child.emit("close", code, signal)
    if (accepted) resolve(receipt); else reject(new Error("PRIVATE_SENTINEL"))
    const value = await observed
    assert.equal(JSON.stringify(value).includes("PRIVATE_SENTINEL"), false)
    return value
  }
  const clean = await observe(JSON.stringify(receipt))
  assert.equal(clean.cleanup, "CONFIRMED"); assert.equal(clean.accepted, true); assert.equal(clean.receipt, "VALID")
  const timeout = await observe(JSON.stringify({ ...receipt, exitCode: -15, timedOut: true }), { code: 1, accepted: false })
  assert.equal(timeout.cleanup, "CONFIRMED"); assert.equal(timeout.accepted, false); assert.equal(timeout.timeoutOrCleanupFailure, true)
  assert.equal(timeout.childExitCode, -15); assert.equal(timeout.supervisorExitCode, 1)
  const failed = await observe(JSON.stringify({ ...receipt, cleaned: false, exitCode: null, timedOut: true }), { code: 1, accepted: false })
  assert.equal(failed.cleanup, "FAILED"); assert.equal(failed.receipt, "VALID")
  for (const [raw, expected] of [["", "MISSING"], ["PRIVATE_SENTINEL", "INVALID"], ["PRIVATE_SENTINEL".repeat(100), "OVERSIZED"],
    [JSON.stringify({ ...receipt, extra: "PRIVATE_SENTINEL" }), "INVALID"], [JSON.stringify({ ...receipt, exitCode: null }), "INVALID"],
    [JSON.stringify({ ...receipt, tracked: "PRIVATE_SENTINEL" }), "INVALID"]]) {
    const invalid = await observe(raw, { code: null, signal: "PRIVATE_SENTINEL", accepted: false })
    assert.equal(invalid.receipt, expected); assert.equal(invalid.cleanup, "UNPROVEN"); assert.equal(invalid.supervisorSignal, "UNKNOWN")
  }
  for (const options of [{ code: 1 }, { code: null, signal: "SIGKILL" }]) {
    assert.equal((await observe(JSON.stringify(receipt), { ...options, accepted: false })).cleanup, "UNPROVEN")
  }
})

test("real owned timeout remains rejected even when its receipt confirms descendants stopped", { timeout: 10000 }, async () => {
  const owned = spawnOwnedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 300, cleanupMs: 1000 })
  owned.child.stdout.resume(); owned.child.stderr.resume()
  const observed = observeOwnedProcess(owned)
  try {
    await assert.rejects(owned.result, /^Error: CLEANUP$/)
    const result = await observed
    assert.equal(result.accepted, false); assert.equal(result.receipt, "VALID"); assert.equal(result.cleanup, "CONFIRMED")
    assert.equal(result.supervisorExitCode, 1); assert.equal(result.timeoutOrCleanupFailure, true)
    assert.equal(result.childExitCode, -15)
  } finally { owned.stop() }
})

test("reused owned-process contract reaps TERM-resistant descendants on normal exit and stop", { timeout: 15000 }, async () => {
  for (const cancelled of [false, true]) {
    const childCode = 'process.on("SIGTERM", () => {}); process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000)'
    const leader = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','inherit','inherit']}); c.unref(); ${cancelled ? 'setInterval(()=>{},1000)' : 'setTimeout(()=>process.exit(0),300)'}`
    const owned = spawnOwnedProcess(process.execPath, ["-e", leader], { timeout: 5000, cleanupMs: 2000 })
    const observed = observeOwnedProcess(owned)
    let output = ""; owned.child.stdout.on("data", (bytes) => { output += bytes.toString() }); owned.child.stderr.resume()
    try {
      if (cancelled) { await delay(350); owned.stop(); owned.stop() }
      const result = await owned.result
      const supervision = await observed
      assert.equal(supervision.cleanup, "CONFIRMED"); assert.equal(supervision.accepted, true)
      assert.equal(result.cleaned, true); assert.ok(result.tracked >= 2)
      const pid = Number(output.trim()); assert.ok(pid > 1); assert.equal(existsSync(`/proc/${pid}/stat`), false)
    } finally { owned.stop(); await owned.result.catch(() => {}) }
  }
})

test("composite guard unit host preserves tools, uses chat identity and bounds a stalled production hook", { timeout: 5000 }, async (t) => {
  const project = mkdtempSync(join(tmpdir(), "resume-plugin-unit-"))
  const manifestPath = join(project, "manifest.json"), audit = join(project, "guard.jsonl")
  const oldManifest = process.env.O4E_RESUME_MANIFEST, oldKey = process.env.O4E_RESUME_LOCAL_KEY
  const singleton = Symbol.for("o4e.resume.closure.runtime")
  t.after(() => {
    if (oldManifest === undefined) delete process.env.O4E_RESUME_MANIFEST; else process.env.O4E_RESUME_MANIFEST = oldManifest
    if (oldKey === undefined) delete process.env.O4E_RESUME_LOCAL_KEY; else process.env.O4E_RESUME_LOCAL_KEY = oldKey
    delete globalThis[singleton]; rmSync(project, { recursive: true, force: true })
  })
  const packageDir = join(project, ".opencode/node_modules/@opencode-ai/plugin"), plugins = join(project, ".opencode/plugins")
  mkdirSync(packageDir, { recursive: true }); mkdirSync(plugins)
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ type: "module", exports: { "./tool": { import: "./tool.js" } } }))
  writeFileSync(join(packageDir, "tool.js"), "export const tool=(v)=>v; tool.schema={enum:()=>({}),string:()=>({})}")
  writeFileSync(join(plugins, "opencode-for-everything.ts"), `
    export const OpenCodeForEverythingPlugin = async (input) => {
      input.unit.initialized++
      return { tool: input.unit.tools, config() {}, "chat.params"() {}, "chat.headers"() {},
        "tool.execute.before": () => input.unit.stalled ? new Promise(() => {}) : undefined }
    }
  `)
  initializeAcceptance(join(project, ".acceptance/guard"))
  const manifest = { project, audit, proxy: "http://127.0.0.1:1", immutable: [], deadline: Date.now() + 300 }
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  process.env.O4E_RESUME_MANIFEST = manifestPath; process.env.O4E_RESUME_LOCAL_KEY = "unit-not-a-credential"
  const unit = { initialized: 0, stalled: false, tools: { task: { execute() {} }, o4e_task: { execute() {} } } }
  const client = { session: new Proxy({}, { get() { throw new Error("SDK guard preflight forbidden in this unit fixture") } }) }
  const hooks = await closurePlugin({ directory: project, worktree: project, client, unit })
  assert.equal(unit.initialized, 1); assert.equal(hooks.tool.task, unit.tools.task); assert.equal(hooks.tool.o4e_task, unit.tools.o4e_task)
  await hooks.config({ plugin: ["unit"], agent: { "inspect-main": { mode: "primary" }, "inspect-child": { mode: "subagent" } }, mcp: {} })
  const request = { agent: "inspect-main", sessionID: parentID, model: { id: MODELS.parent, providerID: PROVIDERS.parent } }, params = {}
  await hooks["chat.params"](request, params); assert.equal(params.maxOutputTokens, 2048)
  const headers = { headers: {} }; await hooks["chat.headers"](request, headers)
  assert.equal(headers.headers["x-o4e-acceptance-role"], "parent")
  const creationRequest = { sessionID: parentID, callID: "call_unit_creation", tool: "task" }
  await hooks["tool.execute.before"](creationRequest, { args: clone(CREATION) })
  await hooks["tool.execute.after"](creationRequest, { output: `Task ${taskID} start · queued`, metadata: { o4eResult: created } })
  unit.stalled = true
  await assert.rejects(hooks["tool.execute.before"]({ sessionID: parentID, callID: "call_unit_stalled", tool: "o4e_task" }, { args: watch() }), /^Error: O4E_RESUME_GUARD_DENIED$/)
  await hooks.dispose()
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(entries.filter((e) => e.kind === "READY").length, 1)
  assert.equal(entries.filter((e) => e.kind === "COMPLETE").length, 1)
  assert.equal(entries.filter((e) => e.kind === "DENIED").length, 1)
  assert.ok(["REQUEST_BUDGET", "TOTAL_BUDGET"].includes(entries.find((e) => e.kind === "DENIED").reason))
  assert.equal(JSON.stringify(entries).includes(CREATION.prompt), false)
})

test("CLI errors are sanitized without setup, private reads or network", () => {
  try { execFileSync(process.execPath, [fileURLToPath(new URL("./resume-closure-runner.mjs", import.meta.url)), "--unknown", "PRIVATE_SENTINEL"], { encoding: "utf8" }) }
  catch (error) {
    assert.equal(error.status, 2)
    assert.deepEqual(JSON.parse(error.stdout), { verdict: "failed", reason: "ARGUMENTS" })
    assert.equal(error.stderr, ""); return
  }
  assert.fail("invalid CLI must fail")
})
