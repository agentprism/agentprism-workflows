// ===== packages/shared-types/src/agent-run.ts =====
import type { Static, TSchema } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { WorkflowBackendConfig } from "./workflow-result.js";

/** Real token/cost usage for ONE subagent run. Delivered OUT-OF-BAND via
 *  RunOptions.onUsage — NEVER via run()'s return value. Fires on BOTH the success
 *  AND error paths (agent.ts:441-455) so partial usage is never lost. `total === 0`
 *  is the "provider reported nothing" sentinel -> the engine falls back to a chars/4
 *  estimate (workflow.ts:444). onUsage may NEVER fire at all (ACP usage is
 *  experimental) — every consumer tolerates usage === undefined.
 *
 *  ACP mapping (acp-agents fills this from PromptResponse.usage / usage_update,
 *  types.gen.d.ts:2943/2984, marked UNSTABLE):
 *    input      <- inputTokens          output     <- outputTokens
 *    cacheRead  <- cachedReadTokens ?? 0 cacheWrite <- cachedWriteTokens ?? 0
 *    total      <- totalTokens ?? 0      (0 => engine estimates)
 *    cost       <- Claude: total_cost_usd (USD) ; Codex: 0 (no dollar cost) */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * The opts side of the AgentRunner seam — exactly the bag the engine passes at
 * workflow.ts:465 (cast `as any` there; frozen-typed here). Inputs flow IN
 * (prompt/schema/model/tier/cwd/signal/instructions/tool policy); telemetry flows
 * OUT via the on* callbacks, NEVER via the return value.
 *
 * NAME = RunOptions (the Phase-1 deliverable name); `AgentRunOptions` is exported as
 * a lift-compat alias so ported pi engine code that imports the old name resolves.
 *
 * FIELD NAMES ARE FROZEN: the engine binds these by name through an `as any` cast
 * (workflow.ts:488), so a renamed field would NOT raise a compile error — it would
 * mis-bind at runtime. Engine-passed core fields (13): label, schema, signal, instructions,
 * model, tier, toolNames, disallowedToolNames, cwd, onModelResolved, onModelFallback,
 * onUsage, onHistory. Plus ADDITIVE run inputs that wire infrastructure / shape the backend,
 * NOT the logical call, so none enters the resume identity hash (hashAgentCall): `mcpServers`,
 * `runId`, the generic ACP `_meta` passthroughs `meta` / `promptMeta`, the run-scoped custom
 * backend registry `backends`, and the Codex-only `baseInstructions` / `developerInstructions`.
 * `maxSchemaRetries` is runner-internal (the engine never passes it). Pi's
 * `tools?: ToolDefinition[]` is DROPPED — a pi-coding-agent type with no ACP analog (ACP
 * injects tools via session/new mcpServers, not this field) and never passed by the engine.
 */
export interface RunOptions<S extends TSchema | undefined = undefined> {
  /** Human label for logs/telemetry. NOT part of the resume identity hash. */
  label?: string;
  /** typebox schema. Present => result is Static<schema>; absent => result is text.
   *  KEPT as typebox: it is JSON.stringify'd into the resume hash (hashAgentCall,
   *  workflow.ts:1062), so its exact serialization is part of journal identity AND it
   *  already IS a JSON Schema object that feeds Claude outputFormat / Codex outputSchema
   *  downstream. Freeze the exact object handed to hashAgentCall; normalize for Codex on
   *  a COPY, never mutate the hashed value. */
  schema?: S;
  /** Extra system guidance (engine builds it from phase/agentType/isolation). NOT hashed. */
  instructions?: string;
  /** Engine-owned cancellation. The runner SHOULD wire this to the backend session cancel
   *  (ACP session/cancel) but MUST NOT implement its own timeout. */
  signal?: AbortSignal;
  /** Model spec (`provider/modelId` or bare `modelId`). Runner interprets: cross-provider =>
   *  which ACP server to spawn; within-provider => session config / Claude _meta model.
   *  Omitted => session default. */
  model?: string;
  /** Coarse tier ("small" | "medium" | "big"). Consulted only when `model` is unset; `model` wins. */
  tier?: string;
  /** Working directory (e.g. an isolated git worktree). ABSOLUTE. Maps to ACP session/new {cwd}. NOT hashed. */
  cwd?: string;
  /** Tool allow-list (agentType `tools`). Runner maps to ACP permission auto-responses / mode. */
  toolNames?: string[];
  /** Tool deny-list (agentType `disallowedTools`), applied after the allow-list. */
  disallowedToolNames?: string[];
  /** With `schema`: extra client-side repair turns before strict prose extraction. Leaf default 2.
   *  Runner-internal — the engine never passes it and it is NOT plumbed to the MCP tool. */
  maxSchemaRetries?: number;
  /** Real usage, read right before session disposal. Fires on success AND error. May never fire. */
  onUsage?: (usage: AgentUsage) => void;
  /** The actually-resolved concrete model id (display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** A requested model/tier/phase spec that wasn't found (fell back to the session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** A compact snapshot of this subagent's message/tool history (diagnostic only). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Client-provided MCP servers to attach to this run (ACP `session/new { mcpServers }`).
   *  ADDITIVE and NOT part of the resume identity hash (hashAgentCall) — it wires tools,
   *  not the logical call. Omitted/empty => the runner sends `mcpServers: []` (the default). */
  mcpServers?: McpServerConfig[];
  /** Engine run id, stamped onto the outgoing ACP `session/new` `_meta` under
   *  META_KEYS.runId as an end-to-end correlation id for tracing/telemetry. ADDITIVE and NOT
   *  part of the resume identity hash (hashAgentCall) — it correlates, it does not identify the
   *  logical call. Omitted => no runId `_meta` is stamped. */
  runId?: string;
  /** RUN-SCOPED custom ACP backends (an APPROVED script-declared `meta.backends`, threaded
   *  by the engine on every agent() call of the run). The runner validates entries with the
   *  same rules as the host registry (reserved names rejected) and consults them for routing
   *  AFTER the host-registered names — a script can never hijack a name the host configured.
   *  ADDITIVE and NOT part of the resume identity hash (hashAgentCall): like `mcpServers`,
   *  it wires infrastructure, not the logical call (the routing `model` string IS hashed).
   *  Omitted => only host-registered + built-in backends are routable. */
  backends?: Record<string, WorkflowBackendConfig>;
  /** Generic ACP `_meta` passthrough, SESSION-scoped: merged into the outgoing ACP
   *  `session/new` `_meta` so a workflow can drive ANY ACP agent's custom extension surface
   *  (the protocol reserves `_meta` for exactly this). Merge precedence: these keys are laid
   *  down FIRST, then backend-computed keys (the Claude `claudeCode` schema channel, the Codex
   *  `baseInstructions`/`developerInstructions` forwards, the `runId` stamp) override on
   *  conflict — user meta can never break the structured-output or correlation channels.
   *  ADDITIVE and NOT part of the resume identity hash (hashAgentCall): it shapes the agent,
   *  not the logical call. Omitted => the request `_meta` is whatever the backend set. */
  meta?: Record<string, unknown>;
  /** Generic ACP `_meta` passthrough, TURN-scoped: merged into the outgoing ACP
   *  `session/prompt` `_meta` (the extension point where e.g. the Codex `outputSchema`
   *  forward rides). Same merge precedence as `meta`: user keys first, backend-computed keys
   *  (e.g. `outputSchema` when a schema is set) win on conflict. ADDITIVE and NOT hashed.
   *  Omitted => the prompt `_meta` is whatever the backend set. */
  promptMeta?: Record<string, unknown>;
  /** CODEX-ONLY. Replaces Codex's built-in base system prompt for the session. The runner forwards
   *  it on ACP `session/new` `_meta.baseInstructions`, which the @automatalabs/codex-acp adapter
   *  threads into `thread/start.baseInstructions`. ADDITIVE and NOT hashed (it shapes the agent,
   *  not the logical call identity). Ignored by the Claude backend. Omitted => Codex default. */
  baseInstructions?: string;
  /** CODEX-ONLY. Injects developer-role instructions for the session (added ON TOP of the base
   *  prompt, unlike `baseInstructions` which replaces it). Forwarded on ACP `session/new`
   *  `_meta.developerInstructions` -> `thread/start.developerInstructions`. ADDITIVE and NOT
   *  hashed. Ignored by the Claude backend. Omitted => Codex default. */
  developerInstructions?: string;
}

/** The result side of the seam: schema => the validated object, no schema => text.
 *  NO wrapper — usage is separate (onUsage). Must be JSON-round-trippable.
 *  NAME = AgentResult (Phase-1 deliverable name); `AgentRunResult` is the lift-compat alias. */
export type AgentResult<S extends TSchema | undefined = undefined> = S extends TSchema ? Static<S> : string;

/** Lift-compat aliases over the Phase-1-canonical names (same types). Ported pi
 *  engine/runner code importing the old names still resolves. */
export type AgentRunOptions<S extends TSchema | undefined = undefined> = RunOptions<S>;
export type AgentRunResult<S extends TSchema | undefined = undefined> = AgentResult<S>;
