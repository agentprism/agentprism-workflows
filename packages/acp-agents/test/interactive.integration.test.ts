// End-to-end public interactive sessions against the MOCK ACP agent. These tests prove the
// dedicated-process contract separately from the pooled one-shot run() contract: a held-open
// session can take multiple prompt turns, but it never consumes the pool slot used by run().
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ContentBlock, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AcpAgentRunner } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };
const REJECT: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "reject-1" } };

const TEST_ENV_VARS = [
  "AGENTPRISM_CLAUDE_ACP_CMD",
  "AGENTPRISM_CLAUDE_ACP_ARGS",
  "AGENTPRISM_FAKE_LOG",
  "AGENTPRISM_FAKE_SCENARIO",
  "AGENTPRISM_DEFAULT_BACKEND",
];

interface LogEntry {
  method: string;
  pid?: number;
  reason?: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    prompt?: ContentBlock[];
  };
}

const runners: AcpAgentRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  for (const key of TEST_ENV_VARS) delete process.env[key];
});

function configure(scenario: unknown): { cwd: string; readLog: () => LogEntry[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-interactive-it-"));
  const log = path.join(dir, "log.jsonl");
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FIXTURE;
  process.env.AGENTPRISM_FAKE_LOG = log;
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  return {
    cwd: dir,
    readLog: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

function makeRunner(options: ConstructorParameters<typeof AcpAgentRunner>[0] = {}): AcpAgentRunner {
  const runner = new AcpAgentRunner(options);
  runners.push(runner);
  return runner;
}

const count = (entries: LogEntry[], method: string): number =>
  entries.filter((entry) => entry.method === method).length;

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pidOfFirst(entries: LogEntry[], method: string): number {
  const pid = entries.find((entry) => entry.method === method)?.pid;
  assert.equal(typeof pid, "number", `${method} carried a pid`);
  return pid;
}

function permissionOutcome(log: LogEntry[]): RequestPermissionResponse["outcome"] | undefined {
  return log.find((entry) => entry.method === "permissionOutcome")?.outcome;
}

test("interactive session drives three prompt turns on one dedicated process", async () => {
  const image = { data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png", uri: "file:///tmp/screen.png" };
  const { cwd, readLog } = configure({
    initialize: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} }, promptCapabilities: { image: true } },
    },
    turns: [{ text: "one" }, { text: "two" }, { text: ["three", "!"] }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "chat" });

  assert.equal((await session.prompt("first")).text, "one");
  assert.equal((await session.prompt([{ type: "text", text: "second" }])).text, "two");
  const third = await session.prompt("third", { images: [image] });
  assert.deepEqual(third, { stopReason: "end_turn", text: "three!" });
  await session.release();

  const log = readLog();
  const newSessions = log.filter((entry) => entry.method === "newSession");
  const prompts = log.filter((entry) => entry.method === "prompt");
  const pid = pidOfFirst(log, "__start");
  assert.equal(count(log, "__start"), 1, "one dedicated process spawned");
  assert.equal(newSessions.length, 1, "one ACP session opened");
  assert.equal(prompts.length, 3, "three prompt turns sent");
  assert.ok(newSessions.every((entry) => entry.pid === pid), "session/new used the dedicated process");
  assert.ok(prompts.every((entry) => entry.pid === pid), "all turns used the same process");
  assert.deepEqual(prompts[2]?.params?.prompt, [{ type: "text", text: "third" }, { type: "image", ...image }]);
});

test("run() still completes while an interactive session is held open on the same backend", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "pooled ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });

  const out = await runner.run("one-shot", { cwd });
  assert.equal(out, "pooled ok");

  const log = readLog();
  assert.equal(count(log, "__start"), 2, "interactive and pooled paths spawned separate processes");
  assert.equal(count(log, "newSession"), 2, "held interactive session did not block run()");
  assert.equal(count(log, "prompt"), 1, "only the one-shot run prompted");
  await session.release();
});

test("per-session on() ignores events from a parallel run() session", async () => {
  const { cwd } = configure({ turns: [{ text: "event text" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd, label: "interactive" });
  const seen: Array<{ text: string; label?: string; sessionId: string }> = [];
  session.on("agent_message_chunk", (event) => {
    if (event.content.type === "text") {
      seen.push({ text: event.content.text, label: event.label, sessionId: event.sessionId });
    }
  });

  const [turn, runOut] = await Promise.all([
    session.prompt("interactive prompt"),
    runner.run("one-shot prompt", { cwd, label: "one-shot" }),
  ]);

  assert.equal(turn.text, "event text");
  assert.equal(runOut, "event text");
  assert.deepEqual(seen, [{ text: "event text", label: "interactive", sessionId: session.sessionId }]);
  await session.release();
});

test("release() closes the interactive session and dedicated process, leaving the pooled process alive", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const interactivePid = pidOfFirst(readLog(), "newSession");

  assert.equal(await runner.run("one-shot", { cwd }), "ok");
  const afterRun = readLog();
  const pooledPid = afterRun.find((entry) => entry.method === "newSession" && entry.pid !== interactivePid)?.pid;
  assert.equal(typeof pooledPid, "number", "pooled run used a different process");

  await session.release();
  const afterRelease = readLog();
  assert.ok(
    afterRelease.some((entry) => entry.method === "closeSession" && entry.pid === interactivePid),
    "interactive session was closed",
  );
  assert.ok(
    afterRelease.some((entry) => entry.method === "__exit" && entry.pid === interactivePid),
    "dedicated process exited on release",
  );
  assert.equal(
    afterRelease.some((entry) => entry.method === "__exit" && entry.pid === pooledPid),
    false,
    "pooled process remained alive until runner.dispose()",
  );
});

test("a second prompt while one is in flight throws and the active turn can be cancelled", async () => {
  const { cwd, readLog } = configure({ turns: [{ waitForCancel: true }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const first = session.prompt("wait");
  await waitFor(() => readLog().some((entry) => entry.method === "prompt"));

  await assert.rejects(
    () => session.prompt("second"),
    /InteractiveSession\.prompt\(\) already has a prompt in flight/,
  );
  await session.cancel();
  assert.deepEqual(await first, { stopReason: "cancelled", text: "" });
  await session.release();
});

test("session-level onPermissionRequest overrides the runner-level resolver", async () => {
  const { cwd, readLog } = configure({
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
  });
  let runnerResolverCalls = 0;
  let sessionResolverCalls = 0;
  const runner = makeRunner({
    onPermissionRequest: () => {
      runnerResolverCalls += 1;
      return REJECT;
    },
  });
  const session = await runner.openSession({
    cwd,
    disallowedToolNames: ["read"],
    onPermissionRequest: () => {
      sessionResolverCalls += 1;
      return ALLOW;
    },
  });

  assert.equal((await session.prompt("do it")).text, "done");
  assert.equal(runnerResolverCalls, 0);
  assert.equal(sessionResolverCalls, 1);
  assert.deepEqual(permissionOutcome(readLog()), ALLOW.outcome);
  await session.release();
});

test("signal abort releases the interactive session", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const controller = new AbortController();
  const session = await runner.openSession({ cwd, signal: controller.signal });
  const pid = pidOfFirst(readLog(), "newSession");

  controller.abort();
  await waitFor(() => {
    const log = readLog();
    return (
      log.some((entry) => entry.method === "closeSession" && entry.pid === pid) &&
      log.some((entry) => entry.method === "__exit" && entry.pid === pid)
    );
  });
  await assert.rejects(() => session.prompt("after abort"), /InteractiveSession has been released/);
});

test("runner.dispose() releases a still-open interactive session before the pool", async () => {
  const { cwd, readLog } = configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });
  const pid = pidOfFirst(readLog(), "newSession");

  await runner.dispose();
  const log = readLog();
  assert.ok(log.some((entry) => entry.method === "closeSession" && entry.pid === pid), "session closed");
  assert.ok(log.some((entry) => entry.method === "__exit" && entry.pid === pid), "process reaped");
  await assert.rejects(() => session.prompt("after dispose"), /InteractiveSession has been released/);
});
