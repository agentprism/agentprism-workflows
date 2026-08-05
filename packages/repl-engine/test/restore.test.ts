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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { AcpAgentRunner } from '@automatalabs/acp-agents';

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

/** The acp-agents integration fixture: a REAL ACP agent server (SDK-side)
 *  that speaks real ACP over stdio — the "actual acp-agents adapter" the
 *  phase-D review demands the re-attach arm be tested through. */
const FAKE_AGENT_FIXTURE = fileURLToPath(
  new URL('../../acp-agents/test/fixtures/fake-acp-agent.mjs', import.meta.url),
);

/** The fake-agent spawn/env keys (see acp-agents' test helpers). */
const FAKE_ENV_KEYS = [
  'AGENTPRISM_CLAUDE_ACP_CMD',
  'AGENTPRISM_CLAUDE_ACP_ARGS',
  'AGENTPRISM_FAKE_LOG',
  'AGENTPRISM_FAKE_SCENARIO',
  'AGENTPRISM_DEFAULT_BACKEND',
] as const;

function clearFakeEnv(): void {
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
}

/** Point the claude built-in's spawn at the fake ACP agent (the acp-agents
 *  integration pattern) and script its scenario. */
function configureFakeAgent(scenario: unknown, logPath: string): void {
  clearFakeEnv();
  process.env.AGENTPRISM_CLAUDE_ACP_CMD = process.execPath;
  process.env.AGENTPRISM_CLAUDE_ACP_ARGS = FAKE_AGENT_FIXTURE;
  process.env.AGENTPRISM_DEFAULT_BACKEND = 'claude';
  process.env.AGENTPRISM_FAKE_SCENARIO = JSON.stringify(scenario);
  process.env.AGENTPRISM_FAKE_LOG = logPath;
}

interface WireLogEntry {
  method: string;
  pid?: number;
  params?: { sessionId?: string };
}

/** The fake agent's request log (one JSON line per observed ACP request). */
function readWireLog(path: string): WireLogEntry[] {
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireLogEntry);
}

/** Poll until `predicate` holds (the fake agent answers asynchronously). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake held-open ACP session (phase-C shape plus the phase-D re-attach
 *  seam: `awaitCurrentTurn`, mirroring the REAL acp-agents adapter's
 *  semantics — it resolves with a scripted loaded-turn outcome when one is
 *  set (the replay made the completed-while-down turn observable), and
 *  PARKS otherwise (the still-running-at-load case: the real adapter keeps
 *  the loaded session attached and waits for the turn's authoritative
 *  completion — reconcile arms the call on the seam and returns; the test
 *  resolves or rejects the parked seam to drive the outcome). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  /** The re-attach seam's parked loaded-turn completions (only used when
   *  no scripted outcome is set). */
  readonly loadedTurns: Array<{ resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  stopReason = 'end_turn';
  readonly completedTexts: string[] = [];
  /** The seam's scripted loaded-turn outcome (the real adapter reads it
   *  from the session/load replay + stream settling). Null parks the seam
   *  (still running at load). */
  loadedTurnTextValue: string | null = null;

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
    if (this.loadedTurnTextValue !== null) {
      // The loaded session's founding turn observably completed (its final
      // message is in the replay) — resolve immediately, like the real
      // adapter.
      return Promise.resolve({ stopReason: this.stopReason, text: this.loadedTurnTextValue });
    }
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
}

/** A fake runner with the phase-D loadSession seam. */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  readonly loadedWith: BrokerLoadSessionOptions[] = [];
  supportsSteering = true;
  /** The re-attach capability gate (acp-agents' supportsLoadSession). */
  supportsLoadSession = true;
  /** When true, loadSession returns sessions WITHOUT the awaitCurrentTurn
   *  seam (a third-party adapter whose loaded-turn completion is
   *  unobservable — the broker degrades to re-issue through the same
   *  honest gate). */
  seamless = false;
  /** The scripted loaded-turn outcome for loadSession-created sessions
   *  (the real adapter resolves the seam from the session/load replay).
   *  Null parks the seam (the still-running-at-load case). */
  loadedTurnText: string | null = null;
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
    session.loadedTurnTextValue = this.loadedTurnText;
    if (this.seamless) {
      // Shadow the prototype method with an own undefined property — the
      // broker's optional-seam probe sees a seam-less adapter.
      Object.defineProperty(session, 'awaitCurrentTurn', { value: undefined, configurable: true });
    }
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
  interruptHandler?: () => boolean;
} = {}) {
  const ws = await Workspace.create(PROJECT);
  const runner = options.runner ?? new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: options.store,
    snapshotSink: options.snapshotSink,
    maxConcurrentAgents: options.maxConcurrentAgents,
    interruptHandler: options.interruptHandler,
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
  // c2's loaded turn completed at the backend while we were down — its
  // final message is in the replayed transcript, so the seam observes it
  // DURING reconcile (the real adapter's semantics).
  runner2.loadedTurnText = 'result B (loaded)';
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

  // The re-attached call's loaded turn was observed during reconcile; the
  // next pump delivers it through the same record → settle → consume path
  // — the guest promise resolves exactly once, and the outcome is durable.
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
  runner2.loadedTurnText = 'loaded turn';
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
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
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
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reissued, ['c1', 'c2']);
  assert.deepEqual(report.failedLost, ['c3'], 'the over-cap re-issue was refused');
  assert.deepEqual(kinds, ['settlement'], 'the over-cap refusal settled the guest — its drain fired the boundary (review: refusals used to skip the changed-VM settlement boundary)');
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
  const runner2 = new FakeRunner();
  runner2.loadedTurnText = 'loaded turn';
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
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

// ────────────────────────────────────────────────────────────────────────
// Reconcile-time refusals and drain failures participate in the cadence
// ────────────────────────────────────────────────────────────────────────

test('cadence: a reconcile-time invalid-options refusal settles the guest and fires the settlement boundary', async () => {
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-badopts-'));
  const storePath = join(dir, 'calls.jsonl');

  // A foreign-style registry entry with an invalid options bag: park the
  // call with the PARKING bridge (no broker validation at dispatch), so
  // the snapshot carries a pending agent call whose options the restored
  // broker refuses at reconcile time.
  const ws = await Workspace.create(PROJECT);
  await ws.eval('const p = agent("pi/x", "task", { bogus: 1 }); "started"');
  assert.equal(ws.surface()!.pending().length, 1);
  const snapshot = ws.snapshot();
  ws.dispose();

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, {
    runner: new FakeRunner(),
    store: JsonlCallStore.open(storePath),
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.failedLost, ['c1'], 'the invalid options refused the re-issue');
  assert.deepEqual(kinds, ['settlement'], 'the refusal settled the guest — its drain fired the boundary (review: refusals used to skip the changed-VM settlement boundary)');
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some((l) => l.startsWith('warn: ') && l.includes('c1') && l.includes('invalid options')),
    output(probe).join('\n'),
  );
  // The refusal is durable and the guest call rejected (never re-issued).
  assert.equal(broker2.store().lookup('c1')!.completion!.outcome, 'reject');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0);
  const rejected = await broker2.eval('await p.catch((e) => e.message)');
  assert.ok(String(rejected.result).includes('unknown option'), String(rejected.result));
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('cadence: a changed-VM settlement drain that FAILS still fires the settlement boundary (reconcile and pump)', async () => {
  // The reconcile arm: the store-arm settlement changed the VM, the drain
  // runs the snapshot-carried continuation, and the continuation runs
  // away — interrupted by the broker-level handler. The boundary must
  // still fire: the settlements landed and the operation-end flush needs
  // the dirty boundary to persist them (review regression: an interrupted
  // drain used to skip the boundary entirely).
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-drainfail-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await broker.eval('const p = agent("pi/x", "t"); await p; let i = 0; while (true) i++; "unreachable"');
  await tick();
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, {
    runner: new FakeRunner(),
    store: JsonlCallStore.open(storePath),
    snapshotSink: sink,
    interruptHandler: () => true,
  });
  broker2.store().recordCompleted('c1', { outcome: 'resolve', value: 'while down', completedAtMs: Date.now() });
  await assert.rejects(
    () => broker2.reconcile(),
    (error: unknown) => (error as Error).name === 'DrainJobError',
  );
  assert.deepEqual(kinds, ['settlement'], 'the settlement boundary fired despite the failed drain');
  // The settlement itself is durable (the store write precedes the guest
  // settle) — a fresh restore settles it from the store arm.
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'while down');
  await broker2.dispose();
  ws2.dispose();

  // The pump's changed-VM drain failure fires its boundary too (the same
  // requirement on the standalone settlement path, pinned here). The
  // broker-level interrupt handler applies to the eval as well, so the
  // interrupted eval fires its own 'eval' boundary first.
  const kinds2: Array<'eval' | 'settlement'> = [];
  const sink2: SnapshotSink = { boundary: (kind) => kinds2.push(kind), flush: () => {} };
  const { ws: ws3, broker: broker3, runner: runner3 } = await setup({
    snapshotSink: sink2,
    runner: new FakeRunner(),
    interruptHandler: () => true,
  });
  await broker3.eval('const q = agent("pi/x", "t2"); q.then(() => { let j = 0; while (true) j++; }); "started"');
  await tick();
  runner3.last().completeTurn('final');
  await tick();
  await assert.rejects(
    () => broker3.pump(),
    (error: unknown) => (error as Error).name === 'DrainJobError',
  );
  assert.deepEqual(kinds2, ['eval', 'settlement'], 'the pump\'s settlement boundary fired despite the failed drain');
  await broker3.dispose();
  ws3.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// The re-attach arm through the REAL acp-agents adapter
// (a real AcpAgentRunner + InteractiveSession over the fake ACP agent)
// ────────────────────────────────────────────────────────────────────────

test('restore through the REAL acp-agents adapter: a completed-while-down call re-attaches and settles from the loaded session\'s replay (no re-issue)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-'));
  const storePath = join(dir, 'calls.jsonl');
  // The founding turn's completion is persisted at the backend (the fake
  // replays the user prompt + the turn's final message on session/load,
  // exactly like a real agent replays its stored conversation).
  configureFakeAgent(
    {
      loadSessionSupport: true,
      turns: [{ text: 'initial' }],
      loadSession: {
        replay: [
          { role: 'user', text: 'task' },
          { role: 'assistant', text: 'result B (loaded)' },
        ],
      },
    },
    join(dir, 'log1.jsonl'),
  );
  const runner = new AcpAgentRunner();
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
  try {
    // Dispatch one call; the founding turn is in flight when we crash.
    const r = await broker.eval('const p = agent("fake/x", "task"); "started"');
    assert.equal(r.result, '"started"');
    assert.deepEqual(broker.pendingCalls().map((e) => e.id), ['c1']);
    // The re-attach key: the REAL backend session id recorded at open
    // (the real runner's openSession is async — spawn + initialize).
    await waitFor(() => broker.store().lookup('c1')!.sessionId !== null);
    const recordedId = broker.store().lookup('c1')!.sessionId!;
    assert.ok(recordedId.startsWith('fake-session-'), recordedId);
    // Snapshot the live VM and crash before any pump settles the call.
    const snapshot = ws.snapshot();
    await broker.dispose();
    ws.dispose();

    // Restore with a FRESH real runner over the same store; the backend
    // serves session/load from its persisted transcript.
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'initial' }],
        loadSession: {
          replay: [
            { role: 'user', text: 'task' },
            { role: 'assistant', text: 'result B (loaded)' },
          ],
        },
      },
      join(dir, 'log2.jsonl'),
    );
    const runner2 = new AcpAgentRunner();
    const ws2 = await Workspace.restore(PROJECT, snapshot);
    const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
    try {
      const report = await broker2.reconcile();
      assert.deepEqual(report.reattached, ['c1'], 'the call re-attached through the real adapter');
      assert.deepEqual(report.reissued, []);
      assert.deepEqual(report.failedLost, []);
      // The wire evidence: the restored process LOADED the recorded
      // session id and never opened a fresh session (no re-issue).
      const entries = readWireLog(join(dir, 'log2.jsonl'));
      const pids = [...new Set(entries.filter((e) => e.method === '__start').map((e) => e.pid))];
      assert.equal(pids.length, 1, 'exactly one backend process');
      const byPid = entries.filter((e) => e.pid === pids[0]);
      assert.ok(
        byPid.some((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId),
        JSON.stringify(byPid),
      );
      assert.ok(!byPid.some((e) => e.method === 'newSession'), 'no fresh session — the call was NOT re-issued');
      // The re-attached call settles with the loaded turn's real outcome,
      // exactly once, and the store is authoritative. The seam's stream-
      // settled wait is bounded by the settle grace, so the settlement
      // lands a moment after reconcile — poll for it like a live call.
      let settled: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
        if (got.result !== undefined) {
          settled = got.result;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(settled, '"result B (loaded)"');
      assert.equal(broker2.store().lookup('c1')!.completion!.value, 'result B (loaded)');
      assert.equal(broker2.store().lookup('c1')!.reissues, 0, 're-attachment is not a re-issue');
    } finally {
      await broker2.dispose();
      ws2.dispose();
      await runner2.dispose();
    }
  } finally {
    await runner.dispose();
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter: a founding turn still in flight at the backend is KEPT ATTACHED and settles from its live completion (no re-issue)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-run-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevGrace = process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS = '100';
  try {
    // The replay ends at the founding turn's user message, and the backend
    // CONTINUES streaming live chunks AFTER the session/load response —
    // the turn is still running at the backend when we reconnect. The
    // seam keeps the loaded session attached and settles from the turn's
    // authoritative completion (phase-D review: this case used to be
    // released and re-issued, risking duplicated work).
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: {
          replay: [{ role: 'user', text: 'task' }],
          continue: [
            { afterMs: 50, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
            { afterMs: 100, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } } },
          ],
        },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("fake/x", "task"); "started"');
      await waitFor(() => broker.store().lookup('c1')!.sessionId !== null);
      const recordedId = broker.store().lookup('c1')!.sessionId!;
      const snapshot = ws.snapshot();
      await broker.dispose();
      ws.dispose();

      configureFakeAgent(
        {
          loadSessionSupport: true,
          turns: [{ text: 'fresh result' }],
          loadSession: {
            replay: [{ role: 'user', text: 'task' }],
            continue: [
              { afterMs: 50, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
              { afterMs: 100, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } } },
            ],
          },
        },
        join(dir, 'log2.jsonl'),
      );
      const runner2 = new AcpAgentRunner();
      const ws2 = await Workspace.restore(PROJECT, snapshot);
      const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
      try {
        // Reconcile returns IMMEDIATELY (it arms the call on the seam
        // instead of blocking on the still-running turn) and reports the
        // call as re-attached — never re-issued.
        const report = await broker2.reconcile();
        assert.deepEqual(report.reattached, ['c1'], 'the still-running turn stays attached');
        assert.deepEqual(report.reissued, [], 'no re-issue — the loaded session is kept');
        assert.deepEqual(report.failedLost, []);
        // Wire evidence: the restored process LOADED the recorded session
        // and never opened a fresh session (no re-issue, no duplicated
        // work).
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          entries.some((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId),
          JSON.stringify(entries),
        );
        assert.ok(!entries.some((e) => e.method === 'newSession'), 'no fresh session — the call was NOT re-issued');
        // The call settles with the turn's AUTHORITATIVE completion — the
        // live stream's full accumulated text, delivered through the same
        // pump as a live call (reconcile's arming does not block it; the
        // seam settles once the stream goes quiet after the last chunk).
        // The first poll eval also carries the re-attach info line (the
        // guest-visible surfacing).
        let resolved: string | undefined;
        let sawReattachLine = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
          if (!sawReattachLine) {
            sawReattachLine = output(got).some((l) => l.startsWith('info: ') && l.includes('c1') && l.includes('re-attached'));
          }
          if (got.result !== undefined) {
            resolved = got.result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(resolved, '"live result"');
        assert.equal(broker2.store().lookup('c1')!.completion!.value, 'live result');
        assert.equal(broker2.store().lookup('c1')!.reissues, 0, 're-attachment is not a re-issue');
        assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId, 'the same backend session stays attached');
        assert.ok(sawReattachLine, 'the re-attach info line surfaced guest-visibly');
      } finally {
        await broker2.dispose();
        ws2.dispose();
        await runner2.dispose();
      }
    } finally {
      await broker.dispose();
      ws.dispose();
      await runner.dispose();
    }
  } finally {
    if (prevGrace === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS = prevGrace;
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter: a still-attached turn whose completion never becomes observable degrades to re-issue, surfaced guest-visibly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-expire-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevGrace = process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS;
  const prevMax = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS = '50';
  process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = '150';
  try {
    // The replay ends at the founding turn's user message and NOTHING
    // continues after the load response (the turn died silently at the
    // backend, or the backend never streams after load): the seam's
    // max-wait backstop rejects, the loaded session is released, and the
    // call is re-issued under the same id — the honest fallback for a
    // genuinely unobservable outcome, surfaced guest-visibly.
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: { replay: [{ role: 'user', text: 'task' }] },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("fake/x", "task"); "started"');
      await waitFor(() => broker.store().lookup('c1')!.sessionId !== null);
      const recordedId = broker.store().lookup('c1')!.sessionId!;
      const snapshot = ws.snapshot();
      await broker.dispose();
      ws.dispose();

      configureFakeAgent(
        {
          loadSessionSupport: true,
          turns: [{ text: 'fresh result' }],
          loadSession: { replay: [{ role: 'user', text: 'task' }] },
        },
        join(dir, 'log2.jsonl'),
      );
      const runner2 = new AcpAgentRunner();
      const ws2 = await Workspace.restore(PROJECT, snapshot);
      const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
      try {
        const report = await broker2.reconcile();
        assert.deepEqual(report.reattached, ['c1'], 'the call is armed on the loaded session first');
        assert.deepEqual(report.reissued, [], 'the in-task degradation is not part of the reconcile report');
        // The in-task re-issue opens a fresh session (the seam's max-wait
        // expiry is bounded — wait for the fresh session to log).
        await waitFor(() =>
          readWireLog(join(dir, 'log2.jsonl')).some((e) => e.method === 'newSession'),
        );
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          entries.some((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId),
          JSON.stringify(entries),
        );
        assert.ok(entries.some((e) => e.method === 'newSession'), 'the re-issue opened a fresh session');
        // The degradation is surfaced guest-visibly, naming the condition.
        const probe = await broker2.eval('"probe"');
        assert.ok(
          output(probe).some(
            (l) =>
              l.startsWith('warn: ') &&
              l.includes('c1') &&
              l.includes('never reached a terminal assistant message') &&
              l.includes('re-issued'),
          ),
          output(probe).join('\n'),
        );
        // The re-issued call's fresh turn completes and settles the SAME
        // guest promise exactly once.
        await waitFor(() => broker2.store().lookup('c1')!.sessionId !== recordedId);
        let result: string | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          await broker2.pump();
          const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
          if (got.result !== undefined) {
            result = got.result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(result, '"fresh result"');
        assert.equal(broker2.store().lookup('c1')!.reissues, 1);
      } finally {
        await broker2.dispose();
        ws2.dispose();
        await runner2.dispose();
      }
    } finally {
      await broker.dispose();
      ws.dispose();
      await runner.dispose();
    }
  } finally {
    if (prevGrace === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_SETTLE_GRACE_MS = prevGrace;
    if (prevMax === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = prevMax;
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a still-running-at-load call stays attached: reconcile arms it on the parked seam and the call settles from the turn\'s later completion (never a re-issue)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-still-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const recordedId = broker.store().lookup('c1')!.sessionId!;
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  // No scripted loaded-turn outcome: the seam parks — the founding turn is
  // still running at the backend (live chunks keep streaming after the
  // load response).
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, ['c1'], 'the still-running call is re-attached and KEPT attached');
  assert.deepEqual(report.reissued, [], 'never a re-issue while the loaded session is attached');
  assert.deepEqual(report.failedLost, []);
  assert.equal(runner2.loadedWith.length, 1);
  assert.equal(
    runner2.loadedWith[0].sessionId,
    recordedId,
    'the load was addressed at the RECORDED backend session (the fake mints a fresh id per load, the real adapter keeps the loaded id)',
  );
  // The call is still pending — the seam observes the turn's completion.
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c1']);
  // The backend finishes the turn: the parked seam resolves with the real
  // accumulated text, the pump delivers it, and the guest settles exactly
  // once — no duplicate dispatch ever happened.
  const parked = runner2.sessions[0].loadedTurns.shift();
  assert.ok(parked, 'the seam is parked on the loaded session');
  parked.resolve({ stopReason: 'end_turn', text: 'completed live' });
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, '"completed live"');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'completed live');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'kept attached — no re-issue');
  assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a seam rejection degrades to re-issue inside the task: the loaded session is released and the fresh turn settles the SAME guest promise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-seamreject-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const recordedId = broker.store().lookup('c1')!.sessionId!;
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, ['c1'], 'armed on the loaded session first');
  assert.deepEqual(report.reissued, [], 'the in-task degradation is not part of the reconcile report');
  // The seam rejects — the founding turn's outcome is genuinely
  // unobservable (e.g. the stream settled without a terminal assistant
  // message within the max-wait bound).
  const parked = runner2.sessions[0].loadedTurns.shift();
  assert.ok(parked, 'the seam is parked on the loaded session');
  parked.reject(new Error('the loaded session\'s founding turn never reached a terminal assistant message'));
  await tick();
  await tick();
  // The loaded session was released and a FRESH session opened for the
  // re-issue; the store bumped the reissues counter.
  assert.equal(runner2.sessions[0].releases, 1, 'the loaded session was released');
  assert.equal(runner2.sessions.length, 2, 'a fresh session opened for the re-issue');
  assert.equal(broker2.store().lookup('c1')!.reissues, 1);
  assert.equal(broker2.store().lookup('c1')!.sessionId, runner2.sessions[1].sessionId, 'the re-issue\'s session is the new attach key');
  // The degradation is surfaced guest-visibly, naming the reason.
  const probe = await broker2.eval('"probe"');
  assert.ok(
    output(probe).some(
      (l) => l.startsWith('warn: ') && l.includes('c1') && l.includes('re-issued') && l.includes('released'),
    ),
    output(probe).join('\n'),
  );
  // The re-issued call's fresh turn completes and settles the SAME guest
  // promise exactly once.
  runner2.sessions[1].completeTurn('fresh result');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, '"fresh result"');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'fresh result');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// The re-issue branches' refusal cadence (phase-D review round 2)
// ────────────────────────────────────────────────────────────────────────

test('cadence: a no-recorded-session re-issue refused by the cap settles the guest and fires the settlement boundary', async () => {
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-nosess-'));
  const storePath = join(dir, 'calls.jsonl');

  // Two pending agent calls with NO recorded backend session (parked with
  // the parking bridge — the store never saw them; reconcile adopts them,
  // the sessionId stays null → the re-issue arm). The restored broker runs
  // cap=1: the first re-issue takes the slot, the second is REFUSED — the
  // refusal settles the guest, so its drain must fire the settlement
  // boundary (review regression: this branch used to drop the newly-settled
  // flag, skipping the drain and the snapshot boundary).
  const ws = await Workspace.create(PROJECT);
  await ws.eval('const p1 = agent("pi/x", "t1"); const p2 = agent("pi/y", "t2"); "started"');
  assert.equal(ws.surface()!.pending().length, 2);
  const snapshot = ws.snapshot();
  ws.dispose();

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, {
    runner: new FakeRunner(),
    store: JsonlCallStore.open(storePath),
    maxConcurrentAgents: 1,
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reissued, ['c1']);
  assert.deepEqual(report.failedLost, ['c2'], 'the over-cap re-issue was refused');
  assert.deepEqual(kinds, ['settlement'], 'the refusal settled the guest — its drain fired the boundary');
  const record = broker2.store().lookup('c2')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('cadence: an adapter-without-seam re-issue refused by the cap settles the guest and fires the settlement boundary', async () => {
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-noseam-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await broker.eval('const p1 = agent("pi/x", "t1"); const p2 = agent("pi/y", "t2"); "started"');
  await tick();
  assert.equal(runner.sessions.length, 2);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  runner2.seamless = true; // a third-party adapter: loads fine, no completion seam
  const broker2 = await Broker.attach(ws2, {
    runner: runner2,
    store: JsonlCallStore.open(storePath),
    maxConcurrentAgents: 1,
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, []);
  assert.deepEqual(report.reissued, ['c1']);
  assert.deepEqual(report.failedLost, ['c2'], 'the over-cap re-issue was refused');
  assert.equal(runner2.loadedWith.length, 2, 'both sessions loaded — the seam absence is discovered after a successful load');
  assert.equal(runner2.sessions[0].releases, 1, 'the loaded session was released before the re-issue');
  assert.deepEqual(kinds, ['settlement'], 'the refusal settled the guest — its drain fired the boundary');
  const record = broker2.store().lookup('c2')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});
