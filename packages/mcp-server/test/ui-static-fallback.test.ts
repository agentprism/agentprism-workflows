// Static-fallback render model (state.ts seedStaticRunModel): the panel's honest state on a host
// that serves NEITHER app-originated resource reads NOR the pi push channel. It cannot build a live
// graph there, so it renders only what the tool call itself delivered — the runId always, plus the
// status/name the result carried — and never the reconnect spinner (main.tsx renders
// STATIC_UNSUPPORTED_MESSAGE around this seed). foreground calls return a terminal status; background
// calls return "running".
import assert from "node:assert/strict";
import { test } from "node:test";

import { seedStaticRunModel } from "../ui/src/state.js";

test("a terminal foreground status seeds a finalized model", () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    const model = seedStaticRunModel("run-1", { status, workflowName: "wf" });
    assert.equal(model.runId, "run-1");
    assert.equal(model.status, status);
    assert.equal(model.finalized, true, `${status} is terminal`);
    assert.equal(model.name, "wf");
  }
});

test("a background 'running' status seeds a live (non-finalized) model", () => {
  const model = seedStaticRunModel("run-2", { status: "running", workflowName: "bg" });
  assert.equal(model.status, "running");
  assert.equal(model.finalized, false);
  assert.equal(model.name, "bg");
});

test("a paused status is not finalized", () => {
  const model = seedStaticRunModel("run-3", { status: "paused" });
  assert.equal(model.status, "paused");
  assert.equal(model.finalized, false);
  assert.equal(model.name, undefined);
});

test("no seed yields an empty pending model that still carries the runId", () => {
  const model = seedStaticRunModel("run-4");
  assert.equal(model.runId, "run-4");
  assert.equal(model.status, "pending");
  assert.equal(model.finalized, false);
  assert.equal(model.nodes.size, 0);
  assert.equal(model.cursor, 0);
});
