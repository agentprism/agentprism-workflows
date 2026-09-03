import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";

import type { RunStatus } from "./state.js";

export const WORKFLOW_RUNS_TOOL_NAME = "workflow-runs";

export interface RunListItem {
  runId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  currentPhase?: string;
}

function errorText(result: CallToolResult): string {
  const block = result.content?.find((content) => content.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  return block?.text ?? "workflow-runs query failed.";
}

export async function readRecentRuns(
  app: Pick<App, "callServerTool">,
  anchorRunId: string,
): Promise<RunListItem[]> {
  const result = await app.callServerTool({
    name: WORKFLOW_RUNS_TOOL_NAME,
    arguments: { anchorRunId, limit: 12 },
  });
  if (result.isError === true) throw new Error(errorText(result));
  const structured = result.structuredContent as { runs?: unknown } | undefined;
  return Array.isArray(structured?.runs) ? structured.runs as RunListItem[] : [];
}
