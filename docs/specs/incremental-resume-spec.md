# Content-addressed Incremental Resume

> **Superseded in part (updated 2026-09-01):** The filesystem-purity, safety-marker, terminal-environment,
> cache-closing, headless-checkpoint, crash-residue, and aborted-source gates in this historical specification are
> no longer the product contract. See the current
> [journal replay contract](journal-replay-contract.md). Identity/fingerprint and journal-integrity
> sections remain useful implementation history.
>
> **SDK-only replay surface (updated 2026-09-02):** every model-facing MCP replay/fork clause in
> this historical design is superseded by [same-run MCP continuation](workflow-resume-action.md).
> The SDK `resumeFromRunId`/`resumePolicy` APIs described here remain available to embedding hosts;
> the MCP schema neither advertises nor accepts them.

**Date:** 2026-07-15

**References:** `packages/workflow-engine/src/workflow.ts`;
`packages/workflow-engine/src/workflow-manager.ts`;
`packages/workflow-engine/src/isolation.ts`;
`packages/workflow-engine/src/run-persistence.ts`;
`packages/workflow-engine/src/run-environment.ts`;
`packages/workflow-engine/src/worktree.ts`;
`packages/shared-types/src/agent-run.ts`;
`packages/shared-types/src/workflow-result.ts`;
`packages/workflows/src/dsl.d.ts`;
`packages/mcp-server/src/server.ts`;
`packages/mcp-server/src/workflow-tool-input.ts`;
`skills/agentprism-workflow-authoring/reference.md`;
`docs/specs/evals-isolation-spec.md`;
`docs/roadmap/incremental-resume.md`

## 1. Problem

The original SDK resume path was positional. `WorkflowManager` hydrates a
`Map<number, JournalEntry>`, and `runWorkflow()` serves an entry only when its hash matches the
call at that index and the index is less than the run-wide `firstMiss`. The first changed, missing,
new, or empty cached agent result lowers `firstMiss`; that call and every later call run live.
Checkpoints use the same gate. `callSeq` assignment itself is deterministic and is not the problem:
it is a single monotonic sequence assigned in the synchronous prefix of
`agent()`/`checkpoint()`, before
the concurrency limiter.

The global cursor wastes unaffected work. In a 40-item fan-out, changing two item prompts should
not force the other 38 calls live merely because their indexes are greater than the first changed
item. Workflow data flow is normally already content-addressed: scripts interpolate upstream
results into downstream prompts, and prompts are part of `hashAgentCall()`. A downstream call whose
script-visible upstream value changed therefore gets a different hash and misses; a sibling whose
prompt and execution inputs are unchanged can reuse its result independent of index.

The existing substrate is sufficient to identify that correspondence without changing call-hash
bytes:

- engine-to-runner `RunOptions` already carries `callIndex`, `callHash`, `callPath`, and
  `callInputsHash`; these are diagnostics/correlation fields and deliberately do not recursively
  become hash inputs;
- `WorkflowCallRecord` records `kind`, `hash`, structural `path`, the agent's unhashed execution
  `inputsHash`, outcome, origin, usage, settlement order, worktree outcome, and scope;
- `JournalEntry` records the frozen result, optional session record, usage, and diagnostics;
- `PersistedRunState` records the script, args, effective cwd, runtime/path/input format, and the
  run-creation environment identity;
- isolation's `ReplayRunner` already indexes rows by
  `kind + "\u0000" + path + "\u0000" + hash`, rejects ambiguity, preserves deterministic
  settlement order, and reports typed correspondence decisions.

Naive hash matching is nevertheless unsound for ordinary coding agents. File flow is invisible to
the prompt hash. If a changed upstream agent runs live and writes different files, an unchanged
downstream prompt could otherwise receive a stale cached result. In the opposite direction, a
replayed upstream result does not recreate its file writes, so a later live call could see a tree
missing artifacts that existed in the recorded run. The journal cannot repair either case: it does
not contain verbatim prompts/options or a filesystem patch.

This contract therefore adopts a staged, fail-to-live v1:

1. identity matching is the automatic default for recordings made entirely from proven host
   checkpoint decisions and author-declared replay-safe agents; a worktree-writing agent qualifies
   only when the same declaration is present and the engine actually created its throwaway
   worktree;
2. valid new-format recordings containing any other agent use a positional **safe-prefix** policy:
   only leading safety-marked calls may replay, and the first unproved agent forces the suffix live;
3. every non-legacy new-format replay requires a terminal working-environment admission gate
   before either policy may serve a result;
4. while identity matching is active, a new filesystem-unsafe live call, live host checkpoint, or
   nested workflow closes the entire replay cache for the remainder of that execution;
5. doubt about identity correspondence runs that call live; source-wide safety doubt selects the
   positional fallback; structural or environment doubt disables all replay.

This deliberately gives declared read-only/worktree-local fan-outs the 38-of-40 win without
asserting that an arbitrary coding agent is pure. Authors do not have to opt the run into the new
policy; they signal each call's safety with one explicit annotation. Worktree isolation by itself is
not a purity assertion: it confines ordinary checkout edits, but not network, ignored-file,
out-of-tree, shared-`.git`, or ambient effects. Unannotated new-format workflows select the
positional strategy but replay no unsafe writer; legacy journals alone keep the historical hash-only
prefix as a compatibility exception.

## 2. The contract

### 2.1 Verified baseline and invariants

The implementation preserves these named invariants:

1. **Fail-to-live.** A mainline matcher never serves a row whose correspondence or filesystem
   eligibility is uncertain. A miss costs execution; it never returns a guessed value.
2. **Unchanged hash bytes.** `hashAgentCall()` continues to hash, in its existing serialization,
   prompt, resolved model, `mode` only when set, sorted non-empty `configOptions`, tier, phase,
   agentType, resolved agent definition, and schema. `hashCheckpoint()` continues to hash
   prompt text, normalized kind, and choices. The additive checkpoint-options fingerprint in
   §2.7 is not a call-hash input. The pinned hash fixtures do not change.
3. **Args remain indirect.** Source and current `args` are never compared. An args change misses
   only when it changes call reachability, a call hash, or the unhashed input fingerprint.
4. **Stable numbering.** `callSeq` remains in the synchronous prefix before any resume-decision
   wait or limiter delegation. Identity correspondence never uses current index as its primary key.
5. **No stale downstream serve after unsafe live work.** Once the identity execution reaches an
   unproved persistent-tree live call, nested workflow, or live host checkpoint callback, every
   later agent and checkpoint call runs live. Cached/injected checkpoint decisions are invalidated
   too: a human may have based a same-prompt decision on files changed by the live work. Recorded
   headless outcomes are never candidates because `default`/`headless`/`timeoutMs` are not
   checkpoint-hash inputs; absent a matching proven-host decision/injection, the current headless
   branch executes fresh.
6. **Self-contained resume hops.** A new managed run durably stores its prepared resume seed before
   a background start is acknowledged, and every replay is re-journaled under the current index.
7. **Isolation stability.** `runIsolation`, `ReplayRunner`, `ReplayReport`, their preflight reason
   arrays, target semantics, nested-workflow exclusion, and strict divergence behavior do not
   change.
8. **Quiescent terminal identity.** A new-format source records a terminal environment only when
   every allocated agent/checkpoint/nested invocation, every worktree cleanup, and every underlying
   runner promise (including a signal-ignoring cancellation loser) has actually settled. A terminal script result alone
   never certifies filesystem quiescence.

The current `firstMiss` field remains, but is consulted only by the positional strategy. The
identity strategy never lowers or reads it.

### 2.2 Authoring safety declaration

Add one optional engine/DSL field to `AgentOptions` in
`packages/workflow-engine/src/workflow.ts` and `packages/workflows/src/dsl.d.ts`:

```ts
export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  // existing fields unchanged

  /** Contractual opt-in for content-addressed mainline replay. The call may read the
   *  admitted workspace, but must not create, modify, or delete persistent state visible
   *  to another workflow call. When isolation:"worktree" is requested, ordinary file
   *  edits inside a successfully-created throwaway checkout are permitted; commits and
   *  every effect outside that checkout remain forbidden. Its result must depend only on
   *  the admitted workspace, hashAgentCall inputs, and hashCallInputs inputs. */
  resume?: { filesystem: "read-only" };
}
```

This is a semantic assertion by the workflow author, not a backend mode. It is stronger than
"usually does not edit":

- a non-worktree call must not write/commit in the run cwd; a worktree call may edit only the
  successfully-created checkout and must not commit or deliberately mutate the shared repository;
  neither class may write an ignored/out-of-tree artifact used by a later call or perform an
  external mutation whose repetition is required for correctness;
- ambient external data not represented by the admitted environment or call inputs must not be a
  load-bearing result dependency;
- a call must not race a concurrently launched workflow primitive that can mutate any persistent
  or ambient resource the call reads. Filesystem-mediated dependencies must be sequenced by script
  control flow (`await`/pipeline), not communicated between unordered `parallel()` siblings;
- `mode: "plan"`/`"read-only"`, tool allowlists, labels, and prose instructions do not imply this
  assertion. The engine cannot prove what a third-party runner did;
- a false assertion is author error and outside the replay guarantee, like a runner that lies in
  its telemetry.

When present at runtime, `resume` must be a non-null object whose prototype is `null` or that VM
realm's `Object.prototype`. `Reflect.ownKeys()` must return only `"filesystem"`, and its own property
descriptor must be an enumerable data property with value `"read-only"`. Arrays, accessors,
symbols, inherited/extra keys, and every other value throw non-recoverable
`SCRIPT_VALIDATION_ERROR` before call identity/index allocation or runner delegation.

The option is engine-owned and is not passed to `AgentRunner`. It is neither a call-identity hash
input nor a `hashCallInputs()` input: it changes replay authorization, not agent execution. Thus
`hashAgentCall()` bytes, `hashCallInputs()` bytes, and `CALL_INPUTS_FORMAT = 1` remain unchanged.
Every new identity-adjacent persisted field below is optional and omitted when unset. Merely adding
the annotation to a later script cannot bless an old cached result: source eligibility and current
safety agreement both require the recorded manifest marker below.

`WorkflowCallRecord` gains one optional field:

```ts
export type WorkflowResumeSafety =
  | "declared-read-only"
  | "isolated-worktree";

export interface WorkflowCallRecord {
  // existing fields unchanged

  /** Why this agent occurrence is safe for content-addressed mainline resume.
   *  "declared-read-only" reflects the authored assertion at allocation.
   *  "isolated-worktree" is written only after createWorktree() returned
   *  isolated:true. Absent for checkpoints and every unproved agent call. */
  resumeSafety?: WorkflowResumeSafety;
}
```

Rules:

- `resume: { filesystem: "read-only" }` on a call that does not request worktree isolation records
  `"declared-read-only"` on result and non-result rows. Non-result rows never replay, but their
  marker allows them to participate as safe identity blockers.
- A call resolved to `isolation: "worktree"` records `"isolated-worktree"` only when the same
  `resume` declaration is present, the manifest already records `worktree: true`, and the worktree
  was derived from the run's admitted `effectiveCwd` (a per-agent `cwd` is absent). An unannotated,
  pre-isolation interruption, degraded, or external-base worktree records no safety marker.
- A journal-replayed call carries the selected source row's safety marker only when the current
  authored inputs still assert the same safety class.
- Checkpoint journal rows need no filesystem marker. Proven host-decision replays and injections
  invoke no host code; engine-headless decisions run fresh but do not taint the workspace. Live
  host callbacks are covered by the barrier in §2.9.

Persisted-marker validation is exact. Checkpoint rows must omit `resumeSafety`.
`"declared-read-only"` requires an agent row whose resolved `isolation` is absent.
`"isolated-worktree"` requires `isolation: "worktree"` and either (a) an origin-`"runner"` row
with `worktree: true`, or (b) an origin-`"journal-replay"` row with mainline `replay` provenance
whose `sourceResumeSafety` exactly equals the row marker. Every journal-replayed agent result in a
non-legacy v1 source requires that provenance, marker, and equality; this is the self-contained
proof that the consumed source marker was propagated. Manual journals are permanently legacy and
cannot manufacture an identity-eligible hop. Engine/confirm/
headless rows cannot carry `"isolated-worktree"`. A violated combination is malformed source
metadata (`"manifest-invalid"`), not an unsafe marker silently treated as valid.

**What each safety class actually proves, and the non-contiguous-replay precondition.** Identity
matching (§2.7) replays safe calls out of order: a changed sibling can run live while a later,
lower-cost sibling with an unchanged prompt replays. Both safety classes must therefore hold under
that interleaving, not merely under a contiguous prefix. `"declared-read-only"` covers it directly:
the assertion above forbids every out-of-model side channel (ignored/out-of-tree artifact, external
mutation, ambient dependency), so a live read-only call cannot alter anything a replayed sibling
observed. `"isolated-worktree"` combines that same explicit assertion with an engine observation.
`createWorktree()` confines only ordinary checkout file writes: the call's edits land in a
throwaway checkout and are never merged into the admitted tree. Best-effort cleanup is awaited,
and the declaration forbids another call from relying on a leftover checkout if cleanup cannot
remove it. Worktree isolation does not confine commits or deliberate writes to the
shared `.git` store, ignored or out-of-`effectiveCwd` paths, the network, or ambient process/OS
state. The required `resume` declaration expressly forbids those channels from being load-bearing.
A live changed sibling may therefore edit its private checkout but cannot perturb anything a
replayed sibling was allowed to observe. Merely choosing `isolation: "worktree"` makes no such
promise and never enables non-contiguous replay. A false declaration remains author error, exactly
like a false read-only declaration on a non-worktree call; the engine does not silently infer purity
from an isolation request.

### 2.3 Persisted format and terminal environment

`PersistedRunState` gains additive resume metadata. The format marker is the detection mechanism;
absence means the historical positional format.

```ts
/** Existing engine type; identity-v1 admission requires exactly one populated arm. */
export type RunEnvironmentIdentity = {
  git?: { head: string; dirtyDigest: string };
  key?: string;
};

export interface PersistedResumeFormat {
  format: "identity-v1";
  /** Captured only after the script has settled AND resume activity is zero, immediately
   *  before the terminal save. Absent from a crash snapshot, a non-quiescent terminal
   *  run, and an unsafe non-git execution whose static host key cannot recapture state. */
  terminalEnvironment?: RunEnvironmentIdentity;
}

export interface PersistedRunState {
  // existing fields unchanged
  resume?: PersistedResumeFormat;
  resumeSeed?: PersistedResumeSeed;
  resumeReport?: WorkflowResumeReport;
}
```

The existing `runtime` identity gains one optional format discriminator, and the engine exports
the pinned value beside `CALL_PATH_FORMAT`/`CALL_INPUTS_FORMAT`:

```ts
export const CHECKPOINT_INPUTS_FORMAT = 1;

export interface PersistedRunState {
  runtime?: {
    node: string;
    v8: string;
    pathFormat: number;
    inputsFormat: number;             // existing agent-input format
    checkpointInputsFormat?: number; // NEW; required by identity-v1
  };
}
```

This does not bump or reinterpret `CALL_INPUTS_FORMAT = 1`: isolation and existing agent input
fingerprints retain exactly their current bytes. Old recordings omit the new field and remain
legacy positional sources. Every run carrying `resume.format: "identity-v1"` writes
`checkpointInputsFormat: CHECKPOINT_INPUTS_FORMAT`; the v1 admission gate requires exact equality.
Isolation's existing runtime preflight continues to inspect only its current four fields and does
not acquire a new rejection condition.

`"identity-v1"` names this entire persisted seed/admission contract, not merely the lookup key.
An incompatible required-field, normalization, or serving-semantics change writes a new literal;
new engines keep the v1 reader or fail it live, and never reinterpret v1 bytes under new rules.

Every newly created journaling-enabled managed run writes `{ format: "identity-v1" }` and
`callsAllocated: 0` in its initial save. The engine
also calls a new manager-owned `WorkflowRunOptions.onResumeFilesystemTainted?: () => void`
synchronously before any unannotated live agent (including a successfully isolated worktree), an
annotated worktree that degrades/uses an external base, a nested workflow, or a live host checkpoint
callback can run. A declared non-worktree reader and an annotated, successfully created worktree do
not taint. This observer only latches `true` and is not passed to workflow code or agent runners.

**Quiescence accounting (normative).** The engine owns one root-execution activity counter in the
shared runtime and reports its absolute value through the manager-only
`WorkflowRunOptions.onResumeActivity?: (active: number) => void` hook (§2.6):

1. Increment one logical unit after every `agent()`/`checkpoint()` index allocation and on entry to
   every `workflow()` invocation, before any matcher decision, callback, worktree operation, or
   child code. Decrement it only after that primitive's returned promise has settled; for a live
   agent this is after its limiter thunk and `removeWorktree()` `finally` have settled. To preserve
   promise timing, the engine attaches a non-throwing fulfillment/rejection observer to the exact
   limiter promise **before** returning it and decrements there; it does not add `return await` or a
   replacement promise. Registration order makes the decrement reaction run before the script's
   continuation can make the root run terminal.
2. Increment a second unit immediately before each underlying `AgentRunner.run()` invocation and
   attach non-throwing decrement handlers to the **raw runner promise** before passing that original
   promise unchanged into the targeted-cancellation race. Cancellation, retry classification, or an
   attempt-slot seal does not decrement that unit; only fulfillment/rejection of the raw promise
   does. If a structurally valid runner nevertheless throws synchronously instead of returning a
   promise, the invocation catch decrements the unit before classifying that throw. Thus a
   signal-ignoring cancellation loser keeps the source non-quiescent.
3. Separately, after each root-scope agent/checkpoint index allocation, call the manager-only
   `onResumeCallAllocated(callIndex + 1)` hook from §2.6. It must report `1, 2, ...` monotonically;
   nested engines clear this hook because child indexes/scopes are not in the root manifest. This
   gives paused/failed runs an authoritative allocation count even when `runWorkflow()` throws
   before returning its ordinary result.
4. The activity counter is root-wide and inherited by nested workflows. It never goes negative;
   a counter or allocation-sequence violation is an engine invariant failure and the manager omits
   `terminalEnvironment`.
5. The manager initializes both observed values to zero before execution. A late decrement after the
   manager has made a terminal decision may update in-memory diagnostics but never retroactively
   adds a terminal identity. Re-record or complete another run to obtain a replayable source.

On `completed`, `paused`, `failed`, or `aborted`, the manager calls the existing
`captureRunEnvironment(effectiveCwd, environmentKey)` after `runWorkflow()` has settled (or thrown)
**only when the observed activity count is zero**. A returned `git` arm is stored as
`terminalEnvironment` whether or not the taint latch fired, because it is a fresh measurement. A
returned `key` arm is stored only if the latch is false: today's string `environmentKey` is a host
assertion captured before execution, not a post-run callback, so it cannot identify terminal state
after unproved writes. Non-zero activity, an invalid counter transition, capture failure, or the
unsafe-key case omits terminal environment and makes future new-format resume all-live. The existing
`environment` field keeps its run-creation meaning; isolation continues to compare that field and
ignores `resume.terminalEnvironment`.

Environment values are well formed only when exactly one arm is populated. Two values are equal
only when they use the same arm and all strings in that arm are byte-equal; a `git` value never
equals a `key` value. For git workspaces, equality therefore means equal HEAD and equal dirty
digest under the existing algorithm (porcelain-v2 status bytes plus contents of every
modified/deleted/untracked path it reports). For
non-git workspaces, `environmentKey` is an embedder assertion and must content-address every
persistent resource replay-safe calls may observe. It can admit only an untainted terminal run;
unsafe non-git positional recordings fail live. Absence of either measured git identity or a host
key disables new-format replay. The exact `effectiveCwd` string must also match; equal repository
content at a different path is not sufficient because cwd is runner-visible.

The quiescent terminal capture closes the missing-side-effect hole for the engine's modeled
workspace: the current git-visible workspace must have the source run's terminal identity, and no
engine-known operation may still change it, before a new-format cached call is served. An unsafe
writer itself is never served by a new-format policy. The contract does not
claim that git's dirty digest covers ignored files or
paths outside the repository, nor contents behind a symlink or inside a nested repository/submodule
that porcelain reports only as a directory/gitlink state. Marker-less/`legacyResume` positional
fallback retains the historical same-cwd assumption for those unmodeled paths. New-format
identity/safe-prefix serving never treats the digest as proof for them: the
`resume: { filesystem: "read-only" }` assertion expressly forbids such communication, and an
unannotated call runs in the live suffix. In a non-git
workspace, the host `environmentKey` is the complete modeled identity.

Environment equality is a pair of snapshots, not a workspace lock. A host that intends a run to be
a future identity-v1 source must serialize other writers to `effectiveCwd` from the run-creation
capture through the terminal capture; otherwise a reader could observe transient bytes that were
restored before the final digest. The host must likewise serialize from resume admission through
the new run's terminal capture. For a non-git `environmentKey`, the exclusion covers every
persistent resource that key summarizes, for the same two intervals; because v1 has no terminal
key callback, the host is asserting that the static key remained valid throughout. The existing
run-ID lease does not lock a directory or any external resource shared by different run IDs. A host
that cannot provide both exclusions must start without
`resumeFromRunId` and must not later use the run as an identity-v1 source. This is the same
external-concurrency boundary as isolation's environment preflight, not permission to serve after
observed drift.

### 2.4 Public execution options and rollout

Add to `ExecOptions` and the SDK's corresponding execution option type:

```ts
/** Lives in shared-types because WorkflowResumeReport also references it. */
export type ResumePolicy = "auto" | "positional";

export interface ExecOptions {
  // existing fields unchanged

  /** Load this persisted run as the source for a NEW execution. Mutually exclusive with
   *  resumeJournal. The manager, not the host, prepares and persists the seed. */
  resumeFromRunId?: string;
  /** Default "auto". "positional" requests the historical index/prefix matcher. */
  resumePolicy?: ResumePolicy;
}
```

`resumeJournal` remains supported for low-level embedders and always means the legacy positional
algorithm. It is mutually exclusive with both `resumeFromRunId` and `resumePolicy`.
`resumePolicy` requires `resumeFromRunId`. Any invalid combination throws non-recoverable
`SCRIPT_VALIDATION_ERROR` before a run is created. `resumeFromRunId` also requires effective
`journaling: true`, and a caller-minted new `runId` must differ from the source ID; the seed cannot
be delegated to host-owned transcript storage. A nonexistent
`resumeFromRunId` throws non-recoverable `PERSISTENCE_ERROR`; it no longer silently starts with an
empty cache.

Validation performs no coercion: `resumeFromRunId` must be a string with `length > 0` (not
trimmed), and `resumePolicy`, when present, must equal one of the two literals. Omission normalizes
to `"auto"` before report/seed construction. On the new-run APIs, `checkpointReplies` requires
`resumeFromRunId`; the same field remains valid without it only on the distinct same-ID
`WorkflowManager.resume()`/`resumeInBackground()` APIs.

The existing `WorkflowManager.resume(runId, exec)` is a same-run recovery API, not the new-run
`resumeFromRunId` operation. It retains positional replay and source-index checkpoint replies in
v1, accepts neither new option, emits no `WorkflowResumeReport`, and sets `legacyResume: true`
before execution. That permanent bit is written through the throwing persistence path before a
same-ID run is re-registered or delegated; failure releases its lease and raises non-recoverable
`PERSISTENCE_ERROR`. A managed run started with a caller-authored `resumeJournal` durably writes the
same bit in its critical initial save. These
marks are permanent: neither positional path applies v1 admission/safety rules, so its results must
never be laundered into a later identity source. SDK hosts that want edited-script or non-contiguous
reuse start a new managed run with `resumeFromRunId`.

The MCP server deliberately exposes none of these fields or reports. Its `resume` action is the
strict same-ID continuation contract and uses a versioned canonical host admission instead.

The existing `WorkflowRunOptions.resumeFromRunId` remains informational at the bare-engine seam.
The manager now sets it to the **source** run ID (today it passes the new managed run's ID when a
journal exists); matching consumes `preparedResume`/`resumeJournal`, never that string.

Rollout is `"auto"` by default:

1. source `resume` absent: use legacy positional serving semantics, including no new environment
   requirement; replayed entries are only normalized into the new run's current scope (§2.6);
2. unknown present format: serve nothing (`strategy: "live"`, reason
   `"unsupported-format"`); never guess a future format;
3. known format plus source `legacyResume === true`: use legacy positional behavior even when a
   new engine wrote the marker on an earlier resume hop; this prevents format laundering;
4. source `resume.format === "identity-v1"`: run the admission algorithm in §2.5;
5. explicit `"positional"`: use the positional matcher, but a new-format source still must pass
   the cwd/runtime/terminal-environment gates. Legacy sources keep historical behavior because
   the required facts do not exist.

A manager-owned new run writes `legacyResume: true` when its source marker was absent or its source
already had `legacyResume: true`; a manual-`resumeJournal` run and every same-ID recovery write it
unconditionally. Terminal compaction never clears it. Unsafe/nested/forced positional fallback
prepared from a valid v1 source does not set the flag because that path did pass the v1 admission
and safety algorithm.

There is intentionally no `"force-identity"` option. Callers cannot bypass a safety gate.

### 2.5 Resume admission algorithm

The manager acquires the source run's existing cross-process lease before loading it, holds the
lease through validation, cloning, and the new target's critical initial save, then releases it in
a `finally` block before execution/acknowledgement. Failure to acquire the source lease is a
non-recoverable pre-run `PERSISTENCE_ERROR`, not a partially prepared live run. This is an
operational ownership failure, not a correspondence miss. The first admission failure otherwise
determines the run-level strategy and is reported; no live call has started.

The format checks in §2.4 run first; an unknown marker always selects live. Every other format then
passes the common terminal gate: aborted status/`abortSignaled` selects `"abort-residue"`, and any
other non-terminal status selects `"source-not-terminal"`; any `executionMode` selects
`"isolation-recording"`. After that gate, an absent marker, or a known marker with
`legacyResume: true`, never enters the remaining new-format structural validator; it selects
`"positional-v1"` with `eligibility: "legacy"` and
`"legacy-recording"`/`"legacy-resume"`. This is load-bearing for multi-hop resumes of journals
written before call manifests and scopes existed.

For a new-format source, validate in this order:

1. The common status gate above has passed.
2. `resume.terminalEnvironment`, `environment`, `effectiveCwd`, `runtime`, `journal`, `calls`, and
   `callsAllocated` are present and structurally valid for the fields consumed below.
3. Current and source `effectiveCwd` strings are equal.
4. Source runtime has exact equality with the current process for full Node version, full V8
   version, `CALL_PATH_FORMAT`, `CALL_INPUTS_FORMAT`, and `CHECKPOINT_INPUTS_FORMAT`.
5. The source terminal environment equals the environment captured at resume admission. The
   admission capture is `captureRunEnvironment(effectiveCwd, exec.environmentKey ?? manager.environmentKey)`
   — the identical call and key resolution the source used at run creation and §2.3 uses at terminal
   time — evaluated on the shared rule-3 `effectiveCwd` (never a per-agent or worktree path), while
   the source lease is held and before any current call runs. Equality is `environmentsEqual` under
   the §2.3 well-formed-arm rules: exactly one arm is populated on each side, a `git` arm never
   equals a `key` arm (so a git source resumed in a non-git tree, or the reverse, fails here), and a
   `key` source requires the current run to re-present the byte-identical `environmentKey`. An
   admission capture that yields no arm — a non-git tree with no supplied key — is
   `"environment-missing"`, never a silent pass; two populated but unequal arms are
   `"environment-mismatch"`.
6. `callsAllocated` is a non-negative safe integer, call-row indexes are exactly the dense set
   `0..callsAllocated - 1`, journal indexes are unique, and every entry/row scope exactly equals the
   source run ID. Every source journal entry has a non-negative safe-integer index, lowercase
   SHA-256 hash, an explicit `"agent" | "checkpoint"` kind, strict-JSON result, structurally valid
   optional session/usage, and exactly one call row at the same index with `outcome: "result"`,
   equal hash, and equal kind. Conversely, every `outcome: "result"` call row has exactly one such
   journal entry; the relation is a bijection. Stale/unpaired/unknown-kind entries or result rows
   make the new-format source malformed and are not served positionally. Non-result call rows need
   no journal pair.
7. Every agent result row has a non-empty NUL-free path and lowercase SHA-256 `inputsHash`. Its
   origin is `"runner"` or `"journal-replay"`; every other origin is invalid for an agent result.
   Every checkpoint result row has a non-empty NUL-free path, a lowercase SHA-256
   `inputsHash` produced by `hashCheckpointInputs()` (§2.7), and has an origin
   of `"confirm"`, `"headless"`, or `"journal-replay"`. Every present safety marker
   is a known literal consistent
   with the row's outcome/origin/worktree fields. `replay` is present exactly on non-legacy
   origin-`"journal-replay"` result rows and absent on every other origin/outcome. A present
   `replay` object must have a non-empty `sourceRunId`, non-negative safe
   `recordedIndex`, known `match`, and only correctly-typed optional fields;
   `sourceResumeSafety` is agent-only, checkpoint flags are checkpoint-only, and
   `checkpointInjected` implies `checkpointHostDecision`. An agent replay requires both agent
   fields and equality between `sourceResumeSafety` and `resumeSafety`; a checkpoint replay
   requires `checkpointHostDecision: true`. Frozen journal results retain the existing strict-JSON
   requirement.
   A checkpoint result pair is copied into the identity candidate set only when it is a proven host
   decision: source origin `"confirm"`, or origin `"journal-replay"` with
   `replay.checkpointHostDecision === true`. Headless result rows remain valid records but are not
   candidates because changing `default`, `headless`, or `timeoutMs` does not change
   `hashCheckpoint()`. A host-decision candidate is servable only when its checkpoint input
   fingerprint equals the current one. Safety is classified separately below so an otherwise-valid
   unsafe recording can take the positional fallback.
8. If `resumeSeed` is present, its format and immediate source ID are valid; every candidate has
   non-empty `sourceRunId`, matching non-negative safe `recordedIndex`/entry/call indexes, equal
   explicit kind/hash, `outcome: "result"`, entry/call scopes both exactly equal to
   `candidate.sourceRunId`, strict-JSON result/session/usage, and required path/input facts. An agent
   candidate has an admissible safety marker; a checkpoint candidate satisfies
   rule 7's host-decision origin/provenance proof, including its checkpoint `inputsHash`. Every
   injection has a non-empty source ID, non-negative safe `recordedIndex`, non-empty NUL-free path,
   lowercase SHA-256 hash, a lowercase SHA-256 `inputsHash`, and a strict-JSON decision. A call
   blocker carries a validated non-result terminal call with required path/input facts; agent
   blockers require an admissible safety marker, while checkpoint blockers are engine-aborted
   `WORKFLOW_ABORTED` rows. No two candidates/blockers/injections share
   `(sourceRunId, recordedIndex)`. This validator runs before flattening.

Outcomes:

- Any failure in rules 1–8 selects `strategy: "live"`. Fail-to-live takes priority over fallback.
- Before safety classification, prepare at most one `pendingInjection` under §2.12. Define
  `pendingRepresented` as true only when the source is paused for `checkpoint_required`, a supplied
  reply passed the row/context/uniqueness checks, and that resulting injection represents that
  exact non-result checkpoint row. Define `allCallsRepresented` as: every root call row has
  `outcome: "result"`, except that exact one pending row may be non-result when
  `pendingRepresented` is true. A validated non-result call blocker also represents its exact
  occurrence without making it replayable.
- Compute `filesystemStable = environmentsEqual(source.environment,
  source.resume.terminalEnvironment)`, `allAgentsSafe` (every root agent row and remaining agent
  candidate has `resumeSafety`), and `allCheckpointResultsHostDecisions` (every root checkpoint
  result row satisfies rule 7's host-decision proof).
- Choose a fallback reason by first match: explicit `resumePolicy: "positional"` ->
  `"forced-positional"`; else `nestedWorkflows` -> `"nested-workflows"`; else
  `!allAgentsSafe || !allCheckpointResultsHostDecisions || !allCallsRepresented` ->
  `"unsafe-recording"`.
  Here `"unsafe-recording"` means "not eligible for non-contiguous identity serving": either an
  unproved agent or a headless checkpoint outcome that v1 deliberately re-executes. A safety-proved
  non-result agent remains an explicit, non-replayable seed blocker. The pending-checkpoint
  exception uses the newly supplied host reply as the durable identity record for that row.
- With a fallback reason, select `"positional-v1"`. Its eligibility is `"all-live"` when
  `nestedWorkflows` or `!filesystemStable`, otherwise `"safe-prefix"`. Thus a nested source or a
  source whose final modeled tree differs from the tree its leading readers observed serves no
  cached row; a stable unsafe source may serve only safety-marked/proven-host leading rows before
  its first unproved agent or headless checkpoint.
- Without a fallback reason, `filesystemStable` selects `"identity-v1"`; inequality selects live
  with `"source-environment-drift"`.

The source/start comparison is necessary even for positional safe-prefix reuse. A final tree cannot
reconstruct an unsafe call's intermediate writes, and a leading reader may have observed the source
start rather than its terminal tree. New-format positional therefore never replays an unsafe agent,
never serves any prefix across source/start drift, and never serves around an unlocated nested
workflow. The exact historical prefix remains only for `eligibility: "legacy"`.

Disabled-reason assignment is exact and follows the validation order. An unknown marker is
`"unsupported-format"`. Aborted status or `abortSignaled` is `"abort-residue"`; another non-terminal
status is `"source-not-terminal"`; `executionMode` is `"isolation-recording"`. A missing required
cwd/runtime/journal/manifest field is `"resume-metadata-missing"`. An absent, malformed, or
uncapturable environment arm is
`"environment-missing"`. Rules 3, 4, and 5 map to `"cwd-mismatch"`, `"runtime-mismatch"`, and
`"environment-mismatch"`. Rules 6–7 map to `"manifest-invalid"`; rule 8 maps to
`"resume-seed-invalid"`; the final identity-only comparison maps as above. Once assigned, a reason
is not replaced by a later failure.

The source may be paused or failed and therefore may represent only a reached prefix/branch of the
script, but its manifest is complete for every root call it actually allocated: indexes are dense,
every allocated primitive has a terminal-shaped row, and every result is journal-paired. On halt,
the engine synchronously records every outstanding allocation as an engine-aborted error before the
manager saves terminal state. Safety-proved interruptions retire resume activity for terminal
environment capture without waiting for backend wind-down. Isolation preflight remains stricter
and additionally requires a completed recording for comparison.

A checkpoint pause supplied with a validated reply is represented by its injection. It is
admitted only for the execution
that supplies its validated reply, and the prepared injection remains in the original multiplicity
groups. Without a reply or with a non-injectable duplicate, the row selects positional fallback.
Safety-proved agent failures instead become call blockers. This is what lets an identity run pause for a human and
continue with its unconsumed seed without forgetting an ambiguity blocker.

Rule 7 is intentionally source-wide in v1. An excluded row cannot simply disappear from the seed:
it must still block an otherwise-unique exact/content group, including after a selected sibling is
consumed and a paused run flattens across generations. Non-result call blockers supply that durable
ambiguity fact and are consumed when the current execution reaches them. A result row still cannot
be reduced to a blocker because doing so would discard a replayable value; v1 treats any result row
missing path/input/debit as `"manifest-invalid"` and serves nothing. This
is conservative for a deep-stack or non-strict-meta row, but it is decidable and fail-to-live.

Frozen exported run-level reason arrays keep code, docs, and tests aligned:

```ts
export const RESUME_FALLBACK_REASONS = [
  "legacy-recording",
  "forced-positional",
  "unsafe-recording",
  "nested-workflows",
  "legacy-resume",
] as const;

export const RESUME_DISABLED_REASONS = [
  "unsupported-format",
  "source-not-terminal",
  "abort-residue",
  "isolation-recording",
  "resume-metadata-missing",
  "manifest-invalid",
  "cwd-mismatch",
  "runtime-mismatch",
  "environment-missing",
  "environment-mismatch",
  "source-environment-drift",
  "resume-seed-invalid",
] as const;
```

### 2.6 Durable seed

Identity correspondence cannot seed the new run's ordinary journal by source index because indexes
may shift. The manager instead persists a normalized candidate seed in the new run's initial save:

```ts
export interface PersistedResumeCandidate {
  sourceRunId: string;
  recordedIndex: number;
  /** Frozen source values; entry.index/call.index remain the source index. */
  entry: JournalEntry;
  call: WorkflowCallRecord;
}

export interface PersistedResumeCallBlocker {
  sourceRunId: string;
  recordedIndex: number;
  /** Frozen non-result terminal call; it participates in matching but never replays. */
  call: WorkflowCallRecord;
}

export interface PersistedCheckpointInjection {
  sourceRunId: string;
  recordedIndex: number;
  hash: string;
  path: string;
  /** hashCheckpointInputs() for the source pending checkpoint. */
  inputsHash: string;
  decision: unknown;
}

export interface PersistedResumeSeed {
  format: "identity-v1";
  /** Immediate run named by resumeFromRunId; individual candidates may originate in an
   *  older hop and retain that run ID themselves. */
  sourceRunId: string;
  candidates: PersistedResumeCandidate[];
  callBlockers?: PersistedResumeCallBlocker[];
  checkpointInjections?: PersistedCheckpointInjection[];
}

/** Manager-prepared, engine-internal execution input. It is exported from the engine
 *  only because WorkflowRunOptions is public; public callers never construct it. */
export type PreparedResume =
  | {
      strategy: "identity-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      seed: PersistedResumeSeed;
      /** Synchronously replace the durable remaining seed. Throws PERSISTENCE_ERROR
       *  on failure; the engine must not expose a replay/live decision first. */
      commitSeed: (remaining: PersistedResumeSeed) => void;
    }
  | {
      strategy: "positional-v1";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      fallbackReason: WorkflowResumeFallbackReason;
      /** "legacy" is the exact historical matcher. "safe-prefix" permits only
       *  safety-marked new-format hits. "all-live" initializes firstMiss to 0. */
      eligibility: "legacy" | "safe-prefix" | "all-live";
      /** Root source manifest by source index when available; empty for pre-manifest legacy
       *  sources. Used only to carry safety/provenance into fresh current rows. */
      sourceCalls: ReadonlyMap<number, WorkflowCallRecord>;
      /** Present only for a new-format shifted checkpoint injection. Its candidates
       *  array is empty; commitSeed has the same critical semantics as above. */
      checkpoint?: {
        seed: PersistedResumeSeed;
        commitSeed: (remaining: PersistedResumeSeed) => void;
      };
    }
  | {
      strategy: "live";
      sourceRunId: string;
      requestedPolicy: ResumePolicy;
      disabledReason: WorkflowResumeDisabledReason;
    };

export interface WorkflowRunOptions {
  // existing fields unchanged
  /** Manager-prepared resume state. Mutually exclusive with a caller-authored
   *  resumeJournal except for strategy "positional-v1", where that map is the cache. */
  preparedResume?: PreparedResume;
  /** Manager-owned synchronous latch; called before unproved persistent effects. */
  onResumeFilesystemTainted?: () => void;
  /** Manager-owned absolute root-execution activity count (§2.3). The engine reports
   *  every transition; it includes logical primitives and raw runner promises. */
  onResumeActivity?: (active: number) => void;
  /** Manager-owned absolute root agent/checkpoint allocation count (§2.3). */
  onResumeCallAllocated?: (allocated: number) => void;
  /** Manager-owned incremental report sink (§2.13). Invoked once per terminal
   *  root call decision so paused/failed executions do not need an EngineRunResult. */
  onResumeDecision?: (decision: WorkflowResumeCallDecision) => void;
}
```

Historical `tokenBudget`, `budgetDebit`, and `logicalBudgetDebit` properties are accepted as
ignored compatibility input when persisted runs are read. Candidate normalization strips them,
so a new seed never carries obsolete budget metadata across resume hops.

The seed contains the source agent result pairs admitted by §2.5 plus only the proven-host subset
of checkpoint result pairs, validated non-result call blockers, the prepared pending injection if
any, and any validated unconsumed candidates/blockers/injections inherited from the source's own
seed, all as strict-JSON clones. It is
written before `startInBackground()` returns. Each binding decision removes the selected or
invalidated source candidates/blockers from the in-memory seed before the decision is exposed to script
code; `preparedResume.commitSeed` persists that smaller seed. A replay also emits a fresh
`JournalEntry` under the current index before returning the value. That entry uses the current
hash/scope/call diagnostics and the rebound session record from §2.11.

On every terminal save of a new-run `resumeFromRunId` execution, the manager first replaces
`calls` with the latest rows whose scope is the **current** run ID, then compacts `journal` to
entries that have a same-index, same-kind, same-hash `outcome: "result"` row in that manifest.
Inherited unvisited positional suffix rows are dropped from both arrays. Ordinary runs and
same-ID `WorkflowManager.resume()` retain their existing compaction behavior. A completed new-run
execution also removes `resumeSeed`, because
every still-unconsumed candidate is unreachable in that completed script. A paused or failed
identity execution retains its already-reduced seed alongside the terminal environment when §2.3
proved quiescence; when its next admission again selects `"identity-v1"`, the manager flattens
(a) the interrupted run's valid current journal/manifest pairs and (b) that remaining seed into one
seed. The union must remain unique by `(sourceRunId, recordedIndex)`; an unexpected collision has
no winner and selects `"resume-seed-invalid"` before the target starts. A checkpoint pause with a
valid supplied reply
qualifies through `pendingRepresented` in §2.5. Other validated non-result occurrences retain their
call blockers, so the source cannot forget a failed row and then claim unique identity
correspondence. Candidates and blockers promoted from current rows use the immediate
interrupted run ID; older candidates retain their original run ID. If the interrupted execution
had already crossed the unsafe-live barrier (§2.9), every remaining candidate, blocker, and injection was
synchronously removed at that barrier. Thus a later hop cannot resurrect a candidate that unsafe
live work made stale.

Resume-source saves are correctness-critical, unlike ordinary best-effort progress persistence.
The new run's initial identity seed or inherited positional journal save, and every `commitSeed`
call, use a throwing persistence path: failure produces a
non-recoverable `PERSISTENCE_ERROR` and no cached value or unsafe live delegation is exposed.
`commitSeed` is a pre-settlement matcher hook, not one of the guarded terminal observers; its throw
sets a run-local fatal persistence latch and propagates as `PERSISTENCE_ERROR`. Every later
agent/checkpoint matcher rethrows that latch before serving or delegating, so a script that catches
the first error cannot continue against a seed the manager failed to update. A hard-crash file
lacking a terminal environment is not flattened or replayed; §2.5 selects all-live. Flattening is
permitted only for a terminal paused/failed file whose seed mutations and quiescent terminal environment were
durably saved. This keeps the existing best-effort policy for non-resume progress while making the
seed's durability claim real.

The same throwing path is used for the pre-execution `legacyResume` writes required by §2.4. A
best-effort `persistRun()` call is not sufficient for that anti-laundering bit: no manual-journal or
same-ID positional result may be exposed until the bit is durable.

Positional strategies copy the source journal and available root manifest under their existing
indexes before background acknowledgement using that critical initial-save path. They create no
agent candidate seed. The sole exception is a new-format shifted checkpoint injection: persist an
otherwise-empty `resumeSeed` containing that injection and consume it through the same critical
`commitSeed` path.

Every positional replay also emits a fresh current-scope `JournalEntry` before returning, even
though its index did not move. This replaces old/foreign-scope metadata before terminal compaction
and keeps later positional hops self-contained. It does not change the selected result, index gate,
empty-output guard, usage, session identity, or zero-debit behavior. A manager-prepared positional
hit consults `sourceCalls` only to attach §2.2 safety and §2.13 provenance; a manual
`resumeJournal` or same-run recovery has no such metadata.

### 2.7 Identity candidate indexes and matching

`WorkflowCallRecord.inputsHash` is generalized from agent-only to the unhashed-input fingerprint
for either primitive. Agent rows retain their existing `hashCallInputs()` bytes. For checkpoints,
compute this additive value in the same synchronous identity window, before index allocation:

```ts
export interface WorkflowCallRecord {
  // existing fields unchanged
  /** hashCallInputs() for an agent or hashCheckpointInputs() for a checkpoint,
   *  when the corresponding strict fingerprint was computable. */
  inputsHash?: string;
}

function hashCheckpointInputs(options: CheckpointOptions): string | undefined {
  return hashCanonicalStrictJson({
    ...(options.default !== undefined ? { default: options.default } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
```

The three values are read once for this computation and the same captured values govern the
current confirm/headless branch; a getter or later mutation cannot make the fingerprint describe
different options from those executed. `kind` and `choices` remain solely in `hashCheckpoint()`.
Unset fields are omitted, so the new data follows the existing byte-compat rule. Failure to
canonicalize (for example a cyclic/non-strict-JSON `default`) yields `undefined`: the checkpoint
still executes live with its existing behavior, but it cannot consume a v1 candidate. This function
does not alter `hashCheckpoint()`, `hashCallInputs()`, or `CALL_INPUTS_FORMAT`. When defined, the
value is written as `inputsHash` on every terminal checkpoint call row, including the
`CHECKPOINT_REQUIRED` error row used for an injection.

This fingerprint is required even for origin-`"confirm"` rows. A host confirm path may use
`default` to populate/fallback a decision and `timeoutMs` to decide when that fallback occurs, so
host provenance alone does not prove equal inputs. For identity replay, a host confirm result is a
decision over the prompt, the documented `CheckpointOptions` values, and (if consulted) the
admitted workspace. `CheckpointCallContext.callIndex`/`path` are correlation data only; a host
whose decision semantics depend on either — or on the run-specific `scope` — must not use
new-run `resumeFromRunId` for that execution. `resumePolicy: "positional"` is not an escape from
this host precondition because the new run's scope always changes. As with an authored filesystem
declaration, violating the precondition is outside the replay guarantee.

Build immutable indexes over the seed before executing the script:

```ts
type ExactKey = `${"agent" | "checkpoint"}\u0000${string}\u0000${string}`;
// kind \0 path \0 hash

type ContentKey = `${string}\u0000${string}`;
// hash \0 inputsHash, separately partitioned by kind
```

Paths use `CALL_PATH_FORMAT`; hashes/input hashes are non-empty lowercase SHA-256 hex. A NUL cannot
occur in any component. Candidate multiplicity is computed from the original seed and never shrinks
for ambiguity purposes after another row is consumed.

For each current agent call, after call hash/path/input hash and current index are allocated, first
enter the index-ordered resume-decision gate in §2.9. Then:

1. If the replay cache is closed by §2.9, run live (`"unsafe-suffix"`).
2. Require non-empty live path and input hash; otherwise run live (`"path-missing"` or
   `"inputs-missing"`).
3. Look up the original exact-identity group `(kind, path, hash)` before using the input
   fingerprint. More than one row is permanently ambiguous and runs live
   (`"ambiguous-identity"`), even if the rows' input fingerprints differ. This preserves
   isolation's refusal to invent occurrence identity for repeated call sites.
4. If the exact group has one row, require an equal source input hash. A missing/different source
   input hash runs live (`"inputs-changed"`). If equal and unconsumed, select it with match
   `"path-hash"`; if already consumed, run live (`"candidate-consumed"`).
5. If the exact group is empty, inspect the original `(kind, hash, inputsHash)` content group.
   - exactly one candidate and not consumed: select it with match `"unique-hash"`; this is the
     bounded call-movement fallback;
   - zero: run live (`"not-recorded"` or `"inputs-changed"` when hash rows exist);
   - more than one: run live (`"ambiguous-content"`). No occurrence ordinal or source-order pairing
     is inferred.
6. Apply the existing empty-output guard to the selected entry. A schema-less empty/whitespace
   string is removed from the seed and runs live (`"empty-output"`).
7. Require safety agreement: `"declared-read-only"` needs the current read-only annotation and no
   resolved worktree request; `"isolated-worktree"` needs the current read-only annotation, a
   resolved isolation request of `"worktree"`, and an absent current per-agent `cwd`. Disagreement
   runs live (`"safety-changed"`) and, when the current call has no valid declaration for its
   resolved mode, closes the suffix per §2.9.
8. Consume the selected source row once, apply budget semantics (§2.10), re-journal under the
   current index, emit terminal events/manifest, and return a fresh strict-JSON clone.

Call movement is therefore content movement, not hash-only movement. For example, insertion can
change a later call's generated default label; because resolved label is in `inputsHash` and reaches
the runner, that call correctly runs live. Authors who need movement across inserted siblings use
stable explicit labels and otherwise-stable execution inputs.

Seed mutation is exact: a replayed row, an empty-output selected row, or a safety-changed selected
row is removed; a consumed checkpoint injection is removed; `not-recorded`, input mismatch, and
ambiguity do not guess which source row to remove; the filesystem barrier removes every remaining
agent/checkpoint candidate and checkpoint injection at once. Every removal commits through §2.6
before the corresponding result/live delegation is exposed.

For **proven host-decision** checkpoint candidates, enter the same index-ordered decision gate and
run rules 2–5 with `hashCheckpointInputs()`: require a non-empty current path and input hash, use
exact `(checkpoint, path, hash)` first and require equal input hashes, then use a unique
`(checkpoint, hash, inputsHash)` movement fallback. Missing/different inputs are
`"inputs-missing"`/`"inputs-changed"`. Duplicate identities or duplicate content groups run through
the live checkpoint channel. Pending injections participate in those same multiplicity groups;
their source index does not disambiguate a repeated checkpoint site. Source headless rows are
absent from both indexes and execute the current `default`/`headless` behavior fresh. Mainline
resume never uses isolation's path-only fallback: a different checkpoint/agent hash means changed
content and must not be served.

The SHA-256 collision resistance used by the existing journal is the cryptographic assumption. The
journal does not retain verbatim prompts/options, so an adversarial digest collision cannot be
byte-compared at replay time. Structural/map collisions and duplicate identities are handled by the
explicit multiplicity rules above.

Frozen per-call reason values:

```ts
export const RESUME_CALL_LIVE_REASONS = [
  "strategy-live",
  "positional-miss",
  "positional-suffix",
  "not-recorded",
  "path-missing",
  "inputs-missing",
  "inputs-changed",
  "ambiguous-identity",
  "ambiguous-content",
  "candidate-consumed",
  "empty-output",
  "safety-changed",
  "unsafe-suffix",
  "worktree-degraded",
] as const;

export const RESUME_CALL_FAILED_REASONS = [
  "seed-persistence-error",
  "resume-fatal-latch",
] as const;
```

All four `RESUME_*_REASONS` arrays are runtime exports of `@automatalabs/workflow-engine`. The
literal unions/report/provenance types live in `@automatalabs/shared-types`; `@automatalabs/workflows`
re-exports both surfaces for SDK callers.

### 2.8 Positional fallback

`"positional-v1"` remains an index/prefix algorithm, not a second identity heuristic. Its exact
mode is carried by `PreparedResume.eligibility`:

1. `"all-live"` initializes `firstMiss = 0`; `"legacy"` and `"safe-prefix"` initialize it to
   positive infinity. A manual `resumeJournal` and same-run recovery behave as `"legacy"`.
2. Look up `resumeJournal.get(currentIndex)` and require equal hash. An agent hit additionally
   requires a non-empty cached result under the existing schema-aware guard.
3. `"safe-prefix"` additionally requires equal source/current kind, a paired source call row, equal
   current/source `inputsHash` for both primitives, and agent safety agreement under §2.7 rule 7.
   A source agent
   without `resumeSafety` is intentionally the first miss even when its index/hash/input all match.
   Checkpoints require no filesystem marker, but their source row must be a proven host decision
   under §2.5 rule 7 and its checkpoint input fingerprint must match; a changed `default`,
   `headless`, or `timeoutMs` is the first miss. A headless row is also the first miss even when its
   fingerprint matches. `"legacy"` retains hash-only matching because those facts/provenance may
   not exist.
4. Replay only while `currentIndex < firstMiss`.
5. The first missing, changed, new, empty-agent, input-changed, unsafe-source, or unproved-headless
   entry lowers `firstMiss` to the current index; every later agent/checkpoint runs live.
6. A parent `workflow()` invocation synchronously lowers `firstMiss` to the current `callSeq` before
   entering its unseeded child, so no later parent call replays after live nested work.
7. Replayed calls cost zero current provider tokens.

An ordinary positional journal hit reports `match: "index-hash"` and
`recordedIndex: currentIndex`; a shifted/same-index injection reports its identity match from
§2.7. The ordinary hit's freshly emitted journal/manifest entry carries the source run ID when the
validated source call is available. Historical debit metadata is ignored and not copied. Legacy
sources without call manifests remain `legacyResume`.

Non-legacy new-format positional fallback additionally passed the admission gate, so the current
workspace matches the source terminal workspace. `"safe-prefix"` also proved source start equals
source terminal; `"all-live"` serves nothing. A marker-less or `legacyResume` source lacks those
facts and retains its historical workspace assumption. This is the only compatibility exception to
the new admission guarantee.

An identity-v1 checkpoint injection (§2.12) may locate a shifted checkpoint by identity while the
overall strategy is positional, but it remains subject to the same `currentIndex < firstMiss`
gate. It is an explicit current host decision, not permission to jump over an earlier changed/live
call. When `currentIndex !== injection.recordedIndex`, the engine serves the explicit decision and
then sets `firstMiss = Math.min(firstMiss, currentIndex + 1)`, so the call immediately after the
moved checkpoint is in the live suffix. A same-index injection behaves like today's synthetic
entry and may leave the prefix open. Ordinary journaled checkpoints remain under `firstMiss` too.

### 2.9 Filesystem barrier and parallelism

Identity mode tracks one engine-internal replay-cache state and one non-rejecting root decision
chain:

```ts
type ResumeReplayState =
  | { kind: "open" }
  | { kind: "closed"; reason: "unsafe-live-call" | "worktree-degraded" | "nested-workflow" };

let resumeDecisionTail: Promise<void>; // initially Promise.resolve()
```

- Immediately after each root agent/checkpoint index is allocated, the primitive synchronously
  appends a deferred, always-fulfilling gate to `resumeDecisionTail` and retains the predecessor.
  Its matcher awaits that predecessor before selecting a cached value or classifying itself live.
  It resolves its own gate only after every required seed mutation/closure is durably committed.
  A non-worktree live call resolves before runner/callback delegation. A replay resolves before its
  result is exposed. Any matcher/commit failure resolves the gate only after latching the fatal
  error, so later matchers wake and fail rather than deadlock. This serializes **decisions**, not
  runner settlement, and does not move hash computation or index allocation.
- A live agent carrying the read-only assertion and no resolved worktree request does not close the
  cache.
- A live unannotated agent — worktree requested or not — closes it in its allocation-ordered
  decision turn, after identity/index allocation and before limiter delegation. All remaining candidates and
  injections are removed from the durable seed before the runner can start. Worktree isolation
  alone never substitutes for the explicit declaration.
- A live worktree-requesting call **with** the read-only declaration keeps its decision gate closed
  through worktree creation. It opens only when `isolated: true`, the worktree was derived from
  `effectiveCwd`, and per-agent `cwd` was absent. A false result, external base, or thrown creation
  error closes the replay cache and durably clears it before that runner can start or the creation
  error can reach script code. Later-index agent **and checkpoint** matchers are already waiting on
  this gate. The runner itself need not finish before safe sibling replays proceed because its
  declaration forbids out-of-worktree effects and its ordinary checkout edits are confined to the
  throwaway worktree.
- Any `workflow()` invocation closes the parent replay cache before executing the child. Children
  receive no parent seed: `workflowFn` explicitly sets `preparedResume: undefined` in addition to
  clearing `resumeJournal`/`resumeFromRunId`. Closing removes and commits every remaining parent
  candidate/injection before child code starts.
- Invoking the live host `confirm` callback closes the parent replay cache before calling host code.
  The same remove-and-commit rule runs before host code. A journal replay or durable injection does
  not close it; an engine-only headless decision runs fresh and does not close it.
- A script catching a live-call failure cannot reopen a closed cache.

"After the first unsafe LIVE call" therefore means after its allocation-ordered decision, before
delegation and independently of settlement or source journal order. The decision chain prevents a
higher-index replay
from racing past a lower-index matcher that is suspended on worktree creation; all indexes are
still assigned in the original synchronous prefix. Parallel calls with greater current indexes are
not assumed independent merely because their thunks were created together. This is conservative
and decidable. A 40-way unannotated coding fan-out falls back/turns live; a 40-way declared reader
fan-out, or a declared worktree-local fan-out whose worktrees are actually created, can replay the
38 unchanged siblings even when two lower-index items run live.

The downstream frontier is current allocation order; it does not manufacture a happens-before
edge between concurrently running agents. A script that deliberately has one `parallel()` sibling
read bytes while another sibling may write them has no deterministic file-data-flow baseline for
either positional or identity resume. Such communication violates the safety declaration above
and must be expressed as a sequenced dependency. This limitation does not permit a higher-index
replay after a lower-index unsafe decision: the chain and whole-cache closure still forbid that
serve.

### 2.10 Usage telemetry

Token usage is observational and never participates in replay admission or script control flow.
A replayed call performs no provider work, so it contributes zero to current `tokenUsage` and
provider cost. Live calls continue to report provider usage through the existing per-agent and
run-level telemetry. Settlement ordinals retain deterministic ordering diagnostics, but neither
mainline replay nor isolation requires a debit or budget trajectory. Cached results are still
resolved through the existing microtask boundary; the engine does not reproduce source provider
latency or reorder current promises by source settlement ordinal.

### 2.11 Sessions and journal rebinding

On an identity replay, the engine clones the selected `JournalEntry.session` and rebinds only its
workflow-call context:

```ts
const rebound: AgentSessionRecord = {
  ...recordedSession,            // sessionId/backendId/cwd/reopen/keptOpen unchanged
  callIndex: currentIndex,
  label: currentLabel,
  phase: currentPhase,
};
```

The rebound record is placed in the current `agentSessions`, terminal event, and freshly emitted
current-index journal entry. The source artifact is never mutated. Live calls attach their new
session records normally. A replay opens no session; `keepSession` cannot turn a closed historical
session into an open one, and reopen capability remains backend-controlled. The result list keeps
the engine's existing observation/completion ordering; consumers join by the rebound current
`callIndex`, while `WorkflowCallRecord.replay.recordedIndex` provides the source join.

Every positional replay, whether legacy or new-format fallback, retains the existing session
behavior: clone/push the recorded session byte-for-byte. Its index is necessarily the current
index; its historical label/phase are not rebound. Isolation session behavior is unchanged: served
isolation calls open no sessions and only live targets surface sessions.

### 2.12 Checkpoints and index-keyed replies

`checkpointReplies` keys name indexes in the **source recording**, never indexes guessed for the
new script.

`confirm` is contractually a decision channel: a host may collect/validate the requested value but
must not create workflow-observable filesystem or external side effects whose repetition is needed
for correctness. To use identity-v1, its value may depend on the prompt, documented checkpoint
options, and admitted workspace, but not on `CheckpointCallContext.callIndex`/`path`; those are
correlation fields. Its decision must not depend on the run-specific `scope` either. A host whose
decisions depend on any of those context fields must not use new-run `resumeFromRunId` for that
execution; forced positional policy still has a different scope. If `confirm` inspects the admitted
workspace to decide, it must not race an unordered parallel writer; the script must sequence that
checkpoint after the writer. Violating any of these API preconditions is host error, analogous to a
false authored read-only assertion. The
live-callback barrier in §2.9 is still applied as defense in depth for the current suffix; replaying
a recorded human decision does not re-invoke the callback.

Preparation algorithm:

1. Parse each own enumerable key as a canonical base-10 non-negative safe integer: `String(n)`
   must equal the key. (JSON object keys always arrive as strings; the `Record<number, unknown>`
   input type is nominal at the wire, and this canonical parse is the actual contract.) A source may have at most one pending durable checkpoint (`pauseReason ===
   "checkpoint_required"` plus `checkpointContext`). Every supplied key must equal that context's
   `callIndex`; a non-canonical/extra key or a reply with no pending context is a pre-run
   `SCRIPT_VALIDATION_ERROR`.
2. Strict-JSON clone the decision as today.
3. For identity-v1 source data, find the source call row at that index and require
   `kind: "checkpoint"`, `outcome: "error"`, origin `"headless"`, a recorded error code of
   `CHECKPOINT_REQUIRED`, equal context hash, a non-empty NUL-free path, and a lowercase SHA-256
   checkpoint `inputsHash`. Create
   `PersistedCheckpointInjection` only when no other root checkpoint call row at another index,
   regardless of outcome, and no retained checkpoint candidate/injection has the same
   `(hash, inputsHash)`; do not insert it into an index map until the flattened seed is complete.
   This content-key uniqueness requirement is deliberately stronger than exact-path uniqueness
   because an injection permits call movement and the result-candidate seed does not otherwise
   retain error/headless rows as occurrence blockers. A duplicate content key makes the reply
   non-injectable, not malformed; the current checkpoint uses its live/headless channel. When a
   reply was supplied, failure of the row/kind/outcome/origin/error/hash/path/input cross-check
   itself is `"manifest-invalid"` and selects run-level live strategy. The injection copies the
   source row's `inputsHash`.
4. At current execution, match the injection by the checkpoint algorithm in §2.7. An inserted or
   deleted earlier call may shift the current index; path/hash/input identity still supplies the
   decision.
5. If the current checkpoint's hash or input fingerprint changed, or correspondence is ambiguous,
   do not inject. Use the live `confirm` callback or authored headless behavior. A headless pause
   reports its new current index.
6. For a legacy positional source lacking checkpoint identity facts, preserve today's synthetic
   `JournalEntry` at the source index. Forced positional over a valid v1 source still uses rules
   3–5 and may shift by identity.

Pause/failure flattening reapplies the same injection uniqueness rule against all promoted current
checkpoint rows and retained candidate/injection rows. If a new same-content-key row appeared, the
retained injection is
dropped before the flattened seed is durably saved; a later hop cannot turn a formerly ambiguous
reply into a unique one by forgetting the blocking row.

In positional-v1 with a new-format injection, the engine attempts the injection before its
ordinary index lookup only while `currentIndex < firstMiss`. If the call is already in the live
suffix, the injection is not consumed and that checkpoint uses the live/headless channel. If an
eligible injection does not correspond, normal positional lookup continues; the absent pending
decision becomes that checkpoint's `"positional-miss"` and lowers `firstMiss`. If it corresponds
at a shifted index, §2.8 closes the prefix immediately after the injected call; identity movement
never realigns ordinary positional journal rows.

When run-level strategy is `"live"`, a supplied source-index reply is validated but not injected:
some required admission fact or environment gate failed. The current checkpoint therefore uses its
live/headless channel and may pause again with a current index.

An injected decision is journaled under the current index before return and appears in
`checkpointsTaken` with source `"injected"`. An ordinary identity-replayed **host** decision uses
`"journal-replay"`; both persist the host-decision provenance of §2.13. A source headless result is
not an identity candidate by v1 policy even when its input fingerprint matches, so the current
headless branch runs and journals its current decision normally. None of these engine-only paths
closes or reopens the filesystem barrier. A live `confirm` callback closes the replay cache as
specified in §2.9.

### 2.13 Observability

Add shared public report types:

```ts
export type WorkflowResumeStrategy = "identity-v1" | "positional-v1" | "live";
export type WorkflowResumeMatch = "path-hash" | "unique-hash" | "index-hash";
export type WorkflowResumeFallbackReason =
  | "legacy-recording"
  | "forced-positional"
  | "unsafe-recording"
  | "nested-workflows"
  | "legacy-resume";
export type WorkflowResumeDisabledReason =
  | "unsupported-format"
  | "source-not-terminal"
  | "abort-residue"
  | "isolation-recording"
  | "resume-metadata-missing"
  | "manifest-invalid"
  | "cwd-mismatch"
  | "runtime-mismatch"
  | "environment-missing"
  | "environment-mismatch"
  | "source-environment-drift"
  | "resume-seed-invalid";
export type WorkflowResumeCallLiveReason =
  | "strategy-live"
  | "positional-miss"
  | "positional-suffix"
  | "not-recorded"
  | "path-missing"
  | "inputs-missing"
  | "inputs-changed"
  | "ambiguous-identity"
  | "ambiguous-content"
  | "candidate-consumed"
  | "empty-output"
  | "safety-changed"
  | "unsafe-suffix"
  | "worktree-degraded";
export type WorkflowResumeCallFailedReason =
  | "seed-persistence-error"
  | "resume-fatal-latch";

export interface WorkflowCallReplayProvenance {
  sourceRunId: string;
  recordedIndex: number;
  match: WorkflowResumeMatch;
  /** Agents only: source row's admitted safety class. Required on every non-legacy
   *  journal replay and equal to the current row's resumeSafety. */
  sourceResumeSafety?: WorkflowResumeSafety;
  /** Checkpoints only: the selected source outcome was produced by a host confirm or
   *  inherited from one. Required to carry that eligibility across resume hops. */
  checkpointHostDecision?: true;
  checkpointInjected?: true;
}

export type WorkflowResumeCallDecision =
  | {
      index: number;                     // current execution index
      kind: "agent" | "checkpoint";
      action: "replayed";
      sourceRunId: string;                // candidate origin; may predate report.sourceRunId
      recordedIndex: number;
      match: WorkflowResumeMatch;
      reason?: never;
      checkpointInjected?: true;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "live";
      reason: WorkflowResumeCallLiveReason;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    }
  | {
      index: number;
      kind: "agent" | "checkpoint";
      action: "failed";
      reason: WorkflowResumeCallFailedReason;
      sourceRunId?: never;
      recordedIndex?: never;
      match?: never;
      checkpointInjected?: never;
    };

interface WorkflowResumeReportBase {
  sourceRunId: string;
  requestedPolicy: ResumePolicy;
  replayed: number;
  live: number;
  failed: number;
  calls: WorkflowResumeCallDecision[];   // ascending current index
}

export type WorkflowResumeReport = WorkflowResumeReportBase &
  (
    | { strategy: "identity-v1"; fallbackReason?: never; disabledReason?: never;
        eligibility?: never }
    | { strategy: "positional-v1"; fallbackReason: WorkflowResumeFallbackReason;
        eligibility: "legacy" | "safe-prefix" | "all-live"; disabledReason?: never }
    | { strategy: "live"; disabledReason: WorkflowResumeDisabledReason;
        fallbackReason?: never; eligibility?: never }
  );

export interface WorkflowCallRecord {
  // existing fields unchanged
  replay?: WorkflowCallReplayProvenance; // manager-owned resumeFromRunId replay only
}

export interface WorkflowRunResult<T = unknown> {
  // existing fields unchanged
  resumeReport?: WorkflowResumeReport;
}
```

The manager persists `resumeReport` during execution and returns it on every terminal status. The
report contains no prompt, result, hash, cwd, or session ID. (The durable seed of §2.6 does retain
hashes — the seed is protected persisted run state, not part of this outward report.) A direct non-resume run omits it.
The low-level manual `resumeJournal` compatibility path also omits it because that map carries no
source run ID or manifest correspondence; reports are guaranteed for manager-owned
`resumeFromRunId` only.
`origin: "journal-replay"` remains the authoritative manifest origin for replayed calls;
`replay.recordedIndex` explains non-positional correspondence. Live miss reasons live only in the
report so the runner-origin manifest shape does not acquire speculative source indexes.
Every identity/manager-prepared positional replay of a proven host checkpoint writes
`replay.checkpointHostDecision: true`; an injected reply also writes `checkpointInjected: true`.
Both fields are forbidden on agent rows, and `checkpointInjected` implies
`checkpointHostDecision`. A headless replay possible only on the legacy positional path carries
neither and cannot become an identity candidate on a later hop.
Every identity/manager-prepared positional agent replay copies the selected source marker into both
`resumeSafety` and `replay.sourceResumeSafety`; both values must agree with the current authored
safety class. Runner-origin rows omit `sourceResumeSafety`. Legacy/manual replay rows may omit both
because `legacyResume` prevents their admission into the v1 validator.

There is one decision row per root-scope call whose identity was successfully computed and index
allocated; retries collapse into that logical row. A pre-allocation hash/path/input computation
throw creates no decision, matching the call-manifest allocation rule. A critical seed-write throw
from an indexed matcher records `action: "failed"` before setting/rethrowing the latch; later
caught-script arrivals record `"resume-fatal-latch"`. A seed-clear failure caused by the unindexed
`workflow()` barrier creates no synthetic call row; it is the terminal `PERSISTENCE_ERROR`, and any
later indexed arrival observes the latch. Otherwise the engine appends the decision and calls the
manager-only, non-throwing `onResumeDecision` observer before exposing replay/live settlement. The
manager keeps an in-memory index map and best-effort progress saves, then replaces its incremental
copy with the engine-owned final array on terminal success, mirroring `WorkflowCallRecord`
authority. On a paused/failed throw, the incremental map is the final report source. The final
array is sorted by current
index and `replayed + live + failed === calls.length`. If the persistence backend itself is failing,
the in-memory/returned failure report remains authoritative; durable report persistence is not
promised when the same storage failure prevented the critical seed write.

Decision reasons follow matcher order. In particular, the first positional miss is
`"positional-miss"` and its suffix is `"positional-suffix"`; a closed identity cache is
`"unsafe-suffix"`; `eligibility: "all-live"` reports `"positional-suffix"` from index 0 without a
synthetic miss row; and a requested worktree whose creation degrades or throws overwrites that call's earlier
miss reason with `"worktree-degraded"` before settlement. No row reports more than one terminal
reason. Consequently, the engine finalizes and emits a live worktree decision only after
`createWorktree()` returns/throws but still before runner delegation; non-worktree and replay
decisions emit at the earlier matcher point. `onResumeDecision` is invoked exactly once per index.

SDK terminal results carry `resumeReport` through `WorkflowRunResult`. This report is not projected
through MCP; the MCP same-ID lifecycle exposes only bounded continuation telemetry.

### 2.14 Failure-mode analysis

#### Changed writer, unchanged downstream prompt

Recording: call A writes `generated.json`; call B's prompt is constant but B reads that file.
Resume: A's prompt changes and its new execution would write different bytes.

- A and B cannot form an identity-v1 source unless both carried the read-only assertion; a
  worktree-writing call additionally must have actually run in its throwaway checkout. An honest
  persistent writer has no `resumeSafety`.
- If the source start/terminal environments differ (the usual writer case), positional eligibility
  is `"all-live"`; neither A nor B is served.
- If A happened to restore the modeled tree so source start equals terminal, eligibility is
  `"safe-prefix"`, but A's missing safety marker is itself `"positional-miss"`. A runs live and
  `firstMiss` makes B live even though B's own hash matches.
- If the source was genuinely worktree/read-only-safe but the current script removes that safety,
  identity safety agreement fails and synchronously closes the cache before A runs; B is
  `"unsafe-suffix"`.

No branch serves B after a possibly-mutating live A.

The same rule applies when B is a checkpoint with unchanged prompt/kind/choices. A host may have
answered by inspecting `generated.json`, so an unsafe live A closes the **entire** replay cache;
neither a recorded decision nor a prepared injection can bypass the barrier. Positional injections
also remain below `firstMiss`. The current checkpoint therefore calls the host or executes its
current headless policy.

#### Replayed writer, live downstream needs its artifact

Recording: A created `generated.json`; resume replays A, while changed/new call B runs live and
expects the artifact.

- A persistent writer makes the source positional, not identity-safe. New-format `safe-prefix`
  explicitly refuses A's row; A runs live, and B is in the live suffix. This recreates A's current
  effects before B observes the workspace.
- If source start and terminal differ, positional eligibility is `"all-live"`; A again runs live.
  The terminal admission gate verifies the starting snapshot but is not mistaken for a per-call
  patch or an intermediate snapshot.
- In a non-git workspace, A tainted the source and the static host key was not stored as a terminal
  measurement. Admission is therefore all-live and A recreates its effects.
- If the artifact is ignored/outside the measured git identity, A is still unannotated and the
  new-format safe-prefix still refuses it; A recreates the artifact before live B. A call that reads
  or writes that channel cannot truthfully use the safety declaration. Only marker-less/legacy
  positional replay retains the old same-cwd assumption; a git run's `environmentKey` does not
  augment the measured git arm.
- In identity-v1, A could only be a declared reader or discarded worktree call, so no persistent
  artifact is promised in the first place.

A marker-less legacy journal cannot prove safety, terminal workspace identity, or input
fingerprints. It keeps the historical hash-only prefix under the precondition that the host accepts
those old semantics; this compatibility exception cannot be retrofitted without data the old
engine did not record. It never enables the new identity matcher or the new correctness guarantee.

No identity-v1 replay can promise a persistent file side effect, and no new-format positional path
replays an unsafe call whose effects a later live call could require.

#### Changed worktree call in a fan-out

Recording: 40 annotated calls actually ran in throwaway worktrees. Two prompts change. At resume,
those two calls create new worktrees and run live. Later sibling matchers wait only until each
worktree is successfully created; the 38 exact/unique content matches then replay. If creation
degrades or throws for either changed call, its decision gate closes the cache before any later
sibling serve and the remaining calls run live. This is sound because each worktree is a fresh
checkout from the same admitted repository HEAD, its ordinary checkout writes are never merged
into the admitted tree, and the explicit declaration
forbids every out-of-worktree load-bearing effect. A worktree call that needs to commit, POST, or
write an ignored/out-of-tree artifact cannot truthfully carry the declaration; without it the
source falls back and a current live call closes the cache before delegation.

#### Script settles while an effect may still be running

Recording: one parallel branch fails or the script floats a call while another agent/checkpoint/
nested invocation is still pending; alternatively, a runner ignores explicit cancellation after
the engine settles the targeted call. The manager reaches a terminal status before that work can no longer mutate state.

- The root resume-activity counter remains non-zero for the allocated primitive. A cancellation loser
  also retains its raw-runner unit even after retry classification and logical-call settlement.
- The manager therefore omits `resume.terminalEnvironment`; it never fingerprints a tree while
  engine-known work can still change it.
- A future new-format resume stops at `"environment-missing"` and serves nothing. A late decrement
  cannot retrofit the terminal file after the fact.

Thus a terminal status without quiescence is not laundered into a replayable source.

#### Duplicate loop occurrences

Recording: a loop emits the same prompt, options, and call path three times. All three rows share
path/hash/input fingerprint. The group is permanently ambiguous; none is paired by index,
settlement order, or occurrence count. Each current occurrence runs live. A loop whose prompt
includes its item/index normally has distinct hashes and matches independently.

#### Unchanged checkpoint hash, changed host-decision inputs

Recording: an SDK-hosted checkpoint has `default: false` and `timeoutMs: 0`. The confirm callback
times out immediately and returns the authored default, so the row has origin `"confirm"` and
decision `false`. The resumed script keeps the same prompt/kind/choices and call site but changes
`default` to `true`; `hashCheckpoint()` is therefore unchanged, while a live confirm would return
`true`.

- The source row carries `hashCheckpointInputs({ default: false, timeoutMs: 0 })`; the current call
  computes a different fingerprint.
- Exact checkpoint matching fails with `"inputs-changed"`; positional safe-prefix treats the call
  as its first miss; a pending injection likewise does not bind.
- The current confirm/headless channel executes and produces the current decision. A later cached
  checkpoint cannot cross an unsafe-live barrier in either strategy.

Thus origin `"confirm"` proves the result came through the host channel, not that the host saw the
same unhashed options. Provenance and checkpoint input equality are both required.

### 2.15 Shared machinery versus isolation-only behavior

Refactoring shared pure utilities is allowed but behavior is split deliberately:

| Concern | Shared | Mainline resume | Isolation |
| --- | --- | --- | --- |
| Exact key | `kind\0path\0hash` construction/indexes | exact first; unique hash+inputs movement fallback | exact target/serve key |
| Changed hash at same path | no shared policy | live; never path-only serve | unique-path recorded serve is allowed to hold downstream fixed |
| Duplicate identity | multiplicity detection | affected calls run live | whole baseline rejected `ambiguous-identity` |
| Doubt/failure | strict validation helpers | fail-to-live and continue | fatal typed `REPLAY_DIVERGENCE` |
| Recording | frozen journal + manifest cross-check | paused/failed reached prefix allowed; allocated rows are complete/dense | complete, completed, dense manifest required |
| Inputs hash | common field/validation; agent bytes unchanged | equality required for every agent or checkpoint hit | agent target equality only; served calls do not execute and isolation ignores checkpoint input hashes |
| Filesystem | common environment equality helper | safety classes + terminal admission + live barrier | run-creation environment comparability |
| Usage | provider token/cost telemetry | replay is free; live usage is observational | served calls are free; live target usage is observational |
| Nested workflow | scope/root helpers | source falls back positional/all-live; a new invocation closes the identity replay cache or lowers positional `firstMiss`; child is unseeded | recording and live invocation rejected |
| Report | shared clone/freeze conventions | `WorkflowResumeReport` | existing `ReplayReport` unchanged |

`ReplayRunnerImplementation`, target resolution, `validateStructure`,
`RECORDING_UNUSABLE_REASONS`, `REPLAY_DIVERGENCE_KINDS`, and `ReplayReport` are not generalized into
the mainline policy. If exact-key/index-building helpers move to a shared internal module, the full
existing isolation suite must pass unmodified and its exported arrays must remain byte-for-byte
equal.

## 3. What this deliberately does not do

- No replay of arbitrary persistent-tree agents by hash in v1. A filesystem write-set/read-set or
  per-call patch artifact would be a different, larger contract.
- No automatic inference that a prompt is read-only. Model mode, tools, label, phase, and prose are
  insufficient proof.
- No deterministic semantics for filesystem communication between unordered parallel siblings.
  Inter-call file dependencies must be sequenced in the script before either resume policy can
  promise a causal result.
- No automatic promotion of `isolation: "worktree"` into replay safety. Worktree isolation is
  observed only for ordinary checkout writes; the explicit §2.2 declaration must additionally
  exclude load-bearing network/ambient/out-of-checkout effects. Without both facts the call is
  positional/live. A false declaration is author error, not an inferred engine guarantee.
- No occurrence ordinals or positional tie-breaking inside `identity-v1`; ambiguity runs live.
  Explicit/legacy positional policy remains index-based by definition.
- No path-only serving in mainline resume. That isolation behavior is specific to holding recorded
  downstream values fixed during substitution.
- No child-journal identity matching. Nested workflows keep independent index/scope spaces and run
  without the parent seed.
- No identity seed for same-ID `WorkflowManager.resume()` recovery. It remains the positional
  compatibility path, permanently marks the artifact `legacyResume`, and cannot become an identity
  source; identity matching belongs to new-run `resumeFromRunId`.
- No recreation of external side effects, ACP sessions, ignored/out-of-tree files, or network state
  from journal data.
- No post-run non-git environment callback in v1. A static `environmentKey` admits only an
  untainted recording; unsafe non-git recordings resume all-live.
- No verbatim prompt/options recovery or hash-collision byte check; journals do not contain those
  inputs.
- No provider-latency or general settlement-order replay. Logical budget values are restored at
  current settlement points.
- No removal of `resumeJournal` or `firstMiss`; both remain the compatibility surface.
- No changes to `runIsolation` admission, serving, target selection, status taxonomy, or report.

## 4. Compatibility & semver

Hash fixtures and existing journal JSON remain readable. Every new persisted/type field is optional
on read, and new identity-adjacent serialization is omitted when unset. Format detection is exact:
old files without `resume` use positional matching; future unknown formats run live. Old engines
can parse/ignore the additive fields and will use their historical positional semantics, but they
cannot enforce the terminal-environment gate. Downgrading an identity-v1 recording is therefore
format-compatible, not covered by this contract's replay correctness guarantee.

The default semantic change applies only when `resumeFromRunId` names an identity-v1-capable source:
safe calls can replay non-contiguously, replayed safe calls contribute logical budget debit, and
sessions are rebound to current indexes. `resumePolicy: "positional"` is the migration escape hatch.
It requests index/prefix correspondence, not unsafe serving: new-format input/safety/environment
guards still apply. Exact historical hash-only serving is limited to marker-less/`legacyResume`,
manual `resumeJournal`, and same-run recovery.

One coordinated release:

| Package | Change | Bump |
| --- | --- | --- |
| `@automatalabs/shared-types` | safety/provenance/report types; checkpoint-capable `inputsHash` documentation; additive `WorkflowCallRecord` and `WorkflowRunResult` fields | minor |
| `@automatalabs/workflow-engine` | format/admission/seed/matcher/barrier/budget/session implementation; checkpoint-options fingerprint; manager-owned `resumeFromRunId` | minor |
| `@automatalabs/workflows` | DSL `agent().resume`, exec option/re-exports, SDK behavior | minor |
| `@automatalabs/mcp-server` | no SDK replay/fork surface is exposed | none |
| `@automatalabs/acp-agents` | none; the safety option is engine-owned and never reaches `RunOptions` | none |

Changesets call out the default resume-policy change, logical budget behavior in identity mode,
current-index session rebinding, exact environment gate, all-live unsafe non-git behavior, the
positional nested-workflow hardening, positional cache hits now emitting fresh journal callbacks,
new-format positional input-fingerprint/host-checkpoint gating, and the legacy positional exception.
Two further observable back-compat changes must be named explicitly: the §2.5 common
terminal-status gate now applies to marker-less/legacy sources, so an aborted (or `abortSignaled`)
legacy source serves nothing; and the §2.6 terminal-save drop of
inherited unvisited positional suffix rows means a double-hop pause flow's bridged tail now runs
live on the second hop where the previous latestRows-merged journal would have replayed it — a
fail-safe regression required so a paused positional-v1 artifact satisfies its own §2.5 rule-6
bijection on the next hop.

## 5. Test plan

### 5.1 `@automatalabs/shared-types`

- Type fixtures for every new union/interface and optional-field compatibility with old object
  literals.
- JSON fixtures proving old `JournalEntry`, `WorkflowCallRecord`, and `WorkflowRunResult` values
  parse without new fields and unknown new fields remain ignorable.

### 5.2 `@automatalabs/workflow-engine`

- **Byte compatibility:** existing `journal-hash.test.ts` passes unmodified; pinned
  `hashAgentCall`, `hashCheckpoint`, `hashCallInputs` bytes and `CALL_INPUTS_FORMAT` are unchanged
  whether `resume` is absent or set; new pinned `hashCheckpointInputs` bytes cover omission,
  `default`, `headless`, key ordering, and `timeoutMs`, with
  `CHECKPOINT_INPUTS_FORMAT === 1`; optional safety/report fields are omitted when unset; an old
  persisted-run byte fixture loads without source rewrite and selects legacy, while new
  initial/terminal JSON fixtures pin the marker, checkpoint-input format, and terminal-environment
  omission/presence rules.
- **Format/admission matrix:** absent marker -> legacy positional; safe v1 -> identity; a v1 source
  with an unsafe agent, headless checkpoint, or nested workflow selects
  positional-v1 when its required terminal environment is present; legacy-resume -> positional-v1;
  unsupported/malformed/aborted/missing terminal env/cwd or
  runtime or checkpoint-input-format mismatch/environment mismatch/source drift/invalid retained
  seed/isolation recording ->
  all live; positional eligibility is pinned for legacy/safe-prefix/all-live (including source
  drift and nested sources); explicit positional; nonexistent source and mutually-exclusive inputs
  fail before run creation; any result row missing path/input/debit disables the source so it cannot
  disappear as an ambiguity blocker; journal/result pairing is bijective, so a result row missing
  its journal also cannot disappear; root indexes must densely equal the manager-observed
  `callsAllocated`, including failed/paused runs, and every engine halt writes the interrupted rows
  needed to satisfy that invariant; a
  replay-origin agent row missing its provenance debit is
  invalid rather than falling back to physical zero; exact first-failure reason precedence is
  pinned.
- **Matching:** index insertion/deletion/reordering; exact path/hash; unique hash movement;
  agent and checkpoint input mismatch; missing path/input; permanent ambiguity for duplicate exact identities and
  duplicate content; consumed rows; empty-output guard; no path-only changed-hash serve;
  new-format positional input/safety mismatch lowers `firstMiss`, unsafe source rows never hit, and
  explicit positional mode can still index-match duplicate safe occurrences while legacy remains
  hash-only.
- **Fan-out:** 40 declared readers with two changed prompts -> 38 replay/2 live even when indexes
  shift; same unannotated fan-out -> positional with zero unsafe hits; 40 annotated actual
  worktrees -> 38/2; the same worktrees without the declaration remain positional; one degraded
  or throwing changed worktree closes the later cache before a serve; a lower matcher suspended on
  worktree creation cannot be overtaken by a higher-index agent/checkpoint replay decision.
- **Filesystem failures:** both §2.14 scenarios verbatim; terminal environment includes source
  side effects; source start/terminal drift makes positional fallback all-live; an unsafe writer
  that restores the tree is still the first safe-prefix miss; a current unsafe inserted call and a
  current nested workflow close all remaining agent/checkpoint candidates and injections
  synchronously; a live host checkpoint callback does the same, while engine-headless checkpoints
  run fresh without closing it; a cached/injected same-prompt checkpoint after an unsafe live writer
  cannot replay; positional nested invocation lowers
  `firstMiss` before the child; non-git safe runs
  retain the host key while every taint source omits terminal identity and resumes all-live;
  source-recording and resumed-run writer exclusion for git workspaces and every host-key resource
  are documented host preconditions.
- **Terminal quiescence:** floated agent, checkpoint, and zero-call/nested invocations each keep the
  absolute activity count non-zero at terminal save; worktree activity decrements only after
  cleanup; a timeout-losing runner that ignores abort retains its raw-promise unit after logical
  settlement. Every case omits terminal environment and later resumes all-live. Ordinary settled
  calls return the counter to zero and report dense root allocation counts even when the script
  throws; invalid/negative/non-monotonic transitions fail closed; a late decrement never retrofits
  the terminal file.
- **Checkpoints:** proven host decision replays with shifted indexes and preserves its provenance
  across multiple hops; injected reply keyed by source index reaches a shifted current checkpoint;
  a quiescent checkpoint pause with a unique validated reply remains identity-v1 and flattens its
  current rows plus inherited seed, while the same pause without an injectable reply falls back;
  changed/ambiguous checkpoint does not inject; changing `default`, `headless`, or `timeoutMs`
  makes an origin-`"confirm"` candidate live in both identity and safe-prefix positional modes;
  the concrete host timeout/default case from §2.14 is pinned; a same-`(hash, inputsHash)` source row
  of any outcome blocks injection and flattening retains that block; an earlier positional miss prevents even a
  corresponding shifted injection, and a served shifted positional injection closes the prefix
  immediately after itself; missing/non-canonicalizable checkpoint inputs cannot replay or inject;
  headless source rows are excluded, and changing a default executes the new default fresh;
  new-format safe-prefix treats headless as its
  first miss, while legacy positional headless replay stays compatible but cannot be laundered into
  identity; extra reply key rejects; source attribution is exact.
- **Sessions:** identity replay rewrites current index/label/phase only, preserves session identity,
  does not mutate source, and re-journals the rebound record; live and isolation session tests
  unchanged.
- **Persistence/crash:** background initial save contains the complete seed before acknowledgement;
  source lease is held through snapshot/target save and always released; lease contention fails
  before target creation;
  selected/invalidated candidates are durably removed before script observation; completion drops
  the seed while pause/failure retains only the remaining seed; flattening does not resurrect
  consumed or unsafe-suffix candidates; grandparent candidates keep their source provenance;
  multi-hop resume is self-contained; initial/commit save failure exposes no cached/live result,
  latches `PERSISTENCE_ERROR`, and prevents a catching script from continuing; manual
  `resumeJournal` and same-ID recovery use the throwing path to persist permanent `legacyResume`
  before replay and can never be admitted as identity sources; a completed → paused-at-changed-
  checkpoint → replied double-hop positional flow is pinned explicitly: the inherited unvisited
  tail runs live on the second hop because the paused artifact's terminal save dropped those
  suffix rows.
- **Manifest/report:** replay provenance records source/current index and match mode; live reasons
  cover every branch; agent replay provenance durably repeats and validates the selected source
  safety class without loading an older run; failed seed-write rows, counters, source-hop
  provenance, and ordering are exact; report present for paused/failed runs and absent for ordinary
  runs; no sensitive fields.
- **Isolation non-regression:** the complete existing `isolation.test.ts`, preflight matrix, reason
  arrays, settlement ordering, nested exclusion, ambiguous-identity rejection, and report fixtures
  pass unmodified. Add a focused shared-index test proving isolation still uses exact/path-only
  rules rather than the mainline hash-only fallback.

### 5.3 `@automatalabs/workflows`

- DSL declaration accepts only `{ filesystem: "read-only" }`; validator/mock manifest records the
  marker without sending it to the fake runner; a worktree records safety only when annotated and
  actually created, while an unannotated/degraded/failed worktree and every non-result row record
  none.
- SDK `runDynamicWorkflow`/manager paths expose `resumeFromRunId`/`resumePolicy`, reject invalid
  combinations, and re-export report types/constants.
- Existing same-run `WorkflowManager.resume()` remains positional, rejects the new options, emits
  no identity report, and permanently marks its artifact `legacyResume`.
- Updated read-only/worktree fan-out example validates; old examples validate with unchanged hash
  fixtures.

### 5.4 `@automatalabs/mcp-server`

- Discovery and runtime reject every SDK replay/fork field; only the strict same-ID `resume` branch
  accepts checkpoint replies.
- Foreground and background continuation keep the exact run ID and use the manager's canonical
  admission, journal, event stream, and cumulative usage.
- Structured results omit SDK correspondence reports and expose bounded same-ID continuation
  telemetry only.
- Authoring-doc generation/drift sentinels cover the same-ID rule.

## 6. Docs & skill updates

- `skills/agentprism-workflow-authoring/SKILL.md` and `reference.md`: replace the
  longest-prefix-only rule; document identity matching, input-fingerprint equality, unique-hash
  movement, ambiguity-to-live, terminal environment admission, safe-prefix/all-live positional
  eligibility, `resume.filesystem`, worktree behavior, budget debit, checkpoint reply source
  indexes, checkpoint-options fingerprint equality, host-decision-only identity replay (headless
  decisions run fresh), and the positional escape hatch. Also document the two author-visible
  all-live triggers that are calibration rather than error: a source containing any result row
  whose call path could not be captured (deep call stacks past the raw-frame cap, or a
  non-strict-JSON meta value) is source-wide `"manifest-invalid"` and resumes all-live; and a Node
  or V8 upgrade invalidates every new-format cache via exact runtime equality while legacy
  journals keep replaying — a future relaxation to positional-with-input-gates on runtime mismatch
  must ship under a new format literal, never by reinterpreting v1 bytes.
- `docs/api.md`: exact SDK/manager types, report/reason catalogs, and separate strict MCP contract,
  session rebinding, and the filesystem boundary.
- Root and package READMEs: one compact read-only/worktree fan-out example and link to API docs.
- `docs/roadmap/incremental-resume.md`: mark the direction item implemented by this contract.
- Regenerate `packages/mcp-server/src/generated/authoring-docs-content.ts` via the existing script
  and update drift tests/sentinels.
- Add a docs drift test over `RESUME_FALLBACK_REASONS`, `RESUME_DISABLED_REASONS`,
  `RESUME_CALL_LIVE_REASONS`, and `RESUME_CALL_FAILED_REASONS`.

## 7. Implementation breakdown

Seven PR-sized stages, each green and independently reviewable; they ship as the coordinated release
in §4 rather than publishing an intermediate surface:

1. **PR1 — shared additive contract.** Shared report/safety/provenance types and engine persisted
   format/seed types; reason constants; byte-compat fixtures. No matcher behavior or public option.
2. **PR2 — recording substrate.** DSL safety declaration, checkpoint-options fingerprint and
   format recording, manifest safety/provenance recording,
   filesystem-taint latch, root-wide logical/raw-runner activity and root-allocation accounting,
   quiescent terminal environment capture, persisted format marker, compaction, permanent legacy
   marking for manual/same-ID replay, and old-file/byte-compat fixtures. Resume serving remains
   positional. Implementation note: the §2.2 runtime validation compares against "that VM realm's
   `Object.prototype`", so the engine must capture the realm prototype at context creation.
3. **PR3 — unreachable matcher core.** Pure admission validation, candidate indexes,
   exact/unique-hash selection, ambiguity/consumption, seed normalization, report construction, and
   shared isolation-safe utilities behind internal tests; no public execution option activates it.
4. **PR4 — engine integration, still unreachable by default.** Consume manager-shaped
   `PreparedResume`; add re-journaling, session rebinding, logical budget debit, shifted checkpoint
   injection/pause continuation, the index-ordered decision chain, whole-cache filesystem/worktree/
   checkpoint/nested barriers, positional nested hardening, incremental decision reporting, and
   reports. Engine tests construct the internal shape directly; no manager creates it yet.
5. **PR5 — durable manager and SDK activation.** Manager-owned
   `resumeFromRunId`/`resumePolicy`, critical initial/commit persistence, pause/failure flattening,
   public SDK exports/validation, and background durability. This is the first default-cache
   behavior change and includes the 40-way fan-out, both filesystem counterexamples, and crash
   tests.
6. **PR6 — MCP boundary.** Keep the SDK replay controls out of MCP and test the separate strict
   same-ID continuation path.
7. **PR7 — docs/release/non-regression.** Skill/reference/API/README/roadmap updates, generated MCP
   prompt, reason drift tests, full isolation non-regression suite, and coordinated changesets.

No stage changes synchronous `callSeq` allocation order, call-hash/input-fingerprint bytes, or
isolation behavior. PR5
activates the new default only after every fail-to-live guard and critical persistence path is in
place.
