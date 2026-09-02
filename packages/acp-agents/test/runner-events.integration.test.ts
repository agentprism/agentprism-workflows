// End-to-end: AcpAgentRunner.on(...) bubbles up REAL ACP events from a live run against the mock
// ACP agent (test/fixtures/fake-acp-agent.mjs). The fake speaks real ACP over stdio, so the whole
// chain — fluent client() connection -> MultiplexClient.sessionUpdate -> emitSessionUpdate -> the runner's
// typed bus -> on() listeners — is exercised; only the agent on the far end is faked.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AcpEventContext,
  AcpRunnerEventMap,
  AcpSessionUpdate,
  AcpUpdateKind,
} from "../src/index.js";
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

  const text = await runner.run("hi", {
    model: MODEL,
    cwd,
    label: "greet",
    runId: "run-1",
    callIndex: 7,
  });

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

const ALL_UPDATE_KINDS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "compaction_update",
  "compaction_summary_chunk",
] as const satisfies readonly AcpUpdateKind[];

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type _AllUpdateKindsComplete = Assert<IsNever<Exclude<AcpUpdateKind, (typeof ALL_UPDATE_KINDS)[number]>>>;
type _AllUpdateKindsExact = Assert<IsNever<Exclude<(typeof ALL_UPDATE_KINDS)[number], AcpUpdateKind>>>;

const ALL_SESSION_UPDATES: AcpSessionUpdate[] = [
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
  { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read" },
  { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
  { sessionUpdate: "plan", entries: [] },
  { sessionUpdate: "plan_update", plan: { type: "items", planId: "plan-1", entries: [] } },
  { sessionUpdate: "plan_removed", planId: "plan-1" },
  { sessionUpdate: "available_commands_update", availableCommands: [] },
  { sessionUpdate: "current_mode_update", currentModeId: "default" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "session_info_update", title: "Correlated session" },
  { sessionUpdate: "usage_update", used: 10, size: 100 },
  // ACP schema 1.21.0 (SDK 1.4.0) — UNSTABLE session compaction updates (#2002).
  { sessionUpdate: "compaction_update", compactionId: "compaction-1", status: "in_progress" },
  { sessionUpdate: "compaction_summary_chunk", compactionId: "compaction-1", content: { type: "text", text: "summary" } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
];

test("callIndex reaches every session event, survives tombstones and retries, and stays off-wire", async () => {
  const callIndex = 987654321;
  const initializeMeta = {
    vendor: "event-fixture",
    nested: { flags: ["complete", "frozen"] },
  };
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } },
      _meta: initializeMeta,
    },
    turns: [
      {
        toolCall: { title: "Read file", kind: "read" },
        elicitation: {
          mode: "url",
          message: "Authorize",
          elicitationId: "url-call-index",
          url: "https://example.test/authorize",
        },
        elicitationComplete: { elicitationId: "url-call-index" },
        updates: ALL_SESSION_UPDATES,
        structuredOutput: { ok: true },
        postCloseUpdates: [{ sessionUpdate: "session_info_update", title: "Late tombstone update" }],
      },
      { text: "retry answer" },
    ],
  });
  const runner = makeRunner({
    onPermissionRequest: async () => ({ outcome: { outcome: "selected", optionId: "allow-1" } }),
    onElicitation: async () => ({ action: "accept" }),
  });
  const observed: Array<{ name: string; event: AcpEventContext }> = [];
  const opened: string[] = [];
  const closed = new Set<string>();
  let lateUpdateAfterClose = false;

  for (const name of ALL_UPDATE_KINDS) {
    runner.on(name, (event) => {
      observed.push({ name, event });
      if (name === "session_info_update" && event.title === "Late tombstone update") {
        lateUpdateAfterClose = closed.has(event.sessionId);
      }
    });
  }
  runner.on("permission_pending", (event) => observed.push({ name: "permission_pending", event }));
  runner.on("permission_request", (event) => observed.push({ name: "permission_request", event }));
  runner.on("elicitation_pending", (event) => observed.push({ name: "elicitation_pending", event }));
  runner.on("elicitation_request", (event) => observed.push({ name: "elicitation_request", event }));
  runner.on("elicitation_complete", (event) => observed.push({ name: "elicitation_complete", event }));
  runner.on("raw_message", (event) => observed.push({ name: "raw_message", event }));
  runner.on("session_open", (event) => {
    opened.push(event.sessionId);
    observed.push({ name: "session_open", event });
  });
  runner.on("session_close", (event) => {
    closed.add(event.sessionId);
    observed.push({ name: "session_close", event });
  });

  const options = { model: MODEL, cwd, label: "correlated", runId: "run-call-index", callIndex };
  assert.equal(await runner.run("first attempt", options), "answer");
  assert.equal(await runner.run("retry attempt", options), "retry answer");

  const names = new Set(observed.map((entry) => entry.name));
  for (const name of ALL_UPDATE_KINDS) assert.ok(names.has(name), `${name} carried context`);
  for (const name of [
    "permission_pending",
    "permission_request",
    "elicitation_pending",
    "elicitation_request",
    "elicitation_complete",
    "raw_message",
    "session_open",
    "session_close",
  ]) {
    assert.ok(names.has(name), `${name} carried context`);
  }
  assert.ok(observed.every(({ event }) => event.callIndex === callIndex));
  assert.ok(observed.every(({ event }) => event.runId === "run-call-index"));
  assert.ok(
    observed.every(({ event }) =>
      assert.deepEqual(event.initializeMeta, initializeMeta) === undefined
    ),
  );
  for (const sessionId of opened) {
    const events = observed.filter(({ event }) => event.sessionId === sessionId);
    assert.ok(events.length > 0);
    assert.ok(
      events.every(({ event }) =>
        event.initializeMeta === events[0].event.initializeMeta
      ),
      "one stable metadata snapshot is shared by every event for a session",
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(observed[0].event)),
    observed[0].event,
  );
  assert.equal(new Set(opened).size, 2, "retry opened a distinct ACP session");
  assert.ok(opened.every((sessionId) => !sessionId.includes(String(callIndex))));
  assert.equal(lateUpdateAfterClose, true, "late update resolved correlation from the tombstone");

  const newSessionRequests = readLog()
    .filter((entry): entry is { method: string; params: Record<string, unknown> } => entry.method === "newSession");
  assert.equal(newSessionRequests.length, 2);
  for (const entry of newSessionRequests) {
    assert.equal("callIndex" in entry.params, false);
    assert.equal(JSON.stringify(entry.params).includes("callIndex"), false);
    assert.equal(JSON.stringify(entry.params).includes("event-fixture"), false);
    assert.deepEqual(entry.params._meta, {
      claudeCode: { options: { title: "AgentPrism: correlated" } },
      runId: "run-call-index",
    });
  }
});

test("direct and interactive sessions omit callIndex", async () => {
  const { cwd } = configure({ turns: [{ text: "direct" }, { text: "interactive" }] });
  const runner = makeRunner();
  const contexts: AcpEventContext[] = [];
  runner.on("session_open", (event) => contexts.push(event));
  runner.on("agent_message_chunk", (event) => contexts.push(event));
  runner.on("session_close", (event) => contexts.push(event));

  assert.equal(await runner.run("direct", { model: MODEL, cwd }), "direct");
  const session = await runner.openSession({ model: MODEL, cwd });
  try {
    assert.equal((await session.prompt("interactive")).text, "direct");
  } finally {
    await session.release();
  }

  assert.ok(contexts.length > 0);
  assert.ok(contexts.every((context) => !("callIndex" in context)));
});

test("backend_error remains connection-scoped", async () => {
  const { cwd } = configure({ turns: [{ crash: true }] });
  const runner = makeRunner();
  const errors: AcpRunnerEventMap["backend_error"][] = [];
  runner.on("backend_error", (event) => errors.push(event));

  await assert.rejects(() => runner.run("crash", { model: MODEL, cwd, callIndex: 12 }));

  assert.equal(errors.length, 1);
  assert.deepEqual(Object.keys(errors[0]).sort(), ["backendId", "error"]);
  assert.equal("sessionId" in errors[0], false);
  assert.equal("runId" in errors[0], false);
  assert.equal("callIndex" in errors[0], false);
});
