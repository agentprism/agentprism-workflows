import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type {
  PersistedRunLineageTombstone,
  PersistedRunState,
  RunEventLogErrorCode,
  RunEventStream,
  WorkflowManager,
} from "@automatalabs/workflows";
import {
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
} from "@automatalabs/workflows";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import type { WorkflowScriptLineageEntry } from "./workflow-tool-output.js";

export const SCRIPT_RESOURCE_MIME_TYPE = "text/javascript";
export const SCRIPT_RESOURCE_LIST_LIMIT = 50;
export const EVENTS_RESOURCE_MIME_TYPE = "application/json";
export const WORKFLOW_RUN_EVENTS_SCHEMA_VERSION = 1 as const;

const SCRIPT_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/script$/;
const EVENTS_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/events(?:\?([^#]*))?$/;
const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;

function resourceNotFound(uri: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Workflow script resource not found: ${uri}`);
}

export function workflowScriptUri(runId: string): string {
  return `workflow://runs/${runId}/script`;
}

export function workflowRunIdFromScriptUri(uri: string): string | undefined {
  return SCRIPT_URI_PATTERN.exec(uri)?.[1];
}

export function workflowRunEventsUri(runId: string): string {
  return `workflow://runs/${runId}/events`;
}

export interface WorkflowRunEventsResourceDocument {
  schemaVersion: typeof WORKFLOW_RUN_EVENTS_SCHEMA_VERSION;
  runId: string;
  streamId: string;
  status: PersistedRunState["status"];
  finalized: boolean;
  after: number;
  cursor: number;
  endCursor: number;
  hasMore: boolean;
  events: RunEventLogRecord[];
}

export interface ParsedWorkflowRunEventsUri {
  runId: string;
  canonical: boolean;
  after?: number;
  limit?: number;
  streamId?: string;
  normalizedUri: string;
}

function parseDecimal(value: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
}

export function parseWorkflowRunEventsUri(uri: string): ParsedWorkflowRunEventsUri | undefined {
  const match = EVENTS_URI_PATTERN.exec(uri);
  if (!match || match[1]!.length > 128) return undefined;
  const runId = match[1]!;
  if (match[2] === undefined) return { runId, canonical: true, normalizedUri: workflowRunEventsUri(runId) };
  if (match[2].length === 0) return undefined;
  const values = new Map<string, string>();
  for (const pair of match[2].split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator !== pair.lastIndexOf("=")) return undefined;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!(["after", "limit", "streamId"] as const).includes(key as "after") || values.has(key) || value.length === 0) {
      return undefined;
    }
    values.set(key, value);
  }
  const after = values.has("after") ? parseDecimal(values.get("after")!) : 0;
  const limit = values.has("limit") ? parseDecimal(values.get("limit")!, RUN_EVENT_READ_LIMIT_MAX) : RUN_EVENT_READ_LIMIT_DEFAULT;
  const streamId = values.get("streamId");
  if (after === undefined || limit === undefined || limit < 1 || !streamId || !STREAM_ID_PATTERN.test(streamId)) return undefined;
  const normalizedUri = `${workflowRunEventsUri(runId)}?after=${after}&limit=${limit}&streamId=${streamId}`;
  return { runId, canonical: false, after, limit, streamId, normalizedUri };
}

interface EventSubscription {
  runId: string;
  uri: string;
  streamId: string;
  watcher?: RunEventStream;
  dirty: boolean;
  inFlight: boolean;
  needsRearm: boolean;
}

const INVALID_EVENT_CODES = new Set<RunEventLogErrorCode>([
  "RUN_NOT_FOUND", "ORPHANED_LOG", "EVENT_LOG_UNAVAILABLE", "WATERMARK_MISSING",
  "STREAM_ID_MISSING", "INVALID_CURSOR", "INVALID_LIMIT", "INVALID_STREAM_ID",
  "STREAM_MISMATCH", "CURSOR_AHEAD",
]);

function malformedEventsUri(): never {
  throw new McpError(ErrorCode.InvalidParams, "Malformed workflow run events URI.");
}

function mapEventError(error: unknown, parsed: ParsedWorkflowRunEventsUri): never {
  if (error instanceof McpError) throw error;
  if (error instanceof RunEventLogError) {
    const code = INVALID_EVENT_CODES.has(error.code) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    throw new McpError(code, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} failed (${error.code}).`);
  }
  throw new McpError(ErrorCode.InternalError, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} failed.`);
}

function startedAtMillis(state: PersistedRunState): number {
  const parsed = Date.parse(state.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineageSourceRunId(state: PersistedRunState): string | undefined {
  const sourceRunId = state.resumeSourceRunId;
  return sourceRunId === state.runId ? undefined : sourceRunId;
}

/**
 * Persistence-backed MCP script resources. Run content and lineage are read directly from the
 * engine store for every request; the only process-local state is protocol bookkeeping and a
 * transient controller for a live foreground checkpoint elicitation.
 */
export class WorkflowScriptResources {
  private readonly persistence: ReturnType<WorkflowManager["getPersistence"]>;
  private readonly subscriptions = new Set<string>();
  private readonly eventSubscriptions = new Map<string, EventSubscription>();
  private readonly deletedRunIds = new Set<string>();
  private readonly silentDeletionRunIds = new Set<string>();
  private readonly elicitationControllers = new Map<string, AbortController>();

  private readonly onRunDeleted = ({ runId }: { runId: string }): void => {
    const uri = workflowScriptUri(runId);
    this.subscriptions.delete(uri);
    this.closeEventSubscription(workflowRunEventsUri(runId));
    this.cancelPendingElicitation(runId);
    this.deletedRunIds.add(runId);
    const notify = !this.silentDeletionRunIds.delete(runId);
    if (notify) void this.mcp.sendResourceListChanged();
  };

  constructor(
    private readonly mcp: McpServer,
    private readonly manager: WorkflowManager,
  ) {
    this.persistence = manager.getPersistence();
    this.manager.on("runDeleted", this.onRunDeleted);
    const previousOnClose = this.mcp.server.onclose;
    this.mcp.server.onclose = () => {
      for (const controller of this.elicitationControllers.values()) controller.abort();
      this.elicitationControllers.clear();
      for (const uri of [...this.eventSubscriptions.keys()]) this.closeEventSubscription(uri);
      this.manager.off("runDeleted", this.onRunDeleted);
      previousOnClose?.();
    };
    this.registerProtocolSurface();
  }

  /** Announce a resource only after the server has read its admitted record back successfully. */
  notifyRunAdmitted(runId: string): void {
    this.deletedRunIds.delete(runId);
    void this.mcp.sendResourceListChanged();
  }

  /** Bind the only request-lifetime admission state after the manager reveals the run ID. */
  trackPendingElicitation(runId: string, controller: AbortController | undefined): void {
    if (controller) this.elicitationControllers.set(runId, controller);
  }

  cancelPendingElicitation(runId: string): void {
    this.elicitationControllers.get(runId)?.abort();
    this.elicitationControllers.delete(runId);
  }

  /**
   * Delete through the composition boundary so subscription state and list notifications stay in
   * sync. Failed-admission cleanup passes notify=false because that resource was never announced.
   */
  deleteRun(runId: string, notify = true): boolean {
    if (!notify) this.silentDeletionRunIds.add(runId);
    const deleted = this.manager.deleteRun(runId);
    if (!deleted) this.silentDeletionRunIds.delete(runId);
    return deleted;
  }

  /** Pure projection over the engine-owned durable ancestry pointers. */
  lineage(runId: string): WorkflowScriptLineageEntry[] {
    const newestToOldest: WorkflowScriptLineageEntry[] = [];
    const visited = new Set<string>();
    let currentRunId: string | undefined = runId;

    while (currentRunId && !visited.has(currentRunId)) {
      visited.add(currentRunId);
      const state = this.persistence.load(currentRunId);
      newestToOldest.push({
        runId: currentRunId,
        uri: workflowScriptUri(currentRunId),
        available: state !== null,
      });
      if (!state) {
        const tombstone: PersistedRunLineageTombstone | null | undefined =
          this.persistence.loadLineageTombstone?.(currentRunId);
        currentRunId = tombstone?.sourceRunId;
        continue;
      }
      currentRunId = lineageSourceRunId(state);
    }

    return newestToOldest.reverse();
  }

  links(lineage: WorkflowScriptLineageEntry[]): ResourceLink[] {
    const links: ResourceLink[] = [];
    for (const entry of lineage) {
      if (!entry.available) continue;
      const state = this.persistence.load(entry.runId);
      if (!state) continue;
      links.push({
        type: "resource_link",
        uri: entry.uri,
        name: `${state.workflowName} (${state.runId})`,
        description: `${state.status} · started ${state.startedAt}`,
        mimeType: SCRIPT_RESOURCE_MIME_TYPE,
      });
    }
    return links;
  }

  private recentRuns(): PersistedRunState[] {
    return this.persistence
      .list()
      .sort((left, right) => startedAtMillis(right) - startedAtMillis(left) || right.runId.localeCompare(left.runId))
      .slice(0, SCRIPT_RESOURCE_LIST_LIMIT);
  }

  private registerProtocolSurface(): void {
    this.mcp.registerResource(
      "workflow-run-script",
      new ResourceTemplate("workflow://runs/{runId}/script", {
        list: () => ({
          resources: this.recentRuns().map((state) => ({
            uri: workflowScriptUri(state.runId),
            name: `${state.workflowName} (${state.runId})`,
            description: `${state.status} · started ${state.startedAt}`,
            mimeType: SCRIPT_RESOURCE_MIME_TYPE,
          })),
        }),
        complete: {
          runId: (partial) =>
            this.recentRuns()
              .map((state) => state.runId)
              .filter((runId) => runId.startsWith(partial)),
        },
      }),
      {
        title: "Workflow run scripts",
        description:
          "Immutable admitted workflow scripts. Listing is discovery-only and contains at most the 50 newest runs by startedAt; direct workflow://runs/{runId}/script reads are unbounded.",
        mimeType: SCRIPT_RESOURCE_MIME_TYPE,
      },
      (uri) => this.readResource(uri.toString()),
    );

    this.mcp.registerResource(
      "workflow-run-events",
      new ResourceTemplate("workflow://runs/{runId}/events", {
        list: () => ({
          resources: this.recentRuns()
            .filter((state) => state.eventStreamId !== undefined && state.eventSeq !== undefined)
            .map((state) => ({
              uri: workflowRunEventsUri(state.runId),
              name: `${state.workflowName} events (${state.runId})`,
              description: `${state.status} · append-only run events · started ${state.startedAt}`,
              mimeType: EVENTS_RESOURCE_MIME_TYPE,
            })),
        }),
        complete: {
          runId: (partial) => this.recentRuns()
            .filter((state) => state.eventStreamId !== undefined && state.eventSeq !== undefined)
            .map((state) => state.runId)
            .filter((runId) => runId.startsWith(partial)),
        },
      }),
      {
        title: "Workflow run events",
        description: "Append-only, redacted workflow run events with cursor-based catch-up.",
        mimeType: EVENTS_RESOURCE_MIME_TYPE,
      },
      (uri) => this.readEventsResource(uri.toString()),
    );

    // The SDK's registerResource handler constructs URL before invoking the template callback.
    // Validate the raw wire string here so malformed input stays an InvalidParams client error.
    this.mcp.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      const uri = request.params.uri;
      return uri.includes("/events") ? this.readEventsResource(uri) : this.readResource(uri);
    });

    this.mcp.server.setRequestHandler(SubscribeRequestSchema, (request) => {
      const uri = request.params.uri;
      const runId = workflowRunIdFromScriptUri(uri);
      if (runId) {
        if (!this.persistence.load(runId)) resourceNotFound(uri);
        this.subscriptions.add(uri);
        return {};
      }
      if (!uri.includes("/events")) resourceNotFound(uri);
      const parsed = parseWorkflowRunEventsUri(uri);
      if (!parsed) malformedEventsUri();
      if (!parsed.canonical) throw new McpError(ErrorCode.InvalidParams, `Only ${workflowRunEventsUri(parsed.runId)} is subscribable.`);
      return this.subscribeEvents(parsed);
    });
    this.mcp.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      const uri = request.params.uri;
      const runId = workflowRunIdFromScriptUri(uri);
      if (runId) {
        if (
          !this.persistence.load(runId) &&
          !this.persistence.loadLineageTombstone?.(runId) &&
          !this.deletedRunIds.has(runId) &&
          !this.subscriptions.has(uri)
        ) resourceNotFound(uri);
        this.subscriptions.delete(uri);
        return {};
      }
      if (!uri.includes("/events")) resourceNotFound(uri);
      const parsed = parseWorkflowRunEventsUri(uri);
      if (!parsed || !parsed.canonical) malformedEventsUri();
      if (!this.persistence.load(parsed.runId) && !this.persistence.loadLineageTombstone?.(parsed.runId) &&
          !this.deletedRunIds.has(parsed.runId) && !this.eventSubscriptions.has(parsed.normalizedUri)) {
        throw new McpError(ErrorCode.InvalidParams, `Workflow events resource ${parsed.normalizedUri} is not known.`);
      }
      this.closeEventSubscription(parsed.normalizedUri);
      return {};
    });
  }

  private subscribeEvents(parsed: ParsedWorkflowRunEventsUri): {} {
    const existing = this.eventSubscriptions.get(parsed.normalizedUri);
    if (existing && !existing.needsRearm && existing.watcher) return {};
    try {
      const state = this.persistence.load(parsed.runId);
      if (!state?.eventStreamId || state.eventSeq === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} are unavailable.`);
      }
      const page = this.persistence.readEvents(parsed.runId, { limit: 1, streamId: state.eventStreamId });
      const watcher = this.persistence.watchEvents(parsed.runId, { after: page.endCursor, streamId: page.streamId });
      const subscription = existing ?? {
        runId: parsed.runId,
        uri: parsed.normalizedUri,
        streamId: page.streamId,
        dirty: false,
        inFlight: false,
        needsRearm: false,
      };
      subscription.streamId = page.streamId;
      subscription.watcher?.close();
      subscription.watcher = watcher;
      subscription.needsRearm = false;
      this.eventSubscriptions.set(subscription.uri, subscription);
      this.drainEventWatcher(subscription, watcher);
      return {};
    } catch (error) {
      mapEventError(error, parsed);
    }
  }

  private drainEventWatcher(subscription: EventSubscription, watcher: RunEventStream): void {
    void (async () => {
      try {
        for await (const _record of watcher) {
          if (this.eventSubscriptions.get(subscription.uri) !== subscription || subscription.watcher !== watcher) return;
          this.markEventSubscriptionDirty(subscription);
        }
      } catch {
        if (this.eventSubscriptions.get(subscription.uri) !== subscription || subscription.watcher !== watcher) return;
        subscription.watcher = undefined;
        subscription.needsRearm = true;
        this.markEventSubscriptionDirty(subscription);
      }
    })();
  }

  private markEventSubscriptionDirty(subscription: EventSubscription): void {
    subscription.dirty = true;
    if (subscription.inFlight) return;
    queueMicrotask(() => this.sendEventUpdate(subscription));
  }

  private sendEventUpdate(subscription: EventSubscription): void {
    if (this.eventSubscriptions.get(subscription.uri) !== subscription || subscription.inFlight || !subscription.dirty) return;
    subscription.dirty = false;
    subscription.inFlight = true;
    void this.mcp.server.sendResourceUpdated({ uri: subscription.uri }).catch(() => {}).finally(() => {
      subscription.inFlight = false;
      if (this.eventSubscriptions.get(subscription.uri) === subscription && subscription.dirty) {
        queueMicrotask(() => this.sendEventUpdate(subscription));
      }
    });
  }

  private closeEventSubscription(uri: string): void {
    const subscription = this.eventSubscriptions.get(uri);
    if (!subscription) return;
    this.eventSubscriptions.delete(uri);
    subscription.dirty = false;
    subscription.needsRearm = false;
    subscription.watcher?.close();
    subscription.watcher = undefined;
  }

  private readEventsResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const parsed = parseWorkflowRunEventsUri(uri);
    if (!parsed) malformedEventsUri();
    try {
      const state = this.persistence.load(parsed.runId);
      if (!state?.eventStreamId || state.eventSeq === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} are unavailable.`);
      }
      let effectiveAfter = parsed.after ?? 0;
      const page = parsed.canonical
        ? (() => {
            const head = this.persistence.readEvents(parsed.runId, { limit: 1, streamId: state.eventStreamId });
            effectiveAfter = Math.max(0, head.endCursor - RUN_EVENT_READ_LIMIT_DEFAULT);
            return this.persistence.readEvents(parsed.runId, {
              after: effectiveAfter,
              limit: RUN_EVENT_READ_LIMIT_DEFAULT,
              streamId: head.streamId,
            });
          })()
        : this.persistence.readEvents(parsed.runId, {
            after: parsed.after,
            limit: parsed.limit,
            streamId: parsed.streamId,
          });
      const subscription = this.eventSubscriptions.get(workflowRunEventsUri(parsed.runId));
      if (subscription?.needsRearm) {
        const watcher = this.persistence.watchEvents(parsed.runId, { after: page.endCursor, streamId: page.streamId });
        subscription.watcher?.close();
        subscription.watcher = watcher;
        subscription.streamId = page.streamId;
        subscription.needsRearm = false;
        this.drainEventWatcher(subscription, watcher);
      }
      const document: WorkflowRunEventsResourceDocument = {
        schemaVersion: WORKFLOW_RUN_EVENTS_SCHEMA_VERSION,
        runId: parsed.runId,
        streamId: page.streamId,
        status: state.status,
        finalized: state.status !== "pending" && state.status !== "running",
        after: effectiveAfter,
        cursor: page.cursor,
        endCursor: page.endCursor,
        hasMore: page.cursor < page.endCursor,
        events: page.events,
      };
      return { contents: [{ uri: parsed.normalizedUri, mimeType: EVENTS_RESOURCE_MIME_TYPE, text: JSON.stringify(document) }] };
    } catch (error) {
      mapEventError(error, parsed);
    }
  }

  private readResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const runId = workflowRunIdFromScriptUri(uri);
    if (!runId) resourceNotFound(uri);
    const state = this.persistence.load(runId);
    if (!state) resourceNotFound(uri);
    return {
      contents: [
        {
          uri: workflowScriptUri(runId),
          mimeType: SCRIPT_RESOURCE_MIME_TYPE,
          text: state.script,
        },
      ],
    };
  }
}
