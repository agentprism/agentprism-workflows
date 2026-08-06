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
 * Round 5 (the carried review's defects) adds:
 * 7. The signal is keyed to the armed eval's CONTINUATION, not to
 *    settled call ids: an unawaited sibling `.then` registered BEFORE
 *    the target's await runs FIRST in the settlement drain (before the
 *    lease-setting reaction) — it can neither fire nor consume the
 *    signal, and the target's own continuation (the job after the
 *    reaction) is the execution broken mid-run.
 * 8. Indirect waits are targetable: `await Promise.all([q])` arms and
 *    the continuation breaks when q settles (the identity is the
 *    promise graph, not a logged call-id list).
 * 9. A zero `timeoutMs` wait still performs ONE immediately available
 *    state read: an idle workspace drains (`drained: true`), and a
 *    pending call's surface reads as pending (the old code returned
 *    unacquired with the deadline already past).
 * 10. The instrumenter is HYGIENIC: a guest lexical `__replAwait`
 *    shadow cannot change the program's semantics (the injected seam
 *    is `this["__replAwait"]` — the keyword base is unshadowable, and
 *    no helper binding is injected into the persistent global lexical
 *    record).
 *
 * Round 6 (the carried review's defects) adds:
 * 11. The lease is associated with the ACTUAL CONTINUATION JOB, not
 *    the next job: a sibling `q.then(...)` registered AFTER the
 *    target's await runs after the wrapper's settlement but BEFORE the
 *    lease-setting reaction (the reaction now rides the WRAPPER
 *    itself, immediately before the await machinery's own) — the
 *    sibling completes (siblingDone), the target's continuation is the
 *    job broken mid-run (targetDone never happens).
 * 12. The for-await ITERABLE wrap preserves the iterable protocol: a
 *    `for await` loop over `[1, 2]` (or an async generator, or an
 *    awaited iterable) iterates normally through the broker — the
 *    0.3.0 wrap returned a promise, making every loop throw
 *    `TypeError: not a function` — and a running loop remains
 *    breakable mid-iteration through the per-iteration lease.
 *
 * Round 7 (the reviewer's rejection of the previous attempt) adds:
 * 13. The for-await iterable wrap passes SYNC iterable values through
 *    AsyncFromSyncIteratorContinuation semantics: `for await (const x
 *    of [Promise.resolve(1), 2])` yields the RESOLVED `[1, 2]` through
 *    the broker — never the promise objects.
 * 14. The await instrumentation is semantically isolated from guest
 *    Promise sabotage: replacing `Promise.prototype.then` does not
 *    change the instrumented `await 40` (still `40`), and the
 *    continuation-lease targeting keeps working under the mutation.
 * 15. The continuation-lease availability check is VERSION-GATED: a
 *    RESTORED 0.3.0 library (whose lease-setting reaction still runs
 *    on the awaited VALUE's settlement — the carried sibling-reaction
 *    interrupt-targeting defect) reports `supportsContinuationLease:
 *    true` but is served WITHOUT instrumentation and the eval-break
 *    interrupt refuses — the flag alone would have re-armed the
 *    original defect on a supported older snapshot.
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
  ReplVm,
  type BrokerLoadSessionOptions,
  type BrokerOpenSessionOptions,
  type BrokerPromptOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
} from '../src/index.js';
import { buildGuestLibrarySource } from '../src/guest/guest-library.js';
import { getVmShim } from '../src/vm.js';
import type { JSValueHandle, QuickJS } from 'quickjs-wasi';

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

// ── 9. Round 5: the armed identity is the continuation, not settled ids ─

test('review round 5: an UNAWAITED SIBLING reaction registered BEFORE the target\'s await runs FIRST in the settlement drain — it can neither fire nor consume the eval-break signal, and the target\'s OWN continuation (the job after the lease-setting reaction) is the execution broken mid-run (the carried defect: settling q interrupted the sibling job, cleared the arm, and let the target continuation run later unbroken)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // `q.then(sibling)` is registered BEFORE `await q`: the reactions on
  // q are [sibling, lease-setting-reaction] in registration order, so
  // the settlement drain runs the sibling's bytecode-heavy continuation
  // FIRST — before any lease is set. The carried defect's signal was
  // keyed to settled call ids: the drain "belonged" to the target, the
  // FIRST poll fired on the sibling's job, the arm was consumed, and
  // the target's own continuation ran later with no protection.
  const a = await broker.eval(
    'const q = agent("pi/x", "one"); const sibling = q.then((v) => { let x = 0; for (let i = 0; i < 200000; i++) x += i; return "sibling:" + v; }); await q; while (true) {}',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'the running eval is targetable');
  // The awaited call settles: the drain runs [sibling, the target's
  // continuation]. The sibling job must COMPLETE (no lease is set yet —
  // the lease-setting reaction runs after it), and the target's own
  // continuation is the job broken mid-run.
  runner.sessions[0].completeTurn('resumed');
  await tick();
  const probe = await bounded('probe after settling the awaited call', broker.eval('await sibling'));
  assert.ok(
    probe.result !== undefined && probe.result.includes('sibling:resumed'),
    `the sibling continuation ran to completion, never interrupted: ${output(probe).join('\n')}`,
  );
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the target's own continuation was broken mid-run (not the sibling's job): ${output(probe).join('\n')}`,
  );
  // The broken eval was released (the interrupted job's continuation
  // lease named it exactly): a later arm refuses.
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

test('review round 5: an INDIRECT wait is targetable — `await Promise.all([q]); while (true) {}` arms (the 0.2.0 log refused it: the awaited value is the combinator\'s promise, not a registry promise) and the armed signal breaks the continuation mid-run when q settles (the identity is the promise graph)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The eval awaits Promise.all([q]) — an indirect chain whose
  // settlement is q's. The continuation lease rides the combinator
  // promise's settlement, exactly like a direct call's.
  const a = await broker.eval('const q = agent("pi/x", "one"); await Promise.all([q]); while (true) {}');
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'an eval awaiting an indirect chain is targetable');
  // Settling q resolves the Promise.all promise: the lease-setting
  // reaction runs, then the target's continuation (the runaway loop) —
  // broken mid-run by the armed signal.
  runner.sessions[0].completeTurn('resumed');
  await tick();
  const probe = await bounded('probe after settling the indirect chain', broker.eval('"probe"'));
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the indirect chain's continuation was broken mid-run: ${output(probe).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  const after = await broker.eval('6 * 7');
  assert.equal(after.result, '42', 'the workspace stays usable');
  await broker.dispose();
  ws.dispose();
});

// ── 10. Round 5: zero-timeout waits perform an immediate state read ───

test('review round 5: a ZERO-timeout wait still performs ONE immediately available state read — an idle workspace reports drained (the carried defect: the chain acquisition returned unacquired with the deadline already past, so even an immediately readable state reported "still running")', async () => {
  const { ws, broker } = await setup();
  const { result, drained } = await bounded('zero-timeout idle wait', broker.waitForCalls(undefined, 0));
  assert.equal(drained, true, 'an idle workspace drains immediately — the pending read was immediately available');
  assert.deepEqual(result.pending, [], 'the empty pending surface was read');
  assert.deepEqual(result.completed, []);
  await broker.dispose();
  ws.dispose();
});

test('review round 5: a ZERO-timeout wait on a workspace with a PENDING call reports the call as pending and "still running" (the carried defect: the unacquired acquisition reported an empty pending list)', async () => {
  const { ws, broker } = await setup();
  const raised = await broker.eval('const q = checkpoint("go?"); "raised"');
  assert.ok(raised.pending.includes('c1'), `pending: ${raised.pending.join(', ')}`);
  const { result, drained } = await bounded('zero-timeout pending wait', broker.waitForCalls(['c1'], 0));
  assert.equal(drained, false, 'the parked checkpoint never settles — "still running"');
  assert.deepEqual(result.pending, ['c1'], 'the pending surface was read immediately');
  await broker.dispose();
  ws.dispose();
});

// ── 11. Round 5: the instrumenter is hygienic ──────────────────────────

test('review round 5: the top-level-await instrumenter is HYGIENIC — a guest lexical `__replAwait` shadow cannot change the program\'s semantics (the 0.2.0 transform inserted the guest-resolvable identifier `__replAwait`, so `{ const __replAwait = () => 7; globalThis.seen = await Promise.resolve(42); }` yielded 7 instead of 42; the injected seam is now `this["__replAwait"]` — the keyword base is unshadowable)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('{ const __replAwait = () => 7; globalThis.seen = await Promise.resolve(42); } "done"');
  assert.equal(r.result, '"done"', `the eval completed normally: ${output(r).join('\n')}`);
  const seen = await broker.eval('seen');
  assert.equal(seen.result, '42', 'the REAL library seam ran — the guest shadow changed nothing');
  // The shadowing identifier stays usable as the guest declared it.
  const shadow = await broker.eval('{ const __replAwait = () => 7; globalThis.seen2 = __replAwait(); } "s"');
  assert.equal(shadow.result, '"s"');
  const seen2 = await broker.eval('seen2');
  assert.equal(seen2.result, '7', 'the guest\'s own shadowed identifier keeps its semantics');
  // The transform injects NO persistent helper binding (a top-level
  // const would redeclare on the loop idiom): the same code runs again.
  const again = await broker.eval('{ const __replAwait = () => 7; globalThis.seen3 = await Promise.resolve(9); } "again"');
  assert.equal(again.result, '"again"', `the loop idiom does not redeclare: ${output(again).join('\n')}`);
  const seen3 = await broker.eval('seen3');
  assert.equal(seen3.result, '9');
  await broker.dispose();
  ws.dispose();
});

// ── 12. Round 6: the lease is the continuation job, not the next job ───

test('review round 6: a sibling `q.then(...)` registered AFTER the target\'s await neither fires nor consumes the eval-break signal — the lease is set only by the WRAPPER reaction (immediately before the await machinery\'s own), so the sibling job completes and the target\'s OWN continuation is the job broken mid-run (the carried defect: the 0.3.0 lease-setting reaction ran on the awaited VALUE\'s settlement, so the sibling job ran between the lease set and the continuation, consumed the armed signal, and the target\'s continuation completed later UNPROTECTED — the siblingDone:false / targetDone:true repro)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // `await q` is evaluated FIRST (the wrap's resolve reaction is
  // registered on q at that moment); the sibling `q.then(...)` is
  // registered LATER, by a deferred microtask (so the reactions on q
  // are [wrap-resolve, sibling] in registration order). Settlement
  // queues [wrap-resolve, sibling] and the wrap-resolve job queues the
  // WRAPPER's [lease-setting, machinery] reactions AFTER the sibling —
  // the sibling job runs with NO lease set (it can neither fire nor
  // consume the armed signal), and the machinery job — the target's
  // actual continuation — starts with the lease set and is broken
  // mid-run. The 0.3.0 ordering set the lease inside the wrap-resolve
  // job: the sibling job then started with the lease set, the drain
  // attributed it, the interrupt broke the SIBLING, and the target's
  // continuation ran later with the arm consumed (targetDone).
  const a = await broker.eval(
    'const q = agent("pi/x", "one"); const deferred = Promise.resolve().then(() => q.then((v) => { let x = 0; for (let i = 0; i < 200000; i++) x += i; return "sibling:" + v; })); await q; while (true) {}',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'the running eval is targetable');
  // The awaited call settles: the drain runs [wrap-resolve, sibling,
  // lease-setting, continuation]. The sibling job must COMPLETE — with
  // the carried defect it was the job right after the lease set, so it
  // was interrupted instead and the deferred sibling promise never
  // settled (this probe would hang and the watchdog would fail).
  runner.sessions[0].completeTurn('resumed');
  await tick();
  const probe = await bounded('probe after settling the awaited call', broker.eval('await deferred'));
  assert.ok(
    probe.result !== undefined && probe.result.includes('sibling:resumed'),
    `the sibling reaction ran to completion, never interrupted: ${output(probe).join('\n')}`,
  );
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the target's own continuation was broken mid-run (not the sibling's job): ${output(probe).join('\n')}`,
  );
  // The broken eval was released (the interrupted job's continuation
  // lease named it exactly): a later arm refuses — the target never
  // completed (an interrupted continuation's wrapper never settles).
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

// ── 13. Round 6: for-await iterables keep the iterable protocol ────────

test('review round 6: the for-await ITERABLE wrap preserves the iterable protocol — `for await (const x of [1, 2])` iterates normally through the broker (the carried defect: the 0.3.0 instrumenter wrapped the iterable in `__replAwait`, whose promise result made the loop throw `TypeError: not a function` instead of iterating)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval(
    'globalThis.forAwaitSum = 0; for await (const x of [1, 2]) { globalThis.forAwaitSum += x; } "iterated"',
  );
  assert.equal(r.result, '"iterated"', `the for-await loop completed normally: ${output(r).join('\n')}`);
  const sum = await broker.eval('forAwaitSum');
  assert.equal(sum.result, '3', 'the loop iterated [1, 2] — the iterable protocol is preserved');
  // An ASYNC-GENERATOR iterable still iterates across drains (each
  // iteration's `next()`-result await rides the wrap's lease-wrapped
  // promises).
  const g = await broker.eval(
    'globalThis.g = (async function* () { yield 10; yield 20; })(); globalThis.genSum = 0; for await (const x of g) { globalThis.genSum += x; } "gen"',
  );
  assert.equal(g.result, '"gen"', `the async-generator loop completed: ${output(g).join('\n')}`);
  const genSum = await broker.eval('genSum');
  assert.equal(genSum.result, '30', 'the async generator yielded 10 then 20');
  // `for await (const x of await y)`: the iterable IS an awaited
  // expression — the instrumenter skips the iterable wrap (the loop
  // iterates the unwrapped value), so the shape keeps its semantics.
  const nested = await broker.eval(
    'globalThis.nestedSum = 0; for await (const x of await Promise.resolve([3])) { globalThis.nestedSum += x; } "nested"',
  );
  assert.equal(nested.result, '"nested"', `the awaited-iterable shape completed: ${output(nested).join('\n')}`);
  const nestedSum = await broker.eval('nestedSum');
  assert.equal(nestedSum.result, '3', 'the awaited iterable [3] iterated once');
  await broker.dispose();
  ws.dispose();
});

test('review round 6: a RUNNING for-await loop is breakable mid-iteration — the iterable wrap sets the continuation lease per iteration, so the armed signal breaks the loop\'s continuation exactly like any other awaited segment', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The loop's body awaits a host call every iteration: the eval is in
  // flight across drains (the loop never completes) and the interrupt
  // arms against it. The per-iteration lease (set by the iterable
  // wrap's next()-result reactions, immediately before the loop's
  // continuation job) makes the armed signal fire while the loop's own
  // continuation executes — with the 0.3.0 wrap the eval threw
  // `TypeError: not a function` at the first iteration (the wrap
  // returned a promise, not an async iterable) and was never targetable.
  // The per-iteration work matters exactly like the other runaway
  // suites: quickjs's interrupt counter only polls the handler on a
  // bytecode budget, so a bare `await agent()` chunk can complete
  // without a poll — the work loop is what the handler breaks mid-run.
  const a = await broker.eval(
    'const gen = (async function* () { for (;;) { yield 1; } })(); globalThis.ticks = 0; for await (const x of gen) { globalThis.ticks++; let y = 0; for (let i = 0; i < 200000; i++) y += i; await agent("pi/x", "tick"); } "done"',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'the running for-await eval is targetable');
  // The awaited call settles: the loop's continuation (the next
  // iteration's body) executes with the lease set and the armed signal
  // breaks it MID-RUN.
  runner.sessions[0].completeTurn('tick');
  await tick();
  const probe = await bounded('probe after settling the loop iteration', broker.eval('"probe"'));
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the loop's continuation was broken mid-run: ${output(probe).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Round 7 — the reviewer's rejection of the previous attempt
// ────────────────────────────────────────────────────────────────────────

test('review round 7: the instrumented for-await over a SYNC iterable yields the RESOLVED values through the broker — `for await (const x of [Promise.resolve(1), Promise.resolve(2)])` collects `[1, 2]`, never promise objects (the reviewer\'s repro: the result wrapper resolved with the RAW iterator result, and because the wrapper is an ASYNC iterable the machinery used the value as-is — the promise object leaked through Broker instead of `1`)', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval(
    'globalThis.round7sync = []; for await (const x of [Promise.resolve(1), Promise.resolve(2)]) { globalThis.round7sync.push(x); } "iterated"',
  );
  assert.equal(r.result, '"iterated"', `the loop completed: ${output(r).join('\n')}`);
  const kinds = await broker.eval('round7sync.map((x) => typeof x).join(",")');
  assert.equal(kinds.result, '"number,number"', 'the loop saw the RESOLVED numbers, never promise objects');
  const sum = await broker.eval('round7sync[0] + round7sync[1]');
  assert.equal(sum.result, '3', 'the resolved values are `1` and `2`');
  await broker.dispose();
  ws.dispose();
});

test('review round 7: the instrumented top-level await is semantically isolated from guest Promise sabotage — replacing `Promise.prototype.then` does not change `await 40` (the reviewer\'s repro: the instrumented await returned `99` where the native evaluation returned `40`), and the continuation-lease targeting keeps working under the mutation (the lease-setting reaction rides the captured pristine `then`)', async () => {
  const runner = new FakeRunner();
  const { ws, broker } = await setup({ runner });
  // The reviewer's exact repro at the broker boundary: with the
  // guest-resolvable `.then` in the mirroring machinery, the replaced
  // prototype hijacked the instrumented await; the captured pristine
  // `then` keeps the mirror native.
  const r = await broker.eval(
    'Promise.prototype.then = function () { return 99; }; const x = await Promise.resolve(40); globalThis.round7x = x; "done"',
  );
  assert.equal(r.result, '"done"', `the eval completed: ${output(r).join('\n')}`);
  const x = await broker.eval('round7x');
  assert.equal(x.result, '40', 'the instrumented await mirrors the native value under the replaced prototype');
  // The lease plumbing still works under the mutation: an eval
  // suspended on a call is targetable, and the armed signal breaks the
  // continuation (the job after the lease-setting reaction) mid-run —
  // the same end-to-end shape as the round-6 sibling regression, with
  // the prototype replaced.
  const a = await broker.eval(
    'const q = agent("pi/x", "research"); const out = await q; let y = 0; for (let i = 0; i < 200000; i++) y += i; globalThis.round7out = out; "waiting"',
  );
  assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
  assert.equal(await broker.armEvalBreak(), true, 'the suspended eval is targetable despite the replaced prototype');
  runner.sessions[0].completeTurn('result');
  await tick();
  const probe = await bounded('probe after settling the mutated-prototype eval', broker.eval('"probe"'));
  assert.ok(
    output(probe).some((line) => line.includes('interrupted')),
    `the continuation was broken mid-run under the mutation: ${output(probe).join('\n')}`,
  );
  assert.equal(await broker.armEvalBreak(), false, 'the broken eval is no longer tracked');
  await broker.dispose();
  ws.dispose();
});

/**
 * The emulated 0.3.0 library copy (review round 7): the shipped source
 * with the version marker at 0.3.0, the 0.3.0 LEASE-SET ORDERING (the
 * lease-setting reaction runs on the awaited VALUE's settlement — the
 * carried sibling-reaction interrupt-targeting defect: a sibling
 * `q.then(...)` registered after the eval started awaiting `q` runs
 * between the lease set and the continuation, consumes the armed
 * signal, and the target's continuation runs later unprotected), and no
 * iterable-lease capability. The broker's version gate must refuse to
 * instrument/arm on this copy even though it reports
 * `supportsContinuationLease: true` — the flag alone would have passed
 * the pre-round-7 check.
 */
function guestLibrary030Source(): string {
  const source = buildGuestLibrarySource('0.3.0');
  // The 0.3.0 `__replAwait` wrapper (the exact form the round-6
  // rejection described): the lease is set inside the job that resolves
  // the wrapper, whose reactions are registered on the awaited VALUE.
  const wrapper030 = `return new Promise(function (resolve, reject) {
          Promise.resolve(value).then(
            function (v) {
              try {
                setContinuationLease(token);
              } catch (_e) {}
              resolve(v);
            },
            function (e) {
              try {
                setContinuationLease(token);
              } catch (_e) {}
              reject(e);
            },
          );
        });`;
  // The 0.3.1 wrapper the shipped source carries (the lease-setting
  // reaction rides the WRAPPER promise itself, registered before the
  // await machinery's own reaction).
  const wrapper031 = `var wrapper = new P(function (resolve, reject) {
          try {
            pThen.call(PResolve(value), resolve, reject);
          } catch (e) {
            reject(e);
          }
        });
        pThen.call(
          wrapper,
          function () {
            try {
              setContinuationLease(token);
            } catch (_e) {}
          },
          function () {
            try {
              setContinuationLease(token);
            } catch (_e) {}
          },
        );
        return wrapper;`;
  const patched = source.replace(wrapper031, wrapper030);
  if (patched === source) {
    throw new Error('round-7 fixture: could not patch the 0.3.1 wrapper into the 0.3.0 ordering');
  }
  // The 0.3.0 copy has no iterable-lease capability.
  const flagged = patched.replace('supportsIterableLease: true,', 'supportsIterableLease: false,');
  if (flagged === patched) {
    throw new Error('round-7 fixture: could not patch the iterable-lease flag');
  }
  return flagged;
}

test('review round 7: a RESTORED 0.3.0 library is served WITHOUT instrumentation and the eval-break interrupt REFUSES — the continuation-lease availability check is VERSION-GATED on 0.3.1 (the reviewer\'s finding: the 0.3.0 copy reports `supportsContinuationLease: true` but its helper still carries the sibling-reaction interrupt-targeting defect, so the flag alone re-armed the original defect on a supported older snapshot)', async () => {
  const runner = new FakeRunner();
  // Build an emulated 0.3.0 library copy, install it in a bare VM (with
  // the four __host_* globals, exactly like the pre-snapshot host the
  // fixture stands in for), snapshot it, and restore the workspace: the
  // restored copy is served as-is (the doc's older-library rule — never
  // re-injected).
  const vm = await ReplVm.create();
  const shim = getVmShim(vm) as QuickJS;
  const noopHost = (_args: unknown[]): JSValueHandle | undefined => undefined;
  for (const name of ['__host_agent', '__host_checkpoint', '__host_agent_steer', '__host_console']) {
    const fnHandle = shim.newFunction(name, noopHost);
    shim.setProp(shim.global, name, fnHandle);
    fnHandle.dispose();
  }
  const installed = await vm.evalCode(guestLibrary030Source());
  assert.equal(installed.kind, 'value', `the emulated 0.3.0 library installed: ${JSON.stringify(installed).slice(0, 200)}`);
  // ReplVm does not expose snapshot(); the shim does (the workspace
  // layer's own snapshot() is exactly this call).
  const snapshot = shim.snapshot();
  vm.dispose();
  const ws = await Workspace.restore(PROJECT, snapshot);
  const broker = await Broker.attach(ws, { runner, evalTimeoutMs: 0 });
  try {
    const surface = ws.surface()!;
    assert.equal(surface.version, '0.3.0', 'the restored copy reports its own version');
    assert.equal(surface.supportsContinuationLease, true, 'the 0.3.0 copy reports the flag — the OLD gate would have accepted it');
    assert.equal(surface.supportsIterableLease, false, 'the 0.3.0 copy has no iterable-lease capability');
    // An eval suspends on a call — in flight, and in principle
    // targetable (the exact shape the pre-gate arm would have armed).
    // The sibling `.then` is registered AFTER the await: with the 0.3.0
    // lease-set ordering it would run between the lease set and the
    // continuation (and consume the armed signal); with NO
    // instrumentation it runs natively and never sees a lease.
    const a = await broker.eval(
      'globalThis.round7sibling = null; const q = agent("pi/x", "research"); const x = await q; q.then(() => { globalThis.round7sibling = __replLease; }); globalThis.round7done = x; "waiting"',
    );
    assert.ok(a.pending.includes('c1'), `pending: ${a.pending.join(', ')}`);
    assert.equal(
      await broker.armEvalBreak(),
      false,
      'the eval-break interrupt REFUSES on the restored 0.3.0 copy — nothing is armed (the version gate)',
    );
    // A no-id interrupt with nothing armed must not have armed anything:
    // the target stays trackable and the workspace stays healthy.
    const still = await broker.armEvalBreak();
    assert.equal(still, false, 'still refused');
    // The eval completes natively when the call settles — the sibling
    // reaction and the continuation both run, exactly like an
    // un-instrumented workspace.
    runner.sessions[0].completeTurn('result');
    await tick();
    const probe = await bounded('probe after settling the 0.3.0-copy eval', broker.eval('"probe"'));
    assert.equal(probe.result, '"probe"', `the workspace stays healthy: ${output(probe).join('\n')}`);
    const sibling = await broker.eval('round7sibling === undefined ? "unset" : round7sibling');
    assert.equal(sibling.result, '"unset"', 'no instrumentation ran — the sibling never observed a continuation lease (the 0.3.0 lease-set defect was never re-armed)');
    const done = await broker.eval('round7done');
    assert.equal(done.result, '"result"', 'the continuation settled natively with the turn text');
  } finally {
    await broker.dispose();
    ws.dispose();
  }
});
