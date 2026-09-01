# Detached MCP Workflow Runs with Bounded Await

**Date:** 2026-07-14

**Feedback:** issue #131, section 2

> **Current MCP migration:** this historical design introduced separate `inspect` and `await`
> actions. The implemented model-facing contract now consolidates both under `action:"status"`
> with optional `waitMs`; see [`workflow-status-action.md`](../workflow-status-action.md).

## 1. Problem

The MCP `workflow` tool currently keeps one `tools/call` open until the workflow reaches a terminal
state. That is appropriate for short runs, but a multi-hour workflow pins the calling agent on one
request and lets an MCP client's request timeout become a workflow failure mode even while the
engine and its agents are healthy.

The engine already assigns a stable run ID, persists the run before doing agent work, journals each
completed deterministic call, and can execute without an inline waiter. The missing piece is an MCP
contract that opts one invocation into that existing background lifecycle, acknowledges the run
immediately, and lets a timeout-constrained caller make bounded status/await calls until it can
collect the terminal result.

This design adds `background: true` to the execution branch of the existing `workflow` tool
(then the server's only model-facing tool — see the pack [README](README.md)'s historical-scope note)
and adds an `action: "await"` branch. The immediate `action: "inspect"` branch and the exact shared
`WorkflowRunStatus` payload are the ones specified in
`docs/specs/issue-131-agent-feedback/01-run-observability.md`; await extends that payload without
changing any of its fields. `resumeFromRunId` remains exclusively the existing journal-prefix replay
input to a new execution. Awaiting a run never resumes it, re-runs its script, or acquires its run
lease.

## 2. Current state

### Engine lifecycle and persistence

- `packages/workflow-engine/src/workflow-manager.ts` exports `WorkflowManager`, `ManagedRun`, and
  `ExecOptions`. `WorkflowManager.startInBackground(script, args, exec)` already returns
  `{ runId, promise }`. It parses the script, creates a `ManagedRun` with `status: "running"` and
  `background: true`, acquires a run lease, saves the initial persisted state, starts
  `executeRun()`, and returns without awaiting that execution. The method attaches an internal
  rejection handler while returning the original settlement promise, so an ignored paused or failed
  background execution does not become an unhandled rejection.
- The same class exposes `getRun(runId)`, `getSnapshot(runId)`, `listRuns()`,
  `getPersistence()`, `pause()`, `stop()`, `resume()`, and `resumeInBackground()`. The returned
  `startInBackground()` promise and these read APIs are sufficient for an MCP adapter to track a
  live detached execution; no second scheduler or new run primitive is needed. One existing
  background-start persistence defect must be corrected before the MCP adapter can use this method
  for `resumeFromRunId`, as described below.
- `WorkflowManager.runSync()` uses the same `createManaged()`/`executeRun()` lifecycle but waits for
  settlement and composes a terminal `WorkflowRunResult`. The MCP adapter uses this method today.
  On the background path, `executeRun()` resolves its promise only for completion and rejects it for
  pauses, failures, and aborts after updating the managed state and persistence. A waiter therefore
  uses the promise only as a wake-up signal and reads the settled status/result from the manager and
  run store.
- `WorkflowManager.resumeInBackground(runId, exec)` is not the MCP `resumeFromRunId` behavior. The
  manager method reloads the persisted script and args, preserves the same run ID, and resumes that
  managed resource. In contrast, the current MCP handler in `packages/mcp-server/src/server.ts`
  loads only the named journal into `ExecOptions.resumeJournal`, then calls `runSync()` with the
  newly supplied script and args; that produces a new run ID and preserves the useful ability to
  change args while replaying the unchanged call prefix. This design keeps that MCP behavior.
- `WorkflowManager.runSync()` explicitly copies a supplied `ExecOptions.resumeJournal` into the new
  managed run before its initial persistence. Its comment explains why: replay hits do not invoke
  `onAgentJournal`, and a synthetic checkpoint reply must survive another cold resume. In contrast,
  `WorkflowManager.startInBackground()` currently initializes `managed.journal` to `[]` and its
  initial `RunPersistence.save()` omits `journal`, even when `exec.resumeJournal` is present.
  `packages/workflow-engine/src/workflow.ts` returns a matching cached agent result directly and
  likewise returns a cached checkpoint result without invoking `onAgentJournal`; only a new live
  miss reaches `recordJournalEntry()`. Consequently, an unchanged `startInBackground()` would
  persist only the new suffix of an MCP background resume. Resuming that new run after a pause would
  see a missing call zero, set `firstMiss` to zero, and re-execute the expensive original prefix.
  The lifecycle API is therefore usable only after `startInBackground()` receives the same
  hydrated-prefix seeding guarantee as `runSync()`.
- `WorkflowManager.recordJournalEntry()` replaces the entry for a deterministic call index and
  calls `persistRun()` after each completed live agent/checkpoint. `persistRun()` also writes status,
  phases, current phase, agent snapshots, logs, terminal result, token usage, pause contexts, and
  duration. `packages/workflow-engine/src/run-persistence.ts` defines `PersistedRunState`,
  `RunPersistence`, and `createRunPersistence()`; there is no TTL or automatic deletion. A run stays
  on disk until `RunPersistence.delete()`/`WorkflowManager.deleteRun()` or external filesystem
  removal.
- `WorkflowManager.recoverStaleRuns()` runs at construction for a journaling manager. A persisted
  run still marked `running` but not owned in memory is changed to `paused` only after the manager
  can acquire its lease. The journal is retained so a later `resumeFromRunId` can replay the
  completed prefix.
- `packages/workflow-engine/src/workflow.ts` maintains cumulative `SharedRuntime.tokenUsage` and
  calls `recordTokens()` after every live agent attempt, including a terminal failed attempt.
  However, `WorkflowRunOptions.onTokenUsage` is called only at successful workflow completion today.
  Consequently a live/paused/failed snapshot usually has no run-level token total even though the
  engine already counted it.
- The manager's `concurrency`/`ExecOptions.concurrency` controls agent calls inside one execution.
  `WorkflowManager` intentionally supports multiple simultaneous background runs and has no
  run-count limit; `packages/workflow-engine/test/workflow-manager-abort.test.ts` asserts independent
  concurrent background runs. The MCP composition root therefore needs its own host-resource cap.

### Shared status contract supplied by run observability

- `docs/specs/issue-131-agent-feedback/01-run-observability.md` adds
  `WorkflowRunInspectionOptions`, `WorkflowLogTail`, `WorkflowRunCallStatus`,
  `WorkflowRunStatusTruncation`, and `WorkflowRunStatus` in
  `packages/shared-types/src/workflow-result.ts`, plus
  `WorkflowManager.inspectRun(runId, options)`. `WorkflowRunStatus` is the safe, bounded,
  redacted, live-first/persistence-fallback projection used by immediate MCP inspection.
- Its `WorkflowRunStatus` fields are `runId`, `status`, `workflowName`, `phases`, optional
  `currentPhase`, optional `reason`, optional `errorCode`, `logTail`, `calls`, `filter`, and
  `truncation`. The status projection is capped at 24,576 UTF-8 bytes; its formatted inspection text
  is capped at 8,192 bytes. This design reuses that type and every field/default/redaction rule
  verbatim rather than defining a competing background status shape.
- The same reviewed design renames the existing MCP execution projection to
  `WorkflowExecutionToolResult<T>` and makes `WorkflowToolResult<T>` a union with
  `WorkflowRunStatus`. It also persists terminal `reason`/`errorCode`, which makes a cold await after
  server restart able to explain a failed or recovered run.

### MCP adapter

- `packages/mcp-server/src/workflow-tool-input.ts` exports `workflowToolInputShape`,
  `WorkflowToolInput`, and `clampWorkflowInput()`. Today `script` is unconditionally required and
  there is no action or background flag. The reviewed observability design changes this to
  run/inspect branches while preserving an omitted action as the legacy run form.
- `packages/mcp-server/src/server.ts` constructs one long-lived `WorkflowManager` inside
  `createWorkflowServer()`. Its sole `workflow` handler performs the script-backend approval gate,
  creates an `ExecOptions`, optionally hydrates `resumeFromRunId`, then always awaits
  `manager.runSync()`.
- Foreground execution threads `extra.signal` to the engine, reports in-flight MCP progress from
  `ExecOptions.onProgress`, and installs the MCP elicitation-backed `confirm` callback when the
  client advertises elicitation. Those request-scoped channels cannot be retained after a
  background acknowledgement is returned.
- `packages/mcp-server/src/workflow-tool-output.ts` exports the current execution projection and
  Zod output shape. Completed executions include the script's raw result and aggregate token usage;
  pause results include `authContext` or `checkpointContext`. There is no terminal-result lookup.
- `packages/mcp-server/src/index.ts` `main()` connects the server through
  `StdioServerTransport`. The server is normally a child process of its MCP client. It has no daemon,
  worker handoff, shutdown drain, or guarantee that its process remains alive after the client
  closes stdio.
- `packages/mcp-server/README.md` and `packages/mcp-server/test/workflow-tool.test.ts` deliberately
  promise exactly one model-facing tool. Background lifecycle operations must remain branches of
  `workflow`; adding another registered tool would reverse that public simplification.

## 3. Proposed design

### 3.1 One tool with run, inspect, and await operations

Build on the input union specified by the observability design. Add `background` only to its run
branch and add an await branch:

```ts
export interface WorkflowExecuteToolInput {
  action?: "run"; // omitted preserves every legacy execution request
  script: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  resumeFromRunId?: string;
  checkpointReplies?: Record<number, unknown>;
  /** Default false. True acknowledges after admission and executes in this server process. */
  background?: boolean;
  runId?: never;
  waitMs?: never;
  lastN?: never;
  labelGlob?: never;
  logLines?: never;
}

// Exact branch from 01-run-observability.md; it is not changed here.
export interface WorkflowInspectToolInput extends WorkflowRunInspectionOptions {
  action: "inspect";
  runId: string;
  script?: never;
  background?: never;
  waitMs?: never;
}

export interface WorkflowAwaitToolInput extends WorkflowRunInspectionOptions {
  action: "await";
  runId: string;
  /** Default 20_000; integer range 0..25_000. Zero is a non-blocking status read. */
  waitMs?: number;
  script?: never;
  background?: never;
  resumeFromRunId?: never;
  checkpointReplies?: never;
}

export type WorkflowToolInput =
  | WorkflowExecuteToolInput
  | WorkflowInspectToolInput
  | WorkflowAwaitToolInput;
```

`parseWorkflowToolInput()` remains the cross-field discriminator introduced by the observability
design. It rejects mixed branches as MCP Invalid Params (`-32602`): an await cannot carry a script,
execution knob, `background`, or `resumeFromRunId`, and a run cannot carry `runId`, `waitMs`, or
inspection filters. An omitted action plus a non-empty script remains a run. `background` defaults
to `false`, so old callers retain the synchronous behavior byte for byte.

`waitMs` is a new bounded-wait control, not an engine resource knob. Zod rejects a non-integer or a
value below 0 or above 25,000 rather than clamping it. The 25-second ceiling leaves transport and
model overhead inside common 30-second MCP request limits. `lastN`, `labelGlob`, `logLines`, and the
run-ID grammar use exactly the defaults, bounds, and validation from `WorkflowRunInspectionOptions`
and the inspect branch.

`action: "inspect"` remains the immediate, bounded diagnostic operation returning exactly
`WorkflowRunStatus`. `action: "await"` waits only for a terminal lifecycle state, for at most
`waitMs`, then returns the freshest status plus token totals and a terminal outcome when one exists.
It does not return early merely because a phase, log, or agent call changed; callers that want an
immediate progress sample use inspect or `waitMs: 0`.

### 3.2 Background start acknowledgement

Add and export this MCP result type from `packages/mcp-server/src/workflow-tool-output.ts`:

```ts
export interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
}
```

A valid background request is:

```json
{
  "script": "export const meta = { name: 'review', description: 'review a change' };\nconst report = await agent('Review ' + args.target, { label: 'review' });\nreturn report;",
  "args": { "target": "src/auth.ts" },
  "background": true,
  "concurrency": 4
}
```

After synchronous input parsing, script parsing, the existing script-backend trust gate, run-slot
admission, lease acquisition, and initial persistence, the structured response is exactly:

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "running"
}
```

The accompanying text is:

```text
Workflow "review" started in the background.
runId: mabc1234-k9x2pq
Call workflow with action="await" and this runId to wait for its result, or action="inspect" for an immediate status snapshot.
```

“Immediately” means no workflow agent or script body completion is awaited. Mandatory approval for
script-declared process-spawning backends remains a pre-start security decision and can elicit before
the acknowledgement. The acknowledgement is not returned until the initial `running` record is
durable. For a fresh run that record has an empty journal; for a background resume it already
contains the complete hydrated prefix, including a supplied synthetic checkpoint reply. If parsing,
approval, lease acquisition, or the initial save fails, the call returns the existing pre-run tool
error and no run ID.

Even if the workflow settles in the next microtask, a successfully admitted `background: true` call
returns the two-field `running` acknowledgement. Its actual terminal status is collected through
inspect/await. Foreground execution (`background` omitted or false) continues to await
`runSync()` and keeps its existing terminal `isError`, progress-notification, cancellation, and live
elicitation behavior.

### 3.3 Background lifecycle and replay-safe journal seeding

Correct `WorkflowManager.startInBackground()` before routing MCP resumes through it. Without changing
its public signature, the method must mirror the proven `runSync()` initialization rule:

```ts
if (managed.journaling && exec.resumeJournal) {
  managed.journal = [...exec.resumeJournal.values()].sort((a, b) => a.index - b.index);
}
```

This assignment occurs after the `ManagedRun` is constructed and before it is added to `runs` or
saved. The method's existing fail-fast initial `RunPersistence.save()` must write
`journal: managed.journal`; it must not be replaced with the later best-effort `persistRun()` helper,
because acknowledgement depends on knowing that this initial save succeeded. A map contains at most
one entry per call index, and sorting fixes the persisted order. The seeded entries are the exact
`JournalEntry` objects supplied by the caller: the manager does not recompute hashes, results, or
session metadata.

This is a persistence invariant, not token accounting or a replay-policy change:

- replay matching in `runWorkflow()` still uses the supplied `exec.resumeJournal` and the existing
  longest-unchanged-prefix rule;
- a matching replay still does not call the runner, add usage, or emit `onAgentJournal`;
- `managed.journal` and the initial persisted record nevertheless contain the full hydrated prefix;
- each subsequent live `recordJournalEntry()` replaces its index within that full prefix and
  `persistRun()` writes the complete prefix plus live suffix; and
- a pause, failure, abort, normal completion, or process death after acknowledgement therefore leaves
  the new run independently resumable from its own run ID.

This guarantee also covers a synthetic checkpoint reply that the MCP adapter inserts into
`exec.resumeJournal`: if the resumed execution later pauses again, the answer and the earlier agent
prefix remain in the new run's journal. The rule applies to every journaling caller of
`startInBackground()`, including the public SDK facade, rather than being an MCP-only copy step.

For a background run, the server performs the current `resumeFromRunId` journal hydration and
script-backend gate, builds the existing `ExecOptions`, and calls:

```ts
const started = manager.startInBackground(input.script, input.args, exec);
backgroundRuns.track(started.runId, started.promise);
```

The background `ExecOptions` deliberately differs from the foreground request-scoped options in
three ways:

- `signal`/`externalSignal` is omitted. Cancellation or timeout of the initiating MCP request after
  acceptance must not abort a detached run.
- `onProgress` is omitted because the initiating `tools/call` has returned and its progress token is
  no longer a valid delivery channel. The manager still updates its snapshot; inspect/await is the
  progress channel.
- `confirm` is omitted even for an elicitation-capable client. A background run has no live request
  on which to ask a checkpoint question, so all `checkpoint()` calls use authored headless
  semantics.

Every other execution option is identical to foreground, including `maxAgents`, per-run agent
`concurrency`, retries, timeout, token budget, approved script backends, and checkpoint reply
injection used during resume.

When `background: true` and `resumeFromRunId` are supplied together, the MCP adapter continues its
current replay protocol: it loads that prior run's journal, adds any keyed checkpoint reply, and
passes the map as `ExecOptions.resumeJournal` to `startInBackground()` with the newly supplied script
and args. The corrected manager seeds and durably saves the entire map before acknowledgement, so
the accepted execution receives a new run ID whose journal is self-contained across any later
resume hop. The server does not call
`WorkflowManager.resumeInBackground()`, because doing so would silently change the current MCP
contract to the old script/args and old run ID.

### 3.4 Bounded await payload

Add and export these MCP-only types from `packages/mcp-server/src/workflow-tool-output.ts`:

```ts
export interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

/**
 * WorkflowRunStatus is imported from @automatalabs/shared-types and is not modified.
 * Await adds transport/lifecycle fields while retaining every status field verbatim.
 */
export interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  /** Cumulative usage observed for live calls in this execution; absent before any is known. */
  tokenUsage?: TokenUsage;
  /** Present exactly when status is paused/completed/failed/aborted. */
  outcome?: WorkflowExecutionToolResult<T>;
}

export type WorkflowToolResult<T = unknown> =
  | WorkflowExecutionToolResult<T>
  | WorkflowBackgroundAccepted
  | WorkflowRunStatus
  | WorkflowRunAwaitResult<T>;
```

This is not a divergence from the sibling status contract: `WorkflowRunStatus` retains its exact
shared-types name, fields, filtering, counters, redaction, and byte budgeting. Await adds fields in a
distinct MCP-specific subtype because the immediate inspect response must remain a safe status
projection while a terminal await must also deliver the authored workflow result and pause contexts.

`wait.returnedBecause` is deterministic:

- `terminal` when the first status read is already terminal or a terminal state is observed before
  the positive wait expires;
- `immediate` when `waitMs` is zero and the status is `pending` or `running`;
- `timeout` when a positive wait expires and the freshest status remains `pending` or `running`.

`elapsedMs` is a non-negative integer measured around the wait and may slightly exceed
`requestedMs` because of event-loop scheduling. A request cancellation ends only that await request;
it never calls `stop()`, `pause()`, or the run's abort controller.

If the await request's `extra.signal` aborts before a status is returned, clear its timer/poller and
return `isError: true`, no `structuredContent`, and exactly:

```text
Workflow await for runId "<runId>" was cancelled; the workflow was not cancelled.
```

Example while still running after a 20-second long poll:

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "running",
  "workflowName": "review",
  "phases": ["Explore", "Review"],
  "currentPhase": "Review",
  "logTail": {
    "lines": ["exploration complete", "review wave 2 started"],
    "totalLines": 2,
    "omittedLines": 0,
    "truncatedLines": 0,
    "redactedLines": 0
  },
  "calls": [
    {
      "index": 0,
      "kind": "agent",
      "label": "explore",
      "phase": "Explore",
      "resultPreview": "{\"files\":[\"src/auth.ts\"]}",
      "resultRedacted": false,
      "resultTruncated": false
    }
  ],
  "filter": { "lastN": 20, "logLines": 20 },
  "truncation": {
    "maxStructuredBytes": 24576,
    "byteCapApplied": false,
    "phases": { "total": 2, "returned": 2, "shortened": 0 },
    "logs": { "total": 2, "returned": 2, "shortened": 0, "redacted": 0 },
    "calls": {
      "total": 1,
      "matched": 1,
      "returned": 1,
      "shortenedResults": 0,
      "redactedResults": 0
    }
  },
  "wait": {
    "requestedMs": 20000,
    "elapsedMs": 20003,
    "returnedBecause": "timeout"
  },
  "tokenUsage": {
    "input": 3200,
    "output": 680,
    "total": 3880,
    "cost": 0.041,
    "cacheRead": 1200,
    "cacheWrite": 0
  }
}
```

Example when completion wakes the await early:

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "completed",
  "workflowName": "review",
  "phases": ["Explore", "Review"],
  "currentPhase": "Review",
  "logTail": {
    "lines": ["review complete: 2 findings"],
    "totalLines": 1,
    "omittedLines": 0,
    "truncatedLines": 0,
    "redactedLines": 0
  },
  "calls": [
    {
      "index": 0,
      "kind": "agent",
      "label": "explore",
      "phase": "Explore",
      "resultPreview": "{\"files\":[\"src/auth.ts\"]}",
      "resultRedacted": false,
      "resultTruncated": false
    },
    {
      "index": 1,
      "kind": "agent",
      "label": "review",
      "phase": "Review",
      "resultPreview": "{\"approved\":false,\"findingCount\":2}",
      "resultRedacted": false,
      "resultTruncated": false
    }
  ],
  "filter": { "lastN": 20, "logLines": 20 },
  "truncation": {
    "maxStructuredBytes": 24576,
    "byteCapApplied": false,
    "phases": { "total": 2, "returned": 2, "shortened": 0 },
    "logs": { "total": 1, "returned": 1, "shortened": 0, "redacted": 0 },
    "calls": {
      "total": 2,
      "matched": 2,
      "returned": 2,
      "shortenedResults": 0,
      "redactedResults": 0
    }
  },
  "wait": {
    "requestedMs": 20000,
    "elapsedMs": 7412,
    "returnedBecause": "terminal"
  },
  "tokenUsage": {
    "input": 6100,
    "output": 1300,
    "total": 7400,
    "cost": 0.082,
    "cacheRead": 1200,
    "cacheWrite": 0
  },
  "outcome": {
    "runId": "mabc1234-k9x2pq",
    "status": "completed",
    "result": {
      "approved": false,
      "findings": ["Missing rollback test", "Token refresh race"]
    },
    "tokenUsage": {
      "input": 6100,
      "output": 1300,
      "total": 7400,
      "cost": 0.082,
      "cacheRead": 1200,
      "cacheWrite": 0
    },
    "logs": ["review complete: 2 findings"]
  }
}
```

Implementations must generate the status portion through `WorkflowManager.inspectRun()`, not
manually assemble it.

An await response is a successful read (`isError: false`) even when the observed run is `failed` or
`aborted`; callers branch on the returned lifecycle status. Foreground execution keeps the existing
behavior where a directly returned failed/aborted run sets `isError: true`.

### 3.5 Await implementation and terminal-result retrieval

The MCP server keeps a private per-server map from active background run IDs to the settlement
promises returned by `startInBackground()`. The promise is a wake-up mechanism only. Its fulfillment
or rejection handler removes the run from the active map and releases the background slot, then an
await reads the settled state through the manager.

Await follows this algorithm:

1. Call `manager.inspectRun(runId, inspectionOptions)`. If it returns no status, use the exact
   unknown-run error from the inspect contract.
2. If status is terminal, return immediately with `returnedBecause: "terminal"`.
3. If `waitMs` is zero, return it with `returnedBecause: "immediate"`.
4. Otherwise race the locally tracked settlement promise, the request abort signal, and the
   `waitMs` timer. If no local promise exists but persisted status is still non-terminal, poll
   `inspectRun()` every 250 ms until terminal, cancellation, or the same deadline. This also observes
   a run being updated by another live process that owns its lease.
5. Project status once more. Mark `terminal` if the fresh state is terminal; otherwise mark
   `timeout`. Attach the freshest cumulative usage. For a terminal state, attach `outcome`.

The terminal execution projection is obtained live-first:

- If `manager.getRun(runId)?.result` exists, pass it to the existing
  `toWorkflowToolResult()`/`WorkflowExecutionToolResult` projector.
- Otherwise load `PersistedRunState` through the manager's project-scoped persistence and construct
  the same execution projection from `status`, `result`, `tokenUsage`, `logs`, `authContext`, and
  `checkpointContext`. Normalize a legacy missing `tokenUsage.cost` to `0`. For a non-completed
  status, omit `result`. For `paused`, `failed`, and `aborted` outcomes, use the already projected
  `WorkflowRunStatus.logTail` for the optional execution-result `logTail` added by the observability
  design. A completed `outcome` omits that execution-result field, exactly like a completed
  foreground result; the enclosing `WorkflowRunAwaitResult` still has the required status-level
  `logTail` for every lifecycle status.

This fallback makes a completed background result retrievable after the active promise has been
removed and after an MCP server restart. Retrieval has no time-based expiration: repeated await
calls return the terminal outcome for as long as the project-scoped run JSON remains readable. The
MCP surface adds no delete operation, so expiration occurs only through the existing SDK
`deleteRun()`/persistence `delete()`, manual cleanup, corruption, or loss of the configured
persistence root. A missing, corrupt, or unreadable record uses the sibling inspect error without
revealing its path:

```text
No workflow run found for runId "<runId>" in this server's project-scoped run store.
```

As in the current manager, persistence after the initial save is best effort: `persistRun()` catches
and warns on a later write failure rather than failing healthy agent work. Therefore same-process
await can still return an in-memory completed result after such a failure, but post-restart terminal
retrieval is guaranteed only when the terminal persistence write succeeded. A stale older record is
recovered and resumed by the journal rules rather than being presented as a completed result.

### 3.6 Token-usage reporting

Make the engine's existing cumulative counters observable during a run. In
`packages/workflow-engine/src/workflow.ts`, immediately after each `recordTokens()` update, call
`WorkflowRunOptions.onTokenUsage` with a fresh copy of `shared.tokenUsage`. Keep the successful
end-of-run callback so an agentless run and existing final observers still receive a final snapshot;
callbacks are cumulative snapshots and an unchanged final value may be emitted twice.

`WorkflowManager.executeRun()` already copies that callback into `managed.snapshot.tokenUsage`,
emits its `tokenUsage` manager event, and calls the progress hook. Because successful agent usage is
updated before `onAgentJournal`, the subsequent `recordJournalEntry()` persistence point also saves
the new cumulative total. Failed/paused settlement saves the latest total in its terminal
`persistRun()` call.

The await projector reads `manager.getRun(runId)?.snapshot.tokenUsage` first and persisted
`tokenUsage` second. It omits the field until a measurement or estimate exists. The values retain
current engine semantics:

- `total` includes every live attempt and uses the existing prompt/result estimate when the runner
  reports no usage;
- `input`, `output`, `cost`, `cacheRead`, and `cacheWrite` contain runner-reported values only;
- journal-replayed calls consume no tokens and are not added again;
- a `resumeFromRunId` execution reports usage for new live work in that new execution, not historical
  usage from the source run.

When terminal, top-level `tokenUsage` and `outcome.tokenUsage` are identical. The duplication lets a
poller use one stable location before and after completion while preserving the foreground execution
result shape inside `outcome`.

### 3.7 Headless checkpoint and authentication pauses

Background execution never captures the initiating request's elicitation callback. Its checkpoints
therefore follow `packages/workflow-engine/src/workflow.ts` `checkpoint()` exactly:

- omitted `headless` or `headless: "default"` journals and returns `default ?? true`, then continues;
- `headless: "abort"` throws `WORKFLOW_ABORTED`; under the current manager classification this is a
  terminal `failed` run unless its abort controller was also cancelled, and await reports
  `errorCode: "WORKFLOW_ABORTED"` in its inherited status fields;
- `headless: "pause"` settles as `status: "paused"`, `reason: "checkpoint_required"`, and
  `errorCode: "CHECKPOINT_REQUIRED"`.

For the checkpoint pause, the inherited `WorkflowRunStatus` portion supplies reason/code and the
terminal `outcome.checkpointContext` supplies the exact non-secret `callIndex`, `hash`, `prompt`,
`kind`, optional `choices`, and optional `default`. The caller continues it with a new run request
using `resumeFromRunId` and `checkpointReplies`; await itself never accepts a reply.

An agent `AUTH_REQUIRED` error similarly settles the background run as `paused`. The status portion
contains `reason: "auth_required"` and `errorCode: "AUTH_REQUIRED"`, while
`outcome.authContext` contains the non-secret backend/method descriptors. The human-readable await
summary uses the same CLI-login plus `resumeFromRunId` guidance as foreground. No host-facing auth
tool or credential channel is added.

This placement is intentional and does not change `WorkflowRunStatus`: the safe status projection
identifies why execution stopped, while the terminal execution `outcome` carries the existing
structured host action context.

### 3.8 Process lifetime and crash semantics

Background means detached from one MCP request, not detached from the MCP server process.

- Once the acknowledgement is returned, client cancellation of that request does not reach the run.
  If the stdio transport disconnects but the Node process and ACP runner processes remain alive, the
  run continues and keeps journaling.
- There is no guarantee that an MCP host keeps its stdio child alive after disconnect. SIGTERM,
  SIGKILL, machine shutdown, process crash, or an explicit server exit can end in-flight agent work.
  This design does not fork a daemon, transfer ownership to a worker service, or promise completion
  after server-process death.
- The initial `running` record is saved before acknowledgement. On a background resume, that initial
  record contains the entire hydrated source journal and any synthetic checkpoint reply, so the new
  run ID never depends on replay callbacks to copy its cached prefix. Thereafter, completed
  agent/checkpoint calls are durable at their journal persistence points; logs/phases/token totals
  are durable at those points and at normal settlement. An agent call in flight when the process
  dies has no replayable result and will run again on resume. Its external side effects therefore
  need the same idempotence care as every existing crash-and-resume path.
- Later manager persistence is currently best effort. A disk-full or permissions failure can leave
  the last successfully written snapshot behind even though the in-memory run continues; the server
  logs the warning and same-process await reads live state, while a restarted server can promise only
  the last durable journal prefix.
- On the next server construction, `recoverStaleRuns()` changes an orphaned persisted `running` run
  to `paused` after acquiring its lease. Inspect/await then reports the pause; the caller submits the
  script again with `resumeFromRunId` to replay the durable prefix. The recovered pause has no
  checkpoint/auth context unless that was already the persisted terminal cause.
- The background concurrency registry is process-local and disappears on exit. It is not a durable
  queue. Cross-process run leases prevent two processes from executing the same run ID, while each
  process applies its own admission cap to newly created background runs.

### 3.9 Concurrent background-run limit

Export `MAX_BACKGROUND_RUNS = 4` from `packages/mcp-server/src/server.ts` and the package barrel. The
limit applies per `createWorkflowServer()` instance to runs requested with `background: true`,
including background executions that hydrate `resumeFromRunId`. Foreground runs, inspect calls, and
await calls do not consume these slots.

Use a small private `BackgroundRunRegistry` in `createWorkflowServer()`:

- Reserve a slot synchronously before the first asynchronous approval/admission step so concurrent
  calls cannot all pass a check and oversubscribe. A starting request counts toward the four.
- Release the reservation if validation, backend approval, lease acquisition, or initial persistence
  fails.
- Replace the reservation with the accepted run ID/promise when `startInBackground()` returns.
- Release the slot on promise fulfillment or rejection, which corresponds to completed, paused,
  failed, or aborted settlement. Result retention is persistence-backed and does not keep the slot.

There is no queue. A fifth active-or-starting request returns `isError: true`, no
`structuredContent`, and exactly:

```text
Background workflow limit reached (4 active or starting runs). Await an existing run and retry.
```

A fixed, conservative cap prevents one MCP model from multiplying the engine's existing per-run
default concurrency of eight into unbounded agent sessions. It is exported for truthful docs and
tests but is not configurable by an untrusted tool call.

### 3.10 Output validation, size, and redaction

Extend the common `workflowToolOutputShape` from the observability design with optional `wait` and
`outcome` objects. `runId` and `status` remain required at the top level, so legacy execution,
background acknowledgement, exact inspect status, and await all validate after a client caches the
schema through `listTools()`.

The inherited status fields in an await result are produced by the exact observability projector:
its phases/logs/call previews retain the 24,576-byte status budget, 512-byte scalar/preview limits,
redaction, filtering, and truncation counters. Await text is formatted from that bounded status and
pause context, never by JSON-stringifying the raw result, and is capped at the same 8,192 UTF-8 bytes
as inspection text.

`wait` is fixed-size numeric/enum metadata and `tokenUsage` is numeric. `outcome`, however, preserves
the existing foreground MCP result contract: the script-authored `result` and existing full `logs`
are not redacted, compacted, or truncated, and no new total-byte cap is imposed on the complete await
envelope. This is necessary to deliver the actual terminal value rather than a lossy preview and
keeps foreground/background results equivalent. The caller already supplied the script and receives
that same data synchronously today. The status projection remains the bounded choice for routine
polling; `outcome` appears once, only at terminal status.

No raw persisted script, args, prompts, histories, hashes, session IDs, cwd, or credentials are
added by this feature. The only raw terminal data is the same authored result/log projection already
available from a foreground execution.

## 4. Alternatives considered

### Use `resumeFromRunId` as status or await

Rejected because it would conflate a read with execution. Today `resumeFromRunId` hydrates a journal
into a new run using the caller's current script and args. Calling it can spend tokens, repeat a
cache-missed agent, create a new run ID, and change files. Status/await is read-only and must never
replay the script.

### Leave `startInBackground()` unchanged and copy only new live misses

Rejected because replay hits intentionally bypass `onAgentJournal`. If a source run contains calls
zero through nine and a background resume executes call ten before pausing, the new run would persist
only call ten. Resuming that new run would miss at call zero and execute calls zero through ten again.
Copying the hydrated map in the MCP adapter after start is also too late: the two stores could diverge
before acknowledgement, and SDK callers would retain the same defect. Seeding and fail-fast saving
the journal inside `WorkflowManager.startInBackground()` establishes one invariant for every
journaling background caller.

### Add waiting and terminal results directly to `action: "inspect"`

Rejected because the reviewed inspect contract is an immediate, safe, bounded
`WorkflowRunStatus`. Returning raw authored results from the same action would weaken its redaction
and size guarantees and change its exact shared payload. A distinct await action keeps immediate
diagnostics predictable while reusing every status field.

### Add `workflow_start`, `workflow_status`, or `workflow_await` tools

Rejected because the package deliberately advertises one model-facing tool and tests that policy.
These are operations on the same workflow-run resource, so action branches are sufficient without
reintroducing tool-selection noise or host-side control-plane tools.

### Use MCP Tasks as the only detached mechanism

Rejected because the current tool is registered as an ordinary handler with task support forbidden,
and the motivating clients are specifically timeout constrained. Requiring task-capable MCP clients
would make the feature unavailable to part of the target audience. The run journal and bounded await
work over ordinary `tools/call` everywhere the existing tool works.

### Fork a daemon or worker process per background run

Rejected because it would require serializing the injected runner, approvals, model routing, and
live ACP connections across a new process boundary and would create a new daemon ownership/security
model. The requested safety property is durable journal replay, not guaranteed execution after the
stdio server dies.

### Allow unlimited background runs or queue overflow

Unlimited runs can multiply each workflow's agent concurrency into resource exhaustion. A hidden
queue makes a `running` acknowledgement misleading because work may not have started and makes queue
retention/process-exit semantics another public contract. A small reject-on-admission cap is explicit
and retryable.

### Retain completed outcomes only in the in-memory promise map

Rejected because results would disappear as soon as the slot was released or the stdio server
restarted, despite already being present in `PersistedRunState`. Persistence-backed reconstruction
provides repeatable retrieval with no second result store or TTL.

### Abort background work when the initiating request is cancelled

Rejected because a client timeout is the failure mode this feature removes. Foreground calls remain
request-cancellable; a caller that opts into background explicitly chooses process-lifetime execution
and journal/resume recovery.

## 5. Compatibility & semver

All changes are additive. Existing requests omit `action` and `background`, continue through
`runSync()`, retain live progress/elicitation/request cancellation, and receive the same terminal
execution result. Existing `resumeFromRunId` journal hydration, changed-args behavior, new run-ID
creation, replay hashes, DSL semantics, and the one-tool policy remain unchanged. The only persistence
behavior correction is that a journaling `startInBackground()` now writes the already-supplied replay
prefix into the new run instead of losing it; the JSON schema already permits those `JournalEntry`
values, so old and new persisted files remain readable. Old persisted runs can be awaited because
terminal outcomes are reconstructed from optional fields with `cost ?? 0`; missing observability
fields receive the sibling design's legacy fallbacks.

Create one Changeset with these releases:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/workflow-engine` | Emit cumulative `onTokenUsage` snapshots after live attempts and make `startInBackground()` seed plus initially persist `ExecOptions.resumeJournal` so multi-hop background resume preserves the full prefix | minor |
| `@automatalabs/workflows` | Carry the additive engine callback and replay-safe background behavior through the existing public manager facade | patch |
| `@automatalabs/mcp-server` | Add `background`, `action: "await"`, await/result types, bounded waiting, process-local admission, and result reconstruction | minor |

`@automatalabs/shared-types` receives no additional change for this item: it uses `TokenUsage` and
the exact `WorkflowRunStatus` family added and minor-bumped by the observability Changeset.
`@automatalabs/acp-agents` is unchanged; the existing injected `AgentRunner` and its usage callbacks
already supply all required data.

The implementation PR is based on, or stacked immediately after, the observability contract so the
shared types and `WorkflowManager.inspectRun()` exist. If both designs land in one release PR, keep
their Changeset entries consolidated so each package receives only the highest stated bump.

## 6. Test plan

### `packages/workflow-engine`

- Extend the existing `node:test` manager/runtime suites with a deferred two-agent runner. Assert
  `onTokenUsage` and `manager.getSnapshot(runId).tokenUsage` update after the first agent while the
  second is still blocked, remain cumulative and monotonic, and end at the existing
  `WorkflowRunResult.tokenUsage` totals.
- Cover runner-reported usage and estimate fallback, a failed retry attempt, provider-limit/auth
  pauses, and a terminal failure. Assert the latest totals survive persistence and cold load.
- Resume a journaled prefix and assert replay does not emit/add usage for cached agents; only new
  live work contributes to the resumed execution.
- Add a multi-hop persistence regression in the existing `node:test` manager/persistence style.
  First complete an args-controlled ten-agent prefix and load its journal. Start the same script with
  `startInBackground()`, changed args that add call ten plus a `headless: "pause"` checkpoint, and the
  source map as `resumeJournal`. Hold call ten in a deferred runner and assert the new run's initial
  persisted record already contains indexes zero through nine; then resolve it, await the expected
  `CHECKPOINT_REQUIRED` rejection, and assert that run's persisted journal contains indexes zero
  through ten. Hydrate a third execution from that second run, add the keyed synthetic checkpoint
  reply, and assert it completes with zero runner calls for the entire zero-through-ten prefix. Also
  assert replay did not re-fire `onAgentJournal`, proving the test depends on manager seeding rather
  than accidental replay callbacks.
- Keep the existing `startInBackground()` tests proving immediate run ID creation, initial
  persistence, independent concurrent runs, rejection containment, and promise settlement. Extend
  the initial-persistence assertion to cover sorted/deduplicated `resumeJournal` values and a
  synthetic checkpoint entry. No engine run-count cap is introduced.

### `packages/workflows`

- Extend `test/sdk.test.ts` through the public facade only. Start a deferred background run with the
  facade `WorkflowManager`, assert the ACP event bridge remains installed until the returned promise
  settles, and assert incremental `tokenUsage` events/snapshots are visible without importing engine
  internals.
- Keep a compile-gate fixture for `WorkflowManager.startInBackground()` and its
  `{ runId, promise: Promise<WorkflowRunResult> }` handle so the MCP adapter's required public method
  cannot disappear from the facade.
- Through that facade, start a background run with a preloaded journal map, pause after one live
  miss, and assert the persisted child run contains both the replayed prefix and live suffix. This
  verifies the facade override preserves the corrected engine behavior while holding its ACP bridge.

### `packages/mcp-server`

- Update `test/workflow-tool-input.test.ts` for omitted/false/true `background`, the
  run/inspect/await discriminator, `waitMs` default and 0/25,000 bounds, and every illegal mixed
  branch. Preserve execution-knob clamp tests.
- Update `test/workflow-tool.test.ts` to keep asserting exactly one registered tool and validate all
  four structured response forms after `listTools()` has cached the advertised output schema:
  foreground execution, two-field background acceptance, exact inspect status, and extended await.
- With a deferred runner, prove the initial background call returns before the runner resolves and
  is exactly `{ runId, status: "running" }`. Assert initiating-call cancellation after acceptance
  and await-call cancellation do not abort the managed run; the latter returns the exact cancelled
  await error with no structured content.
- Start four blocked background runs, assert a fifth receives the exact limit error without invoking
  the runner, settle one, and assert a replacement is accepted. Cover a reservation released after
  parse/approval/start failure and prove foreground/inspect/await calls consume no slot.
- Exercise `await` at `waitMs: 0`, positive timeout, and early completion. Assert
  `returnedBecause`, elapsed/requested values, latest phase/log/call projection, filter behavior,
  partial token totals, and presence/absence of `outcome` at the exact lifecycle boundary.
- Complete a background run, await it repeatedly, close the first in-memory server, construct a new
  server over the same isolated project store, and await again. Assert the raw result, normalized
  token usage, and logs are identical. Delete/corrupt the fixture and assert the exact unknown-run
  error with no structured content.
- Run background checkpoints in all three headless modes with a client that advertises elicitation.
  Assert no checkpoint elicitation is sent after acceptance: default continues, abort reports failed
  plus `WORKFLOW_ABORTED`, and pause reports `checkpoint_required` plus
  `outcome.checkpointContext`.
- Drive an `AUTH_REQUIRED` runner and assert await returns a successful read with status/reason/code,
  non-secret `outcome.authContext`, no credentials, and CLI-login/resume guidance.
- Exercise the full MCP multi-hop resume chain: complete a source run with calls zero through nine;
  start a new `background: true` execution with changed args that replay those calls, execute only
  call ten, and stop at a `headless: "pause"` checkpoint; await its pause; then submit a third run
  with `resumeFromRunId` set to the background run and its `checkpointReplies` answer. Assert the
  third run makes zero runner calls for the original zero-through-ten prefix and completes from the
  persisted journal. Also assert each execution gets a new run ID, the second run's persisted
  journal contains all eleven agent entries before the third starts, and `action: "await"` never
  changes runner call count or run lease. This is the required regression against dropping replayed
  entries from the background child journal; a one-hop replay assertion alone is insufficient.
- Seed a persisted `running` run with a journal, construct a fresh server, and assert stale recovery
  exposes it as paused and resumable rather than claiming process-independent completion.
- Reuse the observability suite's oversized/multibyte status fixtures to prove the inherited status
  fields still meet the 24,576-byte projection and 8,192-byte text caps inside await. Separately
  assert a large authored terminal result is returned exactly in `outcome` and is not duplicated into
  the text block.

## 7. Docs & skill updates

This changes the MCP tool surface, so the implementation PR must update every authoring surface and
regenerate the bundled prompt in the same commit:

- Root `README.md`: change the MCP overview from synchronous-only to foreground-by-default, document
  `background: true`, and show the run/await loop and process-lifetime warning.
- `docs/api.md`: document the run/inspect/await input union; `WorkflowBackgroundAccepted`,
  `WorkflowAwaitMetadata`, and `WorkflowRunAwaitResult`; wait bounds; token semantics; the four-run
  cap; terminal result retention; cancellation; checkpoint/auth pause payloads; and exact process
  guarantees.
- `packages/workflow-engine/README.md`: document that `startInBackground()` is process-lifetime,
  that a supplied `resumeJournal` is copied into the new run before its fail-fast initial save,
  journal persistence guarantees across multiple resume hops, stale recovery, and the cumulative
  snapshot behavior of `onTokenUsage`.
- `packages/workflows/README.md`: expand the existing `WorkflowManager` section with the returned
  background handle, explicit promise rejection behavior for non-completed outcomes, live status
  reads, replay-prefix seeding, and journal/resume safety after process loss.
- `packages/mcp-server/README.md`: update the one-tool input/output tables and run model; include
  exact background/await JSON, default/maximum wait, status-versus-outcome size/redaction behavior,
  no-TTL retrieval, four-run admission error, no background progress token, headless checkpoints,
  auth pause handling, and stdio-child lifetime semantics.
- `skills/agentprism-workflow-authoring/SKILL.md`: teach agents to choose `background: true` for long
  runs, retain the returned run ID, use 20-second await calls, inspect when they need immediate
  filtered diagnostics, and resume only a paused journal.
- `skills/agentprism-workflow-authoring/reference.md`: add the exact run/await input and output types,
  defaults/bounds, terminal-outcome invariant, token/cap/retention rules, checkpoint/auth surfaces,
  the multi-hop guarantee that each resumed background run persists the inherited prefix under its
  new run ID, and the explicit statement that await is read-only while `resumeFromRunId` executes.
- `skills/agentprism-workflow-authoring/examples/README.md`: add a complete host-call transcript for
  starting one of the shipped examples in the background, timing out once, collecting the result,
  and resuming a checkpoint pause through a second background run and its new run ID. Workflow
  scripts do not invoke host MCP actions themselves.
- Run `node scripts/generate-authoring-prompt.mjs` to regenerate
  `packages/mcp-server/src/generated/authoring-prompt-content.ts`, then update the authoring-prompt
  drift assertion/snapshot if its expected source metadata changes. Never hand-edit the generated
  file.
- Add the Changeset from section 5; package changelogs remain generated by the release flow.

## 8. Implementation breakdown

Implement this item as one PR stacked on the run-observability PR; the status projector must land
before the await adapter can compile.

1. **S — Incremental engine usage.** Emit cumulative token snapshots after each live attempt, retain
   final emission, and add runtime/manager persistence tests.
2. **S — MCP contracts.** Extend the discriminated input parser with `background`/`await`, add the
   exported background/await result types and output-schema fields, and add schema unit tests.
3. **M — Replay-safe background admission and start.** In `workflow-engine`, make
   `WorkflowManager.startInBackground()` seed `managed.journal` from sorted
   `ExecOptions.resumeJournal` values and include that full journal in its fail-fast initial save.
   Add the engine and SDK multi-hop persistence regression. In `mcp-server`, add the four-slot
   reservation registry, route opted-in calls to the corrected method, detach request-scoped
   signal/progress/checkpoint channels, hydrate the source journal plus any synthetic checkpoint
   reply before start, and return the exact acknowledgement.
4. **M — Bounded await and outcome projection.** Implement local-promise wake-up plus 250-ms cold
   polling, cancellation cleanup, live-first token lookup, persistence-backed terminal projection,
   bounded text formatting, and exact unknown-run behavior.
5. **L — MCP lifecycle coverage.** Add deferred-run, cap/race, timeout, cancellation, checkpoint,
   auth, background-resume-to-pause-to-resume prefix preservation, cold-restart, retention, and size
   tests over the existing in-memory MCP harness.
6. **M — Documentation and release.** Update every README/API/skill/example surface above,
   regenerate the `author-workflow` prompt and drift fixture, and add the three-package Changeset.
