// Mid-session model switching against the fake: `agent.setModel(spec)` (queued FIFO like
// `setMode`) and the per-turn `prompt(…, { model })`. Both resolve the spec with the fork rule
// (same backend, same poolKey), send `session/set_config_option { configId: "model" }` with the
// routed remainder verbatim — the mechanism open uses — and move `agent.model` to the routed spec
// so forks and a cold reopen passing `agent.model` back inherit the switch. A wire rejection maps
// through the normal error path and moves nothing. Every agent is its own dedicated fake process.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgent } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  pid?: number;
  params?: {
    sessionId?: string;
    configId?: string;
    modeId?: string;
    value?: string | boolean;
    prompt?: ContentBlock[];
  };
}

const MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};
const MODEL: SessionConfigOption = {
  id: "model",
  type: "select",
  name: "Model",
  category: "model",
  currentValue: "default-model",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet" },
    { value: "default-model", name: "Default" },
  ],
};
const EFFORT: SessionConfigOption = {
  id: "effort",
  type: "select",
  name: "Effort",
  currentValue: "low",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};

const harness = createFakeAgentHarness({ prefix: "acp-agent-set-model-it-", backends: ["claude", "pi"] });
const configure = (scenario: unknown, options?: Parameters<typeof harness.configure>[1]) =>
  harness.configure<LogEntry>(scenario, options);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const count = (log: LogEntry[], method: string): number => log.filter((entry) => entry.method === method).length;
const modelValue = (agent: AcpAgent): unknown => agent.configOptions.find((option) => option.id === "model")?.currentValue;

/** One wire call as `method`, `method:configId=value`, `method:modeId`, or `prompt:<text>`. */
function describe(entry: LogEntry): string {
  switch (entry.method) {
    case "setSessionConfigOption":
      return `${entry.method}:${entry.params?.configId}=${String(entry.params?.value)}`;
    case "setSessionMode":
      return `${entry.method}:${entry.params?.modeId}`;
    case "prompt":
      return `${entry.method}:${(entry.params?.prompt ?? []).map((block) => (block.type === "text" ? block.text : "")).join("")}`;
    default:
      return entry.method;
  }
}

/** The session-scoped wire after the session was created (`__*` lifecycle markers dropped). */
function wireAfterOpen(log: LogEntry[], method: "newSession" | "resumeSession", sessionId: string | undefined): string[] {
  const open = log.findIndex((entry) => entry.method === method && (method === "newSession" || entry.params?.sessionId === sessionId));
  assert.ok(open >= 0, `${method} for ${sessionId} on the wire`);
  return log
    .slice(open + 1)
    .filter((entry) => !entry.method.startsWith("__") && (entry.params?.sessionId === undefined || entry.params.sessionId === sessionId))
    .map(describe);
}

function validation(pattern: RegExp, label?: string) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.equal(error.recoverable, false);
    if (label !== undefined) assert.equal(error.agentLabel, label);
    assert.match(error.message, pattern);
    return true;
  };
}

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("setModel queues FIFO behind the in-flight turn, sends set_config_option model=<id> then the next prompt, adopts the echoed catalog, and moves agent.model", async () => {
  const { cwd, readLog } = configure({
    configOptions: [MODEL],
    turns: [{ delayMs: 150, text: "one" }, { text: "two" }, { text: "three" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude/opus" }));
  assert.equal(agent.model, "claude/opus");
  assert.equal(modelValue(agent), "opus");

  const first = agent.prompt("one");
  const switched = agent.setModel("claude/sonnet");
  const second = agent.prompt("two");
  await waitFor(() => count(readLog(), "prompt") === 1);
  assert.deepEqual(
    wireAfterOpen(readLog(), "newSession", agent.sessionId),
    ["setSessionConfigOption:model=opus", "prompt:one"],
    "the switch waits behind the turn in flight",
  );
  assert.equal(agent.model, "claude/opus", "not moved until the switch applied");

  assert.equal((await first).text, "one");
  await switched;
  assert.equal(agent.model, "claude/sonnet", "the routed spec form, <backendId>/<id>");
  assert.equal(modelValue(agent), "sonnet", "the echoed catalog is adopted");
  assert.equal((await second).text, "two");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId), [
    "setSessionConfigOption:model=opus",
    "prompt:one",
    "setSessionConfigOption:model=sonnet",
    "prompt:two",
  ]);
  assert.equal(agent.state, "ready");

  // The unrouted form goes to the default backend (claude here) — the fork rule, so it passes on
  // a claude agent — and is still sent verbatim.
  await agent.setModel("default-model");
  assert.equal(agent.model, "claude/default-model");
  assert.equal(modelValue(agent), "default-model");
  assert.equal((await agent.prompt("three")).text, "three");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId).slice(4), [
    "setSessionConfigOption:model=default-model",
    "prompt:three",
  ]);
});

test("a switched model is inherited by a later fork and by a cold resume that passes agent.model back; the ref itself carries none", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    resumeSession: {},
    configOptions: [MODEL],
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ text: "parent" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude/opus" }));
  await parent.prompt("first");
  await parent.setModel("claude/sonnet");

  const child = track(await parent.fork());
  assert.equal(child.model, "claude/sonnet", "the model the parent is on now, not its constructor option");
  assert.equal(modelValue(child), "sonnet");
  assert.deepEqual(
    wireAfterOpen(readLog(), "resumeSession", child.sessionId),
    ["setSessionConfigOption:model=sonnet"],
    "re-applied on the reattached fork before its first turn",
  );
  assert.equal((await child.prompt("go")).text, "child");

  const overridden = track(await parent.fork({ model: "claude/default-model" }));
  assert.equal(overridden.model, "claude/default-model", "an explicit override still wins over the inherited switch");
  assert.equal(parent.model, "claude/sonnet", "the parent is unaffected by its forks");

  const ref = parent.sessionRef!;
  await parent.close({ keep: true });
  assert.equal("model" in ref, false, "the ref carries no model");
  const resumed = track(await AcpAgent.resume(ref, { model: parent.model }));
  assert.equal(resumed.model, "claude/sonnet");
  assert.equal(modelValue(resumed), "sonnet");
  const resumes = readLog().filter((entry) => entry.method === "resumeSession" && entry.params?.sessionId === ref.sessionId);
  assert.equal(resumes.length, 1);
  const selectedAfterResume = readLog()
    .filter((entry) => entry.pid === resumes[0]!.pid && entry.method === "setSessionConfigOption")
    .map(describe);
  assert.deepEqual(selectedAfterResume, ["setSessionConfigOption:model=sonnet"], "the passed-back model is selected on the fresh process");
  // A fresh fake process serves its script from `turns[0]` again; the point is that the turn ran.
  assert.equal((await resumed.prompt("second")).text, "parent");

  // Without `model` the reopen selects nothing: the switch lives in the agent, never in the ref.
  const selections = count(readLog(), "setSessionConfigOption");
  const plain = track(await AcpAgent.resume(ref));
  assert.equal(plain.model, undefined);
  assert.equal(count(readLog(), "setSessionConfigOption"), selections, "no model passed back: no selection on the wire");
});

test("a spec routing to another backend, a backend-only spec, and a blank spec are INVALID_ARGUMENT before anything is sent; model is unchanged", async () => {
  const { cwd, readLog } = configure({ configOptions: [MODEL], turns: [{ text: "ok" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude/opus", label: "primary" }));
  const before = readLog().length;

  await assert.rejects(
    () => agent.setModel("codex/gpt-5.6-sol"),
    validation(/^AcpAgent\.setModel\(\): model "codex\/gpt-5\.6-sol" routes to backend "codex" but must stay on backend "claude"$/, "primary"),
  );
  await assert.rejects(
    () => agent.setModel("pi/openrouter/some-model"),
    validation(/routes to backend "pi" but must stay on backend "claude"/, "primary"),
  );
  await assert.rejects(
    () => agent.setModel("claude"),
    validation(/^AcpAgent\.setModel\(\): model "claude" names backend "claude" but no model id; use "claude\/<model id>"$/, "primary"),
  );
  await assert.rejects(() => agent.setModel("claude/"), validation(/no model id/, "primary"));
  await assert.rejects(() => agent.setModel("   "), validation(/^AcpAgent\.setModel\(\) requires a non-empty model spec/, "primary"));
  await assert.rejects(() => agent.setModel(undefined as never), validation(/requires a non-empty model spec/, "primary"));

  assert.equal(readLog().length, before, "none of the rejections reached the wire");
  assert.equal(agent.model, "claude/opus");
  assert.equal(modelValue(agent), "opus");
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("hi")).text, "ok");

  // The flip side of the unrouted rule: on a non-default backend a bare id routes to the default
  // backend (claude) and is refused — the spec has to name this backend.
  const pi = track(await AcpAgent.open({ cwd, model: "pi", label: "pi-agent" }));
  await assert.rejects(
    () => pi.setModel("sonnet"),
    validation(/^AcpAgent\.setModel\(\): model "sonnet" routes to backend "claude" but must stay on backend "pi"$/, "pi-agent"),
  );
  await pi.setModel("pi/openrouter/some-model");
  assert.equal(pi.model, "pi/openrouter/some-model");
  assert.equal(modelValue(pi), "openrouter/some-model", "the remainder after the backend segment, verbatim");

  // A registered custom backend routes by its name; a built-in name is another backend.
  const backends = { fake: { command: process.execPath, args: [FAKE_AGENT_FIXTURE] } };
  const custom = track(await AcpAgent.open({ cwd, model: "fake", backends, label: "custom" }));
  await assert.rejects(
    () => custom.setModel("claude/opus"),
    validation(/routes to backend "claude" but must stay on backend "fake"/, "custom"),
  );
  await custom.setModel("fake/Some.Model[high]");
  assert.equal(custom.model, "fake/Some.Model[high]");
  assert.equal(modelValue(custom), "Some.Model[high]");
});

test("setModel on an agent that has not opened yet refuses a spec that leaves its backend with nothing spawned: the log stays empty and the agent stays idle", async () => {
  const { cwd, readLog } = configure({ configOptions: [MODEL], turns: [{ text: "ok" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude/opus", label: "cold" }));
  assert.equal(agent.state, "idle");

  await assert.rejects(
    () => agent.setModel("codex/gpt-5.6-sol"),
    validation(/^AcpAgent\.setModel\(\): model "codex\/gpt-5\.6-sol" routes to backend "codex" but must stay on backend "claude"$/, "cold"),
  );
  await assert.rejects(() => agent.setModel("claude"), validation(/no model id/, "cold"));
  await assert.rejects(() => agent.setModel(""), validation(/requires a non-empty model spec/, "cold"));
  assert.equal(readLog().length, 0, "the route is checked before the operation is queued: no process was spawned");
  assert.equal(agent.state, "idle");
  assert.equal(agent.model, "claude/opus");

  // A spec that stays on the backend queues the switch ahead of the open like any other operation.
  await agent.setModel("claude/sonnet");
  assert.equal(agent.state, "ready");
  assert.equal(agent.model, "claude/sonnet");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId), [
    "setSessionConfigOption:model=opus",
    "setSessionConfigOption:model=sonnet",
  ]);
  assert.equal((await agent.prompt("hi")).text, "ok");
});

test("a model value the agent rejects maps through the normal error path (recoverable AGENT_EXECUTION_ERROR); model is unchanged and the agent stays usable", async () => {
  const { cwd, readLog } = configure({
    setConfigOptionError: "unknown model id",
    configOptions: [MODEL],
    turns: [{ text: "ok" }, { text: "still ok" }],
  });
  // Backend-only at open: no selection is sent, so the open itself succeeds.
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  assert.equal(agent.model, undefined);

  const wireError = (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(error.recoverable, true);
    assert.match(error.message, /unknown model id/);
    return true;
  };
  await assert.rejects(() => agent.setModel("claude/nope"), wireError);
  assert.equal(count(readLog(), "setSessionConfigOption"), 1, "the one request the agent rejected — no retry, no fallback");
  assert.equal(agent.model, undefined, "a rejected switch moves nothing");
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("hi")).text, "ok");

  // The per-turn form rejects the turn the same way and sends no prompt.
  await assert.rejects(() => agent.prompt("never sent", { model: "claude/nope" }), wireError);
  assert.equal(count(readLog(), "setSessionConfigOption"), 2);
  assert.equal(count(readLog(), "prompt"), 1, "the turn never reached the wire");
  assert.equal(agent.model, undefined);
  assert.equal((await agent.prompt("again")).text, "still ok");
});

test("per-turn model applies first — model, configOptions, mode — then the prompt; it sticks; a spec routing elsewhere rejects the turn before any option is sent", async () => {
  const { cwd, readLog } = configure({
    modes: MODES,
    configOptions: [MODEL, EFFORT],
    turns: [{ text: "x" }, { text: "y" }, { text: "z" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude/opus" }));
  const turn = await agent.prompt("x", { model: "claude/sonnet", configOptions: { effort: "high" }, mode: "plan" });
  assert.equal(turn.text, "x");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId), [
    "setSessionConfigOption:model=opus",
    "setSessionConfigOption:model=sonnet",
    "setSessionConfigOption:effort=high",
    "setSessionMode:plan",
    "prompt:x",
  ]);
  assert.equal(agent.model, "claude/sonnet");
  assert.equal(modelValue(agent), "sonnet");
  assert.equal(agent.configOptions.find((option) => option.id === "effort")?.currentValue, "high");
  assert.equal(agent.modes?.currentModeId, "plan");

  // Sticky: the next turn re-sends nothing.
  await agent.prompt("y");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId).slice(5), ["prompt:y"]);

  // Validation covers every per-turn option before anything is sent: a rejected model means the
  // passing configOptions/mode of the same call are not sent either.
  const before = readLog().length;
  await assert.rejects(
    () => agent.prompt("never sent", { model: "codex/x", configOptions: { effort: "low" }, mode: "default" }),
    validation(/^AcpAgent\.prompt\(\{ model \}\): model "codex\/x" routes to backend "codex" but must stay on backend "claude"$/),
  );
  await assert.rejects(() => agent.prompt("never sent", { model: "claude" }), validation(/no model id/));
  await assert.rejects(() => agent.prompt("never sent", { model: "" }), validation(/requires a non-empty model spec/));
  assert.equal(readLog().length, before, "nothing reached the wire");
  assert.equal(agent.model, "claude/sonnet");
  assert.equal(agent.configOptions.find((option) => option.id === "effort")?.currentValue, "high");
  assert.equal(agent.modes?.currentModeId, "plan");
  assert.equal(agent.state, "ready");

  // `stream()` is the same turn body, so the per-turn model rides it too — and a refusal names
  // the entry point actually used, not `prompt()`.
  await assert.rejects(
    () => agent.stream("never sent", { model: "codex/x" }).next(),
    validation(/^AcpAgent\.stream\(\{ model \}\): model "codex\/x" routes to backend "codex" but must stay on backend "claude"$/),
  );
  await assert.rejects(
    () => agent.stream("never sent", { schemaRetries: -1 }).next(),
    validation(/^AcpAgent\.stream\(\{ schemaRetries \}\): schemaRetries must be an integer >= 0/),
  );
  assert.equal(wireAfterOpen(readLog(), "newSession", agent.sessionId).length, 6, "neither refused stream reached the wire");
  let terminal = 0;
  for await (const event of agent.stream("z", { model: "claude/default-model" })) {
    if (event.type === "turn") terminal += 1;
  }
  assert.equal(terminal, 1);
  assert.equal(agent.model, "claude/default-model");
  assert.deepEqual(wireAfterOpen(readLog(), "newSession", agent.sessionId).slice(6), [
    "setSessionConfigOption:model=default-model",
    "prompt:z",
  ]);
});
