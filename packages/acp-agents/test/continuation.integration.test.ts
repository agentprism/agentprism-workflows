import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  isWorkflowError,
  WorkflowErrorCode,
  type AgentResultProvenance,
  type AgentSessionRef,
  type AgentUsage,
} from "@automatalabs/shared-types";
import {
  AcpAgentRunner,
  CustomAcpBackend,
  type CustomBackendConfig,
} from "../src/index.js";
import {
  createFakeAgentHarness,
  FAKE_AGENT_FIXTURE,
  readLog as readLogFile,
  waitFor,
} from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  pid?: number;
  params?: Record<string, any>;
}

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};

const CONFIG_OPTIONS = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default-model",
    options: [
      { value: "default-model", name: "Default" },
      { value: "claude-opus-4-1", name: "Claude Opus 4.1" },
    ],
  },
  {
    id: "thinking",
    type: "boolean",
    name: "Thinking",
    category: "model_config",
    currentValue: false,
  },
];

const harness = createFakeAgentHarness({ prefix: "acp-continuation-it-", backends: ["claude"] });

afterEach(async () => {
  await harness.cleanup();
});

function sessionRef(cwd: string, overrides: Partial<AgentSessionRef> = {}): AgentSessionRef {
  return {
    sessionId: "persisted-session",
    backendId: "claude",
    poolKey: "claude",
    cwd,
    reopen: { load: true, resume: true, list: true, fork: true },
    ...overrides,
  };
}

function methods(log: LogEntry[]): string[] {
  return log.map((entry) => entry.method).filter((method) => !method.startsWith("__"));
}

function count(log: LogEntry[], method: string): number {
  return log.filter((entry) => entry.method === method).length;
}

function promptBlocks(log: LogEntry[]): Array<Record<string, unknown>> {
  return (log.find((entry) => entry.method === "prompt")?.params?.prompt ?? []) as Array<Record<string, unknown>>;
}

function continuationReports(values: AgentResultProvenance[]): NonNullable<Extract<AgentResultProvenance, { source: "live" }>["continuation"]>[] {
  return values.flatMap((value) => value.source === "live" && value.continuation ? [value.continuation] : []);
}

test("provider-usage pause releases without session/close", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    turns: [{ throw: "quota exhausted", throwData: { errorKind: "billing_error" } }],
  });

  await assert.rejects(
    () => harness.makeRunner().run("work", { model: "claude", cwd }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      return true;
    },
  );
  assert.equal(count(readLog(), "closeSession"), 0);
});

test("auth-required pause releases without session/close", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    turns: [{ throw: "Authentication required", throwCode: -32000 }],
  });

  await assert.rejects(
    () => harness.makeRunner().run("work", { model: "claude", cwd }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      return true;
    },
  );
  assert.equal(count(readLog(), "closeSession"), 0);
});

test("non-pause failure still closes and success still closes", async () => {
  const failed = harness.configure<LogEntry>({ turns: [{ throw: "transport broke" }] });
  await assert.rejects(() => harness.makeRunner().run("work", { model: "claude", cwd: failed.cwd }));
  assert.equal(count(failed.readLog(), "closeSession"), 1);

  await harness.cleanup();
  const succeeded = harness.configure<LogEntry>({ turns: [{ text: "done" }] });
  assert.equal(await harness.makeRunner().run("work", { model: "claude", cwd: succeeded.cwd }), "done");
  assert.equal(count(succeeded.readLog(), "closeSession"), 1);
});

test("resume continuation wins once, reports provenance before setup, omits original prompt/images, and stamps poolKey", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    modes: MODES,
    configOptions: CONFIG_OPTIONS,
    turns: [{ text: "complete answer" }],
  });
  const observations: string[] = [];
  const provenances: AgentResultProvenance[] = [];
  const opened: AgentSessionRef[] = [];
  const runner = harness.makeRunner();
  const output = await runner.run("ORIGINAL TASK", {
    model: "claude/claude-opus-4-1",
    mode: "plan",
    configOptions: { thinking: true },
    cwd,
    images: [{ data: "ZmFrZQ==", mimeType: "image/png", uri: "file:///tmp/original.png" }],
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => {
      provenances.push(value);
      observations.push(`provenance:${methods(readLog()).at(-1)}`);
    },
    onSessionOpen: (value) => opened.push(value),
    onModelResolved: () => observations.push("model-resolved"),
  });

  assert.equal(output, "complete answer");
  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "resume" }]);
  assert.equal(observations[0], "provenance:resumeSession");
  assert.equal(observations[1], "model-resolved");
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], {
    ...sessionRef(cwd),
    sessionId: "persisted-session",
    poolKey: "claude",
  });

  const log = readLog();
  assert.equal(count(log, "resumeSession"), 1);
  assert.equal(count(log, "loadSession"), 0);
  assert.equal(count(log, "newSession"), 0);
  const wire = methods(log);
  assert.ok(wire.indexOf("resumeSession") < wire.indexOf("setSessionConfigOption"));
  assert.ok(wire.indexOf("setSessionConfigOption") < wire.indexOf("setSessionMode"));
  assert.ok(wire.indexOf("setSessionMode") < wire.indexOf("prompt"));
  const blocks = promptBlocks(log);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "text");
  assert.match(String(blocks[0]?.text), /previous turn was interrupted/);
  assert.match(String(blocks[0]?.text), /COMPLETE final answer/);
  assert.doesNotMatch(String(blocks[0]?.text), /ORIGINAL TASK/);
  assert.equal(blocks.some((block) => block.type === "image"), false);
});

test("load-only cold connection waits for initialize, replays, then continues without session/new", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    resumeSessionSupport: false,
    loadSession: { replay: ["historical partial"] },
    turns: [{ text: "loaded completion" }],
  });
  const provenances: AgentResultProvenance[] = [];

  const result = await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  });

  assert.equal(result, "loaded completion");
  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "load" }]);
  assert.deepEqual(methods(readLog()).filter((method) => ["loadSession", "resumeSession", "newSession"].includes(method)), ["loadSession"]);
});

test("initialize failure surfaces as reattach-failed, never a premature capability-missing", async () => {
  const { cwd } = harness.configure<LogEntry>({
    initializeThrow: "initialize exploded",
    lifecycleSupport: true,
  });
  const provenances: AgentResultProvenance[] = [];

  await assert.rejects(() => harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  }));

  assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "reattach-failed" }]);
});

test("ready connection without reopen capability preserves the sentinel as capability-missing and falls fresh", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({ turns: [{ text: "fresh answer" }] });
  const provenances: AgentResultProvenance[] = [];
  const result = await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  });

  assert.equal(result, "fresh answer");
  assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "capability-missing" }]);
  assert.equal(count(readLog(), "resumeSession"), 0);
  assert.equal(count(readLog(), "loadSession"), 0);
  assert.equal(count(readLog(), "newSession"), 1);
  assert.equal(String(promptBlocks(readLog())[0]?.text), "original");
});

for (const failure of [
  { name: "rejected reopen", resumeSession: { throw: "resume rejected" } },
  { name: "missing session", resumeSession: { throw: "session not found", throwCode: -32602 } },
] as const) {
  test(`${failure.name} reports reattach-failed and falls fresh`, async () => {
    const { cwd, readLog } = harness.configure<LogEntry>({
      lifecycleSupport: true,
      resumeSession: failure.resumeSession,
      turns: [{ text: "fresh answer" }],
    });
    const provenances: AgentResultProvenance[] = [];
    const result = await harness.makeRunner().run("original", {
      model: "claude",
      cwd,
      continueFromSession: sessionRef(cwd),
      onResultProvenance: (value) => provenances.push(value),
    });

    assert.equal(result, "fresh answer");
    assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "reattach-failed" }]);
    assert.equal(count(readLog(), "resumeSession"), 1);
    assert.equal(count(readLog(), "newSession"), 1);
    assert.equal(String(promptBlocks(readLog())[0]?.text), "original");
  });
}

test("backend id mismatch reports backend-mismatch without a reopen request and falls fresh", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({ lifecycleSupport: true, turns: [{ text: "fresh" }] });
  const provenances: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd, { backendId: "codex", poolKey: "codex" }),
    onResultProvenance: (value) => provenances.push(value),
  }), "fresh");

  assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "backend-mismatch" }]);
  assert.equal(count(readLog(), "resumeSession"), 0);
  assert.equal(count(readLog(), "newSession"), 1);
});

test("capability drift from resume to load selects the current connection's load capability", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    loadSessionSupport: true,
    resumeSessionSupport: false,
    turns: [{ text: "load drift answer" }],
  });
  const provenances: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd, { reopen: { load: true, resume: true, list: false, fork: false } }),
    onResultProvenance: (value) => provenances.push(value),
  }), "load drift answer");

  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "load" }]);
  assert.equal(count(readLog(), "loadSession"), 1);
  assert.equal(count(readLog(), "resumeSession"), 0);
});

test("reattach is attempted once outside the fresh inline-auth retry loop", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    resumeSession: { throw: "resume rejected" },
    authMethods: [{ id: "gateway", name: "Gateway", _meta: { gateway: {} } }],
    authRequiredOnNewSessionCount: 1,
    authRequiredOnNewSessionOnce: true,
    turns: [{ text: "fresh after auth" }],
  });
  process.env.AGENTPRISM_FAKE_AUTH_ONCE_SENTINEL = `${cwd}/auth-once.sentinel`;
  let authCalls = 0;
  const provenances: AgentResultProvenance[] = [];
  const runner = harness.makeRunner({
    onAuth: () => {
      authCalls += 1;
      return { outcome: "meta", methodId: "gateway", meta: { gateway: { token: "test" } } };
    },
  });

  assert.equal(await runner.run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  }), "fresh after auth");

  assert.equal(authCalls, 1);
  assert.equal(count(readLog(), "resumeSession"), 1);
  assert.equal(count(readLog(), "newSession"), 2);
  assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "reattach-failed" }]);
});

test("AUTH_REQUIRED from the reopen RPC is reattach-failed and never enters inline auth", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    resumeSession: { authRequired: true, throw: "login for resume" },
    authMethods: [{ id: "gateway", name: "Gateway", _meta: { gateway: {} } }],
    turns: [{ text: "fresh" }],
  });
  let authCalls = 0;
  const provenances: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner({
    onAuth: () => {
      authCalls += 1;
      return { outcome: "cancelled" };
    },
  }).run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  }), "fresh");

  assert.equal(authCalls, 0);
  assert.deepEqual(continuationReports(provenances), [{ reattached: false, reason: "reattach-failed" }]);
  assert.equal(count(readLog(), "resumeSession"), 1);
  assert.equal(count(readLog(), "newSession"), 1);
});

function customFixture(scenario: unknown, configOverrides: Partial<CustomBackendConfig> = {}): {
  cwd: string;
  config: CustomBackendConfig;
  readLog: () => LogEntry[];
} {
  const configured = harness.configure<LogEntry>(scenario, { backends: [] });
  const config: CustomBackendConfig = {
    command: process.execPath,
    args: [FAKE_AGENT_FIXTURE],
    env: {
      AGENTPRISM_FAKE_SCENARIO: JSON.stringify(scenario),
      AGENTPRISM_FAKE_LOG: configured.log,
    },
    ...configOverrides,
  };
  return { cwd: configured.cwd, config, readLog: () => readLogFile<LogEntry>(configured.log) };
}

function customPoolKey(name: string, config: CustomBackendConfig): string {
  return new CustomAcpBackend({ name, ...config }).poolKey;
}

test("custom backend poolKey drift fails fresh; equal poolKey reattaches; legacy refs never bind custom", async () => {
  const mismatched = customFixture({ lifecycleSupport: true, turns: [{ text: "fresh drift" }] });
  const mismatchReports: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner({ backends: { fake: mismatched.config } }).run("original", {
    model: "fake",
    cwd: mismatched.cwd,
    continueFromSession: sessionRef(mismatched.cwd, {
      backendId: "fake",
      poolKey: "fake#old-command",
    }),
    onResultProvenance: (value) => mismatchReports.push(value),
  }), "fresh drift");
  assert.deepEqual(continuationReports(mismatchReports), [{ reattached: false, reason: "backend-mismatch" }]);
  assert.equal(count(mismatched.readLog(), "resumeSession"), 0);

  await harness.cleanup();
  const matching = customFixture({ lifecycleSupport: true, turns: [{ text: "continued custom" }] });
  const matchReports: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner({ backends: { fake: matching.config } }).run("original", {
    model: "fake",
    cwd: matching.cwd,
    continueFromSession: sessionRef(matching.cwd, {
      backendId: "fake",
      poolKey: customPoolKey("fake", matching.config),
    }),
    onResultProvenance: (value) => matchReports.push(value),
  }), "continued custom");
  assert.deepEqual(continuationReports(matchReports), [{ reattached: true, method: "resume" }]);
  assert.equal(count(matching.readLog(), "newSession"), 0);

  await harness.cleanup();
  const legacyCustom = customFixture({ lifecycleSupport: true, turns: [{ text: "legacy fresh" }] });
  const legacyReports: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner({ backends: { fake: legacyCustom.config } }).run("original", {
    model: "fake",
    cwd: legacyCustom.cwd,
    continueFromSession: sessionRef(legacyCustom.cwd, { backendId: "fake", poolKey: undefined }),
    onResultProvenance: (value) => legacyReports.push(value),
  }), "legacy fresh");
  assert.deepEqual(continuationReports(legacyReports), [{ reattached: false, reason: "backend-mismatch" }]);
  assert.equal(count(legacyCustom.readLog(), "resumeSession"), 0);
});

test("legacy ref without poolKey still reattaches to a first-class backend", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({ lifecycleSupport: true, turns: [{ text: "legacy continued" }] });
  const provenances: AgentResultProvenance[] = [];
  assert.equal(await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd, { poolKey: undefined }),
    onResultProvenance: (value) => provenances.push(value),
  }), "legacy continued");
  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "resume" }]);
  assert.equal(count(readLog(), "newSession"), 0);
});

test("post-open mode failure stays committed to the reattach and provenance precedes setup", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    modes: MODES,
    turns: [{ text: "unused" }],
  });
  const provenances: AgentResultProvenance[] = [];
  const opened: AgentSessionRef[] = [];

  await assert.rejects(
    () => harness.makeRunner().run("original", {
      model: "claude",
      cwd,
      mode: "not-advertised",
      continueFromSession: sessionRef(cwd),
      onSessionOpen: (value) => opened.push(value),
      onResultProvenance: (value) => provenances.push(value),
    }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      return true;
    },
  );

  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "resume" }]);
  assert.equal(opened.length, 1);
  assert.equal(count(readLog(), "resumeSession"), 1);
  assert.equal(count(readLog(), "newSession"), 0);
  assert.equal(count(readLog(), "prompt"), 0);
});

test("failed reattach fires onSessionOpen exactly once for the fresh winning handle", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    resumeSession: { throw: "gone" },
    turns: [{ text: "fresh" }],
  });
  const opened: AgentSessionRef[] = [];
  assert.equal(await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    continueFromSession: sessionRef(cwd),
    onSessionOpen: (value) => opened.push(value),
  }), "fresh");

  assert.equal(opened.length, 1);
  assert.notEqual(opened[0]?.sessionId, "persisted-session");
  assert.equal(count(readLog(), "resumeSession"), 1);
  assert.equal(count(readLog(), "newSession"), 1);
});

for (const pause of [
  {
    name: "provider usage limit",
    turn: { throw: "quota again", throwData: { errorKind: "billing_error" } },
    code: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
  },
  {
    name: "auth required",
    turn: { throw: "Authentication required", throwCode: -32000 },
    code: WorkflowErrorCode.AUTH_REQUIRED,
  },
] as const) {
  test(`second ${pause.name} during continuation propagates and keeps the reopened session open`, async () => {
    const { cwd, readLog } = harness.configure<LogEntry>({
      lifecycleSupport: true,
      turns: [pause.turn],
    });
    const provenances: AgentResultProvenance[] = [];
    await assert.rejects(
      () => harness.makeRunner().run("original", {
        model: "claude",
        cwd,
        continueFromSession: sessionRef(cwd),
        onResultProvenance: (value) => provenances.push(value),
      }),
      (error: unknown) => {
        assert.ok(isWorkflowError(error));
        assert.equal(error.code, pause.code);
        return true;
      },
    );

    assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "resume" }]);
    assert.equal(count(readLog(), "newSession"), 0);
    assert.equal(count(readLog(), "closeSession"), 0);
  });
}

test("empty continuation output is an ordinary live error with no fresh retry", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({ lifecycleSupport: true, turns: [{ text: "   " }] });
  await assert.rejects(
    () => harness.makeRunner().run("original", {
      model: "claude",
      cwd,
      continueFromSession: sessionRef(cwd),
    }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      return true;
    },
  );
  assert.equal(count(readLog(), "resumeSession"), 1);
  assert.equal(count(readLog(), "newSession"), 0);
  assert.equal(count(readLog(), "prompt"), 1);
});

test("abort during cold initialize propagates raw, opens no fresh session, and emits no skip provenance", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    initializeDelayMs: 75,
    turns: [{ text: "unused" }],
  });
  const controller = new AbortController();
  const reason = new Error("cancel during initialize");
  const provenances: AgentResultProvenance[] = [];
  const running = harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    signal: controller.signal,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  });
  await waitFor(() => count(readLog(), "initialize") === 1);
  controller.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);

  assert.equal(count(readLog(), "newSession"), 0);
  assert.equal(continuationReports(provenances).some((value) => !value.reattached), false);
});

test("abort during reopen RPC propagates raw, opens no fresh session, and emits no skip provenance", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    resumeSession: { delayMs: 75 },
    turns: [{ text: "unused" }],
  });
  const controller = new AbortController();
  const reason = new Error("cancel during reopen");
  const provenances: AgentResultProvenance[] = [];
  const running = harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    signal: controller.signal,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  });
  await waitFor(() => count(readLog(), "resumeSession") === 1);
  controller.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);

  assert.equal(count(readLog(), "newSession"), 0);
  assert.equal(continuationReports(provenances).some((value) => !value.reattached), false);
});

test("abort during continuation turn propagates raw and never falls fresh", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    lifecycleSupport: true,
    turns: [{ waitForCancel: true }],
  });
  const controller = new AbortController();
  const reason = new Error("cancel continuation turn");
  const provenances: AgentResultProvenance[] = [];
  const running = harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    signal: controller.signal,
    continueFromSession: sessionRef(cwd),
    onResultProvenance: (value) => provenances.push(value),
  });
  await waitFor(() => count(readLog(), "prompt") === 1);
  controller.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);

  assert.deepEqual(continuationReports(provenances), [{ reattached: true, method: "resume" }]);
  assert.equal(count(readLog(), "newSession"), 0);
  assert.equal(count(readLog(), "cancel"), 1);
});

test("reattach failure releases structured-tool registration before fresh re-registration, even when cleanup throws", async () => {
  const schema = Type.Object({ city: Type.String(), hot: Type.Boolean() });
  const fixture = customFixture({
    lifecycleSupport: true,
    mcpHttpSupport: true,
    resumeSession: { throw: "resume rejected after prepare" },
    turns: [{ structuredToolCall: { arguments: { city: "Oslo", hot: false } }, text: "tool used" }],
  });
  const runner = harness.makeRunner({ backends: { fake: fixture.config } });

  // Force the first failed-acquire registration's release action to throw after it really releases;
  // the runner must still re-register and complete the fresh schema run.
  const toolHost = (runner as unknown as { structuredOutputTools: { register: (...args: any[]) => Promise<any> } }).structuredOutputTools;
  const originalRegister = toolHost.register.bind(toolHost);
  let registrations = 0;
  toolHost.register = async (...args: any[]) => {
    const registration = await originalRegister(...args);
    registrations += 1;
    if (registrations !== 1) return registration;
    return {
      url: registration.url,
      tryCaptured: () => registration.tryCaptured(),
      release: () => {
        registration.release();
        throw new Error("synthetic cleanup failure");
      },
    };
  };

  const output = await runner.run("original", {
    model: "fake",
    cwd: fixture.cwd,
    schema,
    continueFromSession: sessionRef(fixture.cwd, {
      backendId: "fake",
      poolKey: customPoolKey("fake", fixture.config),
    }),
  });
  assert.deepEqual(output, { city: "Oslo", hot: false });
  assert.equal(registrations, 2);
  const log = fixture.readLog();
  const resumeServers = log.find((entry) => entry.method === "resumeSession")?.params?.mcpServers ?? [];
  const freshServers = log.find((entry) => entry.method === "newSession")?.params?.mcpServers ?? [];
  assert.equal(resumeServers.length, 1);
  assert.equal(freshServers.length, 1);
  assert.notEqual(resumeServers[0]?.url, freshServers[0]?.url);
  assert.equal(count(log, "structuredToolCall"), 1);
});

test("abort observed during reattach-failure cleanup is caught before fresh acquire and emits no skip provenance", async () => {
  const schema = Type.Object({ city: Type.String() });
  const fixture = customFixture({
    lifecycleSupport: true,
    mcpHttpSupport: true,
    resumeSession: { throw: "resume rejected after prepare" },
    turns: [{ text: "must not run" }],
  });
  const runner = harness.makeRunner({ backends: { fake: fixture.config } });
  const controller = new AbortController();
  const reason = new Error("abort from cleanup");
  const provenances: AgentResultProvenance[] = [];
  const toolHost = (runner as unknown as { structuredOutputTools: { register: (...args: any[]) => Promise<any> } }).structuredOutputTools;
  const originalRegister = toolHost.register.bind(toolHost);
  toolHost.register = async (...args: any[]) => {
    const registration = await originalRegister(...args);
    return {
      url: registration.url,
      tryCaptured: () => registration.tryCaptured(),
      release: () => {
        registration.release();
        controller.abort(reason);
      },
    };
  };

  await assert.rejects(
    runner.run("original", {
      model: "fake",
      cwd: fixture.cwd,
      schema,
      signal: controller.signal,
      continueFromSession: sessionRef(fixture.cwd, {
        backendId: "fake",
        poolKey: customPoolKey("fake", fixture.config),
      }),
      onResultProvenance: (value) => provenances.push(value),
    }),
    (error: unknown) => error === reason,
  );

  assert.equal(count(fixture.readLog(), "resumeSession"), 1);
  assert.equal(count(fixture.readLog(), "newSession"), 0);
  assert.equal(continuationReports(provenances).some((value) => !value.reattached), false);
});

test("structured-output repair ladder runs unchanged over a continuation turn", async () => {
  const schema = Type.Object({ city: Type.String() });
  const fixture = customFixture(
    {
      lifecycleSupport: true,
      turns: [{ text: "not json" }, { text: '{"city":"Paris"}' }],
    },
    { structuredOutputTool: false },
  );
  const output = await harness.makeRunner({ backends: { fake: fixture.config } }).run("ORIGINAL", {
    model: "fake",
    cwd: fixture.cwd,
    schema,
    continueFromSession: sessionRef(fixture.cwd, {
      backendId: "fake",
      poolKey: customPoolKey("fake", fixture.config),
    }),
  });

  assert.deepEqual(output, { city: "Paris" });
  const prompts = fixture.readLog().filter((entry) => entry.method === "prompt");
  assert.equal(prompts.length, 2);
  assert.match(String(prompts[0]?.params?.prompt?.[0]?.text), /previous turn was interrupted/);
  assert.doesNotMatch(String(prompts[0]?.params?.prompt?.[0]?.text), /ORIGINAL/);
});

test("reattach prepare carries authored MCP servers and runId stamping exactly like fresh prepare", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({ lifecycleSupport: true, turns: [{ text: "continued" }] });
  assert.equal(await harness.makeRunner().run("original", {
    model: "claude",
    cwd,
    runId: "resume-run-42",
    mcpServers: [{ type: "stdio", name: "tools", command: "node", args: ["server.mjs"], env: [] }],
    continueFromSession: sessionRef(cwd),
  }), "continued");

  const resume = readLog().find((entry) => entry.method === "resumeSession")?.params;
  assert.equal(resume?._meta?.runId, "resume-run-42");
  assert.deepEqual(resume?.mcpServers, [
    { name: "tools", command: "node", args: ["server.mjs"], env: [] },
  ]);
  assert.equal(count(readLog(), "newSession"), 0);
});

const ZERO_USAGE: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

for (const usageCase of [
  {
    name: "load replay then continuation reports prompt breakdown and only post-baseline cost",
    scenario: {
      loadSessionSupport: true,
      loadSession: {
        updates: [{ sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 5, currency: "USD" } }],
      },
      turns: [{
        text: "done",
        usageUpdate: { used: 1_300, size: 200_000, cost: { amount: 5.5, currency: "USD" } },
        usage: { inputTokens: 30, outputTokens: 20, cachedReadTokens: 10, cachedWriteTokens: 5, totalTokens: 50 },
      }],
    },
    expected: { input: 30, output: 20, cacheRead: 10, cacheWrite: 5, total: 50, cost: 0.5 },
  },
  {
    name: "load counter reset and context compaction clamp every fallback field non-negative",
    scenario: {
      loadSessionSupport: true,
      loadSession: {
        updates: [{ sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 5, currency: "USD" } }],
      },
      turns: [{ text: "done", usageUpdate: { used: 900, size: 200_000, cost: { amount: 1, currency: "USD" } } }],
    },
    expected: ZERO_USAGE,
  },
  {
    name: "load with no post-baseline update reports all-zero sentinel",
    scenario: {
      loadSessionSupport: true,
      loadSession: {
        updates: [{ sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 5, currency: "USD" } }],
      },
      turns: [{ text: "done" }],
    },
    expected: ZERO_USAGE,
  },
  {
    name: "load prompt-usage-only preserves per-turn fields and reports zero cost delta",
    scenario: {
      loadSessionSupport: true,
      loadSession: {
        updates: [{ sessionUpdate: "usage_update", used: 1_000, size: 200_000, cost: { amount: 5, currency: "USD" } }],
      },
      turns: [{ text: "done", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }],
    },
    expected: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, total: 7, cost: 0 },
  },
  {
    name: "resume without replay reports the full continuation usage",
    scenario: {
      resumeSessionSupport: true,
      turns: [{ text: "done", usageUpdate: { used: 250, size: 200_000, cost: { amount: 0.75, currency: "USD" } } }],
    },
    expected: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 250, cost: 0.75 },
  },
] as const) {
  test(`usage delta: ${usageCase.name}`, async () => {
    const { cwd } = harness.configure<LogEntry>(usageCase.scenario);
    const usages: AgentUsage[] = [];
    assert.equal(await harness.makeRunner().run("original", {
      model: "claude",
      cwd,
      continueFromSession: sessionRef(cwd),
      onUsage: (usage) => usages.push(usage),
    }), "done");
    assert.deepEqual(usages, [usageCase.expected]);
    for (const value of Object.values(usages[0] ?? {})) assert.ok(value >= 0);
  });
}
