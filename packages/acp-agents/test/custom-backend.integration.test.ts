// End-to-end: the fake ACP agent (test/fixtures/fake-acp-agent.mjs) registered as a CUSTOM
// backend — not via the built-in spawn overrides. Proves the registry path spawns arbitrary
// commands with registry env, that generic RunOptions.meta / promptMeta reach the wire with
// the documented precedence (defaults < user meta < protocol-critical keys < runId), that a
// bare registered name skips model selection while "name/inner" selects "inner", and that
// structured output round-trips through the generic dialect (turn-level _meta.outputSchema
// in, final-text JSON out).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { META_KEYS } from "@automatalabs/shared-types";
import { AcpAgentRunner, BACKENDS_ENV, type CustomBackendConfig } from "../src/index.js";
import { createFakeAgentHarness, FAKE_AGENT_FIXTURE, readLog as readLogFile } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

interface LogEntry {
  method: string;
  params?: {
    _meta?: Record<string, unknown> | null;
    configId?: string;
    value?: string;
    cwd?: string;
    prompt?: Array<{ type: string; text?: string }>;
  };
}

function promptTextOf(entry: LogEntry | undefined): string {
  return (entry?.params?.prompt ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

const TEST_ENV_VARS = [BACKENDS_ENV, "AGENTPRISM_DEFAULT_BACKEND"];
const harness = createFakeAgentHarness({ prefix: "acp-custom-it-" });

afterEach(async () => {
  await harness.cleanup();
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

/** Build a registry config that spawns the fake agent, scripting it via the REGISTRY env
 *  field (exercising the env-merge path — the fixture reads its scenario from process env). */
function fakeBackend(scenario: unknown, extra?: Partial<CustomBackendConfig>): {
  config: CustomBackendConfig;
  cwd: string;
  readLog: () => LogEntry[];
} {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-custom-it-"));
  const log = path.join(dir, "log.jsonl");
  return {
    config: {
      command: process.execPath,
      args: [FAKE_AGENT_FIXTURE],
      env: {
        AGENTPRISM_FAKE_SCENARIO: JSON.stringify(scenario),
        AGENTPRISM_FAKE_LOG: log,
      },
      ...extra,
    },
    cwd: dir,
    readLog: () => readLogFile<LogEntry>(log),
  };
}

function makeRunner(backends: Record<string, CustomBackendConfig>): AcpAgentRunner {
  return harness.makeRunner({ backends });
}

test("custom backend: routes by registered name, spawns the registry command, returns text", async () => {
  const { config, cwd, readLog } = fakeBackend({ turns: [{ text: "hello from custom" }] });
  const out = await makeRunner({ fake: config }).run("hi", { model: "fake", cwd });

  assert.equal(out, "hello from custom");
  const log = readLog();
  assert.ok(log.some((e) => e.method === "initialize"), "the registry-spawned agent served the run");
  const newSession = log.find((e) => e.method === "newSession");
  assert.equal(newSession?.params?.cwd, cwd, "per-session cwd reached the custom agent");
  // Bare registered name is ROUTING, not a model id: no model selection was attempted.
  assert.ok(!log.some((e) => e.method === "setSessionConfigOption"), "no setSessionConfigOption for a bare name");
});

test("custom backend: session _meta layers defaults < RunOptions.meta < runId stamp", async () => {
  const { config, cwd, readLog } = fakeBackend(
    { turns: [{ text: "ok" }] },
    { sessionMeta: { allowedDomains: ["default.example.com"], mode: "verify" } },
  );
  await makeRunner({ fake: config }).run("hi", {
    model: "fake",
    cwd,
    meta: { allowedDomains: ["preview.example.com"], credsRef: "vault://qa-user", runId: "user-loses" },
    runId: "run-e2e-1",
  });

  const meta = readLog().find((e) => e.method === "newSession")?.params?._meta;
  assert.ok(meta, "session/new carried _meta");
  // Per-call meta overrides the registry's static default…
  assert.deepEqual(meta.allowedDomains, ["preview.example.com"]);
  // …while non-conflicting default keys and user keys both survive…
  assert.equal(meta.mode, "verify");
  assert.equal(meta.credsRef, "vault://qa-user");
  // …and the engine's runId stamp wins over a user attempt at the reserved key.
  assert.equal(meta[META_KEYS.runId], "run-e2e-1");
});

test("custom backend: 'name/inner' selects the inner model; promptMeta + outputSchema ride the turn", async () => {
  const { config, cwd, readLog } = fakeBackend({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "default-model",
        options: [
          { value: "vision-large", name: "Vision Large" },
          { value: "default-model", name: "Default" },
        ],
      },
    ],
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });
  const resolved: string[] = [];
  const out = await makeRunner({ fake: config }).run("classify", {
    model: "fake/vision-large",
    cwd,
    schema: SCHEMA,
    promptMeta: { viewport: "1280x800", [META_KEYS.outputSchema]: "user-loses" },
    onModelResolved: (id) => resolved.push(id),
  });

  assert.deepEqual(out, { city: "Oslo", hot: false }, "generic-dialect structured output validated");
  assert.deepEqual(resolved, ["vision-large"], "the inner model (after the routing name) was selected");
  const log = readLog();
  const select = log.find((e) => e.method === "setSessionConfigOption");
  assert.equal(select?.params?.value, "vision-large");
  const promptMeta = log.find((e) => e.method === "prompt")?.params?._meta;
  assert.ok(promptMeta, "session/prompt carried _meta");
  assert.equal(promptMeta.viewport, "1280x800", "generic turn-scoped meta reached the wire");
  const outputSchema = promptMeta[META_KEYS.outputSchema] as Record<string, unknown>;
  assert.equal(typeof outputSchema, "object", "backend-computed outputSchema won over the user key");
  assert.ok((outputSchema.properties as Record<string, unknown>).city, "…and is the real JSON schema");
});

test("custom backend: schema runs EMBED the JSON Schema in the prompt text (agent may ignore the meta)", async () => {
  // A custom agent that ignores _meta.outputSchema can only satisfy the contract if the
  // schema is STATED in the prompt — the opencode e2e found exactly this failure (valid JSON,
  // invented keys, ladder never converges). Pin the belt-and-braces behavior.
  const { config, cwd, readLog } = fakeBackend({ turns: [{ text: '{"city":"Oslo","hot":false}' }] });
  await makeRunner({ fake: config }).run("classify", { model: "fake", cwd, schema: SCHEMA });

  const promptText = promptTextOf(readLog().find((e) => e.method === "prompt"));
  assert.match(promptText, /required output schema \(JSON Schema\)/i, "the contract names the embedded schema");
  assert.ok(promptText.includes('"city"') && promptText.includes('"hot"'), "the schema keys are stated in the prompt");
});

test("builtin backends: schema runs do NOT embed the schema in the prompt (native channel is authoritative)", async () => {
  const { cwd, readLog } = harness.configure<LogEntry>({
    turns: [{ structuredOutput: { city: "Oslo", hot: false }, text: "done" }],
  });
  await makeRunner({}).run("classify", { model: "claude", cwd, schema: SCHEMA });
  const promptText = promptTextOf(readLog().find((e) => e.method === "prompt"));
  assert.match(promptText, /Final output contract/, "the generic contract text is still present");
  assert.doesNotMatch(promptText, /required output schema \(JSON Schema\)/i, "no embedded schema for built-ins");
});

test("custom backend: registers via AGENTPRISM_BACKENDS env and serves as the default backend", async () => {
  const { config, cwd, readLog } = fakeBackend({ turns: [{ text: "env-registered" }] });
  process.env[BACKENDS_ENV] = JSON.stringify({ envfake: config });
  process.env.AGENTPRISM_DEFAULT_BACKEND = "envfake";
  // No `backends` option and NO model on the run: env registration + env default route it.
  const runner = harness.track(new AcpAgentRunner());

  const out = await runner.run("hi", { cwd });
  assert.equal(out, "env-registered");
  assert.ok(readLog().some((e) => e.method === "prompt"), "the env-registered agent served the run");
});

test("run-level backends (RunOptions.backends): route without any constructor/env registration", async () => {
  const { config, cwd, readLog } = fakeBackend({ turns: [{ text: "run-scoped" }] });
  // NO backends option, NO env: the registry arrives per-run (an approved meta.backends).
  const out = await makeRunner({}).run("hi", { model: "fake", cwd, backends: { fake: config } });
  assert.equal(out, "run-scoped");
  assert.ok(readLog().some((e) => e.method === "prompt"), "the run-declared agent served the call");
});

test("run-level backends: host registration WINS over a run-declared config of the same name", async () => {
  const host = fakeBackend({ turns: [{ text: "from-host" }] });
  const run = fakeBackend({ turns: [{ text: "from-run" }] });
  const out = await makeRunner({ fake: host.config }).run("hi", {
    model: "fake",
    cwd: host.cwd,
    backends: { fake: run.config },
  });
  assert.equal(out, "from-host", "the host-registered command served the call");
  assert.equal(run.readLog().length, 0, "the run-declared command was never spawned");
});

test("run-level backends: SAME name with DIFFERENT configs never share a pooled process", async () => {
  const first = fakeBackend({ turns: [{ text: "one" }] });
  const second = fakeBackend({ turns: [{ text: "two" }] });
  const runner = makeRunner({});
  assert.equal(await runner.run("a", { model: "fake", cwd: first.cwd, backends: { fake: first.config } }), "one");
  assert.equal(await runner.run("b", { model: "fake", cwd: second.cwd, backends: { fake: second.config } }), "two");
  // Each config logged its own __start: two distinct processes, keyed by spawn-config hash.
  const firstPids = first.readLog().filter((e) => e.method === "__start");
  const secondPids = second.readLog().filter((e) => e.method === "__start");
  assert.equal(firstPids.length, 1, "first config spawned exactly one process");
  assert.equal(secondPids.length, 1, "second config spawned its OWN process (no pool collision)");
});

test("run-level backends: malformed/reserved declarations fail NON-RECOVERABLY with a clear message", async () => {
  await assert.rejects(
    makeRunner({}).run("hi", { model: "x", backends: { claude: { command: "x" } } }),
    (error: Error & { recoverable?: boolean }) => /reserved/.test(error.message) && error.recoverable === false,
  );
});

test("initialize handshake: a non-ACP command fails fast with a legible error (and is killed)", async () => {
  process.env.AGENTPRISM_ACP_INIT_TIMEOUT_MS = "1500";
  try {
    const started = Date.now();
    await assert.rejects(
      makeRunner({ notacp: { command: "sleep", args: ["60"] } }).run("hi", { model: "notacp" }),
      /did not complete the ACP initialize handshake within 1500ms/,
    );
    assert.ok(Date.now() - started < 15_000, "failed fast, not after a long hang");
  } finally {
    delete process.env.AGENTPRISM_ACP_INIT_TIMEOUT_MS;
  }
});

test("builtin backends: generic meta/promptMeta merge under the protocol-critical channels", async () => {
  // The fake serves the CLAUDE spawn override here — proving the passthrough also works for
  // built-ins and never clobbers the Claude schema channel.
  const { cwd, readLog } = harness.configure<LogEntry>({
    turns: [{ structuredOutput: { city: "Oslo", hot: false }, text: "done" }],
  });
  const out = await makeRunner({}).run("classify", {
    model: "claude",
    cwd,
    schema: SCHEMA,
    meta: { experiment: "A", claudeCode: "user-loses" },
  });
  assert.deepEqual(out, { city: "Oslo", hot: false });
  const meta = readLog().find((e) => e.method === "newSession")?.params?._meta;
  assert.ok(meta, "session/new carried _meta");
  assert.equal(meta.experiment, "A", "generic session meta reached the wire");
  const claudeCode = meta.claudeCode as { options?: { outputFormat?: unknown } };
  assert.ok(claudeCode?.options?.outputFormat, "the Claude schema channel won over the user key");
});
