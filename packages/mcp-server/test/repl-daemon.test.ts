/**
 * Phase E of the REPL-orchestrator roadmap (docs/roadmap/repl-orchestrator.md):
 * the `repl` tool's DAEMON-BOUNDARY suite. The phase-D suites
 * (repl-tool.test.ts, repl-review2.test.ts) drive `createWorkflowServer`
 * over in-memory transports; this suite pins the phase-E deliverables
 * against a REAL daemon instance — `createDaemon` on an ephemeral
 * loopback port, driven by real SDK Clients over
 * StreamableHTTPClientTransport (the `_http-harness` pattern):
 *
 * - the tool schema: `repl` registers alongside `workflow` with exactly
 *   the doc's action enum (`eval` / `wait` / `status` / `interrupt` /
 *   `reset`) and field set — snapshotting is implicit, there is no
 *   user-facing snapshot action,
 * - action behaviors on the daemon: projectDir is required in daemon
 *   mode, and eval / wait / status / interrupt / reset round-trip over
 *   HTTP (wait: bounded, "still running" on timeout, absorbs a
 *   mid-wait settlement),
 * - project keying: two projectDirs are two ISOLATED workspaces on one
 *   daemon (separate VMs, separate per-project repl stores, a reset of
 *   one never touches the other),
 * - MCP-session churn never touches the workspace: bindings survive a
 *   client disconnect and a fresh client's reconnect,
 * - the lifecycle drain driven by the daemon's session registry (the
 *   doc's client-presence policy): last-client disconnect drains the
 *   in-flight subagent turn to completion (mock runner), closes the
 *   idle child, and the next connect's followUp lazily re-attaches the
 *   recorded backend session,
 * - the eval-through-MCP round trip applies the doc's output caps
 *   (256 lines / 10 KB, whichever trips first) — and the `$N` refs the
 *   kept lines carry reach the truncated values (the cap costs reads,
 *   never data).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  BrokerLoadSessionOptions,
  BrokerOpenSessionOptions,
  BrokerPromptOptions,
  BrokerRunner,
  BrokerSession,
  BrokerTurn,
} from "@automatalabs/repl-engine";
import { workflowProjectPaths } from "@automatalabs/workflows";
import { z } from "zod";

import { replToolInputShape } from "../src/index.js";
import { createDaemon, type DaemonHandle } from "../src/daemon/http-daemon.js";
import { connectHttp, makeProjectDir } from "./_http-harness.js";
import { okRunner, textOf } from "./_harness.js";

/** The fake held-open ACP session (the broker's structural seam; the
 *  same shape as repl-tool.test.ts's fake, kept local so this suite
 *  runs standalone). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  cancelCalls = 0;
  stopReason = "end_turn";
  readonly completedTexts: string[] = [];
  /** The re-attach seam's scripted loaded-turn outcome (null parks it). */
  loadedTurnTextValue: string | null = null;

  constructor(readonly openedWith: BrokerOpenSessionOptions | BrokerLoadSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.capabilities = { supportsSteering: true };
  }

  static nextId = 0;

  prompt(content: string, opts: BrokerPromptOptions = {}): Promise<BrokerTurn> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ content, resolve, reject });
      opts.onHandoff?.();
    });
  }

  steer(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.steers.push({ content, resolve, reject });
    });
  }

  awaitCurrentTurn(): Promise<BrokerTurn> {
    if (this.loadedTurnTextValue !== null) {
      return Promise.resolve({ stopReason: this.stopReason, text: this.loadedTurnTextValue });
    }
    return new Promise(() => {});
  }

  cancel(): Promise<void> {
    this.cancelCalls++;
    for (const pending of this.prompts.splice(0)) {
      pending.resolve({ stopReason: "cancelled", text: "" });
    }
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.releases++;
    return Promise.resolve();
  }

  currentTurnText(): string {
    return this.completedTexts[this.completedTexts.length - 1] ?? "";
  }

  finalMessageText(): string {
    return this.completedTexts[this.completedTexts.length - 1] ?? "";
  }

  rawStructuredOutput(): unknown {
    return undefined;
  }

  completeTurn(text: string): void {
    const pending = this.prompts.shift();
    assert.ok(pending, "a prompt turn must be in flight");
    this.completedTexts.push(text);
    pending.resolve({ stopReason: this.stopReason, text });
  }
}

/** The fake runner with the loadSession seam (see repl-tool.test.ts). */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    session.loadedTurnTextValue = null;
    this.sessions.push(session);
    this.loadedWith.push(opts);
    return session;
  }

  async dispose(): Promise<void> {}

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, "a session must exist");
    return this.sessions[this.sessions.length - 1];
  }
}

/** A real daemon on an ephemeral loopback port with an injected repl
 *  runner (the suite's mock seam; the drain bound reuses the daemon's
 *  session-eviction TTL knob — here a short test value). */
async function startReplDaemon(replRunner: BrokerRunner): Promise<DaemonHandle> {
  return createDaemon({
    runner: okRunner(),
    port: 0,
    env: {},
    log: () => undefined,
    replRunner,
    sessionTtlMs: 60_000,
  });
}

/** Call the repl tool over HTTP (typed over the raw input). */
function repl(
  session: { client: Client },
  input: { action: string; projectDir?: string; code?: string; ids?: string[]; timeoutMs?: number; id?: string },
): ReturnType<Client["callTool"]> {
  return session.client.callTool({ name: "repl", arguments: input as Record<string, unknown> });
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return (res as { isError?: boolean }).isError === true;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the repl tool registers alongside workflow with the doc's exact action-enum schema; snapshotting is implicit (no snapshot action)", async () => {
  const Schema = z.object(replToolInputShape);
  // The field set is exactly the doc's surface.
  assert.deepEqual(Object.keys(replToolInputShape).sort(), ["action", "code", "id", "ids", "projectDir", "timeoutMs"]);
  // No user-facing snapshot action: snapshotting is implicit (the doc's
  // "Snapshotting is implicit — there is no user-facing snapshot action").
  assert.ok(!("snapshot" in replToolInputShape), "snapshot must not be a tool action");
  // The action enum is exactly eval / wait / status / interrupt / reset.
  assert.doesNotThrow(() => Schema.parse({ action: "eval" }));
  assert.doesNotThrow(() => Schema.parse({ action: "wait" }));
  assert.doesNotThrow(() => Schema.parse({ action: "status" }));
  assert.doesNotThrow(() => Schema.parse({ action: "interrupt" }));
  assert.doesNotThrow(() => Schema.parse({ action: "reset" }));
  assert.throws(() => Schema.parse({ action: "snapshot" }), /Invalid option/);
  assert.throws(() => Schema.parse({ action: "nope" }), /Invalid option/);
  // projectDir must be an absolute path (the doc's validated, realpathed
  // project model; relative paths refuse at the schema).
  assert.throws(() => Schema.parse({ action: "eval", projectDir: "relative/path", code: "1" }), /absolute path/);
  assert.doesNotThrow(() => Schema.parse({ action: "eval", projectDir: "/abs/path", code: "1" }));
  // timeoutMs: an integer in [0, 120_000] (the doc's bounded wait).
  assert.throws(() => Schema.parse({ action: "wait", timeoutMs: -1 }));
  assert.throws(() => Schema.parse({ action: "wait", timeoutMs: 120_001 }));
  assert.throws(() => Schema.parse({ action: "wait", timeoutMs: 1.5 }));
  assert.doesNotThrow(() => Schema.parse({ action: "wait", timeoutMs: 0 }));
  assert.doesNotThrow(() => Schema.parse({ action: "wait", timeoutMs: 120_000 }));
  // ids: an array of strings.
  assert.doesNotThrow(() => Schema.parse({ action: "wait", ids: [] }));
  assert.throws(() => Schema.parse({ action: "wait", ids: [7] }));

  // The WIRE schema of the real daemon advertises exactly that shape,
  // alongside the workflow tool.
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const session = await connectHttp(daemon.url, { listTools: true });
    try {
      const tools = await session.client.listTools();
      assert.deepEqual(
        tools.tools.map((t) => t.name).sort(),
        ["repl", "workflow", "workflow-events"],
        "repl registers alongside workflow (and the app-only events tool)",
      );
      const wire = tools.tools.find((t) => t.name === "repl")!;
      const schema = wire.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(
        Object.keys(schema.properties).sort(),
        ["action", "code", "id", "ids", "projectDir", "timeoutMs"],
      );
      const action = schema.properties.action as { enum?: string[] };
      assert.deepEqual(action.enum, ["eval", "wait", "status", "interrupt", "reset"]);
      assert.deepEqual(schema.required, ["action"], "action is the only required field");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("daemon mode: projectDir is required; eval/wait/status/interrupt/reset round-trip over the real HTTP daemon", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-actions");
      // Daemon mode REQUIRES projectDir for every stateful action (the
      // same required-in-daemon-mode rule the workflow tool has).
      const noDir = await repl(session, { action: "eval", code: "1 + 1" });
      assert.ok(isErrorResult(noDir), textOf(noDir));
      assert.ok(textOf(noDir).includes("projectDir is required on the shared workflow daemon"), textOf(noDir));
      // status without projectDir lists every known project context; a
      // daemon with NO contexts renders an empty listing — status never
      // CREATES a context or a workspace.
      const emptyStatus = await repl(session, { action: "status" });
      assert.ok(!isErrorResult(emptyStatus), textOf(emptyStatus));
      assert.equal(textOf(emptyStatus), "");
      // An unknown action is refused by the schema at the wire boundary.
      const badAction = await repl(session, { action: "snapshot", projectDir: PROJECT, code: "1" });
      assert.ok(isErrorResult(badAction), textOf(badAction));
      assert.ok(textOf(badAction).includes("Input validation error"), textOf(badAction));
      // eval requires a non-empty code string (the stateful call touches
      // the workspace — the documented first-touch semantics — but the
      // empty script is refused).
      const emptyCode = await repl(session, { action: "eval", projectDir: PROJECT, code: "" });
      assert.ok(isErrorResult(emptyCode), textOf(emptyCode));
      assert.ok(textOf(emptyCode).includes("eval requires a non-empty code string"), textOf(emptyCode));
      // eval round trip.
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: "var answer = 40 + 2; answer" });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      assert.ok(textOf(evaled).includes("result: 42"), textOf(evaled));
      // status: the workspace manifest — metadata (name/type token),
      // never content.
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(textOf(status).includes(`workspace ${PROJECT}: fresh`), textOf(status));
      assert.ok(textOf(status).includes("answer = number"), textOf(status));
      assert.ok(!textOf(status).includes("40 + 2"), `content leaked: ${textOf(status)}`);
      // A pending subagent call; wait is bounded ("still running" on
      // timeout — absorbs client tool-call timeouts).
      const started = await repl(session, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(started), textOf(started));
      assert.ok(textOf(started).includes("pending: c1"), textOf(started));
      await tick();
      const timedOut = await repl(session, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 100 });
      assert.ok(!isErrorResult(timedOut), textOf(timedOut));
      assert.ok(textOf(timedOut).includes("still running"), textOf(timedOut));
      // wait absorbs a MID-WAIT settlement: the server-side pump keeps
      // waiting while the HTTP request is open, and the backend's
      // settlement resolves it.
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started"' });
      await tick();
      const waiting = repl(session, { action: "wait", projectDir: PROJECT, ids: ["c2"], timeoutMs: 5000 });
      await tick();
      runner.last().completeTurn("waited result");
      const waited = await waiting;
      assert.ok(!isErrorResult(waited), textOf(waited));
      assert.ok(textOf(waited).includes("completed: c2"), textOf(waited));
      // interrupt with an id cancels the subagent call (ACP
      // session/cancel downward).
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const r = agent("pi/x", "task3"); "started"' });
      await tick();
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c3" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
      // interrupt without an id arms the eval-break signal: the next VM
      // execution is broken (the quickjs interrupt handler).
      await repl(session, { action: "interrupt", projectDir: PROJECT });
      const runaway = await repl(session, { action: "eval", projectDir: PROJECT, code: "while (true) {}" });
      assert.ok(textOf(runaway).includes("interrupted"), textOf(runaway));
      // reset: teardown — the VM and its stored state are dropped; the
      // next eval starts a fresh workspace.
      const reset = await repl(session, { action: "reset", projectDir: PROJECT });
      assert.ok(!isErrorResult(reset), textOf(reset));
      assert.ok(textOf(reset).includes("dropped"), textOf(reset));
      const gone = await repl(session, { action: "eval", projectDir: PROJECT, code: "typeof answer" });
      assert.ok(!isErrorResult(gone), textOf(gone));
      assert.ok(textOf(gone).includes('"undefined"'), textOf(gone));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("workspaces are keyed by projectDir: two projects on one daemon are fully isolated", async () => {
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const session = await connectHttp(daemon.url);
    try {
      const projectA = makeProjectDir("repl-keying-a");
      const projectB = makeProjectDir("repl-keying-b");
      const a = await repl(session, { action: "eval", projectDir: projectA, code: 'const secretA = "alpha"; "A"' });
      assert.ok(!isErrorResult(a), textOf(a));
      // B does not see A's bindings...
      const probeB = await repl(session, { action: "eval", projectDir: projectB, code: "typeof secretA" });
      assert.ok(!isErrorResult(probeB), textOf(probeB));
      assert.ok(textOf(probeB).includes('"undefined"'), textOf(probeB));
      const b = await repl(session, { action: "eval", projectDir: projectB, code: 'const secretB = "beta"; "B"' });
      assert.ok(!isErrorResult(b), textOf(b));
      // ...and A does not see B's.
      const probeA = await repl(session, { action: "eval", projectDir: projectA, code: "typeof secretB" });
      assert.ok(!isErrorResult(probeA), textOf(probeA));
      assert.ok(textOf(probeA).includes('"undefined"'), textOf(probeA));
      // Each project persisted its OWN repl store (one enveloped snapshot
      // per project, under the daemon's per-project layout).
      const pathsA = workflowProjectPaths(projectA);
      const pathsB = workflowProjectPaths(projectB);
      const storeA = join(pathsA.rootDir, "repl");
      const storeB = join(pathsB.rootDir, "repl");
      assert.notEqual(storeA, storeB);
      assert.ok(existsSync(join(storeA, "snapshot.bin")), "A's snapshot exists");
      assert.ok(existsSync(join(storeB, "snapshot.bin")), "B's snapshot exists");
      // status without projectDir lists BOTH workspaces.
      const status = await repl(session, { action: "status" });
      assert.ok(textOf(status).includes(projectA), textOf(status));
      assert.ok(textOf(status).includes(projectB), textOf(status));
      // resetting A never touches B: B's binding and store survive, and
      // A's stored state is gone — the next touch (a named status is a
      // first touch, exactly like every other stateful action) starts a
      // FRESH workspace, never a restore, and the old binding is gone.
      await repl(session, { action: "reset", projectDir: projectA });
      const bAlive = await repl(session, { action: "eval", projectDir: projectB, code: "secretB" });
      assert.ok(!isErrorResult(bAlive), textOf(bAlive));
      assert.ok(textOf(bAlive).includes('"beta"'), textOf(bAlive));
      const aFresh = await repl(session, { action: "status", projectDir: projectA });
      assert.ok(textOf(aFresh).includes("fresh"), textOf(aFresh));
      assert.ok(!textOf(aFresh).includes("restored"), textOf(aFresh));
      const aGone = await repl(session, { action: "eval", projectDir: projectA, code: "typeof secretA" });
      assert.ok(!isErrorResult(aGone), textOf(aGone));
      assert.ok(textOf(aGone).includes('"undefined"'), textOf(aGone));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("MCP-session churn never touches the workspace: bindings survive a client disconnect and a fresh client's reconnect", async () => {
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const PROJECT = makeProjectDir("repl-churn");
    const session1 = await connectHttp(daemon.url);
    try {
      const evaled = await repl(session1, { action: "eval", projectDir: PROJECT, code: "var x = 40 + 2; x" });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      assert.ok(textOf(evaled).includes("result: 42"), textOf(evaled));
    } finally {
      // The client's last connection closes: the session registry signals
      // the presence ledger, which drains the project (no children were
      // ever opened — a quick no-op drain). The workspace itself is
      // NEVER dropped by session churn.
      await session1.dispose();
    }
    const session2 = await connectHttp(daemon.url);
    try {
      // A brand-new MCP session (new session id, new transport) sees the
      // same live VM: the binding survived the disconnect.
      const continued = await repl(session2, { action: "eval", projectDir: PROJECT, code: "x * 2" });
      assert.ok(!isErrorResult(continued), textOf(continued));
      assert.ok(textOf(continued).includes("result: 84"), textOf(continued));
      const status = await repl(session2, { action: "status", projectDir: PROJECT });
      assert.ok(textOf(status).includes("x = number"), textOf(status));
    } finally {
      await session2.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("the session registry drives the client-presence drain on the real daemon: last-client disconnect drains the in-flight turn to completion, closes the idle child, and the next connect's followUp lazily re-attaches", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const PROJECT = makeProjectDir("repl-drain");
    const session1 = await connectHttp(daemon.url);
    try {
      const started = await repl(session1, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(started), textOf(started));
      assert.ok(textOf(started).includes("pending: c1"), textOf(started));
      await tick();
    } finally {
      // The client's last connection closes: the daemon's session
      // registry fires onLastConnectionClosed, the presence ledger
      // removes the session, and the project's workspace DRAINS — the
      // in-flight subagent turn runs to completion (never a cancel).
      await session1.dispose();
    }
    const session = runner.last();
    // The drain waits for the in-flight turn; its completion settles
    // into the VM (each settlement boundary snapshots), then the idle
    // child closes.
    session.completeTurn("drained result");
    for (let attempt = 0; attempt < 200 && session.releases === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(session.releases, 1, "the idle child closed after the drain");
    // The next client connect: the workspace is still live (the drain
    // never drops it), children closed — and followUp on the settled
    // handle lazily re-attaches the recorded backend session via the
    // capability matrix (loadSession with the SAME session id).
    const session2 = await connectHttp(daemon.url);
    try {
      const status = await repl(session2, { action: "status", projectDir: PROJECT });
      assert.ok(textOf(status).includes("children: closed"), textOf(status));
      const probe = await repl(session2, { action: "eval", projectDir: PROJECT, code: 'p.followUp("more"); "fired"' });
      assert.ok(!isErrorResult(probe), textOf(probe));
      await tick();
      assert.equal(runner.loadedWith.length, 1, "the recorded session was loaded lazily on the next connect");
      assert.equal(runner.loadedWith[0].sessionId, session.sessionId, "the SAME backend session");
      // The followUp's delivery starts a new turn on the re-attached
      // session; completing it lets the next disconnect's drain (and the
      // daemon's bounded teardown) finish instead of waiting out their
      // bounds on a parked turn.
      for (let attempt = 0; attempt < 100 && runner.last().prompts.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      runner.last().completeTurn("followed up");
      await tick();
    } finally {
      await session2.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("eval-through-MCP round trip applies the output caps (256 lines / 10 KB, whichever trips first) and the $N refs reach the truncated values", async () => {
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-caps");
      // The LINE cap: 300 console.log calls render 300 preview lines; the
      // tool result keeps exactly the first 256 (the doc: "tool-result
      // output capped at 256 lines or 10 KB, whichever trips first").
      const big = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'for (let i = 0; i < 300; i++) console.log("line-" + i);',
      });
      assert.ok(!isErrorResult(big), textOf(big));
      const text = textOf(big);
      // A loop-only script completes with undefined, so the tool result
      // is exactly the 256 capped output lines plus the completion line
      // ("result: undefined") — the doc's 256-line cap, applied to the
      // OUTPUT, holds on the wire.
      const lines = text.split("\n");
      assert.equal(lines.length, 257, "the 256-line cap (output + completion line)");
      assert.equal(lines[256], "result: undefined", "the completion line is the only extra line");
      // The kept lines carry their $N addresses (the doc's "output is
      // addressed, not just truncated").
      assert.ok(text.startsWith('[$1 · string · 6B] "line-0"'), text.slice(0, 80));
      assert.ok(text.includes('"line-255"'), "the last kept line");
      assert.ok(!text.includes("line-299"), "the tail beyond the cap is never shipped");
      // The truncated values stay reachable through the $N refs the kept
      // lines carry (the cap costs reads, never data).
      const sliced = await repl(session, { action: "eval", projectDir: PROJECT, code: 'console.log($300); "ok"' });
      assert.ok(!isErrorResult(sliced), textOf(sliced));
      assert.ok(textOf(sliced).includes('"line-299"'), textOf(sliced));
      // The BYTE cap: 100 two-kilobyte strings trip the 10 KB cap long
      // before the 256-line cap; only the lines that fit are emitted.
      const heavy = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'for (let i = 0; i < 100; i++) console.log("B".repeat(2000) + i);',
      });
      assert.ok(!isErrorResult(heavy), textOf(heavy));
      const heavyText = textOf(heavy);
      assert.ok(heavyText.split("\n").length < 100, "the byte cap tripped before the line cap");
      assert.ok(Buffer.byteLength(heavyText) <= 10_000, `the 10 KB cap: ${Buffer.byteLength(heavyText)} bytes`);
      // The full value behind a capped line is one global: addressable by
      // its ref in a later eval (the 100th 2 KB value survived intact).
      const length = await repl(session, { action: "eval", projectDir: PROJECT, code: "$401.length" });
      assert.ok(!isErrorResult(length), textOf(length));
      assert.ok(textOf(length).includes("result: 2002"), textOf(length));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});


