// The `workflows` option: openWorkflowDir views feeding runDynamicWorkflow (top-level
// names + nested workflow("<name>") resolution) and validateWorkflowScript. Stub runner
// throughout — no live ACP backend.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable HOME before any WorkflowManager is constructed (see sdk.test.ts).
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-dir-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

import { openWorkflowDir, runDynamicWorkflow } from "../src/index.js";
import { validateWorkflowScript } from "../src/validate.js";
import { setValidateProbeFactoryForTests } from "../src/validate-internal.js";
import type { AgentRunner } from "../src/index.js";

setValidateProbeFactoryForTests(() => ({
  async probeConfigOptions(spec) {
    return { backendId: spec ?? "claude", options: [] };
  },
  async dispose() {},
}));

const FLOWS_DIR = mkdtempSync(join(tmpdir(), "automatalabs-workflows-dir-test-flows-"));
process.on("exit", () => {
  try {
    rmSync(FLOWS_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

writeFileSync(
  join(FLOWS_DIR, "child.workflow.js"),
  ['export const meta = { name: "child", description: "d" };', 'return "child:" + (await agent("c", { label: "c" }));'].join("\n"),
);
writeFileSync(
  join(FLOWS_DIR, "parent.workflow.js"),
  ['export const meta = { name: "parent", description: "d" };', 'return await workflow("child", {});'].join("\n"),
);

const echoRunner: AgentRunner = {
  async run() {
    return "ok" as never;
  },
};

test("runDynamicWorkflow accepts a NAME when `workflows` is set, and nested workflow('<name>') resolves", async () => {
  const run = await runDynamicWorkflow("parent", { workflows: FLOWS_DIR, runner: echoRunner });
  assert.equal(run.status, "completed");
  assert.equal(run.result, "child:ok"); // parent → saved child → stub agent
});

test("a pre-opened WorkflowDir view works the same as dir paths", async () => {
  const run = await runDynamicWorkflow("child", { workflows: openWorkflowDir(FLOWS_DIR), runner: echoRunner });
  assert.equal(run.result, "child:ok");
});

test("an unresolvable name throws the view's diagnosable error, not an engine parse error", async () => {
  await assert.rejects(runDynamicWorkflow("chld", { workflows: FLOWS_DIR, runner: echoRunner }), (error: Error) => {
    assert.match(error.message, /workflow "chld" not found/);
    assert.match(error.message, /Did you mean: child/);
    return true;
  });
});

test("a full script string still runs verbatim when `workflows` is set", async () => {
  const run = await runDynamicWorkflow(
    'export const meta = { name: "inline", description: "d" };\nreturn await agent("x", { label: "x" });',
    { workflows: FLOWS_DIR, runner: echoRunner },
  );
  assert.equal(run.result, "ok");
});

test("validateWorkflowScript: nested workflow('<name>') dry-runs when `workflows` is set, fails without", async () => {
  const parent = ['export const meta = { name: "p", description: "d" };', 'return await workflow("child", {});'].join("\n");

  const without = await validateWorkflowScript(parent);
  assert.equal(without.ok, false);
  assert.equal(without.exitCode, 2); // the bare name fails the nested parse — the documented gap
  assert.match(without.warnings.join("\n"), /--workflows-dir/); // …but the report says how to fix it

  const withDir = await validateWorkflowScript(parent, { workflows: FLOWS_DIR });
  assert.equal(withDir.ok, true);
  // The child ran nested against the validator's mock runner.
  assert.match(String(withDir.dryRun?.result), /^child:\[dry-run\] mock output/);
});
