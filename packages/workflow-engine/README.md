# @automatalabs/workflow-engine

The deterministic core that runs a workflow script. It is a **vm-realm script runtime**
plus a small DSL (`agent()`, `parallel()`, `pipeline()`, …), a resume journal, a token
budget, and optional git-worktree isolation. It drives subagents **only** through an
injected `AgentRunner` seam — it never imports or names a concrete agent backend.

> **Most users want [`@automatalabs/workflows`](../workflows).** That package wires this
> engine to the ACP backend (`@automatalabs/acp-agents`) for you, so `agent()` actually
> talks to a real coding agent. Reach for `@automatalabs/workflow-engine` directly only
> when you are building your own host and want to supply your own `AgentRunner`.

## Install

```bash
npm install @automatalabs/workflow-engine
```

ESM-only, Node 22+.

## The one thing you inject: `AgentRunner`

The engine references the backend through a single frozen method. Supply anything that
matches this shape (re-exported from `@automatalabs/shared-types`):

```ts
import type { AgentRunner, RunOptions, AgentResult } from "@automatalabs/workflow-engine";
import type { TSchema } from "typebox";

// Minimal stand-in. A real runner spawns/streams an agent; the ACP one lives in
// @automatalabs/acp-agents. With no `schema` the return is the assistant's text;
// with a typebox `schema` it is the parsed, validated object. Usage is reported
// out-of-band via options.onUsage — never in the return value.
const myRunner: AgentRunner = {
  async run<S extends TSchema | undefined = undefined>(
    prompt: string,
    _options?: RunOptions<S>,
  ): Promise<AgentResult<S>> {
    return `(stub) ${prompt}` as AgentResult<S>;
  },
};
```

## Minimal use

A workflow is a script whose **first statement** is `export const meta = {...}`; the rest
of the body runs inside the vm realm with the DSL injected as globals.

```ts
const script = `
export const meta = { name: "greet", description: "Summarize a topic" };
const draft = await agent(\`Write three bullet points about \${args.topic}.\`);
return draft;
`;
```

Run it through the manager (background tracking, pause/resume, terminal status):

```ts
import { WorkflowManager } from "@automatalabs/workflow-engine";

const manager = new WorkflowManager({ agent: myRunner });
const result = await manager.runSync(script, { topic: "otters" });
// result.status is always terminal: "completed" | "paused" | "failed" | "aborted"
console.log(result.status, result.result, result.tokenUsage);
```

For process-lifetime background execution, use the returned settlement handle:

```ts
const { runId, promise } = manager.startInBackground(script, { topic: "otters" });
console.log(manager.getSnapshot(runId)?.tokenUsage); // cumulative live usage when known
await manager.cancelAgentCall(runId, 3); // cancel one in-flight agent; the run stays live
const terminal = await promise; // rejects for pause, failure, or abort
```

`startInBackground()` returns only after lease acquisition and its fail-fast initial save; it is
detached from the caller, not from the Node process. If `ExecOptions.resumeJournal` is supplied, the
manager sorts and copies the exact entries—including synthetic checkpoint replies—into the new run
before that save. Replay hits do not emit journal callbacks, so this seeding is what makes the child
run independently resumable after a second pause or process loss. Each later live journal append
persists the complete inherited prefix plus suffix. A dead owner's persisted `pending` or `running`
run reconciles under its lease to `paused` with `pauseReason: "interrupted"` during construction or
a cold inspect/list/resume lookup. Live and permission-protected owner PIDs remain untouched.
Completed current-format crash-journal entries use identity replay; an in-flight unjournaled call
executes again on resume. Missing terminal-environment capture is diagnostic only.

`cancelAgentCall(runId, callIndex)` targets one uniquely matching live attempt. It aborts that
attempt with recoverable `AGENT_CANCELLED`, races backend cooperation so an ignored signal still
settles, bypasses retries, and resolves only after the failed call record and `agentEnd` state are
committed. The script receives `null`; sibling branches continue, the run-level signal and
`abortSignaled` remain untouched, and no journal result is created. Errors for missing, settled,
checkpoint, or duplicate scoped indexes list the currently in-flight call-index/label pairs.

Inspect a run without executing it:

```ts
const status = manager.inspectRun(result.runId, {
  lastN: 10,
  labelGlob: "review-*",
  logLines: 20,
});
```

`inspectRun()` is synchronous and live-first: it projects the manager's freshest in-memory snapshot
and journal, then falls back to the same project-scoped persistence used by resume. A cold persisted
`pending`/`running` row may be lease-reconciled to `paused` / `interrupted` when its owner is dead;
all other inspection is non-mutating. It returns `undefined` for a missing/unreadable ID. `lastN` defaults to 20 (1–50),
`logLines` defaults to 20 (0–50), and `labelGlob` is a case-sensitive whole-label glob where `*`
matches zero or more Unicode code points, `?` matches one, and backslash escapes the next character
(a trailing backslash is literal). Filtering precedes latest-N selection; calls are returned in
ascending call-index order.

The `WorkflowRunStatus` projection includes the run's resolved limits and, for a new-run resume,
its bounded `replayEligibility` admission/progress summary. Agent call rows include their
resolved per-attempt `timeoutMs` and terminal `errorCode`, which keeps failures such as
`AGENT_TIMEOUT` and `AGENT_CANCELLED` visible even though they have no result journal row. The
projection is allowlisted:
it never exposes script, args, prompts,
histories, journal hashes, session IDs, cwd, checkpoint text/defaults, auth context, or raw results.
Text and result previews are redacted and capped at 512 UTF-8 bytes; results are structurally
compacted; at most 64 phases are considered; and the serialized status is capped at 24,576 bytes
by dropping oldest calls, then logs, then phases. `truncation` reports every selection, shortening,
redaction, and byte-budget decision.

Or call the bare engine function (no manager, no persistence layer):

```ts
import { runWorkflow } from "@automatalabs/workflow-engine";

const run = await runWorkflow(script, { agent: myRunner, args: { topic: "otters" } });
console.log(run.result, run.agentCount, run.durationMs);
```

`runWorkflow` returns the `EngineRunResult` (meta / result / logs / phases / agentCount /
durationMs / runId / tokenUsage / resolved `effectiveLimits` / optional `agentSessions`, `fallbacks`, and `checkpointsTaken`). `WorkflowManager` stamps the terminal
`status` / `reason` / `resetHint` on top to produce a `WorkflowRunResult`.

## The script DSL

Inside a workflow body these are available as globals (no imports):

- `agent(prompt, opts?)` — run one subagent. `opts` includes `label`, `phase`, `schema`
  (typebox → validated object), `model`, `mode`, `tier`, `agentType`,
  `isolation: "worktree"`, legacy replay-neutral `resume: { filesystem: "read-only" }`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`,
  `keepSession`, `timeoutMs`, `retries`. The single call into your `AgentRunner`.
- `parallel([() => agent(...), ...])` — run thunks concurrently (bounded by the run's
  concurrency limiter).
- `pipeline(items, stage1, stage2, ...)` — map each item through ordered stages.
- `workflow(nameOrScript, args?)` — run a saved/inline workflow inline (one level deep),
  sharing the parent run's caps and budget.
- `checkpoint(prompt, opts?)` — a deterministic, journaled human-in-the-loop gate
  (resolved via the host's live `confirm`; headless defaults to `default ?? true`, can abort
  with `headless: "abort"`, or durably pause with `headless: "pause"`).
- Quality combinators built on the above: `verify`, `judgePanel`, `loopUntilDry`,
  `completenessCheck`, `retry`, and `gate`. A fulfilled `gate` returns
  `{ ok, value, verdict, attempts }`, where `value` is the final producer result and
  `verdict` is the exact last validator return. Its inner `agent()` calls are journaled;
  the aggregate gate result is not a separate journal entry.
- `phase(title, { budget? })`, `log(msg)`, and the read-only `args`, `cwd`, `budget`.

The realm is hardened for determinism: `Math.random()`, `Date.now()`, and `new Date()`
throw, so a re-run reproduces the journaled values. Pass any timestamps/randomness in via
`args`.

## Resume & token budget

Every `agent()` / `checkpoint()` result is journaled by a deterministic call index. For
edited-script/current-args resume, name a terminal persisted source on a **new** manager run:

```ts
const first = await manager.runSync(script, { topic: "otters" });
const again = await manager.runSync(script, { topic: "otters", expanded: true }, {
  resumeFromRunId: first.runId,
  resumePolicy: "auto", // default; "positional" is the migration escape hatch
});
console.log(again.replayEligibility, again.resumeReport);
```

The manager admits exact cwd plus compatible format/metadata/manifest state, persists the candidate seed, and
then matches completed results by exact path/hash or unique hash+input fingerprint. Allocated calls that
halt without a result are persisted as engine interruption rows; non-result seed blockers make those
occurrences run live without letting an identical result sibling become spuriously unique. Any
uncertain, ambiguous, or mismatched call runs live. Same-ID `manager.resume(runId)` and
manual `resumeJournal` remain permanently legacy positional paths. Full types, reports, reason
catalogs, and checkpoint source-index rules are in the
[incremental resume API](../../docs/api.md#content-addressed-incremental-resume).

The call identity hashes authored behavior; the separate input fingerprint covers label, per-call
cwd/isolation/session/tool inputs, metadata, and approved backends. Host `agentTimeoutMs`,
`agentRetries`, and `concurrency`, plus per-call `timeoutMs` and `retries`, are operational and enter
neither hash. Captured start/terminal environment values, current environment, Node, and V8 are
provenance only and never gate matching. Reporting compares the recorded terminal environment (or
start environment when no terminal capture exists) with the current environment. A current-format crash snapshot reconciled to
`paused` / `interrupted` uses its identity manifest even without terminal environment capture.
Input-fingerprint formats below 2 use the named
`inputs-format-legacy` positional bridge, including ancestor-scoped prefixes carried by ≤0.23 resume
hops when the ancestor run is still persisted. The persisted producing engine version is diagnostic only. Background admission,
inspection, polling, and terminal results expose the same eligibility strategy, predicted/observed
prefix, first non-replay, version formats, runtime/environment provenance changes, and operational differences.

Separately from replay correspondence, the manager builds a `PreparedContinuation` from a
usage/auth-paused snapshot's coherent root `calls[]` × `agents[]` join. Both new-run and same-ID
resume paths thread it to the live boundary. On attempt one, an exact call-index/hash/input/cwd
match that is not worktree-isolated passes the recorded session ref to the runner; every failed
gate runs fresh and emits a guarded `kind: "continuation"` notice with its exact reason. Candidates
carry their persisted input format so format-1 interrupted sessions are checked with the legacy
fingerprint (including its historical retry/timeout fields) rather than compared to incompatible
format-2 bytes. Unsupported formats and changed semantic inputs still run fresh. Candidates
are rebuilt per execution, so multiple new-run consumers may independently reopen the same paused
source session. Nested workflows receive no continuation channel.

Inside a script, a compact journal-replay fan-out looks like:

```js
const [audit, experiment] = await parallel([
  () => agent("Audit src/api without changing files.", {
    label: "audit:api",
  }),
  () => agent("Try the worker fix in isolation; return a unified diff.", {
    label: "try:worker", isolation: "worktree",
  }),
]);
```

The worktree and its edits are discarded; return the diff as data. Both calls replay from matching
journal rows without a filesystem-safety declaration.

`tokenBudget` caps total spend (per-phase sub-budgets via `phase(title, { budget })`);
`maxAgents`, `concurrency`, `agentTimeoutMs`, and `agentRetries` bound the run. `agentTimeoutMs` is a
total wall-clock ceiling for each attempt. A finite per-call `timeoutMs` can tighten the ceiling but
cannot raise or disable it; with no host ceiling, per-call `null`/omission is uncapped. Every retry
gets a fresh clock (at most `(retries + 1) × timeout`, with retries clamped to 3). Exhaustion is a
recoverable `AGENT_TIMEOUT`, so the call settles to `null` and frees its concurrency slot. The ACP
runner cancels the session and closes/recycles a child that does not honor cancellation. Defaults
are exported as `MAX_AGENTS_PER_RUN`, `MAX_CONCURRENCY`, `MAX_AGENT_RETRIES`, and
`DEFAULT_AGENT_TIMEOUT_MS`.

New resume executions resolve limits from their own `ExecOptions`; they do not inherit the source
run's values. Pass operational bounds again when constructing a resume; changing them does not
invalidate replay or interrupted-turn continuation.

`WorkflowManager` persists run state under `~/.agentprism/workflows` by default. Hosts can
set `new WorkflowManager({ persistenceRoot: "/absolute/data/root" })`; when omitted,
`AGENTPRISM_PERSISTENCE_ROOT` is used, then the homedir default. The root must be absolute.
Hosts that own storage can instead pass `new WorkflowManager({ persistence })` with a custom
`RunPersistence`. Set `journaling: false` on the manager or per `runSync`/`startInBackground`
call when the host owns transcript storage. That mode writes no engine run-state/log journal
files and otherwise preserves run results, events, retries, status transitions,
cross-process leases, and listing of persisted runs written by other executions; resume is
intentionally unavailable and rejects with `journaling disabled for this run` for those runs.
The manager-level `journal` event still emits live `{ runId, entry }` observations when file
journaling is disabled.

Token accounting is observable before settlement. `WorkflowRunOptions.onTokenUsage`, the manager's
`tokenUsage` event, and `snapshot.tokenUsage` receive fresh cumulative totals after every live agent
attempt, including retry failures and terminal pause/failure attempts. Provider usage fields are
reported when available; `total` uses the established prompt/result estimate fallback otherwise.
Replayed calls emit/add nothing. Successful completion keeps the final callback, so an unchanged
last value may be emitted twice, and persistence records the latest cumulative snapshot at journal
and terminal writes.

Successful journal writes now include optional replay-neutral `JournalEntry.call` attribution.
Agent entries record the final label/phase/resolved model/actual backend; checkpoint and synthetic
checkpoint-reply entries record checkpoint kind/label/phase. Old entries remain readable and hashes
are unchanged. Terminal persisted states retain a safe run-level `reason` and `errorCode` for cold
inspection. Every paused, failed, or aborted `WorkflowRunResult` has a redacted final-20 `logTail`
(present even when empty); completed results omit it and preserve the full raw `logs` array.

Two optional terminal audit arrays are persisted alongside that state. `fallbacks` records
continuation reattach/skip outcomes (and remains compatible with model/modifier entries); model
selection itself emits no entries because harness errors propagate through the existing
agent-error path.
`checkpointsTaken` records each checkpoint
that resolved in this execution with its journaled decision and source: `live`, `headless-default`,
`journal-replay`, or `injected` from `checkpointReplies`. Pausing checkpoints are omitted. Both
arrays are absent when empty, stay outside call hashes, and are deliberately excluded from
`WorkflowRunStatus`.

The manager treats `PROVIDER_USAGE_LIMIT`, `AUTH_REQUIRED`, and `CHECKPOINT_REQUIRED` as resumable
pause conditions rather than failed runs. An authentication pause uses `reason: "auth_required"`
and carries only the non-secret `authContext`; complete authentication through the injected runner,
then resume the same journal. Checkpoints still default to non-blocking headless behavior: with no
live `confirm`, they take `default ?? true`, while `headless: "abort"` aborts. The opt-in
`headless: "pause"` mode instead persists `reason: "checkpoint_required"` plus the non-secret
`checkpointContext`; resume with `ExecOptions.checkpointReplies[callIndex]`, or supply a live
`confirm`. The reply is inserted into the journal and replayed, so later cold resumes do not ask
again. A detached run therefore never hangs or pauses for a checkpoint unless its author explicitly
chooses `headless: "pause"`.

When a runner reports `onSessionOpen`, the engine records the non-secret re-attach handle on the
journal entry and in `WorkflowRunResult.agentSessions`. Auth/usage failures truthfully record
`keptOpen: true` even without authored `keepSession`. A successful managed continuation journals
the reattach method as diagnostic metadata, preserves it across replay/event projection, and debits
only the continuation turn's reported usage. Scripts still cannot request reattach; the manager owns
the resume directive and custom runners may decline it by running fresh.

## Durable run-event log

Journaling runs use the existing project-scoped `runsDir` and one structured sidecar:

```text
<runsDir>/<runId>.json          # atomic resumable snapshot
<runsDir>/<runId>.json.bak      # best-effort snapshot backup
<runsDir>/<runId>.log           # unstructured engine log
<runsDir>/<runId>.events.jsonl  # bounded, redacted run events
```

`createRunPersistence()` and `manager.getPersistence()` return `RunEventPersistence`, an additive
subtype of `RunPersistence`. A snapshot carries `eventStreamId` plus the highest reflected
`eventSeq`; read the snapshot, consume the suffix after that watermark, then watch from the returned
cursor while pinning the same stream generation:

```ts
const persistence = manager.getPersistence();
const snapshot = persistence.load(runId);
if (!snapshot?.eventStreamId || snapshot.eventSeq === undefined) {
  throw new Error("run has no durable event stream");
}

const page = persistence.readEvents(runId, {
  streamId: snapshot.eventStreamId,
  after: snapshot.eventSeq,
  limit: 100,
});
for (const record of page.events) consume(record);

const stream = persistence.watchEvents(runId, {
  streamId: page.streamId,
  after: page.cursor,
  signal,
});
for await (const record of stream) consume(record);
```

`readEvents()` returns `{ events, streamId, cursor, endCursor, hasMore }` (default limit 100,
maximum 1000). `watchEvents()` validates synchronously, yields backlog before new appends, and
returns a pull-based `RunEventStream`; abort, `close()`, and `return()` end it normally. The stream
does not auto-close on completion/pause/error because the run may resume. Every continuation must
pass the prior stream ID so delete/recreate of the same `runId` fails with `STREAM_MISMATCH` instead
of joining generations.

Lifecycle, call, usage, and authored-log events persist by default; `agentHistory` and the SDK-only
ACP `agentEvent` stream remain live-only. Records are projected at write time, capped at 65,536
UTF-8 bytes including LF, and have no raw-reader bypass. A corrupt, inconsistent, legacy, or marked
incomplete sidecar raises `RunEventLogError`; snapshot/journal recovery remains independent. See
[`docs/api.md`](../../docs/api.md#durable-run-event-log) for the complete policy and error/remedy
table.

Exactly one writer per run is required. `WorkflowManager` holds the cross-process run lease around
publication and deletion; custom/direct callers of `appendEvent()`, `save()`, or `delete()` must
provide equivalent exclusion. `deleteRun()` removes the sidecar before the snapshot while holding
that lease, preventing detached callbacks or a competing process from recreating durable state.

## Key exports

From `@automatalabs/workflow-engine` (see `src/index.ts`):

- **Engine** — `runWorkflow`, `parseWorkflowScript`; types `EngineRunResult`,
  `WorkflowRunOptions`, `AgentOptions`, `CheckpointOptions`, `WorkflowAgentOptions`,
  `WorkflowAgentAttemptControl`, `SharedRuntime`; `RESUME_FALLBACK_REASONS`, `RESUME_DISABLED_REASONS`,
  `RESUME_CALL_LIVE_REASONS`, `RESUME_CALL_FAILED_REASONS`, `PreparedContinuation`,
  `ContinuationCandidate`, and the resume policy/report/replay-eligibility types.
- **Manager & persistence** — `WorkflowManager` (`WorkflowManagerOptions`, `ExecOptions`,
  `ManagedRun`, `WorkflowAgentCallCancellation`); `createRunPersistence`, `generateRunId`, and
  types `RunPersistence`, `RunEventPersistence`, `RunEventStream`, `RunLease`, `RunStatus`, `PersistedRunState`,
  `PersistedAgentState`, `FsLayer`; `readEvents()`/`watchEvents()` options/results/errors; safe
  `inspectRun()` and the `WorkflowRunStatus` / inspection / log-tail / call / truncation contracts.
- **Saved workflows** — `openWorkflowDir` and the `WorkflowDir` / `WorkflowDirEntry` /
  `OpenWorkflowDirOptions` types.
- **Errors** — `WorkflowError`, `WorkflowErrorCode`, `isWorkflowError`, `wrapError`,
  `isProviderUsageLimit`, `isAuthRequired`, `isAbortError`, `isTimeoutError`,
  `ProviderUsageLimitContext`, `AuthErrorContext`, and `CheckpointContext`.
- **Config caps** — `MAX_AGENTS_PER_RUN`, `MAX_CONCURRENCY`, `MAX_AGENT_RETRIES`,
  `DEFAULT_AGENT_TIMEOUT_MS`, `AGENTS_DIR`.
- **Model routing / tiers** — `parseModelRoutingFromMeta`, `resolveModelForPhase`,
  `buildDefaultTierConfig`, `loadModelTierConfig`, `saveModelTierConfig`,
  `resolveTierModel`, `sortedTierNames`, `getModelTierConfigPath`.
- **Agent registry** (`agentType` definitions) — `loadAgentRegistry`, `resolveAgentType`,
  `parseAgentDefinition`, `applyToolPolicy`, `agentDefinitionKey`, `listAgentTypes`.
- **Worktree isolation** — `createWorktree`, `removeWorktree`, type `Worktree`.
- **Display / snapshots** — `preview`, `renderWorkflowText`, `renderWorkflowLines`,
  `createWorkflowSnapshot`, `recomputeWorkflowSnapshot`, `statusIcon`, `shorten`.
- **Paths / logger / frontmatter** — `workflowProjectPaths`, `workflowHomeDir`,
  `workflowUserSavedDir`, `workflowProjectKey`, `AGENTPRISM_PERSISTENCE_ROOT_ENV`,
  `createWorkflowLogger`, `parseFrontmatter`.
- **Seam re-exports** (from `@automatalabs/shared-types`) — `AgentRunner`, `RunOptions`,
  `AgentResult`, `AgentUsage`, `WorkflowMeta`, `WorkflowRunResult`, `WorkflowRunFallback`,
  `WorkflowCheckpointTaken`, `WorkflowCheckpointSource`, `JournalEntry`,
  `TokenUsage`, …

## License

Apache-2.0
