// The capability-negotiation seam (pure, no subprocess): standard ACP adaptation plus transparent
// preservation of vendor initialize metadata for the feature layer that owns it.
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "@automatalabs/shared-types";
import {
  isSupportedProtocolVersion,
  negotiateCapabilities,
  unsupportedMcpServer,
} from "../src/index.js";
// Module-internal diagnostic describer (mirrors describeAuthProviderAdvertisement's internal home).
import { describeClientAuthAdvertisement } from "../src/capabilities.js";

// ---- negotiateCapabilities ----------------------------------------------------------

test("negotiateCapabilities extracts standard fields and preserves arbitrary initialize metadata by reference", () => {
  const initializeMeta = {
    source: "test",
    steering: { supported: true, nested: { modes: ["strict", { future: true }] } },
    vendor: { arbitrary: { list: [1, null, { deep: "value" }] } },
  };
  const negotiated = negotiateCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "codex-acp", title: "Codex", version: "1.2.0" },
    authMethods: [{ id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } }],
    _meta: initializeMeta,
    agentCapabilities: {
      auth: { logout: {} },
      providers: {},
      sessionCapabilities: { close: {}, fork: {} },
      mcpCapabilities: { http: true, sse: false },
      _meta: {
        "@example/agent": { outputSchema: false, nested: { untouched: true } },
      },
    },
  });
  assert.equal(negotiated.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(negotiated.agentInfo, { name: "codex-acp", title: "Codex", version: "1.2.0" });
  assert.deepEqual(negotiated.authMethods, [
    { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } },
  ]);
  assert.strictEqual(negotiated.initializeMeta, initializeMeta);
  assert.equal(negotiated.supportsClose, true);
  assert.equal(negotiated.supportsForkSession, true);
  assert.equal(negotiated.supportsLogout, true);
  assert.equal(negotiated.supportsProviders, true);
  assert.deepEqual(negotiated.agent._meta, {
    "@example/agent": { outputSchema: false, nested: { untouched: true } },
  });
});

test("negotiateCapabilities: a minimal response yields only standard unsupported defaults", () => {
  const negotiated = negotiateCapabilities({ protocolVersion: PROTOCOL_VERSION });
  assert.deepEqual(negotiated.agent, {});
  assert.equal(negotiated.agentInfo, undefined);
  assert.deepEqual(negotiated.authMethods, []);
  assert.equal(negotiated.initializeMeta, undefined);
  assert.equal(negotiated.supportsClose, false);
  assert.equal(negotiated.supportsForkSession, false);
  assert.equal(negotiated.supportsLogout, false);
  assert.equal(negotiated.supportsProviders, false);
});

test("NegotiatedCapabilities exposes no derived vendor-extension or metadata-gating fields", () => {
  const negotiated = negotiateCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    _meta: { steering: { supported: true }, loadedTurn: { supported: true } },
    agentCapabilities: {
      _meta: { "@example/agent": { arbitrary: false } },
    },
  });
  for (const removed of [
    "supportsSteering",
    "supportsLoadedTurnTerminalState",
    "customMetaSupport",
    "gatedKeys",
  ]) {
    assert.equal(removed in negotiated, false, `${removed} must not be projected`);
  }
});

// ---- isSupportedProtocolVersion -----------------------------------------------------

test("isSupportedProtocolVersion: accepts EXACTLY the client's version, rejects any other", () => {
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION), true);
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION + 1), false, "a newer protocol we cannot speak");
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION - 1), false, "an older protocol we no longer speak");
  assert.equal(isSupportedProtocolVersion(0), false);
  assert.equal(isSupportedProtocolVersion(1.5), false);
});

// ---- unsupportedMcpServer -----------------------------------------------------------

const HTTP_SERVER: McpServerConfig = { type: "http", name: "http-mcp", url: "https://x", headers: [] };
const SSE_SERVER: McpServerConfig = { type: "sse", name: "sse-mcp", url: "https://x", headers: [] };
const ACP_SERVER: McpServerConfig = { type: "acp", name: "acp-mcp", serverId: "acp-server" };
const STDIO_SERVER: McpServerConfig = { name: "stdio-mcp", command: "srv", args: [], env: [] };

test("unsupportedMcpServer: gates http/sse on mcpCapabilities; stdio is always serviceable", () => {
  const agent = { mcpCapabilities: { http: true, sse: false } };
  assert.equal(unsupportedMcpServer([HTTP_SERVER], agent), undefined, "http advertised => ok");
  assert.equal(unsupportedMcpServer([STDIO_SERVER], agent), undefined, "stdio is baseline => ok");
  assert.deepEqual(unsupportedMcpServer([SSE_SERVER], agent), { name: "sse-mcp", transport: "sse" });
  // The FIRST unsupported server is reported.
  assert.deepEqual(unsupportedMcpServer([STDIO_SERVER, SSE_SERVER], agent), { name: "sse-mcp", transport: "sse" });
});

test("unsupportedMcpServer: no advertised mcpCapabilities => legacy, gate nothing", () => {
  assert.equal(unsupportedMcpServer([SSE_SERVER, HTTP_SERVER], {}), undefined);
});

test("unsupportedMcpServer: acp requires agent support and complete client handlers", () => {
  assert.deepEqual(unsupportedMcpServer([ACP_SERVER], {}), { name: "acp-mcp", transport: "acp" });
  assert.deepEqual(unsupportedMcpServer([ACP_SERVER], { mcpCapabilities: { acp: false } }), {
    name: "acp-mcp",
    transport: "acp",
  });
  assert.deepEqual(
    unsupportedMcpServer([ACP_SERVER], { mcpCapabilities: { acp: true } }, { clientCanServeAcp: false }),
    {
      name: "acp-mcp",
      transport: "acp",
      reason: "client",
    },
  );
  assert.equal(
    unsupportedMcpServer([ACP_SERVER], { mcpCapabilities: { acp: true } }, { clientCanServeAcp: true }),
    undefined,
  );
});

test("unsupportedMcpServer: undefined/empty server list is serviceable", () => {
  assert.equal(unsupportedMcpServer(undefined, { mcpCapabilities: { http: false, sse: false } }), undefined);
  assert.equal(unsupportedMcpServer([], { mcpCapabilities: { http: false, sse: false } }), undefined);
});

// §1.2 symmetric client-side describer for error/diagnostic text (counterpart to the agent-side
// describeAuthProviderAdvertisement). Renders only the pinned boolean gates, never any secret.
test("describeClientAuthAdvertisement: renders the lit gates and the terminal-auth channel", () => {
  assert.equal(
    describeClientAuthAdvertisement({ terminal: true, _meta: { gateway: true } }, { "terminal-auth": true }),
    'auth.terminal=true; auth._meta.gateway=true; _meta["terminal-auth"]=true',
  );
  assert.equal(describeClientAuthAdvertisement({ _meta: { gateway: true } }, undefined), "auth._meta.gateway=true");
  assert.equal(
    describeClientAuthAdvertisement({ terminal: true }, { "terminal-auth": true }),
    'auth.terminal=true; _meta["terminal-auth"]=true',
  );
});

test("describeClientAuthAdvertisement: renders auth=none when nothing is advertised", () => {
  assert.equal(describeClientAuthAdvertisement(undefined, undefined), "auth=none");
  assert.equal(describeClientAuthAdvertisement(undefined, null), "auth=none");
  assert.equal(describeClientAuthAdvertisement({}, {}), "auth=none");
  // A non-gateway _meta or falsy gate value renders nothing (only `=== true` counts).
  assert.equal(describeClientAuthAdvertisement({ terminal: false, _meta: { gateway: false } }, {}), "auth=none");
});
