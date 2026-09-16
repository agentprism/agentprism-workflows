// The per-agent function-tool host (src/agent/tool-host.ts) driven directly over HTTP MCP with the
// SDK client the real agents use: tools/list advertises every definition's JSON Schema, tools/call
// validates (Convert + Check), runs `execute` with the SDK context, and turns a validation failure
// or a throw into an `isError` result; `abortInFlight` / `dispose` reach a running `execute`.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { AgentToolHost, type AgentToolHostContext } from "../../src/agent/tool-host.js";
import { defineTool } from "../../src/agent/tools.js";
import type { AcpAgentToolContext, AcpAgentToolDefinition, AcpAgentToolResult } from "../../src/index.js";

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

const CONTEXT: AgentToolHostContext = {
  sessionId: "sess-1",
  backendId: "pi",
  label: "primary",
  resolveToolCallId: (name) => (name === "lookup" ? "tc-42" : undefined),
};

const LookupInput = Type.Object({ q: Type.String({ minLength: 1 }), n: Type.Number() });

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

async function withHost(
  tools: AcpAgentToolDefinition[],
  fn: (host: AgentToolHost, client: Client) => Promise<void>,
  context: () => AgentToolHostContext = () => CONTEXT,
): Promise<void> {
  const host = new AgentToolHost(tools, context);
  const url = await host.listen();
  const client = new Client({ name: "tool-host-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    await fn(host, client);
  } finally {
    await client.close().catch(() => undefined);
    await host.dispose();
  }
}

function text(result: unknown): string {
  return (result as ToolResult).content?.find((block) => block.type === "text")?.text ?? "";
}

test("tools/list advertises every definition in order with its JSON Schema ($schema stripped)", async () => {
  const add = defineTool({
    name: "add",
    description: "Add two numbers",
    inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }, { additionalProperties: false }),
    execute: ({ a, b }) => String(a + b),
  });
  await withHost([lookup(), add], async (host, client) => {
    assert.deepEqual(host.toolNames, ["lookup", "add"]);
    assert.match(host.url!, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.description]),
      [
        ["lookup", "Look something up"],
        ["add", "Add two numbers"],
      ],
    );
    assert.deepEqual(tools[0]!.inputSchema, {
      type: "object",
      properties: { q: { type: "string", minLength: 1 }, n: { type: "number" } },
      required: ["q", "n"],
    });
    assert.equal("$schema" in tools[1]!.inputSchema, false);
    assert.equal((tools[1]!.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);
  });
});

test("tools/call converts and validates the input, runs execute with the SDK context, and shapes every result form", async () => {
  const seen: AcpAgentToolContext[] = [];
  const blocks = defineTool({
    name: "blocks",
    description: "content blocks",
    inputSchema: Type.Object({}),
    execute: () => [
      { type: "text" as const, text: "one" },
      { type: "text" as const, text: "two" },
    ],
  });
  const flagged = defineTool({
    name: "flagged",
    description: "a complete result",
    inputSchema: Type.Object({ fail: Type.Boolean() }),
    execute: ({ fail }) => ({ content: [{ type: "text" as const, text: fail ? "nope" : "fine" }], isError: fail }),
  });
  await withHost([lookup(seen), blocks, flagged], async (host, client) => {
    // typebox Convert coerces "3" → 3 before Check; execute sees the converted input.
    const ok = await client.callTool({ name: "lookup", arguments: { q: "x", n: "3" } });
    assert.equal(ok.isError, undefined);
    assert.equal(text(ok), "lookup:x:number:3");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, "sess-1");
    assert.equal(seen[0]!.backendId, "pi");
    assert.equal(seen[0]!.label, "primary");
    assert.equal(seen[0]!.toolCallId, "tc-42", "the context resolver's correlation rides ctx");
    assert.ok(seen[0]!.signal instanceof AbortSignal);
    assert.equal(seen[0]!.signal.aborted, false);

    const many = (await client.callTool({ name: "blocks", arguments: {} })) as ToolResult;
    assert.deepEqual(many.content, [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    assert.equal(many.isError, undefined);

    const fine = (await client.callTool({ name: "flagged", arguments: { fail: false } })) as ToolResult;
    assert.equal(fine.isError, undefined, "isError: false is dropped, not forwarded");
    assert.equal(text(fine), "fine");
    const nope = (await client.callTool({ name: "flagged", arguments: { fail: true } })) as ToolResult;
    assert.equal(nope.isError, true, "isError: true passes through as-is");
    assert.equal(text(nope), "nope");
    assert.equal(host.inFlight, 0);
  });
});

test("a validation failure is an isError result naming the tool and the path; execute never runs", async () => {
  const seen: AcpAgentToolContext[] = [];
  await withHost([lookup(seen)], async (_host, client) => {
    const missing = (await client.callTool({ name: "lookup", arguments: { q: "x" } })) as ToolResult;
    assert.equal(missing.isError, true);
    assert.match(text(missing), /^Invalid arguments for tool "lookup": /);
    assert.match(text(missing), /\/n|Expected|required/);
    const wrongType = (await client.callTool({ name: "lookup", arguments: { q: "", n: "not a number" } })) as ToolResult;
    assert.equal(wrongType.isError, true);
    assert.match(text(wrongType), /Invalid arguments for tool "lookup"/);
    assert.equal(seen.length, 0);
  });
});

test("a thrown execute, a non-conforming return, and a call before the session is open are isError results, not transport errors", async () => {
  const boom = defineTool({
    name: "boom",
    description: "throws",
    inputSchema: Type.Object({}),
    execute: () => {
      throw new Error("kaboom");
    },
  });
  const nothing = defineTool({
    name: "nothing",
    description: "returns undefined",
    inputSchema: Type.Object({}),
    execute: () => undefined as unknown as AcpAgentToolResult,
  });
  const rejects = defineTool({
    name: "rejects",
    description: "rejects with a non-Error",
    inputSchema: Type.Object({}),
    execute: () => Promise.reject("plain string reason"),
  });
  let sessionId: string | undefined = "sess-1";
  await withHost(
    [boom, nothing, rejects, lookup()],
    async (_host, client) => {
      const thrown = (await client.callTool({ name: "boom", arguments: {} })) as ToolResult;
      assert.deepEqual(thrown, { content: [{ type: "text", text: "kaboom" }], isError: true });
      const empty = (await client.callTool({ name: "nothing", arguments: {} })) as ToolResult;
      assert.equal(empty.isError, true);
      assert.match(text(empty), /Tool "nothing" returned undefined; expected a string/);
      const rejected = (await client.callTool({ name: "rejects", arguments: {} })) as ToolResult;
      assert.deepEqual(rejected, { content: [{ type: "text", text: "plain string reason" }], isError: true });

      sessionId = undefined;
      const early = (await client.callTool({ name: "lookup", arguments: { q: "x", n: 1 } })) as ToolResult;
      assert.equal(early.isError, true);
      assert.match(text(early), /called before the agent's session was open/);

      // An unknown tool is the one protocol-level error: the agent could only have learned names
      // from tools/list, so a miss is misuse, answered as an MCP InvalidParams error.
      await assert.rejects(
        client.callTool({ name: "missing", arguments: {} }),
        (error: unknown) => /Unknown tool: missing/.test(String((error as Error).message)) && (error as { code?: number }).code === -32602,
      );
    },
    () => ({ ...CONTEXT, sessionId }),
  );
});

test("an async execute completes over the wire, and abortInFlight reaches a running execute through ctx.signal", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const reasons: unknown[] = [];
  const slow = defineTool({
    name: "slow",
    description: "awaits a timer",
    inputSchema: Type.Object({ ms: Type.Number() }),
    execute: async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `slept ${ms}`;
    },
  });
  const wait = defineTool({
    name: "wait",
    description: "waits for the signal",
    inputSchema: Type.Object({}),
    execute: (_input, ctx) =>
      new Promise<string>((_resolve, reject) => {
        started();
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
  await withHost([slow, wait], async (host, client) => {
    // The result of an execute that awaits real I/O is written before the per-request teardown.
    assert.equal(text(await client.callTool({ name: "slow", arguments: { ms: 60 } })), "slept 60");

    const pending = client.callTool({ name: "wait", arguments: {} }) as Promise<ToolResult>;
    await startedPromise;
    assert.equal(host.inFlight, 1);
    host.abortInFlight(new Error("turn cancelled"));
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(text(result), "turn cancelled");
    assert.equal(reasons.length, 1);
    assert.equal((reasons[0] as Error).message, "turn cancelled");
    assert.equal(host.inFlight, 0);
  });
});

test("dispose aborts a running execute and closes the server; listen() after dispose rejects", async () => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => (started = resolve));
  const wait = defineTool({
    name: "wait",
    description: "waits for the signal",
    inputSchema: Type.Object({}),
    execute: (_input, ctx) =>
      new Promise<string>((_resolve, reject) => {
        started();
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
      }),
  });
  const host = new AgentToolHost([wait], () => CONTEXT);
  assert.equal(host.isListening(), false);
  assert.equal(host.url, undefined);
  const url = await host.listen();
  assert.equal(await host.listen(), url, "listen() is idempotent: one token URL per host");
  assert.equal(host.isListening(), true);
  const client = new Client({ name: "tool-host-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const pending = client.callTool({ name: "wait", arguments: {} }) as Promise<ToolResult>;
  await startedPromise;
  await host.dispose();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(text(result), /AcpAgent closed while the tool call was running/);
  await client.close().catch(() => undefined);
  assert.equal(host.isListening(), false);
  await assert.rejects(fetch(url, { method: "POST", body: "{}" }), /fetch failed/);
  await assert.rejects(host.listen(), /disposed/);
  await host.dispose();
});

test("the token path is the only route: a different token or a nested path is 404", async () => {
  await withHost([lookup()], async (host) => {
    const url = new URL(host.url!);
    const other = await fetch(`${url.origin}/${"0".repeat(32)}`, { method: "POST", body: "{}" });
    assert.equal(other.status, 404);
    const nested = await fetch(`${host.url}/extra`, { method: "POST", body: "{}" });
    assert.equal(nested.status, 404);
    const root = await fetch(`${url.origin}/`, { method: "POST", body: "{}" });
    assert.equal(root.status, 404);
  });
});
