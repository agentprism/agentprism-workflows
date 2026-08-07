// Negotiated ACP capabilities for one pooled connection — the derived state the connection acts on
// after its ONE-TIME `initialize` handshake. Parses the InitializeResponse + the backend's optional
// custom-capability declaration into: the agent's chosen protocolVersion (validated against what this
// client speaks), its full advertised agentCapabilities + agentInfo, whether session/close is
// supported, and the declared custom-capability advertisement (the namespaced `_meta` block gating
// which backend-declared bare `_meta` inputs the client may send). The negotiated record is a pure
// parse of (response + declaration): `gatedKeys` captures the declaration at handshake time, and
// PooledConnection gates against that captured list.
//
// GATING PHILOSOPHY — backend-declared and lenient for legacy agents. A backend with NO declaration
// has NO custom-capability contract: its custom `_meta`, if any, is never gated, even when the agent
// advertises some other backend's namespace. Once a backend declares a namespace + bare keys, an
// agent that advertises NO usable namespace block is legacy passthrough (every declared key still
// sent); malformed namespace values (non-object or arrays) are treated as not advertised. Only once
// an agent DOES advertise the declared namespace object is each declared bare key gated on its
// same-named flag === true. Symmetrically, only once an agent advertises mcpCapabilities is an
// unsupported MCP transport rejected. Truthfully-advertised absence still gates WITHIN an advertised
// capability; total silence is the legacy passthrough.
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  CODEX_META_KEYS,
  META_KEYS,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import type { Backend } from "./backend.js";

const PROMPT_CAPABILITY_BY_BLOCK_KIND = {
  image: "image",
  audio: "audio",
  resource: "embeddedContext",
} as const;

/** The bare `_meta` keys whose emission is gated by Codex's custom-capability advertisement.
 *  Each is named EXACTLY like the advertised flag that gates it, so `support[key] === true` is the
 *  whole test. session/new carries baseInstructions/developerInstructions and session/prompt carries
 *  outputSchema — one list covers both (a key absent from a given `_meta` is simply skipped). */
export const GATED_CUSTOM_META_KEYS: readonly string[] = [
  META_KEYS.outputSchema,
  CODEX_META_KEYS.baseInstructions,
  CODEX_META_KEYS.developerInstructions,
];

/** The capability state a pooled connection derives from its initialize response. */
export interface NegotiatedCapabilities {
  /** The protocol version the agent selected (echoes the client's when supported, else the agent's
   *  latest). Validated by isSupportedProtocolVersion before the connection is used. */
  protocolVersion: number;
  /** The agent's full advertised capabilities — an empty object when the agent sent none (every
   *  capability is then UNSUPPORTED per the ACP spec). */
  agent: AgentCapabilities;
  /** The agent's self-identification, when it sent agentInfo. */
  agentInfo: Implementation | undefined;
  /** Authentication methods advertised by the agent in initialize, defaulting to [] when absent. */
  authMethods: AuthMethod[];
  /** Initialize-response `_meta`, when the agent sent it. */
  initializeMeta: InitializeResponse["_meta"] | undefined;
  /** Whether the agent advertises the `_session/steering` vendor extension through the
   *  top-level initialize-response `_meta.steering.supported === true` contract. This is
   *  intentionally independent of agentCapabilities._meta, which gates outgoing custom metadata. */
  supportsSteering: boolean;
  /** Whether the agent advertises the `_session/loaded_turn` vendor extension through the
   *  top-level initialize-response `_meta.loadedTurn.supported === true` contract: the
   *  loaded-session founding-turn TERMINAL STATE channel (the re-attach arm's authoritative
   *  completion evidence — see `InteractiveSession.awaitCurrentTurn`). Same strict parse and
   *  same independence from agentCapabilities._meta as steering. */
  supportsLoadedTurnTerminalState: boolean;
  /** Whether session/close is advertised (gates the best-effort release-time close). */
  supportsClose: boolean;
  /** Whether session/load is advertised. The current SDK keeps this as the legacy top-level
   *  `loadSession` flag; tolerate a future sessionCapabilities.load shape for forward compat. */
  supportsLoadSession: boolean;
  /** Whether session/list is advertised. */
  supportsListSessions: boolean;
  /** Whether session/delete is advertised. */
  supportsDeleteSession: boolean;
  /** Whether `session/fork` is advertised via `sessionCapabilities.fork`. UNSTABLE in the SDK. */
  supportsForkSession: boolean;
  /** Whether session/resume is advertised. */
  supportsResumeSession: boolean;
  /** Whether logout is advertised under agentCapabilities.auth.logout. */
  supportsLogout: boolean;
  /** Whether the unstable provider-configuration block is advertised. */
  supportsProviders: boolean;
  /** The parsed backend-declared custom-capability block (the namespaced `_meta` object), or
   *  undefined when the backend declared none or the agent did not advertise it — passthrough. */
  customMetaSupport: Record<string, unknown> | undefined;
  /** The backend-declared bare `_meta` keys gated by customMetaSupport; undefined when this backend
   *  has no custom-capability contract, so custom `_meta` is never gated. */
  gatedKeys: readonly string[] | undefined;
}

/** Parse an initialize response into the connection's derived capability state. */
export function negotiateCapabilities(
  response: InitializeResponse,
  customCapabilities?: Backend["customCapabilities"],
): NegotiatedCapabilities {
  const agent = response.agentCapabilities ?? {};
  const sessionCapabilities = agent.sessionCapabilities;
  return {
    protocolVersion: response.protocolVersion,
    agent,
    agentInfo: response.agentInfo ?? undefined,
    authMethods: response.authMethods ?? [],
    initializeMeta: response._meta ?? undefined,
    // Steering is an initialize-response extension advertisement. Never infer it from the
    // backend name/version or from agentCapabilities._meta (the separate outgoing-meta gate).
    supportsSteering: advertisesSteering(response._meta),
    // The loaded-turn terminal-state extension rides the same initialize-response `_meta`
    // advertisement channel (strict `loadedTurn.supported === true`), never inferred.
    supportsLoadedTurnTerminalState: advertisesLoadedTurn(response._meta),
    supportsClose: advertised(sessionCapabilities?.close),
    supportsLoadSession:
      agent.loadSession === true || advertised((sessionCapabilities as Record<string, unknown> | undefined)?.load),
    supportsListSessions: advertised(sessionCapabilities?.list),
    supportsDeleteSession: advertised(sessionCapabilities?.delete),
    supportsForkSession: advertised(sessionCapabilities?.fork),
    supportsResumeSession: advertised(sessionCapabilities?.resume),
    supportsLogout: advertised(agent.auth?.logout),
    supportsProviders: advertised(agent.providers),
    customMetaSupport: customCapabilities
      ? readCustomNamespace(agent._meta, customCapabilities.namespace)
      : undefined,
    gatedKeys: customCapabilities ? [...customCapabilities.gatedKeys] : undefined,
  };
}

/** Strict, defensive parser for the top-level loaded-turn extension advertisement. Only the
 *  exact boolean true is support; absent, null, malformed, array, string, numeric, and truthy
 *  values are all unsupported. */
function advertisesLoadedTurn(meta: InitializeResponse["_meta"]): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const loadedTurn = (meta as Record<string, unknown>).loadedTurn;
  return Boolean(
    loadedTurn &&
      typeof loadedTurn === "object" &&
      !Array.isArray(loadedTurn) &&
      (loadedTurn as Record<string, unknown>).supported === true,
  );
}

/** Strict, defensive parser for the top-level steering extension advertisement. Only the exact
 *  boolean true is support; absent, null, malformed, array, string, numeric, and truthy values are
 *  all unsupported. */
function advertisesSteering(meta: InitializeResponse["_meta"]): boolean {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const steering = (meta as Record<string, unknown>).steering;
  return Boolean(
    steering &&
      typeof steering === "object" &&
      !Array.isArray(steering) &&
      (steering as Record<string, unknown>).supported === true,
  );
}

function advertised(capability: unknown): boolean {
  return capability !== undefined && capability !== null && capability !== false;
}

/** Human-readable lifecycle advertisement summary for strict wrapper gate errors. */
export function describeLifecycleAdvertisement(agent: AgentCapabilities): string {
  const sessionCapabilities = agent.sessionCapabilities;
  const session = [
    ["close", sessionCapabilities?.close],
    ["list", sessionCapabilities?.list],
    ["delete", sessionCapabilities?.delete],
    ["resume", sessionCapabilities?.resume],
    ["fork", sessionCapabilities?.fork],
    ["additionalDirectories", sessionCapabilities?.additionalDirectories],
    ["load", (sessionCapabilities as Record<string, unknown> | undefined)?.load],
  ]
    .filter(([, value]) => advertised(value))
    .map(([name]) => name);
  return [
    `loadSession=${agent.loadSession === true ? "true" : "false"}`,
    `sessionCapabilities=${session.length > 0 ? session.join(", ") : "none"}`,
  ].join("; ");
}

/** Human-readable auth/provider advertisement summary for strict wrapper gate errors. */
export function describeAuthProviderAdvertisement(
  agent: AgentCapabilities,
  authMethods: readonly AuthMethod[] = [],
): string {
  const methodIds = authMethods.map((method) => method.id).filter(Boolean);
  return [
    `authMethods=${methodIds.length > 0 ? methodIds.join(", ") : "none"}`,
    `auth.logout=${advertised(agent.auth?.logout) ? "true" : "false"}`,
    `providers=${advertised(agent.providers) ? "true" : "false"}`,
  ].join("; ");
}

/** Human-readable summary of the CLIENT-side auth advertisement this runner sends at initialize —
 *  the symmetric counterpart to describeAuthProviderAdvertisement (the agent side). Used for
 *  error/diagnostic text (§1.2); reads only the pinned boolean gates, never any secret. Renders
 *  e.g. `auth.terminal=true; auth._meta.gateway=true; _meta["terminal-auth"]=true`, or `auth=none`
 *  when nothing is advertised. */
export function describeClientAuthAdvertisement(
  auth: ClientCapabilities["auth"],
  meta: ClientCapabilities["_meta"],
): string {
  const parts: string[] = [];
  if (auth?.terminal === true) parts.push("auth.terminal=true");
  const gateway = (auth?._meta as Record<string, unknown> | null | undefined)?.gateway;
  if (gateway === true) parts.push("auth._meta.gateway=true");
  const terminalAuth = (meta as Record<string, unknown> | null | undefined)?.["terminal-auth"];
  if (terminalAuth === true) parts.push('_meta["terminal-auth"]=true');
  return parts.length > 0 ? parts.join("; ") : "auth=none";
}

function readCustomNamespace(
  meta: AgentCapabilities["_meta"],
  namespace: string,
): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const block = (meta as Record<string, unknown>)[namespace];
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

/** True only when the agent selected EXACTLY PROTOCOL_VERSION. This client implements that one wire
 *  version and adapts its behavior to no other, so any other selected version — older or newer —
 *  means close the connection per the ACP spec's SHOULD-close rule. Per the spec the agent echoes
 *  the requested version when it supports it, else its own latest; we do NOT accept older versions
 *  (we cannot speak them) — the equality is the whole test. */
export function isSupportedProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
}

/** Remove the declared custom bare `_meta` keys the connected agent did NOT advertise support for.
 *  A no-op when the agent advertised no namespace (`support` undefined => legacy => every key
 *  passes) or the meta is empty/undefined. Never mutates its input; collapses to undefined if
 *  gating empties the object (so no `_meta` is sent at all). */
export function gateCustomMeta(
  meta: Record<string, unknown> | undefined,
  support: Record<string, unknown> | undefined,
  gatedKeys: readonly string[] = GATED_CUSTOM_META_KEYS,
): Record<string, unknown> | undefined {
  if (!meta || !support) return meta;
  let gated: Record<string, unknown> | undefined;
  for (const key of gatedKeys) {
    if (key in meta && support[key] !== true) {
      gated ??= { ...meta };
      delete gated[key];
    }
  }
  const result = gated ?? meta;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Adapt prompt content to the agent's PromptCapabilities. ACP baseline content (text and
 *  resource_link) is never gated; optional blocks follow the spec's capability table:
 *  image->promptCapabilities.image, audio->promptCapabilities.audio, and resource->
 *  promptCapabilities.embeddedContext. Unsupported optional blocks are represented as explicit
 *  bracketed text notes so context is never silently lost. Returns the SAME array reference when
 *  no block changes and never mutates the input or any surviving block. */
export function adaptPromptContent(
  blocks: ContentBlock[],
  agent: AgentCapabilities,
  backendId: string,
): ContentBlock[] {
  let adapted: ContentBlock[] | undefined;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const replacement = unsupportedPromptBlockNote(block, agent, backendId);
    if (replacement) {
      adapted ??= blocks.slice(0, i);
      adapted.push(replacement);
    } else if (adapted) {
      adapted.push(block);
    }
  }

  return adapted ?? blocks;
}

function unsupportedPromptBlockNote(
  block: ContentBlock,
  agent: AgentCapabilities,
  backendId: string,
): ContentBlock | undefined {
  const capability =
    PROMPT_CAPABILITY_BY_BLOCK_KIND[block.type as keyof typeof PROMPT_CAPABILITY_BY_BLOCK_KIND];
  if (!capability || agent.promptCapabilities?.[capability] === true) return undefined;

  switch (block.type) {
    case "image": {
      const uriSuffix = typeof block.uri === "string" && block.uri.length > 0 ? `; uri=${block.uri}` : "";
      return {
        type: "text",
        text: `[image omitted: ${block.mimeType}${uriSuffix} — the ${backendId} agent does not advertise promptCapabilities.image]`,
      };
    }
    case "audio":
      return {
        type: "text",
        text: `[audio omitted: ${block.mimeType} — the ${backendId} agent does not advertise promptCapabilities.audio]`,
      };
    case "resource":
      return {
        type: "text",
        text: `[resource omitted: uri=${block.resource.uri} — the ${backendId} agent does not advertise promptCapabilities.embeddedContext]`,
      };
    default:
      return undefined;
  }
}

/** The first client-provided MCP server whose transport cannot be served, or undefined when every
 *  server is serviceable. stdio is ALWAYS serviceable (the baseline transport); http/sse keep the
 *  legacy leniency and gate only after any mcpCapabilities block exists. ACP transport is stricter:
 *  both sides must be explicit because the client is the MCP server host and an unwired declaration
 *  would otherwise spend tokens before failing at mcp/connect. */
export function unsupportedMcpServer(
  servers: McpServerConfig[] | undefined,
  agent: AgentCapabilities,
  options: { clientCanServeAcp?: boolean } = {},
): { name: string; transport: "http" | "sse" | "acp"; reason?: "client" } | undefined {
  const mcp = agent.mcpCapabilities;
  if (!servers) return undefined;
  for (const server of servers) {
    if ("type" in server && server.type === "http" && mcp && mcp.http !== true) {
      return { name: server.name, transport: "http" };
    }
    if ("type" in server && server.type === "sse" && mcp && mcp.sse !== true) {
      return { name: server.name, transport: "sse" };
    }
    if ("type" in server && server.type === "acp" && mcp?.acp !== true) {
      return { name: server.name, transport: "acp" };
    }
    if ("type" in server && server.type === "acp" && options.clientCanServeAcp !== true) {
      return { name: server.name, transport: "acp", reason: "client" };
    }
  }
  return undefined;
}
