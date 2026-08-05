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
 *   Sessions stay open for the workspace's lifetime — the live-handle
 *   contract (followUp/steer/cancel on a settled call) requires it; the
 *   daemon layer's client-presence drain policy lands in a later phase.
 *   They are opened with `keepSession: true`, so the ACP session persists
 *   on the backend for the restore path's lazy re-attach; the moment a
 *   session opens, its backend session id is recorded in the call store
 *   (`recordAttached` — BEFORE the prompt is sent), so a crash with a
 *   turn in flight leaves a restore able to re-attach the session
 *   instead of re-issuing a call whose turn may still be running
 *   (duplicated work).
 * - **Six concurrent subagents per workspace** (the doc-settled cap).
 *   The cap counts live work: unsettled agent calls plus sessions
 *   running a follow-up turn (a queued-steer delivery turn or a
 *   startedNewTurn prompt on a settled handle — a subagent is working
 *   even on a follow-up turn). The cap is ABSOLUTE for turn starts, not
 *   just dispatches: a dispatch over the cap is refused at dispatch
 *   time — recorded in the call store (dispatched + rejected, so a
 *   restore never re-issues it) and the guest call rejects with a
 *   recoverable error — and a followUp/steer on an idle session whose
 *   start would exceed the cap is queued for the next free slot with
 *   the honest `queued` outcome (never a seventh concurrent turn, never
 *   a hard error). Queued delivery turns likewise start only while a
 *   slot is free; the kick (`kickQueuedDeliveries`) runs whenever a
 *   slot frees. `maxConcurrentAgents` is configurable (server
 *   configuration, invisible to the guest).
 * - **Steering resolves with what actually happened** (the doc's
 *   "nothing is hidden, nothing hard-errors"): followUp/steer settle
 *   with the acp-agents steering-outcome vocabulary where the backend
 *   advertises `_session/steering`, with the broker's honest `queued`
 *   marker where it does not (see the steering mechanism table below).
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
 * - **The eval tool-result shape** (`Broker.eval`): output lines
 *   (console events rendered through the previewer and capped at 256
 *   lines / 10 KB), the previewed completion value when the eval
 *   resolved, the pending call ids when it suspended (no fabricated
 *   value), the raised checkpoints (previewed questions), and the call
 *   ids this operation settled. Eval errors render as error-level lines
 *   in `output`. Every completion value crossing into the tool result is
 *   rendered trap-free (transfer lesson 2): the result line is previewed
 *   from the live completion handle through the previewer's own
 *   own-descriptor machinery, output lines through `renderRef`, and
 *   checkpoint questions through the top-level string rule — no guest
 *   getter is ever executed while rendering.
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
 * - **Checkpoints** (transfer lesson 4): `checkpoint(question)` parks a
 *   promise and records the dispatch in the call store; the question
 *   appears previewed in the tool result's `checkpoints` list;
 *   `checkpoint.answer(id, value)` in a later eval records the answer
 *   and settles the parked promise within that eval — root-mediated by
 *   construction, first-wins, and never delivered to anything but the
 *   matching pending checkpoint.
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
 *    request). On success the call's completion is the loaded session's
 *    founding turn, observed through `awaitCurrentTurn` — a REAL seam on
 *    the acp-agents adapter (phase-D review: the seam used to be absent
 *    from `InteractiveSession`, so every built-in backend loaded,
 *    released, and re-issued). Its protocol-bounded semantics: the
 *    `session/load` contract (the agent replays the entire persisted
 *    conversation and only then resolves the load) makes the founding
 *    turn's completion observable exactly when the replayed transcript's
 *    trailing content event is an assistant message — a turn that ended
 *    while the daemon was down has its final message in the replay, and
 *    the seam resolves with it (`stopReason` synthesized as `end_turn`;
 *    the protocol's replay carries none). When the transcript shows the
 *    founding turn still IN FLIGHT at the backend, the protocol exposes
 *    no completion signal for a turn this client did not start, so the
 *    seam rejects (a host-side error naming the condition) and the
 *    broker degrades to re-issue — the loaded session is released
 *    best-effort and the call re-dispatched under the same id, surfaced
 *    guest-visibly; a re-attached call can never hang unobserved. The
 *    same degradation covers a transcript with no user message (the
 *    recorded session never received its prompt) and a load failure
 *    (capability absent, session deleted, wire failure). A third-party
 *    `BrokerSession` adapter WITHOUT the seam still re-attaches the
 *    session, then degrades to re-issue the same way. The outcome is
 *    delivered through the SAME record → settle → consume pump as a
 *    live call — exactly once, first-wins on both sides. A re-attached
 *    call holds a concurrency token until it settles, like any other
 *    live call.
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
 * session:
 *
 * | Case | Mechanism | Outcome the handle resolves with |
 * |---|---|---|
 * | backend advertises `_session/steering`, turn in flight | `session.steer(content)` — live injection | the backend's verbatim outcome: `injected` \| `startedNewTurn` \| `failed` |
 * | backend advertises `_session/steering`, session idle | `session.prompt(content)` — a new turn (there is nothing to inject into) | `startedNewTurn` |
 * | backend does NOT advertise steering, turn in flight | content enqueued for next-turn delivery | `queued` (immediately — accepted for next-turn delivery; if the call is later cancelled the queue is dropped, and a delivery-turn failure surfaces as a warn-level line in the next tool result — both documented) |
 * | backend does NOT advertise steering, session idle | `session.prompt(content)` — a new turn | `startedNewTurn` |
 * | ANY backend, session idle, but the workspace cap is exhausted | content enqueued for the next free slot (the same durable queue) | `queued` (a follow-up turn IS the subagent working — the six-agent ceiling is absolute; the steer starts the moment a slot frees) |
 * | any backend/wire failure on the steering path | — | `failed` (never a hard rejection) |
 * | the founding call is still OPENING (its session does not exist yet —
 *   a steer in the same eval as the dispatch) | content queued for the
 *   call's next-turn boundary | `queued` |
 * | no live session for the founding call at all (never opened, or lost) | — | `failed` (nothing was steered) |
 * | `cancel()` with a turn in flight | ACP `session/cancel` | `cancelled` (the cancelled call itself rejects with the recoverable `CancelledError`) |
 * | `cancel()` with the session idle | no-op — the agent is already stopped | `idle` |
 * | `cancel()` while the call is still opening | no-op — nothing was running to cancel (the call continues) | `failed` |
 *
 * The outcome surface therefore mirrors acp-agents' `SteeringOutcome`
 * values (`injected` / `startedNewTurn` / `failed`) with one honest
 * addition (`queued`) for the no-extension enqueue case, plus the
 * cancel vocabulary (`cancelled` / `idle`) — the orchestrator can always
 * tell urgency delivery (injected) from next-turn delivery (queued /
 * startedNewTurn), which is the doc's stated requirement.
 *
 * ## The guest options surface (spec-owed decision)
 *
 * `agent(modelSpec, task, opts)` accepts EXACTLY this option bag (any
 * other key rejects the call with `recoverable: false` — an unknown
 * option is a guest bug, never silently ignored):
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
 *   boolean, applied in sorted option-id order by the runner).
 * - `mode`, `tier`, `label`, `baseInstructions`, `developerInstructions`,
 *   `toolNames`, `disallowedToolNames`, `meta`, `promptMeta`,
 *   `maxSchemaRetries` — the runner's own RunOptions passthroughs
 *   (meta is session-scoped, promptMeta is turn-scoped).
 *
 * Steering payloads (`followUp`/`steer` options) accept exactly
 * `{ promptMeta }`.
 */

import type { JSValueHandle } from 'quickjs-wasi';
import {
  AcpAgentRunner,
  parseFinalJson,
  resolveStructuredOutput,
  type StructuredSession,
} from '@automatalabs/acp-agents';
import { isWorkflowError, WorkflowError, WorkflowErrorCode } from '@automatalabs/shared-types';
import { isAbsolute } from 'node:path';

import type { GuestBridgeHandlers, GuestCall, GuestSurfaceEntry } from './bridge.js';
import { headTailDescription, renderCompletionLine, stringDescription } from './preview.js';
import { applyOutputCaps } from './caps.js';
import { InMemoryCallStore, type CallOutcome, type CallRecord, type CallStore } from './store.js';
import { DrainJobError, type ReplEvalOptions, type ReplEvalOutcome } from './vm.js';
import { Workspace } from './workspace.js';
import type { EvalErrorInfo } from './errors.js';

// ────────────────────────────────────────────────────────────────────────
// Public types (all self-contained — the published declaration graph must
// stay free of acp-agents / quickjs-wasi types, per the package's
// consumer-fixture discipline)
// ────────────────────────────────────────────────────────────────────────

/** The outcome surface steering operations settle with (see module docs). */
export type SteeringOutcomeValue = 'injected' | 'startedNewTurn' | 'queued' | 'cancelled' | 'idle' | 'failed';

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
   * (`InteractiveSession.awaitCurrentTurn`): resolves with the founding
   * turn when the `session/load` replay's trailing content event is an
   * assistant message (the turn observably completed while the daemon
   * was down — its final message is in the replay; `stopReason` is
   * synthesized `end_turn`, the protocol's replay carries none), and
   * REJECTS with a host-side error when the outcome is unobservable
   * (the founding turn is still in flight at the backend — the protocol
   * has no turn-end signal for a turn this client did not start — or
   * the transcript shows no user message at all); the broker degrades
   * to re-issue either way, surfaced guest-visibly, so a re-attached
   * call can never hang unobserved. OPTIONAL for third-party
   * `BrokerSession` adapters: an adapter without the seam still
   * re-attaches the session, then degrades to re-issue the same way.
   */
  awaitCurrentTurn?(): Promise<BrokerTurn>;
}

/** The runner seam the broker drives (structural subset of
 *  `AcpAgentRunner` — tests inject fakes). */
export interface BrokerRunner {
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

/** The eval tool-result shape (the roadmap doc's `{ output, result?,
 *  pending, checkpoints, completed }`). */
export interface ReplEvalResult {
  /** Rendered console lines for this operation (error-level lines
   *  included), capped at 256 lines / 10 KB. */
  output: string[];
  /** True when output lines were dropped by the caps (the dropped
   *  content stays reachable through the `$N` refs the kept lines
   *  carry — the cap costs reads, never data). */
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
  /** `opening` — session being opened; `running` — initial turn in
   *  flight; `delivering` — a queued-steer turn in flight; `idle` —
   *  call settled, no turn running. */
  state: 'opening' | 'running' | 'delivering' | 'idle';
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
   *  running a follow-up turn (a queued-steer delivery or a
   *  startedNewTurn prompt on a settled handle). The cap gates turn
   *  starts as well as dispatches: an idle-session follow-up that would
   *  exceed it queues with the honest `queued` outcome. Validated as an
   *  integer in
   *  `[1, DEFAULT_MAX_CONCURRENT_AGENTS]`: invalid values (NaN,
   *  fractional, < 1) throw at attach time; values ABOVE the doc-settled
   *  ceiling are clamped to it (the ceiling is absolute — a
   *  misconfigured host can never open a seventh subagent). */
  maxConcurrentAgents?: number;
  /** Per-eval and per-settlement-drain interrupt handler (a runaway
   *  guest continuation stays bounded). Also the DEFAULT interrupt
   *  handler for evals: a direct eval that runs away is interrupted
   *  with this signal unless the caller passes a per-eval handler. */
  interruptHandler?: () => boolean;
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
  promise: Promise<{ outcome: 'resolve' | 'reject'; value: unknown }>;
  done: boolean;
}

/** The broker's per-session state. */
interface SessionEntry {
  session: BrokerSession;
  /** The founding call id (the session's steering address). */
  callId: string;
  modelSpec: string;
  task: string;
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
  /** Queued followUp/steer payloads (no-extension backends with a turn
   *  in flight, and cap-pressure queues on idle sessions), in order. */
  queue: Array<{ callId: string; prompt: string; promptMeta?: Record<string, unknown> }>;
}

/** A steer that arrived before its session existed (the founding call
 *  was still opening), delivered at the call's next-turn boundary. */
interface PendingSteer {
  callId: string;
  prompt: string;
  promptMeta?: Record<string, unknown>;
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

/** The validated guest options bag (see the module docs for the exact
 *  surface). */
interface ParsedAgentOptions {
  schema?: Record<string, unknown>;
  cwd?: string;
  configOptions?: Record<string, string | boolean>;
  mode?: string;
  meta?: Record<string, unknown>;
  promptMeta?: Record<string, unknown>;
  tier?: string;
  toolNames?: string[];
  disallowedToolNames?: string[];
  maxSchemaRetries?: number;
  label?: string;
  baseInstructions?: string;
  developerInstructions?: string;
}

/** The exact option keys the guest may pass (see module docs). */
const AGENT_OPTION_KEYS = new Set([
  'schema',
  'cwd',
  'configOptions',
  'mode',
  'meta',
  'promptMeta',
  'tier',
  'toolNames',
  'disallowedToolNames',
  'maxSchemaRetries',
  'label',
  'baseInstructions',
  'developerInstructions',
]);

/** The exact option keys a steering payload may carry. */
const STEER_OPTION_KEYS = new Set(['promptMeta']);

/** Default per-workspace concurrency cap (the doc-settled limit). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 6;

/** The guest library's reserved model-spec sentinel (`verify`/`judgePanel`
 *  route their spawned reviewers/graders through it — the DSL options have
 *  no per-call model, so the reviewers inherit "the run's default model").
 *  acp-agents treats an unknown bare spec as a LITERAL model selection, so
 *  the broker maps the sentinel to an omitted model — which routes to the
 *  runner's configured default backend (the guest-library contract:
 *  "host policy routes it to its configured default backend"). */
const GUEST_DEFAULT_MODEL_SENTINEL = 'default';

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
  private readonly sink: SnapshotSink | undefined;
  private readonly consoleBuffer: Array<{ level: string; refs: string[]; args: unknown[] }> = [];
  private readonly sessions = new Map<string, SessionEntry>();
  /** Steers that arrived before their session existed (the founding call
   *  was still opening) — merged into the session's queue at open. */
  private readonly pendingSteers = new Map<string, PendingSteer[]>();
  private readonly checkpoints = new Map<string, PendingCheckpoint>();
  /** Live GuestCalls by call id — the pump's settlement targets. */
  private readonly deferreds = new Map<string, GuestCall>();
  /** In-flight host tasks (agent calls and steering ops). */
  private readonly inFlight = new Map<string, InFlightTask>();
  /** Unsettled agent call ids — one concurrency token each. */
  private readonly agentSlots = new Set<string>();
  /** Sessions running a follow-up turn (a queued-steer delivery turn or
   *  a startedNewTurn prompt on a settled handle) — one concurrency
   *  token each (a subagent is working even on a follow-up turn). */
  private readonly deliverySlots = new Set<string>();
  /** Call ids settled synchronously at dispatch (refusals) since the
   *  last eval result — reported in that eval's `completed`. */
  private readonly syncSettled: string[] = [];
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

  /** The four guest-bridge handlers (see `GuestBridgeHandlers`). */
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
        this.consoleBuffer.push({ level: event.level, refs: event.refs, args: event.args });
      },
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
      // The state-changing boundary of the pump's settlement drain (the
      // sink's burst bookkeeping: the flush at the operation's end
      // coalesces this with the eval's own boundary into one write).
      if (pumped.settled.length > 0) this.sink?.boundary('settlement');
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
      const { outcome, completion } = this.runEval(code, options);
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
      // The settlement drain ran and changed VM state: the doc's
      // state-changing boundary (a pump that settled nothing drained
      // nothing and fires nothing).
      if (settled.length > 0) this.sink?.boundary('settlement');
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
          // The steer's wire call died with the process: its outcome is
          // unknowable, and re-issuing an injected steer would duplicate
          // the injection. The honest `failed`, durably recorded and
          // surfaced guest-visibly. (Queued-but-undelivered steers are
          // handled by the queue rebuild below, NOT here.)
          if (this.settleSteerLost(entry)) changedVm = true;
          report.failedLost.push(entry.id);
          continue;
        }
        if (entry.kind === 'agent') {
          // Agent call: the re-attach / re-issue arms. Returns whether a
          // guest entry was newly settled (a reconcile-time refusal
          // mutates the VM and must participate in the changed-VM drain
          // and its settlement snapshot — review regression: refusals
          // used to settle the guest without the boundary).
          if (await this.reconcileAgentCall(entry, record, report)) changedVm = true;
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
        // a kill lost the settlements). The DrainJobError still
        // propagates — the caller reports it like the pump does.
        let drainError: DrainJobError | undefined;
        try {
          this.drain();
        } catch (error) {
          if (error instanceof DrainJobError) drainError = error;
          else throw error;
        }
        this.sink?.boundary('settlement');
        if (drainError !== undefined) throw drainError;
      }
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
      if (completion === null || completion === undefined || completion.value !== 'queued') continue;
      if (record.deliveredAtMs !== null || record.droppedAtMs !== null) continue;
      if (record.sessionId === null) continue;
      if (this.isCancelledFoundingCall(record.sessionId)) continue;
      const sessionId = record.sessionId;
      const payload = parseSteerPayload(record.optionsJson);
      if (payload === null) continue;
      const entry = this.sessions.get(sessionId);
      if (entry !== undefined) {
        if (entry.queue.some((item) => item.callId === record.callId)) continue;
        entry.queue.push({ callId: record.callId, ...payload });
        reQueued.push(record.callId);
      } else {
        const pending = this.pendingSteers.get(sessionId) ?? [];
        if (pending.some((item) => item.callId === record.callId)) continue;
        pending.push({ callId: record.callId, ...payload });
        this.pendingSteers.set(sessionId, pending);
        reQueued.push(record.callId);
      }
    }
    return reQueued;
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
    let parsed: ParsedAgentOptions;
    try {
      parsed = this.parseAgentOptions(entry.optionsJson);
    } catch (error) {
      // A corrupt options bag (a hostile/foreign registry entry): the
      // same refusal a live dispatch would have produced — recorded,
      // settled, surfaced.
      const settled = this.refuseReconciled(entry, 'agent', error, 're-issue refused (invalid options)');
      report.failedLost.push(entry.id);
      return settled;
    }
    const sessionId = record?.sessionId ?? null;
    if (sessionId === null) {
      // The founding session never opened (or its record predates the
      // attachment log): there is nothing at the backend to re-attach.
      this.reissueCall(entry, parsed, 'no resumable backend session was recorded', report);
      return false;
    }
    let loaded: BrokerSession | undefined;
    try {
      const session = await this.runner.loadSession({
        sessionId,
        model: entry.modelSpec === GUEST_DEFAULT_MODEL_SENTINEL ? undefined : entry.modelSpec ?? undefined,
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        configOptions: parsed.configOptions,
        mode: parsed.mode,
        meta: parsed.meta,
        tier: parsed.tier,
        toolNames: parsed.toolNames,
        disallowedToolNames: parsed.disallowedToolNames,
        label: parsed.label ?? `repl:${entry.id}`,
        runId: entry.id,
        baseInstructions: parsed.baseInstructions,
        developerInstructions: parsed.developerInstructions,
        keepSession: true,
        retainSessionLog: true,
      });
      loaded = session;
      const awaitTurn = session.awaitCurrentTurn;
      if (awaitTurn === undefined) {
        // A THIRD-PARTY BrokerSession adapter without the seam (the real
        // acp-agents adapter has it): the loaded session's founding-turn
        // completion is unobservable to this host. Release the loaded
        // session (best-effort) and degrade to re-issue through the same
        // honest gate — surfaced guest-visibly.
        await Promise.resolve(session.release()).catch(() => undefined);
        this.reissueCall(
          entry,
          parsed,
          'backend session loaded but its turn completion is not observable (awaitCurrentTurn seam absent) — re-issued',
          report,
        );
        return false;
      }
      // The seam (REAL on acp-agents' InteractiveSession): resolves with
      // the founding turn when the session/load replay makes its
      // completion observable (a turn that ended while the daemon was
      // down — its final message is in the replay), rejects when it is
      // not (the turn is still in flight at the backend and the protocol
      // exposes no completion signal for a turn this client did not
      // start, or the transcript shows no user message). Either way the
      // call can never hang unobserved.
      const turn = await awaitTurn.call(session);
      this.registerReattached(entry, parsed, session, turn);
      report.reattached.push(entry.id);
      return false;
    } catch (error) {
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

  /** Register a successfully re-attached session and arm the call's
   *  completion on the loaded session's founding turn (already observed
   *  by the seam). The call holds a concurrency token until the pump
   *  delivers it, exactly like a live call. */
  private registerReattached(
    entry: GuestSurfaceEntry,
    parsed: ParsedAgentOptions,
    session: BrokerSession,
    turn: BrokerTurn,
  ): void {
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
      queue: this.pendingSteers.get(entry.id) ?? [],
    };
    this.pendingSteers.delete(entry.id);
    this.sessions.set(entry.id, sessionEntry);
    this.agentSlots.add(entry.id);
    this.warnLine('info', `call ${entry.id}: re-attached to backend session ${session.sessionId}`);
    const taskPromise = this.runReattachedTask(entry.id, sessionEntry, parsed, turn);
    this.trackInFlight(entry.id, 'agent', taskPromise);
  }

  /** The re-attached call's task: shape the seam-observed founding turn
   *  (schema ladder or the empty-output gate) — delivered by the same
   *  record → settle → consume pump as a live call. The turn itself was
   *  already observed during reconcile; only the result shaping remains. */
  private runReattachedTask(
    callId: string,
    entry: SessionEntry,
    parsed: ParsedAgentOptions,
    turn: BrokerTurn,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    return (async () => {
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

  /** Re-issue a lost call under the SAME call id: the store records the
   *  reissue (counter bumped), a fresh session opens through the
   *  ordinary dispatch path, and the outcome settles the existing guest
   *  promise via the reconciliation surface. A store-unknown entry
   *  (foreign snapshot / wiped store) is adopted first so the replay
   *  ledger stays complete. Re-issues respect the concurrency cap: an
   *  over-cap re-issue is refused with the recoverable
   *  `ConcurrencyLimitError`, recorded and settled exactly like a
   *  dispatch-time refusal. Surfaces the reason guest-visibly. Returns
   *  whether a guest entry was newly settled (the over-cap refusal
   *  settles during reconcile and must participate in the changed-VM
   *  drain and its settlement boundary). */
  private reissueCall(
    entry: GuestSurfaceEntry,
    parsed: ParsedAgentOptions,
    reason: string,
    report: ReconcileReport,
  ): boolean {
    if (this.callStore.lookup(entry.id) === undefined) this.adoptEntry(entry, 'agent');
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      const settled = this.refuseReconciled(entry, 'agent', {
        name: 'ConcurrencyLimitError',
        message:
          `concurrency limit reached: ${this.maxConcurrentAgents} concurrent subagents per workspace ` +
          `(re-issue of call ${entry.id} refused)`,
        recoverable: true,
      }, `re-issue refused: concurrency limit reached (${this.maxConcurrentAgents} concurrent subagents per workspace; ${reason})`);
      report.failedLost.push(entry.id);
      return settled;
    }
    this.callStore.recordReissued(entry.id, now());
    this.agentSlots.add(entry.id);
    this.warnLine('warn', `call ${entry.id}: ${reason} — re-issued`);
    const taskPromise = this.runAgentTask(entry.id, entry.modelSpec ?? '', entry.detail ?? '', parsed);
    this.trackInFlight(entry.id, 'agent', taskPromise);
    report.reissued.push(entry.id);
    return false;
  }

  /** A reconcile-time dispatch refusal (invalid registry options, or the
   *  concurrency cap): record dispatched-rejected FIRST (a refused call
   *  is never re-issued again), settle, and surface the reason. Returns
   *  whether the guest entry was newly settled (a refusal mutates the
   *  VM and its caller must propagate the change into the changed-VM
   *  drain and its settlement boundary). */
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
   *  + optionsJson, so the replay ledger stays complete (completions,
   *  re-issues and attachment records can all be written against it). */
  private adoptEntry(entry: GuestSurfaceEntry, kind: 'agent' | 'checkpoint' | 'steer'): void {
    this.callStore.recordDispatched({
      callId: entry.id,
      kind,
      detail: entry.detail ?? '',
      optionsJson: entry.optionsJson,
      dispatchedAtMs: now(),
      reissues: 0,
      completion: null,
      sessionId: kind === 'steer' ? entry.sessionId : null,
      deliveredAtMs: null,
      droppedAtMs: null,
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
    this.consoleBuffer.push({ level, refs: [], args: [message] });
  }

  /**
   * Cancel one subagent call by its founding call id — the `interrupt`
   * tool's engine-side path (the guest handle's `cancel()` funnels
   * through the same session cancel; it additionally settles the guest
   * steer call). A turn in flight is cancelled (the call then rejects
   * with the recoverable `CancelledError` at the next pump); an idle
   * session is a no-op.
   */
  async cancelCall(callId: string): Promise<void> {
    return this.serialized(async () => {
      this.assertAlive();
      const entry = this.sessions.get(callId);
      if (entry === undefined || !entry.busy) return;
      await this.cancelSession(entry);
    });
  }

  /** Every pending guest call (the registry manifest) — the `status`
   *  seam. */
  pendingCalls(): GuestSurfaceEntry[] {
    this.assertAlive();
    return this.workspace.surface()?.pending() ?? [];
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

  /** Every live subagent session — the `status` seam. */
  liveAgents(): LiveAgentInfo[] {
    return [...this.sessions.values()].map((entry) => ({
      callId: entry.callId,
      modelSpec: entry.modelSpec,
      task: entry.task,
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
  }

  /** The call store (read access for diagnostics and the crash-window
   *  tests). */
  store(): CallStore {
    return this.callStore;
  }

  /**
   * Teardown: cancel in-flight turns (best-effort), release EVERY
   * session the broker opened (whether or not it owns the runner — a
   * host-injected runner keeps its own lifetime, but the broker's
   * dedicated ACP processes are still released; review regression: an
   * injected-runner disposal used to leak every session), then dispose
   * the runner when this broker owns it, and drop the broker's state.
   * The workspace (and its VM) is the caller's to dispose.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.serialized(async () => {
      const cancels: Promise<unknown>[] = [];
      const sessions = [...this.sessions.values()];
      for (const entry of sessions) {
        if (entry.busy) cancels.push(this.cancelSession(entry));
      }
      await Promise.allSettled(cancels);
      const releases: Promise<unknown>[] = sessions.map((entry) =>
        Promise.resolve(entry.session.release()).catch(() => undefined),
      );
      await Promise.allSettled(releases);
      this.sessions.clear();
      this.pendingSteers.clear();
      this.checkpoints.clear();
      this.deferreds.clear();
      this.inFlight.clear();
      this.agentSlots.clear();
      this.deliverySlots.clear();
      if (this.ownsRunner) await this.runner.dispose();
    });
  }

  // ── Guest bridge handlers ─────────────────────────────────────────────

  /**
   * `__host_agent`: validate the options, enforce the concurrency cap,
   * record the dispatch, and start the async task. Refusals (cap
   * breach, invalid options) settle the call SYNCHRONOUSLY — recorded
   * first (a refused call must never be re-issued after a restore) —
   * they never throw and never queue.
   */
  private onAgent(call: GuestCall, callId: string, modelSpec: string, task: string, optionsJson: string | null): void {
    let parsed: ParsedAgentOptions;
    try {
      parsed = this.parseAgentOptions(optionsJson);
    } catch (error) {
      this.refuse(call, callId, 'agent', task, optionsJson, error);
      return;
    }
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      // The doc deletes the budget vocabulary — `AGENT_LIMIT_EXCEEDED`/
      // `BUDGET_EXHAUSTED` have no counterpart here (the guest sees
      // `recoverable: true`, the one signal it needs: a resource refusal
      // is a recoverable condition, never a hard halt).
      this.refuse(call, callId, 'agent', task, optionsJson, {
        name: 'ConcurrencyLimitError',
        message:
          `concurrency limit reached: ${this.maxConcurrentAgents} concurrent subagents per ` +
          `workspace (call ${callId} was not dispatched)`,
        recoverable: true,
      });
      return;
    }
    this.recordDispatch(callId, 'agent', task, optionsJson);
    this.deferreds.set(callId, call);
    this.agentSlots.add(callId);
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
        pending.push({ callId, prompt, promptMeta });
        this.pendingSteers.set(sessionId, pending);
        this.settleSteerSync(call, callId, 'queued');
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
        // Queued for next-turn delivery — the honest immediate outcome.
        entry.queue.push({ callId, prompt, promptMeta });
        this.settleSteerSync(call, callId, 'queued');
      }
      return;
    }

    // The session is idle: the content starts a new turn right now —
    // UNLESS the workspace cap is exhausted (a follow-up turn IS the
    // subagent working; the six-agent ceiling is absolute). Cap pressure
    // queues the steer on the same durable queue with the honest
    // `queued` outcome; `kickQueuedDeliveries` starts it the moment a
    // slot frees (review regression: idle-handle follow-ups used to
    // start without checking the cap, so a maxConcurrentAgents=1
    // workspace could run two subagent turns concurrently).
    if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) {
      entry.queue.push({ callId, prompt, promptMeta });
      this.settleSteerSync(call, callId, 'queued');
      return;
    }
    const task = this.runPromptTask(callId, entry, prompt, promptMeta);
    this.deferreds.set(callId, call);
    this.trackInFlight(callId, 'steer', task);
  }

  /** `__host_console`: buffer the event; the next tool result renders it
   *  (one line per `$N` ref, non-log levels prefixed). */
  private onConsole(event: { level: string; refs: string[]; args: unknown[] }): void {
    this.consoleBuffer.push(event);
  }

  // ── Dispatch, tasks, settlement ───────────────────────────────────────

  /** Record a dispatch (idempotent per id — a re-issue of a known id
   *  keeps the original record). Steer records carry the FOUNDING session
   *  id (`sessionId` — the restore path's queue rebuild keys on it);
   *  agent/checkpoint records pass null. */
  private recordDispatch(
    callId: string,
    kind: 'agent' | 'checkpoint' | 'steer',
    detail: string,
    optionsJson: string | null,
    sessionId: string | null = null,
  ): void {
    this.callStore.recordDispatched({
      callId,
      kind,
      detail,
      optionsJson,
      dispatchedAtMs: now(),
      reissues: 0,
      completion: null,
      sessionId,
      deliveredAtMs: null,
      droppedAtMs: null,
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
    promise: Promise<{ outcome: 'resolve' | 'reject'; value: unknown }>,
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
   *  guest's reserved `"default"` model sentinel maps to an OMITTED model
   *  (acp-agents routes it to the configured default backend; a bare
   *  unknown spec would be treated as a literal model selection — review
   *  regression). The schema rides session creation (`openSession`
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
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    let openedSession: BrokerSession | undefined;
    try {
      const session = await this.runner.openSession({
        model: modelSpec === GUEST_DEFAULT_MODEL_SENTINEL ? undefined : modelSpec,
        schema: parsed.schema as never,
        cwd: parsed.cwd ?? this.workspace.projectDir,
        configOptions: parsed.configOptions,
        mode: parsed.mode,
        meta: parsed.meta,
        tier: parsed.tier,
        toolNames: parsed.toolNames,
        disallowedToolNames: parsed.disallowedToolNames,
        label: parsed.label ?? `repl:${callId}`,
        runId: callId,
        baseInstructions: parsed.baseInstructions,
        developerInstructions: parsed.developerInstructions,
        keepSession: true,
        retainSessionLog: true,
      });
      openedSession = session;
      const entry: SessionEntry = {
        session,
        callId,
        modelSpec,
        task,
        supportsSteering: session.capabilities?.supportsSteering === true,
        busy: false,
        delivering: false,
        callSettled: false,
        callCancelled: false,
        queue: this.pendingSteers.get(callId) ?? [],
      };
      this.pendingSteers.delete(callId);
      this.sessions.set(callId, entry);
      // Durable re-attach key (phase D): record the backend session id
      // the moment the session opens — BEFORE the prompt is sent — so a
      // crash with a turn in flight leaves a restore able to re-attach
      // this session (without the record, the restore would re-issue a
      // call whose turn may still be running at the backend — duplicated
      // work). A failing record is a host-side failure: the call rejects
      // (the session stays open and tracked, so dispose releases it).
      this.callStore.recordAttached(callId, session.sessionId, now());
      entry.busy = true;
      const turn = await session.prompt(task, { promptMeta: parsed.promptMeta });
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
        this.dropPendingSteers(callId, error);
      }
      return { outcome: 'reject', value: toRejectionValue(error) };
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
          refs: [],
          args: [`steer ${steer.callId} (on ${callId}): queued delivery dropped, but its drop could not be recorded: ${toRejectionValue(recordError).message}`],
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
    const promptMeta = parsed.promptMeta;
    const session = entry.session;
    const structuredSession: StructuredSession = {
      prompt: async (repromptText: string) => {
        const turn = await session.prompt(repromptText, { promptMeta });
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
      maxSchemaRetries: parsed.maxSchemaRetries,
      label: parsed.label ?? `repl:${entry.callId}`,
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
      return { outcome: 'resolve', value: outcome };
    } catch {
      // Nothing hard-errors: a wire failure resolves `failed`.
      return { outcome: 'resolve', value: 'failed' };
    }
  }

  /** The steering prompt for an idle session (extension and no-extension
   *  alike): the content starts a new turn. */
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
      return { outcome: 'resolve', value: 'startedNewTurn' };
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
    entry.callCancelled = true;
  }

  /** Drop a cancelled/failed call's queued steers (their promises already
   *  resolved `queued` at enqueue — the cancellation is the visible
   *  reason delivery never happens). Every dropped steer is recorded
   *  DURABLY (first-wins `dropped` marker) before the in-memory queue is
   *  cleared: a restore must never resurrect a dropped delivery. A
   *  failing record propagates (host-side failure) and the queue is left
   *  untouched for the next attempt. */
  private dropQueue(entry: SessionEntry): void {
    for (const item of entry.queue) {
      this.callStore.recordDelivery(item.callId, 'dropped', now());
    }
    entry.queue = [];
  }

  /** A delivery turn failed (a queued steer's delivery or a direct
   *  follow-up's prompt): surface a warn-level line in the next tool
   *  result (nothing is hidden — a queued steer's own promise already
   *  resolved `queued`; a direct steer resolves `failed`). */
  private warnDeliveryFailure(steerCallId: string, sessionCallId: string, error: unknown): void {
    const message = toRejectionValue(error).message;
    this.consoleBuffer.push({
      level: 'warn',
      refs: [],
      args: [`steer ${steerCallId} (on ${sessionCallId}): delivery failed: ${message}`],
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
    void this.runPromptTask(next.callId, entry, next.prompt, next.promptMeta);
  }

  /** Start as many queued delivery turns as the cap allows, sessions in
   *  open order (called whenever a concurrency slot frees — an agent
   *  call settling or a follow-up turn ending). This is the ONLY
   *  scheduler for queued payloads, including cap-pressure queues on
   *  idle sessions: without the global pass, a steer queued on an idle
   *  session would wait forever for its own session's turn to end. */
  private kickQueuedDeliveries(): void {
    for (;;) {
      if (this.agentSlots.size + this.deliverySlots.size >= this.maxConcurrentAgents) return;
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

  private async pumpUnlocked(): Promise<{ settled: string[]; drainError?: DrainJobError }> {
    this.assertAlive();
    const settled: string[] = [];
    for (;;) {
      const ready = [...this.inFlight.values()].filter((t) => t.done);
      if (ready.length === 0) break;
      for (const entry of ready) {
        const outcome = await entry.promise;
        try {
          this.deliver(entry.callId, outcome);
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
      }
    }
    if (settled.length === 0) return { settled };
    try {
      this.drain();
      return { settled };
    } catch (error) {
      if (error instanceof DrainJobError) {
        // The deliveries happened; the continuation drain failed. The
        // settled call ids must NOT be lost with the error (review
        // regression: an interrupted continuation used to erase every
        // id the pump had settled) — the caller reports them alongside
        // the drain-failure line.
        return { settled, drainError: error };
      }
      throw error;
    }
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
   *  continuation resumed by settlement cannot run away unguarded). */
  private drain(): void {
    this.workspace.drainJobs({ interruptHandler: this.interruptHandler });
  }

  // ── Eval + rendering ──────────────────────────────────────────────────

  /** Run the eval (with the rejection bridge armed) and read the
   *  completion. The broker-level interrupt handler is the DEFAULT for
   *  evals too: a direct eval that runs away must be bounded even when
   *  the caller supplies no per-eval handler (review regression: the
   *  configured handler used to apply only to settlement drains, so a
   *  runaway eval could hang the workspace indefinitely). A caller's
   *  per-eval handler still overrides it. */
  private runEval(code: string, options: ReplEvalOptions): { outcome: ReplEvalOutcome; completion?: unknown } {
    return this.workspace.evalWithCompletion(code, {
      ...options,
      interruptHandler: options.interruptHandler ?? this.interruptHandler,
      rejectionBridge: true,
    });
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
      lines.push(...this.renderConsoleEvent(event));
    }
    if (pumpDrainErrorLine !== undefined) lines.push(pumpDrainErrorLine);
    if (outcome.kind === 'error') {
      lines.push(errorLine(outcome.error));
    }
    const capped = applyOutputCaps(lines);
    const result: ReplEvalResult = {
      output: capped.lines,
      outputTruncated: capped.truncated,
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

  /** One console event → one preview line per `$N` ref (non-log levels
   *  prefixed `warn:`/`error:`/…), or the JSON-safe fallback when the
   *  event carries no refs (the broker's own warn lines). */
  private renderConsoleEvent(event: { level: string; refs: string[]; args: unknown[] }): string[] {
    const prefix = event.level === 'log' ? '' : `${event.level}: `;
    if (event.refs.length === 0) {
      return event.args.map((arg) => `${prefix}${renderFallback(arg)}`);
    }
    return event.refs.map((ref, index) => `${prefix}${this.workspace.renderRef(ref, event.args[index])}`);
  }

  /** The pending call ids, in registry order. */
  private pendingIds(): string[] {
    return this.workspace.surface()?.pending().map((entry) => entry.id) ?? [];
  }

  /** The raised-checkpoint summaries, previewed. */
  private checkpointSummaries(): CheckpointSummary[] {
    return [...this.checkpoints.values()].map((c) => ({
      id: c.callId,
      question: stringDescription(c.question),
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
        throw new WorkflowError(`agent options: unknown option "${key}"`, CODE.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
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
    if (opts.meta !== undefined) parsed.meta = requireRecord(opts.meta, 'meta');
    if (opts.promptMeta !== undefined) parsed.promptMeta = requireRecord(opts.promptMeta, 'promptMeta');
    if (opts.tier !== undefined) parsed.tier = requireString(opts.tier, 'tier');
    if (opts.toolNames !== undefined) parsed.toolNames = requireStringArray(opts.toolNames, 'toolNames');
    if (opts.disallowedToolNames !== undefined) {
      parsed.disallowedToolNames = requireStringArray(opts.disallowedToolNames, 'disallowedToolNames');
    }
    if (opts.maxSchemaRetries !== undefined) {
      if (typeof opts.maxSchemaRetries !== 'number' || !Number.isFinite(opts.maxSchemaRetries) || opts.maxSchemaRetries < 0) {
        throw new WorkflowError('agent options: "maxSchemaRetries" must be a non-negative number', CODE.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        });
      }
      parsed.maxSchemaRetries = opts.maxSchemaRetries;
    }
    if (opts.label !== undefined) parsed.label = requireString(opts.label, 'label');
    if (opts.baseInstructions !== undefined) parsed.baseInstructions = requireString(opts.baseInstructions, 'baseInstructions');
    if (opts.developerInstructions !== undefined) {
      parsed.developerInstructions = requireString(opts.developerInstructions, 'developerInstructions');
    }
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
   *  bookkeeping or the eval's pump-before-eval ordering. */
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(
      () => this.runSerialized(fn),
      () => this.runSerialized(fn),
    );
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One serialized operation with the sink's end-of-burst flush: the
   *  boundaries fired inside the op are written (debounced) before the
   *  op's promise resolves — a kill after the op returns loses nothing. */
  private async runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      this.sink?.flush();
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
function toRejectionValue(error: unknown): { name: string; message: string; code?: string; recoverable?: boolean } {
  if (isWorkflowError(error)) {
    return {
      name: 'WorkflowError',
      message: error.message,
      code: error.code,
      recoverable: error.recoverable,
    };
  }
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message };
  }
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    const value = error as { name?: unknown; message: string; code?: unknown; recoverable?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: value.message,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(typeof value.recoverable === 'boolean' ? { recoverable: value.recoverable } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

/** Is this error the session-cancel signal (the prompt's stop reason or
 *  the released-session error after a cancel)? */
function isCancellation(error: unknown): boolean {
  if (isWorkflowError(error)) return error.code === CODE.AGENT_CANCELLED || error.code === CODE.WORKFLOW_ABORTED;
  return false;
}

/** The eval error line: `Name: message`, head+tail capped (the harness's
 *  "thrown-exception message" convention; the harness renders the
 *  uncaught top-level rejection via the console bridge as an `error:`
 *  preview line — this is the in-eval throw, plain). */
function errorLine(info: EvalErrorInfo): string {
  return headTailDescription(`${info.name}: ${info.message}`, 120);
}

/** The JSON-safe fallback rendering for ref-less console events (the
 *  broker's own warn lines). */
function renderFallback(arg: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(arg);
  } catch {
    s = String(arg);
  }
  if (s === undefined) return '…';
  return s.length > 400 ? `${s.slice(0, 399)}…` : s;
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
