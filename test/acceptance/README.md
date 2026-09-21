# Isolated Host Acceptance

These opt-in harnesses cover one bounded Agent Task watch/inspect/output scenario
and one independent Bash workspace/cwd scenario. They are not production
plugins or installed components and are excluded from both the npm package and
the default `npm test` command. Fixture tests do not contact model providers or
launch OpenCode.

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
