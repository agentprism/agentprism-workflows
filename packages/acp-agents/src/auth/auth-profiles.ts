// Per-agent auth profiles (§3). One profile object per built-in backend; custom backends supply
// NONE and run the type-driven base flow verbatim (conformance-by-absence, §3.5). Every field here is
// DATA/ENRICHMENT only — a profile may enrich a descriptor's label, contribute a spawn-env overlay, or
// refine which auth method TYPES this backend can service, but it NEVER gates or redirects the base
// flow (Principle 1). The base dispatcher `buildAuthDescriptors` (§1.3) owns the `type` discriminant
// and the terminal-vs-agent decision; a profile only re-labels the result.
//
// The profiles are pure data: `claudeAuthProfile`/`opencodeAuthProfile` are client-side adaptation
// only (their `describe`/`buildMeta`/`clientAuthCapabilities` map host affordances onto each agent's
// advertised methods), while `codexAuthProfile` additionally carries the `spawnAuthEnv`
// (`DEFAULT_AUTH_REQUEST`) lever — an EXISTING codex-acp spawn-time surface consumed client-side, on
// top of the universal post-`initialize` replay (§2.5), never required for correctness (§3.3).
//
// There is ZERO `if (backendId === …)` branching in the base layer (§1); the per-agent asymmetry
// (only codex defines `spawnAuthEnv`; only claude/opencode advertise terminal; only claude/codex
// advertise gateway) lives entirely inside these pure-data objects — a truthful asymmetry, not a
// ranking (§2.8/§3.3).
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { ClientCapabilityOptions } from "../client-handlers.js";
import type { AuthMethodDescriptor, AuthResolution } from "./auth-types.js";
import type { AuthIntent } from "./auth-store.js";

/** The spawnable interactive login a host runs in a TTY. Identical to the `launch` member of the
 *  `terminal` `AuthMethodDescriptor` (§1.3). */
export interface TerminalLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label?: string;
}

/** Per-agent adapter (§3.1). Every field is DATA/ENRICHMENT only — none gates the base flow. A backend
 *  with NO profile runs the base flow verbatim (conformance-by-absence). Built-in profiles are wired
 *  onto their backend in PR7; `custom.ts` leaves `Backend.authProfile` undefined. */
export interface AuthProfile {
  readonly backendId: string;
  /** Which auth method TYPES to advertise for this backend, given host affordances. Refines the
   *  runner default derivation in §1.2; still connection-lifetime-fixed. `host.onAuth` = the host can
   *  complete an in-process (gateway) auth; `host.terminal` = the host has a real TTY. */
  clientAuthCapabilities(host: { onAuth: boolean; terminal: boolean }): ClientCapabilityOptions["auth"];
  /** Enrich/label the base descriptor for one advertised method. MUST delegate type dispatch to the
   *  §1.3 `buildAuthDescriptors` dispatcher (it receives the already-dispatched `base`); may only
   *  override name/description/label. */
  describe(method: AuthMethod, base: AuthMethodDescriptor): AuthMethodDescriptor;
  /** Terminal launch override; base falls back to §1.3's launch-resolution order. */
  terminalLaunch?(method: Extract<AuthMethod, { type: "terminal" }>): TerminalLaunch;
  /** Wrap a `{outcome:"meta"}` resolution into the agent's expected authenticate `_meta`. */
  buildMeta?(method: AuthMethod, resolution: Extract<AuthResolution, { outcome: "meta" }>): Record<string, unknown>;
  /** OPTIONAL spawn-env overlay contributed regardless of `klass` (§2.8, Principle 9). Codex only —
   *  the `DEFAULT_AUTH_REQUEST` lever channel. Secret; consumed inside `AuthStore.spawnEnvFor`, never
   *  logged. */
  spawnAuthEnv?(intent: AuthIntent): Record<string, string> | undefined;
}

/** Claude Code — `@agentclientprotocol/claude-agent-acp` 0.57.0 (§3.2). Reveals its `terminal` login
 *  methods on `auth.terminal===true` OR `_meta["terminal-auth"]===true`, and its `gateway`/
 *  `gateway-bedrock` `agent`-type methods on `auth._meta.gateway===true`, so terminal follows the
 *  host TTY and gateway follows an `onAuth` resolver. `describe`/`buildMeta` are client-side identity:
 *  the base dispatcher already produces the correct descriptor and the gateway payload passes through
 *  unchanged. No `spawnAuthEnv` — Claude has no `DEFAULT_AUTH_REQUEST`-style pre-auth channel and is
 *  consumed client-side only (§3.2 spawn-time). */
export const claudeAuthProfile: AuthProfile = {
  backendId: "claude",
  clientAuthCapabilities: ({ onAuth, terminal }) => ({ terminal, gateway: onAuth }),
  describe: (_method, base) => base,
  buildMeta: (_method, resolution) => resolution.meta,
};

/** Codex — `@automatalabs/codex-acp` 1.4.x, our fork (§3.3). Advertises no `terminal` method (its
 *  `api-key` reads env internally and `chat-gpt`/`gateway` are `agent`-type), so terminal is always
 *  false; `gateway` follows an `onAuth` resolver. The `spawnAuthEnv` lever emits `DEFAULT_AUTH_REQUEST`
 *  for `api-key`/`gateway` intents so a freshly recycled process pre-authenticates before its first
 *  gated request — layered on top of the universal replay (§2.5), never replacing it and never
 *  required for correctness (§2.8/§3.3). */
export const codexAuthProfile: AuthProfile = {
  backendId: "codex",
  clientAuthCapabilities: ({ onAuth }) => ({ terminal: false, gateway: onAuth }),
  describe: (_method, base) => base,
  buildMeta: (_method, resolution) => resolution.meta,
  spawnAuthEnv(intent: AuthIntent): Record<string, string> | undefined {
    // Only api-key and gateway intents drive the codex pre-auth channel (§3.3). `authenticateMeta` is
    // SECRET and undefined for the env-only api-key path — the base overlay injects that key's env.
    if (intent.methodId !== "api-key" && intent.methodId !== "gateway") return undefined;
    const meta = intent.authenticateMeta;
    return {
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: intent.methodId, ...(meta ? { _meta: meta } : {}) }),
    };
  },
};

/** OpenCode — `opencode-ai` 1.17.14 (§3.4). Advertises exactly one `opencode-login` method that is
 *  semantically terminal (it carries a `_meta["terminal-auth"]` launch hint when the host has a TTY),
 *  and no gateway/`env_var`/logout auth surface. So terminal follows the host TTY and gateway is
 *  always false. `describe` is client-side identity; no `buildMeta` (no meta method) and no
 *  `spawnAuthEnv` (no `DEFAULT_AUTH_REQUEST` analog; §3.4 spawn-time). */
export const opencodeAuthProfile: AuthProfile = {
  backendId: "opencode",
  clientAuthCapabilities: ({ terminal }) => ({ terminal, gateway: false }),
  describe: (_method, base) => base,
};
