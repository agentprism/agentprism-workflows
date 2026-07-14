#!/usr/bin/env node
// @automatalabs/mcp-server — the shell / composition root: it consumes the
// @automatalabs/workflows SDK (the canonical programmatic core) for both the ACP-backed
// AgentRunner and the WorkflowManager engine. The runner is injected into the engine
// (createWorkflowServer(createAcpRunner())) and the resulting MCP server is connected over
// stdio. stdout is RESERVED for JSON-RPC framing — every diagnostic goes to stderr.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAcpRunner } from "@automatalabs/workflows";

import { createWorkflowServer } from "./server.js";

export { createWorkflowServer } from "./server.js";
export type { WorkflowConfirmCallback, WorkflowCheckpointOptions } from "./server.js";
export { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
export type { WorkflowToolInput } from "./workflow-tool-input.js";
export { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
export type { WorkflowToolResult } from "./workflow-tool-output.js";
export { createProgressReporter } from "./progress.js";
export type { WorkflowProgressCallback, WorkflowToolExtra } from "./progress.js";
export { registerAuthoringPrompt, buildAuthoringPromptText, AUTHORING_PROMPT_NAME } from "./authoring-prompt.js";

/**
 * Bootstrap the MCP `workflow` server over stdio. Composition root: build the ACP-backed
 * AgentRunner, inject it into the workflow-engine via the server shell, and serve on
 * stdin/stdout. Backend auth stays with the agents' own CLI credential stores; a run that
 * hits AUTH_REQUIRED pauses and resumes (resumeFromRunId) after an out-of-band CLI login.
 */
export async function main(): Promise<void> {
  const runner = createAcpRunner();
  const server = createWorkflowServer(runner);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Back-compat: `node dist/index.js` was the documented registration path before the dedicated
// ./cli.js bin entry existed, so keep this module runnable while staying import-safe as a
// library. npm/pnpm bin shims are symlinks and Node realpath-resolves the ESM entry module, so
// argv[1] must be realpath'd before comparing — matching the raw shim path would silently skip
// main() and the MCP client would see the connection close before the initialize response.
function isProcessEntryPoint(): boolean {
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
