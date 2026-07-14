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
const terminal = await promise; // rejects for pause, failure, or abort
```

`startInBackground()` returns only after lease acquisition and its fail-fast initial save; it is
detached from the caller, not from the Node process. If `ExecOptions.resumeJournal` is supplied, the
manager sorts and copies the exact entries—including synthetic checkpoint replies—into the new run
before that save. Replay hits do not emit journal callbacks, so this seeding is what makes the child
run independently resumable after a second pause or process loss. Each later live journal append
persists the complete inherited prefix plus suffix. After a crash, stale persisted `running` runs
recover to `paused`; in-flight unjournaled work may execute again on resume.

Inspect a run without executing or leasing it:

```ts
const status = manager.inspectRun(result.runId, {
  lastN: 10,
  labelGlob: "review-*",
  logLines: 20,
});
```

`inspectRun()` is synchronous, read-only, and live-first: it projects the manager's freshest
in-memory snapshot and journal, then falls back to the same project-scoped persistence used by
resume. It returns `undefined` for a missing/unreadable ID. `lastN` defaults to 20 (1–50),
`logLines` defaults to 20 (0–50), and `labelGlob` is a case-sensitive whole-label glob where `*`
matches zero or more Unicode code points, `?` matches one, and backslash escapes the next character
(a trailing backslash is literal). Filtering precedes latest-N selection; calls are returned in
ascending call-index order.

The `WorkflowRunStatus` projection is allowlisted: it never exposes script, args, prompts,
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
durationMs / runId / tokenUsage / optional `agentSessions`). `WorkflowManager` stamps the terminal
`status` / `reason` / `resetHint` on top to produce a `WorkflowRunResult`.

## The script DSL

Inside a workflow body these are available as globals (no imports):

- `agent(prompt, opts?)` — run one subagent. `opts` includes `label`, `phase`, `schema`
  (typebox → validated object), `model`, `mode`, `tier`, `agentType`,
  `isolation: "worktree"`, `cwd`, `mcpServers`, `images`, `meta`, `promptMeta`,
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

Every `agent()` / `checkpoint()` result is journaled by a deterministic call index. Feed
the journal back (and the prior `runId`) to replay the unchanged prefix and only re-run
what changed:

```ts
const first = await runWorkflow(script, { agent: myRunner, args, onAgentJournal: save });
// ...later, after an edit or a usage-limit pause:
const resumeJournal = new Map(/* index -> { index, hash, result } */);
const again = await runWorkflow(script, { agent: myRunner, args, resumeJournal, resumeFromRunId: first.runId });
```

`tokenBudget` caps total spend (per-phase sub-budgets via `phase(title, { budget })`);
`maxAgents`, `concurrency`, `agentTimeoutMs`, and `agentRetries` bound the run. Defaults
are exported as `MAX_AGENTS_PER_RUN`, `MAX_CONCURRENCY`, `MAX_AGENT_RETRIES`, and
`DEFAULT_AGENT_TIMEOUT_MS`.

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
journal entry and in `WorkflowRunResult.agentSessions`. `agent({ keepSession: true })` is forwarded
to the runner so an ACP implementation can skip release-time `session/close`; re-attaching is a
host/runner responsibility, not an in-script DSL operation.

## Key exports

From `@automatalabs/workflow-engine` (see `src/index.ts`):

- **Engine** — `runWorkflow`, `parseWorkflowScript`; types `EngineRunResult`,
  `WorkflowRunOptions`, `AgentOptions`, `CheckpointOptions`, `WorkflowAgentOptions`,
  `SharedRuntime`.
- **Manager & persistence** — `WorkflowManager` (`WorkflowManagerOptions`, `ExecOptions`,
  `ManagedRun`); `createRunPersistence`, `generateRunId`, and types `RunPersistence`,
  `RunLease`, `RunStatus`, `PersistedRunState`, `PersistedAgentState`, `FsLayer`; safe
  `inspectRun()` and the `WorkflowRunStatus` / inspection / log-tail / call / truncation contracts.
- **Saved workflows** — `openWorkflowDir` and the `WorkflowDir` / `WorkflowDirEntry` /
  `OpenWorkflowDirOptions` types.
- **Errors** — `WorkflowError`, `WorkflowErrorCode`, `isWorkflowError`, `wrapError`,
  `isProviderUsageLimit`, `isAuthRequired`, `classifyProviderLimit`, `isAbortError`,
  `isTimeoutError`, `AuthErrorContext`, and `CheckpointContext`.
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
  `AgentResult`, `AgentUsage`, `WorkflowMeta`, `WorkflowRunResult`, `JournalEntry`,
  `TokenUsage`, …

## License

Apache-2.0
