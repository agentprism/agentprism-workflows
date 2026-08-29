import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  decidePermission,
  type AcpEventContext,
  type AcpPermissionEvent,
  type PermissionResolver,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@automatalabs/workflows";

const RUN_ID = /^[a-z0-9]+-[a-z0-9]+$/;
const PERMISSION_ID = /^[0-9a-f-]{36}$/i;
const MAX_PUBLIC_REQUEST_BYTES = 64 * 1024;

export interface WorkflowPendingPermission {
  version: 1;
  permissionId: string;
  runId: string;
  callIndex: number;
  backendId: string;
  label?: string;
  requestedAt: string;
  /** Exact ACP request when it fits the public bound. Oversized diagnostic fields are removed,
   *  while the complete ordered option list and tool identity remain available for response. */
  request: RequestPermissionRequest;
  requestTruncated: boolean;
}

export interface WorkflowPermissionResponseAcknowledgement {
  permissionId: string;
  runId: string;
  callIndex: number;
  outcome: RequestPermissionResponse["outcome"];
  respondedAt: string;
}

interface PendingEntry {
  public: WorkflowPendingPermission;
  request: RequestPermissionRequest;
  settle(response: RequestPermissionResponse): void;
}

interface PermissionEventSource {
  on(name: "permission_request", listener: (event: AcpPermissionEvent) => void): () => void;
}

function cloneRequest(request: RequestPermissionRequest): RequestPermissionRequest {
  return structuredClone(request);
}

function publicRequest(request: RequestPermissionRequest): {
  request: RequestPermissionRequest;
  truncated: boolean;
} {
  const cloned = cloneRequest(request);
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") <= MAX_PUBLIC_REQUEST_BYTES) {
    return { request: cloned, truncated: false };
  }

  // The response contract depends only on the exact advertised option ids. Keep those plus the
  // action identity; drop potentially huge tool payloads rather than truncating JSON recursively
  // into a misleading command or path.
  return {
    request: {
      sessionId: cloned.sessionId,
      toolCall: {
        toolCallId: cloned.toolCall.toolCallId,
        ...(cloned.toolCall.title === undefined ? {} : { title: cloned.toolCall.title }),
        ...(cloned.toolCall.kind === undefined ? {} : { kind: cloned.toolCall.kind }),
        ...(cloned.toolCall.status === undefined ? {} : { status: cloned.toolCall.status }),
      },
      options: cloned.options,
      ...(cloned._meta === undefined ? {} : { _meta: cloned._meta }),
    },
    truncated: true,
  };
}

function validResponse(response: RequestPermissionResponse): boolean {
  if (response.outcome.outcome === "cancelled") return true;
  return typeof response.outcome.optionId === "string" && response.outcome.optionId.length > 0;
}

/** Process-local broker for ACP requests that belong to live workflow agent calls. The request
 * remains parked inside AcpAgentRunner; inspect/await expose this bounded projection and a later
 * MCP permission-response resolves the original promise. Nothing here reconstructs a request
 * after owner death. */
export class WorkflowPermissionBroker {
  private readonly byId = new Map<string, PendingEntry>();
  private readonly idsByRun = new Map<string, Set<string>>();
  private readonly changed = new EventEmitter();
  private detachEvents: (() => void) | undefined;

  readonly resolver: PermissionResolver = (request, context) => {
    // The daemon's runner is shared with the REPL. Engine workflow calls always stamp both an
    // engine runId and callIndex; other callers retain the SDK's autonomous auto-response path.
    if (
      context.backendId === "pi" ||
      context.runId === undefined ||
      !RUN_ID.test(context.runId) ||
      context.callIndex === undefined ||
      !Number.isSafeInteger(context.callIndex) ||
      context.callIndex < 0
    ) {
      return decidePermission(request, {});
    }
    return this.park(request, context as AcpEventContext & { runId: string; callIndex: number });
  };

  attach(source: PermissionEventSource): void {
    this.detachEvents?.();
    this.detachEvents = source.on("permission_request", (event) => this.observeFinalOutcome(event));
  }

  dispose(): void {
    this.detachEvents?.();
    this.detachEvents = undefined;
    for (const entry of [...this.byId.values()]) {
      this.finish(entry, { outcome: { outcome: "cancelled" } });
    }
    this.changed.removeAllListeners();
  }

  list(runId: string): WorkflowPendingPermission[] {
    const ids = this.idsByRun.get(runId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byId.get(id)?.public)
      .filter((entry): entry is WorkflowPendingPermission => entry !== undefined)
      .sort((left, right) =>
        left.callIndex - right.callIndex || left.requestedAt.localeCompare(right.requestedAt) ||
        left.permissionId.localeCompare(right.permissionId)
      )
      .map((entry) => structuredClone(entry));
  }

  has(runId: string, permissionId?: string): boolean {
    if (permissionId !== undefined) return this.byId.get(permissionId)?.public.runId === runId;
    return (this.idsByRun.get(runId)?.size ?? 0) > 0;
  }

  async waitForPending(runId: string): Promise<void> {
    if (this.has(runId)) return;
    await new Promise<void>((resolve) => {
      const eventName = `pending:${runId}`;
      const done = () => {
        this.changed.off(eventName, done);
        resolve();
      };
      this.changed.on(eventName, done);
      if (this.has(runId)) done();
    });
  }

  respond(
    runId: string,
    permissionId: string,
    response: RequestPermissionResponse,
  ): WorkflowPermissionResponseAcknowledgement {
    if (!RUN_ID.test(runId) || !PERMISSION_ID.test(permissionId)) {
      throw new TypeError("Invalid workflow permission identity");
    }
    if (!validResponse(response)) throw new TypeError("Invalid workflow permission response");
    const entry = this.byId.get(permissionId);
    if (!entry || entry.public.runId !== runId) {
      throw new TypeError(`Permission request "${permissionId}" is not pending for run "${runId}"`);
    }
    if (response.outcome.outcome === "selected") {
      const selectedOptionId = response.outcome.optionId;
      if (!entry.request.options.some((option) => option.optionId === selectedOptionId)) {
        throw new TypeError(
          `Permission option ${JSON.stringify(selectedOptionId)} was not advertised by request "${permissionId}"`,
        );
      }
    }
    const accepted = structuredClone(response);
    const acknowledgement: WorkflowPermissionResponseAcknowledgement = {
      permissionId,
      runId,
      callIndex: entry.public.callIndex,
      outcome: structuredClone(accepted.outcome),
      respondedAt: new Date().toISOString(),
    };
    this.finish(entry, accepted);
    return acknowledgement;
  }

  private park(
    request: RequestPermissionRequest,
    context: AcpEventContext & { runId: string; callIndex: number },
  ): Promise<RequestPermissionResponse> {
    if (request.options.length === 0) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = randomUUID();
    const projection = publicRequest(request);
    return new Promise<RequestPermissionResponse>((resolve) => {
      const entry: PendingEntry = {
        request: cloneRequest(request),
        public: {
          version: 1,
          permissionId,
          runId: context.runId,
          callIndex: context.callIndex,
          backendId: context.backendId,
          ...(context.label === undefined ? {} : { label: context.label }),
          requestedAt: new Date().toISOString(),
          request: projection.request,
          requestTruncated: projection.truncated,
        },
        settle: resolve,
      };
      this.byId.set(permissionId, entry);
      const runIds = this.idsByRun.get(context.runId) ?? new Set<string>();
      runIds.add(permissionId);
      this.idsByRun.set(context.runId, runIds);
      this.changed.emit(`run:${context.runId}`);
      this.changed.emit(`pending:${context.runId}`);
    });
  }

  private observeFinalOutcome(event: AcpPermissionEvent): void {
    for (const entry of this.byId.values()) {
      if (
        entry.public.backendId === event.backendId &&
        entry.request.sessionId === event.sessionId &&
        entry.request.toolCall.toolCallId === event.request.toolCall.toolCallId
      ) {
        this.finish(entry, event.outcome);
        return;
      }
    }
  }

  private finish(entry: PendingEntry, response: RequestPermissionResponse): void {
    this.remove(entry);
    entry.settle(response);
  }

  private remove(entry: PendingEntry): void {
    const { permissionId, runId } = entry.public;
    if (!this.byId.delete(permissionId)) return;
    const ids = this.idsByRun.get(runId);
    ids?.delete(permissionId);
    if (ids?.size === 0) this.idsByRun.delete(runId);
    this.changed.emit(`run:${runId}`);
  }
}
