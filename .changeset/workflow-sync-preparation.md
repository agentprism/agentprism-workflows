---
"@automatalabs/mcp-server": major
"@automatalabs/workflow-engine": major
"@automatalabs/workflows": major
---

Prepare workflow runs inside the MCP request and drop the custom retry identity.

- `workflow` `run` now reads the source, validates it (static parse, mocked dry run, routed config probes), and admits execution before it acknowledges. Malformed source, validation failures, missing routing, and a full project are tool execution errors (`isError: true`) that persist no run. A script that declares custom backends is validated and then parked in durable backend-approval setup exactly as before.
- Request cancellation is honored the way each transport defines it (closing the Streamable HTTP response stream, or `notifications/cancelled` on stdio): preparation stops, nothing is persisted, and capacity is released. Preparation stages are reported through `notifications/progress` when the request carries `_meta.progressToken`. The stdio shim aborts the upstream request for a modern-era cancellation instead of forwarding the notification.
- `requestId` and `duplicate` are removed from `run` and `resume`. There is no idempotent retry receipt any more; sending the same input again starts an independent run.
- Engine: `prepareRun` mints a fresh run identity and no longer takes an operation; `findAcceptedRun`, `ExecOptions.operation`, `WorkflowOperationIdentity`, `PersistedWorkflowContinuationOperation`, `MAX_WORKFLOW_CONTINUATION_OPERATIONS`, `RunPersistence.hasRunArtifact`, and the persisted `acceptanceOperation`/`continuationOperations` fields are gone (`MAX_WORKFLOW_SETUP_RESPONSES` names the remaining receipt limit). `startInBackground` begins execution on the next macrotask so callers can register interest under the returned run ID first.
- `validateWorkflowScript` accepts `signal` and rejects with an `AbortError` (`isValidationAbortError`) when it aborts.
