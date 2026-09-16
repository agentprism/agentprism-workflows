// Public option / result / event types of the AcpAgent SDK (src/agent/). No runtime code lives
// here beyond `ZERO_USAGE`; the class itself is in acp-agent.ts and the internal seed type that
// statics hand to the constructor is module-private there (never part of this surface).
import type {
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";
import type {
  AgentHistoryEntry,
  AgentUsage,
  McpServerConfig,
  PromptImage,
  WorkflowError,
} from "@automatalabs/shared-types";
import type { TSchema } from "typebox";
import type { AuthStore } from "../auth/auth-store.js";
import type { ClientHandlers } from "../client-handlers.js";
import type { HarnessConfigReport, HarnessModelsView } from "../config-catalog.js";
import type {
  AcpElicitationEvent,
  AcpPermissionEvent,
  AcpRunnerEventMap,
  AcpSessionUpdate,
} from "../events.js";
import type { ElicitationResolver, PermissionResolver, ToolPolicy } from "../permissions.js";
import type { ProviderStore } from "../provider-store.js";
import type { CustomBackendConfig } from "../registry.js";

// Re-exported for callers that only import the SDK types.
export type { SessionConfigOption, SessionModeState };

export interface AcpAgentOptions {
  /** ABSOLUTE path that exists and is a directory. Validated synchronously in the constructor and
   *  the statics BEFORE any process spawns (SCRIPT_VALIDATION_ERROR otherwise). Sent as the
   *  session/new|fork|resume|load `cwd`. */
  cwd: string;
  /** Model routing spec with the runner's grammar (`resolveModelRoute`): the first `/`-segment
   *  routes to a registered custom backend (wins) or a built-in; the remainder is the backend's
   *  model id VERBATIM and is sent as `session/set_config_option { configId: "model" }` right after
   *  the session opens. An unrouted spec (no known first segment) goes WHOLE to the default backend
   *  (`AGENTPRISM_DEFAULT_BACKEND`, else `claude`). Omitted = default backend, no model selection. */
  model?: string;
  /** Session mode. Explicit ids are strict (unadvertised → SCRIPT_VALIDATION_ERROR at open).
   *  Omitted = the backend's `defaultModeId` when advertised (claude `auto`, codex `agent`,
   *  opencode `build`; pi/custom none). */
  mode?: string;
  /** Applied verbatim via `session/set_config_option` in ascending option-id order after model
   *  selection. `"model"` is reserved (SCRIPT_VALIDATION_ERROR in the constructor). Ids not in the
   *  advertised catalog fail at open with SCRIPT_VALIDATION_ERROR listing the advertised ids. */
  configOptions?: Record<string, string | boolean>;
  /** Session-level structured-output contract (typebox). Claude: `_meta.claudeCode.options.outputFormat`
   *  at session/new|resume|load|fork; Codex: `_meta.outputSchema` on every turn; OpenCode/pi/custom:
   *  the client-hosted `StructuredOutput` HTTP MCP tool injected into `mcpServers` when the agent
   *  advertises `mcpCapabilities.http`, plus the in-prompt contract. Each turn reports
   *  `structured` / `structuredError`; there is no repair ladder. */
  schema?: TSchema;
  /** Client-provided MCP servers (stdio/http/sse/acp). Capability-gated by the connection exactly
   *  like the runner. */
  mcpServers?: McpServerConfig[];
  /** Headless permission auto-policy: allow/deny lists + `defaultOutcome` (default "allow"). */
  tools?: ToolPolicy;
  /** Session-scoped async permission resolver; wins over `tools` unless the request matches an
   *  explicit list (same precedence as the runner: resolver > policy). */
  onPermissionRequest?: PermissionResolver;
  /** Elicitation responder; its presence is what advertises `elicitation` at initialize. */
  onElicitation?: ElicitationResolver;
  /** Generic session/new `_meta` passthrough. Layered UNDER backend-computed keys (shallow, like
   *  the runner) and, when `raw !== false`, OVER `backend.rawMessagesMeta()`. */
  meta?: Record<string, unknown>;
  /** Codex-only session instructions → bare `_meta.baseInstructions` / `_meta.developerInstructions`. */
  instructions?: { base?: string; developer?: string };
  /** Human label stamped on every event context and every WorkflowError `agentLabel`; never on
   *  the wire. */
  label?: string;
  /** Custom backend registry merged over `AGENTPRISM_BACKENDS` exactly like
   *  `createAcpRunner({ backends })`. Read once in the constructor; malformed →
   *  SCRIPT_VALIDATION_ERROR. Forks inherit it and cannot override it. */
  backends?: Record<string, CustomBackendConfig>;
  /** Agent-lifetime abort: rejects queued work with `signal.reason`, cancels an in-flight turn,
   *  then closes. Not inherited by forks. */
  signal?: AbortSignal;
  /** Default true: the session log is retained across turns so `history`/`text` are cumulative
   *  and a fork can seed its child. `false` maps to `retainSessionLog: false` (history/text hold
   *  only the latest turn). */
  retainHistory?: boolean;
  /** Default true: ask the backend to emit its vendor notifications (`_claude/sdkMessage` on
   *  Claude) so they reach `on("raw_message")` and `turn.raw`. `false` skips
   *  `backend.rawMessagesMeta()` (a schema still turns raw messages on for Claude because the
   *  schema channel needs them). */
  raw?: boolean;
  /** Optional shared auth store (default off = each agent's own login). Forks share the parent's. */
  authStore?: AuthStore;
  /** Optional shared provider-intent store. Forks share the parent's. */
  providerStore?: ProviderStore;
  /** Client-side fs/terminal/mcp handlers advertised at initialize (validated with
   *  `validateClientHandlers`). */
  clientHandlers?: ClientHandlers;
}

export interface AcpAgentPromptOptions {
  /** Appended as image content blocks (validated with `validatePromptImages`; string prompts
   *  become `[text, ...images]`). */
  images?: readonly PromptImage[];
  /** Turn `_meta` passthrough, merged UNDER the backend's turn meta (backend keys win direct
   *  collisions, exactly like the runner's `mergeTurnMeta`). */
  meta?: Record<string, unknown>;
  /** Applied via `session/set_config_option` BEFORE this turn, inside the FIFO; STICKY for the
   *  session. Same validation as the constructor option. */
  configOptions?: Record<string, string | boolean>;
  /** Applied via `session/set_mode` before this turn, inside the FIFO; sticky; strict. */
  mode?: string;
  /** Per-turn schema override. Allowed ONLY when the backend carries the schema on the turn and
   *  does not embed it in the prompt (today: Codex). Otherwise SCRIPT_VALIDATION_ERROR naming the
   *  backend and pointing at the constructor `schema` option. */
  schema?: TSchema;
  /** Per-call abort: queued → rejects without sending; in flight → `session/cancel`, then rejects
   *  with the reason. */
  signal?: AbortSignal;
}

export interface AcpAgentSteerOptions {
  images?: readonly PromptImage[];
  meta?: Record<string, unknown>;
}

export interface AcpAgentCloseOptions {
  /** true = skip `session/close` so the agent-persisted session stays re-openable via
   *  `AcpAgent.resume/load/fork(ref)`. The dedicated process is disposed either way. */
  keep?: boolean;
}

/** Everything a fork may override. The backend is fixed by the parent: a `model` override must
 *  route to the same backend (poolKey-equal) or SCRIPT_VALIDATION_ERROR. `backends`, `authStore`,
 *  `providerStore`, `clientHandlers` are inherited and not overridable. `label` defaults to
 *  `<parent label>/fork-<n>` (or `fork-<n>`); `signal` is never inherited. `cwd` defaults to the
 *  parent's; a different cwd is rejected on `cwd: "source-only"` backends (`FORK_SESSION_TRAITS`). */
export type AcpAgentForkOptions = Partial<
  Omit<AcpAgentOptions, "backends" | "authStore" | "providerStore" | "clientHandlers">
>;

/** Options for the cold statics. `cwd` defaults to `ref.cwd`; `model` must route to `ref.backendId`. */
export type AcpAgentReopenOptions = Partial<AcpAgentOptions>;

export interface AcpAgentProbeOptions {
  /** One exact routed spec (`modelSpecs: [model]`): selected before the catalog is read. */
  model?: string;
  /** More exact specs. */
  models?: string[];
  /** Backend-only targets. Default (no `harnesses`, no model specs): every built-in plus every
   *  registered custom backend. */
  harnesses?: string[];
  /** Substring or `/regex/` over leaf model ids → `catalog.models[*].matches`. */
  modelFilter?: string;
  backends?: Record<string, CustomBackendConfig>;
  cwd?: string;
  probeTimeoutMs?: number;
  probeConcurrency?: number;
  signal?: AbortSignal;
}

export type AcpAgentCatalog = HarnessConfigReport & { models: HarnessModelsView[] };

export interface AcpAgentUpdateRecord {
  readonly update: AcpSessionUpdate;
  readonly receivedAt: number;
}

export interface AcpAgentRawRecord {
  readonly method: string;
  readonly message: unknown;
  readonly receivedAt: number;
}

export interface AcpAgentToolCall {
  readonly toolCallId: string;
  /** SDK UNSTABLE `ToolCall.name` / `ToolCallUpdate.name`, verbatim. */
  readonly name?: string;
  readonly title: string;
  readonly kind?: ToolKind;
  /** Last seen; "pending" when the agent sent none. */
  readonly status: ToolCallStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: ToolCallContent[];
  readonly locations?: ToolCallLocation[];
  /** Shallow merge of every `_meta` seen for this id. */
  readonly meta?: Record<string, unknown>;
}

export interface AcpAgentTurnUsage {
  /** THIS turn's tokens: `response.usage` mapped to `AgentUsage` (every installed adapter reports
   *  the turn, not the session — `PROMPT_USAGE_SCOPES`); `cost` = the clamped delta of the
   *  cumulative `usage_update` cost gauge across the turn. When the response carries no `usage`,
   *  tokens fall back to the context-token gauge delta exactly like `UsageAccumulator.delta()`. */
  readonly turn: AgentUsage;
  /** Running per-field sum of every turn THIS AcpAgent ran (`cost` = the latest gauge value),
   *  including this one. Starts at zero at open/fork/resume/load — replayed history and the
   *  parent's turns are not counted. */
  readonly session: AgentUsage;
  /** `response.usage` verbatim. */
  readonly response?: Usage;
}

export interface AcpAgentTurn {
  /** The wire object, `_meta` intact (no SDK response mapping on session/prompt). */
  readonly response: PromptResponse;
  /** `= response.stopReason`; NEVER thrown on (refusal/max_tokens/cancelled included). */
  readonly stopReason: StopReason;
  /** This turn's assistant messages joined by "\n\n" (`SessionHandle.foldedTurnText()`). */
  readonly text: string;
  /** Every session/update of this turn, structuredClone'd (verbatim objects, `_meta` intact). */
  readonly updates: ReadonlyArray<AcpAgentUpdateRecord>;
  /** Every `raw_message` of this turn (Claude `_claude/sdkMessage`). */
  readonly raw: ReadonlyArray<AcpAgentRawRecord>;
  /** tool_call ⊕ tool_call_update folded by toolCallId, first-seen order. */
  readonly toolCalls: ReadonlyArray<AcpAgentToolCall>;
  readonly permissions: ReadonlyArray<AcpPermissionEvent>;
  readonly elicitations: ReadonlyArray<AcpElicitationEvent>;
  readonly usage: AcpAgentTurnUsage;
  /** Validated (typebox Convert + Check) when a schema was active for the turn. */
  readonly structured?: unknown;
  /** Why `structured` is absent although a schema was active. */
  readonly structuredError?: string;
  /** This turn's accumulator entries (copies). */
  readonly history: readonly AgentHistoryEntry[];
}

/** A `prompt()` rejection for a turn the agent walled with a typed session failure (codex-acp's
 *  negotiated extension): the runner's mapped `WorkflowError` (`mapTypedSessionFailure`, so codes,
 *  `recoverable` and `details` keep their tested contract) carrying the COMPLETE turn — verbatim
 *  `response` incl. `_meta`, `usage`, `updates`, `raw`, `toolCalls`, `history` — so nothing is
 *  stripped. Narrow with `isAcpAgentTurnError`. */
export type AcpAgentTurnError = WorkflowError & { readonly turn: AcpAgentTurn };

/** Same keys/payloads as the runner bus (no new cross-cutting names); turn boundaries are the
 *  `prompt()` promise. */
export type AcpAgentEventMap = AcpRunnerEventMap;
export type AcpAgentEventName = keyof AcpAgentEventMap;
export type AcpAgentEventListener<K extends AcpAgentEventName> = (event: AcpAgentEventMap[K]) => void;

/** `idle` (constructed, nothing spawned) → `opening` → `ready` ⇄ `busy` (a queued op is executing)
 *  → `closed` (set the instant `close()` is called, the constructor signal aborts, or the process
 *  dies). */
export type AcpAgentState = "idle" | "opening" | "ready" | "busy" | "closed";

/** The all-zero `AgentUsage` every agent starts from (frozen; never mutated in place). */
export const ZERO_USAGE: AgentUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
});
