// The AcpAgent SDK front door (src/agent/acp-agent.ts) against the fake ACP agent: lazy open,
// the state walk, verbatim turns, per-turn usage, the FIFO, steer/cancel overlap, the
// agent-owned cancel escalation, per-turn options, close semantics, process death, both abort
// signals, pre-spawn validation, wire-error mapping, history retention, per-agent events, and
// permission/elicitation capture. Every test uses one dedicated fake process per agent.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type {
  ContentBlock,
  CreateElicitationResponse,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  CODEX_AIR_EXTENSION_VERSION,
  CODEX_AIR_META_KEYS,
  isWorkflowError,
  WorkflowErrorCode,
} from "@automatalabs/shared-types";
import {
  AcpAgent,
  isAcpAgentTurnError,
  mapTypedSessionFailure,
  type AcpAgentMessage,
  type AcpAgentTurn,
  type TypedSessionFailure,
} from "../../src/index.js";
import { setCancelGraceForTests } from "../../src/agent/acp-agent.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
  pid?: number;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    cwd?: string;
    configId?: string;
    modeId?: string;
    value?: string | boolean;
    prompt?: ContentBlock[];
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
    clientCapabilities?: Record<string, unknown>;
  };
}

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const ELICITATION_ACCEPT: CreateElicitationResponse = { action: "accept", content: { answer: "x" } };

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

const harness = createFakeAgentHarness({ prefix: "acp-agent-it-", backends: ["claude"] });
const configure = (scenario: unknown, options?: Parameters<typeof harness.configure>[1]) =>
  harness.configure<LogEntry>(scenario, options);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);

/** Every logged method in order, `__start`/`__exit` markers included. */
const methods = (log: LogEntry[]): string[] => log.map((entry) => entry.method);
const count = (log: LogEntry[], method: string): number => methods(log).filter((m) => m === method).length;
const permissionOutcomes = (log: LogEntry[]) =>
  log.filter((entry) => entry.method === "permissionOutcome").map((entry) => entry.outcome);
const find = (log: LogEntry[], method: string): LogEntry | undefined => log.find((entry) => entry.method === method);

/** Messages without their wall-clock field (the agent's tap and the turn's tap each read the clock). */
const undated = (messages: readonly AcpAgentMessage[]) => messages.map(({ receivedAt: _receivedAt, ...message }) => message);
const textOf = (message: AcpAgentMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
/** The documented relationship: the TEXT-BEARING assistant messages joined by a blank line. */
const assistantText = (messages: readonly AcpAgentMessage[]): string =>
  messages
    .filter((message) => message.role === "assistant" && message.content.some((block) => block.type === "text"))
    .map(textOf)
    .join("\n\n");

function isCode(code: WorkflowErrorCode, extra?: (error: Error & Record<string, unknown>) => void) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, code);
    extra?.(error as unknown as Error & Record<string, unknown>);
    return true;
  };
}

/** A typed failure record in codex-acp's shape and the `_meta` envelope of the negotiated extension. */
function failureRecord(overrides: Partial<TypedSessionFailure> = {}): TypedSessionFailure {
  return {
    id: "turn-1:error",
    revision: 1,
    category: "limit",
    severity: "error",
    title: "The Codex usage quota is exhausted.",
    actions: ["retry"],
    ...overrides,
  } as TypedSessionFailure;
}
function failureMeta(record: TypedSessionFailure, siblings: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...siblings,
    [CODEX_AIR_META_KEYS.namespace]: {
      [CODEX_AIR_META_KEYS.extension]: {
        [CODEX_AIR_META_KEYS.version]: CODEX_AIR_EXTENSION_VERSION,
        [CODEX_AIR_META_KEYS.sessionFailure]: record,
      },
    },
  };
}

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0, "every dedicated connection was released");
});

// ---- open / state ---------------------------------------------------------------------------

test("the constructor is lazy and ready() is idempotent", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  assert.deepEqual(readLog(), [], "nothing spawned by the constructor");
  assert.equal(agent.state, "idle");
  assert.equal(agent.sessionId, undefined);
  assert.equal(agent.model, undefined, "a backend-only spec selects no model");
  // `model` is the routed spec in canonical form: it leads back to the same backend and model id.
  assert.equal(new AcpAgent({ cwd, model: "Claude/opus[1m]" }).model, "claude/opus[1m]");
  const unrouted = new AcpAgent({ cwd, model: "gpt-5" });
  assert.equal(unrouted.model, `${unrouted.backendId}/gpt-5`, "an unrouted spec is pinned to the backend it routed to");
  assert.deepEqual(readLog(), [], "still nothing spawned");

  await Promise.all([agent.ready(), agent.ready()]);
  assert.equal(count(readLog(), "__start"), 1, "exactly one process");
  assert.equal(count(readLog(), "newSession"), 1, "exactly one session/new");
  assert.equal(agent.state, "ready");
  assert.equal(typeof agent.sessionId, "string");
  assert.equal(agent.backendId, "claude");
  assert.equal(agent.capabilities?.agent.sessionCapabilities?.close !== undefined, true);

  await agent.ready();
  assert.equal(count(readLog(), "newSession"), 1, "ready() after open is a no-op");
});

test("state walks idle → opening → ready → busy → ready → closed", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  assert.equal(agent.state, "idle");
  const ready = agent.ready();
  assert.equal(agent.state, "opening");
  await ready;
  assert.equal(agent.state, "ready");

  const parked = agent.prompt("park");
  assert.equal(agent.state, "busy");
  await waitFor(() => methods(readLog()).includes("prompt"));
  assert.equal(agent.state, "busy");
  await agent.cancel();
  assert.equal((await parked).stopReason, "cancelled");
  assert.equal(agent.state, "ready");

  const closing = agent.close();
  assert.equal(agent.state, "closed", "closed the instant close() is called");
  await closing;
  assert.equal(agent.state, "closed");
});

// ---- turns ----------------------------------------------------------------------------------

test("prompt returns the verbatim response with _meta, every update, raw messages, folded text, and correlated tool calls", async () => {
  const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
  const { cwd } = configure({
    turns: [
      {
        updates: [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "narration" }, _meta: { m: 1 } },
          { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read", kind: "read", status: "in_progress", name: "read_file", _meta: { vendor: 1 } },
          { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "x" },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" }, _meta: { m: 2 } },
        ],
        text: [],
        structuredOutput: { ok: true },
        responseMeta: { quota: { token_count: 1 } },
        usage,
      },
    ],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  const turn = await agent.prompt("hi");

  assert.deepEqual(turn.response._meta, { quota: { token_count: 1 } }, "the wire _meta is intact");
  assert.deepEqual(turn.response, { stopReason: "end_turn", usage, _meta: { quota: { token_count: 1 } } });
  assert.equal(turn.stopReason, "end_turn");
  assert.equal("failure" in turn, false, "a turn never carries a failure field (a walled turn rejects, §15.4)");
  assert.equal(turn.updates.length, 4);
  const toolCall = turn.updates[1]!.update;
  assert.equal(toolCall.sessionUpdate, "tool_call");
  assert.equal(toolCall.sessionUpdate === "tool_call" && toolCall.name, "read_file");
  assert.deepEqual(toolCall._meta, { vendor: 1 });
  assert.deepEqual(turn.updates[0]!.update._meta, { m: 1 });
  assert.equal(turn.raw.length, 1);
  assert.equal(turn.raw[0]!.method, "_claude/sdkMessage");
  assert.deepEqual(turn.raw[0]!.message, { type: "result", subtype: "success", structured_output: { ok: true } });
  assert.deepEqual(turn.toolCalls, [
    { toolCallId: "tc-1", name: "read_file", title: "Read", kind: "read", status: "completed", rawOutput: "x", meta: { vendor: 1 } },
  ]);
  assert.equal(turn.text, "narration\n\nanswer", "distinct assistant messages join with a blank line");
  assert.equal(agent.text, turn.text, "the session text uses the same fold");
  assert.deepEqual(
    turn.messages.map(({ receivedAt, ...message }) => ({ ...message, dated: typeof receivedAt === "number" })),
    [
      {
        role: "assistant",
        content: [{ type: "text", text: "narration" }],
        toolCalls: [{ toolCallId: "tc-1", name: "read_file", title: "Read", kind: "read", status: "completed", rawOutput: "x", meta: { vendor: 1 } }],
        thoughts: [],
        dated: true,
      },
      { role: "assistant", content: [{ type: "text", text: "answer" }], toolCalls: [], thoughts: [], dated: true },
    ],
    "messages: the same fold per message, with the tool call attached to the message that issued it",
  );
  assert.equal(turn.messages[0]!.receivedAt, turn.updates[0]!.receivedAt, "dated by its first update");
  assert.deepEqual(undated(agent.messages), undated(turn.messages), "the retained transcript is this one turn");
  assert.deepEqual(turn.usage.response, usage);
  assert.deepEqual(turn.usage.turn, { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0 });
  assert.equal(turn.history.length, 3, "two text entries + one tool call");
  assert.deepEqual(turn.history.map((entry) => entry.kind), ["text", "toolCall", "text"]);
  assert.deepEqual(turn.permissions, []);
  assert.deepEqual(turn.elicitations, []);
  assert.equal("structured" in turn, false, "no schema → no structured keys");
});

test("turn.messages splits exactly where turn.text splits: the assistant messages joined by a blank line ARE turn.text", async () => {
  const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const thought = (text: string) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
  const { cwd } = configure({
    turns: [
      {
        // Interleaved thoughts, tool calls (with a later update), a plan, a user echo (a steer's), and
        // text that streams in several chunks — the real accumulator folds `text`, the message fold
        // folds `messages`; the two must agree on every boundary.
        updates: [
          thought("plan it"),
          chunk("A1"),
          chunk("A2"),
          { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read", kind: "read", status: "in_progress" },
          { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "x" },
          thought("then"),
          chunk("B"),
          { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Edit", kind: "edit", status: "in_progress" },
          { sessionUpdate: "plan", entries: [] },
          chunk("C"),
          { sessionUpdate: "user_message_chunk", content: { type: "text", text: "steer" } },
          chunk("D1"),
          chunk("D2"),
        ],
        text: [],
      },
      // A turn that starts with a tool call: a leading assistant message with no text, which the
      // text fold never sees — the join over the TEXT-BEARING messages is the exact statement.
      { updates: [{ sessionUpdate: "tool_call", toolCallId: "tc-3", title: "Grep", kind: "search", status: "completed" }], text: "E" },
    ],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  const t1 = await agent.prompt("one");
  assert.equal(t1.text, "A1A2\n\nB\n\nC\n\nD1D2");
  assert.equal(t1.messages.filter((m) => m.role === "assistant").map(textOf).join("\n\n"), t1.text);
  assert.deepEqual(
    t1.messages.map((m) => ({
      role: m.role,
      text: textOf(m),
      tools: m.toolCalls.map((c) => `${c.toolCallId}:${c.status}`),
      thoughts: m.thoughts.map((block) => (block.type === "text" ? block.text : block.type)),
    })),
    [
      { role: "assistant", text: "A1A2", tools: ["tc-1:completed"], thoughts: ["plan it"] },
      { role: "assistant", text: "B", tools: ["tc-2:in_progress"], thoughts: ["then"] },
      { role: "assistant", text: "C", tools: [], thoughts: [] },
      { role: "user", text: "steer", tools: [], thoughts: [] },
      { role: "assistant", text: "D1D2", tools: [], thoughts: [] },
    ],
  );
  assert.deepEqual(t1.toolCalls.map((c) => c.toolCallId), ["tc-1", "tc-2"], "turn.toolCalls is the flattening of the messages' tool calls");
  assert.deepEqual(t1.history.map((e) => e.kind), ["text", "text", "toolCall", "text", "toolCall", "text", "text", "text"], "history stays per chunk");

  const t2 = await agent.prompt("two");
  assert.equal(t2.text, "E");
  assert.deepEqual(
    t2.messages.map((m) => ({ text: textOf(m), tools: m.toolCalls.map((c) => c.toolCallId) })),
    [{ text: "", tools: ["tc-3"] }, { text: "E", tools: [] }],
  );
  assert.equal(assistantText(t2.messages), t2.text);

  // The retained transcript is the concatenation of the turns' messages and folds like agent.text.
  assert.deepEqual(undated(agent.messages), [...undated(t1.messages), ...undated(t2.messages)]);
  assert.equal(agent.text, "A1A2\n\nB\n\nC\n\nD1D2\n\nE");
  assert.equal(assistantText(agent.messages), agent.text);
  const snapshot = agent.messages;
  (snapshot[0]!.content[0] as { text: string }).text = "mutated";
  assert.equal(textOf(agent.messages[0]!), "A1A2", "messages hands out copies");
});

test("a typed session failure rejects with the mapped error carrying the complete turn and the verbatim response", async () => {
  const record = failureRecord();
  const meta = failureMeta(record, { other: true });
  const { cwd } = configure(
    { turns: [{ text: [], responseMeta: meta, usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } }, { text: "next" }] },
    { backends: ["codex"] },
  );
  const agent = track(new AcpAgent({ cwd, model: "codex", label: "walled" }));
  const expected = mapTypedSessionFailure(record, { backendId: "codex" });
  assert.equal(expected.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, "the runner's mapping for a rate/quota wall");

  let turn: AcpAgentTurn | undefined;
  await assert.rejects(
    () => agent.prompt("x"),
    (error: unknown) => {
      assert.ok(isAcpAgentTurnError(error), "the rejection carries the turn");
      assert.equal(error.code, expected.code);
      assert.equal(error.recoverable, expected.recoverable);
      assert.equal(error.agentLabel, "walled");
      assert.deepEqual(error.details, record, "details keep the runner's tested contract");
      assert.deepEqual(error.providerUsageLimitContext, { backendId: "codex", source: "provider", providerCode: "limit" });
      assert.equal(Object.keys(error).includes("turn"), false, "turn is non-enumerable: serialization is unchanged");
      turn = error.turn;
      return true;
    },
  );
  assert.ok(turn);
  assert.deepEqual(turn.response._meta, meta, "record and sibling keys intact");
  assert.equal(turn.stopReason, "end_turn");
  assert.equal(turn.usage.turn.input, 7);
  assert.deepEqual(turn.usage.response, { inputTokens: 7, outputTokens: 0, totalTokens: 7 });
  assert.equal(turn.text, "");
  assert.equal(agent.usage.input, 7, "a walled turn still counts the tokens it burned");
  assert.equal(agent.state, "ready", "the agent stays usable");
  assert.equal((await agent.prompt("again")).text, "next");
  assert.equal(agent.usage.input, 7);
});

test("raw:true layers the vendor-stream meta under user meta; raw:false leaves it out", async () => {
  const meta = { claudeCode: { custom: 1 }, other: true };
  {
    const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude", meta }));
    await agent.ready();
    assert.deepEqual(find(readLog(), "newSession")?.params?._meta, {
      other: true,
      claudeCode: { emitRawSDKMessages: true, custom: 1 },
    });
    await agent.close();
  }
  await harness.cleanup();
  {
    const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude", meta, raw: false }));
    await agent.ready();
    assert.deepEqual(find(readLog(), "newSession")?.params?._meta, { other: true, claudeCode: { custom: 1 } });
    await agent.close();
  }
});

test("usage.turn is this turn's response usage and usage.session is the running sum", async () => {
  const first = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const second = { inputTokens: 30, outputTokens: 10, totalTokens: 40 };
  const { cwd } = configure({
    turns: [
      { text: "one", usage: first, usageUpdate: { used: 10, size: 100, cost: { amount: 0.25, currency: "USD" } } },
      { text: "two", usage: second, usageUpdate: { used: 50, size: 100, cost: { amount: 0.75, currency: "USD" } } },
    ],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  assert.deepEqual(agent.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });

  const t1 = await agent.prompt("1");
  assert.deepEqual(t1.usage.turn, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.25 });
  assert.deepEqual(t1.usage.session, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.25 });
  assert.deepEqual(t1.usage.response, first);

  const t2 = await agent.prompt("2");
  // The wire usage is PER TURN: the second turn reports 30/10/40 itself, never 20/5/25.
  assert.deepEqual(t2.usage.turn, { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, total: 40, cost: 0.5 });
  assert.deepEqual(t2.usage.session, { input: 40, output: 15, cacheRead: 0, cacheWrite: 0, total: 55, cost: 0.75 });
  assert.deepEqual(t2.usage.response, second);
  assert.equal(agent.usage.total, 55);
  assert.equal(agent.usage.cost, 0.75, "session cost is the latest cumulative gauge");
  assert.equal(t2.usage.turn.cost, 0.5, "turn cost is the clamped delta of the gauge");
});

// ---- FIFO / steer / cancel ------------------------------------------------------------------

test("prompt, setConfigOptions, fork, a second prompt, and close serialize behind an in-flight turn", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    configOptions: [MODEL, EFFORT],
    forkSession: {},
    turns: [{ waitForCancel: true }, { text: "child" }, { text: "second" }],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  const first = agent.prompt("one");
  const setCfg = agent.setConfigOptions({ effort: "high" });
  const forked = agent.fork();
  const second = agent.prompt("two");
  const closed = agent.close();
  assert.equal(agent.state, "closed");

  await waitFor(() => methods(readLog()).includes("prompt"));
  const during = methods(readLog());
  const afterNew = during.slice(during.indexOf("newSession") + 1).filter((m) => !m.startsWith("__"));
  assert.deepEqual(afterNew, ["prompt"], "only the in-flight turn reached the wire");

  await agent.cancel();
  const t1 = await first;
  assert.equal(t1.stopReason, "cancelled");
  await setCfg;
  const child = track(await forked);
  const t2 = await second;
  assert.equal(t2.text, "child", "the parent process serves its turns[1]");
  await closed;
  assert.equal(agent.state, "closed");

  const wire = methods(readLog());
  const idx = (m: string, from = 0): number => wire.indexOf(m, from);
  const firstPrompt = idx("prompt");
  const cancel = idx("cancel");
  const setOpt = idx("setSessionConfigOption");
  const fork = idx("forkSession");
  const secondPrompt = idx("prompt", cancel);
  const close = idx("closeSession");
  assert.ok(firstPrompt < cancel && cancel < setOpt && setOpt < fork && fork < secondPrompt && secondPrompt < close, wire.join(","));
  await child.close();
});

test("steer overlaps an in-flight turn and is rejected when idle", async () => {
  const { cwd, readLog } = configure({
    extensionRequest: { method: "_session/steering", response: { outcome: "injected" } },
    turns: [{ waitForCancel: true }],
  });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  const steering: unknown[] = [];
  agent.on("steering", (event) => steering.push(event.response));
  const parked = agent.prompt("park");
  await waitFor(() => methods(readLog()).includes("prompt"));

  assert.deepEqual(await agent.steer("nudge"), { outcome: "injected" });
  assert.deepEqual(steering, [{ outcome: "injected" }]);
  const wire = methods(readLog());
  assert.ok(wire.indexOf("prompt") < wire.indexOf("extensionRequest"), "steer went out while the turn was parked");

  await agent.cancel();
  await parked;
  await assert.rejects(
    () => agent.steer("late"),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /requires a prompt\(\) in flight/)),
  );
});

test("cancel resolves the in-flight turn as cancelled and the agent stays usable", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "after" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  await agent.cancel(); // no turn in flight: a no-op
  const parked = agent.prompt("park");
  await waitFor(() => methods(readLog()).includes("prompt"));
  await Promise.all([agent.cancel(), agent.cancel()]);
  const turn = await parked;
  assert.equal(turn.stopReason, "cancelled");
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("next")).text, "after");
  assert.equal(count(readLog(), "cancel"), 1, "ONE session/cancel for the turn");
  assert.equal(methods(readLog()).includes("closeSession"), false);
});

test("a turn that ignores cancel ends in process disposal without session/close, and the session ref survives", async () => {
  const restore = setCancelGraceForTests(50);
  try {
    const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ ignoreCancel: true }] });
    const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
    const parked = agent.prompt("park");
    await waitFor(() => methods(readLog()).includes("prompt"));
    await agent.cancel();
    assert.equal(agent.state, "busy", "cancel() resolves at the notify boundary: the ignored turn is still in flight");
    await waitFor(() => methods(readLog()).includes("cancel"));
    await assert.rejects(parked, isCode(WorkflowErrorCode.AGENT_EXECUTION_ERROR));
    await waitFor(() => agent.state === "closed");
    await waitFor(() => methods(readLog()).includes("__exit"));
    const wire = methods(readLog());
    assert.ok(wire.includes("cancel"));
    assert.equal(wire.includes("closeSession"), false, "no wire session/close: the session stays re-openable");
    assert.equal(agent.sessionRef?.sessionId, agent.sessionId);
    await assert.rejects(() => agent.prompt("z"), isCode(WorkflowErrorCode.INVALID_ARGUMENT, (e) => assert.match(e.message, /is closed/)));
    await agent.close();
    await waitFor(() => liveConnectionCount() === 0);
  } finally {
    restore();
  }
});

// ---- per-turn options -----------------------------------------------------------------------

test("per-turn configOptions/mode apply before the turn and stick; unknown ids and \"model\" fail up front", async () => {
  const { cwd, readLog } = configure({ modes: MODES, configOptions: [MODEL, EFFORT], turns: [{ text: "x" }, { text: "y" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  await agent.prompt("x", { configOptions: { effort: "high" }, mode: "plan" });
  const wire = methods(readLog());
  assert.ok(
    wire.indexOf("setSessionConfigOption") < wire.indexOf("setSessionMode") && wire.indexOf("setSessionMode") < wire.indexOf("prompt"),
    wire.join(","),
  );
  assert.equal(agent.configOptions.find((option) => option.id === "effort")?.currentValue, "high");
  assert.equal(agent.modes?.currentModeId, "plan");

  const before = readLog().length;
  await assert.rejects(
    () => agent.prompt("y", { configOptions: { model: "m" } }),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /reserved option id "model"/)),
  );
  await assert.rejects(
    () => agent.prompt("y", { configOptions: { nope: true } }),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /not advertised.*model, effort/)),
  );
  assert.equal(readLog().length, before, "the rejections never reached the wire");
  assert.equal(agent.state, "ready");
  assert.equal(agent.modes?.currentModeId, "plan", "the earlier per-turn mode stuck");
});

// ---- close ----------------------------------------------------------------------------------

test("close({ keep: true }) skips session/close, disposes the process, and retains sessionRef; close is idempotent and fences the agent", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ text: "ok" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  await agent.prompt("hi");
  const sessionId = agent.sessionId;
  await agent.close({ keep: true });
  await waitFor(() => methods(readLog()).includes("__exit"));
  assert.equal(methods(readLog()).includes("closeSession"), false);
  assert.equal(count(readLog(), "__exit"), 1);
  assert.equal(agent.state, "closed");
  assert.equal(agent.sessionId, sessionId, "retained after close");
  assert.equal(agent.sessionRef?.sessionId, sessionId);
  assert.equal(agent.sessionRef?.poolKey, "claude");
  assert.equal(agent.sessionRef?.backendId, "claude");
  assert.equal(agent.sessionRef?.cwd, cwd);
  assert.equal(agent.text, "ok", "getters keep their retained values");

  await agent.close();
  assert.equal(count(readLog(), "__exit"), 1, "a second close() is the same teardown");
  await assert.rejects(
    () => agent.prompt("z"),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /is closed/)),
  );
  await assert.rejects(() => agent.ready(), /is closed/);
  await assert.rejects(() => agent.fork(), /is closed/);
  await assert.rejects(() => agent.setMode("plan"), /is closed/);
  await assert.rejects(() => agent.setConfigOptions({}), /is closed/);
  await agent.cancel(); // never throws after close
});

test("close() without keep sends session/close before the process exits", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  await agent.prompt("hi");
  const closes: string[] = [];
  agent.on("session_close", (event) => closes.push(event.sessionId));
  await agent.close();
  await waitFor(() => methods(readLog()).includes("__exit"));
  const wire = methods(readLog());
  assert.ok(wire.indexOf("closeSession") >= 0 && wire.indexOf("closeSession") < wire.indexOf("__exit"), wire.join(","));
  assert.equal(find(readLog(), "closeSession")?.params?.sessionId, agent.sessionId);
  assert.deepEqual(closes, [agent.sessionId], "the agent's own session_close was delivered before the bus closed");
});

test("await using closes via Symbol.asyncDispose", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  let captured: AcpAgent | undefined;
  {
    await using agent = new AcpAgent({ cwd, model: "claude" });
    captured = agent;
    await agent.ready();
    assert.equal(agent.state, "ready");
  }
  assert.equal(captured.state, "closed");
  await waitFor(() => methods(readLog()).includes("__exit"));
  assert.ok(methods(readLog()).includes("closeSession"));
});

// ---- death and abort ------------------------------------------------------------------------

test("process death closes the agent, rejects queued work, and emits backend_error", async () => {
  const { cwd, readLog } = configure({ turns: [{ crash: true }] }, { crashSentinel: true });
  const agent = track(new AcpAgent({ cwd, model: "claude" }));
  const errors: unknown[] = [];
  agent.on("backend_error", (event) => errors.push(event.error));
  const first = agent.prompt("boom");
  const queued = agent.prompt("later");
  await assert.rejects(first, isCode(WorkflowErrorCode.AGENT_EXECUTION_ERROR));
  await assert.rejects(
    queued,
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /process exited/)),
  );
  assert.equal(agent.state, "closed");
  assert.equal(errors.length, 1, "backend_error reaches the agent's own listeners");
  await assert.rejects(() => agent.prompt("z"), /is closed: process exited/);
  await agent.close(); // never throws for an already-dead process
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(count(readLog(), "__start"), 1, "no restart: the SDK owns no pool");
});

test("constructor signal abort rejects queued work with the reason, cancels the turn, and closes", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "never" }] });
  const controller = new AbortController();
  const reason = new Error("stop");
  const agent = track(new AcpAgent({ cwd, model: "claude", signal: controller.signal }));
  const parked = agent.prompt("park");
  const queued = agent.prompt("queued");
  await waitFor(() => methods(readLog()).includes("prompt"));
  // Attach the handlers BEFORE aborting: the queued promise rejects synchronously inside abort().
  const settled = Promise.allSettled([parked, queued]);
  controller.abort(reason);
  const [p, q] = await settled;
  assert.equal(p.status, "rejected");
  assert.equal(q.status, "rejected");
  assert.equal((p as PromiseRejectedResult).reason, reason, "the exact reason object, never a WorkflowError");
  assert.equal((q as PromiseRejectedResult).reason, reason);
  assert.equal(agent.state, "closed");
  await waitFor(() => methods(readLog()).includes("__exit"));
  const wire = methods(readLog());
  assert.ok(wire.indexOf("cancel") >= 0 && wire.indexOf("cancel") < wire.indexOf("__exit"), wire.join(","));
  await assert.rejects(() => agent.prompt("z"), (error: unknown) => error === reason);
  await agent.close();

  // An already-aborted signal: the constructor still validates, but nothing is ever spawned.
  await harness.cleanup();
  const again = configure({ turns: [{ text: "x" }] });
  const pre = new AbortController();
  pre.abort(reason);
  const dead = track(new AcpAgent({ cwd: again.cwd, model: "claude", signal: pre.signal }));
  assert.equal(dead.state, "closed");
  await assert.rejects(() => dead.prompt("x"), (error: unknown) => error === reason);
  assert.deepEqual(again.readLog(), []);
});

test("a close({ keep: true }) queued behind a parked turn survives a constructor abort: the teardown waits out the cancel grace and keeps its keep", async () => {
  const grace = 300;
  const restore = setCancelGraceForTests(grace);
  try {
    const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ ignoreCancel: true }] });
    const controller = new AbortController();
    const reason = new Error("stop");
    const agent = track(await AcpAgent.open({ cwd, model: "claude", signal: controller.signal }));
    const parked = agent.prompt("park");
    await waitFor(() => methods(readLog()).includes("prompt"));
    const closed = agent.close({ keep: true });
    let closeSettled = false;
    void closed.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    const settled = Promise.allSettled([parked]);
    const abortedAt = Date.now();
    controller.abort(reason);
    assert.equal(agent.state, "closed");

    // The abort's cancel goes out; the queued close() must NOT tear down under the parked turn.
    await waitFor(() => methods(readLog()).includes("cancel"));
    assert.equal(closeSettled, false, "close() waits for the in-flight turn to settle");
    assert.equal(methods(readLog()).includes("__exit"), false, "the process is alive while the turn is parked");

    const [p] = await settled;
    assert.equal(p.status, "rejected");
    assert.equal((p as PromiseRejectedResult).reason, reason, "the parked turn rejects with the abort reason");
    await closed;
    assert.ok(Date.now() - abortedAt >= grace - 50, "the teardown ran only after the ignored-cancel grace disposed the process");
    await waitFor(() => methods(readLog()).includes("__exit"));
    const wire = methods(readLog());
    assert.ok(wire.indexOf("cancel") < wire.indexOf("__exit"), wire.join(","));
    assert.equal(wire.includes("closeSession"), false, "close({ keep: true }) kept its keep: no wire session/close");
    assert.equal(agent.sessionRef?.sessionId, agent.sessionId, "the session stays re-openable");
    await waitFor(() => liveConnectionCount() === 0);
  } finally {
    restore();
  }
});

test("a close() queued behind a parked turn survives a constructor abort: session/close goes out only after the cancelled turn settled", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ waitForCancel: true }] });
  const controller = new AbortController();
  const reason = new Error("stop");
  const agent = track(await AcpAgent.open({ cwd, model: "claude", signal: controller.signal }));
  const parked = agent.prompt("park");
  await waitFor(() => methods(readLog()).includes("prompt"));
  const closed = agent.close();
  // `session_close` is emitted synchronously when the handle's release starts; record whether the
  // in-flight turn had already settled at that instant (the reaction below is registered first).
  let parkedSettled = false;
  const observed = parked.then(
    () => {
      parkedSettled = true;
    },
    () => {
      parkedSettled = true;
    },
  );
  const settled = Promise.allSettled([parked]);
  let releasedAfterTurn: boolean | undefined;
  agent.on("session_close", () => {
    releasedAfterTurn = parkedSettled;
  });
  controller.abort(reason);

  const [p] = await settled;
  await observed;
  assert.equal(p.status, "rejected");
  assert.equal((p as PromiseRejectedResult).reason, reason);
  await closed;
  assert.equal(releasedAfterTurn, true, "the session was released only after the in-flight turn settled");
  await waitFor(() => methods(readLog()).includes("__exit"));
  const wire = methods(readLog());
  const cancel = wire.indexOf("cancel");
  const close = wire.indexOf("closeSession");
  assert.ok(cancel >= 0 && close > cancel && close < wire.indexOf("__exit"), wire.join(","));
  assert.equal(find(readLog(), "closeSession")?.params?.sessionId, agent.sessionId);
  assert.equal(agent.state, "closed");
  await waitFor(() => liveConnectionCount() === 0);
});

test("a per-call signal aborted while queued never reaches the wire; aborted in flight sends session/cancel and rejects with the reason", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }, { text: "after" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const reason = new Error("per-call stop");

  // Queued: the parked first turn holds the queue; the second is aborted before it starts.
  const parkedController = new AbortController();
  const parked = agent.prompt("park", { signal: parkedController.signal });
  await waitFor(() => methods(readLog()).includes("prompt"));
  const queuedController = new AbortController();
  const queued = agent.prompt("queued", { signal: queuedController.signal });
  queuedController.abort(reason);
  await assert.rejects(queued, (error: unknown) => error === reason);
  assert.equal(count(readLog(), "prompt"), 1, "the aborted queued prompt never went out");

  // In flight: one session/cancel, then the reason (even though the agent answered `cancelled`).
  parkedController.abort(reason);
  await assert.rejects(parked, (error: unknown) => error === reason);
  assert.equal(count(readLog(), "cancel"), 1);
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("next")).text, "after");
});

// ---- validation and error mapping -----------------------------------------------------------

test("cwd and configOptions are validated synchronously before any spawn", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const validation = isCode(WorkflowErrorCode.INVALID_ARGUMENT);
  assert.throws(() => new AcpAgent({ cwd: "relative" }), validation);
  assert.throws(() => new AcpAgent({ cwd: "" }), validation);
  assert.throws(() => new AcpAgent({ cwd: join(cwd, "missing", "dir") }), validation);
  assert.throws(() => new AcpAgent({ cwd: join(cwd, "log.jsonl") }), /not a directory/);
  assert.throws(() => new AcpAgent({ cwd, configOptions: { model: "x" } }), /reserved option id "model"/);
  assert.throws(() => new AcpAgent({ cwd, backends: { bad: {} as never } }), validation);
  assert.deepEqual(readLog(), [], "nothing spawned");

  const ref = { sessionId: "s", backendId: "claude", cwd, reopen: { load: true, resume: true, list: false } };
  await assert.rejects(() => AcpAgent.resume({ ...ref, cwd: "nope" }), validation);
  await assert.rejects(() => AcpAgent.load(ref, { cwd: join(cwd, "missing") }), validation);
  await assert.rejects(() => AcpAgent.fork({ ...ref, cwd: "relative" }), validation);
  await assert.rejects(() => AcpAgent.open({ cwd, configOptions: { model: "x" } }), /reserved option id "model"/);
  await assert.rejects(() => AcpAgent.resume({ ...ref, sessionId: " " }), /non-empty sessionId/);
  assert.deepEqual(readLog(), [], "the statics reject before spawning too");
});

test("a synchronous spawn failure closes the agent and surfaces as the mapped error", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  // Node's spawn() rejects a command with a NUL byte synchronously, inside PooledConnection.create.
  const agent = track(new AcpAgent({ cwd, model: "nul", backends: { nul: { command: "node x" } }, label: "sync-spawn" }));
  assert.equal(agent.state, "idle");
  await assert.rejects(
    () => agent.prompt("x"),
    isCode(WorkflowErrorCode.AGENT_EXECUTION_ERROR, (error) => {
      assert.match(error.message, /null bytes/);
      assert.equal(error.agentLabel, "sync-spawn");
    }),
  );
  assert.equal(agent.state, "closed", "an open that failed before spawning still closes the agent");
  await assert.rejects(
    () => agent.prompt("y"),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => assert.match(error.message, /is closed/)),
  );
  assert.deepEqual(readLog(), [], "nothing was ever spawned");
  assert.equal(liveConnectionCount(), 0, "nothing was retained for the exit hook");
  await agent.close();
  await assert.rejects(
    () => AcpAgent.open({ cwd, model: "nul", backends: { nul: { command: "node x" } } }),
    isCode(WorkflowErrorCode.AGENT_EXECUTION_ERROR),
  );
});

test("wire errors are mapped: AUTH_REQUIRED with authContext, PROVIDER_USAGE_LIMIT with resetHint, generic recoverable", async () => {
  {
    const { cwd, readLog } = configure({ authRequiredOnNewSession: true, authMethods: [{ id: "api-key", name: "API Key" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude", label: "auth" }));
    await assert.rejects(
      () => agent.ready(),
      isCode(WorkflowErrorCode.AUTH_REQUIRED, (error) => {
        assert.equal(error.agentLabel, "auth");
        assert.deepEqual(error.authContext, { backendId: "claude", methods: [{ id: "api-key", type: "agent", name: "API Key" }] });
      }),
    );
    assert.equal(agent.state, "closed");
    await waitFor(() => methods(readLog()).includes("__exit"));
    await assert.rejects(() => AcpAgent.open({ cwd, model: "claude" }), isCode(WorkflowErrorCode.AUTH_REQUIRED));
    await waitFor(() => count(readLog(), "__exit") === 2);
  }
  await harness.cleanup();
  {
    const { cwd } = configure({
      turns: [
        {
          throw: "out of credits",
          throwData: { errorKind: "billing_error" },
          usageUpdate: { used: 1, size: 10, _meta: { "_claude/rateLimit": { status: "rejected", resetsAt: 1784106000 } } },
        },
        { text: "ok" },
      ],
    });
    const agent = track(new AcpAgent({ cwd, model: "claude" }));
    await assert.rejects(
      () => agent.prompt("x"),
      isCode(WorkflowErrorCode.PROVIDER_USAGE_LIMIT, (error) => {
        assert.match(String(error.resetHint), /Resets at/);
        assert.equal(error.recoverable, false);
      }),
    );
    assert.equal(agent.state, "ready", "a wall never closes the agent");
    assert.equal((await agent.prompt("y")).text, "ok");
  }
  await harness.cleanup();
  {
    const { cwd } = configure({ turns: [{ throw: "boom" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude" }));
    await assert.rejects(
      () => agent.prompt("x"),
      isCode(WorkflowErrorCode.AGENT_EXECUTION_ERROR, (error) => {
        assert.equal(error.recoverable, true);
        assert.match(error.message, /boom/);
      }),
    );
    assert.equal(agent.state, "ready");
  }
});

// ---- history --------------------------------------------------------------------------------

test("history/text are cumulative by default and per-turn with retainHistory:false", async () => {
  {
    const { cwd } = configure({ turns: [{ text: "one" }, { text: "two" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude" }));
    const t1 = await agent.prompt("1");
    const t2 = await agent.prompt("2");
    assert.equal(agent.text, "one\n\ntwo", "agent.text folds like turn.text: distinct messages join with a blank line");
    assert.equal(agent.text, [t1.text, t2.text].join("\n\n"));
    assert.deepEqual(undated(agent.messages), [...undated(t1.messages), ...undated(t2.messages)], "messages are cumulative too");
    assert.equal(assistantText(agent.messages), agent.text);
    assert.equal(agent.history.length, 2);
    assert.equal(t1.history.length, 1);
    assert.equal(t2.history.length, 1, "each turn's slice holds only its own entry");
    assert.equal(t2.history[0]!.text, "two");
    assert.equal(t2.text, "two");
    const snapshot = agent.history;
    (snapshot[0] as { text: string }).text = "mutated";
    assert.equal(agent.history[0]!.text, "one", "history hands out copies");
  }
  await harness.cleanup();
  {
    const { cwd } = configure({ turns: [{ text: "one" }, { text: "two" }] });
    const agent = track(new AcpAgent({ cwd, model: "claude", retainHistory: false }));
    await agent.prompt("1");
    const t2 = await agent.prompt("2");
    assert.equal(agent.text, "two");
    assert.equal(agent.history.length, 1);
    assert.deepEqual(undated(agent.messages), undated(t2.messages), "messages hold only the latest turn, like the accumulator");
    assert.equal(t2.text, "two");
    assert.equal(t2.history.length, 1, "the turn's slice starts at 0 after the accumulator was cleared");
    assert.equal(t2.history[0]!.text, "two");
  }
});

// ---- events ---------------------------------------------------------------------------------

test("per-agent events are isolated; session_open is delivered live and sticky", async () => {
  const { cwd } = configure({ turns: [{ text: "hello" }] });
  const a = track(new AcpAgent({ cwd, model: "claude", label: "a" }));
  const b = track(new AcpAgent({ cwd, model: "claude", label: "b" }));
  const aChunks: string[] = [];
  const bChunks: string[] = [];
  a.on("agent_message_chunk", (event) => aChunks.push(event.sessionId));
  b.on("agent_message_chunk", (event) => bChunks.push(event.sessionId));
  const aOpensLive: string[] = [];
  const aCloses: string[] = [];
  const bCloses: string[] = [];
  a.on("session_open", (event) => aOpensLive.push(`${event.label}:${event.sessionId}`));
  a.on("session_close", (event) => aCloses.push(event.sessionId));
  b.on("session_close", (event) => bCloses.push(event.sessionId));

  await Promise.all([a.prompt("x"), b.prompt("y")]);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(aChunks, [a.sessionId], "a's listener saw only a's session");
  assert.deepEqual(bChunks, [b.sessionId]);
  assert.deepEqual(aOpensLive, [`a:${a.sessionId}`], "registered before ready(): fired once, live, with the label");

  const aOpensLate: string[] = [];
  a.on("session_open", (event) => aOpensLate.push(event.sessionId));
  assert.deepEqual(aOpensLate, []);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(aOpensLate, [a.sessionId], "registered after ready(): fired once on the next microtask");
  assert.deepEqual(aOpensLive, [`a:${a.sessionId}`], "the live subscriber never saw it twice");

  await a.close();
  assert.deepEqual(aCloses, [a.sessionId]);
  assert.deepEqual(bCloses, [], "a's close never reaches b");
  assert.equal(b.state, "ready");
  await b.close();
  assert.deepEqual(bCloses, [b.sessionId]);
});

test("permission and elicitation events of the turn are captured with the decisions", async () => {
  const { cwd, readLog } = configure({
    turns: [
      {
        toolCall: { title: "Write", kind: "edit", name: "write_file", toolCallId: "tc-9" },
        elicitation: { mode: "form", message: "Name?" },
        text: "done",
      },
    ],
  });
  const seen: string[] = [];
  const agent = track(
    new AcpAgent({
      cwd,
      model: "claude",
      onPermissionRequest: (request) => {
        seen.push(`permission:${request.toolCall.toolCallId}`);
        return ALLOW;
      },
      onElicitation: (request) => {
        seen.push(`elicitation:${request.message}`);
        return ELICITATION_ACCEPT;
      },
    }),
  );
  const turn = await agent.prompt("go");
  assert.equal(turn.text, "done");
  assert.equal(turn.permissions.length, 1);
  assert.equal(turn.permissions[0]!.request.toolCall.name, "write_file");
  assert.equal(turn.permissions[0]!.request.toolCall.toolCallId, "tc-9");
  assert.equal(turn.permissions[0]!.request.toolCall.title, "Write");
  assert.equal(turn.permissions[0]!.outcome.outcome.outcome, "selected");
  assert.equal(turn.permissions[0]!.sessionId, agent.sessionId);
  assert.equal(turn.elicitations.length, 1);
  assert.equal(turn.elicitations[0]!.request.message, "Name?");
  assert.equal(turn.elicitations[0]!.outcome.action, "accept");
  assert.deepEqual(seen, ["permission:tc-9", "elicitation:Name?"]);
  assert.deepEqual(permissionOutcomes(readLog()), [ALLOW.outcome]);
  const initialize = find(readLog(), "initialize");
  assert.ok(initialize?.params?.clientCapabilities?.elicitation, "elicitation advertised because a resolver was given");

  // Without a resolver nothing is advertised (the fake would otherwise refuse the elicitation).
  await harness.cleanup();
  const plain = configure({ turns: [{ text: "ok" }] });
  const bare = track(new AcpAgent({ cwd: plain.cwd, model: "claude" }));
  await bare.ready();
  assert.ok(!find(plain.readLog(), "initialize")?.params?.clientCapabilities?.elicitation);
});

// ---- system prompt instructions ------------------------------------------------------------

test("systemPrompt is validated in the constructor against the routed backend, before any spawn", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  // OpenCode carries no channel: refused synchronously with the backend named.
  assert.throws(
    () => new AcpAgent({ cwd, model: "opencode", label: "oc", systemPrompt: { replace: "R" } }),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => {
      assert.match(error.message, /systemPrompt\.replace is not supported by backend "opencode"/);
      assert.equal(error.agentLabel, "oc");
    }),
  );
  // A malformed value is refused on a supporting backend too.
  assert.throws(
    () => new AcpAgent({ cwd, model: "claude", systemPrompt: { append: "" } }),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => {
      assert.match(error.message, /systemPrompt\.append must be a non-empty string/);
    }),
  );
  assert.throws(
    () => new AcpAgent({ cwd, model: "claude", systemPrompt: { base: "x" } as never }),
    isCode(WorkflowErrorCode.INVALID_ARGUMENT, (error) => {
      assert.match(error.message, /unknown field "base"/);
    }),
  );
  assert.equal(readLog().length, 0, "nothing spawned");
  assert.equal(liveConnectionCount(), 0);
});

test("Claude: systemPrompt rides session/new `_meta.systemPrompt` next to the raw-message flag, and wins over `meta`", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }, { text: "ok" }, { text: "ok" }] });
  const appended = track(new AcpAgent({ cwd, model: "claude", systemPrompt: { append: "Be terse." } }));
  await appended.ready();
  assert.deepEqual(find(readLog(), "newSession")?.params?._meta, {
    claudeCode: { emitRawSDKMessages: true },
    systemPrompt: { append: "Be terse." },
  });
  await appended.close();

  const replaced = track(
    new AcpAgent({
      cwd,
      model: "claude",
      raw: false,
      meta: { systemPrompt: "from meta", vendor: { keep: true } },
      systemPrompt: { replace: "You are a release bot.", append: "Only touch CHANGELOG.md." },
    }),
  );
  await replaced.ready();
  const sessions = readLog().filter((entry) => entry.method === "newSession");
  assert.deepEqual(sessions[1]?.params?._meta, {
    vendor: { keep: true },
    systemPrompt: "You are a release bot.\n\nOnly touch CHANGELOG.md.",
  });
  await replaced.close();

  // Without the option, a caller-supplied `meta.systemPrompt` passes through untouched.
  const passthrough = track(new AcpAgent({ cwd, model: "claude", raw: false, meta: { systemPrompt: { append: "via meta" } } }));
  await passthrough.ready();
  assert.deepEqual(readLog().filter((entry) => entry.method === "newSession")[2]?.params?._meta, {
    systemPrompt: { append: "via meta" },
  });
});

test("Codex and pi: systemPrompt rides session/new in each backend's own dialect", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }, { text: "ok" }] }, { backends: ["codex", "pi"] });
  const codex = track(new AcpAgent({ cwd, model: "codex", systemPrompt: { replace: "BASE", append: "DEV" } }));
  await codex.ready();
  assert.deepEqual(find(readLog(), "newSession")?.params?._meta, { baseInstructions: "BASE", developerInstructions: "DEV" });
  await codex.close();

  const pi = track(new AcpAgent({ cwd, model: "pi", systemPrompt: { append: "DEV" } }));
  await pi.ready();
  assert.deepEqual(readLog().filter((entry) => entry.method === "newSession")[1]?.params?._meta, {
    systemPrompt: { append: "DEV" },
  });
});
