import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAcpRunner, WorkflowManager, type AgentSessionRecord } from "../src/index.js";

const FAKE_AGENT_FIXTURE = fileURLToPath(
  new URL("../../acp-agents/test/fixtures/fake-acp-agent.mjs", import.meta.url),
);

const SCRIPT = `export const meta = { name: 'persisted-custom-session', description: 'persist a custom ACP session' }
const reply = await agent('start persisted custom session', {
  label: 'persisted-custom',
  model: 'fake',
  keepSession: true
})
return reply`;

interface LogEntry {
  method: string;
  params?: { sessionId?: string; cwd?: string };
}

function readLog(path: string): LogEntry[] {
  const contents = readFileSync(path, "utf8").trim();
  if (!contents) return [];
  return contents.split("\n").map((line) => JSON.parse(line) as LogEntry);
}

test("persisted custom-backend session records load and continue through the workflows facade", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflows-persisted-session-cwd-"));
  const persistenceRoot = mkdtempSync(join(tmpdir(), "workflows-persisted-session-root-"));
  const log = join(persistenceRoot, "fake-agent.jsonl");
  const scenario = JSON.stringify({ lifecycleSupport: true, turns: [{ echoPrompt: true }] });
  const runner = createAcpRunner({
    backends: {
      fake: {
        command: process.execPath,
        args: [FAKE_AGENT_FIXTURE],
        env: {
          AGENTPRISM_FAKE_SCENARIO: scenario,
          AGENTPRISM_FAKE_LOG: log,
        },
      },
    },
  });
  const writer = new WorkflowManager({ agent: runner, cwd, persistenceRoot });
  let fresh: WorkflowManager | undefined;

  try {
    const run = await writer.runSync(SCRIPT);
    assert.equal(run.status, "completed");
    assert.match(String(run.result), /start persisted custom session$/);

    fresh = new WorkflowManager({ cwd, persistenceRoot });
    const records: AgentSessionRecord[] | undefined = fresh.getPersistedAgentSessions(run.runId);
    assert.equal(records?.length, 1);
    const record = records?.[0];
    assert.ok(record, "the fresh facade manager recovers the kept session record from disk");
    assert.equal(record.backendId, "fake", "the registered backend name is the reload routing spec");
    assert.equal(record.cwd, cwd);
    assert.equal(record.keptOpen, true);
    assert.equal(record.reopen.load, true);
    assert.equal(record.callIndex, 0);
    assert.equal(record.label, "persisted-custom");
    assert.equal(record.sessionId, run.agentSessions?.[0]?.sessionId);

    const session = await runner.loadSession({
      sessionId: record.sessionId,
      cwd: record.cwd,
      model: record.backendId,
    });
    try {
      assert.equal(session.sessionId, record.sessionId);
      assert.equal((await session.prompt("continue persisted session")).text, "continue persisted session");
    } finally {
      await session.release();
    }

    const loadCall = readLog(log).find((entry) => entry.method === "loadSession");
    assert.equal(loadCall?.params?.sessionId, record.sessionId);
    assert.equal(loadCall?.params?.cwd, record.cwd);
  } finally {
    fresh?.dispose();
    writer.dispose();
    await runner.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
