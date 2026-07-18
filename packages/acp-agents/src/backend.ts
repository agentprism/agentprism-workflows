// The internal Backend strategy (NOT part of @automatalabs/shared-types). One AcpAgentSession
// transport drives either backend; the Backend supplies the three things that genuinely
// differ between Claude, Codex, OpenCode, and pi:
//   1. how to spawn the ACP server subprocess,
//   2. the vendor `_meta` that carries the schema IN (Claude: session/new
//      _meta.claudeCode.options.outputFormat + emitRawSDKMessages; Codex: per-turn
//      _meta["outputSchema"], strict-normalized; OpenCode: generic _meta.outputSchema),
//   3. how to read the native structured result OUT (Claude: structured_output off the raw
//      _claude/sdkMessage; Codex/OpenCode/Pi: JSON.parse the final assistant message off the stream).
import type { TSchema } from "typebox";
import type { ProviderUsageLimitContext } from "@automatalabs/shared-types";
import type { AuthProfile } from "./auth/auth-profiles.js";

/** The built-in backends. Custom registry backends extend the id space beyond these. */
export type BuiltinBackendId = "claude" | "codex" | "opencode" | "pi";
/** A backend id: one of the built-ins, or the registered name of a custom ACP backend
 *  (see registry.ts). The pool keys connections by this id, so ids must be stable. */
export type BackendId = string;

export interface SpawnConfig {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** The slice of an active session a Backend reads to extract the native structured result. */
export interface StructuredSource {
  /** The latest turn's accumulated assistant text (every message in the turn, concatenated). */
  currentTurnText(): string;
  /** The latest turn's FINAL assistant message only: the text streamed after the last
   *  tool/thought/plan event. Schema backends read this, never currentTurnText() — agents that
   *  constrain sampling turn-wide (Codex) emit schema-shaped JSON for intermediate progress
   *  messages too, and a first-JSON scan over the whole turn returns the wrong object. */
  finalMessageText(): string;
  /** Claude only: `structured_output` from the latest `type:"result", subtype:"success"` raw message. */
  rawStructuredOutput(): unknown;
}

/** Per-session inputs a backend may fold into its `session/new` `_meta`, beyond the schema.
 *  Additive/optional; a backend that doesn't understand a field ignores it. */
export interface SessionMetaInputs {
  /** CODEX-ONLY: replaces Codex's base system prompt (`thread/start.baseInstructions`). */
  baseInstructions?: string;
  /** CODEX-ONLY: developer-role instructions (`thread/start.developerInstructions`). */
  developerInstructions?: string;
}

/** Structured provider metadata accumulated alongside a prompt before its request rejects. */
export interface ProviderErrorMetadata {
  /** RFC 3339 reset instant derived from provider-owned numeric metadata. */
  resetAt?: string;
}

/** Adapter-owned classification returned to the generic thrown-error mapper. */
export type ProviderErrorClassification = {
  kind: "provider_usage_limit";
  context: ProviderUsageLimitContext;
};

export interface Backend {
  readonly id: BackendId;
  /** Pool identity for this backend's long-lived processes. Defaults to `id` — but a CUSTOM
   *  backend sets it to id + a spawn-config hash, because two runs may declare the SAME name
   *  with DIFFERENT commands (script-declared `meta.backends`): keying the pool by name alone
   *  would hand run B a pooled process spawned from run A's command. */
  readonly poolKey?: string;
  /** @deprecated Prefix stripping is defined solely by the runner's registered first-segment
   *  routing. This compatibility property is no longer consulted. */
  readonly stripsRoutingPrefix?: boolean;
  /** When true, the runner EMBEDS the JSON Schema in the prompt text on schema runs. For the
   *  native built-ins the native constraint channel is authoritative and this stays unset; a
   *  generic backend sets it because its agent may ignore the `_meta.outputSchema` forward entirely —
   *  without the schema in the prompt, such an agent returns well-formed JSON with the WRONG
   *  KEYS and the repair ladder can never converge (it can fix prose, not unseen contracts). */
  readonly embedSchemaInPrompt?: boolean;
  /** When true, schema runs may inject a client-hosted MCP StructuredOutput tool if the
   *  initialized agent strictly advertises HTTP MCP support. Native schema channels leave this
   *  unset; custom ACP backends opt in unless their registry entry disables it. */
  readonly injectStructuredOutputTool?: boolean;
  /** The agentCapabilities._meta namespace this backend's agent advertises under, and the bare
   *  `_meta` keys gated by same-named boolean flags in that block; undefined = this backend has
   *  no custom-capability contract (its custom `_meta`, if any, is never gated). */
  readonly customCapabilities?: { readonly namespace: string; readonly gatedKeys: readonly string[] };
  /** Per-agent auth adapter (§3.1). UNDEFINED for custom backends → the type-driven base auth flow
   *  runs verbatim (conformance-by-absence, §1.4). The four built-in backends wire their pure-data
   *  profile (§3.2–§3.4); the lifecycle spine (§2) reads it when computing `spawnEnvFor` (§2.8), the
   *  runner consults `profile.describe`/`buildMeta` (§1.3/§2.9), and the connection refines client
   *  auth capabilities through `profile.clientAuthCapabilities` (§1.2). */
  readonly authProfile?: AuthProfile;
  /** Interpret this adapter's structured provider error surface. Any unavoidable prose fallback
   *  stays inside the concrete adapter implementation rather than generic runner/engine flow. */
  classifyProviderError?(
    error: unknown,
    metadata?: ProviderErrorMetadata,
  ): ProviderErrorClassification | undefined;
  /** How to launch this backend's ACP server over stdio. */
  spawnConfig(): SpawnConfig;
  /** OPTIONAL backend-level `_meta` DEFAULTS for session/new (e.g. a custom registry entry's
   *  static `sessionMeta`). Lowest precedence: per-call RunOptions.meta merges OVER these,
   *  and sessionMeta()'s protocol-critical keys merge over both. */
  sessionMetaDefaults?(): Record<string, unknown> | undefined;
  /** PROTOCOL-CRITICAL `_meta` for session/new (undefined when this backend carries nothing
   *  there) — e.g. the Claude schema channel. Highest precedence below the runId stamp: these
   *  keys win over the generic user passthrough. `inputs` carries optional per-session extras
   *  (e.g. Codex base/developer instructions); a backend that has no use for them ignores it. */
  sessionMeta(schema: TSchema | undefined, inputs?: SessionMetaInputs): Record<string, unknown> | undefined;
  /** `_meta` for session/prompt (undefined when this backend carries the schema at session/new). */
  promptMeta(schema: TSchema | undefined): Record<string, unknown> | undefined;
  /** Read this backend's native structured result for the latest turn (unvalidated), or undefined. */
  nativeStructured?(source: StructuredSource): unknown;
}

/** Split a whitespace-separated env override (e.g. AGENTPRISM_CLAUDE_ACP_ARGS) into argv. */
export function splitArgs(value: string | undefined): string[] {
  return value ? value.split(/\s+/).filter(Boolean) : [];
}
