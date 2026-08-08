// MCP Apps surface, per the extension's graceful-degradation model: the `workflow` tool
// carries `_meta.ui.resourceUri` for every client (non-Apps hosts ignore it and keep the
// text/structured output), the server declares the extension in its initialize-response
// capabilities, and the app-only `workflow-events` poller plus the ui:// panel resource are
// always registered.
import assert from "node:assert/strict";
import test from "node:test";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import { RUN_MONITOR_RESOURCE_URI, WORKFLOW_EVENTS_TOOL_NAME } from "../src/index.js";
import { PI_STREAM_MODE_EAGER, PI_STREAM_TOOL_META_KEY } from "../src/pi-stream.js";
import { ONE_AGENT_SCRIPT, connect, okRunner, structured, textOf } from "./_harness.js";

function runIdOf(res: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["client"]["callTool"]>>): string {
  const runId = structured(res)?.runId;
  assert.equal(typeof runId, "string");
  return runId as string;
}

test("server declares the MCP Apps extension capability in its initialize response", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const capabilities = client.getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined;
    assert.ok(capabilities?.extensions, "server capabilities include extensions");
    assert.deepEqual(capabilities.extensions[EXTENSION_ID], {});
  } finally {
    await dispose();
  }
});

test("workflow carries the panel resource in _meta.ui; workflow-events is app-only", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["repl", "workflow", WORKFLOW_EVENTS_TOOL_NAME],
    );

    const workflow = tools.find((tool) => tool.name === "workflow");
    const workflowUi = (workflow?._meta as { ui?: { resourceUri?: string; visibility?: string[] } })?.ui;
    assert.equal(workflowUi?.resourceUri, RUN_MONITOR_RESOURCE_URI);
    assert.equal(workflowUi?.visibility, undefined, "workflow keeps default model+app visibility");
    assert.equal(
      (workflow?._meta as Record<string, unknown>)?.["ui/resourceUri"],
      RUN_MONITOR_RESOURCE_URI,
      "registerAppTool mirrors the legacy flat key for older hosts",
    );

    const events = tools.find((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME);
    const eventsUi = (events?._meta as { ui?: { resourceUri?: string; visibility?: string[] } })?.ui;
    assert.equal(eventsUi?.resourceUri, RUN_MONITOR_RESOURCE_URI);
    assert.deepEqual(eventsUi?.visibility, ["app"]);

    const resource = await client.readResource({ uri: RUN_MONITOR_RESOURCE_URI });
    const content = resource.contents[0] as { mimeType?: string; text?: string };
    assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
    assert.ok(typeof content.text === "string" && content.text.includes("<script"));
  } finally {
    await dispose();
  }
});

test("both panel tools declare pi eager streamMode in _meta.ui so pi opens its native push channel", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { tools } = await client.listTools();
    const streamModeOf = (name: string): unknown => {
      const tool = tools.find((candidate) => candidate.name === name);
      const ui = (tool?._meta as { ui?: Record<string, unknown> } | undefined)?.ui;
      return ui?.[PI_STREAM_TOOL_META_KEY];
    };
    // pi reads _meta.ui["pi-mcp-adapter.streamMode"] and, when eager, stamps a stream-token onto the
    // tools/call so the server can push cursor-bearing event windows to the panel.
    assert.equal(streamModeOf("workflow"), PI_STREAM_MODE_EAGER);
    assert.equal(streamModeOf(WORKFLOW_EVENTS_TOOL_NAME), PI_STREAM_MODE_EAGER);
  } finally {
    await dispose();
  }
});

test("workflow-events is annotated read-only (metadata for hosts that gate on the hint)", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const { tools } = await client.listTools();
    const events = tools.find((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME);
    // Paging the event log never mutates run state. The hint is metadata for hosts that gate on it;
    // it does not change how any host narrates app-originated calls.
    assert.equal(
      (events?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint,
      true,
    );
  } finally {
    await dispose();
  }
});

test("workflow-events pages a background run's event log to terminal state", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { script: ONE_AGENT_SCRIPT, background: true },
    });
    assert.equal(accepted.isError ?? false, false);
    const runId = runIdOf(accepted);

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 10_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");

    // Page the event log from 0 like the panel does: agentStart/agentEnd/complete all appear.
    const seenTypes = new Set<string>();
    let after = 0;
    let streamId: string | undefined;
    let finalized = false;
    let workflowName: string | undefined;
    for (let page = 0; page < 20; page++) {
      const eventsRes = await client.callTool({
        name: WORKFLOW_EVENTS_TOOL_NAME,
        arguments: { runId, after, ...(streamId === undefined ? {} : { streamId }) },
      });
      assert.equal(eventsRes.isError ?? false, false);
      const doc = structured(eventsRes) as {
        streamId: string;
        workflowName: string;
        cursor: number;
        hasMore: boolean;
        finalized: boolean;
        events: Array<{ event: { type: string } }>;
      };
      for (const record of doc.events) seenTypes.add(record.event.type);
      streamId = doc.streamId;
      workflowName = doc.workflowName;
      after = doc.cursor;
      finalized = doc.finalized;
      if (!doc.hasMore) break;
    }
    assert.ok(seenTypes.has("agentStart"), `saw ${[...seenTypes].join(",")}`);
    assert.ok(seenTypes.has("agentEnd"));
    assert.ok(seenTypes.has("complete"));
    assert.equal(finalized, true);
    assert.equal(workflowName, "one-agent");

    // Reading past the end returns an empty page, not an error.
    const emptyRes = await client.callTool({
      name: WORKFLOW_EVENTS_TOOL_NAME,
      arguments: { runId, after, streamId },
    });
    const emptyDoc = structured(emptyRes) as { events: unknown[]; hasMore: boolean };
    assert.deepEqual(emptyDoc.events, []);
    assert.equal(emptyDoc.hasMore, false);
  } finally {
    await dispose();
  }
});

test("workflow-events returns a tool error for unknown runs", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const events = await client.callTool({
      name: WORKFLOW_EVENTS_TOOL_NAME,
      arguments: { runId: "missing-run" },
    });
    assert.equal(events.isError, true);
    assert.ok(textOf(events).length > 0);
  } finally {
    await dispose();
  }
});
