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

// ── Durable provider routing: record → recycle → replay (the providers/* sibling of the
//    dispose-after-authenticate fix). Provider config is in-process agent state (codex-acp keeps
//    its custom gateway in memory), so a set that only reached a disposed dedicated connection
//    would leave every pooled run silently unrouted. ──

test("setProvider records durable routing: the pool recycles and a fresh connection replays providers/set at initialize", async () => {
  const { cwd, readLog } = configure({
    providersSupport: true,
    providers: { set: {} },
    turns: [{ text: "routed" }, { text: "routed" }],
  });
  const runner = makeRunner();
  // Seed a pooled process BEFORE the routing change, so a stale reuse-without-replay would show.
  assert.equal(await runner.run("one", { model: "claude", cwd }), "routed");

  await runner.setProvider({
    model: "claude",
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: "https://gw.test/v1",
    headers: { Authorization: "Bearer replay-secret" },
    meta: { source: "explicit" },
  });

  assert.equal(await runner.run("two", { model: "claude", cwd }), "routed");

  const log = readLog();
  const sets = log.filter((entry) => entry.method === "setProvider");
  assert.equal(sets.length, 2, "the explicit set + exactly one replay on the fresh pooled connection");
  for (const set of sets) {
    assert.equal(set.params?.providerId, "custom-gateway");
    assert.equal(set.params?.apiType, "openai");
    assert.equal(set.params?.baseUrl, "https://gw.test/v1");
    assert.deepEqual(set.params?.headers, { Authorization: "Bearer replay-secret" });
  }
  // The request-scoped `_meta` rides the explicit call only — the durable intent never replays it.
  assert.deepEqual(sets[0]?.params?._meta, { source: "explicit" });
  assert.equal(sets[1]?.params?._meta, undefined);

  const methods = log.map((entry) => entry.method);
  assert.ok(
    methods.lastIndexOf("setProvider") < methods.lastIndexOf("newSession"),
    "the replay lands at initialize, before the recycled pool serves the next session",
  );
  // Three processes total: the seeded pooled one (recycled as stale), the dedicated set
  // connection, and the fresh pooled one that replayed.
  assert.equal(count(log, "__start"), 3);
});

test("vertex routing records its durable _meta.claudeCode.vertex and replays it on a fresh connection", async () => {
  const { cwd, readLog } = configure({
    providersSupport: true,
    providers: { set: {} },
    turns: [{ text: "routed" }, { text: "routed" }],
  });
  const runner = makeRunner();
  // Seed a pooled process BEFORE the routing change, so a stale reuse-without-replay would show.
  assert.equal(await runner.run("one", { model: "claude", cwd }), "routed");

  await runner.setProvider({
    model: "claude",
    providerId: "main",
    apiType: "vertex",
    baseUrl: "https://vertex.test/v1",
    vertex: { projectId: "proj-123", region: "us-east1" },
    meta: { source: "explicit" },
  });

  assert.equal(await runner.run("two", { model: "claude", cwd }), "routed");

  const log = readLog();
  const sets = log.filter((entry) => entry.method === "setProvider");
  assert.equal(sets.length, 2, "the explicit vertex set + exactly one replay on the fresh pooled connection");
  const vertexMeta = { claudeCode: { vertex: { projectId: "proj-123", region: "us-east1" } } };
  for (const set of sets) {
    assert.equal(set.params?.apiType, "vertex");
    assert.equal(set.params?.baseUrl, "https://vertex.test/v1");
  }
  // Immediate call carries both the request-scoped meta and the durable vertex config, deep-merged.
  assert.deepEqual(sets[0]?.params?._meta, { source: "explicit", claudeCode: { vertex: { projectId: "proj-123", region: "us-east1" } } });
  // The REPLAY carries the durable vertex config so the 0.60.0 agent accepts it — and nothing else
  // (the request-scoped `source` meta is not replayed).
  assert.deepEqual(sets[1]?.params?._meta, vertexMeta);
});

test("disableProvider drops the recorded routing: later connections do not replay it", async () => {
  const { cwd, readLog } = configure({
    providersSupport: true,
    providers: { set: {}, disable: {} },
    turns: [{ text: "unrouted" }],
  });
  const runner = makeRunner();
  await runner.setProvider({
    model: "claude",
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: "https://gw.test/v1",
  });
  await runner.disableProvider({ model: "claude", providerId: "custom-gateway" });
  assert.equal(await runner.run("go", { model: "claude", cwd }), "unrouted");

  const log = readLog();
  const disableIndex = log.findIndex((entry) => entry.method === "disableProvider");
  assert.ok(disableIndex >= 0, "the explicit disable reached the agent");
  const after = log.slice(disableIndex + 1).map((entry) => entry.method);
  assert.ok(after.includes("newSession"), "the run landed after the disable");
  assert.ok(!after.includes("setProvider"), "no replay once the intent was dropped");
});

test("a provider replay failure at initialize fails the run loudly (never a silently unrouted session)", async () => {
  configure({ providersSupport: true, providers: { set: {} } });
  const runner = makeRunner();
  await runner.setProvider({
    model: "claude",
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: "https://gw.test/v1",
  });

  // Newly spawned agent processes now reject providers/set: the replay on the next pooled
  // connection must fail the run rather than opening sessions without the configured routing.
  const { cwd } = configure({
    providersSupport: true,
    providers: { setHandler: false },
    turns: [{ text: "unreachable" }],
  });
  await assert.rejects(
    () => runner.run("go", { model: "claude", cwd, label: "replay-fail" }),
    (error: unknown) => {
      assert.match(String(error instanceof Error ? error.message : error), /providers\/set|method not found/i);
      return true;
    },
  );
});

test("a capability regression (a fresh process stops advertising providers while routing is configured) fails the run loudly and non-recoverably", async () => {
  // Record routing against a process that DOES advertise providers.
  configure({ providersSupport: true, providers: { set: {} } });
  const runner = makeRunner();
  await runner.setProvider({
    model: "claude",
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: "https://gw.test/v1",
  });

  // The next fresh pooled process NO LONGER advertises `providers` (npx-resolved backend version
  // change, command override/wrapper, startup-dependent advertisement). Stamping it current would
  // silently send traffic direct-to-provider, so applyProviderIntents must FAIL LOUDLY at
  // initialize — before any session opens — rather than skip-and-stamp.
  const { cwd } = configure({ turns: [{ text: "must-not-run" }] });
  await assert.rejects(
    () => runner.run("go", { model: "claude", cwd, label: "cap-regression" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      // Non-recoverable so the engine does not retry-loop respawning identically-failing processes.
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /claude/); // names the backend
      assert.match(error.message, /no longer advertises the .?providers.? capability/); // names the lost capability
      assert.match(error.message, /disableProvider/); // the runner-API operator exit
      return true;
    },
  );
});

test("after disabling the provider, a fresh non-advertising process serves sessions normally (the operator exit works)", async () => {
  configure({ providersSupport: true, providers: { set: {}, disable: {} } });
  const runner = makeRunner();
  await runner.setProvider({
    model: "claude",
    providerId: "custom-gateway",
    apiType: "openai",
    baseUrl: "https://gw.test/v1",
  });
  // The operator's exit: disable drops the intent (and advances the generation).
  await runner.disableProvider({ model: "claude", providerId: "custom-gateway" });

  // Routing is now off (intents emptied, generation > 0). A fresh process that no longer advertises
  // `providers` has nothing to replay, so it must serve normally — the empty-intents gate means the
  // capability-loss throw does NOT fire after a disable.
  const { cwd } = configure({ turns: [{ text: "served" }] });
  assert.equal(await runner.run("go", { model: "claude", cwd }), "served");
});

test("baseline: a non-advertising agent with no recorded routing does not throw (byte-identical to the default-OFF baseline)", async () => {
  // No provider intent is ever recorded, so intentsFor(poolKey) is empty and the capability-loss
  // gate never trips even though the agent does not advertise providers.
  const { cwd } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();
  assert.equal(await runner.run("go", { model: "claude", cwd }), "ok");
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
