/// <reference path="./dsl.d.ts" />
// @automatalabs/workflows — the importable SDK for the AgentPrism dynamic-workflow
// orchestrator. A FACADE re-export barrel: it re-exports the clean public surface of
// the three engine packages, adds the SDK-level WorkflowManager ACP-event bridge, and
// adds ONE convenience helper (`runDynamicWorkflow`) that defaults the AgentRunner seam
// to the ACP backend. It is SEPARATE from @automatalabs/mcp-server (the stdio MCP server)
// and stays a PURE library — it pulls in neither @modelcontextprotocol/sdk nor zod.
//
// The DSL globals available INSIDE a workflow script (agent, parallel, pipeline, …) are
// vm-realm globals, NOT importable symbols; they are documented for author IntelliSense
// in ./dsl.d.ts (referenced above), not exported here.

import { ACP_CROSS_CUTTING_EVENT_NAMES, createAcpRunner } from "@automatalabs/acp-agents";
import {
  openWorkflowDir,
  parseWorkflowScript,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager as EngineWorkflowManager,
} from "@automatalabs/workflow-engine";
import type { AcpEventListener, AcpEventName, AcpRunnerEventMap, AcpUpdateKind } from "@automatalabs/acp-agents";
import type { ExecOptions, WorkflowDir, WorkflowManagerOptions } from "@automatalabs/workflow-engine";
import type { AgentRunner, WorkflowBackendConfig, WorkflowRunResult } from "@automatalabs/shared-types";

type OwnedAcpRunner = AgentRunner & { dispose: () => Promise<void> };

// ── Engine: run entry, script parsing, the managed-run lifecycle, and the
//    option/result + error types the host composes against. ──
export { runWorkflow, parseWorkflowScript } from "@automatalabs/workflow-engine";

// ── Workflow directory view: openWorkflowDir("./workflows") binds a read-only,
//    per-call-fresh view over folders of versioned workflow scripts (name = filename
//    stem). `view.resolve` IS a loadSavedWorkflow resolver; runDynamicWorkflow accepts
//    the view (or dir paths) via `workflows` to serve top-level names AND nested
//    workflow("<name>") calls. ──
export {
  openWorkflowDir,
  type WorkflowDir,
  type WorkflowDirEntry,
  type OpenWorkflowDirOptions,
} from "@automatalabs/workflow-engine";

// ── Token-free script validation: static parse + mock-runner dry run. Also the core of
//    the `agentprism-workflows validate` CLI (./cli.ts). ──
export { validateWorkflowScript, fabricateFromSchema, formatValidateReport, MOCK_TOKENS_PER_AGENT } from "./validate.js";
export type {
  ValidateWorkflowOptions,
  ValidateWorkflowReport,
  ValidatedAgentCall,
  ValidatedCheckpoint,
} from "./validate.js";
export type {
  WorkflowRunOptions,
  AgentOptions,
  ExecOptions,
  WorkflowManagerOptions,
  CheckpointOptions,
  WorkflowRunResult,
  WorkflowSnapshot,
  WorkflowPathOptions,
  RunPersistence,
  RunPersistenceOptions,
  PersistedRunState,
  PersistedAgentState,
} from "@automatalabs/workflow-engine";
export {
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
} from "@automatalabs/workflow-engine";

// ── ACP backend: the default AgentRunner implementation, interactive sessions, backend
//    selection, the concrete backends (built-in + custom registry), the pool/runner options,
//    capability helpers, client handlers, permission resolvers, and JSON-Schema helpers.
//    Custom backends let ANY ACP agent serve agent() calls:
//    `createAcpRunner({ backends: { browser: { command: "…" } } })` (or the
//    AGENTPRISM_BACKENDS env var), then route with `agent(p, { model: "browser" })`. ──
export {
  createAcpRunner,
  AcpAgentRunner,
  InteractiveSession,
  selectBackend,
  ClaudeBackend,
  CodexBackend,
  CustomAcpBackend,
  AGENT_METHODS,
  CLIENT_METHODS,
  AGENT_METHOD_COVERAGE,
  CLIENT_METHOD_COVERAGE,
  ACP_AUTH_REQUIRED_ERROR_CODE,
  clientCapabilitiesFor,
  adaptPromptContent,
  resolveBackendRegistry,
  BACKENDS_ENV,
  toJsonSchema,
  toStrictJsonSchema,
} from "@automatalabs/acp-agents";
export type {
  AcpPoolOptions,
  AcpRunnerOptions,
  AuthenticateOptions,
  AuthMethodsOptions,
  DisableProviderOptions,
  DeleteSessionOptions,
  InteractiveSessionOptions,
  InteractiveTurn,
  ListProvidersOptions,
  ListSessionsOptions,
  LogoutOptions,
  ReattachSessionOptions,
  SetProviderOptions,
  BackendRegistry,
  CustomBackendConfig,
  RegisteredBackend,
  ClientCapabilityOptions,
  ClientHandlers,
  FsHandlers,
  McpHandlers,
  TerminalHandlers,
  AcpSessionContext,
  NegotiatedCapabilities,
  PermissionResolver,
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
  ConnectMcpRequest,
  ConnectMcpResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DisableProviderRequest,
  DisableProviderResponse,
  DisconnectMcpRequest,
  DisconnectMcpResponse,
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
  ProviderCurrentConfig,
  ProviderId,
  ProviderInfo,
  ProvidersCapabilities,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetProviderRequest,
  SetProviderResponse,
  AgentNotificationMethod,
  AgentNotificationParamsByMethod,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationAcceptAction,
  ElicitationCapabilities,
  ElicitationContentValue,
  ElicitationFormCapabilities,
  ElicitationFormMode,
  ElicitationId,
  ElicitationPropertySchema,
  ElicitationRequestScope,
  ElicitationResolver,
  ElicitationSchema,
  ElicitationSchemaType,
  ElicitationSessionScope,
  ElicitationUrlCapabilities,
  ElicitationUrlMode,
  SessionMode,
  SessionModeState,
  SessionInfo,
  SendRequestOptions,
  AgentMethodCoverage,
  ClientMethodCoverage,
} from "@automatalabs/acp-agents";

// ── Type-driven auth surface (§4.2): the runner-facing auth contracts hosts consume through this
//    facade. mcp-server imports these here (its only @automatalabs deps are `workflows` and
//    `shared-types`), so the type re-exports land with PR5 — the MCP auth tools cannot compile
//    without them. The `isAuthRequired` VALUE export lands with PR6. ──
export type {
  AuthResolver,
  AuthContext,
  AuthResolution,
  AuthMethodDescriptor,
  CompleteAuthOptions,
  AuthOutcome,
  AuthController,
  AuthStatusSnapshot,
  AuthCapableRunner,
} from "@automatalabs/acp-agents";
export type { AuthErrorContext, CheckpointContext } from "@automatalabs/shared-types"; // via workflow-engine re-export (§1.5)

// ── Live ACP events: `createAcpRunner().on("tool_call", evt => …)` to listen in on the
//    stream of a run. The event map keys are ACP `sessionUpdate` discriminants plus a few
//    cross-cutting events; each payload carries a `{ sessionId, backendId, label?, runId? }`
//    context envelope so a pooled runner's concurrent runs are disambiguable. ──
export { TypedEventEmitter } from "@automatalabs/acp-agents";
export type {
  AcpRunnerEventMap,
  AcpEventName,
  AcpEventListener,
  AcpEventContext,
  AcpSessionUpdate,
  AcpUpdateKind,
  AcpElicitationCompleteEvent,
  AcpElicitationEvent,
  AcpElicitationPendingEvent,
  AcpPermissionPendingEvent,
  AcpPermissionEvent,
  AcpRawMessageEvent,
  AcpBackendErrorEvent,
} from "@automatalabs/acp-agents";

// ── Shared seam types: the AgentRunner contract and its opts/result/usage shapes,
//    so callers can implement or type a custom runner without reaching past the SDK. ──
export type {
  AgentRunner,
  McpAcpServerConfig,
  McpServerConfig,
  RunOptions,
  AgentResult,
  AgentUsage,
} from "@automatalabs/shared-types";
export type { AgentSessionRecord, AgentSessionRef, JournalEntry, WorkflowBackendConfig, WorkflowMeta } from "@automatalabs/shared-types";

/** Cross-cutting runner events the manager forwards alongside ACP `session/update` traffic. */
type ManagerAcpCrossCuttingEventName = Exclude<AcpEventName, AcpUpdateKind | "session_update">;
const MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES =
  ACP_CROSS_CUTTING_EVENT_NAMES satisfies readonly ManagerAcpCrossCuttingEventName[];
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type _ManagerAcpCrossCuttingEventNamesComplete = Assert<
  IsNever<Exclude<ManagerAcpCrossCuttingEventName, (typeof MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES)[number]>>
>;
type _ManagerAcpCrossCuttingEventNamesExact = Assert<
  IsNever<Exclude<(typeof MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES)[number], ManagerAcpCrossCuttingEventName>>
>;

type AcpEventBusRunner = AgentRunner & {
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void;
};

interface AcpBridgeEntry {
  refs: number;
  unsubscribers: Array<() => void>;
}

type ContextProperty<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type OptionalContextProperty<T, K extends PropertyKey> = K extends keyof T ? T[K] : undefined;

/** Payload of `WorkflowManager`'s `agentEvent` observer. `event` is the verbatim runner event
 *  payload; the top-level envelope repeats the ACP context fields hosts filter on. `backend_error`
 *  is connection-scoped in acp-agents and therefore has no session/run context to repeat. */
type AgentEventPayloadMap = {
  [K in AcpEventName]: {
    name: K;
    event: AcpRunnerEventMap[K];
    backendId: ContextProperty<AcpRunnerEventMap[K], "backendId">;
  } & ("sessionId" extends keyof AcpRunnerEventMap[K]
    ? { sessionId: ContextProperty<AcpRunnerEventMap[K], "sessionId"> }
    : { sessionId?: undefined }) & {
      label?: OptionalContextProperty<AcpRunnerEventMap[K], "label">;
      runId?: OptionalContextProperty<AcpRunnerEventMap[K], "runId">;
    };
};
export type AgentEventPayload<K extends AcpEventName = AcpEventName> = AgentEventPayloadMap[K];

/**
 * Stateful workflow manager exported by the SDK facade. It is the workflow-engine manager plus
 * ONE composition-root bridge for ACP-capable runners: when the injected AgentRunner also exposes
 * the acp-agents `.on(name, listener)` bus, the manager forwards that live stream as `agentEvent`.
 *
 * The engine package stays backend-agnostic; this facade already owns the ACP default runner and
 * ACP event types, so the bridge belongs here. Forwarding is OBSERVABILITY ONLY: manager
 * `agentEvent` listeners are isolated from each other and from the run, and `dispose()` removes
 * only the manager's runner subscriptions (runner process ownership stays with the caller).
 */
export class WorkflowManager extends EngineWorkflowManager {
  private readonly acpBridges = new Map<AcpEventBusRunner, AcpBridgeEntry>();

  constructor(options: WorkflowManagerOptions = {}) {
    super(options);
    this.acquireAcpRunnerBridge(options.agent);
  }

  override startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const releaseBridge = this.acquireAcpRunnerBridge(exec.agent);
    try {
      const started = super.startInBackground(script, args, exec);
      void started.promise.then(releaseBridge, releaseBridge);
      return started;
    } catch (error) {
      releaseBridge();
      throw error;
    }
  }

  override async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const releaseBridge = this.acquireAcpRunnerBridge(exec.agent);
    try {
      return await super.runSync(script, args, exec);
    } finally {
      releaseBridge();
    }
  }

  override async resumeInBackground(
    runId: string,
    exec: ExecOptions = {},
  ): Promise<
    | { accepted: false; promise?: undefined }
    | { accepted: true; promise: Promise<WorkflowRunResult> }
  > {
    const releaseBridge = this.acquireAcpRunnerBridge(exec.agent);
    try {
      const resumed = await super.resumeInBackground(runId, exec);
      if (!resumed.accepted) {
        releaseBridge();
        return resumed;
      }
      void resumed.promise.then(releaseBridge, releaseBridge);
      return resumed;
    } catch (error) {
      releaseBridge();
      throw error;
    }
  }

  override async resume(runId: string, exec: ExecOptions = {}): Promise<boolean> {
    const { accepted } = await this.resumeInBackground(runId, exec);
    return accepted;
  }

  /** Detach manager-owned ACP event subscriptions. The manager does NOT dispose the runner: the
   *  caller may share one runner across managers or own its process lifetime explicitly. */
  dispose(): void {
    for (const bridge of this.acpBridges.values()) {
      for (const unsubscribe of bridge.unsubscribers) unsubscribe();
    }
    this.acpBridges.clear();
  }

  /** Node-style alias for hosts that tear down managers through close hooks. */
  close(): void {
    this.dispose();
  }

  private acquireAcpRunnerBridge(agent: AgentRunner | undefined): () => void {
    if (!isAcpEventBusRunner(agent)) return () => {};
    let bridge = this.acpBridges.get(agent);
    if (!bridge) {
      bridge = {
        refs: 0,
        unsubscribers: [
          agent.on("session_update", (event) => {
            this.emit("agentEvent", toSessionUpdateAgentEventPayload(event));
          }),
          ...MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES.map((name) =>
            agent.on(name, (event) => {
              this.emit("agentEvent", toAgentEventPayload(name, event));
            }),
          ),
        ],
      };
      this.acpBridges.set(agent, bridge);
    }
    bridge.refs++;

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.acpBridges.get(agent);
      if (current !== bridge) return;
      current.refs--;
      if (current.refs > 0) return;
      for (const unsubscribe of current.unsubscribers) unsubscribe();
      this.acpBridges.delete(agent);
    };
  }
}

function isAcpEventBusRunner(agent: AgentRunner | undefined): agent is AcpEventBusRunner {
  return typeof (agent as Partial<Record<"on", unknown>> | undefined)?.on === "function";
}

function toSessionUpdateAgentEventPayload(
  event: AcpRunnerEventMap["session_update"],
): AgentEventPayload<AcpUpdateKind> {
  const name = event.update.sessionUpdate;
  return toAgentEventPayload(name, {
    ...event.update,
    sessionId: event.sessionId,
    backendId: event.backendId,
    label: event.label,
    runId: event.runId,
  } as AcpRunnerEventMap[typeof name]);
}

function toAgentEventPayload<K extends AcpEventName>(name: K, event: AcpRunnerEventMap[K]): AgentEventPayload<K> {
  const context = event as Partial<{
    backendId: string;
    sessionId: string;
    label: string;
    runId: string;
  }>;
  return {
    name,
    event,
    backendId: context.backendId,
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
    ...(context.label !== undefined ? { label: context.label } : {}),
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
  } as AgentEventPayload<K>;
}

/**
 * Approval policy for SCRIPT-DECLARED custom ACP backends (`meta.backends`). Script backends
 * spawn arbitrary commands on this machine, so they are INERT unless the embedder approves
 * them: `true` approves everything the script declares; a callback is asked per backend (and
 * a single decline aborts the run — a declined backend would otherwise silently reroute its
 * agent() calls to the default backend). Omitted/false + a script that declares backends =>
 * runDynamicWorkflow THROWS with guidance rather than running a script whose declared
 * dependencies were dropped.
 */
export type ScriptBackendApproval =
  | boolean
  | ((backend: { name: string } & WorkflowBackendConfig) => boolean | Promise<boolean>);

/** Options for {@link runDynamicWorkflow}. */
export interface RunDynamicWorkflowOptions {
  /**
   * The agent backend (the frozen AgentRunner seam) to drive this run. The seam is
   * injectable: pass a custom runner to swap the backend (or to stub it in tests).
   * Omitted => defaults to the ACP backend via `createAcpRunner()`.
   */
  runner?: AgentRunner;
  /**
   * Base working directory for the run (e.g. the project root): every subagent ACP session
   * runs here (unless the agent sets its own `cwd` or worktree isolation), worktrees branch
   * from it, and agentType definitions are scanned from it. Omitted => `process.cwd()`.
   */
  cwd?: string;
  /** The `args` value handed to the workflow script's vm-realm `args` global. */
  args?: unknown;
  /** Per-execution options forwarded to `WorkflowManager.runSync` (timeouts, signal, budget, …). */
  exec?: ExecOptions;
  /** Approval policy for script-declared `meta.backends` (see {@link ScriptBackendApproval}). */
  allowScriptBackends?: ScriptBackendApproval;
  /**
   * A workflow directory view (or dir path(s) to open one over) serving saved workflows
   * by name. When set, the first argument may be a workflow NAME instead of a script
   * (resolver first, verbatim-script fallback — the engine's own nested-workflow rule),
   * and nested `workflow("<name>")` calls resolve from the same view (it is wired into
   * the run's `loadSavedWorkflow`).
   */
  workflows?: string | string[] | WorkflowDir;
}

/**
 * Run a dynamic workflow script to a TERMINAL result, with the AgentRunner seam
 * defaulted to the ACP backend.
 *
 * Thin convenience over the engine: it constructs a one-off `WorkflowManager` whose
 * injected `agent` is `opts.runner ?? createAcpRunner()` and delegates to its
 * `runSync(script, args, exec)`, which always resolves to a terminal
 * `WorkflowRunResult` (status `completed | paused | failed | aborted`) — never throwing
 * for an ordinary pause/fail — so the caller can read `result.status` directly.
 */
export async function runDynamicWorkflow(
  script: string,
  opts: RunDynamicWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  // Saved-workflow view: `script` may be a workflow NAME when `workflows` is set. A real
  // script always contains the mandatory `export const meta` head, so anything without it
  // is treated as a name and resolved via read() — which throws a diagnosable error
  // (searched dirs + closest matches) instead of the engine's parse error on a bare name.
  const flows =
    opts.workflows === undefined
      ? undefined
      : typeof opts.workflows === "string" || Array.isArray(opts.workflows)
        ? openWorkflowDir(opts.workflows, { cwd: opts.cwd })
        : opts.workflows;
  const resolvedScript = flows !== undefined && !script.includes("export const meta") ? flows.read(script) : script;

  // Script-declared backends need explicit approval BEFORE the run. A malformed script is
  // deliberately not diagnosed here — runSync re-parses and throws the engine's own parse
  // error (its pre-existing contract), so the approval gate never masks a parse message.
  let declared: Record<string, WorkflowBackendConfig> | undefined;
  try {
    declared = parseWorkflowScript(resolvedScript).meta.backends;
  } catch {
    declared = undefined;
  }
  let exec = opts.exec;
  if (declared && Object.keys(declared).length > 0) {
    exec = { ...(exec ?? {}), scriptBackends: await approveScriptBackends(declared, opts.allowScriptBackends) };
  }
  const owned = opts.runner === undefined;
  const runner = opts.runner ?? createAcpRunner();
  const manager = new WorkflowManager({ agent: runner, cwd: opts.cwd, loadSavedWorkflow: flows?.resolve });
  try {
    return await manager.runSync(resolvedScript, opts.args, exec);
  } finally {
    manager.dispose();
    if (owned) await (runner as OwnedAcpRunner).dispose();
  }
}

/** Resolve the embedder's approval policy over the declared backends; throw with guidance when
 *  approval is missing or any backend is declined (an unapproved dependency must abort, never
 *  silently reroute). */
async function approveScriptBackends(
  declared: Record<string, WorkflowBackendConfig>,
  approval: ScriptBackendApproval | undefined,
): Promise<Record<string, WorkflowBackendConfig>> {
  const names = Object.keys(declared).join(", ");
  if (approval === undefined || approval === false) {
    throw new WorkflowError(
      `script declares custom ACP backends (meta.backends: ${names}) — these spawn commands on this machine and require explicit approval. ` +
        `Pass allowScriptBackends: true (or a per-backend approval callback) to runDynamicWorkflow, ` +
        `or thread an approved registry yourself via exec.scriptBackends.`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (approval === true) return declared;
  for (const [name, config] of Object.entries(declared)) {
    if (!(await approval({ name, ...config }))) {
      throw new WorkflowError(
        `script backend "${name}" (command: ${config.command}) was declined by the allowScriptBackends callback — aborting the run`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
  }
  return declared;
}
