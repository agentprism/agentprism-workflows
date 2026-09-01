# Canonical workflow status action

Status: **implemented MCP contract**.

## Scope

The model-facing `workflow` tool has one canonical run-observation action:

```ts
interface WorkflowStatusToolInput extends WorkflowRunInspectionOptions {
  action: "status";
  runId: string;
  waitMs?: number; // default 0; integer 0..25_000
}
```

Omitted `waitMs` and `waitMs: 0` perform an immediate bounded observation. A positive value reuses
the existing durable event-tail/local-settlement wait and returns when the run becomes terminal, a
permission requires action, the request bound expires, or the request itself is cancelled. The
bound belongs only to the MCP request: reaching it never stops, pauses, resumes, or otherwise
cancels workflow work.

`lastN`, `labelGlob`, and `logLines` keep their existing validation, filtering, redaction, and
projection limits. Status retains owner-death reconciliation, cross-generation permission routing
and elicitation, request progress-token behavior, script/result resource links, complete script
lineage, cumulative usage telemetry, terminal outcome reconstruction, and the distinction between
a failed workflow lifecycle and a failed status read.

Every successful status response carries:

```ts
interface WorkflowStatusWaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause:
    | "terminal"
    | "timeout"
    | "immediate"
    | "action-required"
    | "permission-resolved";
}

interface WorkflowStatusToolResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowStatusWaitMetadata;
  tokenUsage?: TokenUsage;
  pendingPermissions?: WorkflowPendingPermission[];
  interaction?: WorkflowPermissionInteraction;
  permissionResponse?: WorkflowPermissionResponseAcknowledgement;
  outcome?: Omit<WorkflowExecutionToolResult<T>, "scriptSource">;
  scriptUri: string;
  resultUri?: string;
  lineage: WorkflowScriptLineageEntry[];
}
```

`outcome` is present exactly for a terminal run. A permission may return before `waitMs` with
`returnedBecause: "action-required"`, or with `"permission-resolved"` when a compatible elicitation
round resolves it. Targeted `stop` continues to return the same compact observation projection but
is a stop result, not a second observation action.

## Compatibility migration

The published tool schema and documentation advertise only `status`. The runtime parser accepts
the two former action names long enough for installed clients to migrate, and normalizes them before
dispatch:

- legacy `inspect` becomes `status` with `waitMs: 0`;
- legacy `await` preserves an explicit `waitMs`, or uses its historical omitted default of 20,000
  ms.

Legacy-only action types remain deprecated TypeScript aliases. They are not members of the
canonical `WorkflowToolInput` union. No second handler or output contract is retained, and the
server does not publish two ways to observe a run. This train intentionally does not introduce the
final per-action discriminated JSON Schema; the existing combined schema remains until all workflow
action and output changes are complete.

## Preserved boundaries

The engine method remains `WorkflowManager.inspectRun()` because it is the backend-agnostic safe
snapshot primitive. Event-tail startup, cancellation, and cleanup bounds remain internal protocol
safety mechanisms. Compatibility normalization does not change persistence, engine journaling,
daemon ownership, or ACP runner boundaries.

## Verification matrix

Contract tests cover immediate status with omitted/zero wait, a positive wait timeout and terminal
settlement, permission-required early return, targeted agent cancellation, unknown run behavior,
published-schema exclusion of the legacy names, and runtime normalization of both legacy names.
