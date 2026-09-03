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
  ACP_ROUTER_META_NAMESPACE,
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

function initializeParams(mode: "discovery" | "backend", backend?: string) {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      terminal: true,
      _meta: {
        [ACP_ROUTER_META_NAMESPACE]: { acpRouter: { versions: [1] } },
        clientVendor: { enabled: true },
      },
    },
    clientInfo: { name: "test-client", version: "1.0.0" },
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: { version: 1, mode, ...(backend === undefined ? {} : { backend }) },
      },
      trace: "trace-1",
    },
  };
}

function sessionParams(backend: string) {
  return {
    cwd: "/workspace",
    mcpServers: [],
    _meta: {
      [ACP_ROUTER_META_NAMESPACE]: { acpRouter: { version: 1, backend } },
      sessionVendor: true,
    },
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

test("backend mode forwards initialize and all post-session traffic without rewriting session ids", async () => {
  let backendFailure: unknown;
  const codex = fakeTarget("codex", "Codex", async (stream) => {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    try {
      const initialized = request(await readMessage(reader));
      assert.equal(initialized.method, methods.agent.initialize);
      assert.deepEqual(initialized.params, initializeParams("backend", "codex"));
      await writer.write({
        jsonrpc: "2.0",
        id: initialized.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "codex-acp", version: "2.0.0" },
          agentCapabilities: {
            loadSession: true,
            _meta: { backendVendor: true },
          },
          _meta: { initializeVendor: true },
        },
      });

      const created = request(await readMessage(reader));
      assert.equal(created.method, methods.agent.session.new);
      assert.deepEqual(created.params, sessionParams("codex"));
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
  const serving = serveAcpServer({ stream: server, targets: [codex], version: "0.1.0" });
  const reader = client.readable.getReader();
  const writer = client.writable.getWriter();

  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: methods.agent.initialize,
    params: initializeParams("backend", "codex"),
  });
  const initialized = response(await readMessage(reader));
  assert.ok("result" in initialized);
  const initializeResult = initialized.result as Record<string, unknown>;
  assert.deepEqual(initializeResult.agentInfo, { name: "codex-acp", version: "2.0.0" });
  assert.deepEqual(
    ((initializeResult.agentCapabilities as { _meta: Record<string, unknown> })._meta),
    {
      backendVendor: true,
      [ACP_ROUTER_META_NAMESPACE]: {
        acpRouter: { version: 1, mode: "backend", backend: "codex" },
      },
    },
  );
  assert.deepEqual(initializeResult._meta, { initializeVendor: true });

  await writer.write({
    jsonrpc: "2.0",
    id: 2,
    method: methods.agent.session.new,
    params: sessionParams("codex"),
  });
  const created = response(await readMessage(reader));
  assert.deepEqual(created, {
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

test("discovery mode probes backend initialize and temporary session configuration", async () => {
  const codex = fakeTarget("codex", "Codex", async (stream) => {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    try {
      const initialized = request(await readMessage(reader));
      assert.equal(initialized.method, methods.agent.initialize);
      assert.deepEqual(initialized.params, initializeParams("discovery"));
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
  const serving = serveAcpServer({ stream: server, targets: [codex, unavailable], version: "0.1.0" });
  const reader = client.readable.getReader();
  const writer = client.writable.getWriter();

  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: methods.agent.initialize,
    params: initializeParams("discovery"),
  });
  const initialized = response(await readMessage(reader));
  assert.ok("result" in initialized);
  assert.equal(
    ((((initialized.result as { agentCapabilities: { _meta: Record<string, unknown> } }).agentCapabilities
      ._meta[ACP_ROUTER_META_NAMESPACE] as { acpRouter: { methods: { probeBackends: string } } })
      .acpRouter.methods.probeBackends)),
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

test("backend mode rejects a mismatched session/new without forwarding it", async () => {
  let receivedSessionNew = false;
  const codex = fakeTarget("codex", "Codex", async (stream) => {
    const reader = stream.readable.getReader();
    const writer = stream.writable.getWriter();
    try {
      const initialized = request(await readMessage(reader));
      await writer.write({ jsonrpc: "2.0", id: initialized.id, result: { protocolVersion: 1 } });
      const item = await reader.read();
      receivedSessionNew = !item.done;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  });

  const [client, server] = streamPair();
  const serving = serveAcpServer({ stream: server, targets: [codex] });
  const reader = client.readable.getReader();
  const writer = client.writable.getWriter();
  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: methods.agent.initialize,
    params: initializeParams("backend", "codex"),
  });
  await readMessage(reader);
  await writer.write({
    jsonrpc: "2.0",
    id: 2,
    method: methods.agent.session.new,
    params: sessionParams("claude"),
  });
  const rejected = response(await readMessage(reader));
  assert.ok("error" in rejected);
  assert.equal(rejected.error.code, -32602);
  await writer.close();
  await serving;
  assert.equal(receivedSessionNew, false);
  reader.releaseLock();
  writer.releaseLock();
});
