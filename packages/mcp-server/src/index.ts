#!/usr/bin/env node
// @automatalabs/mcp-server — the shell / composition root: it consumes the
// @automatalabs/workflows SDK (the canonical programmatic core) for both the ACP-backed
// AgentRunner and the WorkflowManager engine. The runner is injected into the engine
// (createWorkflowServer(createAcpRunner())) and the resulting MCP server is connected over
// stdio. stdout is RESERVED for JSON-RPC framing — every diagnostic goes to stderr.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createAcpRunner } from "@automatalabs/workflows";

import { installMcpServerLifecycle } from "./lifecycle.js";
import { ReplRelayStdioTransport } from "./repl-stdio-transport.js";
import { createWorkflowServer } from "./server.js";

export { BackgroundRunRegistry, createWorkflowServer, MAX_BACKGROUND_RUNS } from "./server.js";
export type {
  CreateWorkflowServerOptions,
  WorkflowConfirmCallback,
  WorkflowCheckpointOptions,
  WorkflowServer,
} from "./server.js";
export { clampWorkflowInput, parseWorkflowToolInput, workflowToolInputShape } from "./workflow-tool-input.js";
export type {
  WorkflowAwaitToolInput,
  WorkflowExecuteToolInput,
  WorkflowInspectToolInput,
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
  WorkflowExecutionOutcome,
  WorkflowExecutionScriptResourceFields,
  WorkflowExecutionToolResult,
  WorkflowInspectionToolResult,
  WorkflowRunAwaitResult,
  WorkflowScriptLineageEntry,
  WorkflowScriptResourceFields,
  WorkflowScriptSource,
  WorkflowStopResult,
  WorkflowToolResult,
} from "./workflow-tool-output.js";
export { createProgressReporter } from "./progress.js";
export type { WorkflowProgressCallback, WorkflowToolExtra } from "./progress.js";
export { registerAuthoringPrompt, buildAuthoringPromptText, AUTHORING_PROMPT_NAME } from "./authoring-prompt.js";
export { replToolInputShape, replToolOutputShape } from "./repl-tool.js";
export type { ReplToolOptions } from "./repl-tool.js";
export {
  createReplProjectState,
  ensureReplWorkspace,
  disposeReplProjectState,
  resetReplProjectState,
} from "./repl-project.js";
export type { ReplProjectState } from "./repl-project.js";
export { ReplPresenceLedger } from "./repl-presence.js";
export {
  RUN_MONITOR_RESOURCE_URI,
  WORKFLOW_EVENTS_TOOL_NAME,
  registerWorkflowAppUi,
} from "./app-ui.js";
export type { WorkflowAppUiDeps } from "./app-ui.js";
export { disposeRunnerWithDeadline, installMcpServerLifecycle, SHUTDOWN_DEADLINE_MS } from "./lifecycle.js";
export type { McpServerLifecycle, McpServerLifecycleOptions, McpServerShutdownReason, WorkflowServerControl } from "./lifecycle.js";
export {
  EVENTS_RESOURCE_MIME_TYPE,
  SCRIPT_RESOURCE_LIST_LIMIT,
  SCRIPT_RESOURCE_MIME_TYPE,
  WORKFLOW_RUN_EVENTS_SCHEMA_VERSION,
  parseWorkflowRunEventsUri,
  workflowRunEventsUri,
  workflowRunIdFromScriptUri,
  workflowScriptUri,
} from "./workflow-resources.js";
export type {
  ParsedWorkflowRunEventsUri,
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
  const runner = createAcpRunner();
  const server = createWorkflowServer(runner);
  // The default-project-key source: the in-process server's own
  // project — the relay fires the out-of-band break under it when a
  // `repl` interrupt omits projectDir (the tool documents projectDir
  // as optional in single-project mode; phase-F review round 4).
  const transport = new ReplRelayStdioTransport(
    () => server.replBreakUrl(),
    () => server.replDefaultProjectDir?.(),
  );
  await server.connect(transport);
  // Install after connect because the SDK takes transport callback ownership during connect.
  installMcpServerLifecycle({ runner, server, transport });
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
