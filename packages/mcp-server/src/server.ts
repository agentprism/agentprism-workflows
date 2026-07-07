// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the single SYNCHRONOUS `workflow` tool,
// and is the composition root where all three packages meet — the injected acp-agents
// AgentRunner is wired into a workflow-engine WorkflowManager (DI) and every tool call runs
// through WorkflowManager.runSync.
//
// Run model (frozen contract + ground-truth finding 5): one tools/call == one full run,
// awaited to completion (taskSupport:'forbidden' — a plain ToolCallback, never a task
// handler). The engine OWNS run identity, status stamping, and resume:
//   - runSync RESOLVES to a TERMINAL WorkflowRunResult (status completed|paused|failed|
//     aborted, carrying reason/resetHint) and does NOT throw on pause/fail/abort — so the
//     shell does no status composition and needs no lifecycle try/catch.
//   - resumeFromRunId is mapped to the engine's own persisted journal (manager persistence
//     loads it) and handed back as exec.resumeJournal; the engine replays the unchanged
//     prefix. The shell no longer owns/forges a runId.
// Mid-run progress streams via notifications/progress; extra.signal threads cancellation into
// the engine; checkpoint() is driven by the engine's `confirm` hook, wired here to
// server.elicitInput with a headless fallback when the host cannot elicit.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";

import { parseWorkflowScript, WorkflowManager } from "@automatalabs/workflows";
import type {
  ExecOptions,
  WorkflowSnapshot,
  AgentRunner,
  JournalEntry,
  WorkflowBackendConfig,
  WorkflowRunResult,
} from "@automatalabs/workflows";

import { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
import { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
import { createProgressReporter } from "./progress.js";

const SERVER_NAME = "agentprism-workflow";
const SERVER_VERSION = "0.0.0";

/**
 * The checkpoint metadata the engine forwards to `confirm` (workflow.ts checkpoint()).
 */
export interface WorkflowCheckpointOptions {
  default?: unknown;
  headless?: "default" | "abort";
  kind?: "confirm" | "input" | "select";
  choices?: string[];
  timeoutMs?: number;
  [key: string]: unknown;
}

/**
 * The engine's `confirm` hook (ExecOptions.confirm): `await confirm(promptText, options)`.
 * The resolved value is the human's reply (truthy => proceed). The shell maps an MCP
 * elicitation result onto it, or returns the headless default when the host cannot elicit.
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
 * Wire the engine's checkpoint `confirm` hook to MCP form elicitation. If the connected
 * host advertises elicitation, request a kind-specific one-field form and map the tri-state
 * result; otherwise (or if the form request throws because the host cannot satisfy it) apply
 * the headless default `default ?? true`. This is server->client and gated on host capability,
 * so the catch is the contract, not a guard against bugs.
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
    lines.push(`reason: ${run.reason}`);
  }
  if (run.resetHint) {
    lines.push(`reset hint: ${run.resetHint}`);
  }
  if (run.status === "paused") {
    lines.push(
      `This run is resumable — call the workflow tool again with resumeFromRunId="${run.runId}" to continue from its journal.`,
    );
  }
  return lines.join("\n");
}

function formatRunSummary(run: WorkflowRunResult): string {
  return run.status === "completed" ? formatCompletedSummary(run) : formatTerminalSummary(run);
}

/**
 * Build the MCP server with the single `workflow` tool registered. The AgentRunner is the
 * DI seam: it is injected here into a single WorkflowManager (so persistence — and therefore
 * resume — is shared across calls) and every run goes through manager.runSync. The returned
 * McpServer is not yet connected — the caller attaches a transport (see index.ts).
 */
export function createWorkflowServer(runner: AgentRunner): McpServer {
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. The
  // manager owns run lifecycle, status stamping, and the persisted journal used by resume.
  const manager = new WorkflowManager({ agent: runner });
  // Session-sticky approvals for script-declared backends (one prompt per unique spawn config).
  const backendApprovals: BackendApprovals = new Set();

  mcp.registerTool(
    "workflow",
    {
      title: "Run a dynamic agent workflow",
      description:
        "Execute a JavaScript workflow script to completion in a single synchronous call. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over the injected " +
        "ACP agent backend. Progress streams via notifications/progress when the client sends a " +
        "progressToken; pass resumeFromRunId to continue a paused run from its persisted journal.",
      inputSchema: workflowToolInputShape,
      outputSchema: workflowToolOutputShape,
    },
    async (args, extra) => {
      const input = clampWorkflowInput(args);
      const reporter = createProgressReporter(extra);

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
        signal: extra.signal,
        maxAgents: input.maxAgents,
        concurrency: input.concurrency,
        agentRetries: input.agentRetries,
        agentTimeoutMs: input.agentTimeoutMs,
        tokenBudget: input.tokenBudget,
        // The engine drives progress with the live snapshot; project it onto the MCP wire
        // shape (settled agents / total seen so far / current phase). `settled` is monotonic.
        onProgress: (snapshot: WorkflowSnapshot) => {
          const settled = snapshot.agents.filter(
            (a) => a.status === "done" || a.status === "error" || a.status === "skipped",
          ).length;
          reporter(settled, snapshot.agents.length || undefined, snapshot.currentPhase);
        },
        confirm: createConfirm(mcp.server),
      };

      // Resume: the engine owns run identity. The shell only re-hydrates the journal the
      // engine persisted for the prior runId and hands it back as resumeJournal; the engine
      // replays the unchanged prefix and runs the rest live.
      if (input.resumeFromRunId) {
        const persisted = manager.getPersistence().load(input.resumeFromRunId);
        if (persisted?.journal) {
          exec.resumeJournal = new Map<number, JournalEntry>(
            persisted.journal.map((entry) => [entry.index, entry] as const),
          );
        }
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
    },
  );

  return mcp;
}
