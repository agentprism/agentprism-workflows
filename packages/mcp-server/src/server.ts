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
//   - resumeFromRunId is mapped to the engine's own persisted journal (manager persistence
//     loads it) and handed back as exec.resumeJournal; checkpointReplies can add a pending
//     durable-checkpoint answer before the engine replays the unchanged prefix. The shell
//     no longer owns/forges a runId.
// Mid-run progress streams via notifications/progress; extra.signal threads cancellation into
// the engine; checkpoint() is driven by the engine's `confirm` hook only when the client
// advertises elicitation. Otherwise the checkpoint's authored headless mode applies.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

import { parseWorkflowScript, redactText, truncateUtf8, WorkflowManager } from "@automatalabs/workflows";
import type {
  ExecOptions,
  PersistedRunState,
  WorkflowSnapshot,
  AgentRunner,
  JournalEntry,
  WorkflowBackendConfig,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "@automatalabs/workflows";
import type { TokenUsage } from "@automatalabs/shared-types";

import { clampWorkflowInput, parseWorkflowToolInput, workflowToolInputShape } from "./workflow-tool-input.js";
import { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
import type { WorkflowExecutionToolResult, WorkflowRunAwaitResult } from "./workflow-tool-output.js";
import { createProgressReporter } from "./progress.js";
import { registerAuthoringPrompt } from "./authoring-prompt.js";

const SERVER_NAME = "agentprism-workflow";
const require = createRequire(import.meta.url);
const SERVER_VERSION = (require("../package.json") as { version: string }).version;

export const MAX_BACKGROUND_RUNS = 4;

const TERMINAL_STATUSES = new Set(["paused", "completed", "failed", "aborted"]);

function isTerminalStatus(status: WorkflowRunStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
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

async function elicitCheckpoint(
  server: Server,
  params: ElicitRequestFormParams,
  timeoutMs: number | undefined,
): Promise<Awaited<ReturnType<Server["elicitInput"]>> | typeof CHECKPOINT_TIMEOUT> {
  if (timeoutMs === undefined) return await server.elicitInput(params);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof CHECKPOINT_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CHECKPOINT_TIMEOUT), timeoutMs);
  });
  try {
    return await Promise.race([server.elicitInput(params), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wire the engine's checkpoint `confirm` hook to MCP form elicitation. The handler installs
 * this callback only for clients that advertise elicitation, then requests a kind-specific
 * one-field form and maps the tri-state result. A timeout or failed elicitation applies
 * `default ?? true`; clients with no elicitation get no callback, so the authored headless
 * mode remains visible to the engine.
 */
function createConfirm(server: Server): WorkflowConfirmCallback {
  return async (prompt, options) => {
    const headlessReply = (): unknown => readCheckpointDefault(options) ?? true;
    const params = createCheckpointElicitation(prompt, options);
    if (!params) return headlessReply();

    // No elicitation capability advertised -> cannot prompt the human; reply headlessly.
    if (!server.getClientCapabilities()?.elicitation) {
      return headlessReply();
    }

    try {
      const elicited = await elicitCheckpoint(server, params, readCheckpointTimeoutMs(options));
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

async function waitForTerminal(
  manager: WorkflowManager,
  runId: string,
  waitMs: number,
  signal: AbortSignal,
  localPromise: Promise<WorkflowRunResult> | undefined,
): Promise<"settled" | "timeout" | typeof AWAIT_CANCELLED> {
  return await new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    let done = false;

    const finish = (result: "settled" | "timeout" | typeof AWAIT_CANCELLED) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      signal.removeEventListener("abort", cancelled);
      resolve(result);
    };
    const cancelled = () => finish(AWAIT_CANCELLED);

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
      return;
    }

    poller = setInterval(() => {
      const status = manager.inspectRun(runId, { lastN: 1, logLines: 0 });
      if (status && isTerminalStatus(status.status)) finish("settled");
    }, 250);
  });
}

function formatAwaitSummary(result: WorkflowRunAwaitResult): string {
  const [heading, runId, ...diagnostics] = inspectionSummaryLines(result);
  const lines = [heading, runId];
  lines.push(
    `wait: ${result.wait.returnedBecause} after ${result.wait.elapsedMs}ms (requested ${result.wait.requestedMs}ms)`,
  );
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

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. The
  // manager owns run lifecycle, status stamping, and the persisted journal used by resume.
  const manager = new WorkflowManager({ agent: runner });
  const backgroundRuns = new BackgroundRunRegistry();
  // Session-sticky approvals for script-declared backends (one prompt per unique spawn config).
  const backendApprovals: BackendApprovals = new Set();

  registerAuthoringPrompt(mcp);

  mcp.registerTool(
    "workflow",
    {
      title: "Run or inspect a dynamic agent workflow",
      description:
        "Run, resume, inspect, or await a JavaScript agent workflow through one project-scoped tool. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over the injected " +
        "ACP agent backend. Foreground is the default and streams progress; background:true returns " +
        "a durable runId for bounded action:\"await\" calls. Pass resumeFromRunId to execute a new " +
        "run from a prior journal prefix. " +
        'Use action:"inspect" with a runId for a safe bounded status, log tail, and attributed call previews. ' +
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
        return {
          structuredContent: { ...status },
          content: [{ type: "text", text: formatInspectionSummary(status) }],
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
        const outcome = isTerminalStatus(status.status)
          ? terminalOutcome(manager, parsedInput.runId, status)
          : undefined;
        const result: WorkflowRunAwaitResult = {
          ...status,
          wait: {
            requestedMs: parsedInput.waitMs ?? 20_000,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            returnedBecause,
          },
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          ...(outcome === undefined ? {} : { outcome }),
        };
        return {
          structuredContent: { ...result },
          content: [{ type: "text", text: formatAwaitSummary(result) }],
          isError: false,
        };
      }

      const input = clampWorkflowInput(parsedInput);
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
        const backendsGate = await resolveScriptBackends(mcp.server, input.script, backendApprovals);
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
          checkpointReplies: input.checkpointReplies,
        };

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
          exec.confirm = mcp.server.getClientCapabilities()?.elicitation ? createConfirm(mcp.server) : undefined;
        }

        // Resume: the engine owns run identity. The shell only re-hydrates the journal the
        // engine persisted for the prior runId and hands it back as resumeJournal; the engine
        // replays the unchanged prefix and runs the rest live.
        if (input.resumeFromRunId) {
          const persisted = manager.getPersistence().load(input.resumeFromRunId);
          if (persisted) {
            exec.resumeJournal = new Map<number, JournalEntry>(
              (persisted.journal ?? []).map((entry) => [entry.index, entry] as const),
            );
            const checkpoint =
              persisted.pauseReason === "checkpoint_required" ? persisted.checkpointContext : undefined;
            if (
              checkpoint &&
              input.checkpointReplies &&
              Object.prototype.hasOwnProperty.call(input.checkpointReplies, checkpoint.callIndex)
            ) {
              exec.resumeJournal.set(checkpoint.callIndex, {
                index: checkpoint.callIndex,
                hash: checkpoint.hash,
                result: input.checkpointReplies[checkpoint.callIndex],
                call: { kind: "checkpoint", label: "checkpoint", phase: persisted.currentPhase },
              });
            }
          }
        }

        if (input.background) {
          const started = manager.startInBackground(input.script, input.args, exec);
          const workflowName = manager.getRun(started.runId)?.snapshot.name ?? "workflow";
          backgroundRuns.track(started.runId, started.promise);
          backgroundReservation = false;
          return {
            structuredContent: { runId: started.runId, status: "running" as const },
            content: [
              {
                type: "text",
                text:
                  `Workflow "${workflowName}" started in the background.\n` +
                  `runId: ${started.runId}\n` +
                  `Call workflow with action="await" and this runId to wait for its result, or ` +
                  `action="inspect" for an immediate status snapshot.`,
              },
            ],
            isError: false,
          };
        }

        // runSync RESOLVES to a terminal WorkflowRunResult (status already stamped); it does not
        // throw on pause/fail/abort, so there is no shell-side status composition. A malformed
        // script throws BEFORE a run exists (no runId) — that propagates to the SDK, which
        // surfaces it as a tool error.
        const run = await manager.runSync(input.script, input.args, exec);

        const structuredContent = toWorkflowToolResult(run);
        const isError = run.status === "failed" || run.status === "aborted";
        return {
          structuredContent: { ...structuredContent },
          content: [{ type: "text", text: formatRunSummary(run) }],
          isError,
        };
      } finally {
        if (backgroundReservation) backgroundRuns.releaseReservation();
      }
    },
  );

  return mcp;
}
