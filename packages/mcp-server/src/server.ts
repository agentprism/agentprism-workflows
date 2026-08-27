// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the `workflow`, `repl`, and selective
// `docs` model-facing tools (plus the user-controlled `author-workflow` prompt), and is the
// composition root where all three packages meet — the injected acp-agents
// AgentRunner is wired into a workflow-engine WorkflowManager (DI) and every tool call runs
// through WorkflowManager.runSync.
//
// Run model: foreground remains one tools/call awaited to completion; background admission
// acknowledges a process-local run and bounded await/inspect calls read it later. This stays a
// plain ToolCallback, never an MCP task handler. The engine OWNS run identity/status/resume:
//   - runSync RESOLVES to a TERMINAL WorkflowRunResult (status completed|paused|failed|
//     aborted, carrying reason/resetHint) and does NOT throw on pause/fail/abort — so the
//     shell does no status composition and needs no lifecycle try/catch.
//   - resumeFromRunId, resumePolicy, and checkpointReplies pass straight to the manager,
//     which owns source admission, durable seed construction, and checkpoint injection.
//     The shell neither hydrates journals nor owns/forges a runId.
// Mid-run progress streams via notifications/progress; extra.signal threads cancellation into
// the engine; checkpoint() is driven by the engine's `confirm` hook only when the client
// advertises elicitation. Otherwise the checkpoint's authored headless mode applies.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, type ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  buildModelFilter,
  parseWorkflowScript,
  probeHarnessConfig,
  redactText,
  validateWorkflowScript,
  truncateUtf8,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
} from "@automatalabs/workflows";
import type {
  ExecOptions,
  PersistedRunState,
  WorkflowAgentCallCancellation,
  WorkflowSnapshot,
  WorkflowBackendConfig,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowReplayEligibility,
  WorkflowResumeReport,
} from "@automatalabs/workflows";
import type { AgentRunner, TokenUsage } from "@automatalabs/shared-types";
import {
  createEvalBreakChannel,
  loadShippedWasm,
  type BrokerRunner,
  type EvalBreakChannel,
} from "@automatalabs/repl-engine";

import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  getUiCapability,
  type ToolCallback,
} from "@modelcontextprotocol/ext-apps/server";

import { clampWorkflowInput, parseWorkflowToolInput, workflowToolInputShape } from "./workflow-tool-input.js";
import {
  BackgroundRunRegistry,
  MAX_BACKGROUND_RUNS,
  WorkflowProjectRegistry,
  resolveProjectDir,
  type ProjectContext,
} from "./project-registry.js";
import { RUN_MONITOR_RESOURCE_URI, registerWorkflowAppUi } from "./app-ui.js";
import {
  toWorkflowExecutionOutcome,
  toWorkflowToolResult,
  workflowToolOutputShape,
} from "./workflow-tool-output.js";
import type {
  WorkflowExecutionOutcome,
  WorkflowRunAwaitResult,
  WorkflowStopResult,
} from "./workflow-tool-output.js";
import { createAwaitProgressReporter, createProgressReporter, formatAgentProgressMessage } from "./progress.js";
import type { AwaitProgressReporter } from "./progress.js";
import { registerAuthoringPrompt } from "./authoring-prompt.js";
import { registerAuthoringDocs } from "./docs-tool.js";
import { registerReplTool } from "./repl-tool.js";
import { ReplPresenceLedger } from "./repl-presence.js";
import { createReplProjectState, DEFAULT_REPL_EVAL_TIMEOUT_MS } from "./repl-project.js";
import { REPL_DRAIN_BOUND_MS } from "./daemon/constants.js";
import {
  configSummary,
  configText,
  validationSummary,
  validationText,
  workflowProbeRunner,
} from "./workflow-preflight.js";
import type { WorkflowServerControl } from "./lifecycle.js";
import {
  WorkflowScriptResources,
  workflowScriptUri,
} from "./workflow-resources.js";

const SERVER_NAME = "agentprism-workflow";
const require = createRequire(import.meta.url);
/**
 * The server's code identity — ALWAYS the mcp-server package version, whichever artifact
 * carries the code. The `@automatalabs/workflows` bundle embeds this source and defines
 * `__AGENTPRISM_MCP_SERVER_VERSION__` at build time (its own `../package.json` is a different
 * package with a different version; reporting that made the two distributions supersede each
 * other's daemon forever). Unbundled, the package's own manifest is the source of truth.
 */
declare const __AGENTPRISM_MCP_SERVER_VERSION__: string | undefined;
export const SERVER_VERSION: string =
  typeof __AGENTPRISM_MCP_SERVER_VERSION__ === "string"
    ? __AGENTPRISM_MCP_SERVER_VERSION__
    : (require("../package.json") as { version: string }).version;

// Server-wide guidance returned in the MCP initialize response (ServerOptions.instructions),
// surfaced by hosts to orient the calling agent to the three model-facing tools and when to reach
// for each. Kept short and behavioral — the exhaustive contract lives in each tool's own
// description and the package README.
export const SERVER_INSTRUCTIONS = [
  "This server exposes three model-facing tools for authoring and orchestrating multi-agent work. " +
    "workflow and repl spawn subagents over the same ACP backends — the registry built-ins Claude, Codex, OpenCode, and " +
    "pi, plus any registered custom agents — and key their durable state by an absolute projectDir " +
    "(required on the shared daemon; defaults to the server's own project in single-project mode). " +
    "Backend credentials come from each agent's own login (claude, codex, opencode, pi), so there " +
    "is nothing auth-shaped to configure here.",
  "• docs — SELECTIVE VERSION-MATCHED REFERENCE. Omit topic or use topic:\"index\" for the bounded catalog, then read exactly one workflow/* or repl/* topic. It embeds the selected text/markdown resource, runs no code, opens no backend, and needs no projectDir. Use it when the compact tool descriptions do not contain enough syntax or lifecycle detail.",
  "• workflow — DETERMINISTIC BATCH orchestration. Supply a JavaScript workflow script (inline or " +
    "by absolute scriptPath) that fans out agent() subagents and optional checkpoint() gates; it " +
    "runs to completion in the foreground, or background:true returns a durable runId for bounded " +
    "action:\"await\"/\"inspect\"/\"stop\" calls, with journaling, replay, and resumeFromRunId. Reach " +
    "for it when the orchestration is known up front and you want it repeatable and resumable. " +
    "action:\"config\" discovers the live backend/model option catalog without starting a run, and " +
    "every run is statically checked, mock-executed, and config-probed before admission. Read docs topic workflow/quickstart first when authoring is unfamiliar.",
  "• repl — INTERACTIVE STATEFUL orchestration. A persistent per-project JavaScript VM you drive " +
    "incrementally with action:\"eval\"; named bindings, pending subagent calls, raised checkpoints, " +
    "and `_` (the previous eval's completion value) persist between calls and survive daemon restarts. " +
    "Console logging produces output text only and creates no persistent value. Reach for it when you want " +
    "to inspect intermediate results and decide the next step adaptively, or keep a human in the " +
    "loop via checkpoint(). Read docs topic repl/quickstart first when the persistent handle API is unfamiliar.",
  "Rule of thumb: use workflow when you can script the whole plan ahead of time; use repl when you " +
    "want a live, stateful session that evolves call by call.",
].join("\n\n");

export { BackgroundRunRegistry, MAX_BACKGROUND_RUNS } from "./project-registry.js";

const TERMINAL_STATUSES = new Set(["paused", "completed", "failed", "aborted"]);

interface ExecutionAdmissionLatch {
  decision: Promise<"admitted" | "denied">;
  admit(): void;
  deny(): void;
}

function createExecutionAdmissionLatch(): ExecutionAdmissionLatch {
  let decision: "admitted" | "denied" | undefined;
  let release!: (decision: "admitted" | "denied") => void;
  const decided = new Promise<"admitted" | "denied">((resolve) => {
    release = resolve;
  });
  const settle = (next: "admitted" | "denied") => {
    if (decision !== undefined) return;
    decision = next;
    release(next);
  };
  return {
    decision: decided,
    admit: () => settle("admitted"),
    deny: () => settle("denied"),
  };
}

function isTerminalStatus(status: WorkflowRunStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isAlreadyTerminalForStop(status: WorkflowRunStatus["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/**
 * The checkpoint metadata the engine forwards to `confirm` (workflow.ts checkpoint()).
 */
export interface WorkflowCheckpointOptions {
  default?: unknown;
  headless?: "default" | "abort" | "pause";
  kind?: "confirm" | "input" | "select";
  choices?: string[];
  timeoutMs?: number;
  [key: string]: unknown;
}

/**
 * The engine's `confirm` hook (ExecOptions.confirm): `await confirm(promptText, options)`.
 * The resolved value is the human's reply (truthy => proceed). The shell maps an MCP
 * elicitation result onto it. Clients that cannot elicit receive no live callback.
 */
export type WorkflowConfirmCallback = NonNullable<ExecOptions["confirm"]>;

/** Read the checkpoint `default` from the opaque options bag the engine forwards. */
function readCheckpointDefault(options: unknown): unknown {
  if (options && typeof options === "object" && "default" in options) {
    return (options as WorkflowCheckpointOptions).default;
  }
  return undefined;
}

function readCheckpointKind(options: unknown): "confirm" | "input" | "select" {
  if (options && typeof options === "object") {
    const kind = (options as WorkflowCheckpointOptions).kind;
    if (kind === "input" || kind === "select") return kind;
  }
  return "confirm";
}

function readCheckpointChoices(options: unknown): string[] {
  if (options && typeof options === "object") {
    const choices = (options as WorkflowCheckpointOptions).choices;
    if (Array.isArray(choices)) return choices.filter((choice): choice is string => typeof choice === "string");
  }
  return [];
}

function readCheckpointTimeoutMs(options: unknown): number | undefined {
  if (options && typeof options === "object") {
    const timeoutMs = (options as WorkflowCheckpointOptions).timeoutMs;
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) return timeoutMs;
  }
  return undefined;
}

function createCheckpointElicitation(
  prompt: string,
  options: unknown,
): ElicitRequestFormParams | undefined {
  const kind = readCheckpointKind(options);
  const defaultValue = readCheckpointDefault(options);

  if (kind === "input") {
    return {
      mode: "form",
      message: prompt,
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            title: "Response",
            description: "Response for this checkpoint.",
            ...(typeof defaultValue === "string" ? { default: defaultValue } : {}),
          },
        },
        required: ["value"],
      },
    };
  }

  if (kind === "select") {
    const choices = readCheckpointChoices(options);
    if (choices.length === 0) return undefined;
    return {
      mode: "form",
      message: prompt,
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: "Choice",
            description: "Select one option for this checkpoint.",
            enum: choices,
            ...(typeof defaultValue === "string" && choices.includes(defaultValue) ? { default: defaultValue } : {}),
          },
        },
        required: ["choice"],
      },
    };
  }

  return {
    mode: "form",
    message: prompt,
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve",
          description: "Approve this checkpoint to let the workflow continue.",
        },
      },
      required: ["approve"],
    },
  };
}

function acceptedCheckpointReply(
  content: Record<string, unknown> | undefined,
  options: unknown,
  headlessReply: () => unknown,
): unknown {
  const kind = readCheckpointKind(options);
  if (kind === "input") {
    const value = content?.value;
    return typeof value === "string" ? value : headlessReply();
  }
  if (kind === "select") {
    const choice = content?.choice;
    return typeof choice === "string" && readCheckpointChoices(options).includes(choice) ? choice : headlessReply();
  }
  const approve = content?.approve;
  return typeof approve === "boolean" ? approve : headlessReply();
}

const CHECKPOINT_TIMEOUT = Symbol("checkpoint-timeout");
const requestIdsPrimed = new WeakSet<Server>();

async function primeCancellableServerRequestId(server: Server): Promise<void> {
  if (requestIdsPrimed.has(server)) return;
  requestIdsPrimed.add(server);
  try {
    // SDK 1.29.0's cancellation receiver ignores request id 0 as falsy. Consume that first
    // server-to-client id with the protocol's built-in ping so checkpoint elicitations always
    // have a cancellable positive id.
    await server.ping();
  } catch {
    // The ping still consumes the id before transport failure; elicitation owns its own error path.
  }
}

async function elicitCheckpoint(
  server: Server,
  params: ElicitRequestFormParams,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Server["elicitInput"]>> | typeof CHECKPOINT_TIMEOUT> {
  if (timeoutMs === undefined) return await server.elicitInput(params, { signal });

  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  try {
    return await server.elicitInput(params, {
      signal: AbortSignal.any([signal, timeoutController.signal]),
    });
  } catch (error) {
    if (timedOut) return CHECKPOINT_TIMEOUT;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire the engine's checkpoint `confirm` hook to MCP form elicitation. The handler installs
 * this callback only for clients that advertise elicitation, then requests a kind-specific
 * one-field form and maps the tri-state result. A timeout or failed elicitation applies
 * `default ?? true`; clients with no elicitation get no callback, so the authored headless
 * mode remains visible to the engine.
 */
function createConfirm(server: Server, signal: AbortSignal): WorkflowConfirmCallback {
  return async (prompt, options) => {
    const headlessReply = (): unknown => readCheckpointDefault(options) ?? true;
    const params = createCheckpointElicitation(prompt, options);
    if (!params) return headlessReply();

    // No elicitation capability advertised -> cannot prompt the human; reply headlessly.
    if (!server.getClientCapabilities()?.elicitation) {
      return headlessReply();
    }

    try {
      await primeCancellableServerRequestId(server);
      const elicited = await elicitCheckpoint(server, params, readCheckpointTimeoutMs(options), signal);
      if (elicited === CHECKPOINT_TIMEOUT) return headlessReply();
      if (elicited.action === "accept") {
        return acceptedCheckpointReply(elicited.content, options, headlessReply);
      }
      // "decline" / "cancel": the human explicitly did not approve -> do not proceed.
      return false;
    } catch {
      // Host advertised elicitation but cannot satisfy a form request (or it failed):
      // degrade to the headless default rather than aborting the whole run.
      return headlessReply();
    }
  };
}

/** Headless opt-in for script-declared backends (set in the mcpServers `env` block). */
const ALLOW_SCRIPT_BACKENDS_ENV = "AGENTPRISM_ALLOW_SCRIPT_BACKENDS";

function scriptBackendsAllowedByEnv(): boolean {
  const value = process.env[ALLOW_SCRIPT_BACKENDS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** One approval decision per unique spawn config. The key is the full config JSON so a script
 *  that changes a backend's command/args/env re-prompts; approvals are session-sticky,
 *  declines are not (the user may change their mind on a later call). */
type BackendApprovals = Set<string>;

function backendApprovalKey(name: string, config: WorkflowBackendConfig): string {
  return JSON.stringify({ name, command: config.command, args: config.args ?? [], env: config.env ?? {} });
}

function describeBackend(name: string, config: WorkflowBackendConfig): string {
  const lines = [`backend "${name}"`, `  command: ${config.command}${(config.args ?? []).length ? " " + (config.args ?? []).join(" ") : ""}`];
  const env = config.env ?? {};
  if (Object.keys(env).length > 0) {
    lines.push(`  env: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  return lines.join("\n");
}

type ScriptBackendsGate =
  | { ok: true; backends?: Record<string, WorkflowBackendConfig> }
  | { ok: false; message: string };

/**
 * The TRUST GATE for script-declared `meta.backends` (they spawn arbitrary commands on this
 * machine, so they are inert until approved):
 *   1. env opt-in (AGENTPRISM_ALLOW_SCRIPT_BACKENDS=1) approves headlessly — the operator
 *      accepted the risk in their MCP config;
 *   2. else, a client that advertises the elicitation capability is asked to approve each
 *      unique spawn config (approvals are session-sticky); a decline aborts the call;
 *   3. else, the call fails with guidance naming the env opt-in — an informative tool error,
 *      never a silent drop (dropped backends would silently reroute agent() calls to the
 *      default backend) and never a hang.
 * Unlike checkpoint confirm (which degrades to its headless default), an elicitation FAILURE
 * here is a DENY — this is a security gate, not a workflow gate.
 */
async function resolveScriptBackends(
  server: Server,
  script: string,
  approvals: BackendApprovals,
): Promise<ScriptBackendsGate> {
  // A malformed script is not this gate's concern: runSync re-parses and resolves the usual
  // terminal failed result with the real parse message.
  let declared: Record<string, WorkflowBackendConfig> | undefined;
  try {
    declared = parseWorkflowScript(script).meta.backends;
  } catch {
    return { ok: true };
  }
  if (!declared || Object.keys(declared).length === 0) return { ok: true };

  if (scriptBackendsAllowedByEnv()) return { ok: true, backends: declared };

  if (!server.getClientCapabilities()?.elicitation) {
    return {
      ok: false,
      message:
        `This workflow declares custom ACP backends (meta.backends: ${Object.keys(declared).join(", ")}), ` +
        `which spawn commands on this machine and require user approval — but this MCP client does not ` +
        `support elicitation, so approval cannot be requested interactively. To allow script-declared ` +
        `backends, set ${ALLOW_SCRIPT_BACKENDS_ENV}=1 in the "env" block of this server's mcpServers ` +
        `config entry (this approves ALL script-declared backends headlessly), or remove meta.backends ` +
        `and register the backends host-side via AGENTPRISM_BACKENDS instead.`,
    };
  }

  for (const [name, config] of Object.entries(declared)) {
    const key = backendApprovalKey(name, config);
    if (approvals.has(key)) continue;
    let approved = false;
    try {
      const elicited = await server.elicitInput({
        message:
          `Workflow wants to spawn a custom ACP agent backend on this machine:\n\n` +
          `${describeBackend(name, config)}\n\n` +
          `Approve spawning this command?`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: `Allow the workflow to spawn "${config.command}" as backend "${name}".`,
            },
          },
          required: ["approve"],
        },
      });
      approved = elicited.action === "accept" && elicited.content?.approve === true;
    } catch {
      approved = false; // elicitation failed -> DENY (security gate; never degrade to allow)
    }
    if (!approved) {
      return {
        ok: false,
        message:
          `User declined to spawn script-declared backend "${name}" (command: ${config.command}) — ` +
          `the workflow was not run. Remove meta.backends.${name} or re-run and approve it.`,
      };
    }
    approvals.add(key);
  }
  return { ok: true, backends: declared };
}

/** Human-readable summary for a completed run. */
function formatCompletedSummary(run: WorkflowRunResult): string {
  const lines: string[] = [
    `Workflow "${run.meta.name}" completed.`,
    `runId: ${run.runId}`,
    `agents: ${run.agentCount}  duration: ${run.durationMs}ms`,
  ];
  if (run.phases.length > 0) {
    lines.push(`phases: ${run.phases.join(", ")}`);
  }
  if (run.tokenUsage) {
    lines.push(
      `tokens: ${run.tokenUsage.total} (input ${run.tokenUsage.input}, output ${run.tokenUsage.output})  cost: $${run.tokenUsage.cost}`,
    );
  }
  if (run.replayEligibility || run.resumeReport) {
    lines.push(formatResumeSummary(run.replayEligibility, run.resumeReport));
  }
  return lines.join("\n");
}

function formatResumeSummary(
  eligibility: WorkflowReplayEligibility | undefined,
  report?: WorkflowResumeReport,
): string {
  if (!eligibility) {
    if (!report) return "resume: eligibility unavailable";
    const strategy = report.strategy === "positional-v1"
      ? `${report.strategy}/${report.eligibility} (${report.fallbackReason})`
      : report.strategy === "live"
        ? `${report.strategy} (${report.disabledReason})`
        : report.strategy;
    const first = report.calls.find((decision) => decision.action !== "replayed");
    const lines = [
      `resume: ${strategy}, ${report.replayed} replayed, ${report.live} live, ${report.failed} failed` +
        (first ? `; first non-replay: call ${first.index} ${first.reason}` : ""),
    ];
    if (report.checkpointReply?.status === "not-applied") {
      lines.push(report.checkpointReply.message);
    }
    return lines.join("\n");
  }
  const strategy = eligibility.strategy === "positional-v1"
    ? `${eligibility.strategy}/${eligibility.eligibility} (${eligibility.fallbackReason})`
    : eligibility.strategy === "live"
      ? `${eligibility.strategy} (${eligibility.disabledReason})`
      : eligibility.strategy;
  const evaluated = eligibility.replayed + eligibility.live + eligibility.failed > 0;
  const zeroPrefix = evaluated
    ? eligibility.replayedPrefix === 0
    : eligibility.predictedReplayablePrefix === 0;
  const lines = [
    `${zeroPrefix ? "WARNING: " : ""}resume: ${strategy}; ` +
      `predicted replayable prefix ${eligibility.predictedReplayablePrefix}; ` +
      `replayed prefix ${eligibility.replayedPrefix}; ` +
      `${eligibility.replayed} replayed, ${eligibility.live} live, ${eligibility.failed} failed`,
    "prediction is an admission-time upper bound; every call is checked before replay",
  ];
  if (report?.checkpointReply?.status === "not-applied") {
    lines.push(report.checkpointReply.message);
  }
  if (eligibility.firstNonReplay) {
    lines.push(
      `first non-replay: call ${eligibility.firstNonReplay.index} ${eligibility.firstNonReplay.reason}` +
        (eligibility.firstNonReplay.detail ? ` — ${eligibility.firstNonReplay.detail}` : ""),
    );
  }
  lines.push(
    `engine: ${eligibility.sourceEngineVersion ?? "unknown"} -> ${eligibility.currentEngineVersion} ` +
      `(${eligibility.engineVersionComparison}); inputs format: ` +
      `${eligibility.sourceInputsFormat ?? "unknown"} -> ${eligibility.currentInputsFormat}`,
  );
  if ((eligibility.provenanceChanges?.length ?? 0) > 0) {
    lines.push(
      `provenance changes: ${eligibility.provenanceChanges?.map((change) => change.detail).join("; ")}`,
    );
  }
  if (eligibility.operationalChanges.length > 0) {
    lines.push(`operational changes: ${eligibility.operationalChanges.map((change) => change.detail).join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Human-readable summary for a terminal non-completed run (paused | failed | aborted). The
 * engine already stamped status/reason/resetHint on the WorkflowRunResult; this is a pure
 * projection — no status is re-derived here.
 */
function formatTerminalSummary(run: WorkflowRunResult): string {
  const lines: string[] = [`Workflow run ${run.status}.`, `runId: ${run.runId}`];
  if (run.reason) {
    lines.push(`reason: ${truncateUtf8(redactText(run.reason).value, 512)}`);
  }
  if (run.resetHint) {
    lines.push(`reset hint: ${truncateUtf8(redactText(run.resetHint).value, 512)}`);
  }
  if (run.logTail) {
    lines.push(`recent run log (last ${run.logTail.lines.length} of ${run.logTail.totalLines}):`);
    for (const line of run.logTail.lines) lines.push(`  ${line}`);
  }
  if (run.replayEligibility || run.resumeReport) {
    lines.push(formatResumeSummary(run.replayEligibility, run.resumeReport));
  }
  if (run.status === "paused") {
    // Read the STRUCTURED authContext (§2.12) — never the free-form `reason` message string.
    if (run.reason === "auth_required" && run.authContext) {
      const backendId = run.authContext.backendId ?? "?";
      lines.push(`This run needs authentication for backend "${backendId}".`);
      for (const m of run.authContext.methods) {
        lines.push(`  - ${m.id} (${m.type})${m.name ? `: ${m.name}` : ""}`);
      }
      lines.push(
        `Agents authenticate from their own credential sources: configure that backend on this ` +
          `machine (e.g. \`claude /login\`, \`codex login\`, \`opencode auth login\`, or a pi provider key / \`~/.pi/agent/auth.json\`), ` +
          `then re-call the workflow tool with resumeFromRunId="${run.runId}".`,
      );
    } else if (run.reason === "checkpoint_required" && run.checkpointContext) {
      const checkpoint = run.checkpointContext;
      lines.push(`This run awaits a ${checkpoint.kind} decision for: ${checkpoint.prompt}`);
      if (checkpoint.choices?.length) lines.push(`choices: ${checkpoint.choices.join(", ")}`);
      lines.push(
        `Re-call the workflow tool with resumeFromRunId="${run.runId}" and ` +
          `checkpointReplies={ "${checkpoint.callIndex}": <decision> }.`,
      );
    } else {
      lines.push(
        `This run is resumable — call the workflow tool again with resumeFromRunId="${run.runId}" to continue from its journal.`,
      );
    }
  }
  return truncateUtf8(lines.join("\n"), 12_288, "…[text truncated]");
}

function formatRunSummary(run: WorkflowRunResult): string {
  return run.status === "completed" ? formatCompletedSummary(run) : formatTerminalSummary(run);
}

function inspectionSummaryLines(
  status: WorkflowRunStatus,
  options: { includeReplayEligibility?: boolean } = {},
): string[] {
  const lines = [`Workflow "${status.workflowName}" is ${status.status}.`, `runId: ${status.runId}`];
  if (status.phases.length > 0) lines.push(`phases: ${status.phases.join(", ")}`);
  if (status.currentPhase) lines.push(`current phase: ${status.currentPhase}`);
  if (status.reason) lines.push(`reason: ${status.reason}`);
  if (status.errorCode) lines.push(`error code: ${status.errorCode}`);
  if (status.replayEligibility && options.includeReplayEligibility !== false) {
    lines.push(formatResumeSummary(status.replayEligibility));
  }
  lines.push(`recent run log (last ${status.logTail.lines.length} of ${status.logTail.totalLines}):`);
  for (const line of status.logTail.lines) lines.push(`  ${line}`);
  lines.push(`recent calls (${status.calls.length} of ${status.truncation.calls.matched} matching):`);
  for (const call of status.calls) {
    const attribution = call.label ? `${call.kind} "${call.label}"` : call.kind;
    const phase = call.phase ? ` in ${call.phase}` : "";
    // In-flight calls have no result yet; show their live state instead of the null preview.
    const outcome = call.status !== undefined ? `(${call.status})` : call.resultPreview;
    lines.push(`  [${call.index}] ${attribution}${phase}: ${outcome}`);
  }
  return lines;
}

/** Human-readable inspection text generated only from the bounded safe status payload. */
function formatInspectionSummary(status: WorkflowRunStatus): string {
  return truncateUtf8(inspectionSummaryLines(status).join("\n"), 8_192, "…[text truncated]");
}

const MAX_INSPECTION_STRUCTURED_BYTES = 24_576;
const MAX_INSPECTION_SCALAR_BYTES = 512;
const MAX_INSPECTION_PHASES = 64;

interface RetainedInspectionText {
  shortened: boolean;
  redacted: boolean;
}

interface InspectionRetentionMetadata {
  phases: RetainedInspectionText[];
  logs: RetainedInspectionText[];
}

function retainedInspectionText(value: string): RetainedInspectionText {
  const redacted = redactText(value);
  return {
    shortened: truncateUtf8(redacted.value, MAX_INSPECTION_SCALAR_BYTES) !== redacted.value,
    redacted: redacted.redacted,
  };
}

function inspectionRetentionMetadata(
  manager: WorkflowManager,
  runId: string,
  status: WorkflowRunStatus,
): InspectionRetentionMetadata {
  const live = manager.getRun(runId);
  const persisted = live ? undefined : manager.getPersistence().load(runId);
  const sourcePhases = live?.snapshot.phases ?? persisted?.phases ?? [];
  const sourceLogs = live?.snapshot.logs ?? persisted?.logs ?? [];
  const phaseCandidates = sourcePhases.slice(-MAX_INSPECTION_PHASES).map(retainedInspectionText);
  const logCandidates = (
    status.filter.logLines === 0 ? [] : sourceLogs.slice(-status.filter.logLines)
  ).map(retainedInspectionText);
  return {
    phases: status.phases.length === 0 ? [] : phaseCandidates.slice(-status.phases.length),
    logs: status.logTail.lines.length === 0 ? [] : logCandidates.slice(-status.logTail.lines.length),
  };
}

function addInspectionResourceFields<Status extends WorkflowRunStatus, Fields extends object>(
  status: Status,
  fields: Fields,
  retention: InspectionRetentionMetadata,
): Status & Fields {
  const projected: Status & Fields = {
    ...status,
    calls: [...status.calls],
    logTail: { ...status.logTail, lines: [...status.logTail.lines] },
    phases: [...status.phases],
    truncation: {
      ...status.truncation,
      phases: { ...status.truncation.phases },
      logs: { ...status.truncation.logs },
      calls: { ...status.truncation.calls },
    },
    ...fields,
  };
  const phaseRetention = [...retention.phases];
  const logRetention = [...retention.logs];
  const refreshCounters = () => {
    projected.logTail.omittedLines = projected.logTail.totalLines - projected.logTail.lines.length;
    projected.logTail.truncatedLines = logRetention.filter((line) => line.shortened).length;
    projected.logTail.redactedLines = logRetention.filter((line) => line.redacted).length;
    projected.truncation.phases.returned = projected.phases.length;
    projected.truncation.phases.shortened = phaseRetention.filter((phase) => phase.shortened).length;
    projected.truncation.logs.returned = projected.logTail.lines.length;
    projected.truncation.logs.shortened = projected.logTail.truncatedLines;
    projected.truncation.logs.redacted = projected.logTail.redactedLines;
    projected.truncation.calls.returned = projected.calls.length;
    projected.truncation.calls.shortenedResults = projected.calls.filter(
      (call) => call.resultTruncated,
    ).length;
    projected.truncation.calls.redactedResults = projected.calls.filter(
      (call) => call.resultRedacted,
    ).length;
  };
  refreshCounters();
  const structuredBytes = () => Buffer.byteLength(JSON.stringify(projected), "utf8");
  const mandatoryEnvelope = {
    ...projected,
    calls: [],
    logTail: { ...projected.logTail, lines: [] },
    phases: [],
  };

  if (
    Buffer.byteLength(JSON.stringify(mandatoryEnvelope), "utf8") >
    MAX_INSPECTION_STRUCTURED_BYTES
  ) {
    let previousLimit = -1;
    while (projected.truncation.maxStructuredBytes !== previousLimit) {
      previousLimit = projected.truncation.maxStructuredBytes;
      projected.truncation.maxStructuredBytes = Math.max(
        MAX_INSPECTION_STRUCTURED_BYTES,
        structuredBytes(),
      );
    }
    return projected;
  }

  projected.truncation.maxStructuredBytes = MAX_INSPECTION_STRUCTURED_BYTES;
  const tooLarge = () => structuredBytes() > MAX_INSPECTION_STRUCTURED_BYTES;

  while (projected.calls.length > 0 && tooLarge()) {
    projected.calls.shift();
    refreshCounters();
    projected.truncation.byteCapApplied = true;
  }
  while (projected.logTail.lines.length > 0 && tooLarge()) {
    projected.logTail.lines.shift();
    logRetention.shift();
    refreshCounters();
    projected.truncation.byteCapApplied = true;
  }
  while (projected.phases.length > 0 && tooLarge()) {
    projected.phases.shift();
    phaseRetention.shift();
    refreshCounters();
    projected.truncation.byteCapApplied = true;
  }
  if (tooLarge()) {
    delete projected.reason;
    delete projected.errorCode;
    delete projected.currentPhase;
  }
  return projected;
}

function formatStopSummary(result: WorkflowStopResult): string {
  const lines = inspectionSummaryLines(result);
  if (result.alreadyTerminal) {
    lines.splice(2, 0, "No stop was initiated because this run was already terminal.");
  } else {
    lines.splice(
      2,
      0,
      "Stop is durably complete: this snapshot is final for run fate, resumeFromRunId is safe immediately, and a follow-up await adds nothing.",
      "Agent-session cancellation may still be winding down; inspect the per-agent states only if backend cleanup appears hung.",
    );
  }
  return truncateUtf8(lines.join("\n"), 8_192, "…[text truncated]");
}

function formatAgentCancellationSummary(
  status: WorkflowRunStatus,
  cancellation: WorkflowAgentCallCancellation,
): string {
  const lines = inspectionSummaryLines(status);
  lines.splice(
    2,
    0,
    `Agent call ${cancellation.callIndex} ("${cancellation.label}") settled with AGENT_CANCELLED; the workflow run remains live.`,
  );
  return truncateUtf8(lines.join("\n"), 8_192, "…[text truncated]");
}

function readScriptAtAdmission(scriptPath: string): string {
  try {
    return readFileSync(scriptPath, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid workflow tool input: unable to read scriptPath "${scriptPath}": ${cause}`,
    );
  }
}

function requireAdmissionResource(
  manager: WorkflowManager,
  scriptResources: WorkflowScriptResources,
  runId: string,
  admittedScript: string,
  beforeCleanup: () => void,
): void {
  let failure: string;
  try {
    const persisted = manager.getPersistence().load(runId);
    if (persisted && persisted.script === admittedScript) {
      scriptResources.notifyRunAdmitted(runId);
      return;
    }
    failure = persisted
      ? "the persisted script did not match the admitted snapshot"
      : "the persisted run record was unreadable";
  } catch (error) {
    failure = `the persisted run record could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }

  beforeCleanup();
  try {
    const live = manager.getRun(runId);
    if (live?.status === "running" || live?.status === "paused") manager.stop(runId);
  } catch {
    // Cleanup continues through deletion so the manager can still release its run lease.
  }
  try {
    scriptResources.deleteRun(runId, false);
  } catch {
    // Best-effort cleanup has already attempted stop, terminal persistence, and lease release.
  }
  throw new McpError(
    ErrorCode.InternalError,
    `Workflow admission failed for runId "${runId}" because ${failure}; the run was not acknowledged.`,
  );
}

async function settleForegroundRun(
  manager: WorkflowManager,
  started: { runId: string; promise: Promise<WorkflowRunResult> },
): Promise<WorkflowRunResult> {
  try {
    return await started.promise;
  } catch (error) {
    const settled = manager.getRun(started.runId)?.result;
    if (settled) return settled;
    throw error;
  }
}

function requireDurableStoppedRun(manager: WorkflowManager, runId: string): void {
  const persistence = manager.getPersistence();
  const persisted = persistence.load(runId);
  if (persisted?.status !== "aborted") {
    throw new McpError(
      ErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: the persisted status is ${persisted?.status ?? "missing"}, not aborted.`,
    );
  }
  if (
    persisted.eventLogIncomplete ||
    persisted.eventStreamId === undefined ||
    persisted.eventSeq === undefined ||
    persisted.eventSeq < 1
  ) {
    throw new McpError(
      ErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: its stopped event is not durably readable.`,
    );
  }

  let stoppedEventIsDurable = false;
  try {
    const events = persistence.readEvents(runId, {
      after: persisted.eventSeq - 1,
      streamId: persisted.eventStreamId,
      limit: 1,
    });
    stoppedEventIsDurable = events.events.some(
      (record) => record.seq === persisted.eventSeq && record.event.type === "stopped",
    );
  } catch {
    stoppedEventIsDurable = false;
  }
  if (!stoppedEventIsDurable) {
    throw new McpError(
      ErrorCode.InternalError,
      `Workflow stop for runId "${runId}" could not be durably acknowledged: its terminal stopped event is missing.`,
    );
  }
}

function normalizeTokenUsage(
  usage:
    | {
        input: number;
        output: number;
        total: number;
        cost?: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cost: usage.cost ?? 0,
    ...(usage.cacheRead === undefined ? {} : { cacheRead: usage.cacheRead }),
    ...(usage.cacheWrite === undefined ? {} : { cacheWrite: usage.cacheWrite }),
  };
}

function currentTokenUsage(manager: WorkflowManager, runId: string): TokenUsage | undefined {
  const live = normalizeTokenUsage(manager.getRun(runId)?.snapshot.tokenUsage);
  if (live) return live;
  return normalizeTokenUsage(manager.getPersistence().load(runId)?.tokenUsage);
}

function persistedOutcome(
  persisted: PersistedRunState,
  status: WorkflowRunStatus,
): WorkflowExecutionOutcome {
  if (status.status === "pending" || status.status === "running") {
    throw new TypeError(`Terminal workflow outcome cannot have status ${status.status}`);
  }
  return {
    runId: persisted.runId,
    status: status.status,
    ...(persisted.limits === undefined ? {} : { limits: persisted.limits }),
    ...(status.status === "completed" && persisted.result !== undefined ? { result: persisted.result } : {}),
    tokenUsage: normalizeTokenUsage(persisted.tokenUsage),
    logs: persisted.logs,
    ...(status.status === "completed" ? {} : { logTail: status.logTail }),
    authContext: persisted.authContext,
    checkpointContext: persisted.checkpointContext,
    ...(persisted.fallbacks === undefined ? {} : { fallbacks: persisted.fallbacks }),
    ...(persisted.checkpointsTaken === undefined ? {} : { checkpointsTaken: persisted.checkpointsTaken }),
    ...(persisted.resumeReport === undefined ? {} : { resumeReport: persisted.resumeReport }),
    ...(persisted.replayEligibility === undefined
      ? {}
      : { replayEligibility: persisted.replayEligibility }),
    scriptUri: workflowScriptUri(persisted.runId),
  };
}

function terminalOutcome(
  manager: WorkflowManager,
  runId: string,
  status: WorkflowRunStatus,
): WorkflowExecutionOutcome | undefined {
  const live = manager.getRun(runId)?.result;
  if (live) {
    return toWorkflowExecutionOutcome(live, { scriptUri: workflowScriptUri(runId) });
  }
  const persisted = manager.getPersistence().load(runId);
  return persisted ? persistedOutcome(persisted, status) : undefined;
}

const AWAIT_CANCELLED = Symbol("await-cancelled");
const AWAIT_UNKNOWN_RUN = Symbol("await-unknown-run");

const EVENT_LOG_POLL_FALLBACK_CODES = new Set([
  "EVENT_LOG_UNAVAILABLE",
  "WATERMARK_MISSING",
  "STREAM_ID_MISSING",
  "STREAM_MISMATCH",
  "EVENT_LOG_INCOMPLETE",
  "CORRUPT_LOG",
  "UNSUPPORTED_VERSION",
  "SNAPSHOT_AHEAD",
  "CURSOR_AHEAD",
  "RECORD_TOO_LARGE",
  "IO_ERROR",
]);

const EVENT_LOG_UNKNOWN_RUN_CODES = new Set(["RUN_NOT_FOUND", "ORPHANED_LOG"]);
const TERMINAL_RUN_EVENT_TYPES = new Set(["complete", "paused", "error", "stopped"]);

async function waitForTerminal(
  manager: WorkflowManager,
  runId: string,
  waitMs: number,
  signal: AbortSignal,
  localPromise: Promise<WorkflowRunResult> | undefined,
  progress: AwaitProgressReporter,
): Promise<"settled" | "timeout" | typeof AWAIT_CANCELLED | typeof AWAIT_UNKNOWN_RUN> {
  return await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    let stream: ReturnType<ReturnType<WorkflowManager["getPersistence"]>["watchEvents"]> | undefined;
    let done = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      stream?.close();
      signal.removeEventListener("abort", cancelled);
    };
    const finish = (result: "settled" | "timeout" | typeof AWAIT_CANCELLED | typeof AWAIT_UNKNOWN_RUN) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const cancelled = () => finish(AWAIT_CANCELLED);

    const startPollingFallback = () => {
      if (done || poller !== undefined) return;
      stream?.close();
      stream = undefined;
      poller = setInterval(() => {
        const status = manager.inspectRun(runId, { lastN: 1, logLines: 0 });
        if (status && isTerminalStatus(status.status)) finish("settled");
      }, 250);
    };

    const handleEventLogError = (error: unknown) => {
      const code = runEventLogErrorCode(error);
      if (code !== undefined && EVENT_LOG_POLL_FALLBACK_CODES.has(code)) {
        startPollingFallback();
      } else if (code !== undefined && EVENT_LOG_UNKNOWN_RUN_CODES.has(code)) {
        finish(AWAIT_UNKNOWN_RUN);
      } else {
        fail(error);
      }
    };

    const consumeRecord = (record: Parameters<AwaitProgressReporter["record"]>[0]) => {
      progress.record(record);
      if (TERMINAL_RUN_EVENT_TYPES.has(record.event.type)) finish("settled");
    };

    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) {
      finish(AWAIT_CANCELLED);
      return;
    }

    const deadline = Date.now() + waitMs;
    timer = setTimeout(() => finish("timeout"), waitMs);
    if (localPromise) {
      void localPromise.then(
        () => finish("settled"),
        () => finish("settled"),
      );
    }

    try {
      const persistence = manager.getPersistence();
      const snapshot = persistence.load(runId);
      if (snapshot) progress.seed(snapshot);
      const initial = persistence.readEvents(runId, {
        after: snapshot?.eventSeq ?? 0,
        streamId: snapshot?.eventStreamId,
      });
      for (const record of initial.events) {
        consumeRecord(record);
        if (done) return;
      }
      stream = persistence.watchEvents(runId, {
        after: initial.cursor,
        streamId: initial.streamId,
      });
      const activeStream = stream;
      void (async () => {
        try {
          while (!done) {
            // The bounded RunEventStream yields the event loop between records, so the waitMs
            // setTimeout above still fires under a heavy catch-up; this in-loop check is the
            // belt-and-suspenders bound the daemon investigation asked for, ending the drain at
            // the deadline even if the timer callback is itself briefly starved.
            if (Date.now() >= deadline) {
              finish("timeout");
              break;
            }
            const next = await activeStream.next();
            if (next.done) break;
            consumeRecord(next.value);
          }
          if (!done) startPollingFallback();
        } catch (error) {
          handleEventLogError(error);
        }
      })();
    } catch (error) {
      handleEventLogError(error);
    }
  });
}

function runEventLogErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "RunEventLogError" && typeof candidate.code === "string" ? candidate.code : undefined;
}

function formatAwaitSummary(result: WorkflowRunAwaitResult): string {
  const [heading, runId, ...diagnostics] = inspectionSummaryLines(result, {
    includeReplayEligibility: false,
  });
  const lines = [heading, runId];
  lines.push(
    `wait: ${result.wait.returnedBecause} after ${result.wait.elapsedMs}ms (requested ${result.wait.requestedMs}ms)`,
  );
  if (result.replayEligibility || result.outcome?.resumeReport) {
    lines.push(formatResumeSummary(result.replayEligibility, result.outcome?.resumeReport));
  }
  if (result.status === "paused" && result.outcome) {
    if (result.reason === "auth_required" && result.outcome.authContext) {
      const backendId = result.outcome.authContext.backendId ?? "?";
      lines.push(`This run needs authentication for backend "${backendId}".`);
      for (const method of result.outcome.authContext.methods) {
        lines.push(`  - ${method.id} (${method.type})${method.name ? `: ${method.name}` : ""}`);
      }
      lines.push(
        `Agents authenticate from their own credential sources: configure that backend on this ` +
          `machine (e.g. \`claude /login\`, \`codex login\`, \`opencode auth login\`, or a pi provider key / \`~/.pi/agent/auth.json\`), then start a new ` +
          `workflow run with resumeFromRunId="${result.runId}".`,
      );
    } else if (result.reason === "checkpoint_required" && result.outcome.checkpointContext) {
      const checkpoint = result.outcome.checkpointContext;
      lines.push(`This run awaits a ${checkpoint.kind} decision for: ${checkpoint.prompt}`);
      if (checkpoint.choices?.length) lines.push(`choices: ${checkpoint.choices.join(", ")}`);
      lines.push(
        `Start a new workflow run with resumeFromRunId="${result.runId}" and ` +
          `checkpointReplies={ "${checkpoint.callIndex}": <decision> }.`,
      );
    } else {
      lines.push(`Start a new workflow run with resumeFromRunId="${result.runId}" to continue from its journal.`);
    }
  }
  lines.push(...diagnostics);
  return truncateUtf8(lines.join("\n"), 8_192, "…[text truncated]");
}

/**
 * Build the MCP server with the `workflow`, `repl`, and selective `docs` model-facing tools,
 * plus the user-controlled `author-workflow` prompt. Prompts are a separate MCP primitive and never enter the model's tool-selection
 * loop). Backend auth is the agents' own concern (their CLI credential stores); a run that
 * genuinely hits AUTH_REQUIRED pauses with authContext and resumes after an out-of-band CLI
 * login. The AgentRunner is the DI seam: it is injected here into a single
 * WorkflowManager (so persistence — and therefore resume — is shared across calls) and every run goes
 * through manager.runSync or startInBackground. The returned McpServer is not yet connected — the caller attaches a
 * transport (see index.ts).
 */
/** The per-eval wall-clock deadline (see `repl-project.ts`); the
 *  `AGENTPRISM_REPL_EVAL_TIMEOUT_MS` env knob, clamped to >= 1 ms. */
function replEvalTimeoutMs(): number {
  const env = process.env.AGENTPRISM_REPL_EVAL_TIMEOUT_MS;
  if (env !== undefined) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_REPL_EVAL_TIMEOUT_MS;
}

export interface CreateWorkflowServerOptions {
  /** Pin a pre-built manager as this server's own project (composition/back-compat seam). */
  manager?: WorkflowManager;
  /** Background-run registry for the pinned manager's project. Defaults to a fresh one. */
  backgroundRuns?: BackgroundRunRegistry;
  /**
   * Share one project registry across servers (the daemon passes its own, shared by every
   * session, so all sessions see all projects' runs). Defaults to a private registry.
   */
  projects?: WorkflowProjectRegistry;
  /**
   * Require `projectDir` on run inputs instead of defaulting to this server's own project.
   * The daemon sets this: it serves every project from one process and has no ambient cwd.
   */
  requireProjectDir?: boolean;
  /**
   * The REPL workspaces' ACP runner (the broker's structural seam). Omitted: every
   * workspace's broker owns its own `AcpAgentRunner` (disposed with the workspace). Tests
   * inject a fake and own its lifetime.
   */
  replRunner?: BrokerRunner;
  /**
   * The REPL client-presence ledger (daemon mode: one ledger per daemon, shared by every
   * session; single-project mode: a private ledger). Drives the doc's last-client-
   * disconnect drain. Omitted: a private ledger is created (the single-project mode's
   * own client presence).
   */
  replPresence?: ReplPresenceLedger;
  /**
   * This server's MCP session id (daemon mode: the per-session transport's id, resolved
   * per call; single-project mode: a fixed client id). The `repl` tool touches presence
   * under it.
   */
  replClientId?: () => string | undefined;
  /** The REPL eval-break relay (phase-F review round 2; daemon mode —
   *  the shim fires it while the daemon's main thread is blocked in a
   *  synchronous eval). OMITTED in single-project mode: the server owns
   *  a channel of its own by default (round 3 — the documented no-id
   *  interrupt must work in every supported mode; the stdio transport's
   *  worker-reader fires it, and `replBreakUrl()` exposes the relay to
   *  library hosts). */
  replEvalBreakChannel?: EvalBreakChannel;
  /**
   * The concrete client-presence drain bound — the daemon reuses its session-eviction
   * TTL (the spec-owed decision; see `repl-presence.ts`). Defaults to
   * `SESSION_IDLE_TTL_MS`.
   */
  replDrainBoundMs?: number;
}

export interface WorkflowServer extends McpServer, WorkflowServerControl {}

export function createWorkflowServer(
  runner: AgentRunner,
  options: CreateWorkflowServerOptions = {},
): WorkflowServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  let acceptingWork = true;
  // The REPL eval-break channel (phase-F review round 3): the in-process/
  // library server OWNS one by default — the documented no-id interrupt
  // for a synchronously running eval is deliverable in every supported
  // mode, not only daemon mode (the daemon passes its own channel and
  // owns its lifetime; `disposeReplEvalBreakChannel` disposes only a
  // server-owned channel). The relay address is exposed as
  // `replBreakUrl()` on the server control — the stdio transport's
  // worker-reader fires it (see `repl-stdio-transport.ts`), and a
  // library host can fire it from another thread.
  const ownsReplEvalBreakChannel = options.replEvalBreakChannel === undefined;
  const replEvalBreakChannel = options.replEvalBreakChannel ?? createEvalBreakChannel();
  const server = Object.assign(mcp, {
    stopAcceptingWork() {
      acceptingWork = false;
    },
    replBreakUrl() {
      return replEvalBreakChannel.breakUrl();
    },
    replDefaultProjectDir() {
      // The single-project server's own project: the FIRST registry
      // context — exactly what the repl tool's projectDir-omitted
      // resolution returns (`resolveContext`: `stores()[0]`). The
      // relay transport fires its out-of-band break under this key
      // when the client omits projectDir (phase-F review round 4: the
      // omitted-projectDir interrupt used to skip the relay entirely
      // and run to the per-eval deadline). Undefined in daemon mode
      // (projectDir is required there) and when no context exists yet.
      return projects.stores()[0]?.projectDir;
    },
    async disposeReplEvalBreakChannel() {
      if (ownsReplEvalBreakChannel) await replEvalBreakChannel.dispose();
    },
  });

  // registerCapabilities is illegal after a transport attaches. Merge the complete resources
  // capability — and the MCP Apps extension declaration required by the extensions
  // negotiation spec (servers advertise `capabilities.extensions` in the initialize
  // response) — before handler registration and before createWorkflowServer returns.
  mcp.server.registerCapabilities({
    resources: { subscribe: true, listChanged: true },
    extensions: { [EXTENSION_ID]: {} },
  });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. Each
  // project's manager owns run lifecycle, status stamping, and the persisted journal used by
  // resume; the registry routes calls to the right project (run: the projectDir argument;
  // inspect/await/stop: locating the runId's store).
  const requireProjectDir = options.requireProjectDir === true;
  const projects = options.projects ?? new WorkflowProjectRegistry(runner);
  const defaultContext: ProjectContext | undefined = requireProjectDir
    ? undefined
    : projects.adopt(options.manager ?? new WorkflowManager({ agent: runner }), options.backgroundRuns);
  const scriptResources = new WorkflowScriptResources(mcp, { router: projects });
  registerAuthoringDocs(mcp, {
    registerResourceReader: (uri, read) => scriptResources.registerExternalResourceReader(uri, read),
  });
  // Session-sticky approvals for script-declared backends (one prompt per unique spawn config).
  const backendApprovals: BackendApprovals = new Set();
  // The REPL client-presence ledger (see `repl-presence.ts`): one per
  // server, shared by the repl tool AND the workflow tool — a session
  // that addresses a project through WORKFLOW calls is present on that
  // project exactly like one that touched the repl workspace (phase-E
  // review rejection round 2: the workflow handler resolved the same
  // project context without registering presence, so a workflow-only
  // client's presence was invisible to the last-client-disconnect drain
  // and a repl client's disconnect could drain children while the
  // workflow client was still connected).
  const replPresence = options.replPresence ?? new ReplPresenceLedger(options.replDrainBoundMs ?? REPL_DRAIN_BOUND_MS);

  /** Route a parsed input to its project context; undefined = runId found in no known store. */
  const resolveContext = (input: ReturnType<typeof parseWorkflowToolInput>): ProjectContext | undefined => {
    if (input.action === "inspect" || input.action === "await" || input.action === "stop") {
      return projects.storeFor(input.runId) ?? defaultContext;
    }
    if (input.projectDir !== undefined) {
      const resolution = resolveProjectDir(input.projectDir);
      if (!resolution.ok) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid workflow tool input: ${resolution.message}`);
      }
      return projects.getOrCreate(resolution.projectDir);
    }
    return defaultContext;
  };

  registerAuthoringPrompt(mcp);
  const probeRunner = workflowProbeRunner(runner);

  // The REPL tool (roadmap doc's Surface section; phase D wiring): one
  // persistent VM per project context, restored from the daemon's
  // per-project repl store on first touch and reconciled; the snapshot
  // sink attached by `ensureReplWorkspace` persists every state-changing
  // boundary. The wasm is the engine's shipped binary (its hash is the
  // snapshot envelope's identity — a version bump refuses loudly).
  registerReplTool(mcp, {
    projects,
    wasm: loadShippedWasm(),
    requireProjectDir,
    runner: options.replRunner,
    evalTimeoutMs: replEvalTimeoutMs(),
    presence: replPresence,
    clientId: options.replClientId ?? (() => "single-project"),
    evalBreakChannel: replEvalBreakChannel,
    acceptingWork: () => acceptingWork,
  });

  const workflowToolConfig = {
    title: "Discover, validate, run, inspect, await, stop, or narrow-cancel an agent workflow",
    description:
        "Author and operate JavaScript agent workflows through one project-scoped tool. " +
        "A script's first statement must be `export const meta = { name, description, phases? }`. When present, phases must be an array of objects shaped `{ title: string, detail?: string, model?: string }`, never an array of strings. " +
        "Inside the deterministic script realm use agent(prompt, options?) for one subagent; parallel([thunks]) for a barrier; " +
        "pipeline(items, ...stages) for streaming stages; checkpoint(prompt, options?) for a human gate; phase(title) and log(message) " +
        "for progress; and return the final JSON-serializable value. Top-level await is supported. Imports, require, network APIs, " +
        "Date.now(), and Math.random() are unavailable. Always label agent calls; schema is a plain JSON Schema object for structured results. " +
        "The only agent option keys are label, phase, model, tier, mode, configOptions, schema, cwd, timeoutMs, retries, isolation:\"worktree\", resume, agentType, mcpServers, images, meta, promptMeta, and keepSession; unknown keys reject before admission. " +
        "Every parallel entry must be a thunk: parallel([() => agent(...), () => agent(...)]). For deeper syntax, read docs topic workflow/quickstart and then one related workflow/* topic. " +
        "Minimal script: `export const meta = { name: \"review\", description: \"Review a target\", phases: [{ title: \"Review\" }] }; phase(\"Review\"); const report = await agent(\"Review \" + args.target, { label: \"review\" }); return { report };`. " +
        "Omit model for the server default, or use a backend name alone to preserve that backend's configured default. " +
        "Before choosing a pinned model, mode, or configOptions, call action:\"config\" with projectDir and optional harnesses/modelFilter; after choosing a model, pass modelSpecs to read its model-specific options. " +
        "Set mode only when that selected harness entry's modes.availableModes explicitly lists the exact id; modes:null means unsupported, so omit mode—never infer a default from an absent value. " +
        "Config opens no-prompt sessions, spends zero tokens, and starts no workflow. " +
        "action:\"run\" automatically performs static validation, a mocked dry run, and routed config checks before admission. " +
        "Invalid scripts return bounded diagnostics with status:\"rejected\" and create no run ID, reserve no background slot, and spend no tokens. " +
        "Run, resume, inspect, await, or stop an admitted workflow through the same tool. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over registry built-ins—currently Claude, Codex, OpenCode, and pi—" +
        "ACP backends, plus registered custom agents. Supply exactly one of inline script or absolute scriptPath; path content is " +
        "read once and snapshotted at admission. " +
        (requireProjectDir
          ? "config and run REQUIRE projectDir (absolute): it is the discovery cwd and selects the project-scoped run store/default execution cwd. "
          : "run optionally takes projectDir (absolute) to select the project-scoped run store; default is this server's own project. ") +
        "inspect/await/stop take only a runId — it locates its project store automatically. " +
        "Foreground is the default and streams progress; background:true returns " +
        "a durable runId for bounded action:\"await\" calls. run and await honor _meta.progressToken " +
        "with notifications/progress while they block. Pass resumeFromRunId to execute a new " +
        "run from a prior journal prefix. " +
        "In hosts that render MCP Apps, every call of this tool shows a live self-updating run-monitor " +
        "panel and the panel reports phase starts, pauses, and terminal outcomes on its own — do NOT poll " +
        'action:"inspect" to check on a run there; prefer a single bounded action:"await". ' +
        'Use action:"inspect" with a runId when you need machine-readable status data: a safe bounded status, log tail, and attributed call previews. ' +
        'Use action:"stop" to durably abort a live run; add callIndex to cancel only that in-flight agent ' +
        "and keep the run live. labelGlob remains an output filter in both forms. A whole-run stop returns " +
        "the final run fate; resume is safe immediately, and only agent-session wind-down can remain asynchronous. " +
        "Every admitted script is readable at workflow://runs/{runId}/script and results include resource links. " +
        "Background runs are tracked per project, capped at four active/starting runs, and use " +
        "headless checkpoint semantics; checkpointReplies continue a checkpoint pause in a new run.",
    inputSchema: workflowToolInputShape,
    outputSchema: workflowToolOutputShape,
    annotations: undefined,
  };

  const workflowToolHandler: ToolCallback<typeof workflowToolInputShape> = async (args, extra) => {
      if (!acceptingWork) {
        throw new McpError(
          ErrorCode.InternalError,
          "Workflow server is shutting down and is no longer accepting tool calls.",
        );
      }
      const parsedInput = parseWorkflowToolInput(args, { requireProjectDir });
      if (parsedInput.action === "config") {
        let cwd = defaultContext?.projectDir;
        if (parsedInput.projectDir !== undefined) {
          const resolution = resolveProjectDir(parsedInput.projectDir);
          if (!resolution.ok) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid workflow tool input: ${resolution.message}`);
          }
          cwd = resolution.projectDir;
        }
        if (cwd === undefined) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid workflow tool input: config requires projectDir on this server");
        }
        if (parsedInput.modelFilter !== undefined) {
          try {
            buildModelFilter(parsedInput.modelFilter);
          } catch (error) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid workflow tool input: modelFilter is invalid — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const report = await probeHarnessConfig({
          harnesses: parsedInput.harnesses,
          modelSpecs: parsedInput.modelSpecs,
          cwd,
          timeoutMs: parsedInput.probeTimeoutMs,
          probeRunner,
        });
        let projected;
        try {
          projected = configSummary(report, parsedInput.modelFilter);
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid workflow tool input: modelFilter is invalid — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          structuredContent: projected,
          content: [{ type: "text", text: configText(report, parsedInput.modelFilter) }],
          isError: false,
        };
      }
      const context = resolveContext(parsedInput);
      if (context === undefined) {
        // Only reachable for runId actions whose run exists in no known project store.
        return {
          content: [
            {
              type: "text",
              text: `No workflow run found for runId "${(parsedInput as { runId: string }).runId}" in any project-scoped run store known to this server.`,
            },
          ],
          isError: true,
        };
      }
      // Project-presence registration for the REPL's client-presence
      // drain (phase-E review rejection round 2): the workflow tool
      // resolves the SAME per-project context the repl tool addresses,
      // and a session that calls it is connected to the project for the
      // doc's "any MCP client connected to the project" warmth rule.
      // The repl STATE is created if missing — a pure-workflow project
      // keeps a stateless context (no VM: the workspace is materialized
      // only on the first repl tool touch); the state is what the
      // presence ledger keys presence by, so a workflow-only client B
      // staying connected keeps the workspace warm when repl-client A
      // disconnects.
      if (context.repl === undefined) context.repl = createReplProjectState(context.projectDir);
      replPresence.touch(context.repl, options.replClientId?.() ?? "unknown");
      const manager = context.manager;
      const backgroundRuns = context.backgroundRuns;
      if ((parsedInput.action === undefined || parsedInput.action === "run") && parsedInput.resumeFromRunId !== undefined) {
        // Cross-project resume is an explicit redirect, never a silent miss in the wrong store.
        if (!manager.getPersistence().load(parsedInput.resumeFromRunId)) {
          const elsewhere = projects.storeFor(parsedInput.resumeFromRunId);
          if (elsewhere !== undefined && elsewhere !== context) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `resumeFromRunId "${parsedInput.resumeFromRunId}" belongs to project "${elsewhere.projectDir}". ` +
                    `Re-send the run with projectDir: "${elsewhere.projectDir}" to resume it there.`,
                },
              ],
              isError: true,
            };
          }
        }
      }
      if (parsedInput.action === "inspect") {
        const status = manager.inspectRun(parsedInput.runId, {
          lastN: parsedInput.lastN,
          labelGlob: parsedInput.labelGlob,
          logLines: parsedInput.logLines,
        });
        if (!status) {
          return {
            content: [
              {
                type: "text",
                text: `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
              },
            ],
            isError: true,
          };
        }
        const lineage = scriptResources.lineage(parsedInput.runId);
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: workflowScriptUri(parsedInput.runId),
            lineage,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        return {
          structuredContent: { ...projected },
          content: [
            // Status summaries are model input, not user-facing chat content (the run-monitor
            // panel is the user's live view) — the audience annotation says so per MCP core.
            {
              type: "text",
              text: formatInspectionSummary(projected),
              annotations: { audience: ["assistant"] },
            },
            ...scriptResources.links(lineage),
          ],
          isError: false,
        };
      }

      if (parsedInput.action === "stop") {
        if (!manager.getRun(parsedInput.runId)) {
          manager.reconcileExternallyDeadRun(parsedInput.runId);
        }
        const persisted = manager.getPersistence().load(parsedInput.runId);
        if (!persisted) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
          );
        }

        const inspectionOptions = {
          lastN: parsedInput.lastN,
          labelGlob: parsedInput.labelGlob,
          logLines: parsedInput.logLines,
        };
        if (parsedInput.callIndex !== undefined) {
          if (isAlreadyTerminalForStop(persisted.status)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Workflow run "${parsedInput.runId}" is already terminal (${persisted.status}); no agent call is in flight to cancel. Whole-run stop without callIndex is a successful no-op for terminal runs.`,
            );
          }
          if (!manager.getRun(parsedInput.runId)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Workflow run "${parsedInput.runId}" is persisted as ${persisted.status}, but there is nothing live to cancel in this server process.`,
            );
          }

          let cancellation: WorkflowAgentCallCancellation;
          try {
            cancellation = await manager.cancelAgentCall(parsedInput.runId, parsedInput.callIndex);
          } catch (error) {
            throw new McpError(
              error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR
                ? ErrorCode.InternalError
                : ErrorCode.InvalidParams,
              error instanceof Error ? error.message : String(error),
            );
          }
          const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
          if (!status) {
            throw new McpError(
              ErrorCode.InternalError,
              `Workflow agent cancellation did not produce a snapshot for runId "${parsedInput.runId}".`,
            );
          }
          const lineage = scriptResources.lineage(parsedInput.runId);
          const projected = addInspectionResourceFields(
            status,
            {
              scriptUri: workflowScriptUri(parsedInput.runId),
              lineage,
            },
            inspectionRetentionMetadata(manager, parsedInput.runId, status),
          );
          return {
            structuredContent: { ...projected },
            content: [
              { type: "text", text: formatAgentCancellationSummary(projected, cancellation) },
              ...scriptResources.links(lineage),
            ],
            isError: false,
          };
        }

        let stopped = false;
        let alreadyTerminal = isAlreadyTerminalForStop(persisted.status);
        if (!alreadyTerminal) {
          const live = manager.getRun(parsedInput.runId);
          if (!live) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Workflow run "${parsedInput.runId}" is persisted as ${persisted.status}, but there is nothing live to stop in this server process. Resume it with resumeFromRunId instead.`,
            );
          }
          stopped = manager.stop(parsedInput.runId);
          if (!stopped) {
            const current = manager.getPersistence().load(parsedInput.runId);
            alreadyTerminal = current !== null && isAlreadyTerminalForStop(current.status);
            if (!alreadyTerminal) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Workflow run "${parsedInput.runId}" could not be stopped; its persisted status is ${current?.status ?? persisted.status}.`,
              );
            }
          } else {
            scriptResources.cancelPendingElicitation(parsedInput.runId);
            requireDurableStoppedRun(manager, parsedInput.runId);
          }
        }

        const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
        if (!status) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
          );
        }
        if (status.status === "pending" || status.status === "running" || status.status === "paused") {
          throw new McpError(
            ErrorCode.InternalError,
            `Workflow stop did not produce a terminal snapshot for runId "${parsedInput.runId}".`,
          );
        }
        backgroundRuns.evict(parsedInput.runId);
        const lineage = scriptResources.lineage(parsedInput.runId);
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: workflowScriptUri(parsedInput.runId),
            lineage,
            stopped,
            alreadyTerminal,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        const result: WorkflowStopResult = { ...projected, status: status.status };
        const currentLink = scriptResources
          .links(lineage)
          .filter((link) => link.uri === workflowScriptUri(parsedInput.runId));
        return {
          structuredContent: { ...result },
          content: [{ type: "text", text: formatStopSummary(result) }, ...currentLink],
          isError: false,
        };
      }

      if (parsedInput.action === "await") {
        if (extra.signal.aborted) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow await for runId "${parsedInput.runId}" was cancelled; the workflow was not cancelled.`,
              },
            ],
            isError: true,
          };
        }

        const inspectionOptions = {
          lastN: parsedInput.lastN,
          labelGlob: parsedInput.labelGlob,
          logLines: parsedInput.logLines,
        };
        const startedAt = Date.now();
        if (!manager.getRun(parsedInput.runId)) {
          manager.reconcileExternallyDeadRun(parsedInput.runId);
        }
        let status = manager.inspectRun(parsedInput.runId, inspectionOptions);
        if (!status) {
          return {
            content: [
              {
                type: "text",
                text: `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
              },
            ],
            isError: true,
          };
        }

        let returnedBecause: WorkflowRunAwaitResult["wait"]["returnedBecause"];
        if (isTerminalStatus(status.status)) {
          returnedBecause = "terminal";
        } else if (parsedInput.waitMs === 0) {
          returnedBecause = "immediate";
        } else {
          const waited = await waitForTerminal(
            manager,
            parsedInput.runId,
            parsedInput.waitMs ?? 20_000,
            extra.signal,
            backgroundRuns.get(parsedInput.runId),
            createAwaitProgressReporter(extra),
          );
          if (waited === AWAIT_CANCELLED) {
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow await for runId "${parsedInput.runId}" was cancelled; the workflow was not cancelled.`,
                },
              ],
              isError: true,
            };
          }
          if (waited === AWAIT_UNKNOWN_RUN) {
            return {
              content: [
                {
                  type: "text",
                  text: `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
                },
              ],
              isError: true,
            };
          }
          status = manager.inspectRun(parsedInput.runId, inspectionOptions);
          if (!status) {
            return {
              content: [
                {
                  type: "text",
                  text: `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
                },
              ],
              isError: true,
            };
          }
          returnedBecause = isTerminalStatus(status.status) ? "terminal" : "timeout";
        }

        const tokenUsage = currentTokenUsage(manager, parsedInput.runId);
        const baseOutcome = isTerminalStatus(status.status)
          ? terminalOutcome(manager, parsedInput.runId, status)
          : undefined;
        const outcome = baseOutcome;
        const lineage = scriptResources.lineage(parsedInput.runId);
        const wait = {
          requestedMs: parsedInput.waitMs ?? 20_000,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          returnedBecause,
        };
        const projected = addInspectionResourceFields(
          status,
          {
            wait,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            scriptUri: workflowScriptUri(parsedInput.runId),
            lineage,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        const result: WorkflowRunAwaitResult = {
          ...projected,
          ...(outcome === undefined ? {} : { outcome }),
        };
        return {
          structuredContent: { ...result },
          content: [
            // Same audience hint as inspect: the await summary is for the model.
            {
              type: "text",
              text: formatAwaitSummary(result),
              annotations: { audience: ["assistant"] },
            },
            ...scriptResources.links(lineage),
          ],
          isError: false,
        };
      }

      const input = clampWorkflowInput(parsedInput);
      const scriptSource = input.script === undefined ? "path" as const : "inline" as const;
      const admittedScript = input.script ?? readScriptAtAdmission(input.scriptPath);
      let backgroundReservation = false;
      const executionLatch = createExecutionAdmissionLatch();
      let elicitationController: AbortController | undefined;
      let cancelElicitationFromRequest: (() => void) | undefined;
      let foregroundRunId: string | undefined;
      let preflightWarningText = "";
      try {
        // Static validation is the first admission boundary: malformed scripts never reserve a
        // background slot, create a run ID, write run state, open a backend, or spend tokens.
        const staticValidation = await validateWorkflowScript(admittedScript, {
          args: input.args,
          dryRun: false,
        });
        if (!staticValidation.ok) {
          const validation = validationSummary(staticValidation);
          return {
            structuredContent: { action: "run" as const, status: "rejected" as const, validation },
            content: [{ type: "text", text: validationText(staticValidation) }],
            isError: true,
          };
        }

        // Trust gate for script-declared meta.backends — BEFORE any run exists. A refusal is an
        // informative tool error (never a silent drop, never a hang on a non-eliciting client).
        const backendsGate = await resolveScriptBackends(mcp.server, admittedScript, backendApprovals);
        if (!backendsGate.ok) {
          return {
            content: [{ type: "text", text: backendsGate.message }],
            isError: true,
          };
        }

        // Full zero-token preflight: execute control flow against the mock runner, resolve
        // host-served nested workflows, then probe each routed backend/model without prompting.
        // Invalid scripts are diagnostics, not failed runs: admission has not started yet.
        const preflight = await validateWorkflowScript(admittedScript, {
          args: input.args,
          cwd: context.projectDir,
          maxAgents: input.maxAgents,
          timeoutMs: 30_000,
          probeTimeoutMs: 60_000,
          probeRunner,
          loadSavedWorkflow: (name) => context.manager.resolveSavedWorkflow(name),
        });
        if (!preflight.ok) {
          const validation = validationSummary(preflight);
          return {
            structuredContent: { action: "run" as const, status: "rejected" as const, validation },
            content: [{ type: "text", text: validationText(preflight) }],
            isError: true,
          };
        }
        if (preflight.warnings.length > 0) {
          const lines = preflight.warnings.slice(0, 20).map((warning) => `- ${warning}`);
          if (preflight.warnings.length > lines.length) {
            lines.push(`- … ${preflight.warnings.length - lines.length} more warning(s) omitted`);
          }
          preflightWarningText = truncateUtf8(
            `\nPreflight warnings (the run was admitted):\n${lines.join("\n")}`,
            4_096,
            "…[preflight warnings truncated]",
          );
        }

        if (input.background) {
          if (!backgroundRuns.reserve()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Background workflow limit reached (4 active or starting runs). Await an existing run and retry.",
                },
              ],
              isError: true,
            };
          }
          backgroundReservation = true;
        }

        const exec: ExecOptions = {
          agent: runner,
          executionAdmission: executionLatch.decision,
          scriptBackends: backendsGate.backends,
          maxAgents: input.maxAgents,
          concurrency: input.concurrency,
          agentRetries: input.agentRetries,
          agentTimeoutMs: input.agentTimeoutMs,
          resumeFromRunId: input.resumeFromRunId,
          resumePolicy: input.resumePolicy,
          checkpointReplies: input.checkpointReplies,
        };
        if (!input.background) {
          const reporter = createProgressReporter(extra);
          let lastActivitySeq = 0;
          exec.signal = extra.signal;
          // The engine drives progress with the live snapshot; project it onto the MCP wire
          // shape (settled agents / total seen so far / current phase). `settled` is monotonic.
          exec.onProgress = (snapshot: WorkflowSnapshot) => {
            const settled = snapshot.agents.filter(
              (a) => a.status === "done" || a.status === "error" || a.status === "skipped",
            ).length;
            const activity = snapshot.latestActivity;
            if (activity && activity.seq > lastActivitySeq) {
              lastActivitySeq = activity.seq;
              reporter(settled, snapshot.agents.length || undefined, formatAgentProgressMessage(activity.progress));
            } else {
              reporter(settled, snapshot.agents.length || undefined, snapshot.currentPhase);
            }
          };
          // A callback is a LIVE channel and therefore wins over headless:"pause". Do not
          // install a defaulting shim for non-elicitation clients; the authored headless mode
          // must remain visible to the engine.
          if (mcp.server.getClientCapabilities()?.elicitation) {
            elicitationController = new AbortController();
            cancelElicitationFromRequest = () => elicitationController?.abort();
            extra.signal.addEventListener("abort", cancelElicitationFromRequest, { once: true });
            if (extra.signal.aborted) elicitationController.abort();
            exec.confirm = createConfirm(mcp.server, elicitationController.signal);
          }
        }

        if (input.background) {
          const started = manager.startInBackground(admittedScript, input.args, exec);
          requireAdmissionResource(
            manager,
            scriptResources,
            started.runId,
            admittedScript,
            executionLatch.deny,
          );
          const admittedRun = manager.getRun(started.runId);
          if (!admittedRun?.limits) {
            throw new McpError(ErrorCode.InternalError, "Workflow admission did not resolve run limits");
          }
          executionLatch.admit();
          const workflowName = admittedRun.snapshot.name;
          backgroundRuns.track(started.runId, started.promise);
          backgroundReservation = false;
          const scriptUri = workflowScriptUri(started.runId);
          const links = scriptResources.links([
            { runId: started.runId, uri: scriptUri, available: true },
          ]);
          return {
            structuredContent: {
              runId: started.runId,
              status: "running" as const,
              scriptSource,
              scriptUri,
              limits: admittedRun.limits,
              ...(admittedRun.replayEligibility === undefined
                ? {}
                : { replayEligibility: admittedRun.replayEligibility }),
            },
            content: [
              {
                type: "text",
                text:
                  `Workflow "${workflowName}" started in the background.\n` +
                  `runId: ${started.runId}\n` +
                  (preflightWarningText ? `${preflightWarningText.trimStart()}\n` : "") +
                  (admittedRun.replayEligibility
                    ? `${formatResumeSummary(admittedRun.replayEligibility)}\n`
                    : "") +
                  `Call workflow with action="await" and this runId to wait for its result, or ` +
                  `action="inspect" for an immediate status snapshot. If a live run-monitor panel ` +
                  `is shown for this run, it self-updates and reports phase starts, pauses, and terminal outcomes — ` +
                  `do not poll inspect for status.`,
              },
              ...links,
            ],
            isError: false,
          };
        }

        // startInBackground reveals the manager-owned run ID immediately after the initial save.
        // Read that record back before awaiting the promise so no foreground result is acknowledged
        // unless its immutable script resource is already durable.
        const started = manager.startInBackground(admittedScript, input.args, exec);
        foregroundRunId = started.runId;
        scriptResources.trackPendingElicitation(started.runId, elicitationController);
        requireAdmissionResource(
          manager,
          scriptResources,
          started.runId,
          admittedScript,
          () => {
            executionLatch.deny();
            scriptResources.cancelPendingElicitation(started.runId);
          },
        );
        executionLatch.admit();
        const run = await settleForegroundRun(manager, started);
        const scriptUri = workflowScriptUri(run.runId);
        const structuredContent = {
          ...toWorkflowToolResult(run, { scriptSource, scriptUri }),
        };
        const isError = run.status === "failed" || run.status === "aborted";
        return {
          structuredContent: { ...structuredContent },
          content: [
            { type: "text", text: `${formatRunSummary(run)}${preflightWarningText}` },
            ...scriptResources.links([{ runId: run.runId, uri: scriptUri, available: true }]),
          ],
          isError,
        };
      } finally {
        executionLatch.deny();
        if (foregroundRunId) scriptResources.cancelPendingElicitation(foregroundRunId);
        else elicitationController?.abort();
        if (cancelElicitationFromRequest) {
          extra.signal.removeEventListener("abort", cancelElicitationFromRequest);
        }
        if (backgroundReservation) backgroundRuns.releaseReservation();
      }
  };

  // The tool itself is registered HERE, at construction — never behind the initialized
  // notification. `notifications/initialized` carries no ordering guarantee against the
  // requests that follow it (a client may pipeline it with its first tools/list or
  // tools/call, and over the stdio shim those arrive as independent HTTP POSTs), so gating
  // the tool on that notification let a client's very first request reach a server with
  // nothing registered: an empty tools/list, or a tool-not-found result on the first call.
  const workflowTool = mcp.registerTool("workflow", workflowToolConfig, workflowToolHandler);

  // Only the MCP Apps surface is negotiated, and it can be: the initialize request is the
  // first point at which the client's MCP Apps MIME support is known, and a client that
  // never advertised the extension has no use for the panel anyway. Adding it here also
  // emits tools/list_changed, so a capable client re-lists and picks up the UI metadata.
  // Preserve any callback installed by a caller before composing this hook.
  const previousOnInitialized = mcp.server.oninitialized;
  mcp.server.oninitialized = () => {
    previousOnInitialized?.();
    const uiCap = getUiCapability(mcp.server.getClientCapabilities());
    if (uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE) !== true) return;
    registerWorkflowAppUi(mcp, {
      readEventsPage: (request) => scriptResources.readEventsPage(request),
      registerResourceReader: (uri, read) => scriptResources.registerExternalResourceReader(uri, read),
    });
    // The same normalization registerAppTool applies: both the nested and the flat key.
    workflowTool.update({
      _meta: {
        ui: { resourceUri: RUN_MONITOR_RESOURCE_URI },
        [RESOURCE_URI_META_KEY]: RUN_MONITOR_RESOURCE_URI,
      },
    });
  };

  return server;
}
