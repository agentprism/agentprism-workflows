// The panel's ui/update-model-context projection must push only on transitions the agent
// would act on: transcript/progress churn keeps the signature stable, while phase changes,
// agent settlement, failures, pauses, and terminal states change it (and pauses/terminals
// are urgent). The text push is a complete snapshot because updates overwrite each other.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import {
  buildModelContextSnapshot,
  formatModelContextText,
  isUrgentStatus,
  modelContextSignature,
} from "../ui/src/model-context.js";
import { createRunModel, foldRecord } from "../ui/src/state.js";

let seq = 0;
function fold(model: ReturnType<typeof createRunModel>, event: Record<string, unknown>): void {
  seq += 1;
  foldRecord(model, {
    seq,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    event,
  } as unknown as RunEventLogRecord);
}

test("transcript and progress churn does not change the push signature", () => {
  const model = createRunModel("run-1");
  model.status = "running";
  fold(model, { type: "phase", title: "Scan" });
  fold(model, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-1" });
  const before = modelContextSignature(model);

  fold(model, {
    type: "agentProgress",
    callIndex: 0,
    label: "finder",
    latestText: "reading files",
  });
  fold(model, {
    type: "agentTranscript",
    callIndex: 0,
    executionStartSeq: 2,
    entryIndex: 0,
    revision: 1,
    entry: { kind: "text", text: "hello" },
  });
  fold(model, { type: "log", message: "narrator line" });

  assert.equal(modelContextSignature(model), before);
  assert.equal(isUrgentStatus(model), false);
});

test("phase transitions and agent settlement change the signature", () => {
  const model = createRunModel("run-2");
  model.status = "running";
  fold(model, { type: "phase", title: "Scan" });
  fold(model, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-2" });
  const scanning = modelContextSignature(model);

  fold(model, { type: "agentEnd", callIndex: 0, tokens: 1200 });
  const settled = modelContextSignature(model);
  assert.notEqual(settled, scanning);

  fold(model, { type: "phase", title: "Verify" });
  assert.notEqual(modelContextSignature(model), settled);
});

test("failures are counted, listed with a snippet, and capped", () => {
  const model = createRunModel("run-3");
  model.status = "running";
  model.name = "review-changes";
  for (let index = 0; index < 5; index += 1) {
    fold(model, { type: "agentStart", callIndex: index, label: `verify:${index}`, scope: "run-3" });
    fold(model, {
      type: "agentEnd",
      callIndex: index,
      error: `boom ${index} ${"x".repeat(200)}`,
    });
  }
  const snapshot = buildModelContextSnapshot(model);
  assert.equal(snapshot.agentsStarted, 5);
  assert.equal(snapshot.agentsSettled, 5);
  assert.equal(snapshot.agentsFailed, 5);

  const text = formatModelContextText(model);
  assert.match(text, /review-changes/);
  assert.match(text, /5 failed/);
  assert.match(text, /Failed agent "verify:0": boom 0/);
  assert.match(text, /…/); // long error text is truncated
  assert.match(text, /\(\+2 more failed agents\)/); // only 3 listed
});

test("paused and terminal states are urgent and produce final wording", () => {
  const model = createRunModel("run-4");
  model.status = "running";
  fold(model, { type: "paused", reason: "usage_limit", resetHint: "resets 5pm" });
  assert.equal(isUrgentStatus(model), true);
  assert.match(formatModelContextText(model), /PAUSED/);
  assert.match(formatModelContextText(model), /usage limit/);

  fold(model, { type: "resumed" });
  assert.equal(isUrgentStatus(model), false);

  fold(model, {
    type: "complete",
    summary: { workflowName: "wf", agentCount: 2, tokenUsage: { total: 999, cost: 0.5 } },
  });
  assert.equal(isUrgentStatus(model), true);
  const text = formatModelContextText(model);
  assert.match(text, /is completed/);
  assert.match(text, /This status is final/);
  const snapshot = buildModelContextSnapshot(model);
  assert.equal(snapshot.finalized, true);
  assert.equal(snapshot.totalTokens, 999);
});

test("live pushes tell the agent not to poll inspect", () => {
  const model = createRunModel("run-5");
  model.status = "running";
  fold(model, { type: "agentStart", callIndex: 0, label: "a", scope: "run-5" });
  assert.match(formatModelContextText(model), /do not call workflow action:"inspect"/);
});
