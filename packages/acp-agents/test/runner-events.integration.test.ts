// End-to-end: AcpAgentRunner.on(...) bubbles up REAL ACP events from a live run against the mock
// ACP agent (test/fixtures/fake-acp-agent.mjs). The fake speaks real ACP over stdio, so the whole
// chain — fluent client() connection -> MultiplexClient.sessionUpdate -> emitSessionUpdate -> the runner's
// typed bus -> on() listeners — is exercised; only the agent on the far end is faked.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { type AcpRunnerEventMap } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const MODEL = "claude/claude-opus-4-1"; // routes to the Claude backend (both point at the fake)

const harness = createFakeAgentHarness({ prefix: "acp-evt-" });
const { makeRunner } = harness;
const configure = (scenario: unknown) => harness.configure(scenario);

afterEach(async () => {
  await harness.cleanup();
});

test("on() bubbles agent_message_chunk + usage_update + session lifecycle with run context", async () => {
  const { cwd } = configure({
    turns: [{ text: ["Hel", "lo"], usageUpdate: { used: 42, size: 200000, cost: { amount: 0.07, currency: "USD" } } }],
  });
  const runner = makeRunner();

  const chunks: string[] = [];
  const wild: string[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let usageSeen = false;

  runner.on("agent_message_chunk", (e) => {
    assert.equal(e.backendId, "claude");
    assert.equal(e.label, "greet");
    assert.equal(e.runId, "run-1");
    assert.ok(e.sessionId, "event carries a sessionId");
    if (e.content.type === "text") chunks.push(e.content.text);
  });
  runner.on("session_update", (e) => wild.push(e.update.sessionUpdate));
  runner.on("usage_update", (e) => {
    usageSeen = true;
    assert.equal(e.used, 42);
  });
  runner.on("session_open", (e) => opened.push(e.sessionId));
  runner.on("session_close", (e) => closed.push(e.sessionId));

  const text = await runner.run("hi", { model: MODEL, cwd, label: "greet", runId: "run-1" });

  assert.equal(text, "Hello");
  assert.deepEqual(chunks, ["Hel", "lo"], "both streamed chunks were delivered, in order");
  assert.ok(usageSeen, "usage_update event fired");
  assert.ok(
    wild.includes("agent_message_chunk") && wild.includes("usage_update"),
    "the session_update catch-all saw every kind",
  );
  assert.equal(opened.length, 1, "exactly one session opened");
  assert.deepEqual(closed, opened, "the opened session was closed on release");
});

test("on() surfaces permission_request and raw_message; off()/the disposer unsubscribe", async () => {
  const { cwd } = configure({
    turns: [{ toolCall: { title: "read file", kind: "read" }, text: "done", structuredOutput: { ok: true } }],
  });
  const runner = makeRunner();

  const perms: string[] = [];
  const raws: string[] = [];
  const permListener = (e: AcpRunnerEventMap["permission_request"]) => {
    perms.push(e.request.toolCall.title ?? "");
    assert.ok(e.outcome.outcome, "a decision was attached to the permission event");
  };
  runner.on("permission_request", permListener);
  const offRaw = runner.on("raw_message", (e) => raws.push(e.method));

  await runner.run("go", { model: MODEL, cwd });

  assert.deepEqual(perms, ["read file"], "permission request bubbled with its title");
  assert.deepEqual(raws, ["_claude/sdkMessage"], "the vendor raw message bubbled");

  // Unsubscribe both ways; a second (identical) run must not re-notify either listener.
  offRaw();
  runner.off("permission_request", permListener);
  await runner.run("again", { model: MODEL, cwd });

  assert.deepEqual(perms, ["read file"], "removed permission listener no longer fires");
  assert.deepEqual(raws, ["_claude/sdkMessage"], "disposed raw listener no longer fires");
});
