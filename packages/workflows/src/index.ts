/// <reference path="./dsl.d.ts" />
// @automatalabs/workflows — the importable SDK for the AgentPrism dynamic-workflow
// orchestrator. A FACADE re-export barrel: it re-exports the clean public surface of
// the three engine packages, adds the SDK-level WorkflowManager ACP-event bridge, and
// adds ACP-defaulted convenience helpers for ordinary and isolation runs. It is
// SEPARATE from @automatalabs/mcp-server (the stdio MCP server)
// and stays a PURE library — it pulls in neither @modelcontextprotocol/sdk nor zod.
//
// The DSL globals available INSIDE a workflow script (agent, parallel, pipeline, …) are
// vm-realm globals, NOT importable symbols; they are documented for author IntelliSense
// in ./dsl.d.ts (referenced above), not exported here.

import { createAcpRunner } from "@automatalabs/acp-agents";
import {
  openWorkflowDir,
  parseWorkflowScript,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager as EngineWorkflowManager,
} from "@automatalabs/workflow-engine";
import type { AcpEventName, AcpRunnerEventMap, AcpUpdateKind } from "@automatalabs/acp-agents";
import type { ExecOptions, WorkflowDir, WorkflowManagerOptions } from "@automatalabs/workflow-engine";
import type { AgentRunner, RunEvent, WorkflowBackendConfig, WorkflowRunResult } from "@automatalabs/shared-types";
import { approveScriptBackends, type ScriptBackendApproval } from "./script-backends.js";
import {
  projectWorkflowAgentActivity,
  workflowAgentEventSource,
} from "./agent-event-source.js";
export {
  projectWorkflowAgentActivity,
  workflowAgentEventSource,
  type WorkflowAgentEventSink,
  type WorkflowAgentEventSource,
} from "./agent-event-source.js";

type OwnedAcpRunner = AgentRunner & { dispose: () => Promise<void> };

// ── Engine: run entry, script parsing, the managed-run lifecycle, and the
//    option/result + error types the host composes against. ──
export {
  runWorkflow,
  parseWorkflowScript,
  hashCheckpointInputs,
  resolveAgentTimeoutMs,
  resolveWorkflowRunLimits,
  redactText,
  truncateUtf8,
  AGENT_PROGRESS_HEARTBEAT_MS,
  AGENT_PROGRESS_MIN_INTERVAL_MS,
  CALL_PATH_FORMAT,
  CALL_INPUTS_FORMAT,
  CHECKPOINT_INPUTS_FORMAT,
  RESUME_FALLBACK_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_CALL_FAILED_REASONS,
} from "@automatalabs/workflow-engine";

// ── Isolation mode: deterministic substitution testing over a recorded run. The SDK
//    wrapper defaults the live target runner to ACP and owns that runner's disposal. ──
export { runIsolation, createReplayRunner, type RunIsolationSdkOptions } from "./isolation.js";
export type {
  RunIsolationOptions,
  IsolationRunResult,
  ReplayRunnerOptions,
  ResolvedIsolationTarget,
  IsolationTarget,
  ReplayRunner,
  ReplayObservation,
  ReplayReport,
  ReplayCallReport,
  ReplayDivergenceEvent,
  CheckpointCallContext,
  WorkflowCallRecord,
  WorkflowRecordedError,
} from "./isolation.js";

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
export {
  validateWorkflowScript,
  fabricateFromSchema,
  formatValidateReport,
  MOCK_TOKENS_PER_AGENT,
  ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT,
} from "./validate.js";
export type {
  MockAnswerJson,
  MockAnswerRule,
  MockAnswers,
  MockAnswerSequence,
  UnusedMockAnswer,
  ValidateWorkflowOptions,
  ValidateWorkflowReport,
  ValidateHarnessOptions,
  ValidatedAgentCall,
  ValidatedCheckpoint,
  ValidatedMockAnswerRule,
  ValidatedMockAnswers,
  ValidatedMockAnswerUse,
} from "./validate.js";

// ── Harness config discovery: validate's sibling (`agentprism-workflows config`) — probe
//    any routable ACP harness's advertised config-option catalog (model ids, effort levels,
//    modes, …) without authoring a script. ──
export { probeHarnessConfig, formatHarnessConfigReport } from "./config.js";
export type { ProbeHarnessConfigOptions, HarnessConfigReport } from "./config.js";
export type {
  WorkflowRunOptions,
  WorkflowRunLimitOptions,
  WorkflowAgentAttemptControl,
  WorkflowAgentCallCancellation,
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
  PersistedResumeFormat,
  PersistedResumeCandidate,
  PersistedResumeCallBlocker,
  PersistedCheckpointInjection,
  PersistedResumeSeed,
  PersistedRunLineageTombstone,
  PreparedResume,
  WorkflowLogTail,
  WorkflowRunCallStatus,
  WorkflowRunInspectionOptions,
  WorkflowRunLimits,
  WorkflowRunStatus,
  WorkflowRunStatusTruncation,
  WorkflowRunFallback,
  WorkflowCheckpointSource,
  WorkflowCheckpointTaken,
  ResumePolicy,
  WorkflowResumeStrategy,
  WorkflowResumeMatch,
  WorkflowResumeFallbackReason,
  WorkflowResumeDisabledReason,
  WorkflowResumeCallLiveReason,
  WorkflowResumeCallFailedReason,
  WorkflowResumeSafety,
  WorkflowCallReplayProvenance,
  WorkflowResumeCallDecision,
  WorkflowResumeReport,
  WorkflowReplayOperationalOption,
  WorkflowReplayOperationalChange,
  WorkflowReplayProvenanceField,
  WorkflowReplayProvenanceChange,
  WorkflowReplayFirstNonReplay,
  WorkflowReplayEligibility,
  WorkflowAgentActivity,
  WorkflowAgentActivityBase,
} from "@automatalabs/workflow-engine";
export {
  AGENTPRISM_PERSISTENCE_ROOT_ENV,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
  isAuthRequired,
} from "@automatalabs/workflow-engine";

// ── Durable run-event read/tail seam: the append/read/watch API over the per-run
//    `<runId>.events.jsonl` sidecar, its error taxonomy, and the read caps (§2.10). A host
//    attaches to a run's structured event log through these — and `withRunEvents` upgrades a
//    custom RunPersistence into the seam — without reaching into package internals. ──
export {
  withRunEvents,
  RunEventLogError,
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RUN_EVENT_MAX_RECORD_BYTES,
} from "@automatalabs/workflow-engine";
export type {
  RunEventPersistence,
  RunEventStream,
  AppendRunEventInput,
  ReadRunEventsOptions,
  ReadRunEventsResult,
  WatchRunEventsOptions,
  RunEventLogErrorCode,
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
  SteeringOutcome,
  ListProvidersOptions,
  ListSessionsOptions,
  LogoutOptions,
  ProbeConfigOptionsOptions,
  ProbedConfigOptions,
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
  SessionConfigOption,
  SessionInfo,
  SendRequestOptions,
  AgentMethodCoverage,
  ClientMethodCoverage,
} from "@automatalabs/acp-agents";

// ── Type-driven auth surface (§4.2) + the providers surface: the runner-facing contracts hosts
//    consume through this facade. mcp-server imports these here (its only @automatalabs deps are
//    `workflows` and `shared-types`), so the type re-exports land with PR5 — the MCP auth tools
//    cannot compile without them. The `isAuthRequired` VALUE export lands with PR6.
//    `ProviderCapableRunner` is the symmetric duck-type gate for the MCP provider tools. ──
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
  ProviderCapableRunner,
} from "@automatalabs/acp-agents";
export type {
  ProviderUsageLimitContext,
  AuthErrorContext,
  CheckpointContext,
} from "@automatalabs/shared-types"; // via workflow-engine re-export (§1.5)

// ── Live ACP events: `createAcpRunner().on("tool_call", evt => …)` to listen in on the
//    stream of a run. The event map keys are ACP `sessionUpdate` discriminants plus a few
//    cross-cutting events; each payload carries a `{ sessionId, backendId, label?, runId?, callIndex? }`
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
  AcpSteeringEvent,
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
export type {
  AgentSessionRecord,
  AgentSessionRef,
  JournalCallMetadata,
  JournalEntry,
  WorkflowBackendConfig,
  WorkflowMeta,
} from "@automatalabs/shared-types";

// ── Shared durable run-event contract: the live/persisted event unions, the engine
//    event name/payload maps, and the bounded persisted projections (§2.2, §2.5). Re-exported
//    through the facade so SDK consumers type a durable-log reader without reaching past the SDK
//    (the ACP-specialized agentEvent branch is bound below as WorkflowAgentEvent/WorkflowRunEvent). ──
export { RUN_EVENT_LOG_VERSION } from "@automatalabs/shared-types";
export type {
  RunEvent,
  EngineRunEvent,
  EngineRunEventName,
  EngineRunEventPayloadMap,
  PersistableEngineRunEvent,
  PersistedRunEvent,
  RunEventLogRecord,
  RunEventValueProjection,
  RunEventErrorProjection,
  RunEventCheckpointProjection,
  PersistedRunAgentEndPayload,
  RunAgentProgressEvent,
  RunAgentProgressPayload,
  RunAgentTranscriptEvent,
  RunAgentTranscriptPayload,
} from "@automatalabs/shared-types";

interface AcpBridgeEntry {
  refs: number;
  detach: () => void;
}

type ContextProperty<T, Key extends PropertyKey> = Key extends keyof T ? T[Key] : never;
type OptionalContextProperty<T, Key extends PropertyKey> =
  Key extends keyof T ? T[Key] : undefined;

/** The manager unwraps the runner catch-all into its concrete sessionUpdate discriminant. */
export type WorkflowAgentEventName = Exclude<AcpEventName, "session_update">;

/**
 * Envelope map over the runner's whole public event-name type. The manager-emitted map below
 * picks only names the bridge actually publishes; retaining the full map preserves the existing
 * AgentEventPayload<"session_update"> type argument for source compatibility.
 */
type WorkflowAgentEventEnvelopeMap = {
  [Name in AcpEventName]: {
    name: Name;
    event: AcpRunnerEventMap[Name];
    backendId: ContextProperty<AcpRunnerEventMap[Name], "backendId">;
  } & ("sessionId" extends keyof AcpRunnerEventMap[Name]
    ? { sessionId: ContextProperty<AcpRunnerEventMap[Name], "sessionId"> }
    : { sessionId?: undefined }) & {
      label?: OptionalContextProperty<AcpRunnerEventMap[Name], "label">;
      runId?: OptionalContextProperty<AcpRunnerEventMap[Name], "runId">;
      scope?: OptionalContextProperty<AcpRunnerEventMap[Name], "runId">;
      callIndex?: OptionalContextProperty<AcpRunnerEventMap[Name], "callIndex">;
    };
};

export type WorkflowAgentEventPayloadMap = Pick<
  WorkflowAgentEventEnvelopeMap,
  WorkflowAgentEventName
>;

export type WorkflowAgentEventPayload<
  Name extends WorkflowAgentEventName = WorkflowAgentEventName,
> = WorkflowAgentEventPayloadMap[Name];

export type WorkflowAgentEvent = {
  [Name in WorkflowAgentEventName]:
    { type: "agentEvent" } & WorkflowAgentEventPayload<Name>;
}[WorkflowAgentEventName];

export type WorkflowRunEvent = RunEvent<WorkflowAgentEvent>;

/**
 * Compatibility alias retained with its pre-contract generic constraint and default. The
 * "session_update" member is type-only: the manager did not emit it before this contract and
 * still does not. New exact consumers use WorkflowAgentEventPayload/WorkflowAgentEvent.
 */
export type AgentEventPayload<
  Name extends AcpEventName = AcpEventName,
> = WorkflowAgentEventEnvelopeMap[Name];

export interface WorkflowManager {
  addListener(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  on(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  once(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  removeListener(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  off(eventName: "agentEvent", listener: (payload: WorkflowAgentEventPayload) => void): this;
  emit(eventName: "agentEvent", payload: WorkflowAgentEventPayload): boolean;
  addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean;
}

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
  private readonly acpBridges = new Map<AgentRunner, AcpBridgeEntry>();

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
      bridge.detach();
    }
    this.acpBridges.clear();
  }

  /** Node-style alias for hosts that tear down managers through close hooks. */
  close(): void {
    this.dispose();
  }

  private acquireAcpRunnerBridge(agent: AgentRunner | undefined): () => void {
    if (!agent) return () => {};
    let bridge = this.acpBridges.get(agent);
    if (!bridge) {
      bridge = {
        refs: 0,
        detach: workflowAgentEventSource(agent).attach({
          observe: (event) => {
            try {
              const activity = projectWorkflowAgentActivity(event);
              if (activity !== undefined) this.observeAgentActivity(activity);
            } finally {
              this.emit("agentEvent", event);
            }
          },
        }),
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
      current.detach();
      this.acpBridges.delete(agent);
    };
  }
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
export type { ScriptBackendApproval } from "./script-backends.js";

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
  /** Per-execution options forwarded to `WorkflowManager.runSync` (timeouts, signal, …). */
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
    exec = {
      ...(exec ?? {}),
      scriptBackends: await approveScriptBackends(declared, opts.allowScriptBackends, "runDynamicWorkflow"),
    };
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
