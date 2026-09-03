// The `workflow` tool must exist the moment a session can issue requests.
//
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

// `notifications/initialized` is a NOTIFICATION: it carries no ordering guarantee against
// the requests a client sends after it, and over the stdio shim each frame becomes its own
// HTTP POST to the daemon. Registering the tool inside `oninitialized` therefore let a
// client's first tools/list or tools/call reach a server with nothing registered — observed
// in CI as `structuredContent === undefined` from a first tools/call (an error result), and
// as a tools/list without `workflow` at all.
//
// These tests pin the invariant at the seam where it broke: the tool is registered at
// construction, and only the negotiated MCP Apps surface waits for client capabilities.
import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";

import { createWorkflowServer } from "../src/index.js";
import { WORKFLOW_EVENTS_TOOL_NAME } from "../src/app-ui.js";
import { okRunner } from "./_harness.js";

/**
 * Connect while making the initialized notification arrive LATE, the way a pipelined client
 * (or a shim forwarding frames as independent POSTs) can. The client is fully usable as soon
 * as connect() resolves, so anything it needs must already be registered.
 */
async function connectWithDelayedInitialized(
  capabilities: Record<string, unknown>,
  delayMs: number,
): Promise<{ client: Client; deliverInitialized: () => void }> {
  const server = createWorkflowServer(okRunner());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Delay DELIVERY of the initialized notification, not the client's send: a real client
  // considers a notification sent the moment it is written, and keeps issuing requests. The
  // server must therefore be usable before the notification is processed.
  const realSend = clientTransport.send.bind(clientTransport);
  let deliver: (() => void) | undefined;
  clientTransport.send = async (message, options) => {
    const method = (message as { method?: unknown }).method;
    if (method === "notifications/initialized") {
      const send = () => void realSend(message, options);
      if (delayMs >= 0) setTimeout(send, delayMs);
      else deliver = send;
      return;
    }
    return realSend(message, options);
  };

  const client = new Client({ name: "race-test", version: "0.0.0" }, { capabilities });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, deliverInitialized: () => deliver?.() };
}

test("the workflow tool is listable and callable before notifications/initialized lands", async () => {
  // Hold the notification for the whole test: the session must be fully usable without it.
  const { client } = await connectWithDelayedInitialized({}, -1);

  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "workflow"),
    `workflow tool must exist before the initialized notification; saw [${tools.tools.map((t) => t.name).join(", ")}]`,
  );

  // A first call must return a real result, not a tool-not-found error result. The CI
  // failure surfaced precisely as a missing structuredContent here.
  const result = await client.callTool({
    name: "workflow",
    arguments: { action: "run", script: 'export const meta = { name: "x", description: "x" };\nreturn 1;' },
  });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  assert.ok(result.structuredContent, "a first tools/call must carry structuredContent");

  await client.close();
});

test("the negotiated MCP Apps surface still waits for client capabilities, then appears", async () => {
  // Capable client: no UI surface before initialized, full UI surface after.
  const capable = await connectWithDelayedInitialized(
    { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } },
    -1, // hold indefinitely until we release it
  );
  const before = await capable.client.listTools();
  assert.ok(before.tools.some((tool) => tool.name === "workflow"));
  assert.equal(
    before.tools.some((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME),
    false,
    "the app-only events tool must not appear before capabilities are known",
  );

  capable.deliverInitialized();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const after = await capable.client.listTools();
  assert.ok(
    after.tools.some((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME),
    "a negotiating client must get the app-only events tool once initialized lands",
  );
  const workflow = after.tools.find((tool) => tool.name === "workflow");
  assert.deepEqual(
    (workflow?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui,
    { resourceUri: "ui://agentprism-workflow/run-monitor.html" },
    "the workflow tool must carry UI metadata for a negotiating client",
  );
  await capable.client.close();

  // Non-capable client: the UI surface never appears, even after initialized.
  const plain = await connectWithDelayedInitialized({}, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const plainTools = await plain.client.listTools();
  assert.equal(
    plainTools.tools.some((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME),
    false,
    "a client that never advertised the extension must not receive the app-only tool",
  );
  assert.equal(
    plainTools.tools.find((tool) => tool.name === "workflow")?._meta,
    undefined,
    "a text-only client's workflow tool must carry no UI metadata",
  );
  await plain.client.close();
});
