/**
 * The `repl` MCP tool — the roadmap doc's Surface section: "One `repl`
 * tool, action-enum shaped — the same pattern as this repo's `workflow`
 * MCP tool. Workspaces follow the daemon's project model exactly."
 *
 * Actions:
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

/** The contained-refusal result (a refused snapshot, surfaced loudly). */
function refusedResult(state: ReplProjectState): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  const error = state.restoreError!;
  return {
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
    const checkpoints = broker.pendingCheckpoints();
    for (const checkpoint of checkpoints) {
      lines.push(`checkpoint ${checkpoint.id}: ${checkpoint.question}`);
    }
  }
  return lines.join("\n");
}

/** Register the `repl` tool on the server. */
export function registerReplTool(mcp: McpServer, options: ReplToolOptions): void {
  const { projects, wasm, requireProjectDir } = options;
  mcp.tool(
    "repl",
    "One persistent QuickJS-in-WASM VM per projectDir, addressed by the same project model as the workflow tool. " +
      "State (bindings, pending subagent calls, checkpoints) lives in the VM between calls and survives MCP-session " +
      "churn and daemon restarts: every eval and every settlement drain that changed state persists the workspace " +
      "to the daemon's per-project repl store, and the first touch of a stored workspace restores it and reconciles " +
      "every outstanding call (settle from the store / re-attach via ACP session/load / re-issue). A stored snapshot " +
      "that refuses (corrupt, a format upgrade, or a wasm-binary mismatch) is surfaced loudly and never silently " +
      "discarded — reset drops it and starts fresh. Subagents are ACP sessions via acp-agents (6 concurrent per " +
      "workspace); console output is captured and previewed. On last-client disconnect the workspace drains " +
      "in-flight subagent turns to completion (each settlement boundary snapshots) and closes idle children; " +
      "followUp re-attaches the subagent session lazily on the next connect.",
    replToolInputShape,
    async (rawArgs) => {
      if (!options.acceptingWork()) {
        throw new McpError(
          ErrorCode.InternalError,
          "Workflow server is shutting down and is no longer accepting tool calls.",
        );
      }
      const args = rawArgs as Record<string, unknown>;
      const action = replToolInputShape.action.parse(args.action);
      const projectDir =
        args.projectDir === undefined ? undefined : replToolInputShape.projectDir.parse(args.projectDir);
      if (projectDir === undefined && requireProjectDir && action !== "status") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid repl tool input: projectDir is required on the shared workflow daemon",
        );
      }
      // status can list every known project context without naming one
      // (both modes); the stateful actions resolve a single context.
      if (action === "status") {
        if (projectDir === undefined) {
          const contexts = projects.stores();
          return { content: [{ type: "text", text: capToolResultText(renderStatus(contexts)) }] };
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
            content: [
              {
                type: "text",
                text: `No project context is available for projectDir "${String(projectDir)}".`,
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
        return { content: [{ type: "text", text: capToolResultText(renderStatus([context])) }] };
      }
      const context = resolveContext(options, projectDir);
      if (context === undefined) {
        return {
          content: [{ type: "text", text: capToolResultText(`No project context is available for projectDir "${String(projectDir)}".`) }],
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

      if (state.restoreError !== null) return refusedResult(state);

      await ensureReplWorkspace(state, await wasm, options.runner, options.evalTimeoutMs);
      if (state.restoreError !== null) return refusedResult(state);

      const broker = state.broker!;
      if (action === "eval") {
        const code = replToolInputShape.code.parse(args.code) ?? "";
        if (code.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid repl tool input: eval requires a non-empty code string");
        }
        const result = await broker.eval(code);
        const line = drainErrorLine(state);
        const rendered = renderEvalResult(result);
        const text = line !== null ? `${line}\n${rendered}` : rendered;
        return { content: [{ type: "text", text: capToolResultText(text) }] };
      }
      if (action === "wait") {
        const timeoutMs = replToolInputShape.timeoutMs.parse(args.timeoutMs ?? 30_000) ?? 30_000;
        const ids = args.ids === undefined ? undefined : replToolInputShape.ids.parse(args.ids);
        // The wait returns the SAME shape as an eval — console output
        // included (phase-D review round 2: the wait used to drop the
        // output drained by its pumps and defer it to the next eval).
        const { result, drained } = await broker.waitForCalls(ids, timeoutMs);
        const text = renderEvalResult(result);
        const line = drainErrorLine(state);
        const body = drained ? text : `${text}\n(still running — wait timed out after ${timeoutMs} ms)`;
        const waitText = line !== null ? `${line}\n${body}` : body;
        return {
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
      if (args.id === undefined) {
        const targeted = await broker.armEvalBreak();
        if (!targeted) {
          return {
            content: [
              {
                type: "text",
                text: capToolResultText(
                  `workspace ${context.projectDir}: no running eval to interrupt — the workspace is idle ` +
                    `(no eval is in flight) and nothing was armed`,
                ),
              },
            ],
          };
        }
        return {
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
      const id = replToolInputShape.id.parse(args.id) ?? "";
      const outcome = await broker.cancelCall(id);
      const text =
        outcome === "cancelled"
          ? `interrupt ${id}: ACP session/cancel sent`
          : outcome === "idle"
            ? `interrupt ${id}: the session was idle — nothing to cancel`
            : outcome === "failed"
              ? `interrupt ${id}: could not reach the backend session (lazy re-attach failed)`
              : `interrupt ${id}: no live session to cancel`;
      return { content: [{ type: "text", text: capToolResultText(text) }] };
    },
  );
}
