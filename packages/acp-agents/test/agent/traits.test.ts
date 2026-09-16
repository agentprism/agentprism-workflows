// Per-agent traits (src/traits.ts, `AcpAgent#traits`, `AcpAgent.traits()`): the table-based
// answer for every built-in checked field by field against the executable protocol-coverage
// tables, a custom registry backend's answer (its own declarations, never a shadowed built-in's
// rows), the live refinement through the fake agent's scripted initialize `_meta` (pi's bare
// `systemPrompt` block, the Codex fork's namespaced capability block, steering / loadedTurn), and
// the static never spawning anything.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { CODEX_CUSTOM_CAPABILITY_NAMESPACE, isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { Type } from "typebox";
import {
  ACP_EXTENSION_SUPPORT_MATRIX,
  AcpAgent,
  BUILTIN_BACKEND_IDS,
  ClaudeBackend,
  CustomAcpBackend,
  FORK_SESSION_TRAITS,
  FORK_SESSION_TRAIT_DEFAULT,
  LOADED_TURN_QUERY_METHOD,
  SESSION_STEERING_METHOD,
  builtinBackend,
  describeBackendTraits,
  promptUsageScope,
  resolveBackendRegistry,
  systemPromptSupport,
  type AcpAgentTraits,
  type BuiltinBackendId,
} from "../../src/index.js";
import { liveConnectionCount } from "../../src/agent/process-registry.js";
import { FAKE_AGENT_FIXTURE, createFakeAgentHarness, trackAgent, waitFor } from "../helpers/fake-agent.js";

interface LogEntry {
  method: string;
}

const harness = createFakeAgentHarness({ prefix: "acp-agent-traits-it-", backends: ["claude", "codex", "pi"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const track = (agent: AcpAgent): AcpAgent => trackAgent(harness, agent);

/** The concrete expectation per built-in, spelled out (not derived) so a table edit that changes a
 *  trait fails here and has to be acknowledged; the cross-check below proves the two agree. */
const EXPECTED: Record<BuiltinBackendId, Omit<AcpAgentTraits, "backendId" | "custom" | "promptUsage">> = {
  claude: {
    defaultModeId: "auto",
    fork: { agent: "claude", disposition: "id-only", reattach: "resume-or-load", cwd: "source-only", distProbe: "claude" },
    systemPrompt: { replace: true, append: true, source: "table" },
    steering: "supported",
    loadedTurn: "not-advertised",
    structuredOutput: "session-meta",
  },
  codex: {
    defaultModeId: "agent",
    fork: { agent: "codex", disposition: "id-only", reattach: "resume-or-load", cwd: "free", distProbe: "codex" },
    systemPrompt: { replace: true, append: true, source: "table" },
    steering: "supported",
    loadedTurn: "supported",
    structuredOutput: "turn-meta",
  },
  opencode: {
    defaultModeId: "build",
    fork: { agent: "opencode", disposition: "live", reattach: "none", cwd: "free" },
    systemPrompt: { replace: false, append: false, source: "table" },
    steering: "not-advertised",
    loadedTurn: "not-advertised",
    structuredOutput: "client-tool",
  },
  pi: {
    fork: { agent: "pi", disposition: "live", reattach: "none", cwd: "free", distProbe: "pi" },
    systemPrompt: { replace: true, append: true, source: "table" },
    steering: "supported",
    loadedTurn: "supported",
    structuredOutput: "client-tool",
  },
};

/** Any object schema: the structured channel is a property of the backend, not of the schema. */
const PROBE_SCHEMA = Type.Object({ ok: Type.Boolean() });

function extensionRow(agent: string, method: string): "supported" | "not-advertised" {
  const row = ACP_EXTENSION_SUPPORT_MATRIX.find((candidate) => candidate.agent === agent && candidate.method === method);
  assert.ok(row, `${agent} has a ${method} row`);
  return row.disposition;
}

function initializeWith(meta: {
  topLevel?: Record<string, unknown>;
  agentMeta?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      ...(meta.agentMeta ? { _meta: meta.agentMeta } : {}),
    },
    ...(meta.topLevel ? { _meta: meta.topLevel } : {}),
  };
}

afterEach(async () => {
  await harness.cleanup();
});

after(async () => {
  await waitFor(() => liveConnectionCount() === 0);
  assert.equal(liveConnectionCount(), 0);
});

test("AcpAgent.traits() answers every built-in from the tables, field by field, and spawns nothing", () => {
  const { readLog } = configure({});
  for (const id of BUILTIN_BACKEND_IDS) {
    const traits = AcpAgent.traits(id);
    const expected = EXPECTED[id];
    assert.equal(traits.backendId, id);
    assert.equal(traits.custom, false);
    assert.equal(traits.promptUsage, "turn");
    assert.deepEqual(
      { ...traits, backendId: undefined, custom: undefined, promptUsage: undefined },
      { ...expected, backendId: undefined, custom: undefined, promptUsage: undefined },
      `${id} traits`,
    );
    assert.equal("defaultModeId" in traits, expected.defaultModeId !== undefined, `${id} carries defaultModeId only when the backend pins one`);

    // The spelled-out expectation and the executable tables agree.
    const backend = builtinBackend(id)!;
    assert.equal(traits.defaultModeId, backend.defaultModeId);
    assert.strictEqual(traits.fork, FORK_SESSION_TRAITS.find((row) => row.agent === id), `${id} fork is the frozen table row itself`);
    assert.deepEqual({ replace: traits.systemPrompt.replace, append: traits.systemPrompt.append }, systemPromptSupport(id));
    assert.equal(traits.steering, extensionRow(id, SESSION_STEERING_METHOD));
    assert.equal(traits.loadedTurn, extensionRow(id, LOADED_TURN_QUERY_METHOD));
    assert.equal(traits.promptUsage, promptUsageScope(id));
    assert.equal(
      traits.structuredOutput,
      backend.injectStructuredOutputTool ? "client-tool" : backend.promptMeta(PROBE_SCHEMA) !== undefined ? "turn-meta" : "session-meta",
      `${id} structured channel follows the Backend object's behavior`,
    );

    assert.ok(Object.isFrozen(traits) && Object.isFrozen(traits.systemPrompt) && Object.isFrozen(traits.fork), `${id} traits are frozen`);
    assert.notStrictEqual(AcpAgent.traits(id), traits, "a fresh object per read");
  }
  // The routing grammar is the constructor's: a model spec routes by its first segment, and an
  // unrouted spec goes to the default backend (claude unless AGENTPRISM_DEFAULT_BACKEND says otherwise).
  assert.equal(AcpAgent.traits("codex/gpt-5.6-sol").backendId, "codex");
  assert.equal(AcpAgent.traits("pi/anthropic/claude-opus-4-1").backendId, "pi");
  assert.equal(AcpAgent.traits("Claude/opus[1m]").backendId, "claude");
  assert.equal(AcpAgent.traits().backendId, "claude");
  assert.equal(AcpAgent.traits("not-a-backend").backendId, "claude");

  // A malformed registry is INVALID_ARGUMENT, and nothing was ever spawned.
  assert.throws(
    () => AcpAgent.traits("x", { backends: { bad: {} as never } }),
    (error: unknown) => isWorkflowError(error) && error.code === WorkflowErrorCode.INVALID_ARGUMENT && /command/.test(error.message),
  );
  assert.deepEqual(readLog(), [], "the static never spawns");
  assert.equal(liveConnectionCount(), 0);
});

test("a custom registry backend reports its own declarations, never a shadowed built-in's rows", () => {
  const { readLog } = configure({});
  const command = { command: process.execPath, args: [FAKE_AGENT_FIXTURE] };

  const undeclared = AcpAgent.traits("wrapped", { backends: { wrapped: command } });
  assert.equal(undeclared.backendId, "wrapped");
  assert.equal(undeclared.custom, true);
  assert.equal(undeclared.defaultModeId, undefined);
  assert.equal("defaultModeId" in undeclared, false);
  assert.deepEqual(undeclared.fork, { ...FORK_SESSION_TRAIT_DEFAULT, agent: "wrapped" }, "an undeclared fork is the live/free default under the custom name");
  assert.deepEqual(undeclared.systemPrompt, { replace: false, append: false, source: "none" }, "no ACP system-prompt channel for a custom backend");
  assert.equal(undeclared.steering, "unknown");
  assert.equal(undeclared.loadedTurn, "unknown");
  assert.equal(undeclared.structuredOutput, "client-tool", "custom backends opt into the injected StructuredOutput tool by default");
  assert.equal(undeclared.promptUsage, "turn");

  const declared = AcpAgent.traits("wrapped/some-model", {
    backends: { wrapped: { ...command, fork: { disposition: "id-only", cwd: "source-only" }, structuredOutputTool: false } },
  });
  assert.deepEqual(declared.fork, { agent: "wrapped", disposition: "id-only", reattach: "resume-or-load", cwd: "source-only" }, "the declaration drives the fork row");
  assert.equal(declared.structuredOutput, "turn-meta", "with the tool disabled the schema rides the turn `_meta.outputSchema`");

  // A custom entry named like a built-in is a different program: custom, its own fork default,
  // no built-in extension row, no system-prompt channel.
  const shadow = AcpAgent.traits("claude", { backends: { claude: command } });
  assert.equal(shadow.custom, true);
  assert.equal(shadow.defaultModeId, undefined);
  assert.deepEqual(shadow.fork, { ...FORK_SESSION_TRAIT_DEFAULT, agent: "claude" });
  assert.equal(shadow.systemPrompt.source, "none");
  assert.equal(shadow.steering, "unknown");
  assert.equal(shadow.loadedTurn, "unknown");

  // The function behind the getter and the static, with the same registry rule.
  const registry = resolveBackendRegistry({ wrapped: command });
  const direct = describeBackendTraits(new CustomAcpBackend(registry.get("wrapped")!), registry);
  assert.deepEqual(direct, undeclared);
  const builtin = describeBackendTraits(new ClaudeBackend(), registry);
  assert.equal(builtin.custom, false);
  assert.equal(builtin.systemPrompt.source, "table");
  assert.deepEqual(readLog(), [], "nothing spawned");
});

test("the instance getter refines the tables with the live initialize advertisements (pi's bare systemPrompt block)", async () => {
  const { cwd } = configure({
    initialize: initializeWith({
      topLevel: {
        steering: { supported: true },
        loadedTurn: { supported: true },
        systemPrompt: { replace: true, append: false },
      },
    }),
    turns: [{ text: "ok" }],
  });
  const agent = track(new AcpAgent({ cwd, model: "pi" }));
  // Before open: the tables.
  assert.deepEqual(agent.traits, AcpAgent.traits("pi"));
  assert.equal(agent.traits.systemPrompt.source, "table");
  await agent.ready();
  const live = agent.traits;
  assert.deepEqual(live.systemPrompt, { replace: true, append: false, source: "advertised" }, "the advertisement wins over the table");
  assert.equal(live.steering, "supported");
  assert.equal(live.loadedTurn, "supported");
  // Everything the wire cannot change stays the table's / the Backend object's.
  assert.strictEqual(live.fork, AcpAgent.traits("pi").fork);
  assert.equal(live.structuredOutput, "client-tool");
  assert.equal(live.custom, false);
  assert.ok(Object.isFrozen(live) && Object.isFrozen(live.systemPrompt));
  await agent.close();
  assert.deepEqual(agent.traits, live, "retained after close");
});

test("the Codex fork's namespaced capability block is the advertisement on codex (baseInstructions => replace, developerInstructions => append)", async () => {
  const { cwd } = configure({
    initialize: initializeWith({
      agentMeta: {
        [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: { outputSchema: true, baseInstructions: false, developerInstructions: true },
      },
      topLevel: { steering: { supported: true } },
    }),
    turns: [{ text: "ok" }],
  });
  const agent = track(await AcpAgent.open({ cwd, model: "codex" }));
  const live = agent.traits;
  assert.deepEqual(live.systemPrompt, { replace: false, append: true, source: "advertised" });
  assert.equal(live.steering, "supported");
  assert.equal(live.loadedTurn, "not-advertised", "the block was not advertised on this connection");
  assert.equal(live.structuredOutput, "turn-meta");
});

test("an initialize without the blocks reports not-advertised extensions and the table's system-prompt row", async () => {
  const { cwd } = configure({ turns: [{ text: "ok" }] });
  const agent = track(await AcpAgent.open({ cwd, model: "claude" }));
  const live = agent.traits;
  assert.equal(live.steering, "not-advertised", "the table said supported; the live agent did not advertise it");
  assert.equal(live.loadedTurn, "not-advertised");
  assert.deepEqual(live.systemPrompt, { replace: true, append: true, source: "table" }, "Claude advertises nothing; the table stands");
  assert.equal(live.structuredOutput, "session-meta");
  assert.strictEqual(live.fork, FORK_SESSION_TRAITS.find((row) => row.agent === "claude"));

  // A Codex namespace block WITHOUT the instruction keys is not a system-prompt advertisement.
  await harness.cleanup();
  const second = configure({
    initialize: initializeWith({ agentMeta: { [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: { outputSchema: true } } }),
    turns: [{ text: "ok" }],
  });
  const codex = track(await AcpAgent.open({ cwd: second.cwd, model: "codex" }));
  assert.deepEqual(codex.traits.systemPrompt, { replace: true, append: true, source: "table" });
  assert.equal(codex.traits.steering, "not-advertised");
});
