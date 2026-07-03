// End-to-end ACP capability negotiation against a MOCK ACP agent whose initialize response is
// scripted per test (test/fixtures/fake-acp-agent.mjs honors scenario.initialize). Proves the real
// ClientSideConnection negotiates the handshake and then GATES what it sends on what the agent
// advertised: the @automatalabs/codex-acp custom `_meta` keys (session/new instruction overrides +
// the turn-level outputSchema forward), the MCP transports, and the protocol version — while a
// legacy agent that advertises nothing keeps today's send-everything behavior.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Type } from "typebox";
import {
  CODEX_CUSTOM_CAPABILITY_NAMESPACE,
  CODEX_META_KEYS,
  META_KEYS,
  isWorkflowError,
  WorkflowErrorCode,
  type McpServerConfig,
} from "@automatalabs/shared-types";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const SCHEMA = Type.Object({ city: Type.String(), hot: Type.Boolean() });

interface LogEntry {
  method: string;
  params?: {
    clientCapabilities?: {
      fs?: { readTextFile?: boolean; writeTextFile?: boolean } | null;
      terminal?: boolean;
    };
    protocolVersion?: number;
    _meta?: Record<string, unknown> | null;
    mcpServers?: Array<{ name: string; type?: string }>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-cap-it-" });
const { makeRunner } = harness;

/** Point BOTH backends' spawn override at the fake agent and script its behavior (including the
 *  scenario.initialize the negotiation reads). Returns a log reader. */
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

/** A capable initialize response that also advertises the fork's custom-capability namespace with
 *  the given per-key flags. session/close stays advertised so sessions release cleanly. */
function forkInitialize(flags: Record<string, boolean>): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: {} },
      _meta: { [CODEX_CUSTOM_CAPABILITY_NAMESPACE]: flags },
    },
  };
}

function newSessionMeta(log: LogEntry[]): Record<string, unknown> {
  return (log.find((e) => e.method === "newSession")?.params?._meta ?? {}) as Record<string, unknown>;
}

function promptMeta(log: LogEntry[]): Record<string, unknown> {
  return (log.find((e) => e.method === "prompt")?.params?._meta ?? {}) as Record<string, unknown>;
}

afterEach(async () => {
  await harness.cleanup();
});

// ---- clientCapabilities: truthful (empty) ------------------------------------------

test("initialize advertises NO client capabilities (we implement no fs/terminal methods)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", { model: "codex", cwd });

  const init = readLog().find((e) => e.method === "initialize");
  assert.ok(init, "initialize was observed");
  // We send `clientCapabilities: {}`; the SDK expands it to explicit falses on the wire. Either
  // way NOTHING is advertised as supported — truthful, since MultiplexClient implements none of
  // the fs/terminal methods (a client must advertise only what it implements).
  const caps = init.params?.clientCapabilities ?? {};
  assert.notEqual(caps.fs?.readTextFile, true, "fs.readTextFile not advertised");
  assert.notEqual(caps.fs?.writeTextFile, true, "fs.writeTextFile not advertised");
  assert.notEqual(caps.terminal, true, "terminal not advertised");
  assert.equal(init.params?.protocolVersion, PROTOCOL_VERSION);
});

// ---- legacy agent: no advertisement => send everything (back-compat) ----------------

test("legacy agent (no custom namespace): Codex instruction overrides ride session/new unchanged", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  await makeRunner().run("hi", {
    model: "codex",
    cwd,
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });

  const meta = newSessionMeta(readLog());
  assert.equal(meta[CODEX_META_KEYS.baseInstructions], "BASE", "no advertisement => key still sent");
  assert.equal(meta[CODEX_META_KEYS.developerInstructions], "DEV");
});

test("legacy agent (no custom namespace): the Codex outputSchema forward rides session/prompt", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: '{"city":"Oslo","hot":false}' }] });
  const out = await makeRunner().run("classify", { model: "codex", cwd, schema: SCHEMA });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.ok(promptMeta(readLog())[META_KEYS.outputSchema], "no advertisement => outputSchema still forwarded");
});

// ---- advertising agent: gate each key on its flag -----------------------------------

test("advertising agent: drops the un-advertised session/new instruction key, keeps the advertised one", async () => {
  const { cwd, readLog } = configure({
    initialize: forkInitialize({ baseInstructions: true, developerInstructions: false }),
    turns: [{ text: "ok" }],
  });
  await makeRunner().run("hi", {
    model: "codex",
    cwd,
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });

  const meta = newSessionMeta(readLog());
  assert.equal(meta[CODEX_META_KEYS.baseInstructions], "BASE", "advertised true => sent");
  assert.equal(CODEX_META_KEYS.developerInstructions in meta, false, "advertised false => dropped");
});

test("advertising agent (outputSchema:false): suppresses the turn-level outputSchema forward", async () => {
  const { cwd, readLog } = configure({
    initialize: forkInitialize({ outputSchema: false }),
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });
  const out = await makeRunner().run("classify", { model: "codex", cwd, schema: SCHEMA });

  // The run still resolves (the runner's validate/extract ladder reads the final JSON), but the
  // schema forward the agent said it does not honor never crossed the wire.
  assert.deepEqual(out, { city: "Oslo", hot: false });
  assert.equal(META_KEYS.outputSchema in promptMeta(readLog()), false, "un-advertised => suppressed");
});

test("advertising agent (outputSchema:true): still forwards the turn-level outputSchema", async () => {
  const { cwd, readLog } = configure({
    initialize: forkInitialize({ outputSchema: true }),
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });
  await makeRunner().run("classify", { model: "codex", cwd, schema: SCHEMA });

  assert.ok(promptMeta(readLog())[META_KEYS.outputSchema], "advertised true => forwarded");
});

// ---- MCP transport gating -----------------------------------------------------------

const SSE_SERVER: McpServerConfig = { type: "sse", name: "sse-mcp", url: "https://x", headers: [] };
const HTTP_SERVER: McpServerConfig = { type: "http", name: "http-mcp", url: "https://x", headers: [] };

test("MCP gate: an sse server against an agent advertising sse:false fails fast, non-recoverably", async () => {
  const { cwd } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, mcpCapabilities: { http: true, sse: false } },
    },
    turns: [{ text: "ok" }],
  });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, mcpServers: [SSE_SERVER], label: "sse-run" }),
    (err: unknown) => {
      assert.ok(isWorkflowError(err), "typed WorkflowError");
      assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(err.recoverable, false);
      assert.match(err.message, /sse-mcp/);
      assert.match(err.message, /sse.+transport.+does not support/i);
      return true;
    },
  );
});

test("MCP gate: an advertised (http) transport reaches session/new", async () => {
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, mcpCapabilities: { http: true, sse: false } },
    },
    turns: [{ text: "ok" }],
  });
  await makeRunner().run("hi", { model: "codex", cwd, mcpServers: [HTTP_SERVER] });

  const servers = readLog().find((e) => e.method === "newSession")?.params?.mcpServers ?? [];
  assert.ok(servers.some((s) => s.name === "http-mcp"), "http server reached the wire");
});

test("MCP gate: legacy agent (no mcpCapabilities) passes an sse server through unchanged", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] }); // default init: no mcpCapabilities
  await makeRunner().run("hi", { model: "codex", cwd, mcpServers: [SSE_SERVER] });

  const servers = readLog().find((e) => e.method === "newSession")?.params?.mcpServers ?? [];
  assert.ok(servers.some((s) => s.name === "sse-mcp"), "no advertisement => no gating");
});

// ---- published fork 1.2.0: the REAL initialize response (verbatim) -------------------

/** The exact initialize response the published @automatalabs/codex-acp 1.2.0 returns (verified
 *  against the installed dist and a live stdio handshake): standard capabilities advertised
 *  (mcpCapabilities http-only), NO custom `_meta` namespace. The two gates are independent — the
 *  custom-meta gate must stay on its legacy passthrough while the MCP gate is simultaneously
 *  ACTIVE. */
const FORK_1_2_0_INITIALIZE = {
  protocolVersion: 1,
  agentInfo: { name: "@automatalabs/codex-acp", title: "Codex", version: "1.2.0" },
  agentCapabilities: {
    auth: { logout: {} },
    loadSession: true,
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, additionalDirectories: {} },
    mcpCapabilities: { acp: false, http: true, sse: false },
  },
  authMethods: [
    {
      id: "api-key",
      name: "API Key",
      description: "Use an API key to authenticate",
      _meta: { "api-key": { provider: "openai" } },
    },
    { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" },
  ],
};

test("published fork 1.2.0 (no custom namespace): overrides + outputSchema still ride unchanged", async () => {
  const { cwd, readLog } = configure({
    initialize: FORK_1_2_0_INITIALIZE,
    turns: [{ text: '{"city":"Oslo","hot":false}' }],
  });
  const out = await makeRunner().run("classify", {
    model: "codex",
    cwd,
    schema: SCHEMA,
    baseInstructions: "BASE",
    developerInstructions: "DEV",
  });

  assert.deepEqual(out, { city: "Oslo", hot: false });
  const log = readLog();
  const meta = newSessionMeta(log);
  assert.equal(meta[CODEX_META_KEYS.baseInstructions], "BASE", "no namespace => legacy passthrough");
  assert.equal(meta[CODEX_META_KEYS.developerInstructions], "DEV");
  assert.ok(promptMeta(log)[META_KEYS.outputSchema], "the turn-level outputSchema forward is untouched");
});

test("published fork 1.2.0: the MCP gate is simultaneously active (sse:false IS advertised)", async () => {
  const { cwd } = configure({ initialize: FORK_1_2_0_INITIALIZE, turns: [{ text: "ok" }] });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd, mcpServers: [SSE_SERVER] }),
    (err: unknown) => isWorkflowError(err) && err.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
});

// ---- protocol version negotiation ---------------------------------------------------

test("protocol version: an agent that selects an unsupported version closes with a legible error", async () => {
  const { cwd } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION + 1,
      agentCapabilities: { sessionCapabilities: { close: {} } },
    },
    turns: [{ text: "ok" }],
  });
  await assert.rejects(
    () => makeRunner().run("hi", { model: "codex", cwd }),
    (err: unknown) =>
      isWorkflowError(err) &&
      err.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
      err.recoverable === false &&
      new RegExp(`protocol version ${PROTOCOL_VERSION + 1}.+does not support`, "i").test(err.message),
  );
});
