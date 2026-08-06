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
import { mkdtempSync, rmSync } from "node:fs";
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
import { ReplPresenceLedger } from "../src/repl-presence.js";
import { okRunner, textOf, type Connected } from "./_harness.js";

/** The fake held-open ACP session (see repl-tool.test.ts). */
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
  options: { presence?: ReplPresenceLedger; clientId?: () => string | undefined } = {},
): Promise<Connected & { runner: FakeRunner }> {
  const server = createWorkflowServer(okRunner(), {
    replRunner,
    replPresence: options.presence,
    replClientId: options.clientId ?? (() => "test-client"),
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
