# Isolated Host Acceptance

These opt-in harnesses cover one bounded Agent Task watch/inspect/output scenario
and one independent Bash workspace/cwd scenario. They are not production
plugins or installed components and are excluded from both the npm package and
the default `npm test` command. Fixture tests do not contact model providers or
launch OpenCode.

## OpenCode V2 preview (read-only)

### Isolated Agent file generator (no V1 install or managed execution)

```bash
npm run build:v2-preview -- --config-root /absolute/source/.o4e --target /absolute/empty-project
node test/acceptance/v2-agent-preview.mjs
node test/acceptance/v2-agent-preview.mjs --package
```

The explicit generator consumes an already installed/valid `.o4e/` definition
and creates 13 prefixed V2 Agent Markdown files and a companion guard plugin in a **completely empty**
target directory; it refuses a symlink, nonempty target or invalid definition.
It does not replace `o4e build` or write user V1 files; it does register an
isolated guard plugin. It does not
translate V1 prompts into claims of managed V2 tools. All generated Agents
have a final blanket `deny` permission rule and a conspicuous preview prompt.
The exporter also rejects source/target overlap and uses exclusive `.opencode`
creation when publishing to avoid replacing a concurrently created empty
`.opencode` directory. A failed publication may leave `.opencode/plugins`,
and an interrupted promotion may leave preview Agent files. The guard is
published before the Agents; it never deletes foreign files as part of rollback.
An interrupted promotion is not a complete installation: inspect or discard
the isolated directory.
The opt-in host acceptance runs the generator against a fresh temporary
project and a credential-free local fake model on OpenCode 2.0.15, checking
the selected preview Agent's prompt and zero model-visible tools. The generated
files do not prove ownership of any globally configured same-name Agent;
do not move them into a real project without separately checking collisions.

The accompanying plugin checks effective Agent identity, preview marker,
final blanket deny and model-visible tools; it refuses a modified Agent
before its model request. Permission checks for preview Sessions are denied.
It does **not** prove global Agent file ownership, protect an installation
where another plugin removes/overrides its hooks, or implement V1 managed
execution. These are opt-in host regression checks:

```bash
node test/acceptance/v2-agent-preview.mjs --tamper
node test/acceptance/v2-agent-preview.mjs --collision
node test/acceptance/v2-agent-preview.mjs --global-collision
node test/acceptance/v2-agent-preview.mjs --probe
```

The first alters a generated Agent and requires model-request rejection. The
second adds a same-name project config definition and checks effective
zero-tool behavior; `--global-collision` adds a same-name global Agent in
the fixture XDG config directory. The final case has the fake provider emit
an unoffered Shell call and requires no Shell side effect. All use isolated
HOME/XDG projects; a name collision cannot establish source ownership.
`--package` packs and installs the current source package to a temporary path,
builds the preview with its unpacked CLI and loads its guard into the real V2
host; it does not publish or install into an existing user project.

### Native execution feasibility experiment (Linux, separate from preview)

```bash
node test/acceptance/v2-native.mjs
```

`v2-native.mjs` generates fresh fixture Agent files outside the repository and
loads the test-only `v2-native-probe-plugin.mjs` into OpenCode `2.0.15` with
isolated HOME/XDG directories. A loopback fake provider emits deterministic
native tool calls. The CLI explicitly selects that provider and a model hook
rejects other providers. It never registers O4E managed execution or reads user
credentials. Do not install this probe plugin into a user environment.

The cases compare native and publicly wrapped `shell.execute` for allow,
resource-specific deny, noninteractive ask rejection, and explicit `--auto`;
they also check interrupt after a shell starts and native child parentage and
permission behavior. Only fixture marker files are written. JSON evidence,
stdout/stderr, and a report are retained in the printed temporary directory.
Optional positional case names select cases; unknown names fail.

`native-child-bounded-ancestry` loads the standalone public-Session ancestry helper in the isolated probe and verifies a one-parent, bounded Shell decision. Unit coverage in `test/opencode-v2-session-ancestry.test.mjs` rejects missing or mismatched parent identity, cycles, excessive depth and failed reads. This is not parent-policy evaluation or a production permission hook.

The child-permission case **expects a non-equivalence**: a native child with
its own allow can run a command denied to its parent. Passing this experiment
does not establish O4E authority inheritance. `--auto` is test-only explicit
host auto-approval, not manual user approval. Human approval/rejection UI,
approval cancellation, Agent ownership conflicts, builder integration,
delegation depth, background lifetime/restart, and completed original Part
updates are not validated by these cases. Cancellation covers a simple shell
process, not all descendant/process-management scenarios.

The separate `@hymsk/o4e/v2/tui` export provides a CLI-only, read-only
`o4e-v2-status` slash/palette command. It reads the local selected O4E
configuration only when invoked and reports that managed execution is
unavailable. To test in an isolated V2 CLI, configure a CLI plugin directory
whose `index.mjs` re-exports this entry and list that directory in the
isolated `<XDG_CONFIG_HOME>/opencode/cli.json` `plugins` array. Do not list it as a server plugin or
overwrite the V1 `./tui` export. Neither this command nor the acceptance
below validates V2 managed execution, Agent Task UI, or server health.

`v2-preview.mjs` is a separate opt-in acceptance harness for OpenCode `2.0.15`.
It packs and installs the current npm artifact in a temporary project, resolves
the real `@hymsk/o4e/v2` export through a directory plugin, and uses an isolated
HOME/XDG environment and local, credential-free fake model. It checks that the
read-only `o4e_v2_status` tool returns a model-visible result and reports the
synthetic configured MCP server as **unprojected**. It does not install into a
user project, register MCP or managed execution, use real model credentials,
or establish V2 TUI / Agent Task support. Its temporary fixture path is printed
on success or failure; it is not a sanitized public report.

```bash
node test/acceptance/v2-preview.mjs
```

Set `OPENCODE_V2_BIN` to a trusted `2.0.15` binary path if `opencode2` is not
on `PATH`. npm installs the current artifact's dependencies into the temporary
project; the project under test and the isolated host never use live credentials.

The separate [process-v1 host checklist](workflow-process.md) describes the
still-unverified Workflow multi-turn, compaction, restart, evidence and UI
scenarios. None of the Task inspect or Bash cwd harnesses below validates them.

`workspace-cwd-acceptance.mjs` and `workspace-cwd-plugin.mjs` form a separate
opt-in real-host Bash harness. It
starts a credential-free local fake OpenAI-compatible provider, builds one fresh
temporary O4E target, launches OpenCode with distinct process cwd, worktree and
session directory, and verifies four actual `pwd` ToolParts plus the model-visible
Bash schema. The provider advances only after matching each call ID to its exact
model-visible output text, and stops on missing or incorrect results within a
bounded request count. Independently, real ToolParts must belong to the owning
Session and carry production O4E metadata with a completed durable command Task,
exit 0 and matching task IDs; builtin Bash cannot produce a false pass. It never
reads provider credentials and reports only the Bash schema and bounded command
evidence.
Run it explicitly with OpenCode on `PATH`:

```bash
node test/acceptance/workspace-cwd-acceptance.mjs
```

## Fixture Tests

An additional opt-in, credential-free real-host smoke covers `o4e_task follow`
read/stop/resume, both task-detail modes, and short/detached Bash watch/output:

```bash
node test/acceptance/task-follow-smoke.mjs
```

For nonempty Workflow list/checkpoint and TUI navigation/paging fixtures, add
`--cards`. This creates an isolated, explicitly loaded 22-step Workflow, checks
start/begin/list/pause/list, creates 21 real Bash Tasks and one read-only Agent
Task, and reads its watch/output. The bounded local provider allows up to 64
requests per mode. The resulting Sessions can be opened in an isolated TUI for
manual paging/details/navigation checks; CLI success alone is not visual proof.

`--storage` includes `--cards` and adds output-heavy commands. After OpenCode
exits, it reopens the actual Bun-written Command SQLite with Node SQLite and
compares exact outputs and source identities against the host ToolParts. The
report compares owner metadata bytes with the same records reconstructed in the
prior full-recovery layout. This is a per-snapshot payload comparison, not an
old/new A/B run or a measurement of total database/disk savings. Native Part
output and refresh paths are not replaced. This harness requires Node.js 24.

It builds fresh isolated targets and uses a bounded local fake provider. Its JSON
ToolPart evidence does not establish real-model behavior, TUI visual rendering,
full automatic-continuation lifecycle or cross-platform acceptance. The report
records the exact host and local SDK versions.

The Task fixture uses only the current public protocol: watch returns status and
events only; inspect owns tail/cursor/resume; output returns the authoritative
text on every explicit read without a `reread` option. The resolver fixture
persists production-rendered inspection text and verifies that body replacement,
cursor-source rewrites and missing anchors fail closed. Historical watch
preview/resume and output `reread` shapes are rejected, not retained as a
compatibility path.

Run from the repository root with Linux, Node >=22.18, and Python 3 supporting
Linux subreaper and pidfd APIs at `/usr/bin/python3`:

```bash
node --test test/acceptance/*.test.mjs
```

Tests use system temporary directories and simulated host records. Process
supervision tests start and clean up real, test-owned child processes. They are
not evidence that the real host or models passed acceptance. Normal product
regressions remain in `test/*.test.mjs` and run through `npm test`.

## Modules

| Files | Responsibility |
| --- | --- |
| `common.mjs` | Strict CLI arguments, source/index byte checks, owned-process supervision and bounded SSE validation |
| `wait-guard.mjs` | Durable two-wait allowance, public progress provenance and execution evidence; requires an explicit inspection evaluator |
| `resume-acceptance.mjs` | Evidence from actual parent ToolParts: status-only watch, inspect resume/fail-closed recovery, one output read and final pagination |
| `resume-acceptance-plugin.mjs` | One generated production Runtime plus fixed timer/evidence tools; preserves the production `o4e_task` object |
| `resume-closure-runner.mjs`, `resume-closure-plugin.mjs` | Frozen fixture inputs, finite setup/run/cleanup budgets, tool sequence and full-run evidence |
| `resume-dependencies.mjs` | Separately prepared and hash-verified offline dependency artifact |
| `resume-main.jsonc`, `resume-child.jsonc`, `resume-acceptance-prompt.md` | Explicit scenario inputs, not default Agent configuration |

## Explicit Host Runs

Dependency preparation resolves the current npm `latest` versions of `opencode-ai`,
`@opencode-ai/plugin` and `@opencode-ai/sdk`. It fails closed unless the host and
plugin versions match and the plugin's declared SDK dependency matches the SDK
`latest` version. The runner accepts the resolved version recorded in the supplied
artifact rather than a historical fixture pin, and rejects a different host as a
source mismatch. Host execution therefore requires that resolved OpenCode version
available on the caller's `PATH`, Linux `/proc`, the fixture-test prerequisites,
npm and Git. The host executable
is selected before constructing a private environment; no user-specific binary
path is assumed. Configuration is loaded in a new isolated process, never by
modifying an active installation or Session.

Use a separate source worktree whose files match its Git index byte-for-byte,
with no untracked or ignored files (including `node_modules`). Source validation
records HEAD and index tree and rejects uncommitted working-file differences.
Never stage unrelated work just to satisfy this precondition.

Every preparation/run directory must be a new direct child of the existing,
canonical `/tmp/opencode` directory. Never reuse an old run directory, guard,
database, installed dependency tree or report.

```bash
node test/acceptance/resume-dependencies.mjs \
  --prepare /tmp/opencode/o4e-resume-dependencies-new

node test/acceptance/resume-closure-runner.mjs \
  --source /tmp/opencode/o4e-resume-source \
  --run-root /tmp/opencode/o4e-resume-controlled-new \
  --mode controlled \
  --dependency-artifact /tmp/opencode/o4e-resume-dependencies-new/artifact \
  --dependency-sha256 "<artifactHash-from-preparation-report>"
```

Dependency preparation explicitly queries npm and downloads packages under a
separate 180-second budget. Each newly prepared artifact records the versions
resolved at preparation time, the exact dependency lock and every compressed
package integrity. Acceptance installs that artifact offline with no network
fallback. This makes a particular run reproducible without permanently freezing
future preparations to an old OpenCode release. If resolution fails or the latest
host/plugin/SDK metadata is inconsistent, preparation fails instead of silently
falling back. If a source version requires new runtime packages or emits a package
manifest, update and test artifact/setup compatibility before claiming it can run.
Do not overwrite a generated manifest, reuse old dependencies, or weaken the
integrity checks to pass setup.

`controlled` supplies explicitly synthetic SSE while the real host executes
tools. `live` instead forwards the two fixed Luna/MiMo routes declared in
`common.mjs`. It requires separate authorization for model usage and explicit
`--provider-config` and `--key-resolver` arguments naming private regular files.
The resolver exports `resolveKey`. No private default inputs are searched.
Do not commit provider inputs, credentials, databases, raw prompts or host logs.
When operating through Zellij, use Zellij MCP for terminal lifecycle operations.

## Evidence And Limits

- Total run budget: 600 seconds, including 90 seconds of setup; cleanup starts
  at 595 seconds, with a hard exit at 599 seconds. Requests are capped at 180
  seconds, 68 parent calls and 3 child calls, with finite byte/token budgets.
- The child must emit verified public BEGIN/MIDDLE text and complete exactly
  two real 45-second waits, then 100 bounded literal STREAM lines and one final
  marker. Reasoning, tool arguments and self-reports cannot replace public text.
- The parent creates one Task, alternates bounded progress `inspect` calls with
  status-only `watch`, collects output once without `reread`, and makes four final
  inspect calls. No manual cursors, replacement Task, retry, restart or extra
  task-management actions are allowed.
- Gaps remain inspect discontinuity evidence. Only the scenario's explicit fresh
  inspect recovery allowance can cross them; no output editing or lossless claim
  is permitted. A watch `user-message` result fails the bounded run so the real
  user instruction remains authoritative.
- Source/generated code, frozen authority, actual tool sequence, output body and
  result references must all agree. A marker or partial fixture check is not a
  full-run PASS. The report is `<run-root>/report.json`; the whole run directory
  is not a sanitized report.
- Moving or testing the harness does not establish a new controlled/live PASS.
  Revalidate the exact source, host, dependency artifact and configuration for
  each explicit run. This scenario does not validate global Bash takeover.
# V2 native ancestry contrast (not production permission inheritance)

`node test/acceptance/v2-native.mjs native-child-permissions native-child-parent-hook native-child-parent-hook-failure` runs isolated OpenCode 2.0.15 with a credential-free local model. The first case observes a native child exceeding its parent's Shell deny; the second uses public `session.get` ancestry and `permission.hook("evaluate")` to turn the child's allow into a deny before side effects. The third forces a failed public Session lookup during evaluation and requires no Shell side effect. A child may still return a `completed` label after that error. These three cases do not establish full policy inheritance, ancestor traversal, ask flows, other tools or lifecycle recovery. See `SPEC.md` `V2-NAT-003` for the independent V2 acceptance target.
