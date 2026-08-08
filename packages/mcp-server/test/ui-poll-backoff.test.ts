// The run-monitor app-only tool poll's transport and timing/stop policy: structuredContent pages
// fold by cursor, idle polls back off
// 2s → 4s → 8s → cap and reset the moment new events arrive, error retries back off to the cap,
// and the loop gives up only after a bounded run of consecutive faults so a dead run is not polled
// forever. These are the ITEM 2a (adaptive no-op backoff) and ITEM 2c (bounded retry) rules,
// factored out of the React effect so they can be checked without a DOM or fake timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import {
  classifyPollFailure,
  MAX_BACKOFF_MS,
  MAX_POLL_FAILURES,
  nextErrorBackoffMs,
  nextIdleDelayMs,
  POLL_MS,
  shouldGiveUp,
} from "../ui/src/poll-backoff.js";
import { createRunModel, foldRecord } from "../ui/src/state.js";
import {
  readWorkflowEventsPage,
  WORKFLOW_EVENTS_TOOL_NAME,
  type EventsDoc,
} from "../ui/src/workflow-events-poll.js";

function record(seq: number, event: RunEventLogRecord["event"]): RunEventLogRecord {
  return {
    version: 1,
    streamId: "a".repeat(32),
    runId: "run-poll",
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
    event,
    projection: { redacted: false, truncated: false },
  };
}

function toolApp(
  implementation: (request: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult>,
): Pick<App, "callServerTool"> {
  return { callServerTool: implementation } as unknown as Pick<App, "callServerTool">;
}

test("polling calls the app-only tool with cursor arguments and folds structuredContent", async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const events = [
    record(1, { type: "phase", runId: "run-poll", scope: "run-poll", title: "Scan" }),
    record(2, {
      type: "agentStart",
      runId: "run-poll",
      scope: "run-poll",
      label: "finder",
      prompt: "find it",
      callIndex: 0,
    }),
  ];
  const document: EventsDoc = {
    schemaVersion: 1,
    runId: "run-poll",
    streamId: "a".repeat(32),
    workflowName: "poll-flow",
    status: "running",
    finalized: false,
    after: 0,
    cursor: 2,
    endCursor: 2,
    hasMore: false,
    events,
  };
  const app = toolApp(async (request) => {
    calls.push(request);
    return { content: [], structuredContent: document, isError: false };
  });

  const page = await readWorkflowEventsPage(app, {
    runId: "run-poll",
    after: 0,
    streamId: undefined,
  });
  assert.deepEqual(calls, [
    {
      name: WORKFLOW_EVENTS_TOOL_NAME,
      arguments: { runId: "run-poll", after: 0, limit: 500, streamId: undefined },
    },
  ]);
  assert.deepEqual(page, document);

  const model = createRunModel("run-poll");
  for (const event of page?.events ?? []) foldRecord(model, event);
  if (page) {
    model.cursor = page.cursor;
    model.status = page.status;
    model.finalized = page.finalized;
    model.name = page.workflowName;
    model.streamId = page.streamId;
  }
  assert.equal(model.cursor, 2);
  assert.equal(model.name, "poll-flow");
  assert.deepEqual(model.phases, ["Scan"]);
  assert.equal(model.nodes.get(0)?.label, "finder");
});

test("tool isError uses the existing classification, backoff, and bounded give-up path", async () => {
  let calls = 0;
  const retrying = toolApp(async () => {
    calls += 1;
    return {
      content: [{ type: "text", text: "temporary host bridge failure" }],
      isError: true,
    };
  });
  let backoff = POLL_MS;
  for (let failures = 1; failures <= MAX_POLL_FAILURES; failures += 1) {
    await assert.rejects(
      readWorkflowEventsPage(retrying, { runId: "run-poll", after: 7, streamId: "a".repeat(32) }),
      /temporary host bridge failure/,
    );
    assert.equal(classifyPollFailure(new Error("temporary host bridge failure")), "retry");
    backoff = nextErrorBackoffMs(backoff);
    assert.equal(shouldGiveUp(failures), failures >= MAX_POLL_FAILURES);
  }
  assert.equal(calls, MAX_POLL_FAILURES, "one tool call per poll attempt");
  assert.equal(backoff, MAX_BACKOFF_MS);

  const missing = toolApp(async () => ({
    content: [{ type: "text", text: "[RUN_NOT_FOUND] no such run" }],
    isError: true,
  }));
  await assert.rejects(
    async () => {
      try {
        await readWorkflowEventsPage(missing, { runId: "missing", after: 0, streamId: undefined });
      } catch (error) {
        assert.equal(classifyPollFailure(error), "run-not-found");
        throw error;
      }
    },
    /RUN_NOT_FOUND/,
  );
  assert.equal(classifyPollFailure(new Error("[STREAM_MISMATCH] rebuilt")), "rebuild");
  assert.equal(classifyPollFailure(new Error("CURSOR_AHEAD")), "rebuild");
  assert.equal(classifyPollFailure(new Error("ORPHANED_LOG")), "run-not-found");
  assert.equal(classifyPollFailure(new Error("No workflow run found")), "run-not-found");
});

test("idle polls double 2s → 4s → 8s → cap and reset when new events arrive", () => {
  assert.equal(POLL_MS, 2000);
  assert.equal(MAX_BACKOFF_MS, 15_000);

  // A run that keeps returning zero new events doubles the next delay toward the cap.
  let delay = POLL_MS;
  const progression: number[] = [];
  for (let poll = 0; poll < 5; poll += 1) {
    delay = nextIdleDelayMs(delay, false);
    progression.push(delay);
  }
  assert.deepEqual(progression, [4000, 8000, 15_000, 15_000, 15_000]);

  // Any poll that brings new events resets to the base cadence, whatever the current delay.
  assert.equal(nextIdleDelayMs(15_000, true), POLL_MS);
  assert.equal(nextIdleDelayMs(POLL_MS, true), POLL_MS);
});

test("error retries double toward the cap", () => {
  assert.equal(nextErrorBackoffMs(POLL_MS), 4000);
  assert.equal(nextErrorBackoffMs(4000), 8000);
  assert.equal(nextErrorBackoffMs(8000), MAX_BACKOFF_MS);
  assert.equal(nextErrorBackoffMs(MAX_BACKOFF_MS), MAX_BACKOFF_MS);
});

test("the poll loop keeps retrying until the bounded fault count is reached, then gives up", () => {
  for (let failures = 1; failures < MAX_POLL_FAILURES; failures += 1) {
    assert.equal(shouldGiveUp(failures), false, `must keep retrying at ${failures} consecutive faults`);
  }
  assert.equal(shouldGiveUp(MAX_POLL_FAILURES), true);
  assert.equal(shouldGiveUp(MAX_POLL_FAILURES + 1), true);
});
