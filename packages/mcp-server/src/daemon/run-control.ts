import { randomUUID } from "node:crypto";
import type { WorkflowAgentCallCancellation, WorkflowManager } from "@automatalabs/workflows";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

import type { WorkflowProjectRegistry } from "../project-registry.js";
import { requireDurableStoppedRun } from "../workflow-stop.js";
import {
  WorkflowPermissionBroker,
  type WorkflowPendingPermission,
  type WorkflowPermissionDecisionResponse,
  type WorkflowPermissionResponseAcknowledgement,
} from "../workflow-permissions.js";
import {
  pidIsAlive,
  probeHealthz,
  readDaemonInfo,
  readDaemonInstance,
  type DaemonHealth,
  type DaemonInfo,
} from "./daemon-info.js";
import {
  RUN_CONTROL_PATH,
  signRunControlRequest,
  type RunControlAuthHeaders,
} from "./run-control-auth.js";
import {
  acknowledgeWholeStopIntent,
  createOrReuseWholeStopIntent,
  listPendingWholeStopIntents,
  readWholeStopIntent,
  type WholeStopIntent,
} from "./run-control-store.js";

const FORWARD_TIMEOUT_MS = 5_000;
const FORCE_TERM_WAIT_MS = 5_000;
const FORCE_KILL_WAIT_MS = 2_000;

export interface RunControlOwnerView {
  pid: number;
  instanceId?: string;
  version?: string;
  lameDuck?: boolean;
  activeRuns?: number;
  controlProtocol?: 1;
}

export type RoutedRunControlResult =
  | { kind: "whole"; state: "settled"; stopped: boolean; alreadyTerminal: boolean }
  | {
      kind: "whole";
      state: "pending";
      operationId: string;
      requestedAt: string;
      owner?: RunControlOwnerView;
    }
  | { kind: "agent"; cancellation: WorkflowAgentCallCancellation };

export interface WorkflowRunControlRouter {
  control(
    manager: WorkflowManager,
    input: { runId: string; callIndex?: number; forceOwner?: boolean },
  ): Promise<RoutedRunControlResult>;
  listPermissions(manager: WorkflowManager, runId: string): Promise<WorkflowPendingPermission[]>;
  respondPermission(
    manager: WorkflowManager,
    input: { runId: string; permissionId: string; response: WorkflowPermissionDecisionResponse },
  ): Promise<WorkflowPermissionResponseAcknowledgement>;
}

export type InternalRunControlRequest =
  | { operationId: string; runId: string; action: "stop" }
  | { operationId: string; runId: string; action: "cancel-agent"; callIndex: number }
  | { operationId: string; runId: string; action: "list-permissions" }
  | {
      operationId: string;
      runId: string;
      action: "respond-permission";
      permissionId: string;
      response: WorkflowPermissionDecisionResponse;
    };

export type InternalRunControlResponse =
  | { ok: true; outcome: "stopped" | "already-terminal" }
  | { ok: true; outcome: "agent-cancelled"; cancellation: WorkflowAgentCallCancellation }
  | { ok: true; outcome: "permissions-listed"; permissions: WorkflowPendingPermission[] }
  | {
      ok: true;
      outcome: "permission-responded";
      acknowledgement: WorkflowPermissionResponseAcknowledgement;
    }
  | { ok: false; code: "UNKNOWN_RUN" | "NOT_OWNER" | "INVALID_OPERATION" | "INTERNAL_ERROR"; message: string };

interface ResolvedOwner {
  pid: number;
  ownerId?: string;
  daemon?: DaemonInfo;
  health?: DaemonHealth;
}

export interface DaemonRunControlOptions {
  projects: WorkflowProjectRegistry;
  ownPid: number;
  ownInstanceId: string;
  key: Uint8Array;
  permissionBroker?: WorkflowPermissionBroker;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
}

function terminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function ownerView(owner: ResolvedOwner | undefined): RunControlOwnerView | undefined {
  if (!owner) return undefined;
  return {
    pid: owner.pid,
    ...(owner.daemon?.instanceId === undefined ? {} : { instanceId: owner.daemon.instanceId }),
    ...(owner.daemon?.version === undefined ? {} : { version: owner.daemon.version }),
    ...(owner.health?.lameDuck === undefined ? {} : { lameDuck: owner.health.lameDuck }),
    ...(owner.health?.activeRuns === undefined ? {} : { activeRuns: owner.health.activeRuns }),
    ...(owner.daemon?.controlProtocol === 1 ? { controlProtocol: 1 as const } : {}),
  };
}

function actionableOwnerMessage(runId: string, owner: ResolvedOwner | undefined, action: string): string {
  if (!owner) return `Workflow run "${runId}" has no discoverable live execution owner for ${action}.`;
  const version = owner.daemon?.version ? ` v${owner.daemon.version}` : "";
  const draining = owner.health?.lameDuck ? ", draining" : "";
  const control = owner.daemon?.controlProtocol === 1 ? "control v1" : "no compatible run-control endpoint";
  return `Workflow run "${runId}" is executing in daemon pid ${owner.pid}${version} (${control}${draining}); ${action} could not be delivered.`;
}

async function waitForPidExit(pid: number, timeoutMs: number, alive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

export class DaemonRunControl implements WorkflowRunControlRouter {
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly permissionBroker: WorkflowPermissionBroker;
  private processingPending: Promise<void> | undefined;

  constructor(private readonly options: DaemonRunControlOptions) {
    this.log = options.log ?? (() => undefined);
    this.fetchImpl = options.fetch ?? fetch;
    this.killProcess = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.isPidAlive = options.isPidAlive ?? pidIsAlive;
    this.permissionBroker = options.permissionBroker ?? new WorkflowPermissionBroker();
  }

  private async resolveOwner(manager: WorkflowManager, runId: string): Promise<ResolvedOwner | undefined> {
    const lease = manager.getPersistence().inspectRunLease?.(runId);
    if (!lease || !this.isPidAlive(lease.pid)) return undefined;
    const daemon = readDaemonInstance(lease.pid);
    if (daemon?.instanceId !== undefined && lease.ownerId !== undefined && daemon.instanceId !== lease.ownerId) {
      return { pid: lease.pid, ownerId: lease.ownerId };
    }
    const health = daemon === undefined ? undefined : await probeHealthz(daemon.port, 1_000);
    const verifiedHealth = health !== undefined && health.pid === lease.pid &&
        (lease.ownerId === undefined || health.instanceId === undefined || health.instanceId === lease.ownerId)
      ? health
      : undefined;
    return { pid: lease.pid, ownerId: lease.ownerId, ...(daemon ? { daemon } : {}), ...(verifiedHealth ? { health: verifiedHealth } : {}) };
  }

  private controlCapable(owner: ResolvedOwner): owner is ResolvedOwner & { daemon: DaemonInfo & { controlUrl: string; controlProtocol: 1 } } {
    return owner.daemon?.controlProtocol === 1 &&
      typeof owner.daemon.controlUrl === "string" &&
      (owner.ownerId === undefined || owner.daemon.instanceId === owner.ownerId);
  }

  private async post(owner: ResolvedOwner & { daemon: DaemonInfo & { controlUrl: string } }, request: InternalRunControlRequest): Promise<InternalRunControlResponse> {
    const body = JSON.stringify(request);
    const headers: RunControlAuthHeaders = signRunControlRequest(
      this.options.key,
      "POST",
      RUN_CONTROL_PATH,
      request.operationId,
      body,
    );
    const response = await this.fetchImpl(owner.daemon.controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const value = await response.json() as InternalRunControlResponse;
    if (!response.ok && value.ok !== false) throw new Error(`run-control owner returned HTTP ${response.status}`);
    return value;
  }

  private settledWhole(manager: WorkflowManager, runId: string): { stopped: boolean; alreadyTerminal: boolean } | undefined {
    const current = manager.getPersistence().load(runId);
    if (!current || !terminal(current.status)) return undefined;
    if (current.status === "aborted") {
      // A pre-existing aborted run remains an already-terminal no-op. A newly stopped run has
      // a readable stopped event, which upgrades it to stopped=true below.
      try {
        requireDurableStoppedRun(manager, runId);
        return { stopped: true, alreadyTerminal: false };
      } catch {
        return { stopped: false, alreadyTerminal: true };
      }
    }
    return { stopped: false, alreadyTerminal: true };
  }

  private applyWholeIntent(manager: WorkflowManager, intent: WholeStopIntent): InternalRunControlResponse {
    const before = manager.getPersistence().load(intent.runId);
    if (!before) return { ok: false, code: "UNKNOWN_RUN", message: `No workflow run found for ${intent.runId}` };
    if (terminal(before.status)) {
      acknowledgeWholeStopIntent(manager, intent, this.options.ownInstanceId, "already-terminal");
      return { ok: true, outcome: "already-terminal" };
    }

    const stopped = manager.getRun(intent.runId)
      ? manager.stop(intent.runId)
        ? { outcome: "stopped" as const }
        : { outcome: "owned-elsewhere" as const }
      : manager.stopPersistedRun(intent.runId);
    if (stopped.outcome === "owned-elsewhere") {
      return { ok: false, code: "NOT_OWNER", message: `Daemon no longer owns run ${intent.runId}` };
    }
    if (stopped.outcome === "missing") {
      return { ok: false, code: "UNKNOWN_RUN", message: `No workflow run found for ${intent.runId}` };
    }
    if (stopped.outcome === "already-terminal") {
      acknowledgeWholeStopIntent(manager, intent, this.options.ownInstanceId, "already-terminal");
      return { ok: true, outcome: "already-terminal" };
    }
    requireDurableStoppedRun(manager, intent.runId);
    acknowledgeWholeStopIntent(manager, intent, this.options.ownInstanceId, "stopped");
    return { ok: true, outcome: "stopped" };
  }

  async applyLocal(request: InternalRunControlRequest): Promise<InternalRunControlResponse> {
    const context = this.options.projects.storeFor(request.runId);
    if (!context) return { ok: false, code: "UNKNOWN_RUN", message: `No workflow run found for ${request.runId}` };
    const manager = context.manager;
    if (request.action === "stop") {
      const intent = readWholeStopIntent(manager, request.runId, request.operationId);
      if (!intent) return { ok: false, code: "INVALID_OPERATION", message: "Durable stop intent is missing" };
      return this.applyWholeIntent(manager, intent);
    }

    if (!manager.getRun(request.runId)) {
      return { ok: false, code: "NOT_OWNER", message: `Daemon has no live run ${request.runId}` };
    }
    try {
      if (request.action === "list-permissions") {
        return {
          ok: true,
          outcome: "permissions-listed",
          permissions: this.permissionBroker.list(request.runId),
        };
      }
      if (request.action === "respond-permission") {
        return {
          ok: true,
          outcome: "permission-responded",
          acknowledgement: this.permissionBroker.respond(
            request.runId,
            request.permissionId,
            request.response,
          ),
        };
      }
      const cancellation = await manager.cancelAgentCall(request.runId, request.callIndex);
      return { ok: true, outcome: "agent-cancelled", cancellation };
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_OPERATION",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  processPendingIntents(): Promise<void> {
    if (this.processingPending) return this.processingPending;
    this.processingPending = (async () => {
      for (const context of this.options.projects.stores()) {
        for (const intent of listPendingWholeStopIntents(context.manager)) {
          try {
            const response = this.applyWholeIntent(context.manager, intent);
            if (response.ok) {
              this.log(`[agentprism-daemon] run-control ${intent.operationId} for ${intent.runId}: ${response.outcome}`);
            }
          } catch (error) {
            this.log(`[agentprism-daemon] run-control ${intent.operationId} for ${intent.runId} failed: ${String(error)}`);
          }
        }
      }
    })().finally(() => {
      this.processingPending = undefined;
    });
    return this.processingPending;
  }

  private async forceOwner(manager: WorkflowManager, runId: string, owner: ResolvedOwner): Promise<void> {
    const lease = manager.getPersistence().inspectRunLease?.(runId);
    const instance = readDaemonInstance(owner.pid);
    if (!lease || lease.pid !== owner.pid || !instance || instance.pid !== owner.pid) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Refusing force stop for run "${runId}": owner identity changed.`);
    }
    if (owner.pid === this.options.ownPid) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Refusing force stop for run "${runId}": owner is this daemon.`);
    }
    if (lease.ownerId !== undefined && instance.instanceId !== lease.ownerId) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Refusing force stop for run "${runId}": owner instance identity does not match the lease.`);
    }
    const current = readDaemonInfo(instance.envFingerprint);
    if (!current || current.pid === owner.pid || !this.isPidAlive(current.pid)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Refusing force stop for run "${runId}": owner is not a superseded daemon with a live successor.`);
    }
    const health = await probeHealthz(instance.port, 1_000);
    if (lease.ownerId === undefined && (health?.pid !== owner.pid || health.startedAt !== instance.startedAt)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Refusing force stop for run "${runId}": legacy owner identity could not be revalidated.`);
    }
    this.log(
      `[agentprism-daemon] force-stopping superseded owner pid ${owner.pid} for run ${runId}; ` +
        `${health?.activeRuns ?? "unknown"} owned run(s) may be interrupted`,
    );
    try {
      this.killProcess(owner.pid, "SIGTERM");
    } catch {
      // A concurrently exited owner is the desired state.
    }
    if (!(await waitForPidExit(owner.pid, FORCE_TERM_WAIT_MS, this.isPidAlive))) {
      this.killProcess(owner.pid, "SIGKILL");
      if (!(await waitForPidExit(owner.pid, FORCE_KILL_WAIT_MS, this.isPidAlive))) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, `Forced owner pid ${owner.pid} did not exit.`);
      }
    }
  }

  async listPermissions(manager: WorkflowManager, runId: string): Promise<WorkflowPendingPermission[]> {
    if (manager.getRun(runId)) return this.permissionBroker.list(runId);
    const owner = await this.resolveOwner(manager, runId);
    if (!owner) return [];
    if (!this.controlCapable(owner)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${actionableOwnerMessage(runId, owner, "permission inspection")} ` +
          "Pending permissions are live execution state and require a control-capable owner.",
      );
    }
    let response: InternalRunControlResponse;
    try {
      response = await this.post(owner, {
        operationId: randomUUID(),
        runId,
        action: "list-permissions",
      });
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `${actionableOwnerMessage(runId, owner, "permission inspection")} ${String(error)}`,
      );
    }
    if (!response.ok || response.outcome !== "permissions-listed") {
      throw new ProtocolError(
        response.ok || response.code === "INTERNAL_ERROR"
          ? ProtocolErrorCode.InternalError
          : ProtocolErrorCode.InvalidParams,
        response.ok ? "Owner returned an invalid permission-list response." : response.message,
      );
    }
    return response.permissions;
  }

  async respondPermission(
    manager: WorkflowManager,
    input: { runId: string; permissionId: string; response: WorkflowPermissionDecisionResponse },
  ): Promise<WorkflowPermissionResponseAcknowledgement> {
    if (manager.getRun(input.runId) && this.permissionBroker.has(input.runId, input.permissionId)) {
      return this.permissionBroker.respond(input.runId, input.permissionId, input.response);
    }
    const owner = await this.resolveOwner(manager, input.runId);
    if (!owner || !this.controlCapable(owner)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${actionableOwnerMessage(input.runId, owner, "permission response")} ` +
          "A permission response cannot be reconstructed after owner loss.",
      );
    }
    let response: InternalRunControlResponse;
    try {
      response = await this.post(owner, {
        operationId: randomUUID(),
        runId: input.runId,
        action: "respond-permission",
        permissionId: input.permissionId,
        response: input.response,
      });
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `${actionableOwnerMessage(input.runId, owner, "permission response")} ${String(error)}`,
      );
    }
    if (!response.ok || response.outcome !== "permission-responded") {
      throw new ProtocolError(
        response.ok || response.code === "INTERNAL_ERROR"
          ? ProtocolErrorCode.InternalError
          : ProtocolErrorCode.InvalidParams,
        response.ok ? "Owner returned an invalid permission-response acknowledgement." : response.message,
      );
    }
    return response.acknowledgement;
  }

  async control(
    manager: WorkflowManager,
    input: { runId: string; callIndex?: number; forceOwner?: boolean },
  ): Promise<RoutedRunControlResult> {
    let owner = await this.resolveOwner(manager, input.runId);

    if (input.callIndex !== undefined) {
      if (!owner || !this.controlCapable(owner)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `${actionableOwnerMessage(input.runId, owner, "agent cancellation")} Per-agent cancellation requires the live control-capable owner.`,
        );
      }
      let response: InternalRunControlResponse;
      try {
        response = await this.post(owner, {
          operationId: randomUUID(),
          runId: input.runId,
          action: "cancel-agent",
          callIndex: input.callIndex,
        });
      } catch (error) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `${actionableOwnerMessage(input.runId, owner, "agent cancellation")} ${String(error)}`,
        );
      }
      if (!response.ok || response.outcome !== "agent-cancelled") {
        throw new ProtocolError(
          response.ok || response.code === "INTERNAL_ERROR"
            ? ProtocolErrorCode.InternalError
            : ProtocolErrorCode.InvalidParams,
          response.ok ? "Owner returned an invalid agent-cancellation response." : response.message,
        );
      }
      return { kind: "agent", cancellation: response.cancellation };
    }

    const intent = createOrReuseWholeStopIntent(manager, input.runId, this.options.ownInstanceId);

    // forceOwner authorizes escalation; it does not skip the ordinary graceful control path.
    if (owner && this.controlCapable(owner)) {
      try {
        await this.post(owner, { operationId: intent.operationId, runId: input.runId, action: "stop" });
      } catch (error) {
        this.log(`[agentprism-daemon] run-control ${intent.operationId} forwarding to pid ${owner.pid} failed: ${String(error)}`);
      }
      const settled = this.settledWhole(manager, input.runId);
      if (settled) return { kind: "whole", state: "settled", ...settled };
      owner = await this.resolveOwner(manager, input.runId);
    }

    if (input.forceOwner && owner) {
      await this.forceOwner(manager, input.runId, owner);
      owner = await this.resolveOwner(manager, input.runId);
    }

    if (!owner) {
      const result = manager.stopPersistedRun(input.runId);
      if (result.outcome === "stopped") {
        requireDurableStoppedRun(manager, input.runId);
        acknowledgeWholeStopIntent(manager, intent, this.options.ownInstanceId, "stopped");
      } else if (result.outcome === "already-terminal") {
        acknowledgeWholeStopIntent(manager, intent, this.options.ownInstanceId, "already-terminal");
      } else if (result.outcome === "owned-elsewhere") {
        owner = await this.resolveOwner(manager, input.runId);
      }
      const settled = this.settledWhole(manager, input.runId);
      if (settled) return { kind: "whole", state: "settled", ...settled };
    }

    return {
      kind: "whole",
      state: "pending",
      operationId: intent.operationId,
      requestedAt: intent.requestedAt,
      owner: ownerView(owner),
    };
  }
}
