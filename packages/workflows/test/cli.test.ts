import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const FAKE_AGENT = resolve(import.meta.dirname, "../../acp-agents/test/fixtures/fake-acp-agent.mjs");
const FIXTURES = mkdtempSync(join(tmpdir(), "automatalabs-workflows-cli-"));

process.on("exit", () => {
  try {
    rmSync(FIXTURES, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function fixture(name: string, source: string): string {
  const path = join(FIXTURES, name);
  writeFileSync(path, source);
  return path;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, "validate", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: FIXTURES,
      AGENTPRISM_CLAUDE_ACP_CMD: process.execPath,
      AGENTPRISM_CLAUDE_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_CODEX_ACP_CMD: process.execPath,
      AGENTPRISM_CODEX_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_OPENCODE_ACP_CMD: process.execPath,
      AGENTPRISM_OPENCODE_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_FAKE_SCENARIO: JSON.stringify({ configOptions: [] }),
    },
  });
}

const REFUTATION = fixture(
  "refutation.workflow.js",
  [
    'export const meta = { name: "refutation", description: "d" };',
    "const S = { type: 'object', additionalProperties: false, required: ['real', 'reason'],",
    "  properties: { real: { type: 'boolean' }, reason: { type: 'string' } } };",
    "for (let round = 0; round < 2; round++) {",
    '  const answer = await agent("refute", { label: "refute:" + round, schema: S });',
    "  if (!answer.real) return { round, answer };",
    "}",
    'throw new Error("refutation loop did not converge");',
  ].join("\n"),
);

const GATE = fixture(
  "gate.workflow.js",
  [
    'export const meta = { name: "gate", description: "d" };',
    "const S = { type: 'object', additionalProperties: false, required: ['ok', 'feedback'],",
    "  properties: { ok: { type: 'boolean' }, feedback: { type: 'string' } } };",
    "return await gate(",
    '  (feedback, attempt) => ({ feedback, attempt }),',
    '  () => agent("review", { label: "report:review", schema: S }),',
    "  { attempts: 2 },",
    ");",
  ].join("\n"),
);

const SIMPLE = fixture(
  "simple.workflow.js",
  'export const meta = { name: "simple", description: "d" };\nreturn await agent("x", { label: "x" });',
);

test("--mock-answers drives a bounded false branch and exposes JSON attribution", () => {
  const result = runCli([
    REFUTATION,
    "--mock-answers",
    '{"refute:*":{"real":false}}',
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun.result.round, 0);
  assert.equal(report.dryRun.result.answer.real, false);
  assert.deepEqual(report.dryRun.agentCalls[0].mockAnswer, { glob: "refute:*" });
});

test("human and --json reports both surface the freshly probed harness catalog", () => {
  const json = runCli([SIMPLE, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.dryRun.harnessOptions, [
    { backendId: "claude", probed: true, options: [] },
  ]);

  const human = runCli([SIMPLE]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /advertised config options:/);
  assert.match(human.stdout, /claude:/);
  assert.match(human.stdout, /\(none advertised\)/);
});

test("--mock-answers-file reads a two-round sequence and human output uses one-based indexes", () => {
  const answers = fixture(
    "gate.mock-answers.json",
    JSON.stringify({
      "report:review": {
        $sequence: [
          { ok: false, feedback: "revise" },
          { ok: true, feedback: "" },
        ],
      },
    }),
  );
  const result = runCli([GATE, "--mock-answers-file", answers]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mock="report:review"\[1\/2\]/);
  assert.match(result.stdout, /mock="report:review"\[2\/2\]/);
});

test("mock-answer CLI usage errors use fail() and never the crash handler", () => {
  const oversized = fixture("oversized.json", `{"x":"${"a".repeat(256 * 1024)}"}`);
  const reservedIndex = fixture("reserved-index.json", '{"*":"default","10":"numeric"}');
  const cases: string[][] = [
    [SIMPLE, "--mock-answers", '{"x":"ok"}', "--mock-answers-file", "answers.json"],
    [SIMPLE, "--mock-answers", '{"x":"ok"}', "--mock-answers", '{"x":"again"}'],
    [SIMPLE, "--mock-answers-file", "answers.json", "--mock-answers-file", "answers.json"],
    [SIMPLE, "--mock-answers", "{"],
    [SIMPLE, "--mock-answers", "[]"],
    [SIMPLE, "--mock-answers", '{"":true}'],
    [SIMPLE, "--mock-answers", '{"bad\\\\":true}'],
    [SIMPLE, "--mock-answers", '{"0":true}'],
    [SIMPLE, "--mock-answers-file", reservedIndex],
    [SIMPLE, "--mock-answers", '{"x":{"$sequence":[]}}'],
    [SIMPLE, "--mock-answers-file", join(FIXTURES, "missing.json")],
    [SIMPLE, "--mock-answers-file", oversized],
    [SIMPLE, "--mock-answers"],
  ];

  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 3, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, /Run `agentprism-workflows validate --help` for usage\./);
    assert.doesNotMatch(result.stderr, /validate crashed:/);
  }
});

test("existing CLI exit codes 0, 1, and 2 remain unchanged", () => {
  const parseInvalid = fixture("parse-invalid.workflow.js", "return 1;");
  const dryRunInvalid = fixture(
    "dry-run-invalid.workflow.js",
    'export const meta = { name: "invalid", description: "d" };\nthrow new Error("dry-run boom");',
  );
  assert.equal(runCli([SIMPLE]).status, 0);
  assert.equal(runCli([parseInvalid]).status, 1);
  assert.equal(runCli([dryRunInvalid]).status, 2);
});
