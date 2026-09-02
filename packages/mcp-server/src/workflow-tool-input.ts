import type { WorkflowRunInspectionOptions } from "@automatalabs/workflows";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { isAbsolute } from "node:path";
import { z } from "zod";

// The published schema is an action-discriminated oneOf. Every object variant is strict, so
// cross-action fields fail at the MCP validation boundary instead of being stripped and rejected
// later by a prose-maintained discriminator. Compatibility aliases are normalized before this
// canonical schema (see normalizeCompatibilityInput), never published as competing actions.

const permissionResponseSchema = z
  .object({
    outcome: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("cancelled") }).strict(),
      z.object({ outcome: z.literal("selected"), optionId: z.string().min(1).max(512) }).strict(),
    ]),
  })
  .strict();

export const WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT = 16_384;
export const WORKFLOW_RESULT_CHUNK_BYTES_MAX = 16_384;
export const WORKFLOW_RESULT_CHUNK_BYTES_MIN = 4;

const actionSchema = z
  .enum(["config", "run", "resume", "status", "result", "permissions-response", "stop"])
  .describe("Workflow operation. See docs topic workflow/run-lifecycle for the action guide.");
const scriptSchema = z
  .string()
  .min(1)
  .describe("Run only: raw JavaScript workflow source, without Markdown fences.");
const scriptPathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "scriptPath must be an absolute path")
  .describe("Run only: absolute server-side script path, read once at admission.");
const projectDirSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "projectDir must be an absolute path")
  .describe("Config/run project directory; required by the shared daemon.");
const harnessesSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9._-]*$/i, "invalid backend name"))
  .min(1)
  .max(16)
  .describe("Config only: backend names to probe; omit to probe all registered backends.");
const modelSpecsSchema = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(16)
  .describe("Config only: exact routed model specs whose model-specific options should be read.");
const modelFilterSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("Config only: case-insensitive model-id substring or /regular expression/ filter.");
const argsSchema = z.unknown().describe("Run/resume JSON value exposed to the script as `args`.");
const maxAgentsSchema = z.number().int().positive().describe("Maximum agents for the new run; default 1000.");
const concurrencySchema = z
  .number()
  .int()
  .positive()
  .describe("Maximum concurrent agents; values above 16 are clamped.");
const agentRetriesSchema = z
  .number()
  .int()
  .min(0)
  .describe("Recoverable retries per agent; values above 3 are clamped.");
const resumeFromRunIdSchema = z
  .string()
  .min(1)
  .describe("Run only: source run for edited-script replay. Use resume for stored-script replay.");
const resumePolicySchema = z
  .enum(["auto", "positional"])
  .describe("Replay matching policy; default auto.");
const checkpointRepliesSchema = z
  .record(
    z.string().refine(
      (key) => {
        const callIndex = Number(key);
        return Number.isSafeInteger(callIndex) && callIndex >= 0 && String(callIndex) === key;
      },
      "checkpoint reply keys must be canonical non-negative safe integer call indexes",
    ),
    z.unknown(),
  )
  .describe("Checkpoint decisions keyed by the source checkpoint call index.");
const backgroundSchema = z
  .boolean()
  .describe("Run/resume only: acknowledge after durable admission; default false.");
const runIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+-[a-z0-9]+$/, "runId must be an engine-generated run ID")
  .describe("Project-scoped engine run ID.");
const permissionIdSchema = z
  .string()
  .uuid()
  .describe("Permissions-response only: opaque pending permission ID returned by status.");
const callIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .describe("Stop only: cancel this in-flight agent call without aborting the run.");
const forceOwnerSchema = z
  .boolean()
  .describe("Whole-run stop only: authorize terminating a superseded owner daemon.");
const lastNSchema = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe("Status/stop latest matching calls; default 20, range 1..50.");
const labelGlobSchema = z
  .string()
  .refine((value) => [...value].length >= 1 && [...value].length <= 128, {
    message: "labelGlob must contain from 1 through 128 Unicode code points",
  })
  .describe("Status/stop case-sensitive whole-label glob using *, ?, and backslash escaping.");
const logLinesSchema = z
  .number()
  .int()
  .min(0)
  .max(50)
  .describe("Status/stop latest log lines; default 20, range 0..50.");
const waitMsSchema = z
  .number()
  .int()
  .min(0)
  .max(25_000)
  .describe("Status request bound in milliseconds, 0..25000; it never cancels workflow work.");
const offsetSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .describe("Result UTF-8 byte offset; default 0, then use the previous endOffset.");
const maxBytesSchema = z
  .number()
  .int()
  .min(WORKFLOW_RESULT_CHUNK_BYTES_MIN)
  .max(WORKFLOW_RESULT_CHUNK_BYTES_MAX)
  .describe(`Result chunk bound; default and maximum ${WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT} bytes.`);

/**
 * Public field catalog retained for hosts that reuse individual validators. It is not the tool
 * schema: workflowToolInputBranches and workflowToolInputSchema are the canonical action union.
 */
export const workflowToolInputShape = {
  action: actionSchema,
  script: scriptSchema,
  scriptPath: scriptPathSchema,
  projectDir: projectDirSchema,
  harnesses: harnessesSchema,
  modelSpecs: modelSpecsSchema,
  modelFilter: modelFilterSchema,
  args: argsSchema,
  maxAgents: maxAgentsSchema,
  concurrency: concurrencySchema,
  agentRetries: agentRetriesSchema,
  resumeFromRunId: resumeFromRunIdSchema,
  resumePolicy: resumePolicySchema,
  checkpointReplies: checkpointRepliesSchema,
  background: backgroundSchema,
  runId: runIdSchema,
  permissionId: permissionIdSchema,
  response: permissionResponseSchema,
  callIndex: callIndexSchema,
  forceOwner: forceOwnerSchema,
  lastN: lastNSchema,
  labelGlob: labelGlobSchema,
  logLines: logLinesSchema,
  waitMs: waitMsSchema,
  offset: offsetSchema,
  maxBytes: maxBytesSchema,
} as const;

const configInputSchema = z
  .object({
    action: z.literal("config").describe("Discover live backend, model, mode, and config options."),
    projectDir: projectDirSchema.optional(),
    harnesses: harnessesSchema.optional(),
    modelSpecs: modelSpecsSchema.optional(),
    modelFilter: modelFilterSchema.optional(),
  })
  .strict();

const executionOptionsShape = {
  projectDir: projectDirSchema.optional(),
  args: argsSchema.optional(),
  maxAgents: maxAgentsSchema.optional(),
  concurrency: concurrencySchema.optional(),
  agentRetries: agentRetriesSchema.optional(),
  background: backgroundSchema.optional(),
} as const;

const editedReplayShape = {
  resumeFromRunId: resumeFromRunIdSchema,
  resumePolicy: resumePolicySchema.optional(),
  checkpointReplies: checkpointRepliesSchema.optional(),
} as const;

const runInlineInputSchema = z
  .object({
    action: z.literal("run").describe("Validate and execute explicit workflow content."),
    script: scriptSchema,
    ...executionOptionsShape,
  })
  .strict();
const runPathInputSchema = z
  .object({
    action: z.literal("run").describe("Validate and execute explicit workflow content."),
    scriptPath: scriptPathSchema,
    ...executionOptionsShape,
  })
  .strict();
const replayInlineInputSchema = z
  .object({
    action: z.literal("run").describe("Execute edited content with replay from a source run."),
    script: scriptSchema,
    ...executionOptionsShape,
    ...editedReplayShape,
  })
  .strict();
const replayPathInputSchema = z
  .object({
    action: z.literal("run").describe("Execute edited content with replay from a source run."),
    scriptPath: scriptPathSchema,
    ...executionOptionsShape,
    ...editedReplayShape,
  })
  .strict();
const runInputSchema = z.xor([
  runInlineInputSchema,
  runPathInputSchema,
  replayInlineInputSchema,
  replayPathInputSchema,
]);

const resumeInputSchema = z
  .object({
    action: z.literal("resume").describe("Create a new run from a source's stored script and args."),
    runId: runIdSchema,
    args: argsSchema.optional(),
    maxAgents: maxAgentsSchema.optional(),
    concurrency: concurrencySchema.optional(),
    agentRetries: agentRetriesSchema.optional(),
    resumePolicy: resumePolicySchema.optional(),
    checkpointReplies: checkpointRepliesSchema.optional(),
    background: backgroundSchema.optional(),
  })
  .strict();

const inspectionShape = {
  runId: runIdSchema,
  lastN: lastNSchema.optional(),
  labelGlob: labelGlobSchema.optional(),
  logLines: logLinesSchema.optional(),
} as const;

const statusInputSchema = z
  .object({
    action: z.literal("status").describe("Read status immediately or wait for a milestone."),
    ...inspectionShape,
    waitMs: waitMsSchema.optional(),
  })
  .strict();

const resultInputSchema = z
  .object({
    action: z.literal("result").describe("Page the exact JSON result of a completed run."),
    runId: runIdSchema,
    offset: offsetSchema.optional(),
    maxBytes: maxBytesSchema.optional(),
  })
  .strict();

const permissionResponseInputSchema = z
  .object({
    action: z.literal("permissions-response").describe("Resolve one pending ACP permission."),
    runId: runIdSchema,
    permissionId: permissionIdSchema,
    response: permissionResponseSchema,
  })
  .strict();

const wholeRunStopInputSchema = z
  .object({
    action: z.literal("stop").describe("Abort a run through its execution owner."),
    ...inspectionShape,
    forceOwner: forceOwnerSchema.optional(),
  })
  .strict();
const callStopInputSchema = z
  .object({
    action: z.literal("stop").describe("Cancel one in-flight agent while keeping the run live."),
    ...inspectionShape,
    callIndex: callIndexSchema,
  })
  .strict();
const stopInputSchema = z.xor([wholeRunStopInputSchema, callStopInputSchema]);

/** The seven canonical action branches; run and stop contain structural sub-variants. */
export const workflowToolInputBranches = {
  config: configInputSchema,
  run: runInputSchema,
  resume: resumeInputSchema,
  status: statusInputSchema,
  result: resultInputSchema,
  "permissions-response": permissionResponseInputSchema,
  stop: stopInputSchema,
} as const;

export const workflowToolCanonicalInputSchema = z.xor([
  workflowToolInputBranches.config,
  workflowToolInputBranches.run,
  workflowToolInputBranches.resume,
  workflowToolInputBranches.status,
  workflowToolInputBranches.result,
  workflowToolInputBranches["permissions-response"],
  workflowToolInputBranches.stop,
]).meta({ type: "object" });

function normalizeCompatibilityInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.action === "inspect") {
    // inspect never accepted a request wait. Leaving the alias untouched makes the canonical
    // schema reject this invalid hybrid instead of silently changing its meaning.
    if (raw.waitMs !== undefined) return value;
    return { ...raw, action: "status", waitMs: 0 };
  }
  if (raw.action === "await") {
    return { ...raw, action: "status", waitMs: raw.waitMs ?? 20_000 };
  }
  if (raw.action === undefined) {
    return { ...raw, action: "run" };
  }
  return value;
}

/**
 * Runtime wire schema. Discovery publishes only the canonical oneOf, while the preprocess keeps
 * pre-status inspect/await and omitted-action run clients working during their migration window.
 */
export const workflowToolInputSchema = z.preprocess(
  normalizeCompatibilityInput,
  workflowToolCanonicalInputSchema,
);

interface WorkflowExecuteToolInputBase {
  action: "run";
  /** Absolute project directory selecting the run store and default execution cwd. */
  projectDir?: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  /** Default false. True acknowledges after admission and executes in this server process. */
  background?: boolean;
}

type WorkflowExplicitContent =
  | { script: string; scriptPath?: never }
  | { script?: never; scriptPath: string };

export type WorkflowExecuteToolInput = WorkflowExecuteToolInputBase &
  WorkflowExplicitContent &
  (
    | { resumeFromRunId?: never; resumePolicy?: never; checkpointReplies?: never }
    | {
        resumeFromRunId: string;
        resumePolicy?: "auto" | "positional";
        checkpointReplies?: Record<number, unknown>;
      }
  );

/** Simple stored-content replay that creates and durably links a fresh target run. */
export interface WorkflowResumeToolInput {
  action: "resume";
  /** Persisted source run whose immutable script and, by default, strict-JSON args are reused. */
  runId: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  background?: boolean;
}

export interface WorkflowConfigToolInput {
  action: "config";
  projectDir?: string;
  harnesses?: string[];
  modelSpecs?: string[];
  modelFilter?: string;
}

export interface WorkflowStatusToolInput extends WorkflowRunInspectionOptions {
  action: "status";
  runId: string;
  /** Omit or use zero for an immediate observation; positive values wait at most this long. */
  waitMs?: number;
}

/** @deprecated Runtime migration input only. Use WorkflowStatusToolInput with omitted waitMs. */
export type WorkflowInspectToolInput = Omit<WorkflowStatusToolInput, "action" | "waitMs"> & {
  action: "inspect";
  waitMs?: never;
};

/** @deprecated Runtime migration input only. Use WorkflowStatusToolInput with a positive waitMs. */
export type WorkflowAwaitToolInput = Omit<WorkflowStatusToolInput, "action"> & {
  action: "await";
  waitMs?: number;
};

export interface WorkflowResultToolInput {
  action: "result";
  runId: string;
  offset?: number;
  maxBytes?: number;
}

export interface WorkflowPermissionResponseToolInput {
  action: "permissions-response";
  runId: string;
  permissionId: string;
  response: z.infer<typeof permissionResponseSchema>;
}

type WorkflowStopToolInputBase = WorkflowRunInspectionOptions & {
  action: "stop";
  runId: string;
};

export type WorkflowStopToolInput = WorkflowStopToolInputBase &
  ({ callIndex: number; forceOwner?: never } | { callIndex?: never; forceOwner?: boolean });

export type WorkflowToolInput =
  | WorkflowConfigToolInput
  | WorkflowExecuteToolInput
  | WorkflowResumeToolInput
  | WorkflowStatusToolInput
  | WorkflowResultToolInput
  | WorkflowPermissionResponseToolInput
  | WorkflowStopToolInput;

export interface ParseWorkflowToolInputOptions {
  /** Require projectDir for config/run on the shared multi-project daemon. */
  requireProjectDir?: boolean;
}

function invalid(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid workflow tool input: ${message}`);
}

function checkpointReplies(
  value: Record<string, unknown> | undefined,
): Record<number, unknown> | undefined {
  return value === undefined
    ? undefined
    : Object.fromEntries(Object.entries(value).map(([callIndex, reply]) => [Number(callIndex), reply]));
}

/** Normalize compatibility input, validate one canonical branch, and apply runtime defaults. */
export function parseWorkflowToolInput(
  supplied: unknown,
  options: ParseWorkflowToolInputOptions = {},
): WorkflowToolInput {
  const parsed = workflowToolInputSchema.safeParse(supplied);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    invalid(first === undefined ? "input does not match a workflow action" : first.message);
  }
  const input = parsed.data;
  if (
    (input.action === "config" || input.action === "run") &&
    options.requireProjectDir &&
    input.projectDir === undefined
  ) {
    invalid(`${input.action} requires projectDir (the absolute project directory) on this shared workflow daemon`);
  }
  switch (input.action) {
    case "config":
      return input;
    case "run":
      return {
        ...input,
        checkpointReplies: checkpointReplies(
          "checkpointReplies" in input ? input.checkpointReplies : undefined,
        ),
        background: input.background ?? false,
      } as WorkflowExecuteToolInput;
    case "resume":
      return {
        ...input,
        checkpointReplies: checkpointReplies(input.checkpointReplies),
        background: input.background ?? false,
      };
    case "status":
      return { ...input, waitMs: input.waitMs ?? 0 };
    case "result":
      return {
        ...input,
        offset: input.offset ?? 0,
        maxBytes: input.maxBytes ?? WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT,
      };
    case "permissions-response":
    case "stop":
      return input;
  }
}

/** Clamp only execution resource knobs; status values are rejected rather than clamped. */
export function clampWorkflowInput<T extends WorkflowExecuteToolInput | WorkflowResumeToolInput>(input: T): T {
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
  } as T;
}
