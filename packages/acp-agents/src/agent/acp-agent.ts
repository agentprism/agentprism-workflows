// AcpAgent — the SDK-style front door of @automatalabs/acp-agents: one dedicated ACP process per
// agent (and per fork), a per-agent FIFO for turns and lifecycle ops, verbatim per-turn results
// (the wire `PromptResponse` with its `_meta`, every update, every raw vendor notification), live
// forks that see everything the parent committed so far, cold reopen from an `AgentSessionRef`,
// and the no-prompt catalog probe. It composes the same primitives the runner uses
// (`PooledConnection`, `SessionHandle`, the backends, the routing grammar, the structured-output
// tool host) and never touches the runner, the pool, or `InteractiveSession`.
//
// Semantics that are not negotiable (docs/api.md "AcpAgent SDK"):
//   - FIFO: prompt / fork / setMode / setConfigOptions / close serialize behind the in-flight
//     turn; steer and cancel overlap it. A fork therefore always sees a quiescent, fully
//     persisted parent transcript (pi rejects busy forks; Claude would copy a partial turn).
//   - `prompt()` resolves a turn for EVERY PromptResponse the wire returned — no stopReason is
//     ever thrown on — and rejects only on a wire rejection, validation, abort, closed, or a typed
//     session failure (then with the complete turn attached, `isAcpAgentTurnError`).
//   - The agent never calls `SessionHandle.cancel()`: it sends one `session/cancel` through
//     `PooledConnection.cancelSession` and owns the escalation (process disposal, no wire
//     `session/close`) so `close({ keep: true })` semantics survive an ignored cancel.
//   - Abort (constructor or per-call signal) rejects the affected promise with `signal.reason`
//     untouched — never a WorkflowError, never a resolved `cancelled` turn.
import type { ContentBlock, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import type { AgentHistoryEntry, AgentSessionRef, AgentUsage } from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import {
  CANCEL_NOT_HONORED_GRACE_MS,
  PooledConnection,
  isChildCleanupError,
  type AcpSessionOptions,
  type PooledConnectionDeps,
  type SessionHandle,
  type SteeringResponse,
} from "../acp-client.js";
import type { Backend } from "../backend.js";
import type { NegotiatedCapabilities } from "../capabilities.js";
import { validateClientHandlers } from "../client-handlers.js";
import type { ErrorMapContext } from "../errors-map.js";
import { appendPromptImages, buildRunPrompt, mergeTurnMeta, validatePromptImages } from "../prompt.js";
import type { BackendRegistry } from "../registry.js";
import { assertNoModelConfigOption, resolveModelRoute } from "../routing.js";
import { sessionRefFor } from "../session-ref.js";
import { StructuredOutputToolHost } from "../structured-tool.js";
import { agentClosedError, agentTurnError, agentValidationError, mapAgentError } from "./errors.js";
import { AgentEventBus } from "./events.js";
import { acquireForkedSession, forkTraitFor } from "./fork.js";
import { probeCatalog } from "./probe.js";
import { releaseOnExit, retainOnExit } from "./process-registry.js";
import { SerialQueue } from "./queue.js";
import {
  freshBackendFor,
  resolveAgentRegistry,
  resolveAgentRoute,
  resolveRefRoute,
  validateAgentCwd,
} from "./routing.js";
import { assertPerTurnSchemaAllowed, planStructured, type StructuredPlan } from "./structured.js";
import { TurnCollector, buildTurn } from "./turn.js";
import {
  ZERO_USAGE,
  type AcpAgentCatalog,
  type AcpAgentCloseOptions,
  type AcpAgentEventListener,
  type AcpAgentEventName,
  type AcpAgentForkOptions,
  type AcpAgentOptions,
  type AcpAgentProbeOptions,
  type AcpAgentPromptOptions,
  type AcpAgentReopenOptions,
  type AcpAgentState,
  type AcpAgentSteerOptions,
  type AcpAgentTurn,
  type AcpAgentUpdateRecord,
} from "./types.js";

/** How the session behind an agent comes into being. `new` is the public constructor's path;
 *  the others are handed in by the statics and `fork()` through the module-private slot below. */
type AcpAgentSeed =
  | { readonly kind: "new" }
  | { readonly kind: "resume" | "load"; readonly sessionId: string }
  | {
      readonly kind: "fork";
      readonly sourceSessionId: string;
      readonly historySeed?: AgentHistoryEntry[];
      readonly textSeed?: string;
    };
type ResolvedSeed = AcpAgentSeed & {
  readonly registry: BackendRegistry;
  readonly backend: Backend;
  readonly modelSpec: string | undefined;
};

/** Handed to the constructor by `AcpAgent.#seeded` only. Set and consumed SYNCHRONOUSLY (the
 *  constructor has no await), so two constructions can never interleave. Module-private: nothing
 *  outside this file can reach it, so the public constructor signature never grows a parameter
 *  through which a caller could skip the ref/poolKey checks of the statics. */
let constructionSeed: ResolvedSeed | undefined;

let cancelGraceMs = CANCEL_NOT_HONORED_GRACE_MS;

/** Package-internal test seam for the ignored-cancel escalation grace. Not barrel-exported. */
export function setCancelGraceForTests(ms: number): () => void {
  const previous = cancelGraceMs;
  cancelGraceMs = ms;
  return () => {
    cancelGraceMs = previous;
  };
}

interface ActiveTurn {
  /** Settles when the wire call settled (either way). */
  readonly ended: Promise<void>;
  /** The single `session/cancel` for this turn, once requested. */
  cancelRequested?: Promise<void>;
  /** The agent-owned escalation: process disposal when the cancel is ignored past the grace. */
  escalation?: Promise<void>;
  /** A per-call abort was observed while the turn was in flight; the turn rejects with `abortReason`. */
  aborted: boolean;
  abortReason?: unknown;
}

const noop = (): void => undefined;

/** Resolve true when `op` settles before `ms`, false when the grace wins; the timer never keeps
 *  the process alive and is cleared either way. */
function resolvesWithin(op: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void op.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Layer the backend's vendor-stream `_meta` UNDER the caller's `meta`, merging one level deep
 *  for keys both carry as objects (`sessionRequestMeta` layers shallowly, so a caller's
 *  `claudeCode: { custom }` must not erase the stream flag and vice versa). */
function layerRawMeta(
  rawMeta: Record<string, unknown> | undefined,
  userMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!rawMeta) return userMeta;
  if (!userMeta) return rawMeta;
  const merged: Record<string, unknown> = { ...rawMeta, ...userMeta };
  for (const [key, rawValue] of Object.entries(rawMeta)) {
    const userValue = userMeta[key];
    if (isRecord(rawValue) && isRecord(userValue)) merged[key] = { ...rawValue, ...userValue };
  }
  return merged;
}

/** Client-side guard: every authored option id must be in the advertised catalog (values are
 *  still validated by the agent). */
function assertKnownConfigOptionIds(
  configOptions: Record<string, string | boolean> | undefined,
  advertised: readonly SessionConfigOption[],
  backendId: string,
  label: string | undefined,
): void {
  if (!configOptions) return;
  const ids = advertised.map((option) => option.id);
  for (const id of Object.keys(configOptions)) {
    if (ids.includes(id)) continue;
    throw agentValidationError(
      `config option "${id}" is not advertised by ${backendId}; advertised: ${ids.length > 0 ? ids.join(", ") : "(none)"}`,
      label,
    );
  }
}

function resolveNewSeed(options: AcpAgentOptions): ResolvedSeed {
  const registry = resolveAgentRegistry(options.backends, options.label);
  const route = resolveAgentRoute(options, registry);
  return { kind: "new", registry, backend: route.backend, modelSpec: route.modelSpec };
}

function assertSessionRef(ref: AgentSessionRef, label: string | undefined, method: string): void {
  if (!isRecord(ref) || typeof ref.sessionId !== "string" || ref.sessionId.trim() === "") {
    throw agentValidationError(`${method} requires a session ref with a non-empty sessionId`, label);
  }
  if (typeof ref.backendId !== "string" || ref.backendId.trim() === "") {
    throw agentValidationError(`${method} requires a session ref with a non-empty backendId`, label);
  }
}

/**
 * One ACP agent session on its own dedicated backend process.
 *
 * Lazy: the constructor validates (cwd, `configOptions`, the registry, `clientHandlers`) and
 * routes the backend synchronously but spawns nothing; the first queued operation (an explicit
 * `ready()` or an implicit `prompt()`) opens the session. `state` walks
 * `idle → opening → ready ⇄ busy → closed`.
 */
export class AcpAgent {
  /** The session's absolute working directory (sent on session/new|fork|resume|load). */
  readonly cwd: string;
  /** The human label stamped on event contexts and error `agentLabel`; never on the wire. */
  readonly label: string | undefined;
  /** The model this agent selects at open, as a routing spec that leads back to the same backend
   *  (`<backendId>/<model id>`, e.g. `"claude/opus[1m]"`), or `undefined` when no model was
   *  selected (the backend's default). Inherited by forks. An `AgentSessionRef` carries no model,
   *  so a cold reopen keeps it only when told: `AcpAgent.resume(agent.sessionRef!, { model: agent.model })`. */
  readonly model: string | undefined;

  readonly #options: AcpAgentOptions;
  readonly #seed: AcpAgentSeed;
  readonly #registry: BackendRegistry;
  readonly #backend: Backend;
  readonly #modelSpec: string | undefined;
  readonly #schema: TSchema | undefined;
  readonly #retainHistory: boolean;
  readonly #raw: boolean;
  readonly #signal: AbortSignal | undefined;
  readonly #bus = new AgentEventBus();
  readonly #queue = new SerialQueue();
  readonly #replay: AcpAgentUpdateRecord[] = [];

  #openPromise: Promise<void> | undefined;
  #closed = false;
  #closedDetail: string | undefined;
  #connection: PooledConnection | undefined;
  #handle: SessionHandle | undefined;
  #plan: StructuredPlan | undefined;
  #structuredHost: StructuredOutputToolHost | undefined;
  #sessionId: string | undefined;
  #sessionRef: AgentSessionRef | undefined;
  #sessionUsage: AgentUsage = ZERO_USAGE;
  #historySeed: AgentHistoryEntry[] = [];
  #textSeed = "";
  #collectingReplay = false;
  #activeTurn: ActiveTurn | undefined;
  #closePromise: Promise<void> | undefined;
  /** The `keep` the first `close()` asked for; a constructor-signal abort that drains that queued
   *  close() tears down with it, never with a keep of its own. */
  #closeKeep: boolean | undefined;
  #teardownPromise: Promise<void> | undefined;
  #teardownStarted = false;
  #forkCount = 0;
  #removeAbort: (() => void) | undefined;

  /**
   * Lazy: validates cwd/configOptions/registry/clientHandlers synchronously, routes the backend,
   * spawns nothing. This is the ONLY public constructor signature — seeded agents (forks, cold
   * reopen) are built by the statics through a module-private factory.
   */
  constructor(options: AcpAgentOptions) {
    const label = options.label;
    validateAgentCwd(options.cwd, label, "AcpAgent");
    assertNoModelConfigOption(options.configOptions, label);
    try {
      validateClientHandlers(options.clientHandlers);
    } catch (error) {
      throw agentValidationError(error instanceof Error ? error.message : String(error), label);
    }
    const seed = constructionSeed ?? resolveNewSeed(options);
    this.#options = { ...options };
    this.#seed = seed;
    this.#registry = seed.registry;
    this.#backend = seed.backend;
    this.#modelSpec = seed.modelSpec;
    this.cwd = options.cwd;
    this.label = label;
    this.model = seed.modelSpec === undefined ? undefined : `${seed.backend.id}/${seed.modelSpec}`;
    this.#schema = options.schema;
    this.#retainHistory = options.retainHistory ?? true;
    this.#raw = options.raw ?? true;
    this.#signal = options.signal;
    // Verbatim session/update records received before the session was ready (a load's replay, a
    // fork's pre-response replay) — adopted from the acquisition buffer, observable as `replay`.
    this.#bus.tap((name, event) => {
      if (name !== "session_update" || !this.#collectingReplay) return;
      const { update } = event as { update: AcpAgentUpdateRecord["update"] };
      this.#replay.push({ update: structuredClone(update), receivedAt: Date.now() });
    });
    if (options.signal) {
      const signal = options.signal;
      if (signal.aborted) {
        this.#closed = true;
      } else {
        const onAbort = (): void => this.#onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Statics and `fork()` build agents through this; the public signature never grows a second
   *  parameter, so a caller cannot hand-roll a seed that skips the ref/poolKey checks. */
  static #seeded(options: AcpAgentOptions, seed: ResolvedSeed): AcpAgent {
    constructionSeed = seed;
    try {
      return new AcpAgent(options);
    } finally {
      constructionSeed = undefined;
    }
  }

  static async #opened(agent: AcpAgent): Promise<AcpAgent> {
    try {
      await agent.ready();
      return agent;
    } catch (error) {
      await agent.close().catch(noop);
      throw error;
    }
  }

  /** `new AcpAgent(options)` + `ready()`; on failure the agent is closed and the mapped error rethrown. */
  static async open(options: AcpAgentOptions): Promise<AcpAgent> {
    return AcpAgent.#opened(new AcpAgent(options));
  }

  /** No-prompt catalog discovery: the same `HarnessConfigReport` the MCP `action:"config"` is
   *  projected from, plus the per-harness `models` view. Never throws for a per-harness failure
   *  (`probed: false`); one disposed process per target. */
  static probe(options: AcpAgentProbeOptions = {}): Promise<AcpAgentCatalog> {
    return probeCatalog(options);
  }

  /** `session/resume` of `ref.sessionId` on a fresh dedicated process of `ref.backendId`
   *  (routed by name — never the default backend — and pool-key checked). `cwd` defaults to
   *  `ref.cwd`; `model` must stay on the ref's backend. */
  static resume(ref: AgentSessionRef, options: AcpAgentReopenOptions = {}): Promise<AcpAgent> {
    return AcpAgent.#reopen("resume", ref, options);
  }

  /** `session/load`: the agent replays the transcript before the response; it lands in
   *  `history`/`text`/`replay` (the statics return after the fact, so the replay is observable
   *  only there, not through `on()`). */
  static load(ref: AgentSessionRef, options: AcpAgentReopenOptions = {}): Promise<AcpAgent> {
    return AcpAgent.#reopen("load", ref, options);
  }

  /** Cold fork of a recorded session: the trait-driven choreography without a history seed
   *  (`history` starts empty on id-only backends unless the reattach fell back to `session/load`).
   *  To seed the fork with the transcript: `const src = await AcpAgent.load(ref); await src.fork()`. */
  static fork(ref: AgentSessionRef, options: AcpAgentReopenOptions = {}): Promise<AcpAgent> {
    return AcpAgent.#reopen("fork", ref, options);
  }

  static async #reopen(
    kind: "resume" | "load" | "fork",
    ref: AgentSessionRef,
    options: AcpAgentReopenOptions,
  ): Promise<AcpAgent> {
    const label = options.label;
    const method = `AcpAgent.${kind}`;
    assertSessionRef(ref, label, method);
    const cwd = options.cwd ?? ref.cwd;
    validateAgentCwd(cwd, label, method);
    const registry = resolveAgentRegistry(options.backends, label);
    const route = resolveRefRoute(ref, options.model, registry, label);
    const base = { registry, backend: route.backend, modelSpec: route.modelSpec };
    let seed: ResolvedSeed;
    if (kind === "fork") {
      const trait = forkTraitFor(route.backend, registry);
      if (trait.cwd === "source-only" && cwd !== ref.cwd) {
        throw agentValidationError(`fork on ${route.backend.id} must keep the source cwd (${ref.cwd})`, label);
      }
      seed = { kind, sourceSessionId: ref.sessionId, ...base };
    } else {
      seed = { kind, sessionId: ref.sessionId, ...base };
    }
    return AcpAgent.#opened(AcpAgent.#seeded({ ...options, cwd }, seed));
  }

  // ── Getters (all readable after close; they return retained values) ──

  /** The resolved backend id (built-in id or registered custom name). */
  get backendId(): string {
    return this.#backend.id;
  }

  /** `idle` → `opening` → `ready` ⇄ `busy` → `closed` (set the instant `close()` is called,
   *  the constructor signal aborts, or the process dies). */
  get state(): AcpAgentState {
    if (this.#closed) return "closed";
    if (this.#handle === undefined) return this.#openPromise ? "opening" : "idle";
    return this.#queue.running ? "busy" : "ready";
  }

  /** The ACP session id once open; retained after close. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The re-attach handle computed at open (drives `AcpAgent.resume/load/fork`); retained after close. */
  get sessionRef(): AgentSessionRef | undefined {
    return this.#sessionRef;
  }

  /** Capabilities negotiated on this agent's dedicated connection. */
  get capabilities(): NegotiatedCapabilities | undefined {
    return this.#connection?.capabilities;
  }

  /** The latest echoed session config-option catalog (verbatim ACP wire shapes). */
  get configOptions(): readonly SessionConfigOption[] {
    return this.#handle?.advertisedConfigOptions ?? [];
  }

  /** The agent-advertised mode catalog plus the current mode, when supported. */
  get modes(): SessionModeState | null | undefined {
    return this.#handle?.modes;
  }

  /** `[...seed, ...session history]` (copies on read). The seed is the parent's snapshot for a
   *  live fork; a `session/load` replay lands in the session history itself. */
  get history(): readonly AgentHistoryEntry[] {
    return [
      ...this.#historySeed.map((entry) => ({ ...entry })),
      ...(this.#handle?.history ?? []).map((entry) => ({ ...entry })),
    ];
  }

  /** Verbatim session/update records received before the session was ready (a fork's
   *  pre-response replay, a load's replay), adopted from the acquisition buffer. */
  get replay(): ReadonlyArray<AcpAgentUpdateRecord> {
    return this.#replay;
  }

  /** The retained assistant text — the parent's seed (live fork) and this session's messages —
   *  folded exactly like `turn.text`: chunks of one message concatenate, distinct messages join
   *  with "\n\n". */
  get text(): string {
    return [this.#textSeed, this.#handle?.foldedText() ?? ""].filter((part) => part !== "").join("\n\n");
  }

  /** Running per-field sum of every turn this agent ran; `ZERO_USAGE` before the first turn. */
  get usage(): AgentUsage {
    return this.#sessionUsage;
  }

  /** The session-level structured-output contract, if any. */
  get schema(): TSchema | undefined {
    return this.#schema;
  }

  // ── Events (per agent: only this agent's session id; forks get their own emitter) ──

  /** Subscribe. `session_open` is sticky: a listener registered after the session opened receives
   *  it once (next microtask); a listener that saw it live never sees it twice. Returns the
   *  unsubscribe thunk; after close it is a no-op. */
  on<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): () => void {
    return this.#bus.on(name, listener);
  }

  once<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): () => void {
    return this.#bus.once(name, listener);
  }

  off<K extends AcpAgentEventName>(name: K, listener: AcpAgentEventListener<K>): void {
    this.#bus.off(name, listener);
  }

  // ── Lifecycle ──

  /** Spawn + initialize + session/new|resume|load|fork (idempotent; memoized). The implicit
   *  open of the first `prompt()` shares the same promise. */
  ready(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#ensureOpen();
    });
  }

  /**
   * One prompt turn, FIFO behind every earlier queued operation. Resolves an `AcpAgentTurn` for
   * EVERY `PromptResponse` the wire returned (no `stopReason` is thrown on — refusal, max_tokens,
   * cancelled included). Rejects only on a wire rejection (mapped like the runner), validation,
   * abort (`signal.reason` untouched), a closed agent, or a typed session failure (the mapped
   * `WorkflowError` carrying the complete turn as `error.turn`; see `isAcpAgentTurnError`).
   * `configOptions`/`mode` are applied before the turn and stick for the session. To stop a
   * specific turn use `options.signal`: it rejects while queued or before the turn reached the
   * wire (nothing is sent) and sends one `session/cancel` once in flight — `cancel()` reaches only
   * a turn already on the wire.
   */
  prompt(content: string | ContentBlock[], options: AcpAgentPromptOptions = {}): Promise<AcpAgentTurn> {
    return this.#enqueue(async () => {
      await this.#ensureOpen();
      options.signal?.throwIfAborted();
      this.#signal?.throwIfAborted();
      const handle = this.#handle!;
      const plan = this.#plan!;
      const backend = this.#backend;
      const label = this.label;

      validatePromptImages(options.images, label);
      assertPerTurnSchemaAllowed(backend, options.schema, label);
      assertNoModelConfigOption(options.configOptions, label);
      assertKnownConfigOptionIds(options.configOptions, handle.advertisedConfigOptions, this.backendId, label);
      try {
        if (options.configOptions) {
          await handle.setConfigOptions(options.configOptions);
          options.signal?.throwIfAborted();
          this.#signal?.throwIfAborted();
        }
        if (options.mode !== undefined) {
          await handle.setMode(options.mode);
          options.signal?.throwIfAborted();
          this.#signal?.throwIfAborted();
        }
      } catch (error) {
        throw mapAgentError(error, this.#errorContext(), options.signal?.aborted ? options.signal : this.#signal);
      }

      const turnSchema = options.schema ?? this.#schema;
      // Same request shaping as the runner: a generic backend whose agent may ignore the `_meta`
      // forward gets the contract stated in-band; backend turn meta wins only direct collisions.
      const shaped =
        typeof content === "string" && turnSchema !== undefined && backend.embedSchemaInPrompt
          ? buildRunPrompt(content, {}, turnSchema, backend, plan.toolActive)
          : content;
      const turnContent = appendPromptImages(shaped, options.images);
      const promptMeta = mergeTurnMeta(options.meta, backend.promptMeta(turnSchema));

      // SYNCHRONOUSLY before the wire call: the collector's tap sees every update of the turn.
      const collector = new TurnCollector(this.#bus, handle, { retainHistory: this.#retainHistory });
      // A capture left by a turn that rejected (wire error/abort) must not leak into this turn.
      plan.registration?.takeCaptured();

      const outcome = handle.promptOutcome(turnContent, promptMeta);
      const active: ActiveTurn = { ended: outcome.then(noop, noop), aborted: false };
      this.#activeTurn = active;
      const callSignal = options.signal;
      const onCallAbort = (): void => {
        active.aborted = true;
        active.abortReason = callSignal?.reason;
        void this.#cancelTurn().catch(noop);
      };
      callSignal?.addEventListener("abort", onCallAbort, { once: true });

      let response: Awaited<typeof outcome>["response"];
      let failure: Awaited<typeof outcome>["failure"];
      try {
        ({ response, failure } = await outcome);
      } catch (error) {
        if (active.aborted) throw active.abortReason;
        if (this.#signal?.aborted) throw this.#signal.reason;
        throw mapAgentError(error, this.#errorContext());
      } finally {
        collector.stop();
        callSignal?.removeEventListener("abort", onCallAbort);
        if (this.#activeTurn === active) this.#activeTurn = undefined;
      }
      // An abort observed in flight rejects with the reason even when the agent answered
      // `stopReason: "cancelled"` — abort is never a resolved turn.
      if (active.aborted) throw active.abortReason;
      if (this.#signal?.aborted) throw this.#signal.reason;

      const turn = buildTurn({
        response,
        collector,
        handle,
        backend,
        schema: turnSchema,
        captured: plan.registration?.takeCaptured(),
        sessionBefore: this.#sessionUsage,
      });
      // A walled turn still counts the tokens it burned.
      this.#sessionUsage = turn.usage.session;
      if (failure) throw agentTurnError(failure, turn, this.#errorContext());
      return turn;
    }, options.signal);
  }

  /** Inject content into the turn in flight (`_session/steering`). Overlaps the FIFO; requires a
   *  `prompt()` in flight (SCRIPT_VALIDATION_ERROR otherwise). The complete raw response is returned. */
  async steer(content: string | ContentBlock[], options: AcpAgentSteerOptions = {}): Promise<SteeringResponse> {
    this.#signal?.throwIfAborted();
    if (this.#closed) throw this.#closedError();
    const handle = this.#handle;
    if (!this.#activeTurn || !handle) {
      throw agentValidationError("AcpAgent.steer() requires a prompt() in flight", this.label);
    }
    validatePromptImages(options.images, this.label);
    try {
      return await handle.steer(appendPromptImages(content, options.images), options.meta);
    } catch (error) {
      throw mapAgentError(error, this.#errorContext(), this.#signal);
    }
  }

  /** ONE `session/cancel` for the turn whose `session/prompt` is on the wire (no-op otherwise).
   *  Resolves at the notify boundary; the in-flight `prompt()` then resolves with
   *  `stopReason: "cancelled"` when the agent honors it. A turn that ignores the cancel for the
   *  grace period ends in process disposal WITHOUT a wire `session/close` (the session stays
   *  re-openable through `sessionRef`); the turn then rejects and the agent is closed. Queued
   *  turns are untouched, and so is a turn that has started (`state === "busy"`) but has not
   *  reached the wire yet — the lazy first open, or its per-turn `configOptions`/`mode` — a
   *  `cancel()` in that window is a no-op the turn never sees. A per-call `signal` covers every
   *  window (rejects with the reason before anything is sent; `session/cancel` once in flight). */
  cancel(): Promise<void> {
    return this.#cancelTurn();
  }

  /**
   * Fork this agent onto a NEW dedicated process (queued: it runs only when no turn is in flight,
   * so the parent's persisted transcript is complete). Inherits every constructor option except
   * `label` (suffixed `/fork-<n>`) and `signal`; `overrides` may change anything but the backend
   * (`backends`, `authStore`, `providerStore`, `clientHandlers` are typed out; a `model` override
   * must route to the same backend; a `cwd` override is rejected on `source-only` backends). The
   * child's `history`/`text` are seeded from the parent's snapshot on backends whose fork response
   * has no replay. The parent keeps going, unaffected; closing either side never affects the other.
   */
  fork(overrides: AcpAgentForkOptions = {}): Promise<AcpAgent> {
    return this.#enqueue(async () => {
      await this.#ensureOpen();
      this.#signal?.throwIfAborted();
      const handle = this.#handle!;
      const trait = forkTraitFor(this.#backend, this.#registry);
      const n = (this.#forkCount += 1);
      const label = overrides.label ?? (this.label ? `${this.label}/fork-${n}` : `fork-${n}`);
      const cwd = overrides.cwd ?? this.cwd;
      // An override set to `undefined` means "not overridden" (`fork({ schema: maybeSchema })` with
      // an undefined variable type-checks): drop such keys so the spread cannot erase the parent's
      // value.
      const defined = Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined),
      ) as AcpAgentForkOptions;
      const merged: AcpAgentOptions = {
        ...this.#options,
        ...defined,
        cwd,
        label,
        signal: overrides.signal,
        backends: this.#options.backends,
        authStore: this.#options.authStore,
        providerStore: this.#options.providerStore,
        clientHandlers: this.#options.clientHandlers,
      };
      validateAgentCwd(cwd, this.label, "AcpAgent.fork");
      if (trait.cwd === "source-only" && cwd !== this.cwd) {
        throw agentValidationError(`fork on ${this.backendId} must keep the source cwd (${this.cwd})`, this.label);
      }
      let route: ReturnType<typeof resolveModelRoute> | undefined;
      if (overrides.model !== undefined) {
        route = resolveModelRoute(overrides.model, this.#registry);
        const samePool = (route.backend.poolKey ?? route.backend.id) === (this.#backend.poolKey ?? this.backendId);
        if (route.backend.id !== this.backendId || !samePool) {
          throw agentValidationError(
            `fork model "${overrides.model}" must stay on backend "${this.backendId}"`,
            this.label,
          );
        }
      }
      assertNoModelConfigOption(merged.configOptions, label);
      const child = AcpAgent.#seeded(merged, {
        kind: "fork",
        sourceSessionId: handle.sessionId,
        registry: this.#registry,
        backend: route?.backend ?? freshBackendFor(this.#backend, this.#registry),
        modelSpec: route ? route.modelSpec : this.#modelSpec,
        historySeed: this.history.map((entry) => ({ ...entry })),
        textSeed: this.text,
      });
      return AcpAgent.#opened(child);
    });
  }

  /** `session/set_mode` (queued; strict — an unadvertised id is a SCRIPT_VALIDATION_ERROR). */
  setMode(modeId: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#ensureOpen();
      this.#signal?.throwIfAborted();
      try {
        await this.#handle!.setMode(modeId);
      } catch (error) {
        throw mapAgentError(error, this.#errorContext(), this.#signal);
      }
    });
  }

  /** `session/set_config_option` per id in ascending order (queued; sticky; `"model"` reserved;
   *  unknown ids rejected against the advertised catalog). */
  setConfigOptions(options: Record<string, string | boolean>): Promise<void> {
    return this.#enqueue(async () => {
      await this.#ensureOpen();
      this.#signal?.throwIfAborted();
      const handle = this.#handle!;
      assertNoModelConfigOption(options, this.label);
      assertKnownConfigOptionIds(options, handle.advertisedConfigOptions, this.backendId, this.label);
      try {
        await handle.setConfigOptions(options);
      } catch (error) {
        throw mapAgentError(error, this.#errorContext(), this.#signal);
      }
    });
  }

  /**
   * Close: `state` becomes `closed` immediately (no new work is admitted), the teardown waits
   * behind queued work, releases the session (`keep: true` skips the wire `session/close` so the
   * agent-persisted session stays re-openable via `sessionRef`), disposes the dedicated process,
   * and releases the structured-output tool. Idempotent (same promise); never throws for an
   * already-dead process; rethrows only a `child_cleanup_error` (mapped, non-recoverable).
   */
  close(options: AcpAgentCloseOptions = {}): Promise<void> {
    this.#closeKeep ??= options.keep === true;
    this.#closePromise ??= this.#closeOwned(this.#closeKeep);
    return this.#closePromise;
  }

  /** `await using agent = …` — equivalent to `close()`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ── Internals ──

  #enqueue<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#signal?.aborted) return Promise.reject(this.#signal.reason);
    if (this.#closed) return Promise.reject(this.#closedError());
    return this.#queue.run(op, signal);
  }

  #closedError(detail?: string): Error {
    return agentClosedError(this.label, this.backendId, detail ?? this.#closedDetail);
  }

  #errorContext(): ErrorMapContext {
    return {
      label: this.label,
      backendId: this.backendId,
      backend: this.#backend,
      providerErrorMetadata: this.#handle?.providerErrorMetadata,
      authMethods: this.#connection?.capabilities?.authMethods,
    };
  }

  #ensureOpen(): Promise<void> {
    this.#openPromise ??= this.#open();
    return this.#openPromise;
  }

  #connectionDeps(): PooledConnectionDeps {
    const options = this.#options;
    return {
      onDead: () => this.#onDead(),
      onEvent: this.#bus.sink,
      // Session-scoped resolvers ride AcpSessionOptions; the connection-wide ones stay undefined.
      advertiseElicitation: Boolean(options.onElicitation),
      authStore: options.authStore,
      providerStore: options.providerStore,
      clientHandlers: options.clientHandlers,
    };
  }

  #layeredMeta(): Record<string, unknown> | undefined {
    const options = this.#options;
    return this.#raw ? layerRawMeta(this.#backend.rawMessagesMeta?.(), options.meta) : options.meta;
  }

  #sessionOptions(plan: StructuredPlan): AcpSessionOptions {
    const options = this.#options;
    return {
      cwd: this.cwd,
      schema: this.#schema,
      policy: options.tools ?? {},
      permissionResolver: options.onPermissionRequest,
      enforceToolPolicyBeforePermissionResolver: false,
      elicitationResolver: options.onElicitation,
      // The agent owns abort (it sends the cancel and the escalation itself); never the handle.
      signal: undefined,
      mcpServers: plan.mcpServers,
      meta: this.#layeredMeta(),
      label: this.label,
      baseInstructions: options.instructions?.base,
      developerInstructions: options.instructions?.developer,
      retainSessionLog: this.#retainHistory,
    };
  }

  #planStructured(connection: PooledConnection): Promise<StructuredPlan> {
    return planStructured(
      {
        schema: this.#schema,
        backend: this.#backend,
        mcpServers: this.#options.mcpServers,
        host: () => (this.#structuredHost ??= new StructuredOutputToolHost()),
      },
      connection,
    );
  }

  async #open(): Promise<void> {
    let handle: SessionHandle | undefined;
    let plan: StructuredPlan | undefined;
    try {
      // Inside the try: `create` spawns synchronously and can throw before any wire traffic
      // (spawn argument validation, missing stdio pipes, a backend's `spawnConfig()` side
      // effects); such a failure must close the agent and map like every other open failure.
      const connection = PooledConnection.create(this.#backend, this.#connectionDeps());
      this.#connection = connection;
      retainOnExit(connection);
      this.#bus.beginAcquisition();
      this.#collectingReplay = true;
      const seed = this.#seed;
      let replayed = false;
      if (seed.kind === "new") {
        // `prepare` runs after initialize, so the injection decision sees the capabilities.
        handle = await connection.openPreparedSession(async (ready) => {
          plan = await this.#planStructured(ready);
          return this.#sessionOptions(plan);
        });
      } else {
        // The cheapest "await initialize": the injection decision needs the capabilities.
        await connection.authMethods();
        plan = await this.#planStructured(connection);
        const opts = this.#sessionOptions(plan);
        if (seed.kind === "fork") {
          const trait = forkTraitFor(this.#backend, this.#registry);
          const acquired = await acquireForkedSession(connection, seed.sourceSessionId, opts, trait);
          handle = acquired.handle;
          replayed = acquired.method === "load";
        } else if (seed.kind === "resume") {
          handle = await connection.resumeSession(seed.sessionId, opts);
        } else {
          handle = await connection.loadSession(seed.sessionId, opts);
          replayed = true;
        }
        // The replay is complete at the load response; mark synchronously, before any later
        // wire message can be applied.
        if (replayed) handle.markLoadBoundary();
      }
      this.#handle = handle;
      this.#plan = plan;
      this.#sessionId = handle.sessionId;
      this.#bus.endAcquisition(handle.sessionId);
      this.#collectingReplay = false;
      this.#signal?.throwIfAborted();
      await this.#applyPostOpen(handle);
      if (seed.kind === "fork") this.#seedHistory(seed.historySeed, seed.textSeed, handle);
      this.#sessionRef = sessionRefFor(handle, this.#backend, this.cwd);
      this.#sessionUsage = ZERO_USAGE;
    } catch (error) {
      this.#collectingReplay = false;
      this.#bus.abortAcquisition();
      this.#closed = true;
      this.#handle ??= handle;
      this.#plan ??= plan;
      plan?.registration?.release();
      // Cleanup failure (child_cleanup_error) wins, exactly like the runner's interactive open.
      await this.#teardown(false);
      throw this.#signal?.aborted ? this.#signal.reason : mapAgentError(error, this.#errorContext());
    }
  }

  /** Re-apply model selection, config options and the mode on the LIVE handle (fork/resume/load
   *  responses replace the catalog). The mode rule is the runner's, verbatim. */
  async #applyPostOpen(handle: SessionHandle): Promise<void> {
    const opts = this.#options;
    const backend = this.#backend;
    if (this.#modelSpec !== undefined) await handle.selectModel(this.#modelSpec);
    this.#signal?.throwIfAborted();
    assertKnownConfigOptionIds(opts.configOptions, handle.advertisedConfigOptions, this.backendId, this.label);
    await handle.setConfigOptions(opts.configOptions);
    this.#signal?.throwIfAborted();
    const effectiveMode = opts.mode ?? backend.defaultModeId;
    if (
      effectiveMode &&
      (opts.mode !== undefined || handle.modes?.availableModes.some((mode) => mode.id === effectiveMode))
    ) {
      await handle.setMode(effectiveMode);
    }
    this.#signal?.throwIfAborted();
  }

  /** Seed a live fork's history/text from the parent's snapshot — only when the child's own
   *  accumulator is empty (a `session/load` fallback already replayed the transcript). */
  #seedHistory(seed: AgentHistoryEntry[] | undefined, text: string | undefined, handle: SessionHandle): void {
    if (!seed || handle.history.length > 0) return;
    this.#historySeed = seed;
    this.#textSeed = text ?? "";
  }

  #cancelTurn(): Promise<void> {
    const active = this.#activeTurn;
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!active || !connection || sessionId === undefined) return Promise.resolve();
    // Settles pending permissions/elicitations + ONE session/cancel notify.
    active.cancelRequested ??= connection.cancelSession(sessionId);
    active.escalation ??= active.cancelRequested.then(async () => {
      if (await resolvesWithin(active.ended, cancelGraceMs)) return;
      // Ignored: kill the process; NO wire session/close, so `keep` semantics survive.
      await connection.dispose();
    });
    void active.escalation.catch(noop);
    return active.cancelRequested;
  }

  #onAbort(): void {
    const reason = this.#signal?.reason;
    this.#closed = true;
    this.#queue.drain(reason);
    void this.#cancelTurn().catch(noop);
    // An open/fork/reattach in flight: dispose the process so the raced wire call rejects.
    if (this.#handle === undefined && this.#connection) void this.#connection.dispose().catch(noop);
    // Not queued: tear down once the in-flight op settled (queued ones were just drained). A
    // close() that was queued behind that op keeps the `keep` it asked for.
    void this.#queue.whenIdle().then(() => this.#teardown(this.#closeKeep ?? false)).catch(noop);
  }

  #onDead(): void {
    // Our own dispose (close / abort / open failure) — the teardown already owns the connection.
    if (this.#teardownStarted) return;
    if (!this.#closed) this.#closedDetail = "process exited";
    this.#closed = true;
    this.#queue.drain(this.#closedError("process exited before the queued operation ran"));
    void this.#teardown(true).catch(noop);
  }

  async #closeOwned(keep: boolean): Promise<void> {
    this.#closed = true;
    let started = false;
    try {
      await this.#queue.run(() => {
        started = true;
        return this.#teardown(keep);
      });
    } catch (error) {
      // The teardown itself failed: only a genuine child_cleanup_error (mapped) gets here.
      if (started) throw error;
      // The queued entry was drained (constructor abort / process death) while an op was still
      // running: wait for that op to settle, then run the memoized teardown — never under a turn
      // that is still on the wire (the abort's own cancel + grace must play out first).
      await this.#queue.whenIdle();
      await this.#teardown(keep);
    }
  }

  #teardown(keep: boolean): Promise<void> {
    this.#teardownPromise ??= this.#teardownOwned(keep);
    return this.#teardownPromise;
  }

  async #teardownOwned(keep: boolean): Promise<void> {
    this.#teardownStarted = true;
    const handle = this.#handle;
    const connection = this.#connection;
    const plan = this.#plan;
    const host = this.#structuredHost;
    let cleanupError: unknown;
    try {
      if (handle) await handle.release({ keepOpen: keep });
    } catch (error) {
      if (isChildCleanupError(error)) cleanupError = error;
    }
    plan?.registration?.release();
    // The process BEFORE the tool host (the runner's order: pool, then tools): the agent process
    // holds keep-alive sockets to the host's HTTP server, and `server.close()` waits for idle
    // sockets to time out (seconds) unless the peer is gone first.
    if (connection) {
      await connection.dispose().catch(noop);
      releaseOnExit(connection);
    }
    if (host) await host.dispose().catch(noop);
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    // Last, so the agent's own `session_close` (emitted by the release above) was delivered.
    this.#bus.close();
    if (cleanupError) throw mapAgentError(cleanupError, this.#errorContext());
  }
}
