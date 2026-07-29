// projectWorkflowAgentActivity mapping for tool_call_update: TERMINAL updates carrying
// displayable content become durable `tool-result` activities; everything else stays a bare
// content boundary (the pre-existing behavior for all tool_call_update events).
import assert from "node:assert/strict";
import test from "node:test";

import { projectWorkflowAgentActivity } from "../src/index.js";

function payload(update: Record<string, unknown>) {
  return {
    name: "tool_call_update" as const,
    event: update,
    backendId: "claude",
    sessionId: "session-1",
    label: "observer",
    runId: "run-1",
    scope: "run-1",
    callIndex: 0,
  };
}

const CONTENT = [{ type: "content", content: { type: "text", text: "tool output body" } }];

test("terminal tool_call_update with content maps to a tool-result activity", () => {
  const completed = projectWorkflowAgentActivity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload({ toolCallId: "t1", status: "completed", content: CONTENT, _meta: { adapter: { toolName: "read_file" } } }) as any,
  );
  assert.deepEqual(completed, {
    scope: "run-1",
    callIndex: 0,
    label: "observer",
    sessionId: "session-1",
    kind: "tool-result",
    text: "tool output body",
    toolName: "read_file",
  });

  const failed = projectWorkflowAgentActivity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload({ toolCallId: "t1", status: "failed", kind: "execute", content: CONTENT }) as any,
  );
  assert.ok(failed && failed.kind === "tool-result");
  assert.equal(failed.isError, true);
  assert.equal(failed.toolName, "execute");
});

test("non-terminal or content-less tool_call_update stays a content boundary", () => {
  for (const update of [
    { toolCallId: "t1", status: "in_progress", content: CONTENT },
    { toolCallId: "t1", status: "pending" },
    { toolCallId: "t1", status: "completed" },
    { toolCallId: "t1", status: "completed", content: [] },
    { toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "/x", newText: "y" }] },
    { toolCallId: "t1" },
  ]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activity = projectWorkflowAgentActivity(payload(update) as any);
    assert.ok(activity, `activity for ${JSON.stringify(update)}`);
    assert.equal(activity.kind, "content-boundary", JSON.stringify(update));
  }
});

test("multiple text content blocks are joined in order", () => {
  const activity = projectWorkflowAgentActivity(
    payload({
      toolCallId: "t1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "first" } },
        { type: "terminal", terminalId: "term-1" },
        { type: "content", content: { type: "text", text: "second" } },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
  assert.ok(activity && activity.kind === "tool-result");
  assert.equal(activity.text, "first\nsecond");
  assert.equal(activity.toolName, undefined);
});

test("steering remains a live observation and never becomes durable workflow activity", () => {
  const activity = projectWorkflowAgentActivity({
    name: "steering",
    event: {
      sessionId: "session-1",
      backendId: "claude",
      runId: "run-1",
      callIndex: 0,
      outcome: "injected",
    },
    backendId: "claude",
    sessionId: "session-1",
    runId: "run-1",
    scope: "run-1",
    callIndex: 0,
  } as Parameters<typeof projectWorkflowAgentActivity>[0]);
  assert.equal(activity, undefined);
});
