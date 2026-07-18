import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import test from "node:test";
import {
  client,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { PiAcpAgent } from "../src/agent.js";
import { realSleep } from "../src/deps.js";
import {
  adapterError,
  classifyTerminal,
  type ErrorKind,
} from "../src/errors.js";
import {
  bridgeMcpServers,
  connectDefaultMcpClient,
} from "../src/mcp-bridge.js";
import { installPermissionWrapper } from "../src/permissions.js";
import { replayEntry } from "../src/replay.js";
import { runAcp } from "../src/server.js";
import {
  context,
  fakeDeps,
  fakeMcpHandle,
  fakeSession,
  streamPair,
} from "./helpers/fakes.js";

function errorKind(error: unknown): unknown {
  return ((error as RequestError).data as { errorKind?: string } | undefined)?.errorKind;
}

function errorWire(error: RequestError) {
  return {
    code: error.code,
    message: error.message,
    data: error.data as Record<string, unknown>,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function gatedRealSleep(gatedMs: number, gate: Promise<void>): typeof realSleep {
  return async (ms, signal) => {
    if (ms === gatedMs) {
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      await Promise.race([gate, aborted]);
    }
    return realSleep(ms, signal);
  };
}

function fakeCreateResult(options: CreateAgentSessionOptions, behavior: "normal" | "wedged" | "tool" = "normal") {
  const control = fakeSession(options, behavior);
  return {
    control,
    result: {
      session: control.session,
      extensionsResult: { extensions: [], errors: [], runtime: {} },
      modelFallbackMessage: undefined,
    } as never,
  };
}

test("T8 adapter errors have the exact reserved prefix and fixed-label wire shape", () => {
  const expected: Record<ErrorKind, { code: number; prefix: string; label: string }> = {
    auth_error: { code: -32000, prefix: "Authentication required", label: "provider credentials required" },
    rate_limit: { code: -32603, prefix: "Internal error", label: "provider rate limit" },
    billing_error: { code: -32603, prefix: "Internal error", label: "provider billing or quota wall" },
    provider_error: { code: -32603, prefix: "Internal error", label: "provider error" },
    invalid_model: { code: -32602, prefix: "Invalid params", label: "unknown or unselectable model" },
    empty_prompt: { code: -32602, prefix: "Invalid params", label: "prompt has no text or images" },
    session_busy: { code: -32602, prefix: "Invalid params", label: "session has a turn in flight" },
    invalid_config_value: { code: -32602, prefix: "Invalid params", label: "invalid config option" },
    invalid_config_type: { code: -32602, prefix: "Invalid params", label: "invalid config option" },
    unknown_config_option: { code: -32602, prefix: "Invalid params", label: "invalid config option" },
    invalid_cwd: { code: -32602, prefix: "Invalid params", label: "invalid working directory" },
    unknown_session: { code: -32602, prefix: "Invalid params", label: "unknown session id" },
    session_already_open: { code: -32602, prefix: "Invalid params", label: "session already open" },
    session_terminated: { code: -32602, prefix: "Invalid params", label: "session terminated" },
    session_corrupt: { code: -32603, prefix: "Internal error", label: "session file could not be read" },
    session_not_forkable: { code: -32602, prefix: "Invalid params", label: "session has no persisted history to fork" },
    mcp_init_error: { code: -32603, prefix: "Internal error", label: "mcp server initialization failed" },
    unsupported_mcp_transport: { code: -32602, prefix: "Invalid params", label: "unsupported mcp transport" },
    extension_setup_error: { code: -32603, prefix: "Internal error", label: "pi extension setup failed" },
    child_cleanup_error: { code: -32603, prefix: "Internal error", label: "child process cleanup failed" },
    invalid_cursor: { code: -32602, prefix: "Invalid params", label: "invalid list cursor" },
    unknown_auth_method: { code: -32602, prefix: "Invalid params", label: "unknown auth method" },
    notification_error: { code: -32603, prefix: "Internal error", label: "notification delivery failed" },
    internal_error: { code: -32603, prefix: "Internal error", label: "internal error" },
  };

  for (const [kind, shape] of Object.entries(expected) as Array<[ErrorKind, typeof expected[ErrorKind]]>) {
    const extras = kind === "mcp_init_error" || kind === "unsupported_mcp_transport"
      ? { server: "server-a" }
      : kind === "child_cleanup_error"
        ? { details: { remainingChildren: 2 } }
        : undefined;
    assert.deepEqual(errorWire(adapterError(kind, extras)), {
      code: shape.code,
      message: shape.prefix,
      data: {
        errorKind: kind,
        message: shape.label,
        ...(extras ?? {}),
      },
    }, kind);
  }

  const diagnostics = [{
    type: "provider",
    timestamp: 42,
    error: { name: "SecretError", message: "WIRE_SECRET", stack: "WIRE_SECRET stack" },
    details: { token: "WIRE_SECRET" },
  }];
  assert.deepEqual(errorWire(classifyTerminal({ stopReason: "error", errorMessage: "generic", diagnostics })), {
    code: -32603,
    message: "Internal error",
    data: {
      errorKind: "provider_error",
      message: "provider error",
      details: [{ type: "provider", timestamp: 42 }],
    },
  });
  assert.equal(RequestError.methodNotFound().code, -32601);
  assert.equal(RequestError.requestCancelled().code, -32800);
});

test("T11 permission decisions cover every allow, deny, abort, transport, and inner-hook path", async () => {
  const call = { toolCall: { name: "read", id: "tool-1" } } as never;
  const install = (
    request: (...args: unknown[]) => Promise<unknown>,
    inner?: () => Promise<{ block?: boolean; reason?: string } | undefined>,
    turn = new AbortController(),
  ) => {
    const fake = fakeSession({});
    fake.session.agent.beforeToolCall = inner;
    let drains = 0;
    installPermissionWrapper(fake.session, {
      sessionId: "session-1",
      client: { request } as never,
      async drain() { drains += 1; },
      turnSignal: () => turn.signal,
    });
    return { fake, turn, drains: () => drains };
  };

  let captured: unknown[] = [];
  let innerCalls = 0;
  const once = install(async (...args) => {
    captured = args;
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  }, async () => { innerCalls += 1; return undefined; });
  assert.equal(await once.fake.session.agent.beforeToolCall?.(call, new AbortController().signal), undefined);
  assert.equal(innerCalls, 1);
  assert.equal(once.drains(), 1);
  assert.equal(captured[0], methods.client.session.requestPermission);
  assert.deepEqual((captured[1] as { options: Array<{ optionId: string }> }).options.map(({ optionId }) => optionId), [
    "allow_always", "allow_once", "reject_once",
  ]);
  assert.deepEqual((captured[1] as { toolCall: { _meta: unknown } }).toolCall._meta, { toolName: "read" });
  assert.equal((captured[2] as { cancellationSignal: AbortSignal }).cancellationSignal, once.turn.signal);

  for (const [response, expected] of [
    [{ outcome: { outcome: "selected", optionId: "reject_once" } }, { block: true, reason: "denied by user" }],
    [{ outcome: { outcome: "cancelled" } }, { block: true, reason: "cancelled" }],
    [{ outcome: { outcome: "selected", optionId: "hostile" } }, { block: true, reason: "unrecognized permission selection" }],
    [{ outcome: { outcome: "selected" } }, { block: true, reason: "unrecognized permission selection" }],
  ] as const) {
    const scenario = install(async () => response);
    assert.deepEqual(
      await scenario.fake.session.agent.beforeToolCall?.(call, new AbortController().signal),
      expected,
    );
  }

  const unavailable = install(async () => { throw new Error("transport closed"); });
  assert.deepEqual(await unavailable.fake.session.agent.beforeToolCall?.(call, new AbortController().signal), {
    block: true,
    reason: "permission unavailable",
  });

  const parked = deferred<unknown>();
  const aborted = install(async () => parked.promise);
  const abortDecision = aborted.fake.session.agent.beforeToolCall?.(call, new AbortController().signal);
  await Promise.resolve();
  aborted.turn.abort();
  assert.deepEqual(await abortDecision, { block: true, reason: "cancelled" });
  parked.reject(new Error("late permission rejection"));
  await setImmediatePromise();

  const innerBlock = install(
    async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    async () => ({ block: true, reason: "extension denied" }),
  );
  assert.deepEqual(await innerBlock.fake.session.agent.beforeToolCall?.(call, new AbortController().signal), {
    block: true,
    reason: "extension denied",
  });

  const innerThrow = install(
    async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    async () => { throw new Error("extension failure"); },
  );
  await assert.rejects(
    innerThrow.fake.session.agent.beforeToolCall?.(call, new AbortController().signal),
    /extension failure/,
  );

  let requestCalls = 0;
  let cachedInnerBlocks = false;
  const cached = install(
    async () => {
      requestCalls += 1;
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    },
    async () => cachedInnerBlocks ? { block: true, reason: "late extension block" } : undefined,
  );
  assert.equal(await cached.fake.session.agent.beforeToolCall?.(call, new AbortController().signal), undefined);
  cachedInnerBlocks = true;
  assert.deepEqual(await cached.fake.session.agent.beforeToolCall?.(call, new AbortController().signal), {
    block: true,
    reason: "late extension block",
  });
  assert.equal(requestCalls, 1);
});

test("T16 replay projection is total for all message roles, entry kinds, and content forms", () => {
  assert.deepEqual(replayEntry({ type: "message", message: { role: "user", content: "user string" } } as never), [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "user string" } },
  ]);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "user", content: [
    { type: "text", text: "user array" },
    { type: "image", data: "image", mimeType: "image/png" },
  ] } } as never).map(({ sessionUpdate }) => sessionUpdate), ["user_message_chunk", "user_message_chunk"]);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "assistant", content: [
    { type: "text", text: "answer" },
    { type: "thinking", thinking: "reason" },
    { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "pwd" } },
  ] } } as never), [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } },
    {
      sessionUpdate: "tool_call", toolCallId: "tc-1", title: "bash", kind: "execute", status: "pending",
      rawInput: { command: "pwd" }, _meta: { toolName: "bash" },
    },
  ]);
  assert.deepEqual(replayEntry({ type: "message", message: {
    role: "toolResult", toolCallId: "tc-1", toolName: "bash", isError: true,
    content: [{ type: "text", text: "failed" }, { type: "image", data: "i", mimeType: "image/png" }],
    details: { exitCode: 1 },
  } } as never), [{
    sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "failed",
    content: [
      { type: "content", content: { type: "text", text: "failed" } },
      { type: "content", content: { type: "image", data: "i", mimeType: "image/png" } },
    ],
    rawOutput: { exitCode: 1 },
  }]);
  assert.deepEqual(replayEntry({ type: "message", message: {
    role: "bashExecution", command: "printf ok", output: "ok", exitCode: 7, truncated: true,
    fullOutputPath: "/tmp/full.log",
  } } as never), [{
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: "Ran `printf ok`\n```\nok\n```\n\nCommand exited with code 7\n\n[Output truncated. Full output: /tmp/full.log]",
    },
  }]);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "custom", display: true, content: "shown" } } as never), [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "shown" } },
  ]);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "custom", display: true, content: [
    { type: "text", text: "shown array" }, { type: "image", data: "i", mimeType: "image/png" },
  ] } } as never).map(({ sessionUpdate }) => sessionUpdate), ["agent_message_chunk", "agent_message_chunk"]);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "custom", display: false, content: "hidden" } } as never), []);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "branchSummary" } } as never), []);
  assert.deepEqual(replayEntry({ type: "message", message: { role: "compactionSummary" } } as never), []);
  assert.deepEqual(replayEntry({ type: "custom_message", content: "visible entry", display: true } as never), [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "visible entry" } },
  ]);
  assert.deepEqual(replayEntry({ type: "custom_message", content: [
    { type: "text", text: "entry array" }, { type: "image", data: "i", mimeType: "image/png" },
  ], display: true } as never).map(({ sessionUpdate }) => sessionUpdate), ["user_message_chunk", "user_message_chunk"]);
  assert.deepEqual(replayEntry({ type: "custom_message", content: "hidden", display: false } as never), []);
  for (const type of ["thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "label", "session_info"] as const) {
    assert.deepEqual(replayEntry({ type } as never), []);
  }
});

test("T8 SDK pre-handler owns malformed prompt row 8 without an adapter errorKind", async () => {
  const setup = fakeDeps();
  const pair = streamPair();
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = client({ name: "pi-acp-malformed-test" }).connect(pair.client);
  await assert.rejects(
    connection.agent.request(methods.agent.session.prompt, {
      sessionId: "not-open",
      prompt: [{ type: "image" }],
    } as never),
    (error) => {
      const requestError = error as RequestError;
      assert.equal(requestError.code, -32602);
      assert.equal(requestError.message, "Invalid params");
      assert.equal(
        typeof requestError.data === "object" && requestError.data !== null && "errorKind" in requestError.data,
        false,
      );
      return true;
    },
  );
  connection.close();
  server.connection.close();
  await server.agent.dispose();
});

test("T15 row 25: $/cancel_request during open returns -32800 and rolls the reservation back", async () => {
  const setup = fakeDeps();
  const id = "cancel-opening-id";
  const manager = SessionManager.create(setup.cwd, setup.sessionDir, { id });
  setup.deps.sessions.create = () => manager;
  const connectStarted = deferred<void>();
  setup.deps.connectMcpClient = async (_server, signal) => {
    connectStarted.resolve();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const pair = streamPair();
  const server = await runAcp({ deps: setup.deps, stream: pair.agent });
  const connection = client({ name: "pi-acp-open-cancel-test" }).connect(pair.client);
  const cancellation = new AbortController();
  const opening = connection.agent.request(methods.agent.session.new, {
    cwd: setup.cwd,
    mcpServers: [{ name: "hung", command: "hung", args: [], env: [] }],
  }, { cancellationSignal: cancellation.signal });
  await connectStarted.promise;
  cancellation.abort();
  await assert.rejects(opening, (error) => (error as RequestError).code === -32800);
  const retried = await connection.agent.request(methods.agent.session.new, {
    cwd: setup.cwd,
    mcpServers: [],
  });
  assert.equal(retried.sessionId, id);
  await connection.agent.request(methods.agent.session.close, { sessionId: id });
  connection.close();
  server.connection.close();
  await server.agent.dispose();
});

test("T15 close and dispose abort opening transactions without resurrection or post-dispose commit", async () => {
  {
    const setup = fakeDeps();
    const id = "close-opening-id";
    const manager = SessionManager.create(setup.cwd, setup.sessionDir, { id });
    setup.deps.sessions.create = () => manager;
    const started = deferred<void>();
    setup.deps.connectMcpClient = async (_server, signal) => {
      started.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const agent = new PiAcpAgent(setup.deps);
    const opening = agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "hung", command: "hung", args: [], env: [] }],
    }));
    await started.promise;
    assert.deepEqual(await agent.closeSession(context({ sessionId: id })), {});
    await assert.rejects(opening);
    const retried = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
    assert.equal(retried.sessionId, id);
    await agent.closeSession(context({ sessionId: id }));
  }

  {
    const setup = fakeDeps();
    const id = "dispose-opening-id";
    const manager = SessionManager.create(setup.cwd, setup.sessionDir, { id });
    setup.deps.sessions.create = () => manager;
    const started = deferred<void>();
    setup.deps.connectMcpClient = async (_server, signal) => {
      started.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const agent = new PiAcpAgent(setup.deps);
    const opening = agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "hung", command: "hung", args: [], env: [] }],
    }));
    await started.promise;
    await agent.dispose();
    await assert.rejects(opening);
    assert.equal(setup.controls.length, 0);
    assert.throws(
      () => agent.newSession(context({ cwd: setup.cwd, mcpServers: [] })),
      (error) => errorKind(error) === "internal_error",
    );
  }
});

test("T14/T15 close waits for prompt settlement; busy mutations reject; disposal failure stays successful", async () => {
  const setup = fakeDeps("wedged");
  const notifications: Array<SessionUpdate | "dispose"> = [];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context(
    { cwd: setup.cwd, mcpServers: [] },
    { notify: async (_method, params: unknown) => {
      notifications.push((params as { update: SessionUpdate }).update);
    } },
  ));
  const pending = agent.prompt(context({
    sessionId: opened.sessionId,
    prompt: [{ type: "text", text: "hang" }],
  }));
  await Promise.resolve();
  await assert.rejects(
    agent.setConfigOption(context({ sessionId: opened.sessionId, configId: "thinkingLevel", value: "high" })),
    (error) => errorKind(error) === "session_busy",
  );
  assert.throws(
    () => agent.forkSession(context({ cwd: setup.cwd, sessionId: opened.sessionId, mcpServers: [] })),
    (error) => errorKind(error) === "session_busy",
  );
  const originalDispose = setup.controls[0]?.session.dispose.bind(setup.controls[0]?.session);
  if (!setup.controls[0] || !originalDispose) throw new Error("missing fake session control");
  setup.controls[0].session.dispose = () => {
    notifications.push("dispose");
    originalDispose();
    throw new Error("injected dispose failure");
  };
  const closing = agent.closeSession(context({ sessionId: opened.sessionId }));
  setup.controls[0].resolvePrompt?.();
  assert.equal((await pending).stopReason, "cancelled");
  assert.deepEqual(await closing, {});
  assert.ok(notifications.findIndex((item) => item !== "dispose" && item.sessionUpdate === "usage_update") >= 0);
  assert.ok(
    notifications.findIndex((item) => item !== "dispose" && item.sessionUpdate === "usage_update") < notifications.indexOf("dispose"),
  );
  assert.throws(
    () => agent.prompt(context({ sessionId: opened.sessionId, prompt: [{ type: "text", text: "closed" }] })),
    (error) => errorKind(error) === "unknown_session",
  );
  assert.deepEqual(await agent.closeSession(context({ sessionId: opened.sessionId })), {});
  assert.deepEqual(await agent.closeSession(context({ sessionId: "unknown" })), {});

  const invalid = fakeDeps();
  const invalidAgent = new PiAcpAgent(invalid.deps);
  assert.throws(
    () => invalidAgent.newSession(context({ cwd: "relative", mcpServers: [] })),
    (error) => errorKind(error) === "invalid_cwd",
  );
  assert.throws(
    () => invalidAgent.loadSession(context({ cwd: "relative", sessionId: "x", mcpServers: [] })),
    (error) => errorKind(error) === "invalid_cwd",
  );
  assert.throws(
    () => invalidAgent.resumeSession(context({ cwd: "relative", sessionId: "x", mcpServers: [] })),
    (error) => errorKind(error) === "invalid_cwd",
  );
  assert.throws(
    () => invalidAgent.forkSession(context({ cwd: "relative", sessionId: "x", mcpServers: [] })),
    (error) => errorKind(error) === "invalid_cwd",
  );
  await assert.rejects(
    invalidAgent.listSessions(context({ cwd: "relative" })),
    (error) => errorKind(error) === "invalid_cwd",
  );
  await assert.rejects(
    invalidAgent.loadSession(context({ cwd: invalid.cwd, sessionId: "missing", mcpServers: [] })),
    (error) => errorKind(error) === "unknown_session",
  );
  await assert.rejects(
    invalidAgent.resumeSession(context({ cwd: invalid.cwd, sessionId: "missing", mcpServers: [] })),
    (error) => errorKind(error) === "unknown_session",
  );
  await invalidAgent.dispose();
});

test("T15b rollback releases every resource after MCP, factory, wrapper, and replay failures", async () => {
  {
    const setup = fakeDeps();
    const id = "mcp-stage-id";
    setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
    let connects = 0;
    let closes = 0;
    setup.deps.connectMcpClient = async () => {
      connects += 1;
      if (connects === 2) throw new Error("second MCP connect failed");
      return fakeMcpHandle({ async close() { closes += 1; } });
    };
    const agent = new PiAcpAgent(setup.deps);
    await assert.rejects(agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [
        { name: "first", command: "first", args: [], env: [] },
        { name: "second", command: "second", args: [], env: [] },
      ],
    })), (error) => errorKind(error) === "mcp_init_error");
    assert.equal(closes, 1);
    assert.equal(setup.controls.length, 0);
    assert.equal((await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }))).sessionId, id);
    await agent.dispose();
  }

  {
    const setup = fakeDeps();
    const id = "factory-stage-id";
    setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
    let closes = 0;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({ async close() { closes += 1; } });
    const realCreate = setup.deps.createAgentSession;
    let fail = true;
    setup.deps.createAgentSession = async (options) => {
      if (fail) {
        fail = false;
        throw new Error("factory stage failed");
      }
      return realCreate(options);
    };
    const agent = new PiAcpAgent(setup.deps);
    await assert.rejects(agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "connected", command: "connected", args: [], env: [] }],
    })), (error) => errorKind(error) === "internal_error");
    assert.equal(closes, 1);
    assert.equal((await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }))).sessionId, id);
    await agent.dispose();
  }

  {
    const setup = fakeDeps();
    const id = "wrapper-stage-id";
    setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
    let closes = 0;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({ async close() { closes += 1; } });
    const realCreate = setup.deps.createAgentSession;
    let failedControl: ReturnType<typeof fakeSession> | undefined;
    setup.deps.createAgentSession = async (options) => {
      if (!failedControl) {
        const created = fakeCreateResult(options);
        failedControl = created.control;
        Object.defineProperty(created.control.session.agent, "beforeToolCall", {
          configurable: true,
          get: () => undefined,
          set: () => { throw new Error("wrapper install failed"); },
        });
        return created.result;
      }
      return realCreate(options);
    };
    const agent = new PiAcpAgent(setup.deps);
    await assert.rejects(agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "connected", command: "connected", args: [], env: [] }],
    })), (error) => errorKind(error) === "internal_error");
    assert.equal(failedControl?.abortCalls, 1);
    assert.equal(failedControl?.disposeCalls, 1);
    assert.equal(failedControl?.listenerCount, 0);
    assert.equal(closes, 1);
    assert.equal((await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }))).sessionId, id);
    await agent.dispose();
  }

  {
    const setup = fakeDeps();
    const id = "replay-stage-id";
    const manager = {
      getSessionId: () => id,
      getBranch: () => [{ type: "message", message: { role: "user", content: "replay me" } }],
      getSessionFile: () => `${setup.sessionDir}/replay.jsonl`,
    } as never;
    setup.deps.sessions.list = async () => [{
      path: "replay-path", id, cwd: setup.cwd, created: new Date(), modified: new Date(),
      messageCount: 1, firstMessage: "replay me", allMessagesText: "replay me",
    }];
    setup.deps.sessions.open = () => manager;
    let closes = 0;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({ async close() { closes += 1; } });
    const agent = new PiAcpAgent(setup.deps);
    await assert.rejects(agent.loadSession(context(
      {
        cwd: setup.cwd,
        sessionId: id,
        mcpServers: [{ name: "connected", command: "connected", args: [], env: [] }],
      },
      { notify: async () => { throw new Error("replay notification failed"); } },
    )), (error) => errorKind(error) === "notification_error");
    assert.equal(setup.controls[0]?.disposeCalls, 1);
    assert.equal(setup.controls[0]?.listenerCount, 0);
    assert.equal(closes, 1);
    const retried = await agent.loadSession(context({ cwd: setup.cwd, sessionId: id, mcpServers: [] }));
    assert.ok(retried.configOptions.length > 0);
    await agent.dispose();
  }
});

test("A4 failed-open abort deadline overrides the opening error and hidden ownership retries", async () => {
  const setup = fakeDeps();
  const id = "failed-open-hidden-cleanup";
  setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
  let sleeps = 0;
  setup.deps.sleep = async () => {
    sleeps += 1;
    if (sleeps === 1) return;
    return new Promise<void>(() => undefined);
  };
  let control: ReturnType<typeof fakeSession> | undefined;
  let abortAttempts = 0;
  setup.deps.createAgentSession = async (options) => {
    const created = fakeCreateResult(options);
    control = created.control;
    (created.control.session as unknown as { abort(): Promise<void> }).abort = async () => {
      abortAttempts += 1;
      if (abortAttempts === 1) await new Promise<void>(() => undefined);
    };
    Object.defineProperty(created.control.session.agent, "beforeToolCall", {
      configurable: true,
      get: () => undefined,
      set: () => { throw new Error("wrapper install failed before publication"); },
    });
    return created.result;
  };
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(
    agent.newSession(context({ cwd: setup.cwd, mcpServers: [] })),
    (error: { data?: { errorKind?: unknown; details?: { remainingChildren?: unknown } } }) =>
      error.data?.errorKind === "child_cleanup_error" && error.data.details?.remainingChildren === 0,
  );
  assert.equal(control?.disposeCalls, 1, "non-child failed-open resources dispose only once");
  assert.equal(abortAttempts, 1);
  await agent.closeSession(context({ sessionId: id }));
  assert.equal(abortAttempts, 2, "hidden failed-open owner retries the abort/liveness generation");
  assert.equal(control?.disposeCalls, 1);
  await agent.dispose();
});

test("A4 new/load/resume/fork preserve every representative open error unless cleanup fails", { timeout: 30_000 }, async () => {
  const methodsUnderTest = ["new", "load", "resume", "fork"] as const;
  const outcomes = [
    { name: "cancel", code: -32800, kind: undefined, error: () => RequestError.requestCancelled() },
    { name: "mcp", code: -32603, kind: "mcp_init_error", error: () => adapterError("mcp_init_error", { server: "second" }) },
    { name: "extension", code: -32603, kind: "extension_setup_error", error: () => adapterError("extension_setup_error") },
    { name: "replay-other", code: -32603, kind: "session_corrupt", error: () => adapterError("session_corrupt") },
  ] as const;

  for (const openingMethod of methodsUnderTest) {
    for (const outcome of outcomes) {
      for (const cleanupFails of [false, true]) {
        const setup = fakeDeps();
        const source = SessionManager.create(setup.cwd, setup.sessionDir, { id: `a4-${openingMethod}-${outcome.name}-source` });
        source.appendMessage({ role: "user", content: "source", timestamp: 1 } as never);
        source.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        } as never);
        const events: string[] = [];
        setup.deps.connectMcpClient = async (server) => fakeMcpHandle({
          close() { events.push(`mcp-close:${server.name}`); return Promise.resolve(); },
        });
        const realCreate = setup.deps.createAgentSession;
        let abortAttempts = 0;
        setup.deps.createAgentSession = async (options) => {
          const result = await realCreate(options);
          const control = setup.controls.at(-1)!;
          control.session.abort = async () => {
            abortAttempts += 1;
            events.push(`pi-abort:${abortAttempts}`);
            if (cleanupFails && abortAttempts === 1) throw new Error("injected cleanup failure");
          };
          return result;
        };
        setup.deps.modelRuntime.getAvailable = async () => { throw outcome.error(); };
        const agent = new PiAcpAgent(setup.deps);
        const request = {
          cwd: setup.cwd,
          mcpServers: [
            { name: "first", command: "fixture", args: [], env: [] },
            { name: "second", command: "fixture", args: [], env: [] },
          ],
        };
        const opening = openingMethod === "new"
          ? agent.newSession(context(request))
          : openingMethod === "load"
            ? agent.loadSession(context({ ...request, sessionId: source.getSessionId() }))
            : openingMethod === "resume"
              ? agent.resumeSession(context({ ...request, sessionId: source.getSessionId() }))
              : agent.forkSession(context({ ...request, sessionId: source.getSessionId() }));
        await assert.rejects(opening, (error: RequestError) => {
          if (cleanupFails) {
            assert.equal(error.code, -32603, `${openingMethod}/${outcome.name}`);
            assert.deepEqual(error.data, {
              errorKind: "child_cleanup_error",
              message: "child process cleanup failed",
              details: { remainingChildren: 0 },
            });
          } else {
            assert.equal(error.code, outcome.code, `${openingMethod}/${outcome.name}`);
            assert.equal(errorKind(error), outcome.kind, `${openingMethod}/${outcome.name}`);
          }
          return true;
        });
        assert.deepEqual(events.slice(0, 3), ["mcp-close:second", "mcp-close:first", "pi-abort:1"],
          `${openingMethod}/${outcome.name} starts reverse MCP closes before Pi abort`);
        assert.equal(setup.controls[0]!.disposeCalls, 1);

        if (cleanupFails && (openingMethod === "load" || openingMethod === "resume")) {
          await agent.closeSession(context({ sessionId: source.getSessionId() }));
        } else {
          await agent.dispose();
        }
        if (cleanupFails) {
          assert.equal(abortAttempts, 2, `${openingMethod}/${outcome.name} retained cleanup owner retries`);
          await agent.dispose();
        } else {
          assert.equal(abortAttempts, 1);
        }
        assert.equal(setup.controls[0]!.disposeCalls, 1, "non-child resources remain memoized");
      }
    }
  }
});

test("M8 fork MCP failure occurs before forkFrom and leaves no target journal", async () => {
  const setup = fakeDeps();
  const source = SessionManager.create(setup.cwd, setup.sessionDir, { id: "fork-preconnect-source" });
  source.appendMessage({ role: "user", content: "source", timestamp: Date.now() } as never);
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  const sourcePath = source.getSessionFile();
  assert.ok(sourcePath);
  setup.deps.sessions.listAll = async () => [{
    path: sourcePath,
    id: source.getSessionId(),
    cwd: setup.cwd,
    created: new Date(),
    modified: new Date(),
    messageCount: 2,
    firstMessage: "source",
    allMessagesText: "source answer",
  }];
  let forkCalls = 0;
  setup.deps.sessions.forkFrom = () => {
    forkCalls += 1;
    throw new Error("forkFrom must not run");
  };
  setup.deps.connectMcpClient = async () => { throw new Error("MCP connect failed"); };
  const before = readdirSync(setup.sessionDir).sort();
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(agent.forkSession(context({
    cwd: setup.cwd,
    sessionId: source.getSessionId(),
    mcpServers: [{ name: "fails-before-write", command: "fixture", args: [], env: [] }],
  })), (error) => errorKind(error) === "mcp_init_error");
  assert.equal(forkCalls, 0);
  assert.deepEqual(readdirSync(setup.sessionDir).sort(), before);
  await agent.dispose();
});

test("M8 fork cancellation after MCP preparation closes the owner before any journal write", async () => {
  const setup = fakeDeps();
  const source = SessionManager.create(setup.cwd, setup.sessionDir, { id: "fork-cancel-source" });
  source.appendMessage({ role: "user", content: "source", timestamp: 1 } as never);
  const sourcePath = source.getSessionFile();
  assert.ok(sourcePath);
  setup.deps.sessions.listAll = async () => [{
    path: sourcePath,
    id: source.getSessionId(),
    cwd: setup.cwd,
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "source",
    allMessagesText: "source",
  }];
  const request = new AbortController();
  let forkCalls = 0;
  let closes = 0;
  setup.deps.sessions.forkFrom = () => {
    forkCalls += 1;
    throw new Error("forkFrom must not run after cancellation");
  };
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() {
      request.abort(new Error("cancel after MCP preparation"));
      return { tools: [] };
    },
    close() { closes += 1; return Promise.resolve(); },
  });
  const before = readdirSync(setup.sessionDir).sort();
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(agent.forkSession(context({
    cwd: setup.cwd,
    sessionId: source.getSessionId(),
    mcpServers: [{ name: "prepared", command: "fixture", args: [], env: [] }],
  }, undefined, request.signal)));
  assert.equal(forkCalls, 0);
  assert.equal(closes, 1);
  assert.deepEqual(readdirSync(setup.sessionDir).sort(), before);
  await agent.dispose();
});

test("T15b irreversible fork failure leaves a complete listable and loadable journal without live leaks", async () => {
  const setup = fakeDeps();
  const sourceCwd = mkdtempSync(`${tmpdir()}/pi-acp-fork-source-`);
  const source = SessionManager.create(sourceCwd, setup.sessionDir, { id: "fork-source-id" });
  source.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() } as never);
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source answer" }],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  const sourcePath = source.getSessionFile();
  if (!sourcePath || !existsSync(sourcePath)) throw new Error("source journal was not persisted");
  setup.deps.sessions.listAll = async () => [{
    path: sourcePath,
    id: source.getSessionId(),
    cwd: sourceCwd,
    created: new Date(),
    modified: new Date(),
    messageCount: 2,
    firstMessage: "source prompt",
    allMessagesText: "source prompt source answer",
  }];
  let forked: SessionManager | undefined;
  setup.deps.sessions.forkFrom = (path, cwd, dir, options) => {
    forked = SessionManager.forkFrom(path, cwd, dir, options);
    return forked;
  };
  let closes = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({ async close() { closes += 1; } });
  const realCreate = setup.deps.createAgentSession;
  let fail = true;
  setup.deps.createAgentSession = async (options) => {
    if (fail) {
      fail = false;
      throw new Error("post-fork factory failure");
    }
    return realCreate(options);
  };
  const agent = new PiAcpAgent(setup.deps);
  await assert.rejects(agent.forkSession(context({
    cwd: setup.cwd,
    sessionId: source.getSessionId(),
    mcpServers: [{ name: "connected", command: "connected", args: [], env: [] }],
  })), (error) => errorKind(error) === "internal_error");
  assert.ok(closes >= 1);
  if (!forked) throw new Error("fork manager was not created");
  const forkPath = forked.getSessionFile();
  if (!forkPath || !existsSync(forkPath)) throw new Error("fork journal was not retained");
  const records = readFileSync(forkPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
  assert.ok(records.length >= 3);
  const reopened = SessionManager.open(forkPath, setup.sessionDir);
  assert.equal(reopened.getBranch().length, source.getBranch().length);
  const listed = await SessionManager.list(setup.cwd, setup.sessionDir);
  assert.ok(listed.some(({ id }) => id === forked?.getSessionId()));
  const loaded = await agent.loadSession(context({
    cwd: setup.cwd,
    sessionId: forked.getSessionId(),
    mcpServers: [],
  }));
  assert.ok(loaded.configOptions.length > 0);
  await agent.dispose();
});

test("T16/T19 cross-cwd fork round-trips and additionalDirectories stay ignored on every opening method", async () => {
  const setup = fakeDeps();
  const sourceCwd = mkdtempSync(`${tmpdir()}/pi-acp-cross-source-`);
  const source = SessionManager.create(sourceCwd, setup.sessionDir, { id: "cross-source-id" });
  source.appendMessage({ role: "user", content: "cross prompt", timestamp: Date.now() } as never);
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "cross answer" }],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  const sourcePath = source.getSessionFile();
  if (!sourcePath) throw new Error("cross-cwd source was not persisted");

  const newManager = SessionManager.create(setup.cwd, setup.sessionDir, { id: "additional-new-id" });
  setup.deps.sessions.create = () => newManager;
  const reattachManager = {
    getSessionId: () => "additional-reattach-id",
    getBranch: () => [],
    getSessionFile: () => `${setup.sessionDir}/additional-reattach.jsonl`,
  } as never;
  setup.deps.sessions.list = async (_cwd) => [{
    path: "additional-reattach-path", id: "additional-reattach-id", cwd: setup.cwd,
    created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "prior", allMessagesText: "prior",
  }];
  setup.deps.sessions.open = () => reattachManager;
  setup.deps.sessions.listAll = async () => [{
    path: sourcePath,
    id: source.getSessionId(),
    cwd: sourceCwd,
    created: new Date(),
    modified: new Date(),
    messageCount: 2,
    firstMessage: "cross prompt",
    allMessagesText: "cross prompt cross answer",
  }];
  let forkTarget: string | undefined;
  const realFork = setup.deps.sessions.forkFrom;
  setup.deps.sessions.forkFrom = (path, target, dir, options) => {
    forkTarget = target;
    return realFork(path, target, dir, options);
  };

  const additionalDirectories = [sourceCwd];
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({
    cwd: setup.cwd, mcpServers: [], additionalDirectories,
  }));
  await agent.closeSession(context({ sessionId: opened.sessionId }));
  await agent.loadSession(context({
    cwd: setup.cwd, sessionId: "additional-reattach-id", mcpServers: [], additionalDirectories,
  }));
  await agent.closeSession(context({ sessionId: "additional-reattach-id" }));
  await agent.resumeSession(context({
    cwd: setup.cwd, sessionId: "additional-reattach-id", mcpServers: [], additionalDirectories,
  }));
  await agent.closeSession(context({ sessionId: "additional-reattach-id" }));
  const forked = await agent.forkSession(context({
    cwd: setup.cwd, sessionId: source.getSessionId(), mcpServers: [], additionalDirectories,
  }));
  assert.equal(forkTarget, setup.cwd);
  assert.notEqual(forked.sessionId, source.getSessionId());
  assert.equal(setup.createOptions.length, 4);
  for (const options of setup.createOptions) {
    assert.equal("additionalDirectories" in options, false);
    assert.equal(options.modelRuntime, setup.deps.modelRuntime);
  }
  await agent.dispose();
});

test("T20 MCP duplicate names, timeouts, detached late failures, and 128-char suffixes are bounded", async () => {
  const setup = fakeDeps();
  const server = { name: "server", command: "server", args: [], env: [] } as const;
  await assert.rejects(
    bridgeMcpServers([server, server], new AbortController().signal, setup.deps),
    (error) => errorKind(error) === "mcp_init_error",
  );

  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    setup.deps.sleep = async (_ms, signal) => {
      if (signal.aborted) throw signal.reason;
    };

    const lateConnect = deferred<never>();
    setup.deps.connectMcpClient = () => lateConnect.promise;
    await assert.rejects(
      bridgeMcpServers([server], new AbortController().signal, setup.deps),
      (error) => errorKind(error) === "mcp_init_error",
    );
    lateConnect.reject(new Error("late connect rejection"));

    const lateList = deferred<never>();
    let listCloseCalls = 0;
    let listBoundedCall = 0;
    setup.deps.sleep = (_ms, signal) => {
      listBoundedCall += 1;
      if (listBoundedCall === 2) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      listTools() { return lateList.promise; },
      async close() { listCloseCalls += 1; },
    });
    await assert.rejects(
      bridgeMcpServers([server], new AbortController().signal, setup.deps),
      (error) => errorKind(error) === "mcp_init_error",
    );
    assert.equal(listCloseCalls, 1);
    lateList.reject(new Error("late list rejection"));

    let boundedCall = 0;
    setup.deps.sleep = (_ms, signal) => {
      boundedCall += 1;
      if (boundedCall === 3) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const lateCall = deferred<never>();
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      async listTools() {
        return { tools: [{ name: "slow", inputSchema: { type: "object" } }] };
      },
      callTool() { return lateCall.promise; },
    });
    const bridge = await bridgeMcpServers([server], new AbortController().signal, setup.deps);
    await assert.rejects(
      bridge.tools[0]?.execute("call", {}, new AbortController().signal),
      /^Error: MCP tool mcp__server__slow timed out$/,
    );
    lateCall.reject(new Error("late call rejection"));
    await setImmediatePromise();
    assert.deepEqual(unhandled, []);
    await bridge.clients[0]?.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  const aliases = new Set<string>();
  const exactBoundaryTool = "x".repeat(120);
  const first = (await import("../src/mcp-bridge.js")).allocateAlias("s", exactBoundaryTool, aliases);
  const second = (await import("../src/mcp-bridge.js")).allocateAlias("s", exactBoundaryTool, aliases);
  assert.equal(first.length, 128);
  assert.equal(second.length, 128);
  assert.match(second, /_2$/);
});

test("T20 a timed-out real stdio connect kills its spawned child and lifecycle rollback is retryable", async () => {
  const setup = fakeDeps();
  const id = "hung-child-id";
  const timeoutClock = deferred<void>();
  setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
  setup.deps.mcpTimeoutMs = 1_000;
  setup.deps.sleep = gatedRealSleep(1_000, timeoutClock.promise);
  setup.deps.connectMcpClient = (server, signal) => connectDefaultMcpClient(
    server,
    signal,
    300,
    gatedRealSleep(300, timeoutClock.promise),
  );
  const pidPath = `${setup.sessionDir}/hung-mcp.pid`;
  const childScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  const agent = new PiAcpAgent(setup.deps);
  const rejection = assert.rejects(agent.newSession(context({
    cwd: setup.cwd,
    mcpServers: [{
      name: "hung-child",
      command: process.execPath,
      args: ["-e", childScript, pidPath],
      env: [],
    }],
  })), (error) => errorKind(error) === "mcp_init_error");
  for (let attempt = 0; attempt < 500 && !existsSync(pidPath); attempt += 1) {
    await realSleep(10, new AbortController().signal);
  }
  assert.equal(existsSync(pidPath), true);
  const pid = Number(readFileSync(pidPath, "utf8"));
  timeoutClock.resolve();
  await rejection;
  // The pinned stdio transport owns escalation: it first gives the child its
  // transport grace and then issues SIGKILL.  The adapter must not pre-kill it.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      process.kill(pid, 0);
      await realSleep(10, new AbortController().signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
      throw error;
    }
  }
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  assert.equal((await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }))).sessionId, id);
  await agent.dispose();
});

test("T20 missing injected aliases roll back and isError/hung calls become fixed failed tool updates", async () => {
  {
    const setup = fakeDeps();
    const id = "missing-alias-id";
    setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
    let closes = 0;
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      async listTools() { return { tools: [{ name: "missing", inputSchema: { type: "object" } }] }; },
      async close() { closes += 1; },
    });
    const realCreate = setup.deps.createAgentSession;
    let failedControl: ReturnType<typeof fakeSession> | undefined;
    setup.deps.createAgentSession = async (options) => {
      if (!failedControl) {
        const created = fakeCreateResult(options);
        failedControl = created.control;
        const getAllTools = created.control.session.getAllTools.bind(created.control.session);
        created.control.session.getAllTools = () => getAllTools().filter(({ name }) => !name.startsWith("mcp__"));
        return created.result;
      }
      return realCreate(options);
    };
    const agent = new PiAcpAgent(setup.deps);
    await assert.rejects(agent.newSession(context({
      cwd: setup.cwd,
      mcpServers: [{ name: "server", command: "server", args: [], env: [] }],
    })), (error) => errorKind(error) === "mcp_init_error");
    assert.equal(failedControl?.disposeCalls, 1);
    assert.equal(failedControl?.listenerCount, 0);
    assert.equal(closes, 1);
    assert.equal((await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }))).sessionId, id);
    await agent.dispose();
  }

  for (const mode of ["isError", "timeout"] as const) {
    const setup = fakeDeps("tool");
    const id = `failed-tool-${mode}`;
    setup.deps.sessions.create = () => SessionManager.create(setup.cwd, setup.sessionDir, { id });
    const late = deferred<never>();
    if (mode === "timeout") {
      let boundedCall = 0;
      setup.deps.sleep = (_ms, signal) => {
        boundedCall += 1;
        if (boundedCall === 3) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
    }
    setup.deps.connectMcpClient = async () => fakeMcpHandle({
      async listTools() { return { tools: [{ name: "remote", inputSchema: { type: "object" } }] }; },
      callTool() {
        if (mode === "timeout") return late.promise;
        return Promise.resolve({ content: [{ type: "text", text: "remote tool error detail" }], isError: true });
      },
    });
    const updates: SessionUpdate[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const agent = new PiAcpAgent(setup.deps);
      const opened = await agent.newSession(context(
        {
          cwd: setup.cwd,
          mcpServers: [{ name: "server", command: "server", args: [], env: [] }],
        },
        { notify: async (_method, params: unknown) => {
          updates.push((params as { update: SessionUpdate }).update);
        } },
      ));
      assert.equal((await agent.prompt(context({
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: "use the tool" }],
      }))).stopReason, "end_turn");
      const failed = updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "failed");
      assert.ok(failed && failed.sessionUpdate === "tool_call_update");
      const failedText = JSON.stringify(failed.content);
      assert.match(failedText, mode === "timeout" ? /timed out/ : /remote tool error detail/);
      if (mode === "isError") assert.doesNotMatch(failedText, /returned an error result/);
      if (mode === "timeout") late.reject(new Error("late tools/call rejection"));
      await setImmediatePromise();
      assert.deepEqual(unhandled, []);
      if (mode === "timeout") setup.deps.sleep = realSleep;
      await agent.dispose();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }
});

test("T20 tools/call round-trips through new, load, resume, and fork with shared modelRuntime identity", async () => {
  const setup = fakeDeps("tool");
  let callCount = 0;
  setup.deps.connectMcpClient = async () => fakeMcpHandle({
    async listTools() { return { tools: [{ name: "roundtrip", inputSchema: { type: "object" } }] }; },
    async callTool() {
      callCount += 1;
      return { content: [{ type: "text", text: "roundtrip ok" }], structuredContent: { ok: true } };
    },
  });
  const newManager = SessionManager.create(setup.cwd, setup.sessionDir, { id: "tool-new-id" });
  setup.deps.sessions.create = () => newManager;
  const reattachManager = {
    getSessionId: () => "tool-reattach-id",
    getBranch: () => [],
    getSessionFile: () => `${setup.sessionDir}/tool-reattach.jsonl`,
  } as never;
  setup.deps.sessions.list = async () => [{
    path: "tool-reattach-path", id: "tool-reattach-id", cwd: setup.cwd,
    created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "tool", allMessagesText: "tool",
  }];
  setup.deps.sessions.open = () => reattachManager;
  setup.deps.sessions.listAll = async () => [{
    path: "tool-source-path", id: "tool-source-id", cwd: setup.cwd,
    created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "source", allMessagesText: "source",
  }];
  setup.deps.sessions.forkFrom = () => ({
    getSessionId: () => "tool-fork-id",
    getBranch: () => [],
    getSessionFile: () => `${setup.sessionDir}/tool-fork.jsonl`,
  }) as never;
  const mcpServers = [{ name: "server", command: "server", args: [], env: [] }];
  const agent = new PiAcpAgent(setup.deps);

  const openedNew = await agent.newSession(context({ cwd: setup.cwd, mcpServers }));
  await agent.prompt(context({ sessionId: openedNew.sessionId, prompt: [{ type: "text", text: "new" }] }));
  await agent.closeSession(context({ sessionId: openedNew.sessionId }));

  await agent.loadSession(context({ cwd: setup.cwd, sessionId: "tool-reattach-id", mcpServers }));
  await agent.prompt(context({ sessionId: "tool-reattach-id", prompt: [{ type: "text", text: "load" }] }));
  await agent.closeSession(context({ sessionId: "tool-reattach-id" }));

  await agent.resumeSession(context({ cwd: setup.cwd, sessionId: "tool-reattach-id", mcpServers }));
  await agent.prompt(context({ sessionId: "tool-reattach-id", prompt: [{ type: "text", text: "resume" }] }));
  await agent.closeSession(context({ sessionId: "tool-reattach-id" }));

  const forked = await agent.forkSession(context({ cwd: setup.cwd, sessionId: "tool-source-id", mcpServers }));
  await agent.prompt(context({ sessionId: forked.sessionId, prompt: [{ type: "text", text: "fork" }] }));
  assert.equal(callCount, 4);
  assert.equal(setup.createOptions.length, 4);
  for (const options of setup.createOptions) {
    assert.equal(options.modelRuntime, setup.deps.modelRuntime);
    assert.ok(options.resourceLoader?.getExtensions().extensions
      .some((extension) => extension.tools.has("mcp__server__roundtrip")));
  }
  await agent.dispose();
});

test("T22 each cooperative abort source drains before settling once and preserves the mode boundary", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const source of ["request-signal", "session-cancel", "session-close"] as const) {
      const setup = fakeDeps("wedged");
      let fire: (() => void) | undefined;
      setup.deps.sleep = (_ms, signal) => new Promise<void>((resolve, reject) => {
        fire = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const updates: SessionUpdate[] = [];
      const agent = new PiAcpAgent(setup.deps);
      const opened = await agent.newSession(context(
        { cwd: setup.cwd, mcpServers: [] },
        { notify: async (_method, params: unknown) => {
          updates.push((params as { update: SessionUpdate }).update);
        } },
      ));
      const requestController = new AbortController();
      const pending = agent.prompt(context(
        { sessionId: opened.sessionId, prompt: [{ type: "text", text: "wedged" }] },
        undefined,
        requestController.signal,
      ));
      await Promise.resolve();
      let closing: Promise<unknown> | undefined;
      if (source === "request-signal") requestController.abort();
      else if (source === "session-cancel") agent.cancel(context({ sessionId: opened.sessionId }) as never);
      else closing = agent.closeSession(context({ sessionId: opened.sessionId }));
      assert.equal(typeof fire, "function");
      assert.equal((await pending).stopReason, "cancelled", source);
      if (closing) assert.deepEqual(await closing, {});
      await setImmediatePromise();
      assert.equal(updates.filter(({ sessionUpdate }) => sessionUpdate === "usage_update").length, 1, source);
      assert.equal(
        (setup.controls[0]?.disposeCalls ?? 0) >= 1,
        source === "session-close",
        source,
      );
      setup.controls[0]?.rejectPrompt?.(new Error(`late pi rejection: ${source}`));
      await setImmediatePromise();
      assert.deepEqual(unhandled, [], source);
      assert.deepEqual(await agent.closeSession(context({ sessionId: opened.sessionId })), {});
      await agent.dispose();
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("T22 notify failure wins settlement after successful abort cleanup with no usage or unhandled rejection", async () => {
  const setup = fakeDeps("wedged");
  let fire: (() => void) | undefined;
  setup.deps.sleep = (_ms, signal) => new Promise<void>((resolve, reject) => {
    fire = resolve;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const delivered: SessionUpdate[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const agent = new PiAcpAgent(setup.deps);
    const opened = await agent.newSession(context(
      { cwd: setup.cwd, mcpServers: [] },
      { notify: async (_method, params: unknown) => {
        delivered.push((params as { update: SessionUpdate }).update);
        throw new Error("notification transport failed");
      } },
    ));
    const pending = agent.prompt(context({
      sessionId: opened.sessionId,
      prompt: [{ type: "text", text: "wedged notification" }],
    }));
    setup.controls[0]?.emit({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial: {} as never,
      },
    });
    await assert.rejects(pending, (error) => errorKind(error) === "notification_error");
    assert.equal(delivered.filter(({ sessionUpdate }) => sessionUpdate === "usage_update").length, 0);
    assert.equal(typeof fire, "function");
    await setImmediatePromise();
    assert.equal(setup.controls[0]?.disposeCalls, 0);
    setup.controls[0]?.rejectPrompt?.(new Error("late notify-failure pi rejection"));
    await setImmediatePromise();
    assert.deepEqual(unhandled, []);
    assert.equal(delivered.filter(({ sessionUpdate }) => sessionUpdate === "usage_update").length, 0);
    setup.deps.sleep = realSleep;
    await agent.dispose();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("T22 non-wedged abort settles cooperatively and cancels the backstop without tombstoning", async () => {
  const setup = fakeDeps("wedged");
  let sleepStarted = false;
  let sleepCancelled = false;
  setup.deps.sleep = (_ms, signal) => new Promise<void>((_resolve, reject) => {
    sleepStarted = true;
    signal.addEventListener("abort", () => {
      sleepCancelled = true;
      reject(signal.reason);
    }, { once: true });
  });
  const agent = new PiAcpAgent(setup.deps);
  const opened = await agent.newSession(context({ cwd: setup.cwd, mcpServers: [] }));
  const cancellation = new AbortController();
  const pending = agent.prompt(context(
    { sessionId: opened.sessionId, prompt: [{ type: "text", text: "cooperative" }] },
    undefined,
    cancellation.signal,
  ));
  cancellation.abort();
  assert.equal(sleepStarted, true);
  setup.controls[0]?.resolvePrompt?.();
  assert.equal((await pending).stopReason, "cancelled");
  await setImmediatePromise();
  assert.equal(sleepCancelled, true);
  assert.equal(setup.controls[0]?.disposeCalls, 0);
  const configured = await agent.setConfigOption(context({
    sessionId: opened.sessionId,
    configId: "thinkingLevel",
    value: "high",
  }));
  assert.equal(configured.configOptions[0]?.currentValue, "high");
  await agent.closeSession(context({ sessionId: opened.sessionId }));
});
