import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inlineSkeletonFromArgs,
  observedRunIdFromArgs,
  skeletonSourceRunIdFromArgs,
} from "../ui/src/tool-input.js";

const SCRIPT = `export const meta = { name: 'input-shape', description: 'x' }
return await gate(
  () => agent('produce', { label: 'producer' }),
  (value) => agent(\`review \${value}\`, { label: 'reviewer' }),
)`;

test("inline run input exposes its static skeleton before a result runId exists", () => {
  const skeleton = inlineSkeletonFromArgs({ action: "run", script: SCRIPT, background: false });
  assert.equal(skeleton?.name, "input-shape");
  const gate = skeleton?.roots[0];
  assert.equal(gate?.kind, "loop");
  if (gate?.kind === "loop") assert.equal(gate.mode, "gate");

  // The migration-compatible omitted action is still a run form.
  assert.equal(inlineSkeletonFromArgs({ script: SCRIPT })?.name, "input-shape");
  assert.equal(inlineSkeletonFromArgs({ action: "run", scriptPath: "/tmp/x.js" }), undefined);
  assert.equal(inlineSkeletonFromArgs({ action: "status", script: SCRIPT }), undefined);
});

test("only existing-run actions take runId from tool input", () => {
  assert.equal(observedRunIdFromArgs({ action: "status", runId: "run-1" }), "run-1");
  assert.equal(observedRunIdFromArgs({ action: "result", runId: "run-1" }), "run-1");
  assert.equal(observedRunIdFromArgs({ action: "stop", runId: "run-1" }), "run-1");
  assert.equal(observedRunIdFromArgs({ action: "permissions-response", runId: "run-1" }), "run-1");
  assert.equal(observedRunIdFromArgs({ action: "run", runId: "source-1" }), undefined);
  assert.equal(observedRunIdFromArgs({ action: "resume", runId: "source-1" }), undefined);
  assert.equal(observedRunIdFromArgs({ action: "config", runId: "run-1" }), undefined);
});

test("resume input can seed a skeleton resource without monitoring the source run", () => {
  assert.equal(skeletonSourceRunIdFromArgs({ action: "resume", runId: "source-1" }), "source-1");
  assert.equal(skeletonSourceRunIdFromArgs({ action: "status", runId: "run-1" }), undefined);
  assert.equal(skeletonSourceRunIdFromArgs({ action: "run", resumeFromRunId: "source-1" }), undefined);
});
