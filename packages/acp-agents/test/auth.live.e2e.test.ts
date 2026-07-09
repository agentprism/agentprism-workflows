// Per-first-class-backend LIVE auth e2e (§4.6.3) — env-GATED, skip-by-default. Every OTHER auth suite
// drives the profile-less fake agent; this one drives the REAL claude / codex / opencode ACP servers
// with REAL credentials so each first-class integration's auth path has a re-runnable guard with
// EQUAL structural depth (Principle 1 — no backend is privileged).
//
// GATE: runs only when AGENTPRISM_LIVE_E2E === "1" (the pre-push gate, mirroring
// mcp-server/test/live-backend.e2e.test.ts:33-36). Each backend is ADDITIONALLY env-guarded on its
// own credential, so a partial local setup exercises only what it can. When a backend is gated ON but
// cannot authenticate, its assertions FAIL loudly (stderr tail surfaces through the mapped error) —
// it never silently passes. The DEFAULT `pnpm test` leaves the whole file SKIPPED and credential-free.
import test from "node:test";
import assert from "node:assert/strict";
import { AcpAgentRunner, type AuthMethodDescriptor, type AuthResolver } from "../src/index.js";

const LIVE = process.env.AGENTPRISM_LIVE_E2E === "1";

/** Per-backend skip reason: the master gate first, then the backend's own credential. */
function gate(reason: string, credentialPresent: boolean): string | false {
  if (!LIVE) return "gated live-backend e2e — set AGENTPRISM_LIVE_E2E=1 (with creds) to run";
  return credentialPresent ? false : reason;
}

const runners: AcpAgentRunner[] = [];
function makeRunner(...args: ConstructorParameters<typeof AcpAgentRunner>): AcpAgentRunner {
  const runner = new AcpAgentRunner(...args);
  runners.push(runner);
  return runner;
}

test.after(async () => {
  await Promise.all(runners.splice(0).map((r) => r.dispose()));
});

const PING_PROMPT = "Reply with exactly one word and nothing else: pong";
function assertPong(result: string): void {
  assert.equal(typeof result, "string");
  assert.ok(result.toLowerCase().includes("pong"), `expected a 'pong' completion, got: ${JSON.stringify(result).slice(0, 200)}`);
}

function methodById(methods: readonly AuthMethodDescriptor[], id: string): AuthMethodDescriptor | undefined {
  return methods.find((m) => m.id === id);
}

// ---- codex — api-key via CODEX_API_KEY / OPENAI_API_KEY (disk cred; DEFAULT_AUTH_REQUEST lever) ----
test(
  "codex: api-key advertised with _meta.provider, DEFAULT_AUTH_REQUEST pre-auth, real prompt completes",
  { skip: gate("set CODEX_API_KEY (or OPENAI_API_KEY) to run the codex auth e2e", Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY)) },
  async () => {
    // onAuth present ⇒ the runner lights auth._meta.gateway; codex still ALWAYS advertises api-key.
    const onAuth: AuthResolver = () => ({ outcome: "cancelled" });
    const runner = makeRunner({ onAuth });

    const methods = await runner.describeAuthMethods({ model: "codex" });
    const apiKey = methodById(methods, "api-key");
    assert.ok(apiKey, "codex must advertise the api-key method");
    assert.equal(apiKey.type, "agent");
    // The advertised _meta["api-key"].provider is agent-published metadata (not a credential).
    const meta = (apiKey as Extract<AuthMethodDescriptor, { type: "agent" }>).meta;
    assert.equal((meta?.["api-key"] as { provider?: string } | undefined)?.provider, "openai");

    // Record the env intent so codexAuthProfile.spawnAuthEnv emits DEFAULT_AUTH_REQUEST at the next
    // spawn — layered ON TOP of the universal replay; it must NOT break a real prompt (§2.8/§3.3).
    const key = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY!;
    const outcome = await runner.completeAuth({
      model: "codex",
      methodId: "api-key",
      resolution: { outcome: "env", values: { CODEX_API_KEY: key } },
    });
    assert.equal(outcome.status, "authenticated");
    assert.equal(outcome.recycled, true);

    assertPong(await runner.run(PING_PROMPT, { model: "codex" }));
  },
);

// ---- opencode — a provider key from the models.dev registry (disk; opencode-login is a no-op ack) ----
test(
  "opencode: single opencode-login method, authenticate no-op, real prompt completes with a provider key",
  { skip: gate("set OPENAI_API_KEY or ANTHROPIC_API_KEY to run the opencode auth e2e", Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) },
  async () => {
    const runner = makeRunner();
    const model = process.env.AGENTPRISM_OPENCODE_E2E_MODEL; // e.g. "opencode/anthropic/claude-..."

    const methods = await runner.describeAuthMethods({ model: model ?? "opencode" });
    // Exactly one method, `opencode-login` (service.ts:49,92-137).
    assert.equal(methods.length, 1, "opencode advertises exactly one auth method");
    assert.equal(methods[0].id, "opencode-login");

    // authenticate is a pure no-op ack (service.ts:139-144): the one-shot agent-login RPC provisions
    // nothing and must NOT throw — the real credential comes from the provider env key.
    await runner.authenticate({ model: model ?? "opencode", methodId: "opencode-login" });

    // With the provider key present the ProviderAuthError→-32000 path (service.ts:856-858) must NOT fire.
    assertPong(await runner.run(PING_PROMPT, { model: model ?? "opencode" }));
  },
);

// ---- claude — gateway against a stub baseUrl (in-process cred; terminal path CI-skipped: needs a TTY) ----
test(
  "claude: auth._meta.gateway-gated advertisement + gateway authenticate stored in-process",
  { skip: gate("set AGENTPRISM_CLAUDE_GATEWAY_URL to run the claude gateway auth e2e", Boolean(process.env.AGENTPRISM_CLAUDE_GATEWAY_URL)) },
  async () => {
    const baseUrl = process.env.AGENTPRISM_CLAUDE_GATEWAY_URL!;
    const headers = process.env.AGENTPRISM_CLAUDE_GATEWAY_TOKEN
      ? { authorization: `Bearer ${process.env.AGENTPRISM_CLAUDE_GATEWAY_TOKEN}` }
      : {};
    // A gateway resolver ⇒ auth._meta.gateway is lit (§1.2); claude then advertises gateway/gateway-bedrock.
    const onAuth: AuthResolver = () => ({ outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl, headers } } });
    const runner = makeRunner({ onAuth, authCapabilities: { terminal: false, gateway: true } });

    const methods = await runner.describeAuthMethods({ model: "claude" });
    const gateway = methodById(methods, "gateway");
    assert.ok(gateway, "claude must advertise the gateway method when auth._meta.gateway is lit");
    assert.equal(gateway.type, "agent");
    assert.equal((gateway as Extract<AuthMethodDescriptor, { type: "agent" }>).expectsMeta, true);

    // Complete gateway auth: recorded in-process and replayed after every initialize (§2.5). The store
    // marks the backend authenticated + recycled without touching disk (claude gateway is in-process).
    const outcome = await runner.completeAuth({
      model: "claude",
      methodId: "gateway",
      resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl, headers } } },
    });
    assert.equal(outcome.status, "authenticated");
    assert.equal(outcome.recycled, true);
    const status = runner.auth.status({ backend: "claude" })[0];
    assert.equal(status.backendId, "claude");
    assert.equal(status.authenticated, true);
    // NOTE: the claude TERMINAL login path (claude-ai-login/console-login) needs a real TTY and is
    // therefore documented and CI-skipped here (§4.6.3); the gateway in-process path is exercised above.
  },
);
