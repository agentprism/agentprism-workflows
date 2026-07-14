import type { WorkflowRunResult, WorkflowRunStatus } from "@automatalabs/workflows";
import { z } from "zod";

const logTailSchema = z.object({
  lines: z.array(z.string()),
  totalLines: z.number().int().nonnegative(),
  omittedLines: z.number().int().nonnegative(),
  truncatedLines: z.number().int().nonnegative(),
  redactedLines: z.number().int().nonnegative(),
});

const countSchema = z.object({ total: z.number().int().nonnegative(), returned: z.number().int().nonnegative() });

/** Common MCP output schema for legacy execution results and exact inspection statuses. */
export const workflowToolOutputShape = {
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
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
        z.object({ id: z.string(), type: z.enum(["agent", "terminal", "env_var"]), name: z.string().optional() }),
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
  workflowName: z.string().optional(),
  phases: z.array(z.string()).optional(),
  currentPhase: z.string().optional(),
  reason: z.string().optional(),
  errorCode: z.string().optional(),
  logTail: logTailSchema.optional(),
  calls: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        kind: z.enum(["agent", "checkpoint", "unknown"]),
        label: z.string().optional(),
        phase: z.string().optional(),
        model: z.string().optional(),
        backendId: z.string().optional(),
        resultPreview: z.string(),
        resultRedacted: z.boolean(),
        resultTruncated: z.boolean(),
      }),
    )
    .optional(),
  filter: z
    .object({
      lastN: z.number().int().min(1).max(50),
      logLines: z.number().int().min(0).max(50),
      labelGlob: z.string().optional(),
    })
    .optional(),
  truncation: z
    .object({
      maxStructuredBytes: z.number().int().positive(),
      byteCapApplied: z.boolean(),
      phases: countSchema.extend({ shortened: z.number().int().nonnegative() }),
      logs: countSchema.extend({ shortened: z.number().int().nonnegative(), redacted: z.number().int().nonnegative() }),
      calls: countSchema.extend({
        matched: z.number().int().nonnegative(),
        shortenedResults: z.number().int().nonnegative(),
        redactedResults: z.number().int().nonnegative(),
      }),
    })
    .optional(),
} as const;

export interface WorkflowExecutionToolResult<T = unknown> {
  runId: string;
  status: WorkflowRunResult["status"];
  result?: T;
  tokenUsage?: WorkflowRunResult["tokenUsage"];
  logs?: string[];
  logTail?: WorkflowRunResult["logTail"];
  authContext?: WorkflowRunResult["authContext"];
  checkpointContext?: WorkflowRunResult["checkpointContext"];
}

export type WorkflowToolResult<T = unknown> = WorkflowExecutionToolResult<T> | WorkflowRunStatus;

export function toWorkflowToolResult<T>(run: WorkflowRunResult<T>): WorkflowExecutionToolResult<T> {
  return {
    runId: run.runId,
    status: run.status,
    result: run.result,
    tokenUsage: run.tokenUsage,
    logs: run.logs,
    ...(run.logTail === undefined ? {} : { logTail: run.logTail }),
    authContext: run.authContext,
    checkpointContext: run.checkpointContext,
  };
}
