import type { TokenUsage } from "@automatalabs/shared-types";
import {
  RESUME_CALL_FAILED_REASONS,
  RESUME_CALL_LIVE_REASONS,
  RESUME_DISABLED_REASONS,
  RESUME_FALLBACK_REASONS,
} from "@automatalabs/workflows";
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

const tokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  total: z.number(),
  cost: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

const authContextSchema = z.object({
  backendId: z.string().optional(),
  methods: z.array(
    z.object({ id: z.string(), type: z.enum(["agent", "terminal", "env_var"]), name: z.string().optional() }),
  ),
});

const checkpointContextSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  hash: z.string(),
  prompt: z.string(),
  kind: z.enum(["confirm", "input", "select"]),
  choices: z.array(z.string()).optional(),
  default: z.unknown().optional(),
});

const fallbackSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  label: z.string(),
  phase: z.string().optional(),
  requestedSpec: z.string(),
  resolvedModel: z.string().optional(),
  backendId: z.string().optional(),
  kind: z.enum(["model", "modifier"]),
  message: z.string(),
});

const checkpointTakenSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  kind: z.enum(["confirm", "input", "select"]),
  decision: z.unknown(),
  source: z.enum(["live", "headless-default", "journal-replay", "injected"]),
});

const resumeCallDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["agent", "checkpoint"]),
    action: z.literal("replayed"),
    sourceRunId: z.string(),
    recordedIndex: z.number().int().nonnegative(),
    match: z.enum(["path-hash", "unique-hash", "index-hash"]),
    logicalBudgetDebit: z.number().optional(),
    checkpointInjected: z.literal(true).optional(),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["agent", "checkpoint"]),
    action: z.literal("live"),
    reason: z.enum(RESUME_CALL_LIVE_REASONS),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["agent", "checkpoint"]),
    action: z.literal("failed"),
    reason: z.enum(RESUME_CALL_FAILED_REASONS),
  }),
]);

const resumeReportBaseShape = {
  sourceRunId: z.string(),
  requestedPolicy: z.enum(["auto", "positional"]),
  replayed: z.number().int().nonnegative(),
  live: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  calls: z.array(resumeCallDecisionSchema),
} as const;

const resumeReportSchema = z.discriminatedUnion("strategy", [
  z.object({
    ...resumeReportBaseShape,
    strategy: z.literal("identity-v1"),
  }),
  z.object({
    ...resumeReportBaseShape,
    strategy: z.literal("positional-v1"),
    fallbackReason: z.enum(RESUME_FALLBACK_REASONS),
    eligibility: z.enum(["legacy", "safe-prefix", "all-live"]),
  }),
  z.object({
    ...resumeReportBaseShape,
    strategy: z.literal("live"),
    disabledReason: z.enum(RESUME_DISABLED_REASONS),
  }),
]);

const executionResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  result: z.unknown().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  logs: z.array(z.string()).optional(),
  logTail: logTailSchema.optional(),
  authContext: authContextSchema.optional(),
  checkpointContext: checkpointContextSchema.optional(),
  fallbacks: z.array(fallbackSchema).optional(),
  checkpointsTaken: z.array(checkpointTakenSchema).optional(),
  resumeReport: resumeReportSchema.optional(),
});

/** Common MCP output schema for legacy execution results and exact inspection statuses. */
export const workflowToolOutputShape = {
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  result: z.unknown().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  logs: z.array(z.string()).optional(),
  authContext: authContextSchema.optional(),
  checkpointContext: checkpointContextSchema.optional(),
  fallbacks: z.array(fallbackSchema).optional(),
  checkpointsTaken: z.array(checkpointTakenSchema).optional(),
  resumeReport: resumeReportSchema.optional(),
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
  wait: z
    .object({
      requestedMs: z.number().int().nonnegative(),
      elapsedMs: z.number().int().nonnegative(),
      returnedBecause: z.enum(["terminal", "timeout", "immediate"]),
    })
    .optional(),
  outcome: executionResultSchema.optional(),
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
  fallbacks?: WorkflowRunResult["fallbacks"];
  checkpointsTaken?: WorkflowRunResult["checkpointsTaken"];
  resumeReport?: WorkflowRunResult["resumeReport"];
}

export interface WorkflowBackgroundAccepted {
  runId: string;
  status: "running";
}

export interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

export interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus {
  wait: WorkflowAwaitMetadata;
  /** Cumulative usage observed for live calls in this execution; absent before any is known. */
  tokenUsage?: TokenUsage;
  /** Present exactly when status is paused/completed/failed/aborted. */
  outcome?: WorkflowExecutionToolResult<T>;
}

export type WorkflowToolResult<T = unknown> =
  | WorkflowExecutionToolResult<T>
  | WorkflowBackgroundAccepted
  | WorkflowRunStatus
  | WorkflowRunAwaitResult<T>;

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
    ...(run.fallbacks === undefined ? {} : { fallbacks: run.fallbacks }),
    ...(run.checkpointsTaken === undefined ? {} : { checkpointsTaken: run.checkpointsTaken }),
    ...(run.resumeReport === undefined ? {} : { resumeReport: run.resumeReport }),
  };
}
