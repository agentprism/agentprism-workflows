#!/usr/bin/env node
// @automatalabs/mcp-server — the shell / composition root: it consumes the
// @automatalabs/workflows SDK (the canonical programmatic core) for both the ACP-backed
// AgentRunner and the WorkflowManager engine. The runner is injected into the engine
// (createWorkflowServer(createAcpRunner())) and the resulting MCP server is connected over
// stdio. stdout is RESERVED for JSON-RPC framing — every diagnostic goes to stderr.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createAcpRunner } from "@automatalabs/workflows";
import { createEvalBreakChannel } from "@automatalabs/repl-engine";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { REPL_DRAIN_BOUND_MS } from "./daemon/constants.js";
import { installMcpServerLifecycle } from "./lifecycle.js";
import { WorkflowProjectRegistry } from "./project-registry.js";
import { ReplPresenceLedger } from "./repl-presence.js";
import { ReplRelayStdioTransport } from "./repl-stdio-transport.js";
import { createWorkflowServer, type WorkflowServer } from "./server.js";
import { workflowRunEventsUri } from "./workflow-resources.js";
import { WorkflowPermissionBroker } from "./workflow-permissions.js";

export { BackgroundRunRegistry, createWorkflowServer, MAX_BACKGROUND_RUNS } from "./server.js";
export { WorkflowPermissionBroker } from "./workflow-permissions.js";
export type {
  WorkflowPendingPermission,
  WorkflowPermissionDecisionResponse,
  WorkflowPermissionRequestProjection,
  WorkflowPermissionResponseAcknowledgement,
} from "./workflow-permissions.js";
export type {
  CreateWorkflowServerOptions,
  WorkflowConfirmCallback,
  WorkflowCheckpointOptions,
  WorkflowServer,
} from "./server.js";
export {
  clampWorkflowInput,
  parseWorkflowToolInput,
  workflowToolInputSchema,
  workflowToolInputShape,
  WORKFLOW_RESULT_CHUNK_BYTES_DEFAULT,
  WORKFLOW_RESULT_CHUNK_BYTES_MAX,
  WORKFLOW_RESULT_CHUNK_BYTES_MIN,
} from "./workflow-tool-input.js";
export type {
  WorkflowAwaitToolInput,
  WorkflowConfigToolInput,
  WorkflowExecuteToolInput,
  WorkflowInspectToolInput,
  WorkflowPermissionResponseToolInput,
  WorkflowResultToolInput,
  WorkflowStatusToolInput,
  WorkflowStopToolInput,
  WorkflowToolInput,
} from "./workflow-tool-input.js";
export {
  toWorkflowExecutionOutcome,
  toWorkflowToolResult,
  workflowToolOutputShape,
} from "./workflow-tool-output.js";
export type {
  WorkflowAwaitMetadata,
  WorkflowBackgroundAccepted,
  WorkflowConfigToolResult,
  WorkflowExecutionOutcome,
  WorkflowExecutionScriptResourceFields,
  WorkflowExecutionToolResult,
  WorkflowInspectionToolResult,
  WorkflowPermissionInteraction,
  WorkflowPermissionResponseResult,
  WorkflowResultRetrieval,
  WorkflowRunAwaitResult,
  WorkflowRunLatestActivity,
  WorkflowScriptLineageEntry,
  WorkflowScriptResourceFields,
  WorkflowScriptSource,
  WorkflowStatusToolResult,
  WorkflowStatusWaitMetadata,
  WorkflowStopPendingResult,
  WorkflowStopResult,
  WorkflowToolResult,
  WorkflowValidationRejected,
} from "./workflow-tool-output.js";
export { createProgressReporter } from "./progress.js";
export type { WorkflowProgressCallback, WorkflowToolExtra } from "./progress.js";
export { registerAuthoringPrompt, buildAuthoringPromptText, AUTHORING_PROMPT_NAME } from "./authoring-prompt.js";
export {
  AUTHORING_DOC_MIME_TYPE,
  DOCS_TOOL_NAME,
  authoringDocResource,
  authoringDocTopic,
  docsToolInputShape,
  docsToolOutputShape,
  registerAuthoringDocs,
} from "./docs-tool.js";
export type { DocsToolResult, RegisterAuthoringDocsOptions } from "./docs-tool.js";
export {
  AUTHORING_DOCS_SCHEMA_VERSION,
  AUTHORING_DOC_TOPICS,
  AUTHORING_DOC_TOPIC_IDS,
} from "./generated/authoring-docs-content.js";
export type { AuthoringDocTopicId, GeneratedAuthoringDocTopic } from "./generated/authoring-docs-content.js";
export { replToolInputShape, replToolOutputShape } from "./repl-tool.js";
export type { ReplToolOptions } from "./repl-tool.js";
export {
  createReplProjectState,
  ensureReplWorkspace,
  disposeReplProjectState,
  resetReplProjectState,
  renameAsideNeverOverwriting,
} from "./repl-project.js";
export type { ReplProjectState } from "./repl-project.js";
export { ReplPresenceLedger } from "./repl-presence.js";
export {
  RUN_MONITOR_RESOURCE_URI,
  WORKFLOW_EVENTS_TOOL_NAME,
  registerWorkflowAppUi,
} from "./app-ui.js";
export type { WorkflowAppUiDeps } from "./app-ui.js";
export {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  appResourceToolMeta,
  getUiCapability,
  supportsMcpApps,
} from "./mcp-apps.js";
export type { UiCapability } from "./mcp-apps.js";
export { disposeRunnerWithDeadline, installMcpServerLifecycle, SHUTDOWN_DEADLINE_MS } from "./lifecycle.js";
export type { McpServerLifecycle, McpServerLifecycleOptions, McpServerShutdownReason, WorkflowServerControl } from "./lifecycle.js";
export {
  EVENTS_RESOURCE_MIME_TYPE,
  RESULT_RESOURCE_MIME_TYPE,
  SCRIPT_RESOURCE_LIST_LIMIT,
  SCRIPT_RESOURCE_MIME_TYPE,
  WORKFLOW_RUN_EVENTS_SCHEMA_VERSION,
  parseWorkflowRunEventsUri,
  workflowRunEventsUri,
  workflowRunIdFromResultUri,
  workflowRunIdFromScriptUri,
  workflowResultUri,
  workflowScriptUri,
} from "./workflow-resources.js";
export type {
  ParsedWorkflowRunEventsUri,
  SerializedWorkflowResult,
  WorkflowRunEventsResourceDocument,
} from "./workflow-resources.js";

/**
 * Bootstrap the MCP `workflow` server over stdio. Composition root: build the ACP-backed
 * AgentRunner, inject it into the workflow-engine via the server shell, and serve on
 * stdin/stdout. Backend auth stays with the agents' own CLI credential stores; a run that
 * hits AUTH_REQUIRED pauses and resumes (resumeFromRunId) after an out-of-band CLI login.
 * The stdio transport is the RELAY transport (phase-F review round 3): its stdin reader
 * lives on a worker thread that fires the server's out-of-band eval-break relay for
 * `repl` interrupt calls, so the documented no-id interrupt works for a synchronously
 * running eval in this mode too (the daemon mode's shim does the same from a separate
 * process).
 */
export async function main(): Promise<void> {
  const permissionBroker = new WorkflowPermissionBroker();
  const runner = createAcpRunner({
    onPermissionRequest: permissionBroker.resolver,
    enforceToolPolicyBeforePermissionResolver: true,
  });
  permissionBroker.attach(runner);
  const projects = new WorkflowProjectRegistry(runner);
  const defaultContext = projects.getOrCreate(process.cwd());
  const replPresence = new ReplPresenceLedger(REPL_DRAIN_BOUND_MS);
  const evalBreakChannel = createEvalBreakChannel();
  let activeServer: WorkflowServer | undefined;
  let activeEra: "legacy" | "modern" | undefined;

  // The relay transport still owns the worker-thread eval-break fast path. serveStdio owns
  // protocol-era arbitration and pins one factory instance to this long-lived connection.
  const transport = new ReplRelayStdioTransport(
    () => evalBreakChannel.breakUrl(),
    () => defaultContext.projectDir,
  );
  const detachModernEvents = projects.onRunEventPersisted((record) => {
    if (activeEra !== "modern") return;
    void activeServer?.server.sendResourceUpdated({ uri: workflowRunEventsUri(record.runId) }).catch(() => undefined);
  });

  await serveStdio(
    ({ era }) => {
      const server = createWorkflowServer(runner, {
        manager: defaultContext.manager,
        backgroundRuns: defaultContext.backgroundRuns,
        projects,
        replPresence,
        replClientId: () => "stdio-client",
        replDrainBoundMs: REPL_DRAIN_BOUND_MS,
        replEvalBreakChannel: evalBreakChannel,
        protocolEra: era,
        disconnectReplClientOnClose: true,
        permissionBroker,
      });
      activeServer = server;
      activeEra = era;
      return server;
    },
    { transport },
  );

  // Install after serveStdio takes transport callback ownership. The lifecycle facade closes
  // shared factory state that is not owned by any one probe/pinned server instance.
  installMcpServerLifecycle({
    runner,
    transport,
    server: {
      stopAcceptingWork: () => activeServer?.stopAcceptingWork(),
      replBreakUrl: () => evalBreakChannel.breakUrl(),
      replDefaultProjectDir: () => defaultContext.projectDir,
      async disposeReplEvalBreakChannel() {
        detachModernEvents();
        permissionBroker.dispose();
        await projects.disposeReplStates();
        replPresence.disconnectAll();
        await evalBreakChannel.dispose();
      },
    },
  });
}

// Back-compat: `node dist/index.js` was the documented registration path before the dedicated
// ./cli.js bin entry existed, so keep this module runnable while staying import-safe as a
// library. npm/pnpm bin shims are symlinks and Node realpath-resolves the ESM entry module, so
// argv[1] must be realpath'd before comparing — matching the raw shim path would silently skip
// main() and the MCP client would see the connection close before the initialize response.
// Inside the esbuild bundle every module shares one import.meta.url, so when entry.ts's argv
// dispatcher owns startup it raises this global (see entry-mode.ts) to keep main() dormant.
function isProcessEntryPoint(): boolean {
  if ((globalThis as Record<string, unknown>).__agentprismEntryDispatch === true) return false;
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  main().catch((error: unknown) => {
    console.error("[agentprism-workflow] fatal error during startup:", error);
    process.exitCode = 1;
  });
}
