import type { ServerContext } from "@modelcontextprotocol/server";

// packages/mcp-server/src/progress.ts
//
// Bridges live foreground snapshots onto the MCP progress notification. MCP correlates each
// notification to the tools/call request via
// the client's progressToken; without one there is no addressable progress channel.
import type { RunAgentProgressPayload } from "@automatalabs/shared-types";

/**
 * The progress sink the shell hands to the engine. The engine calls it as it advances
 * through the run; `total` (planned units) and `message` are optional. Mirrors the engine
 * `onProgress(progress, total?, message?)` shape.
 */
export type WorkflowProgressCallback = (progress: number, total?: number, message?: string) => void;

/** The v2 context the SDK passes to a tool handler: request metadata, notifications, and cancellation. */
export type WorkflowToolExtra = ServerContext;

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
  const progressToken = extra.mcpReq._meta?.progressToken;
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
    void extra.mcpReq.notify({
        method: "notifications/progress",
        params,
      })
      .catch(() => {
        /* advisory channel: swallow notification/transport errors so the run is unaffected. */
      });
  };
}
