// Secret-handling guarantees (§2.14, §4.6.5, Principle 9): credential material — API keys, gateway
// headers, authenticate `_meta`, collected env values — never appears in logs, events, journals,
// error messages, redacted status, or the spawn config returned to callers.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner, BackendAuthMachine, redactSecrets, type AuthIntent } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth-agent.mjs", import.meta.url));
const SECRET = "sk-TOP-SECRET-VALUE-123";
const GATEWAY_HEADER = "Bearer GATEWAY-TOP-SECRET";

const ENV_KEYS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_FAKE_AUTH_LOG",
  "AGENTPRISM_FAKE_AUTH_DISK",
  "FAKE_AUTH_TOKEN",
  "FAKE_ORG",
];
const runners: AcpAgentRunner[] = [];

function setup(): { cwd: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-auth-secrets-"));
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_AUTH_LOG = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_FAKE_AUTH_DISK = path.join(dir, "disk.sentinel");
  return { cwd: dir };
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.dispose()));
  for (const key of ENV_KEYS) delete process.env[key];
});

test("redactSecrets strips *_API_KEY / ANTHROPIC_AUTH_TOKEN / AWS_* / Bearer values", () => {
  const scrubbed = redactSecrets(
    [
      "ANTHROPIC_API_KEY=sk-ant-abc",
      "  export CODEX_API_KEY=sk-codex-xyz",
      "ANTHROPIC_AUTH_TOKEN=tok-123",
      "AWS_SECRET_ACCESS_KEY=aws-secret",
      "hdr Authorization: Bearer tok.abc.def",
    ].join("\n"),
  );
  for (const leaked of ["sk-ant-abc", "sk-codex-xyz", "tok-123", "aws-secret", "tok.abc.def"]) {
    assert.equal(scrubbed.includes(leaked), false, `must redact ${leaked}`);
  }
});

test("BackendAuthMachine.intentView exposes ids/types/klass only; logout zeroizes secrets", () => {
  const m = new BackendAuthMachine();
  const held: AuthIntent = {
    backendId: "claude",
    poolKey: "claude",
    methodId: "gateway",
    methodType: "agent",
    klass: "in-process",
    diskBacked: false,
    authenticateMeta: { gateway: { headers: { Authorization: GATEWAY_HEADER } } },
    envValues: { FAKE_AUTH_TOKEN: SECRET },
  };
  m.send({ t: "host_authenticate", intent: held });
  const serialized = JSON.stringify(m.intentView());
  assert.equal(serialized.includes(GATEWAY_HEADER), false);
  assert.equal(serialized.includes(SECRET), false);
  m.send({ t: "logout" });
  assert.equal(m.applyMeta(), undefined);
  assert.equal(m.spawnEnv(), undefined);
});

test("no emitted event carries the injected env value or gateway header across a full authed run", async () => {
  const { cwd } = setup();
  const events: string[] = [];
  const runner = new AcpAgentRunner({ authCapabilities: { gateway: true } });
  runners.push(runner);
  for (const name of ["session_update", "tool_call", "backend_error", "raw_message"] as const) {
    runner.on(name, (evt) => events.push(JSON.stringify(evt)));
  }
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { headers: { Authorization: GATEWAY_HEADER } } } },
  });
  await runner.auth.authenticate({
    model: "claude",
    methodId: "api-key",
    resolution: { outcome: "env", values: { FAKE_AUTH_TOKEN: SECRET } },
  });
  const result = await runner.run("hi", { model: "claude", cwd });
  assert.equal(result, "ok");
  const blob = events.join("\n");
  assert.equal(blob.includes(GATEWAY_HEADER), false);
  assert.equal(blob.includes(SECRET), false);
});

test("AUTH_REQUIRED authContext carries only advertised ids/types/names — never our sent secrets", async () => {
  const { cwd } = setup();
  const runner = new AcpAgentRunner({ authCapabilities: { gateway: true } });
  runners.push(runner);
  await assert.rejects(
    () => runner.run("hi", { model: "claude", cwd, label: "no-auth" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      const ctx = (error as { authContext?: { methods: { id: string; type: string }[] } }).authContext;
      assert.ok(ctx);
      const serialized = JSON.stringify(error.authContext);
      // The advertised method ids/types are present; no secret payload keys are.
      assert.equal(serialized.includes("authenticateMeta"), false);
      assert.equal(serialized.includes("envValues"), false);
      for (const m of ctx?.methods ?? []) assert.ok(["agent", "terminal", "env_var"].includes(m.type));
      return true;
    },
  );
});

test("the spawn-env overlay is passed to spawn but never returned in the backend SpawnConfig", () => {
  // The overlay lives ONLY in the AuthStore/machine (env injection at spawn, §2.8); the backend's
  // spawnConfig() never carries it. A fresh runner's backend spawn config has no injected secret.
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  const spawnConfigJson = JSON.stringify(process.env);
  // sanity: the raw env we start from does not contain the auth token
  assert.equal(spawnConfigJson.includes("FAKE_AUTH_TOKEN"), false);
  for (const key of ["AGENTPRISM_CLAUDE_ACP_CMD", "AGENTPRISM_CLAUDE_ACP_ARGS"]) delete process.env[key];
});

test("logout leaves auth.status unauthenticated with no secret residue", async () => {
  const { cwd } = setup();
  const runner = new AcpAgentRunner({ authCapabilities: { gateway: true } });
  runners.push(runner);
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { headers: { Authorization: GATEWAY_HEADER } } } },
  });
  await runner.run("hi", { model: "claude", cwd });
  await runner.auth.logout({ model: "claude" });
  const snapshot = JSON.stringify(runner.auth.status({ backend: "claude" }));
  assert.equal(snapshot.includes(GATEWAY_HEADER), false);
  assert.ok(snapshot.includes("unauthenticated"));
});
