// R0 acceptance (docs/roadmap/workflow-permission-model.md §R0): the daemon HTTP face must stay
// responsive while its event-serving path drains a large journal. Two production daemon respawns
// traced to watchEvents re-parsing the whole journal once per record yielded — a measured
// 115.8-second synchronous main-thread block for a 500-record catch-up on a 9.7 MB journal — which
// starved the /healthz probe past its 2-second budget and blew every in-flight await's waitMs.
//
// This exercise runs a real createDaemon() on loopback with a real MCP client, grows a run's
// journal to >= 20,000 records, then loads the daemon's event loop with the exact catch-up the
// outage hit — a watchEvents drain of the full backlog on the daemon's own manager — while a real
// events subscription and a real in-flight await are both active, and asserts /healthz keeps
// answering within 2 seconds throughout. Pre-fix the per-record whole-file re-parse monopolises
// the shared loop and the probe cannot be serviced within budget; post-fix the drain is served
// from the writer's cached view and yields the loop between records.
import assert from "node:assert/strict";
import { test } from "node:test";

import { structured, textOf, NO_AGENT_SCRIPT, ONE_AGENT_SCRIPT } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon, waitUntil } from "../_http-harness.js";

const HEALTHZ_BUDGET_MS = 2_000;
const JOURNAL_RECORDS = 20_000;
const LAG_RECORDS = 5_000;

async function probeHealthz(port: number): Promise<number> {
  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(HEALTHZ_BUDGET_MS),
  });
  const elapsed = Date.now() - start;
  assert.equal(response.status, 200, "/healthz must answer 200");
  const body = (await response.json()) as { name: string };
  assert.equal(body.name, "agentprism-daemon");
  return elapsed;
}

test(
  "/healthz answers within its 2s budget while the event path drains a >=20k-record journal",
  async () => {
    // NO_AGENT_SCRIPT never invokes the runner, so the growable run completes immediately even
    // though the runner gate stays shut; ONE_AGENT_SCRIPT does invoke it, giving a genuinely
    // in-flight run to await while the gate is held.
    const { runner, release } = gatedRunner();
    const daemon = await startDaemon(runner);
    const projectDir = makeProjectDir("event-drain-bounds");
    let released = false;
    try {
      const session = await connectHttp(daemon.url);

      // A real completed run whose journal we then grow to >= 20,000 records via its project's own
      // persistence, leaving the snapshot watermark trailing by LAG_RECORDS exactly as the daemon's
      // save cadence lags its append cadence.
      const created = await session.client.callTool({
        name: "workflow",
        arguments: { script: NO_AGENT_SCRIPT, projectDir },
      });
      assert.equal(created.isError ?? false, false, textOf(created));
      const runId = structured(created)?.runId as string;
      assert.ok(runId);

      const context = daemon.projects.storeFor(runId);
      assert.ok(context, "the growable run must resolve to a project store");
      const persistence = context.manager.getPersistence();
      const seeded = persistence.load(runId);
      assert.ok(seeded?.eventStreamId && seeded.eventSeq !== undefined);
      const streamId = seeded.eventStreamId;
      let seq = seeded.eventSeq;
      for (let index = 0; index < JOURNAL_RECORDS; index++) {
        const record = persistence.appendEvent(runId, {
          seq: seq + 1,
          timestamp: new Date().toISOString(),
          event: { type: "log", runId, scope: runId, message: `drain-${index}` },
        });
        seq = record.seq;
      }
      const tail = persistence.readEvents(runId, { limit: 1, streamId }).endCursor;
      assert.ok(tail >= JOURNAL_RECORDS, `journal should hold >= ${JOURNAL_RECORDS} records, has ${tail}`);
      // Publish a watermark that trails the tail by LAG_RECORDS (a genuinely lagging cursor).
      persistence.save({ ...seeded, eventSeq: tail - LAG_RECORDS });

      // A genuinely in-flight await: ONE_AGENT_SCRIPT invokes the gated runner, so this background
      // run stays "running" and the await below blocks on the event path until the gate is released.
      const inflight = await session.client.callTool({
        name: "workflow",
        arguments: { script: ONE_AGENT_SCRIPT, background: true, projectDir },
      });
      assert.equal(inflight.isError ?? false, false, textOf(inflight));
      const inflightRunId = structured(inflight)?.runId as string;
      assert.ok(inflightRunId);
      await waitUntil(() => daemon.activeRunCount() === 1, "the gated run should be running");
      const awaiting = session.client.callTool({
        name: "workflow",
        arguments: { action: "status", runId: inflightRunId, waitMs: 15_000 },
      });

      // A real events subscription over the grown run (arms the daemon's watcher/notification path).
      await session.client.subscribeResource({ uri: `workflow://runs/${runId}/events` });

      // Load the daemon's event loop with the exact catch-up the outage hit: drain the whole
      // backlog through the daemon manager's real watchEvents. Pre-fix each record cost one
      // whole-journal re-parse; the drain would hold the shared loop for many minutes and no
      // /healthz probe could be serviced within 2 s.
      let drainedCount = 0;
      const drain = (async () => {
        const stream = persistence.watchEvents(runId, { after: 0, streamId });
        try {
          while (drainedCount < tail) {
            const next = await stream.next();
            if (next.done) break;
            drainedCount += 1;
          }
        } finally {
          stream.close();
        }
      })();

      // Probe /healthz repeatedly while the drain, the subscription, and the in-flight await are all
      // live. Every probe must answer within budget.
      const elapsedProbes: number[] = [];
      for (let probe = 0; probe < 5; probe++) {
        elapsedProbes.push(await probeHealthz(daemon.port));
      }
      await drain;
      elapsedProbes.push(await probeHealthz(daemon.port));

      for (const elapsed of elapsedProbes) {
        assert.ok(elapsed < HEALTHZ_BUDGET_MS, `/healthz answered in ${elapsed}ms (budget ${HEALTHZ_BUDGET_MS}ms)`);
      }
      assert.equal(drainedCount, tail, "the full backlog must drain");

      // The in-flight await stays answerable too: releasing the gate settles it promptly.
      released = true;
      release();
      const settled = await awaiting;
      assert.equal(settled.isError ?? false, false, textOf(settled));
      assert.equal(structured(settled)?.status, "completed");

      await session.dispose();
    } finally {
      if (!released) release();
      await daemon.close();
    }
  },
);
