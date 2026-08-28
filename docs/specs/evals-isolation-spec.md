# Evals Isolation Mode — Design Contract (reviewed baseline)

## Status and motivation

**Status: reviewed baseline (revision 7, final-fix pass applied per owner adjudication
of review round 6).** Revision 7 applies every round-6 blocking finding (B1–B14, all
ACCEPTED by the design owner) and the five round-6 advisories under the directives'
BUILD-PREFERENCE ordering: (1) an additive build wherever one resolves the finding —
the widened target fingerprint + engine cwd observation (§2.7, §4.6.2), the
nested-invocation callback (§2.3), candidate-model evidence (§4.6.2 rule T),
budget-trajectory replay (§3.5, §4.6.8), the engine-owned manifest (§3.2), per-attempt
abort (§3.5), the environment-identity manifest (§3.3a, §4.9); (2) narrowing only where
a build would reproduce the problem one level down; (3) normative limitations in §4.12
that FAIL CLOSED, reserved for the three owner-sanctioned residuals (silent third-party
runners, cancellation-ignoring backends, vm-escaping scripts) plus the one
owner-approved budget-read race residual (§4.12 item 5). Dispositions are indexed
in §10.

This document is the normative design for exactly three deliverables that together form
the substrate for substitution testing (`docs/roadmap/evals.md`):

1. **Gap A — call-identity threading.** The engine assigns every `agent()`/`checkpoint()`
   call a deterministic call index and a call-identity hash, but hands neither to the
   injected `AgentRunner` (`packages/workflow-engine/src/workflow.ts:503-511` vs the opts
   bag at `:621-672`). This contract threads the identity through additively — index,
   hash, a structural **call-path key** (§2.5), and an **input fingerprint** (§2.7) — to
   the runner seam and (for checkpoints) the `confirm` callback.
2. **Gap B — per-call usage persistence + the call manifest.** The full per-call
   `AgentUsage` split (`packages/shared-types/src/agent-run.ts:20-27`) exists at run time
   via `RunOptions.onUsage` but only a collapsed `tokens` total survives per agent
   (`workflow.ts:597-609`, persisted untyped via the snapshot spread at
   `packages/workflow-engine/src/workflow-manager.ts:765-769`). This contract persists the
   split, fixes the `PersistedRunState`/`PersistedAgentState` under-typing honestly, makes
   recorded values immutable frozen snapshots (§3.0), and adds a **call manifest**
   (`PersistedRunState.calls`, §3.2) whose completeness is *checkable*, not assumed.
3. **Isolation mode.** A record/replay `AgentRunner` wrapper plus a one-call harness
   (`runIsolation`) that re-executes a recorded workflow, serving recorded results for
   every call except one or more explicitly targeted calls, which run live — optionally
   on a different model/backend. Upstream AND downstream are held fixed from the
   recording: a per-step substitution verdict at per-step cost. The divergence policy is
   **strict fail-fast**: any ambiguity, unproven correspondence, or duplicate-identity
   uncertainty is a typed error that marks the run not-comparable. There is no lenient
   or serve-with-flag mode in v1. (Propagation mode — journal resume with a changed
   call — already works today and is not respecified here.)

**Why.** The orchestrator's differentiator is mixing harnesses/models per step in one
script. Substitution testing answers "can step N run on a cheaper model/harness with a
comparable outcome?" from the user's own recorded runs. Isolation mode is the missing
execution mechanism; Gaps A and B are the seam/persistence facts it needs.

**Design posture (normative for interpretation).** Where a correspondence between a live
call and a recorded row cannot be established from engine-computable facts, the isolation
run fails with a typed error rather than serving a guess. A narrower v1 that refuses
loop-shaped downstream regions and unproven baselines is preferred over a wider one
that can silently produce a wrong verdict. Consequently some
legitimate scripts and recordings are not isolatable in v1 (§4.6.4 and §4.12 enumerate
them); for those steps, propagation mode exists today.

### Non-goals (out of scope, consumed later by the evals package)

- Scoring ("comparable" verdicts), vitest-evals integration, N-sample repetition and
  aggregation, substitution-report UX. The eval harness re-runs `runIsolation` itself
  for repetition; this contract provides a single-shot primitive (§4.10).
- The trajectory sink. Gap B is forward-compatible with it (per-call usage + manifest,
  keyed by call index) without pre-building it.
- Any MCP tool surface. Isolation ships as a library surface (engine + SDK) only.
- Any backend-specific behavior. Nothing here names Claude/Codex/OpenCode; the replay
  wrapper wraps ANY `AgentRunner`, and a target's model override is interpreted by the
  inner runner exactly like any other `RunOptions.model` spec.
- Changes to `@automatalabs/agentprism-otel`. New event fields ride payloads otel
  already ignores unknown fields on (`packages/agentprism-otel/src/attach.ts:213-278`).
- Isolation over recordings that used nested `workflow()` — excluded entirely (§4.9;
  the run-level marker of §2.3 makes the exclusion enforceable).

### Hard constraints

- **Additive only.** No breaking change to `AgentRunner`, `RunOptions`, the
  `hashAgentCall`/`hashCheckpoint` byte layouts (pinned by
  `packages/workflow-engine/test/journal-hash.test.ts:42-64`; journal compatibility with
  existing recorded runs is a hard requirement), persisted-file readability of old runs,
  or any public SDK export. The disclosed value-semantics and settlement-semantics
  corrections (§3.0 record-time freezing; §3.3a args snapshot; §2.6 guarded terminal
  observers; §3.3a post-terminal event drop) are called out in the changeset as behavior
  fixes.
- **Backend-symmetric.** The isolation runner wraps any `AgentRunner`.
- **No deferred work.** Everything specified here is implemented in full; nothing inside
  the agreed scope is stubbed. Conversely, the scope is deliberately tight.

## Table of contents

0. **Definitions**
1. **Verified engine baseline**
2. **Gap A — call identity to the seam**
   - 2.1 `RunOptions` additions · 2.2 numbering contract · 2.3 nested `workflow()` —
     scope ordinal + run marker · 2.4 checkpoint identity · 2.5 the call-path key ·
     2.6 terminal-transition settlement (exactly-once) · 2.7 the input fingerprint ·
     2.8 compatibility
3. **Gap B — per-call usage, the call manifest, honest run-file typing**
   - 3.0 record-time frozen snapshots · 3.1 `JournalEntry` additions · 3.2 the call
     manifest + completeness accounting · 3.2a `WorkflowRecordedError` · 3.3 engine event
     additions + sealed telemetry + result provenance · 3.3a manager state fixes (args,
     cwd, runtime, limits, markers) · 3.4 snapshot + `PersistedAgentState` typing ·
     3.5 usage semantics ·
     3.6 resume semantics · 3.7 old-file tolerance
4. **Isolation runner**
   - 4.1 placement · 4.2 quarantine — `executionMode` + the persisted report · 4.3 engine
     API · 4.4 target selection + baseline-model evidence · 4.5 model override ·
     4.6 serving and divergence semantics (strict) · 4.7 checkpoint serving ·
     4.8 observability and persistence · 4.9 preconditions and error codes · 4.10 SDK
     surface · 4.11 explicitly not in this feature · 4.12 normative limitations
     (fail-closed)
5. **Run-file contract status**
6. **Per-package change list**
7. **Test plan**
8. **Docs & changeset plan**
9. **Implementation order**
10. **Considered and rejected** — terse dispositions

## 0. Definitions

- **Recording / baseline** — a `PersistedRunState`
  (`packages/workflow-engine/src/run-persistence.ts:39-82`) of a completed, journaled run
  that satisfies every §4.9 admissibility check: full `script`, snapshot `args`,
  `agents[]`, `journal[]`, `calls[]` (§3.2), `callsAllocated` (§3.2), `effectiveCwd`,
  `runtime`, `limits`, `environment` (§3.3a), and none of the disqualifying markers
  (§3.3a, §4.2).
- **Call index** — `state.callSeq++` assigned at lexical call time, before the
  concurrency limiter (`workflow.ts:503` for `agent()`, `:1007` for `checkpoint()`); one
  shared, monotonic, dense-from-0 index space per engine run. Nested `workflow()`
  children restart at 0 under their own scope (§2.3); `workflow()` itself consumes no
  parent index (`workflow.ts:805-836` never touches `callSeq`).
- **Call hash** — `hashAgentCall` (`workflow.ts:1337-1361`): sha256 of
  `{prompt, model (resolved spec), mode (ONLY when set), tier, phase, agentType,
  agentDef, schema}`; `hashCheckpoint` (`:1327-1335`): sha256 of
  `{promptText, kind, choices}`. `label`, `cwd`, `mcpServers`, `images`,
  `meta`/`promptMeta`, `keepSession` are deliberately NOT hashed. **The agent hash
  therefore proves the REQUESTED (script-resolved) model spec and prompt — never the
  model a backend actually served (§4.4), and never the unhashed behavioral inputs.**
  This contract nowhere treats hash equality alone as full behavioral identity: every
  serving decision also requires path equality (§4.6), and target binding additionally
  requires input-fingerprint equality (§2.7, §4.6.2 rule 3).
- **Call path** — the synchronous script call path of the frame chain that made the call
  (§2.5): every selectable workflow-script stack frame in the innermost contiguous run
  at call time, normalized to body-relative `"line:column"`, joined innermost-first with
  `"<"`. A structural identity: stable for a byte-identical script under the same
  call-path format and Node major (§2.5), independent of data and completion order.
- **Input fingerprint** — `hashCallInputs` (§2.7): sha256 of the canonical strict-JSON
  of the call's resolved unhashed execution inputs — cwd, isolation, images,
  mcpServers, meta, promptMeta, keepSession, the resolved label, the effective
  timeout/retry values, and the approved-backends digest (r6 B1). Recorded per call
  (`WorkflowCallRecord.inputsHash`), threaded to the seam
  (`RunOptions.callInputsHash`), and REQUIRED to match for target binding — the
  fail-closed guard against a live target executing with unhashed context the baseline
  never saw (r5 B1, r6 B1).
- **Identity of a call** — the triple `(kind, path, hash)`. §4.9 rejects recordings in
  which two rows share an identity, so within an admissible recording an identity names
  at most one row.
- **Scope** — the engine run a call belongs to: the emitting run's `runId` (root, or the
  engine-generated `` `${parentRunId}-nested<ordinal>` `` for a `workflow()` child,
  where `<ordinal>` is a root-run-wide monotonic invocation counter — §2.3). Matched by
  exact string equality only. NOTE (precondition): at the bare `runWorkflow` layer,
  `WorkflowRunOptions.runId` is caller-supplied and the engine does not enforce global
  uniqueness — `(runId, callIndex)` is a cross-run key only for callers that keep runIds
  unique, which `WorkflowManager` and `runIsolation` do (§4.8's collision guard). Direct
  engine callers own that precondition.
- **Recorded call table** — the preflight-normalized view of a recording: one row per
  root call index, built from `calls[]` with `{kind, hash, path, inputsHash?, outcome,
  origin, usage?, error?, modelRequested?, modelResolved?, backendId?, modelFallback?,
  worktree?, isolation?, resolvedCwd?, budgetDebit?, settlementOrdinal?,
  journalEntry?}`.
- **Target** — a call the isolation run executes live on the inner runner, optionally
  with a model override. Targets are matched at runtime by exact identity plus input
  fingerprint (§4.6); a target's identity is unique in any admissible recording by
  construction.
- **Served call** — a non-target call whose recorded outcome the replay wrapper returns
  (value, `null`, or reconstructed throw — §4.6.3) without invoking the inner runner.
- **Single-occurrence path** — a `(kind, path)` pair that exactly one row of the
  recording carries. Only such rows are servable when the live hash mismatches (§4.6.2
  rule 6); everything else fails closed.
- **Divergence** — any live arrival the serving rules cannot establish a correspondence
  for. Always fatal, always typed (`REPLAY_DIVERGENCE`), always latched (§4.6.5).

## 1. Verified engine baseline

Every load-bearing fact below was re-verified against the code on 2026-07-14.

**The seam.** `AgentRunner` is one method, `run<S>(prompt, options?: RunOptions<S>):
Promise<AgentResult<S>>` (`packages/shared-types/src/agent-runner.ts:16-64`). The return
is a JSON-serializable value; usage is out-of-band via `options.onUsage`
(`agent-run.ts:96-97`). The opts bag is passed `as any` (`workflow.ts:672`) — field names
are the contract. Injection points: `WorkflowManagerOptions.agent`
(`workflow-manager.ts:135`), per-run `ExecOptions.agent` (`:78`),
`RunDynamicWorkflowOptions.runner` (`packages/workflows/src/index.ts:465`).

**Pre-allocation gates (r5 B2).** Four checks run BEFORE `callIndex = state.callSeq++`
and leave no journal or manifest trace when they throw: abort (`workflow.ts:435`), agent
limit (`shared.agentCount >= maxAgents`, `:438-444`), run token budget (only when
`options.tokenBudget` is set, `:446-450`), and phase sub-budget (only when the script
called `phase(title, { budget })`, `:458-474`). `checkpoint()` has the same
pre-allocation abort + agent-limit gates (`:998-1006`). Both primitives increment
`shared.agentCount` immediately after allocation (`:518`, `:1011/:1015`), so for a
completed non-nested run the final `agentCount` equals `callsAllocated`, and
`callsAllocated < maxAgents` PROVES no agent-limit gate ever fired (the counter is
monotonic and checked strictly-before increment). §4.9 turns the limit/abort gates into
admissibility conditions; the budget gates are REPRODUCED by trajectory replay (below).

**The script-visible budget surface (r5 B4 / r6 B4).** The vm receives a frozen
`budget = { total, spent(), remaining() }` (`workflow.ts:415-419`, injected `:1081`).
`spent()` accrues in SETTLEMENT order (`recordTokens` fires as each attempt settles,
`:597-609`, `:685`, `:704`). Under isolation the recorded per-call debits are replayed
at this surface in recorded settlement order (§3.5 capture, §4.6.8 application rule), so budget
reads, run `tokenBudget` gates, and phase sub-budget gates reproduce the recording up
to the disclosed concurrent-read race (§4.12 item 5). No budget-based admissibility
exclusion exists (r6 B4 removed the r6-draft AST probe and budget-recording refusals).

**Invocation and failure paths.** The runner is invoked inside the limiter thunk, once
per retry *attempt* (retry loop `workflow.ts:611-739`, up to `agentRetries + 1`
attempts); `callIndex`/`callHash` are computed once per `agent()` call before the limiter
(`:503-511`) and are identical across attempts. Terminal paths of one logical call:
- *Success*: journals `{index, hash, result, session?}` (`:688`), fires success
  `onAgentEnd` (`:689-697`), returns (`:698`).
- *Recoverable exhaustion*: resolves `null` WITHOUT journaling (`:731-736`), after a
  failure `onAgentEnd` (`:718-729`).
- *Non-recoverable error*: failure `onAgentEnd`, then the `WorkflowError` is thrown into
  the script (`:737`) — catchable there. Journal: nothing.
- *Engine-side post-allocation throw before the seam*: the `agentOptions.cwd` validation
  (`:561-566`) throws inside the limiter thunk before the retry `try` — index allocated,
  runner never invoked, no `onAgentEnd`.
- *Abort*: a rejection while `signal.aborted` is rethrown RAW (`:700`), bypassing
  `wrapError`; it propagates into the script and is CATCHABLE; a script that catches it
  and returns normally is marked `"completed"` (`workflow-manager.ts:627-636`).
  `checkpoint()` has the same post-allocation abort exit (`:1045`).

**`onAgentEnd` is NOT exactly-once today (r5 B6 — corrected fact).** The success
`onAgentEnd` (and the journal write) sit INSIDE the attempt `try` (`:688-698`); a
throw from either observer is caught at `:699`, classified by `wrapError`, and can
re-enter the retry ladder — a second, contradictory failure `onAgentEnd` for the
same logical call. Publicly reachable: the manager's `onAgentEnd` handler invokes
the user's `onProgress` directly (`workflow-manager.ts:593-608`, `:524-527`), so a
throwing `onProgress` converts an observed success into a retry/failure. §2.6 fixes
this with a guarded, exactly-once terminal-transition contract — the settlement
signal §4.6 rule T builds on. The wrapper seam still cannot see retry
classification, the empty-output conversion (`:678-683` fires AFTER the wrapper
resolved), or logical exhaustion (`:731-736` returns `null` without re-entering the
wrapper) — why settlement is observed on the engine event, never at the seam.

Usage is reset per attempt (`:613`) and `recordTokens` charges every attempt into the run
aggregate (`:685,:704`). `withTimeout` is a bare `Promise.race` (`:1405-1427`): TODAY a
timed-out attempt's runner promise keeps running under the still-live run signal and its
callbacks can fire later — §3.5 defines the attempt-sealed slots, the disclosed
undercount, AND the per-attempt abort that now cancels the loser (r6 B13); sealed
telemetry surfaces ONLY through the engine's terminal event (§3.3), never through
wrapper-side interception (r5 B7). Empty-text results throw recoverable `AGENT_EMPTY_OUTPUT` before journaling, but
ONLY for schema-less calls (`isEmptyTextAgentResult` requires `schema === undefined`,
`:678-683`, `:1384-1386`).

**Index assignment is completion-ordered after awaits.** `parallel()`/`pipeline()` start
thunks in array order, but each continuation advances independently after its awaits
(`workflow.ts:748-801`): indexes of calls made in continuations follow the completion
order of what they awaited. Under isolation, serving itself changes latencies, so index
positions are systematically NOT comparable between a recording and a replay — and
settlement order is SCRIPT-VISIBLE (realm promises, `Promise.race`/`.then` ordering), so
a script can branch on it. This contract never uses index position as a serving key
(§4.6); order-sensitive target context is caught fail-closed by the input fingerprint
(§2.7); residual order sensitivity is a §4.12 limitation.

**Checkpoints.** `checkpoint()` allocates an index (`:1007`), hashes (`:1008`), replays
from the resume journal (`:1010-1013`), then consults `options.confirm(promptText,
checkpointOptions)` FIRST whenever a confirm is wired (`:1018-1019`; its throw propagates
RAW and is catchable); headless handling applies only with no confirm (`:1020-1043`);
the reply journals after it exists (`:1046`). In any run that wires a confirm — an
isolation run always does — every checkpoint reaches that confirm, including ones that
resolved headlessly in the recording.

**Resume.** Replay requires hash match AND `callIndex < state.firstMiss` (`:526-547`).
Resume re-executes the full script; replayed calls short-circuit without invoking the
runner (`:529-543`) but DO fire `onAgentStart`/`onAgentEnd`. The manager seeds a resumed
run's journal with the entire prior journal (`workflow-manager.ts:948`, map at `:955`);
live writes replace same-index entries (`:708-714`); nothing truncates a stale suffix.

**The vm and the script.** `parseWorkflowScript` validates `meta.name` only as a
non-empty string — it may contain path separators. The body runs as
`${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()` compiled with
`new vm.Script(wrapped, { filename: \`${meta.name || "workflow"}.js\` })`
(`:1103-1108`) — §2.5 replaces that filename with an engine-sanitized one. The
prelude neuters `Date`/`Math.random` in-realm; `DETERMINISM_BLOCKLIST` rejects
`Date.now()`/`Math.random()`/`new Date()` at parse (`:1147-1153`);
`vm.createContext` injects only the engine surface (`:1064-1092`). **The vm is NOT
a security sandbox** — an injected bridge function's `.constructor` is the host
`Function` (`:297-308`), so a determined script can reach host state. This contract
never claims script determinism is *proved*; §4.6.1 states the enforceable
correspondence boundary and why every violation fails closed or affects only
non-compared surfaces (r5 B12).

**Persistence.** One JSON file per run; `RunPersistence.load` is an unchecked
`JSON.parse` cast with a `.bak` fallback (`run-persistence.ts:218-231`); `save`
overwrites `<runId>.json` unconditionally (`:201-216`); `acquireRunLease` checks
only a live `.lock` file — NOT a uniqueness guard (`:282-313`; why §4.8's guard is
lease-FIRST, r6 B10). The manager persists agents by spreading the live snapshot
(`workflow-manager.ts:765-769`), writing undeclared `tokens`/`resultPreview` (§3.4
fixes). ALL THREE run-creation paths store the caller's `args` by reference and
re-persist it at terminal time — `runSync` via `createManaged` (`:356`, `:418`,
engine at `:371`), `startInBackground` inline (`:299`, `:317`, `:339`),
`resumeInBackground` inline (`:943`, `:973`) — so script mutation leaks into
persisted args on every path (§3.3a fixes; r5 B10 / opus B1). Persisted `cwd` is
only the per-exec override; execution falls back to the manager cwd (`:544`), NOT
persisted (§3.3a fixes). `resumeInBackground` accepts paused AND failed runs
(`:831-844`) — why §4.2's quarantine is a run-level marker checked by resume.
`stop()` accepts only running/paused runs (`:981-991`) — why floated-target
containment needs §4.3's internal abort, not `stop()` (r5 B8).

**Manager journaling and events.** The manager always passes `journaling: true`
(`:561`) and gates file persistence itself; `recordJournalEntry` (`:708-714`) keeps
the latest entry per index, persists, and emits the public `journal` event — TODAY
with the same object reference it later persists, so a mutating listener could edit
the persisted result (§3.0 freezing closes this; r5 B9). `onAgentEnd` locates the
snapshot row by a label reverse-find (`:594-596`) — ambiguous under duplicate labels
and nested children (§3.3 fixes). Nested `workflow()` children spread the parent's
callbacks with a child-local index space (`workflow.ts:805-836`), so child journal
entries COLLIDE with parent indexes today (§2.3 fixes); the child runId derives from
`shared.depth`, decremented in `finally` (`:829`, `:834`), so SEQUENTIAL SIBLINGS
reuse the same id today (§2.3's ordinal fixes; r5 B5).

**Model resolution.** Per-call precedence, exactly (`workflow.ts:484-499`): explicit
`model` > `agentType.model`; else, **when `tier` is set**, the tier-resolved model
or — with no configured entry — `options.mainModel` (phase/meta routing NOT
consulted for tier-bearing calls); else phase-resolved routing (which consults
`meta.model`), then the optional host-pinned `options.defaultModel`. The resolved spec
(`modelSpec`) is what `hashAgentCall` hashes and
the runner receives; `onModelResolved`/`onModelFallback`/`onSessionOpen` are
OPTIONAL callbacks a conforming ACP runner invokes
(`acp-agents/src/runner.ts:1262-1276`) but a structural `AgentRunner` may ignore —
absence proves nothing about the served model; §4.4 demands POSITIVE recorded
evidence (r5 B15). With no spec, backend selection varies with runner
configuration/environment (`runner.ts:1457-1467`). Tier config and the agent
registry are re-read per run (`workflow.ts:343-358`), so config drift changes call
hashes without a script change.

**Floated calls.** The engine awaits the script promise plus one tripwire turn
(`workflow.ts:1103-1122`; `rejection-tripwire.ts:121-123`) — NOT a still-pending
floated `agent()` call. The manager then marks completion and persists
(`workflow-manager.ts:627-636`), after which the floated call's late journal/event
emissions would mutate a terminal artifact (§3.3a's post-terminal drop closes this;
r5 B8). A `"completed"` run file can therefore lack a terminal record for an
allocated call; §3.2's `callsAllocated` accounting makes that *detectable* instead
of pretending it cannot happen.
---

## 2. Gap A — call identity to the seam

### 2.1 `RunOptions` additions (type diff)

`packages/shared-types/src/agent-run.ts` — four optional fields appended at the
interface tail, matching the surrounding field-doc conventions:

```ts
export interface RunOptions<S extends TSchema | undefined = undefined> {
  // … existing fields unchanged …

  /** The engine's deterministic journal index for THIS agent() call — the same
   *  value as JournalEntry.index / WorkflowCallRecord.index. Assigned at lexical
   *  call time BEFORE the concurrency limiter; identical on every retry attempt.
   *  The index space is shared with checkpoint() (runner-visible indexes have gaps
   *  at checkpoint positions) and scoped to ONE engine run — `runId` is the scope
   *  discriminator at this seam; (runId, callIndex) is a cross-run key only when
   *  the caller keeps runIds unique (WorkflowManager and runIsolation do; bare
   *  runWorkflow callers own that precondition). ADDITIVE, not a hash input.
   *  Omitted only by callers that are not the engine. */
  callIndex?: number;

  /** The call-identity hash for THIS call — the same value as JournalEntry.hash /
   *  WorkflowCallRecord.hash (hashAgentCall, workflow.ts:1337-1361). Proves the prompt
   *  and the REQUESTED (script-resolved) model spec — never the model a backend
   *  actually served, and never the unhashed inputs (label/cwd/images/mcpServers/meta).
   *  Identical across retry attempts. ADDITIVE, not itself a hash input. */
  callHash?: string;

  /** The structural call-path key for THIS call (§2.5): body-relative "line:column"
   *  workflow-script frames, innermost first, joined with "<". Stable for a
   *  byte-identical script under the same call-path format + Node major (§2.5).
   *  Identical across retry attempts. ABSENT when capture failed or was ambiguous —
   *  never fabricated, never truncated. ADDITIVE, not hashed. */
  callPath?: string;

  /** The input fingerprint for THIS call (§2.7): sha256 of the canonical strict-JSON
   *  of the call's resolved unhashed execution inputs (cwd/isolation/images/mcpServers/
   *  meta/promptMeta/keepSession/label/effective timeout+retries/approved-backends
   *  digest — r6 B1). Identical across retry attempts. ABSENT when any component fails
   *  strict-JSON canonicalization — never fabricated. ADDITIVE, not a hash input. */
  callInputsHash?: string;
}
```

Engine change (`workflow.ts:621-672`): thread `callIndex`, `callHash`, `callPath`,
`callInputsHash` (the values computed at `:503-511`, §2.5, §2.7) into the opts bag.

**Deliberately NOT threaded** (per Q1): `phase`/`agentType` as clean fields (both are
hash inputs already; the recording's `agents[]` carries `phase`); a retry-attempt
counter (a wrapper must treat repeated invocations with identical identity as one
logical call — §4.6 rule 1; the manifest records the attempt count); any provenance or
allocation callback (cut in revision 5; the round-4/round-5 reviews proved the epoch
machinery they served cannot be implemented soundly at the seam).

### 2.2 The numbering contract (normative)

1. **Assignment.** `callIndex = state.callSeq++` at lexical call time (`:503`,
   `:1007`), synchronously, before any await and before the limiter. One shared
   dense space per engine run, starting at 0. `workflow()` consumes no index.
   **Identity precedes allocation (r6 B7):** `modelSpec`, `callHash`/
   `hashCheckpoint`, `callPath`, and `callInputsHash` are computed IMMEDIATELY
   BEFORE the increment (today the hashes sit after it, `:504-511`, `:1008` —
   moved). A throw during identity computation (a cyclic/BigInt `schema` or
   `choices` breaking `JSON.stringify`) is therefore PRE-allocation: no index
   consumed, no record owed, the error propagates into the script typed
   (`wrapError`), and replay reproduces it from the byte-identical script or fails
   closed structurally.
2. **Determinism — and its limit.** Invocations reached synchronously are indexed in
   lexical order. Invocations reached in a continuation after an `await` are indexed in
   the completion order of the awaited promise (`workflow.ts:748-801`) — under real
   latency variation, NOT source-ordered and NOT stable between a recording and a
   replay. No consumer may use index position as cross-run correspondence; §4.6 does
   not.
3. **Retries.** One `agent()` call = one `callIndex`/`callHash`/`callPath`/
   `callInputsHash`, up to `agentRetries + 1` runner invocations, all carrying
   identical identity.
4. **Resume.** A resumed run re-executes the script; `callSeq` restarts at 0.
   Journal-replayed calls do not invoke the runner.
5. **Checkpoint gaps.** Checkpoints consume indexes but never reach the runner.
6. **Failure indexes.** Calls that exhaust retries, throw into the script, die on
   engine-side post-allocation validation, or abort post-allocation consume their index
   and never journal; the manifest (§3.2) records their terminal outcome. Calls blocked
   by a PRE-allocation gate (§1) consume nothing and leave no trace — §4.9's
   admissibility conditions are what make that invisibility harmless for isolation.
7. **Nested runs.** A `workflow()` child is its own engine run: child-local index space,
   child `runId` at the seam, child `scope` on entries/records/events (§2.3).

### 2.3 Nested `workflow()` — invocation-ordinal scope, root-only persistence, run marker

**Unique child scope (r5 B5 — fix).** Today the child runId is
`` `${runId}-nested${shared.depth}` `` with `depth` decremented in `finally`
(`workflow.ts:829`, `:834`), so two sequential sibling children both run as
`<root>-nested1` and their calls collide on `(scope, index, path, hash)`. Normative fix:
`SharedRuntime` gains `nestedSeq: number` (initialized 0, root-run-wide, monotonic,
NEVER decremented); `workflowFn` computes `const ordinal = ++shared.nestedSeq` and the
child runId is `` `${runId}-nested${ordinal}` ``. `shared.depth` remains solely the
one-level nesting guard (`:807-811`). The first child of a run keeps today's
`-nested1` name; every subsequent child — sibling or not — gets a distinct ordinal, so
`(runId, callIndex)` is unique across all runs of one root execution. Pinned by test:
two sequential identical sibling children carry distinct scopes; two distinct parent
call sites likewise.

**Scope threading.** Every journal entry, call record, and agent event gains the
emitting run's `scope` (its own `runId`): `JournalEntry.scope?` (§3.1),
`WorkflowCallRecord.scope?` (§3.2), `onAgentStart`/`onAgentEnd`/`onAgentHistory` event
`scope` (§3.3). `workflowFn` keeps spreading parent callbacks unchanged; children keep
emitting, now self-identifying.

**Root-only persistence.** `recordJournalEntry` (`workflow-manager.ts:708-714`) still
emits the `journal` event for every entry (documented behavior preserved), but adds an
entry to `managed.journal` — the resume map and the persisted journal — ONLY when
`entry.scope === undefined || entry.scope === managed.runId`. Same rule for call
records. Effect: persisted journals/manifests contain only root-index-space rows; the
historical child/parent index collision is gone for new files. (Old files may contain
collided entries; §3.3a's `legacyResume` marker plus §4.9 keep them out of evals.)

**Run marker + immediate invocation callback (r6 B2).** `workflowFn`
(`workflow.ts:805-836`) sets a run-level flag when it is INVOKED — before resolving
or executing the child, so aliasing (`const w = workflow; await w(x)`), zero-call
children, and checkpoint-only children all set it. The flag surfaces as
`WorkflowRunResult.nestedWorkflows?: true` (additive) and persists as
`PersistedRunState.nestedWorkflows?: true` (§3.3a). At the same synchronous point
the engine invokes the additive `WorkflowRunOptions.onNestedWorkflow?: (ordinal:
number, childRunId: string) => void` (throws propagate like any non-terminal
callback, §2.6); the manager threads it via `ExecOptions.onNestedWorkflow?`. This
pair enforces isolation's nested exclusion (§4.9 recording-side; §4.3 replay-side):
the callback stops spend the moment an unsupported child is invoked — even a
zero-call child that would emit no wrapper arrival — and the returned flag is the
finalize backstop (§4.3 step 6). No static scan, no event inference.

**Sessions (unchanged).** Child sessions reach snapshot/persisted `agents[]` rows and
`getPersistedAgentSessions()`, not `WorkflowRunResult.agentSessions`
(`workflow.ts:832`, `workflow-manager.ts:490-494`). Not changed here.

### 2.4 Checkpoint identity — `CheckpointCallContext`

Checkpoints bypass the runner, so isolation needs identity on the `confirm` channel.
New exported interface in `packages/workflow-engine/src/workflow.ts` and a widened
(additive) `confirm` signature:

```ts
/** The engine-computed identity of one checkpoint() call, handed to the confirm
 *  callback as its (additive) third argument. */
export interface CheckpointCallContext {
  callIndex: number;
  hash: string;
  /** The emitting engine run's runId (root, or `${root}-nested<ordinal>`). */
  scope: string;
  /** The structural call-path key (§2.5), when captured. */
  path?: string;
}

// WorkflowRunOptions.confirm — before:
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
// after:
  confirm?: (promptText: string, options: CheckpointOptions,
             context?: CheckpointCallContext) => Promise<unknown>;
```

Call site (`workflow.ts:1018-1019`): pass `{ callIndex, hash: callHash, scope: runId,
path: callPath }`. `ExecOptions.confirm` (`workflow-manager.ts:115` — today
`(promptText: string, options: unknown)`) gains the same third parameter; both changes
are additive under parameter contravariance (a two-parameter host confirm remains
assignable and never sees the third argument). **What the checkpoint hash covers
(corrected, r6 B12):** `hashCheckpoint` (`:1327-1335`) hashes `promptText`, the
NORMALIZED `kind` (`kind ?? "confirm"`), and `choices` ONLY. The remaining
`CheckpointOptions` fields — `default`, `headless`, `timeoutMs` (`:254-264`) — are NOT
hashed and are INTENTIONALLY ignored by isolation: they shape only how a live
confirm/headless path would produce a reply, and under isolation every checkpoint
reply is served from the recording through the wrapper's confirm (§4.7), so the
un-hashed options can never influence a served outcome. Checkpoints therefore need no
input fingerprint.

### 2.5 The call-path key — capture mechanism and honest stability contract

Position-independent structural identity is what lets isolation distinguish "same call,
new content" from "different call". The key is the **synchronous script call path**.

**vm filename (normative — replaces today's raw `meta.name`).** The engine compiles the
script with `filename = sanitizeVmName(meta.name)`: every character outside
`[A-Za-z0-9._-]` replaced with `-`, truncated to 64 chars, `"workflow"` when the result
is empty, then suffixed `".js"`. The engine retains the exact string it passed. This
removes the two failure modes of the raw name (`meta.name` is validated only as
non-empty and used verbatim at `:1106`): a name containing path separators, and a name
colliding with a host module path — sanitized names contain no path separator, while
host frames carry absolute paths or `node:` specifiers, so a sanitized vm filename can
never equal a resolvable host frame filename. User-visible stack traces change only for
names that contained sanitized characters; stack-trace text is not a compatibility
surface.

**Capture (normative — r5 B11 fixes the frame-selection rule).** At call time — the
same synchronous window where `callIndex` is assigned — the engine captures the
stack via an `Error.prepareStackTrace` structured walk with `Error.stackTraceLimit`
set to the engine constant `CALL_PATH_RAW_FRAMES + 1 = 65`; both globals saved and
restored in `finally`. A raw array of 65 entries means deeper frames may exist →
`callPath` is `undefined` (an ambiguous prefix is never emitted). Otherwise: a frame
is **selectable** iff `frame.getFileName()` equals this run's exact vm filename AND
`frame.isAsync()` is false. (V8 DOES emit async frames carrying the vm filename, so
filename equality alone is NOT sufficient; the `isAsync()` exclusion is normative.)
Scanning from the innermost frame: skip non-selectable frames until the first
selectable one, take selectable frames until the first non-selectable one, then
STOP — an async frame terminates the chain even when its filename matches, which is
what truncates at an awaiting helper. Host-frame contiguity breaks (an engine
`workflowFn` frame always sits between child and parent script frames) exclude a
parent script's frames on a nested child's synchronous prefix even when both
scripts sanitize to the same filename. Each selected frame normalizes to
body-relative coordinates (`line = frameLine − (preludeLines + 1)`, column as
reported); the path joins frames innermost-first with `"<"` — e.g. `"3:10"`, or
`"3:10<12:17"` through a synchronous helper. No selectable frame → `undefined`.

**Stability contract (normative, honest).** The capture algorithm's identity is the
engine constant `CALL_PATH_FORMAT = 1`, persisted per run (`PersistedRunState.runtime.
pathFormat`, §3.3a) and bumped whenever the algorithm above changes in any observable
way. Guaranteed: for a byte-identical script captured under equal `pathFormat` on the
same Node.js MAJOR version, a given synchronous activation chain yields the same
`callPath` on every run, resume, and replay, independent of data, completion order, and
concurrency (pinned by test, §7). NOT guaranteed — explicitly disclaimed: V8 `CallSite`
position stability across ANY V8 change. The consequence is bounded fail-closed AND
gated before spend (r6 B14): preflight rejects a recording whose `pathFormat`,
`inputsFormat` (§2.7), FULL Node version (`process.version`), or FULL V8 version
(`process.versions.v8`) differs from the executing engine's (`RECORDING_UNUSABLE`,
reason `"runtime-mismatch"`, §4.9 check 8 — exact equality, not major-only), and every
serving rule requires path equality, so any residual drift that slips past the gate can
only produce a typed refusal — never a wrong serve (§4.12).
Granularity: one path covers every dynamic occurrence of one lexical activation chain
(loop iterations, mapped thunks); §4.6 refuses to guess between occurrences rather than
pairing them. Aliasing-proof: the path records where calls happened, not what the
callee was named.

The path is threaded to the runner (`RunOptions.callPath`), to `confirm`
(`CheckpointCallContext.path`), and persisted per call (`WorkflowCallRecord.path`).
Not added to `JournalEntry`; not hashed.

### 2.6 Terminal-transition settlement — exactly-once, guarded (normative)

Round 5 (B6) proved the previous "exactly once per logical call" claim false: the
success journal write and `onAgentEnd` sit inside the attempt `try` (`workflow.ts:
688-698`), so a throwing observer re-enters retry classification (`:699`) and can emit
a second, contradictory terminal event — reachable via a throwing user `onProgress`
(`workflow-manager.ts:524-527`, `:593-608`). Exactly-once settlement is load-bearing
for isolation's target observation (§4.6 rule T), and it is impossible to provide at
the wrapper seam — so this is the one place the contract changes engine semantics
(directive-2 sanctioned):

- **Settlement point.** A logical call SETTLES exactly once: on success, after the
  post-await abort check and the empty-output conversion have passed (`:677-683`); on
  failure, when the retry classifier reaches a terminal branch (exhaustion `:731-736`,
  non-recoverable `:737`, abort `:700`). Settlement is decided BEFORE any observer runs.
- **Guarded terminal observers.** At the terminal transition the engine invokes, in
  order, `onCallRecord` (§3.2), then `onAgentJournal` (success only), then
  `onAgentEnd` — each wrapped in its own `try/catch`. A throw from any of them is
  reported via `logger.error` (best-effort; a failure of the log call itself is
  ignored) and otherwise SWALLOWED: it never re-enters retry classification, never
  converts the call's outcome, never emits a second terminal event, and never fails the
  run. The ordering rule guarantees a journaled outcome can never exist without its
  manifest row.
- **Non-terminal callbacks are UNCHANGED** (`onLog`, `onPhase`, `onAgentStart`,
  `onTokenUsage`, mid-attempt `onHistory` forwards): their throws propagate exactly as
  today. This is a deliberately narrow carve-out, not an engine-wide throw-isolation
  contract (revision 4's version of that was withdrawn as breaking; §10).

Disclosed behavior change (changeset, §8): a throwing terminal observer previously
retried or failed the call; it is now logged and ignored. No plausible consumer relies
on observer throws mutating call outcomes.

### 2.7 The input fingerprint — `hashCallInputs` (normative)

The identity hash deliberately omits behavior-shaping inputs that ARE delivered to the
runner or shape how it settles (`workflow.ts:638-655`, `:550-552`). Round 5 (B1)
constructed an admissible recording whose replay runs the live TARGET with different
unhashed `images`; round 6 (B1) repeated the construction with `label` alone — the ACP
runner interpolates `Task label: ...` into the actual model prompt
(`packages/acp-agents/src/prompt.ts:23-26`) — and with dynamic `retries`, the approved
backend registry (forwarded unhashed at `:647-649`), and worktree degrade
(`worktree.ts:41-58`). The fingerprint closes every such hole, for exactly the call
that executes live:

- **Computation.** In the same synchronous window as `callIndex`/`callHash`, the engine
  computes `callInputsHash = sha256(canonicalStrictJson(inputs))` where `inputs =
  { cwd: agentOptions.cwd ?? null, isolation: resolvedIsolation ?? null,
  keepSession: agentOptions.keepSession === true, images: agentOptions.images ?? null,
  mcpServers: agentOptions.mcpServers ?? null, meta: agentOptions.meta ?? null,
  promptMeta: agentOptions.promptMeta ?? null,
  label: <the resolved label — requestedLabel || defaultAgentLabel(...), workflow.ts:519>,
  timeoutMs: <the effective value: agentOptions.timeoutMs !== undefined ?
  agentOptions.timeoutMs : agentTimeoutMs, :550, null when none>,
  retries: normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0)
  <the normalized capped value, :551/:1397-1400>,
  backends: <the run's approved-backends digest, below> }` (r6 B1). Every component is
  computable synchronously at call time. The script-level components are deliberately
  pre-resolution, so the fingerprint is stable across runs (the resolved worktree cwd
  embeds `runId`/`callIndex` via `createWorktree(baseCwd,
  `\`${runId}-${callIndex}-${label}\``)`, `workflow.ts:568-573`, and would never
  match); the effective timeout/retry components fold in run-level settings, which §4.3
  reproduces from the recording, so they too are replay-stable.
  `resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation`.
- **Approved-backends digest.** Once per run: `backends = options.scriptBackends ?
  sha256(canonicalStrictJson(<the registry as a name→config record>)) : null` — a
  non-secret canonical digest of the registry that selects executables/backends at the
  ACP runner (`acp-agents/src/runner.ts:1284-1310`). Supplying a different approved
  config under the same custom backend name changes the digest, hence the fingerprint.
- **Format identity.** The input list + canonicalization above carry the engine
  constant `CALL_INPUTS_FORMAT = 1`, persisted as `runtime.inputsFormat` (§3.3a) and
  gated at preflight (§4.9 check 8) — a fingerprint-algorithm change can never be
  compared across versions.
- **Canonical strict-JSON.** The §3.2a strict-JSON qualifier applied to `inputs`,
  serialized with recursively SORTED object keys (arrays keep order). Any component
  failing the qualifier (a function in `meta`, a cycle) ⇒ `callInputsHash` is
  `undefined` — never fabricated, never partial.
- **The engine cwd/worktree observation (r6 B1).** The fingerprint is
  pre-resolution, so the engine ADDITIONALLY records the post-resolution execution
  context per call: `WorkflowCallRecord.resolvedCwd` (the exact `runCwd` handed to
  the runner, `:578`, `:638`), `.isolation` (the resolved request), and the
  `worktree` created-flag (§3.2). Targets: worktree-requesting rows are rejected at
  preflight (`"worktree-target"`, §4.4), and every other target requires the live
  `options.cwd` to equal the row's `resolvedCwd` before delegating (§4.6.2 rule 3) —
  the engine-observed outcome, not an inference.
- **Consumption.** Threaded as `RunOptions.callInputsHash`; recorded as
  `WorkflowCallRecord.inputsHash?` (§3.2). Isolation requires equality when binding a
  TARGET (§4.6.2 rule 3): recorded row without `inputsHash` ⇒ the target is invalid at
  preflight (`REPLAY_TARGET_INVALID`, reason `"no-input-fingerprint"`); live value
  absent or unequal ⇒ fatal divergence `target-inputs-drift`. Served calls are NOT
  fingerprint-checked — their recorded outcome is returned without execution, so their
  live unhashed inputs are irrelevant by construction.
- **Not hashed, not a second identity.** The fingerprint never participates in serving
  correspondence, row lookup, or the journal hash; it is a guard on the one call that
  runs live, which is why it does not reintroduce the "parallel identity" problem that
  round 4 rejected.

### 2.8 Compatibility

- `RunOptions` gains only optional fields → every existing `AgentRunner` (plain-object
  test runners, `createAcpRunner`, the validate.ts mock) compiles and behaves unchanged.
- `hashAgentCall`/`hashCheckpoint` byte layouts untouched; the pin test
  (`journal-hash.test.ts:42-64`) must pass unmodified.
- The `confirm` widening is additive in both directions (§2.4).
- Engine events change only by gaining fields (§3.3) — additive for handlers.
- The nested-child runId ordinal (§2.3) changes an ENGINE-GENERATED id that IS
  observable outside the engine (r6 B12): it is threaded to the seam as
  `RunOptions.runId` (`workflow.ts:829` via `:652`) and the ACP runner stamps it into
  `session/new` `_meta` and event context (`acp-agents/src/runner.ts:1165-1168`).
  Sequential-sibling ids changing from a shared `-nested1` to distinct ordinals is
  therefore a disclosed observable behavior fix (§8 changeset item 7), not an
  internal-only change; the first child of any run keeps its current name.
- Terminal-observer guarding (§2.6) and the post-terminal event drop (§3.3a) are
  disclosed behavior fixes; all other callback failure semantics are unchanged.
---

## 3. Gap B — per-call usage, the call manifest, honest run-file typing

Decision (per Q2): per-call data persists in three places with distinct roles — the
**journal entry** stays the replay contract (index-keyed results), the **call manifest**
(`calls[]`, new) is the structural record (kind/hash/path/outcome/origin/usage per
terminal call, failures included), and the **`agents[]` snapshot row** stays the
diagnostic/display record, now joinable to both via `callIndex` + `scope`. The journal
alone cannot delimit a run's call space (failed calls never journal).

### 3.0 Record-time frozen snapshots (normative — r5 B9 replaces the lossy clone)

Recorded values must be immutable, replay-faithful facts. Today the engine journals the
runner's live object (`workflow.ts:688`), the manager retains that reference AND emits
it on the `journal` event (`workflow-manager.ts:708-714`), and later saves re-serialize
it — so both the script and any event listener can retroactively edit the recording.
Revision 5's `JSON.parse(JSON.stringify(v))` clone was refuted: it silently coerces
`Date`→string, `Map`→`{}`, `NaN`→`null`, and drops `undefined` members — values a
replayed script can distinguish (`"flag" in result`), breaking control-flow
equivalence. Normative replacement, applied at every capture boundary:

- **Strict validation, no coercion.** A captured value (agent result, checkpoint
  reply) must satisfy the §3.2a strict-JSON qualifier — aligning enforcement with
  the seam contract that already REQUIRES JSON-serializable returns
  (`agent-runner.ts`, `workflow-result.ts:118-120`). A qualifying value round-trips
  byte-identically; nothing lossy is ever recorded.
- **One frozen snapshot.** The engine deep-clones the qualifying value once and
  DEEP-FREEZES the clone (recursive `Object.freeze`). The SAME frozen snapshot is
  journaled, placed on the manifest row, carried on the `onAgentEnd` and manager
  `journal` events, and persisted — all artifacts agree byte-for-byte; no listener
  can mutate what is saved (listener writes throw in strict mode / no-op otherwise;
  disclosed). The SCRIPT receives the runner's ORIGINAL object — its mutations stay
  its own and never reach any artifact.
- **Validation failure — agent results.** A result failing the qualifier (cycle,
  BigInt, `Date`, `Map`, accessor, non-finite number, `undefined` member, custom
  prototype) fails the attempt with a non-recoverable
  `WorkflowError(AGENT_EXECUTION_ERROR)` naming the label and the first disqualifying
  path — raised inside the attempt `try`, a deterministic, disclosed failure replacing
  today's silent persistence corruption.
- **Validation failure — checkpoint replies.** `confirm` returns `Promise<unknown>`
  (`workflow.ts:1017-1019`), so a host can return anything. A reply failing the
  qualifier (including `undefined`) throws a non-recoverable
  `WorkflowError(AGENT_EXECUTION_ERROR)` whose message names the checkpoint prompt and
  the disqualifying path; it propagates into the script like any confirm throw
  (catchable), and the manifest records outcome `"error"`, origin
  `"confirm"`/`"headless"`, with the §3.2a projection of that error. (Headless default
  replies — `checkpointOptions.default ?? true`, `:1043` — are caller-authored data
  and validate the same way.)
- **Replay boundary.** The isolation wrapper serves fresh clones of recorded values and
  clones `liveResult` before placing it in the report (§4.6.3, §4.3), so neither the
  loaded recording nor the report is reachable through script references.

Disclosed behavior changes (changeset, §8): scripts that mutated a returned object to
edit the journal were depending on corruption; results/replies containing
non-strict-JSON values now fail typed instead of persisting silently-coerced data;
event payloads are frozen.

### 3.1 `JournalEntry` additions

`packages/shared-types/src/workflow-result.ts:105-113`:

```ts
export interface JournalEntry {
  index: number;
  hash: string;            // byte layout of the hash INPUT pinned by test — never extended
  result: unknown;         // now always the §3.0 frozen snapshot, never a live reference
  session?: AgentSessionRecord;
  /** NEW — which primitive journaled this entry. Absent on old journals ("unknown"). */
  kind?: "agent" | "checkpoint";
  /** NEW — the logical call's provider-reported usage: the §3.5 per-call sum. Absent on
   *  old journals, on checkpoint entries, and when no attempt reported in time. A
   *  present value is a LOWER BOUND on true spend (§3.5). The chars/4 estimate is never
   *  written here. Replay carries it verbatim. */
  usage?: AgentUsage;
  /** NEW — the emitting engine run's runId. Absent on old journals (treated as root).
   *  The manager persists only root-scope entries (§2.3). */
  scope?: string;
}
```

Write sites: `workflow.ts:688` (agent success — `kind: "agent"`, `usage`, `scope`,
frozen snapshot result), `:1046` (checkpoint — `kind: "checkpoint"`, `scope`, frozen
snapshot reply), and the manager's synthetic durable-checkpoint reply entry
(`workflow-manager.ts:957-967`), fully specified as
`{ index: checkpointContext.callIndex, hash: checkpointContext.hash, result:
<frozen snapshot of the host reply, §3.0-validated>, kind: "checkpoint",
scope: managed.runId }` (r5 B13.4 — every field named; a non-qualifying host reply
makes `resumeInBackground` reject the synthetic injection with the §3.0 typed error
before executing).

### 3.2 The call manifest — `WorkflowCallRecord`, `onCallRecord`, completeness accounting

New type in `packages/shared-types/src/workflow-result.ts`:

```ts
/** One record per TERMINATED call of an engine run, emitted at the call's terminal
 *  transition — including calls that never journal (failures, caught throws,
 *  engine-side deaths, aborts). What the journal is to results, this is to structure. */
export interface WorkflowCallRecord {
  /** Same space as JournalEntry.index. */
  index: number;
  kind: "agent" | "checkpoint";
  /** hashAgentCall / hashCheckpoint at call time. Present on every record. */
  hash: string;
  /** The structural call-path key (§2.5), when captured. */
  path?: string;
  /** The input fingerprint (§2.7), when computable. Agent calls only. */
  inputsHash?: string;
  /** options.label as resolved by the engine (agent calls). */
  label?: string;
  /** "result" — a value returned to the script; "null" — recoverable exhaustion
   *  resolved null (workflow.ts:731-736); "error" — a throw propagated into the
   *  script (catchable there). */
  outcome: "result" | "null" | "error";
  /** Which mechanism terminated the call:
   *  "runner"         — the injected AgentRunner ran on ≥1 attempt;
   *  "journal-replay" — the resume gate served it (agent :529-543 / checkpoint
   *                     :1010-1013) without re-driving the call;
   *  "confirm"        — the checkpoint's confirm callback produced the outcome;
   *  "headless"       — checkpoint headless handling produced it;
   *  "engine"         — the engine killed the call after allocation, before any seam
   *                     (cwd validation :561-566; a queued call's pre-seam abort :616;
   *                     checkpoint abort :1045). §4.9 rejects recordings containing
   *                     ANY engine-origin row (r5 B3). */
  origin: "runner" | "journal-replay" | "confirm" | "headless" | "engine";
  /** REQUIRED on outcome "null"/"error", forbidden on "result": the §3.2a projection
   *  of the terminal error/thrown value. */
  error?: WorkflowRecordedError;
  /** True exactly on the signal-abort exits (:700 rethrow; checkpoint :1045). §4.9
   *  rejects recordings containing any aborted row. */
  aborted?: boolean;
  /** Runner attempts that ran (origin "runner"; ≥1). */
  attempts?: number;
  /** The logical call's usage: the §3.5 per-call sum — present for failed calls too.
   *  A LOWER BOUND (§3.5). Journal-replayed calls carry the entry's usage verbatim. */
  usage?: AgentUsage;
  /** The REQUESTED (script-resolved) model spec the engine passed to the runner —
   *  workflow.ts:504's modelSpec; absent when resolution produced none. This is what
   *  the hash proves. NOT the served model. */
  modelRequested?: string;
  /** The runner-reported concrete model id — the terminal attempt's SEALED
   *  onModelResolved value (§3.5). POSITIVE evidence of what was served; absent when
   *  the runner never reported (structural AgentRunners may not — §4.4). */
  modelResolved?: string;
  /** The terminal attempt's SEALED onSessionOpen backendId, when reported. */
  backendId?: string;
  /** True when any SEALED attempt fired onModelFallback: the requested spec was not
   *  fully honored by the backend. */
  modelFallback?: true;
  /** True when the engine created a git worktree for this call (workflow.ts:568-573). */
  worktree?: boolean;
  /** The resolved isolation request at call time (§2.7); absent when none. */
  isolation?: "worktree";
  /** The post-resolution execution directory handed to the runner (workflow.ts:578,
   *  :638) — the engine-observed cwd/worktree outcome (r6 B1). Agent×runner rows. */
  resolvedCwd?: string;
  /** What this logical call added to the run's script-visible spent (shared.spent) —
   *  all attempts summed, chars/4 estimates included when the provider reported
   *  nothing (r6 B4). 0 on journal-replayed rows; absent on checkpoint rows. */
  budgetDebit?: number;
  /** 1-based position of this call's terminal transition in the run's settlement
   *  sequence (run-wide monotonic counter, serialized by the event loop; checkpoint
   *  transitions consume ordinals too). The budget-trajectory replay key (§4.6.8). */
  settlementOrdinal?: number;
  /** The terminal attempt's SEALED runner-reported result provenance (§3.3): whether
   *  the result was produced live or replayed from a recording. Absent when the
   *  runner reported none (every ordinary runner). Permitted only on origin
   *  "runner" rows. */
  provenance?: AgentResultProvenance;
  /** The emitting engine run's runId. Manager persists root-scope records only. */
  scope?: string;
}
```

**Emission — the manifest is ENGINE-OWNED state (normative, r6 B7).** At each call's
terminal transition the engine FIRST appends the frozen record to its own
run-internal manifest — a pure data append no observer can prevent — assigning the
row's `settlementOrdinal` there. Only THEN does it deliver the same frozen row to
the new guarded observer `WorkflowRunOptions.onCallRecord?: (record:
WorkflowCallRecord) => void`, first among that transition's guarded observers
(§2.6): the callback (and every downstream copy) is NON-authoritative. The engine
returns the authoritative array as `WorkflowRunResult.calls?: WorkflowCallRecord[]`
(root scope; additive); the manager collects `onCallRecord` rows for mid-run saves
but the TERMINAL save replaces `calls[]` with the engine-returned array, so a
throwing observer can never produce a completed artifact whose journal and manifest
disagree. The exits, exhaustively: agent journal-replay short-circuit (`:529-543` —
`"result"`, `"journal-replay"`, carried usage); checkpoint journal-replay
short-circuit (`:1010-1013`); live success (post-settlement, §2.6 — `"result"`,
`"runner"`, attempts, usage, modelRequested, modelResolved, backendId,
modelFallback); recoverable exhaustion (`:731-736` — `"null"`, `"runner"`, error,
attempts, usage); non-recoverable throw into the script (`:737` — `"error"`,
`"runner"`); engine-side post-allocation deaths — cwd-validation (`:561-566`) AND a
throwing `onAgentStart` (`:554`, reachable through a throwing manager `onProgress`,
`workflow-manager.ts:524-527`, `:581-592`; the throw still propagates into the
script) — both `"error"`, `"engine"`; the signal-abort rethrow (`:700` — `"error"`,
`aborted: true`, origin `"runner"` when any attempt ran, else `"engine"`);
checkpoint reply (`:1046` — `"result"`, `"confirm"`/`"headless"`); checkpoint
confirm/headless throws, the §3.0 reply-validation throw, and the durable-pause
throw (`:1018-1043` — `"error"`, `"confirm"`/`"headless"`); checkpoint
post-allocation abort (`:1045` — `"error"`, `"engine"`, `aborted: true`).
Identity-computation throws are PRE-allocation by §2.2 rule 1 — no record owed, so
no "record without a hash" state can exist.

**Completeness is CHECKED, never assumed (normative).** The guarantee is scoped to
MANAGED TERMINAL ARTIFACTS (r6 B7): in a manager-persisted run file with terminal
`status`, a journaled outcome can never lack its manifest row — both come from
engine-owned state written by the same terminal save. Exception windows in which an
ALLOCATED call has no row — exactly two: (a) a floated call still pending when the
script settles (§1; its row is missing from the engine-returned array, so
`callsAllocated ≠ calls.length` — detectable); (b) process crash before the terminal
save (the file is then not `"completed"`). Observer throws are NOT a window: the
append precedes delivery. The engine returns the final allocation counter —
`WorkflowRunResult.callsAllocated?: number` (additive; `state.callSeq` at return) —
persisted by the manager (§3.3a). A recording is *complete* iff
`status === "completed"` AND `callsAllocated === calls.length` AND indexes dense
from 0; §4.9 rejects incomplete recordings naming the missing indexes.
Pre-allocation gate failures (§1) are structurally invisible to this accounting;
§4.9's limit/abort admissibility conditions prove those gates never fired, and the
budget gates reproduce under trajectory replay (§4.6.8) (r5 B2 / r6 B4).

**Effective execution inputs and abort accounting (r5 B2/B4).** The engine returns
`WorkflowRunResult.effectiveLimits?: { maxAgents: number; tokenBudget: number |
null; concurrency: number; agentRetries: number; agentTimeoutMs: number | null }` —
the RESOLVED values in force: `maxAgents` (`workflow.ts:346`), `agentTimeoutMs`
(`:347`), `concurrency` (`:384-385` — the default derives from the HOST's
`hardwareConcurrency`, so it must be recorded, not re-derived), the run-level
`agentRetries` as NORMALIZED and capped by `normalizeAgentRetries` (consulted per
call at `:551`, capped at `:1397-1400` — the value in force, never the raw option;
r6 B12), and `options.tokenBudget ?? null`. Per-call script-authored overrides
(`:550-551`) reproduce from the byte-identical script and are pinned per call by
the fingerprint (§2.7). The engine also returns
`WorkflowRunResult.abortSignaled?: true` (set iff the composed signal was ever
observed aborted). The manager persists both (§3.3a). These are the admissibility
and reproduction inputs: a completed baseline with `callsAllocated < maxAgents` and
no `abortSignaled` provably never hit the limit/abort pre-allocation gates, §4.3
reproduces every recorded execution setting (tokenBudget included — r6 B4), and the
budget gates reproduce under trajectory replay (§4.6.8).

**Persistence.** `PersistedRunState.calls?: WorkflowCallRecord[]` — collected
latest-per-index, root-scope only (§2.3), reset to the current execution on resume
(§3.6).

### 3.2a The recorded-error projection — `WorkflowRecordedError`

Recorded caught failures must replay with equivalent control flow, or not at all. New
type in `packages/shared-types/src/errors.ts`:

```ts
/** Strict-JSON projection of a thrown value recorded in a run's call manifest. */
export interface WorkflowRecordedError {
  /** "workflow-error" — instanceof WorkflowError; "error" — any other Error;
   *  "value" — a non-Error thrown value. */
  form: "workflow-error" | "error" | "value";
  name?: string;           // form "error": the error's name (guarded read)
  /** REQUIRED for forms "workflow-error" and "error" (r5 B13.2 — WorkflowError's
   *  constructor requires a string, errors.ts:94). A guarded read that fails or yields
   *  a non-string sets lossy instead of omitting silently. */
  message?: string;
  // form "workflow-error" — every public WorkflowError field:
  code?: WorkflowErrorCode;
  recoverable?: boolean;
  agentLabel?: string;
  details?: unknown;      // strict-JSON projected
  resetHint?: string;
  authContext?: AuthErrorContext;
  checkpointContext?: CheckpointContext;
  /** form "error": JSON-safe own enumerable data properties of the Error (e.g.
   *  `route`, a JSON-safe `cause`) — scripts branch on these. Strict-JSON projected;
   *  restored onto the reconstructed error. */
  props?: Record<string, unknown>;
  /** form "value": the thrown value, strict-JSON projected. */
  value?: unknown;
  /** True when ANY consumed part failed strict-JSON projection or a property read
   *  threw. Lossy rows make a recording unusable as a baseline (§4.9). */
  lossy?: boolean;
}
```

**Strict-JSON qualifier (normative — shared by §3.0 snapshots, §2.7 fingerprints, §3.3a
args, and this projection). REALM-NEUTRAL (r6 B5):** ordinary object literals created
inside the workflow's `vm` realm carry that realm's `Object.prototype`, so a host
`=== Object.prototype` test would disqualify every script-authored `meta`, image list,
MCP config, and checkpoint default — while the fingerprint/checkpoint contracts require
accepting them. A value qualifies iff it is `null`, a boolean, a finite number, a
string, an **array**, or a **plain record**, recursively and acyclically:

- *array*: `Array.isArray(v)` (realm-neutral by spec) whose own enumerable
  string-keyed properties are exactly its dense indices `0..length-1` (holes and extra
  own properties disqualify — `JSON.stringify` would silently coerce them).
- *plain record*: `p = Object.getPrototypeOf(v)` is `null`; OR
  `Object.getPrototypeOf(p) === null` AND `p` owns a `constructor` data property whose
  value `C` is a function with `C.prototype === p` and whose
  `Function.prototype.toString.call(C)` source equals the HOST `Object` constructor's —
  the realm-neutral intrinsic identification: ANY realm's `Object.prototype` passes,
  a class prototype or exotic object does not.
- *properties*: every own property, read via `Object.getOwnPropertyDescriptor`, must be
  an enumerable string-keyed DATA property; accessor properties, symbol keys
  (`Object.getOwnPropertySymbols(v).length !== 0`), and non-enumerable own properties
  disqualify.

Qualifying values are deep-copied verbatim into host-realm plain objects. Anything
else — `Date`, `Map`/`Set`, functions, custom prototypes, non-finite numbers,
`undefined` members, accessors — disqualifies its containing field: in THIS projection
the field is omitted and `lossy: true` is set; in §3.0/§3.3a capture the value is
REJECTED (agent results/checkpoint replies) or MARKED (args, §3.3a); in §2.7 the
fingerprint is absent. NO coercion anywhere: a non-lossy projection round-trips to a
value the script cannot distinguish by any JSON-observable operation. Every strict-JSON
consumer's tests use ACTUAL vm-created fixtures, not host lookalikes (§7).

**Guarded reads (normative).** Every property read during projection (`name`,
`message`, own keys, `details`, …) is individually `try/catch`-guarded (the
`errorMessage` precedent, `packages/workflow-engine/src/errors.ts:82-126`); a throwing
getter substitutes omission + `lossy: true`. The projection as a whole is wrapped: if
it fails catastrophically it yields
`{ form: "error", name: "Error", message: "[unprojectable thrown value]", lossy: true }`
— projection failure NEVER replaces or masks the original call outcome.

**Projection by form.** `instanceof WorkflowError` → `form: "workflow-error"` with
every public field (`details`/`authContext`/`checkpointContext` strict-JSON projected).
Other `Error` → `form: "error"` with `name`, `message`, and `props` (each own
enumerable data property strict-JSON projected; any disqualified property → omitted +
`lossy`). Anything else → `form: "value"` with the strict-JSON projection.

**Reconstruction (normative, used by §4.6.3/§4.7 serving; only non-lossy rows are ever
reconstructed — §4.9 rejects lossy rows).**
- `"workflow-error"` → `new WorkflowError(message, code, { recoverable, agentLabel,
  details, resetHint, authContext, checkpointContext })`
  (`packages/shared-types/src/errors.ts:94` — message and code are both guaranteed
  present by preflight check 1). Safety: a reconstructed `recoverable: true` on an
  AGENT row cannot enter the retry ladder, because agent `"error"` rows with
  `recoverable: true` exist only on abort exits and §4.9 rejects aborted rows;
  checkpoint confirm throws propagate raw with no ladder.
- `"error"` → `new C(message)` where `C` is the matching global among
  `Error`/`TypeError`/`RangeError`/`SyntaxError`/`ReferenceError`/`EvalError`/
  `URIError`; other names → `new Error(message)` + `error.name = name`; then `props`
  assigned as own data properties (fresh clones).
- `"value"` → throw a fresh clone of `value`.

### 3.3 Engine event additions + sealed telemetry

`WorkflowRunOptions.onAgentStart`/`onAgentEnd`/`onAgentHistory` gain call identity,
scope, and — on the terminal event — the SEALED per-call telemetry (additive for
consumers under structural contravariance):

```ts
  onAgentStart:   { …existing…, callIndex: number, scope: string }
  onAgentEnd:     { …existing…, callIndex: number, scope: string,
                    usage?: AgentUsage,          // §3.5 per-call sealed sum
                    modelResolved?: string,      // terminal attempt's sealed value
                    modelFallbacks?: string[],   // sealed, attempt-ordered, dups kept
                    backendId?: string,          // terminal attempt's sealed value
                    provenance?: AgentResultProvenance, // sealed (below)
                    errorRecord?: WorkflowRecordedError } // r6 B8: on terminal
                    // failure, the SAME §3.2a projection the manifest row carries —
                    // every WorkflowError constructor input rides the event, so a
                    // consumer can reconstruct the exact typed error (§4.3).
  onAgentHistory: { …existing…, callIndex: number, scope: string }
```

**Why sealed telemetry rides the event (r5 B7 — the directive-2 hook).** The
engine's timeout races OUTSIDE the wrapper (`workflow.ts:621-675`, `:1405-1427`), so
a wrapper CANNOT know a callback it forwards belongs to a timed-out loser; only the
engine's attempt-sealed slots (§3.5) hold the truth, surfaced on the one
exactly-once settlement signal (§2.6) — the isolation report consumes ONLY that
(§4.6 rule T). The wrapper intercepts NO observation callbacks (§4.5).

**Result provenance — the served/live marker (r5 B14, per Q5).** A fifth `RunOptions`
addition, declared here beside the telemetry callbacks rather than in §2.1's identity
block (`packages/shared-types/src/agent-run.ts`, appended beside `onUsage`):

```ts
/** Out-of-band result provenance a wrapping/caching AgentRunner MAY report for the
 *  current attempt: whether the result it returns was produced live or replayed
 *  from a recording. Generic — any memoizing or record/replay wrapper can report it;
 *  the engine never fabricates a value; absence means an ordinary live call. */
export type AgentResultProvenance =
  | { source: "live"; overrideModel?: string }
  | { source: "replay"; recordedRunId?: string; recordedIndex?: number;
      hashMatched?: boolean };

// RunOptions:
  onResultProvenance?: (provenance: AgentResultProvenance) => void;
```

Attempt-sealed exactly like every other observation callback (§3.5; the last report
before the attempt settles wins; late reports are dropped). The terminal attempt's
sealed value rides the terminal `onAgentEnd` event (`provenance?`, above), the
manifest row (`WorkflowCallRecord.provenance`, §3.2), and the snapshot/persisted
agent row (§3.4). The replay wrapper reports `{ source: "replay", recordedRunId,
recordedIndex, hashMatched }` synchronously before resolving every serve, and
`{ source: "live", overrideModel? }` before every target delegation (§4.6.2) — so
served-vs-live is distinguishable in the manager's live event stream AND in the
persisted artifact's `calls[]`/`agents[]` rows, not only in the in-process report.
Old files and ordinary runners simply lack the field.

Emission sites: live start `:554` and replay start `:534`; the guarded terminal
transition (§2.6) for every end (`usage` = the §3.5 per-call sum; `result` = the §3.0
frozen snapshot; failed calls carry `usage` too — a failed call's spend is real);
replay end `:535-542` (`usage: cached.usage`, `tokens: 0` unchanged); the history
forward `:669-671` (attempt-sealed per §3.5).

The manager re-emits these on `agentStart`/`agentEnd`/`agentHistory` with
`runId: managed.runId` prepended as today; `scope` is the per-call field. **Row-matching
fix:** the `agentEnd` and `agentHistory` handlers locate the snapshot row by
`(a.scope === event.scope && a.callIndex === event.callIndex && a.status ===
"running")`, falling back to the label reverse-find only when the event carries no
`callIndex`. This kills the two known mis-attributions (duplicate labels in flight;
nested-child events patching parent rows).

### 3.3a Manager state fixes — args, cwd, runtime, limits, markers, post-terminal drop

`PersistedRunState` corrections/additions
(`packages/workflow-engine/src/run-persistence.ts:39-82`), all additive on read:

```ts
  /** NEW SEMANTICS (disclosed fix): for args SATISFYING the §3.2a qualifier
   *  (undefined stays undefined), the pre-execution snapshot — cloned at run
   *  creation on ALL THREE creation paths (r5 B10 / opus B1), BEFORE any script code
   *  runs; the VM receives a SEPARATE clone, so in-run mutation reaches neither the
   *  snapshot nor the caller's object. Args FAILING the qualifier (a Date, a custom
   *  instance — args is a public `unknown` API) are NOT rejected on any normal path
   *  (r6 B6): execution is unchanged (the VM gets the caller's object verbatim),
   *  this field keeps today's JSON-coerced save-time write, and `argsUnreplayable`
   *  (below) marks it as not a faithful replay input. Old files may carry
   *  post-mutation args; they are inadmissible baselines anyway (no
   *  calls[]/limits/runtime); new-format files always snapshot or mark. */
  args?: unknown;
  /** NEW — set at run creation when the caller's args failed the §3.2a qualifier
   *  (r6 B6). A baseline-admissibility marker ONLY (§4.9 check 5,
   *  "args-unreplayable"); execution and resume are unaffected. */
  argsUnreplayable?: true;
  /** NEW — the directory the run actually executed in: managed.cwd ?? manager cwd
   *  (workflow-manager.ts:544). Written on every save. `cwd` (the per-exec override)
   *  keeps its existing meaning. */
  effectiveCwd?: string;
  /** NEW — capture runtime, for the §2.5/§2.7 stability boundaries (r6 B14: FULL
   *  versions, exact-equality gated at §4.9 check 8): node = process.version and
   *  v8 = process.versions.v8 at run creation; pathFormat/inputsFormat = the engine's
   *  CALL_PATH_FORMAT / CALL_INPUTS_FORMAT constants. */
  runtime?: { node: string; v8: string; pathFormat: number; inputsFormat: number };
  /** NEW — environment identity for isolation comparability (r6 B14). At run
   *  creation: effective cwd inside a git repository → `git` = the repository HEAD
   *  commit + `dirtyDigest` = sha256 over the `git status --porcelain=v2 -z` output
   *  concatenated with the content hashes of every modified/untracked file it lists
   *  (empty status → digest of the empty string); otherwise `key` = the
   *  host-supplied ExecOptions.environmentKey when provided. Absent otherwise —
   *  never an admissible baseline (§4.9 check 9), records/loads/resumes unchanged. */
  environment?: { git?: { head: string; dirtyDigest: string }; key?: string };
  /** NEW — the engine's final allocation counter (§3.2), from
   *  WorkflowRunResult.callsAllocated on completion. */
  callsAllocated?: number;
  /** NEW — the run's resolved execution inputs (§3.2), from
   *  WorkflowRunResult.effectiveLimits on completion: every run-level setting that is
   *  control-flow-visible (gates, retries-to-null conversion, timeouts) or
   *  host-derived (concurrency). §4.3 defaults the replay to these. */
  limits?: { maxAgents: number; tokenBudget: number | null; concurrency: number;
             agentRetries: number; agentTimeoutMs: number | null };
  /** NEW — set when the run's abort signal was ever observed aborted (engine-returned
   *  abortSignaled, OR managed.controller.signal.aborted at terminal save). */
  abortSignaled?: true;
  /** NEW — the manager-level model-resolution inputs in effect for this run
   *  (WorkflowManagerOptions.mainModel / .agentsDir, threaded to the engine at
   *  workflow-manager.ts:547-548). Absent when unset. §4.3 defaults isolation runs
   *  back to these (r5 B13.1 — now declared here, not merely referenced). */
  mainModel?: string;
  /** Additive host pin for calls with no authored/definition/tier/phase/meta model. */
  defaultModel?: string;
  agentsDir?: string;
  /** NEW — set when workflow() was invoked during this run (§2.3). */
  nestedWorkflows?: true;
  /** NEW — set when this run was produced by resuming a persisted state that had no
   *  calls[] manifest: its replayed journal entries may include historically-collided
   *  child entries (§1 "Manager journaling"), so a fresh manifest row derived from
   *  them proves nothing. §4.9 rejects such recordings. */
  legacyResume?: true;
  /** NEW — run-level execution-mode marker (§4.2). Written in the INITIAL save. */
  executionMode?: { kind: "isolation"; baselineRunId: string };
  /** NEW — the frozen isolation report, written by runIsolation after the terminal
   *  save (§4.2). The durable per-call served/live provenance surface (r5 B14). */
  replayReport?: ReplayReport;
```

**The args choke points (normative, r5 B10 / opus B1 / r6 B6).** Helper
`snapshotArgs(v)`: `undefined` → `{ ok: true, clone: undefined }`; a §3.2a-qualifying
value → `{ ok: true, clone: <deep copy> }`; anything else → `{ ok: false }` — it
NEVER throws. (1) EVERY run-creation site calls it: on `ok`,
`managed.args = clone`; on `!ok`, `managed.args = callerArgs` (the reference,
today's behavior) AND `managed.argsUnreplayable = true`. Sites: `createManaged`
(`workflow-manager.ts:418`), `startInBackground`'s inline construction (`:299`) —
whose initial save (`:317`) also persists the snapshot/marker — and
`resumeInBackground`'s (`:943`; persisted args are post-`JSON.parse`, hence always
`ok`; a persisted marker carries through). (2) `executeRun` passes
`cloneJsonValue(managed.args)` on the `ok` path — never a raw parameter — so the
VM's copy is independent of the snapshot; on `!ok` it passes `managed.args` verbatim
(the unchanged public-`unknown` contract). `persistRun` (`:725`) keeps writing
`managed.args`. `runIsolation` clones per invocation (§4.3; recorded args are always
`ok`). **Failure timing (r6 B6, normative):** NO manager API throws or rejects over
args shape — the only args failure surface is the asynchronous §4.9 baseline
rejection. (Where manager APIs DO fail for other guards: `startInBackground` may
throw synchronously; async `runSync`/`resumeInBackground` reject their returned
Promise — never a "synchronous TypeError".)

**Post-terminal event drop (normative, r5 B8).** Once `managed.status` leaves
`"running"`, the manager DROPS (does not persist, does not emit, logs at debug) any
late `onAgentJournal` entry, call record, or `agentStart`/`agentEnd`/`agentHistory`
event still arriving from a floated engine-side call — a terminal artifact is never
mutated after its terminal save. Disclosed behavior fix (previously a late journal
write re-persisted a completed run's file).

Other manager changes: `persistRun` writes `effectiveCwd`, `runtime`, `environment`,
`mainModel`, `defaultModel`, `agentsDir`, and the markers on every save, and `callsAllocated`/
`limits`/`abortSignaled` on completion; `resumeInBackground` sets `legacyResume` when
the loaded state lacks `calls[]`, and — new gate — returns `{ accepted: false }` for
any persisted state with `executionMode` present (§4.2). `ExecOptions` gains three
additive fields: `runId?: string` (caller-minted id; the §4.8 lease-first collision
guard), `executionMode?: PersistedRunState["executionMode"]`, and
`environmentKey?: string` (the non-git environment identity input, r6 B14; also on
`WorkflowManagerOptions` as a run-default), plus `defaultModel?: string` as a per-run,
persisted model-resolution pin.

### 3.4 Snapshot + `PersistedAgentState` typing (the honesty fix)

`WorkflowAgentSnapshot` (`packages/workflow-engine/src/display.ts:14-31`) gains
`callIndex?: number`, `scope?: string`, `usage?: AgentUsage`,
`provenance?: AgentResultProvenance` — stamped by the `agentStart`/`agentEnd`
handlers. `PersistedAgentState`
(`run-persistence.ts:19-37`) declares exactly what the spread writes:

```ts
export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  /** Legacy: declared historically, not written by the current manager. */
  result?: unknown;
  /** NEW (declaring existing behavior) — preview(result), what is actually written. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  session?: AgentSessionRecord;
  startedAt?: string;
  endedAt?: string;
  model?: string;
  /** NEW (declaring existing behavior) — this-run tokens (real total or chars/4
   *  estimate; 0 for journal-replayed calls). */
  tokens?: number;
  /** NEW — join keys and the real usage split (absent on old files). */
  callIndex?: number;
  scope?: string;
  usage?: AgentUsage;
  /** NEW — the sealed runner-reported result provenance (§3.3), when reported. */
  provenance?: AgentResultProvenance;
}
```

### 3.5 Usage semantics — attempt slots, the settlement seal, cardinality, lower bound

Normative rules replacing the single reset-per-attempt closures
(`workflow.ts:583-586,613-614,656-671`):

- **Attempt-scoped slots.** One slot set per attempt for every per-attempt callback:
  `onUsage`, `onSessionOpen` (backendId), `onModelResolved`, `onModelFallback`
  (an append-list of specs), `onResultProvenance` (§3.3), `onBudgetReplay` (§4.6.8),
  and the `onHistory` forward. Each wrapper closes over its attempt token and writes
  only its own slot. **Snapshot-at-receipt (r6 advisory 2):** every report is COPIED
  into its slot at callback time — later mutation of the runner-owned object never
  changes a received value — and validated there: an `AgentUsage` report carrying any
  non-finite or negative numeric field is dropped (logged at debug), never stored;
  "last cumulative snapshot received" therefore means the last VALID copy.
- **`onUsage` cardinality (new normative doc on `RunOptions.onUsage`,
  `shared-types/src/agent-run.ts:96-97`).** A runner MAY invoke `onUsage` multiple
  times within one attempt; each report is a CUMULATIVE snapshot for that attempt; the
  last report received before the attempt settles wins. (Today's ACP runner reports
  once, in `finally` — already conformant.)
- **The settlement seal.** An attempt settles when the engine's await of the seam
  returns or throws (`withTimeout` resolution `:621` or the catch at `:699`). At
  settlement the attempt's slots seal; a callback arriving afterwards (a timed-out
  loser's eventual report) is DROPPED — it never mutates a slot, an artifact, an
  event, or the run aggregate.
- **Per-attempt abort (r6 B13).** Every attempt gets a FRESH `AbortController`; the
  runner's `RunOptions.signal` is `AbortSignal.any([runSignal, attempt.signal])`.
  When `withTimeout`'s timer wins, the engine ABORTS the attempt controller — the
  loser is actively cancelled through the seam (the ACP runner maps signal abort to
  `session/cancel`, `acp-agents/src/acp-client.ts:1876-1883,2086-2089`), not merely
  floated. Settlement is unchanged: the attempt is already classified as the timeout
  outcome, its slots sealed, the loser's eventual rejection/reports dropped by the
  seal. Residual: a signal-ignoring third-party runner (§4.12 item 4). Disclosed
  (§8 item 10).
- **`budgetDebit` capture (r6 B4).** The manifest row's `budgetDebit` is the EXACT
  amount the call's attempts added to `shared.spent` via `recordTokens`
  (`:597-609,:685,:704`) — provider tokens where reported, the chars/4 estimate
  where not; 0 on journal-replayed rows. The §4.6.8 replay fact, deliberately
  distinct from `usage` (`AgentUsage.total` cannot reconstruct an estimate charge).
- **Per-call usage** = the field-wise sum of each attempt's sealed winning `onUsage`
  report (attempts with no report contribute nothing; no reports at all →
  `undefined`). **Per-call model/backend/provenance telemetry** = the terminal
  attempt's sealed `onModelResolved`/`onSessionOpen.backendId`/`onResultProvenance`,
  and the attempt-ordered concatenation of all sealed `onModelFallback` specs. These
  sealed values are what the terminal `onAgentEnd` event (§3.3) and the manifest row
  (§3.2) carry — the ONLY channel the isolation report reads (r5 B7).
- **Lower bound, stated everywhere.** Because timed-out losers' late spend is dropped
  and providers may under-report, every persisted/reported usage value is normatively an
  *observed lower bound* on true spend, and no field of this contract is described as
  "authoritative" cost. `total === 0` with non-zero split fields is measured data and
  is preserved (the chars/4 estimate exists only for the collapsed `tokens` number and
  the run aggregate — unchanged).
- `attempts` (runner invocations) is recorded on the call record. `recordTokens` and
  the run aggregate are untouched.

### 3.6 Resume semantics

- Journal entries — `kind`/`usage`/`scope` included — carry verbatim through resume
  seeding (`workflow-manager.ts:948`); replayed calls re-surface `cached.usage` on
  events and rows.
- The manager seeds a resumed run's manifest from the prior `calls[]`
  (latest-per-index, root-scope), like the journal; replayed calls emit fresh
  records (origin `"journal-replay"`, carried usage), live calls replace their
  indexes. A completed resumed run's `calls[]`, `callsAllocated`, `limits`, and
  `abortSignaled` are the completing execution's values.
- Resuming a state that lacks `calls[]` sets `legacyResume: true` (§3.3a): its replayed
  journal values have unprovable scope provenance (§1 child-collision), so the fresh
  manifest must not launder them into an admissible baseline (§4.9 rejects).
- Stale journal suffixes (entries whose index has no manifest row, or disagrees with it
  in hash/kind, or sits at a failure-row index) remain possible in resumed files;
  §4.9's cross-check excludes them.

### 3.7 Old-file tolerance

All new fields are optional on read; absence means "not recorded". Old files load
exactly as before; new files remain loadable by old readers (extra JSON keys are
inert). Specific consequences: `calls`/`callsAllocated`/`effectiveCwd`/`runtime`/
`limits` absent → the file is not an admissible isolation baseline (§4.9) but
resumes/lists/loads unchanged; `executionMode` absent → a normal run. One disclosed
asymmetry: an OLD engine ignores every new marker — it would resume an isolation
artifact or a nested-workflow recording live. Old engines also never produce such
artifacts; the quarantine is enforced by every engine that ships this contract, which
is the ordinary limit of additive evolution.
---

## 4. Isolation runner

### 4.1 Placement (decision, per Q3)

Everything lands in `@automatalabs/workflow-engine` — one new module,
`packages/workflow-engine/src/isolation.ts` — with the SDK re-exporting the surface and
adding one ACP-defaulted wrapper (§4.10). The engine already owns `PersistedRunState`,
`createRunPersistence`, `WorkflowManager`, `generateRunId`, and the error taxonomy, and
is backend-agnostic by construction. A new `@automatalabs/agentprism-evals` package now
is rejected: it would carry the new-package release flow for two functions, and its real
content (scoring/harness) is out of scope; when it arrives it consumes these exports.

### 4.2 Quarantine — the `executionMode` marker + the persisted report

An isolation run is a real managed run (per Q5): it persists, journals, and emits
events. Its artifact must never be resumed live or used as a baseline. Per-call
marking cannot achieve that — a first-call fatal or crash leaves a failed artifact
with no per-call rows, and `resumeInBackground` accepts failed runs
(`workflow-manager.ts:831-844`). The quarantine is a **run-level marker written in
the INITIAL save**, before any script code runs:
`PersistedRunState.executionMode = { kind: "isolation", baselineRunId }` (§3.3a),
threaded via `ExecOptions.executionMode` by `runIsolation`. Readers honor it:

- `resumeInBackground` returns `{ accepted: false }` for any persisted state carrying
  `executionMode` (additive gate beside the existing completed/aborted gates).
- Isolation preflight rejects such files as baselines (`RECORDING_UNUSABLE`, reason
  `"isolation-artifact"`).

**Durable per-call provenance (r5 B14 — decision, per Q5).** Served-vs-live is
recoverable from THREE surfaces. (1) **Events and per-call persistence:** the
wrapper reports `onResultProvenance` on every serve and target delegation; the
engine seals it onto the terminal `agentEnd` event, the manifest row, and the
`agents[]` row (§3.3/§3.2/§3.4) — an own-manager host sees served-vs-live in its OWN
event stream, and any later reader sees it per call. (2) **The persisted report:**
when `journaling` is on, `runIsolation` — after the terminal save — loads the
artifact through its private persistence handle, attaches the frozen report as
`PersistedRunState.replayReport` (§3.3a), and saves once (no writer races this);
`replayReport.calls` joins to `agents[]`/`calls[]` by `callIndex` and adds what
per-call markers cannot carry (divergence, unvisited rows, target aggregation).
(3) **In-process:** `report()` / `observeAgentEnd` returns. A composition-path host
MUST pass the same `executionMode` marker through `ExecOptions.executionMode`
(documented, §4.8; the wrapper cannot be constructed without naming the baseline);
§4.9's `"replayed-row"` check makes a forgotten marker fail closed at the next
attempted use as a baseline.

### 4.3 Engine API surface

New module `packages/workflow-engine/src/isolation.ts`, exported from the engine index
under a `── Isolation mode ──` block: `runIsolation`, `createReplayRunner`, and the
types below.

```ts
/** Execute one isolation run end-to-end: load + preflight the recording, resolve
 *  targets, wrap `runner`, re-execute the RECORDED script with a fresh clone of the
 *  RECORDED args as a real managed run, observe target settlement, and return the
 *  report. ONE phase boundary (r6 B8): BEFORE script execution begins, every failure
 *  (load, preflight, target resolution, environment mismatch, lease, runId collision,
 *  manager start) REJECTS the returned promise with a typed WorkflowError — no live
 *  call has run and no status is fabricated. AFTER script execution begins, the
 *  promise never rejects: every outcome resolves to an IsolationRunResult status.
 *  Never throws synchronously. */
export async function runIsolation<T = unknown>(
  options: RunIsolationOptions,
): Promise<IsolationRunResult<T>>;

export interface RunIsolationOptions {
  /** The baseline run id, loaded via createRunPersistence(cwd, undefined,
   *  { persistenceRoot }). No already-loaded-object overload — every consumed byte
   *  comes out of JSON.parse, so the §4.9 structural invariants suffice. In-memory
   *  recordings compose via createReplayRunner, which normalizes them (below). */
  baselineRunId: string;
  /** The live backend for target calls. Any AgentRunner. REQUIRED at the engine layer
   *  (the SDK defaults it, §4.10). */
  runner: AgentRunner;
  /** Target selection (§4.4). At least one entry. */
  live: IsolationTarget[];
  /** Whether the isolation run persists its (quarantined) artifact + replayReport.
   *  Default true. false still touches the runs dir transiently (the run lease). */
  journaling?: boolean;
  /** Persistence lookup key / default project dir. Default process.cwd(). The
   *  re-execution runs in recording.effectiveCwd ?? recording.cwd ?? executionCwd;
   *  when the recording carries neither and executionCwd is unset, preflight rejects
   *  (never a silent process.cwd() fallback for the EXECUTION directory). */
  cwd?: string;
  /** Explicit execution directory for legacy recordings without effectiveCwd. */
  executionCwd?: string;
  persistenceRoot?: string;
  /** APPROVED script-declared backends (ExecOptions.scriptBackends semantics). */
  scriptBackends?: Record<string, WorkflowBackendConfig>;
  // Execution-setting overrides (ExecOptions semantics). DEFAULTS (normative):
  // the RECORDING's persisted limits — concurrency ?? limits.concurrency,
  // agentTimeoutMs ?? limits.agentTimeoutMs, agentRetries ?? limits.agentRetries —
  // so the replay runs under the baseline's effective settings unless the caller
  // deliberately deviates (recorded concurrency reproduces the scheduling ENVELOPE,
  // not latencies — §4.12 item 1). In practice they govern only live-target behavior:
  // served calls resolve at the seam and never hit timeout/retry machinery.
  // NOTE (r6 B4): tokenBudget and maxAgents are NOT accepted — §4.3 FORCES both to
  // the recording's persisted limits, so together with trajectory replay (§4.6.8)
  // the pre-allocation budget gates fire in the replay exactly where they fired
  // when recording; agent-limit gate-freedom is separately proven (§4.9 check 6).
  concurrency?: number;
  agentTimeoutMs?: number | null;
  agentRetries?: number;
  signal?: AbortSignal;
  /** Model-resolution reproduction inputs. Defaults (normative):
   *  agentsDir ?? recording.agentsDir; mainModel ?? recording.mainModel;
   *  defaultModel ?? recording.defaultModel (§3.3a). */
  agentsDir?: string;
  mainModel?: string;
  defaultModel?: string;
  /** The non-git environment identity input (r6 B14): required by preflight when the
   *  BASELINE carries environment.key (equality-checked); ignored when the baseline
   *  carries environment.git (the executing repo state is measured directly). */
  environmentKey?: string;
  /** The ONLY observability passthrough (ExecOptions.onProgress, verbatim). Full event
   *  access is the createReplayRunner + own-manager composition; runIsolation's
   *  analysis surface is the report. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
}

export interface IsolationRunResult<T = unknown> {
  /** "completed"     — script completed; no fatal latch; every target settled
   *                    successfully; no unvisited rows or unreached targets; every
   *                    settled target carries positive candidate evidence or an
   *                    explicit unverified mark (§4.6.2 rule T; r6 B3) — never an
   *                    unmarked silent-runner pass.
   *  "target-failed" — a live target's logical call terminally failed (exhausted to
   *                    null, or threw): a first-class substitution outcome. The run
   *                    is aborted at that observation (§4.6 rule T); report.targets
   *                    carries the failure.
   *  "diverged"      — the fatal latch was set (any §4.6.5 divergence, incl. a
   *                    candidate fallback), the completed run carried
   *                    nestedWorkflows (§4.3 step 6, r6 B2), or finalize found
   *                    unvisited rows / an unreached target. Not comparable.
   *  "failed"        — post-start infrastructure/run failure unrelated to divergence
   *                    (manager fault; abort by the CALLER's signal — precedence over
   *                    finalize findings even when the script catches the abort and
   *                    completes, r6 B8), or a bound target still unsettled at script
   *                    completion (the §3.2 exception window; error carries
   *                    REPLAY_DIVERGENCE with the `target-unsettled` event; internal
   *                    abort fired, §4.6.6). Lease and other pre-start failures
   *                    REJECT the promise instead (the phase boundary) — never a
   *                    status. */
  status: "completed" | "target-failed" | "diverged" | "failed";
  /** The managed run's result whenever runSync produced one (diagnostic under any
   *  non-completed status). */
  run?: WorkflowRunResult<T>;
  /** The classified error: the latched fatal divergence, the target's terminal error
   *  (target-failed — the §3.2a RECONSTRUCTION of the settlement event's
   *  `errorRecord`, so every WorkflowError constructor field is reproduced exactly;
   *  r6 B8), or the run's terminal WorkflowError (failed). */
  error?: WorkflowError;
  report: ReplayReport;
}
```

```ts
/** Wrap ANY AgentRunner in a record/replay layer over one admissible recording.
 *  Composable primitive; runIsolation is the packaged composition. SINGLE-RUN and
 *  NON-REENTRANT: one instance serves exactly the engine run named by rootRunId. A
 *  run()/confirm arrival for any other scope is the SINGLE typed
 *  `nested-workflow-call` fatal divergence (§4.6.2 rule 2 — r6 B9; never a misuse
 *  Error); only reuse AFTER finalize is a misuse Error. Construction normalizes
 *  `recording` by JSON round-trip
 *  (JSON.parse(JSON.stringify(recording))) and then runs the FULL §4.9 preflight AND
 *  §4.4 target resolution on the normalized copy — an in-memory object gets exactly
 *  the wire-format validation a loaded file gets (prototypes are never consulted;
 *  the JSON projection IS the recording — r5 B13.3), and later caller mutation of the
 *  original cannot reach the wrapper. Throws RECORDING_UNUSABLE /
 *  REPLAY_TARGET_INVALID synchronously. */
export function createReplayRunner(options: ReplayRunnerOptions): ReplayRunner;

export interface ReplayRunnerOptions {
  recording: PersistedRunState;
  inner: AgentRunner;
  /** Target selectors — resolved internally via the §4.4 algorithm (callers no longer
   *  hand-build resolved targets; r5 advisory 3). */
  live: IsolationTarget[];
  /** The isolation run's engine runId (§4.6 rule 2). */
  rootRunId: string;
  /** §4.9 check 9 environment-gate inputs (r6 B14), mirroring RunIsolationOptions:
   *  the current identity is measured against executionCwd ??
   *  recording.effectiveCwd ?? recording.cwd, or compared to environmentKey. */
  executionCwd?: string;
  environmentKey?: string;
}

/** The resolved form — the report's `targets` entries. */
export interface ResolvedIsolationTarget {
  /** The target row's index IN THE RECORDING (selection key, not a runtime key). */
  recordedIndex: number;
  /** The row's identity + input fingerprint, verified at construction. */
  hash: string;
  path: string;
  inputsHash: string;
  /** Candidate spec rewritten onto RunOptions.model before delegating (§4.5). */
  model?: string;
}

/** What observeAgentEnd tells the harness about the event it just consumed (the
 *  concrete settlement signal — r5 B6 / opus A1; no implied promises).
 *  outcome "diverged" (r6 B3): the target settled but its sealed telemetry reported
 *  a candidate fallback — the latch is already set; stop the run. */
export type ReplayObservation =
  | { target: false }
  | { target: true; recordedIndex: number;
      outcome: "settled" | "failed" | "diverged"; remainingTargets: number };

export interface ReplayRunner extends AgentRunner {
  /** Checkpoint-serving confirm (§4.7). Pre-bound arrow property (the engine invokes
   *  it bare, workflow.ts:1019). Pass as the run's confirm. */
  confirm: (promptText: string, options: CheckpointOptions,
            context?: CheckpointCallContext) => Promise<unknown>;
  /** Freeze and return the report. Idempotent. scriptCompleted gates end-of-run
   *  checks (§4.6.6). A live delegation still pending at the freeze is reported as
   *  unsettled, never dropped silently. */
  finalize(outcome?: { scriptCompleted?: boolean }): ReplayReport;
  /** A fresh deep copy before finalize; the frozen report after. */
  report(): ReplayReport;
  /** Feed one root-scope manager `agentEnd` event (the §2.6 exactly-once settlement
   *  signal, carrying the §3.3 sealed telemetry). Returns synchronously what the
   *  event meant: the harness stops the run on outcome "failed" or "diverged" and
   *  knows all targets settled when remainingTargets reaches 0. `errorRecord` (r6
   *  B8) is the §3.2a projection riding the terminal event — the input from which
   *  the exact typed IsolationRunResult.error is reconstructed. */
  observeAgentEnd(event: { callIndex: number; scope: string; result: unknown;
    error?: string; errorCode?: WorkflowErrorCode;
    errorRecord?: WorkflowRecordedError; usage?: AgentUsage;
    modelResolved?: string; modelFallbacks?: string[]; backendId?: string;
  }): ReplayObservation;
}
```

`runIsolation` mechanics (normative):

1. Load via `createRunPersistence(cwd ?? process.cwd(), undefined,
   { persistenceRoot }).load(baselineRunId)`; `null` → reject `RECORDING_UNUSABLE`
   (`"not-found"`). Preflight (§4.9). Resolve targets (§4.4). Clone
   `args = cloneJsonValue(recording.args)` per invocation (undefined passes through —
   r5 B10) — two sequential `runIsolation` calls can never share mutable args.
2. Mint `rootRunId = generateRunId()`; construct the wrapper (which re-runs preflight +
   target resolution on its normalized copy — deliberate redundancy).
3. Create an INTERNAL `AbortController`; the run signal is
   `options.signal ? AbortSignal.any([options.signal, internal.signal]) :
   internal.signal` — the containment lever for floated targets and target failure
   (r5 B8). Run on a PRIVATE `WorkflowManager({ cwd, persistenceRoot, journaling,
   agentsDir: agentsDir ?? recording.agentsDir, mainModel: mainModel ??
   recording.mainModel })`:
   `manager.runSync(recording.script, clonedArgs, { agent: wrapper, confirm:
   wrapper.confirm, runId: rootRunId, executionMode: { kind: "isolation",
   baselineRunId }, cwd: recording.effectiveCwd ?? recording.cwd ?? executionCwd,
   journaling, scriptBackends, onProgress, signal: <combined>,
   concurrency: concurrency ?? recording.limits.concurrency,
   agentTimeoutMs: agentTimeoutMs !== undefined ? agentTimeoutMs :
   recording.limits.agentTimeoutMs, agentRetries: agentRetries ??
   recording.limits.agentRetries, tokenBudget: recording.limits.tokenBudget,
   maxAgents: recording.limits.maxAgents,
   budgetReplay: <the §4.6.8 trajectory built from the recording's calls[]>,
   onNestedWorkflow: <latch fatal REPLAY_DIVERGENCE "nested-workflow-call" + fire the
   internal abort — spend stops the moment an unsupported child is INVOKED, even a
   zero-call one (r6 B2)> })`. The REPRODUCED `tokenBudget`/`maxAgents` (r6 B4 —
   never caller-overridable) plus trajectory replay make the pre-allocation budget
   gates fire exactly where the baseline's did, and §4.9 check 6 proves the
   agent-limit gate never fired (runaway spend is impossible — the wrapper's latch
   stops every post-divergence call, and structural drift diverges within one
   arrival). The script and args ALWAYS come from the recording — callers cannot
   substitute either. Before start, `runIsolation` attaches an `agentEnd` listener on
   the private manager that forwards root-scope events to `wrapper.observeAgentEnd`;
   the listener is removed when the run settles.
4. **Error rule (normative — the phase boundary, r6 B8).** BEFORE the script starts
   executing, every throw that reaches `runIsolation` — lease acquisition
   (`workflow-manager.ts:363-364`), the runId collision guard (§4.8), filesystem
   faults — is rethrown as-is when it is already a `WorkflowError`, else wrapped
   `new WorkflowError(message, WorkflowErrorCode.PERSISTENCE_ERROR,
   { recoverable: false })`, and REJECTS the promise. AFTER the script starts,
   nothing rejects: every outcome is a returned status. No bare Error can leak from
   `runIsolation`, on any path, race or no race.
5. On an `observeAgentEnd` return of `{ target: true, outcome: "failed" }` or
   `outcome: "diverged"` (candidate fallback, r6 B3), abort the internal controller
   AND `manager.stop(rootRunId)`, await settlement, classify `"target-failed"` /
   `"diverged"` respectively.
6. Await the terminal result; `wrapper.finalize({ scriptCompleted: result.status ===
   "completed" })`; classify per `IsolationRunResult.status`, precedence exactly
   (r6 B8): fatal latch > target-failed > CALLER abort observed (`"failed"` — even
   when the script caught the abort and completed) > run-not-completed >
   `result.nestedWorkflows === true` (the r6 B2 finalize backstop: a zero-call child
   emitted no wrapper arrival; latch the typed `nested-workflow-call` divergence
   now → `"diverged"`) > finalize findings > completed. A bound target unsettled at
   script completion (floated target — `Promise.race` shapes, §4.6.6): fire the
   INTERNAL abort (best-effort via `RunOptions.signal`; a signal-ignoring runner is
   the §4.12 limitation), classify `"failed"` with the typed `target-unsettled`
   error. Late events from still-running engine calls are dropped by the manager's
   post-terminal guard (§3.3a).
7. When `journaling` is on, attach the frozen report to the persisted artifact
   (`replayReport`, §4.2) after the terminal save. **Report-persistence failure
   (normative, r6 B8):** a missing artifact at this load or a throwing final `save`
   NEVER rejects and NEVER changes the classified status — logged, `report.notes`
   gains `"report-persistence-failed: <reason>"`, the in-process report stays
   authoritative, and the durable artifact simply lacks `replayReport`.

### 4.4 Target selection + baseline-model evidence (decision)

```ts
/** Exactly one selector, enforced by type (r5 advisory 1). */
export type IsolationTarget =
  ({ callIndex: number; label?: never } | { label: string; callIndex?: never }) & {
    /** Candidate model spec (RunOptions.model semantics; inner runner interprets —
     *  swapping model AND backend is the flagship case). */
    model?: string;
  };
```

Resolution (preflight; violations reject `REPLAY_TARGET_INVALID` with
`details: { target, reason, candidates? }`; reasons are kebab-case literals):

- `live` non-empty; resolved indexes pairwise distinct.
- A `callIndex` target must name a recorded-call-table row with `kind: "agent"` and
  origin `"runner"` (r6 B1 narrows out `"journal-replay"`: that row's execution
  context and served model were observed by an EARLIER execution — reason
  `"journal-replay-target"`; target the run that actually ran it). Targeting
  recorded failures (`"null"`/`"error"`) is legitimate — "does the candidate succeed
  where the baseline failed?" is first-class. Invalid: checkpoint rows, indexes
  outside the table. (Origin-`"engine"` rows cannot occur — §4.9 rejects them.)
- **Worktree/cwd pinnability (r6 B1).** A target row with `isolation: "worktree"`/
  `worktree: true` → `"worktree-target"` (a worktree path is minted fresh per run,
  §2.7 — never pinnable). Every other target row carries `resolvedCwd` (§4.9
  check 1), the engine-observed context §4.6.2 rule 3 compares at delegation.
- A `label` target resolves through root-scope `agents[]` rows carrying `callIndex`
  (§3.4): exactly one match with status `"done"`/`"error"` → that row's index,
  validated as above. Zero or multiple matches → invalid (candidates listed; the fix
  is `callIndex`). Recordings whose rows lack `callIndex` → label targeting invalid
  (`"re-record-or-target-by-callindex"`).
- The target row must carry `inputsHash` → else reason `"no-input-fingerprint"`
  (§2.7; without it the live-context guard cannot run).
- **Identity uniqueness is a recording-level admissibility check, not a target
  check**: §4.9 rejects any recording in which two rows share `(kind, path, hash)`, so
  in an admissible recording every target's identity is unique by construction and no
  duplicate-identity pairing question can arise at runtime.
- **Baseline-model evidence (r5 B15 — the POSITIVE-evidence rule).** The journal hash
  proves only the REQUESTED spec; `AgentRunner` is structural
  (`shared-types/src/agent-runner.ts:16-64`) and may ignore `options.model` and every
  observation callback, so *absence* of a fallback signal proves nothing. A target
  with NO `model` override is therefore admissible ONLY when its baseline row carries
  positive evidence of what was served: `modelRequested` present AND `modelResolved`
  present (the sealed runner report, §3.2/§3.5) AND `modelFallback` not `true`.
  Otherwise → reason `"unproven-baseline-model"`, with the documented remedy: pass an
  explicit `target.model` (which makes the comparison intent explicit and needs no
  baseline proof). Runner honesty in its sealed reports is a stated precondition
  (§4.12) — the contract cannot verify a black box's self-reporting, only require it.
- Predicates/regex/occurrence selectors: rejected (not validatable at preflight).

### 4.5 Model override — runner-side rewrite; nothing else at the seam

The target's model override is the wrapper's ONLY delegation rewrite: for a target
call it delegates `inner.run(prompt, { ...options, model: target.model ??
options.model })`, forwarding every other field — INCLUDING every observation
callback — untouched. (It additionally CALLS `options.onResultProvenance` and
`options.onBudgetReplay` per §4.6.2/§4.6.8 — reporting through the engine's
channels, not interception.) The wrapper intercepts no telemetry: round 5 (B7)
proved wrapper-side interception cannot distinguish a timed-out loser's late
reports from sealed ones, so ALL live-target telemetry in the report comes from the
engine's sealed terminal event via `observeAgentEnd` (§3.3, §4.6 rule T). An
engine-level override map stays rejected (a second permanently-public
model-resolution input entangling `hashAgentCall` with eval machinery; the
wrapper-side rewrite happens after hashing, so the engine's identity math never
sees the override — load-bearing for target identity matching, §4.6).

**What identity proves (normative).** The journal/manifest hash embeds the REQUESTED,
script-resolved model spec (`workflow.ts:504`), never the served model: on fallback the
requested spec stays in the hash, and a spec-less call's backend can vary with runner
environment (`acp-agents/src/runner.ts:1457-1467`). Baseline-model verification comes
ONLY from the recorded per-call evidence fields — `modelRequested`, `modelResolved`,
`backendId`, `modelFallback` (§3.2) — never from hash equality; §4.4 enforces this.

### 4.6 Serving and divergence semantics — the crux (strict fail-fast)

**The problem.** Downstream calls' prompts interpolate the LIVE target output, so
post-target hashes legitimately mismatch — recorded results must be served anyway. But
index positions are completion-ordered and not comparable across executions (§1), the
hash omits behavior-changing inputs (§0), and control-flow changes can put different
calls at recorded positions. Only what is provable from engine-computable facts is
kept; everything else is a typed refusal.

#### 4.6.1 The correspondence rule and its honest boundary (r5 B12 — no "lemma")

Revision 5 called this a proved determinism lemma; the vm's documented host-`Function`
escape (`workflow.ts:297-308`) makes any such proof false, so revision 6 states what is
actually enforced and by which guard:

> **Target safety needs no determinism assumption.** A live call binds to a target row
> only when its `(kind, path, hash)` identity equals the row's — unique in an
> admissible recording — AND its input fingerprint equals the row's `inputsHash`
> (§4.6.2 rule 3). Hash equality pins the prompt and requested spec; fingerprint
> equality pins every script-controllable unhashed runner input (§2.7). Whatever
> nondeterminism produced the live call's context — settlement-order races, host
> escape, config drift — a target either executes with runner-visible inputs
> byte-equal to the baseline's, or the run dies typed (`target-inputs-drift`,
> `dependent-or-drifted-target`). No silent wrong-context candidate execution exists.
>
> **Serving safety.** A served value is a recorded constant returned without
> execution; serving is sound wherever the recording proves WHICH row holds the place:
> an exact identity match (unique by §4.9), or a single-occurrence path (rule 6 —
> only one lexical site can be arriving, so its recorded outcome IS "hold this step
> fixed" whatever its live content would have been). No other correspondence is
> provable at the seam; everything else is refused.
>
> **The disclosed residue (§4.12).** For a well-behaved script — byte-identical,
> prelude-constrained, no host escape — every script value derives from (recorded
> args, served recorded constants, replayed budget values, live target outputs), so
> a `"completed"` verdict means the baseline structure was reproduced around the
> live target. A script that DOES escape the vm or branch on settlement order
> cannot corrupt a target execution or a serve (guards above); it can only (a) push
> the run into a typed refusal, or (b) alter surfaces the verdict never compares
> (its own return value, log lines). The trusted-script assumption is an
> admissibility PRECONDITION, not a claim the engine proves.

Model-resolution reproduction precondition (unchanged need): the hash embeds the
resolved spec, whose inputs are the tier config file, `mainModel`, `defaultModel`, and the
`agentsDir` registry (`workflow.ts:343-358,484-499`). `mainModel`/`defaultModel`/`agentsDir` are persisted and
defaulted back (§3.3a/§4.3); tier-config and agents-directory CONTENTS — and the
`scriptBackends` approval set — are documented caller preconditions; drift is
fail-visible (a mismatch lands in rule 6's typed refusals or the target-identity
refusal), never silent.

#### 4.6.2 The serving algorithm (agent calls; checkpoints §4.7)

State: the recorded call table with per-row served flags (target rows are RESERVED —
never served); resolved targets; per-call bindings keyed by `(scope, callIndex)`; the
fatal latch. For each `run(prompt, options)` arrival the wrapper first validates
identity: `callIndex` a non-negative integer, `callHash` a non-empty string, `runId` a
string — else `TypeError` (API misuse); and `callPath` PRESENT — a missing live path
makes every correspondence unprovable, so it is an immediate fatal divergence
(`path-unavailable`), not a degraded mode. Then, with `i/h/p/f` the live index, hash,
path, fingerprint (`callInputsHash`, possibly undefined):

0. **Fatal latch first.** Latched → rethrow the latched error. No serving, no live
   spend, no binding reuse — a script that catches the first fatal error and keeps
   calling spends nothing further.
1. **Binding reuse.** An existing binding for `(scope, i)` means an engine retry of the
   same logical call: a serve-binding re-serves idempotently (fresh clone / same
   reconstructed throw); a target binding delegates live again (model rewrite
   reapplied; `attempts` incremented). New decisions are recorded as the binding
   synchronously, before any await.
2. **Foreign scope.** `options.runId !== rootRunId` → fatal divergence
   `nested-workflow-call` (a `workflow()` child reached the wrapper; children have no
   baseline — §4.9 excludes nested recordings, and this backstop catches a child whose
   branch was not taken when recording).
3. **Target match.** An unbound target `t` with `h === t.hash && p === t.path`: first
   verify the live context — `f` present AND `f === t.inputsHash` AND `options.cwd`
   equal to the target row's `resolvedCwd` (the engine-observed baseline execution
   directory, §2.7 — r6 B1) → binding `live-target`, report
   `options.onResultProvenance({ source: "live", overrideModel })` (§3.3), then
   delegate to `inner` with the §4.5 rewrite; ANY of those absent or unequal →
   fatal divergence `target-inputs-drift` (detail names the target and the failing
   component — fingerprint vs cwd — the r5/r6 B1 counterexamples die here, BEFORE any
   live spend). Unique by §4.9 identity-uniqueness. (A target whose recorded row is a
   failure runs live identically — "does the candidate succeed where the baseline
   failed?")
4. **Exact serve.** The recording's unique row with identity `(agent, p, h)`, if it
   exists and is not reserved: unserved → serve it (rule 6a); already served → fatal
   divergence `identity-reexecuted` (the same lexical call ran more times live than
   recorded). Reserved → fatal `target-site-reexecuted`.
5. **Dependent-target guard.** No exact match, and `p` equals some target's `path` →
   fatal divergence `dependent-or-drifted-target`: either the target site re-arrived
   with content derived from ANOTHER target's live output (dependent targets are out
   of v1 — isolate one step at a time), or the target's own identity drifted
   (config/tier/agentsDir). The detail names both candidate causes and the target.
6. **Unique-path serve (the downstream rule).** No exact match, `p` matches no target:
   let `n` = the number of recorded agent rows at path `p` (any hash).
   - `n === 1` and that row is unserved → serve it (rule 6a) with
     `hashMatched: false`. Sound by §4.6.1 serving safety; deterministic regardless of
     arrival order because the decision depends only on the recording's static row
     count at `p`. (Every agent row's origin is `"runner"`/`"journal-replay"` — §4.9
     rejects engine-origin rows, so no origin case split exists here.)
   - `n === 1` but the row is served → fatal `identity-reexecuted`.
   - `n ≥ 2` → fatal `ambiguous-path`: a multi-occurrence site received content the
     recording never saw; per-occurrence correspondence is unprovable at the seam and
     v1 refuses to guess. The error detail names the path, the candidate indexes, and
     the guidance (target a different step, restructure the fan-out into distinct call
     sites, or use propagation mode).
   - `n === 0` → fatal `unrecorded-call` (control flow left the recording).

   6a. **Outcome-faithful serving.** `"result"` → a fresh clone of the backing journal
   entry's result. `"null"` → `null` (`recordedFailure: true` on the report row).
   `"error"` → throw the §3.2a reconstruction (lossy rows cannot occur — §4.9). A
   serve fires no fabricated telemetry: none of
   `onUsage`/`onModelResolved`/`onModelFallback`/`onHistory`/`onSessionOpen` is
   invoked for served calls. The ONE callback every serve invokes (before resolving)
   is `onResultProvenance({ source: "replay", recordedRunId: baselineRunId,
   recordedIndex, hashMatched })` — truthful provenance, not fabricated telemetry
   (§3.3).

**Rule T — target settlement (harness-side, on the engine signal).** The wrapper's
`observeAgentEnd` matches root-scope events to target bindings by `callIndex` and
returns a `ReplayObservation` (§4.3). A success event closes the target row, recording
`liveResult` (the §3.0 frozen snapshot riding the event), `liveUsage`,
`resolvedModel`, `modelFallbacks`, and `backendId` — ALL from the event's sealed
telemetry (§3.3), never from wrapper-side interception. **Candidate-model evidence
(r6 B3 — positive, mirroring §4.4's baseline rule):** a target settlement is
comparable only on positive evidence the candidate was served. Sealed
`modelFallbacks` non-empty → latch the fatal divergence `candidate-fallback` (naming
the target, override, and fallback specs), return `outcome: "diverged"` — never
`completed`. Sealed `modelResolved` absent (a silent structural runner — the §4.12
item 3 residual) → the row is marked `candidateEvidence: "unverified"` and listed in
`report.unverifiedTargets`; `completed` remains possible, never without that mark.
Present with no fallback → `"verified"`. A failure event (error fields present, or
`result: null` with `errorCode`) marks the target terminally failed, carrying the
event's `errorRecord` (r6 B8); `runIsolation` reacts to the returned
`outcome: "failed"`/`"diverged"` by aborting (§4.3 step 5). The event is the §2.6
exactly-once settlement signal — the seam cannot see retry classification,
empty-output conversion, or exhaustion (§1), and no epoch or wrapper-side
classification exists in this contract.

#### 4.6.3 Serving mechanics

A serve returns a fresh JSON clone — never the recording's own object (the wrapper's
normalized copy is private, §4.3, and the engine freezes what it records, §3.0). Live
delegations forward the engine's callbacks verbatim (§4.5). Calls arriving after
`finalize()` throw a misuse `Error`.

#### 4.6.4 What v1 refuses (normative disclosure)

Strict fail-fast makes these script shapes non-isolatable in v1 — each fails with the
named typed error, never a wrong serve:

- A target whose live output fans into ≥2 downstream calls at ONE lexical path with
  novel content (`ambiguous-path`).
- Recordings containing two calls with identical `(kind, path, hash)`
  (`RECORDING_UNUSABLE`, `"ambiguous-identity"`, §4.9). **Prominent consequence
  (opus r5 A2):** the engine's own stdlib produces exactly this — `verify()` with
  no `lens` and ≥2 reviewers, `judgePanel()`, or any
  `parallel(items.map(() => agent(samePrompt)))` emits identical-prompt,
  identical-path calls (`workflow.ts:855-864`), so ANY recording containing such a
  helper call is wholly non-isolatable, even to isolate an unrelated step.
  Remedies: distinct `lens` values (which change the prompt, hence the hash),
  distinct call sites, or propagation mode. Two all-served upstream duplicates
  would be order-safe to serve, so this is over-conservative, not unsound — future
  admission is out of scope. This lands verbatim in the §8 docs.
- Targets whose prompts depend on another target's live output
  (`dependent-or-drifted-target`).
- Targets whose baseline lacks positive served-model evidence, without an explicit
  override (`REPLAY_TARGET_INVALID`, `"unproven-baseline-model"`, §4.4).
- Recordings made at the agent-limit boundary or with abort residue (§4.9 — those
  pre-allocation gates are untraceable, so admissibility must prove they never
  fired). Budget-reading scripts and budget-gated recordings are NOT refused: the
  budget gates and the script-visible `budget` surface reproduce under trajectory
  replay (§4.6.8, r6 B4).
- Live control flow that grows, shrinks structurally mid-run (`unrecorded-call` /
  `identity-reexecuted`), or completes without visiting recorded rows (§4.6.6).

For these steps, propagation mode exists today. This narrowing is the directives'
intended trade: a smaller set of provably-correct verdicts.

#### 4.6.5 The fatal latch and the single policy

There is exactly one divergence policy: every divergence kind above throws
`new WorkflowError(detail, WorkflowErrorCode.REPLAY_DIVERGENCE, { recoverable: false,
details: event })` AND sets the latch; every subsequent `run()`/`confirm` arrival
rethrows it (rule 0), so a catching script spends nothing further, and `runIsolation`
classifies `"diverged"` however the script settles. `DivergencePolicy`, `"continue"`,
`onDivergence`, and per-call divergence flags do not exist in v1; the report carries
the one causal event.

#### 4.6.6 `finalize()` and end-of-run checks

`finalize({ scriptCompleted })`, idempotent, freezes the report:

- Latch set → no end-of-run checks (post-fatal absences are consequences, not
  findings); the report carries the causal event.
- `scriptCompleted: false` (run failed/aborted) → no end-of-run checks.
- `scriptCompleted: true`, no latch → record `unvisitedRecordedIndexes` (rows never
  requested — engine-origin rows being inadmissible, §4.9, EVERY recorded row must
  be visited; no excluded class, r5 B3) and `unreachedTargets` (never bound). Either
  non-empty → `"diverged"`.
- A bound-but-unsettled target at the freeze is recorded as the `target-unsettled`
  divergence event (typed `REPLAY_DIVERGENCE`) and classifies `"failed"` (§4.3
  step 6). Reachable for admissible baselines only through settlement-order shapes
  (`Promise.race` between a served call and the target) — a baseline that floated
  the same call would itself be incomplete and rejected; mostly-defensive, specified
  because it is not dead (r5 B8 / opus A4).

#### 4.6.7 The report

```ts
export interface ReplayDivergenceEvent {
  kind: "path-unavailable" | "nested-workflow-call" | "identity-reexecuted"
      | "target-site-reexecuted" | "dependent-or-drifted-target" | "ambiguous-path"
      | "unrecorded-call" | "target-inputs-drift" | "target-unsettled"
      | "candidate-fallback"                 // r6 B3: sealed fallback on a target
      | "checkpoint-context-unavailable";    // r6 B9: pre-Gap-A engine composition
  liveCallIndex?: number;
  path?: string;
  candidateIndexes?: number[];
  detail: string;    // human diagnosis; no result payloads
}

export interface ReplayCallReport {
  liveIndex: number;                       // the live run's call index
  recordedIndex?: number;                  // the served/target row (absent: no row)
  kind: "agent" | "checkpoint";
  mode: "served" | "live-target";
  /** live hash === recorded row hash. false exactly on rule-6 unique-path serves —
   *  the machine-readable "held fixed by path, content differed" signal. */
  hashMatched: boolean;
  label?: string;
  recordedFailure?: boolean;               // served a recorded null
  recordedError?: WorkflowRecordedError;   // served a recorded throw
  recordedUsage?: AgentUsage;              // baseline cost (manifest row; lower bound)
  // live-target rows — every live field sourced from the sealed terminal event (§3.3):
  liveResult?: unknown;                    // fresh clone; absent on throw
  /** Sealed per-call sum (§3.5) — an observed LOWER BOUND, never "authoritative". */
  liveUsage?: AgentUsage;
  attempts?: number;                       // wrapper-counted delegations
  modelRequested?: string;                 // what the engine delivered to run()
  overrideModel?: string;                  // what was sent to inner
  resolvedModel?: string;                  // sealed onModelResolved (event)
  modelFallbacks?: string[];               // sealed, attempt-ordered (event)
  backendId?: string;                      // sealed onSessionOpen backendId (event)
  error?: string;                          // terminal failure (target-failed)
  errorCode?: WorkflowErrorCode;
  /** r6 B3 — live-target rows only: "verified" (sealed modelResolved, no fallback)
   *  or "unverified" (silent runner; the §4.12 item 3 residual, explicitly marked).
   *  A sealed fallback never reaches a report row — it latches candidate-fallback. */
  candidateEvidence?: "verified" | "unverified";
}

export interface ReplayReport {
  baselineRunId: string;
  isolationRunId: string;
  targets: ResolvedIsolationTarget[];
  /** One row per BOUND logical call (served or live-target), ascending liveIndex;
   *  retries collapse into their binding. An arrival that diverges BEFORE binding
   *  produces NO row (r6 B9) — its identity rides the causal ReplayDivergenceEvent
   *  (`liveCallIndex`/`path`). Root scope only. */
  calls: ReplayCallReport[];
  /** The causal fatal event, when the latch was set (or target-unsettled). */
  divergence?: ReplayDivergenceEvent;
  unvisitedRecordedIndexes?: number[];     // finalize, completed script only
  unreachedTargets?: number[];             // recordedIndexes never bound
  /** r6 B3 — recordedIndexes of settled targets with candidateEvidence
   *  "unverified". Present (possibly empty) whenever any target settled. */
  unverifiedTargets?: number[];
  targetUnsettled?: number[];              // bound, unsettled at freeze (§3.2 window)
  finalized: boolean;
  /** Human-readable observations only (recorded failure baselines, missing usage,
   *  worktree rows, model notes). Consumers MUST NOT parse notes; every
   *  machine-readable fact rides the typed fields. */
  notes: string[];
}
```

Per-target retry aggregation: `resolvedModel`/`backendId`/`liveResult`/`error`/
`errorCode`/`liveUsage`/`modelFallbacks` come from the ONE sealed terminal event (the
engine already aggregated attempts, §3.5); `attempts` counts the wrapper's delegations.
`mode: "live-target"` means "delegated to `inner`" — which may itself be a wrapper. The
cost comparison the evals layer needs is `recordedUsage` vs `liveUsage` on target rows
plus the served rows' `recordedUsage` — nothing else; the isolation run's own
`tokenUsage`/per-agent `tokens` are estimate-polluted and NOT comparable (§4.8).

#### 4.6.8 Budget-trajectory replay (r6 B4 — owner-prescribed build)

The script-visible budget surface (`budget.spent()`/`remaining()`, the run
`tokenBudget` gate, phase sub-budget gates — §1) reproduces the recording by replaying
the RECORDED debits, in recorded settlement order, at the budget surface:

- **Inputs.** The recorded per-row `budgetDebit` + `settlementOrdinal` (§3.2, §3.5;
  §4.9 check 6 requires both) and the reproduced budget inputs — `tokenBudget`/
  `maxAgents` forced to the recording's limits (§4.3), phase budgets from the
  byte-identical script.
- **Channels (additive).** `WorkflowRunOptions.budgetReplay?: { trajectory:
  Array<{ ordinal: number; debit: number }> }` — the recording's agent rows,
  ascending ordinal, built by `runIsolation`; and `RunOptions.onBudgetReplay?:
  (r: { settlementOrdinal: number }) => void` — the wrapper reports the bound row's
  ordinal before resolving every serve and before every target delegation
  (attempt-sealed, §3.5). Absent `budgetReplay` (every normal run), accrual is
  unchanged.
- **The ordinal-cursor rule (ordering under parallel settlement).** Under
  `budgetReplay` the engine suppresses live `recordTokens` accrual into
  `shared.spent` entirely — a live target's usage stays report telemetry. One
  run-level cursor walks the trajectory: when a call with sealed ordinal `k`
  settles, BEFORE that settlement is exposed to script code the engine applies every
  not-yet-applied debit with `ordinal ≤ k` (apply-once, monotonic). Ordinals totally
  order the baseline's settlements, so `spent()` observed in call `k`'s continuation
  EQUALS the recording's value at that point; pre-applying a lower ordinal still in
  flight makes the rule deadlock-free (no exposure ever waits). Checkpoint ordinals
  carry no debit. A `budget` read RACING concurrent settlements may observe a cursor
  state the baseline sample did not — the owner-approved residual, §4.12 item 5.
- **Gate reproduction.** The pre-allocation run/phase budget gates read
  `shared.spent` at invocation; with identical budget inputs and the exact recorded
  trajectory at every exposure point they fire in replay exactly where they fired
  when recording — including gates the baseline script CAUGHT (why no budget
  admissibility exclusion remains, §4.9 check 6).

### 4.7 Checkpoint serving

Checkpoints never reach the runner; the wrapper's pre-bound `confirm` is wired as the
run's confirm, and the engine consults a wired confirm FIRST (`workflow.ts:1018`), so
EVERY checkpoint of the isolation run arrives there, whatever its recorded origin.
Rules mirror §4.6.2 with `kind: "checkpoint"` (no fingerprint — §2.4: the hashed
inputs are the only outcome-shaping ones under isolation; the un-hashed
`CheckpointOptions` are intentionally ignored, r6 B12):

- `context` (the `CheckpointCallContext`) absent → fatal divergence
  `checkpoint-context-unavailable` (r6 B9 — a representable latched
  `ReplayDivergenceEvent`, typed `REPLAY_DIVERGENCE`; detail: "isolation requires an
  engine that threads checkpoint identity"). This guard is DEFENSIVE, not dead:
  `isolation.ts` ships with the Gap-A engine, but a host composing
  `createReplayRunner` with its own manager can wire `wrapper.confirm` into a stale
  pre-Gap-A engine build in a mixed-version tree (opus r5 A3). `context.path`
  absent → fatal `path-unavailable`.
- Latch, binding (keyed `(context.scope, context.callIndex)`), and the foreign-scope
  guard apply verbatim (`context.scope !== rootRunId` → `nested-workflow-call`).
- Exact serve on `(checkpoint, path, hash)` (identities unique per §4.9); then the
  unique-path rule over checkpoint rows (all origins `"confirm"`/`"headless"`/
  `"journal-replay"` — engine-origin rows are inadmissible); all refusal kinds as
  §4.6.2. Checkpoints are never targets.
- Outcome semantics, uniform for every recorded origin: `"result"` rows serve the
  backing journal entry's reply (clone-fresh) — recorded headless defaults and resumed
  replayed replies included (nothing "reproduces engine-side"; the engine asked the
  wrapper). `"error"` rows re-throw the §3.2a reconstruction — recorded caught
  headless-aborts replay as `WORKFLOW_ABORTED`; recorded caught durable pauses replay
  as `CHECKPOINT_REQUIRED` with their `checkpointContext`; plain confirm throws (Errors
  or raw values) replay in recorded form, `props` included.
- Served checkpoints appear in the report (`kind: "checkpoint"`, `mode: "served"`) and
  in the isolation run's own manifest with origin `"confirm"` (faithful: the wrapper IS
  this run's confirm). No agent events are fabricated for them.

### 4.8 Observability and persistence of an isolation run (decision, per Q5)

- **A real managed run.** `runIsolation` drives a private `WorkflowManager` (§4.3): the
  run leases, persists initial + terminal state (with `executionMode` from the FIRST
  save and `replayReport` after the terminal save — §4.2), journals, collects its
  manifest, and emits the full manager event set on the private manager. Exposed
  observability: `onProgress` (the one passthrough) and the report. A host needing
  the full event stream composes `createReplayRunner` with its own manager — owns
  passing `executionMode` there (§4.2). Served-vs-live IS visible per call in that
  host's own event stream: terminal `agentEnd` events carry the sealed
  `provenance.source` field (§3.3 — r6 B11 deletes the contradictory "events carry
  no provenance" claim). `observeAgentEnd` remains REQUIRED — not for served/live
  visibility but for target-settlement observation and report aggregation
  (§4.6 rule T); `report()` is the aggregate surface.
- **`ExecOptions.runId` collision guard — lease-first (r6 B10; needed by §4.3
  step 3).** Load-then-lease has a cross-process TOCTOU hole (two managers both
  observe no file; the later save overwrites), so the order is normative: both
  manager start paths FIRST acquire the id's run lease (`acquireRunLease`), THEN —
  while holding it — check the in-memory `runs` map and `persistence.load(id)`
  before the initial save. Existing caller-supplied id → typed throw ("run id
  already exists: <id>"), lease released; colliding generated id → re-mint and
  re-acquire. Check-then-save is atomic under the held lease, so among lease-honoring
  managers `save` never overwrites an existing run's file, and an isolation artifact
  can never clobber its baseline (`runIsolation` additionally re-mints on
  `rootRunId === baselineRunId`). Failure timing per API: `startInBackground` throws
  synchronously; `runSync`/`resumeInBackground` reject their returned Promise
  (r6 B6/B8). This guard reaches `runIsolation` callers only as typed
  `WorkflowError`s (§4.3 step 4).
- **Served vs live.** Served calls are real engine-side calls resolving
  near-instantly: they fire `agentStart`/`agentEnd` (`tokens` = the chars/4
  estimate, no `usage` — nothing pretends the recorded spend recurred), journal
  their served snapshots, and get origin-`"runner"` manifest rows — and, per §3.3,
  their events and rows carry `provenance.source: "replay"` while target rows carry
  `"live"` (+`overrideModel`). The artifact's own per-call token figures are
  therefore NOT comparable to a normal run's; `replayReport` is the only valid
  cost/provenance surface — stated verbatim in `docs/api.md` (§8; opus r5 A6). A
  served recorded failure returns `null`; the manager maps it to snapshot status
  `"error"` — consistent with the recording; disclosed.
- **Sessions.** Served calls open no sessions; `keepSession` on a served call is inert;
  the isolation run's `agentSessions` contains only live-call sessions. Baseline
  session records remain reachable on the baseline
  (`getPersistedAgentSessions(baselineRunId)`).
- **Worktree side effect (disclosed).** "Served" refers to the seam: a served call
  whose site resolves `isolation: "worktree"` still pays `git worktree add`/`remove`
  (`workflow.ts:568-573`) — real disk mutation and latency. Preflight `notes` flag
  recordings with `worktree: true` rows.
- **Aggregates.** `journaling: false` writes no durable run state (and no
  `replayReport`) but still touches the runs dir transiently (the lease); harness loops
  that want zero durable artifacts pass `journaling: false` and a temp
  `persistenceRoot`.

### 4.9 Preconditions and error codes (per Q6)

**New `WorkflowErrorCode` members** (`packages/shared-types/src/errors.ts:17-45`,
additive; payload shapes ride `details`):

```ts
  /** A recording is unusable as an isolation baseline. Non-recoverable.
   *  details: { reason: string; runId?: string; indexes?: number[] }. */
  RECORDING_UNUSABLE = "RECORDING_UNUSABLE",
  /** A target could not be resolved to exactly one admissible recorded agent call.
   *  Non-recoverable. details: { target, reason, candidates? }. */
  REPLAY_TARGET_INVALID = "REPLAY_TARGET_INVALID",
  /** The re-executed script left the recording, or correspondence was unprovable.
   *  Non-recoverable. details: ReplayDivergenceEvent. */
  REPLAY_DIVERGENCE = "REPLAY_DIVERGENCE",
```

**Preflight checks** (run by `runIsolation` after load and by `createReplayRunner` on
its normalized copy — §4.3). First failure wins; each rejection names the violated
invariant, field, and index. All inputs are post-`JSON.parse` (loaded file) or
post-normalization (JSON round-trip of the in-memory object — prototypes never
consulted, the JSON projection IS the recording), so JSON-safety holds by construction
on both API paths. `RECORDING_UNUSABLE` reasons are FROZEN kebab-case literals
(r5 advisory 2), exactly: `"not-found"`, `"corrupt-structure"`, `"not-completed"`,
`"script-invalid"`, `"incomplete-manifest"`, `"nested-workflow-recording"`,
`"isolation-artifact"`, `"legacy-resume"`, `"abort-residue"`, `"engine-origin-row"`,
`"replayed-row"`, `"unreplayable-error"`, `"args-unreplayable"`,
`"ambiguous-identity"`, `"path-missing"`, `"runtime-mismatch"`, `"no-limits"`,
`"agent-limit-boundary"`, `"no-budget-trajectory"`, `"no-execution-cwd"`,
`"no-environment-identity"`, `"environment-mismatch"`,
`"journal-manifest-mismatch"`. (r6 B4 removed `"budget-gated-recording"` and
`"budget-sensitive-script"` — the budget gates now reproduce, §4.6.8.)

1. **Structural validity over every consumed field** (`"corrupt-structure"`).
   `runId`/`script` non-empty strings; `status` a string; `effectiveCwd`/`cwd`/
   `mainModel`/`agentsDir` strings when present; `runtime.node` a string and
   `runtime.pathFormat` an integer when present; `callsAllocated` a non-negative
   integer when present; `limits` when present: `maxAgents`/`concurrency` positive
   integers, `agentRetries` a non-negative integer, `tokenBudget`/`agentTimeoutMs`
   null-or-number; `args` anything JSON. `agents[]`: per row, `label`
   string, `status` in the §3.4 enum, `callIndex`/`scope`/`model`/`usage` type-checked
   when present. `journal[]`: may be EMPTY; per entry `index` non-negative integer,
   indexes unique, `hash` non-empty string, `kind`/`scope` in-enum/non-empty when
   present. `calls[]`: per row every §3.2 field type-checked; `path`/`inputsHash`
   non-empty strings when present; discriminated combinations — agent×runner: outcome
   any, `attempts` required, `resolvedCwd` required (r6 B1), `error` required on
   `"null"`/`"error"` and forbidden on `"result"`, on `"null"` the error is
   `form: "workflow-error"` with `recoverable: true`, on non-aborted `"error"`
   `recoverable: false`;
   agent×journal-replay: outcome `"result"` only, attempts/error/aborted forbidden;
   agent×engine: outcome `"error"` only, error required `form: "workflow-error"`,
   attempts/usage forbidden; checkpoint×confirm/headless: outcome `"result"`/
   `"error"`, attempts/usage/worktree forbidden, headless errors
   `form: "workflow-error"`; checkpoint×journal-replay: `"result"` only;
   checkpoint×engine: `"error"` + `aborted: true` + `code: WORKFLOW_ABORTED`. Any
   other combination → corrupt. `WorkflowRecordedError` values: `form` in enum;
   `"workflow-error"` → `code` REQUIRED and a member of THIS build's enum AND
   `message` REQUIRED a string (r5 B13.2); `"error"` → `name`/`message` strings,
   `props` a plain object when present; `"value"` → `value` present unless `lossy`.
2. `status === "completed"` → else `"not-completed"` (partial recordings are
   propagation mode's job).
3. `script` parses (`parseWorkflowScript`) → else `"script-invalid"`.
4. **Manifest completeness (§3.2):** `calls[]` present, `callsAllocated` present,
   `callsAllocated === calls.length`, indexes dense from 0 → else
   `"incomplete-manifest"` naming the missing indexes (a floated trailing call is
   caught HERE, at preflight, before any spend).
5. **No disqualifying markers/rows:** `nestedWorkflows` or any foreign-scope
   agents/journal/calls row → `"nested-workflow-recording"`; `executionMode` →
   `"isolation-artifact"`; `legacyResume` → `"legacy-resume"`; `abortSignaled` or any
   `aborted: true` row → `"abort-residue"` (covers pre-allocation abort throws, which
   leave no row but require an aborted signal — r5 B2); any origin-`"engine"` row →
   `"engine-origin-row"` (r5 B3 — such rows would be invisible to visitation
   accounting; rare in practice: caught cwd-validation deaths); any row with
   `provenance.source === "replay"` → `"replayed-row"` (the baseline's own value was
   served from another recording, not produced live — catches own-manager
   compositions that omitted the §4.2 marker); any `error.lossy` row
   → `"unreplayable-error"`; `argsUnreplayable` → `"args-unreplayable"` (r6 B6 —
   the persisted args are not a faithful replay input). `provenance`, where present,
   must sit on an agent×runner row with `source` in-enum and fields type-checked
   (else `"corrupt-structure"`).
6. **Gate freedom and budget trajectory (r5 B2 / r6 B4):** `limits` present → else
   `"no-limits"`; `callsAllocated < limits.maxAgents` → else
   `"agent-limit-boundary"` (monotonic-counter proof, §1). Every row carries a
   `settlementOrdinal` (unique, dense 1..`calls.length`) and every agent row a
   finite non-negative `budgetDebit` → else `"no-budget-trajectory"` (the §4.6.8
   replay facts). No budget-shaped exclusion exists: r6 B4 removed the draft AST
   probe and tokenBudget/budget-reading refusals — §4.3 + §4.6.8 make the budget
   gates fire in replay exactly where the baseline's did.
7. **Identity uniqueness:** no two `calls[]` rows share `(kind, path, hash)` → else
   `"ambiguous-identity"`, listing indexes (§4.6.4).
8. **Paths present:** every row carries `path` → else `"path-missing"` ("re-record
   with an engine that captures call paths"). **Runtime boundary (r6 B14 — exact
   equality, before any spend):** `runtime` present with
   `pathFormat === CALL_PATH_FORMAT`, `inputsFormat === CALL_INPUTS_FORMAT`,
   `node === process.version`, `v8 === process.versions.v8` (FULL strings) → else
   `"runtime-mismatch"`. V8 CallSite drift is excluded at preflight instead of
   surfacing as mid-run refusals after target spend.
9. **Execution context:** `effectiveCwd` present, or legacy `cwd` present, or
   `executionCwd` supplied → else `"no-execution-cwd"` (never a silent
   `process.cwd()`). **Environment identity (r6 B14):** `environment` present →
   else `"no-environment-identity"`; the preflight recomputes the CURRENT identity
   by the §3.3a rule (git HEAD + dirty/untracked digest when the execution directory
   is inside a repository, else `options.environmentKey`) and requires field-wise
   equality → else `"environment-mismatch"` — filesystem/repository comparability
   gated before spend, not a caller assertion.
10. **Journal cross-check:** every `outcome: "result"` row has a journal entry at its
    index with equal hash and (when the entry carries `kind`) equal kind → else
    `"journal-manifest-mismatch"`. Journal entries with no row, disagreeing with their
    row, or sitting at a failure-row index are stale residue: excluded from serving,
    listed in `notes`.
11. Target resolution, fingerprint presence, cwd pinnability, and baseline-model
    evidence per §4.4 (`REPLAY_TARGET_INVALID`; reasons `"no-input-fingerprint"`,
    `"unproven-baseline-model"`, `"re-record-or-target-by-callindex"`,
    `"journal-replay-target"`, `"worktree-target"`, …).
12. Non-blocking `notes`: recorded failure baselines, rows without `usage`, worktree
    rows, a `tier:`/`agentType:` substring probe surfacing the model-resolution
    reproduction precondition (§4.6.1).

**Engine-version tolerance (decision).** No version gate beyond check 8's exact
runtime equality (`pathFormat`/`inputsFormat`/`node`/`v8` — load-bearing for §2.5 and
§2.7). Everything else is structural: preflight validates the structures it consumes
and rejects per-feature with messages that say what is missing.

### 4.10 SDK surface (`@automatalabs/workflows`)

- **Re-export verbatim:** `createReplayRunner` and every §4.3/§4.6.7 type, plus
  `CheckpointCallContext`, `WorkflowCallRecord`, `WorkflowRecordedError`.
- **Enrich under the same name:** the SDK exports its own `runIsolation` (engine
  function imported internally; the `WorkflowManager` enrichment precedent):

```ts
export interface RunIsolationSdkOptions
  extends Omit<RunIsolationOptions, "runner" | "scriptBackends"> {
  /** Omitted => createAcpRunner(), disposed after the run (the runDynamicWorkflow
   *  owned-runner rule, workflows/src/index.ts:527-535). */
  runner?: AgentRunner;
  /** Approval for the RECORDING's script-declared meta.backends (same
   *  ScriptBackendApproval semantics as runDynamicWorkflow). */
  allowScriptBackends?: ScriptBackendApproval;
}
export async function runIsolation<T = unknown>(
  opts: RunIsolationSdkOptions): Promise<IsolationRunResult<T>>;
```

Mechanics: load the recording (engine `createRunPersistence` as an SDK dependency, not
a new export) to read `meta.backends`, run the existing module-private
`approveScriptBackends`, then delegate to the engine `runIsolation` by
`baselineRunId` (the engine re-loads and preflights; deliberate redundancy). Same
rejection contract: async, typed, never a synchronous throw.

**Named test seam (r6 advisory 3).** The default-runner path goes through a
module-private factory variable (initialized to `createAcpRunner`), with the
test-only setter `__setDefaultRunnerFactoryForTests(factory | undefined)` exported
from `packages/workflows/src/isolation.ts` but NOT re-exported by the package
index — the §7 disposal assertion injects a fake runner through it (owned-runner
rule); no ACP process spawns in unit tests.

### 4.11 Explicitly not in this feature

- N-sample repetition (the evals harness loops `runIsolation`; per-invocation args
  cloning makes one baseline safely reusable).
- Per-occurrence identity for multi-occurrence paths; admission of all-served
  duplicate identities (§4.6.4); dependent targets; positional pairing;
  lenient/serve-with-flag policies.
- Cross-recording target resolution, judge/scorer plumbing, report rendering.
- An external model-override surface for propagation mode.
- Settlement-order recording/reproduction (§4.12 item 1 is the honest boundary).

### 4.12 Normative limitations (all fail closed)

Per the design-owner directive, each limitation below is part of the contract: the
stated behavior is a typed error or an explicit not-comparable classification, and
implementers/docs must present it as a boundary, not a bug.

1. **Settlement-order sensitivity.** Serving changes latencies; a script that branches
   on realm-visible completion order can take a different path in replay. Every
   consequence is fail-closed: target-context drift dies at `target-inputs-drift`
   (§2.7), structural drift at the §4.6.2 refusals, and a target left floating at
   `target-unsettled` (§4.6.6). What is NOT guaranteed: `IsolationRunResult.run.result`
   equality with the baseline — the report, not the script's return value, is the
   comparison surface.
2. **The vm escape.** The engine documents that scripts can reach the host `Function`
   (`workflow.ts:297-308`); trusted scripts are an admissibility precondition. §4.6.1
   bounds the blast radius: refusals or non-compared surfaces only.
3. **Runner honesty.** Sealed `modelResolved`/`backendId`/`onUsage` reports are the
   runner's self-reporting; a runner that lies cannot be caught, one that stays silent
   is refused for no-override targets (§4.4), yields absent usage (lower-bound
   framing, §3.5), and yields `candidateEvidence: "unverified"` target marks
   (§4.6 rule T — explicit, never a silent pass).
4. **Spend containment is best-effort.** On target failure or a floated target,
   `runIsolation` aborts via `RunOptions.signal`, and every timed-out attempt is now
   individually aborted through its per-attempt signal (§3.5, r6 B13). The default
   ACP runner honors it — the signal is wired to ACP `session/cancel` and the runner
   rethrows on abort (`packages/acp-agents/src/runner.ts:14-18`, `:711`, `:756`), and
   backend process teardown is the connection pool's dispose contract — so the
   residual is a THIRD-PARTY runner that ignores `RunOptions.signal`: it keeps
   spending on its own account. The run is already classified (`"target-failed"` /
   `"failed"`), the manager drops post-terminal events (§3.3a), and the wrapper
   rejects post-finalize arrivals — state stays sealed even when spend continues.
5. **The budget-read race (owner-approved residual, r6 B4).** Trajectory replay
   reproduces the recorded `spent()` at every settlement-exposure point (§4.6.8),
   but a `budget` read RACING concurrent settlements can observe a cursor state the
   baseline sample never exposed; where it influences only non-call outputs (log
   lines, the script's return value — surfaces the verdict never compares) it may
   differ from the baseline. Never call structure: any call-structure consequence
   still fails closed through the §4.6.2 refusals.
---

## 5. Run-file contract status (decision, per Q7)

**The persisted-run TYPE is now a documented public contract; the STORAGE is not.**
Precisely (resolving r5 advisory 5's ambiguity):

- `PersistedRunState`, `PersistedAgentState`, `JournalEntry`, `WorkflowCallRecord`,
  `WorkflowRecordedError`, `AgentResultProvenance`, and `ReplayReport` — as amended
  by §3 — are documented public types, published from the engine/shared-types and
  re-exported by the SDK. External consumers MAY depend on their shapes. Evolution
  is **additive-only**: a new field is always optional-on-read, absence means "not
  recorded", no field ever changes meaning or type, disclosed behavior fixes ride
  changeset callouts (§8). The journal hash byte layout is pinned forever
  (`journal-hash.test.ts:42-64`).
- The runs-directory LOCATION and LAYOUT (`workflow-paths.ts:53-77`) stay internal:
  no compatibility promise attaches to the path scheme, the `.bak`/`.lock` mechanics,
  or the right to read another tool's files. The supported read path is
  `createRunPersistence(cwd, fs?, { persistenceRoot })` (engine export) or
  `WorkflowManager.getPersistence()` (`workflow-manager.ts:1057`); the SDK gains no
  new persistence export (§4.10 uses the engine's internally).
- Consumers must tolerate BOTH absence (old files) and unknown extra keys (newer
  files) on every read — the same rule the isolation preflight itself follows (§3.7,
  §4.9). A reader that hard-fails on an unknown key is out of contract.
- Documented-baseline admissibility (§4.9) is a STRICTER, versioned overlay on this
  contract: a file can be perfectly valid as a run record and still be inadmissible
  as an isolation baseline. The two notions are never conflated in docs (§8).

## 6. Per-package change list

**`@automatalabs/shared-types`** (`src/agent-run.ts`, `src/workflow-result.ts`,
`src/errors.ts`):
- `RunOptions` + `callIndex?`/`callHash?`/`callPath?`/`callInputsHash?` (§2.1),
  `onResultProvenance?` (§3.3), `onBudgetReplay?` (§4.6.8); normative cardinality
  doc on `onUsage` (§3.5).
- New `AgentResultProvenance` (§3.3), `WorkflowCallRecord` (§3.2),
  `WorkflowRecordedError` (§3.2a).
- `JournalEntry` + `kind?`/`usage?`/`scope?` (§3.1).
- `WorkflowRunResult` + `calls?`/`callsAllocated?`/`effectiveLimits?`/
  `abortSignaled?`/`nestedWorkflows?` (§3.2, §2.3).
- `WorkflowErrorCode` + `RECORDING_UNUSABLE`/`REPLAY_TARGET_INVALID`/
  `REPLAY_DIVERGENCE` (§4.9).

**`@automatalabs/workflow-engine`**:
- `src/workflow.ts` — thread the four identity fields into the opts bag
  (`:621-672`); `sanitizeVmName` + sanitized compile filename (§2.5); call-path
  capture with explicit `isAsync()` exclusion + `CALL_PATH_FORMAT`/
  `CALL_PATH_RAW_FRAMES` constants (§2.5); `hashCallInputs` (§2.7);
  `SharedRuntime.nestedSeq` + ordinal child runId +
  `WorkflowRunOptions.onNestedWorkflow?` (§2.3); `CheckpointCallContext` +
  widened `confirm` call site (§2.4); §2.6 guarded terminal-transition settlement
  (`onCallRecord` → journal → `onAgentEnd`, each try/caught, decided-before-observers,
  engine-owned manifest append FIRST — r6 B7); §3.5 attempt-scoped slots
  (snapshot-at-receipt + usage validation, r6 advisory 2) + settlement seal for
  `onUsage`/`onSessionOpen`/`onModelResolved`/`onModelFallback`/`onResultProvenance`/
  `onBudgetReplay`/`onHistory`; per-attempt AbortController + timeout abort (§3.5,
  r6 B13); `budgetDebit`/`settlementOrdinal` capture (§3.2, §3.5) + the
  `WorkflowRunOptions.budgetReplay` ordinal-cursor (§4.6.8); §3.0 strict-JSON
  validation + deep-freeze at every capture boundary (agent results, checkpoint
  replies, headless defaults); `onCallRecord` emission at every §3.2 exit;
  `WorkflowRunOptions.onCallRecord?`; event payloads per §3.3 (incl. `errorRecord`,
  r6 B8); `calls`/`effectiveLimits`/`callsAllocated`/`abortSignaled` on
  `WorkflowRunResult`.
- `src/workflow-manager.ts` — args choke points via `snapshotArgs` at ALL THREE
  creation sites + clone-to-VM in `executeRun` + the `argsUnreplayable` marker
  (§3.3a, r6 B6); persist
  `effectiveCwd`/`runtime` (node/v8/pathFormat/inputsFormat)/`environment`/`limits`/
  `callsAllocated`/`abortSignaled`/`mainModel`/`agentsDir`/`nestedWorkflows`/
  `legacyResume`/`executionMode`/`replayReport` (§3.3a, r6 B14); root-scope-only
  journal/manifest persistence (§2.3); manifest collection/seeding (§3.2, §3.6);
  `agentEnd`/`agentHistory` row-matching by `(scope, callIndex)` (§3.3);
  post-terminal event drop (§3.3a); `ExecOptions` +
  `runId?`/`executionMode?`/`environmentKey?` + the LEASE-FIRST runId collision
  guard (§3.3a, §4.8, r6 B10); `ExecOptions.onNestedWorkflow?` threading (§2.3);
  `resumeInBackground` rejects `executionMode` states and sets `legacyResume`
  (§4.2, §3.3a); synthetic durable-checkpoint entry fields (§3.1).
- `src/display.ts` — snapshot `callIndex?`/`scope?`/`usage?`/`provenance?` (§3.4).
- `src/run-persistence.ts` — `PersistedRunState`/`PersistedAgentState` diffs
  (§3.3a, §3.4).
- **NEW `src/isolation.ts`** — `runIsolation`, `createReplayRunner`,
  `RunIsolationOptions`, `IsolationRunResult`, `ReplayRunnerOptions`,
  `ResolvedIsolationTarget`, `IsolationTarget`, `ReplayRunner`, `ReplayObservation`,
  `ReplayReport`, `ReplayCallReport`, `ReplayDivergenceEvent`, the §4.9 preflight
  (incl. the r6 B14 runtime/environment gates), the §4.6.8 trajectory construction,
  the §3.2a reconstruction, and TWO exported runtime const arrays (r6 advisory 1) —
  `RECORDING_UNUSABLE_REASONS` and `REPLAY_DIVERGENCE_KINDS` — the §8 drift
  tripwire's import surface.
- `src/index.ts` — export the isolation surface + `CheckpointCallContext`.

**`@automatalabs/workflows`** (`src/index.ts`, new `src/isolation.ts`): re-export
the isolation types + `createReplayRunner`; SDK `runIsolation` with ACP default
runner + owned-runner dispose + `allowScriptBackends` approval + the
`__setDefaultRunnerFactoryForTests` module-private seam (§4.10, r6 advisory 3).

**`@automatalabs/acp-agents`** — NO changes. The runner already conforms: identity
fields are optional and ignored; `onUsage` once-per-attempt satisfies §3.5;
`options.signal` honoring is cited by §4.12. **`@automatalabs/mcp-server`,
`@automatalabs/agentprism-otel`** — NO changes (non-goals).

## 7. Test plan

All tests are `node:test` + `tsx` per package (`pnpm test`). Every round-4/round-5
counterexample below is pinned by its review id. The pinned hash test
(`packages/workflow-engine/test/journal-hash.test.ts:42-64`) MUST pass UNMODIFIED in
every PR of the train — asserting the byte layout survived is itself part of this
plan.

**`workflow-engine/test/call-identity.test.ts` (new).** The four `RunOptions` fields
reach a mock runner; values identical across retry attempts of one logical call;
checkpoint indexes leave gaps in runner-visible indexes; `confirm` receives the full
`CheckpointCallContext` (and a two-argument legacy confirm still compiles/runs);
nested children: child-local index space, child scope on entries/records/events;
**[r5 B5]** two SEQUENTIAL identical sibling `workflow()` children carry DISTINCT
scopes (`-nested1`/`-nested2`), and two distinct parent call sites likewise; the
first child of a run keeps `-nested1`.

**`workflow-engine/test/call-path.test.ts` (new).** Body-relative normalization
(`line = frameLine − (preludeLines + 1)`), unaffected by meta-block formatting; a
synchronous script helper yields `"a<b"`; **[r5 B11]** an AWAITING helper truncates
the chain — pinned against the real structured stack (adjacent same-filename
`isAsync` frame excluded by the explicit filter, not filename mismatch); >64 raw
frames → `callPath` undefined, never a truncated prefix; loop iterations and mapped
thunks share one path; aliased calls carry the call-site path; `sanitizeVmName`
(separators, >64 chars, empty → `"workflow"`); `CALL_PATH_FORMAT` pinned so an
algorithm change forces a conscious bump.

**`workflow-engine/test/call-manifest.test.ts` (new).** One record per terminal exit,
exhaustively: success; recoverable exhaustion → `"null"` + error + attempts; a
non-recoverable throw; **[r5 B3 structure]** engine-side cwd-validation death →
origin `"engine"`; post-allocation abort → `aborted: true`; journal-replay
short-circuits (agent + checkpoint) with carried usage; checkpoint
confirm/headless/durable-pause/reply-validation exits with origins and §3.2a
projections; `callsAllocated` returned and persisted; `effectiveLimits` carries all
FIVE resolved values (incl. host-derived concurrency); `abortSignaled`; **[r6 B4]**
every row carries a dense unique `settlementOrdinal` and agent rows carry
`budgetDebit` equal to the exact `recordTokens` charge — provider-reported AND
chars/4-estimate cases both pinned; `resolvedCwd` on every agent×runner row
**[r6 B1]**; **[r5 B2 structure]** a pre-allocation gate throw (maxAgents:1 second
call) leaves NO row and NO index shift; a floated call at script settlement →
missing row + `callsAllocated ≠ calls.length` (the §3.2 exception window,
detectable).

**`workflow-engine/test/settlement.test.ts` (new).** **[r5 B6]** a throwing user
`onProgress`/`onAgentEnd` no longer converts a success into retry/failure: outcome
unchanged, exactly one terminal event, throw logged; observer order
`onCallRecord` → journal → `onAgentEnd`; **[r6 B7]** a THROWING `onCallRecord` still
leaves the authoritative row in the engine-returned `WorkflowRunResult.calls`;
**[r5 B7]** a timed-out attempt's late `onUsage`/`onModelResolved`/`onHistory` are
dropped after the seal — report fields come only from sealed slots, tested before
and after a later attempt settles; **[r6 B13]** a timed-out attempt's per-attempt
signal is ABORTED when the timer wins (mock observes it; the run signal stays live);
multi-report cumulative `onUsage` last-wins within one attempt; **[r6 advisory 2]**
mutating a usage object after reporting never changes the received copy, and a
non-finite/negative report is dropped; per-call usage = field-wise sum of sealed
winners; `modelFallbacks` attempt-ordered, duplicates kept; `onResultProvenance` and
`onBudgetReplay` sealed like the rest.

**`workflow-engine/test/frozen-snapshot.test.ts` (new).** **[r5 B9]** a `journal`
event listener mutating `entry.result` does NOT change what is persisted; the same
frozen snapshot rides journal/manifest/event; the script receives the runner's
ORIGINAL object and its mutations reach no artifact; strict-JSON rejection → typed
`AGENT_EXECUTION_ERROR` naming the first bad path for each of: cycle, BigInt, `Date`,
`Map`, `NaN`, `undefined` member, accessor, custom prototype; checkpoint reply
`undefined` and non-qualifying host replies → typed error, manifest outcome
`"error"`; a qualifying value round-trips byte-identically (`"flag" in result`
preserved).

**`workflow-engine/test/manager-state.test.ts` (new).** **[r5 B10 / opus B1]** a
script that mutates `args` between calls: persisted `args` is the PRE-execution
snapshot on ALL THREE paths — `runSync`, `startInBackground` (initial save at `:317`
checked too), and `resumeInBackground` — and the caller's original object is
unmutated (VM clone independence); no-args runs (`runSync(script)`) work unchanged
(`snapshotArgs(undefined).clone === undefined`); **[r6 B6]** non-strict-JSON args
(a `Date`, a custom instance): the run EXECUTES unchanged, the VM sees the verbatim
object, `argsUnreplayable: true` persists, no manager API throws/rejects over args
shape; `effectiveCwd` persisted from the manager-cwd fallback; **[r6 B14]**
`runtime` persisted (full node + v8 + both format constants) and `environment`
captured (git HEAD + dirty digest in a repo; `environmentKey` outside; else absent);
`legacyResume` set when resuming a manifest-less state; **[r5 B8]** post-terminal
drop: a floated call's late journal/record/event after `"completed"` neither
re-persists nor re-emits; **[r6 B10]** the LEASE-FIRST runId collision guard, pinned
by a DELAYED two-manager race (the second manager, started before the first's save,
still refuses the id and never overwrites the file); `executionMode` states rejected
by `resumeInBackground`; root-only persistence: nested-child journal/manifest rows
never enter the persisted file.

**`workflow-engine/test/input-fingerprint.test.ts` (new).** Canonicalization: sorted
keys, arrays ordered; identical across runs for worktree-isolated calls
(pre-resolution values); each of images/cwd/mcpServers/meta/promptMeta/keepSession/
isolation — and **[r6 B1]** label (incl. the default-label path), effective
timeoutMs, normalized retries, and the approved-backends digest (same name,
different config) — changes the fingerprint; a non-qualifying component (function in
`meta`) → fingerprint absent, never partial. **[r6 B5]** every fingerprint fixture
object is created INSIDE the vm realm (actual script-authored literals), never a
host lookalike — the same rule applies to the §3.0 frozen-snapshot and §3.3a args
fixtures (checkpoint defaults, meta, images, MCP configs).

**`workflow-engine/test/isolation.test.ts` (new — the contract's core).** Mock-runner
record → replay, one case per rule:
- **[r5 B1]** the two-upstream/one-image-target regression verbatim: mock settles B
  before A when recording; replay flips order; target dies `target-inputs-drift`
  BEFORE any live delegation (inner runner never invoked for it).
- **[r6 B1]** the dynamic-`label` counterexample verbatim (racing upstream calls,
  `label: first` on the target; recording settles B first, replay serves A first) →
  `target-inputs-drift` BEFORE any live delegation; dynamic per-call `retries`
  likewise; a drifted approved-backends registry (same name, different config)
  likewise; a worktree-requesting target → `"worktree-target"` at preflight; live
  delegation cwd ≠ recorded `resolvedCwd` → `target-inputs-drift`; a
  journal-replay-origin row targeted → `"journal-replay-target"`.
- **[r6 B2]** a live target redirecting control flow into a ZERO-call `workflow()`
  child: `onNestedWorkflow` latches + aborts at invocation; with the callback
  disabled in the fixture, the `result.nestedWorkflows` finalize backstop still
  classifies `"diverged"`.
- **[r6 B3]** a sealed `onModelFallback` on the target → `candidate-fallback` latch,
  `observeAgentEnd` `outcome: "diverged"`, status `"diverged"`; a silent runner (no
  `modelResolved`) → `"completed"` WITH `candidateEvidence: "unverified"` +
  `report.unverifiedTargets`; a verified candidate → `"verified"`.
- **[r5 B2]** the maxAgents:1 caught-`AGENT_LIMIT_EXCEEDED` recording →
  `"agent-limit-boundary"`; missing `budgetDebit`/`settlementOrdinal` →
  `"no-budget-trajectory"`.
- **[r6 B4]** budget-trajectory replay: a `budget.spent()`-reading script replays
  with `spent()` EQUAL to the recording at every settlement-exposure point
  (estimate debits included); `phase(t, { budget })` and tokenBudget recordings
  whose gates FIRED and were caught replay the same gate at the same call; parallel
  settlement: a lower-ordinal debit pre-applies before a faster-settling
  higher-ordinal serve is exposed (apply-once pinned); replay forces
  `tokenBudget`/`maxAgents` to the recorded limits; recorded limits default
  concurrency/agentTimeoutMs/agentRetries (asserted at the engine boundary); the
  live target's OWN usage never reaches `shared.spent` (the recorded debit does).
- **[r5 B3]** a recording with an engine-origin row → `"engine-origin-row"`.
- Serving: exact serve; unique-path serve with `hashMatched: false`; each refusal —
  `ambiguous-path` (incl. the no-lens `verify()` shape → `"ambiguous-identity"` at
  preflight), `unrecorded-call`, `identity-reexecuted`, `target-site-reexecuted`,
  `dependent-or-drifted-target`, `nested-workflow-call`, `path-unavailable`; the
  latch: a catching script triggers ZERO further inner invocations (spend counter
  pinned).
- Outcome-faithful serves: recorded `null`; recorded workflow-error/plain-error/
  thrown-value reconstructions (`props` restored, `WorkflowError` fields intact);
  targeting a recorded failure runs live.
- Checkpoints: served replies for confirm/headless/journal-replay origins; recorded
  headless default served through the wrapper; durable-pause row replays as
  `CHECKPOINT_REQUIRED` with `checkpointContext`; checkpoint rows never targetable;
  **[r6 B9]** a confirm arrival with NO `CheckpointCallContext` → latched
  `checkpoint-context-unavailable` divergence (not `RECORDING_UNUSABLE`).
- Targets: XOR selector enforced; label resolution (unique/duplicate/absent);
  `"no-input-fingerprint"`; **[r5 B15]** `"unproven-baseline-model"` when the
  baseline row lacks `modelResolved` or has `modelFallback`, admitted with an
  explicit `target.model`; model override rewrite visible to inner; identity
  unchanged by override.
- Settlement/containment: target-failure → internal abort + `manager.stop` +
  `"target-failed"` with report row from SEALED event telemetry AND
  `IsolationRunResult.error` reconstructed exactly from the event's `errorRecord`
  (every `WorkflowError` field equal — r6 B8); **[r5 B8]** floated target
  (`Promise.race`) → `target-unsettled`, `"failed"`, internal abort fired;
  post-finalize `run()` arrivals throw misuse; **[r6 B9]** a foreign-scope arrival
  latches `nested-workflow-call` (typed divergence, NOT a misuse Error) and
  `report.calls` contains bound rows only.
- **[r6 B8]** phase-boundary matrix: lease failure and runId collision REJECT typed
  before start (never a `"failed"` status); a caller-signal abort CAUGHT by the
  script (which then completes) → `"failed"`, precedence over finalize findings; a
  throwing final report-`save` / missing artifact → status unchanged +
  `"report-persistence-failed"` note, promise resolves.
- **[r5 B14]** provenance: served rows carry `provenance.source "replay"` (with
  `recordedIndex`/`hashMatched`) and target rows `"live"` (+`overrideModel`) on the
  manager `agentEnd` events AND the persisted `agents[]`/`calls[]` rows;
  `replayReport` persisted on the artifact after the terminal save.
- Quarantine: artifact rejected as a baseline (`"isolation-artifact"`); a
  `"replayed-row"` recording (own-manager composition without the marker) rejected;
  resume of the artifact rejected.
- Lifecycle: runId collision re-mint; `journaling: false` leaves no durable state;
  two sequential `runIsolation` calls on one baseline share no mutable args; every
  pre-execution failure rejects (never throws synchronously) with a typed
  `WorkflowError`.
- Preflight matrix: one fixture per §4.9 reason literal, asserting code + reason +
  named indexes/fields; **[r6 B14]** the runtime gate rejects on EACH of
  node/v8/pathFormat/inputsFormat drift and passes on exact equality; the
  environment gate passes on equal git identity (clean and equally-dirty trees),
  rejects on HEAD or dirty-state drift, and requires/compares `environmentKey` for
  non-git recordings.

**`workflow-engine/test/fixtures/`** gains a pre-contract run file (old format):
loads, lists, and resumes unchanged; rejected as a baseline (`"incomplete-manifest"`
/ `"no-limits"`). **`run-persistence.test.ts`** extends for the §3.4 declared-spread
parity (every persisted agent key is declared — the honesty fix pinned).

**`workflows/test/sdk.test.ts` additions.** SDK `runIsolation`: defaults to
`createAcpRunner` and disposes it (owned-runner rule) — asserted through the NAMED
`__setDefaultRunnerFactoryForTests` seam (§4.10, r6 advisory 3);
`allowScriptBackends` approval path; re-export surface presence (types +
`createReplayRunner`).

**Type-compat pins (r6 advisory 5).** Explicit compile fixtures for the exact
surfaces the brief names: a minimal plain-object `AgentRunner`, `createAcpRunner`,
and the `validate.ts` mock each compile and run unchanged against the widened
`RunOptions`; a two-argument `confirm` compiles and runs (also exercised in
`call-identity`); optionality alone is never the only evidence.

**`workflows/test/isolation.live.e2e.test.ts` (new, gated).** The live smoke,
following `acp-agents/test/auth.live.e2e.test.ts`: runs only when
`AGENTPRISM_LIVE_E2E === "1"`; records a two-step workflow on the default backend,
isolates step 2 with a `model` override, asserts `"completed"`, a live-target report
row with sealed `resolvedModel`/usage, served row provenance, and artifact
quarantine.

**Docs drift.** A new engine-side drift test (same pattern as
`acp-agents/test/docs-drift.test.ts`) asserts `docs/api.md` documents every frozen
`RECORDING_UNUSABLE` reason literal and every `ReplayDivergenceEvent.kind` — imported
from the exported `RECORDING_UNUSABLE_REASONS` and `REPLAY_DIVERGENCE_KINDS` consts
(§6, r6 advisory 1; the test invents no surface) — and contains the §4.8
cost-surface sentence marker.

## 8. Docs & changeset plan

**`docs/api.md`** — new "Isolation mode" section:
- `runIsolation` (SDK + engine forms), `createReplayRunner` composition (incl. the
  MANDATORY `ExecOptions.executionMode` on the own-manager path), target selection
  (XOR, label vs callIndex, model override), the full refusal catalog: every
  `RECORDING_UNUSABLE` reason and divergence kind with one-line remedies (drift-
  tested, §7).
- The §4.6.4 disclosure VERBATIM: no-lens `verify()`/`judgePanel()`/identical-prompt
  fan-out recordings are wholly non-isolatable (`"ambiguous-identity"`); remedies:
  distinct `lens` values, distinct call sites, or propagation mode.
- The cost-surface sentence VERBATIM (opus r5 A6): "An isolation run's own per-call
  token figures (chars/4 estimates for served calls) are not comparable to a normal
  run's; the `ReplayReport` — `recordedUsage` vs `liveUsage` — is the only valid
  cost surface."
- Gap A/Gap B reference: the `RunOptions` identity fields, `onResultProvenance`,
  `WorkflowCallRecord`, `JournalEntry` additions, `PersistedRunState` additions, and
  the §5 public-type/internal-storage split.
- Model attribution on BOTH sides: baseline three-state (§4.4 — verified /
  unverified-refused / explicit override) and candidate evidence (§4.6.2 rule T —
  verified / `candidate-fallback` divergence / explicit `unverified` marks in
  `report.unverifiedTargets`).

**`packages/workflows/README.md`** (r5 advisory 4) — a short "Substitution testing
(isolation mode)" subsection: record a run, `runIsolation({ baselineRunId, live:
[{ label: "step-2", model: "..." }] })`, read the report; link to `docs/api.md`.

**`docs/design-notes.md`** — the load-bearing rationale, condensed from this spec:
call-path capture + honest stability boundary (§2.5), guarded terminal settlement
(§2.6), record-time freezing (§3.0), the serving algebra + strict fail-fast posture
(§4.6), budget-trajectory replay (§4.6.8) + limit/abort gate-freedom admissibility
(§4.9).

**`docs/roadmap/evals.md`** — status update: substrate contract frozen
(this spec); propagation mode available today; isolation mode implemented per this
contract; scoring/vitest-evals/report UX remain the next roadmap stage, consuming
`ReplayReport` + the manifest.

**Changesets** (one coordinated release train, the auth-spec precedent;
`updateInternalDependencies: "patch"` handles the rest):
- `@automatalabs/shared-types` **minor** — additive types/codes (§6).
- `@automatalabs/workflow-engine` **minor** — Gap A/B + isolation surface, with
  DISCLOSED behavior fixes named in the changeset body: (1) throwing terminal
  observers are now logged-and-swallowed, never retry/fail the call (§2.6);
  (2) agent results and checkpoint replies must be strict-JSON snapshots — lossy
  values now fail typed instead of persisting coerced (§3.0); (3) journal/event
  payloads are frozen snapshots — listener mutation no longer reaches persistence
  (§3.0); (4) for strict-JSON args, persisted `args` is the pre-execution snapshot
  on ALL THREE creation paths and the VM gets an independent clone (§3.3a);
  (5) post-terminal events from floated calls are dropped (§3.3a); (6) the vm
  compile filename is sanitized (§2.5); (7) sequential nested siblings get distinct
  child runIds — observable at the runner seam and in ACP session metadata (§2.3,
  r6 B12); (8) `agentEnd`/`agentHistory` snapshot rows match by
  `(scope, callIndex)`, fixing duplicate-label/nested mis-attribution (§3.3);
  (9) non-strict-JSON args still execute verbatim but are marked `argsUnreplayable`
  and refused as baselines — never rejected at run time (§3.3a, r6 B6);
  (10) timed-out attempts are actively aborted via a per-attempt signal (§3.5,
  r6 B13); (11) run-id starts take the lease BEFORE the existence check, closing
  the cross-process overwrite race (§4.8, r6 B10). This enumeration is COMPLETE
  (r6 advisory 4): every behavior change ships named in the changeset body.
- `@automatalabs/workflows` **minor** — SDK `runIsolation` + re-exports.
- No changeset for `acp-agents`/`mcp-server`/`agentprism-otel` (no changes).

## 9. Implementation order

Five PRs, sequential, each green (`pnpm test` across the workspace) with the journal
hash pin unmodified throughout; no PR ships a stub for a later one (no-deferred-work
rule — each PR's surface is complete for what it declares):

1. **PR1 — shared-types.** Every §6 type/code/doc addition. Pure types + enum; no
   behavior. Tests: compile + `errors.test.ts` additions.
2. **PR2 — engine Gap A.** Identity threading, call-path capture + `sanitizeVmName`,
   `hashCallInputs`, `nestedSeq` ordinal, `CheckpointCallContext`. Tests:
   `call-identity`, `call-path`, `input-fingerprint`.
3. **PR3 — engine settlement + Gap B.** §2.6 guarded settlement, §3.5 attempt
   slots/seal, §3.0 freezing/validation, `onCallRecord` + manifest, §3.3 events +
   row-matching, §3.3a manager fixes (args/effectiveCwd/runtime/limits/markers/
   post-terminal drop/collision guard/scope filter), §3.6 resume seeding. Tests:
   `call-manifest`, `settlement`, `frozen-snapshot`, `manager-state`,
   `run-persistence` additions, old-file fixture.
4. **PR4 — isolation.** `isolation.ts` complete (preflight, wrapper, harness,
   report, reconstruction, reason consts) + engine index exports. Tests:
   `isolation.test.ts` + preflight matrix.
5. **PR5 — SDK + docs + release.** SDK surface, README, `docs/api.md`/
   `design-notes.md`/roadmap update, drift test, live smoke, the three changesets.

Rollout note: PR3's disclosed behavior fixes land before any isolation consumer
exists, so recordings made from PR3 onward are admissible baselines; older
recordings are structurally refused (§4.9) — no migration tooling is built (§10).

## 10. Considered and rejected — terse dispositions

**Round-5 blocking findings — where each is resolved (all accepted; none rebutted):**

| Finding | Resolution |
|---|---|
| sol B1 (unhashed target-input drift) | §2.7 input fingerprint; §4.6.2 rule 3 `target-inputs-drift`; regression pinned §7 |
| sol B2 (pre-allocation gates invisible) | §3.2 `effectiveLimits`/`abortSignaled`/`callsAllocated`; §4.9 check 6 limit/abort gate-freedom proof; budget gates reproduce via §4.6.8 (r6 B4) |
| sol B3 (engine-origin rows ignored) | §4.9 `"engine-origin-row"` rejects the recording; §4.6.6 visits EVERY row |
| sol B4 (exec/budget state unreproduced) | limits record all five resolved inputs (§3.2/§3.3a); §4.3 recorded defaults; budget trajectory replayed (§4.6.8, per r6 B4) |
| sol B5 (sibling scope reuse) | §2.3 `nestedSeq` ordinal; pinned §7 |
| sol B6 (onAgentEnd not exactly-once) | §2.6 guarded terminal-transition settlement; `ReplayObservation` as the concrete harness signal (§4.3) |
| sol B7 (wrapper-sealed telemetry impossible) | §3.5 engine-sealed slots → terminal event (§3.3); wrapper intercepts nothing (§4.5) |
| sol B8 (floated target uncontained) | internal AbortController + `stop()` (§4.3 steps 5–6); post-terminal drop (§3.3a); §4.12 item 4 (ACP honors abort; third-party residual) |
| sol B9 (lossy/mutable snapshots) | §3.0 strict-validate + deep-freeze; checkpoint reply failure contract |
| sol B10 / opus B1 (args) | `snapshotArgs` at ALL THREE creation sites + clone-to-VM (§3.3a; marker semantics per r6 B6); no-args passthrough; tests §7 |
| sol B11 (call-path algorithm/gate) | explicit `isAsync()` exclusion; runtime preflight gate (§2.5, §4.9 check 8 — tightened to exact equality by r6 B14) |
| sol B12 (vm escape vs lemma) | §4.6.1 honest boundary; trusted-script precondition (§4.12 item 2 — the same precondition journal resume imposes today) |
| sol B13 (type/preflight gaps) | `mainModel`/`agentsDir` declared (§3.3a); `message` required for reconstruction (§3.2a/§4.9 check 1); JSON projection IS the recording (§4.3); synthetic entry fully specified (§3.1) |
| sol B14 (no served/live provenance) | `onResultProvenance` → sealed marker on events + manifest + agents rows (§3.3); persisted `replayReport` (§4.2) |
| sol B15 (baseline model unproven) | positive-evidence rule + three-state attribution (§4.4); hash proves REQUESTED spec only (§0/§4.5) |

Advisories: sol 1 → §4.4 XOR type; sol 2 → §4.9 frozen kebab-case literals; sol 3 →
`ReplayRunnerOptions.live: IsolationTarget[]` (§4.3); sol 4 → README (§8); sol 5 →
§5. opus A1 → `ReplayObservation`; A2 → §4.6.4 prominent disclosure + §8; A3 → §4.7
defensive rationale; A4 → `target-unsettled` typed `REPLAY_DIVERGENCE` (§4.6.6);
A5 → citations corrected; A6 → §8 verbatim sentence + drift marker.

**Round-6 blocking findings — where each is resolved (all 14 ACCEPTED by the design
owner; B4/B14 per the owner's glosses):**

| Finding | Resolution |
|---|---|
| B1 (fingerprint gaps; cwd unobserved) | §2.7 widened fingerprint + backends digest + `resolvedCwd`; §4.4 worktree/journal-replay target rejection; §4.6.2 rule 3 cwd equality |
| B2 (zero-call nested child) | §2.3 `onNestedWorkflow` + §4.3 step 6 `nestedWorkflows` backstop |
| B3 (fallback = completed) | §4.6.2 rule T: `candidate-fallback` divergence; `unverified` marks |
| B4 (budget recordings rejected) | §4.6.8 trajectory replay (owner overrule); §4.9 check 6 exclusions removed; residual = §4.12 item 5 |
| B5 (strict-JSON vs vm realm) | §3.2a realm-neutral qualifier + vm fixtures (§7) |
| B6 (args breaking/timing) | §3.3a `snapshotArgs` + `argsUnreplayable` marker; per-API timing (§4.8) |
| B7 (manifest vs observers) | §3.2 engine-owned append before delivery → `WorkflowRunResult.calls`; §2.2 rule 1 |
| B8 (runIsolation error semantics) | §4.3 phase boundary, abort precedence, step-7 rule, `errorRecord` |
| B9 (unrepresentable branches) | typed foreign scope; `checkpoint-context-unavailable`; bound-rows-only report |
| B10 (runId TOCTOU) | §4.8 lease-first guard; race pinned (§7) |
| B11 (provenance contradiction) | §4.8 corrected; `observeAgentEnd` = settlement/aggregation only |
| B12 (misstated code claims) | §2.4/§4.7 checkpoint-hash coverage; §3.2 normalized retries; §2.8/§8 nested-id disclosure |
| B13 (timed-out attempts floated) | §3.5 per-attempt abort; §4.12 item 4 residual |
| B14 (environment/V8 as assertions) | §3.3a `environment` + full `runtime`; §4.9 checks 8/9 preflight equality; old §4.12 items 5–6 removed |

r6 advisories: 1 → exported `RECORDING_UNUSABLE_REASONS`/`REPLAY_DIVERGENCE_KINDS`
(§6); 2 → §3.5 snapshot-at-receipt + validation; 3 → the named
`__setDefaultRunnerFactoryForTests` seam (§4.10); 4 → the complete §8 enumeration;
5 → §7 type-compat pins.

**Rejected alternatives (standing; with the round that killed them):**

- **Budget-trajectory seeding — REJECTION OVERRULED (r6 B4, owner adjudication).**
  The r6-draft refusal conflated per-call usage seeding with ordinal-ordered debit
  replay. The shipping build (§4.6.8) persists the ACTUAL charged `budgetDebit` +
  `settlementOrdinal` and applies debits through an apply-once ordinal cursor BEFORE
  each settlement is exposed, so `spent()` equals the recording at every exposure
  point; only the concurrent-read race remains (§4.12 item 5). Kept as the
  disposition record — the former rejection no longer states the contract.
- **Settlement rides a new `onCallSettled` hook** (directive-3(f) shape). §2.6 makes
  the terminal transition exactly-once with `onCallRecord` FIRST; the manager's
  `agentEnd` re-emission is the harness channel because it alone carries the frozen
  result snapshot. A second settlement callback would duplicate the transition
  without adding a fact.
- **Pre-allocation invocation trace** (r5 B2's channel): cannot ride the pinned
  journal index space; a second trace channel re-creates the completeness problem
  one level down. Gate-freedom proof instead.
- **Settlement-order recording/replay** (r5 B1's alternative): order is
  microtask-level, script-visible, not an engine-controlled input; recording it
  would promise reproduction the engine cannot deliver. Fingerprint guard + §4.12
  item 1 instead. (Budget-trajectory replay needs no order reproduction — the
  ordinal cursor reproduces VALUES at exposure points, §4.6.8.)
- **Engine-side served/live classification** (rounds 3–4): the engine cannot know
  what a wrapper served; provenance is therefore RUNNER-reported through a generic
  callback and engine-sealed (§3.3) — reporting, not engine inference.
- **Epoch/generation counters at the seam; wrapper-side retry classification;
  positional/index pairing; per-occurrence counting** (rounds 3–5): each was shown
  to guess under concurrency; §4.6 keeps only provable correspondence.
- **`DivergencePolicy`/serve-with-flag/lenient modes; `onDivergence`** (directive 1):
  one strict policy (§4.6.5); flags-that-permit-wrong-serves are not a mode.
- **Duplicate-identity admission with explicit `callIndex` pairing** (directive 1
  considered it): refused entirely — §4.9 `"ambiguous-identity"`; over-conservative
  by design (opus A2 notes the all-served-safe subcase; future work, out of scope).
- **Engine-level model-override map** (`ExecOptions.modelOverrides`): a second
  permanently-public model-resolution input entangled with `hashAgentCall`;
  wrapper-side rewrite after hashing instead (§4.5).
- **New `@automatalabs/agentprism-evals` package now**: two functions do not justify
  the new-package release flow; the evals package arrives with scoring and consumes
  these exports (§4.1).
- **N-sample repetition in `runIsolation`**: the eval harness loops it; per-invocation
  args cloning makes that safe (§4.11).
- **`JournalEntry` hash-input extension** (any round): the byte layout is pinned;
  every new fact rides new optional fields or the manifest.
- **Static control-flow analysis of scripts** (loops/branches pre-detection):
  rejected in every form — no AST probe survives in this contract (the r6-draft
  budget probe was removed with r6 B4); general control-flow prediction is
  undecidable and the runtime rules already fail closed.
- **Migration tooling for old recordings**: old files stay loadable/resumable; they
  can never become admissible baselines because the facts (manifest, limits,
  fingerprints, paths) were not captured — re-record (§3.7, §9).
- **In-memory recording overload on `runIsolation`**: one code path via persistence;
  in-memory composition exists through `createReplayRunner`'s normalized copy
  (§4.3).

