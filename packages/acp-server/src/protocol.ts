import { isAbsolute } from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";

export const ACP_META_NAMESPACE = "@automatalabs/agentprism" as const;
export const ACP_BACKEND_DISCOVERY_VERSION = 1 as const;
export const ACP_BACKENDS_PROBE_METHOD = "_automatalabs/agentprism/backends/probe" as const;

export interface ProbeBackendsParams {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers: McpServer[];
  _meta?: Record<string, unknown> | null;
}

export type BackendProbe =
  | {
      id: string;
      name: string;
      available: true;
      agentInfo?: Implementation | null;
      agentCapabilities?: AgentCapabilities;
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
      initializeMeta?: Record<string, unknown> | null;
      sessionMeta?: Record<string, unknown> | null;
    }
  | {
      id: string;
      name: string;
      available: false;
      stage: "initialize" | "session/new";
      error: string;
    };

export interface ProbeBackendsResult {
  backends: BackendProbe[];
}

/** Validate the standard ACP portion of the connection's first initialize request. */
export function parseAcpV1Initialize(params: unknown): InitializeRequest {
  const request = requireRecord(params, "initialize params") as InitializeRequest;
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw invalidParams(`AgentPrism ACP server supports protocol version ${PROTOCOL_VERSION}`);
  }
  return request;
}

/** Validate and copy the temporary session inputs accepted by the discovery probe. */
export function parseProbeBackendsParams(params: unknown): ProbeBackendsParams {
  const value = requireRecord(params, "probe params");
  if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw invalidParams("probe cwd must be an absolute path");
  }
  if (!Array.isArray(value.mcpServers)) {
    throw invalidParams("probe mcpServers must be an array");
  }
  if (
    value.additionalDirectories !== undefined &&
    (!Array.isArray(value.additionalDirectories) ||
      !value.additionalDirectories.every(
        (directory) => typeof directory === "string" && isAbsolute(directory),
      ))
  ) {
    throw invalidParams("probe additionalDirectories must contain only absolute paths");
  }
  if (value._meta !== undefined && value._meta !== null && !isRecord(value._meta)) {
    throw invalidParams("probe _meta must be an object or null");
  }
  return {
    cwd: value.cwd,
    mcpServers: value.mcpServers as McpServer[],
    ...(value.additionalDirectories === undefined
      ? {}
      : { additionalDirectories: [...(value.additionalDirectories as string[])] }),
    ...(value._meta === undefined ? {} : { _meta: value._meta as Record<string, unknown> | null }),
  };
}

/** Initialize response for the dedicated backend-discovery endpoint. */
export function discoveryInitializeResponse(version: string): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "agentprism-acp-server",
      title: "AgentPrism ACP Server Discovery",
      version,
    },
    agentCapabilities: {
      _meta: {
        [ACP_META_NAMESPACE]: {
          backendDiscovery: {
            version: ACP_BACKEND_DISCOVERY_VERSION,
            methods: { probeBackends: ACP_BACKENDS_PROBE_METHOD },
          },
        },
      },
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidParams(`${field} must be an object`);
  return value;
}

function invalidParams(message: string): RequestError {
  return RequestError.invalidParams(undefined, message);
}
