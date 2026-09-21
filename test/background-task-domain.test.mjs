import assert from "node:assert/strict"
import test from "node:test"
import {
  TASK_PENDING_INPUT_LIMIT,
  TASK_REF_RECEIPT_LIMIT,
  firstTaskModelCandidate,
  createTaskReceiptID,
  nextTaskModelCandidate,
  normalizeAgentBackgroundTaskConfig,
  normalizeBackgroundTaskConfig,
  normalizeTaskGroupMetadata,
  normalizeTaskMetadata,
  taskHasCurrentRoundSideEffect,
  taskMetadata,
  taskDiagnostic,
  taskPublicSnapshot,
} from "../src/core/background-task-domain.mjs"

test("Background Task 配置应用全局默认并允许 Agent 覆盖重试预算", () => {
  assert.deepEqual(normalizeBackgroundTaskConfig(), {
    maxRetries: 1,
    maxConcurrentAgents: 4,
    maxConcurrentCommands: 4,
  })
  assert.deepEqual(normalizeBackgroundTaskConfig({ maxConcurrentAgents: 2 }), {
    maxRetries: 1,
    maxConcurrentAgents: 2,
    maxConcurrentCommands: 4,
  })
  assert.deepEqual(normalizeAgentBackgroundTaskConfig({ maxRetries: 3 }, { maxRetries: 1 }), { maxRetries: 3 })
})

test("Background Task 配置拒绝无效范围和未知字段", () => {
  assert.throws(() => normalizeBackgroundTaskConfig({ maxRetries: -1 }), /maxRetries 必须是非负安全整数/)
  assert.throws(() => normalizeBackgroundTaskConfig({ maxConcurrentAgents: 0 }), /大于等于 1/)
  assert.throws(() => normalizeBackgroundTaskConfig({ maxConcurrentCommands: 1.5 }), /安全整数/)
  assert.throws(() => normalizeBackgroundTaskConfig({ timeout: 1 }), /不支持字段: timeout/)
  assert.throws(() => normalizeAgentBackgroundTaskConfig({ maxConcurrentAgents: 2 }), /不支持字段/)
})

test("Task metadata normalizer 冻结版本、revision 和双计数", () => {
  const metadata = normalizeTaskMetadata({
    version: 1,
    revision: 3,
    sequence: 2,
    taskID: "o4e_task_fixture",
    kind: "agent",
    status: "running",
    phase: "model-running",
    ownerSessionID: "owner",
    taskSessionID: "child",
    childSessionID: "child",
    agent: "worker",
    effect: "read",
    writeScopes: [],
    dispatchMessageID: "msg_dispatch",
    attemptSessionIDs: ["child"],
    modelCandidates: [
      { providerID: "provider", modelID: "primary", variant: "high" },
      "provider/fallback",
    ],
    currentModel: { providerID: "provider", modelID: "primary", variant: "high" },
    failedModelCandidates: [],
    maxRetries: 1,
    attemptNumber: 2,
    retryRound: 0,
    runGeneration: 0,
    handledModelErrorAttempt: 1,
    sideEffectWatermark: {
      version: 1,
      retryRound: 0,
      attemptNumber: 2,
      childSessionID: "child",
      dispatchMessageID: "msg_dispatch",
      tool: "edit",
      callID: "call_edit",
      at: 3,
    },
    retryDecision: {
      status: "pending",
      retryRound: 0,
      attemptNumber: 2,
      requestedAt: 3,
      error: "retryable",
    },
    createdAt: 1,
    queuedAt: 1,
    startedAt: 2,
    updatedAt: 3,
    diagnostics: [taskDiagnostic("fixture", "fixture diagnostic", 3)],
  })

  assert.equal(metadata.version, 1)
  assert.equal(metadata.revision, 3)
  assert.equal(metadata.sequence, 2)
  assert.equal(metadata.attemptNumber, 2)
  assert.equal(metadata.retryRound, 0)
  assert.equal(metadata.requiresAllAttemptsStopped, false)
  assert.deepEqual(metadata.currentModel, { providerID: "provider", modelID: "primary", variant: "high" })
  assert.equal(taskHasCurrentRoundSideEffect(metadata), true)
  assert.deepEqual(firstTaskModelCandidate(metadata), { providerID: "provider", modelID: "primary", variant: "high" })
  assert.deepEqual(nextTaskModelCandidate(metadata), { providerID: "provider", modelID: "fallback" })
  assert.throws(() => normalizeTaskMetadata({ ...metadata, version: 2 }), /version 不支持/)
  assert.throws(() => normalizeTaskMetadata({ ...metadata, runGeneration: undefined }), /runGeneration 必须是非负安全整数/)
  assert.throws(() => normalizeTaskMetadata({ ...metadata, attemptSessionIDs: undefined }), /attemptSessionIDs 必须是数组/)
  assert.throws(() => normalizeTaskMetadata({ ...metadata, writeScopes: undefined }), /writeScopes 必须是数组/)
  assert.throws(() => normalizeTaskMetadata({ ...metadata, writeScopes: [1] }), /writeScopes\[0\] 必须是非空字符串/)
})

test("Task terminal receipt 使用稳定 ID 并严格校验 V1 metadata", () => {
  const base = {
    version: 1,
    revision: 3,
    sequence: 1,
    taskID: "o4e_task_receipt",
    kind: "agent",
    status: "completed",
    phase: "completed",
    ownerSessionID: "owner",
    taskSessionID: "ledger",
    childSessionID: "attempt",
    attemptSessionIDs: ["attempt"],
    agent: "worker",
    effect: "read",
    writeScopes: [],
    maxRetries: 1,
    attemptNumber: 1,
    retryRound: 0,
    runGeneration: 0,
    createdAt: 1,
    updatedAt: 3,
    endedAt: 3,
    diagnostics: [],
  }
  assert.equal(createTaskReceiptID(base.taskID, base.status), "o4e_receipt_716312ffff7aa20fe461a484b29b30f6")
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.throws(() => normalizeTaskMetadata({ ...base, status }), /终态 Task 必须包含 receipt/)
  }
  const receiptID = createTaskReceiptID(base.taskID, base.status)
  const withReceipt = normalizeTaskMetadata({
    ...base,
    receipt: {
      version: 1,
      generation: 0,
      receiptID,
      taskID: base.taskID,
      status: base.status,
      phase: base.phase,
      createdAt: base.endedAt,
      deliveredToMessageID: "msg_user",
      deliveredAt: 4,
      acknowledgedAt: 5,
    },
  })
  assert.equal(withReceipt.receipt.receiptID, receiptID)
  const reopened = taskMetadata({ ...withReceipt, status: "queued", receipt: undefined, runGeneration: 1 })
  assert.equal(reopened.receipt, undefined)
  assert.equal(taskMetadata({ ...reopened, status: "completed" }).receipt.generation, 1)
  assert.equal(createTaskReceiptID(base.taskID, base.status), receiptID)
  assert.throws(() => normalizeTaskMetadata({
    ...base,
    receipt: { ...withReceipt.receipt, receiptID: "wrong" },
  }), /receiptID 与 Task 终态不一致/)
  const generation = 2
  const generatedReceiptID = createTaskReceiptID(base.taskID, base.status, generation)
  const generated = normalizeTaskMetadata({
    ...base,
    runGeneration: generation,
    receipt: {
      ...withReceipt.receipt,
      receiptID: generatedReceiptID,
      generation,
    },
  })
  assert.equal(generated.receipt.generation, generation)
  assert.throws(() => normalizeTaskMetadata({
    ...generated,
    receipt: { ...generated.receipt, generation: generation - 1, receiptID },
  }), /generation 与 Task runGeneration 不一致/)
})

test("Task input metadata 显式拒绝超过固定容量", () => {
  const base = {
    version: 1,
    revision: 1,
    sequence: 1,
    taskID: "o4e_task_inputs",
    kind: "agent",
    status: "running",
    phase: "model-running",
    ownerSessionID: "owner",
    taskSessionID: "ledger",
    childSessionID: "attempt",
    attemptSessionIDs: ["attempt"],
    agent: "worker",
    effect: "read",
    writeScopes: [],
    maxRetries: 1,
    attemptNumber: 1,
    retryRound: 0,
    runGeneration: 0,
    createdAt: 1,
    updatedAt: 2,
    diagnostics: [],
  }
  const inputs = Array.from({ length: TASK_PENDING_INPUT_LIMIT }, (_, index) => ({ version: 1, text: `input-${index}`, createdAt: index + 1 }))
  const normalized = normalizeTaskMetadata({ ...base, activeInputs: inputs, pendingInputs: inputs })
  assert.equal(normalized.activeInputs.length, TASK_PENDING_INPUT_LIMIT)
  assert.equal(normalized.pendingInputs.length, TASK_PENDING_INPUT_LIMIT)
  assert.throws(() => normalizeTaskMetadata({
    ...base,
    pendingInputs: [...inputs, { version: 1, text: "overflow", createdAt: 99 }],
  }), new RegExp(`最多允许 ${TASK_PENDING_INPUT_LIMIT} 条`))
  assert.throws(() => normalizeTaskMetadata({
    ...base,
    pendingInputs: [{ text: "missing version", createdAt: 1 }],
  }), /version 不支持/)
})

test("Task metadata 可选持久化 permission 和 question pending requests", () => {
  const base = {
    version: 1,
    revision: 3,
    sequence: 1,
    taskID: "o4e_task_pending",
    kind: "agent",
    status: "waiting_question",
    phase: "question-waiting",
    ownerSessionID: "owner",
    taskSessionID: "ledger",
    childSessionID: "attempt",
    attemptSessionIDs: ["attempt"],
    agent: "worker",
    effect: "read",
    writeScopes: [],
    maxRetries: 1,
    attemptNumber: 1,
    retryRound: 0,
    runGeneration: 2,
    createdAt: 1,
    updatedAt: 3,
    diagnostics: [],
  }
  assert.deepEqual(normalizeTaskMetadata(base).pendingRequests, [])
  const metadata = normalizeTaskMetadata({
    ...base,
    pendingRequests: [
      {
        version: 1,
        kind: "permission",
        requestID: "permission-1",
        sessionID: "attempt",
        state: "pending",
        requestedAt: 2,
        updatedAt: 2,
        permission: {
          action: "bash",
          resources: ["git status"],
          save: ["git *"],
          tool: { messageID: "msg-1", callID: "call-1" },
        },
      },
      {
        version: 1,
        kind: "question",
        requestID: "question-1",
        sessionID: "attempt",
        state: "submitting",
        requestedAt: 3,
        updatedAt: 4,
        question: {
          questions: [{
            header: "Target",
            question: "Which target?",
            options: [{ label: "Local", description: "Use local" }],
            multiple: false,
            custom: false,
          }],
          tool: { messageID: "msg-2", callID: "call-2" },
        },
      },
    ],
  })
  assert.equal(metadata.pendingRequests[0].permission.action, "bash")
  assert.equal(metadata.pendingRequests[1].question.questions[0].custom, false)
  assert.throws(() => normalizeTaskMetadata({
    ...base,
    pendingRequests: [
      metadata.pendingRequests[0],
      metadata.pendingRequests[0],
    ],
  }), /重复 request/)
})

test("Task 模型选择跳过已失败候选，并按 retry round 识别副作用", () => {
  const record = {
    modelCandidates: ["primary", "fallback-one", "fallback-two"].map((modelID) => ({ providerID: "provider", modelID })),
    currentModel: { providerID: "provider", modelID: "fallback-one" },
    failedModelCandidates: ["primary", "fallback-two"].map((modelID) => ({ providerID: "provider", modelID })),
    retryRound: 2,
    sideEffectWatermark: { retryRound: 1 },
  }
  assert.equal(nextTaskModelCandidate(record), null)
  assert.equal(taskHasCurrentRoundSideEffect(record), false)
})

test("Task 公共投影使用字段白名单并隐藏结果和内部恢复状态", () => {
  const snapshot = taskPublicSnapshot({
    version: 1,
    revision: 4,
    sequence: 1,
    taskID: "task-public",
    kind: "agent",
    status: "waiting_retry_decision",
    phase: "execution-interrupted",
    ownerSessionID: "owner",
    taskSessionID: "ledger",
    childSessionID: "attempt",
    agent: "worker",
    effect: "scoped-write",
    authorizationFingerprint: "secret-fingerprint",
    writeScopes: ["/workspace/private"],
    dispatchMessageID: "msg-secret",
    attemptSessionIDs: ["attempt"],
    modelCandidates: ["provider/model"],
    currentModel: { providerID: "provider", modelID: "model" },
    failedModelCandidates: [],
    maxRetries: 2,
    attemptNumber: 1,
    retryRound: 0,
    runGeneration: 2,
    retryDecision: {
      status: "pending",
      retryRound: 0,
      attemptNumber: 1,
      requestedAt: 3,
      error: "x".repeat(600),
    },
    pendingRequests: [{
      version: 1,
      kind: "question",
      requestID: "question-public",
      sessionID: "attempt",
      state: "pending",
      requestedAt: 3,
      updatedAt: 3,
      question: {
        questions: [{
          header: "Target",
          question: "Which target?",
          options: [{ label: "Local", description: "Use local" }],
          multiple: false,
          custom: false,
        }],
      },
    }],
    activeInputs: [{ version: 1, text: "private active input", createdAt: 2 }],
    pendingInputs: [{ version: 1, text: "next input", createdAt: 3 }],
    sideEffectWatermark: { tool: "edit" },
    result: { output: { value: "private output" } },
    diagnostics: [{ code: "execution-interrupted", message: "private diagnostic", at: 3 }],
    createdAt: 1,
    queuedAt: 1,
    startedAt: 2,
    updatedAt: 3,
  })

  assert.equal(snapshot.retryDecision.error.length, 512)
  assert.equal(snapshot.pendingRequests[0].question.questions[0].question, "Which target?")
  assert.equal(snapshot.runGeneration, 2)
  assert.equal(snapshot.pendingInputs[0].text, "next input")
  assert.deepEqual(snapshot.diagnostics, [{ code: "execution-interrupted", at: 3 }])
  for (const field of [
    "authorizationFingerprint",
    "writeScopes",
    "dispatchMessageID",
    "attemptSessionIDs",
    "modelCandidates",
    "currentModel",
    "failedModelCandidates",
    "sideEffectWatermark",
    "activeInputs",
    "result",
  ]) assert.equal(Object.hasOwn(snapshot, field), false, field)
  assert.equal(JSON.stringify(snapshot).includes("private"), false)
})

test("Task Group metadata 保存结构化 FIFO 引用", () => {
  assert.deepEqual(normalizeTaskGroupMetadata(), {
    version: 1,
    revision: 0,
    nextSequence: 1,
    taskRefs: {},
  })
  const group = normalizeTaskGroupMetadata({
    version: 1,
    revision: 2,
    nextSequence: 3,
    taskRefs: {
      task: {
        taskSessionID: "child",
        taskRevision: 4,
        kind: "agent",
        sequence: 2,
        createdAt: 10,
        receipts: [{
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
          receiptPhase: "completed",
          receiptDeliveredToMessageID: "user-1",
          receiptDeliveredAt: 21,
          receiptAcknowledgedAt: 22,
        }],
      },
    },
  })
  assert.deepEqual(group.taskRefs.task, {
    taskSessionID: "child",
    taskRevision: 4,
    receipts: [{
      receiptID: createTaskReceiptID("task", "completed"),
      receiptStatus: "completed",
      receiptGeneration: 0,
      receiptCreatedAt: 20,
      receiptPhase: "completed",
      receiptDeliveredToMessageID: "user-1",
      receiptDeliveredAt: 21,
      receiptAcknowledgedAt: 22,
    }],
    kind: "agent",
    sequence: 2,
    createdAt: 10,
  })
  const minimal = normalizeTaskGroupMetadata({
    version: 1,
    revision: 1,
    nextSequence: 2,
    taskRefs: { task: { taskSessionID: "child", kind: "agent", sequence: 1, createdAt: 1 } },
  })
  assert.deepEqual(minimal.taskRefs.task, { taskSessionID: "child", kind: "agent", sequence: 1, createdAt: 1 })
  assert.throws(() => normalizeTaskGroupMetadata({
    version: 1,
    revision: 2,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        taskRevision: 4,
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receiptID: createTaskReceiptID("task", "completed"),
        receiptStatus: "completed",
        receiptGeneration: 0,
        receiptCreatedAt: 20,
      },
    },
  }), /不支持字段: receiptID/)

  const queuedReceipts = normalizeTaskGroupMetadata({
    version: 1,
    revision: 3,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        taskRevision: 5,
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receipts: [{
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
          receiptDeliveredToMessageID: "user-1",
          receiptDeliveredAt: 21,
        }, {
          receiptID: createTaskReceiptID("task", "cancelled"),
          receiptStatus: "cancelled",
          receiptGeneration: 0,
          receiptCreatedAt: 30,
        }],
      },
    },
  })
  assert.deepEqual(queuedReceipts.taskRefs.task.receipts.map((receipt) => receipt.receiptID), [
    createTaskReceiptID("task", "completed"),
    createTaskReceiptID("task", "cancelled"),
  ])

  const sameTimeGenerations = normalizeTaskGroupMetadata({
    version: 1,
    revision: 3,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        taskRevision: 5,
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receipts: [{
          receiptID: createTaskReceiptID("task", "completed", 1),
          receiptStatus: "completed",
          receiptGeneration: 1,
          receiptCreatedAt: 20,
        }, {
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
        }],
      },
    },
  })
  assert.deepEqual(sameTimeGenerations.taskRefs.task.receipts.map((receipt) => receipt.receiptGeneration ?? 0), [0, 1])
  assert.equal(sameTimeGenerations.taskRefs.task.receipts.at(-1).receiptGeneration, 1)

  assert.throws(() => normalizeTaskGroupMetadata({
    version: 1,
    revision: 1,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receipts: Array.from({ length: TASK_REF_RECEIPT_LIMIT + 1 }, (_, generation) => ({
          receiptID: createTaskReceiptID("task", "completed", generation),
          receiptStatus: "completed",
          receiptGeneration: generation,
          receiptCreatedAt: 20 + generation,
        })),
      },
    },
  }), new RegExp(`未确认项最多允许 ${TASK_REF_RECEIPT_LIMIT} 条`))
  assert.throws(() => normalizeTaskGroupMetadata({
    version: 1,
    revision: 1,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receipts: [{
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
          receiptDeliveredToMessageID: "user-1",
          receiptDeliveredAt: 30,
          receiptAcknowledgedAt: 29,
        }],
      },
    },
  }), /确认时间早于投递时间/)

  const staleAcknowledgement = normalizeTaskGroupMetadata({
    version: 1,
    revision: 4,
    nextSequence: 2,
    taskRefs: {
      task: {
        taskSessionID: "child",
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        receipts: [{
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
          receiptDeliveredToMessageID: "user-newer",
          receiptDeliveredAt: 100,
        }, {
          receiptID: createTaskReceiptID("task", "completed"),
          receiptStatus: "completed",
          receiptGeneration: 0,
          receiptCreatedAt: 20,
          receiptDeliveredToMessageID: "user-older",
          receiptDeliveredAt: 50,
          receiptAcknowledgedAt: 75,
        }],
      },
    },
  }).taskRefs.task.receipts[0]
  assert.equal(staleAcknowledgement.receiptDeliveredToMessageID, "user-newer")
  assert.equal(staleAcknowledgement.receiptDeliveredAt, 100)
  assert.equal(staleAcknowledgement.receiptAcknowledgedAt, undefined)
})

test("Task Group metadata 归一化可选的冻结 recovery envelope", () => {
  const recoveryTask = {
    version: 1,
    revision: 2,
    sequence: 1,
    taskID: "task_1",
    kind: "agent",
    status: "running",
    phase: "model-running",
    ownerSessionID: "owner",
    taskSessionID: "child",
    childSessionID: "child",
    agent: "worker",
    effect: "scoped-write",
    writeScopes: ["/workspace"],
    dispatchMessageID: "msg_dispatch",
    attemptSessionIDs: ["child"],
    modelCandidates: [],
    failedModelCandidates: [],
    maxRetries: 1,
    attemptNumber: 1,
    retryRound: 0,
    runGeneration: 0,
    createdAt: 10,
    queuedAt: 10,
    startedAt: 11,
    updatedAt: 12,
    diagnostics: [],
  }
  const group = normalizeTaskGroupMetadata({
    version: 1,
    revision: 2,
    nextSequence: 2,
    taskRefs: {
      task_1: {
        taskSessionID: "child",
        taskRevision: 2,
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        recoveryEnvelope: {
          version: 1,
          task: recoveryTask,
          delegation: { taskID: "task_1", effect: "scoped-write", writeScopes: ["/workspace"] },
        },
      },
    },
  })

  assert.deepEqual(group.taskRefs.task_1.recoveryEnvelope.task, normalizeTaskMetadata(recoveryTask))
  assert.deepEqual(group.taskRefs.task_1.recoveryEnvelope.delegation, {
    taskID: "task_1",
    effect: "scoped-write",
    writeScopes: ["/workspace"],
  })
  assert.throws(() => normalizeTaskGroupMetadata({
    version: 1,
    revision: 2,
    nextSequence: 2,
    taskRefs: {
      task_1: {
        taskSessionID: "child",
        kind: "agent",
        sequence: 1,
        createdAt: 10,
        recoveryEnvelope: { version: 1, task: { ...recoveryTask, taskID: "other" } },
      },
    },
  }), /taskID 与父索引不一致/)
})

test("Task receipt 窗口满额未确认时删除全部已确认项", () => {
  const pending = Array.from({ length: TASK_REF_RECEIPT_LIMIT }, (_, generation) => ({
    receiptID: createTaskReceiptID("task", "completed", generation),
    receiptStatus: "completed",
    receiptGeneration: generation,
    receiptCreatedAt: generation,
  }))
  const group = normalizeTaskGroupMetadata({
    version: 1,
    revision: 1,
    nextSequence: 2,
    taskRefs: { task: {
      taskSessionID: "child", kind: "agent", sequence: 1, createdAt: 0,
      receipts: [...pending, {
        receiptID: createTaskReceiptID("task", "completed", TASK_REF_RECEIPT_LIMIT),
        receiptStatus: "completed", receiptGeneration: TASK_REF_RECEIPT_LIMIT,
        receiptCreatedAt: 30, receiptDeliveredToMessageID: "message", receiptDeliveredAt: 31, receiptAcknowledgedAt: 32,
      }],
    } },
  })
  assert.deepEqual(group.taskRefs.task.receipts, pending)
})
