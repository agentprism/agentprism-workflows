// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the single `workflow` tool
// (plus the user-controlled `author-workflow` prompt — see authoring-prompt.ts), and is the
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

import { parseWorkflowScript, redactText, truncateUtf8, WorkflowManager } from "@automatalabs/workflows";
import type {
  ExecOptions,
  PersistedRunState,
  WorkflowSnapshot,
  AgentRunner,
  WorkflowBackendConfig,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowResumeReport,
} from "@automatalabs/workflows";
import type { TokenUsage } from "@automatalabs/shared-types";

import { clampWorkflowInput, parseWorkflowToolInput, workflowToolInputShape } from "./workflow-tool-input.js";
import { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
import type {
  WorkflowExecutionToolResult,
  WorkflowRunAwaitResult,
  WorkflowStopResult,
} from "./workflow-tool-output.js";
import { createAwaitProgressReporter, createProgressReporter } from "./progress.js";
import type { AwaitProgressReporter } from "./progress.js";
import { registerAuthoringPrompt } from "./authoring-prompt.js";
import { WorkflowScriptResources, workflowScriptUri } from "./workflow-resources.js";

const SERVER_NAME = "agentprism-workflow";
const require = createRequire(import.meta.url);
const SERVER_VERSION = (require("../package.json") as { version: string }).version;

export const MAX_BACKGROUND_RUNS = 4;

const TERMINAL_STATUSES = new Set(["paused", "completed", "failed", "aborted"]);

function isTerminalStatus(status: WorkflowRunStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isAlreadyTerminalForStop(status: WorkflowRunStatus["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

class BackgroundRunRegistry {
  private starting = 0;
  private readonly active = new Map<string, Promise<WorkflowRunResult>>();

  reserve(): boolean {
    if (this.starting + this.active.size >= MAX_BACKGROUND_RUNS) return false;
    this.starting++;
    return true;
  }

  releaseReservation(): void {
    if (this.starting > 0) this.starting--;
  }

  track(runId: string, promise: Promise<WorkflowRunResult>): void {
    this.releaseReservation();
    this.active.set(runId, promise);
    void promise.then(
      () => this.active.delete(runId),
      () => this.active.delete(runId),
    );
  }

  get(runId: string): Promise<WorkflowRunResult> | undefined {
    return this.active.get(runId);
  }
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
  if (run.resumeReport) lines.push(formatResumeSummary(run.resumeReport));
  return lines.join("\n");
}

function formatResumeSummary(report: WorkflowResumeReport): string {
  const strategy = report.strategy === "positional-v1"
    ? `${report.strategy}/${report.eligibility}`
    : report.strategy;
  return `resume: ${strategy}, ${report.replayed} replayed, ${report.live} live, ${report.failed} failed`;
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
  if (run.resumeReport) lines.push(formatResumeSummary(run.resumeReport));
  if (run.status === "paused") {
    // Read the STRUCTURED authContext (§2.12) — never the free-form `reason` message string.
    if (run.reason === "auth_required" && run.authContext) {
      const backendId = run.authContext.backendId ?? "?";
      lines.push(`This run needs authentication for backend "${backendId}".`);
      for (const m of run.authContext.methods) {
        lines.push(`  - ${m.id} (${m.type})${m.name ? `: ${m.name}` : ""}`);
      }
      lines.push(
        `Agents authenticate from their own CLI credentials: log that backend's CLI in on this ` +
          `machine (e.g. \`claude /login\`, \`codex login\`, \`opencode auth login\`), ` +
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

function inspectionSummaryLines(status: WorkflowRunStatus): string[] {
  const lines = [`Workflow "${status.workflowName}" is ${status.status}.`, `runId: ${status.runId}`];
  if (status.phases.length > 0) lines.push(`phases: ${status.phases.join(", ")}`);
  if (status.currentPhase) lines.push(`current phase: ${status.currentPhase}`);
  if (status.reason) lines.push(`reason: ${status.reason}`);
  if (status.errorCode) lines.push(`error code: ${status.errorCode}`);
  lines.push(`recent run log (last ${status.logTail.lines.length} of ${status.logTail.totalLines}):`);
  for (const line of status.logTail.lines) lines.push(`  ${line}`);
  lines.push(`recent calls (${status.calls.length} of ${status.truncation.calls.matched} matching):`);
  for (const call of status.calls) {
    const attribution = call.label ? `${call.kind} "${call.label}"` : call.kind;
    const phase = call.phase ? ` in ${call.phase}` : "";
    lines.push(`  [${call.index}] ${attribution}${phase}: ${call.resultPreview}`);
  }
  return lines;
}

/** Human-readable inspection text generated only from the bounded safe status payload. */
function formatInspectionSummary(status: WorkflowRunStatus): string {
  return truncateUtf8(inspectionSummaryLines(status).join("\n"), 8_192, "…[text truncated]");
}

const MAX_INSPECTION_STRUCTURED_BYTES = 24_576;

function addInspectionResourceFields(
  status: WorkflowRunStatus,
  fields: { scriptUri: string; lineage: ReturnType<WorkflowScriptResources["lineage"]> },
): WorkflowRunStatus & typeof fields {
  const projected: WorkflowRunStatus & typeof fields = {
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
  // Leave room for stop's two acknowledgement booleans, which extend the same projection.
  const tooLarge = () =>
    Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_INSPECTION_STRUCTURED_BYTES - 128;

  while (projected.calls.length > 0 && tooLarge()) {
    projected.calls.shift();
    projected.truncation.calls.returned = projected.calls.length;
    projected.truncation.byteCapApplied = true;
  }
  while (projected.logTail.lines.length > 0 && tooLarge()) {
    projected.logTail.lines.shift();
    projected.logTail.omittedLines = Math.max(
      projected.logTail.omittedLines,
      projected.logTail.totalLines - projected.logTail.lines.length,
    );
    projected.truncation.logs.returned = projected.logTail.lines.length;
    projected.truncation.byteCapApplied = true;
  }
  while (projected.phases.length > 0 && tooLarge()) {
    projected.phases.pop();
    projected.truncation.phases.returned = projected.phases.length;
    projected.truncation.byteCapApplied = true;
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
): WorkflowExecutionToolResult {
  return {
    runId: persisted.runId,
    status: status.status,
    ...(status.status === "completed" && persisted.result !== undefined ? { result: persisted.result } : {}),
    tokenUsage: normalizeTokenUsage(persisted.tokenUsage),
    logs: persisted.logs,
    ...(status.status === "completed" ? {} : { logTail: status.logTail }),
    authContext: persisted.authContext,
    checkpointContext: persisted.checkpointContext,
    ...(persisted.fallbacks === undefined ? {} : { fallbacks: persisted.fallbacks }),
    ...(persisted.checkpointsTaken === undefined ? {} : { checkpointsTaken: persisted.checkpointsTaken }),
    ...(persisted.resumeReport === undefined ? {} : { resumeReport: persisted.resumeReport }),
  };
}

function terminalOutcome(
  manager: WorkflowManager,
  runId: string,
  status: WorkflowRunStatus,
): WorkflowExecutionToolResult | undefined {
  const live = manager.getRun(runId)?.result;
  if (live) return toWorkflowToolResult(live);
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
  const [heading, runId, ...diagnostics] = inspectionSummaryLines(result);
  const lines = [heading, runId];
  lines.push(
    `wait: ${result.wait.returnedBecause} after ${result.wait.elapsedMs}ms (requested ${result.wait.requestedMs}ms)`,
  );
  if (result.outcome?.resumeReport) lines.push(formatResumeSummary(result.outcome.resumeReport));
  if (result.status === "paused" && result.outcome) {
    if (result.reason === "auth_required" && result.outcome.authContext) {
      const backendId = result.outcome.authContext.backendId ?? "?";
      lines.push(`This run needs authentication for backend "${backendId}".`);
      for (const method of result.outcome.authContext.methods) {
        lines.push(`  - ${method.id} (${method.type})${method.name ? `: ${method.name}` : ""}`);
      }
      lines.push(
        `Agents authenticate from their own CLI credentials: log that backend's CLI in on this ` +
          `machine (e.g. \`claude /login\`, \`codex login\`, \`opencode auth login\`), then start a new ` +
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
 * Build the MCP server with the single `workflow` tool registered — the whole model-facing
 * tool surface — plus the user-controlled `author-workflow` prompt (the bundled authoring
 * guide; prompts are a separate MCP primitive and never enter the model's tool-selection
 * loop). Backend auth is the agents' own concern (their CLI credential stores); a run that
 * genuinely hits AUTH_REQUIRED pauses with authContext and resumes after an out-of-band CLI
 * login. The AgentRunner is the DI seam: it is injected here into a single
 * WorkflowManager (so persistence — and therefore resume — is shared across calls) and every run goes
 * through manager.runSync or startInBackground. The returned McpServer is not yet connected — the caller attaches a
 * transport (see index.ts).
 */
export function createWorkflowServer(runner: AgentRunner): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  // registerCapabilities is illegal after a transport attaches. Merge the complete resources
  // capability before resource/handler registration and before createWorkflowServer returns.
  mcp.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. The
  // manager owns run lifecycle, status stamping, and the persisted journal used by resume.
  const manager = new WorkflowManager({ agent: runner });
  const scriptResources = new WorkflowScriptResources(mcp, manager);
  const backgroundRuns = new BackgroundRunRegistry();
  // Session-sticky approvals for script-declared backends (one prompt per unique spawn config).
  const backendApprovals: BackendApprovals = new Set();

  registerAuthoringPrompt(mcp);

  mcp.registerTool(
    "workflow",
    {
      title: "Run, inspect, await, or stop a dynamic agent workflow",
      description:
        "Run, resume, inspect, await, or stop a JavaScript agent workflow through one project-scoped tool. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over the injected " +
        "ACP agent backend. Supply exactly one of inline script or absolute scriptPath; path content is " +
        "read once and snapshotted at admission. Foreground is the default and streams progress; background:true returns " +
        "a durable runId for bounded action:\"await\" calls. Pass resumeFromRunId to execute a new " +
        "run from a prior journal prefix. " +
        'Use action:"inspect" with a runId for a safe bounded status, log tail, and attributed call previews. ' +
        'Use action:"stop" to durably abort a live run; its returned snapshot is the final run fate, ' +
        "resume is safe immediately, and only agent-session wind-down can remain asynchronous. " +
        "Every admitted script is readable at workflow://runs/{runId}/script and results include resource links. " +
        "Background is tied to this server process, capped at four active/starting runs, and uses " +
        "headless checkpoint semantics; checkpointReplies continue a checkpoint pause in a new run.",
      inputSchema: workflowToolInputShape,
      outputSchema: workflowToolOutputShape,
    },
    async (args, extra) => {
      const parsedInput = parseWorkflowToolInput(args);
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
        const projected = addInspectionResourceFields(status, {
          scriptUri: workflowScriptUri(parsedInput.runId),
          lineage,
        });
        return {
          structuredContent: { ...projected },
          content: [
            { type: "text", text: formatInspectionSummary(projected) },
            ...scriptResources.links(lineage),
          ],
          isError: false,
        };
      }

      if (parsedInput.action === "stop") {
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
          }
        }

        const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
        if (!status) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
          );
        }
        const lineage = scriptResources.lineage(parsedInput.runId);
        const projected = addInspectionResourceFields(status, {
          scriptUri: workflowScriptUri(parsedInput.runId),
          lineage,
        });
        const result: WorkflowStopResult = {
          ...projected,
          stopped,
          alreadyTerminal,
        };
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
        const outcome = baseOutcome
          ? {
              ...baseOutcome,
              scriptSource: scriptResources.scriptSource(parsedInput.runId),
              scriptUri: workflowScriptUri(parsedInput.runId),
            }
          : undefined;
        const lineage = scriptResources.lineage(parsedInput.runId);
        const result: WorkflowRunAwaitResult = {
          ...status,
          wait: {
            requestedMs: parsedInput.waitMs ?? 20_000,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            returnedBecause,
          },
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          ...(outcome === undefined ? {} : { outcome }),
          scriptUri: workflowScriptUri(parsedInput.runId),
          lineage,
        };
        return {
          structuredContent: { ...result },
          content: [
            { type: "text", text: formatAwaitSummary(result) },
            ...scriptResources.links(lineage),
          ],
          isError: false,
        };
      }

      const input = clampWorkflowInput(parsedInput);
      const scriptSource = input.script === undefined ? "path" as const : "inline" as const;
      const admittedScript = input.script ?? readScriptAtAdmission(input.scriptPath);
      let backgroundReservation = false;
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

      try {
        // Trust gate for script-declared meta.backends — BEFORE any run exists. A refusal is an
        // informative tool error (never a silent drop, never a hang on a non-eliciting client).
        const backendsGate = await resolveScriptBackends(mcp.server, admittedScript, backendApprovals);
        if (!backendsGate.ok) {
          return {
            content: [{ type: "text", text: backendsGate.message }],
            isError: true,
          };
        }

        const exec: ExecOptions = {
          scriptBackends: backendsGate.backends,
          maxAgents: input.maxAgents,
          concurrency: input.concurrency,
          agentRetries: input.agentRetries,
          agentTimeoutMs: input.agentTimeoutMs,
          tokenBudget: input.tokenBudget,
          resumeFromRunId: input.resumeFromRunId,
          resumePolicy: input.resumePolicy,
          checkpointReplies: input.checkpointReplies,
        };

        let elicitationController: AbortController | undefined;
        let cancelElicitationFromRequest: (() => void) | undefined;
        if (!input.background) {
          const reporter = createProgressReporter(extra);
          exec.signal = extra.signal;
          // The engine drives progress with the live snapshot; project it onto the MCP wire
          // shape (settled agents / total seen so far / current phase). `settled` is monotonic.
          exec.onProgress = (snapshot: WorkflowSnapshot) => {
            const settled = snapshot.agents.filter(
              (a) => a.status === "done" || a.status === "error" || a.status === "skipped",
            ).length;
            reporter(settled, snapshot.agents.length || undefined, snapshot.currentPhase);
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
          const admission = scriptResources.beginAdmission({
            script: admittedScript,
            scriptSource,
            resumeSourceRunId: input.resumeFromRunId,
          });
          try {
            const started = manager.startInBackground(admittedScript, input.args, exec);
            const workflowName = manager.getRun(started.runId)?.snapshot.name ?? "workflow";
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
              },
              content: [
                {
                  type: "text",
                  text:
                    `Workflow "${workflowName}" started in the background.\n` +
                    `runId: ${started.runId}\n` +
                    `Call workflow with action="await" and this runId to wait for its result, or ` +
                    `action="inspect" for an immediate status snapshot.`,
                },
                ...links,
              ],
              isError: false,
            };
          } finally {
            scriptResources.finishAdmission(admission);
          }
        }

        // runSync RESOLVES to a terminal WorkflowRunResult (status already stamped); it does not
        // throw on pause/fail/abort, so there is no shell-side status composition. A malformed
        // script throws BEFORE a run exists (no runId) — that propagates to the SDK, which
        // surfaces it as a tool error.
        const admission = scriptResources.beginAdmission({
          script: admittedScript,
          scriptSource,
          resumeSourceRunId: input.resumeFromRunId,
          elicitationController,
        });
        let run: WorkflowRunResult;
        try {
          run = await manager.runSync(admittedScript, input.args, exec);
        } finally {
          scriptResources.finishAdmission(admission);
          if (cancelElicitationFromRequest) {
            extra.signal.removeEventListener("abort", cancelElicitationFromRequest);
          }
        }

        const scriptUri = workflowScriptUri(run.runId);
        const structuredContent = {
          ...toWorkflowToolResult(run),
          scriptSource,
          scriptUri,
        };
        const isError = run.status === "failed" || run.status === "aborted";
        return {
          structuredContent: { ...structuredContent },
          content: [
            { type: "text", text: formatRunSummary(run) },
            ...scriptResources.links([{ runId: run.runId, uri: scriptUri, available: true }]),
          ],
          isError,
        };
      } finally {
        if (backgroundReservation) backgroundRuns.releaseReservation();
      }
    },
  );

  return mcp;
}
