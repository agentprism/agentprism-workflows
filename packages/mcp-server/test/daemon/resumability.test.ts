// Spec resumability end-to-end: a client that vanishes mid-call reconnects with the
// priming event's ID via GET + Last-Event-ID and receives the stored tool response. This
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";

// exercises the BoundedEventStore through the real SDK transports, not in isolation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { structured, ONE_AGENT_SCRIPT } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon } from "../_http-harness.js";

test("a dropped foreground call's response is replayed via GET + Last-Event-ID", async () => {
  const { runner, release } = gatedRunner();
  const projectDir = makeProjectDir("resume-project");
  const daemon = await startDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    const sessionId = session.transport.sessionId;
    assert.ok(sessionId, "session id should be captured after initialize");

    // Fire a foreground call; capture the resumption token from the stream's priming event.
    let resumptionToken: string | undefined;
    const pending = session.client.request(
      {
        method: "tools/call",
        params: { name: "workflow", arguments: { script: ONE_AGENT_SCRIPT, projectDir } },
      },
      { onresumptiontoken: (token) => (resumptionToken = token) },
    );
    pending.catch(() => undefined); // The deliberate disconnect below rejects it.

    await waitFor(() => resumptionToken !== undefined, "priming event token");

    // Client dies mid-call: sockets abort, no DELETE, no CancelledNotification.
    await session.transport.close();

    // Spec: disconnect is NOT cancellation — the tool keeps executing server-side.
    release();
    await waitFor(() => daemon.sessions.values()[0]?.openConnections === 0, "connections drained");

    // Reconnect into the SAME session and resume the dropped stream.
    const resumed = new StreamableHTTPClientTransport(new URL(daemon.url), { sessionId });
    const received: JSONRPCMessage[] = [];
    resumed.onmessage = (message) => received.push(message);
    await resumed.start();
    await resumed.resumeStream(resumptionToken as string, {});

    await waitFor(
      () => received.some((m) => "result" in m && (m as { id?: unknown }).id !== undefined),
      "replayed tool response",
    );
    const response = received.find((m) => "result" in m) as { result: { structuredContent?: unknown } };
    const structuredResult = response.result.structuredContent as Record<string, unknown>;
    assert.equal(structuredResult.status, "completed");
    assert.ok(structured({ structuredContent: structuredResult } as never));
    await resumed.close();
  } finally {
    await daemon.close();
  }
});

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
