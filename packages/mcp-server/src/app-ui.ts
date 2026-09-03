import { ProtocolError } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

// packages/mcp-server/src/app-ui.ts
//
// MCP Apps (io.modelcontextprotocol/ui) surface for the workflow server. The v2-native server
// registers the union once; CapabilityAwareToolCatalog and the resource router project it only
// when the current legacy initialize snapshot or modern per-request envelope contains the exact
// Apps HTML MIME declaration. Incapable clients receive the unchanged text workflow surface.
//
// This module registers the two panel-support pieces:
//   - the ui:// panel resource (the Vite single-file React app, embedded at build time), and
//   - the app-only `workflow-events` cursor tool (visibility: ["app"]) the panel polls to
//     stay live without any model involvement, and
//   - the app-only bounded `workflow-runs` query used for multi-run navigation.
import { RunEventLogError } from "@automatalabs/workflows";
import { z } from "zod";

import { RUN_MONITOR_HTML } from "./generated/run-monitor-html.js";
import { RESOURCE_MIME_TYPE, appResourceToolMeta } from "./mcp-apps.js";
import type { WorkflowRunEventsResourceDocument } from "./workflow-resources.js";
import { workflowEventsOutputShape } from "./workflow-tool-output.js";

export const RUN_MONITOR_RESOURCE_URI = "ui://agentprism-workflow/run-monitor.html";
export const WORKFLOW_EVENTS_TOOL_NAME = "workflow-events";
export const WORKFLOW_RUNS_TOOL_NAME = "workflow-runs";

export interface WorkflowRunListItem {
  runId: string;
  workflowName: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
  startedAt: string;
  updatedAt: string;
  currentPhase?: string;
}

/** The dependencies the server shell binds when registering the panel surface. */
export interface WorkflowAppUiDeps {
  /** Cursor-paged, redacted run events (shared with the events resource). */
  readEventsPage(request: {
    runId: string;
    after?: number;
    limit?: number;
    streamId?: string;
  }): WorkflowRunEventsResourceDocument;
  /** One bounded active/recent query in the anchor run's authoritative project store. */
  listRecentRuns(request: { anchorRunId: string; limit: number }): WorkflowRunListItem[];
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
  if (error instanceof ProtocolError) return error.message;
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
  // UI resources may be omitted from resources/list. The custom resource router serves this
  // fixed URI only to Apps-capable requests, avoiding a static registration that would leak
  // the panel to an incapable modern request on a long-lived stdio connection.
  deps.registerResourceReader(RUN_MONITOR_RESOURCE_URI, readRunMonitorHtml);

  mcp.registerTool(
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
      inputSchema: z.object({
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
      }),
      outputSchema: z.object(workflowEventsOutputShape),
      _meta: appResourceToolMeta(RUN_MONITOR_RESOURCE_URI, ["app"]),
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

  mcp.registerTool(
    WORKFLOW_RUNS_TOOL_NAME,
    {
      title: "List active and recent workflow runs (app-only)",
      description: "Bounded project-local run navigation for the multi-run monitor panel.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        anchorRunId: z.string().describe("Run whose authoritative project store supplies the listing."),
        limit: z.number().int().min(1).max(24).optional().describe("Maximum rows; default 12."),
      }),
      outputSchema: z.object({
        anchorRunId: z.string(),
        runs: z.array(z.object({
          runId: z.string(),
          workflowName: z.string(),
          status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
          startedAt: z.string(),
          updatedAt: z.string(),
          currentPhase: z.string().optional(),
        })),
      }),
      _meta: appResourceToolMeta(RUN_MONITOR_RESOURCE_URI, ["app"]),
    },
    ({ anchorRunId, limit }) => {
      try {
        const runs = deps.listRecentRuns({ anchorRunId, limit: limit ?? 12 });
        return {
          structuredContent: { anchorRunId, runs },
          content: [{ type: "text", text: `${runs.length} active/recent workflow runs.` }],
          isError: false,
        };
      } catch (error) {
        return { content: [{ type: "text", text: eventsErrorText(error) }], isError: true };
      }
    },
  );
}
