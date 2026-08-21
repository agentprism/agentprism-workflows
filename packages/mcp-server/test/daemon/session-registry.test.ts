// SessionRegistry: connections vs requests are tracked separately, and the lame-duck
// migration (`evictDrainable`) never cuts a session with a request in flight or one the
// daemon vetoes (a REPL workspace mid-turn).
import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionRegistry, type SessionRecord } from "../../src/daemon/session-registry.js";

function fakeRecord(registry: SessionRegistry, sessionId: string): { closed: boolean } {
  const state = { closed: false };
  const transport = {
    close: async () => {
      state.closed = true;
      registry.delete(sessionId);
    },
  } as unknown as SessionRecord["transport"];
  registry.add({ sessionId, transport, server: {} as never, lastActivityAt: Date.now(), openConnections: 0 });
  return state;
}

test("requests and connections are counted independently; evictDrainable skips in-flight and vetoed sessions", () => {
  const registry = new SessionRegistry();
  const idle = fakeRecord(registry, "idle"); // GET stream only
  const busy = fakeRecord(registry, "busy"); // a POST being processed
  const vetoed = fakeRecord(registry, "vetoed"); // REPL workspace mid-turn
  registry.connectionOpened("idle");
  registry.connectionOpened("busy");
  registry.requestStarted("busy");
  assert.equal(registry.inflightCount(), 1);
  assert.equal(registry.get("busy")?.openConnections, 1);

  const migrated = registry.evictDrainable((sessionId) => sessionId === "vetoed");
  assert.deepEqual(migrated, ["idle"]);
  assert.equal(idle.closed, true);
  assert.equal(busy.closed, false, "a session with a request in flight is never cut");
  assert.equal(vetoed.closed, false, "a vetoed session is kept");
  assert.equal(registry.size, 2);

  // The request finishes → the session becomes drainable.
  registry.requestFinished("busy");
  registry.connectionClosed("busy");
  assert.equal(registry.inflightCount(), 0);
  assert.deepEqual(registry.evictDrainable(), ["busy", "vetoed"]);
  assert.equal(registry.size, 0);
});

test("requestFinished never underflows and touches only known sessions", () => {
  const registry = new SessionRegistry();
  fakeRecord(registry, "a");
  registry.requestFinished("a");
  registry.requestFinished("unknown");
  assert.equal(registry.get("a")?.inflightRequests, 0);
  assert.equal(registry.inflightCount(), 0);
});
