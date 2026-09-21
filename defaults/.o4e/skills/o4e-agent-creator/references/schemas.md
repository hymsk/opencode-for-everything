# JSON Schemas

This document defines the JSON structures used by o4e-agent-creator.

## O4E model configuration

The implicit mode is `default`, which retains model configuration. Global config accepts
`defaultModel` and `fallbackModels`; selectable/delegatable Agents accept `model` and
`fallbackModels`. A model is `"provider/model"` or `{ "id": "provider/model", "variant": "high" }`.
An absent/null Agent model inherits the global default; absent fallbacks inherit the global
list, while `[]` disables them. Plan profiles inherit their source Agent model. Only `clear`
removes runtime model/variant projections and configured candidate chains; it never deletes
source configuration or host preferences. Explicit message selections remain authoritative.

---

## evals.json

Defines evaluation scenarios for an agent. Located at `evals/evals.json` within the skill directory.

```json
{
  "skill_name": "o4e-agent-creator",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt describing the agent to create or modify",
      "expected_output": "Description of expected result",
      "files": [],
      "expectations": [
        "只把 .o4e 作为可编辑真实源，不建议直接修改 .opencode",
        "明确说明 prompt 不是权限边界，并通过 loadTools/loadSkills 限制能力",
        "包含构建验证命令和至少两个真实评测场景"
      ]
    }
  ]
}
```

**Fields:**
- `skill_name`: Name matching the skill's frontmatter
- `evals[].id`: Unique integer identifier
- `evals[].prompt`: The task to execute
- `evals[].expected_output`: Human-readable description of success
- `evals[].files`: Optional list of input file paths (relative to skill root)
- `evals[].expectations`: List of verifiable statements for the grader

---

## grading.json

Output from the grader agent. Located at `<run-dir>/grading.json`.

```json
{
  "expectations": [
    {
      "text": "The expectation text from evals.json",
      "passed": true,
      "evidence": "Specific quote or description supporting the verdict"
    }
  ],
  "summary": {
    "passed": 2,
    "failed": 1,
    "total": 3,
    "pass_rate": 0.67
  },
  "claims": [
    {
      "claim": "Agent is read-only",
      "type": "permission",
      "verified": false,
      "evidence": "loadTools includes bash and edit; edit also enables host write/apply_patch"
    }
  ],
  "eval_feedback": {
    "suggestions": [
      {
        "assertion": "Optional — which assertion this relates to",
        "reason": "Why this assertion could be improved"
      }
    ],
    "overall": "Brief assessment of eval quality"
  }
}
```

**Fields:**
- `expectations[].text`: The original expectation text
- `expectations[].passed`: Boolean verdict
- `expectations[].evidence`: Supporting evidence
- `summary.passed/failed/total`: Counts
- `summary.pass_rate`: Fraction passed (0.0 to 1.0)
- `claims[]`: Extracted and verified claims
  - `type`: "permission", "structure", "behavior", "factual"
- `eval_feedback`: Improvement suggestions for the evals

---

## benchmark.json

Aggregated benchmark from multiple grading runs.

```json
{
  "skill_name": "o4e-agent-creator",
  "generated_at": "2026-08-15T12:00:00Z",
  "configurations": [
    {
      "name": "with_skill",
      "runs": [
        {
          "eval_id": 1,
          "eval_name": "security-auditor-creation",
          "pass_rate": 1.0,
          "passed": 3,
          "total": 3,
          "duration_ms": 45000
        }
      ],
      "aggregate": {
        "pass_rate": { "mean": 0.89, "stddev": 0.05, "min": 0.83, "max": 0.95 },
        "duration_ms": { "mean": 42000, "stddev": 3000, "min": 38000, "max": 45000 }
      }
    },
    {
      "name": "without_skill",
      "runs": [],
      "aggregate": {}
    }
  ],
  "delta": {
    "pass_rate": 0.22,
    "description": "with_skill improves pass_rate by 0.22 over without_skill"
  }
}
```

---

## Agent JSONC Structures

Repository default agent names, types, and localized descriptions are maintained in `defaults/.o4e/agents/default.jsonc`; the installer materializes the selected language into concrete Agent JSONC files and does not copy the catalog to target `.o4e/`. Installed and custom agents keep their own `description`. OpenCode manages Agent list ordering and default selection.

### All-mode Agent

```jsonc
{
  "$schema": "../../schemas/all-agent.schema.json",
  "name": "implementation-lead",
  "description": "可作为主 Agent 或子 Agent 的工程实现负责人",
  "plan": {
    "mode": "child",
    "permission": { "bash": "deny" },
    "reminder": "all/implementation-lead/plan-reminder"
  },
  "systemPrompt": "all/implementation-lead/system",
  "loadTools": ["question", "bash", "read", "glob", "grep", "edit", "task", "execute", "webfetch", "websearch", "lsp", "skill"],
  "loadAgents": ["*"],
  "loadWorkflows": ["feature-development"],
  "capabilities": ["workflow.coordinate", "implementation.change"]
}
```

### Primary Agent

```jsonc
{
  "$schema": "../../schemas/primary-agent.schema.json",
  "name": "security-auditor",
  "description": "只读审查认证、权限和敏感数据风险",
  "plan": { "mode": "self" },
  "systemPrompt": "primary/security-auditor/system",
  "loadTools": ["question", "read", "glob", "grep", "webfetch", "websearch", "lsp", "skill"],
  "loadSkills": [],
  "instructionFiles": {
    "global": ["<default>"],
    "project": ["<default>", "docs/project-rules.md"]
  }
}
```

### Subagent

```jsonc
{
  "$schema": "../../schemas/subagent-agent.schema.json",
  "name": "code-analyzer",
  "description": "分析代码质量和潜在问题",
  "systemPrompt": "subagent/code-analyzer/system",
  "loadTools": ["question", "read", "glob", "grep", "webfetch", "websearch", "lsp"]
}
```

### System Phase Agent

```jsonc
{
  "$schema": "../../schemas/system-phase-agent.schema.json",
  "name": "compaction",
  "systemPrompt": "system/compaction/system",
  "loadTools": [],
  "loadSkills": [],
  "instructionFiles": { "global": [], "project": [] }
}
```

### Config

```jsonc
{
  "$schema": "./schemas/config.schema.json",
  "soul": {
    "enabled": true,
    "file": "soul.md",
    "inheritMode": "override"
  },
  "instructionFiles": {
    "global": ["<default>"],
    "project": ["<default>", "docs/project-rules.md"]
  },
  "loadSkills": ["*"]
}
```

---

## Allowed Fields by Agent Type

### Primary (`agents/primary/*.jsonc`)

Use the shared fields in [agent-common.schema.json](../../../schemas/agent-common.schema.json) plus the type-specific fields in [primary-agent.schema.json](../../../schemas/primary-agent.schema.json). `nativeMode` and `plan` are allowed; validate model, blocklist, background-task and other shared fields against the current Schema rather than a copied field list.

### All (`agents/all/*.jsonc`)

Same selectable/delegatable fields as `primary`, except `nativeMode` is forbidden.

### Subagent (`agents/subagent/*.jsonc`)

Use the shared fields in [agent-common.schema.json](../../../schemas/agent-common.schema.json) and [subagent-agent.schema.json](../../../schemas/subagent-agent.schema.json). `nativeMode` is forbidden; `plan` supports both `mode: "self"` and `mode: "child"`. Expanded Plan Profiles remain delegation-only subagents and do not enter the primary selector. For example, `architect` with child Plan emits `architect` and `architect (plan)`; `reviewer` with self Plan emits only `reviewer (plan)`.

`capabilities` contains stable dotted Skill IDs, not localized descriptions; the field does not grant tools or permission. process-v1 Workflow Steps do not use `step.skill`, Agent selectors, or preferred bindings: ordinary `work` Steps run in the main Session, while `execution: {mode:task,agent:<name>}` requires a separately authorized ordinary Task call. `loadWorkflows` is an entry-Workflow allowlist and should follow role responsibility rather than defaulting every Agent to every Workflow; only managed primary/all root Sessions may use that entry.

### System (`agents/system/*.jsonc`)

Use [system-phase-agent.schema.json](../../../schemas/system-phase-agent.schema.json); selectable/delegatable Agent fields must not be inferred for this type.

Only `compaction`, `title`, `summary`.
