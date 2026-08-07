// The panel's ui/update-model-context projection must push only on transitions the agent
// would act on: transcript/progress churn keeps the signature stable, while phase changes,
// agent settlement, failures, pauses, and terminal states change it (and pauses/terminals
// are urgent). The text push is a complete snapshot because updates overwrite each other.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunEventLogRecord } from "@automatalabs/shared-types";

import {
  buildModelContextSnapshot,
  formatModelContextText,
  hasFoldedEvents,
  isUrgentStatus,
  MODEL_CONTEXT_MIN_INTERVAL_MS,
  modelContextSignature,
  nextPushDelayMs,
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

test("only agent settlement, phase starts, and terminal/paused run state push", () => {
  const model = createRunModel("run-1");
  model.status = "running";
  fold(model, { type: "phase", title: "Scan" });
  fold(model, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-1" });
  const before = modelContextSignature(model);

  // None of this is a milestone: progress rows, transcript tokens, narrator logs, and
  // additional agent STARTS are all live-view detail.
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
  fold(model, { type: "agentStart", callIndex: 1, label: "checker", scope: "run-1" });
  assert.equal(modelContextSignature(model), before);
  assert.equal(isUrgentStatus(model), false);

  // A new phase IS a milestone — it is the workflow's own structural checkpoint.
  fold(model, { type: "phase", title: "Verify" });
  const verifying = modelContextSignature(model);
  assert.notEqual(verifying, before);

  // A re-announced identical title is the SAME phase: the reducer collapses it, so no push.
  fold(model, { type: "phase", title: "Verify" });
  assert.equal(modelContextSignature(model), verifying);

  // An agent going terminal IS a milestone — once per settled agent, success or failure.
  fold(model, { type: "agentEnd", callIndex: 0, tokens: 1200 });
  const oneSettled = modelContextSignature(model);
  assert.notEqual(oneSettled, verifying);

  fold(model, { type: "agentEnd", callIndex: 1, error: "boom" });
  assert.notEqual(modelContextSignature(model), oneSettled);
});

test("workflow completion is a milestone; token and cost churn is not", () => {
  const model = createRunModel("run-2");
  model.status = "running";
  fold(model, { type: "agentStart", callIndex: 0, label: "finder", scope: "run-2" });
  fold(model, { type: "agentEnd", callIndex: 0, tokens: 10 });
  const running = modelContextSignature(model);

  fold(model, { type: "paused", reason: "usage_limit", resetHint: "resets 5pm" });
  const paused = modelContextSignature(model);
  assert.notEqual(paused, running);

  fold(model, { type: "resumed" });
  assert.equal(modelContextSignature(model), running);

  fold(model, {
    type: "complete",
    summary: { workflowName: "wf", agentCount: 1, tokenUsage: { total: 999, cost: 0.5 } },
  });
  assert.notEqual(modelContextSignature(model), running);
});

test("failures are counted and summarized to the first failure", () => {
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
  // Frontmatter carries the parseable fields, per the ext-apps context pattern.
  assert.match(text, /^---\n/);
  assert.match(text, /\nrun-id: run-3\n/);
  assert.match(text, /\nstatus: running\n/);
  assert.match(text, /\nagents-failed: 5\n/);
  assert.match(text, /\n---\n/);
  assert.match(text, /5 failed/);
  // Failure detail is summarized to one entry, not enumerated as a log feed.
  assert.match(text, /First failure — agent "verify:0": boom 0/);
  assert.match(text, /…/); // long error text is truncated
  assert.match(text, /\(\+4 more failed\)/);
  assert.doesNotMatch(text, /verify:1/);
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
  assert.match(text, /\nstatus: completed\n/);
  assert.match(text, /This status is final/);
  const snapshot = buildModelContextSnapshot(model);
  assert.equal(snapshot.finalized, true);
  assert.equal(snapshot.totalTokens, 999);
});

test("a phase push carries the phase title and its ordinal", () => {
  const model = createRunModel("run-6");
  model.status = "running";
  fold(model, { type: "phase", title: "Scan" });
  fold(model, { type: "phase", title: "Verify: deep" });

  const text = formatModelContextText(model);
  // Frontmatter carries the title (quoted, since the colon would break YAML) and the ordinal.
  assert.match(text, /^current-phase: "Verify: deep"$/m);
  assert.match(text, /^phase-number: 2$/m);
  // The prose names it too, so a model reading only the sentence still learns the phase.
  assert.match(text, /phase 2 "Verify: deep"/);

  assert.equal(buildModelContextSnapshot(model).currentPhase, "Verify: deep");
  assert.equal(buildModelContextSnapshot(model).phasesSeen, 2);
});

test("live pushes tell the agent not to poll inspect", () => {
  const model = createRunModel("run-5");
  model.status = "running";
  fold(model, { type: "agentStart", callIndex: 0, label: "a", scope: "run-5" });
  assert.match(formatModelContextText(model), /do not call workflow action:"inspect"/);
});

test("routine pushes are throttled on the trailing edge; urgent ones are not", () => {
  const now = 1_700_000_000_000;
  // Urgent (paused/terminal) always goes out on this tick, however recent the last push.
  assert.equal(nextPushDelayMs(true, now, now), 0);
  assert.equal(nextPushDelayMs(true, now - 1, now), 0);

  // Routine waits out only the REMAINDER of the interval, so a burst collapses into one push.
  assert.equal(nextPushDelayMs(false, now, now), MODEL_CONTEXT_MIN_INTERVAL_MS);
  assert.equal(nextPushDelayMs(false, now - 500, now), MODEL_CONTEXT_MIN_INTERVAL_MS - 500);
  assert.equal(nextPushDelayMs(false, now - MODEL_CONTEXT_MIN_INTERVAL_MS, now), 0);
  assert.equal(nextPushDelayMs(false, now - 10 * MODEL_CONTEXT_MIN_INTERVAL_MS, now), 0);

  // First push of a panel's life (no prior push recorded) is not delayed.
  assert.equal(nextPushDelayMs(false, 0, now), 0);
  // A clock that jumped backwards cannot stretch the wait past one interval.
  assert.equal(nextPushDelayMs(false, now + 60_000, now), MODEL_CONTEXT_MIN_INTERVAL_MS);
});

test("no model-context push until the first events page has folded", () => {
  // A freshly seeded model (the effect bumps a render before any page lands) must be held back:
  // the name is unknown and would fall back to "workflow", with agents-settled reading 0/0.
  const seed = createRunModel("run-hold");
  assert.equal(hasFoldedEvents(seed), false);

  // Learning the workflow name from any page releases the hold...
  const named = createRunModel("run-hold");
  named.name = "review-changes";
  assert.equal(hasFoldedEvents(named), true);

  // ...as does the cursor advancing past the seed, even before a name is known.
  const advanced = createRunModel("run-hold");
  advanced.cursor = 4;
  assert.equal(hasFoldedEvents(advanced), true);
});

// The signature joins fields with NUL so no phase title or banner can forge a boundary.
// Write it as an ESCAPE (\u0000) — a literal NUL byte makes git classify the source as
// binary, which silently drops the file from every diff and review.
test("panel sources are text: control bytes only ever appear as escapes", () => {
  const uiSrc = fileURLToPath(new URL("../ui/src/", import.meta.url));
  const sources = readdirSync(uiSrc).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));
  assert.ok(sources.includes("model-context.ts"));
  for (const name of sources) {
    const bytes = readFileSync(join(uiSrc, name));
    const offending = bytes.findIndex((byte) => byte < 9 || (byte > 13 && byte < 32));
    assert.equal(offending, -1, `${name} holds a raw control byte at offset ${offending}`);
  }
});
