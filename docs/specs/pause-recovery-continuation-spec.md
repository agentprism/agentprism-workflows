# Pause-recovery Session Continuation

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #183. Verified against base commit
`c06d1e3a5a4363d42b892df1d4d12a5e9c5b94b2` (branch `spec/pause-recovery-continuation`, based on
`origin/main`). Every file:line citation in this document was read at that SHA; see §9.

**References (files):** `packages/shared-types/src/agent-run.ts`;
`packages/shared-types/src/workflow-result.ts`; `packages/shared-types/src/errors.ts`;
`packages/acp-agents/src/runner.ts`; `packages/acp-agents/src/acp-client.ts`;
`packages/acp-agents/src/pool.ts`; `packages/acp-agents/src/backend.ts`;
`packages/acp-agents/src/usage.ts`; `packages/workflow-engine/src/workflow.ts`;
`packages/workflow-engine/src/workflow-manager.ts`; `packages/workflow-engine/src/resume.ts`;
`packages/workflow-engine/src/resume-matcher.ts`; `packages/workflow-engine/src/run-persistence.ts`;
`packages/workflow-engine/src/run-event-persistence.ts`;
`packages/workflow-engine/src/run-observability.ts`; `packages/mcp-server/src/workflow-tool-output.ts`.

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
  (`runner.ts:822-824`), handing the engine an `AgentSessionRef` — `{ sessionId, backendId, cwd,
  reopen: { load, resume, list, fork } }` (`workflow-result.ts:71-90`) whose `reopen` flags mirror
  what the connected agent advertised at initialize (`sessionRefFor`, `runner.ts:1375-1388`). The
  engine copies that ref into the call's attempt slot (`workflow.ts:1235-1239`) and, on **every**
  terminal transition including error settles, seals it into the per-agent snapshot
  (`emitFailure` → `state.agentSessions.push(session)`, `workflow.ts:1135-1136`, via `sessionRecord`,
  `workflow.ts:1111-1120`).

- **The reopen path costs zero inference tokens.** The runner already serves capability-gated
  `session/load` (with transcript replay) and `session/resume` (without replay) as
  `loadSession`/`resumeSession` (`runner.ts:693-697`, `runner.ts:714-717`); the pooled connection
  drives them (`acp-client.ts:1554-1560`) and refuses them before any wire request when the backend
  did not advertise the capability (`assertLifecycleSupported`, `acp-client.ts:1220-1234`). Reopen is
  served from the agent's own on-disk session store, not by re-running the turn.

- **Pause classification is already precise and durable.** `WorkflowManager` maps
  `PROVIDER_USAGE_LIMIT` → pause reason `usage_limit` and `AUTH_REQUIRED` → `auth_required`
  (`runReason`, `workflow-manager.ts:317-323`), marks the run `paused` (never `failed`), and persists
  the full snapshot — including `agents[].session` and `agents[].errorCode` — to disk before
  releasing (`persistRun` in the pause `beforeLive` hook, `workflow-manager.ts:1369-1370`; agents
  projected at `workflow-manager.ts:1627-1631`; `PersistedAgentState.session`/`.errorCode` at
  `run-persistence.ts:57`/`:52`).

The missing piece is the connection: on resume, when the interrupted call comes up live again with an
unchanged identity hash **and** unchanged execution inputs, reattach to its recorded session and ask
the agent to **continue** the interrupted turn rather than restarting it.

Three facts about the existing resume machinery shape how continuation must be wired, and all are
load-bearing:

1. **The resume seed cannot carry the continuation candidate.** The manager's resume seed is built
   exclusively from `outcome === "result"` journal rows (the promotion loop filters
   `if (call.outcome !== "result") continue;`, `resume-matcher.ts:873-882`). The interrupted call is
   `outcome: "error"` and is excluded by design. Continuation therefore needs a **new, additive
   manager→engine channel** (`preparedContinuation`, §2.7), distinct from the seed and from
   `PreparedResume`.

2. **A pause-class resume runs the positional (not identity) correspondence strategy.** The
   interrupted `outcome: "error"` call makes `allCallsRepresented` false
   (`resume-matcher.ts:827-829`; the pending-representation exception covers only
   `checkpoint_required`), which selects `fallbackReason: "unsafe-recording"` and a
   `positional-v1` strategy at `safe-prefix` eligibility (`resume-matcher.ts:847-868`). This is
   **orthogonal to continuation**: both `identity-v1` and `positional-v1` resolve a journal-miss to
   the same live executor, `runLive()` (`workflow.ts:1684` and `workflow.ts:1759`), where the call
   re-runs live with its unchanged hash. Continuation is served at that live boundary and does not
   depend on which correspondence strategy the resume chose — nor on whether a `PreparedResume`
   exists at all (§2.7, §2.8).

3. **Session refs reach disk only through the `PersistedRunState` snapshot.** The append-only
   event-log projections deliberately drop `session` from both the agent-end and journal events
   (`run-event-persistence.ts:536` and `run-event-persistence.ts:555`). The continuation candidate
   map must therefore be built from the snapshot's `agents[]` array (`run-persistence.ts:152`),
   **never** from the event stream.

**Continuation is a cheaper way to finish an interrupted live call. It never changes what a call
*is*.** The call's identity hash (`hashAgentCall`, `workflow.ts:2949-2975`), journal semantics, and
replay eligibility are untouched — same prompt, same hash; continuation only changes how the live
execution reaches its result. Every uncertainty falls back to a fresh `session/new` + original
prompt (fail-to-fresh), mirroring the engine's fail-to-live posture: a skipped continuation costs
tokens, never correctness.

---

## 2. The contract

### 2.1 Verified baseline and invariants

The implementation preserves these named invariants. Each has a test in §7.

1. **Unchanged hash bytes.** `hashAgentCall()` continues to hash, in its existing serialization,
   prompt, resolved model (`model: model ?? null`, `workflow.ts:2960`), `mode` only when set, sorted
   non-empty `configOptions`, tier, phase, agentType, resolved agent definition, and schema (the
   identity object, `workflow.ts:2958-2973`). Nothing continuation adds — the `continueFromSession`
   reattach directive, the runner-internal continuation instruction, the recorded session ref, the
   reattach method, or any provenance/observability marker — is a `hashAgentCall` input. Pinned hash
   fixtures do not change. The separate input fingerprint `hashCallInputs()`
   (`workflow.ts:2865-2879`) is likewise unchanged; continuation **reads** it (§2.8) but does not add
   to it.

2. **Fail-to-fresh.** Every continuation eligibility gate (§2.8) and every runner-side reattach step
   (§2.5, §2.6) that is not fully satisfied discards the continuation attempt and runs the call fresh
   (`session/new` + the original prompt) within the *same* attempt or a later retry of the *same*
   `run()`/`runLive()` invocation. A skipped or failed continuation never returns a guessed result,
   never aborts the call, and never changes the call's journaled identity.

3. **Continuation is strategy- and PreparedResume-independent.** A continued call is served at the
   `runLive()` live boundary (`workflow.ts:1684`, `workflow.ts:1759`), which both `identity-v1` and
   `positional-v1` resume strategies reach on a journal miss, and which the same-ID legacy resume
   path (`runManualAgent`, `workflow.ts:1710-1760`) reaches on a journal miss too. The candidate is
   carried on a **standalone** `preparedContinuation` engine option (§2.3f), never folded into
   `PreparedResume`, so continuation is available on every pause-class resume regardless of
   correspondence strategy — including a resume whose `PreparedResume.strategy === "live"` (replay
   fully disabled) and the same-ID `resume()`/`resumeInBackground()` path, which builds no
   `PreparedResume` at all (`workflow-manager.ts:1962`).

4. **Candidate data comes only from the persisted snapshot.** The continuation candidate map is built
   by joining `PersistedRunState.calls[]` (`run-persistence.ts:173`) to `PersistedRunState.agents[]`
   session refs and error codes (`run-persistence.ts:57`, `:52`) on the compound
   `(scope, callIndex)` key, filtered to **root scope only** (§2.7). It is never built from the event
   log, which projects `session` away (`run-event-persistence.ts:536`, `:555`).

5. **A continued call journals exactly like a fresh live call.** Same hash, current index, runner
   origin, its (reattached) session ref recorded through the ordinary `onSessionOpen` flow, and real
   continuation-turn usage debited against the budget. The only additions are diagnostic and
   non-identity (§2.9): a durable `continuation` marker on the journal call metadata (preserved
   verbatim across replay and event projection, §2.10) and a transient provenance report.

6. **Default-on, zero configuration.** Continuation is the live-path behavior on every resume of a
   `usage_limit`/`auth_required`-paused run, on both the new-run `resumeFromRunId` API and the
   same-ID `resume()`/`resumeInBackground()` recovery API (§2.7). There is no opt-in flag, no
   per-call toggle, and no resource cap. `@automatalabs/workflows` takes no new inputs;
   `@automatalabs/mcp-server` takes no new inputs and only widens its result **output** schema (§2.10,
   §6). Both pick the behavior up transitively.

### 2.2 The continuation candidate (data model)

A **continuation candidate** is the join of one interrupted root call's structural record with its
persisted session ref and error code. Candidates are keyed by the interrupted call's deterministic
**call index**, not by its hash — the index pins the exact source occurrence deterministically (the
`state.callSeq` allocation is reproducible for a fixed script, `workflow.ts:1000`), which a hash key
cannot do when an identical prompt appears more than once (§5, rejected alt #9).

```ts
// packages/workflow-engine/src/resume.ts (new, engine-internal)
export interface ContinuationCandidate {
  /** The interrupted call's deterministic index (WorkflowCallRecord.index). Map key. */
  readonly callIndex: number;
  /** The interrupted call's identity hash (WorkflowCallRecord.hash). Verified against the live
   *  call's hash before reattach — a script edit that changed the call at this index fails it. */
  readonly hash: string;
  /** The interrupted call's input fingerprint (WorkflowCallRecord.inputsHash) — the strict-JSON
   *  hash of cwd/isolation/images/mcpServers/meta/promptMeta/keepSession/label/timeout/retries/
   *  approved-backends digest (hashCallInputs, workflow.ts:2865-2879). Verified against the live
   *  call's fingerprint before reattach. Absent only on legacy pre-fingerprint records. */
  readonly inputsHash?: string;
  /** The re-attach handle sealed on the error settle (PersistedAgentState.session). Carries the
   *  recorded backendId and the agent-advertised reopen surface. */
  readonly sessionRef: AgentSessionRecord;
  /** The interrupted call's recorded execution directory (WorkflowCallRecord.resolvedCwd, falling
   *  back to sessionRef.cwd). Absolute. */
  readonly recordedCwd: string;
  /** The source run the candidate came from (diagnostics only). */
  readonly sourceRunId: string;
}

/** The additive manager→engine channel. Keyed by the interrupted call's index; each index maps to
 *  at most one interrupted, reopenable candidate (indices are unique per execution). */
export interface PreparedContinuation {
  readonly candidatesByIndex: ReadonlyMap<number, ContinuationCandidate>;
}
```

`AgentSessionRef`/`AgentSessionRecord` and the `reopen` surface are unchanged
(`workflow-result.ts:71-101`). The candidate carries no secrets and is JSON-round-trippable — it is a
projection of already-persisted data. Because the key space is the unique call-index space, there is
no ambiguity set and no cross-occurrence consumption set: each index is reached at most once per
execution (retries reuse the same index but are handled attempt-locally, §2.8, §2.11).

### 2.3 Additive `shared-types` surface

All fields below are additive and JSON-round-trippable; none is a `hashAgentCall` or
`hashCallInputs` input.

**(a) `RunOptions.continueFromSession`** — `packages/shared-types/src/agent-run.ts`, added
immediately after `onSessionOpen` (`agent-run.ts:198`):

```ts
  /** RESUME-ONLY reattach directive. When set, the runner attempts to reopen this exact ACP
   *  session (via session/resume, else session/load) and CONTINUE the interrupted turn instead of
   *  opening a fresh session/new. Advisory: a runner that ignores it — or any reattach failure —
   *  runs the call fresh, which IS the fallback. ADDITIVE and NOT part of the resume identity hash
   *  (hashAgentCall) or the input fingerprint (hashCallInputs): it changes how a live call reaches
   *  its result, never the logical call. Omitted => today's fresh session/new + original-prompt
   *  path. */
  continueFromSession?: AgentSessionRef;
```

**(b) `AgentResultProvenance` continuation attempt** — `packages/shared-types/src/agent-run.ts`,
extending the `"live"` arm (`agent-run.ts:33-40`):

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
infers ordinary live provenance). It is reported **before** the continuation turn settles, so a
reattach that later fails or re-pauses is still recorded as a reattach.

**(c) `ContinuationSkipReason`** — `packages/shared-types/src/agent-run.ts` (new export). The closed
set of reasons a continuation was not served when a candidate existed for the call's index:

```ts
export type ContinuationSkipReason =
  // engine-side gates (§2.8) — candidate existed at the index but a gate rejected it, no reattach
  // attempted:
  | "hash-mismatch"      // recorded hash !== the live call's hash at this index (script changed)
  | "inputs-mismatch"    // recorded inputsHash !== the live call's inputsHash, or either is absent
  | "worktree-isolated"  // the call is worktree-isolated
  | "cwd-mismatch"       // recorded cwd !== the call's resolved cwd
  | "cwd-missing"        // the call's resolved cwd does not exist on disk
  // runner-side gates (§2.5, §2.6) — reattach attempted and abandoned before the continuation turn:
  | "backend-mismatch"   // continueFromSession.backendId !== the resolved backend id
  | "capability-missing" // the CURRENT connection advertises neither session/resume nor session/load
  | "reattach-failed"    // load/resume rejected, session gone, or a spawn/auth error at reopen
  // engine-synthesized (§2.10) — engine passed the directive but the runner reported no
  // continuation provenance (a custom AgentRunner that ignored continueFromSession ran fresh):
  | "runner-declined";
```

**(d) `JournalCallMetadata` continuation marker** — `packages/shared-types/src/workflow-result.ts`,
extending the `"agent"` arm (`workflow-result.ts:137-145`):

```ts
  | {
      kind: "agent";
      label: string;
      phase?: string;
      model?: string;
      backendId?: string;
      /** Diagnostic-only: present when this result was produced by reattaching to a paused session
       *  and continuing the interrupted turn, and which reopen method reattached. NOT part of
       *  replay identity — replay restores it verbatim (workflow.ts replayPreparedAgent) and never
       *  consults it; the run-event journal projection preserves it (run-observability.ts). */
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
  /** For continuation: the model/tier spec the engine asked the runner to serve on the continued
   *  call (identical to the interrupted call's — the hash proves it). */
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

**(f) Engine-internal `preparedContinuation` option (NOT shared-types).** A new optional field on the
engine's `WorkflowRunOptions` (`workflow.ts:169` neighborhood) and on the manager's
`ManagerResumeExecution` (`workflow-manager.ts:164` neighborhood):
`preparedContinuation?: PreparedContinuation`. It is engine/manager-internal wiring — never a
`hashAgentCall`/`hashCallInputs` input, never surfaced to `@automatalabs/workflows` or
`@automatalabs/mcp-server` callers.

### 2.4 Runner: keep the session reopenable on a pause-class release

Today `run()`'s `finally` releases the session with `keepOpen: opts.keepSession === true`
(`runner.ts:908-909`), so a normal error closes the agent-side session. Continuation requires the
interrupted session to survive.

The change is local to `run()`:

1. Declare a release decision before the `try`: `let keepOpenOnRelease = opts.keepSession === true;`.
2. In the existing `catch` (`runner.ts:881-890`), compute the mapped error once, and if it is
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
   `errors.ts:19`; equivalently reuse the shared `isProviderUsageLimit`, `errors.ts:158`).
3. The `finally` releases with the decision: `await session.release({ keepOpen: keepOpenOnRelease });`
   (`runner.ts:909`).

Behavior contract:

- Success path: `keepOpenOnRelease` stays `opts.keepSession === true` — **unchanged**.
- Non-pause error: unchanged (closed unless `keepSession`).
- Pause-class error (`PROVIDER_USAGE_LIMIT` or `AUTH_REQUIRED`): released with `keepOpen: true`
  regardless of `keepSession`, so the agent-persisted session survives for a later reattach. The
  pooled process is released either way. For a backend that advertises no reopen capability, skipping
  the close is harmless (there is nothing to reattach; the engine builds no candidate for it, §2.7)
  and matches existing `keepSession` semantics.

**Diagnostic `keptOpen` fix.** The persisted `AgentSessionRecord.keptOpen`
(`workflow-result.ts:101`) documents whether the release-time `session/close` was skipped, and the
engine currently derives it solely from authored `keepSession` (`sessionRecord`,
`workflow.ts:1118`). On an automatic pause-class keep-open the close **is** skipped, so `keptOpen`
must record `true`. The engine's `sessionRecord` therefore stamps
`keptOpen: agentOptions.keepSession === true || <this settle is a pause-class error>`; the pause-class
signal is available in `emitFailure`, which already receives the thrown error
(`workflow.ts:1124-1136`). `keptOpen` is diagnostic only — the candidate builder gates on the
recorded `errorCode`, not on `keptOpen` (§2.7) — but the field must not lie.

### 2.5 Runner: reattach-and-continue

Add a reattach acquire path to `run()`, gated on `opts.continueFromSession`. When it is set, the
runner attempts reopen-and-continue **before** the fresh `session/new` acquire (`runner.ts:791`); on
any failure it cleans up (below) and falls through to the unchanged fresh path.

**Pool method (new).** `packages/acp-agents/src/pool.ts` gains `acquirePreparedReattach`, mirroring
`acquirePrepared` (`pool.ts:101-119`) but opening the session by reopen instead of `session/new`, and
choosing the reopen method against the **current** connection's advertised capabilities (not the
recorded ref, §2.6 gate 7):

```ts
async acquirePreparedReattach(
  backend: Backend,
  sessionId: string,
  prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
  context: { signal?: AbortSignal; label?: string } = {},
): Promise<{ handle: SessionHandle; method: "resume" | "load" }> {
  if (this.disposed) throw new Error("ACP agent pool is disposed");
  const connection = this.selectConnection(backend);   // same generation-gated selection as acquire
  // Prefer resume (no transcript replay — the agent holds the history); fall back to load. Read the
  // LIVE connection's advertised capabilities so stale recorded flags never mis-drive the wire.
  const caps = connection.capabilities;
  const method: "resume" | "load" | undefined =
    caps?.supportsResumeSession ? "resume" : caps?.supportsLoadSession ? "load" : undefined;
  if (method === undefined) throw new ReattachCapabilityUnavailable(connection.backendId, sessionId);
  try {
    const opts = await prepare(connection);
    const handle = method === "resume"
      ? await connection.resumeSession(sessionId, opts)
      : await connection.loadSession(sessionId, opts);
    return { handle, method };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    throw mapThrownError(error, { label: context.label, backendId: connection.backendId, backend,
      authMethods: connection.capabilities?.authMethods });
  }
}
```

`ReattachCapabilityUnavailable` is a new runner-internal sentinel thrown **before** any wire request;
the runner maps it to `capability-missing`. `connection.resumeSession`/`loadSession`
(`acp-client.ts:1554-1560`) additionally refuse before any wire request when the negotiated
capability is absent (`assertLifecycleSupported`, `acp-client.ts:1220-1234`), so the method choice
and the wire gate agree by construction.

**`run()` reattach path.** Replacing the single `acquirePrepared` call at `runner.ts:791` with a
guarded reattach-then-fresh sequence, all inside the existing `try` that already holds the
structured-tool state (`runner.ts:749-752`):

1. **Backend-identity gate (§2.6 `backend-mismatch`).** Resolve the call's backend from its model
   spec via the existing `prepareSession` (`prepared.backend`, `runner.ts:743`). If
   `continueFromSession.backendId !== prepared.backend.id`, do not reattach; report
   `{ reattached: false, reason: "backend-mismatch" }` and take the fresh path. (The stronger
   custom-backend process-identity drift — same name, different command → different
   `Backend.poolKey`, `pool.ts:129`, `backend.ts:66` — is caught engine-side by the `inputsHash`
   gate, because the approved-backends digest is a `hashCallInputs` input, `workflow.ts:995`; see
   §2.8 and §5 rejected alt #10.)
2. **Reattach (§2.6 `capability-missing`/`reattach-failed`).** Call
   `this.pool.acquirePreparedReattach(prepared.backend, continueFromSession.sessionId, prepare, ctx)`,
   reusing the **same** `prepare` closure the fresh path uses (so structured-output MCP injection,
   `mcpServers`, and `runId` stamping are identical). On success it returns `{ handle, method }`; the
   reattach acquisition is the **mechanically observable fail-to-fresh boundary** — the reopen RPC
   resolved and returned a `SessionHandle`. On any throw:
   - `ReattachCapabilityUnavailable` → report `{ reattached: false, reason: "capability-missing" }`.
   - anything else (capability error, RPC rejection, session-gone, spawn/auth error) → report
     `{ reattached: false, reason: "reattach-failed" }`.
   Then run the **fail-to-fresh cleanup** (below) and take the fresh acquire path within the same
   `run()` invocation.

**Fail-to-fresh cleanup (§2.6, closes the schema-run deadlock).** The `prepare` closure may have
acquired the per-connection structured-tool turn (`releaseStructuredToolTurn`) and registered an MCP
tool (`structuredTool`, `structuredToolActive`) before the reopen RPC failed. Before the fresh
acquire the runner MUST run the identical cleanup the inline auth-retry already performs
(`runner.ts:799-809`): release the turn (`releaseStructuredToolTurn?.(); releaseStructuredToolTurn =
undefined;`), release the tool (`try { structuredTool?.release(); } catch {}
structuredTool = undefined; structuredToolActive = false;`), and discard any returned handle
(`try { await handle?.release({ keepOpen: false }); } catch {}`). Without releasing the turn first,
the fresh `acquirePrepared` → `prepare` → `acquireStructuredToolTurn` on the same connection would
await a turn this run still holds and deadlock (`runner.ts:926-935`). Cleanup failure is best-effort
and never masks the fresh path.

**On a successful reattach**, the run proceeds through the identical post-open sequence as a fresh
run and a mirror of `createInteractiveSession`'s reattach assembly (`runner.ts:985-989`):

- **Usage baseline (§2.9, closes load-replay double-count).** Immediately after
  `acquirePreparedReattach` resolves — which for `session/load` is after the transcript replay
  completes (the load response settles only once replayed `session/update` notifications have been
  processed into the fresh `SessionState`, `acp-client.ts:1627,1653,1659`) — the runner snapshots the
  session's usage accumulator and reports, at settle, only the **delta** from that baseline through
  the continuation turn. This deterministically excludes replayed historical `usage_update`
  notifications (which feed the cumulative `cost`/`contextUsedTokens` channels,
  `acp-client.ts:282-289`; `usage.ts:33-48`) from the continued call's debit. Implementation: add a
  `baseline()`/`delta(baseline)` pair to `UsageAccumulator` (`usage.ts:21-73`, additive, internal);
  the authoritative per-turn `promptUsage` channel is already per-turn (overwritten each
  `prompt()`, `acp-client.ts:2043`) and needs no adjustment. Because `session/resume` replays nothing,
  its delta equals its raw usage — the baseline is uniform and correct for both methods.
- `onSessionOpen` fires with the reattached session's ref (`runner.ts:822-824`) — same `sessionId`,
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
  (`runner.ts:874-878`), and the structured-output repair ladder (`runner.ts:850-869`) run
  **unchanged**. The instruction demands the *complete* final answer precisely so a pre-pause partial
  emission cannot satisfy the extraction path.
- The runner reports provenance `{ source: "live", continuation: { reattached: true, method } }` via
  `onResultProvenance` before the attempt settles.

The `keepOpen`-on-pause rule (§2.4) applies to the continuation turn too: a **second** pause-class
error during continuation propagates normally, the run pauses again, and the (re-recorded) session is
again kept reopenable — continuation can chain across successive pauses (§2.11).

### 2.6 Runner: fail-to-fresh failure contract

Each runner-side gate discards the continuation attempt and runs the call fresh in the same `run()`
invocation. The runner reports the reason on `AgentResultProvenance.continuation`; the engine turns
it into an observability notice (§2.10).

| Gate | Condition to reattach | On failure |
| --- | --- | --- |
| Backend identity | `continueFromSession.backendId === prepared.backend.id` | report `backend-mismatch`; cleanup; fresh `session/new` + original prompt |
| Reopen capability (current connection) | the selected pooled connection advertises `session/resume` or `session/load` | report `capability-missing`; cleanup; fresh path |
| Reattach accepted | the `resume`/`load` RPC resolves and returns a `SessionHandle` (no capability error, no RPC rejection, no session-gone, no spawn/auth error) | report `reattach-failed`; cleanup; fresh path |

**The fail-to-fresh window is exactly the reattach acquisition** — from the `continueFromSession`
directive through the reopen RPC resolving. This is the only mechanically observable boundary:
`SessionHandle.prompt()` resolves only after the whole turn, with no separate "prompt accepted"
acknowledgement (`acp-client.ts:2027-2044`). Once the handle is in hand the run is committed to the
continuation turn, and every later step is a genuine live-call outcome, not a fresh-fallback
candidate:

- **Post-open setup failure** (`applyModelSelection`/`setConfigOptions`/`setMode`,
  `runner.ts:831-835`): these are the *identical* calls a fresh run makes on the same model spec and
  the reattached session advertises the same config options, so a fresh retry would fail identically —
  falling to fresh here would loop and double-charge. The error propagates through the normal
  `catch`/`mapThrownError` (`runner.ts:881-890`) as a live-call failure. See §5 rejected alt #8.
- **A fresh pause-class error** at any post-open step: propagates; the run re-pauses; the
  (re-recorded) session is kept reopenable (§2.4); continuation resumes on the next hop.
- **Empty or schema-noncompliant continuation output**: the existing live-call error paths
  (`AGENT_EMPTY_OUTPUT`, `runner.ts:874-878`; `SCHEMA_NONCOMPLIANCE` via the repair ladder,
  `runner.ts:850-869`). No silent fresh retry.
- **Abort**: re-thrown raw (the engine's concern), unchanged (`runner.ts:883`).
- **Connection death mid-continuation**: maps to a runner error and settles the attempt like any
  runner failure; the engine's attempt loop then decides retry-vs-fail (§2.8, §2.11).

Custom `AgentRunner` implementations that ignore `continueFromSession` run the call fresh — which is
the fallback — so no interface break and no capability negotiation at the engine seam. The engine
detects this case (no continuation provenance reported) and emits a `runner-declined` notice (§2.10).

### 2.7 Engine: candidate map construction (manager)

The manager builds a `PreparedContinuation` whenever it prepares **any** resume of a source run whose
status is `paused` with pause reason `usage_limit` or `auth_required`, on both resume entry points. A
single private helper `buildPreparedContinuation(persisted: PersistedRunState): PreparedContinuation |
undefined` is called from both:

- **New-run resume (`resumeFromRunId`).** `prepareManagedResume` (`workflow-manager.ts:610-708`)
  attaches the result to the returned `ManagerResumeExecution.preparedContinuation` for all three
  admission strategies (`identity-v1` `:640-648`, `live` `:651-660`, `positional-v1` `:688-707`) — it
  is independent of `PreparedResume` (Invariant §2.1.3). `executeRun` reads
  `resumeExecution?.preparedContinuation` alongside `resumeExecution?.preparedResume`
  (`workflow-manager.ts:1071`) and threads it into the engine options bag next to `preparedResume`
  (`workflow-manager.ts:1129-1132`).
- **Same-ID recovery (`resume()`/`resumeInBackground()`).** This path builds no `PreparedResume` and
  today passes only `resumeJournal` to `executeRun` (`workflow-manager.ts:1962`). It calls
  `buildPreparedContinuation(persisted)` on the loaded snapshot and threads the result into the same
  engine option (via a `managed.preparedContinuation` field consumed by `executeRun`). For an
  `auth_required` source this runs **after** the existing cold re-arm gate
  (`workflow-manager.ts:1800-1841`): if the runner's auth did not survive the gate re-pauses and no
  candidate is ever consumed; if it survived, continuation is served on the live path exactly as on
  the new-run API.

`buildPreparedContinuation` (mirrors the `getPersistedAgentSessions` snapshot read,
`workflow-manager.ts:2086-2101`, joined to the root-scope call manifest the manager already
materializes, `latestRootRows`, `workflow-manager.ts:303-309`):

1. **Gate on pause class.** Return `undefined` unless `persisted.status === "paused"` and
   `persisted.pauseReason` ∈ `{ "usage_limit", "auth_required" }` (`run-persistence.ts:140`).
   `checkpoint_required`, `completed`, `failed`, and `aborted` sources produce none (Non-goals §4).
2. **Index the session refs by call index, root scope only.** For each `PersistedAgentState` in
   `persisted.agents` (`run-persistence.ts:152`) whose `scope` is undefined or equals
   `persisted.runId` (root scope, mirroring `latestRootRows`) and that has both a `session`
   (`run-persistence.ts:57`) and an `errorCode` (`run-persistence.ts:52`), key it by
   `session.callIndex`. **Root-scope filtering is mandatory:** nested `workflow()` agents are recorded
   with child-local indexes and a child `scope` (`onAgentStart` stamps `callIndex`/`scope`,
   `workflow-manager.ts:1199-1200`; `onAgentEnd` matches on the `(scope, callIndex)` pair,
   `:1217-1219`), so a child `callIndex: 0` would otherwise collide with the root row at index 0. The
   interrupted call has no journal entry, so its ref is read from `agents[]`, never from the journal
   or the event stream (Invariant §2.1.4). Later rows win per index (last-write, matching
   `latestRootRows`).
3. **Join to the root-scope call manifest and filter.** For each `WorkflowCallRecord` in
   `latestRootRows(persisted.calls, persisted.runId)` (`run-persistence.ts:173`), keep it as a
   candidate iff **all** hold:
   - `record.kind === "agent"` (`workflow-result.ts:315`);
   - a session ref **and** an `errorCode` exist at `record.index` from step 2, and that joined
     **`PersistedAgentState.errorCode`** ∈ `{ PROVIDER_USAGE_LIMIT, AUTH_REQUIRED }` (`errors.ts:19`,
     `:24`). The pause-class test reads the agent row's `errorCode` (the authoritative settle-time
     code, per the issue's verification comment), **not** `WorkflowCallRecord.error.code`; the call
     record supplies only identity/cwd (`hash`, `inputsHash`, `resolvedCwd`). This avoids a
     disagreement bug when the two disagree (tested, §7.3).
   - the joined session ref advertises `reopen.resume === true || reopen.load === true`
     (`workflow-result.ts:80-90`).
   Form `ContinuationCandidate` with `callIndex = record.index`, `hash = record.hash`
   (`workflow-result.ts:317`), `inputsHash = record.inputsHash` (`workflow-result.ts:322`),
   `sessionRef = <the joined AgentSessionRecord>`, `recordedCwd = record.resolvedCwd ?? sessionRef.cwd`
   (`workflow-result.ts:354`).
4. **Key by index.** Insert each candidate into `candidatesByIndex` under `record.index`. Indices are
   unique, so there is no ambiguity resolution: at most one candidate per index. (Two interrupted
   calls that share a hash have distinct indices and both become candidates — each tied to its own
   occurrence.)
5. **Return** `{ candidatesByIndex }`, or `undefined` when the map is empty.

Nested continuation is out of scope: `workflow()` runs its child with `preparedResume: undefined`,
`resumeJournal: undefined`, and (added here) `preparedContinuation: undefined`
(`workflow.ts:1878-1880`), so an interrupted nested agent re-runs fresh exactly as today (Non-goals
§4).

### 2.8 Engine: live-boundary selection and eligibility gates

`preparedContinuation` is read inside `runLive()` (`workflow.ts:1068`) — the boundary both resume
strategies and the same-ID path converge on (Invariant §2.1.3). After the call's execution directory
`runCwd` is resolved (`workflow.ts:1192`) and inside the attempt loop when the runner options bag is
assembled (`workflow.ts:1206-1296`):

```
candidate := preparedContinuation?.candidatesByIndex.get(callIndex)
if candidate is present AND all engine gates hold AND attempt === 1:
    pass continueFromSession = candidate.sessionRef in the runner options bag
    (record that a directive was passed, for the runner-declined check, §2.10)
else if a candidate existed for callIndex but a gate rejected it:
    emit a "skipped" continuation notice (§2.10) with the gate's reason; run fresh
else:
    run fresh, no notice (the ordinary no-candidate case)
```

`continueFromSession` is added to the existing `agentRunner.run(prompt, { … })` options object
(`workflow.ts:1206-1296`) — the same additive bag that already carries `keepSession`, `onSessionOpen`,
`callIndex`, `callHash`, and `callInputsHash`; it is not passed to `hashAgentCall`/`hashCallInputs`
and not folded into `AgentOptions`, so Invariant §2.1.1 holds by construction.

**Engine-side eligibility gates (each fails to fresh, with its own contract):**

| Gate | Condition | On failure |
| --- | --- | --- |
| Candidate present | `candidatesByIndex.get(callIndex)` is defined | no candidate → run fresh, no notice |
| First attempt | `attempt === 1` (the retry loop's first pass, `workflow.ts:1194`) | later attempts run fresh, no *additional* notice (attempt 1's notice already fired) |
| Identity match | `candidate.hash === callHash` (`workflow.ts:975`) | notice `hash-mismatch`; run fresh |
| Inputs match | `candidate.inputsHash !== undefined && callInputsHash !== undefined && candidate.inputsHash === callInputsHash` (`workflow.ts:984`) | notice `inputs-mismatch`; run fresh |
| Not worktree-isolated | `resolvedIsolation !== "worktree"` (defined `workflow.ts:967`) | notice `worktree-isolated`; run fresh |
| Cwd equality | `candidate.recordedCwd === runCwd` (`workflow.ts:1192`) | notice `cwd-mismatch`; run fresh |
| Cwd exists on disk | `fs.existsSync(runCwd)` | notice `cwd-missing`; run fresh |

Rationale for the identity + inputs gates (closes hash-only-match unsafety): `hashAgentCall`
deliberately excludes the execution inputs `hashCallInputs` captures — cwd, isolation, images,
mcpServers, meta, promptMeta, keepSession, label, timeout, retries, and the approved-backends digest
(`workflow.ts:984-996`). A hash match alone would let a resume that changed an image, an MCP/tool
surface, prompt metadata, or a same-named custom backend's command reattach to the old turn and
return an answer computed for stale inputs. Requiring `candidate.inputsHash === callInputsHash`
(both already persisted — `WorkflowCallRecord.inputsHash`, `workflow-result.ts:322`, and the live
`callInputsHash`, `agent-run.ts:221-226`) reinstates fail-to-fresh for every such change with **no
new persisted surface**. The missing-fingerprint rule is explicit: if either side lacks a fingerprint
(a legacy pre-fingerprint record, or a call whose inputs failed strict-JSON canonicalization),
`inputs-mismatch` fires and the call runs fresh — continuation never proceeds on unproven inputs.

Rationale for the two cwd gates: call worktrees are removed at settle (`workflow.ts:1419`) and
recreated at a fresh path on resume (`createWorktree(baseCwd, \`${runId}-${callIndex}-${label}\`)`,
`workflow.ts:1184`/`:1653`, with a new `runId`), so a worktree-isolated call's recorded cwd is gone
by design — the `worktree-isolated` gate rejects it deterministically without relying on path
comparison. For a non-isolated call, `runCwd` is `resolvePath(baseCwd, agentOptions.cwd ?? ".")`
(`workflow.ts:1192`); the equality-and-existence pair guarantees the recorded session's directory is
the same real directory the continuation will run in.

**Occurrence correspondence is exact.** Because the candidate is keyed by the interrupted call's
recorded index and the engine looks it up by the live call's `callIndex`, an earlier completed call
that shares a hash with a later interrupted call can never consume the interrupted call's candidate:
the earlier call's index does not match the interrupted call's index. The `state.callSeq` allocation
is deterministic for a fixed script (`workflow.ts:1000`), so the source index and the current index
are the same position; the `hash` gate additionally rejects the case where a script edit shifted what
runs at that index (tested with an identical-prompt loop, §7.3).

**The backend-identity gate is enforced runner-side** (§2.6): the engine cannot resolve a model spec
to a concrete backend id — that resolution is runner-internal (`prepareSession`). Because the
candidate is keyed by index and gated on identity hash, and the model spec is a `hashAgentCall`
input (`workflow.ts:2960`), a hash match already pins the model spec; the runner then compares
`continueFromSession.backendId` (carried on the ref) to `prepared.backend.id`. Custom-backend
**process** drift (same name, different command → different `Backend.poolKey`, `pool.ts:129`,
`backend.ts:66`) is caught earlier by the engine's `inputsHash` gate, since the approved-backends
digest is a `hashCallInputs` input (`workflow.ts:995`). The two gates together pin backend-instance
identity without adding a `poolKey` field to the persisted ref (§5 rejected alt #10).

### 2.9 Engine: journaling, provenance, and budget

A continued call settles through the ordinary live-call path — no special-casing of its identity:

- **Journal identity.** Same `hash`, current `index`, and the settle path already used for a live
  runner attempt (`origin: "runner"`, `workflow.ts:1328-1348`). Its reattached session ref is
  recorded through the normal `onSessionOpen` → `slot.sessionRef` → `sessionRecord` flow
  (`workflow.ts:1235-1239`, `:1111-1120`).
- **Diagnostic marker.** When the terminal attempt's provenance (`slot.provenance`, populated from
  the runner's `onResultProvenance` report, `workflow.ts:1270-1274`) carries
  `continuation: { reattached: true, method }`, the engine writes `continuation: { method }` onto the
  journal entry's `call` metadata (the live journal build at `workflow.ts:1358-1364`,
  `JournalCallMetadata` agent arm, §2.3d). This marker is diagnostic only; it is not a
  `hashAgentCall`/`hashCallInputs` input and replay never consults it (Invariant §2.1.5), but it is
  preserved verbatim across re-journaling and event projection (§2.10). The full attempt outcome
  (including a runner-side skip) is already durably visible on the call record's `provenance`
  (`WorkflowCallRecord.provenance`, `workflow-result.ts:370`) via the extended
  `AgentResultProvenance`.
- **Budget.** The continuation turn's usage flows through the existing `onUsage` → `slot.usage`
  (`workflow.ts:1264-1268`) → `recordTokens` budget-debit path (`workflow.ts:1088-1102`) unchanged.
  The runner reports the post-reopen **delta** (§2.5), so the debit covers only the continuation turn
  and never re-charges replayed pre-pause usage. Pre-pause spend was reported to the paused run's
  telemetry, not to this resume; the journaled usage for a continued call covers the continuation
  turn as reported and — like all recorded usage (`JournalEntry.usage`, "A present value is a LOWER
  BOUND on true spend", `workflow-result.ts:164-168`) — remains a documented lower bound on true
  spend.

### 2.10 Engine: observability notices and marker propagation

**Notice channel.** Continuation outcomes surface through the identical channel model-selection
degrades already use: the `onFallback` callback (`workflow.ts:185`, invoked for model fallbacks at
`workflow.ts:1259-1262`) → `state.fallbacks` → `WorkflowRunResult.fallbacks[]`
(`workflow-result.ts:490`) → persisted `PersistedRunState.fallbacks[]` (`run-persistence.ts:170`),
where the manager's `onFallback` handler appends and persists the snapshot
(`workflow-manager.ts:1160-1163`). No dedicated fallback run-event type exists for model fallbacks
today, and continuation matches model fallbacks exactly; adding one would be a new observability
surface for both kinds, which the issue did not request (§5 rejected alt #4). A `kind:
"continuation"` notice is deduped through an extended `sameFallback` (`workflow.ts:2568`, which for
the continuation kind compares `callIndex` and the `continuation` detail) and emitted **through a
guarded invocation** — `guardTerminal("onFallback", () => options.onFallback?.(fallback))`, matching
the guarded journal emission (`workflow.ts:1366`) — so a throwing host callback is isolated and never
aborts the call (Invariant §2.1.2). A notice fires in exactly these situations, all within the
first attempt (retries emit no additional continuation notice):

- **Reattached (savings realized).** The settling/first-attempt provenance reports
  `continuation: { reattached: true, method }`: `{ kind: "continuation", callIndex, label, phase?,
  requestedSpec, backendId?, continuation: { outcome: "reattached", method }, message:
  "continuation: reattached via session/<method>" }`.
- **Skipped (engine gate).** A candidate existed at `callIndex` but an engine gate (§2.8) rejected it:
  `{ …, continuation: { outcome: "skipped", reason }, message: "continuation skipped (<reason>) —
  running fresh" }`.
- **Skipped (runner gate).** The runner attempted and abandoned reattach; the first-attempt
  provenance reports `continuation: { reattached: false, reason }` (§2.6): same shape with the
  runner's reason.
- **Skipped (runner-declined).** The engine passed `continueFromSession` (all engine gates held) but
  the first-attempt provenance carries **no** `continuation` field — a custom `AgentRunner` ignored
  the directive and ran fresh. The engine synthesizes `{ …, continuation: { outcome: "skipped",
  reason: "runner-declined" }, … }`, so an eligible candidate is never silently consumed without a
  notice.

No notice fires for the ordinary no-candidate live call, so continuation adds no per-call noise to
runs that were never paused. `requestedSpec` is `modelSpec ?? agentOptions.tier ?? "(default)"`,
matching the model-fallback emission (`workflow.ts:1254`).

**Marker propagation (closes lost-on-replay/projection).** The `continuation` journal marker is
preserved across every path that reconstructs journal/provenance metadata:

- **Re-journaling on a later replay hop.** `replayPreparedAgent` reconstructs the replayed entry's
  `call` metadata from the current call context (`workflow.ts:1483-1489`), which would drop the
  source marker. It must re-stamp `...(input.entry.call?.continuation ? { continuation:
  input.entry.call.continuation } : {})` so a continued call that later replays keeps recording that
  its result was originally produced via continuation.
- **Run-event journal projection.** The append-only journal-event projection reconstructs the agent
  arm's `call` from `event.entry.call` (`run-observability.ts:722-734`) and must add
  `...(event.entry.call.continuation === undefined ? {} : { continuation: event.entry.call.continuation })`.
- **Live provenance projection.** The run-event provenance projection rebuilds the `"live"` arm as
  `{ source: "live", overrideModel? }` (`run-observability.ts:474-484`) and must carry
  `...(provenance.continuation ? { continuation: provenance.continuation } : {})`. The
  corresponding event-validator (`run-event-persistence.ts` provenance predicate) admits the additive
  field.

### 2.11 Multi-hop, retry, and timeout semantics

- **Attempt-locality (retries).** `runLive()`'s attempt loop reuses one `callIndex` across retries
  (`workflow.ts:1194`). `continueFromSession` is passed **only on attempt 1** (§2.8). If attempt 1
  reattaches and the continuation turn then fails recoverably, attempt 2+ run fresh (`session/new` +
  original prompt) — the reattach is not retried, so no attempt can reopen a session another attempt
  already continued or closed. Terminal provenance and the journal marker come from whichever attempt
  settles the call (`slot.provenance` on the winning attempt); the notice reflects attempt 1's
  outcome and is deduped (§2.10).
- **Timeouts.** A continuation attempt that hits the per-attempt `withTimeout`
  (`workflow.ts:1302-1310`) is aborted and sealed like any attempt; `run()`'s `finally` releases its
  session (a timeout is not pause-class, so it may `session/close`). Attempt 2+ run fresh. A
  subsequent resume hop rebuilds the candidate from the snapshot; if the timed-out session was
  closed, its reattach fails to fresh — correctness preserved, savings simply not realized.
- **Consume-on-occurrence, not by hash.** Because candidates are index-keyed and each index's
  `runLive()` runs once per execution, no cross-occurrence consumption set is needed. A same-prompt
  loop assigns distinct indices; only the interrupted occurrence's index has a candidate, so only it
  reattaches — every other occurrence runs fresh with no notice.
- **Correctness across resume hops comes from the persisted rebuild, not from carrying state.** Each
  resume hop rebuilds the candidate map from the latest `PersistedRunState` (§2.7). If a prior hop
  completed the continued call, the new source records it as `outcome: "result"` with the agent row's
  `errorCode` cleared → no candidate. If a prior hop re-paused on it, the new snapshot holds the
  re-recorded session ref and pause-class `errorCode` → a fresh candidate for the next hop. Chained
  continuation therefore needs no cross-hop bookkeeping.

---

## 3. Failure-contract summary

Every deviation from the happy path runs the call fresh (`session/new` + original prompt) and never
changes the call's journaled identity. Consolidated:

1. Source not paused on `usage_limit`/`auth_required` → no candidate map; every call fresh (§2.7.1).
2. No root-scope agent row with a pause-class `errorCode` and a reopenable session ref at the call's
   index → not a candidate (§2.7.3). Nested (child-scope) interrupted agents are excluded by the
   root-scope filter and re-run fresh (§2.7.2, Non-goals §4).
3. Interrupted call's session ref advertises neither `reopen.resume` nor `reopen.load` → not a
   candidate (§2.7.3).
4. Live call's hash ≠ recorded hash at this index (script changed) → notice `hash-mismatch` (§2.8).
5. Live call's input fingerprint ≠ recorded fingerprint, or either absent → notice `inputs-mismatch`
   (§2.8).
6. Call is worktree-isolated → notice `worktree-isolated` (§2.8).
7. Recorded cwd ≠ resolved cwd → notice `cwd-mismatch` (§2.8).
8. Resolved cwd absent on disk → notice `cwd-missing` (§2.8).
9. Not the first retry attempt → later attempts run fresh, no extra notice (§2.8, §2.11).
10. Resolved backend id ≠ recorded backend id → notice `backend-mismatch` (§2.6).
11. Current connection advertises neither reopen method → notice `capability-missing` (§2.6).
12. `resume`/`load` RPC rejected, session gone, or spawn/auth error at reopen → notice
    `reattach-failed`; structured-tool state cleaned up before the fresh acquire (§2.5, §2.6).
13. Custom runner ignored `continueFromSession` (no continuation provenance) → notice
    `runner-declined` (§2.10).
14. Continuation turn produces empty/noncompliant output → existing live-call error paths, no silent
    fresh retry (§2.6).
15. Continuation turn hits a fresh pause-class error → re-pause; session kept reopenable (§2.4, §2.5,
    §2.11).

---

## 4. Non-goals (v1)

- **Killed-process recovery.** A crash/SIGKILL mid-turn never runs the pause-class release path
  (§2.4), so no `keepOpen: true` release fires and what the agent's persisted session contains at the
  kill point is backend-dependent. v1 scopes to graceful `usage_limit`/`auth_required` pauses only.
- **Durable-checkpoint pauses.** A `headless: "pause"` checkpoint pause (`CHECKPOINT_REQUIRED`,
  `errors.ts:27` / pause reason `checkpoint_required`, `workflow-manager.ts:322`) happens *between*
  turns at a checkpoint — there is no interrupted agent turn to continue, and `runReason` does not
  classify it as `usage_limit`/`auth_required`, so §2.7.1 produces no candidate for it.
- **Interrupted nested-`workflow()` agent calls.** A nested run executes with `preparedResume`,
  `resumeJournal`, and `preparedContinuation` all `undefined` (`workflow.ts:1878-1880`) — there is no
  continuation channel into a child execution — and its agents are recorded under a child scope that
  the root-scope candidate filter excludes (§2.7.2). An interrupted nested agent re-runs fresh exactly
  as today. This is a scope boundary grounded in the existing nested-execution model, not a change to
  it.
- **Worktree-isolated calls.** Excluded by the worktree gate (§2.8): the recorded worktree is removed
  at settle and recreated at a fresh path on resume; recovering it would require not deleting
  worktrees at settle (`workflow.ts:1419`), i.e. touching isolation behavior, itself a Non-goal.
- **Any change to call identity, replay identity, or the incremental-resume correspondence rules.**
  Continuation applies only to a call already running live; the `hashAgentCall` bytes
  (`workflow.ts:2958-2973`), the `hashCallInputs` bytes (`workflow.ts:2865-2879`), journal semantics,
  resume-matcher policy selection (`resume-matcher.ts:827-868`), and every other call's replay
  eligibility are computed exactly as before.

---

## 5. Rejected alternatives

1. **Piggyback the continuation candidate on the resume seed.** Rejected: the seed's promotion loop
   is built exclusively from `outcome === "result"` journal rows (`if (call.outcome !== "result")
   continue;`, `resume-matcher.ts:873-882`); the interrupted call is `outcome: "error"` and is
   excluded by design. A new additive channel is required. Overloading the seed would mean widening
   its construction to include error rows, perturbing the positional/identity replay logic the seed
   feeds — a change the issue's Non-goals forbid.

2. **Fold continuation into `PreparedResume`.** Rejected: the same-ID `resume()`/`resumeInBackground()`
   recovery path — the canonical pause→resume API — builds no `PreparedResume` and passes only
   `resumeJournal` (`workflow-manager.ts:1962`). A candidate carried only on `PreparedResume` would
   silently skip continuation on every same-ID recovery, contradicting default-on (Invariant §2.1.6).
   A standalone `preparedContinuation` engine option (§2.3f) is built and threaded on **both** resume
   entry points and is strategy-independent (Invariant §2.1.3), which also dissolves the question of
   whether a `PreparedResume.strategy === "live"` (replay-disabled) resume is eligible: it is, because
   continuation's own gates (§2.8) are the trust boundary, independent of replay admission.

3. **Seal the full session ref into `WorkflowCallRecord` and read the candidate from the call record
   alone.** Rejected: `WorkflowCallRecord` carries only `backendId` (`workflow-result.ts:346`), not
   the reopen surface. The reopenable ref lives in the per-agent snapshot (`state.agentSessions`,
   `workflow.ts:1135-1136`; `PersistedAgentState.session`, `run-persistence.ts:57`). Building the
   candidate as a `calls[]`×`agents[]` join on `(scope, callIndex)` (§2.7) reuses the persisted data
   as-is; duplicating the ref onto the call record would be a redundant, wider persisted surface.

4. **Model the continuation notice as a separate `onContinuation` callback +
   `WorkflowRunResult.continuations[]`, or a new fallback run-event type.** Rejected: the issue directs
   reuse of the existing `onFallback` channel, and hosts already subscribe to it; model fallbacks
   surface through `fallbacks[]` with no dedicated run-event, and continuation matches that exactly.
   A parallel surface (or a new event type serving both kinds) would add host-facing API the issue did
   not ask for. Widening the flat `WorkflowRunFallback` with a `"continuation"` kind and an optional
   detail object (§2.3e) is additive and non-breaking for existing `requestedSpec`/`kind` readers.

5. **Re-send the original prompt on the continuation turn.** Rejected: the original prompt is already
   in the reopened session's history; re-sending it invites a restart and doubles the work
   continuation exists to avoid. A fixed, runner-internal continuation instruction (§2.5) that demands
   the *complete* final answer keeps the extraction path honest against a pre-pause partial emission,
   and — crucially — is not a `hashAgentCall` input, so identity is untouched.

6. **Prefer `session/load` (with replay) over `session/resume`.** Rejected: continuation does not need
   the transcript streamed back to the client — the agent already holds the history on its side.
   `session/resume` reopens without replay (`acp-client.ts:1559-1560`), avoids the replayed-usage
   double-count (§2.5), and is preferred; `session/load` is the fallback for backends that advertise
   only it. The method is chosen against the **current** connection's advertised capabilities, not the
   recorded ref's flags (§2.6), so capability drift toward load-only degrades to load rather than
   spuriously failing.

7. **Gate continuation on the resume correspondence strategy (identity-v1 only).** Rejected:
   continuation is orthogonal to correspondence (Invariant §2.1.3). A pause-class resume in fact always
   runs `positional-v1` (`resume-matcher.ts:827-868`), so gating on `identity-v1` would disable
   continuation entirely. Serving at the strategy-independent `runLive()` boundary (§2.8) is correct
   and future-proof.

8. **Extend fail-to-fresh through the post-open setup (model/config/mode) to the continuation prompt
   being accepted.** Rejected: there is no mechanically observable "prompt accepted" signal —
   `SessionHandle.prompt()` resolves only after the whole turn (`acp-client.ts:2027-2044`). Post-open
   setup runs the *identical* calls a fresh run makes on the same model spec against a session that
   advertises the same config options, so a fresh retry would fail identically; falling to fresh there
   would loop and double-charge. The boundary is pinned at "reopen RPC resolved" (§2.6), the only
   observable seam; post-open failures follow the normal live-call paths (re-pause / empty-output /
   schema / abort).

9. **Key the candidate map by identity hash, with an ambiguity set for duplicate-hash interrupted
   calls and a consumed-hash set to prevent double reopen.** Rejected: a hash key cannot distinguish
   occurrences of an identical prompt. An earlier completed call sharing a hash with a later
   interrupted call would let the first live occurrence consume the interrupted call's session — the
   wrong occurrence — and a duplicate-hash interrupted pair would disable continuation for the whole
   hash. Keying by the deterministic call index (§2.2, §2.8) pins the exact occurrence, needs no
   ambiguity or consumption set, and reduces the identity check to a per-index `hash` verify. The
   `inputsHash` verify then guarantees the reattached turn's execution inputs match.

10. **Add a `poolKey` field to `AgentSessionRef` to catch custom-backend process drift.** Rejected as
    redundant: a same-named custom backend whose command changed produces a different approved-backends
    digest, which is a `hashCallInputs` input (`workflow.ts:995`), so the engine's `inputsHash` gate
    (§2.8) already rejects the reattach — with no new persisted field. The runner's `backendId`
    comparison (§2.6) covers routing to a different *logical* backend. Adding `poolKey` to the
    persisted ref would widen the surface for a case the input fingerprint already closes.

11. **Add a configuration flag or a token cap for continuation.** Rejected per repo policy: requested
    behavior ships default-on, and safety comes from the fail-to-fresh gates (§2.6, §2.8), not from a
    toggle. There is no configuration surface (Invariant §2.1.6).

---

## 6. Compatibility & semver

Additive minor across four packages; the two host-facing library packages take no new **inputs**:

- **`@automatalabs/shared-types`** (minor): `RunOptions.continueFromSession`;
  `AgentResultProvenance.continuation` + `ContinuationAttempt`; `ContinuationSkipReason`;
  `JournalCallMetadata` agent-arm `continuation`; `WorkflowRunFallback` `"continuation"` kind +
  `continuation` detail. All optional/additive; existing serializations and the pinned hash fixtures
  are unchanged.
- **`@automatalabs/acp-agents`** (minor): `run()` reattach path, `keepOpen`-on-pause release, the
  `keptOpen` pause-class stamp is engine-side, `CONTINUATION_INSTRUCTION`, `isProviderUsageLimitError`,
  `pool.acquirePreparedReattach` + `ReattachCapabilityUnavailable`, `UsageAccumulator`
  `baseline()`/`delta()`. No `AgentRunner` interface break — `continueFromSession` is optional and
  advisory.
- **`@automatalabs/workflow-engine`** (minor): `PreparedContinuation`/`ContinuationCandidate`;
  `WorkflowRunOptions.preparedContinuation` + `ManagerResumeExecution.preparedContinuation`;
  `buildPreparedContinuation` construction on both resume entry points; live-boundary selection, gates,
  `keptOpen` pause-class stamp, notices, and marker propagation across replay and the run-event
  projection.
- **`@automatalabs/mcp-server`** (minor): the result **output** schema `fallbackSchema.kind` widens
  from `["model","modifier"]` to include `"continuation"` and gains the optional `continuation` detail
  (`workflow-tool-output.ts:46-55`, used at `:125` and `:139`), so a continuation notice can pass
  through the MCP host. No new **input**; the single `workflow` tool's inputs are unchanged.
- **`@automatalabs/workflows`** (patch/transitive): no new inputs; it picks up the behavior through
  the engine.

`hashAgentCall()` and `hashCallInputs()` bytes are untouched (Invariant §2.1.1); no hash-fixture
change. A coordinated release ships all four minors together plus the transitive patch, with
Changesets per `CONTRIBUTING.md:73-85` (§8).

---

## 7. Test plan

Every normative statement above has coverage. Gated live suites follow the existing live-e2e pattern.

### 7.1 `@automatalabs/shared-types`

- **Hash invariants (§2.1.1).** Snapshot/byte tests assert `hashAgentCall()` and `hashCallInputs()`
  output are identical with and without any continuation-adjacent field in play, and the pinned hash
  fixtures are unchanged. (Focus directive: `hashAgentCall()` bytes untouched.)
- Type round-trip: `RunOptions.continueFromSession`, `AgentResultProvenance.continuation` (both
  `reattached` arms), every `ContinuationSkipReason` value, `JournalCallMetadata.continuation`, and the
  `WorkflowRunFallback` continuation notice JSON-serialize and parse unchanged.
- `WorkflowRunFallback` back-compat: an existing `kind: "model"` fallback with no `continuation` field
  still type-checks and round-trips (flat-interface guarantee, §2.3e).

### 7.2 `@automatalabs/acp-agents`

- **Pause-class release keeps the session open (§2.4).** A mock ACP server asserts no `session/close`
  when `run()` throws `PROVIDER_USAGE_LIMIT` and when it throws `AUTH_REQUIRED`; asserts a
  `session/close` *is* sent for a non-pause error without `keepSession`; asserts the success path is
  unchanged.
- **Reattach-and-continue happy path (§2.5).** With `continueFromSession` and a connection advertising
  `resume`, `run()` reopens via `session/resume` (no `session/new`), runs
  model-selection/configOptions/mode, sends the continuation instruction (not the original prompt),
  does not re-attach original images, and returns the extracted result; provenance reports
  `{ reattached: true, method: "resume" }`. Repeat for a `load`-only connection → `method: "load"`.
- **Fail-to-fresh (§2.6) — one case each:** `backend-mismatch` (ref backend ≠ resolved backend);
  `capability-missing` (current connection advertises neither); `reattach-failed` (mock rejects
  `session/resume`; and mock reports the session gone). Each asserts a subsequent `session/new` +
  original prompt runs and the reported provenance reason matches.
- **Capability drift (§2.6 gate 7).** Recorded ref advertised both `resume`+`load` but the current
  connection advertises only `load` → the pool picks `load` and reattaches (provenance
  `method: "load"`), not `reattach-failed`. Recorded ref advertised `resume` but the current
  connection advertises neither → `capability-missing` → fresh.
- **Post-open boundary (§2.6).** A reattach that succeeds but whose `setMode` then throws propagates
  as a live-call error (no fresh retry); a pause-class error on the continuation prompt re-pauses and
  releases with `keepOpen: true`; an abort during the continuation turn re-throws raw.
- **Reattach-failure cleanup, no leak/deadlock (§2.5, §2.6).** A schema run whose reattach RPC rejects
  after `prepare` registered the structured-output MCP tool and acquired the tool turn: assert the
  fresh `session/new` completes (no self-deadlock on the held turn) and the structured tool is
  registered exactly once (no double-register), by driving the repair ladder to a valid object.
- **Structured-output ladder over a continuation turn (§2.5).** A schema run that reattaches and
  continues drives the repair ladder and empty-output guard identically to a fresh schema run.
- **Second pause during continuation re-pauses cleanly (§2.5, §2.11).** A continuation turn that hits
  `PROVIDER_USAGE_LIMIT` propagates it, and the session is released with `keepOpen: true`.
- **`prepare` closure reuse (§2.5).** The reattach path attaches the same structured-output MCP
  server / `mcpServers` / `runId` stamp as the fresh path.
- **Load-replay usage delta (§2.5, §2.9).** A `load`-only mock replays historical `usage_update`
  notifications (cost + context tokens) during `session/load`, then the continuation turn reports new
  usage; assert the runner debits only the post-reopen delta (replayed cost/tokens excluded). A
  `resume` mock (no replay) reports its full continuation-turn usage unchanged (delta == raw).

### 7.3 `@automatalabs/workflow-engine`

- **Candidate map: pause-class + reopenable + root-scope only (§2.7).** Built only from root-scope
  agent rows whose joined `PersistedAgentState.errorCode` is `PROVIDER_USAGE_LIMIT`/`AUTH_REQUIRED`
  and whose session ref has `reopen.resume`/`reopen.load`; `result`/`null` rows, non-pause errors,
  and non-reopenable refs yield no candidate. A source paused on `checkpoint_required` yields an empty
  map. **Error-code disagreement:** a call whose `WorkflowCallRecord.error.code` differs from the
  joined agent row's `errorCode` is admitted/rejected on the **agent row's** `errorCode` (§2.7.3).
- **Scope-safe join (§2.7.2).** A snapshot with a nested child agent at `(scope: child, callIndex: 0)`
  and a root agent at `(scope: root, callIndex: 0)` builds a candidate only for the root row; the
  child row never overwrites or joins to the root. A pause inside `workflow()` yields no candidate for
  the child (the child ran with `preparedContinuation: undefined`), and the nested agent re-runs fresh.
- **Snapshot-only source (§2.1.4).** The interrupted call has no journal entry; its candidate is built
  from `agents[].session`. Assert the map is unchanged when the event log is present but the snapshot
  `session` is the only ref source, and that an event-log-only reconstruction finds nothing.
- **Both resume entry points (§2.7, Invariant §2.1.6).** A `usage_limit`-paused run resumed via
  same-ID `resumeInBackground()` reattaches (no `PreparedResume` built); the same run resumed via
  new-run `resumeFromRunId` reattaches; an `auth_required` same-ID resume reattaches only after the
  cold re-arm gate passes and re-pauses (no candidate consumed) when it fails.
- **Occurrence correspondence via index (§2.2, §2.8, closes hash-alias).** An identical-prompt loop
  where an *earlier* occurrence completed and a *later* occurrence was interrupted: on resume the
  earlier live occurrence runs fresh (its index has no candidate) and only the interrupted index
  reattaches. A same-hash completed+interrupted mixture never continues the wrong occurrence.
- **Identity + inputs gates (§2.8, closes hash-only match).** With a valid index candidate, changing
  the call at that index's prompt/model → `hash-mismatch` → fresh; changing an unhashed input
  (`images`, `mcpServers`, `promptMeta`, `meta`, `keepSession`, `label`, `timeout`, `retries`, `cwd`,
  or a same-named custom backend's command via the approved-backends digest) → `inputs-mismatch` →
  fresh; a legacy record with no `inputsHash`, or a call whose `callInputsHash` is absent →
  `inputs-mismatch` → fresh.
- **Gate matrix (§2.8).** One test per remaining engine gate — `worktree-isolated`, `cwd-mismatch`,
  `cwd-missing` — asserts fresh execution and the correct skip notice; a positive case asserts
  `continueFromSession` is passed to the runner with the recorded ref on `attempt === 1` only.
- **Retry + timeout (§2.11).** With `retries > 0`: attempt 1 reattaches and fails recoverably → attempt
  2 runs fresh (no `continueFromSession`), settles, and the journal marker reflects the settling
  attempt; a first-attempt reattach that times out aborts and attempt 2 runs fresh; a late timeout
  settlement does not double-emit the notice.
- **Backend gates from the engine's view (§2.6).** The engine surfaces the runner-reported
  `backend-mismatch`/`capability-missing`/`reattach-failed` reasons as `skipped` notices; a custom
  runner that ignores `continueFromSession` yields a `runner-declined` `skipped` notice (no silent
  consumption).
- **`keptOpen` honesty (§2.4, §2.9).** An automatic pause-class keep-open records
  `AgentSessionRecord.keptOpen === true` even though `keepSession` was not authored.
- **Journal identity + marker of a continued call (§2.9, Invariant §2.1.5).** A continued call's
  journal entry is byte-identical in identity fields (`hash`, `index`, `kind`) to a fresh live entry
  for the same call; the only difference is the additive `call.continuation` marker; replay of that
  entry ignores the marker and matches by hash exactly as for a fresh entry.
- **Marker preservation across replay + projection (§2.10).** A snapshot→replay→snapshot cycle keeps
  `call.continuation` on the re-journaled entry; the projected journal run-event carries
  `call.continuation`; the projected live provenance run-event carries `continuation`; the event
  validator admits both.
- **Notice plumbing + observer isolation (§2.10).** A successful reattach emits a `reattached` notice
  with the method (guarded); an engine-gate skip and a runner-gate skip emit `skipped` notices with the
  right reason; an ordinary no-candidate live call emits no continuation notice; a throwing
  `onFallback` host callback does not abort the call (Invariant §2.1.2).
- **Default-on, zero config (§2.1.6).** An eligible resume attempts continuation with no option set
  anywhere; `@automatalabs/workflows` inputs are unchanged.
- **Strategy independence (§2.1.3).** A `usage_limit`-paused source resumes via `positional-v1`
  (asserted from the resume report) and, separately, a resume whose admission is `live` (replay
  disabled) both still serve the continuation candidate at the live boundary.

### 7.4 `@automatalabs/mcp-server`

- **Output schema round-trip (§2.10, §6).** A `WorkflowRunResult` carrying a `kind: "continuation"`
  fallback (both `reattached` and `skipped` details) passes the widened `fallbackSchema` and survives
  `toWorkflowToolResult` → parse unchanged; an existing `kind: "model"` fallback still validates
  (back-compat).

### 7.5 Live e2e (gated like the existing live suites)

- Interrupt a real backend turn on a usage/auth wall, resume via the same-ID recovery API, and assert
  the continuation turn completes the original task without re-running the prefix work (observable via
  the agent's own history / token accounting and the `reattached` notice). Run for a `resume`-capable
  backend and, if available, a `load`-only backend.

---

## 8. Implementation breakdown

Four PR-sized stages, each green and independently reviewable; they ship as one coordinated additive
minor release (§6) with Changesets per `CONTRIBUTING.md:73-85`:

1. **PR1 — shared additive contract (`shared-types`).** `RunOptions.continueFromSession`;
   `ContinuationAttempt`/`AgentResultProvenance.continuation`; `ContinuationSkipReason`;
   `JournalCallMetadata.continuation`; `WorkflowRunFallback` continuation kind + detail. Type
   round-trip and hash-fixture non-regression tests (§7.1). No behavior change.
2. **PR2 — runner reattach + keep-open + usage delta (`acp-agents`).** `keepOpen`-on-pause release,
   `isProviderUsageLimitError`, `pool.acquirePreparedReattach` + `ReattachCapabilityUnavailable`,
   `run()` reattach path with cleanup and post-open boundary, `CONTINUATION_INSTRUCTION`,
   `UsageAccumulator` baseline/delta, provenance reporting. Mock-ACP tests (§7.2). Behavior reachable
   only when a caller passes `continueFromSession`.
3. **PR3 — engine candidate map, selection, notices, marker (`workflow-engine`).**
   `PreparedContinuation`/`ContinuationCandidate`; `buildPreparedContinuation` on both resume entry
   points; `preparedContinuation` plumbing through `executeRun`; live-boundary selection, gates,
   `keptOpen` pause-class stamp, guarded notices with `runner-declined`, and marker propagation across
   `replayPreparedAgent` + the run-event projection/validator. Engine unit tests (§7.3) plus the gated
   live e2e (§7.5). This is the stage that turns the default-on behavior on end-to-end.
4. **PR4 — MCP output schema + docs + changesets (`mcp-server`, docs, skill).** Widen
   `fallbackSchema.kind` and add the `continuation` detail in `workflow-tool-output.ts` with
   round-trip tests (§7.4); update the continuation-relevant docs and authoring surfaces that describe
   fallbacks as model-only and one-shot sessions as always fresh (`packages/workflow-engine/README.md`
   fallback wording; the workflow-authoring skill `skills/agentprism-workflow-authoring/SKILL.md` +
   `reference.md`; and, if it references fallback kinds or fresh-only resume, the generated MCP
   authoring prompt regenerated via `scripts/generate-authoring-prompt.mjs` with its CI drift test);
   add coordinated changesets for all four packages.

No stage changes synchronous `callSeq` allocation, `hashAgentCall`/`hashCallInputs` bytes,
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
- `AgentResultProvenance` live/replay union — `:33-40`
- `RunOptions` (additive infra fields are not hash inputs): `keepSession` `:192`; `onSessionOpen`
  `:198`; `callIndex` `:208`; `callHash` `:214`; `callPath` `:220`; `callInputsHash` `:221-226`

**`packages/shared-types/src/workflow-result.ts`**
- `AgentSessionRef` + `reopen` (load/resume/list/fork) — `:71-90`; `reopen.load/resume` `:80-90`
- `AgentSessionRecord extends AgentSessionRef` (callIndex `:97`, keptOpen `:101`) — `:93-101`
- `WorkflowRunFallback` (kind "model"/"modifier" `:116`, requestedSpec `:110`) — `:104-119`
- `JournalCallMetadata` agent arm (kind/label/phase/model/backendId) — `:137-145`
- `JournalEntry` (call `:161`; usage "LOWER BOUND on true spend" `:164-168`; scope `:171`) — `:152-172`
- `WorkflowCallRecord` (index `:314`, kind `:315`, hash `:317`, inputsHash `:322`, outcome `:327`,
  origin `:329`, error `:332`, backendId `:346`, isolation `:352`, resolvedCwd `:354`, provenance
  `:370`, scope `:372`) — `:312-373`
- `WorkflowRunResult.fallbacks` — `:490`

**`packages/shared-types/src/errors.ts`**
- `WorkflowErrorCode.PROVIDER_USAGE_LIMIT` `:19`; `AUTH_REQUIRED` `:24`; `CHECKPOINT_REQUIRED` `:27`
- `WorkflowRecordedError.code` — `:131`; `isProviderUsageLimit` `:158`; `isAuthRequired` `:162`

**`packages/acp-agents/src/runner.ts`**
- `run()` — `:721-920`; `prepareSession(prepared.backend)` `:743`; structured-tool state decl
  `:749-752`; `prepare` closure (MCP inject) `:754-783`; inline auth-retry cleanup pattern `:799-809`;
  fresh acquire (`pool.acquirePrepared`) `:791`; `onSessionOpen` fire (post-open, pre-prompt)
  `:822-824`; post-open sequence (model/configOptions/mode) `:831-835`; prompt build (`buildRunPrompt`)
  `:837`; images `:838-839`; prompt `:843`; stop-reason assert `:848`; schema repair ladder `:850-869`;
  empty-output guard `:874-878`; catch/`mapThrownError` `:881-890`; finally `onUsage` `:897` / release
  `keepOpen` `:909`; `acquireStructuredToolTurn` (per-connection serialization) `:926-935`
- `loadSession`/`resumeSession` runner methods — `:693-697`, `:714-717`
- `createInteractiveSession` reattach assembly (post-open mirror) — `:954-1005` (model/config/mode
  `:985-989`)
- `sessionRefFor` (reopen population from capabilities) — `:1375-1388`
- `isAuthRequiredError` — `:1428-1430`

**`packages/acp-agents/src/backend.ts`**
- `Backend.poolKey` (defaults to id; custom = id + spawn-config hash) — `:60-66`

**`packages/acp-agents/src/acp-client.ts`**
- `AGENT_METHODS.session_new/load/resume` — `:158-160`
- `SessionState.usage` `:191`; `beginTurn` does NOT reset usage `:223-234`; `usage_update` records
  cost + context tokens `:282-289`
- `assertLifecycleSupported` capability gate — `:1220-1234`
- connection `loadSession`/`resumeSession` → `reattachSession` — `:1554-1555`, `:1559-1560`,
  `:1620-1677` (fresh `SessionState` `:1627`; register-before-wire `:1653`; load/resume RPC
  `:1659`/`:1665`)
- `SessionHandle.prompt` (`beginTurn` `:2029`, `recordPromptUsage` `:2043`) — `:2027-2044`

**`packages/acp-agents/src/usage.ts`**
- `UsageAccumulator` — `:21-73`; cumulative `recordCost` `:33-37`; `recordContextTokens` `:45-48`;
  `toAgentUsage` `:50-72`

**`packages/acp-agents/src/pool.ts`**
- `AcpAgentPool.acquire` `:84-98`; `acquirePrepared` `:101-119`; `selectConnection` (poolKey identity
  `:129`, generation-gated) `:126-156`

**`packages/workflow-engine/src/workflow.ts`**
- `WorkflowRunOptions.preparedResume` `:169`; `onFallback` `:185`
- `backendsDigest` (approved script backends → `hashCallInputs`) — `:513`, consumed `:995`
- `resolvedIsolation` definition — `:967`
- `hashAgentCall` call `:975-982`; `hashCallInputs` call `:984-996`; `callSeq` alloc `:1000`;
  settle (records `inputsHash` `:1018`) `:1006-1025`
- `runLive` definition — `:1068`; `sessionRecord` (callIndex join, `keptOpen` `:1118`) `:1111-1120`;
  `emitFailure` seals session into `state.agentSessions` on error (`push` `:1136`) `:1124-1170`;
  `runCwd` resolution `:1192`; worktree create at fresh path `:1184`; attempt loop `:1194`;
  `agentRunner.run` options bag (additive seam) `:1206-1296`; `slot.sessionRef` via `onSessionOpen`
  `:1235-1239`; model-fallback emission template `:1245-1263` (`sameFallback` guard `:1259`,
  `requestedSpec` `:1254`); `onUsage` `:1264-1268`; `onResultProvenance` capture `:1270-1274`;
  `withTimeout` `:1302-1310`; success settle `:1328-1348`; live journal `call` metadata `:1358-1364`;
  worktree teardown at settle `:1419`
- `replayPreparedAgent` (reconstructs `call` metadata, drops continuation) — `:1423-1502`
  (`call` build `:1483-1489`)
- strategy convergence on `runLive`: `runPreparedAgent` `:1684`; `runManualAgent` journal-miss
  `:1759`; dispatch `:1762`
- nested `workflow()` child options (`resumeJournal`/`preparedResume` undefined) — `:1878-1880`
- `hashAgentCall` — `:2949-2975` (identity object `:2958-2973`, `model: model ?? null` `:2960`);
  `hashCallInputs` — `:2865-2879`; `sameFallback` — `:2568`

**`packages/workflow-engine/src/workflow-manager.ts`**
- `runReason` pause mapping (usage_limit `:320`, auth_required `:321`, checkpoint_required `:322`) —
  `:317-323`
- `latestRootRows` (root-scope filter) — `:303-309`
- `prepareManagedResume` — `:610-708` (identity-v1 `:640-648`, live `:651-660`, positional-v1
  `:688-707`; `managed.calls = latestRootRows(source.calls)` `:680-683`)
- `executeRun` (`preparedResume` read `:1071`, engine options bag `:1129-1132`, `onFallback` append +
  persist `:1160-1163`, `onAgentStart` stamps callIndex/scope `:1199-1200`, `onAgentEnd` matches
  `(scope, callIndex)` `:1217-1219`, `event.session` capture `:1236`)
- `resume()`/`resumeInBackground()` (same-ID recovery; `executeRun` with `resumeJournal` only
  `:1962`; auth cold re-arm gate `:1800-1841`; `managed.calls`/`journal` via `latestRootRows`
  `:1911`/`:1914`; `resumeJournal` build `:1937`)
- pause persist (`persistRun` in the pause `beforeLive` hook) — `:1369-1370`; agents-to-disk
  projection — `:1627-1631`
- `getPersistedAgentSessions` (snapshot session-read pattern) — `:2086-2101`

**`packages/workflow-engine/src/resume.ts`**
- `PreparedResume` union (identity-v1 `:95` / positional-v1 `:104` / live `:122` arms) — `:93-126`

**`packages/workflow-engine/src/resume-matcher.ts`**
- `allCallsRepresented` (interrupted error call ⇒ false; pending covers only checkpoint) — `:827-829`
- `fallbackReason: "unsafe-recording"` selection + `positional-v1`/`safe-prefix` — `:847-868`
- seed promotion filters non-`result` rows (`if (call.outcome !== "result") continue;` `:874`) —
  `:873-882`

**`packages/workflow-engine/src/run-persistence.ts`**
- `PersistedAgentState.errorCode` `:52`; `.session` `:57`; `.callIndex` `:64`; `.scope` `:65`;
  `.provenance` `:67`
- `PersistedRunState` (status `:133`, errorCode `:137`, pauseReason `:140`, agents `:152`, journal
  `:168`, fallbacks `:170`, calls `:173`)

**`packages/workflow-engine/src/run-event-persistence.ts`**
- event projections drop `session`: agent-end record `:536`; journal event `:555`

**`packages/workflow-engine/src/run-observability.ts`**
- `callStatus` (journal `call` → inspection status) — `:266-300`
- `projectProvenance` live arm (rebuilds `{ source: "live", overrideModel? }`, drops continuation) —
  `:474-484`
- journal run-event projection (rebuilds agent-arm `call`, drops continuation) — `:710-748` (agent arm
  `:722-734`)

**`packages/mcp-server/src/workflow-tool-output.ts`**
- `fallbackSchema` (`kind: z.enum(["model","modifier"])` `:53`) — `:46-55`; used in
  `executionResultSchema.fallbacks` `:125` and `workflowToolOutputShape.fallbacks` `:139`;
  `toWorkflowToolResult` `:232-246`

**`CONTRIBUTING.md`**
- Changesets requirement (add a changeset per PR; merging a changeset-bearing PR is the release) —
  `:73-85`
