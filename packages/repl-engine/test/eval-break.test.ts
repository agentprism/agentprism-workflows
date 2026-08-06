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
 * All three suites disable the per-eval deadline (`evalTimeoutMs: 0`),
 * so the ONLY thing that can break a runaway here is the armed signal —
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
