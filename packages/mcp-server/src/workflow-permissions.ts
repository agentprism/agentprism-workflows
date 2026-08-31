import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  decidePermission,
  redactText,
  truncateUtf8,
  type AcpEventContext,
  type AcpPermissionEvent,
  type PermissionOption,
  type PermissionResolver,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@automatalabs/workflows";

const RUN_ID = /^[a-z0-9]+-[a-z0-9]+$/;
const PERMISSION_ID = /^[0-9a-f-]{36}$/i;
const MAX_PUBLIC_REQUEST_BYTES = 64 * 1024;
const MAX_PUBLIC_SCALAR_BYTES = 512;
const MAX_PERMISSION_OPTIONS = 16;
const MAX_OPTION_ID_CODE_UNITS = 512;
const MAX_OPTION_ID_BYTES = 2_048;
const MAX_PUBLIC_ARRAY_ITEMS = 16;
const MAX_PUBLIC_OBJECT_KEYS = 20;
const MAX_PUBLIC_DEPTH = 4;
const SENSITIVE_KEY_PARTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "credential",
  "authorization",
  "cookie",
  "privatekey",
] as const;
const PERMISSION_OPTION_KINDS = new Set([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

export interface WorkflowPermissionRequestProjection {
  /** Safe tool-call projection. The private ACP session id is deliberately omitted. */
  toolCall: RequestPermissionRequest["toolCall"];
  /** Complete ordered response choices. optionId values are exact; presentation is redacted/bounded. */
  options: PermissionOption[];
  /** Redacted/bounded request metadata when it fits the public envelope. */
  _meta?: Record<string, unknown> | null;
}

export interface WorkflowPermissionDecisionResponse {
  outcome: RequestPermissionResponse["outcome"];
}

export interface WorkflowPendingPermission {
  version: 1;
  permissionId: string;
  runId: string;
  callIndex: number;
  backendId: string;
  label?: string;
  requestedAt: string;
  /** Redacted and bounded ACP projection with the complete ordered exact optionId list. */
  request: WorkflowPermissionRequestProjection;
  requestTruncated: boolean;
  requestRedacted: boolean;
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

interface ProjectionState {
  redacted: boolean;
  truncated: boolean;
}

interface PublicRequestProjection {
  request: WorkflowPermissionRequestProjection;
  truncated: boolean;
  redacted: boolean;
}

function cloneRequest(request: RequestPermissionRequest): RequestPermissionRequest {
  return structuredClone(request);
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeString(value: string, state: ProjectionState): string {
  const redacted = redactText(value);
  const bounded = truncateUtf8(redacted.value, MAX_PUBLIC_SCALAR_BYTES);
  state.redacted ||= redacted.redacted;
  state.truncated ||= bounded !== redacted.value;
  return bounded;
}

function sanitizeValue(
  value: unknown,
  state: ProjectionState,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set(),
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, state);
  if (typeof value !== "object") {
    state.truncated = true;
    return null;
  }
  if (depth >= MAX_PUBLIC_DEPTH || ancestors.has(value)) {
    state.truncated = true;
    return depth >= MAX_PUBLIC_DEPTH ? "[max depth]" : "[cycle]";
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_PUBLIC_ARRAY_ITEMS).map((entry) =>
      sanitizeValue(entry, state, depth + 1, nextAncestors)
    );
    if (value.length > MAX_PUBLIC_ARRAY_ITEMS) state.truncated = true;
    return kept;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_PUBLIC_OBJECT_KEYS)) {
    const outwardKey = sanitizeString(key, state);
    if (Object.hasOwn(output, outwardKey)) {
      state.truncated = true;
      continue;
    }
    if (sensitiveKey(key)) {
      output[outwardKey] = "[REDACTED]";
      state.redacted = true;
    } else {
      output[outwardKey] = sanitizeValue(child, state, depth + 1, nextAncestors);
    }
  }
  if (entries.length > MAX_PUBLIC_OBJECT_KEYS) state.truncated = true;
  return output;
}

function validMeta(value: unknown): value is Record<string, unknown> | null | undefined {
  return value === undefined || value === null || (typeof value === "object" && !Array.isArray(value));
}

function validOption(option: PermissionOption): boolean {
  return typeof option.optionId === "string" &&
    option.optionId.length > 0 &&
    option.optionId.length <= MAX_OPTION_ID_CODE_UNITS &&
    Buffer.byteLength(option.optionId, "utf8") <= MAX_OPTION_ID_BYTES &&
    typeof option.name === "string" &&
    PERMISSION_OPTION_KINDS.has(option.kind) &&
    validMeta(option._meta);
}

function sanitizeOption(option: PermissionOption, state: ProjectionState): PermissionOption {
  return {
    optionId: option.optionId,
    name: sanitizeString(option.name, state),
    kind: option.kind,
    ...(option._meta === undefined
      ? {}
      : { _meta: sanitizeValue(option._meta, state) as Record<string, unknown> | null }),
  };
}

function safeToolCall(
  toolCall: RequestPermissionRequest["toolCall"],
  state: ProjectionState,
): RequestPermissionRequest["toolCall"] | undefined {
  if (typeof toolCall.toolCallId !== "string" || toolCall.toolCallId.length === 0) return undefined;
  const sanitized = sanitizeValue(toolCall, state);
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) return undefined;
  return {
    ...(sanitized as RequestPermissionRequest["toolCall"]),
    toolCallId: sanitizeString(toolCall.toolCallId, state),
  };
}

function publicRequest(request: RequestPermissionRequest): PublicRequestProjection | undefined {
  if (
    !Array.isArray(request.options) ||
    request.options.length === 0 ||
    request.options.length > MAX_PERMISSION_OPTIONS ||
    !request.options.every(validOption) ||
    !validMeta(request._meta)
  ) return undefined;
  const optionIds = request.options.map((option) => option.optionId);
  if (new Set(optionIds).size !== optionIds.length) return undefined;

  const state: ProjectionState = { redacted: false, truncated: false };
  const toolCall = safeToolCall(request.toolCall, state);
  if (!toolCall) return undefined;
  const options = request.options.map((option) => sanitizeOption(option, state));
  const projected: WorkflowPermissionRequestProjection = {
    toolCall,
    options,
    ...(request._meta === undefined
      ? {}
      : { _meta: sanitizeValue(request._meta, state) as Record<string, unknown> | null }),
  };
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_PUBLIC_REQUEST_BYTES) {
    return { request: projected, truncated: state.truncated, redacted: state.redacted };
  }

  // Preserve exact response ids and useful presentation while dropping optional diagnostics.
  const minimal: WorkflowPermissionRequestProjection = {
    toolCall: {
      toolCallId: projected.toolCall.toolCallId,
      ...(projected.toolCall.title === undefined ? {} : { title: projected.toolCall.title }),
      ...(projected.toolCall.name === undefined ? {} : { name: projected.toolCall.name }),
      ...(projected.toolCall.kind === undefined ? {} : { kind: projected.toolCall.kind }),
      ...(projected.toolCall.status === undefined ? {} : { status: projected.toolCall.status }),
    },
    options: projected.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
  };
  if (Buffer.byteLength(JSON.stringify(minimal), "utf8") > MAX_PUBLIC_REQUEST_BYTES) return undefined;
  return { request: minimal, truncated: true, redacted: state.redacted };
}

function validResponse(response: WorkflowPermissionDecisionResponse): boolean {
  if ("_meta" in response) return false;
  if (response.outcome.outcome === "cancelled") return true;
  return typeof response.outcome.optionId === "string" &&
    response.outcome.optionId.length > 0 &&
    response.outcome.optionId.length <= MAX_OPTION_ID_CODE_UNITS &&
    Buffer.byteLength(response.outcome.optionId, "utf8") <= MAX_OPTION_ID_BYTES;
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
    response: WorkflowPermissionDecisionResponse,
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
    const projection = publicRequest(request);
    if (!projection) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = randomUUID();
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
          requestRedacted: projection.redacted,
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
