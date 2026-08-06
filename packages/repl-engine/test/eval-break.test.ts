/**
 * Phase-E review rejection round 2 regression suite, pinned at the
 * engine boundary: the `interrupt` tool's two paths against a REAL
 * currently-executing (in-flight) eval, and the `wait` tool's chain
 * behavior under concurrency.
 *
 * 1. `waitForCalls` RELEASES the broker serialization chain between its
 *    pumps: a concurrent `cancelCall` (and `armEvalBreak`) completes
 *    mid-wait instead of queueing behind the whole bounded poll (up to
 *    120 s) — an interrupt can cancel or break while the wait is still
 *    pumping, and the wait's very next pump observes the result.
 * 2. The no-id interrupt (`armEvalBreak`) breaks a RUNNING runaway
 *    eval that is executing ACROSS drains: an eval whose body loops
 *    over subagent calls (yielding between iterations) is in flight
 *    while the wait pumps it; the interrupt lands mid-flight; the
 *    wait's next pump resumes the loop's next iteration and the quickjs
 *    interrupt handler breaks it MID-RUN. (The old daemon test only
 *    exercised a suspended continuation resumed later — the signal was
 *    armed against an eval that had never executed.)
 * 3. The eval-break signal rides a direct eval's OWN drain too: a
 *    suspended eval's continuation resumed by a SYNCHRONOUS
 *    host-callback settlement (`checkpoint.answer` in a later eval)
 *    executes inside that eval's drain — where the old
 *    settlement-drain-only signal was blind, so the runaway burned the
 *    eval deadline instead of being broken by the interrupt. The
 *    interrupted drain releases the tracked eval (no stale arm target).
 *
 * Round 3 (the carried review's defects) adds:
 * 4. The signal is keyed to the armed target's CONTINUATION, not to
 *    whichever drain runs next: an unrelated finite eval whose own
 *    drain executes real bytecode (polling the interrupt handler many
 *    times) is neither broken nor consumes the signal, and an
 *    unrelated settlement drain (a call no tracked eval awaits) does
 *    not fire it either — the armed state survives unrelated drains
 *    intact and breaks the target at its actual next execution.
 * 5. A no-id interrupt with NOTHING BREAKABLE — every in-flight eval
 *    suspended on no pending host call (a never-settling local
 *    promise) — refuses without arming anything.
 * 6. `waitForCalls` sleeps only for the REMAINING wait budget: a short
 *    `timeoutMs` returns in that budget, never a fixed 50 ms poll
 *    overshoot (~51 ms for every sub-50 ms timeout).
 *
 * All suites disable the per-eval deadline (`evalTimeoutMs: 0`), so
 * the ONLY thing that can break a runaway here is the armed signal —
 * a regression hangs the operation and the test's watchdog fails it.
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

const PROJECT = '/tmp/repl-eval-break-project';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The fake held-open ACP session (the same shape as broker.test.ts's). */
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

async function setup(options: { runner?: BrokerRunner; evalTimeoutMs?: number } = {}): Promise<{
  ws: Workspace;
  broker: Broker;
}> {
  const ws = await Workspace.create(PROJECT);
  const broker = await Broker.attach(ws, {
    runner: options.runner,
    evalTimeoutMs: options.evalTimeoutMs ?? 0, // the deadline is DISABLED: only the armed signal can break a runaway
  });
  return { ws, broker };
}

function output(result: { output: string[] }): string[] {
  return result.output;
}

/** Race a broker operation against a watchdog: a regression that leaves
 *  the runaway unbroken (the deadline is disabled in this suite) must
 *  FAIL the test, not hang the run. */
async function bounded<T>(label: string, promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watchdog: ${label} did not settle in ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, watch]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── 1. waitForCalls releases the chain between pumps ───────────────────

test('review round 2: a concurrent cancelCall completes MID-WAIT (the wait does not hold the broker chain across its sleeps) and the wait\'s next pump observes the cancelled settlement', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  // The wait starts pumping c1 (a bounded poll: pump + sleep + re-poll).
  const waiting = broker.waitForCalls(['c1'], 30_000);
  await tick();
  // The interrupt lands while the wait is in flight: cancelCall must run
  // NOW (between the wait's pumps), not queue behind the whole 30 s
  // poll. The old code serialized the entire wait, so this call could
  // not complete until the wait finished or timed out — by which point
  // the target could already have completed.
  const outcome = await bounded('cancelCall mid-wait', broker.cancelCall('c1'));
  assert.equal(outcome, 'cancelled', 'the live session was cancelled mid-wait');
  // The wait's very next pump delivers the cancelled settlement: the
  // wait reports drained with the call completed (the cancel settles the
  // call as the recoverable AGENT_CANCELLED — the pump observes it).
  const { result, drained } = await bounded('wait after the mid-wait cancel', waiting);
  assert.equal(drained, true, 'the cancelled call drained the wait');
  assert.ok(result.completed.includes('c1'), `completed: ${result.completed.join(', ')}`);
  await broker.dispose();
  ws.dispose();
});

// ── 2. armEvalBreak lands mid-wait and breaks an EXECUTING runaway ─────

test('review round 2: the no-id interrupt breaks an EXECUTING runaway eval — an eval looping over subagent calls is in flight while a wait pumps it; the interrupt arms mid-wait and the wait\'s very next pump breaks the loop\'s next iteration MID-RUN (quickjs interrupt handler)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The running eval: a runaway whose body keeps EXECUTING across
  // drains (each iteration does real work, fires the next subagent call
  // and suspends — the eval is in flight the whole time, never
  // completing). A suspended-continuation test (the old one) armed the
  // signal against an eval that had never executed; this eval is
  // mid-run — being pumped by a live wait — when the interrupt lands.
  // (The per-iteration work matters: quickjs's interrupt counter only
  // polls the handler on a bytecode budget, so a bare `await agent()`
  // chunk can complete without a poll — a genuinely executing runaway
  // is doing work, and that work is what the handler breaks.)
  const a = await broker.eval(
    'const s = agent("pi/x", "task"); await s; for (;;) { let x = 0; for (let i = 0; i < 200000; i++) x += i; await agent("pi/x", "again"); }',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  await tick();
  // The wait starts pumping the eval's first call; the interrupt lands
  // WHILE THE WAIT IS IN FLIGHT — the old waitForCalls held the broker
  // serialization chain across its whole bounded poll, so this arm
  // could not be processed until the wait finished or timed out (up to
  // 120 s), by which point the target could already have completed.
  const waiting1 = broker.waitForCalls(['c1'], 30_000);
  await tick();
  const armed = await bounded('armEvalBreak mid-wait', broker.armEvalBreak());
  assert.equal(armed, true, 'the RUNNING eval was targeted while the wait pumped it');
  // The first settlement: the wait's very next pump resumes the loop's
  // next iteration — and the armed signal breaks it MID-RUN (with the
  // deadline disabled, only the signal can break it). The break is the
  // wait's own drain error — honest output in the wait's result — and
  // the settlement that resumed the broken iteration is still reported.
  runner.sessions[0].completeTurn('resumed');
  const waited1 = await bounded('wait#1 after the mid-run break', waiting1);
  assert.equal(waited1.drained, true, 'the settled call drained the wait');
  assert.ok(waited1.result.completed.includes('c1'), `completed: ${waited1.result.completed.join(', ')}`);
  assert.ok(
    output(waited1.result).some((line) => line.includes('interrupted')),
    `the executing runaway was broken mid-run: ${output(waited1.result).join('\n')}`,
  );
  // The broken eval is released and the signal was consumed: the next
  // eval runs normally, and a later arm REFUSES (no stale target — the
  // interrupted continuation's wrapper never settles, so only the
  // interrupted-drain release could have cleared it).
  const after = await broker.eval('6 * 7');
  assert.equal(after.result, '42');
  assert.equal(await broker.armEvalBreak(), false, 'nothing is tracked after the break');
  await broker.dispose();
  ws.dispose();
});

// ── 3. The signal rides a direct eval's own drain (checkpoint.answer) ──

test('review round 2: a suspended eval\'s continuation resumed by checkpoint.answer inside a LATER eval\'s own drain is broken mid-run by the armed signal — and the interrupted drain releases the tracked eval', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // eval A suspends on a checkpoint; its continuation is a runaway loop.
  const a = await broker.eval('const q = checkpoint("go?"); await q; while (true) {}');
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  // The interrupt arms against the running eval.
  assert.equal(await broker.armEvalBreak(), true);
  // eval B answers the checkpoint: the answer is a SYNCHRONOUS
  // host-callback settlement — the continuation is resumed inside B's
  // OWN drain, an execution the old settlement-drain-only signal was
  // blind to (the runaway would burn the eval deadline instead of being
  // broken by the interrupt). With the deadline disabled, only the
  // armed signal can break it.
  const b = await bounded(
    'eval B answering the checkpoint',
    broker.eval('checkpoint.answer("c1", "go"); "answered"'),
  );
  assert.equal(b.result, undefined, 'the answering eval was interrupted before producing a result');
  assert.ok(
    output(b).some((line) => line.includes('interrupted')),
    `the resumed runaway was broken mid-run in the answering eval's drain: ${output(b).join('\n')}`,
  );
  // The interrupted continuation's wrapper never settles — the
  // interrupted-drain release (not the sweep) is what frees the tracked
  // eval: a later arm refuses, and the next eval runs normally.
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  const after = await broker.eval('6 * 7');
  assert.equal(after.result, '42');
  // The signal was consumed by the running eval's execution: an
  // UNRELATED eval's own code was never broken (the phase-E review
  // rejection's targeting discipline) — the next arm still targets a
  // genuinely running eval and breaks IT mid-run.
  const c = await broker.eval(
    'const p2 = agent("pi/x", "task2"); await p2; for (;;) { let y = 0; for (let j = 0; j < 200000; j++) y += j; await agent("pi/x", "again2"); }',
  );
  assert.ok(c.pending.includes('c2'), `pending: ${c.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'a later running eval is targetable');
  runner.last().completeTurn('resumed');
  // Let the turn-resolution microtasks land (the task's readiness flag
  // is set by a promise continuation) before the pumping eval runs.
  await tick();
  const d = await broker.eval('"probe"');
  assert.ok(
    output(d).some((line) => line.includes('interrupted')),
    `the second runaway was broken by the second arm: ${output(d).join('\n')}`,
  );
  await broker.dispose();
  ws.dispose();
});

// ── 4. The signal is keyed to the armed target's continuation ──────────

test('review round 3: an UNRELATED finite eval whose own drain executes real bytecode neither consumes the eval-break signal nor is broken by it — the armed state survives and breaks the target at its actual next execution (the carried review defect: every later eval\'s drain installed the drainInterruptHandler, so an unrelated finite eval B was interrupted and noteInterruptedDrain cleared A\'s tracking while A\'s checkpoint stayed pending and uninterruptible)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // eval A suspends on a checkpoint; its continuation is a runaway loop.
  const a = await broker.eval('const q = checkpoint("go?"); await q; while (true) {}');
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  // The interrupt arms against the running eval (its resume key: c1).
  assert.equal(await broker.armEvalBreak(), true);
  // Unrelated finite eval B whose DRAIN executes real bytecode — a
  // microtask with a 200k-iteration loop polls the quickjs interrupt
  // handler many times. The carried defect: B's own drain installed the
  // armed drainInterruptHandler unconditionally, so the FIRST poll
  // fired it — B was interrupted mid-run, and the interrupted-drain
  // release cleared A's tracking (c1 stayed pending and UNINTERRUPTIBLE).
  const b = await bounded(
    'unrelated finite eval with a bytecode-heavy drain',
    broker.eval('Promise.resolve().then(() => { let x = 0; for (let i = 0; i < 200000; i++) x += i; return "B-done"; });'),
  );
  assert.ok(
    b.result !== undefined && b.result.includes('B-done'),
    `the unrelated eval completed normally, never interrupted: ${output(b).join('\n')}`,
  );
  // The armed state SURVIVED B: answering c1 resumes A's runaway in the
  // answering eval's own drain, and the still-armed signal breaks it
  // MID-RUN — the exact execution the interrupt targeted.
  const c = await bounded(
    'eval C answering the checkpoint after the unrelated drain',
    broker.eval('checkpoint.answer("c1", "go"); "answered"'),
  );
  assert.ok(
    output(c).some((line) => line.includes('interrupted')),
    `the armed signal survived the unrelated drain and broke the target: ${output(c).join('\n')}`,
  );
  // The broken target was released: a later arm refuses.
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

test('review round 3: an UNRELATED settlement drain (a call no tracked eval awaits) neither fires nor consumes the eval-break signal — the armed state survives and breaks the target at its actual next execution', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // A RESOLVED eval leaves a pending agent call whose continuation does
  // real bytecode when it settles (a .then with a 200k-iteration loop):
  // its settlement drain polls the interrupt handler many times. NO
  // tracked eval awaits c1 (the founding eval resolved).
  await broker.eval('const p = agent("pi/x", "task").then((v) => { let x = 0; for (let i = 0; i < 200000; i++) x += i; return v; }); "started"');
  await tick();
  // eval A suspends on a checkpoint; its continuation is a runaway loop.
  const a = await broker.eval('const q = checkpoint("go?"); await q; while (true) {}');
  assert.ok(a.pending.includes('c2'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true)
  // The unrelated call settles: the pump's drain runs c1's bytecode-
  // heavy continuation, polling the armed handler — which must NOT fire
  // (c1 is not one of the armed target's resume keys; the drain does
  // not belong to the target). The carried defect fired on any drain.
  runner.sessions[0].completeTurn('unrelated');
  await tick();
  const probe = await bounded('probe eval after the unrelated settlement', broker.eval('"probe"'));
  assert.ok(
    probe.result !== undefined && probe.result.includes('probe'),
    `the unrelated settlement did not fire the signal: ${output(probe).join('\n')}`,
  );
  // The armed state SURVIVED the unrelated settlement: answering c2
  // resumes A's runaway in the answering eval's own drain and the
  // still-armed signal breaks it mid-run.
  const c = await bounded('eval C answering the checkpoint', broker.eval('checkpoint.answer("c2", "go"); "answered"'));
  assert.ok(
    output(c).some((line) => line.includes('interrupted')),
    `the armed signal survived the unrelated settlement drain: ${output(c).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

// ── 5. Nothing breakable → refuse without arming ───────────────────────

test('review round 3: a no-id interrupt with NOTHING BREAKABLE — an in-flight eval suspended on NO pending host call (a never-settling local promise, so no execution can ever resume it) — REFUSES and arms nothing', async () => {
  const { ws, broker } = await setup();
  // The eval suspends (its completion stays pending) with ZERO pending
  // host calls: no settlement can ever queue its continuation, so there
  // is no execution to break. Arming would be dead weight that lingers
  // until reset — the guidance's refusal rule.
  const a = await broker.eval('await new Promise(() => {}); "never"');
  assert.equal(a.result, undefined, 'the eval suspended — no completion value');
  assert.deepEqual(a.pending, [], 'no pending host call');
  assert.equal(await broker.armEvalBreak(), false, 'nothing breakable — refused, nothing armed');
  // Nothing was armed: a later eval runs normally.
  const after = await broker.eval('6 * 7');
  assert.equal(after.result, '42');
  await broker.dispose();
  ws.dispose();
});

// ── 6. The wait sleeps only for the remaining budget ───────────────────

test('review round 3: waitForCalls respects the REMAINING wait budget — a 10 ms timeout returns in ~10 ms, never the fixed 50 ms poll overshoot (~51 ms for every sub-50 ms timeout: the carried review defect)', async () => {
  const { ws, broker } = await setup();
  // A parked checkpoint keeps c1 pending forever (no runner needed):
  // the wait pumps (nothing ready), sleeps, and must return at its
  // deadline.
  const raised = await broker.eval('const q = checkpoint("go?"); "raised"');
  assert.ok(raised.pending.includes('c1'), `pending: ${raised.pending.join(', ')}`);
  const started = Date.now();
  const { result, drained } = await bounded('bounded 10 ms wait', broker.waitForCalls(['c1'], 10));
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the parked checkpoint never settles — "still running"');
  assert.deepEqual(result.pending, ['c1'], 'the pending ids are reported');
  // The old code slept a fixed 50 ms per pump regardless of the budget
  // (~51 ms total for a 10 ms wait). The remaining-budget sleep must
  // return within the requested bound plus a generous scheduling
  // margin — 45 ms is 4.5x the budget and far under the old overshoot.
  assert.ok(elapsed < 45, `the 10 ms wait returned in ${elapsed} ms (the fixed 50 ms overshoot is gone)`);
  await broker.dispose();
  ws.dispose();
});

// ── 7. Round 4: the armed identity is the calls the eval AWAITS ────────

test('review round 4: an UNAWAITED SIBLING call (c2.then with a bytecode-heavy continuation) neither fires nor consumes the eval-break signal — settling c2 runs its own .then to completion, the awaited c1 stays pending, the armed target stays tracked (a later arm still returns true), and the target breaks at c1\'s actual settlement (the carried defect: every call an eval CREATED was a resume key, so settling the unawaited sibling interrupted its unrelated heavy .then, left c1 pending, and made the next arm refuse)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The eval AWAITS c1 but only TENS c2: `await c1` is a top-level await
  // (instrumented — recorded as a resume key); `c2.then(...)` is not an
  // await (never recorded). The carried defect treated every call the
  // eval created as a resume key.
  const a = await broker.eval(
    'const c1 = agent("pi/x", "one"); const c2 = agent("pi/x", "two"); const heavy = c2.then((v) => { let x = 0; for (let i = 0; i < 200000; i++) x += i; return "heavy:" + v; }); await c1; while (true) {}',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.ok(a.pending.includes('c2'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'the running eval is targetable (it awaits c1)');
  // The UNAWAITED sibling settles first: its drain runs c2's OWN heavy
  // .then continuation — 200k iterations polling the armed interrupt
  // handler — and must COMPLETE (the drain does not belong to the
  // target: c2 is not one of its resume keys).
  runner.sessions[1].completeTurn('sibling');
  await tick();
  const probe = await bounded('probe after the unawaited sibling settled', broker.eval('await heavy'));
  assert.ok(
    probe.result !== undefined && probe.result.includes('heavy:sibling'),
    `the unawaited sibling's own .then ran to completion, never interrupted: ${output(probe).join('\n')}`,
  );
  assert.ok(
    !output(probe).some((line) => line.includes('interrupted')),
    `no execution was interrupted by the sibling's settlement: ${output(probe).join('\n')}`,
  );
  // The armed state SURVIVED the unrelated settlement: the target is
  // still tracked and c1 is still pending (the carried defect: the
  // signal was consumed and the tracked eval released, so this arm
  // returned false and c1 became uninterruptible).
  assert.equal(await broker.armEvalBreak(), true, 'the target is still tracked after the sibling settlement');
  assert.ok((await broker.eval('"still-pending"')).pending.includes('c1'), 'c1 is still pending');
  // The awaited call settles: the eval\'s continuation (the runaway
  // loop) executes and the still-armed signal breaks it MID-RUN.
  runner.sessions[0].completeTurn('resumed');
  await tick();
  const broken = await bounded('probe after the awaited call settled', broker.eval('"after"'));
  assert.ok(
    output(broken).some((line) => line.includes('interrupted')),
    `the awaited call's settlement resumed the runaway continuation and the armed signal broke it: ${output(broken).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

test('review round 4: a RUNNING eval awaiting an EARLIER eval\'s binding remains targetable — `await p` on a promise a previous eval created logs the call as THIS eval\'s resume key (the carried defect: an eval\'s resume keys were the calls it CREATED, so this eval had none and the arm refused)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // eval 1 creates the call and resolves; the binding outlives the eval.
  const first = await broker.eval('const p = agent("pi/x", "earlier"); "started"');
  assert.ok(first.pending.includes('c1'), `pending: ${first.pending.join(', ')}`);
  // eval 2 awaits the EARLIER binding: its continuation is queued by
  // c1's settlement — exactly the execution the interrupt must be able
  // to break.
  const second = await broker.eval('await p; while (true) {}');
  assert.ok(second.pending.includes('c1'), `pending: ${second.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'an eval awaiting an earlier binding is targetable');
  // Settling c1 resumes eval 2's continuation (the runaway loop): the
  // armed signal breaks it mid-run.
  runner.last().completeTurn('resumed');
  await tick();
  const probe = await bounded('probe after settling the earlier binding', broker.eval('"probe"'));
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the resumed continuation was broken mid-run: ${output(probe).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

// ── 8. Round 4: the wait's chain ACQUISITION is deadline-bounded ───────

test('review round 4: waitForCalls\'s chain acquisition is bounded by the wait deadline — a bounded wait queued behind a long chain hold (the client-presence drain pumping a slow turn) returns at its bound, not behind the drain (the carried defect: a 20 ms wait behind a 250 ms eval took ~253 ms because the acquisition enqueued with no deadline)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // A slow turn keeps the client-presence drain pumping: the drain is
  // ONE serialized op, so its internal pumps/sleeps HOLD the broker
  // serialization chain for the whole bounded run (the event loop stays
  // free — the drain sleeps between pumps).
  const a = await broker.eval('const p = agent("pi/x", "slow"); await p; "done"');
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  const draining = broker.drainForDisconnect(2000, () => false);
  await tick();
  // The 30 ms wait's acquisitions must race the REMAINING budget: with
  // the chain held by the drain, the wait reports "still running" at
  // its bound instead of queueing behind the drain.
  const started = Date.now();
  const { result, drained } = await bounded('bounded wait behind the drain', broker.waitForCalls(['c1'], 30));
  const elapsed = Date.now() - started;
  assert.equal(drained, false, 'the slow turn never settled within the wait bound — "still running"');
  assert.deepEqual(result.pending, ['c1'], 'the target ids are reported (none observed settled)');
  assert.ok(elapsed < 80, `the 30 ms wait returned at its bound (${elapsed} ms), not behind the drain`);
  // The drain still completes its work once the turn settles: the turn
  // drains to completion and the children release (the doc's graceful
  // drain is unaffected by the wait's bounded acquisition).
  await new Promise((resolve) => setTimeout(resolve, 150));
  runner.sessions[0].completeTurn('slow-done');
  assert.equal(await bounded('drain completion', draining), true, 'the drain drained the turn to completion');
  await broker.dispose();
  ws.dispose();
});
