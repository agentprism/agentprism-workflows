import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, RequestPermissionResponse, SessionModeState } from "@agentclientprotocol/sdk";
import { isWorkflowError, WorkflowErrorCode } from "@automatalabs/shared-types";
import { AGENT_METHODS, AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

const ALLOW: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow-1" } };

const MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
};

interface LogEntry {
  method: string;
  phase?: string;
  outcome?: RequestPermissionResponse["outcome"];
  params?: {
    sessionId?: string;
    cwd?: string;
    cursor?: string;
    modeId?: string;
    prompt?: ContentBlock[];
    mcpServers?: unknown[];
    _meta?: Record<string, unknown>;
  };
}

const harness = createFakeAgentHarness({ prefix: "acp-session-lifecycle-it-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

function methods(log: LogEntry[]): string[] {
  return log.map((entry) => entry.method).filter((method) => !method.startsWith("__"));
}

function permissionOutcomes(log: LogEntry[]): Array<RequestPermissionResponse["outcome"] | undefined> {
  return log.filter((entry) => entry.method === "permissionOutcome").map((entry) => entry.outcome);
}

afterEach(async () => {
  await harness.cleanup();
});

test("loadSession routes replay updates and permissions before resolving", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: {
      replay: ["loaded ", "history"],
      toolCall: { title: "Read replay", kind: "read" },
    },
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();

  const session = await runner.loadSession({ cwd, sessionId: "persisted-load", toolNames: ["read"] });

  assert.equal(session.sessionId, "persisted-load");
  assert.equal(session.text, "loaded history");
  assert.deepEqual(
    session.history.map((entry) => entry.text),
    ["loaded ", "history"],
  );
  assert.deepEqual(permissionOutcomes(readLog()), [ALLOW.outcome]);
  await session.release();
});

test("a prompt after loadSession receives a real permission decision, not unknown-session cancellation", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { replay: ["prior"] },
    turns: [{ toolCall: { title: "Read file", kind: "read" }, text: "done" }],
  });
  const runner = makeRunner();
  const session = await runner.loadSession({ cwd, sessionId: "persisted-permission" });

  assert.equal((await session.prompt("continue")).text, "done");

  const outcomes = permissionOutcomes(readLog());
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], ALLOW.outcome);
  await session.release();
});

test("resumeSession returns a live session without replaying history", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    resumeSession: { modes: MODES },
    turns: [{ text: "resumed" }],
  });
  const runner = makeRunner();
  const session = await runner.resumeSession({ cwd, sessionId: "persisted-resume" });

  assert.equal(session.text, "");
  assert.deepEqual(session.history, []);
  assert.equal((await session.prompt("continue")).text, "resumed");

  const wire = methods(readLog());
  assert.ok(wire.indexOf("resumeSession") < wire.indexOf("prompt"));
  assert.equal(wire.includes("loadSession"), false);
  await session.release();
});

test("listSessions and deleteSession round-trip through the selected backend", async () => {
  const savedCwd = "/tmp/saved-session";
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    listSessions: {
      sessions: [{ sessionId: "s1", cwd: savedCwd, title: "Saved", updatedAt: "2026-07-06T00:00:00.000Z" }],
      nextCursor: "next-page",
    },
  });
  const runner = makeRunner();

  const listed = await runner.listSessions({
    model: "claude",
    cwd,
    cursor: "cursor-1",
    meta: { source: "test" },
  });
  await runner.deleteSession({ model: "claude", sessionId: "s1", meta: { source: "test" } });

  assert.deepEqual(listed, {
    sessions: [{ sessionId: "s1", cwd: savedCwd, title: "Saved", updatedAt: "2026-07-06T00:00:00.000Z" }],
    nextCursor: "next-page",
  });
  const listCall = readLog().find((entry) => entry.method === "listSessions");
  assert.equal(listCall?.params?.cwd, cwd);
  assert.equal(listCall?.params?.cursor, "cursor-1");
  assert.deepEqual(listCall?.params?._meta, { source: "test" });
  const deleteCall = readLog().find((entry) => entry.method === "deleteSession");
  assert.equal(deleteCall?.params?.sessionId, "s1");
});

test("lifecycle capability gate names the backend, method, and advertisement", async () => {
  configure({ turns: [{ text: "unused" }] });
  const runner = makeRunner();

  await assert.rejects(
    () => runner.listSessions({ model: "claude" }),
    (error: unknown) => {
      assert.ok(isWorkflowError(error));
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.equal(error.recoverable, false);
      assert.match(error.message, /claude/);
      assert.match(error.message, /session\/list/);
      assert.match(error.message, /loadSession=false/);
      assert.match(error.message, /sessionCapabilities=close/);
      return true;
    },
  );
});

test("raw passthrough guards stateful session methods but leaves safe methods open", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    modes: MODES,
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();
  const session = await runner.openSession({ cwd });

  await assert.rejects(
    () => session.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] }),
    /use openSession\(\).+unregistered.+permission requests auto-cancel/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_load, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /use loadSession\(\).+unregistered.+fs\/terminal dispatch fails/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_resume, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /use resumeSession\(\).+unregistered/s,
  );
  await assert.rejects(
    () => session.request(AGENT_METHODS.session_fork, { sessionId: session.sessionId, cwd, mcpServers: [] }),
    /no driven wrapper yet; raw forked sessions cannot be routed \(permissions auto-cancel\)/,
  );

  await session.request(AGENT_METHODS.session_set_mode, { sessionId: session.sessionId, modeId: "plan" });
  assert.equal(
    readLog().some((entry) => entry.method === "setSessionMode" && entry.params?.modeId === "plan"),
    true,
  );
  await session.release();
});

test("loadSession({ mode }) applies strictly from the response mode catalog", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { modes: MODES },
    turns: [{ text: "unused" }],
  });
  const runner = makeRunner();

  const session = await runner.loadSession({ cwd, sessionId: "persisted-mode", mode: "plan" });

  assert.equal(session.modes?.currentModeId, "plan");
  await session.release();
  const wire = methods(readLog());
  assert.ok(wire.indexOf("setSessionMode") > wire.indexOf("loadSession"));
  assert.ok(wire.indexOf("setSessionMode") < wire.indexOf("closeSession"));
});
