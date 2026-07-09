#!/usr/bin/env node
// @automatalabs/mcp-server — the shell / composition root: it consumes the
// @automatalabs/workflows SDK (the canonical programmatic core) for both the ACP-backed
// AgentRunner and the WorkflowManager engine. The runner is injected into the engine
// (createWorkflowServer(createAcpRunner())) and the resulting MCP server is connected over
// stdio. stdout is RESERVED for JSON-RPC framing — every diagnostic goes to stderr.
import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAcpRunner } from "@automatalabs/workflows";

import { createWorkflowServer } from "./server.js";
import { createDeferredMcpAuthResolver } from "./auth-resolver.js";

export { createWorkflowServer } from "./server.js";
export type { WorkflowConfirmCallback, WorkflowCheckpointOptions } from "./server.js";
export { clampWorkflowInput, workflowToolInputShape } from "./workflow-tool-input.js";
export type { WorkflowToolInput } from "./workflow-tool-input.js";
export { toWorkflowToolResult, workflowToolOutputShape } from "./workflow-tool-output.js";
export type { WorkflowToolResult } from "./workflow-tool-output.js";
export {
  authStatusInputShape,
  authStatusOutputShape,
  authenticateInputShape,
  authenticateOutputShape,
  projectAuthMethod,
  projectAuthStatusBackend,
  mapAuthenticateResolution,
  formatAuthStatusSummary,
  formatAuthenticateSummary,
} from "./auth-tool-io.js";
export type {
  AuthStatusToolMethod,
  AuthStatusToolBackend,
  AuthStatusToolResult,
  AuthenticateToolResult,
  AuthenticateMapping,
} from "./auth-tool-io.js";
export { createDeferredMcpAuthResolver } from "./auth-resolver.js";
export { createProgressReporter } from "./progress.js";
export type { WorkflowProgressCallback, WorkflowToolExtra } from "./progress.js";

/** Headless opt-in for the inline MCP auth resolver (§4.3). DEFAULT OFF: the clean, spec-faithful
 *  headless behavior is pure pause-and-resume; setting this to 1/true wires the elicitation bridge. */
const INLINE_AUTH_ENV = "AGENTPRISM_MCP_INLINE_AUTH";

function inlineAuthEnabledByEnv(): boolean {
  const value = process.env[INLINE_AUTH_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Bootstrap the MCP `workflow` server over stdio. Composition root: build the ACP-backed
 * AgentRunner, inject it into the workflow-engine via the server shell, and serve on stdin/stdout.
 *
 * When AGENTPRISM_MCP_INLINE_AUTH is set, build a DEFERRED inline auth resolver, construct the runner
 * with it (`onAuth` — which derives `authCapabilities` to `{ terminal:false, gateway:true }`), then
 * bind the resolver to the constructed server, breaking the runner⇄server construction cycle. Unset
 * (the default) the runner takes no `onAuth`, so a -32000 pauses the run for the pause-and-resume path.
 */
export async function main(): Promise<void> {
  let server;
  if (inlineAuthEnabledByEnv()) {
    const bridge = createDeferredMcpAuthResolver();
    const runner = createAcpRunner({ authCapabilities: { gateway: true }, onAuth: bridge.resolver });
    server = createWorkflowServer(runner);
    bridge.bind(server.server);
  } else {
    const runner = createAcpRunner();
    server = createWorkflowServer(runner);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run as the `agentprism-workflow` executable, but stay import-safe as a library: only start
// the stdio server when this module is the process entry point.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error("[agentprism-workflow] fatal error during startup:", error);
    process.exitCode = 1;
  });
}
