/**
 * Phase-D review round 5 regression suite: the reviewer's rejected items,
 * pinned at the engine boundary.
 *
 * 1. The broker's drain latch must never skip in-flight work on a SECOND
 *    disconnect: a reconnect's fresh dispatch (or a lazy re-attach)
 *    clears the latch the moment a child may open, so drain → reconnect →
 *    parked openSession → disconnect drains (and stops) the open instead
 *    of returning immediately.
 * 2. A lazy re-attach whose `loadSession` lands AFTER the drain deadline
 *    (or after disposal) is released immediately — it never registers and
 *    never prompts (the drain/disposal generation fence).
 * 3. `cancelCall`'s lazy re-attach runs OUTSIDE the serialized operation
 *    chain — a hung backend `loadSession` can never hold the chain, so
 *    `drainForDisconnect` enters promptly and its deadline is effective.
 * 4. An `openSession` that lands after `dispose` is released immediately
 *    (never re-registers, never prompts on the disposed broker).
 * 5. Simultaneously ready settlements drain ONE CALL AT A TIME, each
 *    with its own provenance pass: two independent continuations
 *    producing separate bindings are attributed to their OWN worker and
 *    task (`worker c1` / `worker c2`), never a joined batch label.
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
  type SnapshotBoundaryKind,
  type SnapshotSink,
} from '../src/index.js';

const PROJECT = '/tmp/repl-review5-project';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Poll until `predicate` holds (the async-landing tests' wait). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The fake held-open ACP session (see review2.test.ts). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  stopReason = 'end_turn';
  readonly completedTexts: string[] = [];
  backendId = 'pi';

  constructor(readonly openedWith: BrokerOpenSessionOptions | BrokerLoadSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.capabilities = { supportsSteering: true };
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
}

/** The fake runner (see review2.test.ts). */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];

  listBackends(): string[] {
    return ['claude', 'codex', 'opencode', 'pi'];
  }

  defaultBackendId(): string {
    return 'claude';
  }

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    session.backendId = 'pi';
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
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

async function setup(options: {
  runner?: BrokerRunner;
  maxConcurrentAgents?: number;
  store?: CallStore;
  sink?: SnapshotSink;
} = {}): Promise<{
  ws: Workspace;
  broker: Broker;
}> {
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, {
    runner: options.runner,
    store: options.store ?? new InMemoryCallStore(),
    evalTimeoutMs: 0, // tests drive interrupts explicitly
    snapshotSink: options.sink,
    ...(options.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: options.maxConcurrentAgents } : {}),
  });
  return { ws, broker };
}

/** Settle a call end to end (complete its turn, pump, drain the latch). */
async function settleAndDrain(broker: Broker, runner: FakeRunner, boundMs = 5000): Promise<void> {
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  runner.last().completeTurn('settled');
  await tick();
  await broker.pump();
  assert.equal(await broker.drainForDisconnect(boundMs), true, 'the settled call drains immediately');
  assert.ok(broker.isDrained);
}

// ── 1. The drain latch never skips in-flight work on a second disconnect ─

test('review 5/1: a second disconnect after a reconnect with a PARKED open drains again — the fresh dispatch cleared the stale drain latch, and the parked open is stopped (never prompts after the last client disconnected)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await settleAndDrain(broker, runner);

  // Reconnect: the next dispatch's openSession is PARKED (slow backend).
  let releaseOpen!: () => void;
  const parkedOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const originalOpen = runner.openSession.bind(runner);
  runner.openSession = async (opts) => {
    await parkedOpen;
    return originalOpen(opts);
  };
  await broker.eval('const q = agent("pi/x", "task2"); "started"');
  await tick();
  // The old code kept the latch set until the open RESOLVED — the second
  // disconnect then returned immediately and the child could open and
  // prompt after the last client disconnected.
  assert.ok(!broker.isDrained, 'the fresh dispatch cleared the stale drain latch');
  assert.equal(await broker.drainForDisconnect(60), false, 'the second disconnect drains (and stops) the parked open');
  assert.ok(broker.isDrained);
  // The parked open lands later: the child is closed immediately — it
  // never prompts (nothing runs after the last client disconnected).
  releaseOpen();
  await waitFor(() => runner.sessions.length === 2);
  const late = runner.sessions[1];
  assert.equal(late.releases, 1, 'the stopped child was closed without ever prompting');
  assert.equal(late.prompts.length, 0, 'the stopped call never ran a turn');
  await broker.dispose();
  ws.dispose();
});

test('review 5/1b: a lazy re-attach in flight at the second disconnect also clears the stale latch — the drain waits for it and its late landing is fenced', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await settleAndDrain(broker, runner);

  // Reconnect: a followUp starts a lazy re-attach whose loadSession is
  // PARKED.
  let releaseLoad!: () => void;
  const parkedLoad = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const originalLoad = runner.loadSession.bind(runner);
  runner.loadSession = async (opts) => {
    await parkedLoad;
    return originalLoad(opts);
  };
  await broker.eval('p.followUp("continue"); "fired"');
  await tick();
  assert.ok(!broker.isDrained, 'the lazy re-attach start cleared the stale drain latch');
  // The second disconnect: the drain waits for the parked load, then the
  // bound stops it (the drain returns false — the honest bounded
  // teardown).
  assert.equal(await broker.drainForDisconnect(60), false);
  assert.ok(broker.isDrained);
  // The parked load lands after the deadline: the child is released
  // immediately — never registered, never prompted.
  releaseLoad();
  await waitFor(() => runner.sessions.length === 2);
  const late = runner.sessions[1];
  assert.equal(late.releases, 1, 'the late re-attached child was closed without registering');
  assert.equal(late.prompts.length, 0, 'the late re-attach never prompted');
  // The steer settles the honest failed (nothing was steered).
  await broker.pump();
  for (let attempt = 0; attempt < 100; attempt++) {
    await broker.pump();
    const record = broker.store().lookup('c2')?.completion;
    if (record !== undefined && record !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.store().lookup('c2')!.completion!.value, 'failed');
  await broker.dispose();
  ws.dispose();
});

// ── 2. The parked-loadSession fence (late re-attachments never register) ─

test('review 5/2: a lazy re-attach load that lands AFTER the drain deadline is released immediately — it never registers and never prompts (the generation fence)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await settleAndDrain(broker, runner);

  // Park the lazy re-attach's loadSession BEFORE the drain deadline.
  let releaseLoad!: () => void;
  const parkedLoad = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const originalLoad = runner.loadSession.bind(runner);
  runner.loadSession = async (opts) => {
    await parkedLoad;
    return originalLoad(opts);
  };
  await broker.eval('p.followUp("continue"); "fired"');
  await tick();
  assert.equal(runner.loadedWith.length, 0, 'the load is still parked');
  // The drain's bound expires with the load still in flight.
  assert.equal(await broker.drainForDisconnect(60), false);
  assert.ok(broker.isDrained);
  // The parked load lands AFTER the deadline: the loaded child is
  // released immediately — it never registers and never prompts (the old
  // code cleared `pendingReattaches` without fencing the unresolved
  // load, so the landing ran a warm child after the disconnect).
  releaseLoad();
  await waitFor(() => runner.sessions.length === 2);
  const late = runner.sessions[1];
  assert.equal(late.releases, 1, 'the late re-attached child was closed without registering');
  assert.equal(late.prompts.length, 0, 'the late re-attach never prompted');
  assert.equal(broker.liveAgents().length, 0, 'no session entry was registered');
  await broker.pump();
  for (let attempt = 0; attempt < 100; attempt++) {
    await broker.pump();
    const record = broker.store().lookup('c2')?.completion;
    if (record !== undefined && record !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(broker.store().lookup('c2')!.completion!.value, 'failed', 'nothing was steered — the honest failed');
  await broker.dispose();
  ws.dispose();
});

// ── 3. cancelCall never holds the chain on a hung loadSession ──────────

test('review 5/3: a hung backend loadSession in cancelCall never blocks the client-presence drain (the lazy re-attach runs OUTSIDE the serialized chain — the drain\'s deadline starts when it enters)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await settleAndDrain(broker, runner);

  // The backend loadSession hangs forever.
  runner.loadSession = async () => new Promise(() => {});
  const cancelling = broker.cancelCall('c1');
  await tick();
  const started = Date.now();
  const drained = await broker.drainForDisconnect(200);
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the drain bound expired with the load still hung');
  assert.ok(elapsed < 2000, `the drain returned within its bound: ${elapsed} ms`);
  assert.ok(broker.isDrained);
  void cancelling;
  await broker.dispose();
  ws.dispose();
});

// ── 4. The disposal fence (late opens never register or prompt) ─────────

test('review 5/4: an openSession that lands AFTER dispose is released immediately — it never registers and never prompts on the disposed broker', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // Park the founding session's open.
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
  assert.equal(runner.sessions.length, 0, 'the open is still parked');
  // Dispose while the open is still in flight (the reset path drives the
  // same disposal).
  await broker.dispose();
  // The parked open lands LATER: the child is released immediately — it
  // never registers and never prompts (the old code cleared
  // `openingCalls`/`stoppedOpens` without fencing the unresolved open,
  // so the landing re-registered the session and could prompt on the
  // disposed broker).
  releaseOpen();
  await waitFor(() => runner.sessions.length === 1);
  const late = runner.sessions[0];
  assert.equal(late.releases, 1, 'the late child was closed without registering');
  assert.equal(late.prompts.length, 0, 'the late open never prompted');
  ws.dispose();
});

// ── 5. Per-call settlement provenance ──────────────────────────────────

test('review 5/5: simultaneously ready settlements drain ONE CALL AT A TIME — each continuation binding is attributed to its OWN worker and task (never the joined batch label)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval(
    'const a = agent("pi/x", "task A").then((r) => { globalThis.fromA = r; });' +
      'const b = agent("pi/x", "task B").then((r) => { globalThis.fromB = r; });' +
      '"started"',
  );
  await tick();
  assert.equal(runner.sessions.length, 2, 'two independent subagents');
  // BOTH turns complete before the pump: both outcomes are ready
  // simultaneously.
  runner.sessions[0].completeTurn('A-result');
  runner.sessions[1].completeTurn('B-result');
  await tick();
  await broker.pump();
  // The per-value producer attribution: the old batch drain labelled
  // every binding changed in the batch with ALL call ids (`worker
  // c1+c2`) and joined both tasks — two independent continuations were
  // falsely attributed to both workers.
  const view = ws.provenanceView();
  assert.equal(view.origins.get('fromA')?.via, 'worker c1', 'the A continuation is attributed to worker c1 alone');
  assert.equal(view.origins.get('fromB')?.via, 'worker c2', 'the B continuation is attributed to worker c2 alone');
  const manifest = broker.workspaceManifest();
  const byName = new Map(manifest.bindings.map((b) => [b.name, b]));
  assert.equal(byName.get('fromA')?.provenance, 'worker c1');
  assert.equal(byName.get('fromA')?.task, 'task A', 'the "from what task" half follows the same per-value split');
  assert.equal(byName.get('fromB')?.provenance, 'worker c2');
  assert.equal(byName.get('fromB')?.task, 'task B');
  await broker.dispose();
  ws.dispose();
});

// ── 6. interrupt { id } / handle.cancel() on a still-OPENING call ──────

test('review 8/6a: cancelCall cancels a call whose openSession is still pending — the decision\'s opening arm fences + settles it DURABLY (recorded AGENT_CANCELLED, guest-settled first-wins, concurrency token released), and the LATE child is closed without ever prompting (the phase-E review rejection: cancelCall ignored openingCalls, returned `none`, and the eventual open resolved into a prompted, supposedly-interrupted call)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner, maxConcurrentAgents: 1 });
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
  assert.deepEqual(
    broker.pendingCalls().map((e) => e.id),
    ['c1'],
    'the opening call is pending while the open is in flight',
  );
  // The interrupt lands with the open STILL parked.
  assert.equal(await broker.cancelCall('c1'), 'cancelled', 'the opening call reports cancelled');
  // The settlement is DURABLE at the interrupt, not deferred to the
  // landing: recorded (AGENT_CANCELLED, recoverable), the guest
  // promise already rejected, the registry no longer pending.
  const record = broker.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  assert.equal((record.completion!.value as { replBackend?: string }).replBackend, 'pi');
  assert.deepEqual(
    broker.pendingCalls().map((e) => e.id),
    [],
    'the cancelled opening call is not left pending',
  );
  assert.deepEqual(broker.liveAgents(), [], 'no live session was ever registered');
  const uncaught = await broker.eval('await p');
  const uncaughtLine = uncaught.output.find((line) => line.includes('(call c1'));
  assert.ok(uncaughtLine !== undefined, uncaught.output.join('\n'));
  assert.ok(
    uncaughtLine.includes('(call c1 on backend pi)'),
    `the opening-call rejection renders its resolved backend: ${uncaughtLine}`,
  );
  const got = await broker.eval('await p.catch((e) => "ERR:" + e.message)');
  assert.ok(
    (got.result ?? '').includes('was cancelled by interrupt while its session was still opening'),
    `guest-visible settlement: ${got.result}`,
  );
  // The concurrency token was released: under a cap of ONE, a fresh
  // dispatch must not be refused.
  runner.openSession = originalOpen;
  await broker.eval('const q = agent("pi/x", "again"); "started"');
  await tick();
  assert.equal(runner.sessions.length, 1, 'the fresh dispatch opened (the cancelled call freed its slot)');
  runner.sessions[0].completeTurn('ok');
  await tick();
  await broker.pump();
  // The LATE landing of the cancelled open: the child is closed
  // immediately — it never prompts (a supposedly-interrupted call must
  // not run a turn) — and the late reject is a first-wins no-op
  // against the interrupt's recorded completion.
  releaseOpen();
  await waitFor(() => runner.sessions.length === 2);
  const session = runner.sessions[1];
  assert.equal(session.releases, 1, 'the stopped child was closed without ever prompting');
  assert.equal(session.prompts.length, 0, 'the supposedly-interrupted call never ran a turn');
  for (let attempt = 0; attempt < 100; attempt++) {
    await broker.pump();
    const check = await broker.eval('await p.catch((e) => "ERR:" + e.message)');
    if (check.result !== undefined) {
      assert.ok((check.result as string).includes('was cancelled by interrupt'), 'the late landing settled nothing new');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const after = broker.store().lookup('c1')!;
  assert.equal(after.completion!.outcome, 'reject');
  assert.equal((after.completion!.value as { recoverable?: boolean }).recoverable, true);
  assert.equal(after.reissues, 0, 'never re-issued');
  await broker.dispose();
  ws.dispose();
});

test('review 8/6b: the guest handle cancel() on a still-OPENING call is the same cancellation as the interrupt tool\'s id path — fenced + settled durably as cancelled, and the steer resolves `cancelled` (the phase-E review rejection: the handle cancel fell through to `failed` — "nothing was steered" — while the eventual open went on to prompt a supposedly-cancelled call)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  let releaseOpen!: () => void;
  const parkedOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const originalOpen = runner.openSession.bind(runner);
  runner.openSession = async (opts) => {
    await parkedOpen;
    return originalOpen(opts);
  };
  await broker.eval('const pi = agent("pi/x", "task"); "started"');
  await tick();
  const outcome = await broker.eval('await pi.cancel()');
  assert.ok(
    String(outcome.result).includes('cancelled'),
    `the handle cancel resolves with what actually happened: ${outcome.result}`,
  );
  const record = broker.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  assert.equal((record.completion!.value as { replBackend?: string }).replBackend, 'pi');
  assert.equal((broker.store().lookup('c2')!.completion!.value as string), 'cancelled', 'the steer recorded its outcome');
  assert.deepEqual(
    broker.pendingCalls().map((e) => e.id),
    [],
    'the cancelled opening call is not left pending',
  );
  const got = await broker.eval('await pi.catch((e) => "ERR:" + e.message)');
  assert.ok(
    (got.result ?? '').includes('was cancelled by handle cancel while its session was still opening'),
    `guest-visible settlement: ${got.result}`,
  );
  // The LATE landing closes the child without prompting.
  releaseOpen();
  await waitFor(() => runner.sessions.length === 1);
  const session = runner.sessions[0];
  assert.equal(session.releases, 1, 'the stopped child was closed without ever prompting');
  assert.equal(session.prompts.length, 0, 'the supposedly-cancelled call never ran a turn');
  await broker.pump();
  const after = broker.store().lookup('c1')!;
  assert.equal(after.completion!.outcome, 'reject');
  assert.equal(after.reissues, 0, 'never re-issued');
  await broker.dispose();
  ws.dispose();
});

// ── 9. The opening-cancel's settlement boundary + provenance, and the
//        slot release's queued-delivery kick (phase-E review rejection
//        round 9) ────────────────────────────────────────────────────

test('review 9/1: cancelling a still-OPENING call is a settlement drain that fires the per-settlement provenance pass AND the state-changing boundary — the manifest immediately attributes the continuation\'s binding to the cancelled worker, and an IMMEDIATE snapshot/restart (no eval or wait in between) restores the settled registry with that provenance intact (the phase-E review rejection: the opening-cancel settled and drained the guest but skipped `provenancePass` and `sink.boundary`, so the manifest missed the settlement\'s provenance and a kill right after the interrupt restored the PRE-settlement snapshot with the call still pending — the round-8 daemon regression masked it by performing another eval and wait before the restart)', async () => {
  const runner = new FakeRunner();
  const boundaries: SnapshotBoundaryKind[] = [];
  let flushes = 0;
  const sink: SnapshotSink = {
    boundary(kind) {
      boundaries.push(kind);
    },
    flush() {
      flushes++;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'repl-review9-'));
  const storePath = join(dir, 'calls.jsonl');
  const { ws, broker } = await setup({ runner, store: JsonlCallStore.open(storePath), sink });
  // Park the founding session's open.
  let releaseOpen!: () => void;
  const parkedOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const originalOpen = runner.openSession.bind(runner);
  runner.openSession = async (opts) => {
    await parkedOpen;
    return originalOpen(opts);
  };
  // The settlement drain's continuation creates a binding: without the
  // per-settlement provenance pass, `wasCancelled` would never be
  // attributed to the worker that was cancelled.
  await broker.eval('const p = agent("pi/x", "task"); p.catch(() => { globalThis.wasCancelled = true; }); "started"');
  await tick();
  boundaries.length = 0;
  assert.equal(await broker.cancelCall('c1'), 'cancelled');
  // THE SINK-BOUNDARY ASSERTION: the interrupt ITSELF fired the
  // settlement boundary — no eval or wait in between — and the
  // serialized operation flushed the burst (the daemon's writer would
  // persist the settled workspace before the interrupt's promise
  // resolves).
  assert.deepEqual(boundaries, ['settlement'], `exactly the settlement boundary fired: ${boundaries.join(',')}`);
  assert.ok(flushes >= 1, 'the operation-end burst flush ran');
  // THE PROVENANCE ASSERTION: the continuation the settlement drain ran
  // is attributed to the cancelled worker — not a later eval.
  const view = ws.provenanceView();
  assert.equal(view.origins.get('wasCancelled')?.via, 'worker c1', 'the settlement pass attributed the continuation binding');
  const manifest = broker.workspaceManifest();
  const binding = manifest.bindings.find((b) => b.name === 'wasCancelled');
  assert.ok(binding !== undefined, 'the continuation binding is in the manifest');
  assert.equal(binding.provenance, 'worker c1', 'the manifest carries the settlement provenance');
  // THE IMMEDIATE RESTART REGRESSION: snapshot NOW — no eval or wait in
  // between — and restore over the same store. The restored VM must
  // already carry the settlement (the registry is empty — nothing left
  // for the reconcile's store arm) with the provenance intact inside
  // the snapshot.
  const snapshot = ws.snapshot();
  await broker.dispose();
  ws.dispose();
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, {
    runner: runner2,
    store: JsonlCallStore.open(storePath),
    evalTimeoutMs: 0,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.settledFromStore, [], 'the snapshot already carries the settlement — the store arm has nothing to settle');
  assert.deepEqual(
    broker2.pendingCalls().map((e) => e.id),
    [],
    'the restored registry is settled, not pending',
  );
  const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
  assert.ok(
    (got.result ?? '').includes('was cancelled by interrupt'),
    `the guest-visible settlement survives the immediate restart: ${got.result}`,
  );
  const view2 = ws2.provenanceView();
  assert.equal(view2.origins.get('wasCancelled')?.via, 'worker c1', 'the provenance traveled INSIDE the snapshot');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('review 9/2: cancelling a still-OPENING call releases its concurrency slot THROUGH THE GLOBAL KICK — a cap-pressure follow-up queued on an idle session starts its delivery turn the moment the opening call is cancelled (the phase-E review rejection: the slot release skipped `kickQueuedDeliveries`, so under a cap of one the queued follow-up stayed stuck despite capacity becoming available)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner, maxConcurrentAgents: 1 });
  // The founding call opens and settles: its session is IDLE with the
  // slot free.
  await broker.eval('const pi = agent("pi/x", "task"); "started"');
  await tick();
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  // A second call dispatches (holding the only slot) with its open
  // PARKED: the cap is exhausted while the first session sits idle.
  let releaseOpen!: () => void;
  const parkedOpen = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const originalOpen = runner.openSession.bind(runner);
  runner.openSession = async (opts) => {
    await parkedOpen;
    return originalOpen(opts);
  };
  await broker.eval('const q = agent("pi/x", "second"); "started"');
  await tick();
  assert.equal(runner.sessions.length, 1, 'the second call is still opening');
  // The cap-pressure follow-up on the IDLE session queues with the
  // §4.2 ANSWER semantics (a follow-up turn IS subagent work — the
  // ceiling is absolute; its promise stays pending until the delivery
  // runs).
  const queued = await broker.eval('const o = await pi.steer("go deeper"); console.log("outcome", o); "done"');
  assert.equal(queued.result, undefined, 'the cap-pressure follow-up suspends (answer semantics)');
  assert.equal(runner.last().prompts.length, 0, 'no delivery turn can start while the cap is exhausted');
  // Cancel the OPENING call: its slot frees, and the slot-release kick
  // must start the queued follow-up as a delivery turn — the old code
  // released the token without kicking, so the follow-up stayed queued
  // forever.
  assert.equal(await broker.cancelCall('c2'), 'cancelled');
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'the queued follow-up started as a delivery turn');
  assert.equal(runner.last().prompts[0].content, 'go deeper');
  runner.last().completeTurn('deeper answer');
  await tick();
  await broker.pump();
  const outcomeProbe = await broker.eval('"probe"');
  assert.ok(outcomeProbe.output.some((l) => l === 'outcome deeper answer'), outcomeProbe.output.join('\n'));
  // The late landing of the cancelled open closes the child without
  // prompting.
  releaseOpen();
  await waitFor(() => runner.sessions.length === 2);
  const late = runner.sessions[1];
  assert.equal(late.releases, 1, 'the stopped child was closed without ever prompting');
  assert.equal(late.prompts.length, 0, 'the supposedly-interrupted call never ran a turn');
  await broker.dispose();
  ws.dispose();
});
