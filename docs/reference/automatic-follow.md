# Automatic Task Follow

[English](automatic-follow.md) | [中文](automatic-follow.cn.md)

After a main turn goes naturally idle, the Runtime may create a synthetic text turn for unfinished Tasks to continue coordination, without forging model tool results. Real user interruptions take priority. Background task status should still be confirmed via `watch/status`, and bodies read via `output`; automatic continuation itself is not evidence of completion.

## Explicit Stop and Resume

Only managed `primary`/`all` root callers may manage their own follow choice, and the operation still goes through host permission checks. Read first, then modify with the returned revision:

```json
{"action":"follow"}
```

```json
{"action":"follow","enabled":false,"expectedRevision":1}
```

The revision above is only an example. To resume, reread and change `enabled` to `true`. No `taskID` or `taskIDs` is provided; the choice applies to the current owner and does not change Task execution. Ordinary user messages do not lift an explicit stop; the choice persists in Session metadata. Natural language is understood by the main Agent, which invokes the control operation; the Runtime does not guess from user text.

If the model transport requires values for optional fields, use `enabled:null` and
`expectedRevision:null` for a read; null means omitted, not false. The adapter discards unrelated
action fields and empty Task selector placeholders, but rejects actual Task selectors and forbidden
fields (`reason`, `cursors`, `reread`). Explicit changes still require a boolean and the latest
revision; a read must not supply a non-null revision. Do not invent a switch value or revision.

A host root-turn abort is a temporary suppression, lifted by the next real user turn; it differs from an explicit stop. Detached Bash is not cancelled by this temporary suppression, but `dispose`, owner deletion, child task lifecycle termination, and explicit cancel still preserve stop boundaries.

## Failure and Recovery Boundaries

- `automatic-follow-failed` means automatic continuation was disabled after a check or submission failed. Read `follow` for diagnostics, troubleshoot, and explicitly resume within your authorization; the model is not automatically retried and permission/question requests are not answered. If the metadata store itself is unavailable, persistence may fail; do not claim the control was saved.
- The check interface for terminal-state notifications stops following after three consecutive failures; normal waits such as busy, user turns, or watch do not count as failures, and a fully successful check resets the check-failure count. This count is independent of the terminal submission budget below.
- If a failure-driven disable fails to persist, this instance still stops automatic checks; once host reads recover, `follow` returns `enabled:false`, `diagnostic:"automatic-follow-failed"`, and `persistenceConfirmed:false`. This does not mean the persisted state has been changed to disabled, nor does it guarantee the local suppression survives a restart; ordinary messages do not lift this local failure state — follow must be set explicitly. If the Session itself is still unreadable, the query errors instead of forging a usable revision.
- A lost response or persistence confirmation for a terminal receipt may reuse the same message identity for at most three bounded submissions; once exhausted it disables and exposes diagnostics. A late failure from an old attempt cannot overwrite a later user turn or an explicit control revision.
- Submission mutual exclusion and actionable deduplication for same-directory instances are same-process guarantees only, not cross-process leases or exactly-once. Explicit on/off state can be read by new instances; this cannot be used to claim crash-safe submission deduplication, delivery of all command terminal states, or that the full lifecycle has passed real host acceptance.
- This feature's automation fixtures do not equal real host or Windows/macOS acceptance; target-environment evidence must be recorded separately before release.
