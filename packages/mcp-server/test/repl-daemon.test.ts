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
 * - a TRANSIENT connection drop of the same live session restores its
 *   project presence on reconnect (the registry's connection-open
 *   signal re-adds it from the ledger's retained affinity), so the
 *   scheduled drain aborts and children stay warm,
 * - reset does NOT clear client presence (connection liveness, not
 *   workspace state): with a second client connected, the resetting
 *   client's disconnect never drains the post-reset workspace,
 * - the lifecycle drain driven by the daemon's session registry (the
 *   doc's client-presence policy): last-client disconnect drains the
 *   in-flight subagent turn to completion (mock runner), closes the
 *   idle child, and the next connect's followUp lazily re-attaches the
 *   recorded backend session,
 * - the eval-through-MCP round trip applies the doc's output caps
 *   (256 lines / 10 KB, whichever trips first) to the FINAL tool
 *   result — console lines, the result line, and the metadata sections
 *   alike, with the truncation marker shipping — and the `$N` refs the
 *   kept lines carry reach the truncated values (the cap costs reads,
 *   never data),
 * - interrupt without an id breaks a RUNNING eval: an eval suspended
 *   in flight is interrupted when its continuation (a runaway loop)
 *   executes, and the signal is consumed by that execution.
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
      // never content. EVERY binding carries its byte size (phase-E
      // review rejection: primitives used to render without size).
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(textOf(status).includes(`workspace ${PROJECT}: fresh`), textOf(status));
      assert.ok(textOf(status).includes("answer = number · 8B"), textOf(status));
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
      // interrupt without an id BREAKS THE RUNNING EVAL (phase-E review
      // rejection: the old test pre-armed the signal before the eval
      // started, so it never exercised the required ability to interrupt
      // a RUNNING eval). The eval is started first — it suspends on an
      // in-flight call, so it IS running (its continuation is registered
      // and will execute); the interrupt lands while it is in flight;
      // when the continuation (a runaway loop) executes, the quickjs
      // interrupt handler breaks it MID-RUN. The signal is consumed by
      // the running eval's execution — a later eval is unaffected.
      const inFlight = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const s = agent("pi/x", "task4"); await s; while (true) {}',
      });
      assert.ok(!isErrorResult(inFlight), textOf(inFlight));
      assert.ok(textOf(inFlight).includes("pending: c1, c4"), textOf(inFlight));
      const armed = await repl(session, { action: "interrupt", projectDir: PROJECT });
      assert.ok(!isErrorResult(armed), textOf(armed));
      assert.ok(textOf(armed).includes("interrupting the running eval"), textOf(armed));
      runner.last().completeTurn("resumed");
      const runaway = await repl(session, { action: "eval", projectDir: PROJECT, code: '"after"' });
      assert.ok(textOf(runaway).includes("interrupted"), `the running eval was broken: ${textOf(runaway)}`);
      // The signal was consumed by the running eval: the next eval is
      // NOT broken, and the VM stays usable.
      const afterInterrupt = await repl(session, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
      assert.ok(textOf(afterInterrupt).includes("result: 42"), textOf(afterInterrupt));
      // reset: teardown — the VM and its stored state are dropped; the
      // next eval starts a fresh workspace.
      const reset = await repl(session, { action: "reset", projectDir: PROJECT });
      assert.ok(!isErrorResult(reset), textOf(reset));
      assert.ok(textOf(reset).includes("dropped"), textOf(reset));
      const gone = await repl(session, { action: "eval", projectDir: PROJECT, code: "typeof answer" });
      assert.ok(!isErrorResult(gone), textOf(gone));
      assert.ok(textOf(gone).includes('"undefined"'), textOf(gone));
      // A GLOBAL LEXICAL binding (top-level let/const/class — the
      // roadmap's canonical `const research = agent(...)` state) is
      // listed by status with its full provenance surface (phase-E
      // review rejection: only global-object keys were enumerated, so
      // lexical workspace state was invisible to status).
      const lexed = await repl(session, { action: "eval", projectDir: PROJECT, code: 'const research = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(lexed), textOf(lexed));
      assert.ok(textOf(lexed).includes("pending: c1"), textOf(lexed));
      const statusLex = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(
        textOf(statusLex).includes(
          "research = agent handle · pending · call c1 · 151B · via eval 2 · task \"task\"",
        ),
        `lexical binding in status: ${textOf(statusLex)}`,
      );
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

test("a transient connection drop of the SAME live session restores its project presence on reconnect — the scheduled drain aborts and children stay warm", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const PROJECT = makeProjectDir("repl-reconnect");
    const session = await connectHttp(daemon.url);
    try {
      const started = await repl(session, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(started), textOf(started));
      assert.ok(textOf(started).includes("pending: c1"), textOf(started));
      await tick();
      const record = daemon.sessions.values()[0];
      assert.ok(record, "the session is registered");
      // The transient drop: the session's LAST connection closes (a
      // standalone-GET blip — the session itself stays alive). The
      // registry signals the presence ledger, which removes the session's
      // presence and schedules the project drain.
      daemon.sessions.connectionClosed(record.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const child = runner.last();
      assert.equal(child.releases, 0, "the drain is waiting on the in-flight turn");
      // The SAME live session reconnects (no new MCP session, no tool
      // call): the registry's connection-open signal re-adds the
      // session's project presence from its retained affinity, and the
      // scheduled drain aborts — the child stays warm (phase-E review
      // rejection: only disconnects were wired, so the reconnect used to
      // leave the presence gone and the already-scheduled drain could
      // close children while the client was connected).
      daemon.sessions.connectionOpened(record.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(child.releases, 0, "the reconnect aborted the drain — the child stays warm");
      assert.equal(child.cancelCalls, 0, "nothing was cancelled");
      // The turn completes normally and settles into the live workspace;
      // the workspace stays warm (children not closed).
      child.completeTurn("warm after reconnect");
      const got = await repl(session, { action: "eval", projectDir: PROJECT, code: "await p" });
      assert.ok(!isErrorResult(got), textOf(got));
      assert.ok(textOf(got).includes("warm after reconnect"), textOf(got));
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!textOf(status).includes("children: closed"), textOf(status));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("reset does not clear client presence: with a second client still connected, the resetting client's disconnect does NOT drain the post-reset workspace", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const PROJECT = makeProjectDir("repl-reset-presence");
    const sessionA = await connectHttp(daemon.url);
    const sessionB = await connectHttp(daemon.url);
    try {
      // Both clients are present on the project.
      const start = await repl(sessionA, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(start), textOf(start));
      assert.ok(textOf(start).includes("pending: c1"), textOf(start));
      await repl(sessionB, { action: "eval", projectDir: PROJECT, code: '"b present"' });
      await tick();
      // A resets: the workspace is dropped, but the CONNECTIONS stay —
      // presence is connection liveness, not workspace state (phase-E
      // review rejection: reset used to clear state.clients while the
      // presence ledger kept its maps, so the two desynced and a later
      // disconnect of A could drain work started after the reset even
      // though B was still connected).
      const reset = await repl(sessionA, { action: "reset", projectDir: PROJECT });
      assert.ok(!isErrorResult(reset), textOf(reset));
      assert.ok(textOf(reset).includes("dropped"), textOf(reset));
      // A starts NEW work on the fresh workspace.
      const restarted = await repl(sessionA, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started2"' });
      assert.ok(!isErrorResult(restarted), textOf(restarted));
      assert.ok(textOf(restarted).includes("pending: c1"), textOf(restarted));
      await tick();
      const child = runner.last();
      // A's connection drops while B is still connected: NO drain may
      // fire — the post-reset child stays warm (the drain decision sees
      // B's presence).
      await sessionA.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(child.releases, 0, "no drain while B is connected");
      assert.equal(child.cancelCalls, 0, "nothing was cancelled");
      // The in-flight turn completes and settles into the live
      // workspace; B can see the result.
      child.completeTurn("post-reset result");
      const got = await repl(sessionB, { action: "eval", projectDir: PROJECT, code: "await q" });
      assert.ok(!isErrorResult(got), textOf(got));
      assert.ok(textOf(got).includes("post-reset result"), textOf(got));
      // B's disconnect is the LAST client: NOW the drain runs and closes
      // the idle child.
      await sessionB.dispose();
      for (let attempt = 0; attempt < 200 && child.releases === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(child.releases, 1, "the last-client disconnect drains and closes the idle child");
    } finally {
      await sessionA.dispose().catch(() => undefined);
      await sessionB.dispose().catch(() => undefined);
    }
  } finally {
    await daemon.close();
  }
});

test("eval-through-MCP round trip applies the output caps to the FINAL result (256 lines / 10 KB, whichever trips first, marker included) and the $N refs reach the truncated values", async () => {
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-caps");
      // The LINE cap: 300 console.log calls render 300 preview lines. The
      // caps apply to the FINAL assembled tool result (phase-E review
      // rejection: the completion line and the metadata sections used to
      // be appended UNcapped, shipping 257 wire lines) — at most 256
      // lines reach the wire, and a truncation marker ships instead of
      // the dropped tail (its own budget is reserved inside the caps).
      const big = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'for (let i = 0; i < 300; i++) console.log("line-" + i);',
      });
      assert.ok(!isErrorResult(big), textOf(big));
      const text = textOf(big);
      const lines = text.split("\n");
      assert.ok(lines.length <= 256, `the 256-line cap holds on the wire: ${lines.length}`);
      assert.ok(text.includes("tool result truncated"), `the truncation marker ships: ${text.slice(0, 120)}`);
      // The kept lines carry their $N addresses (the doc's "output is
      // addressed, not just truncated").
      assert.ok(text.startsWith('[$1 · string · 6B] "line-0"'), text.slice(0, 80));
      assert.ok(text.includes('"line-2'), "the kept head lines are the earliest lines");
      assert.ok(!text.includes("line-299"), "the tail beyond the cap is never shipped");
      // The truncated values stay reachable through the $N refs the kept
      // lines carry (the cap costs reads, never data).
      const sliced = await repl(session, { action: "eval", projectDir: PROJECT, code: 'console.log($300); "ok"' });
      assert.ok(!isErrorResult(sliced), textOf(sliced));
      assert.ok(textOf(sliced).includes('"line-299"'), textOf(sliced));
      // The BYTE cap: 100 two-kilobyte strings trip the 10 KB cap long
      // before the 256-line cap; only the lines that fit are emitted,
      // and the marker ships.
      const heavy = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'for (let i = 0; i < 100; i++) console.log("B".repeat(2000) + i);',
      });
      assert.ok(!isErrorResult(heavy), textOf(heavy));
      const heavyText = textOf(heavy);
      assert.ok(heavyText.split("\n").length < 100, "the byte cap tripped before the line cap");
      assert.ok(Buffer.byteLength(heavyText) <= 10_000, `the 10 KB cap: ${Buffer.byteLength(heavyText)} bytes`);
      // (The broker already capped the console lines, so the final text
      // fits without a marker; the marker-on-byte-cap path is pinned by
      // capFinalText's unit tests.)
      // The full value behind a capped line is one global: addressable by
      // its ref in a later eval. The 300 prior logs created $1..$300, the
      // sliced eval's log created $301, and the heavy loop created
      // $302..$401 — the last one is "B" × 2000 + "99" (length 2002),
      // intact.
      const length = await repl(session, { action: "eval", projectDir: PROJECT, code: "$401.length" });
      assert.ok(!isErrorResult(length), textOf(length));
      assert.ok(textOf(length).includes("result: 2002"), textOf(length));
      // METADATA-heavy results are capped too (phase-E review rejection:
      // pending ids, checkpoints, completed ids, and timeout text were
      // appended uncapped): 300 parked checkpoints render 300 checkpoint
      // lines plus the result/pending sections — the final text is
      // capped at 256 lines with the marker, head sections kept in
      // order.
      const meta = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'for (let i = 0; i < 300; i++) checkpoint("q-" + i); "asked"',
      });
      assert.ok(!isErrorResult(meta), textOf(meta));
      const metaText = textOf(meta);
      const metaLines = metaText.split("\n");
      assert.ok(metaLines.length <= 256, `metadata-heavy result capped: ${metaLines.length}`);
      assert.ok(metaText.includes("tool result truncated"), "the metadata cap marker ships");
      assert.ok(metaText.includes("pending:"), "the pending section is kept (head)");
      assert.ok(metaText.includes("checkpoint"), "the checkpoint section is kept (head)");
      assert.ok(!metaText.includes("completed:"), "the tail section is dropped");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});
