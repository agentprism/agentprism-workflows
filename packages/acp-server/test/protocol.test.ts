import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, type InitializeRequest } from "@agentclientprotocol/sdk";
import {
  ACP_BACKENDS_PROBE_METHOD,
  ACP_ROUTER_META_NAMESPACE,
  assertSessionBackend,
  discoveryInitializeResponse,
  mergeBackendInitializeResponse,
  parseProbeBackendsParams,
  parseRouterInitialize,
} from "../src/index.js";

function initialize(mode: "discovery" | "backend", backend?: string): InitializeRequest {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      _meta: {
        [ACP_ROUTER_META_NAMESPACE]: {
          acpRouter: { versions: [1] },
        },
      },
    },
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: {
          version: 1,
          mode,
          ...(backend === undefined ? {} : { backend }),
        },
      },
    },
  };
}

test("parses discovery and connection-pinned backend initialization", () => {
  assert.deepEqual(parseRouterInitialize(initialize("discovery")).selection, {
    version: 1,
    mode: "discovery",
  });
  assert.deepEqual(parseRouterInitialize(initialize("backend", "codex")).selection, {
    version: 1,
    mode: "backend",
    backend: "codex",
  });
});

test("rejects clients that do not negotiate the router capability", () => {
  const request = initialize("backend", "codex");
  request.clientCapabilities = {};
  assert.throws(() => parseRouterInitialize(request), RequestError);
});

test("session/new must repeat the pinned backend", () => {
  const params = {
    cwd: "/workspace",
    mcpServers: [],
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: { version: 1, backend: "codex" },
      },
    },
  };
  assert.doesNotThrow(() => assertSessionBackend(params, "codex"));
  assert.throws(() => assertSessionBackend(params, "claude"), RequestError);
});

test("discovery helpers preserve backend capabilities and unrelated metadata", () => {
  const discovery = discoveryInitializeResponse("0.1.0");
  assert.equal(
    ((discovery.agentCapabilities?._meta?.[ACP_ROUTER_META_NAMESPACE] as {
      acpRouter: { methods: { probeBackends: string } };
    }).acpRouter.methods.probeBackends),
    ACP_BACKENDS_PROBE_METHOD,
  );

  const merged = mergeBackendInitializeResponse(
    {
      protocolVersion: 1,
      agentInfo: { name: "codex", version: "2.0.0" },
      agentCapabilities: {
        loadSession: true,
        _meta: {
          vendor: { enabled: true },
          [ACP_ROUTER_META_NAMESPACE]: { retained: true },
        },
      },
      _meta: { responseVendor: true },
    },
    "codex",
  );
  assert.equal(merged.agentInfo?.name, "codex");
  assert.equal(merged.agentCapabilities?.loadSession, true);
  assert.deepEqual(merged.agentCapabilities?._meta?.vendor, { enabled: true });
  assert.deepEqual(merged.agentCapabilities?._meta?.[ACP_ROUTER_META_NAMESPACE], {
    retained: true,
    acpRouter: { version: 1, mode: "backend", backend: "codex" },
  });
  assert.deepEqual(merged._meta, { responseVendor: true });
});

test("probe params require absolute workspace paths", () => {
  assert.deepEqual(
    parseProbeBackendsParams({
      cwd: "/workspace",
      additionalDirectories: ["/other"],
      mcpServers: [],
      _meta: { trace: "t1" },
    }),
    {
      cwd: "/workspace",
      additionalDirectories: ["/other"],
      mcpServers: [],
      _meta: { trace: "t1" },
    },
  );
  assert.throws(
    () => parseProbeBackendsParams({ cwd: "relative", mcpServers: [] }),
    RequestError,
  );
});
