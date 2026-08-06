/**
 * Phase-D review round 2 at the MCP-tool boundary: the wait action's
 * same-shape output (console output drained by the wait's pumps is
 * rendered immediately, never deferred to the next eval), the status
 * action's workspace manifest (bindings with structure-only tokens,
 * provenance, and live-handle status), the single-flight first touch
 * (concurrent first-touch calls create exactly one VM and broker), the
 * client-presence drain (last-client disconnect drains in-flight turns
 * and closes idle children; the next connect's followUp re-attaches
 * lazily), and the per-eval deadline (a currently-running runaway eval
 * is always breakable).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  BrokerLoadSessionOptions,
  BrokerOpenSessionOptions,
  BrokerPromptOptions,
  BrokerRunner,
  BrokerSession,
  BrokerTurn,
} from "@automatalabs/repl-engine";

import { createWorkflowServer } from "../src/index.js";
import { WorkflowProjectRegistry } from "../src/project-registry.js";
import { ReplPresenceLedger } from "../src/repl-presence.js";
import { okRunner, textOf, type Connected } from "./_harness.js";
import { workflowProjectPaths } from "@automatalabs/workflows";

/** The fake held-open ACP session (see repl-tool.test.ts). */
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
  /** A hung cancel (the bounded-teardown regression: the shutdown
   *  disposal must not await a hung cancel past its bound). */
  hangCancel = false;
  /** A hung release (same regression for the release phase). */
  hangRelease = false;

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
    if (this.hangCancel) return new Promise(() => {});
    for (const pending of this.prompts.splice(0)) {
      pending.resolve({ stopReason: "cancelled", text: "" });
    }
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.releases++;
    if (this.hangRelease) return new Promise(() => {});
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

/** The fake runner with the phase-D loadSession seam (see repl-tool.test.ts). */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  loadedTurnText: string | null = null;

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    session.loadedTurnTextValue = this.loadedTurnText;
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

/** A fresh project directory per test (the repl store persists across
 *  tests — each test gets its own project so the store starts clean). */
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "repl-review2-tool-"));
}

/** Connect a workflow server with an injected repl runner + presence. */
async function connectWithRepl(
  replRunner: BrokerRunner,
  options: {
    presence?: ReplPresenceLedger;
    clientId?: () => string | undefined;
    projects?: WorkflowProjectRegistry;
  } = {},
): Promise<Connected & { runner: FakeRunner }> {
  const server = createWorkflowServer(okRunner(), {
    replRunner,
    replPresence: options.presence,
    replClientId: options.clientId ?? (() => "test-client"),
    projects: options.projects,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-repl-review2", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    runner: replRunner as FakeRunner,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

async function repl(
  connected: Connected,
  input: { action: string; projectDir?: string; code?: string; ids?: string[]; timeoutMs?: number; id?: string },
) {
  return connected.client.callTool({ name: "repl", arguments: input as Record<string, unknown> });
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return (res as { isError?: boolean }).isError === true;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("review2: wait returns the SAME shape as eval — console output drained by its pumps renders immediately (never deferred to the next eval)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    // The continuation of the settled call logs guest-visible output; the
    // wait's pump drains it and must render it in the wait result.
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task").then((v) => { console.log("continuation ran:", v); }); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    runner.last().completeTurn("waited result");
    await tick();
    const waited = await repl(connected, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
    assert.ok(!isErrorResult(waited), textOf(waited));
    // The wait's pump drained the continuation's console.log and rendered
    // it in the wait result (the preview line carries the frozen refs).
    assert.ok(
      textOf(waited).includes('"continuation ran:"') && textOf(waited).includes('"waited result"'),
      `output rendered: ${textOf(waited)}`,
    );
    assert.ok(textOf(waited).includes("completed: c1"), textOf(waited));
  } finally {
    await connected.dispose();
  }
});

test("review2: status renders the workspace manifest — bindings with structure-only tokens, provenance, and live-handle status", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'globalThis.findings = { zekret: "MARKER".repeat(10), n: 1 }; globalThis.research = agent("pi/x", "investigate"); "done"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    const status = await repl(connected, { action: "status", projectDir: PROJECT });
    const text = textOf(status);
    assert.ok(text.includes("bindings:"), text);
    assert.ok(text.includes("findings = {2 keys}"), text);
    assert.ok(text.includes("research = agent handle · pending · call c1"), text);
    assert.ok(text.includes("via eval 1"), text);
    // The doc's full provenance surface (phase-D review round 3): the
    // binding renders "from what task, when" — the founding task text and
    // the attribution wall clock.
    assert.ok(text.includes('· task "investigate"'), text);
    assert.ok(text.includes("· at "), text);
    // The live agent line carries its task too (the renderer used to omit
    // the task already available on LiveAgentInfo).
    assert.ok(text.includes('agent c1: running — task: "investigate"'), text);
    // The intent-plane hygiene rule: NO value content in the manifest.
    assert.ok(!text.includes("MARKER"), `value content leaked: ${text}`);
    assert.ok(!text.includes("zekret"), `nested names leaked: ${text}`);
    // The handle settles: the manifest's live-handle status follows.
    runner.last().completeTurn("DUG-UP");
    await tick();
    await repl(connected, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
    const after = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(
      textOf(after).includes("research = agent handle · settled · call c1"),
      `settled status: ${textOf(after)}`,
    );
    assert.ok(!textOf(after).includes("DUG-UP"), `worker content leaked: ${textOf(after)}`);
  } finally {
    await connected.dispose();
  }
});

test("review2: concurrent first touches create exactly ONE VM and broker for a project (the single-flight lock)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const connected = await connectWithRepl(runner, { presence });
  try {
    // Park the backend open so the first touch is slow: every concurrent
    // first-touch eval must share the single in-flight firstTouch promise
    // (phase-D review round 2: the async null-check race used to create
    // two VMs and brokers for one project).
    let releaseOpen!: () => void;
    const parkedOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const originalOpen = runner.openSession.bind(runner);
    runner.openSession = async (opts) => {
      await parkedOpen;
      return originalOpen(opts);
    };
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        repl(connected, {
          action: "eval",
          projectDir: PROJECT,
          code: `const p${i} = agent("pi/x", "t${i}"); globalThis.n = ${i}`,
        }),
      ),
    );
    for (const result of results) assert.ok(!isErrorResult(result), textOf(result));
    releaseOpen();
    await tick();
    // All three dispatches ran through the ONE broker (three sessions),
    // and the ONE provenance registry saw exactly three eval passes — if
    // a second VM had been created and abandoned, its passes would have
    // landed on a different registry and the eval sequence would be short.
    assert.equal(runner.openedWith.length, 3, "all dispatches were served");
    const status = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(status).includes("bindings:"), textOf(status));
    assert.ok(textOf(status).includes("via eval 3"), `the three passes landed on one registry: ${textOf(status)}`);
  } finally {
    await connected.dispose();
  }
});

test("review2: last-client disconnect drains in-flight turns to completion and closes idle children; the next connect's followUp lazily re-attaches", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const connected = await connectWithRepl(runner, { presence, clientId: () => "client-A" });
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    // The client's last connection closes: the project's workspace drains
    // (the in-flight turn completes and settles; then the child closes).
    presence.disconnect("client-A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const session = runner.last();
    session.completeTurn("drained result");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The drain settles the result into the VM (the continuation sees it)
    // and closes the child.
    for (let attempt = 0; attempt < 100 && session.releases === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(session.releases, 1, "the idle child closed after the drain");
    const status = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(status).includes("children: closed"), textOf(status));
    // The next connect (a new client) evaluates: the continuation already
    // fired; a followUp lazily re-attaches the recorded session.
    const probe = await repl(connected, { action: "eval", projectDir: PROJECT, code: 'p.followUp("again"); "fired"' });
    assert.ok(!isErrorResult(probe), textOf(probe));
    await tick();
    assert.equal(runner.loadedWith.length, 1, "the recorded session was loaded lazily on the next connect");
    assert.equal(runner.loadedWith[0].sessionId, session.sessionId, "the SAME backend session");
    // SECOND DISCONNECT (phase-D review regression): the re-attached child
    // is warm again. The project-level drain latch reset when the client
    // reconnected (touch), so this disconnect must drain the re-attached
    // child too — the latch used to skip every later drain permanently,
    // leaving the reattached child running.
    const reattached = runner.last();
    presence.disconnect("client-A");
    // The followUp started a NEW turn on the reattached session: the
    // drain waits for it to complete (drain-to-completion is the policy),
    // then closes the reattached child.
    await new Promise((resolve) => setTimeout(resolve, 20));
    reattached.completeTurn("second-drain result");
    for (let attempt = 0; attempt < 100 && reattached.releases === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(reattached.releases, 1, "the re-attached child closed after the SECOND disconnect");
    const status2 = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(status2).includes("children: closed"), textOf(status2));
  } finally {
    await connected.dispose();
  }
});

test("review2: the per-eval deadline bounds a CURRENTLY running runaway eval through the daemon wiring (the eval-timeout env knob)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const prev = process.env.AGENTPRISM_REPL_EVAL_TIMEOUT_MS;
  process.env.AGENTPRISM_REPL_EVAL_TIMEOUT_MS = "200";
  try {
    const server = createWorkflowServer(okRunner(), { replRunner: runner });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-repl-review2", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const runaway = await repl(
        { client, server, async dispose() {} },
        { action: "eval", projectDir: PROJECT, code: "while (true) {}" },
      );
      assert.ok(!isErrorResult(runaway), textOf(runaway));
      assert.ok(textOf(runaway).includes("interrupted"), `the deadline broke the runaway eval: ${textOf(runaway)}`);
      const after = await repl(
        { client, server, async dispose() {} },
        { action: "eval", projectDir: PROJECT, code: "6 * 7" },
      );
      assert.ok(textOf(after).includes("result: 42"), `the VM stayed usable: ${textOf(after)}`);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    if (prev === undefined) delete process.env.AGENTPRISM_REPL_EVAL_TIMEOUT_MS;
    else process.env.AGENTPRISM_REPL_EVAL_TIMEOUT_MS = prev;
  }
});

test("review6: a client reconnecting mid-drain ABORTS the drain through the daemon wiring — the child stays warm while any client is connected, nothing is cancelled or released", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const connected = await connectWithRepl(runner, { presence, clientId: () => "client-A" });
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    // The last client disconnects: the drain starts (the in-flight turn
    // is still running).
    presence.disconnect("client-A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const session = runner.last();
    assert.equal(session.releases, 0, "the drain is waiting for the in-flight turn — the child is still warm");
    // A client RECONNECTS mid-drain (the next tool call touches
    // presence): the drain must ABORT — the release phase must never
    // close children while any client is connected (phase-D review
    // round 6: the drain used to run to completion regardless of
    // presence, and repl-presence.ts documented the contradictory
    // behavior).
    const probe = await repl(connected, { action: "eval", projectDir: PROJECT, code: '"back"' });
    assert.ok(!isErrorResult(probe), textOf(probe));
    assert.equal(session.releases, 0, "the drain aborted — the child was NOT released");
    assert.equal(session.cancelCalls, 0, "nothing was cancelled");
    // The still-running turn completes normally after the abort and
    // settles into the live workspace.
    session.completeTurn("warm result");
    for (let attempt = 0; attempt < 100; attempt++) {
      const got = await repl(connected, { action: "eval", projectDir: PROJECT, code: "await p" });
      if (textOf(got).includes("warm result")) break;
      if (attempt === 99) assert.fail(`the turn never settled: ${textOf(got)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(!textOf(status).includes("children: closed"), "the workspace is warm (the drain aborted)");
  } finally {
    await connected.dispose();
  }
});

test("review6: a failed client-presence drain is surfaced loudly and retained — the snapshot-flush failure is recorded on the state, the next tool result reports it, and the next disconnect retries the drain", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const connected = await connectWithRepl(runner, { presence, clientId: () => "client-A" });
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    // Sabotage the snapshot write: a DIRECTORY at the tmp path makes the
    // drain's atomic write fail (EISDIR).
    const paths = workflowProjectPaths(PROJECT);
    const tmpPath = join(paths.rootDir, "repl", "snapshot.bin.tmp");
    mkdirSync(tmpPath);
    // The last client disconnects: the drain runs, the in-flight turn
    // completes, and the drain's settlement flush FAILS. The failure
    // must not vanish (phase-D review round 6: the ledger used to
    // swallow it) — it is recorded on the state and surfaced loudly.
    presence.disconnect("client-A");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const session = runner.last();
    session.completeTurn("drained but not persisted");
    // Wait for the drain op to finish (single-flight ends in the
    // finally), then remove the obstruction: the drain failed, the
    // boundary stayed dirty, and the NEXT flush retries the SAME state.
    for (let attempt = 0; attempt < 100 && presence.drainingCount() > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(presence.drainingCount(), 0, "the drain op finished (and failed)");
    assert.equal(session.releases, 1, "the release phase ran before the flush failure");
    rmSync(tmpPath, { recursive: true, force: true });
    // The next eval succeeds (its end-of-op flush retries the retained
    // boundary — the retry, loud on failure, silent on success) and
    // surfaces the recorded drain failure in its result; the call's
    // settlement survived the failed flush in the live VM.
    const probe = await repl(connected, { action: "eval", projectDir: PROJECT, code: "await p" });
    assert.ok(!isErrorResult(probe), textOf(probe));
    assert.ok(
      textOf(probe).includes("drained but not persisted"),
      `the drained settlement survived the failed flush in the live VM: ${textOf(probe)}`,
    );
    assert.ok(
      textOf(probe).includes("client-presence drain failed"),
      `the drain failure is surfaced guest-visibly: ${textOf(probe)}`,
    );
    const status = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(
      textOf(status).includes("LAST DRAIN FAILED"),
      `status reports the failure: ${textOf(status)}`,
    );
    // The next disconnect retries the drain: the broker's latch says the
    // release already completed, so the retry finishes the bookkeeping
    // and clears the recorded failure.
    presence.disconnect("client-A");
    for (let attempt = 0; attempt < 100 && presence.drainingCount() > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status2 = await repl(connected, { action: "status", projectDir: PROJECT });
    assert.ok(!textOf(status2).includes("LAST DRAIN FAILED"), `the retry cleared the failure: ${textOf(status2)}`);
    assert.ok(textOf(status2).includes("children: closed"), textOf(status2));
  } finally {
    await connected.dispose();
  }
});

test("review8: daemon shutdown cleanup runs in FINALLY paths — when broker.dispose REJECTS (its op-end flush retries the retained dirty boundary from the failed drain and fails again), the workspace VM is still disposed and the store still closed (phase-D review round 8)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const projects = new WorkflowProjectRegistry(okRunner());
  const connected = await connectWithRepl(runner, { presence, projects });
  const tmpPath = join(workflowProjectPaths(PROJECT).rootDir, "repl", "snapshot.bin.tmp");
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    const session = runner.last();
    session.hangCancel = true;
    session.hangRelease = true;
    const projectContext = projects.stores().find((c) => c.projectDir === PROJECT)!;
    const state = projectContext.repl!;
    const workspace = state.workspace!;
    const callStore = state.store.callStore();
    // Obstruct the snapshot write: a DIRECTORY at the tmp path makes the
    // atomic write fail (EISDIR). The shutdown drain's op-end flush
    // fails → the drain rejects AND the dirty boundary is RETAINED; the
    // disposal's own op-end flush RETRIES the same boundary and fails
    // again → broker.dispose REJECTS (phase-D review round 8: a
    // disposal rejection used to skip workspace.dispose() and
    // state.store.close() — the actual VM and call store stayed open
    // even though state.workspace was already nulled, and the registry
    // swallows the rejection at shutdown, so the cleanup must not
    // depend on the disposal resolving).
    mkdirSync(tmpPath);
    const started = Date.now();
    const teardown = projects.disposeReplStates(300);
    const result = await Promise.race([
      teardown.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 3000)),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(result, "done", "daemon shutdown returned within the bound (never hung)");
    assert.ok(elapsed < 2000, `shutdown was bounded: ${elapsed} ms`);
    // The cleanup ran in the FINALLY path despite the disposal
    // rejection: the VM was ACTUALLY disposed and the store closed.
    assert.equal(workspace.isDisposed, true, "the workspace VM was disposed even though broker.dispose rejected");
    assert.equal(callStore.isClosed(), true, "the call store was closed even though broker.dispose rejected");
    assert.equal(state.broker, null, "the broker was disposed");
    assert.equal(state.workspace, null, "the workspace was nulled");
  } finally {
    try {
      rmSync(tmpPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    await connected.dispose();
  }
});

test("review8: the shutdown drain FAILS BEFORE releasing sessions — the bounded disposal still sees the hung cancel/release and returns within the remaining bound (phase-D review round 8: the old regression's EISDIR failed only at the op-end flush, AFTER the release phase had already cleared this.sessions, so broker.dispose saw no hung backend and the old unbounded disposal passed)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const projects = new WorkflowProjectRegistry(okRunner());
  const connected = await connectWithRepl(runner, { presence, projects });
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    const session = runner.last();
    session.hangCancel = true;
    session.hangRelease = true;
    const projectContext = projects.stores().find((c) => c.projectDir === PROJECT)!;
    const state = projectContext.repl!;
    const workspace = state.workspace!;
    // Sabotage the CALL STORE: the bound-expired drain's forced stop
    // records the AGENT_CANCELLED completion FIRST (the exactly-once
    // discipline) — with the log closed, that record throws (EBADF), so
    // the drain FAILS at the forced stop, BEFORE the release phase has
    // cleared this.sessions. The disposal therefore still holds the
    // hung session and must cancel/release it BOUNDED — an unbounded
    // disposal would hang on the exact hung backend the drain had
    // already caught.
    state.store.close();
    const started = Date.now();
    const teardown = projects.disposeReplStates(300);
    const result = await Promise.race([
      teardown.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 3000)),
    ]);
    const elapsed = Date.now() - started;
    assert.equal(result, "done", "daemon shutdown returned within the bound (never hung on the hung cancel/release)");
    assert.ok(elapsed < 2000, `shutdown was bounded: ${elapsed} ms`);
    // The disposal still held the busy session (the drain failed BEFORE
    // its release phase) and issued its wire calls even though it could
    // not await them (the deadline won the race): one cancel from the
    // drain's forced stop, one from the disposal — and the release only
    // from the disposal (the drain's release phase never ran).
    assert.equal(session.cancelCalls, 2, "the forced stop and the bounded disposal each issued the cancel for the still-registered session");
    assert.equal(session.releases, 1, "the bounded disposal issued the release for the still-registered session");
    // The state was fully torn down — and the VM actually disposed
    // (the finally-path cleanup).
    assert.equal(workspace.isDisposed, true, "the workspace VM was disposed");
    assert.equal(state.broker, null, "the broker was disposed");
    assert.equal(state.workspace, null, "the workspace was nulled");
  } finally {
    await connected.dispose();
  }
});

/** A small bounded poll (this file's tests park promises by hand). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("review8b: a concurrent first touch during a parked restore-time loadSession AWAITS the in-flight reconcile (never bypasses to partially restored state), and daemon teardown during the parked load releases the late session with no stale restore report (phase-D review rejection: ensureReplWorkspace checked state.workspace before state.firstTouch, and doFirstTouch published source/reconcileReport without generation-checking reconcile completion)", async () => {
  const PROJECT = freshProject();
  // Phase 1 — seed a stored snapshot with a pending call whose backend
  // session is recorded (the restore's re-attach key).
  const runner1 = new FakeRunner();
  const first = await connectWithRepl(runner1);
  try {
    const r = await repl(first, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task"); "started"',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    assert.equal(runner1.sessions.length, 1, "the founding session opened");
    assert.ok(existsSync(join(workflowProjectPaths(PROJECT).rootDir, "repl", "snapshot.bin")), "the eval boundary snapshot exists");
  } finally {
    await first.dispose();
  }

  // Phase 2 — a fresh daemon: the first touch restores the workspace and
  // the restore-time loadSession PARKS (never resolves on its own).
  const runner2 = new FakeRunner();
  const presence = new ReplPresenceLedger(60_000);
  const projects = new WorkflowProjectRegistry(okRunner());
  const second = await connectWithRepl(runner2, { presence, projects });
  let loadCalls = 0;
  let resolveLoad!: () => void;
  const parkedLoad = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const loadedSessions: FakeSession[] = [];
  const originalLoad = runner2.loadSession.bind(runner2);
  runner2.loadSession = async (opts) => {
    loadCalls++;
    await parkedLoad;
    const session = await originalLoad(opts);
    loadedSessions.push(session);
    return session;
  };
  try {
    // The first touch: restore + reconcile, parked in the re-attach load.
    const touch1 = repl(second, { action: "eval", projectDir: PROJECT, code: '"probe 1"' });
    await waitFor(() => loadCalls === 1);
    const projectContext = projects.stores().find((c) => c.projectDir === PROJECT)!;
    const state = projectContext.repl!;

    // A CONCURRENT first touch must AWAIT the in-flight first-touch
    // promise — it must NOT return early through the workspace fast path
    // (the old ordering checked state.workspace before state.firstTouch,
    // so the concurrent call observed the partially restored workspace
    // and evaluated against it).
    let touch2Settled = false;
    void repl(second, { action: "eval", projectDir: PROJECT, code: '"probe 2"' }).then(
      () => {
        touch2Settled = true;
      },
      () => {
        touch2Settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(touch2Settled, false, "the concurrent first touch awaited the in-flight restore reconcile (never bypassed to the partially restored workspace)");

    // Daemon teardown WHILE the restore-time load is parked: the
    // shutdown drain force-stops the opening re-attach (the call settles
    // durably as AGENT_CANCELLED — it is in the opening-call registry
    // now, so the bound's forced stop covers it exactly like an
    // openSession), and the bounded disposal runs unlocked at its
    // deadline — shutdown returns within the bound.
    const started = Date.now();
    await projects.disposeReplStates(300);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `daemon shutdown was bounded while the restore load was parked: ${elapsed} ms`);
    assert.equal(state.workspace, null, "the workspace was torn down");
    assert.equal(state.broker, null, "the broker was torn down");
    assert.equal(state.source, null, "no source was published before the reconciliation completed");

    // The parked load lands AFTER the teardown: the child is released
    // exactly once — never registered, never re-issued — and the
    // first-touch continuation must NOT write a stale source/report onto
    // the torn-down state (the generation check aborts the touch; the
    // broker's own disposal fence released the session).
    resolveLoad();
    await waitFor(() => loadedSessions.length === 1);
    assert.equal(loadedSessions[0].releases, 1, "the late-loaded session was released exactly once");
    assert.equal(loadedSessions[0].prompts.length, 0, "the late-loaded session never prompted");
    assert.equal(runner2.openedWith.length, 0, "no re-issue — no fresh session was opened");
    assert.equal(state.workspace, null, "the workspace stayed torn down");
    assert.equal(state.broker, null, "the broker stayed torn down");
    assert.equal(state.source, null, "no stale restore source on the torn-down state");
    assert.equal(state.reconcileReport, null, "no stale reconcile report on the torn-down state");

    // The first touch settles LOUDLY (aborted by the teardown) — never a
    // successful eval against torn-down state.
    const [touch1Result] = await Promise.allSettled([touch1]);
    assert.equal(touch1Result.status, "fulfilled", "the abort is surfaced as an error result");
    assert.ok(
      isErrorResult((touch1Result as PromiseFulfilledResult<unknown>).value),
      "the aborted first touch is an error result",
    );
    assert.ok(
      textOf((touch1Result as PromiseFulfilledResult<{ content: unknown[] }>).value).includes("aborted by reset/dispose"),
      "the abort names the teardown loudly",
    );
  } finally {
    await second.dispose();
  }
});
