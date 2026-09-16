import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type {
  AuthCapabilities,
  AuthMethod,
  AuthMethodAgent,
  AuthMethodTerminal,
  ClientCapabilities,
} from "@agentclientprotocol/sdk";
import { LOADED_TURN_QUERY_METHOD, SESSION_STEERING_METHOD } from "./acp-client.js";

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
export const CLIENT_METHOD_COVERAGE: Readonly<Record<ClientMethod, ClientMethodCoverage>> = Object.freeze({
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
});

export const AGENT_METHOD_COVERAGE: Readonly<Record<AgentMethod, AgentMethodCoverage>> = Object.freeze({
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
});

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

/** The two `AuthMethod` variants the base dispatcher handles (`agent`/`terminal`, §1.3). `agent` is
 *  the default when `type` is absent (`AuthMethodAgent` carries no `type`). ACP schema 1.21.0
 *  (`@agentclientprotocol/sdk` 1.4.0) removed the former `env_var` variant
 *  (agentclientprotocol/agent-client-protocol #1796/#2000); the tripwires below are retargeted to the
 *  two-variant union and additionally pin that `env_var` stays absent. */
export const HANDLED_AUTH_METHOD_TYPES: readonly ["agent", "terminal"] = ["agent", "terminal"];

/** §4.6.4 item 3 — the SDK `AuthMethod` union is EXACTLY the two variants the dispatcher handles;
 *  a third variant (a widened union) makes this `false` and fails `tsc`. */
export type _AuthMethodUnionPinned = Expect<
  [AuthMethod] extends [AuthMethodAgent | AuthMethodTerminal] ? true : false
>;
/** The `terminal` discriminant is still the literal the dispatcher branches on: the SDK intersects the
 *  bare method type with `{ type: "…" }` in the `AuthMethod` union, so a dropped discriminant makes
 *  `Extract` collapse to `never` and fails `tsc`. */
export type _AuthMethodTerminalDiscriminant = Expect<
  [Extract<AuthMethod, { type: "terminal" }>] extends [never] ? false : true
>;
/** The removed `env_var` discriminant must STAY absent: if a future SDK reintroduces it, this fails
 *  `tsc` so the dispatcher/descriptor decision is re-made consciously, never by silent widening. */
export type _AuthMethodEnvVarAbsent = Expect<
  [Extract<AuthMethod, { type: "env_var" }>] extends [never] ? true : false
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
  // The five provider API-key methods were `env_var`-typed and left with that variant (ACP 1.21.0).
  authMethodIds: ["pi-stored-credentials"],
  providerErrorKinds: ["auth_error", "rate_limit", "billing_error", "provider_error"],
} as const;

/** One row of the §3.6 full `_meta` support matrix, landed as executable data (not prose) so an
 *  SDK/agent bump that changes a `_meta` surface trips the drift suite (§4.6.4 item 4). */
export interface AuthMetaMatrixRow {
  readonly agent: string;
  /** A stable literal that MUST still be present in the cited artifact/spec — the drift anchor. */
  readonly capability: string;
  /** Wire direction: A→C agent→client, C→A client→agent, C↔A both, — none, agent-internal. */
  readonly direction: "A→C" | "C→A" | "C↔A" | "—" | "agent-internal";
  /** Every published row describes behavior delivered and verified by the current implementation. */
  readonly status: "supported-today";
  /** When set, the literal is asserted present in this backend's INSTALLED dist (claude/codex only;
   *  opencode ships a compiled binary with no consumable source — §3.4, grounded by live-e2e). */
  readonly distProbe?: "claude" | "codex";
  /** Exact compiled-source tripwire when the human capability label is too broad. */
  readonly distProbeLiteral?: string;
}

/** The §3.6 auth `_meta` matrix as executable rows — the exact surfaces §4.6.4 item 4 enumerates
 *  (claude gateway/terminal-auth, codex api-key/gateway/DEFAULT_AUTH_REQUEST, opencode terminal-auth),
 *  plus Codex permission-presentation metadata and the cross-agent provider-env passthrough. The
 *  loaded-turn extension rows (turn-terminal state for loaded sessions) record which servers
 *  SERVE the extension: claude and opencode do not advertise it, and the re-attach seam's
 *  observation path classifies their loaded turns authoritatively instead (see
 *  `InteractiveSession.awaitCurrentTurn` — the connection-death contract makes the replay
 *  probe authoritative for the VERIFIED BUILT-INS; phase-F review round 2, restricted to the
 *  built-in instances in round 3). Each
 *  `capability` is a literal that MUST appear in spec §3.6; `docs-drift.test.ts` asserts that lockstep,
 *  and (where `distProbe` is set) `protocol-coverage.test.ts` asserts `distProbeLiteral ?? capability`
 *  is still present in the installed agent dist — so neither the spec nor an agent bump can silently drift a `_meta`
 *  surface. OpenCode ships a compiled binary with no consumable source (§3.4), so its row has no dist
 *  probe (grounded instead by the §4.6.3 live-e2e). */
const AUTH_META_MATRIX_ROWS = [
  { agent: "claude", capability: "gateway", direction: "C↔A", status: "supported-today", distProbe: "claude" },
  { agent: "claude", capability: "terminal-auth", direction: "C↔A", status: "supported-today", distProbe: "claude" },
  { agent: "codex", capability: "api-key", direction: "A→C", status: "supported-today", distProbe: "codex" },
  { agent: "codex", capability: "gateway", direction: "C↔A", status: "supported-today", distProbe: "codex" },
  { agent: "codex", capability: "DEFAULT_AUTH_REQUEST", direction: "C→A", status: "supported-today", distProbe: "codex" },
  {
    agent: "codex",
    capability: "permission",
    direction: "A→C",
    status: "supported-today",
    distProbe: "codex",
    distProbeLiteral: "permission:",
  },
  { agent: "opencode", capability: "terminal-auth", direction: "C↔A", status: "supported-today" },
  { agent: "all", capability: "provider env keys", direction: "C→A", status: "supported-today" },
] satisfies readonly AuthMetaMatrixRow[];

export const AUTH_META_MATRIX: readonly AuthMetaMatrixRow[] = Object.freeze(
  AUTH_META_MATRIX_ROWS.map((row) => Object.freeze(row)),
);

/** One executable advertisement record for a vendor extension that is intentionally absent from
 *  the standard SDK AGENT_METHODS table. This matrix documents installed/built-in behavior only;
 *  it never gates or routes runtime extension calls. The loaded-turn
 *  extension (turn-terminal state for loaded sessions) is only served by the two in-repo
 *  servers (pi-acp, codex-acp); claude and opencode do not advertise it — the seam then
 *  classifies the loaded session's founding turn through the OBSERVATION path instead (the
 *  post-load continuation watch plus the replay probe under the connection-death contract —
 *  see `InteractiveSession.awaitCurrentTurn`; phase-F review round 2: the old degradation
 *  released the loaded session and re-issued the call, which can duplicate a still-running
 *  turn; a possibly-running call is never re-issued). The replay classification is restricted
 *  to the VERIFIED BUILT-IN instances (`connectionDeathVerified`) — a custom backend's quiet
 *  observation window is not terminal evidence and degrades to the keep-attached
 *  still-running wait (phase-F review round 3). */
export interface AcpExtensionSupportMatrixRow {
  readonly agent: string;
  readonly method: typeof SESSION_STEERING_METHOD | typeof LOADED_TURN_QUERY_METHOD;
  readonly disposition: "supported" | "not-advertised";
  /** Installed distributions whose method + initialize advertisement are probed by the protocol
   *  coverage suite. Pi is workspace-owned and covered in its package tests instead. */
  readonly distProbe?: "claude" | "codex";
}

const ACP_EXTENSION_SUPPORT_MATRIX_ROWS = [
  {
    agent: "claude",
    method: SESSION_STEERING_METHOD,
    disposition: "supported",
    distProbe: "claude",
  },
  {
    agent: "codex",
    method: SESSION_STEERING_METHOD,
    disposition: "supported",
    distProbe: "codex",
  },
  {
    agent: "opencode",
    method: SESSION_STEERING_METHOD,
    disposition: "not-advertised",
  },
  {
    agent: "pi",
    method: SESSION_STEERING_METHOD,
    disposition: "supported",
  },
  {
    agent: "claude",
    method: LOADED_TURN_QUERY_METHOD,
    disposition: "not-advertised",
    distProbe: "claude",
  },
  {
    agent: "codex",
    method: LOADED_TURN_QUERY_METHOD,
    disposition: "supported",
    distProbe: "codex",
  },
  {
    agent: "opencode",
    method: LOADED_TURN_QUERY_METHOD,
    disposition: "not-advertised",
  },
  {
    agent: "pi",
    method: LOADED_TURN_QUERY_METHOD,
    disposition: "supported",
  },
] satisfies readonly AcpExtensionSupportMatrixRow[];

/** Built-in support for non-standard agent request methods. Kept separate from
 *  AGENT_METHOD_COVERAGE so a vendor extension is never counted as a standard ACP method. */
export const ACP_EXTENSION_SUPPORT_MATRIX: readonly AcpExtensionSupportMatrixRow[] = Object.freeze(
  ACP_EXTENSION_SUPPORT_MATRIX_ROWS.map((row) => Object.freeze(row)),
);

/** How each installed agent answers `session/fork`, read from its adapter source, and what the
 *  AcpAgent SDK must do with the response. `id-only`: the response names a persisted copy that
 *  is not live — claude-agent-acp returns `{ sessionId }` from `dist/fork-session.js` and `prompt`
 *  on it throws "Session not found". `live`: the fork handle is the session — @automatalabs/codex-acp
 *  forks the thread through `thread/fork`, which subscribes the connection to the new thread
 *  exactly like `thread/resume` does, keeps that subscription (no `threadUnsubscribe`), and
 *  publishes the forked session's available commands and MCP startup status like a resumed one;
 *  pi constructs the fork in-process; OpenCode by live verification only. `reattach` names the
 *  reopen an `id-only` fork needs before its first turn. `cwd`: whether the fork may re-home —
 *  claude's transcript store is keyed by the source cwd. Data for the SDK's fork choreography;
 *  the runner's `forkSession()` returns the raw fork handle and never consults it. */
export interface ForkSessionTraitRow {
  readonly agent: string;
  readonly disposition: "id-only" | "live";
  readonly reattach: "resume-or-load" | "none";
  readonly cwd: "source-only" | "free";
  /** Installed distributions whose fork implementation is probed by the protocol coverage
   *  suite (opencode ships a compiled binary; grounded by live-e2e only). */
  readonly distProbe?: "claude" | "codex" | "pi";
}

const FORK_SESSION_TRAIT_ROWS = [
  { agent: "claude", disposition: "id-only", reattach: "resume-or-load", cwd: "source-only", distProbe: "claude" },
  { agent: "codex", disposition: "live", reattach: "none", cwd: "free", distProbe: "codex" },
  { agent: "opencode", disposition: "live", reattach: "none", cwd: "free" },
  { agent: "pi", disposition: "live", reattach: "none", cwd: "free", distProbe: "pi" },
] satisfies readonly ForkSessionTraitRow[];

/** Per-built-in `session/fork` dispositions. Pinned against the installed adapter dists by the
 *  protocol coverage suite and against the public docs by the docs-drift suite. */
export const FORK_SESSION_TRAITS: readonly ForkSessionTraitRow[] = Object.freeze(
  FORK_SESSION_TRAIT_ROWS.map((row) => Object.freeze(row)),
);

/** Unknown agents: a fork response is treated as live (the ACP contract), cwd free. */
export const FORK_SESSION_TRAIT_DEFAULT: ForkSessionTraitRow = Object.freeze({
  agent: "*",
  disposition: "live",
  reattach: "none",
  cwd: "free",
});

/** The built-in row for `agent`, or — when `declared` is given (a custom registry entry's `fork`
 *  field, `CustomBackendConfig.fork`) — the row the declaration describes. A declaration always
 *  wins over the name: a custom entry named `claude` is a different program from the built-in and
 *  never inherits its row. An undeclared unknown agent gets `FORK_SESSION_TRAIT_DEFAULT`. */
export function forkSessionTrait(
  agent: string,
  declared?: { readonly disposition: ForkSessionTraitRow["disposition"]; readonly cwd?: ForkSessionTraitRow["cwd"] },
): ForkSessionTraitRow {
  if (declared) {
    return Object.freeze({
      agent,
      disposition: declared.disposition,
      reattach: declared.disposition === "id-only" ? "resume-or-load" : "none",
      cwd: declared.cwd ?? "free",
    });
  }
  return FORK_SESSION_TRAITS.find((row) => row.agent === agent) ?? FORK_SESSION_TRAIT_DEFAULT;
}

/** Which halves of the backend-neutral `SystemPromptOptions` (`replace` / `append`) each built-in
 *  can carry, and on which `session/new|resume|load|fork` `_meta` key — read from each adapter's
 *  source and pinned by the protocol coverage suite (claude/codex/pi dists) and the docs-drift
 *  suite. `replace` swaps the agent's built-in system prompt; `append` adds to it. A backend with
 *  both `false` (opencode: `opencode acp` reads no session `_meta`; system prompts live in its
 *  config and agent definitions) rejects any `systemPrompt` before a session opens. */
export interface SystemPromptSupport {
  readonly replace: boolean;
  readonly append: boolean;
}

export interface SystemPromptSupportRow extends SystemPromptSupport {
  readonly agent: string;
  /** The bare `_meta` key(s) the instructions ride on; empty when unsupported. */
  readonly metaKeys: readonly string[];
  /** Installed distributions whose `_meta` reader is probed by the protocol coverage suite. */
  readonly distProbe?: "claude" | "codex" | "pi";
}

const SYSTEM_PROMPT_SUPPORT_ROWS = [
  // claude-agent-acp `createSession`: `_meta.systemPrompt` string => replaces the prompt; object =>
  // merged into the `claude_code` preset with type/preset locked (`{ append }` extends it).
  { agent: "claude", replace: true, append: true, metaKeys: ["systemPrompt"], distProbe: "claude" },
  // @automatalabs/codex-acp: bare `_meta.baseInstructions` (base prompt replacement) and
  // `_meta.developerInstructions` (developer-role instructions) => thread/{start,resume,fork} params
  // (a Codex fork is live, so session/fork's own `_meta` is where a fork's instructions travel).
  { agent: "codex", replace: true, append: true, metaKeys: ["baseInstructions", "developerInstructions"], distProbe: "codex" },
  { agent: "opencode", replace: false, append: false, metaKeys: [] },
  // @automatalabs/pi-acp: `_meta.systemPrompt` `{ replace?, append? }` (or a string = replace) =>
  // pi's `DefaultResourceLoader` system-prompt overrides.
  { agent: "pi", replace: true, append: true, metaKeys: ["systemPrompt"], distProbe: "pi" },
] satisfies readonly SystemPromptSupportRow[];

/** Per-built-in system-prompt instruction support. Executable data: the backends read their own
 *  row (`Backend.systemPrompt`), the validators reject what a row does not carry, and the drift
 *  suites pin the rows against the installed adapters and the public docs. */
export const SYSTEM_PROMPT_SUPPORT: readonly SystemPromptSupportRow[] = Object.freeze(
  SYSTEM_PROMPT_SUPPORT_ROWS.map((row) => Object.freeze({ ...row, metaKeys: Object.freeze([...row.metaKeys]) })),
);

/** Unknown agents carry no system-prompt channel: a custom registry entry's own `_meta` keys
 *  travel through the generic `meta` passthrough instead. */
export const SYSTEM_PROMPT_UNSUPPORTED: SystemPromptSupport = Object.freeze({ replace: false, append: false });

/** The built-in row for `agent`, or `SYSTEM_PROMPT_UNSUPPORTED` for an unknown agent. */
export function systemPromptSupport(agent: string): SystemPromptSupport {
  const row = SYSTEM_PROMPT_SUPPORT.find((candidate) => candidate.agent === agent);
  return row ? { replace: row.replace, append: row.append } : SYSTEM_PROMPT_UNSUPPORTED;
}

/** What `PromptResponse.usage` covers on each installed agent, read from its adapter source.
 *  Every source-verified agent reports THE TURN (the SDK's own type doc says "across session";
 *  the adapters do not follow it): claude-agent-acp resets its accumulator at every turn
 *  activation, codex-acp reports the turn's last token count, pi sums the assistant messages
 *  after the turn's start index. A session total is therefore the client's own running sum of
 *  per-turn reports. OpenCode ships a compiled binary: `turn` by live verification and by the
 *  client's existing per-turn accumulator contract (`usage.ts` `recordPromptUsage` replaces,
 *  never sums) only. The `scope` union has one member on purpose: exactly one arithmetic is
 *  implemented, and a second member needs a live proof before it exists. */
export interface PromptUsageScopeRow {
  readonly agent: string;
  readonly scope: "turn";
  /** Installed distributions whose usage reporting is probed by the protocol coverage suite. */
  readonly distProbe?: "claude" | "codex" | "pi";
}

const PROMPT_USAGE_SCOPE_ROWS = [
  { agent: "claude", scope: "turn", distProbe: "claude" },
  { agent: "codex", scope: "turn", distProbe: "codex" },
  { agent: "opencode", scope: "turn" },
  { agent: "pi", scope: "turn", distProbe: "pi" },
] satisfies readonly PromptUsageScopeRow[];

/** Per-built-in `PromptResponse.usage` scope. Pinned against the installed adapter dists so an
 *  adapter that starts reporting cumulative usage fails the build instead of silently doubling
 *  a client-side session sum. */
export const PROMPT_USAGE_SCOPES: readonly PromptUsageScopeRow[] = Object.freeze(
  PROMPT_USAGE_SCOPE_ROWS.map((row) => Object.freeze(row)),
);

/** Unknown agents: the ACP-client contract (`recordPromptUsage` keeps the latest per-turn report). */
const PROMPT_USAGE_SCOPE_DEFAULT: PromptUsageScopeRow = Object.freeze({ agent: "*", scope: "turn" });

function promptUsageScopeRow(agent: string): PromptUsageScopeRow {
  return PROMPT_USAGE_SCOPES.find((row) => row.agent === agent) ?? PROMPT_USAGE_SCOPE_DEFAULT;
}

/** The usage scope `agent` reports on `session/prompt`; custom agents follow the ACP-client contract. */
export function promptUsageScope(agent: string): PromptUsageScopeRow["scope"] {
  return promptUsageScopeRow(agent).scope;
}

/** One built-in's reference to universal ACP classifications and backend-specific live evidence. */
export interface BuiltinProtocolCoverageRow {
  readonly clientMethods: Readonly<Record<string, ClientMethodCoverage>>;
  readonly agentMethods: Readonly<Record<string, AgentMethodCoverage>>;
  readonly authMeta: readonly AuthMetaMatrixRow[];
  readonly extensions: readonly AcpExtensionSupportMatrixRow[];
  readonly installedDistProbes: readonly string[];
  readonly liveProbes: readonly string[];
  /** This built-in's `session/fork` disposition (the same frozen `FORK_SESSION_TRAITS` row). */
  readonly fork: ForkSessionTraitRow;
  /** This built-in's `PromptResponse.usage` scope (the same frozen `PROMPT_USAGE_SCOPES` row). */
  readonly promptUsage: PromptUsageScopeRow;
}

function coverageRow(
  id: string,
  installedDistProbes: readonly string[],
): BuiltinProtocolCoverageRow {
  return Object.freeze({
    clientMethods: CLIENT_METHOD_COVERAGE,
    agentMethods: AGENT_METHOD_COVERAGE,
    authMeta: Object.freeze(
      AUTH_META_MATRIX.filter((row) => row.agent === id || row.agent === "all"),
    ),
    extensions: Object.freeze(
      ACP_EXTENSION_SUPPORT_MATRIX.filter((row) => row.agent === id),
    ),
    installedDistProbes: Object.freeze([...installedDistProbes]),
    liveProbes: Object.freeze([id]),
    fork: forkSessionTrait(id),
    promptUsage: promptUsageScopeRow(id),
  });
}

/** Central backend dispositions. Registry tests enforce exact key and reference parity. */
export const BUILTIN_PROTOCOL_COVERAGE = Object.freeze({
  claude: coverageRow("claude", ["claude"]),
  codex: coverageRow("codex", ["codex"]),
  opencode: coverageRow("opencode", []),
  pi: coverageRow("pi", []),
});
