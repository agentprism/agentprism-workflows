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

/** VENDOR (codex-acp ≥ 1.9.0, from upstream agentclientprotocol/codex-acp v1.2.0) — the wire names
 *  of the NEGOTIATED typed-session-failures extension the fork calls "AIR". The client advertises
 *  `initialize.clientCapabilities._meta[namespace][extension] = { version, capabilities: [...] }`;
 *  once the server's gate accepts that block it stops rejecting/streaming raw provider prose for
 *  terminal turn failures and instead reports them as a structured `sessionFailure` payload under
 *  `_meta[namespace][extension]` — on `PromptResponse._meta` for a terminal turn failure, and on a
 *  `session_info_update` session update for an asynchronous one.
 *
 *  MIRRORED, NOT IMPORTED. The source of truth is `packages/codex-acp/src/AirExtension.ts`
 *  (`JETBRAINS_META_KEY`, `AIR_META_KEY`, `AIR_EXTENSION_VERSION_KEY`,
 *  `AIR_EXTENSION_CAPABILITIES_KEY`, `AIR_SESSION_FAILURE_KEY`, `AIR_EXTENSION_VERSION`), which the
 *  fork does not export from its published package (it ships only a bundled `dist/index.js` with no
 *  type declarations). Mirroring here follows the same rule as CODEX_META_KEYS above — the writer
 *  and the wire contract meet in one file — and `acp-agents/test/typed-session-failures.test.ts`
 *  asserts the mirror against that source file so the two can never drift silently.
 *
 *  `jetbrains`/`air` are protocol namespace names, not branding: upstream owns the non-standard
 *  contract under its own key so unrelated ACP clients never collide with it. */
export const CODEX_AIR_META_KEYS = {
  /** `JETBRAINS_META_KEY` — the `_meta` namespace owning the extension. */
  namespace: "jetbrains",
  /** `AIR_META_KEY` — the extension key inside the namespace. */
  extension: "air",
  /** `AIR_EXTENSION_VERSION_KEY` — the integer extension version, sent in both directions. */
  version: "version",
  /** `AIR_EXTENSION_CAPABILITIES_KEY` — the client's advertised capability list. */
  capabilities: "capabilities",
  /** `AIR_SESSION_FAILURE_KEY` — the capability name AND the typed-failure payload key. */
  sessionFailure: "sessionFailure",
} as const;

/** `AIR_EXTENSION_VERSION` — the extension version this monorepo implements. The server accepts a
 *  client whose advertised version is >= its own, so a client may only ever receive payloads at
 *  this version or below. */
export const CODEX_AIR_EXTENSION_VERSION = 1;

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
export interface ClaudeCodeSessionMeta extends Record<string, unknown> {
  claudeCode?: {
    options?: { outputFormat?: ClaudeJsonSchemaOutputFormat; [k: string]: unknown };
    emitRawSDKMessages?: boolean;
  };
}
