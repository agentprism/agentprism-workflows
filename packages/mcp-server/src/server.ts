import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type {
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
// MCP run/resume acknowledge durable asynchronous operations. Setup, permissions, and
// checkpoints are run-scoped state; transport disconnect never cancels admitted work.
import { createRequire } from "node:module";

import {
  buildModelFilter,
  probeHarnessConfig,
  redactText,
  truncateUtf8,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowManager,
} from "@automatalabs/workflows";
import type {
  PersistedRunState,
  WorkflowAgentCallCancellation,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "@automatalabs/workflows";
import type { AgentRunner, TokenUsage } from "@automatalabs/shared-types";
import {
  boundWorkflowRequest, isPreparationCancelled, WorkflowPreparationRejected, workflowLifecycle, workflowSetup,
  type WorkflowPreparationOutcome,
} from "./workflow-lifecycle.js";
import { createProgressReporter } from "./progress.js";
import { CLAUDE_CHANNEL_CAPABILITY, ClaudeChannelNotifier } from "./channel-notifier.js";
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
import {
  ActiveRunRegistry,
  MAX_ACTIVE_RUNS,
  WorkflowProjectRegistry,
  resolveProjectDir,
  type ProjectContext,
} from "./project-registry.js";
import { registerWorkflowAppUi } from "./app-ui.js";
import { EXTENSION_ID } from "./mcp-apps.js";
import {
  toWorkflowExecutionOutcome,
  workflowToolOutputShape,
} from "./workflow-tool-output.js";
import type {
  WorkflowExecutionOutcome,
  WorkflowResultRetrieval,
  WorkflowRunLatestActivity,
  WorkflowStatusToolResult,
  WorkflowPauseResult,
  WorkflowStopPendingResult,
  WorkflowStopResult,
} from "./workflow-tool-output.js";
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
  missingRoutingDiagnostics,
  WORKFLOW_CONFIG_PROBE_TIMEOUT_MS,
  WORKFLOW_CONFIG_DISCOVERY_TIMEOUT_MS,
  workflowProbeRunner,
} from "./workflow-preflight.js";
import type { WorkflowServerControl } from "./lifecycle.js";
import {
  RESULT_RESOURCE_MIME_TYPE,
  WorkflowScriptResources,
  workflowResultUri,
} from "./workflow-resources.js";
import { requireDurableStoppedRun } from "./workflow-stop.js";
import {
  WorkflowPermissionBroker,
  type WorkflowPendingPermission,
  type WorkflowPermissionResponseAcknowledgement,
} from "./workflow-permissions.js";

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
// surfaced by hosts to orient the calling agent to the two model-facing tools and the two
// version-matched Agent Skills. Kept short and behavioral — exhaustive guidance is loaded through
// the host's skill activation path only when needed.
export const SERVER_INSTRUCTIONS = [
  "This server exposes workflow and repl orchestration tools, plus workflow_monitor for Apps-capable hosts. They " +
    "spawn subagents over the same ACP backends — the registry built-ins Claude, Codex, OpenCode, and " +
    "pi, plus any registered custom agents — and key durable state by an absolute projectDir " +
    "(required on the shared daemon; defaulted by a single-project server). Backend credentials come " +
    "from each agent's own login, so there is nothing auth-shaped to configure here.",
  "Version-matched authoring guidance is available through the server's Agent Skills. Activate " +
    "skill://agentprism-workflow-authoring/SKILL.md for deterministic workflow scripts, or " +
    "skill://agentprism-repl-orchestration/SKILL.md for the persistent REPL. Load a skill through " +
    "the host's skill-loading path, then read only the supporting resources it references as needed.",
  "• workflow — DETERMINISTIC BATCH orchestration. Use action:\"run\" with a JavaScript workflow " +
    "script that fans out agent() subagents and optional checkpoint() gates. Run and resume always return " +
    "a durable runId for bounded status, permissions-response, result, pause, and stop calls; resume continues " +
    "the exact run (paused or stopped) from its durable admission and journal. action:\"config\" discovers the live backend " +
    "and model option catalog. Every agent call must resolve an explicit model route (backend-only routes are valid). Accepted runs prepare durably; custom backends require approval. Checkpoints always require an explicit answer.",
  "• repl — INTERACTIVE STATEFUL orchestration. A persistent per-project JavaScript VM driven with " +
    "action:\"eval\". Named bindings, pending subagent handles, queued turns, checkpoints, and `_` " +
    "persist between calls and survive daemon restarts. Use it when the next orchestration step depends " +
    "on inspecting intermediate results.",
  "Rule of thumb: use workflow when you can script the whole plan ahead of time; use repl when you " +
    "want a live session that evolves call by call.",
  "Claude Code channels: when this server is loaded as a channel, the updates the run monitor would " +
    "show arrive as <channel source=\"<this server's configured name>\" run_id=\"…\" " +
    "kind=\"terminal|paused|checkpoint|permission|setup\" status=\"…\"> events for every workflow run " +
    "this session started, resumed, or inspected with action:\"status\". They are informational and " +
    "need no reply through the channel: act on them with the workflow tool — status to read the exact " +
    "pending setup, permission, or checkpoint, then setup-response, permissions-response, or resume, " +
    "and result after completion.",
].join("\n\n");

export { ActiveRunRegistry, MAX_ACTIVE_RUNS } from "./project-registry.js";

const TERMINAL_STATUSES = new Set(["paused", "completed", "failed", "aborted"]);

function isTerminalStatus(status: WorkflowRunStatus["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isAlreadyTerminalForStop(status: WorkflowRunStatus["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

/** How long a pause request waits for executing agents to finish before answering with `running`. */
export const WORKFLOW_PAUSE_SETTLE_WAIT_MS = 2_000;

async function waitForPauseSettlement(manager: WorkflowManager, runId: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const live = manager.getRun(runId);
    const status = live ? live.status : manager.getPersistence().load(runId)?.status;
    if (status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  configurationDiagnosticReason?: string;
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
  const reason = live?.error?.message ?? persisted?.reason;
  const errorCode = live?.error?.code ?? persisted?.errorCode;
  const configurationDiagnosticReason = errorCode === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && reason !== undefined
    ? truncateUtf8(redactText(reason).value, 6_144, "…[configuration diagnostics truncated]")
    : undefined;
  const sourcePhases = live?.snapshot.phases ?? persisted?.phases ?? [];
  const sourceLogs = live?.snapshot.logs ?? persisted?.logs ?? [];
  const phaseCandidates = sourcePhases.slice(-MAX_INSPECTION_PHASES).map(retainedInspectionText);
  const logCandidates = (
    status.filter.logLines === 0 ? [] : sourceLogs.slice(-status.filter.logLines)
  ).map(retainedInspectionText);
  return {
    configurationDiagnosticReason,
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
    ...(retention.configurationDiagnosticReason === undefined ? {} : { reason: retention.configurationDiagnosticReason }),
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
  // The engine's replay-eligibility diagnostic is SDK surface; MCP inspection stays the bounded
  // documented field set, and a revised continuation reports its per-call decisions on the result.
  delete (projected as { replayEligibility?: unknown }).replayEligibility;
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

function formatPauseSummary(result: WorkflowPauseResult): string {
  const lines = inspectionSummaryLines(result);
  lines.splice(
    2,
    0,
    result.paused
      ? result.pauseRequested
        ? "Pause is durably complete: executing agents finished and journaled, nothing new started. Edit the script file if needed, then resume with the same runId."
        : "No pause was initiated because this run was already paused; resume with the same runId when ready."
      : result.pauseRequested
        ? "Pause requested: agents already executing are finishing and will journal; nothing new starts. Poll status until it reports paused, then resume with the same runId."
        : result.status === "running"
          ? "Pause could not be delivered: the run is running but no live execution owner accepted the request. Retry pause, or stop the run."
          : `This run settled as ${result.status} before it could pause; nothing is executing.`,
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
  scriptUri: string,
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
    scriptUri,
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
  const resultUri = status.status === "completed" && persisted?.status === "completed" && persisted.result !== undefined
    ? workflowResultUri(runId)
    : undefined;
  const live = manager.getRun(runId)?.result;
  const eventsUri = resources.availableEventsUri(runId);
  if (live?.status === status.status) {
    return toWorkflowExecutionOutcome(live, {
      scriptUri: resources.scriptUri(runId),
      ...(resultUri === undefined ? {} : { resultUri }),
      ...(eventsUri === undefined ? {} : { eventsUri }),
    });
  }
  if (persisted?.status === status.status) return persistedOutcome(persisted, status, eventsUri, resources.scriptUri(runId));
  // Another process can settle or continue the run between synchronous reads. Keep
  // the inspected status and its bounded facts; the next poll supplies newer details.
  if (status.status === "pending" || status.status === "running") return undefined;
  return {
    runId, status: status.status, scriptUri: resources.scriptUri(runId),
    ...(eventsUri === undefined ? {} : { eventsUri }),
    ...(status.limits === undefined ? {} : { limits: status.limits }),
    logTail: status.logTail,
  };
}

const INLINE_WORKFLOW_RESULT_MAX_BYTES = 4_096;

type WorkflowResultContentBlock =
  | { type: "text"; text: string; annotations?: { audience: ["assistant"] } }
  | ResourceLink;

function resultResourceFields(
  resources: WorkflowScriptResources,
  runId: string,
  observedStatus: WorkflowRunStatus["status"],
): { resultUri?: string; eventsUri?: string } {
  const resultUri = observedStatus === "completed" ? resources.availableResultUri(runId) : undefined;
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
  observedStatus: WorkflowRunStatus["status"],
): WorkflowResultContentBlock[] {
  if (observedStatus !== "completed") return [];
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
    } else if (result.reason === "requested") {
      lines.push(
        `This run paused by request: executing agents finished and journaled, nothing new started. ` +
          `Edit its script file if needed, then call the workflow tool with action="resume" and runId="${result.runId}".`,
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
  activeRuns?: ActiveRunRegistry;
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
  const permissionBroker = options.permissionBroker ?? new WorkflowPermissionBroker();
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
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
    // Claude Code registers a channel listener on this key; every other host ignores it.
    experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} },
  });

  // Composition root: the ACP-backed AgentRunner is injected into the engine here. Each
  // project's manager owns run lifecycle, status stamping, and the persisted journal used by
  // resume; the registry routes calls to the right project (run: the projectDir argument;
  // resume/status/stop: locating the runId's store).
  const requireProjectDir = options.requireProjectDir === true;
  const projects = options.projects ?? new WorkflowProjectRegistry(runner);
  const defaultContext: ProjectContext | undefined = requireProjectDir
    ? undefined
    : projects.adopt(options.manager ?? new WorkflowManager({ agent: runner }), options.activeRuns);
  const scriptResources = new WorkflowScriptResources(mcp, { router: projects }, options.modernNotifier);
  // Channel delivery is the run monitor's automatic messages sent by this session's server. Claude
  // Code only registers a channel over the legacy handshake, and modern per-request instances have
  // no push stream for it, so only legacy-era instances watch runs.
  const channel = options.protocolEra === "modern" ? undefined : new ClaudeChannelNotifier(mcp, projects, permissionBroker);
  registerAuthoringSkills(mcp, {
    registerResourceReader: (uri, read) => scriptResources.registerExternalResourceReader(uri, read),
  });
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
      input.action === "pause" ||
      input.action === "permissions-response" ||
      input.action === "setup-response"
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
        "Use config before pinning live model, mode, or config-option ids. run validates explicit script or scriptPath content inside the request (cancel the request to abandon it) and returns once execution has started; resume continues the exact runId from durable state. " +
        "Use status for an immediate snapshot, result for exact completed JSON, permissions-response for a pending ACP choice, pause to let executing agents finish and journal before the run pauses, and stop to interrupt a run or one live call; resume continues a paused or stopped run. " +
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
      if (ctx.mcpReq.requestState?.() !== undefined || ctx.mcpReq.inputResponses !== undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Workflow requestState/inputResponses are retired. Use run-scoped setup-response, permissions-response, or resume with checkpointReplies.");
      }
      const parsedInput = parseWorkflowToolInput(args, { requireProjectDir });
      if (parsedInput.action === "config") {
        return boundWorkflowRequest((async () => {
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
          const discovery = new AbortController();
          const discoveryTimer = setTimeout(() => discovery.abort(new Error(
            `config discovery timed out after ${WORKFLOW_CONFIG_DISCOVERY_TIMEOUT_MS}ms`,
          )), WORKFLOW_CONFIG_DISCOVERY_TIMEOUT_MS);
          try {
            let report = await probeHarnessConfig({
              harnesses: parsedInput.harnesses,
              modelSpecs: parsedInput.modelSpecs,
              cwd,
              probeRunner, probeTimeoutMs: WORKFLOW_CONFIG_PROBE_TIMEOUT_MS,
              signal: discovery.signal,
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
                probeRunner, probeTimeoutMs: WORKFLOW_CONFIG_PROBE_TIMEOUT_MS,
                signal: discovery.signal,
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
          } finally {
            clearTimeout(discoveryTimer);
          }
        })());
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
      const activeRuns = context.activeRuns;
      if ("runId" in parsedInput) workflowLifecycle(context, runner).recover(parsedInput.runId);

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
            scriptUri: scriptResources.scriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId, status.status),
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
            ...resultContentBlocks(scriptResources, parsedInput.runId, false, status.status),
            ...scriptContentBlocks(scriptResources, parsedInput.runId),
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
          ],
          isError: false,
        };
      }

      if (parsedInput.action === "pause") {
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
        if (persisted.status === "pending") {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Workflow run "${parsedInput.runId}" is waiting for setup and has not started executing; answer its setup request or stop it instead of pausing.`,
          );
        }
        if (isAlreadyTerminalForStop(persisted.status)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Workflow run "${parsedInput.runId}" is already terminal (${persisted.status}); nothing is executing to pause. Resume it to continue from its journal.`,
          );
        }
        let pauseRequested = false;
        if (persisted.status === "running") {
          if (manager.getRun(parsedInput.runId)) {
            pauseRequested = manager.pause(parsedInput.runId);
          } else if (options.runControl) {
            pauseRequested = await options.runControl.pause(manager, parsedInput.runId);
            // An owner that no longer runs it, or none at all: reconcile an orphaned run to its
            // interrupted pause rather than reporting a request nobody holds.
            if (!pauseRequested) manager.reconcileExternallyDeadRun(parsedInput.runId);
          } else {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Workflow run "${parsedInput.runId}" is persisted as running, but there is nothing live to pause in this server process.`,
            );
          }
          if (pauseRequested) await waitForPauseSettlement(manager, parsedInput.runId, WORKFLOW_PAUSE_SETTLE_WAIT_MS);
        }
        const inspectionOptions = {
          lastN: parsedInput.lastN,
          labelGlob: parsedInput.labelGlob,
          logLines: parsedInput.logLines,
        };
        const status = manager.inspectRun(parsedInput.runId, inspectionOptions);
        if (!status || status.status === "pending") {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Workflow pause did not produce a snapshot for runId "${parsedInput.runId}".`,
          );
        }
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: scriptResources.scriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId, status.status),
            ...latestActivityFields(scriptResources, parsedInput.runId, status),
            pauseRequested,
            paused: status.status === "paused",
          },
          inspectionRetentionMetadata(manager, parsedInput.runId, status),
        );
        const result: WorkflowPauseResult = { ...projected, status: status.status };
        return {
          structuredContent: { ...result },
          content: [
            { type: "text", text: formatPauseSummary(result) },
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
              scriptUri: scriptResources.scriptUri(parsedInput.runId),
              ...resultResourceFields(scriptResources, parsedInput.runId, status.status),
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
                    scriptUri: scriptResources.scriptUri(parsedInput.runId),
                    ...resultResourceFields(scriptResources, parsedInput.runId, pendingStatus.status),
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
        activeRuns.evict(parsedInput.runId);
        const projected = addInspectionResourceFields(
          status,
          {
            scriptUri: scriptResources.scriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId, status.status),
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
            ...resultContentBlocks(scriptResources, parsedInput.runId, false, status.status),
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
        const pendingPermissions = manager.getRun(parsedInput.runId)
          ? permissionBroker.list(parsedInput.runId)
          : await pendingPermissionsForRun(
              manager,
              parsedInput.runId,
              permissionBroker,
              options.runControl,
            );
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
        // Inspecting a run attaches this session to its later updates; the response below carries
        // everything that already happened, so nothing is replayed.
        channel?.watch(parsedInput.runId);

        // Observation never owns an input wait or execution lifetime.
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
            setup: workflowSetup(manager.getPersistence().load(parsedInput.runId)),
            scriptUri: scriptResources.scriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId, status.status),
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
            ...resultContentBlocks(scriptResources, parsedInput.runId, true, status.status),
            ...scriptContentBlocks(scriptResources, parsedInput.runId),
            ...eventsContentBlocks(scriptResources, parsedInput.runId),
          ],
          isError: false,
        };
      }

      const lifecycle = workflowLifecycle(context, runner);
      if (parsedInput.action === "setup-response") {
        if (options.runControl && !manager.getRun(parsedInput.runId)) {
          await options.runControl.respondSetup(manager, parsedInput);
        } else {
          lifecycle.respond(parsedInput);
        }
        const state = manager.getPersistence().load(parsedInput.runId)!;
        return {
          structuredContent: { action: "setup-response", runId: parsedInput.runId, setupId: parsedInput.setupId,
            status: state.status, scriptUri: scriptResources.scriptUri(parsedInput.runId),
            ...resultResourceFields(scriptResources, parsedInput.runId, state.status), setup: workflowSetup(state) },
          content: [{ type: "text", text: `Setup response recorded for workflow run ${parsedInput.runId}.` }],
          isError: false,
        };
      }
      if (parsedInput.action === "resume") {
        lifecycle.recover(parsedInput.runId);
        const input = clampWorkflowInput(parsedInput);
        const persisted = manager.getPersistence().load(input.runId);
        const needsReservation = !context.activeRuns.has(input.runId);
        if (needsReservation && !context.activeRuns.reserve()) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Workflow limit reached (4 active or preparing runs)");
        }
        let reserved = needsReservation;
        try {
          // The run's script file is the editable working copy: a changed file continues as a
          // validated revision, an unchanged or missing one continues the persisted script.
          let revision: { script: string; revised: boolean } = { script: persisted?.script ?? "", revised: false };
          if (persisted) {
            try {
              revision = await lifecycle.prepareRevision(input.runId, persisted, { signal: ctx.mcpReq.signal });
            } catch (error) {
              if (isPreparationCancelled(error)) {
                throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow continuation was cancelled before admission; nothing was continued.");
              }
              if (error instanceof WorkflowPreparationRejected) {
                return { content: [{ type: "text", text: `Workflow run ${input.runId} was not continued: ${error.message}` }], isError: true };
              }
              throw error;
            }
          }
          const started = await manager.continueRun(input.runId, {
            agent: runner, maxAgents: input.maxAgents,
            ...(revision.revised ? { script: revision.script } : {}),
            onMissingAgentConfiguration: () => missingRoutingDiagnostics(probeRunner, context.projectDir, persisted?.admission?.scriptBackends),
            concurrency: input.concurrency, agentRetries: input.agentRetries, checkpointReplies: input.checkpointReplies,
          });
          if (!started.accepted) {
            const status = manager.inspectRun(input.runId, { lastN: 20, logLines: 20 });
            if (!status) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No workflow run found for ${input.runId}`);
            const outcome = isTerminalStatus(status.status) ? terminalOutcome(manager, scriptResources, input.runId, status) : undefined;
            const projected = addInspectionResourceFields(status, {
              scriptUri: scriptResources.scriptUri(input.runId), ...resultResourceFields(scriptResources, input.runId, status.status),
              setup: workflowSetup(manager.getPersistence().load(input.runId)),
              ...(outcome === undefined ? {} : { outcome }),
            }, inspectionRetentionMetadata(manager, input.runId, status));
            const informational = ["running", "terminal", "checkpoint-required", "auth-required"].includes(started.reason);
            const requiresFreshRun = ["admission-missing", "admission-invalid", "admission-uncovered", "backends-changed"].includes(started.reason);
            return { structuredContent: { ...projected },
              content: [{ type: "text", text: `Workflow run ${input.runId} was not continued: ${started.reason}.` +
                (requiresFreshRun ? " Please start a fresh run." : "") +
                (started.reason === "script-invalid" ? " Fix the run's script file, then resume again." : "") +
                (started.resolvedCheckpoints?.length ? `\n${JSON.stringify(started.resolvedCheckpoints)}` : "") }], isError: !informational };
          }
          context.activeRuns.track(input.runId, started.promise);
          reserved = false;
          channel?.watch(input.runId);
          const state = manager.getPersistence().load(input.runId)!;
          return { structuredContent: { action: "resume", accepted: true, runId: input.runId,
              continuation: started.continuation,
              status: state.status, scriptSource: "stored", scriptUri: scriptResources.scriptUri(input.runId),
              scriptPath: scriptResources.scriptPath(input.runId),
              eventsUri: scriptResources.availableEventsUri(input.runId), limits: state.limits },
            content: [{ type: "text", text: `Continuation accepted for workflow run ${input.runId}${
              revision.revised ? " with the revised script: unchanged calls replay from the journal, changed calls run live" : ""
            }. Use status to inspect it; use result after completion.` },
              ...scriptContentBlocks(scriptResources, input.runId), ...eventsContentBlocks(scriptResources, input.runId)], isError: false };
        } finally { if (reserved) context.activeRuns.releaseReservation(); }
      }
      // Preparation (source read, static parse, mock dry run, live probes) runs inside this
      // request. Nothing is persisted until it succeeds: a validation failure is a tool execution
      // error and a cancelled request leaves no run behind. Only a declared backend awaiting
      // approval parks the validated run in durable setup before execution starts.
      let outcome: WorkflowPreparationOutcome;
      try {
        outcome = await lifecycle.prepare(parsedInput, {
          signal: ctx.mcpReq.signal,
          progress: createProgressReporter(ctx),
          // Register interest before execution or a setup announcement can race ahead of it.
          onAdmitted: (runId) => {
            scriptResources.notifyRunAdmitted(runId);
            channel?.watch(runId);
          },
        });
      } catch (error) {
        if (isPreparationCancelled(error)) {
          throw new ProtocolError(ProtocolErrorCode.InternalError, "Workflow run was cancelled before admission; nothing was started.");
        }
        if (error instanceof WorkflowPreparationRejected) {
          return { content: [{ type: "text", text: `Workflow run was not started: ${error.message}` }], isError: true };
        }
        throw error;
      }
      const state = manager.getPersistence().load(outcome.runId)!;
      const summary = outcome.setup
        ? `Workflow run ${outcome.runId} validated and is waiting for setup: answer status.setup.request with setup-response to start it.`
        : `Workflow run ${outcome.runId} started. Use workflow_monitor with this runId to open its panel, or status for checkpoints, permissions, and completion.`;
      return {
        structuredContent: { action: "run", accepted: true, runId: outcome.runId,
          status: state.status, scriptSource: parsedInput.script === undefined ? "path" : "inline",
          scriptUri: scriptResources.scriptUri(outcome.runId), scriptPath: scriptResources.scriptPath(outcome.runId),
          eventsUri: scriptResources.availableEventsUri(outcome.runId),
          limits: state.limits, setup: workflowSetup(state) },
        content: [{ type: "text", text: summary },
          ...scriptContentBlocks(scriptResources, outcome.runId), ...eventsContentBlocks(scriptResources, outcome.runId)],
        isError: false,
      };
  };

  // The tool itself is registered HERE, at construction — never behind the initialized
  // notification. `notifications/initialized` carries no ordering guarantee against the
  // requests that follow it (a client may pipeline it with its first tools/list or
  // tools/call, and over the stdio shim those arrive as independent HTTP POSTs), so gating
  // the tool on that notification let a client's very first request reach a server with
  // nothing registered: an empty tools/list, or a tool-not-found result on the first call.
  mcp.registerTool("workflow", workflowToolConfig, (args, ctx) => {
    // run and resume prepare inside the request under the preparation ceiling and the request's
    // own cancellation signal; every observation action keeps the short transport bound.
    const action = (args as { action?: unknown } | undefined)?.action;
    const work = Promise.resolve(workflowToolHandler(args, ctx));
    return action === "run" || action === "resume" ? work : boundWorkflowRequest(work);
  });

  // Register the Apps union once. tools/list, direct app-only calls, and the fixed UI resource
  // are projected from the current request's capabilities; no modern request inherits another
  // request's decision, including on long-lived stdio connections.
  registerWorkflowAppUi(mcp, {
    openMonitor: (runId) => {
      const context = projects.storeFor(runId);
      if (context) workflowLifecycle(context, runner).recover(runId);
      const state = context?.manager.getPersistence().load(runId);
      if (!state) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No accepted workflow run found for ${runId}`);
      return { runId, status: state.status, scriptUri: scriptResources.scriptUri(runId), eventsUri: scriptResources.availableEventsUri(runId) };
    },
    notification: (request) => {
      if (!projects.storeFor(request.runId)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No workflow run found for ${request.runId}`);
      const scope = options.protocolEra === "modern"
        ? `modern:${request.scopeId ?? request.viewId}`
        : `legacy:${options.replClientId?.() ?? "single-project"}`;
      return projects.notificationClaims.handle(scope, request);
    },
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

  if (channel) {
    const previousOnClose = mcp.server.onclose;
    mcp.server.onclose = () => {
      try {
        previousOnClose?.();
      } finally {
        channel.close();
      }
    };
  }

  return server;
}
