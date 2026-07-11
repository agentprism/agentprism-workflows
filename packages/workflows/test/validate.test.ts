// validateWorkflowScript: the token-free parse + mock-runner dry run behind
// `agentprism-workflows validate`. No live ACP backend is involved anywhere here —
// the whole point of the surface under test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disposable HOME before any WorkflowManager is constructed (see sdk.test.ts): validate's
// manager uses its own throwaway persistenceRoot, but agentType registries scan ~/.
const TEST_HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-validate-test-home-"));
process.env.HOME = TEST_HOME;
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

import { fabricateFromSchema, validateWorkflowScript, MOCK_TOKENS_PER_AGENT } from "../src/validate.js";

test("valid script: parse + dry run complete; calls, backends, checkpoints, phases reported", async () => {
  const script = [
    'export const meta = { name: "v", description: "d", phases: [{ title: "Fan" }, { title: "Judge" }] };',
    "const S = { type: 'object', additionalProperties: false, required: ['ok', 'notes'],",
    "  properties: { ok: { type: 'boolean' }, notes: { type: 'string' } } };",
    'phase("Fan");',
    "const pair = await parallel([",
    '  () => agent("a", { label: "claude-side", model: "opus", schema: S }),',
    '  () => agent("b", { label: "codex-side", model: "gpt-5.6-luna[high]" }),',
    "]);",
    'phase("Judge");',
    'const go = await checkpoint("proceed?", { kind: "confirm", default: false });',
    "return { pair, go };",
  ].join("\n");

  const report = await validateWorkflowScript(script);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.parse.ok, true);
  assert.equal(report.dryRun?.status, "completed");

  const byLabel = new Map(report.dryRun!.agentCalls.map((c) => [c.label, c]));
  assert.equal(byLabel.size, 2);
  assert.equal(byLabel.get("claude-side")?.backend, "claude");
  assert.equal(byLabel.get("claude-side")?.schema, true);
  assert.equal(byLabel.get("codex-side")?.backend, "codex");
  assert.equal(byLabel.get("codex-side")?.schema, false);

  // The checkpoint took its declared headless default (false), and the fabricated
  // structured result flowed into the script's return value.
  assert.deepEqual(report.dryRun!.checkpoints, [{ prompt: "proceed?", kind: "confirm", reply: false }]);
  const result = report.dryRun!.result as { pair: [{ ok: boolean; notes: string }, string]; go: boolean };
  assert.equal(result.go, false);
  assert.equal(result.pair[0].ok, true);
  assert.equal(typeof result.pair[0].notes, "string");
  assert.match(result.pair[1], /dry-run/);
  assert.deepEqual(report.dryRun!.phasesVisited, ["Fan", "Judge"]);
  assert.equal(report.warnings.length, 0);
});

test("determinism violation fails the static parse (exit 1), no dry run", async () => {
  const report = await validateWorkflowScript(
    'export const meta = { name: "v", description: "d" };\nreturn Date.now();',
  );
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.match(report.parse.error ?? "", /deterministic/i);
  assert.equal(report.dryRun, undefined);
});

test("missing meta fails the static parse", async () => {
  const report = await validateWorkflowScript('return await agent("x");');
  assert.equal(report.exitCode, 1);
  assert.equal(report.parse.ok, false);
});

test("runtime script bugs surface as dry-run failures (exit 2) with the engine's message", async () => {
  // The classic authoring mistake: promises instead of thunks.
  const report = await validateWorkflowScript(
    ['export const meta = { name: "v", description: "d" };', 'return await parallel([agent("a")]);'].join("\n"),
  );
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.dryRun?.status, "failed");
  assert.match(report.dryRun?.reason ?? "", /array of functions/);
});

test("parse-only skips the dry run", async () => {
  const report = await validateWorkflowScript(
    'export const meta = { name: "v", description: "d" };\nreturn await agent("x");',
    { dryRun: false },
  );
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, undefined);
});

test("script-declared backends: dry run treats them as approved, attributes calls, and warns", async () => {
  const script = [
    'export const meta = { name: "v", description: "d", backends: { browser: { command: "browser-acp" } } };',
    'return await agent("qa", { label: "qa", model: "browser" });',
  ].join("\n");
  const report = await validateWorkflowScript(script);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun?.agentCalls[0]?.backend, "browser (script-declared)");
  assert.match(report.warnings.join("\n"), /custom backends \(browser\)/);
});

test("token budget: budget-guarded loops execute and terminate against mock usage", async () => {
  const script = [
    'export const meta = { name: "v", description: "d" };',
    "const out = [];",
    `while (budget.total && budget.remaining() >= ${MOCK_TOKENS_PER_AGENT}) {`,
    '  out.push(await agent("more", { label: "loop:" + out.length }));',
    "}",
    "return out.length;",
  ].join("\n");
  const report = await validateWorkflowScript(script, { tokenBudget: 3 * MOCK_TOKENS_PER_AGENT });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun?.result, 3);
});

test("phase mismatches and agent-less scripts produce warnings, not failures", async () => {
  // Note: the engine seeds the FIRST declared phase as active from run start, so only
  // later declared-but-never-entered phases can warn.
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "v", description: "d", phases: [{ title: "First" }, { title: "Second" }] };',
      'phase("Undeclared");',
      "return 1;",
    ].join("\n"),
  );
  assert.equal(report.ok, true);
  const text = report.warnings.join("\n");
  assert.match(text, /"Second" but no phase\("Second"\)/);
  assert.doesNotMatch(text, /"First"/);
  assert.match(text, /phase "Undeclared" is used but meta\.phases/);
  assert.match(text, /without a single agent\(\)/);
});

test("agent({ phase }) assignments count as phase usage (no false declared-but-unused warning)", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "v", description: "d", phases: [{ title: "A" }, { title: "B" }] };',
      'return await agent("x", { label: "x", phase: "B" });',
    ].join("\n"),
  );
  assert.equal(report.ok, true);
  assert.equal(report.warnings.length, 0);
});

test("checkpoint headless:abort is warned about (the dry-run confirm still answers it)", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "v", description: "d" };',
      'const ok = await checkpoint("ship?", { kind: "confirm", headless: "abort" });',
      'return await agent("then", { label: "then" }) && ok;',
    ].join("\n"),
  );
  assert.equal(report.ok, true);
  assert.match(report.warnings.join("\n"), /headless: "abort"/);
});

test("checkpoint headless:pause dry-runs through the mock confirm without a warning", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "v", description: "d" };',
      'const decision = await checkpoint("ship?", { headless: "pause", default: "hold" });',
      'return { decision };',
    ].join("\n"),
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.dryRun?.checkpoints, [{ prompt: "ship?", kind: "confirm", reply: "hold" }]);
  assert.doesNotMatch(report.warnings.join("\n"), /headless: "pause"/);
});

test("fabricateFromSchema covers the portable-schema subset", () => {
  assert.equal(fabricateFromSchema({ type: "string", enum: ["a", "b"] }), "a");
  assert.equal(fabricateFromSchema({ const: 42 }), 42);
  assert.equal(fabricateFromSchema({ type: "boolean" }), true);
  assert.equal(fabricateFromSchema({ type: "number", minimum: 5 }), 5);
  assert.equal(fabricateFromSchema({ anyOf: [{ type: "integer" }, { type: "string" }] }), 1);
  const obj = fabricateFromSchema({
    type: "object",
    required: ["files", "extra"],
    properties: { files: { type: "array", items: { type: "string" }, minItems: 2 } },
  }) as { files: string[]; extra: string };
  assert.equal(obj.files.length, 2);
  assert.match(obj.files[0], /^mock-/);
  assert.equal(typeof obj.extra, "string"); // required-but-undeclared property still present
  // No infinite recursion on self-referential shapes.
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.properties = { self: cyclic };
  assert.ok(fabricateFromSchema(cyclic) !== undefined);
});
