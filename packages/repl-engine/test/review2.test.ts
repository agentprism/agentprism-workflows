/**
 * Phase-D review round 2 regression suite: the reviewer's rejected items,
 * pinned at the engine boundary.
 *
 * 1. Lazy re-attach of SETTLED handles (the doc: "followUp re-attaches
 *    the subagent session lazily via the capability matrix"): after the
 *    client-presence drain released every child — or after a restore
 *    that left settled calls unattached — followUp/steer/cancel on a
 *    settled handle must load the recorded backend session on demand
 *    (capability-gated through the runner's own loadSession; a custom
 *    backend without the capability degrades through the same gate,
 *    surfaced guest-visibly) instead of resolving the honest `failed`.
 * 2. Backend identity/pool routing is persisted (modelSpec + the
 *    RESOLVED backendId recorded at session open), so a restore or
 *    re-issue never re-resolves the model spec against the CURRENT
 *    default backend and misses the still-resumable original session.
 * 3. The client-presence drain: in-flight turns drain to completion
 *    (each settlement boundary snapshots), then idle children close;
 *    the spec-owed concrete bound applies (an over-bound turn is
 *    cancelled — the honest bounded teardown); queued steers survive
 *    durably.
 * 4. The workspace manifest: top-level bindings with structure-only
 *    tokens, provenance, and live-handle status — metadata, never
 *    content.
 * 5. The per-eval wall-clock deadline: a currently-running runaway eval
 *    is ALWAYS breakable through the quickjs interrupt handler (the
 *    armed-signal-only semantics could only break the next execution).
 * 6. The per-binding provenance passes (eval / settlement labels,
 *    sanitized rendering).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Broker,
  InMemoryCallStore,
  JsonlCallStore,
  Workspace,
  type BrokerLoadSessionOptions,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type CallStore,
  type SnapshotSink,
} from '../src/index.js';

const PROJECT = '/tmp/repl-review2-project';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The fake held-open ACP session (see broker.test.ts). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  stopReason = 'end_turn';
  readonly completedTexts: string[] = [];

  /** The steering capability advertised at open (the broker captures it
   *  per session at open time — the test flips this BEFORE dispatching). */
  static supportsSteering = true;

  constructor(readonly openedWith: BrokerOpenSessionOptions | BrokerLoadSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.capabilities = { supportsSteering: FakeSession.supportsSteering };
  }

  static nextId = 0;

  prompt(content: string, opts: BrokerPromptOptions = {}): Promise<BrokerTurn> {
    this.texts.push(content);
    return new Promise((resolve, reject) => {
      this.prompts.push({ content, resolve, reject });
      opts.onHandoff?.();
    });
  }
  readonly texts: string[] = [];

  steer(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.steers.push({ content, resolve, reject });
    });
  }

  awaitCurrentTurn(): Promise<BrokerTurn> {
    return new Promise(() => {});
  }

  cancel(): Promise<void> {
    for (const pending of this.prompts.splice(0)) {
      pending.resolve({ stopReason: 'cancelled', text: '' });
    }
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.releases++;
    return Promise.resolve();
  }

  currentTurnText(): string {
    return this.completedTexts[this.completedTexts.length - 1] ?? '';
  }

  finalMessageText(): string {
    return this.completedTexts[this.completedTexts.length - 1] ?? '';
  }

  rawStructuredOutput(): unknown {
    return undefined;
  }

  completeTurn(text: string): void {
    const pending = this.prompts.shift();
    assert.ok(pending, 'a prompt turn must be in flight');
    this.completedTexts.push(text);
    pending.resolve({ stopReason: this.stopReason, text });
  }

  failTurn(error: unknown): void {
    const pending = this.prompts.shift();
    assert.ok(pending, 'a prompt turn must be in flight');
    pending.reject(error);
  }
}

/** The fake runner (see broker.test.ts) — sessions carry a `backendId`
 *  (the routing pin the store records), and `loadSession` is the lazy
 *  re-attach seam. */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  /** When set, loadSession rejects (the capability gate / lost session). */
  loadError: Error | null = null;

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    session.backendId = 'pi';
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
    if (this.loadError !== null) throw this.loadError;
    const session = new FakeSession(opts);
    session.backendId = 'pi';
    this.sessions.push(session);
    this.loadedWith.push(opts);
    return session;
  }

  async dispose(): Promise<void> {}

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, 'a session must exist');
    return this.sessions[this.sessions.length - 1];
  }
}

async function setup(options: { runner?: BrokerRunner; store?: CallStore; sink?: SnapshotSink } = {}): Promise<{
  ws: Workspace;
  broker: Broker;
}> {
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, {
    runner: options.runner,
    store: options.store,
    snapshotSink: options.sink,
    evalTimeoutMs: 0, // tests drive interrupts explicitly
  });
  return { ws, broker };
}

function output(result: { output: string[] }): string[] {
  return result.output;
}

// ── 1. Lazy re-attach of settled handles ───────────────────────────────

test('review 2/1: after the client-presence drain, followUp/steer/cancel on a settled handle lazily re-attach the recorded backend session (the doc\'s lazy re-attach)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  runner.last().completeTurn('settled result');
  await tick();
  await broker.pump();
  // The drain releases every child and drops the live session entries.
  assert.equal(await broker.drainForDisconnect(5000), true, 'the settled call drains immediately');
  assert.equal(runner.sessions[0].releases, 1, 'the child closed');
  assert.ok(broker.isDrained, 'the broker reports drained');

  // followUp on the settled handle re-attaches the recorded session and
  // starts a new turn on it (startedNewTurn).
  await broker.eval('p.followUp("continue"); "fired"');
  await tick();
  assert.equal(runner.loadedWith.length, 1, 'the recorded session was loaded lazily');
  assert.equal(runner.loadedWith[0].sessionId, runner.sessions[0].sessionId, 'the SAME backend session');
  assert.equal(runner.loadedWith[0].model, 'pi', 'routing pins the recorded backend id');
  const loaded = runner.sessions[1];
  assert.equal(loaded.releases, 0, 'the re-attached child stays warm');
  loaded.completeTurn('follow-up answer');
  await tick();
  await broker.pump();
  assert.equal(broker.store().lookup('c2')!.completion!.value, 'startedNewTurn', 'the followUp settled with what happened');
  // The lazy re-attach info line surfaces guest-visibly in the next tool
  // result.
  let sawReattachLine = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const got = await broker.eval('1');
    if (output(got).some((l) => l.includes('lazily re-attached'))) {
      sawReattachLine = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(sawReattachLine, 'the lazy re-attach info line surfaced guest-visibly');
  // steer on the re-attached idle session starts a new turn
  // (startedNewTurn).
  await broker.eval('p.steer("urgent"); "fired"');
  await tick();
  runner.sessions[1].completeTurn('steered answer');
  await tick();
  await broker.pump();
  assert.equal(broker.store().lookup('c3')!.completion!.value, 'startedNewTurn');
  // cancelCall (the interrupt tool's engine path) reports the honest idle
  // no-op for the now-warm re-attached session (no second load — the
  // session entry is live again).
  assert.equal(await broker.cancelCall('c1'), 'idle');
  assert.equal(runner.loadedWith.length, 1, 'the warm session served the cancel');
  assert.ok(!broker.isDrained, 'the lazy re-attach warmed the children again');
  await broker.dispose();
  ws.dispose();
});

test('review 2/1b: a lazy re-attach that fails through the capability gate (or a lost session) degrades to the honest failed, surfaced guest-visibly', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  runner.last().completeTurn('settled');
  await tick();
  await broker.pump();
  await broker.drainForDisconnect(5000);

  runner.loadError = new Error('session/load not supported by this backend');
  await broker.eval('p.followUp("continue"); "fired"');
  await tick();
  await broker.pump();
  // Nothing was steered: the steer settled the honest `failed`, recorded
  // durably, and the degradation surfaced guest-visibly as a warn line.
  assert.equal(broker.store().lookup('c2')!.completion!.value, 'failed');
  let sawWarn = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = await broker.eval('1');
    if (
      output(probe).some(
        (l) => l.startsWith('warn: ') && l.includes('lazy re-attach') && l.includes('failed'),
      )
    ) {
      sawWarn = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(sawWarn, 'the capability-gate degradation surfaced guest-visibly');
  await broker.dispose();
  ws.dispose();
});

test('review 2/1c: a settled handle whose session never opened (no recorded backend session) keeps the honest failed — never a load', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The call's session fails to open (the runner throws): the record has
  // no backend session id.
  runner.openSession = async () => {
    throw new Error('no backend');
  };
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  await broker.pump();
  const got = await broker.eval('await p.followUp("x")');
  await tick();
  await broker.pump();
  let outcome: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = await broker.eval('await p.followUp("x")');
    if (probe.result !== undefined) {
      outcome = probe.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(outcome, '"failed"');
  assert.equal(runner.loadedWith.length, 0, 'nothing to load — the session never opened');
  void got;
  await broker.dispose();
  ws.dispose();
});

// ── 2. Backend identity/pool routing is persisted ──────────────────────

test('review 2/2: the resolved backend id is recorded at session open and pins the restore\'s loadSession routing — a changed configured default never misses the original session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-pin-'));
  const storePath = `${dir}/calls.jsonl`;
  try {
    const runner = new FakeRunner();
    const { ws, broker } = await setup({ runner, store: JsonlCallStore.open(storePath) });
    // The guest's reserved "default" sentinel routes to the configured
    // default backend; the RESOLVED backend id ("pi") is what the store
    // records.
    await broker.eval('const p = agent("default", "task"); "started"');
    await tick();
    const record = broker.store().lookup('c1')!;
    assert.equal(record.modelSpec, 'default', 'the verbatim spec is persisted');
    assert.equal(record.backendId, 'pi', 'the resolved backend id is persisted');
    const snapshot = ws.snapshot();
    await broker.dispose();
    ws.dispose();
    void runner;

    // Restore: even though the CURRENT default would route elsewhere, the
    // re-attach pins the recorded backend id.
    const ws2 = await Workspace.restore(PROJECT, snapshot);
    const runner2 = new FakeRunner();
    const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
    await broker2.reconcile();
    assert.equal(runner2.loadedWith.length, 1, 'the call re-attached');
    assert.equal(runner2.loadedWith[0].model, 'pi', 'routing pinned the ORIGINAL backend id');
    await broker2.dispose();
    ws2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review 2/2b: a re-issued call re-routes to the ORIGINAL backend (the recorded pin), never the current default', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/deepseek-v4-flash-max", "task"); "started"');
  await tick();
  const recorded = broker.store().lookup('c1')!.sessionId!;
  const snapshot = ws.snapshot();
  await broker.dispose();
  ws.dispose();

  // A fresh runner whose loadSession FAILS (the session is lost at the
  // backend): the fallback re-issue must route by the recorded backend
  // id, not by the model spec re-resolved against a changed default.
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.loadError = new Error('session lost');
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: new InMemoryCallStore() });
  // The in-memory store starts EMPTY — reconcile adopts the registry
  // entry but loses the recorded session id (a wiped store): the call
  // re-issues through the ordinary dispatch path.
  await broker2.reconcile();
  await tick();
  void recorded;
  assert.equal(runner2.openedWith.length, 1, 'the lost call was re-issued');
  assert.equal(
    runner2.openedWith[0].model,
    'pi/deepseek-v4-flash-max',
    'the re-issue routes by the verbatim recorded spec',
  );
  await broker2.dispose();
  ws2.dispose();
});

// ── 3. The client-presence drain ───────────────────────────────────────

/** A snapshot sink recording the boundaries (the drain cadence). */
class BoundSink implements SnapshotSink {
  boundaries: Array<'eval' | 'settlement'> = [];
  boundary(kind: 'eval' | 'settlement'): void {
    this.boundaries.push(kind);
  }
  flush(): void {}
}

test('review 2/3: drainForDisconnect drains in-flight turns to completion (settlement boundaries fire), then closes every idle child; a bound-exceeding turn is cancelled (the honest bounded teardown)', async () => {
  const runner = new FakeRunner();
  const sink = new BoundSink();
  const { ws, broker } = await setup({ runner, sink });
  await broker.eval('const a = agent("pi/x", "A"); const b = agent("pi/x", "B"); "started"');
  await tick();
  assert.equal(broker.busySessionCount(), 2, 'two turns in flight');

  // The drain runs WITHOUT the test completing the turns: it must WAIT
  // for them (the doc: in-flight turns drain to completion — never a
  // cancel of running work).
  const draining = broker.drainForDisconnect(60_000);
  await tick();
  assert.equal(broker.busySessionCount(), 2, 'the drain waits instead of cancelling');
  runner.sessions[0].completeTurn('A done');
  runner.sessions[1].completeTurn('B done');
  assert.equal(await draining, true, 'both turns drained within the bound');
  assert.ok(broker.isDrained, 'the broker reports drained');
  for (const session of runner.sessions) {
    assert.equal(session.releases, 1, 'every child closed after the drain');
  }
  // The drain's settlement boundaries fired (the daemon's snapshot sink
  // persists each one — a kill mid-drain loses nothing).
  assert.ok(sink.boundaries.includes('settlement'), sink.boundaries.join(','));
  // Both results settled into the VM (the continuation can read them).
  const got = await broker.eval('await a + "|" + await b');
  assert.equal(got.result, '"A done|B done"');
  await broker.dispose();
  ws.dispose();
});

test('review 2/3b: the drain bound is the outer ceiling — an over-bound turn is cancelled and settled as the recoverable AGENT_CANCELLED', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  assert.equal(await broker.drainForDisconnect(50), false, 'the bound expired with a turn still running');
  assert.ok(broker.isDrained);
  assert.equal(runner.sessions[0].releases, 1, 'the child closed even under the bound');
  // The cancelled call rejects recoverably into the guest.
  let result: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const got = await broker.eval('await p.catch((e) => "ERR:" + e.message)');
    if (got.result !== undefined) {
      result = got.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(result?.includes('cancelled'), `recoverable cancel: ${result}`);
  await broker.dispose();
  ws.dispose();
});

test('review 2/3c: queued-but-undelivered steers survive the drain — the next re-attached session delivers them', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The founding session's open is PARKED (the backend is slow): the call
  // is still opening, so a steer in the same window queues for the
  // call's next-turn boundary (the honest `queued`).
  let releaseOpen!: () => void;
  const parkedOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const originalOpen = runner.openSession.bind(runner);
  runner.openSession = async (opts) => {
    await parkedOpen;
    return originalOpen(opts);
  };
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  await broker.eval('const s = p.steer("queued content"); "steered"');
  await tick();
  await broker.pump();
  assert.equal(broker.store().lookup('c2')!.completion!.value, 'queued', 'the steer queued');
  // The drain with nothing busy releases every child; the undelivered
  // steer is re-queued durably against the founding session id.
  assert.equal(await broker.drainForDisconnect(5000), true);
  assert.equal(runner.sessions.length, 0, 'no child was ever opened before the drain');
  assert.ok(broker.isDrained);
  // The slow open completes AFTER the drain: the session registers and
  // merges the surviving steer into its queue (never lost).
  releaseOpen();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const session = runner.sessions[0];
  session.completeTurn('founding done');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await broker.pump();
  // The surviving steer delivered as the next turn on the re-attached
  // session (the founding prompt was consumed by completeTurn).
  assert.equal(session.prompts.length, 1, 'the surviving steer delivered as the next turn');
  assert.equal(session.prompts[0].content, 'queued content');
  assert.equal(broker.store().lookup('c2')!.deliveredAtMs !== null, true, 'the delivered marker recorded');
  await broker.dispose();
  ws.dispose();
});

// ── 4. The workspace manifest ──────────────────────────────────────────

test('review 2/4: the workspace manifest lists top-level bindings with structure-only tokens, provenance, and live-handle status — metadata, never content', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval(
    'globalThis.findings = { zekret: "MARKER-STRING".repeat(50), n: 12 }; globalThis.note = "shibboleth"; ' +
      'globalThis.count = 98765; globalThis.research = agent("pi/x", "investigate"); ' +
      'console.log("logged once"); "done"',
  );
  await tick();
  // The handle is pending (its turn is in flight): the manifest reports
  // the live-handle status from the call store.
  let manifest = broker.workspaceManifest();
  const byName = new Map(manifest.bindings.map((b) => [b.name, b]));
  assert.ok(byName.has('findings'), [...byName.keys()].join(','));
  assert.ok(byName.get('findings')!.token.startsWith('{2 keys} \u00b7 '), byName.get('findings')!.token);
  assert.equal(byName.get('note')!.token, 'string \u00b7 10B');
  assert.equal(byName.get('count')!.token, 'number');
  assert.equal(byName.get('research')!.token, 'agent handle \u00b7 pending \u00b7 call c1');
  assert.equal(byName.get('research')!.provenance, 'eval 1');
  assert.equal(manifest.logs.count, 1);
  assert.equal(manifest.logs.first, 1);
  assert.ok(manifest.inFlight.includes('c1'), manifest.inFlight.join(','));
  // The intent-plane hygiene rule: NO fragment of any bound value at ANY
  // length appears in the manifest.
  const rendered = JSON.stringify(manifest);
  for (const leaked of ['MARKER', 'MARK', 'STRING', 'shibboleth', 'shibb', '98765']) {
    assert.ok(!rendered.includes(leaked), `value content leaked (${leaked}): ${rendered}`);
  }
  assert.ok(!rendered.includes('zekret'), 'nested property names never leak');

  // Settlement attributes continuation bindings to the worker call.
  runner.last().completeTurn('DUG-UP');
  await tick();
  await broker.pump();
  await broker.eval('globalThis.finding = research; "stored"');
  manifest = broker.workspaceManifest();
  const finding = manifest.bindings.find((b) => b.name === 'finding');
  assert.equal(finding?.token, 'agent handle \u00b7 settled \u00b7 call c1');
  assert.ok(!JSON.stringify(manifest).includes('DUG-UP'), 'worker result content never leaks');
  await broker.dispose();
  ws.dispose();
});

// ── 5. The per-eval wall-clock deadline ────────────────────────────────

test('review 2/5: the per-eval deadline makes a CURRENTLY running runaway eval breakable through the quickjs interrupt handler; the VM stays usable', async () => {
  const runner = new FakeRunner();
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, { runner, evalTimeoutMs: 200 });
  try {
    const runaway = await broker.eval('while (true) {}');
    assert.ok(
      output(runaway).some((l) => l.includes('interrupted')),
      output(runaway).join('\n'),
    );
    // The VM stays usable.
    const after = await broker.eval('6 * 7');
    assert.equal(after.result, '42');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});

// ── 6. The provenance passes ───────────────────────────────────────────

test('review 2/6: provenance passes attribute bindings to evals and worker settlements, sanitized at render', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('globalThis.a = { n: 1 }; globalThis.b = "x".repeat(4)');
  await broker.eval('globalThis.c = 3');
  // In-place mutation does NOT re-attribute; rebinding does.
  await broker.eval('globalThis.a.n = 99; globalThis.b = 42');
  let view = ws.provenanceView();
  assert.equal(view.origins.get('a')?.via, 'eval 1');
  assert.equal(view.origins.get('b')?.via, 'eval 3', 'rebinding re-attributes');
  assert.equal(view.origins.get('c')?.via, 'eval 2');
  assert.equal(view.evalSeq, 3);

  // A worker settlement's continuation bindings attribute to the call.
  await broker.eval('const p = agent("pi/x", "task").then((r) => { globalThis.finding = r; })');
  await tick();
  runner.last().completeTurn('result text');
  await tick();
  await broker.pump();
  view = ws.provenanceView();
  assert.equal(view.origins.get('finding')?.via, 'worker c1');

  // A deleted binding drops out of the registry.
  await broker.eval('delete globalThis.c');
  view = ws.provenanceView();
  assert.ok(!view.origins.has('c'));
  await broker.dispose();
  ws.dispose();
});
