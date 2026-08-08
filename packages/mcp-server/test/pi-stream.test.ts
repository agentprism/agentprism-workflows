// Server-side pi (pi-mcp-adapter) push channel (src/pi-stream.ts): the stream-token read, the
// self-contained result-patch frame builder, and the PiStreamSession emitter that pages the event
// log into cursor-bearing windows — an initial baseline, live patches with periodic checkpoints, and
// a single terminal "final" frame after which it stops. Closed with an end-to-end test: a workflow
// tools/call stamped with a pi stream-token drives real result-patch notifications to the client.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import {
  buildResultPatchParams,
  PI_SERVER_RESULT_PATCH_METHOD,
  PI_STREAM_STRUCTURED_CONTENT_KEY,
  PI_STREAM_REQUEST_META_KEY,
  PiStreamManager,
  PiStreamSession,
  readPiStreamToken,
  type PiResultPatchParams,
} from "../src/pi-stream.js";
import type { WorkflowRunEventsResourceDocument } from "../src/workflow-resources.js";
import { ONE_AGENT_SCRIPT, connect, okRunner, structured } from "./_harness.js";

function rec(seq: number, event: Record<string, unknown>): RunEventLogRecord {
  return {
    seq,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    event,
  } as unknown as RunEventLogRecord;
}

/** An in-memory dense event log (seq 1..N) that plays the readEventsPage + watch seams. */
class FakeLog {
  records: RunEventLogRecord[] = [];
  status: WorkflowRunEventsResourceDocument["status"] = "running";
  finalized = false;
  private listeners: Array<() => void> = [];

  append(record: RunEventLogRecord): void {
    this.records.push(record);
  }
  finish(records: RunEventLogRecord[]): void {
    for (const record of records) this.append(record);
    this.status = "completed";
    this.finalized = true;
  }
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
  readEventsPage(request: { after?: number; limit?: number }): WorkflowRunEventsResourceDocument {
    const after = request.after ?? 0;
    const events = this.records.filter((r) => r.seq > after).slice(0, request.limit ?? 500);
    const endCursor = this.records.length;
    const cursor = events.at(-1)?.seq ?? after;
    return {
      schemaVersion: 1,
      runId: "run-1",
      streamId: "0123456789abcdef0123456789abcdef",
      workflowName: "wf",
      status: this.status,
      finalized: this.finalized,
      after,
      cursor,
      endCursor,
      hasMore: cursor < endCursor,
      events,
    };
  }
  watch(_after: number, _streamId: string, onRecord: () => void): () => void {
    this.listeners.push(onRecord);
    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== onRecord);
    };
  }
}

function assertSelfContained(params: PiResultPatchParams): void {
  const sc = params.result.structuredContent;
  assert.equal(typeof sc.after, "number");
  assert.equal(typeof sc.cursor, "number");
  assert.equal(typeof sc.endCursor, "number");
  assert.ok(Array.isArray(sc.events));
  // Every carried record's seq lies within the window (after, cursor]: the frame stands alone.
  for (const record of sc.events) {
    const seq = (record as { seq: number }).seq;
    assert.ok(seq > sc.after && seq <= sc.cursor, `record seq ${seq} outside (${sc.after}, ${sc.cursor}]`);
  }
  assert.ok(sc[PI_STREAM_STRUCTURED_CONTENT_KEY], "frame carries the pi visualization-stream envelope");
}

test("readPiStreamToken reads a non-empty string token and ignores everything else", () => {
  assert.equal(readPiStreamToken({ _meta: { [PI_STREAM_REQUEST_META_KEY]: "tok-1" } }), "tok-1");
  assert.equal(readPiStreamToken({ _meta: { [PI_STREAM_REQUEST_META_KEY]: "" } }), undefined);
  assert.equal(readPiStreamToken({ _meta: { [PI_STREAM_REQUEST_META_KEY]: 7 } }), undefined);
  assert.equal(readPiStreamToken({ _meta: {} }), undefined);
  assert.equal(readPiStreamToken({}), undefined);
});

test("buildResultPatchParams carries the whole self-contained window + an explicit non-final envelope", () => {
  const doc = new FakeLog();
  doc.append(rec(1, { type: "phase", title: "A" }));
  const page = doc.readEventsPage({ after: 0 });
  const params = buildResultPatchParams("tok-1", page, "checkpoint");
  assert.equal(params.streamToken, "tok-1");
  assertSelfContained(params);
  const envelope = params.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY];
  // Non-terminal frames MUST carry an explicit frameType — else pi defaults each frame to "final"
  // and treats it as the stream's terminal frame.
  assert.equal(envelope.frameType, "checkpoint");
  assert.equal(envelope.phase, "detail");
  assert.equal(envelope.status, "ok");
});

test("a failed run's frame carries an error envelope status", () => {
  const doc = new FakeLog();
  doc.status = "failed";
  const params = buildResultPatchParams("tok", doc.readEventsPage({ after: 0 }), "final");
  assert.equal(params.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].status, "error");
  assert.equal(params.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType, "final");
});

test("PiStreamSession: baseline checkpoint, live patches, and a single terminal final frame that stops the stream", () => {
  const log = new FakeLog();
  log.append(rec(1, { type: "phase", title: "A" }));
  log.append(rec(2, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-1" }));

  const frames: PiResultPatchParams[] = [];
  const session = new PiStreamSession({
    runId: "run-1",
    streamToken: "tok-1",
    readEventsPage: (request) => log.readEventsPage(request),
    watch: (after, streamId, onRecord) => log.watch(after, streamId, onRecord),
    send: (params) => frames.push(params),
  });
  session.start();

  // Bootstrap: one self-contained checkpoint baseline covering the existing log.
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType, "checkpoint");
  assert.deepEqual(
    frames[0]!.result.structuredContent.events.map((r) => (r as { seq: number }).seq),
    [1, 2],
  );
  frames.forEach(assertSelfContained);

  // A live append: one incremental patch window (records strictly after the last cursor).
  log.append(rec(3, { type: "agentProgress", callIndex: 0, label: "finder", latestText: "reading" }));
  log.notify();
  assert.equal(frames.length, 2);
  assert.equal(frames[1]!.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType, "patch");
  assert.deepEqual(frames[1]!.result.structuredContent.events.map((r) => (r as { seq: number }).seq), [3]);

  // Termination: a single "final" frame, then the stream stops — later notifies emit nothing.
  log.finish([rec(4, { type: "complete", summary: { workflowName: "wf", agentCount: 1 } })]);
  log.notify();
  assert.equal(frames.length, 3);
  const finalFrame = frames[2]!;
  assert.equal(finalFrame.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType, "final");
  assert.equal(finalFrame.result.structuredContent.finalized, true);
  frames.forEach(assertSelfContained);

  log.notify();
  assert.equal(frames.length, 3, "no frames after the terminal frame");
});

test("PiStreamSession emits a checkpoint resync baseline on the configured cadence", () => {
  const log = new FakeLog(); // start empty: bootstrap sends an (empty) checkpoint baseline
  const frames: PiResultPatchParams[] = [];
  const session = new PiStreamSession({
    runId: "run-1",
    streamToken: "tok",
    readEventsPage: (request) => log.readEventsPage(request),
    watch: (after, streamId, onRecord) => log.watch(after, streamId, onRecord),
    send: (params) => frames.push(params),
    checkpointEvery: 2,
  });
  session.start();

  log.append(rec(1, { type: "phase", title: "A" }));
  log.notify(); // patch #1
  log.append(rec(2, { type: "phase", title: "B" }));
  log.notify(); // patch #2 -> checkpoint on the cadence

  const types = frames.map((f) => f.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType);
  assert.deepEqual(types, ["checkpoint", "patch", "checkpoint"]);
});

test("PiStreamSession disposes its event-feed watcher and stops streaming", () => {
  const log = new FakeLog();
  let watcherClosed = false;
  const frames: PiResultPatchParams[] = [];
  const session = new PiStreamSession({
    runId: "run-1",
    streamToken: "tok",
    readEventsPage: (request) => log.readEventsPage(request),
    watch: (after, streamId, onRecord) => {
      const off = log.watch(after, streamId, onRecord);
      return () => {
        watcherClosed = true;
        off();
      };
    },
    send: (params) => frames.push(params),
  });
  session.start();
  const before = frames.length;
  session.dispose();
  assert.equal(watcherClosed, true);
  log.append(rec(1, { type: "phase", title: "A" }));
  log.notify();
  assert.equal(frames.length, before, "disposed session emits nothing further");
});

test("PiStreamManager supersedes the prior session for a run and disposes everything on close", () => {
  const manager = new PiStreamManager();
  const closedTokens: string[] = [];
  const deps = (runId: string, streamToken: string) => {
    const log = new FakeLog(); // a live (non-terminal) log so the session stays open
    return {
      runId,
      streamToken,
      readEventsPage: (request: { after?: number; limit?: number }) => log.readEventsPage(request),
      watch: (after: number, streamId: string, onRecord: () => void) => log.watch(after, streamId, onRecord),
      send: () => {},
      onClosed: () => closedTokens.push(streamToken),
    };
  };

  manager.begin(deps("run-1", "tok-a"));
  // A newer token for the SAME run supersedes tok-a: the old session is disposed exactly once.
  manager.begin(deps("run-1", "tok-b"));
  assert.deepEqual(closedTokens, ["tok-a"], "the superseded prior session for the run is disposed");

  // A live session for a DIFFERENT run coexists (not superseded by run-1's activity).
  manager.begin(deps("run-2", "tok-c"));
  assert.deepEqual(closedTokens, ["tok-a"]);

  // disposeAll tears down every remaining session exactly once.
  manager.disposeAll();
  assert.deepEqual(closedTokens.slice().sort(), ["tok-a", "tok-b", "tok-c"]);

  // begin() after close is a no-op — no new session, no further closes.
  manager.begin(deps("run-3", "tok-after-close"));
  assert.deepEqual(closedTokens.slice().sort(), ["tok-a", "tok-b", "tok-c"]);
});

test("end-to-end: a workflow tools/call stamped with a pi stream-token drives real result-patch notifications", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  const frames: PiResultPatchParams[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === PI_SERVER_RESULT_PATCH_METHOD) {
      frames.push(notification.params as unknown as PiResultPatchParams);
    }
  };
  try {
    const accepted = await client.callTool({
      name: "workflow",
      arguments: { script: ONE_AGENT_SCRIPT, background: true },
      _meta: { [PI_STREAM_REQUEST_META_KEY]: "tok-e2e" },
    });
    assert.equal(accepted.isError ?? false, false);
    const runId = structured(accepted)?.runId as string;

    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 10_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");

    // Give the detached push session time to observe termination and emit the final frame.
    for (let i = 0; i < 400 && !frames.some((f) => f.result.structuredContent.finalized); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(frames.length > 0, "at least one result-patch frame arrived");
    for (const frame of frames) {
      assert.equal(frame.streamToken, "tok-e2e");
      assertSelfContained(frame);
    }
    // A complete stream: a baseline checkpoint and a terminal final frame carrying the terminal state.
    const types = frames.map((f) => f.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType);
    assert.ok(types.includes("checkpoint"), `saw ${types.join(",")}`);
    const finalFrame = frames.find((f) => f.result.structuredContent.finalized);
    assert.ok(finalFrame, "a terminal frame arrived");
    assert.equal(finalFrame!.result.structuredContent[PI_STREAM_STRUCTURED_CONTENT_KEY].frameType, "final");
    const seenTypes = new Set(
      frames.flatMap((f) => f.result.structuredContent.events.map((r) => (r as { event: { type: string } }).event.type)),
    );
    assert.ok(seenTypes.has("agentStart") && seenTypes.has("complete"), `saw event types ${[...seenTypes].join(",")}`);
  } finally {
    await dispose();
  }
});
