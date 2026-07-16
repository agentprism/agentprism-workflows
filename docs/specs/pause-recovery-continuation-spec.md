# Pause-recovery Session Continuation

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #183. Verified against base commit
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pause-recovery-continuation`, based on
`origin/main`). Every file:line citation in this document was read at that SHA; see §9.

**References (files):** `packages/shared-types/src/agent-run.ts`;
`packages/shared-types/src/workflow-result.ts`; `packages/shared-types/src/errors.ts`;
`packages/acp-agents/src/runner.ts`; `packages/acp-agents/src/acp-client.ts`;
`packages/acp-agents/src/pool.ts`; `packages/workflow-engine/src/workflow.ts`;
`packages/workflow-engine/src/workflow-manager.ts`; `packages/workflow-engine/src/resume.ts`;
`packages/workflow-engine/src/resume-matcher.ts`; `packages/workflow-engine/src/run-persistence.ts`;
`packages/workflow-engine/src/run-event-persistence.ts`.

---

## 1. Problem

When a run pauses mid-`agent()`-call on `PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED`, the interrupted
call never journals — the journal records only calls that returned a value (`outcome: "result"`),
and an interrupted call settles as `outcome: "error"`. On resume, that call comes up live again and
re-runs from scratch in a fresh `session/new`. Every token the agent spent before hitting the wall —
file reads, tool calls, partial reasoning — is spent again. For long coding-agent turns interrupted
near the end, that is close to a full duplicate of the call's cost.

The substrate to finish the interrupted turn instead of restarting it already exists and is
persisted:

- **The re-attach handle is captured before the first prompt and survives an error settle.**
  `AcpAgentRunner.run()` fires `onSessionOpen` right after the session opens and before any turn runs
  (`runner.ts:820-824`), handing the engine an `AgentSessionRef` — `{ sessionId, backendId, cwd,
  reopen: { load, resume, list, fork } }` (`workflow-result.ts:71-90`) whose `reopen` flags mirror
  what the connected agent advertised at initialize (`sessionRefFor`, `runner.ts:1375-1388`). The
  engine copies that ref into the call's attempt slot (`workflow.ts:1235-1239`) and, on **every**
  terminal transition including error settles, seals it into the per-agent snapshot
  (`emitFailure` → `state.agentSessions.push(session)`, `workflow.ts:1134-1135`, via `sessionRecord`,
  `workflow.ts:1111-1119`).

- **The reopen path costs zero inference tokens.** The runner already serves capability-gated
  `session/load` (with transcript replay) and `session/resume` (without replay) as
  `loadSession`/`resumeSession` (`runner.ts:693-697`, `runner.ts:714-717`); the pooled connection
  drives them (`acp-client.ts:1554-1560`) and refuses them before any wire request when the backend
  did not advertise the capability (`assertLifecycleSupported`, `acp-client.ts:1220-1234`). Reopen is
  served from the agent's own on-disk session store, not by re-running the turn.

- **Pause classification is already precise and durable.** `WorkflowManager` maps
  `PROVIDER_USAGE_LIMIT` → pause reason `usage_limit` and `AUTH_REQUIRED` → `auth_required`
  (`runReason`, `workflow-manager.ts:317-325`), marks the run `paused` (never `failed`), and persists
  the full snapshot — including `agents[].session` — to disk before releasing
  (`persistRun` in the pause `beforeLive` hook, `workflow-manager.ts:1360-1373`; agents projected at
  `workflow-manager.ts:1627`; `PersistedAgentState.session` at `run-persistence.ts:57`).

The missing piece is the connection: on resume, when the interrupted call comes up live again with an
unchanged identity hash, reattach to its recorded session and ask the agent to **continue** the
interrupted turn rather than restarting it.

Two facts about the existing resume machinery shape how continuation must be wired, and both are
load-bearing:

1. **The resume seed cannot carry the continuation candidate.** The manager's resume seed is built
   exclusively from `outcome === "result"` journal rows (`resume-matcher.ts:878-884`). The
   interrupted call is `outcome: "error"` and is excluded by design. Continuation therefore needs a
   **new, additive manager→engine channel**, distinct from the seed.

2. **A pause-class resume runs the positional (not identity) correspondence strategy.** The
   interrupted `outcome: "error"` call makes `allCallsRepresented` false
   (`resume-matcher.ts:827-829`; the pending-representation exception covers only
   `checkpoint_required`), which selects `fallbackReason: "unsafe-recording"` and a
   `positional-v1` strategy at `safe-prefix` eligibility (`resume-matcher.ts:847-868`). This is
   **orthogonal to continuation**: both `identity-v1` and `positional-v1` resolve a journal-miss to
   the same live executor, `runLive()` (`workflow.ts:1684` and `workflow.ts:1759`), where the call
   re-runs live with its unchanged hash. Continuation is served at that live boundary and does not
   depend on which correspondence strategy the resume chose.

3. **Session refs reach disk only through the `PersistedRunState` snapshot.** The append-only
   event-log projections deliberately drop `session` from both the agent-end and journal events
   (`run-event-persistence.ts:536` and `run-event-persistence.ts:555`). The continuation candidate
   map must therefore be built from the snapshot's `agents[]` array, **never** from the event stream.

**Continuation is a cheaper way to finish an interrupted live call. It never changes what a call
*is*.** The call's identity hash (`hashAgentCall`, `workflow.ts:2949-2977`), journal semantics, and
replay eligibility are untouched — same prompt, same hash; continuation only changes how the live
execution reaches its result. Every uncertainty falls back to a fresh `session/new` + original
prompt (fail-to-fresh), mirroring the engine's fail-to-live posture: a skipped continuation costs
tokens, never correctness.

---

## 2. The contract

### 2.1 Verified baseline and invariants

The implementation preserves these named invariants. Each has a test in §7.

1. **Unchanged hash bytes.** `hashAgentCall()` continues to hash, in its existing serialization,
   prompt, resolved model, `mode` only when set, sorted non-empty `configOptions`, tier, phase,
   agentType, resolved agent definition, and schema (`workflow.ts:2954-2974`). Nothing continuation
   adds — the `continueFromSession` reattach directive, the runner-internal continuation instruction,
   the recorded session ref, the reattach method, or any provenance/observability marker — is a hash
   input. Pinned hash fixtures do not change.

2. **Fail-to-fresh.** Every continuation eligibility gate (§2.8) and every runner-side reattach step
   (§2.5) that is not fully satisfied discards the continuation attempt and runs the call fresh
   (`session/new` + the original prompt) within the *same* `run()` invocation. A skipped or failed
   continuation never returns a guessed result, never aborts the call, and never changes the call's
   journaled identity.

3. **Continuation is strategy-independent.** A continued call is served at the `runLive()` live
   boundary (`workflow.ts:1684`, `workflow.ts:1759`), which both `identity-v1` and `positional-v1`
   resume strategies reach on a journal miss. The candidate is carried on the `PreparedResume` the
   manager emits for the source run regardless of the correspondence strategy that resume selected.

4. **Candidate data comes only from the persisted snapshot.** The continuation candidate map is built
   by joining `PersistedRunState.calls[]` (`run-persistence.ts:173`) to `PersistedRunState.agents[]`
   session refs (`run-persistence.ts:57`) on `callIndex`. It is never built from the event log, which
   projects `session` away (`run-event-persistence.ts:536`, `:555`).

5. **A continued call journals exactly like a fresh live call.** Same hash, current index,
   runner origin, its (reattached) session ref recorded through the ordinary `onSessionOpen` flow,
   and real continuation-turn usage debited against the budget. The only additions are diagnostic and
   non-identity (§2.9): a durable `continuation` marker on the journal call metadata and a transient
   provenance report.

6. **Default-on, zero configuration.** Continuation is the live-path behavior on every resume of a
   `usage_limit`/`auth_required`-paused run. There is no opt-in flag, no per-call toggle, and no
   resource cap. `@automatalabs/workflows` and `@automatalabs/mcp-server` take no new inputs and pick
   the behavior up transitively.

### 2.2 The continuation candidate (data model)

A **continuation candidate** is the join of one interrupted call's structural record with its
persisted session ref:

```ts
// packages/workflow-engine/src/resume.ts (new, engine-internal)
export interface ContinuationCandidate {
  /** The interrupted call's identity hash (WorkflowCallRecord.hash). Map key. */
  readonly hash: string;
  /** The re-attach handle sealed on the error settle (PersistedAgentState.session). */
  readonly sessionRef: AgentSessionRef;
  /** The interrupted call's recorded execution directory (WorkflowCallRecord.resolvedCwd,
   *  falling back to sessionRef.cwd). Absolute. */
  readonly recordedCwd: string;
  /** The interrupted call's recorded terminal backend id (WorkflowCallRecord.backendId,
   *  falling back to sessionRef.backendId). */
  readonly backendId: string;
  /** The source run the candidate came from (diagnostics only). */
  readonly sourceRunId: string;
}

/** The additive manager→engine channel. Keyed by identity hash; a hash present here has
 *  exactly one interrupted, reopenable candidate. Ambiguous hashes are dropped at build
 *  time and instead recorded in `ambiguousHashes` for observability. */
export interface PreparedContinuation {
  readonly candidatesByHash: ReadonlyMap<string, ContinuationCandidate>;
  readonly ambiguousHashes: ReadonlySet<string>;
}
```

`AgentSessionRef` and its `reopen` surface are unchanged (`workflow-result.ts:71-90`). The candidate
carries no secrets and is JSON-round-trippable — it is a projection of already-persisted data.

### 2.3 Additive `shared-types` surface

All fields below are additive and JSON-round-trippable; none is a `hashAgentCall` input.

**(a) `RunOptions.continueFromSession`** — `packages/shared-types/src/agent-run.ts`, added
immediately after `onSessionOpen` (`agent-run.ts:198-204`):

```ts
  /** RESUME-ONLY reattach directive. When set, the runner attempts to reopen this exact
   *  ACP session (via session/resume, else session/load) and CONTINUE the interrupted turn
   *  instead of opening a fresh session/new. Advisory: a runner that ignores it — or any
   *  reattach failure — runs the call fresh, which IS the fallback. ADDITIVE and NOT part of
   *  the resume identity hash (hashAgentCall): it changes how a live call reaches its result,
   *  never the logical call. Omitted => today's fresh session/new + original-prompt path. */
  continueFromSession?: AgentSessionRef;
```

**(b) `AgentResultProvenance` continuation attempt** — `packages/shared-types/src/agent-run.ts`,
extending the `"live"` arm (`agent-run.ts:33-41`):

```ts
export type ContinuationAttempt =
  | { reattached: true; method: "resume" | "load" }
  | { reattached: false; reason: ContinuationSkipReason };

export type AgentResultProvenance =
  | { source: "live"; overrideModel?: string; continuation?: ContinuationAttempt }
  | { source: "replay"; recordedRunId?: string; recordedIndex?: number; hashMatched?: boolean };
```

The base `AcpAgentRunner` reports this through the existing `onResultProvenance` callback **only when
`continueFromSession` was supplied** (otherwise it reports nothing, exactly as today, and the engine
infers ordinary live provenance).

**(c) `ContinuationSkipReason`** — `packages/shared-types/src/agent-run.ts` (new export). The closed
set of reasons a continuation was not served when a candidate existed for the call's hash:

```ts
export type ContinuationSkipReason =
  // engine-side gates (§2.8) — candidate existed but a gate rejected it, no reattach attempted:
  | "cwd-mismatch"       // recorded cwd !== the call's resolved cwd
  | "cwd-missing"        // the call's resolved cwd does not exist on disk
  | "worktree-isolated"  // the call is worktree-isolated
  | "ambiguous-hash"     // >1 interrupted candidate shares this hash (dropped at build)
  | "already-consumed"   // an earlier live call in this execution consumed the hash's candidate
  // runner-side gates (§2.5, §2.6) — reattach attempted and abandoned before the continuation prompt:
  | "backend-mismatch"   // continueFromSession.backendId !== the resolved backend id
  | "capability-missing" // the backend advertises neither session/resume nor session/load
  | "reattach-failed";   // load/resume rejected, session gone, or a spawn/auth error before continue
```

**(d) `JournalCallMetadata` continuation marker** — `packages/shared-types/src/workflow-result.ts`,
extending the `"agent"` arm (`workflow-result.ts:136-150`):

```ts
  | {
      kind: "agent";
      label: string;
      phase?: string;
      model?: string;
      backendId?: string;
      /** Diagnostic-only: present when this result was produced by reattaching to a paused
       *  session and continuing the interrupted turn, and which reopen method reattached.
       *  NOT part of replay identity — replay restores it as-is and never consults it. */
      continuation?: { method: "resume" | "load" };
    }
```

**(e) `WorkflowRunFallback` continuation notice** — `packages/shared-types/src/workflow-result.ts`,
extending the existing model-degrade notice (`workflow-result.ts:104-119`). The type stays a flat
interface (no consumer break): a new `kind` value plus one optional detail object.

```ts
/** One notice observed while serving an agent() call: a model-selection degrade
 *  (kind "model"/"modifier") OR a continuation attempt on resume (kind "continuation"). */
export interface WorkflowRunFallback {
  callIndex: number;
  label: string;
  phase?: string;
  /** For continuation: the model/tier spec the engine asked the runner to serve on the
   *  continued call (identical to the interrupted call's — the hash proves it). */
  requestedSpec: string;
  resolvedModel?: string;
  backendId?: string;
  kind: "model" | "modifier" | "continuation";
  message: string;
  /** Present iff kind === "continuation". */
  continuation?:
    | { outcome: "reattached"; method: "resume" | "load" }
    | { outcome: "skipped"; reason: ContinuationSkipReason };
}
```

### 2.4 Runner: keep the session reopenable on a pause-class release

Today `run()`'s `finally` releases the session with `keepOpen: opts.keepSession === true`
(`runner.ts:908-910`), so a normal error closes the agent-side session. Continuation requires the
interrupted session to survive.

The change is local to `run()`:

1. Declare a release decision before the `try`: `let keepOpenOnRelease = opts.keepSession === true;`.
2. In the existing `catch` (`runner.ts:880-887`), compute the mapped error once, and if it is
   pause-class, promote the decision, then throw the same mapped error:

   ```ts
   } catch (error) {
     if (opts.signal?.aborted) throw error;
     const mapped = mapThrownError(error, { /* unchanged args */ });
     if (isProviderUsageLimitError(mapped) || isAuthRequiredError(mapped)) keepOpenOnRelease = true;
     throw mapped;
   }
   ```

   `isAuthRequiredError` already exists in the runner (`runner.ts:1428-1430`); add the sibling
   `isProviderUsageLimitError` (mirroring it against `WorkflowErrorCode.PROVIDER_USAGE_LIMIT`,
   `errors.ts:19`; or reuse the shared `isProviderUsageLimit`, `errors.ts:158`).
3. The `finally` releases with the decision: `await session.release({ keepOpen: keepOpenOnRelease });`.

Behavior contract:

- Success path: `keepOpenOnRelease` stays `opts.keepSession === true` — **unchanged**.
- Non-pause error: unchanged (closed unless `keepSession`).
- Pause-class error (`PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED`): released with `keepOpen: true`
  regardless of `keepSession`, so the agent-persisted session survives for a later reattach. The
  pooled process is released either way. For a backend that advertises no reopen capability, skipping
  the close is harmless (there is nothing to reattach; the engine builds no candidate for it, §2.7)
  and matches existing `keepSession` semantics.

### 2.5 Runner: reattach-and-continue

Add a reattach acquire path to `run()`, gated on `opts.continueFromSession`. When it is set, the
runner attempts reopen-and-continue **before** the fresh `session/new` acquire (`runner.ts:791`); on
any failure it falls through to the unchanged fresh path.

**Pool method (new).** `packages/acp-agents/src/pool.ts` gains `acquirePreparedReattach`, mirroring
`acquirePrepared` (`pool.ts:101-119`) but opening the session by reopen instead of `session/new`:

```ts
async acquirePreparedReattach(
  backend: Backend,
  sessionId: string,
  method: "resume" | "load",
  prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
  context: { signal?: AbortSignal; label?: string } = {},
): Promise<SessionHandle> {
  if (this.disposed) throw new Error("ACP agent pool is disposed");
  const connection = this.selectConnection(backend);   // same generation-gated selection as acquire
  try {
    const opts = await prepare(connection);
    return method === "resume"
      ? await connection.resumeSession(sessionId, opts)
      : await connection.loadSession(sessionId, opts);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw mapThrownError(error, { label: context.label, backendId: connection.backendId, backend,
      authMethods: connection.capabilities?.authMethods });
  }
}
```

`connection.resumeSession`/`loadSession` (`acp-client.ts:1554-1560`) already refuse before any wire
request when the negotiated capability is absent (`assertLifecycleSupported`, `acp-client.ts:1220-1234`).

**`run()` reattach path.** Inside the acquire block (replacing the single `acquirePrepared` call at
`runner.ts:791` with a guarded pair):

1. **Backend-identity gate (§2.6 `backend-mismatch`).** Resolve the call's backend from its model
   spec via the existing `prepareSession` (`prepared.backend`, `runner.ts:743`). If
   `continueFromSession.backendId !== prepared.backend.id`, do not reattach; report
   `{ reattached: false, reason: "backend-mismatch" }` and take the fresh path.
2. **Capability gate (§2.6 `capability-missing`).** Choose the reopen method, preferring resume
   (no transcript replay is needed — the agent holds the history):
   `const method = continueFromSession.reopen.resume ? "resume" : continueFromSession.reopen.load ? "load" : undefined;`
   If `method` is undefined, report `{ reattached: false, reason: "capability-missing" }` and take the
   fresh path.
3. **Reattach (§2.6 `reattach-failed`).** Call
   `this.pool.acquirePreparedReattach(prepared.backend, continueFromSession.sessionId, method, prepare, ctx)`,
   reusing the **same** `prepare` closure the fresh path uses (so structured-output MCP injection,
   `mcpServers`, and `runId` stamping are identical). If it throws for any reason — capability error,
   RPC rejection, session-gone, spawn/auth error — catch it, report
   `{ reattached: false, reason: "reattach-failed" }`, discard the failed handle, and take the fresh
   path within the same `run()` invocation. The inline auth-retry loop (`runner.ts:786-814`) applies
   to the fresh acquire, not the reattach: a reattach that hits auth is a fail-to-fresh, and the
   subsequent fresh acquire runs its normal auth handling.

**On a successful reattach**, the run proceeds through the identical post-open sequence as a fresh
run and a mirror of `createInteractiveSession`'s reattach assembly (`runner.ts:985-991`):

- `onSessionOpen` fires with the reattached session's ref (`runner.ts:820-824`) — same `sessionId`,
  the agent's advertised reopen surface — so the engine re-records the session for a possible
  next-hop continuation (§2.11).
- `applyModelSelection`, `setConfigOptions`, `setMode` run exactly as on a fresh run
  (`runner.ts:831-835`).
- The turn prompt is the **fixed continuation instruction**, not the original prompt (which is
  already in the session's history), threaded through the same `buildRunPrompt` path
  (`runner.ts:837`) so schema/structured-output guidance is applied identically. Define:

  ```ts
  // packages/acp-agents/src/runner.ts (runner-internal; NOT a hash input, wording non-normative)
  const CONTINUATION_INSTRUCTION =
    "Your previous turn was interrupted before it finished — the provider paused it for a usage " +
    "limit or expired credentials, not because the task was complete. The full task and all prior " +
    "context are already in this session's history; do not restart or repeat work you already did. " +
    "Continue from where you stopped and produce the COMPLETE final answer to the original task now.";
  ```

  The continuation turn sends `buildRunPrompt(CONTINUATION_INSTRUCTION, opts, schema, prepared.backend,
  structuredToolActive)`. Original-prompt images are **not** re-attached (they belong to the
  interrupted turn preserved in the session).
- Stop-reason assertion (`assertNormalStopReason`, `runner.ts:848`), the empty-output guard
  (`runner.ts:875-878`), and the structured-output repair ladder (`runner.ts:850-871`) run
  **unchanged**. The instruction demands the *complete* final answer precisely so a pre-pause partial
  emission cannot satisfy the extraction path.
- The runner reports provenance `{ source: "live", continuation: { reattached: true, method } }` via
  `onResultProvenance` before the attempt settles.

The `keepOpen`-on-pause rule (§2.4) applies to the continuation turn too: a **second** pause-class
error during continuation propagates normally, the run pauses again, and the (re-recorded) session is
again kept reopenable — continuation can chain across successive pauses (§2.11).

### 2.6 Runner: fail-to-fresh failure contract

Each runner-side gate discards the continuation attempt and runs the call fresh in the same `run()`.
The runner reports the reason on `AgentResultProvenance.continuation`; the engine turns it into an
observability notice (§2.10).

| Gate | Condition to reattach | On failure |
| --- | --- | --- |
| Backend identity | `continueFromSession.backendId === prepared.backend.id` | report `backend-mismatch`; fresh `session/new` + original prompt |
| Reopen capability | `reopen.resume` or `reopen.load` advertised | report `capability-missing`; fresh path |
| Reattach accepted | `resume`/`load` RPC resolves; session exists; no spawn/auth error before the continuation prompt is accepted | report `reattach-failed`; fresh path |

A continuation turn that reattaches successfully but then produces empty or schema-noncompliant
output does **not** silently retry fresh: it follows the existing live-call error paths
(`AGENT_EMPTY_OUTPUT` at `runner.ts:875-878`; `SCHEMA_NONCOMPLIANCE` via the repair ladder). A
continuation turn that hits a fresh pause-class error re-pauses (§2.5). "Fail-to-fresh" applies only
between the reattach directive and the continuation prompt being accepted.

Custom `AgentRunner` implementations that ignore `continueFromSession` run the call fresh — which is
the fallback — so no interface break and no capability negotiation at the engine seam.

### 2.7 Engine: candidate map construction (manager)

The manager builds the `PreparedContinuation` when it prepares a resume of a source run whose status
is `paused` with pause reason `usage_limit` or `auth_required`. The construction mirrors the existing
`getPersistedAgentSessions` snapshot read (`workflow-manager.ts:2088-2101`) and joins it to the call
manifest the manager already materializes for a positional resume (`managed.calls`,
`workflow-manager.ts:683-687`):

1. **Gate on pause class.** Build a map only when `source.status === "paused"` and
   `source.pauseReason` ∈ `{ "usage_limit", "auth_required" }` (`run-persistence.ts:140`). Otherwise
   attach no continuation (`checkpoint_required`, `completed`, `failed`, and `aborted` sources
   produce none — see Non-goals §4).
2. **Index the session refs by call index** from the snapshot: for each `PersistedAgentState` in
   `source.agents` (`run-persistence.ts:152`) with a `session` (`run-persistence.ts:57`), key it by
   `session.callIndex`. The interrupted call has no journal entry, so its ref is read from
   `agents[]`, never from the journal or the event stream (Invariant §2.1.4).
3. **Join to the call manifest and filter.** For each `WorkflowCallRecord` in `source.calls`
   (`run-persistence.ts:173`), keep it as a candidate iff **all** hold:
   - `record.kind === "agent"`;
   - `record.outcome === "error"` (`workflow-result.ts:326`) with
     `record.error?.code` ∈ `{ PROVIDER_USAGE_LIMIT, AUTH_REQUIRED }` (`errors.ts:98`, `errors.ts:19`,
     `errors.ts:24`);
   - a session ref exists at `record.index` and its `reopen.resume === true || reopen.load === true`
     (`workflow-result.ts:80-85`).
   Form `ContinuationCandidate` with `hash = record.hash`,
   `recordedCwd = record.resolvedCwd ?? sessionRef.cwd`,
   `backendId = record.backendId ?? sessionRef.backendId`.
4. **Resolve hash ambiguity at build time.** If two or more surviving candidates share a `hash`, drop
   that hash from `candidatesByHash` entirely and add it to `ambiguousHashes`. A hash present in
   `candidatesByHash` therefore has exactly one candidate.
5. **Attach to the emitted `PreparedResume`.** Set `preparedResume.continuation = { candidatesByHash,
   ambiguousHashes }`.

`PreparedResume` (`resume.ts:93-127`) gains an optional `continuation?: PreparedContinuation` on the
`identity-v1` and `positional-v1` arms (the two arms that execute the script and reach a live
boundary); the `live` (disabled) arm does not carry it — a fully disabled resume runs every call
fresh and continuation would add no value there. In practice a pause-class resume always resolves to
`positional-v1` (Invariant §2.1.3 / `resume-matcher.ts:827-868`), so that is where the field is
populated today; typing it on both arms keeps the engine's live-path consumption (§2.8) free of any
correspondence-strategy assumption. The manager populates it at the construction sites at
`workflow-manager.ts:641-649` (identity-v1) and `workflow-manager.ts:689+` (positional-v1).

### 2.8 Engine: live-boundary selection and eligibility gates

Consumption is per-execution mutable state, so the engine holds a local set alongside `state`:
`const consumedContinuations = new Set<string>();` (hashes consumed this execution).

In `runLive()` (`workflow.ts:1068`), after the call's execution directory `runCwd` is resolved
(`workflow.ts:1192`) and before the runner options bag is assembled (`workflow.ts:1204`), select a
candidate:

```
candidate := preparedResume?.continuation?.candidatesByHash.get(callHash)
if candidate is present AND all engine gates hold:
    mark callHash consumed; pass continueFromSession = candidate.sessionRef to agentRunner.run
else if a candidate existed for callHash but a gate rejected it (or callHash ∈ ambiguousHashes,
        or callHash already consumed):
    emit a "skipped" continuation notice (§2.10) with the gate's reason; run fresh
else:
    run fresh, no notice (the ordinary no-candidate case)
```

`continueFromSession` is added to the existing `agentRunner.run(prompt, { … })` options object
(`workflow.ts:1204-1245`) — the same additive bag that already carries `keepSession`, `onSessionOpen`,
`callIndex`, and `callHash`; it is not passed to `hashAgentCall` and not folded into `AgentOptions`,
so Invariant §2.1.1 holds by construction.

**Engine-side eligibility gates (each fails to fresh, with its own contract):**

| Gate | Condition | On failure |
| --- | --- | --- |
| Candidate present | `candidatesByHash.get(callHash)` is defined | no candidate → run fresh, no notice (unless `callHash ∈ ambiguousHashes` → notice `ambiguous-hash`) |
| Unambiguous hash | `callHash ∉ ambiguousHashes` (already enforced by the map; the set drives the notice) | notice `ambiguous-hash`; run fresh |
| Not worktree-isolated | `resolvedIsolation !== "worktree"` (`workflow.ts:1755`) | notice `worktree-isolated`; run fresh |
| Cwd equality | `candidate.recordedCwd === runCwd` | notice `cwd-mismatch`; run fresh |
| Cwd exists on disk | `runCwd` exists (`fs.existsSync(runCwd)`) | notice `cwd-missing`; run fresh |
| Unconsumed | `callHash ∉ consumedContinuations` | notice `already-consumed`; run fresh |

Rationale for the two cwd gates: call worktrees are removed at settle (`workflow.ts:1419`) and
recreated at a fresh path on resume (`createWorktree(baseCwd, \`${runId}-${callIndex}-${label}\`)`,
`workflow.ts:1184`, with a new `runId`), so a worktree-isolated call's recorded cwd is gone by
design — the `worktree-isolated` gate rejects it deterministically without relying on path
comparison. For a non-isolated call, `runCwd` is `resolvePath(baseCwd, agentOptions.cwd ?? ".")`
(`workflow.ts:1192`); the equality-and-existence pair guarantees the recorded session's directory is
the same real directory the continuation will run in.

**The backend-identity gate is enforced runner-side** (§2.6): the engine cannot resolve a model spec
to a concrete backend id — that resolution is runner-internal (`prepareSession`). Because the
candidate is keyed by identity hash, and the model spec is a hash input (`workflow.ts:2957`), a hash
match already pins the model spec; the residual risk is a host reconfiguring a backend *name* to a
different process between the paused run and the resume, which the runner catches by comparing
`continueFromSession.backendId` to `prepared.backend.id`. The engine carries the recorded `backendId`
on the candidate solely to feed that comparison.

### 2.9 Engine: journaling, provenance, and budget

A continued call settles through the ordinary live-call path — no special-casing of its identity:

- **Journal identity.** Same `hash`, current `index`, and the settle path already used for a live
  runner attempt (`origin: "runner"`). Its reattached session ref is recorded through the normal
  `onSessionOpen` → `slot.sessionRef` → `sessionRecord` flow (`workflow.ts:1235-1239`,
  `workflow.ts:1111-1119`).
- **Diagnostic marker.** When the terminal attempt's provenance (`slot.provenance`, populated from
  the runner's `onResultProvenance` report, `workflow.ts:1270`) carries
  `continuation: { reattached: true, method }`, the engine writes `continuation: { method }` onto the
  journal entry's `call` metadata (`JournalCallMetadata` agent arm, §2.3d). This marker is diagnostic
  only; it is not a `hashAgentCall` input and replay never consults it (Invariant §2.1.5). The full
  attempt outcome (including a runner-side skip) is already durably visible on the call record's
  `provenance` (`WorkflowCallRecord.provenance`, `workflow-result.ts:370`) via the extended
  `AgentResultProvenance`.
- **Budget.** The continuation turn's usage flows through the existing `onUsage` → `slot.usage` →
  budget-debit path unchanged. Pre-pause spend was reported to the paused run's telemetry, not to this
  resume; the journaled usage for a continued call covers the continuation turn as reported and — like
  all recorded usage (`workflow-result.ts:171`) — remains a documented lower bound on true spend.

### 2.10 Engine: observability notices

Continuation outcomes surface through the existing `onFallback` callback (`workflow.ts:185`,
`workflow.ts:1261`) and accumulate in `state.fallbacks` → `WorkflowRunResult.fallbacks[]`
(`workflow-result.ts:490`; persisted at `run-persistence.ts:170`) — the same channel model-selection
degrades already use. A `kind: "continuation"` notice is emitted (deduped through an extended
`sameFallback`, `workflow.ts:2573`, which for the continuation kind compares `callIndex` and the
`continuation` detail) in exactly two situations:

- **Reattached (savings realized).** On a successful continuation, from the runner's provenance
  report: `{ kind: "continuation", callIndex, label, phase?, requestedSpec, backendId?,
  continuation: { outcome: "reattached", method }, message: "continuation: reattached via
  session/<method>" }`.
- **Skipped (why there were no savings).** When a candidate existed for the call's hash but a gate
  rejected it — engine-side (from §2.8) or runner-side (from the provenance report §2.6) —
  `{ kind: "continuation", …, continuation: { outcome: "skipped", reason }, message: "continuation
  skipped (<reason>) — running fresh" }`.

No notice fires for the ordinary no-candidate live call, so continuation adds no per-call noise to
runs that were never paused. `requestedSpec` is `modelSpec ?? agentOptions.tier ?? "(default)"`,
matching the model-fallback emission (`workflow.ts:1254`).

### 2.11 Multi-hop and consumption semantics

- **Consume on first use, within one execution.** `consumedContinuations` (§2.8) ensures that when a
  script reaches the same hash more than once (e.g. an identical prompt inside a loop), only the
  first live occurrence reattaches; later same-hash live calls in the same execution run fresh with a
  `already-consumed` notice. This prevents two live calls from racing to reopen one session.
- **Correctness across resume hops comes from the persisted rebuild, not from carrying state.** Each
  resume hop rebuilds the candidate map from the latest `PersistedRunState` (§2.7). If a prior hop
  completed the continued call, the new source records it as `outcome: "result"` → no candidate. If a
  prior hop re-paused on it, the new snapshot holds the re-recorded session ref → a fresh candidate
  for the next hop. Chained continuation therefore needs no cross-hop bookkeeping.

---

## 3. Failure-contract summary

Every deviation from the happy path runs the call fresh (`session/new` + original prompt) and never
changes the call's journaled identity. Consolidated:

1. Source not paused on `usage_limit`/`auth_required` → no candidate map; every call fresh (§2.7.1).
2. Interrupted call's record is not an agent `outcome: "error"` with a pause-class code → not a
   candidate (§2.7.3).
3. Interrupted call's session ref advertises neither `reopen.resume` nor `reopen.load` → not a
   candidate (§2.7.3).
4. Two interrupted candidates share a hash → hash dropped; notice `ambiguous-hash` (§2.7.4, §2.8).
5. Call is worktree-isolated → notice `worktree-isolated` (§2.8).
6. Recorded cwd ≠ resolved cwd → notice `cwd-mismatch` (§2.8).
7. Resolved cwd absent on disk → notice `cwd-missing` (§2.8).
8. Hash already consumed this execution → notice `already-consumed` (§2.8, §2.11).
9. Resolved backend id ≠ recorded backend id → notice `backend-mismatch` (§2.6).
10. Backend advertises neither reopen method → notice `capability-missing` (§2.6).
11. `resume`/`load` RPC rejected, session gone, or spawn/auth error before continue → notice
    `reattach-failed` (§2.6).
12. Continuation turn produces empty/noncompliant output → existing live-call error paths, no silent
    fresh retry (§2.6).
13. Continuation turn hits a fresh pause-class error → re-pause; session kept reopenable (§2.5, §2.11).

---

## 4. Non-goals (v1)

- **Killed-process recovery.** A crash/SIGKILL mid-turn never runs the pause-class release path
  (§2.4), so no `keepOpen: true` release fires and what the agent's persisted session contains at the
  kill point is backend-dependent. v1 scopes to graceful `usage_limit`/`auth_required` pauses only.
- **Durable-checkpoint pauses.** A `headless: "pause"` checkpoint pause (`CHECKPOINT_REQUIRED`,
  `errors.ts` / pause reason `checkpoint_required`, `workflow-manager.ts:320`) happens *between* turns
  at a checkpoint — there is no interrupted agent turn to continue, and `runReason` does not classify
  it as `usage_limit`/`auth_required`, so §2.7.1 produces no candidate for it.
- **Worktree-isolated calls.** Excluded by the cwd/worktree gate (§2.8): the recorded worktree is
  removed at settle and recreated at a fresh path on resume.
- **Any change to call identity, replay identity, or the incremental-resume correspondence rules.**
  Continuation applies only to a call already running live; the `hashAgentCall` bytes
  (`workflow.ts:2954-2974`), journal semantics, resume-matcher policy selection
  (`resume-matcher.ts:827-868`), and every other call's replay eligibility are computed exactly as
  before.

---

## 5. Rejected alternatives

1. **Piggyback the continuation candidate on the resume seed.** Rejected: the seed is built
   exclusively from `outcome === "result"` journal rows (`resume-matcher.ts:878-884`); the
   interrupted call is `outcome: "error"` and is excluded by design. A new additive manager→engine
   channel (`PreparedResume.continuation`, §2.7) is required. Overloading the seed would mean widening
   its construction to include error rows, which would perturb the positional/identity replay logic
   the seed feeds — a change the issue's Non-goals forbid.

2. **Seal the full session ref into `WorkflowCallRecord` and read the candidate from the call
   record alone.** Rejected: `WorkflowCallRecord` carries only `backendId` (`workflow-result.ts:346`),
   not the reopen surface. The reopenable ref lives in the per-agent snapshot (`state.agentSessions`,
   `workflow.ts:1134-1135`; `PersistedAgentState.session`, `run-persistence.ts:57`). Building the
   candidate as a `calls[]`×`agents[]` join on `callIndex` (§2.7) reuses the persisted data as-is;
   duplicating the ref onto the call record would be a redundant, wider persisted surface.

3. **Build the candidate map from the append-only event log.** Rejected: the event projections
   deliberately drop `session` from both agent-end and journal events
   (`run-event-persistence.ts:536`, `:555`). The `PersistedRunState` snapshot is the only disk surface
   that carries session refs (§2.1.4); the candidate map is built from it.

4. **Model the continuation notice as a separate `onContinuation` callback +
   `WorkflowRunResult.continuations[]`.** Rejected: the issue directs reuse of the existing
   `onFallback` channel, and hosts already subscribe to it. A parallel surface would add host-facing
   API the issue did not ask for. Widening the flat `WorkflowRunFallback` with a `"continuation"`
   kind and an optional detail object (§2.3e) is additive and non-breaking for existing
   `requestedSpec`/`kind` readers.

5. **Re-send the original prompt on the continuation turn.** Rejected: the original prompt is already
   in the reopened session's history; re-sending it invites a restart and doubles the work
   continuation exists to avoid. A fixed, runner-internal continuation instruction (§2.5) that demands
   the *complete* final answer keeps the extraction path honest against a pre-pause partial emission,
   and — crucially — is not a `hashAgentCall` input, so identity is untouched.

6. **Prefer `session/load` (with replay) over `session/resume`.** Rejected: continuation does not
   need the transcript streamed back to the client — the agent already holds the history on its side.
   `session/resume` reopens without replay (`acp-client.ts:1559-1560`) and is preferred; `session/load`
   is the fallback for backends that advertise only it (§2.5).

7. **Gate continuation on the resume correspondence strategy (identity-v1 only).** Rejected:
   continuation is orthogonal to correspondence (§2.1.3). A pause-class resume in fact always runs
   `positional-v1` (`resume-matcher.ts:827-868`), so gating on `identity-v1` would disable
   continuation entirely. Serving at the strategy-independent `runLive()` boundary (§2.8) is correct
   and future-proof.

8. **Add a configuration flag or a token cap for continuation.** Rejected per repo policy: requested
   behavior ships default-on, and safety comes from the fail-to-fresh gates (§2.6, §2.8), not from a
   toggle. There is no configuration surface (§2.1.6).

---

## 6. Compatibility & semver

Additive minor across three packages; the two host-facing packages take no new inputs:

- **`@automatalabs/shared-types`** (minor): `RunOptions.continueFromSession`;
  `AgentResultProvenance.continuation` + `ContinuationAttempt`; `ContinuationSkipReason`;
  `JournalCallMetadata` agent-arm `continuation`; `WorkflowRunFallback` `"continuation"` kind +
  `continuation` detail. All optional/additive; existing serializations and the pinned hash fixtures
  are unchanged.
- **`@automatalabs/acp-agents`** (minor): `run()` reattach path, `keepOpen`-on-pause release,
  `CONTINUATION_INSTRUCTION`, `isProviderUsageLimitError`, `pool.acquirePreparedReattach`. No
  `AgentRunner` interface break — `continueFromSession` is optional and advisory.
- **`@automatalabs/workflow-engine`** (minor): `PreparedResume.continuation` +
  `PreparedContinuation`/`ContinuationCandidate`; manager candidate-map construction; live-boundary
  selection, gates, and notices.
- **`@automatalabs/workflows`** and **`@automatalabs/mcp-server`** (patch/transitive): no new inputs;
  they pick up the behavior through the engine. No MCP schema change.

`hashAgentCall()` bytes are untouched (§2.1.1); no hash-fixture change.

---

## 7. Test plan

Every normative statement above has coverage. Gated live suites follow the existing live-e2e pattern.

### 7.1 `@automatalabs/shared-types`

- **Hash invariant (§2.1.1).** A snapshot/byte test asserts `hashAgentCall()` output is identical for
  an options bag with and without any continuation-adjacent field in play, and the pinned hash
  fixtures are unchanged. (Normative: Invariant §2.1.1; focus directive.)
- Type round-trip: `RunOptions.continueFromSession`, `AgentResultProvenance.continuation`,
  `JournalCallMetadata.continuation`, and the `WorkflowRunFallback` continuation notice JSON-serialize
  and parse unchanged.
- `WorkflowRunFallback` back-compat: an existing `kind: "model"` fallback with no `continuation`
  field still type-checks and round-trips (flat-interface guarantee, §2.3e).

### 7.2 `@automatalabs/acp-agents`

- **Pause-class release keeps the session open (§2.4).** A mock ACP server asserts no `session/close`
  is sent when `run()` throws `PROVIDER_USAGE_LIMIT` and when it throws `AUTH_REQUIRED`; asserts a
  `session/close` *is* sent (today's behavior) for a non-pause error without `keepSession`; asserts
  the success path is unchanged.
- **Reattach-and-continue happy path (§2.5).** With `continueFromSession` whose ref advertises
  `resume`, `run()` reopens via `session/resume` (no `session/new`), runs
  model-selection/configOptions/mode, sends the continuation instruction (not the original prompt),
  and returns the extracted result; provenance reports `{ reattached: true, method: "resume" }`.
  Repeat for a `load`-only backend → `method: "load"`.
- **Fail-to-fresh (§2.6).** Separate cases: `backend-mismatch` (ref backend ≠ resolved backend);
  `capability-missing` (ref advertises neither); `reattach-failed` (mock rejects `session/resume`,
  and mock reports the session gone). Each asserts a subsequent `session/new` + original prompt runs
  and the reported provenance reason matches.
- **Structured-output ladder over a continuation turn (§2.5).** A schema run that reattaches and
  continues drives the repair ladder and empty-output guard identically to a fresh schema run.
- **Second pause during continuation re-pauses cleanly (§2.5, §2.11).** A continuation turn that hits
  `PROVIDER_USAGE_LIMIT` propagates it, and the session is released with `keepOpen: true`.
- **`prepare` closure reuse (§2.5).** The reattach path attaches the same structured-output MCP
  server / `mcpServers` / `runId` stamp as the fresh path.

### 7.3 `@automatalabs/workflow-engine`

- **Candidate map: pause-class + reopenable only (§2.7).** Built only from agent `outcome: "error"`
  records whose code is `PROVIDER_USAGE_LIMIT`/`AUTH_REQUIRED` and whose joined session ref has
  `reopen.resume`/`reopen.load`; `result`/`null` records, non-pause errors, and non-reopenable refs
  yield no candidate. A source paused on `checkpoint_required` yields an empty map.
- **Snapshot-only source (§2.1.4).** The interrupted call has no journal entry; its candidate is
  built from `agents[].session`. A test asserts the map is unchanged when the event log is present but
  the snapshot `session` is the only ref source, and that an event-log-only reconstruction would find
  nothing (guarding against a future regression that reads the event stream).
- **Duplicate-hash ambiguity (§2.7.4, §2.8).** Two interrupted candidates with the same hash → hash
  absent from `candidatesByHash`, present in `ambiguousHashes`; the live call runs fresh with an
  `ambiguous-hash` notice.
- **Gate matrix (§2.8).** One test per engine gate — `worktree-isolated`, `cwd-mismatch`,
  `cwd-missing`, `already-consumed` — asserts fresh execution and the correct skip notice; and a
  positive case asserts `continueFromSession` is passed to the runner with the recorded ref.
- **Consume-once across a loop and across hops (§2.11).** A same-hash second live call in one
  execution runs fresh (`already-consumed`); a multi-hop resume where hop 1 completes the continued
  call produces no candidate on hop 2; a multi-hop resume where hop 1 re-pauses produces a fresh
  candidate on hop 2.
- **Journal identity of a continued call (§2.9, §2.1.5).** A continued call's journal entry is
  byte-identical in identity fields (`hash`, `index`, `kind`) to a fresh live entry for the same call;
  the only difference is the additive `call.continuation` marker; replay of that entry ignores the
  marker and matches by hash exactly as for a fresh entry.
- **Provenance + notice plumbing (§2.9, §2.10).** A successful reattach writes
  `call.continuation.method` and emits a `reattached` fallback notice with the method; a runner-side
  skip emits a `skipped` notice with the runner reason; an ordinary no-candidate live call emits no
  continuation notice.
- **Default-on, zero config (§2.1.6).** An eligible resume attempts continuation with no option set
  anywhere; `workflows`/`mcp-server` inputs are unchanged.
- **Strategy independence (§2.1.3).** A `usage_limit`-paused source resumes via `positional-v1`
  (asserted from the resume report) yet still serves the continuation candidate at the live boundary.

### 7.4 Live e2e (gated like the existing live suites)

- Interrupt a real backend turn on a usage/auth wall, resume, and assert the continuation turn
  completes the original task without re-running the prefix work (observable via the agent's own
  history / token accounting and the `reattached` notice). Run for a `resume`-capable backend and, if
  available, a `load`-only backend.

---

## 8. Implementation breakdown

Three PR-sized stages, each green and independently reviewable; they ship as one coordinated additive
minor release (§6):

1. **PR1 — shared additive contract (`shared-types`).** `RunOptions.continueFromSession`;
   `ContinuationAttempt`/`AgentResultProvenance.continuation`; `ContinuationSkipReason`;
   `JournalCallMetadata.continuation`; `WorkflowRunFallback` continuation kind + detail. Type
   round-trip and hash-fixture non-regression tests (§7.1). No behavior change.
2. **PR2 — runner reattach + keep-open (`acp-agents`).** `keepOpen`-on-pause release,
   `isProviderUsageLimitError`, `pool.acquirePreparedReattach`, `run()` reattach path,
   `CONTINUATION_INSTRUCTION`, provenance reporting. Mock-ACP tests (§7.2). Behavior reachable only
   when a caller passes `continueFromSession`.
3. **PR3 — engine candidate map, selection, notices (`workflow-engine`).**
   `PreparedResume.continuation`/`PreparedContinuation`/`ContinuationCandidate`; manager candidate-map
   construction; live-boundary selection, gates, consumption set, journal marker, and notices. Engine
   unit tests (§7.3) plus the gated live e2e (§7.4). This is the stage that turns the default-on
   behavior on end-to-end.

No stage changes synchronous `callSeq` allocation, `hashAgentCall`/input-fingerprint bytes,
resume-matcher policy selection, or isolation behavior.

---

## 9. References

All citations verified by reading the file at base commit
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pause-recovery-continuation`, based on
`origin/main`; `docs/specs/incremental-resume-spec.md` and `docs/specs/acp-auth-spec.md` are the
house-format exemplars). External dependency: `@agentclientprotocol/sdk` declared `^1.2.1`
(`packages/acp-agents/package.json:46`); the reopen RPC method constants used are
`AGENT_METHODS.session_new` / `session_load` / `session_resume`
(`packages/acp-agents/src/acp-client.ts:158-160`).

**`packages/shared-types/src/agent-run.ts`**
- `AgentResultProvenance` live/replay union — `:33-41`
- `RunOptions` interface (additive infra fields are not hash inputs) — `:73-230`; `keepSession` `:192`;
  `onSessionOpen` `:198-204`; `callIndex`/`callHash` `:208-224`

**`packages/shared-types/src/workflow-result.ts`**
- `AgentSessionRef` + `reopen` (load/resume/list/fork) — `:71-90`
- `AgentSessionRecord extends AgentSessionRef` (callIndex, keptOpen) — `:93-101`
- `WorkflowRunFallback` (kind "model"/"modifier", requestedSpec) — `:104-119`
- `JournalCallMetadata` agent arm (kind/label/phase/model/backendId) — `:136-150`
- `JournalEntry` (index/hash/result/session/call/kind/usage/scope) — `:152-172`
- `WorkflowCallRecord` (index/kind/hash/outcome/origin/error) — `:312-330`; `backendId` `:346`;
  `isolation`/`resolvedCwd` `:352-354`; `provenance` `:370`
- `WorkflowRunResult.fallbacks` — `:490`

**`packages/shared-types/src/errors.ts`**
- `WorkflowErrorCode.PROVIDER_USAGE_LIMIT` `:19`; `AUTH_REQUIRED` `:24`
- `WorkflowRecordedError.code` — `:98`
- `isProviderUsageLimit` `:158`; `isAuthRequired` `:162`

**`packages/acp-agents/src/runner.ts`**
- `run()` — `:721-948`; fresh acquire (`pool.acquirePrepared`) `:791`; inline auth-retry loop
  `:786-814`; `onSessionOpen` fire (post-open, pre-prompt) `:820-824`; post-open sequence
  (model/configOptions/mode) `:831-835`; prompt build (`buildRunPrompt`) `:837`; stop-reason assert
  `:848`; empty-output guard `:875-878`; catch/`mapThrownError` `:880-887`; `finally` release
  `keepOpen` `:908-910`
- `loadSession`/`resumeSession` runner methods — `:693-697`, `:714-717`
- `createInteractiveSession` reattach assembly (post-open sequence mirror) — `:954-1010` (model/config/mode `:985-991`)
- `sessionRefFor` (reopen population from capabilities) — `:1375-1388`
- `isAuthRequiredError` — `:1428-1430`

**`packages/acp-agents/src/acp-client.ts`**
- `AGENT_METHODS.session_new/load/resume` — `:158-160`
- `assertLifecycleSupported` capability gate — `:1220-1234`
- `openSession`/`openPreparedSession` (`session/new`) — `:1490`, `:1503`
- connection `loadSession`/`resumeSession` → `reattachSession` — `:1554-1560`, `:1620`

**`packages/acp-agents/src/pool.ts`**
- `AcpAgentPool.acquire` — `:84-99`; `acquirePrepared` — `:101-119`; `selectConnection`
  (generation-gated) — `:126-160`

**`packages/workflow-engine/src/workflow.ts`**
- `onResumeFilesystemTainted`/`onFallback` options — `:171`, `:185`
- `preparedResume` option — `:169`, `:694`
- `runLive` definition — `:1068`; strategy convergence `return runLive()` — `:1684`, `:1759`
- `sessionRecord` (callIndex join) — `:1111-1119`; `emitFailure` seals session into
  `state.agentSessions` on error — `:1134-1135`; settle `backendId` from `slot.sessionRef` — `:1145`
- worktree create at fresh path on resume — `:1184`; `runCwd` resolution — `:1192`;
  `agentRunner.run` options bag (the additive seam) — `:1204-1245`; `slot.sessionRef` capture via
  `onSessionOpen` — `:1235-1239`; `onResultProvenance` capture — `:1270`
- fallback emission (`onFallback` + `state.fallbacks`) — `:1250-1263`
- worktree teardown at settle — `:1419`
- `hashAgentCall` — `:2949-2977` (identity object `:2954-2974`); `sameFallback` — `:2573`
- `resolvedIsolation === "worktree"` (worktree gate signal) — `:1755`

**`packages/workflow-engine/src/workflow-manager.ts`**
- `runReason` pause mapping (usage_limit/auth_required/checkpoint_required) — `:317-325`
- pause persist (`persistRun` in the pause `beforeLive` hook) — `:1360-1373`; agents-to-disk
  projection — `:1627`
- `preparedResume` construction: identity-v1 `:641-649`; live `:653-660`; positional-v1 `:689+`;
  `managed.calls` = `source.calls` `:683-687`
- `getPersistedAgentSessions` (snapshot session-read pattern) — `:2088-2101`

**`packages/workflow-engine/src/resume.ts`**
- `PreparedResume` union (identity-v1 / positional-v1 / live arms) — `:93-127`

**`packages/workflow-engine/src/resume-matcher.ts`**
- `allCallsRepresented` (interrupted error call ⇒ false; pending covers only checkpoint) — `:827-829`
- `fallbackReason: "unsafe-recording"` selection — `:847-853`; `positional-v1`/`safe-prefix` return —
  `:854-868`
- seed built exclusively from `outcome === "result"` rows — `:878-884`

**`packages/workflow-engine/src/run-persistence.ts`**
- `PersistedAgentState.errorCode` `:52`; `.session` `:57`
- `PersistedRunState` (status `:133`, errorCode `:137`, pauseReason `:140`, agents `:152`, journal
  `:168`, fallbacks `:170`, calls `:173`)

**`packages/workflow-engine/src/run-event-persistence.ts`**
- event projections drop `session`: agent-end record `:536`; journal event `:555`
