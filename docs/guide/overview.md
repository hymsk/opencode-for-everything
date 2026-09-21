# Project Overview

[English](overview.md) | [中文](overview.cn.md)

[← Documentation Hub](../README.md) | [Quick Start](../getting-started/quick-start.md) | [Configuration Reference](../reference/configuration.md)

`opencode-for-everything` is a project-level Agent and Workflow configuration system running on top of OpenCode. It lets teams prepare specialized roles for different development tasks and manage those roles' prompts, tools, Skills, MCPs, permissions, and collaboration flows together with the project.

## Project Positioning

Once a project starts using multiple Agents, configuration is often no longer just a system prompt: architecture design, code implementation, debugging, testing, and review need different contexts, tool permissions, and ways of working, and complex tasks also need reliable main-session checkpoints and interruption recovery.

This project provides a unified entry for these needs:

| Need | Project capability |
| --- | --- |
| Specialized role division | Agent roles, contexts, and capabilities are expressed explicitly through configuration. |
| Configuration governance | Project configuration can be version-controlled and code-reviewed. |
| Collaboration boundaries | Each Agent's delegation targets and available Workflows are controllable. |
| Process reuse | Repeated processes can be defined once and reused across tasks. |
| Deployment boundary | OpenCode is the sole host; no additional Agent service needs deploying. |

## Core Model

```text
.o4e/                        build                       .opencode/
project-editable config      ─────────────────────────>  runtime loaded by OpenCode
```

`.o4e/` is the user-maintained configuration source, containing Agents, Workflows, prompts, Skills, Soul, and permission policies. The installer reads and validates this configuration, then generates the Agent and plugin entries in `.opencode/`; the plugin registers `.o4e/skills/` directly with OpenCode.

Day to day you only edit `.o4e/`. `.opencode/` can be regenerated at any time and therefore should not be maintained by hand.

## Agent Division

The default installation provides 7 custom roles:

| Agent | Suitable tasks |
| --- | --- |
| `orchestrator` | Multi-step development tasks that need decomposition, coordination, and summarization |
| `architect` / `architect (plan)` | Requirement clarification, solution design, and module boundary analysis; the regular Profile can implement per task, the Plan Profile is read-only |
| `debugger` | Defect reproduction, root-cause location, and fixing |
| `tester` | Test design, boundary coverage, and behavior verification |
| `reviewer (plan)` | Code review, architecture review, and regression risk analysis |
| `researcher (plan)` | Technical research, material comparison, and evidence organization |
| `chat (plan)` | Read-only pure conversation and requirement discussion; source configuration name `chat` |

Agents are also divided by usage:

| Type | Purpose |
| --- | --- |
| `all` | Can be selected from the Agent Selector and can also be delegated to by other Agents |
| `primary` | Can only serve as the main Agent of the current session |
| `subagent` | Can only serve as a controlled delegation target |
| `system` | Internal stages used fixedly by OpenCode |

During installation you can choose to take over the native `build`, `plan`, or enable the native `general`, `explore`. See the [Agent Reference](../reference/agents.md) for configuration details.

## How Workflows Collaborate

A Workflow is a process-v1 main-session checkpoint protocol in `.o4e/workflows/`, suitable for expressing development processes that need reuse, acceptance, and recovery. For example, the main Agent can complete requirement analysis, implementation, and verification in sequence, submitting a structured report after each Step for Runtime Gate acceptance.

| Workflow capability | Description |
| --- | --- |
| DAG dependencies | Only Steps whose dependencies have passed their Gates become ready; currently only one active Step at a time. |
| Main-session execution | Ordinary Steps are completed directly by the current main Agent; no Workflow execution Session is created. |
| Explicit Task | A Step can ask the main Agent to separately call the existing `task`, but authorization, waiting, and cancellation still belong to the Task protocol. |
| Gate | Accepts StepReports by output Schema, Artifact counts, and bounded fact references. |
| Bounded repair | After a Gate rejection, the next Attempt can be started explicitly within the configured count; work is not replayed automatically. |
| Checkpoint recovery | Runs are stored in owner Session metadata; after a new message, handle the instruction first, then explicitly read/resume. |

Ordinary tasks can be handed directly to a single Agent. Create a Workflow only when the process itself is worth reusing, constraining, or recovering.

## Skills and Soul

| Component | Role |
| --- | --- |
| Skill | Provides on-demand methods and operating guidance without expanding an Agent's existing permissions. |
| Soul | Provides shared user background and durable preferences across multiple roles. |

## Applicable Scenarios

| Scenario | Support |
| --- | --- |
| Using multiple specialized Agents in the same project | Supported |
| Version-managing Agent configuration together with code | Supported |
| Restricting tools, permissions, and delegation scope per role | Supported |
| Distilling implementation, testing, and review into recoverable main-session Workflows | Supported |
| Running standalone Agent processes or Agent Cards | Not provided |
| Providing an HTTP/SSE Gateway or push notifications | Not provided |
| Running remote A2A or cross-host Agent networks | Not provided |

## Related Documents

| Topic | Document |
| --- | --- |
| Installation and first run | [Quick Start](../getting-started/quick-start.md) |
| Agent customization | [Creating and Improving Agents](./creating-agents.md) |
| Workflow orchestration | [`o4e-workflow-creator` Skill](../../defaults/.o4e/skills/o4e-workflow-creator/SKILL.md#design-steps) |
| Configuration fields | [Configuration Reference](../reference/configuration.md) |
| Comparison with OpenCode native capabilities | [Capability Comparison](./opencode-comparison.md) |
