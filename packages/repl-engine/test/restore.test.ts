/**
 * Restore-path tests (phase D): the full restore flow — restore the VM
 * from the enveloped snapshot, re-register the host callbacks by name,
 * read the in-VM pending-call registry, and reconcile each outstanding
 * call three ways (mock backends, per the phase deliverable):
 *
 * - completed while down → settle from the call store,
 * - still resumable at the backend → re-attach via loadSession
 *   (capability-gated; a custom backend without the capability degrades
 *   through the same gate, surfaced guest-visibly),
 * - lost → re-issue under the same call id (reissues counter bumped,
 *   the existing guest promise settles exactly once).
 *
 * Plus: pending checkpoints re-surface (answerable across the restore),
 * in-flight steers resolve the honest `failed`, reconcile idempotence,
 * the snapshot cadence (a boundary after each eval and after each
 * settlement drain that changed VM state — nothing for a drain that
 * changed nothing), and the end-to-end debounce (one atomic write per
 * drain burst through the per-project store).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Broker,
  JsonlCallStore,
  ReplWorkspaceStore,
  Workspace,
  loadShippedWasm,
  type BrokerLoadSessionOptions,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type CallStore,
  type ReplEvalResult,
  type SnapshotSink,
} from '../src/index.js';

const PROJECT = '/tmp/repl-restore-project';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake held-open ACP session (phase-C shape plus the phase-D re-attach
 *  seam: `awaitCurrentTurn` + `completeLoadedTurn`). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  /** The re-attach seam: the loaded session's founding-turn completion. */
  readonly loadedTurns: Array<{ resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  stopReason = 'end_turn';
  readonly completedTexts: string[] = [];

  constructor(readonly openedWith: BrokerOpenSessionOptions | BrokerLoadSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.capabilities = { supportsSteering: true };
  }

  static nextId = 0;

  prompt(content: string, opts: BrokerPromptOptions = {}): Promise<BrokerTurn> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ content, resolve, reject });
      // The handoff acknowledgment (the phase-C seam order).
      opts.onHandoff?.();
    });
  }

  steer(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.steers.push({ content, resolve, reject });
    });
  }

  awaitCurrentTurn(): Promise<BrokerTurn> {
    return new Promise((resolve, reject) => {
      this.loadedTurns.push({ resolve, reject });
    });
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

  completeSteer(outcome: string): void {
    const pending = this.steers.shift();
    assert.ok(pending, 'a steer wire call must be in flight');
    pending.resolve(outcome);
  }

  /** The re-attached session's loaded turn completes at the backend. */
  completeLoadedTurn(text: string): void {
    const pending = this.loadedTurns.shift();
    assert.ok(pending, 'a loaded turn must be awaited');
    this.completedTexts.push(text);
    pending.resolve({ stopReason: this.stopReason, text });
  }
}

/** A fake runner with the phase-D loadSession seam. */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  supportsSteering = true;
  /** The re-attach capability gate (acp-agents' supportsLoadSession). */
  supportsLoadSession = true;
  failNextOpens = 0;
  /** The next N loadSession calls reject (each one once). */
  failNextLoads = 0;
  /** LoadSession calls at ordinal >= failLoadsFrom reject (1-based). */
  failLoadsFrom = Infinity;

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    if (this.failNextOpens > 0) {
      this.failNextOpens--;
      throw new Error('spawn failed');
    }
    const session = new FakeSession(opts);
    session.capabilities = { supportsSteering: this.supportsSteering };
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
    this.loadedWith.push(opts);
    const ordinal = this.loadedWith.length;
    if (!this.supportsLoadSession) {
      // The acp-agents capability gate (capabilities.ts): a backend
      // that omits session/load rejects BEFORE any wire request.
      throw new Error('backend does not advertise session/load (loadSession capability gate)');
    }
    if (this.failNextLoads > 0) {
      this.failNextLoads--;
      throw new Error('session not found at the backend');
    }
    if (ordinal >= this.failLoadsFrom) {
      throw new Error('session not found at the backend');
    }
    const session = new FakeSession(opts);
    session.capabilities = { supportsSteering: this.supportsSteering };
    this.sessions.push(session);
    return session;
  }

  async dispose(): Promise<void> {}

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, 'a session must have been opened');
    return this.sessions[this.sessions.length - 1];
  }
}

async function setup(options: {
  store?: CallStore;
  snapshotSink?: SnapshotSink;
  runner?: FakeRunner;
  maxConcurrentAgents?: number;
} = {}) {
  const ws = await Workspace.create(PROJECT);
  const runner = options.runner ?? new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: options.store,
    snapshotSink: options.snapshotSink,
    maxConcurrentAgents: options.maxConcurrentAgents,
  });
  return { ws, broker, runner };
}

function output(r: ReplEvalResult): string[] {
  return r.output;
}

/** Dispatch one agent call and wait until its session is open. */
async function dispatchAgent(broker: Broker, runner: FakeRunner, code = 'const p = agent("pi/x", "task"); "started"') {
  const r = await broker.eval(code);
  assert.equal(r.result, '"started"', JSON.stringify(r));
  await tick();
  assert.equal(runner.sessions.length, 1);
  assert.equal(runner.last().prompts.length, 1, 'the initial turn is in flight');
}

/** Crash: dispose the broker and workspace (the store file survives). */
async function crash(ws: Workspace, broker: Broker): Promise<void> {
  await broker.dispose();
  ws.dispose();
}

// ────────────────────────────────────────────────────────────────────────
// The three reconciliation arms
// ────────────────────────────────────────────────────────────────────────

test('restore with all three arms: settle-from-store, re-attach, re-issue (mock backends)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-arms-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });

  const r = await broker.eval(
    'const a = agent("pi/a", "task A"); const b = agent("pi/b", "task B"); const c = agent("pi/c", "task C"); "started"',
  );
  assert.equal(r.result, '"started"');
  await tick();
  assert.equal(runner.sessions.length, 3);
  const [sessionA, sessionB, sessionC] = runner.sessions;

  // c1's worker completes, but the process crashes BEFORE the pump
  // settles it: the completion is recorded in the store (the pump's
  // record step) while the guest registry still holds c1 pending (the
  // settle step never ran) — the store arm's exact crash window.
  sessionA.completeTurn('result A');
  await tick();
  broker.store().recordCompleted('c1', { outcome: 'resolve', value: 'result A', completedAtMs: Date.now() });
  assert.deepEqual(broker.pendingCalls().map((e) => e.id), ['c1', 'c2', 'c3'], 'all three calls are pending in the registry');

  // The re-attach keys were recorded in the store the moment each
  // session opened (BEFORE any prompt).
  assert.equal(broker.store().lookup('c2')!.sessionId, sessionB.sessionId);
  assert.equal(broker.store().lookup('c3')!.sessionId, sessionC.sessionId);

  // Snapshot the LIVE VM (c2, c3 pending in the registry), then crash.
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  // Restore: fresh workspace over the snapshot, fresh broker + runner
  // over the same store.
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  // The SECOND load (c3's) fails — the session was lost at the backend.
  runner2.failLoadsFrom = 2;
  const report = await broker2.reconcile();
  assert.deepEqual(report.settledFromStore, ['c1']);
  assert.deepEqual(report.reattached, ['c2']);
  assert.deepEqual(report.reissued, ['c3']);
  assert.deepEqual(report.failedLost, []);
  assert.deepEqual(report.requeuedCheckpoints, []);
  assert.deepEqual(report.leftPending, [], 'the full three-way reconcile leaves nothing pending');

  // Guest-visible surfacing: the re-attach info line and the re-issue
  // warn line are in the next tool result (before any later eval
  // consumes the buffer).
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('info: ') && l.includes('c2') && l.includes('re-attached')),
    output(probe).join('\n'),
  );
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('c3') && l.includes('re-issued') && l.includes('session not found')),
    output(probe).join('\n'),
  );
  assert.equal((await broker2.eval('await a')).result, '"result A"', 'the store arm settled c1 exactly once');

  // The re-attach went to the RECORDED backend session with the founding
  // routing (model spec + cwd recovered from the registry entry).
  assert.equal(runner2.loadedWith.length, 2, 'two load attempts: c2 re-attaches, c3 is lost');
  assert.equal(runner2.loadedWith[0].sessionId, sessionB.sessionId);
  assert.equal(runner2.loadedWith[0].model, 'pi/b');
  assert.equal(runner2.loadedWith[0].cwd, PROJECT);
  assert.equal(runner2.sessions[0].openedWith.runId, 'c2', 'the loaded session is addressed by the founding call id');

  // The re-issue opened a FRESH session under the SAME call id and the
  // store bumped the reissues counter (a re-attach is not a re-issue).
  assert.equal(runner2.sessions.length, 2);
  assert.equal(runner2.sessions[1].openedWith.runId, 'c3');
  assert.equal(broker2.store().lookup('c3')!.reissues, 1);
  assert.equal(broker2.store().lookup('c2')!.reissues, 0);

  // The re-attached call's loaded turn completes at the backend → pump →
  // the guest promise resolves exactly once, and the outcome is durable.
  runner2.sessions[0].completeLoadedTurn('result B (loaded)');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await b')).result, '"result B (loaded)"');
  assert.equal(broker2.store().lookup('c2')!.completion!.value, 'result B (loaded)');

  // The re-issued call's fresh turn completes → the SAME guest promise
  // resolves (never a duplicate), and the store's session id now points
  // at the re-issue's new session (a later restore re-attaches THAT one).
  runner2.sessions[1].completeTurn('result C (re-issued)');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await c')).result, '"result C (re-issued)"');
  assert.equal(broker2.store().lookup('c3')!.sessionId, runner2.sessions[1].sessionId);

  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a custom backend without the loadSession capability degrades through the same gate — re-issue, surfaced guest-visibly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-cap-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.supportsLoadSession = false; // the custom backend omits the capability
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, [], 'no re-attach — the backend lacks the capability');
  assert.deepEqual(report.reissued, ['c1'], 're-issue is the honest fallback through the same gate');
  assert.equal(runner2.loadedWith.length, 1, 'the load WAS attempted — the runner enforces the gate');
  assert.equal(broker2.store().lookup('c1')!.reissues, 1);

  // The re-issued call completes normally; the guest sees the result AND
  // the capability-degradation warn line.
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('c1') && l.includes('loadSession') && l.includes('re-issued')),
    output(probe).join('\n'),
  );
  runner2.sessions[0].completeTurn('custom backend result');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, '"custom backend result"');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a session lost at the backend (loadSession fails) degrades to re-issue, surfaced guest-visibly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-lost-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.failNextLoads = 1;
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reissued, ['c1']);
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('not resumable') && l.includes('session not found')),
    output(probe).join('\n'),
  );
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('reconcile is idempotent: a repeated reconcile never re-attaches or re-issues twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-idem-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const first = await broker2.reconcile();
  assert.deepEqual(first.reattached, ['c1']);
  assert.equal(runner2.loadedWith.length, 1);
  const second = await broker2.reconcile();
  assert.deepEqual(second.reattached, ['c1'], 'already-tracked calls report as re-attached');
  assert.equal(runner2.loadedWith.length, 1, 'no second loadSession');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'no second dispatch');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('re-issues respect the concurrency cap: an over-cap re-issue is refused with the recoverable ConcurrencyLimitError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-capref-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({
    store: JsonlCallStore.open(storePath),
    runner,
    maxConcurrentAgents: 3,
  });
  await broker.eval('const p1 = agent("pi/x", "t1"); const p2 = agent("pi/y", "t2"); const p3 = agent("pi/z", "t3"); "started"');
  await tick();
  assert.equal(runner.sessions.length, 3);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  // All three calls are lost at the backend. The RESTORED broker runs a
  // TIGHTER cap (server configuration can change between processes): two
  // re-issues fit, the third is refused (recorded + settled + surfaced).
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.failNextLoads = 3;
  const broker2 = await Broker.attach(ws2, {
    runner: runner2,
    store: JsonlCallStore.open(storePath),
    maxConcurrentAgents: 2,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reissued, ['c1', 'c2']);
  assert.deepEqual(report.failedLost, ['c3'], 'the over-cap re-issue was refused');
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('c3') && l.includes('concurrency limit')),
    output(probe).join('\n'),
  );
  // The refusal is durable and the guest call rejected recoverably.
  const record = broker2.store().lookup('c3')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  const refused = await broker2.eval('await p3.catch((e) => e.message)');
  assert.ok(String(refused.result).includes('concurrency limit reached'), String(refused.result));
  assert.ok(String(refused.result).includes('re-issue of call c3 refused'), String(refused.result));
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// Checkpoints and steers across a restore
// ────────────────────────────────────────────────────────────────────────

test('a pending checkpoint re-surfaces across the restore: listed again, answerable through the surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-cp-'));
  const storePath = join(dir, 'calls.jsonl');
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath) });
  await broker.eval('const q = checkpoint("What color?"); "raised"');
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, { runner: new FakeRunner(), store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.requeuedCheckpoints, ['c1']);
  assert.deepEqual(report.leftPending, []);

  // The question is listed again in the next tool result.
  const listed = await broker2.eval('"probe"');
  assert.deepEqual(listed.checkpoints.map((c) => c.id), ['c1']);
  assert.equal(listed.checkpoints[0].question, '"What color?"');

  // The answer settles the RESTORED checkpoint (no live GuestCall —
  // through the reconciliation surface), exactly once.
  const answered = await broker2.eval('checkpoint.answer("c1", "blue"); "delivered"');
  assert.equal(answered.result, '"delivered"');
  assert.equal((await broker2.eval('await q')).result, '"blue"');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'blue');
  // A second answer reports false (first-wins).
  assert.equal((await broker2.eval('checkpoint.answer("c1", "again")')).result, 'false');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a steer whose wire call died with the process resolves the honest failed, with a warn line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-steer-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner, 'const pi = agent("pi/x", "task"); "started"');
  // The steering-extension backend: the injected steer's wire call is in
  // flight at the crash (its outcome never resolves in this process).
  const steered = await broker.eval('const o = await pi.steer("go deeper"); "outcome:" + o');
  assert.equal(steered.result, undefined, 'the injected steer is in flight');
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, { runner: new FakeRunner(), store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, ['c1'], 'the founding call re-attaches');
  assert.deepEqual(report.failedLost, ['c2'], 'the in-flight steer settles failed');
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('c2') && l.includes('unknowable')),
    output(probe).join('\n'),
  );
  // The failed settle is durable: a second restore settles it from the
  // store (never re-failed, never re-injected).
  assert.equal(broker2.store().lookup('c2')!.completion!.value, 'failed');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// The state-changing-boundary cadence
// ────────────────────────────────────────────────────────────────────────

test('cadence: a boundary fires after each eval and after each settlement drain that changed VM state — never for an empty drain', async () => {
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = {
    boundary: (kind) => kinds.push(kind),
    flush: () => {},
  };
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ snapshotSink: sink, runner });

  // A plain eval: one eval boundary.
  await broker.eval('6 * 7');
  assert.deepEqual(kinds.splice(0), ['eval']);

  // A dispatch eval (suspends): one eval boundary, no settlement.
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  assert.deepEqual(kinds.splice(0), ['eval']);

  // A settlement drain that changed VM state: one settlement boundary.
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  assert.deepEqual(kinds.splice(0), ['settlement']);

  // A pump with nothing ready: drains nothing, fires nothing.
  await broker.pump();
  assert.deepEqual(kinds.splice(0), []);

  // An eval whose pump settles a completed call AND runs the eval: both
  // boundaries fire, in order (the pump's first).
  await broker.eval('const p2 = agent("pi/x", "task2"); "started"');
  assert.deepEqual(kinds.splice(0), ['eval'], 'the dispatch eval fired its own boundary');
  await tick();
  runner.last().completeTurn('second');
  await tick();
  const resumed = await broker.eval('const got = await p2; "resolved:" + got');
  assert.equal(resumed.result, '"resolved:second"');
  assert.deepEqual(kinds.splice(0), ['settlement', 'eval']);

  // A reconcile that settles from the store fires the settlement
  // boundary (its drain changed VM state).
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-cadence-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner2 = new FakeRunner();
  const { ws: ws2, broker: broker2 } = await setup({ snapshotSink: sink, store: JsonlCallStore.open(storePath), runner: runner2 });
  await broker2.eval('const q = agent("pi/x", "t"); "started"');
  assert.deepEqual(kinds.splice(0), ['eval'], 'the dispatch eval fired its own boundary');
  await tick();
  const snapshot = ws2.snapshot();
  await crash(ws2, broker2);
  const ws3 = await Workspace.restore(PROJECT, snapshot);
  const broker3 = await Broker.attach(ws3, {
    runner: new FakeRunner(),
    store: JsonlCallStore.open(storePath),
    snapshotSink: sink,
  });
  broker3.store().recordCompleted('c1', { outcome: 'resolve', value: 'while down', completedAtMs: Date.now() });
  await broker3.reconcile();
  assert.deepEqual(kinds.splice(0), ['settlement'], 'the reconcile drain fired its boundary');
  assert.equal((await broker3.eval('await q')).result, '"while down"');
  await broker3.dispose();
  ws3.dispose();
  rmSync(dir, { recursive: true, force: true });
  await ws.dispose();
});

test('debounce end to end: one eval that pumps settlements and runs the eval writes ONE atomic snapshot through the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-debounce-'));
  const storePath = join(dir, 'calls.jsonl');
  const module = await loadShippedWasm();
  const store = ReplWorkspaceStore.open(PROJECT, { persistenceRoot: dir });
  const ws = await Workspace.create(PROJECT, { wasm: module });
  const runner = new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: JsonlCallStore.open(storePath),
    snapshotSink: store.snapshotWriter(ws, module),
  });

  // Eval 1: a dispatch. One write (the eval boundary).
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  assert.equal(store.stats().snapshotWrites, 1, 'the eval boundary wrote once');

  // The worker completes; the NEXT eval both pumps the settlement and
  // runs the eval — one drain burst, ONE write (the doc's debounce).
  runner.last().completeTurn('result');
  await tick();
  const r = await broker.eval('const got = await p; "resolved:" + got');
  assert.equal(r.result, '"resolved:result"');
  assert.equal(store.stats().snapshotWrites, 2, 'the settlement + eval boundaries of one burst coalesced into one write');

  // A standalone settlement drain writes once (its own burst): the
  // dispatch eval wrote its own boundary (3), the pump's drain its own
  // (4).
  await broker.eval('const q = agent("pi/y", "t2"); "started"');
  await tick();
  runner.last().completeTurn('second');
  await tick();
  await broker.pump();
  assert.equal(store.stats().snapshotWrites, 4, 'the standalone settlement drain wrote once');

  // The disk snapshot is loadable and restores (the state survives).
  const loaded = store.loadSnapshot(module);
  const ws2 = await Workspace.restore(PROJECT, loaded.snapshot, { wasm: module });
  assert.equal((await ws2.eval('"state survived"')).kind, 'value');
  ws.dispose();
  ws2.dispose();
  await broker.dispose();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
