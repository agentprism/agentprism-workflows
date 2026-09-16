// Schema plumbing of the SDK (src/agent/structured.ts) per backend channel: Claude's session
// _meta + native result, Codex's per-turn _meta.outputSchema (+ the per-turn override), the
// injected StructuredOutput HTTP tool on http-MCP agents (pi here), the no-injection embed +
// final-text fallback, the no-repair error ladder, turn-scoped captures, the per-turn schema
// gate, and the host teardown on close.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { Type } from "typebox";
import { AcpAgent, toStrictJsonSchema } from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
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
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const count = (log: LogEntry[], method: string): number => log.filter((entry) => entry.method === method).length;
const newSessionServers = (log: LogEntry[]): McpServerEntry[] =>
  log.find((entry) => entry.method === "newSession")?.params?.mcpServers ?? [];
const promptText = (entry: LogEntry | undefined): string =>
  (entry?.params?.prompt ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

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

test("invalid or missing structured output sets structuredError and never re-prompts", async () => {
  {
    const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "no json here" }] });
    const agent = track(await AcpAgent.open({ cwd, model: "pi", schema: SCHEMA }));
    const turn = await agent.prompt("q");
    assert.equal(count(readLog(), "prompt"), 1, "exactly one prompt: no repair ladder");
    assert.equal(turn.structured, undefined);
    assert.equal("structured" in turn, false);
    assert.match(turn.structuredError!, /no JSON object/);
    assert.match(turn.structuredError!, /no StructuredOutput capture/);
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
  }
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
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
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
