// SESSION HAND-OFF from the one-shot run() path — end-to-end against the MOCK ACP agent
// (test/fixtures/fake-acp-agent.mjs).
//
// run() historically discarded the ACP session id at release, so a completed agent was
// unrecoverable even though the protocol (session/load|resume) and the runner's reattach
// API (loadSession/resumeSession) both support it. These tests prove the hand-off contract:
//   - onSessionOpen fires once with the re-attach ref: the REAL session id, the backend
//     routing id, the session cwd, and reopen flags that MIRROR the agent's advertisement.
//   - keepSession: true skips the release-time best-effort session/close (default keeps it).
//   - a kept session re-opens live via runner.loadSession() using nothing but the ref.
//   - InteractiveSession exposes the same ref (sessionRef) and honors keepSession at release.
//   - onSessionOpen is a best-effort observer: a throwing host callback never fails the run.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionRef } from "@automatalabs/shared-types";
import { AcpAgentRunner } from "../src/index.js";
import { createFakeAgentHarness } from "./helpers/fake-agent.js";

interface LogEntry {
  method: string;
  params?: { sessionId?: string; cwd?: string };
}

const harness = createFakeAgentHarness({ prefix: "acp-session-handoff-", backends: ["claude"] });
const configure = (scenario: unknown) => harness.configure<LogEntry>(scenario);

const count = (entries: LogEntry[], method: string): number =>
  entries.filter((e) => e.method === method).length;

function makeRunner(): AcpAgentRunner {
  return harness.makeRunner();
}

afterEach(async () => {
  await harness.cleanup();
});

test("onSessionOpen hands out the re-attach ref: real session id, backend, cwd, advertised reopen surface", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ text: "ok" }] });
  const runner = makeRunner();

  let ref: AgentSessionRef | undefined;
  const out = await runner.run("hi", { cwd, onSessionOpen: (session) => (ref = session) });

  assert.equal(out, "ok");
  assert.ok(ref, "onSessionOpen fired");
  assert.equal(ref.backendId, "claude");
  assert.equal(ref.cwd, cwd);
  // lifecycleSupport advertises loadSession + sessionCapabilities.resume/.list -> all reopen paths.
  assert.deepEqual(ref.reopen, { load: true, resume: true, list: true });
  // The ref names the SAME session the runner then released — not an invented id.
  const closedIds = readLog()
    .filter((e) => e.method === "closeSession")
    .map((e) => e.params?.sessionId);
  assert.deepEqual(closedIds, [ref.sessionId]);
});

test("reopen flags mirror a non-persisting agent: all false when load/resume/list are unadvertised", async () => {
  const { cwd } = configure({ turns: [{ text: "ok" }] }); // close-only advertisement
  const runner = makeRunner();

  let ref: AgentSessionRef | undefined;
  await runner.run("hi", { cwd, onSessionOpen: (session) => (ref = session) });

  assert.ok(ref);
  assert.deepEqual(ref.reopen, { load: false, resume: false, list: false });
});

test("keepSession: true skips the release-time session/close; the default still closes", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ text: "a" }, { text: "b" }] });
  const runner = makeRunner();

  await runner.run("kept", { cwd, keepSession: true });
  assert.equal(count(readLog(), "closeSession"), 0, "kept session was NOT closed");

  await runner.run("closed", { cwd });
  assert.equal(count(readLog(), "closeSession"), 1, "default run still closes its session");
});

test("a kept session re-opens live via loadSession() from nothing but the ref", async () => {
  const { cwd, readLog } = configure({
    lifecycleSupport: true,
    loadSession: { replay: ["prior "] },
    turns: [{ text: "plan done" }],
  });
  const runner = makeRunner();

  let ref: AgentSessionRef | undefined;
  const plan = await runner.run("produce the plan", {
    cwd,
    keepSession: true,
    onSessionOpen: (session) => (ref = session),
  });
  assert.equal(plan, "plan done");
  assert.ok(ref);
  assert.equal(ref.reopen.load, true);

  // The round trip the ref exists for: persist { sessionId, cwd, backendId }, re-open later.
  const chat = await runner.loadSession({ sessionId: ref.sessionId, cwd: ref.cwd, model: ref.backendId });
  assert.equal(chat.sessionId, ref.sessionId);
  const loaded = readLog().filter((e) => e.method === "loadSession");
  assert.deepEqual(
    loaded.map((e) => e.params?.sessionId),
    [ref.sessionId],
    "session/load was sent for exactly the handed-out id",
  );
  await chat.release();
});

test("InteractiveSession exposes the same ref (sessionRef) and honors keepSession at release", async () => {
  const { cwd, readLog } = configure({ lifecycleSupport: true, turns: [{ text: "t1" }, { text: "t2" }] });
  const runner = makeRunner();

  const kept = await runner.openSession({ cwd, keepSession: true });
  assert.equal(kept.sessionRef.sessionId, kept.sessionId);
  assert.equal(kept.sessionRef.backendId, "claude");
  assert.equal(kept.sessionRef.cwd, cwd);
  assert.deepEqual(kept.sessionRef.reopen, { load: true, resume: true, list: true });
  await kept.release();
  assert.equal(count(readLog(), "closeSession"), 0, "kept interactive session was NOT closed");

  const closed = await runner.openSession({ cwd });
  await closed.release();
  assert.equal(count(readLog(), "closeSession"), 1, "default interactive release still closes");
});

test("a throwing onSessionOpen callback is isolated and never fails the run", async () => {
  const { cwd } = configure({ turns: [{ text: "ok" }] });
  const runner = makeRunner();

  const out = await runner.run("hi", {
    cwd,
    onSessionOpen: () => {
      throw new Error("host observer bug");
    },
  });
  assert.equal(out, "ok");
});
