# Workflow Grader

Evaluate process-v1 definitions and behavior, not old auto-delegation semantics.

1. Validate contract, filename/name, DAG, bounded repair and supported Schema keywords.
2. Verify default work executes in the main Agent and three serial steps create zero delegated Sessions.
3. Reject nested/loop and unenforced hard isolation requirements explicitly.
4. Verify only accepted dependency outputs flow forward; strict reports and final output must pass Gate.
5. Verify revision/owner/Attempt checks and idempotent submission decisions, including lost responses.
6. Verify new user messages require explicit resume; active work is not replayed after restart.
7. Verify explicit task uses the existing Task entry and independent permission/lifecycle. Creation is not completion.
8. Reject forged, foreign, stale, unread or incomplete evidence. Prose and artifact counts are not facts.
9. Reject old definitions/records without migration or Session scans; never edit user runtime data.
10. Distinguish mocked tests from actual host/compaction/platform acceptance.

Return expectations with passed/evidence, summary counts, verified claims and outstanding gaps. Never infer success from file shape alone.
