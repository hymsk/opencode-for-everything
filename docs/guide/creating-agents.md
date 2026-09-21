# Creating and Improving Agents

[English](creating-agents.md) | [中文](creating-agents.cn.md)

[← Documentation Hub](../README.md) | [Agent Reference](../reference/agents.md) | [Prompt Fields](../reference/agents.md#prompt-fields)

After installation, you can invoke the `o4e-agent-creator` Skill to create, review, and iteratively improve o4e agents. It guides the agent to work from the real sources in `.o4e/`, the Schemas, neighboring roles, project rules, and the current prompt, rather than directly editing the generated `.opencode/` files.

You can state the task directly, for example:

```text
Add a read-only security-auditor to this project to review authentication, permission, and sensitive-data risks.
```

```text
Improve the orchestrator so that implementation tasks strictly follow the project's acceptance rules and load applicable Agent capabilities or declarative Workflows on demand.
```

## Skill Workflow

1. Confirm the Agent type, responsibilities, non-goals, and acceptance method: `all` can serve as primary or child, `primary` only as the main Agent, `subagent` can only be delegated to, and `system` is limited to fixed internal stages.
2. Read the corresponding Schema, existing agents, installed prompts in `.o4e/prompts/`, and applicable project rules; if the role requires additional project contracts, read the corresponding instruction files as configured.
3. Choose tools, Skills, MCPs, `permission`, `loadAgents`, and role-scoped `loadWorkflows`; the prompt does not carry permission control. `capabilities` may be used for role descriptions, but the current process-v1 Workflow does not automatically select Agents based on the legacy `step.skill`.
4. Modify the real sources in `.o4e/agents/`, `.o4e/prompts/`, or `.o4e/skills/`.
5. Choose Plan explicitly: `mode:self` generates only `<name> (plan)`, `mode:child` keeps the source Agent and additionally generates `<name> (plan)`; omitting it provides no Plan. The native `plan` also uses this lowercase suffix; unsuffixed self names and the historical `<name> (Plan)` are not accepted. Source names must not contain parentheses; the default read-only intersection can be overridden by explicit configuration inside the `plan` object.
6. Design 2-3 real scenarios covering normal tasks, permission boundaries, project-rule conflicts, Plan behavior, or Agent-to-Agent delegation.
7. Build, run the relevant tests, and iterate based on observations.

Roles and methods should be modeled separately: add a new Agent only when independent permissions or session boundaries are needed; prefer making reusable single-Agent methods into on-demand Skills; the main Agent's sequencing, dependencies, Gates, and recovery can be written as a process-v1 Workflow. When multiple Agents are needed, the main Agent explicitly calls `task`, which still independently passes authorization, depth, and lifecycle checks; neither Skills nor Workflows may bypass Agent permissions.

The Skill source file is located at:

```text
.o4e/skills/o4e-agent-creator/SKILL.md
```

For the repository default version and the complete method, see
[`o4e-agent-creator` Skill](../../defaults/.o4e/skills/o4e-agent-creator/SKILL.md#先确认边界).

The repository default version also includes an initial evaluation set:

```text
.o4e/skills/o4e-agent-creator/evals/evals.json
```

Both the Skill and the evaluation scenarios can be maintained manually over time. After modifying the Skill or installer selections, run:

```bash
node scripts/installer.mjs build --target /path/to/project
```

The Builder validates the default Skills in the internal registry in place; the plugin registers `.o4e/skills/` directly and does not generate or overwrite `.opencode/skills/`. After modifying agents, Skills, or permission configuration, you need to restart OpenCode for the loaded configuration to take effect.

## End-to-End Example: Creating a security-auditor

The following example shows how to create a read-only `security-auditor` Agent from scratch.

### Step 1: Determine the Type and Responsibilities

- **Type**: `all` (can be selected as the main Agent and can also be delegated to by the orchestrator)
- **Responsibilities**: Review authentication, permissions, sensitive-data handling, and dependency security
- **Non-goals**: Does not modify code, run builds, or deploy

### Step 2: Create the Agent Configuration

Create `.o4e/agents/all/security-auditor.jsonc`:

```jsonc
{
  "$schema": "../../schemas/all-agent.schema.json",
  "name": "security-auditor",
  "description": "Reviews authentication, permission, and sensitive-data risks; read-only",
  "systemPrompt": "all/security-auditor/system",
  "loadTools": ["read", "glob", "grep", "question"],
  "permission": {
    "bash": "deny",
    "edit": "deny"
  },
  "loadAgents": [],
  "loadWorkflows": [],
  "plan": {
    "mode": "self",
    "permission": {
      "bash": "deny",
      "edit": "deny"
    }
  }
}
```

### Step 3: Create the Prompt

Create `.o4e/prompts/all/security-auditor/system.md`:

```markdown
# Security Auditor

You are a security review expert. Your responsibilities are:

1. Review authentication and authorization implementations
2. Check sensitive-data handling (passwords, tokens, keys)
3. Assess dependency security
4. Identify potential security vulnerabilities

## Review Checklist

- [ ] Whether passwords use secure hashing
- [ ] Whether tokens/keys are hardcoded
- [ ] Whether input validation is complete
- [ ] SQL injection/XSS protection
- [ ] Whether dependency versions have known vulnerabilities

## Output Format

Report issues classified by risk level:
- **Critical**: Must be fixed immediately
- **High**: Should be fixed before release
- **Medium**: Suggested improvement
- **Low**: Optional optimization
```

### Step 4: Build and Verify

```bash
# Build the runtime
node scripts/installer.mjs build --target /path/to/project

# Check the generated result
node scripts/installer.mjs status --target /path/to/project
```

### Step 5: Test Scenarios

Select `security-auditor` in OpenCode and test the following scenarios:

1. **Normal task**: "Review the authentication implementation of this project"
2. **Permission boundary**: Try to make the agent modify files (should be denied)
3. **Delegation test**: Delegate a security review task from the orchestrator

### Step 6: Iterate and Improve

Adjust based on test results:
- Modify the prompt to improve review quality
- Adjust `loadTools` to support more read-only operations
- Add `loadWorkflows` to support security review Workflows
