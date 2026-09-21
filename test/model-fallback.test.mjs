import assert from "node:assert/strict"
import test from "node:test"
import { isRetryableModelError, modelCandidateKey, modelRefKey, normalizeModelRefs, SessionModelFallback } from "../src/model-fallback.mjs"

const primary = "provider/primary"
const fallbackOne = "provider/fallback-one"
const fallbackTwo = "provider/fallback-two"
const primaryHigh = { id: primary, variant: "high" }
const fallbackOneHigh = { id: fallbackOne, variant: "high" }
const fallbackTwoLow = { id: fallbackTwo, variant: "low" }

function toModelRef(value) {
  const id = typeof value === "string" ? value : value.id
  const separator = id.indexOf("/")
  const ref = { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) }
  return typeof value === "object" && typeof value.variant === "string" ? { ...ref, variant: value.variant } : ref
}

test("候选模型保持配置顺序并去重", () => {
  assert.deepEqual(
    normalizeModelRefs([primary, fallbackOne, primary, fallbackTwo]).map(modelRefKey),
    [primary, fallbackOne, fallbackTwo],
  )
  assert.deepEqual(normalizeModelRefs([" provider / primary ", primary, " /empty"]), [toModelRef(primary)])
})

test("候选模型保留 variant，且同一模型的不同 variant 不会被去重", () => {
  assert.deepEqual(
    normalizeModelRefs([primaryHigh, { id: primary, variant: "low" }, primaryHigh]),
    [toModelRef(primaryHigh), toModelRef({ id: primary, variant: "low" })],
  )
})

test("只识别宿主标记为可重试的 API 错误", () => {
  assert.equal(isRetryableModelError({ name: "APIError", data: { isRetryable: true } }), true)
  assert.equal(isRetryableModelError({ name: "APIError", data: { isRetryable: false } }), false)
  assert.equal(isRetryableModelError({ name: "ProviderAuthError", data: {} }), false)
  assert.equal(isRetryableModelError({ name: "MessageAbortedError", data: {} }), false)
})

test("模型候选键区分 variant，模型引用键忽略 variant", () => {
  assert.equal(modelRefKey(primaryHigh), primary)
  assert.notEqual(modelCandidateKey(primaryHigh), modelCandidateKey({ id: primary, variant: "low" }))
  assert.equal(modelCandidateKey({ id: primary, variant: "" }), modelCandidateKey(primary))
})

test("fallback 只保留候选与错误分类，不选择模型或生成重试请求", () => {
  const fallback = new SessionModelFallback()
  const error = { name: "APIError", data: { isRetryable: true } }
  const request = { sessionID: "s", messageID: "m", agent: "orchestrator", model: primaryHigh, fallbackModels: [fallbackOneHigh, fallbackTwoLow], parts: [] }
  fallback.recordMessage(request)
  assert.deepEqual(fallback.describeError("s", error), {
    retryable: true,
    currentModel: toModelRef(primaryHigh),
    fallbackCandidates: [toModelRef(fallbackOneHigh), toModelRef(fallbackTwoLow)],
  })
  assert.deepEqual(fallback.describeError("s", { name: "ProviderAuthError" }), {
    retryable: false,
    currentModel: toModelRef(primaryHigh),
    fallbackCandidates: [toModelRef(fallbackOneHigh), toModelRef(fallbackTwoLow)],
  })
  fallback.clear()
  assert.equal(fallback.describeError("s", error), null)
})
