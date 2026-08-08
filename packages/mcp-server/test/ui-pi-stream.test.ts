// Panel-side pi (pi-mcp-adapter) push channel (ui/src/pi-stream.ts): host-context detection, the
// ui-result-patch notification parse, and the cursor-driven fold. The fold must be correct under
// the pi contract's hard cases — windows delivered OUT OF ORDER (pi's SSE replay + reorder) and
// periodic CHECKPOINT baselines that re-send already-folded records — because foldRecord is a
// non-idempotent reducer: every record must fold exactly once, in stream order.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import {
  getPiStreamHostContext,
  parseUiResultPatch,
  PiStreamFold,
  PI_STREAM_HOST_CONTEXT_KEY,
  PI_STREAM_STRUCTURED_CONTENT_KEY,
  PI_UI_RESULT_PATCH_METHOD,
  type PiStreamFrame,
} from "../ui/src/pi-stream.js";
import { createRunModel } from "../ui/src/state.js";
import type { RunStatus } from "../ui/src/state.js";

function rec(seq: number, event: Record<string, unknown>): RunEventLogRecord {
  return {
    seq,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    event,
  } as unknown as RunEventLogRecord;
}

const UI_STREAM = "ui-stream-uuid";
const EVENT_GEN = "0123456789abcdef0123456789abcdef";

interface WindowSpec {
  after: number;
  cursor: number;
  endCursor: number;
  status: RunStatus;
  finalized: boolean;
  events: RunEventLogRecord[];
  workflowName?: string;
}

function frame(
  sequence: number,
  frameType: "patch" | "checkpoint" | "final",
  spec: WindowSpec,
  uiStreamId = UI_STREAM,
): PiStreamFrame {
  return {
    envelope: {
      frameType,
      phase: frameType === "final" ? "settled" : "detail",
      status: spec.status === "failed" || spec.status === "aborted" ? "error" : "ok",
      streamId: uiStreamId,
      sequence,
    },
    window: {
      streamId: EVENT_GEN,
      status: spec.status,
      finalized: spec.finalized,
      after: spec.after,
      cursor: spec.cursor,
      endCursor: spec.endCursor,
      events: spec.events,
      ...(spec.workflowName === undefined ? {} : { workflowName: spec.workflowName }),
    },
  };
}

/** A four-record run: phase A, agentStart 0, agentEnd 0 (done), complete. */
const HEAD = [rec(1, { type: "phase", title: "A" }), rec(2, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-1" })];
const TAIL = [
  rec(3, { type: "agentEnd", callIndex: 0, label: "finder", scope: "run-1", result: { preview: "ok" } }),
  rec(4, { type: "complete", summary: { workflowName: "wf", agentCount: 1 } }),
];

test("getPiStreamHostContext reads a well-formed pi stream descriptor and rejects others", () => {
  assert.deepEqual(
    getPiStreamHostContext({ [PI_STREAM_HOST_CONTEXT_KEY]: { mode: "eager", streamId: UI_STREAM, extra: 1 } }),
    { mode: "eager", streamId: UI_STREAM },
  );
  assert.equal(getPiStreamHostContext(undefined), undefined);
  assert.equal(getPiStreamHostContext({}), undefined);
  assert.equal(getPiStreamHostContext({ [PI_STREAM_HOST_CONTEXT_KEY]: { mode: "eager" } }), undefined);
  assert.equal(getPiStreamHostContext({ [PI_STREAM_HOST_CONTEXT_KEY]: { streamId: "" } }), undefined);
});

test("parseUiResultPatch extracts the envelope + window and rejects foreign/malformed notifications", () => {
  const f = frame(1, "patch", { after: 0, cursor: 2, endCursor: 4, status: "running", finalized: false, events: HEAD });
  const notification = {
    method: PI_UI_RESULT_PATCH_METHOD,
    params: {
      content: [],
      structuredContent: { ...f.window, [PI_STREAM_STRUCTURED_CONTENT_KEY]: f.envelope },
    },
  };
  const parsed = parseUiResultPatch(notification);
  assert.ok(parsed);
  assert.equal(parsed.envelope.streamId, UI_STREAM);
  assert.equal(parsed.envelope.sequence, 1);
  assert.equal(parsed.window.cursor, 2);
  assert.equal(parsed.window.events.length, 2);

  assert.equal(parseUiResultPatch({ method: "notifications/progress", params: {} }), undefined);
  assert.equal(parseUiResultPatch({ method: PI_UI_RESULT_PATCH_METHOD }), undefined);
  assert.equal(
    parseUiResultPatch({ method: PI_UI_RESULT_PATCH_METHOD, params: { structuredContent: {} } }),
    undefined,
  );
});

test("in-order windows fold cumulatively to the terminal state", () => {
  const model = createRunModel("run-1");
  const fold = new PiStreamFold(UI_STREAM);
  assert.equal(
    fold.fold(model, frame(1, "checkpoint", { after: 0, cursor: 2, endCursor: 4, status: "running", finalized: false, workflowName: "wf", events: HEAD })),
    true,
  );
  assert.deepEqual(model.phases, ["A"]);
  assert.equal(model.nodes.size, 1);
  assert.equal(model.cursor, 2);
  assert.equal(model.finalized, false);

  assert.equal(
    fold.fold(model, frame(2, "final", { after: 2, cursor: 4, endCursor: 4, status: "completed", finalized: true, events: TAIL })),
    true,
  );
  assert.equal(model.cursor, 4);
  assert.equal(model.finalized, true);
  assert.equal(model.status, "completed");
  assert.equal(model.nodes.get(0)?.status, "done");
});

test("OUT-OF-ORDER windows: a window ahead of the cursor buffers until its predecessor fills the gap", () => {
  const model = createRunModel("run-1");
  const fold = new PiStreamFold(UI_STREAM);

  // The TAIL frame (after=2) arrives first, while the model cursor is still 0 -> gap -> buffered.
  assert.equal(
    fold.fold(model, frame(2, "final", { after: 2, cursor: 4, endCursor: 4, status: "completed", finalized: true, events: TAIL })),
    false,
    "a gap-ahead window applies nothing yet",
  );
  assert.equal(model.cursor, 0);
  assert.equal(model.finalized, false);

  // The HEAD frame (after=0) lands; it folds, then the buffered TAIL becomes contiguous and drains.
  assert.equal(
    fold.fold(model, frame(1, "patch", { after: 0, cursor: 2, endCursor: 4, status: "running", finalized: false, events: HEAD })),
    true,
  );
  assert.equal(model.cursor, 4);
  assert.equal(model.finalized, true);
  assert.equal(model.status, "completed");
  assert.deepEqual(model.phases, ["A"], "phase folded exactly once despite the reorder");
  assert.equal(model.nodes.get(0)?.status, "done");
});

test("a CHECKPOINT that re-sends already-folded records is idempotent (no duplicate fold)", () => {
  const model = createRunModel("run-1");
  const fold = new PiStreamFold(UI_STREAM);
  fold.fold(model, frame(1, "patch", { after: 0, cursor: 2, endCursor: 4, status: "running", finalized: false, events: HEAD }));
  fold.fold(model, frame(2, "patch", { after: 2, cursor: 4, endCursor: 4, status: "completed", finalized: true, events: TAIL }));
  assert.deepEqual(model.phases, ["A"]);

  // A periodic checkpoint re-sends the whole self-contained window [0,4]; every record is already
  // folded (seq <= cursor), so the phase is not re-pushed and the node count is unchanged.
  fold.fold(model, frame(3, "checkpoint", { after: 0, cursor: 4, endCursor: 4, status: "completed", finalized: true, events: [...HEAD, ...TAIL] }));
  assert.deepEqual(model.phases, ["A"], "checkpoint did not duplicate the phase");
  assert.equal(model.nodes.size, 1);
  assert.equal(model.finalized, true);
});

test("a frame for a different pi UI stream is ignored", () => {
  const model = createRunModel("run-1");
  const fold = new PiStreamFold(UI_STREAM);
  assert.equal(
    fold.fold(model, frame(1, "patch", { after: 0, cursor: 2, endCursor: 4, status: "running", finalized: false, events: HEAD }, "some-other-stream")),
    false,
  );
  assert.equal(model.cursor, 0);
  assert.equal(model.nodes.size, 0);
});

test("run status never regresses when a stale checkpoint arrives after the terminal frame", () => {
  const model = createRunModel("run-1");
  const fold = new PiStreamFold(UI_STREAM);
  // Terminal frame first (endCursor 4).
  fold.fold(model, frame(9, "final", { after: 0, cursor: 4, endCursor: 4, status: "completed", finalized: true, events: [...HEAD, ...TAIL] }));
  assert.equal(model.finalized, true);
  assert.equal(model.status, "completed");

  // A late, stale checkpoint sent BEFORE termination (older endCursor, "running", not finalized).
  fold.fold(model, frame(3, "checkpoint", { after: 0, cursor: 2, endCursor: 2, status: "running", finalized: false, events: HEAD }));
  assert.equal(model.finalized, true, "finalized never regresses");
  assert.equal(model.status, "completed", "status is recency-guarded by endCursor");
});
