import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import type {
  ElicitRequestFormParams,
  RequestStateCodec,
  Server,
  ServerContext,
  ServerNotifier,
  ToolCallback,
  ResourceLink,
} from "@modelcontextprotocol/server";

// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the `workflow`, `repl`, and selective
// `docs` model-facing tools (plus the user-controlled `author-workflow` prompt), and is the
// composition root where all three packages meet — the injected acp-agents
// AgentRunner is wired into a workflow-engine WorkflowManager (DI) and every tool call runs
// through WorkflowManager.runSync.
//
// Run model: foreground remains one tools/call awaited to completion; background admission
// acknowledges a process-local run and bounded status calls read it later. This stays a
// plain ToolCallback, never an MCP task handler. The engine OWNS run identity/status/resume:
//   - runSync RESOLVES to a TERMINAL WorkflowRunResult (status completed|paused|failed|
//     aborted, carrying reason/resetHint) and does NOT throw on pause/fail/abort — so the
//     shell does no status composition and needs no lifecycle try/catch.
//   - simple resume hydrates only the source's persisted script/args, then resumeFromRunId,
//     resumePolicy, and checkpointReplies pass to the manager, which owns journal admission,
//     durable seed construction, checkpoint injection, and the fresh target runId.
// Mid-run progress streams via notifications/progress; ctx.mcpReq.signal threads cancellation into
// the engine; checkpoint() is driven by the engine's `confirm` hook only when the client
// advertises elicitation. Otherwise the checkpoint's authored headless mode applies.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  buildModelFilter,
  parseWorkflowScript,
  probeHarnessConfig,
  redactText,
  validateWorkflowScript,
  truncateUtf8,
  workflowMayUseDefaultModel,
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
  clampWorkflowInput,
  parseWorkflowToolInput,
  workflowToolInputSchema,
  WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT,
} from "./workflow-tool-input.js";
import type {
  WorkflowExecuteToolInput,
  WorkflowResumeToolInput,
} from "./workflow-tool-input.js";
import {
  DEFAULT_BACKEND_ENV,
  NoAutoDefaultBackendError,
  discoverProjectDefaultBackend,
  recordedDefaultModel,
  workflowNeedsPinnedDefault,
} from "./default-backend.js";
import {
  BackgroundRunRegistry,
  MAX_BACKGROUND_RUNS,
  WorkflowProjectRegistry,
  resolveProjectDir,
  type ProjectContext,
} from "./project-registry.js";
import { RUN_MONITOR_RESOURCE_URI, registerWorkflowAppUi } from "./app-ui.js";
import { EXTENSION_ID } from "./mcp-apps.js";
import {
  toWorkflowExecutionOutcome,
  toWorkflowToolResult,
  workflowToolOutputShape,
} from "./workflow-tool-output.js";
import type {
  WorkflowExecutionOutcome,
  WorkflowResultRetrieval,
  WorkflowRunLatestActivity,
  WorkflowStatusToolResult,
  WorkflowStopPendingResult,
  WorkflowStopResult,
} from "./workflow-tool-output.js";
import { createAwaitProgressReporter, createProgressReporter, formatAgentProgressMessage } from "./progress.js";
import type { AwaitProgressReporter } from "./progress.js";
import { registerAuthoringPrompt } from "./authoring-prompt.js";
import { registerAuthoringDocs } from "./docs-tool.js";
import { registerReplTool } from "./repl-tool.js";
import { ReplPresenceLedger } from "./repl-presence.js";
import { CapabilityAwareToolCatalog } from "./tool-catalog.js";
import { createReplProjectState, DEFAULT_REPL_EVAL_TIMEOUT_MS } from "./repl-project.js";
import { REPL_DRAIN_BOUND_MS } from "./daemon/constants.js";
import type { WorkflowRunControlRouter } from "./daemon/run-control.js";
import {
  configSummary,
  configText,
  validationSummary,
  validationText,
  workflowProbeRunner,
} from "./workflow-preflight.js";
import type { WorkflowServerControl } from "./lifecycle.js";
import {
  RESULT_RESOURCE_MIME_TYPE,
  WorkflowScriptResources,
  workflowResultUri,
  workflowScriptUri,
} from "./workflow-resources.js";
import { requireDurableStoppedRun } from "./workflow-stop.js";
import {
  WorkflowPermissionBroker,
  type WorkflowPendingPermission,
  type WorkflowPermissionResponseAcknowledgement,
} from "./workflow-permissions.js";

const SERVER_NAME = "agentprism-workflow";
const DEFAULT_REQUEST_STATE_CODEC = createRequestStateCodec<unknown>({
  key: randomBytes(32),
  bind: (ctx) => ctx.mcpReq.method,
});
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
    "action:\"status\"/\"permissions-response\"/\"stop\" calls, with journaling and replay. " +
    "action:\"resume\" reuses a source run's stored script and args; explicit script plus resumeFromRunId remains the edited-replay path. " +
    "Status surfaces exact live ACP permission options when an agent needs external action. Reach " +
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

function permissionInteraction(canElicit: boolean) {
  return {
    permissionRequests: "may-block" as const,
    collectWith: ["status"] as ["status"],
    respondWith: "permissions-response" as const,
    elicitation: canElicit ? "available" as const : "unavailable" as const,
  };
}

async function pendingPermissionsForRun(
  manager: WorkflowManager,
  runId: string,
  broker: WorkflowPermissionBroker,
  router: WorkflowRunControlRouter | undefined,
): Promise<WorkflowPendingPermission[]> {
  if (manager.getRun(runId)) return broker.list(runId);
  return router ? await router.listPermissions(manager, runId) : [];
}

async function respondToPermission(
  manager: WorkflowManager,
  input: { runId: string; permissionId: string; response: Parameters<WorkflowPermissionBroker["respond"]>[2] },
  broker: WorkflowPermissionBroker,
  router: WorkflowRunControlRouter | undefined,
): Promise<WorkflowPermissionResponseAcknowledgement> {
  if (manager.getRun(input.runId) && broker.has(input.runId, input.permissionId)) {
    return broker.respond(input.runId, input.permissionId, input.response);
  }
  if (!router) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Permission request "${input.permissionId}" is not pending in this server process.`,
    );
  }
  return await router.respondPermission(manager, input);
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

function createPermissionElicitation(permission: WorkflowPendingPermission): ElicitRequestFormParams {
  const tool = permission.request.toolCall;
  const title = typeof tool.title === "string" && tool.title.trim() !== ""
    ? tool.title
    : `${tool.kind ?? "tool"} request`;
  const optionLines = permission.request.options.map((option) =>
    `- ${option.optionId}: ${option.name} (${option.kind})`
  );
  return {
    mode: "form",
    message:
      `Workflow agent ${permission.label ? JSON.stringify(permission.label) : `call ${permission.callIndex}`} ` +
      `on ${permission.backendId} requests permission for: ${title}\n\n` +
      `${optionLines.join("\n")}\n\nSelect one exact advertised option.`,
    requestedSchema: {
      type: "object",
      properties: {
        optionId: {
          type: "string",
          title: "Permission decision",
          description: "Exact option advertised by the ACP backend.",
          enum: permission.request.options.map((option) => option.optionId),
        },
      },
      required: ["optionId"],
    },
  };
}

function formatPendingPermissions(permissions: WorkflowPendingPermission[]): string {
  if (permissions.length === 0) return "";
  const lines = [
    `${permissions.length} workflow permission request(s) require a response:`,
    ...permissions.map((permission) => {
      const title = permission.request.toolCall.title ?? permission.request.toolCall.kind ?? "tool request";
      const options = permission.request.options.map((option) => option.optionId).join(", ");
      return `- ${permission.permissionId} call ${permission.callIndex} (${permission.backendId}) ${title}; options: ${options}`;
    }),
    `Use action="permissions-response" with runId, permissionId, and an exact selected optionId or cancelled outcome.`,
  ];
  return truncateUtf8(`\n${lines.join("\n")}`, 8_192, "…[permission summary truncated]");
}

function permissionResponseFromElicitation(
  permission: WorkflowPendingPermission,
  response: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> },
): Parameters<WorkflowPermissionBroker["respond"]>[2] {
  if (response.action !== "accept") return { outcome: { outcome: "cancelled" } };
  const optionId = response.content?.optionId;
  if (
    typeof optionId !== "string" ||
    !permission.request.options.some((option) => option.optionId === optionId)
  ) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
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
  return createHash("sha256")
    .update(JSON.stringify({ name, command: config.command, args: config.args ?? [], env: config.env ?? {} }))
    .digest("hex");
}

function describeBackend(name: string, config: WorkflowBackendConfig): string {
  const lines = [`backend "${name}"`, `  command: ${config.command}${(config.args ?? []).length ? " " + (config.args ?? []).join(" ") : ""}`];
  const env = config.env ?? {};
  if (Object.keys(env).length > 0) {
    lines.push(`  env: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  return lines.join("\n");
}

type WorkflowMcpRequestState =
  | {
      version: 1;
      flow: "backend-approval";
      inputHash: string;
      scriptHash: string;
      approvedKeys: string[];
      pendingKey: string;
    }
  | {
      version: 1;
      flow: "permission";
      inputHash: string;
      scriptHash: string;
      runId: string;
      permissionId: string;
    }
  | {
      version: 1;
      flow: "checkpoint";
      inputHash: string;
      scriptHash: string;
      runId: string;
      callIndex: number;
      checkpointHash: string;
      approvedKeys: string[];
      expiresAt?: number;
    };

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return "null";
}

function workflowInputHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

function workflowScriptHash(script: string): string {
  return createHash("sha256").update(script).digest("hex");
}

function parseWorkflowRequestState(value: unknown, inputHash: string): WorkflowMcpRequestState | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow requestState");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    state.inputHash !== inputHash ||
    typeof state.scriptHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(state.scriptHash)
  ) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      "Invalid workflow requestState: the retried workflow arguments do not match the originating call",
    );
  }
  if (state.flow === "backend-approval") {
    if (
      !Array.isArray(state.approvedKeys) ||
      state.approvedKeys.length > 64 ||
      !state.approvedKeys.every((key) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) ||
      typeof state.pendingKey !== "string" ||
      !/^[0-9a-f]{64}$/.test(state.pendingKey)
    ) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow backend-approval requestState");
    }
    return {
      version: 1,
      flow: "backend-approval",
      inputHash,
      scriptHash: state.scriptHash as string,
      approvedKeys: [...new Set(state.approvedKeys)],
      pendingKey: state.pendingKey,
    };
  }
  if (state.flow === "permission") {
    if (
      typeof state.runId !== "string" ||
      !/^[a-z0-9]+-[a-z0-9]+$/.test(state.runId) ||
      typeof state.permissionId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(state.permissionId)
    ) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow permission requestState");
    }
    return {
      version: 1,
      flow: "permission",
      inputHash,
      scriptHash: state.scriptHash as string,
      runId: state.runId,
      permissionId: state.permissionId,
    };
  }
  if (state.flow === "checkpoint") {
    if (
      typeof state.runId !== "string" ||
      !Number.isSafeInteger(state.callIndex) ||
      (state.callIndex as number) < 0 ||
      typeof state.checkpointHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(state.checkpointHash) ||
      !Array.isArray(state.approvedKeys) ||
      state.approvedKeys.length > 64 ||
      !state.approvedKeys.every((key) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) ||
      (state.expiresAt !== undefined && (typeof state.expiresAt !== "number" || !Number.isFinite(state.expiresAt)))
    ) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow checkpoint requestState");
    }
    return {
      version: 1,
      flow: "checkpoint",
      inputHash,
      scriptHash: state.scriptHash as string,
      runId: state.runId,
      callIndex: state.callIndex as number,
      checkpointHash: state.checkpointHash,
      approvedKeys: [...new Set(state.approvedKeys)],
      ...(state.expiresAt === undefined ? {} : { expiresAt: state.expiresAt as number }),
    };
  }
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow requestState flow");
}

type ScriptBackendsGate =
  | { ok: true; backends?: Record<string, WorkflowBackendConfig> }
  | { ok: false; message: string };

type ModernScriptBackendsGate = ScriptBackendsGate | {
  ok: false;
  approval: { name: string; config: WorkflowBackendConfig; key: string };
};

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

function backendApprovalElicitation(name: string, config: WorkflowBackendConfig): ElicitRequestFormParams {
  return {
    mode: "form",
    message:
      `Workflow wants to spawn a custom ACP agent backend on this machine:\n\n` +
      `${describeBackend(name, config)}\n\n` +
      "Approve spawning this command?",
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
  };
}

function resolveModernScriptBackends(
  script: string,
  approvedKeys: ReadonlySet<string>,
): ModernScriptBackendsGate {
  let declared: Record<string, WorkflowBackendConfig> | undefined;
  try {
    declared = parseWorkflowScript(script).meta.backends;
  } catch {
    return { ok: true };
  }
  if (!declared || Object.keys(declared).length === 0) return { ok: true };
  if (scriptBackendsAllowedByEnv()) return { ok: true, backends: declared };

  for (const [name, config] of Object.entries(declared)) {
    const key = backendApprovalKey(name, config);
    if (!approvedKeys.has(key)) return { ok: false, approval: { name, config, key } };
  }
  return { ok: true, backends: declared };
}

function declinedBackendMessage(name: string, config: WorkflowBackendConfig): string {
  return (
    `User declined to spawn script-declared backend "${name}" (command: ${config.command}) — ` +
    `the workflow was not run. Remove meta.backends.${name} or re-run and approve it.`
  );
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
          `then call the workflow tool with action="resume" and runId="${run.runId}".`,
      );
    } else if (run.reason === "checkpoint_required" && run.checkpointContext) {
      const checkpoint = run.checkpointContext;
      lines.push(`This run awaits a ${checkpoint.kind} decision for: ${checkpoint.prompt}`);
      if (checkpoint.choices?.length) lines.push(`choices: ${checkpoint.choices.join(", ")}`);
      lines.push(
        `Call the workflow tool with action="resume", runId="${run.runId}", and ` +
          `checkpointReplies={ "${checkpoint.callIndex}": <decision> }.`,
      );
    } else {
      lines.push(
        `This run is resumable — call the workflow tool with action="resume" and runId="${run.runId}" to continue from its journal.`,
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
  const activityProjection = projected as Status & Fields & {
    latestActivity?: WorkflowRunLatestActivity[];
  };
  if (activityProjection.latestActivity !== undefined) {
    activityProjection.latestActivity = [...activityProjection.latestActivity];
  }
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
    ...(activityProjection.latestActivity === undefined ? {} : { latestActivity: [] }),
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
  while ((activityProjection.latestActivity?.length ?? 0) > 0 && tooLarge()) {
    activityProjection.latestActivity!.shift();
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
      "Stop is durably complete: this snapshot is final for run fate, a new resume action is safe immediately, and a follow-up status call adds nothing.",
      "Agent-session cancellation may still be winding down; check the per-agent states only if backend cleanup appears hung.",
    );
  }
  return truncateUtf8(lines.join("\n"), 8_192, "…[text truncated]");
}

function formatPendingStopSummary(result: WorkflowStopPendingResult): string {
  const lines = inspectionSummaryLines(result);
  const owner = result.control.owner;
  lines.splice(
    2,
    0,
    `Stop request ${result.control.operationId} is durably pending; retry stop or status to observe settlement.`,
    owner === undefined
      ? "No live execution owner is currently discoverable; a later lease holder will apply the intent."
      : `Execution owner: daemon pid ${owner.pid}${owner.version ? ` v${owner.version}` : ""}` +
        `${owner.lameDuck ? " (draining)" : ""}.`,
  );
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
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
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
    if (
      persisted &&
      persisted.script === admittedScript &&
      scriptResources.availableEventsUri(runId) !== undefined
    ) {
      scriptResources.notifyRunAdmitted(runId);
      return;
    }
    failure = persisted
      ? persisted.script !== admittedScript
        ? "the persisted script did not match the admitted snapshot"
        : "the persisted run did not expose its durable events resource"
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
  throw new ProtocolError(
    ProtocolErrorCode.InternalError,
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

async function settleForegroundRunOrPermission(
  manager: WorkflowManager,
  started: { runId: string; promise: Promise<WorkflowRunResult> },
  broker: WorkflowPermissionBroker,
): Promise<{ kind: "terminal"; run: WorkflowRunResult } | { kind: "permission" }> {
  if (broker.has(started.runId)) return { kind: "permission" };
  return await Promise.race([
    settleForegroundRun(manager, started).then((run) => ({ kind: "terminal" as const, run })),
    broker.waitForPending(started.runId).then(() => ({ kind: "permission" as const })),
  ]);
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

function currentResumeReport(report: WorkflowResumeReport): WorkflowResumeReport {
  return {
    ...report,
    calls: report.calls.map((decision) => {
      const { logicalBudgetDebit: _logicalBudgetDebit, ...currentDecision } = decision as
        typeof decision & { logicalBudgetDebit?: unknown };
      return currentDecision;
    }),
  } as WorkflowResumeReport;
}

function persistedOutcome(
  persisted: PersistedRunState,
  status: WorkflowRunStatus,
  eventsUri: string | undefined,
): WorkflowExecutionOutcome {
  if (status.status === "pending" || status.status === "running") {
    throw new TypeError(`Terminal workflow outcome cannot have status ${status.status}`);
  }
  return {
    runId: persisted.runId,
    status: status.status,
    ...(status.limits === undefined ? {} : { limits: status.limits }),
    ...(status.status === "completed" && persisted.result !== undefined ? { result: persisted.result } : {}),
    tokenUsage: normalizeTokenUsage(persisted.tokenUsage),
    logs: persisted.logs,
    ...(status.status === "completed" ? {} : { logTail: status.logTail }),
    authContext: persisted.authContext,
    checkpointContext: persisted.checkpointContext,
    ...(persisted.fallbacks === undefined ? {} : { fallbacks: persisted.fallbacks }),
    ...(persisted.checkpointsTaken === undefined ? {} : { checkpointsTaken: persisted.checkpointsTaken }),
    ...(persisted.resumeReport === undefined
      ? {}
      : { resumeReport: currentResumeReport(persisted.resumeReport) }),
    ...(persisted.replayEligibility === undefined
      ? {}
      : { replayEligibility: persisted.replayEligibility }),
    scriptUri: workflowScriptUri(persisted.runId),
    ...(eventsUri === undefined ? {} : { eventsUri }),
    ...(status.status === "completed" && persisted.result !== undefined
      ? { resultUri: workflowResultUri(persisted.runId) }
      : {}),
  };
}

function terminalOutcome(
  manager: WorkflowManager,
  resources: WorkflowScriptResources,
  runId: string,
  status: WorkflowRunStatus,
): WorkflowExecutionOutcome | undefined {
  const persisted = manager.getPersistence().load(runId);
  const resultUri = persisted?.status === "completed" && persisted.result !== undefined
    ? workflowResultUri(runId)
    : undefined;
  const live = manager.getRun(runId)?.result;
  const eventsUri = resources.availableEventsUri(runId);
  if (live) {
    return toWorkflowExecutionOutcome(live, {
      scriptUri: workflowScriptUri(runId),
      ...(resultUri === undefined ? {} : { resultUri }),
      ...(eventsUri === undefined ? {} : { eventsUri }),
    });
  }
  return persisted ? persistedOutcome(persisted, status, eventsUri) : undefined;
}

const INLINE_WORKFLOW_RESULT_MAX_BYTES = 4_096;

type WorkflowResultContentBlock =
  | { type: "text"; text: string; annotations?: { audience: ["assistant"] } }
  | ResourceLink;

function resultResourceFields(
  resources: WorkflowScriptResources,
  runId: string,
): { resultUri?: string; eventsUri?: string } {
  const resultUri = resources.availableResultUri(runId);
  const eventsUri = resources.availableEventsUri(runId);
  return {
    ...(resultUri === undefined ? {} : { resultUri }),
    ...(eventsUri === undefined ? {} : { eventsUri }),
  };
}

function matchesActivityLabelGlob(label: string, pattern: string): boolean {
  const labelPoints = [...label];
  const patternPoints = [...pattern];
  const tokens: Array<{ kind: "star" } | { kind: "one" } | { kind: "literal"; value: string }> = [];
  for (let index = 0; index < patternPoints.length; index++) {
    const point = patternPoints[index]!;
    if (point === "*") tokens.push({ kind: "star" });
    else if (point === "?") tokens.push({ kind: "one" });
    else if (point === "\\") {
      const escaped = patternPoints[index + 1];
      if (escaped === undefined) tokens.push({ kind: "literal", value: "\\" });
      else {
        tokens.push({ kind: "literal", value: escaped });
        index++;
      }
    } else tokens.push({ kind: "literal", value: point });
  }

  let previous = new Array<boolean>(labelPoints.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokens) {
    const current = new Array<boolean>(labelPoints.length + 1).fill(false);
    if (token.kind === "star") {
      current[0] = previous[0]!;
      for (let index = 1; index <= labelPoints.length; index++) {
        current[index] = previous[index]! || current[index - 1]!;
      }
    } else {
      for (let index = 1; index <= labelPoints.length; index++) {
        current[index] = previous[index - 1]! &&
          (token.kind === "one" || token.value === labelPoints[index - 1]);
      }
    }
    previous = current;
  }
  return previous[labelPoints.length]!;
}

function latestActivityFields(
  resources: WorkflowScriptResources,
  runId: string,
  status: WorkflowRunStatus,
): { latestActivity?: WorkflowRunLatestActivity[] } {
  const activity = resources.latestActivity(runId);
  if (activity === undefined) return {};
  const matched = status.filter.labelGlob === undefined
    ? activity
    : activity.filter((item) => matchesActivityLabelGlob(item.label, status.filter.labelGlob!));
  return { latestActivity: matched.slice(-status.filter.lastN) };
}

function eventsContentBlocks(resources: WorkflowScriptResources, runId: string): ResourceLink[] {
  const link = resources.eventsLink(runId);
  return link === undefined ? [] : [link];
}

/**
 * Compatibility projection for content-first MCP clients. Small results are copied exactly as
 * JSON; large results stay out of the tool envelope and point to both the exact resource and the
 * bounded result action.
 */
function resultContentBlocks(
  resources: WorkflowScriptResources,
  runId: string,
  inline: boolean,
): WorkflowResultContentBlock[] {
  const link = resources.resultLink(runId);
  if (!link) return [];
  const resultUri = link.uri;
  if (inline) {
    const result = resources.serializedResult(runId);
    if (result.bytes <= INLINE_WORKFLOW_RESULT_MAX_BYTES) {
      return [
        {
          type: "text",
          text: `Workflow result (exact JSON):\n${result.text}`,
          annotations: { audience: ["assistant"] },
        },
        link,
      ];
    }
    return [
      {
        type: "text",
        text:
          `Exact workflow result: ${result.bytes} UTF-8 bytes at ${resultUri}. ` +
          `Read that resource directly, or call workflow with action="result", runId="${runId}", ` +
          `offset=0 and follow endOffset while hasMore is true for bounded exact chunks.`,
        annotations: { audience: ["assistant"] },
      },
      link,
    ];
  }
  return [
    {
      type: "text",
      text:
        `Exact workflow result: ${resultUri}. Read that resource directly, or call workflow with ` +
        `action="result", runId="${runId}", offset=0 and follow endOffset while hasMore is true ` +
        `for bounded exact chunks.`,
      annotations: { audience: ["assistant"] },
    },
    link,
  ];
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function resultRetrievalPage(
  resources: WorkflowScriptResources,
  runId: string,
  offset: number,
  maxBytes: number,
): WorkflowResultRetrieval {
  const result = resources.serializedResult(runId);
  const eventsUri = resources.availableEventsUri(runId);
  const buffer = Buffer.from(result.text, "utf8");
  if (offset > buffer.length) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Workflow result offset ${offset} exceeds totalBytes ${buffer.length} for runId "${runId}".`,
    );
  }
  if (offset < buffer.length && isUtf8ContinuationByte(buffer[offset])) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Workflow result offset ${offset} is not a UTF-8 boundary for runId "${runId}"; use the previous endOffset.`,
    );
  }
  let endOffset = Math.min(buffer.length, offset + maxBytes);
  while (endOffset > offset && endOffset < buffer.length && isUtf8ContinuationByte(buffer[endOffset])) {
    endOffset--;
  }
  return {
    action: "result",
    runId,
    status: "completed",
    resultUri: result.uri,
    ...(eventsUri === undefined ? {} : { eventsUri }),
    mimeType: RESULT_RESOURCE_MIME_TYPE,
    encoding: "utf-8",
    totalBytes: buffer.length,
    offset,
    endOffset,
    hasMore: endOffset < buffer.length,
    chunk: buffer.subarray(offset, endOffset).toString("utf8"),
  };
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
  permissionWait?: Promise<void>,
  permissionProbe?: () => Promise<boolean>,
): Promise<"settled" | "timeout" | "action-required" | typeof AWAIT_CANCELLED | typeof AWAIT_UNKNOWN_RUN> {
  return await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let poller: NodeJS.Timeout | undefined;
    let permissionPoller: NodeJS.Timeout | undefined;
    let permissionProbeActive = false;
    let stream: ReturnType<ReturnType<WorkflowManager["getPersistence"]>["watchEvents"]> | undefined;
    let done = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (permissionPoller) clearInterval(permissionPoller);
      stream?.close();
      signal.removeEventListener("abort", cancelled);
    };
    const finish = (result: "settled" | "timeout" | "action-required" | typeof AWAIT_CANCELLED | typeof AWAIT_UNKNOWN_RUN) => {
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
    if (permissionWait) {
      void permissionWait.then(() => finish("action-required"), () => undefined);
    }
    if (permissionProbe) {
      const probe = async () => {
        if (done || permissionProbeActive) return;
        permissionProbeActive = true;
        try {
          if (await permissionProbe()) finish("action-required");
        } catch {
          // The event stream/timeout still owns await settlement; a transient owner-control
          // failure is retried on the next bounded probe.
        } finally {
          permissionProbeActive = false;
        }
      };
      permissionPoller = setInterval(() => void probe(), 1_000);
      void probe();
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

function formatStatusSummary(result: WorkflowStatusToolResult): string {
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
          `machine (e.g. \`claude /login\`, \`codex login\`, \`opencode auth login\`, or a pi provider key / \`~/.pi/agent/auth.json\`), then call the ` +
          `workflow tool with action="resume" and runId="${result.runId}".`,
      );
    } else if (result.reason === "checkpoint_required" && result.outcome.checkpointContext) {
      const checkpoint = result.outcome.checkpointContext;
      lines.push(`This run awaits a ${checkpoint.kind} decision for: ${checkpoint.prompt}`);
      if (checkpoint.choices?.length) lines.push(`choices: ${checkpoint.choices.join(", ")}`);
      lines.push(
        `Call the workflow tool with action="resume", runId="${result.runId}", and ` +
          `checkpointReplies={ "${checkpoint.callIndex}": <decision> }.`,
      );
    } else {
      lines.push(
        `Call the workflow tool with action="resume" and runId="${result.runId}" to continue from its journal.`,
      );
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
  /** Protocol era selected by an SDK serving entry. Hand-connected servers remain legacy. */
  protocolEra?: "legacy" | "modern";
  /** Shared codec used by every modern per-request server instance in this process. */
  requestStateCodec?: RequestStateCodec<unknown>;
  /** Modern request instances have request-scoped presence and disconnect when the instance closes. */
  disconnectReplClientOnClose?: boolean;
  /** Daemon-scoped publisher for modern subscriptions/listen change delivery. */
  modernNotifier?: ServerNotifier;
  /** Daemon-only location-transparent run-control router. */
  runControl?: WorkflowRunControlRouter;
  /** Process-local broker whose resolver is installed on the shared ACP runner. */
  permissionBroker?: WorkflowPermissionBroker;
}

export interface WorkflowServer extends McpServer, WorkflowServerControl {}

export function createWorkflowServer(
  runner: AgentRunner,
  options: CreateWorkflowServerOptions = {},
): WorkflowServer {
  const requestStateCodec = options.requestStateCodec ?? DEFAULT_REQUEST_STATE_CODEC;
  const permissionBroker = options.permissionBroker ?? new WorkflowPermissionBroker();
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
      requestState: { verify: requestStateCodec.verify },
    },
  );
  const toolCatalog = new CapabilityAwareToolCatalog(mcp, options.protocolEra ?? "legacy");
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
  // capability and advertise this server's Apps support before handler registration and before
  // createWorkflowServer returns. The current legacy era carries server extensions in initialize;
  // the separately gated modern era moves that advertisement to server/discover.
  mcp.server.registerCapabilities({
    resources: { subscribe: true, listChanged: true },
    extensions: { [EXTENSION_ID]: {} },
  });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. Each
  // project's manager owns run lifecycle, status stamping, and the persisted journal used by
  // resume; the registry routes calls to the right project (run: the projectDir argument;
  // resume/status/stop: locating the runId's store).
  const requireProjectDir = options.requireProjectDir === true;
  const projects = options.projects ?? new WorkflowProjectRegistry(runner);
  const defaultContext: ProjectContext | undefined = requireProjectDir
    ? undefined
    : projects.adopt(options.manager ?? new WorkflowManager({ agent: runner }), options.backgroundRuns);
  const scriptResources = new WorkflowScriptResources(mcp, { router: projects }, options.modernNotifier);
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
    if (
      input.action === "status" ||
      input.action === "resume" ||
      input.action === "stop" ||
      input.action === "permissions-response"
    ) {
      return projects.storeFor(input.runId) ?? defaultContext;
    }
    if (input.projectDir !== undefined) {
      const resolution = resolveProjectDir(input.projectDir);
      if (!resolution.ok) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid workflow tool input: ${resolution.message}`);
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

  const workflowToolOutputSchema = workflowToolOutputShape;
  const workflowToolConfig = {
    title: "Discover, validate, run, resume, observe status, answer permissions, stop, or narrow-cancel a workflow",
    description:
        "Author and operate JavaScript agent workflows through one project-scoped tool. " +
        "A script's first statement must be `export const meta = { name, description, phases? }`. When present, phases must be an array of objects shaped `{ title: string, detail?: string, model?: string }`, never an array of strings. " +
        "Inside the deterministic script realm use agent(prompt, options?) for one subagent; parallel([thunks]) for a barrier; " +
        "pipeline(items, ...stages) for streaming stages; checkpoint(prompt, options?) for a human gate; phase(title) and log(message) " +
        "for progress; and return the final JSON-serializable value. Top-level await is supported. Imports, require, network APIs, " +
        "Date.now(), and Math.random() are unavailable. Always label agent calls; schema is a plain JSON Schema object for structured results. " +
        "The only agent option keys are label, phase, model, tier, mode, configOptions, schema, cwd, retries, isolation:\"worktree\", resume, agentType, mcpServers, images, meta, promptMeta, and keepSession; unknown keys reject before admission. " +
        "Every parallel entry must be a thunk: parallel([() => agent(...), () => agent(...)]). For deeper syntax, read docs topic workflow/quickstart and then one related workflow/* topic. " +
        "Minimal script: `export const meta = { name: \"review\", description: \"Review a target\", phases: [{ title: \"Review\" }] }; phase(\"Review\"); const report = await agent(\"Review \" + args.target, { label: \"review\" }); return { report };`. " +
        "Omit model for the server default (explicit AGENTPRISM_DEFAULT_BACKEND, else a zero-token auto-selected project pin), or use a backend name alone to preserve that backend's configured default. " +
        "Before choosing a pinned model, mode, or configOptions, call action:\"config\" with projectDir and optional harnesses/modelFilter; after choosing a model, pass modelSpecs to read its model-specific options. " +
        "Config returns every harness-advertised mode name, description, and metadata plus AgentPrism's omitted-mode default: Claude auto, Codex agent, OpenCode build, and no Pi mode. Pin only exact advertised ids. " +
        "Config opens no-prompt sessions, spends zero tokens, and starts no workflow. " +
        "action:\"run\" automatically performs static validation, a mocked dry run, and routed config checks before admission. " +
        "Invalid scripts return bounded diagnostics with status:\"rejected\" and create no run ID, reserve no background slot, and spend no tokens. " +
        "Run, resume, observe status, retrieve an exact completed result, answer a live ACP permission, or stop an admitted workflow through the same tool. The " +
        "script orchestrates agent() subagents (and optional checkpoint() gates) over registry built-ins—currently Claude, Codex, OpenCode, and pi—" +
        "ACP backends, plus registered custom agents. Supply exactly one of inline script or absolute scriptPath; path content is " +
        "read once and snapshotted at admission. " +
        (requireProjectDir
          ? "config and run REQUIRE projectDir (absolute): it is the discovery cwd and selects the project-scoped run store/default execution cwd. "
          : "run optionally takes projectDir (absolute) to select the project-scoped run store; default is this server's own project. ") +
        "resume/status/result/stop/permissions-response locate the project store from runId and never accept projectDir. " +
        "Foreground is the default and streams progress; background:true returns " +
        "a durable runId for bounded action:\"status\" calls. run and status honor _meta.progressToken " +
        "with notifications/progress while they block. Use action:\"resume\" with runId to create a new run from that source's stored immutable script and strict-JSON args; an explicit args value overrides the stored args, and operational limits come only from the new request. Use action:\"run\" with explicit script or scriptPath plus resumeFromRunId for edited-script replay. " +
        "In hosts that render MCP Apps, every call of this tool shows a live self-updating run-monitor " +
        "panel and the panel reports phase starts, pauses, and terminal outcomes on its own — do NOT poll " +
        'action:"status" only when you need machine-readable state or want to wait for a milestone. ' +
        'Use action:"status" with a runId and optional waitMs for a safe bounded status, log tail, attributed call previews, and pending ACP permissions. Omitted or zero waitMs reads immediately; a positive value waits only for this MCP request and never cancels the run. Status returns early with action-required when one appears. Elicitation-capable hosts can present the exact backend options; otherwise use action:"permissions-response" with the returned permissionId and an exact advertised optionId or cancelled outcome. ' +
        'Use action:"stop" to durably abort through the run\'s execution owner; cross-generation control may return a durable pending operationId before final settlement. Add callIndex to cancel only that live agent and keep the run live. forceOwner explicitly authorizes terminating a superseded owner and is forbidden with callIndex. ' +
        "labelGlob remains an output filter. A final whole-run stop makes resume safe immediately; pending control must be retried or observed with status. " +
        "Every admitted script is readable at workflow://runs/{runId}/script. Completed JSON results are readable at workflow://runs/{runId}/result; small results are also copied into text for content-first hosts, while large results can be paged exactly with action:\"result\", offset, and maxBytes. Result and script resource links are labelled separately. " +
        "Background runs are tracked per project, capped at four active/starting runs, and use " +
        "headless checkpoint semantics; checkpointReplies continue a checkpoint pause in a new run.",
    inputSchema: workflowToolInputSchema,
    outputSchema: workflowToolOutputSchema,
    annotations: undefined,
  };

  const workflowToolHandler: ToolCallback<typeof workflowToolInputSchema> = async (args, ctx: ServerContext) => {
      if (!acceptingWork) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          "Workflow server is shutting down and is no longer accepting tool calls.",
        );
      }
      const inputHash = workflowInputHash(args);
      const requestState = options.protocolEra === "modern"
        ? parseWorkflowRequestState(ctx.mcpReq.requestState<unknown>(), inputHash)
        : undefined;
      let parsedInput = parseWorkflowToolInput(args, { requireProjectDir });
      const approvedBackendKeys = new Set<string>();
      let declinedBackendKey: string | undefined;
      if (requestState !== undefined && "approvedKeys" in requestState) {
        for (const key of requestState.approvedKeys) approvedBackendKeys.add(key);
      }
      if (requestState?.flow === "backend-approval") {
        const response = inputResponse(ctx.mcpReq.inputResponses, "backendApproval");
        if (response.kind === "elicit") {
          if (response.action === "accept" && response.content?.approve === true) {
            approvedBackendKeys.add(requestState.pendingKey);
          } else {
            declinedBackendKey = requestState.pendingKey;
          }
        }
      }
      if (parsedInput.action === "config") {
        let cwd = defaultContext?.projectDir;
        if (parsedInput.projectDir !== undefined) {
          const resolution = resolveProjectDir(parsedInput.projectDir);
          if (!resolution.ok) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid workflow tool input: ${resolution.message}`);
          }
          cwd = resolution.projectDir;
        }
        if (cwd === undefined) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow tool input: config requires projectDir on this server");
        }
        if (parsedInput.modelFilter !== undefined) {
          try {
            buildModelFilter(parsedInput.modelFilter);
          } catch (error) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Invalid workflow tool input: modelFilter is invalid — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const report = await probeHarnessConfig({
          harnesses: parsedInput.harnesses,
          modelSpecs: parsedInput.modelSpecs,
          cwd,
          probeRunner,
        });
        let projected;
        try {
          projected = configSummary(report, parsedInput.modelFilter);
        } catch (error) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
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

      if (requestState?.flow === "permission") {
        const statusStartedAt = Date.now();
        if (
          parsedInput.action !== "status" ||
          parsedInput.runId !== requestState.runId
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid workflow permission retry: the original status arguments must be replayed unchanged",
          );
        }
        const pending = await pendingPermissionsForRun(
          manager,
          requestState.runId,
          permissionBroker,
          options.runControl,
        );
        const permission = pending.find((entry) => entry.permissionId === requestState.permissionId);
        if (!permission) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Permission request "${requestState.permissionId}" is no longer pending for run "${requestState.runId}"`,
          );
        }
        const input = inputResponse(ctx.mcpReq.inputResponses, "permission");
        if (input.kind !== "elicit") {
          return inputRequired({
            inputRequests: { permission: inputRequired.elicit(createPermissionElicitation(permission)) },
            requestState: await requestStateCodec.mint(requestState, ctx),
          });
        }
        const response = permissionResponseFromElicitation(permission, input);
        const acknowledgement = await respondToPermission(
          manager,
          { runId: requestState.runId, permissionId: requestState.permissionId, response },
          permissionBroker,
          options.runControl,
        );
        const status = manager.inspectRun(requestState.runId, {
          lastN: parsedInput.lastN,
          labelGlob: parsedInput.labelGlob,
          logLines: parsedInput.logLines,
        });
        if (!status) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `No workflow run found for runId "${requestState.runId}" after its permission response.`,
          );
        }
        const lineage = scriptResources.lineage(requestState.runId);
        const remaining = await pendingPermissionsForRun(
          manager,
          requestState.runId,
          permissionBroker,
          options.runControl,
        );
        const tokenUsage = currentTokenUsage(manager, requestState.runId);
        const outcome = isTerminalStatus(status.status)
          ? terminalOutcome(manager, scriptResources, requestState.runId, status)
          : undefined;
        const wait = {
          requestedMs: parsedInput.waitMs ?? 0,
          elapsedMs: Math.max(0, Date.now() - statusStartedAt),
          returnedBecause: "permission-resolved" as const,
        };
        const projected = addInspectionResourceFields(
          status,
          {
            wait,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            scriptUri: workflowScriptUri(requestState.runId),
            ...resultResourceFields(scriptResources, requestState.runId),
            ...latestActivityFields(scriptResources, requestState.runId, status),
            lineage,
            pendingPermissions: remaining,
            interaction: permissionInteraction(true),
            permissionResponse: acknowledgement,
          },
          inspectionRetentionMetadata(manager, requestState.runId, status),
        );
        const result: WorkflowStatusToolResult = {
          ...projected,
          ...(outcome === undefined ? {} : { outcome }),
        };
        return {
          structuredContent: { ...result },
          content: [
            {
              type: "text",
              text: formatStatusSummary(result) + formatPendingPermissions(remaining),
              annotations: { audience: ["assistant"] },
            },
            ...resultContentBlocks(scriptResources, requestState.runId, true),
            ...scriptResources.links(lineage),
            ...eventsContentBlocks(scriptResources, requestState.runId),
          ],
          isError: false,
        };
      }

      if (requestState?.flow === "checkpoint") {
        if (
          (parsedInput.action !== undefined && parsedInput.action !== "run" && parsedInput.action !== "resume") ||
          parsedInput.background ||
          parsedInput.resumeFromRunId !== undefined ||
          parsedInput.checkpointReplies !== undefined
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid workflow checkpoint retry: the original foreground run arguments must be replayed unchanged",
          );
        }
        const persisted = manager.getPersistence().load(requestState.runId);
        const checkpoint = persisted?.checkpointContext;
        if (
          persisted?.status !== "paused" ||
          persisted.pauseReason !== "checkpoint_required" ||
          checkpoint === undefined ||
          checkpoint.callIndex !== requestState.callIndex ||
          checkpoint.hash !== requestState.checkpointHash
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid workflow checkpoint retry: runId "${requestState.runId}" is no longer paused at that checkpoint`,
          );
        }

        let decision: unknown;
        let hasDecision = false;
        if (requestState.expiresAt !== undefined && Date.now() >= requestState.expiresAt) {
          decision = checkpoint.default ?? true;
          hasDecision = true;
        } else {
          const response = inputResponse(ctx.mcpReq.inputResponses, "checkpoint");
          if (response.kind === "elicit") {
            if (response.action !== "accept") {
              decision = false;
              hasDecision = true;
            } else if (checkpoint.kind === "input" && typeof response.content?.value === "string") {
              decision = response.content.value;
              hasDecision = true;
            } else if (
              checkpoint.kind === "select" &&
              typeof response.content?.choice === "string" &&
              checkpoint.choices?.includes(response.content.choice)
            ) {
              decision = response.content.choice;
              hasDecision = true;
            } else if (checkpoint.kind === "confirm" && typeof response.content?.approve === "boolean") {
              decision = response.content.approve;
              hasDecision = true;
            }
          }
        }

        if (!hasDecision) {
          const elicitation = createCheckpointElicitation(checkpoint.prompt, checkpoint);
          if (elicitation === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Persisted checkpoint cannot be represented as MCP elicitation");
          }
          return inputRequired({
            inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
            requestState: await requestStateCodec.mint(requestState, ctx),
          });
        }

        parsedInput = parsedInput.action === "resume"
          ? {
              ...parsedInput,
              runId: requestState.runId,
              checkpointReplies: { [requestState.callIndex]: decision },
            }
          : {
              ...parsedInput,
              resumeFromRunId: requestState.runId,
              checkpointReplies: { [requestState.callIndex]: decision },
            };
      }

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
      if (parsedInput.action === "result") {
        try {
          const page = resultRetrievalPage(
            scriptResources,
            parsedInput.runId,
            parsedInput.offset ?? 0,
            parsedInput.maxBytes ?? WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT,
          );
          const resultLink = scriptResources.resultLink(parsedInput.runId);
          return {
            structuredContent: { ...page },
            content: [
              {
                type: "text",
                text: JSON.stringify(page),
                annotations: { audience: ["assistant"] },
              },
              ...(resultLink === undefined ? [] : [resultLink]),
              ...eventsContentBlocks(scriptResources, parsedInput.runId),
            ],
            isError: false,
          };
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }
      }

      if (parsedInput.action === "permissions-response") {
        const acknowledgement = await respondToPermission(
          manager,
          {
            runId: parsedInput.runId,
            permissionId: parsedInput.permissionId,
            response: parsedInput.response,
          },
          permissionBroker,
          options.runControl,
        );
        const status = manager.inspectRun(parsedInput.runId, { lastN: 20, logLines: 20 });
        if (!status) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `No workflow run found for runId "${parsedInput.runId}" after its permission response.`,
          );
        }
        const lineage = scriptResources.lineage(parsedInput.runId);
        const pendingPermissions = await pendingPermissionsForRun(
          manager,
          parsedInput.runId,
          permissionBroker,
          options.runControl,
        );
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: workflowScriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
            lineage,
            pendingPermissions,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        return {
          structuredContent: {
            ...projected,
            permissionResponse: acknowledgement,
          },
          content: [
            {
              type: "text",
              text:
                `Permission ${acknowledgement.permissionId} resolved for workflow run ${parsedInput.runId}.\n` +
                formatInspectionSummary(projected) +
                formatPendingPermissions(pendingPermissions),
              annotations: { audience: ["assistant"] },
            },
            ...resultContentBlocks(scriptResources, parsedInput.runId, false),
            ...scriptResources.links(lineage),
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
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
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
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
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Workflow run "${parsedInput.runId}" is already terminal (${persisted.status}); no agent call is in flight to cancel. Whole-run stop without callIndex is a successful no-op for terminal runs.`,
            );
          }
          let cancellation: WorkflowAgentCallCancellation;
          if (!manager.getRun(parsedInput.runId)) {
            if (!options.runControl) {
              throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Workflow run "${parsedInput.runId}" is persisted as ${persisted.status}, but there is nothing live to cancel in this server process.`,
              );
            }
            const routed = await options.runControl.control(manager, {
              runId: parsedInput.runId,
              callIndex: parsedInput.callIndex,
            });
            if (routed.kind !== "agent") {
              throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `Workflow agent cancellation returned an invalid routed outcome for runId "${parsedInput.runId}".`,
              );
            }
            cancellation = routed.cancellation;
          } else {
            try {
              cancellation = await manager.cancelAgentCall(parsedInput.runId, parsedInput.callIndex);
            } catch (error) {
              throw new ProtocolError(
                error instanceof WorkflowError && error.code === WorkflowErrorCode.PERSISTENCE_ERROR
                  ? ProtocolErrorCode.InternalError
                  : ProtocolErrorCode.InvalidParams,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
          if (!status) {
            throw new ProtocolError(
              ProtocolErrorCode.InternalError,
              `Workflow agent cancellation did not produce a snapshot for runId "${parsedInput.runId}".`,
            );
          }
          const lineage = scriptResources.lineage(parsedInput.runId);
          const projected = addInspectionResourceFields(
            status,
            {
              scriptUri: workflowScriptUri(parsedInput.runId),
              ...resultResourceFields(scriptResources, parsedInput.runId),
              ...latestActivityFields(scriptResources, parsedInput.runId, status),
              lineage,
            },
            inspectionRetentionMetadata(manager, parsedInput.runId, status),
          );
          return {
            structuredContent: { ...projected },
            content: [
              { type: "text", text: formatAgentCancellationSummary(projected, cancellation) },
              ...scriptResources.links(lineage),
              ...eventsContentBlocks(scriptResources, parsedInput.runId),
            ],
            isError: false,
          };
        }

        let stopped = false;
        let alreadyTerminal = isAlreadyTerminalForStop(persisted.status);
        if (!alreadyTerminal) {
          const live = manager.getRun(parsedInput.runId);
          if (!live) {
            if (options.runControl) {
              const routed = await options.runControl.control(manager, {
                runId: parsedInput.runId,
                forceOwner: parsedInput.forceOwner,
              });
              if (routed.kind !== "whole") {
                throw new ProtocolError(
                  ProtocolErrorCode.InternalError,
                  `Workflow stop returned an invalid routed outcome for runId "${parsedInput.runId}".`,
                );
              }
              if (routed.state === "pending") {
                const pendingStatus = manager.inspectRun(parsedInput.runId, inspectionOptions);
                if (!pendingStatus) {
                  throw new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
                  );
                }
                if (pendingStatus.status !== "pending" && pendingStatus.status !== "running") {
                  throw new ProtocolError(
                    ProtocolErrorCode.InternalError,
                    `Workflow stop intent ${routed.operationId} remained pending but runId "${parsedInput.runId}" is ${pendingStatus.status}.`,
                  );
                }
                const lineage = scriptResources.lineage(parsedInput.runId);
                const projected = addInspectionResourceFields(
                  pendingStatus,
                  {
                    scriptUri: workflowScriptUri(parsedInput.runId),
                    ...resultResourceFields(scriptResources, parsedInput.runId),
                    ...latestActivityFields(scriptResources, parsedInput.runId, pendingStatus),
                    lineage,
                    stopped: false as const,
                    alreadyTerminal: false as const,
                    control: {
                      state: "pending" as const,
                      operationId: routed.operationId,
                      requestedAt: routed.requestedAt,
                      ...(routed.owner === undefined ? {} : { owner: routed.owner }),
                    },
                  },
                  inspectionRetentionMetadata(manager, parsedInput.runId, pendingStatus),
                );
                const result: WorkflowStopPendingResult = {
                  ...projected,
                  status: pendingStatus.status,
                };
                const currentLink = scriptResources
                  .links(lineage)
                  .filter((link) => link.uri === workflowScriptUri(parsedInput.runId));
                return {
                  structuredContent: { ...result },
                  content: [
                    { type: "text", text: formatPendingStopSummary(result) },
                    ...currentLink,
                    ...eventsContentBlocks(scriptResources, parsedInput.runId),
                  ],
                  isError: false,
                };
              }
              stopped = routed.stopped;
              alreadyTerminal = routed.alreadyTerminal;
            } else {
              const cold = manager.stopPersistedRun(parsedInput.runId);
              stopped = cold.outcome === "stopped";
              alreadyTerminal = cold.outcome === "already-terminal";
              if (cold.outcome === "owned-elsewhere") {
                throw new ProtocolError(
                  ProtocolErrorCode.InvalidParams,
                  `Workflow run "${parsedInput.runId}" is persisted as ${persisted.status} and is owned by another live process; this server has no daemon run-control router.`,
                );
              }
              if (cold.outcome === "missing") {
                throw new ProtocolError(
                  ProtocolErrorCode.InvalidParams,
                  `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
                );
              }
            }
          } else {
            stopped = manager.stop(parsedInput.runId);
            if (!stopped) {
              const current = manager.getPersistence().load(parsedInput.runId);
              alreadyTerminal = current !== null && isAlreadyTerminalForStop(current.status);
              if (!alreadyTerminal) {
                const cold = manager.stopPersistedRun(parsedInput.runId);
                stopped = cold.outcome === "stopped";
                alreadyTerminal = cold.outcome === "already-terminal";
              }
              if (!stopped && !alreadyTerminal) {
                throw new ProtocolError(
                  ProtocolErrorCode.InvalidParams,
                  `Workflow run "${parsedInput.runId}" could not be stopped; its persisted status is ${current?.status ?? persisted.status}.`,
                );
              }
            }
          }
          if (stopped) {
            scriptResources.cancelPendingElicitation(parsedInput.runId);
            requireDurableStoppedRun(manager, parsedInput.runId);
          }
        }

        const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
        if (!status) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `No workflow run found for runId "${parsedInput.runId}" in this server's project-scoped run store.`,
          );
        }
        if (status.status === "pending" || status.status === "running" || status.status === "paused") {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Workflow stop did not produce a terminal snapshot for runId "${parsedInput.runId}".`,
          );
        }
        backgroundRuns.evict(parsedInput.runId);
        const lineage = scriptResources.lineage(parsedInput.runId);
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: workflowScriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
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
          content: [
            { type: "text", text: formatStopSummary(result) },
            ...resultContentBlocks(scriptResources, parsedInput.runId, false),
            ...currentLink,
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
          ],
          isError: false,
        };
      }

      if (parsedInput.action === "status") {
        if (ctx.mcpReq.signal.aborted) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow status request for runId "${parsedInput.runId}" was cancelled; the workflow was not cancelled.`,
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
        const waitMs = parsedInput.waitMs ?? 0;
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

        let pendingPermissions = manager.getRun(parsedInput.runId)
          ? permissionBroker.list(parsedInput.runId)
          : await pendingPermissionsForRun(
              manager,
              parsedInput.runId,
              permissionBroker,
              options.runControl,
            );
        let returnedBecause: WorkflowStatusToolResult["wait"]["returnedBecause"];
        if (isTerminalStatus(status.status)) {
          returnedBecause = "terminal";
        } else if (pendingPermissions.length > 0) {
          returnedBecause = "action-required";
        } else if (waitMs === 0) {
          returnedBecause = "immediate";
        } else {
          const local = manager.getRun(parsedInput.runId) !== undefined;
          const waited = await waitForTerminal(
            manager,
            parsedInput.runId,
            waitMs,
            ctx.mcpReq.signal,
            backgroundRuns.get(parsedInput.runId),
            createAwaitProgressReporter(ctx),
            local ? permissionBroker.waitForPending(parsedInput.runId) : undefined,
            !local && options.runControl
              ? async () => (await options.runControl!.listPermissions(manager, parsedInput.runId)).length > 0
              : undefined,
          );
          if (waited === AWAIT_CANCELLED) {
            return {
              content: [
                {
                  type: "text",
                  text: `Workflow status request for runId "${parsedInput.runId}" was cancelled; the workflow was not cancelled.`,
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
          pendingPermissions = await pendingPermissionsForRun(
            manager,
            parsedInput.runId,
            permissionBroker,
            options.runControl,
          );
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
          returnedBecause = isTerminalStatus(status.status)
            ? "terminal"
            : waited === "action-required" || pendingPermissions.length > 0
              ? "action-required"
              : "timeout";
        }

        const canElicitPermission = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
        let permissionResponse: WorkflowPermissionResponseAcknowledgement | undefined;
        if (pendingPermissions.length > 0 && canElicitPermission) {
          const permission = pendingPermissions[0]!;
          if (options.protocolEra === "modern") {
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "permission",
              inputHash,
              scriptHash: workflowScriptHash(parsedInput.runId),
              runId: parsedInput.runId,
              permissionId: permission.permissionId,
            };
            return inputRequired({
              inputRequests: { permission: inputRequired.elicit(createPermissionElicitation(permission)) },
              requestState: await requestStateCodec.mint(state, ctx),
            });
          }
          try {
            await primeCancellableServerRequestId(mcp.server);
            const elicited = await mcp.server.elicitInput(createPermissionElicitation(permission), {
              signal: ctx.mcpReq.signal,
            });
            permissionResponse = await respondToPermission(
              manager,
              {
                runId: parsedInput.runId,
                permissionId: permission.permissionId,
                response: permissionResponseFromElicitation(permission, elicited),
              },
              permissionBroker,
              options.runControl,
            );
            pendingPermissions = await pendingPermissionsForRun(
              manager,
              parsedInput.runId,
              permissionBroker,
              options.runControl,
            );
            returnedBecause = "permission-resolved";
          } catch {
            // Leave the request pending for an explicit response or a later elicitation attempt.
          }
        }

        const tokenUsage = currentTokenUsage(manager, parsedInput.runId);
        const baseOutcome = isTerminalStatus(status.status)
          ? terminalOutcome(manager, scriptResources, parsedInput.runId, status)
          : undefined;
        const outcome = baseOutcome;
        const lineage = scriptResources.lineage(parsedInput.runId);
        const wait = {
          requestedMs: waitMs,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          returnedBecause,
        };
        const projected = addInspectionResourceFields(
          status,
          {
            wait,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            pendingPermissions,
            interaction: permissionInteraction(canElicitPermission),
            ...(permissionResponse === undefined ? {} : { permissionResponse }),
            scriptUri: workflowScriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
            lineage,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        const result: WorkflowStatusToolResult = {
          ...projected,
          ...(outcome === undefined ? {} : { outcome }),
        };
        return {
          structuredContent: { ...result },
          content: [
            // The status summary is model input; the run-monitor panel is the user's live view.
            {
              type: "text",
              text: formatStatusSummary(result) + formatPendingPermissions(pendingPermissions),
              annotations: { audience: ["assistant"] },
            },
            ...resultContentBlocks(scriptResources, parsedInput.runId, true),
            ...scriptResources.links(lineage),
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
          ],
          isError: false,
        };
      }

      let executionInput: WorkflowExecuteToolInput;
      let scriptSource: "inline" | "path" | "stored";
      if (parsedInput.action === "resume") {
        const resumeInput: WorkflowResumeToolInput = parsedInput;
        let source: PersistedRunState | null;
        try {
          source = manager.getPersistence().load(parsedInput.runId);
        } catch {
          return {
            content: [{
              type: "text",
              text: `Cannot resume workflow run "${parsedInput.runId}": its persisted source content is unreadable.`,
            }],
            isError: true,
          };
        }
        if (source === null) {
          return {
            content: [{
              type: "text",
              text: `Cannot resume workflow run "${parsedInput.runId}": the source run is missing or its persisted content is unreadable.`,
            }],
            isError: true,
          };
        }
        if (
          source.runId !== parsedInput.runId ||
          typeof source.script !== "string" ||
          source.script.length === 0
        ) {
          return {
            content: [{
              type: "text",
              text: `Cannot resume workflow run "${parsedInput.runId}": its persisted source script is missing or unreadable.`,
            }],
            isError: true,
          };
        }
        if (resumeInput.args === undefined && source.argsUnreplayable === true) {
          return {
            content: [{
              type: "text",
              text: `Cannot resume workflow run "${parsedInput.runId}": its stored args are not replayable strict JSON.`,
            }],
            isError: true,
          };
        }
        executionInput = {
          action: "run",
          script: source.script,
          args: resumeInput.args === undefined ? source.args : resumeInput.args,
          maxAgents: resumeInput.maxAgents,
          concurrency: resumeInput.concurrency,
          agentRetries: resumeInput.agentRetries,
          resumeFromRunId: resumeInput.runId,
          resumePolicy: resumeInput.resumePolicy,
          checkpointReplies: resumeInput.checkpointReplies,
          background: resumeInput.background,
        };
        scriptSource = "stored";
      } else {
        executionInput = parsedInput;
        scriptSource = executionInput.script === undefined ? "path" : "inline";
      }
      const input = clampWorkflowInput(executionInput);
      const admittedScript = input.script ?? readScriptAtAdmission(input.scriptPath);
      if (requestState !== undefined && requestState.scriptHash !== workflowScriptHash(admittedScript)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Invalid workflow requestState: scriptPath content changed during the multi-round-trip call",
        );
      }
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

        // Trust gate for script-declared meta.backends — BEFORE any run exists. Legacy keeps
        // its established push elicitation path; modern returns inputRequired and re-enters this
        // same tool handler with integrity-protected approval state.
        const backendsGate = options.protocolEra === "modern"
          ? resolveModernScriptBackends(admittedScript, approvedBackendKeys)
          : await resolveScriptBackends(mcp.server, admittedScript, backendApprovals);
        if (!backendsGate.ok) {
          if ("approval" in backendsGate) {
            const { name, config, key } = backendsGate.approval;
            if (declinedBackendKey === key) {
              return {
                content: [{ type: "text", text: declinedBackendMessage(name, config) }],
                isError: true,
              };
            }
            if (!toolCatalog.clientCapabilities(ctx)?.elicitation) {
              return {
                content: [{
                  type: "text",
                  text:
                    `This workflow declares custom ACP backends (meta.backends: ${name}), which spawn commands on this machine ` +
                    `and require user approval — but this MCP client does not support elicitation. To allow script-declared ` +
                    `backends, set ${ALLOW_SCRIPT_BACKENDS_ENV}=1 in the "env" block of this server's mcpServers config entry ` +
                    `(this approves ALL script-declared backends headlessly), or remove meta.backends and register the backends ` +
                    `host-side via AGENTPRISM_BACKENDS instead.`,
                }],
                isError: true,
              };
            }
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "backend-approval",
              inputHash,
              scriptHash: workflowScriptHash(admittedScript),
              approvedKeys: [...approvedBackendKeys].sort(),
              pendingKey: key,
            };
            return inputRequired({
              inputRequests: {
                backendApproval: inputRequired.elicit(backendApprovalElicitation(name, config)),
              },
              requestState: await requestStateCodec.mint(state, ctx),
            });
          }
          return {
            content: [{ type: "text", text: backendsGate.message }],
            isError: true,
          };
        }

        // Discover whether the mocked execution reaches any agent call whose backend remains
        // completely unauthored. This pass deliberately skips live config probes: it exists only
        // to avoid probing backends for deterministic/no-agent or fully pinned workflows.
        const routingDiscovery = await validateWorkflowScript(admittedScript, {
          args: input.args,
          cwd: context.projectDir,
          maxAgents: input.maxAgents,
          timeoutMs: 30_000,
          probeConfig: false,
          loadSavedWorkflow: (name) => context.manager.resolveSavedWorkflow(name),
        });

        let defaultModel: string | undefined;
        let defaultBackendWarning: string | undefined;
        if (workflowNeedsPinnedDefault(routingDiscovery) || workflowMayUseDefaultModel(admittedScript)) {
          const explicitDefault = process.env[DEFAULT_BACKEND_ENV] !== undefined;
          if (explicitDefault) {
            // Preserve the explicit operator contract, including its historical unknown/empty ->
            // Claude resolution. Pin the runner's resolved backend into engine identity for this run.
            defaultModel = probeRunner.defaultBackendId?.();
          } else {
            const source = input.resumeFromRunId
              ? context.manager.getPersistence().load(input.resumeFromRunId)
              : null;
            defaultModel = recordedDefaultModel(source);
            if (defaultModel) {
              defaultBackendWarning =
                `Model-less agent calls inherit pinned backend ${JSON.stringify(defaultModel)} from the resume source; ` +
                "the run will not switch providers automatically.";
            } else if (probeRunner.defaultBackendId && probeRunner.listBackends) {
              try {
                const selected = await discoverProjectDefaultBackend(context, probeRunner);
                defaultModel = selected.backendId;
                defaultBackendWarning =
                  `Model-less agent calls use auto-selected backend ${JSON.stringify(selected.backendId)} for this run ` +
                  `(${selected.reason}); the run will not switch providers automatically.`;
              } catch (error) {
                if (error instanceof NoAutoDefaultBackendError) {
                  return {
                    content: [{ type: "text", text: truncateUtf8(error.message, 8_192, "…[backend diagnostics truncated]") }],
                    isError: true,
                  };
                }
                throw error;
              }
            }
          }
        }

        // Full zero-token preflight: execute control flow against the mock runner using the same
        // pinned default as live execution, resolve host-served nested workflows, then probe each
        // routed backend/model without prompting. Invalid scripts are diagnostics, not failed runs:
        // admission has not started yet.
        const preflight = await validateWorkflowScript(admittedScript, {
          args: input.args,
          cwd: context.projectDir,
          maxAgents: input.maxAgents,
          timeoutMs: 30_000,
          defaultModel,
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
        const admissionWarnings = [
          ...(defaultBackendWarning ? [defaultBackendWarning] : []),
          ...preflight.warnings,
        ];
        if (admissionWarnings.length > 0) {
          const lines = admissionWarnings.slice(0, 20).map((warning) => `- ${warning}`);
          if (admissionWarnings.length > lines.length) {
            lines.push(`- … ${admissionWarnings.length - lines.length} more warning(s) omitted`);
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
                  text: "Background workflow limit reached (4 active or starting runs). Check an existing run with status and retry.",
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
          defaultModel,
          scriptBackends: backendsGate.backends,
          maxAgents: input.maxAgents,
          concurrency: input.concurrency,
          agentRetries: input.agentRetries,
          resumeFromRunId: input.resumeFromRunId,
          resumePolicy: input.resumePolicy,
          checkpointReplies: input.checkpointReplies,
        };
        if (!input.background) {
          const reporter = createProgressReporter(ctx);
          let lastActivitySeq = 0;
          exec.signal = ctx.mcpReq.signal;
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
          // A callback is a LIVE channel and therefore wins over headless:"pause". Legacy
          // retains push elicitation. Modern deliberately raises a durable pause so the outer
          // tool handler can return inputRequired and resume on the client's retry.
          const canElicit = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
          if (canElicit) {
            if (options.protocolEra === "modern") {
              exec.pauseOnCheckpoint = true;
            } else {
              elicitationController = new AbortController();
              cancelElicitationFromRequest = () => elicitationController?.abort();
              ctx.mcpReq.signal.addEventListener("abort", cancelElicitationFromRequest, { once: true });
              if (ctx.mcpReq.signal.aborted) elicitationController.abort();
              exec.confirm = createConfirm(mcp.server, elicitationController.signal);
            }
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
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow admission did not resolve run limits");
          }
          executionLatch.admit();
          const workflowName = admittedRun.snapshot.name;
          backgroundRuns.track(started.runId, started.promise);
          backgroundReservation = false;
          const scriptUri = workflowScriptUri(started.runId);
          const eventsUri = scriptResources.availableEventsUri(started.runId);
          if (eventsUri === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow admission lost its durable events resource");
          }
          const links = scriptResources.links([
            { runId: started.runId, uri: scriptUri, available: true },
          ]);
          return {
            structuredContent: {
              runId: started.runId,
              status: "running" as const,
              scriptSource,
              scriptUri,
              eventsUri,
              limits: admittedRun.limits,
              ...(admittedRun.replayEligibility === undefined
                ? {}
                : { replayEligibility: admittedRun.replayEligibility }),
              pendingPermissions: permissionBroker.list(started.runId),
              interaction: permissionInteraction(Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation)),
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
                  `Call workflow with action="status" and this runId to read it immediately, or add a positive ` +
                  `waitMs to wait for a milestone. Status returns early when an ACP ` +
                  `permission needs a response; use the elicitation shown by capable clients or ` +
                  `action="permissions-response" with an exact advertised option. If a live run-monitor panel ` +
                  `is shown for this run, it self-updates and reports phase starts, pauses, and terminal outcomes — ` +
                  `call status only when the model needs machine-readable state or wants to wait.`,
              },
              ...links,
              ...eventsContentBlocks(scriptResources, started.runId),
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
        const settled = await settleForegroundRunOrPermission(manager, started, permissionBroker);
        if (settled.kind === "permission") {
          const admittedRun = manager.getRun(started.runId);
          if (!admittedRun?.limits) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow permission wait lost its live run limits");
          }
          backgroundRuns.track(started.runId, started.promise);
          const pendingPermissions = permissionBroker.list(started.runId);
          const scriptUri = workflowScriptUri(started.runId);
          const eventsUri = scriptResources.availableEventsUri(started.runId);
          if (eventsUri === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow admission lost its durable events resource");
          }
          const canElicitPermission = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
          return {
            structuredContent: {
              runId: started.runId,
              status: "running" as const,
              scriptSource,
              scriptUri,
              eventsUri,
              limits: admittedRun.limits,
              pendingPermissions,
              interaction: permissionInteraction(canElicitPermission),
              ...(admittedRun.replayEligibility === undefined
                ? {}
                : { replayEligibility: admittedRun.replayEligibility }),
            },
            content: [
              {
                type: "text",
                text:
                  `Workflow "${admittedRun.snapshot.name}" is still running but requires a permission response.\n` +
                  `runId: ${started.runId}\n` +
                  formatPendingPermissions(pendingPermissions).trimStart() +
                  `\nCall workflow with action="status"; elicitation-capable clients will ` +
                  `present the pending choice, and other clients can use action="permissions-response".`,
              },
              ...scriptResources.links([{ runId: started.runId, uri: scriptUri, available: true }]),
              ...eventsContentBlocks(scriptResources, started.runId),
            ],
            isError: false,
          };
        }
        const run = settled.run;
        if (
          options.protocolEra === "modern" &&
          toolCatalog.clientCapabilities(ctx)?.elicitation &&
          run.status === "paused" &&
          run.reason === "checkpoint_required" &&
          run.checkpointContext !== undefined
        ) {
          const checkpoint = run.checkpointContext;
          const elicitation = createCheckpointElicitation(checkpoint.prompt, checkpoint);
          if (elicitation === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Paused checkpoint cannot be represented as MCP elicitation");
          }
          const timeoutMs = readCheckpointTimeoutMs(checkpoint);
          const state: WorkflowMcpRequestState = {
            version: 1,
            flow: "checkpoint",
            inputHash,
            scriptHash: workflowScriptHash(admittedScript),
            runId: run.runId,
            callIndex: checkpoint.callIndex,
            checkpointHash: checkpoint.hash,
            approvedKeys: [...approvedBackendKeys].sort(),
            ...(timeoutMs === undefined ? {} : { expiresAt: Date.now() + timeoutMs }),
          };
          return inputRequired({
            inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
            requestState: await requestStateCodec.mint(state, ctx),
          });
        }
        const scriptUri = workflowScriptUri(run.runId);
        const resultFields = resultResourceFields(scriptResources, run.runId);
        const eventsUri = resultFields.eventsUri;
        if (eventsUri === undefined) {
          throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow result lost its durable events resource");
        }
        const structuredContent = {
          ...toWorkflowToolResult(run, { scriptSource, scriptUri, ...resultFields, eventsUri }),
        };
        const isError = run.status === "failed" || run.status === "aborted";
        return {
          structuredContent: { ...structuredContent },
          content: [
            { type: "text", text: `${formatRunSummary(run)}${preflightWarningText}` },
            ...resultContentBlocks(scriptResources, run.runId, true),
            ...scriptResources.links([{ runId: run.runId, uri: scriptUri, available: true }]),
            ...eventsContentBlocks(scriptResources, run.runId),
          ],
          isError,
        };
      } finally {
        executionLatch.deny();
        if (foregroundRunId) scriptResources.cancelPendingElicitation(foregroundRunId);
        else elicitationController?.abort();
        if (cancelElicitationFromRequest) {
          ctx.mcpReq.signal.removeEventListener("abort", cancelElicitationFromRequest);
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
  mcp.registerTool("workflow", workflowToolConfig, workflowToolHandler);

  // Register the Apps union once. tools/list, direct app-only calls, and the fixed UI resource
  // are projected from the current request's capabilities; no modern request inherits another
  // request's decision, including on long-lived stdio connections.
  registerWorkflowAppUi(mcp, {
    readEventsPage: (request) => scriptResources.readEventsPage(request),
    registerResourceReader: (uri, read) =>
      scriptResources.registerExternalResourceReader(uri, read, (ctx) => toolCatalog.supportsApps(ctx)),
  });
  toolCatalog.setWorkflowAppResource(RUN_MONITOR_RESOURCE_URI);
  toolCatalog.installListHandler();

  // Legacy capabilities are initialize-scoped. Modern requests bypass this snapshot and read
  // only their own ctx.mcpReq.envelope through CapabilityAwareToolCatalog.
  const previousOnInitialized = mcp.server.oninitialized;
  mcp.server.oninitialized = () => {
    previousOnInitialized?.();
    if (toolCatalog.setLegacyCapabilities(mcp.server.getClientCapabilities())) {
      void mcp.sendToolListChanged();
    }
  };

  if (options.disconnectReplClientOnClose) {
    const previousOnClose = mcp.server.onclose;
    mcp.server.onclose = () => {
      try {
        previousOnClose?.();
      } finally {
        const clientId = options.replClientId?.();
        if (clientId !== undefined) {
          replPresence.disconnect(clientId);
          replPresence.forget(clientId);
        }
      }
    };
  }

  return server;
}
