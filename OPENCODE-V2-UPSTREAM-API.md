# OpenCode V2: minimal upstream API request for O4E (draft)

[中文](OPENCODE-V2-UPSTREAM-API.cn.md) | [English](OPENCODE-V2-UPSTREAM-API.md)

**Status: discussion draft only; not submitted upstream and not a claim of V2 support.** Target: OpenCode `2.0.15`. The repository's `SPEC.md` remains O4E's authoritative contract. The names below are illustrative, not prescribed API names.

## Verified public API boundary

Checked pinned `@opencode/plugin`, `@opencode/schema`, and `@opencode/protocol` `2.0.15` type declarations:

| Required capability | Current public surface | Gap and impact |
| --- | --- | --- |
| Request and await host authorization for tool resources | `ToolContext` exposes `sessionID`, `agent`, `messageID`, `id`, `signal`, `progress`; the plugin permission domain has `list/get/reply` and an `evaluate` hook. The **protocol** defines `session.permission.create` | No plugin tool-scoped request method binding resources to this call and awaiting the user's decision. Rule `allow` and an evaluation hook do not constitute approval. Managed `bash`, `task`, `o4e_task`, and Workflow cannot be wired up |
| Create execution Sessions with a controlled parent | Plugin `session.create`; its protocol request body lacks `parentID`, although Session records contain it | Cannot create a real child Session; a separate root cannot impersonate one or route prompts to the native root |
| Bounded message and status provenance | **Protocol** defines `session.messages` (`cursor`, `limit`, `order`) and `session.active`; the plugin session domain omits both and exposes selected methods such as `get` | Protocol endpoints alone do not establish plugin access through an authenticated supported client. No dependable paged Message/Part lineage, user-interruption, idle/busy/retry or recovery evidence |
| Preserve the original tool card after return | `ToolContext.progress` can submit progress; `ToolDomain` exposes `execute.before/after` hooks | No proven way to update **the same original Part** after tool return. New messages or sidebar entries cannot replace the native Shell card's capture, truncation, and final status |

“Missing” refers only to public plugin signatures in this pinned release, not private implementations or later releases. The presence of a protocol endpoint is not proof of an authenticated, supported plugin transport. No bare `fetch`, private imports, direct DB writes, or access to local user configuration/credentials should be used as a workaround.

## Proposed minimal extensions and acceptance

1. **Tool-scoped authorization request:** provide a host-managed equivalent of `ask({ action, resources, ... })` on the tool invocation context, bound to trusted Session, Agent, message, and call IDs. Respect host deny/ask/allow: deny rejects, ask awaits the user, and approval is explicit and verifiable. Cover atomic Shell, external paths, target Agents, and management actions. Cancellation, interaction failure, or timeout must fail closed; the plugin cannot manufacture approval. Acceptance: no side effects before approval, deny never executes, frozen authority is revalidated before dispatch, and child prompts appear at the native root.
2. **Controlled child Session creation:** expose parent selection validated by the host against an existing parent, caller ownership, and valid ancestry; return a durable readable `parentID`. Do not accept arbitrary model-provided parent IDs. Acceptance: nested tasks, prompt ownership, ancestor cancellation/deletion, sequential restart and missing parents are mechanically verifiable, without granting the child new permissions.
3. **Plugin-accessible bounded provenance:** provide authenticated paged messages, raw single Message/Part reads, and Session activity state in the plugin context (or explicitly support equivalent public endpoints via an injected authenticated client). Pagination needs trustworthy cursors/bounds; status distinguishes busy, retry, idle/missing and permits rechecking after message reads. Acceptance: multi-page reads, compaction, concurrent changes, read failures, restart, and result references; failures cannot be interpreted as idle or success.
4. **Durable original tool-Part updates:** enable updates to the same tool Part by host-validated `(sessionID,messageID,callID)` until command settlement, with bounded content, durable acknowledgement, and rejection of stale provenance. Acceptance: running output and final state remain on the original card after a background return; empty output, truncation, lost acknowledgements, and TUI restart are represented accurately without replaying the command.

Each is an independent gate. If the upstream host already provides one, please identify a **pinned-version public signature and a real plugin call example**, then verify it in a credential-free isolated fixture. Similar type names alone do not pass acceptance. Plugin lifecycle/replayable synchronous transforms, config/model projection, CLI/TUI migration still require separate implementation and validation.

## Sources and limits

- `@opencode/plugin@2.0.15`: `dist/promise/tool.d.ts`, `permission.d.ts`, `session.d.ts`, `plugin.d.ts`
- `@opencode/schema@2.0.15`: `dist/tool.d.ts`, `session.d.ts`
- `@opencode/protocol@2.0.15`: `dist/groups/session.d.ts`, `message.d.ts`, `permission.d.ts`
- O4E requirements: `SPEC.md` `DEL-003`, `BGT-005`, `BGT-011`, `CMD-004`, `CMD-008`, `RUN-003`, and Inspection pagination requirements.

Do not modify upstream OpenCode, file an issue/PR, publish, or migrate user data without separate authorization.
