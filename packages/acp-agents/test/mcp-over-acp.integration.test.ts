// End-to-end MCP-over-ACP routing against the MOCK ACP agent. The fake agent makes real
// mcp/connect, mcp/message, and mcp/disconnect JSON-RPC calls to the client; this test asserts
// per-session context, opaque payload forwarding, config gates, and release-time cleanup.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { AcpAgentRunner, clientCapabilitiesFor, type AcpSessionContext, type ClientHandlers } from "../src/index.js";
import {
  WorkflowErrorCode,
  isWorkflowError,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  label?: string;
  clientMethod?: string;
  request?: unknown;
  response?: unknown;
  error?: { name?: string; message?: string; code?: number; data?: unknown };
  params?: {
    clientCapabilities?: ClientCapabilities & { mcp?: unknown };
    mcpServers?: McpServerConfig[];
  };
}

const ACP_SERVER: McpServerConfig = { type: "acp", name: "local-mcp", serverId: "fake-acp-mcp" };
const harness = createFakeAgentHarness({ prefix: "acp-mcp-it-" });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

afterEach(async () => {
  await harness.cleanup();
});

function makeRunner(clientHandlers?: ClientHandlers): AcpAgentRunner {
  return harness.makeRunner({ clientHandlers });
}

function initializeCapabilities(log: LogEntry[]): LogEntry["params"] {
  return log.find((entry) => entry.method === "initialize")?.params;
}

/** The fake agent PARSES initialize with the SDK zod schema, which default-fills absent
 *  capability flags to `false` before logging — prune those (and objects emptied by the
 *  pruning) so assertions compare the truthful advertisement, not the peer's schema
 *  defaults. Intentionally-empty objects (e.g. `configOptions.boolean: {}`) survive. */
function pruneSchemaDefaults(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === false) continue;
    const pruned = pruneSchemaDefaults(entry);
    const emptiedByPruning =
      pruned !== null &&
      typeof pruned === "object" &&
      !Array.isArray(pruned) &&
      Object.keys(pruned).length === 0 &&
      entry !== null &&
      typeof entry === "object" &&
      Object.keys(entry as object).length > 0;
    if (emptiedByPruning) continue;
    out[key] = pruned;
  }
  return out;
}

function logEntry(log: LogEntry[], method: string, label?: string): LogEntry | undefined {
  return log.find((entry) => entry.method === method && (label === undefined || entry.label === label));
}

test("MCP-over-ACP round-trip routes with session context and returns opaque payloads", async () => {
  const { cwd, readLog } = configure({
    mcpAcpSupport: true,
    turns: [
      {
        mcpOverAcp: {
          label: "flow",
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hello" } },
        },
        text: "ok",
      },
    ],
  });
  const seen: Array<{ phase: string; params: unknown; ctx: AcpSessionContext }> = [];
  const handlers: ClientHandlers = {
    mcp: {
      connect: (params, ctx) => {
        seen.push({ phase: "connect", params, ctx });
        return { connectionId: `conn:${params.serverId}` };
      },
      message: (params, ctx) => {
        seen.push({ phase: "message", params, ctx });
        return { echo: params };
      },
      disconnect: (params, ctx) => {
        seen.push({ phase: "disconnect", params, ctx });
        return {};
      },
    },
  };

  const out = await makeRunner(handlers).run("hi", {
    model: "codex",
    cwd,
    label: "mcp-run",
    runId: "run-mcp-1",
    mcpServers: [ACP_SERVER],
  });

  assert.equal(out, "ok");
  assert.deepEqual(pruneSchemaDefaults(initializeCapabilities(readLog())?.clientCapabilities), clientCapabilitiesFor(handlers));
  assert.equal(initializeCapabilities(readLog())?.clientCapabilities?.mcp, undefined);
  assert.deepEqual(readLog().find((entry) => entry.method === "newSession")?.params?.mcpServers, [ACP_SERVER]);
  assert.deepEqual(seen.map((entry) => entry.phase), ["connect", "message", "disconnect"]);
  assert.ok(seen.every((entry) => entry.ctx.cwd === cwd));
  assert.ok(seen.every((entry) => entry.ctx.label === "mcp-run"));
  assert.ok(seen.every((entry) => entry.ctx.runId === "run-mcp-1"));
  assert.ok(seen.every((entry) => entry.ctx.sessionId === seen[0]?.ctx.sessionId));
  assert.deepEqual(logEntry(readLog(), "mcpConnect", "flow")?.response, { connectionId: "conn:fake-acp-mcp" });
  assert.deepEqual(logEntry(readLog(), "mcpMessage", "flow")?.response, {
    echo: {
      connectionId: "conn:fake-acp-mcp",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    },
  });
  assert.deepEqual(logEntry(readLog(), "mcpDisconnect", "flow")?.response, {});
});

test("MCP-over-ACP without handlers is not advertised and mcp/connect returns -32601", async () => {
  const { cwd, readLog } = configure({
    mcpAcpSupport: true,
    turns: [{ mcpOverAcp: { label: "unwired" }, text: "ok" }],
  });

  const out = await makeRunner().run("hi", { model: "codex", cwd });

  assert.equal(out, "ok");
  assert.deepEqual(pruneSchemaDefaults(initializeCapabilities(readLog())?.clientCapabilities), clientCapabilitiesFor(undefined));
  assert.equal(initializeCapabilities(readLog())?.clientCapabilities?.mcp, undefined);
  const connect = logEntry(readLog(), "mcpConnect", "unwired");
  assert.equal(connect?.response, undefined);
  assert.equal(connect?.error?.code, -32601);
  assert.match(connect?.error?.message ?? "", /mcp\/connect.+not advertised by this client/);
});

test("MCP-over-ACP gate rejects acp server configs before prompt when either side is unwired", async () => {
  const noAgentSupport = configure({ turns: [{ text: "ok" }] });
  const handlers: ClientHandlers = {
    mcp: {
      connect: () => ({ connectionId: "conn" }),
      message: () => ({}),
      disconnect: () => undefined,
    },
  };
  await assert.rejects(
    () => makeRunner(handlers).run("hi", { model: "codex", cwd: noAgentSupport.cwd, mcpServers: [ACP_SERVER] }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /local-mcp/);
      assert.match(err.message, /acp.+transport.+does not support/i);
      return true;
    },
  );
  assert.equal(noAgentSupport.readLog().some((entry) => entry.method === "prompt"), false);
  await harness.cleanup();

  const noClientSupport = configure({ mcpAcpSupport: true, turns: [{ text: "ok" }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd: noClientSupport.cwd, mcpServers: [ACP_SERVER] }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /clientHandlers\.mcp/);
      assert.match(err.message, /local-mcp/);
      return true;
    },
  );
  assert.equal(noClientSupport.readLog().some((entry) => entry.method === "prompt"), false);
});

test("MCP-over-ACP teardown invokes disconnect for live connections on session release", async () => {
  const { cwd, readLog } = configure({
    mcpAcpSupport: true,
    turns: [{ mcpOverAcp: { label: "live", disconnect: false }, text: "ok" }],
  });
  const disconnects: Array<{ params: unknown; ctx: AcpSessionContext }> = [];
  const handlers: ClientHandlers = {
    mcp: {
      connect: () => ({ connectionId: "live-conn" }),
      message: () => ({ ok: true }),
      disconnect: (params, ctx) => {
        disconnects.push({ params, ctx });
        return {};
      },
    },
  };

  await makeRunner(handlers).run("hi", { model: "codex", cwd, label: "live-run", mcpServers: [ACP_SERVER] });

  assert.equal(logEntry(readLog(), "mcpDisconnect", "live"), undefined);
  assert.equal(disconnects.length, 1);
  assert.deepEqual(disconnects[0]?.params, { connectionId: "live-conn" });
  assert.equal(disconnects[0]?.ctx.cwd, cwd);
  assert.equal(disconnects[0]?.ctx.label, "live-run");
});

test("AcpAgentRunner rejects partial mcp handler objects", () => {
  assert.throws(
    () =>
      new AcpAgentRunner({
        clientHandlers: {
          mcp: {
            connect: () => ({ connectionId: "conn" }),
            message: () => ({}),
          } as never,
        },
      }),
    /clientHandlers\.mcp missing required methods: disconnect/,
  );
});
