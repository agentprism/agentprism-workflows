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
 * - interrupt without an id breaks a RUNNING eval: an eval that keeps
 *   EXECUTING across drains (a runaway loop over subagent calls) is in
 *   flight while a wait pumps it; the interrupt lands mid-wait (the
 *   wait releases the broker chain between its pumps) and the wait's
 *   very next pump breaks the loop's next iteration MID-RUN via the
 *   quickjs interrupt handler; the signal is consumed by that
 *   execution (a later eval is unaffected).
 * - the machine-readable output (phase-E review round 3): the tool
 *   publishes an outputSchema and every result carries the doc's
 *   shapes as structuredContent — eval/wait `{ output, result?,
 *   pending, checkpoints, completed }` (plus the wait-only
 *   drained/timedOut flags), the structured status workspaces surface
 *   (workspace state, reconcile summary, the workspace manifest, live
 *   agents, pending ops), the interrupt outcome, the reset
 *   acknowledgement, and the error variant — guest output and trusted
 *   orchestration metadata as separate fields, never one flat string;
 *   and the pending surface reports the WHOLE guest registry (the
 *   trap-free read cap that used to truncate it at 256 entries leaked
 *   an undefined hole into the structured array) — bounded on the wire
 *   by the aggregate structured-result cap (phase-E review round 8:
 *   the serialized structuredContent respects the doc's 10 KB bound
 *   with every elision flagged in the `truncated` record, so kept
 *   prefix + elided count always reconcile to the true totals).
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
import { OUTPUT_MAX_BYTES } from "@automatalabs/repl-engine";
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

  // The OUTPUT schema (phase-E review round 3): the published
  // machine-readable shape parses the doc's eval/wait variant and
  // refuses a malformed one (the superRefine mirrors the oneOf
  // branches at runtime — the workflow output shape's pattern).
  const OutputSchema = replToolOutputShape;
  assert.doesNotThrow(() =>
    OutputSchema.parse({
      action: "eval",
      projectDir: "/p",
      output: [],
      outputTruncated: false,
      pending: [],
      checkpoints: [],
      completed: [],
    }),
  );
  assert.doesNotThrow(() =>
    OutputSchema.parse({
      action: "wait",
      projectDir: "/p",
      output: [],
      outputTruncated: false,
      pending: ["c1"],
      checkpoints: [],
      completed: [],
      drained: false,
      timedOut: true,
    }),
  );
  assert.doesNotThrow(() =>
    OutputSchema.parse({ action: "status", projectDir: "/p", workspaces: [] }),
  );
  assert.throws(
    () => OutputSchema.parse({ action: "eval", projectDir: "/p", output: [], pending: [] }),
    /output does not match a repl result variant/,
  );
  assert.throws(
    () => OutputSchema.parse({ action: "wait", projectDir: "/p", output: [], outputTruncated: false, pending: [], checkpoints: [], completed: [] }),
    /output does not match a repl result variant/,
  );
  assert.throws(
    () => OutputSchema.parse({ action: "reset", projectDir: "/p" }),
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
      // The OUTPUT schema is advertised on the wire too (phase-E review
      // round 3: the tool used to register with no outputSchema at all):
      // the doc's eval/wait fields plus the structured status, interrupt
      // and reset surfaces, as six oneOf variants.
      const wireOutput = wire.outputSchema as { properties?: Record<string, unknown>; oneOf?: Array<{ title?: string; required?: string[] }> };
      assert.ok(wireOutput, "the output schema is published on the wire");
      for (const field of ["action", "output", "outputTruncated", "result", "pending", "checkpoints", "completed", "drained", "timedOut", "workspaces", "interrupt", "dropped", "error"]) {
        assert.ok(field in (wireOutput.properties ?? {}), `output schema field ${field}`);
      }
      assert.equal(wireOutput.oneOf?.length, 6, "the six output variants are published");
      const evalBranch = wireOutput.oneOf?.find((b) => b.title === "eval");
      assert.ok(
        evalBranch?.required?.includes("output") &&
          evalBranch.required.includes("pending") &&
          evalBranch.required.includes("checkpoints") &&
          evalBranch.required.includes("completed"),
        "the eval branch requires the doc's shape",
      );
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
      // An empty script is VALID JavaScript (the doc's `eval { projectDir,
      // code }` has no non-empty restriction — phase-E review round 5:
      // the tool used to invent one): it resolves with `undefined` and
      // returns the normal resolved eval shape.
      const emptyCode = await repl(session, { action: "eval", projectDir: PROJECT, code: "" });
      assert.ok(!isErrorResult(emptyCode), textOf(emptyCode));
      assert.ok(textOf(emptyCode).includes("result: undefined"), textOf(emptyCode));
      const structuredEmpty = (emptyCode as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
      assert.deepEqual(structuredEmpty.output, []);
      assert.deepEqual(structuredEmpty.pending, []);
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
      // rejection round 2: the old test exercised a suspended
      // continuation — the eval had never executed when the interrupt
      // landed, and the old waitForCalls held the broker chain across
      // its whole bounded poll, so an interrupt sent mid-wait could not
      // even be PROCESSED until the wait finished or timed out). Here
      // the eval is a runaway that KEEPS EXECUTING across drains (each
      // iteration does real work, fires the next subagent call, and
      // suspends — it is in flight the whole time, mid-run), a wait is
      // pumping it, and the interrupt lands WHILE THE WAIT IS IN
      // FLIGHT; the wait's very next pump resumes the loop's next
      // iteration and the quickjs interrupt handler breaks it MID-RUN.
      const inFlight = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const s = agent("pi/x", "task4"); await s; for (;;) { let x = 0; for (let i = 0; i < 200000; i++) x += i; await agent("pi/x", "again"); }',
      });
      assert.ok(!isErrorResult(inFlight), textOf(inFlight));
      assert.ok(textOf(inFlight).includes("pending: c1, c4"), textOf(inFlight));
      // The wait starts pumping the running eval; the interrupt must be
      // PROCESSED while the wait is still in flight — the wait releases
      // the broker chain between its pumps, so the interrupt call is
      // served mid-wait (the old code held the chain: the interrupt
      // queued behind the whole bounded wait and could not break the
      // eval before the target completed).
      let wait1Done = false;
      const waiting1 = repl(session, { action: "wait", projectDir: PROJECT, ids: ["c4"], timeoutMs: 30000 }).then((r) => {
        wait1Done = true;
        return r;
      });
      await tick();
      await tick();
      const armed = await repl(session, { action: "interrupt", projectDir: PROJECT });
      assert.ok(!isErrorResult(armed), textOf(armed));
      assert.ok(textOf(armed).includes("interrupting the running eval"), textOf(armed));
      assert.ok(!wait1Done, "the interrupt was processed MID-WAIT (the wait was still pumping, its target unsettled)");
      // The first settlement: the wait's very next pump resumes the
      // loop's next iteration — and the armed signal breaks it MID-RUN
      // (the break is the wait's own pump-drain error — honest output
      // in the wait's result).
      runner.last().completeTurn("resumed");
      const waited1 = await waiting1;
      assert.ok(!isErrorResult(waited1), textOf(waited1));
      assert.ok(textOf(waited1).includes("completed: c4"), textOf(waited1));
      assert.ok(textOf(waited1).includes("interrupted"), `the executing runaway was broken mid-run: ${textOf(waited1)}`);
      // The signal was consumed by the running eval's execution: the
      // next eval is NOT broken, and the VM stays usable.
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
      // session's presence on it (phase-E review rejection round 2: only
      // repl calls used to register presence, so B's connection was
      // invisible to the drain and A's disconnect below would have
      // drained/closed children while B was still connected).
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
      assert.ok(textOf(got).includes("wf-presence result"), textOf(got));
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

test("every repl action returns the doc's machine-readable shape as structuredContent alongside the bounded text — eval/wait { output, result?, pending, checkpoints, completed } with the wait-only drained/timedOut flags, the structured status workspaces surface (state, reconcile, manifest, live agents, pending ops), the interrupt outcome, and the reset acknowledgement (phase-E review round 3: the text-only result mixed guest output and orchestration metadata into one flat string)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-structured");
      // eval: the doc's shape, guest output and trusted orchestration
      // metadata as separate fields.
      const evaled = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: 'const research = agent("pi/x", "investigate"); globalThis.answer = 42; console.log("hello"); answer',
      });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      const sc = (evaled as { structuredContent?: Record<string, unknown> }).structuredContent;
      assert.ok(sc !== undefined, "structured content present");
      assert.equal(sc.action, "eval");
      assert.equal(sc.projectDir, PROJECT);
      assert.equal((sc.output as string[]).length, 1);
      assert.ok((sc.output as string[])[0].includes('"hello"'), `output line: ${(sc.output as string[])[0]}`);
      assert.equal(sc.outputTruncated, false);
      assert.equal(sc.result, "42");
      assert.deepEqual(sc.pending, ["c1"]);
      assert.deepEqual(sc.checkpoints, []);
      assert.deepEqual(sc.completed, []);
      assert.equal((sc as Record<string, unknown>).drained, undefined, "no wait-only flags on eval");
      assert.ok(textOf(evaled).includes("result: 42"), "the bounded text stays alongside");

      // status: the structured workspaces surface — state, the manifest
      // (bindings with size and provenance, never value content), the
      // live agents, the pending ops.
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const scStatus = (status as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal(scStatus.action, "status");
      assert.equal(scStatus.projectDir, PROJECT);
      const workspaces = scStatus.workspaces as Array<Record<string, unknown>>;
      assert.equal(workspaces.length, 1);
      const w = workspaces[0];
      assert.equal(w.projectDir, PROJECT);
      assert.equal(w.state, "fresh");
      const bindings = w.bindings as Array<Record<string, unknown>>;
      assert.ok(bindings.some((b) => b.name === "answer" && b.sizeBytes === 8), "manifest binding with its byte size");
      assert.ok(bindings.some((b) => b.name === "research" && (b.token as string).includes("agent handle")), "the agent handle binding");
      assert.ok(bindings.some((b) => b.name === "research" && (b.task as string) === "investigate"), "the task provenance");
      assert.ok((w.liveAgents as Array<Record<string, unknown>>).some((a) => a.callId === "c1" && a.state === "running"), "the live agent with its state");
      assert.deepEqual(w.pending, ["c1"]);
      assert.deepEqual(w.checkpoints, []);
      assert.equal(w.childrenClosed, false);
      assert.equal(w.drainError, undefined);

      // wait: the SAME eval/wait shape plus drained/timedOut (the doc's
      // "still running on timeout" as a machine-readable flag), with the
      // mid-wait settlement absorbed.
      await tick();
      const waiting = repl(session, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
      await tick();
      runner.last().completeTurn("waited result");
      const waited = await waiting;
      assert.ok(!isErrorResult(waited), textOf(waited));
      const scWaited = (waited as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal(scWaited.action, "wait");
      assert.equal(scWaited.drained, true);
      assert.equal(scWaited.timedOut, false);
      assert.deepEqual(scWaited.completed, ["c1"]);
      assert.deepEqual(scWaited.pending, []);
      assert.ok(textOf(waited).includes("completed: c1"), textOf(waited));
      // The settled agent's RESULT text is worker content — it must not
      // leak into the status manifest (metadata, never content).
      const statusAfter = await repl(session, { action: "status", projectDir: PROJECT });
      const scAfter = (statusAfter as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok(!JSON.stringify(scAfter).includes("waited result"), "worker content never enters the manifest");

      // A timed-out wait reports drained: false / timedOut: true.
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const q2 = agent("pi/x", "task2"); "started2"' });
      const timedOut = await repl(session, { action: "wait", projectDir: PROJECT, ids: ["c2"], timeoutMs: 100 });
      const scTimedOut = (timedOut as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal(scTimedOut.drained, false);
      assert.equal(scTimedOut.timedOut, true);
      assert.ok(textOf(timedOut).includes("still running"), textOf(timedOut));

      // interrupt with an id: the honest outcome + the call id.
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c2" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      const scInterrupt = (interrupted as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.deepEqual(scInterrupt.interrupt, { outcome: "cancelled", callId: "c2" });
      assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
      // interrupt without an id on an idle workspace: the honest refusal.
      const refused = await repl(session, { action: "interrupt", projectDir: PROJECT });
      const scRefused = (refused as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.deepEqual(scRefused.interrupt, { outcome: "refused-idle" });
      assert.ok(textOf(refused).includes("no running eval to interrupt"), textOf(refused));
      // interrupt without an id on a RUNNING eval: outcome "targeted".
      await repl(session, { action: "eval", projectDir: PROJECT, code: 'const q3 = agent("pi/x", "task3"); await q3; while (true) {}' });
      const targeted = await repl(session, { action: "interrupt", projectDir: PROJECT });
      const scTargeted = (targeted as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.deepEqual(scTargeted.interrupt, { outcome: "targeted" });
      assert.ok(textOf(targeted).includes("interrupting the running eval"), textOf(targeted));
      // The targeted runaway is broken at its next execution, then the
      // reset acknowledgement.
      await tick();
      runner.last().completeTurn("resumed");
      const broken = await repl(session, { action: "eval", projectDir: PROJECT, code: '"after"' });
      assert.ok(textOf(broken).includes("interrupted"), `the armed target was broken: ${textOf(broken)}`);
      const reset = await repl(session, { action: "reset", projectDir: PROJECT });
      const scReset = (reset as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal(scReset.action, "reset");
      assert.equal(scReset.projectDir, PROJECT);
      assert.equal(scReset.dropped, true);
      assert.ok(textOf(reset).includes("dropped"), textOf(reset));
    } finally {
      await session.dispose();
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
      // The STRUCTURED surface is bounded by the aggregate result cap
      // too (phase-E review round 8: structuredContent used to cross
      // the wire uncapped while only the text was capped) — every
      // elision is FLAGGED with its elided count, so the kept head
      // prefix plus the record always reconciles to the whole registry
      // (phase-E review round 3: the trap-free surface read used to
      // truncate at 256 entries and leak an undefined hole into the
      // structured array — a silent hole stays impossible).
      const scMeta = (meta as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok(
        Buffer.byteLength(JSON.stringify(scMeta), "utf8") <= OUTPUT_MAX_BYTES,
        `the structured surface respects the aggregate cap: ${Buffer.byteLength(JSON.stringify(scMeta), "utf8")} bytes`,
      );
      const truncated = (scMeta.truncated ?? {}) as Record<string, number>;
      const scPending = scMeta.pending as string[];
      assert.equal(scPending.length + (truncated.pending ?? 0), 300, "the structured pending reconciles to the whole registry");
      assert.ok(scPending.every((id, index) => id === `c${index + 1}`), "dense and in order — no holes");
      const scCheckpoints = scMeta.checkpoints as unknown[];
      assert.equal(
        scCheckpoints.length + (truncated.checkpoints ?? 0),
        300,
        "the structured checkpoints reconcile to the whole registry",
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

// ── Round 4: exact action shapes, manifest fields, bounded status ─────

test("review round 4: the input is action-discriminated — every action's EXACT field set is enforced at the boundary (eval without code, reset with code, status with ids, interrupt with timeoutMs, wait with code, eval with ids: all rejected with 'cannot include'/'requires'; irrelevant known fields are never silently accepted)", async () => {
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
      // Extraneous known fields per action (the carried defect: the
      // flat optional-field bag silently accepted them and deferred the
      // semantics to late handler checks).
      const resetWithCode = await repl(session, { action: "reset", projectDir: PROJECT, code: "1 + 1" });
      assert.ok(isErrorResult(resetWithCode), textOf(resetWithCode));
      assert.ok(textOf(resetWithCode).includes('cannot include code'), textOf(resetWithCode));
      const statusWithIds = await repl(session, { action: "status", projectDir: PROJECT, ids: ["c1"] });
      assert.ok(isErrorResult(statusWithIds), textOf(statusWithIds));
      assert.ok(textOf(statusWithIds).includes('cannot include ids'), textOf(statusWithIds));
      const interruptWithTimeout = await repl(session, { action: "interrupt", projectDir: PROJECT, timeoutMs: 100 });
      assert.ok(isErrorResult(interruptWithTimeout), textOf(interruptWithTimeout));
      assert.ok(textOf(interruptWithTimeout).includes('cannot include timeoutMs'), textOf(interruptWithTimeout));
      const waitWithCode = await repl(session, { action: "wait", projectDir: PROJECT, code: "1 + 1" });
      assert.ok(isErrorResult(waitWithCode), textOf(waitWithCode));
      assert.ok(textOf(waitWithCode).includes('cannot include code'), textOf(waitWithCode));
      const evalWithIds = await repl(session, { action: "eval", projectDir: PROJECT, code: "1 + 1", ids: ["c1"] });
      assert.ok(isErrorResult(evalWithIds), textOf(evalWithIds));
      assert.ok(textOf(evalWithIds).includes('cannot include ids'), textOf(evalWithIds));
      const resetWithId = await repl(session, { action: "reset", projectDir: PROJECT, id: "c1" });
      assert.ok(isErrorResult(resetWithId), textOf(resetWithId));
      assert.ok(textOf(resetWithId).includes('cannot include id'), textOf(resetWithId));
      // The workspace was never created by the rejected calls (nothing
      // ran): a status still reports the project as not opened... (the
      // named status IS a first touch — assert the workspace is still
      // usable and fresh).
      const ok = await repl(session, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
      assert.ok(!isErrorResult(ok), textOf(ok));
      assert.ok(textOf(ok).includes("result: 42"), textOf(ok));
      // A well-formed reset (no extraneous fields) works.
      const reset = await repl(session, { action: "reset", projectDir: PROJECT });
      assert.ok(!isErrorResult(reset), textOf(reset));
      assert.ok(textOf(reset).includes("dropped"), textOf(reset));
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 4: the structured manifest carries the machine-readable type and live-handle status fields — `agent handle` type, the call id, and pending→settled status transitions as their own fields (phase-E review round 4: the manifest exposed only the human token with the status and call id embedded in the string)", async () => {
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
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const sc = (status as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const w = (sc.workspaces as Array<Record<string, unknown>>)[0];
      const bindings = w.bindings as Array<Record<string, unknown>>;
      const handle = bindings.find((b) => b.name === "research");
      assert.ok(handle, "the agent handle binding");
      assert.equal(handle.type, "agent handle", "the machine-readable type");
      assert.equal(handle.handleCallId, "c1", "the call id is its own field, not just token text");
      assert.equal(handle.handleStatus, "pending", "the live-handle status is its own field");
      assert.ok((handle.token as string).includes("agent handle · pending · call c1"), `the token still carries the human form: ${handle.token}`);
      const plain = bindings.find((b) => b.name === "answer");
      assert.ok(plain, "the plain binding");
      assert.equal(plain.type, "number", "the plain binding's machine-readable type");
      assert.equal(plain.handleCallId, null);
      assert.equal(plain.handleStatus, null);
      // The handle settles: the structured status transitions to
      // `settled` (the call store is the authority).
      runner.last().completeTurn("done");
      await tick();
      const after = await repl(session, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
      assert.ok(!isErrorResult(after), textOf(after));
      const statusAfter = await repl(session, { action: "status", projectDir: PROJECT });
      const scAfter = (statusAfter as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const wAfter = (scAfter.workspaces as Array<Record<string, unknown>>)[0];
      const handleAfter = (wAfter.bindings as Array<Record<string, unknown>>).find((b) => b.name === "research");
      assert.equal(handleAfter?.handleStatus, "settled", "the handle status transitioned");
      assert.equal(handleAfter?.handleCallId, "c1");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 4: the structured status respects the output limits for guest-derived fields — a huge agent task is head+tail elided at the ENGINE seam, so the wire's structuredContent carries at most the documented 200-char bound (the carried defect: structured status copied the raw task, so a guest could push an unbounded string through structuredContent while only the text was capped)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-bounded-status");
      const hugeTask = "T".repeat(10_000);
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const big = agent("pi/x", ${JSON.stringify(hugeTask)}); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const sc = (status as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const w = (sc.workspaces as Array<Record<string, unknown>>)[0];
      const agent = (w.liveAgents as Array<Record<string, unknown>>)[0];
      assert.equal(agent.callId, "c1");
      assert.ok(typeof agent.task === "string", "the task is a string");
      assert.ok(agent.task.length <= 200, `the wire task respects the 200-char cap: ${agent.task.length}`);
      assert.ok(agent.task.startsWith("T".repeat(99)) && agent.task.endsWith("T".repeat(100)), "head+tail elision keeps both ends");
      assert.ok(agent.task.includes("…"), "the elision marker is present");
      // The raw task never reaches the wire in ANY structured field.
      assert.ok(!JSON.stringify(sc).includes(hugeTask), "the unbounded task never crosses the wire");
      // The bounded text rendering carries the same elided form.
      assert.ok(!textOf(status).includes(hugeTask), "the text rendering is bounded too");
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 8: the structured status bounds the modelSpec at the ENGINE seam like the task — a 20,000-character model spec produces a head+tail-elided live-agent entry, never a >20KB structured field (the phase-E review rejection: modelSpec crossed status uncapped while only the text was capped), and the serialized structuredContent respects the aggregate 10 KB cap", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const PROJECT = makeProjectDir("repl-bounded-modelspec");
      const hugeSpec = "model-" + "X".repeat(20_000);
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const big = agent(${JSON.stringify(hugeSpec)}, "task"); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      await tick();
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const sc = (status as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const w = (sc.workspaces as Array<Record<string, unknown>>)[0];
      const agent = (w.liveAgents as Array<Record<string, unknown>>)[0];
      assert.equal(agent.callId, "c1");
      assert.ok(typeof agent.modelSpec === "string", "the modelSpec is a string");
      assert.ok(agent.modelSpec.length <= 200, `the wire modelSpec respects the engine-seam cap: ${agent.modelSpec.length}`);
      assert.ok(agent.modelSpec.startsWith("model-XXXX"), "head+tail elision keeps the head");
      assert.ok(agent.modelSpec.includes("…"), "the elision marker is present");
      // The raw spec never reaches the wire in ANY structured field or
      // the text, and the WHOLE serialized structured result respects
      // the aggregate cap.
      assert.ok(!JSON.stringify(sc).includes(hugeSpec), "the unbounded modelSpec never crosses the wire");
      assert.ok(!textOf(status).includes(hugeSpec), "the text rendering is bounded too");
      assert.ok(
        Buffer.byteLength(JSON.stringify(sc), "utf8") <= OUTPUT_MAX_BYTES,
        `the serialized structured result respects the aggregate cap: ${Buffer.byteLength(JSON.stringify(sc), "utf8")} bytes`,
      );
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
});

test("review round 8: interrupt { id } cancels a call whose openSession is still pending — the call settles durably as the recoverable AGENT_CANCELLED (the guest promise rejects now, a later wait reports it completed, and a daemon RESTART settles it from the store), and the LATE child is closed without ever prompting (the phase-E review rejection: cancelCall ignored openingCalls and returned 'none', and the eventual open resolved into a prompted, supposedly-interrupted call)", async () => {
  const runner = new DelayedOpenRunner();
  runner.parkOpens();
  const PROJECT = makeProjectDir("repl-interrupt-opening");
  const daemon = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon.url);
    try {
      const evaled = await repl(session, { action: "eval", projectDir: PROJECT, code: `const p = agent("pi/x", "task"); "started"` });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      const sc0 = (evaled as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok((sc0.pending as string[]).includes("c1"), `the opening call is pending: ${JSON.stringify(sc0.pending)}`);
      await tick();
      // The interrupt lands while openSession is STILL parked: the
      // old decision returned 'none' (no live session, no lazy
      // re-attach record) and the eventual open went on to prompt a
      // supposedly-interrupted call.
      const interrupted = await repl(session, { action: "interrupt", projectDir: PROJECT, id: "c1" });
      assert.ok(!isErrorResult(interrupted), textOf(interrupted));
      const si = (interrupted as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal((si.interrupt as { outcome: string }).outcome, "cancelled", `honest outcome: ${JSON.stringify(si.interrupt)}`);
      // The guest promise settled NOW with the recoverable error — not
      // when the open eventually lands.
      const read = await repl(session, { action: "eval", projectDir: PROJECT, code: `await p.catch((e) => "ERR:" + e.message)` });
      assert.ok(!isErrorResult(read), textOf(read));
      const sc1 = (read as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok(
        String(sc1.result).includes("was cancelled by interrupt while its session was still opening"),
        `guest-visible settlement: ${sc1.result}`,
      );
      // A later wait sees the cancelled call as no longer pending (the
      // settled call is gone from the pending registry — the wait
      // drains at its first pump; it observed nothing settle, so
      // `completed` stays empty and `pending` no longer lists c1).
      const waited = await repl(session, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
      assert.ok(!isErrorResult(waited), textOf(waited));
      const sw = (waited as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.equal(sw.drained, true, `the cancelled call drains the wait: ${JSON.stringify(sw)}`);
      assert.ok(!(sw.pending as string[]).includes("c1"), `no longer pending: ${JSON.stringify(sw.pending)}`);
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
      const sc = (read as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok(
        String(sc.result).includes("was cancelled by interrupt"),
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

test("review round 9: interrupt { id } on a still-OPENING call is IMMEDIATELY durable — the daemon can be killed right after the interrupt (NO eval or wait in between) and the restart restores the SETTLED workspace: the manifest provenance attributes the settlement's continuation to the cancelled worker, the registry is settled (nothing left for the store arm), and the guest promise rejects with the cancellation (the phase-E review rejection: the opening-cancel skipped the settlement boundary, so the daemon's snapshot writer never marked the workspace dirty and the kill restored the PRE-settlement snapshot with the call still pending — the round-8 regression masked it by performing another eval and wait before the restart)", async () => {
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
      const si = (interrupted as { structuredContent?: Record<string, unknown> }).structuredContent!;
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
  // The restart over the same home: the FIRST read is a status, and it
  // must already see the settlement — the restored registry is settled
  // (c1 not pending) and the continuation binding carries the
  // settlement's provenance FROM THE SNAPSHOT (without the fix, the
  // restored pre-settlement VM's continuation runs only at reconcile,
  // with no provenance pass before the read — the manifest would show
  // null provenance).
  const daemon2 = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon2.url);
    try {
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const sc = (status as { structuredContent?: Record<string, unknown> }).structuredContent!;
      const w0 = (sc.workspaces as Array<Record<string, unknown>>)[0];
      assert.ok(w0 !== undefined, `a workspace is reported: ${JSON.stringify(sc)}`);
      assert.ok(!(w0.pending as string[]).includes("c1"), `the restored registry is settled: ${JSON.stringify(w0.pending)}`);
      // The discriminator: the interrupt's OWN snapshot carried the
      // settlement, so the restart's reconcile has NOTHING for the
      // store arm (without the fix, the restore reconciles the
      // pre-settlement snapshot and settles c1 from the store here).
      const reconcile = w0.reconcile as { settledFromStore: string[] } | undefined;
      assert.ok(reconcile !== undefined, "the restored workspace carries its reconcile summary");
      assert.deepEqual(reconcile.settledFromStore, [], "the store arm had nothing to settle — the snapshot already carried the settlement");
      const bindings = w0.bindings as Array<Record<string, unknown>>;
      const wasCancelled = bindings.find((b) => b.name === "wasCancelled");
      assert.ok(wasCancelled !== undefined, `the continuation binding survived the restart: ${JSON.stringify(bindings)}`);
      assert.equal(wasCancelled.provenance, "worker c1", "the settlement provenance traveled inside the interrupt's snapshot");
      // The guest promise rejects with the durable cancellation.
      const read = await repl(session, { action: "eval", projectDir: PROJECT, code: `await p.catch((e) => "ERR:" + e.message)` });
      assert.ok(!isErrorResult(read), textOf(read));
      const sc1 = (read as { structuredContent?: Record<string, unknown> }).structuredContent!;
      assert.ok(
        String(sc1.result).includes("was cancelled by interrupt"),
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

test("review round 8: the aggregate structured-result cap bounds the eval/wait/status wire — 16 500 parked checkpoints cross the wire as an EXPLICITLY-FLAGGED head prefix (kept ids well-formed, never a silent undefined hole), the elided counts reconcile to the true totals, and the serialized structuredContent respects the doc's 10 KB cap; a daemon RESTART restores and reconciles the FULL registry in the VM while the wire stays bounded (the phase-E review rejection: 16 500 pending ids crossed the wire as an ~80 KB array — structuredContent was uncapped while only the text was)", async () => {
  const runner = new FakeRunner();
  const daemon = await startReplDaemon(runner);
  const PROJECT = makeProjectDir("repl-whole-registry");
  const CHECKPOINTS = 16_500;
  const boundedSc = (res: unknown): Record<string, unknown> => {
    const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent!;
    assert.ok(
      Buffer.byteLength(JSON.stringify(sc), "utf8") <= OUTPUT_MAX_BYTES,
      `the serialized structuredContent respects the aggregate cap: ${Buffer.byteLength(JSON.stringify(sc), "utf8")} bytes`,
    );
    return sc;
  };
  try {
    const session = await connectHttp(daemon.url);
    try {
      const evaled = await repl(session, {
        action: "eval",
        projectDir: PROJECT,
        code: `for (let i = 0; i < ${CHECKPOINTS}; i++) checkpoint("q" + i); "raised"`,
      });
      assert.ok(!isErrorResult(evaled), textOf(evaled));
      const sc = boundedSc(evaled);
      const pending = sc.pending as string[];
      const truncated = (sc.truncated ?? {}) as Record<string, number>;
      assert.ok(pending.length > 0, "the head prefix is non-empty");
      assert.ok(pending.length < CHECKPOINTS, "the wire is bounded, not the whole registry");
      assert.equal(pending[0], "c1", "the kept prefix starts at the head");
      assert.equal(truncated.pending, CHECKPOINTS - pending.length, "the elided pending count reconciles");
      for (const id of pending) {
        assert.ok(typeof id === "string" && /^c\d+$/.test(id), `no truncation/undefined hole: ${JSON.stringify(id)}`);
      }
      const checkpoints = sc.checkpoints as Array<{ id: string }>;
      assert.equal(checkpoints.length + (truncated.checkpoints ?? 0), CHECKPOINTS, "the elided checkpoint count reconciles");
      for (const checkpoint of checkpoints) {
        assert.ok(/^c\d+$/.test(checkpoint.id), `no checkpoint hole: ${JSON.stringify(checkpoint.id)}`);
      }
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon.close();
  }
  // A daemon RESTART over the same store: the first touch restores the
  // snapshot and reconciles the in-VM pending-call registry — the FULL
  // registry survives in the VM (the same complete read serves the
  // restore path) while the wire stays bounded and flagged.
  const daemon2 = await startReplDaemon(runner);
  try {
    const session = await connectHttp(daemon2.url);
    try {
      const status = await repl(session, { action: "status", projectDir: PROJECT });
      assert.ok(!isErrorResult(status), textOf(status));
      const sc = boundedSc(status);
      const w = (sc.workspaces as Array<Record<string, unknown>>)[0];
      assert.equal(w.state, "restored", "the workspace restored from the snapshot");
      const truncated = (sc.truncated ?? {}) as Record<string, number>;
      assert.ok(Object.keys(truncated).length > 0, "the wire elision is flagged");
      const pending = w.pending as string[];
      assert.ok(pending.length < CHECKPOINTS, "the status pending surface is bounded");
      assert.equal(
        pending.length + (truncated["workspaces[0].pending"] ?? 0),
        CHECKPOINTS,
        "the status pending counts reconcile",
      );
      for (const id of pending) {
        assert.ok(typeof id === "string" && /^c\d+$/.test(id), `no hole after restore: ${JSON.stringify(id)}`);
      }
      const checkpoints = w.checkpoints as Array<{ id: string }>;
      assert.equal(
        checkpoints.length + (truncated["workspaces[0].checkpoints"] ?? 0),
        CHECKPOINTS,
        "every checkpoint re-surfaced in the VM, wire-bounded",
      );
      // The restore's reconcile report rides the same cap (the
      // re-surfaced checkpoint ids are an id list like any other).
      const requeued = truncated["workspaces[0].reconcile.requeuedCheckpoints"];
      if (requeued !== undefined) {
        const kept = ((w.reconcile as Record<string, unknown>).requeuedCheckpoints as string[]).length;
        assert.equal(kept + requeued, CHECKPOINTS, "the reconcile id list reconciles too");
      }
    } finally {
      await session.dispose();
    }
  } finally {
    await daemon2.close();
  }
});
