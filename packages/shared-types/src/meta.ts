// ===== packages/shared-types/src/meta.ts =====
// RESERVED `_meta` keys. One source of truth so the Codex patch key and any engine
// correlation stamps never drift across packages. All keys are BARE (un-namespaced),
// mirroring the target Codex param / upstream codex-acp convention (e.g. `additionalRoots`).

/** Canonical bare `_meta` keys the engine/runner read & write. */
export const META_KEYS = {
  /** Codex turn-level schema forward: the PATCHED codex-acp adapter reads
   *  request._meta["outputSchema"] and threads it into turn/start.outputSchema. */
  outputSchema: "outputSchema",
  /** Run correlation passthrough on ACP requests, for tracing/telemetry. */
  runId: "runId",
} as const;

/** VENDOR (codex-acp) bare `session/new` `_meta` keys the @automatalabs/codex-acp adapter reads
 *  and threads into the Codex `thread/start` / `thread/resume` / `thread/fork` params of the same
 *  name. Kept here (beside META_KEYS) so the writer (CodexBackend) and its tests never drift from
 *  the wire contract the fork reads. */
export const CODEX_META_KEYS = {
  /** Replaces Codex's built-in base system prompt for the thread. */
  baseInstructions: "baseInstructions",
  /** Injects developer-role instructions for the thread (added on top of the base prompt). */
  developerInstructions: "developerInstructions",
} as const;

/** The `agentCapabilities._meta` NAMESPACE under which the @automatalabs/codex-acp fork advertises
 *  its custom capabilities (the ACP extensibility convention — custom capabilities are namespaced
 *  `_meta` keys: https://agentclientprotocol.com/protocol/v1/extensibility). Keyed by the fork's
 *  published package identity so it never collides with another extension. Under this key the fork
 *  publishes a `{ [bareKey]: boolean }` block whose flags are named EXACTLY the bare `_meta` wire
 *  keys they gate — META_KEYS.outputSchema and CODEX_META_KEYS.{baseInstructions,
 *  developerInstructions} — so a client tests `block[bareKey] === true` before sending each key.
 *  An agent that omits this namespace has NOT opted into negotiation: the client keeps sending
 *  every key (the pre-advertisement / non-fork legacy path), because fork releases ≤ 1.2.0 and
 *  arbitrary custom ACP servers honor these inputs without advertising them. */
export const CODEX_CUSTOM_CAPABILITY_NAMESPACE = "@automatalabs/codex-acp";

/** VENDOR (claude-agent-acp) — NOT ours; the SDK's. Set at session/new for the Claude
 *  structured-output path: _meta.claudeCode.options.outputFormat = { type:"json_schema", schema }
 *  AND _meta.claudeCode.emitRawSDKMessages = true (MANDATORY — the parsed object lands on
 *  SDKResultSuccess.structured_output, readable ONLY off the raw _claude/sdkMessage notification).
 *  Typed here so the two namespaces never collide. */
export interface ClaudeJsonSchemaOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}
export interface ClaudeCodeSessionMeta {
  claudeCode?: {
    options?: { outputFormat?: ClaudeJsonSchemaOutputFormat; model?: string; [k: string]: unknown };
    emitRawSDKMessages?: boolean;
  };
}
