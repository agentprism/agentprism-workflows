// End-to-end proof that AcpRunnerOptions.authCapabilities (§1.2) threads runner -> pool ->
// PooledConnection -> the ONE-TIME initialize handshake, and that leaving it unset is byte-identical
// to today (default-OFF). The fake agent records the initialize params, so we assert exactly what
// clientCapabilities.auth / _meta the runner advertised on the wire.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const MODEL = "anthropic/claude-opus-4-1";

interface LogEntry {
  method: string;
  params?: { clientCapabilities?: ClientCapabilities };
}

const harness = createFakeAgentHarness({ prefix: "acp-auth-adv-" });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);
const makeRunner = harness.makeRunner;

afterEach(async () => {
  await harness.cleanup();
});

function initializeCapabilities(log: LogEntry[]): ClientCapabilities | undefined {
  return log.find((entry) => entry.method === "initialize")?.params?.clientCapabilities;
}

// NOTE ON SDK NORMALIZATION: the agent-side SDK parses the incoming clientCapabilities through its
// Zod schema, which fills schema defaults (`auth: { terminal: false }`, `fs.*: false`, …). So an
// OMITTED `auth` arrives as `{ terminal: false }` — exactly the spec's "unsupported" (§1.2), and
// byte-identical to what the runner emitted before PR2. We therefore assert the SEMANTIC gates that
// are actually lit (`auth.terminal === true`, `auth._meta.gateway === true`, top-level
// `_meta["terminal-auth"] === true`), which is what steers the three agents' method reveal, rather
// than exact object shape (which the SDK owns). The pure emission shape is pinned by the unit
// matrix in client-handlers.test.ts.
function terminalLit(caps: ClientCapabilities | undefined): boolean {
  return caps?.auth?.terminal === true;
}
function gatewayLit(caps: ClientCapabilities | undefined): boolean {
  return (caps?.auth?._meta as Record<string, unknown> | null | undefined)?.gateway === true;
}
function terminalChannelLit(caps: ClientCapabilities | undefined): boolean {
  return (caps?._meta as Record<string, unknown> | null | undefined)?.["terminal-auth"] === true;
}

test("no authCapabilities => no auth gate is lit at initialize (default-OFF, byte-identical to today)", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();

  const out = await runner.run("hi", { model: MODEL, cwd, label: "no-auth" });

  assert.equal(out, "ok");
  const caps = initializeCapabilities(readLog());
  assert.ok(caps, "initialize was observed");
  assert.equal(terminalLit(caps), false, "terminal gate not lit when unset");
  assert.equal(gatewayLit(caps), false, "gateway gate not lit when unset");
  assert.equal(terminalChannelLit(caps), false, "terminal-auth channel not lit when unset");
});

test("authCapabilities { terminal, gateway } lights auth.terminal, gateway, and the terminal-auth channel", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner({ authCapabilities: { terminal: true, gateway: true } });

  const out = await runner.run("hi", { model: MODEL, cwd, label: "both" });

  assert.equal(out, "ok");
  const caps = initializeCapabilities(readLog());
  assert.equal(terminalLit(caps), true);
  assert.equal(gatewayLit(caps), true);
  assert.equal(terminalChannelLit(caps), true);
});

test("authCapabilities { gateway } lights only auth._meta.gateway, never the terminal channel", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner({ authCapabilities: { gateway: true } });

  const out = await runner.run("hi", { model: MODEL, cwd, label: "gateway" });

  assert.equal(out, "ok");
  const caps = initializeCapabilities(readLog());
  assert.equal(gatewayLit(caps), true);
  assert.equal(terminalLit(caps), false, "gateway-only must not light terminal");
  assert.equal(terminalChannelLit(caps), false, "gateway-only must not light the terminal-auth channel");
});
