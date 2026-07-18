import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type {
  AuthCapabilities,
  AuthMethod,
  AuthMethodAgent,
  AuthMethodEnvVar,
  AuthMethodTerminal,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";

type ValueOf<T> = T[keyof T];
type ClientMethod = ValueOf<typeof CLIENT_METHODS>;
type AgentMethod = ValueOf<typeof AGENT_METHODS>;

export type ClientMethodCoverage = "served" | "pending";
/** `guarded` means the raw passthrough would create/reopen session state outside the router, so
 *  the client rejects it until a driven wrapper can route updates, permissions, and terminals. */
export type AgentMethodCoverage = "driven" | "passthrough" | "guarded";

/** Enforceable definition of "full ACP spec support": every SDK method constant is classified
 *  here, and the tripwire test fails when an SDK bump silently widens or shrinks the protocol.
 *  Agent side: 16 operational methods are driven (plus initialize), 0 are guarded, and the
 *  passthrough remainder is nes/*, document/*, and mcp/message. The raw escape hatch remains
 *  blocked for session-stateful new/load/resume/fork even though each has a driven wrapper. */
export const CLIENT_METHOD_COVERAGE: Record<ClientMethod, ClientMethodCoverage> = {
  [CLIENT_METHODS.session_request_permission]: "served",
  [CLIENT_METHODS.session_update]: "served",
  [CLIENT_METHODS.fs_read_text_file]: "served",
  [CLIENT_METHODS.fs_write_text_file]: "served",
  [CLIENT_METHODS.terminal_create]: "served",
  [CLIENT_METHODS.terminal_output]: "served",
  [CLIENT_METHODS.terminal_release]: "served",
  [CLIENT_METHODS.terminal_wait_for_exit]: "served",
  [CLIENT_METHODS.terminal_kill]: "served",
  [CLIENT_METHODS.mcp_connect]: "served",
  [CLIENT_METHODS.mcp_message]: "served",
  [CLIENT_METHODS.mcp_disconnect]: "served",
  [CLIENT_METHODS.elicitation_create]: "served",
  [CLIENT_METHODS.elicitation_complete]: "served",
};

export const AGENT_METHOD_COVERAGE: Record<AgentMethod, AgentMethodCoverage> = {
  [AGENT_METHODS.initialize]: "driven",
  [AGENT_METHODS.authenticate]: "driven",
  [AGENT_METHODS.providers_list]: "driven",
  [AGENT_METHODS.providers_set]: "driven",
  [AGENT_METHODS.providers_disable]: "driven",
  [AGENT_METHODS.session_new]: "driven",
  [AGENT_METHODS.session_load]: "driven",
  [AGENT_METHODS.session_set_mode]: "driven",
  [AGENT_METHODS.session_set_config_option]: "driven",
  [AGENT_METHODS.session_prompt]: "driven",
  [AGENT_METHODS.session_cancel]: "driven",
  [AGENT_METHODS.mcp_message]: "passthrough",
  [AGENT_METHODS.session_list]: "driven",
  [AGENT_METHODS.session_delete]: "driven",
  [AGENT_METHODS.session_fork]: "driven",
  [AGENT_METHODS.session_resume]: "driven",
  [AGENT_METHODS.session_close]: "driven",
  [AGENT_METHODS.logout]: "driven",
  [AGENT_METHODS.nes_start]: "passthrough",
  [AGENT_METHODS.nes_suggest]: "passthrough",
  [AGENT_METHODS.nes_accept]: "passthrough",
  [AGENT_METHODS.nes_reject]: "passthrough",
  [AGENT_METHODS.nes_close]: "passthrough",
  [AGENT_METHODS.document_did_open]: "passthrough",
  [AGENT_METHODS.document_did_change]: "passthrough",
  [AGENT_METHODS.document_did_close]: "passthrough",
  [AGENT_METHODS.document_did_save]: "passthrough",
  [AGENT_METHODS.document_did_focus]: "passthrough",
};

// ---------------------------------------------------------------------------------------------
// Auth advertisement drift tripwire (§1.2 / §4.6.4). The client auth advertisement rides on the
// SDK's UNSTABLE `@experimental` `ClientCapabilities.auth` (`AuthCapabilities`) surface. Pin it two
// ways so a `@agentclientprotocol/sdk` bump that renames, removes, or reshapes it fails the build
// BEFORE release (honoring the bump-ACP-deps-every-release policy), never silently:
//   1. compile-time type-existence assertions (this pin fails `tsc`);
//   2. a runtime shape assertion exercised by the coverage test.
// ---------------------------------------------------------------------------------------------

/** Compile-time assertion primitive: `Expect<T>` only accepts `true`, so a `false` (drifted) SDK
 *  shape is a type error at build time. */
type Expect<T extends true> = T;

/** `ClientCapabilities.auth` still exists and is typed as `AuthCapabilities` (§1.2 UNSTABLE pin). */
export type _AuthKeyExists = Expect<"auth" extends keyof ClientCapabilities ? true : false>;
/** `AuthCapabilities.terminal` is still the typed boolean gate §1.2 assigns to (no `as` cast). */
export type _AuthTerminalIsBoolean = Expect<
  AuthCapabilities["terminal"] extends boolean | undefined ? true : false
>;

/** The exact property set SDK 1.2.1 types on `AuthCapabilities` (§1.2). The runtime tripwire below
 *  asserts `clientCapabilitiesFor({ auth })` emits ONLY these keys, so a bump that widens/renames
 *  the shape trips the coverage suite. */
export const AUTH_CAPABILITY_KEYS: readonly string[] = ["terminal", "_meta"];

/** Runtime drift assertion (§4.6.4 item 1): every key on the advertised `ClientCapabilities.auth`
 *  block is a pinned SDK-1.2.1 `AuthCapabilities` key. Throws on drift, tripping the build. A
 *  `null`/absent `auth` (the default-OFF baseline) is vacuously conformant. Reads only structural
 *  keys — never any advertised value — so it is secret-free. */
export function assertAuthCapabilityShape(auth: ClientCapabilities["auth"]): void {
  if (auth == null) return;
  for (const key of Object.keys(auth)) {
    if (!AUTH_CAPABILITY_KEYS.includes(key)) {
      throw new Error(
        `ClientCapabilities.auth carries unpinned key "${key}" — the SDK AuthCapabilities shape drifted (§1.2/§4.6.4).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Auth `AuthMethod.type` discriminant + cross-agent `_meta` convention drift tripwires
// (§3.6 / §4.6.4 items 3–5). The base auth flow (§1) dispatches on `AuthMethod.type` plus a small,
// fixed set of literal cross-agent `_meta` key names — NOT SDK schema fields. Pin both so a
// `@agentclientprotocol/sdk` bump that widens the method union, or an agent bump that moves a `_meta`
// surface, fails the build BEFORE release (bump-ACP-deps-every-release), never silently.
// ---------------------------------------------------------------------------------------------

/** The three `AuthMethod` variants the base dispatcher handles (`agent`/`terminal`/`env_var`, §1.3).
 *  `agent` is the default when `type` is absent (`AuthMethodAgent` carries no `type`). */
export const HANDLED_AUTH_METHOD_TYPES: readonly ["agent", "terminal", "env_var"] = ["agent", "terminal", "env_var"];

/** §4.6.4 item 3 — the SDK `AuthMethod` union is EXACTLY the three variants the dispatcher handles;
 *  a fourth variant (a widened union) makes this `false` and fails `tsc`. */
export type _AuthMethodUnionPinned = Expect<
  [AuthMethod] extends [AuthMethodAgent | AuthMethodTerminal | AuthMethodEnvVar] ? true : false
>;
/** The `terminal`/`env_var` discriminants are still the literals the dispatcher branches on: the SDK
 *  intersects the bare method type with `{ type: "…" }` in the `AuthMethod` union, so a dropped
 *  discriminant makes `Extract` collapse to `never` and fails `tsc`. */
export type _AuthMethodTerminalDiscriminant = Expect<
  [Extract<AuthMethod, { type: "terminal" }>] extends [never] ? false : true
>;
export type _AuthMethodEnvVarDiscriminant = Expect<
  [Extract<AuthMethod, { type: "env_var" }>] extends [never] ? false : true
>;

/** The cross-agent `_meta` key conventions the base layer keys on (§1 intro; recognized by literal
 *  name, NOT SDK schema fields). `gateway` ⇒ in-process classification; `terminal-auth` ⇒ terminal
 *  launch hint; `api-key` ⇒ codex's disk api-key `_meta`. */
export const AUTH_META_CONVENTION_KEYS = {
  gateway: "gateway",
  terminalAuth: "terminal-auth",
  apiKey: "api-key",
} as const;

/** The codex startup pre-auth env channel delivered by `codexAuthProfile.spawnAuthEnv` (§2.8/§3.3). */
export const CODEX_SPAWN_AUTH_ENV = "DEFAULT_AUTH_REQUEST" as const;

/** JSON-RPC `-32000` is reserved EXCLUSIVELY for `authRequired` (SDK `jsonrpc.js:818-823`) — the
 *  guarantee the code-only §1.5 matcher relies on (§4.6.4 item 5). */
export const ACP_AUTH_REQUIRED_CODE_EXCLUSIVE = -32000 as const;

/** Frozen pi-acp wire surface consumed by the first-class backend. Keeping these literals in the
 *  executable protocol-coverage module makes capability/auth/error drift visible in tests instead
 *  of leaving the built-in coupled only through prose. */
export const PI_ACP_PROTOCOL_CONTRACT = {
  mcpCapabilities: { http: true, sse: true },
  authMethodIds: [
    "anthropic-api-key",
    "openai-api-key",
    "gemini-api-key",
    "xai-api-key",
    "openrouter-api-key",
    "pi-stored-credentials",
  ],
  providerErrorKinds: ["auth_error", "rate_limit", "billing_error", "provider_error"],
} as const;

/** One row of the §3.6 full `_meta` support matrix, landed as executable data (not prose) so an
 *  SDK/agent bump that changes a `_meta` surface trips the drift suite (§4.6.4 item 4). */
export interface AuthMetaMatrixRow {
  readonly agent: "claude" | "codex" | "opencode" | "all";
  /** A stable literal that MUST still be present in the cited artifact/spec — the drift anchor. */
  readonly capability: string;
  /** Wire direction: A→C agent→client, C→A client→agent, C↔A both, — none, agent-internal. */
  readonly direction: "A→C" | "C→A" | "C↔A" | "—" | "agent-internal";
  readonly status: "supported-today" | "work-item";
  /** Owning §/PR for a work item; omitted for supported-today rows. */
  readonly owner?: string;
  /** When set, the literal is asserted present in this backend's INSTALLED dist (claude/codex only;
   *  opencode ships a compiled binary with no consumable source — §3.4, grounded by live-e2e). */
  readonly distProbe?: "claude" | "codex";
}

/** The §3.6 auth `_meta` matrix as executable rows — the exact surfaces §4.6.4 item 4 enumerates
 *  (claude gateway/terminal-auth, codex api-key/gateway/DEFAULT_AUTH_REQUEST, opencode terminal-auth),
 *  plus the codex tool-approval `persist` and the cross-agent provider-env passthrough. Each
 *  `capability` is a literal that MUST appear in spec §3.6; `docs-drift.test.ts` asserts that lockstep,
 *  and (where `distProbe` is set) `protocol-coverage.test.ts` asserts the literal is still present in
 *  the installed agent dist — so neither the spec nor an agent bump can silently drift a `_meta`
 *  surface. OpenCode ships a compiled binary with no consumable source (§3.4), so its row has no dist
 *  probe (grounded instead by the §4.6.3 live-e2e). */
export const AUTH_META_MATRIX: readonly AuthMetaMatrixRow[] = [
  { agent: "claude", capability: "gateway", direction: "C↔A", status: "work-item", owner: "§1.2-§1.3/PR2-PR3", distProbe: "claude" },
  { agent: "claude", capability: "terminal-auth", direction: "C↔A", status: "work-item", owner: "§1.2-§1.3/PR2-PR3", distProbe: "claude" },
  { agent: "codex", capability: "api-key", direction: "A→C", status: "work-item", owner: "§1.3/PR3", distProbe: "codex" },
  { agent: "codex", capability: "gateway", direction: "C↔A", status: "work-item", owner: "§1.2-§1.3/PR2-PR3", distProbe: "codex" },
  { agent: "codex", capability: "DEFAULT_AUTH_REQUEST", direction: "C→A", status: "work-item", owner: "§3.3/PR7", distProbe: "codex" },
  { agent: "codex", capability: "persist", direction: "C→A", status: "work-item", owner: "§3.6/PR7", distProbe: "codex" },
  { agent: "opencode", capability: "terminal-auth", direction: "C↔A", status: "work-item", owner: "§1.2-§1.3/PR2-PR3" },
  { agent: "all", capability: "provider env keys", direction: "C→A", status: "work-item", owner: "§2.8/§3.4/PR3" },
];
