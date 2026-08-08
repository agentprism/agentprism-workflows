import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { PersistedRunEvent, RunEventLogRecord } from "@automatalabs/shared-types";

import {
  createModelMessageState,
  sendModelMessagesForFold,
} from "../ui/src/model-messages.js";

type SentMessage = Parameters<App["sendMessage"]>[0];

function record(
  seq: number,
  event: Record<string, unknown>,
  streamId = "a".repeat(32),
): RunEventLogRecord {
  return {
    version: 1,
    streamId,
    runId: "run-msg",
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
    event: event as unknown as PersistedRunEvent,
    projection: { redacted: false, truncated: false },
  };
}

function messageApp(
  sent: SentMessage[],
  result: () => Promise<{ isError?: boolean }> = async () => ({}),
): Pick<App, "sendMessage"> {
  return {
    sendMessage: async (message) => {
      sent.push(message);
      return result();
    },
  } as Pick<App, "sendMessage">;
}

test("ui/message selects only phase, every paused reason, and complete in exact order", () => {
  const sent: SentMessage[] = [];
  const app = messageApp(sent);
  const state = createModelMessageState();

  // The first cursor-zero fold is bootstrap, so even selected historical events stay silent.
  sendModelMessagesForFold(
    app,
    "run-msg",
    0,
    [
      record(1, { type: "phase", title: "Historical", runId: "run-msg", scope: "run-msg" }),
      record(2, {
        type: "complete",
        runId: "run-msg",
        scope: "run-msg",
        summary: { workflowName: "old", agentCount: 0 },
      }),
    ],
    state,
  );
  assert.deepEqual(sent, []);

  sendModelMessagesForFold(
    app,
    "run-msg",
    2,
    [
      record(3, { type: "phase", title: "Scan", runId: "run-msg", scope: "run-msg" }),
      record(4, {
        type: "agentStart",
        runId: "run-msg",
        scope: "run-msg",
        label: "finder",
        prompt: "find",
        callIndex: 0,
      }),
      record(5, {
        type: "agentProgress",
        runId: "run-msg",
        scope: "run-msg",
        label: "finder",
        callIndex: 0,
        executionStartSeq: 4,
        turnCount: 1,
        observedEvents: 1,
        coalescedEvents: 0,
        cause: "activity",
        latestText: "working",
      }),
      record(6, {
        type: "agentEnd",
        runId: "run-msg",
        scope: "run-msg",
        label: "finder",
        callIndex: 0,
        result: { preview: "done", redacted: false, truncated: false },
      }),
      record(7, { type: "log", runId: "run-msg", scope: "run-msg", message: "detail" }),
      record(8, {
        type: "tokenUsage",
        runId: "run-msg",
        scope: "run-msg",
        usage: { total: 10, cost: 0.01 },
      }),
      record(9, { type: "paused", runId: "run-msg", scope: "run-msg" }),
      record(10, { type: "resumed", runId: "run-msg", scope: "run-msg" }),
      record(11, {
        type: "paused",
        runId: "run-msg",
        scope: "run-msg",
        reason: "usage_limit",
        resetHint: "resets at 5pm",
        errorRecord: {},
      }),
      record(12, {
        type: "paused",
        runId: "run-msg",
        scope: "run-msg",
        reason: "auth_required",
        authContext: { backendId: "claude", methods: [] },
        errorRecord: {},
      }),
      record(13, {
        type: "paused",
        runId: "run-msg",
        scope: "run-msg",
        reason: "checkpoint_required",
        checkpointContext: { callIndex: 2, kind: "confirm", prompt: "Ship it?" },
        errorRecord: {},
      }),
      record(14, {
        type: "complete",
        runId: "run-msg",
        scope: "run-msg",
        summary: { workflowName: "flow", agentCount: 1 },
      }),
    ],
    state,
  );

  assert.deepEqual(sent, [
    { role: "user", content: [{ type: "text", text: '[workflow run run-msg] Phase started: "Scan".' }] },
    { role: "user", content: [{ type: "text", text: "[workflow run run-msg] Paused." }] },
    {
      role: "user",
      content: [{ type: "text", text: "[workflow run run-msg] Paused: usage limit reached — resets at 5pm." }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '[workflow run run-msg] Paused: authentication required for backend "claude". Log in on this machine, then resume.',
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "[workflow run run-msg] Paused: awaiting a confirm decision — Ship it?.",
        },
      ],
    },
    { role: "user", content: [{ type: "text", text: "[workflow run run-msg] Run completed." }] },
  ]);
});

test("terminal error and stopped messages use exact errorRecord text", () => {
  const sent: SentMessage[] = [];
  const app = messageApp(sent);
  const state = createModelMessageState();
  sendModelMessagesForFold(app, "run-msg", 0, [], state);
  sendModelMessagesForFold(
    app,
    "run-msg",
    0,
    [
      record(1, {
        type: "error",
        runId: "run-msg",
        scope: "run-msg",
        errorRecord: { message: "backend exploded" },
      }),
      record(2, { type: "stopped", runId: "run-msg", scope: "run-msg" }),
    ],
    state,
  );
  assert.deepEqual(sent, [
    {
      role: "user",
      content: [{ type: "text", text: "[workflow run run-msg] Run failed: backend exploded." }],
    },
    { role: "user", content: [{ type: "text", text: "[workflow run run-msg] Run stopped." }] },
  ]);
});

test("sequence high-water dedupes across stream rebuilds for the panel lifetime", () => {
  const sent: SentMessage[] = [];
  const app = messageApp(sent);
  const state = createModelMessageState();
  sendModelMessagesForFold(
    app,
    "run-msg",
    0,
    [record(5, { type: "log", runId: "run-msg", scope: "run-msg", message: "bootstrap" })],
    state,
  );
  sendModelMessagesForFold(
    app,
    "run-msg",
    5,
    [record(6, { type: "phase", title: "Verify", runId: "run-msg", scope: "run-msg" })],
    state,
  );

  const rebuiltStream = "b".repeat(32);
  sendModelMessagesForFold(
    app,
    "run-msg",
    0,
    [
      record(5, { type: "phase", title: "Old", runId: "run-msg", scope: "run-msg" }, rebuiltStream),
      record(6, { type: "phase", title: "Verify", runId: "run-msg", scope: "run-msg" }, rebuiltStream),
      record(7, { type: "phase", title: "Report", runId: "run-msg", scope: "run-msg" }, rebuiltStream),
    ],
    state,
  );
  assert.deepEqual(sent, [
    { role: "user", content: [{ type: "text", text: '[workflow run run-msg] Phase started: "Verify".' }] },
    { role: "user", content: [{ type: "text", text: '[workflow run run-msg] Phase started: "Report".' }] },
  ]);
});

test("sendMessage isError is logged once, never retried, and does not stop later folds", async () => {
  const sent: SentMessage[] = [];
  let attempts = 0;
  const app = messageApp(sent, async () => {
    attempts += 1;
    return attempts === 1 ? { isError: true } : {};
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const state = createModelMessageState();
    sendModelMessagesForFold(app, "run-msg", 0, [], state);
    sendModelMessagesForFold(
      app,
      "run-msg",
      0,
      [record(1, { type: "phase", title: "Scan", runId: "run-msg", scope: "run-msg" })],
      state,
    );
    sendModelMessagesForFold(
      app,
      "run-msg",
      1,
      [record(2, { type: "complete", runId: "run-msg", scope: "run-msg", summary: {} })],
      state,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }

  assert.equal(attempts, 2, "each selected event gets one attempt and no retry");
  assert.equal(sent.length, 2, "the rejected phase message does not break the next fold");
  assert.equal(errors.length, 1);
});
