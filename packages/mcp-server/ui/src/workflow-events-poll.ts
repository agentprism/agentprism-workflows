import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import type { RunStatus } from "./state.js";

// Source of truth: packages/mcp-server/src/app-ui.ts (kept local so the browser bundle does not
// import the server registration module and its Node-only dependency graph).
export const WORKFLOW_EVENTS_TOOL_NAME = "workflow-events";

// Per-page cursor read size (server caps limit at 1000). Catch-up paging chains reads via hasMore.
export const PAGE_LIMIT = 500;

export interface EventsDoc {
  schemaVersion: number;
  runId: string;
  streamId: string;
  workflowName: string;
  status: RunStatus;
  finalized: boolean;
  after: number;
  cursor: number;
  endCursor: number;
  hasMore: boolean;
  events: RunEventLogRecord[];
}

export interface WorkflowEventsRequest {
  runId: string;
  after: number;
  streamId: string | undefined;
}

function errorText(result: CallToolResult): string {
  const block = result.content?.find((content) => content.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  return block?.text ?? "workflow-events poll failed.";
}

/** Call the app-only cursor tool and expose its structured events document to the fold loop. */
export async function readWorkflowEventsPage(
  app: Pick<App, "callServerTool">,
  request: WorkflowEventsRequest,
): Promise<EventsDoc | undefined> {
  const result = await app.callServerTool({
    name: WORKFLOW_EVENTS_TOOL_NAME,
    arguments: {
      runId: request.runId,
      after: request.after,
      limit: PAGE_LIMIT,
      streamId: request.streamId,
    },
  });
  if (result.isError === true) throw new Error(errorText(result));
  if (typeof result.structuredContent !== "object" || result.structuredContent === null) {
    return undefined;
  }
  return result.structuredContent as unknown as EventsDoc;
}
