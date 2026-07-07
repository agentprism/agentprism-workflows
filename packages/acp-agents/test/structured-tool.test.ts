import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type, type TSchema } from "typebox";
import {
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
  StructuredOutputToolHost,
  type StructuredOutputToolRegistration,
} from "../src/structured-tool.js";

const SCHEMA = Type.Object(
  {
    city: Type.String({ minLength: 2 }),
    hot: Type.Boolean(),
  },
  { additionalProperties: false },
);

interface ConnectedMcp {
  client: Client;
  close(): Promise<void>;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>> & {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

async function withHost(fn: (host: StructuredOutputToolHost) => Promise<void> | void): Promise<void> {
  const host = new StructuredOutputToolHost();
  try {
    await fn(host);
  } finally {
    await host.dispose();
  }
}

async function connect(slot: StructuredOutputToolRegistration): Promise<ConnectedMcp> {
  const transport = new StreamableHTTPClientTransport(new URL(slot.url));
  const client = new Client({ name: "structured-tool-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
}

async function call(slot: StructuredOutputToolRegistration, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(slot);
  try {
    return (await client.callTool({ name: STRUCTURED_OUTPUT_TOOL_NAME, arguments: args })) as ToolResult;
  } finally {
    await close();
  }
}

function firstText(result: ToolResult): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

test("StructuredOutput tool advertises the plain JSON schema with top-level $schema stripped", async () => {
  await withHost(async (host) => {
    const schema = {
      ...SCHEMA,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    } as TSchema;
    const slot = await host.register(schema);
    const { client, close } = await connect(slot);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.name, STRUCTURED_OUTPUT_TOOL_NAME);
      assert.equal(tools[0]?.description, STRUCTURED_OUTPUT_TOOL_DESCRIPTION);
      assert.equal("$schema" in tools[0]!.inputSchema, false);
      assert.deepEqual(tools[0]!.inputSchema, {
        type: "object",
        properties: {
          city: { type: "string", minLength: 2 },
          hot: { type: "boolean" },
        },
        required: ["city", "hot"],
        additionalProperties: false,
      });
    } finally {
      await close();
      slot.release();
    }
  });
});

test("StructuredOutput tool captures valid arguments", async () => {
  await withHost(async (host) => {
    const slot = await host.register(SCHEMA);
    const result = await call(slot, { city: "Oslo", hot: false });

    assert.equal(result.isError, undefined);
    assert.equal(firstText(result), "Structured output captured successfully.");
    assert.deepEqual(slot.tryCaptured(), { city: "Oslo", hot: false });
    slot.release();
  });
});

test("StructuredOutput tool rejects invalid arguments without clobbering prior valid capture", async () => {
  await withHost(async (host) => {
    const slot = await host.register(SCHEMA);
    await call(slot, { city: "Oslo", hot: false });
    const result = await call(slot, { city: "", hot: false });

    assert.equal(result.isError, true);
    assert.match(firstText(result), /Structured output rejected/);
    assert.match(firstText(result), /\/city|Expected/);
    assert.deepEqual(slot.tryCaptured(), { city: "Oslo", hot: false });
    slot.release();
  });
});

test("StructuredOutput tool uses the last valid call", async () => {
  await withHost(async (host) => {
    const slot = await host.register(SCHEMA);
    await call(slot, { city: "Oslo", hot: false });
    await call(slot, { city: "Rome", hot: true });

    assert.deepEqual(slot.tryCaptured(), { city: "Rome", hot: true });
    slot.release();
  });
});

test("StructuredOutput registrations isolate concurrent token paths", async () => {
  await withHost(async (host) => {
    const first = await host.register(SCHEMA);
    const second = await host.register(SCHEMA);

    await Promise.all([
      call(first, { city: "Oslo", hot: false }),
      call(second, { city: "Rome", hot: true }),
    ]);

    assert.deepEqual(first.tryCaptured(), { city: "Oslo", hot: false });
    assert.deepEqual(second.tryCaptured(), { city: "Rome", hot: true });
    first.release();
    second.release();
  });
});

test("StructuredOutput server returns 404 for unknown and released tokens", async () => {
  await withHost(async (host) => {
    const slot = await host.register(SCHEMA);
    const unknownUrl = slot.url.replace(/\/[^/]+$/, "/missing-token");
    const unknown = await fetch(unknownUrl, { method: "POST", body: "{}" });
    assert.equal(unknown.status, 404);

    slot.release();
    const released = await fetch(slot.url, { method: "POST", body: "{}" });
    assert.equal(released.status, 404);
  });
});

test("StructuredOutput server listens lazily and closes on dispose", async () => {
  const host = new StructuredOutputToolHost();
  assert.equal(host.isListening(), false);

  const slot = await host.register(SCHEMA);
  const port = host.listeningPort();
  assert.equal(host.isListening(), true);
  assert.equal(typeof port, "number");

  await host.dispose();
  assert.equal(host.isListening(), false);
  await assert.rejects(() => fetch(slot.url), /fetch failed/);
});
