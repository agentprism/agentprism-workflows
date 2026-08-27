// packages/mcp-server/src/app-ui.ts
//
// MCP Apps (io.modelcontextprotocol/ui) surface for the workflow server, per the extension
// spec's legacy-era capability-negotiation model: the server advertises Apps support and registers
// this surface only after a client advertises the extension with the MCP Apps HTML MIME type. The
// UI-enabled `workflow` tool carries `_meta.ui.resourceUri`; every other client receives the same
// tool config without UI metadata. Modern advertisement through server/discover remains gated.
//
// This module registers the two panel-support pieces:
//   - the ui:// panel resource (the Vite single-file React app, embedded at build time), and
//   - the app-only `workflow-events` cursor tool (visibility: ["app"]) the panel polls to
//     stay live without any model involvement.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { RunEventLogError } from "@automatalabs/workflows";
import { z } from "zod";

import { RUN_MONITOR_HTML } from "./generated/run-monitor-html.js";
import type { WorkflowRunEventsResourceDocument } from "./workflow-resources.js";
import { workflowEventsOutputShape } from "./workflow-tool-output.js";

export const RUN_MONITOR_RESOURCE_URI = "ui://agentprism-workflow/run-monitor.html";
export const WORKFLOW_EVENTS_TOOL_NAME = "workflow-events";

/** The dependencies the server shell binds when registering the panel surface. */
export interface WorkflowAppUiDeps {
  /** Cursor-paged, redacted run events (shared with the events resource). */
  readEventsPage(request: {
    runId: string;
    after?: number;
    limit?: number;
    streamId?: string;
  }): WorkflowRunEventsResourceDocument;
  /**
   * Route reads of a fixed URI through the server's custom resources/read dispatch
   * (WorkflowScriptResources replaces the SDK default, so ui:// must be registered there too).
   */
  registerResourceReader(
    uri: string,
    read: () => { contents: Array<{ uri: string; mimeType: string; text: string }> },
  ): void;
}

/** Stable machine-readable prefix so the app can react to specific event-log faults. */
function eventsErrorText(error: unknown): string {
  if (error instanceof RunEventLogError) return `[${error.code}] ${error.message}`;
  if (error instanceof McpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Register the run-monitor panel resource and its app-only events tool. */
export function registerWorkflowAppUi(mcp: McpServer, deps: WorkflowAppUiDeps): void {
  const readRunMonitorHtml = () => ({
    contents: [
      {
        uri: RUN_MONITOR_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: RUN_MONITOR_HTML,
      },
    ],
  });
  registerAppResource(
    mcp,
    "Workflow run monitor",
    RUN_MONITOR_RESOURCE_URI,
    {
      description:
        "Live monitor panel for a workflow run: phase/agent graph, per-node logs, token usage, and stop control.",
    },
    readRunMonitorHtml,
  );
  deps.registerResourceReader(RUN_MONITOR_RESOURCE_URI, readRunMonitorHtml);

  registerAppTool(
    mcp,
    WORKFLOW_EVENTS_TOOL_NAME,
    {
      title: "Read a page of workflow run events (app-only)",
      description:
        "Cursor-paged, redacted, append-only run events for the run-monitor panel. after/streamId " +
        "default to 0 and the run's current stream, so the first call bootstraps the full log.",
      // Paging the event log never mutates run state. The hint is metadata for hosts that gate on
      // it (e.g. VS Code skips the pre-run confirmation, ChatGPT dev mode classifies un-hinted
      // tools as write actions); it does not change how any host narrates app-originated calls.
      annotations: { readOnlyHint: true },
      inputSchema: {
        runId: z.string().describe("Workflow runId whose event log to read."),
        after: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Return events with seq greater than this cursor. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Maximum records to return. Default 100; range 1..1000."),
        streamId: z
          .string()
          .optional()
          .describe("Expected event stream generation; mismatch fails so the reader can restart."),
      },
      outputSchema: workflowEventsOutputShape,
      _meta: { ui: { resourceUri: RUN_MONITOR_RESOURCE_URI, visibility: ["app"] } },
    },
    ({ runId, after, limit, streamId }) => {
      try {
        const document = deps.readEventsPage({ runId, after, limit, streamId });
        return {
          structuredContent: { ...document },
          content: [
            {
              type: "text",
              text: `${document.events.length} events after ${document.after} for ${runId} (cursor ${document.cursor}/${document.endCursor}).`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: eventsErrorText(error) }],
          isError: true,
        };
      }
    },
  );
}
