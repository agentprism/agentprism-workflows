// Oversized model-catalog collapsing for `agentprism-workflows config` / `validate`
// (see ./src/validate.ts summarize/collapse helpers and ./src/config.ts --models view).
// A harness with a huge model list (pi, opencode) must not flood an agent's context on
// ANY rendered surface — human table or --json — while the complete catalog stays in the
// in-memory report and is reachable only through the explicit `--models[=<filter>]` path.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  MAX_INLINE_SELECT_CHOICES,
  summarizeSelectChoices,
  isOversizedSelect,
  selectChoicePairs,
  collapseHarnessOptionsForOutput,
  type CollapsedSelectOption,
} from "../src/validate.js";
import {
  probeHarnessConfig,
  formatHarnessConfigReport,
  buildHarnessModelsView,
  formatHarnessModels,
  buildModelFilter,
} from "../src/config.js";
import { setValidateProbeFactoryForTests } from "../src/validate-internal.js";
import type { SessionConfigOption } from "@automatalabs/acp-agents";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const FAKE_AGENT = resolve(import.meta.dirname, "../../acp-agents/test/fixtures/fake-acp-agent.mjs");

/** A flat (ungrouped) model select whose ids are "<provider>/<model>". */
function flatModelOption(providers: string[], perProvider: number): SessionConfigOption {
  const options = providers.flatMap((provider) =>
    Array.from({ length: perProvider }, (_, i) => ({ value: `${provider}/model-${i}`, name: `${provider} ${i}` })),
  );
  return {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: `${providers[0]}/model-0`,
    options,
  };
}

/** A model select whose leaves are carried in advertised optgroups (with human names). */
function groupedModelOption(groups: Array<{ id: string; name: string; count: number }>): SessionConfigOption {
  return {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: `${groups[0].id}/m0`,
    options: groups.map((group) => ({
      group: group.id,
      name: group.name,
      options: Array.from({ length: group.count }, (_, i) => ({ value: `${group.id}/m${i}`, name: `m${i}` })),
    })),
  };
}

const SMALL_OPTIONS: SessionConfigOption[] = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "opus[1m]", name: "Opus (1M)" },
    ],
  },
  {
    id: "effort",
    type: "select",
    name: "Effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "xhigh", name: "Xhigh" },
    ],
  },
];

// ── pure helpers ─────────────────────────────────────────────────────────────

test("summarizeSelectChoices groups flat ids by their provider prefix, largest-first", () => {
  const option = flatModelOption(["anthropic", "openai", "google"], 20);
  assert.equal(option.type, "select");
  const summary = summarizeSelectChoices(option as Extract<SessionConfigOption, { type: "select" }>);
  assert.equal(summary.total, 60);
  assert.deepEqual(summary.groups, [
    { group: "anthropic", count: 20 },
    { group: "openai", count: 20 },
    { group: "google", count: 20 },
  ]);
});

test("summarizeSelectChoices prefers advertised optgroup names and sorts by count", () => {
  const option = groupedModelOption([
    { id: "openai", name: "OpenAI", count: 31 },
    { id: "anthropic", name: "Anthropic", count: 23 },
  ]);
  const summary = summarizeSelectChoices(option as Extract<SessionConfigOption, { type: "select" }>);
  assert.equal(summary.total, 54);
  assert.deepEqual(summary.groups, [
    { group: "OpenAI", count: 31 },
    { group: "Anthropic", count: 23 },
  ]);
});

test("a slash-less id falls into the (ungrouped) bucket", () => {
  const option: SessionConfigOption = {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "solo",
    options: Array.from({ length: 30 }, (_, i) => ({ value: `solo-${i}`, name: `Solo ${i}` })),
  };
  const summary = summarizeSelectChoices(option as Extract<SessionConfigOption, { type: "select" }>);
  assert.deepEqual(summary.groups, [{ group: "(ungrouped)", count: 30 }]);
});

test("isOversizedSelect trips strictly above the inline bound", () => {
  const atBound = flatModelOption(["p"], MAX_INLINE_SELECT_CHOICES); // exactly 24 → inline
  const overBound = flatModelOption(["p"], MAX_INLINE_SELECT_CHOICES + 1); // 25 → collapse
  assert.equal(selectChoicePairs(atBound as Extract<SessionConfigOption, { type: "select" }>).length, 24);
  assert.equal(isOversizedSelect(atBound), false);
  assert.equal(isOversizedSelect(overBound), true);
});

// ── human render ─────────────────────────────────────────────────────────────

test("formatHarnessConfigReport collapses an oversized model list and keeps small options verbatim", () => {
  const human = formatHarnessConfigReport({
    ok: true,
    exitCode: 0,
    harnessOptions: [
      {
        backendId: "opencode",
        probed: true,
        options: [flatModelOption(["anthropic", "openai", "google", "xai"], 25), SMALL_OPTIONS[1]],
      },
    ],
  });
  // The model line is summarized, NOT a 100-id dump.
  assert.match(human, /^    model \| Model \| select \| "anthropic\/model-0" \| 100 choices across 4 group\(s\): /m);
  assert.match(human, /list with `config opencode --models\[=<filter>\]`/);
  assert.doesNotMatch(human, /"anthropic\/model-24"/); // no leaf ids leaked into the table
  // The small effort option is untouched.
  assert.match(human, /^    effort \| Effort \| select \| "medium" \| "low", "xhigh" \| $/m);
});

test("a below-threshold catalog keeps every advertised choice inline", () => {
  const human = formatHarnessConfigReport({
    ok: true,
    exitCode: 0,
    harnessOptions: [{ backendId: "claude", probed: true, options: SMALL_OPTIONS }],
  });
  assert.match(human, /^    model \| Model \| select \| "default" \| "default", "opus\[1m\]" \| $/m);
});

// ── serialized (--json) collapse ─────────────────────────────────────────────

test("collapseHarnessOptionsForOutput drops the leaf array for oversized selects only", () => {
  const full = [
    { backendId: "opencode", probed: true, options: [flatModelOption(["anthropic", "openai"], 30), SMALL_OPTIONS[1]] },
  ];
  const collapsed = collapseHarnessOptionsForOutput(full)!;
  const model = collapsed[0].options![0] as CollapsedSelectOption;
  assert.equal(model.truncated, true);
  assert.equal("options" in model, false, "the huge leaf array is gone from the serialized option");
  assert.equal(model.choiceSummary.total, 60);
  assert.deepEqual(model.choiceSummary.groups, [
    { group: "anthropic", count: 30 },
    { group: "openai", count: 30 },
  ]);
  assert.equal(model.choiceSummary.expand, "config opencode --models=<filter>");
  // The small option is passed through untouched (still carries its leaves).
  const effort = collapsed[0].options![1];
  assert.ok("options" in effort && Array.isArray(effort.options));
  // The SOURCE report is not mutated — the in-memory catalog stays complete.
  assert.ok("options" in full[0].options[0] && (full[0].options[0] as { options: unknown[] }).options.length === 60);
});

// ── --models view ────────────────────────────────────────────────────────────

const MODELS_REPORT = {
  ok: true,
  exitCode: 0 as const,
  harnessOptions: [{ backendId: "opencode", probed: true, options: [flatModelOption(["anthropic", "openai"], 20)] }],
};

test("buildHarnessModelsView with no filter returns the group breakdown, never leaf ids", () => {
  const [view] = buildHarnessModelsView(MODELS_REPORT);
  assert.equal(view.hasModelOption, true);
  assert.equal(view.total, 40);
  assert.deepEqual(view.groups, [
    { group: "anthropic", count: 20 },
    { group: "openai", count: 20 },
  ]);
  assert.equal(view.matches, undefined);
  const text = formatHarnessModels([view]);
  assert.match(text, /^opencode: 40 models in 2 group\(s\):$/m);
  assert.match(text, /^  anthropic \(20\)$/m);
  assert.match(text, /narrow with: config opencode --models=/);
  assert.doesNotMatch(text, /anthropic\/model-0/); // breakdown carries no leaves
});

test("buildHarnessModelsView with a substring filter returns matching leaves", () => {
  const [view] = buildHarnessModelsView(MODELS_REPORT, "openai");
  assert.equal(view.total, undefined);
  assert.equal(view.matches?.length, 20);
  assert.ok(view.matches?.every((value) => value.startsWith("openai/")));
  const text = formatHarnessModels([view]);
  assert.match(text, /^opencode: 20 model\(s\) matching "openai":$/m);
  assert.match(text, /^  openai\/model-3$/m);
});

test("a /regex/ filter is honored case-insensitively; a bad regex throws", () => {
  const [view] = buildHarnessModelsView(MODELS_REPORT, "/^ANTHROPIC\\/model-1$/");
  assert.deepEqual(view.matches, ["anthropic/model-1"]);
  assert.throws(() => buildModelFilter("/(/"), TypeError);
});

test("--models reports harnesses that advertise no model option", () => {
  const view = buildHarnessModelsView({
    ok: true,
    exitCode: 0,
    harnessOptions: [{ backendId: "codex", probed: true, options: [SMALL_OPTIONS[1]] }],
  });
  assert.equal(view[0].hasModelOption, false);
  assert.match(formatHarnessModels(view), /^codex: no model option advertised$/m);
});

// ── programmatic probe stays complete; only the CLI print collapses ──────────

test("probeHarnessConfig keeps the full catalog in memory (collapse is print-only)", async () => {
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      return { backendId: spec ?? "claude", options: [flatModelOption(["anthropic", "openai"], 30)] };
    },
    async dispose() {},
  }));
  try {
    const report = await probeHarnessConfig({ harnesses: ["opencode"] });
    const model = report.harnessOptions[0].options![0];
    assert.ok(model.type === "select" && model.options.length === 60, "in-memory report is not collapsed");
  } finally {
    restore();
  }
});

// ── CLI wiring against the fake agent (small catalog) ────────────────────────

function runConfig(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, "config", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTPRISM_BACKENDS: undefined,
      AGENTPRISM_CLAUDE_ACP_CMD: process.execPath,
      AGENTPRISM_CLAUDE_ACP_ARGS: FAKE_AGENT,
    },
  });
}

test("CLI: `config claude --models` prints the breakdown and no leaf ids", () => {
  const result = runConfig(["claude", "--models"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^claude: \d+ models in \d+ group\(s\):$/m);
  assert.match(result.stdout, /narrow with: config claude --models=/);
  assert.doesNotMatch(result.stdout, /luna/); // no leaf id in the bare breakdown
});

test("CLI: `config claude --models=luna` lists only the matching leaves", () => {
  const result = runConfig(["claude", "--models=luna"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model\(s\) matching "luna"/);
  assert.match(result.stdout, /gpt-5\.6-luna\[high\]/);
});

test("CLI: `config claude --models --json` emits the structured model view", () => {
  const result = runConfig(["claude", "--models", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { harnessModels: Array<{ backendId: string; groups?: unknown[] }> };
  assert.equal(parsed.harnessModels[0].backendId, "claude");
  assert.ok(Array.isArray(parsed.harnessModels[0].groups));
});
