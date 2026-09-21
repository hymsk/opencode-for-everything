import { createHash } from "node:crypto"

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const STEP_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const STEP_INPUT_TEMPLATE_SOURCES = new Set(["workflow", "dependencies"])
const WORKFLOW_OUTPUT_TEMPLATE_SOURCES = new Set(["steps"])

function fail(message) {
  throw new Error(message)
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是对象`)
  return value
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} 不支持字段: ${key}`)
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 必须是非空字符串`)
  return value
}

function optionalSchema(value, label) {
  if (value === undefined) return { type: "object" }
  assertWorkflowSchema(value, label)
  return structuredClone(value)
}

function stringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是字符串数组`)
  const items = value.map((item, index) => stringValue(item, `${label}[${index}]`))
  return [...new Set(items)]
}

function normalizeEvidenceRequirements(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} 必须是数组`)
  const normalized = value.map((item, index) => {
    const itemLabel = `${label}[${index}]`
    if (typeof item === "string") {
      if (!["command-success", "task-created", "task-result"].includes(item)) fail(`${itemLabel} 不支持的事实类型`)
      return item
    }
    const requirement = objectValue(item, itemLabel)
    onlyKeys(requirement, new Set(["kind", "taskFrom"]), itemLabel)
    const kind = stringValue(requirement.kind, `${itemLabel}.kind`)
    if (kind !== "task-result") fail(`${itemLabel}.kind 只有 task-result 支持跨 Step Task 绑定`)
    const taskFrom = stringValue(requirement.taskFrom, `${itemLabel}.taskFrom`)
    if (!STEP_ID_PATTERN.test(taskFrom)) fail(`${itemLabel}.taskFrom 必须是合法 Step id`)
    return { kind, taskFrom }
  })
  const identities = normalized.map((item) => JSON.stringify(item))
  if (new Set(identities).size !== identities.length) fail(`${label} 包含重复要求`)
  return normalized
}

function normalizeTemplate(value, label, allowedSources) {
  if (Array.isArray(value)) return value.map((item, index) => normalizeTemplate(item, `${label}[${index}]`, allowedSources))
  if (!value || typeof value !== "object") return structuredClone(value)
  if ("$from" in value) {
    onlyKeys(value, new Set(["$from", "path", "default"]), label)
    const from = stringValue(value.$from, `${label}.$from`)
    if (!allowedSources.has(from)) fail(`${label}.$from 不允许引用 ${from}`)
    const path = value.path === undefined || value.path === "" ? "" : stringValue(value.path, `${label}.path`)
    if (path !== "" && !path.startsWith("/")) fail(`${label}.path 必须是空字符串或 JSON Pointer`)
    return { $from: from, path, ...(Object.hasOwn(value, "default") ? { default: normalizeTemplate(value.default, `${label}.default`, allowedSources) } : {}) }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeTemplate(item, `${label}.${key}`, allowedSources)]))
}

function firstPointerToken(pointer) {
  if (pointer === "") return undefined
  return pointer.slice(1).split("/", 1)[0].replace(/~1/g, "/").replace(/~0/g, "~")
}

function assertTemplateTargets(template, source, allowedNames, label) {
  if (Array.isArray(template)) {
    template.forEach((item, index) => assertTemplateTargets(item, source, allowedNames, `${label}[${index}]`))
    return
  }
  if (!template || typeof template !== "object") return
  if ("$from" in template) {
    if (template.$from === source) {
      const target = firstPointerToken(template.path ?? "")
      if (target !== undefined && !allowedNames.has(target)) fail(`${label} 引用了未声明的 ${source} 目标: ${target}`)
    }
    if (Object.hasOwn(template, "default")) assertTemplateTargets(template.default, source, allowedNames, `${label}.default`)
    return
  }
  for (const [key, item] of Object.entries(template)) assertTemplateTargets(item, source, allowedNames, `${label}.${key}`)
}

export function pointerValue(value, pointer, label = "workflow pointer") {
  if (pointer === "") return { found: true, value }
  let current = value
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~")
    if (current === null || current === undefined || typeof current !== "object" || !Object.hasOwn(current, token)) {
      return { found: false }
    }
    current = current[token]
  }
  return { found: true, value: current }
}

export function resolveWorkflowTemplate(template, sources, label = "workflow template") {
  if (Array.isArray(template)) return template.map((item, index) => resolveWorkflowTemplate(item, sources, `${label}[${index}]`))
  if (!template || typeof template !== "object") return structuredClone(template)
  if ("$from" in template) {
    const source = sources?.[template.$from]
    if (source === undefined) fail(`${label} 缺少数据源: ${template.$from}`)
    const selected = pointerValue(source, template.path ?? "", label)
    if (!selected.found) {
      if (Object.hasOwn(template, "default")) return resolveWorkflowTemplate(template.default, sources, `${label}.default`)
      fail(`${label} 引用了不存在的路径: ${template.path}`)
    }
    return structuredClone(selected.value)
  }
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, resolveWorkflowTemplate(item, sources, `${label}.${key}`)]))
}

function normalizeGate(value, label) {
  if (value === undefined) return { evidence: [], artifactsMin: 0 }
  const gate = objectValue(value, label)
  onlyKeys(gate, new Set(["evidence", "artifactsMin"]), label)
  const evidence = normalizeEvidenceRequirements(gate.evidence, `${label}.evidence`)
  const artifactsMin = gate.artifactsMin === undefined ? 0 : gate.artifactsMin
  if (!Number.isSafeInteger(artifactsMin) || artifactsMin < 0) fail(`${label}.artifactsMin 必须是非负整数`)
  return { evidence, artifactsMin }
}

function normalizeStep(value, index) {
  const label = `workflow.steps[${index}]`
  const step = objectValue(value, label)
  onlyKeys(step, new Set(["id", "type", "description", "dependsOn", "input", "inputSchema", "outputSchema", "gate", "maxRepairRounds", "execution"]), label)
  const id = stringValue(step.id, `${label}.id`)
  if (["constructor", "prototype"].includes(id)) fail(`${label}.id 保留名称`)
  if (!STEP_ID_PATTERN.test(id)) fail(`${label}.id 只能使用小写字母、数字和连字符，并以字母开头`)
  const type = step.type
  if (type !== "work") fail(`${label}.type 只支持 work；agent/workflow/loop 不支持`)
  const common = {
    id,
    type,
    description: step.description === undefined ? id : stringValue(step.description, `${label}.description`),
    dependsOn: stringList(step.dependsOn, `${label}.dependsOn`),
    input: step.input === undefined ? undefined : normalizeTemplate(step.input, `${label}.input`, STEP_INPUT_TEMPLATE_SOURCES),
    inputSchema: optionalSchema(step.inputSchema, `${label}.inputSchema`),
    outputSchema: optionalSchema(step.outputSchema, `${label}.outputSchema`),
  }
  if (common.input !== undefined) assertTemplateTargets(common.input, "dependencies", new Set(common.dependsOn), `${label}.input`)
  const maxRepairRounds = step.maxRepairRounds === undefined ? 2 : step.maxRepairRounds
  if (!Number.isSafeInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 10) fail(`${label}.maxRepairRounds 必须是 0..10 整数`)
  const execution = step.execution === undefined ? { mode: "self" } : step.execution
  objectValue(execution, `${label}.execution`)
  onlyKeys(execution, new Set(["mode", "agent"]), `${label}.execution`)
  if (!["self", "task"].includes(execution.mode)) fail(`${label}.execution.mode 不支持`)
  if (execution.mode === "task") stringValue(execution.agent, `${label}.execution.agent`)
  else if (execution.agent !== undefined) fail(`${label}.execution.agent 仅用于 task`)
  return {
    ...common,
    execution: structuredClone(execution),
    gate: normalizeGate(step.gate, `${label}.gate`),
    maxRepairRounds,
  }
}

function assertDag(steps) {
  const byID = new Map(steps.map((step) => [step.id, step]))
  for (const step of steps) {
    for (const dependency of step.dependsOn) if (!byID.has(dependency)) fail(`workflow.steps.${step.id}.dependsOn 引用了不存在的 Step: ${dependency}`)
    if (step.dependsOn.includes(step.id)) fail(`workflow Step 不能依赖自身: ${step.id}`)
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) fail(`workflow Step 依赖存在环: ${[...visiting, id].join(" -> ")}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byID.get(id).dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
  for (const step of steps) {
    for (const requirement of step.gate.evidence) {
      if (typeof requirement === "string") continue
      if (!step.dependsOn.includes(requirement.taskFrom)) fail(`workflow.steps.${step.id}.gate.evidence 的 taskFrom 必须引用直接依赖: ${requirement.taskFrom}`)
      const source = byID.get(requirement.taskFrom)
      if (source.execution.mode !== "task") fail(`workflow.steps.${step.id}.gate.evidence 的 taskFrom 必须引用 execution.mode=task 的 Step: ${requirement.taskFrom}`)
      if (!source.gate.evidence.some((item) => (typeof item === "string" ? item : item.kind) === "task-created")) {
        fail(`workflow.steps.${step.id}.gate.evidence 的 taskFrom Step 必须要求 task-created: ${requirement.taskFrom}`)
      }
    }
  }
}

export function normalizeWorkflow(value, source = "workflow") {
  const workflow = objectValue(value, source)
  onlyKeys(workflow, new Set(["$schema", "contract", "name", "description", "visibility", "inputSchema", "output", "outputSchema", "steps"]), source)
  if (workflow.$schema !== undefined && typeof workflow.$schema !== "string") fail(`${source}.$schema 必须是字符串`)
  if (workflow.contract !== "process-v1") fail(`${source}.contract 必须是 process-v1；不接受旧定义`)
  const name = stringValue(workflow.name, `${source}.name`)
  if (!NAME_PATTERN.test(name)) fail(`${source}.name 名称不合法`)
  const visibility = workflow.visibility === undefined ? "entry" : workflow.visibility
  if (visibility !== "entry" && visibility !== "internal") fail(`${source}.visibility 只能是 entry 或 internal`)
  if (workflow.output === undefined) fail(`${source}.output 必须显式声明 Workflow 输出映射`)
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) fail(`${source}.steps 必须是非空数组`)
  const steps = workflow.steps.map(normalizeStep)
  if (new Set(steps.map((step) => step.id)).size !== steps.length) fail(`${source}.steps 包含重复 id`)
  assertDag(steps)
  const output = normalizeTemplate(workflow.output, `${source}.output`, WORKFLOW_OUTPUT_TEMPLATE_SOURCES)
  assertTemplateTargets(output, "steps", new Set(steps.map((step) => step.id)), `${source}.output`)
  return {
    contract: "process-v1",
    name,
    description: stringValue(workflow.description, `${source}.description`),
    visibility,
    inputSchema: optionalSchema(workflow.inputSchema, `${source}.inputSchema`),
    output,
    outputSchema: optionalSchema(workflow.outputSchema, `${source}.outputSchema`),
    steps,
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function workflowHash(workflow) {
  return createHash("sha256").update(JSON.stringify(stableValue(workflow))).digest("hex")
}

export function compileWorkflowRegistry(definitions) {
  const registry = new Map()
  for (const definition of definitions) {
    const workflow = normalizeWorkflow(definition.value, definition.source)
    if (registry.has(workflow.name)) fail(`Workflow 名称重复: ${workflow.name}`)
    registry.set(workflow.name, { ...workflow, hash: workflowHash(workflow), source: definition.source })
  }
  return registry
}

export function assertWorkflowSchema(schema, label = "schema") {
  objectValue(schema, label)
  onlyKeys(schema, new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "minItems", "description"]), label)
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) fail(`${label}.type 必须显式声明支持类型`)
  if (schema.description !== undefined) stringValue(schema.description, `${label}.description`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail(`${label}.enum 无效`)
  for (const key of ["minLength", "minItems"]) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail(`${label}.${key} 无效`)
  if (schema.minLength !== undefined && schema.type !== "string" || schema.minItems !== undefined && schema.type !== "array") fail(`${label} 关键字与类型不匹配`)
  if (schema.type === "object") {
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail(`${label}.additionalProperties 只支持布尔值`)
    for (const [name, child] of Object.entries(objectValue(schema.properties === undefined ? {} : schema.properties, `${label}.properties`))) assertWorkflowSchema(child, `${label}.${name}`)
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties ?? {}, key)) || new Set(schema.required).size !== schema.required.length)) fail(`${label}.required 无效`)
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) fail(`${label} 对象关键字不适用`)
  if (schema.items !== undefined) {
    if (schema.type !== "array") fail(`${label}.items 不适用`)
    assertWorkflowSchema(schema.items, `${label}.items`)
  }
}

export function validateValue(schema, value, path = "$") {
  assertWorkflowSchema(schema, path)
  if (!schema || typeof schema !== "object") return []
  const errors = []
  const type = schema.type
  const matches = type === undefined
    || (type === "object" && value && typeof value === "object" && !Array.isArray(value))
    || (type === "array" && Array.isArray(value))
    || (type === "string" && typeof value === "string")
    || (type === "number" && typeof value === "number" && Number.isFinite(value))
    || (type === "integer" && Number.isInteger(value))
    || (type === "boolean" && typeof value === "boolean")
    || (type === "null" && value === null)
  if (!matches) return [`${path} 应为 ${type}`]
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => workflowHash(item) === workflowHash(value))) errors.push(`${path} 不在允许值中`)
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} 是必填项`)
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) errors.push(...validateValue(child, value[key], `${path}.${key}`))
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key} 未声明`)
  }
  if (type === "array" && Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validateValue(schema.items, item, `${path}[${index}]`)))
  if (typeof value === "string" && Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path} 长度小于 ${schema.minLength}`)
  if (Array.isArray(value) && Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${path} 数量小于 ${schema.minItems}`)
  return errors
}
