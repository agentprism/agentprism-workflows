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
 *   request itself cannot be PROCESSED mid-run — phase-F review round 2:
 *   the out-of-band eval-break channel closes exactly that gap (the MCP
 *   shim fires the relay — a worker thread — before forwarding, and the
 *   running eval's quickjs interrupt handler consumes the break flag
 *   mid-execution; see `src/eval-break-channel.ts` in repl-engine); the
 *   per-eval wall-clock deadline (the harness's eval guard) remains the
 *   last-resort bound. Every eval that YIELDS (suspends on a call) is
 *   interruptible at its next execution, and the wait tool's pumps run
 *   with the broker chain released between them so an interrupt lands
 *   promptly mid-wait.
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
import type { BrokerRunner, EvalBreakChannel, WasmModule } from "@automatalabs/repl-engine";
import type { ReplEvalResult } from "@automatalabs/repl-engine";
import { capFinalText, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "@automatalabs/repl-engine";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { resolveProjectDir, type WorkflowProjectRegistry, type ProjectContext } from "./project-registry.js";
import {
  createReplProjectState,
  ensureReplWorkspace,
  resetReplProjectState,
  TruncationRefStore,
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
    .describe("The JavaScript to eval (top-level await accepted; `return` is a syntax error; console output is captured). " +
      "An empty string is valid JavaScript and resolves with `undefined` (the normal resolved eval shape)."),
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
  refs: z
    .array(z.string())
    .optional()
    .describe(
      "Continuation refs to read back (eval/wait/status): the truncated record's ref ids from an earlier result — " +
        "the snapshot of the entries the structured-output cap elided (pending ids, checkpoint questions, " +
        "completion ids, status metadata). The result carries them under `referenced` — the cap costs reads, " +
        "never data.",
    ),
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
  /** The OUT-OF-BAND eval-break channel (phase-F review round 2; see
   *  repl-engine's `EvalBreakChannel`): the worker-thread relay the MCP
   *  shim fires while the daemon's main thread is blocked in a
   *  synchronous eval, so the interrupt tool's no-id path breaks the
   *  eval mid-run instead of waiting for the per-eval deadline. The
   *  server always wires one — the daemon passes its own, and
   *  single-project servers own one by default (round 3) whose relay
   *  the stdio transport's worker-reader fires (see
   *  `repl-stdio-transport.ts`). */
  evalBreakChannel?: EvalBreakChannel;
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
  | { action: "eval"; projectDir?: string; code: string; refs?: string[] }
  | { action: "wait"; projectDir?: string; ids?: string[]; timeoutMs: number; refs?: string[] }
  | { action: "status"; projectDir?: string; refs?: string[] }
  | { action: "interrupt"; projectDir?: string; id?: string }
  | { action: "reset"; projectDir?: string };

/** Which fields belong to which action (the discriminator's exact-shape
 *  vocabulary). */
const replInputFields = ["action", "projectDir", "code", "ids", "timeoutMs", "id", "refs"] as const;
type ReplInputField = (typeof replInputFields)[number];

const REPL_ACTION_FIELDS: Record<string, ReadonlySet<ReplInputField>> = {
  eval: new Set(["action", "projectDir", "code", "refs"]),
  wait: new Set(["action", "projectDir", "ids", "timeoutMs", "refs"]),
  status: new Set(["action", "projectDir", "refs"]),
  interrupt: new Set(["action", "projectDir", "id"]),
  reset: new Set(["action", "projectDir"]),
};

function invalidReplInput(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Invalid repl tool input: ${message}`);
}

/** The optional `refs` read-back list (eval/wait/status), validated
 *  and deduplicated. */
function parseRefs(raw: Record<string, unknown>): string[] | undefined {
  if (raw.refs === undefined) return undefined;
  const refs = replToolInputShape.refs.parse(raw.refs) ?? [];
  return refs.length > 0 ? [...new Set(refs)] : undefined;
}

/** The tool handler's `refs` resolution: read each requested ref from
 *  the given contexts' truncation-reference stores (the elided
 *  entries' snapshots — see `capStructuredResult`). Refs are
 *  WORKSPACE-NAMESPACED (`<project-key>:t<seq>` — phase-F review round
 *  3), so each ref resolves in exactly the store that advertised it:
 *  the projectless-status search can never substitute another
 *  project's data (the id's namespace prefix only exists in the owning
 *  workspace's store). Unknown refs are skipped (a foreign namespace,
 *  or a ref from a reset workspace — the caller re-reads current
 *  state and gets fresh refs). */
function resolveRefs(
  refs: string[] | undefined,
  contexts: Array<{ projectDir: string; repl?: ReplProjectState }>,
): Record<string, unknown[]> | undefined {
  if (refs === undefined) return undefined;
  const referenced: Record<string, unknown[]> = {};
  for (const ref of refs) {
    for (const context of contexts) {
      const values = context.repl?.truncationRefs.get(ref);
      if (values !== undefined) {
        referenced[ref] = values;
        break;
      }
    }
  }
  return Object.keys(referenced).length > 0 ? referenced : undefined;
}

/** The elision-capture store for a multi-context result (the
 *  projectDir-less status): the FIRST workspace's store — its elided
 *  entries' refs are found by the same `resolveRefs` search (the refs
 *  are namespaced to that workspace, and the snapshot is exactly the
 *  merged-status entries the result elided). When no workspace state
 *  exists yet, the elisions degrade to plain counts (nothing was ever
 *  readable anyway). */
function stateRefStoreOf(
  contexts: Array<{ projectDir: string; repl?: ReplProjectState }>,
): TruncationRefStore | undefined {
  for (const context of contexts) {
    if (context.repl !== undefined) return context.repl.truncationRefs;
  }
  return undefined;
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
      if (code === undefined) {
        invalidReplInput('eval requires a code string');
      }
      // An EMPTY script is valid JavaScript (the doc's `eval { projectDir,
      // code }` has no non-empty restriction): it resolves with `undefined`
      // and returns the normal resolved eval shape (phase-E review round
      // 5: the tool invented a non-empty-code restriction absent from the
      // doc). Only the ABSENT field is rejected, at the exact-shape
      // boundary.
      return { action, projectDir, code, refs: parseRefs(raw) };
    }
    case "wait": {
      const ids = raw.ids === undefined ? undefined : replToolInputShape.ids.parse(raw.ids);
      const timeoutMs = replToolInputShape.timeoutMs.parse(raw.timeoutMs ?? 30_000) ?? 30_000;
      return { action, projectDir, ids, timeoutMs, refs: parseRefs(raw) };
    }
    case "status":
      return { action, projectDir, refs: parseRefs(raw) };
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
  "truncated",
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

/** Which structured fields the aggregate result cap elided, with the
 *  ELIDED entry counts (present only when elision happened): each key
 *  is the elided field's path in the structured shape (`pending`,
 *  `completed`, `checkpoints`, `output`, `bindings`, `liveAgents`,
 *  `inFlight`, `workspaces[0].reconcile.requeuedCheckpoints`, …) and
 *  its value the number of entries dropped — the kept HEAD prefix
 *  remains, so the true totals are kept + elided. `strings` counts
 *  string fields the backstop elided. Elision is never silent (the
 *  phase-E review round 4 registry-read defect was a silent undefined
 *  hole). */
const truncatedShape = z.record(
  z.string(),
  z.union([
    // The string backstop's elision count (`truncated.strings`).
    z.number().int().positive(),
    // An elided array's continuation reference (phase-F review round
    // 2): the dropped tail's entry count plus the ref id that a later
    // eval/wait/status call's `refs` parameter reads back — the cap
    // costs reads, never data.
    z.object({ elided: z.number().int().positive(), ref: z.string() }),
  ]),
);

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
 *  tokens — and the whole structured result is bounded AGAIN at the
 *  tool seam by the aggregate serialized-size cap (10 KB, the same
 *  bound as the text; every elision flagged in the `truncated`
 *  record, phase-E review round 8: the structured surface used to
 *  cross the wire uncapped — a 20,000-character modelSpec, 16,500
 *  pending ids — while only the text was capped). The text content
 *  stays alongside (the bounded human rendering, capped at 256 lines /
 *  10 KB). */
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
    // The aggregate structured-result cap's elision record (present
    // only when the serialized result crossed the doc's 10 KB bound):
    // a path-keyed record that serves every variant (`pending`,
    // `checkpoints`, `workspaces[0].reconcile.requeuedCheckpoints`, …)
    // with the elided entry counts — the kept head prefix plus the
    // record always reconciles to the true totals — and each elided
    // array's CONTINUATION REF (phase-F review round 2): the dropped
    // tail's snapshot id, readable back through the `refs` parameter of
    // a later eval/wait/status call (`referenced` in the result). The
    // cap costs reads, never data.
    truncated: truncatedShape.optional(),
    // The referenced continuation values (phase-F review round 2): the
    // `refs` parameter's read-back — `{ [refId]: values }` for every
    // requested ref the workspace's truncation-reference store holds
    // (the dropped entries of an earlier elision, verbatim).
    referenced: z.record(z.string(), z.array(z.unknown())).optional(),
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
        only("projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "truncated", "referenced") &&
        hasAll("projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed");
    } else if (value.action === "wait") {
      valid =
        only("projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "drained", "timedOut", "truncated", "referenced") &&
        hasAll("projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed", "drained", "timedOut");
    } else if (value.action === "status") {
      valid = only("projectDir", "workspaces", "truncated", "referenced") && has("workspaces");
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
        ...forbidsOutside(["action", "projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "truncated", "referenced"]),
      },
      {
        title: "wait",
        required: ["action", "projectDir", "output", "outputTruncated", "pending", "checkpoints", "completed", "drained", "timedOut"],
        properties: { action: { const: "wait" } },
        ...forbidsOutside(["action", "projectDir", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "drained", "timedOut", "truncated", "referenced"]),
      },
      {
        title: "status",
        required: ["action", "workspaces"],
        properties: { action: { const: "status" } },
        ...forbidsOutside(["action", "projectDir", "workspaces", "truncated", "referenced"]),
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
  `values remain reachable through their $N refs, and every elided structured field through its truncated ` +
  `record's continuation ref — read it back with the refs parameter)`;

/** The aggregate serialized-size bound for `structuredContent`: the
 *  doc's tool-result cap (10 KB) applies to the MACHINE-READABLE
 *  surface too, not only the bounded text (phase-E review rejection
 *  round 7: the structured results were uncapped — a 20,000-character
 *  modelSpec crossed status as a >20 KB live-agent entry and 16,500
 *  pending ids crossed the wire as an ~80 KB array — while only the
 *  text content was capped). Same decimal 10 KB unit as the text cap. */
const STRUCTURED_MAX_BYTES = OUTPUT_MAX_BYTES;


/** The backstop string bound for the structured cap: head+tail elision
 *  at the manifest-task vocabulary (200 chars — the same bound the
 *  engine seam applies to task/modelSpec). Only reachable when a
 *  single array ELEMENT is itself over the aggregate bound (a
 *  pathological guest-controlled string that survives the array
 *  elision, since a one-element array cannot be halved). */
const STRUCTURED_STRING_MAX = 200;

/** The serialized UTF-8 size of a JSON-able structured value. */
function structuredBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** The largest ELIGIBLE array in a structured result tree (by
 *  serialized bytes), with its path. `eligible` decides which arrays
 *  the current pass may elide (the halving pass: lists with ≥ 2
 *  entries; the absolute-guarantee pass: any list except the status
 *  `workspaces` container). Descends into array ELEMENTS too: the
 *  nested id lists inside a workspace entry are separate elidable
 *  arrays — without the descent, a single-element CONTAINER list
 *  (the status `workspaces` entry holds every other list) would be
 *  the largest candidate, unhaleable, and block the pass (phase-E
 *  review round 8: the cap used to give up and then EMPTY the
 *  workspaces container in the guarantee pass, shipping a status
 *  with zero workspace entries). */
function largestStructuredArray(
  node: unknown,
  path: (string | number)[],
  best: { path: (string | number)[]; value: unknown[]; bytes: number } | null,
  eligible: (path: (string | number)[], length: number) => boolean,
): { path: (string | number)[]; value: unknown[]; bytes: number } | null {
  if (Array.isArray(node)) {
    if (eligible(path, node.length)) {
      const bytes = structuredBytes(node);
      if (best === null || bytes > best.bytes) best = { path, value: node, bytes };
    }
    for (let i = 0; i < node.length; i++) {
      best = largestStructuredArray(node[i], [...path, i], best, eligible);
    }
    return best;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      best = largestStructuredArray(value, [...path, key], best, eligible);
    }
  }
  return best;
}

/** Replace the value at a path inside a structured result. */
function setStructuredPath(node: unknown, path: (string | number)[], value: unknown): void {
  let cursor = node as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i] as string] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}

/** A structured path's flag key: `workspaces[0].pending` style. */
function structuredPathKey(path: (string | number)[]): string {
  let key = '';
  for (const part of path) {
    if (typeof part === 'number') key += `[${part}]`;
    else key += key === '' ? part : `.${part}`;
  }
  return key;
}

/** Head+tail string elision with the ellipsis marker (the preview
 *  format's shape). */
function structuredHeadTail(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Cap every string in a structured result head+tail at `max` chars —
 *  the backstop for a single array element that is itself over the
 *  aggregate bound. Strings are immutable, so the walk mutates the
 *  CONTAINERS (array slots / object properties) in place. Returns the
 *  number of strings elided (recorded under `truncated.strings`). */
function capStructuredStrings(node: unknown, max: number): number {
  let elided = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === 'string') {
        if (item.length > max) {
          node[i] = structuredHeadTail(item, max);
          elided++;
        }
      } else {
        elided += capStructuredStrings(item, max);
      }
    }
    return elided;
  }
  if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === 'string') {
        if (value.length > max) {
          record[key] = structuredHeadTail(value, max);
          elided++;
        }
      } else {
        elided += capStructuredStrings(value, max);
      }
    }
  }
  return elided;
}

/** Apply the aggregate structured-result cap (see
 *  `STRUCTURED_MAX_BYTES`): while the serialized result exceeds the
 *  bound, elide the largest halvable array field (head prefix kept),
 *  then — only when a single oversized ELEMENT still crosses the bound
 *  (a pathological guest string that cannot be halved away) — cap every
 *  remaining string head+tail at the manifest-task bound, and as the
 *  absolute guarantee drop the remaining id-list entries (the arrays
 *  stay present, empty; the status `workspaces` container is never
 *  emptied). Every drop is recorded in the `truncated` record (field
 *  path → `{ elided, ref }` — the elided entry count plus the
 *  continuation ref that reads the dropped entries back, phase-F review
 *  round 2: the old record kept only counts, so the omitted values had
 *  no address and repeated reads could never recover them; the doc's
 *  "the cap costs reads, never data" now holds for every omitted
 *  field; `truncated.strings` stays a plain count for the string
 *  backstop) — elision is explicit, never a silent hole (the
 *  phase-E review round 4 registry-read defect was a silent undefined
 *  hole). Results that fit the bound are returned untouched. Applied to
 *  the eval / wait / status variants (the output-bearing surfaces); the
 *  interrupt / reset / error variants carry only broker-authored
 *  scalar fields and are left as-is. Exported for the truncation-ref
 *  unit tests. */
export function capStructuredResult(
  result: Record<string, unknown>,
  truncationRefs?: TruncationRefStore,
): Record<string, unknown> {
  // Deep-clone first: the structured trees share broker-owned objects
  // (the reconcile report, the manifest) — elision must never mutate
  // broker state.
  result = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  const truncated: Record<string, unknown> = {};
  const fits = () => structuredBytes({ ...result, truncated }) <= STRUCTURED_MAX_BYTES;
  if (fits()) return result;
  // The dropped entries' snapshot under a store-global ref id (the
  // sequence never resets, so a chained read's fresh refs never
  // collide with earlier ids; see `TruncationRefStore`).
  const capture = (dropped: unknown[]): string =>
    truncationRefs === undefined ? '' : truncationRefs.set(dropped);
  // Pass 1 — the halving pass: elide the largest list with ≥ 2
  // entries (a one-entry list cannot be halved; the container lists
  // like `workspaces` hold the payload and are never preferred over
  // the lists inside them). The dropped TAIL is snapshotted under the
  // continuation ref.
  const recordElision = (key: string, dropped: unknown[]): void => {
    const prior = truncated[key];
    // ROUND 3 — the continuation ref is CUMULATIVE: a repeated halving
    // of the same field used to overwrite the prior ref with a ref
    // holding only the LATEST dropped chunk, so the earlier tails
    // (including the largest first drop) became undiscoverable —
    // contradicting "the cap costs reads, never data". Each new
    // elision's snapshot now chains the field's previously dropped
    // values ahead of the new chunk, so the latest advertised ref
    // addresses the WHOLE dropped tail; earlier refs stay readable
    // too (the store never evicts — see `TruncationRefStore`).
    const priorRef =
      typeof prior === 'object' && prior !== null ? (prior as { ref?: string }).ref : undefined;
    const priorValues =
      priorRef !== undefined && truncationRefs !== undefined
        ? truncationRefs.get(priorRef)
        : undefined;
    // ROUND 4 — the chained snapshot preserves the ORIGINAL verbatim
    // order: the halving pass always drops from the CURRENT array's
    // tail, and the current array is the kept prefix of the previous
    // one, so the newest dropped chunk precedes every previously
    // dropped chunk in the ORIGINAL array. The old accumulation
    // (`[...priorValues, ...dropped]`) concatenated the chunks in
    // reverse order — after dropping [4…7] and then [2…3] the
    // advertised ref held [4…7,2…3] instead of the verbatim tail
    // [2…7] the output contract promises.
    const accumulated = priorValues !== undefined ? [...dropped, ...priorValues] : dropped;
    const ref = capture(accumulated);
    const priorElided =
      typeof prior === 'object' && prior !== null
        ? (prior as { elided: number }).elided
        : typeof prior === 'number'
          ? prior
          : 0;
    truncated[key] =
      ref === '' ? priorElided + dropped.length : { elided: priorElided + dropped.length, ref };
  };
  for (;;) {
    if (fits()) break;
    const largest = largestStructuredArray(result, [], null, (_path, length) => length >= 2);
    if (largest === null) break;
    const kept = Math.floor(largest.value.length / 2);
    const dropped = largest.value.slice(kept);
    setStructuredPath(result, largest.path, largest.value.slice(0, kept));
    recordElision(structuredPathKey(largest.path), dropped);
  }
  // Pass 2 — the string backstop: a single array element that is
  // itself over the aggregate bound (a pathological guest string that
  // survives the halving pass).
  if (!fits()) {
    const stringElisions = capStructuredStrings(result, STRUCTURED_STRING_MAX);
    if (stringElisions > 0) truncated.strings = stringElisions;
  }
  // Pass 3 — the absolute guarantee: drop the remaining list entries
  // (the arrays stay present — empty — and every drop is counted and
  // referenced). The status `workspaces` container is never emptied:
  // its entries are the payload, and their internal lists were already
  // dropped.
  if (!fits()) {
    for (;;) {
      const largest = largestStructuredArray(
        result,
        [],
        null,
        (path) => !(path.length === 1 && path[0] === 'workspaces'),
      );
      if (largest === null) break;
      const dropped = largest.value;
      setStructuredPath(result, largest.path, []);
      recordElision(structuredPathKey(largest.path), dropped);
      if (fits()) break;
    }
  }
  if (Object.keys(truncated).length > 0) result.truncated = truncated;
  return result;
}

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
          const structured = structuredStatus(contexts);
          const referenced = resolveRefs(input.refs, contexts);
          if (referenced !== undefined) structured.referenced = referenced;
          return {
            structuredContent: capStructuredResult(structured, stateRefStoreOf(contexts)),
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
          await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs, options.evalBreakChannel);
        }
        return {
          structuredContent: capStructuredResult(
            (() => {
              const structured = structuredStatus([context], projectDir);
              const referenced = resolveRefs(input.refs, [context]);
              if (referenced !== undefined) structured.referenced = referenced;
              return structured;
            })(),
            state.truncationRefs,
          ),
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
        // A stale out-of-band break flag must not survive into the fresh
        // workspace (a pipelined interrupt + reset could otherwise break
        // the reset's first eval).
        options.evalBreakChannel?.clearBreak(context.projectDir);
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

      await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs, options.evalBreakChannel);
      if (state.restoreError !== null) return refusedResult(state, action);

      const broker = state.broker!;
      if (action === "eval") {
        const result = await broker.eval(input.code);
        const line = drainErrorLine(state);
        const rendered = renderEvalResult(result);
        const text = line !== null ? `${line}\n${rendered}` : rendered;
        const structured = structuredEvalWait("eval", context.projectDir, result);
        const referenced = resolveRefs(input.refs, [context]);
        if (referenced !== undefined) structured.referenced = referenced;
        return {
          structuredContent: capStructuredResult(structured, state.truncationRefs),
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
        const structured = structuredEvalWait("wait", context.projectDir, result, drained);
        const referenced = resolveRefs(input.refs, [context]);
        if (referenced !== undefined) structured.referenced = referenced;
        return {
          structuredContent: capStructuredResult(structured, state.truncationRefs),
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
      // later eval's own code is never broken by it.
      //
      // A fully synchronous (never-yielding) runaway blocks the
      // single-threaded daemon's event loop, so the request itself
      // cannot arrive mid-run — phase-F review round 2: the OUT-OF-BAND
      // eval-break channel closes exactly that gap. The MCP shim fires
      // the channel's relay (a worker thread — reachable while the main
      // thread is wedged) BEFORE forwarding this request; the relay
      // arms a shared-memory flag that the running eval's quickjs
      // interrupt handler consumes mid-execution (the arm-after-start
      // rule: a stale break never touches a later eval). By the time
      // this handler runs (the daemon unblocked — the eval either broke
      // or finished), the flag is cleared here (the continuation-
      // targeted signal owns the break from now on) and the broker's
      // out-of-band break counter reports whether the relay actually
      // broke the running eval.
      if (input.id === undefined) {
        const targeted = await broker.armEvalBreak();
        options.evalBreakChannel?.clearBreak(context.projectDir);
        // The honest out-of-band outcome: the running eval broke via
        // the relay while the daemon was blocked (the break's delivery
        // record — the `armEvalBreak` refusal above is expected for a
        // SYNC eval, which is never continuation-tracked). The record
        // is consumed on read, so a later interrupt never inherits an
        // earlier break's delivery.
        if (!targeted && broker.consumeOutOfBandBreakReport() !== null) {
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
                  `workspace ${context.projectDir}: the running eval was broken OUT OF BAND — the relay delivered ` +
                    `the break while the daemon's main thread was blocked in the eval, and the quickjs interrupt ` +
                    `handler broke it mid-run`,
                ),
              },
            ],
          };
        }
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
                  `workspace ${context.projectDir}: no running eval to interrupt — no eval is in flight, the ` +
                    `in-flight evals await nothing this host can key an execution to (a never-settling local ` +
                    `promise — no pending host call's settlement can ever resume it), or the resident guest ` +
                    `library predates the continuation-lease seam (a restored older snapshot); nothing was armed`,
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
