/// <reference path="./dsl.d.ts" />
// @automatalabs/workflows — the importable SDK for the AgentPrism dynamic-workflow
// orchestrator. A THIN FACADE re-export barrel: it owns NO logic of its own, it
// re-exports the clean public surface of the three engine packages and adds ONE
// convenience helper (`runDynamicWorkflow`) that defaults the AgentRunner seam to the
// ACP backend. It is SEPARATE from @automatalabs/mcp-server (the stdio MCP server) and
// stays a PURE library — it pulls in neither @modelcontextprotocol/sdk nor zod.
//
// The DSL globals available INSIDE a workflow script (agent, parallel, pipeline, …) are
// vm-realm globals, NOT importable symbols; they are documented for author IntelliSense
// in ./dsl.d.ts (referenced above), not exported here.

import { createAcpRunner } from "@automatalabs/acp-agents";
import { parseWorkflowScript, WorkflowError, WorkflowErrorCode, WorkflowManager } from "@automatalabs/workflow-engine";
import type { ExecOptions } from "@automatalabs/workflow-engine";
import type { AgentRunner, WorkflowBackendConfig, WorkflowRunResult } from "@automatalabs/shared-types";

// ── Engine: run entry, script parsing, the managed-run lifecycle, and the
//    option/result + error types the host composes against. ──
export { runWorkflow, parseWorkflowScript, WorkflowManager } from "@automatalabs/workflow-engine";
export type {
  WorkflowRunOptions,
  AgentOptions,
  ExecOptions,
  WorkflowManagerOptions,
  CheckpointOptions,
  WorkflowRunResult,
  WorkflowSnapshot,
} from "@automatalabs/workflow-engine";
export {
  WorkflowError,
  WorkflowErrorCode,
  isWorkflowError,
  isProviderUsageLimit,
} from "@automatalabs/workflow-engine";

// ── ACP backend: the default AgentRunner implementation, backend selection, the
//    concrete backends (built-in + custom registry), the pool/runner options, and the
//    JSON-Schema helpers. Custom backends let ANY ACP agent serve agent() calls:
//    `createAcpRunner({ backends: { browser: { command: "…" } } })` (or the
//    AGENTPRISM_BACKENDS env var), then route with `agent(p, { model: "browser" })`. ──
export {
  createAcpRunner,
  AcpAgentRunner,
  selectBackend,
  ClaudeBackend,
  CodexBackend,
  CustomAcpBackend,
  resolveBackendRegistry,
  BACKENDS_ENV,
  toJsonSchema,
  toStrictJsonSchema,
} from "@automatalabs/acp-agents";
export type {
  AcpPoolOptions,
  AcpRunnerOptions,
  BackendRegistry,
  CustomBackendConfig,
  RegisteredBackend,
} from "@automatalabs/acp-agents";

// ── Live ACP events: `createAcpRunner().on("tool_call", evt => …)` to listen in on the
//    stream of a run. The event map keys are ACP `sessionUpdate` discriminants plus a few
//    cross-cutting events; each payload carries a `{ sessionId, backendId, label?, runId? }`
//    context envelope so a pooled runner's concurrent runs are disambiguable. ──
export { TypedEventEmitter } from "@automatalabs/acp-agents";
export type {
  AcpRunnerEventMap,
  AcpEventName,
  AcpEventListener,
  AcpEventContext,
  AcpSessionUpdate,
  AcpUpdateKind,
  AcpPermissionEvent,
  AcpRawMessageEvent,
  AcpBackendErrorEvent,
} from "@automatalabs/acp-agents";

// ── Shared seam types: the AgentRunner contract and its opts/result/usage shapes,
//    so callers can implement or type a custom runner without reaching past the SDK. ──
export type { AgentRunner, RunOptions, AgentResult, AgentUsage } from "@automatalabs/shared-types";
export type { JournalEntry, WorkflowBackendConfig, WorkflowMeta } from "@automatalabs/shared-types";

/**
 * Approval policy for SCRIPT-DECLARED custom ACP backends (`meta.backends`). Script backends
 * spawn arbitrary commands on this machine, so they are INERT unless the embedder approves
 * them: `true` approves everything the script declares; a callback is asked per backend (and
 * a single decline aborts the run — a declined backend would otherwise silently reroute its
 * agent() calls to the default backend). Omitted/false + a script that declares backends =>
 * runDynamicWorkflow THROWS with guidance rather than running a script whose declared
 * dependencies were dropped.
 */
export type ScriptBackendApproval =
  | boolean
  | ((backend: { name: string } & WorkflowBackendConfig) => boolean | Promise<boolean>);

/** Options for {@link runDynamicWorkflow}. */
export interface RunDynamicWorkflowOptions {
  /**
   * The agent backend (the frozen AgentRunner seam) to drive this run. The seam is
   * injectable: pass a custom runner to swap the backend (or to stub it in tests).
   * Omitted => defaults to the ACP backend via `createAcpRunner()`.
   */
  runner?: AgentRunner;
  /** The `args` value handed to the workflow script's vm-realm `args` global. */
  args?: unknown;
  /** Per-execution options forwarded to `WorkflowManager.runSync` (timeouts, signal, budget, …). */
  exec?: ExecOptions;
  /** Approval policy for script-declared `meta.backends` (see {@link ScriptBackendApproval}). */
  allowScriptBackends?: ScriptBackendApproval;
}

/**
 * Run a dynamic workflow script to a TERMINAL result, with the AgentRunner seam
 * defaulted to the ACP backend.
 *
 * Thin convenience over the engine: it constructs a one-off `WorkflowManager` whose
 * injected `agent` is `opts.runner ?? createAcpRunner()` and delegates to its
 * `runSync(script, args, exec)`, which always resolves to a terminal
 * `WorkflowRunResult` (status `completed | paused | failed | aborted`) — never throwing
 * for an ordinary pause/fail — so the caller can read `result.status` directly.
 */
export async function runDynamicWorkflow(
  script: string,
  opts: RunDynamicWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  // Script-declared backends need explicit approval BEFORE the run. A malformed script is
  // deliberately not diagnosed here — runSync re-parses and throws the engine's own parse
  // error (its pre-existing contract), so the approval gate never masks a parse message.
  let declared: Record<string, WorkflowBackendConfig> | undefined;
  try {
    declared = parseWorkflowScript(script).meta.backends;
  } catch {
    declared = undefined;
  }
  let exec = opts.exec;
  if (declared && Object.keys(declared).length > 0) {
    exec = { ...(exec ?? {}), scriptBackends: await approveScriptBackends(declared, opts.allowScriptBackends) };
  }
  return new WorkflowManager({ agent: opts.runner ?? createAcpRunner() }).runSync(script, opts.args, exec);
}

/** Resolve the embedder's approval policy over the declared backends; throw with guidance when
 *  approval is missing or any backend is declined (an unapproved dependency must abort, never
 *  silently reroute). */
async function approveScriptBackends(
  declared: Record<string, WorkflowBackendConfig>,
  approval: ScriptBackendApproval | undefined,
): Promise<Record<string, WorkflowBackendConfig>> {
  const names = Object.keys(declared).join(", ");
  if (approval === undefined || approval === false) {
    throw new WorkflowError(
      `script declares custom ACP backends (meta.backends: ${names}) — these spawn commands on this machine and require explicit approval. ` +
        `Pass allowScriptBackends: true (or a per-backend approval callback) to runDynamicWorkflow, ` +
        `or thread an approved registry yourself via exec.scriptBackends.`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  if (approval === true) return declared;
  for (const [name, config] of Object.entries(declared)) {
    if (!(await approval({ name, ...config }))) {
      throw new WorkflowError(
        `script backend "${name}" (command: ${config.command}) was declined by the allowScriptBackends callback — aborting the run`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
  }
  return declared;
}
