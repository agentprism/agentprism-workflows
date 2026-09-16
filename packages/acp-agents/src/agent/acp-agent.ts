// AcpAgent — the SDK-style front door of @automatalabs/acp-agents: one dedicated ACP process per
// agent (and per fork), a per-agent FIFO for turns and lifecycle ops, verbatim per-turn results
// (the wire `PromptResponse` with its `_meta`, every update, every raw vendor notification), live
// forks that see everything the parent committed so far, cold reopen from an `AgentSessionRef`,
// and the no-prompt catalog probe. It composes the same primitives the runner uses
// (`PooledConnection`, `SessionHandle`, the backends, the routing grammar, the structured-output
// tool host) plus its own per-agent function-tool host (`agent_tools`, src/agent/tool-host.ts),
// and never touches the runner, the pool, or `InteractiveSession`.
//
// Semantics that are not negotiable (docs/api.md "AcpAgent SDK"):
//   - FIFO: prompt / stream / fork / setModel / setMode / setConfigOptions / close serialize
//     behind the in-flight turn; steer and cancel overlap it. A fork therefore always sees a
//     quiescent, fully persisted parent transcript (pi rejects busy forks; Claude would copy a
//     partial turn).
//   - The model is a session setting, not an identity: `setModel(spec)` and a per-turn `model`
//     re-route through the fork rule (same backend, same poolKey) and send the routed remainder
//     verbatim as `session/set_config_option { configId: "model" }` — exactly how open selects —
//     then `agent.model` moves to the routed spec, so forks and cold reopens inherit the switch.
//   - `prompt()` resolves a turn for EVERY PromptResponse the wire returned — no stopReason is
//     ever thrown on — and rejects only on a wire rejection, validation, abort, closed, or a typed
//     session failure (then with the complete turn attached, `isAcpAgentTurnError`). `stream()`
//     is the same turn observed as an async iterable: its tap is attached inside the queued
//     operation, the instant the turn is dequeued, so it yields THIS turn's events and no other's.
//   - A schema miss is a RESULT, not an error, and `prompt()` is one turn unless `schemaRetries`
//     buys more: the opt-in ladder re-prompts the same session inside the same queued operation
//     with the runner's repair prompt, each repair a real turn (`stream()` sees it, `usage` counts
//     it, `cancel()`/`steer()` reach it), and the resolved turn is the final attempt's plus
//     `structuredAttempts`. Only an `end_turn` miss is repaired — a cancelled or walled attempt
//     ends the ladder where it stands.
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
  type ReattachPreference,
  type SessionHandle,
  type SteeringResponse,
} from "../acp-client.js";
import type { Backend } from "../backend.js";
import type { NegotiatedCapabilities } from "../capabilities.js";
import { validateClientHandlers } from "../client-handlers.js";
import type { ErrorMapContext } from "../errors-map.js";
import type { AcpSessionUpdate } from "../events.js";
import { appendPromptImages, buildRunPrompt, mergeTurnMeta, validatePromptImages } from "../prompt.js";
import type { BackendRegistry, CustomBackendConfig } from "../registry.js";
import { assertNoModelConfigOption, type ModelRoute } from "../routing.js";
import { sessionRefFor } from "../session-ref.js";
import { repairPromptText } from "../structured-output.js";
import { StructuredOutputToolHost } from "../structured-tool.js";
import { assertSystemPromptSupported } from "../system-prompt.js";
import { describeBackendTraits, type AcpAgentTraits } from "../traits.js";
import type { TypedSessionFailure } from "../typed-failures.js";
import {
  agentClosedError,
  agentTurnError,
  agentValidationError,
  mapAgentError,
  validateArguments,
} from "./errors.js";
import { AgentEventBus } from "./events.js";
import { acquireForkedSession, forkTraitFor } from "./fork.js";
import { MessageFolder, copyMessage } from "./messages.js";
import { probeCatalog } from "./probe.js";
import { releaseOnExit, retainOnExit } from "./process-registry.js";
import { SerialQueue } from "./queue.js";
import { TurnStream } from "./stream.js";
import {
  freshBackendFor,
  resolveAgentRegistry,
  resolveAgentRoute,
  resolveModelSwitch,
  resolveRefRoute,
  resolveSameBackendModel,
  validateAgentCwd,
} from "./routing.js";
import { assertPerTurnSchemaAllowed, planStructured, validateSchemaRetries, type StructuredPlan } from "./structured.js";
import { AgentToolHost, type AgentToolHostContext } from "./tool-host.js";
import { planTools, validateToolDefinitions } from "./tools.js";
import { TurnCollector, buildTurn } from "./turn.js";
import {
  ZERO_USAGE,
  type AcpAgentCatalog,
  type AcpAgentCloseOptions,
  type AcpAgentEventListener,
  type AcpAgentEventName,
  type AcpAgentForkOptions,
  type AcpAgentMessage,
  type AcpAgentOptions,
  type AcpAgentProbeOptions,
  type AcpAgentPromptOptions,
  type AcpAgentReopenOptions,
  type AcpAgentState,
  type AcpAgentSteerOptions,
  type AcpAgentStream,
  type AcpAgentStreamEvent,
  type AcpAgentToolDefinition,
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
      /** The id-only reattach's preferred method: `resume` for the live `fork()` (the child is
       *  seeded from the parent), `load` for the cold static (the replay IS the child's transcript). */
      readonly reattach: ReattachPreference;
      readonly historySeed?: AgentHistoryEntry[];
      readonly textSeed?: string;
      readonly messagesSeed?: AcpAgentMessage[];
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
  assertSystemPromptSupported(route.backend, options.systemPrompt, options.label);
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
 * Lazy: the constructor validates (cwd, `configOptions`, the registry, `clientHandlers`, the
 * function-tool definitions, `schemaRetries`) and routes the backend synchronously but spawns nothing; the first
 * queued operation (an explicit `ready()` or an implicit `prompt()`) opens the session. `state`
 * walks `idle → opening → ready ⇄ busy → closed`.
 */
export class AcpAgent {
  /** The session's absolute working directory (sent on session/new|fork|resume|load). */
  readonly cwd: string;
  /** The human label stamped on event contexts and error `agentLabel`; never on the wire. */
  readonly label: string | undefined;

  readonly #options: AcpAgentOptions;
  readonly #seed: AcpAgentSeed;
  readonly #registry: BackendRegistry;
  readonly #backend: Backend;
  /** The verbatim model id this agent is on (what open sends and a switch replaces); `undefined`
   *  = no selection. Read by open's post-open apply and by `fork()` for the child's seed. */
  #modelSpec: string | undefined;
  /** `#modelSpec` in its routed spec form (`<backendId>/<id>`) — what the `model` getter returns. */
  #model: string | undefined;
  readonly #schema: TSchema | undefined;
  /** The default repair budget (`schemaRetries`, validated in the constructor); a per-turn value wins. */
  readonly #schemaRetries: number;
  readonly #tools: readonly AcpAgentToolDefinition[];
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
  /** The `agent_tools` host, created lazily by the first open that injects it; disposed on close. */
  #toolHost: AgentToolHost | undefined;
  /** The collector of the turn on the wire — what a function tool's `toolCallId` is correlated against. */
  #activeCollector: TurnCollector | undefined;
  #sessionId: string | undefined;
  #sessionRef: AgentSessionRef | undefined;
  #sessionUsage: AgentUsage = ZERO_USAGE;
  #historySeed: AgentHistoryEntry[] = [];
  #textSeed = "";
  #messagesSeed: AcpAgentMessage[] = [];
  /** The retained transcript as messages — the same updates the handle's accumulator folds into
   *  `history`/`text`, folded per message. Live once the session is registered; a `load` replay
   *  is folded from `#replay` at that point (the accumulator saw it too); a fork's pre-response
   *  replay is not (the accumulator never saw it — it lands in `replay` only). */
  readonly #transcript = new MessageFolder();
  #transcriptLive = false;
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
   * Lazy: validates cwd/configOptions/registry/clientHandlers/tools/schemaRetries synchronously,
   * routes the backend, spawns nothing. This is the ONLY public constructor signature — seeded agents (forks,
   * cold reopen) are built by the statics through a module-private factory.
   */
  constructor(options: AcpAgentOptions) {
    const label = options.label;
    // Every pre-spawn guard speaks INVALID_ARGUMENT: the SDK's own throw it directly, a shared
    // validator's SCRIPT_VALIDATION_ERROR is re-coded here at the boundary.
    const { seed, tools, schemaRetries } = validateArguments(() => {
      validateAgentCwd(options.cwd, label, "AcpAgent");
      assertNoModelConfigOption(options.configOptions, label);
      try {
        validateClientHandlers(options.clientHandlers);
      } catch (error) {
        throw agentValidationError(error instanceof Error ? error.message : String(error), label);
      }
      const tools = validateToolDefinitions(options.tools, label);
      const schemaRetries = validateSchemaRetries(options.schemaRetries, label, "AcpAgent");
      return { seed: constructionSeed ?? resolveNewSeed(options), tools, schemaRetries };
    });
    this.#options = { ...options };
    this.#tools = tools;
    this.#schemaRetries = schemaRetries;
    this.#seed = seed;
    this.#registry = seed.registry;
    this.#backend = seed.backend;
    this.#modelSpec = seed.modelSpec;
    this.cwd = options.cwd;
    this.label = label;
    this.#model = seed.modelSpec === undefined ? undefined : `${seed.backend.id}/${seed.modelSpec}`;
    this.#schema = options.schema;
    this.#retainHistory = options.retainHistory ?? true;
    this.#raw = options.raw ?? true;
    this.#signal = options.signal;
    // Verbatim session/update records received before the session was ready (a load's replay, a
    // fork's pre-response replay) — adopted from the acquisition buffer, observable as `replay`.
    // Once the session is registered, every update is folded into the message transcript.
    this.#bus.tap((name, event) => {
      if (name !== "session_update") return;
      const { update } = event as { update: AcpSessionUpdate };
      if (this.#collectingReplay) {
        this.#replay.push({ update: structuredClone(update), receivedAt: Date.now() });
      } else if (this.#transcriptLive) {
        this.#transcript.apply(structuredClone(update), Date.now());
      }
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

  /** The table-based traits of the backend `spec` routes to — exactly the constructor's routing
   *  (`backends` merged over `AGENTPRISM_BACKENDS`, a registered name wins, an unrouted spec goes
   *  to the default backend) — without spawning anything. The instance getter refines the same
   *  shape with the live initialize advertisements once the agent is open. */
  static traits(spec?: string, options: { backends?: Record<string, CustomBackendConfig> } = {}): AcpAgentTraits {
    return validateArguments(() => {
      const registry = resolveAgentRegistry(options.backends);
      const route = resolveAgentRoute({ model: spec }, registry);
      return describeBackendTraits(route.backend, registry);
    });
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

  /** Cold fork of a recorded session: the trait-driven choreography with no parent to seed from,
   *  so on an id-only backend the reattach PREFERS `session/load` — the agent replays the forked
   *  transcript and it lands in the child's `history`/`text`/`messages`/`replay` — and takes
   *  `session/resume` (an empty transcript) only when load is not advertised. On a live backend the
   *  fork handle is the session and the child's transcript is whatever the agent streams. */
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
    const { cwd, seed } = validateArguments(() => {
      assertSessionRef(ref, label, method);
      const cwd = options.cwd ?? ref.cwd;
      validateAgentCwd(cwd, label, method);
      const registry = resolveAgentRegistry(options.backends, label);
      const route = resolveRefRoute(ref, options.model, registry, label);
      assertSystemPromptSupported(route.backend, options.systemPrompt, label);
      const base = { registry, backend: route.backend, modelSpec: route.modelSpec };
      if (kind === "fork") {
        const trait = forkTraitFor(route.backend, registry);
        if (trait.cwd === "source-only" && cwd !== ref.cwd) {
          throw agentValidationError(`fork on ${route.backend.id} must keep the source cwd (${ref.cwd})`, label);
        }
        return { cwd, seed: { kind, sourceSessionId: ref.sessionId, reattach: "load", ...base } satisfies ResolvedSeed };
      }
      return { cwd, seed: { kind, sessionId: ref.sessionId, ...base } satisfies ResolvedSeed };
    });
    return AcpAgent.#opened(AcpAgent.#seeded({ ...options, cwd }, seed));
  }

  // ── Getters (all readable after close; they return retained values) ──

  /** The resolved backend id (built-in id or registered custom name). */
  get backendId(): string {
    return this.#backend.id;
  }

  /** The model this agent is on, as a routing spec that leads back to the same backend
   *  (`<backendId>/<model id>`, e.g. `"claude/opus[1m]"`): the constructor's `model` until a
   *  `setModel()` or a per-turn `model` applied, then the switched one; `undefined` when nothing
   *  was ever selected (the backend's default). Inherited by forks taken after the switch. An
   *  `AgentSessionRef` carries no model, so a cold reopen keeps it only when told:
   *  `AcpAgent.resume(agent.sessionRef!, { model: agent.model })`. */
  get model(): string | undefined {
    return this.#model;
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

  /** This backend's traits (`describeBackendTraits`): the tables before open, refined by the live
   *  initialize advertisements once the connection is up (retained after close). A fresh frozen
   *  object per read. */
  get traits(): AcpAgentTraits {
    return describeBackendTraits(this.#backend, this.#registry, this.#connection?.capabilities);
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

  /** The retained transcript as messages (`AcpAgentMessage`, copies on read): `[...seed, ...this
   *  session's messages]` — the same retained log `history`/`text` describe, folded per message
   *  with the turn fold's boundary, a `load` replay included, seeded from the parent's snapshot on
   *  a live fork, and holding only the latest turn under `retainHistory: false`. */
  get messages(): readonly AcpAgentMessage[] {
    return [...this.#messagesSeed.map(copyMessage), ...this.#transcript.snapshot()];
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
   * `model`/`configOptions`/`mode` are applied before the turn, in that order, and stick for the
   * session. With a schema active and a `schemaRetries` budget > 0 (constructor or per turn), an
   * `end_turn` that left `structured` absent is followed by up to that many repair turns inside
   * this same operation; the resolved turn is the final attempt's with `structuredAttempts`. To
   * stop a specific turn use `options.signal`: it rejects while queued or before the turn reached
   * the wire (nothing is sent) and sends one `session/cancel` once in flight — `cancel()` reaches
   * only a turn already on the wire (a repair turn included).
   */
  prompt(content: string | ContentBlock[], options: AcpAgentPromptOptions = {}): Promise<AcpAgentTurn> {
    return this.#enqueue(() => this.#promptTurn(content, options, "prompt"), options.signal);
  }

  /**
   * The same turn as `prompt()`, observed as an async iterable of this turn's events: every bus
   * event emitted while the turn's operation runs — from the instant it is dequeued (a lazy
   * open's `session_open`, a per-turn `mode`'s `current_mode_update` included) until the wire
   * settles — each tagged `{ type: <event name>, ...payload }` (an update once, under its kind;
   * never the `session_update` catch-all; a concurrent `steer()`'s `steering` event and the
   * permission / elicitation / raw_message events included), then the terminal
   * `{ type: "turn", turn }` with exactly the `AcpAgentTurn` `prompt()` would have resolved.
   * The turn is queued (FIFO) by this call, exactly like `prompt()`; events are buffered without
   * dropping until consumed. When the turn rejects, the iterator yields the buffered events, then
   * throws that same error. Leaving early — `break`, `return()`, `throw()` — aborts the turn's
   * per-call signal: a turn still queued or not yet on the wire is dropped with nothing sent, a
   * turn in flight gets the one `session/cancel` (and the agent's escalation), and the call
   * resolves only once the turn settled, so no turn keeps running unobserved.
   */
  stream(content: string | ContentBlock[], options: AcpAgentPromptOptions = {}): AcpAgentStream {
    // The consumer's exit is not an error: the turn rejects with this marker, which never leaves
    // the stream (a caller's own `options.signal` reason does — the iterator throws it).
    const left = new Error("AcpAgent.stream(): the consumer stopped iterating");
    const controller = new AbortController();
    const outer = options.signal;
    const forward = (): void => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", forward, { once: true });

    const stream = new TurnStream(() => {
      controller.abort(left);
      return settled.then(noop, noop);
    });
    // The tap is attached INSIDE the queued operation, the instant this turn is dequeued: from
    // outside the queue it would observe the previous turn's events too.
    const settled = this.#enqueue(async () => {
      const untap = this.#bus.tap((name, event) => {
        if (name === "session_update") return;
        stream.push({ type: name, ...(event as object) } as AcpAgentStreamEvent);
      });
      try {
        const turn = await this.#promptTurn(content, { ...options, signal: controller.signal }, "stream");
        stream.push({ type: "turn", turn });
        return turn;
      } finally {
        untap();
      }
    }, controller.signal);
    void settled.then(
      () => stream.end(),
      (error: unknown) => {
        if (error === left) stream.end();
        else stream.fail(error);
      },
    );
    void settled.then(noop, noop).finally(() => outer?.removeEventListener("abort", forward));
    return stream;
  }

  /** The body of one turn — runs inside the FIFO (`prompt()` queues it directly, `stream()` under
   *  its tap). `options.signal` is the per-call signal; `stream()` hands in its own combined one.
   *  `entry` is the public method the caller used, so a refused per-turn option names it. */
  async #promptTurn(
    content: string | ContentBlock[],
    options: AcpAgentPromptOptions,
    entry: "prompt" | "stream",
  ): Promise<AcpAgentTurn> {
    await this.#ensureOpen();
    options.signal?.throwIfAborted();
    this.#signal?.throwIfAborted();
    const handle = this.#handle!;
    const plan = this.#plan!;
    const backend = this.#backend;
    const label = this.label;

    // Every per-turn option is validated up front — a rejected turn sends nothing, not even the
    // options that would have passed.
    const { modelSwitch, schemaRetries } = validateArguments(() => {
      validatePromptImages(options.images, label);
      assertPerTurnSchemaAllowed(backend, options.schema, label);
      assertNoModelConfigOption(options.configOptions, label);
      assertKnownConfigOptionIds(options.configOptions, handle.advertisedConfigOptions, this.backendId, label);
      return {
        modelSwitch:
          options.model === undefined
            ? undefined
            : resolveModelSwitch(options.model, backend, this.#registry, label, `AcpAgent.${entry}({ model })`),
        schemaRetries:
          options.schemaRetries === undefined
            ? this.#schemaRetries
            : validateSchemaRetries(options.schemaRetries, label, `AcpAgent.${entry}({ schemaRetries })`),
      };
    });
    try {
      // The open's order, verbatim: model, config options, mode.
      if (modelSwitch) {
        await this.#applyModelSwitch(handle, modelSwitch);
        options.signal?.throwIfAborted();
        this.#signal?.throwIfAborted();
      }
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

    let attempt = await this.#runTurn(turnContent, promptMeta, turnSchema, options.signal);
    if (turnSchema === undefined) {
      if (attempt.failure) throw agentTurnError(attempt.failure, attempt.turn, this.#errorContext());
      return attempt.turn;
    }
    // The opt-in repair ladder (`schemaRetries`, default 0): re-prompt the SAME session with the
    // runner's repair prompt — the StructuredOutput-tool variant when the tool is active, else
    // the JSON one, plus the attempt's validation failure — and the same turn `_meta`, so the
    // native channel stays authoritative (Codex's per-turn `outputSchema` rides the repair too).
    // Text only, like the runner's repair turns: no images, no re-embedded contract. Only an
    // `end_turn` miss is repaired — a cancelled, refused, or truncated attempt (or a walled one)
    // ends the ladder where it stands; a per-call or agent abort between attempts rejects.
    let attempts = 1;
    while (
      attempts <= schemaRetries &&
      attempt.failure === undefined &&
      attempt.turn.structured === undefined &&
      attempt.turn.stopReason === "end_turn"
    ) {
      options.signal?.throwIfAborted();
      this.#signal?.throwIfAborted();
      const repair = repairPromptText({ toolActive: plan.toolActive, reason: attempt.turn.structuredError });
      attempt = await this.#runTurn(repair, promptMeta, turnSchema, options.signal);
      attempts += 1;
    }
    const turn: AcpAgentTurn = { ...attempt.turn, structuredAttempts: attempts };
    if (attempt.failure) throw agentTurnError(attempt.failure, turn, this.#errorContext());
    return turn;
  }

  /** ONE `session/prompt` on the wire and its fold: the collector's tap is attached synchronously
   *  before the call, the turn is the agent's active turn for `cancel()`/`steer()`/tool
   *  correlation while it flies, an abort observed in flight rejects with the reason (never a
   *  resolved `cancelled` turn), and the turn's tokens are added to the session sum whether or
   *  not it was walled. `#promptTurn` runs it once, plus once per repair. */
  async #runTurn(
    content: string | ContentBlock[],
    promptMeta: Record<string, unknown> | undefined,
    schema: TSchema | undefined,
    callSignal: AbortSignal | undefined,
  ): Promise<{ turn: AcpAgentTurn; failure?: TypedSessionFailure }> {
    const handle = this.#handle!;
    const plan = this.#plan!;
    // SYNCHRONOUSLY before the wire call: the collector's tap sees every update of the turn, and
    // the transcript marks the turn boundary exactly where the handle's accumulator does
    // (`SessionState.beginTurn()` inside `promptOutcome`) — nothing can interleave.
    const collector = new TurnCollector(this.#bus, handle, { retainHistory: this.#retainHistory });
    this.#transcript.beginTurn(this.#retainHistory);
    // A capture left by a turn that rejected (wire error/abort) must not leak into this turn.
    plan.registration?.takeCaptured();

    const outcome = handle.promptOutcome(content, promptMeta);
    const active: ActiveTurn = { ended: outcome.then(noop, noop), aborted: false };
    this.#activeTurn = active;
    this.#activeCollector = collector;
    const onCallAbort = (): void => {
      active.aborted = true;
      active.abortReason = callSignal?.reason;
      void this.#cancelTurn(callSignal?.reason).catch(noop);
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
      if (this.#activeCollector === collector) this.#activeCollector = undefined;
    }
    // An abort observed in flight rejects with the reason even when the agent answered
    // `stopReason: "cancelled"` — abort is never a resolved turn.
    if (active.aborted) throw active.abortReason;
    if (this.#signal?.aborted) throw this.#signal.reason;

    const turn = buildTurn({
      response,
      collector,
      handle,
      backend: this.#backend,
      schema,
      captured: plan.registration?.takeCaptured(),
      sessionBefore: this.#sessionUsage,
    });
    // A walled turn still counts the tokens it burned.
    this.#sessionUsage = turn.usage.session;
    return failure ? { turn, failure } : { turn };
  }

  /** Inject content into the turn in flight (`_session/steering`). Overlaps the FIFO; requires a
   *  `prompt()` in flight (INVALID_ARGUMENT otherwise). The complete raw response is returned. */
  async steer(content: string | ContentBlock[], options: AcpAgentSteerOptions = {}): Promise<SteeringResponse> {
    this.#signal?.throwIfAborted();
    if (this.#closed) throw this.#closedError();
    const handle = this.#handle;
    if (!this.#activeTurn || !handle) {
      throw agentValidationError("AcpAgent.steer() requires a prompt() in flight", this.label);
    }
    validateArguments(() => validatePromptImages(options.images, this.label));
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
   *  reached the wire yet — the lazy first open, or its per-turn `model`/`configOptions`/`mode` —
   *  a `cancel()` in that window is a no-op the turn never sees. A per-call `signal` covers every
   *  window (rejects with the reason before anything is sent; `session/cancel` once in flight). */
  cancel(): Promise<void> {
    return this.#cancelTurn(new Error("AcpAgent.cancel(): the turn was cancelled"));
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
      const route = validateArguments(() => {
        validateAgentCwd(cwd, this.label, "AcpAgent.fork");
        if (trait.cwd === "source-only" && cwd !== this.cwd) {
          throw agentValidationError(`fork on ${this.backendId} must keep the source cwd (${this.cwd})`, this.label);
        }
        let route: ModelRoute | undefined;
        if (overrides.model !== undefined) {
          route = resolveSameBackendModel(overrides.model, this.#backend, this.#registry, this.label, "AcpAgent.fork()");
        }
        assertNoModelConfigOption(merged.configOptions, label);
        // The backend is fixed by the parent, so an inherited value already passed; an override
        // is validated here, before the child's process spawns.
        assertSystemPromptSupported(this.#backend, merged.systemPrompt, label);
        return route;
      });
      const child = AcpAgent.#seeded(merged, {
        kind: "fork",
        sourceSessionId: handle.sessionId,
        // The parent's snapshot seeds the child: reattach without a replay (load is the fallback).
        reattach: "resume",
        registry: this.#registry,
        backend: route?.backend ?? freshBackendFor(this.#backend, this.#registry),
        // The model the parent is on NOW (a `setModel` / per-turn switch included), not its
        // constructor option — `merged.model` is never read for a seeded child.
        modelSpec: route ? route.modelSpec : this.#modelSpec,
        historySeed: this.history.map((entry) => ({ ...entry })),
        textSeed: this.text,
        messagesSeed: [...this.messages],
      });
      return AcpAgent.#opened(child);
    });
  }

  /**
   * Switch the session's model (queued, FIFO like `setMode`; sticky). `spec` is resolved with the
   * fork rule — the runner's routing grammar, and it must land on this agent's backend and poolKey
   * (`"<backendId>/<model id>"`; an unrouted spec goes to the default backend and passes only when
   * that is this one) — otherwise INVALID_ARGUMENT naming both backends. The route is checked
   * BEFORE the operation is queued, so a refused spec sends nothing and, on an agent that has not
   * opened yet, spawns nothing (the agent stays `idle`). A backend-only spec is INVALID_ARGUMENT
   * too: there is no wire form for "unselect". Applied exactly like open's selection —
   * `session/set_config_option { configId: "model" }` with the routed remainder verbatim; no
   * aliases, coercion, catalog matching, or fallback; the agent's catalog and validation are
   * authoritative and a wire rejection maps through the normal error path with `model` unchanged.
   * On success `model` becomes the routed spec, so later forks and a cold reopen passing
   * `agent.model` back inherit the switch. `"model"` stays reserved in `configOptions`; this is
   * the one way to move it after open.
   */
  setModel(spec: string): Promise<void> {
    let modelSwitch: { modelSpec: string; model: string };
    try {
      modelSwitch = validateArguments(() =>
        resolveModelSwitch(spec, this.#backend, this.#registry, this.label, "AcpAgent.setModel()"),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(async () => {
      await this.#ensureOpen();
      this.#signal?.throwIfAborted();
      try {
        await this.#applyModelSwitch(this.#handle!, modelSwitch);
      } catch (error) {
        throw mapAgentError(error, this.#errorContext(), this.#signal);
      }
    });
  }

  /** `session/set_mode` (queued; strict — an unadvertised id is INVALID_ARGUMENT). */
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
      validateArguments(() => {
        assertNoModelConfigOption(options, this.label);
        assertKnownConfigOptionIds(options, handle.advertisedConfigOptions, this.backendId, this.label);
      });
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
   * releases the structured-output tool, and closes the function-tool host (aborting any running
   * `execute`). Idempotent (same promise); never throws for an already-dead process; rethrows
   * only a `child_cleanup_error` (mapped, non-recoverable).
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
      policy: options.permissions ?? {},
      permissionResolver: options.onPermissionRequest,
      enforceToolPolicyBeforePermissionResolver: false,
      elicitationResolver: options.onElicitation,
      // The agent owns abort (it sends the cancel and the escalation itself); never the handle.
      signal: undefined,
      mcpServers: plan.mcpServers,
      meta: this.#layeredMeta(),
      label: this.label,
      systemPrompt: options.systemPrompt,
      retainSessionLog: this.#retainHistory,
    };
  }

  /** After initialize (the capabilities are known): the structured-output injection, then the
   *  function-tool injection appended to the same `mcpServers` — or the INVALID_ARGUMENT refusal
   *  when the agent does not advertise HTTP MCP for the tools it was given. */
  async #planSession(connection: PooledConnection): Promise<StructuredPlan> {
    const structured = await planStructured(
      {
        schema: this.#schema,
        backend: this.#backend,
        mcpServers: this.#options.mcpServers,
        host: () => (this.#structuredHost ??= new StructuredOutputToolHost()),
      },
      connection,
    );
    const mcpServers = await planTools(
      {
        tools: this.#tools,
        backendId: this.backendId,
        label: this.label,
        mcpServers: structured.mcpServers,
        host: () => (this.#toolHost ??= new AgentToolHost(this.#tools, () => this.#toolContext())),
      },
      connection,
    );
    return { ...structured, mcpServers };
  }

  #toolContext(): AgentToolHostContext {
    return {
      sessionId: this.#sessionId,
      backendId: this.backendId,
      label: this.label,
      resolveToolCallId: (toolName) => this.#resolveToolCallId(toolName),
    };
  }

  /** Best-effort: the latest unsettled `tool_call` of the turn in flight whose standard `name`
   *  (or `title`) is the tool's name or ends in `__<name>` (pi's `mcp__agent_tools__<name>`). */
  #resolveToolCallId(toolName: string): string | undefined {
    const calls = this.#activeCollector?.toolCalls ?? [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index]!;
      if (call.status === "completed" || call.status === "failed") continue;
      const names = [call.name, call.title].filter((value): value is string => typeof value === "string");
      if (names.some((name) => name === toolName || name.endsWith(`__${toolName}`))) return call.toolCallId;
    }
    return undefined;
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
          plan = await this.#planSession(ready);
          return this.#sessionOptions(plan);
        });
      } else {
        // The cheapest "await initialize": the injection decision needs the capabilities.
        await connection.authMethods();
        plan = await this.#planSession(connection);
        const opts = this.#sessionOptions(plan);
        if (seed.kind === "fork") {
          const trait = forkTraitFor(this.#backend, this.#registry);
          const acquired = await acquireForkedSession(connection, seed.sourceSessionId, opts, trait, seed.reattach);
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
      // The transcript follows the handle's accumulator: a replay the registered session applied
      // (`session/load`, the id-only fork's load fallback) is folded from the adopted records; a
      // pre-response fork replay was never applied there and stays in `replay` alone. Live from
      // here on — synchronously, so no later update can slip between the two.
      if (replayed) {
        for (const { update, receivedAt } of this.#replay) this.#transcript.apply(structuredClone(update), receivedAt);
      }
      this.#transcriptLive = true;
      this.#signal?.throwIfAborted();
      await this.#applyPostOpen(handle);
      if (seed.kind === "fork") this.#seedHistory(seed, handle);
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

  /** The one mechanism behind every model selection after open (`setModel`, a per-turn `model`):
   *  `SessionHandle.selectModel` — the same call open makes — then `model` moves to the routed
   *  spec. Nothing moves when the wire rejects. */
  async #applyModelSwitch(handle: SessionHandle, next: { modelSpec: string; model: string }): Promise<void> {
    await handle.selectModel(next.modelSpec);
    this.#modelSpec = next.modelSpec;
    this.#model = next.model;
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

  /** Seed a live fork's history/text/messages from the parent's snapshot — only when the child's
   *  own accumulator is empty (a `session/load` reattach already replayed the transcript). The
   *  cold static carries no seed: its transcript is the load replay, or empty after a resume. */
  #seedHistory(seed: Extract<AcpAgentSeed, { kind: "fork" }>, handle: SessionHandle): void {
    if (!seed.historySeed || handle.history.length > 0) return;
    this.#historySeed = seed.historySeed;
    this.#textSeed = seed.textSeed ?? "";
    this.#messagesSeed = seed.messagesSeed ?? [];
  }

  /** `reason` is what a running function tool's `ctx.signal` aborts with. */
  #cancelTurn(reason?: unknown): Promise<void> {
    const active = this.#activeTurn;
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!active || !connection || sessionId === undefined) return Promise.resolve();
    // A function tool running for this turn stops with it.
    this.#toolHost?.abortInFlight(reason);
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
    this.#toolHost?.abortInFlight(reason);
    void this.#cancelTurn(reason).catch(noop);
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
    const toolHost = this.#toolHost;
    let cleanupError: unknown;
    try {
      if (handle) await handle.release({ keepOpen: keep });
    } catch (error) {
      if (isChildCleanupError(error)) cleanupError = error;
    }
    plan?.registration?.release();
    // The process BEFORE the tool hosts (the runner's order: pool, then tools): the agent process
    // holds keep-alive sockets to the hosts' HTTP servers, and `server.close()` waits for idle
    // sockets to time out (seconds) unless the peer is gone first.
    if (connection) {
      await connection.dispose().catch(noop);
      releaseOnExit(connection);
    }
    if (host) await host.dispose().catch(noop);
    if (toolHost) await toolHost.dispose().catch(noop);
    this.#removeAbort?.();
    this.#removeAbort = undefined;
    // Last, so the agent's own `session_close` (emitted by the release above) was delivered.
    this.#bus.close();
    if (cleanupError) throw mapAgentError(cleanupError, this.#errorContext());
  }
}
