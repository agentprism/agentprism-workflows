import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

// Input schema and cross-field discriminator for the single MCP `workflow` tool.
// Numeric execution knobs retain their existing clamp-at-runtime behavior. Inspection
// bounds are rejected at the Zod boundary because they are wire-contract limits.
import type { WorkflowRunInspectionOptions } from "@automatalabs/workflows";
import { isAbsolute } from "node:path";
import { z } from "zod";

const checkpointRepliesSchema = z.record(
  z.string().refine(
    (key) => {
      const callIndex = Number(key);
      return Number.isSafeInteger(callIndex) && callIndex >= 0 && String(callIndex) === key;
    },
    "checkpoint reply keys must be canonical non-negative safe integer call indexes",
  ),
  z.unknown(),
);

export const workflowToolInputShape = {
  action: z
    .enum(["run", "config", "inspect", "await", "stop"])
    .optional()
    .describe(
      "Operation. Omit or use run to validate then execute; config discovers live backend/model/mode/config options without starting a run; inspect reads immediately; await waits for terminal status; stop aborts a live run or cancels one in-flight agent.",
    ),
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Raw JavaScript workflow script (no Markdown fences). Exactly one of script or scriptPath is required for run; both are forbidden for config/inspect/await/stop. First statement MUST be `export const meta = { name, description, phases? }`. When present, phases MUST be an array of objects shaped `{ title: string, detail?: string, model?: string }`, never an array of strings.",
    ),
  scriptPath: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), "scriptPath must be an absolute path")
    .optional()
    .describe(
      "Absolute path, on the server's filesystem, to a workflow script file read once at admission. " +
        "Exactly one of script or scriptPath is required for run; both are forbidden for config/inspect/await/stop. " +
        "Relative paths are rejected.",
    ),
  projectDir: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), "projectDir must be an absolute path")
    .optional()
    .describe(
      "Absolute project directory used as the cwd for config discovery and, for run, the project-scoped store " +
        "(where the runId, journal, and resume state live) plus default execution cwd. " +
        "Required for run and config on the shared workflow daemon; on a single-project (in-process) server it " +
        "defaults to that server's own project. Forbidden for inspect/await/stop — a runId locates its project.",
    ),
  harnesses: z
    .array(z.string().regex(/^[a-z][a-z0-9._-]*$/i, "invalid backend name"))
    .min(1)
    .max(16)
    .optional()
    .describe('With action="config", backend names to probe. Omit to probe every backend registered on this server.'),
  modelSpecs: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(16)
    .optional()
    .describe(
      'With action="config", exact routed model specs to select before reading their model-specific mode and config-option catalogs. Use mode only when modes.availableModes explicitly lists its exact id; modes:null means unsupported.',
    ),
  modelFilter: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'With action="config", return model ids matching this case-insensitive substring or /regular expression/. Omit for bounded per-provider model summaries.',
    ),
  probeTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(120_000)
    .optional()
    .describe('With action="config", per-backend no-prompt probe timeout. Default 60000; range 1..120000.'),
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
    .describe("Per-agent total-wall timeout in ms. Omit/null for no hard timeout (the engine owns the timeout)."),
  agentIdleTimeoutMs: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Per-agent no-backend-activity timeout in ms. Omit/null to disable the idle watchdog."),
  resumeFromRunId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Start a new run from this persisted source run. Re-send the script via script or scriptPath and the desired args; the manager validates replay eligibility and runs live wherever reuse is uncertain. The source ID must exist in this project namespace.",
    ),
  resumePolicy: z
    .enum(["auto", "positional"])
    .optional()
    .describe('Resume matching policy. Default "auto"; requires resumeFromRunId.'),
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
    .describe("Project-scoped workflow run ID. Required for inspect/await/stop; forbidden for config/run."),
  callIndex: z
    .number()
    .int()
    .nonnegative()
    .safe()
    .optional()
    .describe(
      "With action=stop, cancel exactly this in-flight agent call without aborting the run. Forbidden for every other action.",
    ),
  forceOwner: z
    .boolean()
    .optional()
    .describe(
      "With whole-run action=stop, explicitly authorize terminating a superseded owner daemon when graceful cross-generation control cannot settle. Forbidden with callIndex and every other action.",
    ),
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

interface WorkflowExecuteToolInputBase {
  action?: "run";
  /** Absolute project directory selecting the run store and default execution cwd. */
  projectDir?: string;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  agentIdleTimeoutMs?: number | null;
  resumeFromRunId?: string;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<number, unknown>;
  /** Default false. True acknowledges after admission and executes in this server process. */
  background?: boolean;
  runId?: never;
  callIndex?: never;
  forceOwner?: never;
  waitMs?: never;
  lastN?: never;
  labelGlob?: never;
  logLines?: never;
}

export type WorkflowExecuteToolInput = WorkflowExecuteToolInputBase &
  (
    | { script: string; scriptPath?: never }
    | { script?: never; scriptPath: string }
  );

export interface WorkflowConfigToolInput {
  action: "config";
  /** Absolute project cwd used for project-sensitive backend discovery. */
  projectDir?: string;
  harnesses?: string[];
  modelSpecs?: string[];
  modelFilter?: string;
  probeTimeoutMs?: number;
  script?: never;
  scriptPath?: never;
  runId?: never;
  forceOwner?: never;
}

export interface WorkflowInspectToolInput extends WorkflowRunInspectionOptions {
  action: "inspect";
  runId: string;
  callIndex?: never;
  forceOwner?: never;
  script?: never;
  scriptPath?: never;
  projectDir?: never;
  background?: never;
  waitMs?: never;
  resumeFromRunId?: never;
  resumePolicy?: never;
  checkpointReplies?: never;
}

export interface WorkflowAwaitToolInput extends WorkflowRunInspectionOptions {
  action: "await";
  runId: string;
  callIndex?: never;
  forceOwner?: never;
  /** Default 20_000; integer range 0..25_000. Zero is a non-blocking status read. */
  waitMs?: number;
  script?: never;
  scriptPath?: never;
  projectDir?: never;
  background?: never;
  resumeFromRunId?: never;
  resumePolicy?: never;
  checkpointReplies?: never;
}

export interface WorkflowStopToolInput extends WorkflowRunInspectionOptions {
  action: "stop";
  runId: string;
  /** Omitted for whole-run stop; present to cancel exactly one in-flight agent call. */
  callIndex?: number;
  /** Explicitly authorize terminating a superseded owner daemon. Forbidden with callIndex. */
  forceOwner?: boolean;
  script?: never;
  scriptPath?: never;
  projectDir?: never;
  background?: never;
  waitMs?: never;
  resumeFromRunId?: never;
  resumePolicy?: never;
  checkpointReplies?: never;
}

export type WorkflowToolInput =
  | WorkflowExecuteToolInput
  | WorkflowConfigToolInput
  | WorkflowInspectToolInput
  | WorkflowAwaitToolInput
  | WorkflowStopToolInput;

interface RawWorkflowToolInput {
  action?: "run" | "config" | "inspect" | "await" | "stop";
  script?: string;
  scriptPath?: string;
  projectDir?: string;
  harnesses?: string[];
  modelSpecs?: string[];
  modelFilter?: string;
  probeTimeoutMs?: number;
  args?: unknown;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number | null;
  agentIdleTimeoutMs?: number | null;
  resumeFromRunId?: string;
  resumePolicy?: "auto" | "positional";
  checkpointReplies?: Record<string, unknown>;
  background?: boolean;
  runId?: string;
  callIndex?: number;
  forceOwner?: boolean;
  lastN?: number;
  labelGlob?: string;
  logLines?: number;
  waitMs?: number;
}

function hasConfigFields(raw: RawWorkflowToolInput): boolean {
  return raw.harnesses !== undefined || raw.modelSpecs !== undefined || raw.modelFilter !== undefined || raw.probeTimeoutMs !== undefined;
}

function hasExecutionFields(raw: RawWorkflowToolInput): boolean {
  return (
    raw.script !== undefined ||
    raw.scriptPath !== undefined ||
    raw.projectDir !== undefined ||
    raw.args !== undefined ||
    raw.maxAgents !== undefined ||
    raw.concurrency !== undefined ||
    raw.agentRetries !== undefined ||
    raw.agentTimeoutMs !== undefined ||
    raw.agentIdleTimeoutMs !== undefined ||
    raw.resumeFromRunId !== undefined ||
    raw.resumePolicy !== undefined ||
    raw.checkpointReplies !== undefined ||
    raw.background !== undefined
  );
}

function invalid(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid workflow tool input: ${message}`);
}

export interface ParseWorkflowToolInputOptions {
  /**
   * Enforce projectDir on run inputs. The shared workflow daemon serves every project from
   * one process and has no ambient cwd, so a run must name its project; a single-project
   * (in-process) server leaves this off and defaults to its own project.
   */
  requireProjectDir?: boolean;
}

/** Apply the action discriminator after the MCP SDK has validated primitive fields. */
export function parseWorkflowToolInput(
  raw: RawWorkflowToolInput,
  options: ParseWorkflowToolInputOptions = {},
): WorkflowToolInput {
  if (raw.action === "config") {
    if (
      raw.script !== undefined ||
      raw.scriptPath !== undefined ||
      raw.args !== undefined ||
      raw.maxAgents !== undefined ||
      raw.concurrency !== undefined ||
      raw.agentRetries !== undefined ||
      raw.agentTimeoutMs !== undefined ||
      raw.agentIdleTimeoutMs !== undefined ||
      raw.resumeFromRunId !== undefined ||
      raw.resumePolicy !== undefined ||
      raw.checkpointReplies !== undefined ||
      raw.background !== undefined ||
      raw.runId !== undefined ||
      raw.callIndex !== undefined ||
      raw.forceOwner !== undefined ||
      raw.waitMs !== undefined ||
      raw.lastN !== undefined ||
      raw.labelGlob !== undefined ||
      raw.logLines !== undefined
    ) {
      invalid('action="config" accepts only projectDir, harnesses, modelSpecs, modelFilter, and probeTimeoutMs');
    }
    if (options.requireProjectDir === true && raw.projectDir === undefined) {
      invalid(
        "config requires projectDir (the absolute project directory) on this server so project-sensitive backend options are discovered in the correct cwd",
      );
    }
    return {
      action: "config",
      projectDir: raw.projectDir,
      harnesses: raw.harnesses,
      modelSpecs: raw.modelSpecs,
      modelFilter: raw.modelFilter,
      probeTimeoutMs: raw.probeTimeoutMs,
    };
  }

  if (raw.action === "inspect") {
    if (!raw.runId) invalid('action="inspect" requires runId');
    if (hasExecutionFields(raw) || hasConfigFields(raw) || raw.waitMs !== undefined || raw.callIndex !== undefined || raw.forceOwner !== undefined) {
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
    if (hasExecutionFields(raw) || hasConfigFields(raw) || raw.callIndex !== undefined || raw.forceOwner !== undefined) {
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

  if (raw.action === "stop") {
    if (!raw.runId) invalid('action="stop" requires runId');
    if (hasExecutionFields(raw) || hasConfigFields(raw) || raw.waitMs !== undefined) {
      invalid('action="stop" cannot include execution fields or waitMs');
    }
    if (raw.callIndex !== undefined && raw.forceOwner !== undefined) {
      invalid('action="stop" forceOwner is forbidden with callIndex');
    }
    return {
      action: "stop",
      runId: raw.runId,
      callIndex: raw.callIndex,
      ...(raw.forceOwner === undefined ? {} : { forceOwner: raw.forceOwner }),
      lastN: raw.lastN,
      labelGlob: raw.labelGlob,
      logLines: raw.logLines,
    };
  }

  if (
    raw.runId !== undefined ||
    raw.callIndex !== undefined ||
    raw.forceOwner !== undefined ||
    raw.waitMs !== undefined ||
    raw.lastN !== undefined ||
    raw.labelGlob !== undefined ||
    raw.logLines !== undefined ||
    hasConfigFields(raw)
  ) {
    invalid("run inputs cannot include inspection fields");
  }
  const hasScript = raw.script !== undefined;
  const hasScriptPath = raw.scriptPath !== undefined;
  if (hasScript === hasScriptPath) invalid("exactly one of script or scriptPath is required");
  if (options.requireProjectDir === true && raw.projectDir === undefined) {
    invalid(
      "run requires projectDir (the absolute project directory) on this server — it selects the project-scoped run store and default execution cwd",
    );
  }
  if (raw.resumePolicy !== undefined && raw.resumeFromRunId === undefined) {
    invalid("resumePolicy requires resumeFromRunId");
  }
  if (raw.checkpointReplies !== undefined && raw.resumeFromRunId === undefined) {
    invalid("checkpointReplies requires resumeFromRunId");
  }
  const common = {
    action: raw.action,
    projectDir: raw.projectDir,
    args: raw.args,
    maxAgents: raw.maxAgents,
    concurrency: raw.concurrency,
    agentRetries: raw.agentRetries,
    agentTimeoutMs: raw.agentTimeoutMs,
    agentIdleTimeoutMs: raw.agentIdleTimeoutMs,
    resumeFromRunId: raw.resumeFromRunId,
    resumePolicy: raw.resumePolicy,
    checkpointReplies: raw.checkpointReplies === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(raw.checkpointReplies).map(([callIndex, reply]) => [Number(callIndex), reply]),
        ),
    background: raw.background ?? false,
  };
  return hasScript
    ? { ...common, script: raw.script as string }
    : { ...common, scriptPath: raw.scriptPath as string };
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
