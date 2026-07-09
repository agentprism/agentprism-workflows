import test from "node:test";
import assert from "node:assert/strict";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import {
  AuthStore,
  BackendAuthMachine,
  classifyCredential,
  redactSecrets,
  type AuthIntent,
  type ConnectionAuthStamp,
} from "../src/index.js";

function intent(partial: Partial<AuthIntent> = {}): AuthIntent {
  return {
    backendId: "claude",
    poolKey: "claude",
    methodId: "gateway",
    methodType: "agent",
    klass: "in-process",
    diskBacked: false,
    ...partial,
  };
}

function stamp(appliedGeneration: number): ConnectionAuthStamp {
  return { appliedGeneration, applied: true, trippedAuthRequired: false };
}

test("classifyCredential is type-driven and agent-agnostic (§2.1)", () => {
  assert.deepEqual(classifyCredential("env_var", undefined), { klass: "spawn-env", diskBacked: false });
  assert.deepEqual(classifyCredential("terminal", undefined), { klass: "disk", diskBacked: true });
  // agent + gateway-shaped _meta -> in-process (claude/codex gateway).
  assert.deepEqual(classifyCredential("agent", { gateway: { protocol: "x" } }), { klass: "in-process", diskBacked: false });
  // agent + non-gateway _meta (codex api-key) -> disk.
  assert.deepEqual(classifyCredential("agent", { "api-key": { provider: "openai" } }), { klass: "disk", diskBacked: true });
  // agent + no _meta (codex chat-gpt / opencode-login) -> disk.
  assert.deepEqual(classifyCredential("agent", undefined), { klass: "disk", diskBacked: true });
});

test("host_authenticate stores the intent and bumps the generation (§2.3)", () => {
  const m = new BackendAuthMachine();
  assert.equal(m.state, "unauthenticated");
  assert.equal(m.generation, 0);
  m.send({ t: "host_authenticate", intent: intent() });
  assert.equal(m.state, "credentials_held");
  assert.equal(m.generation, 1);
});

test("credentials_held --apply_ok--> authenticated", () => {
  const m = new BackendAuthMachine();
  m.send({ t: "host_authenticate", intent: intent() });
  m.send({ t: "apply_ok", connectionId: "c1", generation: m.generation });
  assert.equal(m.state, "authenticated");
  assert.equal(m.authenticated, true);
});

test("authenticated --auth_required_tripped--> auth_required (mid-run expiry)", () => {
  const m = new BackendAuthMachine();
  m.send({ t: "host_authenticate", intent: intent() });
  m.send({ t: "apply_ok", connectionId: "c1", generation: m.generation });
  m.send({ t: "auth_required_tripped", connectionId: "c1", error: new Error("expired") });
  assert.equal(m.state, "auth_required");
});

test("credentials_held/authenticated --apply_failed--> auth_required", () => {
  const held = new BackendAuthMachine();
  held.send({ t: "host_authenticate", intent: intent() });
  held.send({ t: "apply_failed", connectionId: "c1", generation: held.generation, error: new Error("bad") });
  assert.equal(held.state, "auth_required");

  const authed = new BackendAuthMachine();
  authed.send({ t: "host_authenticate", intent: intent() });
  authed.send({ t: "apply_ok", connectionId: "c1", generation: authed.generation });
  authed.send({ t: "apply_failed", connectionId: "c1", generation: authed.generation, error: new Error("bad") });
  assert.equal(authed.state, "auth_required");
});

test("unauthenticated/auth_required --auth_required_tripped--> auth_required", () => {
  const m = new BackendAuthMachine();
  m.send({ t: "auth_required_tripped", connectionId: "c1", error: new Error("x") });
  assert.equal(m.state, "auth_required");
  m.send({ t: "auth_required_tripped", connectionId: "c1", error: new Error("x") });
  assert.equal(m.state, "auth_required");
});

test("process_death leaves machine state unchanged (§2.3)", () => {
  const m = new BackendAuthMachine();
  m.send({ t: "host_authenticate", intent: intent() });
  m.send({ t: "apply_ok", connectionId: "c1", generation: m.generation });
  const before = m.state;
  const gen = m.generation;
  m.send({ t: "process_death", connectionId: "c1" });
  assert.equal(m.state, before);
  assert.equal(m.generation, gen);
});

test("logout clears the intent, bumps the generation, and ZEROIZES the secret payload (§2.14)", () => {
  const m = new BackendAuthMachine();
  const secretMeta = { gateway: { baseUrl: "https://gw.test", headers: { Authorization: "Bearer SUPERSECRET" } } };
  const secretEnv = { FAKE_AUTH_TOKEN: "SUPERSECRET" };
  const held = intent({
    klass: "in-process",
    authenticateMeta: JSON.parse(JSON.stringify(secretMeta)),
    envValues: { ...secretEnv },
  });
  m.send({ t: "host_authenticate", intent: held });
  assert.equal(m.applyMeta()?.["gateway"] !== undefined, true);
  const genBefore = m.generation;

  m.send({ t: "logout" });
  assert.equal(m.state, "unauthenticated");
  assert.equal(m.generation, genBefore + 1);
  assert.equal(m.intentView(), undefined);
  assert.equal(m.applyMeta(), undefined);
  assert.equal(m.spawnEnv(), undefined);
  // The original intent object's secret fields are unreachable (zeroized in place).
  assert.deepEqual(held.authenticateMeta, {});
  assert.deepEqual(held.envValues, { FAKE_AUTH_TOKEN: "" });
});

test("intentView is redacted — never exposes authenticateMeta / envValues (§2.14)", () => {
  const m = new BackendAuthMachine();
  m.send({
    t: "host_authenticate",
    intent: intent({ authenticateMeta: { gateway: { headers: { Authorization: "Bearer X" } } }, envValues: { K: "V" } }),
  });
  const view = m.intentView();
  assert.ok(view);
  assert.equal("authenticateMeta" in (view as object), false);
  assert.equal("envValues" in (view as object), false);
  assert.equal(view?.methodId, "gateway");
  assert.equal(view?.klass, "in-process");
});

test("canResume: authenticated/credentials_held OR diskBacked (§2.13)", () => {
  const inproc = new BackendAuthMachine();
  assert.equal(inproc.canResume(), false); // unauthenticated
  inproc.send({ t: "host_authenticate", intent: intent({ klass: "in-process", diskBacked: false }) });
  assert.equal(inproc.canResume(), true); // credentials_held

  // A cold process loses an in-process intent (empty machine) -> not resumable.
  const cold = new BackendAuthMachine();
  cold.send({ t: "auth_required_tripped", connectionId: "c1", error: new Error("x") });
  assert.equal(cold.canResume(), false);

  // A disk-backed intent survives cold resume even in auth_required.
  const disk = new BackendAuthMachine();
  disk.send({ t: "host_authenticate", intent: intent({ klass: "disk", diskBacked: true }) });
  disk.send({ t: "auth_required_tripped", connectionId: "c1", error: new Error("x") });
  assert.equal(disk.canResume(), true);
});

test("isStale: a stamp older than the machine generation is stale; host_authenticate invalidates all", () => {
  const m = new BackendAuthMachine();
  assert.equal(m.isStale(stamp(0)), false); // gen 0, stamp 0
  m.send({ t: "host_authenticate", intent: intent() }); // gen -> 1
  assert.equal(m.isStale(stamp(0)), true);
  assert.equal(m.isStale(stamp(1)), false);
});

test("AuthStore.spawnEnvFor returns the machine's collected env_var values (§2.8)", () => {
  const store = new AuthStore();
  assert.equal(store.spawnEnvFor("codex"), undefined); // no machine yet
  const m = store.machineFor("codex");
  m.send({ t: "host_authenticate", intent: intent({ backendId: "codex", poolKey: "codex", methodId: "api-key", methodType: "env_var", klass: "spawn-env", envValues: { OPENAI_API_KEY: "sk-test" } }) });
  assert.deepEqual(store.spawnEnvFor("codex"), { OPENAI_API_KEY: "sk-test" });
});

test("AuthStore.machineFor is idempotent per key; poolKeys enumerates touched backends", () => {
  const store = new AuthStore();
  const a = store.machineFor("claude");
  const b = store.machineFor("claude");
  assert.equal(a, b);
  store.machineFor("codex");
  assert.deepEqual([...store.poolKeys()].sort(), ["claude", "codex"]);
  assert.equal(store.existing("opencode"), undefined);
});

test("redactSecrets strips known credential patterns from diagnostic text (§2.14)", () => {
  const raw = [
    "starting agent",
    "ANTHROPIC_API_KEY=sk-ant-verysecret",
    "export OPENAI_API_KEY=sk-openai-secret",
    "using Authorization: Bearer abc123.def456",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
    "normal log line",
  ].join("\n");
  const out = redactSecrets(raw);
  assert.equal(out.includes("sk-ant-verysecret"), false);
  assert.equal(out.includes("sk-openai-secret"), false);
  assert.equal(out.includes("abc123.def456"), false);
  assert.equal(out.includes("wJalrXUtnFEMI"), false);
  assert.equal(out.includes("[redacted]"), true);
  assert.equal(out.includes("starting agent"), true);
  assert.equal(out.includes("normal log line"), true);
});

test("advertised methods are recorded on initialize_ok for redacted status", () => {
  const m = new BackendAuthMachine();
  const advertised: AuthMethod[] = [{ id: "gateway", name: "Gateway", _meta: { gateway: {} } }];
  m.send({ t: "initialize_ok", connectionId: "c1", advertised });
  assert.deepEqual([...m.advertised], advertised);
});
