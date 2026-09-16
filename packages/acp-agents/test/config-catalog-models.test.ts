// The select-choice grouping helpers and the `--models` view builders of
// src/config-catalog.ts (moved here from @automatalabs/workflows; the CLI renderers and the
// collapse-on-print rules stay with the CLI).
import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeSelectChoices,
  buildHarnessModelsView,
  buildModelFilter,
  probeHarnessConfig,
  setConfigProbeFactoryForTests,
} from "../src/config-catalog.js";
import type { SessionConfigOption } from "../src/index.js";

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

const EFFORT_OPTION: SessionConfigOption = {
  id: "effort",
  type: "select",
  name: "Effort",
  category: "thought_level",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "xhigh", name: "Xhigh" },
  ],
};

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
  assert.doesNotMatch(JSON.stringify(view), /anthropic\/model-0/); // breakdown carries no leaves
});

test("buildHarnessModelsView with a substring filter returns matching leaves", () => {
  const [view] = buildHarnessModelsView(MODELS_REPORT, "openai");
  assert.equal(view.total, undefined);
  assert.equal(view.filter, "openai");
  assert.equal(view.matches?.length, 20);
  assert.ok(view.matches?.every((value) => value.startsWith("openai/")));
});

test("a /regex/ filter is honored case-insensitively; a bad regex throws", () => {
  const [view] = buildHarnessModelsView(MODELS_REPORT, "/^ANTHROPIC\\/model-1$/");
  assert.deepEqual(view.matches, ["anthropic/model-1"]);
  assert.throws(() => buildModelFilter("/(/"), TypeError);
});

test("buildHarnessModelsView reports harnesses that advertise no model option and failed probes", () => {
  const views = buildHarnessModelsView({
    ok: false,
    exitCode: 1,
    harnessOptions: [
      { backendId: "codex", probed: true, options: [EFFORT_OPTION] },
      { backendId: "pi", probed: false, error: "login required" },
    ],
  });
  assert.deepEqual(views[0], { backendId: "codex", probed: true, hasModelOption: false });
  assert.deepEqual(views[1], { backendId: "pi", probed: false, error: "login required", hasModelOption: false });
});

// ── programmatic probe stays complete; collapsing is a print-time concern ────

test("probeHarnessConfig keeps the full catalog in memory", async () => {
  const restore = setConfigProbeFactoryForTests(() => ({
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
