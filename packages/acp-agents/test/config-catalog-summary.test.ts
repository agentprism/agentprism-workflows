// The bounded authoring summary and the probe scheduler of src/config-catalog.ts
// (moved here from @automatalabs/workflows together with the code).
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  buildHarnessConfigSummary, formatHarnessConfigSummary, buildHarnessModelsView,
  probeHarnessConfig, setConfigProbeFactoryForTests,
} from "../src/config-catalog.js";
import type { ValidateHarnessOptions } from "../src/config-catalog.js";
import type { ProbedConfigOptions } from "../src/index.js";

function catalog(backendId: string, ids: string[], metadata?: Record<string, unknown>): ValidateHarnessOptions {
  return {
    backendId, probed: true,
    options: [{
      id: "model", type: "select", name: "Model", currentValue: ids[0] ?? "",
      options: ids.map((value) => ({ value, name: value })),
      ...(metadata ? { _meta: metadata } : {}),
    }],
  };
}

test("bounded concurrent probes preserve request order despite reversed completion", async () => {
  const pending = new Map<string, (value: ProbedConfigOptions) => void>();
  let active = 0;
  let peak = 0;
  const started: string[] = [];
  const reportPromise = probeHarnessConfig({
    harnesses: ["a", "b", "c", "d", "a"], probeConcurrency: 2,
    probeRunner: {
      probeConfigOptions(spec) {
        const id = spec!;
        started.push(id);
        peak = Math.max(peak, ++active);
        return new Promise((resolve) => pending.set(id, (value) => { active--; resolve(value); }));
      },
    },
  });
  await setImmediate();
  assert.deepEqual(started, ["a", "b"]);
  pending.get("b")!({ backendId: "b", options: [] });
  await setImmediate();
  assert.deepEqual(started, ["a", "b", "c"]);
  pending.get("c")!({ backendId: "c", options: [] });
  await setImmediate();
  pending.get("d")!({ backendId: "d", options: [] });
  pending.get("a")!({ backendId: "a", options: [] });
  const report = await reportPromise;
  assert.equal(peak, 2);
  assert.deepEqual(report.harnessOptions.map(({ backendId }) => backendId), ["a", "b", "c", "d"]);
  assert.deepEqual(report.authoringSummary?.harnesses.map(({ backendId }) => backendId), ["a", "b", "c", "d"]);
});

test("timeout aborts a stalled peer and retains healthy catalogs and late rejection handlers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  let rejectStalled: (error: Error) => void = () => {};
  let disposed = false;
  const reportPromise = probeHarnessConfig({
    harnesses: ["stall", "claude"], probeTimeoutMs: 10,
    probeRunner: {
      async probeConfigOptions(spec, options) {
        if (spec === "stall") {
          signal = options?.signal;
          return new Promise((_, reject) => { rejectStalled = reject; });
        }
        return { backendId: "claude", options: catalog("claude", ["opus"]).options! };
      },
      async dispose() { disposed = true; },
    },
  });
  await setImmediate();
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(10);
  const report = await reportPromise;
  assert.equal(signal?.aborted, true);
  assert.equal(disposed, false);
  assert.equal(report.ok, false);
  assert.match(report.harnessOptions[0].error!, /timed out after 10ms/);
  assert.equal(report.harnessOptions[1].probed, true);
  assert.deepEqual(report.authoringSummary?.harnesses[1].models, [{ modelId: "opus", route: "claude/opus" }]);
  rejectStalled(new Error("late failure"));
  await setImmediate();
});

test("owned-runner disposal is bounded even when cleanup stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposing = false;
  const restore = setConfigProbeFactoryForTests(() => ({
    async probeConfigOptions() { return { backendId: "claude", options: [] }; },
    async dispose() { disposing = true; return new Promise(() => {}); },
  }));
  try {
    const reportPromise = probeHarnessConfig({ harnesses: ["claude"], probeTimeoutMs: 10 });
    await setImmediate();
    assert.equal(disposing, true);
    t.mock.timers.tick(10);
    assert.equal((await reportPromise).ok, true);
  } finally { restore(); }
});

test("shared cancellation preserves completed catalogs and never starts queued probes", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const signals: AbortSignal[] = [];
  const reportPromise = probeHarnessConfig({
    harnesses: ["healthy", "stalled", "queued"], probeConcurrency: 1, signal: controller.signal,
    probeRunner: {
      async probeConfigOptions(spec, options) {
        started.push(spec!);
        signals.push(options!.signal!);
        if (spec === "healthy") return { backendId: "healthy", options: [] };
        return new Promise(() => {});
      },
    },
  });
  await setImmediate();
  controller.abort(new Error("shared discovery deadline"));
  const report = await reportPromise;
  assert.deepEqual(started, ["healthy", "stalled"]);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(report.harnessOptions.map(entry => entry.probed), [true, false, false]);
  assert.match(report.harnessOptions[2].error!, /shared discovery deadline/);
});

test("cancellation still initiates owned disposal without awaiting stalled cleanup", async () => {
  const controller = new AbortController();
  let disposing = false;
  const restore = setConfigProbeFactoryForTests(() => ({
    async probeConfigOptions() { return new Promise(() => {}); },
    async dispose() { disposing = true; return new Promise(() => {}); },
  }));
  try {
    const reportPromise = probeHarnessConfig({ harnesses: ["claude"], signal: controller.signal });
    await setImmediate();
    controller.abort(new Error("shared discovery deadline"));
    assert.equal((await reportPromise).ok, false);
    assert.equal(disposing, true);
  } finally { restore(); }
});

test("invalid probe bounds fail before creating or calling a runner", async () => {
  const probeRunner = { async probeConfigOptions(): Promise<ProbedConfigOptions> { assert.fail("must not probe"); } };
  for (const probeTimeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    await assert.rejects(probeHarnessConfig({ probeRunner, probeTimeoutMs }), /probeTimeoutMs/);
  }
  for (const probeConcurrency of [0, -1, 17, Infinity, 1.5]) {
    await assert.rejects(probeHarnessConfig({ probeRunner, probeConcurrency }), /probeConcurrency/);
  }
});

test("a synchronously throwing probe releases its slot and cancels its timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  const report = await probeHarnessConfig({
    harnesses: ["bad", "healthy"], probeConcurrency: 1, probeTimeoutMs: 10,
    probeRunner: {
      probeConfigOptions(spec, options) {
        signals.push(options!.signal!);
        if (spec === "bad") throw new Error("synchronous failure");
        return Promise.resolve({ backendId: "healthy", options: [] });
      },
    },
  });
  assert.equal(report.harnessOptions[0].probed, false);
  assert.match(report.harnessOptions[0].error!, /synchronous failure/);
  assert.equal(report.harnessOptions[1].probed, true);
  t.mock.timers.tick(10);
  assert.ok(signals.every((signal) => !signal.aborted), "settled probes have no live deadline");
});

test("small Claude/Codex catalogs preserve exact routes and failed providers remain visible", () => {
  const report = { harnessOptions: [
    catalog("claude", ["sonnet", "opus[1m]"]), catalog("codex", ["gpt-5.6-sol", "gpt-5.6-sol[high]"]),
    { backendId: "pi", probed: false, error: "login required" },
  ] };
  const summary = buildHarnessConfigSummary(report);
  assert.deepEqual(summary.harnesses[0].models.map(({ route }) => route), ["claude/sonnet", "claude/opus[1m]"]);
  assert.equal(summary.harnesses[1].total, 2);
  const text = formatHarnessConfigSummary(summary);
  assert.match(text, /"pi": unavailable.*login required/);
  assert.match(text, /modelSpecs/);
  assert.match(text, /Default-model options do not describe every model/);
});

test("Pi enabledModels preserves preference order, intersects supported leaves, and reports unmatched patterns", () => {
  const harness = catalog("pi", ["openai/a", "anthropic/b", "openai/c"], {
    "@automatalabs/agentprism.modelDiscovery": {
      source: "enabledModels", preferred: ["anthropic/b", "missing/id", "openai/a", "anthropic/b"], unmatched: ["unknown/*"],
    },
  });
  const original = structuredClone(harness);
  const report = { ok: true, exitCode: 0 as const, harnessOptions: [harness] };
  const summary = buildHarnessConfigSummary(report);
  const entry = summary.harnesses[0];
  assert.equal(entry.total, 3);
  assert.equal(entry.preferredTotal, 2);
  assert.equal(entry.preferenceSource, "enabledModels");
  assert.deepEqual(entry.models.map(({ route }) => route), ["pi/anthropic/b", "pi/openai/a"]);
  assert.deepEqual(entry.unmatched, ["unknown/*"]);
  assert.equal(entry.omittedModels, 1);
  assert.deepEqual(harness, original);
  assert.deepEqual(buildHarnessModelsView(report, "openai/c")[0].matches, ["openai/c"]);
  assert.match(formatHarnessConfigSummary(summary), /presentation shortlist, not an execution allowlist/);
});

test("Pi without preferences uses actual provider groups; empty configured preferences stay explicit", () => {
  const plain = catalog("pi", ["openai/a", "openai/b", "vendor/c"]);
  const empty = catalog("pi", ["openai/a"], {
    "@automatalabs/agentprism.modelDiscovery": { source: "enabledModels", preferred: [], unmatched: ["missing/*"] },
  });
  const summary = buildHarnessConfigSummary({ harnessOptions: [plain, empty] });
  assert.deepEqual(summary.harnesses[0].models, []);
  assert.deepEqual(summary.harnesses[0].groups.map(({ provider, count }) => [provider, count]), [["openai", 2], ["vendor", 1]]);
  assert.equal(summary.harnesses[1].preferredTotal, 0);
  assert.match(formatHarnessConfigSummary(summary), /No enabledModels preference metadata/);
  assert.match(formatHarnessConfigSummary(summary), /missing\/\*/);
});

test("OpenCode lists direct models first and exact known aggregators as browse-only entries", () => {
  const harness = catalog("opencode", [
    "openrouter/openai/a", "opencode/b", "anthropic/c", "my-openrouter/d", "openrouter/google/e", "vendor.with+regex/f",
  ]);
  const report = { ok: true, exitCode: 0 as const, harnessOptions: [harness] };
  const entry = buildHarnessConfigSummary(report).harnesses[0];
  assert.equal(entry.total, 6);
  assert.deepEqual(entry.models.map(({ route }) => route), ["opencode/anthropic/c", "opencode/my-openrouter/d", "opencode/vendor.with+regex/f"]);
  assert.deepEqual(entry.groups.map(({ provider }) => provider), ["anthropic", "my-openrouter", "vendor.with+regex", "openrouter", "opencode"]);
  const browse = entry.groups.filter(({ kind }) => kind === "aggregator");
  assert.deepEqual(browse.map(({ selector, count }) => [selector, count]), [["openrouter/*", 2], ["opencode/*", 1]]);
  assert.ok(entry.models.every(({ route }) => !route.includes("*")));
  assert.deepEqual(buildHarnessModelsView(report, browse[0].modelFilter)[0].matches, ["openrouter/openai/a", "openrouter/google/e"]);
  assert.deepEqual(buildHarnessModelsView(report, entry.groups[2].modelFilter)[0].matches, ["vendor.with+regex/f"]);
  assert.match(formatHarnessConfigSummary({ harnesses: [entry] }), /browse only \(not executable\)/);
});

test("all explicitly classified OpenCode aggregators are browsable and current models remain separate", () => {
  const ids = ["huggingface/vendor/a", "amazon-bedrock/vendor.b", "opencode-go/c", "github-copilot/d", "openrouter/vendor/e", "opencode/f", "deepseek/g"];
  const entry = buildHarnessConfigSummary({ harnessOptions: [catalog("opencode", ids)] }).harnesses[0];
  assert.deepEqual(entry.models.map(({ route }) => route), ["opencode/deepseek/g"]);
  assert.equal(entry.currentRoute, "opencode/huggingface/vendor/a");
  assert.deepEqual(entry.groups.filter(({ kind }) => kind === "aggregator").map(({ selector }) => selector), [
    "huggingface/*", "amazon-bedrock/*", "opencode-go/*", "github-copilot/*", "openrouter/*", "opencode/*",
  ]);
  const pi = buildHarnessConfigSummary({ harnessOptions: [catalog("pi", ["provider/current", "provider/preferred"], {
    "@automatalabs/agentprism.modelDiscovery": { source: "enabledModels", preferred: ["provider/preferred"], unmatched: [] },
  })] }).harnesses[0];
  assert.equal(pi.currentRoute, "pi/provider/current");
  assert.deepEqual(pi.models.map(({ route }) => route), ["pi/provider/preferred"]);
});

test("catalog route identifiers remain verbatim even when they resemble credential strings", () => {
  const id = "vendor/model-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const route = `pi/${id}`;
  const entry = buildHarnessConfigSummary({ harnessOptions: [{ ...catalog("pi", [id]), model: route }] }).harnesses[0];
  assert.equal(entry.model, route);
  assert.equal(entry.currentRoute, route);
  assert.ok(formatHarnessConfigSummary({ harnesses: [entry] }).includes(route));
});

test("bounded OpenCode direct models represent every configured direct provider", () => {
  const entry = buildHarnessConfigSummary({ harnessOptions: [catalog("opencode", [
    ...Array.from({ length: 40 }, (_, index) => `google/model-${index}`),
    "deepseek/model-a", "zai/model-b", "openrouter/vendor/model-c",
  ])] }).harnesses[0];
  assert.equal(entry.models.length, 24);
  assert.deepEqual(entry.models.slice(0, 3).map(({ modelId }) => modelId), ["google/model-0", "deepseek/model-a", "zai/model-b"]);
  assert.equal(entry.omittedModels, 19);
});

test("summary bounds are explicit and do not hide catalog/provider/pattern counts", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `provider${i}/model`);
  ids.push(`provider80/${"x".repeat(300)}`, "provider81/*");
  const summary = buildHarnessConfigSummary({ harnessOptions: [
    catalog("claude", ids),
    catalog("pi", ids, {
      "@automatalabs/agentprism.modelDiscovery": {
        source: "enabledModels", preferred: ids,
        unmatched: Array.from({ length: 80 }, (_, i) => `missing${i}/${"x".repeat(300)}`),
      },
    }),
    { backendId: "failed", probed: false, error: "x".repeat(10_000) },
  ] });
  for (const entry of summary.harnesses.slice(0, 2)) {
    assert.equal(entry.total, 82);
    assert.equal(entry.models.length, 24);
    assert.equal(entry.omittedModels, 58);
    assert.equal(entry.groups.length, 24);
    assert.equal(entry.omittedGroups, 58);
    assert.equal(entry.omittedGroupModels, 58);
    assert.ok(entry.models.every(({ route }) => route.length <= 240 && !route.includes("*")));
  }
  assert.equal(summary.harnesses[1].omittedUnmatched, 56);
  assert.equal(summary.harnesses[1].unmatched.length, 24);
  assert.ok(summary.harnesses[2].error!.length < 300);
  assert.match(formatHarnessConfigSummary(summary), /58 provider group\(s\), 58 models omitted/);
  assert.match(formatHarnessConfigSummary(summary), /56 additional unmatched/);
});

test("exact-model scopes and absent model options are represented without fabricated models", () => {
  const entry = { ...catalog("codex", ["gpt"]), model: "codex/gpt" };
  const summary = buildHarnessConfigSummary({ harnessOptions: [entry, { backendId: "custom", probed: true, options: [] }] });
  assert.equal(summary.harnesses[0].model, "codex/gpt");
  assert.equal(summary.harnesses[1].hasModelOption, false);
  assert.match(formatHarnessConfigSummary(summary), /"custom": no model option advertised/);
});
