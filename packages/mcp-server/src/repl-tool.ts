/**
 * The `repl` MCP tool — the eval-plane redesign's surface (the roadmap
 * bible, docs/roadmap/repl-eval-redesign.md §3): TWO actions on the
 * same enum-shaped tool the repo's `workflow` tool uses.
 *
 * - `eval { projectDir, code, timeoutMs? }` — the ONE verb. Runs `code`
 *   in the workspace VM (top-level `await` allowed; top-level `return`
 *   a syntax error; empty string valid), then HOLDS THE CALL OPEN
 *   pumping settlements server-side (the fusion of v1's eval with v1's
 *   wait pump) up to the soft bound — default 60 000 ms, per-call
 *   `timeoutMs` override, hard cap 120 000 ms. Everything the code is
 *   waiting on settles within the bound → the FINISHED shape
 *   `{ output, result? }` (`result` is the completion value's §4.4
 *   repr). The bound elapses first → the honest STILL-RUNNING shape
 *   `{ output, running: [call ids] }`; the eval continues server-side
 *   and ANY later eval — including `""`, the documented idempotent
 *   poll — drains and reports what settled. `output` is ONE
 *   newline-joined string: console lines (one per call), raised
 *   checkpoint lines (`checkpoint c9: <question>`), and uncaught-error
 *   renderings (§4.6). No `pending`/`completed`/`checkpoints`/
 *   `outputTruncated`/`truncated`/`referenced` fields exist on the
 *   wire — the budget/cap apparatus is deleted (§7); an agent CAN
 *   flood its own context, the Python posture.
 * - `interrupt { projectDir, id? }` — the one out-of-band verb: with
 *   `id`, cancel that subagent call (the guest promise rejects
 *   recoverable, `AGENT_CANCELLED` family); without `id`, break the
 *   running eval — every running eval is broken mid-run (the
 *   out-of-band eval-break channel and the quickjs interrupt handler
 *   stand as built) or, when it is suspended on nothing resumable or
 *   its continuation cannot be keyed, TERMINATED (released) outright;
 *   `refused-idle` is honest only when NOTHING is running.
 *
 * Durability is kept and hidden (§6): bindings AND in-flight subagent
 * turns survive daemon restarts exactly as before, but the ceremony
 * left the surface — a refused stored snapshot AUTO-RESETS (the file
 * is renamed aside `.refused-<ts>`, never deleted, and the next eval's
 * output leads with a loud one-line notice naming the file and the
 * reason); reconcile summaries and retained drain errors live under
 * `workspace().diagnostics`, except a restore that lost calls or a
 * drain failure that lost state, which still get a one-line notice in
 * the next eval's output (losses are never silent).
 */
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Broker, BrokerRunner, EvalBreakChannel, WasmModule } from "@automatalabs/repl-engine";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { resolveProjectDir, type WorkflowProjectRegistry, type ProjectContext } from "./project-registry.js";
import { createReplProjectState, ensureReplWorkspace, type ReplProjectState } from "./repl-project.js";
import type { ReplPresenceLedger } from "./repl-presence.js";

/** The soft-bound eval's default hold (§3.1 [D]: default 60 000 ms). */
export const DEFAULT_REPL_EVAL_BOUND_MS = 60_000;
/** The soft-bound eval's hard cap (§3.1 [D]: 120 000 ms — the same
 *  numbers v1's `wait` used). */
export const MAX_REPL_EVAL_BOUND_MS = 120_000;
/** The fused eval's re-poll interval when the suspended eval awaits
 *  nothing pumpable by call ids (a checkpoint, a sleep) — a short hold
 *  so host-timer settlements still resolve within the call; the
 *  absolute bound caps the hold. */
const REPL_EVAL_POLL_GAP_MS = 100;

export const replToolInputShape = {
  action: z
    .enum(["eval", "interrupt"])
    .describe(
      "Operation. eval runs code in the workspace's persistent VM and holds the call open pumping " +
        "settlements up to the soft bound; interrupt cancels one subagent call (by id) or breaks the " +
        "running eval (no id; honestly refused when nothing is running).",
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
    .describe(
      "The JavaScript to eval (top-level await accepted; `return` is a syntax error; console output is captured). " +
        "An empty string is valid — the documented idempotent poll: a no-op script that drains and reports " +
        "whatever settled since the last eval.",
    ),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_REPL_EVAL_BOUND_MS)
    .optional()
    .describe(
      `Bounded server-side hold for this eval (default ${DEFAULT_REPL_EVAL_BOUND_MS} ms, hard cap ${MAX_REPL_EVAL_BOUND_MS} ms): ` +
        "the call is held open pumping settlements up to the bound. Everything the code waits on settles " +
        "within the bound → the finished shape { output, result? }; the bound elapses first → the " +
        "still-running shape { output, running } with the eval continuing server-side (any later eval drains).",
    ),
  id: z
    .string()
    .optional()
    .describe(
      "The call id to cancel (interrupt action). Omitted: break the running eval (honestly refused when no eval is in flight).",
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
 *  (the workflow tool's pattern): the MCP SDK validates the primitive
 *  fields, then the discriminator enforces each action's EXACT field
 *  set — `eval` without `code`, or `interrupt` with `code`/`timeoutMs`,
 *  are both rejected at the boundary. */
export type ParsedReplToolInput =
  | { action: "eval"; projectDir?: string; code: string; timeoutMs: number }
  | { action: "interrupt"; projectDir?: string; id?: string };

/** Which fields belong to which action (the discriminator's exact-shape
 *  vocabulary — every other key is rejected at the boundary). */
const replInputFields = ["action", "projectDir", "code", "timeoutMs", "id"] as const;
type ReplInputField = (typeof replInputFields)[number];

const REPL_ACTION_FIELDS: Record<string, ReadonlySet<ReplInputField>> = {
  eval: new Set(["action", "projectDir", "code", "timeoutMs"]),
  interrupt: new Set(["action", "projectDir", "id"]),
};

function invalidReplInput(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid repl tool input: ${message}`);
}

/** Apply the action discriminator after the MCP SDK has validated the
 *  primitive fields: every action's EXACT field set is enforced here.
 *  EVERY key outside the action's set is rejected — deleted surface
 *  like the v1 `refs` parameter (and the wait/status/reset fields)
 *  fails at the boundary instead of being silently discarded, and
 *  missing required fields are rejected too. `requireProjectDir`
 *  mirrors the workflow tool's daemon-mode rule: projectDir is
 *  required for both actions there. */
export function parseReplToolInput(
  raw: Record<string, unknown>,
  options: { requireProjectDir: boolean },
): ParsedReplToolInput {
  const action = replToolInputShape.action.parse(raw.action);
  const allowed = REPL_ACTION_FIELDS[action];
  for (const field of Object.keys(raw)) {
    if (field === "action") continue;
    if (!allowed.has(field as ReplInputField)) {
      invalidReplInput(`action "${action}" cannot include ${field}`);
    }
  }
  const projectDir = raw.projectDir === undefined ? undefined : replToolInputShape.projectDir.parse(raw.projectDir);
  if (projectDir === undefined && options.requireProjectDir) {
    invalidReplInput("projectDir is required on the shared workflow daemon");
  }
  switch (action) {
    case "eval": {
      const code = replToolInputShape.code.parse(raw.code);
      if (code === undefined) {
        invalidReplInput("eval requires a code string");
      }
      // An EMPTY script is valid JavaScript AND the documented poll
      // idiom — only the ABSENT field is rejected, at the exact-shape
      // boundary.
      const timeoutMs = replToolInputShape.timeoutMs.parse(raw.timeoutMs ?? DEFAULT_REPL_EVAL_BOUND_MS)
        ?? DEFAULT_REPL_EVAL_BOUND_MS;
      return { action, projectDir, code, timeoutMs };
    }
    case "interrupt": {
      const id = raw.id === undefined ? undefined : replToolInputShape.id.parse(raw.id);
      return { action, projectDir, id };
    }
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
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid repl tool input: ${resolution.message}`);
  }
  return options.projects.getOrCreate(resolution.projectDir);
}

/** The pending one-line notices (§6.1 auto-reset, §6.2 [C]14 loss
 *  notices): each is rendered ONCE, leading the next eval's `output`,
 *  and consumed on render. */
function takeNotices(state: ReplProjectState): string[] {
  const notices: string[] = [];
  if (state.autoResetNotice !== null) {
    const { file, reason } = state.autoResetNotice;
    notices.push(
      `REPL workspace auto-reset: the stored snapshot refused (${reason}) — the file was renamed aside to ` +
        `${file} (never deleted) and a fresh workspace started`,
    );
    state.autoResetNotice = null;
  }
  notices.push(...state.lossNotices.splice(0));
  return notices;
}

/** §4.5 reset(): the reset-owning eval disposes its own broker in the
 *  operation's post-hook (AFTER the eval result was rendered). Clear the
 *  project state's live references and drop the whole repl/ store (the
 *  deleted v1 `reset` action's engine-side) so the NEXT touch creates a
 *  FRESH workspace, never a restore of the torn-down one. Returns true
 *  when a reset tore the workspace down.
 *
 *  The pending §6.1/§6.2 notices are deliberately NOT cleared here:
 *  they belong to the STORE's refusal history (the renamed-aside
 *  `.refused-*` file survives `store.reset()` — §6.1 [C]13, never
 *  deleted) and are consumed exactly once when an eval's output
 *  renders them (the review finding: the sync ran before the render,
 *  so a first-eval `reset()` after an auto-reset erased the leading
 *  refusal notice). */
function syncReplStateAfterOp(state: ReplProjectState): boolean {
  if (state.broker !== null && state.broker.isDisposed) {
    state.broker = null;
    state.workspace = null;
    state.store.reset();
    state.source = null;
    state.reconcileReport = null;
    state.drained = false;
    state.drainError = null;
    state.timedOutEvalTokens.clear();
    return true;
  }
  return false;
}

/** The interrupt action's structured outcome. */
const interruptOutcomeShape = z.object({
  outcome: z.enum(["targeted", "refused-idle", "cancelled", "idle", "failed", "none"]),
  callId: z.string().optional(),
});

/** The machine-readable output of the `repl` tool (published as the
 *  tool's `outputSchema`, mirrored by every result's
 *  `structuredContent`): the bible's §3.1 eval shape — ONE
 *  newline-joined string of the printed stream (console lines,
 *  checkpoint lines, error renderings, and the §6 notices), the
 *  completion value's repr when the code finished, the in-flight call
 *  ids when the bound elapsed. `result` and `running` are MUTUALLY
 *  EXCLUSIVE — an eval result is exactly one of the finished shape
 *  `{ output, result }`, the still-running shape `{ output, running }`,
 *  or the bare `{ output }` of an eval whose code threw (the §4.6
 *  rendering, no completion value). The interrupt variant carries the
 *  honest outcome; the error variant a structured error string.
 *  NOTHING else — the v1
 *  pending/completed/checkpoints/outputTruncated/truncated/referenced
 *  fields are deleted with the cap apparatus (§7). */
export const replToolOutputShape = z
  .object({
    output: z.string().optional(),
    result: z.string().optional(),
    running: z.array(z.string()).optional(),
    interrupt: interruptOutcomeShape.optional(),
    error: z.string().optional(),
  })
  .superRefine((value, context) => {
    const keys = new Set(Object.keys(value));
    const has = (field: string) => keys.has(field);
    const only = (...fields: string[]) => [...keys].every((key) => fields.includes(key));
    let valid: boolean;
    if (has("error")) {
      valid = only("error");
    } else if (has("interrupt")) {
      valid = only("interrupt");
    } else {
      // The eval variant: the output string is required, `result` and
      // `running` are mutually exclusive (the finished shape vs the
      // bound-elapsed shape), and nothing else rides along.
      valid = has("output") && only("output", "result", "running") && !(has("result") && has("running"));
    }
    if (!valid) {
      context.addIssue({ code: "custom", message: "output does not match a repl result variant" });
    }
  })
  .meta({
    oneOf: [
      {
        title: "eval",
        required: ["output", "result"],
        properties: { output: { type: "string" }, result: { type: "string" } },
        not: { anyOf: [{ required: ["running"] }, { required: ["interrupt"] }, { required: ["error"] }] },
      },
      {
        title: "eval-still-running",
        required: ["output", "running"],
        properties: { output: { type: "string" }, running: { type: "array", items: { type: "string" } } },
        not: { anyOf: [{ required: ["result"] }, { required: ["interrupt"] }, { required: ["error"] }] },
      },
      {
        title: "eval-error",
        required: ["output"],
        properties: { output: { type: "string" } },
        not: { anyOf: [{ required: ["result"] }, { required: ["running"] }, { required: ["interrupt"] }, { required: ["error"] }] },
      },
      {
        title: "interrupt",
        required: ["interrupt"],
        properties: { interrupt: interruptOutcomeShape },
        not: { anyOf: [{ required: ["output"] }, { required: ["result"] }, { required: ["running"] }, { required: ["error"] }] },
      },
      {
        title: "error",
        required: ["error"],
        properties: { error: { type: "string" } },
        // The runtime validator accepts ONLY the bare `error` key — the
        // published branch must mirror it exactly, so `error`+`result`
        // and `error`+`running` objects are advertised-invalid too
        // (§3.1 [C]1: the published schema mirrors the runtime shape).
        not: {
          anyOf: [
            { required: ["output"] },
            { required: ["interrupt"] },
            { required: ["result"] },
            { required: ["running"] },
          ],
        },
      },
    ],
  });

/** Assemble the eval result: the §3.1 wire shape
 *  `{ output, result?, running? }` as `structuredContent` (mirroring
 *  the published output schema exactly), plus the bounded human text —
 *  the output string, then the `result:` line, then the `running:`
 *  line. Notices (§6.1/§6.2) lead the output. */
function evalResult(
  outputLines: string[],
  result: string | undefined,
  running: string[] | undefined,
  notices: string[],
): { structuredContent: Record<string, unknown>; content: { type: "text"; text: string }[] } {
  const output = [...notices, ...outputLines].join("\n");
  const structured: Record<string, unknown> = { output };
  if (result !== undefined) structured.result = result;
  if (running !== undefined) structured.running = running;
  const textLines = [...notices, ...outputLines];
  if (result !== undefined) textLines.push(`result: ${result}`);
  if (running !== undefined) textLines.push(`running: ${running.join(", ")}`);
  return {
    structuredContent: structured,
    content: [{ type: "text", text: textLines.join("\n") }],
  };
}

/** Register the `repl` tool on the server. */
export function registerReplTool(mcp: McpServer, options: ReplToolOptions): void {
  const { projects, wasm, requireProjectDir } = options;
  mcp.registerTool(
    "repl",
    {
      description:
        "A persistent QuickJS-in-WASM JavaScript VM you drive interactively to orchestrate subagents — one VM per " +
        "projectDir, addressed by the same project model as the workflow tool. Two actions: eval runs code and " +
        "holds the call open pumping settlements; interrupt cancels one subagent call (by id) or breaks the " +
        "running eval (no id). Named bindings, pending subagent calls, raised checkpoints, and `_` (the previous " +
        "eval's completion value) PERSIST in the VM between calls — a later eval sees the same variables and awaits " +
        "the same promises. Console logging produces output text only and creates no persistent value; nothing lives " +
        "in the transcript. For deeper syntax and examples, read docs topic repl/quickstart and then one related repl/* topic. " +
        // The guest API.
        "Inside code (JavaScript; top-level await is allowed, top-level return is a syntax error; console output " +
        "is captured) the host bridge provides agent(modelSpec, task, opts?) → Promise: spawn an ACP subagent on " +
        "a registry built-in (currently Claude, Codex, OpenCode, and pi) or a registered custom agent. The spec " +
        "is \"backend/model\" (a bare \"backend\" runs its default model); an unknown backend rejects the call " +
        "immediately, naming the known backends. The opts keys are schema (a structured-output JSON schema, " +
        "validated per call), cwd, configOptions (backend-specific knobs, validated at admission), and mode. " +
        "Before setting mode, use workflow action:\"config\" for that exact modelSpec and copy only an id explicitly listed in modes.availableModes; modes:null means omit mode, never infer \"default\". " +
        "Unknown option keys reject synchronously. agent() returns a persistent promise-handle. Assign the handle " +
        "before awaiting it: `const a = agent(\"codex\", \"inspect the failure\"); const first = await a`. " +
        "a.steer(text) targets only the currently running turn. It never starts or queues another turn and resolves " +
        "\"injected\", \"idle\", or \"unsupported\"; transport and protocol failures reject. Steering while " +
        "idle returns \"idle\" and loses the instruction by design. `const q = a.queue(text)` creates a distinct " +
        "FIFO turn on the same session. q.id is available immediately, await q returns that turn's answer, and " +
        "q.cancel() or an out-of-band interrupt of q.id cancels that exact turn. Queueing works on every backend " +
        "that can continue the session; steering requires the ACP server's raw steering advertisement. Do not write " +
        "`const a = await agent(...)` when you intend to reuse the handle, because that stores only the answer. " +
        "Persistent-workspace example — first eval: `const a = agent(\"codex\", \"Investigate the parser " +
        "failure\")`; a later eval, only while agents() reports a's turn as running: `const steering = await " +
        "a.steer(\"Focus on the parser state machine\")`; after the founding answer settles: `const first = await " +
        "a; const q1 = a.queue(\"Implement the fix\"); const q2 = a.queue(\"Run the focused tests\"); " +
        "console.log(q1.id, q2.id, steering); const fixed = await q1; const tested = await q2`. " +
        "checkpoint(question) parks a promise for a human answer, resolved by checkpoint.answer(id, value) in a " +
        "later eval. parallel, pipeline, verify, judgePanel, gate, retry, " +
        "loopUntilDry, and sleep(ms) round out the guest library. Introspection is in-band: workspace() returns " +
        "{ bindings, inFlight, checkpoints, diagnostics }; agents() lists live agents with their call ids and " +
        "states; reset() tears the workspace down. `_` holds the previous eval's completion value. No fs, no " +
        "net, no timers beyond sleep. Subagents (6 concurrent per workspace) take stable ids c1, c2, … used by " +
        "interrupt and reported by agents(). " +
        // The soft-bound eval loop.
        "eval { code } runs the code, then HOLDS THE CALL OPEN pumping settlements up to a soft bound (default " +
        "60 000 ms; per-call timeoutMs override; hard cap 120 000 ms). If everything the code waits on settles " +
        "within the bound the result is the finished shape { output, result? } — output is ONE newline-joined " +
        "string (console lines, checkpoint lines like \"checkpoint c9: <question>\", error renderings), result " +
        "the completion value's repr. If the bound elapses first the result is the still-running shape " +
        "{ output, running: [call ids] } and the eval continues server-side — any later eval drains what " +
        "settled, and eval with \"\" (the empty script) is the documented idempotent poll: it re-executes " +
        "nothing, only reports. " +
        // Durability (kept, hidden) + §5 hygiene.
        "State survives MCP-session churn and daemon restarts: every eval and every settlement drain that " +
        "changed state persists the workspace to the daemon's per-project repl store, and the first touch of a " +
        "stored workspace restores it and reconciles every outstanding call. A stored snapshot that refuses " +
        "(corrupt, a format upgrade, a wasm-binary mismatch) AUTO-RESETS — the file is renamed aside, never " +
        "deleted, and the next eval's output leads with a notice naming the file and reason. Reconcile reports " +
        "and drain errors live in workspace().diagnostics. On last-client disconnect the workspace drains " +
        "in-flight subagent turns to completion and closes idle children; the next eligible queued turn re-attaches " +
        "its founding session lazily. Subagent " +
        "output passes through UNFILTERED — backend harness noise (e.g. codex's \"Warning: Skill descriptions " +
        "were shortened…\") is forwarded verbatim, never curated away. Every result carries the machine-readable " +
        "shape (see the output schema) as structuredContent alongside the human text.",
      // STRICT at the wire too: the MCP SDK strips unknown keys from a
      // non-strict object schema before the handler runs, so a deleted
      // surface like `refs` would be silently discarded instead of
      // rejected. The strict schema makes the wire fail on EVERY key
      // outside the two actions' exact sets (§3.3 [C]4 / §7).
      inputSchema: z.object(replToolInputShape).strict(),
      outputSchema: replToolOutputShape,
    },
    async (rawArgs) => {
      if (!options.acceptingWork()) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Workflow server is shutting down and is no longer accepting tool calls.",
        );
      }
      // The action discriminator (the workflow tool's pattern): the MCP
      // SDK validates the primitive fields, then the discriminator
      // enforces each action's EXACT field set — `eval` without code,
      // `interrupt` with code/timeoutMs, and projectDir-missing on the
      // daemon are all rejected HERE, never deferred to late handler
      // checks.
      const input = parseReplToolInput(rawArgs as Record<string, unknown>, { requireProjectDir });
      const { action, projectDir } = input;
      const context = resolveContext(options, projectDir);
      if (context === undefined) {
        return {
          structuredContent: {
            error: `No project context is available for projectDir "${projectDir}".`,
          },
          content: [{ type: "text", text: `No project context is available for projectDir "${projectDir}".` }],
          isError: true,
        };
      }

      // All actions touch the workspace: the session is marked present
      // on the project (the client-presence ledger — its
      // last-connection-closed signal drives the doc's drain).
      context.repl ??= createReplProjectState(context.projectDir);
      const state = context.repl;
      options.presence.touch(state, options.clientId() ?? "unknown");

      // The first touch (restore + reconcile, or the §6.1 auto-reset of
      // a refused snapshot) happens on BOTH actions — an interrupt on a
      // restored workspace must be able to target the restored suspended
      // eval. The auto-reset/loss notices stay pending: only the next
      // EVAL's output carries them.
      await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs, options.evalBreakChannel);
      const broker = state.broker!;

      if (action === "interrupt") {
        return handleInterrupt(options, context.projectDir, broker, input);
      }

      // ── eval: the soft-bound fused pump ────────────────────────────
      const bound = Math.min(input.timeoutMs, MAX_REPL_EVAL_BOUND_MS);
      const deadline = Date.now() + bound;
      let evalOutcome: Awaited<ReturnType<Broker["eval"]>>;
      try {
        evalOutcome = await broker.eval(input.code);
      } catch (error) {
        // A reset-owning eval that completed during this eval's pump
        // tears the workspace down BEFORE the submitted code runs (the
        // engine's documented order) — clear the state so the NEXT
        // touch re-creates, and surface the honest failure. The pending
        // notices stay on the state: no output was rendered to consume
        // them, so the NEXT eval still leads with them.
        syncReplStateAfterOp(state);
        throw error;
      }
      // A reset-owning eval disposes the broker and the post-op sync
      // tears the store down; the eval result may still need to render
      // below (the renamed `.refused-*` file survives the store reset —
      // §6.1 [C]13).
      syncReplStateAfterOp(state);
      const outputLines = [...evalOutcome.output];
      let finalResult: string | undefined;
      let finalRunning: string[] | undefined;
      if (evalOutcome.kind !== "pending") {
        // Finished in-eval: a value (its repr in `result`) or an error
        // (the §4.6 rendering in `output`). Nothing the code waits on
        // remains — the finished shape ships immediately.
        finalResult = evalOutcome.result;
        if (input.code === "") {
          // The empty eval IS the documented idempotent poll (§3.1
          // [C]3): its own completion is the guest `undefined` (repr
          // "undefined") — and a previous eval that timed out may have
          // settled in the meantime, its completion value swept under
          // that eval's token. Claim the oldest such settlement: the
          // poll reports the drained late value instead of its own
          // empty-script undefined. A claimed `error` settlement's
          // rendering already drained into `output` — the poll keeps
          // its own undefined result then.
          const swept = broker.claimSweptEvalSettlement(state.timedOutEvalTokens);
          if (swept !== undefined) {
            state.timedOutEvalTokens.delete(swept.token);
            if (swept.kind === "value" && swept.result !== undefined) {
              finalResult = swept.result;
            }
          }
        }
      } else {
        // Suspended: hold the call open pumping settlements up to the
        // bound. Each wait is passed the ids KNOWN to be pending at ITS
        // entry (the eval's own suspension surface first, then each
        // wait's last pending read), so a continuation that dispatches
        // more calls is chased within the same call; a suspended eval
        // awaiting nothing pumpable by call ids (a checkpoint, a sleep,
        // a local promise) is re-polled on a short gap so host-timer
        // settlements still resolve in-call. The wait's token-keyed seam
        // reports exactly THIS eval's completion. Passing the KNOWN ids
        // (never the ids-omitted form) also keeps the still-running shape
        // honest under chain contention: a concurrent serialized
        // operation that holds the broker through the whole remaining
        // bound makes the broker's pending surface UNREADABLE (it would
        // read empty) — the known in-flight ids stay reported, never
        // replaced by an empty guess (§3.1 [D]3/[C]1).
        let lastRunning = evalOutcome.pending;
        let finished = false;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          let waitResult: Awaited<ReturnType<Broker["waitForCalls"]>>["result"];
          let drained: boolean;
          try {
            const waited = await broker.waitForCalls(lastRunning, remaining, evalOutcome.evalToken);
            waitResult = waited.result;
            drained = waited.drained;
          } catch (error) {
            // A concurrent reset tore the broker down mid-hold — clear the
            // state so the next touch re-creates, and surface the honest
            // failure. The pending §6.1/§6.2 notices are NOT taken yet
            // (they are consumed only when a result that carries them is
            // actually returned — review finding): they stay on the state
            // so the next successful eval still leads with them.
            syncReplStateAfterOp(state);
            throw error;
          }
          outputLines.push(...waitResult.output);
          lastRunning = waitResult.pending;
          if (syncReplStateAfterOp(state) && waitResult.kind === "pending") {
            // A reset() tore the workspace down mid-hold (this eval's own
            // reset completed — or a concurrent client's): the workspace
            // is gone; report the honest still-running shape and let the
            // next touch re-create.
            break;
          }
          if (waitResult.kind !== "pending") {
            // The eval's continuation completed during the pumps — the
            // finished shape with its completion repr (or the late error
            // rendering already in the output lines).
            finalResult = waitResult.result;
            finished = true;
            break;
          }
          if (Date.now() >= deadline) break;
          if (waitResult.pending.length === 0 || !drained) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(REPL_EVAL_POLL_GAP_MS, deadline - Date.now())));
            if (Date.now() >= deadline) break;
          }
          // `drained` with pending ids left: the continuation dispatched
          // more calls — chase them within the remaining bound.
        }
        if (!finished) {
          // The bound elapsed first: the honest still-running shape. The
          // eval continues server-side; any later eval (including `""`)
          // drains what settled. Its continuation token joins the poll
          // seam: when the eval settles later, a subsequent empty eval
          // claims the swept settlement under this token and reports the
          // late completion value as ITS `result` (§3.1 [C]3).
          if (evalOutcome.evalToken !== undefined) {
            state.timedOutEvalTokens.add(evalOutcome.evalToken);
          }
          finalRunning = lastRunning;
        }
      }
      // §6.1/§6.2: the pending notices are consumed ONLY here, at the
      // single point a result that carries them is built — a
      // `waitForCalls` failure (or any other throwing path) above
      // renders NO eval result, so the notices stay on the state and
      // the NEXT successful eval still leads with them (review
      // finding: taking them before the held settlement pump lost them
      // on the pump's throwing path).
      const notices = takeNotices(state);
      return evalResult(outputLines, finalResult, finalRunning, notices);
    },
  );
}

/** The interrupt action (§3.2, unchanged from v1): with `id`, cancel
 *  that subagent call; without `id`, BREAK THE RUNNING EVAL through the
 *  broker's eval-break arm (suspended evals) and the OUT-OF-BAND
 *  eval-break channel (a synchronous runaway blocking the daemon's
 *  event loop — the MCP shim fires the worker-thread relay before
 *  forwarding, and the running eval's quickjs interrupt handler
 *  consumes the break flag mid-execution). Honest `refused-idle` when
 *  nothing is running. */
async function handleInterrupt(
  options: ReplToolOptions,
  projectDir: string,
  broker: Broker,
  input: Extract<ParsedReplToolInput, { action: "interrupt" }>,
): Promise<{ structuredContent: Record<string, unknown>; content: { type: "text"; text: string }[] }> {
  if (input.id === undefined) {
    const targeted = await broker.armEvalBreak();
    options.evalBreakChannel?.clearBreak(projectDir);
    // The honest out-of-band outcome: the running eval broke via the
    // relay while the daemon was blocked (the break's delivery record —
    // the `armEvalBreak` refusal above is expected for a SYNC eval,
    // which is never continuation-tracked). The record is consumed on
    // read, so a later interrupt never inherits an earlier break's
    // delivery.
    if (!targeted && broker.consumeOutOfBandBreakReport() !== null) {
      return {
        structuredContent: {
          interrupt: { outcome: "targeted" },
        },
        content: [
          {
            type: "text",
            text:
              `workspace ${projectDir}: the running eval was broken OUT OF BAND — the relay delivered ` +
              `the break while the daemon's main thread was blocked in the eval, and the quickjs interrupt ` +
              `handler broke it mid-run`,
          },
        ],
      };
    }
    if (!targeted) {
      return {
        structuredContent: {
          interrupt: { outcome: "refused-idle" },
        },
        content: [
          {
            type: "text",
            text:
              `workspace ${projectDir}: no running eval to interrupt — no eval is in flight; nothing was armed`,
          },
        ],
      };
    }
    return {
      structuredContent: {
        interrupt: { outcome: "targeted" },
      },
      content: [
        {
          type: "text",
          text:
            `workspace ${projectDir}: interrupting the running eval — the eval-break signal is set and the eval's next ` +
            `execution (a settlement drain resuming its continuation, or a direct eval's drain) is broken mid-run by the ` +
            `quickjs interrupt handler; an eval suspended on nothing resumable (a never-settling local promise) is ` +
            `terminated outright — its tracked continuation is released immediately`,
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
      interrupt: { outcome, callId: input.id },
    },
    content: [{ type: "text", text }],
  };
}
