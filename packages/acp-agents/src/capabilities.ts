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
  type Implementation,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  CODEX_META_KEYS,
  META_KEYS,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import type { Backend } from "./backend.js";

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
  /** Whether session/close is advertised (gates the best-effort release-time close). */
  supportsClose: boolean;
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
  return {
    protocolVersion: response.protocolVersion,
    agent,
    agentInfo: response.agentInfo ?? undefined,
    supportsClose: Boolean(agent.sessionCapabilities?.close),
    customMetaSupport: customCapabilities
      ? readCustomNamespace(agent._meta, customCapabilities.namespace)
      : undefined,
    gatedKeys: customCapabilities ? [...customCapabilities.gatedKeys] : undefined,
  };
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

/** The first client-provided MCP server whose transport the agent did NOT advertise, or undefined
 *  when every server is serviceable. stdio is ALWAYS serviceable (the baseline transport); http/sse
 *  are gated on mcpCapabilities.{http,sse}. Lenient for legacy agents: when the agent advertised no
 *  mcpCapabilities at all we cannot know its transports, so we do not gate (preserving today's
 *  send-and-let-the-agent-decide behavior for minimal/custom servers). */
export function unsupportedMcpServer(
  servers: McpServerConfig[] | undefined,
  agent: AgentCapabilities,
): { name: string; transport: "http" | "sse" } | undefined {
  const mcp = agent.mcpCapabilities;
  if (!mcp || !servers) return undefined;
  for (const server of servers) {
    if ("type" in server && server.type === "http" && mcp.http !== true) {
      return { name: server.name, transport: "http" };
    }
    if ("type" in server && server.type === "sse" && mcp.sse !== true) {
      return { name: server.name, transport: "sse" };
    }
  }
  return undefined;
}
