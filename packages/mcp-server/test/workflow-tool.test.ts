import test from "node:test";
import assert from "node:assert/strict";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { WorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";

import { workflowToolOutputShape } from "../src/workflow-tool-output.js";

import {
  connect,
  makeRunner,
  NO_AGENT_SCRIPT,
  okRunner,
  ONE_AGENT_SCRIPT,
  structured,
  textOf,
  throwingRunner,
} from "./_harness.js";

/** Read a nested field off an unknown object without `as any`. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const LIMITS = {
  maxAgents: 1_000,
  tokenBudget: null,
  concurrency: 6,
  agentRetries: 0,
  agentTimeoutMs: null,
} as const;
const ADMISSION_LOG =
  "agent timeout admission: host ceiling none total wall-clock per attempt; each retry re-arms the clock";

function inspectionFixture(status: "running" | "completed" | "aborted" = "running") {
  return {
    runId: "fixture-run",
    status,
    scriptUri: "workflow://runs/fixture-run/script",
    workflowName: "fixture",
    phases: [],
    limits: LIMITS,
    logTail: {
      lines: [],
      totalLines: 0,
      omittedLines: 0,
      truncatedLines: 0,
      redactedLines: 0,
    },
    calls: [],
    filter: { lastN: 10, logLines: 20 },
    truncation: {
      maxStructuredBytes: 24_576,
      byteCapApplied: false,
      phases: { total: 0, returned: 0, shortened: 0 },
      logs: { total: 0, returned: 0, shortened: 0, redacted: 0 },
      calls: { total: 0, matched: 0, returned: 0, shortenedResults: 0, redactedResults: 0 },
    },
    lineage: [
      { runId: "fixture-run", uri: "workflow://runs/fixture-run/script", available: true },
    ],
  };
}

const terminalOutcomeFixture = {
  runId: "fixture-run",
  status: "completed" as const,
  scriptUri: "workflow://runs/fixture-run/script",
  limits: LIMITS,
};

function outputVariantFixtures() {
  const inspection = inspectionFixture();
  const terminalAwait = {
    ...inspectionFixture("completed"),
    wait: { requestedMs: 100, elapsedMs: 5, returnedBecause: "terminal" as const },
    outcome: terminalOutcomeFixture,
  };
  const nonterminalAwait = {
    ...inspection,
    wait: { requestedMs: 100, elapsedMs: 5, returnedBecause: "timeout" as const },
    tokenUsage: { input: 1, output: 2, total: 3, cost: 0 },
  };
  const stop = {
    ...inspectionFixture("aborted"),
    stopped: true,
    alreadyTerminal: false,
  };
  const background = {
    runId: "fixture-run",
    status: "running" as const,
    scriptSource: "inline" as const,
    scriptUri: "workflow://runs/fixture-run/script",
    limits: LIMITS,
  };
  const execution = {
    ...terminalOutcomeFixture,
    scriptSource: "inline" as const,
  };
  const config = {
    action: "config" as const,
    ok: true,
    harnessOptions: [],
    omittedHarnesses: 0,
    models: [],
  };
  const rejected = {
    action: "run" as const,
    status: "rejected" as const,
    validation: {
      ok: false as const,
      exitCode: 1 as const,
      parse: { ok: false, error: "bad script" },
      warnings: [],
      omittedWarnings: 0,
    },
  };
  return { config, rejected, execution, background, inspection, terminalAwait, nonterminalAwait, stop };
}

// Engine-owned run id shape (run-persistence.generateRunId): `${base36ts}-${base36rand}`.
const RUN_ID = /^[a-z0-9]+-[a-z0-9]+$/;

test("tool registration: one `workflow` tool advertises config plus the run lifecycle union", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const { tools } = await client.listTools();
    // The model-facing surface is selective `docs`, `workflow`, and `repl` (the persistent
    // workspace tool), plus the app-only `workflow-events` poller (visibility
    // ["app"] — Apps hosts keep it out of the model's tool loop; see app-ui.ts).
    assert.deepEqual(
      tools.map((candidate) => candidate.name).sort(),
      ["docs", "repl", "workflow", "workflow-events"],
    );
    const tool = tools.find((candidate) => candidate.name === "workflow");
    assert.ok(tool, "the workflow tool is registered");
    assert.match(tool.description ?? "", /registry built-ins—currently Claude, Codex, OpenCode, and pi/);
    assert.match(tool.description ?? "", /action:\"config\"/);
    assert.match(tool.description ?? "", /automatically performs static validation, a mocked dry run, and routed config checks/);
    assert.match(tool.description ?? "", /Every parallel entry must be a thunk/);
    assert.match(tool.description ?? "", /phases must be an array of objects shaped `\{ title: string, detail\?: string, model\?: string \}`, never an array of strings/);
    assert.match(tool.description ?? "", /Minimal script:.*phases: \[\{ title: \"Review\" \}\].*phase\(\"Review\"\)/);
    assert.match(tool.description ?? "", /configOptions, schema, cwd, timeoutMs, retries/);
    assert.doesNotMatch(tool.description ?? "", /npx|CLI|shell out/i);

    assert.deepEqual(tool.inputSchema.required, undefined, "the raw shape leaves branch requirements to the discriminator");
    const inputProps = Object.keys(tool.inputSchema.properties ?? {});
    assert.ok(!inputProps.includes("startInBackground"), "startInBackground is not advertised");
    assert.ok(inputProps.includes("resumeFromRunId"), "explicit resume knob is advertised");
    assert.ok(inputProps.includes("resumePolicy"), "resume matching policy is advertised");
    assert.ok(inputProps.includes("action") && inputProps.includes("runId"), "inspection action fields are advertised");
    assert.ok(inputProps.includes("background") && inputProps.includes("waitMs"), "detached lifecycle fields are advertised");
    assert.ok(inputProps.includes("lastN") && inputProps.includes("labelGlob") && inputProps.includes("logLines"));
    assert.ok(inputProps.includes("checkpointReplies"), "durable checkpoint reply channel is advertised");
    assert.ok(inputProps.includes("concurrency") && inputProps.includes("agentRetries"));
    assert.ok(inputProps.includes("harnesses") && inputProps.includes("modelSpecs") && inputProps.includes("modelFilter") && inputProps.includes("probeTimeoutMs"));

    // The machine-readable output core includes structured pause contexts.
    assert.ok(tool.outputSchema, "an output schema is declared");
    const outProps = Object.keys(field(tool.outputSchema, "properties") ?? {});
    for (const k of [
      "runId",
      "status",
      "result",
      "tokenUsage",
      "logs",
      "authContext",
      "checkpointContext",
      "fallbacks",
      "checkpointsTaken",
      "resumeReport",
      "replayEligibility",
      "limits",
      "workflowName",
      "phases",
      "logTail",
      "calls",
      "filter",
      "truncation",
      "wait",
      "outcome",
      "action",
      "validation",
      "harnessOptions",
      "models",
    ]) {
      assert.ok(outProps.includes(k), `output schema exposes ${k}`);
    }
    assert.deepEqual(field(tool.outputSchema, "required"), undefined);
    const variants = field(tool.outputSchema, "oneOf") as Array<Record<string, unknown>>;
    assert.equal(variants.length, 7);
    assert.deepEqual(variants.map((variant) => variant.required), [
      ["action", "ok", "harnessOptions", "omittedHarnesses", "models"],
      ["action", "status", "validation"],
      ["runId", "status", "scriptUri", "scriptSource", "limits"],
      ["runId", "status", "scriptUri", "scriptSource", "limits"],
      ["runId", "status", "scriptUri", "workflowName", "phases", "logTail", "calls", "filter", "truncation", "lineage"],
      ["runId", "status", "scriptUri", "workflowName", "phases", "logTail", "calls", "filter", "truncation", "lineage", "wait"],
      [
        "runId",
        "status",
        "scriptUri",
        "workflowName",
        "phases",
        "logTail",
        "calls",
        "filter",
        "truncation",
        "lineage",
        "stopped",
        "alreadyTerminal",
      ],
    ]);
    const outcome = field(field(tool.outputSchema, "properties"), "outcome");
    assert.deepEqual(field(outcome, "required"), ["runId", "status", "scriptUri"]);
  } finally {
    await dispose();
  }
});

test("action=config discovers the live runner catalog without creating or executing a workflow", async () => {
  let agentRuns = 0;
  const probes: Array<{ spec?: string; selectModel?: boolean }> = [];
  const runner = Object.assign(
    makeRunner(() => {
      agentRuns += 1;
      return "unexpected";
    }),
    {
      listBackends: () => ["claude", "team"],
      async probeConfigOptions(spec?: string, options?: { selectModel?: boolean }) {
        probes.push({ spec, selectModel: options?.selectModel });
        const backendId = spec?.split("/", 1)[0] || "claude";
        return {
          backendId,
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
          options: [
            {
              id: "model",
              name: "Model",
              type: "select" as const,
              currentValue: "opus",
              options: [
                { value: "opus", name: "Opus" },
                { value: "sonnet", name: "Sonnet" },
              ],
            },
            {
              id: "fast",
              name: "Fast",
              type: "boolean" as const,
              currentValue: false,
            },
          ],
        };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: { action: "config", harnesses: ["claude"], modelFilter: "son" },
    });
    assert.notEqual(result.isError, true);
    const output = structured(result);
    assert.equal(output?.action, "config");
    assert.equal(output?.ok, true);
    assert.equal((output?.harnessOptions as unknown[]).length, 1);
    const discoveredHarness = (output?.harnessOptions as Array<Record<string, unknown>>)[0];
    assert.deepEqual(
      ((discoveredHarness?.modes as { availableModes: Array<{ id: string }> }).availableModes).map((mode) => mode.id),
      ["default", "plan"],
    );
    const models = output?.models as Array<Record<string, unknown>>;
    assert.deepEqual(models[0]?.matches, ["sonnet"]);
    assert.equal(agentRuns, 0, "config never calls AgentRunner.run");
    assert.equal(field(output, "runId"), undefined, "config creates no run ID");
    assert.match(textOf(result), /no workflow was started/);
    assert.match(textOf(result), /modes: current "default" \| advertised "default", "plan"/);

    const selected = await client.callTool({
      name: "workflow",
      arguments: { action: "config", modelSpecs: ["claude/opus"] },
    });
    assert.notEqual(selected.isError, true);
    const selectedHarness = (structured(selected)?.harnessOptions as Array<Record<string, unknown>>)[0];
    assert.equal(selectedHarness?.model, "claude/opus");
    assert.deepEqual(probes.at(-1), { spec: "claude/opus", selectModel: true });

    const probesBeforeInvalidFilter = probes.length;
    const invalidFilter = await client.callTool({
      name: "workflow",
      arguments: { action: "config", modelFilter: "/[/" },
    });
    assert.equal(invalidFilter.isError, true);
    assert.equal(probes.length, probesBeforeInvalidFilter, "invalid filters fail before opening probe sessions");
  } finally {
    await dispose();
  }
});

test("config discovery structured diagnostics stay within 24 KiB", async () => {
  const huge = "x".repeat(4_000);
  const runner = Object.assign(okRunner(), {
    listBackends: () => ["claude"],
    async probeConfigOptions() {
      return {
        backendId: "claude",
        options: Array.from({ length: 100 }, (_, index) => ({
          id: `option-${index}`,
          name: huge,
          type: "select" as const,
          currentValue: `value-${index}`,
          options: Array.from({ length: 30 }, (__, choice) => ({ value: `${huge}-${choice}`, name: huge })),
        })),
      };
    },
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({ name: "workflow", arguments: { action: "config" } });
    const output = structured(result);
    assert.ok(output);
    assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") <= 24_576);
    const harness = (output.harnessOptions as Array<Record<string, unknown>>)[0];
    assert.ok(Number(harness?.omittedOptions) > 0);
  } finally {
    await dispose();
  }
});

test("model-less MCP workflows auto-select and cache the first backend with positive readiness evidence", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND;
  const liveModels: Array<string | undefined> = [];
  const probes: Array<{ spec?: string; selectModel?: boolean }> = [];
  const modelOption = (currentValue: string, choices: string[] = [currentValue]) => ({
    id: "model",
    name: "Model",
    type: "select" as const,
    currentValue,
    options: choices.filter(Boolean).map((value) => ({ value, name: value })),
  });
  const runner = Object.assign(
    makeRunner((_prompt, options) => {
      liveModels.push(options.model);
      return "ok";
    }),
    {
      defaultBackendId: () => "claude",
      listBackends: () => ["claude", "codex", "opencode", "pi"],
      listCustomBackends: () => [],
      async probeConfigOptions(spec?: string, options?: { selectModel?: boolean }) {
        probes.push({ spec, selectModel: options?.selectModel });
        const backendId = spec?.split("/", 1)[0] ?? "claude";
        if (backendId === "opencode") throw new Error("opencode is not installed");
        if (backendId === "pi") return { backendId, options: [modelOption("", [])] };
        return {
          backendId,
          options: [modelOption(backendId === "codex" ? "gpt" : "opus")],
        };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const first = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.notEqual(first.isError, true);
    assert.deepEqual(liveModels, ["codex"]);
    assert.match(textOf(first), /auto-selected backend "codex"/);
    assert.match(textOf(first), /will not switch providers automatically/);
    assert.equal(probes.filter(({ spec }) => spec === "claude").length, 1);
    assert.equal(probes.filter(({ spec }) => spec === "opencode").length, 1);
    assert.equal(probes.filter(({ spec }) => spec === "pi").length, 1);
    assert.equal(probes.filter(({ spec }) => spec === "codex").length, 2, "discovery plus routed preflight");

    const second = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.notEqual(second.isError, true);
    assert.deepEqual(liveModels, ["codex", "codex"]);
    assert.equal(probes.filter(({ spec }) => spec === "claude").length, 1, "project discovery is cached");
    assert.equal(probes.filter(({ spec }) => spec === "opencode").length, 1);
    assert.equal(probes.filter(({ spec }) => spec === "pi").length, 1);
    assert.equal(probes.filter(({ spec }) => spec === "codex").length, 3, "only normal preflight repeats");
  } finally {
    await dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("a resumed MCP run inherits its source's pinned automatic backend instead of rediscovering", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND;
  const modelOption = (currentValue: string) => ({
    id: "model",
    name: "Model",
    type: "select" as const,
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  });
  const firstRunner = Object.assign(makeRunner(() => "source"), {
    defaultBackendId: () => "claude",
    listBackends: () => ["claude", "codex"],
    listCustomBackends: () => [],
    async probeConfigOptions(spec?: string) {
      const backendId = spec ?? "claude";
      return { backendId, options: [modelOption(backendId === "codex" ? "gpt" : "opus")] };
    },
  });
  const firstConnection = await connect(firstRunner, { listTools: true });
  let sourceRunId: string;
  try {
    const source = await firstConnection.client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.notEqual(source.isError, true);
    sourceRunId = String(structured(source)?.runId);
  } finally {
    await firstConnection.dispose();
  }

  const probes: string[] = [];
  const resumedRunner = Object.assign(makeRunner(() => "should replay"), {
    defaultBackendId: () => "claude",
    listBackends: () => ["pi"],
    listCustomBackends: () => [],
    async probeConfigOptions(spec?: string) {
      probes.push(spec ?? "claude");
      return { backendId: spec ?? "claude", options: [modelOption("default")] };
    },
  });
  const secondConnection = await connect(resumedRunner, { listTools: true });
  try {
    const resumed = await secondConnection.client.callTool({
      name: "workflow",
      arguments: { script: ONE_AGENT_SCRIPT, resumeFromRunId: sourceRunId! },
    });
    assert.notEqual(resumed.isError, true);
    assert.deepEqual(probes, ["codex"], "the inherited source backend receives only normal preflight");
    assert.match(textOf(resumed), /inherit pinned backend "codex" from the resume source/);
  } finally {
    await secondConnection.dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("an explicit AGENTPRISM_DEFAULT_BACKEND wins and skips automatic candidate discovery", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  process.env.AGENTPRISM_DEFAULT_BACKEND = "pi";
  const liveModels: Array<string | undefined> = [];
  const probes: string[] = [];
  const runner = Object.assign(
    makeRunner((_prompt, options) => {
      liveModels.push(options.model);
      return "ok";
    }),
    {
      defaultBackendId: () => "pi",
      listBackends: () => ["claude", "codex", "opencode", "pi"],
      async probeConfigOptions(spec?: string) {
        probes.push(spec ?? "claude");
        return { backendId: spec ?? "pi", options: [] };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(liveModels, ["pi"]);
    assert.deepEqual(probes, ["pi"], "only the normal routed preflight probes the explicit backend");
    assert.doesNotMatch(textOf(result), /auto-selected backend/);
  } finally {
    await dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("automatic default discovery rejects admission when every backend is definitely unavailable", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND;
  let liveCalls = 0;
  const runner = Object.assign(
    makeRunner(() => {
      liveCalls++;
      return "unexpected";
    }),
    {
      defaultBackendId: () => "claude",
      listBackends: () => ["claude", "codex", "pi"],
      async probeConfigOptions(spec?: string) {
        if (spec === "pi") {
          return {
            backendId: "pi",
            options: [{ id: "model", name: "Model", type: "select" as const, currentValue: "", options: [] }],
          };
        }
        throw new Error(`${spec} login required`);
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.equal(result.isError, true);
    assert.equal(structured(result), undefined, "no run or validation artifact is created");
    assert.equal(liveCalls, 0);
    assert.match(textOf(result), /No usable default ACP backend/);
    assert.match(textOf(result), /claude login required/);
    assert.match(textOf(result), /pi: session opened but/);
  } finally {
    await dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("fully pinned and agent-less workflows do not trigger automatic backend discovery", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND;
  const probes: string[] = [];
  const liveModels: Array<string | undefined> = [];
  const runner = Object.assign(
    makeRunner((_prompt, options) => {
      liveModels.push(options.model);
      return "ok";
    }),
    {
      defaultBackendId: () => "claude",
      listBackends: () => ["claude", "codex", "opencode", "pi"],
      async probeConfigOptions(spec?: string) {
        probes.push(spec ?? "claude");
        return { backendId: spec?.split("/", 1)[0] ?? "claude", options: [] };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const pinned = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "pinned", description: "d" };',
          'return agent("work", { label: "work", model: "pi" });',
        ].join("\n"),
      },
    });
    assert.notEqual(pinned.isError, true);
    assert.deepEqual(liveModels, ["pi"]);
    assert.deepEqual(probes, ["pi"], "the explicit call receives only its normal preflight probe");

    probes.length = 0;
    const deterministic = await client.callTool({ name: "workflow", arguments: { script: NO_AGENT_SCRIPT } });
    assert.notEqual(deterministic.isError, true);
    assert.deepEqual(probes, []);
  } finally {
    await dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("static routing discovery pins the default for a model-less branch the fabricated dry run does not reach", async () => {
  const previousDefault = process.env.AGENTPRISM_DEFAULT_BACKEND;
  delete process.env.AGENTPRISM_DEFAULT_BACKEND;
  const liveModels: Array<string | undefined> = [];
  const runner = Object.assign(
    makeRunner((_prompt, options) => {
      liveModels.push(options.model);
      return liveModels.length === 1 ? "take-live-branch" : "done";
    }),
    {
      defaultBackendId: () => "claude",
      listBackends: () => ["claude", "codex"],
      listCustomBackends: () => [],
      async probeConfigOptions(spec?: string) {
        const backendId = spec?.split("/", 1)[0] ?? "claude";
        return {
          backendId,
          options: [{
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: backendId === "codex" ? "gpt" : "opus",
            options: [{ value: backendId === "codex" ? "gpt" : "opus", name: "default" }],
          }],
        };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "hidden-default", description: "d" };',
          'const decision = await agent("decide", { label: "decide", model: "claude" });',
          'if (decision === "take-live-branch") return agent("hidden", { label: "hidden" });',
          'return "dry-path";',
        ].join("\n"),
      },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(liveModels, ["claude", "codex"]);
    assert.match(textOf(result), /auto-selected backend "codex"/);
  } finally {
    await dispose();
    if (previousDefault === undefined) delete process.env.AGENTPRISM_DEFAULT_BACKEND;
    else process.env.AGENTPRISM_DEFAULT_BACKEND = previousDefault;
  }
});

test("runtime and advertised output schemas enforce exact result branches", async () => {
  const fixtures = outputVariantFixtures();
  for (const [name, fixture] of Object.entries(fixtures)) {
    assert.equal(workflowToolOutputShape.safeParse(fixture).success, true, `${name} runtime fixture`);
  }

  const invalid = {
    "config with a run id": { ...fixtures.config, runId: "bad-run" },
    "config without models": (() => {
      const { models: _models, ...withoutModels } = fixtures.config;
      return withoutModels;
    })(),
    "rejection with a run id": { ...fixtures.rejected, runId: "bad-run" },
    "execution without limits": (() => {
      const { limits: _limits, ...withoutLimits } = fixtures.execution;
      return withoutLimits;
    })(),
    "background without limits": (() => {
      const { limits: _limits, ...withoutLimits } = fixtures.background;
      return withoutLimits;
    })(),
    "background with execution logs": { ...fixtures.background, logs: [] },
    "background with execution usage": {
      ...fixtures.background,
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0 },
    },
    "background with await outcome": { ...fixtures.background, outcome: terminalOutcomeFixture },
    "inspection with execution result": { ...fixtures.inspection, result: 42 },
    "inspection with execution usage": {
      ...fixtures.inspection,
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0 },
    },
    "inspection with await outcome": { ...fixtures.inspection, outcome: terminalOutcomeFixture },
    "stop with execution logs": { ...fixtures.stop, logs: [] },
    "stop with execution usage": {
      ...fixtures.stop,
      tokenUsage: { input: 1, output: 2, total: 3, cost: 0 },
    },
    "stop with await outcome": { ...fixtures.stop, outcome: terminalOutcomeFixture },
    "terminal await with top-level logs": { ...fixtures.terminalAwait, logs: [] },
    "terminal await without outcome": (() => {
      const { outcome: _outcome, ...withoutOutcome } = fixtures.terminalAwait;
      return withoutOutcome;
    })(),
    "nonterminal await with execution logs": { ...fixtures.nonterminalAwait, logs: [] },
    "nonterminal await with outcome": { ...fixtures.nonterminalAwait, outcome: terminalOutcomeFixture },
  };
  for (const [name, fixture] of Object.entries(invalid)) {
    assert.equal(workflowToolOutputShape.safeParse(fixture).success, false, `${name} runtime rejection`);
  }

  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const workflow = (await client.listTools()).tools.find((tool) => tool.name === "workflow");
    assert.ok(workflow?.outputSchema);
    const validate = new AjvJsonSchemaValidator().getValidator(
      workflow.outputSchema as JsonSchemaType,
    );
    for (const [name, fixture] of Object.entries(fixtures)) {
      assert.equal(validate(fixture).valid, true, `${name} advertised-schema fixture`);
    }
    for (const [name, fixture] of Object.entries(invalid)) {
      assert.equal(validate(fixture).valid, false, `${name} advertised-schema rejection`);
    }
  } finally {
    await dispose();
  }
});

test("foreground and await outcomes expose result observability while inspection status stays bounded", async () => {
  let sessions = 0;
  const runner = makeRunner((_prompt, options) => {
    options.onSessionOpen?.({
      sessionId: `observable-${sessions++}`,
      backendId: "codex",
      cwd: "/workspace",
      reopen: { load: true, resume: true, list: true },
    });
    options.onModelResolved?.("gpt-5.6-sol");
    options.onModelFallback?.("codex/gpt-5.6-sol");
    return "ok";
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const script = [
      'export const meta = { name: "result-observability", description: "result observability" };',
      'await agent("review", { label: "review", model: "codex/gpt-5.6-sol" });',
      'return await checkpoint("Release?", { kind: "select", choices: ["ship", "hold"], default: "hold" });',
    ].join("\n");

    const foreground = await client.callTool({ name: "workflow", arguments: { script } });
    const foregroundResult = structured(foreground);
    assert.equal((foregroundResult?.fallbacks as unknown[])?.length, 1);
    assert.deepEqual(foregroundResult?.checkpointsTaken, [
      { callIndex: 1, kind: "select", decision: "hold", source: "headless-default" },
    ]);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: String(foregroundResult?.runId) },
    });
    const status = structured(inspected);
    assert.equal(Object.hasOwn(status ?? {}, "fallbacks"), false);
    assert.equal(Object.hasOwn(status ?? {}, "checkpointsTaken"), false);

    const accepted = await client.callTool({ name: "workflow", arguments: { script, background: true } });
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId: String(structured(accepted)?.runId), waitMs: 1_000 },
    });
    const awaitResult = structured(awaited);
    assert.equal(Object.hasOwn(awaitResult ?? {}, "fallbacks"), false);
    assert.equal(Object.hasOwn(awaitResult ?? {}, "checkpointsTaken"), false);
    const outcome = field(awaitResult?.outcome, "fallbacks") as unknown[];
    assert.equal(outcome.length, 1);
    assert.deepEqual(field(awaitResult?.outcome, "checkpointsTaken"), [
      { callIndex: 1, kind: "select", decision: "hold", source: "headless-default" },
    ]);
  } finally {
    await dispose();
  }
});

test("run and inspect both validate after listTools caching; inspect is read-only and chronologically filtered", async () => {
  let calls = 0;
  const runner = makeRunner((prompt, options) => {
    calls++;
    options.onModelResolved?.("resolved/model");
    options.onSessionOpen?.({
      sessionId: `private-session-${calls}`,
      backendId: "actual-backend",
      cwd: "/private/cwd",
      reopen: { load: true, resume: true, list: true },
    });
    return { prompt, approved: !prompt.includes("two"), secret: "ghp_abcdefgh12345678" };
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const script = [
      'export const meta = { name: "inspection", description: "inspection", phases: [{ title: "Plan" }, { title: "Review" }] };',
      'phase("Plan");',
      'log("plan complete");',
      'await agent("one", { label: "plan-one" });',
      'phase("Review");',
      'await agent("two", { label: "review-two" });',
      'log("review complete");',
      'await agent("three", { label: "review-three" });',
      'return true;',
    ].join("\n");
    const run = await client.callTool({ name: "workflow", arguments: { action: "run", script } });
    const runStatus = structured(run);
    assert.equal(runStatus?.status, "completed");
    assert.equal(calls, 3);

    const inspected = await client.callTool({
      name: "workflow",
      arguments: {
        action: "inspect",
        runId: String(runStatus?.runId),
        lastN: 2,
        labelGlob: "review-*",
        logLines: 2,
      },
    });
    assert.equal(inspected.isError, false);
    assert.equal(calls, 3, "inspection never invokes the runner");
    const status = structured(inspected);
    assert.equal(status?.status, "completed");
    assert.equal(status?.workflowName, "inspection");
    assert.deepEqual(status?.phases, ["Plan", "Review"]);
    assert.ok((field(status?.logTail, "lines") as string[]).includes("review complete"));
    const projectedCalls = status?.calls as Array<Record<string, unknown>>;
    assert.deepEqual(projectedCalls.map((call) => call.index), [1, 2]);
    assert.deepEqual(projectedCalls.map((call) => call.label), ["review-two", "review-three"]);
    assert.ok(projectedCalls.every((call) => call.model === "resolved/model"));
    assert.ok(projectedCalls.every((call) => call.backendId === "actual-backend"));
    assert.ok(projectedCalls.every((call) => call.resultRedacted === true));
    assert.ok(!JSON.stringify(status).includes("private-session"));
  } finally {
    await dispose();
  }
});

test("inspecting a live run surfaces its in-flight agent calls", async () => {
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const runner = makeRunner((prompt) => (prompt === "hold" ? gate : `done:${prompt}`));
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const script = [
      'export const meta = { name: "live-inspect", description: "live inspect", phases: [{ title: "Work" }] };',
      'phase("Work");',
      'await agent("first", { label: "settled-agent" });',
      'await agent("hold", { label: "held-agent" });',
      'return true;',
    ].join("\n");
    const accepted = await client.callTool({ name: "workflow", arguments: { script, background: true } });
    const runId = String(structured(accepted)?.runId);

    // Wait until the held agent is actually in flight (its start is durable in the event log).
    let liveStatus: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const inspected = await client.callTool({ name: "workflow", arguments: { action: "inspect", runId } });
      assert.equal(inspected.isError, false);
      liveStatus = structured(inspected);
      const calls = (liveStatus?.calls as Array<Record<string, unknown>>) ?? [];
      if (calls.some((call) => call.label === "held-agent")) {
        assert.equal(liveStatus?.status, "running");
        const held = calls.find((call) => call.label === "held-agent");
        assert.equal(held?.status, "running");
        assert.equal(textOf(inspected).includes('[1] agent "held-agent" in Work: (running)'), true);
        break;
      }
      liveStatus = undefined;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(liveStatus, "a live inspection surfaced the in-flight agent call");

    release("held-done");
    const awaited = await client.callTool({
      name: "workflow",
      arguments: { action: "await", runId, waitMs: 10_000 },
    });
    assert.equal(structured(awaited)?.status, "completed");
    const settled = await client.callTool({ name: "workflow", arguments: { action: "inspect", runId } });
    const settledCalls = (structured(settled)?.calls as Array<Record<string, unknown>>) ?? [];
    assert.equal(settledCalls.length, 2);
    assert.ok(
      settledCalls.every((call) => call.status === undefined),
      "settled calls carry no in-flight status",
    );
  } finally {
    await dispose();
  }
});

test("unknown inspection is an exact tool error; inspecting a failed run is a successful read", async () => {
  const runner = throwingRunner(
    () => new WorkflowError("FAIL-CLOSED", WorkflowErrorCode.SCRIPT_ERROR, { recoverable: false }),
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const missing = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: "missing-run" },
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent, undefined);
    assert.equal(
      textOf(missing),
      'No workflow run found for runId "missing-run" in this server\'s project-scoped run store.',
    );

    const failed = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });
    assert.equal(failed.isError, true);
    const failedRun = structured(failed);
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId: String(failedRun?.runId) },
    });
    assert.equal(inspected.isError, false, "the read succeeds even when the run status is failed");
    assert.equal(structured(inspected)?.status, "failed");
    assert.equal(structured(inspected)?.reason, "FAIL-CLOSED");
  } finally {
    await dispose();
  }
});

test("inspection structured content is at most 24 KiB and text is at most 8 KiB", async () => {
  const large = "safe".repeat(1_000);
  const runner = makeRunner((prompt) => ({ prompt, large }));
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const phases = Array.from({ length: 70 }, (_, index) => ({ title: `phase-${index}-${"x".repeat(600)}` }));
    const script = [
      `export const meta = ${JSON.stringify({ name: "large", description: "large", phases })};`,
      'for (let i = 0; i < 50; i++) { phase(`dynamic-${i}-${"x".repeat(600)}`); log(`line-${i}-${"😀".repeat(1000)}`); await agent(`prompt-${i}`, { label: `call-${i}` }); }',
      'return true;',
    ].join("\n");
    const run = await client.callTool({ name: "workflow", arguments: { script } });
    assert.equal(structured(run)?.status, "completed");
    const runId = String(structured(run)?.runId);
    const inspected = await client.callTool({
      name: "workflow",
      arguments: { action: "inspect", runId, lastN: 50, logLines: 50 },
    });
    const status = structured(inspected);
    assert.ok(status);
    assert.ok(Buffer.byteLength(JSON.stringify(status), "utf8") <= 24_576);
    assert.ok(Buffer.byteLength(textOf(inspected), "utf8") <= 8_192);
    assert.equal(field(status?.truncation, "byteCapApplied"), true);
  } finally {
    await dispose();
  }
});

test("paused and failed terminal summaries carry redacted final-20 log tails and preserve status guidance", async () => {
  const token = "ghp_abcdefgh12345678";
  const logs = 'for (let i = 1; i <= 25; i++) log(i === 10 ? `line-${i} ghp_abcdefgh12345678` : `line-${i}`);';
  const runner = makeRunner((prompt) => {
    if (prompt === "fail") {
      throw new WorkflowError("boom", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    }
    return `ok:${prompt}`;
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const paused = await client.callTool({
      name: "workflow",
      arguments: {
        script: `export const meta = { name: "paused-tail", description: "paused" };\n${logs}\nawait checkpoint("q", { headless: "pause" });`,
      },
    });
    assert.equal(paused.isError, false);
    const pausedTail = field(structured(paused)?.logTail, "lines") as string[];
    assert.equal(pausedTail.length, 20);
    assert.equal(pausedTail[0], "line-6");
    assert.equal(pausedTail.at(-1), "line-25");
    assert.equal(pausedTail.some((line) => line.includes(token)), false);
    assert.match(textOf(paused), /recent run log \(last 20 of 26\):/);
    assert.match(textOf(paused), /\n  line-6\n/);
    assert.doesNotMatch(textOf(paused), /\n  line-[1-5]\n/);
    assert.doesNotMatch(textOf(paused), /ghp_/);
    assert.match(textOf(paused), /resumeFromRunId/);

    const failed = await client.callTool({
      name: "workflow",
      arguments: {
        script: `export const meta = { name: "failed-tail", description: "failed" };\n${logs}\nawait agent("fail");`,
      },
    });
    assert.equal(failed.isError, true);
    const failedTail = field(structured(failed)?.logTail, "lines") as string[];
    assert.equal(failedTail[0], "line-7");
    assert.match(textOf(failed), /recent run log \(last 20 of 27\):/);

    const empty = await client.callTool({
      name: "workflow",
      arguments: {
        script: 'export const meta = { name: "empty-tail", description: "empty" };\nawait agent("fail");',
      },
    });
    const emptyLines = field(structured(empty)?.logTail, "lines") as string[];
    assert.equal(emptyLines[0], ADMISSION_LOG);
    assert.equal(emptyLines.length, 2);
    assert.match(textOf(empty), /recent run log \(last 2 of 2\):/);
  } finally {
    await dispose();
  }
});

test("completed run -> isError:false, structuredContent is the WorkflowRunResult core (status completed)", async () => {
  // listTools:true caches the client-side output-schema validator, so a green result here
  // also proves the completed structuredContent VALIDATES against the advertised schema.
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, false, "a completed run is not an error");
    const sc = structured(res);
    assert.ok(sc, "structuredContent is mandatory when an outputSchema is declared");

    assert.equal(typeof sc.runId, "string");
    assert.match(String(sc.runId), RUN_ID, "the engine owns/stamps the run id");
    assert.equal(sc.status, "completed", "the engine stamped a terminal completed status");
    assert.equal(sc.result, "stub:hello", "result is the script's resolved value (raw agent text)");
    assert.ok(Array.isArray(sc.logs), "logs is a string array");

    // tokenUsage is schema-optional, but the engine always summarizes a completed run.
    const usage = sc.tokenUsage;
    assert.ok(usage && typeof usage === "object", "tokenUsage present for a completed run");
    assert.equal(typeof field(usage, "total"), "number");
    assert.equal(typeof field(usage, "input"), "number");

    // A human-readable text block accompanies the structured core.
    const text = textOf(res);
    assert.match(text, /completed/, "summary names the terminal status");
    assert.match(text, /agents:/, "summary reflects engine-computed run stats");
    assert.ok(text.includes(String(sc.runId)), "summary echoes the engine run id");
  } finally {
    await dispose();
  }
});

test("tool boundary: over-max concurrency/agentRetries are CLAMPED, not rejected with InvalidParams", async () => {
  const { client, dispose } = await connect(okRunner(), { listTools: true });
  try {
    // If the boundary rejected these, the SDK would surface an isError result whose text
    // begins "Input validation error: ...". Instead the run executes to completion.
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: NO_AGENT_SCRIPT, concurrency: 1000, agentRetries: 99 },
    });

    assert.equal(res.isError, false, "over-max knobs are accepted, not rejected");
    assert.doesNotMatch(textOf(res), /Input validation error/i, "no InvalidParams was raised");
    const sc = structured(res);
    assert.equal(sc?.status, "completed");
    assert.equal(sc?.result, 42, "the script ran with clamped knobs");
  } finally {
    await dispose();
  }
});

test("paused run -> shell does NOT throw: isError:false, status 'paused', resetHint + resume hint pass through", async () => {
  // A provider usage-limit is non-recoverable -> the engine checkpoints the run as PAUSED
  // (resumable) and resolves a terminal result; the shell projects it without throwing.
  // Regression (output-schema fix): listTools:true caches the client-side output-schema
  // validator, so a paused run with NO `result` (now `.optional()`) must still validate —
  // before the fix this threw McpError -32602 "must have required property 'result'".
  const runner = throwingRunner(
    () =>
      new WorkflowError("usage limit reached. Resets in ~3h", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
        recoverable: false,
        resetHint: "Resets in ~3h",
      }),
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, false, "paused is resumable, NOT an error");
    const sc = structured(res);
    assert.ok(sc);
    assert.equal(sc.status, "paused", "the engine stamped a paused status (shell did not derive it)");
    assert.match(String(sc.runId), RUN_ID);

    const text = textOf(res);
    assert.match(text, /paused/, "summary reports the paused status");
    assert.ok(text.includes("Resets in ~3h"), "the provider resetHint passes through verbatim");
    assert.ok(text.includes(String(sc.runId)) && text.includes("resumeFromRunId"), "summary tells the host how to resume");
  } finally {
    await dispose();
  }
});

test("failed run -> shell does NOT throw: returns isError:true with status 'failed' (engine-stamped)", async () => {
  // A non-recoverable, non-usage-limit failure -> the engine stamps status 'failed' and
  // runSync RESOLVES (does not reject); the handler maps failed -> isError:true. The shell
  // never throws on fail. Regression: listTools:true (output-schema fix — a failed run omits
  // `result`) AND the reason is the REAL error, not "Unhandled error" (the engine now persists/
  // releases the lease and guards the unheard 'error' emit, so the real WorkflowError propagates).
  const runner = throwingRunner(
    () => new WorkflowError("schema never satisfied", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false }),
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: ONE_AGENT_SCRIPT } });

    assert.equal(res.isError, true, "a failed run maps to isError:true");
    const sc = structured(res);
    assert.ok(sc, "a failed run still returns a structured terminal result (not a thrown error)");
    assert.equal(sc.status, "failed", "the engine stamped a failed status");
    assert.match(String(sc.runId), RUN_ID);

    const text = textOf(res);
    assert.match(text, /schema never satisfied/, "the failed run's reason is the REAL WorkflowError message");
    assert.ok(!/unhandled error/i.test(text), "the real error is not masked by ERR_UNHANDLED_ERROR");
  } finally {
    await dispose();
  }
});

test("automatic routed config validation rejects unknown options before the live runner executes", async () => {
  let realCalls = 0;
  let probes = 0;
  const runner = Object.assign(
    makeRunner(() => {
      realCalls += 1;
      return "real";
    }),
    {
      listBackends: () => ["claude"],
      async probeConfigOptions() {
        probes += 1;
        return {
          backendId: "claude",
          options: [
            { id: "fast", name: "Fast", type: "boolean" as const, currentValue: false },
          ],
        };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "bad-config", description: "must not admit" };',
          'return await agent("work", { label: "work", model: "claude", configOptions: { invented: true } });',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    const output = structured(result);
    assert.equal(output?.status, "rejected");
    assert.equal(field(output?.validation, "exitCode"), 2);
    assert.equal(output?.runId, undefined);
    assert.equal(probes, 1);
    assert.equal(realCalls, 0);
    assert.match(textOf(result), /invented/);
    assert.match(textOf(result), /advertised alternatives: option ids "fast"/);
  } finally {
    await dispose();
  }
});

test("automatic mode validation rejects a guessed default when the selected backend advertises no modes", async () => {
  let realCalls = 0;
  let probes = 0;
  const runner = Object.assign(
    makeRunner(() => {
      realCalls += 1;
      return "real";
    }),
    {
      listBackends: () => ["pi"],
      defaultBackendId: () => "pi",
      async probeConfigOptions() {
        probes += 1;
        return {
          backendId: "pi",
          modes: null,
          options: [{ id: "thinkingLevel", name: "Thinking", type: "select" as const, currentValue: "high", options: [{ value: "high", name: "High" }] }],
        };
      },
    },
  );
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const discovered = await client.callTool({
      name: "workflow",
      arguments: { action: "config", harnesses: ["pi"] },
    });
    const piHarness = (structured(discovered)?.harnessOptions as Array<Record<string, unknown>>)[0];
    assert.equal(piHarness?.modes, null, "config makes no-mode support explicit rather than omitting it");
    assert.match(textOf(discovered), /modes: \(none advertised — omit mode\)/);
    probes = 0;

    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "bad-mode", description: "must not admit" };',
          'return agent("work", { label: "pi-call", model: "pi/openai/model", mode: "default", configOptions: { thinkingLevel: "high" } });',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(structured(result)?.status, "rejected");
    assert.equal(probes, 1);
    assert.equal(realCalls, 0);
    assert.match(textOf(result), /mode authored value "default" is not advertised/);
    assert.match(textOf(result), /advertised modes: \(none advertised\)/);
    assert.doesNotMatch(textOf(result), /thinkingLevel.*unknown|offending key/);
  } finally {
    await dispose();
  }
});

test("unknown workflow agent option keys reject before config probing or admission", async () => {
  let realCalls = 0;
  let probes = 0;
  const runner = Object.assign(makeRunner(() => {
    realCalls += 1;
    return "real";
  }), {
    async probeConfigOptions() {
      probes += 1;
      return { backendId: "claude", modes: null, options: [] };
    },
  });
  const { client, dispose } = await connect(runner, { listTools: true });
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        script: [
          'export const meta = { name: "foreign-options", description: "must not admit" };',
          'return agent("work", { label: "pi-call", backend: "pi", model: "openai/model", config: { thinkingLevel: "high" } });',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    assert.equal(structured(result)?.status, "rejected");
    assert.equal(probes, 0);
    assert.equal(realCalls, 0);
    assert.match(textOf(result), /agent "pi-call" options contain unknown keys "backend", "config"/);
  } finally {
    await dispose();
  }
});

test("mocked dry-run failure is rejected before real agent execution or background admission", async () => {
  let realCalls = 0;
  const { client, dispose } = await connect(makeRunner(() => {
    realCalls += 1;
    return "real";
  }), { listTools: true });
  try {
    const result = await client.callTool({
      name: "workflow",
      arguments: {
        background: true,
        script: [
          'export const meta = { name: "preflight-failure", description: "must not admit" };',
          'await agent("mock-only", { label: "mock-only" });',
          'throw new Error("dry-run boom");',
        ].join("\n"),
      },
    });
    assert.equal(result.isError, true);
    const output = structured(result);
    assert.equal(output?.status, "rejected");
    assert.equal(output?.runId, undefined);
    assert.equal(field(output?.validation, "exitCode"), 2);
    assert.equal(realCalls, 0, "the live AgentRunner is never invoked");
    assert.match(textOf(result), /dry-run boom/);
    assert.match(textOf(result), /No run was created/);
  } finally {
    await dispose();
  }
});

test("malformed script is rejected with structured pre-admission diagnostics and no run ID", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const res = await client.callTool({ name: "workflow", arguments: { script: 'await agent("hi");' } });

    assert.equal(res.isError, true, "a parse failure is a tool error");
    const output = structured(res);
    assert.equal(output?.action, "run");
    assert.equal(output?.status, "rejected");
    assert.equal(output?.runId, undefined, "pre-admission rejection creates no run ID");
    assert.equal(field(output?.validation, "exitCode"), 1);
    assert.match(textOf(res), /must be the first statement in the script/, "the parse error explains the meta requirement");
    assert.match(textOf(res), /No run was created/);
  } finally {
    await dispose();
  }
});

test("malformed script (meta present but invalid) -> isError:true with the validation message", async () => {
  const { client, dispose } = await connect(okRunner());
  try {
    const res = await client.callTool({
      name: "workflow",
      arguments: { script: 'export const meta = { description: "missing a name" };\nreturn 1;' },
    });

    assert.equal(res.isError, true);
    const output = structured(res);
    assert.equal(output?.status, "rejected");
    assert.equal(output?.runId, undefined);
    assert.equal(field(output?.validation, "exitCode"), 1);
    assert.match(textOf(res), /meta\.name must be a non-empty string/, "meta validation rejects a nameless workflow");
  } finally {
    await dispose();
  }
});
