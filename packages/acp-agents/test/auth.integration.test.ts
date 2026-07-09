// Drives the PROFILE-LESS conformant fake-auth-agent (§3.5) over the REAL pool — the executable
// proof of Principle 1. Every behavior here traverses the identical dispatcher, class inference,
// advertisement, and error taxonomy the three first-class agents use, with ZERO agent-specific code.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AcpAgentRunner, type AcpRunnerOptions, type AuthResolver } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth-agent.mjs", import.meta.url));

interface LogEntry {
  method: string;
  pid?: number;
  authed?: boolean;
  params?: { methodId?: string; _meta?: Record<string, unknown> };
}

const ENV_KEYS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_FAKE_AUTH_LOG",
  "AGENTPRISM_FAKE_AUTH_DISK",
  "FAKE_AUTH_TOKEN",
  "FAKE_ORG",
];

const runners: AcpAgentRunner[] = [];

function setup(): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-auth-it-"));
  const log = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_AUTH_LOG = log;
  process.env.AGENTPRISM_FAKE_AUTH_DISK = path.join(dir, "disk.sentinel");
  return {
    cwd: dir,
    readLog: () => {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogEntry);
    },
  };
}

function makeRunner(options: AcpRunnerOptions = {}): AcpAgentRunner {
  const runner = new AcpAgentRunner(options);
  runners.push(runner);
  return runner;
}

function newSessions(log: LogEntry[]): LogEntry[] {
  return log.filter((e) => e.method === "newSession");
}

/** Deterministic settle signal for the fire-and-forget live re-apply (§2.6): `host_authenticate`
 *  resets the machine to "credentials_held", and `apply_ok` — sent only AFTER the connection stamp
 *  — flips it back to "authenticated", so the redacted status is safe to poll. */
async function waitForApplied(runner: AcpAgentRunner, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner.auth.status({ backend: "claude" })[0]?.state === "authenticated") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("timed out waiting for the live re-apply to settle (machine never reached 'authenticated')");
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.dispose()));
  for (const key of ENV_KEYS) delete process.env[key];
});

test("advertisement gating: authCapabilities lights gateway + terminal; unset advertises env_var only", async () => {
  setup();
  const lit = await makeRunner({ authCapabilities: { terminal: true, gateway: true } }).describeAuthMethods({
    model: "claude",
  });
  assert.deepEqual(lit.map((d) => d.id).sort(), ["api-key", "gateway", "terminal-login"]);
  const gateway = lit.find((d) => d.id === "gateway");
  assert.equal(gateway?.type, "agent");
  assert.equal(gateway?.type === "agent" ? gateway.expectsMeta : undefined, true);
  const terminal = lit.find((d) => d.id === "terminal-login");
  assert.equal(terminal?.type, "terminal");

  const off = await makeRunner({}).describeAuthMethods({ model: "claude" });
  assert.deepEqual(off.map((d) => d.id), ["api-key"]);
});

test("proactive describeAuthMethods dispatches env_var vars with SDK defaults", async () => {
  setup();
  const methods = await makeRunner({}).describeAuthMethods({ model: "claude" });
  const apiKey = methods.find((d) => d.id === "api-key");
  assert.equal(apiKey?.type, "env_var");
  if (apiKey?.type !== "env_var") return;
  assert.deepEqual(apiKey.vars[0], { name: "FAKE_AUTH_TOKEN", label: "Fake auth token", secret: true, optional: false });
  assert.deepEqual(apiKey.vars[1], { name: "FAKE_ORG", label: "Organization", secret: false, optional: true });
});

test("no resolver: -32000 on session/new maps to non-recoverable AUTH_REQUIRED", async () => {
  const { cwd } = setup();
  await assert.rejects(
    () => makeRunner({}).run("hi", { model: "claude", cwd, label: "needs-auth" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});

test("reactive: -32000 -> onAuth env resolution -> retry-once -> success (no pause), fresh process carries the env", async () => {
  const { cwd, readLog } = setup();
  let calls = 0;
  const onAuth: AuthResolver = () => {
    calls += 1;
    return { outcome: "env", values: { FAKE_AUTH_TOKEN: "secret-value" } };
  };
  const result = await makeRunner({ onAuth, authCapabilities: { gateway: true } }).run("hi", {
    model: "claude",
    cwd,
    label: "reactive",
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  // The unauthenticated -32000 and the authenticated session ran on DIFFERENT processes (§2.6 gap-3):
  // the stale connection was recycled and a fresh process spawned WITH the env overlay.
  const sessions = newSessions(readLog());
  const failed = sessions.find((e) => e.authed === false);
  const authed = sessions.find((e) => e.authed === true);
  assert.ok(failed && authed, "expected both a failed and an authed newSession");
  assert.notEqual(failed?.pid, authed?.pid);
});

test("retry-once guard: a resolution that still fails propagates AUTH_REQUIRED after exactly one retry", async () => {
  const { cwd } = setup();
  let calls = 0;
  const onAuth: AuthResolver = () => {
    calls += 1;
    // Wrong var (fixture checks FAKE_AUTH_TOKEN) -> the retry still hits -32000.
    return { outcome: "env", values: { FAKE_ORG: "acme" } };
  };
  await assert.rejects(
    () => makeRunner({ onAuth }).run("hi", { model: "claude", cwd, label: "guard" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.AUTH_REQUIRED);
      return true;
    },
  );
  assert.equal(calls, 1); // resolver invoked once; a second -32000 propagates, no unbounded loop
});

test("completeAuth(gateway) -> recycle -> replay-after-initialize on a fresh connection, then a 2nd run reuses the authed pool", async () => {
  const { cwd, readLog } = setup();
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  const outcome = await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl: "https://gw.test", headers: { Authorization: "Bearer SECRET" } } } },
  });
  assert.equal(outcome.status, "authenticated");
  assert.equal(outcome.recycled, true);

  const r1 = await runner.run("hi", { model: "claude", cwd, label: "gw1" });
  assert.equal(r1, "ok");
  const r2 = await runner.run("hi again", { model: "claude", cwd, label: "gw2" });
  assert.equal(r2, "ok");

  const log = readLog();
  // The gateway credential was REPLAYED on the wire (in-process, per §2.5) with its _meta.
  const auth = log.find((e) => e.method === "authenticate" && e.params?.methodId === "gateway");
  assert.ok(auth, "expected an authenticate replay for the gateway method");
  assert.ok(auth?.params?._meta?.gateway, "replay must carry the gateway _meta");
  // The two runs reused ONE authenticated pooled process (no session served under stale auth).
  const authedPids = new Set(newSessions(log).filter((e) => e.authed).map((e) => e.pid));
  assert.equal(authedPids.size, 1);
});

test("generation staleness: a mid-life completeAuth drains the stale process; no session is served under stale auth", async () => {
  const { cwd, readLog } = setup();
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  await runner.auth.authenticate({
    model: "claude",
    methodId: "api-key",
    resolution: { outcome: "env", values: { FAKE_AUTH_TOKEN: "v1" } },
  });
  const r1 = await runner.run("one", { model: "claude", cwd });
  assert.equal(r1, "ok");
  const pidA = newSessions(readLog()).find((e) => e.authed)?.pid;

  // Re-authenticate (generation bump). The idle spawn-env process is disposed-and-dropped (§2.6).
  await runner.auth.authenticate({
    model: "claude",
    methodId: "api-key",
    resolution: { outcome: "env", values: { FAKE_AUTH_TOKEN: "v2" } },
  });
  const r2 = await runner.run("two", { model: "claude", cwd });
  assert.equal(r2, "ok");

  const authedPids = newSessions(readLog())
    .filter((e) => e.authed)
    .map((e) => e.pid);
  const pidB = authedPids.at(-1);
  assert.ok(pidA && pidB);
  assert.notEqual(pidA, pidB); // the second run landed on a FRESH process, never the stale one
});

test("generation staleness, in-process half: a mid-life gateway re-auth live-reapplies on the SAME idle process (§2.6, no recycle)", async () => {
  const { cwd, readLog } = setup();
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl: "https://gw-a.test" } } },
  });
  const r1 = await runner.run("one", { model: "claude", cwd });
  assert.equal(r1, "ok");
  const pidA = newSessions(readLog()).find((e) => e.authed)?.pid;
  assert.ok(pidA);

  // Re-authenticate with a NEW gateway credential while the process idles. The in-process klass
  // takes the live-reapply branch (an authenticate replay on the live connection) — the
  // complement of the drained half above, where the spawn-env process is disposed instead.
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl: "https://gw-b.test" } } },
  });
  await waitForApplied(runner);

  const r2 = await runner.run("two", { model: "claude", cwd });
  assert.equal(r2, "ok");

  const log = readLog();
  // Both runs were served by the ONE original process: the stale idle connection was re-primed
  // live, never recycled.
  const authedPids = new Set(newSessions(log).filter((e) => e.authed).map((e) => e.pid));
  assert.deepEqual([...authedPids], [pidA]);
  // The re-apply is visible on the wire: a SECOND authenticate on the same pid carrying cred B.
  const replays = log.filter((e) => e.method === "authenticate" && e.params?.methodId === "gateway" && e.pid === pidA);
  assert.equal(replays.length, 2);
  const gw = (replays.at(-1)?.params?._meta as { gateway?: { baseUrl?: string } } | undefined)?.gateway;
  assert.equal(gw?.baseUrl, "https://gw-b.test");
});

test("interactive openSession on a dedicated connection replays the in-process credential", async () => {
  const { cwd } = setup();
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl: "https://gw.test" } } },
  });
  const session = await runner.openSession({ model: "claude", cwd, label: "interactive" });
  try {
    const turn = await session.prompt("hello");
    assert.equal(turn.text.trim(), "ok");
  } finally {
    await session.release();
  }
});

test("logout clears the store, recycles, zeroizes, and issues the logout RPC; the backend re-requires auth", async () => {
  const { cwd, readLog } = setup();
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { baseUrl: "https://gw.test", headers: { Authorization: "Bearer SECRET" } } } },
  });
  assert.equal((await runner.run("hi", { model: "claude", cwd })), "ok");

  await runner.auth.logout({ model: "claude" });
  const status = runner.auth.status({ backend: "claude" });
  assert.equal(status[0]?.state, "unauthenticated");
  assert.equal(status[0]?.authenticated, false);

  // A fresh process has no gateway cred (cleared from the store) -> session/new -32000 again.
  await assert.rejects(
    () => runner.run("hi", { model: "claude", cwd }),
    (error: unknown) => isWorkflowError(error) && error.code === WorkflowErrorCode.AUTH_REQUIRED,
  );
  assert.ok(readLog().some((e) => e.method === "logout"), "expected a logout RPC on the wire");
});

test("auth.status is redacted and reports canResume; secrets never surface in status or events", async () => {
  const { cwd } = setup();
  const secret = "Bearer TOP-SECRET-GATEWAY-KEY";
  const seen: string[] = [];
  const runner = makeRunner({ authCapabilities: { gateway: true } });
  runner.on("session_update", (evt) => seen.push(JSON.stringify(evt)));
  await runner.auth.authenticate({
    model: "claude",
    methodId: "gateway",
    resolution: { outcome: "meta", methodId: "gateway", meta: { gateway: { headers: { Authorization: secret } } } },
  });
  await runner.run("hi", { model: "claude", cwd });

  const status = runner.auth.status({ backend: "claude" });
  const snapshot = status[0];
  assert.ok(snapshot);
  assert.equal(JSON.stringify(snapshot).includes("TOP-SECRET"), false);
  assert.equal(snapshot.canResume, true); // credentials held / authenticated
  for (const m of snapshot.methods) assert.ok(!("meta" in m) || JSON.stringify(m).indexOf("TOP-SECRET") === -1);
  // No emitted event carries the gateway header value.
  assert.equal(seen.some((s) => s.includes("TOP-SECRET")), false);
});
