/**
 * The REPL orchestrator's broker — the host-side brain that wires a
 * workspace's guest bridge to real ACP subagent sessions through
 * `@automatalabs/acp-agents` (the roadmap doc's phase C: broker + call
 * store + eval semantics).
 *
 * `Broker.attach(workspace, options)` takes over a workspace's four
 * `__host_*` callbacks (the same by-name re-registration the snapshot-
 * restore path uses; the guest library and its pending-call registry are
 * untouched) and implements the doc's broker contract:
 *
 * - **`agent(modelSpec, task, opts)` dispatches a held-open ACP session**
 *   via the runner's `openSession` (the routing grammar, model spec and
 *   per-call cwd are the runner's own; the broker passes the guest's
 *   options through — `schema` is validated by acp-agents' own
 *   structured-output ladder, see "The guest options surface" below).
 *   Sessions stay open while any MCP client is connected to the project;
 *   on last-client disconnect the daemon drives the client-presence
 *   DRAIN (`drainForDisconnect` — the doc's policy: in-flight turns
 *   drain to completion, each settlement boundary snapshots, then idle
 *   children close; the concrete bound reuses the daemon's
 *   session-eviction TTL), and a later followUp/steer/cancel on a
 *   settled handle RE-ATTACHES the subagent session lazily via the
 *   capability matrix (`canLazyReattach`/`lazyReattach` — the doc's
 *   "followUp re-attaches the subagent session lazily").
 *   They are opened with `keepSession: true`, so the ACP session persists
 *   on the backend for the restore path's lazy re-attach; the moment a
 *   session opens, its backend session id AND resolved backend id are
 *   recorded in the call store
 *   (`recordAttached` — BEFORE the prompt is sent), so a crash with a
 *   turn in flight leaves a restore able to re-attach the session
 *   instead of re-issuing a call whose turn may still be running
 *   (duplicated work).
 * - **Six concurrent subagents per workspace** (the doc-settled cap).
 *   The cap counts live work: unsettled agent calls plus sessions
 *   running a follow-up turn (a queued-steer delivery turn or a §4.2
 *   followUp turn on a settled handle — a subagent is working even on a
 *   follow-up turn). The cap is ABSOLUTE for turn starts, not just
 *   dispatches: a dispatch over the cap QUEUES in dispatch order for
 *   the next free slot (§4.1 — never a rejection, matching the workflow
 *   engine's semantics), and a followUp/steer on an idle session whose
 *   start would exceed the cap queues on the same durable delivery
 *   queue (never a seventh concurrent turn, never a hard error).
 *   Queued delivery turns likewise start only while a slot is free; the
 *   kick (`kickQueuedDeliveries`) runs whenever a slot frees.
 *   `maxConcurrentAgents` is configurable (server configuration,
 *   invisible to the guest).
 * - **Steering resolves with what actually happened** (the doc's
 *   "nothing is hidden, nothing hard-errors", redesigned per §4.2):
 *   followUp/steer on a SETTLED or IDLE session mint a NEW turn with its
 *   own call id (visible in `agents()`/`liveAgents()`, targetable by
 *   `interrupt`) and resolve with the TURN'S ANSWER — the SAME value
 *   semantics as `agent()` (the founding handle's schema drives the
 *   schema-validated object; a schema-less handle resolves the final
 *   text), never the bare
 *   `startedNewTurn` token, never a discarded turn (idle-session `steer`
 *   is the followUp alias). A MID-TURN steer keeps the delivery-outcome
 *   vocabulary: `injected` where the backend advertises
 *   `_session/steering` (a backend `startedNewTurn` maps to `queued`),
 *   `queued` where it does not (next-turn delivery), `failed` on wire
 *   failure (see the steering mechanism table below).
 *   Queued-for-next-turn delivery is DURABLE: the steer's payload and
 *   founding session id live in the call store, and the store records
 *   each delivery turn's start (the `delivered` marker — recorded in
 *   the session's handoff acknowledgment, i.e. only once the prompt has
 *   passed every preflight AND the underlying ACP session/prompt
 *   request has actually been invoked: a crash before the
 *   acknowledgment — or an async pre-handoff rejection: released
 *   session, aborted signal, prompt-in-flight — leaves the steer
 *   undelivered-in-the-store, so reconcile re-queues it instead of
 *   skipping it forever) and each
 *   drop (`dropped`), so a crash between enqueue and delivery loses
 *   nothing and a restored broker replays undelivered steers without
 *   duplicating delivered ones (`reconcile()`'s queue rebuild arm).
 *   Steering calls NEVER hard-error: every backend/wire failure resolves
 *   `failed`; the only rejections are guest protocol violations.
 * - **The append-only call store** (`store.ts`): every call's outcome is
 *   recorded by call id BEFORE it is settled into the guest (transfer
 *   lesson 1 — exactly-once settlement across crashes). The pump's
 *   delivery loop is record → settle → consume; both sides are first-wins
 *   idempotent, so a crash between the store write and the guest
 *   settlement is healed by the next delivery attempt (and, across a
 *   restore, by `reconcile()`'s store arm).
 * - **The restore path's three-way reconciliation** (transfer lesson 1,
 *   phase D): `reconcile()` reads the in-VM pending-call registry and
 *   settles every outstanding call exactly one way — completed while
 *   down → settle from the store; still resumable at the backend →
 *   re-attach via `runner.loadSession` (the capability gate is the
 *   runner's own, per acp-agents' `supportsLoadSession`; a custom
 *   backend that omits it degrades through the same gate, surfaced
 *   guest-visibly); lost → re-issue under the same call id (bumping the
 *   store's reissues counter, never duplicating the guest promise). The
 *   re-attach decision keys on the backend session id the store
 *   recorded at session open; a re-attached call's completion is the
 *   loaded session's founding turn (`awaitCurrentTurn`), delivered
 *   through the same record → settle → consume pump as a live call.
 *   Pending checkpoints re-surface (answering works across a restore)
 *   and pending steers whose wire call died with the process resolve
 *   the honest `failed` (their outcome is unknowable; re-injecting
 *   would duplicate). See "The restore path" below.
 * - **The eval tool-result shape** (`Broker.eval`): output lines (the
 *   guest-rendered §4.4 one-line console reprs, raised-checkpoint lines,
 *   and the §4.6 uncaught-error renderings — NO output caps, the §7
 *   deletion), the repr'd completion value when the eval resolved (the
 *   depth-limited repr: direct strings whole, objects/arrays to depth 2,
 *   20 entries per level, nested strings head-limited at 200 chars), the
 *   pending call ids when it suspended (no fabricated value), the raised
 *   checkpoints (previewed questions), and the call ids this operation
 *   settled. Eval errors render with the error name and message, the
 *   guest stack's top frames with line numbers in the submitted code,
 *   and — for subagent-call errors — the call id and the resolved
 *   backend. Every completion value crossing into the tool result is
 *   rendered trap-free (transfer lesson 2): the result line is repr'd
 *   from the live completion handle through the previewer's own
 *   own-descriptor machinery — no guest getter is ever executed while
 *   rendering. The `_` result-history global is set after every eval
 *   that resolved with a value (§4.4; the `$N` capture globals are
 *   deleted).
 * - **Suspended-eval semantics** (transfer lesson 3, as pinned by the
 *   harness's R69 work): top-level `await` is accepted; an eval whose
 *   completion resolves within its drain reports the previewed value; one
 *   that suspends returns immediately with no fabricated value, listing
 *   the pending call ids; the continuation resumes at settlement like a
 *   `.then` (its output lands in the next tool result); a late uncaught
 *   rejection of a suspended completion surfaces as an error-level
 *   console line in the next tool result (the VM's rejection bridge,
 *   armed by the broker's `rejectionBridge` eval option); top-level
 *   `return` stays a syntax error (the VM layer's parser).
 * - **Checkpoints** (transfer lesson 4, §4.3): `checkpoint(question)`
 *   parks a promise and records the dispatch in the call store; the
 *   raise surfaces as a `checkpoint c9: <question>` line in the eval's
 *   output (the question as PLAIN head+tail metadata text — the
 *   double-JSON-quote fix) and in `workspace()`; `checkpoint.answer(id,
 *   value)` in a later eval records the answer and settles the parked
 *   promise within that eval — root-mediated by construction, first-
 *   wins, and never delivered to anything but the matching pending
 *   checkpoint.
 *
 * ## The restore path (phase D, spec-owed decisions)
 *
 * The roadmap doc's restore path — restore the VM, re-register host
 * callbacks by name, read the in-VM pending-call registry, and reconcile
 * each outstanding call three ways — is implemented here in full:
 *
 * 1. **Completed while down → settle from the store.** A pending call
 *    whose store record carries a completion settles from the store
 *    (the guest's idempotent settle-by-id makes a double delivery a
 *    no-op), whatever its kind.
 * 2. **Still resumable at the backend → re-attach.** A pending AGENT
 *    call with a recorded backend session id is re-attached via
 *    `runner.loadSession({ sessionId, model, cwd, … })` — the same
 *    open options the founding dispatch used, recovered from the
 *    registry entry (modelSpec + verbatim optionsJson). The
 *    capability gate is the runner's own, exactly as in acp-agents
 *    (`negotiateCapabilities().supportsLoadSession`; all four built-in
 *    backends advertise `loadSession: true` per docs/api.md, and a
 *    custom backend that omits it rejects the load before any wire
 *    request). The load routes by the store's RECORDED backend id (a
 *    backend id doubles as a model routing spec — never the current
 *    configured default; phase-D review round 2). On success the call's
 *    completion is the loaded session's founding turn, observed through
 *    `awaitCurrentTurn` — a REAL seam on the acp-agents adapter (phase-D
 *    review: the seam used to be absent from `InteractiveSession`, so
 *    every built-in backend loaded, released, and re-issued). Its
 *    completion evidence is the `_session/loaded_turn` vendor extension
 *    (phase-D review round 3 — the AUTHORITATIVE terminal channel the
 *    orchestrator required after rejecting both the quiet-grace
 *    heuristic, which durably settled an assistant PARTIAL as a
 *    completed-while-down turn when the next live chunk arrived later,
 *    and the blind re-issue, which duplicated a still-running backend
 *    turn): `session/load` obliges the agent to replay the entire
 *    persisted conversation and only then resolve the load; the runner
 *    marks the LOAD BOUNDARY at the response, and the seam asks
 *    `_session/loaded_turn/query` whether the founding turn is still
 *    running RIGHT NOW. `completed` — the turn observably ended while
 *    the daemon was down: the replay's trailing assistant message is
 *    its FINAL message, and the seam resolves immediately (the real
 *    accumulated text; `stopReason` synthesized as `end_turn` — the
 *    protocol's replay carries none, and the broker's own
 *    result-shaping gates still apply). `interrupted` — it ended
 *    without a terminal message and no turn is running: the SAFE-
 *    RE-ISSUE rejection class. `running` — the turn is still executing:
 *    the seam KEEPS THE LOADED SESSION ATTACHED and waits for the
 *    authoritative `_session/loaded_turn/ended` notification (a quiet
 *    gap is only a progress-stream gap, never terminal evidence),
 *    bounded by the max-wait backstop. A backend WITHOUT the extension
 *    (the built-in claude and opencode backends today) is classified by
 *    the seam's OBSERVATION path instead (phase-F review round 2 — the
 *    old degradation released the loaded session and re-issued the
 *    call, which can duplicate a still-running backend turn; re-issue
 *    is now reserved for the observably-dead classes): the post-load
 *    continuation watch (any CONTENT update after the load boundary is
 *    live continuation — the authoritative still-running signal, which
 *    flips the classification to the keep-attached wait) plus the
 *    replay probe under the CONNECTION-DEATH CONTRACT — the built-in
 *    ACP servers terminate in-flight turns when the client connection
 *    closes (live-verified) and their persisted transcripts hold only
 *    completed messages, so at restore the founding turn is never still
 *    running and the replay's trailing content is authoritative: an
 *    assistant message is the turn's terminal message (completed-while-
 *    down), anything else means it died mid-way (safe re-issue —
 *    nothing running, no duplication possible). A query failure on an
 *    extension backend falls through to the same observation path. The
 *    seam degrades to a
 *    rejection on: a transcript with no user message (the recorded
 *    session never received its prompt — safe re-issue), a
 *    released/dead session (safe re-issue — the process died with the
 *    turn), `interrupted` (safe re-issue), a load failure (capability
 *    absent, session deleted, wire failure), an unmarked handle (the
 *    boundary was never recorded), a `running` turn
 *    past the max-wait bound (re-armable `LoadedTurnStillRunningError`
 *    — the broker re-arms the seam on the still-attached session so a
 *    later notification or cancel still settles the call; the
 *    NON-re-armable form from a third-party seam (it can NEVER observe
 *    the terminal state) is NOT re-invoked — an immediate recursive
 *    re-arm would spin in an unbounded microtask/warning loop,
 *    starving cancellation, drain, and every other task — the broker
 *    instead waits for the terminal state from the session's own ended
 *    notification, the call's cancel, the session's release, or the
 *    drain's forced stop (phase-F review round 2: a possibly-running
 *    call is never re-issued), or a turn
 *    that failed at the backend
 *    (`LoadedTurnFailedError` — a definite outcome, settled as an
 *    ordinary rejection, never re-issued). While the broker is
 *    draining/disposing even safe-re-issue rejections resolve `hold` (a
 *    fresh child must never open and run after the last client
 *    disconnected — the drain's forced stop settles every still-pending
 *    call DURABLY at its bound, so a drained call is never left
 *    pending; a disposed broker's state is being torn down).
 *    A third-party `BrokerSession` adapter WITHOUT the seam degrades
 *    through the SAME re-issue fallback (the seam absence is a
 *    capability omission — re-attachment itself is unavailable there). The outcome is
 *    delivered through the SAME record → settle → consume pump as a
 *    live call — exactly once, first-wins on both sides (a held call's
 *    `hold` outcome drops the pump entry without recording or
 *    settling — the only `hold`s left are the drain/disposal fences,
 *    where the call was already settled durably by the drain's forced
 *    stop or the owning state is being torn down). A re-attached call
 *    holds a concurrency token until it settles, like any other live
 *    call.
 * 3. **Lost → re-issue.** A pending agent call with no recorded session
 *    (its session never opened, or a foreign snapshot), or whose
 *    re-attach failed, is re-issued under the SAME call id: the store
 *    records the reissue (`recordReissued` — the reissues counter
 *    bumps), a fresh session opens through the ordinary dispatch path,
 *    and the outcome settles the existing guest promise via the
 *    reconciliation surface. The re-issue is surfaced guest-visibly
 *    (a warn line naming the reason); a store-unknown entry (foreign
 *    snapshot / wiped store) is adopted first so the replay ledger
 *    stays complete. Re-issues respect the concurrency cap: an over-cap
 *    re-issue is refused with the recoverable `ConcurrencyLimitError`,
 *    recorded and settled exactly like a dispatch-time refusal.
 *
 * Everything else a restore finds in the registry:
 *
 * - **Pending checkpoints re-surface**: the broker re-registers them in
 *   its checkpoint table (the question + options travel inside the
 *   snapshot), so the tool result lists them again and
 *   `checkpoint.answer` settles them across the restore — through the
 *   reconciliation surface (a restored checkpoint has no live
 *   `GuestCall`; `PendingCheckpoint.call` is null on that path).
 * - **Pending steers whose wire call died with the process** (an
 *   injected steer, a delivery turn, or a cancel in flight at the
 *   crash) resolve the honest `failed` with a warn line: their outcome
 *   is unknowable, and re-issuing an injected steer would duplicate the
 *   injection. Queued-but-undelivered steers are the one deliberate
 *   exception — their payload is in the store, so the queue rebuild
 *   re-queues them exactly once (the phase-C durable-delivery arm).
 * - **Idempotence**: a call this broker already tracks (a repeated
 *   reconcile, a live in-flight task) is never re-attached or re-issued
 *   a second time — the report lists it as re-attached and the
 *   registry's first-wins settle makes any replay a no-op.
 *
 * ## The state-changing-boundary sink (phase D)
 *
 * The doc's snapshot cadence — a snapshot after each eval and after
 * each settlement drain that changed VM state — is delivered as
 * `BrokerOptions.snapshotSink`: `boundary(kind)` fires after every eval
 * and after every settlement drain that changed VM state, and
 * `flush()` fires at the end of each serialized broker operation — the
 * burst boundary. A sink that debounces (the daemon's snapshot writer,
 * `ReplWorkspaceStore.snapshotWriter`) therefore coalesces the
 * boundaries of one drain burst (a broker eval first pumps settled
 * calls and drains, then drains the eval itself — two boundaries in
 * one operation) into a single write, taken before the operation's
 * promise resolves. The debounced gap is always covered: settlements
 * are recorded in the call store BEFORE they settle, so a restore
 * replays them from the store arm; the eval itself is only visible
 * after the write. A drain that changed nothing fires nothing.
 *
 * ## The steering mechanism table (spec-owed decision)
 *
 * The roadmap doc's per-backend steering *mechanism* table is decided
 * here. The CURRENT per-backend inventory (the doc's owed decision,
 * sourced from the live capability probes in acp-agents —
 * `ACP_EXTENSION_SUPPORT_MATRIX` in `src/protocol-coverage.ts`, probed
 * by the protocol-coverage suite against the installed Claude/Codex
 * distributions, plus the live-verified initialize matrix in
 * `docs/api.md`):
 *
 * | Backend | `_session/steering` | Steering mechanism |
 * |---|---|---|
 * | claude | advertised (`_meta.steering.supported` probe, live-verified) | live injection via `session.steer()` |
 * | codex | advertised (same probe, live-verified) | live injection via `session.steer()` |
 * | pi | advertised (same probe; workspace-owned package tested in its own suite) | live injection via `session.steer()` |
 * | opencode | NOT advertised (`typed-unsupported` in the extension matrix — no safe driven wrapper) | queued-for-next-turn delivery |
 * | custom backend | whatever the agent's initialize response advertises (capability-gated per session) | live injection when advertised, queued delivery otherwise |
 *
 * The per-session capability is read ONCE at session open
 * (`session.capabilities.supportsSteering`); the mechanism table for one
 * session (§4.2):
 *
 * | Case | Mechanism | Outcome the handle resolves with |
 * |---|---|---|
 * | backend advertises `_session/steering`, turn in flight | `session.steer(content)` — live injection | `injected` (live injection); a backend `startedNewTurn` — the injection raced the turn's end and the backend started a new turn with the content — maps to `queued` (accepted for next-turn delivery; the v1 bare token never reaches the guest) |
 * | backend does NOT advertise steering, turn in flight | content enqueued for next-turn delivery | `queued` (immediately — accepted for next-turn delivery; if the call is later cancelled the queue is dropped, and a delivery-turn failure surfaces as a warn-level line in the next tool result — both documented) |
 * | ANY backend, session SETTLED or IDLE | `session.prompt(content)` — a NEW TURN with its own call id | the TURN'S ANSWER (the founding handle's schema drives the schema-validated object; a schema-less handle resolves the final text — the §4.2 semantics; a turn failure rejects the call with the §4.6 attribution) |
 * | ANY backend, session idle, but the workspace cap is exhausted | content enqueued for the next free slot (the same durable queue); the steer's promise stays pending | the TURN'S ANSWER once the delivery runs (a follow-up turn IS the subagent working — the six-agent ceiling is absolute) |
 * | any backend/wire failure on the steering path | — | `failed` (never a hard rejection) |
 * | the founding call is still OPENING (its session does not exist yet —
 *   a steer in the same eval as the dispatch) | content queued for the
 *   call's next-turn boundary | `queued` |
 * | no live session for the founding call at all (never opened, or lost) | — | `failed` (nothing was steered) |
 * | `cancel()` with a turn in flight | ACP `session/cancel` | `cancelled` (the cancelled call itself rejects with the recoverable `CancelledError`) |
 * | `cancel()` with the session idle | no-op — the agent is already stopped | `idle` |
 * | `cancel()` while the call is still opening | the opening call is fenced + settled durably as cancelled (a late child is closed without prompting) | `cancelled` (the call rejects with the recoverable `AGENT_CANCELLED`) |
 *
 * A MID-TURN steer resolves EXACTLY the delivery-outcome vocabulary
 * (`injected` / `queued` / `failed` — the backend's `startedNewTurn` maps
 * to `queued`, never the bare v1 token), with the cancel vocabulary
 * (`cancelled` / `idle`) for `cancel()`; IDLE-session followUp/steer
 * resolve with the turn's answer instead — the orchestrator can always
 * tell urgency delivery (injected) from next-turn delivery (queued),
 * which is the doc's stated requirement.
 *
 * ## The guest options surface (§4.1)
 *
 * `agent(modelSpec, task, opts)` accepts EXACTLY this option bag (any
 * other key rejects the call SYNCHRONOUSLY with an error that lists the
 * valid keys — an unknown option is a guest bug, never silently
 * ignored):
 *
 * - `schema` — a JSON Schema object; acp-agents validates per call (its
 *   own convert/check + re-prompt ladder, driven by the broker over the
 *   session). The schema reaches the backend through acp-agents' native
 *   channels exactly like `run()`: the broker passes it into session
 *   creation (`openSession({ schema })` folds it into session/new
 *   `_meta` where the backend carries it there — Claude), and
 *   acp-agents' `InteractiveSession.prompt` merges the backend-computed
 *   turn meta (the Codex `outputSchema` forward) and embeds the
 *   contract in the prompt text for backends that ignore the `_meta`
 *   forward (pi, custom). The one divergence from `run()` stays: the
 *   client-hosted StructuredOutput MCP capture tool is not injected on
 *   the interactive path; the native + prose-extraction channels are
 *   the same ladder.
 * - `cwd` — absolute working directory for the ACP session; defaults to
 *   the workspace's project directory.
 * - `configOptions` — ACP session config options (record of string |
 *   boolean, applied in sorted option-id order by the runner). Keys
 *   validate AT ADMISSION against the resolved backend's known option
 *   vocabulary where it is knowable (the runner's `knownConfigOptionIds`
 *   seam); where the vocabulary is genuinely dynamic, the [C]5 fallback
 *   guarantees the late error names the offending key.
 * - `mode` — the agent-advertised ACP session mode id (strict
 *   confinement lever).
 *
 * The §4.1 admission validation also resolves the model spec's backend
 * segment against the registry (built-ins plus registered custom
 * agents): an unknown segment rejects synchronously naming the segment
 * and enumerating the known backends — never a silent route to the
 * default backend. The guest's reserved `'default'` sentinel
 * (verify/judgePanel reviewers/graders) is host-routed.
 *
 * Steering payloads (`followUp`/`steer` options) accept exactly
 * `{ promptMeta }`.
 */

import type { JSValueHandle } from 'quickjs-wasi';
import {
  AcpAgentRunner,
  LoadedTurnFailedError,
  isLoadedTurnFailedError,
  isLoadedTurnStillRunningError,
  parseFinalJson,
  resolveStructuredOutput,
  type StructuredSession,
} from '@automatalabs/acp-agents';
import { isWorkflowError, WorkflowError, WorkflowErrorCode } from '@automatalabs/shared-types';
import { isAbsolute } from 'node:path';

import type { GuestBridgeHandlers, GuestCall, GuestSurfaceEntry } from './bridge.js';
import { instrumentTopLevelAwaits } from './await-instrument.js';
import { formatByteSize, headTailDescription, renderCompletionLine } from './preview.js';
import { InMemoryCallStore, type CallOutcome, type CallRecord, type CallStore } from './store.js';
import { DrainJobError, type ReplEvalOptions, type ReplEvalOutcome, type ReplJobLease } from './vm.js';
import { Workspace } from './workspace.js';
import type { EvalBreakChannel } from './eval-break-channel.js';
import type { EvalErrorInfo } from './errors.js';

// ────────────────────────────────────────────────────────────────────────
// Public types (all self-contained — the published declaration graph must
// stay free of acp-agents / quickjs-wasi types, per the package's
// consumer-fixture discipline)
// ────────────────────────────────────────────────────────────────────────

/** The outcome surface steering operations settle with (see module docs). */
export type SteeringOutcomeValue = 'injected' | 'queued' | 'cancelled' | 'idle' | 'failed';

/** Options for opening one subagent session (the broker's structural
 *  subset of the runner's `InteractiveSessionOptions`). */
export interface BrokerOpenSessionOptions {
  /** The model spec — routed by the runner's own grammar. */
  model?: string;
  /** The structured-output contract (a JSON Schema object) — folded into
   *  the backend's native schema channels by the runner's session
   *  (session/new `_meta` where the backend carries it there; the
   *  per-turn `_meta` forward and the in-band prompt contract come from
   *  the same value inside `InteractiveSession.prompt`). */
  schema?: unknown;
  /** Agent-advertised ACP session mode id (strict confinement lever). */
  mode?: string;
  /** ACP session config options, applied verbatim in sorted id order. */
  configOptions?: Record<string, string | boolean>;
  /** Coarse tier consulted only when `model` is unset. */
  tier?: string;
  /** Absolute working directory for `session/new`. */
  cwd: string;
  /** Event/telemetry label stamped onto this session's ACP events. */
  label?: string;
  /** Correlation id stamped into `session/new` `_meta`. */
  runId?: string;
  /** Generic session-scoped ACP `_meta` passthrough. */
  meta?: Record<string, unknown>;
  /** CODEX-ONLY base instruction override. */
  baseInstructions?: string;
  /** CODEX-ONLY developer instruction override. */
  developerInstructions?: string;
  /** Tool allow-list used by the headless permission auto-responder. */
  toolNames?: string[];
  /** Tool deny-list, applied after the allow-list. */
  disallowedToolNames?: string[];
  /** Skip the release-time session/close so the ACP session stays
   *  re-openable (the broker always passes true). */
  keepSession?: boolean;
  /** Keep accumulated text/history after each turn (the broker always
   *  passes true — the schema ladder and status need the final message). */
  retainSessionLog?: boolean;
}

/** Per-turn options (the broker's structural subset of the runner's). */
export interface BrokerPromptOptions {
  /** Generic turn-scoped ACP `_meta` passthrough. */
  promptMeta?: Record<string, unknown>;
  /** Handoff acknowledgment: the session invokes this exactly when the
   *  prompt has passed every preflight check (released session, aborted
   *  signal, prompt-in-flight) and is being handed to the underlying ACP
   *  session/prompt — the point of no return. The broker records its
   *  queued-steer `delivered` marker inside this callback: a marker
   *  recorded here can never precede the backend handoff (review
   *  regression: the marker used to be recorded when the prompt promise
   *  was CREATED, so an async pre-handoff rejection — released session,
   *  aborted signal, prompt-in-flight — produced a non-null marker for a
   *  steer the backend never saw, and reconcile then skipped that
   *  never-delivered steer permanently). */
  onHandoff?: () => void;
}

/** One completed interactive turn (the broker's structural stand-in for
 *  the runner's `InteractiveTurn`). */
export interface BrokerTurn {
  readonly stopReason: string;
  readonly text: string;
}

/** Options for re-attaching an existing backend session (the restore
 *  path's re-attach arm; structural subset of acp-agents'
 *  `ReattachSessionOptions` — the same open options as
 *  `BrokerOpenSessionOptions` plus the required backend `sessionId`). */
export interface BrokerLoadSessionOptions extends BrokerOpenSessionOptions {
  /** The existing backend session id to re-attach (ACP `session/load`). */
  sessionId: string;
}

/** A held-open ACP session (structural subset of the runner's
 *  `InteractiveSession` — what the broker drives). */
export interface BrokerSession {
  readonly sessionId: string;
  /** The RESOLVED backend id this session belongs to (the re-attach
   *  routing pin — a backend id doubles as a model routing spec, so a
   *  restore or lazy re-attach routes by it instead of re-resolving the
   *  model spec against the current default backend; phase-D review
   *  round 2). Optional for third-party adapters: when absent, the
   *  persisted backendId stays null and routing falls back to the
   *  persisted model spec. */
  readonly backendId?: string;
  /** The negotiated initialize capabilities; `undefined` degrades to
   *  "no steering" (the capability-gated honest fallback). */
  readonly capabilities?: { supportsSteering?: boolean };
  /** Send one prompt turn. Only one turn may be in flight at a time. */
  prompt(content: string, opts?: BrokerPromptOptions): Promise<BrokerTurn>;
  /** Inject content into the in-flight turn via `_session/steering`. */
  steer(content: string, opts?: BrokerPromptOptions): Promise<string>;
  /** Cancel the active turn (ACP `session/cancel`). */
  cancel(): Promise<void>;
  /** Release the ACP session and close its dedicated process (the
   *  session stays re-openable on the backend when it was opened with
   *  `keepSession: true`). Idempotent. */
  release(): Promise<void>;
  /** The latest turn's assistant text. */
  currentTurnText(): string;
  /** The latest turn's FINAL assistant message (schema extraction). */
  finalMessageText(): string;
  /** The backend's native structured output for the latest turn, if any. */
  rawStructuredOutput(): unknown;
  /**
   * The loaded session's founding-turn completion — the re-attach arm's
   * task source. REAL on the acp-agents adapter
   * (`InteractiveSession.awaitCurrentTurn`), whose completion evidence is
   * the `_session/loaded_turn` vendor extension (phase-D review round 3:
   * an AUTHORITATIVE terminal channel — the quiet-grace heuristic and
   * the blind re-issue were rejected): right after the `session/load`
   * response the seam asks `_session/loaded_turn/query` whether the
   * founding turn is still running, and the backend's answer is the
   * classification — `completed` (the replay's trailing assistant message
   * is the turn's FINAL message; resolves immediately with the real
   * accumulated text, `stopReason` synthesized `end_turn`), `interrupted`
   * (ended without a terminal message, nothing running — the
   * SAFE-RE-ISSUE rejection class), or `running` (the loaded session
   * stays ATTACHED and the seam waits for the authoritative
   * `_session/loaded_turn/ended` notification — a quiet gap is only a
   * progress-stream gap, never terminal evidence — bounded by the
   * max-wait backstop). A backend WITHOUT the extension (the built-in
   * claude and opencode backends today) is classified by the seam's
   * OBSERVATION path instead (phase-F review round 2): the post-load
   * continuation watch plus the replay probe under the connection-death
   * contract — never a possibly-running re-issue. A `running` turn past
   * the max-wait bound rejects with the `LoadedTurnStillRunningError`
   * (the broker re-arms the seam on the still-attached session for BOTH
   * forms — a possibly-running call is never re-issued); a turn that
   * failed at the backend rejects with `LoadedTurnFailedError` (a
   * definite outcome, settled as a rejection, never re-issued);
   * everything else (no user message, `interrupted`, a dead process) is
   * the safe-re-issue class (observably dead — re-issue cannot
   * duplicate). OPTIONAL for third-party `BrokerSession` adapters: an
   * adapter without the seam still re-attaches the session, then
   * degrades through the re-issue fallback — never a permanent hold
   * (re-attachment itself is unavailable there). A seam that rejects
   * with the still-running class and `rearmable: false` (it can NEVER
   * observe the terminal state) is NOT re-invoked: the broker keeps the
   * loaded session attached and waits for the terminal state from the
   * surfaces below (`loadedTurnEndedState`/`subscribeLoadedTurnEnded`,
   * `released`, the call's cancel, or the client-presence drain's
   * forced stop).
   */
  awaitCurrentTurn?(): Promise<BrokerTurn>;
  /** The loaded session's recorded founding-turn terminal state (the
   *  `_session/loaded_turn/ended` notification, when the backend pushed
   *  one — a seam-less backend that sends it anyway). The
   *  non-re-armable settlement wait's observability surface; OPTIONAL
   *  for third-party adapters that cannot observe it (the wait then
   *  settles only on a cancel, the drain's forced stop, or the
   *  session's release). */
  loadedTurnEndedState?(): { stopReason?: string; error?: { name: string; message: string } } | null;
  /** Watch the loaded-turn-ended channel (fires immediately for a
   *  notification that already arrived). Returns the unsubscribe
   *  thunk. OPTIONAL like `loadedTurnEndedState`. */
  subscribeLoadedTurnEnded?(listener: () => void): () => void;
  /** Resolve when the session is released (its dedicated process died
   *  or was disposed) — the non-re-armable settlement wait's release
   *  watch. OPTIONAL for third-party adapters that cannot expose it. */
  released?(): Promise<void>;
}

/** The runner seam the broker drives (structural subset of
 *  `AcpAgentRunner` — tests inject fakes). */
export interface BrokerRunner {
  /** Ids of every configured backend (built-ins plus registered custom
   *  agents) — the admission-validation vocabulary for the model spec's
   *  backend segment (§4.1: an unknown segment rejects synchronously,
   *  naming the segment and enumerating the known backends — never a
   *  silent route to the default backend). REQUIRED: every runner must
   *  publish its registry — validation runs on every dispatch path. The
   *  real acp-agents runner exposes `listBackends()`. */
  listBackends(): string[];
  /** The configured DEFAULT backend id (a REGISTERED segment) — the
   *  host's own routing for an omitted model. The broker serves it to
   *  the guest library (`__host_default_backend`), where the
   *  verify/judgePanel combinators resolve their reviewer/grader spec
   *  through it (§4.7 — the workers inherit the run's default model as
   *  a REAL registered segment; the v1 reserved 'default' sentinel that
   *  bypassed registry validation is deleted). The real acp-agents
   *  runner exposes `defaultBackendId()`. */
  defaultBackendId(): string;
  /** A backend's STATIC config-option vocabulary, when its adapter
   *  publishes one (§4.1: `configOptions` keys validate at admission
   *  against the resolved backend's known vocabulary WHERE IT IS
   *  KNOWABLE). Returning `undefined` means the vocabulary is genuinely
   *  dynamic (agent-advertised at initialize — the built-ins) and the
   *  [C]5 fallback applies: the late error MUST name the offending key.
   *  Returning an array means the vocabulary is known: an unknown key
   *  rejects synchronously naming the key and the valid alternatives. */
  knownConfigOptionIds?(backendId: string): string[] | undefined;
  openSession(opts: BrokerOpenSessionOptions): Promise<BrokerSession>;
  /**
   * Re-attach an existing backend session (ACP `session/load`) — the
   * restore path's re-attach arm. Capability-gated per acp-agents
   * (`negotiateCapabilities().supportsLoadSession` — all four built-in
   * backends advertise it per docs/api.md): a backend that does not
   * advertise the capability rejects before any wire request (the
   * "same gate" a custom backend degrades through), and a lost/deleted
   * session rejects with the backend's error. Either way the broker
   * degrades to re-issue, surfaced guest-visibly.
   */
  loadSession(opts: BrokerLoadSessionOptions): Promise<BrokerSession>;
  dispose(): Promise<void>;
}

/** The eval tool-result shape. NOTE: the eval-plane redesign's §3.1 wire
 *  shape (`{ output: string, result?, running? }`) lands in the tool
 *  phase — this engine seam keeps its pre-redesign field names until the
 *  surface phase deletes them with their consumers, but the CONTENT is
 *  the redesigned one: `output` lines are the §4.4 reprs (one joined
 *  line per console.* call), raised-checkpoint lines, and the §4.6
 *  uncaught-error renderings, with NO output caps applied. */
export interface ReplEvalResult {
  /** Rendered output lines for this operation (one line per console.*
   *  call, checkpoint lines, error renderings) — NOT capped: the engine
   *  stops applying output caps to guest output (the redesign's §7; the
   *  Python posture — an agent CAN flood its own context). */
  output: string[];
  /** ALWAYS false (vestigial — the cap apparatus is deleted; the field
   *  stays only until the surface phase removes it with its consumers). */
  outputTruncated: boolean;
  /** The previewed completion value when the eval resolved (FORMAT.md
   *  collapsed rendering, trap-free); absent when the eval suspended or
   *  threw. */
  result?: string;
  /** Pending call ids (the whole guest registry, in order) — non-empty
   *  exactly when the eval suspended (or when other work is in flight). */
  pending: string[];
  /** Checkpoints raised and still awaiting an answer. */
  checkpoints: CheckpointSummary[];
  /** Call ids settled into the guest by this operation: the pump's
   *  deliveries plus dispatch-time refusals during the eval. Checkpoint
   *  answers are deliberately excluded (an answered id leaves the
   *  `checkpoints` list — that is its visibility). */
  completed: string[];
}

/** One pending checkpoint as the tool result carries it: the question
 *  PREVIEWED through the top-level string rule (quoted, head+tail
 *  elided past 200 chars — guest-chosen text never crosses into the
 *  intent plane verbatim and unbounded; the id stays exact). */
export interface CheckpointSummary {
  id: string;
  question: string;
}

/** A pending checkpoint as the broker tracks it (raw question — the
 *  broker's internal table, not the tool-result surface). */
export interface CheckpointInfo {
  id: string;
  question: string;
  optionsJson: string | null;
  raisedAtMs: number;
}

/** One live subagent as `status` carries it. */
export interface LiveAgentInfo {
  /** The founding call id (the session's steering address). */
  callId: string;
  modelSpec: string;
  task: string;
  /** `opening` — session being opened, or a followUp turn whose
   *  founding session is still being re-attached (listed from mint
   *  time); `running` — initial turn in
   *  flight; `delivering` — a queued-steer turn in flight; `queued` —
   *  a followUp turn waiting for a free concurrency slot (visible and
   *  targetable before its delivery starts); `idle` — call settled, no
   *  turn running. */
  state: 'opening' | 'running' | 'delivering' | 'queued' | 'idle';
  supportsSteering: boolean;
  queuedSteers: number;
}

/** What the store-arm reconciliation did with each pending guest call. */
export interface ReconcileReport {
  /** Completed while down → settled now from the store. */
  settledFromStore: string[];
  /** Still resumable at the backend → re-attached via `loadSession`
   *  (including calls this broker already tracks — a repeated
   *  reconcile never re-attaches or re-issues twice). */
  reattached: string[];
  /** Lost → re-issued under the same call id (fresh session, the
   *  reissues counter bumped, the outcome settling the existing guest
   *  promise exactly once). */
  reissued: string[];
  /** Pending calls whose outcome is unknowable: steers whose wire call
   *  died with the process (settled `failed` with a warn line), and
   *  re-issue refusals (a corrupt registry entry, or the concurrency
   *  cap exhausted at restore). */
  failedLost: string[];
  /** Pending checkpoints re-surfaced into the broker's checkpoint
   *  table (answerable again across the restore). */
  requeuedCheckpoints: string[];
  /** Calls neither settled nor re-attached nor re-issued. Empty once
   *  all three arms ran (kept for report-shape compatibility with the
   *  store-only reconcile). */
  leftPending: string[];
  /** Queued-for-next-turn steers the store showed as accepted but
   *  undelivered (completion `queued`, no delivered/dropped marker) —
   *  re-queued against their founding sessions (or held for the
   *  session's next open), so a crash between enqueue and delivery
   *  loses nothing. Delivered and dropped steers are never replayed
   *  (the markers are first-wins). */
  reQueuedUndelivered: string[];
}

/** What kind of state-changing boundary fired (the doc's snapshot
 *  cadence: after each eval, and after each settlement drain that
 *  changed VM state). */
export type SnapshotBoundaryKind = 'eval' | 'settlement';

/** One manifest binding (the broker-enriched form; see
 *  `Broker.workspaceManifest`). */
export interface WorkspaceManifestBinding {
  name: string;
  /** Structure-only token — for an agent handle, `agent handle ·
   *  pending|settled · call <id> · <size>` (the live-handle status
   *  appended from the call store; the id maps to the task and
   *  timestamps). Every token carries the binding's byte size (phase-E
   *  review rejection: the token used to omit size for primitives,
   *  null, functions and plain promises). */
  token: string;
  /** The machine-readable structure-only type label (`string`,
   *  `number`, `object`, `array`, `agent handle`, … — see preview.ts's
   *  `manifestTypeLabel`): the structured manifest's type field, so a
   *  structured consumer never has to parse the token (phase-E review
   *  round 4: the type used to live only inside the formatted token). */
  type: string;
  /** The trap-free byte-size estimate of the binding's value — the
   *  doc's manifest contract is name, type, AND size for every
   *  top-level binding; exposed as its own field so a structured
   *  consumer never has to parse the token (phase-E review rejection:
   *  the broker exposed no separate size field). 0 only for the
   *  unreadable accessor/sabotage cases. */
  sizeBytes: number;
  /** The stable call id when the binding is an agent handle; null
   *  otherwise (the engine reports it — the broker no longer embeds
   *  the call id only inside the token string; phase-E review round
   *  4: the call id used to be discarded from the structured
   *  surface). */
  handleCallId: string | null;
  /** The LIVE-HANDLE STATUS of an agent-handle binding, read from the
   *  call store: `pending` while the founding call is unsettled,
   *  `settled` once it completed (phase-E review round 4: the status
   *  used to be embedded only in the human token and was absent from
   *  the structured surface). Null for non-handle bindings. */
  handleStatus: 'pending' | 'settled' | null;
  /** The sanitized provenance label (`eval 3`, `worker c2`, `session
   *  restore`), or null when untracked. */
  provenance: string | null;
  /** Wall clock of the provenance attribution (ms since epoch). */
  provenanceAtMs: number | null;
  /** The task text behind a worker provenance (`worker c1` → the
   *  founding agent() call's task, read from the call store) or an
   *  agent-handle binding's founding call — the doc's "from what task"
   *  provenance half. Null when the provenance is not worker-shaped or
   *  the store record is missing. Capped at 200 chars (head+tail) so
   *  the manifest stays bounded metadata. */
  task: string | null;
}

/** The broker-enriched workspace manifest (`Broker.workspaceManifest`). */
export interface WorkspaceManifestReport {
  bindings: WorkspaceManifestBinding[];
  /** The `$N` log-ref globals as a range. */
  logs: { first: number | null; last: number | null; count: number };
  /** The provenance registry's snapshot-durable eval counter. */
  evalSeq: number;
  /** In-flight host-task call ids (dispatch order). */
  inFlight: string[];
  /** Pending checkpoints (raw questions — the tool result previews). */
  checkpoints: CheckpointInfo[];
}

/** The state-changing-boundary sink (see the module docs' "The
 *  state-changing-boundary sink" section): `boundary(kind)` fires at
 *  every doc-defined boundary; `flush()` fires at the end of each
 *  serialized broker operation (the burst boundary) so a debouncing
 *  writer coalesces one drain burst's boundaries into one write. */
export interface SnapshotSink {
  /** A state-changing boundary occurred. */
  boundary(kind: SnapshotBoundaryKind): void;
  /** The current burst ended — flush any debounced write now. */
  flush(): void;
}

/** Options for attaching a broker to a workspace. */
export interface BrokerOptions {
  /** The ACP runner (structural subset of `AcpAgentRunner`; fakes for
   *  tests). Defaults to a bare `AcpAgentRunner` owned by this broker
   *  (disposed with it); hosts with a backend registry pass their own
   *  configured runner and own its lifetime (the broker still RELEASES
   *  every session it opened before dropping its state). */
  runner?: BrokerRunner;
  /** The append-only call store. Defaults to `InMemoryCallStore`. */
  store?: CallStore;
  /** The concurrency cap: max concurrent subagents per workspace
   *  (doc-settled default 6). Counts unsettled agent calls plus sessions
   *  running a follow-up turn (a queued-steer delivery or a §4.2
   *  followUp turn on a settled handle). The cap gates turn starts as
   *  well as dispatches: a dispatch above it queues in dispatch order
   *  (§4.1 — never a rejection), and an idle-session follow-up that
   *  would exceed it queues for the next free slot (its promise stays
   *  pending until the delivery runs). Validated as an
   *  integer in
   *  `[1, DEFAULT_MAX_CONCURRENT_AGENTS]`: invalid values (NaN,
   *  fractional, < 1) throw at attach time; values ABOVE the doc-settled
   *  ceiling are clamped to it (the ceiling is absolute — a
   *  misconfigured host can never open a seventh subagent). */
  maxConcurrentAgents?: number;
  /** Per-eval and per-settlement-drain interrupt handler (a runaway
   *  guest continuation stays bounded). Also the DEFAULT interrupt
   *  handler for evals: a direct eval that runs away is interrupted
   *  with this signal unless the caller passes a per-eval handler. When
   *  omitted, the broker's own wall-clock EVAL DEADLINE bounds every
   *  eval and drain (the harness's eval guard — the doc's "break a
   *  runaway eval (the quickjs interrupt handler)": a runaway eval is
   *  interrupted by the quickjs interrupt handler once it exceeds the
   *  budget, the VM stays usable, and the currently-running eval can
   *  never hang the workspace forever — see `evalTimeoutMs`). */
  interruptHandler?: () => boolean;
  /** The per-eval wall-clock deadline in ms (the harness's eval guard;
   *  phase-D review round 2: the interrupt tool's armed signal alone
   *  could only break the NEXT VM execution, because a synchronous
   *  runaway eval blocks the event loop before a later MCP request can
   *  arm it — the deadline makes the CURRENTLY running eval always
   *  breakable through the quickjs interrupt handler). Applied to every
   *  eval and every settlement drain; a `null`/`0` value disables the
   *  deadline. Default `DEFAULT_EVAL_TIMEOUT_MS` (30 000). */
  evalTimeoutMs?: number;
  /** The OUT-OF-BAND eval-break channel (phase-F review round 2): the
   *  interrupt tool's no-id path deliverable to a SYNCHRONOUSLY running
   *  eval. A never-yielding eval blocks the daemon's single thread, so
   *  the interrupt request itself cannot be processed — the channel's
   *  worker thread receives the break (via its loopback HTTP endpoint)
   *  and sets a shared-memory flag that every eval execution's quickjs
   *  interrupt handler consumes mid-run (see `eval-break-channel.ts`).
   *  The probe is composed into every execution — fresh evals AND
   *  settlement drains — with the arm-after-start rule: a break armed
   *  after the execution began breaks it; a stale break (armed while
   *  the workspace was idle) is dropped on first observation and never
   *  breaks a later eval. The daemon's interrupt handling clears the
   *  flag once it processes the request (the continuation-targeted
   *  signal owns the break from then on). */
  evalBreakChannel?: EvalBreakChannel;
  /** The state-changing-boundary sink (see the module docs): the
   *  daemon wires it to `ReplWorkspaceStore.snapshotWriter(workspace,
   *  wasm)` so every doc-defined boundary — after each eval, after
   *  each settlement drain that changed VM state — persists the
   *  workspace, with one drain burst's boundaries debounced into a
   *  single atomic write. */
  snapshotSink?: SnapshotSink;
}

// ────────────────────────────────────────────────────────────────────────
// Internal shapes
// ────────────────────────────────────────────────────────────────────────

/** One in-flight host task (an agent call or a steering operation): the
 *  outcome promise plus a readiness flag flipped by a microtask when the
 *  promise settles — the pump's poll-shaped readiness probe. */
interface InFlightTask {
  callId: string;
  /** `agent` tasks release their session's concurrency token and start
   *  queued-steer delivery when the pump delivers them; `steer` tasks
   *  do not. */
  kind: 'agent' | 'steer';
  /** `resolve`/`reject` deliver a record → settle → consume outcome;
   *  `hold` (the re-attach arm's unobservable-turn degradation) deletes
   *  the in-flight entry WITHOUT recording or settling — the call stays
   *  pending, the session stays attached (cancelable), and the broker
   *  surfaces the condition guest-visibly. */
  promise: Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }>;
  done: boolean;
}

/** The broker's per-session state. */
interface SessionEntry {
  session: BrokerSession;
  /** The founding call id (the session's steering address). */
  callId: string;
  modelSpec: string;
  task: string;
  /** The RESOLVED backend id (the session's own when it advertises one,
   *  else the admission-validated model-spec segment) — the §4.6 error
   *  attribution for followUp turns on this session. */
  backendId: string;
  supportsSteering: boolean;
  /** True while a turn runs on this session (initial call turn or a
   *  queued-steer delivery turn). */
  busy: boolean;
  /** True while the busy turn is a queued-steer delivery turn. */
  delivering: boolean;
  /** True once the founding call settled (resolved or rejected). */
  callSettled: boolean;
  /** True when the founding call was cancelled — the queue is dropped. */
  callCancelled: boolean;
  /** Waiters woken when the entry's cancel flag flips (the
   *  non-re-armable settlement wait's cancel signal — see
   *  `markCancelled`). One-shot listeners, removed on fire. */
  readonly cancelWaiters: Set<() => void>;
  /** Queued followUp/steer payloads (no-extension backends with a turn
   *  in flight, and cap-pressure queues on idle sessions), in order. */
  queue: Array<QueuedDelivery>;
}

/** One queued delivery (a mid-turn no-extension steer, or a cap-pressure
 *  followUp/steer on an idle session). `answer: true` marks the §4.2
 *  followUp semantics: the steer's guest call stays PENDING until the
 *  delivery turn runs and settles with the TURN'S ANSWER (its own call
 *  id — the addressable turn); `answer: false` items already resolved
 *  `queued` at enqueue (the delivery-outcome vocabulary for mid-turn
 *  steers) and their delivery folds into the session's next turn. */
interface QueuedDelivery {
  callId: string;
  prompt: string;
  promptMeta?: Record<string, unknown>;
  /** The GuestCall to settle with the turn's answer (answer mode only;
   *  null for delivery-outcome items). */
  call: GuestCall | null;
  /** True for the §4.2 followUp-answer semantics; false for the
   *  delivery-outcome semantics. */
  answer: boolean;
}

/** A steer that arrived before its session existed (the founding call
 *  was still opening), delivered at the call's next-turn boundary. The
 *  guest call already resolved `queued` at enqueue (the delivery-
 *  outcome vocabulary — the founding turn has not even started). */
interface PendingSteer {
  callId: string;
  prompt: string;
  promptMeta?: Record<string, unknown>;
  /** Answer-mode items (a cap-pressure followUp whose guest call is
   *  still pending — the §4.2 turn-answer semantics) keep their mode
   *  through a re-home into `pendingSteers` (the re-issue/drain path);
   *  delivery-outcome items (already settled `queued`) carry false. */
  answer: boolean;
}

/** A pending checkpoint as the broker tracks it (the GuestCall is the
 *  settlement target — kept separate from the agent/steer call table so
 *  an answer can never settle a call that shares the id space; NULL on
 *  the restore path, where the checkpoint re-surfaced from the in-VM
 *  registry and answers settle through the reconciliation surface). */
interface PendingCheckpoint {
  callId: string;
  call: GuestCall | null;
  question: string;
  optionsJson: string | null;
  raisedAtMs: number;
}

/** The validated guest options bag (§4.1: the guest may pass EXACTLY
 *  `{ schema, cwd, configOptions, mode }` — any other key rejects
 *  synchronously listing the valid keys). */
interface ParsedAgentOptions {
  schema?: Record<string, unknown>;
  cwd?: string;
  configOptions?: Record<string, string | boolean>;
  mode?: string;
}

/** The exact option keys the guest may pass (§4.1). */
const AGENT_OPTION_KEYS = new Set(['schema', 'cwd', 'configOptions', 'mode']);
/** The human-readable valid-keys list for admission errors. */
const AGENT_OPTION_KEYS_TEXT = 'schema, cwd, configOptions, mode';

/** The exact option keys a steering payload may carry. */
const STEER_OPTION_KEYS = new Set(['promptMeta']);

/** Default per-workspace concurrency cap (the doc-settled limit). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 6;

/** Default per-eval wall-clock deadline in ms (the harness's eval guard;
 *  see `BrokerOptions.evalTimeoutMs`). */
export const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

/** Default teardown ceiling in ms for `Broker.dispose` (spec-owed
 *  decision: the daemon's shutdown deadline is 5 s — the engine's own
 *  default mirrors it, so a hung backend can never block reset/shutdown
 *  past this bound even when the caller passes no explicit bound; the
 *  daemon's shutdown path shares ONE deadline across the drain and the
 *  disposal and passes the remaining time instead). */
export const DEFAULT_DISPOSE_BOUND_MS = 5_000;

/** The error-code vocabulary the broker rejects with (shared-types'
 *  `WorkflowErrorCode`, kept in lockstep with the runner's own errors). */
const CODE = WorkflowErrorCode;

// ────────────────────────────────────────────────────────────────────────
// The broker
// ────────────────────────────────────────────────────────────────────────

/**
 * The broker: wires a workspace's guest bridge to real ACP sessions
 * (see the module docs for the full contract). Attach it to take over a
 * workspace:
 *
 * ```ts
 * const ws = await Workspace.create(projectDir);
 * const broker = await Broker.attach(ws, { runner });
 * const result = await broker.eval('const pi = agent("pi/deepseek-v4-flash-max", "research X")');
 * ```
 *
 * Operations serialize (eval/pump/reconcile/dispose run one at a time),
 * so two overlapping tool calls can never interleave their settlement
 * bookkeeping.
 */
export class Broker {
  /** The workspace this broker drives. */
  readonly workspace: Workspace;
  /** The configured concurrency cap. */
  readonly maxConcurrentAgents: number;

  private readonly runner: BrokerRunner;
  private readonly ownsRunner: boolean;
  private readonly callStore: CallStore;
  private readonly interruptHandler: (() => boolean) | undefined;
  private readonly evalTimeoutMs: number;
  private readonly evalBreakChannel: EvalBreakChannel | undefined;
  /** The workspace's eval-break slot REGISTRATION ACK (phase-F review
   *  round 4): resolves once the relay worker applied the key→slot
   *  mapping; every serialized operation awaits it before touching the
   *  VM (`runSerialized`). Rejects when the worker dies before
   *  acknowledging — operations swallow the rejection and degrade to
   *  the per-eval deadline bound. */
  private readonly evalBreakReady: Promise<void>;
  private readonly sink: SnapshotSink | undefined;
  private readonly consoleBuffer: Array<{ level: string; line: string }> = [];
  private readonly sessions = new Map<string, SessionEntry>();
  /** Steers that arrived before their session existed (the founding call
   *  was still opening) — merged into the session's queue at open. */
  private readonly pendingSteers = new Map<string, PendingSteer[]>();
  /** Lazy re-attaches in flight (a settled handle's followUp/steer/cancel
   *  loading its recorded backend session) — deduped per founding call id
   *  so concurrent steers share one load. */
  private readonly pendingReattaches = new Map<string, Promise<SessionEntry | undefined>>();
  private readonly checkpoints = new Map<string, PendingCheckpoint>();
  /** Live GuestCalls by call id — the pump's settlement targets. */
  private readonly deferreds = new Map<string, GuestCall>();
  /** In-flight host tasks (agent calls and steering ops). */
  private readonly inFlight = new Map<string, InFlightTask>();
  /** Unsettled agent call ids — one concurrency token each. */
  private readonly agentSlots = new Set<string>();
  /** §4.1: dispatches QUEUED above the concurrency cap, in dispatch
   *  order — never a rejection. Each entry carries everything the
   *  dispatch needs; `kickDispatchQueue` starts them as slots free.
   *  Restore-time RE-ISSUES queue through the same structure (a lost
   *  call re-issued above a tightened cap stays PENDING in the guest
   *  registry until the kick — §4.1's queue-above-cap applies to every
   *  dispatch path, never a `ConcurrencyLimitError`). */
  private readonly dispatchQueue: Array<
    | {
        kind: 'dispatch';
        call: GuestCall;
        callId: string;
        modelSpec: string;
        task: string;
        optionsJson: string | null;
        parsed: ParsedAgentOptions;
      }
    | {
        kind: 'reissue';
        entry: GuestSurfaceEntry;
        parsed: ParsedAgentOptions;
        reason: string;
        report: ReconcileReport;
      }
  > = [];
  /** The cached known-backend vocabulary (see `knownBackends`). */
  private knownBackendsCache: string[] | undefined;
  /** In-flight FOLLOW-UP turns (an idle/settled session's followUp/
   *  steer), keyed by the turn's OWN call id — the §4.2 addressable
   *  turn: visible in `agents()`/`liveAgents()`, targetable by
   *  `interrupt`. `queued` marks a minted turn whose delivery is
   *  waiting for a free concurrency slot (enrolled at mint time — the
   *  turn is visible and interruptable BEFORE it starts). `entry` is
   *  undefined while the turn's founding session is still being
   *  re-attached (a followUp on a drained settled handle mid-load, or
   *  a restored queued turn whose founding session is not attached
   *  yet) — the turn is REGISTERED from mint time either way (the
   *  review defect: the lazy-load turn used to be registered only once
   *  `loadSession` finished, hiding the minted call from `agents()`
   *  and `interrupt` during a delayed load). `cancelRequested` marks
   *  an interrupt that landed during that load: the load's completion
   *  settles the steer with the recoverable AGENT_CANCELLED instead of
   *  starting the turn. */
  private readonly followUpTurns = new Map<
    string,
    {
      entry: SessionEntry | undefined;
      /** The founding call id (the session key) — always known, even
       *  while the session itself is being re-attached. */
      sessionId: string;
      prompt: string;
      queued: boolean;
      /** The resolved backend id for the §4.6 attribution (the
       *  founding session's own when attached, else the founding
       *  store record's) — carried so cancelling a not-yet-attached
       *  turn still names the backend. */
      backendId?: string;
      /** An interrupt landed while the lazy re-attach load was in
       *  flight: the load's completion must settle the steer with the
       *  recoverable AGENT_CANCELLED — never start the turn. */
      cancelRequested?: boolean;
    }
  >();
  /** Live `sleep(ms)` calls, keyed by host-minted tracking ids (not
   *  guest call ids — sleeps never enter the guest registry or the call
   *  store). */
  private readonly sleepCalls = new Map<string, { call: GuestCall; done: boolean }>();
  private sleepSeq = 0;
  /** The `reset()` request (see the eval handler): the teardown runs
   *  after the current eval completes. SCOPED to the eval being
   *  executed: cleared at the start of every eval op, so an unrelated
   *  later eval never inherits an earlier eval's request (the review
   *  defect: the workspace-global flag inserted EVERY later suspending
   *  eval into `resetOwningCompletions`, delaying the teardown behind
   *  unrelated suspended evals — the workspace kept running guest code
   *  after the reset-owning eval completed). A reset() called from a
   *  RESUMED continuation is attributed to the reset-calling eval's
   *  completion wrapper immediately, through the executing job's
   *  continuation token (see the reset handler) — the flag is only the
   *  code-phase snapshot. */
  private resetRequested = false;
  /** The reset-requesting evals' retained SUSPENDED completions (a
   *  reset() owes its teardown AFTER the eval completes — a reset eval
   *  that suspended tears down only once its continuation settles; the
   *  sweep observes the settlement and flips `resetDue`). */
  private readonly resetOwningCompletions = new Set<JSValueHandle>();
  /** The teardown owed by a completed reset eval, flipped by the sweep
   *  (or by `eval` for an in-call completion) and consumed by the
   *  serialized-op post-hook (`resetIfDue`) — OUTSIDE the chain slot
   *  (the disposal acquires the chain itself). */
  private resetDue = false;
  /** The retained last settlement-drain error (workspace().diagnostics).
   *  — the §6.2 demotion: drain failures leave the eval result surface
   *  entirely and live under the diagnostics field. */
  private retainedDrainError: { name: string; message: string; atMs: number } | null = null;
  /** The retained last reconcile summary (workspace().diagnostics —
   *  the §6.2 demotion). */
  private lastReconcileReport: ReconcileReport | null = null;
  /** Sessions running a follow-up turn (a queued-steer delivery turn or
   *  a §4.2 followUp turn on a settled handle) — one concurrency token
   *  each (a subagent is working even on a follow-up turn). */
  private readonly deliverySlots = new Set<string>();
  /** Call ids settled synchronously at dispatch (refusals) since the
   *  last eval result — reported in that eval's `completed`. */
  private readonly syncSettled: string[] = [];

  /** Completion wrappers of SUSPENDED evals whose continuation is still
   *  in flight (see `eval`): the wrapper settles when the continuation
   *  completes or is broken — the broker's "an eval is running" probe.
   *  This is the interrupt tool's eval-break TARGET surface (phase-E
   *  review rejection: the no-id interrupt used to arm a project-wide
   *  "next VM execution" boolean with no notion of a running eval, so
   *  an idle workspace's next eval — or an unrelated drain — consumed
   *  it; the doc's "break a runaway eval" requires a tracked,
   *  targetable running eval). Handles are owned by the broker;
   *  released by `sweepActiveEvals` when they settle and by `dispose`.
   *  A suspended eval stacks alongside earlier ones (each suspension
   *  retains its own wrapper). */
  private readonly activeEvalCompletions = new Set<JSValueHandle>();
  /** The per-eval CONTINUATION TOKEN (`e1`, `e2`, …): minted per eval
   *  (see `runEval`), embedded in the instrumented code's
   *  `__replAwait(value, token)` calls, and attributed to the eval's
   *  completion wrapper when it SUSPENDS. The token is the eval-break
   *  signal's armed-target identity (phase-E review rejection round 5:
   *  the signal used to be keyed to settled call ids — the calls the
   *  target awaited — so an unawaited sibling `.then` job running
   *  before the target's continuation consumed it, and indirect waits
   *  (`await Promise.all([q])`) were refused entirely): the guest
   *  library's wrap-settling reaction sets the CONTINUATION LEASE to
   *  this token immediately before the eval's continuation segment, the
   *  drain loop mirrors the lease per job (see `jobLease`), and the
   *  signal fires only while the mirror holds an armed token — the
   *  executing job IS the armed eval's continuation. */
  private readonly evalTokens = new Map<JSValueHandle, string>();
  /** The token of the eval currently being run (see `eval`/`runEval`:
   *  `runEval` mints it before the VM execution; `eval` attributes it
   *  to the completion wrapper when the eval suspends). */
  private lastEvalToken: string | undefined;
  /** True while `runEval` is executing (its code phase and its own
   *  drain) — the reset handler's attribution discriminator: a job
   *  whose continuation token is NOT the current eval's while `runEval`
   *  is active is a RESUMED SUSPENDED eval (attributed through its
   *  completion wrapper); outside `runEval` every leased job is a
   *  resumed eval (the stale `lastEvalToken` of a now-suspended eval
   *  must never route through the per-eval flag). */
  private inRunEval = false;
  /** The per-eval continuation-token mint counter. */
  private evalTokenSeq = 0;
  /** The per-job continuation-lease seam (see `ReplJobLease` in vm.ts):
   *  the drain loop reads the guest library's lease before each job
   *  into `jobLease.cell.current` and clears it after a lease-carrying
   *  job. The interrupt handler (consulted DURING a job) reads the
   *  mirror; the interrupted-drain release reads it after the drain
   *  throws. Read/clear ride the workspace's lease seams (the guest
   *  library's `__replLease` accessor — trusted library code). */
  private readonly jobLease: ReplJobLease = {
    read: () => this.workspace.readContinuationLease(),
    clear: () => this.workspace.clearContinuationLease(),
    cell: { current: undefined },
  };
  /** The eval-break signal (the interrupt tool's no-id arm): consulted
   *  ONLY by executions that resume suspended-eval continuations — the
   *  settlement drains (`drain`) and a direct eval's own drain phase
   *  (`runEval` composes the same handler) — NEVER by a fresh eval's
   *  own code (`runEval` does not compose it for the code phase): an
   *  unrelated eval can neither consume the signal nor be broken by
   *  it. The signal fires only while the currently-executing job is
   *  one of the armed targets' continuation segments — the job's lease
   *  (see `jobLease`) holds one of the armed tokens (phase-E review
   *  round 3/5: the carried defect's handler fired on whichever drain
   *  ran next — or whichever JOB ran first in a drain that settled a
   *  target's call, breaking an unawaited sibling's continuation and
   *  clearing the arm before the target ran). Consumed on first
   *  observation (the quickjs interrupt polls constantly, so the next
   *  target continuation execution after arming breaks mid-run). */
  private evalBreakArmed = false;
  /** The OUT-OF-BAND break probe's execution marker (phase-F review
   *  round 2, see `evalBreakProbe`; round 3: the wall-clock start was
   *  replaced by the channel's monotonic ARM-SEQUENCE marker — a total
   *  order across the worker and this thread, so a break armed in the
   *  same millisecond as the execution's start can never be consumed
   *  as stale and lost): the arm-sequence counter's value the moment
   *  the CURRENT execution began — a fresh eval's code phase or a
   *  settlement drain. The probe consumes the channel's break flag
   *  only when its arm sequence exceeds this marker (the arm-after-
   *  start rule). Zero when no channel is wired (the probe is then
   *  absent anyway). */
  private currentExecutionStartSeq = 0;
  /** How many out-of-band breaks were CONSUMED by an executing eval
   *  (a break that actually broke a running eval). */
  outOfBandBreakCount = 0;
  /** The wall-clock moment of the most recent CONSUMED out-of-band
   *  break (see `consumeOutOfBandBreakReport`): the honest outcome
   *  record for the interrupt tool when the daemon was blocked. */
  private lastOutOfBandBreakAtMs: number | null = null;
  /** The arming-time active-eval set the eval-break signal is scoped
   *  to: when every target settles (or is released), the signal is
   *  cleared with them — a signal whose target no longer exists must
   *  never leak into a later execution. */
  private evalBreakTargets = new Set<JSValueHandle>();
  /** The armed targets' continuation TOKENS (see `evalTokens`): the
   *  eval-break signal's firing identity — the handler fires only
   *  while the current job's lease is one of these (phase-E review
   *  round 5). */
  private evalBreakTokens = new Set<string>();
  /** The cached continuation-lease capability probe (see
   *  `continuationLeaseAvailable`): whether the workspace's guest
   *  library carries the 0.3.0 lease surface. Cached — the library
   *  never changes within a broker's lifetime; `undefined` until first
   *  probed. */
  private leaseCapabilityCached: boolean | undefined;
  /** The cached iterable-lease capability probe (see
   *  `iterableLeaseAvailable`): whether the workspace's guest library
   *  carries the 0.3.1 `__replAwaitIterable` surface. Cached like
   *  `leaseCapabilityCached`; `undefined` until first probed. */
  private iterableLeaseCapabilityCached: boolean | undefined;
  /** True once the client-presence drain released every child (see
   *  `drainForDisconnect`): the workspace stays live, and later
   *  followUp/steer/cancel on a settled handle lazily re-attach the
   *  recorded backend session. */
  private drained = false;
  /** True while a client-presence drain or a dispose is in progress (and
   *  stays true after a drain — the drained broker owns no attached
   *  sessions until a new open). The re-attach arm keys on it: a seam
   *  rejection while the broker is draining/disposing must NOT re-issue
   *  (a fresh child would open and run after the last client
   *  disconnected — the drain defect); the call is left pending and
   *  surfaced guest-visibly instead. */
  private draining = false;
  /** Agent calls whose `openSession` is still in flight (no session entry
   *  exists yet — the session may appear at any moment). The client-
   *  presence drain waits for these exactly like busy sessions: a call
   *  blocked in openSession is still in flight, and draining past it
   *  would let the child open and run after the last client
   *  disconnected (phase-D review round 3). */
  private readonly openingCalls = new Set<string>();
  /** Opening calls the drain's bound forced to STOP (see
   *  `drainForDisconnect`): when the parked `openSession` eventually
   *  lands, the session is released immediately (never prompts), the
   *  call settles as the recoverable `AGENT_CANCELLED`, and queued
   *  steers are dropped with the durable `dropped` marker — the child
   *  never runs after the drain. */
  private readonly stoppedOpens = new Set<string>();
  /** The disposal/drain GENERATION (phase-D review round 5): bumped when
   *  the client-presence drain's bound expires and when the broker is
   *  disposed. In-flight `openSession` calls and lazy re-attaches capture
   *  the generation when they START; when they land after a bump, the
   *  child session is released immediately — it never registers and
   *  never prompts (a child must never open or run after the last
   *  client disconnected, nor after a reset/dispose). */
  private generation = 0;
  private disposed = false;
  private opChain: Promise<unknown> = Promise.resolve();

  private constructor(workspace: Workspace, options: BrokerOptions) {
    this.workspace = workspace;
    // Validate the cap: an integer in [1, DEFAULT_MAX_CONCURRENT_AGENTS].
    // Non-integer / NaN / < 1 values are programming errors at attach time
    // (loud throw); values ABOVE the doc-settled ceiling are clamped to it
    // — the six-per-workspace maximum is absolute, so a misconfigured host
    // can never open a seventh subagent (review regression: a config of 7
    // used to open seven sessions).
    const rawCap = options.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    if (typeof rawCap !== 'number' || !Number.isInteger(rawCap) || rawCap < 1) {
      throw new Error(
        `Broker: maxConcurrentAgents must be an integer in [1, ${DEFAULT_MAX_CONCURRENT_AGENTS}] ` +
          `(got ${String(rawCap)})`,
      );
    }
    this.maxConcurrentAgents = Math.min(rawCap, DEFAULT_MAX_CONCURRENT_AGENTS);
    this.callStore = options.store ?? new InMemoryCallStore();
    this.interruptHandler = options.interruptHandler;
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.evalBreakChannel = options.evalBreakChannel;
    // The workspace's slot is registered up front so the worker's HTTP
    // endpoint knows the key before any eval can run. The registration
    // is ACKNOWLEDGED (phase-F review round 4): every serialized
    // operation awaits the ack before touching the VM (see
    // `runSerialized`), so a no-id interrupt can never 404 against a
    // key→slot mapping the worker has not applied yet — the old
    // fire-and-forget registration left a window where the first
    // interrupt's out-of-band break was lost and the eval ran to the
    // per-eval deadline.
    this.evalBreakReady =
      options.evalBreakChannel?.register(this.workspace.projectDir) ?? Promise.resolve();
    this.sink = options.snapshotSink;
    this.ownsRunner = options.runner === undefined;
    this.runner = options.runner ?? new AcpAgentRunner();
  }

  /**
   * Attach a broker to a workspace: re-register the four `__host_*`
   * callbacks with the broker's handlers (the same by-name
   * re-registration the restore path uses — the guest library and its
   * pending-call registry are untouched, and every subsequent guest call
   * routes to the broker). Works on a live workspace (replacing the
   * parking bridge) and on a restored one.
   */
  static async attach(workspace: Workspace, options: BrokerOptions = {}): Promise<Broker> {
    const broker = new Broker(workspace, options);
    workspace.rehost(broker.makeHandlers());
    return broker;
  }

  /** The guest-bridge handlers (see `GuestBridgeHandlers`). */
  makeHandlers(): GuestBridgeHandlers {
    return {
      agent: (call, callId, modelSpec, task, optionsJson) => {
        this.onAgent(call, callId, modelSpec, task, optionsJson);
      },
      checkpoint: (call, callId, question, optionsJson, answerJson) => {
        return this.onCheckpoint(call, callId, question, optionsJson, answerJson);
      },
      steer: (call, callId, sessionId, action, payloadJson) => {
        this.onSteer(call, callId, sessionId, action, payloadJson);
      },
      console: (event) => {
        this.consoleBuffer.push(event);
      },
      // The eval-plane helpers (§4.5/§4.7): sleep settles from a host
      // timer; workspace()/agents() serve the §4.5 plain-value shapes;
      // reset() marks the teardown consumed after the current eval;
      // defaultBackend() serves the runner's configured default backend
      // id to the guest library's verify/judgePanel (§4.7).
      sleep: (call, ms) => {
        this.onSleep(call, ms);
      },
      workspace: () => this.workspaceJson(),
      agents: () => this.agentsJson(),
      reset: () => {
        // The request belongs to the eval whose code/continuation is
        // EXECUTING. A RESUMED SUSPENDED eval's continuation (the
        // continuation IS the eval's tail — `await agent(...);
        // reset()`) is attributed to that eval's retained completion
        // wrapper NOW, through the executing job's continuation token
        // (the lease mirror — set by the drain loop while the
        // continuation segment runs): the teardown then depends ONLY
        // on the reset-calling eval's completion (the sweep flips
        // `resetDue` when it settles) and never leaks into an
        // unrelated later eval's snapshot (the review defect's shape).
        // The CURRENT eval's request — its code phase (the mirror is
        // clean there, see `runEval`) or its own continuation in its
        // own drain (a job carrying THIS eval's token) — takes the
        // per-eval flag instead: the eval op's snapshot attributes it
        // (suspension → owning set, completion → `resetDue`). A legacy
        // workspace without the lease surface reads an empty mirror
        // and takes the flag path (its snapshots take the §6.1
        // auto-reset path on first touch anyway).
        const token = this.jobLease.cell.current;
        if (token !== undefined && (!this.inRunEval || token !== this.lastEvalToken)) {
          for (const [completion, evalToken] of this.evalTokens) {
            if (evalToken === token) {
              this.resetOwningCompletions.add(completion);
              break;
            }
          }
          return;
        }
        this.resetRequested = true;
      },
      defaultBackend: () => this.runner.defaultBackendId(),
    };
  }

  /**
   * The tool-result eval: settle what can be settled (pump), run the
   * script (top-level-await semantics, the uncaught-rejection bridge
   * armed), drain, and report the doc's shape. The pump runs FIRST so an
   * eval that awaits a call which completed earlier resolves in-eval
   * with its value ("an eval whose promise resolves within the drain
   * reports the value"); a suspended eval's continuation resumes at a
   * later settlement drain and its output lands in the next tool result.
   */
  async eval(code: string, options: ReplEvalOptions = {}): Promise<ReplEvalResult> {
    return this.serialized(async () => {
      this.assertAlive();
      let completed: string[];
      let pumpDrainErrorLine: string | undefined;
      const pumped = await this.pumpUnlocked();
      completed = pumped.settled;
      // The pump's per-call settlement boundaries already fired inside
      // `pumpUnlocked` (one per settled call's continuation drain); the
      // sink's burst bookkeeping coalesces them with the eval's own
      // boundary into one write at the operation's flush.
      if (pumped.drainError !== undefined) {
        // The pump's drain ran PREVIOUS evals' continuations and one
        // failed. The current eval did not fail; the background
        // failure is honest output (rendered alongside the eval's own
        // error, if it has one), the already-settled call ids are
        // STILL reported (a continuation drain failure must never
        // erase the deliveries it followed — review regression), and
        // the VM stays usable.
        pumpDrainErrorLine = errorLine(pumped.drainError.info);
      }
      // reset() (§4.5): the pump already swept the retained suspended
      // evals (its end-of-pump sweep reads every settlement the pump's
      // drains ran) — a reset-owning eval that COMPLETED during the
      // pump flipped `resetDue`. Its teardown runs NOW, before this
      // eval's submitted code: the reset-owning eval completed, so
      // later guest code must never run against the doomed workspace
      // (the review probe: `reset(); await sleep(10)` followed by an
      // eval returning its own result before the disposal). The
      // disposal runs with an already-expired bound — the deadline
      // path's unlocked body — because the eval op itself holds the
      // serialization chain (the default disposal would enqueue behind
      // the operation that is awaiting it).
      if (this.resetDue) {
        await this.resetIfDue(0);
      }
      // reset() (§4.5) SCOPING: the request belongs to THIS eval — the
      // snapshot below captures only what this eval's execution
      // requested. The scope starts clean (an earlier suspended eval's
      // continuation may have called reset() during the pump's drains;
      // that request was attributed to ITS completion wrapper through
      // the continuation-token seam in the reset handler) so an
      // UNRELATED later eval that suspends can never join the owning
      // set (the review defect: the workspace-global flag inserted
      // every later suspending eval into `resetOwningCompletions`,
      // delaying the teardown behind unrelated suspended evals — the
      // workspace kept running guest code after the reset-owning eval
      // completed).
      this.resetRequested = false;
      const { outcome, completion, interruptedInDrain } = this.runEval(code, options);
      const resetByThisEval = this.resetRequested;
      this.resetRequested = false;
      if (interruptedInDrain === true) {
        // The eval's OWN drain was interrupted (the armed eval-break
        // signal's target resumed by a synchronous host-callback
        // settlement — a checkpoint answer — inside this eval's drain,
        // or the per-eval deadline): the interrupted continuation's
        // engine wrapper NEVER settles (the quickjs interrupt aborts
        // the async job without rejecting its promise — verified
        // against the shipped binary), so the tracked "running eval"
        // can only be released HERE — exactly like the pump path's
        // release (phase-E review rejection round 2: the old signal was
        // consulted only by settlement drains, and without this release
        // a broken target stayed tracked forever, making a later
        // eval-break arm target a dead eval). The release is EXACT
        // (phase-E review rounds 3/5): the interrupted job's
        // continuation lease (see `jobLease`) names the eval whose
        // continuation was actually executing — an unrelated
        // interrupted drain — THIS eval's own completion jobs bounded
        // by the per-eval deadline, with no tracked continuation
        // running — releases nothing and leaves the eval-break armed
        // state intact.
        this.releaseInterruptedEval();
      }
      // The eval's own provenance pass: bindings this eval created or
      // rebound are attributed to `eval N` (the registry's snapshot-
      // durable counter).
      this.provenancePass('eval');
      // The active-eval sweep FIRST reads late completions (a previous
      // suspended eval settled during this operation's pump/drain):
      // its value becomes `_` here, BEFORE this eval's own `_` write
      // below (this eval is the most recent one — its value wins).
      this.sweepActiveEvals();
      // The §4.4 result-history global: `_` holds the previous eval's
      // completion value, IPython-style — the sole replacement for the
      // deleted `$N` capture globals. Set after every eval that
      // RESOLVED with a value — an undefined completion (an empty
      // poll) makes `_` undefined: the previous eval's completion
      // value IS undefined (the review probe: `42`, then `""`, then
      // `_` must read undefined, never the stale 42). An error or a
      // suspension leaves `_` unchanged, like IPython's. The set
      // borrows the completion handle the render below still owns.
      if (outcome.kind === 'value' && completion !== undefined) {
        try {
          this.workspace.setGlobal('_', completion as JSValueHandle);
        } catch {
          // A failed `_` write must not fail the eval that produced the
          // value — the result line still renders.
        }
      }
      // A SUSPENDED eval's completion wrapper is retained as the
      // active-eval probe (the interrupt tool's eval-break target
      // surface): the wrapper is pending while the eval's continuation
      // is in flight and settles when the continuation completes or is
      // broken — `sweepActiveEvals` releases it at the next operation
      // (reading its fulfilled value into `_` first).
      // A RESOLVED eval's completion handle is owned by `render` (it
      // previews and disposes it); an error outcome carries none. The
      // eval's CONTINUATION TOKEN is attributed alongside (see
      // `evalTokens`): the token `runEval` minted and embedded in the
      // instrumented code's `__replAwait(value, token)` calls — the
      // eval-break signal's armed-target identity. The token is
      // attributed at suspension only (a resolved eval needs no
      // identity); it is only meaningful when the workspace's library
      // carries the 0.3.0 continuation-lease surface (the arm refuses
      // otherwise).
      if (outcome.kind === 'pending' && completion !== undefined) {
        this.activeEvalCompletions.add(completion as JSValueHandle);
        if (this.lastEvalToken !== undefined) {
          this.evalTokens.set(completion as JSValueHandle, this.lastEvalToken);
        }
        // reset() (§4.5) owes its teardown after THIS eval completes —
        // a reset eval that SUSPENDED retains its completion in the
        // owning set; the sweep flips `resetDue` when it settles. ONLY
        // this eval's own wrapper joins (the per-eval scope above): an
        // unrelated suspended eval never gates the teardown.
        if (resetByThisEval) {
          this.resetOwningCompletions.add(completion as JSValueHandle);
        }
      }
      // reset() (§4.5): an eval that called reset() and COMPLETED
      // within this call owes the teardown NOW (no owning completion
      // outstanding). The disposal itself runs after the operation —
      // the serialized-op post-hook (`resetIfDue`), OUTSIDE the chain
      // slot — so this eval's result ships first.
      if (resetByThisEval && outcome.kind !== 'pending' && this.resetOwningCompletions.size === 0) {
        this.resetDue = true;
      }
      // The pump's deliveries first, then this eval's own synchronous
      // settlements (dispatch-time refusals).
      completed = [...completed, ...this.syncSettled.splice(0)];
      const result = this.render(outcome, completion, completed, pumpDrainErrorLine);
      // The eval's state-changing boundary (the doc's cadence: after
      // each eval). The operation-end flush coalesces it with the
      // pump's settlement boundary into one debounced write.
      this.sink?.boundary('eval');
      return result;
    });
  }

  /**
   * The settlement pump: poll every in-flight host task, deliver the
   * ready outcomes (record → settle → consume, per the exactly-once
   * discipline), drain the guest once, and return the settled call ids
   * in settlement order. A delivery failure keeps the outcome staged
   * (both the store write and the guest settlement are first-wins
   * idempotent), so the next pump retries it — a crash between the
   * store write and the guest settlement is healed, not doubled. A drain
   * failure (a guest continuation threw) propagates as `DrainJobError`
   * with the VM left usable and the already-settled ids still reported.
   */
  async pump(): Promise<string[]> {
    return this.serialized(async () => {
      const { settled, drainError } = await this.pumpUnlocked();
      // The per-call settlement boundaries fired inside `pumpUnlocked`
      // (one per settled call's continuation drain).
      if (drainError !== undefined) throw drainError;
      return settled;
    });
  }

  /**
   * The three-way post-restore reconciliation (the roadmap doc's restore
   * path, step 3): read the guest registry's pending calls and settle
   * every outstanding call EXACTLY one way —
   *
   * - completed while down → settle from the store (whatever the kind),
   * - still resumable at the backend → re-attach via `runner.loadSession`
   *   (capability-gated per acp-agents; see the module docs' "The
   *   restore path" section),
   * - lost → re-issue under the same call id (or, for a steer whose wire
   *   call died with the process, the honest `failed`).
   *
   * Pending checkpoints re-surface into the broker's checkpoint table
   * (answering works across a restore) and the queued-for-next-turn
   * delivery queues rebuild from the store (undelivered steers re-queued
   * exactly once; delivered/dropped never replayed — the markers are
   * first-wins). Drains once when any guest settlement happened, so
   * snapshot-carried continuations fire before this returns — and the
   * drain's state change fires the settlement boundary.
   */
  async reconcile(): Promise<ReconcileReport> {
    return this.serialized(async () => {
      this.assertAlive();
      const surface = this.workspace.surface();
      if (surface === undefined) {
        throw new Error('Broker: cannot reconcile — the guest surface is not installed');
      }
      const report: ReconcileReport = {
        settledFromStore: [],
        reattached: [],
        reissued: [],
        failedLost: [],
        requeuedCheckpoints: [],
        leftPending: [],
        reQueuedUndelivered: [],
      };
      let changedVm = false;
      for (const entry of surface.pending()) {
        const record = this.callStore.lookup(entry.id);
        const completion = record?.completion;
        if (completion !== null && completion !== undefined) {
          const settled = surface.settle(entry.id, completion.outcome, completion.value);
          if (settled) {
            report.settledFromStore.push(entry.id);
            changedVm = true;
          }
          continue;
        }
        if (entry.kind === 'checkpoint') {
          // A question still awaiting its answer: re-surface it (the
          // checkpoint analogue of re-attachment — there is no backend
          // task to find).
          this.requeueCheckpoint(entry, record);
          report.requeuedCheckpoints.push(entry.id);
          continue;
        }
        if (entry.kind === 'steer') {
          // A §4.2 followUp QUEUED for delivery (queuedAtMs marker, no
          // completion): nothing was delivered — the queue rebuild below
          // re-queues it against its founding session (the answer
          // semantics: the registry entry stays pending and the rebuilt
          // delivery settles it with the turn's answer).
          if (record?.queuedAtMs !== null && record?.queuedAtMs !== undefined && record.deliveredAtMs === null && record.droppedAtMs === null) {
            continue;
          }
          // The steer's wire call died with the process: its outcome is
          // unknowable, and re-issuing an injected steer would duplicate
          // the injection. The honest `failed`, durably recorded and
          // surfaced guest-visibly. (Queued-but-undelivered steers are
          // handled by the queue rebuild below, NOT here.)
          if (this.settleSteerLost(entry)) {
            changedVm = true;
          }
          report.failedLost.push(entry.id);
          continue;
        }
        if (entry.kind === 'agent') {
          // Agent call: the re-attach / re-issue arms. Returns whether a
          // guest entry was newly settled (a reconcile-time refusal
          // mutates the VM and must participate in the changed-VM drain
          // and its settlement snapshot — review regression: refusals
          // used to settle the guest without the boundary).
          if (await this.reconcileAgentCall(entry, record, report)) {
            changedVm = true;
          }
          continue;
        }
        // An unrecognized kind (a foreign snapshot from a library version
        // this host does not speak): refuse loudly — settled + recorded +
        // surfaced — never re-issued into the agent machinery.
        if (
          this.refuseReconciled(
            entry,
            'agent',
            new Error(`pending call ${entry.id} has unrecognized kind ${JSON.stringify(entry.kind)} — this host cannot serve it`),
            `unrecognized pending call kind ${JSON.stringify(entry.kind)}`,
          )
        ) {
          changedVm = true;
        }
        report.failedLost.push(entry.id);
      }
      report.reQueuedUndelivered = this.rebuildUndeliveredQueues();
      if (changedVm) {
        // The settlement drain fires snapshot-carried continuations. The
        // state-changing boundary is the doc's cadence (after each
        // settlement drain that changed VM state) and it fires EVEN when
        // the drain fails: the settlements landed (the VM changed) and
        // the operation-end flush must have a dirty boundary to persist
        // them (review regression: an interrupted drain used to skip the
        // boundary, so the operation-end flush had nothing to write and
        // a kill lost the settlements). The drain itself performs the
        // interrupted-drain release when it ran a tracked eval's
        // continuation (the interrupted job's continuation lease — see
        // `releaseInterruptedEval`). The DrainJobError still propagates
        // — the caller reports it like the pump does.
        let drainError: DrainJobError | undefined;
        try {
          this.drain();
        } catch (error) {
          if (error instanceof DrainJobError) {
            drainError = error;
          } else throw error;
        }
        // The reconciliation's provenance pass: bindings the reconciled
        // settlements' continuations created are attributed to the settled
        // call ids (a pre-provenance restore's own sweep ran inside
        // `Workspace.restore`).
        this.provenancePass('settlement', [
          ...report.settledFromStore,
          ...report.failedLost,
        ]);
        this.sink?.boundary('settlement');
        if (drainError !== undefined) throw drainError;
      }
      // §6.2: the reconcile summary DEMOTES to workspace().diagnostics
      // (retained; it never rides the eval result surface).
      this.lastReconcileReport = report;
      return report;
    });
  }

  /**
   * Rebuild the per-session delivery queues from the store: every steer
   * record with a `queued` completion and NO delivered/dropped marker is
   * undelivered-at-crash — its payload and founding session id are in the
   * store, so delivery can be replayed exactly once. A steer whose
   * founding call was CANCELLED is not re-queued (its queue was dropped
   * when the cancel landed — the dropped marker covers the normal drop
   * path; this is the belt-and-braces check for a crash between the
   * cancel and the drop record). Returns the re-queued steer call ids.
   */
  private rebuildUndeliveredQueues(): string[] {
    const reQueued: string[] = [];
    const records = this.callStore.all();
    for (const record of records) {
      if (record.kind !== 'steer') continue;
      const completion = record.completion;
      // TWO undelivered-at-crash shapes re-queue: (a) the delivery-
      // outcome shape — a completion of `queued` and no delivered/
      // dropped marker (v1's durable queue); (b) the §4.2 followUp-
      // answer shape — a queuedAtMs marker and NO completion (the
      // promise stays pending until the delivery runs; the store's
      // first completion is the answer the turn will settle).
      const queuedAnswer = record.queuedAtMs !== null;
      const queuedOutcome = completion !== null && completion !== undefined && completion.value === 'queued';
      if (!queuedAnswer && !queuedOutcome) continue;
      if (record.deliveredAtMs !== null || record.droppedAtMs !== null) continue;
      if (record.sessionId === null) continue;
      if (this.isCancelledFoundingCall(record.sessionId)) continue;
      const sessionId = record.sessionId;
      const payload = parseSteerPayload(record.optionsJson);
      if (payload === null) continue;
      const entry = this.sessions.get(sessionId);
      if (entry !== undefined) {
        if (entry.queue.some((item) => item.callId === record.callId)) continue;
        entry.queue.push({ callId: record.callId, ...payload, call: null, answer: queuedAnswer });
        // A restored QUEUED followUp turn re-enters the turn registry
        // at rebuild (visible in `agents()`, targetable by `interrupt`
        // — the §4.2 addressability survives the restore).
        if (queuedAnswer) {
          this.followUpTurns.set(record.callId, {
            entry,
            sessionId: entry.callId,
            prompt: payload.prompt,
            queued: true,
            backendId: entry.backendId,
          });
        }
        reQueued.push(record.callId);
      } else {
        const pending = this.pendingSteers.get(sessionId) ?? [];
        if (pending.some((item) => item.callId === record.callId)) continue;
        pending.push({ callId: record.callId, ...payload, answer: queuedAnswer });
        this.pendingSteers.set(sessionId, pending);
        if (queuedAnswer) {
          // A restored QUEUED followUp turn whose founding session is
          // NOT attached (the crash happened with the handle settled
          // and drained): the turn is registered NOW — visible in
          // `agents()` and targetable by `interrupt` from rebuild time
          // (the review defect: the item was parked in `pendingSteers`
          // with no turn registered, no re-attach scheduled and no
          // delivery scheduled — `agents()` omitted it, `interrupt`
          // returned `none`, and it stayed pending after capacity
          // freed) — and its delivery is scheduled through the
          // founding handle's lazy re-attach: the load merges the
          // pending steers into the rebuilt session and the global
          // kick starts the turn as slots free. A load that fails
          // settles the queued followUp with the honest `failed`
          // (recorded durably first — never a discarded turn).
          const founding = this.callStore.lookup(sessionId);
          this.followUpTurns.set(record.callId, {
            entry: undefined,
            sessionId,
            prompt: payload.prompt,
            queued: true,
            backendId:
              founding?.backendId ??
              (founding?.modelSpec !== null && founding?.modelSpec !== undefined && founding.modelSpec !== ''
                ? backendSegment(founding.modelSpec)
                : undefined),
          });
          this.scheduleRestoredQueuedDelivery(sessionId, record.callId);
        }
        reQueued.push(record.callId);
      }
    }
    return reQueued;
  }

  /** Find a QUEUED (cap-pressure) followUp item by its steer call id —
   *  the interrupt tool's cancel-by-id target for undelivered followUps
   *  (§4.2: the queued turn is addressable before it starts). */
  private findQueuedSteer(callId: string): { entry: SessionEntry } | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.queue.some((item) => item.callId === callId && item.answer)) {
        return { entry };
      }
    }
    return undefined;
  }

  /** Settle a QUEUED (not-yet-started) followUp turn's cancellation:
   *  the item is already removed from its queue (the caller removed it
   *  from the session's queue or its re-homed pending steers); record
   *  the durable drop, reject the guest call recoverable with the §4.6
   *  attribution, and release the turn registry entry. One settlement
   *  drain fires the guest reactions (mirrors the pump's per-call
   *  drain); a failed drain is honest output, never a cancel failure. */
  private settleQueuedFollowUpCancellation(callId: string, backendId: string | undefined): void {
    this.callStore.recordDelivery(callId, 'dropped', now());
    const value = toRejectionValue(
      new WorkflowError(`followUp ${callId} was cancelled while queued for delivery`, CODE.AGENT_CANCELLED, {
        recoverable: true,
      }),
    );
    // The §4.6 attribution: the followUp's resolved backend (the
    // founding session's recorded backend id).
    if (backendId !== undefined) (value as { replBackend?: string }).replBackend = backendId;
    this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
    try {
      this.settleIntoGuest(callId, 'reject', value);
      this.drain();
      this.provenancePass('settlement', [callId]);
      this.sink?.boundary('settlement');
    } catch (error) {
      if (error instanceof DrainJobError) {
        this.warnLine('warn', `settlement drain interrupted after cancelling queued followUp ${callId}: ${errorLine(error.info)}`);
        this.sink?.boundary('settlement');
      } else throw error;
    }
    this.followUpTurns.delete(callId);
    this.kickQueuedDeliveries();
  }

  /** Schedule the delivery of a restored QUEUED answer-mode followUp
   *  whose founding session is NOT attached (see
   *  `rebuildUndeliveredQueues`): lazily re-attach the founding
   *  session — deduped per founding call id, capability-gated exactly
   *  like every load — and let the global kick start the queued
   *  delivery (the turn settles with its answer through the ordinary
   *  record → settle → consume pump). A failed load settles the queued
   *  followUp with the honest `failed`, recorded durably FIRST (the
   *  dropped marker — a restore never re-queues a settled item). The
   *  task runs OUTSIDE the serialized chain (the load is a runner
   *  wire call, like every lazy re-attach); its outcome travels the
   *  pump like any steer. */
  private scheduleRestoredQueuedDelivery(sessionId: string, steerCallId: string): void {
    const task = this.lazyReattach(sessionId).then(
      (entry): { outcome: 'resolve' | 'reject' | 'hold'; value: unknown } => {
        if (this.disposed) {
          // The broker is being torn down: the guest calls are gone
          // with the workspace — nothing to settle.
          this.followUpTurns.delete(steerCallId);
          return { outcome: 'hold', value: undefined };
        }
        if (entry === undefined) {
          this.followUpTurns.delete(steerCallId);
          this.callStore.recordDelivery(steerCallId, 'dropped', now());
          this.warnLine(
            'warn',
            `followUp ${steerCallId} (on ${sessionId}): the founding session could not be re-attached — failed`, // eslint-disable-line max-len
          );
          return { outcome: 'resolve', value: 'failed' };
        }
        // The load merged the pending steers into the rebuilt session's
        // queue; the global kick starts the delivery as slots free (the
        // turn settles with its answer through the pump).
        this.kickQueuedDeliveries();
        return { outcome: 'hold', value: undefined };
      },
    );
    this.trackInFlight(steerCallId, 'steer', task);
  }

  /** Did this founding call end in an orchestrator-driven cancel (the
   *  only settlement that drops its delivery queue)? */
  private isCancelledFoundingCall(callId: string): boolean {
    const record = this.callStore.lookup(callId);
    const completion = record?.completion;
    if (completion === null || completion === undefined || completion.outcome !== 'reject') return false;
    const value = completion.value as { code?: unknown } | null | undefined;
    return value !== null && typeof value === 'object' && value.code === CODE.AGENT_CANCELLED;
  }

  // ── The restore path: re-attach / re-issue arms ──────────────────────

  /** One pending agent call's reconcile: re-attach when a backend
   *  session is recorded (capability-gated through the runner's own
   *  `loadSession` — the same gate a custom backend without
   *  `session/load` degrades through), re-issue when it is lost. See
   *  the module docs' "The restore path" section. Returns whether a
   *  guest entry was newly settled (a reconcile-time refusal mutates
   *  the VM and must participate in the changed-VM drain and its
   *  settlement boundary). */
  private async reconcileAgentCall(
    entry: GuestSurfaceEntry,
    record: CallRecord | undefined,
    report: ReconcileReport,
  ): Promise<boolean> {
    if (this.isTracked(entry.id)) {
      // Already live under this broker (a repeated reconcile, or a call
      // this pass already re-attached/re-issued): duplicating the task
      // would double-poll the session. The registry's first-wins settle
      // makes any replay a no-op anyway.
      report.reattached.push(entry.id);
      return false;
    }
    if (this.draining || this.disposed) {
      // A PARKED restore-time load resumed after the client-presence
      // drain force-stopped (or after disposal): the drain already
      // settled EVERY outstanding call at its bound — including the
      // registry entries this serialized loop had not reached yet (see
      // `drainForDisconnect`'s forced stop) — and a disposed broker
      // must never open a child. Never initiate a NEW load or re-issue
      // from the resumed loop: a fresh child must not open and run
      // after the last client disconnected, nor after disposal
      // (phase-D review rejection: the generation fence covered only
      // the parked load itself, so a load that landed after the
      // drain/disposal bump let the reconciliation loop initiate
      // SUBSEQUENT loads for the registry entries behind it). The call
      // stays pending (leftPending — the state owning it is being torn
      // down or drained).
      report.leftPending.push(entry.id);
      return false;
    }
    let parsed: ParsedAgentOptions;
    try {
      parsed = this.parseAgentOptions(entry.optionsJson);
    } catch (error) {
      // A corrupt options bag (a hostile/foreign registry entry): the
      // same refusal a live dispatch would have produced — recorded,
      // settled, surfaced. The §4.6 attribution rides it too: the
      // call's recorded spec names its resolved backend (the same
      // stamp a live admission refusal with a resolved segment gets).
      if (entry.modelSpec !== null && entry.modelSpec !== '') {
        const segment = backendSegment(entry.modelSpec);
        if (this.knownBackends().includes(segment)) {
          (error as { replBackend?: string }).replBackend = segment;
        }
      }
      const settled = this.refuseReconciled(entry, 'agent', error, 're-issue refused (invalid options)');
      report.failedLost.push(entry.id);
      return settled;
    }
    const sessionId = record?.sessionId ?? null;
    if (sessionId === null) {
      // The founding session never opened (or its record predates the
      // attachment log): there is nothing at the backend to re-attach.
      // The re-issue may itself refuse (the concurrency cap) — that
      // refusal settles the guest, so its newly-settled flag propagates
      // into the changed-VM bookkeeping (review regression: this branch
      // used to drop the flag, skipping the settlement drain and its
      // snapshot boundary when the re-issue was refused).
      return this.reissueCall(entry, parsed, 'no resumable backend session was recorded', report);
    }
    // The restore-time re-attach is covered by the OPENING-CALL registry
    // (phase-D review rejection: a parked restore-time loadSession used to
    // be invisible to the client-presence drain and to dispose). The drain
    // now WAITS for the load exactly like an openSession (a parked restore
    // load is in-flight work — the child may open and run after the last
    // client disconnected) and force-stops it DURABLY at the bound
    // (recorded AGENT_CANCELLED, guest-settled, drained, snapshotted —
    // never an orphaned pending call), while the GENERATION captured at
    // START fences the late landing: a load that resolves after the
    // broker was disposed (or after the drain force-stopped) is released
    // immediately — never registered (a late landing must not leak the
    // session or repopulate liveAgents on a torn-down broker) and never
    // re-issued (a fresh child must not open or prompt after disposal).
    const generation = this.generation;
    this.openingCalls.add(entry.id);
    let loaded: BrokerSession | undefined;
    try {
      // The re-attach routing: the store's RECORDED backend id pins the
      // original backend (a backend id doubles as a model routing spec),
      // falling back to the recorded model spec verbatim — never the
      // current configured default (phase-D review round 2: a changed
      // default across a restart used to load on the wrong backend and
      // miss the still-resumable original session).
      const model =
        record?.backendId ??
        (entry.modelSpec ?? undefined);
      const session = await this.runner.loadSession({
        sessionId,
        model,
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        configOptions: parsed.configOptions,
        mode: parsed.mode,
        label: `repl:${entry.id}`,
        runId: entry.id,
        keepSession: true,
        retainSessionLog: true,
      });
      loaded = session;
      this.openingCalls.delete(entry.id);
      // The disposed/drain fence (see above): the drain's force-stop
      // marked the call stopped (and settled it durably) when the bound
      // expired with the load parked; disposal bumped the generation.
      const stoppedByDrain = this.stoppedOpens.delete(entry.id);
      if (stoppedByDrain || this.disposed || this.generation !== generation) {
        if (!stoppedByDrain) {
          // Not already settled by the drain's force-stop: the broker was
          // disposed while the load was parked. The child is closed
          // immediately, and the call stays pending in the guest
          // (leftPending — the state owning it is being torn down anyway;
          // it is never settled from a quiet gap and never re-issued).
          this.warnLine(
            'info',
            `call ${entry.id}: restore re-attach of backend session ${sessionId} landed after the broker ` +
              `was disposed — the child was closed without registering`, // eslint-disable-line max-len
          );
          report.leftPending.push(entry.id);
        }
        // The teardown-fence release is DETACHED, never awaited
        // (phase-D review rejection: the fence used to await
        // `session.release()` with no deadline — a custom backend with a
        // hung release kept the reconciliation — and with it the daemon's
        // first touch — pending indefinitely, reintroducing the
        // unbounded-teardown defect). The child's close is best-effort
        // here: the drain/disposal already returned at its bound, and a
        // parked release must not hold the resumed reconcile.
        void Promise.resolve(session.release()).catch(() => undefined);
        loaded = undefined;
        return false;
      }
      const awaitTurn = session.awaitCurrentTurn;
      if (awaitTurn === undefined) {
        // A THIRD-PARTY BrokerSession adapter without the seam (the real
        // acp-agents adapter has it): the loaded session's founding-turn
        // completion is unobservable to this host. Phase-F review: the
        // doc's three reconciliation arms are exhaustive — a call must
        // settle exactly once through settle-from-the-store / re-attach /
        // re-issue, never through an undocumented fourth arm that parks
        // it until interrupt/reset. The seam absence is a capability
        // omission, and the doc's rule for a capability-omitting backend
        // is "re-issue is the honest fallback, surfaced guest-visibly":
        // the catch arm below releases the loaded session (best-effort —
        // the re-issue opens its own fresh session) and re-issues the
        // call under the same id. The old keep-attached-and-pending arm
        // (`registerUnobservableReattach`) is deleted: it left every
        // re-attached call on a seam-less backend — including the
        // built-in claude and opencode backends, which do not advertise
        // `_session/loaded_turn` — permanently pending across a crash.
        throw new Error(
          'the loaded session exposes no awaitCurrentTurn seam — its founding-turn completion is ' +
            'unobservable; re-issue is the honest fallback',
        );
      }
      // The seam (REAL on acp-agents' InteractiveSession): an OBSERVING
      // wait — it resolves with the founding turn when the session/load
      // replay's update stream settles with a trailing assistant message
      // (a turn that ended while the daemon was down has its final
      // message in the replay), keeps the session ATTACHED while a
      // still-running turn keeps streaming live chunks after the load
      // response (settling from its authoritative completion — phase-D
      // review: this case used to be rejected, releasing the loaded
      // session and re-issuing a call whose turn was still running), and
      // rejects only when the outcome is genuinely unobservable (no user
      // message, a released/dead session, or a stream settled without a
      // terminal assistant message within the max-wait bound). The call
      // is ARMED on the seam WITHOUT blocking reconcile: a still-running
      // founding turn may take minutes, so reconcile returns immediately
      // and the pump delivers the completion when the seam settles — the
      // same record → settle → consume path as a live call. A seam
      // rejection degrades to re-issue INSIDE the task (releasing the
      // loaded session first), surfaced guest-visibly — a re-attached
      // call can never hang unobserved.
      this.registerReattached(entry, parsed, session);
      report.reattached.push(entry.id);
      return false;
    } catch (error) {
      this.openingCalls.delete(entry.id);
      // The disposed/drain fence for a load that FAILED while parked
      // (mirrors the try arm): a force-stopped call was already settled
      // by the drain; on a disposed broker the call stays pending — never
      // a re-issue (a fresh child must not open after disposal).
      const stoppedByDrain = this.stoppedOpens.delete(entry.id);
      if (stoppedByDrain || this.disposed || this.generation !== generation) {
        if (loaded !== undefined) {
          // The teardown-fence release is DETACHED, never awaited (the
          // same boundless-release family as the try arm above — phase-D
          // review rejection: a hung release must not keep the resumed
          // reconciliation pending forever).
          void Promise.resolve(loaded.release()).catch(() => undefined);
          loaded = undefined;
        }
        if (!stoppedByDrain) report.leftPending.push(entry.id);
        return false;
      }
      // The capability gate (a backend without session/load), a
      // lost/deleted session, a wire failure, or the seam's rejection
      // (founding-turn outcome unobservable): release the loaded session
      // when one was obtained (best-effort — the re-issue opens its own
      // fresh session) and re-issue is the honest fallback, surfaced
      // guest-visibly (a warn line in the next tool result). The re-issue
      // may itself refuse (the concurrency cap) — that refusal settles
      // the guest, so its newly-settled flag propagates into the
      // changed-VM bookkeeping (review regression: the catch used to
      // drop it, skipping the settlement boundary).
      if (loaded !== undefined) {
        await Promise.resolve(loaded.release()).catch(() => undefined);
      }
      // The disposed/drain fence RE-CHECKED after the awaited release
      // (phase-D review rejection — the same late-fence family as
      // `reissueReattached`): the release can park past the drain's
      // bound or a disposal's generation bump, and the drain's forced
      // stop then settles the call durably (the opening-call pass —
      // recorded AGENT_CANCELLED, guest-settled, drained, snapshotted)
      // and reports `isDrained` while the release is still parked. A
      // late re-issue would open a fresh child after the broker
      // reported drained; the re-check holds instead — the call stays
      // as the drain settled it (the stopped-open marker is consumed
      // here when the forced stop landed during the parked release).
      const stoppedByDrainLate = this.stoppedOpens.delete(entry.id);
      if (stoppedByDrainLate || this.disposed || this.generation !== generation) {
        if (!stoppedByDrainLate) report.leftPending.push(entry.id);
        return false;
      }
      return this.reissueCall(
        entry,
        parsed,
        loaded === undefined
          ? `backend session ${sessionId} not resumable (${toRejectionValue(error).message})`
          : `backend session ${sessionId} loaded, but its founding turn's outcome is not observable (${toRejectionValue(error).message})`,
        report,
      );
    }
  }

  /** Register a successfully re-attached session and ARM the call's
   *  completion on the loaded session's founding turn — the seam runs as
   *  an in-flight task (reconcile does NOT block on a still-running
   *  turn), delivered by the same record → settle → consume pump as a
   *  live call. The call holds a concurrency token until the pump
   *  delivers it, exactly like a live call. A seam that can never
   *  observe the founding turn (absent on a third-party adapter) degrades
   *  INSIDE the task to a re-issue under the same call id — the honest
   *  fallback when re-attachment itself is unavailable (phase-F review
   *  round 2: the seam-less BUILT-INS no longer take this path — the
   *  seam classifies their loaded turns authoritatively through the
   *  observation path, and every possibly-running call stays attached;
   *  this degradation is reserved for the observably-dead classes and
   *  for third-party adapters whose sessions expose no seam at all). */
  private registerReattached(entry: GuestSurfaceEntry, parsed: ParsedAgentOptions, session: BrokerSession): void {
    const sessionEntry: SessionEntry = {
      session,
      callId: entry.id,
      modelSpec: entry.modelSpec ?? '',
      task: entry.detail ?? '',
      supportsSteering: session.capabilities?.supportsSteering === true,
      busy: true,
      delivering: false,
      callSettled: false,
      callCancelled: false,
      backendId: session.backendId ?? backendSegment(entry.modelSpec ?? ''),
      cancelWaiters: new Set(),
      queue: (this.pendingSteers.get(entry.id) ?? []).map((steer) => ({
        callId: steer.callId,
        prompt: steer.prompt,
        promptMeta: steer.promptMeta,
        call: null,
        answer: steer.answer,
      })),
    };
    this.pendingSteers.delete(entry.id);
    this.sessions.set(entry.id, sessionEntry);
    this.agentSlots.add(entry.id);
    this.registerQueuedTurns(sessionEntry);
    this.drained = false; // children are warm again
    this.warnLine('info', `call ${entry.id}: re-attached to backend session ${session.sessionId}`);
    const taskPromise = this.runReattachedTask(entry.id, sessionEntry, parsed);
    this.trackInFlight(entry.id, 'agent', taskPromise);
  }

  /** The re-attached call's task: observe the loaded session's founding
   *  turn through the seam (the observing wait — a still-running turn is
   *  kept attached and settles from its authoritative terminal
   *  notification), then shape the result (schema ladder or the
   *  empty-output gate). A seam REJECTION is classified three ways
   *  (phase-D review round 3, amended phase-F review):
   *
   *  - the still-running class (`LoadedTurnStillRunningError`): the turn
   *    may still be running and its terminal state is unobservable —
   *    NEVER settle a quiet gap and NEVER re-issue a possibly-running
   *    call. The broker KEEPS THE LOADED SESSION ATTACHED and re-arms
   *    the seam on it for BOTH the re-armable form (a `running` turn
   *    past its max-wait bound on a backend that carries the extension)
   *    and the non-re-armable form (a third-party seam that can never
   *    observe the terminal state) — a later terminal notification — or
   *    a cancel — still settles the call, and the drain's forced stop
   *    settles it DURABLY at its bound (phase-F review round 2: the
   *    non-re-armable form used to release the loaded session and
   *    re-issue the call, which can duplicate a still-running backend
   *    turn; re-issue is now reserved for the observably-dead classes
   *    below).
   *  - the failed-at-backend class (`LoadedTurnFailedError`): the turn
   *    RAN and failed — a definite outcome, settled as an ordinary
   *    rejection (never re-issued, never settled as success).
   *  - the safe-re-issue class (anything else — no user message in the
   *    transcript, an `interrupted` answer, a dead process): re-issued
   *    under the same id through the ordinary dispatch path. While the
   *    broker is draining/disposing, even these resolve `hold` — a
   *    fresh child must never open and run after the last client
   *    disconnected (the drain's forced stop settles every still-pending
   *    call DURABLY at its bound, so a drained call is never left
   *    pending; a disposed broker's state is being torn down).
   *
   *  Result-shaping failures AFTER the turn resolved (stop-reason gate,
   *  empty output, schema ladder) settle as ordinary rejections, exactly
   *  like a live call — never a re-issue. */
  private runReattachedTask(
    callId: string,
    entry: SessionEntry,
    parsed: ParsedAgentOptions,
  ): Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }> {
    return (async () => {
      let turn: BrokerTurn;
      const awaitTurn = entry.session.awaitCurrentTurn;
      if (awaitTurn === undefined) {
        // Unreachable — `registerReattached` is only called after the seam
        // was checked — but a structural guard keeps the optional seam
        // honest for third-party adapters: degrade to re-issue exactly
        // like every other unobservable completion (phase-F review: a
        // call must settle through one of the doc's three arms — never a
        // permanent hold).
        return this.reissueReattached(
          callId,
          entry,
          parsed,
          new Error('the loaded session exposes no awaitCurrentTurn seam — re-issue is the honest fallback'),
        );
      }
      try {
        turn = await awaitTurn.call(entry.session);
      } catch (error) {
        if (isLoadedTurnStillRunningError(error)) {
          // The turn may still be running at the backend and its terminal
          // state is unobservable: never settle partial output, and never
          // re-issue a possibly-running call. The broker KEEPS THE LOADED
          // SESSION ATTACHED — the doc's second reconciliation arm,
          // re-attach to a still-running task. The RE-ARMABLE form (a
          // `running` turn past the max-wait bound on an extension-
          // carrying backend): re-arm the seam on the still-attached
          // session — a later ended notification — or a cancel — still
          // settles the call. The NON-RE-ARMABLE form (a third-party seam
          // that can never observe the terminal state) is NOT re-invoked:
          // an immediate recursive re-arm would spin in an unbounded
          // microtask/warning loop (each rejection cycles instantly),
          // starving cancellation, drain, and every other task — the
          // broker instead waits for the terminal state from the
          // remaining authority surfaces (see
          // `waitForNonRearmableSettlement`). The drain's forced stop
          // settles a still-pending call durably at its bound either way
          // (phase-F review round 2: the non-re-armable form used to
          // release the loaded session and re-issue the call — a
          // still-running backend turn would have been duplicated; the
          // seam's own observation path now classifies the seam-less
          // built-ins authoritatively, and re-issue is reserved for the
          // observably-dead classes below).
          if (error.rearmable === false) {
            this.warnLine(
              'warn',
              `call ${callId}: ${toRejectionValue(error).message} — the seam can never observe the terminal state; ` +
                `the loaded session stays attached and the call settles on a cancel, the backend's ended ` +
                `notification, the session's release, or the client-presence drain`, // eslint-disable-line max-len
            );
            return this.waitForNonRearmableSettlement(callId, entry, parsed);
          }
          this.warnLine('warn', `call ${callId}: ${toRejectionValue(error).message} — re-armed on the attached session`);
          return this.runReattachedTask(callId, entry, parsed);
        }
        if (isLoadedTurnFailedError(error)) {
          // The founding turn RAN and failed at the backend: a definite
          // outcome — settle it as an ordinary rejection (record → settle
          // → consume), never a re-issue and never a success.
          return { outcome: 'reject', value: toRejectionValue(error) };
        }
        if (this.draining || this.disposed) {
          // The broker's own teardown released the session (or the seam
          // rejected mid-drain): re-issuing would open a fresh child after
          // the last client disconnected. The call is NOT left pending
          // forever: the drain's forced stop settles every still-pending
          // call DURABLY at its bound (recorded AGENT_CANCELLED,
          // guest-settled), and a disposed broker's state is being torn
          // down. Surfaced guest-visibly.
          this.warnLine(
            'warn',
            `call ${callId}: ${toRejectionValue(error).message} — the broker is draining; the call stays ` +
              `pending (never re-issued after the last client disconnected)`, // eslint-disable-line max-len
          );
          return { outcome: 'hold', value: undefined };
        }
        return this.reissueReattached(callId, entry, parsed, error);
      }
      try {
        this.assertNormalStopReason(turn.stopReason, callId);
        const value =
          parsed.schema !== undefined
            ? await this.resolveStructuredOutput(entry, parsed)
            : this.finalTextOf(turn.text, entry.callId);
        return { outcome: 'resolve', value };
      } catch (error) {
        return { outcome: 'reject', value: toRejectionValue(error) };
      }
    })();
  }

  /** The NON-RE-ARMABLE still-running settlement wait (see
   *  `runReattachedTask`'s seam-rejection classification): a third-party
   *  seam that rejects with `LoadedTurnStillRunningError` and
   *  `rearmable: false` can NEVER observe the loaded session's founding-
   *  turn terminal state, so re-invoking it is pointless — the immediate
   *  recursive re-arm would spin in an unbounded microtask/warning loop
   *  (each rejection cycles instantly), starving cancellation, drain,
   *  and every other task. The broker KEEPS THE LOADED SESSION ATTACHED
   *  (a possibly-running call is never re-issued, never settled from a
   *  quiet gap) and waits — zero polling, one-shot subscriptions — for
   *  the terminal state from the remaining authority surfaces:
   *
   *  - the session's own `_session/loaded_turn/ended` notification (the
   *    `loadedTurnEndedState`/`subscribeLoadedTurnEnded` surfaces — a
   *    seam-less backend that pushes the notification anyway): a turn
   *    that ended with an error settles as a rejection (the
   *    `LoadedTurnFailedError` class — a definite outcome, never
   *    re-issued); one that ended with a response resolves with the
   *    accumulated text (the stop-reason gate applies, exactly like a
   *    live call);
   *  - a cancel of the call: settled as the recoverable `AGENT_CANCELLED`
   *    (the interrupt tool works on a held call);
   *  - the session's release: its dedicated process died — the backend
   *    turn died with it — the safe-re-issue class (fenced by
   *    `reissueReattached`);
   *  - the client-presence drain: the forced stop settles every
   *    still-pending call DURABLY at the bound (recorded `AGENT_CANCELLED`,
   *    guest-settled); while draining/disposed, the wait holds — the
   *    call stays as the drain/disposal left it.
   *
   *  The wait is a bounded task exactly like the re-armable seam's: it
   *  holds the call's in-flight entry, and a later settlement is
   *  first-wins against the drain's recorded completion. */
  private async waitForNonRearmableSettlement(
    callId: string,
    entry: SessionEntry,
    parsed: ParsedAgentOptions,
  ): Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }> {
    const session = entry.session;
    // The release watch (the session's process death/disposal): created
    // once and raced every cycle. Absent on adapters that cannot expose
    // it — the wait then settles only on the remaining signals. The
    // flag is set exactly once (a released session stays released), so
    // the race can never spin on a resolved watch.
    let released = false;
    const releaseWatch = (session.released?.() ?? new Promise<void>(() => undefined)).then(() => {
      released = true;
    });
    for (;;) {
      if (this.draining || this.disposed) {
        // The drain/disposal fences: the forced stop settled (or is
        // about to settle) the call durably at the bound — never a
        // re-issue after the last client disconnected, and never a
        // settlement from a torn-down state.
        this.warnLine(
          'warn',
          `call ${callId}: the held re-attach's settlement wait was cut off by the client-presence drain (or ` +
            `the broker was disposed) — the call stays as the drain/disposal left it`, // eslint-disable-line max-len
        );
        return { outcome: 'hold', value: undefined };
      }
      if (released) {
        // The loaded session's dedicated process died (or was
        // disposed): the backend turn died with it — observably dead —
        // the safe-re-issue class (fenced by `reissueReattached`).
        return this.reissueReattached(
          callId,
          entry,
          parsed,
          new Error(
            'the held loaded session was released while awaiting its founding turn — the backend process ' +
              'died; re-issue is the honest fallback',
          ),
        );
      }
      if (entry.callCancelled) {
        // A cancel landed on the held call: settle it as the recoverable
        // `AGENT_CANCELLED` — the interrupt tool's contract, exactly like
        // a live call's cancellation.
        const value = toRejectionValue(
          new WorkflowError(`call ${callId} was cancelled`, CODE.AGENT_CANCELLED, {
            recoverable: true,
          }),
        );
        return { outcome: 'reject', value };
      }
      const ended = session.loadedTurnEndedState?.() ?? null;
      if (ended !== null) {
        if (ended.error !== undefined) {
          // The turn RAN and failed at the backend: a definite outcome —
          // settled as an ordinary rejection, never re-issued and never
          // settled as success.
          return {
            outcome: 'reject',
            value: toRejectionValue(
              new LoadedTurnFailedError(
                `the loaded session's founding turn failed at the backend: ${ended.error.message}`,
              ),
            ),
          };
        }
        try {
          this.assertNormalStopReason(ended.stopReason ?? 'end_turn', callId);
          return { outcome: 'resolve', value: this.finalTextOf(session.currentTurnText(), callId) };
        } catch (error) {
          return { outcome: 'reject', value: toRejectionValue(error) };
        }
      }
      // One-shot signal promises: the ended notification (immediately
      // for a notification that already arrived — the state was checked
      // above, so only the in-between race can land here), the cancel
      // flag, and the release watch. Each wake re-runs the checks; the
      // wait never spins.
      const endedNotification = new Promise<void>((resolve) => {
        const off = session.subscribeLoadedTurnEnded?.(() => {
          off?.();
          resolve();
        });
      });
      const cancelSignal = new Promise<void>((resolve) => {
        if (entry.callCancelled) {
          resolve();
          return;
        }
        const wake = () => {
          entry.cancelWaiters.delete(wake);
          resolve();
        };
        entry.cancelWaiters.add(wake);
      });
      await Promise.race([endedNotification, cancelSignal, releaseWatch]);
    }
  }

  /** The safe-re-issue degradation (inside the re-attached task) — the
   *  observably-dead classes ONLY (phase-F review round 2): a seam
   *  rejection that proves nothing is running at the backend — the
   *  interrupted classification (the replayed transcript's trailing
   *  content is not an assistant message and no live continuation
   *  followed the load), a transcript that never received its prompt, a
   *  dead/released session, or a third-party adapter whose session
   *  exposes no seam at all. A possibly-running call NEVER reaches this
   *  path: the still-running class keeps the loaded session attached and
   *  re-arms the seam. Release the loaded session (best-effort — the
   *  re-issue opens its own fresh session), record the reissue (counter
   *  bumped), surface the reason guest-visibly, and re-dispatch the SAME
   *  call id through the ordinary dispatch path. The call's concurrency
   *  token is reused (it was held for the re-attached wait and never
   *  left the slot), so the workspace's concurrent-subagent total never
   *  grows. Steers queued
   *  against the re-attached session are handed to the fresh session
   *  (the dispatch path merges `pendingSteers` into its entry's queue).
   *
   *  The drain/disposal fence is checked by the CALLER before this path
   *  is entered AND re-checked HERE after the awaited release (phase-D
   *  review rejection: the release can park past the client-presence
   *  drain's bound — or past a disposal — and the drain's forced stop
   *  settles the call durably and reports `isDrained` while the release
   *  is still parked; the old code resumed into a post-drain re-issue
   *  that recorded a reissue and opened a FRESH child after the broker
   *  reported drained). The generation is captured at entry so the
   *  re-check is exact; a fenced landing holds the call (its outcome
   *  stays as the drain/disposal left it — settled, or pending on a
   *  torn-down state) and never records a reissue, never opens. */
  private async reissueReattached(
    callId: string,
    entry: SessionEntry,
    parsed: ParsedAgentOptions,
    error: unknown,
  ): Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }> {
    const generation = this.generation;
    await Promise.resolve(entry.session.release()).catch(() => undefined);
    // The fence RE-CHECK after the awaited release (see above): the
    // release may have parked past the drain's bound, during which the
    // forced stop recorded + settled the call and the drain reported
    // drained, or past a disposal's generation bump. Re-issuing now
    // would open a fresh child after the last client disconnected (or
    // on a torn-down broker) — the call stays as the drain left it.
    if (this.draining || this.disposed || this.generation !== generation) {
      this.warnLine(
        'warn',
        `call ${callId}: ${toRejectionValue(error).message} — the loaded session's release outlived the ` +
          `client-presence drain (or the broker was disposed); the call stays as the drain/disposal left it, ` +
          `never re-issued after the last client disconnected`, // eslint-disable-line max-len
      );
      return { outcome: 'hold', value: undefined };
    }
    if (entry.queue.length > 0) {
      const pending = this.pendingSteers.get(callId) ?? [];
      this.pendingSteers.set(callId, [...pending, ...entry.queue]);
      entry.queue = [];
    }
    this.callStore.recordReissued(callId, now());
    this.warnLine(
      'warn',
      `call ${callId}: re-attached session ${entry.session.sessionId} released (${toRejectionValue(error).message}) — re-issued`, // eslint-disable-line max-len
    );
    // The re-issue opens a fresh session: covered by the opening-call
    // registry like any dispatch.
    this.openingCalls.add(callId);
    return this.runAgentTask(callId, entry.modelSpec, entry.task, parsed, this.recordedBackendId(callId));
  }

  /** The recorded backend routing pin of a call, if any (the store's
   *  `backendId` — recorded at session open). Re-issues and lazy
   *  re-attaches route by it. */
  private recordedBackendId(callId: string): string | null {
    return this.callStore.lookup(callId)?.backendId ?? null;
  }

  /**
   * Can this founding call id be lazily re-attached? A store record that
   * is a SETTLED agent call (its completion is recorded — the handle's
   * call is done, the session outlives it by the live-handle contract)
   * with a recorded backend session id. A call still opening is handled
   * by the queued-while-opening arm, a pending call by reconcile; this
   * arm exists for the doc's lazy re-attach of settled handles after a
   * drain (or a restore that left settled calls unattached).
   */
  private canLazyReattach(sessionId: string): boolean {
    if (this.isTracked(sessionId)) return false;
    const record = this.callStore.lookup(sessionId);
    if (record === undefined || record.kind !== 'agent') return false;
    if (record.completion === null || record.sessionId === null) return false;
    return true;
  }

  /**
   * The lazy re-attach (deduped per founding call id): load the store's
   * recorded backend session for a SETTLED call through the runner's own
   * `loadSession` — capability-gated exactly like the restore path's
   * re-attach arm (a custom backend without `session/load` degrades
   * through the same gate, surfaced guest-visibly as a warn line) — and
   * register it as the call's live session (settled, idle, its pending
   * steers merged). Returns undefined when the load failed or the record
   * cannot serve one; the caller settles the honest `failed` outcome.
   * Concurrent lazy re-attaches of one session share a single load.
   */
  private lazyReattach(sessionId: string): Promise<SessionEntry | undefined> {
    const existing = this.pendingReattaches.get(sessionId);
    if (existing !== undefined) return existing;
    // A lazy re-attach warms a child again: the drain latch is stale the
    // moment the load starts (phase-D review round 5: the latch used to
    // stay set until the load RESOLVED, so a disconnect while the load
    // was parked skipped the drain and the re-attached child could run
    // after the last client disconnected).
    this.drained = false;
    const promise = this.doLazyReattach(sessionId).finally(() => {
      if (this.pendingReattaches.get(sessionId) === promise) this.pendingReattaches.delete(sessionId);
    });
    this.pendingReattaches.set(sessionId, promise);
    return promise;
  }

  private async doLazyReattach(sessionId: string): Promise<SessionEntry | undefined> {
    const record = this.callStore.lookup(sessionId);
    if (record === undefined || record.kind !== 'agent' || record.completion === null || record.sessionId === null) {
      return undefined;
    }
    // The drain/disposal generation captured at START: when the load
    // lands after the drain's bound expired (or after a dispose/reset),
    // the loaded child is released immediately — it must never register
    // or prompt (phase-D review round 5: the drain cleared
    // `pendingReattaches` but the in-flight load resolved afterward and
    // registered a warm child that could run after the last client
    // disconnected).
    const generation = this.generation;
    let parsed: ParsedAgentOptions;
    try {
      parsed = this.parseAgentOptions(record.optionsJson);
    } catch {
      // A corrupt options bag: nothing was steered (the failed outcome).
      return undefined;
    }
    try {
      // The routing pin: the recorded backend id (a backend id doubles as
      // a model routing spec), falling back to the recorded model spec
      // verbatim — never the current configured default (phase-D review
      // round 2).
      const model =
        record.backendId ??
        (record.modelSpec ?? undefined);
      const session = await this.runner.loadSession({
        sessionId: record.sessionId,
        model,
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        configOptions: parsed.configOptions,
        mode: parsed.mode,
        label: `repl:${sessionId}`,
        runId: sessionId,
        keepSession: true,
        retainSessionLog: true,
      });
      if (this.disposed || this.generation !== generation) {
        // The drain's bound expired (or the broker was disposed) while
        // the load was in flight: the child is closed immediately — it
        // never registers and never prompts (nothing runs after the last
        // client disconnected / after disposal). The caller settles the
        // honest `failed` outcome.
        this.warnLine(
          'info',
          `call ${sessionId}: lazy re-attach of backend session ${record.sessionId} landed after the ` +
            `client-presence drain (or disposal) — the child was closed without registering`, // eslint-disable-line max-len
        );
        // Detached, never awaited: the drain/disposal already returned at
        // its bound, and a hung release must not hold the re-attach task
        // (the same boundless-release family as the restore fence).
        void Promise.resolve(session.release()).catch(() => undefined);
        return undefined;
      }
      const entry: SessionEntry = {
        session,
        callId: sessionId,
        modelSpec: record.modelSpec ?? '',
        task: record.detail,
        supportsSteering: session.capabilities?.supportsSteering === true,
        busy: false,
        delivering: false,
        callSettled: true,
        callCancelled: false,
        backendId: session.backendId ?? backendSegment(record.modelSpec ?? ''),
        cancelWaiters: new Set(),
        queue: (this.pendingSteers.get(sessionId) ?? []).map((steer) => ({
          callId: steer.callId,
          prompt: steer.prompt,
          promptMeta: steer.promptMeta,
          call: null,
          answer: steer.answer,
        })),
      };
      this.pendingSteers.delete(sessionId);
      this.sessions.set(sessionId, entry);
      this.registerQueuedTurns(entry);
      this.drained = false; // children are warm again
      this.warnLine('info', `call ${sessionId}: lazily re-attached to backend session ${session.sessionId}`);
      return entry;
    } catch (error) {
      this.warnLine(
        'warn',
        `call ${sessionId}: lazy re-attach of backend session ${record.sessionId} failed ` +
          `(${toRejectionValue(error).message}) — nothing was steered`, // eslint-disable-line max-len
      );
      return undefined;
    }
  }

  /**
   * One steer's lazy-re-attach task: re-attach the settled handle's
   * recorded session, then deliver the steering operation per the
   * mechanism table against the loaded session (idle → new turn, busy →
   * live injection or queued, cancel → cancel or the honest `idle`).
   * The load runs OUTSIDE the broker's serialized ops (it is a runner
   * wire call); the session registration and the delivery are ordered by
   * the shared re-attach promise, and the outcome travels the same
   * record → settle → consume pump as any steer.
   */
  private runLazyReattachSteerTask(
    callId: string,
    sessionId: string,
    action: string,
    prompt: string,
    promptMeta: Record<string, unknown> | undefined,
  ): Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }> {
    return (async () => {
      const entry = await this.lazyReattach(sessionId);
      // An interrupt landed while the load was in flight (the turn was
      // minted and targetable from the start — §4.2): the turn must
      // NEVER start. Drop it durably (the dropped marker — a restore
      // never re-queues it) and settle the steer with the recoverable
      // AGENT_CANCELLED; the pump records the completion and settles
      // the guest promise. The cancel wins over a failed load too (the
      // interrupt reported `cancelled` — the settlement must match).
      const minted = this.followUpTurns.get(callId);
      if (minted?.cancelRequested === true) {
        if (entry !== undefined) {
          entry.queue = entry.queue.filter((item) => item.callId !== callId);
        }
        this.callStore.recordDelivery(callId, 'dropped', now());
        this.followUpTurns.delete(callId);
        const value = toRejectionValue(
          new WorkflowError(`followUp ${callId} was cancelled`, CODE.AGENT_CANCELLED, {
            recoverable: true,
          }),
        );
        (value as { replBackend?: string }).replBackend = entry?.backendId ?? minted.backendId;
        return { outcome: 'reject', value };
      }
      if (entry === undefined) {
        // Nothing was steered (the load failed through the capability
        // gate or the session is lost) — the minted turn registry
        // entry (if any) is released with the honest `failed`.
        this.followUpTurns.delete(callId);
        return { outcome: 'resolve', value: 'failed' };
      }
      if (action === 'cancel') {
        if (!entry.busy) return { outcome: 'resolve', value: 'idle' };
        return this.runCancelTask(callId, entry);
      }
      if (action !== 'followUp' && action !== 'steer') {
        this.followUpTurns.delete(callId);
        return { outcome: 'resolve', value: 'failed' };
      }
      if (entry.busy) {
        // Mid-turn semantics (the delivery-outcome vocabulary — no
        // separate turn to answer): release the minted registry entry.
        this.followUpTurns.delete(callId);
        if (entry.supportsSteering) {
          return this.runInjectTask(callId, entry, prompt, promptMeta);
        }
        entry.queue.push({ callId, prompt, promptMeta, call: null, answer: false });
        return { outcome: 'resolve', value: 'queued' };
      }
      // The session is idle: followUp/steer mint a NEW turn with its own
      // call id and resolve with the TURN'S ANSWER (§4.2 — the same
      // semantics as the live idle path in `onSteer`). Cap pressure
      // queues the delivery with the pending promise (answer mode).
      if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
        this.recordQueuedDelivery(callId);
        entry.queue.push({ callId, prompt, promptMeta, call: null, answer: true });
        // Minted at enqueue like the live idle path: the queued turn is
        // visible in `agents()` and targetable before its delivery
        // starts.
        this.followUpTurns.set(callId, {
          entry,
          sessionId: entry.callId,
          prompt,
          queued: true,
          backendId: entry.backendId,
        });
        return { outcome: 'hold', value: undefined };
      }
      return this.runFollowUpTask(callId, entry, prompt, promptMeta);
    })();
  }

  /** Re-issue a lost call under the SAME call id: the store records the
   *  reissue (counter bumped), a fresh session opens through the
   *  ordinary dispatch path, and the outcome settles the existing guest
   *  promise via the reconciliation surface. A store-unknown entry
   *  (foreign snapshot / wiped store) is adopted first so the replay
   *  ledger stays complete. §4.1: an over-cap re-issue QUEUES in
   *  dispatch order for the next free slot — the call stays PENDING in
   *  the guest registry (never a `ConcurrencyLimitError` rejection; the
   *  workflow engine's queue-above-cap semantics cover every dispatch
   *  path). The queued entry reports as re-issued (it is being
   *  re-issued — not left pending, not lost). Returns whether a guest
   *  entry was newly settled (always false now — queueing settles
   *  nothing). */
  private reissueCall(
    entry: GuestSurfaceEntry,
    parsed: ParsedAgentOptions,
    reason: string,
    report: ReconcileReport,
  ): boolean {
    if (this.callStore.lookup(entry.id) === undefined) this.adoptEntry(entry, 'agent');
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      this.dispatchQueue.push({ kind: 'reissue', entry, parsed, reason, report });
      report.reissued.push(entry.id);
      return false;
    }
    this.startReissue(entry, parsed, reason, report);
    return false;
  }

  /** The re-issue dispatch body (shared by the live path and the queued
   *  path): record the reissue, register the concurrency token, and
   *  start the agent task under the SAME call id (the original backend
   *  routing pin). */
  private startReissue(
    entry: GuestSurfaceEntry,
    parsed: ParsedAgentOptions,
    reason: string,
    report: ReconcileReport,
  ): void {
    this.callStore.recordReissued(entry.id, now());
    this.agentSlots.add(entry.id);
    this.warnLine('warn', `call ${entry.id}: ${reason} — re-issued`);
    // The re-issue opens a fresh session: the opening-call registry covers
    // it like any dispatch (the drain waits for opens, not just sessions).
    this.openingCalls.add(entry.id);
    const taskPromise = this.runAgentTask(
      entry.id,
      entry.modelSpec ?? '',
      entry.detail ?? '',
      parsed,
      this.recordedBackendId(entry.id),
    );
    this.trackInFlight(entry.id, 'agent', taskPromise);
    report.reissued.push(entry.id);
  }

  /** A reconcile-time dispatch refusal (invalid registry options, or an
   *  unrecognized pending-call kind): record dispatched-rejected FIRST
   *  (a refused call
   *  is never re-issued again), settle, and surface the reason. Returns
   *  whether the guest entry was newly settled (a refusal mutates the
   *  VM and its caller must propagate the change into the changed-VM
   *  drain and its settlement boundary). (§4.1: over-cap re-issues are
   *  NOT refused — they queue via `reissueCall`.) */
  private refuseReconciled(entry: GuestSurfaceEntry, kind: 'agent' | 'steer', error: unknown, warn: string): boolean {
    if (this.callStore.lookup(entry.id) === undefined) this.adoptEntry(entry, kind);
    const value = toRejectionValue(error);
    this.recordCompletion(entry.id, { outcome: 'reject', value, completedAtMs: now() });
    const newlySettled = this.settleIntoGuest(entry.id, 'reject', value);
    this.warnLine('warn', `call ${entry.id}: ${warn}`);
    return newlySettled;
  }

  /** A pending steer whose wire call died with the process: settle the
   *  honest `failed` (recorded durably first, then into the guest — a
   *  subsequent restore settles it from the store), with a warn line.
   *  Returns whether the guest entry was newly settled. */
  private settleSteerLost(entry: GuestSurfaceEntry): boolean {
    if (this.callStore.lookup(entry.id) === undefined) this.adoptEntry(entry, 'steer');
    this.recordCompletion(entry.id, {
      outcome: 'resolve',
      value: 'failed',
      completedAtMs: now(),
    });
    const newlySettled = this.settleIntoGuest(entry.id, 'resolve', 'failed');
    this.warnLine(
      'warn',
      `steer ${entry.id}: was in flight when the process died; its outcome is unknowable — failed`,
    );
    return newlySettled;
  }

  /** Re-surface a pending checkpoint into the broker's checkpoint table
   *  (its question + options travel inside the snapshot). The restored
   *  checkpoint has no live `GuestCall` — answers settle through the
   *  reconciliation surface (`settleCheckpoint`). */
  private requeueCheckpoint(entry: GuestSurfaceEntry, record: CallRecord | undefined): void {
    if (record === undefined) this.adoptEntry(entry, 'checkpoint');
    this.checkpoints.set(entry.id, {
      callId: entry.id,
      call: null,
      question: entry.detail ?? '',
      optionsJson: entry.optionsJson,
      raisedAtMs: record?.dispatchedAtMs ?? now(),
    });
  }

  /** Settle a checkpoint's answer: through its live `GuestCall` when it
   *  has one, through the reconciliation surface when it re-surfaced
   *  from a restore (`call` is null). The answering eval's own drain
   *  fires the continuation either way. */
  private settleCheckpoint(callId: string, call: GuestCall | null, outcome: 'resolve' | 'reject', value: unknown): void {
    if (call !== null) {
      if (outcome === 'resolve') call.resolve(value);
      else call.reject(value);
      return;
    }
    this.settleIntoGuest(callId, outcome, value);
  }

  /** Adopt a registry entry the store has never seen (foreign snapshot /
   *  wiped store): record its dispatch from the entry's verbatim detail
   *  + optionsJson (+ modelSpec — the re-attach routing source), so the
   *  replay ledger stays complete (completions, re-issues and attachment
   *  records can all be written against it). */
  private adoptEntry(entry: GuestSurfaceEntry, kind: 'agent' | 'checkpoint' | 'steer'): void {
    this.callStore.recordDispatched({
      callId: entry.id,
      kind,
      detail: entry.detail ?? '',
      optionsJson: entry.optionsJson,
      modelSpec: kind === 'agent' ? entry.modelSpec : null,
      backendId: null,
      dispatchedAtMs: now(),
      reissues: 0,
      completion: null,
      sessionId: kind === 'steer' ? entry.sessionId : null,
      deliveredAtMs: null,
      droppedAtMs: null,
      queuedAtMs: null,
    });
  }

  /** Is this call already tracked by this broker (a live in-flight task,
   *  a live session, or a live deferred)? The reconcile arms' idempotence
   *  guard: a tracked call is never re-attached or re-issued twice. */
  private isTracked(callId: string): boolean {
    return this.inFlight.has(callId) || this.sessions.has(callId) || this.deferreds.has(callId);
  }

  /** A broker-authored console line (the restore path's guest-visible
   *  surfacing): rendered in the next tool result with its level prefix. */
  private warnLine(level: 'info' | 'warn', message: string): void {
    this.consoleBuffer.push({ level, line: message });
  }

  /** Cancel a dispatch QUEUED above the concurrency cap (§4.1's
   *  dispatch-order queue — a fresh dispatch, or a queued restore-time
   *  re-issue): remove it from the queue (it never starts — a freed
   *  slot must never dispatch a cancelled call) and settle it durably
   *  as the recoverable AGENT_CANCELLED, recorded FIRST (a restore
   *  settles it from the store, never re-issues it). The rejection
   *  carries the §4.6 backend attribution when the call's backend
   *  resolved. `drain` is true for the interrupt tool's id path (its
   *  own serialized op — one settlement drain fires the guest
   *  reactions within the operation) and false for the guest handle's
   *  `cancel()` (it runs INSIDE the eval's code phase, where a drain
   *  would be a reentrant VM operation — the eval's own drain phase
   *  runs the queued reactions, and the eval's provenance pass and
   *  state-changing boundary cover the settlement). Returns whether
   *  the call was found queued. Runs under the serialized chain (its
   *  callers hold it) — the shared body of the interrupt tool's id
   *  path and the guest handle's `cancel()` (the review defect:
   *  `h.cancel()` on a queued founding dispatch fell through to
   *  `failed` while the dispatch later opened and prompted). */
  private cancelQueuedDispatch(callId: string, source: string, drain: boolean): boolean {
    const queueIndex = this.dispatchQueue.findIndex((queued) =>
      queued.kind === 'dispatch' ? queued.callId === callId : queued.entry.id === callId,
    );
    if (queueIndex < 0) return false;
    const [queued] = this.dispatchQueue.splice(queueIndex, 1);
    const isReissue = queued.kind === 'reissue';
    const detail = isReissue ? (queued.entry.detail ?? '') : queued.task;
    const optionsJson = isReissue ? queued.entry.optionsJson : queued.optionsJson;
    const modelSpec = isReissue ? (queued.entry.modelSpec ?? '') : queued.modelSpec;
    const value = toRejectionValue(
      new WorkflowError(
        isReissue
          ? `call ${callId} was cancelled (${source}) while queued for re-issue (the concurrency cap)`
          : `call ${callId} was cancelled (${source}) while queued for dispatch (the concurrency cap)`,
        CODE.AGENT_CANCELLED,
        { recoverable: true },
      ),
    );
    // The §4.6 attribution: the resolved backend (the recorded
    // backend id when the store has one — a queued re-issue pins
    // the original backend — else the admission-validated segment).
    const backend =
      this.recordedBackendId(callId) ?? (modelSpec !== '' ? backendSegment(modelSpec) : undefined);
    if (backend !== undefined && this.knownBackends().includes(backend)) {
      (value as { replBackend?: string }).replBackend = backend;
    }
    this.recordDispatch(callId, 'agent', detail, optionsJson, null, modelSpec !== '' ? modelSpec : null);
    this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
    if (drain) {
      try {
        this.settleIntoGuest(callId, 'reject', value);
        this.drain();
        this.provenancePass('settlement', [callId]);
        this.sink?.boundary('settlement');
      } catch (error) {
        if (error instanceof DrainJobError) {
          this.warnLine('warn', `settlement drain interrupted after cancelling queued call ${callId}: ${errorLine(error.info)}`);
          this.sink?.boundary('settlement');
        } else throw error;
      }
    } else {
      // Inside the eval's code phase (the handle-cancel path): no
      // drain, no settlement pass here — the eval's own drain runs the
      // queued reactions and its provenance/boundary cover the
      // settlement.
      this.settleIntoGuest(callId, 'reject', value);
    }
    return true;
  }

  /** Fence + durably settle an opening call as cancelled — the
   *  `interrupt` tool's id path (and the guest handle's `cancel()`) on
   *  a call whose `openSession` is still pending (phase-E review
   *  rejection round 7: the old `cancelCall` decision skipped opening
   *  calls entirely — it returned `none`, and the eventual open
   *  resolved into a PROMPTED, supposedly-interrupted call). Mirrors
   *  the client-presence drain's bound force-stop exactly: the
   *  completion is recorded FIRST (durable — a kill after this returns
   *  settles the call from the store on restore), the guest settles
   *  first-wins, the concurrency token is released (with the global
   *  queued-delivery kick — the freed slot starts any cap-pressure
   *  follow-up immediately), and the
   *  `stoppedOpens` fence is set so an eventual late landing closes the
   *  child immediately WITHOUT prompting (its reject is a first-wins
   *  no-op against the recorded completion). Returns whether the call
   *  was still opening (false — already open, settled, or unknown —
   *  leaves everything untouched). */
  private stopOpeningCall(callId: string, source: string): boolean {
    if (!this.openingCalls.has(callId)) return false;
    this.stoppedOpens.add(callId);
    const value = toRejectionValue(
      new WorkflowError(
        `call ${callId} was cancelled by ${source} while its session was still opening — the call is ` +
          `settled, and a late child, if any, is closed without prompting`,
        CODE.AGENT_CANCELLED,
        { recoverable: true },
      ),
    );
    this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
    this.settleIntoGuest(callId, 'reject', value);
    // The freed concurrency token starts any queued steers through the
    // GLOBAL kick — the cancelled opening call's slot release is a
    // slot-free transition like any other (phase-E review rejection: the
    // release used to skip the kick, so a cap-pressure follow-up queued
    // on an idle session stayed stuck even though capacity had become
    // available).
    this.agentSlots.delete(callId);
    this.kickQueuedDeliveries();
    this.warnLine('warn', `call ${callId}: ${value.message}`);
    return true;
  }

  /**
   * Cancel one subagent call by its founding call id — the `interrupt`
   * tool's engine-side path (the guest handle's `cancel()` funnels
   * through the same session cancel; it additionally settles the guest
   * steer call). A turn in flight is cancelled (the call then rejects
   * with the recoverable `CancelledError` at the next pump); an idle
   * session is a no-op. A call whose session is still OPENING (the
   * `openSession` is in flight — a delayed backend, a parked open) is
   * fenced and settled DURABLY as cancelled right here (see
   * `stopOpeningCall`). After the client-presence drain released every
   * child, a SETTLED handle's recorded backend session is re-attached
   * lazily (the doc: followUp/steer/cancel re-attach the subagent
   * session lazily via the capability matrix) and cancelled if a turn
   * is running there; an idle loaded session is the honest no-op.
   * Returns the outcome the tool renders: `cancelled` | `idle` |
   * `failed` | `none` (no session to act on).
   */
  async cancelCall(callId: string): Promise<'cancelled' | 'idle' | 'failed' | 'none'> {
    // Phase 1 — the DECISION under the serialized chain (no runner wire
    // calls): the live entry, the still-opening call, the lazy
    // re-attach path, or nothing to act on. The wire work then runs
    // OUTSIDE the chain (phase-D review round 5: the lazy
    // `loadSession` used to run inside it, so a hung backend load held
    // the operation chain — `drainForDisconnect` queues behind the
    // chain and its deadline only starts when it enters, making the
    // documented outer drain bound ineffective).
    const decision = await this.serialized(async () => {
      this.assertAlive();
      // §4.1: a QUEUED dispatch — a fresh call above the cap or a
      // queued restore-time RE-ISSUE — the interrupt removes it from
      // the queue and settles it as cancelled (recorded first, durable:
      // a restore never re-issues it). The rejection carries the §4.6
      // backend attribution when the call's backend resolved.
      if (this.cancelQueuedDispatch(callId, 'interrupt', true)) {
        return { kind: 'opening-cancelled' as const };
      }
      // §4.2: a QUEUED followUp delivery (cap pressure on an idle
      // session) — remove it from its session's queue, drop it durably,
      // and settle the pending steer with the recoverable
      // AGENT_CANCELLED (the interrupt's cancel-by-id contract).
      const queuedSteer = this.findQueuedSteer(callId);
      if (queuedSteer !== undefined) {
        queuedSteer.entry.queue = queuedSteer.entry.queue.filter((item) => item.callId !== callId);
        this.settleQueuedFollowUpCancellation(callId, queuedSteer.entry.backendId);
        return { kind: 'opening-cancelled' as const };
      }
      const entry = this.sessions.get(callId);
      if (entry !== undefined) {
        if (!entry.busy) return { kind: 'idle' as const };
        return { kind: 'cancel-live' as const, entry };
      }
      // §4.2: an in-flight FOLLOW-UP TURN (its own addressable call id)
      // — cancel the underlying session turn; the turn task settles the
      // steer call with the recoverable AGENT_CANCELLED. The turn id
      // rides the decision so phase 3 verifies against the TURN
      // registry, not the session map (the turn id is not a session
      // key).
      const turn = this.followUpTurns.get(callId);
      if (turn !== undefined) {
        if (turn.entry === undefined) {
          // The turn's delivery still waits on the founding session's
          // lazy re-attach load. TWO homes, both settled durably: a
          // restored queue rebuild's item waits in `pendingSteers`
          // (remove it there and settle the cancellation NOW), and a
          // live followUp's load is in flight (mark it cancelled — the
          // load's completion settles the steer with the recoverable
          // AGENT_CANCELLED instead of starting the turn). Either way
          // the turn is addressable from mint time, never `none`.
          const pending = this.pendingSteers.get(turn.sessionId);
          if (pending !== undefined && pending.some((item) => item.callId === callId)) {
            const remaining = pending.filter((item) => item.callId !== callId);
            if (remaining.length > 0) this.pendingSteers.set(turn.sessionId, remaining);
            else this.pendingSteers.delete(turn.sessionId);
            this.settleQueuedFollowUpCancellation(callId, turn.backendId);
            return { kind: 'opening-cancelled' as const };
          }
          turn.cancelRequested = true;
          return { kind: 'opening-cancelled' as const };
        }
        if (turn.queued) {
          // A QUEUED turn whose delivery item is NOT in the founding
          // session's queue (it was re-homed into the session's pending
          // steers — the re-issue/drain path): remove it there and
          // settle the same durable cancellation (the queued turn is
          // addressable everywhere it waits).
          const pending = this.pendingSteers.get(turn.sessionId);
          if (pending !== undefined) {
            const remaining = pending.filter((item) => item.callId !== callId);
            if (remaining.length > 0) this.pendingSteers.set(turn.sessionId, remaining);
            else this.pendingSteers.delete(turn.sessionId);
          }
          this.settleQueuedFollowUpCancellation(callId, turn.backendId ?? turn.entry.backendId);
          return { kind: 'opening-cancelled' as const };
        }
        return { kind: 'cancel-live' as const, entry: turn.entry, turnId: callId };
      }
      // A call whose session is still OPENING (its `openSession` has
      // not resolved — the phase-E review rejection round 7 defect:
      // the decision used to skip it, return `none`, and let the
      // eventual open prompt a supposedly-interrupted call): fence +
      // settle it durably as cancelled — under the chain, exactly like
      // the drain's bound force-stop. The guest promise rejects now;
      // the late landing (if any) closes the child without prompting.
      // ONE drain fires the settlement's guest reactions (the registry
      // bookkeeping — the same post-settle drain the pump runs per
      // settled call), so a subsequent status read reports the call
      // settled, not still pending. A failed continuation drain is
      // honest output, never a cancel failure.
      if (this.openingCalls.has(callId)) {
        this.stopOpeningCall(callId, 'interrupt');
        try {
          this.drain();
          // The opening-cancel is a settlement drain that changed VM
          // state: it fires the SAME per-settlement provenance pass and
          // state-changing boundary as the pump (phase-E review
          // rejection: the cancelled opening call's settlement used to
          // skip both — the manifest missed the settlement's
          // provenance, and the daemon's sink never marked the
          // workspace dirty, so a kill immediately after the interrupt
          // restored the PRE-settlement snapshot with the call still
          // pending; the round-8 daemon regression masked the defect by
          // performing another eval and wait before the restart).
          this.provenancePass('settlement', [callId]);
          this.sink?.boundary('settlement');
        } catch (error) {
          if (error instanceof DrainJobError) {
            this.warnLine('warn', `settlement drain interrupted after cancelling opening call ${callId}: ${errorLine(error.info)}`);
            // The settlement landed even though the continuation drain
            // failed: the boundary still fires (mirrors the pump's
            // drain-failure arm) so the operation-end flush persists
            // the changed VM.
            this.sink?.boundary('settlement');
          } else throw error;
        }
        return { kind: 'opening-cancelled' as const };
      }
      // No live entry: a drained broker (or a handle whose session never
      // opened). A settled call with a recorded backend session is
      // re-attached lazily; anything else has nothing to cancel.
      if (!this.canLazyReattach(callId)) return { kind: 'none' as const };
      return { kind: 'lazy' as const };
    });
    if (decision.kind === 'none' || decision.kind === 'idle') return decision.kind;
    // The opening-cancel settled everything under the chain: no wire
    // phase, no re-check — the outcome is `cancelled` as reported.
    if (decision.kind === 'opening-cancelled') return 'cancelled';
    // Phase 2 — the wire phase (outside the chain): the lazy re-attach
    // (the doc: followUp/steer/cancel re-attach the subagent session
    // lazily via the capability matrix) and the ACP session/cancel. A
    // released/dead session makes the adapter's cancel the idempotent
    // no-op, so racing a concurrent drain is harmless.
    const entry =
      decision.kind === 'cancel-live' ? decision.entry : await this.lazyReattach(callId);
    if (entry === undefined) return 'failed';
    const turnId = decision.kind === 'cancel-live' ? decision.turnId : undefined;
    await this.cancelSession(entry);
    // Phase 3 — CONSUME under the chain: the call may have settled (or
    // the session been released) while the wire cancel was in flight. A
    // turn that settled is a settled turn: the cancel-no-op must not
    // report `cancelled`, and the cancellation marker set by phase 2 is
    // rolled back on an idle entry — marking an idle session cancelled
    // would drop its queued steers. (The rollback window is one chain
    // hop; the marker is only read by settlement/delivery bookkeeping,
    // never by the guest.)
    return this.serialized(async () => {
      this.assertAlive();
      // The §4.2 followUp-turn verify: the addressable id keys the TURN
      // registry, not the session map — a turn that settled while the
      // wire cancel was in flight reports idle (the settled turn's
      // answer already shipped), exactly like the founding-call path.
      if (turnId !== undefined) {
        // The turn may have ended while the wire cancel was in flight.
        // A turn that settled NATURALLY (its task resolved with the
        // answer) reports idle — the answer shipped, the cancel was a
        // no-op; anything else (the cancel ended it, or it is still
        // running) reports cancelled — the pump settles the steer call
        // with the recoverable AGENT_CANCELLED.
        const task = this.inFlight.get(turnId);
        if (task !== undefined && task.done) {
          const result = await task.promise;
          if (result.outcome === 'resolve') return 'idle';
        }
        return 'cancelled';
      }
      const current = this.sessions.get(callId);
      if (current !== entry) return 'idle';
      if (!current.busy) {
        current.callCancelled = false;
        return 'idle';
      }
      current.callCancelled = true;
      for (const wake of current.cancelWaiters) wake();
      return 'cancelled';
    });
  }

  /** Every pending guest call (the registry manifest) — the `status`
   *  seam. */
  pendingCalls(): GuestSurfaceEntry[] {
    this.assertAlive();
    return this.workspace.surface()?.pending() ?? [];
  }

  /**
   * Arm the eval-break signal — the `interrupt` tool's no-id path (the
   * roadmap doc: "break a runaway eval (the quickjs interrupt
   * handler)"). Returns `false` when NO eval is in flight — the
   * workspace is idle, there is no continuation to break, and NOTHING
   * is armed (phase-E review rejection: the old project-wide boolean
   * was armed regardless, so an idle workspace's next eval — or an
   * unrelated drain — consumed it before the intended continuation).
   * Also refuses when every in-flight eval is suspended on NO pending
   * host call (a never-settling local promise — no execution can ever
   * resume it, so there is nothing breakable): the guidance's refusal
   * rule, nothing is armed (phase-E review round 3).
   *
   * When an eval IS in flight (a suspended eval whose continuation will
   * run at a later execution — a settlement drain, or a direct eval's
   * own drain when a synchronous host-callback settlement like
   * `checkpoint.answer` resumes it), the signal is armed and SCOPED to
   * the arming-time active evals: it is consulted ONLY by the
   * executions that resume those evals' continuations (settlement
   * drains and direct evals' own drains — `runEval` composes it as the
   * drain-phase handler — phase-E review rejection round 2), never by
   * a fresh eval's own code or an unrelated eval's code, so an
   * unrelated eval can neither consume the signal nor be broken by it;
   * the first target continuation execution after arming breaks
   * mid-run (the quickjs interrupt handler), and the signal is
   * consumed on that observation.
   * When every arming-time target settles (completed or broken), the
   * signal is cleared with them — it never leaks into a later
   * execution.
   *
   * The signal is keyed to the armed target's CONTINUATION — the
   * eval's continuation TOKEN (phase-E review rounds 3/5, the carried
   * review's defects): the guest library's wrap-settling reaction sets
   * the continuation lease to the token immediately before the target
   * eval's continuation segment, and the signal fires only while the
   * executing JOB holds an armed token — never on whichever drain (or
   * whichever JOB) runs next. An unawaited sibling `.then` registered
   * before the target's await runs first in the settlement drain —
   * before the lease-setting reaction — so it can neither fire nor
   * consume the signal; an indirect wait (`await Promise.all([q])`)
   * is targetable through the promise graph.
   *
   * With MULTIPLE concurrently suspended evals (each suspension retains
   * its own completion), the first continuation execution after arming
   * is broken — honest ambiguity, the same stance as the provenance
   * batch labels; the doc's model runs one eval per tool call, where
   * the armed signal targets exactly the running eval.
   */
  async armEvalBreak(): Promise<boolean> {
    return this.serialized(async () => {
      this.assertAlive();
      this.sweepActiveEvals();
      if (this.activeEvalCompletions.size === 0) return false;
      // The 0.3.1+ continuation-lease surface is the targeting seam
      // (version-gated — a restored 0.3.0 snapshot reports the flag but
      // its lease-setting reaction still runs on the awaited VALUE's
      // settlement, the carried sibling-reaction defect; phase-E review
      // rejection round 7): a workspace whose resident library predates
      // it (a restored 0.1.0/0.2.0/0.3.0 snapshot) cannot key the signal
      // to an eval's continuation — the 0.2.0 log-only targeting is the
      // rejected settled-call-ids identity. Refuse honestly.
      if (!this.continuationLeaseAvailable()) return false;
      // The pending-call refusal (phase-E review round 3): a suspended
      // eval's continuation can only ever be resumed by the settlement
      // of a pending host call (the realm has no timers, and a
      // promise resolved by guest code alone would have settled within
      // the eval's own drain — a genuinely SUSPENDED eval awaits a
      // host call, directly or through any promise chain). With the
      // registry EMPTY no execution can ever resume a tracked
      // continuation — arming would be dead weight that lingers until
      // reset. Refuse. (The converse is deliberately not required: the
      // continuation identity is the promise graph, so `await
      // Promise.all([q])` is targetable through q even though the
      // awaited value is not itself a registry promise — phase-E
      // review round 5.)
      if (this.pendingIds().length === 0) return false;
      // The armed identity: the targets' continuation TOKENS (see
      // `evalTokens`). A tracked eval without a token (a suspension
      // the instrumenter never covered — a defensive corner) is not
      // targetable: refuse rather than arm dead weight.
      const tokens = new Set<string>();
      for (const completion of this.activeEvalCompletions) {
        const token = this.evalTokens.get(completion);
        if (token === undefined) return false;
        tokens.add(token);
      }
      this.evalBreakArmed = true;
      this.evalBreakTargets = new Set(this.activeEvalCompletions);
      this.evalBreakTokens = tokens;
      return true;
    });
  }

  /**
   * One pass over the retained suspended-eval completions: a completion
   * that SETTLED (its continuation completed, or was broken) is
   * released. The eval-break signal is scoped to its arming-time
   * targets: when every target settled, the signal is cleared with them
   * — a signal whose target no longer exists must never leak into a
   * later execution (a settled target can no longer be broken, and an
   * armed signal would otherwise fire at the next unrelated drain).
   * Runs at the start of every serialized operation — the only moments
   * between operations, since a drain that settles a continuation can
   * only run inside one. Trap-free: a raw promise-state read per
   * retained handle.
   *
   * The §4.4 result-history seam rides the sweep: a settled completion
   * IS the previous eval — its FULFILLED value is read trap-free into
   * `_` (a rejected completion leaves `_` unchanged, like IPython's).
   * A settled completion owed by a reset-requesting eval flips
   * `resetDue` — the teardown runs after the operation (the
   * serialized-op post-hook), once the eval actually completed.
   */
  private sweepActiveEvals(): void {
    if (this.activeEvalCompletions.size === 0 && !this.evalBreakArmed) return;
    const settled = new Set<JSValueHandle>();
    for (const completion of this.activeEvalCompletions) {
      if (completion.promiseState !== 0) settled.add(completion);
    }
    if (this.evalBreakArmed && this.evalBreakTargets.size > 0) {
      let anyLive = false;
      for (const target of this.evalBreakTargets) {
        // A target still in the active set is still pending; one in
        // `settled` was just released (its state already read — skip
        // re-reading a disposed handle).
        if (!settled.has(target) && target.promiseState === 0) {
          anyLive = true;
          break;
        }
      }
      if (!anyLive) {
        this.evalBreakArmed = false;
        this.evalBreakTargets = new Set();
        this.evalBreakTokens = new Set();
      }
    }
    for (const completion of settled) {
      this.activeEvalCompletions.delete(completion);
      this.evalTokens.delete(completion);
      this.evalBreakTargets.delete(completion);
      if (this.resetOwningCompletions.delete(completion) && this.resetOwningCompletions.size === 0) {
        // The reset-requesting eval completed (or, with several
        // outstanding, the LAST one did): the teardown is owed once
        // this operation ends.
        this.resetDue = true;
      }
      // The previous eval's completion value becomes `_` (a rejected
      // completion reads undefined — `_` stays unchanged, the error
      // already rendered through the rejection bridge).
      try {
        const value = this.workspace.readRetainedCompletion(completion) as JSValueHandle | undefined;
        if (value !== undefined) {
          try {
            this.workspace.setGlobal('_', value);
          } catch {
            // A failed `_` write must not fail the operation.
          }
          value.dispose();
        }
      } catch {
        // Best-effort bookkeeping: a hostile completion shape must not
        // break the operation.
      }
      completion.dispose();
    }
  }

  /** A guest execution that resumes a suspended eval's continuation was
   *  INTERRUPTED (the eval-break signal's consumption, or the per-eval
   *  deadline bounding a runaway continuation): the execution broke a
   *  suspended eval's continuation, and the interrupted continuation's
   *  engine wrapper NEVER settles (the quickjs interrupt aborts the
   *  async job without rejecting its promise — verified against the
   *  shipped binary), so the tracked "running eval" can only be
   *  released HERE. The callers are the pump path's drain-failure arm
   *  AND the direct-eval path (an eval's own drain interrupted —
   *  `runEval` reports `interruptedInDrain`; phase-E review rejection
   *  round 2).
   *
   * The release is EXACT (phase-E review rounds 3/5): the interrupted
   *  job's CONTINUATION LEASE (see `jobLease`) names the eval whose
   *  continuation was actually executing — the drain loop read the
   *  guest lease into the mirror before the job, and no further job
   *  ran after the drain threw. Exactly the tracked eval(s) holding
   *  that token are released. An interrupted job with NO lease — an
   *  unrelated drain (a later finite eval's own drain bounded by the
   *  deadline, a settlement of a call no tracked eval awaits) —
   *  releases NOTHING and leaves the eval-break armed state intact:
   *  the target's continuation was never running, so it is still
   *  breakable at its next execution (the carried review's defect: the
   *  old release cleared the armed signal while the target's
   *  checkpoint stayed pending and uninterruptible). The armed signal
   *  is cleared only when the released eval was an armed target and no
   *  target remains (the handler already consumed the flag when IT
   *  fired; a deadline break leaves the arm in place for any surviving
   *  target). The released handles are disposed here (between
   *  operations — the drain's exception already unwound).
   */
  private releaseInterruptedEval(): void {
    const token = this.jobLease.cell.current;
    if (token === undefined) return;
    let released = false;
    for (const completion of [...this.activeEvalCompletions]) {
      if (this.evalTokens.get(completion) === token) {
        this.activeEvalCompletions.delete(completion);
        this.evalTokens.delete(completion);
        this.evalBreakTargets.delete(completion);
        // A broken eval is finished (its continuation never settles):
        // a reset() it requested owes its teardown all the same (the
        // eval will never complete any other way).
        if (this.resetOwningCompletions.delete(completion) && this.resetOwningCompletions.size === 0) {
          this.resetDue = true;
        }
        completion.dispose();
        released = true;
      }
    }
    if (released && this.evalBreakTargets.size === 0) {
      this.evalBreakArmed = false;
      this.evalBreakTokens = new Set();
    }
  }

  /** The eval-break signal's interrupt handler: consulted by the
   *  executions that resume suspended-eval continuations — the
   *  settlement drains (`drain`) AND a direct eval's own drain
   *  (`runEval` composes it as the drain-phase handler — a continuation
   *  resumed by a synchronous host-callback settlement like
   *  `checkpoint.answer` executes inside the answering eval's drain,
   *  where the phase-E review rejection round 2's old settlement-drain-
   *  only signal was blind). A fresh eval's OWN CODE still never
   *  consults it (an unrelated eval's code can neither consume the
   *  signal nor be broken by it — the phase-E review rejection).
   *  Consumed on first observation: the quickjs interrupt polls it
   *  constantly, so the first target continuation execution after
   *  arming breaks mid-run. The signal fires ONLY while the currently-
   *  executing JOB is one of the armed targets' continuation segments —
   *  the job's lease (see `jobLease`, set by the drain loop before the
   *  job) holds one of the armed tokens (phase-E review rounds 3/5,
   *  the carried review's defects): an unrelated drain — and an
   *  unrelated JOB inside a drain that settled a target's call (an
   *  unawaited sibling `.then` registered before the target's await
   *  runs FIRST, before the lease-setting reaction; one registered
   *  AFTER the target's await runs after the wrapper's settlement but
   *  still BEFORE the lease-setting job — the lease is set only by the
   *  reaction registered on the WRAPPER itself, immediately before the
   *  await machinery's own reaction, so no other job can run with it
   *  set — phase-E review rejection round 6) — neither fires
   *  nor consumes it, and the armed state stays intact for the
   *  target's actual continuation. Returns `undefined` while nothing
   *  is armed (the composition drops it). */
  private evalBreakHandler(): (() => boolean) | undefined {
    if (!this.evalBreakArmed) return undefined;
    return () => {
      if (!this.evalBreakArmed) return false;
      const lease = this.jobLease.cell.current;
      if (lease === undefined) return false;
      if (this.evalBreakTokens.has(lease)) {
        this.evalBreakArmed = false;
        return true;
      }
      return false;
    };
  }

  /** Every pending checkpoint, oldest first (raw questions — the tool
   *  result's `checkpoints` field carries the previewed form). */
  pendingCheckpoints(): CheckpointInfo[] {
    return [...this.checkpoints.values()].map((c) => ({
      id: c.callId,
      question: c.question,
      optionsJson: c.optionsJson,
      raisedAtMs: c.raisedAtMs,
    }));
  }

  /** Every live subagent session — the `status` seam. The guest-derived
   *  `task` is previewed (head+tail capped at 200 chars, the same bound
   *  as the manifest's task surface) at the ENGINE seam so EVERY
   *  consumer — the bounded text renderer AND the structured status —
   *  is bounded: the tool's structuredContent must respect the doc's
   *  output limits (phase-E review rejection: the structured status
   *  used to copy the raw task, so a guest could push an unbounded
   *  task string through `structuredContent` while only the text
   *  content was capped). */
  liveAgents(): LiveAgentInfo[] {
    const entries: LiveAgentInfo[] = [...this.sessions.values()].map((entry) => ({
      callId: entry.callId,
      // The modelSpec ships VERBATIM (§7: the engine retains 200-char
      // metadata formatting ONLY for manifest tokens, checkpoint
      // questions and task previews — `agents()` is the §4.5
      // guest-visible plain data, and the full spec must stay
      // recoverable; the review defect capped it at 200 chars). The
      // task preview keeps its 200-char bound (a retained preview).
      modelSpec: entry.modelSpec,
      task: entry.task.length > 200 ? headTail(entry.task, 200) : entry.task,
      state: !entry.callSettled
        ? entry.busy
          ? 'running'
          : 'opening'
        : entry.delivering
          ? 'delivering'
          : 'idle',
      supportsSteering: entry.supportsSteering,
      queuedSteers: entry.queue.length,
    }));
    // The §4.2 addressable followUp turns: each minted turn gets its
    // own entry with its OWN call id (targetable by interrupt) — the
    // session entry alone would hide the turn behind the founding call.
    // A QUEUED turn (minted but waiting for a free concurrency slot) is
    // listed too, in the honest `queued` state — it is addressable
    // before its delivery starts (the review probe: a cap-queued turn
    // must be visible in `agents()` while pending).
    for (const [callId, turn] of this.followUpTurns) {
      // A turn whose founding session is still being re-attached (a
      // drained settled handle's lazy load, or a restore whose queue
      // rebuild re-attaches the founding session) renders the honest
      // `opening` state from the founding store record — the turn is
      // listed from MINT time (the review defect: a delayed load hid
      // the minted call from `agents()`). The modelSpec is the
      // founding session's, VERBATIM like the session entries.
      entries.push({
        callId,
        modelSpec: turn.entry?.modelSpec ?? this.callStore.lookup(turn.sessionId)?.modelSpec ?? '',
        task: turn.prompt.length > 200 ? headTail(turn.prompt, 200) : turn.prompt,
        state: turn.entry === undefined ? 'opening' : turn.queued ? 'queued' : 'running',
        supportsSteering: turn.entry?.supportsSteering ?? false,
        queuedSteers: turn.entry?.queue.length ?? 0,
      });
    }
    return entries;
  }

  /** The `workspace()` guest handler's JSON (§4.5): the workspace
   *  manifest as plain data — bindings with the honest handle status
   *  (`failed` for rejected handle calls — v1 showed rejected and
   *  fulfilled both as `settled`), the in-flight ids, the raised
   *  checkpoints, and the §6.2 diagnostics (reconcile summary, retained
   *  drain error, children-closed). */
  private workspaceJson(): string {
    const manifest = this.workspaceManifest();
    const bindings = manifest.bindings.map((binding) => ({
      name: binding.name,
      type: binding.type,
      sizeBytes: binding.sizeBytes,
      provenance: binding.provenance,
      task: binding.task,
      ...(binding.handleCallId !== null ? { callId: binding.handleCallId } : {}),
      ...(binding.handleStatus !== null
        ? {
            status:
              binding.handleStatus === 'settled'
                ? this.isFailedCall(binding.handleCallId)
                  ? 'failed'
                  : 'settled'
                : binding.handleStatus,
          }
        : {}),
    }));
    return JSON.stringify({
      bindings,
      inFlight: this.inFlightIds(),
      checkpoints: [...this.checkpoints.values()].map((c) => ({ id: c.callId, question: c.question })),
      diagnostics: {
        reconcile: this.lastReconcileReport,
        drainError: this.retainedDrainError,
        childrenClosed: this.drained,
      },
    });
  }

  /** The `agents()` guest handler's JSON (§4.5): the live-agent entries
   *  as plain data (v1's liveAgents entries — including the addressable
   *  followUp turns). */
  private agentsJson(): string {
    return JSON.stringify(this.liveAgents());
  }

  /** Did the store record this handle call as REJECTED (the honest
   *  `failed` handle status — §4.5)? */
  private isFailedCall(callId: string | null): boolean {
    if (callId === null) return false;
    const completion = this.callStore.lookup(callId)?.completion;
    return completion !== null && completion !== undefined && completion.outcome === 'reject';
  }

  /** The call store (read access for diagnostics and the crash-window
   *  tests). */
  store(): CallStore {
    return this.callStore;
  }

  /** True once the client-presence drain released every child (see
   *  `drainForDisconnect`): the workspace stays live, and later
   *  followUp/steer/cancel on a settled handle lazily re-attaches the
   *  recorded backend session. */
  get isDrained(): boolean {
    return this.drained;
  }

  /** The number of sessions with a turn running (the drain's progress
   *  probe). */
  busySessionCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.busy) count++;
    }
    return count;
  }

  /**
   * The `wait` tool's engine-side seam: pump until the target call ids
   * settle (or `timeoutMs` elapses — "still running" on timeout), then
   * return the SAME tool-result shape as an eval — output lines included
   * (the wait's pumps drain console events and restored-call warn lines
   * into the buffer; the doc requires wait to return the same shape, and
   * deferring output to the next eval would lose immediate guest-visible
   * restored-call output and warnings — phase-D review round 2).
   * `ids` omitted waits for the calls pending at ENTRY (with other
   * operations interleaving between pumps, the entry-time set is the
   * only stable "every pending call" reading — a call a concurrent eval
   * dispatches after entry is not waited on; see the phase-E review
   * rejection round 2 note below). Returns the rendered result plus
   * whether the target set drained within the bound.
   */
  async waitForCalls(
    ids: string[] | undefined,
    timeoutMs: number,
  ): Promise<{ result: ReplEvalResult; drained: boolean }> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // The target set is captured at ENTRY (phase-E review rejection
    // round 2: the wait used to run its whole bounded poll inside ONE
    // serialized op, so a concurrent interrupt — `cancelCall` /
    // `armEvalBreak` — queued behind it and could not cancel or break
    // until the wait finished or timed out, up to 120 s, by which point
    // the target could already have completed). The wait now runs each
    // PUMP as its own serialized unit and RELEASES the chain between
    // pumps, so other operations — interrupts, other waits, the
    // client-presence drain — interleave mid-wait: an interrupt landing
    // mid-wait arms the eval-break signal against the eval the wait is
    // pumping, and the wait's very next pump breaks it mid-run. With
    // other operations interleaving, "wait for every pending call" can
    // only mean "the calls pending when the wait started" — a call a
    // concurrent eval dispatches after entry is not waited on (the wait
    // stays bounded and deterministic).
    //
    // The CHAIN ACQUISITION itself is bounded by the wait's absolute
    // deadline (phase-E review round 4's carried defect: the entry
    // capture, every pump, and the final re-check used to enqueue onto
    // the serialization chain with NO deadline, so a wait queued behind
    // a long eval — 20 ms behind a 250 ms eval — took the eval's whole
    // remaining run (~253 ms) instead of returning at its bound; the
    // absolute deadline must bound chain contention as well as polling
    // sleep and guest drains). A pump that cannot acquire the chain
    // within the remaining budget reports "still running" — it
    // observed nothing settle — and never touches the VM while another
    // operation is mid-flight.
    let targets: Set<string>;
    // The last pending read taken UNDER the chain (rendered in the
    // result). Initialized to the explicit ids when given — the wait's
    // own target set, none of which was observed to settle before any
    // read — and empty until the entry capture for the ids-omitted
    // form (the pending surface is unreadable while another operation
    // holds the chain).
    let lastPending: string[] = ids ?? [];
    if (ids !== undefined) {
      // Explicit ids need no chain read — the target set is the input.
      targets = new Set(ids);
    } else {
      const captured = await this.trySerialized(async () => {
        this.assertAlive();
        const pending = this.pendingIds();
        lastPending = pending;
        return new Set(pending);
      }, deadline);
      if (!captured.acquired) {
        // The chain was busy for the whole budget: no pending read was
        // possible, nothing was observed to settle — the honest
        // "still running" with an empty (unreadable) pending surface.
        return { result: this.renderWaitResult([], undefined, []), drained: false };
      }
      targets = captured.value!;
    }
    const completed: string[] = [];
    let drainErrorLine: string | undefined;
    let drained = false;
    for (;;) {
      const pumped = await this.trySerialized(async () => {
        this.assertAlive();
        // Each pump runs under the REMAINING wait time: a settlement
        // drain that resumes a runaway continuation near the deadline is
        // interrupted at the wait's bound, never at the eval deadline —
        // the wait's bound is absolute (the same posture as the
        // disconnect drain).
        const { settled, drainError } = await this.pumpUnlocked(deadline);
        if (settled.length > 0) {
          // The per-call settlement boundaries fired inside
          // `pumpUnlocked` (one per settled call's continuation drain).
          completed.push(...settled);
        }
        if (drainError !== undefined) {
          // The pump's drain broke a suspended eval's continuation (the
          // armed eval-break signal's target, or the wait-bound): the
          // break is honest output in the wait's result, exactly like an
          // eval's pump-drain error line.
          drainErrorLine = errorLine(drainError.info);
        }
        const pending = this.pendingIds();
        lastPending = pending;
        return [...targets].every((id) => !pending.includes(id));
      }, deadline);
      if (!pumped.acquired) {
        // The chain was held past the deadline (a long eval): the wait
        // reports "still running" at its bound instead of queueing
        // behind the stuck operation (the round-4 carried defect).
        drained = false;
        break;
      }
      drained = pumped.value!;
      if (drained) break;
      // Sleep only for the REMAINING wait budget — never a fixed 50 ms
      // past the deadline (phase-E review round 3's carried defect: the
      // unconditional sleep made every bounded wait take ~51 ms, so a
      // 5/10/20/30 ms timeout all reported ~51 ms, violating
      // `timeoutMs`'s bounded-wait contract). The next pump still runs
      // when the deadline is already passed (the deadline check above
      // handles the terminal state; the pump itself is bounded by the
      // remaining budget through `pumpUnlocked(deadline)`).
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
    if (!drained) {
      // The deadline tripped between the last pump and the timeout
      // check — an interleaved operation (an interrupt's cancel, or
      // another pump) may have settled the targets in that window:
      // re-check once so the result is not a stale "still running"
      // (the re-check's acquisition is bounded by the REMAINING budget
      // — it may itself report the chain still busy, which is the
      // honest not-drained).
      const recheck = await this.trySerialized(async () => {
        this.assertAlive();
        const pending = this.pendingIds();
        lastPending = pending;
        return [...targets].every((id) => !pending.includes(id));
      }, deadline);
      if (recheck.acquired) drained = recheck.value!;
    }
    const result = this.renderWaitResult(completed, drainErrorLine, lastPending);
    return { result, drained };
  }

  /** Render the wait result in the eval-result shape (output lines from
   *  the console buffer, the pump-drain error line when one occurred,
   *  pending ids, checkpoints, completed ids). `pending` is the last
   *  pending read taken UNDER the chain (the wait's pumps capture it;
   *  a wait that could never acquire the chain passes the empty
   *  unreadable surface) — the renderer never re-enters the VM outside
   *  the chain.
   */
  private renderWaitResult(completed: string[], drainErrorLine: string | undefined, pending: string[]): ReplEvalResult {
    const lines: string[] = [];
    for (const event of this.consoleBuffer.splice(0)) {
      lines.push(this.renderConsoleEvent(event));
    }
    if (drainErrorLine !== undefined) lines.push(drainErrorLine);
    // §7: no output caps on guest output.
    return {
      output: lines,
      outputTruncated: false,
      pending,
      checkpoints: this.checkpointSummaries(),
      completed,
    };
  }

  /**
   * The doc's client-presence drain: on last-client disconnect the daemon
   * calls this — in-flight subagent turns DRAIN TO COMPLETION (their
   * results settle into the VM and each settlement boundary snapshots, so
   * "close the laptop while two researchers run" ends with the findings
   * durable in the workspace — never a cancel of running work), bounded
   * by `boundMs` (the daemon reuses its session-eviction TTL — the
   * spec-owed concrete drain bound; individual turns already run under
   * the runner's runaway protections, so the bound is the outer ceiling),
   * and then every idle child CLOSES (sessions released — `keepSession`
   * keeps the backend sessions re-openable). The workspace and broker
   * stay alive; on the next client connect `followUp` re-attaches the
   * subagent session lazily via the capability matrix (see
   * `canLazyReattach`/`lazyReattach`). Queued-but-undelivered steers are
   * re-queued durably against their founding session ids (the same
   * rebuild reconcile uses — their payloads live in the store), so the
   * next lazy re-attach delivers them exactly once. Returns `true` when
   * every turn drained within the bound, `false` when the bound forced
   * the remainder to cancel (the honest bounded teardown — the cancel
   * settles the calls as the recoverable `AGENT_CANCELLED`, recorded and
   * snapshotted like any settlement) or when `shouldAbort` reported a
   * reconnecting client (nothing was cancelled or released — the next
   * disconnect drains again).
   *
   * `shouldAbort` is the daemon's mid-drain presence probe (phase-D
   * review round 6): the drain consults it every iteration and before
   * every destructive phase, and aborts — children stay warm, the drain
   * latch stays clear — the moment a client is connected again.
   *
   * **The drain covers OPENING calls too** (phase-D review round 3: a
   * call blocked in `openSession` has no session entry yet, so a drain
   * that considered only registered busy sessions returned `true`
   * immediately, cleared its bookkeeping, and let the child open and run
   * after the last client disconnected). The drain waits for opening
   * calls and in-flight lazy re-attaches exactly like busy sessions;
   * when the bound expires with an open still parked, the call is
   * STOPPED — the child that eventually opens is closed immediately
   * (never prompts), the call settles as the recoverable `AGENT_CANCELLED`,
   * and queued steers are dropped durably.
   *
   * **The outer bound is absolute** (phase-D review round 3: the
   * cancel/release phases used to await `cancelSession`/`release` with no
   * remaining-time bound, so a hung backend could block disconnect/
   * shutdown indefinitely past the eviction TTL): every post-deadline
   * await races the remaining bound, and once it expires the drain
   * returns without waiting — the best-effort cancellations and releases
   * already issued keep running in the background (all promises carry
   * catch handlers, so nothing can become an unhandled rejection). The
   * GUEST DRAINS the drain's pumps trigger are bounded by the same
   * remaining bound (phase-D review round 6: a ready settlement resumes
   * the guest continuation through `drainJobs`, which used to run under
   * the per-eval deadline alone — a runaway continuation near the
   * disconnect deadline could exceed the session-eviction TTL).
   *
   * **A client reconnecting mid-drain aborts the drain** (phase-D review
   * round 6: the drain used to run to its release phase and close every
   * child regardless of presence — the doc requires children to remain
   * warm while any client is connected): the daemon passes
   * `shouldAbort` (its presence check — `clients.size > 0`), which the
   * drain consults every iteration and before every destructive phase.
   * An abort leaves every child attached and running, clears the
   * drain latch (`isDrained` stays false), and returns `false` — the
   * NEXT disconnect drains again.
   *
   * **The bound's forced stop never orphans a pending call** (phase-D
   * review round 6: a re-attached call whose seam rejected mid-drain
   * used to resolve `hold`, then the release phase discarded its
   * session — the call stayed pending forever, uncancelable except by
   * reset, because reconcile never runs again on a live workspace):
   * after the bound expires every call still pending on an attached
   * session is settled with the recoverable `AGENT_CANCELLED` (recorded
   * FIRST, settled into the guest, one bounded drain + settlement
   * boundary) — the same forced-stop vocabulary as a stopped open. A
   * still-observing task's later outcome is a first-wins no-op against
   * the recorded completion.
   *
   * **The bound's forced stop settles a still-OPENING call DURABLY at
   * the bound, not when its openSession eventually lands** (phase-D
   * review round 7: a bound-expired openSession used to be only flagged
   * in `stoppedOpens` — its call was not recorded, guest-settled,
   * drained or snapshotted until `openSession` resolved, so a parked
   * open that NEVER resolves left the broker reporting drained with
   * the call pending and uncancelable). The opening call is settled
   * with the recoverable `AGENT_CANCELLED` at the bound — recorded
   * FIRST, settled into the guest, one bounded drain + settlement
   * boundary — while the `stoppedOpens` fence is RETAINED: an eventual
   * landing still closes the child immediately without prompting, and
   * the late task's reject is a first-wins no-op against the recorded
   * completion. The same pass settles in-flight STEER wire calls the
   * bound cut off (a lazy re-attach whose load never lands, an
   * injection/delivery the release phase is about to cut) with the
   * honest `failed` — exactly what their fenced late landing would
   * have settled — so the drain never reports drained with a pending
   * call of any kind.
   *
   * **The forced stop also settles every restored call the serialized
   * reconcile had NOT yet reached** (phase-D review rejection: the
   * reconciliation registers calls in `openingCalls` only as its loop
   * reaches them — parked on the FIRST pending call's never-resolving
   * `loadSession`, it never processes the entries behind it, so a
   * forced stop that covered only the tracked calls left those entries
   * pending and uncancelable while `isDrained` reported true, and a
   * load that later landed let the resumed loop initiate SUBSEQUENT
   * loads after the drain/disposal generation bump — children opening
   * and running after the last client disconnected). Every pending
   * registry entry that is not tracked is settled at the bound
   * (completed-while-down entries from the store — the store arm's
   * semantics; agent entries with the recoverable `AGENT_CANCELLED`;
   * steers with the honest `failed`), and `reconcileAgentCall` refuses
   * to initiate any load or re-issue while the broker is
   * draining/disposed — the resumed loop settles the recorded
   * completions from the store, first-wins, and opens nothing.
   *
   * **The outer bound is measured from METHOD ENTRY, before the
   * serialized-chain wait** (phase-D review round 7: the clock used to
   * start inside the serialized closure, so a drain queued behind a
   * long operation ran its whole window AFTER the queue wait — the
   * total could exceed the session-eviction TTL by the queue wait —
   * and the loop's yield was a fixed 50 ms sleep that could land past
   * the deadline). A deadline already past at chain acquisition skips
   * straight to the forced stop; the loop's yield races the remaining
   * bound. Everything below races the remaining bound — INCLUDING the
   * chain acquisition itself (phase-D review round 8: the chain wait
   * used to have no deadline race, so a YIELDFUL queued operation — a
   * long `wait` op polling a pending call, an async op on a stuck
   * backend — could delay the drain indefinitely past its bound; when
   * the deadline expires while queued, the drain body runs WITHOUT the
   * chain, and its forced-stop settlement is first-wins and
   * generation-fenced against the stuck op's eventual landing, so an
   * unlocked forced stop settles exactly like a chained one). A hung
   * cancel/release can never block disconnect past the eviction TTL.
   */
  async drainForDisconnect(boundMs: number, shouldAbort?: () => boolean): Promise<boolean> {
    // The ABSOLUTE bound: measured at METHOD ENTRY — before the
    // serialized-chain wait — so the queue wait counts against it and
    // the drain can never run a fresh full window after the chain
    // finally freed (review round 7). The chain wait itself races the
    // remaining bound (review round 8 — see `serialized`).
    const deadline = Date.now() + Math.max(0, boundMs);
    return this.serialized(async () => {
      this.assertAlive();
      if (this.drained) return true;
      if (shouldAbort?.()) return false;
      this.draining = true;
      // Drain phase: pump until no session has a turn running, no session
      // is still opening, and no lazy re-attach is in flight (or the
      // bound expires). Each pump settles into the VM and fires the
      // settlement boundary — the daemon's snapshot sink persists each
      // drain boundary, so a kill mid-drain loses nothing. An empty pump
      // yields briefly (the turns complete asynchronously at the
      // backends; a busy spin would starve the event loop).
      for (;;) {
        if (shouldAbort?.()) {
          // A client reconnected mid-drain: the children stay warm —
          // nothing is cancelled, nothing is released, and the drain
          // latch stays clear so the next disconnect drains again.
          this.draining = false;
          return false;
        }
        const outstandingOpens = this.openingCalls.size + this.pendingReattaches.size;
        if (this.busySessionCount() === 0 && outstandingOpens === 0) break;
        if (Date.now() >= deadline) break;
        const { drainError } = await this.pumpUnlocked(deadline);
        // The pump's per-call settlement boundaries already fired inside
        // `pumpUnlocked` (one per settled call's continuation drain —
        // the daemon's snapshot sink persists each drain boundary, so a
        // kill mid-drain loses nothing). A continuation the bound
        // interrupted is honest output for the next tool result.
        if (drainError !== undefined) {
          this.warnLine('warn', `settlement drain interrupted at the disconnect bound: ${errorLine(drainError.info)}`);
        }
        if (this.busySessionCount() > 0 || this.openingCalls.size > 0 || this.pendingReattaches.size > 0) {
          // The yield is bounded by the REMAINING bound — never a fixed
          // sleep past the deadline (review round 7: a deadline that
          // expired during the pump used to add a full 50 ms overshoot).
          const remaining = deadline - Date.now();
          if (remaining > 0) await sleep(Math.min(50, remaining));
        }
      }
      const drainedWithinBound =
        this.busySessionCount() === 0 && this.openingCalls.size === 0 && this.pendingReattaches.size === 0;
      if (!drainedWithinBound) {
        if (shouldAbort?.()) {
          this.draining = false;
          return false;
        }
        // The bound is the outer ceiling: stop what it caught
        // (best-effort; the cancellations settle the calls as the
        // recoverable AGENT_CANCELLED, and a parked open's eventual
        // landing is stopped the same way), then one final pump settles
        // the cancellations into the VM (each settlement boundary
        // snapshots). Every await below races the remaining bound — a
        // hung cancel/release can never block past the eviction TTL.
        // The GENERATION bump fences every in-flight open and lazy
        // re-attach that started before this moment: when it lands, the
        // child is released immediately (never registers, never prompts
        // — phase-D review round 5: the drain used to clear
        // `pendingReattaches` without fencing the unresolved load, so a
        // late landing ran a child after the disconnect).
        this.generation++;
        for (const callId of [...this.openingCalls]) this.stoppedOpens.add(callId);
        const cancels: Promise<unknown>[] = [];
        for (const entry of this.sessions.values()) {
          if (entry.busy) {
            cancels.push(Promise.resolve(this.cancelSession(entry)).catch(() => undefined));
          }
        }
        await boundedAll(cancels, deadline);
        // One final pump settles the cancellations into the VM; its
        // per-call settlement boundaries already fired inside
        // `pumpUnlocked` (one per settled call's continuation drain) and
        // its guest drain is bounded by the remaining bound (review
        // round 6 — the outer bound is absolute).
        const final = await this.pumpUnlocked(deadline);
        if (final.drainError !== undefined) {
          this.warnLine('warn', `settlement drain interrupted at the disconnect bound: ${errorLine(final.drainError.info)}`);
        }
        // The bound's forced stop settles EVERY call still pending at
        // the bound — recorded FIRST, settled into the guest, one
        // bounded drain + settlement boundary — so the drain never
        // reports drained with a pending, uncancelable call (review
        // round 7): (a) calls still OPENING (a parked openSession whose
        // child never landed — the settlement is DURABLE at the bound,
        // not deferred until the open resolves; the `stoppedOpens`
        // fence stays so an eventual landing still closes the child
        // immediately without prompting, and the late task's reject is
        // a first-wins no-op against the recorded completion), (b) calls
        // still pending on an attached session (a held re-attach (the
        // seam rejected and the pump dropped its in-flight entry) or a
        // seam the release phase is about to cut off — a call left
        // pending here would be ORPHANED: the release phase discards its
        // session, no task tracks it, and (the workspace stays live —
        // reconcile never runs again) it would be uncancelable except
        // by reset (phase-D review round 6); a still-observing task's
        // later outcome is a first-wins no-op against the recorded
        // completion), and (c) in-flight STEER wire calls the bound cut
        // off (a lazy re-attach whose load never lands, an
        // injection/delivery turn the release phase is about to cut) —
        // settled with the honest `failed`, exactly what their fenced
        // late landing would have settled.
        const stopped: Array<[string, SessionEntry]> = [];
        for (const [callId, entry] of this.sessions) {
          if (!entry.callSettled && !this.openingCalls.has(callId)) stopped.push([callId, entry]);
        }
        const stoppedSteers = [...this.inFlight.values()].filter((task) => task.kind === 'steer' && !task.done);
        if (stopped.length > 0 || this.openingCalls.size > 0 || stoppedSteers.length > 0) {
          const settledIds: string[] = [];
          for (const callId of [...this.openingCalls]) {
            const value = toRejectionValue(
              new WorkflowError(
                `call ${callId} was cancelled by the client-presence drain: its bound expired while the session ` +
                  `was still opening — the call is settled, and a late child, if any, is closed without prompting`,
                CODE.AGENT_CANCELLED,
                { recoverable: true },
              ),
            );
            this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
            if (this.settleIntoGuest(callId, 'reject', value)) settledIds.push(callId);
            // The settled opening call's concurrency token is released
            // at the bound (its parked task is never pumped).
            this.agentSlots.delete(callId);
            this.warnLine('warn', `call ${callId}: ${value.message}`);
          }
          for (const [callId, entry] of stopped) {
            const value = toRejectionValue(
              new WorkflowError(
                `call ${callId} was cancelled by the client-presence drain: its bound expired before the call's ` +
                  `outcome became observable — the session is closing`,
                CODE.AGENT_CANCELLED,
                { recoverable: true },
              ),
            );
            this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
            if (this.settleIntoGuest(callId, 'reject', value)) settledIds.push(callId);
            entry.callSettled = true;
            entry.busy = false;
            this.warnLine('warn', `call ${callId}: ${value.message}`);
          }
          for (const task of stoppedSteers) {
            // The deliver() discipline: the store write first, and when
            // the store ALREADY holds a first completion the guest
            // settles with the STORE's completion (the store's first
            // completion is the authority — the guest must never see a
            // different value than the store records). A QUEUED
            // answer-mode followUp (its store record carries the
            // queued marker — a restored queue rebuild's delivery
            // scheduler, or a cap-queued lazy re-attach) also gains the
            // durable DROPPED marker: the cut-off turn settled `failed`
            // here, and a restore must never re-queue it for a
            // spurious second delivery turn.
            const queuedRecord = this.callStore.lookup(task.callId);
            if (
              queuedRecord?.queuedAtMs !== null &&
              queuedRecord?.queuedAtMs !== undefined &&
              queuedRecord.deliveredAtMs === null &&
              queuedRecord.droppedAtMs === null
            ) {
              this.callStore.recordDelivery(task.callId, 'dropped', now());
            }
            if (this.recordCompletion(task.callId, { outcome: 'resolve', value: 'failed', completedAtMs: now() })) {
              if (this.settleIntoGuest(task.callId, 'resolve', 'failed')) settledIds.push(task.callId);
            } else {
              const record = this.callStore.lookup(task.callId);
              const completion = record?.completion;
              if (completion === null || completion === undefined) {
                throw new Error(`Broker: store lost the recorded completion for ${task.callId}`);
              }
              if (this.settleIntoGuest(task.callId, completion.outcome, completion.value)) settledIds.push(task.callId);
            }
            this.warnLine(
              'warn',
              `steer ${task.callId}: cut off by the client-presence drain — nothing was delivered`,
            );
          }
          // The bound's forced stop also settles EVERY restored call the
          // serialized reconcile had NOT yet reached. The passes above
          // own the tracked calls (openingCalls, registered sessions,
          // in-flight tasks), but a registry entry behind a parked
          // loadSession — the serialized reconcile parks on the FIRST
          // pending call's never-resolving load and never processes the
          // entries after it — is in NONE of them: without this pass it
          // would stay pending and uncancelable while `isDrained`
          // reports true, and a load that later landed would let the
          // resumed loop initiate SUBSEQUENT loads after the generation
          // bump (a fresh child opening and running after the last
          // client disconnected — phase-D review rejection). A
          // completed-while-down entry settles from the store (the
          // reconcile store arm's semantics — a recorded completion is
          // the authority, never overwritten by the forced stop); an
          // unreached agent entry settles with the recoverable
          // AGENT_CANCELLED; an unreached steer with the honest
          // `failed` (exactly what its fenced late landing would have
          // settled). All recorded FIRST, then settled, drained and
          // snapshotted with the other bound settlements below. (The
          // gate above is always entered when unreached entries exist:
          // the reconcile loop's only await — the re-attach load — is
          // covered by the opening-call registry before it parks.)
          const pendingEntries = this.workspace.surface()?.pending() ?? [];
          for (const registryEntry of pendingEntries) {
            if (registryEntry.kind === 'checkpoint') {
              // A checkpoint the parked reconcile never re-surfaced is
              // re-registered in the broker's checkpoint table here — it
              // stays pending (a checkpoint awaits the human's answer;
              // the drain must never fabricate one) but must stay
              // ANSWERABLE across the cut-off restore (the doc:
              // "answering works across a restore" — without the
              // re-surface, `checkpoint.answer` could not find it).
              this.requeueCheckpoint(registryEntry, this.callStore.lookup(registryEntry.id));
              continue;
            }
            if (this.openingCalls.has(registryEntry.id)) continue; // owned by the pass above
            if (this.isTracked(registryEntry.id)) continue; // owned by the passes above
            const storedRecord = this.callStore.lookup(registryEntry.id);
            const storedCompletion = storedRecord?.completion;
            if (storedCompletion !== null && storedCompletion !== undefined) {
              // Completed while down: settle from the store (the same
              // settle the store arm would have performed).
              if (this.settleIntoGuest(registryEntry.id, storedCompletion.outcome, storedCompletion.value)) {
                settledIds.push(registryEntry.id);
              }
              continue;
            }
            if (registryEntry.kind === 'steer') {
              // The deliver() discipline: the store write first; a
              // store that already holds a first completion stays the
              // authority. A QUEUED answer-mode followUp (the store
              // record carries the queued marker) also gains the
              // durable DROPPED marker — the cut-off turn settled
              // `failed` here, and a restore must never re-queue it
              // for a spurious second delivery turn.
              const queuedRecord = this.callStore.lookup(registryEntry.id);
              if (
                queuedRecord?.queuedAtMs !== null &&
                queuedRecord?.queuedAtMs !== undefined &&
                queuedRecord.deliveredAtMs === null &&
                queuedRecord.droppedAtMs === null
              ) {
                this.callStore.recordDelivery(registryEntry.id, 'dropped', now());
              }
              if (this.recordCompletion(registryEntry.id, { outcome: 'resolve', value: 'failed', completedAtMs: now() })) {
                if (this.settleIntoGuest(registryEntry.id, 'resolve', 'failed')) settledIds.push(registryEntry.id);
              } else {
                const completion = this.callStore.lookup(registryEntry.id)?.completion;
                if (completion === null || completion === undefined) {
                  throw new Error(`Broker: store lost the recorded completion for ${registryEntry.id}`);
                }
                if (this.settleIntoGuest(registryEntry.id, completion.outcome, completion.value)) {
                  settledIds.push(registryEntry.id);
                }
              }
              this.warnLine(
                'warn',
                `steer ${registryEntry.id}: cut off by the client-presence drain before its wire call started — nothing was delivered`,
              );
              continue;
            }
            const value = toRejectionValue(
              new WorkflowError(
                `call ${registryEntry.id} was cancelled by the client-presence drain: its restore reconciliation ` +
                  `was cut off at the bound — the call is settled`, // eslint-disable-line max-len
                CODE.AGENT_CANCELLED,
                { recoverable: true },
              ),
            );
            this.recordCompletion(registryEntry.id, { outcome: 'reject', value, completedAtMs: now() });
            if (this.settleIntoGuest(registryEntry.id, 'reject', value)) settledIds.push(registryEntry.id);
            this.warnLine('warn', `call ${registryEntry.id}: ${value.message}`);
          }
          if (settledIds.length > 0) {
            try {
              // The interrupted-drain release — when the drain ran a
              // tracked eval's continuation — happens inside `drain`
              // itself (the interrupted job's continuation lease).
              this.drain(deadline);
            } catch (drainError) {
              if (drainError instanceof DrainJobError) {
                // The forced-stop settlements resumed a continuation that
                // the disconnect bound interrupted; the failure is
                // surfaced loudly.
                this.warnLine(
                  'warn',
                  `settlement drain interrupted at the disconnect bound: ${errorLine(drainError.info)}`,
                );
              } else {
                throw drainError;
              }
            }
            this.provenancePass('settlement', settledIds);
            this.sink?.boundary('settlement');
          }
        }
      }
      if (shouldAbort?.()) {
        this.draining = false;
        return false;
      }
      // Release phase: every session's child closes (keepSession keeps
      // the backend session re-openable). Queued-but-undelivered steers
      // are re-queued against their founding session ids FIRST — the
      // next lazy re-attach merges them into the fresh entry's queue.
      const sessions = [...this.sessions.values()];
      for (const entry of sessions) {
        const pending = this.pendingSteers.get(entry.callId) ?? [];
        if (entry.queue.length > 0) {
          this.pendingSteers.set(entry.callId, [...pending, ...entry.queue]);
          entry.queue = [];
        } else if (pending.length === 0) {
          this.pendingSteers.delete(entry.callId);
        }
      }
      const releases = sessions.map((entry) =>
        Promise.resolve(entry.session.release()).catch(() => undefined),
      );
      await boundedAll(releases, deadline);
      this.sessions.clear();
      this.agentSlots.clear();
      this.deliverySlots.clear();
      this.pendingReattaches.clear();
      this.drained = true;
      return drainedWithinBound;
    }, deadline);
  }

  /**
   * The broker-enriched workspace manifest — the `status` tool's bindings
   * surface (the roadmap doc: "top-level bindings with name, type, size,
   * provenance (which subagent produced the value, from what task, when),
   * and live-handle status. Metadata, never content — ls for the data
   * plane"). The engine enumerates the user bindings trap-free (fresh-
   * realm baseline set difference) with structure-only tokens and
   * provenance labels; this layer appends the LIVE-HANDLE STATUS from the
   * call store (`pending` / `settled` — the call id maps to the task and
   * timestamps in the store, so any claim audits back to the worker that
   * made it), the in-flight call ids, and the pending checkpoints.
   */
  workspaceManifest(): WorkspaceManifestReport {
    this.assertAlive();
    const manifest = this.workspace.manifest();
    const bindings = manifest.bindings.map((binding) => {
      let token = binding.token;
      let handleStatus: 'pending' | 'settled' | null = null;
      if (binding.handleCallId !== null) {
        const record = this.callStore.lookup(binding.handleCallId);
        handleStatus = record === undefined || record.completion === null ? 'pending' : 'settled';
        // The size travels with the handle token too (phase-E review
        // rejection: the manifest's size surface used to stop at the
        // handle marker). `formatByteSize` is the previewer's decimal
        // formatter — the same one the structure tokens use. The
        // status and call id are ALSO reported as their own structured
        // fields (phase-E review round 4: they used to live only in
        // this string).
        token = `agent handle \u00b7 ${handleStatus} \u00b7 call ${binding.handleCallId} \u00b7 ${formatByteSize(binding.sizeBytes)}`;
      }
      return {
        name: binding.name,
        token,
        type: binding.type,
        sizeBytes: binding.sizeBytes,
        handleCallId: binding.handleCallId,
        handleStatus,
        provenance: binding.provenance,
        provenanceAtMs: binding.provenanceAtMs,
        // The doc's "from what task" provenance half: the task text behind
        // a worker provenance (`worker c1` → the founding agent() call's
        // task from the call store) or an agent-handle binding's founding
        // call. Capped so the manifest stays bounded metadata.
        task: this.taskForBinding(binding.provenance, binding.handleCallId),
      };
    });
    return {
      bindings,
      logs: manifest.logs,
      evalSeq: manifest.evalSeq,
      inFlight: this.inFlightIds(),
      checkpoints: this.pendingCheckpoints(),
    };
  }

  /** Resolve a binding's task text ("from what task"): the founding
   *  agent() call's detail for a `worker cN` provenance label, or the
   *  handle's own call record for an agent-handle binding. Null when
   *  neither applies or the record is missing; capped at 200 chars
   *  (head+tail elision) so the manifest stays bounded metadata. */
  private taskForBinding(provenance: string | null, handleCallId: string | null): string | null {
    const ids: string[] = [];
    if (provenance !== null && provenance.startsWith('worker ')) {
      ids.push(...provenance.slice('worker '.length).split('+'));
    }
    if (handleCallId !== null && !ids.includes(handleCallId)) ids.push(handleCallId);
    const tasks: string[] = [];
    for (const id of ids) {
      const record = this.callStore.lookup(id);
      if (record !== undefined && record.kind === 'agent' && record.detail.length > 0) {
        tasks.push(record.detail);
      }
    }
    if (tasks.length === 0) return null;
    const joined = tasks.join(' / ');
    return joined.length > 200 ? headTail(joined, 200) : joined;
  }

  /** The in-flight host-task call ids, in dispatch order (the manifest's
   *  in-flight seam; the harness's `in_flight_ids`). */
  inFlightIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Teardown: cancel in-flight turns (best-effort), release EVERY
   * session the broker opened (whether or not it owns the runner — a
   * host-injected runner keeps its own lifetime, but the broker's
   * dedicated ACP processes are still released; review regression: an
   * injected-runner disposal used to leak every session), then dispose
   * the runner when this broker owns it, and drop the broker's state.
   * The workspace (and its VM) is the caller's to dispose.
   *
   * The teardown is BOUNDED (phase-D review round 7: it used to await
   * `cancelSession`, `session.release` and the owned runner's dispose
   * with NO deadline — a hung backend could block daemon shutdown and
   * the reset tool indefinitely, and the daemon's shutdown path entered
   * this unbounded disposal right after a failed or deadline-expired
   * drain, hanging on the exact hung backend the drain had already
   * caught). `boundMs` defaults to `DEFAULT_DISPOSE_BOUND_MS` (5 s —
   * the spec-owed decision: the engine's own default mirrors the
   * daemon's shutdown deadline; callers with a stricter budget — the
   * daemon's shutdown path, which shares ONE deadline across the drain
   * and this teardown — pass the remaining time). The bound is
   * ABSOLUTE, measured from method entry like the client-presence
   * drain's: every await races the remaining bound — INCLUDING the
   * serialized-chain acquisition (phase-D review round 8: the chain
   * wait used to have no deadline race, so a yieldful queued operation
   * could delay disposal indefinitely; when the deadline expires while
   * queued, the disposal body runs WITHOUT the chain, and its
   * bookkeeping clear is safe unlocked — the stuck op's eventual
   * landing is absorbed by the same first-wins/fenced paths as a
   * disposal that ran chained) — and once it expires the disposal
   * returns without waiting — the best-effort
   * cancellations, releases and the runner teardown already issued keep
   * running in the background (every promise carries a catch handler,
   * so nothing can become an unhandled rejection).
   */
  async dispose(boundMs: number = DEFAULT_DISPOSE_BOUND_MS): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.draining = true;
    // The disposal GENERATION bump fences every in-flight open and lazy
    // re-attach started before disposal: when it lands, the child is
    // released immediately — it never registers and never prompts after
    // disposal/reset (phase-D review round 5: `openingCalls`,
    // `stoppedOpens` and `pendingReattaches` used to be cleared without
    // fencing their unresolved promises, so a late landing could
    // re-register or run a child on a disposed broker).
    this.generation++;
    // The ABSOLUTE bound: measured at method entry — before the
    // serialized-chain wait — like the client-presence drain's (review
    // round 7); the chain wait itself races it (review round 8).
    const deadline = Date.now() + Math.max(0, boundMs);
    await this.serialized(async () => {
      const cancels: Promise<unknown>[] = [];
      const sessions = [...this.sessions.values()];
      for (const entry of sessions) {
        if (entry.busy) cancels.push(Promise.resolve(this.cancelSession(entry)).catch(() => undefined));
      }
      await boundedAll(cancels, deadline);
      const releases: Promise<unknown>[] = sessions.map((entry) =>
        Promise.resolve(entry.session.release()).catch(() => undefined),
      );
      await boundedAll(releases, deadline);
      this.sessions.clear();
      this.pendingSteers.clear();
      this.pendingReattaches.clear();
      this.checkpoints.clear();
      this.deferreds.clear();
      this.inFlight.clear();
      this.agentSlots.clear();
      this.deliverySlots.clear();
      this.openingCalls.clear();
      this.stoppedOpens.clear();
      // The eval-plane additions: queued dispatches, addressable
      // followUp turns, and live sleep timers are dropped with the
      // broker (their guest calls are gone with the workspace). The
      // owed-but-unconsumed reset() teardown dies with the broker (a
      // disposed broker owns no children to tear down).
      this.dispatchQueue.length = 0;
      this.followUpTurns.clear();
      this.sleepCalls.clear();
      this.resetDue = false;
      this.resetRequested = false;
      this.resetOwningCompletions.clear();
      // The retained suspended-eval completions and the eval-break
      // signal die with the broker (the handles are released before the
      // VM is disposed by the caller).
      for (const completion of this.activeEvalCompletions) completion.dispose();
      this.activeEvalCompletions.clear();
      this.evalTokens.clear();
      this.evalBreakTargets = new Set();
      this.evalBreakTokens = new Set();
      this.evalBreakArmed = false;
      this.lastEvalToken = undefined;
      this.jobLease.cell.current = undefined;
      if (this.ownsRunner) {
        // The owned runner's disposal races the remaining bound too
        // (review round 7: it used to be awaited without any deadline).
        // Its rejection still propagates when it wins the race — a
        // failing runner teardown is a host-side failure; a deadline
        // that wins leaves the runner's own best-effort teardown (its
        // internal allSettled releases) running in the background, and
        // the tail catch below absorbs a later rejection.
        const runnerDispose = Promise.resolve(this.runner.dispose());
        runnerDispose.catch(() => undefined);
        await boundedOne(runnerDispose, deadline);
      }
    }, deadline);
    // The workspace's eval-break slot is released with the broker (the
    // channel's slots are per-project and reusable — phase-F review
    // round 3: the old channel never released slots, and a fresh
    // workspace for the same project re-registers on its broker's
    // attach). Fire-and-forget: the channel is a best-effort relay.
    this.evalBreakChannel?.unregister(this.workspace.projectDir);
  }

  // ── Guest bridge handlers ─────────────────────────────────────────────

  /**
   * `__host_agent`: ADMISSION VALIDATION (§4.1 — the backend segment
   * against the registry, the option keys, the `configOptions`
   * vocabulary where it is knowable; all refusals settle the call
   * SYNCHRONOUSLY, recorded first — a refused call must never be
   * re-issued after a restore — and never throw), then the concurrency
   * gate: dispatches above the cap QUEUE in dispatch order for the
   * next free slot — NEVER a rejection (the workflow engine's
   * semantics; `parallel(items.map(...))` must not lose work).
   */
  private onAgent(call: GuestCall, callId: string, modelSpec: string, task: string, optionsJson: string | null): void {
    let parsed: ParsedAgentOptions;
    try {
      parsed = this.parseAgentOptions(optionsJson);
    } catch (error) {
      this.refuseAdmitted(call, callId, task, optionsJson, modelSpec, error);
      return;
    }
    const admissionError = this.validateAdmission(modelSpec, parsed);
    if (admissionError !== undefined) {
      this.refuseAdmitted(call, callId, task, optionsJson, modelSpec, admissionError);
      return;
    }
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      // §4.1: queue-above-cap — the dispatch waits for the next free
      // slot, in dispatch order. The guest call stays pending until the
      // dispatch runs; the kick (see `kickDispatchQueue`) starts it the
      // moment a slot frees. A snapshot taken while queued carries the
      // call in the guest registry; a restore re-issues it through the
      // ordinary reconcile arm.
      this.dispatchQueue.push({ kind: 'dispatch', call, callId, modelSpec, task, optionsJson, parsed });
      return;
    }
    this.startDispatch(call, callId, modelSpec, task, optionsJson, parsed);
  }

  /**
   * The admission validation (§4.1): the backend segment MUST resolve
   * against the registry at call time (built-ins plus registered custom
   * agents) — an unknown segment rejects synchronously, naming the
   * segment and enumerating the known backends, never a silent route to
   * the default backend; a spec with no known-backend prefix is an
   * error. EVERY spec validates — there is no sentinel bypass (the v1
   * reserved 'default' sentinel is deleted; verify/judgePanel resolve
   * their reviewers/graders through the runner's real
   * `defaultBackendId()`, which IS a registered segment).
   * `configOptions` keys validate at admission against the
   * resolved backend's known vocabulary WHERE IT IS KNOWABLE (the
   * runner's `knownConfigOptionIds` seam — a backend whose vocabulary
   * is genuinely dynamic returns undefined and the [C]5 fallback in
   * `runAgentTask` covers it). Returns the refusal error, or undefined
   * when the call is admitted.
   */
  private validateAdmission(modelSpec: string, parsed: ParsedAgentOptions): unknown {
    const segment = backendSegment(modelSpec);
    const known = this.knownBackends();
    if (!known.includes(segment)) {
      return new WorkflowError(
        `unknown backend "${segment}" in model spec "${modelSpec}" (known backends: ${known.join(', ')})`,
        CODE.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (parsed.configOptions !== undefined) {
      const vocabulary = this.runner.knownConfigOptionIds?.(segment);
      if (vocabulary !== undefined) {
        for (const key of Object.keys(parsed.configOptions)) {
          if (!vocabulary.includes(key)) {
            return new WorkflowError(
              `configOptions: unknown option "${key}" for backend "${segment}" ` +
                `(known options: ${vocabulary.length > 0 ? vocabulary.join(', ') : 'none'})`,
              CODE.SCRIPT_VALIDATION_ERROR,
              { recoverable: false },
            );
          }
        }
      }
    }
    return undefined;
  }

  /** The known backend ids (built-ins plus registered custom agents),
   *  lowercased and sorted — cached (the registry is fixed at runner
   *  construction). Every runner publishes its registry (the seam's
   *  `listBackends` is REQUIRED — admission validation runs on every
   *  dispatch path). */
  private knownBackends(): string[] {
    if (this.knownBackendsCache !== undefined) return this.knownBackendsCache;
    const set = new Set<string>();
    for (const id of this.runner.listBackends()) set.add(id.toLowerCase());
    this.knownBackendsCache = [...set].sort();
    return this.knownBackendsCache;
  }

  /**
   * A dispatch-time admission refusal, with the §4.6 backend attribution:
   * a call whose backend segment RESOLVED (an option-key/config-option
   * failure — the call was admitted to that backend) stamps `replBackend`
   * onto the rejection so the uncaught-error rendering names the backend
   * alongside the call id; an unknown-backend refusal has no resolved
   * backend to name (its message enumerates the vocabulary instead).
   */
  private refuseAdmitted(
    call: GuestCall,
    callId: string,
    task: string,
    optionsJson: string | null,
    modelSpec: string,
    error: unknown,
  ): void {
    const segment = backendSegment(modelSpec);
    if (this.knownBackends().includes(segment)) {
      (error as { replBackend?: string }).replBackend = segment;
    }
    this.refuse(call, callId, 'agent', task, optionsJson, error);
  }

  /** Register QUEUED answer-mode items (cap-pressure followUp turns
   *  re-homed into a session's delivery queue — a restore's queue
   *  rebuild or a re-issue/drain re-home) in the turn registry, so they
   *  stay visible in `agents()` and targetable by `interrupt` before
   *  their delivery starts. Idempotent per turn id. */
  private registerQueuedTurns(entry: SessionEntry): void {
    for (const item of entry.queue) {
      if (!item.answer) continue;
      // Unconditional: a turn registered BEFORE the session existed (a
      // restore's queue rebuild whose lazy re-attach just landed, or a
      // re-issued founding call's re-homed items) gains its entry here
      // — the turn was addressable while the session was absent and
      // stays addressable now that it is attached.
      this.followUpTurns.set(item.callId, {
        entry,
        sessionId: entry.callId,
        prompt: item.prompt,
        queued: true,
        backendId: entry.backendId,
      });
    }
  }

  /** The dispatch body (shared by the live path and the queued path):
   *  record the dispatch, register the deferred and the concurrency
   *  token, and start the async task. */
  private startDispatch(
    call: GuestCall,
    callId: string,
    modelSpec: string,
    task: string,
    optionsJson: string | null,
    parsed: ParsedAgentOptions,
  ): void {
    this.recordDispatch(callId, 'agent', task, optionsJson, null, modelSpec);
    this.deferreds.set(callId, call);
    this.agentSlots.add(callId);
    // The opening-call registry (the client-presence drain's in-flight
    // probe): the session does not exist yet — the drain must wait for it
    // exactly like a busy session (a call blocked in openSession is still
    // in flight; draining past it would let the child open and run after
    // the last client disconnected).
    this.openingCalls.add(callId);
    // A fresh dispatch makes the workspace warmable again: the drain
    // latch is STALE the moment a child may open (phase-D review round
    // 5: it used to stay set until the open RESOLVED, so a second
    // disconnect while the open was still parked skipped the drain
    // entirely and the child could prompt after the last client
    // disconnected). The latch re-sets when the drain runs.
    this.drained = false;
    const taskPromise = this.runAgentTask(callId, modelSpec, task, parsed);
    this.trackInFlight(callId, 'agent', taskPromise);
  }

  /**
   * `__host_checkpoint`: question mode parks the call and records the
   * dispatch; answer mode delivers the user's answer for the matching
   * pending checkpoint — recorded FIRST (an accepted answer must survive
   * a kill between the eval and the next snapshot; a FAILING store write
   * must leave the checkpoint pending so a later answer retry can
   * succeed — review regression: the checkpoint used to be forgotten
   * before its answer was durable, and a failed write left the guest
   * promise pending forever), then settled within the same eval,
   * first-wins. Returns whether a pending checkpoint with that id was
   * answered; an answer never touches the agent/steer call table (the
   * phase-B review regression's id-space separation).
   */
  private onCheckpoint(
    call: GuestCall | null,
    callId: string,
    question: string | null,
    optionsJson: string | null,
    answerJson: string | null,
  ): boolean | void {
    if (answerJson !== null) {
      const pending = this.checkpoints.get(callId);
      if (pending === undefined) return false;
      let answer: unknown;
      try {
        answer = JSON.parse(answerJson);
      } catch {
        // A host-side contract violation (the guest only sends
        // JSON.stringify output): reject rather than park the question
        // forever. Recorded FIRST, then the checkpoint is consumed, then
        // the call settles (a failing record leaves the checkpoint
        // pending and the call unsettled — the next answer retry works).
        this.recordCompletion(callId, {
          outcome: 'reject',
          value: toRejectionValue(new Error(`checkpoint ${callId}: answer was not valid JSON`)),
          completedAtMs: now(),
        });
        this.checkpoints.delete(callId);
        this.settleCheckpoint(callId, pending.call, 'reject', new Error(`checkpoint ${callId}: answer was not valid JSON`));
        return true;
      }
      // Record FIRST (durable), THEN consume the pending checkpoint,
      // THEN settle — a failing store write propagates as a guest error
      // in the answering eval and the checkpoint stays pending.
      this.recordCompletion(callId, { outcome: 'resolve', value: answer, completedAtMs: now() });
      this.checkpoints.delete(callId);
      this.settleCheckpoint(callId, pending.call, 'resolve', answer);
      return true;
    }
    this.recordDispatch(callId, 'checkpoint', question ?? '', optionsJson, null);
    this.checkpoints.set(callId, {
      callId,
      call: call!,
      question: question ?? '',
      optionsJson,
      raisedAtMs: now(),
    });
    // The §4.3 output line: a raised checkpoint surfaces as
    // `checkpoint c9: <question>` in the eval's output stream — the
    // question rendered as PLAIN head+tail metadata text (the retained
    // 200-char preview, §7; the §4.3 fix: never a double-JSON-quoted
    // form).
    this.consoleBuffer.push({
      level: 'log',
      line: `checkpoint ${callId}: ${headTailDescription(question ?? '', 200)}`,
    });
    return undefined;
  }

  /**
   * `__host_agent_steer`: a steering operation on a live agent handle.
   * `callId` is the operation's own registry id (the settlement key),
   * `sessionId` the founding call id (the session being steered). The
   * dispatch is recorded, then the operation runs per the steering
   * mechanism table (module docs); the outcome settles with what
   * actually happened — never a hard error. The session's cancel path
   * also settles the CANCELLED call itself through its own task.
   */
  private onSteer(call: GuestCall, callId: string, sessionId: string, action: string, payloadJson: string | null): void {
    let payload: { prompt?: unknown; options?: unknown } | null = null;
    try {
      if (payloadJson !== null) {
        const parsed: unknown = JSON.parse(payloadJson);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('steer payload must be an object');
        payload = parsed as { prompt?: unknown; options?: unknown };
      }
    } catch (error) {
      this.refuse(call, callId, 'steer', action, payloadJson, error);
      return;
    }
    this.recordDispatch(callId, 'steer', action, payloadJson, sessionId);

    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      if (action === 'cancel' && this.openingCalls.has(sessionId)) {
        // The founding call's session is still OPENING: the handle's
        // cancel() is the same cancellation as the interrupt tool's id
        // path (phase-E review rejection round 7: it used to fall
        // through to `failed` — "nothing was steered" — while the
        // eventual open went on to prompt a supposedly-cancelled
        // call). Fence + settle the call durably as cancelled, and the
        // steer resolves with what actually happened: `cancelled`.
        this.stopOpeningCall(sessionId, 'handle cancel');
        this.settleSteerSync(call, callId, 'cancelled');
        return;
      }
      // §4.1/§4.2: a founding dispatch QUEUED above the concurrency
      // cap is neither opening nor open — it waits in the dispatch
      // queue, invisible to `openingCalls`/`agentSlots`. The handle's
      // cancel() must reach it there (the review defect: the cancel
      // fell through to `failed` while the supposedly-cancelled queued
      // dispatch later opened and prompted when a slot freed). The
      // same durable AGENT_CANCELLED settlement as the interrupt
      // tool's id path; the steer resolves with what actually
      // happened: `cancelled`.
      if (action === 'cancel' && this.cancelQueuedDispatch(sessionId, 'handle cancel', false)) {
        this.settleSteerSync(call, callId, 'cancelled');
        return;
      }
      if (this.agentSlots.has(sessionId) && action !== 'cancel') {
        // The founding call is still opening (its session does not exist
        // yet — a steer in the same eval as the dispatch lands here).
        // Queue it for the call's next-turn boundary; the delivery is
        // the honest `queued` outcome.
        let prompt: string;
        let options: Record<string, unknown> | undefined;
        try {
          if (typeof payload?.prompt !== 'string') {
            throw new TypeError(`handle.${action}(prompt, options?) needs a prompt string`);
          }
          prompt = payload.prompt;
          options = payload.options === undefined ? undefined : this.parseSteerOptions(payload.options);
        } catch (error) {
          this.refuse(call, callId, 'steer', action, payloadJson, error);
          return;
        }
        const promptMeta = (options?.promptMeta as Record<string, unknown> | undefined) ?? undefined;
        const pending = this.pendingSteers.get(sessionId) ?? [];
        pending.push({ callId, prompt, promptMeta, answer: false });
        this.pendingSteers.set(sessionId, pending);
        this.settleSteerSync(call, callId, 'queued');
        return;
      }
      if (this.canLazyReattach(sessionId)) {
        // The doc's lazy re-attach: a SETTLED handle whose session was
        // released (the client-presence drain, or a restore that left the
        // settled call un-attached) re-attaches its recorded backend
        // session on demand — `followUp re-attaches the subagent session
        // lazily via the capability matrix above`. The load is
        // capability-gated through the runner's own `loadSession`; a
        // failure (no `session/load` on a custom backend, a lost
        // session) degrades to the honest `failed` with a warn line —
        // nothing was steered.
        let prompt: string;
        let promptMeta: Record<string, unknown> | undefined;
        try {
          if (action === 'cancel') {
            prompt = '';
          } else {
            if (typeof payload?.prompt !== 'string') {
              throw new TypeError(`handle.${action}(prompt, options?) needs a prompt string`);
            }
            prompt = payload.prompt;
            const options =
              payload.options === undefined ? undefined : this.parseSteerOptions(payload.options);
            promptMeta = (options?.promptMeta as Record<string, unknown> | undefined) ?? undefined;
          }
        } catch (error) {
          this.refuse(call, callId, 'steer', action, payloadJson, error);
          return;
        }
        // §4.2 addressability FROM MINT TIME: the followUp/steer turn
        // is REGISTERED before the lazy load starts — visible in
        // `agents()` and targetable by `interrupt` while the session
        // is still being re-attached (the review defect: the turn was
        // registered only once `loadSession` finished, so a delayed
        // load hid the minted call and `interrupt` returned `none`).
        // A cancel needs no turn (its outcome is the delivery
        // vocabulary's `idle`/`cancelled`).
        if (action === 'followUp' || action === 'steer') {
          const founding = this.callStore.lookup(sessionId);
          this.followUpTurns.set(callId, {
            entry: undefined,
            sessionId,
            prompt,
            queued: false,
            backendId:
              this.recordedBackendId(sessionId) ??
              (founding?.modelSpec !== null && founding?.modelSpec !== undefined && founding.modelSpec !== ''
                ? backendSegment(founding.modelSpec)
                : undefined),
          });
        }
        const task = this.runLazyReattachSteerTask(callId, sessionId, action, prompt, promptMeta);
        this.deferreds.set(callId, call);
        this.trackInFlight(callId, 'steer', task);
        return;
      }
      // No live session for the founding call (never opened, or lost
      // with the process): nothing was steered.
      this.settleSteerSync(call, callId, 'failed');
      return;
    }

    if (action === 'cancel') {
      if (!entry.busy) {
        // Nothing is running — the agent is already stopped.
        this.settleSteerSync(call, callId, 'idle');
        return;
      }
      const task = this.runCancelTask(callId, entry);
      this.deferreds.set(callId, call);
      this.trackInFlight(callId, 'steer', task);
      return;
    }

    // followUp / steer.
    if (action !== 'followUp' && action !== 'steer') {
      this.settleSteerSync(call, callId, 'failed');
      return;
    }
    let prompt: string;
    let options: Record<string, unknown> | undefined;
    try {
      if (typeof payload?.prompt !== 'string') {
        throw new TypeError(`handle.${action}(prompt, options?) needs a prompt string`);
      }
      prompt = payload.prompt;
      options = payload.options === undefined ? undefined : this.parseSteerOptions(payload.options);
    } catch (error) {
      this.refuse(call, callId, 'steer', action, payloadJson, error);
      return;
    }
    const promptMeta = (options?.promptMeta as Record<string, unknown> | undefined) ?? undefined;

    if (entry.busy) {
      if (entry.supportsSteering) {
        // Live injection into the in-flight turn.
        const task = this.runInjectTask(callId, entry, prompt, promptMeta);
        this.deferreds.set(callId, call);
        this.trackInFlight(callId, 'steer', task);
      } else {
        // Queued for next-turn delivery — the honest immediate outcome
        // (the MID-TURN delivery-outcome vocabulary, §4.2).
        entry.queue.push({ callId, prompt, promptMeta, call: null, answer: false });
        this.settleSteerSync(call, callId, 'queued');
      }
      return;
    }

    // The session is idle: followUp/steer mint a NEW TURN with its own
    // call id and resolve with the TURN'S ANSWER (§4.2 — idle-session
    // steer is the followUp alias; never the bare 'startedNewTurn'
    // token, never a discarded turn). UNLESS the workspace cap is
    // exhausted (a follow-up turn IS the subagent working; the
    // six-agent ceiling is absolute): the steer queues on the durable
    // delivery queue — its promise stays PENDING until the delivery
    // turn runs and settles with the answer; `kickQueuedDeliveries`
    // starts it the moment a slot frees (review regression: idle-handle
    // follow-ups used to start without checking the cap, so a
    // maxConcurrentAgents=1 workspace could run two subagent turns
    // concurrently).
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      this.recordQueuedDelivery(callId);
      this.deferreds.set(callId, call);
      entry.queue.push({ callId, prompt, promptMeta, call, answer: true });
      // The turn is MINTED at enqueue (the §4.2 addressable turn): it
      // is visible in `agents()`/`liveAgents()` and targetable by
      // `interrupt` while it waits for a free slot — never hidden
      // behind the cap until its delivery starts.
      this.followUpTurns.set(callId, {
        entry,
        sessionId: entry.callId,
        prompt,
        queued: true,
        backendId: entry.backendId,
      });
      return;
    }
    const task = this.runFollowUpTask(callId, entry, prompt, promptMeta);
    this.deferreds.set(callId, call);
    this.trackInFlight(callId, 'steer', task);
  }

  /** The durable QUEUED marker for a cap-pressure followUp (§4.2): the
   *  steer's store record gains `queuedAtMs` so a restore's queue
   *  rebuild re-queues it for delivery exactly once (the completion is
   *  deliberately NOT recorded — the promise resolves with the turn's
   *  ANSWER when the delivery runs, and the store's first completion is
   *  the settlement authority). */
  private recordQueuedDelivery(callId: string): void {
    this.callStore.recordQueued(callId, now());
  }

  /** `__host_console`: buffer the event; the next tool result renders it
   *  (the guest-rendered one line per call, non-log levels prefixed). */
  private onConsole(event: { level: string; line: string }): void {
    this.consoleBuffer.push(event);
  }

  /** `__host_sleep`: settle the call from a HOST-side timer (the VM
   *  itself stays timer-free — §4.7). The settlement is tracked under a
   *  host-minted key (not a guest call id — sleeps never enter the
   *  guest registry or the call store) so the pump's readiness probe
   *  sees it; the pump resolves the guest promise and drains the
   *  continuation. A timer firing after the broker was disposed is a
   *  harmless no-op (the call is gone with the workspace). */
  private onSleep(call: GuestCall, ms: number): void {
    const key = `sleep${++this.sleepSeq}`;
    const task = { call, done: false };
    this.sleepCalls.set(key, task);
    const delay = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 2 ** 31 - 1) : 0;
    setTimeout(() => {
      task.done = true;
    }, delay);
  }

  // ── Dispatch, tasks, settlement ───────────────────────────────────────

  /** Record a dispatch (idempotent per id — a re-issue of a known id
   *  keeps the original record). Steer records carry the FOUNDING session
   *  id (`sessionId` — the restore path's queue rebuild keys on it);
   *  agent/checkpoint records pass null. Agent records ALSO persist the
   *  model spec verbatim (`modelSpec` — the re-attach routing source; a
   *  restore or lazy re-attach must not re-resolve the spec against the
   *  current default backend, phase-D review round 2). */
  private recordDispatch(
    callId: string,
    kind: 'agent' | 'checkpoint' | 'steer',
    detail: string,
    optionsJson: string | null,
    sessionId: string | null = null,
    modelSpec: string | null = null,
  ): void {
    this.callStore.recordDispatched({
      callId,
      kind,
      detail,
      optionsJson,
      modelSpec,
      backendId: null,
      dispatchedAtMs: now(),
      reissues: 0,
      completion: null,
      sessionId,
      deliveredAtMs: null,
      droppedAtMs: null,
      queuedAtMs: null,
    });
  }

  /** Record a completion (first-wins — returns whether newly recorded). */
  private recordCompletion(callId: string, outcome: CallOutcome): boolean {
    return this.callStore.recordCompleted(callId, outcome);
  }

  /** A dispatch-time refusal: record dispatched + rejected FIRST (a
   *  refused call must never be re-issued after a restore), then settle
   *  the guest call with the recoverable/non-recoverable error. */
  private refuse(call: GuestCall, callId: string, kind: 'agent' | 'steer', detail: string, optionsJson: string | null, error: unknown): void {
    this.recordDispatch(callId, kind, detail, optionsJson);
    const value = toRejectionValue(error);
    this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
    call.reject(value);
    this.syncSettled.push(callId);
  }

  /** A synchronous steering settlement (no session, idle cancel, queued
   *  delivery, bad action): recorded then settled, like every other
   *  settlement. */
  private settleSteerSync(call: GuestCall, callId: string, outcome: SteeringOutcomeValue): void {
    this.recordCompletion(callId, { outcome: 'resolve', value: outcome, completedAtMs: now() });
    call.resolve(outcome);
    this.syncSettled.push(callId);
  }

  /** Track an in-flight host task with the poll-shaped readiness flag. */
  private trackInFlight(
    callId: string,
    kind: 'agent' | 'steer',
    promise: Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }>,
  ): void {
    const entry: InFlightTask = { callId, kind, promise, done: false };
    promise.then(
      () => {
        entry.done = true;
      },
      () => {
        entry.done = true;
      },
    );
    this.inFlight.set(callId, entry);
  }

  /** The agent call task: open the session, run the prompt, shape the
   *  result (schema ladder or text), and report the outcome. The session
   *  stays open after the call settles — the live-handle contract. The
   *  model spec is admission-validated (its backend segment resolved
   *  against the registry — §4.1) and passed verbatim. The schema rides
   *  session creation (`openSession`
   *  folds it into the backend's native session/new channel — Claude);
   *  the per-turn channels (Codex's `outputSchema` forward, the in-band
   *  contract for pi/custom) are the runner's own, applied inside
   *  `InteractiveSession.prompt` from that same schema.
   */
  private async runAgentTask(
    callId: string,
    modelSpec: string,
    task: string,
    parsed: ParsedAgentOptions,
    backendIdOverride: string | null = null,
  ): Promise<{ outcome: 'resolve' | 'reject' | 'hold'; value: unknown }> {
    let openedSession: BrokerSession | undefined;
    // The drain/disposal generation captured at START: an `openSession`
    // that lands after the drain's bound expired (or after a
    // dispose/reset) is STOPPED exactly like a drain-stopped open — the
    // child is released immediately and never prompts (phase-D review
    // round 5: the disposal cleared `openingCalls`/`stoppedOpens`
    // without fencing the unresolved open, so a late landing could
    // re-register and prompt after disposal/reset).
    const generation = this.generation;
    try {
      const session = await this.runner.openSession({
        // The routing pin: a re-issue of a call that once had a backend
        // re-routes to the ORIGINAL backend (a backend id doubles as a
        // model routing spec), never to the current configured default
        // (phase-D review round 2: routing by the current default across
        // a restart could open the re-issued session on the wrong
        // backend).
        model: backendIdOverride ?? (modelSpec ?? undefined),
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        configOptions: parsed.configOptions,
        mode: parsed.mode,
        label: `repl:${callId}`,
        runId: callId,
        keepSession: true,
        retainSessionLog: true,
      });
      openedSession = session;
      if (this.stoppedOpens.has(callId) || this.disposed || this.generation !== generation) {
        // The client-presence drain's bound expired (or the broker was
        // disposed/reset) while this open was in flight: the call is
        // STOPPED — the child is closed immediately (it never prompts —
        // nothing runs after the last client disconnected, and nothing
        // runs after disposal), queued steers are dropped durably, and
        // the call settles as the recoverable AGENT_CANCELLED. The
        // stopped marker is consumed here so a later reconcile re-issues
        // normally.
        this.stoppedOpens.delete(callId);
        this.openingCalls.delete(callId);
        this.dropPendingSteers(
          callId,
          new Error('the client-presence drain stopped this call while its session was still opening'),
        );
        // Detached, never awaited: the drain already settled the call at
        // its bound, and a hung release must not park the stopped task
        // (the same boundless-release family as the restore fence).
        void Promise.resolve(session.release()).catch(() => undefined);
        return {
          outcome: 'reject',
          value: toRejectionValue(
            new WorkflowError(
              `call ${callId} was stopped by the client-presence drain while its session was still opening`,
              CODE.AGENT_CANCELLED,
              { recoverable: true },
            ),
          ),
        };
      }
      this.openingCalls.delete(callId);
      this.drained = false; // children are warm again
      const entry: SessionEntry = {
        session,
        callId,
        modelSpec,
        task,
        backendId: session.backendId ?? backendSegment(modelSpec),
        supportsSteering: session.capabilities?.supportsSteering === true,
        busy: false,
        delivering: false,
        callSettled: false,
        callCancelled: false,
        cancelWaiters: new Set(),
        queue: (this.pendingSteers.get(callId) ?? []).map((steer) => ({
          callId: steer.callId,
          prompt: steer.prompt,
          promptMeta: steer.promptMeta,
          call: null,
          answer: steer.answer,
        })),
      };
      this.pendingSteers.delete(callId);
      this.sessions.set(callId, entry);
      this.registerQueuedTurns(entry);
      // Durable re-attach key (phase D): record the backend session id
      // (and the RESOLVED backend id — the re-attach routing pin) the
      // moment the session opens — BEFORE the prompt is sent — so a
      // crash with a turn in flight leaves a restore able to re-attach
      // this session on the RIGHT backend (without the record, the
      // restore would re-issue a call whose turn may still be running at
      // the backend — duplicated work — or route the load by the current
      // default backend and miss the original session). A failing record
      // is a host-side failure: the call rejects (the session stays open
      // and tracked, so dispose releases it).
      this.callStore.recordAttached(callId, session.sessionId, now(), session.backendId ?? null);
      entry.busy = true;
      const turn = await session.prompt(task);
      this.assertNormalStopReason(turn.stopReason, callId);
      const value =
        parsed.schema !== undefined
          ? await this.resolveStructuredOutput(entry, parsed)
          : this.finalText(entry);
      return { outcome: 'resolve', value };
    } catch (error) {
      if (openedSession === undefined) {
        // The founding session never opened: same-eval steers queued
        // against this call (their promises already resolved `queued`)
        // can never be delivered. Nothing is hidden — each gets the
        // documented delivery warning in the next tool result — and the
        // undelivered state is recorded durably (dropped marker) so a
        // restore never resurrects a dead queue.
        this.openingCalls.delete(callId);
        this.dropPendingSteers(callId, error);
      }
      // The §4.6 attribution: the rejecting call names its resolved
      // backend. The session's own backend id when it opened, else the
      // admission-validated segment.
      const value = toRejectionValue(error);
      const backend =
        openedSession !== undefined
          ? (openedSession.backendId ?? backendSegment(modelSpec))
          : backendSegment(modelSpec);
      (value as { replBackend?: string }).replBackend = backend;
      // The [C]5 fallback: a backend whose config-option vocabulary is
      // genuinely dynamic cannot be validated at admission — its LATE
      // error MUST name the offending key. When the call carried
      // configOptions and the failure does not already name one, one
      // bounded diagnostic reopen WITHOUT the config options decides
      // whether the config caused the failure; if it did, the rejection
      // names the offending key(s) explicitly.
      if (openedSession === undefined && parsed.configOptions !== undefined && Object.keys(parsed.configOptions).length > 0) {
        return {
          outcome: 'reject',
          value: await this.configOptionLateError(callId, modelSpec, parsed, value, backendIdOverride),
        };
      }
      return { outcome: 'reject', value };
    }
  }

  /**
   * The [C]5 fallback body: decide whether the openSession failure was
   * the config options' doing and, when it was, guarantee the rejection
   * NAMES the offending key. The diagnostic reopen (configOptions
   * omitted, session NOT kept open) is the only admission-unknowable
   * vocabulary the engine can consult — it runs once, on the failure
   * path only, before any prompt was sent (no paid spawn).
   */
  private async configOptionLateError(
    callId: string,
    modelSpec: string,
    parsed: ParsedAgentOptions,
    original: { name: string; message: string; code?: string; recoverable?: boolean },
    backendIdOverride: string | null,
  ): Promise<{ name: string; message: string; code?: string; recoverable?: boolean; replBackend?: string }> {
    const keys = Object.keys(parsed.configOptions!);
    // The backend may already have named the key in its own message.
    if (keys.some((key) => original.message.includes(key))) return original;
    let diagnostic: BrokerSession | undefined;
    try {
      diagnostic = await this.runner.openSession({
        model: backendIdOverride ?? (modelSpec ?? undefined),
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        mode: parsed.mode,
        label: `repl:${callId}`,
        runId: callId,
        keepSession: false,
        retainSessionLog: true,
      });
    } catch {
      // The diagnostic open failed WITHOUT the config options too: the
      // failure was not observably config-caused, but the [C]5
      // guarantee stands — a late error on a call that carried
      // configOptions MUST name the offending key even when the
      // diagnostic reopen cannot decide (the review probe: an original
      // `invalid config option` with no key and a failing diagnostic
      // reopen produced an unchanged generic rejection). The rejection
      // names the key(s) and reports the backend's original error
      // verbatim.
      const carried = keys.map((key) => `"${key}"`).join(', ');
      const backend = backendIdOverride ?? backendSegment(modelSpec);
      return {
        name: 'ConfigOptionsError',
        message:
          `backend ${backend} rejected the call with configOptions ${carried} present — the offending key ` +
          (keys.length === 1 ? `is ${carried}` : `is among ${carried}`) +
          ` (backend error: ${original.message}; a diagnostic open without configOptions failed too)`, // eslint-disable-line max-len
        recoverable: false,
        // The §4.6 attribution: the [C]5 fallback's replacement error
        // names the resolved backend too (the call id is stamped by the
        // guest library at settlement).
        replBackend: backend,
      };
    }
    try {
      // The config options caused the failure: name the offending key
      // (exactly, when the call carried one; exhaustively — with the
      // backend's own error — when it carried several and the adapter
      // publishes no per-key seam to isolate further).
      const carried = keys.map((key) => `"${key}"`).join(', ');
      const backend = diagnostic.backendId ?? backendSegment(modelSpec);
      return {
        name: 'ConfigOptionsError',
        message:
          `backend ${backend} rejected the call's configOptions — offending key ` +
          (keys.length === 1 ? carried : `among: ${carried}`) +
          ` (backend error: ${original.message})`,
        recoverable: false,
        // The §4.6 attribution: the [C]5 fallback's replacement error
        // names the resolved backend too (the call id is stamped by the
        // guest library at settlement).
        replBackend: backend,
      };
    } finally {
      void Promise.resolve(diagnostic.release()).catch(() => undefined);
    }
  }

  /** The founding session failed to open: every steer queued against the
   *  still-opening call is dropped — recorded in the store (first-wins
   *  `dropped` marker; the guest promises already resolved `queued`) and
   *  surfaced as a warn-level line per steer. */
  private dropPendingSteers(callId: string, error: unknown): void {
    const pending = this.pendingSteers.get(callId);
    this.pendingSteers.delete(callId);
    if (pending === undefined) return;
    for (const steer of pending) {
      try {
        this.callStore.recordDelivery(steer.callId, 'dropped', now());
      } catch (recordError) {
        // A failing store must not silence the visible warning.
        this.consoleBuffer.push({
          level: 'warn',
          line: `steer ${steer.callId} (on ${callId}): queued delivery dropped, but its drop could not be recorded: ${toRejectionValue(recordError).message}`,
        });
      }
      this.warnDeliveryFailure(steer.callId, callId, error);
    }
  }

  /** The schema ladder, driven by acp-agents' own resolver over the
   *  session (the same convert/check + re-prompt machinery `run()` uses;
   *  the one divergence is documented in the module docs). */
  private async resolveStructuredOutput(
    entry: SessionEntry,
    parsed: ParsedAgentOptions,
  ): Promise<unknown> {
    const session = entry.session;
    const structuredSession: StructuredSession = {
      prompt: async (repromptText: string) => {
        const turn = await session.prompt(repromptText);
        // A repair turn that refuses / truncates / cancels must surface
        // distinctly instead of silently continuing the ladder (the
        // runner's own ladder does the same).
        this.assertNormalStopReason(turn.stopReason, entry.callId);
      },
      // Final message only, matching the runner: prose extraction over
      // the whole turn would resurrect the first-JSON-wins bug.
      lastText: () => session.finalMessageText(),
      tryNative: () => session.rawStructuredOutput() ?? parseFinalJson(session.finalMessageText()),
    };
    return resolveStructuredOutput(structuredSession, parsed.schema as never, {
      label: `repl:${entry.callId}`,
    });
  }

  /** The no-schema result: the latest turn's assistant text, mirroring
   *  the runner's `AGENT_EMPTY_OUTPUT` refusal. */
  private finalText(entry: SessionEntry): string {
    return this.finalTextOf(entry.session.currentTurnText(), entry.callId);
  }

  /** The shared empty-output gate for a completed turn's text (used by
   *  the live path and the re-attached path alike). */
  private finalTextOf(text: string, callId: string): string {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new WorkflowError('Subagent produced no assistant output', CODE.AGENT_EMPTY_OUTPUT, {
        recoverable: true,
      });
    }
    return trimmed;
  }

  /** The stop-reason gate, mirroring the runner's own (with the REPL's
   *  `AGENT_CANCELLED` code for the orchestrator-driven cancel). */
  private assertNormalStopReason(stopReason: string, callId: string): void {
    switch (stopReason) {
      case 'refusal':
        throw new WorkflowError('model refused to respond', CODE.AGENT_EXECUTION_ERROR, {
          recoverable: false,
          agentLabel: `repl:${callId}`,
        });
      case 'max_tokens':
      case 'max_turn_requests':
        throw new WorkflowError(`output truncated (stop reason: ${stopReason})`, CODE.AGENT_EXECUTION_ERROR, {
          recoverable: false,
          agentLabel: `repl:${callId}`,
        });
      case 'cancelled':
        // Orchestrator-driven cancellation is RECOVERABLE (review
        // regression: this used to be recoverable: false, which the guest
        // combinators treat as a halt signal — cancelling one worker then
        // aborted the parallel()/pipeline() owning it). The module docs'
        // cancel contract ("the cancelled call itself rejects with the
        // recoverable CancelledError") and the monorepo convention agree:
        // one call's cancellation must never abort the surrounding
        // orchestration. The store's cancelled-founding-call check keys on
        // the CODE, not the flag, so the queue-drop semantics are
        // unchanged.
        throw new WorkflowError(`call ${callId} was cancelled`, CODE.AGENT_CANCELLED, {
          recoverable: true,
          agentLabel: `repl:${callId}`,
        });
      default:
        return; // "end_turn" and any unrecognized future reason: normal
    }
  }

  /** The steering wire call for a supported backend with a turn in
   *  flight. */
  private async runInjectTask(
    callId: string,
    entry: SessionEntry,
    prompt: string,
    promptMeta: Record<string, unknown> | undefined,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    try {
      const outcome = await entry.session.steer(prompt, { promptMeta });
      // §4.2: a MID-TURN steer resolves EXACTLY the delivery-outcome
      // vocabulary (`injected` / `queued` / `failed`). A backend
      // `startedNewTurn` — the injection raced the turn's end and the
      // backend started a new turn with the content — maps to `queued`
      // (accepted for next-turn delivery); the v1 bare token never
      // reaches the guest.
      if (outcome === 'startedNewTurn') {
        this.warnLine(
          'info',
          `steer ${callId} (on ${entry.callId}): the in-flight turn ended before the injection — ` +
            `the backend started a new turn with the content (queued)`, // eslint-disable-line max-len
        );
        return { outcome: 'resolve', value: 'queued' };
      }
      if (outcome === 'injected' || outcome === 'queued' || outcome === 'failed') {
        return { outcome: 'resolve', value: outcome };
      }
      // An outcome OUTSIDE the vocabulary (a third-party adapter's own
      // value): the engine constrains mid-turn outcomes to exactly
      // `injected` / `queued` / `failed` — never a passthrough. The
      // steer wire call did not reject, so the content was accepted;
      // without proof of live injection the honest vocabulary value is
      // `queued` (accepted for delivery on the backend's own terms).
      this.warnLine(
        'warn',
        `steer ${callId} (on ${entry.callId}): the backend resolved an unrecognized steering outcome ` +
          `${JSON.stringify(outcome)} — constrained to the delivery-outcome vocabulary (queued)`, // eslint-disable-line max-len
      );
      return { outcome: 'resolve', value: 'queued' };
    } catch {
      // Nothing hard-errors: a wire failure resolves `failed`.
      return { outcome: 'resolve', value: 'failed' };
    }
  }

  /** The delivery turn for a DELIVERY-OUTCOME item (a mid-turn no-
   *  extension steer whose guest call already resolved `queued` at
   *  enqueue, and the still-opening-call boundary deliveries): the
   *  content folds into the session's next turn; the turn's own result
   *  has no separate addressable call (its promise settled at enqueue —
   *  the §4.2 delivery-outcome vocabulary). The delivered marker rides
   *  the session's handoff acknowledgment exactly as before. */
  private async runPromptTask(
    callId: string,
    entry: SessionEntry,
    prompt: string,
    promptMeta: Record<string, unknown> | undefined,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    try {
      entry.busy = true;
      entry.delivering = entry.callSettled;
      if (entry.delivering) this.deliverySlots.add(entry.callId);
      // Invoke the prompt FIRST — the hand-off to the backend — and
      // record the `delivered` marker only in the session's handoff
      // acknowledgment, which fires only once the prompt has passed
      // every preflight check (released session, aborted signal,
      // prompt-in-flight) AND the underlying ACP session/prompt request
      // has actually been invoked — the wire send happens synchronously
      // inside the invocation, so a marker recorded in the acknowledgment
      // can never precede the hand-off (review regression: the marker
      // used to be recorded right after the prompt promise was CREATED,
      // before the backend prompt was invoked — a crash in that interval,
      // or an ASYNC pre-handoff rejection, produced a non-null marker
      // for a steer the backend never saw, and reconcile then skipped
      // that never-delivered steer permanently). A crash before the
      // acknowledgment leaves the steer undelivered-in-the-store, so a
      // restore re-queues it; after it, the payload is on the wire and
      // replay would duplicate — the at-least-once direction is preserved
      // on both sides. The marker applies only to QUEUED steers (their
      // store completion is `queued`); a direct steer's completion is
      // recorded by the pump when its turn settles, which is its own
      // authority. A failing marker record aborts the turn as a delivery
      // failure (the payload was already handed off; re-delivery after a
      // restore is preferrable to loss).
      const turnPromise = entry.session.prompt(prompt, {
        promptMeta,
        onHandoff: () => {
          const record = this.callStore.lookup(callId);
          if (record?.completion?.value === 'queued') {
            this.callStore.recordDelivery(callId, 'delivered', now());
          }
        },
      });
      const turn = await turnPromise;
      this.assertNormalStopReason(turn.stopReason, callId);
      return { outcome: 'resolve', value: 'queued' };
    } catch (error) {
      if (isCancellation(error)) {
        // The turn was cancelled mid-delivery — the remaining queue is
        // dropped (the turn stream it was queued onto is gone).
        this.dropQueue(entry);
        return { outcome: 'resolve', value: 'failed' };
      }
      this.warnDeliveryFailure(callId, entry.callId, error);
      return { outcome: 'resolve', value: 'failed' };
    } finally {
      this.endDeliveryTurn(entry);
    }
  }

  /**
   * The §4.2 FOLLOW-UP TURN: a followUp/steer on a settled or idle
   * session mints a NEW turn with its own call id (this steer call's
   * own id — the addressable turn, visible in `agents()`/`liveAgents()`
   * and targetable by `interrupt`) and its promise resolves with the
   * TURN'S ANSWER — the SAME value semantics as `agent()`: the
   * schema-validated object when the founding handle was created with
   * `schema` (its recorded options bag drives the ladder), the final
   * assistant text otherwise (never the bare `startedNewTurn` token,
   * never a discarded turn). A turn failure rejects the call with the
   * attributed error (the §4.6 call-id + backend attribution), and a
   * cancellation rejects with the recoverable `AGENT_CANCELLED` family.
   */
  private async runFollowUpTask(
    callId: string,
    entry: SessionEntry,
    prompt: string,
    promptMeta: Record<string, unknown> | undefined,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    this.followUpTurns.set(callId, {
      entry,
      sessionId: entry.callId,
      prompt,
      queued: false,
      backendId: entry.backendId,
    });
    try {
      entry.busy = true;
      entry.delivering = entry.callSettled;
      if (entry.delivering) this.deliverySlots.add(entry.callId);
      const turnPromise = entry.session.prompt(prompt, {
        promptMeta,
        onHandoff: () => {
          // The delivered marker for a QUEUED followUp (its store record
          // carries the queued marker, no completion — see
          // `recordQueuedDelivery`): once handed to the backend the
          // payload is on the wire; a restore must not re-queue it.
          const record = this.callStore.lookup(callId);
          if (record !== undefined && record.queuedAtMs !== null && record.deliveredAtMs === null) {
            this.callStore.recordDelivery(callId, 'delivered', now());
          }
        },
      });
      const turn = await turnPromise;
      this.assertNormalStopReason(turn.stopReason, callId);
      // The turn's answer, with the SAME value semantics as agent()
      // (§4.2): the founding handle's schema — its recorded options bag
      // — drives the schema-validated object; a schema-less handle
      // resolves the latest turn's assistant text (the empty-output
      // gate included). A corrupt founding record degrades to the
      // text answer.
      const founding = this.callStore.lookup(entry.callId);
      let foundingParsed: ParsedAgentOptions | undefined;
      if (founding !== undefined && founding.optionsJson !== null) {
        try {
          foundingParsed = this.parseAgentOptions(founding.optionsJson);
        } catch {
          foundingParsed = undefined;
        }
      }
      if (foundingParsed?.schema !== undefined) {
        return { outcome: 'resolve', value: await this.resolveStructuredOutput(entry, foundingParsed) };
      }
      return { outcome: 'resolve', value: this.finalText(entry) };
    } catch (error) {
      if (isCancellation(error)) {
        // The follow-up turn was cancelled (the interrupt tool's id
        // path, or the founding handle's cancel) — the remaining queue
        // is dropped (the turn stream it was queued onto is gone) and
        // the call rejects recoverable, the AGENT_CANCELLED family.
        this.dropQueue(entry);
        const value = toRejectionValue(
          new WorkflowError(`followUp ${callId} was cancelled`, CODE.AGENT_CANCELLED, {
            recoverable: true,
            agentLabel: `repl:${callId}`,
          }),
        );
        // The §4.6 attribution covers the cancellation path too: the
        // rejecting followUp names its call id (the guest library
        // stamps it on settlement) AND its resolved backend (stamped
        // here — the review probe: the uncaught rendering showed the
        // call id but no backend).
        (value as { replBackend?: string }).replBackend = entry.backendId;
        return { outcome: 'reject', value };
      }
      // The §4.6 attribution: the rejecting followUp names its call id
      // (the guest library stamps it on settlement) and its resolved
      // backend (stamped here).
      const value = toRejectionValue(error);
      (value as { replBackend?: string }).replBackend = entry.backendId;
      return { outcome: 'reject', value };
    } finally {
      this.followUpTurns.delete(callId);
      this.endDeliveryTurn(entry);
    }
  }

  /** The cancel operation on a busy session. */
  private async runCancelTask(
    callId: string,
    entry: SessionEntry,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    try {
      await this.cancelSession(entry);
      return { outcome: 'resolve', value: 'cancelled' };
    } catch {
      return { outcome: 'resolve', value: 'failed' };
    }
  }

  /** Cancel the session's active turn (ACP `session/cancel`); the turn's
   *  owning task (the call or a delivery) observes the cancellation and
   *  settles accordingly. Best-effort: a cancel that cannot be delivered
   *  resolves `failed` on the steer side and leaves the call task to its
   *  own fate. */
  private async cancelSession(entry: SessionEntry): Promise<void> {
    await entry.session.cancel();
    this.markCancelled(entry);
  }

  /** Set the entry's cancel flag and wake its waiters (the
   *  non-re-armable settlement wait's cancel signal — a held re-attach
   *  call is settled as the recoverable `AGENT_CANCELLED` the moment a
   *  cancel lands, never left pending until the drain). Idempotent;
   *  waiters are one-shot and removed on fire. */
  private markCancelled(entry: SessionEntry): void {
    if (entry.callCancelled) return;
    entry.callCancelled = true;
    for (const wake of [...entry.cancelWaiters]) {
      entry.cancelWaiters.delete(wake);
      wake();
    }
  }

  /** Drop a cancelled/failed call's queued steers. Delivery-outcome
   *  items already resolved `queued` at enqueue — the cancellation is
   *  the visible reason delivery never happens. Every dropped steer is
   *  recorded DURABLY (first-wins `dropped` marker) before the
   *  in-memory queue is cleared: a restore must never resurrect a
   *  dropped delivery. A failing record propagates (host-side failure)
   *  and the queue is left untouched for the next attempt. An
   *  ANSWER-MODE item is a minted §4.2 turn: dropping it never
   *  discards the turn — its guest promise settles with an explicit
   *  recoverable AGENT_CANCELLED rejection and its completion is
   *  recorded (the review defect: a cancelled in-flight followUp's
   *  dropQueue deleted its queued answer-mode siblings from
   *  `agents()` with NO completion recorded and their guest promises
   *  pending forever). */
  private dropQueue(entry: SessionEntry): void {
    for (const item of entry.queue) {
      this.callStore.recordDelivery(item.callId, 'dropped', now());
      if (item.answer) {
        this.settleDroppedQueuedFollowUp(item.callId, entry);
      }
    }
    entry.queue = [];
  }

  /** One dropped QUEUED answer-mode followUp (see `dropQueue`): record
   *  the reject completion (first-wins) and settle the guest promise —
   *  the settlement reactions fire at the next execution (the drop
   *  runs inside a task body, outside the serialized chain, so no
   *  drain here — a drain would race the operation; the completion and
   *  the dropped marker are already durable, so a restore settles the
   *  item from the store exactly once). */
  private settleDroppedQueuedFollowUp(callId: string, entry: SessionEntry): void {
    this.followUpTurns.delete(callId);
    const value = toRejectionValue(
      new WorkflowError(
        `followUp ${callId} was dropped with the cancelled queue — the turn never ran`,
        CODE.AGENT_CANCELLED,
        { recoverable: true },
      ),
    );
    // The §4.6 attribution: the followUp's resolved backend (the
    // founding session's own).
    (value as { replBackend?: string }).replBackend = entry.backendId;
    this.recordCompletion(callId, { outcome: 'reject', value, completedAtMs: now() });
    try {
      this.settleIntoGuest(callId, 'reject', value);
    } catch (error) {
      // A failing settlement must not mask the drop (the completion is
      // already durable — a restore settles from the store).
      this.warnLine(
        'warn',
        `followUp ${callId}: the dropped queued turn's settlement into the guest failed: ${toRejectionValue(error).message}`, // eslint-disable-line max-len
      );
    }
  }

  /** A delivery turn failed (a queued steer's delivery or a direct
   *  follow-up's prompt): surface a warn-level line in the next tool
   *  result (nothing is hidden — a queued steer's own promise already
   *  resolved `queued`; a direct steer resolves `failed`). */
  private warnDeliveryFailure(steerCallId: string, sessionCallId: string, error: unknown): void {
    const message = toRejectionValue(error).message;
    this.consoleBuffer.push({
      level: 'warn',
      line: `steer ${steerCallId} (on ${sessionCallId}): delivery failed: ${message}`,
    });
  }

  /** Start one queued steer's delivery turn. The `delivered` marker is
   *  NOT recorded here — `runPromptTask` records it inside the session's
   *  handoff acknowledgment, i.e. only once the prompt has passed every
   *  preflight and has actually been handed to the backend (see there):
   *  a marker recorded before that would make a crash — or an async
   *  pre-handoff rejection — leave a never-delivered steer marked
   *  delivered, skipped by reconcile forever (review regression). The
   *  absolute cap guard stays here too: a delivery turn is subagent work
   *  and never starts while the cap is exhausted (kickQueuedDeliveries is
   *  the scheduler; this guard makes the ceiling unconditional). */
  private startQueuedDelivery(entry: SessionEntry): void {
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) return;
    const next = entry.queue[0];
    if (next === undefined) return;
    entry.queue.shift();
    // The §4.2 split: an answer-mode item is a followUp/steer whose
    // guest call is still pending — the delivery turn settles it with
    // the TURN'S ANSWER (runFollowUpTask); a delivery-outcome item
    // already resolved `queued` at enqueue and its delivery folds into
    // the session's next turn (runPromptTask).
    if (next.answer) {
      const task = this.runFollowUpTask(next.callId, entry, next.prompt, next.promptMeta);
      if (next.call !== null) this.deferreds.set(next.callId, next.call);
      this.trackInFlight(next.callId, 'steer', task);
      return;
    }
    void this.runPromptTask(next.callId, entry, next.prompt, next.promptMeta);
  }

  /** Start as many queued delivery turns as the cap allows, sessions in
   *  open order (called whenever a concurrency slot frees — an agent
   *  call settling or a follow-up turn ending). This is the ONLY
   *  scheduler for queued payloads, including cap-pressure queues on
   *  idle sessions: without the global pass, a steer queued on an idle
   *  session would wait forever for its own session's turn to end. The
   *  §4.1 queued DISPATCHES run first (in dispatch order — an agent
   *  dispatch queueing never loses its place to a later steering
   *  delivery). */
  private kickQueuedDeliveries(): void {
    for (;;) {
      if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) return;
      // §4.1: queued dispatches first, FIFO (a queued re-issue keeps its
      // dispatch-order place alongside fresh dispatches).
      const queued = this.dispatchQueue.shift();
      if (queued !== undefined) {
        if (queued.kind === 'dispatch') {
          this.startDispatch(queued.call, queued.callId, queued.modelSpec, queued.task, queued.optionsJson, queued.parsed);
        } else {
          this.startReissue(queued.entry, queued.parsed, queued.reason, queued.report);
        }
        continue;
      }
      let candidate: SessionEntry | undefined;
      for (const entry of this.sessions.values()) {
        if (!entry.busy && !entry.callCancelled && entry.queue.length > 0) {
          candidate = entry;
          break;
        }
      }
      if (candidate === undefined) return;
      this.startQueuedDelivery(candidate);
    }
  }

  /** A delivery turn ended (settled or cancelled): the session is idle;
   *  any queued steers (its own or any other session's) start through
   *  the global kick as slots allow. */
  private endDeliveryTurn(entry: SessionEntry): void {
    entry.busy = false;
    entry.delivering = false;
    this.deliverySlots.delete(entry.callId);
    if (entry.callCancelled) {
      this.dropQueue(entry);
      this.kickQueuedDeliveries();
      return;
    }
    this.kickQueuedDeliveries();
  }

  // ── The settlement pump ───────────────────────────────────────────────

  private async pumpUnlocked(boundDeadlineMs?: number): Promise<{ settled: string[]; drainError?: DrainJobError }> {
    this.assertAlive();
    const settled: string[] = [];
    for (;;) {
      const ready = [...this.inFlight.values()].filter((t) => t.done);
      const readySleeps = [...this.sleepCalls.entries()].filter(([, task]) => task.done);
      if (ready.length === 0 && readySleeps.length === 0) break;
      for (const [sleepKey, sleepTask] of readySleeps) {
        // A `sleep(ms)` settlement (the host timer fired): settle the
        // guest call directly (no store record — sleeps are never
        // registry calls), then one drain + provenance pass like every
        // settled call. A drain failure keeps the already-settled ids
        // and reports the error like the agent/steer arm.
        this.sleepCalls.delete(sleepKey);
        try {
          sleepTask.call.resolve(undefined);
        } catch {
          // The call was already settled (first-wins) — nothing to do.
        }
        try {
          this.drain(boundDeadlineMs);
          this.provenancePass('settlement');
          this.sink?.boundary('settlement');
        } catch (error) {
          if (error instanceof DrainJobError) {
            this.sink?.boundary('settlement');
            this.retainedDrainError = { name: error.info.name, message: error.info.message, atMs: now() };
            this.sweepActiveEvals();
            return { settled, drainError: error };
          }
          throw error;
        }
      }
      for (const entry of ready) {
        const outcome: { outcome: 'resolve' | 'reject' | 'hold'; value: unknown } = await entry.promise;
        if (outcome.outcome === 'hold') {
          // The drain/disposal fences only (phase-F review: the re-attach
          // arm's unobservable-turn degradation was deleted — a
          // non-re-armable seam rejection and a missing seam now re-issue
          // under the same call id, the doc's honest fallback): the
          // in-flight entry is dropped WITHOUT recording or settling —
          // either the client-presence drain's forced stop already settled
          // the call DURABLY (recorded + guest-settled at the bound), or
          // the broker was disposed and the state owning the call is being
          // torn down. The condition was surfaced guest-visibly by the
          // task. ALSO the queue-scheduler shape (a restored queued
          // followUp's delivery scheduler and the lazy re-attach arm's
          // cap-queue): the hold entry's call id is REUSED by the
          // delivery task that starts once a slot frees — the drop must
          // only remove the map entry when it still holds THIS task (the
          // review probe: the stale hold arm deleted the freshly tracked
          // delivery task by id, leaving a completed delivery turn with
          // no recorded completion and a pending guest promise).
          if (this.inFlight.get(entry.callId) === entry) {
            this.inFlight.delete(entry.callId);
          }
          continue;
        }
        try {
          // Narrowed past the `hold` branch above: the pump only ever
          // delivers resolve/reject outcomes (hold drops the entry).
          this.deliver(entry.callId, outcome as { outcome: 'resolve' | 'reject'; value: unknown });
        } catch (error) {
          // The outcome stays IN FLIGHT (its readiness flag is already
          // set) — the next pump retries. Both the store write and the
          // guest settlement are first-wins idempotent, so the retry
          // settles exactly once. The failure propagates to the caller:
          // a store IO failure is a host-side failure, not a guest
          // outcome.
          throw error;
        }
        this.inFlight.delete(entry.callId);
        if (entry.kind === 'agent') this.onCallSettled(entry.callId);
        settled.push(entry.callId);
        // ONE drain + ONE provenance pass PER SETTLED CALL (phase-D
        // review round 5: the pump used to deliver every simultaneously
        // ready call and then run one drain + one provenance pass
        // labelled with all their ids — two independent continuations
        // producing separate bindings were both attributed to both
        // workers/tasks, violating the doc's per-value producer/task
        // provenance). Each call's continuation drain is attributed to
        // THAT call alone (`worker c1`, not `worker c1+c2`), and each
        // drain that changed VM state fires the state-changing boundary
        // (the sink's burst debounce coalesces the batch into one write
        // at the operation's flush). A drain failure stops the pump with
        // the already-settled ids still reported (review regression: an
        // interrupted continuation used to erase every id the pump had
        // settled).
        try {
          // The drain itself performs the interrupted-drain release
          // when it ran a tracked eval's continuation (the interrupted
          // job's continuation lease — see `releaseInterruptedEval`).
          this.drain(boundDeadlineMs);
          this.provenancePass('settlement', [entry.callId]);
          this.sink?.boundary('settlement');
        } catch (error) {
          if (error instanceof DrainJobError) {
            // The delivery happened; the continuation drain failed. The
            // settled call ids must NOT be lost with the error (review
            // regression: an interrupted continuation used to erase
            // every id the pump had settled) — the caller reports them
            // alongside the drain-failure line. The state-changing
            // boundary still fires: the settlement landed (the VM
            // changed) and the operation-end flush must have a dirty
            // boundary to persist it.
            this.sink?.boundary('settlement');
            // §6.2: the drain error DEMOTES to workspace().diagnostics
            // (retained; the eval surface reports it only as a line in
            // the next result).
            this.retainedDrainError = { name: error.info.name, message: error.info.message, atMs: now() };
            // A suspended eval's continuation may still have completed
            // before the drain failure — the sweep reads any settled
            // completion into `_` and releases it.
            this.sweepActiveEvals();
            return { settled, drainError: error };
          }
          throw error;
        }
      }
    }
    // The pump's drains may have completed suspended evals (their
    // continuations resumed by the deliveries): the sweep reads the
    // settled values into `_` right here, so a `pump()` returns with
    // the result history already updated (the §4.4 seam — `await
    // sleep(10); 42`, pump, then `_` reads `42`).
    this.sweepActiveEvals();
    return { settled };
  }

  /** An agent call's settlement transition: the session is idle (its
   *  concurrency token is released — UNCONDITIONALLY, so an agent call
   *  whose session never opened (openSession failure) still frees its
   *  slot; review regression: a failed open used to leak the token and
   *  refuse every later dispatch under a tight cap) and queued steers
   *  start their delivery turns through the global kick; a cancelled
   *  call's queue is dropped. */
  private onCallSettled(callId: string): void {
    this.agentSlots.delete(callId);
    const entry = this.sessions.get(callId);
    if (entry !== undefined) {
      entry.callSettled = true;
      entry.busy = false;
      if (entry.callCancelled) {
        this.dropQueue(entry);
        this.kickQueuedDeliveries();
        return;
      }
    }
    this.kickQueuedDeliveries();
  }

  /** Record → settle → consume for one ready outcome (the exactly-once
   *  discipline). The store write happens BEFORE the guest settlement;
   *  on a crash between the two, the next delivery (or the restore's
   *  reconcile) settles from the store — never twice. When the store
   *  ALREADY holds a first completion (a re-delivery after a crash, or a
   *  second pump attempt), the guest settles with the STORE's completion,
   *  never the newer host outcome — the store's first completion is the
   *  authority and the guest must never see a different value than the
   *  store records (review regression: the newer live outcome used to
   *  settle the guest while the store kept the first, leaving them
   *  disagreeing). */
  private deliver(
    callId: string,
    outcome: { outcome: 'resolve' | 'reject'; value: unknown },
  ): void {
    const newlyRecorded = this.recordCompletion(callId, {
      outcome: outcome.outcome,
      value: outcome.value,
      completedAtMs: now(),
    });
    if (!newlyRecorded) {
      const record = this.callStore.lookup(callId);
      const completion = record?.completion;
      if (completion === null || completion === undefined) {
        throw new Error(`Broker: store lost the recorded completion for ${callId}`);
      }
      this.settleIntoGuest(callId, completion.outcome, completion.value);
      return;
    }
    this.settleIntoGuest(callId, outcome.outcome, outcome.value);
  }

  /** Settle one call into the guest: through its live deferred when this
   *  broker issued it, through the reconciliation surface otherwise
   *  (the restored-broker route). Both converge on the guest's
   *  idempotent first-wins settle. Returns whether the guest entry was
   *  newly settled (a no-op replay of an already-settled id reports
   *  false — the changed-VM bookkeeping's source of truth). */
  private settleIntoGuest(callId: string, outcome: 'resolve' | 'reject', value: unknown): boolean {
    const call = this.deferreds.get(callId);
    this.deferreds.delete(callId);
    if (call !== undefined) {
      if (outcome === 'resolve') call.resolve(value);
      else call.reject(value);
      return true;
    }
    const surface = this.workspace.surface();
    if (surface === undefined) {
      throw new Error(`Broker: cannot settle ${callId} — the guest surface is not installed`);
    }
    return surface.settle(callId, outcome, value);
  }

  /** One settlement drain with the broker's interrupt handler armed (a
   *  continuation resumed by settlement cannot run away unguarded). The
   *  drain also runs under the per-eval wall-clock deadline (a
   *  settlement drain can itself resume a runaway continuation — it
   *  gets the same bound) and, when the drain is the client-presence
   *  teardown's pump, under the REMAINING disconnect bound
   *  (`boundDeadlineMs` — phase-D review round 6: the outer drain bound
   *  is absolute, so a settlement that resumed a runaway continuation
   *  near the disconnect deadline can never exceed the session-eviction
   *  TTL).
   *
   * The drain carries the per-job CONTINUATION-LEASE plumbing (see
   * `jobLease`): the drain loop mirrors the guest lease per job, and
   * the eval-break signal's handler fires only while the executing job
   * holds an armed token — the executing job IS the armed eval's
   * continuation segment (phase-E review rounds 3/5: the carried
   * defect's drainInterruptHandler fired on every later drain
   * regardless of which continuation it was actually executing). A
   * drain interrupted while running a TRACKED eval's continuation
   * releases exactly the tracked eval holding the interrupted job's
   * token here (the `releaseInterruptedEval` gate); an unrelated
   * interrupted drain releases nothing and leaves the eval-break armed
   * state intact. */
  private drain(boundDeadlineMs?: number): void {
    // The OUT-OF-BAND probe's execution marker: this drain began now (a
    // break armed mid-drain breaks the running job — an interrupt lands
    // promptly mid-wait).
    this.currentExecutionStartSeq = this.evalBreakChannel?.executionStartMarker() ?? 0;
    const boundHandler =
      boundDeadlineMs === undefined ? undefined : () => Date.now() >= boundDeadlineMs;
    try {
      this.workspace.drainJobs({
        // The eval-break signal rides ONLY the settlement drains (see
        // `evalBreakHandler`): a fresh eval's own code and its own job
        // drain never consult it (phase-E review rejection — the armed
        // signal used to be the broker's DEFAULT eval handler, so an
        // unrelated eval consumed it before the intended continuation).
        // The OUT-OF-BAND probe rides BOTH (see `evalBreakProbe`): a
        // synchronously running eval OR drain is exactly the blocked-
        // main-thread case the worker channel exists for.
        interruptHandler: this.composedInterrupt(
          this.evalBreakProbe(),
          this.interruptHandler,
          this.evalBreakHandler(),
          boundHandler,
        ),
        // The per-job continuation-lease plumbing (see `jobLease`): the
        // drain loop reads the guest lease before each job into the
        // mirror and clears it after a lease-carrying job — the
        // eval-break signal's firing identity and the interrupted-drain
        // release decision.
        jobLease: this.jobLease,
      });
    } catch (error) {
      if (error instanceof DrainJobError) {
        // The interrupted drain RAN a tracked suspended eval's
        // continuation (the interrupted job's continuation lease — see
        // `releaseInterruptedEval`): the continuation is broken and its
        // wrapper never settles — release the intersecting tracked
        // eval NOW. An unrelated interrupted drain releases nothing:
        // the armed state and the tracked evals stay intact (phase-E
        // review round 3's carried defect).
        this.releaseInterruptedEval();
      }
      throw error;
    }
  }

  /** The per-eval wall-clock deadline interrupt (the harness's eval
   *  guard; see `BrokerOptions.evalTimeoutMs`): a fresh handler per
   *  operation, interrupting once the operation exceeds the budget.
   *  Returns `undefined` when the deadline is disabled (`0`/`null`), so
   *  the caller falls back to no handler. */
  private deadlineHandler(): (() => boolean) | undefined {
    if (!(this.evalTimeoutMs > 0)) return undefined;
    const deadline = Date.now() + this.evalTimeoutMs;
    return () => Date.now() >= deadline;
  }

  /** One maintenance pass of the per-binding provenance registry after a
   *  guest-entering operation (the workspace manifest's provenance seam;
   *  see `provenance.ts`). Orientation metadata only — never throws. */
  private provenancePass(origin: 'eval' | 'settlement', callIds: string[] = []): void {
    try {
      this.workspace.provenanceRecord(
        origin === 'eval' ? { kind: 'eval' } : { kind: 'settlement', callIds },
      );
    } catch {
      // Orientation metadata: a failing pass must never break the
      // operation that triggered it.
    }
  }

  // ── Eval + rendering ──────────────────────────────────────────────────

  /** Run the eval (with the rejection bridge armed) and read the
   *  completion. The broker-level interrupt handler is the DEFAULT for
   *  evals too: a direct eval that runs away must be bounded even when
   *  the caller supplies no per-eval handler (review regression: the
   *  configured handler used to apply only to settlement drains, so a
   *  runaway eval could hang the workspace indefinitely). A caller's
   *  per-eval handler still overrides it. The per-eval wall-clock
   *  deadline ALWAYS applies on top (phase-D review round 2: the
   *  interrupt tool's armed signal alone could only break the NEXT
   *  execution, because a synchronous runaway eval blocks the event loop
   *  — the deadline makes the CURRENTLY running eval always breakable
   *  through the quickjs interrupt handler, even when an explicit signal
   *  handler is armed and unset). */
  private runEval(code: string, options: ReplEvalOptions): { outcome: ReplEvalOutcome; completion?: unknown; interruptedInDrain?: boolean } {
    // The OUT-OF-BAND probe's execution marker: this eval's code phase
    // began now — a break armed after this instant breaks THIS eval; a
    // stale flag (armed before) is dropped on first observation.
    this.currentExecutionStartSeq = this.evalBreakChannel?.executionStartMarker() ?? 0;
    // The continuation-lease mirror starts clean: the code phase must
    // never read a token a PREVIOUS drain's last lease-carrying job
    // left in the mirror (the reset handler's continuation attribution
    // reads it — a code-phase reset() must read undefined and be
    // attributed by the eval op's own snapshot, never by a stale
    // token). The drain phases re-set the mirror per job.
    this.jobLease.cell.current = undefined;
    this.inRunEval = true;
    try {
      return this.runEvalInner(code, options);
    } finally {
      this.inRunEval = false;
    }
  }

  /** The `runEval` body (see above): the `inRunEval` marker frames the
   *  whole execution — code phase and own drain alike. */
  private runEvalInner(code: string, options: ReplEvalOptions): { outcome: ReplEvalOutcome; completion?: unknown; interruptedInDrain?: boolean } {
    // The eval's CONTINUATION TOKEN (phase-E review round 5): minted
    // per eval, embedded in the instrumented code's `__replAwait(value,
    // token)` calls (see `await-instrument.ts`), and attributed to the
    // completion wrapper when the eval suspends (`eval()`). The guest
    // library's wrap-settling reaction sets the continuation lease to
    // this token immediately before the eval's continuation segment —
    // the eval-break signal's genuine continuation identity. The token
    // is minted even when the library lacks the lease surface (the arm
    // refuses then); the attribution is harmless.
    const token = `e${++this.evalTokenSeq}`;
    this.lastEvalToken = token;
    // The top-level-await instrumenter (see `await-instrument.ts`):
    // rewrites the eval's top-level `await x` into
    // `await <hygienic helper>(x, TOKEN)` so the guest library can wrap
    // the awaited value — the continuation-lease seam (phase-E review
    // round 5). Gated on the workspace's library carrying the 0.3.1+
    // lease surface (version-gated — the 0.3.0 copy's lease-set
    // ordering carries the sibling-reaction defect, phase-E review
    // rejection round 7): a restored snapshot with the 0.1.0/0.2.0/0.3.0
    // library is served as-is and simply gets no instrumentation (the
    // interrupt degrades to the honest refusal — the 0.2.0 log-only
    // targeting is the rejected settled-call-ids identity).
    const instrumented = this.continuationLeaseAvailable()
      ? instrumentTopLevelAwaits(code, token, { wrapIterables: this.iterableLeaseAvailable() })
      : code;
    const result = this.workspace.evalWithCompletion(instrumented, {
      ...options,
      // The per-eval handler overrides the broker-level default (the
      // documented contract); the per-eval wall-clock deadline ALWAYS
      // composes on top (phase-D review round 2: a currently-running
      // runaway eval is always breakable).
      interruptHandler: this.composedInterrupt(
        this.evalBreakProbe(),
        options.interruptHandler ?? this.interruptHandler,
      ),
      // The eval-break signal rides the eval's OWN DRAIN as well
      // (phase-E review rejection round 2: the signal used to be
      // consulted only by settlement drains, but a suspended eval's
      // continuation can be resumed by a SYNCHRONOUS host-callback
      // settlement — `checkpoint.answer` in a later eval — and that
      // execution runs inside the answering eval's own drain, where the
      // old signal was blind: the runaway continuation burned the eval
      // deadline instead of being broken by the interrupt). The eval's
      // own CODE still never consults the signal — an unrelated eval's
      // code is never broken by it (the phase-E review rejection's
      // targeting discipline).
      drainInterruptHandler: this.evalBreakHandler(),
      // The per-job continuation-lease plumbing: the drain loop mirrors
      // the guest lease per job, and the handler above fires only while
      // the mirror holds an armed token (the executing job IS the armed
      // eval's continuation segment).
      jobLease: this.jobLease,
      rejectionBridge: true,
    });
    return result;
  }

  /** Whether the workspace's guest library carries the 0.3.1+
   *  CONTINUATION-LEASE surface — the corrected lease ordering (the
   *  eval-break targeting seam). VERSION-GATED (phase-E review
   *  rejection round 7): the 0.3.0 copy reports 'supportsContinuationLease:
   *  true' but its lease-setting reaction still runs on the awaited
   *  VALUE's settlement — the carried sibling-reaction interrupt-
   *  targeting defect (a sibling 'q.then' registered after the target's
   *  await runs between the lease set and the continuation, consumes the
   *  armed signal, and the target runs later unprotected). Accepting the
   *  flag alone would re-arm the original defect on a restored 0.3.0
   *  snapshot; the version gate refuses it: a restored 0.3.0 workspace is
   *  served as-is, its awaits are left UNINSTRUMENTED (native semantics),
   *  and the eval-break interrupt degrades to the honest refusal. 0.3.1
   *  is the first copy with the corrected ordering (its wrapper reaction
   *  rides the wrapper promise itself, immediately before the await
   *  machinery's own — the lease is associated with the actual
   *  continuation job), so it passes the gate. A restored snapshot with
   *  the 0.1.0/0.2.0 library is refused by the flag itself (the 0.2.0
   *  log-only targeting is the rejected settled-call-ids identity).
   *  Cached per check: the library never changes within a broker's
   *  lifetime (restore keeps the snapshot's copy). */
  private continuationLeaseAvailable(): boolean {
    if (this.leaseCapabilityCached !== undefined) return this.leaseCapabilityCached;
    try {
      const surface = this.workspace.surface();
      this.leaseCapabilityCached =
        surface?.supportsContinuationLease === true &&
        guestVersionAtLeast(surface.version, '0.3.1');
    } catch {
      this.leaseCapabilityCached = false;
    }
    return this.leaseCapabilityCached;
  }

  /** Whether the workspace's guest library carries the 0.3.1
   *  ITERABLE-LEASE surface (`__replAwaitIterable` — the for-await
   *  iterable wrap that preserves the iterable protocol while setting
   *  the continuation lease per iteration). The instrumenter's
   *  for-await sites are gated on this: a restored snapshot carrying
   *  the 0.3.0 library (whose for-await wrap returned a promise and
   *  broke every `for await` loop — phase-E review rejection round 6)
   *  is served as-is, its for-await sites are left UNWRAPPED, and the
   *  loops run natively (no mid-loop eval-break targeting — the honest
   *  degradation). Cached per check like `continuationLeaseAvailable`.
   */
  private iterableLeaseAvailable(): boolean {
    if (this.iterableLeaseCapabilityCached !== undefined) return this.iterableLeaseCapabilityCached;
    try {
      const surface = this.workspace.surface();
      this.iterableLeaseCapabilityCached = surface?.supportsIterableLease === true;
    } catch {
      this.iterableLeaseCapabilityCached = false;
    }
    return this.iterableLeaseCapabilityCached;
  }

  /** Compose the per-operation interrupt handlers with the per-eval
   *  wall-clock deadline: any handler returning true interrupts. The
   *  deadline is the last resort — a runaway operation is ALWAYS
   *  breakable (see `BrokerOptions.evalTimeoutMs`; `0`/`null` disables
   *  it). */
  private composedInterrupt(...handlers: Array<(() => boolean) | undefined>): () => boolean {
    const live = handlers.filter((handler): handler is () => boolean => handler !== undefined);
    const deadline = this.deadlineHandler();
    return () => {
      for (const handler of live) {
        if (handler()) return true;
      }
      return deadline !== undefined && deadline();
    };
  }

  /** The OUT-OF-BAND eval-break probe (phase-F review round 2; see
   *  `BrokerOptions.evalBreakChannel` and `eval-break-channel.ts`):
   *  consumes the channel's break flag for this workspace and breaks
   *  the executing eval when the flag was armed after the execution
   *  began (the arm-after-start rule — a stale flag never breaks a
   *  later eval; it is consumed-and-dropped on first observation).
   *  Composed into every execution: a fresh eval's own code (the
   *  `while (true)` case — the daemon's main thread is blocked, the
   *  worker armed the flag, and the quickjs interrupt handler breaks
   *  the eval mid-run) and the settlement drains (an interrupt lands
   *  promptly mid-wait). `undefined` when no channel is wired. */
  private evalBreakProbe(): (() => boolean) | undefined {
    const channel = this.evalBreakChannel;
    if (channel === undefined) return undefined;
    const projectDir = this.workspace.projectDir;
    return () => {
      if (channel.consumeBreak(projectDir, this.currentExecutionStartSeq)) {
        this.outOfBandBreakCount++;
        this.lastOutOfBandBreakAtMs = Date.now();
        return true;
      }
      return false;
    };
  }

  /** The interrupt tool's honest-outcome record: the moment an
   *  out-of-band break was CONSUMED by a running eval, consumed on
   *  read (one request → one report — a later interrupt can never
   *  inherit an earlier break's delivery record). Null when no
   *  out-of-band break was delivered since the last read. The daemon
   *  reads it AFTER `armEvalBreak` (the eval's chain hold releases
   *  before the interrupt's processing — the break already happened
   *  by then, which is exactly what the record reports). */
  consumeOutOfBandBreakReport(): number | null {
    const at = this.lastOutOfBandBreakAtMs;
    this.lastOutOfBandBreakAtMs = null;
    return at;
  }

  /** Render the tool-result shape: output lines (console events drained
   *  from the buffer, then the pump-drain error line when one occurred,
   *  then the eval's own error line when it threw), the previewed
   *  result, pending ids, checkpoints, completed ids. */
  private render(
    outcome: ReplEvalOutcome,
    completion: unknown,
    completed: string[],
    pumpDrainErrorLine?: string,
  ): ReplEvalResult {
    const lines: string[] = [];
    for (const event of this.consoleBuffer.splice(0)) {
      lines.push(this.renderConsoleEvent(event));
    }
    if (pumpDrainErrorLine !== undefined) lines.push(pumpDrainErrorLine);
    if (outcome.kind === 'error') {
      lines.push(errorLine(outcome.error));
    }
    // §7: the engine applies NO output caps to guest output — the lines
    // ship verbatim (the Python posture). `outputTruncated` is always
    // false (vestigial until the surface phase deletes the field).
    const result: ReplEvalResult = {
      output: lines,
      outputTruncated: false,
      pending: this.pendingIds(),
      checkpoints: this.checkpointSummaries(),
      completed,
    };
    if (outcome.kind === 'value' && completion !== undefined) {
      try {
        result.result = renderCompletionLine(completion);
      } finally {
        (completion as JSValueHandle).dispose();
      }
    }
    return result;
  }

  /** One console event → its guest-rendered line (non-log levels
   *  prefixed `warn:`/`error:`/…). */
  private renderConsoleEvent(event: { level: string; line: string }): string {
    const prefix = event.level === 'log' ? '' : `${event.level}: `;
    return `${prefix}${event.line}`;
  }

  /** The pending call ids, in registry order. */
  private pendingIds(): string[] {
    return this.workspace.surface()?.pending().map((entry) => entry.id) ?? [];
  }

  /** The raised-checkpoint summaries, previewed — the `status` seam's
   *  checkpoint surface (the same bounded form the eval/wait result's
   *  `checkpoints` field carries: questions previewed through the
   *  top-level string rule, never unbounded guest text). */
  checkpointSummaries(): CheckpointSummary[] {
    return [...this.checkpoints.values()].map((c) => ({
      id: c.callId,
      // The §4.3 double-JSON-quote fix: the question renders as PLAIN
      // head+tail metadata text (the retained 200-char metadata preview,
      // §7) — never a JSON-stringified quoted form.
      question: headTailDescription(c.question, 200),
    }));
  }

  // ── Options validation ────────────────────────────────────────────────

  /** Parse + validate the agent options bag (the exact surface is the
   *  module docs' table). Throws a `WorkflowError` for every invalid
   *  shape — the caller refuses the call with it. */
  private parseAgentOptions(optionsJson: string | null): ParsedAgentOptions {
    if (optionsJson === null) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(optionsJson);
    } catch (error) {
      throw new WorkflowError(`agent options are not valid JSON: ${(error as Error).message}`, CODE.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new WorkflowError('agent options must be an object', CODE.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const opts = raw as Record<string, unknown>;
    for (const key of Object.keys(opts)) {
      if (!AGENT_OPTION_KEYS.has(key)) {
        // §4.1: an unknown option key rejects synchronously, and the
        // error lists the valid keys (the enumerated teaching error).
        throw new WorkflowError(
          `agent options: unknown option "${key}" (valid options: ${AGENT_OPTION_KEYS_TEXT})`,
          CODE.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
    }
    const parsed: ParsedAgentOptions = {};
    if (opts.schema !== undefined) {
      if (typeof opts.schema !== 'object' || opts.schema === null || Array.isArray(opts.schema)) {
        throw new WorkflowError('agent options: "schema" must be a JSON Schema object', CODE.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
      parsed.schema = opts.schema as Record<string, unknown>;
    }
    if (opts.cwd !== undefined) {
      if (typeof opts.cwd !== 'string' || opts.cwd.length === 0 || !isAbsolute(opts.cwd)) {
        throw new WorkflowError('agent options: "cwd" must be an absolute path string', CODE.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
      parsed.cwd = opts.cwd;
    }
    if (opts.configOptions !== undefined) {
      parsed.configOptions = requireStringBoolRecord(opts.configOptions, 'configOptions');
    }
    if (opts.mode !== undefined) parsed.mode = requireString(opts.mode, 'mode');
    return parsed;
  }

  /** Parse + validate a steering payload's options bag (exactly
   *  `{ promptMeta }`). */
  private parseSteerOptions(options: unknown): Record<string, unknown> {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new WorkflowError('steer options must be an object', CODE.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const opts = options as Record<string, unknown>;
    for (const key of Object.keys(opts)) {
      if (!STEER_OPTION_KEYS.has(key)) {
        throw new WorkflowError(`steer options: unknown option "${key}"`, CODE.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
    }
    if (opts.promptMeta !== undefined) opts.promptMeta = requireRecord(opts.promptMeta, 'promptMeta');
    return opts;
  }

  // ── Misc ──────────────────────────────────────────────────────────────

  /** Serialize async broker operations (eval/pump/reconcile/dispose) —
   *  two overlapping tool calls must never interleave settlement
   *  bookkeeping or the eval's pump-before-eval ordering.
   *
   *  `deadline` (the client-presence drain's and the disposal's ABSOLUTE
   *  bound) races the CHAIN WAIT itself (phase-D review round 8: the
   *  chain acquisition used to be awaited with no deadline, so a
   *  YIELDFUL queued operation — a long `wait` op polling a pending
   *  call, anything async that never resolves — could delay the drain
   *  and the teardown indefinitely past their bounds, exactly the
   *  unbounded-wait family the outer bound exists to kill). When the
   *  deadline expires while queued, `fn` runs WITHOUT the chain: the
   *  chain is, by definition, stuck past the caller's absolute ceiling,
   *  and the caller's body is safe unlocked because it is first-wins
   *  (the store's first-completion authority) and generation-fenced
   *  against the stuck op's eventual landing — the same protections the
   *  drain's late-landing paths already rely on. A deadline already
   *  past at call time skips straight to the unlocked run. When the
   *  chain frees within the bound, `fn` runs INSIDE it exactly as
   *  before (subsequent ops queue behind it).
   *
   *  The enqueue is ATOMIC with a changed-chain re-check: the race
   *  resolves when the chain promise captured AT RACE TIME settles, but
   *  other microtasks run between that resolution and this continuation
   *  — an op enqueued in that window chains onto the just-released
   *  chain and REPLACES `this.opChain` (the no-deadline path enqueues
   *  synchronously, so it can land exactly there). Re-reading the
   *  mutable field after the await would enqueue behind the NEW chain
   *  with no deadline race on it (the review-rejected round-8 code did
   *  exactly this: a 20 ms drain took 307 ms behind an op queued as the
   *  prior chain released). So the post-race path re-checks the field
   *  and, when it changed, re-races the new chain against the REMAINING
   *  time — each loop pass only consumes remaining budget, so the total
   *  wait can never exceed the deadline plus timer slop no matter how
   *  many ops enqueue around a release; and the check-and-assign when
   *  the field is unchanged run in ONE synchronous block, so no op can
   *  interleave between them. */
  private async serialized<T>(fn: () => Promise<T>, deadline?: number): Promise<T> {
    if (deadline === undefined) {
      const run = this.opChain.then(
        () => this.runSerialized(fn),
        () => this.runSerialized(fn),
      );
      this.opChain = run.then(
        () => undefined,
        () => undefined,
      );
      return this.afterOp(run);
    }
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // The deadline is already past: run WITHOUT the chain — waiting
        // for it would exceed the absolute bound.
        return this.afterOp(this.runSerialized(fn));
      }
      const raced = this.opChain;
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<'bound'>((resolve) => {
        timer = setTimeout(() => resolve('bound'), remaining);
      });
      const winner = await Promise.race([
        raced.then(
          () => 'chain' as const,
          () => 'chain' as const,
        ),
        bound,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner === 'bound') {
        // The bound won the race: the chain is stuck past the deadline
        // — run WITHOUT it and return at the bound (the caller's body
        // is first-wins/generation-fenced, so the stuck op's eventual
        // landing cannot interleave into a double settlement).
        return this.afterOp(this.runSerialized(fn));
      }
      if (this.opChain === raced) {
        // The chain we raced is still the current one — enqueue onto it
        // atomically (the check and the replacement share one
        // synchronous block, so no operation can interleave between
        // them).
        const run = raced.then(
          () => this.runSerialized(fn),
          () => this.runSerialized(fn),
        );
        this.opChain = run.then(
          () => undefined,
          () => undefined,
        );
        return this.afterOp(run);
      }
      // The chain CHANGED while we awaited the race (an op enqueued in
      // the microtasks between the chain's release and this continuation
      // replaced it): re-race the new chain with the remaining time.
    }
  }

  /**
   * After a serialized operation settles: run the owed reset() teardown
   * (§4.5 — the guest's reset() tears the workspace down once the eval
   * that called it completed). OUTSIDE the chain slot: the disposal
   * acquires the chain itself, and the op's own promise has settled
   * (its result shipped) before the teardown starts. A failing op still
   * tears down (the eval completed with an error — the teardown is
   * owed all the same).
   */
  private async afterOp<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } finally {
      await this.resetIfDue();
    }
  }

  /**
   * The reset() teardown owed by a completed eval (`resetDue`, flipped
   * by the sweep or by `eval` for an in-call completion): dispose the
   * broker's children (bounded, generation-fenced), then the workspace
   * VM — the host-side effect the deleted `reset` action performed; the
   * daemon's next touch creates a fresh workspace. Idempotent: dispose
   * is first-wins and the flags are consumed once. `boundMs` is
   * forwarded to the disposal — the eval path passes an already-expired
   * bound so the disposal body runs WITHOUT the chain (the eval op
   * holds it); the post-op path uses the disposal's own default.
   */
  private async resetIfDue(boundMs?: number): Promise<void> {
    if (!this.resetDue || this.disposed) return;
    this.resetDue = false;
    this.resetRequested = false;
    this.resetOwningCompletions.clear();
    await this.dispose(boundMs);
    this.workspace.dispose();
  }

  /** One serialized operation with the sink's end-of-burst flush: the
   *  boundaries fired inside the op are written (debounced) before the
   *  op's promise resolves — a kill after the op returns loses nothing.
   *  The active-eval sweep runs first: a suspended eval's completion
   *  can only settle inside an operation's drain, so the operation
   *  boundaries are exactly the moments the tracking can advance. */
  private async runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    try {
      // Every serialized operation waits for the workspace's eval-break
      // slot ACK (phase-F review round 4): guest-executing operations
      // must not start before the relay worker knows the workspace's
      // key — an interrupt fired during the operation would 404 against
      // an unapplied mapping. The ack resolves once (milliseconds after
      // attach) and is a settled-promise microtask from then on; a dead
      // channel rejects it and the swallow degrades to the documented
      // per-eval deadline bound — never a hang.
      await this.evalBreakReady.catch(() => undefined);
      this.sweepActiveEvals();
      return await fn();
    } finally {
      this.sink?.flush();
    }
  }

  /**
   * Race the serialization chain against an ABSOLUTE deadline: acquire
   * the chain when it frees within the remaining budget, otherwise
   * report `{ acquired: false }` — WITHOUT running the body (a
   * VM-touching body must never execute while another operation is
   * mid-flight: the chain is held by the operation itself, and running
   * unlocked would re-enter the single-threaded engine). This is the
   * `wait` tool's chain-contention bound (phase-E review round 4's
   * carried defect: the wait enqueued onto the chain with no deadline,
   * so a bounded wait queued behind a long eval took the eval's whole
   * remaining run instead of returning at its bound). Unlike
   * `serialized(fn, deadline)` — which runs the body WITHOUT the chain
   * when the bound trips (the disconnect drain's choice, whose body is
   * settlement-safe) — the caller here treats a failed acquisition as
   * "the operation did not run": the wait reports still-running with
   * the last observation it actually made.
   */
  private async trySerialized<T>(
    fn: () => Promise<T>,
    deadline: number,
  ): Promise<{ acquired: boolean; value?: T }> {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // The deadline is already past: ONE IMMEDIATE acquisition
        // attempt (phase-E review round 5's carried defect: the wait
        // used to return unacquired right here, so a zero-timeout wait
        // could not perform even an immediately available state read —
        // an idle workspace reported "still running" and a pending
        // call's surface read as empty). The chain is acquirable
        // WITHOUT any wait when it is currently free: its settle
        // continuation is a microtask, which runs before a zero timer
        // (macrotask), so the race resolves 'chain' for a free chain
        // and 'bound' for a busy one — nothing was waited for either
        // way, the body just ran when the read was immediately
        // available. A busy chain loses to the timer: unacquired,
        // nothing ran (a VM-touching body must never execute while
        // another operation is mid-flight).
        const raced = this.opChain;
        let timer: NodeJS.Timeout | undefined;
        const zero = new Promise<'bound'>((resolve) => {
          timer = setTimeout(() => resolve('bound'), 0);
        });
        const winner = await Promise.race([
          raced.then(
            () => 'chain' as const,
            () => 'chain' as const,
          ),
          zero,
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (winner === 'bound') {
          // The chain is busy: do NOT run the body (it would touch the
          // VM while the stuck operation is mid-flight).
          return { acquired: false };
        }
        if (this.opChain === raced) {
          // The chain we raced is still the current one — enqueue onto it
          // atomically (the check and the replacement share one
          // synchronous block, so no operation can interleave between
          // them).
          const run = raced.then(
            () => this.runSerialized(fn),
            () => this.runSerialized(fn),
          );
          this.opChain = run.then(
            () => undefined,
            () => undefined,
          );
          return { acquired: true, value: await run };
        }
        // The chain CHANGED while we awaited the race: re-race the new
        // chain (still zero budget — the same one-attempt semantics).
        continue;
      }
      const raced = this.opChain;
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<'bound'>((resolve) => {
        timer = setTimeout(() => resolve('bound'), remaining);
      });
      const winner = await Promise.race([
        raced.then(
          () => 'chain' as const,
          () => 'chain' as const,
        ),
        bound,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner === 'bound') {
        // The chain is stuck past the deadline: do NOT run the body (it
        // would touch the VM while the stuck operation is mid-flight).
        return { acquired: false };
      }
      if (this.opChain === raced) {
        // The chain we raced is still the current one — enqueue onto it
        // atomically (the check and the replacement share one
        // synchronous block, so no operation can interleave between
        // them).
        const run = raced.then(
          () => this.runSerialized(fn),
          () => this.runSerialized(fn),
        );
        this.opChain = run.then(
          () => undefined,
          () => undefined,
        );
        return { acquired: true, value: await run };
      }
      // The chain CHANGED while we awaited the race (an op enqueued in
      // the microtasks between the chain's release and this continuation
      // replaced it): re-race the new chain with the remaining time.
    }
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error(`Broker for ${this.workspace.projectDir}: operation on a disposed broker`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Module helpers
// ────────────────────────────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

/** Await a batch of best-effort teardown promises (cancels, releases)
 *  ONLY until the drain deadline — the doc's outer drain bound (phase-D
 *  review round 3: a hung cancel/release used to block disconnect/
 *  shutdown indefinitely past the session-eviction TTL). After the
 *  deadline the drain returns without waiting; every promise in the batch
 *  already carries its own catch handler, so the fire-and-forget tail can
 *  never become an unhandled rejection. The bound timer is CLEARED when
 *  the batch wins the race — a satisfied drain must not leave a timer
 *  pending for the whole remaining bound (it would keep the process
 *  alive and fire needlessly later). */
async function boundedAll(promises: Promise<unknown>[], deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, remaining);
  });
  await Promise.race([Promise.allSettled(promises), bound]);
  if (timer !== undefined) clearTimeout(timer);
}

/** Await ONE teardown promise (the owned runner's dispose) only until
 *  `deadline` — the same absolute-bound discipline as `boundedAll`. A
 *  rejection still propagates when the promise wins the race; a deadline
 *  that wins returns `undefined` and the promise keeps running in the
 *  background (callers must attach their own tail catch — the broker's
 *  dispose does — so the abandoned tail can never become an unhandled
 *  rejection). The bound timer is CLEARED when the promise wins, so a
 *  satisfied teardown must not leave a timer pending for the whole
 *  remaining bound. */
async function boundedOne<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remaining);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Timer sleep (the drain's yield and bounded-wait primitive). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The guest-library version gate (phase-E review rejection round 7):
 *  parse a surface version string ('0.3.1') into its numeric triple and
 *  compare it against a minimum. Returns false for unparseable or
 *  missing versions — an unknown library version can never pass a
 *  capability gate. The gate exists for the corrected continuation-lease
 *  ordering (0.3.1 is the first copy whose lease-setting reaction rides
 *  the wrapper promise itself; see `continuationLeaseAvailable`). */
function guestVersionAtLeast(version: string, atLeast: string): boolean {
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const minimum = /^(\d+)\.(\d+)\.(\d+)/.exec(atLeast);
  if (parsed === null || minimum === null) return false;
  for (let i = 1; i <= 3; i++) {
    const a = Number(parsed[i]);
    const b = Number(minimum[i]);
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/** Head+tail elision at `max` chars (the manifest task cap). */
function headTail(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(0, max - 1);
  const half = Math.floor(keep / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - (keep - half))}`;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new WorkflowError(`agent options: "${what}" must be a string`, CODE.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  return value;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError(`agent options: "${what}" must be an object`, CODE.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  return value as Record<string, unknown>;
}

function requireStringBoolRecord(value: unknown, what: string): Record<string, string | boolean> {
  const record = requireRecord(value, what);
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string' && typeof entry !== 'boolean') {
      throw new WorkflowError(`agent options: "${what}.${key}" must be a string or boolean`, CODE.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
  }
  return record as Record<string, string | boolean>;
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new WorkflowError(`agent options: "${what}" must be an array of strings`, CODE.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  return value;
}

/** Normalize any thrown value into the guest rejection shape: `{ name,
 *  message, code?, recoverable? }` (the guest's `toError` turns it into
 *  an Error carrying code/recoverable). WorkflowErrors keep their code
 *  and recoverable flag; plain errors are recoverable by default; a
 *  plain rejection-shaped object (the broker's own refusals) passes
 *  through with its name/recoverable. */
function toRejectionValue(error: unknown): { name: string; message: string; code?: string; recoverable?: boolean; replBackend?: string } {
  // The §4.6 backend stamp passes THROUGH the conversion (an error
  // pre-stamped with `replBackend` — an admission refusal whose segment
  // resolved — keeps it on the rejection value the guest sees).
  const backend = (error as { replBackend?: unknown } | null | undefined)?.replBackend;
  const stamped = (value: { name: string; message: string; code?: string; recoverable?: boolean; replBackend?: string }): typeof value => {
    if (typeof backend === 'string') value.replBackend = backend;
    return value;
  };
  if (isWorkflowError(error)) {
    return stamped({
      name: 'WorkflowError',
      message: error.message,
      code: error.code,
      recoverable: error.recoverable,
    });
  }
  if (error instanceof Error) {
    return stamped({ name: error.name || 'Error', message: error.message });
  }
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    const value = error as { name?: unknown; message: string; code?: unknown; recoverable?: unknown };
    return stamped({
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: value.message,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.recoverable === 'boolean' ? { recoverable: value.recoverable } : {}),
    });
  }
  return { name: 'Error', message: String(error) };
}

/** Is this error the session-cancel signal (the prompt's stop reason or
 *  the released-session error after a cancel)? */
function isCancellation(error: unknown): boolean {
  if (isWorkflowError(error)) return error.code === CODE.AGENT_CANCELLED || error.code === CODE.WORKFLOW_ABORTED;
  return false;
}

/** The §4.6 uncaught-eval-error rendering: the error name and message,
 *  the guest stack's top frames with LINE NUMBERS in the submitted code
 *  (the eval's filename — the broker evals under the VM's default
 *  `'<repl>'`), and — when the error came from a subagent call — the
 *  call id and the resolved backend (the guest library stamps
 *  `replCallId`, the broker stamps `replBackend` — see
 *  `EvalErrorInfo`). */
function errorLine(info: EvalErrorInfo): string {
  let line = `${info.name}: ${info.message}`;
  if (info.replCallId !== undefined) {
    line += ` (call ${info.replCallId}${info.replBackend !== undefined ? ` on backend ${info.replBackend}` : ''})`;
  }
  const frames = replStackFrames(info.stack);
  if (frames.length > 0) line += '\n' + frames.join('\n');
  return line;
}

/** The guest stack's frames with line numbers in the submitted code:
 *  quickjs stacks are newest-first, so the FIRST matching frames are the
 *  top of the guest stack; frames from the guest library (filename
 *  `'<guest-library>'`) and the host are skipped. At most 8 frames — the
 *  render is attribution, not a transcript (the §4.6 rule: name, message,
 *  top frames with line numbers). */
function replStackFrames(stack: string | undefined): string[] {
  if (stack === undefined) return [];
  const frames: string[] = [];
  for (const raw of stack.split('\n')) {
    if (frames.length >= 8) break;
    const match = /^\s*at\s+(?:(.+?)\s+\()?<repl>:(\d+):(\d+)\)?\s*$/.exec(raw);
    if (match === null) continue;
    frames.push(
      match[1] !== undefined
        ? `    at ${match[1]} (<repl>:${match[2]}:${match[3]})`
        : `    at <repl>:${match[2]}:${match[3]}`,
    );
  }
  return frames;
}

/** The backend segment of a model spec (the §4.1 grammar: `"backend/
 *  model"` — the first `/`-delimited segment, ASCII-lowercased; a bare
 *  `"backend"` spec is the whole string). */
function backendSegment(modelSpec: string): string {
  const slash = modelSpec.indexOf('/');
  return (slash >= 0 ? modelSpec.slice(0, slash) : modelSpec).toLowerCase();
}

/** Recover a queued steer's payload from its store record (the verbatim
 *  `{ prompt, options }` bag recorded at dispatch — the queue rebuild's
 *  crash-durable source). Returns null for a record whose payload is
 *  malformed (a corrupt log line must not resurrect a bogus delivery). */
function parseSteerPayload(
  optionsJson: string | null,
): { prompt: string; promptMeta?: Record<string, unknown> } | null {
  if (optionsJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const payload = parsed as { prompt?: unknown; options?: unknown };
  if (typeof payload.prompt !== 'string') return null;
  const result: { prompt: string; promptMeta?: Record<string, unknown> } = { prompt: payload.prompt };
  if (payload.options !== undefined && payload.options !== null && typeof payload.options === 'object') {
    const options = payload.options as Record<string, unknown>;
    const promptMeta = options.promptMeta;
    if (promptMeta !== undefined && typeof promptMeta === 'object' && promptMeta !== null) {
      result.promptMeta = promptMeta as Record<string, unknown>;
    }
  }
  return result;
}
