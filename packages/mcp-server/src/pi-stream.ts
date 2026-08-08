// packages/mcp-server/src/pi-stream.ts
//
// pi (pi-mcp-adapter) native server -> app push channel for the run-monitor panel.
//
// WHY. pi's MCP-Apps host bridge has never implemented resources/read for app-originated
// requests (measured: -32601 "Method not found" on the real 2.21.0 bundle for BOTH URI forms;
// its AppBridge is constructed with a null client and no serverResources capability). So the
// panel's event-poll resource read — the primary live channel on capable hosts — cannot work
// on pi. But pi is NOT resource-less in spirit: it ships a purpose-built server->app stream,
// wire-verified end to end against our real ext-apps App class:
//   1. the tool that opens the panel declares `_meta.ui["pi-mcp-adapter.streamMode"] = "eager"`;
//   2. pi attaches `_meta["pi-mcp-adapter/stream-token"] = <uuid>` to the initiating tools/call;
//   3. our server emits MCP notifications "notifications/pi-mcp-adapter/result-patch" with
//      { streamToken, result } — a CallToolResult carrying structuredContent;
//   4. pi routes each to the app as "notifications/pi-mcp-adapter/ui-result-patch", injecting
//      streamId + a monotonic sequence into structuredContent["pi-mcp-adapter/stream"];
//   5. the app detects the channel via hostContext["pi-mcp-adapter/stream"] and folds the frames.
//
// CONTRACT DETAILS THAT SHAPE THIS EMITTER (measured against pi-mcp-adapter 2.21.0):
//  - pi's `withStreamEnvelope` PRESERVES our structuredContent["pi-mcp-adapter/stream"] fields
//    (frameType/phase/status) but OVERWRITES streamId + sequence with its own. If we omit that
//    key, pi DEFAULTS every frame to `{ frameType: "final" }` — which pi treats as the terminal
//    frame of the stream. So every non-terminal frame MUST carry an explicit
//    frameType: "patch" | "checkpoint", and only the true terminal frame carries "final".
//  - pi's SSE event log keeps 128 events with Last-Event-ID replay, so patches must be
//    cursor-bearing SELF-CONTAINED windows (each frame carries its own after/cursor/events),
//    with periodic frameType:"checkpoint" envelopes as recent self-contained resync baselines.
//  - Server->app notifications trigger NO narration and NO agent turn on pi (only app-originated
//    tools/call and app.updateModelContext do). Push cadence is invisible to the host.
//
// This module is server-plumbing-free where it can be: the wire constants, the stream-token
// read, and the frame builder are pure and unit-tested; the PiStreamSession loop is driven by
// injected read/watch/send seams so it can be tested with a fake event feed.
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RunEventStream } from "@automatalabs/workflows";
import type { WorkflowRunEventsResourceDocument } from "./workflow-resources.js";

/** Meta key the panel-opening tool sets under `_meta.ui` to opt into the pi stream. */
export const PI_STREAM_TOOL_META_KEY = "pi-mcp-adapter.streamMode";
/** Only the eager mode is meaningful for us: the panel renders the initiating call's args. */
export const PI_STREAM_MODE_EAGER = "eager" as const;
/** Meta key pi attaches to the initiating tools/call carrying the per-call stream token. */
export const PI_STREAM_REQUEST_META_KEY = "pi-mcp-adapter/stream-token";
/** Notification method the SERVER emits; pi routes it to the app as .../ui-result-patch. */
export const PI_SERVER_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/result-patch";
/** structuredContent key carrying the visualization-stream envelope pi preserves + augments. */
export const PI_STREAM_STRUCTURED_CONTENT_KEY = "pi-mcp-adapter/stream";

/** Per-page window size for the push channel (mirrors the panel's PAGE_LIMIT). */
export const PI_STREAM_PAGE_LIMIT = 500;
/** Emit a checkpoint resync baseline every this-many live patch frames. */
export const PI_STREAM_CHECKPOINT_EVERY = 20;

export type PiStreamFrameType = "patch" | "checkpoint" | "final";

/** The envelope we author; pi overwrites streamId + sequence, keeps frameType/phase/status. */
export interface PiStreamEnvelopeSeed {
  frameType: PiStreamFrameType;
  phase: "shell" | "narrative" | "structure" | "detail" | "settled";
  status: "ok" | "error";
}

/** The CallToolResult payload of one result-patch notification. */
export interface PiStreamResult {
  content: [];
  structuredContent: WorkflowRunEventsResourceDocument & {
    [PI_STREAM_STRUCTURED_CONTENT_KEY]: PiStreamEnvelopeSeed;
  };
  isError: boolean;
}

/** Params of the "notifications/pi-mcp-adapter/result-patch" notification. */
export interface PiResultPatchParams {
  streamToken: string;
  result: PiStreamResult;
}

/** The `extra` bag the SDK passes to a tool handler (progress sink + AbortSignal + request _meta). */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Read the pi stream token pi attaches to the initiating tools/call `_meta`. Mirrors the
 * existing `_meta` read pattern in progress.ts (`extra._meta?.progressToken`). Returns undefined
 * on any host that is not pi-with-eager-streaming — the panel then uses resource polling or the
 * static fallback, per the host-classification rules.
 */
export function readPiStreamToken(extra: Pick<ToolExtra, "_meta">): string | undefined {
  const token = extra._meta?.[PI_STREAM_REQUEST_META_KEY];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Build one result-patch notification's params from an events window. The whole document is
 * carried in structuredContent (self-contained: after/cursor/endCursor/events/streamId), plus
 * our explicit envelope so pi does not default the frame to "final".
 */
export function buildResultPatchParams(
  streamToken: string,
  document: WorkflowRunEventsResourceDocument,
  frameType: PiStreamFrameType,
): PiResultPatchParams {
  const status: "ok" | "error" = document.status === "failed" || document.status === "aborted" ? "error" : "ok";
  return {
    streamToken,
    result: {
      content: [],
      structuredContent: {
        ...document,
        [PI_STREAM_STRUCTURED_CONTENT_KEY]: {
          frameType,
          // Non-terminal frames are "detail" refreshes of the run graph; the terminal frame settles.
          phase: frameType === "final" ? "settled" : "detail",
          status,
        },
      },
      isError: false,
    },
  };
}

/** The read/watch/send seams a PiStreamSession drives — injected so the loop is testable. */
export interface PiStreamSessionDeps {
  runId: string;
  streamToken: string;
  /** Cursor-paged, redacted run events (shared with the events resource/tool). Throws when the
   *  run has no readable event stream. */
  readEventsPage(request: {
    runId: string;
    after?: number;
    limit?: number;
    streamId?: string;
  }): WorkflowRunEventsResourceDocument;
  /** Subscribe to the run's event feed. Fires `onRecord` (best-effort) whenever new events land;
   *  returns a disposer, or undefined if the run has no watchable stream. */
  watch(after: number, streamId: string, onRecord: () => void): (() => void) | undefined;
  /** Emit one result-patch notification (fire-and-forget). */
  send(params: PiResultPatchParams): void;
  /** Optional: swallow-and-observe transport/read faults. */
  onError?(error: unknown): void;
  /** Optional: fired exactly once when the session stops (terminal frame, fault, or dispose). */
  onClosed?(): void;
  checkpointEvery?: number;
  pageLimit?: number;
}

/**
 * Drives the pi push channel for one run: an initial full-log baseline (checkpoint + patch
 * pages), then live patch frames off the event feed with periodic checkpoint resync baselines,
 * stopping on the terminal frame. Self-terminating (stops on finalized) and idempotently
 * disposable (server close / run deletion).
 */
export class PiStreamSession {
  private disposed = false;
  private started = false;
  private finalSent = false;
  private cursor = 0;
  private streamId: string | undefined;
  private patchesSinceCheckpoint = 0;
  private draining = false;
  private redrain = false;
  private unwatch: (() => void) | undefined;
  private readonly checkpointEvery: number;
  private readonly pageLimit: number;

  constructor(private readonly deps: PiStreamSessionDeps) {
    this.checkpointEvery = deps.checkpointEvery ?? PI_STREAM_CHECKPOINT_EVERY;
    this.pageLimit = deps.pageLimit ?? PI_STREAM_PAGE_LIMIT;
  }

  /** Begin streaming. Safe to call once; a second call is a no-op. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.bootstrap();
  }

  /** Stop streaming and release the event-feed watcher. Idempotent; fires onClosed exactly once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unwatch?.();
    this.unwatch = undefined;
    this.deps.onClosed?.();
  }

  private fail(error: unknown): void {
    this.deps.onError?.(error);
    // A push-channel fault must never wedge the run; give up this session cleanly.
    this.dispose();
  }

  /** Page the whole current log from cursor 0 so the panel folds a complete graph, no gap. */
  private async bootstrap(): Promise<void> {
    let firstPage = true;
    try {
      for (;;) {
        if (this.disposed) return;
        const doc = this.deps.readEventsPage({
          runId: this.deps.runId,
          after: this.cursor,
          limit: this.pageLimit,
          streamId: this.streamId,
        });
        this.streamId = doc.streamId;
        this.cursor = doc.cursor;
        const terminal = doc.finalized && !doc.hasMore;
        // First bootstrap frame is a self-contained checkpoint baseline; continuation pages are
        // patches; the final page of an already-terminal run is the terminal frame.
        const frameType: PiStreamFrameType = terminal ? "final" : firstPage ? "checkpoint" : "patch";
        this.emit(doc, frameType);
        firstPage = false;
        if (terminal) {
          this.finalSent = true;
          this.dispose();
          return;
        }
        if (!doc.hasMore) break;
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.disposed || this.streamId === undefined) return;
    // Subscribe to the live feed; each signal drains the tail into patch/checkpoint frames.
    this.unwatch = this.deps.watch(this.cursor, this.streamId, () => void this.drainLive());
    // A late-arriving record could have landed between the last bootstrap read and the watch arm;
    // one immediate drain closes that gap.
    void this.drainLive();
  }

  /** Serialized tail drain: reads new windows and pushes patch/checkpoint/final frames. */
  private async drainLive(): Promise<void> {
    if (this.disposed || this.finalSent || this.streamId === undefined) return;
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        if (this.disposed || this.finalSent) return;
        let doc: WorkflowRunEventsResourceDocument;
        try {
          doc = this.deps.readEventsPage({
            runId: this.deps.runId,
            after: this.cursor,
            limit: this.pageLimit,
            streamId: this.streamId,
          });
        } catch (error) {
          this.fail(error);
          return;
        }
        const advanced = doc.cursor > this.cursor;
        this.cursor = doc.cursor;
        if (doc.finalized && !doc.hasMore) {
          // Terminal: one final self-contained frame, then stop.
          this.emit(doc, "final");
          this.finalSent = true;
          this.dispose();
          return;
        }
        if (advanced || doc.events.length > 0) {
          this.patchesSinceCheckpoint += 1;
          const frameType: PiStreamFrameType =
            this.patchesSinceCheckpoint % this.checkpointEvery === 0 ? "checkpoint" : "patch";
          this.emit(doc, frameType);
        }
        if (doc.hasMore) continue;
        break;
      }
    } finally {
      this.draining = false;
      if (this.redrain && !this.disposed && !this.finalSent) {
        this.redrain = false;
        void this.drainLive();
      }
    }
  }

  private emit(document: WorkflowRunEventsResourceDocument, frameType: PiStreamFrameType): void {
    this.deps.send(buildResultPatchParams(this.deps.streamToken, document, frameType));
  }
}

/**
 * Server-side registry of active pi push sessions. Keyed by stream token so a repeated call with the
 * same token (pi re-issues one per UI-session activation) does not double-stream. pi keeps only ONE
 * panel per (server, tool), so a new stream-token for a run supersedes the prior one: the prior
 * session is disposed to avoid leaking event-feed watchers across repeated inspect/await calls on a
 * live run. Sessions self-evict from both maps when they finish (terminal, fault, or dispose), and
 * everything is disposed on server close.
 */
export class PiStreamManager {
  private readonly sessions = new Map<string, PiStreamSession>();
  private readonly tokenByRun = new Map<string, string>();
  private closed = false;

  /** Start a session for the given token. No-op after close or if the token is already streaming. */
  begin(deps: PiStreamSessionDeps): void {
    if (this.closed || this.sessions.has(deps.streamToken)) return;
    // A newer token for the same run supersedes the prior panel session; release its watcher.
    const priorToken = this.tokenByRun.get(deps.runId);
    if (priorToken !== undefined && priorToken !== deps.streamToken) {
      this.sessions.get(priorToken)?.dispose();
    }
    const session = new PiStreamSession({
      ...deps,
      onClosed: () => {
        this.sessions.delete(deps.streamToken);
        if (this.tokenByRun.get(deps.runId) === deps.streamToken) this.tokenByRun.delete(deps.runId);
        deps.onClosed?.();
      },
    });
    this.sessions.set(deps.streamToken, session);
    this.tokenByRun.set(deps.runId, deps.streamToken);
    session.start();
  }

  /** Dispose every active session (server shutdown). */
  disposeAll(): void {
    this.closed = true;
    for (const session of [...this.sessions.values()]) session.dispose();
    this.sessions.clear();
    this.tokenByRun.clear();
  }
}

/** Build a raw MCP notification the low-level server accepts for the pi push channel. */
export function piResultPatchNotification(params: PiResultPatchParams): ServerNotification {
  // The method is not in the ServerNotification union (it is an adapter-owned extension), but the
  // low-level server's assertNotificationCapability no-ops for unrecognized methods, so the send
  // is accepted at runtime. The cast is the single, contained bridge for that.
  return { method: PI_SERVER_RESULT_PATCH_METHOD, params } as unknown as ServerNotification;
}
