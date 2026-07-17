// Areas (2b)/(3b)/(4)/(5b)/(6)/(7): end-to-end run() against a MOCK ACP agent.
//
// No network and no real Claude/Codex: the runner spawns a fake ACP server (test/fixtures/
// fake-acp-agent.mjs) via the AGENTPRISM_*_ACP_CMD/ARGS spawn override. That fake speaks REAL
// ACP over stdio, so the runner's real fluent client() connection, draining, permission/usage/
// structured-output plumbing, and stopReason/throw mapping are all exercised; only the agent
// on the far end is faked. The fake appends every observed ACP request to a JSONL log so we
// can assert exactly what crossed the wire (clientInfo, _meta, permission outcomes).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { isWorkflowError, WorkflowErrorCode, type AgentUsage, type McpServerConfig } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness, waitFor } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

interface LogEntry {
  method: string;
  pid?: number;
  reason?: string;
  params?: {
    clientInfo?: unknown;
    _meta?: Record<string, unknown> | null;
    configId?: string;
    value?: string | boolean;
    type?: string;
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

test("Pi release-time child cleanup failure overrides success, primary error, and caller abort", async () => {
  const close = {
    throw: "child process cleanup failed",
    throwData: { errorKind: "child_cleanup_error", details: { remainingChildren: 1 } },
  };
  const expectCleanup = (error: unknown): boolean => {
    assert.ok(isWorkflowError(error));
    assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(error.recoverable, false);
    assert.equal(error.message, "child process cleanup failed");
    return true;
  };

  const success = harness.configure<LogEntry>({ turns: [{ text: "primary success", close }] }, { backends: ["pi"] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "pi", cwd: success.cwd }),
    expectCleanup,
  );

  const failed = harness.configure<LogEntry>({ turns: [{ throw: "primary failure", close }] }, { backends: ["pi"] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "pi", cwd: failed.cwd }),
    expectCleanup,
  );

  const aborted = harness.configure<LogEntry>({ turns: [{ waitForCancel: true, close }] }, { backends: ["pi"] });
  const controller = new AbortController();
  const running = makeRunner().run("hi", { model: "pi", cwd: aborted.cwd, signal: controller.signal });
  await waitFor(() => aborted.readLog().some((entry) => entry.method === "prompt"));
  controller.abort();
  await assert.rejects(() => running, expectCleanup);
});

test("runner disposal releases every interactive Pi session before reporting the first child cleanup failure", async () => {
  const configured = harness.configure<LogEntry>({
    close: {
      throw: "child process cleanup failed",
      throwData: { errorKind: "child_cleanup_error", details: { remainingChildren: 1 } },
    },
  }, { backends: ["pi"] });
  const runner = makeRunner();
  await runner.openSession({ model: "pi", cwd: configured.cwd });
  await runner.openSession({ model: "pi", cwd: configured.cwd });

  await assert.rejects(
    runner.dispose(),
    (error: { code?: unknown; data?: { errorKind?: unknown } }) =>
      error.code === -32603 && error.data?.errorKind === "child_cleanup_error",
  );
  const log = configured.readLog();
  assert.equal(log.filter((entry) => entry.method === "closeSession").length, 2);
  assert.equal(log.filter((entry) => entry.method === "__exit").length, 2);
});

// ---- (7) benign clientInfo at initialize --------------------------------------------

test("(7) sends benign clientInfo at initialize — NOT JetBrains/IntelliJ 2026.1", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "claude/claude-opus-4-1", cwd });

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

test("(4) structured provider wall => PROVIDER_USAGE_LIMIT with reset metadata", async () => {
  const live =
    "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.";
  const { cwd } = configure({
    turns: [{
      throw: live,
      throwData: { errorKind: "billing_error" },
      usageUpdate: {
        used: 10,
        size: 100,
        _meta: {
          "_claude/rateLimit": {
            status: "rejected",
            resetsAt: Date.parse("2026-07-15T09:00:00.000Z") / 1_000,
          },
        },
      },
    }],
  });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, label: "wall-agent" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err));
      assert.equal(err.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
      assert.equal(err.recoverable, false);
      assert.equal(err.message, live);
      assert.equal(err.resetHint, "Resets at 2026-07-15T09:00:00.000Z");
      assert.deepEqual(err.providerUsageLimitContext, {
        backendId: "claude",
        source: "provider",
        providerCode: "billing_error",
        resetAt: "2026-07-15T09:00:00.000Z",
      });
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
        model: "codex/gpt-5.6-luna",
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
    model: "codex/gpt-5.6-luna",
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

test("(2b) schema result is the FINAL assistant message — a schema-shaped progress message never wins", async () => {
  // Codex's turn-wide Responses constraint makes intermediate progress messages conform to the
  // schema too (field report). The turn below streams: progress JSON -> tool call -> final JSON.
  // Extraction must return the final object; a whole-turn first-JSON scan would return progress.
  const progress = JSON.stringify({ city: "progress-not-result", hot: false });
  const final = JSON.stringify({ city: "LA", hot: true });
  const { cwd } = configure({
    turns: [
      {
        updates: [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: progress } },
          { sessionUpdate: "tool_call", toolCallId: "tc-seg-1", title: "search the codebase", kind: "search", status: "in_progress" },
          { sessionUpdate: "tool_call_update", toolCallId: "tc-seg-1", status: "completed" },
        ],
        text: final,
      },
    ],
  });
  const out = await makeRunner().run("structured please", {
    model: "codex/gpt-5.6-luna",
    schema: SCHEMA,
    cwd,
  });
  assert.deepEqual(out, { city: "LA", hot: true });
});

// ---- (3b) Claude schema channel + structured_output read ----------------------------

test("(3b) Claude sets outputFormat+emitRawSDKMessages at session/new and reads structured_output", async () => {
  const { cwd, readLog } = configure({
    turns: [{ text: "Here is the result.", structuredOutput: { city: "LA", hot: false } }],
  });
  const resolved: string[] = [];
  const out = await makeRunner().run("weather?", {
    model: "claude/claude-opus-4-1",
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
        throwData: { errorKind: "rate_limit" },
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
        model: "codex/gpt-5.6-luna",
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
        model: "codex/gpt-5.6-luna",
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

// ---- model ids are sent verbatim; catalogs and bracket contents are opaque ----------------

test("a bracketed model id is sent verbatim and no sibling config option is touched", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      // Real codex-acp shape: model values are BARE base ids, effort is a SEPARATE select.
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });
  const resolved: string[] = [];
  const out = await makeRunner().run("hi", {
    model: "codex/gpt-5.6-luna[high]",
    cwd,
    onModelResolved: (m) => resolved.push(m),
  });
  assert.equal(out, "ok");
  assert.deepEqual(resolved, ["gpt-5.6-luna[high]"]);
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[high]");
});

test("(#147) an unprefixed bracketed model id is sent verbatim without driving effort", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "claude-fable-5",
        options: [{ value: "claude-fable-5", name: "Claude Fable 5" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
    turns: [{ text: "ok" }],
  });

  assert.equal(
    await makeRunner().run("hi", { model: "claude-fable-5[high]", cwd }),
    "ok",
  );
  const configCalls = readLog().filter((entry) => entry.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "claude-fable-5[high]");
  assert.equal(
    configCalls.filter((entry) => entry.params?.configId === "reasoning_effort").length,
    0,
  );
});

test("bracket tokens remain ordinary model-id characters even when matching options are advertised", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
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
  await makeRunner().run("hi", { model: "codex/gpt-5.6-luna[high fast]", cwd });
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[high fast]");
});

test("a boolean Fast-mode option is ignored during verbatim model selection", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      },
      {
        id: "fast-mode",
        type: "boolean",
        name: "Fast mode",
        category: "model_config",
        currentValue: false,
      },
    ],
    turns: [{ text: "ok" }],
  });
  const fallbacks: string[] = [];
  await makeRunner().run("hi", {
    model: "codex/gpt-5.6-luna[fast]",
    cwd,
    onModelFallback: (s) => fallbacks.push(s),
  });
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[fast]");
  assert.deepEqual(fallbacks, []);
});

test("catalog current values do not suppress the verbatim model request", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
      },
      {
        id: "fast-mode",
        type: "boolean",
        name: "Fast mode",
        category: "model_config",
        currentValue: true,
      },
    ],
    turns: [{ text: "ok" }],
  });
  await makeRunner().run("hi", { model: "codex/gpt-5.6-luna[fast]", cwd });
  const fastSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "fast-mode",
  );
  assert.equal(fastSet, undefined);
  const modelSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "model",
  );
  assert.equal(modelSet?.params?.value, "gpt-5.6-luna[fast]");
});

test("(#3) a plain effort spec does NOT touch a Fast-mode option that is advertised", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
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
  await makeRunner().run("hi", { model: "codex/gpt-5.6-luna[high]", cwd });
  const fastSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "fast-mode",
  );
  assert.equal(fastSet, undefined);
  const modelSet = readLog().find(
    (e) => e.method === "setSessionConfigOption" && e.params?.configId === "model",
  );
  assert.equal(modelSet?.params?.value, "gpt-5.6-luna[high]");
});

// ---- model resolution never emits fallback events ----------------------------------------

test("an unadvertised bracketed id is still sent verbatim without a fallback event", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
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
    model: "codex/gpt-5.6-luna[high]",
    cwd,
    onModelResolved: (m) => resolved.push(m),
    onModelFallback: (s) => fallbacks.push(s),
  });
  assert.equal(out, "ok");
  assert.deepEqual(resolved, ["gpt-5.6-luna[high]"]);
  assert.deepEqual(fallbacks, []);
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[high]");
});

test("advertised effort choices do not affect the model value or emit fallbacks", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
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
    model: "codex/gpt-5.6-luna[high]",
    cwd,
    onModelFallback: (s) => fallbacks.push(s),
  });
  assert.deepEqual(fallbacks, []);
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[high]");
});

test("an unadvertised Fast-mode token stays inside the id without a fallback event", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.6-luna",
        options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
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
    model: "codex/gpt-5.6-luna[high fast]",
    cwd,
    onModelFallback: (s) => fallbacks.push(s),
  });
  assert.deepEqual(fallbacks, []);
  const configCalls = readLog().filter((e) => e.method === "setSessionConfigOption");
  assert.equal(configCalls.length, 1);
  assert.equal(configCalls[0].params?.configId, "model");
  assert.equal(configCalls[0].params?.value, "gpt-5.6-luna[high fast]");
});

test("backend-only specs select no model for every built-in harness", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();
  for (const model of ["claude", "codex", "opencode", "pi"]) {
    assert.equal(await runner.run("hi", { model, cwd }), "ok");
  }
  assert.equal(readLog().filter((entry) => entry.method === "setSessionConfigOption").length, 0);
});

test("routing strips at most one segment and sends authored brackets, dots, and provider prefixes byte-for-byte", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const fallbacks: string[] = [];
  const runner = makeRunner();
  const cases = [
    ["claude/anthropic/claude.4[high]", "anthropic/claude.4[high]"],
    ["codex/openai/gpt.5[high]", "openai/gpt.5[high]"],
    ["opencode/zai/glm.5[max]", "zai/glm.5[max]"],
    ["pi/openrouter/vendor/model.5[max]", "openrouter/vendor/model.5[max]"],
    ["anthropic/claude.4[high]", "anthropic/claude.4[high]"],
    ["claude/codex/gpt.5[high]", "codex/gpt.5[high]"],
  ] as const;
  for (const [model] of cases) {
    assert.equal(
      await runner.run("hi", { model, cwd, onModelFallback: (spec) => fallbacks.push(spec) }),
      "ok",
    );
  }

  const calls = readLog().filter((entry) => entry.method === "setSessionConfigOption");
  assert.deepEqual(calls.map((entry) => entry.params?.configId), cases.map(() => "model"));
  assert.deepEqual(calls.map((entry) => entry.params?.value), cases.map(([, value]) => value));
  assert.deepEqual(fallbacks, []);
});

test("catalog order and content never affect the value sent for model selection", async () => {
  const catalogs = [
    [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "close-match",
        options: [
          { value: "prefix-target-suffix", name: "target" },
          { value: "target", name: "Exact display" },
        ],
      },
    ],
    [
      {
        id: "unrelated",
        type: "select",
        name: "Unrelated",
        category: "other",
        currentValue: "x",
        options: [{ value: "x", name: "X" }],
      },
    ],
  ];
  for (const configOptions of catalogs) {
    const { cwd, readLog } = configure({ configOptions, turns: [{ text: "ok" }] });
    const runner = makeRunner();
    await runner.run("hi", { model: "codex/Target.Model[HIGH]", cwd });
    await runner.dispose();
    const calls = readLog().filter((entry) => entry.method === "setSessionConfigOption");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params?.configId, "model");
    assert.equal(calls[0].params?.value, "Target.Model[HIGH]");
  }
});

test("set_config_option rejection follows the existing agent-error path with no retry or fallback", async () => {
  const { cwd, readLog } = configure({
    setConfigOptionError: "unknown model id",
    turns: [{ text: "must not run" }],
  });
  const fallbacks: string[] = [];
  const resolved: string[] = [];
  await assert.rejects(
    () =>
      makeRunner().run("hi", {
        model: "claude/rejected.model[high]",
        cwd,
        onModelResolved: (model) => resolved.push(model),
        onModelFallback: (spec) => fallbacks.push(spec),
      }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.equal(readLog().filter((entry) => entry.method === "setSessionConfigOption").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 0);
  assert.deepEqual(resolved, []);
  assert.deepEqual(fallbacks, []);
});

test("configOptions are sent verbatim after model selection in ascending option-id order", async () => {
  const { cwd, readLog } = configure({
    configOptions: [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "default-model",
        options: [{ value: "target-model", name: "Target" }],
      },
      {
        id: "reasoning_effort",
        type: "select",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "medium",
        options: [{ value: "high", name: "High" }],
      },
      {
        id: "fast_mode",
        type: "boolean",
        name: "Fast mode",
        category: "model_config",
        currentValue: false,
      },
      {
        id: "10",
        type: "select",
        name: "Ten",
        category: "other",
        currentValue: "old-ten",
        options: [{ value: "ten", name: "Ten" }],
      },
      {
        id: "2",
        type: "select",
        name: "Two",
        category: "other",
        currentValue: "old-two",
        options: [{ value: "two", name: "Two" }],
      },
    ],
    turns: [{ text: "ok" }],
  });

  assert.equal(
    await makeRunner().run("hi", {
      model: "claude/target-model",
      cwd,
      configOptions: {
        "2": "two",
        "10": "ten",
        reasoning_effort: "high",
        fast_mode: true,
      },
    }),
    "ok",
  );

  const wire = readLog().filter((entry) =>
    ["newSession", "setSessionConfigOption", "prompt"].includes(entry.method),
  );
  assert.deepEqual(wire.map((entry) => entry.method), [
    "newSession",
    "setSessionConfigOption",
    "setSessionConfigOption",
    "setSessionConfigOption",
    "setSessionConfigOption",
    "setSessionConfigOption",
    "prompt",
  ]);
  const configCalls = wire.filter((entry) => entry.method === "setSessionConfigOption");
  assert.deepEqual(configCalls.map((entry) => entry.params?.configId), [
    "model",
    "10",
    "2",
    "fast_mode",
    "reasoning_effort",
  ]);
  assert.deepEqual(configCalls.map((entry) => entry.params?.value), [
    "target-model",
    "ten",
    "two",
    true,
    "high",
  ]);
  assert.equal(configCalls[3].params?.type, "boolean");
  assert.equal(configCalls[4].params?.type, undefined);
});

test("configOptions rejection follows the existing agent-error path without retry or prompt", async () => {
  const { cwd, readLog } = configure({
    setConfigOptionError: "unknown config option",
    turns: [{ text: "must not run" }],
  });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "claude", cwd, configOptions: { invented: "value" } }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.equal(readLog().filter((entry) => entry.method === "newSession").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "setSessionConfigOption").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 0);
});

test("probeConfigOptions opens and closes exactly one session without sending a prompt", async () => {
  const advertised = [
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
    },
    {
      id: "fast_mode",
      type: "boolean",
      name: "Fast mode",
      category: "model_config",
      currentValue: false,
    },
  ];
  const { cwd, readLog } = configure({ configOptions: advertised });

  const probed = await makeRunner().probeConfigOptions("codex/ignored-for-probe", { cwd });

  assert.equal(probed.backendId, "codex");
  assert.deepEqual(probed.options, advertised);
  assert.equal(readLog().filter((entry) => entry.method === "newSession").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "closeSession").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 0);
  assert.equal(readLog().filter((entry) => entry.method === "setSessionConfigOption").length, 0);
});

test("probeConfigOptions propagates an authentication failure cleanly", async () => {
  const { cwd, readLog } = configure({ authRequiredOnNewSession: true });
  await assert.rejects(
    () => makeRunner().probeConfigOptions("claude", { cwd }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      return true;
    },
  );
  assert.equal(readLog().filter((entry) => entry.method === "newSession").length, 1);
  assert.equal(readLog().filter((entry) => entry.method === "prompt").length, 0);
});

test("probeConfigOptions propagates a spawn failure cleanly", async () => {
  const { cwd } = harness.configure<LogEntry>({}, {
    env: {
      AGENTPRISM_CLAUDE_ACP_CMD: "/definitely/missing/agentprism-acp-agent",
      AGENTPRISM_CLAUDE_ACP_ARGS: undefined,
    },
  });
  await assert.rejects(
    () => makeRunner().probeConfigOptions("claude", { cwd }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      return true;
    },
  );
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
    model: "claude/claude-opus-4-1",
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
    model: "codex/gpt-5.6-luna",
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
    model: "codex/gpt-5.6-luna",
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
    model: "codex/gpt-5.6-luna",
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
    model: "claude/claude-opus-4-1",
    cwd,
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });
  // No schema, no runId, and Claude has no instruction channel => no _meta at all.
  assert.equal(readLog().find((e) => e.method === "newSession")?.params?._meta ?? undefined, undefined);
});
