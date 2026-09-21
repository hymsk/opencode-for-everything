import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { compileWorkflowRegistry, normalizeWorkflow, resolveWorkflowTemplate, validateValue, workflowHash } from "../src/core/workflow-definition.mjs"

const sample = { contract: "process-v1", name: "check", description: "Check", output: { $from: "steps", path: "/work" }, steps: [{ id: "work", type: "work" }] }

const definitionSchema = JSON.parse(readFileSync(new URL("../defaults/.o4e/schemas/workflow.schema.json", import.meta.url), "utf8"))

// Deliberately limited to the published definition Schema's keywords, not a runtime validator.
// Unknown keywords fail the test rather than silently weakening parity coverage.
function matchesDefinitionSchema(value, schema = definitionSchema) {
  const annotations = new Set(["$schema", "title", "description", "$defs", "default"])
  return Object.entries(schema).map(([key, constraint]) => {
    if (annotations.has(key)) return true
    const object = value !== null && typeof value === "object" && !Array.isArray(value)
    switch (key) {
      case "$ref": {
        assert.ok(constraint.startsWith("#/$defs/"))
        const target = definitionSchema.$defs[constraint.slice("#/$defs/".length)]
        assert.ok(target, constraint)
        return matchesDefinitionSchema(value, target)
      }
      case "type": return [constraint].flat().some(type => type === "object" ? object : type === "array" ? Array.isArray(value) : type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : typeof value === type)
      case "const": return sameJson(value, constraint)
      case "enum": return constraint.some(item => sameJson(value, item))
      case "not": return !matchesDefinitionSchema(value, constraint)
      case "oneOf": return constraint.filter(child => matchesDefinitionSchema(value, child)).length === 1
      case "required": return !object || constraint.every(name => Object.hasOwn(value, name))
      case "properties": return !object || Object.entries(constraint).every(([name, child]) => !Object.hasOwn(value, name) || matchesDefinitionSchema(value[name], child))
      case "additionalProperties": return !object || Object.keys(value).filter(name => !Object.hasOwn(schema.properties ?? {}, name)).every(name => typeof constraint === "boolean" ? constraint : matchesDefinitionSchema(value[name], constraint))
      case "items": return !Array.isArray(value) || value.every(item => matchesDefinitionSchema(item, constraint))
      case "uniqueItems": return !constraint || !Array.isArray(value) || value.every((item, index) => !value.slice(0, index).some(other => sameJson(item, other)))
      case "minItems": return !Array.isArray(value) || value.length >= constraint
      case "minLength": return typeof value !== "string" || [...value].length >= constraint
      case "pattern": return typeof value !== "string" || new RegExp(constraint, "u").test(value)
      case "minimum": return typeof value !== "number" || value >= constraint
      case "maximum": return typeof value !== "number" || value <= constraint
      default: assert.fail(`Unsupported test Schema keyword: ${key}`)
    }
  }).every(Boolean)
}

function sameJson(left, right) {
  return workflowHash(left) === workflowHash(right)
}

test("Workflow definition Schema and normalizer share positive and negative field examples", async (t) => {
  const step = fields => ({ ...sample, steps: [{ ...sample.steps[0], ...fields }] })
  const dependencies = { ...sample, steps: [{ id: "prepare", type: "work" }, { id: "work", type: "work", dependsOn: ["prepare", "prepare"] }] }
  const taskBinding = { ...sample, steps: [
    { id: "prepare", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] } },
    { id: "work", type: "work", dependsOn: ["prepare"], gate: { evidence: [{ kind: "task-result", taskFrom: "prepare" }] } },
  ] }
  const cases = [
    ["minimal", sample, true],
    ["string schema annotation", { ...sample, $schema: "../schemas/workflow.schema.json" }, true],
    ["nonstring schema annotation", { ...sample, $schema: 42 }, false],
    ["null schema annotation", { ...sample, $schema: null }, false],
    ["null visibility", { ...sample, visibility: null }, false],
    ["null execution", step({ execution: null }), false],
    ["null repair rounds", step({ maxRepairRounds: null }), false],
    ["null artifact minimum", step({ gate: { artifactsMin: null } }), false],
    ["null schema properties", { ...sample, inputSchema: { type: "object", properties: null } }, false],
    ["duplicate dependencies normalize once", dependencies, true],
    ...["constructor", "prototype"].map(id => [`reserved ${id}`, { ...sample, output: {}, steps: [{ id, type: "work" }] }, false]),
    ["reserved name prefix remains valid", { ...sample, output: {}, steps: [{ id: "constructor-work", type: "work" }] }, true],
    ["blank workflow description", { ...sample, description: " \t\n" }, false],
    ["blank step description", step({ description: " \t" }), false],
    ["blank schema description", { ...sample, inputSchema: { type: "object", description: " " } }, false],
    ["blank task agent", step({ execution: { mode: "task", agent: " " } }), false],
    ["blank dependency", step({ dependsOn: [" "] }), false],
    ["empty dependency", step({ dependsOn: [""] }), false],
    ["nonblank descriptions retain whitespace", { ...sample, description: " Check\n", inputSchema: { type: "object", description: " Input " }, steps: [{ ...sample.steps[0], description: " Work " }] }, true],
    ["valid task agent and bounds", step({ execution: { mode: "task", agent: "reviewer (plan)" }, maxRepairRounds: 10, gate: { artifactsMin: Number.MAX_SAFE_INTEGER } }), true],
    ["unsafe artifactsMin", step({ gate: { artifactsMin: Number.MAX_SAFE_INTEGER + 1 } }), false],
    ["unsafe schema minLength", { ...sample, inputSchema: { type: "string", minLength: Number.MAX_SAFE_INTEGER + 1 } }, false],
    ["unsafe schema minItems", { ...sample, outputSchema: { type: "array", minItems: Number.MAX_SAFE_INTEGER + 1 } }, false],
    ["safe schema bounds", { ...sample, inputSchema: { type: "string", minLength: Number.MAX_SAFE_INTEGER }, outputSchema: { type: "array", minItems: 0 } }, true],
    ["duplicate gate evidence", step({ gate: { evidence: ["task-result", "task-result"] } }), false],
    ["cross-Step task binding", taskBinding, true],
    ["duplicate object gate evidence ignores key order", { ...taskBinding, steps: [taskBinding.steps[0], { ...taskBinding.steps[1], gate: { evidence: [{ kind: "task-result", taskFrom: "prepare" }, { taskFrom: "prepare", kind: "task-result" }] } }] }, false],
    ["duplicate required names", { ...sample, inputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok", "ok"] } }, false],
    ["unsupported schema keyword", { ...sample, outputSchema: { type: "string", pattern: "a" } }, false],
    ["unsupported isolation", step({ isolation: "hard" }), false],
    ["invalid repair bound", step({ maxRepairRounds: 11 }), false],
    ["undeclared field", { ...sample, extra: true }, false],
  ]
  for (const [label, definition, valid] of cases) await t.test(label, () => {
    if (valid) assert.doesNotThrow(() => normalizeWorkflow(definition))
    else assert.throws(() => normalizeWorkflow(definition))
    assert.equal(matchesDefinitionSchema(definition), valid, label)
  })
  assert.deepEqual(normalizeWorkflow(dependencies).steps[1].dependsOn, ["prepare"])
})

test("Workflow process-v1 normalizes self execution and stable definitions", () => {
  const normalized = normalizeWorkflow(sample)
  assert.deepEqual(normalized.steps[0].execution, { mode: "self" })
  assert.equal(workflowHash(normalized), workflowHash(normalizeWorkflow(normalized)))
  assert.notEqual(workflowHash(normalized), workflowHash(normalizeWorkflow({ ...sample, description: "changed" })))
  assert.equal(compileWorkflowRegistry([{ value: sample, source: "check.json" }]).get("check").hash, workflowHash(normalized))
})

test("Workflow rejects old contracts, nested/loop and unenforced isolation declarations", () => {
  assert.throws(() => normalizeWorkflow({ ...sample, contract: undefined }), /contract/)
  for (const type of ["agent", "workflow", "loop"]) assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ id: "work", type }] }), /只支持 work/)
  for (const field of ["effect", "writeScopes", "permissionOverlay", "agent", "skill", "isolation", "recovery"]) {
    assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], [field]: "unsupported" }] }), /不支持字段/)
  }
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], gate: { evidence: ["file-hash"] } }] }), /不支持的事实类型/)
  assert.throws(() => normalizeWorkflow({ ...sample, output: undefined }), /output 必须/)
})

test("Workflow DAG and template boundaries reject cycles and undeclared sources", () => {
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ id: "work", type: "work", dependsOn: ["next"] }, { id: "next", type: "work", dependsOn: ["work"] }] }), /存在环/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], dependsOn: ["missing"] }] }), /不存在/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], input: { $from: "steps" } }] }), /不允许引用/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], input: { $from: "dependencies", path: "/missing" } }] }), /未声明/)
  assert.throws(() => normalizeWorkflow({ ...sample, output: { $from: "workflow" } }), /不允许引用/)
  assert.deepEqual(resolveWorkflowTemplate({ $from: "workflow", path: "/a~1b/~0key" }, { workflow: { "a/b": { "~key": 3 } } }), 3)
  assert.deepEqual(resolveWorkflowTemplate({ $from: "workflow", path: "/missing", default: [] }, { workflow: {} }), [])
  assert.throws(() => resolveWorkflowTemplate({ $from: "workflow", path: "/missing" }, { workflow: {} }), /不存在/)
})

test("Workflow schemas reject unsupported keywords instead of ignoring acceptance constraints", () => {
  for (const schema of [{ type: "string", pattern: "a" }, { type: "object", allOf: [] }, { type: "string", format: "uri" }, { type: "number", minimum: 1 }, { type: ["null", "string"] }, { const: true }]) {
    assert.throws(() => normalizeWorkflow({ ...sample, outputSchema: schema }))
  }
  assert.throws(() => normalizeWorkflow({ ...sample, outputSchema: { type: "object", required: ["missing"] } }), /required/)
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean", enum: [true] } }, additionalProperties: false }
  assert.deepEqual(validateValue(schema, { ok: true }), [])
  assert.ok(validateValue(schema, { ok: false }).length)
  assert.ok(validateValue(schema, { ok: true, extra: true }).length)
  assert.ok(validateValue(schema, Object.create({ ok: true })).length)
  assert.ok(validateValue({ type: "array", minItems: 1, items: { type: "string", minLength: 2 } }, ["x"]).length)
})

test("explicit task requirement is separate from ordinary work and bounded repair", () => {
  const normalized = normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] }, maxRepairRounds: 0 }] })
  assert.equal(normalized.steps[0].execution.agent, "reviewer")
  for (const maxRepairRounds of [-1, 11, 1.5]) assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], maxRepairRounds }] }), /maxRepairRounds/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...sample.steps[0], execution: { mode: "task" } }] }), /agent/)
})

test("cross-Step task-result requirements bind only to direct accepted task dependencies", () => {
  const review = { id: "review", type: "work", execution: { mode: "task", agent: "reviewer" }, gate: { evidence: ["task-created"] } }
  const collect = { id: "collect", type: "work", dependsOn: ["review"], gate: { evidence: [{ kind: "task-result", taskFrom: "review" }] } }
  const normalized = normalizeWorkflow({ ...sample, output: { $from: "steps", path: "/collect" }, steps: [review, collect] })
  assert.deepEqual(normalized.steps[1].gate.evidence, [{ kind: "task-result", taskFrom: "review" }])
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [review, { ...collect, dependsOn: [] }] }), /直接依赖/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...review, execution: { mode: "self" } }, collect] }), /execution.mode=task/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [{ ...review, gate: { evidence: [] } }, collect] }), /必须要求 task-created/)
  assert.throws(() => normalizeWorkflow({ ...sample, steps: [review, { ...collect, gate: { evidence: [{ kind: "task-created", taskFrom: "review" }] } }] }), /只有 task-result/)
})
