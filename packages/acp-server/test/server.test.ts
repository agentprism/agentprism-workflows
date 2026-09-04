import assert from "node:assert/strict";
import test from "node:test";
import {
  methods,
  type AnyMessage,
  type AnyRequest,
  type AnyResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { RawBackendConnection } from "@automatalabs/acp-agents";
import {
  ACP_BACKENDS_PROBE_METHOD,
  ACP_META_NAMESPACE,
  serveAcpServer,
  type BackendTarget,
} from "../src/index.js";

function streamPair(): [Stream, Stream] {
  const leftToRight = new TransformStream<AnyMessage, AnyMessage>();
  const rightToLeft = new TransformStream<AnyMessage, AnyMessage>();
  return [
    { writable: leftToRight.writable, readable: rightToLeft.readable },
    { writable: rightToLeft.writable, readable: leftToRight.readable },
  ];
}

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      terminal: true,
      _meta: { clientVendor: { enabled: true } },
    },
    clientInfo: { name: "ordinary-acp-client", version: "1.0.0" },
    _meta: { trace: "trace-1" },
  };
}

function sessionParams() {
  return {
    cwd: "/workspace",
    mcpServers: [],
    _meta: { sessionVendor: true },
  };
}

function fakeTarget(
  id: string,
  name: string,
  serve: (stream: Stream) => Promise<void>,
): BackendTarget {
  return {
    id,
    name,
    async open() {
      const [proxy, backend] = streamPair();
      const closed = serve(backend);
      closed.catch(() => {});
      return {
        backendId: id,
        stream: proxy,
        closed,
        stderrTail: "",
        async close() {
          await closed;
        },
        killNow() {},
      } satisfies RawBackendConnection;
    },
  };
}

async function readMessage(reader: ReadableStreamDefaultReader<AnyMessage>): Promise<AnyMessage> {
  const item = await reader.read();
  assert.equal(item.done, false);
  return item.value!;
}

function request(message: AnyMessage): AnyRequest {
  assert.ok("method" in message && "id" in message);
  return message;
}

function response(message: AnyMessage): AnyResponse {
  assert.ok("result" in message || "error" in message);
  return message;
}

test("a backend endpoint transparently proxies an ordinary ACP client", async () => {
  let backendFailure: unknown;
  const codex = fakeTarget("codex", "Codex", async (stream) => {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    try {
      const initialized = request(await readMessage(reader));
      assert.equal(initialized.method, methods.agent.initialize);
      assert.deepEqual(initialized.params, initializeParams());
      await writer.write({
        jsonrpc: "2.0",
        id: initialized.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "codex-acp", version: "2.0.0" },
          agentCapabilities: { loadSession: true, _meta: { backendVendor: true } },
          _meta: { initializeVendor: true },
        },
      });

      const created = request(await readMessage(reader));
      assert.equal(created.method, methods.agent.session.new);
      assert.deepEqual(created.params, sessionParams());
      await writer.write({
        jsonrpc: "2.0",
        id: created.id,
        result: {
          sessionId: "native-codex-session",
          configOptions: [],
          _meta: { sessionVendor: "preserved" },
        },
      });

      const prompted = request(await readMessage(reader));
      assert.deepEqual(prompted, {
        jsonrpc: "2.0",
        id: 3,
        method: methods.agent.session.prompt,
        params: {
          sessionId: "native-codex-session",
          prompt: [{ type: "text", text: "hello" }],
        },
      });
      await writer.write({
        jsonrpc: "2.0",
        method: methods.client.session.update,
        params: {
          sessionId: "native-codex-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      });
      await writer.write({
        jsonrpc: "2.0",
        id: prompted.id,
        result: { stopReason: "end_turn", _meta: { promptVendor: true } },
      });
      await reader.read();
    } catch (error) {
      backendFailure = error;
      throw error;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  });

  const [client, server] = streamPair();
  const serving = serveAcpServer({
    endpoint: { kind: "backend", backendId: "codex" },
    stream: server,
    targets: [codex],
  });
  const reader = client.readable.getReader();
  const writer = client.writable.getWriter();

  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: methods.agent.initialize,
    params: initializeParams(),
  });
  assert.deepEqual(await readMessage(reader), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentInfo: { name: "codex-acp", version: "2.0.0" },
      agentCapabilities: { loadSession: true, _meta: { backendVendor: true } },
      _meta: { initializeVendor: true },
    },
  });

  await writer.write({
    jsonrpc: "2.0",
    id: 2,
    method: methods.agent.session.new,
    params: sessionParams(),
  });
  assert.deepEqual(await readMessage(reader), {
    jsonrpc: "2.0",
    id: 2,
    result: {
      sessionId: "native-codex-session",
      configOptions: [],
      _meta: { sessionVendor: "preserved" },
    },
  });

  await writer.write({
    jsonrpc: "2.0",
    id: 3,
    method: methods.agent.session.prompt,
    params: {
      sessionId: "native-codex-session",
      prompt: [{ type: "text", text: "hello" }],
    },
  });
  assert.deepEqual(await readMessage(reader), {
    jsonrpc: "2.0",
    method: methods.client.session.update,
    params: {
      sessionId: "native-codex-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    },
  });
  assert.deepEqual(await readMessage(reader), {
    jsonrpc: "2.0",
    id: 3,
    result: { stopReason: "end_turn", _meta: { promptVendor: true } },
  });

  await writer.close();
  await serving;
  assert.equal(backendFailure, undefined);
  reader.releaseLock();
  writer.releaseLock();
});

test("the discovery endpoint probes backend initialize and temporary session configuration", async () => {
  const codex = fakeTarget("codex", "Codex", async (stream) => {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    try {
      const initialized = request(await readMessage(reader));
      assert.equal(initialized.method, methods.agent.initialize);
      assert.deepEqual(initialized.params, initializeParams());
      await writer.write({
        jsonrpc: "2.0",
        id: initialized.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "codex-acp", version: "2.0.0" },
          agentCapabilities: { loadSession: true },
          _meta: { init: "meta" },
        },
      });

      const created = request(await readMessage(reader));
      assert.equal(created.method, methods.agent.session.new);
      assert.deepEqual(created.params, {
        cwd: "/workspace",
        additionalDirectories: ["/other"],
        mcpServers: [],
        _meta: { probe: true },
      });
      await writer.write({
        jsonrpc: "2.0",
        id: created.id,
        result: {
          sessionId: "temporary",
          modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
          configOptions: [{ type: "boolean", id: "fast", name: "Fast", currentValue: false }],
          _meta: { session: "meta" },
        },
      });

      const closed = request(await readMessage(reader));
      assert.equal(closed.method, methods.agent.session.close);
      assert.deepEqual(closed.params, { sessionId: "temporary" });
      await writer.write({ jsonrpc: "2.0", id: closed.id, result: {} });
      await reader.read();
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  });
  const unavailable: BackendTarget = {
    id: "missing",
    name: "Missing",
    async open() {
      throw new Error("not installed");
    },
  };

  const [client, server] = streamPair();
  const serving = serveAcpServer({
    endpoint: { kind: "discovery" },
    stream: server,
    targets: [codex, unavailable],
    version: "0.1.0",
  });
  const reader = client.readable.getReader();
  const writer = client.writable.getWriter();

  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: methods.agent.initialize,
    params: initializeParams(),
  });
  const initialized = response(await readMessage(reader));
  assert.ok("result" in initialized);
  assert.equal(
    ((((initialized.result as { agentCapabilities: { _meta: Record<string, unknown> } }).agentCapabilities
      ._meta[ACP_META_NAMESPACE] as { backendDiscovery: { methods: { probeBackends: string } } })
      .backendDiscovery.methods.probeBackends)),
    ACP_BACKENDS_PROBE_METHOD,
  );

  await writer.write({
    jsonrpc: "2.0",
    id: 2,
    method: ACP_BACKENDS_PROBE_METHOD,
    params: {
      cwd: "/workspace",
      additionalDirectories: ["/other"],
      mcpServers: [],
      _meta: { probe: true },
    },
  });
  const probed = response(await readMessage(reader));
  assert.ok("result" in probed);
  assert.deepEqual(probed.result, {
    backends: [
      {
        id: "codex",
        name: "Codex",
        available: true,
        agentInfo: { name: "codex-acp", version: "2.0.0" },
        agentCapabilities: { loadSession: true },
        modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
        configOptions: [{ type: "boolean", id: "fast", name: "Fast", currentValue: false }],
        initializeMeta: { init: "meta" },
        sessionMeta: { session: "meta" },
      },
      {
        id: "missing",
        name: "Missing",
        available: false,
        stage: "initialize",
        error: "not installed",
      },
    ],
  });

  await writer.close();
  await serving;
  reader.releaseLock();
  writer.releaseLock();
});

test("backend endpoint selection fails before the ACP handshake for an unknown id", async () => {
  await assert.rejects(
    serveAcpServer({ endpoint: { kind: "backend", backendId: "missing" }, targets: [] }),
    /Unknown AgentPrism ACP backend "missing"/,
  );
});
