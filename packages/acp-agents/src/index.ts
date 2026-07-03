// @automatalabs/acp-agents — implements the AgentRunner seam from @automatalabs/shared-types over
// the Agent Client Protocol. It spawns claude-agent-acp / the installed npm dep @automatalabs/codex-acp
// (a published fork of @agentclientprotocol/codex-acp with the outputSchema forward baked into its
// dist) as child processes and drives one subagent run to completion. It NEVER imports
// @automatalabs/workflow-engine; the two siblings meet ONLY at AgentRunner, injected by the
// @automatalabs/workflows facade (which mcp-server builds on) via createAcpRunner().
export { AcpAgentRunner, createAcpRunner, selectBackend } from "./runner.js";
export type { AcpRunnerOptions } from "./runner.js";

// The custom-backend registry: run ANY ACP agent as an agent() target.
export { BACKENDS_ENV, registryWithRunBackends, resolveBackendRegistry } from "./registry.js";
export type { BackendRegistry, CustomBackendConfig, RegisteredBackend } from "./registry.js";

export { PooledConnection, SessionHandle } from "./acp-client.js";
export type { AcpSessionOptions, PooledConnectionDeps } from "./acp-client.js";

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
export type { AcpSessionContext, ClientHandlers, FsHandlers, TerminalHandlers } from "./client-handlers.js";

// The typed ACP event bus surfaced on AcpAgentRunner (`runner.on(name, evt => …)`).
export { TypedEventEmitter, emitSessionUpdate } from "./events.js";
export type {
  AcpRunnerEventMap,
  AcpEventName,
  AcpEventListener,
  AcpEventContext,
  AcpEventSink,
  AcpSessionUpdate,
  AcpUpdateKind,
  AcpPermissionEvent,
  AcpRawMessageEvent,
  AcpBackendErrorEvent,
} from "./events.js";

export type {
  Backend,
  BackendId,
  BuiltinBackendId,
  SessionMetaInputs,
  SpawnConfig,
  StructuredSource,
} from "./backend.js";
export { ClaudeBackend } from "./backends/claude.js";
export { CodexBackend } from "./backends/codex.js";
export { CustomAcpBackend } from "./backends/custom.js";

export { decidePermission } from "./permissions.js";
export type { ToolPolicy } from "./permissions.js";

export { UsageAccumulator } from "./usage.js";

export { toJsonSchema, toStrictJsonSchema } from "./schema-strict.js";

export {
  extractValidated,
  findJsonBlock,
  parseFinalJson,
  resolveStructuredOutput,
  validateValue,
} from "./structured-output.js";
export type { ResolveOptions, StructuredSession } from "./structured-output.js";

export { errorText, mapThrownError } from "./errors-map.js";
