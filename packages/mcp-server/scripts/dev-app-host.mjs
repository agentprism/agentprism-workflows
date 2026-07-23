#!/usr/bin/env node
// Local MCP Apps dev harness for the run-monitor panel. Serves the workflow server over
// Streamable HTTP (one MCP server per session, ONE shared WorkflowManager so background
// runs are visible across sessions) and auto-starts a stubbed demo background run whose
// runId is printed at boot. Point the ext-apps basic-host at it:
//
//   pnpm --filter @automatalabs/mcp-server build && node scripts/dev-app-host.mjs
//   # then in a clone of github.com/modelcontextprotocol/ext-apps:
//   cd examples/basic-host && npm install
//   SERVERS='["http://localhost:3001/mcp"]' npm run start   # open http://localhost:8080
//   # call workflow-monitor with the printed runId to render the panel
//
// The stub runner needs no agent backends or credentials; set AGENTPRISM_DEV_LIVE=1 to use
// the real ACP runner instead (requires logged-in backends).
import { randomUUID } from "node:crypto";
import http from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WorkflowManager, createAcpRunner } from "@automatalabs/workflows";

import { createWorkflowServer } from "../dist/index.js";

const PORT = Number(process.env.PORT ?? 3001);

function stubRunner() {
  let calls = 0;
  return {
    async run(prompt, options = {}) {
      calls += 1;
      // The long-form report agent stays busy for minutes so Stop and live updates are testable.
      const delayMs = String(prompt).includes("long-form report") ? 300_000 : 3000 + (calls % 5) * 2000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      void options;
      return `Stubbed result for: ${String(prompt).slice(0, 80)}`;
    },
  };
}

const DEMO_SCRIPT = `
export const meta = {
  name: "research-sweep",
  description: "Demo run for the run-monitor panel",
  phases: [{ title: "research" }, { title: "judge" }],
};
phase("research");
log("Scoping the research target.");
const recon = await agent("Map the target area and list angles to cover.", { label: "recon" });
log("Fanning out three scouts in parallel.");
const scouts = await parallel([
  () => agent("Scout the public web for prior art.", { label: "scout-web" }),
  () => agent("Scout the codebase for existing implementations.", { label: "scout-code" }),
  () => agent("Scout the docs and specs for constraints.", { label: "scout-docs" }),
]);
phase("judge");
log("Judging the scouts' findings.");
const verdict = await agent("Weigh the three scout reports and pick a direction.", { label: "judge" });
const slow = await agent("Write the long-form report (slow; good target for Stop).", { label: "report" });
return { recon, scouts: scouts.length, verdict, slow };
`;

const live = process.env.AGENTPRISM_DEV_LIVE === "1";
// AGENTPRISM_DEV_CWD points the manager at an EXISTING project store (e.g. the repo root) so
// the panel can render real historical runs — full graphs and agent transcripts — with no
// live agents and no token cost. In this mode no demo run is started (don't pollute a real
// store); the newest persisted runs are listed at boot to inspect by runId.
const devCwd = process.env.AGENTPRISM_DEV_CWD;
const runner = live ? createAcpRunner() : stubRunner();
const manager = new WorkflowManager({ agent: runner, ...(devCwd ? { cwd: devCwd } : {}) });

if (devCwd) {
  const runs = manager
    .getPersistence()
    .list()
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 10);
  console.log(`serving existing project store for cwd=${devCwd} (${runs.length} newest runs):`);
  for (const run of runs) {
    console.log(`  ${run.runId}  ${String(run.status).padEnd(9)} ${run.startedAt}  ${run.workflowName}`);
  }
} else {
  const started = manager.startInBackground(DEMO_SCRIPT, undefined, { agent: runner });
  console.log(`demo background run started: runId=${started.runId} (runner: ${live ? "live acp" : "stub"})`);
  started.promise.then(
    (result) => console.log(`demo run ${started.runId} finished: ${result.status}`),
    (error) => console.log(`demo run ${started.runId} errored:`, error),
  );
}

/** @type {Map<string, StreamableHTTPServerTransport>} */
const transports = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

const httpServer = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, created),
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      transport = created;
      const server = createWorkflowServer(runner, { manager });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("mcp request failed:", error);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, () => {
  console.log(`workflow MCP server (dev) listening on http://localhost:${PORT}/mcp`);
});
