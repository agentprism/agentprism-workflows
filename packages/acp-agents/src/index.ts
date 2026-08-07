// @automatalabs/acp-agents — implements the AgentRunner seam from @automatalabs/shared-types over
// the Agent Client Protocol. It spawns claude-agent-acp / the installed npm dep @automatalabs/codex-acp
// (a published fork of @agentclientprotocol/codex-acp with the outputSchema forward baked into its
// dist) / OpenCode's `opencode acp` as child processes and drives one subagent run to completion. It NEVER imports
// @automatalabs/workflow-engine; the two siblings meet ONLY at AgentRunner, injected by the
// @automatalabs/workflows facade (which mcp-server builds on) via createAcpRunner().
export { AcpAgentRunner, createAcpRunner, selectBackend } from "./runner.js";
export type {
  AcpRunnerOptions,
  AuthenticateOptions,
  AuthMethodsOptions,
  AuthCapableRunner,
  AuthController,
  AuthOutcome,
  AuthStatusSnapshot,
  CompleteAuthOptions,
  DisableProviderOptions,
  DeleteSessionOptions,
  ListProvidersOptions,
  ListSessionsOptions,
  LogoutOptions,
  ProviderCapableRunner,
  ProbedConfigOptions,
  ProbeConfigOptionsOptions,
  ReattachSessionOptions,
  SetProviderOptions,
} from "./runner.js";

// Type-driven auth contracts (§1.3) and the AuthStore lifecycle spine (§2).
export { buildAuthDescriptor, buildAuthDescriptors, isGatewayShapedMeta } from "./auth/auth-types.js";
export type { AuthContext, AuthMethodDescriptor, AuthResolution, AuthResolver } from "./auth/auth-types.js";
export {
  AuthStore,
  BackendAuthMachine,
  classifyCredential,
  redactSecrets,
} from "./auth/auth-store.js";
export type {
  AuthEvent,
  AuthIntent,
  AuthMethodType,
  BackendAuthState,
  ConnectionAuthStamp,
  CredentialClass,
  RedactedIntent,
} from "./auth/auth-store.js";
// The provider-routing intent store — the providers/* sibling of the AuthStore: recorded on a
// successful setProvider, replayed on every connection's initialize, generation-gated by the pool.
export { ProviderStore } from "./provider-store.js";
export type { ProviderIntent } from "./provider-store.js";
// Per-agent auth profiles (§3): the pure-data adapters wired onto the built-in backends. Custom
// backends supply none (conformance-by-absence, §3.5).
export { claudeAuthProfile, codexAuthProfile, opencodeAuthProfile, piAuthProfile } from "./auth/auth-profiles.js";
export type { AuthProfile, TerminalLaunch } from "./auth/auth-profile.js";
export { InteractiveSession } from "./interactive.js";
export {
  LoadedTurnFailedError,
  LoadedTurnStillRunningError,
  isLoadedTurnFailedError,
  isLoadedTurnStillRunningError,
} from "./interactive.js";
export type { InteractiveSessionOptions, InteractiveTurn } from "./interactive.js";

export { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
export type {
  AgentNotificationMethod,
  AgentNotificationParamsByMethod,
  AgentAuthCapabilities,
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  AuthCapabilities,
  AuthEnvVar,
  AuthenticateRequest,
  AuthenticateResponse,
  AuthMethod,
  AuthMethodAgent,
  AuthMethodEnvVar,
  AuthMethodId,
  AuthMethodTerminal,
  DisableProviderRequest,
  DisableProviderResponse,
  CompleteElicitationNotification,
  ConnectMcpRequest,
  ConnectMcpResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DisconnectMcpRequest,
  DisconnectMcpResponse,
  ElicitationAcceptAction,
  ElicitationCapabilities,
  ElicitationContentValue,
  ElicitationFormCapabilities,
  ElicitationFormMode,
  ElicitationId,
  ElicitationPropertySchema,
  ElicitationRequestScope,
  ElicitationSchema,
  ElicitationSchemaType,
  ElicitationSessionScope,
  ElicitationUrlCapabilities,
  ElicitationUrlMode,
  ForkSessionRequest,
  ForkSessionResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LlmProtocol,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutCapabilities,
  LogoutRequest,
  LogoutResponse,
  McpConnectionId,
  McpServerAcp,
  McpServerAcpId,
  MessageMcpNotification,
  MessageMcpRequest,
  MessageMcpResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  ProviderCurrentConfig,
  ProviderId,
  ProviderInfo,
  ProvidersCapabilities,
  SessionMode,
  SessionModeState,
  SessionConfigOption,
  SessionInfo,
  SendRequestOptions,
  SetProviderRequest,
  SetProviderResponse,
} from "@agentclientprotocol/sdk";

// The custom-backend registry: run ANY ACP agent as an agent() target.
export { BACKENDS_ENV, registryWithRunBackends, resolveBackendRegistry } from "./registry.js";
export type { BackendRegistry, CustomBackendConfig, RegisteredBackend } from "./registry.js";

export {
  CANCEL_NOT_HONORED_GRACE_MS,
  PI_CHILD_CLEANUP_DEADLINE_MS,
  PI_CLOSE_DELIVERY_MARGIN_MS,
  PI_CLOSE_SESSION_TIMEOUT_MS,
  PI_DISPOSE_SIGKILL_GRACE_MS,
  PI_PROCESS_EXIT_MARGIN_MS,
  PI_PROCESS_SHUTDOWN_ENVELOPE_MS,
  PooledConnection,
  SESSION_STEERING_METHOD,
  LOADED_TURN_QUERY_METHOD,
  LOADED_TURN_ENDED_METHOD,
  SessionHandle,
  isChildCleanupError,
} from "./acp-client.js";
export type {
  AcpSessionOptions,
  PooledConnectionDeps,
  SteeringOutcome,
  SteeringRequest,
  SteeringResponse,
  LoadedTurnQueryRequest,
  LoadedTurnQueryResponse,
  LoadedTurnEndedNotification,
  LoadedTurnStatus,
} from "./acp-client.js";

export {
  AGENT_METHOD_COVERAGE,
  ACP_EXTENSION_SUPPORT_MATRIX,
  ACP_AUTH_REQUIRED_CODE_EXCLUSIVE,
  AUTH_CAPABILITY_KEYS,
  AUTH_META_CONVENTION_KEYS,
  AUTH_META_MATRIX,
  CLIENT_METHOD_COVERAGE,
  CODEX_SPAWN_AUTH_ENV,
  HANDLED_AUTH_METHOD_TYPES,
  PI_ACP_PROTOCOL_CONTRACT,
  BUILTIN_PROTOCOL_COVERAGE,
  assertAuthCapabilityShape,
} from "./protocol-coverage.js";
export type {
  AgentMethodCoverage,
  AcpExtensionSupportMatrixRow,
  AuthMetaMatrixRow,
  BuiltinProtocolCoverageRow,
  ClientMethodCoverage,
} from "./protocol-coverage.js";

// ACP capability negotiation: parse/validate the initialize response and gate what the client
// sends (custom `_meta` keys, MCP transports) on what the connected agent advertised.
export {
  GATED_CUSTOM_META_KEYS,
  adaptPromptContent,
  gateCustomMeta,
  isSupportedProtocolVersion,
  negotiateCapabilities,
  unsupportedMcpServer,
} from "./capabilities.js";
export type { NegotiatedCapabilities } from "./capabilities.js";
export { AcpAgentPool, resolvePoolSize } from "./pool.js";
export type { AcpPoolOptions, AcpPoolDeps } from "./pool.js";

// Consumer-provided client-side ACP handlers: fs/terminal routing plus truthful initialize
// clientCapabilities derived from the registered handler set.
export { clientCapabilitiesFor } from "./client-handlers.js";
export type {
  AcpSessionContext,
  ClientCapabilityOptions,
  ClientHandlers,
  FsHandlers,
  McpHandlers,
  TerminalHandlers,
} from "./client-handlers.js";

// The typed ACP event bus surfaced on AcpAgentRunner (`runner.on(name, evt => …)`).
export { ACP_CROSS_CUTTING_EVENT_NAMES, TypedEventEmitter, emitSessionUpdate } from "./events.js";
export type {
  AcpRunnerEventMap,
  AcpEventName,
  AcpEventListener,
  AcpEventContext,
  AcpEventSink,
  AcpSessionUpdate,
  AcpUpdateKind,
  AcpElicitationCompleteEvent,
  AcpElicitationEvent,
  AcpElicitationPendingEvent,
  AcpPermissionPendingEvent,
  AcpPermissionEvent,
  AcpRawMessageEvent,
  AcpSteeringEvent,
  AcpBackendErrorEvent,
} from "./events.js";

export type {
  Backend,
  BackendId,
  ProviderErrorClassification,
  ProviderErrorMetadata,
  SessionMetaInputs,
  SpawnConfig,
  StructuredSource,
} from "./backend.js";
export {
  BUILTIN_BACKENDS,
  BUILTIN_BACKEND_IDS,
  builtinBackend,
  builtinThoughtLevelDomainSemantics,
} from "./backends/builtins.js";
export type { BuiltinBackendId } from "./backends/builtins.js";
export type {
  BuiltinBackendDefinition,
  BuiltinBackendReleaseMetadata,
  ThoughtLevelDomainSemantics,
} from "./backends/define.js";
export { ClaudeBackend } from "./backends/claude.js";
export { CodexBackend } from "./backends/codex.js";
export { OpenCodeBackend } from "./backends/opencode.js";
export { PiBackend } from "./backends/pi.js";
export { CustomAcpBackend } from "./backends/custom.js";

export { decidePermission, resolvePermission, withPersist } from "./permissions.js";
export type {
  ElicitationResolver,
  PermissionPersist,
  PermissionResolution,
  PermissionResolver,
  ToolPolicy,
} from "./permissions.js";

export { UsageAccumulator } from "./usage.js";

export type { AgentSessionRef, McpAcpServerConfig, McpServerConfig } from "@automatalabs/shared-types";

export { toAnthropicJsonSchema, toJsonSchema, toStrictJsonSchema } from "./schema-strict.js";

export {
  extractValidated,
  findJsonBlock,
  parseFinalJson,
  resolveStructuredOutput,
  validateValue,
} from "./structured-output.js";
export type { ResolveOptions, StructuredSession } from "./structured-output.js";

export { ACP_AUTH_REQUIRED_ERROR_CODE, errorText, mapThrownError } from "./errors-map.js";
export type { ErrorMapContext } from "./errors-map.js";
