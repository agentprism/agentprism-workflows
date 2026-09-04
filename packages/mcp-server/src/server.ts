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
  ServerContext,
  ServerNotifier,
  ToolCallback,
  ResourceLink,
} from "@modelcontextprotocol/server";

// packages/mcp-server/src/server.ts
//
// The MCP shell: constructs an McpServer, registers the `workflow` and `repl` model-facing
// tools, serves their version-matched Agent Skills, and adds the user-controlled
// `author-workflow` prompt. This is the composition root where all three packages meet — the injected acp-agents
// AgentRunner is wired into a workflow-engine WorkflowManager (DI) and every tool call runs
// through WorkflowManager.runSync.
//
// Run model: foreground remains one tools/call awaited to completion; background admission
// acknowledges a process-local run and immediate bounded status snapshots read it later. This stays a
// plain ToolCallback, never an MCP task handler. The engine OWNS run identity/status/resume:
//   - runSync RESOLVES to a TERMINAL WorkflowRunResult (status completed|paused|failed|
//     aborted, carrying reason/resetHint) and does NOT throw on pause/fail/abort — so the
//     shell does no status composition and needs no lifecycle try/catch.
//   - resume continues the exact runId from its durable script, args, admitted provider
//     configuration, journal, events, cumulative usage, and checkpoint decisions.
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
  WorkflowAgentConfiguration,
  WorkflowAgentCallCancellation,
  WorkflowSnapshot,
  WorkflowBackendConfig,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "@automatalabs/workflows";
import type { AgentRunner, TokenUsage } from "@automatalabs/shared-types";
import { buildWorkflowAgentConfigurationPlan } from "./workflow-agent-configuration.js";
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
import type { WorkflowExecuteToolInput } from "./workflow-tool-input.js";
import {
  DEFAULT_BACKEND_ENV,
  NoAutoDefaultBackendError,
  discoverProjectDefaultBackend,
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
import { createProgressReporter, formatAgentProgressMessage } from "./progress.js";
import { registerAuthoringPrompt } from "./authoring-prompt.js";
import { registerAuthoringSkills, SKILLS_EXTENSION_ID } from "./authoring-skills.js";
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
// surfaced by hosts to orient the calling agent to the two model-facing tools and the two
// version-matched Agent Skills. Kept short and behavioral — exhaustive guidance is loaded through
// the host's skill activation path only when needed.
export const SERVER_INSTRUCTIONS = [
  "This server exposes two model-facing tools for orchestrating multi-agent work. workflow and repl " +
    "spawn subagents over the same ACP backends — the registry built-ins Claude, Codex, OpenCode, and " +
    "pi, plus any registered custom agents — and key durable state by an absolute projectDir " +
    "(required on the shared daemon; defaulted by a single-project server). Backend credentials come " +
    "from each agent's own login, so there is nothing auth-shaped to configure here.",
  "Version-matched authoring guidance is available through the server's Agent Skills. Activate " +
    "skill://agentprism-workflow-authoring/SKILL.md for deterministic workflow scripts, or " +
    "skill://agentprism-repl-orchestration/SKILL.md for the persistent REPL. Load a skill through " +
    "the host's skill-loading path, then read only the supporting resources it references as needed.",
  "• workflow — DETERMINISTIC BATCH orchestration. Use action:\"run\" with a JavaScript workflow " +
    "script that fans out agent() subagents and optional checkpoint() gates. background:true returns " +
    "a durable runId for bounded status, permissions-response, result, and stop calls; resume continues " +
    "the exact run from its durable admission and journal. action:\"config\" discovers the live backend " +
    "and model option catalog. Every run is statically checked, mock-executed, and config-probed before admission.",
  "• repl — INTERACTIVE STATEFUL orchestration. A persistent per-project JavaScript VM driven with " +
    "action:\"eval\". Named bindings, pending subagent handles, queued turns, checkpoints, and `_` " +
    "persist between calls and survive daemon restarts. Use it when the next orchestration step depends " +
    "on inspecting intermediate results.",
  "Rule of thumb: use workflow when you can script the whole plan ahead of time; use repl when you " +
    "want a live session that evolves call by call.",
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

function forwardRequestAbort(source: AbortSignal, abort: () => void): () => void {
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function detachableExecutionSignal(source: AbortSignal): { signal: AbortSignal; detach(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    detach: forwardRequestAbort(source, () => controller.abort(source.reason)),
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
    collectWith: ["run", "resume"] as ["run", "resume"],
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

const PERMISSION_KIND_MEANING: Record<string, string> = {
  allow_once: "Allow this exact tool request once.",
  allow_always: "Allow matching requests for this tool for the remainder of this agent session.",
  reject_once: "Reject this exact tool request once.",
  reject_always: "Reject matching requests for this tool for the remainder of this agent session.",
};

export function createPermissionElicitation(
  permission: WorkflowPendingPermission,
  phase = "Unphased",
): ElicitRequestFormParams {
  const tool = permission.request.toolCall;
  const title = typeof tool.title === "string" && tool.title.trim() !== ""
    ? tool.title
    : `${tool.kind ?? "tool"} request`;
  const optionLines = permission.request.options.map((option) =>
    `- ${option.optionId}: ${option.name} (${option.kind}) — ${PERMISSION_KIND_MEANING[option.kind] ?? "Apply this exact advertised response."}`
  );
  const visibleRequest = Object.fromEntries(
    (["rawInput", "content", "locations"] as const)
      .filter((field) => tool[field] !== undefined)
      .map((field) => [field, tool[field]]),
  );
  const requestDetails = truncateUtf8(
    JSON.stringify(visibleRequest, null, 2),
    8_192,
    "…[permission details truncated]",
  );
  return {
    mode: "form",
    message: [
      `Run: ${permission.runId}`,
      `Phase: ${phase}`,
      `Agent: ${permission.label ?? `call ${permission.callIndex}`}`,
      `Backend: ${permission.backendId}`,
      `Tool: ${title}`,
      `Kind: ${tool.kind ?? "unspecified"}`,
      "",
      "Sanitized request details:",
      requestDetails === "{}" ? "(No input, content, or locations were provided.)" : requestDetails,
      ...(permission.requestRedacted ? ["Sensitive values were redacted."] : []),
      ...(permission.requestTruncated ? ["The public request projection was bounded/truncated."] : []),
      "",
      "Exact advertised options and scope:",
      ...optionLines,
      "",
      "Select one exact advertised option.",
    ].join("\n"),
    requestedSchema: {
      type: "object",
      properties: {
        optionId: {
          type: "string",
          title: "Permission decision",
          description: optionLines.join(" "),
          enum: permission.request.options.map((option) => option.optionId),
        },
      },
      required: ["optionId"],
    },
  };
}

function permissionPhase(manager: WorkflowManager, permission: WorkflowPendingPermission): string {
  const status = manager.inspectRun(permission.runId, { lastN: 50, logLines: 0 });
  return status?.calls.find((call) => call.index === permission.callIndex)?.phase ??
    status?.currentPhase ??
    "Unphased";
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


/** Headless opt-in for script-declared backends (set in the mcpServers `env` block). */
const ALLOW_SCRIPT_BACKENDS_ENV = "AGENTPRISM_ALLOW_SCRIPT_BACKENDS";

function scriptBackendsAllowedByEnv(): boolean {
  const value = process.env[ALLOW_SCRIPT_BACKENDS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** One approval decision per unique spawn config. The key is the full config JSON so a script
 *  that changes a backend's command/args/env re-prompts; approvals are session-sticky,
 *  declines are not (the user may change their mind on a later call). */
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
    }
  | {
      version: 1;
      flow: "agent-configuration";
      inputHash: string;
      scriptHash: string;
      approvedKeys: string[];
      selectionHash: string;
    };

function supportsFormElicitation(capabilities: unknown): boolean {
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const elicitation = (capabilities as { elicitation?: unknown }).elicitation;
  if (elicitation === null || typeof elicitation !== "object" || Array.isArray(elicitation)) return false;
  const fields = Object.keys(elicitation);
  // The legacy capability was the empty object. Modern clients advertise the explicit form mode.
  if (fields.length === 0) return true;
  const form = (elicitation as { form?: unknown }).form;
  return form !== null && typeof form === "object" && !Array.isArray(form);
}

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
  if (state.flow === "agent-configuration") {
    if (
      !Array.isArray(state.approvedKeys) ||
      state.approvedKeys.length > 64 ||
      !state.approvedKeys.every((key) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key)) ||
      typeof state.selectionHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(state.selectionHash)
    ) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid workflow agent-configuration requestState");
    }
    return {
      version: 1,
      flow: "agent-configuration",
      inputHash,
      scriptHash: state.scriptHash as string,
      approvedKeys: [...new Set(state.approvedKeys)],
      selectionHash: state.selectionHash,
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

function latestActivitySummaryLines(activity: WorkflowRunLatestActivity[] | undefined): string[] {
  if (!activity || activity.length === 0) return [];
  const visible = activity.slice(-10);
  const lines = [
    `latest activity (last ${visible.length} of ${activity.length} calls with durable progress):`,
  ];
  for (const item of visible) {
    const attribution = item.label ? `agent "${item.label}"` : `call ${item.callIndex}`;
    const latestText = item.latestText?.replace(/\s+/g, " ").trim();
    const details = [
      ...(latestText ? [`assistant: ${latestText}`] : []),
      ...(item.lastToolName ? [`tool: ${item.lastToolName}`] : []),
    ];
    const detail = details.length > 0 ? details.join(" · ") : "progress event observed";
    const counters = [
      `${item.observedEvents} event${item.observedEvents === 1 ? "" : "s"}`,
      `${item.turnCount} turn${item.turnCount === 1 ? "" : "s"}`,
      ...(item.tokensObserved === undefined ? [] : [`${item.tokensObserved} tokens observed`]),
    ];
    lines.push(
      `  [${item.callIndex}] ${attribution} (${item.relevance}): ` +
        `${truncateUtf8(detail, 256, "…")} · ${counters.join(", ")}`,
    );
  }
  return lines;
}

function inspectionSummaryLines(
  status: WorkflowRunStatus & { latestActivity?: WorkflowRunLatestActivity[] },
): string[] {
  const lines = [`Workflow "${status.workflowName}" is ${status.status}.`, `runId: ${status.runId}`];
  if (status.phases.length > 0) lines.push(`phases: ${status.phases.join(", ")}`);
  if (status.currentPhase) lines.push(`current phase: ${status.currentPhase}`);
  if (status.reason) lines.push(`reason: ${status.reason}`);
  if (status.errorCode) lines.push(`error code: ${status.errorCode}`);
  lines.push(...latestActivitySummaryLines(status.latestActivity));
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

function scriptContentBlocks(resources: WorkflowScriptResources, runId: string): ResourceLink[] {
  const link = resources.scriptLink(runId);
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

function formatStatusSummary(result: WorkflowStatusToolResult): string {
  const [heading, runId, ...diagnostics] = inspectionSummaryLines(result);
  const lines = [heading, runId];
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
 * Build the MCP server with the `workflow` and `repl` model-facing tools, their Agent Skills,
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
  // capability and advertise Apps plus SEP-2640 Skills support before handler registration and
  // before createWorkflowServer returns. The current legacy era carries server extensions in
  // initialize; the separately gated modern era moves that advertisement to server/discover.
  mcp.server.registerCapabilities({
    resources: { subscribe: true, listChanged: true },
    extensions: {
      [EXTENSION_ID]: {},
      [SKILLS_EXTENSION_ID]: { directoryRead: true },
    },
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
  registerAuthoringSkills(mcp, {
    registerResourceReader: (uri, read) => scriptResources.registerExternalResourceReader(uri, read),
  });
  // Session-sticky approvals for script-declared backends (one prompt per unique spawn config).
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
      input.action === "result" ||
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
    title: "Run and manage deterministic agent workflows",
    description:
        "Validate, run, resume, observe, and control deterministic JavaScript agent workflows. " +
        "Use config before pinning live model, mode, or config-option ids; run validates explicit script or scriptPath content; resume continues the exact runId from durable state. " +
        "Use status for an immediate snapshot, result for exact completed JSON, permissions-response for a pending ACP choice, and stop for a run or one live call. " +
        (requireProjectDir
          ? "Config and run require an absolute projectDir on this shared daemon. "
          : "Config and run may omit projectDir on this single-project server. ") +
        "For deeper syntax and lifecycle guidance, activate skill://agentprism-workflow-authoring/SKILL.md through the host's skill-loading path and read only the references needed.",
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
      // inputRequired's SDK shim re-enters this handler for legacy elicitation too, while
      // modern 2026-07-28 clients retry over the wire. The signed state contract is shared.
      const encodedRequestState = typeof ctx.mcpReq.requestState === "function"
        ? ctx.mcpReq.requestState<unknown>()
        : undefined;
      const requestState = parseWorkflowRequestState(encodedRequestState, inputHash);
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
        let report = await probeHarnessConfig({
          harnesses: parsedInput.harnesses,
          modelSpecs: parsedInput.modelSpecs,
          cwd,
          probeRunner,
        });
        const missingCatalogBackends = [...new Set(
          report.harnessOptions
            .filter((harness) => !harness.probed && harness.model !== undefined)
            .map((harness) => harness.backendId)
            .filter((backendId) => !report.harnessOptions.some((harness) =>
              harness.probed && harness.backendId === backendId && harness.model === undefined)),
        )];
        if (missingCatalogBackends.length > 0) {
          const catalogs = await probeHarnessConfig({
            harnesses: missingCatalogBackends,
            cwd,
            probeRunner,
          });
          report = {
            ok: false,
            exitCode: 1,
            harnessOptions: [...report.harnessOptions, ...catalogs.harnessOptions],
          };
        }
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
        if (
          (parsedInput.action !== "run" && parsedInput.action !== "resume") ||
          parsedInput.background
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid workflow permission retry: the original foreground run or resume arguments must be replayed unchanged",
          );
        }
        const persisted = manager.getPersistence().load(requestState.runId);
        if (persisted === null || workflowScriptHash(persisted.script) !== requestState.scriptHash) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid workflow permission retry for runId "${requestState.runId}"`,
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
            inputRequests: {
              permission: inputRequired.elicit(createPermissionElicitation(permission, permissionPhase(manager, permission))),
            },
            requestState: await requestStateCodec.mint(requestState, ctx),
          });
        }
        // Capture the foreground promise before resolving the permission: a fast final agent can
        // settle and be removed from the registry in the same microtask turn as the response.
        const foregroundPromise = backgroundRuns.get(requestState.runId);
        const liveController = manager.getRun(requestState.runId)?.controller;
        const detachRetryAbort = liveController === undefined
          ? undefined
          : forwardRequestAbort(ctx.mcpReq.signal, () => liveController.abort());
        const response = permissionResponseFromElicitation(permission, input);
        const acknowledgement = await respondToPermission(
          manager,
          { runId: requestState.runId, permissionId: requestState.permissionId, response },
          permissionBroker,
          options.runControl,
        );

        if (foregroundPromise) {
          const settled = await settleForegroundRunOrPermission(
            manager,
            { runId: requestState.runId, promise: foregroundPromise },
            permissionBroker,
          );
          if (settled.kind === "permission") {
            const nextPermission = permissionBroker.list(requestState.runId)[0];
            if (!nextPermission) {
              throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow permission signal had no pending request");
            }
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "permission",
              inputHash,
              scriptHash: requestState.scriptHash,
              runId: requestState.runId,
              permissionId: nextPermission.permissionId,
            };
            const retry = inputRequired({
              inputRequests: {
                permission: inputRequired.elicit(createPermissionElicitation(
                  nextPermission,
                  permissionPhase(manager, nextPermission),
                )),
              },
              requestState: await requestStateCodec.mint(state, ctx),
            });
            detachRetryAbort?.();
            return retry;
          }

          const run = settled.run;
          if (
            run.status === "paused" &&
            run.reason === "checkpoint_required" &&
            run.checkpointContext
          ) {
            const checkpoint = run.checkpointContext;
            const elicitation = createCheckpointElicitation(checkpoint.prompt, checkpoint);
            if (!elicitation) {
              throw new ProtocolError(ProtocolErrorCode.InternalError, "Paused checkpoint cannot be elicited");
            }
            const timeoutMs = readCheckpointTimeoutMs(checkpoint);
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "checkpoint",
              inputHash,
              scriptHash: requestState.scriptHash,
              runId: requestState.runId,
              callIndex: checkpoint.callIndex,
              checkpointHash: checkpoint.hash,
              approvedKeys: [],
              ...(timeoutMs === undefined ? {} : { expiresAt: Date.now() + timeoutMs }),
            };
            const retry = inputRequired({
              inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
              requestState: await requestStateCodec.mint(state, ctx),
            });
            detachRetryAbort?.();
            return retry;
          }

          const scriptUri = workflowScriptUri(requestState.runId);
          const resultFields = resultResourceFields(scriptResources, requestState.runId);
          const eventsUri = resultFields.eventsUri;
          if (!eventsUri) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow result lost its durable events resource");
          }
          const scriptSource = parsedInput.action === "resume"
            ? "stored" as const
            : ("scriptPath" in parsedInput ? "path" as const : "inline" as const);
          const structuredContent = toWorkflowToolResult(run, {
            scriptSource,
            scriptUri,
            ...resultFields,
            eventsUri,
          });
          const result = {
            structuredContent: { ...structuredContent },
            content: [
              { type: "text" as const, text: formatRunSummary(run) },
              ...resultContentBlocks(scriptResources, requestState.runId, true),
              ...scriptContentBlocks(scriptResources, requestState.runId),
              ...eventsContentBlocks(scriptResources, requestState.runId),
            ],
            isError: run.status === "failed" || run.status === "aborted",
          };
          detachRetryAbort?.();
          return result;
        }

        // A daemon may have succeeded the owner between MRTR legs. The exact response was routed
        // to that owner; return one immediate persisted snapshot rather than turning status into
        // an interaction or waiting API.
        const status = manager.inspectRun(requestState.runId, { lastN: 20, logLines: 20 });
        if (!status) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `No workflow run found for runId "${requestState.runId}" after its permission response.`,
          );
        }
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
        const projected = addInspectionResourceFields(
          status,
          {
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            scriptUri: workflowScriptUri(requestState.runId),
            ...resultResourceFields(scriptResources, requestState.runId),
            ...latestActivityFields(scriptResources, requestState.runId, status),
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
        const responseResult = {
          structuredContent: { ...result },
          content: [
            {
              type: "text" as const,
              text: formatStatusSummary(result) + formatPendingPermissions(remaining),
              annotations: { audience: ["assistant"] as ["assistant"] },
            },
            ...resultContentBlocks(scriptResources, requestState.runId, true),
            ...scriptContentBlocks(scriptResources, requestState.runId),
            ...eventsContentBlocks(scriptResources, requestState.runId),
          ],
          isError: false,
        };
        detachRetryAbort?.();
        return responseResult;
      }

      if (requestState?.flow === "checkpoint") {
        if (
          (parsedInput.action !== "run" && parsedInput.action !== "resume") ||
          parsedInput.background
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid workflow checkpoint retry: the original foreground arguments must be replayed unchanged",
          );
        }
        const persisted = manager.getPersistence().load(requestState.runId);
        if (persisted === null || workflowScriptHash(persisted.script) !== requestState.scriptHash) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid workflow checkpoint retry for runId "${requestState.runId}"`,
          );
        }
        // The retried checkpoint is pending only while the run is still paused at that exact call.
        // A later or duplicate retry (the checkpoint was already answered, or the run moved on)
        // continues with the caller's original replies so the continuation reports the durable
        // decision or the currently pending checkpoint instead of failing the protocol call.
        const pending = persisted.pauseReason === "checkpoint_required" ? persisted.checkpointContext : undefined;
        const checkpoint = pending?.callIndex === requestState.callIndex ? pending : undefined;
        if (checkpoint !== undefined && checkpoint.hash !== requestState.checkpointHash) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid workflow checkpoint retry for runId "${requestState.runId}": checkpoint ${requestState.callIndex} changed identity`,
          );
        }
        // An explicit resume may already carry earlier answers (for example the reply that
        // reached this checkpoint). They stay in the batch: repeats are idempotent by contract.
        const priorReplies = parsedInput.action === "resume" ? parsedInput.checkpointReplies : undefined;

        let decision: unknown;
        let hasDecision = false;
        if (checkpoint !== undefined && requestState.expiresAt !== undefined && Date.now() >= requestState.expiresAt) {
          decision = checkpoint.default ?? true;
          hasDecision = true;
        } else {
          const response = inputResponse(ctx.mcpReq.inputResponses, "checkpoint");
          if (response.kind === "elicit") {
            const kind = checkpoint?.kind;
            const content = response.content;
            if (response.action !== "accept") {
              decision = false;
              hasDecision = true;
            } else if ((kind === undefined || kind === "input") && typeof content?.value === "string") {
              decision = content.value;
              hasDecision = true;
            } else if (
              (kind === undefined || kind === "select") &&
              typeof content?.choice === "string" &&
              (checkpoint?.choices === undefined || checkpoint.choices.includes(content.choice))
            ) {
              decision = content.choice;
              hasDecision = true;
            } else if ((kind === undefined || kind === "confirm") && typeof content?.approve === "boolean") {
              decision = content.approve;
              hasDecision = true;
            }
          }
        }

        if (!hasDecision && checkpoint !== undefined) {
          const elicitation = createCheckpointElicitation(checkpoint.prompt, checkpoint);
          if (elicitation === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Persisted checkpoint cannot be represented as MCP elicitation");
          }
          return inputRequired({
            inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
            requestState: await requestStateCodec.mint(requestState, ctx),
          });
        }

        parsedInput = {
          action: "resume",
          runId: requestState.runId,
          maxAgents: parsedInput.maxAgents,
          concurrency: parsedInput.concurrency,
          agentRetries: parsedInput.agentRetries,
          ...(hasDecision
            ? { checkpointReplies: { ...(priorReplies ?? {}), [requestState.callIndex]: decision } }
            : priorReplies === undefined
              ? {}
              : { checkpointReplies: priorReplies }),
          background: false,
        };
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
            ...scriptContentBlocks(scriptResources, parsedInput.runId),
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
          const cancellationOutcome = isTerminalStatus(status.status)
            ? terminalOutcome(manager, scriptResources, parsedInput.runId, status)
            : undefined;
          const projected = addInspectionResourceFields(
            status,
            {
              scriptUri: workflowScriptUri(parsedInput.runId),
              ...resultResourceFields(scriptResources, parsedInput.runId),
              ...latestActivityFields(scriptResources, parsedInput.runId, status),
              ...(cancellationOutcome === undefined ? {} : { outcome: cancellationOutcome }),
            },
            inspectionRetentionMetadata(manager, parsedInput.runId, status),
          );
          return {
            structuredContent: { ...projected },
            content: [
              { type: "text", text: formatAgentCancellationSummary(projected, cancellation) },
              ...scriptContentBlocks(scriptResources, parsedInput.runId),
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
                const projected = addInspectionResourceFields(
                  pendingStatus,
                  {
                    scriptUri: workflowScriptUri(parsedInput.runId),
                    ...resultResourceFields(scriptResources, parsedInput.runId),
                    ...latestActivityFields(scriptResources, parsedInput.runId, pendingStatus),
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
                return {
                  structuredContent: { ...result },
                  content: [
                    { type: "text", text: formatPendingStopSummary(result) },
                    ...scriptContentBlocks(scriptResources, parsedInput.runId),
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
          if (stopped) requireDurableStoppedRun(manager, parsedInput.runId);
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
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: workflowScriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
            stopped,
            alreadyTerminal,
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        const result: WorkflowStopResult = { ...projected, status: status.status };
        return {
          structuredContent: { ...result },
          content: [
            { type: "text", text: formatStopSummary(result) },
            ...resultContentBlocks(scriptResources, parsedInput.runId, false),
            ...scriptContentBlocks(scriptResources, parsedInput.runId),
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
        if (!manager.getRun(parsedInput.runId)) {
          manager.reconcileExternallyDeadRun(parsedInput.runId);
        }
        const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
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

        const pendingPermissions = manager.getRun(parsedInput.runId)
          ? permissionBroker.list(parsedInput.runId)
          : await pendingPermissionsForRun(
              manager,
              parsedInput.runId,
              permissionBroker,
              options.runControl,
            );
        // Status is observation-only even for form-capable clients. Permission elicitation belongs
        // to the foreground run/resume call that encountered it; background callers respond with
        // the explicit permissions-response action using this snapshot's exact advertised option.
        const canElicitPermission = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
        const tokenUsage = currentTokenUsage(manager, parsedInput.runId);
        const baseOutcome = isTerminalStatus(status.status)
          ? terminalOutcome(manager, scriptResources, parsedInput.runId, status)
          : undefined;
        const outcome = baseOutcome;
        const projected = addInspectionResourceFields(
          status,
          {
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            pendingPermissions,
            interaction: permissionInteraction(canElicitPermission),
            scriptUri: workflowScriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
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
            ...scriptContentBlocks(scriptResources, parsedInput.runId),
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
          ],
          isError: false,
        };
      }

      if (parsedInput.action === "resume") {
        const input = clampWorkflowInput(parsedInput);
        if (input.background && !backgroundRuns.reserve()) {
          return {
            content: [{ type: "text", text: "Background workflow limit reached (4 active or starting runs)." }],
            isError: true,
          };
        }
        let reserved = input.background;
        const reporter = input.background ? undefined : createProgressReporter(ctx);
        const foregroundAbort = input.background ? undefined : detachableExecutionSignal(ctx.mcpReq.signal);
        const canElicit = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
        try {
          const started = await manager.continueRun(input.runId, {
            agent: runner,
            maxAgents: input.maxAgents,
            concurrency: input.concurrency,
            agentRetries: input.agentRetries,
            checkpointReplies: input.checkpointReplies,
            ...(foregroundAbort === undefined ? {} : { signal: foregroundAbort.signal }),
            // Both MCP protocol eras durably pause later checkpoints and return the same
            // inputRequired lifecycle as a fresh foreground run.
            ...(!input.background && canElicit ? { pauseOnCheckpoint: true } : {}),
            ...(reporter === undefined
              ? {}
              : {
                  onProgress: (snapshot: WorkflowSnapshot) => {
                    const settled = snapshot.agents.filter(
                      (agent) => agent.status === "done" || agent.status === "error" || agent.status === "skipped",
                    ).length;
                    reporter(settled, snapshot.agents.length || undefined, snapshot.currentPhase);
                  },
                }),
          });
          if (!started.accepted) {
            const decisions = started.resolvedCheckpoints?.map((entry) =>
              `checkpoint ${entry.callIndex}: ${entry.outcome}; durable decision=${JSON.stringify(entry.decision)}` +
              (entry.ignored === undefined ? "" : `; ignored=${JSON.stringify(entry.ignored)}`)
            ).join("\n");
            // Running, terminal, and still-paused outcomes are observations of the run's real
            // state, not tool failures: the caller learns the durable decision or what is pending.
            const informational = started.reason === "running" ||
              started.reason === "terminal" ||
              started.reason === "checkpoint-required" ||
              started.reason === "auth-required";
            if (informational) {
              const status = manager.inspectRun(input.runId, { lastN: 20, logLines: 20 });
              if (!status) throw new ProtocolError(ProtocolErrorCode.InternalError, "Continuation snapshot disappeared");
              if (started.reason === "checkpoint-required" && !input.background && canElicit) {
                // A form-capable foreground caller answers the pending checkpoint directly; the
                // retry re-enters as resume with checkpointReplies for this exact call.
                const pausedState = manager.getPersistence().load(input.runId);
                const checkpoint = pausedState?.pauseReason === "checkpoint_required"
                  ? pausedState.checkpointContext
                  : undefined;
                const elicitation = checkpoint === undefined
                  ? undefined
                  : createCheckpointElicitation(checkpoint.prompt, checkpoint);
                if (pausedState && checkpoint && elicitation) {
                  const timeoutMs = readCheckpointTimeoutMs(checkpoint);
                  const state: WorkflowMcpRequestState = {
                    version: 1,
                    flow: "checkpoint",
                    inputHash,
                    scriptHash: workflowScriptHash(pausedState.script),
                    runId: input.runId,
                    callIndex: checkpoint.callIndex,
                    checkpointHash: checkpoint.hash,
                    approvedKeys: [],
                    ...(timeoutMs === undefined ? {} : { expiresAt: Date.now() + timeoutMs }),
                  };
                  return inputRequired({
                    inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
                    requestState: await requestStateCodec.mint(state, ctx),
                  });
                }
              }
              const pendingPermissions = await pendingPermissionsForRun(
                manager,
                input.runId,
                permissionBroker,
                options.runControl,
              );
              const permission = pendingPermissions[0];
              if (started.reason === "running" && !input.background && canElicit && permission) {
                const persistedState = manager.getPersistence().load(input.runId);
                if (!persistedState) {
                  throw new ProtocolError(ProtocolErrorCode.InternalError, "Pending permission lost its persisted run");
                }
                const state: WorkflowMcpRequestState = {
                  version: 1,
                  flow: "permission",
                  inputHash,
                  scriptHash: workflowScriptHash(persistedState.script),
                  runId: input.runId,
                  permissionId: permission.permissionId,
                };
                return inputRequired({
                  inputRequests: {
                    permission: inputRequired.elicit(createPermissionElicitation(
                      permission,
                      permissionPhase(manager, permission),
                    )),
                  },
                  requestState: await requestStateCodec.mint(state, ctx),
                });
              }
              const outcome = isTerminalStatus(status.status)
                ? terminalOutcome(manager, scriptResources, input.runId, status)
                : undefined;
              const projected = addInspectionResourceFields(
                status,
                {
                  ...(currentTokenUsage(manager, input.runId) === undefined
                    ? {}
                    : { tokenUsage: currentTokenUsage(manager, input.runId) }),
                  scriptUri: workflowScriptUri(input.runId),
                  ...resultResourceFields(scriptResources, input.runId),
                  ...latestActivityFields(scriptResources, input.runId, status),
                  pendingPermissions,
                  interaction: permissionInteraction(Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation)),
                },
                inspectionRetentionMetadata(manager, input.runId, status),
              );
              const result: WorkflowStatusToolResult = {
                ...projected,
                ...(outcome === undefined ? {} : { outcome }),
              };
              return {
                structuredContent: { ...result },
                content: [{
                  type: "text",
                  text: `Workflow run "${input.runId}" was not continued: ${started.reason}.` +
                    (decisions ? `\n${decisions}` : "") +
                    `\n${formatStatusSummary(result)}`,
                }],
                isError: false,
              };
            }
            return {
              content: [{
                type: "text",
                text: `Workflow run "${input.runId}" was not continued: ${started.reason}.` +
                  (decisions ? `\n${decisions}` : "") +
                  (started.reason.startsWith("admission-")
                    ? "\nThis persisted run lacks valid canonical continuation metadata; start a fresh run."
                    : ""),
              }],
              isError: true,
            };
          }
          const live = manager.getRun(input.runId);
          const persisted = manager.getPersistence().load(input.runId);
          const limits = live?.limits ?? persisted?.limits;
          if (!limits) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow continuation lost its durable limits");
          }
          const scriptUri = workflowScriptUri(input.runId);
          const eventsUri = scriptResources.availableEventsUri(input.runId);
          if (!eventsUri) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow continuation lost its events resource");
          }
          if (input.background) {
            backgroundRuns.track(input.runId, started.promise);
            reserved = false;
            return {
              structuredContent: {
                runId: input.runId,
                status: "running" as const,
                scriptSource: "stored" as const,
                scriptUri,
                eventsUri,
                limits,
                pendingPermissions: permissionBroker.list(input.runId),
                interaction: permissionInteraction(Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation)),
              },
              content: [
                { type: "text", text: `Continuing workflow run ${input.runId} in place.` },
                ...scriptContentBlocks(scriptResources, input.runId),
                ...eventsContentBlocks(scriptResources, input.runId),
              ],
              isError: false,
            };
          }

          const settled = await settleForegroundRunOrPermission(manager, started, permissionBroker);
          if (settled.kind === "permission") {
            backgroundRuns.track(input.runId, started.promise);
            const pendingPermissions = permissionBroker.list(input.runId);
            const permission = pendingPermissions[0];
            if (canElicit && permission) {
              const state: WorkflowMcpRequestState = {
                version: 1,
                flow: "permission",
                inputHash,
                scriptHash: workflowScriptHash(persisted?.script ?? ""),
                runId: input.runId,
                permissionId: permission.permissionId,
              };
              return inputRequired({
                inputRequests: {
                  permission: inputRequired.elicit(createPermissionElicitation(
                    permission,
                    permissionPhase(manager, permission),
                  )),
                },
                requestState: await requestStateCodec.mint(state, ctx),
              });
            }
            return {
              structuredContent: {
                runId: input.runId,
                status: "running" as const,
                scriptSource: "stored" as const,
                scriptUri,
                eventsUri,
                limits,
                pendingPermissions,
                interaction: permissionInteraction(canElicit),
              },
              content: [{
                type: "text",
                text: `Workflow run ${input.runId} is continuing and requires action="permissions-response"; status remains observation-only.`,
              }],
              isError: false,
            };
          }
          const run = settled.run;
          if (
            toolCatalog.clientCapabilities(ctx)?.elicitation &&
            run.status === "paused" &&
            run.reason === "checkpoint_required" &&
            run.checkpointContext
          ) {
            const checkpoint = run.checkpointContext;
            const elicitation = createCheckpointElicitation(checkpoint.prompt, checkpoint);
            if (!elicitation) throw new ProtocolError(ProtocolErrorCode.InternalError, "Paused checkpoint cannot be elicited");
            const timeoutMs = readCheckpointTimeoutMs(checkpoint);
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "checkpoint",
              inputHash,
              scriptHash: workflowScriptHash(persisted?.script ?? ""),
              runId: input.runId,
              callIndex: checkpoint.callIndex,
              checkpointHash: checkpoint.hash,
              approvedKeys: [],
              ...(timeoutMs === undefined ? {} : { expiresAt: Date.now() + timeoutMs }),
            };
            return inputRequired({
              inputRequests: { checkpoint: inputRequired.elicit(elicitation) },
              requestState: await requestStateCodec.mint(state, ctx),
            });
          }
          const resultFields = resultResourceFields(scriptResources, input.runId);
          const structuredContent = toWorkflowToolResult(run, {
            scriptSource: "stored",
            scriptUri,
            ...resultFields,
            eventsUri,
          });
          return {
            structuredContent: { ...structuredContent },
            content: [
              { type: "text", text: formatRunSummary(run) },
              ...resultContentBlocks(scriptResources, input.runId, true),
              ...scriptContentBlocks(scriptResources, input.runId),
              ...eventsContentBlocks(scriptResources, input.runId),
            ],
            isError: run.status === "failed" || run.status === "aborted",
          };
        } finally {
          foregroundAbort?.detach();
          if (reserved) backgroundRuns.releaseReservation();
        }
      }
      const executionInput: WorkflowExecuteToolInput = parsedInput;
      const scriptSource: "inline" | "path" = executionInput.script === undefined ? "path" : "inline";
      const input = clampWorkflowInput(executionInput);
      const admittedScript = input.script ?? readScriptAtAdmission(input.scriptPath);
      if (requestState !== undefined && requestState.scriptHash !== workflowScriptHash(admittedScript)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Invalid workflow requestState: scriptPath content changed during the multi-round-trip call",
        );
      }
      let backgroundReservation = false;
      let foregroundAbort: ReturnType<typeof detachableExecutionSignal> | undefined;
      const executionLatch = createExecutionAdmissionLatch();
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

        // Both supported protocol eras use the same integrity-protected lifecycle.
        const backendsGate = resolveModernScriptBackends(admittedScript, approvedBackendKeys);
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

        let agentConfigurations: ExecOptions["agentConfigurations"];
        let agentConfigurationElicited = false;
        const canConfigureAgents = supportsFormElicitation(toolCatalog.clientCapabilities(ctx));
        // Discovery has already resolved per-call, agentType, tier, phase, and meta models.
        // Optional mode/config omissions use backend defaults and do not require user input.
        const needsAgentConfiguration = routingDiscovery.dryRun?.agentCalls.some(
          (call) => call.model === undefined,
        ) === true;
        if (canConfigureAgents && needsAgentConfiguration) {
          const configuredHarnesses = [
            ...(probeRunner.listBackends?.() ?? []),
            ...Object.keys(backendsGate.backends ?? {}),
          ].filter((value, index, all) => all.indexOf(value) === index);
          const advertised = await probeHarnessConfig({
            cwd: context.projectDir,
            ...(configuredHarnesses.length === 0 ? {} : { harnesses: configuredHarnesses }),
            backends: backendsGate.backends,
            probeRunner,
          });
          let plan;
          try {
            plan = buildWorkflowAgentConfigurationPlan(
              staticValidation.parse.meta!,
              routingDiscovery.dryRun?.agentCalls ?? [],
              advertised.harnessOptions,
            );
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: truncateUtf8(
                  `Cannot configure this workflow before execution: ${error instanceof Error ? error.message : String(error)}`,
                  8_192,
                  "…[provider diagnostics truncated]",
                ),
              }],
              isError: true,
            };
          }
          if (plan !== undefined) {
            const selectionState = requestState?.flow === "agent-configuration" ? requestState : undefined;
            const response = selectionState?.selectionHash === plan.selectionHash
              ? inputResponse(ctx.mcpReq.inputResponses, "agentConfiguration")
              : { kind: "missing" as const };
            if (response.kind === "elicit") {
              if (response.action !== "accept") {
                return {
                  content: [{ type: "text", text: "Workflow execution cancelled because agent configuration was not accepted." }],
                  isError: true,
                };
              }
              try {
                agentConfigurations = plan.parse(response.content ?? {});
                agentConfigurationElicited = true;
              } catch (error) {
                throw new ProtocolError(
                  ProtocolErrorCode.InvalidParams,
                  `Invalid workflow agent configuration response: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            } else {
              const state: WorkflowMcpRequestState = {
                version: 1,
                flow: "agent-configuration",
                inputHash,
                scriptHash: workflowScriptHash(admittedScript),
                approvedKeys: [...approvedBackendKeys].sort(),
                selectionHash: plan.selectionHash,
              };
              return inputRequired({
                inputRequests: {
                  agentConfiguration: inputRequired.elicit(plan.request as ElicitRequestFormParams),
                },
                requestState: await requestStateCodec.mint(state, ctx),
              });
            }
          }
        } else if (requestState?.flow === "agent-configuration") {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            "Invalid workflow agent-configuration retry: the workflow no longer has an unresolved agent model",
          );
        }

        let defaultModel: string | undefined;
        let defaultBackendWarning: string | undefined;
        const reachedModelLessCall = workflowNeedsPinnedDefault(routingDiscovery);
        const mayReachModelLessCall = workflowMayUseDefaultModel(admittedScript);
        if (agentConfigurations === undefined && (reachedModelLessCall || mayReachModelLessCall)) {
          const explicitDefault = process.env[DEFAULT_BACKEND_ENV] !== undefined;
          if (explicitDefault) {
            // Preserve the explicit operator contract, including its historical unknown/empty ->
            // Claude resolution. Pin the runner's resolved backend into engine identity for this run.
            defaultModel = probeRunner.defaultBackendId?.();
          } else {
            if (probeRunner.defaultBackendId && probeRunner.listBackends) {
              try {
                const selected = await discoverProjectDefaultBackend(context, probeRunner);
                defaultModel = selected.backendId;
                defaultBackendWarning = reachedModelLessCall
                  ? `Model-less agent calls use auto-selected backend ${JSON.stringify(selected.backendId)} for this run ` +
                    `(${selected.reason}); the run will not switch providers automatically.`
                  : `Conservative routing analysis could not prove every agent call has an authored model or tier ` +
                    `(for example, options assembled through a spread or a call hidden behind an unvisited branch). ` +
                    `Backend ${JSON.stringify(selected.backendId)} is pinned only as the fallback for otherwise model-less ` +
                    `calls (${selected.reason}); every explicit per-call model or tier still wins.`;
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
          agentConfigurations,
          requireAgentConfiguration: agentConfigurations !== undefined,
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
        if (agentConfigurations === undefined) {
          const canonical: Record<number, WorkflowAgentConfiguration> = {};
          for (const call of preflight.dryRun?.agentCalls ?? []) {
            const model = call.model ?? defaultModel;
            if (!model) {
              return {
                content: [{
                  type: "text",
                  text:
                    `Cannot durably admit agent occurrence ${call.index} (${call.label}): ` +
                    "its effective provider/model is unresolved. Configure a provider or set an explicit default.",
                }],
                isError: true,
              };
            }
            canonical[call.index] = {
              model,
              ...(call.mode === undefined ? {} : { mode: call.mode }),
              ...(call.configOptions === undefined ? {} : { configOptions: call.configOptions }),
            };
          }
          agentConfigurations = canonical;
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
          agentConfigurations,
          requireAgentConfiguration: true,
          agentConfigurationSource: agentConfigurationElicited ? "mcp-elicitation" : "mcp-routing",
          scriptBackends: backendsGate.backends,
          maxAgents: input.maxAgents,
          concurrency: input.concurrency,
          agentRetries: input.agentRetries,
        };
        if (!input.background) {
          const reporter = createProgressReporter(ctx);
          let lastActivitySeq = 0;
          foregroundAbort = detachableExecutionSignal(ctx.mcpReq.signal);
          exec.signal = foregroundAbort.signal;
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
          // Both MCP protocol eras durably pause and return the same inputRequired lifecycle.
          const canElicit = Boolean(toolCatalog.clientCapabilities(ctx)?.elicitation);
          if (canElicit) exec.pauseOnCheckpoint = true;
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
          return {
            structuredContent: {
              runId: started.runId,
              status: "running" as const,
              scriptSource,
              scriptUri,
              eventsUri,
              limits: admittedRun.limits,
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
                  `Call workflow with action="status" and this runId for an immediate snapshot. Status shows when an ACP ` +
                  `permission needs a response but remains observation-only; use action="permissions-response" ` +
                  `with an exact advertised option. If a live run-monitor panel ` +
                  `is shown for this run, it self-updates and reports phase starts, pauses, and terminal outcomes — ` +
                  `call status only when the model needs an on-demand machine-readable snapshot.`,
              },
              ...scriptContentBlocks(scriptResources, started.runId),
              ...eventsContentBlocks(scriptResources, started.runId),
            ],
            isError: false,
          };
        }

        // startInBackground reveals the manager-owned run ID immediately after the initial save.
        // Read that record back before awaiting the promise so no foreground result is acknowledged
        // unless its immutable script resource is already durable.
        const started = manager.startInBackground(admittedScript, input.args, exec);
        requireAdmissionResource(
          manager,
          scriptResources,
          started.runId,
          admittedScript,
          () => executionLatch.deny(),
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
          const permission = pendingPermissions[0];
          if (canElicitPermission && permission) {
            const state: WorkflowMcpRequestState = {
              version: 1,
              flow: "permission",
              inputHash,
              scriptHash: workflowScriptHash(admittedScript),
              runId: started.runId,
              permissionId: permission.permissionId,
            };
            return inputRequired({
              inputRequests: {
                permission: inputRequired.elicit(createPermissionElicitation(
                  permission,
                  permissionPhase(manager, permission),
                )),
              },
              requestState: await requestStateCodec.mint(state, ctx),
            });
          }
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
            },
            content: [
              {
                type: "text",
                text:
                  `Workflow "${admittedRun.snapshot.name}" is still running but requires a permission response.\n` +
                  `runId: ${started.runId}\n` +
                  formatPendingPermissions(pendingPermissions).trimStart() +
                  `\nUse action="permissions-response" with one exact advertised option. Status remains ` +
                  `an observation-only snapshot and never opens a permission form.`,
              },
              ...scriptContentBlocks(scriptResources, started.runId),
              ...eventsContentBlocks(scriptResources, started.runId),
            ],
            isError: false,
          };
        }
        const run = settled.run;
        if (
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
            ...scriptContentBlocks(scriptResources, run.runId),
            ...eventsContentBlocks(scriptResources, run.runId),
          ],
          isError,
        };
      } finally {
        foregroundAbort?.detach();
        executionLatch.deny();
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
    listRecentRuns: ({ anchorRunId, limit }) => {
      const context = projects.storeFor(anchorRunId) ?? defaultContext;
      const anchor = context?.manager.getPersistence().load(anchorRunId);
      if (!context || !anchor) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No workflow run found for ${anchorRunId}`);
      }
      const recent = context.manager.listRecentRuns(limit);
      // The panel belongs to the tool call that named anchorRunId. Keep that run navigable even
      // after newer concurrent runs push it outside the bounded recent window.
      const listed = recent.some((run) => run.runId === anchorRunId)
        ? recent
        : [anchor, ...recent].slice(0, limit);
      // Script-authored text crosses to the app the same way the events resource projects it:
      // credential-redacted and bounded.
      const safeText = (value: string) => truncateUtf8(redactText(value).value, 512);
      return listed.map((run) => ({
        runId: run.runId,
        workflowName: safeText(run.workflowName),
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        ...(run.currentPhase === undefined ? {} : { currentPhase: safeText(run.currentPhase) }),
      }));
    },
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
