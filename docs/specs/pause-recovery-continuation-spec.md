# Pause-recovery Session Continuation

> **Replay-strategy update (2026-07-21):** This document remains the frozen design record for ACP
> session continuation, but its claims that interrupted runs force `unsafe-recording` positional
> replay are superseded. Current-format interrupted calls are identity blockers: completed matching
> calls replay independently, while the interrupted call runs at the live boundary and may reattach
> through the continuation channel described here. See the current
> [journal replay contract](journal-replay-contract.md).

**Date:** 2026-07-15

**Status:** Frozen implementation contract for issue #183. Verified against base commit
`e9c94aa537b2ed75c81cf73eeb303cb9441bd346` (branch `spec/pause-recovery-continuation`, rebased onto
`origin/main`). Every file:line citation in this document was read at that SHA; see §9. The prior
freeze round pinned `7dd17af` and this revision mechanically re-pinned forward onto `origin/main` at
`e9c94aa`: the intervening commits (PRs #203/#204 — the `workflows config` command and a Version
Packages bump) touch no file this spec cites (`git diff 7dd17af..e9c94aa` over
`packages/{workflow-engine,acp-agents,shared-types}` is empty and `workflow-tool-output.ts` is
byte-identical), and the two doc surfaces they did shift (`docs/api.md`, root `README.md`) had their
§8 citations re-verified against the new tree. That earlier `7dd17af` base itself rebased off `c06d1e3`
after the #184 train (PRs #200–#202) advanced `origin/main` and restructured `run-persistence.ts`,
`workflow-manager.ts`, and `workflow-tool-output.ts`; §2.12 accounts for the two new engine surfaces
(`resumeSourceRunId`, `ExecOptions.executionAdmission`) that train added.

**References (files):** `packages/shared-types/src/agent-run.ts`;
`packages/shared-types/src/workflow-result.ts`; `packages/shared-types/src/errors.ts`;
`packages/acp-agents/src/runner.ts`; `packages/acp-agents/src/acp-client.ts`;
`packages/acp-agents/src/pool.ts`; `packages/acp-agents/src/backend.ts`;
`packages/acp-agents/src/backends/custom.ts`; `packages/acp-agents/src/registry.ts`;
`packages/acp-agents/src/capabilities.ts`; `packages/acp-agents/src/usage.ts`;
`packages/workflow-engine/src/workflow.ts`; `packages/workflow-engine/src/workflow-manager.ts`;
`packages/workflow-engine/src/resume.ts`; `packages/workflow-engine/src/resume-matcher.ts`;
`packages/workflow-engine/src/run-persistence.ts`;
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
  (`runner.ts:822-828`), handing the engine an `AgentSessionRef` — `{ sessionId, backendId, cwd,
  reopen: { load, resume, list, fork } }` (`workflow-result.ts:71-90`) whose `reopen` flags mirror
  what the connected agent advertised at initialize (`sessionRefFor`, `runner.ts:1375-1388`). The
  engine copies that ref into the call's attempt slot (`workflow.ts:1235-1239`) and, on **every**
  terminal transition including error settles, seals it into the per-agent snapshot
  (`emitFailure` → `state.agentSessions.push(session)`, `workflow.ts:1136`, via `sessionRecord`,
  `workflow.ts:1111-1120`).

- **The reopen path costs zero inference tokens.** The runner already serves capability-gated
  `session/load` (with transcript replay) and `session/resume` (without replay) as
  `loadSession`/`resumeSession` (`runner.ts:693`, `runner.ts:714`); the pooled connection
  drives them (`acp-client.ts:1554-1560`) and refuses them before any wire request when the backend
  did not advertise the capability (`assertLifecycleSupported`, `acp-client.ts:1220-1234`). Reopen is
  served from the agent's own on-disk session store, not by re-running the turn.

- **Pause classification is already precise and durable.** `WorkflowManager` maps
  `PROVIDER_USAGE_LIMIT` → pause reason `usage_limit` and `AUTH_REQUIRED` → `auth_required`
  (`runReason`, `workflow-manager.ts:325-331`), marks the run `paused` (never `failed`), and persists
  the full snapshot — including `agents[].session` and `agents[].errorCode` — to disk before
  releasing (`persistRun` in the pause `beforeLive` hook, `workflow-manager.ts:1384-1388`; agents
  projected at `workflow-manager.ts:1644-1648`; `PersistedAgentState.session`/`.errorCode` at
  `run-persistence.ts:57`/`:52`).

The missing piece is the connection: on resume, when the interrupted call comes up live again with an
unchanged identity hash **and** unchanged execution inputs, reattach to its recorded session and ask
the agent to **continue** the interrupted turn rather than restarting it.

Three facts about the existing resume machinery shape how continuation must be wired, and all are
load-bearing:

1. **The resume seed cannot carry the continuation candidate.** The manager's resume seed is built
   exclusively from `outcome === "result"` journal rows (the promotion loop filters
   `if (call.outcome !== "result") continue;`, `resume-matcher.ts:874`). The interrupted call is
   `outcome: "error"` and is excluded by design. Continuation therefore needs a **new, additive
   manager→engine channel** (`preparedContinuation`, §2.7), distinct from the seed and from
   `PreparedResume`.

2. **Continuation is independent of the correspondence strategy.** At this document's frozen base,
   an interrupted `outcome: "error"` call forced `fallbackReason: "unsafe-recording"` and
   `positional-v1`. The current matcher instead retains that non-result occurrence as an identity
   blocker: it runs live without invalidating completed matching calls around it. In both designs,
   continuation is served at the live boundary and does not depend on the replay strategy—or on
   whether a `PreparedResume` exists at all (§2.7, §2.8).

3. **Session refs reach disk only through the `PersistedRunState` snapshot.** The append-only
   event-log projections deliberately drop `session` from both the agent-end and journal events
   (`run-event-persistence.ts:536` and `run-event-persistence.ts:555`). The continuation candidate
   map must therefore be built from the snapshot's `agents[]` array (`run-persistence.ts:165`),
   **never** from the event stream.

**Continuation is a cheaper way to finish an interrupted live call. It never changes what a call
*is*.** The call's identity hash (`hashAgentCall`, `workflow.ts:2949-2975`), journal semantics, and
replay eligibility are untouched — same prompt, same hash; continuation only changes how the live
execution reaches its result. Every uncertainty about a candidate's eligibility or reattachability —
each gate up to and including the reopen RPC resolving — falls back to a fresh `session/new` + original
prompt (fail-to-fresh), mirroring the engine's fail-to-live posture: a skipped continuation costs
tokens, never correctness. (Once the reopen boundary is crossed the run is committed to the continuation
turn; a failure there is an ordinary live-call outcome, not a fresh fallback — §2.6, §3.)

---

## 2. The contract

### 2.1 Verified baseline and invariants

The implementation preserves these named invariants. Each has a test in §7.

1. **Unchanged hash bytes.** `hashAgentCall()` continues to hash, in its existing serialization,
   prompt, resolved model (`model: model ?? null`, `workflow.ts:2960`), `mode` only when set, sorted
   non-empty `configOptions`, tier, phase, agentType, resolved agent definition, and schema (the
   identity object, `workflow.ts:2958-2973`). Nothing continuation adds — the `continueFromSession`
   reattach directive, the runner-internal continuation instruction, the recorded session ref, the
   persisted `poolKey` spawn-identity, the reattach method, or any provenance/observability marker —
   is a `hashAgentCall` input. Pinned hash fixtures do not change. The separate input fingerprint
   `hashCallInputs()` (`workflow.ts:2865-2879`) is likewise unchanged; continuation **reads** it
   (§2.8) but does not add to it.

2. **Fail-to-fresh.** Every continuation eligibility gate (§2.8) and every runner-side reattach gate
   **up to and including the reopen RPC resolving** (§2.5, §2.6) that is not fully satisfied — for any
   reason other than caller cancellation (§2.6) — discards the continuation attempt and runs the call
   fresh (`session/new` + the original prompt) within the *same* attempt or a later retry of the *same*
   `run()`/`runLive()` invocation. A skipped or failed continuation never returns a guessed result,
   never aborts the call, and never changes the call's journaled identity. **Once the reopen boundary
   is crossed** the run is committed to the continuation turn; a later failure there (re-pause,
   empty-output, schema-noncompliance, abort) is an ordinary live-call outcome, **not** a fresh
   fallback (§2.6 post-boundary contract, §3). Fail-to-fresh is thus the pre-reopen-boundary posture,
   not a universal one.

3. **Continuation is strategy- and PreparedResume-independent.** A continued call is served at the
   `runLive()` live boundary (`workflow.ts:1684`, `workflow.ts:1759`), which both `identity-v1` and
   `positional-v1` resume strategies reach on a journal miss, and which the same-ID legacy resume
   path (`runManualAgent`, `workflow.ts:1759`) reaches on a journal miss too. The candidate is
   carried on a **standalone** `preparedContinuation` engine option (§2.3f), never folded into
   `PreparedResume`, so continuation is available on every pause-class resume regardless of
   correspondence strategy — including a resume whose `PreparedResume.strategy === "live"` (replay
   fully disabled) and the same-ID `resume()`/`resumeInBackground()` path, which builds no
   `PreparedResume` at all (`workflow-manager.ts:1980`).

4. **Candidate data comes only from the persisted snapshot.** The continuation candidate map is built
   by joining `PersistedRunState.calls[]` (`run-persistence.ts:186`) to `PersistedRunState.agents[]`
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
  /** The interrupted call's deterministic index (WorkflowCallRecord.index). Map key, and the
   *  value against which the persisted agent row's callIndex and its session.callIndex must both
   *  agree for the candidate to form (§2.7.3). */
  readonly callIndex: number;
  /** The interrupted call's identity hash (WorkflowCallRecord.hash). Verified against the live
   *  call's hash before reattach — a script edit that changed the call at this index fails it. */
  readonly hash: string;
  /** The interrupted call's input fingerprint (WorkflowCallRecord.inputsHash) — the strict-JSON
   *  hash of cwd/isolation/images/mcpServers/meta/promptMeta/keepSession/label/timeout/retries/
   *  approved-SCRIPT-backends digest (hashCallInputs, workflow.ts:2865-2879). Verified against the
   *  live call's fingerprint before reattach. Absent only on legacy pre-fingerprint records. */
  readonly inputsHash?: string;
  /** The re-attach handle sealed on the error settle (PersistedAgentState.session). Carries the
   *  recorded backendId, the persisted effective spawn identity (poolKey, §2.5/§2.6), and the
   *  agent-advertised reopen surface. */
  readonly sessionRef: AgentSessionRecord;
  /** The interrupted call's recorded execution directory (WorkflowCallRecord.resolvedCwd, falling
   *  back to sessionRef.cwd). Absolute. */
  readonly recordedCwd: string;
}

/** The additive manager→engine channel. Keyed by the interrupted call's index; each index maps to
 *  at most one interrupted, reopenable candidate (indices are unique per execution). */
export interface PreparedContinuation {
  readonly candidatesByIndex: ReadonlyMap<number, ContinuationCandidate>;
}
```

The candidate carries **no source-run id**: a `PreparedContinuation` is built from exactly one
persisted snapshot, so its provenance is that snapshot's `PersistedRunState.runId` (already known to
the manager that built it) and the engine's immutable `resumeSourceRunId` ancestry field (§2.12) —
continuation adds neither a per-candidate `sourceRunId` field nor any read/write of `resumeSourceRunId`.
`AgentSessionRef`/`AgentSessionRecord` and the `reopen` surface are unchanged apart from the additive
`poolKey` field (§2.3g, `workflow-result.ts:71-101`). The candidate carries no secrets and is
JSON-round-trippable — it is a projection of already-persisted data. Because the key space is the
unique call-index space, there is no ambiguity set and no cross-occurrence consumption set **within one
execution**: each index is reached at most once per execution (retries reuse the same index but are
handled attempt-locally, §2.8, §2.11). Consumption is **per-execution**, not global: several
`resumeFromRunId` executions that target the same still-paused source each build their own
`PreparedContinuation` from that snapshot and may each reattach the same recorded session — an
explicitly-permitted fan-out, §2.11.

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

The `onSessionOpen` JSDoc (`agent-run.ts:193-198`) is amended (§2.5): it fires **exactly once for
whichever session acquisition won** — `session/new`, or `session/resume`/`session/load` on a
successful reattach — never twice, and a failed reattach that falls to a fresh `session/new` fires it
exactly once for the fresh handle.

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

The base `AcpAgentRunner` reports this through the existing `onResultProvenance` callback
(`agent-run.ts:123`, captured at `workflow.ts:1270-1274`) **only when `continueFromSession` was
supplied** (otherwise it reports nothing, exactly as today, and the engine infers ordinary live
provenance). The `{ reattached: true, method }` report is emitted the instant the reopen handle is
obtained and **before** any post-open setup (§2.5), so a reattach that later fails or re-pauses is
still recorded as a reattach and can never be mislabeled `runner-declined`.

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
  | "backend-mismatch"   // continueFromSession backendId OR effective poolKey !== the resolved backend
  | "capability-missing" // the CURRENT connection advertises neither session/resume nor session/load
  | "reattach-failed"    // load/resume rejected, session gone, or a spawn/auth error at reopen
  // engine-synthesized (§2.10) — engine passed the directive but the runner reported no
  // continuation provenance (a custom AgentRunner that ignored continueFromSession ran fresh):
  | "runner-declined";
```

**(d) `JournalCallMetadata` continuation marker** — `packages/shared-types/src/workflow-result.ts`,
extending the `"agent"` arm (`workflow-result.ts:136-145`):

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
  /** Present when — and only when — the engine emits `kind: "continuation"`. See the emission
   *  invariant below; the type keeps it structurally optional so the flat interface stays
   *  non-breaking and no consumer must switch on `kind` to parse. */
  continuation?:
    | { outcome: "reattached"; method: "resume" | "load" }
    | { outcome: "skipped"; reason: ContinuationSkipReason };
}
```

**Emission/validation contract for the `continuation` detail.** The `kind`↔`continuation`
correlation is an **engine-emission invariant**, not a runtime-validation invariant: the engine sets
`continuation` **iff** it sets `kind: "continuation"`, and always sets it in that case (§2.10). The
type and every schema that mirrors it (the MCP output schema, §6) keep `continuation` structurally
**optional on every kind** — a flat, permissive shape — because the goal is to stay non-breaking for
the existing `{ kind: "model" | "modifier" }` readers and to remain forward-compatible. No consumer
rejects, strips, or throws on a "wrong" combination (`{ kind: "model", continuation }` or
`{ kind: "continuation" }` with no detail); it round-trips verbatim. The invariant is asserted by an
engine emission test and by positive/negative schema round-trip tests (§7.1, §7.4), not by a
discriminated-union refactor that would break the flat-interface guarantee.

**(f) Engine-internal `preparedContinuation` option (NOT shared-types).** A new optional field on the
engine's `WorkflowRunOptions` (`workflow.ts:169` neighborhood) and on the manager's `ManagedRun`
(`workflow-manager.ts:124` neighborhood): `preparedContinuation?: PreparedContinuation`. It is
engine/manager-internal wiring — never a `hashAgentCall`/`hashCallInputs` input, never surfaced to
`@automatalabs/workflows` or `@automatalabs/mcp-server` callers. It is **not** added to
`ManagerResumeExecution` (`workflow-manager.ts:165-169`): both resume entry points populate
`ManagedRun.preparedContinuation`, and `executeRun` reads exactly that one field (§2.7). Unlike
`resumeJournal`, `preparedContinuation` is journaling-independent — it carries persisted session
refs, not journal state, and is consulted purely at the live boundary — so it is **not** subject to
the `!managed.journaling && resumeJournal` rejection at `workflow-manager.ts:1108`; the manager only
ever builds it for a journaling resume of a paused run, and a bare-engine `runDynamicWorkflow` caller
leaves it `undefined`. A `preparedContinuation` supplied to a non-journaling run is therefore
harmless: its candidates are consulted at `runLive()` and every gate (§2.8) simply fails to fresh
unless the identical interrupted call comes up live.

**(g) `AgentSessionRef.poolKey` (effective spawn identity)** — `packages/shared-types/src/workflow-result.ts`,
added to `AgentSessionRef` (`workflow-result.ts:71-90`) and thereby inherited by
`AgentSessionRecord` (`workflow-result.ts:95-101`):

```ts
  /** The effective pool identity of the process that owns this session: the runner's resolved
   *  Backend.poolKey (`backend.ts:60-66`). For a custom backend that is `name` + a spawn-config hash
   *  over command/args/env; for a first-class backend it is deliberately the logical agent id
   *  (backendId), matching the pool's own process-identity model, which keys built-ins by bare id
   *  (`pool.ts:129`). A first-class backend's spawn config is NOT fixed — `spawnConfig()` varies with
   *  `AGENTPRISM_*_ACP_CMD/ARGS` env overrides and with installed-bin-vs-npx resolution
   *  (`backends/claude.ts:44-58`, and codex/opencode) and built-ins define no explicit `poolKey` — but
   *  every such launch of the same first-class agent shares one agent-side session store, so reattach
   *  stays semantically valid and the logical-agent identity is correct by design; a genuinely
   *  different program bound behind an env override is caught at the reopen RPC (`reattach-failed` →
   *  fresh, §2.6), not by this field. Persisted so a COLD resume can prove the currently-resolved
   *  backend is the SAME logical process identity that owns the recorded session (§2.6). ADDITIVE and
   *  NOT a hash input; absent on legacy pre-poolKey refs. */
  poolKey?: string;
```

### 2.4 Runner: keep the session reopenable on a pause-class release

Today `run()`'s `finally` releases the session with `keepOpen: opts.keepSession === true`
(`runner.ts:909`), so a normal error closes the agent-side session. Continuation requires the
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
(`workflow-result.ts:100`) documents whether the release-time `session/close` was skipped, and the
engine currently derives it solely from authored `keepSession` (`sessionRecord`,
`workflow.ts:1118`). On an automatic pause-class keep-open the close **is** skipped, so `keptOpen`
must record `true`. The engine's `sessionRecord(slot, keptOpen)` therefore takes the decision as an
argument; the success settle passes `agentOptions.keepSession === true`, and `emitFailure`
(`workflow.ts:1124-1170`, which already receives the thrown error and computes the mapped
`workflowError`) passes `agentOptions.keepSession === true || isProviderUsageLimit(workflowError) ||
isAuthRequired(workflowError)` before pushing the record at `workflow.ts:1136`. `keptOpen` is
diagnostic only — the candidate builder gates on the recorded `errorCode`, not on `keptOpen` (§2.7) —
but the field must not lie.

### 2.5 Runner: reattach-and-continue

Add a reattach acquire path to `run()`, gated on `opts.continueFromSession`. When it is set, the
runner attempts reopen-and-continue **before** the fresh `session/new` acquire (`runner.ts:791`); on
any non-cancellation failure it cleans up (below) and falls through to the unchanged fresh path. A
caller cancellation at any point wins outright (§2.6) — it propagates raw and never opens a fresh
`session/new`.

**Pool + connection primitive (new).** The round-2 draft read `connection.capabilities` synchronously
right after `selectConnection`, but a freshly-spawned connection's `capabilities` are `undefined`
until its one-time initialize handshake completes (`acp-client.ts:1169-1173`), and `ready` is private
(`acp-client.ts` `PooledConnection`). Reading capabilities before readiness would misclassify a
cold, actually-resume-capable connection as `capability-missing` and always fall fresh. The fresh
path avoids this by reserving the slot and awaiting `ready` **inside** the connection
(`openPreparedSession`, `acp-client.ts:1503-1515`). The reattach path mirrors that exactly with a new
initialized, slot-reserving `PooledConnection` method that awaits readiness, chooses the method from
the **now-negotiated** capabilities of that same connection, runs `prepare`, and opens the session
under one reservation:

```ts
// packages/acp-agents/src/acp-client.ts — PooledConnection (mirrors openPreparedSession)
async openPreparedReattachedSession(
  sessionId: string,
  prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
): Promise<{ handle: SessionHandle; method: "resume" | "load" }> {
  this._activeSessions += 1;                 // reserve the slot, exactly like openPreparedSession
  try {
    await this.ready;                        // capabilities are negotiated only after this resolves
    const caps = this.negotiated;            // internal field behind the `capabilities` getter
    const method: "resume" | "load" | undefined =
      caps?.supportsResumeSession ? "resume" : caps?.supportsLoadSession ? "load" : undefined;
    if (method === undefined) throw new ReattachCapabilityUnavailable(this.backendId, sessionId);
    const opts = await prepare(this);
    // Reattach under THIS single reservation (do NOT call the public resumeSession/loadSession,
    // which each reserve a second slot). Reuses the reattachSession body, extracted to a helper
    // that assumes the reservation and awaits ready + assertLifecycleSupported itself.
    const handle = await this.reattachReadySession(
      method === "resume" ? AGENT_METHODS.session_resume : AGENT_METHODS.session_load,
      sessionId, opts,
    );
    return { handle, method };
  } catch (error) {
    this._activeSessions -= 1;
    throw error;
  }
}
```

`reattachReadySession` is the current `reattachSession` body (`acp-client.ts:1620-1677`) with its
`_activeSessions += 1`/`-= 1` bookkeeping removed (the caller owns the reservation); the public
`resumeSession`/`loadSession` (`acp-client.ts:1554-1560`) keep their own bookkeeping and delegate to
it. Its internal `await this.ready` + `assertLifecycleSupported` (`acp-client.ts:1220-1234`) re-assert
the capability the method choice already used, so the method choice and the wire gate agree by
construction and re-registration on the fresh `SessionState` (`acp-client.ts:1627`, register-before-wire
`:1653`) is unchanged.

**Pool method (new).** `packages/acp-agents/src/pool.ts` gains `acquirePreparedReattach`, mirroring
`acquirePrepared` (`pool.ts:101-119`) but delegating to `openPreparedReattachedSession`, and — crucially —
letting the typed capability sentinel through **unmapped** so the runner can distinguish it:

```ts
async acquirePreparedReattach(
  backend: Backend,
  sessionId: string,
  prepare: (connection: PooledConnection) => AcpSessionOptions | Promise<AcpSessionOptions>,
  context: { signal?: AbortSignal; label?: string } = {},
): Promise<{ handle: SessionHandle; method: "resume" | "load" }> {
  if (this.disposed) throw new Error("ACP agent pool is disposed");
  const connection = this.selectConnection(backend);   // same generation-gated selection as acquire
  try {
    return await connection.openPreparedReattachedSession(sessionId, prepare);
  } catch (error) {
    if (context.signal?.aborted) throw error;                       // cancellation wins, raw (§2.6)
    if (error instanceof ReattachCapabilityUnavailable) throw error; // typed sentinel bypasses mapping
    throw mapThrownError(error, { label: context.label, backendId: connection.backendId, backend,
      authMethods: connection.capabilities?.authMethods });
  }
}
```

`ReattachCapabilityUnavailable` is a new runner-internal sentinel thrown **before** any wire request;
because `acquirePreparedReattach` rethrows it unmapped, the runner maps it to `capability-missing`,
and every other non-cancellation throw to `reattach-failed`.

**`run()` reattach path — attempted at most once, before/outside the inline-auth retry loop.** The
fresh `acquirePrepared` call at `runner.ts:791` sits **inside** a `for (;;)` inline-auth retry loop
(`runner.ts:789-816`) whose `authRetried` latch resolves one `AUTH_REQUIRED` thrown by the fresh
`session/new` and `continue`s the loop exactly once (§2.11). The reattach acquisition is **not** placed
inside that loop — a reattach re-run after an inline-auth `continue` would re-open a session the run
already discarded, double-report provenance, and violate discard semantics (Invariant §2.1.2) and
attempt-locality (§2.11). Instead, gated on `opts.continueFromSession`, a **single** reattach
acquisition runs **once, before the `for (;;)` loop is entered**, inside the existing `try` that
already holds the structured-tool state (`runner.ts:749-752`). It is attempted **at most once per
`run()` invocation**; on fall-to-fresh the run enters the unchanged `for (;;)` loop and from there
acquires only fresh `session/new`, never re-attempting the reattach on any iteration:

1. **Backend-identity gate (§2.6 `backend-mismatch`).** Resolve the call's backend from its model
   spec via the existing `prepareSession` (`prepared.backend`, `runner.ts:743`). Reattach only when
   **both** hold: `continueFromSession.backendId === prepared.backend.id`, **and** the normalized
   effective spawn identity matches —
   `(continueFromSession.poolKey ?? continueFromSession.backendId) === (prepared.backend.poolKey ?? prepared.backend.id)`
   (§2.3g; `Backend.poolKey`, `backend.ts:60-66`; a custom backend's `poolKey` hashes command/args/env,
   `backends/custom.ts:29`/`:46`). Otherwise report `{ reattached: false, reason: "backend-mismatch" }`
   and take the fresh path. The normalized comparison is total: for a first-class backend both sides
   collapse to `backendId` (no false mismatch — an env-override relaunch of the same first-class agent
   is deliberately the same logical identity, §2.3g, and a genuinely different program bound behind an
   override is caught at the reopen RPC, not here); for a custom backend both sides are the spawn hash
   (a host-registry command change → different hash → mismatch → fresh, §2.6);
   a legacy ref (no `poolKey`) collapses to `backendId` on the left and so reattaches only to a
   first-class backend, never to a custom one whose identity it cannot prove.
2. **Reattach (§2.6 `capability-missing`/`reattach-failed`).** Call
   `this.pool.acquirePreparedReattach(prepared.backend, continueFromSession.sessionId, prepare, ctx)`,
   reusing the **same** `prepare` closure the fresh path uses (so structured-output MCP injection,
   `mcpServers`, and `runId` stamping are identical). On success it returns `{ handle, method }`; the
   reattach acquisition is the **mechanically observable fail-to-fresh boundary** — the reopen RPC
   resolved and returned a `SessionHandle` — and the run proceeds directly to the continuation turn
   (below) and **never enters the fresh `for (;;)` loop**. On any throw:
   - the caller's `signal` is aborted → **cancellation wins**: rethrow raw, run no fresh `session/new`
     (§2.6).
   - `ReattachCapabilityUnavailable` → report `{ reattached: false, reason: "capability-missing" }`.
   - anything else (RPC rejection, session-gone, spawn/auth error — **including an `AUTH_REQUIRED`
     thrown by the reopen RPC itself**) → report `{ reattached: false, reason: "reattach-failed" }`.
     The reattach never enters the inline-auth resolve-and-retry-once machinery: an `AUTH_REQUIRED` at
     the `session/resume`/`session/load` reopen is a plain `reattach-failed` fall-to-fresh, not a
     reattach retry.
   For the two report cases, run the **fail-to-fresh cleanup** (below), then **fall through into the
   unchanged `for (;;)` loop, which from here acquires only fresh `session/new`** — the reattach is
   attempted at most once per `run()` invocation and is never re-attempted on a later loop iteration.
   The fresh loop's own inline-auth behavior on the fresh `session/new` is **entirely unchanged** from
   today (an `AUTH_REQUIRED` there is resolved and retried once by the existing `authRetried` latch, or
   propagates as the PR4 pause when `onAuth` is unset); the reattach one-shot and the fresh inline-auth
   one-shot are independent and never compound.

**Fail-to-fresh cleanup (§2.6, closes the schema-run deadlock).** The `prepare` closure may have
acquired the per-connection structured-tool turn (`releaseStructuredToolTurn`) and registered an MCP
tool (`structuredTool`, `structuredToolActive`) before the reopen RPC failed. Before the fresh
acquire the runner MUST run the identical cleanup the inline auth-retry already performs
(`runner.ts:799-809`): release the turn (`releaseStructuredToolTurn?.(); releaseStructuredToolTurn =
undefined;`), release the tool (`try { structuredTool?.release(); } catch {}
structuredTool = undefined; structuredToolActive = false;`), and discard any returned handle
(`try { await handle?.release({ keepOpen: false }); } catch {}`). Without releasing the turn first,
the fresh `acquirePrepared` → `prepare` → `acquireStructuredToolTurn` on the same connection would
await a turn this run still holds and deadlock (`runner.ts:926-935`). Each cleanup action is
best-effort and its own throw is swallowed — a throwing cleanup never masks or blocks the fresh path.
**After the cleanup and immediately before entering the fresh `for (;;)` acquire, the runner runs one
explicit `opts.signal?.throwIfAborted()` — the existing pattern at `runner.ts:818` — so a caller
cancellation that landed during the reattach acquire or its cleanup is caught at that checkpoint and
wins outright (raw abort, no fresh `session/new`, no skip notice, §2.6), never letting a fresh session
open after a cancellation this checked boundary observes.**

**On a successful reattach**, the run proceeds through the identical post-open sequence as a fresh
run and a mirror of `createInteractiveSession`'s reattach assembly (`runner.ts:954-1005`, model/config/mode
`:985-989`):

- **Provenance first (§2.6, closes the runner-declined mislabel).** Immediately after
  `acquirePreparedReattach` resolves and **before** any post-open setup, the runner reports
  `onResultProvenance({ source: "live", continuation: { reattached: true, method } })`. Committing the
  reattach provenance at the handle boundary means a later `applyModelSelection`/`setConfigOptions`/
  `setMode` failure surfaces as an ordinary live-call error, never as `runner-declined`.
- **Usage baseline (§2.9, closes load-replay double-count).** Immediately after
  `acquirePreparedReattach` resolves — which for `session/load` is after the transcript replay
  completes (the load response settles only once replayed `session/update` notifications have been
  processed into the fresh `SessionState`, `acp-client.ts:1627`,`:1653`) — the runner snapshots the
  session's usage accumulator baseline (`session.usage.baseline()`, §2.9) and reports, at settle,
  the **delta** from that baseline (`session.usage.delta(baseline)`) instead of the raw
  `toAgentUsage()`.
- `onSessionOpen` fires **once** with the reattached session's ref (`runner.ts:822-828`) — same
  `sessionId`, the agent's advertised reopen surface, and the effective `poolKey` (§2.3g) — so the
  engine re-records the session for a possible next-hop continuation (§2.11). Because the fresh path
  is only taken when the reattach acquire failed *before* this point, `onSessionOpen` fires exactly
  once per `run()`, for the acquisition that won.
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

The `keepOpen`-on-pause rule (§2.4) applies to the continuation turn too: a **second** pause-class
error during continuation propagates normally, the run pauses again, and the (re-recorded) session is
again kept reopenable — continuation can chain across successive pauses (§2.11).

### 2.6 Runner: fail-to-fresh and cancellation failure contract

Each runner-side gate that is not a caller cancellation discards the continuation attempt and runs the
call fresh in the same `run()` invocation. The runner reports the reason on
`AgentResultProvenance.continuation`; the engine turns it into an observability notice (§2.10).

| Gate | Condition to reattach | On failure (not cancelled) |
| --- | --- | --- |
| Backend identity | `continueFromSession.backendId === prepared.backend.id` AND normalized `poolKey` equal (§2.5) | report `backend-mismatch`; cleanup; fresh `session/new` + original prompt |
| Reopen capability (current connection) | the selected pooled connection, once `ready`, advertises `session/resume` or `session/load` | report `capability-missing`; cleanup; fresh path |
| Reattach accepted | the `resume`/`load` RPC resolves and returns a `SessionHandle` (no capability error, no RPC rejection, no session-gone, no spawn/auth error) | report `reattach-failed`; cleanup; fresh path |

**Cancellation wins at the checked boundaries.** A caller `signal` abort during connection initialize,
`prepare`, the reopen RPC, or any post-open step is **not** a fail-to-fresh case: the run performs
best-effort partial cleanup (the same release actions above, each swallowing its own throw), emits
**no** continuation skip notice, and propagates the abort **raw** — matching the existing runner
posture (`runner.ts:883`; the pool and `acquirePreparedReattach` rethrow raw when `signal.aborted`).
The guarantee that a cancelled reattach **never opens a fresh `session/new`** is enforced by the
explicit checkpoint mandated above — the `opts.signal?.throwIfAborted()` run after fail-to-fresh
cleanup and immediately before the fresh acquire (`runner.ts:818` pattern) — plus the existing
pre/post-prompt `throwIfAborted` checks (`runner.ts:818`,`:832`,`:834`,`:844`): an abort observed at
any of those checked boundaries aborts before the fresh acquire runs. The categorical claim scopes to
those checked boundaries; a `signal` that fires and is cleared in the sub-millisecond window between
the check and the acquire is the same theoretical race the fresh path already carries today and is not
made worse here. The fail-to-fresh summary in §3 and Invariant §2.1.2 govern only non-cancellation
failures before the reopen boundary.

**The fail-to-fresh window is exactly the reattach acquisition** — from the `continueFromSession`
directive through the reopen RPC resolving. This is the only mechanically observable boundary:
`SessionHandle.prompt()` resolves only after the whole turn, with no separate "prompt accepted"
acknowledgement (`acp-client.ts:2027-2044`). Once the handle is in hand the run is committed to the
continuation turn, the `{ reattached: true, method }` provenance is already reported (§2.5), and every
later step is a genuine live-call outcome, not a fresh-fallback candidate:

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
status is `paused` with pause reason `usage_limit` or `auth_required`, on both resume entry points,
and stamps it onto `ManagedRun.preparedContinuation` (§2.3f) — the single field `executeRun` reads. A
private helper `buildPreparedContinuation(persisted: PersistedRunState): PreparedContinuation |
undefined` is called from both:

- **New-run resume (`resumeFromRunId`).** `prepareManagedResume` (`workflow-manager.ts:618-716`) has
  both the `managed` run and the `source` snapshot in hand; it sets
  `managed.preparedContinuation = this.buildPreparedContinuation(source)` for all three admission
  strategies (`identity-v1` `:646-656`, `live` `:659-668`, `positional-v1` `:696-715`) — it is
  independent of `PreparedResume` (Invariant §2.1.3).
- **Same-ID recovery (`resume()`/`resumeInBackground()`).** This path builds `managed` directly with
  the loaded `persisted` snapshot in hand and today passes only `resumeJournal` to `executeRun`
  (`workflow-manager.ts:1980`). Before that call it sets
  `managed.preparedContinuation = this.buildPreparedContinuation(persisted)`. For an `auth_required`
  source this runs **after** the existing cold re-arm gate (`workflow-manager.ts:1817-1858`): if the
  runner's auth did not survive, the gate re-pauses and returns before `managed` is even built, so no
  candidate is ever consumed; if it survived, continuation is served on the live path exactly as on
  the new-run API.

`executeRun` reads `managed.preparedContinuation` once and threads it into the engine options bag next
to `preparedResume` (`workflow-manager.ts:1148`), so `runWorkflow` receives it as
`WorkflowRunOptions.preparedContinuation`. Threading occurs strictly **after** the admission latch
(§2.12), so a denied admission never reaches `runWorkflow` and never consumes a candidate.

`buildPreparedContinuation` (mirrors the `getPersistedAgentSessions` snapshot read,
`workflow-manager.ts:2104-2119`, joined to the root-scope call manifest the manager already
materializes, `latestRootRows`, `workflow-manager.ts:311-317`). It is a **total fail-to-fresh
projection**: every malformed, absent, or incoherent input yields *no candidate for that index* and
**never throws** — persistence loads run state by cast, not validation, so the builder validates
defensively and a bad row can only reduce eligibility, never crash resume:

1. **Gate on pause class.** Return `undefined` unless `persisted.status === "paused"`
   (`run-persistence.ts:146`) and `persisted.pauseReason` ∈ `{ "usage_limit", "auth_required" }`
   (`run-persistence.ts:153`). `checkpoint_required`, `completed`, `failed`, and `aborted` sources
   produce none (Non-goals §4).
2. **Index the session refs by call index, root scope only.** For each `PersistedAgentState` in
   `persisted.agents` (`run-persistence.ts:165`; treat a missing/non-array `agents` as empty) whose
   `scope` is undefined or equals `persisted.runId` (root scope, mirroring `latestRootRows`) and that
   has a `session` (`run-persistence.ts:57`) with a safe-integer `session.callIndex`, an `errorCode`
   (`run-persistence.ts:52`), a terminal **`status === "error"`** (`run-persistence.ts:47`; a row that
   did not settle as an error is not an interrupted call and is dropped), and an **own `callIndex` that
   is a non-negative safe integer equal to `session.callIndex`** (`run-persistence.ts:64`; a row whose
   two indexes disagree, or whose index is absent/non-integer, is dropped — it cannot be safely joined),
   key it by that shared index. **Root-scope
   filtering is mandatory:** nested `workflow()` agents are recorded with child-local indexes and a
   child `scope` (`onAgentStart` stamps `callIndex`/`scope`, `workflow-manager.ts:1215-1216`;
   `onAgentEnd` matches on the `(scope, callIndex)` pair, `:1233-1234`), so a child `callIndex: 0`
   would otherwise collide with the root row at index 0. The interrupted call has no journal entry, so
   its ref is read from `agents[]`, never from the journal or the event stream (Invariant §2.1.4).
   Later rows win per index (last-write, matching `latestRootRows`).
3. **Join to the root-scope call manifest and filter.** For each `WorkflowCallRecord` in
   `latestRootRows(persisted.calls ?? [], persisted.runId)` (`run-persistence.ts:186`; a missing
   `calls` is empty), keep it as a candidate iff **all** hold:
   - `record.kind === "agent"` (`workflow-result.ts:315`);
   - **`record.outcome === "error"`** (`workflow-result.ts:327`) — the interrupted call settled as an
     error; a `result` or `null`/absent-outcome row is never a candidate (this is what makes §7.3's
     "result/null rows yield no candidate" true by construction, and prevents pairing a stale
     pause-class agent row with a completed call);
   - `record.index` is a non-negative safe integer, and a session ref **and** an `errorCode` exist at
     `record.index` from step 2 (the coherent `(scope, callIndex)` join), and that joined
     **`PersistedAgentState.errorCode`** ∈ `{ PROVIDER_USAGE_LIMIT, AUTH_REQUIRED }` (`errors.ts:19`,
     `:24`). The pause-class test reads the agent row's `errorCode` (the authoritative settle-time
     code, per the issue's verification comment), **not** `WorkflowCallRecord.error.code`; the call
     record supplies only identity/cwd (`hash`, `inputsHash`, `resolvedCwd`). This avoids a
     disagreement bug when the two disagree (tested, §7.3).
   - the joined session ref advertises `reopen.resume === true || reopen.load === true`
     (`workflow-result.ts:80-90`), and is otherwise well-formed (a non-object/malformed ref is
     dropped, not thrown on);
   - **cross-field coherence:** the joined `session.backendId` equals `record.backendId`
     (`workflow-result.ts:346`; a call record whose backend disagrees with its session ref's backend is
     incoherent and dropped), and — **when both are present** — the joined `session.cwd`
     (`workflow-result.ts:78`) equals `record.resolvedCwd` (`workflow-result.ts:354`; a divergent
     recorded cwd pair is incoherent and dropped). These are the settle-time record↔ref consistency
     checks; the *live*-value gates (runner backend/`poolKey`, engine cwd equality+existence) still run
     downstream at reattach (§2.6/§2.8), and a missing side of the cwd pair is tolerated and left to
     those gates rather than dropping the candidate.
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
mcpServers, meta, promptMeta, keepSession, label, timeout, retries, and the approved-**script**-backends
digest (`workflow.ts:984-996`). A hash match alone would let a resume that changed an image, an
MCP/tool surface, prompt metadata, or a same-named script backend's command reattach to the old turn
and return an answer computed for stale inputs. Requiring `candidate.inputsHash === callInputsHash`
(both already persisted — `WorkflowCallRecord.inputsHash`, `workflow-result.ts:322`, and the live
`callInputsHash`, `agent-run.ts:221-226`) reinstates fail-to-fresh for every such change with **no
new persisted engine surface**. The missing-fingerprint rule is explicit: if either side lacks a
fingerprint (a legacy pre-fingerprint record, or a call whose inputs failed strict-JSON
canonicalization), `inputs-mismatch` fires and the call runs fresh — continuation never proceeds on
unproven inputs.

Rationale for the two cwd gates: call worktrees are removed at settle (`workflow.ts:1419`) and
recreated at a fresh path on resume (`createWorktree(baseCwd, \`${runId}-${callIndex}-${label}\`)`,
`workflow.ts:1184`, with a new `runId`), so a worktree-isolated call's recorded cwd is gone
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

**Backend-instance identity is pinned across the engine and runner gates.** The engine's `inputsHash`
gate catches a changed **script-declared** backend (its command feeds the approved-script-backends
digest, a `hashCallInputs` input, `workflow.ts:995`). It does **not** catch a **host-registry**
backend that shadows the same name: `registryWithRunBackends` lets host registrations win on a name
conflict (`registry.ts:90`) without touching `scriptBackends`, so a host-defined custom backend can
change command/args/env with the script hash unchanged. That case is closed runner-side by the
persisted-`poolKey` spawn-identity gate (§2.6): the recorded ref carries the effective `poolKey`
(§2.3g), and the runner requires the currently-resolved backend's normalized `poolKey` to match. The
two gates together pin backend-instance identity for both script and host backends (§5 rejected alt #10).

### 2.9 Engine: journaling, provenance, and budget

A continued call settles through the ordinary live-call path — no special-casing of its identity:

- **Journal identity.** Same `hash`, current `index`, and the settle path already used for a live
  runner attempt (`origin: "runner"`, `workflow.ts:1328-1348`). Its reattached session ref is
  recorded through the normal `onSessionOpen` → `slot.sessionRef` → `sessionRecord` flow
  (`workflow.ts:1235-1239`, `:1111-1120`).
- **Diagnostic marker.** When the **settling** attempt's provenance (`slot.provenance`, populated from
  the runner's `onResultProvenance` report, `workflow.ts:1270-1274`, and fresh per attempt because
  `slot` is re-created each pass, `workflow.ts:1195`) carries `continuation: { reattached: true,
  method }`, the engine writes `continuation: { method }` onto the journal entry's `call` metadata
  (the live journal build at `workflow.ts:1358-1364`, right after `backendId` `:1363`,
  `JournalCallMetadata` agent arm, §2.3d). Because `slot` is per-attempt, an attempt-1 reattach that
  fails recoverably followed by a fresh attempt-2 settle records **no** marker — the settling
  attempt's `slot.provenance` is `undefined`. This marker is diagnostic only; it is not a
  `hashAgentCall`/`hashCallInputs` input and replay never consults it (Invariant §2.1.5), but it is
  preserved verbatim across re-journaling and event projection (§2.10). The full attempt outcome
  (including a runner-side skip) is already durably visible on the call record's `provenance`
  (`WorkflowCallRecord.provenance`, `workflow-result.ts:370`) via the extended `AgentResultProvenance`.
- **Budget.** The continuation turn's usage flows through the existing `onUsage` → `slot.usage`
  (`workflow.ts:1264-1268`) → `recordTokens` budget-debit path unchanged. The runner reports the
  post-reopen **delta** (below), so the debit covers only the continuation turn and never re-charges
  replayed pre-pause usage. Pre-pause spend was reported to the paused run's telemetry, not to this
  resume; the journaled usage for a continued call covers the continuation turn as reported and —
  like all recorded usage (`JournalEntry.usage`, "A present value is a LOWER BOUND on true spend",
  `workflow-result.ts:164-168`) — remains a documented lower bound on true spend.

**Usage baseline/delta arithmetic (`usage.ts`, additive, internal).** `UsageAccumulator`
(`usage.ts:21-73`) holds three channels: the authoritative **per-turn** `promptUsage`
(overwritten each `prompt()`, `acp-client.ts:2043`), the latest **cumulative** dollar `costAmount`
(`recordCost`, `usage.ts:33-37`), and the current-context **gauge** `contextUsedTokens`
(`recordContextTokens`, `usage.ts:45-48`). On `session/load`, replayed `usage_update` notifications
feed `costAmount` and `contextUsedTokens` (`acp-client.ts:282-289`) but **never** `promptUsage`
(replay carries no `PromptResponse.usage`). So only the cumulative/gauge channels are polluted by
replay; the per-turn breakdown is already scoped to the continuation turn. Add:

```ts
// usage.ts (additive)
interface UsageBaseline { costAmount: number; contextUsedTokens: number; }
baseline(): UsageBaseline;                    // { costAmount, contextUsedTokens } snapshot
delta(baseline: UsageBaseline): AgentUsage;   // per-field, below
```

`delta(baseline)` returns, for every `AgentUsage` field:

- When `promptUsage` is present (authoritative breakdown fired on the continuation turn):
  `input`/`output`/`cacheRead`/`cacheWrite`/`total` = the per-turn `promptUsage` values **unchanged**
  (they are already per-turn, not baseline-adjusted); `cost` = `max(0, costAmount − baseline.costAmount)`.
- When `promptUsage` is absent (only `usage_update` fired): `input=output=cacheRead=cacheWrite=0`,
  `total` = `max(0, contextUsedTokens − baseline.contextUsedTokens)` (the gauge growth over the turn),
  `cost` = `max(0, costAmount − baseline.costAmount)`.

Every subtraction clamps to `≥ 0`, so a backend that **resets** cumulative cost on reopen, **compacts**
context so `contextUsedTokens` decreases, or emits **no** post-baseline update yields a non-negative
result and preserves the documented lower-bound invariant (a `total === 0` with no `promptUsage` is
the existing "provider reported nothing" sentinel, and the engine's chars/4 estimate then applies to
the continuation prompt exactly as for a fresh call). For `session/resume` (no replay) the baseline is
captured on a fresh per-session accumulator (`reattachSession` builds a new `SessionState`,
`acp-client.ts:1627`; `SessionState.usage`, `acp-client.ts:191`), so `baseline` is
`{ costAmount: 0, contextUsedTokens: 0 }` and the delta equals the raw continuation-turn usage. The
runner uses `delta(baseline)` in place of `toAgentUsage()` at the settle `onUsage` (`runner.ts:897`)
only on a reattach; a fresh run reports `toAgentUsage()` unchanged.

### 2.10 Engine: observability notices and marker propagation

**Notice channel.** Continuation outcomes surface through the identical channel model-selection
degrades already use: the engine appends a `WorkflowRunFallback` to `state.fallbacks` and invokes the
`onFallback` callback (`workflow.ts:185`; model fallbacks do the same at `workflow.ts:1259-1262`) →
`WorkflowRunResult.fallbacks[]` (`workflow-result.ts:490`) → persisted
`PersistedRunState.fallbacks[]` (`run-persistence.ts:183`), where the manager's `onFallback` handler
appends and persists the snapshot (`workflow-manager.ts:1176-1179`). No dedicated fallback run-event
type exists for model fallbacks today, and continuation matches model fallbacks exactly; adding one
would be a new observability surface for both kinds, which the issue did not request (§5 rejected alt
#4). A `kind: "continuation"` notice is deduped through an extended `sameFallback`
(`workflow.ts:2568`, which for the continuation kind compares `callIndex` and the `continuation`
detail) and its `onFallback` invocation is isolated by the engine's terminal-callback guard
(`guardTerminal`, as used for the journal emission at `workflow.ts:1366`) so a throwing host callback
never aborts the call (Invariant §2.1.2). Exactly one continuation notice fires per call, tied to
**attempt 1** (later attempts pass no `continueFromSession` and emit none):

- **Reattached (savings realized).** Attempt 1's settling provenance reports
  `continuation: { reattached: true, method }`: `{ kind: "continuation", callIndex, label, phase?,
  requestedSpec, backendId?, continuation: { outcome: "reattached", method }, message:
  "continuation: reattached via session/<method>" }`. Emitted after the attempt-1 runner call settles
  (resolve or reject), so a re-pause on the continuation turn still records that the reattach happened.
- **Skipped (engine gate).** A candidate existed at `callIndex` but an engine gate (§2.8) rejected it
  before the runner was called: `{ …, continuation: { outcome: "skipped", reason }, message:
  "continuation skipped (<reason>) — running fresh" }`. Emitted at attempt 1, before `agentRunner.run`.
- **Skipped (runner gate).** The engine passed the directive; attempt 1's provenance reports
  `continuation: { reattached: false, reason }` (§2.6): same shape with the runner's reason.
- **Skipped (runner-declined).** The engine passed `continueFromSession` (all engine gates held) but
  attempt 1's provenance carries **no** `continuation` field — a custom `AgentRunner` ignored the
  directive and ran fresh. The engine synthesizes `{ …, continuation: { outcome: "skipped",
  reason: "runner-declined" }, … }`, so an eligible candidate is never silently consumed without a
  notice.

A cancelled attempt (caller abort, §2.6) emits **no** continuation notice — with one carve-out: an
engine-gate `skipped` notice is emitted at gate time, *before* the fresh `agentRunner.run`, and records
a final, true fact (a candidate existed at this index and that engine gate rejected it). That fact does
not become false if the subsequent fresh call is later cancelled, so the already-emitted engine-gate
skip notice stands. The "cancelled attempt emits no notice" rule governs the reattach/continuation
attempt *outcome* (the `reattached`/runner-`skipped`/`runner-declined` notices, all tied to the
attempt-1 runner settle), not a gate rejection that settled before any runner call began. No notice
fires for the ordinary no-candidate live call, so continuation adds no per-call noise to runs that were
never paused. When a paused-run resume produces **no attempt at all** for a call — no candidate was
constructed, e.g. the source agent row advertised no reopen surface or carried a non-pause `errorCode`
(§2.7) — that construction-time ineligibility is deliberately silent on the per-call notice channel
(the notice channel reports *attempt outcomes*, per the issue), but it is inspectable post-hoc from the
persisted source snapshot (`agents[].session.reopen`, `agents[].errorCode`, via
`getPersistedAgentSessions`), so a host can always answer "why was there no continuation attempt here."
`requestedSpec` is `modelSpec ?? agentOptions.tier ?? "(default)"`, matching the model-fallback
emission (`workflow.ts:1254`).

**Marker propagation (closes lost-on-replay/projection).** The `continuation` journal marker is
preserved across every path that reconstructs journal/provenance metadata:

- **Re-journaling on a later replay hop.** `replayPreparedAgent` reconstructs the replayed entry's
  `call` metadata from the current call context (`workflow.ts:1483-1489`), which would drop the
  source marker. It must re-stamp `...(input.entry.call?.continuation ? { continuation:
  input.entry.call.continuation } : {})` so a continued call that later replays keeps recording that
  its result was originally produced via continuation.
- **Run-event journal projection.** The append-only journal-event projection reconstructs the agent
  arm's `call` from `event.entry.call` (`run-observability.ts:722-734`, right after `backendId`
  `:731-733`) and must add
  `...(event.entry.call.continuation === undefined ? {} : { continuation: event.entry.call.continuation })`.
- **Live provenance projection.** The run-event provenance projection rebuilds the `"live"` arm as
  `{ source: "live", overrideModel? }` (`run-observability.ts:474-484`, `source: "live"` `:480`) and
  must carry `...(provenance.continuation ? { continuation: provenance.continuation } : {})`. The
  corresponding event-validator (the provenance predicate in `run-event-persistence.ts`) admits the
  additive field.

### 2.11 Multi-hop, retry, and timeout semantics

- **Attempt-locality (retries).** `runLive()`'s attempt loop reuses one `callIndex` across retries
  (`workflow.ts:1194`) but creates a fresh `slot` each pass (`workflow.ts:1195`). `continueFromSession`
  is passed **only on attempt 1** (§2.8). If attempt 1 reattaches and the continuation turn then fails
  recoverably, attempt 2+ run fresh (`session/new` + original prompt) — the reattach is not retried, so
  no attempt can reopen a session another attempt already continued or closed. Terminal provenance and
  the journal marker come from the settling attempt's `slot.provenance`; a fresh attempt-2 settle
  therefore records no marker (§2.9), and the notice reflects attempt 1's outcome and is deduped (§2.10).
- **Timeouts.** A continuation attempt that hits the per-attempt `withTimeout`
  (`workflow.ts:1302-1310`) is aborted and sealed like any attempt; `run()`'s `finally` releases its
  session (a timeout is not pause-class, so it may `session/close`). Attempt 2+ run fresh. A
  subsequent resume hop rebuilds the candidate from the snapshot; if the timed-out session was
  closed, its reattach fails to fresh — correctness preserved, savings simply not realized.
- **Consume-on-occurrence, not by hash.** Because candidates are index-keyed and each index's
  `runLive()` runs once per execution, no cross-occurrence consumption set is needed. A same-prompt
  loop assigns distinct indices; only the interrupted occurrence's index has a candidate, so only it
  reattaches — every other occurrence runs fresh with no notice.
- **Multi-consumer fan-out is permitted; consumption is per-execution (the contract).** The manager
  releases the **source** run's lease immediately after candidate/seed preparation — `initializeRun`'s
  `finally` (`workflow-manager.ts:751`), which runs after `prepareManagedResume` builds the candidate
  (`:733-734`) and **before** the target execution runs. Two sequential or concurrent `resumeFromRunId`
  targets of one still-paused source therefore each build the same `PreparedContinuation` from the same
  snapshot and **MAY each reattach the same recorded ACP session** — and that is permitted by design.
  It mirrors the existing claim-free host-facing reattach surfaces exactly:
  `getPersistedAgentSessions` + `runner.loadSession`/`resumeSession`, and `forkSession`, already let any
  number of consumers reopen a persisted session ref with no lease held. Serialization and
  session-store semantics are **agent-owned**: the runner drives one reopen RPC per execution and the
  agent's own on-disk store decides how concurrent reopens interleave; a sequential second consumer
  receives a **genuine live answer** computed over the completed turn's history (continuation only ever
  asks the agent to finish the interrupted turn — it never mutates shared state under a promise of
  exclusivity, and every gate still fails safe at the reopen RPC, §2.6). Continuation adds **no**
  durable per-source claim, lease, or lock (rejected alternatives #12, #13); the lease-exclusive
  same-ID `resume()`/`resumeInBackground()` recovery API remains the path with no sharing for callers
  who want it. Correctness never depends on exclusivity: each consumer's candidate is index-keyed to
  its own execution and every uncertainty falls to fresh.
- **Correctness across resume hops comes from the persisted rebuild, not from carrying state.** Each
  resume hop rebuilds the candidate map from the latest `PersistedRunState` snapshot (§2.7) — never
  from the `resumeSourceRunId` ancestry chain (§2.12). If a prior hop completed the continued call,
  the new source records it as `outcome: "result"` with the agent row's `errorCode` cleared → no
  candidate. If a prior hop re-paused on it **after `onSessionOpen` recorded a session ref**, the new
  snapshot holds the re-recorded session ref and pause-class `errorCode` → a fresh candidate for the
  next hop. One corner is **savings-only, not a correctness gap**: if the fresh fallback re-pauses
  *before* `onSessionOpen` fires (e.g. an `AUTH_REQUIRED` at the fresh `session/new` with no `onAuth`),
  no new ref is recorded for that call, so the next hop finds no candidate and runs fresh — the still
  agent-reopenable prior session is simply not reattached (a missed saving), never a wrong result.
  Chained continuation therefore needs no cross-hop bookkeeping and no walk of the resume ancestry.

### 2.12 Interaction with the #200 engine surfaces (`resumeSourceRunId`, `executionAdmission`)

The #184 train (PR #200) added two fields to the engine this contract builds on. Both are accounted
for here explicitly so no implementer discovers the overlap during PR4.

- **`resumeSourceRunId` (immutable ancestry field) — orthogonal, not duplicated.** #200 added
  `readonly resumeSourceRunId?: string` to `PersistedRunState` (`run-persistence.ts:140`) and
  `ManagedRun` (`workflow-manager.ts:124`), written once at admission from `exec.resumeFromRunId`
  (`workflow-manager.ts:862`) and propagated on both the new-run save (`workflow-manager.ts:1586`)
  and the same-ID resume save (`workflow-manager.ts:1936`); a content-free
  `PersistedRunLineageTombstone` (`run-persistence.ts:112-116`) retains that ancestry after a record
  is deleted. This field names a run's **immediate resume ancestor** — the run it was resumed *from*.
  It is **not** the same datum as anything continuation needs. `buildPreparedContinuation` reads the
  single `persisted` snapshot it is handed and never consults `resumeSourceRunId`; the candidate map
  carries no source-run id at all (§2.2), so there is no duplicated surface (this revision drops the
  round-2 draft's `ContinuationCandidate.sourceRunId`, which would have collided with this field).
  Continuation **never reads, writes, or joins on `resumeSourceRunId`**, and §2.11's multi-hop rebuild
  walks successive persisted **snapshots**, not the ancestry chain — each hop's snapshot already holds
  the re-recorded session refs and pause-class error codes it needs. The engine keeps sole ownership
  of `resumeSourceRunId`; this feature leaves its bytes untouched (tested, §7.3).
- **`ExecOptions.executionAdmission` (pre-execution admission latch) — orthogonal by ordering.** #200
  added `executionAdmission?: Promise<"admitted" | "denied">` to `ExecOptions`
  (`workflow-manager.ts:207-212`), awaited at the **top of `executeRun`'s `try`**
  (`workflow-manager.ts:1101`) — before the journaling check, before `resolveAgent`, and before
  `runWorkflow` (`workflow-manager.ts:1118`) is ever called; a denied admission throws a
  `PERSISTENCE_ERROR` there and settles through the normal abort/error path without evaluating any
  authored code. Continuation candidate consumption happens strictly downstream, inside `runLive()`
  (`workflow.ts:1068`) which only runs *within* `runWorkflow`. `executeRun` threads
  `managed.preparedContinuation` into the `runWorkflow` options bag at `workflow-manager.ts:1148`,
  after the admission await. Therefore a **denied admission builds no candidate consumption, opens no
  reattach, and emits no continuation provenance or notice** — the candidate map is prepared
  side-effect-free before the latch resolves and is simply never consulted. The threading lands
  correctly relative to the reworked `executeRun` entry: admission (`:1101`) precedes the options-bag
  assembly (`:1148`) precedes `runLive()`. Admission-denied behavior is tested (§7.3).

---

## 3. Failure-contract summary

Every non-cancellation deviation that occurs **at or before the reattach boundary** — an engine
eligibility gate (§2.8) or a runner-side gate up to and including the reopen RPC resolving (§2.6) —
runs the call fresh (`session/new` + original prompt) and never changes the call's journaled identity.
**Once the reattach boundary is crossed** (the reopen RPC resolved and the run is committed to the
continuation turn), a later failure is a genuine live-call outcome — re-pause, empty-output,
schema-noncompliance, or abort — and does **not** fall to fresh (items 14–15; §2.6 post-boundary
contract). A caller cancellation instead wins outright at every checked boundary (propagates raw, opens
no fresh session, records no notice, §2.6). Consolidated:

1. Source not paused on `usage_limit`/`auth_required` → no candidate map; every call fresh (§2.7.1).
2. No root-scope agent row with a coherent `(scope, callIndex)`↔`session.callIndex`↔`record.index`
   join, a pause-class `errorCode`, an `outcome: "error"` call record, and a reopenable session ref
   → not a candidate (§2.7). Nested (child-scope) interrupted agents are excluded by the root-scope
   filter and re-run fresh (§2.7.2, Non-goals §4). Malformed/absent persistence yields no candidate,
   never a throw (§2.7).
3. Interrupted call's session ref advertises neither `reopen.resume` nor `reopen.load` → not a
   candidate (§2.7.3).
4. Live call's hash ≠ recorded hash at this index (script changed) → notice `hash-mismatch` (§2.8).
5. Live call's input fingerprint ≠ recorded fingerprint, or either absent → notice `inputs-mismatch`
   (§2.8).
6. Call is worktree-isolated → notice `worktree-isolated` (§2.8).
7. Recorded cwd ≠ resolved cwd → notice `cwd-mismatch` (§2.8).
8. Resolved cwd absent on disk → notice `cwd-missing` (§2.8).
9. Not the first retry attempt → later attempts run fresh, no extra notice (§2.8, §2.11).
10. Resolved backend id or normalized `poolKey` ≠ recorded → notice `backend-mismatch` (§2.6).
11. Current connection (once `ready`) advertises neither reopen method → notice `capability-missing`
    (§2.6).
12. `resume`/`load` RPC rejected, session gone, or spawn/auth error at reopen → notice
    `reattach-failed`; structured-tool state cleaned up before the fresh acquire (§2.5, §2.6).
13. Custom runner ignored `continueFromSession` (no continuation provenance) → notice
    `runner-declined` (§2.10).
14. Continuation turn produces empty/noncompliant output → existing live-call error paths, no silent
    fresh retry (§2.6).
15. Continuation turn hits a fresh pause-class error → re-pause; session kept reopenable (§2.4, §2.5,
    §2.11).
16. Caller cancellation at any reattach phase → raw propagation, no fresh session, no notice (§2.6).
17. Host admission denied (`ExecOptions.executionAdmission`) → run settles before `runLive()`; no
    candidate consumed, no notice (§2.12).

---

## 4. Non-goals (v1)

- **Killed-process recovery.** A crash/SIGKILL mid-turn never runs the pause-class release path
  (§2.4), so no `keepOpen: true` release fires and what the agent's persisted session contains at the
  kill point is backend-dependent. v1 scopes to graceful `usage_limit`/`auth_required` pauses only.
- **Durable-checkpoint pauses.** A `headless: "pause"` checkpoint pause (`CHECKPOINT_REQUIRED`,
  `errors.ts:27` / pause reason `checkpoint_required`, `workflow-manager.ts:330`) happens *between*
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
  resume-matcher policy selection (`resume-matcher.ts:827-868`), the engine-owned `resumeSourceRunId`
  ancestry (§2.12), and every other call's replay eligibility are computed exactly as before.

---

## 5. Rejected alternatives

1. **Piggyback the continuation candidate on the resume seed.** Rejected: the seed's promotion loop
   is built exclusively from `outcome === "result"` journal rows (`if (call.outcome !== "result")
   continue;`, `resume-matcher.ts:874`); the interrupted call is `outcome: "error"` and is excluded by
   design. A new additive channel is required. Overloading the seed would mean widening its
   construction to include error rows, perturbing the positional/identity replay logic the seed feeds
   — a change the issue's Non-goals forbid.

2. **Fold continuation into `PreparedResume`.** Rejected: the same-ID `resume()`/`resumeInBackground()`
   recovery path — the canonical pause→resume API — builds no `PreparedResume` and passes only
   `resumeJournal` (`workflow-manager.ts:1980`). A candidate carried only on `PreparedResume` would
   silently skip continuation on every same-ID recovery, contradicting default-on (Invariant §2.1.6).
   A standalone `preparedContinuation` channel (§2.3f) is built and threaded on **both** resume entry
   points and is strategy-independent (Invariant §2.1.3), which also dissolves the question of whether
   a `PreparedResume.strategy === "live"` (replay-disabled) resume is eligible: it is, because
   continuation's own gates (§2.8) are the trust boundary, independent of replay admission.

3. **Seal the full session ref into `WorkflowCallRecord` and read the candidate from the call record
   alone.** Rejected: `WorkflowCallRecord` carries only `backendId` (`workflow-result.ts:346`), not
   the reopen surface. The reopenable ref lives in the per-agent snapshot (`state.agentSessions`,
   `workflow.ts:1136`; `PersistedAgentState.session`, `run-persistence.ts:57`). Building the
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
   double-count (§2.9), and is preferred; `session/load` is the fallback for backends that advertise
   only it. The method is chosen against the **current** connection's advertised capabilities once it
   is `ready` (§2.5), not the recorded ref's flags, so capability drift toward load-only degrades to
   load rather than spuriously failing.

7. **Gate continuation on the resume correspondence strategy (identity-v1 only).** Rejected:
   continuation is orthogonal to correspondence (Invariant §2.1.3). A pause-class resume in fact always
   runs `positional-v1` (`resume-matcher.ts:847-868`), so gating on `identity-v1` would disable
   continuation entirely. Serving at the strategy-independent `runLive()` boundary (§2.8) is correct
   and future-proof.

8. **Extend fail-to-fresh through the post-open setup (model/config/mode) to the continuation prompt
   being accepted.** Rejected: there is no mechanically observable "prompt accepted" signal —
   `SessionHandle.prompt()` resolves only after the whole turn (`acp-client.ts:2027-2044`). Post-open
   setup runs the *identical* calls a fresh run makes on the same model spec against a session that
   advertises the same config options, so a fresh retry would fail identically; falling to fresh there
   would loop and double-charge. The boundary is pinned at "reopen RPC resolved" (§2.6), the only
   observable seam, and the `{ reattached: true }` provenance is reported there (§2.5) so a post-open
   failure can never be mislabeled `runner-declined`; post-open failures follow the normal live-call
   paths (re-pause / empty-output / schema / abort).

9. **Key the candidate map by identity hash, with an ambiguity set for duplicate-hash interrupted
   calls and a consumed-hash set to prevent double reopen.** Rejected: a hash key cannot distinguish
   occurrences of an identical prompt. An earlier completed call sharing a hash with a later
   interrupted call would let the first live occurrence consume the interrupted call's session — the
   wrong occurrence — and a duplicate-hash interrupted pair would disable continuation for the whole
   hash. Keying by the deterministic call index (§2.2, §2.8) pins the exact occurrence, needs no
   ambiguity or consumption set, and reduces the identity check to a per-index `hash` verify. The
   `inputsHash` verify then guarantees the reattached turn's execution inputs match.

10. **Rely on the engine's `inputsHash` gate alone to catch custom-backend process drift (no persisted
    `poolKey`).** Rejected as incomplete: the round-2 draft claimed `inputsHash` catches every
    same-name custom-backend command change because the approved-backends digest is a `hashCallInputs`
    input. That digest covers only **script-declared** backends (`workflow.ts:513`,`:995`). A
    **host-registry** custom backend wins on a name conflict (`registryWithRunBackends`, `registry.ts:90`)
    and can change command/args/env — and thus its effective `Backend.poolKey` (`backends/custom.ts:46`) —
    with `scriptBackends`, `inputsHash`, and `backendId` all unchanged. Relying on `inputsHash` alone
    would let continuation bind the turn to a **different process identity**, violating the core "never
    changes what a call is" invariant. The design therefore persists the effective `poolKey` on the
    session ref (§2.3g — one additive, non-hashed field) and gates runner-side on normalized `poolKey`
    equality (§2.6). This is the minimal spawn-identity proof that works on a cold resume; the engine's
    `inputsHash` gate still covers script-backend changes, and the two are complementary (§2.8).

11. **Add a configuration flag or a token cap for continuation.** Rejected per repo policy: requested
    behavior ships default-on, and safety comes from the fail-to-fresh gates (§2.6, §2.8), not from a
    toggle. There is no configuration surface (Invariant §2.1.6).

12. **Serialize fan-out reattach behind a durable per-source claim (lease/lock).** Rejected: this is
    the safest guard against two concurrent `resumeFromRunId` consumers reopening one still-paused
    source's recorded session, but it adds new persisted lease/claim state plus crash-recovery
    semantics the issue never requested — against the house no-uninvited-machinery posture — and it
    cannot be enforced across processes without real distributed locking. Per-execution consumption
    (§2.11) is the adopted contract instead: it matches the existing claim-free host-facing reattach
    surfaces (`getPersistedAgentSessions`, `loadSession`/`resumeSession`, `forkSession`), which already
    permit unclaimed multi-consumer reopen, and correctness never depends on exclusivity because every
    gate fails safe at the reopen RPC (§2.6).

13. **Restrict continuation to the lease-exclusive same-ID recovery path only (no fan-out sharing).**
    Rejected: gating continuation on the same-ID `resume()`/`resumeInBackground()` API would add zero
    machinery but would silently disable continuation on the new-run `resumeFromRunId` / MCP entry
    point, contradicting default-on on **both** entry points (Invariant §2.1.6). The adopted contract
    permits fan-out and documents per-execution consumption (§2.11); the same-ID API still remains
    available as the exclusive recovery path for callers who want no sharing.

---

## 6. Compatibility & semver

Additive minor across four packages; the two host-facing library packages take no new **inputs**:

- **`@automatalabs/shared-types`** (minor): `RunOptions.continueFromSession`;
  `AgentResultProvenance.continuation` + `ContinuationAttempt`; `ContinuationSkipReason`;
  `JournalCallMetadata` agent-arm `continuation`; `WorkflowRunFallback` `"continuation"` kind +
  `continuation` detail; `AgentSessionRef.poolKey`; the amended `onSessionOpen` JSDoc. All
  optional/additive; existing serializations and the pinned hash fixtures are unchanged.
- **`@automatalabs/acp-agents`** (minor): `run()` reattach path, `keepOpen`-on-pause release,
  `CONTINUATION_INSTRUCTION`, `isProviderUsageLimitError`, `sessionRefFor` stamps `poolKey`,
  `pool.acquirePreparedReattach` + `PooledConnection.openPreparedReattachedSession` +
  `reattachReadySession` + `ReattachCapabilityUnavailable`, `UsageAccumulator` `baseline()`/`delta()`,
  provenance reporting. No `AgentRunner` interface break — `continueFromSession` is optional and
  advisory.
- **`@automatalabs/workflow-engine`** (minor): `PreparedContinuation`/`ContinuationCandidate`;
  `WorkflowRunOptions.preparedContinuation` + `ManagedRun.preparedContinuation`;
  `buildPreparedContinuation` construction on both resume entry points; live-boundary selection, gates,
  `keptOpen` pause-class stamp, notices, and marker propagation across replay and the run-event
  projection. `resumeSourceRunId` and `executionAdmission` bytes untouched (§2.12).
- **`@automatalabs/mcp-server`** (minor): the result **output** schema `fallbackSchema.kind` widens
  from `["model","modifier"]` to include `"continuation"` and gains the optional `continuation` detail
  (`workflow-tool-output.ts:46-55`, `kind` at `:53`; consumed via `executionDetailsShape.fallbacks`
  `:179` in `executionResultSchema` `:184` and `workflowToolOutputShape` `:259`; projected at `:437`;
  `toWorkflowToolResult` `:444`), so a continuation notice can pass through the MCP host. No new
  **input**; the `workflow` tool's inputs are unchanged (the server also registers a separate
  `repl` tool, unaffected by this spec). This widening lands **before** the
  engine activates the behavior (§8) so no stage ever emits a `kind` the MCP boundary would reject.
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
  output are identical with and without any continuation-adjacent field in play (`continueFromSession`,
  `poolKey`, the markers), and the pinned hash fixtures are unchanged. (Focus directive:
  `hashAgentCall()` bytes untouched.)
- Type round-trip: `RunOptions.continueFromSession`, `AgentResultProvenance.continuation` (both
  `reattached` arms), every `ContinuationSkipReason` value, `JournalCallMetadata.continuation`,
  `AgentSessionRef.poolKey`, and the `WorkflowRunFallback` continuation notice JSON-serialize and
  parse unchanged.
- **`WorkflowRunFallback` shape (§2.3e).** An existing `kind: "model"` fallback with no `continuation`
  field type-checks and round-trips (flat-interface guarantee); a `{ kind: "continuation",
  continuation: {…} }` round-trips; the negative/permissive cases `{ kind: "continuation" }` without a
  detail and `{ kind: "model", continuation: {…} }` also round-trip without rejection (the correlation
  is an engine-emission invariant, not a validation one).

### 7.2 `@automatalabs/acp-agents`

- **Pause-class release keeps the session open (§2.4).** A mock ACP server asserts no `session/close`
  when `run()` throws `PROVIDER_USAGE_LIMIT` and when it throws `AUTH_REQUIRED`; asserts a
  `session/close` *is* sent for a non-pause error without `keepSession`; asserts the success path is
  unchanged.
- **Reattach-and-continue happy path (§2.5).** With `continueFromSession` and a connection advertising
  `resume`, `run()` reopens via `session/resume` (no `session/new`), reports
  `{ reattached: true, method: "resume" }` **before** model-selection/configOptions/mode run, sends the
  continuation instruction (not the original prompt), does not re-attach original images, and returns
  the extracted result. Repeat for a `load`-only connection → `method: "load"`.
- **Cold-spawn capability timing (§2.5, closes premature-capabilities read).** A freshly-spawned
  connection whose `capabilities` are `undefined` at selection time but advertise `resume` after
  `initialize` completes: the reattach reserves the slot, awaits `ready`, and reattaches via `resume`
  (not misclassified `capability-missing`). Plus a load-only cold spawn → `load`, and an
  `initialize`-failure cold spawn → the failure surfaces (not a spurious capability skip).
- **Capability sentinel bypasses error mapping (§2.5).** A connection that, once `ready`, advertises
  neither reopen method → `openPreparedReattachedSession` throws `ReattachCapabilityUnavailable`,
  `acquirePreparedReattach` rethrows it unmapped, and the runner reports `capability-missing` (not a
  generic mapped `reattach-failed`).
- **Fail-to-fresh (§2.6) — one case each:** `backend-mismatch` (recorded `backendId` ≠ resolved);
  `backend-mismatch` (same `backendId`, recorded `poolKey` ≠ resolved custom-backend `poolKey`);
  `capability-missing` (ready connection advertises neither); `reattach-failed` (mock rejects
  `session/resume`; and mock reports the session gone). Each asserts a subsequent `session/new` +
  original prompt runs and the reported provenance reason matches.
- **Reattach is attempted at most once, outside the inline-auth retry loop (§2.5 blocker).** A run with
  `onAuth` set whose reattach RPC rejects (`reattach-failed`) → falls to fresh; the fresh `session/new`
  then throws `AUTH_REQUIRED` exactly once and `onAuth` resolves it so the fresh acquire retries and
  succeeds. Assert the reattach acquire (`session/resume`/`session/load`) fired **exactly once** across
  the whole `run()` — the inline-auth `continue` re-attempts only the fresh `session/new`, never the
  reattach — the run reports `reattached: false, reason: "reattach-failed"`, and the final result is
  served by the fresh session. Separately, a reattach RPC that itself throws `AUTH_REQUIRED` asserts
  `reattach-failed` → fresh (the reattach never enters the inline-auth resolve-and-retry-once path).
- **Host-registry custom-backend drift (§2.6, §2.8, closes alt #10 hole).** A cold resume where a
  host-registered custom backend shadows the script name with a changed command (same `backendId`,
  unchanged `scriptBackends`/`inputsHash`): the recorded ref's `poolKey` ≠ the resolved backend's
  `poolKey` → `backend-mismatch` → fresh. A host override whose command is unchanged (same `poolKey`)
  reattaches. A legacy ref with no `poolKey` reattaches only to a first-class backend, never to a
  custom one.
- **Capability drift toward load (§2.6).** Recorded ref advertised both `resume`+`load` but the ready
  connection advertises only `load` → the pool picks `load` and reattaches (provenance `method: "load"`),
  not `reattach-failed`.
- **Post-open boundary + provenance ordering (§2.5, §2.6).** A reattach that succeeds but whose
  `setMode` then throws propagates as a live-call error (no fresh retry) **and** the run is still
  recorded as `reattached` (never `runner-declined`), proving provenance was reported before setup.
- **Cancellation wins (§2.6).** An abort during connection `initialize`, during the reopen RPC, and
  during the continuation turn each re-throws raw, opens **no** fresh `session/new`, and emits no skip
  provenance; best-effort cleanup runs.
- **Reattach-failure cleanup, no leak/deadlock (§2.5, §2.6).** A schema run whose reattach RPC rejects
  after `prepare` registered the structured-output MCP tool and acquired the tool turn: assert the
  fresh `session/new` completes (no self-deadlock on the held turn). The cleanup releases the failed
  reattach's registration before the fresh path re-registers, so across the whole `run()` there are
  **two** registrations (reattach then fresh) with **at most one active at a time**, and the fresh
  session that ultimately serves the call carries **exactly one** structured-output MCP server entry
  (matching §2.5's release-then-re-register cleanup). A variant where a cleanup action itself throws
  still reaches the fresh path.
- **Structured-output ladder over a continuation turn (§2.5).** A schema run that reattaches and
  continues drives the repair ladder and empty-output guard identically to a fresh schema run.
- **Second pause / AUTH_REQUIRED during continuation (§2.5, §2.11).** A continuation turn that hits
  `PROVIDER_USAGE_LIMIT` propagates it and releases with `keepOpen: true`; a continuation turn that
  hits `AUTH_REQUIRED` likewise re-pauses and keeps the session open.
- **`onSessionOpen` fires exactly once (§2.5).** Assert one `onSessionOpen` call for a fresh run, one
  for a successful reattach (with the reattached ref carrying `poolKey`), and exactly one for a failed
  reattach that falls to fresh (for the fresh handle).
- **`prepare` closure reuse (§2.5).** The reattach path attaches the same structured-output MCP
  server / `mcpServers` / `runId` stamp as the fresh path.
- **Usage baseline/delta arithmetic (§2.5, §2.9).** A `load`-only mock replays historical
  `usage_update` notifications (cost + context tokens) during `session/load`, then the continuation
  turn reports new usage; assert the runner debits only the post-baseline delta. Cover: counter
  **reset** (cumulative cost drops below baseline → `cost` clamps to 0); context **decrease**
  (compaction → `total` fallback clamps to 0); **no post-baseline update** (delta `{ total: 0,
  cost: 0 }`, engine estimate applies); **prompt-usage-only** (per-turn breakdown, `cost` delta from
  baseline); **replay-then-continuation** on `load`; a `resume` mock (no replay) reports full
  continuation-turn usage (delta == raw). Every field is non-negative.

### 7.3 `@automatalabs/workflow-engine`

- **Candidate map: pause-class + reopenable + root-scope + error-outcome (§2.7).** Built only from
  root-scope agent rows whose joined `PersistedAgentState.errorCode` is
  `PROVIDER_USAGE_LIMIT`/`AUTH_REQUIRED` and whose session ref has `reopen.resume`/`reopen.load`, and
  whose call record has `outcome: "error"`. `result` rows, `null`/absent-outcome rows, non-pause
  errors, and non-reopenable refs yield no candidate. A source paused on `checkpoint_required` yields
  an empty map. **Error-code disagreement:** a call whose `WorkflowCallRecord.error.code` differs from
  the joined agent row's `errorCode` is admitted/rejected on the **agent row's** `errorCode` (§2.7.3).
- **Total fail-to-fresh projection / malformed persistence (§2.7).** Snapshots with a missing/non-array
  `agents` or `calls`, an agent row whose own `callIndex` ≠ its `session.callIndex`, a non-integer or
  negative index, and a malformed session ref each produce **no candidate** for that index and **no
  throw**; a well-formed sibling row in the same snapshot still forms its candidate.
- **Cross-field coherence checks (§2.7.3).** A row whose `status !== "error"` (a pause-class `errorCode`
  present but the agent row not settled as an error), a row whose `session.backendId` ≠ the joined
  `record.backendId`, and a row whose `session.cwd` ≠ `record.resolvedCwd` (both present) each yield
  **no candidate** for that index; a missing side of the cwd pair is tolerated and the candidate still
  forms (left to the downstream live-value gates). A snapshot where every row is coherent forms its
  candidates.
- **Scope-safe join (§2.7.2).** A snapshot with a nested child agent at `(scope: child, callIndex: 0)`
  and a root agent at `(scope: root, callIndex: 0)` builds a candidate only for the root row; the
  child row never overwrites or joins to the root. A pause inside `workflow()` yields no candidate for
  the child (the child ran with `preparedContinuation: undefined`), and the nested agent re-runs fresh.
- **Snapshot-only source (§2.1.4).** The interrupted call has no journal entry; its candidate is built
  from `agents[].session`. Assert an event-log-only reconstruction finds nothing (the event log drops
  `session`).
- **Both resume entry points (§2.7, Invariant §2.1.6).** A `usage_limit`-paused run resumed via
  same-ID `resumeInBackground()` reattaches (no `PreparedResume` built, `managed.preparedContinuation`
  consumed by `executeRun`); the same run resumed via new-run `resumeFromRunId` reattaches
  (`ManagedRun.preparedContinuation` set inside `prepareManagedResume`); an `auth_required` same-ID
  resume reattaches only after the cold re-arm gate passes and re-pauses (no candidate consumed) when
  it fails.
- **Admission latch + ancestry orthogonality (§2.12).** A denied `ExecOptions.executionAdmission`
  settles the run before `runLive()`: no `continueFromSession` is passed, no reattach opens, no
  continuation notice/provenance is emitted. `resumeSourceRunId` is neither read as a join/eligibility
  key nor mutated by continuation across a new-run and a same-ID resume (its persisted value is
  preserved and equals the admitting `resumeFromRunId`).
- **Occurrence correspondence via index (§2.2, §2.8, closes hash-alias).** An identical-prompt loop
  where an *earlier* occurrence completed and a *later* occurrence was interrupted: on resume the
  earlier live occurrence runs fresh (its index has no candidate) and only the interrupted index
  reattaches.
- **Identity + inputs gates (§2.8, closes hash-only match).** With a valid index candidate, changing
  the call at that index's prompt/model → `hash-mismatch` → fresh; changing an unhashed input
  (`images`, `mcpServers`, `promptMeta`, `meta`, `keepSession`, `label`, `timeout`, `retries`, `cwd`,
  or a same-named **script** backend's command via the approved-backends digest) → `inputs-mismatch` →
  fresh; a legacy record with no `inputsHash`, or a call whose `callInputsHash` is absent →
  `inputs-mismatch` → fresh.
- **Gate matrix (§2.8).** One test per remaining engine gate — `worktree-isolated`, `cwd-mismatch`,
  `cwd-missing` — asserts fresh execution and the correct skip notice; a positive case asserts
  `continueFromSession` is passed to the runner with the recorded ref on `attempt === 1` only.
- **Retry + timeout (§2.11).** With `retries > 0`: attempt 1 reattaches and fails recoverably → attempt
  2 runs fresh (no `continueFromSession`), settles, and the journal marker is **absent** (the settling
  attempt's fresh `slot` carries no continuation provenance); a first-attempt reattach that times out
  aborts and attempt 2 runs fresh; a late timeout settlement does not double-emit the notice.
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
  right reason; a `runner-declined` skip emits its notice; a cancelled attempt emits none; an ordinary
  no-candidate live call emits no continuation notice; a throwing `onFallback` host callback does not
  abort the call (Invariant §2.1.2).
- **Default-on, zero config (§2.1.6).** An eligible resume attempts continuation with no option set
  anywhere; `@automatalabs/workflows` inputs are unchanged.
- **Strategy independence (§2.1.3).** A `usage_limit`-paused source resumes via `positional-v1`
  (asserted from the resume report) and, separately, a resume whose admission is `live` (replay
  disabled) both still serve the continuation candidate at the live boundary.

### 7.4 `@automatalabs/mcp-server`

- **Output schema round-trip (§2.10, §6).** A `WorkflowRunResult` carrying a `kind: "continuation"`
  fallback (both `reattached` and `skipped` details) passes the widened `fallbackSchema` and survives
  `toWorkflowToolResult` → parse unchanged; an existing `kind: "model"` fallback still validates
  (back-compat); the permissive negatives `{ kind: "continuation" }` (no detail) and
  `{ kind: "model", continuation }` are accepted, not rejected (matching §2.3e).

### 7.5 Live e2e (gated like the existing live suites)

- Interrupt a real backend turn on a usage/auth wall, resume via the same-ID recovery API, and assert
  the continuation turn completes the original task without re-running the prefix work (observable via
  the agent's own history / token accounting and the `reattached` notice). Run for a `resume`-capable
  backend and, if available, a `load`-only backend.

---

## 8. Implementation breakdown

Four PR-sized stages, each green and independently reviewable; they ship as one coordinated additive
minor release (§6) with Changesets per `CONTRIBUTING.md:73-85`. The MCP output-schema widening
(PR3) lands **before** the engine turns the behavior on (PR4), so no stage ever emits a `kind` a
downstream schema would reject:

1. **PR1 — shared additive contract (`shared-types`).** `RunOptions.continueFromSession` + amended
   `onSessionOpen` JSDoc; `ContinuationAttempt`/`AgentResultProvenance.continuation`;
   `ContinuationSkipReason`; `JournalCallMetadata.continuation`; `AgentSessionRef.poolKey`;
   `WorkflowRunFallback` continuation kind + detail. Type round-trip, emission-invariant, and
   hash-fixture non-regression tests (§7.1). No behavior change.
2. **PR2 — runner reattach + keep-open + usage delta (`acp-agents`).** `keepOpen`-on-pause release,
   `isProviderUsageLimitError`, `sessionRefFor` `poolKey` stamp, `pool.acquirePreparedReattach` +
   `PooledConnection.openPreparedReattachedSession`/`reattachReadySession` +
   `ReattachCapabilityUnavailable`, `run()` reattach path with provenance-first ordering, cancellation
   contract, cleanup, and post-open boundary, `CONTINUATION_INSTRUCTION`, `UsageAccumulator`
   baseline/delta. Mock-ACP tests (§7.2). Behavior reachable only when a caller passes
   `continueFromSession`.
3. **PR3 — MCP output schema widening (`mcp-server`).** Widen `fallbackSchema.kind` to include
   `"continuation"` and add the optional `continuation` detail in `workflow-tool-output.ts`
   (`:46-55`), with positive/negative round-trip tests (§7.4). No behavior change — it only widens
   what the MCP boundary *accepts*, so it is independently green and makes `kind: "continuation"` legal
   before anything emits it.
4. **PR4 — engine candidate map, selection, notices, marker, docs (`workflow-engine`, docs, skill).**
   `PreparedContinuation`/`ContinuationCandidate`; `buildPreparedContinuation` on both resume entry
   points; `ManagedRun.preparedContinuation` plumbing through `executeRun`; live-boundary selection,
   gates, `keptOpen` pause-class stamp, guarded notices with `runner-declined`, and marker propagation
   across `replayPreparedAgent` + the run-event projection/validator. Engine unit tests (§7.3) plus the
   gated live e2e (§7.5). This is the only stage that emits `kind: "continuation"`, and by now PR1 and
   PR3 already accept it. It also updates every authoritative doc surface whose current text becomes
   false — that fallbacks are model-only, that one-shot/`run()` sessions are always `session/new`, and
   that pause resume merely re-runs — namely:
   - the root `README.md` (durable-journal resume narrative `:54`; "model resolution no longer emits
     fallback entries" `:209` — false once a `kind: "continuation"` fallback ships; "a fresh session
     per call" `:421` — false for a reattached occurrence; line `:421` was `:415` at the prior base and
     shifted +6 under PRs #203/#204, re-verified here);
   - `packages/shared-types/README.md` (`onSessionOpen` `:82`; `WorkflowRunFallback` kind
     `model | modifier` `:101-102`);
   - `packages/acp-agents/README.md` (`RunOptions` seam `:51`; `keepSession`/`onSessionOpen` reopen
     narrative `:173-179`);
   - `packages/workflows/README.md` (fallbacks `:299`; `keepSession`/session `:390`);
   - `packages/mcp-server/README.md` (resume `:124`; fallback output shape `:229`);
   - `docs/api.md` (fallback-kind enum `:427-428` — was `:425-426` at the prior base, shifted +2 under
     PRs #203/#204; the `onSessionOpen`-always-after-`session/new` session-handoff narrative `:878`; the
     auth-pause "rather than re-running into the same wall" narrative `:441`);
   - `docs/design-notes.md` (the `session/new` acquisition diagrams, §5.x);
   - the workflow-authoring skill `skills/agentprism-workflow-authoring/SKILL.md` (the "every `agent()`
     call is a fresh session with no memory" claim `:15`, false for a reattached occurrence) +
     `reference.md`, and — **regenerated unconditionally** (any skill-source edit forces it via the CI
     drift test) — the generated MCP authoring prompt via `scripts/generate-authoring-prompt.mjs`;
   - add coordinated changesets for all four packages.

No stage changes synchronous `callSeq` allocation, `hashAgentCall`/`hashCallInputs` bytes,
resume-matcher policy selection, isolation behavior, or the engine-owned `resumeSourceRunId` ancestry.

---

## 9. References

All citations verified by reading the file at base commit
`e9c94aa537b2ed75c81cf73eeb303cb9441bd346` (branch `spec/pause-recovery-continuation`, rebased onto
`origin/main`; `docs/specs/incremental-resume-spec.md` and `docs/specs/acp-auth-spec.md` are the
house-format exemplars). External dependency: `@agentclientprotocol/sdk` declared `^1.2.1`
(`packages/acp-agents/package.json:46`; `@agentclientprotocol/claude-agent-acp` `0.59.0` at `:45`);
the reopen RPC method constants used are `AGENT_METHODS.session_new` / `session_load` /
`session_resume` (`packages/acp-agents/src/acp-client.ts:158-160`).

**`packages/shared-types/src/agent-run.ts`**
- `AgentResultProvenance` live/replay union — `:33-40`; `onResultProvenance` callback `:123`
- `RunOptions` (additive infra fields are not hash inputs): `keepSession` `:192`; `onSessionOpen`
  `:193-198`; `callIndex` `:208`; `callHash` `:214`; `callPath` `:220`; `callInputsHash` `:221-226`

**`packages/shared-types/src/workflow-result.ts`**
- `AgentSessionRef` + `reopen` (load/resume/list/fork) — `:71-90`; `reopen.load/resume` `:80-90`
- `AgentSessionRecord extends AgentSessionRef` (callIndex `:97`, keptOpen `:100`) — `:95-101`
- `WorkflowRunFallback` (kind "model"/"modifier" `:116`, requestedSpec `:110`) — `:104-119`
- `JournalCallMetadata` agent arm (kind `:138`, backendId `:144`) — `:136-145`
- `JournalEntry` (session `:159`; call `:161`; usage "LOWER BOUND on true spend" `:164-168`; scope
  `:171`) — `:152-172`
- `WorkflowCallRecord` (index `:314`, kind `:315`, hash `:317`, inputsHash `:322`, outcome `:327`,
  backendId `:346`, resolvedCwd `:354`, provenance `:370`, scope `:372`) — `:312-373`
- `WorkflowRunResult.fallbacks` — `:490`

**`packages/shared-types/src/errors.ts`**
- `WorkflowErrorCode.PROVIDER_USAGE_LIMIT` `:19`; `AUTH_REQUIRED` `:24`; `CHECKPOINT_REQUIRED` `:27`
- `isProviderUsageLimit` `:158`; `isAuthRequired` `:162`

**`packages/acp-agents/src/runner.ts`**
- `run()` — `:721-920`; `prepareSession(prepared.backend)` `:743`; structured-tool state decl
  `:749-752`; `prepare` closure (MCP inject) `:754-783`; inline auth-retry cleanup pattern `:799-809`;
  fresh acquire (`pool.acquirePrepared`) `:791`; `onSessionOpen` fire (post-open, pre-prompt)
  `:822-828` (call `:824`); post-open sequence (model/configOptions/mode) `:831-835`; prompt build
  (`buildRunPrompt`) `:837`; prompt `:843`; stop-reason assert `:848`; schema repair ladder `:850-869`;
  empty-output guard `:874-878`; catch/`mapThrownError` (abort raw `:883`) `:881-890`; finally `onUsage`
  `:897` / release `keepOpen` `:909`; `acquireStructuredToolTurn` `:926-935`
- `loadSession`/`resumeSession` runner methods — `:693`, `:714`
- `createInteractiveSession` reattach assembly (post-open mirror, model/config/mode `:985-989`) — `:954-1005`
- `sessionRefFor` (reopen population from capabilities; stamps backendId + poolKey) — `:1375-1388`
- `isAuthRequiredError` — `:1428-1430`

**`packages/acp-agents/src/backend.ts`**
- `Backend.poolKey` (defaults to id; custom = id + spawn-config hash) — `:60-66`

**`packages/acp-agents/src/backends/custom.ts`**
- `CustomAcpBackend.poolKey` = `name#sha256(command/args/env)` — `:29`, hash `:46`

**`packages/acp-agents/src/backends/claude.ts`** (built-in spawn identity is NOT fixed)
- `spawnConfig()` varies with `AGENTPRISM_CLAUDE_ACP_CMD`/`_ARGS` env override (`:46-48`) and
  installed-bin (`require.resolve`, `:53-54`) vs `npx` (`:56`) — codex/opencode mirror this; built-ins
  define no explicit `poolKey`, so their effective identity is the logical agent id (§2.3g) — `:44-58`

**`packages/acp-agents/src/registry.ts`**
- `registryWithRunBackends` (host registration wins on a name conflict) — `:81-92` (`host wins` `:90`)

**`packages/acp-agents/src/capabilities.ts`**
- `NegotiatedCapabilities.supportsLoadSession` `:69`; `supportsResumeSession` `:77`

**`packages/acp-agents/src/acp-client.ts`**
- `AGENT_METHODS.session_new/load/resume` — `:158-160`
- `SessionState.usage` `:191`; `usage_update` records cost + context tokens `:282-289`
- `capabilities` getter (undefined until initialize) — `:1169-1173`
- `assertLifecycleSupported` capability gate — `:1220-1234`
- `openPreparedSession` (reserve slot → await ready → prepare → open) — `:1503-1515`
- connection `loadSession`/`resumeSession` — `:1554-1560`
- `reattachSession` (fresh `SessionState` `:1627`, register-before-wire `:1653`, load/resume RPC
  `:1659`/`:1665`) — `:1620-1677`
- `SessionHandle.prompt` (`recordPromptUsage` `:2043`) — `:2027-2044`

**`packages/acp-agents/src/usage.ts`**
- `UsageAccumulator` — `:21-73`; per-turn `promptUsage` (`recordPromptUsage`) `:22`/`:28-30`; cumulative
  `costAmount` (`recordCost`) `:33-37`; gauge `contextUsedTokens` (`recordContextTokens`) `:45-48`;
  `toAgentUsage` `:50-72`

**`packages/acp-agents/src/pool.ts`**
- `AcpAgentPool.acquire` `:84-98`; `acquirePrepared` `:101-119`; `selectConnection` (poolKey identity
  `:129`, generation-gated) `:126-156`

**`packages/workflow-engine/src/workflow.ts`**
- `WorkflowRunOptions.preparedResume` `:169`; `onFallback` `:185`
- `backendsDigest` (approved script backends → `hashCallInputs`) — `:513`, consumed `:995`
- `resolvedIsolation` definition — `:967`
- `hashAgentCall` call `:975-982`; `hashCallInputs` call `:984-996`; `callSeq` alloc `:1000`;
  settle (records `inputsHash` `:1018`)
- `runLive` definition — `:1068`; `sessionRecord` (callIndex join, `keptOpen` `:1118`) `:1111-1120`;
  `emitFailure` seals session into `state.agentSessions` on error (`push` `:1136`) `:1124-1170`;
  `runCwd` resolution `:1192`; worktree create at fresh path `:1184`; attempt loop `:1194`; per-attempt
  fresh `slot` `:1195`; `agentRunner.run` options bag (additive seam) `:1206-1296`; `slot.sessionRef`
  via `onSessionOpen` `:1235-1239`; model-fallback emission template `:1245-1263` (`sameFallback` guard
  `:1259`, `requestedSpec` `:1254`); `onUsage` `:1264-1268`; `onResultProvenance` capture `:1270-1274`;
  `withTimeout` `:1302-1310`; success settle `:1328-1348` (provenance `:1347`); live journal `call`
  metadata `:1358-1364` (backendId `:1363`); guarded journal emit (`guardTerminal`) `:1366`;
  `emitAgentEnd` `:1368-1381`; catch/retry `:1383-1409`; worktree teardown at settle `:1419`
- `replayPreparedAgent` (reconstructs `call` metadata, drops continuation) — `:1423-1502`
  (`call` build `:1483-1489`)
- strategy convergence on `runLive`: `runPreparedAgent` `:1684`; `runManualAgent` journal-miss `:1759`;
  dispatch `:1762`
- nested `workflow()` child options (`resumeJournal`/`preparedResume` undefined) — `:1878-1880`
- `hashAgentCall` — `:2949-2975` (identity object `:2958-2973`, `model: model ?? null` `:2960`);
  `hashCallInputs` — `:2865-2879`; `sameFallback` — `:2568`

**`packages/workflow-engine/src/workflow-manager.ts`**
- `ManagedRun.resumeSourceRunId` (#200 ancestry) — `:124`; `ExecOptions.executionAdmission` (#200
  admission latch) — `:207-212`
- `latestRootRows` (root-scope filter) — `:311-317`
- `runReason` pause mapping (usage_limit `:328`, auth_required `:329`, checkpoint_required `:330`) —
  `:325-331`
- `prepareManagedResume` — `:618-716` (identity-v1 `:646-656`, live `:659-668`, positional-v1
  `:696-715`; `managed.journal` via `latestRows` `:687`, `managed.calls` via `latestRootRows`
  `:688-691`)
- `initializeRun` (calls `prepareManagedResume` `:733-735`; returns `{ managed, resumeExecution }`
  `:745`; `finally` releases the **source** resume lease `:751`, after candidate prep and before target
  execution — the multi-consumer fan-out basis, §2.11) — `:718-752`
- `resumeSourceRunId` written at admission (`createManaged`) — `:862`
- `ManagerResumeExecution` interface — `:165-169`
- `executeRun` (signature/`resumeExecution` param `:1059-1063`; `resumeJournal` read `:1079`;
  `preparedResume` read `:1080`; `executionAdmission` await `:1101`; journaling+resumeJournal reject
  `:1108`; `runWorkflow` call `:1118`; engine options bag `resumeJournal`/`preparedResume` pass `:1144`,
  `:1148`; `onFallback` append + persist `:1176-1179`; `onAgentStart` stamps callIndex/scope
  `:1215-1216`; `onAgentEnd` matches `(scope, callIndex)` `:1233-1234`, `event.session` capture `:1252`)
- pause persist (`persistRun` in the pause `beforeLive` hook `:1386`) — `:1384-1388`; `resumeSourceRunId`
  new-run save `:1586`; agents-to-disk projection — `:1644-1648`
- `resume()`/`resumeInBackground()` (same-ID recovery): auth cold re-arm gate `:1817-1858`;
  `managed.journal` via `latestRootRows` `:1928`; `managed.calls` `:1931`; `resumeSourceRunId` same-ID
  save `:1936`; `resumeJournal` build `:1955`; `executeRun(managed, script, { ...exec, resumeJournal })`
  (no `resumeExecution`) `:1980`
- `getPersistedAgentSessions` (snapshot session-read pattern) — `:2104-2119` (session read `:2109`)

**`packages/workflow-engine/src/resume.ts`**
- `PreparedResume` union (identity-v1 `:95` / positional-v1 `:104` / live `:122` arms) — `:93-126`

**`packages/workflow-engine/src/resume-matcher.ts`**
- Historical frozen-base `allCallsRepresented` behavior (interrupted error call ⇒ false) — `:827-829`
- Historical frozen-base `fallbackReason: "unsafe-recording"` positional selection — `:847-868`
- seed promotion filters non-`result` rows (`if (call.outcome !== "result") continue;` `:874`) —
  `:872-882`

**`packages/workflow-engine/src/run-persistence.ts`**
- `PersistedAgentState.errorCode` `:52`; `.session` `:57`; `.callIndex` `:64`; `.scope` `:65`;
  `.provenance` `:67`
- `PersistedRunLineageTombstone` (#200) — `:112-116`
- `PersistedRunState.resumeSourceRunId` (#200) `:140`; `status` `:146`; `errorCode` `:150`;
  `pauseReason` `:153`; `agents` `:165`; `journal` `:181`; `fallbacks` `:183`; `calls` `:186`

**`packages/workflow-engine/src/run-event-persistence.ts`**
- event projections drop `session`: agent-end record `:536`; journal event `:555`

**`packages/workflow-engine/src/run-observability.ts`**
- `callStatus` (journal `call` → inspection status) — `:266-300`
- `projectProvenance` live arm (rebuilds `{ source: "live", overrideModel? }`, drops continuation;
  `source: "live"` `:480`) — `:474-484`
- journal run-event projection (rebuilds agent-arm `call`, drops continuation; agent arm `:722-734`,
  `backendId` `:731-733`) — `:710-745`

**`packages/mcp-server/src/workflow-tool-output.ts`** (restructured by #200)
- `fallbackSchema` (`kind: z.enum(["model","modifier"])` `:53`) — `:46-55`; consumed via
  `executionDetailsShape.fallbacks` `:179` in `executionResultSchema` `:184` and
  `workflowToolOutputShape` `:259`; projected from `run.fallbacks` `:437`; `toWorkflowToolResult` `:444`

**`CONTRIBUTING.md`**
- Changesets requirement (add a changeset per PR; merging a changeset-bearing PR is the release) —
  `:73-85`
