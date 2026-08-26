// Negotiated standard ACP capabilities for one pooled connection — the derived state the connection
// acts on after its one-time `initialize` handshake. Vendor extension metadata is preserved verbatim
// in `initializeMeta`; it is interpreted only at the feature call site that owns the extension.
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "@automatalabs/shared-types";

const PROMPT_CAPABILITY_BY_BLOCK_KIND = {
  image: "image",
  audio: "audio",
  resource: "embeddedContext",
} as const;

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
}

/** Parse an initialize response into the connection's derived capability state. */
export function negotiateCapabilities(response: InitializeResponse): NegotiatedCapabilities {
  const agent = response.agentCapabilities ?? {};
  const sessionCapabilities = agent.sessionCapabilities;
  return {
    protocolVersion: response.protocolVersion,
    agent,
    agentInfo: response.agentInfo ?? undefined,
    authMethods: response.authMethods ?? [],
    initializeMeta: response._meta ?? undefined,
    supportsClose: advertised(sessionCapabilities?.close),
    supportsLoadSession:
      agent.loadSession === true || advertised((sessionCapabilities as Record<string, unknown> | undefined)?.load),
    supportsListSessions: advertised(sessionCapabilities?.list),
    supportsDeleteSession: advertised(sessionCapabilities?.delete),
    supportsForkSession: advertised(sessionCapabilities?.fork),
    supportsResumeSession: advertised(sessionCapabilities?.resume),
    supportsLogout: advertised(agent.auth?.logout),
    supportsProviders: advertised(agent.providers),
  };
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

/** True only when the agent selected EXACTLY PROTOCOL_VERSION. This client implements that one wire
 *  version and adapts its behavior to no other, so any other selected version — older or newer —
 *  means close the connection per the ACP spec's SHOULD-close rule. Per the spec the agent echoes
 *  the requested version when it supports it, else its own latest; we do NOT accept older versions
 *  (we cannot speak them) — the equality is the whole test. */
export function isSupportedProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION;
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
