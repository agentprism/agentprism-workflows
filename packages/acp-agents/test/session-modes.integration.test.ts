import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { RequestPermissionResponse, SessionModeState } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "read-only", name: "Read only" },
  ],
};

interface LogEntry {
  method: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    modeId?: string;
    configId?: string;
    value?: string;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-session-modes-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

const MODE_CONFIG_OPTIONS = [
  {
    id: "mode",
    type: "select",
    name: "Mode",
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
];

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

function methods(log: LogEntry[]): string[] {
  return log.map((entry) => entry.method).filter((method) => !method.startsWith("__"));
}

function permissionOutcome(log: LogEntry[]): RequestPermissionResponse["outcome"] | undefined {
  return log.find((entry) => entry.method === "permissionOutcome")?.outcome;
}

function assertModeFailure(error: unknown, requested: string, advertised: string | RegExp): true {
  assert.ok(isWorkflowError(error));
  assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  assert.equal(error.recoverable, false);
  assert.match(error.message, /claude/);
  assert.match(error.message, new RegExp(requested));
  assert.match(error.message, advertised);
  return true;
}

afterEach(async () => {
  await harness.cleanup();
});

test("probeConfigOptions returns the dedicated ACP mode catalog without prompting", async () => {
  const { cwd, readLog } = configure({ modes: MODES });
  const probed = await makeRunner().probeConfigOptions("claude", { cwd });

  assert.deepEqual(probed.modes, MODES);
  assert.equal(probed.defaultModeId, "auto");
  assert.equal(readLog().some((entry) => entry.method === "prompt"), false);
});

test("probeConfigOptions normalizes the mode config-option fallback and reports unsupported modes explicitly", async () => {
  const supported = configure({ configOptions: MODE_CONFIG_OPTIONS });
  const fallback = await makeRunner().probeConfigOptions("claude", { cwd: supported.cwd });
  assert.equal(fallback.modes?.currentModeId, "build");
  assert.deepEqual(fallback.modes?.availableModes.map((mode) => mode.id), ["build", "plan"]);

  await harness.cleanup();
  const unsupported = configure({ configOptions: [] });
  const absent = await makeRunner().probeConfigOptions("claude", { cwd: unsupported.cwd });
  assert.equal(absent.modes, null);
});

test("openSession({ mode }) drives session/set_mode before any prompt and exposes updated modes", async () => {
  const { cwd, readLog } = configure({ modes: MODES, turns: [{ text: "ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, model: "claude", mode: "plan" });

  assert.equal(session.modes?.currentModeId, "plan");
  assert.deepEqual(
    session.modes?.availableModes.map((mode) => mode.id),
    ["default", "plan", "read-only"],
  );
  assert.equal((await session.prompt("hi")).text, "ok");

  const wire = methods(readLog());
  assert.ok(wire.indexOf("setSessionMode") > wire.indexOf("newSession"));
  assert.ok(wire.indexOf("setSessionMode") < wire.indexOf("prompt"));
  await session.release();
});

test("openSession rejects unsupported requested modes before prompting", async () => {
  const { cwd, readLog } = configure({ modes: MODES, turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.openSession({ cwd, model: "claude", mode: "nope" }),
    (error: unknown) => assertModeFailure(error, "nope", /default, plan, read-only/),
  );
  assert.equal(readLog().some((entry) => entry.method === "prompt"), false);
});

test("openSession rejects requested modes when the agent advertises no modes", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.openSession({ cwd, model: "claude", mode: "plan" }),
    (error: unknown) => assertModeFailure(error, "plan", /none/),
  );
  assert.equal(readLog().some((entry) => entry.method === "prompt"), false);
});

test("openSession uses a mode config option catalog when session/new carries no modes", async () => {
  const { cwd, readLog } = configure({ configOptions: MODE_CONFIG_OPTIONS, turns: [{ text: "ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, model: "claude", mode: "plan" });

  assert.equal(session.modes?.currentModeId, "plan");
  assert.deepEqual(
    session.modes?.availableModes.map((mode) => mode.id),
    ["build", "plan"],
  );
  assert.equal((await session.prompt("hi")).text, "ok");

  const wire = methods(readLog());
  assert.equal(wire.includes("setSessionMode"), false);
  assert.ok(wire.indexOf("setSessionConfigOption") > wire.indexOf("newSession"));
  assert.ok(wire.indexOf("setSessionConfigOption") < wire.indexOf("prompt"));
  const modeSet = readLog().find((entry) => entry.method === "setSessionConfigOption");
  assert.equal(modeSet?.params?.configId, "mode");
  assert.equal(modeSet?.params?.value, "plan");
  await session.release();
});

test("openSession rejects config-option modes not advertised before prompting", async () => {
  const { cwd, readLog } = configure({ configOptions: MODE_CONFIG_OPTIONS, turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.openSession({ cwd, model: "claude", mode: "yolo" }),
    (error: unknown) => assertModeFailure(error, "yolo", /build, plan/),
  );
  assert.equal(readLog().some((entry) => entry.method === "prompt"), false);
});

test("run({ mode }) drives session/set_mode before prompt and strict failures stay non-recoverable", async () => {
  const ok = configure({ modes: MODES, turns: [{ text: "done" }] });
  const runner = makeRunner();

  assert.equal(await runner.run("do it", { model: "claude", cwd: ok.cwd, mode: "plan" }), "done");
  const okWire = methods(ok.readLog());
  assert.ok(okWire.indexOf("setSessionMode") < okWire.indexOf("prompt"));
  // The MODE must ride session/set_mode when response.modes exists. A model-selection
  // setSessionConfigOption (configId "model") is unrelated and allowed on this wire.
  const modeViaConfigOption = ok
    .readLog()
    .some((entry) => entry.method === "setSessionConfigOption" && entry.params?.configId === "mode");
  assert.equal(modeViaConfigOption, false);

  await harness.cleanup();

  const bad = configure({ modes: MODES, turns: [{ text: "unused" }] });
  const badRunner = makeRunner();
  await assert.rejects(
    () => badRunner.run("do it", { model: "claude", cwd: bad.cwd, mode: "nope" }),
    (error: unknown) => assertModeFailure(error, "nope", /default, plan, read-only/),
  );
  assert.equal(bad.readLog().some((entry) => entry.method === "prompt"), false);
});

test("InteractiveSession.setMode switches modes mid-session and updates local state", async () => {
  const { cwd, readLog } = configure({ modes: MODES, turns: [{ text: "ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, model: "claude", mode: "plan" });

  await session.setMode("default");

  const calls = readLog().filter((entry) => entry.method === "setSessionMode");
  assert.deepEqual(
    calls.map((entry) => entry.params?.modeId),
    ["plan", "default"],
  );
  assert.equal(session.modes?.currentModeId, "default");
  await session.release();
});

test("current_mode_update updates the exposed mode state", async () => {
  const { cwd } = configure({ modes: MODES, turns: [{ currentModeId: "default", text: "done" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, model: "claude", mode: "plan" });

  assert.equal(session.modes?.currentModeId, "plan");
  assert.equal((await session.prompt("switch")).text, "done");
  assert.equal(session.modes?.currentModeId, "default");
  await session.release();
});

test("an omitted Claude mode explicitly applies AgentPrism's auto default", async () => {
  const advertised: SessionModeState = {
    currentModeId: "acceptEdits",
    availableModes: [
      { id: "auto", name: "Auto", description: "Use a model classifier" },
      { id: "acceptEdits", name: "Accept Edits" },
    ],
  };
  const { cwd, readLog } = configure({ modes: advertised, turns: [{ text: "done" }] });
  const runner = makeRunner();
  assert.equal(await runner.run("do it", { model: "claude", cwd }), "done");
  const wire = readLog().filter((entry) => entry.method === "setSessionMode" || entry.method === "prompt");
  assert.equal(wire[0]?.method, "setSessionMode");
  assert.equal(wire[0]?.params?.modeId, "auto");
  assert.equal(wire[1]?.method, "prompt");
});

test("an omitted interactive-session mode also applies the AgentPrism default", async () => {
  const advertised: SessionModeState = {
    currentModeId: "acceptEdits",
    availableModes: [
      { id: "auto", name: "Auto", description: "Use a model classifier" },
      { id: "acceptEdits", name: "Accept Edits" },
    ],
  };
  const { cwd, readLog } = configure({ modes: advertised });
  const session = await makeRunner().openSession({ model: "claude", cwd });
  assert.equal(session.modes?.currentModeId, "auto");
  assert.deepEqual(
    readLog().filter((entry) => entry.method === "setSessionMode").map((entry) => entry.params?.modeId),
    ["auto"],
  );
  await session.release();
});

test("an explicit harness mode does not invent a client-side deny policy", async () => {
  const withMode = configure({
    modes: MODES,
    turns: [{ toolCall: { title: "Run shell", kind: "execute" }, text: "done" }],
  });
  const runner = makeRunner();
  assert.equal(await runner.run("do it", { model: "claude", cwd: withMode.cwd, mode: "read-only" }), "done");
  assert.deepEqual(permissionOutcome(withMode.readLog()), ALLOW.outcome);

  await harness.cleanup();

  const withoutMode = configure({
    modes: MODES,
    turns: [{ toolCall: { title: "Run shell", kind: "execute" }, text: "done" }],
  });
  const defaultRunner = makeRunner();
  assert.equal(await defaultRunner.run("do it", { model: "claude", cwd: withoutMode.cwd }), "done");
  assert.deepEqual(permissionOutcome(withoutMode.readLog()), ALLOW.outcome);
});
