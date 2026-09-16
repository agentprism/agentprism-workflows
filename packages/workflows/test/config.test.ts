// Tests for `agentprism-workflows config` (./src/config.ts + ./src/cli.ts): the standalone
// harness config-discovery sibling of validate. The programmatic probeHarnessConfig tests
// live with the catalog core in @automatalabs/acp-agents (test/config-catalog*.test.ts);
// what stays here is the human renderer and the CLI, spawned against the fake ACP agent
// fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatHarnessConfigReport } from "../src/config.js";
import {
  BUILTIN_BACKEND_IDS,
  type SessionConfigOption,
} from "@automatalabs/acp-agents";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const FAKE_AGENT = resolve(import.meta.dirname, "../../acp-agents/test/fixtures/fake-acp-agent.mjs");
const HERMETIC_PI_AGENT = resolve(import.meta.dirname, "../../pi-acp/test/fixtures/hermetic-pi-acp.mjs");
const HOME = mkdtempSync(join(tmpdir(), "automatalabs-workflows-config-"));

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

test("formatHarnessConfigReport renders validate's table format plus a probe summary", () => {
  const human = formatHarnessConfigReport({
    ok: false,
    exitCode: 1,
    harnessOptions: [
      { backendId: "claude", probed: true, modes: null, options: ADVERTISED_OPTIONS },
      { backendId: "codex", probed: false, error: "spawn failed" },
    ],
  });
  assert.match(human, /^advertised modes and config options:/);
  assert.match(human, /^  claude:$/m);
  assert.match(human, /^    modes: \(none advertised — omit mode\)$/m);
  assert.match(human, /^    config options:$/m);
  assert.match(human, /^    id \| name \| type \| current \| choices \| description$/m);
  assert.match(human, /^    model \| Model \| select \| "default-model" \| "default-model", "opus\[1m\]" \| $/m);
  assert.match(human, /^    reasoning_effort \| Reasoning effort \| select \| "medium" \| "low", "xhigh" \| $/m);
  assert.match(human, /^    fast_mode \| Fast mode \| boolean \| false \| true, false \| $/m);
  assert.match(human, /^  codex: probe failed — spawn failed$/m);
  assert.match(human, /^result: 1\/2 harness\(es\) probed$/m);
});

// ── CLI-level coverage against the fake ACP agent fixture. ──

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, "config", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME,
      AGENTPRISM_BACKENDS: undefined,
      AGENTPRISM_CLAUDE_ACP_CMD: process.execPath,
      AGENTPRISM_CLAUDE_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_CODEX_ACP_CMD: process.execPath,
      AGENTPRISM_CODEX_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_OPENCODE_ACP_CMD: process.execPath,
      AGENTPRISM_OPENCODE_ACP_ARGS: FAKE_AGENT,
      AGENTPRISM_PI_ACP_CMD: process.execPath,
      AGENTPRISM_PI_ACP_ARGS: FAKE_AGENT,
      ...env,
    },
  });
}

test("formatHarnessConfigReport preserves harness mode names, descriptions, metadata, and AgentPrism default", () => {
  const human = formatHarnessConfigReport({
    ok: true,
    exitCode: 0,
    harnessOptions: [{
      backendId: "codex",
      defaultModeId: "agent",
      probed: true,
      modes: {
        currentModeId: "read-only",
        availableModes: [{
          id: "agent",
          name: "Approve for me",
          description: "Only ask for actions detected as potentially unsafe",
          _meta: { kind: "auto_review" },
        }],
      },
      options: [],
    }],
  });
  assert.match(human, /current "read-only" \| AgentPrism default "agent"/);
  assert.match(human, /"agent" \| Approve for me \| Only ask for actions detected as potentially unsafe/);
  assert.match(human, /_meta=\{"kind":"auto_review"\}/);
});

test("CLI: no-arg config probes every built-in harness and exits 0", () => {
  const result = runCli(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.harnessOptions.map((harness: { backendId: string }) => harness.backendId),
    BUILTIN_BACKEND_IDS,
  );
  const model = report.harnessOptions[0].options.find((option: { id: string }) => option.id === "model");
  assert.ok(
    model.options.some((choice: { value: string }) => choice.value === "gpt-5.6-luna[high]"),
    "the fake agent's advertised model catalog is reported verbatim",
  );
});

test("C3 CLI: config pi executes the hermetic real-pi origin probe and exposes model choices", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, "config", "pi", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME,
      AGENTPRISM_BACKENDS: undefined,
      AGENTPRISM_PI_ACP_CMD: process.execPath,
      AGENTPRISM_PI_ACP_ARGS: HERMETIC_PI_AGENT,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    harnessOptions: Array<{ backendId: string; options: SessionConfigOption[] }>;
  };
  assert.equal(report.harnessOptions.length, 1);
  assert.equal(report.harnessOptions[0]?.backendId, "pi");
  assert.deepEqual(report.harnessOptions[0]?.options.map(({ id }) => id), ["thinkingLevel", "model"]);
  const thinking = report.harnessOptions[0]?.options[0];
  assert.equal(thinking?.type, "select");
  assert.deepEqual(
    thinking?.type === "select"
      ? thinking.options.flatMap((entry) => "options" in entry ? entry.options : [entry]).map(({ value }) => value)
      : [],
    ["off"],
  );
  const thinkingMeta = thinking?._meta?.["@automatalabs/agentprism"] as
    | { recognizedValues?: unknown }
    | undefined;
  const recognizedValues = thinkingMeta?.recognizedValues;
  assert.ok(Array.isArray(recognizedValues));
  assert.equal(recognizedValues.length, 7);
  assert.ok(recognizedValues.includes("max"));
  // pi advertises a large model catalog, so the serialized (--json) model option is
  // collapsed to a grouped summary rather than the full leaf list — the same bound that
  // keeps it out of the human table also keeps it out of --json (see
  // config-model-collapse.test.ts). The complete catalog is reachable via `--models`.
  const model = report.harnessOptions[0]?.options[1] as
    | { type: string; truncated?: boolean; options?: unknown[]; choiceSummary?: { total: number } }
    | undefined;
  assert.equal(model?.type, "select");
  assert.equal(model?.truncated, true);
  assert.equal(model?.options, undefined, "the huge leaf array is not serialized to --json");
  assert.ok((model?.choiceSummary?.total ?? 0) > 0, "the summary reports the catalog size");

  // …and the leaves stay reachable through the explicit --models path.
  const models = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, "config", "pi", "--models", "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME,
        AGENTPRISM_BACKENDS: undefined,
        AGENTPRISM_PI_ACP_CMD: process.execPath,
        AGENTPRISM_PI_ACP_ARGS: HERMETIC_PI_AGENT,
      },
    },
  );
  assert.equal(models.status, 0, models.stderr);
  const modelsReport = JSON.parse(models.stdout) as {
    harnessModels: Array<{ backendId: string; total?: number; groups?: unknown[] }>;
  };
  assert.equal(modelsReport.harnessModels[0]?.backendId, "pi");
  assert.ok((modelsReport.harnessModels[0]?.total ?? 0) > 0);
  assert.ok(Array.isArray(modelsReport.harnessModels[0]?.groups));
});

test("CLI: a named harness scopes the probe and renders the human table", () => {
  const result = runCli(["claude"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^advertised modes and config options:/);
  assert.match(result.stdout, /^  claude:$/m);
  assert.match(result.stdout, /"gpt-5\.6-luna\[high\]"/);
  assert.match(result.stdout, /^result: 1\/1 harness\(es\) probed$/m);
  assert.doesNotMatch(result.stdout, /codex|opencode/);
});

test("CLI: an env-registered custom backend is probeable by name and joins the defaults", () => {
  const env = { AGENTPRISM_BACKENDS: JSON.stringify({ browser: { command: process.execPath, args: [FAKE_AGENT] } }) };
  const named = runCli(["browser", "--json"], env);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(
    JSON.parse(named.stdout).harnessOptions.map((harness: { backendId: string }) => harness.backendId),
    ["browser"],
  );
  const all = runCli(["--json"], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(
    JSON.parse(all.stdout).harnessOptions.map((harness: { backendId: string }) => harness.backendId),
    ["claude", "codex", "opencode", "pi", "browser"],
  );
});

test("CLI: a harness that dies at spawn reports probed:false and exits 1", () => {
  const result = runCli(["claude", "--json"], {
    AGENTPRISM_CLAUDE_ACP_ARGS: undefined,
    AGENTPRISM_CLAUDE_ACP_CMD: "/nonexistent/acp-agent-binary",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.harnessOptions[0].probed, false);
  assert.equal(typeof report.harnessOptions[0].error, "string");
});

test("CLI: usage errors exit 3", () => {
  assert.equal(runCli(["--bogus"]).status, 3);
  assert.equal(runCli(["--timeout-ms", "soon"]).status, 3);
  assert.equal(runCli(["claude"], { AGENTPRISM_BACKENDS: "{not json" }).status, 3);
});
