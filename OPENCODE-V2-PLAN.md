# OpenCode V2 adaptation plan and status

[中文](OPENCODE-V2-PLAN.cn.md) | [English](OPENCODE-V2-PLAN.md)

## Conclusion

### Host merge checks for the deny-all preview (isolated project only)

The exporter now includes an isolated `.opencode/plugins/o4e-v2-preview-guard/` alongside `.opencode/agents/`. Public `session.context` and `session.model.request` hooks check effective Agent identity, preview marker, final blanket deny and model-visible tools; host permission evaluations belonging to preview Sessions are additionally denied. An Agent modified to append `shell: allow` after the deny is rejected before a model request. A conflicting project config definition was observed with zero effective tools; a fake model's attempted unlisted `shell` call had no command side effect. The guard only covers an isolated environment where it actually loads: it **does not** establish global same-name Agent ownership, safe interactions with other plugins, production installation, or V1 managed execution. Reproduce with `node test/acceptance/v2-agent-preview.mjs --tamper`, `--collision`, and `--probe`.

`--package` separately packs the source, builds from its temporary npm-installed CLI, and loads the guard in the real 2.0.15 host; it neither publishes to npm nor installs into an existing user project.

A separate Zellij tab subsequently tested the generated preview from current source with the real `newapi-openai/gpt-6-luna` model under a repository-external isolated HOME/XDG. The normal run returned `LUNA_V2_PREVIEW_OK`, exited 0, and used no tools; after appending `shell: allow` to the same preview Agent, the guard rejected the model request with `O4E_V2_PREVIEW_AGENT_UNVERIFIABLE`, exited 1, and used no tools. The temporary V2 configuration was mode `0600` and held only an environment-variable key reference; the wrapper stays outside this repository and did not read or modify user V1 configuration. This is not real-model verification of a published npm version, production installation, or managed execution.

Following independent review, an isolated XDG global same-name Agent was also tested; zero tools remained visible, but identity and final deny do not prove source ownership. The user workflow must isolate HOME/XDG, not just create an empty directory. The guard denies permissions only for Sessions whose **own Agent** is a preview identity, not unrelated child identities. Single-line variants such as `high+fast` are safely serialized; those containing `#` remain rejected rather than changing model-reference meaning.

### Separate V2-native contract and ancestry experiment (not V1-equivalent)

`V2-NAT-001`–`005` in the root `SPEC.md` are authorized **incremental targets**, not completed functionality; the V1 managed contract remains in force. In isolated OpenCode 2.0.15 runs using separate HOME/XDG directories and a local fake model, a native child with `shell: allow` executed a command denied by its parent's resource rule when no narrowing hook was installed. In the public `permission.hook("evaluate")`, `session.get(child.parentID)` exposed the parent's agent; changing the child's Shell decision from `allow` to `deny` prevented the actual side effect. When a public `session.get` lookup of a nonexistent Session failed during evaluation, the Shell also did not run, but the child result could still be labelled `completed`. Reproduce with `node test/acceptance/v2-native.mjs native-child-permissions native-child-parent-hook native-child-parent-hook-failure`. This demonstrates **one native Shell decision can be tightened, including fail-closed execution on a lookup error**, not complete parent permission inheritance. Dynamic parent-policy evaluation, ancestor chains, other tools, ask flows, error visibility and restart are unverified. A native child still uses its own permissions by default.

`src/adapters/opencode-v2/session-ancestry.mjs` now walks the physical ancestry via public `session.get`, with a strict depth bound and rejection of missing or mismatched IDs, cycles and API failures. Unit tests cover these boundaries; `native-child-bounded-ancestry` combines the bounded lookup with one real-host Shell denial. Agent identities do not prove file ownership or parent policy, so this helper grants no execution authority.

The current V2 user-facing scope is an opt-in read-only status tool/TUI command and deny-all Agent preview in an empty isolated project; native Shell/child probes are not wired to production execution. Production V2 installation, Agent ownership, dynamic authority narrowing, background management and recovery, post-return original Tool Part updates, and V1 equivalence remain missing. `SPEC.md` governs the independent targets and acceptance gates.

### Standalone V2 Agent generator (explicit opt-in, not managed execution)

`npm run build:v2-preview -- --config-root /absolute/.o4e --target
/absolute/empty-project` reuses the existing definition validation and Plan
expansion, writing prefixed, deny-all V2 Markdown Agents into an existing
completely empty directory only. It refuses symlinks, nonempty targets, and
invalid configurations, stages files privately and does not alter the V1
builder/installer or project output. V1 managed-tool prompts are deliberately
not transplanted. `node test/acceptance/v2-agent-preview.mjs` selected a
generated profile in a real isolated OpenCode 2.0.15 run and verified its
model-visible prompt and zero available tools (13 generated profiles). Global
same-name merging, production ownership, delegation, and background tasks are
not addressed; this is not complete V2 support.

### Native execution reuse experiment (Linux, pinned 2.0.15)

The separate `node test/acceptance/v2-native.mjs` experiment does not load the
O4E managed runtime. Its initial ten isolated real-host cases passed, followed by the ancestry contrasts above. Generated
Markdown agents expose their identity, system marker, model and ordered rules.
Wrapping native `shell.execute` with public `ToolEditor.update` retains native
resource allow/deny; permission Session/message/call IDs match the wrapper.
Noninteractive ask is auto-rejected by the host (exit 1), explicit `--auto`
allows it, and `session.interrupt` after startup removes the shell PID and
prevents a delayed write. A native child has a physical parent but uses its
own allow to run a command denied to that parent. The last case proves
**non-equivalence to O4E authority narrowing**, not managed delegation support.

Missing tool-scoped ask therefore does not rule out all native-tool reuse;
native Shell wrapping deserves further validation but cannot authorize
arbitrary O4E effects. Human approval UI, cancellation during approval, complex
process trees, generated ownership/conflicts, delegation depth, background and
restart recovery, and completed original Part updates remain unverified.
An initial fixture omitted explicit CLI model selection, fell back to a free
built-in model and timed out; it used no user credentials but was not local-only
and is not a pass. The final harness pins the local fake model and rejects
non-fixture providers in `model.request`. Only test assets and evidence notes
changed; no production execution gate or contract was relaxed.

An independent CLI-only `@hymsk/o4e/v2/tui` export now registers the opt-in,
read-only `o4e-v2-status` slash/palette command with V2's public Keymap API.
It reads only the CLI location's local O4E configuration on invocation and
reports that managed execution is unavailable; errors are not exposed as
configuration content. This is not a managed Task UI, server status check,
or a replacement for V1 `./tui`. Loading it requires an isolated V2
`cli.json` plugin entry, with the public `@opencode/plugin/tui/plugin`
subpath and a component-owned Keymap layer. An isolated Linux OpenCode
`2.0.15` full-TUI run loaded the installed npm package, displayed 13 local
agents, 0 local MCP servers and execution unavailable, then exited 0 without
a plugin failure banner. An earlier setup-scoped Keymap attempt and an
accidentally auto-discovered server plugin failed; both were corrected before
the final run. Managed execution and other platforms remain unverified.

### Latest deliverable slice (standalone V2 preview; no managed execution)

The [official plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1/) requires porting V1 plugin implementations, while supported V1 configuration need not be rewritten first. The npm package now exports a separate `@hymsk/o4e/v2` entry and pins `@opencode/plugin@2.0.15` as a runtime dependency. V1 `./server` / `./tui` exports and V1 installer/build registration are unchanged. The read-only `o4e_v2_status` reports the configured MCP server count with `mcpProjection: unavailable`: it does not register MCP servers, alter Agents or their permissions, or disable native V2 host tools.

Run the opt-in, credential-free `node test/acceptance/v2-preview.mjs` in an isolated HOME/XDG environment: it packs and installs the actual npm artifact, loads its `@hymsk/o4e/v2` export in OpenCode `2.0.15`, and uses a local fake model and a synthetic never-run MCP to verify a real model-visible status Tool result. The latest Linux run exited 0 with `status: passed` and three local provider requests (including an auxiliary request). It does not verify a real external model, TUI, CLI installation, or managed execution; a local provider validates transport and call wiring, not model quality.

Minimal upstream API request draft: [English](OPENCODE-V2-UPSTREAM-API.md) / [中文](OPENCODE-V2-UPSTREAM-API.cn.md). Discussion only; not submitted upstream.

## Isolated real-host check (OpenCode 2.0.15, Linux)

In independent Zellij tabs, ran `opencode2 debug paths` and `opencode2 mini --standalone` under `env -i` with isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR` outside the repository. The observed data/config/cache/state paths all pointed to the fixture, the mini TUI showed `v2.0.15` and started normally, and `/quit` exited with status 0. No real user background service, model, or configuration was used.

A local, non-executing probe plugin was configured only in that disposable project. An initial single-file entry produced the host warning `configured plugin path must be a directory` and does **not** count as a successful load. With a directory containing `package.json` and `index.mjs`, the host logged `loading plugin`, `setup` wrote these **boolean-only** results inside the fixture, and normal exit wrote a `cleanup` marker:

```json
{"version":"2.0.15","toolScopedAsk":false,"sessionCreate":true,"sessionMessages":false,"sessionActive":false,"permissionCreate":false,"toolTransform":true}
```

This verifies `setup` execution and the presence of those properties on the **top-level plugin context** only. No custom tool was executed, so `toolScopedAsk` is **not** a runtime test of the per-call Tool Context. `opencode2 api --standalone plugin.list` returned an empty array in the fixture despite the observed `setup` and `cleanup`; its scope/timing remains unresolved and the empty list cannot establish load or active status. A `debug config` attempt without `--standalone` hit a default service-port collision and was interrupted; it is not acceptance evidence. This did not load the V1 O4E plugin or test V2 O4E tools, real models, managed background tasks, permission interactions, or recovery.

### Subsequent real-model and custom-tool check

After explicit permission to inspect the existing configuration, located the V1 `newapi-openai/gpt-6-luna` model with an HTTPS OpenAI-compatible endpoint and a `0600` `{file:...}` credential reference. Only the required provider/model fields were extracted to create an isolated V2 `providers` configuration (`0600`, without user MCPs/plugins or plaintext credentials). A separate wrapper reads the credential file in memory and passes it to the isolated V2 subprocess via an environment variable. No key was written to the new configuration, repository, or CLI arguments. The V2 process/provider can access the key to make real requests; this is not a claim that the credential is invisible to the host.

In an independent Zellij tab, `opencode2 run --standalone --model newapi-openai/gpt-6-luna --agent build` returned `LUNA_OK` and exited `0`. A second run with the same real model invoked the disposable plugin's read-only `o4e_v2_probe` tool, returned `PROBE_OK`, and exited `0`. The tool recorded only the **types** of context properties: `sessionID`, `agent`, `messageID`, and call `id` were strings, `signal` was an object, `progress` was a function, and **`ask` and `permission.create` were `undefined`**. The probe ran no Shell command, delegation, or file modification. Its success proves that registration and invocation of a V2 custom tool work, not that managed authorization works.

Conclusion: isolated V2 + `gpt-6-luna` model and read-only tool invocation worked on Linux, but the tool-call context lacks the host resource-level approval required by O4E. The `DEL-003` / `CMD-004` gates remain unmet; managed execution cannot safely be wired up, and original-Part updates, child creation, paged provenance, and recovery remain unverified. **O4E cannot yet be guaranteed operational on V2.** The managed O4E Runtime was not run on V2, and no legacy Task ledger was migrated.

### Separate V2 preview adapter (partial verification)

Added `src/plugin-v2.mjs` and `src/adapters/opencode-v2/compat.mjs`, separate from the V1 `src/plugin.ts`. The preview is loaded in a manually configured, isolated V2 project; the installer and CLI/TUI are not wired up. It reads the selected `.o4e/` definition. V2 AgentEditor can only update existing Agents, not create O4E Agents, so this adapter neither creates O4E Agents nor impersonates native `build`, `plan`, `general`, or `explore` (including native `keep`). A pure helper computes a tightening-only permission candidate, but **does not apply it to any host Agent**: a matching name does not establish ownership, and incorrect takeover would break native `keep` or unrelated user Agents. Global config and complete Agent/Prompt/Skill/model/MCP projection are not wired up. If the selected definition declares an MCP server, the preview only counts and reports it as unprojected; it does not register the server. **The preview does not impose global native-execution restrictions** and must not be used as isolation for host-native tools.

The read-only `o4e_v2_status` tool reports `managedExecution: unavailable` and the missing gates. Managed `bash`, `task`, `o4e_task` and Workflow are not registered. In the existing isolated fixture with OpenCode `2.0.15` and `gpt-6-luna`, an initial run failed because the fixture did not contain `@opencode/plugin` and did **not** load the plugin. After using an identity entrypoint equivalent to the pinned package's `Plugin.define` implementation in that isolated fixture, and declaring the status tool `codemode:false`, the model actually invoked `o4e_v2_status`, returned `managedExecution: unavailable`, and exited `0`. This only checks the adapter module and read-only tool: **the actual npm dependency and `src/plugin-v2.mjs` entrypoint were not installed or tested**, and this does not prove native permission gates.

Subsequently, a fixed `@opencode/plugin@2.0.15` dependency was installed in a repository-external `/tmp` fixture with `npm install --no-save --no-package-lock --ignore-scripts`. An unmodified copy of `src/plugin-v2.mjs` resolved that real dependency (its relative adapter import pointed to the repository module) and exported the `Plugin.define` plugin object. The isolated OpenCode `2.0.15` project then loaded this copy through a forwarding entrypoint; a real model called `o4e_v2_status`, reported `managedExecution: unavailable`, and the command exited `0`. This proves **real dependency resolution and read-only tool invocation for the isolated copy**, not published-package installation, installer/CLI/TUI wiring, or full lifecycle acceptance. Host Ports, Feature Gates and registration cleanup have been added; unverified approval, ancestry, paged source, original-Part updates and other execution dependencies remain unavailable. The complete `npm test` regression passed `1564/1564`.

Rechecking the pinned release's `promise/tool.d.ts`, `promise/permission.d.ts` and `promise/session.d.ts` found no proven public plugin equivalent for G1–G4. The preview tool transform now refuses to overwrite a host tool of the same name during replay; definitions with MCP entries still fail before registration, and a rejected host registration is propagated. A subsequent isolated real-model invocation of the read-only tool returned `configured: true`, `managedExecution: unavailable`; this does **not** enable managed execution. The latest full `npm test` regression passed `1567/1567`, and `git diff --check` passed. Completing the V2 Runtime requires the upstream host capabilities in the API request, followed by Runtime, CLI/TUI and published-package lifecycle acceptance. Port facades and configuration translation are not substitutes for these gates.

Review of nearby APIs: ToolContext's `sessionID/agent/messageID/id` can bind the provenance of an active invocation, and `progress` can update it while the call is running. A new `tool-call.mjs` adapter bounds that handle to the invocation and rejects missing provenance. `permission.hook("evaluate")` only reviews an existing host decision, while protocol-level `permission.create` is not injected into ordinary plugins; `session.context` lacks cursor/limit and is not a bounded message source; the full client's `message.list` and `session.active` are absent from the ordinary plugin Context; `session.create` accepts no `parentID`; and neither ToolContext.progress, tool.execute.after nor session.synthetic can persistently update the same completed original Part. None of these nearby interfaces **satisfies G1–G4**. Managed execution remains disabled. The isolated real host again invoked the read-only status tool successfully.

After this compatibility adapter, the latest full `npm test` passed `1570/1570`, and `git diff --check` passed; the earlier `1564/1564` and `1567/1567` figures above are earlier regression snapshots.

### Deeper plugin API and alternative-path investigation (pinned 2.0.15)

The actual `@opencode/plugin/dist/promise/adapter.js` Context construction, the Promise/Effect declarations, and the public `@opencode/client` and `@opencode/protocol` types were checked. An isolated host probe recorded only **property names**, not values, on an ordinary server plugin Context: `permission` exposes `get/hook/list/reply`; `session` exposes a limited selection including `context/create/get/hook/interrupt/prompt/update/wait`; `rpc` registers and calls plugin-defined RPC methods, not arbitrary native host endpoints. The online docs mention `ctx.permission.rules`, but it is absent in the pinned types, Promise adapter, and observed Context. The full `@opencode/client` exposes `permission.create`, `message.list`, and `session.active`, but that client is not injected into ordinary server plugins. It also does not offer parentID session creation or persistent updates to completed original Tool Parts. Bare HTTP, private host objects, and inventing a separate credentialed connection do not resolve this boundary.

The `Tool.Options.permission?: string` field was tested in an isolated real host: a harmless tool with `permission: "shell"` executed under default permissions without an observed `permission.hook("evaluate")` event. With an explicit `shell: deny` rule, the model instead reported the tool unavailable and it did not execute. This only suggests host-level **tool availability filtering**; it does not prove per-execution approval for a dynamic Shell-command resource. The status capability matrix now records similar but narrower interfaces separately and tests that none promotes G1–G4. The probes touched only the external disposable fixture; no O4E managed execution tools were registered.

As a separate check, `@opencode/plugin@2.0.16` and the matching `@opencode/client`, `@opencode/protocol` and `@opencode/schema` were installed outside the repository. Its Promise `permission.d.ts`, `session.d.ts`, `tool.d.ts`, and `rpc.d.ts` have no differences from `2.0.15`. This is not real-host acceptance for 2.0.16 and does not change the pinned target.

This round's complete `npm test` regression passed `1571/1571`, and `git diff --check` passed; earlier pass counts above are historical snapshots.

The target host is **OpenCode 2.0.15**, not the `@opencode-ai/sdk/v2` subpath shipped with V1.
O4E **does not yet support full V2 operation**. This stage implements a separate preview entrypoint, tightening-only projection and permission transport conversion; managed execution is not connected, and the V1 entrypoint and SDK remain unchanged.
The root `SPEC.md` remains authoritative. This plan does not relax permission or lifecycle requirements.

## Verified differences

Based on the official migration guide and published `@opencode/plugin`, `@opencode/schema`, and `@opencode/protocol` **2.0.15** packages:

| Area | V2 change and O4E impact |
| --- | --- |
| Entrypoint | `Plugin.define({ id, setup(ctx) })`; V1 hook-returning functions do not run directly |
| Configuration | Domain transforms replace the global config hook; callbacks must be synchronous and replayable, without file reads or one-time side effects |
| Permissions | Ordered `{action,resource,effect}[]`; `bash → shell`, `task → subagent`; preserve order and never treat allow as approval |
| Tools | JSON Schema and structured content; Tool Context has no ask, and the permission domain exposes only list/get/reply/evaluate hooks |
| Sessions | The plugin domain omits list, active and paginated message APIs; HTTP endpoints do not automatically grant plugins those client operations |
| Child sessions | Public session.create payload has no parentID; independent roots cannot impersonate native child sessions |
| Messages | prompt runs before durable admission; hook completion is not persistence evidence. Model context is not the original Message/Part representation |
| Presentation | progress cannot be assumed to update completed original Parts after tool return; the TUI entrypoint also needs porting |
| CLI | Shared background service and config reload require new Location, shared-instance, cancellation and disposal validation |

These gaps block full Runtime integration. Bare fetch, private host APIs, whole-history reads, event-only caches, or default approval are not acceptable workarounds.

## Implementation stages and acceptance

1. **Baseline and coexistence**: preserve V1, pin V2 package evidence, and use credential-free independent HOME/XDG fixtures. The read-only preview passed an installed-package call with a local fake model, not managed execution acceptance.
2. **Transport conversion**: isolated `src/adapters/opencode-v2/`; preserve permission order, resources and effects, rejecting action patterns without proven equivalence. Unit validation only, no authorization role.
3. **V2-native semantics and trusted interfaces**: define separate V2 contracts for the workbench, actual execution, provenance and recovery first. The draft gaps (ask, parentID, paged source, original Part update) concern V1-equivalent behavior, not a preset list of all V2-native prerequisite interfaces. Any managed side effect still needs host-verifiable authorization and stop boundaries; do not change the upstream host or publish issues without authorization.
4. **Runtime integration**: after V2-native contracts and interfaces exist, assess which V1 domain rules are reusable and which SessionStore, execution ports and ledgers require independent implementations. Verify deny/ask, identity, cancellation, stop evidence and recovery. Gate V1 equivalence separately; the preview is not a complete port.
5. **Projection and UI**: split Agent/MCP/Skill/model transforms, Prompt hooks and CLI plugins. Use a separate V2 entrypoint rather than requiring the V1 1.18.29 dual-object entrypoint.
6. **Release gate**: full V1 regression, installed-package V2 loading, real models/tools/TUI, normal exit and restart acceptance. Do not claim full support beforehand. Validate Windows/macOS separately.

## Smooth configuration and secrets

V2 supports in-memory normalization of existing `opencode.json(c)` and file definitions; **provider/MCP configuration need not be rewritten first**.
V1/V2 share configuration locations by default, and first CLI startup may migrate settings. Do not validate by launching the real user environment.
Do not read auth.json, credential databases, .env, the full environment, or host configuration that may embed secrets. Reading then redacting is not equivalent to not reading secrets.
This stage neither copied nor converted local provider/MCP/user configuration. Use synthetic secret-free fixtures; personalized migration needs user-reviewed allowlisted excerpts.

The official installer, `https://opencode.ai/v2/install`, replaces the default opencode and creates an opencode2 shim; it does not isolate configuration.
For coexistence, preserve the V1 binary and name V2 separately. Both names can still access the same configuration/data; renaming is not state isolation.
Do not use uninstall for rollback: it may remove shared configuration, data and cache. Upgraders may also overwrite a manual coexistence layout.

## Sources

- [V1 migration](https://opencode.ai/v2/docs/migrate-v1/)
- [Plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [V2 CLI](https://opencode.ai/v2/docs/cli/)
- Pinned packages: [@opencode/plugin 2.0.15](https://registry.npmjs.org/@opencode/plugin/2.0.15), [@opencode/schema 2.0.15](https://registry.npmjs.org/@opencode/schema/2.0.15), [@opencode/protocol 2.0.15](https://registry.npmjs.org/@opencode/protocol/2.0.15).

Web pages change; recheck API conclusions against pinned packages. Git tag dates are not GA release dates.
