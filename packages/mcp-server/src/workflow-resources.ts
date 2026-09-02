import { ResourceTemplate, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { McpServer, ResourceLink, ServerContext, ServerNotifier } from "@modelcontextprotocol/server";
import type {
  PersistedRunLineageTombstone,
  PersistedRunState,
  RunEventLogErrorCode,
  RunEventPersistence,
  RunEventStream,
} from "@automatalabs/workflows";
import {
  RUN_EVENT_READ_LIMIT_DEFAULT,
  RUN_EVENT_READ_LIMIT_MAX,
  RunEventLogError,
  WorkflowManager,
  redactText,
  truncateUtf8,
} from "@automatalabs/workflows";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import { singleStoreRouter, type RunStoreRouter } from "./project-registry.js";

import type {
  WorkflowRunLatestActivity,
  WorkflowScriptLineageEntry,
} from "./workflow-tool-output.js";

export const SCRIPT_RESOURCE_MIME_TYPE = "text/javascript";
export const RESULT_RESOURCE_MIME_TYPE = "application/json";
export const SCRIPT_RESOURCE_LIST_LIMIT = 50;
export const EVENTS_RESOURCE_MIME_TYPE = "application/json";
export const WORKFLOW_RUN_EVENTS_SCHEMA_VERSION = 1 as const;

const SCRIPT_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/script$/;
const RESULT_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/result$/;
const EVENTS_URI_PATTERN = /^workflow:\/\/runs\/([a-z0-9]+-[a-z0-9]+)\/events(?:\?([^#]*))?$/;
const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_ACTIVITY_SCALAR_BYTES = 512;

function resourceNotFound(uri: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Workflow resource not found: ${uri}`);
}

export function workflowScriptUri(runId: string): string {
  return `workflow://runs/${runId}/script`;
}

export function workflowRunIdFromScriptUri(uri: string): string | undefined {
  return SCRIPT_URI_PATTERN.exec(uri)?.[1];
}

export function workflowResultUri(runId: string): string {
  return `workflow://runs/${runId}/result`;
}

export function workflowRunIdFromResultUri(uri: string): string | undefined {
  return RESULT_URI_PATTERN.exec(uri)?.[1];
}

export function workflowRunEventsUri(runId: string): string {
  return `workflow://runs/${runId}/events`;
}

export interface SerializedWorkflowResult {
  uri: string;
  text: string;
  bytes: number;
}

function hasExactResult(state: PersistedRunState): boolean {
  return state.status === "completed" && state.result !== undefined;
}

function hasDurableEventStream(state: PersistedRunState): boolean {
  // A run whose journal append faulted mid-run persists eventLogIncomplete and its read/watch
  // seam fails closed (EVENT_LOG_INCOMPLETE). Such a stream is integrity-unsafe, so it is never
  // advertised: availableEventsUri, eventsLink, latestActivity, and the events resource listing
  // must all omit it, matching requireDurableStoppedRun and the legacy/stream-less handling.
  return state.eventLogIncomplete !== true &&
    typeof state.eventStreamId === "string" && STREAM_ID_PATTERN.test(state.eventStreamId) &&
    Number.isSafeInteger(state.eventSeq) && (state.eventSeq ?? -1) >= 0;
}

function latestActivityKey(scope: string, callIndex: number): string {
  return JSON.stringify([scope, callIndex]);
}

function safeActivityText(value: string): string {
  return truncateUtf8(redactText(value).value, MAX_ACTIVITY_SCALAR_BYTES);
}

export interface WorkflowRunEventsResourceDocument {
  schemaVersion: typeof WORKFLOW_RUN_EVENTS_SCHEMA_VERSION;
  runId: string;
  streamId: string;
  workflowName: string;
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
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Malformed workflow run events URI.");
}

function mapEventError(error: unknown, parsed: ParsedWorkflowRunEventsUri): never {
  if (error instanceof ProtocolError) throw error;
  if (error instanceof RunEventLogError) {
    const code = INVALID_EVENT_CODES.has(error.code) ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError;
    throw new ProtocolError(code, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} failed (${error.code}).`);
  }
  throw new ProtocolError(ProtocolErrorCode.InternalError, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} failed.`);
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
  private readonly router: RunStoreRouter;
  private readonly detachRunDeleted: () => void;
  private readonly detachRunEventPersisted: () => void;
  private readonly detachRunStopped: () => void;
  private readonly subscriptions = new Set<string>();
  private readonly externalReaders = new Map<
    string,
    {
      read: () => { contents: Array<{ uri: string; mimeType: string; text: string }> };
      available?: (ctx: ServerContext) => boolean;
    }
  >();
  private readonly eventSubscriptions = new Map<string, EventSubscription>();
  private readonly deletedRunIds = new Set<string>();
  private readonly silentDeletionRunIds = new Set<string>();
  private readonly elicitationControllers = new Map<string, AbortController>();

  private readonly onRunDeleted = ({ runId }: { runId: string }): void => {
    this.subscriptions.delete(workflowScriptUri(runId));
    this.subscriptions.delete(workflowResultUri(runId));
    this.closeEventSubscription(workflowRunEventsUri(runId));
    this.cancelPendingElicitation(runId);
    this.deletedRunIds.add(runId);
    const notify = !this.silentDeletionRunIds.delete(runId);
    if (notify && !this.modernNotifier) void this.mcp.sendResourceListChanged();
  };

  constructor(
    private readonly mcp: McpServer,
    source: WorkflowManager | { router: RunStoreRouter },
    private readonly modernNotifier?: ServerNotifier,
  ) {
    this.router = source instanceof WorkflowManager ? singleStoreRouter(source) : source.router;
    this.detachRunDeleted = this.router.onRunDeleted(this.onRunDeleted);
    // Modern stateless requests each construct a short-lived server, so registering the same
    // global run listener here would fan one completion out once per in-flight request. The
    // daemon composition root owns the single modern notification listener instead.
    this.detachRunEventPersisted = this.modernNotifier
      ? () => undefined
      : this.router.onRunEventPersisted((record) => {
          if (record.event.type !== "complete") return;
          // The engine publishes the durable event before its terminal snapshot save. Defer one
          // microtask and re-read persistence so list_changed never advertises a result that is
          // not durably readable (including a failed terminal save).
          queueMicrotask(() => {
            try {
              if (this.availableResultUri(record.runId)) void this.mcp.sendResourceListChanged();
            } catch {
              // Corrupt/unreadable state has no result resource and therefore no availability hint.
            }
          });
        });
    this.detachRunStopped = this.router.onRunStopped(({ runId }) => this.cancelPendingElicitation(runId));
    const previousOnClose = this.mcp.server.onclose;
    this.mcp.server.onclose = () => {
      for (const controller of this.elicitationControllers.values()) controller.abort();
      this.elicitationControllers.clear();
      for (const uri of [...this.eventSubscriptions.keys()]) this.closeEventSubscription(uri);
      this.detachRunStopped();
      this.detachRunEventPersisted();
      this.detachRunDeleted();
      previousOnClose?.();
    };
    this.registerProtocolSurface();
  }

  /** The persistence store containing runId, if any known project store holds it. */
  private persistenceFor(runId: string): RunEventPersistence | undefined {
    return this.router.storeFor(runId)?.manager.getPersistence();
  }

  /**
   * Reconcile a run orphaned by a dead owner before reading its events. `await`/`stop` already do
   * this (server.ts), but the events read path did not: a run left "running" with a frozen journal
   * by a daemon that exited stayed status "running", so buildEventsDocument reported finalized:false
   * forever and the run-monitor panel polled it without end. Mirror the tool paths — only reconcile
   * when nothing live in THIS process owns the run — and let a failed reconcile fall through to
   * reporting the run's current persisted state.
   */
  private reconcileDeadRunForEvents(runId: string): void {
    const manager = this.router.storeFor(runId)?.manager;
    if (!manager || manager.getRun(runId) !== undefined) return;
    try {
      manager.reconcileExternallyDeadRun(runId);
    } catch {
      // Best-effort: a reconcile fault must not block an otherwise-serviceable events read.
    }
  }

  /** Load a persisted run from whichever project store holds it. */
  private loadState(runId: string): PersistedRunState | null {
    return this.persistenceFor(runId)?.load(runId) ?? null;
  }

  /** Tombstones outlive their run file, so consult every live store. */
  private loadTombstone(runId: string): PersistedRunLineageTombstone | null | undefined {
    for (const context of this.router.stores()) {
      const tombstone = context.manager.getPersistence().loadLineageTombstone?.(runId);
      if (tombstone) return tombstone;
    }
    return undefined;
  }

  /**
   * Serve a fixed, non-run resource (exact URI match) through this class's resources/read
   * router. Needed because registerProtocolSurface replaces the SDK's default read dispatch.
   */
  registerExternalResourceReader(
    uri: string,
    read: () => { contents: Array<{ uri: string; mimeType: string; text: string }> },
    available?: (ctx: ServerContext) => boolean,
  ): void {
    this.externalReaders.set(uri, { read, available });
  }

  /** Announce a resource only after the server has read its admitted record back successfully. */
  notifyRunAdmitted(runId: string): void {
    this.deletedRunIds.delete(runId);
    if (this.modernNotifier) this.modernNotifier.resourcesChanged();
    else void this.mcp.sendResourceListChanged();
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
    const deleted = this.router.storeFor(runId)?.manager.deleteRun(runId) ?? false;
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
      const state = this.loadState(currentRunId);
      newestToOldest.push({
        runId: currentRunId,
        uri: workflowScriptUri(currentRunId),
        available: state !== null,
      });
      if (!state) {
        const tombstone = this.loadTombstone(currentRunId);
        currentRunId = tombstone?.sourceRunId;
        continue;
      }
      currentRunId = lineageSourceRunId(state);
    }

    return newestToOldest.reverse();
  }

  /** Exact persisted result metadata, available only for completed runs with a JSON value. */
  serializedResult(runId: string): SerializedWorkflowResult {
    const state = this.loadState(runId);
    if (!state) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `No workflow run found for runId "${runId}" in this server's project-scoped run store.`,
      );
    }
    if (!hasExactResult(state)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        state.status === "completed"
          ? `Workflow run "${runId}" completed without a JSON result.`
          : `Workflow result for runId "${runId}" is unavailable while the run is ${state.status}.`,
      );
    }
    let text: string | undefined;
    try {
      text = JSON.stringify(state.result);
    } catch {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Workflow result for runId "${runId}" could not be serialized.`,
      );
    }
    if (text === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Workflow result for runId "${runId}" could not be serialized.`,
      );
    }
    return {
      uri: workflowResultUri(runId),
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }

  availableResultUri(runId: string): string | undefined {
    const state = this.loadState(runId);
    return state && hasExactResult(state) ? workflowResultUri(runId) : undefined;
  }

  /** Canonical events URI when the persisted row belongs to the durable event-log era. */
  availableEventsUri(runId: string): string | undefined {
    const state = this.loadState(runId);
    return state && hasDurableEventStream(state) ? workflowRunEventsUri(runId) : undefined;
  }

  resultLink(runId: string): ResourceLink | undefined {
    const state = this.loadState(runId);
    if (!state || !hasExactResult(state)) return undefined;
    return {
      type: "resource_link",
      uri: workflowResultUri(runId),
      name: `${state.workflowName} result (${state.runId})`,
      description: `exact workflow result · completed ${state.completedAt ?? state.updatedAt}`,
      mimeType: RESULT_RESOURCE_MIME_TYPE,
    };
  }

  eventsLink(runId: string): ResourceLink | undefined {
    const state = this.loadState(runId);
    if (!state || !hasDurableEventStream(state)) return undefined;
    return {
      type: "resource_link",
      uri: workflowRunEventsUri(runId),
      name: `${state.workflowName} events (${state.runId})`,
      description: `detailed workflow event stream · ${state.status} · started ${state.startedAt}`,
      mimeType: EVENTS_RESOURCE_MIME_TYPE,
    };
  }

  /**
   * Fold the validated durable stream into one compact latest sample per logical call. The
   * append-only events resource remains the detailed transcript and cursor authority.
   */
  latestActivity(runId: string): WorkflowRunLatestActivity[] | undefined {
    const persistence = this.persistenceFor(runId);
    const state = persistence?.load(runId);
    if (!persistence || !state || !hasDurableEventStream(state)) return undefined;

    const latest = new Map<string, WorkflowRunLatestActivity>();
    const active = new Set<string>();
    let after = 0;
    let streamId = state.eventStreamId;
    try {
      while (true) {
        const page = persistence.readEvents(runId, {
          after,
          limit: RUN_EVENT_READ_LIMIT_MAX,
          streamId,
        });
        streamId = page.streamId;
        for (const record of page.events) {
          const event = record.event;
          if (event.type === "agentStart") {
            const key = latestActivityKey(event.scope, event.callIndex);
            active.add(key);
            const previous = latest.get(key);
            if (previous) latest.set(key, { ...previous, relevance: "terminal" });
            continue;
          }
          if (event.type === "agentProgress") {
            const key = latestActivityKey(event.scope, event.callIndex);
            latest.set(key, {
              scope: safeActivityText(event.scope),
              callIndex: event.callIndex,
              executionStartSeq: event.executionStartSeq,
              label: safeActivityText(event.label),
              ...(event.phase === undefined ? {} : { phase: safeActivityText(event.phase) }),
              timestamp: safeActivityText(record.timestamp),
              cursor: record.seq,
              turnCount: event.turnCount,
              observedEvents: event.observedEvents,
              ...(event.latestText === undefined
                ? { lastToolName: safeActivityText(event.lastToolName!) }
                : { latestText: safeActivityText(event.latestText) }),
              ...(event.tokensObserved === undefined ? {} : { tokensObserved: event.tokensObserved }),
              relevance: active.has(key) ? "current" : "terminal",
            });
            continue;
          }
          if (event.type === "agentEnd") {
            const key = latestActivityKey(event.scope, event.callIndex);
            active.delete(key);
            const previous = latest.get(key);
            if (previous) latest.set(key, { ...previous, relevance: "terminal" });
            continue;
          }
          if (event.type === "complete" || event.type === "paused" || event.type === "error" || event.type === "stopped") {
            active.clear();
            for (const [key, previous] of latest) {
              if (previous.relevance !== "terminal") latest.set(key, { ...previous, relevance: "terminal" });
            }
          }
        }
        after = page.cursor;
        if (!page.hasMore) break;
      }
    } catch {
      // Status remains available for legacy, incomplete, corrupt, or otherwise unsafe streams.
      return undefined;
    }

    if (state.status !== "pending" && state.status !== "running") {
      for (const [key, previous] of latest) {
        if (previous.relevance !== "terminal") latest.set(key, { ...previous, relevance: "terminal" });
      }
    }
    return [...latest.values()].sort((left, right) => left.cursor - right.cursor);
  }

  links(lineage: WorkflowScriptLineageEntry[]): ResourceLink[] {
    const links: ResourceLink[] = [];
    for (const entry of lineage) {
      if (!entry.available) continue;
      const state = this.loadState(entry.runId);
      if (!state) continue;
      links.push({
        type: "resource_link",
        uri: entry.uri,
        name: `${state.workflowName} script (${state.runId})`,
        description: `workflow script · ${state.status} · started ${state.startedAt}`,
        mimeType: SCRIPT_RESOURCE_MIME_TYPE,
      });
    }
    return links;
  }

  private recentRuns(): PersistedRunState[] {
    return this.router
      .stores()
      .flatMap((context) => context.manager.getPersistence().list())
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
            name: `${state.workflowName} script (${state.runId})`,
            description: `workflow script · ${state.status} · started ${state.startedAt}`,
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
      "workflow-run-result",
      new ResourceTemplate("workflow://runs/{runId}/result", {
        list: () => ({
          resources: this.recentRuns()
            .filter(hasExactResult)
            .map((state) => ({
              uri: workflowResultUri(state.runId),
              name: `${state.workflowName} result (${state.runId})`,
              description: `exact workflow result · completed ${state.completedAt ?? state.updatedAt}`,
              mimeType: RESULT_RESOURCE_MIME_TYPE,
            })),
        }),
        complete: {
          runId: (partial) =>
            this.recentRuns()
              .filter(hasExactResult)
              .map((state) => state.runId)
              .filter((runId) => runId.startsWith(partial)),
        },
      }),
      {
        title: "Workflow run results",
        description:
          "Exact JSON results for completed workflow runs. Listing is discovery-only and contains at most the 50 newest runs; direct workflow://runs/{runId}/result reads remain available until run deletion.",
        mimeType: RESULT_RESOURCE_MIME_TYPE,
      },
      (uri) => this.readResultResource(uri.toString()),
    );

    this.mcp.registerResource(
      "workflow-run-events",
      new ResourceTemplate("workflow://runs/{runId}/events", {
        list: () => ({
          resources: this.recentRuns()
            .filter(hasDurableEventStream)
            .map((state) => ({
              uri: workflowRunEventsUri(state.runId),
              name: `${state.workflowName} events (${state.runId})`,
              description: `${state.status} · append-only run events · started ${state.startedAt}`,
              mimeType: EVENTS_RESOURCE_MIME_TYPE,
            })),
        }),
        complete: {
          runId: (partial) => this.recentRuns()
            .filter(hasDurableEventStream)
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
    // This handler REPLACES the SDK's default resources/read dispatch, so any fixed resource
    // registered outside this class (e.g. the MCP Apps ui:// panel) must also register a
    // reader here via registerExternalResourceReader.
    this.mcp.server.setRequestHandler('resources/read', (request, ctx) => {
      const uri = request.params.uri;
      const external = this.externalReaders.get(uri);
      if (external) {
        if (external.available !== undefined && !external.available(ctx)) resourceNotFound(uri);
        return external.read();
      }
      if (uri.includes("/events")) return this.readEventsResource(uri);
      if (workflowRunIdFromResultUri(uri)) return this.readResultResource(uri);
      return this.readResource(uri);
    });

    this.mcp.server.setRequestHandler('resources/subscribe', (request, ctx) => {
      const uri = request.params.uri;
      // Fixed external resources (authoring docs and the app panel) never update.
      // Accept host auto-subscription as a no-op rather than claiming a listed URI is missing.
      const external = this.externalReaders.get(uri);
      if (external) {
        if (external.available !== undefined && !external.available(ctx)) resourceNotFound(uri);
        return {};
      }
      const runId = workflowRunIdFromScriptUri(uri);
      if (runId) {
        if (!this.loadState(runId)) resourceNotFound(uri);
        this.subscriptions.add(uri);
        return {};
      }
      const resultRunId = workflowRunIdFromResultUri(uri);
      if (resultRunId) {
        if (!this.availableResultUri(resultRunId)) resourceNotFound(uri);
        this.subscriptions.add(uri);
        return {};
      }
      if (!uri.includes("/events")) resourceNotFound(uri);
      const parsed = parseWorkflowRunEventsUri(uri);
      if (!parsed) malformedEventsUri();
      if (!parsed.canonical) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Only ${workflowRunEventsUri(parsed.runId)} is subscribable.`);
      return this.subscribeEvents(parsed);
    });
    this.mcp.server.setRequestHandler('resources/unsubscribe', (request, ctx) => {
      const uri = request.params.uri;
      const external = this.externalReaders.get(uri);
      if (external) {
        if (external.available !== undefined && !external.available(ctx)) resourceNotFound(uri);
        return {};
      }
      const runId = workflowRunIdFromScriptUri(uri) ?? workflowRunIdFromResultUri(uri);
      if (runId) {
        if (
          !this.loadState(runId) &&
          !this.loadTombstone(runId) &&
          !this.deletedRunIds.has(runId) &&
          !this.subscriptions.has(uri)
        ) resourceNotFound(uri);
        this.subscriptions.delete(uri);
        return {};
      }
      if (!uri.includes("/events")) resourceNotFound(uri);
      const parsed = parseWorkflowRunEventsUri(uri);
      if (!parsed || !parsed.canonical) malformedEventsUri();
      if (!this.loadState(parsed.runId) && !this.loadTombstone(parsed.runId) &&
          !this.deletedRunIds.has(parsed.runId) && !this.eventSubscriptions.has(parsed.normalizedUri)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Workflow events resource ${parsed.normalizedUri} is not known.`);
      }
      this.closeEventSubscription(parsed.normalizedUri);
      return {};
    });
  }

  private subscribeEvents(parsed: ParsedWorkflowRunEventsUri): {} {
    const existing = this.eventSubscriptions.get(parsed.normalizedUri);
    if (existing && !existing.needsRearm && existing.watcher) return {};
    try {
      const persistence = this.persistenceFor(parsed.runId);
      const state = persistence?.load(parsed.runId);
      if (!persistence || !state?.eventStreamId || state.eventSeq === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Workflow events ${parsed.normalizedUri} for ${parsed.runId} are unavailable.`);
      }
      const page = persistence.readEvents(parsed.runId, { limit: 1, streamId: state.eventStreamId });
      const watcher = persistence.watchEvents(parsed.runId, { after: page.endCursor, streamId: page.streamId });
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

  /**
   * Shared events-page builder used by both the `workflow://runs/{runId}/events` resource and
   * the app-only `workflow-events` tool. `streamId` defaults to the run's current stream and
   * `after` to 0, so a UI consumer can bootstrap the full log without a prior head read.
   * Throws McpError (unavailable) or RunEventLogError (cursor/stream faults) — callers map.
   */
  readEventsPage(request: {
    runId: string;
    after?: number;
    limit?: number;
    streamId?: string;
  }): WorkflowRunEventsResourceDocument {
    this.reconcileDeadRunForEvents(request.runId);
    const persistence = this.persistenceFor(request.runId);
    const state = persistence?.load(request.runId);
    if (!persistence || !state?.eventStreamId || state.eventSeq === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Workflow events for ${request.runId} are unavailable.`,
      );
    }
    const after = request.after ?? 0;
    const page = persistence.readEvents(request.runId, {
      after,
      limit: request.limit ?? RUN_EVENT_READ_LIMIT_DEFAULT,
      streamId: request.streamId ?? state.eventStreamId,
    });
    return this.buildEventsDocument(request.runId, state, after, page);
  }

  /** Canonical (query-less) resource read: the tail window of the current stream. */
  private readEventsTail(runId: string): WorkflowRunEventsResourceDocument {
    this.reconcileDeadRunForEvents(runId);
    const persistence = this.persistenceFor(runId);
    const state = persistence?.load(runId);
    if (!persistence || !state?.eventStreamId || state.eventSeq === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Workflow events for ${runId} are unavailable.`);
    }
    const head = persistence.readEvents(runId, { limit: 1, streamId: state.eventStreamId });
    const effectiveAfter = Math.max(0, head.endCursor - RUN_EVENT_READ_LIMIT_DEFAULT);
    const page = persistence.readEvents(runId, {
      after: effectiveAfter,
      limit: RUN_EVENT_READ_LIMIT_DEFAULT,
      streamId: head.streamId,
    });
    return this.buildEventsDocument(runId, state, effectiveAfter, page);
  }

  private buildEventsDocument(
    runId: string,
    state: PersistedRunState,
    after: number,
    page: ReturnType<ReturnType<WorkflowManager["getPersistence"]>["readEvents"]>,
  ): WorkflowRunEventsResourceDocument {
    const subscription = this.eventSubscriptions.get(workflowRunEventsUri(runId));
    if (subscription?.needsRearm) {
      // The store just answered a read, so it is present; skip the re-arm if it vanished since.
      const watcher = this.persistenceFor(runId)?.watchEvents(runId, { after: page.endCursor, streamId: page.streamId });
      if (watcher !== undefined) {
        subscription.watcher?.close();
        subscription.watcher = watcher;
        subscription.streamId = page.streamId;
        subscription.needsRearm = false;
        this.drainEventWatcher(subscription, watcher);
      }
    }
    return {
      schemaVersion: WORKFLOW_RUN_EVENTS_SCHEMA_VERSION,
      runId,
      streamId: page.streamId,
      workflowName: state.workflowName,
      status: state.status,
      finalized: state.status !== "pending" && state.status !== "running",
      after,
      cursor: page.cursor,
      endCursor: page.endCursor,
      hasMore: page.cursor < page.endCursor,
      events: page.events,
    };
  }

  private readEventsResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const parsed = parseWorkflowRunEventsUri(uri);
    if (!parsed) malformedEventsUri();
    try {
      const document = parsed.canonical
        ? this.readEventsTail(parsed.runId)
        : this.readEventsPage({
            runId: parsed.runId,
            after: parsed.after,
            limit: parsed.limit,
            streamId: parsed.streamId,
          });
      return { contents: [{ uri: parsed.normalizedUri, mimeType: EVENTS_RESOURCE_MIME_TYPE, text: JSON.stringify(document) }] };
    } catch (error) {
      mapEventError(error, parsed);
    }
  }

  private readResultResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const runId = workflowRunIdFromResultUri(uri);
    if (!runId) resourceNotFound(uri);
    const result = this.serializedResult(runId);
    return {
      contents: [
        {
          uri: result.uri,
          mimeType: RESULT_RESOURCE_MIME_TYPE,
          text: result.text,
        },
      ],
    };
  }

  private readResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const runId = workflowRunIdFromScriptUri(uri);
    if (!runId) resourceNotFound(uri);
    const state = this.loadState(runId);
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
