// Negotiated ACP capabilities for one pooled connection — the derived state the connection acts on
// after its ONE-TIME `initialize` handshake. Parses the InitializeResponse into: the agent's chosen
// protocolVersion (validated against what this client speaks), its full advertised agentCapabilities
// + agentInfo, whether session/close is supported, and the @automatalabs/codex-acp fork's custom
// capability advertisement (the namespaced `_meta` block gating which bare `_meta` inputs the client
// may send).
//
// GATING PHILOSOPHY — lenient for legacy agents. An agent that advertises NOTHING is treated as
// today's behavior (every gated key still sent), because the currently-published fork
// (@automatalabs/codex-acp ≤ 1.2.0) and arbitrary custom ACP servers honor these inputs WITHOUT
// advertising them; a strict "omitted => unsupported" reading would silently regress them. Only once
// an agent DOES advertise the fork namespace (opts into negotiation) is each bare key gated on its
// same-named flag — and, symmetrically, only once an agent advertises mcpCapabilities is an
// unsupported MCP transport rejected. Truthfully-advertised absence still gates (per spec) WITHIN an
// advertised capability; total silence is the legacy passthrough.
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type Implementation,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  CODEX_CUSTOM_CAPABILITY_NAMESPACE,
  CODEX_META_KEYS,
  META_KEYS,
  type McpServerConfig,
} from "@automatalabs/shared-types";

/** The bare `_meta` keys whose emission is gated by the fork's custom-capability advertisement.
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
  /** The parsed @automatalabs/codex-acp custom-capability block (the namespaced `_meta` object), or
   *  undefined when the agent did not advertise the namespace at all — the legacy passthrough. */
  customMetaSupport: Record<string, unknown> | undefined;
}

/** Parse an initialize response into the connection's derived capability state. */
export function negotiateCapabilities(response: InitializeResponse): NegotiatedCapabilities {
  const agent = response.agentCapabilities ?? {};
  return {
    protocolVersion: response.protocolVersion,
    agent,
    agentInfo: response.agentInfo ?? undefined,
    supportsClose: Boolean(agent.sessionCapabilities?.close),
    customMetaSupport: readCustomNamespace(agent._meta),
  };
}

function readCustomNamespace(meta: AgentCapabilities["_meta"]): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const block = (meta as Record<string, unknown>)[CODEX_CUSTOM_CAPABILITY_NAMESPACE];
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

/** Remove the fork's custom bare `_meta` keys the connected agent did NOT advertise support for.
 *  A no-op when the agent advertised no namespace (`support` undefined => legacy => every key
 *  passes) or the meta is empty/undefined. Never mutates its input; collapses to undefined if
 *  gating empties the object (so no `_meta` is sent at all). */
export function gateCustomMeta(
  meta: Record<string, unknown> | undefined,
  support: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta || !support) return meta;
  let gated: Record<string, unknown> | undefined;
  for (const key of GATED_CUSTOM_META_KEYS) {
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
