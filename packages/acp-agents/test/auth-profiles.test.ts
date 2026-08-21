// Per-agent auth profiles (§3) — PURE DATA layered on the type-driven base flow. These unit tests
// pin each profile's client-capability refinement, its identity `describe`/`buildMeta`, the codex
// `DEFAULT_AUTH_REQUEST` spawn-env lever, and the conformance-by-absence contract (custom backends
// carry NO profile). Nothing here gates the base flow (Principle 1).
import test from "node:test";
import assert from "node:assert/strict";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import {
  AuthStore,
  ClaudeBackend,
  CodexBackend,
  CustomAcpBackend,
  OpenCodeBackend,
  PiBackend,
  claudeAuthProfile,
  codexAuthProfile,
  opencodeAuthProfile,
  piAuthProfile,
  type AuthIntent,
  type AuthMethodDescriptor,
  type Backend,
} from "../src/index.js";

// -- clientAuthCapabilities: each backend maps host affordances onto the TYPES it can service (§1.2/§3.1)

test("claudeAuthProfile.clientAuthCapabilities: terminal follows the host TTY, gateway follows onAuth", () => {
  assert.deepEqual(claudeAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: true }), {
    terminal: true,
    gateway: true,
  });
  assert.deepEqual(claudeAuthProfile.clientAuthCapabilities({ onAuth: false, terminal: true }), {
    terminal: true,
    gateway: false,
  });
  assert.deepEqual(claudeAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: false }), {
    terminal: false,
    gateway: true,
  });
});

test("codexAuthProfile.clientAuthCapabilities: NEVER advertises terminal; gateway follows onAuth", () => {
  // Codex has no terminal auth method (§3.3), so terminal is false regardless of the host TTY.
  assert.deepEqual(codexAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: true }), {
    terminal: false,
    gateway: true,
  });
  assert.deepEqual(codexAuthProfile.clientAuthCapabilities({ onAuth: false, terminal: true }), {
    terminal: false,
    gateway: false,
  });
});

test("opencodeAuthProfile.clientAuthCapabilities: terminal follows the host TTY; NEVER gateway", () => {
  // OpenCode has no gateway/env_var auth method (§3.4), so gateway is always false.
  assert.deepEqual(opencodeAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: true }), {
    terminal: true,
    gateway: false,
  });
  assert.deepEqual(opencodeAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: false }), {
    terminal: false,
    gateway: false,
  });
});

test("piAuthProfile.clientAuthCapabilities: env-var and stored credentials need no optional client gate", () => {
  assert.deepEqual(piAuthProfile.clientAuthCapabilities({ onAuth: true, terminal: true }), {
    terminal: false,
    gateway: false,
  });
  assert.deepEqual(piAuthProfile.clientAuthCapabilities({ onAuth: false, terminal: false }), {
    terminal: false,
    gateway: false,
  });
});

// -- describe: client-side identity (the base dispatcher already produces the correct descriptor) ----

test("every built-in describe() is a pass-through of the base descriptor (label-only seam, §3.1)", () => {
  const base: AuthMethodDescriptor = {
    type: "agent",
    id: "gateway",
    name: "Custom gateway",
    expectsMeta: true,
    interactive: false,
    meta: { gateway: { protocol: "anthropic" } },
  };
  const method = { id: "gateway", name: "Custom gateway", _meta: { gateway: { protocol: "anthropic" } } } as AuthMethod;
  for (const profile of [claudeAuthProfile, codexAuthProfile, opencodeAuthProfile]) {
    assert.equal(profile.describe(method, base), base, `${profile.backendId} describe is identity`);
  }
});

test("piAuthProfile describes every advertised method with non-secret remediation", () => {
  const expected = new Map([
    [
      "pi-stored-credentials",
      "Set a provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or OPENROUTER_API_KEY) in the environment or configure pi credentials in ~/.pi/agent/auth.json, then retry or resume the workflow.",
    ],
  ]);
  for (const [id, description] of expected) {
    const method = { id, name: id } as AuthMethod;
    const base: AuthMethodDescriptor = {
      type: "agent",
      id,
      name: id,
      expectsMeta: false,
      interactive: true,
    };
    assert.equal(piAuthProfile.describe(method, base).description, description);
  }
});

// -- buildMeta: claude/codex pass the gateway payload through unchanged; opencode has none ------------

test("claude/codex buildMeta pass the gateway payload through; opencode advertises no buildMeta", () => {
  const method = { id: "gateway", name: "Gateway", _meta: { gateway: {} } } as AuthMethod;
  const payload = { gateway: { baseUrl: "https://gw.example", headers: { authorization: "Bearer red_me" } } };
  assert.equal(
    claudeAuthProfile.buildMeta?.(method, { outcome: "meta", methodId: "gateway", meta: payload }),
    payload,
  );
  assert.equal(
    codexAuthProfile.buildMeta?.(method, { outcome: "meta", methodId: "gateway", meta: payload }),
    payload,
  );
  assert.equal(opencodeAuthProfile.buildMeta, undefined);
});

// -- codex DEFAULT_AUTH_REQUEST spawn-env lever (§2.8/§3.3) — the ONLY spawnAuthEnv -------------------

test("codexAuthProfile.spawnAuthEnv emits DEFAULT_AUTH_REQUEST for api-key/gateway, undefined otherwise", () => {
  const base = { backendId: "codex", poolKey: "codex", methodType: "agent", klass: "disk", diskBacked: true } as const;

  // env-only api-key path: no meta -> just the methodId (forces readApiKeyFromEnv).
  const apiKeyOnly = codexAuthProfile.spawnAuthEnv!({ ...base, methodId: "api-key" });
  assert.deepEqual(apiKeyOnly, { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) });

  // api-key with a meta payload: the _meta is carried in the request.
  const apiKeyMeta = codexAuthProfile.spawnAuthEnv!({
    ...base,
    methodId: "api-key",
    authenticateMeta: { "api-key": { apiKey: "sk-secret" } },
  });
  assert.deepEqual(apiKeyMeta, {
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key", _meta: { "api-key": { apiKey: "sk-secret" } } }),
  });

  // gateway path carries its gateway _meta.
  const gateway = codexAuthProfile.spawnAuthEnv!({
    ...base,
    methodId: "gateway",
    klass: "in-process",
    diskBacked: false,
    authenticateMeta: { gateway: { baseUrl: "https://gw" } },
  });
  assert.deepEqual(gateway, {
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "gateway", _meta: { gateway: { baseUrl: "https://gw" } } }),
  });

  // Any other methodId is NOT a codex pre-auth channel.
  assert.equal(codexAuthProfile.spawnAuthEnv!({ ...base, methodId: "chat-gpt" }), undefined);
});

test("claude, opencode, and pi define NO spawnAuthEnv (no DEFAULT_AUTH_REQUEST analog — a truthful asymmetry)", () => {
  assert.equal(claudeAuthProfile.spawnAuthEnv, undefined);
  assert.equal(opencodeAuthProfile.spawnAuthEnv, undefined);
  assert.equal(piAuthProfile.spawnAuthEnv, undefined);
});

// -- AuthStore.spawnEnvFor wires the codex profile lever into the spawn overlay (§2.8) --------------

test("AuthStore.spawnEnvFor merges host-collected env values with the codex DEFAULT_AUTH_REQUEST contribution", () => {
  const store = new AuthStore();
  const machine = store.machineFor("codex", codexAuthProfile);
  // api-key intent from an `env` resolution: env values injected by the host PLUS the profile's DEFAULT_AUTH_REQUEST.
  const intent: AuthIntent = {
    backendId: "codex",
    poolKey: "codex",
    methodId: "api-key",
    methodType: "agent",
    klass: "disk",
    diskBacked: true,
    envValues: { CODEX_API_KEY: "sk-secret" },
  };
  machine.send({ t: "host_authenticate", intent });
  const overlay = store.spawnEnvFor("codex");
  assert.deepEqual(overlay, {
    CODEX_API_KEY: "sk-secret",
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
  });
});

test("AuthStore.spawnEnvFor is undefined for a backend with no intent (default-OFF)", () => {
  const store = new AuthStore();
  store.machineFor("codex", codexAuthProfile);
  assert.equal(store.spawnEnvFor("codex"), undefined);
  assert.equal(store.spawnEnvFor("never-touched"), undefined);
});

test("AuthStore.spawnEnvFor yields no DEFAULT_AUTH_REQUEST for a claude gateway intent (no lever)", () => {
  const store = new AuthStore();
  const machine = store.machineFor("claude", claudeAuthProfile);
  machine.send({
    t: "host_authenticate",
    intent: {
      backendId: "claude",
      poolKey: "claude",
      methodId: "gateway",
      methodType: "agent",
      klass: "in-process",
      diskBacked: false,
      authenticateMeta: { gateway: { baseUrl: "https://gw" } },
    },
  });
  // in-process gateway is applied via authenticate replay, not env — and claude has no spawnAuthEnv.
  assert.equal(store.spawnEnvFor("claude"), undefined);
});

// -- backend wiring: the four built-ins carry their profile; custom carries NONE (conformance) -------

test("built-in backends wire their profile; a custom backend leaves authProfile undefined (§3.5)", () => {
  assert.equal(new ClaudeBackend().authProfile, claudeAuthProfile);
  assert.equal(new CodexBackend().authProfile, codexAuthProfile);
  assert.equal(new OpenCodeBackend().authProfile, opencodeAuthProfile);
  assert.equal(new PiBackend().authProfile, piAuthProfile);
  const custom: Backend = new CustomAcpBackend({ name: "acme", command: "acme-acp", args: [] });
  assert.equal(custom.authProfile, undefined);
});
