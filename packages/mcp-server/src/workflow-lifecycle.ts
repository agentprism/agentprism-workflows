import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  isValidationAbortError, parseWorkflowScript, redactText, validateWorkflowScript, validationAbortError,
  type PersistedRunState, type WorkflowBackendConfig,
} from "@automatalabs/workflows";
import type { AgentRunner } from "@automatalabs/shared-types";
import type { ProjectContext } from "./project-registry.js";
import { clampWorkflowInput, type WorkflowExecuteToolInput, type WorkflowSetupResponseToolInput } from "./workflow-tool-input.js";
import { missingRoutingDiagnostics, validationText, workflowProbeRunner } from "./workflow-preflight.js";

/** Every observation request has a finite transport budget; human input is durable run state. */
export const WORKFLOW_REQUEST_BOUND_MS = 45_000;
/** The server's own ceiling on one preparation (validation, dry run, live probes). */
export const WORKFLOW_PREPARATION_BOUND_MS = 120_000;
const MAX_SCRIPT_BYTES = 1_048_576;
const PREPARATION_STEPS = 3;

export interface WorkflowSetupRequest {
    id: string;
    kind: "backend-approval";
    title: string;
    message: string;
    requestedSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: false;
    };
}

export type WorkflowSetup = { state: "preparing" } | { state: "input-required"; request: WorkflowSetupRequest };

export interface WorkflowSetupRequiredEvent {
  runId: string;
  request: WorkflowSetupRequest;
}

const setupRequiredListeners = new Set<(event: WorkflowSetupRequiredEvent) => void>();

/**
 * Fired once per setup request, after the run's preparation is durably `input-required`. Process
 * scope, like the permission broker: preparation is owned by the process executing the run, and
 * each server instance filters for the runs its own session named. Returns detach.
 */
export function onSetupRequired(listener: (event: WorkflowSetupRequiredEvent) => void): () => void {
  setupRequiredListeners.add(listener);
  return () => {
    setupRequiredListeners.delete(listener);
  };
}

interface PreparationData extends Record<string, unknown> {
  approvedKeys: string[];
  setup?: WorkflowSetupRequest;
  pendingBackendKey?: string;
  responses: Record<string, string>;
}

export function canonicalWorkflowJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalWorkflowJson(item)}`).join(",")}}`;
}

export async function boundWorkflowRequest<T>(operation: Promise<T>, ms = WORKFLOW_REQUEST_BOUND_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProtocolError(ProtocolErrorCode.InternalError,
        "Workflow request deadline reached. Inspect status; accepted work continues.")), ms);
      timer.unref?.();
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Preparation refused the run before anything was persisted: unreadable source, a script that
 * fails validation, or no admission capacity. Hosts report it as a tool execution error.
 */
export class WorkflowPreparationRejected extends Error {
  override readonly name = "WorkflowPreparationRejected";
}

/** True when preparation stopped because the caller cancelled the request. */
export function isPreparationCancelled(error: unknown): boolean {
  return isValidationAbortError(error);
}

export interface WorkflowPreparationControl {
  /** Caller cancellation (the MCP request signal). Nothing is persisted once it aborts. */
  signal?: AbortSignal;
  /** Stage progress for the request's progress token, when the client supplied one. */
  progress?: (progress: number, total?: number, message?: string) => void;
  /**
   * Called synchronously as soon as the run exists (started, or parked in setup) and before any
   * setup announcement, so the requesting session can register its interest in the run first.
   */
  onAdmitted?: (runId: string) => void;
}

export type WorkflowPreparationOutcome =
  | { runId: string; setup?: undefined }
  /** Validated, but parked in durable setup until the host answers the request. */
  | { runId: string; setup: Extract<WorkflowSetup, { state: "input-required" }> };

function readAcceptedScript(input: WorkflowExecuteToolInput): string {
  if (input.script !== undefined) {
    if (Buffer.byteLength(input.script, "utf8") > MAX_SCRIPT_BYTES) throw new WorkflowPreparationRejected("Workflow script exceeds 1 MiB");
    return input.script;
  }
  // Open once and check the same descriptor before reading: never block on a FIFO/device.
  let descriptor: number;
  try {
    descriptor = openSync(input.scriptPath!, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new WorkflowPreparationRejected(`scriptPath could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) throw new WorkflowPreparationRejected("scriptPath must identify a regular file of at most 1 MiB");
    const script = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) throw new WorkflowPreparationRejected("Workflow script exceeds 1 MiB");
    return script;
  } finally { closeSync(descriptor); }
}

function preparationData(state: PersistedRunState): PreparationData {
  const preparation = state.preparation;
  const data = preparation?.data as PreparationData | undefined;
  if (preparation?.format !== 1 || !data || !Array.isArray(data.approvedKeys) || !data.responses ||
    (data.setup !== undefined && data.setup.kind !== "backend-approval")) {
    throw new Error("Stored workflow preparation is incompatible; start a fresh run");
  }
  return data;
}

export function workflowSetup(state: PersistedRunState | null | undefined): WorkflowSetup | undefined {
  if (!state?.preparation || state.status !== "pending") return undefined;
  const data = preparationData(state);
  if (state.preparation.state === "preparing") return { state: "preparing" };
  if (!data.setup) throw new Error("Stored workflow setup request is missing");
  return { state: "input-required", request: data.setup };
}

function backendKey(name: string, config: WorkflowBackendConfig): string {
  return createHash("sha256").update(canonicalWorkflowJson({ name, command: config.command, args: config.args ?? [], env: config.env ?? {} })).digest("hex");
}

function scriptBackendsAllowedByEnvironment(): boolean {
  return ["1", "true"].includes(process.env.AGENTPRISM_ALLOW_SCRIPT_BACKENDS?.trim().toLowerCase() ?? "");
}

/** The first declared backend that still needs a host decision, as a durable setup request. */
function pendingBackendApproval(
  backends: Record<string, WorkflowBackendConfig> | undefined,
  approvedKeys: readonly string[],
): { key: string; request: WorkflowSetupRequest } | undefined {
  if (scriptBackendsAllowedByEnvironment()) return undefined;
  for (const [name, config] of Object.entries(backends ?? {})) {
    const key = backendKey(name, config);
    if (approvedKeys.includes(key)) continue;
    return {
      key,
      request: {
        id: randomUUID(), kind: "backend-approval", title: "Approve workflow backend",
        message: `Workflow wants to spawn custom ACP backend "${name}":\n${redactText(`${config.command} ${(config.args ?? []).join(" ")}`).value}\nEnvironment: ${redactText(JSON.stringify(config.env ?? {})).value}. Approve this command?`,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve" } }, required: ["approve"], additionalProperties: false },
      },
    };
  }
  return undefined;
}

/** Project-owned driver: it never captures an MCP request or transport beyond one preparation. */
export class WorkflowLifecycle {
  private readonly driving = new Set<string>();
  private readonly probeRunner: ReturnType<typeof workflowProbeRunner>;

  constructor(private readonly context: ProjectContext, private readonly runner: AgentRunner) {
    this.probeRunner = workflowProbeRunner(runner);
  }

  /**
   * Prepare a run inside the caller's request: read the source, validate it (static parse, mock
   * dry run, live config probes), then either start execution or park the validated run in
   * durable setup when a declared backend still needs approval. Nothing is persisted before that
   * point, so a rejection or a cancellation leaves no run behind.
   */
  async prepare(input: WorkflowExecuteToolInput, control: WorkflowPreparationControl = {}): Promise<WorkflowPreparationOutcome> {
    const { progress } = control;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, WORKFLOW_PREPARATION_BOUND_MS);
    timer.unref?.();
    const onCallerAbort = () => controller.abort();
    if (control.signal?.aborted) controller.abort();
    else control.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const throwIfAborted = () => {
      if (!controller.signal.aborted) return;
      if (timedOut) throw new WorkflowPreparationRejected(`Workflow preparation exceeded ${WORKFLOW_PREPARATION_BOUND_MS} ms; nothing was started.`);
      throw validationAbortError();
    };

    throwIfAborted();
    if (!this.context.activeRuns.reserve()) throw new WorkflowPreparationRejected("Workflow limit reached (4 active or preparing runs)");
    let reserved = true;
    try {
      const script = readAcceptedScript(input);
      let meta: ReturnType<typeof parseWorkflowScript>["meta"];
      try {
        meta = parseWorkflowScript(script).meta;
      } catch (error) {
        throw new WorkflowPreparationRejected(error instanceof Error ? error.message : String(error));
      }
      progress?.(1, PREPARATION_STEPS, "workflow script parsed");
      const limits = clampWorkflowInput(input);
      const backends = meta.backends;
      let preflight: Awaited<ReturnType<typeof validateWorkflowScript>>;
      try {
        preflight = await validateWorkflowScript(script, {
          args: input.args, cwd: this.context.projectDir, maxAgents: limits.maxAgents, timeoutMs: 30_000,
          requireAgentConfiguration: true, signal: controller.signal,
          probeRunner: this.probeRunner, loadSavedWorkflow: (name) => this.context.manager.resolveSavedWorkflow(name),
        });
      } catch (error) {
        if (isValidationAbortError(error)) throwIfAborted();
        throw error;
      }
      if (!preflight.ok) {
        const diagnostic = validationText(preflight);
        throw new WorkflowPreparationRejected(preflight.dryRun?.missingAgentConfiguration !== undefined
          ? `${diagnostic}\n\n${await missingRoutingDiagnostics(this.probeRunner, this.context.projectDir, backends)}`
          : diagnostic);
      }
      progress?.(2, PREPARATION_STEPS, "workflow script validated");
      throwIfAborted();

      const exec = { maxAgents: limits.maxAgents, concurrency: limits.concurrency, agentRetries: limits.agentRetries };
      const pending = pendingBackendApproval(backends, []);
      if (pending) {
        const data: PreparationData = { approvedKeys: [], responses: {}, pendingBackendKey: pending.key, setup: pending.request };
        const parked = this.context.manager.prepareRun(script, input.args, {
          ...exec, agent: this.runner,
          preparation: { format: 1, state: "input-required", data, responses: data.responses },
        });
        this.context.activeRuns.hold(parked.runId);
        reserved = false;
        control.onAdmitted?.(parked.runId);
        for (const listener of setupRequiredListeners) listener({ runId: parked.runId, request: structuredClone(pending.request) });
        return { runId: parked.runId, setup: { state: "input-required", request: pending.request } };
      }
      const started = this.context.manager.startInBackground(script, input.args, {
        ...exec, agent: this.runner, requireAgentConfiguration: true,
        onMissingAgentConfiguration: () => missingRoutingDiagnostics(this.probeRunner, this.context.projectDir, backends),
        scriptBackends: backends,
      });
      this.context.activeRuns.track(started.runId, started.promise);
      reserved = false;
      control.onAdmitted?.(started.runId);
      progress?.(PREPARATION_STEPS, PREPARATION_STEPS, "workflow run admitted");
      return { runId: started.runId };
    } finally {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", onCallerAbort);
      if (reserved) this.context.activeRuns.releaseReservation();
    }
  }

  recover(runId: string): void {
    const state = this.context.manager.getPersistence().load(runId);
    if (!state?.preparation || state.status !== "pending") return;
    if (!this.context.activeRuns.has(runId)) {
      if (!this.context.activeRuns.reserve()) return;
      try {
        if (!this.context.manager.claimPreparedRun(runId)) {
          this.context.activeRuns.releaseReservation();
          return;
        }
        this.context.activeRuns.hold(runId);
      } catch (error) {
        this.context.activeRuns.releaseReservation();
        throw error;
      }
    }
    if (state.preparation.state === "preparing") this.schedule(runId);
  }

  respond(input: WorkflowSetupResponseToolInput): void {
    const manager = this.context.manager;
    const state = manager.getPersistence().load(input.runId);
    if (!state) throw new Error(`No workflow run found for ${input.runId}`);
    const fingerprint = createHash("sha256").update(canonicalWorkflowJson(input.response)).digest("hex");
    // Receipts survive execution admission so delayed retransmissions remain idempotent.
    const receipts = state.setupResponses;
    if (receipts?.[input.setupId] !== undefined) {
      if (receipts[input.setupId] !== fingerprint) throw new Error("Conflicting response for this workflow setup request");
      return;
    }
    const data = preparationData(state);
    if (data.responses[input.setupId] !== undefined) {
      if (data.responses[input.setupId] !== fingerprint) throw new Error("Conflicting response for this workflow setup request");
      return;
    }
    if (state.status !== "pending" || data.setup?.id !== input.setupId) throw new Error("Workflow setup request is no longer pending");
    const cancelSetup = (message: string) => {
      const settled = manager.settlePreparedRun(input.runId, "aborted", message, {
        responses: { [input.setupId]: fingerprint }, expectedRevision: state.preparationRevision,
      });
      if (!settled) throw new Error("Workflow setup is no longer owned by this execution owner");
      this.context.activeRuns.evict(input.runId);
    };
    if (input.response.action !== "accept") {
      cancelSetup(`Workflow setup was ${input.response.action === "decline" ? "declined" : "cancelled"}`);
      return;
    }
    if (data.setup.kind === "backend-approval" &&
      (Object.keys(input.response.content).length !== 1 || typeof input.response.content.approve !== "boolean")) {
      throw new Error("Backend approval requires exactly the boolean approve field");
    }
    if (data.setup.kind === "backend-approval" && input.response.content.approve === false) {
      cancelSetup("Workflow setup was declined");
      return;
    }
    // Receipt retries and explicit cancellation do not start work. Every accepted answer
    // must first own a reserved slot; updatePreparation cannot bypass a full recovery cap.
    this.recover(input.runId);
    if (!this.context.activeRuns.has(input.runId)) {
      throw new Error("Workflow setup requires an available active-run slot and ownership; retry after capacity is available");
    }
    if (input.response.content.approve && data.pendingBackendKey) data.approvedKeys.push(data.pendingBackendKey);
    else {
      cancelSetup("Workflow setup was declined");
      return;
    }
    data.responses[input.setupId] = fingerprint;
    delete data.setup;
    delete data.pendingBackendKey;
    this.save(input.runId, data, state.preparationRevision);
    this.schedule(input.runId);
  }

  private save(runId: string, data: PreparationData, revision?: number): void {
    this.context.manager.updatePreparation(runId, {
      format: 1, state: data.setup ? "input-required" : "preparing", data, responses: data.responses,
    }, revision);
  }

  private schedule(runId: string): void {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    // Cross the setup-response boundary before beginning admission work.
    setImmediate(() => {
      const revision = this.context.manager.getPersistence().load(runId)?.preparationRevision;
      let failed = false;
      void this.drive(runId).catch((error: unknown) => {
        failed = true;
        const current = this.context.manager.getPersistence().load(runId);
        if (current?.preparationRevision !== revision) return;
        if (this.context.manager.settlePreparedRun(runId, "failed", error instanceof Error ? error.message : String(error))) {
          this.context.activeRuns.evict(runId);
        }
      }).finally(() => {
        this.driving.delete(runId);
        const current = this.context.manager.getPersistence().load(runId);
        // A setup response may arrive while the previous stage's promise is settling.
        if (!failed && current?.status === "pending" && current.preparation?.state === "preparing") this.schedule(runId);
      }).catch((error: unknown) => {
        // A persistence fault while recording preparation failure must not crash the daemon.
        // Retain ownership/capacity; a later inspection can retry the still-pending stage.
        console.error(`[workflow-lifecycle] Unable to settle preparation ${runId}: ${redactText(error instanceof Error ? error.message : String(error)).value}`);
      });
    });
  }

  /**
   * Continue a parked run after a setup answer: ask for the next unapproved backend, or
   * re-validate against the current routing state and admit execution on the same run ID.
   */
  private async drive(runId: string): Promise<void> {
    const manager = this.context.manager;
    const state = manager.getPersistence().load(runId);
    if (!state?.preparation || state.status !== "pending" || state.preparation.state === "input-required") return;
    const revision = state.preparationRevision;
    const data = preparationData(state);
    const input = { ...state.limits, args: state.args };
    const script = state.script;
    // Timeout invalidates this entire driver generation. Late probe completion cannot admit it.
    let expired = false;
    const run = async () => {
      const backends = parseWorkflowScript(script).meta.backends;
      const pending = pendingBackendApproval(backends, data.approvedKeys);
      if (pending) {
        data.pendingBackendKey = pending.key;
        data.setup = pending.request;
        if (expired) return;
        this.save(runId, data, revision);
        for (const listener of setupRequiredListeners) listener({ runId, request: structuredClone(pending.request) });
        return;
      }
      const preflight = await validateWorkflowScript(script, {
        args: input.args, cwd: this.context.projectDir, maxAgents: input.maxAgents, timeoutMs: 30_000,
        requireAgentConfiguration: true,
        probeRunner: this.probeRunner, loadSavedWorkflow: (name) => manager.resolveSavedWorkflow(name),
      });
      if (!preflight.ok) {
        const diagnostic = validationText(preflight);
        throw new Error(preflight.dryRun?.missingAgentConfiguration !== undefined
          ? `${diagnostic}\n\n${await missingRoutingDiagnostics(this.probeRunner, this.context.projectDir, backends)}`
          : diagnostic);
      }
      const current = manager.getPersistence().load(runId);
      if (expired || !current?.preparation || current.status !== "pending" || current.preparationRevision !== revision) return;
      const started = manager.admitPreparedRun(runId, {
        agent: this.runner, requireAgentConfiguration: true,
        onMissingAgentConfiguration: () => missingRoutingDiagnostics(this.probeRunner, this.context.projectDir, backends),
        scriptBackends: backends, maxAgents: input.maxAgents, concurrency: input.concurrency, agentRetries: input.agentRetries,
      });
      this.context.activeRuns.track(runId, started.promise);
    };
    try { await boundWorkflowRequest(run(), WORKFLOW_PREPARATION_BOUND_MS); }
    catch (error) { expired = true; throw error; }
  }
}

const drivers = new WeakMap<ProjectContext, WorkflowLifecycle>();
export function workflowLifecycle(context: ProjectContext, runner: AgentRunner): WorkflowLifecycle {
  let driver = drivers.get(context);
  if (!driver) { driver = new WorkflowLifecycle(context, runner); drivers.set(context, driver); }
  return driver;
}
