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
 *   on the backend for the restore path's lazy re-attach.
 * - **Six concurrent subagents per workspace** (the doc-settled cap).
 *   The cap counts live work: unsettled agent calls plus sessions
 *   currently running a queued-steer delivery turn. A dispatch over the
 *   cap is refused at dispatch time — recorded in the call store
 *   (dispatched + rejected, so a restore never re-issues it) and the
 *   guest call rejects with a recoverable error; nothing is queued and
 *   nothing is hidden. `maxConcurrentAgents` is configurable (server
 *   configuration, invisible to the guest).
 * - **Steering resolves with what actually happened** (the doc's
 *   "nothing is hidden, nothing hard-errors"): followUp/steer settle
 *   with the acp-agents steering-outcome vocabulary where the backend
 *   advertises `_session/steering`, with the broker's honest `queued`
 *   marker where it does not (see the steering mechanism table below).
 *   Steering calls NEVER hard-error: every backend/wire failure resolves
 *   `failed`; the only rejections are guest protocol violations.
 * - **The append-only call store** (`store.ts`): every call's outcome is
 *   recorded by call id BEFORE it is settled into the guest (transfer
 *   lesson 1 — exactly-once settlement across crashes). The pump's
 *   delivery loop is record → settle → consume; both sides are first-wins
 *   idempotent, so a crash between the store write and the guest
 *   settlement is healed by the next delivery attempt (and, across a
 *   restore, by `reconcile()`'s store arm).
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
 * ## The steering mechanism table (spec-owed decision)
 *
 * The roadmap doc's per-backend steering *mechanism* table is decided
 * here (the doc's remaining item — the documentation table generated
 * from live capability probes — is the observability layer's artifact):
 *
 * | Case | Mechanism | Outcome the handle resolves with |
 * |---|---|---|
 * | backend advertises `_session/steering`, turn in flight | `session.steer(content)` — live injection | the backend's verbatim outcome: `injected` \| `startedNewTurn` \| `failed` |
 * | backend advertises `_session/steering`, session idle | `session.prompt(content)` — a new turn (there is nothing to inject into) | `startedNewTurn` |
 * | backend does NOT advertise steering, turn in flight | content enqueued for next-turn delivery | `queued` (immediately — accepted for next-turn delivery; if the call is later cancelled the queue is dropped, and a delivery-turn failure surfaces as a warn-level line in the next tool result — both documented) |
 * | backend does NOT advertise steering, session idle | `session.prompt(content)` — a new turn | `startedNewTurn` |
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
 *   session — the one divergence from `run()`: the client-hosted
 *   StructuredOutput MCP capture tool is not injected on the interactive
 *   path; the native + prose-extraction channels are the same ladder).
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
import { InMemoryCallStore, type CallOutcome, type CallStore } from './store.js';
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
}

/** One completed interactive turn (the broker's structural stand-in for
 *  the runner's `InteractiveTurn`). */
export interface BrokerTurn {
  readonly stopReason: string;
  readonly text: string;
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
  /** The latest turn's assistant text. */
  currentTurnText(): string;
  /** The latest turn's FINAL assistant message (schema extraction). */
  finalMessageText(): string;
  /** The backend's native structured output for the latest turn, if any. */
  rawStructuredOutput(): unknown;
}

/** The runner seam the broker drives (structural subset of
 *  `AcpAgentRunner` — tests inject fakes). */
export interface BrokerRunner {
  openSession(opts: BrokerOpenSessionOptions): Promise<BrokerSession>;
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
  /** Pending calls with no store completion — left pending (the
   *  re-attach / re-issue arms belong to the restore path, a later
   *  phase). */
  leftPending: string[];
}

/** Options for attaching a broker to a workspace. */
export interface BrokerOptions {
  /** The ACP runner (structural subset of `AcpAgentRunner`; fakes for
   *  tests). Defaults to a bare `AcpAgentRunner` owned by this broker
   *  (disposed with it); hosts with a backend registry pass their own
   *  configured runner and own its lifetime. */
  runner?: BrokerRunner;
  /** The append-only call store. Defaults to `InMemoryCallStore`. */
  store?: CallStore;
  /** The concurrency cap: max concurrent subagents per workspace
   *  (doc-settled default 6). Counts unsettled agent calls plus sessions
   *  running queued-steer delivery turns. */
  maxConcurrentAgents?: number;
  /** Per-eval and per-settlement-drain interrupt handler (a runaway
   *  guest continuation stays bounded). */
  interruptHandler?: () => boolean;
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
  /** Queued followUp/steer payloads (no-extension backends, turn in
   *  flight), in order. */
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
 *  an answer can never settle a call that shares the id space). */
interface PendingCheckpoint {
  callId: string;
  call: GuestCall;
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
  /** Sessions running a queued-steer delivery turn — one concurrency
   *  token each (a subagent is working even on a follow-up turn). */
  private readonly deliverySlots = new Set<string>();
  /** Call ids settled synchronously at dispatch (refusals) since the
   *  last eval result — reported in that eval's `completed`. */
  private readonly syncSettled: string[] = [];
  private disposed = false;
  private opChain: Promise<unknown> = Promise.resolve();

  private constructor(workspace: Workspace, options: BrokerOptions) {
    this.workspace = workspace;
    this.maxConcurrentAgents = options.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    this.callStore = options.store ?? new InMemoryCallStore();
    this.interruptHandler = options.interruptHandler;
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
      try {
        completed = await this.pumpUnlocked();
      } catch (error) {
        if (error instanceof DrainJobError) {
          // The pump's drain ran PREVIOUS evals' continuations and one
          // failed. The current eval did not fail; the background
          // failure is honest output (rendered alongside the eval's own
          // error, if it has one), and the VM stays usable.
          const { outcome, completion } = this.runEval(code, options);
          return this.render(outcome, completion, this.syncSettled.splice(0), errorLine(error.info));
        }
        throw error; // host-side failure — fail loudly
      }
      const { outcome, completion } = this.runEval(code, options);
      // The pump's deliveries first, then this eval's own synchronous
      // settlements (dispatch-time refusals).
      completed = [...completed, ...this.syncSettled.splice(0)];
      return this.render(outcome, completion, completed);
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
   * with the VM left usable.
   */
  async pump(): Promise<string[]> {
    return this.serialized(() => this.pumpUnlocked());
  }

  /**
   * The store arm of the three-way post-restore reconciliation: read the
   * guest registry's pending calls, and settle every one whose call the
   * store shows as completed — from the store, exactly once (the guest's
   * own idempotent settle-by-id makes a double delivery a no-op). The
   * re-attach and re-issue arms belong to the restore path (a later
   * phase); entries without a store completion are reported in
   * `leftPending`. Drains once after settling.
   */
  async reconcile(): Promise<ReconcileReport> {
    return this.serialized(async () => {
      this.assertAlive();
      const surface = this.workspace.surface();
      if (surface === undefined) {
        throw new Error('Broker: cannot reconcile — the guest surface is not installed');
      }
      const report: ReconcileReport = { settledFromStore: [], leftPending: [] };
      for (const entry of surface.pending()) {
        const record = this.callStore.lookup(entry.id);
        const completion = record?.completion;
        if (completion !== null && completion !== undefined) {
          const settled = surface.settle(entry.id, completion.outcome, completion.value);
          if (settled) report.settledFromStore.push(entry.id);
          continue;
        }
        report.leftPending.push(entry.id);
      }
      if (report.settledFromStore.length > 0) this.drain();
      return report;
    });
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
   * Teardown: cancel in-flight turns (best-effort), dispose the runner
   * (releasing every session — opened with `keepSession: true`, so the
   * ACP sessions persist on the backends for a later re-attach), and
   * drop the broker's state. The workspace (and its VM) is the caller's
   * to dispose.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.serialized(async () => {
      const cancels: Promise<unknown>[] = [];
      for (const entry of this.sessions.values()) {
        if (entry.busy) cancels.push(this.cancelSession(entry));
      }
      await Promise.allSettled(cancels);
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
   * a kill between the eval and the next snapshot), then settled within
   * the same eval, first-wins. Returns whether a pending checkpoint with
   * that id was answered; an answer never touches the agent/steer call
   * table (the phase-B review regression's id-space separation).
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
      this.checkpoints.delete(callId);
      let answer: unknown;
      try {
        answer = JSON.parse(answerJson);
      } catch {
        // A host-side contract violation (the guest only sends
        // JSON.stringify output): reject rather than park the question
        // forever.
        this.recordCompletion(callId, {
          outcome: 'reject',
          value: toRejectionValue(new Error(`checkpoint ${callId}: answer was not valid JSON`)),
          completedAtMs: now(),
        });
        pending.call.reject(new Error(`checkpoint ${callId}: answer was not valid JSON`));
        return true;
      }
      this.recordCompletion(callId, { outcome: 'resolve', value: answer, completedAtMs: now() });
      pending.call.resolve(answer);
      return true;
    }
    this.recordDispatch(callId, 'checkpoint', question ?? '', optionsJson);
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
    this.recordDispatch(callId, 'steer', action, payloadJson);

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

    // The session is idle: the content starts a new turn right now.
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
   *  keeps the original record). */
  private recordDispatch(callId: string, kind: 'agent' | 'checkpoint' | 'steer', detail: string, optionsJson: string | null): void {
    this.callStore.recordDispatched({
      callId,
      kind,
      detail,
      optionsJson,
      dispatchedAtMs: now(),
      reissues: 0,
      completion: null,
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
   *  stays open after the call settles — the live-handle contract. */
  private async runAgentTask(
    callId: string,
    modelSpec: string,
    task: string,
    parsed: ParsedAgentOptions,
  ): Promise<{ outcome: 'resolve' | 'reject'; value: unknown }> {
    try {
      const session = await this.runner.openSession({
        model: modelSpec,
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
      entry.busy = true;
      const turn = await session.prompt(task, { promptMeta: parsed.promptMeta });
      this.assertNormalStopReason(turn.stopReason, callId);
      const value =
        parsed.schema !== undefined
          ? await this.resolveStructuredOutput(entry, parsed)
          : this.finalText(entry);
      return { outcome: 'resolve', value };
    } catch (error) {
      return { outcome: 'reject', value: toRejectionValue(error) };
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
    const text = entry.session.currentTurnText().trim();
    if (!text) {
      throw new WorkflowError('Subagent produced no assistant output', CODE.AGENT_EMPTY_OUTPUT, {
        recoverable: true,
      });
    }
    return text;
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
        throw new WorkflowError(`call ${callId} was cancelled`, CODE.AGENT_CANCELLED, {
          recoverable: false,
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
      const turn = await entry.session.prompt(prompt, { promptMeta });
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

  /** Drop a cancelled call's queued steers (their promises already
   *  resolved `queued` at enqueue — the cancellation is the visible
   *  reason delivery never happens). */
  private dropQueue(entry: SessionEntry): void {
    entry.queue = [];
  }

  /** A queued-steer delivery turn failed: surface a warn-level line in
   *  the next tool result (nothing is hidden — the steer's own promise
   *  already resolved `queued`). */
  private warnDeliveryFailure(steerCallId: string, sessionCallId: string, error: unknown): void {
    const message = toRejectionValue(error).message;
    this.consoleBuffer.push({
      level: 'warn',
      refs: [],
      args: [`steer ${steerCallId} (on ${sessionCallId}): queued delivery failed: ${message}`],
    });
  }

  /** A delivery turn ended (settled or cancelled): the session is idle
   *  unless more queued steers start the next turn. */
  private endDeliveryTurn(entry: SessionEntry): void {
    entry.busy = false;
    entry.delivering = false;
    this.deliverySlots.delete(entry.callId);
    if (entry.callCancelled) {
      this.dropQueue(entry);
      return;
    }
    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      void this.runPromptTask(next.callId, entry, next.prompt, next.promptMeta);
    }
  }

  // ── The settlement pump ───────────────────────────────────────────────

  private async pumpUnlocked(): Promise<string[]> {
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
    if (settled.length > 0) this.drain();
    return settled;
  }

  /** An agent call's settlement transition: the session is idle (its
   *  concurrency token is released) and queued steers start their
   *  delivery turns; a cancelled call's queue is dropped. */
  private onCallSettled(callId: string): void {
    const entry = this.sessions.get(callId);
    if (entry === undefined) return;
    entry.callSettled = true;
    entry.busy = false;
    this.agentSlots.delete(callId);
    if (entry.callCancelled) {
      this.dropQueue(entry);
      return;
    }
    if (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      void this.runPromptTask(next.callId, entry, next.prompt, next.promptMeta);
    }
  }

  /** Record → settle → consume for one ready outcome (the exactly-once
   *  discipline). The store write happens BEFORE the guest settlement;
   *  on a crash between the two, the next delivery (or the restore's
   *  reconcile) settles from the store — never twice. */
  private deliver(
    callId: string,
    outcome: { outcome: 'resolve' | 'reject'; value: unknown },
  ): void {
    this.recordCompletion(callId, { outcome: outcome.outcome, value: outcome.value, completedAtMs: now() });
    this.settleIntoGuest(callId, outcome.outcome, outcome.value);
  }

  /** Settle one call into the guest: through its live deferred when this
   *  broker issued it, through the reconciliation surface otherwise
   *  (the restored-broker route). Both converge on the guest's
   *  idempotent first-wins settle. */
  private settleIntoGuest(callId: string, outcome: 'resolve' | 'reject', value: unknown): void {
    const call = this.deferreds.get(callId);
    this.deferreds.delete(callId);
    if (call !== undefined) {
      if (outcome === 'resolve') call.resolve(value);
      else call.reject(value);
      return;
    }
    const surface = this.workspace.surface();
    if (surface === undefined) {
      throw new Error(`Broker: cannot settle ${callId} — the guest surface is not installed`);
    }
    surface.settle(callId, outcome, value);
  }

  /** One settlement drain with the broker's interrupt handler armed (a
   *  continuation resumed by settlement cannot run away unguarded). */
  private drain(): void {
    this.workspace.drainJobs({ interruptHandler: this.interruptHandler });
  }

  // ── Eval + rendering ──────────────────────────────────────────────────

  /** Run the eval (with the rejection bridge armed) and read the
   *  completion. The caller owns `completion` when present. */
  private runEval(code: string, options: ReplEvalOptions): { outcome: ReplEvalOutcome; completion?: unknown } {
    return this.workspace.evalWithCompletion(code, {
      ...options,
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
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
