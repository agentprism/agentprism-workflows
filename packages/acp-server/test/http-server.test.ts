import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { RawBackendConnection } from "@automatalabs/acp-agents";
import { WebSocket } from "ws";
import {
  ACP_ROUTER_META_NAMESPACE,
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
    clientInfo: { name: "network-router-test", version: "1.0.0" },
    clientCapabilities: {
      _meta: {
        [ACP_ROUTER_META_NAMESPACE]: { acpRouter: { versions: [1] } },
      },
    },
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: { version: 1, mode: "backend", backend: "codex" },
      },
    },
  } satisfies acp.InitializeRequest;
}

function sessionParams() {
  return {
    cwd: "/workspace",
    mcpServers: [],
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: { version: 1, backend: "codex" },
      },
    },
  } satisfies acp.NewSessionRequest;
}

test("HTTP and WebSocket connections each reach a connection-pinned router", async () => {
  const receivedInitializes: unknown[] = [];
  const backendFailures: unknown[] = [];
  let opened = 0;
  const target: BackendTarget = {
    id: "codex",
    name: "Codex",
    async open() {
      const [router, backend] = streamPair();
      opened += 1;
      const nativeSessionId = `native-session-${opened}`;
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
              agentInfo: { name: "codex-acp", version: "test" },
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
            result: { sessionId: nativeSessionId },
          });
          await reader.read();
        } finally {
          reader.releaseLock();
          writer.releaseLock();
        }
      })();
      serving.catch((error) => backendFailures.push(error));
      return {
        backendId: "codex",
        stream: router,
        closed: serving,
        stderrTail: "",
        async close() {
          await serving;
        },
        killNow() {},
      } satisfies RawBackendConnection;
    },
  };

  const server = await listenAcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    targets: [target],
    version: "test",
  });
  try {
    const connections: Array<[string, acp.Stream]> = [
      ["HTTP", createHttpStream(server.url)],
      ["WebSocket", createWebSocketStream(server.webSocketUrl, { WebSocket })],
    ];
    for (const [index, [transport, stream]] of connections.entries()) {
      const result = await acp.client({ name: `network-router-${transport}` }).connectWith(
        stream,
        async (context) => {
          const initialized = await context.request(acp.methods.agent.initialize, initializeParams());
          const selection = initialized.agentCapabilities?._meta?.[ACP_ROUTER_META_NAMESPACE] as {
            acpRouter?: { backend?: string };
          };
          assert.equal(selection.acpRouter?.backend, "codex");
          return context.request(acp.methods.agent.session.new, sessionParams());
        },
      );
      assert.equal(result.sessionId, `native-session-${index + 1}`);
    }
  } finally {
    await server.close();
  }

  assert.equal(opened, 2);
  assert.deepEqual(receivedInitializes, [initializeParams(), initializeParams()]);
  assert.deepEqual(backendFailures, []);
});
