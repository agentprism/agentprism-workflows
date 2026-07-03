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

import { createAcpRunner } from "@automatalabs/acp-agents";
import {
  parseWorkflowScript,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager as EngineWorkflowManager,
} from "@automatalabs/workflow-engine";
import type { AcpEventListener, AcpEventName, AcpRunnerEventMap, AcpUpdateKind } from "@automatalabs/acp-agents";
import type { ExecOptions, WorkflowManagerOptions } from "@automatalabs/workflow-engine";
import type { AgentRunner, WorkflowBackendConfig, WorkflowRunResult } from "@automatalabs/shared-types";

// ── Engine: run entry, script parsing, the managed-run lifecycle, and the
//    option/result + error types the host composes against. ──
export { runWorkflow, parseWorkflowScript } from "@automatalabs/workflow-engine";
export type {
  WorkflowRunOptions,
  AgentOptions,
  ExecOptions,
  WorkflowManagerOptions,
  CheckpointOptions,
  WorkflowRunResult,
  WorkflowSnapshot,
} from "@automatalabs/workflow-engine";
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
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
  InteractiveSessionOptions,
  InteractiveTurn,
  BackendRegistry,
  CustomBackendConfig,
  RegisteredBackend,
  ClientHandlers,
  FsHandlers,
  TerminalHandlers,
  AcpSessionContext,
  NegotiatedCapabilities,
  PermissionResolver,
} from "@automatalabs/acp-agents";

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
  AcpPermissionPendingEvent,
  AcpPermissionEvent,
  AcpRawMessageEvent,
  AcpBackendErrorEvent,
} from "@automatalabs/acp-agents";

// ── Shared seam types: the AgentRunner contract and its opts/result/usage shapes,
//    so callers can implement or type a custom runner without reaching past the SDK. ──
export type { AgentRunner, RunOptions, AgentResult, AgentUsage } from "@automatalabs/shared-types";
export type { JournalEntry, WorkflowBackendConfig, WorkflowMeta } from "@automatalabs/shared-types";

/** Cross-cutting runner events the manager forwards alongside ACP `session/update` traffic. */
const MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES = [
  "permission_pending",
  "permission_request",
  "session_open",
  "session_close",
  "backend_error",
  "raw_message",
] as const satisfies readonly AcpEventName[];

type AcpEventBusRunner = AgentRunner & {
  on<K extends AcpEventName>(name: K, listener: AcpEventListener<K>): () => void;
};

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
  private readonly acpBridgeUnsubscribers = new Map<AcpEventBusRunner, Array<() => void>>();

  constructor(options: WorkflowManagerOptions = {}) {
    super(options);
    this.bridgeAcpRunner(options.agent);
  }

  override startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    this.bridgeAcpRunner(exec.agent);
    return super.startInBackground(script, args, exec);
  }

  override async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    this.bridgeAcpRunner(exec.agent);
    return super.runSync(script, args, exec);
  }

  override async resume(runId: string, exec: ExecOptions = {}): Promise<boolean> {
    this.bridgeAcpRunner(exec.agent);
    return super.resume(runId, exec);
  }

  /** Detach manager-owned ACP event subscriptions. The manager does NOT dispose the runner: the
   *  caller may share one runner across managers or own its process lifetime explicitly. */
  dispose(): void {
    for (const unsubscribers of this.acpBridgeUnsubscribers.values()) {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
    this.acpBridgeUnsubscribers.clear();
  }

  /** Node-style alias for hosts that tear down managers through close hooks. */
  close(): void {
    this.dispose();
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName !== "agentEvent") return super.emit(eventName, ...args);
    const listeners = this.rawListeners(eventName);
    for (const listener of listeners) {
      try {
        Reflect.apply(listener, this, args);
      } catch {
        // agentEvent is live observability; a bad host listener must not block sibling observers.
      }
    }
    return listeners.length > 0;
  }

  private bridgeAcpRunner(agent: AgentRunner | undefined): void {
    if (!isAcpEventBusRunner(agent) || this.acpBridgeUnsubscribers.has(agent)) return;
    const unsubscribers: Array<() => void> = [
      agent.on("session_update", (event) => {
        this.emit("agentEvent", toSessionUpdateAgentEventPayload(event));
      }),
      ...MANAGER_ACP_CROSS_CUTTING_EVENT_NAMES.map((name) =>
        agent.on(name, (event) => {
          this.emit("agentEvent", toAgentEventPayload(name, event));
        }),
      ),
    ];
    this.acpBridgeUnsubscribers.set(agent, unsubscribers);
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
  /** The `args` value handed to the workflow script's vm-realm `args` global. */
  args?: unknown;
  /** Per-execution options forwarded to `WorkflowManager.runSync` (timeouts, signal, budget, …). */
  exec?: ExecOptions;
  /** Approval policy for script-declared `meta.backends` (see {@link ScriptBackendApproval}). */
  allowScriptBackends?: ScriptBackendApproval;
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
  // Script-declared backends need explicit approval BEFORE the run. A malformed script is
  // deliberately not diagnosed here — runSync re-parses and throws the engine's own parse
  // error (its pre-existing contract), so the approval gate never masks a parse message.
  let declared: Record<string, WorkflowBackendConfig> | undefined;
  try {
    declared = parseWorkflowScript(script).meta.backends;
  } catch {
    declared = undefined;
  }
  let exec = opts.exec;
  if (declared && Object.keys(declared).length > 0) {
    exec = { ...(exec ?? {}), scriptBackends: await approveScriptBackends(declared, opts.allowScriptBackends) };
  }
  const manager = new WorkflowManager({ agent: opts.runner ?? createAcpRunner() });
  try {
    return await manager.runSync(script, opts.args, exec);
  } finally {
    manager.dispose();
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
