/**
 * Claude Code channel delivery of run notices — the run-monitor App's automatic messages, sent by
 * the server instead of an iframe. Every MCP client has its own server instance (one per legacy
 * session in the daemon, one per `--in-process` connection), so "which client" is answered by
 * where the tool call ran: a session watches exactly the runs its own `run`, `resume`, and
 * `status` calls named. A restarted host re-attaches the same way — the agent asks, calls
 * `status`, and delivery resumes from that point. Nothing is persisted and nothing is replayed:
 * the tail starts at the current end of the run's event log, and the status response already
 * carried whatever happened before.
 *
 * Contract (Claude Code channels reference): the server declares
 * `capabilities.experimental["claude/channel"]` and emits `notifications/claude/channel` with
 * `content` plus identifier-keyed `meta`. Hosts without a handler drop the notification. Claude
 * Code registers a channel only over the legacy handshake, so modern instances never construct
 * this class. Terminal and paused notices come from the durable event-log tail, which follows a
 * run across daemon supersession exactly as `resources/subscribe` does; permission and setup
 * notices come from the in-process broker and lifecycle hooks.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import type { RunEventStream } from "@automatalabs/workflows";
import type { RunStoreRouter } from "./project-registry.js";
import {
  pausedNotice,
  permissionNotice,
  setupNotice,
  terminalNotice,
  type RunNotice,
} from "./run-notices.js";
import { onSetupRequired } from "./workflow-lifecycle.js";
import type { WorkflowPermissionBroker } from "./workflow-permissions.js";

export const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
export const CLAUDE_CHANNEL_NOTIFICATION = "notifications/claude/channel";

/** Claude Code silently drops meta keys that are not identifiers; keep every key on this shape. */
export type ClaudeChannelNotificationParams = {
  content: string;
  meta: { run_id: string; kind: RunNotice["kind"]; status: RunNotice["status"]; event_id: string };
};

const TERMINAL = new Set(["completed", "failed", "aborted"]);

export function channelNotificationParams(runId: string, notice: RunNotice): ClaudeChannelNotificationParams {
  return {
    content: notice.text,
    meta: { run_id: runId, kind: notice.kind, status: notice.status, event_id: notice.id },
  };
}

function noticeForRecord(runId: string, record: RunEventLogRecord): RunNotice | undefined {
  const event = record.event;
  switch (event.type) {
    case "complete":
    case "error":
    case "stopped":
      return terminalNotice(runId, record);
    case "paused": {
      const checkpoint = event.reason === "checkpoint_required" ? event.checkpointContext : undefined;
      const backendId = event.reason === "auth_required" ? event.authContext?.backendId : undefined;
      return pausedNotice(runId, {
        // Rows written by the earlier interrupting pause carry no reason; show them as manual.
        reason: event.reason ?? "manual",
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(backendId === undefined ? {} : { backendId }),
      });
    }
    default:
      return undefined;
  }
}

export class ClaudeChannelNotifier {
  /** Runs this session named; permission and setup notices are filtered on it. */
  private readonly attached = new Set<string>();
  /** Open event-log tails, one per attached run that has a journal and is not yet terminal. */
  private readonly streams = new Map<string, RunEventStream>();
  private readonly detach: Array<() => void>;
  private closed = false;

  constructor(
    private readonly mcp: McpServer,
    private readonly router: RunStoreRouter,
    broker: WorkflowPermissionBroker,
  ) {
    this.detach = [
      broker.onPending((permission) => {
        if (this.attached.has(permission.runId)) this.send(permission.runId, permissionNotice(permission.runId, permission));
      }),
      onSetupRequired((event) => {
        if (this.attached.has(event.runId)) this.send(event.runId, setupNotice(event.runId, event.request));
      }),
      router.onRunDeleted(({ runId }) => this.forget(runId)),
    ];
  }

  /**
   * Attach a run this session just admitted, resumed, or inspected. Idempotent once the tail is
   * open; a later call re-arms a tail that could not open or broke. A run that is already
   * terminal is not watched: the response the caller is about to read says so.
   */
  watch(runId: string): void {
    if (this.closed || this.streams.has(runId)) return;
    const persistence = this.router.storeFor(runId)?.manager.getPersistence();
    const state = persistence?.load(runId);
    if (!persistence || !state || TERMINAL.has(state.status)) return;
    this.attached.add(runId);
    if (state.eventStreamId === undefined) return;
    let stream: RunEventStream;
    try {
      const page = persistence.readEvents(runId, { limit: 1, streamId: state.eventStreamId });
      stream = persistence.watchEvents(runId, { after: page.endCursor, streamId: page.streamId });
    } catch {
      // No readable journal yet: permission and setup notices still flow, and the next call retries.
      return;
    }
    this.streams.set(runId, stream);
    void this.drain(runId, stream);
  }

  close(): void {
    this.closed = true;
    for (const detach of this.detach) detach();
    for (const runId of [...this.attached]) this.forget(runId);
  }

  private async drain(runId: string, stream: RunEventStream): Promise<void> {
    try {
      for await (const record of stream) {
        if (this.streams.get(runId) !== stream) return;
        const notice = noticeForRecord(runId, record);
        if (!notice) continue;
        if (notice.kind === "terminal") {
          // The engine appends the terminal record before its snapshot save; let that stack unwind
          // so the result the notice announces is readable by the time Claude reads the notice.
          this.forget(runId);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (this.closed) return;
        }
        this.send(runId, notice);
      }
    } catch {
      // A broken tail ends watching; the next status call re-attaches.
    } finally {
      if (this.streams.get(runId) === stream) this.streams.delete(runId);
    }
  }

  private forget(runId: string): void {
    this.attached.delete(runId);
    const stream = this.streams.get(runId);
    if (!stream) return;
    this.streams.delete(runId);
    void stream.return().catch(() => undefined);
  }

  private send(runId: string, notice: RunNotice): void {
    void this.mcp.server
      .notification({ method: CLAUDE_CHANNEL_NOTIFICATION, params: channelNotificationParams(runId, notice) })
      .catch(() => undefined);
  }
}
