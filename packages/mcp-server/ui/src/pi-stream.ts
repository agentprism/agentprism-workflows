// pi (pi-mcp-adapter) native server->app push channel — PANEL side. See the server counterpart
// packages/mcp-server/src/pi-stream.ts for the full contract and the measured wire facts.
//
// On pi (eager streamMode) the panel cannot poll the events resource (app-originated resources/read
// is answered -32601), so it folds server-pushed windows instead:
//   - detect the channel via hostContext["pi-mcp-adapter/stream"] (mode/streamId), OR the arrival of
//     a "notifications/pi-mcp-adapter/ui-result-patch" notification;
//   - each notification's params.structuredContent carries a self-contained events window (the same
//     shape the events resource serves) PLUS structuredContent["pi-mcp-adapter/stream"] = the
//     envelope pi augmented with { streamId, sequence } (its own UI stream id + a monotonic counter);
//   - verify the envelope streamId matches the host-context stream, order by pi's sequence, and fold
//     each window into the SAME RunModel the resource poll feeds.
//
// Windows can arrive out of order or be replayed (pi's SSE keeps 128 events with Last-Event-ID
// replay), so the fold is cursor-driven: it applies a window only when it is contiguous with the
// model cursor, buffers a window that is ahead until its predecessor fills the gap, and skips
// records already folded. That makes reorder + replay + periodic checkpoint baselines all safe.
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import { foldRecord } from "./state.js";
import type { RunModel, RunStatus } from "./state.js";

/** hostContext key pi sets when the panel-opening tool declared eager streamMode. */
export const PI_STREAM_HOST_CONTEXT_KEY = "pi-mcp-adapter/stream";
/** Notification method pi routes each server result-patch to inside the app. */
export const PI_UI_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";
/** structuredContent key carrying the visualization-stream envelope. */
export const PI_STREAM_STRUCTURED_CONTENT_KEY = "pi-mcp-adapter/stream";

/** The pi UI-stream descriptor placed in the ui/initialize hostContext. */
export interface PiStreamHostContext {
  mode: string;
  streamId: string;
}

/** The envelope pi delivers on each frame (frameType/phase/status authored by us; streamId +
 *  sequence stamped by pi). */
export interface PiStreamEnvelope {
  frameType: string;
  phase?: string;
  status?: string;
  streamId: string;
  sequence: number;
}

/** The self-contained events window carried in a frame — structurally the events resource doc. */
export interface PiStreamWindow {
  streamId: string;
  workflowName?: string;
  status: RunStatus;
  finalized: boolean;
  after: number;
  cursor: number;
  endCursor: number;
  events: RunEventLogRecord[];
}

export interface PiStreamFrame {
  envelope: PiStreamEnvelope;
  window: PiStreamWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the pi stream host-context, if present and well-formed, from the app's ui/initialize result. */
export function getPiStreamHostContext(
  hostContext: Record<string, unknown> | undefined,
): PiStreamHostContext | undefined {
  const candidate = hostContext?.[PI_STREAM_HOST_CONTEXT_KEY];
  if (!isRecord(candidate)) return undefined;
  const { mode, streamId } = candidate;
  if (typeof mode !== "string" || typeof streamId !== "string" || streamId.length === 0) return undefined;
  return { mode, streamId };
}

function parseEnvelope(value: unknown): PiStreamEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const { frameType, streamId, sequence } = value;
  if (typeof frameType !== "string" || typeof streamId !== "string" || typeof sequence !== "number") {
    return undefined;
  }
  return {
    frameType,
    streamId,
    sequence,
    ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
  };
}

function parseWindow(structured: Record<string, unknown>): PiStreamWindow | undefined {
  const { streamId, status, finalized, after, cursor, endCursor, events } = structured;
  if (
    typeof streamId !== "string" ||
    typeof status !== "string" ||
    typeof finalized !== "boolean" ||
    typeof after !== "number" ||
    typeof cursor !== "number" ||
    typeof endCursor !== "number" ||
    !Array.isArray(events)
  ) {
    return undefined;
  }
  return {
    streamId,
    status: status as RunStatus,
    finalized,
    after,
    cursor,
    endCursor,
    events: events as RunEventLogRecord[],
    ...(typeof structured.workflowName === "string" ? { workflowName: structured.workflowName } : {}),
  };
}

/**
 * Parse a "notifications/pi-mcp-adapter/ui-result-patch" notification into an ordered frame, or
 * undefined if it is some other notification or malformed. The App delivers these via
 * `fallbackNotificationHandler`.
 */
export function parseUiResultPatch(notification: unknown): PiStreamFrame | undefined {
  if (!isRecord(notification) || notification.method !== PI_UI_RESULT_PATCH_METHOD) return undefined;
  const params = notification.params;
  if (!isRecord(params)) return undefined;
  const structured = params.structuredContent;
  if (!isRecord(structured)) return undefined;
  const envelope = parseEnvelope(structured[PI_STREAM_STRUCTURED_CONTENT_KEY]);
  const window = parseWindow(structured);
  if (envelope === undefined || window === undefined) return undefined;
  return { envelope, window };
}

/** Fold one self-contained window into the model, skipping already-folded records and advancing the
 *  cursor. Returns true if it applied (records folded or run state advanced). */
function applyWindow(model: RunModel, window: PiStreamWindow, updateState: boolean): boolean {
  let folded = false;
  for (const record of window.events) {
    if (typeof record.seq === "number" && record.seq <= model.cursor) continue;
    foldRecord(model, record);
    folded = true;
  }
  if (window.cursor > model.cursor) model.cursor = window.cursor;
  if (model.streamId === undefined) model.streamId = window.streamId;
  if (model.name === undefined && window.workflowName) model.name = window.workflowName;
  let stateChanged = false;
  if (updateState) {
    if (model.status !== window.status) {
      model.status = window.status;
      stateChanged = true;
    }
    // finalized never regresses: a stale checkpoint sent before termination must not un-finalize.
    if (window.finalized && !model.finalized) {
      model.finalized = true;
      stateChanged = true;
    }
  }
  return folded || stateChanged;
}

/**
 * Cursor-driven folder for the pi push channel. Verifies each frame belongs to the expected pi UI
 * stream, buffers windows that are ahead of the model cursor (reorder / gap), and drains contiguous
 * windows in `after` order. Recency-guards run status by the window's endCursor so a late-arriving
 * stale checkpoint cannot roll status backwards.
 */
export class PiStreamFold {
  private readonly pending: PiStreamWindow[] = [];
  private maxEndCursor = -1;

  constructor(private readonly uiStreamId: string) {}

  /** Fold a frame; returns true if the model changed (caller re-renders). */
  fold(model: RunModel, frame: PiStreamFrame): boolean {
    // Wrong pi UI stream (a superseded panel session) — ignore.
    if (frame.envelope.streamId !== this.uiStreamId) return false;
    this.pending.push(frame.window);
    return this.drain(model);
  }

  private drain(model: RunModel): boolean {
    let changed = false;
    for (;;) {
      // Prune windows fully folded already (contiguous, no new records, not newer state).
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        const w = this.pending[i]!;
        if (w.after <= model.cursor && w.cursor <= model.cursor && w.endCursor <= this.maxEndCursor) {
          this.pending.splice(i, 1);
        }
      }
      // Pick the contiguous window with the smallest `after` so records fold in stream order.
      let pickIndex = -1;
      let pickAfter = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.pending.length; i += 1) {
        const w = this.pending[i]!;
        if (w.after <= model.cursor && w.after < pickAfter) {
          pickIndex = i;
          pickAfter = w.after;
        }
      }
      if (pickIndex === -1) break;
      const window = this.pending.splice(pickIndex, 1)[0]!;
      // Only the freshest-yet window (by endCursor) is allowed to set run status/finalized.
      const updateState = window.endCursor >= this.maxEndCursor;
      if (window.endCursor > this.maxEndCursor) this.maxEndCursor = window.endCursor;
      if (applyWindow(model, window, updateState)) changed = true;
    }
    return changed;
  }
}
