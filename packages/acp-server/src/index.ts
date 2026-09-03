export { serveAcpServer } from "./server.js";
export type { ServeAcpServerOptions } from "./server.js";

export {
  DEFAULT_ACP_HTTP_HOST,
  DEFAULT_ACP_HTTP_PATH,
  DEFAULT_ACP_HTTP_PORT,
  listenAcpHttpServer,
} from "./http-server.js";
export type { AcpHttpServerHandle, ListenAcpHttpServerOptions } from "./http-server.js";

export { resolveBackendTargets } from "./backends.js";
export type { BackendTarget, ResolveBackendTargetsOptions } from "./backends.js";

export {
  ACP_BACKENDS_PROBE_METHOD,
  ACP_ROUTER_META_NAMESPACE,
  ACP_ROUTER_VERSION,
  assertSessionBackend,
  discoveryInitializeResponse,
  mergeBackendInitializeResponse,
  parseProbeBackendsParams,
  parseRouterInitialize,
} from "./protocol.js";
export type {
  BackendProbe,
  ParsedRouterInitialize,
  ProbeBackendsParams,
  ProbeBackendsResult,
  RouterSelection,
} from "./protocol.js";
