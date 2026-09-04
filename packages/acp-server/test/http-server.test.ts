import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { RawBackendConnection } from "@automatalabs/acp-agents";
import { WebSocket } from "ws";
import {
  ACP_META_NAMESPACE,
  listenAcpHttpServer,
  type BackendTarget,
} from "../src/index.js";

function streamPair(): [acp.Stream, acp.Stream] {
  const leftToRight = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const rightToLeft = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  return [
    { writable: leftToRight.writable, readable: rightToLeft.readable },
    { writable: rightToLeft.writable, readable: leftToRight.readable },
  ];
}

function initializeParams() {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "ordinary-network-client", version: "1.0.0" },
    clientCapabilities: { _meta: { clientVendor: true } },
    _meta: { trace: "network" },
  } satisfies acp.InitializeRequest;
}

function sessionParams() {
  return {
    cwd: "/workspace",
    mcpServers: [],
    _meta: { sessionVendor: true },
  } satisfies acp.NewSessionRequest;
}

function fakeTarget(
  id: string,
  opens: string[],
  receivedInitializes: unknown[],
  failures: unknown[],
): BackendTarget {
  return {
    id,
    name: id.toUpperCase(),
    async open() {
      const [proxy, backend] = streamPair();
      opens.push(id);
      const serving = (async () => {
        const reader = backend.readable.getReader();
        const writer = backend.writable.getWriter();
        try {
          const initialized = await reader.read();
          assert.equal(initialized.done, false);
          assert.ok(initialized.value && "method" in initialized.value && "id" in initialized.value);
          assert.equal(initialized.value.method, acp.methods.agent.initialize);
          receivedInitializes.push(initialized.value.params);
          await writer.write({
            jsonrpc: "2.0",
            id: initialized.value.id,
            result: {
              protocolVersion: acp.PROTOCOL_VERSION,
              agentInfo: { name: `${id}-acp`, version: "test" },
              agentCapabilities: { _meta: { backendVendor: id } },
            },
          });

          const created = await reader.read();
          assert.equal(created.done, false);
          assert.ok(created.value && "method" in created.value && "id" in created.value);
          assert.equal(created.value.method, acp.methods.agent.session.new);
          assert.deepEqual(created.value.params, sessionParams());
          await writer.write({
            jsonrpc: "2.0",
            id: created.value.id,
            result: { sessionId: `native-${id}-session` },
          });
          await reader.read();
        } finally {
          reader.releaseLock();
          writer.releaseLock();
        }
      })();
      serving.catch((error) => failures.push(error));
      return {
        backendId: id,
        stream: proxy,
        closed: serving,
        stderrTail: "",
        async close() {
          await serving;
        },
        killNow() {},
      } satisfies RawBackendConnection;
    },
  };
}

test("HTTP and WebSocket paths select discovery or one configured backend before initialize", async () => {
  const opens: string[] = [];
  const receivedInitializes: unknown[] = [];
  const failures: unknown[] = [];
  const targets = [
    fakeTarget("codex", opens, receivedInitializes, failures),
    fakeTarget("claude", opens, receivedInitializes, failures),
  ];

  const server = await listenAcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    basePath: "/router",
    targets,
    version: "test",
  });
  try {
    assert.equal(server.discovery.path, "/router/discovery");
    assert.deepEqual(
      server.backends.map(({ backendId, path }) => ({ backendId, path })),
      [
        { backendId: "codex", path: "/router/backends/codex" },
        { backendId: "claude", path: "/router/backends/claude" },
      ],
    );

    const oldEndpoint = await fetch(`http://${server.host}:${server.port}/router`);
    assert.equal(oldEndpoint.status, 404);
    const unknownBackend = await fetch(`http://${server.host}:${server.port}/router/backends/missing`);
    assert.equal(unknownBackend.status, 404);

    const discoveryStream = createHttpStream(server.discovery.url);
    const discovery = await acp.client({ name: "discovery-client" }).connectWith(
      discoveryStream,
      (context) => context.request(acp.methods.agent.initialize, initializeParams()),
    );
    assert.equal(discovery.agentInfo?.name, "agentprism-acp-server");
    assert.ok(
      (discovery.agentCapabilities._meta?.[ACP_META_NAMESPACE] as { backendDiscovery?: unknown })
        .backendDiscovery,
    );
    assert.deepEqual(opens, []);

    const codex = server.backends.find((endpoint) => endpoint.backendId === "codex")!;
    const codexSession = await acp.client({ name: "codex-http-client" }).connectWith(
      createHttpStream(codex.url),
      async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, initializeParams());
        assert.deepEqual(initialized.agentCapabilities?._meta, { backendVendor: "codex" });
        return context.request(acp.methods.agent.session.new, sessionParams());
      },
    );
    assert.equal(codexSession.sessionId, "native-codex-session");

    const claude = server.backends.find((endpoint) => endpoint.backendId === "claude")!;
    const claudeSession = await acp.client({ name: "claude-websocket-client" }).connectWith(
      createWebSocketStream(claude.webSocketUrl, { WebSocket }),
      async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, initializeParams());
        assert.deepEqual(initialized.agentCapabilities?._meta, { backendVendor: "claude" });
        return context.request(acp.methods.agent.session.new, sessionParams());
      },
    );
    assert.equal(claudeSession.sessionId, "native-claude-session");
  } finally {
    await server.close();
  }

  assert.deepEqual(opens, ["codex", "claude"]);
  assert.deepEqual(receivedInitializes, [initializeParams(), initializeParams()]);
  assert.deepEqual(failures, []);
});

test("network routes reject backend ids that cannot be represented canonically", async () => {
  await assert.rejects(
    listenAcpHttpServer({
      port: 0,
      targets: [{ id: "bad/id", name: "Bad", async open() { throw new Error("unused"); } }],
    }),
    /must match/,
  );
});
