# O4E Compared with Native OpenCode Capabilities

[English](opencode-comparison.md) | [中文](opencode-comparison.cn.md)

## One-sentence positioning

**Native OpenCode capabilities answer how an Agent uses tools to complete work; O4E answers how multiple Agents and background tasks are organized, constrained, recovered, and audited.**

O4E (`opencode-for-everything`) is a plugin system running on top of OpenCode. It is not another Agent and is not an OpenCode replacement. It reuses OpenCode Sessions, Tools, permission prompts, the Host Shell, and the plugin mechanism, then adds Agent orchestration, the Task Runtime, Workflow, Scope Lock, and configuration lifecycle management.

```text
OpenCode = Agent host and tool runtime
O4E      = Agent orchestration and governance layer
```

## Overall comparison

| Capability | Native OpenCode | What O4E adds or changes |
| --- | --- | --- |
| Agent conversation | Provides Agents, models, and tool calls | Reuses the host and adds role catalogues, capability, and permission governance |
| Native Agents | Supports `build`, `plan`, `general`, and `explore` | Can retain, take over, or disable them through `keep`, `managed`, and `disable` policies |
| Custom Agents | Configurable Agents | Uses `all`, `primary`, `subagent`, and `system` layouts to separate usage boundaries |
| Agent delegation | Native `task` calls | Managed `task` calls with candidate validation, parent chains, depth, ownership, and permission rechecks |
| Background tasks | Provides host-level execution | Persistent Tasks, status reads, output reads, cancellation, recovery, and receipt deduplication |
| Shell | Executes commands using the host Shell configuration | The managed `bash` tool places commands under Command Tasks, permissions, logs, and lifecycle management |
| Permissions | Host permission rules and user authorization | O4E can only tighten host permissions and adds Agent, Task, Scope, and ownership constraints |
| Workflow | Steps are mainly arranged by the Agent | Experimental Beta, disabled by default; when enabled, provides a main-session process-v1 DAG, Gates, bounded repair, and explicit recovery |
| Skill / Prompt | Supports host directories and configuration | `.o4e/` centrally manages Prompts, Skills, Soul, Agents, and Workflow |
| MCP / Tool | Host-level configuration | Each Agent can control loaded Tools, MCPs, Skills, and delegation targets |
| Model selection | Uses the host's existing mechanisms | `default` preserves default/Agent models and fallback candidates; child tasks freeze target candidates or the parent model; model errors require an explicit resolve by the main Agent and do not switch automatically; `clear` only clears the runtime projection |
| Installation and uninstall | Mainly manual configuration | Provides install, build, status, import, export, and uninstall lifecycles |

## What O4E adds

### 1. Professional Agent roles and capability boundaries

Default roles are organized by engineering responsibility, for example:

| Role | Main responsibility |
| --- | --- |
| `orchestrator` | Break down work, coordinate sub-tasks, and summarize results |
| `architect` / `architect (plan)` | Architecture design and module-boundary analysis; the normal Profile may implement, while the Plan Profile is read-only |
| `debugger` | Reproduce problems, find root causes, and implement fixes |
| `tester` | Design tests, cover boundaries, and validate behavior |
| `reviewer (plan)` | Review code, architecture, and regression risks |
| `researcher (plan)` | Research material, compare options, and organize evidence |
| `chat (plan)` | Read-only conversation and requirements discussion; the source configuration name is `chat` |

An Agent is more than a Prompt. It can declare:

- which Tools, Skills, and MCPs it may use;
- which Agents it may delegate to;
- whether it may act as a main Agent or sub-agent;
- which permissions and Plan Profile it uses;
- how many delegation layers it may continue to create.

**Why add this:** writing “you are a reviewer; do not modify files” in a Prompt is not a reliable permission boundary. O4E applies role constraints through configuration, tool capabilities, host authorization, and Runtime validation.

**Advantage:** roles can be reused, reviewed, and versioned, reducing the risk of an Agent misusing tools.

### 2. Controlled Agent delegation

The managed O4E delegation flow is:

```text
Choose a legal Agent
  → validate current identity and parent chain
  → validate depth, permissions, and Scope
  → request host authorization
  → create and persist a child Task
  → execute, settle, and deliver the receipt
```

Additional constraints include:

- only Agents currently allowed by the parent may be selected;
- a child Agent cannot manage its parent Task or sibling Tasks;
- `permissionOverlay` may only tighten permissions, never expand them;
- a child task inherits its ancestors' permissions and side-effect boundaries;
- identity, permission, and ownership are revalidated during recovery and redispatch;
- `maxDelegationDepth` limits delegation depth and prevents unbounded recursion.

**Why add this:** in complex collaboration, a model calling native `task` on its own can cause privilege escalation, unclear task ownership, and unbounded nesting.

**Advantage:** the delegation chain has explicit identity, boundaries, and lifecycle semantics suitable for multi-role engineering work.

### 3. Persistent background Tasks

O4E models background Agent work as manageable Tasks rather than one-shot calls:

```text
Task
├── taskID
├── ownerSessionID
├── parent / child relationship
├── status and terminal state
├── output and read cursors
├── permissions and Scope
└── receipt and recovery information
```

`o4e_task` supports:

```text
status   read status
watch    wait for status events from multiple Tasks
inspect  read a bounded process tail
output   read final body text
cancel   request cancellation
pending  inspect pending requests
```

**Why add this:** long-running work may continue after the current response ends, or encounter state inconsistencies during Session reload, new user messages, oversized output, or parent cancellation.

**Advantage:** long-running work can be queried, cancelled, recovered, and deduplicated; bounded output reads prevent arbitrarily large logs from being placed into model context.

### 4. Managed Host Shell Command Tasks

O4E retains OpenCode's external tool name `bash`, but internally handles it as a managed Host Shell command. The execution chain is:

```text
Host Shell configuration
  → permission prompt
  → resource admission and queueing
  → reauthorization and Command claim persistence confirmation
  → execution and output capture
  → log archival
  → terminal settlement
```

Command execution follows the Host Shell Profile selected by OpenCode `config.shell`; it does not force commands to use Linux `/bin/bash`. The target Shell determines command syntax, argument protocol, working directory, and environment behavior. O4E does not translate between PowerShell, `cmd.exe`, Bash, or other Shells. Current background execution is handled by O4E's own `src/command-core/command-execution-port.mjs`, not by directly wrapping an OpenCode-native Bash `ChildProcess` handle; the public plugin API does not currently expose a detachable native command handle.

Additional capabilities include:

- short commands return directly, while long commands detach and return a stable `taskID`;
- admission, running, and execution timeouts are separate;
- output capture, truncation markers, logs, and SHA-256;
- command-level `status/watch/inspect/output/cancel`;
- a per-owner command concurrency limit, without participating in Agent or other Bash write-range exclusion;
- lifecycle handling for Session deletion, explicit cancellation, and plugin disposal.

**Why add this:** native Shell calls are suitable for immediate commands; engineering work also needs managed long-running builds, tests, scans, and large outputs.

**Advantage:** Shell commands and Agent Tasks have consistent ownership, status, permissions, logs, and cancellation semantics.

### 5. Dual permissions and Scope Lock

O4E does not replace OpenCode host authorization. It adds a tightening layer above it:

```text
Agent capability
  → O4E Runtime permission
  → Task / Scope Lock
  → OpenCode context.ask
  → final host authorization
```

Important principles:

- O4E `allow` cannot bypass host `context.ask`;
- a child task cannot forge ownership through arguments;
- `permissionOverlay` cannot expand ancestor permissions;
- an uncertain lock cannot be released until process termination is confirmed;
- Bash/Host Shell commands default to `unknown-write` handling.

**Why add this:** tool permission can answer “may this be called?”, but does not fully answer who initiated it, who owns it, who can cancel or recover it, or who holds the side-effect boundary during concurrency.

**Advantage:** Agent identity, task ownership, and side-effect scope form one verifiable model, reducing concurrent-write and privilege risks.

### 6. Declarative Workflow (Beta)

Workflow is an experimental Beta, disabled by default, and is not presented as production-ready. It becomes available only after explicitly setting `"enableWorkflow": true` in `.o4e/config.jsonc`, then rebuilding and restarting; Agent permissions and definition files cannot replace this switch. Workflows under `.o4e/workflows/` can express:

- DAG dependencies;
- `work` Steps executed by the current main Agent;
- StepReports and Gates;
- three bounded fact references: `command-success`, `task-created`, and `task-result`;
- explicit bounded repair after a Gate rejection;
- owner Session interruption and checkpoint recovery;
- optional explicit Task requirements, still subject to independent `task` authorization and lifecycle handling.

For example:

```text
Requirements → solution Gate → implementation → validation Gate
                                      └→ explicit bounded repair after rejection
```

**Why add this:** when steps are arranged only through a Prompt, a model may skip tests, retry forever, or lose checkpoints after interruption.

**Advantage:** process dependencies and acceptance conditions can be reused, checked, and recovered without pretending to be a background multi-Agent scheduler. Nested workflows, loops, parallel main Steps, and main-Session Scope sandboxes are not supported; real OpenCode multi-turn, restart, and authorization-UI acceptance still require separate verification.

### 7. Unified configuration and installation lifecycle

Users maintain `.o4e/`; the installer generates the `.opencode/` runtime:

```text
.o4e/ configuration source  ── install/build ──>  .opencode/ runtime
```

`.o4e/` can centrally store:

- Agents;
- Prompts;
- Skills;
- Soul;
- MCP;
- Workflows;
- permission policies;
- global O4E configuration.

**Why add this:** when Agents, Prompts, Skills, MCPs, and processes are spread across directories, versioning, review, and secure migration become difficult.

**Advantage:** configuration sources and generated output are separated; changes can be rebuilt, and install, status, import, export, and uninstall have unified entry points.

## O4E's core advantages

### From Prompt constraints to Runtime governance

Native OpenCode mainly relies on an Agent understanding its Prompt and selecting tools. O4E moves critical boundaries into the Runtime:

```text
Legal Agent
→ legal Tool
→ legal permission
→ legal Task ownership
→ legal Scope
→ legal recovery
```

Prompts express role and intent; the Runtime enforces execution boundaries. They are complementary, not interchangeable.

### Better suited to long-running work and multi-Agent collaboration

Native OpenCode is well suited to immediate conversation and one-shot tool calls. O4E is better suited to:

- multiple specialist Agents working in parallel;
- long-running builds, tests, and scans;
- implementation processes with explicit Gates;
- team projects that require permission and ownership audits;
- tasks that must remain manageable after Session lifecycle changes.

### Easier standardization and review

Teams can standardize rules such as:

```text
All research is performed by researcher
All tests are performed by tester
All reviews are performed by reviewer
All writes pass permission and Scope checks
All long commands become durable Command Tasks
```

These conventions can live in the repository and pass code review instead of existing only in individual Prompt habits.

## Costs and boundaries

O4E adds governance capabilities, but also increases system complexity:

- there are more configuration, permission, Task, Scope, and recovery paths;
- it depends on the OpenCode Plugin API, Sessions, and `context.ask`;
- the Runtime performs additional authorization, persistence, logging, and state work;
- Scope Lock is in-process coordination, not an OS sandbox, container, or virtual machine;
- O4E does not provide an independent Agent service, HTTP/SSE Gateway, remote A2A network, or cross-host scheduler;
- Host Shell behavior is determined by OpenCode and the current platform. Linux has real lifecycle verification; Windows and macOS startup, encoding, process identity, and process-tree termination still require target-platform or CI evidence. Platform branches, Mock tests, and a passing Linux suite cannot replace that evidence.

Therefore, simple one-shot tasks can use native OpenCode directly. Use O4E when you need role separation, long-running work, recovery, permission governance, or process Gates.

## How to choose

| Scenario | Recommendation |
| --- | --- |
| Quick questions, simple edits, one-shot commands | Use native OpenCode capabilities |
| Short debugging by one Agent | Native capabilities are usually enough |
| Collaboration between specialist roles | Use O4E |
| Long-running background work | Use the O4E Task Runtime |
| Recoverable implementation-test-review checkpoints for the main Agent | Use O4E Workflow |
| Strict permission, ownership, and concurrency boundaries | Use O4E |
| Independent Agent services or remote multi-host networking | O4E does not currently provide this |

## Summary

```text
Native OpenCode: lets an Agent do things
O4E: makes the Agent do them under controllable roles, permissions, processes, and lifecycles
```

O4E is not merely another tool. It extends OpenCode into a configurable, governable, recoverable, and auditable Agent engineering runtime while retaining OpenCode as the sole host and preserving the Host Shell's native selection.
