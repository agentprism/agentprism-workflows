// Over the shared daemon, a run's channel notifications reach the session that admitted it and
// any session that inspected it, and no one else. Each session has its own server instance, so
// "which client" is answered by where the tool call ran.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CLAUDE_CHANNEL_NOTIFICATION, type ClaudeChannelNotificationParams } from "../../src/channel-notifier.js";
import { ONE_AGENT_SCRIPT, structured, textOf } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon, waitUntil, type HttpConnected } from "../_http-harness.js";

function capture(session: HttpConnected): ClaudeChannelNotificationParams[] {
  const received: ClaudeChannelNotificationParams[] = [];
  session.client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === CLAUDE_CHANNEL_NOTIFICATION) {
      received.push(notification.params as unknown as ClaudeChannelNotificationParams);
    }
  };
  return received;
}

test("channel notifications go to the admitting session and to a session that inspected the run", async () => {
  const { runner, release } = gatedRunner();
  const daemon = await startDaemon(runner);
  const projectDir = makeProjectDir("channel-project");
  try {
    const [admitter, inspector, bystander] = await Promise.all([
      connectHttp(daemon.url),
      connectHttp(daemon.url),
      connectHttp(daemon.url),
    ]);
    const received = { admitter: capture(admitter), inspector: capture(inspector), bystander: capture(bystander) };

    const started = await admitter.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, projectDir },
    });
    const runId = structured(started)?.runId as string;
    assert.ok(runId, textOf(started));

    // The agent is blocked on the gate, so this inspection happens while the run is live.
    const inspected = await inspector.client.callTool({ name: "workflow", arguments: { action: "status", runId } });
    assert.equal(inspected.isError, false, textOf(inspected));

    release();
    await waitUntil(
      () => received.admitter.length === 1 && received.inspector.length === 1,
      "terminal channel notifications on both attached sessions",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.bystander.length, 0, "a session that never named the run receives nothing");
    for (const notice of [received.admitter[0]!, received.inspector[0]!]) {
      assert.equal(notice.meta.run_id, runId);
      assert.equal(notice.meta.kind, "terminal");
      assert.equal(notice.meta.status, "completed");
      assert.match(notice.content, /Run completed/);
    }

    await Promise.all([admitter.dispose(), inspector.dispose(), bystander.dispose()]);
  } finally {
    await daemon.close();
  }
});
