/**
 * The `repl` tool's daemon wiring (phase D): the per-project context opens
 * the daemon's repl store, attaches the broker's snapshot sink, and on
 * FIRST TOUCH restores the stored workspace + reconciles — or contains a
 * refused snapshot loudly without crash-looping. Pins:
 *
 * - a fresh workspace persists across "daemon restarts" (a second server
 *   over the same HOME restores the VM from the enveloped snapshot —
 *   bindings survive, status reports `restored`),
 * - the three-way reconcile runs through the tool on restore (a pending
 *   call with a recorded backend session re-attaches via loadSession and
 *   settles the guest promise exactly once),
 * - a corrupted/truncated stored snapshot is CONTAINED: the first touch
 *   refuses loudly in the tool result (naming the file), the daemon keeps
 *   serving, status reports the refusal, and `reset` clears it so a fresh
 *   workspace starts,
 * - the eval / wait / interrupt / reset actions over the in-memory MCP
 *   client, including the eval-break interrupt signal.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The fake runner with the phase-D loadSession seam. */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  /** The scripted loaded-turn outcome (null parks the seam). */
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

/** A real project directory (resolveProjectDir realpaths it). */
const PROJECT = mkdtempSync(join(tmpdir(), "repl-tool-project-"));

/** The repl store's snapshot path for the test project under the harness HOME. */
function replStorePaths(): { snapshotPath: string; replDir: string } {
  const paths = workflowProjectPaths(PROJECT);
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

test("repl eval persists to the daemon's per-project store; a later server restores the workspace from the snapshot", async () => {
  const first = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(first, { action: "eval", projectDir: PROJECT, code: "globalThis.answer = 42; answer + 1" });
    assert.ok(!isErrorResult(r), textOf(r));
    assert.ok(textOf(r).includes("result: 43"), textOf(r));
    // The eval boundary wrote the enveloped snapshot into the repl store
    // (next to the workflow state, under workflowHomeDir()/projects/<key>/).
    const { snapshotPath, replDir } = replStorePaths();
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
    const status = await repl(second, { action: "status", projectDir: PROJECT });
    assert.ok(!isErrorResult(status), textOf(status));
    assert.ok(textOf(status).includes("restored"), textOf(status));
  } finally {
    await second.dispose();
  }
});

test("a pending call with a recorded backend session re-attaches on restore through the tool (reconcile runs at first touch)", async () => {
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
    const { snapshotPath } = replStorePaths();
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
    let result = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await repl(second, { action: "eval", projectDir: PROJECT, code: 'await p.catch((e) => "ERR:" + e.message)' });
      result = textOf(r);
      if (result.includes("result:")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(result.includes("loaded result"), result);
    const status = await repl(second, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(status).includes("restored"), textOf(status));
    assert.ok(textOf(status).includes("re-attached: 1"), textOf(status));
    assert.equal(runner2.loadedWith.length, 1, "the recorded session was loaded");
    assert.equal(runner2.openedWith.length, 0, "never a fresh session — no re-issue");
  } finally {
    await second.dispose();
  }
});

test("a corrupted stored snapshot is CONTAINED: loud refusal in the tool result, no crash-loop, reset clears it", async () => {
  const first = await connectWithRepl(new FakeRunner());
  try {
    await repl(first, { action: "eval", projectDir: PROJECT, code: "globalThis.doomed = 1" });
  } finally {
    await first.dispose();
  }
  const { snapshotPath } = replStorePaths();
  assert.ok(existsSync(snapshotPath));
  // Corrupt the stored snapshot (truncate mid-payload).
  const bytes = readFileSync(snapshotPath);
  writeFileSync(snapshotPath, bytes.subarray(0, Math.floor(bytes.length / 2)));

  // The next daemon's first touch must NOT crash-loop: the refusal is
  // contained and surfaced loudly in every result, naming the file.
  const second = await connectWithRepl(new FakeRunner());
  try {
    const r = await repl(second, { action: "eval", projectDir: PROJECT, code: "1 + 1" });
    assert.ok(isErrorResult(r), textOf(r));
    assert.ok(textOf(r).includes("REPL workspace refused"), textOf(r));
    assert.ok(textOf(r).includes(snapshotPath), `names the file: ${textOf(r)}`);
    const status = await repl(second, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(status).includes("REFUSED"), textOf(status));
    // The daemon is still fully alive and the refusal is idempotent.
    const again = await repl(second, { action: "eval", projectDir: PROJECT, code: "2 + 2" });
    assert.ok(isErrorResult(again), "the refusal is stable, not a crash");
    // reset clears the store and a fresh workspace starts.
    const reset = await repl(second, { action: "reset", projectDir: PROJECT });
    assert.ok(!isErrorResult(reset), textOf(reset));
    assert.ok(!existsSync(snapshotPath), "the refused snapshot was dropped");
    const fresh = await repl(second, { action: "eval", projectDir: PROJECT, code: "3 + 4" });
    assert.ok(!isErrorResult(fresh), textOf(fresh));
    assert.ok(textOf(fresh).includes("result: 7"), textOf(fresh));
    const statusAfter = await repl(second, { action: "status", projectDir: PROJECT });
    assert.ok(textOf(statusAfter).includes("fresh"), `the fresh workspace persists again: ${textOf(statusAfter)}`);
  } finally {
    await second.dispose();
  }
});

test("wait absorbs a still-running call until the backend settles it; interrupt cancels a call; the eval-break signal interrupts the next eval", async () => {
  const runner = new FakeRunner();
  const connected = await connectWithRepl(runner);
  try {
    const r = await repl(connected, { action: "eval", projectDir: PROJECT, code: 'const p = agent("pi/x", "task"); "started"' });
    assert.ok(!isErrorResult(r), textOf(r));
    assert.ok(textOf(r).includes("pending: c1"), textOf(r));
    await tick();
    // A wait that times out reports "still running".
    const timedOut = await repl(connected, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 100 });
    assert.ok(textOf(timedOut).includes("still running"), textOf(timedOut));
    // The worker completes; wait absorbs the gap and reports the settle.
    runner.last().completeTurn("waited result");
    await tick();
    const waited = await repl(connected, { action: "wait", projectDir: PROJECT, ids: ["c1"], timeoutMs: 5000 });
    assert.ok(!isErrorResult(waited), textOf(waited));
    assert.ok(textOf(waited).includes("completed: c1"), textOf(waited));
    assert.ok(!textOf(waited).includes("still running"), textOf(waited));
    // The value is delivered through the next eval.
    const value = await repl(connected, { action: "eval", projectDir: PROJECT, code: "await p" });
    assert.ok(textOf(value).includes("waited result"), textOf(value));

    // interrupt with a call id cancels the in-flight call (the call then
    // rejects recoverably with the cancelled error).
    await repl(connected, { action: "eval", projectDir: PROJECT, code: 'const q = agent("pi/x", "task2"); "started"' });
    await tick();
    const interrupted = await repl(connected, { action: "interrupt", projectDir: PROJECT, id: "c2" });
    assert.ok(!isErrorResult(interrupted), textOf(interrupted));
    assert.ok(textOf(interrupted).includes("session/cancel sent"), textOf(interrupted));
    for (let attempt = 0; attempt < 100; attempt++) {
      const got = await repl(connected, { action: "eval", projectDir: PROJECT, code: 'await q.catch((e) => "ERR:" + e.message)' });
      if (textOf(got).includes("result:")) {
        assert.ok(textOf(got).includes("cancelled"), textOf(got));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // The eval-break signal (interrupt without an id) breaks the NEXT VM
    // execution — the single-threaded daemon cannot observe a request
    // while an eval is executing, so the signal is consumed by the next
    // drain/eval that runs with it armed (documented semantics).
    await repl(connected, { action: "interrupt", projectDir: PROJECT });
    const runaway = await repl(connected, { action: "eval", projectDir: PROJECT, code: "while (true) {}" });
    assert.ok(textOf(runaway).includes("interrupted"), `the armed signal broke the eval: ${textOf(runaway)}`);
    // The VM stays usable.
    const after = await repl(connected, { action: "eval", projectDir: PROJECT, code: "6 * 7" });
    assert.ok(textOf(after).includes("result: 42"), textOf(after));
  } finally {
    await connected.dispose();
  }
});
