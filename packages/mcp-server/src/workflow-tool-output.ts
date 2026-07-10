// packages/mcp-server/src/workflow-tool-output.ts
//
// The MCP `workflow` tool OUTPUT. The host-facing WorkflowRunResult<T> (runId, status,
// result, meta, phases, agentCount, durationMs, tokenUsage?, logs, reason?, resetHint?,
// authContext?, checkpointContext?)
// lives in @automatalabs/shared-types — it is the engine's runWorkflow return PLUS the
// run-manager's terminal status trio (the engine seam at :465 stays unchanged; the
// manager composes status). THIS file declares the MINIMAL outputSchema the MCP SDK
// validates structuredContent against, and projects the full result onto it.
//
// When an outputSchema is declared, CallToolResult.structuredContent is MANDATORY and
// SDK-validated (verified mcp.d.ts:150-154 + types.js:1289). We pin only the durable,
// machine-readable core — including structured pause contexts — and ALSO emit a
// human-readable text content block alongside it.
import { z } from "zod";
import type { WorkflowRunResult } from "@automatalabs/workflows";

/** MINIMAL MCP outputSchema (registerTool `outputSchema`). Pins WorkflowRunResult's
 *  machine-readable core. status lets a host tell completed from paused (provider
 *  usage-limit, auth_required, or checkpoint_required via headless:"pause") / failed /
 *  aborted WITHOUT parsing logs. */
export const workflowToolOutputShape = {
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  // Optional: present only on a completed run (the script's resolved value). Paused/failed/
  // aborted runs have NO result, so it must not be required — a strict MCP client that caches
  // this output schema via listTools would otherwise reject EVERY non-completed run with -32602.
  result: z.unknown().optional(),
  tokenUsage: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
      cost: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  logs: z.array(z.string()).optional(),
  authContext: z
    .object({
      backendId: z.string().optional(),
      methods: z.array(
        z.object({
          id: z.string(),
          type: z.enum(["agent", "terminal", "env_var"]),
          name: z.string().optional(),
        }),
      ),
    })
    .optional(),
  checkpointContext: z
    .object({
      callIndex: z.number().int().nonnegative(),
      hash: z.string(),
      prompt: z.string(),
      kind: z.enum(["confirm", "input", "select"]),
      choices: z.array(z.string()).optional(),
      default: z.unknown().optional(),
    })
    .optional(),
} as const;

/** The validated structuredContent shape (z.infer of the object built from the shape). */
export interface WorkflowToolResult<T = unknown> {
  runId: string;
  status: WorkflowRunResult["status"];
  result?: T;
  tokenUsage?: WorkflowRunResult["tokenUsage"];
  logs?: string[];
  authContext?: WorkflowRunResult["authContext"];
  checkpointContext?: WorkflowRunResult["checkpointContext"];
}

/**
 * Project the host-facing WorkflowRunResult<T> onto the minimal MCP structuredContent.
 * The manager already settled `status` (normal return -> "completed"; a thrown
 * PROVIDER_USAGE_LIMIT / AUTH_REQUIRED / CHECKPOINT_REQUIRED WorkflowError -> "paused"
 * with its structured pause metadata, persisted and resumable via resumeFromRunId; abort ->
 * "aborted"; any other non-recoverable throw -> "failed"), so this is a pure narrowing.
 */
export function toWorkflowToolResult<T>(run: WorkflowRunResult<T>): WorkflowToolResult<T> {
  return {
    runId: run.runId,
    status: run.status,
    result: run.result,
    tokenUsage: run.tokenUsage,
    logs: run.logs,
    authContext: run.authContext,
    checkpointContext: run.checkpointContext,
  };
}
