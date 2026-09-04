import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import {
  ACP_BACKEND_DISCOVERY_VERSION,
  ACP_BACKENDS_PROBE_METHOD,
  ACP_META_NAMESPACE,
  discoveryInitializeResponse,
  parseAcpV1Initialize,
  parseProbeBackendsParams,
} from "../src/protocol.js";

test("standard ACP initialize is independent of AgentPrism routing metadata", () => {
  const params = {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    clientInfo: { name: "ordinary-client", version: "1.0.0" },
    _meta: { vendor: { trace: "kept" } },
  };

  assert.equal(parseAcpV1Initialize(params), params);
  assert.throws(() => parseAcpV1Initialize({ protocolVersion: 2 }), RequestError);
});

test("the discovery initialize advertises only the backend probe extension", () => {
  const response = discoveryInitializeResponse("9.8.7");

  assert.deepEqual(response.agentCapabilities._meta, {
    [ACP_META_NAMESPACE]: {
      backendDiscovery: {
        version: ACP_BACKEND_DISCOVERY_VERSION,
        methods: { probeBackends: ACP_BACKENDS_PROBE_METHOD },
      },
    },
  });
  assert.deepEqual(response.agentInfo, {
    name: "agentprism-acp-server",
    title: "AgentPrism ACP Server Discovery",
    version: "9.8.7",
  });
});

test("backend probes validate the temporary session boundary", () => {
  assert.throws(
    () => parseProbeBackendsParams({ cwd: "relative", mcpServers: [] }),
    RequestError,
  );
  assert.throws(
    () =>
      parseProbeBackendsParams({
        cwd: "/tmp/project",
        additionalDirectories: ["relative"],
        mcpServers: [],
      }),
    RequestError,
  );

  assert.deepEqual(
    parseProbeBackendsParams({
      cwd: "/tmp/project",
      additionalDirectories: ["/tmp/shared"],
      mcpServers: [],
      _meta: { trace: "probe" },
    }),
    {
      cwd: "/tmp/project",
      additionalDirectories: ["/tmp/shared"],
      mcpServers: [],
      _meta: { trace: "probe" },
    },
  );
});
