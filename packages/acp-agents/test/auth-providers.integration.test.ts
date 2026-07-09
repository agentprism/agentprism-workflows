import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AuthMethod, ProviderInfo } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: {
    methodId?: string;
    providerId?: string;
    apiType?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    _meta?: Record<string, unknown>;
  };
}

const AUTH_METHODS: AuthMethod[] = [
  {
    id: "api-key",
    name: "API Key",
    type: "env_var",
    vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API key" }],
  },
  { id: "chat-gpt", name: "ChatGPT" },
];

const PROVIDERS: ProviderInfo[] = [
  {
    providerId: "openai",
    supported: ["openai"],
    required: false,
    current: { apiType: "openai", baseUrl: "https://api.openai.com/v1" },
  },
];

const harness = createFakeAgentHarness({ prefix: "acp-auth-providers-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

function count(log: LogEntry[], method: string): number {
  return log.filter((entry) => entry.method === method).length;
}

afterEach(async () => {
  await harness.cleanup();
});

test("runner.authMethods returns advertised auth methods", async () => {
  configure({ authMethods: AUTH_METHODS });
  assert.deepEqual(await makeRunner().authMethods({ model: "claude" }), AUTH_METHODS);
});

test("runner.authMethods returns [] when none are advertised", async () => {
  configure({});
  assert.deepEqual(await makeRunner().authMethods({ model: "claude" }), []);
});

test("authenticate records the credential into the AuthStore and REPLAYS it after initialize (§2.5/§2.9)", async () => {
  // REBUILT off dispose-after-authenticate: a method carrying `_meta` (gateway-shaped => in-process)
  // records a durable intent instead of a fire-and-dispose RPC, and the credential is replayed on the
  // next pooled connection's initialize (the gap-3 fix) rather than lost with a disposed connection.
  const { cwd, readLog } = configure({
    authMethods: [{ id: "gateway", name: "Gateway", _meta: { gateway: {} } }],
    authenticate: { response: {} },
    turns: [{ text: "done" }],
  });
  const runner = makeRunner();
  await runner.authenticate({ model: "claude", methodId: "gateway", meta: { gateway: { token: "secret" } } });

  // The replay lands when a pooled process initializes for the next run().
  const result = await runner.run("go", { model: "claude", cwd, label: "gw" });
  assert.equal(result, "done");

  const call = readLog().find((entry) => entry.method === "authenticate");
  assert.equal(call?.params?.methodId, "gateway");
  assert.deepEqual(call?.params?._meta, { gateway: { token: "secret" } });
});

test("providers list/set/disable and logout round-trip through the selected backend", async () => {
  const { readLog } = configure({
    providers: {
      list: { providers: PROVIDERS },
      set: { _meta: { set: true } },
      disable: { _meta: { disabled: true } },
    },
    logout: { response: { _meta: { loggedOut: true } } },
  });
  const runner = makeRunner();

  assert.deepEqual(await runner.listProviders({ model: "claude", meta: { source: "list" } }), {
    providers: PROVIDERS,
  });
  assert.deepEqual(
    await runner.setProvider({
      model: "claude",
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://gateway.test/v1",
      headers: { Authorization: "Bearer test" },
      meta: { source: "set" },
    }),
    { _meta: { set: true } },
  );
  assert.deepEqual(
    await runner.disableProvider({ model: "claude", providerId: "openai", meta: { source: "disable" } }),
    { _meta: { disabled: true } },
  );
  assert.deepEqual(await runner.logout({ model: "claude", meta: { source: "logout" } }), {
    _meta: { loggedOut: true },
  });

  const log = readLog();
  const listCall = log.find((entry) => entry.method === "listProviders");
  assert.deepEqual(listCall?.params?._meta, { source: "list" });
  const setCall = log.find((entry) => entry.method === "setProvider");
  assert.equal(setCall?.params?.providerId, "openai");
  assert.equal(setCall?.params?.apiType, "openai");
  assert.equal(setCall?.params?.baseUrl, "https://gateway.test/v1");
  assert.deepEqual(setCall?.params?.headers, { Authorization: "Bearer test" });
  assert.deepEqual(setCall?.params?._meta, { source: "set" });
  const disableCall = log.find((entry) => entry.method === "disableProvider");
  assert.equal(disableCall?.params?.providerId, "openai");
  assert.deepEqual(disableCall?.params?._meta, { source: "disable" });
  const logoutCall = log.find((entry) => entry.method === "logout");
  assert.deepEqual(logoutCall?.params?._meta, { source: "logout" });
});

test("auth-required on session/new maps to non-recoverable AUTH_REQUIRED without retrying", async () => {
  const { cwd, readLog } = configure({
    authMethods: AUTH_METHODS,
    authRequiredOnNewSession: true,
    authRequiredMessage: "login first",
    turns: [{ text: "unused" }],
  });

  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "needs-auth" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      assert.equal(error.recoverable, false);
      assert.equal(error.agentLabel, "needs-auth");
      assert.match(error.message, /claude/);
      assert.match(error.message, /api-key, chat-gpt/);
      assert.match(error.message, /login first/);
      return true;
    },
  );
  assert.equal(count(readLog(), "newSession"), 1);
});

test("with onAuth, a -32000 resolves-and-retries EXACTLY once then propagates AUTH_REQUIRED (§2.11)", async () => {
  const { cwd, readLog } = configure({
    authMethods: AUTH_METHODS,
    authRequiredOnNewSession: true, // the fixture -32000s on EVERY newSession
    turns: [{ text: "unused" }],
  });
  let calls = 0;
  const runner = harness.makeRunner({
    onAuth: () => {
      calls += 1;
      return { outcome: "completed" };
    },
  });

  await assert.rejects(
    () => runner.run("hi", { model: "claude", cwd, label: "needs-auth" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      return true;
    },
  );
  // The resolver ran once and the acquire retried once: exactly two newSession attempts, no loop.
  assert.equal(calls, 1);
  assert.equal(count(readLog(), "newSession"), 2);
});

test("ungated authenticate surfaces method-not-found with backend and method context", async () => {
  configure({
    authMethods: AUTH_METHODS,
    authenticateHandler: false,
  });

  await assert.rejects(
    () => makeRunner().authenticate({ model: "claude", methodId: "api-key" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /claude/);
      assert.match(error.message, /authenticate/);
      assert.match(error.message, /Method not found/);
      return true;
    },
  );
});
