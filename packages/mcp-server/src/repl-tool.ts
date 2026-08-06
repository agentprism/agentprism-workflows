/**
 * The `repl` MCP tool — the roadmap doc's Surface section: "One `repl`
 * tool, action-enum shaped — the same pattern as this repo's `workflow`
 * MCP tool. Workspaces follow the daemon's project model exactly."
 *
 * Actions:
 *
 * Every result carries the doc's MACHINE-READABLE shape as
 * `structuredContent` alongside the bounded text (the published
 * `outputSchema` — see `replToolOutputShape`): eval/wait return
 * `{ output, result?, pending, checkpoints, completed }` (plus the
 * wait-only `drained`/`timedOut` flags and `outputTruncated`), status
 * returns the structured workspaces surface (workspace state, the
 * reconcile summary, the workspace MANIFEST, live agents, pending
 * ops), interrupt returns its honest outcome, reset the dropped
 * acknowledgement, and the error paths a structured error string.
 * Guest output and trusted orchestration metadata stay separate
 * fields — never one flat string (phase-E review rejection: the
 * text-only result mixed them).
 *
 * - `eval { projectDir, code }` → the broker's tool-result shape rendered
 *   as text: console output lines, the previewed completion value when
 *   the eval resolved, the pending call ids when it suspended, the
 *   raised checkpoints, and the settled call ids.
 * - `wait { projectDir, ids?, timeoutMs }` → a bounded server-side wait:
 *   pumps until the target calls settle (or `timeoutMs` elapses — "still
 *   running" on timeout), then renders the SAME eval-result shape —
 *   console output included (phase-D review round 2: the wait used to
 *   return only pending/checkpoint/completion metadata and defer the
 *   console output drained by its pumps to the next eval, losing
 *   immediate guest-visible restored-call output and warnings).
 * - `status { projectDir? }` → workspaces (source, reconcile summary, or
 *   a refused snapshot's contained error) plus the WORKSPACE MANIFEST
 *   (the doc: "top-level bindings with name, type, size, provenance
 *   (which subagent produced the value, from what task, when), and
 *   live-handle status. Metadata, never content — ls for the data
 *   plane"), live agents, pending ops, and the `$N` log-ref range.
 *   Without `projectDir` every known project context is listed (daemon
 *   mode). Status never CREATES a workspace — an untouched project
 *   reports as such.
 * - `interrupt { projectDir, id? }` → cancel one subagent call (ACP
 *   `session/cancel` downward; a drained handle's recorded session is
 *   re-attached lazily first); without an id, BREAK THE RUNNING EVAL:
 *   the broker's eval-break arm targets the workspace's in-flight eval
 *   (suspended on a call or a checkpoint, its continuation registered;
 *   refused — nothing armed — when the workspace is idle), and the
 *   armed signal is consulted by EVERY subsequent execution of that
 *   eval — the settlement drains that resume its continuation (a
 *   wait's pumps, a later eval's pump, the client-presence drain) AND
 *   a direct eval's own drain (a `checkpoint.answer` in a later eval
 *   resumes the continuation synchronously inside that eval's drain) —
 *   and the quickjs interrupt handler breaks it MID-RUN, consumed on
 *   first observation so a later eval is unaffected (see
 *   `src/repl-project.ts`). A fully synchronous (never-yielding)
 *   runaway blocks the single-threaded daemon's event loop, so the
 *   request itself cannot arrive mid-run — that case is bounded by the
 *   per-eval wall-clock deadline (the harness's eval guard); every
 *   eval that YIELDS (suspends on a call) is interruptible at its next
 *   execution, and the wait tool's pumps run with the broker chain
 *   released between them so an interrupt lands promptly mid-wait.
 * - `reset { projectDir }` → teardown (cancels in-flight ACP sessions,
 *   drops the VM and the whole `repl/` store), clearing any contained
 *   snapshot refusal.
 *
 * A stored snapshot that REFUSES on first touch (corrupt/truncated,
 * version bump, wasm-hash mismatch) is CONTAINED: every eval/wait/
 * interrupt result surfaces the refusal loudly and points at `reset`;
 * the daemon never crash-loops and never silently discards the data.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrokerRunner, WasmModule } from "@automatalabs/repl-engine";
import type { ReplEvalResult } from "@automatalabs/repl-engine";
import { capFinalText, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "@automatalabs/repl-engine";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { resolveProjectDir, type WorkflowProjectRegistry, type ProjectContext } from "./project-registry.js";
import {
  createReplProjectState,
  ensureReplWorkspace,
  resetReplProjectState,
  type ReplProjectState,
} from "./repl-project.js";
import type { ReplPresenceLedger } from "./repl-presence.js";

export const replToolInputShape = {
  action: z
    .enum(["eval", "wait", "status", "interrupt", "reset"])
    .describe(
      "Operation. eval runs a script in the workspace's VM (persistent between calls); wait pumps server-side " +
        "until the target calls settle or the timeout elapses; status reports workspaces, the workspace manifest, " +
        "live agents, and pending ops; interrupt cancels one subagent call or breaks the running eval (refused when " +
        "nothing is running); reset " +
        "drops the VM and its stored state.",
    ),
  projectDir: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), "projectDir must be an absolute path")
    .optional()
    .describe(
      "Absolute project directory the workspace lives in: one VM per projectDir, addressed exactly like the " +
        "workflow tool's projectDir (the same validated, realpathed per-project context; the workspace state " +
        "survives MCP-session churn and daemon restarts through the per-project repl store). Required on the " +
        "shared workflow daemon; optional (defaults to this server's own project) in single-project mode.",
    ),
  code: z
    .string()
    .optional()
    .describe("The JavaScript to eval (top-level await accepted; `return` is a syntax error; console output is captured)."),
  ids: z
    .array(z.string())
    .optional()
    .describe("Call ids to wait for (wait action). Omitted: wait for every pending call."),
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .max(120_000)
    .optional()
    .describe("Bounded server-side wait (wait action; default 30 000 ms, max 120 000 ms)."),
  id: z
    .string()
    .optional()
    .describe("The call id to cancel (interrupt action). Omitted: break the running eval (honestly refused when no eval is in flight)."),
};

export interface ReplToolOptions {
  projects: WorkflowProjectRegistry;
  /** The engine's compiled quickjs.wasm (a shared promise — the
   *  envelope's identity check compares its hash at restore). */
  wasm: Promise<WasmModule>;
  /** The workspaces' ACP runner (optional: each workspace's broker owns
   *  its own when omitted — tests inject a fake). */
  runner?: BrokerRunner;
  /** The per-eval wall-clock deadline in ms (the harness's eval guard;
   *  a currently-running runaway eval is always breakable through the
   *  quickjs interrupt handler — see `src/repl-project.ts`). Read from
   *  `AGENTPRISM_REPL_EVAL_TIMEOUT_MS`, default
   *  `DEFAULT_REPL_EVAL_TIMEOUT_MS`. */
  evalTimeoutMs: number;
  /** Mirrors the workflow tool's daemon-mode projectDir requirement. */
  requireProjectDir: boolean;
  /** The client-presence ledger (the doc's last-client-disconnect drain;
   *  see `repl-presence.ts`). */
  presence: ReplPresenceLedger;
  /** This server's client id (the MCP session id in daemon mode), used
   *  to touch presence. */
  clientId: () => string | undefined;
  /** When true, the server is shutting down and rejects new calls. */
  acceptingWork: () => boolean;
}

/** One parsed `repl` tool input — the action discriminator's output
 *  (the workflow tool's pattern: the MCP SDK validates the primitive
 *  fields, then the discriminator enforces each action's EXACT field
 *  set — required fields missing, and irrelevant known fields present,
 *  are both rejected at the boundary; phase-E review round 4: the
 *  input used to be a flat bag of optional fields with the action
 *  semantics deferred to late handler checks, so `reset` with `code`
 *  or `status` with `ids` was silently accepted). */
export type ParsedReplToolInput =
  | { action: "eval"; projectDir?: string; code: string }
  | { action: "wait"; projectDir?: string; ids?: string[]; timeoutMs: number }
  | { action: "status"; projectDir?: string }
  | { action: "interrupt"; projectDir?: string; id?: string }
  | { action: "reset"; projectDir?: string };

/** Which fields belong to which action (the discriminator's exact-shape
 *  vocabulary). */
const replInputFields = ["action", "projectDir", "code", "ids", "timeoutMs", "id"] as const;
type ReplInputField = (typeof replInputFields)[number];

const REPL_ACTION_FIELDS: Record<string, ReadonlySet<ReplInputField>> = {
  eval: new Set(["action", "projectDir", "code"]),
  wait: new Set(["action", "projectDir", "ids", "timeoutMs"]),
  status: new Set(["action", "projectDir"]),
  interrupt: new Set(["action", "projectDir", "id"]),
  reset: new Set(["action", "projectDir"]),
};

function invalidReplInput(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Invalid repl tool input: ${message}`);
}

/** Apply the action discriminator after the MCP SDK has validated the
 *  primitive fields: every action's EXACT field set is enforced here
 *  (missing required fields and extraneous known fields are both
 *  rejected; unknown fields are the SDK's rejection — the input schema
 *  is non-strict-shaped, so the discriminator additionally rejects
 *  irrelevant KNOWN fields like `reset` with `code` or `status` with
 *  `ids`). `requireProjectDir` mirrors the workflow tool's daemon-mode
 *  rule: projectDir is required for every action except `status` (which
 *  may list every known project context without naming one). */
export function parseReplToolInput(
  raw: Record<string, unknown>,
  options: { requireProjectDir: boolean },
): ParsedReplToolInput {
  const action = replToolInputShape.action.parse(raw.action);
  const allowed = REPL_ACTION_FIELDS[action];
  const present = replInputFields.filter((field) => field !== "action" && raw[field] !== undefined);
  for (const field of present) {
    if (!allowed.has(field)) {
      invalidReplInput(`action "${action}" cannot include ${field}`);
    }
  }
  const projectDir = raw.projectDir === undefined ? undefined : replToolInputShape.projectDir.parse(raw.projectDir);
  if (projectDir === undefined && options.requireProjectDir && action !== "status") {
    invalidReplInput("projectDir is required on the shared workflow daemon");
  }
  switch (action) {
    case "eval": {
      const code = replToolInputShape.code.parse(raw.code);
      if (code === undefined || code.length === 0) {
        invalidReplInput('eval requires a non-empty code string');
      }
      return { action, projectDir, code };
    }
    case "wait": {
      const ids = raw.ids === undefined ? undefined : replToolInputShape.ids.parse(raw.ids);
      const timeoutMs = replToolInputShape.timeoutMs.parse(raw.timeoutMs ?? 30_000) ?? 30_000;
      return { action, projectDir, ids, timeoutMs };
    }
    case "status":
      return { action, projectDir };
    case "interrupt": {
      const id = raw.id === undefined ? undefined : replToolInputShape.id.parse(raw.id);
      return { action, projectDir, id };
    }
    case "reset":
      return { action, projectDir };
  }
}

/** The project context a repl call addresses; undefined = no project. */
function resolveContext(
  options: ReplToolOptions,
  projectDir: string | undefined,
): ProjectContext | undefined {
  if (projectDir === undefined) {
    // Single-project mode: the registry's adopted default context.
    return options.projects.stores()[0];
  }
  const resolution = resolveProjectDir(projectDir);
  if (!resolution.ok) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid repl tool input: ${resolution.message}`);
  }
  return options.projects.getOrCreate(resolution.projectDir);
}

/** The contained-refusal result (a refused snapshot, surfaced loudly):
 *  the machine-readable error variant (keyed to the action that
 *  touched the refused workspace) plus the bounded text. */
function refusedResult(state: ReplProjectState, action: string): {
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  const error = state.restoreError!;
  return {
    structuredContent: {
      action,
      projectDir: state.projectDir,
      error: `${error.message} (the stored snapshot is not restorable with the running engine — run the repl tool with action "reset" to drop it and start a fresh workspace)`,
    },
    content: [
      {
        type: "text",
        text: capToolResultText(
          `REPL workspace refused: ${error.message}\nThe stored snapshot is not restorable with the running engine. ` +
            `Run the repl tool with action "reset" to drop it and start a fresh workspace.`,
        ),
      },
    ],
    isError: true,
  };
}

/** The last client-presence drain's failure, rendered as a warn line
 *  (phase-D review round 6: a failed drain — a snapshot-flush failure
 *  mid-drain, for example — is never silent; it is surfaced in every
 *  repl result until the next drain succeeds or reset clears it, and
 *  the next disconnect retries it). */
function drainErrorLine(state: ReplProjectState): string | null {
  const error = state.drainError;
  if (error === null) return null;
  return `warn: ${error.name}: ${error.message} (the last client-presence drain failed — the workspace state was ` +
    `not persisted; the next disconnect retries the drain)`;
}

/** The top-level output fields across all variants (the oneOf
 *  branches' forbidden-field vocabulary). */
const replOutputFields = [
  "action",
  "projectDir",
  "output",
  "outputTruncated",
  "result",
  "pending",
  "checkpoints",
  "completed",
  "drained",
  "timedOut",
  "workspaces",
  "interrupt",
  "dropped",
  "error",
] as const;

/** JSON-Schema metadata: forbid every variant field outside the
 *  allowed set (the workflow output shape's pattern). */
function forbidsOutside(allowed: readonly string[]) {
  const allowedFields = new Set(allowed);
  return {
    not: {
      anyOf: replOutputFields
        .filter((field) => !allowedFields.has(field))
        .map((field) => ({ required: [field] })),
    },
  };
}

/** One raised checkpoint as the machine-readable surface carries it
 *  (the question previewed — the same bounded form the text renders). */
const checkpointSummaryShape = z.object({
  id: z.string(),
  question: z.string(),
});

/** The restore's three-way reconcile report (which arm each pending
 *  call took — see the broker's `ReconcileReport`). */
const reconcileReportShape = z.object({
  settledFromStore: z.array(z.string()),
  reattached: z.array(z.string()),
  reissued: z.array(z.string()),
  failedLost: z.array(z.string()),
  requeuedCheckpoints: z.array(z.string()),
  leftPending: z.array(z.string()),
  reQueuedUndelivered: z.array(z.string()),
});

/** One workspace-manifest binding (the doc's manifest contract: name,
 *  type, size, provenance, live-handle status — metadata, never
 *  content). The type is the machine-readable structure-only label, the
 *  handle status and call id are their own fields (phase-E review round
 *  4: the manifest used to expose only the human-formatted `token`,
 *  with the live-handle status and call id embedded in the string). */
const manifestBindingShape = z.object({
  name: z.string(),
  /** Structure-only token (type/shape/size, and the live-handle status
   *  for agent handles) — never value content. */
  token: z.string(),
  /** The machine-readable structure-only type label (`string`,
   *  `number`, `object`, `array`, `agent handle`, … — see the engine's
   *  `manifestTypeLabel` vocabulary). */
  type: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** The stable call id of an agent-handle binding; null otherwise. */
  handleCallId: z.string().nullable(),
  /** The live-handle status of an agent-handle binding (`pending`
   *  while its founding call is unsettled, `settled` once it
   *  completed); null for non-handle bindings. */
  handleStatus: z.enum(["pending", "settled"]).nullable(),
  provenance: z.string().nullable(),
  provenanceAtMs: z.number().int().nonnegative().nullable(),
  task: z.string().nullable(),
});

/** The `$N` log-ref globals as a range (mirroring the harness
 *  manifest's logs breakdown). */
const logRefsShape = z.object({
  first: z.number().int().nonnegative().nullable(),
  last: z.number().int().nonnegative().nullable(),
  count: z.number().int().nonnegative(),
});

/** One live subagent session as status carries it. The guest-derived
 *  `task` is previewed at the ENGINE seam (head+tail capped at 200
 *  chars, the same bound as the manifest's task field): the structured
 *  status must respect the doc's output limits like the text content
 *  does (phase-E review round 4: the structured status used to copy
 *  the raw task, so a guest could push an unbounded task string
 *  through `structuredContent` while only the text was capped). */
const liveAgentShape = z.object({
  callId: z.string(),
  modelSpec: z.string(),
  task: z.string().max(200),
  state: z.enum(["opening", "running", "delivering", "idle"]),
  supportsSteering: z.boolean(),
  queuedSteers: z.number().int().nonnegative(),
});

/** One workspace's status entry (the doc's workspaces surface: the
 *  workspace state, the reconcile summary, the workspace manifest, live
 *  agents, and pending ops — everything bounded metadata, never guest
 *  content beyond the previewed checkpoint questions). */
const workspaceStatusShape = z.object({
  projectDir: z.string(),
  state: z.enum(["not-opened", "fresh", "restored", "refused"]),
  restoreError: z.string().optional(),
  reconcile: reconcileReportShape.optional(),
  bindings: z.array(manifestBindingShape),
  logs: logRefsShape,
  evalSeq: z.number().int().nonnegative(),
  inFlight: z.array(z.string()),
  checkpoints: z.array(checkpointSummaryShape),
  liveAgents: z.array(liveAgentShape),
  pending: z.array(z.string()),
  /** True when the client-presence drain closed every child (the
   *  workspace stays live; re-attach on demand). */
  childrenClosed: z.boolean(),
  drainError: z.string().optional(),
});

/** The interrupt action's structured outcome. */
const interruptOutcomeShape = z.object({
  outcome: z.enum(["targeted", "refused-idle", "cancelled", "idle", "failed", "none"]),
  callId: z.string().optional(),
});

/** The machine-readable output of the `repl` tool (published as the
 *  tool's `outputSchema`, mirrored by every result's
 *  `structuredContent`): the doc's public eval/wait shape
 *  `{ output, result?, pending, checkpoints, completed }` plus the
 *  wait-only drained/timedOut flags, the structured status fields
 *  (workspaces with the manifest, live agents, pending ops), the
 *  interrupt outcome, the reset acknowledgement, and the error
 *  variant. Guest output (the `output` lines, the previewed `result`)
 *  is kept strictly separate from the trusted orchestration metadata
 *  (pending/checkpoints/completed, the manifest, the agent states) —
 *  the phase-E review rejection: the old text-only result mixed them
 *  into one flat string. Every structured field is bounded metadata:
 *  the output lines are already capped by the broker, the checkpoint
 *  questions are previewed, and the manifest binds structure-only
 *  tokens — the structured surface never carries unbounded guest
 *  content. The text content stays alongside (the bounded human
 *  rendering, capped at 256 lines / 10 KB). */
export const replToolOutputShape = z
  .object({
    action: z.enum(["eval", "wait", "status", "interrupt", "reset"]),
    projectDir: z.string().optional(),
    // eval/wait (the doc's `{ output, result?, pending, checkpoints,
    // completed }`).
    output: z.array(z.string()).optional(),
    outputTruncated: z.boolean().optional(),
    result: z.string().optional(),
    pending: z.array(z.string()).optional(),
    checkpoints: z.array(checkpointSummaryShape).optional(),
    completed: z.array(z.string()).optional(),
    // wait-only: whether the targets settled within the bound (false =
    // the doc's "still running" timeout outcome).
    drained: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    // status: one entry per workspace context.
    workspaces: z.array(workspaceStatusShape).optional(),
    // interrupt: the honest outcome.
    interrupt: interruptOutcomeShape.optional(),
    // reset: the teardown acknowledgement.
    dropped: z.boolean().optional(),
    // The error variant (a refused snapshot, a missing project context).
    error: z.string().optional(),
  })
  .superRefine((value, context) => {
    const keys = new Set(Object.keys(value));
    const has = (field: string) => keys.has(field);
    const only = (...fields: string[]) =>
      [...keys].every((key) => key === "action" || fields.includes(key));
    const hasAll = (...fields: string[]) => fields.every(has);
    let valid: boolean;
    if (has("error")) {
      valid = only("projectDir", "error");
    } else if (value.action === "eval") {
      valid =
        only("projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed") &&
        hasAll("projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed");
    } else if (value.action === "wait") {
      valid =
        only("projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "drained", "timedOut") &&
        hasAll("projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed", "drained", "timedOut");
    } else if (value.action === "status") {
      valid = only("projectDir", "workspaces") && has("workspaces");
    } else if (value.action === "interrupt") {
      valid = only("projectDir", "interrupt") && hasAll("projectDir", "interrupt");
    } else if (value.action === "reset") {
      valid = only("projectDir", "dropped") && hasAll("projectDir", "dropped");
    } else {
      valid = false;
    }
    if (!valid) {
      context.addIssue({ code: "custom", message: "output does not match a repl result variant" });
    }
  })
  .meta({
    oneOf: [
      {
        title: "eval",
        required: ["action", "projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed"],
        properties: { action: { const: "eval" } },
        ...forbidsOutside(["action", "projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed"]),
      },
      {
        title: "wait",
        required: ["action", "projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed", "drained", "timedOut"],
        properties: { action: { const: "wait" } },
        ...forbidsOutside(["action", "projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "drained", "timedOut"]),
      },
      {
        title: "status",
        required: ["action", "workspaces"],
        properties: { action: { const: "status" } },
        ...forbidsOutside(["action", "projectDir", "workspaces"]),
      },
      {
        title: "interrupt",
        required: ["action", "projectDir", "interrupt"],
        properties: { action: { const: "interrupt" } },
        ...forbidsOutside(["action", "projectDir", "interrupt"]),
      },
      {
        title: "reset",
        required: ["action", "projectDir", "dropped"],
        properties: { action: { const: "reset" } },
        ...forbidsOutside(["action", "projectDir", "dropped"]),
      },
      {
        title: "error",
        required: ["action", "error"],
        ...forbidsOutside(["action", "projectDir", "error"]),
      },
    ],
  });

/** The truncation marker `capToolResultText` appends when the caps trip
 *  (its own budget is reserved inside the caps, so it always ships). */
const TOOL_RESULT_TRUNCATION_MARKER =
  `(tool result truncated — cap: ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes; the omitted console ` +
  `values remain reachable through their $N refs)`;

/** Apply the doc's output caps (256 lines / 10 KB, whichever trips
 *  first) to a repl tool result's FINAL text — the wire guarantee
 *  (phase-E review rejection: the caps used to apply only to the
 *  broker's console lines, so the result line, pending ids,
 *  checkpoints, completed ids, the wait timeout note, and status output
 *  were appended UNcapped). Every section is capped together, in order;
 *  when the caps trip, the truncation marker ships instead of the
 *  dropped tail. */
function capToolResultText(text: string): string {
  return capFinalText(text, TOOL_RESULT_TRUNCATION_MARKER);
}

/** Render the broker's eval-result shape as text (the tool's output; the
 *  same renderer serves eval AND wait — the doc's same-shape rule). */
function renderEvalResult(result: ReplEvalResult): string {
  const lines: string[] = [];
  if (result.output.length > 0) lines.push(...result.output);
  if (result.result !== undefined) lines.push(`result: ${result.result}`);
  if (result.pending.length > 0) lines.push(`pending: ${result.pending.join(", ")}`);
  for (const checkpoint of result.checkpoints) {
    lines.push(`checkpoint ${checkpoint.id}: ${checkpoint.question}`);
  }
  if (result.completed.length > 0) lines.push(`completed: ${result.completed.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "(no output)";
}

function renderStatus(contexts: Array<{ projectDir: string; repl?: ReplProjectState }>): string {
  const lines: string[] = [];
  for (const context of contexts) {
    const state = context.repl;
    if (state === undefined) {
      lines.push(`workspace ${context.projectDir}: not opened yet`);
      continue;
    }
    if (state.restoreError !== null) {
      lines.push(`workspace ${context.projectDir}: REFUSED — ${state.restoreError.message}`);
      continue;
    }
    if (state.source === null) {
      lines.push(`workspace ${context.projectDir}: not opened yet`);
      continue;
    }
    if (state.source === "restored") {
      const report = state.reconcileReport;
      lines.push(
        `workspace ${context.projectDir}: restored` +
          (report !== null
            ? ` (settled from store: ${report.settledFromStore.length}, re-attached: ${report.reattached.length}, ` +
              `re-issued: ${report.reissued.length}, failed/lost: ${report.failedLost.length}, ` +
              `checkpoints re-surfaced: ${report.requeuedCheckpoints.length})`
            : ""),
      );
    } else {
      lines.push(`workspace ${context.projectDir}: fresh`);
    }
    // The last failed client-presence drain, surfaced loudly (phase-D
    // review round 6: the failure used to be discarded silently).
    if (state.drainError !== null) {
      lines.push(`workspace ${context.projectDir}: LAST DRAIN FAILED — ${state.drainError.name}: ${state.drainError.message}`);
    }
    const broker = state.broker;
    if (broker === null) continue;
    // The workspace manifest (the doc's status surface): top-level
    // bindings with name, structure-only type/size token, provenance,
    // and live-handle status. Metadata, never content.
    const manifest = broker.workspaceManifest();
    if (manifest.bindings.length === 0) {
      lines.push("bindings: (none)");
    } else {
      lines.push("bindings:");
      for (const binding of manifest.bindings) {
        // The doc's provenance surface: which subagent produced the value
        // (via), from what task (task), when (at) — metadata, never
        // content.
        lines.push(
          `  ${binding.name} = ${binding.token}` +
            (binding.provenance !== null ? ` · via ${binding.provenance}` : "") +
            (binding.task !== null ? ` · task ${JSON.stringify(binding.task)}` : "") +
            (binding.provenanceAtMs !== null
              ? ` · at ${new Date(binding.provenanceAtMs).toISOString()}`
              : ""),
        );
      }
    }
    const logs = manifest.logs;
    lines.push(
      logs.first === null
        ? "logs: (none)"
        : `logs: $${logs.first}…$${logs.last} (${logs.count} values)`,
    );
    if (manifest.inFlight.length > 0) {
      lines.push(`in-flight calls: ${manifest.inFlight.join(", ")}`);
    }
    // The broker's authoritative child-warmth state (the project-level
    // latch alone is the drain-skip guard: it resets on every connect, so
    // the renderer reads the broker — a lazy re-attach after a drain
    // makes the workspace warm again and the line disappears).
    if (broker.isDrained) lines.push("children: closed (client-presence drain; re-attach on demand)");
    for (const agent of broker.liveAgents()) {
      // The task is part of the agent's provenance surface (the doc:
      // "from what task") — the renderer shows it alongside the state.
      lines.push(
        `agent ${agent.callId}: ${agent.state} — task: ${JSON.stringify(agent.task)} ` +
          `(${agent.modelSpec}; steering: ${agent.supportsSteering ? "yes" : "no"}; queued: ${agent.queuedSteers})`,
      );
    }
    const pending = broker.pendingCalls();
    if (pending.length > 0) lines.push(`pending: ${pending.map((entry) => entry.id).join(", ")}`);
    // The PREVIEWED checkpoint summaries (the same bounded form the
    // eval/wait surface carries and the structured status ships — the
    // doc's rule: questions appear previewed, truncated, in the tool
    // result; the raw question would be unbounded guest text).
    for (const checkpoint of broker.checkpointSummaries()) {
      lines.push(`checkpoint ${checkpoint.id}: ${checkpoint.question}`);
    }
  }
  return lines.join("\n");
}

/** The structured eval/wait content (the doc's public shape
 *  `{ output, result?, pending, checkpoints, completed }` plus the
 *  wait-only drained/timedOut flags and the outputTruncated flag) —
 *  served as `structuredContent` alongside the bounded text. Guest
 *  output (the capped console lines, the previewed result) and the
 *  orchestration metadata (pending/checkpoints/completed) stay
 *  separate fields: never one flat string (phase-E review rejection:
 *  the text-only result mixed them). */
function structuredEvalWait(
  action: "eval" | "wait",
  projectDir: string,
  result: ReplEvalResult,
  drained?: boolean,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    action,
    projectDir,
    output: result.output,
    outputTruncated: result.outputTruncated,
    pending: result.pending,
    checkpoints: result.checkpoints,
    completed: result.completed,
  };
  if (result.result !== undefined) structured.result = result.result;
  if (drained !== undefined) {
    structured.drained = drained;
    structured.timedOut = !drained;
  }
  return structured;
}

/** The structured status content — one entry per workspace context
 *  (the doc's workspaces surface): the workspace state (fresh /
 *  restored / refused / not opened), the restore's reconcile summary,
 *  the workspace MANIFEST (bindings with name, structure-only token,
 *  size, provenance and task — metadata, never content), the `$N`
 *  log-ref range, the live agents, the pending ops (in-flight calls,
 *  pending ids, previewed checkpoints), the child-warmth state, and a
 *  retained drain failure. Everything bounded: the checkpoint
 *  questions are previewed like the eval/wait surface, and the
 *  manifest tokens are structure-only — the structured surface never
 *  carries unbounded guest content. */
function structuredStatus(
  contexts: Array<{ projectDir: string; repl?: ReplProjectState }>,
  projectDir?: string,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    action: "status",
    workspaces: contexts.map((context) => {
      const entry: Record<string, unknown> = {
        projectDir: context.projectDir,
        state: "not-opened",
        bindings: [],
        logs: { first: null, last: null, count: 0 },
        evalSeq: 0,
        inFlight: [],
        checkpoints: [],
        liveAgents: [],
        pending: [],
        childrenClosed: false,
      };
      const state = context.repl;
      if (state === undefined) return entry;
      if (state.restoreError !== null) {
        entry.state = "refused";
        entry.restoreError = state.restoreError.message;
        return entry;
      }
      if (state.source === null) return entry;
      entry.state = state.source;
      if (state.source === "restored" && state.reconcileReport !== null) {
        entry.reconcile = state.reconcileReport;
      }
      if (state.drainError !== null) {
        entry.drainError = `${state.drainError.name}: ${state.drainError.message}`;
      }
      const broker = state.broker;
      if (broker === null) return entry;
      const manifest = broker.workspaceManifest();
      entry.bindings = manifest.bindings;
      entry.logs = manifest.logs;
      entry.evalSeq = manifest.evalSeq;
      entry.inFlight = manifest.inFlight;
      entry.checkpoints = broker.checkpointSummaries();
      entry.liveAgents = broker.liveAgents();
      entry.pending = broker.pendingCalls().map((call) => call.id);
      entry.childrenClosed = broker.isDrained;
      return entry;
    }),
  };
  if (projectDir !== undefined) structured.projectDir = projectDir;
  return structured;
}

/** Register the `repl` tool on the server. */
export function registerReplTool(mcp: McpServer, options: ReplToolOptions): void {
  const { projects, wasm, requireProjectDir } = options;
  mcp.registerTool(
    "repl",
    {
      description:
        "One persistent QuickJS-in-WASM VM per projectDir, addressed by the same project model as the workflow tool. " +
        "State (bindings, pending subagent calls, checkpoints) lives in the VM between calls and survives MCP-session " +
        "churn and daemon restarts: every eval and every settlement drain that changed state persists the workspace " +
        "to the daemon's per-project repl store, and the first touch of a stored workspace restores it and reconciles " +
        "every outstanding call (settle from the store / re-attach via ACP session/load / re-issue). A stored snapshot " +
        "that refuses (corrupt, a format upgrade, or a wasm-binary mismatch) is surfaced loudly and never silently " +
        "discarded — reset drops it and starts fresh. Subagents are ACP sessions via acp-agents (6 concurrent per " +
        "workspace); console output is captured and previewed. On last-client disconnect the workspace drains " +
        "in-flight subagent turns to completion (each settlement boundary snapshots) and closes idle children; " +
        "followUp re-attaches the subagent session lazily on the next connect. Every result carries the machine- " +
        "readable shape (see the output schema) as structuredContent alongside the bounded text.",
      inputSchema: replToolInputShape,
      outputSchema: replToolOutputShape,
    },
    async (rawArgs) => {
      if (!options.acceptingWork()) {
        throw new McpError(
          ErrorCode.InternalError,
          "Workflow server is shutting down and is no longer accepting tool calls.",
        );
      }
      // The action discriminator (the workflow tool's pattern): the MCP
      // SDK validates the primitive fields, then the discriminator
      // enforces each action's EXACT field set — `eval` without code,
      // `reset` with code, `status` with ids, `interrupt` with
      // timeoutMs, and projectDir-missing on the daemon are all
      // rejected HERE, never deferred to late handler checks (phase-E
      // review round 4).
      const input = parseReplToolInput(rawArgs as Record<string, unknown>, { requireProjectDir });
      const { action, projectDir } = input;
      // status can list every known project context without naming one
      // (both modes); the stateful actions resolve a single context.
      if (action === "status") {
        if (projectDir === undefined) {
          const contexts = projects.stores();
          return {
            structuredContent: structuredStatus(contexts),
            content: [{ type: "text", text: capToolResultText(renderStatus(contexts)) }],
          };
        }
        // A NAMED status is a first touch exactly like the other stateful
        // actions (phase-D review round 5: it used to return before
        // creating the REPL state, so on a fresh daemon whose project
        // already has a snapshot `status {projectDir}` skipped the
        // restore, the three-way reconciliation, the hash/version
        // refusal surface, and the workspace manifest). The refusal
        // (corrupt / version bump / wasm-hash mismatch) and the restore
        // report are rendered by `renderStatus` from the state.
        const context = resolveContext(options, projectDir);
        if (context === undefined) {
          return {
            structuredContent: {
              action: "status",
              projectDir,
              error: `No project context is available for projectDir "${projectDir}".`,
            },
            content: [
              {
                type: "text",
                text: `No project context is available for projectDir "${projectDir}".`,
              },
            ],
            isError: true,
          };
        }
        context.repl ??= createReplProjectState(context.projectDir);
        const state = context.repl;
        options.presence.touch(state, options.clientId() ?? "unknown");
        if (state.restoreError === null) {
          await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs);
        }
        return {
          structuredContent: structuredStatus([context], projectDir),
          content: [{ type: "text", text: capToolResultText(renderStatus([context])) }],
        };
      }
      const context = resolveContext(options, projectDir);
      if (context === undefined) {
        return {
          structuredContent: {
            action,
            projectDir,
            error: `No project context is available for projectDir "${projectDir}".`,
          },
          content: [{ type: "text", text: capToolResultText(`No project context is available for projectDir "${projectDir}".`) }],
          isError: true,
        };
      }

      // All stateful actions touch (or reset) the workspace: the session
      // is marked present on the project (the client-presence ledger —
      // its last-connection-closed signal drives the doc's drain).
      context.repl ??= createReplProjectState(context.projectDir);
      const state = context.repl;
      options.presence.touch(state, options.clientId() ?? "unknown");

      if (action === "reset") {
        await resetReplProjectState(state);
        return {
          structuredContent: { action: "reset", projectDir: context.projectDir, dropped: true },
          content: [
            {
              type: "text",
              text: capToolResultText(
                `workspace ${context.projectDir}: dropped — the VM and its stored state were reset`,
              ),
            },
          ],
        };
      }

      if (state.restoreError !== null) return refusedResult(state, action);

      await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs);
      if (state.restoreError !== null) return refusedResult(state, action);

      const broker = state.broker!;
      if (action === "eval") {
        const result = await broker.eval(input.code);
        const line = drainErrorLine(state);
        const rendered = renderEvalResult(result);
        const text = line !== null ? `${line}\n${rendered}` : rendered;
        return {
          structuredContent: structuredEvalWait("eval", context.projectDir, result),
          content: [{ type: "text", text: capToolResultText(text) }],
        };
      }
      if (action === "wait") {
        // The wait returns the SAME shape as an eval — console output
        // included (phase-D review round 2: the wait used to drop the
        // output drained by its pumps and defer it to the next eval).
        const { result, drained } = await broker.waitForCalls(input.ids, input.timeoutMs);
        const text = renderEvalResult(result);
        const line = drainErrorLine(state);
        const body = drained ? text : `${text}\n(still running — wait timed out after ${input.timeoutMs} ms)`;
        const waitText = line !== null ? `${line}\n${body}` : body;
        return {
          structuredContent: structuredEvalWait("wait", context.projectDir, result, drained),
          content: [{ type: "text", text: capToolResultText(waitText) }],
        };
      }
      // interrupt without an id: BREAK THE RUNNING EVAL — the doc's
      // "break a runaway eval (the quickjs interrupt handler)". The
      // broker's eval-break arm targets the workspace's RUNNING eval
      // (in flight — suspended on a subagent call or a checkpoint, its
      // continuation registered) and REFUSES — nothing armed — when the
      // workspace is idle (phase-E review rejection round 1: the old
      // project-wide boolean was armed even when idle, so an unrelated
      // eval consumed it before the intended continuation). The armed
      // signal is consulted by EVERY subsequent execution of the
      // running eval: the settlement drains that resume its
      // continuation (a wait's pumps — the wait releases the broker
      // chain between pumps, so this interrupt lands promptly mid-wait
      // — a later eval's pump, the client-presence drain) AND a direct
      // eval's own drain (a `checkpoint.answer` in a later eval resumes
      // the continuation synchronously inside that eval's drain —
      // phase-E review rejection round 2: the old settlement-drain-only
      // signal was blind there). The quickjs interrupt handler breaks
      // it MID-RUN, and the signal is consumed on first observation — a
      // later eval's own code is never broken by it. A fully
      // synchronous (never-yielding) runaway blocks the single-threaded
      // daemon's event loop, so the request itself cannot arrive
      // mid-run — that case is bounded by the per-eval wall-clock
      // deadline (the harness's eval guard); every eval that YIELDS is
      // interruptible at its next execution.
      if (input.id === undefined) {
        const targeted = await broker.armEvalBreak();
        if (!targeted) {
          return {
            structuredContent: {
              action: "interrupt",
              projectDir: context.projectDir,
              interrupt: { outcome: "refused-idle" },
            },
            content: [
              {
                type: "text",
                text: capToolResultText(
                  `workspace ${context.projectDir}: no running eval to interrupt — no eval is in flight, or the ` +
                    `in-flight eval awaits nothing this host can key an execution to (a local or never-settling ` +
                    `promise, or an indirect chain like Promise.all of agent calls — its settlement is the LAST ` +
                    `component's, unknowable in advance); nothing was armed`,
                ),
              },
            ],
          };
        }
        return {
          structuredContent: {
            action: "interrupt",
            projectDir: context.projectDir,
            interrupt: { outcome: "targeted" },
          },
          content: [
            {
              type: "text",
              text: capToolResultText(
                `workspace ${context.projectDir}: interrupting the running eval — the eval-break signal is set; ` +
                  `the eval's next execution (a settlement drain resuming its continuation, or a direct eval's drain) ` +
                  `is broken mid-run by the quickjs interrupt handler`,
              ),
            },
          ],
        };
      }
      const outcome = await broker.cancelCall(input.id);
      const text =
        outcome === "cancelled"
          ? `interrupt ${input.id}: ACP session/cancel sent`
          : outcome === "idle"
            ? `interrupt ${input.id}: the session was idle — nothing to cancel`
            : outcome === "failed"
              ? `interrupt ${input.id}: could not reach the backend session (lazy re-attach failed)`
              : `interrupt ${input.id}: no live session to cancel`;
      return {
        structuredContent: {
          action: "interrupt",
          projectDir: context.projectDir,
          interrupt: { outcome, callId: input.id },
        },
        content: [{ type: "text", text: capToolResultText(text) }],
      };
    },
  );
}
