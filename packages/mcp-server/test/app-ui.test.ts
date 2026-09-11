// MCP Apps surface: only workflow_monitor opens an App. Data/control tools stay view-free,
// and Apps tools/resources require the exact negotiated MIME capability.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readRunStatus } from "../ui/src/run-status.js";

import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "../src/mcp-apps.js";

import {
  RUN_MONITOR_RESOURCE_URI,
  WORKFLOW_EVENTS_TOOL_NAME,
  WORKFLOW_RUNS_TOOL_NAME,
  WORKFLOW_MONITOR_TOOL_NAME,
  WORKFLOW_NOTIFICATIONS_TOOL_NAME,
} from "../src/app-ui.js";
import { ONE_AGENT_SCRIPT, NO_AGENT_SCRIPT, connect, okRunner, structured, textOf, waitForRun } from "./_harness.js";

function runIdOf(res: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["client"]["callTool"]>>): string {
  assert.equal(res.isError ?? false, false, textOf(res));
  const runId = structured(res)?.runId;
  assert.equal(typeof runId, "string");
  return runId as string;
}

test("legacy initialize advertises this server's MCP Apps extension support", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching" });
  try {
    const capabilities = client.getServerCapabilities();
    assert.deepEqual(capabilities?.extensions?.[EXTENSION_ID], {});
  } finally {
    await dispose();
  }
});

test("only workflow_monitor carries the panel resource; app-only support tools carry visibility only", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching" });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["repl", "workflow", WORKFLOW_MONITOR_TOOL_NAME, WORKFLOW_EVENTS_TOOL_NAME, WORKFLOW_RUNS_TOOL_NAME, WORKFLOW_NOTIFICATIONS_TOOL_NAME].sort(),
    );

    const workflow = tools.find((tool) => tool.name === "workflow");
    assert.equal(workflow?._meta, undefined, "every lifecycle action remains free of UI attachment");
    const monitor = tools.find((tool) => tool.name === WORKFLOW_MONITOR_TOOL_NAME);
    const monitorUi = (monitor?._meta as { ui?: { resourceUri?: string; visibility?: string[] } })?.ui;
    assert.equal(monitorUi?.resourceUri, RUN_MONITOR_RESOURCE_URI);
    assert.equal(monitorUi?.visibility, undefined, "monitor is visible to model and app");
    assert.deepEqual(monitor?._meta, { ui: { resourceUri: RUN_MONITOR_RESOURCE_URI } });
    for (const name of [WORKFLOW_EVENTS_TOOL_NAME, WORKFLOW_RUNS_TOOL_NAME, WORKFLOW_NOTIFICATIONS_TOOL_NAME]) {
      const support = tools.find((tool) => tool.name === name);
      assert.deepEqual(support?._meta, { ui: { visibility: ["app"] } }, `${name} does not open a view`);
    }

    const resource = await client.readResource({ uri: RUN_MONITOR_RESOURCE_URI });
    const content = resource.contents[0] as { mimeType?: string; text?: string };
    assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
    assert.ok(typeof content.text === "string" && content.text.includes("<script"));
  } finally {
    await dispose();
  }
});

test("only the exact well-formed extensions capability receives the MCP Apps surface", async () => {
  const matching = await connect(okRunner(), { uiCapability: "matching" });
  const absent = await connect(okRunner(), { uiCapability: "absent" });
  const nonmatching = await connect(okRunner(), { uiCapability: "nonmatching" });
  const missingMimeTypes = await connect(okRunner(), { uiCapability: "missing-mime-types" });
  const experimentalOnly = await connect(okRunner(), { uiCapability: "experimental-only" });
  const malformedString = await connect(okRunner(), { uiCapability: "malformed-string" });
  try {
    const matchingTools = (await matching.client.listTools()).tools;
    const matchingWorkflow = matchingTools.find((tool) => tool.name === "workflow");
    assert.ok(matchingWorkflow);
    assert.ok(matchingTools.some((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME));
    assert.ok(matchingTools.some((tool) => tool.name === WORKFLOW_RUNS_TOOL_NAME));
    assert.ok(matchingTools.some((tool) => tool.name === WORKFLOW_MONITOR_TOOL_NAME));
    assert.ok(matchingTools.some((tool) => tool.name === WORKFLOW_NOTIFICATIONS_TOOL_NAME));

    const sharedFields = (tool: typeof matchingWorkflow) => ({
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    });

    for (const session of [
      absent,
      nonmatching,
      missingMimeTypes,
      experimentalOnly,
      malformedString,
    ]) {
      const tools = (await session.client.listTools()).tools;
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["repl", "workflow"]);
      const workflow = tools.find((tool) => tool.name === "workflow");
      assert.ok(workflow);
      assert.equal(workflow._meta, undefined, "text workflow has no UI metadata");
      assert.deepEqual(sharedFields(workflow), sharedFields(matchingWorkflow));
      await assert.rejects(
        session.client.readResource({ uri: RUN_MONITOR_RESOURCE_URI }),
        /not found|Invalid params/i,
      );
    }
  } finally {
    await Promise.all([
      matching.dispose(),
      absent.dispose(),
      nonmatching.dispose(),
      missingMimeTypes.dispose(),
      experimentalOnly.dispose(),
      malformedString.dispose(),
    ]);
  }
});

test("workflow-events is annotated read-only (metadata for hosts that gate on the hint)", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching" });
  try {
    const { tools } = await client.listTools();
    const events = tools.find((tool) => tool.name === WORKFLOW_EVENTS_TOOL_NAME);
    // Paging the event log never mutates run state. The hint is metadata for hosts that gate on it;
    // it does not change how any host narrates app-originated calls.
    assert.equal(
      (events?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint,
      true,
    );
    assert.equal(
      (tools.find((tool) => tool.name === WORKFLOW_RUNS_TOOL_NAME)?.annotations as
        { readOnlyHint?: boolean } | undefined)?.readOnlyHint,
      true,
    );
  } finally {
    await dispose();
  }
});

test("the browser status projection reads explicit checkpoint controls from the real server outcome", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching" });
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: {
        action: "run",
        script: 'export const meta = { name: "app-checkpoint", description: "Verify the monitor status seam" }; const answer = await checkpoint("Continue from this monitor?"); return { answer };',
      },
    });
    const runId = runIdOf(accepted);
    await waitForRun(client, runId, (status) => status.status === "paused");
    const app = { callServerTool: (request: { name: string; arguments?: Record<string, unknown> }) => client.callTool(request) } as Parameters<typeof readRunStatus>[0];
    const snapshot = await readRunStatus(app, runId);
    assert.equal(snapshot.status, "paused");
    assert.equal(snapshot.pauseReason, "checkpoint_required");
    assert.equal(snapshot.checkpointContext?.callIndex, 0);
    assert.equal(snapshot.checkpointContext?.kind, "confirm");
    assert.equal(snapshot.checkpointContext?.prompt, "Continue from this monitor?");
    assert.equal(typeof snapshot.checkpointContext?.hash, "string");
    assert.deepEqual(snapshot.pendingPermissions, []);
    const resumed = await client.callTool({ name: "workflow", arguments: {
      action: "resume", runId, checkpointReplies: { [snapshot.checkpointContext!.callIndex]: true },
    } });
    assert.equal(resumed.isError, false, textOf(resumed));
    await waitForRun(client, runId, (status) => status.status === "completed");
    const completed = await readRunStatus(app, runId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.checkpointContext, undefined);
  } finally {
    await dispose();
  }
});

test("workflow-events pages an accepted asynchronous run to terminal state", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true, uiCapability: "matching" });
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT },
    });
    assert.equal(accepted.isError ?? false, false, textOf(accepted));
    const runId = runIdOf(accepted);
    const settled = await waitForRun(client, runId);
    assert.equal(structured(settled)?.status, "completed", textOf(settled));

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
      if (doc.finalized && !doc.hasMore) break;
      if (!doc.hasMore) await new Promise((resolve) => setTimeout(resolve, 10));
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

test("workflow-runs returns one bounded active/recent project dashboard", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true, uiCapability: "matching" });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT },
    });
    const firstRunId = runIdOf(first);
    const second = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT },
    });
    const secondRunId = runIdOf(second);
    await Promise.all([waitForRun(client, firstRunId), waitForRun(client, secondRunId)]);
    const listed = await client.callTool({
      name: WORKFLOW_RUNS_TOOL_NAME,
      arguments: { anchorRunId: secondRunId, limit: 2 },
    });
    assert.equal(listed.isError ?? false, false, textOf(listed));
    const runs = structured(listed)?.runs as Array<{ runId: string; status: string }>;
    assert.equal(runs.length, 2);
    assert.deepEqual(new Set(runs.map((run) => run.runId)), new Set([firstRunId, secondRunId]));
    assert.ok(runs.every((run) => run.status === "completed"));
  } finally {
    await dispose();
  }
});

test("workflow-runs keeps the panel's anchor run in a bounded listing", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true, uiCapability: "matching" });
  try {
    const first = await client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT },
    });
    const firstRunId = runIdOf(first);
    await client.callTool({ name: "workflow", arguments: { action: "run", script: ONE_AGENT_SCRIPT } });
    await client.callTool({ name: "workflow", arguments: { action: "run", script: ONE_AGENT_SCRIPT } });

    const listed = await client.callTool({
      name: WORKFLOW_RUNS_TOOL_NAME,
      arguments: { anchorRunId: firstRunId, limit: 1 },
    });
    assert.equal(listed.isError ?? false, false, textOf(listed));
    const runs = structured(listed)?.runs as Array<{ runId: string }>;
    assert.deepEqual(runs.map((run) => run.runId), [firstRunId]);
  } finally {
    await dispose();
  }
});

test("workflow-events returns a tool error for unknown runs", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching" });
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


test("workflow_monitor requires a real accepted run and never starts execution", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "matching", listTools: true });
  try {
    const missing = await client.callTool({ name: WORKFLOW_MONITOR_TOOL_NAME, arguments: { runId: "missing-run" } });
    assert.equal(missing.isError, true);
    for (const input of [{}, { runId: "" }, { runId: "missing-run", action: "run" }]) {
      const invalid = await client.callTool({ name: WORKFLOW_MONITOR_TOOL_NAME, arguments: input });
      assert.equal(invalid.isError, true, "invalid monitor input is rejected");
    }
    const accepted = await client.callTool({ name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT } });
    const runId = runIdOf(accepted);
    const monitor = await client.callTool({ name: WORKFLOW_MONITOR_TOOL_NAME, arguments: { runId } });
    assert.equal(monitor.isError, false, textOf(monitor));
    assert.equal(structured(monitor)?.runId, runId);
    await waitForRun(client, runId);
    const reopened = await client.callTool({ name: WORKFLOW_MONITOR_TOOL_NAME, arguments: { runId } });
    assert.equal(structured(reopened)?.runId, runId);
    assert.equal(structured(reopened)?.status, "completed");
  } finally { await dispose(); }
});

test("incapable clients cannot invoke hidden Apps tools by guessing their names", async () => {
  const { client, dispose } = await connect(okRunner(), { uiCapability: "absent" });
  try {
    for (const [name, args] of [
      [WORKFLOW_MONITOR_TOOL_NAME, { runId: "missing-run" }],
      [WORKFLOW_EVENTS_TOOL_NAME, { runId: "missing-run" }],
      [WORKFLOW_RUNS_TOOL_NAME, { anchorRunId: "missing-run" }],
      [WORKFLOW_NOTIFICATIONS_TOOL_NAME, { action: "claim", runId: "missing-run", eventId: "one", viewId: randomUUID() }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.match(textOf(result), /MCP Apps support|not found|Invalid params/i);
    }
  } finally { await dispose(); }
});
