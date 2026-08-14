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

import { AcpAgentRunner, LoadedTurnFailedError, LoadedTurnStillRunningError } from '@automatalabs/acp-agents';

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
  /** The session-level loaded-turn terminal state (the real adapter's
   *  `loadedTurnEndedState` — the `_session/loaded_turn/ended`
   *  notification a seam-less backend pushes anyway). Null until
   *  `fireLoadedTurnEnded`. */
  endedState: { stopReason?: string; error?: { name: string; message: string } } | null = null;
  private readonly endedWatchers = new Set<() => void>();
  /** The `released()` watch (the real adapter's release promise). */
  private releasedWatchers: Array<() => void> = [];
  private releasedFlag = false;
  stopReason = 'end_turn';
  readonly completedTexts: string[] = [];
  /** The seam's scripted loaded-turn outcome (the real adapter reads it
   *  from the session/load replay + stream settling). Null parks the seam
   *  (still running at load). */
  loadedTurnTextValue: string | null = null;
  /** A hung cancel (the drain-bound regression: the post-deadline cancel
   *  await must not block disconnect past the bound). */
  hangCancel = false;
  /** A hung release (same regression for the release phase). */
  hangRelease = false;
  /** Cancel invocations (the mid-drain-abort regression: an aborted
   *  drain must never cancel anything). */
  cancelCalls = 0;

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
    this.cancelCalls++;
    if (this.hangCancel) return new Promise(() => {});
    for (const pending of this.prompts.splice(0)) {
      pending.resolve({ stopReason: 'cancelled', text: '' });
    }
    return Promise.resolve();
  }

  loadedTurnEndedState(): { stopReason?: string; error?: { name: string; message: string } } | null {
    return this.endedState;
  }

  subscribeLoadedTurnEnded(listener: () => void): () => void {
    if (this.endedState !== null) {
      queueMicrotask(listener);
      return () => {};
    }
    this.endedWatchers.add(listener);
    return () => {
      this.endedWatchers.delete(listener);
    };
  }

  /** Drive the session-level ended notification (the test's handle for
   *  the non-re-armable wait's observability surface). */
  fireLoadedTurnEnded(state: { stopReason?: string; error?: { name: string; message: string } }, text?: string): void {
    this.endedState = state;
    if (text !== undefined) this.completedTexts.push(text);
    for (const watcher of [...this.endedWatchers]) watcher();
  }

  released(): Promise<void> {
    if (this.releasedFlag) return Promise.resolve();
    return new Promise((resolve) => {
      if (this.releasedFlag) {
        resolve();
        return;
      }
      this.releasedWatchers.push(resolve);
    });
  }

  release(): Promise<void> {
    this.releases++;
    if (this.hangRelease) return new Promise(() => {});
    this.releasedFlag = true;
    for (const watcher of this.releasedWatchers.splice(0)) watcher();
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

  listBackends(): string[] {
    return ['claude', 'codex', 'opencode', 'pi'];
  }

  defaultBackendId(): string {
    return 'claude';
  }

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
  evalTimeoutMs?: number;
} = {}) {
  const ws = await Workspace.create(PROJECT);
  const runner = options.runner ?? new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: options.store,
    snapshotSink: options.snapshotSink,
    maxConcurrentAgents: options.maxConcurrentAgents,
    interruptHandler: options.interruptHandler,
    evalTimeoutMs: options.evalTimeoutMs,
  });
  return { ws, broker, runner };
}

function output(r: ReplEvalResult): string[] {
  return r.output;
}

/** §6.2: the re-attach / re-issue / refusal / lost-steer surfacing lines
 *  demote to workspace().diagnostics.reconcileNotes — read them through
 *  the guest introspection surface. */
async function reconcileNotesOf(broker: Broker): Promise<Array<{ level: string; line: string; atMs: number }>> {
  const r = await broker.eval('JSON.stringify(workspace().diagnostics.reconcileNotes)');
  assert.equal(r.kind, 'value', 'the diagnostics read resolved');
  return JSON.parse(r.result ?? '[]') as Array<{ level: string; line: string; atMs: number }>;
}

/** Dispatch one agent call and wait until its session is open. */
async function dispatchAgent(broker: Broker, runner: FakeRunner, code = 'const p = agent("pi/x", "task"); "started"') {
  const r = await broker.eval(code);
  assert.equal(r.result, 'started', JSON.stringify(r));
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
  assert.equal(r.result, 'started');
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

  // Guest-visible surfacing (§6.2): the re-attach info line and the
  // re-issue warn line leave the eval result surface entirely — they
  // are retained under workspace().diagnostics.reconcileNotes with the
  // reconcile summary (only the [C]14 LOSS notice may ride an eval's
  // output).
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'ordinary reconciliation never rides the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.level === 'info' && n.line.includes('c2') && n.line.includes('re-attached')),
    JSON.stringify(notes),
  );
  assert.ok(
    notes.some(
      (n) => n.level === 'warn' && n.line.includes('c3') && n.line.includes('re-issued') && n.line.includes('session not found'),
    ),
    JSON.stringify(notes),
  );
  assert.equal((await broker2.eval('await a')).result, 'result A', 'the store arm settled c1 exactly once');

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
  assert.equal((await broker2.eval('await b')).result, 'result B (loaded)');
  assert.equal(broker2.store().lookup('c2')!.completion!.value, 'result B (loaded)');

  // The re-issued call's fresh turn completes → the SAME guest promise
  // resolves (never a duplicate), and the store's session id now points
  // at the re-issue's new session (a later restore re-attaches THAT one).
  runner2.sessions[1].completeTurn('result C (re-issued)');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await c')).result, 'result C (re-issued)');
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

  // The re-issued call completes normally; the guest sees the result,
  // and the capability-degradation line demotes to diagnostics (§6.2).
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.line.includes('c1') && n.line.includes('loadSession') && n.line.includes('re-issued')),
    JSON.stringify(notes),
  );
  runner2.sessions[0].completeTurn('custom backend result');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, 'custom backend result');
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
  assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.line.includes('not resumable') && n.line.includes('session not found')),
    JSON.stringify(notes),
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

test('re-issues respect the concurrency cap: an over-cap re-issue QUEUES in dispatch order for the next free slot — never a rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-capq-'));
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
  // re-issues fit, the third QUEUES — it stays PENDING in the guest
  // registry (never a ConcurrencyLimitError rejection) and dispatches in
  // dispatch order the moment a slot frees (§4.1 queue-above-cap).
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
  assert.deepEqual(report.reissued, ['c1', 'c2', 'c3'], 'the over-cap re-issue QUEUED (reported re-issued, never failed-lost)');
  assert.deepEqual(report.failedLost, []);
  assert.deepEqual(kinds, [], 'queueing settles nothing — no settlement boundary');
  const pending = await broker2.eval('"probe"');
  assert.ok(pending.pending.includes('c3'), 'the queued re-issue stays PENDING in the guest registry');
  // The store records no completion for c3 — it was never rejected.
  assert.equal(broker2.store().lookup('c3')!.completion, null);
  // A slot frees (c1's re-issue settles) and the queued re-issue
  // dispatches IN ORDER for the free slot.
  runner2.sessions[0].completeTurn('done-1');
  await tick();
  await broker2.pump();
  await tick();
  assert.equal(runner2.sessions.length, 3, 'the queued re-issue opened a fresh session once a slot freed');
  assert.equal(broker2.store().lookup('c3')!.reissues, 1);
  // c3's guest promise is still the same one — it settles from the
  // re-issued turn's answer.
  runner2.sessions[2].completeTurn('done-3');
  await tick();
  await broker2.pump();
  const c3 = await broker2.eval('await p3');
  assert.equal(c3.result, 'done-3');
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
  assert.equal(listed.checkpoints[0].question, 'What color?');

  // The answer settles the RESTORED checkpoint (no live GuestCall —
  // through the reconciliation surface), exactly once.
  const answered = await broker2.eval('checkpoint.answer("c1", "blue"); "delivered"');
  assert.equal(answered.result, 'delivered');
  assert.equal((await broker2.eval('await q')).result, 'blue');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'blue');
  // A second answer reports false (first-wins).
  assert.equal((await broker2.eval('checkpoint.answer("c1", "again")')).result, 'false');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a steer whose wire call died with the process resolves the honest failed, demoted to diagnostics (§6.2)', async () => {
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
  assert.deepEqual(output(probe), [], 'the lost-steer line demotes to diagnostics — never an eval output line');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.level === 'warn' && n.line.includes('c2') && n.line.includes('unknowable')),
    JSON.stringify(notes),
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
  assert.equal(resumed.result, 'resolved:second');
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
  assert.equal((await broker3.eval('await q')).result, 'while down');
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
  assert.equal(r.result, 'resolved:result');
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
  assert.deepEqual(output(probe), [], 'the refusal line demotes to diagnostics — never an eval output line');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.level === 'warn' && n.line.includes('c1') && n.line.includes('invalid options')),
    JSON.stringify(notes),
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

test('cadence: a changed-VM settlement drain that FAILS still fires the settlement boundary, and the reconcile drain failure DEMOTES to workspace().diagnostics (reconcile and pump)', async () => {
  // The reconcile arm: the store-arm settlement changed the VM, the drain
  // runs the snapshot-carried continuation, and the continuation runs
  // away — interrupted by the broker-level handler. The boundary must
  // still fire: the settlements landed and the operation-end flush needs
  // the dirty boundary to persist them (review regression: an interrupted
  // drain used to skip the boundary entirely). The DrainJobError itself
  // DEMOTES (§6.2): the settlements landed and will persist — nothing
  // was lost — so the reconcile RESOLVES with its report (the first
  // touch never fails outside the eval result contract), the failure is
  // retained under workspace().diagnostics.drainError, and it never
  // rides the next eval's output surface.
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
  const report = await broker2.reconcile();
  assert.deepEqual(report.failedLost, [], 'the store arm settled the call — nothing was lost');
  assert.deepEqual(kinds, ['settlement'], 'the settlement boundary fired despite the failed drain');
  // The settlement itself is durable (the store write precedes the guest
  // settle) — a fresh restore settles it from the store arm.
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'while down');
  // §6.2: the interrupted reconcile drain is RETAINED under
  // workspace().diagnostics.drainError — never a reconcile rejection,
  // never an eval output line.
  const diag = await broker2.eval(
    'workspace().diagnostics.drainError === null ? "null" : workspace().diagnostics.drainError.name + ":" + workspace().diagnostics.drainError.message',
  );
  assert.ok(String(diag.result).startsWith('InternalError:'), String(diag.result));
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'the reconcile drain failure never rides the eval output surface');
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
        // The _session/loaded_turn extension's authoritative answer: the
        // founding turn completed while down — the replay's trailing
        // assistant message is its FINAL message.
        loadedTurn: { status: 'completed' },
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
    const r = await broker.eval('const p = agent("claude/x", "task"); "started"');
    assert.equal(r.result, 'started');
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
          loadedTurn: { status: 'completed' },
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
      if (JSON.stringify(report.reattached) !== JSON.stringify(['c1'])) {
        throw new Error('REPORTPROBE ' + JSON.stringify(report));
      }
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
      assert.equal(settled, 'result B (loaded)');
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

test('restore through the REAL acp-agents adapter: a founding turn still in flight at the backend is KEPT ATTACHED and settles from the authoritative _session/loaded_turn/ended notification — partial output is never settled from a quiet gap, and the still-running turn is never re-issued (duplicated work)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-run-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevMax = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = '2000';
  try {
    // The replay ends at the founding turn's user message, and the backend
    // CONTINUES streaming live chunks AFTER the session/load response —
    // the turn is still running at the backend when we reconnect (the
    // extension's query answers `running`). The seam keeps the loaded
    // session attached (phase-D review: this case used to be released and
    // re-issued immediately, risking duplicated work) and NEVER settles
    // from a quiet gap: the turn's completion is the AUTHORITATIVE
    // `_session/loaded_turn/ended` notification (phase-D review round 3:
    // the quiet-grace heuristic and the blind re-issue were both rejected
    // — a restored transcript ending in an assistant partial used to be
    // durably settled as a completed-while-down turn when the next live
    // chunk arrived later, and a still-running backend turn used to be
    // re-issued). The call settles with the turn's REAL accumulated text
    // at the notification — never the partial, never a duplicate issue.
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: {
          loadedTurn: { status: 'running' },
          replay: [{ role: 'user', text: 'task' }],
          continue: [
            { afterMs: 50, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
            { afterMs: 120, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } },
          ],
          turnEnded: { afterMs: 250, stopReason: 'end_turn' },
        },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("claude/x", "task"); "started"');
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
            loadedTurn: { status: 'running' },
            replay: [{ role: 'user', text: 'task' }],
            continue: [
              { afterMs: 50, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
              { afterMs: 120, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } },
            ],
            turnEnded: { afterMs: 250, stopReason: 'end_turn' },
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
        // call as re-attached — never re-issued while the turn may still
        // be running.
        const report = await broker2.reconcile();
        assert.deepEqual(report.reattached, ['c1'], 'the still-running turn stays attached');
        assert.deepEqual(report.reissued, [], 'no re-issue while the seam waits');
        assert.deepEqual(report.failedLost, []);
        // Wire evidence: the restored process LOADED the recorded session
        // and has not opened a fresh session — and never will (the live
        // turn settles from its authoritative terminal notification).
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          entries.some((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId),
          JSON.stringify(entries),
        );
        // The seam's authoritative query fires asynchronously (reconcile
        // arms the task and returns) — wait for it on the wire.
        await waitFor(() =>
          readWireLog(join(dir, 'log2.jsonl')).some(
            (e) => e.method === 'extensionRequest' && e.extensionMethod === '_session/loaded_turn/query',
          ),
        );
        // The turn's real accumulated text settles the call exactly once —
        // from the authoritative ended notification (the round-3
        // regression: the old seam settled the pause as completion,
        // durably recording "live partial" as the call's outcome BEFORE
        // the notification, or re-issued the still-running turn).
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
        assert.equal(result, 'live partial', 'the authoritative completion is the turn\'s REAL accumulated text');
        assert.equal(broker2.store().lookup('c1')!.completion!.value, 'live partial');
        assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'the still-running turn was never re-issued');
        assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId, 'the call settled on the SAME backend session');
        const after = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          !after.some((e) => e.method === 'newSession'),
          'no fresh session was ever opened — the still-running turn was kept attached, never duplicated: ' + JSON.stringify(after),
        );
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
    if (prevMax === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = prevMax;
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter: a founding turn that ended without a terminal message (interrupted while down) degrades to re-issue IMMEDIATELY — the extension answer makes nothing-is-running authoritative', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-expire-'));
  const storePath = join(dir, 'calls.jsonl');
  try {
    // The replay ends at the founding turn's user message and the backend
    // answers the extension's query `interrupted`: no turn is running at
    // the backend, and the founding turn ended without a terminal
    // assistant message while the host was down. Its outcome is not
    // observable — but nothing is running, so the seam rejects with the
    // SAFE-RE-ISSUE class immediately (no max-wait backstop needed) and
    // the broker re-issues under the same id, surfaced guest-visibly.
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: {
          loadedTurn: { status: 'interrupted' },
          replay: [{ role: 'user', text: 'task' }],
        },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("claude/x", "task"); "started"');
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
            loadedTurn: { status: 'interrupted' },
            replay: [{ role: 'user', text: 'task' }],
          },
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
        // The in-task re-issue opens a fresh session immediately (the
        // `interrupted` answer is authoritative — no max-wait).
        await waitFor(() =>
          readWireLog(join(dir, 'log2.jsonl')).some((e) => e.method === 'newSession'),
        );
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          entries.some((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId),
          JSON.stringify(entries),
        );
        assert.ok(
          entries.some((e) => e.method === 'extensionRequest' && e.extensionMethod === '_session/loaded_turn/query'),
          JSON.stringify(entries),
        );
        assert.ok(entries.some((e) => e.method === 'newSession'), 'the re-issue opened a fresh session');
        // The degradation demotes to diagnostics (§6.2), naming the condition.
        const probe = await broker2.eval('"probe"');
        assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
        const notes = await reconcileNotesOf(broker2);
        assert.ok(
          notes.some(
            (n) =>
              n.line.includes('c1') &&
              n.line.includes('ended without a terminal assistant message') &&
              n.line.includes('re-issued'),
          ),
          JSON.stringify(notes),
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
        assert.equal(result, 'fresh result');
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
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter WITHOUT the _session/loaded_turn extension: the observation path classifies a completed-while-down turn from the replay (trailing assistant message, no live continuation) and settles from the loaded session — never a re-issue (phase-F review round 2: the seam-less built-ins\' terminal state is authoritative under the connection-death contract — their ACP servers terminate in-flight turns when the client connection closes, and the replay holds only completed messages)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-seamless-completed-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevObserve = process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = '120';
  try {
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'initial' }],
        loadSession: {
          // NO `loadedTurn` / `turnEnded` / `loadedTurnQueryError`: the
          // backend does NOT advertise the extension — the seam-less
          // observation path classifies the founding turn.
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
      await broker.eval('const p = agent("claude/x", "task"); "started"');
      await waitFor(() => broker.store().lookup('c1')!.sessionId !== null);
      const recordedId = broker.store().lookup('c1')!.sessionId!;
      const snapshot = ws.snapshot();
      await broker.dispose();
      ws.dispose();

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
        // The observation path never asks the extension query on the wire
        // (there is nothing to ask — the backend did not advertise it).
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(
          !readWireLog(join(dir, 'log2.jsonl')).some(
            (e) => e.method === 'extensionRequest' && e.extensionMethod === '_session/loaded_turn/query',
          ),
          'no extension query — the observation path classifies from the replay + stream',
        );
        // The completed-while-down classification settles the call with
        // the loaded turn's real outcome (after the observation window),
        // exactly once — never a re-issue.
        let settled: string | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
          if (got.result !== undefined) {
            settled = got.result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(settled, 'result B (loaded)');
        assert.equal(broker2.store().lookup('c1')!.completion!.value, 'result B (loaded)');
        assert.equal(broker2.store().lookup('c1')!.reissues, 0, 're-attachment is not a re-issue');
        assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId, 'settled on the SAME loaded session');
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(!entries.some((e) => e.method === 'newSession'), 'no fresh session — the call was NOT re-issued');
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
    if (prevObserve === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = prevObserve;
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter WITHOUT the extension: a replay that ends without a terminal assistant message (the turn died mid-way while down) is the INTERRUPTED classification — nothing is running at the backend (the connection-death contract), so the in-task degradation re-issues under the same id, surfaced guest-visibly, and no duplication is possible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-seamless-interrupted-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevObserve = process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = '120';
  try {
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: {
          replay: [{ role: 'user', text: 'task' }],
        },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("claude/x", "task"); "started"');
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
          },
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
        // The interrupted classification (nothing running) degrades to a
        // re-issue after the observation window — surfaced guest-visibly.
        await waitFor(() =>
          readWireLog(join(dir, 'log2.jsonl')).some((e) => e.method === 'newSession'),
        );
        assert.ok(
          !readWireLog(join(dir, 'log2.jsonl')).some(
            (e) => e.method === 'extensionRequest' && e.extensionMethod === '_session/loaded_turn/query',
          ),
          'no extension query — the observation path classifies from the replay + stream',
        );
        const probe = await broker2.eval('"probe"');
        assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
        const notes = await reconcileNotesOf(broker2);
        assert.ok(
          notes.some(
            (n) =>
              n.line.includes('c1') &&
              n.line.includes('without a terminal assistant message') &&
              n.line.includes('re-issue'),
          ),
          JSON.stringify(notes),
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
        assert.equal(result, 'fresh result');
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
    if (prevObserve === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = prevObserve;
    clearFakeEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore through the REAL acp-agents adapter WITHOUT the extension: live continuation within the observation window classifies the founding turn STILL RUNNING — the loaded session stays attached and the call is never re-issued, across the re-armable bound (phase-F review round 2: a possibly-running call is never duplicated)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-real-seamless-running-'));
  const storePath = join(dir, 'calls.jsonl');
  const prevObserve = process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
  const prevMax = process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS;
  process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = '120';
  process.env.AGENTPRISM_ACP_LOADED_TURN_MAX_WAIT_MS = '200';
  try {
    configureFakeAgent(
      {
        loadSessionSupport: true,
        turns: [{ text: 'fresh result' }],
        loadSession: {
          // The replay ends at an assistant PARTIAL, and the backend
          // CONTINUES streaming live chunks after the session/load
          // response — the turn is still running at the backend when we
          // reconnect. WITHOUT the extension, the observation path sees
          // the live continuation within its window and classifies the
          // turn STILL RUNNING: the seam keeps the loaded session
          // attached (never settles the quiet gap, never re-issues), and
          // the re-armable bound keeps the wait live.
          replay: [
            { role: 'user', text: 'task' },
            { role: 'assistant', text: 'partial ' },
          ],
          continue: [
            { afterMs: 40, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
            { afterMs: 90, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continuation' } } },
          ],
        },
      },
      join(dir, 'log1.jsonl'),
    );
    const runner = new AcpAgentRunner();
    const ws = await Workspace.create(PROJECT);
    const broker = await Broker.attach(ws, { runner, store: JsonlCallStore.open(storePath) });
    try {
      await broker.eval('const p = agent("claude/x", "task"); "started"');
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
            replay: [
              { role: 'user', text: 'task' },
              { role: 'assistant', text: 'partial ' },
            ],
            continue: [
              { afterMs: 40, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live ' } } },
              { afterMs: 90, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'continuation' } } },
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
        assert.deepEqual(report.reattached, ['c1'], 'the still-running call is re-attached and KEPT attached');
        assert.deepEqual(report.reissued, [], 'never a re-issue while the loaded session is attached');
        assert.deepEqual(report.failedLost, []);
        // Across the observation window AND two max-wait re-arm cycles:
        // the call stays pending on the SAME loaded session — no fresh
        // session is ever opened, and the partial is never settled.
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c1'], 'the call is still pending — the partial was never settled');
        const entries = readWireLog(join(dir, 'log2.jsonl'));
        assert.ok(
          !entries.some((e) => e.method === 'newSession'),
          'no fresh session across the re-arm cycles — a possibly-running call is never duplicated: ' + JSON.stringify(entries),
        );
        assert.equal(
          entries.filter((e) => e.method === 'loadSession' && e.params?.sessionId === recordedId).length,
          1,
          'the recorded session was loaded exactly once — the re-arms ride the SAME attached session',
        );
        assert.ok(
          !readWireLog(join(dir, 'log2.jsonl')).some(
            (e) => e.method === 'extensionRequest' && e.extensionMethod === '_session/loaded_turn/query',
          ),
          'no extension query — the observation path classifies from the replay + stream',
        );
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
    if (prevObserve === undefined) delete process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS;
    else process.env.AGENTPRISM_ACP_LOADED_TURN_OBSERVE_MS = prevObserve;
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
  assert.equal((await broker2.eval('await p')).result, 'completed live');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'completed live');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'kept attached — no re-issue');
  assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a restored turn failure rejects with its resolved backend attribution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-turn-failed-backend-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, {
    runner: runner2,
    store: JsonlCallStore.open(storePath),
  });
  await broker2.reconcile();
  const parked = runner2.sessions[0].loadedTurns.shift();
  assert.ok(parked, 'the restored founding turn is being observed');
  parked.reject(new LoadedTurnFailedError('restored turn failed at the backend'));
  await tick();
  await broker2.pump();

  const record = broker2.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { replBackend?: string }).replBackend, 'pi');
  assert.equal((await broker2.eval('await p.catch((e) => e.replBackend + "/" + e.replCallId)')).result, 'pi/c1');
  assert.equal(record.reissues, 0, 'a definitive backend failure is never re-issued');
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
  // The degradation demotes to diagnostics (§6.2), naming the reason.
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.line.includes('c1') && n.line.includes('re-issued') && n.line.includes('released')),
    JSON.stringify(notes),
  );
  // The re-issued call's fresh turn completes and settles the SAME guest
  // promise exactly once.
  runner2.sessions[1].completeTurn('fresh result');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, 'fresh result');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'fresh result');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a safe loaded-turn reissue whose release parks past the disconnect bound is HELD — no reissue recorded, no fresh child opens after the broker reported drained (late-resolving-release regression)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-laterelease-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, ['c1'], 'armed on the loaded session first');

  // The seam rejects with a SAFE re-issue class error, and the loaded
  // session's release PARKS (a hung backend release): the re-issue is
  // now blocked inside `reissueReattached`'s awaited release.
  const loaded = runner2.sessions[0];
  const parkedSeam = loaded.loadedTurns.shift();
  assert.ok(parkedSeam, 'the seam is parked on the loaded session');
  // Every release invocation parks on its own resolver — the drain's
  // release phase calls `release()` a second time, so the re-issue
  // task's await and the drain's bounded release share the parking
  // family; all parks are released together later.
  const releaseResolvers: Array<() => void> = [];
  loaded.release = () => {
    loaded.releases++;
    return new Promise<void>((resolve) => {
      releaseResolvers.push(resolve);
    });
  };
  parkedSeam.reject(new Error("the loaded session's founding turn never reached a terminal assistant message"));
  await tick();
  await tick();
  assert.equal(runner2.sessions.length, 1, 'no fresh session yet — the re-issue is parked in the release');
  assert.equal(loaded.releases, 1, 'the release was issued and parked');

  // The disconnect drain runs while the release is parked: the bound
  // expires (the call is still pending on the busy entry), the forced
  // stop settles the call DURABLY as AGENT_CANCELLED (recorded first,
  // settled into the guest), and the drain reports drained.
  const started = Date.now();
  const drained = await broker2.drainForDisconnect(120);
  assert.equal(drained, false, 'the bound is the honest outcome — the call could not drain');
  assert.ok(Date.now() - started < 2000, 'the drain returned at its bound (never awaited the parked release)');
  assert.ok(broker2.isDrained);
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'the forced stop settled the call');
  const record = broker2.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.equal((record.completion!.value as { replBackend?: string }).replBackend, 'pi');

  // The parked release resolves LATE, after the drain reported drained.
  // The re-issue must NOT proceed: no reissue recorded, no fresh session,
  // no prompt — a fresh child must never open after the broker reported
  // drained (phase-D review rejection: the fence was checked only BEFORE
  // the awaited release, so a release that parked past the bound resumed
  // into a post-drain re-issue that recorded a reissue and opened/prompted
  // a new child).
  for (const resolve of releaseResolvers) resolve();
  await tick();
  await tick();
  assert.equal(runner2.sessions.length, 1, 'no fresh session opened after the drain');
  assert.ok(
    runner2.sessions.every((s) => s.prompts.length === 0),
    'no new child prompted after the drain',
  );
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'no reissue was recorded');
  assert.equal(record.completion!.outcome, 'reject', 'the call stays as the drain settled it');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// The re-issue branches' refusal cadence (phase-D review round 2)
// ────────────────────────────────────────────────────────────────────────

test('cadence: a no-recorded-session re-issue QUEUED by the cap stays pending and dispatches when the slot frees — no refusal, no premature settlement boundary', async () => {
  const kinds: Array<'eval' | 'settlement'> = [];
  const sink: SnapshotSink = { boundary: (kind) => kinds.push(kind), flush: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-nosess-'));
  const storePath = join(dir, 'calls.jsonl');

  // Two pending agent calls with NO recorded backend session (parked with
  // the parking bridge — the store never saw them; reconcile adopts them,
  // the sessionId stays null → the re-issue arm). The restored broker runs
  // cap=1: the first re-issue takes the slot, the second QUEUES in
  // dispatch order — it stays PENDING (never a ConcurrencyLimitError
  // rejection), so nothing settles and no settlement boundary fires at
  // reconcile (§4.1 queue-above-cap; review: the old refusal settled the
  // guest mid-reconcile).
  const ws = await Workspace.create(PROJECT);
  await ws.eval('const p1 = agent("pi/x", "t1"); const p2 = agent("pi/y", "t2"); "started"');
  assert.equal(ws.surface()!.pending().length, 2);
  const snapshot = ws.snapshot();
  ws.dispose();

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, {
    runner: runner2,
    store: JsonlCallStore.open(storePath),
    maxConcurrentAgents: 1,
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reissued, ['c1', 'c2'], 'the over-cap re-issue QUEUED (reported re-issued)');
  assert.deepEqual(report.failedLost, []);
  assert.deepEqual(kinds, [], 'queueing settles nothing — no settlement boundary at reconcile');
  const record = broker2.store().lookup('c2')!;
  assert.equal(record.completion, null, 'the queued re-issue was never rejected');
  // The slot frees and the queued re-issue dispatches in order.
  runner2.sessions[0].completeTurn('done-1');
  await tick();
  await broker2.pump();
  await tick();
  assert.equal(runner2.sessions.length, 2, 'the queued re-issue opened a fresh session');
  assert.equal(broker2.store().lookup('c2')!.reissues, 1);
  runner2.sessions[1].completeTurn('done-2');
  await tick();
  await broker2.pump();
  const p2 = await broker2.eval('await p2');
  assert.equal(p2.result, 'done-2', 'the queued re-issue settled the SAME guest promise');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('cadence: an adapter without the completion seam degrades through the doc\'s RE-ISSUE fallback — the loaded sessions are released, the calls are re-issued under the same ids (never settled from a quiet gap, never left pending), surfaced guest-visibly', async () => {
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
    snapshotSink: sink,
  });
  const report = await broker2.reconcile();
  assert.deepEqual(report.reattached, [], 'no call stays attached without the seam');
  assert.deepEqual(report.reissued, ['c1', 'c2'], 'both calls degrade to re-issue — the doc\'s honest fallback for a capability-omitting backend');
  assert.deepEqual(report.failedLost, []);
  assert.equal(runner2.loadedWith.length, 2, 'both sessions loaded — the seam absence is discovered after a successful load');
  // The degradation demotes to diagnostics (§6.2) — never the eval result surface.
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'no reconcile lines leak into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.filter((n) => n.line.includes('re-issued')).length >= 2 &&
      notes.some((n) => n.line.includes('c1') && n.line.includes('not observable') && n.line.includes('re-issued')),
    JSON.stringify(notes),
  );
  assert.equal(runner2.sessions[0].releases, 1, 'c1\'s seam-less loaded session was released before the re-issue');
  assert.equal(runner2.sessions[2].releases, 1, 'c2\'s seam-less loaded session was released before the re-issue');
  // The re-issue opened a FRESH session per call (the loaded ones are gone):
  // [0] c1 loaded, [1] c1 fresh, [2] c2 loaded, [3] c2 fresh.
  assert.equal(runner2.sessions.length, 4, '2 loaded + 2 fresh re-issue sessions');
  assert.equal(broker2.store().lookup('c1')!.reissues, 1, 'the reissue was recorded');
  // The calls settle through the fresh dispatch exactly once (phase-F
  // review: the old unobservable degradation left them pending until
  // interrupt/reset).
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c1', 'c2'], 'the re-issued calls are tracked pending on their fresh turns');
  runner2.sessions[1].completeTurn('fresh outcome 1');
  runner2.sessions[3].completeTurn('fresh outcome 2');
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p1')).result, 'fresh outcome 1');
  assert.equal((await broker2.eval('await p2')).result, 'fresh outcome 2');
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'both continuations settled exactly once');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'fresh outcome 1');
  assert.equal(broker2.store().lookup('c2')!.completion!.value, 'fresh outcome 2');
  assert.ok(kinds.includes('settlement'), 'the settlements fired the state-changing boundary: ' + JSON.stringify(kinds));
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// The re-attach arm's still-running degradation (phase-D review round 3)
// ────────────────────────────────────────────────────────────────────────

test('a RE-ARMABLE still-running seam rejection keeps the call attached and pending: the broker re-arms the seam on the SAME session, never settles a quiet gap, never re-issues — and a later authoritative completion settles the call exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-rearm-'));
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
  assert.deepEqual(report.reattached, ['c1']);
  // The seam rejects with the re-armable still-running class (a `running`
  // turn whose terminal notification did not arrive within the max-wait
  // bound): the broker retains the line under diagnostics (§6.2), KEEPS
  // the loaded session attached, and re-arms the seam — the call is
  // never settled from a quiet gap and never re-issued while the
  // backend turn may still be running.
  const firstSeam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(firstSeam, 'the seam is parked on the loaded session');
  firstSeam.reject(new LoadedTurnStillRunningError('the loaded session\'s founding turn is still running at the backend', true));
  await tick();
  await tick();
  assert.equal(runner2.sessions.length, 1, 'no fresh session — the still-running call was NOT re-issued');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'reissues counter untouched');
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c1'], 'the call stays pending');
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.line.includes('c1') && n.line.includes('still running')),
    JSON.stringify(notes),
  );
  // The seam was re-armed on the SAME loaded session: a later
  // authoritative completion still settles the call exactly once.
  const secondSeam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(secondSeam, 'the seam was re-armed on the still-attached session');
  secondSeam.resolve({ stopReason: 'end_turn', text: 'completed eventually' });
  await tick();
  await broker2.pump();
  assert.equal((await broker2.eval('await p')).result, 'completed eventually');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'completed eventually');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'kept attached — no re-issue');
  assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId, 'settled on the SAME backend session');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a NON-re-armable still-running seam rejection is NEVER re-invoked — the broker keeps the loaded session ATTACHED and waits for the terminal state from the session-level surfaces: a later ended notification settles the call exactly once, and a cancel settles it as the recoverable AGENT_CANCELLED (phase-F review round 3: the old immediate recursive re-arm spun in an unbounded microtask/warning loop, starving cancellation, drain, and every other task)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-nonrearm-'));
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
  assert.deepEqual(report.reattached, ['c1']);
  const seam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(seam, 'the seam is parked on the loaded session');
  seam.reject(
    new LoadedTurnStillRunningError(
      'a third-party seam that can never observe the terminal state',
      false,
    ),
  );
  await tick();
  await tick();
  // Phase-F review round 3: a possibly-running call is NEVER re-issued —
  // the loaded session stays attached (no release, no fresh session, no
  // reissue record) — and the NON-re-armable seam is NOT re-invoked (an
  // immediate recursive re-arm would spin in an unbounded
  // microtask/warning loop, starving cancellation, drain, and every
  // other task). The call is still pending — partial output is never
  // settled — and the broker now waits for the terminal state from the
  // remaining authority surfaces below.
  assert.equal(runner2.sessions[0].releases, 0, 'the loaded session stays attached');
  assert.equal(runner2.sessions.length, 1, 'no fresh session — no re-issue');
  assert.equal(broker2.store().lookup('c1')!.reissues, 0, 'no reissue was recorded');
  assert.equal(broker2.store().lookup('c1')!.sessionId, recordedId, 'the attach key is unchanged');
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c1'], 'the call is still pending — partial output is never settled');
  assert.equal(runner2.sessions[0].loadedTurns.length, 0, 'the seam was NOT re-invoked — no loop');
  const probe = await broker2.eval('"probe"');
  assert.deepEqual(output(probe), [], 'no reconcile line leaks into the eval output');
  const notes = await reconcileNotesOf(broker2);
  assert.ok(
    notes.some((n) => n.line.includes('c1') && n.line.includes('can never observe')),
    JSON.stringify(notes),
  );
  // The SESSION-LEVEL ended notification settles the call (a seam-less
  // backend that pushes `_session/loaded_turn/ended` anyway) with the
  // turn's real accumulated text — exactly once.
  runner2.sessions[0].fireLoadedTurnEnded({ stopReason: 'end_turn' }, 'the turn eventually completed');
  await tick();
  await broker2.pump();
  const settleProbe = await broker2.eval('await p');
  assert.equal(settleProbe.result, 'the turn eventually completed');
  assert.equal(broker2.store().lookup('c1')!.completion!.value, 'the turn eventually completed');
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'the continuation settled exactly once');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a NON-re-armable still-running seam rejection settles on a CANCEL as the recoverable AGENT_CANCELLED — the interrupt tool works on a held call (phase-F review round 3: the old re-arm loop never yielded, so cancellation could not reach the held call)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-nonrearm-cancel-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  await broker2.reconcile();
  const seam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(seam);
  seam.reject(
    new LoadedTurnStillRunningError(
      'a third-party seam that can never observe the terminal state',
      false,
    ),
  );
  await tick();
  await tick();
  // The held call is cancelable: the interrupt tool's wire cancel flips
  // the entry's cancel flag, the non-re-armable wait observes it, and
  // the call settles as the recoverable AGENT_CANCELLED (recorded first,
  // delivered by the pump) — never left pending until the drain.
  const outcome = await broker2.cancelCall('c1');
  assert.equal(outcome, 'cancelled', 'the interrupt tool reports the cancel');
  await tick();
  await broker2.pump();
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'the call settled — not left pending');
  const record = broker2.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED', 'the recoverable cancel code');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  assert.equal((record.completion!.value as { replBackend?: string }).replBackend, 'pi');
  assert.equal(record.reissues, 0, 'never re-issued');
  assert.equal(runner2.sessions[0].releases, 0, 'the loaded session stays attached (the cancel did not release it)');
  // The guest promise rejected with the recoverable cancellation (a
  // later eval reads it; the workspace stays live).
  let result: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
    if (got.result !== undefined) {
      result = got.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(result?.includes('c1 was cancelled'), `guest-visible settlement: ${result}`);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a NON-re-armable held call whose SESSION IS RELEASED re-issues through the safe-re-issue class — the backend process died, so nothing is running to duplicate (phase-F review round 3: the wait\'s release branch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-nonrearm-release-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  await broker2.reconcile();
  const seam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(seam);
  seam.reject(
    new LoadedTurnStillRunningError(
      'a third-party seam that can never observe the terminal state',
      false,
    ),
  );
  await tick();
  await tick();
  assert.equal(runner2.sessions[0].loadedTurns.length, 0, 'the seam was NOT re-invoked — no loop');
  // The loaded session's dedicated process dies: the wait's release
  // watch fires, and the observably-dead call is re-issued under the
  // same id (the fresh session's turn settles the SAME guest promise).
  await runner2.sessions[0].release();
  await tick();
  assert.equal(broker2.store().lookup('c1')!.reissues, 1, 'the released-session re-issue was recorded');
  assert.equal(runner2.sessions.length, 2, 'the re-issue opened a fresh session');
  runner2.sessions[1].completeTurn('the re-issued turn completed');
  await tick();
  await broker2.pump();
  const probe = await broker2.eval('await p');
  assert.equal(probe.result, 'the re-issued turn completed');
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'the continuation settled exactly once');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a still-running seam rejection during the client-presence drain is STOPPED at the bound — the call settles as the recoverable AGENT_CANCELLED (never a re-issue after the last client disconnected, and never an orphaned pending call)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-drainhold-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  await broker2.reconcile();
  // The drain starts while the seam is parked (the turn is still running
  // at the backend). The seam rejects with the plain released-class error
  // mid-drain — and because the broker is draining, the rejection HOLDS
  // the call (a re-issue would open a fresh child after the last client
  // disconnected). The unobservable turn cannot drain, so the bound is
  // the honest outcome: the drain cancels what it caught, then settles
  // the still-pending call with the recoverable AGENT_CANCELLED (phase-D
  // review round 6: the hold used to leave the call pending forever —
  // orphaned by the release phase's bookkeeping clear, uncancelable
  // except by reset, because reconcile never runs again on a live
  // workspace).
  const seam = runner2.sessions[0].loadedTurns.shift();
  assert.ok(seam);
  const draining = broker2.drainForDisconnect(400);
  await tick();
  seam.reject(new Error('InteractiveSession has been released while awaiting the loaded session\'s founding turn'));
  assert.equal(await draining, false, 'the unobservable turn cannot drain — the bound is the honest outcome');
  assert.ok(broker2.isDrained);
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), [], 'the call is NOT orphaned — the bound\'s forced stop settled it');
  const record = broker2.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED', 'the recoverable forced-stop code');
  assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true);
  assert.equal(record.reissues, 0, 'never re-issued');
  assert.equal(runner2.sessions[0].releases, 1, 'the child closed in the release phase');
  // The guest promise settled with the recoverable error (a later eval
  // reads it — the workspace stays live after the drain).
  let result: string | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const got = await broker2.eval('await p.catch((e) => "ERR:" + e.message)');
    if (got.result !== undefined) {
      result = got.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(result?.includes('cancelled by the client-presence drain'), `guest-visible settlement: ${result}`);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('the drain bound is ABSOLUTE: a hung cancel/release cannot block disconnect past the deadline (the session-eviction TTL is the outer ceiling)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  // A backend whose cancel AND release hang forever (the worst case the
  // review flagged: the post-deadline awaits used to block indefinitely).
  const session = runner.sessions[0];
  session.hangCancel = true;
  session.hangRelease = true;
  const started = Date.now();
  const drained = await broker.drainForDisconnect(100);
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the bound expired with the turn still running');
  // TIGHT ceiling (phase-D review round 7: this used to permit a 100 ms
  // drain to take nearly 3 seconds — it did not enforce the required
  // ceiling). The bound is absolute: the drain returns at the deadline
  // plus timer slop, never a fresh window after it.
  assert.ok(elapsed < 500, `the drain returned within the bound, not blocked by the hung backend: ${elapsed} ms`);
  assert.ok(broker.isDrained);
  await broker.dispose();
  ws.dispose();
});

test('the drain bound is measured from METHOD ENTRY: a drain queued behind a long serialized operation skips straight to the forced stop instead of running a fresh window after the queue wait (phase-D review round 7)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  // A hung backend: cancel AND release never resolve (the worst case).
  const session = runner.sessions[0];
  session.hangCancel = true;
  session.hangRelease = true;
  // Hold the broker's serialized chain with a guest busy-loop eval for
  // ~400 ms (the eval's op runs synchronously, so the drain queued
  // behind it cannot start until the loop exits). The drain's bound
  // must be measured from METHOD ENTRY — a deadline already past at
  // chain acquisition skips straight to the forced stop. The old code
  // started the clock inside the serialized closure: the drain then ran
  // a fresh ~120 ms window AFTER the 400 ms queue wait (~520 ms total).
  const started = Date.now();
  const evalP = broker.eval('const t = Date.now(); while (Date.now() - t < 400) {} "slow"');
  const drainP = broker.drainForDisconnect(120);
  await evalP;
  const drained = await drainP;
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the turn never completed — the bound is the honest outcome');
  assert.ok(broker.isDrained);
  // 400 ms queue wait + a margin: a drain that ran a fresh full window
  // after the queue wait would land well past this.
  assert.ok(elapsed < 480, `the bound was measured from method entry, not after the queue wait: ${elapsed} ms`);
  await broker.dispose();
  ws.dispose();
});

test('the drain bound is ABSOLUTE against the CHAIN WAIT: a YIELDFUL queued operation (a long wait op polling a pending call — async, never blocking the event loop) cannot delay the drain past its deadline — the chain acquisition races the remaining bound (phase-D review round 8)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  // A hung backend: cancel AND release never resolve (the worst case).
  const session = runner.sessions[0];
  session.hangCancel = true;
  session.hangRelease = true;
  // A YIELDFUL op holds the serialized chain: a wait with a long timeout
  // and a pending call loops (pump + sleep + re-poll) without blocking
  // the event loop. The round-7 chain wait had NO deadline race — a
  // stuck queued op of this kind delayed the drain until ITS OWN
  // timeout (indefinitely for an op that never terminates), i.e. the
  // 120 ms drain could return ~10 s later. The synchronous busy-loop
  // regression above cannot exercise this: a synchronous eval blocks
  // the event loop, so no timer can fire until it yields — the
  // yieldful case is the one the absolute bound must actually win.
  const waiting = broker.waitForCalls(undefined, 10_000);
  await tick();
  const started = Date.now();
  const drained = await broker.drainForDisconnect(120);
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the bound expired with the turn still running');
  // TIGHT: the drain returns AT its deadline — the old code returned
  // only when the queued op freed the chain (~10 s) and the round-7
  // regression permitted ~480 ms for a 120 ms drain.
  assert.ok(elapsed < 400, `the drain returned at its deadline, not after the stuck chain op: ${elapsed} ms`);
  assert.ok(broker.isDrained);
  // The UNLOCKED forced stop still settled the pending call DURABLY at
  // the bound — recorded first, settled into the guest, no pending
  // registry entry left (the chain wait can shorten the drain, never
  // its settlement discipline).
  const record = broker.store().lookup('c1')!;
  assert.equal(record.completion!.outcome, 'reject');
  assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.deepEqual(
    broker.pendingCalls().map((e) => e.id),
    [],
    'the opening call is not left pending in the guest registry',
  );
  assert.equal(session.cancelCalls, 1, 'the forced stop issued the cancel');
  assert.equal(session.releases, 1, 'the release phase issued the release (bounded, never awaited past the bound)');
  // The wait op sees the settled call and ends promptly (its next poll
  // observes the guest registry empty — no 10 s wait).
  await waiting;
  await broker.dispose();
  ws.dispose();
});

test('the drain bound is ABSOLUTE against a chain REPLACED mid-wait: an op enqueued precisely as the prior chain releases (in the drain\'s race window) must not become the chain the drain waits behind with no deadline race (review rejection)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // Two pending calls: c1 drives the FIRST chain holder's release (the
  // race fires when its wait completes); c2 keeps the SECOND op — the
  // one enqueued DURING the drain's chain wait — alive past the bound
  // (a replacement that resolved quickly would let the re-read bug
  // pass unnoticed).
  await broker.eval('const p1 = agent("pi/x", "task1"); const p2 = agent("pi/x", "task2"); "started"');
  await tick();
  // A hung backend: cancel AND release never resolve (the worst case).
  for (const session of runner.sessions) {
    session.hangCancel = true;
    session.hangRelease = true;
  }
  // op1 holds the serialized chain waiting on c1 (yieldful — its poll
  // loop never blocks the event loop, so the drain's bound timer fires
  // normally).
  const waiting1 = broker.waitForCalls(['c1'], 10_000);
  await tick();
  const started = Date.now();
  // The drain races the chain — op1's — with the remaining bound.
  const drainedP = broker.drainForDisconnect(120);
  await tick();
  // op2 enqueues WHILE the drain awaits: it chains onto op1's chain and
  // REPLACES `this.opChain`. The review-rejected code raced one chain,
  // then re-read the mutable field after its race won — the microtasks
  // between the chain's release and that re-read let op2's replacement
  // win, so the drain queued behind op2 with no deadline race on it (a
  // 20 ms drain took 307 ms; here op2 polls c2 for 10 s, so the old
  // code returned only at ITS timeout).
  const waiting2 = broker.waitForCalls(['c2'], 10_000);
  // Release the raced chain: c1's turn completes, op1's wait ends, the
  // drain's race fires 'chain' — with op2 already the current chain.
  runner.sessions[0].completeTurn('done');
  const drained = await drainedP;
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the bound expired with c2 still running');
  // TIGHT: the drain returns AT its deadline — the old code returned
  // only when the replacement op freed the chain (~10 s later).
  assert.ok(elapsed < 500, `the drain re-raced the replaced chain instead of waiting behind it: ${elapsed} ms`);
  assert.ok(broker.isDrained);
  // c1 completed normally (its turn finished before the bound) — the
  // unlocked forced stop never touched it.
  const record1 = broker.store().lookup('c1')!;
  assert.equal(record1.completion!.outcome, 'resolve');
  // c2 — still pending at the bound — was settled DURABLY by the
  // unlocked forced stop (recorded first, settled into the guest, no
  // pending registry entry left — the chain wait can shorten the
  // drain, never its settlement discipline).
  const record2 = broker.store().lookup('c2')!;
  assert.equal(record2.completion!.outcome, 'reject');
  assert.equal((record2.completion!.value as { code?: string }).code, 'AGENT_CANCELLED');
  assert.deepEqual(
    broker.pendingCalls().map((e) => e.id),
    [],
    'neither call is left pending in the guest registry',
  );
  assert.equal(runner.sessions[0].cancelCalls, 0, 'the completed turn was not cancelled');
  assert.equal(runner.sessions[1].cancelCalls, 1, 'the forced stop issued the cancel for the still-running turn');
  assert.equal(runner.sessions[0].releases, 1, 'the release phase released the completed session (bounded, never awaited past the bound)');
  assert.equal(runner.sessions[1].releases, 1, 'the release phase released the hung session (bounded, never awaited past the bound)');
  // Both wait ops observe their calls settled and end promptly (no 10 s
  // wait: op1 saw c1 settle; op2 sees the registry empty on its next
  // poll).
  await waiting1;
  await waiting2;
  await broker.dispose();
  ws.dispose();
});

test('Broker.dispose is bounded against the CHAIN WAIT too: a YIELDFUL queued operation cannot delay teardown past the bound — the disposal races the remaining bound like the drain (phase-D review round 8)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  const session = runner.sessions[0];
  session.hangCancel = true;
  session.hangRelease = true;
  // A yieldful op holds the chain past the dispose bound (its own
  // timeout is far beyond it — the still-pending call keeps it
  // polling). The disposal must NOT queue behind it: the absolute
  // bound is the outer ceiling for teardown exactly as for the drain
  // (a stuck serialized op must not hang daemon shutdown / reset).
  // The catch is attached IMMEDIATELY: `dispose` sets `disposed` at
  // method entry, so the stuck op dies on its next poll while the test
  // is still awaiting the disposal — its rejection must be handled
  // from the start, never unhandled.
  const waiting = broker.waitForCalls(undefined, 2_000).catch(() => undefined);
  await tick();
  const started = Date.now();
  await broker.dispose(120);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `dispose returned at its bound, not after the stuck chain op: ${elapsed} ms`);
  assert.equal(session.cancelCalls, 1, 'the bounded disposal still issued the cancel');
  assert.equal(session.releases, 1, 'the bounded disposal still issued the release');
  // The stuck wait op's rejection is the chain's own — absorbed by the
  // chain bookkeeping; the caught handle settles when the op dies.
  await waiting;
  ws.dispose();
});

test('the drain bound is ABSOLUTE for the GUEST DRAIN too: a settlement that resumes a runaway continuation near the deadline is interrupted at the remaining bound, never at the eval deadline (phase-D review round 6)', async () => {
  const runner = new FakeRunner();
  // The per-eval deadline is far beyond the drain bound: without the
  // remaining-bound interrupt, the interrupted-continuation drain would
  // run for the whole eval deadline and exceed the session-eviction TTL.
  const { ws, broker } = await setup({ runner, evalTimeoutMs: 10_000 });
  // A suspended eval whose continuation runs forever once the call
  // settles (the guest drain resumes it — `drainJobs`).
  await broker.eval('const p = agent("pi/x", "task"); const r = await p; while (true) {}');
  await tick();
  const started = Date.now();
  const draining = broker.drainForDisconnect(300);
  // The settlement lands mid-drain (the backend turn completes): the
  // pump delivers it and the guest drain resumes the runaway
  // continuation — which must be interrupted at the REMAINING disconnect
  // bound, not run to the 10 s eval deadline.
  await new Promise((resolve) => setTimeout(resolve, 50));
  runner.last().completeTurn('done');
  const drained = await draining;
  const elapsed = Date.now() - started;
  assert.equal(drained, true, 'the turn itself drained within the bound; the interrupted continuation is a bounded drain, not a drain failure');
  assert.ok(elapsed < 3000, `the guest drain was bounded by the remaining disconnect bound, not the eval deadline: ${elapsed} ms`);
  assert.ok(broker.isDrained);
  // §6.2: the interrupted continuation is RETAINED under
  // workspace().diagnostics (the settlement itself landed; only its
  // continuation was bounded) — the warn line left the eval result
  // surface.
  const probe = await broker.eval('"probe"');
  assert.ok(
    output(probe).every((l) => !l.includes('interrupted at the disconnect bound')),
    `the drain failure left the result surface: ${output(probe).join('\n')}`,
  );
  const diag = await broker.eval(
    'workspace().diagnostics.drainError === null ? "none" : workspace().diagnostics.drainError.message',
  );
  assert.ok(
    String(diag.result ?? '').includes('interrupted') || String(diag.result ?? '').includes('Job execution error'),
    `the interrupted drain is retained in diagnostics: ${diag.result}`,
  );
  await broker.dispose();
  ws.dispose();
});

test('a client reconnecting mid-drain ABORTS the drain: children stay warm — nothing is cancelled, nothing is released, and the next disconnect drains again (phase-D review round 6)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  // The drain starts with no clients; a client reconnects mid-drain (the
  // daemon's presence probe flips to true).
  let clientConnected = false;
  const draining = broker.drainForDisconnect(2000, () => clientConnected);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runner.sessions[0].releases, 0, 'the child is still warm while the drain waits for the in-flight turn');
  clientConnected = true;
  assert.equal(await draining, false, 'the drain aborted — it did not run to its release phase');
  assert.equal(broker.isDrained, false, 'the drain latch stays clear — the next disconnect drains again');
  assert.equal(runner.sessions[0].releases, 0, 'the child was NOT released: children stay warm while any client is connected');
  assert.equal(runner.sessions[0].cancelCalls, 0, 'nothing was cancelled');
  // The still-running turn completes normally after the abort and
  // settles into the live workspace.
  runner.last().completeTurn('warm result');
  await broker.pump();
  const got = await broker.eval('await p');
  assert.equal(got.result, 'warm result');
  await broker.dispose();
  ws.dispose();
});

test('a restore-time loadSession that lands AFTER a bounded dispose is released exactly once — never registered, never re-issued (phase-D review rejection: the parked restore load used to register its session on the disposed broker, leaking it and repopulating liveAgents)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-late-load-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  // Restore: fresh workspace over the snapshot, fresh broker + runner
  // over the same store. The re-attach loadSession PARKS (never resolves
  // on its own — the reviewer's focused probe scenario).
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  let loadCalls = 0;
  let resolveLoad: (() => void) | undefined;
  const parkedLoad = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const originalLoad = runner2.loadSession.bind(runner2);
  runner2.loadSession = async (opts) => {
    loadCalls++;
    await parkedLoad;
    return originalLoad(opts);
  };
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const reconcilePromise = broker2.reconcile();
  await tick();
  assert.equal(loadCalls, 1, 'the re-attach load is in flight (parked)');

  // A BOUNDED dispose completes while the load is parked (the daemon
  // shutdown path): the serialized chain is held by the parked reconcile,
  // so the disposal runs unlocked at its deadline — it must return
  // within the bound, never after the parked load.
  const started = Date.now();
  await broker2.dispose(150);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `dispose was bounded while the reconcile held the chain: ${elapsed} ms`);
  assert.equal(broker2.liveAgents().length, 0, 'no live agent after the dispose');

  // The parked load lands LATER: the child is released exactly once,
  // never registered, never re-issued (no fresh openSession, no prompt —
  // a disposed broker must never open a child), and the call is never
  // settled from a quiet gap.
  resolveLoad!();
  const report = await reconcilePromise;
  assert.deepEqual(report.reattached, [], 'the call was never re-attached');
  assert.deepEqual(report.reissued, [], 'the call was never re-issued');
  assert.deepEqual(report.failedLost, []);
  assert.deepEqual(report.leftPending, ['c1'], 'the call stays pending — the state owning it was torn down');
  assert.equal(runner2.sessions.length, 1, 'only the loaded session exists');
  const loaded = runner2.sessions[0];
  assert.equal(loaded.releases, 1, 'the late-loaded session was released exactly once');
  assert.equal(loaded.prompts.length, 0, 'the late-loaded session never prompted');
  assert.equal(broker2.liveAgents().length, 0, 'no live agent — the session never registered');
  assert.equal(runner2.openedWith.length, 0, 'no re-issue — no fresh session was opened');
  assert.equal(broker2.store().lookup('c1')!.completion, null, 'the call was not settled from a quiet gap');
  ws2.dispose();
});

test('a bounded drain with MULTIPLE pending restored calls settles EVERY outstanding call at the bound — a reconcile parked on a never-resolving first loadSession leaves no pending, uncancelable entry, and the resumed reconcile never initiates subsequent loads after the generation bump (phase-D review rejection)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-multi-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await broker.eval('const p1 = agent("pi/x", "t1"); const p2 = agent("pi/y", "t2"); const q = checkpoint("Question?"); "started"');
  await tick();
  assert.equal(runner.sessions.length, 2);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  // Restore: the re-attach of the FIRST pending call parks FOREVER, so
  // the serialized reconciliation can never reach the second registry
  // entry (it registers calls in `openingCalls` only as the loop reaches
  // them).
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  let loadCalls = 0;
  let resolveLoad!: () => void;
  const parkedLoad = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const originalLoad = runner2.loadSession.bind(runner2);
  runner2.loadSession = async (opts) => {
    loadCalls++;
    await parkedLoad;
    return originalLoad(opts);
  };
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const reconcilePromise = broker2.reconcile();
  await tick();
  assert.equal(loadCalls, 1, 'reconcile parked on the FIRST call\'s re-attach load');
  assert.deepEqual(
    broker2.pendingCalls().map((e) => e.id),
    ['c1', 'c2', 'c3'],
    'all three entries (two calls + the checkpoint) are pending in the guest registry',
  );

  // The bounded drain: c1 is covered by the opening-call registry, but
  // c2 was never REACHED by the serialized reconcile — the forced stop
  // must settle it too (the old code settled only c1, then reported
  // drained with c2 pending and uncancelable forever — reconcile never
  // runs again on a live workspace).
  assert.equal(await broker2.drainForDisconnect(80), false, 'the bound expired with the load parked');
  assert.ok(broker2.isDrained, 'the broker reports drained');
  assert.deepEqual(
    broker2.pendingCalls().map((e) => e.id),
    ['c3'],
    'EVERY outstanding CALL was settled at the bound — only the checkpoint (which awaits the human\'s answer) stays pending',
  );
  for (const id of ['c1', 'c2']) {
    const record = broker2.store().lookup(id)!;
    assert.equal(record.completion!.outcome, 'reject', `${id} settled durably at the bound`);
    assert.equal((record.completion!.value as { code?: string }).code, 'AGENT_CANCELLED', `${id} carries the forced-stop code`);
    assert.equal((record.completion!.value as { recoverable?: boolean }).recoverable, true, `${id} is recoverable`);
  }

  // The parked load lands AFTER the drain: the resumed reconciliation
  // must NOT initiate the SECOND call's load — a fresh child must never
  // open and run after the last client disconnected (the generation
  // fence used to cover only the parked load itself, so the resumed
  // loop initiated subsequent loads for the entries behind it). The
  // already-recorded completions settle from the store, first-wins.
  resolveLoad();
  const report = await reconcilePromise;
  assert.equal(loadCalls, 1, 'no second loadSession after the drain generation bump');
  assert.equal(runner2.openedWith.length, 0, 'no re-issue — no fresh session was opened');
  assert.equal(runner2.sessions.length, 1, 'only the parked-load session exists');
  assert.equal(runner2.sessions[0].releases, 1, 'the late-loaded session was released exactly once');
  assert.equal(runner2.sessions[0].prompts.length, 0, 'the late-loaded session never prompted');
  assert.deepEqual(report.reissued, [], 'nothing was re-issued');
  assert.deepEqual(report.reattached, [], 'nothing was re-attached after the drain');
  assert.deepEqual(report.leftPending, [], 'no call left pending');
  // The bound settlements are exactly-once: the resumed store arm did
  // not double-settle (the registry still holds only the checkpoint).
  assert.deepEqual(broker2.pendingCalls().map((e) => e.id), ['c3']);
  // The checkpoint the parked reconcile never re-surfaced was re-surfaced
  // by the bound's pass — it stays ANSWERABLE across the cut-off restore
  // (the doc: "answering works across a restore").
  const answered = await broker2.eval('checkpoint.answer("c3", "blue"); "delivered"');
  assert.equal(answered.result, 'delivered');
  assert.equal((await broker2.eval('await q')).result, 'blue');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test('a late-landing restore load whose session.release HANGS cannot hold the reconciliation (or the daemon\'s first touch) — the teardown fence DETACHES the best-effort release (phase-D review rejection: the fence awaited session.release() with no deadline, so a custom backend with a hung release kept reconcile/first-touch pending indefinitely)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-restore-hungrel-'));
  const storePath = join(dir, 'calls.jsonl');
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ store: JsonlCallStore.open(storePath), runner });
  await dispatchAgent(broker, runner);
  const snapshot = ws.snapshot();
  await crash(ws, broker);

  // Restore: the re-attach load parks; a bounded dispose completes while
  // it is parked (the daemon shutdown path — the disposal runs unlocked
  // at its deadline because the parked reconcile holds the chain).
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  let resolveLoad!: () => void;
  const parkedLoad = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  const originalLoad = runner2.loadSession.bind(runner2);
  runner2.loadSession = async (opts) => {
    await parkedLoad;
    const session = await originalLoad(opts);
    session.hangRelease = true; // the custom backend's release hangs forever
    return session;
  };
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  const reconcilePromise = broker2.reconcile();
  await tick();
  await broker2.dispose(150);

  // The parked load lands LATER, with a HUNG release: the teardown fence
  // must DETACH the release (best-effort, catch attached) instead of
  // awaiting it — the reconciliation completes promptly and the first
  // touch is never left pending on the hung release (the old code
  // awaited `session.release()` with no deadline: reconcile stayed
  // parked forever).
  const started = Date.now();
  resolveLoad();
  const report = await reconcilePromise;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `reconcile completed without awaiting the hung release: ${elapsed} ms`);
  assert.equal(runner2.sessions.length, 1, 'only the loaded session exists');
  assert.equal(runner2.sessions[0].releases, 1, 'the release was ISSUED (best-effort, detached)');
  assert.equal(runner2.sessions[0].prompts.length, 0, 'the late-loaded session never prompted');
  assert.deepEqual(report.leftPending, ['c1'], 'the call stays pending — the state owning it was torn down');
  assert.deepEqual(report.reissued, [], 'never re-issued');
  assert.equal(runner2.openedWith.length, 0, 'no fresh session was opened');
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});
