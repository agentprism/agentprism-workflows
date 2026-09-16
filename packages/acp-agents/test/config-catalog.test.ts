// Programmatic tests for probeHarnessConfig (src/config-catalog.ts): default targets, the
// custom-backend registry, host-owned probe runners, model specs and failure reporting.
// Every probe goes through the package-internal probe-factory seam or a caller-supplied
// runner; the CLI-level coverage stays with the CLI in @automatalabs/workflows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHarnessConfig, setConfigProbeFactoryForTests } from "../src/config-catalog.js";
import { BUILTIN_BACKEND_IDS, type SessionConfigOption } from "../src/index.js";

const HOME = mkdtempSync(join(tmpdir(), "automatalabs-acp-agents-config-catalog-"));

process.on("exit", () => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const ADVERTISED_OPTIONS: SessionConfigOption[] = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "default-model",
    options: [
      { value: "default-model", name: "Default" },
      { value: "opus[1m]", name: "Opus (1M)" },
    ],
  },
  {
    id: "reasoning_effort",
    type: "select",
    name: "Reasoning effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "xhigh", name: "Xhigh" },
    ],
  },
  {
    id: "fast_mode",
    type: "boolean",
    name: "Fast mode",
    category: "model_config",
    currentValue: false,
  },
];

function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("default targets are the built-ins; catalogs and probe cwd flow through", async () => {
  const probes: Array<{ spec?: string; cwd?: string }> = [];
  let disposed = 0;
  const restore = setConfigProbeFactoryForTests((backends) => {
    assert.equal(backends, undefined);
    return {
      async probeConfigOptions(spec, opts) {
        probes.push({ spec, cwd: opts?.cwd });
        return {
          backendId: spec ?? "claude",
          options: ADVERTISED_OPTIONS,
          modes: {
            currentModeId: "default",
            availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
          },
        };
      },
      async dispose() {
        disposed++;
      },
    };
  });
  try {
    await withEnv("AGENTPRISM_BACKENDS", undefined, async () => {
      const report = await probeHarnessConfig({ cwd: HOME });
      assert.equal(report.ok, true);
      assert.equal(report.exitCode, 0);
      assert.deepEqual(probes.map((probe) => probe.spec), BUILTIN_BACKEND_IDS);
      assert.ok(probes.every((probe) => probe.cwd === HOME));
      assert.deepEqual(
        report.harnessOptions.map((harness) => harness.backendId),
        BUILTIN_BACKEND_IDS,
      );
      assert.ok(report.harnessOptions.every((harness) => harness.probed));
      assert.deepEqual(report.harnessOptions[0].options, ADVERTISED_OPTIONS);
      assert.deepEqual(report.harnessOptions[0].modes?.availableModes.map((mode) => mode.id), ["default", "plan"]);
      assert.equal(disposed, 1);
    });
  } finally {
    restore();
  }
});

test("registered custom backends join the default target list (env and programmatic)", async () => {
  const probes: string[] = [];
  const restore = setConfigProbeFactoryForTests((backends) => {
    assert.ok(backends?.visual, "programmatic backends reach the probe runner");
    return {
      async probeConfigOptions(spec) {
        probes.push(spec ?? "claude");
        return { backendId: spec ?? "claude", options: [] };
      },
      async dispose() {},
    };
  });
  try {
    await withEnv("AGENTPRISM_BACKENDS", JSON.stringify({ browser: { command: "browser-acp" } }), async () => {
      const report = await probeHarnessConfig({ backends: { visual: { command: "visual-acp" } } });
      assert.deepEqual(probes, [...BUILTIN_BACKEND_IDS, "browser", "visual"]);
      assert.equal(report.ok, true);
    });
  } finally {
    restore();
  }
});

test("a host-owned probe runner supplies default targets and is never disposed", async () => {
  let disposed = 0;
  const restore = setConfigProbeFactoryForTests(() => {
    throw new Error("owned probe factory must not be used");
  });
  const probeRunner = {
    listBackends: () => ["claude", "team"],
    async probeConfigOptions(spec?: string) {
      return { backendId: spec ?? "claude", options: ADVERTISED_OPTIONS };
    },
    async dispose() {
      disposed++;
    },
  };
  try {
    const report = await probeHarnessConfig({ probeRunner });
    assert.deepEqual(report.harnessOptions.map((harness) => harness.backendId), ["claude", "team"]);
    assert.equal(report.ok, true);
    assert.equal(disposed, 0, "the caller retains ownership of its live runner");
  } finally {
    restore();
  }
});

test("probeHarnessConfig passes custom backend definitions to a host-owned probe runner", async () => {
  const backends = { visual: { command: "visual-acp", args: ["serve"] } };
  let observed: unknown;
  const probeRunner = {
    async probeConfigOptions(spec?: string, options?: { backends?: unknown }) {
      observed = options?.backends;
      return { backendId: spec ?? "visual", options: [] };
    },
  };
  const report = await probeHarnessConfig({ harnesses: ["visual"], backends, probeRunner });
  assert.equal(report.ok, true);
  assert.deepEqual(observed, backends);
});

test("explicit harnesses replace the defaults and deduplicate in request order", async () => {
  const probes: string[] = [];
  const restore = setConfigProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      probes.push(spec ?? "claude");
      return { backendId: spec ?? "claude", options: [] };
    },
    async dispose() {},
  }));
  try {
    const report = await probeHarnessConfig({ harnesses: ["codex", "codex", "claude"] });
    assert.deepEqual(probes, ["codex", "claude"]);
    assert.deepEqual(
      report.harnessOptions.map((harness) => harness.backendId),
      ["codex", "claude"],
    );
  } finally {
    restore();
  }
});

test("modelSpecs select exact routed models and report model-specific catalogs", async () => {
  const probes: Array<{ spec?: string; selectModel?: boolean }> = [];
  const probeRunner = {
    async probeConfigOptions(spec?: string, options?: { selectModel?: boolean }) {
      probes.push({ spec, selectModel: options?.selectModel });
      return { backendId: spec?.split("/", 1)[0] ?? "claude", options: ADVERTISED_OPTIONS };
    },
  };
  const report = await probeHarnessConfig({
    modelSpecs: ["claude/opus[1m]", "codex/gpt"],
    probeRunner,
  });
  assert.deepEqual(probes, [
    { spec: "claude/opus[1m]", selectModel: true },
    { spec: "codex/gpt", selectModel: true },
  ]);
  assert.deepEqual(report.harnessOptions.map((harness) => harness.model), ["claude/opus[1m]", "codex/gpt"]);
});

test("a failing probe reports probed:false with the reason and flips the exit code only", async () => {
  const restore = setConfigProbeFactoryForTests(() => ({
    async probeConfigOptions(spec) {
      if (spec === "codex") throw new Error("login required by fake codex");
      return { backendId: spec ?? "claude", options: ADVERTISED_OPTIONS };
    },
    async dispose() {},
  }));
  try {
    const report = await probeHarnessConfig({ harnesses: ["claude", "codex"] });
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 1);
    assert.equal(report.harnessOptions[0].probed, true);
    assert.equal(report.harnessOptions[1].probed, false);
    assert.match(report.harnessOptions[1].error ?? "", /login required by fake codex/);
    assert.equal(report.harnessOptions[1].options, undefined);
  } finally {
    restore();
  }
});
