import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect, makeRunner, NO_AGENT_SCRIPT, okRunner, persistedRunFile, structured, TEST_HOME, textOf, waitForRun } from "./_harness.js";
import { WorkflowNotificationClaims } from "../src/workflow-notifications.js";

test("run returns once preparation succeeded and execution started; the persisted run is already admitted", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "done"; }), { listTools: true });
  const input = { action: "run", script: 'export const meta = { name: "sync-prep", description: "prepared inside the request", model: "claude" }; return await agent("work");' };
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.equal(accepted.isError, false, textOf(accepted));
    const acknowledgement = structured(accepted)!;
    assert.equal(acknowledgement.accepted, true);
    assert.equal(acknowledgement.status, "running", "a validated script is admitted before the acknowledgement");
    assert.equal(acknowledgement.setup, undefined);
    assert.equal(acknowledgement.result, undefined);
    assert.equal("requestId" in acknowledgement, false);
    assert.equal("duplicate" in acknowledgement, false);
    const runId = String(acknowledgement.runId);
    const durable = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8"));
    assert.equal(durable.script, input.script);
    assert.equal(durable.admission?.format, 3, "admission is the first and only persistence of the run");
    assert.equal(durable.preparation, undefined);
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.equal(calls, 1);
    const again = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.notEqual(structured(again)?.runId, runId, "identical inputs start an independent run");
    await waitForRun(conn.client, String(structured(again)?.runId));
    assert.equal(calls, 2);
  } finally { await conn.dispose(); }
});

test("scriptPath is read when the run is admitted; later edits do not change the admitted run", async () => {
  const scriptPath = join(mkdtempSync(join(tmpdir(), "workflow-accepted-path-")), "workflow.js");
  writeFileSync(scriptPath, NO_AGENT_SCRIPT);
  const conn = await connect(okRunner());
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: { action: "run", scriptPath } });
    assert.equal(accepted.isError, false, textOf(accepted));
    assert.equal(structured(accepted)?.scriptSource, "path");
    const runId = String(structured(accepted)?.runId);
    writeFileSync(scriptPath, 'throw new Error("changed");');
    const completed = await waitForRun(conn.client, runId);
    assert.equal((structured(completed)?.outcome as { result: unknown }).result, 42);
    const durable = JSON.parse(readFileSync(persistedRunFile(runId)!, "utf8"));
    assert.equal(durable.script, NO_AGENT_SCRIPT);
  } finally { await conn.dispose(); }
});

test("setup approval is durable and addressable without an App or a held elicitation", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "approved"; }), { listTools: true });
  const input = { action: "run", script: 'export const meta = { name: "setup", description: "approval", backends: { custom: { command: "custom-acp" } } }; return 42;' };
  try {
    const accepted = await conn.client.callTool({ name: "workflow", arguments: input });
    assert.equal(accepted.isError, false, textOf(accepted));
    assert.equal(structured(accepted)?.status, "pending", "a declared backend parks the validated run in setup");
    const runId = String(structured(accepted)?.runId);
    const setup = (structured(accepted)?.setup as { state: string; request: { id: string; kind: string } });
    assert.equal(setup.state, "input-required");
    assert.equal(setup.request.kind, "backend-approval");
    const waiting = await waitForRun(conn.client, runId, (status) => (status.setup as { state?: string })?.state === "input-required");
    assert.deepEqual(structured(waiting)?.setup, setup, "status reports the same durable request");
    assert.equal(calls, 0);
    const response = { action: "setup-response", runId, setupId: setup.request.id, response: { action: "accept", content: { approve: true } } };
    const acknowledged = await conn.client.callTool({ name: "workflow", arguments: response });
    assert.equal(acknowledged.isError, false, textOf(acknowledged));
    const completed = await waitForRun(conn.client, runId);
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    const repeated = await conn.client.callTool({ name: "workflow", arguments: response });
    assert.equal(repeated.isError, false, textOf(repeated));
    const conflict = await conn.client.callTool({ name: "workflow", arguments: { ...response, response: { action: "decline" } } });
    assert.equal(conflict.isError, true);
  } finally { await conn.dispose(); }
});

test("malformed and invalid sources are tool execution errors that persist no run", async () => {
  let calls = 0;
  const conn = await connect(makeRunner(() => { calls++; return "unexpected"; }));
  try {
    const malformed = await conn.client.callTool({ name: "workflow", arguments: { action: "run", script: "not a workflow" } });
    assert.equal(malformed.isError, true);
    assert.equal(structured(malformed)?.runId, undefined);
    assert.match(textOf(malformed), /not started/);
    const invalid = await conn.client.callTool({ name: "workflow", arguments: { action: "run", script: 'export const meta = { name: "invalid-call", description: "valid structure" }; return agent("work", { unknownOption: true });' } });
    assert.equal(invalid.isError, true, textOf(invalid));
    assert.equal(structured(invalid)?.runId, undefined, "a rejected preparation creates no run");
    assert.match(textOf(invalid), /unknownOption|not started/);
    assert.equal(calls, 0);
    const healthy = await conn.client.callTool({ name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT } });
    assert.equal(healthy.isError, false, "a rejected preparation releases its capacity slot");
    await waitForRun(conn.client, String(structured(healthy)?.runId));
  } finally { await conn.dispose(); }
});

test("notification leases suppress simultaneous views, release failures, and retain sent receipts", () => {
  let now = 0;
  const claims = new WorkflowNotificationClaims(() => now);
  const base = { runId: "run-a", eventId: "terminal:stream:9", viewId: randomUUID() };
  const first = claims.handle("host-a", { ...base, action: "claim" });
  assert.equal("send" in first && first.send, true);
  const token = "token" in first ? first.token : undefined;
  assert.deepEqual(claims.handle("host-a", { ...base, viewId: randomUUID(), action: "claim" }), { send: false });
  claims.handle("host-a", { ...base, action: "release", token });
  const retry = claims.handle("host-a", { ...base, action: "claim" });
  const retryToken = "token" in retry ? retry.token : undefined;
  claims.handle("host-a", { ...base, action: "sent", token: retryToken });
  now = 60_000;
  assert.deepEqual(claims.handle("host-a", { ...base, action: "claim" }), { send: false });
  const otherHost = claims.handle("host-b", { ...base, action: "claim" });
  assert.equal("send" in otherHost && otherHost.send, true);
});

test("cancelling the request during a live probe abandons preparation: no run, no agent, capacity released", async () => {
  let releaseProbe!: () => void;
  let probeEntered!: () => void;
  const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
  const held = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let liveCalls = 0;
  const runner = makeRunner(() => { liveCalls++; return "unexpected"; });
  runner.probeConfigOptions = async () => {
    probeEntered();
    await held;
    return { backendId: "codex", options: [] };
  };
  const conn = await connect(runner, { listTools: true });
  const script = 'export const meta = { name: "held-probe", description: "cancelled preparation", model: "codex" }; return agent("work");';
  try {
    const before = new Set(persistedRunIds());
    const controller = new AbortController();
    const cancelled = conn.client.callTool({ name: "workflow", arguments: { action: "run", script } }, { signal: controller.signal });
    cancelled.catch(() => undefined);
    await entered;
    controller.abort();
    await assert.rejects(cancelled);
    releaseProbe();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(liveCalls, 0);
    assert.deepEqual([...persistedRunIds()].filter((runId) => !before.has(runId)), [], "a cancelled preparation persists nothing");
    runner.probeConfigOptions = async () => ({ backendId: "codex", options: [] });
    const afterwards = await conn.client.callTool({ name: "workflow", arguments: { action: "run", script } });
    assert.equal(afterwards.isError, false, textOf(afterwards));
    const completed = await waitForRun(conn.client, String(structured(afterwards)?.runId));
    assert.equal(structured(completed)?.status, "completed", textOf(completed));
    assert.equal(liveCalls, 1);
  } finally { releaseProbe(); await conn.dispose(); }
});

/** Every run id currently persisted in the isolated test home. */
function persistedRunIds(): string[] {
  const ids: string[] = [];
  const visit = (dir: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".json") && entry.name !== "project.json") ids.push(entry.name.slice(0, -".json".length));
    }
  };
  visit(join(TEST_HOME, ".agentprism", "workflows"));
  return ids;
}
