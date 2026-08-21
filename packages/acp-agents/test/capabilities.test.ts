// The capability-negotiation seam (pure, no subprocess): parsing an initialize response, protocol
// version validation, and the two gates (custom `_meta` keys / MCP transports) that decide what the
// client is allowed to send based on what the connected agent advertised.
import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  CODEX_CUSTOM_CAPABILITY_NAMESPACE,
  CODEX_META_KEYS,
  META_KEYS,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import {
  GATED_CUSTOM_META_KEYS,
  gateCustomMeta,
  isSupportedProtocolVersion,
  negotiateCapabilities,
  unsupportedMcpServer,
} from "../src/index.js";
// Module-internal diagnostic describer (mirrors describeAuthProviderAdvertisement's internal home).
import { describeClientAuthAdvertisement } from "../src/capabilities.js";

const CODEX_CUSTOM_CAPABILITIES = {
  namespace: CODEX_CUSTOM_CAPABILITY_NAMESPACE,
  gatedKeys: GATED_CUSTOM_META_KEYS,
} as const;

/** The fork's advertisement shape, keyed under its namespace (mirrors what the fork emits). */
function forkAdvertisement(flags: Record<string, boolean>): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      _meta: { [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: flags },
    },
  };
}

// ---- negotiateCapabilities ----------------------------------------------------------

test("negotiateCapabilities extracts version, agentInfo, close support, and the declared custom block", () => {
  const negotiated = negotiateCapabilities(
    {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "codex-acp", title: "Codex", version: "1.2.0" },
      authMethods: [{ id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } }],
      _meta: { source: "test", steering: { supported: true } },
      agentCapabilities: {
        auth: { logout: {} },
        providers: {},
        sessionCapabilities: { close: {}, fork: {} },
        mcpCapabilities: { http: true, sse: false },
        _meta: {
          [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: { outputSchema: true, baseInstructions: true, developerInstructions: true },
        },
      },
    },
    CODEX_CUSTOM_CAPABILITIES,
  );
  assert.equal(negotiated.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(negotiated.agentInfo, { name: "codex-acp", title: "Codex", version: "1.2.0" });
  assert.deepEqual(negotiated.authMethods, [
    { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } },
  ]);
  assert.deepEqual(negotiated.initializeMeta, { source: "test", steering: { supported: true } });
  assert.equal(negotiated.supportsSteering, true);
  assert.equal(negotiated.supportsClose, true);
  assert.equal(negotiated.supportsForkSession, true);
  assert.equal(negotiated.supportsLogout, true);
  assert.equal(negotiated.supportsProviders, true);
  assert.deepEqual(negotiated.customMetaSupport, {
    outputSchema: true,
    baseInstructions: true,
    developerInstructions: true,
  });
  assert.deepEqual(negotiated.gatedKeys, GATED_CUSTOM_META_KEYS);
});

test("negotiateCapabilities: a minimal response yields no close support and no custom block (legacy)", () => {
  const negotiated = negotiateCapabilities({ protocolVersion: PROTOCOL_VERSION }, CODEX_CUSTOM_CAPABILITIES);
  assert.deepEqual(negotiated.agent, {});
  assert.equal(negotiated.agentInfo, undefined);
  assert.deepEqual(negotiated.authMethods, []);
  assert.equal(negotiated.initializeMeta, undefined);
  assert.equal(negotiated.supportsSteering, false);
  assert.equal(negotiated.supportsClose, false);
  assert.equal(negotiated.supportsForkSession, false);
  assert.equal(negotiated.supportsLogout, false);
  assert.equal(negotiated.supportsProviders, false);
  assert.equal(negotiated.customMetaSupport, undefined, "no namespace advertised => legacy passthrough");
  assert.deepEqual(negotiated.gatedKeys, GATED_CUSTOM_META_KEYS);
});

test("negotiateCapabilities derives steering strictly from top-level response _meta", () => {
  const supported = negotiateCapabilities({
    protocolVersion: PROTOCOL_VERSION,
    _meta: { steering: { supported: true } },
    agentCapabilities: {
      _meta: { steering: { supported: false } },
    },
  });
  assert.equal(supported.supportsSteering, true, "top-level exact true wins");

  const malformedAdvertisements: unknown[] = [
    undefined,
    null,
    false,
    true,
    1,
    "true",
    [],
    {},
    { steering: null },
    { steering: true },
    { steering: [] },
    { steering: {} },
    { steering: { supported: false } },
    { steering: { supported: 1 } },
    { steering: { supported: "true" } },
  ];
  for (const meta of malformedAdvertisements) {
    const negotiated = negotiateCapabilities({
      protocolVersion: PROTOCOL_VERSION,
      _meta: meta as InitializeResponse["_meta"],
      agentCapabilities: {
        _meta: { steering: { supported: true } },
      },
    });
    assert.equal(
      negotiated.supportsSteering,
      false,
      `unsupported top-level advertisement: ${JSON.stringify(meta)}`,
    );
  }
});

test("negotiateCapabilities: no backend declaration ignores even a known custom namespace", () => {
  const negotiated = negotiateCapabilities(forkAdvertisement({ outputSchema: false }));
  assert.equal(negotiated.customMetaSupport, undefined);
  assert.equal(negotiated.gatedKeys, undefined);
});

test("negotiateCapabilities ignores a non-object custom namespace value", () => {
  const negotiated = negotiateCapabilities(
    {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { _meta: { [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: true } },
    },
    CODEX_CUSTOM_CAPABILITIES,
  );
  assert.equal(negotiated.customMetaSupport, undefined);
});

test("negotiateCapabilities ignores a malformed array custom namespace value", () => {
  const negotiated = negotiateCapabilities(
    {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { _meta: { [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: [] } },
    },
    CODEX_CUSTOM_CAPABILITIES,
  );
  assert.equal(negotiated.customMetaSupport, undefined);
});

// ---- isSupportedProtocolVersion -----------------------------------------------------

test("isSupportedProtocolVersion: accepts EXACTLY the client's version, rejects any other", () => {
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION), true);
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION + 1), false, "a newer protocol we cannot speak");
  assert.equal(isSupportedProtocolVersion(PROTOCOL_VERSION - 1), false, "an older protocol we no longer speak");
  assert.equal(isSupportedProtocolVersion(0), false);
  assert.equal(isSupportedProtocolVersion(1.5), false);
});

// ---- gateCustomMeta -----------------------------------------------------------------

test("gateCustomMeta: no advertised namespace => passes every key unchanged (legacy)", () => {
  const meta = { [META_KEYS.outputSchema]: { a: 1 }, [CODEX_META_KEYS.baseInstructions]: "B" };
  const support = negotiateCapabilities(forkAdvertisement({}), CODEX_CUSTOM_CAPABILITIES).customMetaSupport; // '{}' block, still a namespace
  // Sanity: forkAdvertisement({}) DOES advertise the namespace (empty flags) — that gates everything.
  assert.deepEqual(gateCustomMeta(meta, undefined), meta, "undefined support is the legacy passthrough");
  // …whereas an advertised-but-empty block treats every flag as unsupported:
  assert.equal(gateCustomMeta(meta, support), undefined, "advertised empty block drops all gated keys");
});

test("gateCustomMeta: drops only the un-advertised gated keys, keeps advertised + ungated keys", () => {
  const support = negotiateCapabilities(
    forkAdvertisement({ baseInstructions: true, developerInstructions: false, outputSchema: false }),
    CODEX_CUSTOM_CAPABILITIES,
  ).customMetaSupport;
  const meta = {
    [CODEX_META_KEYS.baseInstructions]: "B",
    [CODEX_META_KEYS.developerInstructions]: "D",
    [META_KEYS.runId]: "r1", // ungated key — always survives
  };
  assert.deepEqual(gateCustomMeta(meta, support), {
    [CODEX_META_KEYS.baseInstructions]: "B",
    [META_KEYS.runId]: "r1",
  });
});

test("gateCustomMeta: all advertised => unchanged; does not mutate the input", () => {
  const support = negotiateCapabilities(
    forkAdvertisement({ outputSchema: true, baseInstructions: true, developerInstructions: true }),
    CODEX_CUSTOM_CAPABILITIES,
  ).customMetaSupport;
  const meta = { [META_KEYS.outputSchema]: { a: 1 }, [CODEX_META_KEYS.baseInstructions]: "B" };
  const out = gateCustomMeta(meta, support);
  assert.deepEqual(out, meta);
  assert.deepEqual(meta, { [META_KEYS.outputSchema]: { a: 1 }, [CODEX_META_KEYS.baseInstructions]: "B" }, "input untouched");
});

test("gateCustomMeta: undefined/empty meta is passed through", () => {
  const support = negotiateCapabilities(forkAdvertisement({}), CODEX_CUSTOM_CAPABILITIES).customMetaSupport;
  assert.equal(gateCustomMeta(undefined, support), undefined);
});

test("GATED_CUSTOM_META_KEYS are exactly the fork's three bare wire keys", () => {
  assert.deepEqual([...GATED_CUSTOM_META_KEYS].sort(), [
    CODEX_META_KEYS.baseInstructions,
    CODEX_META_KEYS.developerInstructions,
    META_KEYS.outputSchema,
  ].sort());
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
