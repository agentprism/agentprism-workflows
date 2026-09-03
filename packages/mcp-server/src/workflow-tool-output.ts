import type { TokenUsage, WorkflowRunLimits } from "@automatalabs/shared-types";
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
  concurrency: z.number().int().positive(),
  agentRetries: z.number().int().nonnegative(),
});

const authContextSchema = z.object({
  backendId: z.string().optional(),
  methods: z.array(
    z.object({ id: z.string(), type: z.enum(["agent", "terminal"]), name: z.string().optional() }),
  ),
});

const permissionOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled") }).strict(),
  z.object({ outcome: z.literal("selected"), optionId: z.string() }).strict(),
]);

const pendingPermissionSchema = z.object({
  version: z.literal(1),
  permissionId: z.string().uuid(),
  runId: z.string(),
  callIndex: z.number().int().nonnegative(),
  backendId: z.string(),
  label: z.string().optional(),
  requestedAt: z.string(),
  request: z.object({
    toolCall: z.record(z.string(), z.unknown()),
    options: z.array(z.object({
      optionId: z.string(),
      name: z.string(),
      kind: z.string(),
      _meta: z.record(z.string(), z.unknown()).nullable().optional(),
    })),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  requestTruncated: z.boolean(),
  requestRedacted: z.boolean(),
});

const permissionInteractionSchema = z.object({
  permissionRequests: z.literal("may-block"),
  collectWith: z.array(z.literal("status")),
  respondWith: z.literal("permissions-response"),
  elicitation: z.enum(["available", "unavailable"]),
});

const permissionAcknowledgementSchema = z.object({
  permissionId: z.string().uuid(),
  runId: z.string(),
  callIndex: z.number().int().nonnegative(),
  outcome: permissionOutcomeSchema,
  respondedAt: z.string(),
});

const checkpointContextSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  hash: z.string(),
  prompt: z.string(),
  kind: z.enum(["confirm", "input", "select"]),
  choices: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  timeoutMs: z.number().nonnegative().optional(),
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

const scriptSourceSchema = z.enum(["inline", "path", "stored"]);

const latestActivitySchema = z.object({
  scope: z.string(),
  callIndex: z.number().int().nonnegative(),
  executionStartSeq: z.number().int().positive(),
  label: z.string(),
  phase: z.string().optional(),
  timestamp: z.string(),
  cursor: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  observedEvents: z.number().int().nonnegative(),
  latestText: z.string().optional(),
  lastToolName: z.string().optional(),
  tokensObserved: z.number().int().nonnegative().optional(),
  relevance: z.enum(["current", "terminal"]),
}).superRefine((value, context) => {
  if ((value.latestText === undefined) === (value.lastToolName === undefined)) {
    context.addIssue({
      code: "custom",
      message: "latest activity must contain exactly one of latestText or lastToolName",
    });
  }
});

const inspectionScriptResourceShape = {
  scriptUri: z.string(),
  resultUri: z.string().optional(),
  eventsUri: z.string().optional(),
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
  latestActivity: z.array(latestActivitySchema).optional(),
  logTail: logTailSchema,
  calls: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      kind: z.enum(["agent", "checkpoint", "unknown"]),
      label: z.string().optional(),
      phase: z.string().optional(),
      model: z.string().optional(),
      backendId: z.string().optional(),
      errorCode: z.string().optional(),
      status: z.enum(["queued", "running"]).optional(),
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
  result: z.unknown().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  logs: z.array(z.string()).optional(),
  logTail: logTailSchema.optional(),
  authContext: authContextSchema.optional(),
  checkpointContext: checkpointContextSchema.optional(),
  fallbacks: z.array(fallbackSchema).optional(),
  checkpointsTaken: z.array(checkpointTakenSchema).optional(),
} as const;

const executionResultSchema = z
  .object({
    runId: z.string(),
    status: z.enum(["paused", "completed", "failed", "aborted"]),
    ...executionDetailsShape,
    scriptUri: z.string(),
    resultUri: z.string().optional(),
    eventsUri: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resultUri !== undefined && value.status !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["resultUri"],
        message: "resultUri is available only for completed workflow outcomes",
      });
    }
  })
  .meta({
    allOf: [
      {
        if: { required: ["resultUri"] },
        then: { required: ["status"], properties: { status: { const: "completed" } } },
      },
    ],
  });

const diagnosticRecordSchema = z.record(z.string(), z.unknown());
const sessionModeStateSchema = z.object({
  currentModeId: z.string(),
  availableModes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })),
  _meta: z.record(z.string(), z.unknown()).nullable().optional(),
});
const harnessDiagnosticSchema = z.object({
  backendId: z.string(),
  defaultModeId: z.string().optional().describe(
    "AgentPrism's explicit mode when a call omits mode; absent for no-mode/custom backends.",
  ),
  model: z.string().optional(),
  probed: z.boolean(),
  error: z.string().optional(),
  modes: sessionModeStateSchema.nullable().optional().describe(
    "Present on every probed:true row. Exact advertised mode domain; null means unsupported, so omit mode.",
  ),
  options: z.array(z.unknown()),
  omittedOptions: z.number().int().nonnegative(),
});
const validationSummarySchema = z.object({
  ok: z.literal(false),
  exitCode: z.union([z.literal(1), z.literal(2)]),
  parse: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    meta: z.object({
      name: z.string(),
      description: z.string(),
      phases: z.array(z.string()),
    }).optional(),
  }),
  dryRun: z.object({
    ok: z.boolean(),
    status: z.string(),
    reason: z.string().optional(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
    agentCalls: z.array(diagnosticRecordSchema),
    omittedAgentCalls: z.number().int().nonnegative(),
    checkpoints: z.array(diagnosticRecordSchema),
    omittedCheckpoints: z.number().int().nonnegative(),
    phasesVisited: z.array(z.string()),
    harnessOptions: z.array(harnessDiagnosticSchema),
    omittedHarnesses: z.number().int().nonnegative(),
  }).optional(),
  warnings: z.array(z.string()),
  omittedWarnings: z.number().int().nonnegative(),
});
const configModelDiagnosticSchema = z.object({
  backendId: z.string(),
  probed: z.boolean(),
  error: z.string().optional(),
  hasModelOption: z.boolean(),
  filter: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  groups: z.array(z.unknown()).optional(),
  matches: z.array(z.string()),
  matchCount: z.number().int().nonnegative(),
  omittedMatches: z.number().int().nonnegative(),
});

const inspectionRequired = [
  "workflowName",
  "phases",
  "logTail",
  "calls",
  "filter",
  "truncation",
] as const;

const terminalStatuses = ["paused", "completed", "failed", "aborted"] as const;
const nonterminalStatuses = ["pending", "running"] as const;
const commonOutputFields = ["runId", "status", "scriptUri", "resultUri", "eventsUri", "limits"] as const;
const runOutputRequired = ["runId", "status", "scriptUri"] as const;
const executionDetailFields = [
  "result",
  "tokenUsage",
  "logs",
  "logTail",
  "authContext",
  "checkpointContext",
  "fallbacks",
  "checkpointsTaken",
] as const;
const inspectionFields = [
  ...inspectionRequired,
  "currentPhase",
  "reason",
  "errorCode",
  "latestActivity",
] as const;
const discoveryOutputFields = [
  "action",
  "ok",
  "validation",
  "harnessOptions",
  "omittedHarnesses",
  "models",
] as const;
const resultRetrievalFields = [
  "mimeType",
  "encoding",
  "totalBytes",
  "offset",
  "endOffset",
  "hasMore",
  "chunk",
] as const;
const stopControlSchema = z.object({
  state: z.literal("pending"),
  operationId: z.string(),
  requestedAt: z.string(),
  owner: z.object({
    pid: z.number().int().positive(),
    instanceId: z.string().optional(),
    version: z.string().optional(),
    lameDuck: z.boolean().optional(),
    activeRuns: z.number().int().nonnegative().optional(),
    controlProtocol: z.literal(1).optional(),
  }).optional(),
});

const variantOutputFields = [
  ...executionDetailFields,
  "scriptSource",
  ...inspectionFields,
  "outcome",
  "stopped",
  "alreadyTerminal",
  "control",
  "pendingPermissions",
  "interaction",
  "permissionResponse",
  "latestActivity",
  ...resultRetrievalFields,
  ...discoveryOutputFields,
] as const;

const forbidsRequired = (...fields: string[]) => ({
  not: { anyOf: fields.map((field) => ({ required: [field] })) },
});

function forbidsOutside(allowed: readonly string[]) {
  const allowedFields = new Set(allowed);
  return forbidsRequired(...new Set(variantOutputFields.filter((field) => !allowedFields.has(field))));
}

function hasOnlyExactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedFields = new Set<string>(allowed);
  return Object.entries(value).every(([field, fieldValue]) =>
    fieldValue === undefined || allowedFields.has(field));
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
    action: z.enum(["run", "config", "result"]).optional(),
    ok: z.boolean().optional(),
    validation: validationSummarySchema.optional(),
    harnessOptions: z.array(harnessDiagnosticSchema).optional(),
    omittedHarnesses: z.number().int().nonnegative().optional(),
    models: z.array(configModelDiagnosticSchema).optional(),
    runId: z.string().optional(),
    status: z.enum(["rejected", "pending", "running", "paused", "completed", "failed", "aborted"]).optional(),
    ...executionDetailsShape,
    scriptSource: scriptSourceSchema.optional(),
    scriptUri: z.string().optional(),
    resultUri: z.string().optional(),
    eventsUri: z.string().optional(),
    workflowName: runStatusShape.workflowName.optional(),
    phases: runStatusShape.phases.optional(),
    currentPhase: runStatusShape.currentPhase,
    reason: runStatusShape.reason,
    errorCode: runStatusShape.errorCode,
    latestActivity: runStatusShape.latestActivity,
    calls: runStatusShape.calls.optional(),
    filter: runStatusShape.filter.optional(),
    truncation: runStatusShape.truncation.optional(),
    outcome: executionResultSchema.optional(),
    stopped: z.boolean().optional(),
    alreadyTerminal: z.boolean().optional(),
    control: stopControlSchema.optional(),
    pendingPermissions: z.array(pendingPermissionSchema).optional(),
    interaction: permissionInteractionSchema.optional(),
    permissionResponse: permissionAcknowledgementSchema.optional(),
    mimeType: z.literal("application/json").optional(),
    encoding: z.literal("utf-8").optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    chunk: z.string().optional(),
  })
  .superRefine((value, context) => {
    const has = (field: keyof typeof value) => value[field] !== undefined;
    const inspectionComplete = inspectionRequired.every((field) => has(field));
    const runCommonComplete = has("runId") && has("status") && has("scriptUri");
    const terminal = terminalStatuses.includes(value.status as typeof terminalStatuses[number]);
    let valid: boolean;
    if (value.action === "result") {
      valid =
        value.status === "completed" &&
        has("runId") &&
        has("resultUri") &&
        resultRetrievalFields.every((field) => has(field)) &&
        hasOnlyExactFields(value, ["action", "runId", "status", "resultUri", "eventsUri", ...resultRetrievalFields]);
    } else if (value.action === "config") {
      valid =
        has("ok") &&
        has("harnessOptions") &&
        has("omittedHarnesses") &&
        has("models") &&
        hasOnlyExactFields(value, ["action", "ok", "harnessOptions", "omittedHarnesses", "models"]);
    } else if (value.action === "run") {
      valid =
        value.status === "rejected" &&
        has("validation") &&
        hasOnlyExactFields(value, ["action", "status", "validation"]);
    } else if (has("scriptSource")) {
      valid = runCommonComplete && has("eventsUri") && has("limits") && (value.status === "running"
        ? hasOnlyFields(value, ["scriptSource", "pendingPermissions", "interaction"])
        : terminal && hasOnlyFields(value, ["scriptSource", ...executionDetailFields]));
    } else if (has("permissionResponse")) {
      valid =
        runCommonComplete &&
        inspectionComplete &&
        hasOnlyFields(value, [...inspectionFields, "pendingPermissions", "interaction", "permissionResponse"]);
    } else if (has("control")) {
      valid =
        runCommonComplete &&
        inspectionComplete &&
        value.stopped === false &&
        value.alreadyTerminal === false &&
        (value.status === "pending" || value.status === "running") &&
        hasOnlyFields(value, [...inspectionFields, "stopped", "alreadyTerminal", "control"]);
    } else if (has("stopped") || has("alreadyTerminal")) {
      valid =
        runCommonComplete &&
        inspectionComplete &&
        has("stopped") &&
        has("alreadyTerminal") &&
        (value.status === "completed" || value.status === "failed" || value.status === "aborted") &&
        hasOnlyFields(value, [...inspectionFields, "stopped", "alreadyTerminal"]);
    } else {
      valid =
        runCommonComplete &&
        inspectionComplete &&
        hasOnlyFields(value, [...inspectionFields, "tokenUsage", "outcome", "pendingPermissions", "interaction"]) &&
        (terminal ? has("outcome") : !has("outcome"));
    }
    if (has("resultUri") && value.status !== "completed") valid = false;
    if (!valid) {
      context.addIssue({ code: "custom", message: "output does not match a workflow result variant" });
    }
  })
  .meta({
    allOf: [
      {
        if: { required: ["resultUri"] },
        then: { required: ["status"], properties: { status: { const: "completed" } } },
      },
    ],
    oneOf: [
      {
        title: "Workflow result retrieval",
        required: ["action", "runId", "status", "resultUri", ...resultRetrievalFields],
        properties: { action: { const: "result" }, status: { const: "completed" } },
        ...forbidsRequired(
          "ok",
          "validation",
          "harnessOptions",
          "omittedHarnesses",
          "models",
          "scriptUri",
          "scriptSource",
          "limits",
          ...executionDetailFields,
          ...inspectionFields,
          "outcome",
          "stopped",
          "alreadyTerminal",
          "control",
          "pendingPermissions",
          "interaction",
          "permissionResponse",
        ),
      },
      {
        title: "Workflow config discovery",
        required: ["action", "ok", "harnessOptions", "omittedHarnesses", "models"],
        properties: { action: { const: "config" } },
        ...forbidsRequired(
          "validation",
          "runId",
          "status",
          "scriptUri",
          "eventsUri",
          "scriptSource",
          ...executionDetailFields,
          ...inspectionFields,
          "outcome",
          "stopped",
          "alreadyTerminal",
          "control",
        ),
      },
      {
        title: "Workflow validation rejection",
        required: ["action", "status", "validation"],
        properties: { action: { const: "run" }, status: { const: "rejected" } },
        ...forbidsRequired(
          "ok",
          "harnessOptions",
          "omittedHarnesses",
          "models",
          "runId",
          "scriptUri",
          "eventsUri",
          "scriptSource",
          ...executionDetailFields,
          ...inspectionFields,
          "outcome",
          "stopped",
          "alreadyTerminal",
          "control",
        ),
      },
      {
        title: "Workflow execution",
        required: [...runOutputRequired, "eventsUri", "scriptSource", "limits"],
        properties: { status: { enum: terminalStatuses } },
        ...forbidsOutside(["scriptSource", ...executionDetailFields]),
      },
      {
        title: "Workflow background admission",
        required: [...runOutputRequired, "eventsUri", "scriptSource", "limits"],
        properties: { status: { const: "running" } },
        ...forbidsOutside(["scriptSource", "pendingPermissions", "interaction"]),
      },
      {
        title: "Workflow status",
        required: [...runOutputRequired, ...inspectionRequired],
        ...forbidsOutside([...inspectionFields, "tokenUsage", "outcome", "pendingPermissions", "interaction"]),
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
        title: "Workflow permission response acknowledgement",
        required: [...runOutputRequired, ...inspectionRequired, "permissionResponse"],
        ...forbidsOutside([...inspectionFields, "pendingPermissions", "interaction", "permissionResponse"]),
      },
      {
        title: "Workflow stop acknowledgement",
        required: [...runOutputRequired, ...inspectionRequired, "stopped", "alreadyTerminal"],
        properties: { status: { enum: ["completed", "failed", "aborted"] } },
        ...forbidsOutside([...inspectionFields, "stopped", "alreadyTerminal"]),
      },
      {
        title: "Workflow stop pending",
        required: [...runOutputRequired, ...inspectionRequired, "stopped", "alreadyTerminal", "control"],
        properties: {
          status: { enum: nonterminalStatuses },
          stopped: { const: false },
          alreadyTerminal: { const: false },
        },
        ...forbidsOutside([...inspectionFields, "stopped", "alreadyTerminal", "control"]),
      },
    ],
  });

/**
 * Output shape for the app-only `workflow-events` tool: the same document served by the
 * `workflow://runs/{runId}/events` resource (cursor-paged, redacted, append-only records).
 */
export const workflowEventsOutputShape = {
  schemaVersion: z.literal(1),
  runId: z.string(),
  streamId: z.string(),
  workflowName: z.string(),
  status: z.enum(["pending", "running", "paused", "completed", "failed", "aborted"]),
  finalized: z.boolean(),
  after: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  endCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  events: z.array(z.unknown()),
} as const;

export type WorkflowScriptSource = z.infer<typeof scriptSourceSchema>;

/** One bounded, durable activity summary per logical agent call. */
export interface WorkflowRunLatestActivity {
  scope: string;
  callIndex: number;
  executionStartSeq: number;
  label: string;
  phase?: string;
  timestamp: string;
  /** Sequence/cursor of the source agentProgress record in the linked events stream. */
  cursor: number;
  turnCount: number;
  observedEvents: number;
  latestText?: string;
  lastToolName?: string;
  tokensObserved?: number;
  /** Whether this execution is still current or has reached call/run terminal relevance. */
  relevance: "current" | "terminal";
}

export interface WorkflowScriptResourceFields {
  scriptUri: string;
  resultUri?: string;
  eventsUri?: string;
}

export interface WorkflowExecutionScriptResourceFields {
  scriptSource: WorkflowScriptSource;
  scriptUri: string;
  resultUri?: string;
  eventsUri: string;
}

export interface WorkflowExecutionOutcome<T = unknown> {
  runId: string;
  status: Exclude<WorkflowRunResult["status"], "pending" | "running">;
  scriptUri: string;
  resultUri?: string;
  eventsUri?: string;
  limits?: WorkflowRunLimits;
  result?: T;
  tokenUsage?: WorkflowRunResult["tokenUsage"];
  logs?: string[];
  logTail?: WorkflowRunResult["logTail"];
  authContext?: WorkflowRunResult["authContext"];
  checkpointContext?: WorkflowRunResult["checkpointContext"];
  fallbacks?: WorkflowRunResult["fallbacks"];
  checkpointsTaken?: WorkflowRunResult["checkpointsTaken"];
}

export type WorkflowExecutionToolResult<T = unknown> = WorkflowExecutionOutcome<T> &
  WorkflowExecutionScriptResourceFields & { limits: WorkflowRunLimits };

export interface WorkflowPermissionInteraction {
  permissionRequests: "may-block";
  collectWith: ["status"];
  respondWith: "permissions-response";
  elicitation: "available" | "unavailable";
}

export interface WorkflowBackgroundAccepted extends WorkflowExecutionScriptResourceFields {
  runId: string;
  status: "running";
  limits: WorkflowRunLimits;
  pendingPermissions?: z.infer<typeof pendingPermissionSchema>[];
  interaction?: WorkflowPermissionInteraction;
}

export interface WorkflowRunObservation extends WorkflowRunStatus, WorkflowScriptResourceFields {
  latestActivity?: WorkflowRunLatestActivity[];
  pendingPermissions?: z.infer<typeof pendingPermissionSchema>[];
  interaction?: WorkflowPermissionInteraction;
  permissionResponse?: z.infer<typeof permissionAcknowledgementSchema>;
}

export interface WorkflowStatusToolResult<T = unknown> extends WorkflowRunObservation {
  /** Cumulative usage observed for live calls in this execution; absent before any is known. */
  tokenUsage?: TokenUsage;
  pendingPermissions?: z.infer<typeof pendingPermissionSchema>[];
  interaction?: WorkflowPermissionInteraction;
  /** Present exactly when status is paused/completed/failed/aborted. */
  outcome?: WorkflowExecutionOutcome<T>;
}

export type WorkflowInspectionToolResult = WorkflowRunObservation;

export interface WorkflowResultRetrieval {
  action: "result";
  runId: string;
  status: "completed";
  resultUri: string;
  eventsUri?: string;
  mimeType: "application/json";
  encoding: "utf-8";
  totalBytes: number;
  offset: number;
  endOffset: number;
  hasMore: boolean;
  chunk: string;
}

export interface WorkflowConfigToolResult {
  action: "config";
  ok: boolean;
  harnessOptions: Array<Record<string, unknown>>;
  omittedHarnesses: number;
  models: Array<Record<string, unknown>>;
}

export interface WorkflowValidationRejected {
  action: "run";
  status: "rejected";
  validation: {
    ok: false;
    exitCode: 1 | 2;
    [key: string]: unknown;
  };
}

export interface WorkflowPermissionResponseResult extends WorkflowRunStatus, WorkflowScriptResourceFields {
  latestActivity?: WorkflowRunLatestActivity[];
  pendingPermissions?: z.infer<typeof pendingPermissionSchema>[];
  permissionResponse: z.infer<typeof permissionAcknowledgementSchema>;
}

export interface WorkflowStopResult extends WorkflowRunStatus, WorkflowScriptResourceFields {
  latestActivity?: WorkflowRunLatestActivity[];
  status: "completed" | "failed" | "aborted";
  stopped: boolean;
  alreadyTerminal: boolean;
}

export interface WorkflowStopPendingResult extends WorkflowRunStatus, WorkflowScriptResourceFields {
  latestActivity?: WorkflowRunLatestActivity[];
  status: "pending" | "running";
  stopped: false;
  alreadyTerminal: false;
  control: z.infer<typeof stopControlSchema>;
}

export type WorkflowToolResult<T = unknown> =
  | WorkflowResultRetrieval
  | WorkflowConfigToolResult
  | WorkflowValidationRejected
  | WorkflowExecutionToolResult<T>
  | WorkflowBackgroundAccepted
  | WorkflowStatusToolResult<T>
  | WorkflowPermissionResponseResult
  | WorkflowStopResult
  | WorkflowStopPendingResult;

export function toWorkflowExecutionOutcome<T>(
  run: WorkflowRunResult<T>,
  resources: Pick<WorkflowExecutionScriptResourceFields, "scriptUri" | "resultUri"> &
    Partial<Pick<WorkflowExecutionScriptResourceFields, "eventsUri">>,
): WorkflowExecutionOutcome<T> {
  if (run.status === "pending" || run.status === "running") {
    throw new TypeError(`Workflow execution result must be terminal, received ${run.status}`);
  }
  return {
    runId: run.runId,
    status: run.status,
    ...(run.effectiveLimits === undefined ? {} : { limits: run.effectiveLimits }),
    result: run.result,
    tokenUsage: run.tokenUsage,
    logs: run.logs,
    ...(run.logTail === undefined ? {} : { logTail: run.logTail }),
    authContext: run.authContext,
    checkpointContext: run.checkpointContext,
    ...(run.fallbacks === undefined ? {} : { fallbacks: run.fallbacks }),
    ...(run.checkpointsTaken === undefined ? {} : { checkpointsTaken: run.checkpointsTaken }),
    scriptUri: resources.scriptUri,
    ...(resources.eventsUri === undefined ? {} : { eventsUri: resources.eventsUri }),
    ...(run.status === "completed" && resources.resultUri !== undefined
      ? { resultUri: resources.resultUri }
      : {}),
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
    eventsUri: resources.eventsUri,
  };
}
