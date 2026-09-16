// Public option / result / event types of the AcpAgent SDK (src/agent/). No runtime code lives
// here beyond `ZERO_USAGE`; the class itself is in acp-agent.ts and the internal seed type that
// statics hand to the constructor is module-private there (never part of this surface).
import type {
  ContentBlock,
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
  SystemPromptOptions,
  WorkflowError,
} from "@automatalabs/shared-types";
import type { ContentBlock as McpContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Static, TSchema } from "typebox";
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

/** What a function tool's `execute` receives next to its validated input. */
export interface AcpAgentToolContext {
  /** The ACP session id of the agent that called the tool. */
  readonly sessionId: string;
  /** The agent's resolved backend id. */
  readonly backendId: string;
  /** The agent's `label`, when set. */
  readonly label?: string;
  /** The ACP `tool_call` id the backend surfaced for this call, when the SDK could correlate it:
   *  the latest not-yet-settled `tool_call` of the turn in flight whose standard `name` (or
   *  `title`) is the tool's name or ends in `__<name>` (pi's `mcp__agent_tools__<name>` alias).
   *  Best-effort — undefined when the backend surfaced none before calling. */
  readonly toolCallId?: string;
  /** Aborts when the agent's constructor `signal` fires, when the turn in flight is cancelled
   *  (`cancel()`, a per-call `signal`, an early `stream()` exit), when the agent closes or its
   *  process dies, and when the backend drops the HTTP request before the result was written. */
  readonly signal: AbortSignal;
}

/** What `execute` may return: a string (one text block), MCP content blocks, or a complete
 *  `{ content, isError? }` result — `isError: true` is passed through to the agent as-is. The
 *  blocks are MCP's `ContentBlock` (`@modelcontextprotocol/sdk/types.js`: `text`, `image`,
 *  `audio`, `resource_link`, `resource`) — the `tools/call` result shape the agent receives on the
 *  wire — and NOT the ACP `ContentBlock` every other content on the AcpAgent surface uses
 *  (`prompt()` input, `AcpAgentMessage.content`, the update events). A `{ type: "text", text }`
 *  block is valid in both. */
export type AcpAgentToolResult =
  | string
  | McpContentBlock[]
  | { readonly content: McpContentBlock[]; readonly isError?: boolean };

/**
 * One client-side function tool (`AcpAgentOptions.tools`). The SDK serves it to the agent as an
 * MCP tool on the per-agent local tool host (`agent_tools`): `name` and `description` are
 * advertised verbatim, `inputSchema` (typebox, like the `schema` option) is advertised as its
 * JSON Schema, and every `tools/call` is validated against it (typebox Convert + Check) before
 * `execute` runs with the converted input. A validation failure or a thrown `execute` is returned
 * to the agent as an `isError: true` result carrying the message, never a transport error. Use
 * `defineTool()` to infer the input type from the schema.
 */
export interface AcpAgentToolDefinition<TInput extends TSchema = TSchema> {
  /** `^[A-Za-z0-9_-]{1,64}$`, unique across the agent's tools (INVALID_ARGUMENT in the constructor). */
  name: string;
  description: string;
  /** A typebox OBJECT schema (`Type.Object(...)`, JSON `type: "object"`): MCP `tools/call`
   *  arguments are an object, so any other top-level type is INVALID_ARGUMENT in the constructor. */
  inputSchema: TInput;
  execute(input: Static<TInput>, ctx: AcpAgentToolContext): Promise<AcpAgentToolResult> | AcpAgentToolResult;
}

export interface AcpAgentOptions {
  /** ABSOLUTE path that exists and is a directory. Validated synchronously in the constructor and
   *  the statics BEFORE any process spawns (INVALID_ARGUMENT otherwise). Sent as the
   *  session/new|fork|resume|load `cwd`. */
  cwd: string;
  /** Model routing spec with the runner's grammar (`resolveModelRoute`): the first `/`-segment
   *  routes to a registered custom backend (wins) or a built-in; the remainder is the backend's
   *  model id VERBATIM and is sent as `session/set_config_option { configId: "model" }` right after
   *  the session opens. An unrouted spec (no known first segment) goes WHOLE to the default backend
   *  (`AGENTPRISM_DEFAULT_BACKEND`, else `claude`). Omitted = default backend, no model selection.
   *  This is the model the agent STARTS on: `agent.setModel(spec)` and a per-turn
   *  `prompt(…, { model })` switch it mid-session (same backend only); `agent.model` follows. */
  model?: string;
  /** Session mode. Explicit ids are strict (unadvertised → INVALID_ARGUMENT at open).
   *  Omitted = the backend's `defaultModeId` when advertised (claude `auto`, codex `agent`,
   *  opencode `build`; pi/custom none). */
  mode?: string;
  /** Applied verbatim via `session/set_config_option` in ascending option-id order after model
   *  selection. `"model"` is reserved (INVALID_ARGUMENT in the constructor). Ids not in the
   *  advertised catalog fail at open with INVALID_ARGUMENT listing the advertised ids. */
  configOptions?: Record<string, string | boolean>;
  /** Session-level structured-output contract (typebox). Claude: `_meta.claudeCode.options.outputFormat`
   *  at session/new|resume|load|fork; Codex: `_meta.outputSchema` on every turn; OpenCode/pi/custom:
   *  the client-hosted `StructuredOutput` HTTP MCP tool injected into `mcpServers` when the agent
   *  advertises `mcpCapabilities.http`, plus the in-prompt contract. Each turn reports
   *  `structured` / `structuredError`; a repair ladder runs only when `schemaRetries` asks for one. */
  schema?: TSchema;
  /** Opt-in structured repair ladder: how many EXTRA turns `prompt()` may spend re-prompting the
   *  same session when a schema is active and the turn ended (`end_turn`) with `structured` absent
   *  — an integer ≥ 0 (INVALID_ARGUMENT otherwise), default 0 = exactly one turn per `prompt()`.
   *  A repair turn sends the runner's repair prompt (`repairPromptText`: the StructuredOutput-tool
   *  variant when the tool is active, else the JSON variant, with the previous attempt's
   *  `structuredError` appended) with the same turn `_meta`; the native channel (Claude session
   *  `outputFormat`, Codex per-turn `outputSchema`, the client-hosted tool) stays authoritative.
   *  Every repair turn is a real turn: events fire, `stream()` yields them, `usage` accumulates.
   *  The resolved `AcpAgentTurn` is the FINAL attempt's plus `structuredAttempts`. A turn that ended
   *  `cancelled` / `refusal` / `max_tokens` / `max_turn_requests` is never repaired. Overridable
   *  per turn (`AcpAgentPromptOptions.schemaRetries`); inherited by forks. */
  schemaRetries?: number;
  /** Client-provided MCP servers (stdio/http/sse/acp). Capability-gated by the connection exactly
   *  like the runner. */
  mcpServers?: McpServerConfig[];
  /** Client-side function tools, served to the agent over HTTP MCP from a per-agent local host
   *  injected into `mcpServers` as `agent_tools` (`agent_tools_2`, … when a caller's server holds
   *  the name) on `session/new|resume|load|fork` and an id-only fork's reattach. Names are
   *  validated in the constructor (INVALID_ARGUMENT before any spawn); an agent that does not
   *  advertise `mcpCapabilities.http` fails the open with INVALID_ARGUMENT — tools are never
   *  silently dropped. Inherited by forks (each runs its own host); the host closes with the
   *  agent. An empty array is the same as omitting the option. */
  tools?: AcpAgentToolDefinition[];
  /** Headless permission auto-policy: allow/deny lists + `defaultOutcome` (default "allow").
   *  Consulted only when no `onPermissionRequest` resolver is installed. */
  permissions?: ToolPolicy;
  /** Session-scoped async permission resolver. When present it answers EVERY permission request
   *  (the runner's default precedence); `permissions` is the headless fallback without one. */
  onPermissionRequest?: PermissionResolver;
  /** Elicitation responder; its presence is what advertises `elicitation` at initialize. */
  onElicitation?: ElicitationResolver;
  /** Generic session/new `_meta` passthrough. Layered UNDER backend-computed keys (shallow, like
   *  the runner) and, when `raw !== false`, OVER `backend.rawMessagesMeta()`. */
  meta?: Record<string, unknown>;
  /** Backend-neutral system prompt instructions: `replace` swaps the backend's built-in system
   *  prompt, `append` adds to it. Validated in the constructor (and `fork()` / the statics) against
   *  the routed backend's `Backend.systemPrompt` support BEFORE any process spawns — a field the
   *  backend cannot carry is INVALID_ARGUMENT, never a silent no-op (Codex and Claude and pi
   *  carry both; OpenCode and custom backends carry neither). Sent on `session/new|resume|load|fork`
   *  and the reattach of an id-only fork in the backend's dialect: Codex `_meta.baseInstructions`
   *  / `_meta.developerInstructions`, Claude `_meta.systemPrompt` (string, or `{ append }`), pi
   *  `_meta.systemPrompt` `{ replace?, append? }`. Wins over the same key in `meta`. Inherited by
   *  forks (overridable). */
  systemPrompt?: SystemPromptOptions;
  /** Human label stamped on every event context and every WorkflowError `agentLabel`; never on
   *  the wire. */
  label?: string;
  /** Custom backend registry merged over `AGENTPRISM_BACKENDS` exactly like
   *  `createAcpRunner({ backends })`. Read once in the constructor; malformed →
   *  INVALID_ARGUMENT. Forks inherit it and cannot override it. */
  backends?: Record<string, CustomBackendConfig>;
  /** Agent-lifetime abort: rejects queued work with `signal.reason`, cancels an in-flight turn,
   *  then closes. Not inherited by forks. */
  signal?: AbortSignal;
  /** Default true: the session log is retained across turns so `history`/`text`/`messages` are
   *  cumulative and a fork can seed its child. `false` maps to `retainSessionLog: false`
   *  (history/text/messages hold only the latest turn). */
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
  /** Switch the model BEFORE this turn, inside the FIFO (first, ahead of `configOptions` and
   *  `mode` — open's order); STICKY for the session and reflected in `agent.model`. Same
   *  validation as `setModel()`: the fork rule (the spec must route to this agent's backend and
   *  poolKey, `"<backendId>/<model id>"`; a backend-only spec is rejected) → INVALID_ARGUMENT
   *  before anything is sent; then `session/set_config_option { configId: "model" }` with the
   *  routed remainder verbatim, a wire rejection mapping through the normal error path. */
  model?: string;
  /** Applied via `session/set_config_option` BEFORE this turn, inside the FIFO; STICKY for the
   *  session. Same validation as the constructor option. */
  configOptions?: Record<string, string | boolean>;
  /** Applied via `session/set_mode` before this turn, inside the FIFO; sticky; strict. */
  mode?: string;
  /** Per-turn schema override. Allowed ONLY when the backend carries the schema on the turn and
   *  does not embed it in the prompt (today: Codex). Otherwise INVALID_ARGUMENT naming the
   *  backend and pointing at the constructor `schema` option. */
  schema?: TSchema;
  /** Per-turn repair budget (integer ≥ 0; INVALID_ARGUMENT otherwise, before anything is sent);
   *  wins over the constructor's `schemaRetries` for this `prompt()` only. */
  schemaRetries?: number;
  /** Per-call abort: queued, or started but not yet on the wire (the lazy open, the per-turn
   *  `model`/`configOptions`/`mode`) → rejects with the reason without sending; in flight →
   *  `session/cancel`, then rejects with the reason. The one way to stop a turn `cancel()` cannot
   *  reach: `cancel()` targets only a turn whose `session/prompt` is on the wire. */
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
 *  route to the same backend (poolKey-equal) or INVALID_ARGUMENT. `backends`, `authStore`,
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

/**
 * One message of the transcript, folded from the session/update stream (`turn.messages` for a
 * turn, `agent.messages` for the retained log). The assistant-message boundary is EXACTLY the
 * `text` fold's: text chunks concatenate into one message until a `tool_call`, `tool_call_update`,
 * `agent_thought_chunk`, `plan*` or `user_message_chunk` event (or a changed ACP `messageId`)
 * marks a boundary, and the next text chunk opens a new message — so `turn.text` is the
 * text-bearing assistant messages of the turn joined by `"\n\n"`. Tool calls attach to the
 * assistant message in progress (a turn that starts with a tool call has a leading message with
 * no text); thoughts lead and attach to the assistant message that receives the next assistant
 * content (a trailing thought is a message of its own); a run of `user_message_chunk`s is one
 * user message.
 */
export interface AcpAgentMessage {
  readonly role: "user" | "assistant";
  /** The ordered blocks of this message. Consecutive text chunks fold into one text block (the
   *  first chunk's fields, the concatenated text); other blocks are kept as sent. The verbatim
   *  chunks stay in `updates`. */
  readonly content: ContentBlock[];
  /** Assistant only: the tool calls this message issued, folded by `toolCallId` (first-seen
   *  order; a later `tool_call_update` updates the call where it lives). Empty for user messages. */
  readonly toolCalls: readonly AcpAgentToolCall[];
  /** Assistant only: the `agent_thought_chunk` blocks folded into this message, consecutive text
   *  chunks folded like `content`. A thought is held until the next assistant content and attaches
   *  to the message that content lands on: a text chunk (or a non-text block) after a thought
   *  OPENS a new message — a thought is a boundary — and the thought goes with it; a tool call
   *  attaches to the assistant message in progress, which may already hold text, so `text →
   *  thought → tool_call` puts the thought on the message with that text (opening a message when
   *  none is in progress). A thought followed by a user message or by the end of the turn is an
   *  assistant message of its own with no `content`. Empty for user messages. */
  readonly thoughts: ContentBlock[];
  /** The `receivedAt` of the first update folded into this message. */
  readonly receivedAt: number;
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
  /** tool_call ⊕ tool_call_update folded by toolCallId, first-seen order (the flattening of
   *  `messages[*].toolCalls`). */
  readonly toolCalls: ReadonlyArray<AcpAgentToolCall>;
  /** This turn's messages, folded from `updates` (`AcpAgentMessage`): the per-message view of
   *  the same chunks `text` folds, with each message's tool calls and thoughts attached. */
  readonly messages: ReadonlyArray<AcpAgentMessage>;
  readonly permissions: ReadonlyArray<AcpPermissionEvent>;
  readonly elicitations: ReadonlyArray<AcpElicitationEvent>;
  readonly usage: AcpAgentTurnUsage;
  /** Validated (typebox Convert + Check) when a schema was active for the turn. */
  readonly structured?: unknown;
  /** Why `structured` is absent although a schema was active (the LAST attempt's failure when
   *  the repair ladder ran). */
  readonly structuredError?: string;
  /** When a schema was active: the turns this `prompt()` spent — 1 plus the repair turns the
   *  `schemaRetries` ladder actually ran (1 under the default budget of 0). Absent without a schema. */
  readonly structuredAttempts?: number;
  /** This turn's accumulator entries (copies). Per CHUNK, not per message: one `assistant`/`text`
   *  entry per streamed `agent_message_chunk` and one `tool`/`toolCall` entry per `tool_call`, so
   *  `history.length` is not a message count — `text` is the folded, per-message view. */
  readonly history: readonly AgentHistoryEntry[];
}

/** A `prompt()` rejection for a turn the agent walled with a typed session failure (codex-acp's
 *  negotiated extension): the runner's mapped `WorkflowError` (`mapTypedSessionFailure`, so codes,
 *  `recoverable` and `details` keep their tested contract) carrying the COMPLETE turn — verbatim
 *  `response` incl. `_meta`, `usage`, `updates`, `raw`, `toolCalls`, `messages`, `history` — so
 *  nothing is stripped. Narrow with `isAcpAgentTurnError`. */
export type AcpAgentTurnError = WorkflowError & { readonly turn: AcpAgentTurn };

/** Same keys/payloads as the runner bus (no new cross-cutting names); turn boundaries are the
 *  `prompt()` promise. */
export type AcpAgentEventMap = AcpRunnerEventMap;
export type AcpAgentEventName = keyof AcpAgentEventMap;
export type AcpAgentEventListener<K extends AcpAgentEventName> = (event: AcpAgentEventMap[K]) => void;

/** The event names `stream()` yields: every bus event except the `session_update` catch-all (an
 *  update is yielded once, under its `sessionUpdate` kind). */
export type AcpAgentStreamEventName = Exclude<AcpAgentEventName, "session_update">;

/**
 * One item of `agent.stream()`: a bus event of this turn tagged with its name as `type` (the
 * payload is the same object `on(name)` delivers — an ACP update variant plus the event context,
 * or a permission / elicitation / raw_message / steering / session_open / session_close /
 * backend_error payload), or the terminal `{ type: "turn", turn }` carrying the `AcpAgentTurn`
 * `prompt()` would have resolved. Narrow on `type`.
 */
export type AcpAgentStreamEvent =
  | { [K in AcpAgentStreamEventName]: { readonly type: K } & AcpAgentEventMap[K] }[AcpAgentStreamEventName]
  | { readonly type: "turn"; readonly turn: AcpAgentTurn };

/** What `stream()` returns: an async iterable that is its own iterator, with `return()` and
 *  `throw()` always present (leaving early is part of the contract — both cancel the turn and
 *  resolve once it settled; `throw(error)` then rethrows `error`). */
export interface AcpAgentStream extends AsyncIterableIterator<AcpAgentStreamEvent> {
  next(): Promise<IteratorResult<AcpAgentStreamEvent, undefined>>;
  return(): Promise<IteratorResult<AcpAgentStreamEvent, undefined>>;
  throw(error?: unknown): Promise<IteratorResult<AcpAgentStreamEvent, undefined>>;
  [Symbol.asyncIterator](): AcpAgentStream;
}

/** Compile-time guard: the terminal discriminant can never be shadowed by an ACP update kind or a
 *  cross-cutting event name (a collision would make `type: "turn"` ambiguous). */
type AssertNever<T extends never> = T;
type StreamTerminalIsDistinct = AssertNever<Extract<AcpAgentEventName, "turn">>;

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
