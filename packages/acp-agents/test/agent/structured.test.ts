// Schema plumbing of the SDK (src/agent/structured.ts) per backend channel: Claude's session
// _meta + native result, Codex's per-turn _meta.outputSchema (+ the per-turn override), the
// injected StructuredOutput HTTP tool on http-MCP agents (pi here), the no-injection embed +
// final-text fallback, the per-turn result resolution and its structuredError, the opt-in
// `schemaRetries` repair ladder (default 0 = one turn; the runner's repair prompt with the
// validation error; attempts counted; per-turn override; exhausted; never after a non-end_turn),
// turn-scoped captures, the per-turn schema gate, and the host teardown on close.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { Type } from "typebox";
import {
  AcpAgent,
  toStrictJsonSchema,
  type AcpAgentStreamEvent,
  type AcpAgentTurn,
} from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { REPROMPT_TEXT, STRUCTURED_TOOL_REPROMPT_TEXT, repairPromptText } from "../../src/structured-output.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface McpServerEntry {
  type?: string;
  name?: string;
  url?: string;
}

interface LogEntry {
  method: string;
  label?: string;
  params?: {
    sessionId?: string;
    prompt?: ContentBlock[];
    mcpServers?: McpServerEntry[];
    _meta?: Record<string, unknown>;
  };
}

const SCHEMA = Type.Object({ answer: Type.Number() });

const harness = createFakeAgentHarness({ prefix: "acp-agent-structured-it-", backends: ["claude", "codex", "opencode", "pi"] });
const configure = (scenario: unknown, options?: Parameters<typeof harness.configure>[1]) =>
  harness.configure<LogEntry>(scenario, options);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const count = (log: LogEntry[], method: string): number => log.filter((entry) => entry.method === method).length;
const newSessionServers = (log: LogEntry[]): McpServerEntry[] =>
  log.find((entry) => entry.method === "newSession")?.params?.mcpServers ?? [];
const promptText = (entry: LogEntry | undefined): string =>
  (entry?.params?.prompt ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
const prompts = (log: LogEntry[]): LogEntry[] => log.filter((entry) => entry.method === "prompt");
const invalidArgument = (pattern: RegExp) => (error: unknown): boolean => {
  assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
  assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
  assert.match(error.message, pattern);
  return true;
};

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("Claude: the session schema rides session/new _meta and the turn's structured result is the validated native output", async () => {
  const { cwd, readLog } = configure({ turns: [{ structuredOutput: { answer: 42 }, text: '{"answer":42}' }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude", schema: SCHEMA }));
  assert.equal(agent.schema, SCHEMA);
  const meta = readLog().find((entry) => entry.method === "newSession")?.params?._meta as {
    claudeCode?: { options?: { outputFormat?: { type?: string } }; emitRawSDKMessages?: boolean };
  };
  assert.equal(meta.claudeCode?.options?.outputFormat?.type, "json_schema");
  assert.equal(meta.claudeCode?.emitRawSDKMessages, true);

  const turn = await agent.prompt("q");
  assert.deepEqual(turn.structured, { answer: 42 });
  assert.equal(turn.structuredError, undefined);
  assert.equal("structuredError" in turn, false);
  assert.equal(turn.raw[0]?.method, "_claude/sdkMessage", "the native result rode the raw stream");
  assert.equal(readLog().find((entry) => entry.method === "prompt")?.params?._meta, undefined, "Claude carries nothing on the turn");
});

test("Codex: the session schema rides every turn's _meta.outputSchema, a per-turn schema replaces it, and the result is parsed from the final message", async () => {
  const perTurn = Type.Object({ name: Type.String() });
  const { cwd, readLog } = configure({ turns: [{ text: '{"answer":1}' }, { text: '{"name":"n"}' }] });
  const agent = track(await AcpAgent.open({ cwd, model: "codex", schema: SCHEMA }));
  const first = await agent.prompt("a");
  const second = await agent.prompt("b", { schema: perTurn });
  assert.deepEqual(first.structured, { answer: 1 });
  assert.deepEqual(second.structured, { name: "n" });

  const prompts = readLog().filter((entry) => entry.method === "prompt");
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0]!.params?._meta?.outputSchema, toStrictJsonSchema(SCHEMA));
  assert.deepEqual(prompts[1]!.params?._meta?.outputSchema, toStrictJsonSchema(perTurn));
  assert.equal(promptText(prompts[0]), "a", "Codex never embeds the contract in the prompt");
  assert.equal(newSessionServers(readLog()).length, 0, "no injected tool on Codex");

  // The session schema returns once the per-turn override is gone.
  const third = await agent.prompt("c");
  assert.deepEqual(readLog().filter((entry) => entry.method === "prompt")[2]!.params?._meta?.outputSchema, toStrictJsonSchema(SCHEMA));
  assert.equal(third.structured, undefined, "the fake's last turn repeats {name} which fails the session schema");
  assert.match(third.structuredError!, /native result rejected/);
});

test("pi/opencode/custom: the StructuredOutput tool is injected when http MCP is advertised and the capture wins over prose", async () => {
  const userServer = { type: "http" as const, name: "structured_output", url: "http://127.0.0.1:1/x", headers: [] };
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [{ structuredToolCall: { arguments: { answer: 7 } }, text: "prose" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, mcpServers: [userServer] }));
  const servers = newSessionServers(readLog());
  assert.equal(servers.length, 2);
  assert.deepEqual(servers[0], userServer);
  assert.equal(servers[1]?.name, "structured_output_2", "the injected name never collides with the caller's");
  assert.equal(servers[1]?.type, "http");
  assert.match(servers[1]?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\//);

  const turn = await agent.prompt("classify");
  const prompt = promptText(readLog().find((entry) => entry.method === "prompt"));
  assert.match(prompt, /StructuredOutput/);
  assert.match(prompt, /required output schema \(JSON Schema\)/i);
  assert.ok(prompt.startsWith("classify"), "the user's text leads the shaped prompt");
  assert.deepEqual(turn.structured, { answer: 7 }, "the capture wins over the prose final message");
  assert.equal(turn.text, "prose");
  assert.equal(count(readLog(), "structuredToolCall"), 1);
});

test("no http MCP → no injection; the schema is embedded and the final-text fallback validates", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: '{"answer":"3"}' }] });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
  assert.equal(newSessionServers(readLog()).some((server) => server.name?.startsWith("structured_output")), false);
  const turn = await agent.prompt("q");
  assert.deepEqual(turn.structured, { answer: 3 }, "typebox Convert coerces the string");
  const prompt = promptText(readLog().find((entry) => entry.method === "prompt"));
  assert.match(prompt, /required output schema \(JSON Schema\)/i);
  assert.doesNotMatch(prompt, /MCP tool named StructuredOutput/, "no tool → the tool clause is absent");
  assert.equal(count(readLog(), "structuredToolCall"), 0);
});

test("the default schemaRetries of 0 keeps prompt() one turn: a miss sets structuredError and structuredAttempts 1, nothing is re-prompted", async () => {
  {
    const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "no json here" }] });
    const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
    const turn = await agent.prompt("q");
    assert.equal(count(readLog(), "prompt"), 1, "exactly one prompt: the default budget buys no repair");
    assert.equal(turn.structured, undefined);
    assert.equal("structured" in turn, false);
    assert.match(turn.structuredError!, /no JSON object/);
    assert.match(turn.structuredError!, /no StructuredOutput capture/);
    assert.equal(turn.structuredAttempts, 1);
    assert.equal(turn.text, "no json here", "the turn still resolves normally");
  }
  await harness.cleanup();
  {
    const { cwd, readLog } = configure({ turns: [{ structuredOutput: { answer: "not a number" }, text: "no json here" }] });
    const agent = track(await AcpAgent.open({ cwd, model: "claude", schema: SCHEMA }));
    const turn = await agent.prompt("q");
    assert.equal(count(readLog(), "prompt"), 1);
    assert.equal(turn.structured, undefined);
    assert.match(turn.structuredError!, /native result rejected/);
    assert.match(turn.structuredError!, /no JSON object/);
    assert.equal(turn.structuredAttempts, 1);
  }
  await harness.cleanup();
  {
    // No schema: no attempt count either.
    const { cwd } = configure({ turns: [{ text: "plain" }] });
    const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
    const turn = await agent.prompt("q");
    assert.equal("structuredAttempts" in turn, false);
    assert.equal(turn.structuredAttempts, undefined);
  }
});

test("schemaRetries: an invalid turn is repaired inside the same prompt() — the runner's repair prompt carrying the validation error, structuredAttempts 2, usage summed, and stream() yields the repair turn's events", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: false,
    turns: [
      { text: "no json here", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      { text: '{"answer":5}', usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } },
    ],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, schemaRetries: 1 }));
  const events: AcpAgentStreamEvent[] = [];
  let turn: AcpAgentTurn | undefined;
  for await (const event of agent.stream("classify")) {
    events.push(event);
    if (event.type === "turn") turn = event.turn;
  }
  assert.ok(turn, "the stream ends with the terminal turn");
  assert.deepEqual(turn.structured, { answer: 5 }, "the repair turn's JSON is the result");
  assert.equal(turn.structuredError, undefined);
  assert.equal(turn.structuredAttempts, 2, "1 + the one repair actually run");
  assert.equal(turn.text, '{"answer":5}', "the resolved turn is the FINAL attempt's");
  assert.deepEqual(turn.usage.turn, { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, total: 22, cost: 0 }, "turn usage is the final attempt's");
  assert.deepEqual(agent.usage, { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, total: 33, cost: 0 }, "both attempts count on the agent");
  assert.deepEqual(turn.usage.session, agent.usage);

  const sent = prompts(readLog());
  assert.equal(sent.length, 2, "one repair turn on the same session");
  assert.equal(sent[1]!.params?.sessionId, sent[0]!.params?.sessionId);
  assert.ok(promptText(sent[0]).startsWith("classify"), "the first turn is the shaped user prompt");
  assert.match(promptText(sent[0]), /required output schema \(JSON Schema\)/i);
  const repair = promptText(sent[1]);
  assert.ok(repair.startsWith(REPROMPT_TEXT), `the runner's JSON repair prompt leads: ${repair}`);
  assert.equal(
    repair,
    repairPromptText({ toolActive: false, reason: "no StructuredOutput capture; no JSON object in the final message" }),
    "the previous attempt's structuredError rides the repair prompt",
  );
  assert.doesNotMatch(repair, /\(JSON Schema\)/, "text only — the contract is not re-embedded on a repair");

  assert.equal(events.filter((event) => event.type === "agent_message_chunk").length, 2, "both attempts' chunks were streamed");
  assert.equal(events.at(-1)?.type, "turn");
  assert.equal(events.filter((event) => event.type === "turn").length, 1, "one terminal event for the whole prompt()");
});

test("schemaRetries exhausted: structuredAttempts is 1 + n, structured stays absent, structuredError is the last failure; Claude's native channel stays authoritative", async () => {
  const { cwd, readLog } = configure({
    turns: [
      { structuredOutput: { answer: "a" }, text: "first" },
      { structuredOutput: { answer: "b" }, text: "second" },
      { structuredOutput: { answer: "c" }, text: "third" },
      { structuredOutput: { answer: 3 }, text: '{"answer":3}' },
    ],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "claude", schema: SCHEMA, schemaRetries: 2 }));
  const turn = await agent.prompt("q");
  assert.equal(count(readLog(), "prompt"), 3, "1 + 2 repairs, then the budget is spent — the fourth (valid) turn is never requested");
  assert.equal(turn.structuredAttempts, 3);
  assert.equal(turn.structured, undefined);
  assert.equal("structured" in turn, false);
  assert.match(turn.structuredError!, /native result rejected/, "the LAST attempt's failure");
  assert.equal(turn.text, "third", "the final attempt's turn");
  const sent = prompts(readLog());
  for (const repair of sent.slice(1)) {
    assert.ok(promptText(repair).startsWith(REPROMPT_TEXT), "Claude has no injected tool: the JSON repair prompt");
    assert.match(promptText(repair), /Validation error: no StructuredOutput capture; native result rejected: /);
    assert.equal(repair.params?._meta, undefined, "Claude carries nothing on the turn — the repair too");
  }
  assert.equal(agent.state, "ready");
  // The next prompt() is its own ladder: the valid fourth turn resolves at once.
  const next = await agent.prompt("again");
  assert.deepEqual(next.structured, { answer: 3 });
  assert.equal(next.structuredAttempts, 1);
});

test("a per-turn schemaRetries wins over the constructor's in both directions", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "nope" }, { text: '{"answer":1}' }] });
  const conservative = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
  const repaired = await conservative.prompt("a", { schemaRetries: 1 });
  assert.deepEqual(repaired.structured, { answer: 1 });
  assert.equal(repaired.structuredAttempts, 2);
  assert.equal(count(readLog(), "prompt"), 2);

  const generous = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, schemaRetries: 3 }));
  const single = await generous.prompt("b", { schemaRetries: 0 });
  assert.equal(single.structured, undefined);
  assert.equal(single.structuredAttempts, 1);
  assert.equal(count(readLog(), "prompt"), 3, "the per-turn 0 sent exactly one prompt on the second agent");
  // Without a per-turn value the constructor's budget applies (the second agent's cursor is at its valid turn).
  const inherited = await generous.prompt("c");
  assert.deepEqual(inherited.structured, { answer: 1 });
  assert.equal(inherited.structuredAttempts, 1);
});

test("injected tool active: a turn that skipped StructuredOutput is re-prompted with the tool repair text, and the repair turn's capture wins", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [{ text: "prose only" }, { structuredToolCall: { arguments: { answer: 7 } }, text: "called it" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, schemaRetries: 1 }));
  const turn = await agent.prompt("classify");
  assert.deepEqual(turn.structured, { answer: 7 });
  assert.equal(turn.structuredAttempts, 2);
  const sent = prompts(readLog());
  assert.equal(sent.length, 2);
  const repair = promptText(sent[1]);
  assert.ok(repair.startsWith(STRUCTURED_TOOL_REPROMPT_TEXT), `the tool variant of the runner's repair prompt: ${repair}`);
  assert.equal(
    repair,
    repairPromptText({ toolActive: true, reason: "no StructuredOutput capture; no JSON object in the final message" }),
  );
  assert.equal(count(readLog(), "structuredToolCall"), 1, "the capture came from the repair turn");
});

test("Codex: the repair turn carries the same per-turn _meta.outputSchema, with a per-turn schemaRetries on a per-turn schema", async () => {
  const perTurn = Type.Object({ name: Type.String() });
  const { cwd, readLog } = configure({ turns: [{ text: "not json" }, { text: '{"name":"n"}' }] });
  const agent = track(await AcpAgent.open({ cwd, model: "codex" }));
  const turn = await agent.prompt("x", { schema: perTurn, schemaRetries: 1 });
  assert.deepEqual(turn.structured, { name: "n" });
  assert.equal(turn.structuredAttempts, 2);
  const sent = prompts(readLog());
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.params?._meta?.outputSchema, toStrictJsonSchema(perTurn));
  assert.deepEqual(sent[1]!.params?._meta?.outputSchema, toStrictJsonSchema(perTurn), "the native channel rides the repair too");
  assert.equal(promptText(sent[0]), "x", "Codex never embeds the contract");
  assert.equal(promptText(sent[1]), repairPromptText({ toolActive: false, reason: "no StructuredOutput capture; no JSON object in the final message" }));
});

test("an attempt that did not end with end_turn is never repaired: refusal and cancelled end the ladder with structuredAttempts 1", async () => {
  for (const stopReason of ["refusal", "cancelled"] as const) {
    const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "nope", stopReason }, { text: '{"answer":1}' }] });
    const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, schemaRetries: 2 }));
    const turn = await agent.prompt("q");
    assert.equal(turn.stopReason, stopReason);
    assert.equal(count(readLog(), "prompt"), 1, `${stopReason}: no repair turn was sent`);
    assert.equal(turn.structuredAttempts, 1);
    assert.equal(turn.structured, undefined);
    assert.match(turn.structuredError!, /no JSON object/);
    await harness.cleanup();
  }
});

test("schemaRetries is validated: the constructor refuses before any spawn, a per-turn value before anything is sent", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "nope" }] });
  // The message renders the value it saw — NaN and ±Infinity included, which JSON would print as null.
  const rejected: Array<[unknown, string]> = [
    [-1, "-1"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    ["2", '"2"'],
    [null, "null"],
    [2n, "2"],
  ];
  for (const [bad, rendered] of rejected) {
    assert.throws(
      () => new AcpAgent({ cwd, model: "pi", schema: SCHEMA, schemaRetries: bad as number }),
      (error: unknown) => {
        invalidArgument(/^AcpAgent: schemaRetries must be an integer >= 0 \(the number of extra repair turns\), got /)(error);
        assert.ok((error as Error).message.endsWith(`, got ${rendered}`), `renders ${String(bad)} as ${rendered}: ${(error as Error).message}`);
        return true;
      },
      `constructor rejects ${String(bad)}`,
    );
  }
  assert.equal(count(readLog(), "__start"), 0, "nothing spawned");
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
  await assert.rejects(
    () => agent.prompt("q", { schemaRetries: 2.5 }),
    invalidArgument(/AcpAgent\.prompt\(\{ schemaRetries \}\): schemaRetries must be an integer >= 0/),
  );
  assert.equal(count(readLog(), "prompt"), 0, "rejected before the wire");
  assert.equal(agent.state, "ready");
});

test("forks inherit schemaRetries", async () => {
  const { cwd, readLog } = configure(
    {
      lifecycleSupport: true,
      mcpHttpSupport: false,
      forkSession: { turns: [{ text: "nope" }, { text: '{"answer":2}' }] },
      turns: [{ text: '{"answer":1}' }],
    },
    { backends: ["pi"] },
  );
  const parent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA, schemaRetries: 1 }));
  assert.deepEqual((await parent.prompt("p")).structured, { answer: 1 });
  const child = track(await parent.fork());
  const turn = await child.prompt("c");
  assert.deepEqual(turn.structured, { answer: 2 });
  assert.equal(turn.structuredAttempts, 2, "the child repaired with the inherited budget");
  assert.equal(count(readLog(), "prompt"), 3);
});

test("an injected-tool capture belongs to one turn only", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      { structuredToolCall: { arguments: { answer: 7 } }, text: "prose" },
      { text: "no json here" },
      { structuredToolCall: { arguments: { answer: 9 } }, text: "prose again" },
    ],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
  const one = await agent.prompt("1");
  assert.deepEqual(one.structured, { answer: 7 });
  const two = await agent.prompt("2");
  assert.equal(two.structured, undefined, "turn one's capture was consumed, not resurrected");
  assert.match(two.structuredError!, /no StructuredOutput capture/);
  const three = await agent.prompt("3");
  assert.deepEqual(three.structured, { answer: 9 }, "a fresh capture on the still-live registration");
  assert.equal(count(readLog(), "structuredToolCall"), 2);
  assert.equal(count(readLog(), "prompt"), 3);
});

test("per-turn schema is rejected on claude, pi, opencode, and custom with a pointer at the constructor option", async () => {
  const targets: Array<{ model: string; id: string; backends?: Record<string, { command: string; args: string[] }> }> = [
    { model: "claude", id: "claude" },
    { model: "pi", id: "pi" },
    { model: "opencode", id: "opencode" },
    { model: "fake", id: "fake", backends: { fake: { command: process.execPath, args: [FAKE_AGENT_FIXTURE] } } },
  ];
  for (const target of targets) {
    const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
    const agent = track(await AcpAgent.open({ cwd, model: target.model, backends: target.backends }));
    await assert.rejects(
      () => agent.prompt("x", { schema: SCHEMA }),
      (error: unknown) => {
        assert.ok(isWorkflowError(error));
        assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
        assert.match(error.message, new RegExp(`not supported on backend "${target.id}".*constructor`));
        return true;
      },
    );
    assert.equal(count(readLog(), "prompt"), 0, `${target.id}: rejected before the wire`);
    assert.equal(agent.state, "ready");
    await harness.cleanup();
  }
});

test("close() releases the tool registration and disposes the host", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: true, turns: [{ structuredToolCall: { arguments: { answer: 1 } } }] });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
  const url = newSessionServers(readLog()).find((server) => server.name === "structured_output")?.url;
  assert.ok(url, "the injected server URL");
  assert.deepEqual((await agent.prompt("q")).structured, { answer: 1 }, "the host answered while the agent was live");
  await agent.close();
  await assert.rejects(fetch(url, { method: "POST" }), "the host's server is closed after close()");
});
