// `AcpAgent.stream()` (src/agent/acp-agent.ts + src/agent/stream.ts) against the fake ACP agent:
// event order and the terminal turn, the queue seam (a stream sees ITS turn's events only, a
// queued stream is dropped without going on the wire), an early exit's cancel path, a rejected
// turn's drain-then-throw, a steer's inclusion, and the per-call signal. One fake process per agent.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgent, type AcpAgentStreamEvent, type AcpAgentTurn } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: { sessionId?: string; prompt?: ContentBlock[] };
}

const harness = createFakeAgentHarness({ prefix: "acp-agent-stream-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const methods = (log: LogEntry[]): string[] => log.map((entry) => entry.method);
const count = (log: LogEntry[], method: string): number => methods(log).filter((m) => m === method).length;

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const TOOL_CALL = { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read", kind: "read", status: "in_progress" };
const TOOL_DONE = { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "x" };

async function collect(stream: AsyncIterable<AcpAgentStreamEvent>): Promise<AcpAgentStreamEvent[]> {
  const events: AcpAgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const types = (events: readonly AcpAgentStreamEvent[]): string[] => events.map((event) => event.type);
function terminal(events: readonly AcpAgentStreamEvent[]): AcpAgentTurn {
  const last = events[events.length - 1];
  assert.ok(last && last.type === "turn", `the last event is the turn, got ${last?.type}`);
  return last.turn;
}

/** A turn without its wall-clock fields and the running session sum, for cross-turn comparison. */
function comparable(turn: AcpAgentTurn) {
  const { updates, raw, history, messages, usage, ...rest } = turn;
  return {
    ...rest,
    updates: updates.map((record) => record.update),
    raw: raw.map((record) => ({ method: record.method, message: record.message })),
    history: history.map(({ timestamp: _timestamp, ...entry }) => entry),
    messages: messages.map(({ receivedAt: _receivedAt, ...message }) => message),
    usage: { turn: usage.turn, response: usage.response },
  };
}

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0, "every dedicated connection was released");
});

test("events arrive in wire order under their own kind (never session_update) and end with the turn prompt() would return", async () => {
  const { cwd } = configure({
    turns: [
      {
        toolCall: { toolCallId: "tc-1", title: "Read", kind: "read" },
        updates: [chunk("narration"), TOOL_CALL, TOOL_DONE],
        text: "answer",
        usageUpdate: { used: 5, size: 100 },
        structuredOutput: { ok: true },
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude", label: "s" }));
  const events = await collect(agent.stream("go"));
  assert.deepEqual(types(events), [
    "session_open", // the lazy open ran inside this turn's operation
    "permission_request",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "agent_message_chunk",
    "usage_update",
    "raw_message",
    "turn",
  ]);
  for (const event of events) {
    assert.equal("update" in event, false, "an update is yielded under its kind, never as the catch-all");
    if (event.type !== "turn" && event.type !== "backend_error") assert.equal(event.sessionId, agent.sessionId);
  }
  const [, permission, first, toolCall, toolDone, second, usage, raw] = events;
  assert.ok(permission!.type === "permission_request" && permission.outcome.outcome.outcome === "selected");
  assert.ok(first!.type === "agent_message_chunk" && first.content.type === "text" && first.content.text === "narration");
  assert.ok(toolCall!.type === "tool_call" && toolCall.toolCallId === "tc-1" && toolCall.label === "s");
  assert.ok(toolDone!.type === "tool_call_update" && toolDone.status === "completed");
  assert.ok(second!.type === "agent_message_chunk" && second.content.type === "text" && second.content.text === "answer");
  assert.ok(usage!.type === "usage_update" && usage.used === 5);
  assert.ok(raw!.type === "raw_message" && raw.method === "_claude/sdkMessage");

  const streamed = terminal(events);
  assert.equal(streamed.text, "narration\n\nanswer");
  assert.deepEqual(streamed.toolCalls.map((call) => call.status), ["completed"]);
  assert.equal(streamed.permissions.length, 1);
  assert.equal(streamed.raw.length, 1);
  assert.deepEqual(streamed.usage.turn, { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0 });

  // The same script served again by prompt(): the terminal event IS the turn prompt() returns.
  const prompted = await agent.prompt("go");
  assert.deepEqual(comparable(streamed), comparable(prompted));
  assert.deepEqual(prompted.usage.session, { input: 6, output: 4, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0 });
  assert.equal(agent.state, "ready");
});

test("breaking out early cancels the in-flight turn (one session/cancel), awaits it, and leaves the agent usable", async () => {
  const { cwd, readLog } = configure({
    turns: [{ updates: [chunk("partial")], waitForCancel: true, parkAfterUpdates: true }, { text: "after" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const seen: string[] = [];
  for await (const event of agent.stream("park")) {
    seen.push(event.type);
    if (event.type === "agent_message_chunk") break;
  }
  assert.deepEqual(seen, ["agent_message_chunk"]);
  assert.equal(agent.state, "ready", "return() resolved only once the cancelled turn settled");
  assert.equal(count(readLog(), "cancel"), 1, "ONE session/cancel for the abandoned turn");
  assert.equal(methods(readLog()).includes("closeSession"), false);
  assert.equal((await agent.prompt("next")).text, "after");
  assert.equal(count(readLog(), "cancel"), 1);
});

test("throw() cancels like return() and rethrows to the caller; a finished stream stays done", async () => {
  const { cwd, readLog } = configure({
    turns: [{ updates: [chunk("partial")], waitForCancel: true, parkAfterUpdates: true }, { text: "after" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const stream = agent.stream("park");
  assert.equal(stream[Symbol.asyncIterator](), stream, "an async iterable that is its own iterator");
  const first = await stream.next();
  assert.ok(!first.done && first.value.type === "agent_message_chunk");
  await assert.rejects(() => stream.throw(new Error("stop here")), /stop here/);
  assert.equal(agent.state, "ready");
  assert.equal(count(readLog(), "cancel"), 1);
  assert.deepEqual(await stream.next(), { value: undefined, done: true });
  assert.deepEqual(await stream.return(), { value: undefined, done: true }, "idempotent after the exit");
  assert.equal((await agent.prompt("next")).text, "after");
});

test("a rejected turn yields its buffered events, then throws that same error once", async () => {
  const { cwd } = configure({ turns: [{ updates: [chunk("x")], text: "y", throw: "boom" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const stream = agent.stream("go");
  const seen: string[] = [];
  await assert.rejects(
    async () => {
      for await (const event of stream) seen.push(event.type);
    },
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.match(error.message, /boom/);
      return true;
    },
  );
  assert.deepEqual(seen, ["agent_message_chunk", "agent_message_chunk"], "everything before the rejection was delivered");
  assert.deepEqual(await stream.next(), { value: undefined, done: true }, "thrown once, then done");
  assert.equal(agent.state, "ready");
});

test("two queued streams never see each other's events; a queued stream left early never reaches the wire", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "one" }, { text: "two" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));

  // Three streams queued at once: the first parks on the wire, the second is abandoned while
  // still queued, the third runs after the first settles.
  const parked = agent.stream("park");
  const abandoned = agent.stream("abandoned");
  const third = agent.stream("three");
  const parkedEvents = collect(parked);
  const thirdEvents = collect(third);
  await waitFor(() => methods(readLog()).includes("prompt"));
  assert.equal(agent.state, "busy");

  assert.deepEqual(await abandoned.return(), { value: undefined, done: true }, "resolves while the first turn is still parked");
  assert.deepEqual(await abandoned.next(), { value: undefined, done: true });

  await agent.cancel();
  const first = await parkedEvents;
  assert.deepEqual(types(first), ["turn"]);
  assert.equal(terminal(first).stopReason, "cancelled");
  const second = await thirdEvents;
  assert.deepEqual(types(second), ["agent_message_chunk", "turn"], "the third stream saw only its own chunk");
  assert.equal(terminal(second).text, "one", "the abandoned stream consumed no scripted turn: turns[1] served the third");
  const prompts = readLog().filter((entry) => entry.method === "prompt");
  assert.deepEqual(
    prompts.map((entry) => entry.params?.prompt?.[0]),
    [{ type: "text", text: "park" }, { type: "text", text: "three" }],
    "exactly two session/prompt requests: the abandoned turn was never sent",
  );
  assert.equal(count(readLog(), "cancel"), 1);
});

test("two concurrently consumed streams each get their own turn's events", async () => {
  const { cwd } = configure({ turns: [{ updates: [chunk("one"), TOOL_CALL], text: [] }, { text: "two" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const [first, second] = await Promise.all([collect(agent.stream("1")), collect(agent.stream("2"))]);
  assert.deepEqual(types(first), ["agent_message_chunk", "tool_call", "turn"]);
  assert.deepEqual(types(second), ["agent_message_chunk", "turn"]);
  assert.equal(terminal(first).text, "one");
  assert.equal(terminal(second).text, "two");
  assert.deepEqual(terminal(second).toolCalls, [], "the first turn's tool call never leaked into the second");
});

test("a steer() during the stream is included as its steering event", async () => {
  const { cwd, readLog } = configure({
    extensionRequest: { method: "_session/steering", response: { outcome: "injected" } },
    turns: [{ waitForCancel: true }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const events = collect(agent.stream("park"));
  await waitFor(() => methods(readLog()).includes("prompt"));
  assert.deepEqual(await agent.steer("nudge"), { outcome: "injected" });
  await agent.cancel();
  const seen = await events;
  assert.deepEqual(types(seen), ["steering", "turn"]);
  const [steering] = seen;
  assert.ok(steering!.type === "steering");
  assert.deepEqual(steering.response, { outcome: "injected" });
  assert.equal(terminal(seen).stopReason, "cancelled");
});

test("the caller's per-call signal aborts the stream with its own reason; the agent stays ready", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "after" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const reason = new Error("mine");
  const controller = new AbortController();
  const events = collect(agent.stream("park", { signal: controller.signal }));
  await waitFor(() => methods(readLog()).includes("prompt"));
  controller.abort(reason);
  await assert.rejects(events, (error: unknown) => error === reason);
  assert.equal(count(readLog(), "cancel"), 1);
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("next")).text, "after");

  // Already aborted before the call: nothing is queued, the first next() throws the reason.
  const early = agent.stream("never", { signal: AbortSignal.abort(reason) });
  await assert.rejects(early.next(), (error: unknown) => error === reason);
  assert.equal(count(readLog(), "prompt"), 2);
});

test("stream() on a closed agent throws the closed error on the first next()", async () => {
  const { cwd } = configure({ turns: [{ text: "x" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  await agent.close();
  const stream = agent.stream("late");
  await assert.rejects(stream.next(), (error: unknown) => {
    assert.ok(isWorkflowError(error));
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.match(error.message, /is closed/);
    return true;
  });
  assert.deepEqual(await stream.next(), { value: undefined, done: true });
});
