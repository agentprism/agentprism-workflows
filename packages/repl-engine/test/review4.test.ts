/**
 * Phase-E review round 4 regression suite: the COMPLETE trap-free
 * metadata reads — the two caps the round-3 review left in place:
 *
 * 1. The pending-call registry read (`surface.pending()`) used to be
 *    capped at 16 384 elements: 16 400 pending checkpoints returned
 *    only 16 384 ids plus one `undefined` hole (the `[ArrayTruncated]`
 *    marker mapping to `undefined` in the broker's id lists). The read
 *    is now COMPLETE (no array cap) — the registry is the frozen guest
 *    library's own metadata, bounded by the VM's memory like the
 *    metadata itself. Pinned here at the engine boundary: the eval's
 *    `pending` surface, the broker's pending-id reads, and the restore
 *    path's three-way reconciliation all see the WHOLE registry.
 * 2. The provenance registry's `read()` result used to go through the
 *    generic 256-property object cap: a workspace with 300 bindings
 *    reported null provenance for bindings 256-299 even though the eval
 *    created them. The registry read is now complete too — every
 *    binding's origin (which eval/worker produced the value) is
 *    preserved in the manifest.
 *
 * Both reads stay trap-free (own-property-descriptor reads only; the
 * metadata is created by the frozen library closures, never by guest
 * code) and bounded by the VM's memory like the metadata itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Broker,
  Workspace,
  type BrokerLoadSessionOptions,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
} from '../src/index.js';

const PROJECT = '/tmp/repl-review4-project';

/** How many pending checkpoints exceed the round-3 read cap (16 384)
 *  with margin — the regression's floor. */
const CHECKPOINTS = 16_500;

/** The fake held-open ACP session (the same shape as eval-break.test.ts's). */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  releases = 0;
  cancelCalls = 0;
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
      opts.onHandoff?.();
    });
  }

  steer(content: string): Promise<string> {
    return new Promise((_, reject) => reject(new Error('steer not used in this suite')));
  }

  awaitCurrentTurn(): Promise<BrokerTurn> {
    return new Promise(() => {});
  }

  cancel(): Promise<void> {
    this.cancelCalls++;
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

class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    this.sessions.push(session);
    return session;
  }

  async loadSession(opts: BrokerLoadSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    this.sessions.push(session);
    return session;
  }

  async dispose(): Promise<void> {}

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, 'a session must exist');
    return this.sessions[this.sessions.length - 1];
  }
}

async function setup(): Promise<{ ws: Workspace; broker: Broker }> {
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, {
    evalTimeoutMs: 0,
  });
  return { ws, broker };
}

function pendingIds(result: { pending: string[] }): string[] {
  return result.pending;
}

// ── 1. The pending-call registry read is COMPLETE ──────────────────────

test('review round 4: the pending-call registry read is COMPLETE — 16 500 parked checkpoints report all 16 500 ids (no 16 384-element truncation, no undefined hole) in the eval result AND through the surface', async () => {
  const { ws, broker } = await setup();
  try {
    // The former read capped the array at 16 384 elements and appended
    // an `[ArrayTruncated]` marker that mapped to `undefined` in the
    // broker's id lists: 16 400 checkpoints returned 16 384 ids plus
    // one undefined entry. The eval result's pending surface must carry
    // EVERY id.
    const a = await broker.eval(`for (let i = 0; i < ${CHECKPOINTS}; i++) checkpoint("q" + i); "raised"`);
    const pending = pendingIds(a);
    assert.equal(pending.length, CHECKPOINTS, `the whole registry is reported: ${pending.length}`);
    assert.equal(pending[0], 'c1', 'the first id');
    assert.equal(pending[pending.length - 1], `c${CHECKPOINTS}`, 'the last id');
    for (const id of pending) {
      assert.ok(typeof id === 'string' && /^c\d+$/.test(id), `no undefined/truncation hole: ${JSON.stringify(id)}`);
    }
    // The same complete read serves the broker's other seams (the
    // surface read is shared): every pending checkpoint is visible.
    assert.equal(broker.pendingCalls().length, CHECKPOINTS, 'the broker sees the whole registry');
    assert.equal(broker.pendingCheckpoints().length, CHECKPOINTS, 'every checkpoint is tracked');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});

test('review round 4: the restore path\'s registry read is COMPLETE — after a snapshot/restore, the three-way reconciliation re-surfaces all 16 500 pending checkpoints (no truncation on the reconcile path either)', async () => {
  // THIS workspace raises the checkpoints (each setup() is a fresh VM at
  // the engine level — there is no disk persistence here), then
  // snapshots and restores them.
  const { ws, broker } = await setup();
  const a = await broker.eval(`for (let i = 0; i < ${CHECKPOINTS}; i++) checkpoint("q" + i); "raised"`);
  assert.equal(pendingIds(a).length, CHECKPOINTS);
  const snapshot = ws.snapshot();
  await broker.dispose();
  ws.dispose();
  // A fresh broker over the restored VM: the reconciliation reads the
  // in-VM pending-call registry through the same surface read.
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const broker2 = await Broker.attach(ws2, { evalTimeoutMs: 0 });
  try {
    const report = await broker2.reconcile();
    assert.equal(report.requeuedCheckpoints.length, CHECKPOINTS, 'every pending checkpoint re-surfaced');
    assert.equal(report.leftPending.length, 0, 'nothing was left pending (all checkpoints re-surfaced)');
    const pending = broker2.pendingCalls();
    assert.equal(pending.length, CHECKPOINTS, `the whole registry is reported after restore: ${pending.length}`);
    for (const entry of pending) {
      assert.ok(typeof entry.id === 'string' && /^c\d+$/.test(entry.id), `no undefined hole: ${JSON.stringify(entry.id)}`);
    }
  } finally {
    await broker2.dispose();
    ws2.dispose();
  }
});

// ── 2. The provenance registry read is COMPLETE ────────────────────────

test('review round 4: the manifest\'s provenance is COMPLETE — 300 bindings all report their origin (the former 256-property object cap dropped bindings 256-299 to null provenance)', async () => {
  const { ws, broker } = await setup();
  try {
    // One eval creates 300 top-level bindings (the lexical pass — the
    // canonical `const research = agent(...)` state at scale).
    const code = Array.from({ length: 300 }, (_, i) => `const b${i} = ${i};`).join('\n') + '\n"created"';
    const a = await broker.eval(code);
    assert.equal(a.result, '"created"');    const manifest = broker.workspaceManifest();
    const named = manifest.bindings.filter((binding) => /^b\d+$/.test(binding.name));
    assert.equal(named.length, 300, 'every binding is listed');
    for (const binding of named) {
      assert.ok(
        binding.provenance !== null && binding.provenance.startsWith('eval '),
        `binding ${binding.name} keeps its provenance (the eval created it): ${JSON.stringify(binding.provenance)}`,
      );
    }
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});
