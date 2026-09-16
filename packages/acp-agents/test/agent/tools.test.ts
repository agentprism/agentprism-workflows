// Client-side function tools (`AcpAgentOptions.tools`, src/agent/tools.ts + tool-host.ts) through
// the fake ACP agent: the `agent_tools` mcpServers entry on session/new (next to the caller's
// servers and the structured_output host, suffixed on a name collision), the fake listing and
// calling the tools over HTTP MCP, the SDK context each execute sees, isError results for bad
// arguments and throws, the HTTP-MCP gate (INVALID_ARGUMENT at open, nothing dropped), the
// constructor's name validation before any spawn, fork inheritance on a child-owned host, the
// id-only reattach and the cold statics, and the abort wiring (cancel, per-call signal, agent signal).
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { Type } from "typebox";
import {
  AGENT_TOOLS_SERVER_NAME,
  AcpAgent,
  defineTool,
  type AcpAgentToolContext,
  type AcpAgentToolDefinition,
} from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface McpServerEntry {
  type?: string;
  name?: string;
  url?: string;
}

interface LogEntry {
  method: string;
  serverName?: string;
  response?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message: string };
  tools?: { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };
  params?: {
    sessionId?: string;
    prompt?: ContentBlock[];
    mcpServers?: McpServerEntry[];
  };
}

const SCHEMA = Type.Object({ answer: Type.Number() });
const LookupInput = Type.Object({ q: Type.String(), n: Type.Number() });

const harness = createFakeAgentHarness({ prefix: "acp-agent-tools-it-", backends: ["claude", "pi"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);
const count = (log: LogEntry[], method: string): number => log.filter((entry) => entry.method === method).length;
const serversOf = (entry: LogEntry | undefined): McpServerEntry[] => entry?.params?.mcpServers ?? [];
const newSessionServers = (log: LogEntry[]): McpServerEntry[] => serversOf(log.find((entry) => entry.method === "newSession"));
const agentToolsEntry = (servers: McpServerEntry[]): McpServerEntry | undefined =>
  servers.find((server) => server.name === AGENT_TOOLS_SERVER_NAME);
const toolCalls = (log: LogEntry[]): LogEntry[] => log.filter((entry) => entry.method === "structuredToolCall");
const resultText = (entry: LogEntry | undefined): string =>
  entry?.response?.content?.find((block) => block.type === "text")?.text ?? "";

function lookup(seen: AcpAgentToolContext[] = []): AcpAgentToolDefinition {
  return defineTool({
    name: "lookup",
    description: "Look something up",
    inputSchema: LookupInput,
    execute: (input, ctx) => {
      seen.push(ctx);
      return `lookup:${input.q}:${typeof input.n}:${input.n}`;
    },
  });
}

const add = defineTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
  execute: ({ a, b }) => String(a + b),
});

/** A tool that resolves `started` when called and then waits for `ctx.signal`. */
function waiting(): { tool: AcpAgentToolDefinition; started: Promise<AcpAgentToolContext>; reasons: unknown[] } {
  let start!: (ctx: AcpAgentToolContext) => void;
  const started = new Promise<AcpAgentToolContext>((resolve) => (start = resolve));
  const reasons: unknown[] = [];
  const tool = defineTool({
    name: "wait",
    description: "waits for the signal",
    inputSchema: Type.Object({}),
    execute: (_input, ctx) =>
      new Promise<string>((_resolve, reject) => {
        start(ctx);
        ctx.signal.addEventListener(
          "abort",
          () => {
            reasons.push(ctx.signal.reason);
            reject(ctx.signal.reason);
          },
          { once: true },
        );
      }),
  });
  return { tool, started, reasons };
}

function invalidArgument(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(isWorkflowError(error), `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, WorkflowErrorCode.INVALID_ARGUMENT);
    assert.equal(error.recoverable, false);
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

test("session/new carries agent_tools after the caller's servers and the structured_output host; the agent lists and calls the tools; execute sees the SDK context", async () => {
  const userServer = { type: "http" as const, name: "u", url: "http://127.0.0.1:1/x", headers: [] };
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCalls: [
          { serverName: "agent_tools", toolName: "lookup", arguments: { q: "x", n: "3" }, listTools: true },
          { arguments: { answer: 7 } },
        ],
        text: "prose",
      },
    ],
  });
  const seen: AcpAgentToolContext[] = [];
  const agent = track(
    await AcpAgent.open({ cwd, model: "pi", label: "primary", schema: SCHEMA, mcpServers: [userServer], tools: [lookup(seen), add] }),
  );
  const servers = newSessionServers(readLog());
  assert.deepEqual(
    servers.map((server) => server.name),
    ["u", "structured_output", "agent_tools"],
    "the caller's servers first, then the two injected hosts",
  );
  const injected = agentToolsEntry(servers)!;
  assert.equal(injected.type, "http");
  assert.match(injected.url!, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  assert.notEqual(new URL(injected.url!).port, new URL(servers[1]!.url!).port, "a separate server from the structured-output host");

  const turn = await agent.prompt("go");
  assert.equal(turn.text, "prose");
  assert.deepEqual(turn.structured, { answer: 7 }, "the structured capture coexists with the function tools");

  const log = readLog();
  const listed = log.find((entry) => entry.method === "structuredToolList");
  assert.equal(listed?.serverName, "agent_tools");
  assert.deepEqual(
    listed?.tools?.tools.map((tool) => [tool.name, tool.description]),
    [
      ["lookup", "Look something up"],
      ["add", "Add two numbers"],
    ],
  );
  assert.deepEqual(listed?.tools?.tools[0]?.inputSchema, {
    type: "object",
    properties: { q: { type: "string" }, n: { type: "number" } },
    required: ["q", "n"],
  });
  const call = toolCalls(log).find((entry) => entry.serverName === "agent_tools");
  assert.equal(call?.response?.isError, undefined);
  assert.equal(resultText(call), "lookup:x:number:3", "typebox Convert coerced the string before execute");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.sessionId, agent.sessionId);
  assert.equal(seen[0]!.backendId, "pi");
  assert.equal(seen[0]!.label, "primary");
  assert.equal(seen[0]!.toolCallId, undefined, "no tool_call update was surfaced for this call");
  assert.ok(seen[0]!.signal instanceof AbortSignal);
  assert.equal(seen[0]!.signal.aborted, false);
});

test("a caller's server named agent_tools keeps its name; the injected host becomes agent_tools_2", async () => {
  const shadow = { type: "http" as const, name: "agent_tools", url: "http://127.0.0.1:1/x", headers: [] };
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [{ structuredToolCall: { serverName: "agent_tools_2", toolName: "add", arguments: { a: 2, b: 3 } }, text: "ok" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", mcpServers: [shadow], tools: [add] }));
  const servers = newSessionServers(readLog());
  assert.deepEqual(servers[0], shadow);
  assert.equal(servers[1]?.name, "agent_tools_2");
  await agent.prompt("go");
  const call = toolCalls(readLog())[0];
  assert.equal(call?.serverName, "agent_tools_2");
  assert.equal(resultText(call), "5");
});

test("toolCallId correlates with the tool_call the agent surfaced for the call (pi's mcp__agent_tools__<name> alias)", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCall: {
          serverName: "agent_tools",
          toolName: "lookup",
          arguments: { q: "x", n: 1 },
          toolCallUpdate: {
            toolCallId: "tc-7",
            title: "mcp__agent_tools__lookup",
            name: "mcp__agent_tools__lookup",
            kind: "other",
            status: "in_progress",
          },
        },
        text: "ok",
      },
    ],
  });
  const seen: AcpAgentToolContext[] = [];
  const agent = track(await AcpAgent.open({ cwd, model: "pi", tools: [lookup(seen)] }));
  const turn = await agent.prompt("go");
  assert.equal(seen[0]?.toolCallId, "tc-7");
  assert.equal(turn.toolCalls[0]?.toolCallId, "tc-7", "the same call is in the turn's fold");
  assert.equal(turn.toolCalls[0]?.name, "mcp__agent_tools__lookup");
  assert.equal(count(readLog(), "structuredToolCall"), 1);
});

test("bad arguments and a thrown execute come back to the agent as isError results; the turn resolves normally", async () => {
  const boom = defineTool({
    name: "boom",
    description: "throws",
    inputSchema: Type.Object({}),
    execute: () => {
      throw new Error("kaboom");
    },
  });
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCalls: [
          { serverName: "agent_tools", toolName: "lookup", arguments: { q: "x" }, label: "invalid" },
          { serverName: "agent_tools", toolName: "boom", arguments: {}, label: "thrown" },
        ],
        text: "still here",
      },
    ],
  });
  const seen: AcpAgentToolContext[] = [];
  const agent = track(await AcpAgent.open({ cwd, model: "pi", tools: [lookup(seen), boom] }));
  const turn = await agent.prompt("go");
  assert.equal(turn.text, "still here");
  assert.equal(turn.stopReason, "end_turn");
  const calls = toolCalls(readLog());
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.error, undefined, "a validation failure is a result, not a transport error");
  assert.equal(calls[0]!.response?.isError, true);
  assert.match(resultText(calls[0]), /^Invalid arguments for tool "lookup": /);
  assert.equal(seen.length, 0, "execute never ran on invalid input");
  assert.equal(calls[1]!.error, undefined);
  assert.equal(calls[1]!.response?.isError, true);
  assert.equal(resultText(calls[1]), "kaboom");
  assert.equal(agent.state, "ready");
});

test("an agent that does not advertise mcpCapabilities.http refuses the open with INVALID_ARGUMENT naming the backend; nothing is opened and no tool is dropped", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: false, turns: [{ text: "never" }] });
  await assert.rejects(
    AcpAgent.open({ cwd, model: "pi", label: "tooled", tools: [lookup(), add] }),
    (error: unknown) => {
      invalidArgument(/function tools need HTTP MCP, but backend "pi" does not advertise mcpCapabilities\.http/)(error);
      assert.match((error as Error).message, /2 tools configured: lookup, add/);
      assert.equal((error as { agentLabel?: string }).agentLabel, "tooled");
      return true;
    },
  );
  let log = readLog();
  assert.equal(count(log, "initialize"), 1, "the gate needs the initialize advertisement");
  assert.equal(count(log, "newSession"), 0, "no session/new without the tools");
  await waitFor(() => count(readLog(), "__exit") === 1);
  await waitFor(() => liveConnectionCount() === 0);

  // The lazy path: the first prompt() carries the same refusal and the agent is closed.
  await harness.cleanup();
  const lazy = configure({ mcpHttpSupport: false, turns: [{ text: "never" }] });
  const agent = track(new AcpAgent({ cwd: lazy.cwd, model: "pi", tools: [add] }));
  await assert.rejects(agent.prompt("go"), invalidArgument(/function tools need HTTP MCP/));
  assert.equal(agent.state, "closed");
  log = lazy.readLog();
  assert.equal(count(log, "newSession"), 0);
  assert.equal(count(log, "prompt"), 0);
  await assert.rejects(agent.prompt("again"), invalidArgument(/is closed/));

  // Without tools the same agent opens fine: the gate is about the tools, not the backend.
  await harness.cleanup();
  const plain = configure({ mcpHttpSupport: false, turns: [{ text: "fine" }] });
  const bare = track(await AcpAgent.open({ cwd: plain.cwd, model: "pi", tools: [] }));
  assert.equal((await bare.prompt("go")).text, "fine");
  assert.equal(agentToolsEntry(newSessionServers(plain.readLog())), undefined, "an empty tools array injects nothing");
});

test("tool definitions are validated in the constructor: names, uniqueness, and shape are INVALID_ARGUMENT before any spawn", async () => {
  const { cwd, readLog } = configure({ mcpHttpSupport: true, turns: [{ text: "never" }] });
  const cases: Array<{ tools: unknown; pattern: RegExp }> = [
    { tools: [{ ...add, name: "bad name" }], pattern: /tools\[0\]\.name must match \^\[A-Za-z0-9_-\]\{1,64\}\$ \(got "bad name"\)/ },
    { tools: [{ ...add, name: "" }], pattern: /tools\[0\]\.name must match/ },
    { tools: [{ ...add, name: "x".repeat(65) }], pattern: /tools\[0\]\.name must match/ },
    { tools: [{ ...add, name: "dotted.name" }], pattern: /tools\[0\]\.name must match/ },
    { tools: [add, { ...lookup(), name: "add" }], pattern: /duplicate tool name "add"/ },
    { tools: [{ ...add, execute: undefined }], pattern: /tool "add" needs an execute function/ },
    { tools: [{ ...add, description: undefined }], pattern: /tool "add" needs a string description/ },
    { tools: [{ ...add, inputSchema: undefined }], pattern: /tool "add" needs an inputSchema/ },
    { tools: [null], pattern: /tools\[0\] must be a tool definition object/ },
    { tools: { name: "add" }, pattern: /`tools` must be an array/ },
  ];
  for (const { tools, pattern } of cases) {
    assert.throws(
      () => new AcpAgent({ cwd, model: "pi", label: "guarded", tools: tools as AcpAgentToolDefinition[] }),
      (error: unknown) => {
        invalidArgument(pattern)(error);
        assert.equal((error as { agentLabel?: string }).agentLabel, "guarded");
        return true;
      },
    );
  }
  // The statics and fork share the constructor's guard.
  await assert.rejects(
    AcpAgent.resume(
      { sessionId: "s", backendId: "pi", cwd, reopen: { load: true, resume: true, list: false } },
      { tools: [{ ...add, name: "bad name" }] },
    ),
    invalidArgument(/tools\[0\]\.name must match/),
  );
  assert.equal(readLog().length, 0, "nothing spawned");
  // Valid names cover the whole grammar.
  const agent = new AcpAgent({ cwd, model: "pi", tools: [{ ...add, name: "A-z_09" }, { ...add, name: "x".repeat(64) }] });
  assert.equal(agent.state, "idle");
  assert.equal(readLog().length, 0, "the constructor spawns nothing");
});

test("forks inherit the tools on a host of their own; the parent's close leaves the child serving; an override replaces them", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    lifecycleSupport: true,
    forkSession: {
      turns: [{ structuredToolCall: { serverName: "agent_tools", toolName: "lookup", arguments: { q: "child", n: 2 } }, text: "child" }],
    },
    turns: [{ structuredToolCall: { serverName: "agent_tools", toolName: "lookup", arguments: { q: "parent", n: 1 } }, text: "parent" }],
  });
  const seen: AcpAgentToolContext[] = [];
  const parent = track(await AcpAgent.open({ cwd, model: "pi", label: "primary", tools: [lookup(seen)] }));
  assert.equal((await parent.prompt("p")).text, "parent");
  const parentUrl = agentToolsEntry(newSessionServers(readLog()))!.url!;

  const child = track(await parent.fork());
  const bare = track(await parent.fork({ tools: [] }));
  const log = readLog();
  const forks = log.filter((entry) => entry.method === "forkSession");
  assert.equal(forks.length, 2);
  const childEntry = agentToolsEntry(serversOf(forks[0]));
  assert.ok(childEntry, "the inherited tools ride session/fork");
  assert.notEqual(childEntry.url, parentUrl, "the child runs its own host");
  assert.equal(agentToolsEntry(serversOf(forks[1])), undefined, "an override to [] injects nothing on that fork");

  await parent.close();
  assert.equal((await child.prompt("go")).text, "child", "the child's host outlives the parent");
  const calls = toolCalls(readLog());
  assert.deepEqual(calls.map(resultText), ["lookup:parent:number:1", "lookup:child:number:2"]);
  assert.deepEqual(
    seen.map((ctx) => [ctx.sessionId, ctx.label]),
    [
      [parent.sessionId, "primary"],
      [child.sessionId, "primary/fork-1"],
    ],
  );
  await assert.rejects(fetch(parentUrl, { method: "POST", body: "{}" }), "the parent's host closed with the parent");
  await bare.close();
});

test("id-only fork: agent_tools rides session/fork and the reattach with the same URL; a cold resume injects a fresh host", async () => {
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    lifecycleSupport: true,
    forkSession: { idOnly: true, turns: [{ text: "child" }] },
    turns: [{ structuredToolCall: { serverName: "agent_tools", toolName: "add", arguments: { a: 1, b: 1 } }, text: "answer" }],
  });
  const parent = track(await AcpAgent.open({ cwd, model: "claude", raw: false, tools: [add] }));
  assert.equal((await parent.prompt("p")).text, "answer");
  const parentUrl = agentToolsEntry(newSessionServers(readLog()))!.url!;

  const child = track(await parent.fork());
  let log = readLog();
  const forkUrl = agentToolsEntry(serversOf(log.find((entry) => entry.method === "forkSession")))?.url;
  const reattachUrl = agentToolsEntry(
    serversOf(log.find((entry) => entry.method === "resumeSession" && entry.params?.sessionId === child.sessionId)),
  )?.url;
  assert.ok(forkUrl, "injected on session/fork");
  assert.equal(reattachUrl, forkUrl, "the same child host on the id-only reattach");
  assert.notEqual(forkUrl, parentUrl);

  await parent.close({ keep: true });
  const resumed = track(await AcpAgent.resume(parent.sessionRef!, { tools: [add] }));
  assert.equal((await resumed.prompt("again")).text, "answer", "a fresh fake process serves turns[0] again");
  log = readLog();
  const resumeEntry = log.filter((entry) => entry.method === "resumeSession" && entry.params?.sessionId === resumed.sessionId).at(-1);
  const resumedUrl = agentToolsEntry(serversOf(resumeEntry))?.url;
  assert.ok(resumedUrl, "the cold static injects the tools on session/resume");
  assert.notEqual(resumedUrl, parentUrl, "a fresh host for the fresh agent");
  const calls = toolCalls(log);
  assert.deepEqual(calls.map(resultText), ["2", "2"], "both the original and the resumed agent answered the call");
});

test("cancel() aborts a running execute with ctx.signal; the turn settles cancelled and the agent stays usable", async () => {
  const { tool, started, reasons } = waiting();
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      {
        structuredToolCall: { serverName: "agent_tools", toolName: "wait", arguments: {} },
        waitForCancel: true,
        parkAfterUpdates: true,
        text: "partial",
      },
      { text: "next" },
    ],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", tools: [tool] }));
  const pending = agent.prompt("go");
  const ctx = await started;
  assert.equal(ctx.signal.aborted, false);
  await agent.cancel();
  const turn = await pending;
  assert.equal(turn.stopReason, "cancelled");
  assert.equal(turn.text, "partial", "the agent's partial output after the aborted tool still lands");
  assert.equal(reasons.length, 1);
  assert.match((reasons[0] as Error).message, /AcpAgent\.cancel\(\): the turn was cancelled/);
  const call = toolCalls(readLog())[0];
  assert.equal(call?.response?.isError, true);
  assert.match(resultText(call), /the turn was cancelled/);
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("again")).text, "next");
});

test("a per-call signal aborts the running execute with its reason; the turn rejects with that reason", async () => {
  const { tool, started, reasons } = waiting();
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [
      { structuredToolCall: { serverName: "agent_tools", toolName: "wait", arguments: {} }, waitForCancel: true, parkAfterUpdates: true },
      { text: "next" },
    ],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "pi", tools: [tool] }));
  const controller = new AbortController();
  const pending = agent.prompt("go", { signal: controller.signal });
  await started;
  const stop = new Error("stop this turn");
  controller.abort(stop);
  await assert.rejects(pending, (error: unknown) => error === stop);
  assert.deepEqual(reasons, [stop], "ctx.signal carries the caller's reason untouched");
  assert.equal(resultText(toolCalls(readLog())[0]), "stop this turn");
  assert.equal(agent.state, "ready");
  assert.equal((await agent.prompt("again")).text, "next");
});

test("the agent's constructor signal aborts a running execute and closes the host with the agent", async () => {
  const { tool, started, reasons } = waiting();
  const { cwd, readLog } = configure({
    mcpHttpSupport: true,
    turns: [{ structuredToolCall: { serverName: "agent_tools", toolName: "wait", arguments: {} }, waitForCancel: true, parkAfterUpdates: true }],
  });
  const controller = new AbortController();
  const agent = track(await AcpAgent.open({ cwd, model: "pi", tools: [tool], signal: controller.signal }));
  const url = agentToolsEntry(newSessionServers(readLog()))!.url!;
  const pending = agent.prompt("go");
  await started;
  const reason = new Error("agent aborted");
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.deepEqual(reasons, [reason]);
  assert.equal(agent.state, "closed");
  await waitFor(() => liveConnectionCount() === 0);
  await assert.rejects(fetch(url, { method: "POST", body: "{}" }), "the host is closed with the agent");
});
