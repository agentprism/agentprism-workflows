/**
 * Broker tests (phase C): the broker wires a workspace's guest bridge to
 * ACP subagent sessions through acp-agents. Pins the doc's deliverables
 * against a FAKE runner/session (a real backend needs live credentials —
 * the capability negotiation and wire behavior are mocked structurally):
 *
 * - the eval tool-result shapes (resolved / suspended / rejected),
 * - the agent call round trip with continuation-at-settlement,
 * - exactly-once settlement, including a simulated crash between the
 *   store write and the guest settlement (both the live retry and the
 *   snapshot/restore + reconcile path),
 * - late uncaught rejections surfacing as error-level console lines in
 *   the next tool result,
 * - the checkpoint round trip (raise → previewed question → answer in a
 *   later eval → settlement within that eval),
 * - steering outcome visibility: a backend WITH and WITHOUT the
 *   `_session/steering` extension (injected / queued / startedNewTurn /
 *   failed / cancelled / idle),
 * - the concurrency cap (dispatch-time refusal, slot release on
 *   settlement),
 * - trap-free result rendering and the output caps.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Broker,
  JsonlCallStore,
  Workspace,
  type BrokerOpenSessionOptions,
  type BrokerRunner,
  type BrokerSession,
  type BrokerTurn,
  type ReplEvalResult,
} from '../src/index.js';

const PROJECT = '/tmp/repl-broker-project';

/** Let queued host microtasks (openSession continuations, readiness
 *  flags) run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake held-open ACP session: the test drives turns and steer calls. */
class FakeSession implements BrokerSession {
  readonly sessionId: string;
  capabilities: { supportsSteering: boolean } | undefined;
  readonly prompts: Array<{ content: string; resolve: (turn: BrokerTurn) => void; reject: (error: unknown) => void }> = [];
  readonly steers: Array<{ content: string; resolve: (outcome: string) => void; reject: (error: unknown) => void }> = [];
  cancelled = 0;
  stopReason = 'end_turn';
  readonly texts: string[] = [];
  /** The assistant text of each COMPLETED turn (the result-shaping
   *  source the broker reads — the prompt texts are in `texts`). */
  readonly completedTexts: string[] = [];

  constructor(readonly openedWith: BrokerOpenSessionOptions) {
    this.sessionId = `fake-session-${FakeSession.nextId++}`;
    this.capabilities = { supportsSteering: true };
  }

  static nextId = 0;

  prompt(content: string): Promise<BrokerTurn> {
    this.texts.push(content);
    return new Promise((resolve, reject) => {
      this.prompts.push({ content, resolve, reject });
    });
  }

  steer(content: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.steers.push({ content, resolve, reject });
    });
  }

  cancel(): Promise<void> {
    this.cancelled++;
    // The real session settles the in-flight turn with stopReason
    // "cancelled"; the fake mirrors that.
    for (const pending of this.prompts.splice(0)) {
      pending.resolve({ stopReason: 'cancelled', text: '' });
    }
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

  /** The broker's openSession lands asynchronously; wait for it. */
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

  completeSteer(outcome: string): void {
    const pending = this.steers.shift();
    assert.ok(pending, 'a steer wire call must be in flight');
    pending.resolve(outcome);
  }

  failSteer(error: unknown): void {
    const pending = this.steers.shift();
    assert.ok(pending, 'a steer wire call must be in flight');
    pending.reject(error);
  }
}

/** A fake runner: opens fake sessions, records what was requested. The
 *  steering capability is negotiated at initialize — the fake models that
 *  by stamping every session it opens from `supportsSteering` (the
 *  broker captures the capability ONCE, at session open). */
class FakeRunner implements BrokerRunner {
  readonly sessions: FakeSession[] = [];
  readonly openedWith: BrokerOpenSessionOptions[] = [];
  supportsSteering = true;

  async openSession(opts: BrokerOpenSessionOptions): Promise<FakeSession> {
    const session = new FakeSession(opts);
    session.capabilities = { supportsSteering: this.supportsSteering };
    this.sessions.push(session);
    this.openedWith.push(opts);
    return session;
  }

  async dispose(): Promise<void> {}

  last(): FakeSession {
    assert.ok(this.sessions.length > 0, 'a session must have been opened');
    return this.sessions[this.sessions.length - 1];
  }
}

/** Create a workspace + attached broker with a fake runner. */
async function setup(options: { maxConcurrentAgents?: number; runner?: FakeRunner; store?: ConstructorParameters<typeof Broker['attach']>[1]['store'] } = {}) {
  const ws = await Workspace.create(PROJECT);
  const runner = options.runner ?? new FakeRunner();
  const broker = await Broker.attach(ws, {
    runner,
    store: options.store,
    maxConcurrentAgents: options.maxConcurrentAgents,
  });
  return { ws, broker, runner };
}

function output(r: ReplEvalResult): string[] {
  return r.output;
}

/** Dispatch one agent call and wait until its session is open with the
 *  initial turn in flight. */
async function dispatchAgent(
  broker: Broker,
  runner: FakeRunner,
  code = 'const pi = agent("pi/deepseek-v4-flash-max", "research X"); "started"',
): Promise<void> {
  const r = await broker.eval(code);
  assert.ok(r.result !== undefined, `dispatch eval must complete: ${JSON.stringify(r)}`);
  await tick();
  assert.equal(runner.sessions.length, 1);
  assert.equal(runner.last().prompts.length, 1, 'the initial turn is in flight');
}

// ────────────────────────────────────────────────────────────────────────
// Eval shapes
// ────────────────────────────────────────────────────────────────────────

test('eval shapes: resolved reports the previewed value; suspended lists pending ids with no fabricated value; rejected reports the error line', async () => {
  const { ws, broker, runner } = await setup();

  // Resolved: the completion value is previewed (trap-free, see the
  // accessor test below).
  const resolved = await broker.eval('6 * 7');
  assert.equal(resolved.result, '42');
  assert.equal(resolved.pending.length, 0);
  assert.deepEqual(resolved.output, []);
  assert.deepEqual(resolved.completed, []);

  // Microtask-only awaits resolve within the drain.
  const micro = await broker.eval('await Promise.all([1, 2]).then(([a, b]) => a + b)');
  assert.equal(micro.result, '3');

  // Object completion values preview per FORMAT.md (nested values are
  // property-level tokens, never expanded).
  const obj = await broker.eval('({ sections: [{ title: "Auth flow" }], n: 3 })');
  assert.equal(obj.result, '{sections: Array(1), n: 3}');

  // Rejected: the error renders as an error-level line; result is absent.
  const rejected = await broker.eval('throw new Error("boom")');
  assert.equal(rejected.result, undefined);
  assert.ok(output(rejected).some((line) => line.includes('Error: boom')));
  assert.equal(rejected.pending.length, 0);

  // Top-level return stays a syntax error (the doc's pinned shape).
  const syntax = await broker.eval('return 1');
  assert.equal(syntax.result, undefined);
  assert.ok(output(syntax).some((line) => line.startsWith('SyntaxError')));

  // Suspended: no fabricated value, the pending call ids are listed.
  const suspended = await broker.eval('const r = await agent("pi/deepseek-v4-flash-max", "task"); "done:" + r');
  assert.equal(suspended.result, undefined, 'no fabricated value');
  assert.deepEqual(suspended.pending, ['c1']);
  assert.deepEqual(output(suspended), []);

  // Started-not-awaited handles list their pending id too.
  const started = await broker.eval('const second = agent("pi/x", "other"); "ok"');
  assert.equal(started.result, '"ok"');
  assert.deepEqual(started.pending, ['c1', 'c2']);

  // Settle both; the suspended eval's continuation runs at settlement.
  runner.sessions[0].completeTurn('hello');
  runner.sessions[1].completeTurn('world');
  await tick();
  const pumped = await broker.pump();
  assert.deepEqual(pumped, ['c1', 'c2']);
  await ws.dispose();
});

test('a suspended eval continues at settlement like a .then: its output lands in the next tool result', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('const r = await agent("pi/x", "task"); console.log("got", r); "done:" + r');
  assert.equal(r1.kind ?? undefined, undefined);
  assert.deepEqual(r1.pending, ['c1']);
  await tick();
  runner.last().completeTurn('hello');
  await tick();
  await broker.pump();
  const r2 = await broker.eval('"probe"');
  assert.ok(
    output(r2).some((line) => line.includes('"hello"')) && output(r2).some((line) => line.includes('got')),
    `continuation output: ${output(r2).join('\n')}`,
  );
  await ws.dispose();
});

test('a late uncaught rejection of a suspended eval surfaces as an error-level console line in the next tool result', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('const p = agent("pi/x", "research"); await p; "never"');
  assert.deepEqual(r1.pending, ['c1']);
  await tick();
  // The worker fails AFTER the eval returned: the completion promise
  // rejects late, and the rejection bridge routes it into the console
  // bridge (error-level, $N-frozen) instead of vanishing.
  runner.last().failTurn(new Error('research failed'));
  await tick();
  await broker.pump();
  const r2 = await broker.eval('"probe"');
  const errorLines = output(r2).filter((line) => line.startsWith('error: '));
  assert.equal(errorLines.length, 1, `one error line, got: ${output(r2)}`);
  assert.ok(errorLines[0].includes('Error: research failed'), errorLines[0]);
  assert.ok(errorLines[0].includes('[$1 · error ·'), errorLines[0]);
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Agent options and result shaping
// ────────────────────────────────────────────────────────────────────────

test('agent options: the guest option bag maps onto the runner (cwd default, label, runId, keepSession, retainSessionLog)', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner, 'const pi = agent("pi/deepseek-v4-flash-max", "research X", { configOptions: { thinking: true }, label: "my label" }); "ok"');
  const opened = runner.openedWith[0];
  assert.equal(opened.model, 'pi/deepseek-v4-flash-max');
  assert.equal(opened.cwd, PROJECT, 'cwd defaults to the workspace project dir');
  assert.deepEqual(opened.configOptions, { thinking: true });
  assert.equal(opened.label, 'my label');
  assert.equal(opened.runId, 'c1');
  assert.equal(opened.keepSession, true);
  assert.equal(opened.retainSessionLog, true);
  await ws.dispose();
});

test('agent options: a relative cwd and unknown keys refuse the call with recoverable: false', async () => {
  const { ws, broker } = await setup();
  const r1 = await broker.eval('await agent("pi/x", "t", { cwd: "relative" }).catch(e => e.code + "/" + e.recoverable)');
  assert.equal(r1.result, '"SCRIPT_VALIDATION_ERROR/false"');
  const r2 = await broker.eval('await agent("pi/x", "t", { bogus: 1 }).catch(e => e.code)');
  assert.equal(r2.result, '"SCRIPT_VALIDATION_ERROR"');
  const r3 = await broker.eval('await agent("pi/x", "t", { schema: 42 }).catch(e => e.code)');
  assert.equal(r3.result, '"SCRIPT_VALIDATION_ERROR"');
  await ws.dispose();
});

test('the structured-output schema is validated by acp-agents\' own ladder (parse → validate → re-prompt → SCHEMA_NONCOMPLIANCE)', async () => {
  const { ws, broker, runner } = await setup();
  const started = await broker.eval(
    'const p = agent("pi/x", "research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }); "started"',
  );
  assert.equal(started.result, '"started"');
  await tick();
  // The worker's final message is JSON: the ladder's native/prose
  // extraction validates it.
  runner.last().completeTurn('{"answer": "42"}');
  await tick();
  await broker.pump();
  const got = await broker.eval('await p');
  assert.deepEqual(got.result, '{answer: "42"}');
  await ws.dispose();
});

test('a schema miss re-prompts (the ladder), then rejects SCHEMA_NONCOMPLIANCE when exhausted', async () => {
  const { ws, broker, runner } = await setup();
  await broker.eval(
    'const p = agent("pi/x", "research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, maxSchemaRetries: 1 }); "started"',
  );
  await tick();
  const session = runner.last();
  // First turn: unparseable prose — the ladder re-prompts (max 1 retry).
  session.completeTurn('let me think about this...');
  await tick();
  assert.equal(session.prompts.length, 1, 'one repair turn was sent');
  session.completeTurn('still not json');
  await tick();
  await broker.pump();
  const r = await broker.eval('await p.catch(e => e.code + "/" + e.recoverable)');
  assert.equal(r.result, '"SCHEMA_NONCOMPLIANCE/false"');
  await ws.dispose();
});

test('an empty worker result rejects with the recoverable AGENT_EMPTY_OUTPUT', async () => {
  const { ws, broker, runner } = await setup();
  await broker.eval('const p = agent("pi/x", "task"); "started"');
  await tick();
  runner.last().completeTurn('   ');
  await tick();
  await broker.pump();
  const r = await broker.eval('await p.catch(e => e.code + "/" + e.recoverable)');
  assert.equal(r.result, '"AGENT_EMPTY_OUTPUT/true"');
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Exactly-once settlement
// ────────────────────────────────────────────────────────────────────────

test('exactly-once settlement: a crash between the store write and the guest settlement is healed by the next pump (record→settle→consume, both first-wins)', async () => {
  const { ws, broker, runner } = await setup();
  const r1 = await broker.eval('const p = agent("pi/x", "task"); p.then((v) => console.log("settled:", v)); "started"');
  assert.equal(r1.result, '"started"');
  await tick();
  runner.last().completeTurn('final');
  await tick();
  // Simulate the crash window: the pump's RECORD step completed (the
  // store durably holds the completion) but the process died before the
  // GUEST settlement. The store is the authority; the guest still has
  // c1 pending.
  broker.store().recordCompleted('c1', { outcome: 'resolve', value: 'final', completedAtMs: Date.now() });
  assert.deepEqual(broker.workspace.surface()!.pending().map((e) => e.id), ['c1']);
  // The next pump re-delivers: the store write is first-wins (no
  // change), the guest settles exactly once.
  const pumped = await broker.pump();
  assert.deepEqual(pumped, ['c1']);
  const r2 = await broker.eval('await p');
  assert.equal(r2.result, '"final"');
  // The continuation fired exactly once (console.log(arg1, arg2) renders
  // one line per argument).
  const settledMarkers = output(r2).filter((line) => line.includes('settled:'));
  const finalLines = output(r2).filter((line) => line.includes('"final"'));
  assert.equal(settledMarkers.length, 1, output(r2).join('\n'));
  assert.equal(finalLines.length, 1, output(r2).join('\n'));
  // The guest is idempotent: a second settlement of c1 is a no-op.
  assert.equal(broker.workspace.surface()!.settle('c1', 'resolve', 'again'), false);
  // The store kept the FIRST completion.
  assert.equal(broker.store().lookup('c1')!.completion!.value, 'final');
  await ws.dispose();
});

test('exactly-once settlement across a crash: the snapshot\'s registry is reconciled from the store after restore (settle-from-store arm)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-broker-store-'));
  const storePath = join(dir, 'calls.jsonl');
  const { ws, broker, runner } = await setup({ store: JsonlCallStore.open(storePath) });
  const r1 = await broker.eval('const p = agent("pi/x", "task"); p.then((v) => console.log("settled:", v)); "started"');
  assert.equal(r1.result, '"started"');
  await tick();
  // Snapshot the live VM: the guest registry (with c1 pending) travels.
  const snapshot = ws.snapshot();
  // The worker completes; the pump's RECORD step runs (the store durably
  // holds the completion) — then the process crashes before the guest
  // settlement.
  runner.last().completeTurn('final');
  await tick();
  broker.store().recordCompleted('c1', { outcome: 'resolve', value: 'final', completedAtMs: Date.now() });
  await broker.dispose();
  ws.dispose();

  // Restore: a fresh workspace over the snapshot, a fresh broker over
  // the same store, a fresh runner (the old process is gone).
  const ws2 = await Workspace.restore(PROJECT, snapshot);
  const runner2 = new FakeRunner();
  const broker2 = await Broker.attach(ws2, { runner: runner2, store: JsonlCallStore.open(storePath) });
  // The three-way reconciliation, store arm: completed-while-down calls
  // settle from the store — exactly once.
  const report = await broker2.reconcile();
  assert.deepEqual(report.settledFromStore, ['c1']);
  assert.deepEqual(report.leftPending, []);
  // The guest continuation fired exactly once, with the stored result.
  const r2 = await broker2.eval('"probe"');
  const settledLines = output(r2).filter((line) => line.includes('settled:'));
  const finalLines = output(r2).filter((line) => line.includes('"final"'));
  assert.equal(settledLines.length, 1, output(r2).join('\n'));
  assert.equal(finalLines.length, 1, output(r2).join('\n'));
  assert.equal((await broker2.eval('await p')).result, '"final"');
  // A second reconcile has nothing left to settle.
  const report2 = await broker2.reconcile();
  assert.deepEqual(report2.settledFromStore, []);
  assert.deepEqual(report2.leftPending, []);
  await broker2.dispose();
  ws2.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────
// Checkpoints
// ────────────────────────────────────────────────────────────────────────

test('checkpoint round trip: raised → previewed question in the tool result → answered in a later eval → settlement within that eval', async () => {
  const { ws, broker } = await setup();
  const raised = await broker.eval('const q = checkpoint("What color?"); "raised"');
  assert.deepEqual(raised.checkpoints, [{ id: 'c1', question: '"What color?"' }]);
  assert.deepEqual(raised.pending, ['c1']);
  // The question crosses previewed/truncated — never verbatim and
  // unbounded (the top-level string rule: quoted, elided past 200 chars).
  const longQ = await broker.eval('const q2 = checkpoint("a".repeat(300)); "raised"');
  assert.equal(longQ.checkpoints.length, 2);
  const longQuestion = longQ.checkpoints[1].question;
  assert.ok(longQuestion.startsWith('"'), longQuestion);
  assert.ok(longQuestion.includes('chars elided'), longQuestion);
  assert.ok(!longQuestion.includes('a'.repeat(200)), 'the verbatim question never crosses unbounded');
  // The continuation rides the answer's own eval drain.
  const answered = await broker.eval('checkpoint.answer("c1", "blue"); "delivered"');
  assert.equal(answered.result, '"delivered"');
  assert.deepEqual(answered.checkpoints, [{ id: 'c2', question: longQuestion }]);
  const r = await broker.eval('await q');
  assert.equal(r.result, '"blue"');
  // The answer was recorded in the store BEFORE the settlement (the
  // exactly-once discipline applies to answers too).
  assert.equal(broker.store().lookup('c1')!.completion!.value, 'blue');
  assert.equal(broker.store().lookup('c1')!.completion!.outcome, 'resolve');
  // Unknown / already-answered ids report false; nothing new pends.
  const unknown = await broker.eval('checkpoint.answer("cX", 1)');
  assert.equal(unknown.result, 'false');
  const again = await broker.eval('checkpoint.answer("c1", "green")');
  assert.equal(again.result, 'false');
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Steering
// ────────────────────────────────────────────────────────────────────────

test('steering with the _session/steering extension: a turn in flight gets live injection; the handle resolves with the backend\'s own outcome', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  // The steer is a wire call: the eval suspends until it resolves.
  const steered = await broker.eval('const o = await pi.steer("go deeper"); console.log("steer-outcome", o); "done"');
  assert.equal(steered.result, undefined);
  assert.deepEqual(steered.pending, ['c1', 'c2']);
  await tick();
  assert.equal(runner.last().steers.length, 1);
  assert.equal(runner.last().steers[0].content, 'go deeper');
  runner.last().completeSteer('injected');
  await tick();
  await broker.pump();
  const r = await broker.eval('"probe"');
  assert.ok(output(r).some((line) => line.includes('"injected"')), output(r).join('\n'));
  assert.ok(output(r).some((line) => line.includes('steer-outcome')), output(r).join('\n'));
  await ws.dispose();
});

test('steering WITHOUT the extension: a turn in flight queues for next-turn delivery and resolves "queued" immediately; the queued content becomes the next turn', async () => {
  const { ws, broker, runner } = await setup();
  runner.supportsSteering = false; // negotiated at initialize
  await dispatchAgent(broker, runner);
  // No wire call, no suspension: the honest immediate outcome is
  // "queued" — accepted for next-turn delivery.
  const queued = await broker.eval('const o = await pi.steer("go deeper"); "outcome:" + o');
  assert.equal(queued.result, '"outcome:queued"');
  assert.deepEqual(queued.completed, ['c2'], 'the queued steer settled synchronously');
  await tick();
  assert.equal(runner.last().steers.length, 0, 'no _session/steering wire call');
  // The initial turn completes; the queued content starts the next turn.
  runner.last().completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'the queued content became the next turn');
  assert.equal(runner.last().prompts[0].content, 'go deeper');
  await ws.dispose();
});

test('steering an idle session starts a new turn (startedNewTurn) with and without the extension', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  runner.last().completeTurn('done');
  await tick();
  await broker.pump();
  // Idle + extension backend.
  const withExt = await broker.eval('const o = await pi.steer("more"); "outcome:" + o');
  assert.equal(withExt.result, undefined, 'a new turn is in flight — the steer suspends until it settles');
  await tick();
  runner.last().completeTurn('more results');
  await tick();
  await broker.pump();
  // The steer settled with what actually happened: a new turn started.
  const steerRecord1 = broker.store().all().find((r) => r.kind === 'steer')!;
  assert.equal(steerRecord1.completion!.value, 'startedNewTurn');
  assert.equal(steerRecord1.detail, 'steer');
  // Idle + no-extension backend: same mechanism (a fresh session, the
  // capability is negotiated at open).
  runner.supportsSteering = false;
  await broker.eval('const pi2 = agent("pi/x", "second"); "ok"');
  await tick();
  const noExtSession = runner.last();
  noExtSession.completeTurn('second done');
  await tick();
  await broker.pump();
  const noExt = await broker.eval('const o2 = await pi2.steer("even more"); "outcome:" + o2');
  assert.equal(noExt.result, undefined);
  await tick();
  noExtSession.completeTurn('even more results');
  await tick();
  await broker.pump();
  const steerRecords = broker.store().all().filter((r) => r.kind === 'steer');
  assert.equal(steerRecords.length, 2);
  assert.equal(steerRecords[1].completion!.value, 'startedNewTurn');
  await ws.dispose();
});

test('steering wire failures resolve "failed" — nothing hard-errors', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  await broker.eval('const o = await pi.steer("go deeper"); console.log("steer-outcome", o); "done"');
  await tick();
  runner.last().failSteer(new Error('backend gone'));
  await tick();
  await broker.pump();
  const r = await broker.eval('"probe"');
  assert.ok(output(r).some((line) => line.includes('"failed"')), output(r).join('\n'));
  assert.ok(output(r).some((line) => line.includes('steer-outcome')), output(r).join('\n'));
  await ws.dispose();
});

test('a steer in the same eval as the dispatch (the call is still opening) queues for next-turn delivery', async () => {
  const { ws, broker, runner } = await setup();
  const r = await broker.eval('const pi = agent("pi/x", "task"); const o = await pi.steer("same eval"); "outcome:" + o');
  assert.equal(r.result, '"outcome:queued"', 'the steer queued while the session was still opening');
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'only the initial turn is in flight');
  runner.last().completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  assert.equal(runner.last().prompts.length, 1, 'the queued content became the next turn');
  assert.equal(runner.last().prompts[0].content, 'same eval');
  await ws.dispose();
});

test('cancel with a turn in flight: the handle resolves "cancelled" and the cancelled call rejects with AGENT_CANCELLED', async () => {
  const { ws, broker, runner } = await setup();
  await dispatchAgent(broker, runner);
  const cancelled = await broker.eval('const o = await pi.cancel(); console.log("cancel-outcome", o); "done"');
  assert.equal(cancelled.result, undefined);
  await tick();
  assert.equal(runner.last().cancelled, 1, 'ACP session/cancel went out');
  await broker.pump();
  const r = await broker.eval('"probe"');
  assert.ok(output(r).some((line) => line.includes('"cancelled"')), output(r).join('\n'));
  assert.ok(output(r).some((line) => line.includes('cancel-outcome')), output(r).join('\n'));
  // The call itself rejects with the machine-readable cancellation.
  const call = await broker.eval('await pi.catch((e) => e.code + "/" + e.message)');
  assert.equal(call.result, '"AGENT_CANCELLED/call c1 was cancelled"');
  assert.equal(runner.last().cancelled, 1, 'a second cancel of the idle session is a no-op');
  const idle = await broker.eval('await pi.cancel()');
  assert.equal(idle.result, '"idle"');
  await ws.dispose();
});

test('a queued delivery turn that fails surfaces a warn line in the next tool result (nothing is hidden)', async () => {
  const { ws, broker, runner } = await setup();
  runner.supportsSteering = false;
  await dispatchAgent(broker, runner);
  await broker.eval('await pi.steer("go deeper"); "queued"');
  // The initial turn completes; the queued steer starts its delivery
  // turn — which fails.
  runner.last().completeTurn('first pass');
  await tick();
  await broker.pump();
  await tick();
  runner.last().failTurn(new Error('worker crashed'));
  await tick();
  await broker.pump();
  const r = await broker.eval('"probe"');
  assert.ok(
    output(r).some((line) => line.startsWith('warn: ') && line.includes('queued delivery failed') && line.includes('worker crashed')),
    output(r).join('\n'),
  );
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Concurrency cap
// ────────────────────────────────────────────────────────────────────────

test('the concurrency cap refuses over-cap dispatches at dispatch time (recoverable) and releases the slot on settlement', async () => {
  const { ws, broker, runner } = await setup({ maxConcurrentAgents: 2 });
  // Two calls admitted; the third is refused synchronously — recorded in
  // the store (never re-issued after a restore) and rejected recoverably.
  const refused = await broker.eval(
    'const a = agent("pi/x", "a"); const b = agent("pi/x", "b"); await agent("pi/x", "c").catch((e) => e.name + "/" + e.recoverable)',
  );
  assert.equal(refused.result, '"ConcurrencyLimitError/true"');
  assert.equal(runner.sessions.length, 2, 'only two sessions were opened');
  assert.equal(broker.store().lookup('c3')!.completion!.outcome, 'reject');
  assert.ok(refused.completed.includes('c3'), 'the refusal is reported in completed');
  // The refusal was recorded BEFORE the rejection — a restore can never
  // re-issue it.
  assert.ok(broker.store().lookup('c3')!.completion !== null);
  // Settle one call: its slot is released, a new dispatch is admitted.
  await tick();
  runner.sessions[0].completeTurn('a done');
  await tick();
  await broker.pump();
  const admitted = await broker.eval('const d = agent("pi/x", "d"); "ok"');
  assert.equal(admitted.result, '"ok"');
  await tick();
  assert.equal(runner.sessions.length, 3);
  await ws.dispose();
});

// ────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────

test('trap-free result rendering: accessor properties render as (...) and never fire; Object.prototype.value pollution cannot hijack the result', async () => {
  const { ws, broker } = await setup();
  // An accessor-valued completion renders the accessor marker — the
  // getter never runs.
  const accessor = await broker.eval('let fires = 0; const o = { get x() { fires++; return 1; } }; o');
  assert.equal(accessor.result, '{x: (...)}');
  assert.equal((await broker.eval('fires')).result, '0');
  // The R69 regression shape: a `value` getter on Object.prototype must
  // not fabricate or hijack the completion preview.
  await broker.eval('Object.defineProperty(Object.prototype, "value", { get() { throw new Error("hijacked"); } })');
  const polluted = await broker.eval('({ a: 1 })');
  // The own-descriptor read fires no getter: either the honest preview
  // or the engine's documented degraded shape — never "hijacked".
  assert.ok(!JSON.stringify(polluted).includes('hijacked'));
  assert.ok(!output(polluted).some((l) => l.includes('hijacked')));
  await ws.dispose();
});

test('output lines are preview lines (one per logged argument, levels prefixed) and the caps truncate at 256 lines with outputTruncated', async () => {
  const { ws, broker } = await setup();
  const r = await broker.eval('console.log({ a: 1 }, "text"); console.error("boom"); "done"');
  assert.match(output(r)[0], /^\[\$1 · object · \d+B\] \{a: 1\}$/);
  assert.equal(output(r)[1], '[$2 · string · 4B] "text"');
  assert.equal(output(r)[2], 'error: [$3 · string · 4B] "boom"');
  assert.equal(r.outputTruncated, false);
  // 300 console.log calls → 600 refs → the 256-line cap trips.
  const big = await broker.eval('for (let i = 0; i < 300; i++) console.log("line", i); "done"');
  assert.equal(big.outputTruncated, true);
  assert.equal(big.output.length, 256);
  // The truncated content stays reachable through $N.
  assert.ok(output(big).some((line) => line.startsWith('[$')) );
  await ws.dispose();
});
