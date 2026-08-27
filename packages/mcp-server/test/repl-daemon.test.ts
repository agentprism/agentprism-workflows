/**
 * Phase E of the REPL-orchestrator roadmap, adapted to the eval-plane
 * redesign surface: the `repl` tool's DAEMON-BOUNDARY suite. The
 * phase-D suites (repl-tool.test.ts, repl-review2.test.ts) drive
 * `createWorkflowServer` over in-memory transports; this suite pins the
 * phase-E deliverables against a REAL daemon instance — `createDaemon`
 * on an ephemeral loopback port, driven by real SDK Clients over
 * StreamableHTTPClientTransport (the `_http-harness` pattern):
 *
 * - the tool schema: `repl` registers alongside `workflow` with exactly
 *   the redesign's two-action enum (`eval` / `interrupt`) and field set
 *   — snapshotting is implicit, there is no user-facing snapshot action,
 * - action behaviors on the daemon: projectDir is required in daemon
 *   mode, and eval / interrupt round-trip over HTTP (eval: the
 *   soft-bound fused pump — the finished shape when the awaited call
 *   settles within the bound, the honest still-running shape with the
 *   running ids when it does not),
 * - project keying: two projectDirs are two ISOLATED workspaces on one
 *   daemon (separate VMs, separate per-project repl stores, a reset of
 *   one never touches the other),
 * - MCP-session churn never touches the workspace: bindings survive a
 *   client disconnect and a fresh client's reconnect,
 * - a TRANSIENT connection drop of the same live session restores its
 *   project presence on reconnect (the registry's connection-open
 *   signal re-adds it from the ledger's retained affinity), so the
 *   scheduled drain aborts and children stay warm,
 * - reset() (the §4.5 guest function) does NOT clear client presence
 *   (connection liveness, not workspace state): with a second client
 *   connected, the resetting client's disconnect never drains the
 *   post-reset workspace,
 * - the lifecycle drain driven by the daemon's session registry: the
 *   last-client disconnect drains the in-flight subagent turn to
 *   completion (mock runner), closes the idle child, and the next
 *   explicit queued turn lazily re-attaches the recorded backend session,
 * - interrupt without an id breaks a RUNNING eval: an eval held open by
 *   the fused pump is in flight while the interrupt lands (the pump
 *   releases the broker chain between iterations) and the armed signal
 *   breaks the resumed continuation MID-RUN via the quickjs interrupt
 *   handler,
 * - the machine-readable output: the tool publishes an outputSchema and
 *   every result carries the redesign's shapes as structuredContent —
 *   eval `{ output, result?, running? }` (ONE newline-joined string,
 *   nothing else), the interrupt outcome, and the error variant.
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

import { replToolInputShape, replToolOutputShape } from "../src/index.js";
import { createDaemon, type DaemonHandle } from "../src/daemon/http-daemon.js";
import { connectHttp, makeProjectDir } from "./_http-harness.js";
import { okRunner, textOf } from "./_harness.js";

/** The fake held-open ACP session (the broker's structural seam; the
 *  same shape as repl-tool.test.ts's fake, kept local so this suite
 *  runs standalone). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  initializeMeta: Readonly<Record<string, unknown>> | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: unknown) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  cancelCalls = 0;
  stopReason = "end_turn";
  readonly completedTexts: string[] = [];
  /** The re-attach seam's scripted loaded-turn outcome (null parks it). */
  loadedTurnTextValue: string | null = null;

  constructor(readonly openedWith: BrokerOpenSessionOptions | BrokerLoadSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.initializeMeta = { steering: { supported: true } };
  }

  static nextId = 0;

  prompt(content: string, opts: BrokerPromptOptions = {}): Promise<BrokerTurn> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ content, resolve, reject });
      opts.onHandoff?.();
    });
  }

  steer(content: string): Promise<unknown> {
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

  listBackends(): string[] {
    return ["pi"];
  }

  defaultBackendId(): string {
    return "pi";
  }

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

/** The runner whose openSession is PARKED until released manually — the
 *  delayed-open regression seam (phase-E review rejection round 7:
 *  `interrupt { id }` must cancel a call whose `openSession()` is still
 *  pending, and the eventual late child must be closed without ever
 *  prompting). */
class DelayedOpenRunner extends FakeRunner {
  private gate: Promise<void> = Promise.resolve();
  private releaseGate: () => void = () => {};

  /** Park every openSession until `releaseOpens()`. */
  parkOpens(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  releaseOpens(): void {
    this.releaseGate();
  }

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    await this.gate;
    return super.openSession(opts);
  }
}

/** Call the repl tool over HTTP (typed over the raw input). */
function repl(
  session: { client: Client },
  input: { action: string; projectDir?: string; code?: string; timeoutMs?: number; id?: string },
): ReturnType<Client["callTool"]> {
  return session.client.callTool({ name: "repl", arguments: input as Record<string, unknown> });
}

function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

/** Evaluate an expression that returns JSON (the §4.5 sliceable-
 *  introspection idiom). */
async function evalJson(session: { client: Client }, projectDir: string, expression: string): Promise<unknown> {
  const r = await repl(session, { action: "eval", projectDir, code: `JSON.stringify(${expression})` });
  assert.ok(!isErrorResult(r), textOf(r));
  const sc = structuredOf(r);
  assert.ok(typeof sc.result === "string", `the eval resolved with a value: ${JSON.stringify(sc)}`);
  return JSON.parse(sc.result as string);
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return (res as { isError?: boolean }).isError === true;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the repl tool registers alongside workflow with the redesign's two-action schema; snapshotting is implicit (no snapshot action)", async () => {
  const Schema = z.object(replToolInputShape);
  // The field set is exactly the redesign's surface.
  assert.deepEqual(Object.keys(replToolInputShape).sort(), ["action", "code", "id", "projectDir", "timeoutMs"]);
  // No user-facing snapshot action: snapshotting is implicit.
  assert.ok(!("snapshot" in replToolInputShape), "snapshot must not be a tool action");
  // The action enum is exactly eval / interrupt.
  assert.doesNotThrow(() => Schema.parse({ action: "eval" }));
  assert.doesNotThrow(() => Schema.parse({ action: "interrupt" }));
  assert.throws(() => Schema.parse({ action: "snapshot" }), /Invalid option/);
  assert.throws(() => Schema.parse({ action: "wait" }), /Invalid option/);
  assert.throws(() => Schema.parse({ action: "status" }), /Invalid option/);
  assert.throws(() => Schema.parse({ action: "reset" }), /Invalid option/);
  assert.throws(() => Schema.parse({ action: "nope" }), /Invalid option/);
  // projectDir must be an absolute path.
  assert.throws(() => Schema.parse({ action: "eval", projectDir: "relative/path", code: "1" }), /absolute path/);
  assert.doesNotThrow(() => Schema.parse({ action: "eval", projectDir: "/abs/path", code: "1" }));
  // timeoutMs: an integer in [0, 120_000] (the soft-bound eval's cap).
  assert.throws(() => Schema.parse({ action: "eval", timeoutMs: -1 }));
  assert.throws(() => Schema.parse({ action: "eval", timeoutMs: 120_001 }));
  assert.throws(() => Schema.parse({ action: "eval", timeoutMs: 1.5 }));
  assert.doesNotThrow(() => Schema.parse({ action: "eval", timeoutMs: 0 }));
  assert.doesNotThrow(() => Schema.parse({ action: "eval", timeoutMs: 120_000 }));

  // The OUTPUT schema: the published machine-readable shape parses the
  // redesign's eval variant and refuses a malformed one.
  const OutputSchema = replToolOutputShape;
  assert.doesNotThrow(() => OutputSchema.parse({ output: "", result: "42" }));
  assert.doesNotThrow(() => OutputSchema.parse({ output: "", running: ["c1"] }));
  assert.doesNotThrow(() => OutputSchema.parse({ interrupt: { outcome: "refused-idle" } }));
  assert.doesNotThrow(() => OutputSchema.parse({ error: "nope" }));
  assert.throws(
    () => OutputSchema.parse({ output: "", interrupt: { outcome: "refused-idle" } }),
    /output does not match a repl result variant/,
  );
  assert.throws(
    () => OutputSchema.parse({ error: "x", interrupt: { outcome: "refused-idle" } }),
    /output does not match a repl result variant/,
  );

  // The WIRE schema of the real daemon advertises exactly that shape,
  // alongside the workflow tool.
  const daemon = await startReplDaemon(new FakeRunner());
  try {
    const session = await connectHttp(daemon.url, { listTools: true });
    try {
      const tools = await session.client.listTools();
      assert.deepEqual(
        tools.tools.map((t) => t.name).sort(),
        ["docs", "repl", "workflow", "workflow-events"],
        "repl registers alongside workflow (and the app-only events tool)",
      );
      const wire = tools.tools.find((t) => t.name === "repl")!;
      const schema = wire.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      assert.deepEqual(
        Object.keys(schema.properties).sort(),
        ["action", "code", "id", "projectDir", "timeoutMs"],
      );
      const action = schema.properties.action as { enum?: string[] };
      assert.deepEqual(action.enum, ["eval", "interrupt"]);
      assert.deepEqual(schema.required, ["action"], "action is the only required field");
      // The OUTPUT schema is advertised on the wire too: the redesign's
      // eval shape plus the interrupt outcome and the error variant.
      const wireOutput = wire.outputSchema as { properties?: Record<string, unknown>; oneOf?: Array<{ title?: string; required?: string[] }> };
      assert.ok(wireOutput, "the output schema is published on the wire");
      for (const field of ["output", "result", "running", "interrupt", "error"]) {
        assert.ok(field in (wireOutput.properties ?? {}), `output schema field ${field}`);
      }
      for (const dead of ["pending", "completed", "checkpoints", "outputTruncated", "truncated", "referenced", "drained", "timedOut", "workspaces", "dropped", "action"]) {
        assert.ok(!(dead in (wireOutput.properties ?? {})), `deleted output field ${dead}`);
      }
      assert.equal(wireOutput.oneOf?.length, 5, "the five output variants are published (finished / still-running / thrown eval, interrupt, error)");
      const evalFinished = wireOutput.oneOf?.find((b) => b.title === "eval");
      assert.deepEqual(
        evalFinished?.required?.sort(),
        ["output", "result"],
        "the finished eval branch requires exactly output + result",
      );
      const evalRunning = wireOutput.oneOf?.find((b) => b.title === "eval-still-running");
      assert.deepEqual(
        evalRunning?.required?.sort(),
        ["output", "running"],
        "the still-running eval branch requires exactly output + running",
      );
      const evalError = wireOutput.oneOf?.find((b) => b.title === "eval-error");
      assert.deepEqual(evalError?.required, ["output"], "the thrown-eval branch requires the output string alone");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("daemon mode: projectDir is required; eval/interrupt round-trip over the real HTTP daemon (soft-bound shapes included); reset() is the guest function", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-actions");
      // Daemon mode REQUIRES projectDir for both actions.
      const noDir = await repl(session, { action: "eval", code: "1 + 1" });
      assert.ok(isErrorResult(noDir), textOf(noDir));
      assert.ok(textOf(noDir).includes("projectDir is required on the shared workflow daemon"), textOf(noDir));
      // An unknown action is refused by the schema at the wire boundary.
      const badAction = await repl(session, { action: "snapshot", projectDir: PROJECT, code: "1" });
      assert.ok(isErrorResult(badAction), textOf(badAction));
      assert.ok(textOf(badAction).includes("Input validation error"), textOf(badAction));
      // An empty script is VALID JavaScript and the documented poll idiom.
      const emptyCode = await repl(session, { action: "eval", projectDir: PROJECT, code: "" });
      assert.ok(!isErrorResult(emptyCode), textOf(emptyCode));
      assert.ok(textOf(emptyCode).includes("result: undefined"), textOf(emptyCode));
      const structuredEmpty = structuredOf(emptyCode);
      assert.equal(structuredEmpty.output, "");
      assert.equal(structuredEmpty.result, "undefined");
      // eval round trip.
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: "var answer = 40 + 2; answer" });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      assert.ok(textOf(evaled).includes("result: 42"), textOf(evaled));
      // The workspace manifest through workspace(): metadata (name/type
      // token), never content. EVERY binding carries its byte size.
      const ws = (await evalJson(session, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; type: string; sizeBytes: number; token?: string }>;
      };
      assert.ok(ws.bindings.some((b) => b.name === "answer" && b.type === "number"), JSON.stringify(ws.bindings));
      assert.ok(!JSON.stringify(ws).includes("40 + 2"), `content leaked: ${JSON.stringify(ws)}`);
      // A pending subagent call; the soft-bound eval reports the honest
      // still-running shape when the bound elapses (the call continues
      // server-side).
      const started = await repl(session, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(started), textOf(started));
      assert.equal(structuredOf(started).result, "started", "start-and-don't-await finishes immediately");
      await tick();
      const timedOut = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: "await p",
        timeoutMs: 100,
      });
      assert.ok(!isErrorResult(timedOut), textOf(timedOut));
      const scTimedOut = structuredOf(timedOut);
      assert.deepEqual(Object.keys(scTimedOut).sort(), ["output", "running"], "the still-running shape");
      assert.deepEqual(scTimedOut.running, ["c1"], "the in-flight call ids");
      assert.ok(textOf(timedOut).includes("running: c1"), textOf(timedOut));
      // The fused pump absorbs a MID-HOLD settlement: the eval call is
      // held open while the HTTP request is open, and the backend's
      // settlement resolves it in the SAME call (the finished shape).
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started"' });
      await tick();
      const waiting = repl(session, { action: "eval", projectDir: PROJECT, code: "await q", timeoutMs: 5000 });
      await tick();
      runner.last().completeTurn("waited result");
      const waited = await waiting;
      assert.ok(!isErrorResult(waited), textOf(waited));
      const scWaited = structuredOf(waited);
      assert.deepEqual(Object.keys(scWaited).sort(), ["output", "result"], "the finished shape");
      assert.equal(scWaited.result, "waited result");
      // The earlier still-running eval's promise is still live: `await p`
      // resolves once ITS turn completes.
      runner.sessions[0].completeTurn("p result");
      const picked = await repl(session, { action: "eval", projectDir: PROJECT, code: "await p" });
      assert.equal(structuredOf(picked).result, "p result");
      // interrupt with an id cancels the subagent call (ACP
      // session/cancel downward).
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const r = agent("pi/x", "task3"); "started"' });
      await tick();
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c3" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
      assert.deepEqual(structuredOf(interrupted), { interrupt: { outcome: "cancelled", callId: "c3" } });
      // interrupt without an id BREAKS THE RUNNING EVAL: a runaway loop
      // that keeps EXECUTING across drains (each iteration does real
      // work, fires the next subagent call, and suspends) is held open
      // by the fused pump; the interrupt lands while the eval call is IN
      // FLIGHT; the pump's next iteration breaks the loop MID-RUN via
      // the quickjs interrupt handler.
      const inFlight = repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const s = agent("pi/x", "task4"); await s; for (;;) { let x = 0; for (let i = 0; i < 200000; i++) x += i; await agent("pi/x", "again"); }',
        timeoutMs: 30_000,
      });
      await tick();
      await tick();
      const armed = await repl(session, { action: "interrupt", projectDir: PROJECT });
      assert.ok(!isErrorResult(armed), textOf(armed));
      assert.ok(textOf(armed).includes("interrupting the running eval"), textOf(armed));
      assert.deepEqual(structuredOf(armed), { interrupt: { outcome: "targeted" } });
      // The first settlement: the pump resumes the loop's next iteration
      // — and the armed signal breaks it MID-RUN. The broken eval can
      // never settle: the held eval returns the finished-with-error
      // shape promptly, and the interrupted drain is retained in
      // workspace().diagnostics (§6.2).
      runner.last().completeTurn("resumed");
      const broken = await inFlight;
      assert.ok(!isErrorResult(broken), textOf(broken));
      const scBroken = structuredOf(broken);
      assert.ok(!("running" in scBroken) && !("result" in scBroken), `the broken eval returned promptly: ${JSON.stringify(scBroken)}`);
      const diag = (await evalJson(session, PROJECT, "workspace().diagnostics")) as { drainError: { message: string } | null };
      assert.ok(
        diag.drainError !== null && (diag.drainError.message.includes("interrupted") || diag.drainError.message.includes("Job execution error")),
        `the interrupted drain is retained in diagnostics: ${JSON.stringify(diag.drainError)}`,
      );
      // The signal was consumed by the running eval's execution: the
      // next eval is NOT broken, and the VM stays usable.
      const afterInterrupt = await repl(session, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
      assert.ok(textOf(afterInterrupt).includes("result: 42"), textOf(afterInterrupt));
      // reset() — the §4.5 guest function: the teardown runs after the
      // eval completes; the next eval starts a fresh workspace.
      const reset = await repl(session, { action: "eval", projectDir: PROJECT, code: "reset()" });
      assert.ok(!isErrorResult(reset), textOf(reset));
      const gone = await repl(session, { action: "eval", projectDir: PROJECT, code: "typeof answer" });
      assert.ok(!isErrorResult(gone), textOf(gone));
      assert.ok(textOf(gone).includes("undefined"), textOf(gone));
      // A GLOBAL LEXICAL binding (top-level let/const/class — the
      // canonical `const research = agent(...)` state) is listed by
      // workspace() with its full provenance surface.
      const lexed = await repl(session, { action: "eval", projectDir: PROJECT, code: 'const research = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(lexed), textOf(lexed));
      const wsLex = (await evalJson(session, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; type: string; status?: string; callId?: string; provenance: string | null; task: string | null }>;
      };
      const binding = wsLex.bindings.find((b) => b.name === "research");
      assert.ok(binding, JSON.stringify(wsLex.bindings));
      assert.equal(binding.type, "agent handle");
      assert.equal(binding.callId, "c1");
      assert.equal(binding.status, "pending");
      assert.equal(binding.provenance, "eval 2", "the provenance pass counts the fresh workspace's evals");
      assert.equal(binding.task, "task");
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
      assert.ok(textOf(probeB).includes("undefined"), textOf(probeB));
      const b = await repl(session, { action: "eval", projectDir: projectB, code: 'const secretB = "beta"; "B"' });
      assert.ok(!isErrorResult(b), textOf(b));
      // ...and A does not see B's.
      const probeA = await repl(session, { action: "eval", projectDir: projectA, code: "typeof secretB" });
      assert.ok(!isErrorResult(probeA), textOf(probeA));
      assert.ok(textOf(probeA).includes("undefined"), textOf(probeA));
      // Each project persisted its OWN repl store (one enveloped snapshot
      // per project, under the daemon's per-project layout).
      const pathsA = workflowProjectPaths(projectA);
      const pathsB = workflowProjectPaths(projectB);
      const storeA = join(pathsA.rootDir, "repl");
      const storeB = join(pathsB.rootDir, "repl");
      assert.notEqual(storeA, storeB);
      assert.ok(existsSync(join(storeA, "snapshot.bin")), "A's snapshot exists");
      assert.ok(existsSync(join(storeB, "snapshot.bin")), "B's snapshot exists");
      // resetting A never touches B: B's binding and store survive, and
      // A's stored state is gone — the next touch starts a FRESH
      // workspace, never a restore, and the old binding is gone.
      await repl(session, { action: "eval", projectDir: projectA, code: "reset()" });
      const bAlive = await repl(session, { action: "eval", projectDir: projectB, code: "secretB" });
      assert.ok(!isErrorResult(bAlive), textOf(bAlive));
      assert.ok(textOf(bAlive).includes("beta"), textOf(bAlive));
      const aGone = await repl(session, { action: "eval", projectDir: projectA, code: "typeof secretA" });
      assert.ok(!isErrorResult(aGone), textOf(aGone));
      assert.ok(textOf(aGone).includes("undefined"), textOf(aGone));
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
      const ws = (await evalJson(session2, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; type: string }>;
      };
      assert.ok(ws.bindings.some((b) => b.name === "x" && b.type === "number"), JSON.stringify(ws.bindings));
    } finally {
      await session2.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("the session registry drives the client-presence drain on the real daemon: last-client disconnect drains the in-flight turn to completion, closes the idle child, and the next queued turn lazily re-attaches", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const PROJECT = makeProjectDir("repl-drain");
    const session1 = await connectHttp(daemon.url);
    try {
      const started = await repl(session1, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(started), textOf(started));
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
    // never drops it), children closed — and queue() on the settled
    // handle lazily re-attaches the recorded backend session via the
    // capability matrix (loadSession with the SAME session id).
    const session2 = await connectHttp(daemon.url);
    try {
      const ws = (await evalJson(session2, PROJECT, "workspace()")) as {
        diagnostics: { childrenClosed: boolean };
      };
      assert.equal(ws.diagnostics.childrenClosed, true, "children closed after the drain");
      const probe = await repl(session2, { action: "eval", projectDir: PROJECT, code: 'p.queue("more"); "fired"' });
      assert.ok(!isErrorResult(probe), textOf(probe));
      await tick();
      assert.equal(runner.loadedWith.length, 1, "the recorded session was loaded lazily on the next connect");
      assert.equal(runner.loadedWith[0].sessionId, session.sessionId, "the SAME backend session");
      // The queued turn starts on the re-attached
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
      // scheduled drain aborts — the child stays warm.
      daemon.sessions.connectionOpened(record.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(child.releases, 0, "the reconnect aborted the drain — the child stays warm");
      assert.equal(child.cancelCalls, 0, "nothing was cancelled");
      // The turn completes normally and settles into the live workspace;
      // the workspace stays warm (children not closed).
      child.completeTurn("warm after reconnect");
      const got = await repl(session, { action: "eval", projectDir: PROJECT, code: "await p" });
      assert.ok(!isErrorResult(got), textOf(got));
      assert.equal(structuredOf(got).result, "warm after reconnect");
      const ws = (await evalJson(session, PROJECT, "workspace()")) as {
        diagnostics: { childrenClosed: boolean };
      };
      assert.equal(ws.diagnostics.childrenClosed, false, "the workspace is warm");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("reset() does not clear client presence: with a second client still connected, the resetting client's disconnect does NOT drain the post-reset workspace", async () => {
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
      await repl(sessionB, { action: "eval", projectDir: PROJECT, code: '"b present"' });
      await tick();
      // A resets: the workspace is dropped, but the CONNECTIONS stay —
      // presence is connection liveness, not workspace state.
      const reset = await repl(sessionA, { action: "eval", projectDir: PROJECT, code: "reset()" });
      assert.ok(!isErrorResult(reset), textOf(reset));
      // A starts NEW work on the fresh workspace.
      const restarted = await repl(sessionA, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started2"' });
      assert.ok(!isErrorResult(restarted), textOf(restarted));
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
      assert.equal(structuredOf(got).result, "post-reset result");
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

test("workflow calls register project presence: a workflow-only client B keeps the workspace warm when repl-client A disconnects (phase-E review rejection round 2)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const PROJECT = makeProjectDir("repl-workflow-presence");
    const sessionA = await connectHttp(daemon.url);
    const sessionB = await connectHttp(daemon.url);
    try {
      // A touches the repl workspace (a child opens).
      const start = await repl(sessionA, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
      assert.ok(!isErrorResult(start), textOf(start));
      await tick();
      const child = runner.last();
      // B addresses the SAME project through the WORKFLOW tool (a
      // trivial script — no agents, nothing repl-related). The workflow
      // handler resolves the same per-project context and registers the
      // session's presence on it.
      const ran = await sessionB.client.callTool({
        name: "workflow",
        arguments: {
          action: "run",
          projectDir: PROJECT,
          script: 'export const meta = { name: "empty", description: "empty script" };',
        },
      });
      assert.ok(!(ran as { isError?: boolean }).isError, textOf(ran));
      // A's connection drops while B is still connected to the project
      // through workflow calls: NO drain may fire — the post-workflow
      // child stays warm.
      await sessionA.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(child.releases, 0, "no drain while B (a workflow-only client) is connected");
      assert.equal(child.cancelCalls, 0, "nothing was cancelled");
      // The in-flight turn completes and settles into the live workspace.
      child.completeTurn("wf-presence result");
      const got = await repl(sessionB, { action: "eval", projectDir: PROJECT, code: "await p" });
      assert.ok(!isErrorResult(got), textOf(got));
      assert.equal(structuredOf(got).result, "wf-presence result");
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

test("every repl action returns the redesign's machine-readable shape as structuredContent — eval { output, result?, running? }, the interrupt outcome, and the error variant (guest output and orchestration metadata were separate fields in v1; the redesign's output is ONE string)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-structured");
      // eval: the redesign's shape — ONE newline-joined output string
      // (console lines), the result repr, and nothing else.
      const evaled = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const research = agent("pi/x", "investigate"); globalThis.answer = 42; console.log("hello"); answer',
      });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      const sc = structuredOf(evaled);
      assert.deepEqual(Object.keys(sc).sort(), ["output", "result"]);
      assert.equal(sc.output, "hello");
      assert.equal(sc.result, "42");
      assert.ok(textOf(evaled).includes("result: 42"), "the human text stays alongside");

      // The still-running shape with the mid-hold settlement absorbed.
      await tick();
      const waiting = repl(session, { action: "eval", projectDir: PROJECT, code: "await research", timeoutMs: 5000 });
      await tick();
      runner.last().completeTurn("waited result");
      const waited = await waiting;
      assert.ok(!isErrorResult(waited), textOf(waited));
      const scWaited = structuredOf(waited);
      assert.deepEqual(Object.keys(scWaited).sort(), ["output", "result"]);
      assert.equal(scWaited.result, "waited result");

      // A timed-out hold reports the still-running shape with the ids.
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const q2 = agent("pi/x", "task2"); "started2"' });
      const timedOut = await repl(session, { action: "eval", projectDir: PROJECT, code: "await q2", timeoutMs: 100 });
      const scTimedOut = structuredOf(timedOut);
      assert.deepEqual(scTimedOut, { output: "", running: ["c2"] });
      assert.ok(textOf(timedOut).includes("running: c2"), textOf(timedOut));

      // interrupt with an id: the honest outcome + the call id.
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c2" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      const scInterrupt = structuredOf(interrupted);
      assert.deepEqual(scInterrupt, { interrupt: { outcome: "cancelled", callId: "c2" } });
      assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
      // interrupt without an id on an idle workspace: the honest refusal
      // (a fresh project — nothing ever ran).
      const idleProject = makeProjectDir("repl-structured-idle");
      const refused = await repl(session, { action: "interrupt", projectDir: idleProject });
      const scRefused = structuredOf(refused);
      assert.deepEqual(scRefused, { interrupt: { outcome: "refused-idle" } });
      assert.ok(textOf(refused).includes("no running eval to interrupt"), textOf(refused));
      // interrupt without an id on a RUNNING eval: outcome "targeted".
      const running = repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const q3 = agent("pi/x", "task3"); await q3; while (true) {}',
        timeoutMs: 30_000,
      });
      await tick();
      const targeted = await repl(session, { action: "interrupt", projectDir: PROJECT });
      const scTargeted = structuredOf(targeted);
      assert.deepEqual(scTargeted, { interrupt: { outcome: "targeted" } });
      assert.ok(textOf(targeted).includes("interrupting the running eval"), textOf(targeted));
      // The targeted runaway is broken at its next execution — the held
      // eval returns promptly (the finished-with-error shape).
      await tick();
      runner.last().completeTurn("resumed");
      const broken = await running;
      assert.ok(!isErrorResult(broken), textOf(broken));
      assert.ok(!("running" in structuredOf(broken)), "the broken eval returned");
      // reset() via the guest function.
      const reset = await repl(session, { action: "eval", projectDir: PROJECT, code: "reset()" });
      assert.ok(!isErrorResult(reset), textOf(reset));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

// ── Round 4: exact action shapes, manifest fields, bounded surface ────

test("review round 4: the input is action-discriminated — every action's EXACT field set is enforced at the boundary (eval without code, interrupt with code/timeoutMs, eval with id: all rejected with 'cannot include'/'requires'; irrelevant known fields are never silently accepted)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-shapes");
      // Missing required fields: eval WITHOUT the code field is still
      // rejected (the absent field fails the exact-shape boundary — only
      // the present-but-empty string is valid).
      const noCode = await repl(session, { action: "eval", projectDir: PROJECT });
      assert.ok(isErrorResult(noCode), textOf(noCode));
      assert.ok(textOf(noCode).includes("eval requires a code string"), textOf(noCode));
      // Extraneous known fields per action.
      const interruptWithTimeout = await repl(session, { action: "interrupt", projectDir: PROJECT, timeoutMs: 100 });
      assert.ok(isErrorResult(interruptWithTimeout), textOf(interruptWithTimeout));
      assert.ok(textOf(interruptWithTimeout).includes('cannot include timeoutMs'), textOf(interruptWithTimeout));
      const interruptWithCode = await repl(session, { action: "interrupt", projectDir: PROJECT, code: "1 + 1" });
      assert.ok(isErrorResult(interruptWithCode), textOf(interruptWithCode));
      assert.ok(textOf(interruptWithCode).includes('cannot include code'), textOf(interruptWithCode));
      const evalWithId = await repl(session, { action: "eval", projectDir: PROJECT, code: "1 + 1", id: "c1" });
      assert.ok(isErrorResult(evalWithId), textOf(evalWithId));
      assert.ok(textOf(evalWithId).includes('cannot include id'), textOf(evalWithId));
      // The workspace was never created by the rejected calls: a well-
      // formed eval works.
      const ok = await repl(session, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
      assert.ok(!isErrorResult(ok), textOf(ok));
      assert.ok(textOf(ok).includes("result: 42"), textOf(ok));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 4: workspace() carries the machine-readable type and live-handle status fields — `agent handle` type, the call id, and pending→settled status transitions as their own fields", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-manifest-fields");
      const evaled = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const research = agent("pi/x", "investigate"); globalThis.answer = 42; console.log("hello"); answer',
      });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      const ws = (await evalJson(session, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; type: string; callId?: string; status?: string }>;
      };
      const handle = ws.bindings.find((b) => b.name === "research");
      assert.ok(handle, "the agent handle binding");
      assert.equal(handle.type, "agent handle", "the machine-readable type");
      assert.equal(handle.callId, "c1", "the call id is its own field");
      assert.equal(handle.status, "pending", "the live-handle status is its own field");
      const plain = ws.bindings.find((b) => b.name === "answer");
      assert.ok(plain, "the plain binding");
      assert.equal(plain.type, "number", "the plain binding's machine-readable type");
      assert.equal(plain.callId, undefined);
      assert.equal(plain.status, undefined);
      // The handle settles: the status transitions to `settled` (the
      // call store is the authority).
      runner.last().completeTurn("done");
      await tick();
      const picked = await repl(session, { action: "eval", projectDir: PROJECT, code: "await research" });
      assert.equal(structuredOf(picked).result, "done");
      const wsAfter = (await evalJson(session, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; status?: string }>;
      };
      const handleAfter = wsAfter.bindings.find((b) => b.name === "research");
      assert.equal(handleAfter?.status, "settled", "the handle status transitioned");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 8 (flipped by the redesign): agents() ships the modelSpec VERBATIM — the old 200-char status cap is deleted with the structured-status surface (§7 kept the 200-char bound only for manifest tokens and task previews)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-modelspec-verbatim");
      const hugeSpec = "pi/" + "X".repeat(500);
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const big = agent(${JSON.stringify(hugeSpec)}, "task"); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      const agents = (await evalJson(session, PROJECT, "agents()")) as Array<{ callId: string; modelSpec: string }>;
      assert.equal(agents.length, 1);
      assert.equal(agents[0].callId, "c1");
      assert.equal(agents[0].modelSpec, hugeSpec, "the full model spec, verbatim");
      // The workspace manifest's task preview keeps its 200-char metadata
      // bound (a retained §7 preview — metadata formatting, not a cap).
      const ws = (await evalJson(session, PROJECT, "workspace()")) as {
        bindings: Array<{ name: string; task: string | null }>;
      };
      assert.equal(ws.bindings.find((b) => b.name === "big")?.task, "task");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 8: interrupt { id } cancels a call whose openSession is still pending — the call settles durably as the recoverable AGENT_CANCELLED, and the LATE child is closed without ever prompting", async () => {
  const runner = new DelayedOpenRunner();
  runner.parkOpens();
  const PROJECT = makeProjectDir("repl-interrupt-opening");
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const p = agent("pi/x", "task"); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      // The interrupt lands while openSession is STILL parked: the
      // old decision returned 'none' (no live session, no lazy
      // re-attach record) and the eventual open went on to prompt a
      // supposedly-interrupted call.
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c1" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      const si = structuredOf(interrupted);
      assert.equal((si.interrupt as { outcome: string }).outcome, "cancelled", `honest outcome: ${JSON.stringify(si.interrupt)}`);
      // The guest promise settled NOW with the recoverable error — not
      // when the open eventually lands.
      const read = await repl(session, { action: "eval", projectDir: PROJECT, code: `await p.catch((e) => "ERR:" + e.message)` });
      assert.ok(!isErrorResult(read), textOf(read));
      const sc1 = structuredOf(read);
      assert.ok(
        String(sc1.result).includes("turn c1 was cancelled"),
        `guest-visible settlement: ${sc1.result}`,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
  // DURABILITY: a daemon restart over the same store restores the
  // snapshot (the rejected promise is part of it) and the recorded
  // completion — the cancellation is durable, never re-issued, never
  // re-opened (a fresh daemon must not open a session for a settled
  // call).
  const daemon2 = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon2.url);
    try {
      const read = await repl(session, { action: "eval", projectDir: PROJECT, code: `await p.catch((e) => "ERR:" + e.message)` });
      assert.ok(!isErrorResult(read), textOf(read));
      const sc = structuredOf(read);
      assert.ok(
        String(sc.result).includes("turn c1 was cancelled"),
        `the restart settles the durable cancellation: ${sc.result}`,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon2.close();
  }
  // The LATE open lands after everything: the child is closed
  // immediately — it never prompts (a supposedly-interrupted call must
  // not run a turn), and nothing re-opened across the restart.
  runner.releaseOpens();
  await tick();
  assert.equal(runner.sessions.length, 1, "exactly one session ever opened");
  assert.equal(runner.sessions[0].prompts.length, 0, "the stopped call never ran a turn");
  assert.equal(runner.sessions[0].releases, 1, "the late child was closed without prompting");
});

test("review round 9: interrupt { id } on a still-OPENING call is IMMEDIATELY durable — the daemon can be killed right after the interrupt (NO eval in between) and the restart restores the SETTLED workspace: the reconcile's store arm has nothing to settle and the continuation binding carries the settlement provenance", async () => {
  const runner = new DelayedOpenRunner();
  runner.parkOpens();
  const PROJECT = makeProjectDir("repl-interrupt-opening-immediate");
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      // The settlement drain's continuation creates a binding whose
      // provenance must travel INSIDE the interrupt's own snapshot.
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const p = agent("pi/x", "task"); p.catch(() => { globalThis.wasCancelled = true; }); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c1" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      const si = structuredOf(interrupted);
      assert.equal((si.interrupt as { outcome: string }).outcome, "cancelled", `honest outcome: ${JSON.stringify(si.interrupt)}`);
      // NO further repl calls — the daemon dies immediately. The
      // interrupt's own settlement boundary must already have persisted
      // the settled workspace (the op-end flush writes before the tool
      // call resolves).
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
  // The restart over the same home: the FIRST read is an eval, and it
  // must already see the settlement — the restored registry is settled
  // (c1 not pending) and the continuation binding carries the
  // settlement's provenance FROM THE SNAPSHOT.
  const daemon2 = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon2.url);
    try {
      const ws = (await evalJson(session, PROJECT, "workspace()")) as {
        inFlight: string[];
        bindings: Array<{ name: string; provenance: string | null }>;
        diagnostics: { reconcile: { settledFromStore: string[] } | null };
      };
      assert.ok(!ws.inFlight.includes("c1"), `the restored registry is settled: ${JSON.stringify(ws.inFlight)}`);
      // The discriminator: the interrupt's OWN snapshot carried the
      // settlement, so the restart's reconcile has NOTHING for the
      // store arm.
      assert.ok(ws.diagnostics.reconcile !== null, "the restored workspace carries its reconcile summary");
      assert.deepEqual(ws.diagnostics.reconcile!.settledFromStore, [], "the store arm had nothing to settle — the snapshot already carried the settlement");
      const wasCancelled = ws.bindings.find((b) => b.name === "wasCancelled");
      assert.ok(wasCancelled !== undefined, `the continuation binding survived the restart: ${JSON.stringify(ws.bindings)}`);
      assert.equal(wasCancelled.provenance, "worker c1", "the settlement provenance traveled inside the interrupt's snapshot");
      // The guest promise rejects with the durable cancellation.
      const read = await repl(session, { action: "eval", projectDir: PROJECT, code: `await p.catch((e) => "ERR:" + e.message)` });
      assert.ok(!isErrorResult(read), textOf(read));
      const sc1 = structuredOf(read);
      assert.ok(
        String(sc1.result).includes("turn c1 was cancelled"),
        `the restart settles the durable cancellation: ${sc1.result}`,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon2.close();
  }
  // The LATE open lands after everything: the child is closed
  // immediately — it never prompts — and nothing re-opened across the
  // immediate restart.
  runner.releaseOpens();
  await tick();
  assert.equal(runner.sessions.length, 1, "exactly one session ever opened");
  assert.equal(runner.sessions[0].prompts.length, 0, "the stopped call never ran a turn");
  assert.equal(runner.sessions[0].releases, 1, "the late child was closed without prompting");
});
