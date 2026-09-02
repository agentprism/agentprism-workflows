# MCP Run Observability: Inspection and Failure Log Tails

**Date:** 2026-07-14

**Feedback:** issue #131, section 1

> **Current MCP migration:** this historical design introduced `action:"inspect"`. The implemented
> model-facing contract now consolidates observation under `action:"status"`; see
> [`workflow-status-action.md`](../workflow-status-action.md). The engine's backend-agnostic
> `inspectRun()` primitive remains unchanged.

## 1. Problem

The MCP `workflow` call returns a terminal summary, but an agent diagnosing a paused or failed run
cannot reliably see the narration and completed call results that explain the outcome. The durable
data exists in the project-scoped run file under
`~/.agentprism/workflows/projects/<dir>-<hash>/runs/<runId>.json`, so the current workaround is to
locate that private implementation file and manually inspect its `logs`, `agents`, and `journal`.
That is not a usable MCP contract and exposes much more state than diagnosis requires, including the
script, args, prompts, histories, hashes, session identifiers, and full unbounded results.

This design delivers both requested paths. First, the existing `workflow` tool gains a read-only
inspection action that returns a shared run-status payload containing lifecycle status, phase state,
a bounded log tail, and filtered, attributed, compact journal results. Second, every paused, failed,
or aborted execution result carries the latest 20 run-log lines in both structured content and the
human-readable MCP text response, so the first failure response is independently diagnosable.

Inspection remains part of the existing `workflow` tool. The server deliberately removed auth and
provider control-plane tools and, at the time of this spec, promised one model-facing tool (`workflow`;
the server has since added a second, `repl` — see the pack [README](README.md)'s historical-scope note);
run, resume, and inspect are operations on the same workflow-run resource. A discriminated action avoids reintroducing tool-choice
noise while retaining byte-for-byte-valid legacy execution inputs that omit the action.

## 2. Current state

### Shared contracts

- `packages/shared-types/src/workflow-result.ts` exports `RunStatus`, `JournalEntry`, and
  `WorkflowRunResult`. `JournalEntry` currently contains only `index`, `hash`, `result`, and an
  optional `AgentSessionRecord`. It has no explicit call kind, label, model, or backend fields.
  `WorkflowRunResult.logs` contains captured lines, but there is no bounded tail object or reusable
  run-inspection/status payload. `packages/shared-types/src/index.ts` re-exports this file.
- `AgentSessionRecord` does carry `callIndex`, `label`, optional `phase`, and `backendId` through its
  `AgentSessionRef` base. That provides a partial fallback for old agent journal entries, but it is
  absent for checkpoints and for runners that do not invoke `RunOptions.onSessionOpen`; it also does
  not carry a model.

### Engine lifecycle and persistence

- `packages/workflow-engine/src/run-persistence.ts` defines `PersistedRunState` and
  `createRunPersistence()`. Persisted state already includes `status`, `pauseReason`, `phases`,
  `currentPhase`, `agents`, `logs`, and `journal`. It also stores the raw `script`, `args`, agent
  prompts/results/histories, and session records, which must not be projected wholesale. It does not
  persist the terminal `WorkflowError.message` or error code as run-level fields. `load(runId)` tries
  the primary and backup JSON files and returns `null` for a missing or unreadable run.
- `packages/workflow-engine/src/workflow-paths.ts` implements the current project namespace through
  `workflowProjectPaths(cwd)`: the default root is `~/.agentprism/workflows`, with run files under
  `projects/<project-key>/runs`. Inspection must use the manager's existing persistence instance so
  it has exactly the same project/root selection as resume.
- `packages/workflow-engine/src/workflow.ts` assigns the deterministic `callIndex` before the
  concurrency limiter. On a successful live `agent()` it invokes `onAgentJournal` with
  `{ index, hash, result, session }`; on a resolved `checkpoint()` it journals
  `{ index, hash, result }`. The runner's `onModelResolved` callback updates `displayModel`, and
  `onSessionOpen` provides the actual `backendId`, but those values are not currently copied into the
  journal entry. Failed agent calls are not journaled as replayable results, correctly preventing a
  failure from becoming a resume cache hit.
- The same file's `log()` bridge appends to runtime `state.logs` and calls `WorkflowLogger.log()`.
  `packages/workflow-engine/src/logger.ts` forwards logger writes through `WorkflowLoggerOptions.onLog`.
  Consequently `WorkflowManager`'s live snapshot receives DSL `log()`/`console.*` narration and
  engine-generated logger messages such as failed-attempt diagnostics.
- `packages/workflow-engine/src/workflow-manager.ts` defines `WorkflowManager.runSync()`,
  `composeResult()`, `recordJournalEntry()`, and `persistRun()`. `runSync()` resolves ordinary
  completed/paused/failed/aborted outcomes to `WorkflowRunResult`; `composeResult()` uses the live
  snapshot when the engine did not produce a completed result. `persistRun()` writes snapshots and
  journals, but logs/phases are only guaranteed durable at persistence points (initial save, journal
  append, and settlement). The manager exposes raw `getRun()`, `getSnapshot()`, and
  `getPersistence()`, but no safe public inspection projection.

### MCP projection

- `packages/mcp-server/src/workflow-tool-input.ts` exports the raw Zod
  `workflowToolInputShape`, `WorkflowToolInput`, and `clampWorkflowInput()`. `script` is required,
  execution is synchronous, and explicit resume is selected with `resumeFromRunId`; there is no
  operation discriminator or inspection branch.
- `packages/mcp-server/src/workflow-tool-output.ts` exports `workflowToolOutputShape`,
  `WorkflowToolResult`, and `toWorkflowToolResult()`. The structured projection currently includes
  `runId`, `status`, optional `result`/`tokenUsage`, the complete `run.logs` array, and structured
  pause contexts. It does not expose phases, current phase, attributed journal entries, or a named
  bounded tail.
- `packages/mcp-server/src/server.ts` constructs one long-lived `WorkflowManager` in
  `createWorkflowServer()`, registers exactly one tool named `workflow`, and formats completed versus
  non-completed text with `formatRunSummary()`. `formatTerminalSummary()` prints status, run ID,
  reason/reset hint, and resume guidance, but no log lines. This explains why a calling model that is
  shown the text content sees the final cause but not the diagnostic narration even though the
  structured projection currently carries `logs`.
- The one-tool policy is explicit in `packages/mcp-server/README.md`, asserted by
  `packages/mcp-server/test/workflow-tool.test.ts`, and recorded in
  `packages/mcp-server/CHANGELOG.md` 0.7.0. The removed tools were misleading host-side auth/provider
  controls. Inspection is instead truthful read-only access to state already owned by `workflow`.

## 3. Proposed design

### 3.1 Shared types and enriched journal metadata

Add the following contracts to `packages/shared-types/src/workflow-result.ts` and re-export them from
the existing package barrels:

```ts
export type JournalCallMetadata =
  | {
      kind: "agent";
      label: string;
      phase?: string;
      /** Resolved model when the runner reported one; otherwise the engine's best-known spec. */
      model?: string;
      /** Actual backend from onSessionOpen; absent when the runner supplied no session ref. */
      backendId?: string;
    }
  | {
      kind: "checkpoint";
      label: "checkpoint";
      phase?: string;
    };

export interface JournalEntry {
  index: number;
  hash: string;
  result: unknown;
  session?: AgentSessionRecord;
  /** Additive diagnostic metadata; it is not part of replay identity. */
  call?: JournalCallMetadata;
}

export interface WorkflowRunInspectionOptions {
  /** Latest matching journal entries. Default 20; valid range 1..50. */
  lastN?: number;
  /** Case-sensitive whole-label glob. Omitted means all call kinds. */
  labelGlob?: string;
  /** Latest run-log lines. Default 20; valid range 0..50. */
  logLines?: number;
}

export interface WorkflowLogTail {
  lines: string[];
  totalLines: number;
  omittedLines: number;
  truncatedLines: number;
  redactedLines: number;
}

export interface WorkflowRunCallStatus {
  index: number;
  kind: "agent" | "checkpoint" | "unknown";
  label?: string;
  phase?: string;
  model?: string;
  backendId?: string;
  /** Compact JSON text after structural compaction and redaction; never the raw result. */
  resultPreview: string;
  resultRedacted: boolean;
  resultTruncated: boolean;
}

export interface WorkflowRunStatusTruncation {
  maxStructuredBytes: number;
  byteCapApplied: boolean;
  phases: { total: number; returned: number; shortened: number };
  logs: { total: number; returned: number; shortened: number; redacted: number };
  calls: {
    total: number;
    matched: number;
    returned: number;
    shortenedResults: number;
    redactedResults: number;
  };
}

/** Safe, bounded, point-in-time status used by every run-inspection/polling host. */
export interface WorkflowRunStatus {
  runId: string;
  status: RunStatus;
  workflowName: string;
  phases: string[];
  currentPhase?: string;
  reason?: string;
  errorCode?: WorkflowErrorCode;
  logTail: WorkflowLogTail;
  calls: WorkflowRunCallStatus[];
  filter: { lastN: number; logLines: number; labelGlob?: string };
  truncation: WorkflowRunStatusTruncation;
}
```

Also add `logTail?: WorkflowLogTail` to `WorkflowRunResult`. `WorkflowManager` sets it for every
`paused`, `failed`, or `aborted` result; it remains absent on `completed` results. This is additive,
and the existing full `logs` field keeps its current SDK and MCP behavior for compatibility.

The engine writes `JournalEntry.call` only after it has the best attribution available. Successful
agents store the final `label`, `phase`, `displayModel`, and `session?.backendId`; checkpoints store
`{ kind: "checkpoint", label: "checkpoint", phase: state.currentPhase }`. The metadata never enters
`hashAgentCall()`, `hashCheckpoint()`, or replay matching. Synthetic checkpoint replies created by
both `WorkflowManager.resumeInBackground()` and the MCP resume adapter receive the checkpoint
metadata too. Old entries remain valid because `call` is optional. Inspection derives an old agent
entry's label/phase/backend from `entry.session` when present; otherwise it returns
`kind: "unknown"` without inventing attribution.

### 3.2 Engine-owned inspection API

Add this public method to `packages/workflow-engine/src/workflow-manager.ts`:

```ts
inspectRun(
  runId: string,
  options?: WorkflowRunInspectionOptions,
): WorkflowRunStatus | undefined;
```

The method is synchronous and read-only. It never acquires a run lease, saves state, or changes a
status. It first checks the manager's in-memory `ManagedRun`, ensuring a concurrent inspection sees
the freshest snapshot and journal; if the ID is not in memory, it calls the existing
`RunPersistence.load(runId)`. Thus non-journaled runs are inspectable only while this manager still
holds them, while normal MCP runs remain inspectable after restart. The lookup deliberately mirrors
`resumeFromRunId`: it is project-scoped and possession of the run ID is the capability, rather than
being filtered by `listRuns()`'s optional UI session ID.

`WorkflowManager` also persists run-level `reason?: string` and `errorCode?: WorkflowErrorCode` on
`PersistedRunState`. The manager derives `reason` through the same helper used by `composeResult()`:
standardized pause reasons remain `usage_limit`, `auth_required`, and `checkpoint_required`, while a
failure retains the actual `WorkflowError.message`. This closes the cold-inspection gap without
returning raw per-agent error objects.

Inspection normalization is fixed:

- `lastN` defaults to 20 and must be an integer from 1 through 50.
- `logLines` defaults to 20 and must be an integer from 0 through 50.
- `labelGlob`, when present, must be non-empty and at most 128 Unicode code points.
- Programmatic violations throw `RangeError`. The MCP Zod boundary rejects the same violations as
  Invalid Params before calling the manager.
- Glob matching is case-sensitive and covers the entire raw label. `*` matches zero or more Unicode
  code points, `?` matches exactly one, and `\` escapes the next character. A trailing `\` matches a
  literal backslash. Implement the matcher with dynamic programming, not a constructed regular
  expression. `labelGlob` applies only to entries known to be agents; checkpoints and unknown legacy
  entries are excluded when a glob is supplied.
- Filtering happens before `lastN`. The latest matching entries are selected by `index`, then
  returned in ascending index order so narration reads chronologically.
- `phases` is the manager/persisted phase-title order: declared titles initialized in the snapshot
  plus dynamically encountered titles, with `currentPhase` separate. No per-phase completion state
  is inferred.

Place the pure projection, glob, redaction, preview, and byte-budget logic in a new
`packages/workflow-engine/src/run-observability.ts`. `WorkflowManager.inspectRun()` and terminal
`logTail` composition both use it. Export the types through `packages/workflow-engine/src/index.ts`;
the SDK facade in `packages/workflows/src/index.ts` re-exports them so consumers do not need to reach
through package internals.

### 3.3 Redaction and compact-result contract

Inspection never offers a raw mode. It does not return the persisted script, args, prompts, agent
history, journal hash, session IDs, cwd, checkpoint prompt/default, auth context, or the raw journal
result. This allowlist is the primary secret boundary; the remaining result preview is sanitized as
follows before serialization or truncation:

1. Recursively copy JSON values to a maximum depth of four. Keep the first 10 array elements and
   first 20 object keys in insertion order. Represent omitted content with
   `"[+N items omitted]"` or `"[max depth]"` and set `resultTruncated: true`.
2. Normalize each object key to lowercase alphanumerics. If it contains `password`, `passwd`,
   `secret`, `token`, `apikey`, `credential`, `authorization`, `cookie`, or `privatekey`, replace its
   complete value with `"[REDACTED]"`.
3. In every remaining string, replace with `"[REDACTED]"` each PEM private-key block; a
   `Bearer`/`Basic` credential; URL user-info before `@`; a JWT-shaped three-segment value; an
   assignment whose key matches the sensitive-key list; known credential prefixes
   (`ghp_`, `gho_`, `ghu_`, `ghs_`, `github_pat_`, `sk-`, `sk-proj-`, `xoxb-`, `xoxp-`, `AKIA`,
   `ASIA`) followed by at least eight token characters; and any unbroken base64/base64url/hex-like
   token of at least 32 characters containing at least one letter and one digit. The last rule is
   intentionally conservative and may redact commit hashes.
4. Serialize the compact copy with `JSON.stringify`. Cap `resultPreview` at 512 UTF-8 bytes. A
   shortened value ends with the literal `…[truncated]`; truncation removes complete Unicode code
   points until the suffix fits. `resultRedacted` is true if any replacement occurred, and
   `resultTruncated` is true if structural or byte truncation occurred.

Apply the same string redactor to every outward text scalar, including workflow/phase/call names,
model/backend identifiers, reason, and log lines. Each such scalar is capped at 512 UTF-8 bytes with
the same suffix. This policy cannot infer an arbitrary low-entropy secret embedded in natural prose;
the no-raw-field allowlist plus sensitive-key, assignment, credential-format, and conservative opaque
token rules define the enforceable boundary.

### 3.4 Hard size limits and deterministic truncation

The serialized JSON value placed in inspection `structuredContent` must be at most 24,576 UTF-8
bytes, measured as `Buffer.byteLength(JSON.stringify(status), "utf8")`. The accompanying inspection
text block must be at most 8,192 UTF-8 bytes, so the two new representations consume at most 32 KiB
before MCP envelope overhead.

Before the byte cap, inspection keeps at most 64 phase titles, the requested last `logLines`, and the
requested last `lastN` matching calls. If the structured payload is still too large, the projector
recomputes counters while removing, in order, the oldest returned call, the oldest returned log
line, and then the oldest phase until it fits. It always retains the newest diagnostics. If an
unexpected future fixed field still exceeds the cap after arrays are empty, it returns the minimal
status/header/filter/truncation object with optional `reason`, `errorCode`, and `currentPhase`
omitted; fixed-field scalar caps guarantee that object fits. `byteCapApplied` is true whenever this
budget pass removes data.

`truncation` reports source totals, post-glob matches, returned counts, shortened values, and
redactions. `WorkflowLogTail.omittedLines` is always `totalLines - lines.length`, so it includes
selection and byte-budget omissions. The formatted text is produced from the already-bounded shared
payload; if it exceeds 8,192 bytes it is Unicode-safely shortened with `…[text truncated]`.

### 3.5 MCP input and output wire contract

Keep one registered tool and extend its input to this discriminated union:

```ts
export interface WorkflowExecuteToolInput {
  action?: "run"; // omitted means today's execution behavior
  script: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  resumeFromRunId?: string;
  checkpointReplies?: Record<number, unknown>;
  runId?: never;
  lastN?: never;
  labelGlob?: never;
  logLines?: never;
}

export interface WorkflowInspectToolInput extends WorkflowRunInspectionOptions {
  action: "inspect";
  runId: string;
  script?: never;
}

export type WorkflowToolInput = WorkflowExecuteToolInput | WorkflowInspectToolInput;
```

Because `registerTool` currently receives a Zod raw shape, `script` becomes schema-optional and a
new exported `parseWorkflowToolInput()` performs the cross-field discrimination after primitive Zod
validation. It throws MCP Invalid Params (`-32602`) when no branch is complete, when inspect fields
are mixed with execute fields, or when `action: "run"` lacks `script`. The omitted `action` plus a
non-empty `script` remains a valid execute input, so every existing call remains valid.
`action: "inspect"` requires `runId` to match the engine-generated
`/^[a-z0-9]+-[a-z0-9]+$/` form and be at most 128 characters; this also prevents a run ID from being
treated as a path. Inspection never runs the script, invokes the runner, requests backend approval,
elicits, sends progress, or consumes a run lease.

Example request:

```json
{
  "action": "inspect",
  "runId": "mabc1234-k9x2pq",
  "lastN": 10,
  "labelGlob": "plan-review-*",
  "logLines": 20
}
```

The valid inspect response is exactly `WorkflowRunStatus`, not a second MCP-only status shape:

```json
{
  "runId": "mabc1234-k9x2pq",
  "status": "failed",
  "workflowName": "implementation-review",
  "phases": ["Plan", "Implement", "Review"],
  "currentPhase": "Review",
  "reason": "FAIL-CLOSED at review",
  "errorCode": "SCRIPT_ERROR",
  "logTail": {
    "lines": ["round 3: 2 findings remain", "FAIL-CLOSED at review"],
    "totalLines": 2,
    "omittedLines": 0,
    "truncatedLines": 0,
    "redactedLines": 0
  },
  "calls": [
    {
      "index": 18,
      "kind": "agent",
      "label": "plan-review-3",
      "phase": "Review",
      "model": "claude-opus-4-1",
      "backendId": "claude",
      "resultPreview": "{\"approved\":false,\"findingCount\":2,\"summary\":\"Missing rollback coverage\"}",
      "resultRedacted": false,
      "resultTruncated": false
    }
  ],
  "filter": { "lastN": 10, "logLines": 20, "labelGlob": "plan-review-*" },
  "truncation": {
    "maxStructuredBytes": 24576,
    "byteCapApplied": false,
    "phases": { "total": 3, "returned": 3, "shortened": 0 },
    "logs": { "total": 2, "returned": 2, "shortened": 0, "redacted": 0 },
    "calls": {
      "total": 19,
      "matched": 1,
      "returned": 1,
      "shortenedResults": 0,
      "redactedResults": 0
    }
  }
}
```

Expand `workflowToolOutputShape` into the common superset needed to validate both the existing run
projection and `WorkflowRunStatus`; `runId` and `status` remain required, while inspect-only fields
are optional in the raw output schema. Rename the current interface to
`WorkflowExecutionToolResult<T>` and export
`WorkflowToolResult<T> = WorkflowExecutionToolResult<T> | WorkflowRunStatus`.
`toWorkflowToolResult()` continues to project execution results and adds `logTail`.

An unknown or unreadable run returns `isError: true`, no `structuredContent`, and exactly:

```text
No workflow run found for runId "<runId>" in this server's project-scoped run store.
```

This deliberately does not reveal the persistence path or distinguish missing, corrupt, and
unreadable files. A valid inspection is never flagged `isError`, even when the inspected run itself
has `status: "failed"`; the read operation succeeded, and callers branch on the payload status.

### 3.6 Failure and pause log tail

For a `paused`, `failed`, or `aborted` `WorkflowRunResult`, the manager constructs `logTail` by taking
the final 20 entries from the snapshot's full `logs` array, redacting each line, and capping each at
512 UTF-8 bytes. The object is present even when there are zero lines. Selection happens before
redaction, and `totalLines` always describes the original snapshot array.

`packages/mcp-server/src/workflow-tool-output.ts` includes this object as `logTail` without
recomputing it. `formatTerminalSummary()` appends a `recent run log (last X of Y):` block after the
reason/reset hint and before resume guidance, with each line prefixed by two spaces. The terminal
text formatter is capped at 12,288 UTF-8 bytes with `…[text truncated]`; under the fixed 20-by-512
tail bound it normally does not truncate. Existing `isError` behavior is unchanged: paused is a
successful resumable tool call, while failed and aborted set `isError: true`. A malformed script
still fails before a run ID exists and therefore has no tail.

## 4. Alternatives considered

### A sibling read-only MCP tool

A separate `workflow_inspect` tool would make each schema simpler and is semantically honest as a
read-only operation. It was rejected because the server's published and tested contract is exactly
one model-facing tool, and inspection is lifecycle access to the same resource already run and
resumed by `workflow`. Adding a sibling would make every model choose between two workflow tools and
would reverse the deliberate surface simplification recorded in the 0.7.0 changelog. The action
discriminator preserves that history without conflating inspection with script execution.

### Only attach log lines to failures

The tail alone fixes the immediate failure response but cannot answer which labels/backends ran or
show structured reviewer output after the fact. It also cannot support repeated status reads. Both
the tail and inspection are required, so this is insufficient.

### Return `PersistedRunState` or raw journal results

This would be mechanically simple but would expose scripts, args, prompts, histories, working
directories, session IDs, replay hashes, and unbounded agent output. It would make the persistence
schema a public wire contract and create a direct secret/size hazard. The safe shared projection is
intentionally lossy.

### Build inspection from `PersistedAgentState` alone

Agent snapshots have labels/model previews, but no deterministic journal call index, and parallel
completion plus duplicate labels make positional joins incorrect. They also omit checkpoint
entries. Enriching `JournalEntry` at the point where `callIndex` and attribution are simultaneously
known is deterministic and remains backward compatible.

### Make redaction optional or truncate raw JSON bytes

An opt-out would let an MCP caller exfiltrate the exact payload this boundary is meant to protect.
Truncating raw serialized JSON can cut through a secret after it has already been selected and can
produce misleading partial structures. Redaction and structural compaction therefore precede the
bounded string preview, with no raw escape hatch.

## 5. Compatibility & semver

All existing execute inputs, run/resume behavior, `WorkflowRunResult.logs`, journal replay hashes,
and persisted files remain valid. Old journals simply have no `call` metadata and receive only the
attribution that can be proven from their optional session record. New fields are optional in
existing types/persistence, and inspection is a new read method/action.

Create one Changeset with these releases:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/shared-types` | New status/tail/call contracts; optional `JournalEntry.call` and `WorkflowRunResult.logTail` | minor |
| `@automatalabs/workflow-engine` | New `WorkflowManager.inspectRun()`, safe projector, persisted reason/code, enriched journal writes | minor |
| `@automatalabs/workflows` | Re-export the new shared inspection contracts and inherited manager method | minor |
| `@automatalabs/mcp-server` | Add the `action: "inspect"` branch, union output, and terminal `logTail` rendering | minor |

`@automatalabs/acp-agents` is unchanged: the engine already receives resolved model and session
backend attribution through the frozen `RunOptions` callbacks.

## 6. Test plan

### `packages/shared-types`

- Extend `test/index.test.ts` with compile/runtime fixtures proving the public barrel exports
  `WorkflowRunStatus`, `WorkflowRunInspectionOptions`, `WorkflowLogTail`, and
  `JournalCallMetadata`.
- Construct both a legacy `JournalEntry` without `call` and new agent/checkpoint entries with it,
  proving the additive field does not make old persisted shapes invalid.

### `packages/workflow-engine`

- Add `test/run-observability.test.ts` using `node:test`, `assert/strict`, the existing in-memory
  `RunPersistence` style, and deferred fake runners. Cover live `running` inspection, cold persisted
  completed/paused/failed inspection, current phase/phase ordering, missing IDs, and no mutation or
  lease acquisition.
- Have a fake runner invoke `onModelResolved` and `onSessionOpen`; assert the live and persisted
  journal metadata contains label, phase, resolved model, and actual backend. Assert checkpoint
  metadata and synthetic reply metadata, and prove journal hashes/replay still hit.
- Cover case-sensitive whole-label glob semantics (`*`, `?`, escaped wildcard, trailing backslash),
  filtering-before-last-N, ascending output order, exclusion of checkpoint/unknown entries under a
  label glob, and honest legacy fallback from `entry.session`.
- Feed nested sensitive keys, assignments, bearer/basic strings, URL credentials, JWTs, PEM keys,
  known prefixes, and opaque tokens through the projector. Assert none survive; assert redaction
  flags/counts. Also assert prompt/script/args/history/hash/session/cwd never appear in serialized
  status.
- Use multibyte Unicode, oversized arrays/objects/results, 50 large calls, 50 large logs, and more
  than 64 phases. Assert preview suffixes are valid UTF-8, newest entries survive, counters are exact,
  and serialized status is always at most 24,576 bytes.
- Extend manager failure/pause tests to assert `logTail` contains exactly the final 20 of 25 lines,
  reports omissions/redactions/truncations, is present when empty, and is also added for abort. Assert
  completed results do not gain it and the existing full `logs` array is unchanged.
- Extend `test/run-persistence.test.ts` for reason/error-code and enriched-journal round trips plus
  loading a pre-change JSON fixture without those fields.

### `packages/workflows`

- Extend `test/sdk.test.ts` as the facade compile gate for all new types and call
  `WorkflowManager.inspectRun()` through the public SDK class, proving the inherited method and
  shared payload are available without importing `workflow-engine` directly.

### `packages/mcp-server`

- Update `test/workflow-tool-input.test.ts` for legacy omitted-action execution, explicit
  `action: "run"`, valid inspection defaults/bounds, run-ID validation, and every mixed/missing
  branch Invalid Params case. Retain the existing execution knob clamp assertions.
- Update `test/workflow-tool.test.ts` to keep asserting exactly one registered tool, exercise both
  response branches after `listTools()` has cached the output-schema validator, and verify inspect
  does not increment the fake runner's call count.
- Run a multi-agent script, inspect it with `lastN` and `labelGlob`, and assert status/phases/log
  tail/attribution/compact results and chronological ordering. Cover unknown IDs as `isError: true`
  without structured content and inspecting a failed run as a successful read whose payload status
  is `failed`.
- Generate more than 24 KiB of safe previews/log lines and assert the structured byte cap and 8 KiB
  inspection text cap over the in-memory MCP transport.
- For paused and failed executions with 25 narrated lines, assert structured `logTail` and the text
  summary contain lines 6 through 25, omit lines 1 through 5, redact a planted token, and preserve
  current `isError`/resume guidance. Cover an empty-log failure and malformed pre-run script.

## 7. Docs & skill updates

This changes the MCP tool surface, so the implementation PR must update every authoring surface and
regenerate the prompt in the same commit:

- Root `README.md`: describe the single tool as run/resume/inspect and show a compact inspection call.
- `docs/api.md`: document `WorkflowManager.inspectRun()`, all shared status/filter/truncation types,
  `JournalEntry.call`, terminal `logTail`, redaction, limits, and the MCP action/error contract.
- `packages/shared-types/README.md`: add the new public result/status types and optional journal
  metadata.
- `packages/workflow-engine/README.md`: document safe inspection, live-versus-persisted lookup,
  glob/default/cap semantics, and terminal log tails.
- `packages/workflows/README.md`: document the facade re-exports and an SDK `inspectRun()` example.
- `packages/mcp-server/README.md`: change the input table to the run/inspect union, add request and
  response examples, explain one-tool rationale, unknown-ID behavior, failure/pause tails, redaction,
  and the 24 KiB + 8 KiB limits.
- `skills/agentprism-workflow-authoring/SKILL.md`: teach agents to retain `runId`, inspect a halted
  run before guessing, use label globs/last-N, and read the immediate terminal tail.
- `skills/agentprism-workflow-authoring/reference.md`: add the exact inspect input/status shapes,
  defaults, glob grammar, redaction/size behavior, and terminal `logTail` contract.
- `skills/agentprism-workflow-authoring/examples/README.md`: add post-run examples for inspecting the
  shipped workflows; workflow script examples themselves do not call host MCP operations.
- Run `node scripts/generate-authoring-prompt.mjs` to regenerate
  `packages/mcp-server/src/generated/authoring-prompt-content.ts`, then update the authoring-prompt
  drift assertion/snapshot if its expected content metadata changes. The generated file is never
  hand-edited.
- Add the Changeset described in section 5 and let Changesets generate package changelogs during the
  release flow.

## 8. Implementation breakdown

One PR is appropriate because the shared type, engine projector, and MCP schema must land together
for output-schema validation and prompt drift CI to remain green.

1. **S — Shared contracts.** Add/export the journal metadata, status/filter/call/truncation/tail
   types and optional `WorkflowRunResult.logTail`; add shared barrel tests.
2. **M — Attribution and persistence.** Enrich agent/checkpoint/synthetic journal writes without
   changing hashes; persist run-level reason/error code; add backward-compatible round-trip and
   replay tests.
3. **L — Safe engine projection.** Implement `run-observability.ts`, DP glob matching, structural
   compaction, redaction, UTF-8 truncation, byte budgeting, terminal tail creation, and
   `WorkflowManager.inspectRun()` with live-first lookup; add the exhaustive engine tests.
4. **S — SDK facade.** Re-export all contracts through `workflow-engine` and `workflows`; extend the
   facade compile/behavior tests.
5. **M — MCP action and output.** Add the discriminated parser, inspection handler, common output
   schema, text formatter, unknown-ID error, and terminal-tail rendering while retaining the single
   tool and legacy run path; extend in-memory MCP tests.
6. **M — Documentation and release.** Update all README/API/skill/example surfaces listed above,
   regenerate the `author-workflow` prompt, run its drift test, and add the four-package minor
   Changeset.
