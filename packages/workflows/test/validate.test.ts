// validateWorkflowScript: the token-free parse + mock-runner dry run behind
// `agentprism-workflows validate`. No live ACP backend is involved anywhere here —
// the whole point of the surface under test.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import {
  fabricateFromSchema,
  formatValidateReport,
  validateWorkflowScript,
  MOCK_TOKENS_PER_AGENT,
} from "../src/validate.js";

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const RESUME_LOOP_CAP_EXAMPLE = readFileSync(
  new URL("../../../skills/agentprism-workflow-authoring/examples/resume-loop-cap.workflow.js", import.meta.url),
  "utf8",
);

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

test("published resume-loop-cap example validates its default and intentional six-round failure", async () => {
  const complete = await validateWorkflowScript(RESUME_LOOP_CAP_EXAMPLE);
  assert.equal(complete.ok, true);
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.dryRun?.status, "completed");
  assert.equal(complete.dryRun?.agentCalls.length, 8);

  const capped = await validateWorkflowScript(RESUME_LOOP_CAP_EXAMPLE, { args: { maxRounds: 6 } });
  assert.equal(capped.exitCode, 2);
  assert.equal(capped.dryRun?.status, "failed");
  assert.equal(capped.dryRun?.agentCalls.length, 6);
  assert.match(capped.dryRun?.reason ?? "", /review cap 6 reached before 8 rounds/);
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

test("dry-run gate result exposes every fabricated structured validator field", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "gate-verdict", description: "structured gate verdict" };',
      "const PRODUCER = { type: 'object', additionalProperties: false, required: ['branch', 'tests'],",
      "  properties: { branch: { type: 'string' }, tests: { type: 'number' } } };",
      "const VERDICT = { type: 'object', additionalProperties: false, required: ['ok', 'commitSha', 'feedback', 'scores'],",
      "  properties: { ok: { type: 'boolean' }, commitSha: { type: 'string' }, feedback: { type: 'string' },",
      "    scores: { type: 'object', additionalProperties: false, required: ['correctness'],",
      "      properties: { correctness: { type: 'number' } } } } };",
      "return await gate(",
      '  () => agent("produce", { label: "gate:producer", schema: PRODUCER }),',
      '  (value) => agent("validate " + value.branch, { label: "gate:validator", schema: VERDICT }),',
      ");",
    ].join("\n"),
  );

  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.dryRun?.status, "completed");
  assert.deepEqual(
    report.dryRun?.agentCalls.map(({ label, schema }) => ({ label, schema })),
    [
      { label: "gate:producer", schema: true },
      { label: "gate:validator", schema: true },
    ],
  );
  const outcome = report.dryRun?.result as {
    ok: boolean;
    value: { branch: string; tests: number };
    verdict: {
      ok: boolean;
      commitSha: string;
      feedback: string;
      scores: { correctness: number };
    };
    attempts: number;
  };
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(typeof outcome.value.branch, "string");
  assert.equal(typeof outcome.value.tests, "number");
  assert.deepEqual(outcome.verdict, {
    ok: true,
    commitSha: "mock-commitSha",
    feedback: "mock-feedback",
    scores: { correctness: 1 },
  });
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

test("mock answers deep-merge a reusable false branch over fresh fabricated fields", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "mock-false", description: "d" };',
      "const S = { type: 'object', additionalProperties: false, required: ['real', 'reason'],",
      "  properties: { real: { type: 'boolean' }, reason: { type: 'string' } } };",
      'const a = await agent("a", { label: "refute:a", schema: S });',
      'const b = await agent("b", { label: "refute:b", schema: S });',
      'return { values: [a, b], branch: a.real || b.real ? "true" : "false" };',
    ].join("\n"),
    { mockAnswers: { "refute:*": { real: false } } },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(plain(report.dryRun?.result), {
    values: [
      { real: false, reason: "mock-reason" },
      { real: false, reason: "mock-reason" },
    ],
    branch: "false",
  });
  assert.deepEqual(report.dryRun?.agentCalls.map((call) => call.mockAnswer), [
    { glob: "refute:*" },
    { glob: "refute:*" },
  ]);
  assert.deepEqual(report.dryRun?.mockAnswers?.rules, [
    { glob: "refute:*", kind: "single", matchingCalls: 2, consumedCalls: 2 },
  ]);
});

test("a two-answer sequence drives gate() through rejection and approval", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "mock-gate", description: "d" };',
      "const REVIEW = { type: 'object', additionalProperties: false, required: ['ok', 'feedback'],",
      "  properties: { ok: { type: 'boolean' }, feedback: { type: 'string' } } };",
      "return await gate(",
      '  (feedback, attempt) => ({ feedback, attempt }),',
      '  (value) => agent("review " + value.attempt, { label: "quality:review", schema: REVIEW }),',
      "  { attempts: 3 },",
      ");",
    ].join("\n"),
    {
      mockAnswers: {
        "quality:review": {
          $sequence: [
            { ok: false, feedback: "revise" },
            { ok: true, feedback: "" },
          ],
        },
      },
    },
  );

  assert.equal(report.ok, true);
  const result = report.dryRun?.result as {
    ok: boolean;
    value: { feedback?: string; attempt: number };
    verdict: { ok: boolean; feedback: string };
    attempts: number;
  };
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(plain(result.value), { feedback: "revise", attempt: 1 });
  assert.deepEqual(plain(result.verdict), { ok: true, feedback: "" });
  assert.deepEqual(report.dryRun?.agentCalls.map((call) => call.mockAnswer), [
    { glob: "quality:review", sequenceIndex: 0, sequenceLength: 2 },
    { glob: "quality:review", sequenceIndex: 1, sequenceLength: 2 },
  ]);
});

test("parallel repeated labels consume sequences in stable thunk/FIFO order", async () => {
  const script = [
    'export const meta = { name: "mock-parallel", description: "d" };',
    "const S = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };",
    'return await parallel(["a", "b", "c"].map((name) => () =>',
    '  agent(name, { label: "same", schema: S }).then((answer) => ({ name, n: answer.n }))',
    "));",
  ].join("\n");
  const mockAnswers = { same: { $sequence: [{ n: 1 }, { n: 2 }, { n: 3 }] } } as const;
  const projections: string[] = [];
  for (let run = 0; run < 4; run++) {
    const report = await validateWorkflowScript(script, { mockAnswers });
    assert.equal(report.ok, true);
    projections.push(JSON.stringify({
      result: report.dryRun?.result,
      calls: report.dryRun?.agentCalls,
      mockAnswers: report.dryRun?.mockAnswers,
    }));
  }
  assert.equal(new Set(projections).size, 1);
  assert.deepEqual(JSON.parse(projections[0]).result, [
    { name: "a", n: 1 },
    { name: "b", n: 2 },
    { name: "c", n: 3 },
  ]);
});

test("root and nested workflows share one sequence and rule counters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "automatalabs-mock-answer-nested-"));
  try {
    writeFileSync(
      join(dir, "child.workflow.js"),
      [
        'export const meta = { name: "child", description: "d" };',
        "const S = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };",
        'return await agent("child", { label: "shared", schema: S });',
      ].join("\n"),
    );
    const report = await validateWorkflowScript(
      [
        'export const meta = { name: "parent", description: "d" };',
        "const S = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };",
        'const root = await agent("root", { label: "shared", schema: S });',
        'const child = await workflow("child");',
        "return { root, child };",
      ].join("\n"),
      {
        workflows: dir,
        mockAnswers: { shared: { $sequence: [{ n: 1 }, { n: 2 }] } },
      },
    );
    assert.deepEqual(plain(report.dryRun?.result), { root: { n: 1 }, child: { n: 2 } });
    assert.deepEqual(report.dryRun?.mockAnswers?.rules, [
      { glob: "shared", kind: "sequence", matchingCalls: 2, consumedCalls: 2, sequenceLength: 2 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captured rule order uses last-match precedence and reports shadowing", async () => {
  const script = [
    'export const meta = { name: "precedence", description: "d" };',
    "const S = { type: 'object', required: ['real'], properties: { real: { type: 'boolean' } } };",
    'return await agent("x", { label: "refute:a", schema: S });',
  ].join("\n");
  const narrowLast = await validateWorkflowScript(script, {
    mockAnswers: { "*": { real: true }, "refute:*": { real: false } },
  });
  assert.deepEqual(narrowLast.dryRun?.result, { real: false });
  assert.deepEqual(narrowLast.dryRun?.mockAnswers, {
    rules: [
      { glob: "*", kind: "single", matchingCalls: 1, consumedCalls: 0 },
      { glob: "refute:*", kind: "single", matchingCalls: 1, consumedCalls: 1 },
    ],
    unused: [{ glob: "*", reason: "shadowed" }],
  });

  const broadLast = await validateWorkflowScript(script, {
    mockAnswers: { "refute:*": { real: false }, "*": { real: true } },
  });
  assert.deepEqual(broadLast.dryRun?.result, { real: true });

  for (const glob of ["0", "10", "4294967294"]) {
    await assert.rejects(
      validateWorkflowScript(script, { mockAnswers: { "*": true, [glob]: false } as never }),
      /reserved canonical array-index key/,
    );
  }

  const numericScript = [
    'export const meta = { name: "numeric", description: "d" };',
    'const a = await agent("a", { label: "10" });',
    'const b = await agent("b", { label: "01" });',
    'const c = await agent("c", { label: "4294967295" });',
    "return [a, b, c];",
  ].join("\n");
  const numeric = await validateWorkflowScript(numericScript, {
    mockAnswers: {
      "*": "broad",
      "\\10": "ten",
      "01": "leading-zero",
      "4294967295": "upper-bound",
    },
  });
  assert.deepEqual(plain(numeric.dryRun?.result), ["ten", "leading-zero", "upper-bound"]);
  assert.deepEqual(numeric.dryRun?.agentCalls.map((call) => call.mockAnswer?.glob), ["\\10", "01", "4294967295"]);
});

test("raw arrays are single answers and sequence elements may contain $sequence data", async () => {
  const arrayReport = await validateWorkflowScript(
    [
      'export const meta = { name: "array-answer", description: "d" };',
      "const S = { type: 'array', items: { type: 'number' } };",
      'return await agent("x", { label: "array", schema: S });',
    ].join("\n"),
    { mockAnswers: { array: [2, 3] } },
  );
  assert.deepEqual(arrayReport.dryRun?.result, [2, 3]);
  assert.equal(arrayReport.dryRun?.mockAnswers?.rules[0].kind, "single");

  const dataReport = await validateWorkflowScript(
    [
      'export const meta = { name: "sequence-data", description: "d" };',
      "const S = { type: 'object', required: ['$sequence'], properties: { $sequence: { type: 'array', items: { type: 'string' } } } };",
      'return await agent("x", { label: "data", schema: S });',
    ].join("\n"),
    { mockAnswers: { data: { $sequence: [{ $sequence: ["literal-data"] }] } } },
  );
  assert.deepEqual(dataReport.dryRun?.result, { $sequence: ["literal-data"] });
  assert.equal(dataReport.dryRun?.mockAnswers?.rules[0].kind, "sequence");
});

test("merge recursively combines objects, replaces other JSON values, and refreshes sequence bases", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "merge", description: "d" };',
      "const S = { type: 'object', additionalProperties: false, required: ['nested', 'array', 'nullable', 'flag', 'count', 'text'], properties: {",
      " nested: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } },",
      " array: { type: 'array', items: { type: 'number' } }, nullable: { type: ['string', 'null'] },",
      " flag: { type: 'boolean' }, count: { type: 'number' }, text: { type: 'string' } } };",
      'const first = await agent("one", { label: "merge", schema: S });',
      'const second = await agent("two", { label: "merge", schema: S });',
      "return { first, second };",
    ].join("\n"),
    {
      mockAnswers: {
        merge: {
          $sequence: [
            { nested: { a: "first" }, array: [7], nullable: null, flag: false, count: 0, text: "" },
            { nested: { b: "second" }, array: [8, 9], nullable: "value", flag: false, count: 0, text: "done" },
          ],
        },
      },
    },
  );
  const result = report.dryRun?.result as { first: Record<string, unknown>; second: Record<string, unknown> };
  assert.deepEqual(result.first, {
    nested: { a: "first", b: "mock-b" },
    array: [7],
    nullable: null,
    flag: false,
    count: 0,
    text: "",
  });
  assert.deepEqual(result.second, {
    nested: { a: "mock-a", b: "second" },
    array: [8, 9],
    nullable: "value",
    flag: false,
    count: 0,
    text: "done",
  });
});

test("sequence exhaustion fails without false consumption attribution", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "exhaust", description: "d" };',
      'await agent("a", { label: "repeat" });',
      'await agent("b", { label: "repeat" });',
      'return await agent("c", { label: "repeat" });',
    ].join("\n"),
    { mockAnswers: { repeat: { $sequence: ["one", "two"] } } },
  );
  assert.equal(report.exitCode, 2);
  assert.match(report.dryRun?.reason ?? "", /sequence length 2, 2 already consumed/);
  assert.doesNotMatch(report.dryRun?.reason ?? "", /\bone\b|\btwo\b/);
  assert.deepEqual(report.dryRun?.agentCalls.map((call) => call.mockAnswer?.sequenceIndex), [0, 1, undefined]);
  assert.equal(report.dryRun?.mockAnswers?.rules[0].consumedCalls, 2);
});

test("override-caused schema violations fail without coercion or answer disclosure", async () => {
  const script = [
    'export const meta = { name: "schema-failure", description: "d" };',
    "const S = { type: 'object', additionalProperties: false, required: ['real'], properties: { real: { type: 'boolean' } } };",
    'return await agent("x", { label: "x", schema: S });',
  ].join("\n");
  const secret = "fixture-sentinel-not-for-reports";
  for (const answer of [{ real: "false" }, { real: false, extra: secret }, 0]) {
    const report = await validateWorkflowScript(script, { mockAnswers: { x: answer } as never });
    assert.equal(report.exitCode, 2);
    assert.match(report.dryRun?.reason ?? "", /failed schema validation/);
    assert.ok((report.dryRun?.reason?.length ?? 0) <= 1024);
    assert.doesNotMatch(JSON.stringify({
      reason: report.dryRun?.reason,
      warnings: report.warnings,
      attribution: report.dryRun?.agentCalls,
    }), new RegExp(secret));
  }
});

test("baseline-delta accepts untouched fabrication debt, groups paths, and rejects touched debt", async () => {
  const script = [
    'export const meta = { name: "baseline", description: "d" };',
    "const S = { type: 'object', additionalProperties: false, required: ['ok', 'items', 'digits', 'even'], properties: {",
    " ok: { type: 'boolean' }, items: { type: 'array', minItems: 5, items: { type: 'string' } },",
    " digits: { type: 'string', pattern: '^[0-9]+$' }, even: { type: 'number', multipleOf: 2 } } };",
    'return await agent("x", { label: "baseline", schema: S });',
  ].join("\n");
  const inherited = await validateWorkflowScript(script, { mockAnswers: { baseline: { ok: false } } });
  assert.equal(inherited.ok, true);
  assert.match(inherited.warnings.join("\n"), /\/items, \/digits, \/even/);
  assert.match(inherited.warnings.join("\n"), /1 occurrence/);

  const touched = await validateWorkflowScript(script, { mockAnswers: { baseline: { items: [] } } });
  assert.equal(touched.exitCode, 2);
  assert.match(touched.dryRun?.reason ?? "", /\/items/);

  const repaired = await validateWorkflowScript(script, {
    mockAnswers: { baseline: { digits: "123", even: 2 } },
  });
  assert.equal(repaired.ok, true);
  assert.match(repaired.warnings.join("\n"), /\/items/);
  assert.doesNotMatch(repaired.warnings.join("\n"), /\/digits|\/even/);

  const rootSchema = [
    'export const meta = { name: "root-path", description: "d" };',
    "const S = { type: 'object', minProperties: 3, properties: { ok: { type: 'boolean' } } };",
    'return await agent("x", { label: "root", schema: S });',
  ].join("\n");
  const root = await validateWorkflowScript(rootSchema, { mockAnswers: { root: { ok: false } } });
  assert.equal(root.exitCode, 2);
  assert.match(root.dryRun?.reason ?? "", /: \/ /);
});

test("schema-less fixtures require nonblank strings and never retry or double-consume", async () => {
  const valid = await validateWorkflowScript(
    'export const meta = { name: "text", description: "d" };\nreturn await agent("x", { label: "text" });',
    { mockAnswers: { text: "scripted text" } },
  );
  assert.equal(valid.dryRun?.result, "scripted text");

  for (const answer of [{}, "", "   "]) {
    const invalid = await validateWorkflowScript(
      'export const meta = { name: "text", description: "d" };\nreturn await agent("x", { label: "text" });',
      { mockAnswers: { text: answer } as never },
    );
    assert.equal(invalid.exitCode, 2);
    assert.match(invalid.dryRun?.reason ?? "", /non-blank string/);
  }

  const retry = await validateWorkflowScript(
    'export const meta = { name: "retry", description: "d" };\nreturn await agent("x", { label: "text", retries: 2 });',
    { mockAnswers: { text: { $sequence: [" ", "would-pass"] } } },
  );
  assert.equal(retry.exitCode, 2);
  assert.equal(retry.dryRun?.agentCalls.length, 1);
  assert.deepEqual(retry.dryRun?.agentCalls[0].mockAnswer, {
    glob: "text",
    sequenceIndex: 0,
    sequenceLength: 2,
  });
  assert.equal(retry.dryRun?.mockAnswers?.rules[0].consumedCalls, 1);
  assert.deepEqual(retry.dryRun?.mockAnswers?.unused, [
    { glob: "text", sequenceIndex: 1, reason: "not-reached" },
  ]);
});

test("unused rules distinguish no-match, shadowed, and partially not-reached answers", async () => {
  const report = await validateWorkflowScript(
    'export const meta = { name: "unused", description: "d" };\nreturn await agent("x", { label: "hit" });',
    {
      mockAnswers: {
        miss: "unused",
        hit: { $sequence: ["first", "later"] },
        "*": "winner",
      },
    },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.dryRun?.mockAnswers?.unused, [
    { glob: "miss", reason: "no-match" },
    { glob: "hit", sequenceIndex: 0, reason: "shadowed" },
    { glob: "hit", sequenceIndex: 1, reason: "shadowed" },
  ]);
  assert.equal(report.warnings.filter((warning) => /unused answer/.test(warning)).length, 2);

  const partial = await validateWorkflowScript(
    'export const meta = { name: "partial", description: "d" };\nreturn await agent("x", { label: "hit" });',
    { mockAnswers: { hit: { $sequence: ["first", "later"] } } },
  );
  assert.deepEqual(partial.dryRun?.mockAnswers?.unused, [
    { glob: "hit", sequenceIndex: 1, reason: "not-reached" },
  ]);

  const full = await validateWorkflowScript(
    'export const meta = { name: "full", description: "d" };\nawait agent("x", { label: "hit" }); return await agent("y", { label: "hit" });',
    { mockAnswers: { hit: { $sequence: ["first", "second"] } } },
  );
  assert.deepEqual(full.dryRun?.mockAnswers?.unused, []);
  assert.doesNotMatch(full.warnings.join("\n"), /unused answer/);
});

test("invalid mock-answer contracts throw TypeError before workflow parsing", async () => {
  const invalidScript = "this is not a workflow";
  const invalidValues: unknown[] = [
    null,
    [],
    "text",
    { "": true },
    { "bad\\": true },
    { "0": true },
    { x: { $sequence: [] } },
    { x: { $sequence: "no" } },
    { x: { $sequence: [true], extra: false } },
    { x: undefined },
    { x: NaN },
    { x: Infinity },
    { x: 1n },
    { x: () => true },
    { x: new (class Fixture {})() },
    { x: new Array(1) },
    { [Symbol("x")]: true },
  ];
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "x", { enumerable: true, get: () => true });
  invalidValues.push(accessor);
  const hidden = {} as Record<string, unknown>;
  Object.defineProperty(hidden, "x", { enumerable: false, value: true });
  invalidValues.push(hidden);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  invalidValues.push({ x: cycle });

  for (const mockAnswers of invalidValues) {
    await assert.rejects(
      validateWorkflowScript(invalidScript, { mockAnswers } as never),
      TypeError,
    );
  }

  const tooManyRules = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`rule-${index}`, true]));
  const tooLongGlob = { ["x".repeat(257)]: true };
  const tooLongSequence = { x: { $sequence: Array.from({ length: 257 }, () => true) } };
  let tooDeep: unknown = true;
  for (let depth = 0; depth < 33; depth++) tooDeep = { child: tooDeep };
  const tooLarge = { x: "a".repeat(256 * 1024) };
  for (const mockAnswers of [tooManyRules, tooLongGlob, tooLongSequence, { x: tooDeep }, tooLarge]) {
    await assert.rejects(validateWorkflowScript(invalidScript, { mockAnswers } as never), TypeError);
  }
});

test("default validation omits mock fields while an empty configuration reports empty rules", async () => {
  const script = [
    'export const meta = { name: "defaults", description: "d" };',
    "const S = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };",
    'return await agent("x", { label: "x", schema: S });',
  ].join("\n");
  const defaults = await validateWorkflowScript(script);
  assert.deepEqual(defaults.dryRun?.result, { ok: true });
  assert.equal(defaults.dryRun?.mockAnswers, undefined);
  assert.equal(defaults.dryRun?.agentCalls[0].mockAnswer, undefined);

  const empty = await validateWorkflowScript(script, { mockAnswers: {} });
  assert.deepEqual(empty.dryRun?.result, { ok: true });
  assert.deepEqual(empty.dryRun?.mockAnswers, { rules: [], unused: [] });
});

test("parse-only and parse failures validate input but do not report unused mock answers", async () => {
  const parseOnly = await validateWorkflowScript(
    'export const meta = { name: "parse-only", description: "d" };\nreturn 1;',
    { dryRun: false, mockAnswers: { never: "unused" } },
  );
  assert.equal(parseOnly.dryRun, undefined);
  assert.equal(parseOnly.warnings.length, 0);

  const parseFailure = await validateWorkflowScript("not valid", { mockAnswers: { never: "unused" } });
  assert.equal(parseFailure.exitCode, 1);
  assert.equal(parseFailure.dryRun, undefined);
  assert.equal(parseFailure.warnings.length, 0);
});

test("human reports print value-free mock attribution and grouped warnings", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "format", description: "d" };',
      "const S = { type: 'object', required: ['ok', 'items'], properties: { ok: { type: 'boolean' }, items: { type: 'array', minItems: 5, items: { type: 'string' } } } };",
      'return await agent("x", { label: "quality:review", schema: S });',
    ].join("\n"),
    {
      mockAnswers: {
        "quality:review": { $sequence: [{ ok: false }, { ok: true }] },
        never: "secret-answer-body",
      },
    },
  );
  const text = formatValidateReport(report);
  assert.match(text, /mock="quality:review"\[1\/2\]/);
  assert.match(text, /pre-existing fabricated-default limitations/);
  assert.match(text, /unused answer/);
  assert.doesNotMatch(text, /secret-answer-body/);
});
