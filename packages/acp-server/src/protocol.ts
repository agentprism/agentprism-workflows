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

export const ACP_ROUTER_META_NAMESPACE = "@automatalabs/agentprism" as const;
export const ACP_ROUTER_VERSION = 1 as const;
export const ACP_BACKENDS_PROBE_METHOD = "_automatalabs/agentprism/backends/probe" as const;

const BACKEND_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;

export type RouterSelection =
  | { readonly version: 1; readonly mode: "discovery" }
  | { readonly version: 1; readonly mode: "backend"; readonly backend: string };

export interface ParsedRouterInitialize {
  readonly request: InitializeRequest;
  readonly selection: RouterSelection;
}

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

/** Validate the ACP and AgentPrism portions of the connection's first initialize request. */
export function parseRouterInitialize(params: unknown): ParsedRouterInitialize {
  const request = requireRecord(params, "initialize params") as InitializeRequest;
  if (request.protocolVersion !== PROTOCOL_VERSION) {
    throw invalidParams(`AgentPrism ACP server supports protocol version ${PROTOCOL_VERSION}`);
  }

  const clientCapabilities = requireRecord(request.clientCapabilities, "clientCapabilities");
  const capabilityMeta = requireRecord(clientCapabilities._meta, "clientCapabilities._meta");
  const capabilityNamespace = requireRecord(
    capabilityMeta[ACP_ROUTER_META_NAMESPACE],
    `clientCapabilities._meta[${JSON.stringify(ACP_ROUTER_META_NAMESPACE)}]`,
  );
  const capability = requireRecord(capabilityNamespace.acpRouter, "acpRouter client capability");
  if (
    !Array.isArray(capability.versions) ||
    !capability.versions.every((value) => Number.isSafeInteger(value)) ||
    !capability.versions.includes(ACP_ROUTER_VERSION)
  ) {
    throw invalidParams(`client must advertise AgentPrism ACP router version ${ACP_ROUTER_VERSION}`);
  }

  const requestMeta = requireRecord(request._meta, "initialize._meta");
  const requestNamespace = requireRecord(
    requestMeta[ACP_ROUTER_META_NAMESPACE],
    `initialize._meta[${JSON.stringify(ACP_ROUTER_META_NAMESPACE)}]`,
  );
  const selection = requireRecord(requestNamespace.acpRouter, "initialize acpRouter selection");
  if (selection.version !== ACP_ROUTER_VERSION) {
    throw invalidParams(`initialize must select AgentPrism ACP router version ${ACP_ROUTER_VERSION}`);
  }
  if (selection.mode === "discovery") {
    return { request, selection: { version: ACP_ROUTER_VERSION, mode: "discovery" } };
  }
  if (selection.mode !== "backend") {
    throw invalidParams('initialize acpRouter mode must be "discovery" or "backend"');
  }
  if (typeof selection.backend !== "string" || !BACKEND_ID_PATTERN.test(selection.backend)) {
    throw invalidParams(`initialize acpRouter backend must match ${BACKEND_ID_PATTERN}`);
  }
  return {
    request,
    selection: {
      version: ACP_ROUTER_VERSION,
      mode: "backend",
      backend: selection.backend,
    },
  };
}

/** Validate the redundant backend assertion required on every session/new request. */
export function assertSessionBackend(params: unknown, selectedBackend: string): void {
  const request = requireRecord(params, "session/new params");
  const meta = requireRecord(request._meta, "session/new._meta");
  const namespace = requireRecord(
    meta[ACP_ROUTER_META_NAMESPACE],
    `session/new._meta[${JSON.stringify(ACP_ROUTER_META_NAMESPACE)}]`,
  );
  const selection = requireRecord(namespace.acpRouter, "session/new acpRouter selection");
  if (selection.version !== ACP_ROUTER_VERSION || selection.backend !== selectedBackend) {
    throw invalidParams(
      `session/new must select router version ${ACP_ROUTER_VERSION} and backend ${JSON.stringify(selectedBackend)}`,
    );
  }
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
      !value.additionalDirectories.every((directory) => typeof directory === "string" && isAbsolute(directory)))
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

/** Router-owned initialize response for a discovery connection. */
export function discoveryInitializeResponse(version: string): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: {
      name: "agentprism-acp-server",
      title: "AgentPrism ACP Server",
      version,
    },
    agentCapabilities: {
      _meta: {
        [ACP_ROUTER_META_NAMESPACE]: {
          acpRouter: {
            version: ACP_ROUTER_VERSION,
            mode: "discovery",
            methods: { probeBackends: ACP_BACKENDS_PROBE_METHOD },
          },
        },
      },
    },
  };
}

/** Add the proxy's negotiated capability without changing the selected backend's response fields. */
export function mergeBackendInitializeResponse(
  response: InitializeResponse,
  backend: string,
): InitializeResponse {
  const capabilities = response.agentCapabilities ?? {};
  const capabilityMeta = capabilities._meta ?? {};
  const namespaceValue = capabilityMeta[ACP_ROUTER_META_NAMESPACE];
  const namespace = isRecord(namespaceValue) ? namespaceValue : {};
  return {
    ...response,
    agentCapabilities: {
      ...capabilities,
      _meta: {
        ...capabilityMeta,
        [ACP_ROUTER_META_NAMESPACE]: {
          ...namespace,
          acpRouter: {
            version: ACP_ROUTER_VERSION,
            mode: "backend",
            backend,
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
