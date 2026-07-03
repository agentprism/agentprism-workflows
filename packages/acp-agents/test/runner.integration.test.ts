// Areas (2b)/(3b)/(4)/(5b)/(6)/(7): end-to-end run() against a MOCK ACP agent.
//
// No network and no real Claude/Codex: the runner spawns a fake ACP server (test/fixtures/
// fake-acp-agent.mjs) via the AGENTPRISM_*_ACP_CMD/ARGS spawn override. That fake speaks REAL
// ACP over stdio, so the runner's real ClientSideConnection, draining, permission/usage/
// structured-output plumbing, and stopReason/throw mapping are all exercised; only the agent
// on the far end is faked. The fake appends every observed ACP request to a JSONL log so we
// can assert exactly what crossed the wire (clientInfo, _meta, permission outcomes).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode, type AgentUsage, type McpServerConfig } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

interface LogEntry {
  method: string;
  pid?: number;
  reason?: string;
  params?: {
    clientInfo?: unknown;
    _meta?: Record<string, unknown> | null;
    configId?: string;
    value?: string;
    mcpServers?: unknown;
  };
  outcome?: { outcome: string; optionId?: string };
}

const harness = createFakeAgentHarness({ prefix: "acp-it-", crashSentinel: true });

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

/** Point BOTH backends' spawn override at the fake agent and script its behavior. Backend
 *  selection is driven by the run()'s `model`, not these env vars. Returns a log reader. */
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

afterEach(async () => {
  // Dispose every runner this test built (closes its pooled processes) before clearing env.
  await harness.cleanup();
});

// ---- (7) benign clientInfo at initialize --------------------------------------------

test("(7) sends benign clientInfo at initialize — NOT JetBrains/IntelliJ 2026.1", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "anthropic/claude-opus-4-1", cwd });

  const init = readLog().find((e) => e.method === "initialize");
  assert.ok(init, "initialize was observed by the agent");
  assert.deepEqual(init.params?.clientInfo, {
    name: "agentprism-workflows",
    title: "AgentPrism Workflows",
    version: "0.1.0",
  });
  // The exact identity codex-acp disables its session config options for:
  const info = init.params?.clientInfo as { name: string; title: string; version: string };
  assert.doesNotMatch(info.name, /jetbrains|intellij/i);
  assert.doesNotMatch(info.title, /jetbrains|intellij/i);
  assert.notEqual(info.version, "2026.1");
});

// ---- (4) stopReason -> result/throw mapping -----------------------------------------

test("(4) no-schema completion returns the final assistant text; onHistory fires", async () => {
  const { cwd } = configure({ turns: [{ text: ["Hello, ", "world!"] }] });
  const history: unknown[][] = [];
  const out = await makeRunner().run("hi", {
    model: "claude",
    cwd,
    onHistory: (h) => history.push(h),
  });
  assert.equal(out, "Hello, world!"); // chunks concatenated, then trimmed
  assert.equal(history.length, 1);
  assert.ok(history[0].length >= 1, "history captured assistant chunks");
});

test("(4) empty no-schema output => AGENT_EMPTY_OUTPUT (recoverable)", async () => {
  const { cwd } = configure({ turns: [{ text: "   " }] }); // whitespace only -> trims to empty
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "empty-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      assert.equal(err.recoverable, true);
      assert.equal(err.agentLabel, "empty-agent");
      return true;
    },
  );
});

test("(4) provider wall (thrown) => PROVIDER_USAGE_LIMIT (non-recoverable, resetHint)", async () => {
  const { cwd } = configure({ turns: [{ throw: "Subscription usage limit reached. Resets in 2 hours." }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "wall-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(err.recoverable, false);
      assert.equal(err.resetHint, "Resets in 2 hours");
      assert.equal(err.agentLabel, "wall-agent");
      return true;
    },
  );
});

test("(4) a generic backend fault => recoverable AGENT_EXECUTION_ERROR", async () => {
  const { cwd } = configure({ turns: [{ throw: "ECONNRESET: the agent process died" }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, true);
      return true;
    },
  );
});

test("(4) schema never satisfied after the ladder => SCHEMA_NONCOMPLIANCE (non-recoverable)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "I am unable to produce JSON." }] });
  await assert.rejects(
    () =>
      makeRunner().run("give me json", {
        model: "openai/gpt-5-codex",
        schema: SCHEMA,
        cwd,
        maxSchemaRetries: 0, // no repair turns -> fail fast after the first turn
        label: "schema-agent",
      }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
      assert.equal(err.recoverable, false);
      assert.equal(err.agentLabel, "schema-agent");
      return true;
    },
  );
  // with maxSchemaRetries:0 exactly one prompt turn is sent
  assert.equal(readLog().filter((e) => e.method === "prompt").length, 1);
});

// ---- (2b) Codex schema forwarding via _meta -----------------------------------------

test("(2b) Codex forwards the strict schema via _meta[outputSchema] into the turn", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: JSON.stringify({ city: "NYC", hot: true }) }],
  });
  const out = await makeRunner().run("weather?", {
    model: "openai/gpt-5-codex",
    schema: SCHEMA,
    cwd,
  });
  assert.deepEqual(out, { city: "NYC", hot: true }); // codex native = JSON.parse(final message)

  const entries = readLog();
  const prompt = entries.find((e) => e.method === "prompt");
  const forwarded = prompt?.params?._meta?.["outputSchema"];
  // strict-normalized: every prop required + additionalProperties:false
  assert.deepEqual(forwarded, {
    type: "object",
    required: ["city", "hot"],
    properties: { city: { type: "string" }, hot: { type: "boolean" } },
    additionalProperties: false,
  });
  // Codex carries NOTHING at session/new (schema rides the turn)
  assert.equal(entries.find((e) => e.method === "newSession")?.params?._meta ?? undefined, undefined);
});

// ---- (3b) Claude schema channel + structured_output read ----------------------------

test("(3b) Claude sets outputFormat+emitRawSDKMessages at session/new and reads structured_output", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: "Here is the result.", structuredOutput: { city: "LA", hot: false } }],
  });
  const resolved: string[] = [];
  const out = await makeRunner().run("weather?", {
    model: "anthropic/claude-opus-4-1",
    schema: SCHEMA,
    cwd,
    onModelResolved: (m) => resolved.push(m),
  });
  // The value came from the raw _claude/sdkMessage structured_output, NOT the prose.
  assert.deepEqual(out, { city: "LA", hot: false });
  assert.deepEqual(resolved, ["claude-opus-4-1"]); // model selection round-tripped

  const newSession = readLog().find((e) => e.method === "newSession");
  const claudeCode = newSession?.params?._meta?.claudeCode as {
    options: { outputFormat: { type: string; schema: Record<string, unknown> } };
    emitRawSDKMessages: boolean;
  };
  assert.equal(claudeCode.options.outputFormat.type, "json_schema");
  assert.equal(claudeCode.emitRawSDKMessages, true);
  assert.deepEqual(claudeCode.options.outputFormat.schema.required, ["city", "hot"]);
  // Claude carries NOTHING on the turn (schema is session-scoped)
  assert.equal(readLog().find((e) => e.method === "prompt")?.params?._meta ?? undefined, undefined);
});

// ---- (5) permission allow/deny auto-response at request_permission -------------------

test("(5) deny-list denies the tool at request_permission; the run still completes", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Run Bash", kind: "execute" }, text: "done anyway" }],
  });
  const out = await makeRunner().run("do it", {
    model: "claude",
    cwd,
    disallowedToolNames: ["bash"],
  });
  assert.equal(out, "done anyway"); // a denied tool does not fail the run
  const outcome = readLog().find((e) => e.method === "permissionOutcome")?.outcome;
  assert.equal(outcome?.outcome, "selected");
  assert.equal(outcome?.optionId, "reject-1");
});

test("(5) default policy allows the tool at request_permission", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "read it" }],
  });
  const out = await makeRunner().run("do it", { model: "claude", cwd });
  assert.equal(out, "read it");
  const outcome = readLog().find((e) => e.method === "permissionOutcome")?.outcome;
  assert.equal(outcome?.optionId, "allow-1");
});

// ---- (6) usage_update -> onUsage on success AND error -------------------------------

test("(6) onUsage fires on SUCCESS with PromptResponse tokens + usage_update cost", async () => {
  const { cwd } = configure({
    turns: [
      {
        text: "ok",
        usageUpdate: { used: 42, size: 200000, cost: { amount: 0.07, currency: "USD" } },
        usage: {
          totalTokens: 42,
          inputTokens: 30,
          outputTokens: 12,
          cachedReadTokens: 3,
          cachedWriteTokens: 1,
        },
      },
    ],
  });
  const seen: AgentUsage[] = [];
  await makeRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    input: 30,
    output: 12,
    cacheRead: 3,
    cacheWrite: 1,
    total: 42,
    cost: 0.07,
  });
});

test("(6) onUsage fires on the ERROR path too, carrying the usage_update cost seen before the wall", async () => {
  const { cwd } = configure({
    turns: [
      {
        usageUpdate: { used: 10, size: 200000, cost: { amount: 0.03, currency: "USD" } },
        throw: "Usage limit reached. Resets in 1 hour.",
      },
    ],
  });
  const seen: AgentUsage[] = [];
  await assert.rejects(() => makeRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) }));
  assert.equal(seen.length, 1);
  // The prompt rejected (no PromptResponse.usage breakdown), but the usage_update streamed
  // before the wall carried BOTH a cost (0.03) and a token count (used:10) — total reflects
  // the reported tokens (no input/output split is available from usage_update alone).
  assert.deepEqual(seen[0], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.03 });
});

test("(6) onUsage tolerates usage === undefined: all-zero sentinel when nothing was reported", async () => {
  const { cwd } = configure({ turns: [{ throw: "ECONNRESET" }] }); // no usage_update, no PromptResponse
  const seen: AgentUsage[] = [];
  await assert.rejects(() => makeRunner().run("hi", { model: "claude", cwd, onUsage: (u) => seen.push(u) }));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
});

// ---- (#2) stop-reason -> distinct, non-recoverable failures --------------------------

test("(#2) stopReason 'refusal' => non-recoverable AGENT_EXECUTION_ERROR (NOT AGENT_EMPTY_OUTPUT)", async () => {
  const { cwd, readLog } = configure({ turns: [{ stopReason: "refusal" }] }); // no text => would be "empty"
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "refuser" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      // A refusal is a hard, deterministic failure — recoverable AGENT_EMPTY_OUTPUT would
      // re-run the refused prompt and burn the engine retry budget.
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.notEqual(err.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /refus/i);
      assert.equal(err.agentLabel, "refuser");
      return true;
    },
  );
  // Surfaced from the first turn; not retried.
  assert.equal(readLog().filter((e) => e.method === "prompt").length, 1);
});

test("(#2) refusal on a SCHEMA run is NOT burned through the repair ladder into SCHEMA_NONCOMPLIANCE", async () => {
  const { cwd, readLog } = configure({ turns: [{ stopReason: "refusal", text: "I will not." }] });
  await assert.rejects(
    () =>
      makeRunner().run("give me json", {
        model: "openai/gpt-5-codex",
        schema: SCHEMA,
        cwd,
        maxSchemaRetries: 3, // 3 repair turns WOULD fire if we entered the ladder
        label: "schema-refuser",
      }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR); // not SCHEMA_NONCOMPLIANCE
      assert.equal(err.recoverable, false);
      return true;
    },
  );
  assert.equal(readLog().filter((e) => e.method === "prompt").length, 1); // ladder never ran
});

test("(#2) stopReason 'max_tokens' => distinct 'output truncated' failure, even when the JSON parses", async () => {
  // The turn emits perfectly valid schema JSON, but it was TRUNCATED — we must surface that
  // distinctly, not silently accept a possibly-incomplete object.
  const { cwd, readLog } = configure({
    turns: [{ stopReason: "max_tokens", text: JSON.stringify({ city: "NYC", hot: true }) }],
  });
  await assert.rejects(
    () =>
      makeRunner().run("weather?", {
        model: "openai/gpt-5-codex",
        schema: SCHEMA,
        cwd,
        maxSchemaRetries: 3,
        label: "trunc",
      }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /truncat/i);
      assert.equal(err.agentLabel, "trunc");
      return true;
    },
  );
  assert.equal(readLog().filter((e) => e.method === "prompt").length, 1); // surfaced immediately
});

test("(#2) stopReason 'max_turn_requests' => 'output truncated' on a no-schema run", async () => {
  const { cwd } = configure({ turns: [{ stopReason: "max_turn_requests", text: "partial answer" }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /truncat/i);
      return true;
    },
  );
});

test("(#2) stopReason 'cancelled' => WORKFLOW_ABORTED", async () => {
  const { cwd } = configure({ turns: [{ stopReason: "cancelled", text: "partial" }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "cancelled-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    },
  );
});

test("(#2) normal stopReason 'end_turn' still returns the assistant text", async () => {
  const { cwd } = configure({ turns: [{ stopReason: "end_turn", text: "all good" }] });
  const out = await makeRunner().run("hi", { model: "claude", cwd });
  assert.equal(out, "all good");
});

// ---- (#3) reasoning_effort + Fast-mode driven from the model[effort] spec ------------

test("(#3) a model[effort] spec drives the reasoning_effort config option via set_config_option", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      // Real codex-acp shape: model values are BARE base ids, effort is a SEPARATE select.
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  const resolved: string[] = [];
  const out = await makeRunner().run("hi", {
    model: "openai/gpt-5.1-codex[high]",
    cwd,
    onModelResolved: (m) => resolved.push(m),
  });
  assert.equal(out, "ok");
  // The bracket strips off for the model select (matches the bare base id); the effort rides
  // the separate reasoning_effort option.
  assert.deepEqual(resolved, ["gpt-5.1-codex"]);

  const effortSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "reasoning_effort",
  );
  assert.ok(effortSet, "reasoning_effort was set via session/set_config_option");
  assert.equal(effortSet.params?.value, "high");
});

test("(#3) a `fast` bracket token turns the advertised Fast-mode option on", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "fast-mode",
        type: "select",
        name: "Fast mode",
        category: "fast-mode",
        currentValue: "off",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  await makeRunner().run("hi", { model: "openai/gpt-5.1-codex[high fast]", cwd });
  const fastSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "fast-mode",
  );
  assert.ok(fastSet, "fast-mode was set via session/set_config_option");
  assert.equal(fastSet.params?.value, "on");
});

test("(#3) a plain effort spec does NOT touch a Fast-mode option that is advertised", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "fast-mode",
        type: "select",
        name: "Fast mode",
        category: "fast-mode",
        currentValue: "off",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  await makeRunner().run("hi", { model: "openai/gpt-5.1-codex[high]", cwd });
  const fastSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "fast-mode",
  );
  assert.equal(fastSet, undefined, "no `fast` token => Fast-mode is left untouched");
});

// ---- (#4) effort/Fast fallback signal: an unadvertised modifier is SURFACED -----------

test("(#4) a model[high] whose 'high' effort is NOT advertised fires onModelFallback exactly once", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        // Deliberately MISSING "high".
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  const resolved: string[] = [];
  const fallbacks: string[] = [];
  const out = await makeRunner().run("hi", {
    model: "openai/gpt-5.1-codex[high]",
    cwd,
    onModelResolved: (m) => resolved.push(m),
    onModelFallback: (s) => fallbacks.push(s),
  });
  assert.equal(out, "ok");
  // The MODEL still resolved (the bare base id matched); only the effort tier could not apply.
  assert.deepEqual(resolved, ["gpt-5.1-codex"]);
  // The unmet effort is surfaced on the same channel model fallback uses — exactly once.
  assert.equal(fallbacks.length, 1, "the unadvertised 'high' effort fires onModelFallback once");
  assert.match(fallbacks[0], /reasoning_effort/i);
  assert.match(fallbacks[0], /high/);
  // It is a no-op, not a throw: reasoning_effort was never set on the wire.
  assert.equal(
    readLog().find((e) => e.method === "setSessionConfigOption" && e.params?.configId === "reasoning_effort"),
    undefined,
  );
});

test("(#4) an ADVERTISED effort applies cleanly and does NOT fire onModelFallback", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  const fallbacks: string[] = [];
  await makeRunner().run("hi", {
    model: "openai/gpt-5.1-codex[high]",
    cwd,
    onModelFallback: (s) => fallbacks.push(s),
  });
  // The effort applied -> no fallback signal.
  assert.deepEqual(fallbacks, []);
  const effortSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "reasoning_effort",
  );
  assert.equal(effortSet?.params?.value, "high");
});

test("(#4) an unadvertised Fast mode also surfaces on the fallback channel", async () => {
  const { cwd } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.1-codex",
        options: [{ value: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
      // No fast-mode option advertised.
    ],
    turns: [{ text: "ok" }],
  });
  const fallbacks: string[] = [];
  await makeRunner().run("hi", {
    model: "openai/gpt-5.1-codex[high fast]",
    cwd,
    onModelFallback: (s) => fallbacks.push(s),
  });
  // `high` applied (advertised); `fast` could not (no Fast-mode option) -> one fallback.
  assert.equal(fallbacks.length, 1);
  assert.match(fallbacks[0], /fast/i);
});

// ---- (#5) client-provided mcpServers reach session/new -------------------------------

test("(#5) RunOptions.mcpServers reach session/new mcpServers (stdio + http)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const mcpServers: McpServerConfig[] = [
    { name: "fs", command: "mcp-fs", args: ["--root", "/tmp"], env: [{ name: "TOKEN", value: "abc" }] },
    {
      type: "http",
      name: "remote",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer xyz" }],
    },
  ];
  await makeRunner().run("hi", { model: "claude", cwd, mcpServers });

  const newSession = readLog().find((e) => e.method === "newSession");
  assert.ok(newSession, "newSession was observed");
  assert.deepEqual(newSession.params?.mcpServers, mcpServers);
});

test("(#5) mcpServers defaults to [] at session/new when none is provided", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "claude", cwd });
  const newSession = readLog().find((e) => e.method === "newSession");
  assert.deepEqual(newSession?.params?.mcpServers, []);
});

// ---- (#5b) engine runId rides the session/new _meta as a correlation id ---------------

test("(#5b) RunOptions.runId is stamped onto session/new _meta[runId]", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "claude", cwd, runId: "run-abc123" });

  const entries = readLog();
  const newSession = entries.find((e) => e.method === "newSession");
  // No schema on this run, so the ONLY _meta is the correlation stamp.
  assert.deepEqual(newSession?.params?._meta, { runId: "run-abc123" });
  // It rides session/new, NOT the prompt turn.
  assert.equal(entries.find((e) => e.method === "prompt")?.params?._meta ?? undefined, undefined);
});

test("(#5b) runId coexists with the Claude schema _meta at session/new", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: "x", structuredOutput: { city: "LA", hot: false } }],
  });
  await makeRunner().run("weather?", {
    model: "anthropic/claude-opus-4-1",
    schema: SCHEMA,
    cwd,
    runId: "run-xyz",
  });
  const meta = readLog().find((e) => e.method === "newSession")?.params?._meta as Record<string, unknown>;
  // Both the vendor schema channel AND the correlation stamp are present.
  assert.equal(meta?.["runId"], "run-xyz");
  assert.ok(meta?.claudeCode, "the Claude schema _meta channel is preserved");
});

test("(#5b) Codex session/new carries the runId _meta even though the schema rides the turn", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: JSON.stringify({ city: "NYC", hot: true }) }],
  });
  await makeRunner().run("weather?", {
    model: "openai/gpt-5-codex",
    schema: SCHEMA,
    cwd,
    runId: "run-codex-1",
  });
  const entries = readLog();
  // Codex sends NO schema at session/new, but the runId stamp still rides it.
  assert.deepEqual(entries.find((e) => e.method === "newSession")?.params?._meta, {
    runId: "run-codex-1",
  });
  // The schema still rides the prompt turn (runId did not displace it).
  assert.ok(entries.find((e) => e.method === "prompt")?.params?._meta?.["outputSchema"]);
});

// ---- (#instr) Codex base/developer instructions ride session/new _meta as bare keys ---

test("(#instr) RunOptions base/developerInstructions reach Codex session/new _meta (bare keys)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", {
    model: "openai/gpt-5-codex",
    cwd,
    baseInstructions: "You only write Rust.",
    developerInstructions: "Prefer iterators.",
  });
  const newSession = readLog().find((e) => e.method === "newSession");
  // Bare keys (the codex-acp fork's contract).
  assert.deepEqual(newSession?.params?._meta, {
    baseInstructions: "You only write Rust.",
    developerInstructions: "Prefer iterators.",
  });
  // They ride session/new, NOT the prompt turn (no schema on this run => no prompt _meta).
  assert.equal(readLog().find((e) => e.method === "prompt")?.params?._meta ?? undefined, undefined);
});

test("(#instr) instructions coexist with the runId stamp at Codex session/new", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", {
    model: "openai/gpt-5-codex",
    cwd,
    runId: "run-xyz",
    baseInstructions: "BASE",
  });
  assert.deepEqual(readLog().find((e) => e.method === "newSession")?.params?._meta, {
    baseInstructions: "BASE",
    runId: "run-xyz",
  });
});

test("(#instr) Claude ignores base/developer instructions (no such _meta at session/new)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", {
    model: "anthropic/claude-opus-4-1",
    cwd,
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });
  // No schema, no runId, and Claude has no instruction channel => no _meta at all.
  assert.equal(readLog().find((e) => e.method === "newSession")?.params?._meta ?? undefined, undefined);
});
