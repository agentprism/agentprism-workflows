import type { TokenUsage, WorkflowReplayEligibility, WorkflowRunLimits } from "@automatalabs/shared-types";
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

const workflowRunLimitsSchema = z.object({
  maxAgents: z.number().int().positive(),
  tokenBudget: z.number().nonnegative().nullable(),
  concurrency: z.number().int().positive(),
  agentRetries: z.number().int().nonnegative(),
  agentTimeoutMs: z.number().nonnegative().nullable(),
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
  kind: z.enum(["model", "modifier", "continuation"]),
  message: z.string(),
  continuation: z
    .discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("reattached"),
        method: z.enum(["resume", "load"]),
      }),
      z.object({
        outcome: z.literal("skipped"),
        reason: z.enum([
          "hash-mismatch",
          "inputs-mismatch",
          "worktree-isolated",
          "cwd-mismatch",
          "cwd-missing",
          "backend-mismatch",
          "capability-missing",
          "reattach-failed",
          "runner-declined",
        ]),
      }),
    ])
    .optional(),
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

const replayOperationalChangeSchema = z.object({
  option: z.enum(["agentTimeoutMs", "agentRetries", "concurrency"]),
  source: z.number().nullable(),
  current: z.number().nullable(),
  detail: z.string(),
});

const replayFirstNonReplaySchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.enum(["live", "failed"]),
  reason: z.enum([
    ...RESUME_CALL_LIVE_REASONS,
    ...RESUME_CALL_FAILED_REASONS,
    ...RESUME_DISABLED_REASONS,
    ...RESUME_FALLBACK_REASONS,
  ]),
  detail: z.string().optional(),
});

const replayEligibilityBaseShape = {
  sourceRunId: z.string(),
  predictedReplayablePrefix: z.number().int().nonnegative(),
  replayedPrefix: z.number().int().nonnegative(),
  replayed: z.number().int().nonnegative(),
  live: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  firstNonReplay: replayFirstNonReplaySchema.optional(),
  sourceEngineVersion: z.string().optional(),
  currentEngineVersion: z.string(),
  engineVersionComparison: z.enum(["same", "different", "source-unknown"]),
  sourceInputsFormat: z.number().int().nonnegative().optional(),
  currentInputsFormat: z.number().int().nonnegative(),
  operationalChanges: z.array(replayOperationalChangeSchema),
} as const;

const replayEligibilitySchema = z.discriminatedUnion("strategy", [
  z.object({
    ...replayEligibilityBaseShape,
    strategy: z.literal("identity-v1"),
  }),
  z.object({
    ...replayEligibilityBaseShape,
    strategy: z.literal("positional-v1"),
    fallbackReason: z.enum(RESUME_FALLBACK_REASONS),
    eligibility: z.enum(["legacy", "safe-prefix", "all-live"]),
  }),
  z.object({
    ...replayEligibilityBaseShape,
    strategy: z.literal("live"),
    disabledReason: z.enum(RESUME_DISABLED_REASONS),
  }),
]);

const scriptSourceSchema = z.enum(["inline", "path"]);

const scriptLineageEntrySchema = z.object({
  runId: z.string(),
  uri: z.string(),
  available: z.boolean(),
});

const inspectionScriptResourceShape = {
  scriptUri: z.string(),
  lineage: z.array(scriptLineageEntrySchema),
} as const;

const runStatusShape = {
  runId: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  workflowName: z.string(),
  phases: z.array(z.string()),
  currentPhase: z.string().optional(),
  reason: z.string().optional(),
  errorCode: z.string().optional(),
  limits: workflowRunLimitsSchema.optional(),
  replayEligibility: replayEligibilitySchema.optional(),
  logTail: logTailSchema,
  calls: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      kind: z.enum(["agent", "checkpoint", "unknown"]),
      label: z.string().optional(),
      phase: z.string().optional(),
      model: z.string().optional(),
      backendId: z.string().optional(),
      timeoutMs: z.number().nonnegative().nullable().optional(),
      errorCode: z.string().optional(),
      resultPreview: z.string(),
      resultRedacted: z.boolean(),
      resultTruncated: z.boolean(),
    }),
  ),
  filter: z.object({
    lastN: z.number().int().min(1).max(50),
    logLines: z.number().int().min(0).max(50),
    labelGlob: z.string().optional(),
  }),
  truncation: z.object({
    maxStructuredBytes: z.number().int().positive(),
    byteCapApplied: z.boolean(),
    phases: countSchema.extend({ shortened: z.number().int().nonnegative() }),
    logs: countSchema.extend({
      shortened: z.number().int().nonnegative(),
      redacted: z.number().int().nonnegative(),
    }),
    calls: countSchema.extend({
      matched: z.number().int().nonnegative(),
      shortenedResults: z.number().int().nonnegative(),
      redactedResults: z.number().int().nonnegative(),
    }),
  }),
} as const;

const executionDetailsShape = {
  limits: workflowRunLimitsSchema.optional(),
  replayEligibility: replayEligibilitySchema.optional(),
  result: z.unknown().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  logs: z.array(z.string()).optional(),
  logTail: logTailSchema.optional(),
  authContext: authContextSchema.optional(),
  checkpointContext: checkpointContextSchema.optional(),
  fallbacks: z.array(fallbackSchema).optional(),
  checkpointsTaken: z.array(checkpointTakenSchema).optional(),
  resumeReport: resumeReportSchema.optional(),
} as const;

const executionResultSchema = z
  .object({
    runId: z.string(),
    status: z.enum(["paused", "completed", "failed", "aborted"]),
    ...executionDetailsShape,
    scriptUri: z.string(),
  })
  .strict();

const waitSchema = z.object({
  requestedMs: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  returnedBecause: z.enum(["terminal", "timeout", "immediate"]),
});

const inspectionRequired = [
  "workflowName",
  "phases",
  "logTail",
  "calls",
  "filter",
  "truncation",
  "lineage",
] as const;

const terminalStatuses = ["paused", "completed", "failed", "aborted"] as const;
const nonterminalStatuses = ["pending", "running"] as const;
const commonOutputFields = ["runId", "status", "scriptUri", "limits", "replayEligibility"] as const;
const executionDetailFields = [
  "result",
  "tokenUsage",
  "logs",
  "logTail",
  "authContext",
  "checkpointContext",
  "fallbacks",
  "checkpointsTaken",
  "resumeReport",
] as const;
const inspectionFields = [
  ...inspectionRequired,
  "currentPhase",
  "reason",
  "errorCode",
] as const;
const variantOutputFields = [
  ...executionDetailFields,
  "scriptSource",
  ...inspectionFields,
  "wait",
  "outcome",
  "stopped",
  "alreadyTerminal",
] as const;

const forbidsRequired = (...fields: string[]) => ({
  not: { anyOf: fields.map((field) => ({ required: [field] })) },
});

function forbidsOutside(allowed: readonly string[]) {
  const allowedFields = new Set(allowed);
  return forbidsRequired(...new Set(variantOutputFields.filter((field) => !allowedFields.has(field))));
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedFields = new Set<string>([...commonOutputFields, ...allowed]);
  return Object.entries(value).every(([field, fieldValue]) =>
    fieldValue === undefined || allowedFields.has(field));
}

/**
 * The SDK's registerTool runtime accepts an arbitrary Zod schema in its types, but 1.29.0
 * only publishes and validates object schemas. Keep an object schema for interoperability,
 * attach the exact branch constraints as JSON Schema metadata, and mirror them at runtime.
 */
export const workflowToolOutputShape = z
  .object({
    runId: z.string(),
    status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
    ...executionDetailsShape,
    scriptSource: scriptSourceSchema.optional(),
    scriptUri: z.string(),
    lineage: inspectionScriptResourceShape.lineage.optional(),
    workflowName: runStatusShape.workflowName.optional(),
    phases: runStatusShape.phases.optional(),
    currentPhase: runStatusShape.currentPhase,
    reason: runStatusShape.reason,
    errorCode: runStatusShape.errorCode,
    calls: runStatusShape.calls.optional(),
    filter: runStatusShape.filter.optional(),
    truncation: runStatusShape.truncation.optional(),
    wait: waitSchema.optional(),
    outcome: executionResultSchema.optional(),
    stopped: z.boolean().optional(),
    alreadyTerminal: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const has = (field: keyof typeof value) => value[field] !== undefined;
    const inspectionComplete = inspectionRequired.every((field) => has(field));
    const terminal = terminalStatuses.includes(value.status as typeof terminalStatuses[number]);
    let valid: boolean;
    if (has("scriptSource")) {
      valid = has("limits") && (value.status === "running"
        ? hasOnlyFields(value, ["scriptSource"])
        : terminal && hasOnlyFields(value, ["scriptSource", ...executionDetailFields]));
    } else if (has("stopped") || has("alreadyTerminal")) {
      valid =
        inspectionComplete &&
        has("stopped") &&
        has("alreadyTerminal") &&
        (value.status === "completed" || value.status === "failed" || value.status === "aborted") &&
        hasOnlyFields(value, [...inspectionFields, "stopped", "alreadyTerminal"]);
    } else if (has("wait")) {
      valid =
        inspectionComplete &&
        hasOnlyFields(value, [...inspectionFields, "wait", "tokenUsage", "outcome"]) &&
        (terminal ? has("outcome") : !has("outcome"));
    } else {
      valid = inspectionComplete && hasOnlyFields(value, inspectionFields);
    }
    if (!valid) {
      context.addIssue({ code: "custom", message: "output does not match a workflow result variant" });
    }
  })
  .meta({
    oneOf: [
      {
        title: "Workflow execution",
        required: ["scriptSource", "limits"],
        properties: { status: { enum: terminalStatuses } },
        ...forbidsOutside(["scriptSource", ...executionDetailFields]),
      },
      {
        title: "Workflow background admission",
        required: ["scriptSource", "limits"],
        properties: { status: { const: "running" } },
        ...forbidsOutside(["scriptSource"]),
      },
      {
        title: "Workflow inspection",
        required: [...inspectionRequired],
        ...forbidsOutside(inspectionFields),
      },
      {
        title: "Workflow await",
        required: [...inspectionRequired, "wait"],
        ...forbidsOutside([...inspectionFields, "wait", "tokenUsage", "outcome"]),
        anyOf: [
          {
            required: ["outcome"],
            properties: { status: { enum: terminalStatuses } },
          },
          {
            properties: { status: { enum: nonterminalStatuses } },
            ...forbidsRequired("outcome"),
          },
        ],
      },
      {
        title: "Workflow stop acknowledgement",
        required: [...inspectionRequired, "stopped", "alreadyTerminal"],
        properties: { status: { enum: ["completed", "failed", "aborted"] } },
        ...forbidsOutside([...inspectionFields, "stopped", "alreadyTerminal"]),
      },
    ],
  });

export type WorkflowScriptSource = z.infer<typeof scriptSourceSchema>;

export interface WorkflowScriptLineageEntry {
  runId: string;
  uri: string;
  available: boolean;
}

export interface WorkflowScriptResourceFields {
  scriptUri: string;
  lineage: WorkflowScriptLineageEntry[];
}

export interface WorkflowExecutionScriptResourceFields {
  scriptSource: WorkflowScriptSource;
  scriptUri: string;
}

export interface WorkflowExecutionOutcome<T = unknown> {
  runId: string;
  status: Exclude<WorkflowRunResult["status"], "pending" | "running">;
  scriptUri: string;
  limits?: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
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

export interface WorkflowExecutionToolResult<T = unknown>
  extends WorkflowExecutionOutcome<T>, WorkflowExecutionScriptResourceFields {
  limits: WorkflowRunLimits;
}

export interface WorkflowBackgroundAccepted extends WorkflowExecutionScriptResourceFields {
  runId: string;
  status: "running";
  limits: WorkflowRunLimits;
  replayEligibility?: WorkflowReplayEligibility;
}

export interface WorkflowAwaitMetadata {
  requestedMs: number;
  elapsedMs: number;
  returnedBecause: "terminal" | "timeout" | "immediate";
}

export interface WorkflowInspectionToolResult extends WorkflowRunStatus, WorkflowScriptResourceFields {}

export interface WorkflowRunAwaitResult<T = unknown> extends WorkflowRunStatus, WorkflowScriptResourceFields {
  wait: WorkflowAwaitMetadata;
  /** Cumulative usage observed for live calls in this execution; absent before any is known. */
  tokenUsage?: TokenUsage;
  /** Present exactly when status is paused/completed/failed/aborted. */
  outcome?: WorkflowExecutionOutcome<T>;
}

export interface WorkflowStopResult extends WorkflowRunStatus, WorkflowScriptResourceFields {
  status: "completed" | "failed" | "aborted";
  stopped: boolean;
  alreadyTerminal: boolean;
}

export type WorkflowToolResult<T = unknown> =
  | WorkflowExecutionToolResult<T>
  | WorkflowBackgroundAccepted
  | WorkflowInspectionToolResult
  | WorkflowRunAwaitResult<T>
  | WorkflowStopResult;

export function toWorkflowExecutionOutcome<T>(
  run: WorkflowRunResult<T>,
  resources: Pick<WorkflowExecutionScriptResourceFields, "scriptUri">,
): WorkflowExecutionOutcome<T> {
  if (run.status === "pending" || run.status === "running") {
    throw new TypeError(`Workflow execution result must be terminal, received ${run.status}`);
  }
  return {
    runId: run.runId,
    status: run.status,
    ...(run.effectiveLimits === undefined ? {} : { limits: run.effectiveLimits }),
    ...(run.replayEligibility === undefined ? {} : { replayEligibility: run.replayEligibility }),
    result: run.result,
    tokenUsage: run.tokenUsage,
    logs: run.logs,
    ...(run.logTail === undefined ? {} : { logTail: run.logTail }),
    authContext: run.authContext,
    checkpointContext: run.checkpointContext,
    ...(run.fallbacks === undefined ? {} : { fallbacks: run.fallbacks }),
    ...(run.checkpointsTaken === undefined ? {} : { checkpointsTaken: run.checkpointsTaken }),
    ...(run.resumeReport === undefined ? {} : { resumeReport: run.resumeReport }),
    ...resources,
  };
}

export function toWorkflowToolResult<T>(
  run: WorkflowRunResult<T>,
  resources: WorkflowExecutionScriptResourceFields,
): WorkflowExecutionToolResult<T> {
  const outcome = toWorkflowExecutionOutcome(run, resources);
  if (outcome.limits === undefined) {
    throw new TypeError("Current workflow execution result is missing resolved run limits");
  }
  return {
    ...outcome,
    limits: outcome.limits,
    scriptSource: resources.scriptSource,
  };
}
