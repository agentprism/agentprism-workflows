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
 *   running" on timeout), then renders the same shape. Absorbs client
 *   tool-call timeouts.
 * - `status { projectDir? }` → workspaces (source, reconcile summary, or
 *   a refused snapshot's contained error), live agents, and pending ops.
 *   Without `projectDir` every known project context is listed (daemon
 *   mode). Status never CREATES a workspace — an untouched project
 *   reports as such.
 * - `interrupt { projectDir, id? }` → cancel one subagent call (ACP
 *   `session/cancel` downward); without an id, arm the project's
 *   eval-break signal (see `src/repl-project.ts` — the daemon is
 *   single-threaded, so a currently-executing runaway eval cannot
 *   observe a later request; the signal breaks the next VM execution
 *   that runs with it armed).
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
import { isAbsolute } from "node:path";
import { z } from "zod";

import { resolveProjectDir, type WorkflowProjectRegistry, type ProjectContext } from "./project-registry.js";
import {
  createReplProjectState,
  ensureReplWorkspace,
  resetReplProjectState,
  type ReplProjectState,
} from "./repl-project.js";

export const replToolInputShape = {
  action: z
    .enum(["eval", "wait", "status", "interrupt", "reset"])
    .describe(
      "Operation. eval runs a script in the workspace's VM (persistent between calls); wait pumps server-side " +
        "until the target calls settle or the timeout elapses; status reports workspaces, live agents, and pending " +
        "ops; interrupt cancels one subagent call or arms the eval-break signal; reset drops the VM and its stored state.",
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
    .describe("The call id to cancel (interrupt action). Omitted: arm the eval-break signal."),
};

export interface ReplToolOptions {
  projects: WorkflowProjectRegistry;
  /** The engine's compiled quickjs.wasm (a shared promise — the
   *  envelope's identity check compares its hash at restore). */
  wasm: Promise<WasmModule>;
  /** The workspaces' ACP runner (optional: each workspace's broker owns
   *  its own when omitted — tests inject a fake). */
  runner?: BrokerRunner;
  /** Mirrors the workflow tool's daemon-mode projectDir requirement. */
  requireProjectDir: boolean;
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
        text: `REPL workspace refused: ${error.message}\nThe stored snapshot is not restorable with the running engine. ` +
          `Run the repl tool with action "reset" to drop it and start a fresh workspace.`,
      },
    ],
    isError: true,
  };
}

/** Render the broker's eval result shape as text (the tool's output). */
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

/** One `wait` action's result: the current broker state rendered in the
 *  tool-result shape (pending ids, re-surfaced checkpoints, and the ids
 *  that settled during the wait). Console lines drained by the wait's
 *  pumps surface in the next eval's output (the broker's buffer). */
async function renderWaitResult(
  broker: { pendingCalls(): Array<{ id: string }>; pendingCheckpoints(): Array<{ id: string; question: string }> },
  initialPending: string[],
): Promise<string> {
  const pending = broker.pendingCalls().map((entry) => entry.id);
  const completed = initialPending.filter((id) => !pending.includes(id));
  const lines: string[] = [];
  if (pending.length > 0) lines.push(`pending: ${pending.join(", ")}`);
  for (const checkpoint of broker.pendingCheckpoints()) {
    lines.push(`checkpoint ${checkpoint.id}: ${checkpoint.question}`);
  }
  if (completed.length > 0) lines.push(`completed: ${completed.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "(no pending calls)";
}

/** One `wait` action: pump until the target ids settle or the deadline. */
async function waitForCalls(
  broker: { pump(): Promise<string[]>; pendingCalls(): Array<{ id: string }> },
  ids: string[] | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const targets = ids === undefined ? null : new Set(ids);
  for (;;) {
    await broker.pump();
    const pending = new Set(broker.pendingCalls().map((entry) => entry.id));
    if (targets === null ? pending.size === 0 : [...targets].every((id) => !pending.has(id))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
    const broker = state.broker;
    if (broker === null) continue;
    for (const agent of broker.liveAgents()) {
      lines.push(
        `agent ${agent.callId}: ${agent.state} (${agent.modelSpec}; steering: ${agent.supportsSteering ? "yes" : "no"}; queued: ${agent.queuedSteers})`,
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
      "workspace); console output is captured and previewed.",
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
        const contexts = projectDir === undefined ? projects.stores() : [resolveContext(options, projectDir)!];
        return { content: [{ type: "text", text: renderStatus(contexts) }] };
      }
      const context = resolveContext(options, projectDir);
      if (context === undefined) {
        return {
          content: [{ type: "text", text: `No project context is available for projectDir "${String(projectDir)}".` }],
          isError: true,
        };
      }

      // All stateful actions touch (or reset) the workspace.
      context.repl ??= createReplProjectState(context.projectDir);
      const state = context.repl;

      if (action === "reset") {
        await resetReplProjectState(state);
        return {
          content: [
            { type: "text", text: `workspace ${context.projectDir}: dropped — the VM and its stored state were reset` },
          ],
        };
      }

      if (state.restoreError !== null) return refusedResult(state);

      await ensureReplWorkspace(state, await wasm, options.runner);
      if (state.restoreError !== null) return refusedResult(state);

      const broker = state.broker!;
      if (action === "eval") {
        const code = replToolInputShape.code.parse(args.code) ?? "";
        if (code.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid repl tool input: eval requires a non-empty code string");
        }
        const result = await broker.eval(code);
        return { content: [{ type: "text", text: renderEvalResult(result) }] };
      }
      if (action === "wait") {
        const timeoutMs = replToolInputShape.timeoutMs.parse(args.timeoutMs ?? 30_000) ?? 30_000;
        const ids = args.ids === undefined ? undefined : replToolInputShape.ids.parse(args.ids);
        const initialPending = broker.pendingCalls().map((entry) => entry.id);
        const settled = await waitForCalls(broker, ids, timeoutMs);
        const text = await renderWaitResult(broker, initialPending);
        return {
          content: [
            { type: "text", text: settled ? text : `${text}\n(still running — wait timed out after ${timeoutMs} ms)` },
          ],
        };
      }
      // interrupt
      if (args.id === undefined) {
        state.interrupt.armed = true;
        return {
          content: [
            {
              type: "text",
              text: `workspace ${context.projectDir}: eval-break signal armed — the next VM execution will be interrupted`,
            },
          ],
        };
      }
      const id = replToolInputShape.id.parse(args.id) ?? "";
      await broker.cancelCall(id);
      return { content: [{ type: "text", text: `interrupt ${id}: ACP session/cancel sent` }] };
    },
  );
}
