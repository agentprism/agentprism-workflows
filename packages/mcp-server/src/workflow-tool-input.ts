// Input schema and cross-field discriminator for the single MCP `workflow` tool.
// Numeric execution knobs retain their existing clamp-at-runtime behavior. Inspection
// bounds are rejected at the Zod boundary because they are wire-contract limits.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { WorkflowRunInspectionOptions } from "@automatalabs/workflows";
import { z } from "zod";

const checkpointRepliesSchema = z
  .record(
    z.string().regex(/^(0|[1-9]\d*)$/, "checkpoint reply keys must be non-negative integer call indexes"),
    z.unknown(),
  )
  .transform(
    (replies) =>
      Object.fromEntries(Object.entries(replies).map(([callIndex, reply]) => [Number(callIndex), reply])) as Record<
        number,
        unknown
      >,
  );

export const workflowToolInputShape = {
  action: z
    .enum(["run", "inspect", "await"])
    .optional()
    .describe("Operation. Omit or use run to execute; inspect reads immediately; await waits for terminal status."),
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Raw JavaScript workflow script (no Markdown fences). Required for run; forbidden for inspect. First statement MUST be `export const meta = { name, description, phases? }`.",
    ),
  args: z.unknown().optional().describe("Optional JSON value exposed to the script as the global `args`."),
  maxAgents: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max agents allowed in this run. Default 1000 (engine cap MAX_AGENTS_PER_RUN)."),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max concurrent agents. CLAMPED to the runtime max (16) by the engine — not rejected."),
  agentRetries: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Retry attempts for recoverable agent failures. CLAMPED to the runtime max (3) by the engine."),
  agentTimeoutMs: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Per-agent timeout in ms. Omit/null for no hard timeout (the engine owns the timeout)."),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Hard total-token budget for the whole run. Omit/null for no limit."),
  resumeFromRunId: z
    .string()
    .optional()
    .describe("Execute a new run by replaying the unchanged prefix of a prior run's persisted journal."),
  checkpointReplies: checkpointRepliesSchema
    .optional()
    .describe("With resumeFromRunId, durable-checkpoint decisions keyed by checkpointContext.callIndex."),
  background: z
    .boolean()
    .optional()
    .describe("Default false. True acknowledges after admission and executes in this server process."),
  runId: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+-[a-z0-9]+$/, "runId must be an engine-generated run ID")
    .optional()
    .describe("Project-scoped workflow run ID. Required for inspect; forbidden for run."),
  lastN: z.number().int().min(1).max(50).optional().describe("Latest matching calls. Default 20; range 1..50."),
  labelGlob: z
    .string()
    .refine((value) => [...value].length >= 1 && [...value].length <= 128, {
      message: "labelGlob must contain from 1 through 128 Unicode code points",
    })
    .optional()
    .describe("Case-sensitive whole-label glob using *, ?, and backslash escaping."),
  logLines: z.number().int().min(0).max(50).optional().describe("Latest run-log lines. Default 20; range 0..50."),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(25_000)
    .optional()
    .describe("Await duration in milliseconds. Default 20000; range 0..25000. Zero reads without blocking."),
} as const;

export interface WorkflowExecuteToolInput {
  action?: "run";
  script: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  resumeFromRunId?: string;
  checkpointReplies?: Record<number, unknown>;
  /** Default false. True acknowledges after admission and executes in this server process. */
  background?: boolean;
  runId?: never;
  waitMs?: never;
  lastN?: never;
  labelGlob?: never;
  logLines?: never;
}

export interface WorkflowInspectToolInput extends WorkflowRunInspectionOptions {
  action: "inspect";
  runId: string;
  script?: never;
  background?: never;
  waitMs?: never;
}

export interface WorkflowAwaitToolInput extends WorkflowRunInspectionOptions {
  action: "await";
  runId: string;
  /** Default 20_000; integer range 0..25_000. Zero is a non-blocking status read. */
  waitMs?: number;
  script?: never;
  background?: never;
  resumeFromRunId?: never;
  checkpointReplies?: never;
}

export type WorkflowToolInput = WorkflowExecuteToolInput | WorkflowInspectToolInput | WorkflowAwaitToolInput;

interface RawWorkflowToolInput {
  action?: "run" | "inspect" | "await";
  script?: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  tokenBudget?: number | null;
  resumeFromRunId?: string;
  checkpointReplies?: Record<number, unknown>;
  background?: boolean;
  runId?: string;
  lastN?: number;
  labelGlob?: string;
  logLines?: number;
  waitMs?: number;
}

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Invalid workflow tool input: ${message}`);
}

/** Apply the action discriminator after the MCP SDK has validated primitive fields. */
export function parseWorkflowToolInput(raw: RawWorkflowToolInput): WorkflowToolInput {
  if (raw.action === "inspect") {
    if (!raw.runId) invalid('action="inspect" requires runId');
    if (
      raw.script !== undefined ||
      raw.args !== undefined ||
      raw.maxAgents !== undefined ||
      raw.concurrency !== undefined ||
      raw.agentRetries !== undefined ||
      raw.agentTimeoutMs !== undefined ||
      raw.tokenBudget !== undefined ||
      raw.resumeFromRunId !== undefined ||
      raw.checkpointReplies !== undefined ||
      raw.background !== undefined ||
      raw.waitMs !== undefined
    ) {
      invalid('action="inspect" cannot include execution fields');
    }
    return {
      action: "inspect",
      runId: raw.runId,
      lastN: raw.lastN,
      labelGlob: raw.labelGlob,
      logLines: raw.logLines,
    };
  }

  if (raw.action === "await") {
    if (!raw.runId) invalid('action="await" requires runId');
    if (
      raw.script !== undefined ||
      raw.args !== undefined ||
      raw.maxAgents !== undefined ||
      raw.concurrency !== undefined ||
      raw.agentRetries !== undefined ||
      raw.agentTimeoutMs !== undefined ||
      raw.tokenBudget !== undefined ||
      raw.resumeFromRunId !== undefined ||
      raw.checkpointReplies !== undefined ||
      raw.background !== undefined
    ) {
      invalid('action="await" cannot include execution fields');
    }
    return {
      action: "await",
      runId: raw.runId,
      waitMs: raw.waitMs ?? 20_000,
      lastN: raw.lastN,
      labelGlob: raw.labelGlob,
      logLines: raw.logLines,
    };
  }

  if (
    raw.runId !== undefined ||
    raw.waitMs !== undefined ||
    raw.lastN !== undefined ||
    raw.labelGlob !== undefined ||
    raw.logLines !== undefined
  ) {
    invalid("run inputs cannot include inspection fields");
  }
  if (!raw.script) invalid(raw.action === "run" ? 'action="run" requires script' : "script or an explicit action is required");
  return {
    action: raw.action,
    script: raw.script,
    args: raw.args,
    maxAgents: raw.maxAgents,
    concurrency: raw.concurrency,
    agentRetries: raw.agentRetries,
    agentTimeoutMs: raw.agentTimeoutMs,
    tokenBudget: raw.tokenBudget,
    resumeFromRunId: raw.resumeFromRunId,
    checkpointReplies: raw.checkpointReplies,
    background: raw.background ?? false,
  };
}

/** Clamp only execution resource knobs; inspection values are rejected rather than clamped. */
export function clampWorkflowInput(input: WorkflowExecuteToolInput): WorkflowExecuteToolInput {
  const clampInt = (value: number | undefined, minimum: number, maximum: number) =>
    value === undefined || !Number.isFinite(value)
      ? undefined
      : Math.min(maximum, Math.max(minimum, Math.floor(value)));
  return {
    ...input,
    concurrency: clampInt(input.concurrency, 1, 16),
    agentRetries: clampInt(input.agentRetries, 0, 3),
    maxAgents:
      input.maxAgents === undefined || !Number.isFinite(input.maxAgents)
        ? undefined
        : Math.max(1, Math.floor(input.maxAgents)),
  };
}
