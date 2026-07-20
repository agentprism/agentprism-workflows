import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  extensionMethod?: string;
  params?: {
    sessionId?: string;
    configId?: string;
    value?: unknown;
  };
}

test("generic custom request and notification preserve exact types, methods, params, and response", async () => {
  const { cwd, readLog } = configure({
    extensionRequest: {
      method: "example.test/echo",
      response: { echoed: "exact", count: 2 },
    },
    turns: [{ text: "unused" }],
  });
  const session = await makeRunner().openSession({ model: "codex", cwd });

  const response = await session.request<
    { echoed: string; count: number },
    { text: string; values: number[] }
  >("example.test/echo", { text: "Exact Case", values: [1, 2] });
  assert.deepEqual(response, { echoed: "exact", count: 2 });

  await session.notify<{ enabled: boolean; label: string }>(
    "example.test/observe",
    { enabled: true, label: "verbatim" },
  );

  const deadline = Date.now() + 5_000;
  while (
    !readLog().some((entry) => entry.method === "extensionNotification") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const request = readLog().find((entry) => entry.method === "extensionRequest");
  const notification = readLog().find(
    (entry) => entry.method === "extensionNotification",
  );
  assert.equal(request?.extensionMethod, "example.test/echo");
  assert.deepEqual(request?.params, { text: "Exact Case", values: [1, 2] });
  assert.equal(notification?.extensionMethod, "example.test/observe");
  assert.deepEqual(notification?.params, { enabled: true, label: "verbatim" });
  await session.release();
});

test("generic custom request preserves an agent-provided numeric error, message, and data", async () => {
  const { cwd } = configure({
    extensionRequest: {
      method: "example.test/fail",
      error: {
        code: -32042,
        message: "Extension rejected exactly",
        data: { reason: "fixture", retryable: false },
      },
    },
    turns: [{ text: "unused" }],
  });
  const session = await makeRunner().openSession({ model: "codex", cwd });
  await assert.rejects(
    () => session.request("example.test/fail", { opaque: "request" }),
    (error: unknown) => {
      const requestError = error as { name?: string; code?: number; message?: string; data?: unknown };
      assert.equal(requestError.name, "RequestError");
      assert.equal(requestError.code, -32042);
      assert.equal(requestError.message, "Extension rejected exactly");
      assert.deepEqual(requestError.data, { reason: "fixture", retryable: false });
      return true;
    },
  );
  await session.release();
});

test("generic custom request races process death instead of hanging", { timeout: 10_000 }, async () => {
  const { cwd } = configure({
    extensionRequest: {
      method: "example.test/die",
      exitBeforeResponse: true,
    },
    turns: [{ text: "unused" }],
  });
  const session = await makeRunner().openSession({ model: "codex", cwd });
  await assert.rejects(
    () => session.request("example.test/die", { exact: true }),
    /process|exited|closed|connection/i,
  );
});

const harness = createFakeAgentHarness({ prefix: "acp-passthrough-it-", backends: ["codex"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const makeRunner = () => harness.makeRunner();

afterEach(async () => {
  await harness.cleanup();
});

test("interactive request passthrough reaches session/set_config_option", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ],
    turns: [{ text: "unused" }],
  });
  const session = await makeRunner().openSession({ model: "codex", cwd });

  const response = await session.request(AGENT_METHODS.session_set_config_option, {
    sessionId: session.sessionId,
    configId: "reasoning_effort",
    value: "high",
  });
  assert.equal(
    response.configOptions.find((option) => option.id === "reasoning_effort")?.currentValue,
    "high",
  );

  const wireCall = readLog().find((entry) => entry.method === "setSessionConfigOption");
  assert.equal(wireCall?.params?.sessionId, session.sessionId);
  assert.equal(wireCall?.params?.configId, "reasoning_effort");
  assert.equal(wireCall?.params?.value, "high");
  await session.release();
});

test("interactive notify passthrough reaches session/cancel", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const session = await makeRunner().openSession({ model: "codex", cwd });

  await session.notify(AGENT_METHODS.session_cancel, { sessionId: session.sessionId });

  // notify() resolves when the notification is WRITTEN; the fake appends to its wire log
  // asynchronously (no response round-trip to serialize on) — poll so the assertion never
  // races the child's log flush.
  const deadline = Date.now() + 5_000;
  let wireCall: LogEntry | undefined;
  while (!wireCall && Date.now() < deadline) {
    wireCall = readLog().find((entry) => entry.method === "cancel");
    if (!wireCall) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(wireCall?.params?.sessionId, session.sessionId);
  await session.release();
});

test("generic request passthrough surfaces JSON-RPC method-not-found for extension methods", async () => {
  const { cwd } = configure({ turns: [{ text: "unused" }] });
  const session = await makeRunner().openSession({ model: "codex", cwd });

  await assert.rejects(
    () =>
      session.request<{ ok: true }, { sessionId: string }>("agentprism/extension", {
        sessionId: session.sessionId,
      }),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, "RequestError");
      assert.equal((error as { code?: number }).code, -32601);
      assert.match((error as { message?: string }).message ?? "", /Method not found.+agentprism\/extension/);
      return true;
    },
  );
  await session.release();
});

test("released interactive sessions reject request and notify passthrough calls", async () => {
  const { cwd } = configure({ turns: [{ text: "unused" }] });
  const session = await makeRunner().openSession({ model: "codex", cwd });

  await session.release();

  await assert.rejects(
    () =>
      session.request(AGENT_METHODS.session_set_config_option, {
        sessionId: session.sessionId,
        configId: "reasoning_effort",
        value: "high",
      }),
    /InteractiveSession has been released/,
  );
  await assert.rejects(
    () => session.notify(AGENT_METHODS.session_cancel, { sessionId: session.sessionId }),
    /InteractiveSession has been released/,
  );
});
