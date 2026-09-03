// createDaemon() integration: real HTTP on loopback, real SDK clients. Proves the daemon
// invariants the migration exists for — sessions are cheap, project-agnostic, and
// disposable; every run names its project via the required projectDir argument; runId
// actions route to the right store from any session; and dead clients never take runs
// down with them.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { okRunner, structured, textOf, persistedRunFile, NO_AGENT_SCRIPT, ONE_AGENT_SCRIPT, TEST_HOME } from "../_harness.js";
import { connectHttp, gatedRunner, makeProjectDir, startDaemon } from "../_http-harness.js";
import { createDaemon } from "../../src/daemon/http-daemon.js";
import { SESSION_IDLE_TTL_MS } from "../../src/daemon/constants.js";

test("initialize + foreground workflow call over real Streamable HTTP", async () => {
  const daemon = await startDaemon(okRunner());
  const projectDir = makeProjectDir("basic-project");
  try {
    const session = await connectHttp(daemon.url, { listTools: true });
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir },
    });
    assert.equal(result.isError ?? false, false, textOf(result));
    assert.equal(structured(result)?.status, "completed");

    const health = await fetch(`http://127.0.0.1:${daemon.port}/healthz`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { name: string; pid: number; sessions: number };
    assert.equal(body.name, "agentprism-daemon");
    assert.equal(body.pid, process.pid);
    assert.ok(body.sessions >= 1);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("run without projectDir is rejected with a clear InvalidParams error", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const session = await connectHttp(daemon.url);
    const result = await session.client.callTool({ name: "workflow", arguments: { action: "run", script: NO_AGENT_SCRIPT } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /run requires projectDir/);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("a nonexistent projectDir is rejected before any engine state is created", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const session = await connectHttp(daemon.url);
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir: join(TEST_HOME, "does-not-exist") },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /projectDir does not exist/);
    assert.equal(daemon.projects.stores().length, 0, "no project context should have been created");
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("background run started in one session is observed from another — runId alone routes it", async () => {
  const { runner, release } = gatedRunner();
  const projectDir = makeProjectDir("shared-project");
  const daemon = await startDaemon(runner);
  try {
    const a = await connectHttp(daemon.url);
    const b = await connectHttp(daemon.url);
    const started = await a.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, background: true, projectDir },
    });
    assert.equal(started.isError ?? false, false, textOf(started));
    const runId = structured(started)?.runId as string;
    assert.ok(runId);
    assert.equal(daemon.activeRunCount(), 1);

    release();
    // Session B never named the project: await routes by locating the runId's store.
    const awaited = await b.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(awaited.isError ?? false, false, textOf(awaited));
    assert.equal(structured(awaited)?.status, "completed");
    await a.dispose();
    await b.dispose();
  } finally {
    await daemon.close();
  }
});

test("one session runs two projects; runs persist under distinct project keys", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const projectA = makeProjectDir("proj-alpha");
    const projectB = makeProjectDir("proj-beta");
    const session = await connectHttp(daemon.url);
    const resultA = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir: projectA },
    });
    const resultB = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir: projectB },
    });
    const runA = structured(resultA)?.runId as string;
    const runB = structured(resultB)?.runId as string;
    const fileA = persistedRunFile(runA);
    const fileB = persistedRunFile(runB);
    assert.ok(fileA && fileB);
    const projectKeyOf = (runFile: string) => basename(dirname(dirname(runFile)));
    assert.notEqual(projectKeyOf(fileA), projectKeyOf(fileB));
    assert.ok(projectKeyOf(fileA).startsWith("proj-alpha"));
    assert.ok(projectKeyOf(fileB).startsWith("proj-beta"));

    const keys = readdirSync(join(TEST_HOME, ".agentprism", "workflows", "projects"));
    assert.ok(keys.length >= 2);
    await session.dispose();
  } finally {
    await daemon.close();
  }
});

test("a fresh daemon locates a prior daemon's run on disk via the project manifest", async () => {
  const projectDir = makeProjectDir("relocate-project");
  const first = await startDaemon(okRunner());
  let runId: string;
  try {
    const session = await connectHttp(first.url);
    const result = await session.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: NO_AGENT_SCRIPT, projectDir },
    });
    runId = structured(result)?.runId as string;
    assert.ok(runId);
    await session.dispose();
  } finally {
    await first.close();
  }

  // New daemon, no live contexts: inspect must route via projects/<key>/project.json.
  const second = await startDaemon(okRunner());
  try {
    const session = await connectHttp(second.url);
    const inspected = await session.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(inspected.isError ?? false, false, textOf(inspected));
    assert.equal(structured(inspected)?.status, "completed");
    await session.dispose();
  } finally {
    await second.close();
  }
});

test("idle eviction closes a dead client's session; its background run survives and 404s re-initialize", async () => {
  const { runner, release } = gatedRunner();
  const projectDir = makeProjectDir("evict-project");
  const daemon = await startDaemon(runner);
  try {
    const a = await connectHttp(daemon.url);
    const started = await a.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, background: true, projectDir },
    });
    const runId = structured(started)?.runId as string;
    assert.ok(runId);
    const [record] = daemon.sessions.values();
    const evictedSessionId = record.sessionId;

    // Simulate a crashed client: transport aborts its sockets, no DELETE is ever sent.
    await a.transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(record.openConnections, 0, "dead client should hold no connections");

    record.lastActivityAt = Date.now() - SESSION_IDLE_TTL_MS - 1;
    const evicted = daemon.sessions.evictIdle(SESSION_IDLE_TTL_MS);
    assert.deepEqual(evicted, [evictedSessionId]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(daemon.sessions.size, 0);

    // Spec behavior for the evicted id: 404, telling the client to re-initialize.
    const stale = await fetch(daemon.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": evictedSessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(stale.status, 404);

    // The run was never tied to the session: release the gate and await it from a new session.
    release();
    const b = await connectHttp(daemon.url);
    const awaited = await b.client.callTool({
      name: "workflow",
      arguments: { action: "status", runId },
    });
    assert.equal(structured(awaited)?.status, "completed", textOf(awaited));
    await b.dispose();
  } finally {
    await daemon.close();
  }
});

test("MAX_BACKGROUND_RUNS caps per project across sessions", async () => {
  const { runner, release } = gatedRunner();
  const projectDir = makeProjectDir("cap-project");
  const otherProject = makeProjectDir("cap-other");
  const daemon = await startDaemon(runner);
  try {
    const a = await connectHttp(daemon.url);
    const b = await connectHttp(daemon.url);
    const runIds: string[] = [];
    for (const session of [a, a, b, b]) {
      const started = await session.client.callTool({
        name: "workflow",
        arguments: { action: "run", script: ONE_AGENT_SCRIPT, background: true, projectDir },
      });
      assert.equal(started.isError ?? false, false, textOf(started));
      runIds.push(structured(started)?.runId as string);
    }
    const fifth = await b.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, background: true, projectDir },
    });
    assert.equal(fifth.isError, true);
    assert.match(textOf(fifth), /Background workflow limit reached/);

    // The cap is per project: a different project still admits.
    const other = await b.client.callTool({
      name: "workflow",
      arguments: { action: "run", script: ONE_AGENT_SCRIPT, background: true, projectDir: otherProject },
    });
    assert.equal(other.isError ?? false, false, textOf(other));
    runIds.push(structured(other)?.runId as string);

    release();
    for (const runId of runIds) {
      const awaited = await a.client.callTool({
        name: "workflow",
        arguments: { action: "status", runId },
      });
      assert.equal(structured(awaited)?.status, "completed", textOf(awaited));
    }
    await a.dispose();
    await b.dispose();
  } finally {
    await daemon.close();
  }
});

test("middleware rejects bad Origin over real HTTP; unknown paths 404", async () => {
  const daemon = await startDaemon(okRunner());
  try {
    const evil = await fetch(daemon.url, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(evil.status, 403);
    const missing = await fetch(`http://127.0.0.1:${daemon.port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
  }
});

test("the session registry signals last-connection-closed and the repl presence drain closes idle children", async () => {
  // Phase-D review round 2: the daemon's session registry measures
  // liveness by connection presence and SIGNALS project repl lifecycle —
  // a client whose last connection closed leaves its projects' workspaces
  // drained (in-flight turns complete — each settlement boundary
  // snapshots — then idle children close; the next connect re-attaches
  // lazily). The drain itself is pinned in repl-review2.test.ts; this
  // test pins the daemon wiring: registry signal → presence ledger →
  // drain over a real HTTP session.
  type Turn = { resolve: (turn: import("@automatalabs/repl-engine").BrokerTurn) => void };
  let pendingTurn: Turn | undefined;
  const releases: number[] = [];
  const fakeSession = {
    sessionId: "fake-s1",
    backendId: "pi",
    initializeMeta: { steering: { supported: true } },
    async prompt(): Promise<import("@automatalabs/repl-engine").BrokerTurn> {
      return new Promise((resolve) => {
        pendingTurn = { resolve };
      });
    },
    async steer(): Promise<unknown> {
      return { outcome: "injected" };
    },
    async cancel(): Promise<void> {},
    async release(): Promise<void> {
      releases.push(1);
    },
    currentTurnText(): string {
      return "done text";
    },
    finalMessageText(): string {
      return "done text";
    },
    rawStructuredOutput(): unknown {
      return undefined;
    },
  } as import("@automatalabs/repl-engine").BrokerSession;
  const runner = {
    sessions: 0,
    listBackends(): string[] {
      return ["pi"];
    },
    defaultBackendId(): string {
      return "pi";
    },
    async openSession(): Promise<import("@automatalabs/repl-engine").BrokerSession> {
      this.sessions++;
      return fakeSession;
    },
    async loadSession(): Promise<never> {
      throw new Error("no load");
    },
    async dispose(): Promise<void> {},
  } as unknown as import("@automatalabs/repl-engine").BrokerRunner;

  const daemon = await createDaemon({
    runner: okRunner(),
    port: 0,
    env: {},
    log: () => undefined,
    replRunner: runner,
    sessionTtlMs: 60_000,
  } as never);
  const project = makeProjectDir("repl-drain");
  const a = await connectHttp(daemon.url);
  try {
    const started = await a.client.callTool({
      name: "repl",
      arguments: { action: "eval", projectDir: project, code: 'const p = agent("pi/x", "task"); "started"' },
    });
    assert.ok(!(started as { isError?: boolean }).isError, textOf(started));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runner.sessions, 1, "the session opened");
    // The client disconnects: the session's connections close, the
    // registry signals, and the project's workspace starts draining —
    // the in-flight turn is WAITED OUT, not cancelled.
    await a.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(releases.length, 0, "the drain waits for the in-flight turn (never cancels it)");
    assert.ok(pendingTurn !== undefined, "the founding turn is still in flight");
    pendingTurn!.resolve({ stopReason: "end_turn", text: "done text" });
    for (let attempt = 0; attempt < 100 && releases.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(releases.length, 1, "the idle child closed after the drain completed the turn");
  } finally {
    await daemon.close();
  }
});
