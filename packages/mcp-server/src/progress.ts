// packages/mcp-server/src/progress.ts
//
// Bridges live foreground snapshots and persisted background event tails onto the MCP
// progress notification. MCP correlates each notification to the tools/call request via
// the client's progressToken; without one there is no addressable progress channel.
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { redactText, truncateUtf8 } from "@automatalabs/workflows";
import type { PersistedRunState } from "@automatalabs/workflows";
import type { RunEventLogRecord } from "@automatalabs/shared-types";
import type { RunAgentProgressPayload } from "@automatalabs/shared-types";

const EVENT_TEXT_LIMIT_BYTES = 512;

/**
 * The progress sink the shell hands to the engine. The engine calls it as it advances
 * through the run; `total` (planned units) and `message` are optional. Mirrors the engine
 * `onProgress(progress, total?, message?)` shape.
 */
export type WorkflowProgressCallback = (progress: number, total?: number, message?: string) => void;

/** The `extra` bag the SDK passes to a tool handler: progress sink + AbortSignal + request `_meta`. */
export type WorkflowToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface AwaitProgressReporter {
  seed(snapshot: PersistedRunState): void;
  record(record: RunEventLogRecord): void;
}

export function formatAgentProgressMessage(progress: RunAgentProgressPayload): string {
  return progress.lastToolName !== undefined
    ? `${progress.label}: tool ${progress.lastToolName}`
    : `${progress.label}: ${progress.latestText ?? ""}`;
}

/**
 * Build the engine `onProgress` sink for ONE tool call. Progress flows only when the client
 * attached `_meta.progressToken` to its `tools/call`; otherwise we return a no-op so the run
 * still proceeds but emits nothing. Notifications are advisory and fire-and-forget — a closed
 * or failing transport must never abort the workflow.
 */
export function createProgressReporter(extra: WorkflowToolExtra): WorkflowProgressCallback {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return () => {
      /* no progressToken on this call -> progress is not addressable; intentionally skip. */
    };
  }
  return (progress, total, message) => {
    const params = {
      progressToken,
      progress,
      ...(total === undefined ? {} : { total }),
      ...(message === undefined ? {} : { message }),
    };
    void extra
      .sendNotification({
        method: "notifications/progress",
        params,
      })
      .catch(() => {
        /* advisory channel: swallow notification/transport errors so the run is unaffected. */
      });
  };
}

/** Build the distinct-call projection used only while one background await is pending. */
export function createAwaitProgressReporter(extra: WorkflowToolExtra): AwaitProgressReporter {
  if (extra._meta?.progressToken === undefined) {
    return { seed() {}, record() {} };
  }

  const report = createProgressReporter(extra);
  const started = new Set<string>();
  const ended = new Set<string>();
  let latestTitle: string | undefined;

  const emit = () => report(ended.size, started.size || undefined, latestTitle);

  return {
    seed(snapshot) {
      latestTitle = snapshot.currentPhase === undefined ? undefined : projectSnapshotText(snapshot.currentPhase);
      for (const agent of snapshot.agents) {
        const key = callKey(projectSnapshotText(agent.scope ?? snapshot.runId), agent.callIndex);
        if (key === undefined) continue;
        started.add(key);
        if (agent.status === "done" || agent.status === "error" || agent.status === "skipped") ended.add(key);
      }
    },
    record(record) {
      const event = record.event;
      if (event.type === "agentTranscript") return;
      if (event.type === "agentProgress") {
        report(ended.size, started.size || undefined, formatAgentProgressMessage(event));
        return;
      }
      if (event.type === "phase") {
        latestTitle = event.title;
        emit();
        return;
      }
      if (event.type === "agentStart") {
        const key = callKey(event.scope, event.callIndex);
        if (key !== undefined && !started.has(key)) {
          started.add(key);
          emit();
        }
        return;
      }
      if (event.type === "agentEnd") {
        const key = callKey(event.scope, event.callIndex);
        if (key === undefined) return;
        started.add(key);
        if (!ended.has(key)) {
          ended.add(key);
          emit();
        }
      }
    },
  };
}

function projectSnapshotText(value: string): string {
  return truncateUtf8(redactText(value).value, EVENT_TEXT_LIMIT_BYTES);
}

function callKey(scope: string, callIndex: number | undefined): string | undefined {
  if (!Number.isSafeInteger(callIndex) || (callIndex ?? -1) < 0) return undefined;
  return JSON.stringify([scope, callIndex]);
}
