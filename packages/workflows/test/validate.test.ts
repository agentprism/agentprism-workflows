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
  ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT,
} from "../src/validate.js";
import { setValidateProbeFactoryForTests } from "../src/validate-internal.js";
import type { SessionConfigOption } from "@automatalabs/acp-agents";

const ADVERTISED_OPTIONS: SessionConfigOption[] = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default-model",
    options: [{ value: "default-model", name: "Default" }],
  },
  {
    id: "reasoning_effort",
    type: "select",
    name: "Reasoning effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
    _meta: {
      "@automatalabs/agentprism": {
        recognizedValues: ["low", "high"],
      },
    },
  },
  {
    id: "fast_mode",
    type: "boolean",
    name: "Fast mode",
    category: "model_config",
    currentValue: false,
  },
];

setValidateProbeFactoryForTests(() => ({
  async probeConfigOptions(spec) {
    return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
  },
  async dispose() {},
}));

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("valid script: parse + dry run complete; calls, backends, checkpoints, phases reported", async () => {
  const script = [
    'export const meta = { name: "v", description: "d", phases: [{ title: "Fan" }, { title: "Judge" }] };',
    "const S = { type: 'object', additionalProperties: false, required: ['ok', 'notes'],",
    "  properties: { ok: { type: 'boolean' }, notes: { type: 'string' } } };",
    'phase("Fan");',
    "const pair = await parallel([",
    '  () => agent("a", { label: "claude-side", model: "claude/opus[1m]", schema: S }),',
    '  () => agent("b", { label: "codex-side", model: "codex/gpt-5.6-luna" }),',
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

test("agent configuration discovery exposes a useful bounded redacted task preview", async () => {
  const secret = "sk-proj-1234567890abcdef";
  const longTask = `Inspect deployment ${secret} and report concrete file targets ${"detail ".repeat(100)}`;
  const report = await validateWorkflowScript(
    `export const meta = { name: "preview", description: "preview" };\n` +
      `return await agent(${JSON.stringify(longTask)}, { label: "review", model: "codex" });`,
    { probeConfig: false },
  );
  assert.equal(report.ok, true);
  const preview = report.dryRun?.agentCalls[0]?.promptPreview;
  assert.ok(preview);
  assert.match(preview, /Inspect deployment \[REDACTED\]/);
  assert.doesNotMatch(preview, /sk-proj-/);
  assert.ok(Buffer.byteLength(preview, "utf8") <= 384);
  assert.match(preview, /…$/);
});

test("defaultModel is resolved during the dry run and probeConfig:false performs routing discovery without probes", async () => {
  let probes = 0;
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "default-model", description: "d" };',
      'return await agent("look", { label: "look" });',
    ].join("\n"),
    {
      cwd: TEST_HOME,
      defaultModel: "codex",
      probeConfig: false,
      probeRunner: {
        async probeConfigOptions() {
          probes++;
          return { backendId: "codex", options: ADVERTISED_OPTIONS };
        },
      },
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.dryRun?.agentCalls[0]?.model, "codex");
  assert.equal(report.dryRun?.agentCalls[0]?.backend, "codex");
  assert.deepEqual(report.dryRun?.harnessOptions, []);
  assert.equal(probes, 0);
});

test("validate reuses a host-owned probe runner, passes approved script backends, and never disposes it", async () => {
  let disposed = 0;
  const probes: Array<{ spec?: string; hasBrowser: boolean }> = [];
  const probeRunner = {
    async probeConfigOptions(spec?: string, options?: { backends?: Record<string, { command: string }> }) {
      probes.push({ spec, hasBrowser: options?.backends?.browser?.command === "browser-acp" });
      return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
    },
    async dispose() {
      disposed++;
    },
  };
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "host-probe", description: "d", backends: { browser: { command: "browser-acp" } } };',
      'return await agent("look", { label: "look", model: "browser/visual" });',
    ].join("\n"),
    { cwd: TEST_HOME, probeRunner },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(probes, [{ spec: "browser/visual", hasBrowser: true }]);
  assert.equal(disposed, 0, "validation does not own the server runner");
});

test("host-owned runner backend names drive custom routing attribution without exposing spawn configs", async () => {
  const probeRunner = {
    listBackends: () => ["claude", "codex", "opencode", "pi", "team"],
    async probeConfigOptions(spec?: string) {
      return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
    },
  };
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "host-custom", description: "d" };',
      'return await agent("look", { label: "look", model: "team/model-a" });',
    ].join("\n"),
    { cwd: TEST_HOME, probeRunner },
  );
  assert.equal(report.ok, true);
  assert.equal(report.dryRun?.agentCalls[0]?.backend, "team");
  assert.equal(report.dryRun?.harnessOptions?.[0]?.backendId, "team");
});

test("validate probes each distinct routed backend/model pair and surfaces catalogs without authored configOptions", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  process.env.AGENTPRISM_DEFAULT_BACKEND = "browser";
  const probes: Array<{
    spec: string | undefined;
    cwd: string | undefined;
    selectModel: boolean | undefined;
  }> = [];
  const restore = setValidateProbeFactoryForTests((backends) => {
    assert.ok(backends?.browser, "script-declared custom backend reaches the probe runner registry");
    return {
      async probeConfigOptions(spec, opts) {
        probes.push({ spec, cwd: opts?.cwd, selectModel: opts?.selectModel });
        return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
      },
      async dispose() {},
    };
  });
  try {
    const report = await validateWorkflowScript(
      [
        'export const meta = { name: "routing", description: "d", backends: { browser: { command: "browser-acp" } } };',
        'const a = await agent("a", { label: "default-a" });',
        'const b = await agent("b", { label: "browser-b", model: "browser/visual" });',
        'const c = await agent("c", { label: "codex-c", model: "codex/gpt" });',
        'return { a, b, c };',
      ].join("\n"),
      { cwd: TEST_HOME },
    );

    assert.equal(report.ok, true);
    assert.deepEqual(probes.map((probe) => probe.spec), ["browser", "browser/visual", "codex/gpt"]);
    assert.ok(probes.every((probe) => probe.cwd === TEST_HOME));
    assert.deepEqual(probes.map((probe) => probe.selectModel), [false, true, true]);
    assert.deepEqual(
      report.dryRun?.harnessOptions?.map(({ backendId, model }) => ({ backendId, model })),
      [
        { backendId: "browser", model: undefined },
        { backendId: "browser", model: "browser/visual" },
        { backendId: "codex", model: "codex/gpt" },
      ],
    );
    assert.ok(report.dryRun?.harnessOptions?.every((harness) => harness.probed));
    assert.deepEqual(report.dryRun?.harnessOptions?.[0].options, ADVERTISED_OPTIONS);
    assert.equal(report.dryRun?.agentCalls[0].configOptions, undefined);
    const human = formatValidateReport(report);
    assert.match(human, /advertised modes and config options:/);
    assert.match(human, /reasoning_effort \| Reasoning effort \| select \| "medium" \| "low", "high"/);
    assert.match(JSON.stringify(report), /reasoning_effort/);
  } finally {
    restore();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("session mode validation rejects unadvertised ids and preserves an explicit no-modes catalog", async () => {
  const probeRunner = {
    async probeConfigOptions() {
      return { backendId: "pi", options: ADVERTISED_OPTIONS, modes: null };
    },
  };
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "bad-mode", description: "d" };',
      'return agent("x", { label: "pi-call", model: "pi/openai/model", mode: "default", configOptions: { fast_mode: true } });',
    ].join("\n"),
    { probeRunner },
  );

  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.dryRun?.harnessOptions?.[0]?.modes, null);
  const reason = report.dryRun?.reason ?? "";
  assert.match(reason, /agent "pi-call" mode authored value "default" is not advertised/);
  assert.match(reason, /advertised modes: \(none advertised\)/);
  assert.match(reason, /omit mode unless action:"config" explicitly lists the exact id/);
  assert.doesNotMatch(reason, /offending key|fast_mode.*unknown/);
  assert.match(formatValidateReport(report), /modes: \(none advertised — omit mode\)/);
});

test("session mode validation accepts only an explicitly advertised exact id", async () => {
  const probeRunner = {
    async probeConfigOptions() {
      return {
        backendId: "claude",
        options: ADVERTISED_OPTIONS,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      };
    },
  };
  const report = await validateWorkflowScript(
    'export const meta = { name: "mode", description: "d" }; return agent("x", { label: "plan", model: "claude/opus", mode: "plan" });',
    { probeRunner },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.dryRun?.harnessOptions?.[0]?.modes?.availableModes.map((mode) => mode.id), ["default", "plan"]);
  assert.match(formatValidateReport(report), /modes: current "default" \| AgentPrism default \(harness current\)/);
  assert.match(formatValidateReport(report), /"plan" \| Plan/);
});

test("an omitted mode validates the AgentPrism built-in default against the live catalog", async () => {
  const script = 'export const meta = { name: "default-mode", description: "d" }; return agent("x", { label: "worker", model: "claude/opus" });';
  const accepted = await validateWorkflowScript(script, {
    probeRunner: {
      async probeConfigOptions() {
        return {
          backendId: "claude",
          defaultModeId: "auto",
          options: [],
          modes: {
            currentModeId: "acceptEdits",
            availableModes: [{ id: "auto", name: "Auto", description: "Use a model classifier" }],
          },
        };
      },
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.dryRun?.harnessOptions?.[0]?.defaultModeId, "auto");

  const rejected = await validateWorkflowScript(script, {
    probeRunner: {
      async probeConfigOptions() {
        return {
          backendId: "claude",
          defaultModeId: "auto",
          options: [],
          modes: {
            currentModeId: "acceptEdits",
            availableModes: [{ id: "acceptEdits", name: "Accept Edits" }],
          },
        };
      },
    },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.dryRun?.reason ?? "", /mode AgentPrism default "auto" is not advertised/);
});

test("config-option error classes make validation INVALID with labels, values, and alternatives", async () => {
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "bad-options", description: "d" };',
      'await agent("a", { label: "unknown-call", configOptions: { mystery: "wat" } });',
      'await agent("b", { label: "select-call", configOptions: { reasoning_effort: "extreme" } });',
      'await agent("c", { label: "boolean-call", configOptions: { fast_mode: 1 } });',
      'return agent("d", { label: "model-call", configOptions: { model: "shadow" } });',
    ].join("\n"),
  );

  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.dryRun?.ok, false);
  const reason = report.dryRun?.reason ?? "";
  for (const label of ["unknown-call", "select-call", "boolean-call", "model-call"]) {
    assert.match(reason, new RegExp(label));
  }
  for (const value of ["wat", "extreme", "1", "shadow"]) assert.match(reason, new RegExp(value));
  assert.match(reason, /advertised alternatives: option ids/);
  assert.match(reason, /valid values: "low", "high"/);
  assert.match(reason, /advertised alternatives: true, false/);
  assert.match(reason, /use the call's model field/);
  assert.deepEqual(plain(report.dryRun?.agentCalls.map((call) => call.configOptions)), [
    { mystery: "wat" },
    { reasoning_effort: "extreme" },
    { fast_mode: 1 },
    { model: "shadow" },
  ]);
});

const PI_THINKING_DOMAIN = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function piThinkingOptions(supported: readonly string[]): SessionConfigOption[] {
  return [{
    id: "thinkingLevel",
    type: "select",
    name: "Thinking level",
    category: "thought_level",
    currentValue: supported.includes("medium") ? "medium" : supported[0] ?? "off",
    options: supported.map((value) => ({ value, name: value })),
    _meta: {
      "@automatalabs/agentprism": {
        recognizedValues: PI_THINKING_DOMAIN,
      },
    },
  }];
}

function modelSelect(models: readonly string[], current: string): SessionConfigOption {
  return {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: current,
    options: models.map((value) => ({ value, name: value })),
  };
}

function thoughtSelect(id: string, values: readonly string[]): SessionConfigOption {
  return {
    id,
    type: "select",
    name: "Effort",
    category: "thought_level",
    currentValue: values[0] ?? "default",
    options: values.map((value) => ({ value, name: value })),
  };
}

test("pi thinkingLevel validation probes the call model and passes over-ceiling values with a clamp warning", async () => {
  const probes: Array<{ spec: string | undefined; selectModel: boolean | undefined }> = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec, opts) {
      probes.push({ spec, selectModel: opts?.selectModel });
      const supported = spec === "pi/test/capped"
        ? PI_THINKING_DOMAIN.slice(0, PI_THINKING_DOMAIN.indexOf("high") + 1)
        : PI_THINKING_DOMAIN;
      return { backendId: "pi", options: piThinkingOptions(supported) };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "pi-clamp", description: "d" };',
      'return agent("x", { label: "capped-call", model: "pi/test/capped", configOptions: { thinkingLevel: "xhigh" } });',
    ].join("\n"));

    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(probes, [{ spec: "pi/test/capped", selectModel: true }]);
    assert.equal(report.dryRun?.harnessOptions?.[0]?.model, "pi/test/capped");
    assert.match(report.warnings.join("\n"), /capped-call/);
    assert.match(report.warnings.join("\n"), /pi model "pi\/test\/capped"/);
    assert.match(report.warnings.join("\n"), /will clamp to "high"/);
    assert.doesNotMatch(report.warnings.join("\n"), /domain enumeration/);
  } finally {
    restore();
  }
});

test("pi thinkingLevel validation passes supported values unchanged without a clamp warning", async () => {
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions() {
      return {
        backendId: "pi",
        options: piThinkingOptions(PI_THINKING_DOMAIN.slice(0, PI_THINKING_DOMAIN.indexOf("high") + 1)),
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "pi-supported", description: "d" };',
      'return agent("x", { label: "supported-call", model: "pi/test/capped", configOptions: { thinkingLevel: "high" } });',
    ].join("\n"));

    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.doesNotMatch(report.warnings.join("\n"), /clamp/);
  } finally {
    restore();
  }
});

test("pi thinkingLevel validation fails unrecognized garbage with exit 2, model, and valid domain", async () => {
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions() {
      return {
        backendId: "pi",
        options: piThinkingOptions(PI_THINKING_DOMAIN.slice(0, PI_THINKING_DOMAIN.indexOf("high") + 1)),
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "pi-garbage", description: "d" };',
      'return agent("x", { label: "garbage-call", model: "pi/test/capped", configOptions: { thinkingLevel: "ultrahigh" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 2);
    assert.match(report.dryRun?.reason ?? "", /garbage-call/);
    assert.match(report.dryRun?.reason ?? "", /pi model "pi\/test\/capped"/);
    assert.match(report.dryRun?.reason ?? "", /"off".*"max"/);
    assert.match(report.dryRun?.reason ?? "", /ultrahigh/);
  } finally {
    restore();
  }
});

test("recognized interior-gap thinkingLevel clamps upward in advertised order", async () => {
  const supported = PI_THINKING_DOMAIN.filter((value) => value !== "low" && value !== "xhigh" && value !== "max");
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions() {
      return { backendId: "pi", options: piThinkingOptions(supported) };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "pi-gap", description: "d" };',
      'return agent("x", { label: "gap-call", model: "pi/test/gap", configOptions: { thinkingLevel: "low" } });',
    ].join("\n"));

    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.match(report.warnings.join("\n"), /will clamp to "medium"/);
  } finally {
    restore();
  }
});

test("codex enumerates one ordered union per backend, clamps a lower-ceiling model, and rejects unknown values", async () => {
  const perModel = {
    "gpt-six": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-four": ["low", "medium", "high", "xhigh"],
  } as const;
  const models = Object.keys(perModel);
  const probes: string[] = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec, opts) {
      assert.equal(opts?.selectModel, true);
      probes.push(spec ?? "");
      const model = spec?.slice("codex/".length) as keyof typeof perModel;
      return {
        backendId: "codex",
        options: [modelSelect(models, model), thoughtSelect("reasoning_effort", perModel[model])],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "codex-domain", description: "d" };',
      'await agent("a", { label: "six-supported", model: "codex/gpt-six", configOptions: { reasoning_effort: "ultra" } });',
      'await agent("b", { label: "four-clamp", model: "codex/gpt-four", configOptions: { reasoning_effort: "ultra" } });',
      'return agent("c", { label: "four-unknown", model: "codex/gpt-four", configOptions: { reasoning_effort: "warp" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 2);
    assert.deepEqual(probes, ["codex/gpt-four", "codex/gpt-six"]);
    assert.match(report.warnings.join("\n"), /four-clamp[\s\S]*will clamp to "xhigh"/);
    assert.doesNotMatch(report.warnings.join("\n"), /six-supported/);
    assert.match(report.dryRun?.reason ?? "", /four-unknown[\s\S]*warp/);
    const expectedDomain = [...new Set(Object.values(perModel).flat())];
    const fourCatalog = report.dryRun?.harnessOptions?.find((entry) => entry.model === "codex/gpt-four");
    const effort = fourCatalog?.options?.find((option) => option.id === "reasoning_effort");
    const namespace = effort?._meta?.["@automatalabs/agentprism"] as
      | { recognizedValues?: unknown }
      | undefined;
    assert.deepEqual(namespace?.recognizedValues, expectedDomain);
  } finally {
    restore();
  }
});

test("claude does not borrow effort for an effort-absent model and keeps default outside clamp ordering", async () => {
  const perModel = {
    opus: ["default", "low", "medium", "high", "xhigh"],
    sonnet: ["default", "low", "medium"],
    haiku: undefined,
  } as const;
  const models = Object.keys(perModel);
  const probes: string[] = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      probes.push(spec ?? "");
      const model = spec?.slice("claude/".length) as keyof typeof perModel;
      const effort = perModel[model];
      return {
        backendId: "claude",
        options: [
          modelSelect(models, model),
          ...(effort === undefined ? [] : [thoughtSelect("effort", effort)]),
        ],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "claude-domain", description: "d" };',
      'await agent("a", { label: "haiku-absent", model: "claude/haiku", configOptions: { effort: "high" } });',
      'await agent("b", { label: "sonnet-clamp", model: "claude/sonnet", configOptions: { effort: "high" } });',
      'return agent("c", { label: "sonnet-default", model: "claude/sonnet", configOptions: { effort: "default" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.deepEqual(probes, ["claude/haiku", "claude/sonnet", "claude/opus"]);
    assert.deepEqual(
      report.dryRun?.harnessOptions?.find((entry) => entry.model === "claude/haiku")?.options?.map(({ id }) => id),
      ["model"],
    );
    assert.match(report.dryRun?.reason ?? "", /haiku-absent[\s\S]*option "effort"[\s\S]*unknown/);
    assert.match(report.warnings.join("\n"), /sonnet-clamp[\s\S]*will clamp to "medium"/);
    assert.doesNotMatch(report.warnings.join("\n"), /will clamp to "default"/);
    assert.doesNotMatch(report.warnings.join("\n"), /sonnet-default/);
    const sonnet = report.dryRun?.harnessOptions?.find((entry) => entry.model === "claude/sonnet");
    const effort = sonnet?.options?.find((option) => option.id === "effort");
    const namespace = effort?._meta?.["@automatalabs/agentprism"] as
      | { recognizedValues?: unknown }
      | undefined;
    assert.deepEqual(namespace?.recognizedValues, ["low", "medium", "high", "xhigh", "default"]);
  } finally {
    restore();
  }
});

test("opencode keeps full provider/model identities distinct and exact-rejects without enumeration", async () => {
  const perModel = {
    "openrouter/anthropic/claude-opus-4.6": ["low", "high"],
    "direct/anthropic/claude-opus-4.6": ["eco", "turbo"],
  } as const;
  const probes: Array<{ spec: string | undefined; selectModel: boolean | undefined }> = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec, opts) {
      probes.push({ spec, selectModel: opts?.selectModel });
      const model = spec?.slice("opencode/".length) as keyof typeof perModel;
      return {
        backendId: "opencode",
        options: [
          modelSelect(Object.keys(perModel), model),
          thoughtSelect("effort", perModel[model]),
        ],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "opencode-exact", description: "d" };',
      'await agent("a", { label: "openrouter-valid", model: "opencode/openrouter/anthropic/claude-opus-4.6", configOptions: { effort: "high" } });',
      'return agent("b", { label: "direct-reject", model: "opencode/direct/anthropic/claude-opus-4.6", configOptions: { effort: "high" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.deepEqual(probes, [
      { spec: "opencode/direct/anthropic/claude-opus-4.6", selectModel: true },
      { spec: "opencode/openrouter/anthropic/claude-opus-4.6", selectModel: true },
    ]);
    assert.match(report.dryRun?.reason ?? "", /direct-reject[\s\S]*advertised alternatives: "eco", "turbo"/);
    assert.match(report.dryRun?.reason ?? "", /must match exactly/);
    assert.doesNotMatch(report.warnings.join("\n"), /clamp|enumeration/);
  } finally {
    restore();
  }
});

test("ordered-domain cost guard skips catalogs above 32 models, warns, and exact-rejects", async () => {
  const models = Array.from(
    { length: ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT + 1 },
    (_, index) => `model-${index}`,
  );
  const probes: string[] = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      probes.push(spec ?? "");
      return {
        backendId: "codex",
        options: [modelSelect(models, "model-0"), thoughtSelect("reasoning_effort", ["low"])],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "cost-guard", description: "d" };',
      'return agent("x", { label: "guarded-call", model: "codex/model-0", configOptions: { reasoning_effort: "high" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.deepEqual(probes, ["codex/model-0"]);
    assert.match(
      report.warnings.join("\n"),
      new RegExp(`advertised ${models.length} models[\\s\\S]*limit of ${ORDERED_THOUGHT_LEVEL_ENUMERATION_MODEL_LIMIT}`),
    );
    assert.match(report.dryRun?.reason ?? "", /guarded-call[\s\S]*must match exactly/);
  } finally {
    restore();
  }
});

test("undeclared/custom backend semantics default to exact-set and never enumerate", async () => {
  const probes: string[] = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      probes.push(spec ?? "");
      return {
        backendId: "future",
        options: [
          modelSelect(["model-a", "model-b"], "model-a"),
          thoughtSelect("effort", ["low"]),
        ],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "custom-exact", description: "d", backends: { future: { command: "future-acp" } } };',
      'return agent("x", { label: "custom-call", model: "future/model-a", configOptions: { effort: "high" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.deepEqual(probes, ["future/model-a"]);
    assert.match(report.dryRun?.reason ?? "", /custom-call[\s\S]*must match exactly/);
    assert.doesNotMatch(report.warnings.join("\n"), /ordered thought-level domain enumeration/);
  } finally {
    restore();
  }
});

test("inconsistent ordered subsets warn and fall back to exact advertised-value validation", async () => {
  const perModel = {
    alpha: ["low", "high"],
    beta: ["high", "low", "xhigh"],
  } as const;
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      const model = spec?.slice("codex/".length) as keyof typeof perModel;
      return {
        backendId: "codex",
        options: [
          modelSelect(Object.keys(perModel), model),
          thoughtSelect("reasoning_effort", perModel[model]),
        ],
      };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript([
      'export const meta = { name: "inconsistent-domain", description: "d" };',
      'return agent("x", { label: "inconsistent-call", model: "codex/alpha", configOptions: { reasoning_effort: "xhigh" } });',
    ].join("\n"));

    assert.equal(report.ok, false);
    assert.match(report.warnings.join("\n"), /could not merge advertised thought-level orders/);
    assert.match(report.dryRun?.reason ?? "", /inconsistent-call[\s\S]*must match exactly/);
    assert.doesNotMatch(report.warnings.join("\n"), /will clamp/);
  } finally {
    restore();
  }
});

test("probe failure warns once per backend/model pair, reports probed:false, and skips its option checks", async () => {
  const probes: string[] = [];
  const restore = setValidateProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      probes.push(spec ?? "claude");
      if (spec?.startsWith("codex")) throw new Error("login required by fake codex");
      return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
    },
    async dispose() {},
  }));
  try {
    const report = await validateWorkflowScript(
      [
        'export const meta = { name: "degrade", description: "d" };',
        'const a = await agent("a", { label: "codex-a", model: "codex/gpt", configOptions: { mystery: "x" } });',
        'const b = await agent("b", { label: "codex-b", model: "codex/other" });',
        'const c = await agent("c", { label: "claude-c", model: "claude" });',
        'return { a, b, c };',
      ].join("\n"),
    );

    assert.equal(report.ok, true, "an unverified unknown option is skipped, not failed");
    assert.deepEqual(probes, ["claude", "codex/gpt", "codex/other"]);
    const codex = report.dryRun?.harnessOptions?.filter((harness) => harness.backendId === "codex");
    assert.deepEqual(codex, [
      {
        backendId: "codex",
        model: "codex/gpt",
        probed: false,
        error: "login required by fake codex",
      },
      {
        backendId: "codex",
        model: "codex/other",
        probed: false,
        error: "login required by fake codex",
      },
    ]);
    assert.equal(report.warnings.filter((warning) => /could not probe codex/.test(warning)).length, 2);
    assert.match(report.warnings.join("\n"), /configOptions on its calls are unverified/);
    assert.doesNotMatch(report.dryRun?.reason ?? "", /mystery/);
    assert.match(
      formatValidateReport(report),
      /codex \(model "codex\/gpt"\): probe failed — login required by fake codex/,
    );
  } finally {
    restore();
  }
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

test("foreign workflow agent option dialects reject before probing or runner execution", async () => {
  let probes = 0;
  const report = await validateWorkflowScript(
    [
      'export const meta = { name: "foreign", description: "d" };',
      'return agent("x", { label: "pi-call", backend: "pi", model: "openai/model", config: { thinkingLevel: "high" } });',
    ].join("\n"),
    {
      probeRunner: {
        async probeConfigOptions() {
          probes++;
          return { backendId: "claude", options: ADVERTISED_OPTIONS, modes: null };
        },
      },
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(probes, 0);
  assert.match(report.dryRun?.reason ?? "", /agent "pi-call" options contain unknown keys "backend", "config"/);
  assert.equal(report.dryRun?.agentCalls.length, 0);
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

test("§7: the budget surface is deleted — a script referencing `budget` fails the dry run with the undefined-global error", async () => {
  const script = [
    'export const meta = { name: "v", description: "d" };',
    "const out = [];",
    "while (budget.remaining() >= 1) {",
    '  out.push(await agent("more", { label: "loop:" + out.length }));',
    "}",
    "return out.length;",
  ].join("\n");
  const report = await validateWorkflowScript(script);
  assert.equal(report.ok, false);
  assert.match(report.dryRun?.reason ?? "", /budget/);
});

test("§7: the per-phase budget option is deleted — phase('p', { budget: 0 }) fails the dry run as a script error", async () => {
  const script = [
    'export const meta = { name: "v", description: "d" };',
    'phase("p", { budget: 0 });',
    "return 1;",
  ].join("\n");
  const report = await validateWorkflowScript(script);
  assert.equal(report.ok, false);
  assert.match(report.dryRun?.reason ?? "", /phase\(\) takes no options/);
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
