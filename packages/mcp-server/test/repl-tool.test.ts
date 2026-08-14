/**
 * The `repl` tool's surface suite (eval-plane redesign, the roadmap
 * bible docs/roadmap/repl-eval-redesign.md §3): the per-project context
 * opens the daemon's repl store, attaches the broker's snapshot sink,
 * and on FIRST TOUCH restores the stored workspace + reconciles — or
 * AUTO-RESETS a refused snapshot (§6.1). Pins:
 *
 * - a fresh workspace persists across "daemon restarts" (a second server
 *   over the same HOME restores the VM from the enveloped snapshot),
 * - the two-action surface: eval (soft-bound fused pump) and interrupt,
 * - the soft-bound eval's finished shape { output, result? } — one call
 *   when the awaited call settles within the bound — and the honest
 *   still-running shape { output, running } when the bound elapses,
 * - the empty-string eval (the documented idempotent poll) drains what
 *   settled,
 * - a refused stored snapshot AUTO-RESETS: the file is renamed aside
 *   (`.refused-<ts>`, never deleted) and the next eval's output leads
 *   with the one-line notice naming the file and the reason,
 * - the three-way reconcile runs through the tool on restore,
 * - interrupt: cancel by id; eval-break without id (refused-idle when
 *   nothing is running),
 * - the §4.5 guest introspection functions: workspace(), agents(),
 *   reset() — ordinary values, sliceable in the same eval.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  deserializeSnapshot,
  loadShippedWasm,
  serializeSnapshot,
  wasmSha256Of,
  type BrokerLoadSessionOptions,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
} from "@automatalabs/repl-engine";
import { workflowProjectPaths } from "@automatalabs/workflows";

import { createWorkflowServer } from "../src/index.js";
import { okRunner, textOf, type Connected } from "./_harness.js";

/** The fake held-open ACP session (the broker's structural seam). */
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

/** The fake runner with the loadSession seam. */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  /** The scripted loaded-turn outcome (null parks the seam). */
  loadedTurnText: string | null = null;

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

/** A real project directory (resolveProjectDir realpaths it). */
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "repl-tool-project-"));
}

/** The repl store's snapshot path for the test project under the harness HOME. */
function replStorePaths(projectDir: string): { snapshotPath: string; replDir: string } {
  const paths = workflowProjectPaths(projectDir);
  return { snapshotPath: join(paths.rootDir, "repl", "snapshot.bin"), replDir: join(paths.rootDir, "repl") };
}

/** Connect a workflow server with an injected repl runner (single-project mode). */
async function connectWithRepl(replRunner: BrokerRunner): Promise<Connected & { runner: FakeRunner }> {
  const server = createWorkflowServer(okRunner(), { replRunner });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-repl-test", version: "0.0.0" }, { capabilities: {} });
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

/** Call the repl tool (typed over the raw input). */
async function repl(
  connected: Connected,
  input: { action: string; projectDir?: string; code?: string; timeoutMs?: number; id?: string },
) {
  return connected.client.callTool({ name: "repl", arguments: input as Record<string, unknown> });
}

function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function isErrorResult(res: Awaited<ReturnType<Client["callTool"]>>): boolean {
  return (res as { isError?: boolean }).isError === true;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Evaluate an expression that returns JSON — the sliceable-introspection
 *  idiom (§4.5: workspace()/agents() return ordinary values, sliceable in
 *  the same eval). */
async function evalJson(connected: Connected, projectDir: string, expression: string): Promise<unknown> {
  const r = await repl(connected, { action: "eval", projectDir, code: `JSON.stringify(${expression})` });
  assert.ok(!isErrorResult(r), textOf(r));
  const sc = structuredOf(r);
  assert.ok(typeof sc.result === "string", `the eval resolved with a value: ${JSON.stringify(sc)}`);
  return JSON.parse(sc.result as string);
}

// ── The surface shapes ────────────────────────────────────────────────

test("eval returns the finished shape { output, result? } mirrored in structuredContent — one newline-joined output string, no v1 metadata fields", async () => {
  const PROJECT = freshProject();
  const connected = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'console.log("line one"); console.error("boom"); 40 + 2',
    });
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    // The wire shape is EXACTLY { output, result? } — nothing else.
    assert.deepEqual(Object.keys(sc).sort(), ["output", "result"]);
    assert.equal(sc.output, 'line one\nerror: boom');
    assert.equal(sc.result, "42");
    assert.ok(textOf(r).includes("result: 42"), textOf(r));
    // The v1 metadata fields are deleted from the wire.
    for (const field of ["pending", "completed", "checkpoints", "outputTruncated", "truncated", "referenced", "action", "projectDir", "drained", "timedOut", "workspaces", "dropped"]) {
      assert.ok(!(field in sc), `no ${field} on the wire`);
    }
  } finally {
    await connected.dispose();
  }
});

test("an empty eval resolves with result \"undefined\" — the documented poll idiom runs as a normal eval", async () => {
  const PROJECT = freshProject();
  const connected = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(connected, { action: "eval", projectDir: PROJECT, code: "" });
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    assert.deepEqual(Object.keys(sc).sort(), ["output", "result"]);
    assert.equal(sc.output, "");
    assert.equal(sc.result, "undefined");
  } finally {
    await connected.dispose();
  }
});

test("the soft-bound eval: everything the code waits on settles within the bound → the FINISHED shape in ONE call (the v1 eval→wait→eval loop fused)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    // The eval awaits the subagent; the tool holds the call open pumping
    // settlements. The turn completes mid-hold → the SAME call returns
    // the finished shape with the completion value's repr.
    const held = repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "research task"); const answer = await p; console.log("got it"); answer',
      timeoutMs: 5000,
    });
    for (let attempt = 0; attempt < 100 && runner.sessions.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runner.sessions.length, 1, "the founding session opened");
    runner.last().completeTurn("the answer");
    const r = await held;
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    assert.deepEqual(Object.keys(sc).sort(), ["output", "result"], "the finished shape has no running");
    assert.equal(sc.output, "got it");
    assert.equal(sc.result, "the answer", "the completion value's repr");
    assert.ok(textOf(r).includes("result: the answer"), textOf(r));
    // The value is live in the VM — `_` holds it (the §4.4 result-history
    // global).
    const underscore = await repl(connected, { action: "eval", projectDir: PROJECT, code: "_" });
    assert.equal(structuredOf(underscore).result, "the answer");
  } finally {
    await connected.dispose();
  }
});

test("the soft-bound eval: the bound elapses first → the STILL-RUNNING shape { output, running } and a later eval drains what settled", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    const held = repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "slow task"); const v = await p; "result:" + v',
      timeoutMs: 300,
    });
    await tick();
    const r = await held;
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    assert.deepEqual(Object.keys(sc).sort(), ["output", "running"], "the still-running shape has no result");
    assert.equal(sc.output, "");
    assert.deepEqual(sc.running, ["c1"], "the in-flight call ids");
    assert.ok(textOf(r).includes("running: c1"), textOf(r));
    // The eval CONTINUES server-side: the turn settles after the bound
    // and the next eval picks the value up.
    runner.last().completeTurn("slow answer");
    const picked = await repl(connected, { action: "eval", projectDir: PROJECT, code: "await p" });
    assert.ok(!isErrorResult(picked), textOf(picked));
    assert.equal(structuredOf(picked).result, "slow answer");
    // `_` holds the late completion too.
    assert.equal(structuredOf(await repl(connected, { action: "eval", projectDir: PROJECT, code: "_" })).result, "slow answer");
  } finally {
    await connected.dispose();
  }
});

test("the empty-eval poll (the documented idempotent idiom) drains what settled without re-executing work", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    // Start-and-don't-await: the eval completes immediately (finished
    // shape); the call keeps running server-side.
    const started = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p = agent("pi/x", "task").then((v) => console.log("settled:", v)); "started"',
    });
    assert.ok(!isErrorResult(started), textOf(started));
    assert.equal(structuredOf(started).result, "started");
    await tick();
    assert.equal(runner.sessions.length, 1, "the founding session opened");
    // The turn settles AFTER the eval returned. The empty eval drains
    // and reports the settled continuation's console output.
    runner.last().completeTurn("waited result");
    await tick();
    const poll = await repl(connected, { action: "eval", projectDir: PROJECT, code: "" });
    assert.ok(!isErrorResult(poll), textOf(poll));
    const sc = structuredOf(poll);
    assert.equal(sc.output, "settled: waited result", "the poll drained the settled output");
    assert.equal(sc.result, "undefined", "the poll itself completes with undefined");
    // Idempotent: re-sending the empty eval re-executes nothing.
    const again = await repl(connected, { action: "eval", projectDir: PROJECT, code: "" });
    assert.equal(structuredOf(again).output, "", "the second poll drains nothing new");
  } finally {
    await connected.dispose();
  }
});

test("a raised checkpoint renders as an output line; checkpoint.answer in a later eval resolves it", async () => {
  const PROJECT = freshProject();
  const connected = await connectWithRepl(new FakeRunner());
  try {
    const raised = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const q = checkpoint("what color?"); "asked"',
    });
    assert.ok(!isErrorResult(raised), textOf(raised));
    const sc = structuredOf(raised);
    assert.ok(sc.output.includes("checkpoint c1: what color?"), `the checkpoint line: ${sc.output}`);
    assert.equal(sc.result, "asked");
    const answered = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'checkpoint.answer("c1", "blue"); await q',
    });
    assert.equal(structuredOf(answered).result, "blue", "the answer resolves the parked promise");
  } finally {
    await connected.dispose();
  }
});

test("an uncaught eval error renders in output with the §4.6 attribution and the call succeeds", async () => {
  const PROJECT = freshProject();
  const connected = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(connected, { action: "eval", projectDir: PROJECT, code: "throw new Error('nope')" });
    assert.ok(!isErrorResult(r), "a throwing eval is honest output, not a tool error");
    const sc = structuredOf(r);
    assert.ok(String(sc.output).includes("Error: nope"), `the error rendering: ${sc.output}`);
    assert.ok(!("result" in sc), "no completion value for an error");
  } finally {
    await connected.dispose();
  }
});

// ── Durability: persistence, restore, auto-reset ──────────────────────

test("repl eval persists to the daemon's per-project store; a later server restores the workspace from the snapshot", async () => {
  const PROJECT = freshProject();
  const first = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(first, { action: "eval", projectDir: PROJECT, code: "globalThis.answer = 42; answer + 1" });
    assert.ok(!isErrorResult(r), textOf(r));
    assert.ok(textOf(r).includes("result: 43"), textOf(r));
    // The eval boundary wrote the enveloped snapshot into the repl store
    // (next to the workflow state, under workflowHomeDir()/projects/<key>/).
    const { snapshotPath, replDir } = replStorePaths(PROJECT);
    assert.ok(existsSync(replDir), `repl/ dir exists: ${replDir}`);
    assert.ok(existsSync(snapshotPath), `snapshot written: ${snapshotPath}`);
    const header = readFileSync(snapshotPath).subarray(0, 200).toString("utf8");
    assert.ok(header.includes('"format":"repl-snapshot"'), `enveloped: ${header}`);
    assert.ok(header.includes('"wasmSha256":"'), `identity carried: ${header}`);
  } finally {
    await first.dispose();
  }

  // "Daemon restart": a fresh server over the same HOME (and a fresh
  // runner) — the first touch restores the VM from the stored snapshot.
  const second = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(second, { action: "eval", projectDir: PROJECT, code: "answer" });
    assert.ok(!isErrorResult(r), textOf(r));
    assert.ok(textOf(r).includes("result: 42"), `state survived the restart: ${textOf(r)}`);
    // The restore is visible through the guest introspection surface.
    const diag = (await evalJson(second, PROJECT, "workspace().diagnostics")) as { reconcile: unknown };
    assert.ok(diag.reconcile !== null, "the restore's reconcile report lives in diagnostics");
  } finally {
    await second.dispose();
  }
});

test("a pending call with a recorded backend session re-attaches on restore through the tool (reconcile runs at first touch)", async () => {
  const PROJECT = freshProject();
  const runner = new FakeRunner();
  const first = await connectWithRepl(runner);
  try {
    const r = await repl(first, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
    assert.ok(!isErrorResult(r), textOf(r));
    await tick();
    assert.equal(runner.sessions.length, 1, "the founding session opened");
    // The eval boundary snapshot now exists with the call pending in the
    // guest registry; the re-attach key was recorded in the store BEFORE
    // the prompt (the phase-D contract).
    const { snapshotPath } = replStorePaths(PROJECT);
    assert.ok(existsSync(snapshotPath));
  } finally {
    await first.dispose();
  }

  // Restart: the stored snapshot carries the pending call; the fresh
  // runner's loadSession re-attaches it (scripted loaded turn) and the
  // SAME guest promise settles exactly once.
  const runner2 = new FakeRunner();
  runner2.loadedTurnText = "loaded result";
  const second = await connectWithRepl(runner2);
  try {
    // The first touch restores + reconciles; the re-attached call settles
    // the SAME guest promise exactly once.
    const r = await repl(second, { action: "eval", projectDir: PROJECT, code: 'await p.catch((e) => "ERR:" + e.message)' });
    assert.ok(!isErrorResult(r), textOf(r));
    assert.ok(structuredOf(r).result!.includes("loaded result"), textOf(r));
    const diag = (await evalJson(second, PROJECT, "workspace().diagnostics")) as {
      reconcile: { reattached: string[] } | null;
    };
    assert.ok(diag.reconcile !== null && diag.reconcile.reattached.includes("c1"), "the restore re-attached c1");
    assert.equal(runner2.loadedWith.length, 1, "the recorded session was loaded");
    assert.equal(runner2.openedWith.length, 0, "never a fresh session — no re-issue");
  } finally {
    await second.dispose();
  }
});

test("a corrupted stored snapshot AUTO-RESETS (§6.1): the file is renamed aside (never deleted), the next eval's output leads with the loud notice naming file and reason, and a fresh workspace starts", async () => {
  const PROJECT = freshProject();
  const first = await connectWithRepl(new FakeRunner());
  try {
    await repl(first, { action: "eval", projectDir: PROJECT, code: "globalThis.doomed = 1" });
  } finally {
    await first.dispose();
  }
  const { snapshotPath, replDir } = replStorePaths(PROJECT);
  assert.ok(existsSync(snapshotPath));
  // Corrupt the stored snapshot (truncate mid-payload).
  const bytes = readFileSync(snapshotPath);
  writeFileSync(snapshotPath, bytes.subarray(0, Math.floor(bytes.length / 2)));

  // The next daemon's first touch must NOT crash-loop and must NOT
  // demand a manual reset: the refused snapshot is renamed aside and a
  // fresh workspace starts, with the notice leading the eval's output.
  const second = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(second, { action: "eval", projectDir: PROJECT, code: "1 + 1" });
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    const output = sc.output as string;
    assert.ok(
      output.startsWith("REPL workspace auto-reset:"),
      `the notice leads the output: ${output.slice(0, 120)}`,
    );
    assert.ok(output.includes("snapshot refused"), output);
    // The refused file was RENAMED ASIDE — never deleted.
    const entries = readdirSync(replDir);
    const refused = entries.filter((name) => name.startsWith("snapshot.bin.refused-"));
    assert.equal(refused.length, 1, `exactly one refused snapshot renamed aside: ${entries.join(", ")}`);
    assert.ok(output.includes(refused[0]), `the notice names the renamed file: ${output}`);
    // The fresh workspace works.
    assert.equal(sc.result, "2");
    const fresh = await repl(second, { action: "eval", projectDir: PROJECT, code: "3 + 4" });
    assert.equal(structuredOf(fresh).result, "7");
    // The notice was consumed exactly once — later evals are clean.
    assert.equal(structuredOf(fresh).output, "");
    // The fresh workspace persists again (a NEW snapshot was written).
    assert.ok(existsSync(snapshotPath), "the fresh workspace re-persisted");
  } finally {
    await second.dispose();
  }
});

test("a STRUCTURALLY VALID corrupted snapshot (a corrupted in-range VM header that passes every at-rest check) takes the SAME auto-reset path at restore time", async () => {
  const PROJECT = freshProject();
  const first = await connectWithRepl(new FakeRunner());
  try {
    await repl(first, { action: "eval", projectDir: PROJECT, code: "globalThis.doomed = 1" });
  } finally {
    await first.dispose();
  }
  const { snapshotPath, replDir } = replStorePaths(PROJECT);
  assert.ok(existsSync(snapshotPath));
  // Re-encode the stored snapshot with the VM header's STACK POINTER
  // patched to an in-range-but-wrong value (1): the envelope stays fully
  // valid, but materializing the VM fails (`RuntimeError: memory access
  // out of bounds`) — the corruption class NO at-rest check can see.
  const module = await loadShippedWasm();
  const originalBytes = readFileSync(snapshotPath);
  const { snapshot } = deserializeSnapshot(originalBytes);
  const corrupted = { ...snapshot, stackPointer: 1 };
  writeFileSync(snapshotPath, serializeSnapshot(corrupted, wasmSha256Of(module)));

  const second = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(second, { action: "eval", projectDir: PROJECT, code: "1 + 1" });
    assert.ok(!isErrorResult(r), textOf(r));
    const sc = structuredOf(r);
    const output = sc.output as string;
    assert.ok(output.startsWith("REPL workspace auto-reset:"), output.slice(0, 120));
    assert.ok(
      output.includes("restoring the workspace VM from the snapshot failed") ||
        output.includes("initializing the restored workspace failed") ||
        output.includes("memory access out of bounds"),
      `names the refusal stage: ${output.slice(0, 300)}`,
    );
    const entries = readdirSync(replDir);
    assert.equal(entries.filter((name) => name.startsWith("snapshot.bin.refused-")).length, 1, `renamed aside: ${entries.join(", ")}`);
    assert.equal(sc.result, "2", "the fresh workspace evaluated");
  } finally {
    await second.dispose();
  }
});

// ── Interrupt ─────────────────────────────────────────────────────────

test("interrupt cancels a call by id; interrupt without an id on an IDLE workspace is the honest refusal; the eval-break signal interrupts a RUNNING eval mid-hold", async () => {
  const runner = new FakeRunner();
  const PROJECT = freshProject();
  const connected = await connectWithRepl(runner);
  try {
    // Cancel by id: the session receives the cancel; the guest promise
    // rejects recoverably.
    await repl(connected, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started"' });
    await tick();
    const interrupted = await repl(connected, { action: "interrupt", projectDir: PROJECT, id: "c1" });
    assert.ok(!isErrorResult(interrupted), textOf(interrupted));
    assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
    assert.deepEqual(structuredOf(interrupted), { interrupt: { outcome: "cancelled", callId: "c1" } });
    const read = await repl(connected, { action: "eval", projectDir: PROJECT, code: 'await q.catch((e) => "ERR:" + e.message)' });
    assert.ok(String(structuredOf(read).result).includes("cancelled"), textOf(read));

    // Idle from the start of a FRESH project: no running eval → honest
    // refusal, nothing armed; the next eval runs normally.
    const otherProject = freshProject();
    const idle = await repl(connected, { action: "interrupt", projectDir: otherProject });
    assert.ok(!isErrorResult(idle), textOf(idle));
    assert.deepEqual(structuredOf(idle), { interrupt: { outcome: "refused-idle" } });
    assert.ok(textOf(idle).includes("no running eval to interrupt"), textOf(idle));
    const r = await repl(connected, { action: "eval", projectDir: otherProject, code: "6 * 7" });
    assert.ok(textOf(r).includes("result: 42"), textOf(r));

    // The eval-break signal interrupts the RUNNING eval: the fused eval
    // holds the call open pumping a suspended eval; the interrupt lands
    // mid-hold; when the awaited call settles, the resumed continuation
    // (a runaway loop) is broken mid-run by the armed signal.
    const eval3 = repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'const p3 = agent("pi/x", "task3"); await p3; while (true) {}',
      timeoutMs: 10_000,
    });
    await tick();
    await tick();
    const armed = await repl(connected, { action: "interrupt", projectDir: PROJECT });
    assert.ok(!isErrorResult(armed), textOf(armed));
    assert.ok(textOf(armed).includes("interrupting the running eval"), textOf(armed));
    assert.deepEqual(structuredOf(armed), { interrupt: { outcome: "targeted" } });
    // The awaited call settles: the eval's continuation resumes in the
    // tool's pump and the armed signal breaks the runaway mid-run. The
    // broken eval can never settle — the held eval returns promptly with
    // the finished-with-error shape (no result, no running), and the
    // interrupted drain is retained in workspace().diagnostics (§6.2).
    runner.last().completeTurn("resumed");
    const broken = await eval3;
    assert.ok(!isErrorResult(broken), textOf(broken));
    const brokenSc = structuredOf(broken);
    assert.ok(!("running" in brokenSc), `not still-running after the break: ${JSON.stringify(brokenSc)}`);
    assert.ok(!("result" in brokenSc), `no completion value after the break: ${JSON.stringify(brokenSc)}`);
    const diag = (await evalJson(connected, PROJECT, "workspace().diagnostics")) as { drainError: { message: string } | null };
    assert.ok(
      diag.drainError !== null && (diag.drainError.message.includes("interrupted") || diag.drainError.message.includes("Job execution error")),
      `the interrupted drain is retained in diagnostics: ${JSON.stringify(diag.drainError)}`,
    );
    // The signal was consumed by the running eval: the NEXT eval runs
    // normally, and the VM stays usable.
    const after = await repl(connected, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
    assert.ok(textOf(after).includes("result: 42"), textOf(after));
    const idleAfter = await repl(connected, { action: "interrupt", projectDir: PROJECT });
    assert.deepEqual(structuredOf(idleAfter), { interrupt: { outcome: "refused-idle" } }, "nothing is tracked after the break");
  } finally {
    await connected.dispose();
  }
});

// ── The §4.5 guest introspection functions ────────────────────────────

test("workspace() returns the plain-data shape (bindings, inFlight, checkpoints, diagnostics) and agents() the live agents — sliceable in the same eval; reset() tears the workspace down", async () => {
  const runner = new FakeRunner();
  const PROJECT = freshProject();
  const connected = await connectWithRepl(runner);
  try {
    const started = await repl(connected, {
      action: "eval",
      projectDir: PROJECT,
      code: 'globalThis.findings = { n: 1 }; globalThis.n = 3; globalThis.research = agent("pi/x", "investigate"); "done"',
    });
    assert.ok(!isErrorResult(started), textOf(started));
    await tick();
    // workspace(): plain data — the bindings carry name/type/size/
    // provenance/task and the live-handle status.
    const ws = (await evalJson(connected, PROJECT, "workspace()")) as {
      bindings: Array<{ name: string; type: string; sizeBytes: number; provenance: string | null; task: string | null; callId?: string; status?: string }>;
      inFlight: string[];
      diagnostics: { childrenClosed: boolean };
    };
    const research = ws.bindings.find((b) => b.name === "research");
    assert.ok(research, JSON.stringify(ws.bindings));
    assert.equal(research.type, "agent handle", "the machine-readable type");
    assert.equal(research.callId, "c1", "the stable call id");
    assert.equal(research.status, "pending", "the live-handle status");
    assert.equal(research.task, "investigate", "the task provenance");
    const n = ws.bindings.find((b) => b.name === "n");
    assert.equal(n?.type, "number", "the plain binding type");
    assert.ok((n?.sizeBytes ?? 0) > 0, "every binding carries its size");
    assert.deepEqual(ws.inFlight, ["c1"], "the in-flight ids");
    assert.equal(ws.diagnostics.childrenClosed, false, "children are warm");
    // The intent-plane hygiene rule: metadata only — no value content.
    // agents(): the live-agent entries.
    const agents = (await evalJson(connected, PROJECT, "agents()")) as Array<{ callId: string; modelSpec: string; state: string }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].callId, "c1");
    assert.equal(agents[0].modelSpec, "pi/x", "the full model spec, verbatim");
    assert.equal(agents[0].state, "running");
    // The handle settles: the status transitions to settled.
    runner.last().completeTurn("DUG-UP");
    await tick();
    const picked = await repl(connected, { action: "eval", projectDir: PROJECT, code: "await research" });
    assert.equal(structuredOf(picked).result, "DUG-UP");
    const wsAfter = (await evalJson(connected, PROJECT, "workspace()")) as {
      bindings: Array<{ name: string; status?: string }>;
      inFlight: string[];
    };
    assert.equal(wsAfter.bindings.find((b) => b.name === "research")?.status, "settled", "the handle status transitioned");
    assert.deepEqual(wsAfter.inFlight, [], "nothing left in flight");
    // reset(): the teardown runs after the eval completes; the next eval
    // starts a fresh workspace.
    const reset = await repl(connected, { action: "eval", projectDir: PROJECT, code: "reset()" });
    assert.ok(!isErrorResult(reset), textOf(reset));
    const gone = await repl(connected, { action: "eval", projectDir: PROJECT, code: "typeof findings" });
    assert.ok(!isErrorResult(gone), textOf(gone));
    assert.equal(structuredOf(gone).result, "undefined", "the fresh workspace has no bindings");
  } finally {
    await connected.dispose();
  }
});

// ── The action discriminator ──────────────────────────────────────────

test("the input is action-discriminated: eval requires code; interrupt rejects code/timeoutMs; the two-action enum rejects everything else", async () => {
  const PROJECT = freshProject();
  const connected = await connectWithRepl(new FakeRunner());
  try {
    const noCode = await repl(connected, { action: "eval", projectDir: PROJECT });
    assert.ok(isErrorResult(noCode), textOf(noCode));
    assert.ok(textOf(noCode).includes("eval requires a code string"), textOf(noCode));
    const interruptWithCode = await repl(connected, { action: "interrupt", projectDir: PROJECT, code: "1 + 1" });
    assert.ok(isErrorResult(interruptWithCode), textOf(interruptWithCode));
    assert.ok(textOf(interruptWithCode).includes('cannot include code'), textOf(interruptWithCode));
    const interruptWithTimeout = await repl(connected, { action: "interrupt", projectDir: PROJECT, timeoutMs: 100 });
    assert.ok(isErrorResult(interruptWithTimeout), textOf(interruptWithTimeout));
    assert.ok(textOf(interruptWithTimeout).includes('cannot include timeoutMs'), textOf(interruptWithTimeout));
    const evalWithId = await repl(connected, { action: "eval", projectDir: PROJECT, code: "1 + 1", id: "c1" });
    assert.ok(isErrorResult(evalWithId), textOf(evalWithId));
    assert.ok(textOf(evalWithId).includes('cannot include id'), textOf(evalWithId));
    // The deleted v1 actions refuse at the schema (the wire enum).
    for (const dead of ["wait", "status", "reset"]) {
      const r = await repl(connected, { action: dead, projectDir: PROJECT });
      assert.ok(isErrorResult(r), textOf(r));
      assert.ok(textOf(r).includes("Input validation error"), `action "${dead}" is deleted: ${textOf(r)}`);
    }
    // timeoutMs is bounded at [0, 120 000].
    const tooLong = await repl(connected, { action: "eval", projectDir: PROJECT, code: "1", timeoutMs: 120_001 });
    assert.ok(isErrorResult(tooLong), textOf(tooLong));
    assert.ok(textOf(tooLong).includes("Input validation error"), textOf(tooLong));
  } finally {
    await connected.dispose();
  }
});
